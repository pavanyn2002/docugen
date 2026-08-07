import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routesExtractor } from '../src/extract/routes/index.js';
import { detectRouters, readDependencyNames } from '../src/extract/routes/detect.js';
import { analyseMiddleware, compileMatcher } from '../src/extract/routes/middleware.js';
import { joinRoutePaths, resolveRelativeImport } from '../src/extract/routes/react-router.js';
import { parseAppSegments, parsePagesSegments, stripRouteExtension } from '../src/extract/routes/segments.js';
import { loadConfig } from '../src/config/load.js';
import type { RouteEntry, RoutesResult } from '../src/types/entries.js';
import { createLogger } from '../src/util/logger.js';
import { DocgenError } from '../src/util/errors.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TEST_DIR, 'fixtures');

const silentLogger = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

async function runOn(root: string): Promise<RoutesResult> {
  const config = await loadConfig({ root });
  return (await routesExtractor.run({ root: config.root, config, logger: silentLogger })) as RoutesResult;
}

function pathsOf(result: RoutesResult, kind?: RouteEntry['kind']): string[] {
  return result.entries.filter((e) => kind === undefined || e.kind === kind).map((e) => e.path);
}

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-routes-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dir;
}

// ── segment parsing ──────────────────────────────────────────────────────────

describe('app router segment parsing', () => {
  it.each([
    ['', '/'],
    ['dashboard', '/dashboard'],
    ['dashboard/projects/[id]', '/dashboard/projects/[id]'],
    ['blog/[...slug]', '/blog/[...slug]'],
    ['shop/[[...filters]]', '/shop/[[...filters]]'],
  ])('maps %s to %s', (input, expected) => {
    expect(parseAppSegments(input).path).toBe(expected);
  });

  it('removes route groups from the URL but records them', () => {
    const parsed = parseAppSegments('(marketing)/pricing');
    expect(parsed.path).toBe('/pricing');
    expect(parsed.groups).toEqual(['marketing']);
  });

  it('collects dynamic param names in order', () => {
    expect(parseAppSegments('orgs/[orgId]/projects/[id]').params).toEqual(['orgId', 'id']);
  });

  it('flags catch-all and optional catch-all distinctly', () => {
    expect(parseAppSegments('blog/[...slug]')).toMatchObject({ isCatchAll: true, isOptionalCatchAll: false });
    expect(parseAppSegments('shop/[[...f]]')).toMatchObject({ isCatchAll: true, isOptionalCatchAll: true });
  });

  it('marks a _private folder as not routable', () => {
    expect(parseAppSegments('_components/Button').isPrivate).toBe(true);
  });

  it('removes a parallel slot from the URL and records it', () => {
    const parsed = parseAppSegments('dashboard/@modal/preview');
    expect(parsed.path).toBe('/dashboard/preview');
    expect(parsed.slots).toEqual(['modal']);
  });

  it('recognises an intercepting route', () => {
    const parsed = parseAppSegments('feed/(..)photo/[id]');
    expect(parsed.isIntercepting).toBe(true);
    expect(parsed.path).toBe('/feed/photo/[id]');
  });
});

describe('pages router segment parsing', () => {
  it.each([
    ['index', '/'],
    ['about', '/about'],
    ['blog/index', '/blog'],
    ['blog/[slug]', '/blog/[slug]'],
  ])('maps %s to %s', (input, expected) => {
    expect(parsePagesSegments(input).path).toBe(expected);
  });
});

describe('route extension stripping', () => {
  it.each([
    ['page.tsx', 'page'],
    ['layout.jsx', 'layout'],
    ['route.ts', 'route'],
  ])('strips %s', (input, expected) => {
    expect(stripRouteExtension(input)).toBe(expected);
  });

  it('returns undefined for a non-route file', () => {
    expect(stripRouteExtension('styles.css')).toBeUndefined();
  });
});

// ── detection ────────────────────────────────────────────────────────────────

