import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCodeJobs } from '../src/extract/jobs/code-jobs.js';
import { parseAmqpJobs } from '../src/extract/jobs/amqp.js';
import { jobsExtractor } from '../src/extract/jobs/index.js';
import { schemaExtractor } from '../src/extract/schema/index.js';
import { mongooseProvider } from '../src/extract/schema/mongoose.js';
import { typeormProvider } from '../src/extract/schema/decorated-orm.js';
import { pythonModelsProvider } from '../src/extract/schema/python-models.js';
import { extractReactRouterRoutes } from '../src/extract/routes/react-router.js';
import { extractFastApiEndpoints } from '../src/extract/endpoints/fastapi.js';
import { extractDjangoEndpoints } from '../src/extract/endpoints/django.js';
import { extractNestEndpoints } from '../src/extract/endpoints/nest.js';
import { crossCheckAgainstSpec } from '../src/extract/endpoints/openapi.js';
import { configExtractor, collectEnvReads, collectPythonEnvReads, collectEnvDeclarations } from '../src/extract/config/index.js';
import { depsExtractor, findCycles, packageNameOf } from '../src/extract/deps/index.js';
import { enrichGraphWithTypeScriptSymbols } from '../src/graph/symbols.js';
import { enrichGraphWithPythonSymbols } from '../src/graph/python-symbols.js';
import { fingerprintFiles } from '../src/graph/fingerprints.js';
import { detectStack } from '../src/detect/stack.js';
import { readDependencyNames } from '../src/extract/routes/detect.js';
import { ensureDefaultGraphCacheIgnored } from '../src/graph/store.js';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { computeFindings } from '../src/analysis/findings.js';
import { loadConfig } from '../src/config/load.js';
import { runExtraction } from '../src/pipeline.js';
import { createLogger } from '../src/util/logger.js';
import type { SourceRef } from '../src/types/core.js';
import type { SchemaResult, ConfigResult, DepsResult, ModuleEntry } from '../src/types/entries.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-extraction-coverage-'));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents);
  }
  return root;
}
const logger = createLogger({ level: 'silent' });

describe('background job parser boundaries', () => {
  it('distinguishes unsupported method names, dynamic triggers and named schedules', () => {
    const parsed = parseCodeJobs('jobs.ts', `new Unrelated(); new ns.Worker('ignored'); new Worker; new Queue;
      new Worker(dynamic); new Queue(dynamic); new Queue('anonymous');
      const queue = new Bull('known'); queue.process(handler); unknown.process(handler); owner.queue.process(handler);
      process(handler); (factory())(); cron.schedule(); cron.schedule(dynamic, handler);
      cron.schedule('not a schedule', handler); cron.schedule(dynamic, 'named');
      cron.schedule('30 seconds', handler); scheduleJob('named', '0 0 * * *', handler);
      scheduleJob(dynamic, '0 0 * * *', handler);
      agenda.define(dynamic); agenda.define(); agenda.every(dynamic, 'x'); agenda.every('1 hour', dynamic);
      agenda.every('1 hour'); agenda.every(); agenda.every('1 hour', 'job');
    `);
    expect(parsed.gaps).toHaveLength(3);
    expect(parsed.entries.map(entry => entry.name)).toEqual(['known', 'unknown', '30 seconds', 'named', '0 0 * * *', 'job']);
    expect(parsed.declaredQueues.map(queue => queue.channel)).toEqual(['anonymous', 'known']);
    expect(parseCodeJobs('other.ts', "queue.process(handler); object.define('name', handler); object.every('1 hour', 'job')").entries).toEqual([]);
    expect(parseAmqpJobs('other.ts', 'consume(); channel.consume(); channel.other(); (factory())();').entries).toEqual([]);
    expect(parseCodeJobs('agenda.ts', 'agenda.define(dynamic); cron.schedule("0 * * * *");').entries).toHaveLength(1);
  });

  it('keeps duplicate declarations stable while recognizing a worker in another module', async () => {
    const root = await repository({ 'producer.ts': "const first = new Queue('tasks'); const second = new Queue('tasks'); const orphan = new Queue('orphan');", 'another-producer.ts': "const duplicate = new Queue('tasks');", 'workers.ts': "new Worker('tasks', handler); new Worker('tasks', handler);" });
    const config = await loadConfig({ root });
    const result = await jobsExtractor.run({ root, config, logger });
    expect(result.entries).toHaveLength(2);
    expect(new Set(result.entries.map(entry => entry.id)).size).toBe(2);
    expect(result.gaps.filter(gap => gap.kind === 'queue-without-local-worker')).toEqual([expect.objectContaining({ message: expect.stringContaining("'orphan'") })]);
    expect(result.gaps.some(gap => gap.kind === 'duplicate-job-definition')).toBe(false);
  });

  it('does not report an AMQP job when a consumer call lacks its required queue', async () => {
    const root = await repository({ 'consumer.ts': "import amqp from 'amqplib'; channel.consume();" });
    const config = await loadConfig({ root });
    expect(await jobsExtractor.run({ root, config, logger })).toMatchObject({ applicable: false, entries: [], gaps: [] });
  });
});

