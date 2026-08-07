import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap, Skip, SourceRef } from '../../types/core.js';
import type { ConfigEntry, ConfigResult } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { parseSourceFile, positionOf, ts, walk } from '../../util/ts-ast.js';
import type { Extractor, ExtractorContext } from '../types.js';
import { inapplicable, skip } from '../types.js';

/**
 * Environment variables and feature flags.
 *
 * Both halves matter and they answer different questions: where a value is read
 * tells you what breaks without it, and where it is declared tells you whether
 * anyone remembered to set it. Comparing the two produces the two gap lists
 * SPEC 6.4 asks for — declared-but-never-read, and read-but-never-declared.
 *
 * Values are never recorded, only names and locations. A `.env` file is full of
 * secrets, and a documentation tool that copies them into a committed markdown
 * file would be a security incident.
 */
export const configExtractor: Extractor<ConfigEntry> = {
  id: 'config',
  title: 'Environment and configuration',

  async run(context: ExtractorContext): Promise<ConfigResult> {
    const startedAt = Date.now();
    const exclude = context.config.effectiveExclude;

    const reads = new Map<string, SourceRef[]>();
    const declarations = new Map<string, SourceRef[]>();
    const defaults = new Map<string, string>();
    const detected = new Set<string>();

    // ── reads, from code ──────────────────────────────────────────────────────
    const sourceFiles = (
      await fg(['**/*.{ts,tsx,js,jsx,mjs,cjs}'], { cwd: context.root, ignore: [...exclude], onlyFiles: true })
    )
      .map(toPosix)
      .sort();

    for (const relative of sourceFiles) {
      let contents: string;
      try {
        contents = await fs.readFile(path.join(context.root, relative), 'utf8');
      } catch {
        continue;
      }
      if (!contents.includes('process.env') && !contents.includes('import.meta.env')) continue;

      detected.add('code');
      collectEnvReads(relative, contents, reads, defaults);
    }

    // ── reads, from Python ────────────────────────────────────────────────────
    const pythonFiles = (
      await fg(['**/*.py'], { cwd: context.root, ignore: [...exclude], onlyFiles: true })
    )
      .map(toPosix)
      .sort();

    for (const relative of pythonFiles) {
      let contents: string;
      try {
        contents = await fs.readFile(path.join(context.root, relative), 'utf8');
      } catch {
        continue;
      }
      if (!/os\.(?:environ|getenv)/.test(contents)) continue;

      detected.add('python');
      collectPythonEnvReads(relative, contents, reads);
    }

    // ── declarations, from .env files ─────────────────────────────────────────
    const envFiles = (
      await fg(['**/.env', '**/.env.*'], {
        cwd: context.root,
        ignore: [...exclude],
        onlyFiles: true,
        dot: true,
      })
    )
      .map(toPosix)
      .sort();

    for (const relative of envFiles) {
      let contents: string;
      try {
        contents = await fs.readFile(path.join(context.root, relative), 'utf8');
      } catch {
        continue;
      }
      detected.add('dotenv');
      collectEnvDeclarations(relative, contents, declarations);
    }

    if (detected.size === 0) {
      return inapplicable<ConfigEntry>(
        'config',
        [skip('config', 'no-config-source-detected', 'No environment variable reads or .env files were found.')],
        Date.now() - startedAt,
      );
    }

    const names = new Set([...reads.keys(), ...declarations.keys()]);
    const entries: ConfigEntry[] = [];
    const gaps: Gap[] = [];

    for (const name of [...names].sort()) {
      const readSites = reads.get(name) ?? [];
      const declarationSites = declarations.get(name) ?? [];
      const defaultValue = defaults.get(name);

      entries.push({
        id: `config:env:${name}`,
        source: (readSites[0] ?? declarationSites[0]) as SourceRef,
        extractionMethod: 'ast',
        certainty: 'high',
        name,
        kind: 'env',
        reads: readSites,
        declarations: declarationSites,
        ...(defaultValue === undefined ? {} : { defaultValue }),
        isSecretLike: isSecretLike(name),
      });
    }

    // SPEC 6.4: the two gap lists that surface real rot immediately.
    const unread = entries.filter(
      (entry) => entry.reads.length === 0 && entry.declarations.length > 0,
    );
    if (unread.length > 0) {
      gaps.push({
        extractor: 'config',
        kind: 'env-declared-never-read',
        message:
          `${unread.length} variable(s) are declared but never read: ` +
          `${unread.slice(0, 12).map((entry) => entry.name).join(', ')}${unread.length > 12 ? ', …' : ''}.`,
      });
    }

    const undeclared = entries.filter(
      (entry) => entry.reads.length > 0 && entry.declarations.length === 0,
    );
    if (undeclared.length > 0) {
      gaps.push({
        extractor: 'config',
        kind: 'env-read-never-declared',
        message:
          `${undeclared.length} variable(s) are read but declared in no .env file: ` +
          `${undeclared.slice(0, 12).map((entry) => entry.name).join(', ')}${undeclared.length > 12 ? ', …' : ''}. ` +
          'These may be supplied by the deployment environment, or they may be missing.',
      });
    }

    return {
      extractor: 'config',
      applicable: true,
      detected: [...detected].sort(),
      entries,
      gaps,
      skips: [],
      durationMs: Date.now() - startedAt,
    };
  },
};

