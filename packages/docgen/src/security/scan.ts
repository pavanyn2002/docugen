import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import picomatch from 'picomatch';
import { DocgenError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import { toPosix } from '../util/paths.js';
import type {
  SupplyChainComponent,
  SupplyChainFinding,
  SupplyChainGap,
  SupplyChainReport,
} from './types.js';

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly workspaces?: readonly string[] | { readonly packages?: readonly string[] };
}

interface LockPackage {
  readonly name?: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly license?: string;
  readonly dev?: boolean;
  readonly link?: boolean;
  readonly hasInstallScript?: boolean;
}

interface PackageLock {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockPackage>>;
}

const MANIFEST_GLOBS = ['**/package.json', '**/requirements.txt'] as const;
const IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.docgen/**',
  '**/tests/fixtures/**',
  '**/test/fixtures/**',
  '**/__fixtures__/**',
] as const;

export async function scanSupplyChain(root: string): Promise<SupplyChainReport> {
  const manifests = (await fg([...MANIFEST_GLOBS], { cwd: root, onlyFiles: true, ignore: [...IGNORED] }))
    .map(toPosix)
    .sort(compareStrings);
  const components: SupplyChainComponent[] = [];
  const findings: SupplyChainFinding[] = [];
  const gaps: SupplyChainGap[] = [];
  const lockfiles = new Set<string>();

  for (const manifestFile of manifests) {
    if (path.posix.basename(manifestFile) === 'package.json') {
      await scanNpmManifest({ root, manifestFile, components, findings, gaps, lockfiles });
    } else {
      await scanRequirements({ root, manifestFile, components, findings });
    }
  }

  const unsupported = await fg(
    ['**/{pnpm-lock.yaml,yarn.lock,Pipfile,poetry.lock,pyproject.toml,go.mod,Cargo.toml,Gemfile}'],
    { cwd: root, onlyFiles: true, ignore: [...IGNORED] },
  );
  for (const file of unsupported.map(toPosix).sort(compareStrings)) {
    gaps.push({
      kind: 'unsupported-manifest',
      file,
      message: `${file} was detected, but this Docgen version cannot yet verify or inventory that dependency format.`,
    });
  }

  return {
    schemaVersion: 1,
    components: uniqueComponents(components),
    findings: [...new Map(findings.map((finding) => [finding.id, finding])).values()].sort(compareFinding),
    gaps: gaps.sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.kind, b.kind)),
    manifests,
    lockfiles: [...lockfiles].sort(compareStrings),
    vulnerabilityCoverage: {
      status: 'not-evaluated',
      reason:
        'This deterministic offline scan checks dependency provenance and reproducibility only. Run a current advisory scanner in CI for CVE coverage.',
    },
  };
}

