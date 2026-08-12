import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { endpointsExtractor } from '../src/extract/endpoints/index.js';
import type { EndpointsResult } from '../src/types/entries.js';
import { createLogger } from '../src/util/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'class-express-payment');
const created: string[] = [];
const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function runOn(root: string): Promise<EndpointsResult> {
  const config = await loadConfig({ root });
  return await endpointsExtractor.run({ root: config.root, config, logger: silent }) as EndpointsResult;
}

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-v103-express-'));
  created.push(root);
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return root;
}

describe('v1.0.3 class-based Express ownership', () => {
  it('resolves constructor apps, property initializer apps, aliases, default and named router imports', async () => {
    const result = await runOn(FIXTURE);
    const paths = result.entries.map((entry) => `${entry.method} ${entry.path}`);

    expect(paths).toContain('GET /');
    expect(paths).toContain('GET /api/v1/health');
    expect(paths).toContain('GET /api/v1/ready');
    expect(paths).toContain('POST /api/v1/payments');
    expect(paths).toContain('POST /api/v1/webhooks/provider');
    expect(new Set(result.entries.filter((entry) => entry.path === '/').map((entry) => entry.application)).size).toBe(2);
    expect(result.entries.filter((entry) => entry.path === '/api/v1/payments')[0]?.middleware).toEqual([]);
    expect(result.entries.find((entry) => entry.method === 'POST' && entry.path === '/api/v1/payments')?.middleware)
      .toEqual(['authenticate', 'validate()']);
  });

  it('reports only the genuinely unmounted router and finds the same-application duplicate', async () => {
    const result = await runOn(FIXTURE);
    const unmounted = result.gaps.filter((gap) => gap.kind === 'router-not-mounted');
    const duplicates = result.gaps.filter((gap) => gap.kind === 'duplicate-endpoint');

    expect(unmounted).toHaveLength(1);
    expect(unmounted[0]?.source?.file).toBe('src/routes/unmountedRoutes.ts');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.message).toContain('GET /api/v1/payments');
    expect(duplicates[0]?.message).not.toContain('GET / is registered');
  });

  it('associates inline operations with the mounted application without repeated ambiguity findings', async () => {
    const result = await runOn(FIXTURE);
    expect(result.gaps.filter((gap) => gap.kind === 'openapi-scope-ambiguous')).toHaveLength(0);
    expect(result.openapi).toMatchObject({
      operationsCompared: 6,
      operationsSkippedAmbiguous: 0,
      ambiguousDocuments: 0,
      documentsParsed: 3,
    });
    expect(result.entries.find((entry) => entry.path === '/api/v1/health')?.specStatus).toBe('match');
  });

  it('is deterministic across repeated runs', async () => {
    const first = await runOn(FIXTURE);
    const second = await runOn(FIXTURE);
    expect(JSON.stringify({ ...first, durationMs: 0 })).toBe(JSON.stringify({ ...second, durationMs: 0 }));
  });

  it('supports every Express registration method directly on a typed class property', async () => {
    const calls = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']
      .map((method) => `this.app.${method}('/${method}', handler);`).join('\n');
    const root = await makeRepo({
      'package.json': '{"dependencies":{"express":"^4.21.0"}}',
      'src/app.ts': `import express, { type Express } from 'express';
class App { app: Express.Application; constructor(){ this.app=express(); } routes(){ ${calls} } }`,
    });
    const result = await runOn(root);
    expect(result.entries.map((entry) => entry.method).sort()).toEqual(
      ['ALL', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    );
  });
});

