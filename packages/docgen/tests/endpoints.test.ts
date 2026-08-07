import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpointsExtractor } from '../src/extract/endpoints/index.js';
import { analyseFile } from '../src/extract/endpoints/express.js';
import { parseNestController } from '../src/extract/endpoints/nest.js';
import { parseYamlSpecPaths } from '../src/extract/endpoints/openapi.js';
import { joinPath, paramsOf } from '../src/extract/endpoints/paths.js';
import { loadConfig } from '../src/config/load.js';
import type { EndpointEntry, EndpointsResult } from '../src/types/entries.js';
import { createLogger } from '../src/util/logger.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TEST_DIR, 'fixtures');

const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

async function runOn(root: string): Promise<EndpointsResult> {
  const config = await loadConfig({ root });
  return (await endpointsExtractor.run({ root: config.root, config, logger: silent })) as EndpointsResult;
}

const route = (result: EndpointsResult, method: string, routePath: string): EndpointEntry | undefined =>
  result.entries.find((entry) => entry.method === method && entry.path === routePath);

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-endpoints-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dir;
}

// ── path helpers ─────────────────────────────────────────────────────────────

describe('path helpers', () => {
  it.each([
    ['/orders', '/', '/orders'],
    ['/orders', '/:id', '/orders/:id'],
    ['', '/health', '/health'],
    ['/api/', '/v1/', '/api/v1'],
  ])('joins %s + %s to %s', (prefix, routePath, expected) => {
    expect(joinPath(prefix, routePath)).toBe(expected);
  });

  it.each([
    ['/orders/:orderId', ['orderId']],
    ['/orders/[id]/items/[itemId]', ['id', 'itemId']],
    ['/orders/{orderId}', ['orderId']],
    ['/orders', []],
  ])('reads params from %s', (routePath, expected) => {
    expect(paramsOf(routePath)).toEqual(expected);
  });
});

// ── Express ──────────────────────────────────────────────────────────────────

