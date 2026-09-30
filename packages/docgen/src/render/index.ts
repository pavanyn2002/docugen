import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunResult } from '../pipeline.js';
import type {
  ConfigResult,
  DepsResult,
  EndpointsResult,
  JobsResult,
  RoutesResult,
  SchemaResult,
} from '../types/entries.js';
import { renderApiPage } from './pages/api.js';
import { renderConfigPage } from './pages/config.js';
import { renderJobsPage } from './pages/jobs.js';
import { renderReadme } from './pages/readme.js';
import { renderRoutesPage } from './pages/routes.js';
import { renderSchemaPage } from './pages/schema.js';
import { renderErd, renderIntegrations, renderModules, renderSitemap } from './diagrams.js';
import { chunkSurfaces } from '../surface/chunk.js';
import { REQUIREMENTS_DIR } from '../config/paths.js';
import { compareStrings } from '../util/sort.js';
import { computeFindings } from '../analysis/findings.js';
import type { FindingsReport } from '../analysis/findings.js';
import { computeGovernanceFiles } from '../governance/expected.js';
import { writeFileAtomically } from '../util/atomic.js';
import { projectRenderResults } from './projection.js';
import { assertGeneratedPath, assertGeneratedTargets, isGeneratedFile } from '../util/generated.js';
import { computeWalkthroughFiles } from '../walkthrough/render.js';

/** A file to write: repo-relative POSIX path and its full contents. */
export interface RenderedFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * Turn a run into the exact set of files to write.
 *
 * Pure: it performs no I/O, so the same run always produces the same bytes and
 * a test can assert that without touching a disk.
 */
export function renderAll(
  run: RunResult,
  findings?: FindingsReport,
  lanes: { behaviour?: boolean; requirements?: boolean; walkthroughs?: boolean } = {},
): readonly RenderedFile[] {
  const outDir = run.config.outDir.split(path.sep).join('/').replace(/\/+$/, '');
  const context = run.context;
  const stack = run.stack;
  const projectedResults = projectRenderResults(run.graph, run.results);
  const projectedRun: RunResult = { ...run, results: projectedResults };

  const get = <T>(id: Parameters<RunResult['results']['get']>[0]): T | undefined =>
    projectedResults.get(id) as T | undefined;

  const routes = get<RoutesResult>('routes');
  const endpoints = get<EndpointsResult>('endpoints');
  const schema = get<SchemaResult>('schema');
  const jobs = get<JobsResult>('jobs');
  const config = get<ConfigResult>('config');
  const deps = get<DepsResult>('deps');

  // The surface chunker groups endpoints the way a reader asks about them,
  // including stripping a mount prefix shared by the whole service.
  const surfaceSet = chunkSurfaces({
    routes: routes?.entries ?? [],
    endpoints: endpoints?.entries ?? [],
    jobs: jobs?.entries ?? [],
    overrides: run.config.surfaces.overrides.map((override) => ({
      id: override.id,
      kind: override.kind,
      include: override.include,
      ...(override.title === undefined ? {} : { title: override.title }),
    })),
    apiBasePaths: run.config.surfaces.apiBasePaths,
  });

  const files: RenderedFile[] = [
    { path: `${outDir}/README.md`, contents: renderReadme(projectedRun, findings, lanes) },
  ];

  // A section whose extractor did not run is omitted rather than written empty:
  // an empty page and a page that was never generated mean different things.
  if (routes !== undefined) {
    files.push({
      path: `${outDir}/routes.md`,
      contents: renderRoutesPage({ result: routes, stack, context, outDir }),
    });
  }
  if (endpoints !== undefined) {
    files.push({
      path: `${outDir}/api.md`,
      contents: renderApiPage({
        result: endpoints,
        stack,
        context,
        outDir,
        surfaces: surfaceSet.surfaces,
        surfaceNotes: surfaceSet.notes,
      }),
    });
  }
  if (schema !== undefined) {
    files.push({
      path: `${outDir}/schema.md`,
      contents: renderSchemaPage({ result: schema, stack, context, outDir }),
    });
  }
  if (jobs !== undefined) {
    files.push({
      path: `${outDir}/jobs.md`,
      contents: renderJobsPage({ result: jobs, stack, context, outDir }),
    });
  }
  if (config !== undefined) {
    files.push({
      path: `${outDir}/config.md`,
      contents: renderConfigPage({ result: config, stack, context, outDir }),
    });
  }

  const maxNodes = run.config.diagrams.maxNodes;
  files.push(
    { path: `${outDir}/diagrams/sitemap.mmd`, contents: renderSitemap(routes, maxNodes) },
    { path: `${outDir}/diagrams/erd.mmd`, contents: renderErd(schema, maxNodes) },
    { path: `${outDir}/diagrams/modules.mmd`, contents: renderModules(deps, maxNodes) },
    {
      path: `${outDir}/diagrams/integrations.mmd`,
      contents: renderIntegrations({ deps, config, projectName: path.basename(run.config.root) }),
    },
  );

  return files.sort((a, b) =>compareStrings(a.path, b.path));
}

