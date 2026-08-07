import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Gap, Skip } from '../../types/core.js';
import type { JobEntry, JobsResult } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import type { Extractor, ExtractorContext } from '../types.js';
import { inapplicable, skip } from '../types.js';
import { parseAmqpJobs } from './amqp.js';
import { parseCodeJobs } from './code-jobs.js';
import { extractManifestJobs } from './manifests.js';

/**
 * Background work: queue consumers, cron jobs, and scheduled tasks.
 *
 * This is the part of a system QA has the least visibility into — "what happens
 * after an order is placed" is usually answered by a queue consumer nobody
 * documented. Triggers that are not literals are reported rather than guessed:
 * claiming a job runs hourly when it does not is a behavioural falsehood.
 */
export const jobsExtractor: Extractor<JobEntry> = {
  id: 'jobs',
  title: 'Background jobs',

  async run(context: ExtractorContext): Promise<JobsResult> {
    const startedAt = Date.now();
    const exclude = context.config.effectiveExclude;

    const files = (
      await fg(['**/*.{ts,js,mjs}'], { cwd: context.root, ignore: [...exclude], onlyFiles: true })
    )
      .map(toPosix)
      .sort();

    const entries: JobEntry[] = [];
    const gaps: Gap[] = [];
    const skips: Skip[] = [];
    const detected = new Set<string>();

    for (const relative of files) {
      let contents: string;
      try {
        contents = await fs.readFile(path.join(context.root, relative), 'utf8');
      } catch {
        continue;
      }

      // Cheap pre-filters; parsing every file in a large repo blows the budget.
      if (/\.consume\s*\(/.test(contents) && /amqp/i.test(contents)) {
        const parsed = parseAmqpJobs(relative, contents);
        if (parsed.entries.length > 0 || parsed.gaps.length > 0) detected.add('amqplib');
        entries.push(...parsed.entries);
        gaps.push(...parsed.gaps);
      }

      if (/\b(?:new\s+(?:Worker|Queue|Bull|QueueScheduler)\b|cron|scheduleJob|agenda)/i.test(contents)) {
        const parsed = parseCodeJobs(relative, contents);
        for (const entry of parsed.entries) {
          if (entry.runtime !== undefined) detected.add(entry.runtime);
        }
        entries.push(...parsed.entries);
        gaps.push(...parsed.gaps);
      }
    }

    const manifests = await extractManifestJobs({ root: context.root, exclude });
    if (manifests.found) {
      for (const entry of manifests.entries) {
        if (entry.runtime !== undefined) detected.add(entry.runtime);
      }
      entries.push(...manifests.entries);
      gaps.push(...manifests.gaps);
    }

    if (entries.length === 0 && gaps.length === 0) {
      return inapplicable<JobEntry>(
        'jobs',
        [
          skip(
            'jobs',
            'no-job-source-detected',
            'No queue consumer, cron schedule, or scheduled workflow was found.',
          ),
        ],
        Date.now() - startedAt,
      );
    }

    const { deduped, duplicateGaps } = resolveDuplicates(entries);

    return {
      extractor: 'jobs',
      applicable: true,
      detected: [...detected].sort(),
      entries: [...deduped].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      gaps: [...gaps, ...duplicateGaps].sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          (a.source?.file ?? '').localeCompare(b.source?.file ?? '') ||
          a.message.localeCompare(b.message),
      ),
      skips,
      durationMs: Date.now() - startedAt,
    };
  },
};

/** Two consumers on one queue is normal (scaling), so this only disambiguates ids. */
function resolveDuplicates(entries: readonly JobEntry[]): {
  deduped: readonly JobEntry[];
  duplicateGaps: readonly Gap[];
} {
  const byId = new Map<string, JobEntry[]>();
  for (const entry of entries) {
    const bucket = byId.get(entry.id);
    if (bucket === undefined) byId.set(entry.id, [entry]);
    else bucket.push(entry);
  }

  const deduped: JobEntry[] = [];
  for (const [, bucket] of byId) {
    if (bucket.length === 1) {
      deduped.push(bucket[0] as JobEntry);
      continue;
    }
    for (const entry of bucket) {
      const suffix = createHash('sha256')
        .update(`${entry.source.file}:${entry.source.line ?? 0}`)
        .digest('hex')
        .slice(0, 8);
      deduped.push({ ...entry, id: `${entry.id}#${suffix}` });
    }
  }

  return { deduped, duplicateGaps: [] };
}