async function scanNpmManifest(args: {
  root: string;
  manifestFile: string;
  components: SupplyChainComponent[];
  findings: SupplyChainFinding[];
  gaps: SupplyChainGap[];
  lockfiles: Set<string>;
}): Promise<void> {
  const manifest = await readJson<PackageManifest>(args.root, args.manifestFile, 'package manifest');
  const direct = new Map<string, { specifier: string; development: boolean }>();
  for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
    direct.set(name, { specifier, development: false });
  }
  for (const [name, specifier] of Object.entries(manifest.optionalDependencies ?? {})) {
    direct.set(name, { specifier, development: false });
  }
  for (const [name, specifier] of Object.entries(manifest.devDependencies ?? {})) {
    if (!direct.has(name)) direct.set(name, { specifier, development: true });
  }
  for (const [name, dependency] of direct) {
    if (isNonRegistrySpecifier(dependency.specifier)) {
      args.findings.push({
        id: findingId('non-registry-dependency', args.manifestFile, name),
        kind: 'non-registry-dependency',
        severity: 'medium',
        file: args.manifestFile,
        package: name,
        message: `${name} uses non-registry specifier '${dependency.specifier}', which requires explicit source review.`,
      });
    }
  }

  const lockFile = await findAncestorLockfile(args.root, path.posix.dirname(args.manifestFile));
  if (lockFile === undefined) {
    if (direct.size > 0) {
      args.findings.push({
        id: findingId('lockfile-missing', args.manifestFile),
        kind: 'lockfile-missing',
        severity: 'high',
        file: args.manifestFile,
        message: `${args.manifestFile} declares dependencies but has no adjacent package-lock.json.`,
      });
    }
    return;
  }

  args.lockfiles.add(lockFile);
  const lock = await readJson<PackageLock>(args.root, lockFile, 'npm lockfile');
  if (lock.packages === undefined || (lock.lockfileVersion ?? 0) < 2) {
    throw new DocgenError({
      code: 'security-lockfile-unsupported',
      message: `${lockFile} does not contain the package inventory used by npm lockfile v2/v3.`,
      remedy: 'Regenerate it with a supported npm version, then rerun `docgen security scan`.',
      file: path.join(args.root, lockFile),
    });
  }

  const directNames = new Set(direct.keys());
  for (const [key, entry] of Object.entries(lock.packages).sort(([a], [b]) => compareStrings(a, b))) {
    if (key === '' || entry.link === true || entry.version === undefined) continue;
    if (!key.includes('node_modules/')) continue;
    const name = entry.name ?? packageNameFromLockPath(key);
    if (name === undefined) {
      args.gaps.push({
        kind: 'unresolved-lock-entry',
        file: lockFile,
        message: `Could not derive a package name for lockfile entry '${key}'.`,
      });
      continue;
    }
    args.components.push({
      ecosystem: 'npm',
      name,
      version: entry.version,
      sourceFile: lockFile,
      direct: directNames.has(name),
      development: entry.dev === true,
      ...(entry.integrity === undefined ? {} : { integrity: entry.integrity }),
      ...(entry.resolved === undefined ? {} : { resolved: entry.resolved }),
      ...(entry.license === undefined ? {} : { license: entry.license }),
    });

    if (entry.resolved?.startsWith('http://') === true) {
      args.findings.push({
        id: findingId('insecure-download', lockFile, `${name}@${entry.version}`),
        kind: 'insecure-download',
        severity: 'high',
        file: lockFile,
        package: name,
        message: `${name}@${entry.version} is downloaded over unauthenticated HTTP.`,
      });
    }
    if (entry.resolved !== undefined && isRegistryArchive(entry.resolved) && entry.integrity === undefined) {
      args.findings.push({
        id: findingId('lockfile-integrity-missing', lockFile, `${name}@${entry.version}`),
        kind: 'lockfile-integrity-missing',
        severity: 'high',
        file: lockFile,
        package: name,
        message: `${name}@${entry.version} has a registry archive URL but no integrity digest.`,
      });
    }
    if (entry.hasInstallScript === true) {
      args.findings.push({
        id: findingId('install-script', lockFile, `${name}@${entry.version}`),
        kind: 'install-script',
        severity: 'medium',
        file: lockFile,
        package: name,
        message: `${name}@${entry.version} executes code during dependency installation.`,
      });
    }
  }
}

async function scanRequirements(args: {
  root: string;
  manifestFile: string;
  components: SupplyChainComponent[];
  findings: SupplyChainFinding[];
}): Promise<void> {
  const contents = await fs.readFile(path.join(args.root, args.manifestFile), 'utf8');
  for (const logical of logicalRequirementLines(contents)) {
    const line = logical.text;
    if (
      line.length === 0 ||
      line.startsWith('#') ||
      /^(?:--(?:index-url|extra-index-url|trusted-host|find-links|no-index|hash)\b)/.test(line)
    ) {
      continue;
    }
    const requirement = line.split(';', 1)[0]?.trim() ?? '';
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]+\])?)\s*==\s*([^\s\\]+)(.*)$/.exec(requirement);
    if (match === null) {
      const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)?.[1] ?? `line-${logical.line}`;
      args.findings.push({
        id: findingId('python-requirement-unpinned', args.manifestFile, `${logical.line}`),
        kind: 'python-requirement-unpinned',
        severity: 'high',
        file: args.manifestFile,
        package: name,
        message: `${name} is not pinned with an exact == version at ${args.manifestFile}:${logical.line}.`,
      });
      continue;
    }
    const rawName = match[1] as string;
    const name = rawName.replace(/\[.*$/, '');
    const version = match[2] as string;
    const suffix = match[3] ?? '';
    args.components.push({
      ecosystem: 'pypi',
      name,
      version,
      sourceFile: args.manifestFile,
      direct: true,
      development: false,
    });
    if (!suffix.includes('--hash=')) {
      args.findings.push({
        id: findingId('python-requirement-unhashed', args.manifestFile, `${name}@${version}`),
        kind: 'python-requirement-unhashed',
        severity: 'medium',
        file: args.manifestFile,
        package: name,
        message: `${name}==${version} is pinned but has no --hash integrity constraint.`,
      });
    }
  }
}

