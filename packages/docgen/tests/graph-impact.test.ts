import { describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { analyzeChangeImpact } from '../src/graph/impact.js';

const serviceEvidence = { origin: 'extracted' as const, evidence: [{ file: 'src/service.ts', line: 1 }] };
const checkoutEvidence = { origin: 'extracted' as const, evidence: [{ file: 'src/checkout.ts', line: 1 }] };
const routeEvidence = { origin: 'extracted' as const, evidence: [{ file: 'src/routes.ts', line: 1 }] };
const featureEvidence = {
  origin: 'human' as const,
  evidence: [{ file: 'docs/.features/checkout.json' }],
  actor: 'dev@example.com',
  recordedAt: '2026-08-01T00:00:00.000Z',
};

function dependencyGraph() {
  const builder = new EvidenceGraphBuilder();
  builder.addNode({ id: 'file:service', kind: 'file', label: 'src/service.ts', provenance: serviceEvidence });
  builder.addNode({ id: 'symbol:charge', kind: 'symbol', label: 'charge', provenance: serviceEvidence });
  builder.addNode({ id: 'symbol:checkout', kind: 'symbol', label: 'checkout', provenance: checkoutEvidence });
  builder.addNode({ id: 'endpoint:checkout', kind: 'endpoint', label: 'POST /checkout', provenance: routeEvidence });
  builder.addNode({ id: 'route:checkout', kind: 'route', label: '/checkout', provenance: routeEvidence });
  builder.addNode({ id: 'feature:checkout', kind: 'feature', label: 'Checkout', provenance: featureEvidence });
  builder.addNode({ id: 'surface:api:checkout', kind: 'surface', label: 'checkout', provenance: routeEvidence, properties: { surfaceId: 'api:checkout', slug: 'api-checkout', surfaceKind: 'endpoint-group' } });
  builder.addNode({ id: 'requirement:REQ-api-checkout-01', kind: 'requirement', label: 'Retry safely', provenance: featureEvidence, properties: { requirementId: 'REQ-api-checkout-01', surfaceId: 'api:checkout' } });
  builder.addNode({ id: 'test:tests/checkout.test.ts', kind: 'test', label: 'tests/checkout.test.ts', provenance: { origin: 'extracted', evidence: [{ file: 'tests/checkout.test.ts', line: 1 }] } });
  builder.addEdge({ id: 'defined', kind: 'defined-in', from: 'symbol:charge', to: 'file:service', provenance: serviceEvidence });
  builder.addEdge({ id: 'call', kind: 'calls', from: 'symbol:checkout', to: 'symbol:charge', provenance: checkoutEvidence });
  builder.addEdge({ id: 'handler', kind: 'handled-by', from: 'endpoint:checkout', to: 'symbol:checkout', provenance: routeEvidence });
  builder.addEdge({ id: 'route-endpoint', kind: 'implemented-by', from: 'route:checkout', to: 'endpoint:checkout', provenance: routeEvidence });
  builder.addEdge({ id: 'feature-member', kind: 'belongs-to-feature', from: 'symbol:charge', to: 'feature:checkout', provenance: featureEvidence });
  builder.addEdge({ id: 'surface-member', kind: 'contains', from: 'surface:api:checkout', to: 'endpoint:checkout', provenance: routeEvidence });
  builder.addEdge({ id: 'requirement-surface', kind: 'belongs-to-surface', from: 'requirement:REQ-api-checkout-01', to: 'surface:api:checkout', provenance: featureEvidence });
  builder.addEdge({ id: 'requirement-test', kind: 'tested-by', from: 'requirement:REQ-api-checkout-01', to: 'test:tests/checkout.test.ts', provenance: { origin: 'extracted', evidence: [{ file: 'tests/checkout.test.ts', line: 1 }] } });
  return builder.build();
}

describe('change impact', () => {
  it('walks from changed evidence toward downstream callers and surfaces', () => {
    const report = analyzeChangeImpact({
      current: dependencyGraph(),
      changes: { base: 'HEAD', changes: [{ status: 'modified', file: 'src/service.ts' }] },
      maxDepth: 5,
    });

    expect(report.files[0]?.impacted.map((item) => [item.node.id, item.distance])).toEqual([
      ['file:service', 0],
      ['symbol:charge', 0],
      ['feature:checkout', 1],
      ['symbol:checkout', 1],
      ['endpoint:checkout', 2],
      ['route:checkout', 3],
      ['surface:api:checkout', 3],
      ['requirement:REQ-api-checkout-01', 4],
      ['test:tests/checkout.test.ts', 5],
    ]);
  });

  it('uses the previous graph for deleted code and validates depth', () => {
    const empty = new EvidenceGraphBuilder().build();
    const report = analyzeChangeImpact({
      current: empty,
      baseline: dependencyGraph(),
      changes: { base: 'main', changes: [{ status: 'deleted', file: 'src/service.ts' }] },
      maxDepth: 1,
    });

    expect(report.files[0]?.impacted.map((item) => [item.node.id, item.basis])).toEqual([
      ['file:service', ['baseline']],
      ['symbol:charge', ['baseline']],
      ['feature:checkout', ['baseline']],
      ['symbol:checkout', ['baseline']],
    ]);
    expect(() =>
      analyzeChangeImpact({ current: empty, changes: { base: 'HEAD', changes: [] }, maxDepth: -1 }),
    ).toThrow(/non-negative integer/);
  });

  it('traces a changed test citation back to its requirement and QA surface', () => {
    const report = analyzeChangeImpact({
      current: dependencyGraph(),
      changes: {
        base: 'HEAD',
        changes: [{ status: 'modified', file: 'tests/checkout.test.ts' }],
      },
      maxDepth: 2,
    });

    expect(report.files[0]?.impacted.map((item) => item.node.id)).toEqual([
      'requirement:REQ-api-checkout-01',
      'test:tests/checkout.test.ts',
      'surface:api:checkout',
    ]);
  });
});
