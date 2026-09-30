import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { extractReactRouterRoutes, joinRoutePaths } from '../src/extract/routes/react-router.js';
import { endpointsExtractor } from '../src/extract/endpoints/index.js';
import { configExtractor } from '../src/extract/config/index.js';
import { renderSitemap } from '../src/render/diagrams.js';
import { createLogger } from '../src/util/logger.js';
import { buildSurfaceContext } from '../src/infer/context.js';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import type { RoutesResult } from '../src/types/entries.js';

const roots: string[] = [];
const logger = createLogger({ level: 'silent' });
async function repo(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docugen-spa-'));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  }
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

const app = `import { BrowserRouter, Routes, Route } from 'react-router-dom';
export const App = () => <BrowserRouter><Routes>
  <Route path="/krsna" element={<Login />} />
  <Route path="/krsna/*" element={<PrivateRoute><Layout><Routes>
    <Route index element={<HomeRedirect />} />
    <Route path="dashboard" element={<Dashboard />} />
    <Route path="my-leads" element={<Leads />} />
  </Routes></Layout></PrivateRoute>} />
  <Route path="*" element={<Login />} />
</Routes></BrowserRouter>;`;

it('normalizes wildcard parents for relative and index children', () => {
  expect(joinRoutePaths('/krsna/*', 'dashboard')).toBe('/krsna/dashboard');
  expect(joinRoutePaths('/krsna/*', '')).toBe('/krsna');
  expect(joinRoutePaths('*', 'dashboard')).toBe('/dashboard');
  expect(joinRoutePaths('/krsna/*', '/absolute')).toBe('/absolute');
  expect(joinRoutePaths('/krsna/*', '*')).toBe('/krsna/*');
});
it('extracts nested JSX in element attributes without an index collision', async () => {
  const root = await repo({ 'App.tsx': app });
  const result = await extractReactRouterRoutes({ root, include: [], exclude: [] });
  expect(result.entries.map(e => e.path).sort()).toEqual(['/*', '/krsna', '/krsna/*', '/krsna/dashboard', '/krsna/my-leads']);
  expect(result.gaps).toEqual([]);
});
it('still reports duplicate explicit routes', async () => {
  const root = await repo({ 'App.tsx': app.replace('<Route path="*"', '<Route path="/krsna"') });
  const result = await extractReactRouterRoutes({ root, include: [], exclude: [] });
  expect(result.gaps.filter(g => g.kind === 'duplicate-route-path')).toHaveLength(1);
});
it('uses distinct sitemap IDs for wildcard and punctuation collisions', async () => {
  const root = await repo({ 'App.tsx': app });
  const result = await extractReactRouterRoutes({ root, include: [], exclude: [] });
  const diagram = renderSitemap({ ...result, extractor: 'routes', applicable: true, detected: [], skips: [], durationMs: 0 } as RoutesResult, 100);
  const ids = [...diagram.matchAll(/^  (\w+)\[/gm)].map(m => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const edge of diagram.matchAll(/^  (\w+) --> (\w+)/gm)) expect(edge[1]).not.toBe(edge[2]);
  expect(diagram).toContain('dashboard');
});
it('discovers Vercel handlers at root and workspace roots, excluding helper and Next files', async () => {
  const root = await repo({
    'package.json': JSON.stringify({ private: true, workspaces: ['admin-ui'] }),
    'admin-ui/package.json': '{}',
    'admin-ui/api/admin/[...path].js': 'module.exports = async function handler(req, res) { res.status(200).send("ok"); };',
    'admin-ui/api/users/[id].ts': 'export default async function handler(req, res) { res.end(); }',
    'api/health.mjs': 'export default (req, res) => res.end("ok");',
    'api/helper.cjs': 'module.exports = { helper: true };',
    'pages/api/next.ts': 'export default function handler(req, res) {}',
  });
  const config = await loadConfig({ root });
  const result = await endpointsExtractor.run({ root, config, logger });
  expect(result.detected).toContain('vercel');
  const vercel = result.entries.filter(e => e.application?.includes(':vercel:'));
  expect(vercel.map(e => e.path).sort()).toEqual(['/api/admin/*', '/api/health', '/api/users/:id']);
  expect(vercel.every(e => e.method === 'ALL' && e.source.line !== undefined)).toBe(true);
  expect(vercel.find(e => e.path === '/api/users/:id')?.params).toEqual(['id']);
});
it('honors ordered gitignore negations and always scans env declaration templates', async () => {
  const root = await repo({
    '.gitignore': '.env\n.env.*\n!.env.example\n!**/.env.example\nignored/*\n!ignored/keep.ts\nignored/reignored.ts\n!ignored/reignored.ts\nignored/reignored.ts\n',
    '.env.example': 'ADMIN_API_KEY=\nOMNICHANNEL_API_URL=https://example.com',
    '.env.template': 'TEMPLATE_VALUE=', '.env.defaults': 'DEFAULT_VALUE=',
    'app.ts': 'process.env.ADMIN_API_KEY; process.env.OMNICHANNEL_API_URL;',
    'ignored/drop.ts': 'process.env.DROP;', 'ignored/keep.ts': 'process.env.KEEP;',
    'ignored/reignored.ts': 'process.env.REIGNORED;',
  });
  const config = await loadConfig({ root });
  expect(config.gitignoreNegations).toEqual([]);
  const result = await configExtractor.run({ root, config, logger });
  expect(result.entries.map(e => e.name)).toEqual(['ADMIN_API_KEY', 'DEFAULT_VALUE', 'KEEP', 'OMNICHANNEL_API_URL', 'TEMPLATE_VALUE']);
  expect(result.entries.find(e => e.name === 'ADMIN_API_KEY')?.declarations).toHaveLength(1);
  expect(result.gaps.find(g => g.kind === 'env-read-never-declared')?.message).not.toContain('ADMIN_API_KEY');
});
it('includes the complete Login component rather than only its setup window', async () => {
  const login = ['export default function Login() {', '  const timer = 30;', ...Array.from({ length: 60 }, (_, i) => '  // setup ' + i), '  async function submit() { await fetch("/api/login"); }', '  return <form onSubmit={submit}><button>Sign in</button></form>;', '}'].join('\n');
  const root = await repo({ 'Login.tsx': login });
  const builder = new EvidenceGraphBuilder();
  builder.addNode({ id: 'surface:screen:login', kind: 'surface', label: 'Login', provenance: { origin: 'extracted', certainty: 'high', evidence: [{ file: 'Login.tsx', line: 1 }] } });
  const context = await buildSurfaceContext({ root, graph: builder.build(), bundle: {}, surface: { id: 'screen:login', slug: 'login', kind: 'screen', title: 'Login', sourceFiles: ['Login.tsx'], routes: [], supportingRoutes: [], endpoints: [], jobs: [], origin: 'derived' }, limits: { maxFiles: 10, maxBytesPerFile: 10000, maxTotalBytes: 40000 } });
  expect(context.code).toContain('onSubmit={submit}');
  expect(context.code).toContain('/api/login');
  expect(context.includedEvidence).toContainEqual({ file: 'Login.tsx', startLine: 1, endLine: 65 });
});
