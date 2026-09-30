import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crossCheckAgainstSpec, parseYamlSpecPaths } from '../src/extract/endpoints/openapi.js';
import { extractFastApiEndpoints } from '../src/extract/endpoints/fastapi.js';
import { extractDjangoEndpoints, methodsOfView, normaliseDjangoPath } from '../src/extract/endpoints/django.js';
import { parseNestController } from '../src/extract/endpoints/nest.js';
import { analyseFile, extractExpressEndpoints } from '../src/extract/endpoints/express.js';
import { endpointsExtractor } from '../src/extract/endpoints/index.js';
import { loadConfig } from '../src/config/load.js';
import { createLogger } from '../src/util/logger.js';
import { extractAppRoutes, extractPagesRoutes } from '../src/extract/routes/next-fs.js';
import { routesExtractor } from '../src/extract/routes/index.js';
import { extractNextApiEndpoints, exportedHandlerMethods } from '../src/extract/endpoints/next-api.js';
import { parseSourceFile } from '../src/util/ts-ast.js';
import { extractManifestJobs, parseWorkflowSchedules } from '../src/extract/jobs/manifests.js';
import { analyseMiddleware, compileMatcher, isInterpretableLookahead } from '../src/extract/routes/middleware.js';
import type { EndpointEntry } from '../src/types/entries.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-endpoint-boundaries-'));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents);
  }
  return root;
}
function endpoint(routePath: string, application?: string, workspace?: string): EndpointEntry {
  return { id: `endpoint:GET:${routePath}`, source: { file: 'app.ts', line: 1 }, extractionMethod: 'ast', certainty: 'high', method: 'GET', path: routePath, params: [], middleware: [], ...(application === undefined ? {} : { application }), ...(workspace === undefined ? {} : { workspace }) };
}

