import path from 'node:path';
import type { GenerationContext, SourceRef, TrustLane } from '../types/core.js';

/**
 * Markdown primitives shared by every page.
 *
 * Two rules run through all of this. Output must be byte-identical between
 * runs, so nothing here reads a clock or a random value. And nothing may state
 * a behavioural claim without a badge — the helpers below make the badged form
 * the easy one to write.
 */

/** Warns a reader, and any editor, that hand edits will be overwritten. */
export const GENERATED_MARKER = '<!-- docgen:generated -->';

export interface PageMeta {
  readonly title: string;
  readonly confidence: TrustLane;
  readonly context: GenerationContext;
  /** Only README carries a timestamp; every other page must stay stable. */
  readonly includeTimestamp?: boolean;
  /** Command that regenerates this page. Defaults to the static-lane one. */
  readonly regenerateWith?: string;
}

/**
 * YAML front matter plus the do-not-edit marker.
 *
 * `confidence` is the file-level trust lane (SPEC section 3). Phase 0 emits
 * only `verified`, because every statement here comes from a parser reading
 * real code.
 */
export function renderFrontMatter(meta: PageMeta): string {
  const lines = [
    '---',
    'generated: true',
    `engine_version: ${meta.context.engineVersion}`,
    `source_commit: ${meta.context.sourceCommit ?? 'unknown'}`,
    `confidence: ${meta.confidence}`,
  ];
  if (meta.includeTimestamp === true && meta.context.generatedAt !== undefined) {
    lines.push(`source_commit_date: ${meta.context.generatedAt}`);
  }
  lines.push('---', '', GENERATED_MARKER, '');
  lines.push(
    `<!-- Do not edit by hand. Regenerate with \`${
      meta.regenerateWith ?? 'docgen extract'
    }\`; changes here will be lost. -->`,
    '',
    '',
  );
  return lines.join('\n');
}

/** Escape a value for use inside a markdown table cell. */
export function cell(value: string | undefined): string {
  if (value === undefined || value.length === 0) return '—';
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Wrap in backticks, escaping any backticks already present. */
export function code(value: string | undefined): string {
  if (value === undefined || value.length === 0) return '—';
  const fence = value.includes('`') ? '``' : '`';
  return `${fence}${value}${fence}`;
}

export interface TableColumn<T> {
  readonly header: string;
  readonly render: (row: T) => string;
}

/** Render a table, or a plain note when there are no rows. */
export function table<T>(columns: readonly TableColumn<T>[], rows: readonly T[]): string {
  if (rows.length === 0) return '_None._\n';

  const header = `| ${columns.map((column) => column.header).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => column.render(row)).join(' | ')} |`);
  return [header, divider, ...body, ''].join('\n');
}

/**
 * A clickable link back to the source, so any claim can be verified in one
 * click (SPEC 6.2). The `#L42` fragment is what GitHub uses to jump to a line.
 */
export function sourceLink(ref: SourceRef | undefined, outDir: string): string {
  if (ref === undefined) return '—';
  const prefix = pathToRepoRoot(outDir);
  const label = ref.line === undefined ? ref.file : `${ref.file}:${ref.line}`;
  const target = ref.line === undefined ? `${prefix}${ref.file}` : `${prefix}${ref.file}#L${ref.line}`;
  return `[${label}](${target})`;
}

/** Relative prefix from the output directory back to the repo root. */
export function pathToRepoRoot(outDir: string): string {
  const depth = outDir.split('/').filter((segment) => segment.length > 0 && segment !== '.').length;
  return depth === 0 ? './' : '../'.repeat(depth);
}

/**
 * Inline badge for anything not read from a real parser.
 *
 * Phase 0 produces no `inferred` content, but a regex-derived entry is lower
 * certainty than an AST read (SPEC 6.1) and a reader has to be able to see
 * which is which without checking the source.
 */
export function certaintyBadge(certainty: 'high' | 'low'): string {
  return certainty === 'low' ? ' `~heuristic`' : '';
}

/** Heading plus body, with the blank lines markdown needs around them. */
export function section(title: string, body: string, level = 2): string {
  const trimmed = body.trimEnd();
  if (trimmed.length === 0) return `${'#'.repeat(level)} ${title}\n\n`;
  return `${'#'.repeat(level)} ${title}\n\n${trimmed}\n\n`;
}

/** A callout that a reader cannot skim past. */
export function warning(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return `> [!WARNING]\n${lines.map((line) => `> ${line}`).join('\n')}\n\n`;
}

export function note(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return `> [!NOTE]\n${lines.map((line) => `> ${line}`).join('\n')}\n\n`;
}

/** POSIX join that keeps output identical on Windows. */
export function joinOut(outDir: string, file: string): string {
  return path.posix.join(outDir.split(path.sep).join('/'), file);
}
