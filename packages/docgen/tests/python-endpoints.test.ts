import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { endpointsExtractor } from '../src/extract/endpoints/index.js';
import { methodsOfView, normaliseDjangoPath } from '../src/extract/endpoints/django.js';
import {
  pythonParams,
  readPythonImports,
  resolvePythonModule,
  stripPythonComments,
} from '../src/extract/endpoints/python.js';
import type { EndpointEntry, EndpointsResult } from '../src/types/entries.js';
import { createLogger } from '../src/util/logger.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TEST_DIR, 'fixtures');

const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

async function runOn(fixture: string): Promise<EndpointsResult> {
  const config = await loadConfig({ root: path.join(FIXTURES, fixture) });
  return (await endpointsExtractor.run({
    root: config.root,
    config,
    logger: silent,
  })) as EndpointsResult;
}

const routes = (result: EndpointsResult): string[] =>
  result.entries.map((entry: EndpointEntry) => `${entry.method} ${entry.path}`).sort();

// ── shared python helpers ────────────────────────────────────────────────────

describe('python source helpers', () => {
  it('removes a commented-out route without moving any line', () => {
    const source = ['@app.get("/live")', '# @app.get("/dead")', 'x = 1'].join('\n');
    const stripped = stripPythonComments(source);
    expect(stripped).toContain('/live');
    expect(stripped).not.toContain('/dead');
    expect(stripped.split('\n')).toHaveLength(3);
  });

  it('leaves a hash inside a string alone', () => {
    // `#` in a URL fragment is not a comment, and cutting there would truncate
    // the path to something that never existed.
    expect(stripPythonComments('path = "/a#b"')).toBe('path = "/a#b"');
  });

  it('reads both python parameter syntaxes', () => {
    expect(pythonParams('/items/{item_id}')).toEqual(['item_id']);
    expect(pythonParams('/users/<int:pk>/')).toEqual(['pk']);
    expect(pythonParams('/posts/<slug>/')).toEqual(['slug']);
    expect(pythonParams('/static/path')).toEqual([]);
  });

  it('binds `from . import views` to the sibling module, not the parent', () => {
    // Joining the dot to the name produced `..views`, one package too high, and
    // every view lookup through it silently found nothing.
    expect(readPythonImports('from . import views').get('views')).toBe('.views');
    expect(readPythonImports('from .routers import items').get('items')).toBe('.routers.items');
    expect(readPythonImports('from app.routers import x').get('x')).toBe('app.routers.x');
    expect(readPythonImports('import app.urls').get('app')).toBe('app.urls');
  });

  it('resolves a relative import to a scanned file', () => {
    const files = new Set(['app/routers/items.py', 'app/main.py', 'blog/views.py']);
    expect(resolvePythonModule('app/main.py', '.routers.items', files)).toBe('app/routers/items.py');
    expect(resolvePythonModule('blog/urls.py', '.views', files)).toBe('blog/views.py');
    expect(resolvePythonModule('app/main.py', '.nope', files)).toBeUndefined();
  });
});

// ── fastapi ──────────────────────────────────────────────────────────────────

describe('fastapi endpoints', () => {
  it('composes the router prefix with the include prefix', async () => {
    // The router declares `/items` and main.py includes it at `/api/v1`; a
    // reader of either file alone would see the wrong URL.
    const result = await runOn('fastapi-service');
    expect(routes(result)).toEqual([
      'DELETE /api/v1/items/{item_id}',
      'GET /api/v1/items',
      'GET /api/v1/items/{item_id}',
      'GET /health',
      'GET /users/me',
      'POST /api/v1/items',
    ]);
  });

  it('mounts a router included without a prefix at its own prefix only', async () => {
    const result = await runOn('fastapi-service');
    expect(routes(result)).toContain('GET /users/me');
    expect(routes(result)).not.toContain('GET /me');
  });

  it('does not document a commented-out route', async () => {
    const result = await runOn('fastapi-service');
    expect(routes(result).join(' ')).not.toContain('/disabled');
  });

  it('marks python endpoints low certainty, since they are read by regex', async () => {
    const result = await runOn('fastapi-service');
    expect(result.entries.every((entry) => entry.certainty === 'low')).toBe(true);
    expect(result.entries.every((entry) => entry.extractionMethod === 'regex')).toBe(true);
  });

  it('reports fastapi as a detected source', async () => {
    expect((await runOn('fastapi-service')).detected).toContain('fastapi');
  });
});

// ── django ───────────────────────────────────────────────────────────────────

describe('django urlconf', () => {
  it('follows include() from the project urlconf into the app', async () => {
    const result = await runOn('django-app');
    expect(routes(result)).toContain('GET /api/blog/posts');
    expect(routes(result)).toContain('DELETE /api/blog/posts/<int:pk>');
  });

  it('reads verbs from an @api_view decorator', async () => {
    const result = await runOn('django-app');
    const posts = routes(result).filter((route) => route.endsWith(' /api/blog/posts'));
    expect(posts.sort()).toEqual(['GET /api/blog/posts', 'POST /api/blog/posts']);
  });

  it('reads verbs from the handler methods of a class-based view', async () => {
    const result = await runOn('django-app');
    const detail = routes(result).filter((route) => route.endsWith('/api/blog/posts/<int:pk>'));
    expect(detail.sort()).toEqual([
      'DELETE /api/blog/posts/<int:pk>',
      'GET /api/blog/posts/<int:pk>',
    ]);
  });

  /**
   * A Django URL carries no method — the view decides. Writing GET because most
   * views are GET would be a claim nothing in the code supports, so the verb is
   * ALL and the uncertainty is recorded where a reader will see it.
   */
  it('records ALL and a gap when the view does not declare its verbs', async () => {
    const result = await runOn('django-app');
    expect(routes(result)).toContain('ALL /api/blog/legacy/<slug>');
    const gap = result.gaps.find((entry) => entry.kind === 'view-methods-undetermined');
    expect(gap?.message).toContain('the view decides');
  });

  it('does not document a commented-out url row', async () => {
    expect(routes(await runOn('django-app')).join(' ')).not.toContain('/hidden');
  });

  it('survives a view reference carrying parentheses', async () => {
    // `views.PostDetail.as_view()` truncated to `views.PostDetail.as_view(`
    // and was then built into a pattern, which threw before reaching a result.
    await expect(runOn('django-app')).resolves.toBeDefined();
  });

  it('normalises a re_path regex into a readable url', () => {
    expect(normaliseDjangoPath('^legacy/(?P<slug>[\\w-]+)/$', true)).toBe('/legacy/<slug>/');
    expect(normaliseDjangoPath('posts/', false)).toBe('/posts/');
  });

  it('returns no verbs rather than guessing for an undecorated function view', () => {
    expect(methodsOfView('def plain(request):\n    return None\n', 'plain')).toEqual([]);
  });

  it('reports django as a detected source', async () => {
    expect((await runOn('django-app')).detected).toContain('django');
  });
});