describe('OpenAPI comparison scope and malformed documents', () => {
  it.each(['null', '7', '{}', '{"paths":null}', '{"paths":7}', '{"paths":{"/skip":null,"/bad":7,"/valid":{"parameters":[]}}}'])('ignores unreadable operation structures in %s', async contents => {
    const root = await repository({ 'openapi.json': contents });
    expect(await crossCheckAgainstSpec({ root, exclude: [], entries: [] })).toMatchObject({ specFound: true, gaps: [], summary: { documentsParsed: 0, operationsCompared: 0 } });
  });

  it('reports invalid JSON and leaves unrelated endpoints untouched', async () => {
    const root = await repository({ 'openapi.json': '{', 'swagger.yaml': 'paths:\n  /ready:\n    get:\n      summary: ready\n' });
    const unspecified = endpoint('/unknown');
    const other = endpoint('/elsewhere', 'unrelated', 'other');
    const result = await crossCheckAgainstSpec({ root, exclude: [], entries: [endpoint('/ready', 'main'), unspecified, other] });
    expect(result.gaps.map(gap => gap.kind)).toEqual(['spec-unparseable']);
    expect(result.annotated[1]).toBe(unspecified);
    expect(result.annotated[2]).toBe(other);
    expect(result.annotated[0]?.specStatus).toBe('match');
  });

  it('keeps unmounted and multiply-owned inline specs unannotated', async () => {
    const inline = '/**\n * @openapi\n * /ready:\n *   get:\n *     summary: Ready\n */';
    const root = await repository({ 'unmounted.ts': inline, 'ambiguous.ts': inline, 'empty.ts': inline, 'other.ts': '/** ordinary comment */\n// @openapi', 'ignored.ts': '/** @swagger irrelevant */' });
    const result = await crossCheckAgainstSpec({ root, exclude: [], entries: [endpoint('/ready', 'appA')], expressOwnership: [
      { file: 'ambiguous.ts', workspace: '', applications: [{ application: 'appA', prefix: '', finalPathResolved: true, origin: 'application' }, { application: 'appB', prefix: '', finalPathResolved: true, origin: 'application' }] },
      { file: 'empty.ts', workspace: '', applications: [] },
    ] });
    expect(result.gaps.filter(gap => gap.kind === 'openapi-scope-ambiguous')).toHaveLength(3);
    expect(result.summary).toMatchObject({ operationsSkippedAmbiguous: 3, ambiguousDocuments: 3 });
    expect(result.annotated[0]?.specStatus).toBeUndefined();
  });

  it('deduplicates inline mounted operations and matches both root and nested prefixes', async () => {
    const root = await repository({ 'router.ts': '/**\n * @swagger\n * /api/ready:\n *   get:\n *\n * /status:\n *   post:\n */\n/** @swagger\n * /status:\n *   post:\n */' });
    const result = await crossCheckAgainstSpec({ root, exclude: [], entries: [endpoint('/api/ready', 'a')], expressOwnership: [{ file: 'router.ts', workspace: '', applications: [
      { application: 'a', prefix: '/api', finalPathResolved: true, origin: 'router' },
      { application: 'a', prefix: '/api', finalPathResolved: true, origin: 'router' },
      { application: 'b', prefix: '/', finalPathResolved: true, origin: 'router' },
    ] }] });
    expect(result.annotated[0]).toMatchObject({ specStatus: 'match', openApiSources: [{ file: 'router.ts', line: 1 }] });
    expect(result.summary).toMatchObject({ operationsCompared: 4, specOperationsWithoutHandlers: 3 });
  });

  it('bounds long missing-operation diagnostics while retaining accurate counts', async () => {
    const paths = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`/spec${index}`, { get: {} }]));
    const root = await repository({ 'openapi.json': JSON.stringify({ paths }) });
    const result = await crossCheckAgainstSpec({ root, exclude: [], entries: Array.from({ length: 10 }, (_, index) => endpoint(`/code${index}`, 'a')) });
    expect(result.summary).toMatchObject({ codeEndpointsAbsent: 10, specOperationsWithoutHandlers: 10 });
    expect(result.gaps.every(gap => gap.message.endsWith(', ….'))).toBe(true);
  });

  it('selects the nearest Express application and preserves unresolved final paths', async () => {
    const root = await repository({ 'apps/a/openapi.json': JSON.stringify({ paths: { '/ready': { get: {} } } }) });
    const result = await crossCheckAgainstSpec({ root, exclude: [], entries: [
      endpoint('/ready', 'app:express:apps/a/app.ts#app'),
      endpoint('/ready', 'app:express:apps/b/app.ts#app'),
      { ...endpoint('/dynamic', 'app:express:apps/a/app.ts#app'), finalPathResolved: false },
    ] });
    expect(result.annotated.map(entry => entry.specStatus)).toEqual(['match', undefined, 'undeclared']);
    expect(result.summary?.codeEndpointsAbsent).toBe(0);
  });

  it('prefers a deeper application directory and reports equally near ownership as ambiguous', async () => {
    const root = await repository({ 'apps/service/docs/openapi.json': JSON.stringify({ paths: { '/ready': { get: {} } } }) });
    const outer = endpoint('/ready', 'app:express:apps/service/app.ts#outer');
    const inner = endpoint('/ready', 'app:express:apps/service/docs/server.ts#inner');
    const result = await crossCheckAgainstSpec({ root, exclude: [], entries: [outer, inner] });
    expect(result.annotated.map(entry => entry.specStatus)).toEqual([undefined, 'match']);
    const ambiguous = await crossCheckAgainstSpec({ root, exclude: [], entries: [outer, inner, endpoint('/ready', 'app:express:apps/service/docs/another.ts#inner')] });
    expect(ambiguous.gaps).toEqual([expect.objectContaining({ kind: 'openapi-scope-ambiguous' })]);
    expect(ambiguous.annotated.every(entry => entry.specStatus === undefined)).toBe(true);
  });

  it('handles YAML section boundaries, duplicate methods, quotes and unsupported keys', () => {
    expect(parseYamlSpecPaths(`openapi: 3.0.0
paths:
  # ignored
  parameters:
    value: ignored
  '/ready':
    GET:
      summary: Ready
      nested: value
    get:
  /other:
    parameters:
    put:
      description: Other

components:
  /ignored:
    get:
`)).toEqual([{ method: 'put', path: '/other' }, { method: 'get', path: '/ready' }]);
  });
});

