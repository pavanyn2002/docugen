import { createHash } from 'node:crypto';
import type { Gap, Skip } from '../../types/core.js';
import type { EndpointEntry, EndpointsResult } from '../../types/entries.js';
import type { Extractor, ExtractorContext } from '../types.js';
import { inapplicable, skip } from '../types.js';
import { extractExpressEndpoints } from './express.js';
import { extractNextApiEndpoints } from './next-api.js';
import { extractNestEndpoints } from './nest.js';
import { extractFastApiEndpoints } from './fastapi.js';
import { extractDjangoEndpoints } from './django.js';
import { crossCheckAgainstSpec } from './openapi.js';
import { compareStrings } from '../../util/sort.js';
import { applicationScope, owningWorkspace, workspaceLabel } from '../../detect/ownership.js';

/**
 * Every API endpoint the repo serves.
 *
 * Providers are additive: a repo can serve Next route handlers from its web app
 * and Express routes from a service in the same monorepo.
 */
export const endpointsExtractor: Extractor<EndpointEntry> = {
  id: 'endpoints',
  title: 'API endpoints',

  async run(context: ExtractorContext): Promise<EndpointsResult> {
    const startedAt = Date.now();
    const exclude = context.config.effectiveExclude;
    const workspaces = context.workspaces ?? [{ dir: '', manifests: [] }];

    const entries: EndpointEntry[] = [];
    const gaps: Gap[] = [];
    const skips: Skip[] = [];
    const detected: string[] = [];

    const nextApi = await extractNextApiEndpoints({ root: context.root, exclude });
    if (nextApi.found) {
      detected.push('next-api');
      entries.push(...withOwnership(nextApi.entries, 'next-api', context));
      gaps.push(...nextApi.gaps);
    }

    const nest = await extractNestEndpoints({ root: context.root, exclude });
    if (nest.found) {
      detected.push('nestjs');
      entries.push(...withOwnership(nest.entries, 'nestjs', context));
      gaps.push(...nest.gaps);
    }

    // Nest is built on Express. In a monorepo, however, a Nest workspace must
    // not suppress independent Express services elsewhere.
    const express = await extractExpressEndpoints({ root: context.root, exclude, workspaces });
    if (express.found) {
      const nestWorkspaces = new Set(nest.entries.map((entry) => owningWorkspace(entry.source.file, workspaces)));
      const expressEntries = nest.found
        ? express.entries.filter((entry) => !nestWorkspaces.has(owningWorkspace(entry.source.file, workspaces)))
        : express.entries;
      const expressGaps = nest.found
        ? express.gaps.filter((gap) => gap.source === undefined || !nestWorkspaces.has(owningWorkspace(gap.source.file, workspaces)))
        : express.gaps;
      if (expressEntries.length > 0 || expressGaps.length > 0) detected.push('express');
      entries.push(...expressEntries);
      gaps.push(...expressGaps);
    }

    const fastapi = await extractFastApiEndpoints({ root: context.root, exclude });
    if (fastapi.found) {
      detected.push('fastapi');
      entries.push(...withOwnership(fastapi.entries, 'fastapi', context));
      gaps.push(...fastapi.gaps);
    }

    const django = await extractDjangoEndpoints({ root: context.root, exclude });
    if (django.found) {
      detected.push('django');
      entries.push(...withOwnership(django.entries, 'django', context));
      gaps.push(...django.gaps);
    }

    if (detected.length === 0) {
      return inapplicable<EndpointEntry>(
        'endpoints',
        [
          skip(
            'endpoints',
            'no-endpoint-source-detected',
            'No Express router, NestJS controller, Next.js API handler, FastAPI route, or ' +
              'Django urlconf was found.',
          ),
        ],
        Date.now() - startedAt,
      );
    }

    const { deduped, duplicateGaps } = resolveDuplicates(entries);

    // Code first, spec second — the spec annotates, it never overrides.
    const crossCheck = await crossCheckAgainstSpec({
      root: context.root,
      exclude,
      entries: deduped,
      workspaces,
    });
    if (crossCheck.specFound) detected.push('openapi-spec');

    return {
      extractor: 'endpoints',
      applicable: true,
      detected: [...detected].sort(),
      entries: [...crossCheck.annotated].sort(
        (a, b) =>
          compareStrings(a.workspace ?? '', b.workspace ?? '') ||
          compareStrings(a.application ?? '', b.application ?? '') ||
          compareStrings(a.path, b.path) || compareStrings(a.method, b.method) ||
          compareStrings(a.id, b.id),
      ),
      gaps: [...gaps, ...duplicateGaps, ...crossCheck.gaps].sort(
        (a, b) =>compareStrings(a.kind, b.kind) ||compareStrings((a.source?.file ?? ''), b.source?.file ?? '') ||compareStrings(a.message, b.message),
      ),
      skips,
      durationMs: Date.now() - startedAt,
    };
  },
};