describe('v1.0.3 computed mount prefixes', () => {
  it('handles literals, aliases, concatenation, templates, partial values, calls, and repeated mounts', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"express":"^4.21.0"}}',
      'src/config.ts': "export default { server: { version: 'v2' } }; export const importedPath='/imported';\n",
      'src/router.ts': "import { Router } from 'express'; const r=Router(); r.get('/items', h); export default r;\n",
      'src/app.ts': `import express from 'express';
import config, { importedPath } from './config';
import routes from './router';
const literal = ('/literal');
const joined = '/api/' + config.server.version;
const partial = \`/tenant/\${runtime.tenant}\`;
class A { app = express(); mount() {
  this.app.use('/direct', routes);
  this.app.use(literal, routes);
  this.app.use(joined, routes);
  this.app.use(\`/full/\${config.server.version}\`, routes);
  this.app.use(importedPath, routes);
  this.app.use(partial, routes);
  this.app.use(prefixFromRuntime(), routes);
} }
`,
    });
    const result = await runOn(root);
    const paths = result.entries.map((entry) => entry.path).sort();
    expect(paths).toEqual([
      '/api/v2/items', '/direct/items', '/full/v2/items', '/imported/items', '/literal/items',
      '/tenant/{runtime.tenant}/items', '/{prefixFromRuntime()}/items',
    ]);
    expect(result.gaps.filter((gap) => gap.kind === 'mount-prefix-unresolved')).toHaveLength(2);
    expect(result.gaps.some((gap) => gap.kind === 'router-not-mounted')).toBe(false);
    expect(result.entries.filter((entry) => entry.finalPathResolved === false)).toHaveLength(2);
  });
});

describe('v1.0.3 inline OpenAPI scoping', () => {
  it('deduplicates twenty ambiguous operations to one source finding', async () => {
    const swagger = Array.from({ length: 20 }, (_, index) =>
      `/** @openapi\n * /op-${index}:\n *   get:\n *     summary: operation\n */`,
    ).join('\n');
    const root = await makeRepo({
      'package.json': '{"dependencies":{"express":"^4.21.0"}}',
      'src/app.ts': "import express from 'express'; const app=express(); app.get('/health', h);\n",
      'src/orphan.ts': `import { Router } from 'express'; const r=Router();\n${swagger}\nr.get('/op-0', h); export default r;\n`,
    });
    const result = await runOn(root);
    expect(result.gaps.filter((gap) => gap.kind === 'openapi-scope-ambiguous')).toHaveLength(1);
    expect(result.openapi).toMatchObject({ operationsSkippedAmbiguous: 20, ambiguousDocuments: 1, documentsParsed: 1 });
    expect(result.entries.find((entry) => entry.path === '/health')?.specStatus).toBeUndefined();
  });

  it('expands one inline document across two mounts and two independently scoped applications', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"express":"^4.21.0"}}',
      'src/router.ts': `import { Router } from 'express'; const r=Router();
/** @openapi
 * /ping:
 *   get:
 *     summary: Ping
 */
r.get('/ping', h); export default r;`,
      'src/app.ts': `import express from 'express'; import r from './router';
class A { app=express(); x(){ this.app.use('/one', r); this.app.use('/two', r); } }
class B { app=express(); x(){ this.app.use('/other', r); } }
`,
    });
    const result = await runOn(root);
    expect(result.entries.map((entry) => entry.path).sort()).toEqual(['/one/ping', '/other/ping', '/two/ping']);
    expect(result.entries.every((entry) => entry.specStatus === 'match')).toBe(true);
    expect(result.gaps.filter((gap) => gap.kind === 'openapi-scope-ambiguous')).toHaveLength(0);
    expect(result.openapi?.operationsCompared).toBe(3);
  });

  it('associates application-level annotations when the file has one application root', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"express":"^4.21.0"}}',
      'src/app.ts': `import express from 'express'; const app=express();
/** @openapi
 * /health:
 *   get:
 *     summary: Health
 */
app.get('/health', h);`,
    });
    const result = await runOn(root);
    expect(result.entries[0]?.specStatus).toBe('match');
    expect(result.gaps.some((gap) => gap.kind === 'openapi-scope-ambiguous')).toBe(false);
  });

  it('keeps a root-level standalone spec ambiguous when two applications are equally applicable', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"express":"^4.21.0"}}',
      'src/apps.ts': `import express from 'express';
class A { app=express(); x(){ this.app.get('/a', h); } }
class B { app=express(); x(){ this.app.get('/b', h); } }`,
      'openapi.json': '{"openapi":"3.0.0","paths":{"/a":{"get":{}}}}',
    });
    const result = await runOn(root);
    expect(result.gaps.filter((gap) => gap.kind === 'openapi-scope-ambiguous')).toHaveLength(1);
    expect(result.entries.every((entry) => entry.specStatus === undefined)).toBe(true);
    expect(result.openapi).toMatchObject({ operationsSkippedAmbiguous: 1, ambiguousDocuments: 1 });
  });
});