describe('framework endpoint boundary declarations', () => {
  it('keeps Express evidence from other services when Nest owns one workspace', async () => {
    const root = await repository({
      'package.json': '{}',
      'nest/package.json': '{"dependencies":{"@nestjs/core":"*"}}',
      'nest/controller.ts': '@Controller("orders") class Controller { @Get() list() {} }',
      'nest/internal.ts': "import express from 'express'; const app = express(); app.get('/internal', handler); unknown.get('/unknown', handler);",
      'express/package.json': '{"dependencies":{"express":"*"}}',
      'express/app.ts': "import express from 'express'; const app = express(); app.get('/outside', handler); unknown.get('/unknown', handler);",
    });
    const config = await loadConfig({ root });
    const result = await endpointsExtractor.run({ root, config, logger: createLogger({ level: 'silent' }), workspaces: [{ dir: '', manifests: ['package.json'] }, { dir: 'nest', manifests: ['package.json'] }, { dir: 'express', manifests: ['package.json'] }] });
    expect(result.entries.map(entry => entry.path)).toEqual(['/outside', '/orders']);
    expect(result.gaps.filter(gap => gap.kind === 'unconfirmed-router-variable').map(gap => gap.source?.file)).toEqual(['express/app.ts']);
  });

  it('does not declare an Express framework when all matching files belong to a Nest application', async () => {
    const root = await repository({ 'package.json': '{"dependencies":{"@nestjs/core":"*","express":"*"}}', 'controller.ts': '@Controller("orders") class Controller { @Get() list() {} }', 'internal.ts': "import express from 'express'; const app = express(); app.get('/internal', handler);" });
    const config = await loadConfig({ root });
    const result = await endpointsExtractor.run({ root, config, logger: createLogger({ level: 'silent' }) });
    expect(result.entries.map(entry => entry.path)).toEqual(['/orders']);
    expect(result.detected).not.toContain('express');
  });

  it('retains collocated endpoint registrations with unique deterministic ids', async () => {
    const root = await repository({ 'package.json': '{"dependencies":{"express":"*"}}', 'app.ts': "import express from 'express'; const app = express(); app.get('/same', handler); app.get('/same', handler);" });
    const config = await loadConfig({ root });
    const result = await endpointsExtractor.run({ root, config, logger: createLogger({ level: 'silent' }) });
    expect(result.entries).toHaveLength(2);
    expect(new Set(result.entries.map(entry => entry.id)).size).toBe(2);
    expect(result.entries[0]?.source.line).toBe(result.entries[1]?.source.line);
  });

  it('reports intercepting Next routes and unimplemented empty React route tables', async () => {
    const root = await repository({ 'app/layout.tsx': '', 'app/(.)preview/page.tsx': '', 'package.json': '{"dependencies":{"react-router-dom":"*"}}' });
    const next = await extractAppRoutes({ root, dir: 'app', exclude: [] });
    expect(next.gaps).toEqual([expect.objectContaining({ kind: 'intercepting-route' })]);
    const config = await loadConfig({ root });
    const result = await routesExtractor.run({ root, config, logger: createLogger({ level: 'silent' }) });
    expect(result.skips).toEqual([expect.objectContaining({ kind: 'react-router-no-literal-routes' })]);
  });

  it('skips private Next page subtrees while accepting public pages', async () => {
    const root = await repository({ 'app/_private/page.tsx': '', 'app/public/page.tsx': '', 'pages/_private/page.tsx': '', 'pages/public.tsx': '' });
    expect((await extractAppRoutes({ root, dir: 'app', exclude: [] })).entries.map(entry => entry.path)).toEqual(['/public']);
    expect((await extractPagesRoutes({ root, dir: 'pages', exclude: [] })).entries.map(entry => entry.path)).toEqual(['/public']);
  });

  it('classifies typed Express variables, alias roots and middleware argument shapes', () => {
    const analysis = analyseFile('app.ts', `import express from 'express'; import { prefix, middleware } from './config';
      const typed: Application = factory(); const router: Router = factory();
      const app = express(); const alias = app; const nestedAlias = alias;
      const harmless = (factory())(); let none: string;
      function bind(target: Express, route: express.Router, unrelated: string) { target.get('/param', handler); }
      class Server {
        'app': Application; [dynamic] = express();
        value = express(); raw = unknown;
        constructor() { this.app = express(); this.raw = factory(); this.value = 1; }
        bind() { this.app.get('/typed', guard(), validate({}), validate(Dto), validate(Other), ns.guard(), 12, handler); }
      }
      const Anonymous = class { app = express(); bind() { this.app.get('/ignored', handler); } };
      this.app.get('/outside', handler);
      nestedAlias.disable('powered-by'); nestedAlias.get(dynamic, handler); nestedAlias.get('relative', handler);
      nestedAlias.get('/alias', handler);
      nestedAlias.use(prefix, unknown); nestedAlias.use(middleware, unknown); nestedAlias.use(true, unknown);
      nestedAlias.use('/', unknown); nestedAlias.use('', unknown);
      express.Router().get('/inline', handler);
    `);
    expect(analysis.registrations.map(registration => registration.path)).toEqual(['/param', '/typed', '/alias']);
    expect(analysis.registrations.find(registration => registration.path === '/typed')).toMatchObject({ middleware: ['guard()', 'validate()', 'validate()', 'validate()'], requestShape: { name: 'Dto', kind: 'validator-argument' } });
    expect(analysis.mounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'unknown', prefix: '/' }),
      expect.objectContaining({ symbol: 'middleware', prefix: '' }),
    ]));
  });

  it('reports unresolved Express mount targets and namespace router ambiguity', async () => {
    const root = await repository({
      'app.ts': `import express from 'express'; import * as routes from './routes'; import * as anonymous from './anonymous'; import { router as missing } from './empty';
        const app = express(); app.use('/missing', missing); app.use('/', unknown); app.use(unknown); app.use('/named', routes); app.use('/anonymous', anonymous);
      `,
      'routes.ts': "import { Router } from 'express'; const first = Router(); const second = Router(); first.get('/one', handler); second.get('/two', handler); export { first, second };",
      'anonymous.ts': "import { Router } from 'express'; export default Router().get('/inline', handler);",
      'empty.ts': 'export const router = {}',
    });
    const result = await extractExpressEndpoints({ root, exclude: [] });
    expect(result.gaps.filter(gap => gap.kind === 'mount-target-unresolved')).toEqual([expect.objectContaining({ message: expect.stringContaining("'/missing'") })]);
    expect(result.entries.some(entry => entry.path === '/anonymous/inline')).toBe(true);
    expect(result.entries.find(entry => entry.path === '/one')?.application).toBeUndefined();
  });

  it('deduplicates partially resolved mounts and follows anonymous router chains', async () => {
    const root = await repository({
      'app.ts': `import express from 'express'; import * as anonymous from './anonymous';
        const app = express(); const router = express.Router(); const prefix = process.env.BASE_PREFIX;
        router.get('/ready', handler); app.use(prefix, router, router); app.use('/anon', anonymous);
      `,
      'anonymous.ts': "import { Router } from 'express'; const router = Router(); router.get('/ready', handler); export default Router().use('/inner', router);",
    });
    const result = await extractExpressEndpoints({ root, exclude: [] });
    expect(result.gaps.filter(gap => gap.kind === 'mount-prefix-unresolved')).toHaveLength(1);
    expect(result.entries.map(entry => entry.path)).toEqual(expect.arrayContaining(['/{process.env.BASE_PREFIX}/ready', '/anon/inner/ready']));
    expect(result.entries.find(entry => entry.path.includes('BASE_PREFIX'))?.finalPathResolved).toBe(false);
  });

  it('keeps unresolvable root-mounted imports from producing a false prefix warning', async () => {
    const root = await repository({ 'app.ts': "import express from 'express'; import { router } from 'external-router'; const app = express(); app.use('/', router); app.use(router);" });
    expect(await extractExpressEndpoints({ root, exclude: [] })).toMatchObject({ found: true, entries: [], gaps: [] });
  });

  it('records Nest guards and DTO uncertainty, skipping non-method properties', () => {
    const result = parseNestController('controller.ts', `class Other {}
      @Controller(dynamic) @UseGuards(Auth, makeGuard()) class Controller {
        @Bare @ns.Decorator() @Post() @UseInterceptors(Cache, factory())
        save(@Body() unknown, @Body() typed: SaveDto, unrelated: string) {}
        @Get() 'quoted'() {}
        @Get() value = 1;
      }
      @Controller({ path: '/object' }) class ObjectController { @Get() list() {} }
      @Controller() class Root { @Options() options(@Body() raw) {} }
    `);
    expect(result.entries.map(entry => entry.method)).toEqual(['POST', 'GET', 'OPTIONS']);
    expect(result.entries[0]).toMatchObject({ requestShape: { name: 'SaveDto', kind: 'typescript' }, middleware: ['Auth', 'Cache'] });
    expect(result.gaps).toEqual([expect.objectContaining({ kind: 'controller-prefix-not-literal' })]);
  });

  it('recognizes Next handler exports and ignores private and special route files', async () => {
    expect(exportedHandlerMethods(parseSourceFile('route.ts', `function GET() {} export default function() {} export class Other {} export const { GET } = handler; export const PUT = handler, unknown = 1; export function POST() {}`))).toEqual([{ method: 'POST', line: 1 }, { method: 'PUT', line: 1 }]);
    const root = await repository({ 'app/route.ts': 'export const GET = handler;', 'app/_internal/route.ts': 'export function POST() {}', 'app/empty/route.ts': 'export default function() {}', 'pages/api/_ignored.ts': '', 'pages/api/index.ts': '' });
    const result = await extractNextApiEndpoints({ root, exclude: [], workspaces: [] });
    expect(result.entries.map(entry => `${entry.method} ${entry.path}`)).toEqual(['GET /', 'ALL /api']);
    expect(result.gaps.map(gap => gap.kind)).toEqual(['route-handler-no-methods', 'pages-api-method-undetermined']);
  });

  it('follows FastAPI direct imports and identifies unresolved and unmounted targets', async () => {
    const root = await repository({
      'app/main.py': `from fastapi import FastAPI, APIRouter
from .router import router
from .plain import missing
from .absent import absent
app = FastAPI()
local = APIRouter(prefix='/local')
app.include_router(router, prefix='/api')
app.include_router(local)
app.include_router(missing)
app.include_router(absent)
app.include_router(unknown)
@local.get('/ready')
def ready(): pass
@app.unknown('/ignored')
def ignored(): pass
@phantom.get('/orphan')
`,
      'app/router.py': "from fastapi import APIRouter\nrouter = APIRouter(prefix='/router')\n@router.get('/item/{id}')\ndef item(): pass\n",
      'app/plain.py': 'def missing(): pass',
      'app/empty.py': 'from fastapi import FastAPI',
    });
    const result = await extractFastApiEndpoints({ root, exclude: [] });
    expect(result.entries.map(entry => entry.path)).toEqual(['/local/ready', '/orphan', '/api/router/item/{id}']);
    expect(result.gaps.filter(gap => gap.kind === 'include-router-unresolved')).toHaveLength(3);
    expect(result.entries.find(entry => entry.path === '/orphan')?.handler).toBeUndefined();
  });

  it('keeps an unproven FastAPI parent mount explicit rather than inventing an app prefix', async () => {
    const root = await repository({ 'main.py': "from fastapi import APIRouter\nrouter = APIRouter(prefix='/items')\nunknown.include_router(router, prefix='/api')\n@router.get('/ready')\ndef ready(): pass\n" });
    const result = await extractFastApiEndpoints({ root, exclude: [] });
    expect(result.entries.map(entry => entry.path)).toEqual(['/api/items/ready']);
    expect(result.entries[0]?.certainty).toBe('low');
  });

  it('follows Django symbol includes and imported views, reporting unsupported targets', async () => {
    const root = await repository({
      'project/urls.py': `from django.urls import path, include
from app import urls as app_urls
from app.views import decorated
from missing.views import foreign
urlpatterns = [
    path('app/', include(app_urls)),
    path('missing/', include(missing)),
    path('no-urlconf/', include('app.plain')),
    path('direct/', decorated),
    path('duplicate/', decorated),
    path('duplicate/', decorated),
    path('unknown/', runtime.handler),
    path('unimported/', local),
    path('foreign/', foreign),
]
`,
      'app/urls.py': "from django.urls import path\nfrom . import views\nurlpatterns = [path('view/', views.Plain.as_view()), path('bad/', views.Missing)]\n",
      'app/views.py': "@api_view(['TRACE'])\ndef ignored(): pass\n@api_view(['GET', 'GET'])\ndef decorated(): pass\nclass Plain:\n    def post(self): pass\nclass Empty:\n    def helper(self): pass\n",
      'app/plain.py': 'value = 1',
      'other.py': 'urlpatterns = []',
    });
    const result = await extractDjangoEndpoints({ root, exclude: [] });
    expect(result.entries.map(entry => `${entry.method} ${entry.path}`)).toEqual(['POST /app/view', 'ALL /app/bad', 'GET /direct', 'GET /duplicate', 'ALL /unknown', 'ALL /unimported', 'ALL /foreign']);
    expect(result.gaps.filter(gap => gap.kind === 'urlconf-include-unresolved')).toHaveLength(1);
    expect(methodsOfView(await fs.readFile(path.join(root, 'app/views.py'), 'utf8'), 'ignored')).toEqual([]);
    expect(methodsOfView('class Empty:\n    def helper(self): pass', 'Empty')).toEqual([]);
    expect(normaliseDjangoPath('^x/(abc)/$', true)).toBe('/x/<unnamed>/');
  });

  it('bounds recursive Django include graphs', async () => {
    const root = await repository({ 'root/urls.py': "from django.urls import path, include\nurlpatterns = [path('root/', include('cycle.urls'))]", 'cycle/urls.py': "from django.urls import path, include\nurlpatterns = [path('cycle/', include('cycle.urls'))]" });
    expect(await extractDjangoEndpoints({ root, exclude: [] })).toMatchObject({ found: true, entries: [], gaps: [] });
  });
});

