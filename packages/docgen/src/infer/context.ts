import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EvidenceGraph } from '../graph/types.js';
import { redactSecrets } from '../privacy/redact.js';
import type { Surface } from '../surface/types.js';
import type { SourceRef } from '../types/core.js';
import { parseSourceFile, ts, walk } from '../util/ts-ast.js';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';
import type { ExtractionBundleLike } from './facts.js';
import { renderFacts } from './facts.js';
import { renderGraphNeighborhood, selectGraphNeighborhood } from './graph-context.js';

export interface EvidenceExcerpt {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** The exact code, facts, and graph neighborhood sent for one surface. */
export interface SurfaceContext {
  readonly surface: Surface;
  readonly facts: string;
  readonly graph: string;
  readonly graphNodeCount: number;
  readonly graphEdgeCount: number;
  readonly code: string;
  readonly includedFiles: readonly string[];
  readonly omittedFiles: readonly string[];
  readonly includedEvidence: readonly EvidenceExcerpt[];
  readonly contentHash: string;
  readonly redactions: number;
  readonly redactionKinds: readonly string[];
}

export interface ContextLimits {
  readonly maxFiles: number;
  readonly maxBytesPerFile: number;
  readonly maxTotalBytes: number;
}

export async function buildSurfaceContext(args: {
  root: string;
  surface: Surface;
  bundle: ExtractionBundleLike;
  limits: ContextLimits;
  graph?: EvidenceGraph;
  redact?: boolean;
}): Promise<SurfaceContext> {
  const { root, surface, bundle, limits } = args;
  const neighborhood = args.graph === undefined
    ? undefined
    : selectGraphNeighborhood({ graph: args.graph, surfaceId: surface.id });
  const graph = renderGraphNeighborhood(neighborhood);
  const evidenceByFile = groupEvidence(neighborhood?.evidence ?? []);
  const candidates = [
    ...new Set([
      ...surface.sourceFiles.map(toPosix).sort(compareStrings),
      ...[...evidenceByFile.keys()].sort(compareStrings),
    ]),
  ];
  const included: string[] = [];
  const omitted: string[] = [];
  const chunks: string[] = [];
  const includedEvidence: EvidenceExcerpt[] = [];
  let totalBytes = 0;
  let redactionCount = 0;
  const redactionKinds = new Set<string>();

  for (const relative of candidates) {
    if (included.length >= limits.maxFiles) {
      omitted.push(relative);
      continue;
    }
    let contents: string;
    try {
      const target = resolveWithinRoot(root, relative);
      if (target === undefined) {
        omitted.push(relative);
        continue;
      }
      contents = await fs.readFile(target, 'utf8');
    } catch {
      omitted.push(relative);
      continue;
    }

    const excerpt = renderSourceExcerpt(
      contents,
      evidenceByFile.get(relative) ?? [],
      limits.maxBytesPerFile,
      relative,
    );
    const redacted = args.redact === false
      ? { text: excerpt.text, count: 0, kinds: [] as readonly string[] }
      : redactSecrets(excerpt.text);
    redactionCount += redacted.count;
    for (const kind of redacted.kinds) redactionKinds.add(kind);

    const bytes = Buffer.byteLength(redacted.text);
    if (totalBytes + bytes > limits.maxTotalBytes) {
      omitted.push(relative);
      continue;
    }
    totalBytes += bytes;
    included.push(relative);
    includedEvidence.push(...excerpt.ranges.map((range) => ({ file: relative, ...range })));
    chunks.push(`### ${relative}\n\n\`\`\`text\n${redacted.text}\n\`\`\`\n`);
  }

  const omissionNote = omitted.length === 0
    ? ''
    : `\n> Note: ${omitted.length} file(s) belonging to this graph neighborhood were not included ` +
      `(${omitted.slice(0, 5).join(', ')}${omitted.length > 5 ? ', …' : ''}). ` +
      'Do not describe behaviour that would live in them; record it as an unknown instead.\n';
  const code = chunks.length === 0
    ? '_No source files could be read for this surface._'
    : chunks.join('\n');
  const renderedCode = `${omissionNote}${code}`;

  return {
    surface,
    facts: renderFacts(surface, bundle),
    graph,
    graphNodeCount: neighborhood?.nodes.length ?? 0,
    graphEdgeCount: neighborhood?.edges.length ?? 0,
    code: renderedCode,
    includedFiles: included,
    omittedFiles: omitted,
    includedEvidence,
    contentHash: hashContext(surface, included, graph, renderedCode),
    redactions: redactionCount,
    redactionKinds: [...redactionKinds].sort(compareStrings),
  };
}

function hashContext(surface: Surface, files: readonly string[], graph: string, code: string): string {
  return createHash('sha256')
    .update(surface.id)
    .update('\u0000')
    .update(files.join('\u0000'))
    .update('\u0000')
    .update(graph)
    .update('\u0000')
    .update(code)
    .digest('hex')
    .slice(0, 32);
}

function groupEvidence(evidence: readonly SourceRef[]): ReadonlyMap<string, readonly number[]> {
  const grouped = new Map<string, Set<number>>();
  for (const ref of evidence) {
    const file = toPosix(ref.file);
    const lines = grouped.get(file) ?? new Set<number>();
    if (ref.line !== undefined) lines.add(ref.line);
    grouped.set(file, lines);
  }
  return new Map(
    [...grouped.entries()].map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)]),
  );
}