describe('environment, dependency and route-table boundaries', () => {
  it('keeps only readable uppercase environment reads and the first safe default', () => {
    const reads = new Map<string, SourceRef[]>();
    const defaults = new Map<string, string>();
    collectEnvReads('env.ts', `process.env.PORT ?? '3000'; process.env.PORT || '4000';
      process.env['BRACKET'] ?? 'safe'; import.meta.env.MODE || 'production';
      process.env[dynamic]; process.env.lowercase; process.env.INVALID + 1;
      (process.env.RIGHT ?? 'fallback'); ('constant' || process.env.RIGHT);
      process.env.SECRET_TOKEN ?? 'avoid'; process.env.URL ?? 'https://user:password@example.com';
      other.env.VALUE; env.VALUE; import.meta.env['OTHER'];`, reads, defaults);
    expect([...defaults.entries()]).toEqual([['PORT', "'3000'"], ['BRACKET', "'safe'"], ['MODE', "'production'"], ['RIGHT', "'fallback'"]]);
    expect(reads.has('lowercase')).toBe(false);
    const python = new Map<string, SourceRef[]>();
    collectPythonEnvReads('env.py', "os.getenv('SAME'); os.getenv('SAME'); os.environ.get('OTHER'); os.environ['LAST']", python);
    expect(python.get('SAME')).toHaveLength(2);
    const declarations = new Map<string, SourceRef[]>();
    collectEnvDeclarations('.env', 'export PORT=3000\nPORT=4000\ninvalid text\n#ignored', declarations);
    expect(declarations.get('PORT')).toHaveLength(2);
  });

  it('limits long undeclared environment and unresolved-import diagnostics', async () => {
    const root = await repository({ '.env': Array.from({ length: 14 }, (_, index) => `DECLARED_${index}=value`).join('\n'), 'app.ts': Array.from({ length: 14 }, (_, index) => `process.env.READ_${index}; import './missing${index}';`).join('\n') + "\nimport './app'; import data from './image.png'; require(dynamic); import(dynamic); export { local }; const local = 1;" });
    const config = await loadConfig({ root });
    const environment = await configExtractor.run({ root, config, logger }) as ConfigResult;
    expect(environment.gaps).toHaveLength(2);
    expect(environment.gaps.every(gap => gap.message.includes('…'))).toBe(true);
    const deps = await depsExtractor.run({ root, config, logger }) as DepsResult;
    expect(deps.gaps.find(gap => gap.kind === 'import-unresolved')?.message).toContain('14 import(s)');
    expect(deps.gaps.find(gap => gap.kind === 'import-unresolved')?.message).toContain('…');
    expect(deps.entries[0]?.imports).toEqual([]);
    expect(packageNameOf('@incomplete')).toBe('@incomplete');
  });

  it('reports no missing declarations when every root-workspace read has an env declaration', async () => {
    const root = await repository({ '.env': 'PORT=3000', 'app.ts': 'export const port = process.env.PORT;' });
    const config = await loadConfig({ root });
    const result = await configExtractor.run({ root, config, logger, workspaces: [{ dir: '', manifests: [] }, { dir: 'other', manifests: [] }] }) as ConfigResult;
    expect(result.entries).toEqual([expect.objectContaining({ id: 'config:env:.:PORT', workspace: '', reads: [{ file: 'app.ts', line: 1, column: 21 }], declarations: [{ file: '.env', line: 1 }] })]);
    expect(result.gaps).toEqual([]);
  });

  it('handles cycles with black nodes, external targets, duplicate cycles and varied lengths', () => {
    const entries: ModuleEntry[] = [
      ['a', ['b', 'b', 'missing', 'a']], ['b', ['a', 'c']], ['c', ['a']], ['z', ['a']],
    ].map(([module, imports]) => ({ id: String(module), module: String(module), imports: imports as string[], externals: [], source: { file: String(module) }, extractionMethod: 'ast', certainty: 'high' }));
    expect(findCycles(entries)).toEqual([['a'], ['a', 'b'], ['a', 'b', 'c']]);
    const rotated: ModuleEntry[] = ['a', 'b', 'c'].map(module => ({ id: module, module, imports: module === 'a' ? ['c'] : module === 'c' ? ['b', 'b'] : ['c', 'c'], externals: [], source: { file: module }, extractionMethod: 'ast', certainty: 'high' }));
    expect(findCycles(rotated)).toEqual([['b', 'c']]);
  });

  it('ignores route lookalikes and reports computed JSX and object paths', async () => {
    const root = await repository({
      'router.tsx': `import { createMemoryRouter, createHashRouter, Route } from 'react-router-dom';
        import table from './table'; import './router'; import './other-router';
        createMemoryRouter(); createHashRouter(runtime);
        createMemoryRouter([dynamic, { path: '/parent', children: [{ index: true, children: [] }, { path: 'child', element: null }, { path: dynamic }] }, { path: '/empty', children: runtime }]);
        const nodes = <><Route {...props} path /><Route path={dynamic}/><Route path={'/literal'}/><Route index/><ns.Route path='/ignored'/><Route path='/wrap'><Route index /></Route></>;
        const unreadable = <Route path=<Unsupported/> />;
        const dynamicTable = [{ path: dynamic, element: null }];
        const rootTable = [{ index: true }];
      `,
      'table.tsx': `export default [1, { path: '/nav', label: 'navigation' }, { path: '/table', element: null, children: [{ path: 'child', element: null }] }, { path: dynamic, element: null }];`,
      'other-router.tsx': "import { Route } from 'react-router'; const value = <Route path='/other' />;",
      'lookalike.ts': "const packageName = 'react-router'; const paths = [{path:'/invented',element:null}];",
    });
    const result = await extractReactRouterRoutes({ root, exclude: [], include: ['**/*'] });
    expect(result.entries.map(entry => entry.path)).toEqual(expect.arrayContaining(['/parent', '/parent/child', '/empty', '/literal', '/', '/wrap', '/table/child', '/other']));
    expect(result.entries.some(entry => ['/invented', '/ignored'].includes(entry.path))).toBe(false);
    expect(result.gaps.map(gap => gap.kind)).toEqual(expect.arrayContaining(['router-config-not-literal', 'route-path-not-literal']));
    const unreadableLine = (await fs.readFile(path.join(root, 'router.tsx'), 'utf8')).split('\n').findIndex(line => line.includes('const unreadable')) + 1;
    expect(result.gaps.find(gap => gap.source?.file === 'router.tsx' && gap.source.line === unreadableLine)?.kind).toBe('route-path-not-literal');
  });

  it('separates same-named schema tables by workspace', async () => {
    const root = await repository({ 'one/schema.prisma': 'model User {\n id Int @id\n}', 'two/schema.prisma': 'model User {\n id Int @id\n}' });
    const config = await loadConfig({ root });
    const result = await schemaExtractor.run({ root, config, logger, workspaces: [{ dir: '', manifests: [] }, { dir: 'one', manifests: [] }, { dir: 'two', manifests: [] }] }) as SchemaResult;
    expect(result.entries.map(entry => entry.workspace)).toEqual(['one', 'two']);
    expect(result.gaps.map(gap => gap.kind)).toEqual(['cross-workspace-schema-name-collision']);
  });

  it('retains collocated duplicate table declarations with stable unique identities', async () => {
    const root = await repository({ 'entities.ts': "@Entity('shared') class First { @Column() value: string; } @Entity('shared') class Second { @Column() value: number; } @Entity('other') class Third {} @Entity('other') class Fourth {}", 'other/schema.prisma': 'model Other {\n id Int @id\n}' });
    const config = await loadConfig({ root });
    const result = await schemaExtractor.run({ root, config, logger, workspaces: [{ dir: '', manifests: [] }, { dir: 'other', manifests: [] }] }) as SchemaResult;
    const shared = result.entries.filter(entry => entry.name === 'shared');
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map(entry => entry.id)).size).toBe(2);
    expect(shared.every(entry => entry.workspace === '')).toBe(true);
    expect(result.gaps.filter(gap => gap.kind === 'duplicate-table-definition')).toHaveLength(2);
  });
});