describe('framework detection', () => {
  it('detects the app router', async () => {
    const detected = await detectRouters(path.join(FIXTURES, 'next-app'));
    expect(detected).toEqual([{ kind: 'next-app', dir: 'src/app' }]);
  });

  it('detects the pages router', async () => {
    const detected = await detectRouters(path.join(FIXTURES, 'next-pages'));
    expect(detected).toEqual([{ kind: 'next-pages', dir: 'pages' }]);
  });

  it('detects react-router', async () => {
    const detected = await detectRouters(path.join(FIXTURES, 'react-router'));
    expect(detected).toEqual([{ kind: 'react-router' }]);
  });

  it('detects nothing in a repo with no router', async () => {
    expect(await detectRouters(path.join(FIXTURES, 'plain-node'))).toEqual([]);
  });

  // A dependency without the directory is not a router — a repo can depend on
  // next without having migrated any pages yet.
  it('requires a populated directory, not just the dependency', async () => {
    const root = await makeRepo({ 'package.json': '{"dependencies":{"next":"^15.0.0"}}' });
    expect(await detectRouters(root)).toEqual([]);
  });

  it('treats a missing package.json as absent input', async () => {
    const root = await makeRepo({ 'index.js': '' });
    await expect(readDependencyNames(root)).resolves.toEqual(new Set());
  });

  // SPEC rule 6: malformed input is loud. Silently failing detection here would
  // emit empty docs that look like a clean result.
  it('treats a corrupt package.json as an error', async () => {
    const root = await makeRepo({ 'package.json': '{ not json' });
    await expect(readDependencyNames(root)).rejects.toThrow(DocgenError);
  });
});

// ── middleware guards ────────────────────────────────────────────────────────

describe('middleware matcher compilation', () => {
  it('matches an exact path', () => {
    const matcher = compileMatcher('/account');
    expect(matcher?.test('/account')).toBe(true);
    expect(matcher?.test('/account/settings')).toBe(false);
  });

  it('matches a prefix wildcard, including the prefix itself', () => {
    const matcher = compileMatcher('/dashboard/:path*');
    expect(matcher?.test('/dashboard')).toBe(true);
    expect(matcher?.test('/dashboard/projects/[id]')).toBe(true);
    expect(matcher?.test('/settings')).toBe(false);
  });

  it('matches a single dynamic segment', () => {
    const matcher = compileMatcher('/orders/:id');
    expect(matcher?.test('/orders/[id]')).toBe(true);
    expect(matcher?.test('/orders/[id]/items')).toBe(false);
  });

  // Claiming a route is authenticated when it is not is the exact failure the
  // trust model exists to prevent, so an uninterpretable pattern matches nothing.
  it('refuses to interpret a regex pattern', () => {
    expect(compileMatcher('/((?!api|_next/static).*)')).toBeUndefined();
  });

  it('reports an uninterpretable pattern as a gap', () => {
    const info = analyseMiddleware(
      'middleware.ts',
      "export const config = { matcher: ['/((?!api).*)'] };",
    );
    expect(info.matchers).toEqual([]);
    expect(info.gaps[0]?.kind).toBe('middleware-matcher-uninterpretable');
  });

  it('reports a computed matcher as a gap', () => {
    const info = analyseMiddleware('middleware.ts', 'export const config = { matcher: PATHS };');
    expect(info.gaps[0]?.kind).toBe('middleware-matcher-not-literal');
  });

  // Next runs matcher-less middleware on every request; that is documented
  // behaviour, not an assumption.
  it('treats middleware with no matcher as guarding everything', () => {
    const info = analyseMiddleware('middleware.ts', 'export function middleware() {}');
    expect(info.matchers[0]?.test('/anything')).toBe(true);
  });
});

// ── app router end to end ────────────────────────────────────────────────────

describe('Next.js App Router fixture', () => {
  it('lists exactly the user-facing pages', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));

    expect(pathsOf(result, 'page').sort()).toEqual([
      '/',
      '/blog/[...slug]',
      '/dashboard',
      '/dashboard/preview',
      '/dashboard/projects/[id]',
      '/pricing',
    ]);
  });

  it('does not treat an API route handler as a screen', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    expect(pathsOf(result)).not.toContain('/api/health');
  });

  it('excludes a _private folder', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    expect(result.entries.every((e) => !e.source.file.includes('_components'))).toBe(true);
  });

  it('classifies layout, loading, and error files', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    const kinds = new Set(result.entries.map((e) => e.kind));
    expect(kinds).toContain('layout');
    expect(kinds).toContain('loading');
    expect(kinds).toContain('error');
  });

  it('builds the layout chain from the app root down', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    const detail = result.entries.find((e) => e.path === '/dashboard/projects/[id]' && e.kind === 'page');

    expect(detail?.layoutChain.map((ref) => ref.file)).toEqual([
      'src/app/layout.tsx',
      'src/app/dashboard/layout.tsx',
    ]);
  });

  it('applies the middleware guard only to matched routes', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    const guarded = result.entries
      .filter((e) => e.kind === 'page' && e.guards.length > 0)
      .map((e) => e.path)
      .sort();

    expect(guarded).toEqual(['/dashboard', '/dashboard/preview', '/dashboard/projects/[id]']);
  });

  it('records the route group without putting it in the URL', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    const pricing = result.entries.find((e) => e.path === '/pricing');

    expect(pricing?.group).toBe('marketing');
    expect(pricing?.source.file).toBe('src/app/(marketing)/pricing/page.tsx');
  });

  it('captures catch-all params', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    const blog = result.entries.find((e) => e.path === '/blog/[...slug]');

    expect(blog).toMatchObject({ isCatchAll: true, params: ['slug'] });
  });

  // The URL of a parallel-slot page depends on how the parent layout renders
  // the slot, which is not statically knowable.
  it('reports a parallel route slot as a gap rather than asserting its URL', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    expect(result.gaps.some((g) => g.kind === 'parallel-route-slot')).toBe(true);
  });

  it('links every entry to a source file', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    expect(result.entries.every((e) => e.source.file.length > 0 && e.source.line !== undefined)).toBe(true);
  });
});

