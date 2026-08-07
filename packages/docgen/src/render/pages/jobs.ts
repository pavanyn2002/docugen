import type { GenerationContext } from '../../types/core.js';
import type { JobEntry, JobsResult } from '../../types/entries.js';
import type { StackReport } from '../../detect/stack.js';
import { renderGaps, renderInapplicable, renderProvenance } from '../common.js';
import { certaintyBadge, cell, code, renderFrontMatter, note, section, sourceLink, table } from '../markdown.js';

/**
 * jobs.md — what runs without anyone clicking anything.
 *
 * This is the section a QA engineer has least visibility into: "what happens
 * after an order is placed" is usually answered by a queue consumer that
 * appears in no UI and no API.
 */
export function renderJobsPage(args: {
  result: JobsResult;
  stack: StackReport;
  context: GenerationContext;
  outDir: string;
}): string {
  const { result, stack, context, outDir } = args;
  const head = renderFrontMatter({ title: 'Jobs', confidence: 'verified', context });

  if (!result.applicable) {
    return `${head}# Background jobs\n\n${renderInapplicable(result, stack)}`;
  }

  let body = `${head}# Background jobs\n\n`;
  body += renderProvenance(result);
  body += note([
    'Only work that actually runs is listed. A queue declared for publishing is not a job;',
    'where one has no consumer in this repository, that is recorded under **Not determined**',
    'because the consumer usually lives in another service.',
  ]);

  const columns = [
    { header: 'Name', render: (entry: JobEntry) => code(entry.name) },
    { header: 'Kind', render: (entry: JobEntry) => cell(entry.kind) },
    {
      header: 'Trigger',
      // A job whose schedule is not a literal has an undetermined trigger.
      // Leaving this blank would read as "runs once", which is a claim.
      render: (entry: JobEntry) =>
        entry.schedule !== undefined
          ? code(entry.schedule)
          : entry.channel !== undefined
            ? `on message to ${code(entry.channel)}`
            : '_undetermined_',
    },
    { header: 'Runtime', render: (entry: JobEntry) => cell(entry.runtime) },
    {
      header: 'Source',
      render: (entry: JobEntry) =>
        `${sourceLink(entry.handler ?? entry.source, outDir)}${certaintyBadge(entry.certainty)}`,
    },
  ];

  const byKind = new Map<string, JobEntry[]>();
  for (const entry of result.entries) {
    const bucket = byKind.get(entry.kind) ?? [];
    bucket.push(entry);
    byKind.set(entry.kind, bucket);
  }

  const KIND_TITLES: Readonly<Record<string, string>> = {
    'queue-consumer': 'Queue consumers',
    cron: 'Scheduled (cron)',
    'scheduled-task': 'Scheduled tasks',
    worker: 'Workers',
  };

  body += section(`Jobs (${result.entries.length})`, '');
  for (const kind of [...byKind.keys()].sort()) {
    body += section(KIND_TITLES[kind] ?? kind, table(columns, byKind.get(kind) ?? []), 3);
  }

  body += renderGaps(result.gaps, outDir);
  return body;
}