describe('files disappearing between discovery and read', () => {
  it('skips a disappeared source consistently across best-effort extractors', async () => {
    const root = await repository({ 'vanished.ts': '', 'vanished.py': '', 'vanished.env': '', '.env': '' });
    const config = await loadConfig({ root });
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const name = String(args[0]);
      if (name.startsWith(root) && ['vanished.ts', 'vanished.py', '.env'].includes(path.basename(name))) throw Object.assign(new Error('file disappeared'), { code: 'ENOENT' });
      return original(...args);
    });
    for (const provider of [mongooseProvider, typeormProvider, pythonModelsProvider]) expect((await provider.run({ root, exclude: [] })).entries).toEqual([]);
    for (const extractor of [configExtractor, depsExtractor, jobsExtractor]) expect((await extractor.run({ root, config, logger })).entries).toEqual([]);
    expect((await extractReactRouterRoutes({ root, include: ['**/*'], exclude: [] })).entries).toEqual([]);
    expect((await extractFastApiEndpoints({ root, exclude: [] })).entries).toEqual([]);
    expect((await extractDjangoEndpoints({ root, exclude: [] })).entries).toEqual([]);
    expect((await extractNestEndpoints({ root, exclude: [] })).entries).toEqual([]);
    expect((await crossCheckAgainstSpec({ root, exclude: [], entries: [] })).specFound).toBe(false);
    expect((await fingerprintFiles({ root, include: ['*.ts'], exclude: [] })).files).toEqual([]);
    expect((await enrichGraphWithTypeScriptSymbols({ root, exclude: [], graph: new EvidenceGraphBuilder().build() })).nodes).toEqual([]);
    expect((await enrichGraphWithPythonSymbols({ root, exclude: [], graph: new EvidenceGraphBuilder().build() })).nodes).toEqual([]);
  });

  it('leaves imported symbol, Prisma, Bull and AMQP references unresolved when their module disappears', async () => {
    const root = await repository({ 'vanished.ts': 'export const anything = 1;', 'app.ts': `import { callable, prisma, queue, channel } from './vanished';
      function run() { callable(); prisma.user.findMany(); queue.add('job'); channel.sendToQueue('emails', data); }
    ` });
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith('vanished.ts')) throw Object.assign(new Error('file disappeared'), { code: 'ENOENT' });
      return original(...args);
    });
    const result = await enrichGraphWithTypeScriptSymbols({ root, exclude: [], graph: new EvidenceGraphBuilder().build() });
    expect(result.edges.filter(edge => ['calls', 'references'].includes(edge.kind))).toEqual([]);
    expect(result.nodes.some(node => node.id.startsWith('symbol:vanished.ts'))).toBe(false);
  });

  it('ignores a project manifest that disappears after workspace discovery', async () => {
    const root = await repository({ 'package.json': '{"dependencies":{"express":"*"}}' });
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith('package.json')) throw Object.assign(new Error('file disappeared'), { code: 'ENOENT' });
      return original(...args);
    });
    expect((await detectStack({ root, exclude: [] })).technologies).toEqual([]);
  });

  it('preserves an existing graph cache ignore file and skips nonobject dependency manifests', async () => {
    const root = await repository({ '.docgen/cache/.gitignore': 'custom ignore\n', 'package.json': 'null' });
    expect(await ensureDefaultGraphCacheIgnored(root)).toBe(false);
    expect(await fs.readFile(path.join(root, '.docgen/cache/.gitignore'), 'utf8')).toBe('custom ignore\n');
    expect(await readDependencyNames(root)).toEqual(new Set());
  });

  it('propagates a Python symbol filesystem failure other than disappearance', async () => {
    const root = await repository({ 'locked.py': '' });
    const original = fs.readFile.bind(fs);
    const failure = Object.assign(new Error('access denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith('locked.py')) throw failure;
      return original(...args);
    });
    await expect(enrichGraphWithPythonSymbols({ root, exclude: [], graph: new EvidenceGraphBuilder().build() })).rejects.toBe(failure);
  });

  it('keeps an unreadable source from inventing a table reference', async () => {
    const root = await repository({ 'app.ts': 'export const value = 1;', 'schema.prisma': 'model User {\n id Int @id\n}' });
    const config = await loadConfig({ root });
    const run = await runExtraction({ config, logger });
    const original = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith('app.ts')) throw Object.assign(new Error('file disappeared'), { code: 'ENOENT' });
      return original(...args);
    });
    const findings = await computeFindings(run);
    expect(findings.findings.find(finding => finding.id === 'unreferenced-tables')?.items).toEqual([expect.objectContaining({ label: 'User' })]);
  });
});