describe('Express endpoints', () => {
  it('resolves the mount prefix across a barrel re-export', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));

    expect(result.entries.map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual([
      'DELETE /orders/:orderId',
      'GET /health',
      'GET /orders',
      'GET /orders/:orderId',
      'POST /orders',
    ]);
  });

  // Reading `req.get('User-Agent')` or `axios.post('http://...')` as a route
  // publishes an endpoint that does not exist — the worst failure this tool
  // can have.
  it('does not read header access or HTTP client calls as routes', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).not.toContain('/User-Agent');
    expect(paths).not.toContain('/Authorization');
    expect(paths).not.toContain('/Content-Length');
    expect(paths.some((p) => p.includes('http:'))).toBe(false);
  });

  it('recognises an app that arrives as a typed parameter', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));
    expect(route(result, 'GET', '/health')).toBeDefined();
  });

  // The final argument is the handler, not middleware. Listing it as
  // middleware would misreport the auth chain.
  it('records middleware without the handler', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));
    expect(route(result, 'POST', '/orders')?.middleware).toEqual(['auth', 'validate()']);
  });

  it('treats a lone argument as the handler, not middleware', () => {
    const analysis = analyseFile(
      'r.ts',
      "import { Router } from 'express';\nconst router = Router();\nrouter.get('/x', handler);\n",
    );
    expect(analysis.registrations[0]?.middleware).toEqual([]);
  });

  it('captures the validated request shape', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));
    expect(route(result, 'POST', '/orders')?.requestShape).toEqual({
      name: 'CreateOrderSchema',
      kind: 'validator-argument',
    });
  });

  it('links each endpoint to its handler line', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));
    expect(result.entries.every((entry) => (entry.handler?.line ?? 0) > 0)).toBe(true);
  });

  it('does not treat the app itself as an unmounted router', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));
    expect(result.gaps.some((gap) => gap.kind === 'router-not-mounted')).toBe(false);
  });

  // A computed path cannot be resolved without running the module, and a wrong
  // URL is worse than a missing one.
  it('emits nothing for a computed route path', () => {
    const analysis = analyseFile(
      'r.ts',
      "import { Router } from 'express';\nconst router = Router();\nrouter.get(PATHS.list, handler);\n",
    );
    expect(analysis.registrations).toEqual([]);
  });

  it('reports a router it could not confirm rather than staying silent', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"express":"^4.19.0"}}',
      // Express is in scope, but the parameter is untyped JS so docgen cannot
      // prove `server` is the app. Staying silent here would hide the routes.
      'src/app.js':
        "const express = require('express');\nmodule.exports = (server) => {\n  server.get('/widgets', handler);\n};\n",
    });

    const result = await runOn(root);
    const gap = result.gaps.find((g) => g.kind === 'unconfirmed-router-variable');

    expect(gap?.message).toContain('server');
    expect(result.entries).toEqual([]);
  });

  // Regression: `const r = await import('./routes')` inside a function body,
  // mounted as `r.default`. Missing either form loses the prefix for every
  // route in the module, documenting them all at a URL that 404s.
  it('resolves a mount through a dynamic import and a .default access', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"express":"^4.19.0"}}',
      'src/routes/userRoutes.ts':
        "import { Router } from 'express';\nconst router = Router();\nrouter.get('/:id', h);\nexport default router;\n",
      'src/app.ts': `import express, { Application } from 'express';

export default async (app: Application): Promise<void> => {
  const userRoutes = await import('./routes/userRoutes');
  app.use('/api/users', userRoutes.default);
};
`,
    });

    const result = await runOn(root);
    expect(result.entries.map((entry) => entry.path)).toEqual(['/api/users/:id']);
  });

  it('resolves a mount through require()', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"express":"^4.19.0"}}',
      'src/routes/a.js':
        "const { Router } = require('express');\nconst router = Router();\nrouter.get('/ping', h);\nmodule.exports = router;\n",
      'src/app.js': `const express = require('express');
const app = express();
const a = require('./routes/a');
app.use('/svc', a);
`,
    });

    const result = await runOn(root);
    expect(result.entries.map((entry) => entry.path)).toEqual(['/svc/ping']);
  });

  // An HTTP client call is a request, not a route. Reporting it would claim
  // the repo runs a server it does not have.
  it('ignores axios calls in a repo with no express', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"axios":"^1.0.0","react":"19.0.0"}}',
      'src/api.ts': "import axios from 'axios';\nexport const load = () => axios.get('/api/roles');\n",
    });

    const result = await runOn(root);

    expect(result.applicable).toBe(false);
    expect(result.gaps).toEqual([]);
  });

  it('reports a router that nothing mounts', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"express":"^4.19.0"}}',
      'src/orphan.ts':
        "import { Router } from 'express';\nconst router = Router();\nrouter.get('/x', h);\nexport default router;\n",
    });

    const result = await runOn(root);
    expect(result.gaps.some((gap) => gap.kind === 'router-not-mounted')).toBe(true);
  });
});

// ── NestJS ───────────────────────────────────────────────────────────────────

describe('NestJS controllers', () => {
  it('composes the controller prefix with each method path', async () => {
    const result = await runOn(path.join(FIXTURES, 'nest-app'));

    expect(result.entries.map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual([
      'GET /orders',
      'GET /orders/:id',
      'PATCH /orders/:id',
      'POST /orders',
    ]);
  });

  // Nest is one of the few frameworks where auth is genuinely knowable
  // statically, because the guard is named in a decorator.
  it('applies class-level guards to every route', async () => {
    const result = await runOn(path.join(FIXTURES, 'nest-app'));
    expect(route(result, 'GET', '/orders')?.middleware).toEqual(['JwtAuthGuard']);
  });

  it('merges method-level guards with class-level ones', async () => {
    const result = await runOn(path.join(FIXTURES, 'nest-app'));
    expect(route(result, 'PATCH', '/orders/:id')?.middleware).toEqual(['AdminGuard', 'JwtAuthGuard']);
  });

  it('reads the DTO type of a @Body parameter', async () => {
    const result = await runOn(path.join(FIXTURES, 'nest-app'));
    expect(route(result, 'POST', '/orders')?.requestShape).toEqual({
      name: 'CreateOrderDto',
      kind: 'typescript',
    });
  });

  it('reports a computed controller prefix', () => {
    const parsed = parseNestController(
      'c.ts',
      "@Controller(PREFIX)\nexport class C {\n  @Get()\n  find() {}\n}\n",
    );
    expect(parsed.gaps.some((gap) => gap.kind === 'controller-prefix-not-literal')).toBe(true);
  });
});

// ── Next.js API ──────────────────────────────────────────────────────────────

describe('Next.js API endpoints', () => {
  it('reads one endpoint per exported method function', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));

    expect(result.entries.map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual([
      'DELETE /api/orders/[id]',
      'GET /api/health',
      'GET /api/orders/[id]',
    ]);
  });

  it('ignores a non-method export in a route handler', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    expect(result.entries.some((entry) => entry.method.toString() === 'revalidate')).toBe(false);
  });

  // A Pages Router handler branches on req.method at runtime, so claiming a
  // specific verb would be a guess.
  it('records a Pages API handler as ALL and says the methods are undetermined', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-pages'));

    expect(route(result, 'ALL', '/api/users')).toBeDefined();
    expect(result.gaps.some((gap) => gap.kind === 'pages-api-method-undetermined')).toBe(true);
  });
});