// ── pages router end to end ──────────────────────────────────────────────────

describe('Next.js Pages Router fixture', () => {
  it('lists the pages and collapses index files', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-pages'));
    expect(pathsOf(result, 'page').sort()).toEqual(['/', '/about', '/blog', '/blog/[slug]']);
  });

  it('excludes pages/api handlers', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-pages'));
    expect(result.entries.every((e) => !e.source.file.includes('/api/'))).toBe(true);
  });

  it('treats _app as a layout and _error as an error route', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-pages'));
    expect(result.entries.find((e) => e.kind === 'layout')?.source.file).toBe('pages/_app.tsx');
    expect(result.entries.find((e) => e.kind === 'error')?.source.file).toBe('pages/_error.tsx');
  });

  it('excludes _document, which is not a user-visible route', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-pages'));
    expect(result.entries.every((e) => !e.source.file.includes('_document'))).toBe(true);
  });
});

// ── react router end to end ──────────────────────────────────────────────────

describe('react-router path joining', () => {
  it.each([
    ['', 'orders', '/orders'],
    ['/', 'orders', '/orders'],
    ['/admin', 'users', '/admin/users'],
    ['/admin', '/root', '/root'],
    ['/admin', '', '/admin'],
  ])('joins %s + %s to %s', (parent, child, expected) => {
    expect(joinRoutePaths(parent, child)).toBe(expected);
  });
});

describe('React Router SPA fixture', () => {
  it('resolves nested object routes against their parent', async () => {
    const result = await runOn(path.join(FIXTURES, 'react-router'));
    expect(pathsOf(result)).toEqual(expect.arrayContaining(['/orders', '/orders/:orderId', '/settings']));
  });

  it('resolves nested JSX routes against their parent', async () => {
    const result = await runOn(path.join(FIXTURES, 'react-router'));
    expect(pathsOf(result)).toEqual(expect.arrayContaining(['/admin/users', '/admin/users/:userId']));
  });

  it('extracts dynamic params', async () => {
    const result = await runOn(path.join(FIXTURES, 'react-router'));
    expect(result.entries.find((e) => e.path === '/orders/:orderId')?.params).toEqual(['orderId']);
  });

  // A path held in a variable cannot be resolved without evaluating the module.
  it('reports a computed route path instead of guessing', async () => {
    const result = await runOn(path.join(FIXTURES, 'react-router'));
    expect(result.gaps.some((g) => g.kind === 'route-path-not-literal')).toBe(true);
  });

  it('reports line numbers, not just files', async () => {
    const result = await runOn(path.join(FIXTURES, 'react-router'));
    expect(result.entries.every((e) => (e.source.line ?? 0) > 0)).toBe(true);
  });
});

describe('route tables declared in a separate module', () => {
  it('resolves a relative import to the file it names', () => {
    const files = new Set(['src/utils/routes.js', 'src/App.js']);
    expect(resolveRelativeImport('src/App.js', './utils/routes.js', files)).toBe('src/utils/routes.js');
  });

  it('resolves a .js specifier onto a .tsx source', () => {
    const files = new Set(['src/routeTable.tsx']);
    expect(resolveRelativeImport('src/App.tsx', './routeTable.js', files)).toBe('src/routeTable.tsx');
  });

  it('resolves a directory import to its index file', () => {
    const files = new Set(['src/routes/index.ts']);
    expect(resolveRelativeImport('src/App.tsx', './routes', files)).toBe('src/routes/index.ts');
  });

  it('returns undefined for a bare package specifier', () => {
    expect(resolveRelativeImport('src/App.tsx', 'react-router-dom', new Set())).toBeUndefined();
  });

  // The common SPA shape: an exported array mapped into <Route> elements.
  it('extracts routes from a table imported by a router file', async () => {
    const result = await runOn(path.join(FIXTURES, 'react-router'));
    const fromTable = result.entries.filter((e) => e.source.file === 'src/routeTable.jsx').map((e) => e.path);

    expect(fromTable).toEqual(expect.arrayContaining(['/profile', '/billing']));
  });

  // A nav menu has `path` and `label`; a route has `path` and something to
  // render. Publishing menu entries as routes would invent URLs outright.
  it('ignores a lookalike array that has no element to render', async () => {
    const result = await runOn(path.join(FIXTURES, 'react-router'));
    const paths = pathsOf(result);

    expect(paths).not.toContain('/marketing-only');
    expect(paths).not.toContain('/not-a-real-route');
  });

  it('marks a wildcard table entry as catch-all', async () => {
    const result = await runOn(path.join(FIXTURES, 'react-router'));
    expect(result.entries.find((e) => e.path === '/*')?.isCatchAll).toBe(true);
  });
});

