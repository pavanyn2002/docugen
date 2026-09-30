import path from 'node:path';
import type { RunResult } from '../pipeline.js';
import type { RenderedFile } from '../render/index.js';
import { renderFrontMatter } from '../render/markdown.js';
import type { GenerationContext } from '../types/core.js';
import { compareStrings } from '../util/sort.js';
import { loadWalkthroughs } from './store.js';
import type { WalkthroughRecord } from './schema.js';
import { publicUrlSchema } from './schema.js';

function text(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]])/g, '\\$1');
}

function link(file: string): string {
  return file.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export function renderWalkthrough(record: WalkthroughRecord, context: GenerationContext, outDir: string): string {
  const lines = [
    renderFrontMatter({ title: record.title, confidence: record.status === 'reviewed' ? 'verified' : 'unknown', context, regenerateWith: 'docgen sync' }),
    `# ${text(record.title)}`, '',
    record.summary === undefined ? '' : `${text(record.summary)}\n`,
    '> [!NOTE]',
    '> Screenshots record visible UI state. Instructions were supplied by an author.',
    '> This guide does not establish backend behavior or replace confirmed requirements.', '',
    `- Recorded by: ${text(record.recordedBy)} at ${record.recordedAt}`,
    `- Source: ${record.source === 'capture' ? 'browser capture' : 'imported screenshots'}`,
    `- Snapshot: \`${record.contentHash}\``,
    record.review === undefined
      ? '- Review: **Draft — not yet reviewed.**'
      : `- Review: **Reviewed** by ${text(record.review.reviewedBy)} at ${record.review.reviewedAt}`,
    '',
  ];
  for (const [index, step] of record.steps.entries()) {
    const image = path.posix.relative(`${outDir}/walkthroughs`, step.screenshot.file);
    lines.push(`## ${index + 1}. ${text(step.title)}`, '', `${record.status === 'reviewed' ? '`verified`' : '`unknown`'} ${text(step.instruction)}`, '');
    if (step.expected !== undefined) lines.push(`Expected visible result: ${text(step.expected)}`, '');
    if (step.url !== undefined) lines.push(`Page: <${publicUrlSchema.parse(step.url)}>`, '');
    lines.push(`![${text(step.alt)}](${link(image)})`, '', `<sub>Screenshot SHA-256: ${step.screenshot.sha256}</sub>`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function computeWalkthroughFiles(run: RunResult, supplied?: readonly WalkthroughRecord[]): Promise<readonly RenderedFile[]> {
  const records = supplied ?? await loadWalkthroughs(run.config.root);
  if (records.length === 0) return [];
  const outDir = run.config.outDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const lines = [renderFrontMatter({ title: 'Screenshot walkthroughs', confidence: 'unknown', context: run.context, regenerateWith: 'docgen sync' }), '# Screenshot walkthroughs', '',
    'These guides contain recorded UI observations and authored instructions. Review applies to the exact screenshot and text snapshot.', '',
    ...records.map((record) => `- [${text(record.title)}](walkthroughs/${record.id}.md) — ${record.steps.length} step(s), ${record.status === 'reviewed' ? 'reviewed' : 'not yet reviewed'}`), '',
  ];
  return [
    { path: `${outDir}/walkthroughs.md`, contents: `${lines.join('\n').trimEnd()}\n` },
    ...records.map((record) => ({ path: `${outDir}/walkthroughs/${record.id}.md`, contents: renderWalkthrough(record, run.context, outDir) })),
  ].sort((a, b) => compareStrings(a.path, b.path));
}
