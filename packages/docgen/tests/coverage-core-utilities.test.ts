import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findStaleAtomicFiles, removeAtomicFiles, ATOMIC_TEMP_MARKER } from '../src/util/atomic.js';
import { assertGeneratedPath, assertGeneratedTargets, isSafeOutputDirectory, isGeneratedFile } from '../src/util/generated.js';
import { aliasCandidates, loadPathAliases } from '../src/util/tsconfig.js';
import { parseGitignore } from '../src/config/gitignore.js';
import { ts, getProperty, literalStringArray, importedModules, parseSourceFile } from '../src/util/ts-ast.js';
import { readModuleBindings, resolveSymbolToFile, resolveImport } from '../src/util/modules.js';
import { findBoundaryViolations } from '../src/util/boundaries.js';
import { redactSecrets, isSecretLikeName } from '../src/privacy/redact.js';
import { classifyGitHeadError, resolveGitHeadDiagnostic, resolveGitChanges, resolveFileCommitHistory, resolveGitUserEmail, filterGitChanges } from '../src/util/git.js';
import { currentGitEmail, lastAuthorOf, resolveOwners } from '../src/questions/queue.js';
import { deriveFeatureCommitHistory } from '../src/features/history.js';
import { featureRecordSchema } from '../src/features/schema.js';
import { featureCardSchema } from '../src/infer/types.js';
import { captureJson } from '../src/util/capture.js';
import { resolveColorEnabled } from '../src/util/colors.js';
import { installGitHook, renderPrePushHook } from '../src/adapters/hooks.js';
import { upsertMcpConfig, upsertCodexMcpConfig } from '../src/adapters/mcp.js';
import { loadConfig } from '../src/config/load.js';