describe('never inventing a route from a failed parse', () => {
  // Regression: `<Route path={variable} />` used to fall through and publish a
  // route at the parent path, turning a parse failure into a fabricated URL.
  it('emits no entry when a JSX route path is computed', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"react-router-dom":"^6.26.0"}}',
      'src/App.jsx': `
import { Route, Routes } from 'react-router-dom';
import routes from './table.js';

export default function App() {
  return (
    <Routes>
      {routes.map(({ path, element }, i) => (
        <Route key={i} path={path} element={element} />
      ))}
    </Routes>
  );
}
`,
      'src/table.js': `
export default [
  { path: '/real', element: null },
];
`,
    });

    const result = await runOn(root);

    expect(result.entries.map((e) => e.path)).toEqual(['/real']);
    expect(result.gaps.some((g) => g.kind === 'route-path-not-literal')).toBe(true);
  });
});

describe('guard reporting honesty', () => {
  // An empty guard list must never read as "this route is public".
  it('records a gap when no guard mechanism exists to detect', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-pages'));
    const gap = result.gaps.find((g) => g.kind === 'no-guard-mechanism-detected');

    expect(gap).toBeDefined();
    expect(gap?.message).toContain('undetermined, not public');
  });

  it('does not record that gap when middleware is present', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    expect(result.gaps.some((g) => g.kind === 'no-guard-mechanism-detected')).toBe(false);
  });
});

// ── graceful degradation and determinism ─────────────────────────────────────

describe('degradation', () => {
  // SPEC 6.1: an inapplicable technology returns empty and skips, never throws.
  it('returns an inapplicable result for a repo with no router', async () => {
    const result = await runOn(path.join(FIXTURES, 'plain-node'));

    expect(result.applicable).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.skips[0]?.kind).toBe('no-router-detected');
  });

  it('does not throw on an empty directory', async () => {
    const root = await makeRepo({ 'readme.txt': 'nothing here' });
    await expect(runOn(root)).resolves.toMatchObject({ applicable: false });
  });
});

describe('duplicate routes', () => {
  // Two files claiming one URL is real rot, and only one can be reachable.
  it('reports a duplicate rather than silently dropping one', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"next":"^15.0.0"}}',
      'app/about/page.tsx': 'export default function A() { return null; }',
      'pages/about.tsx': 'export default function B() { return null; }',
    });

    const result = await runOn(root);
    const duplicate = result.gaps.find((g) => g.kind === 'duplicate-route');

    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toContain('app/about/page.tsx');
    expect(duplicate?.message).toContain('pages/about.tsx');
    expect(result.entries.filter((e) => e.path === '/about')).toHaveLength(2);
  });

  it('gives duplicated entries distinct ids', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"next":"^15.0.0"}}',
      'app/about/page.tsx': 'export default function A() { return null; }',
      'pages/about.tsx': 'export default function B() { return null; }',
    });

    const result = await runOn(root);
    const ids = result.entries.filter((e) => e.path === '/about').map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('determinism', () => {
  it.each(['next-app', 'next-pages', 'react-router'])('is byte-identical across runs on %s', async (name) => {
    const root = path.join(FIXTURES, name);
    const first = await runOn(root);
    const second = await runOn(root);

    const strip = (result: RoutesResult): string =>
      JSON.stringify({ ...result, durationMs: 0 });

    expect(strip(first)).toBe(strip(second));
  });

  it('sorts entries by path', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    const paths = result.entries.map((e) => e.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it('emits POSIX paths regardless of host platform', async () => {
    const result = await runOn(path.join(FIXTURES, 'next-app'));
    expect(result.entries.every((e) => !e.source.file.includes('\\'))).toBe(true);
  });
});
