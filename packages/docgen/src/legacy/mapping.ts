import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EvidenceGraph, GraphNode } from '../graph/types.js';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';
import type { LegacyInventory } from './inventory.js';
import type { LegacyInventoryDocument } from './schema.js';

function addAlias(index: Map<string, string[]>, alias: string, node: GraphNode): void {
  const value = alias.trim();
  if (value.length === 0) return;
  const ids = index.get(value) ?? [];
  if (!ids.includes(node.id)) ids.push(node.id);
  index.set(value, ids.sort(compareStrings));
}

function graphAliases(graph: EvidenceGraph): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const node of graph.nodes) {
    addAlias(index, node.id, node);
    addAlias(index, node.label, node);
    const name = node.properties?.name;
    if (typeof name === 'string') addAlias(index, name, node);
  }
  return index;
}

function localTargets(file: string, line: string): readonly string[] {
  const targets = new Set<string>();
  for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1]?.trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
    if (
      raw === undefined ||
      raw.length === 0 ||
      raw.includes('\\') ||
      raw.startsWith('#') ||
      /^(?:[a-z]+:)?\/\//i.test(raw) ||
      /^(?:mailto|tel|data):/i.test(raw)
    ) continue;
    const withoutFragment = raw.split('#')[0]?.split('?')[0];
    if (withoutFragment === undefined || withoutFragment.length === 0) continue;
    const target = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(file), withoutFragment)));
    if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) continue;
    targets.add(target);
  }
  return [...targets].sort(compareStrings);
}

function inlineCode(line: string): readonly string[] {
  return [...new Set([...line.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]?.trim()).filter(
    (value): value is string => value !== undefined && value.length > 0,
  ))].sort(compareStrings);
}

function claimExcerpt(line: string): string | undefined {
  const value = line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+] |\d+[.)] |>{1,3}\s*)/, '')
    .replace(/!?(?:\[([^\]]*)\])\([^)]+\)/g, '$1')
    .replace(/[*_~]+/g, '')
    .trim();
  if (value.length === 0 || !/[A-Za-z0-9]/.test(value) || /^[-:|\s]+$/.test(value)) return undefined;
  return value.slice(0, 240);
}

function graphFileIds(graph: EvidenceGraph): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind !== 'file') continue;
    const ids = result.get(node.label) ?? [];
    ids.push(node.id);
    result.set(node.label, ids.sort(compareStrings));
  }
  return result;
}

function mappedDocument(
  document: LegacyInventoryDocument,
  contents: string,
  aliases: ReadonlyMap<string, readonly string[]>,
  files: ReadonlyMap<string, readonly string[]>,
): LegacyInventoryDocument {
  const references = document.references.map((reference) => ({
    ...reference,
    graphNodeIds: [...(files.get(reference.target) ?? [])],
  }));
  const claims: LegacyInventoryDocument['claims'][number][] = [];
  let inFence = false;

  contents.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence || /^\s{4,}\S/.test(line)) return;
    const excerpt = claimExcerpt(line);
    if (excerpt === undefined) return;

    const graphNodeIds = new Set<string>();
    const matchedBy = new Set<'local-reference' | 'inline-code'>();
    let uniqueAnchor = false;
    let ambiguousAnchor = false;
    for (const target of localTargets(document.path, line)) {
      const ids = files.get(target) ?? [];
      for (const id of ids) graphNodeIds.add(id);
      if (ids.length === 1) uniqueAnchor = true;
      if (ids.length > 0) matchedBy.add('local-reference');
    }
    for (const token of inlineCode(line)) {
      const ids = aliases.get(token) ?? [];
      for (const id of ids) graphNodeIds.add(id);
      if (ids.length === 1) uniqueAnchor = true;
      if (ids.length > 1) ambiguousAnchor = true;
      if (ids.length > 0) matchedBy.add('inline-code');
    }
    const mapping = uniqueAnchor ? 'mapped' : ambiguousAnchor ? 'ambiguous' : 'unmapped';
    claims.push({
      id: `legacy-claim:${createHash('sha256')
        .update(`${document.path}:${index + 1}:${line}`)
        .digest('hex')
        .slice(0, 16)}`,
      line: index + 1,
      excerpt,
      mapping,
      matchedBy: [...matchedBy].sort(compareStrings),
      graphNodeIds: [...graphNodeIds].sort(compareStrings),
    });
  });

  const mapped = claims.filter((claim) => claim.mapping === 'mapped').length;
  const evidenceStatus =
    claims.length > 0 && mapped === claims.length
      ? 'mapped'
      : mapped > 0
        ? 'partial'
        : references.length > 0 && references.every((reference) => !reference.exists)
          ? 'orphaned-references'
          : 'unmapped';
  return { ...document, evidenceStatus, references, claims };
}

/**
 * Anchor untrusted prose to exact graph identities. An anchor means “about
 * this entity”, never “verified by this entity”.
 */
export async function mapLegacyInventoryToGraph(options: {
  readonly root: string;
  readonly inventory: LegacyInventory;
  readonly graph: EvidenceGraph;
}): Promise<LegacyInventory> {
  const aliases = graphAliases(options.graph);
  const files = graphFileIds(options.graph);
  const documents: LegacyInventoryDocument[] = [];
  for (const document of options.inventory.documents) {
    if (document.ownership !== 'human-authored') {
      documents.push(document);
      continue;
    }
    try {
      const contents = await fs.readFile(path.join(options.root, document.path), 'utf8');
      documents.push(mappedDocument(document, contents, aliases, files));
    } catch {
      documents.push(document);
    }
  }
  const human = documents.filter((document) => document.ownership === 'human-authored');
  return {
    documents,
    counts: {
      ...options.inventory.counts,
      mapped: human.filter((document) => document.evidenceStatus === 'mapped').length,
      partial: human.filter((document) => document.evidenceStatus === 'partial').length,
      unmapped: human.filter((document) => document.evidenceStatus === 'unmapped').length,
      orphanedReferences: human.filter(
        (document) => document.evidenceStatus === 'orphaned-references',
      ).length,
    },
  };
}