const command = vi.hoisted(() => vi.fn<(args: readonly string[]) => string>());
vi.mock('node:child_process', () => {
  const execFile = Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: async (_file: string, args: string[]) => ({ stdout: command(args), stderr: '' }) });
  return { execFile };
});
const roots: string[] = [];
async function repo(files: Record<string, string> = {}) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-core-util-')); roots.push(root); for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); } return root; }
afterEach(async () => { vi.restoreAllMocks(); command.mockReset(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('Git command boundary diagnostics', () => {
  it.each(['', 'a'.repeat(40), `${'a'.repeat(40)}\n`, 'invalid\n2026-01-01'])('rejects invalid HEAD response %j', async text => {
    command.mockReturnValue(text);
    await expect(resolveGitHeadDiagnostic('.')).resolves.toMatchObject({ ok: false, kind: 'invalid-head' });
  });
  it('explains unsafe ownership without changing git configuration', async () => {
    command.mockImplementation(() => { throw { stderr: 'dubious ownership' }; });
    await expect(resolveGitHeadDiagnostic('checkout')).resolves.toMatchObject({ kind: 'dubious-ownership', remedy: expect.stringContaining('checkout') });
    expect(command).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['timeout', { killed: true }], ['timeout', new Error('timed out')], ['dubious-ownership', new Error('safe.directory')],
    ['no-commits', new Error('unknown revision')], ['no-commits', new Error('bad revision')], ['no-commits', new Error('ambiguous argument')],
    ['permission-denied', { code: 'EPERM' }], ['permission-denied', new Error('access is denied')],
    ['invalid-head', new Error('invalid object name')], ['invalid-head', new Error('bad object head')], ['invalid-head', new Error('not a valid object name')],
    ['unknown', null], ['unknown', 12],
  ])('classifies %s from %j', (kind, error) => { expect(classifyGitHeadError(error)).toMatchObject({ ok: false, kind }); });
  it('parses copies, incomplete records and duplicate untracked entries', async () => {
    command.mockImplementation(args => args[0] === 'diff' ? 'C100\0old.ts\0copy.ts\0M\0tracked.ts\0R100\0missing.ts' : args[0] === 'ls-files' ? 'tracked.ts\0untracked.ts\0' : 'tree');
    const changes = await resolveGitChanges('.');
    expect(changes.changes).toEqual([{ status: 'added', file: 'copy.ts' }, { status: 'modified', file: 'tracked.ts' }, { status: 'added', file: 'untracked.ts' }]);
    command.mockImplementation(args => args[0] === 'diff' ? 'M' : '');
    expect((await resolveGitChanges('.')).changes).toEqual([]);
  });
  it('ignores malformed history entries and empty identity values', async () => {
    command.mockReturnValue(`no-tab\ninvalid\tdate\n${'b'.repeat(40)}\t2026-01-01\n`);
    expect(await resolveFileCommitHistory('.', 'a')).toMatchObject({ introduced: { sha: 'b'.repeat(40) }, lastChanged: { sha: 'b'.repeat(40) } });
    command.mockReturnValue('');
    await expect(resolveFileCommitHistory('.', 'a')).resolves.toBeUndefined();
    await expect(resolveGitUserEmail('.')).resolves.toBeUndefined();
    command.mockImplementation(() => { throw new Error('git unavailable'); });
    await expect(resolveFileCommitHistory('.', 'a')).resolves.toBeUndefined();
  });
  it('routes questions only when Git author and surface file are known', async () => {
    command.mockReturnValue('');
    await expect(currentGitEmail('.')).resolves.toBeUndefined();
    await expect(lastAuthorOf('.', 'a')).resolves.toBeUndefined();
    const card = { surfaceId: 'a', slug: 'a', title: 'A', kind: 'screen', producedBy: 'test', promptVersion: '', inputHash: '', answered: [], body: featureCardSchema.parse({ summary: { text: 'A', evidence: [{ file: 'a.ts' }] } }) };
    expect(await resolveOwners({ root: '.', cards: [card], filesBySurface: new Map() })).toEqual(new Map());
    expect(await resolveOwners({ root: '.', cards: [card], filesBySurface: new Map([['a', ['a.ts']]]) })).toEqual(new Map());
  });
  it('aggregates oldest introduction and newest change across feature files', async () => {
    const root = await repo({ 'a.ts': 'a', 'b.ts': 'b' });
    const record = { ...featureRecordSchema.parse({ schemaVersion: 1, id: 'a', title: 'A', selectors: { files: ['*.ts'] }, recordedBy: 'owner', recordedAt: '2026-01-01T00:00:00.000Z' }), sourceFile: 'feature.json' };
    command.mockImplementation(args => args.at(-1) === 'a.ts' ? `${'a'.repeat(40)}\t2026-01-02\n${'b'.repeat(40)}\t2026-01-03` : `${'c'.repeat(40)}\t2026-01-01\n${'d'.repeat(40)}\t2026-01-04`);
    expect(await deriveFeatureCommitHistory({ root, record, graph: { schemaVersion: 1, nodes: [], edges: [], gaps: [] } })).toMatchObject({ introduced: { committedAt: '2026-01-01' }, lastChanged: { committedAt: '2026-01-04' } });
  });
});

describe('filesystem safety and source aliases', () => {
  it('recovers a stale candidate disappearing after discovery and enforces deletion ownership', async () => {
    const relative = `stale${ATOMIC_TEMP_MARKER}test`;
    const root = await repo({ [relative]: 'bytes' });
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await findStaleAtomicFiles(root)).toEqual([]);
    await expect(removeAtomicFiles(root, ['ordinary.tmp'])).rejects.toThrow('Refusing');
    await expect(removeAtomicFiles(root, [`../outside${ATOMIC_TEMP_MARKER}test`])).rejects.toThrow('Refusing');
    await expect(removeAtomicFiles(root, [`D:/outside${ATOMIC_TEMP_MARKER}test`])).rejects.toThrow('Refusing');
    await removeAtomicFiles(root, [relative]);
    await expect(fs.stat(path.join(root, relative))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('surfaces output access errors and refuses Windows roots', async () => {
    const root = await repo();
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(error);
    await expect(assertGeneratedPath(root, 'docs/page.md')).rejects.toBe(error);
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(error);
    await expect(assertGeneratedTargets(root, ['page.md'])).rejects.toBe(error);
    expect(isSafeOutputDirectory('C:relative')).toBe(false);
    expect(isSafeOutputDirectory('docs/segment.')).toBe(false);
    expect(isSafeOutputDirectory('docs/segment ')).toBe(false);
    expect(isSafeOutputDirectory('docs/\u007f')).toBe(false);
  });
  it('reads extensionless inherited JSONC, rejects invalid targets and terminates cycles', async () => {
    const root = await repo({ 'tsconfig.json': '{"extends":"./base"}', 'base.json': '{"compilerOptions":{"paths":{"valid/*":["lib/*",null],"bad":"not-array","outside/*":["../*"],"empty":[]}}}' });
    const aliases = await loadPathAliases(root);
    expect(aliases.map(alias => alias.prefix)).toEqual(['valid/']);
    expect(aliasCandidates('valid/item', aliases)).toEqual(['lib/item']);
    await fs.writeFile(path.join(root, 'tsconfig.json'), '{"extends":"./tsconfig.json"}');
    expect(await loadPathAliases(root)).toEqual([]);
    await fs.writeFile(path.join(root, 'tsconfig.json'), '{"extends":"package-config/base"}');
    expect(await loadPathAliases(root)).toEqual([]);
    await fs.writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"paths":null}}');
    expect(await loadPathAliases(root)).toEqual([]);
    vi.spyOn(ts.sys, 'readFile').mockImplementationOnce(() => { throw new Error('filesystem failed'); });
    expect(await loadPathAliases(root)).toEqual([]);
  });
  it('handles exact aliases, wildcard suffixes, overlapping patterns and root targets', () => {
    const aliases = [
      { prefix: 'a', suffix: 'bc', hasWildcard: true, targets: [{ prefix: '', suffix: '.ts' }, { prefix: 'lib/', suffix: '' }] },
      { prefix: 'fixed', suffix: '', hasWildcard: false, targets: [{ prefix: 'index.ts', suffix: '' }] },
    ];
    expect(aliasCandidates('abc', aliases)).toEqual(['.ts', 'lib/']);
    expect(aliasCandidates('ab', aliases)).toEqual([]);
    expect(aliasCandidates('fixed-extra', aliases)).toEqual([]);
    expect(aliasCandidates('fixed', aliases)).toEqual(['index.ts']);
    expect(aliasCandidates('bc', [{ prefix: 'bc', suffix: 'bc', hasWildcard: true, targets: [] }])).toEqual([]);
    expect(parseGitignore('/\n///\n')).toEqual({ patterns: [], unsupportedNegations: [] });
  });
  it('continues without aliases when an externally supplied config exceeds the parser nesting limit', async () => {
    const root = await repo({ 'tsconfig.json': '{"unknown":' + '['.repeat(6000) + '0' + ']'.repeat(6000) + '}' });
    expect(await loadPathAliases(root)).toEqual([]);
  });
  it('resolves missing imported bindings, re-export failures, and hop limits', async () => {
    const files = new Set(['a.ts', 'b.ts']);
    const bindings = readModuleBindings(ts.createSourceFile('a.ts', "import './side'; import * as ns from './b'; export * as names from './b'; export { ns }; export default 3; export const { x } = obj; const mod=require('./b'); const dynamic=await import('./b'); const invalid=require(); const noLoad=fn();", ts.ScriptTarget.Latest, true));
    expect(bindings.imports.get('ns')?.importedName).toBe('*');
    expect(bindings.imports.get('mod')?.specifier).toBe('./b');
    expect(bindings.imports.has('noLoad')).toBe(false);
    const loadBindings = async (file: string) => file === 'a.ts' ? bindings : undefined;
    await expect(resolveSymbolToFile({ fromFile: 'a.ts', symbol: 'ns', loadBindings, files })).resolves.toBeUndefined();
    await expect(resolveSymbolToFile({ fromFile: 'a.ts', symbol: 'ns', loadBindings, files, maxHops: 0 })).resolves.toBeUndefined();
    const unresolved = readModuleBindings(ts.createSourceFile('a.ts', "import { a } from 'absent'; export { b } from 'absent';", ts.ScriptTarget.Latest, true));
    for (const symbol of ['a', 'b']) await expect(resolveSymbolToFile({ fromFile: 'a.ts', symbol, loadBindings: async () => unresolved, files })).resolves.toBeUndefined();
    expect(resolveImport('a.ts', './absent', files)).toBeUndefined();
    const imports = readModuleBindings(parseSourceFile('a.ts', "import { x } from './b';"));
    const exports = readModuleBindings(parseSourceFile('b.ts', "export { x } from './a';"));
    expect(await resolveSymbolToFile({ fromFile: 'a.ts', symbol: 'x', files, loadBindings: async file => file === 'a.ts' ? imports : exports })).toBeUndefined();
    expect(readModuleBindings(parseSourceFile('invalid.ts', 'export *;')).starExports).toEqual([]);
  });
  it('checks every import syntax while allowing package imports', async () => {
    const root = await repo({ 'extract/sample.ts': "import 'external';\nexport { x } from '../infer/x';\nimport('../agents/a');\nrequire('../questions/b');\nimport '../infer/c';", 'commands/free.ts': "import '../infer/ok';" });
    expect((await findBoundaryViolations(root)).map(violation => violation.line)).toEqual([2, 3, 4, 5]);
  });
  it('redacts bare secret assignments and private keys without redacting twice', () => {
    expect(isSecretLikeName('---')).toBe(false);
    expect(redactSecrets('password = plainSecret123').text).toBe('password = [REDACTED:named-secret]');
    const initial = redactSecrets('-----BEGIN PRIVATE KEY-----\nsecret bytes\n-----END PRIVATE KEY-----');
    expect(initial.kinds).toContain('private-key');
    expect(redactSecrets('token="[REDACTED:named-secret]"').count).toBe(0);
  });
  it('keeps renames crossing exclusion boundaries and resolves aliases to their second target', () => {
    expect(filterGitChanges({ base: 'HEAD', changes: [{ file: 'ignored/new.ts', previousFile: 'src/old.ts', status: 'renamed' }, { file: 'ignored/a.ts', status: 'modified' }] }, ['ignored/**']).changes).toHaveLength(1);
    expect(resolveImport('a.ts', '@/a', new Set(['src/a.ts']), [{ prefix: '@/', suffix: '', hasWildcard: true, targets: [{ prefix: 'missing', suffix: '' }, { prefix: 'src', suffix: '' }] }])).toBe('src/a.ts');
    const changes = { base: 'HEAD', changes: [] };
    expect(filterGitChanges(changes, [])).toBe(changes);
  });
  it('rejects unsafe Git revisions and reports unavailable comparison trees', async () => {
    for (const revision of ['', '-argument', 'main\n']) await expect(resolveGitChanges('.', revision)).rejects.toMatchObject({ code: 'git-base-invalid' });
    command.mockImplementation(() => { throw new Error('unknown revision'); });
    await expect(resolveGitChanges('.', 'missing')).rejects.toMatchObject({ code: 'git-base-unavailable' });
  });
  it('handles literal AST edge forms and ignores computed imports', () => {
    const object = ts.factory.createObjectLiteralExpression([ts.factory.createShorthandPropertyAssignment('x'), ts.factory.createPropertyAssignment(ts.factory.createNumericLiteral(1), ts.factory.createStringLiteral('a')), ts.factory.createPropertyAssignment(ts.factory.createStringLiteral('quoted'), ts.factory.createStringLiteral('b')), ts.factory.createPropertyAssignment(ts.factory.createComputedPropertyName(ts.factory.createIdentifier('dynamic')), ts.factory.createStringLiteral('c'))]);
    expect(getProperty(object, 'quoted')).toMatchObject({ text: 'b' });
    expect(getProperty(object, 'missing')).toBeUndefined();
    expect(literalStringArray(ts.factory.createIdentifier('notArray'))).toEqual([]);
    const source = parseSourceFile('invalid.ts', 'import value from computed;');
    expect(importedModules(source)).toEqual([]);
  });
  it('captures empty command JSON and honors nonempty NO_COLOR', async () => {
    await expect(captureJson(async () => {})).resolves.toBeNull();
    expect(resolveColorEnabled({ argv: [], env: { NO_COLOR: '1' }, stream: { isTTY: true } })).toBe(false);
    expect(resolveColorEnabled({ argv: ['--color'], env: {}, stream: {} })).toBe(true);
    expect(isGeneratedFile('human.json', '<!-- docgen:generated -->')).toBe(false);
    expect(isGeneratedFile('human.md', '---\ngenerated: true\n')).toBe(false);
    expect(isGeneratedFile('human.md', '---\ngenerated: false\n---\n<!-- docgen:generated -->')).toBe(false);
  });
  it('rejects team-owned hooks and updates managed hooks and MCP defaults', async () => {
    const root = await repo({ '.githooks/pre-push': 'team hook' });
    command.mockReturnValue('');
    await expect(installGitHook(root, 'docgen')).rejects.toMatchObject({ code: 'git-hook-owned' });
    await fs.writeFile(path.join(root, '.githooks/pre-push'), renderPrePushHook('old-command'));
    await expect(installGitHook(root, 'docgen')).resolves.toMatchObject({ action: 'updated' });
    command.mockImplementation(args => args[0] === 'config' && args.includes('--get') ? '.githooks' : '');
    await expect(installGitHook(root, 'docgen')).resolves.toMatchObject({ action: 'unchanged' });
    command.mockReturnValue('owned-hooks');
    await expect(installGitHook(root, 'docgen')).rejects.toMatchObject({ code: 'git-hooks-path-owned' });
    command.mockImplementation(() => { throw new Error('git missing'); });
    await expect(installGitHook(root, 'docgen')).rejects.toMatchObject({ code: 'git-hooks-not-repository' });
    expect(JSON.parse((await upsertMcpConfig(root, '')).contents).mcpServers.docgen.command).toBe('docgen');
    expect((await upsertCodexMcpConfig(root, '')).contents).toContain('command = "docgen"');
  });
  it('reports scalar, null, root-level schema and thrown module configs', async () => {
    const root = await repo({ 'docgen.config.json': 'null' });
    await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('null') });
    await fs.writeFile(path.join(root, 'docgen.config.json'), 'true');
    await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('boolean') });
    await fs.writeFile(path.join(root, 'docgen.config.json'), '{"unknown":true}');
    await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('(root)') });
    await fs.rm(path.join(root, 'docgen.config.json'));
    await fs.writeFile(path.join(root, 'docgen.config.mjs'), 'throw new Error("config failed");');
    await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'config-unparseable' });
  });
  it('falls back to unknown engine version for absent or malformed package metadata', async () => {
    vi.resetModules();
    vi.spyOn(fsSync, 'readFileSync').mockReturnValue('null');
    expect((await import('../src/util/version.js')).ENGINE_VERSION).toBe('0.0.0-unknown');
    vi.restoreAllMocks();
    vi.resetModules();
    vi.spyOn(fsSync, 'readFileSync').mockReturnValue('{"name":"@pavanyn/docugen","version":3}');
    expect((await import('../src/util/version.js')).ENGINE_VERSION).toBe('0.0.0-unknown');
    vi.restoreAllMocks();
    vi.resetModules();
    vi.spyOn(fsSync, 'readFileSync').mockImplementation(() => { throw new Error('metadata unavailable'); });
    expect((await import('../src/util/version.js')).ENGINE_VERSION).toBe('0.0.0-unknown');
  });
});