describe('manifest jobs and middleware malformed inputs', () => {
  it.each(['{', 'null', '7', '{}', '{"crons":7}', '{"crons":[null,7,{}, {"path":7}, {"path":"/task"}]}'])('handles Vercel manifest %s', async contents => {
    const root = await repository({ 'vercel.json': contents });
    const result = await extractManifestJobs({ root, exclude: [] });
    if (contents === '{') expect(result.gaps).toEqual([expect.objectContaining({ kind: 'manifest-unparseable' })]);
    else if (contents.includes('/task')) {
      expect(result.entries).toEqual([expect.objectContaining({ name: '/task' })]);
      expect(result.entries[0]?.schedule).toBeUndefined();
    }
    else expect(result.entries).toEqual([]);
  });

  it('uses workflow filenames when names are absent and ends schedule blocks', async () => {
    const root = await repository({ '.github/workflows/task.yml': "on:\n  schedule:\n    # comment\n\n    - cron: '0 * * * *'\n    - ignored\n  workflow_dispatch:\n    cron: ignored\n", '.github/workflows/plain.yml': 'on: push' });
    expect((await extractManifestJobs({ root, exclude: [] })).entries).toEqual([expect.objectContaining({ name: 'task.yml', schedule: '0 * * * *' })]);
    expect(parseWorkflowSchedules('schedule:\n - invalid\nname: after\ncron: ignored')).toEqual([]);
  });

  it.each(['', 'x'.repeat(501), '\\d', '(abc)', '(?:abc', 'abc)', 'abc[0]', '\\', '(?=abc)'])('rejects uninterpretable lookahead %s', body => {
    expect(isInterpretableLookahead(body)).toBe(false);
  });

  it('rejects unsupported matcher syntax and preserves dynamic config uncertainty', () => {
    expect(compileMatcher('')).toBeUndefined();
    expect(compileMatcher('relative')).toBeUndefined();
    expect(compileMatcher('/a?/:path*')).toBeUndefined();
    expect(compileMatcher('/((?!*).*)')).toBeUndefined();
    expect(compileMatcher('/:path*')?.test('/any/path')).toBe(true);
    const dynamic = analyseMiddleware('middleware.ts', 'const config = { matcher: dynamic };');
    expect(dynamic.matchers).toEqual([]);
    expect(dynamic.gaps).toEqual([expect.objectContaining({ kind: 'middleware-matcher-not-literal' })]);
    const partly = analyseMiddleware('middleware.ts', "const config = { matcher: ['/valid', value, '/invalid?'] }; const {config: ignored} = unknown; let unrelated; let config2; ");
    expect(partly.patterns).toEqual(['/valid', '/invalid?']);
    expect(partly.gaps.map(gap => gap.kind)).toEqual(['middleware-matcher-not-literal', 'middleware-matcher-uninterpretable']);
    for (const contents of ['let config;', 'const config = runtime;', 'const config = {};']) {
      expect(analyseMiddleware('middleware.ts', contents).matchers[0]?.test('/')).toBe(true);
    }
    const literal = analyseMiddleware('middleware.ts', "const config = { matcher: '/private' };");
    expect(literal.matchers[0]?.test('/private')).toBe(true);
    expect(literal.matchers[0]?.test('/outside')).toBe(false);
  });
});