/** `process.env.FOO`, `process.env['FOO']`, and `import.meta.env.FOO`. */
export function collectEnvReads(
  file: string,
  contents: string,
  reads: Map<string, SourceRef[]>,
  defaults: Map<string, string>,
): void {
  const source = parseSourceFile(file, contents);

  walk(source, (node) => {
    let name: string | undefined;
    let target: ts.Node | undefined;

    if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression)) {
      name = node.name.text;
      target = node;
    } else if (ts.isElementAccessExpression(node) && isEnvObject(node.expression)) {
      const argument = node.argumentExpression;
      if (ts.isStringLiteral(argument)) {
        name = argument.text;
        target = node;
      }
    }

    if (name === undefined || target === undefined) return;
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return;

    const bucket = reads.get(name) ?? [];
    bucket.push(positionOf(source, target, file));
    reads.set(name, bucket);

    // `process.env.PORT ?? '3000'` and `|| 3000` document the fallback.
    const parent = target.parent;
    if (
      parent !== undefined &&
      ts.isBinaryExpression(parent) &&
      parent.left === target &&
      (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      !defaults.has(name)
    ) {
      defaults.set(name, parent.right.getText(source).slice(0, 60));
    }
  });
}

function isEnvObject(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    const text = node.getText();
    return text === 'process.env' || text === 'import.meta.env';
  }
  return false;
}

/** `os.environ['FOO']`, `os.environ.get('FOO')`, `os.getenv('FOO')`. */
export function collectPythonEnvReads(
  file: string,
  contents: string,
  reads: Map<string, SourceRef[]>,
): void {
  const lines = contents.split(/\r?\n/);

  lines.forEach((line, index) => {
    const patterns = [
      /os\.environ\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
      /os\.environ\.get\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
      /os\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
    ];

    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        const name = match[1];
        if (name === undefined) continue;
        const bucket = reads.get(name) ?? [];
        bucket.push({ file, line: index + 1 });
        reads.set(name, bucket);
      }
    }
  });
}

/**
 * Names declared in a `.env` file.
 *
 * Only the name and its line are recorded. The value is deliberately never
 * read: these files hold credentials, and copying one into generated
 * documentation would leak it into version control.
 */
export function collectEnvDeclarations(
  file: string,
  contents: string,
  declarations: Map<string, SourceRef[]>,
): void {
  contents.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) return;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    const name = match?.[1];
    if (name === undefined) return;

    const bucket = declarations.get(name) ?? [];
    bucket.push({ file, line: index + 1 });
    declarations.set(name, bucket);
  });
}

/** Names that look like credentials, so a renderer can avoid echoing anything near them. */
export function isSecretLike(name: string): boolean {
  return /(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|SALT|CERT|DSN|CONNECTION_?STRING)/i.test(
    name,
  );
}