/**
 * Two handlers for the same method and final path inside one runtime can
 * compete. Registration order and middleware flow determine what executes.
 */
export function resolveDuplicates(entries: readonly EndpointEntry[]): {
  deduped: readonly EndpointEntry[];
  duplicateGaps: readonly Gap[];
} {
  const byConflict = new Map<string, EndpointEntry[]>();
  for (const entry of entries) {
    if (entry.finalPathResolved === false || entry.application === undefined) continue;
    const identity = `${entry.application}\u0000${entry.method}\u0000${entry.path}`;
    const bucket = byConflict.get(identity);
    if (bucket === undefined) byConflict.set(identity, [entry]);
    else bucket.push(entry);
  }
  const duplicateGaps: Gap[] = [];
  for (const bucket of byConflict.values()) {
    if (bucket.length < 2) continue;
    const first = bucket[0] as EndpointEntry;
    const sites = bucket
      .map((entry) => `${entry.source.file}:${entry.source.line ?? 1}`)
      .sort();
    duplicateGaps.push({
      extractor: 'endpoints',
      kind: 'duplicate-endpoint',
      message:
        `${first.method} ${first.path} is registered ${bucket.length} times in the same runtime application ` +
        `(${workspaceLabel(first.workspace ?? '')}): ${sites.join(', ')}. ` +
        'These handlers can compete at runtime; registration order determines which handles the request.',
      source: first.source,
    });
  }

  const byId = new Map<string, EndpointEntry[]>();
  for (const entry of entries) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
  const deduped: EndpointEntry[] = [];
  for (const bucket of byId.values()) {
    if (bucket.length === 1) {
      deduped.push(bucket[0] as EndpointEntry);
      continue;
    }
    const suffixCounts = new Map<string, number>();
    for (const entry of [...bucket].sort((a, b) =>
      compareStrings(a.application ?? '', b.application ?? '') ||
      compareStrings(a.source.file, b.source.file) ||
      (a.source.line ?? 0) - (b.source.line ?? 0) ||
      (a.source.column ?? 0) - (b.source.column ?? 0))) {
      const suffixBase = createHash('sha256')
        .update(`${entry.application ?? 'unmounted'}:${entry.source.file}:${entry.source.line ?? 0}:${entry.source.column ?? 0}`)
        .digest('hex')
        .slice(0, 8);
      const occurrence = (suffixCounts.get(suffixBase) ?? 0) + 1;
      suffixCounts.set(suffixBase, occurrence);
      const suffix = occurrence === 1 ? suffixBase : `${suffixBase}-${occurrence}`;
      deduped.push({ ...entry, id: `${entry.id}#${suffix}` });
    }
  }
  return { deduped, duplicateGaps };
}

function withOwnership(
  entries: readonly EndpointEntry[],
  kind: string,
  context: ExtractorContext,
): readonly EndpointEntry[] {
  return entries.map((entry) => {
    const workspaces = context.workspaces ?? [{ dir: '', manifests: [] }];
    const workspace = owningWorkspace(entry.source.file, workspaces);
    return {
      ...entry,
      ...(workspaces.length > 1 ? { workspace } : {}),
      application: applicationScope(workspace, kind, workspace || '.'),
      finalPathResolved: true,
    };
  });
}