function resolveWithinRoot(root: string, relative: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  const relation = path.relative(resolvedRoot, target);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    return undefined;
  }
  return target;
}

function renderSourceExcerpt(
  contents: string,
  evidenceLines: readonly number[],
  maxBytes: number,
  file: string,
): { readonly text: string; readonly ranges: readonly Omit<EvidenceExcerpt, 'file'>[] } {
  const lines = contents.replace(/\r\n/g, '\n').split('\n');
  const windows = evidenceLines.length === 0
    ? [{ startLine: 1, endLine: lines.length }]
    : mergeRanges(componentEvidenceRanges(file, contents, evidenceLines, lines.length));
  const rendered: string[] = [];
  const ranges: Array<Omit<EvidenceExcerpt, 'file'>> = [];
  let bytes = 0;

  for (const window of windows) {
    let actualStart: number | undefined;
    let actualEnd: number | undefined;
    for (let line = window.startLine; line <= window.endLine; line += 1) {
      const value = `${line.toString().padStart(6, ' ')} | ${lines[line - 1] as string}`;
      const addition = Buffer.byteLength(`${rendered.length === 0 ? '' : '\n'}${value}`);
      if (bytes + addition > maxBytes) break;
      rendered.push(value);
      bytes += addition;
      actualStart ??= line;
      actualEnd = line;
    }
    if (actualStart !== undefined && actualEnd !== undefined) {
      ranges.push({ startLine: actualStart, endLine: actualEnd });
    }
    if (bytes >= maxBytes) break;
  }

  if (ranges.length === 0 && lines.length > 0) {
    const fallback = `     1 | ${lines[0] as string}`;
    if (Buffer.byteLength(fallback) <= maxBytes) {
      return { text: fallback, ranges: [{ startLine: 1, endLine: 1 }] };
    }
  }
  const truncated = ranges.some((range, index) => {
    const expected = windows[index];
    return expected !== undefined && range.endLine < expected.endLine;
  }) || ranges.length < windows.length;
  return {
    text: `${rendered.join('\n')}${truncated ? '\n… [source excerpt truncated by docgen]' : ''}`,
    ranges,
  };
}

function mergeRanges(
  ranges: readonly Omit<EvidenceExcerpt, 'file'>[],
): readonly Omit<EvidenceExcerpt, 'file'>[] {
  const merged: Array<Omit<EvidenceExcerpt, 'file'>> = [];
  for (const range of [...ranges].sort((a, b) => a.startLine - b.startLine)) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.startLine <= previous.endLine + 1) {
      merged[merged.length - 1] = {
        startLine: previous.startLine,
        endLine: Math.max(previous.endLine, range.endLine),
      };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** Expand React evidence to its enclosing component, including handlers and JSX. */
function componentEvidenceRanges(
  file: string, contents: string, evidenceLines: readonly number[], lineCount: number,
): readonly Omit<EvidenceExcerpt, 'file'>[] {
  const ranges = evidenceLines.map(line => ({ startLine: Math.max(1, line - 20), endLine: Math.min(lineCount, line + 20) }));
  if (!/\.(?:tsx|jsx|ts|js|mjs|cjs)$/.test(file) || !contents.includes('<')) return ranges;
  const source = parseSourceFile(file, contents);
  walk(source, node => {
    if (!ts.isFunctionDeclaration(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return;
    const startLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const endLine = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    if (!evidenceLines.some(line => line >= startLine && line <= endLine)) return;
    let hasJsx = false;
    walk(node, child => { if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) hasJsx = true; });
    if (hasJsx) ranges.push({ startLine, endLine });
  });
  return ranges;
}