export interface WriteReport {
  readonly written: readonly string[];
  readonly outDir: string;
  readonly gitattributesUpdated: boolean;
}

/**
 * Write the rendered files, and mark the output directory as generated.
 *
 * Files are written with explicit LF endings. On Windows the default would be
 * whatever the platform prefers, which would make the same repo produce
 * different bytes on different machines and defeat the whole point.
 */
export async function writeAll(run: RunResult): Promise<WriteReport> {
  const findings = await computeFindings(run);
  const walkthroughFiles = await computeWalkthroughFiles(run);
  const files = [
    ...renderAll(run, findings, {
      behaviour: run.graph.nodes.some((node) => node.kind === 'surface') &&
        await hasGeneratedPage(run.config.root, `${run.config.outDir}/behaviour.md`),
      requirements: await hasFilesIn(run.config.root, REQUIREMENTS_DIR),
      walkthroughs: walkthroughFiles.length > 0,
    }),
    ...(await computeGovernanceFiles(run)),
    ...walkthroughFiles,
  ].sort((a, b) => compareStrings(a.path, b.path));
  const written: string[] = [];
  await assertGeneratedTargets(run.config.root, files.map((file) => file.path));

  for (const file of files) {
    const absolute = path.join(run.config.root, file.path);
    await writeFileAtomically(absolute, normaliseLineEndings(file.contents));
    written.push(file.path);
  }

  const gitattributesUpdated =
    run.config.gitattributes && (await ensureGitattributes(run.config.root, run.config.outDir));

  if (gitattributesUpdated) written.push('.gitattributes');

  return { written: written.sort(compareStrings), outDir: run.config.outDir, gitattributesUpdated };
}

/**
 * Link only an existing generated index, not orphaned card caches. The static
 * renderer reads an ownership header and never consumes inferred claims.
 */
async function hasGeneratedPage(root: string, file: string): Promise<boolean> {
  await assertGeneratedPath(root, file);
  try { return isGeneratedFile(file, await fs.readFile(path.join(root, file), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function hasFilesIn(root: string, directory: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(root, directory));
    return entries.some((entry) => entry.endsWith('.yaml'));
  } catch {
    return false;
  }
}

function normaliseLineEndings(contents: string): string {
  return contents.replace(/\r\n/g, '\n');
}

/**
 * Add the `linguist-generated` marker so the output collapses in pull request
 * diffs (SPEC 6.2). An existing entry is left alone rather than duplicated.
 */
export async function ensureGitattributes(root: string, outDir: string): Promise<boolean> {
  const file = path.join(root, '.gitattributes');
  const normalised = outDir.split(path.sep).join('/').replace(/\/+$/, '');
  const line = `${normalised}/** linguist-generated=true`;

  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    existing = '';
  }

  if (existing.split(/\r?\n/).some((current) => current.trim() === line)) return false;

  const prefix = existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
  await writeFileAtomically(file, `${prefix}${line}\n`);
  return true;
}
