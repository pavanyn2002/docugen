import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';
import type { LegacyInventoryDocument } from './schema.js';

const DOCUMENT_GLOBS = ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc', '**/*.txt'];
const SCAN_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.cache/**',
  '**/coverage/**',
];
const RECORD_PREFIXES = [
  'docs/.cards/',
  'docs/.answers/',
  'docs/.requirements/',
  'docs/.features/',
  'docs/.plans/',
  'docs/.changes/',
  'docs/.legacy/',
  '.docgen/',
];

export interface LegacyInventory {
  readonly documents: readonly LegacyInventoryDocument[];
  readonly counts: {
    readonly total: number;
    readonly humanAuthored: number;
    readonly docgenGenerated: number;
    readonly docgenRecords: number;
    readonly archivedHuman: number;
    readonly unreviewed: number;
    readonly duplicates: number;
    readonly mapped?: number;
    readonly partial?: number;
    readonly unmapped?: number;
    readonly orphanedReferences?: number;
  };
}

function formatOf(file: string): LegacyInventoryDocument['format'] {
  if (file.endsWith('.mdx')) return 'mdx';
  if (file.endsWith('.rst')) return 'restructured-text';
  if (file.endsWith('.adoc')) return 'asciidoc';
  if (file.endsWith('.txt')) return 'text';
  return 'markdown';
}

function ownershipOf(file: string, outDir: string): LegacyInventoryDocument['ownership'] {
  const generatedPrefixes = [`${outDir.replace(/\/$/, '')}/`, 'docs/handoffs/'];
  if (generatedPrefixes.some((prefix) => file.startsWith(prefix))) return 'docgen-generated';
  if (file.startsWith('docs/legacy-archive/')) return 'archived-human';
  if (RECORD_PREFIXES.some((prefix) => file.startsWith(prefix))) return 'docgen-record';
  return 'human-authored';
}

function localReferenceTargets(file: string, contents: string): readonly string[] {
  if (!file.endsWith('.md') && !file.endsWith('.mdx')) return [];
  const targets = new Set<string>();
  for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
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

async function referencesOf(root: string, file: string, contents: string) {
  return Promise.all(
    localReferenceTargets(file, contents).map(async (target) => {
      try {
        await fs.stat(path.join(root, target));
        return { target, exists: true, graphNodeIds: [] } as const;
      } catch {
        return { target, exists: false, graphNodeIds: [] } as const;
      }
    }),
  );
}

/** Inventory prose as untrusted artifacts; content is hashed, never asserted as fact. */
export async function inventoryLegacyDocuments(options: {
  readonly root: string;
  readonly outDir: string;
}): Promise<LegacyInventory> {
  const files = (await fg(DOCUMENT_GLOBS, {
    cwd: options.root,
    ignore: SCAN_EXCLUDES,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
  }))
    .map(toPosix)
    .sort(compareStrings);
  const preliminary: LegacyInventoryDocument[] = [];

  for (const file of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(options.root, file), 'utf8');
    } catch {
      continue;
    }
    const ownership = ownershipOf(file, toPosix(options.outDir));
    preliminary.push({
      path: file,
      format: formatOf(file),
      ownership,
      bytes: Buffer.byteLength(contents),
      sha256: createHash('sha256').update(contents).digest('hex'),
      classification: 'unreviewed',
      rationale:
        ownership === 'human-authored'
          ? 'Content has not been evaluated against code evidence.'
          : 'Docgen-owned artifact; excluded from legacy migration decisions.',
      evidenceStatus: 'unmapped',
      references: await referencesOf(options.root, file, contents),
      claims: [],
    });
  }

  const canonicalByHash = new Map<string, string>();
  const documents = preliminary.map((document): LegacyInventoryDocument => {
    if (document.ownership !== 'human-authored') return document;
    const canonical = canonicalByHash.get(document.sha256);
    if (canonical === undefined) {
      canonicalByHash.set(document.sha256, document.path);
      return document;
    }
    return {
      ...document,
      classification: 'duplicate',
      rationale: `Byte-identical to ${canonical}; no semantic claim comparison was performed.`,
      duplicateOf: canonical,
    };
  });

  return {
    documents,
    counts: {
      total: documents.length,
      humanAuthored: documents.filter((document) => document.ownership === 'human-authored').length,
      docgenGenerated: documents.filter((document) => document.ownership === 'docgen-generated').length,
      docgenRecords: documents.filter((document) => document.ownership === 'docgen-record').length,
      archivedHuman: documents.filter((document) => document.ownership === 'archived-human').length,
      unreviewed: documents.filter(
        (document) => document.ownership === 'human-authored' && document.classification === 'unreviewed',
      ).length,
      duplicates: documents.filter((document) => document.classification === 'duplicate').length,
    },
  };
}
