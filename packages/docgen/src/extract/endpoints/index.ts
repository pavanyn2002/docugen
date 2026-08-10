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

    const entries: EndpointEntry[] = [];
    const gaps: Gap[] = [];
    const skips: Skip[] = [];
    const detected: string[] = [];

    const nextApi = await extractNextApiEndpoints({ root: context.root, exclude });
    if (nextApi.found) {
      detected.push('next-api');
      entries.push(...nextApi.entries);
      gaps.push(...nextApi.gaps);
    }

    const nest = await extractNestEndpoints({ root: context.root, exclude });
    if (nest.found) {
      detected.push('nestjs');
      entries.push(...nest.entries);
      gaps.push(...nest.gaps);
    }

    // Nest is built on Express, and its bootstrap file registers middleware
    // that would otherwise be read as bare Express routes.
    if (!nest.found) {
      const express = await extractExpressEndpoints({ root: context.root, exclude });
      if (express.found) {
        detected.push('express');
        entries.push(...express.entries);
        gaps.push(...express.gaps);
      }
    }

    const fastapi = await extractFastApiEndpoints({ root: context.root, exclude });
    if (fastapi.found) {
      detected.push('fastapi');
      entries.push(...fastapi.entries);
      gaps.push(...fastapi.gaps);
    }

    const django = await extractDjangoEndpoints({ root: context.root, exclude });
    if (django.found) {
      detected.push('django');
      entries.push(...django.entries);
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
    });
    if (crossCheck.specFound) detected.push('openapi-spec');

    return {
      extractor: 'endpoints',
      applicable: true,
      detected: [...detected].sort(),
      entries: [...crossCheck.annotated].sort(
        (a, b) =>compareStrings(a.path, b.path) ||compareStrings(a.method, b.method),
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
 * Two handlers for the same method and path is a real conflict: only one can
 * win at runtime, and which one depends on registration order.
 */
function resolveDuplicates(entries: readonly EndpointEntry[]): {
  deduped: readonly EndpointEntry[];
  duplicateGaps: readonly Gap[];
} {
  const byId = new Map<string, EndpointEntry[]>();
  for (const entry of entries) {
    const bucket = byId.get(entry.id);
    if (bucket === undefined) byId.set(entry.id, [entry]);
    else bucket.push(entry);
  }

  const deduped: EndpointEntry[] = [];
  const duplicateGaps: Gap[] = [];

  for (const [, bucket] of byId) {
    if (bucket.length === 1) {
      deduped.push(bucket[0] as EndpointEntry);
      continue;
    }

    const first = bucket[0] as EndpointEntry;
    const files = [...new Set(bucket.map((entry) => entry.source.file))].sort();

    // The same file registering a path twice is usually one handler read via
    // two mount points, which is not a conflict worth reporting.
    if (files.length > 1) {
      duplicateGaps.push({
        extractor: 'endpoints',
        kind: 'duplicate-endpoint',
        message:
          `${first.method} ${first.path} is registered in ${files.length} places: ${files.join(', ')}. ` +
          'Only the first registered handler runs.',
        source: { file: files[0] as string },
      });
    }

    for (const entry of bucket) {
      const suffix = createHash('sha256')
        .update(`${entry.source.file}:${entry.source.line ?? 0}`)
        .digest('hex')
        .slice(0, 8);
      deduped.push({ ...entry, id: `${entry.id}#${suffix}` });
    }
  }

  return { deduped, duplicateGaps };
}
