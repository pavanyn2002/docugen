import { describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder, validateEvidenceGraph } from '../src/graph/builder.js';
import { buildEvidenceGraph } from '../src/graph/from-extraction.js';
import { serialiseEvidenceGraph } from '../src/graph/serialize.js';
import { EVIDENCE_GRAPH_SCHEMA_VERSION } from '../src/graph/types.js';
import type { EvidenceGraph } from '../src/graph/types.js';
import type { EntryBase, ExtractResult, ExtractorId } from '../src/types/core.js';
import type {
  ConfigEntry,
  DepsResult,
  ModuleEntry,
  SchemaEntry,
} from '../src/types/entries.js';
import { endpoint, job, route } from './helpers/entries.js';

function result<T extends EntryBase>(extractor: ExtractorId, entries: readonly T[]): ExtractResult<T> {
  return {
    extractor,
    applicable: true,
    detected: ['fixture'],
    entries,
    gaps: [],
    skips: [],
    durationMs: 1,
  };
}

const orderSchema: SchemaEntry = {
  id: 'schema:table:orders',
  source: { file: 'prisma/schema.prisma', line: 10 },
  extractionMethod: 'schema',
  certainty: 'high',
  name: 'orders',
  modelName: 'Order',
  kind: 'table',
  fields: [
    { name: 'id', type: 'String', isPrimaryKey: true },
    { name: 'userId', type: 'String' },
  ],
  indexes: [],
  relations: [{ field: 'userId', targetModel: 'User', cardinality: 'many-to-one' }],
};

const userSchema: SchemaEntry = {
  id: 'schema:table:users',
  source: { file: 'prisma/schema.prisma', line: 1 },
  extractionMethod: 'schema',
  certainty: 'high',
  name: 'users',
  modelName: 'User',
  kind: 'table',
  fields: [{ name: 'id', type: 'String', isPrimaryKey: true }],
  indexes: [],
  relations: [],
};

const modules: readonly ModuleEntry[] = [
  {
    id: 'module:src/a.ts',
    source: { file: 'src/a.ts', line: 1 },
    extractionMethod: 'ast',
    certainty: 'high',
    module: 'src/a.ts',
    imports: ['src/b.ts'],
    externals: ['zod'],
  },
  {
    id: 'module:src/b.ts',
    source: { file: 'src/b.ts', line: 1 },
    extractionMethod: 'ast',
    certainty: 'high',
    module: 'src/b.ts',
    imports: [],
    externals: ['zod'],
  },
];

const secretConfig: ConfigEntry = {
  id: 'config:env:API_SECRET',
  source: { file: 'src/config.ts', line: 2 },
  extractionMethod: 'ast',
  certainty: 'high',
  name: 'API_SECRET',
  kind: 'env',
  reads: [{ file: 'src/config.ts', line: 2 }],
  declarations: [{ file: '.env.example', line: 1 }],
  defaultValue: 'must-not-enter-the-graph',
  isSecretLike: true,
};

function fixtureResults(reverse = false): ReadonlyMap<ExtractorId, ExtractResult> {
  const routeResult = result('routes', [
    route('/orders', {
      file: 'app/orders/page.tsx',
      component: 'app/orders/page.tsx',
      guards: [{ name: 'auth', file: 'src/middleware.ts' }],
    }),
  ]);
  const endpointResult = result('endpoints', [
    {
      ...endpoint('POST', '/orders', { file: 'src/routes/orders.ts', handler: 'src/orders/create.ts' }),
      requestShape: { name: 'CreateOrder', kind: 'typescript', source: { file: 'src/orders/dto.ts', line: 4 } },
    },
  ]);
  const depsResult: DepsResult = {
    ...result('deps', modules),
    extractor: 'deps',
    cycles: [],
  };
  const pairs: [ExtractorId, ExtractResult][] = [
    ['routes', routeResult],
    ['endpoints', endpointResult],
    ['schema', result('schema', [orderSchema, userSchema])],
    ['deps', depsResult],
    ['jobs', result('jobs', [job('order-cleanup', { file: 'src/jobs/cleanup.ts' })])],
    ['config', result('config', [secretConfig])],
  ];
  return new Map(reverse ? pairs.reverse() : pairs);
}

describe('evidence graph', () => {
  it('projects every current extractor into evidence-linked nodes and edges', () => {
    const graph = buildEvidenceGraph(fixtureResults());

    expect(graph.schemaVersion).toBe(1);
    expect(graph.nodes.some((node) => node.kind === 'route' && node.label === '/orders')).toBe(true);
    expect(graph.nodes.some((node) => node.kind === 'endpoint' && node.label === 'POST /orders')).toBe(true);
    expect(graph.nodes.some((node) => node.kind === 'job' && node.label === 'order-cleanup')).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === 'handled-by')).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === 'has-field')).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === 'references')).toBe(true);
    expect(graph.edges.some((edge) => edge.kind === 'imports')).toBe(true);
    expect(validateEvidenceGraph(graph)).toEqual([]);
  });

  it('serialises identically regardless of extractor insertion order', () => {
    expect(serialiseEvidenceGraph(buildEvidenceGraph(fixtureResults()))).toBe(
      serialiseEvidenceGraph(buildEvidenceGraph(fixtureResults(true))),
    );
  });

  it('merges evidence for shared nodes and excludes secret-like defaults', () => {
    const graph = buildEvidenceGraph(fixtureResults());
    const zod = graph.nodes.find((node) => node.id === 'package:zod');
    const secret = graph.nodes.find((node) => node.kind === 'config' && node.label === 'API_SECRET');

    expect(zod?.provenance.evidence.map((ref) => ref.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(secret?.properties).not.toHaveProperty('defaultValue');
    expect(serialiseEvidenceGraph(graph)).not.toContain('must-not-enter-the-graph');
  });

  it('rejects dangling relationships', () => {
    const graph: EvidenceGraph = {
      schemaVersion: EVIDENCE_GRAPH_SCHEMA_VERSION,
      nodes: [
        {
          id: 'file:src/a.ts',
          kind: 'file',
          label: 'src/a.ts',
          provenance: { origin: 'extracted', evidence: [{ file: 'src/a.ts' }] },
        },
      ],
      edges: [
        {
          id: 'edge:imports:file:src/a.ts->file:src/missing.ts',
          kind: 'imports',
          from: 'file:src/a.ts',
          to: 'file:src/missing.ts',
          provenance: { origin: 'extracted', evidence: [{ file: 'src/a.ts' }] },
        },
      ],
      gaps: [],
    };

    expect(validateEvidenceGraph(graph)).toEqual([
      expect.objectContaining({ code: 'dangling-edge' }),
    ]);

    const builder = new EvidenceGraphBuilder();
    builder.addNode(graph.nodes[0] as NonNullable<(typeof graph.nodes)[number]>);
    builder.addEdge(graph.edges[0] as NonNullable<(typeof graph.edges)[number]>);
    expect(() => builder.build()).toThrow(/invalid/i);
  });
});
