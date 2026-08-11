import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSecuritySbomCommand, runSecurityScanCommand } from '../src/commands/security.js';
import { buildCycloneDxBom, serialiseCycloneDxBom } from '../src/security/sbom.js';
import { scanSupplyChain } from '../src/security/scan.js';
import { createLogger } from '../src/util/logger.js';

const created: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-security-'));
  created.push(root);
  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, contents, 'utf8');
  }
  return root;
}

function loggerCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sink = (target: string[]): NodeJS.WritableStream =>
    ({ write: (chunk: string) => (target.push(chunk), true) }) as unknown as NodeJS.WritableStream;
  return {
    stdout,
    stderr,
    logger: createLogger({ stdout: sink(stdout), stderr: sink(stderr) }),
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('offline dependency scanning', () => {
  it('uses an ancestor npm lockfile for workspace manifests and inventories exact versions', async () => {
    const root = await makeRepo({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'packages/app/package.json': JSON.stringify({ dependencies: { safe: '^1.0.0' } }),
      'package-lock.json': JSON.stringify({
        name: 'root',
        lockfileVersion: 3,
        packages: {
          '': { name: 'root', workspaces: ['packages/*'] },
          'packages/app': { dependencies: { safe: '^1.0.0' } },
          'node_modules/safe': {
            version: '1.2.3',
            resolved: 'https://registry.npmjs.org/safe/-/safe-1.2.3.tgz',
            integrity: 'sha512-YWJj',
            license: 'MIT',
          },
        },
      }),
    });

    const report = await scanSupplyChain(root);
    expect(report.lockfiles).toEqual(['package-lock.json']);
    expect(report.components).toEqual([
      expect.objectContaining({ ecosystem: 'npm', name: 'safe', version: '1.2.3', direct: true }),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.vulnerabilityCoverage.status).toBe('not-evaluated');
  });

  it('reports missing locks, non-registry sources, install scripts, and absent integrity', async () => {
    const unlocked = await makeRepo({
      'package.json': JSON.stringify({ dependencies: { direct: 'git+https://example.test/direct.git' } }),
    });
    const unlockedReport = await scanSupplyChain(unlocked);
    expect(unlockedReport.findings.map((finding) => finding.kind)).toEqual([
      'lockfile-missing',
      'non-registry-dependency',
    ]);

    const locked = await makeRepo({
      'package.json': JSON.stringify({ dependencies: { risky: '1.0.0' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { risky: '1.0.0' } },
          'node_modules/risky': {
            version: '1.0.0',
            resolved: 'http://registry.npmjs.org/risky/-/risky-1.0.0.tgz',
            hasInstallScript: true,
          },
        },
      }),
    });
    const lockedReport = await scanSupplyChain(locked);
    expect(lockedReport.findings.map((finding) => finding.kind)).toEqual([
      'insecure-download',
      'lockfile-integrity-missing',
      'install-script',
    ]);
  });

  it('does not let an unrelated nested package borrow the root lockfile', async () => {
    const root = await makeRepo({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/real-*'] }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'root' } } }),
      'tools/standalone/package.json': JSON.stringify({ dependencies: { unlocked: '1.0.0' } }),
    });
    const report = await scanSupplyChain(root);
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: 'lockfile-missing', file: 'tools/standalone/package.json' }),
    ]);
  });

  it('requires exact, hashed Python requirements and exposes unsupported formats as gaps', async () => {
    const root = await makeRepo({
      'requirements.txt': 'safe==1.2.3 \\\n+  --hash=sha256:abc\nfloating>=2\n',
      'pyproject.toml': '[project]\nname="example"\n',
    });
    const report = await scanSupplyChain(root);
    expect(report.components).toEqual([
      expect.objectContaining({ ecosystem: 'pypi', name: 'safe', version: '1.2.3' }),
    ]);
    expect(report.findings).toEqual([
      expect.objectContaining({ kind: 'python-requirement-unpinned', package: 'floating' }),
    ]);
    expect(report.gaps).toEqual([
      expect.objectContaining({ kind: 'unsupported-manifest', file: 'pyproject.toml' }),
    ]);
  });
});

describe('CycloneDX generation', () => {
  it('is deterministic and carries purl, integrity, license, scope, and provenance', async () => {
    const root = await makeRepo({
      'package.json': JSON.stringify({ devDependencies: { '@scope/tool': '1.0.0' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { devDependencies: { '@scope/tool': '1.0.0' } },
          'node_modules/@scope/tool': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/@scope/tool/-/tool-1.0.0.tgz',
            integrity: 'sha512-YWJj',
            license: 'Apache-2.0',
            dev: true,
          },
        },
      }),
    });
    const report = await scanSupplyChain(root);
    const first = buildCycloneDxBom(report);
    const second = buildCycloneDxBom(report);
    expect(serialiseCycloneDxBom(first)).toBe(serialiseCycloneDxBom(second));
    expect(first).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1 });
    expect(first.components[0]).toMatchObject({
      name: '@scope/tool',
      purl: 'pkg:npm/%40scope/tool@1.0.0',
      scope: 'excluded',
      hashes: [{ alg: 'SHA-512', content: '616263' }],
      licenses: [{ license: { name: 'Apache-2.0' } }],
    });
  });

  it('writes atomically, supports repeat generation, and prints the BOM with --json', async () => {
    const root = await makeRepo({ 'requirements.txt': 'safe==1.2.3 --hash=sha256:abc\n' });
    const first = loggerCapture();
    await runSecuritySbomCommand({ cwd: root, logger: first.logger });
    await runSecuritySbomCommand({ cwd: root, logger: first.logger });
    const stored = JSON.parse(
      await fs.readFile(path.join(root, 'docs/.security/sbom.cdx.json'), 'utf8'),
    ) as { bomFormat: string };
    expect(stored.bomFormat).toBe('CycloneDX');

    const stdout = loggerCapture();
    await runSecuritySbomCommand({ cwd: root, json: true, logger: stdout.logger });
    expect(JSON.parse(stdout.stdout.join(''))).toMatchObject({ bomFormat: 'CycloneDX' });
  });

  it('makes strict scan findings enforceable', async () => {
    const root = await makeRepo({
      'package.json': JSON.stringify({ dependencies: { unlocked: '1.0.0' } }),
    });
    const output = loggerCapture();
    await expect(
      runSecurityScanCommand({ cwd: root, strict: true, json: true, logger: output.logger }),
    ).rejects.toMatchObject({ code: 'supply-chain-policy-failed' });
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      vulnerabilityCoverage: { status: 'not-evaluated' },
    });
  });
});
