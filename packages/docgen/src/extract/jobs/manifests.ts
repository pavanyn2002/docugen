import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { JobEntry } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';

/**
 * Scheduled jobs declared in manifests rather than code.
 *
 * A GitHub Actions cron and a Vercel cron are real recurring jobs that touch
 * production, and neither appears anywhere in application source. Omitting them
 * would leave a QA engineer believing nothing runs on a schedule.
 */
export async function extractManifestJobs(args: {
  root: string;
  exclude: readonly string[];
}): Promise<{ entries: readonly JobEntry[]; gaps: readonly Gap[]; found: boolean }> {
  const entries: JobEntry[] = [];
  const gaps: Gap[] = [];
  let found = false;

  // ── Vercel crons ──────────────────────────────────────────────────────────
  for (const candidate of ['vercel.json']) {
    const file = path.join(args.root, candidate);
    let contents: string;
    try {
      contents = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      gaps.push({
        extractor: 'jobs',
        kind: 'manifest-unparseable',
        message: 'vercel.json is not valid JSON, so any crons it declares were not read.',
        source: { file: candidate },
      });
      continue;
    }

    const crons = (parsed as Record<string, unknown> | null)?.['crons'];
    if (!Array.isArray(crons)) continue;
    found = true;

    for (const cron of crons) {
      if (cron === null || typeof cron !== 'object') continue;
      const record = cron as Record<string, unknown>;
      const routePath = typeof record['path'] === 'string' ? record['path'] : undefined;
      const schedule = typeof record['schedule'] === 'string' ? record['schedule'] : undefined;
      if (routePath === undefined) continue;

      entries.push({
        id: `job:vercel-cron:${routePath}`,
        source: { file: candidate },
        extractionMethod: 'config',
        certainty: 'high',
        name: routePath,
        kind: 'cron',
        ...(schedule === undefined ? {} : { schedule }),
        channel: routePath,
        runtime: 'vercel-cron',
      });
    }
  }

  // ── GitHub Actions schedules ──────────────────────────────────────────────
  const workflows = (
    await fg(['.github/workflows/*.{yml,yaml}'], {
      cwd: args.root,
      ignore: [...args.exclude],
      onlyFiles: true,
      dot: true,
    })
  )
    .map(toPosix)
    .sort();

  for (const relative of workflows) {
    const contents = await fs.readFile(path.join(args.root, relative), 'utf8');
    const schedules = parseWorkflowSchedules(contents);
    if (schedules.length === 0) continue;
    found = true;

    const workflowName = /^name:\s*(.+)$/m.exec(contents)?.[1]?.trim().replace(/^["']|["']$/g, '');
    const name = workflowName ?? path.posix.basename(relative);

    for (const [index, schedule] of schedules.entries()) {
      entries.push({
        id: `job:gha:${relative}:${index}`,
        source: { file: relative },
        extractionMethod: 'config',
        certainty: 'high',
        name,
        kind: 'scheduled-task',
        schedule,
        runtime: 'github-actions',
      });
    }
  }

  return { entries, gaps, found };
}

/**
 * Read `on.schedule[].cron` from a workflow.
 *
 * Only two levels of structure are needed, and they are strictly
 * indentation-based, so this reads them directly rather than adding a YAML
 * dependency.
 */
export function parseWorkflowSchedules(contents: string): readonly string[] {
  const schedules: string[] = [];
  let inSchedule = false;

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    if (/^schedule\s*:/.test(trimmed)) {
      inSchedule = true;
      continue;
    }

    if (inSchedule) {
      const cron = /^-?\s*cron\s*:\s*(['"]?)(.+?)\1\s*$/.exec(trimmed);
      if (cron?.[2] !== undefined) {
        schedules.push(cron[2]);
        continue;
      }
      // Any other key at this level ends the schedule block.
      if (/^[a-zA-Z_][a-zA-Z0-9_-]*\s*:/.test(trimmed)) inSchedule = false;
    }
  }

  return schedules;
}