function logicalRequirementLines(contents: string): readonly { line: number; text: string }[] {
  const logical: { line: number; text: string }[] = [];
  let buffer = '';
  let start = 1;
  for (const [index, raw] of contents.split(/\r?\n/).entries()) {
    const trimmed = raw.trim();
    if (buffer.length === 0) start = index + 1;
    const continues = trimmed.endsWith('\\');
    const part = continues ? trimmed.slice(0, -1).trimEnd() : trimmed;
    buffer = buffer.length === 0 ? part : `${buffer} ${part}`;
    if (!continues) {
      logical.push({ line: start, text: buffer.trim() });
      buffer = '';
    }
  }
  if (buffer.length > 0) logical.push({ line: start, text: buffer.trim() });
  return logical;
}

async function readJson<T>(root: string, relative: string, label: string): Promise<T> {
  const absolute = path.join(root, relative);
  try {
    return JSON.parse(await fs.readFile(absolute, 'utf8')) as T;
  } catch (cause) {
    throw new DocgenError({
      code: 'security-manifest-invalid',
      message: `${relative} is not valid JSON and cannot be used as a ${label}.`,
      remedy: 'Fix the JSON syntax and rerun the security command.',
      file: absolute,
      cause,
    });
  }
}

function packageNameFromLockPath(key: string): string | undefined {
  const marker = 'node_modules/';
  const at = key.lastIndexOf(marker);
  if (at === -1) return undefined;
  return key.slice(at + marker.length) || undefined;
}

function isNonRegistrySpecifier(value: string): boolean {
  return /^(?:git(?:\+|:)|https?:|file:|link:|github:|gitlab:|bitbucket:)/i.test(value);
}

function isRegistryArchive(value: string): boolean {
  return /^https?:\/\//i.test(value) && /\.(?:tgz|tar\.gz)(?:[?#].*)?$/i.test(value);
}

function findingId(kind: SupplyChainFinding['kind'], file: string, subject = ''): string {
  const normalized = `${kind}-${file}-${subject}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return normalized.replace(/^-|-$/g, '');
}

function uniqueComponents(components: readonly SupplyChainComponent[]): readonly SupplyChainComponent[] {
  const unique = new Map<string, SupplyChainComponent>();
  for (const component of components) {
    const key = `${component.ecosystem}:${component.name.toLowerCase()}@${component.version}`;
    const existing = unique.get(key);
    if (
      existing === undefined ||
      (!existing.direct && component.direct) ||
      (existing.development && !component.development)
    ) {
      unique.set(key, component);
    }
  }
  return [...unique.values()].sort(
    (a, b) =>
      compareStrings(a.ecosystem, b.ecosystem) ||
      compareStrings(a.name.toLowerCase(), b.name.toLowerCase()) ||
      compareStrings(a.version, b.version),
  );
}

function compareFinding(a: SupplyChainFinding, b: SupplyChainFinding): number {
  const ranks = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return ranks[a.severity] - ranks[b.severity] || compareStrings(a.id, b.id);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function findAncestorLockfile(root: string, start: string): Promise<string | undefined> {
  let directory = start === '.' ? '' : start;
  const packageDirectory = directory;
  while (true) {
    const candidate = directory.length === 0 ? 'package-lock.json' : `${directory}/package-lock.json`;
    if (await exists(path.join(root, candidate))) {
      if (directory === packageDirectory) return candidate;
      const manifestFile = directory.length === 0 ? 'package.json' : `${directory}/package.json`;
      const workspaceManifest = await readOptionalManifest(path.join(root, manifestFile));
      const workspaces = workspacePatterns(workspaceManifest?.workspaces);
      const relativePackage = path.posix.relative(directory || '.', packageDirectory || '.');
      if (
        workspaces?.some((pattern) =>
          picomatch(pattern.replace(/\\/g, '/'), { dot: true })(relativePackage),
        ) === true
      ) {
        return candidate;
      }
    }
    if (directory.length === 0) return undefined;
    const parent = path.posix.dirname(directory);
    directory = parent === '.' ? '' : parent;
  }
}

async function readOptionalManifest(file: string): Promise<PackageManifest | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as PackageManifest;
  } catch {
    return undefined;
  }
}

function workspacePatterns(value: PackageManifest['workspaces']): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return (value as { readonly packages?: readonly string[] }).packages ?? [];
  }
  return value as readonly string[];
}
