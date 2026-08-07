import type { ExtractResult, ExtractorId, Gap } from '../types/core.js';
import type { StackReport } from '../detect/stack.js';
import { note, section, sourceLink, table, warning } from './markdown.js';

/**
 * The parts of a page that exist to stop a reader drawing a false conclusion.
 *
 * An empty page has three very different meanings — the technology is absent,
 * docgen cannot parse it, or it genuinely has no entries — and they are
 * indistinguishable unless stated. Every page therefore says which one applies.
 */

/** Explains an empty page, rather than leaving it to be read as "nothing here". */
export function renderInapplicable(result: ExtractResult, stack: StackReport): string {
  const reasons = result.skips.map((skip) => `- ${skip.message}`);
  const relevant = stack.unsupported.filter((tech) => tech.covers.length === 0);

  let body = `No ${result.extractor} were found in this repository.\n\n`;
  if (reasons.length > 0) body += `${reasons.join('\n')}\n\n`;

  if (relevant.length > 0) {
    body += warning([
      'This may be a coverage gap rather than an empty repository. docgen detected',
      'the following technologies it cannot document:',
      '',
      ...relevant.map(
        (tech) =>
          `- **${tech.name}** (\`${tech.evidence.file}\`)` +
          (tech.unsupportedNote === undefined ? '' : ` — ${tech.unsupportedNote}`),
      ),
    ]);
  } else {
    body += note([
      'docgen found no technology here that it recognises as a source for this section.',
      'If that is wrong, the stack may not be supported yet — see the detected stack in `README.md`.',
    ]);
  }

  return body;
}

/**
 * Everything the extractor could not determine.
 *
 * SPEC rule 5: a gap is recorded rather than filled with a plausible value.
 * Rendering them is what turns that discipline into something a reader can act
 * on, so this is never collapsed or truncated away.
 */
export function renderGaps(gaps: readonly Gap[], outDir: string): string {
  if (gaps.length === 0) return '';

  return section(
    `Not determined (${gaps.length})`,
    `${note([
      'These are things docgen could not establish from the code. They are **not** claims',
      'that something is missing or broken — they mark the limits of what static analysis',
      'could prove here.',
    ])}${table(
      [
        { header: 'Kind', render: (gap: Gap) => `\`${gap.kind}\`` },
        { header: 'Detail', render: (gap: Gap) => gap.message.replace(/\|/g, '\\|') },
        { header: 'Source', render: (gap: Gap) => sourceLink(gap.source, outDir) },
      ],
      gaps,
    )}`,
  );
}

/** Technologies relevant to this page that docgen cannot read. */
export function renderUnsupportedForPage(
  stack: StackReport,
  extractor: ExtractorId,
  covers: (id: string) => boolean,
): string {
  const relevant = stack.unsupported.filter((tech) => covers(tech.id));
  if (relevant.length === 0) return '';

  return warning([
    `This page is incomplete. docgen detected technology it cannot read for ${extractor}:`,
    '',
    ...relevant.map(
      (tech) =>
        `- **${tech.name}** (\`${tech.evidence.file}\`)` +
        (tech.unsupportedNote === undefined ? '' : ` — ${tech.unsupportedNote}`),
    ),
    '',
    'Anything those technologies define is absent below.',
  ]);
}

/** One-line provenance shown under each page heading. */
export function renderProvenance(result: ExtractResult): string {
  const sources =
    result.detected.length === 0 ? 'static analysis' : result.detected.map((d) => `\`${d}\``).join(', ');
  return `Read from ${sources}. Every row links to the code it came from.\n\n`;
}