// ── OpenAPI cross-check ──────────────────────────────────────────────────────

describe('OpenAPI spec parsing', () => {
  it('reads paths and methods from YAML', () => {
    const operations = parseYamlSpecPaths(
      'openapi: 3.0.0\npaths:\n  /orders:\n    get:\n      summary: x\n    post:\n      summary: y\n  /orders/{id}:\n    get:\n      summary: z\n',
    );
    expect(operations).toEqual([
      { method: 'get', path: '/orders' },
      { method: 'post', path: '/orders' },
      { method: 'get', path: '/orders/{id}' },
    ]);
  });

  it('ignores non-method keys inside a path', () => {
    const operations = parseYamlSpecPaths('paths:\n  /orders:\n    parameters: []\n    get:\n      x: 1\n');
    expect(operations).toEqual([{ method: 'get', path: '/orders' }]);
  });
});

describe('spec cross-check', () => {
  // The spec is never authoritative: it is a claim about the code that may
  // have rotted. Trusting it would emit fabricated endpoints as verified.
  it('marks endpoints present in the spec as matching', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));
    expect(route(result, 'GET', '/orders')?.specStatus).toBe('match');
  });

  it('compares paths by shape, not by parameter name', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));
    // Spec says /orders/{orderId}; code says /orders/:orderId.
    expect(route(result, 'GET', '/orders/:orderId')?.specStatus).toBe('match');
  });

  it('flags an endpoint that exists in code but not in the spec', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));

    expect(route(result, 'GET', '/health')?.specStatus).toBe('undeclared');
    expect(result.gaps.some((gap) => gap.kind === 'endpoint-not-in-spec')).toBe(true);
  });

  // A documented endpoint with no handler means the published contract
  // describes something that does not run.
  it('flags a spec endpoint with no handler behind it', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));
    const gap = result.gaps.find((g) => g.kind === 'spec-endpoint-not-in-code');

    expect(gap?.message).toContain('/legacy/export');
  });

  it('leaves specStatus unset when no spec exists', async () => {
    const result = await runOn(path.join(FIXTURES, 'nest-app'));
    expect(result.entries.every((entry) => entry.specStatus === undefined)).toBe(true);
  });
});

// ── degradation and determinism ──────────────────────────────────────────────

describe('degradation and determinism', () => {
  it('returns an inapplicable result when there is no endpoint source', async () => {
    const result = await runOn(path.join(FIXTURES, 'plain-node'));

    expect(result.applicable).toBe(false);
    expect(result.skips[0]?.kind).toBe('no-endpoint-source-detected');
  });

  it.each(['express-service', 'nest-app', 'next-app'])(
    'is byte-identical across runs on %s',
    async (name) => {
      const root = path.join(FIXTURES, name);
      const strip = (result: EndpointsResult): string => JSON.stringify({ ...result, durationMs: 0 });
      expect(strip(await runOn(root))).toBe(strip(await runOn(root)));
    },
  );

  it('sorts endpoints by path then method', async () => {
    const result = await runOn(path.join(FIXTURES, 'express-service'));
    const keys = result.entries.map((entry) => `${entry.path} ${entry.method}`);
    expect(keys).toEqual([...keys].sort());
  });
});
