import { describe, expect, it } from 'vitest';
import { chunkSurfaces } from '../src/surface/chunk.js';
import { endpointGroupKey, isDynamicSegment, normalisePath } from '../src/surface/group.js';
import { assignSlugs, sanitiseSlug } from '../src/surface/slug.js';
import { DocgenError } from '../src/util/errors.js';
import { endpoint, job, route } from './helpers/entries.js';

const empty = { routes: [], endpoints: [], jobs: [] };

describe('path normalisation', () => {
  it.each([
    ['orders', '/orders'],
    ['/orders/', '/orders'],
    ['//api//orders//', '/api/orders'],
    ['/', '/'],
    ['', '/'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalisePath(input)).toBe(expected);
  });
});

describe('dynamic segment detection', () => {
  it.each([':id', '[id]', '{id}', '*', '...rest', '[...slug]'])('treats %s as dynamic', (segment) => {
    expect(isDynamicSegment(segment)).toBe(true);
  });

  it.each(['orders', 'v1x', 'api-keys'])('treats %s as static', (segment) => {
    expect(isDynamicSegment(segment)).toBe(false);
  });
});

describe('endpoint grouping', () => {
  it.each([
    ['/orders', 'orders'],
    ['/api/orders', 'orders'],
    ['/api/v1/orders', 'orders'],
    ['/v2/orders/:id', 'orders'],
    ['/api/v1/orders/:id/items', 'orders'],
  ])('groups %s under %s', (path, expected) => {
    expect(endpointGroupKey(path)).toBe(expected);
  });

  // Sub-resources join their parent rather than forming one-endpoint surfaces.
  it('puts a nested sub-resource in its parent group', () => {
    expect(endpointGroupKey('/api/projects/:id/milestones')).toBe('projects');
  });

  it('falls back to (root) when there is no resource segment', () => {
    expect(endpointGroupKey('/api/v1')).toBe('(root)');
    expect(endpointGroupKey('/:id')).toBe('(root)');
    expect(endpointGroupKey('/')).toBe('(root)');
  });

  // Without this, a repo mounting everything under one prefix collapses into
  // a single surface named after the mount point.
  it('strips a configured base path', () => {
    expect(endpointGroupKey('/service/internal/orders', ['/service/internal'])).toBe('orders');
  });

  it('prefers the longest matching base path', () => {
    expect(endpointGroupKey('/api/internal/orders', ['/api', '/api/internal'])).toBe('orders');
  });

  it('ignores a base path that does not prefix the route', () => {
    expect(endpointGroupKey('/orders', ['/service'])).toBe('orders');
  });

  it('does not treat a partial segment match as a prefix', () => {
    expect(endpointGroupKey('/apifoo/orders')).toBe('apifoo');
  });
});

describe('slugs', () => {
  it.each([
    ['screen:/orders/[id]', 'screen-orders-id'],
    ['api:orders', 'api-orders'],
    ['job:re-index', 'job-re-index'],
  ])('sanitises %s', (input, expected) => {
    expect(sanitiseSlug(input)).toBe(expected);
  });

  it('never produces an empty slug', () => {
    expect(sanitiseSlug('///')).toBe('index');
  });

  it('leaves non-colliding slugs clean', () => {
    const slugs = assignSlugs(['screen:/orders', 'screen:/users']);
    expect(slugs.get('screen:/orders')).toBe('screen-orders');
  });

  // Phase 1 files developer answers under the slug, so a silent collision
  // would merge two features' ground truth.
  it('disambiguates colliding slugs on both sides', () => {
    const slugs = assignSlugs(['screen:/orders/[id]', 'screen:/orders/id']);
    const a = slugs.get('screen:/orders/[id]') as string;
    const b = slugs.get('screen:/orders/id') as string;

    expect(a).not.toBe(b);
    expect(a).toMatch(/^screen-orders-id-[0-9a-f]{8}$/);
    expect(b).toMatch(/^screen-orders-id-[0-9a-f]{8}$/);
  });

  it('is order-independent', () => {
    const forward = assignSlugs(['screen:/a/[b]', 'screen:/a/b']);
    const reverse = assignSlugs(['screen:/a/b', 'screen:/a/[b]']);
    expect(forward.get('screen:/a/[b]')).toBe(reverse.get('screen:/a/[b]'));
  });
});

describe('screen surfaces', () => {
  it('makes one surface per page route', () => {
    const result = chunkSurfaces({
      ...empty,
      routes: [route('/'), route('/orders'), route('/orders/[id]')],
    });

    expect(result.surfaces.map((s) => s.id)).toEqual([
      'screen:/',
      'screen:/orders',
      'screen:/orders/[id]',
    ]);
    expect(result.surfaces.every((s) => s.kind === 'screen')).toBe(true);
  });

  // Naming '/orders/[id]' "Order detail" would be a behavioural claim, and
  // behavioural claims are Phase 1's job, badged.
  it('titles a screen with its path verbatim, inventing nothing', () => {
    const result = chunkSurfaces({ ...empty, routes: [route('/orders/[id]')] });
    expect(result.surfaces[0]?.title).toBe('/orders/[id]');
  });

  it('treats a redirect as a user-facing screen', () => {
    const result = chunkSurfaces({ ...empty, routes: [route('/old', { kind: 'redirect' })] });
    expect(result.surfaces).toHaveLength(1);
    expect(result.surfaces[0]?.id).toBe('screen:/old');
  });

  it('collects component, layout, and guard files as sources', () => {
    const result = chunkSurfaces({
      ...empty,
      routes: [
        route('/orders', {
          file: 'app/orders/page.tsx',
          component: 'app/orders/OrdersView.tsx',
          layoutChain: ['app/layout.tsx'],
          guards: [{ name: 'middleware', file: 'middleware.ts' }],
        }),
      ],
    });

    expect(result.surfaces[0]?.sourceFiles).toEqual([
      'app/layout.tsx',
      'app/orders/OrdersView.tsx',
      'app/orders/page.tsx',
      'middleware.ts',
    ]);
  });
});

describe('supporting routes', () => {
  it('attaches a segment layout to every screen beneath it', () => {
    const result = chunkSurfaces({
      ...empty,
      routes: [
        route('/orders', { kind: 'layout', file: 'app/orders/layout.tsx' }),
        route('/orders'),
        route('/orders/[id]'),
        route('/users'),
      ],
    });

    const orders = result.surfaces.find((s) => s.id === 'screen:/orders');
    const detail = result.surfaces.find((s) => s.id === 'screen:/orders/[id]');
    const users = result.surfaces.find((s) => s.id === 'screen:/users');

    expect(orders?.supportingRoutes).toContain('route:layout:/orders');
    expect(detail?.supportingRoutes).toContain('route:layout:/orders');
    expect(users?.supportingRoutes).toEqual([]);
  });

  it('attaches a root layout to every screen', () => {
    const result = chunkSurfaces({
      ...empty,
      routes: [route('/', { kind: 'layout', file: 'app/layout.tsx' }), route('/'), route('/orders')],
    });

    expect(result.surfaces.every((s) => s.supportingRoutes.includes('route:layout:/'))).toBe(true);
  });

  it('attaches via the framework layout chain even without path containment', () => {
    const result = chunkSurfaces({
      ...empty,
      routes: [
        route('/(marketing)', { kind: 'layout', file: 'app/(marketing)/layout.tsx' }),
        route('/pricing', { layoutChain: ['app/(marketing)/layout.tsx'] }),
      ],
    });

    expect(result.surfaces.find((s) => s.id === 'screen:/pricing')?.supportingRoutes).toEqual([
      'route:layout:/(marketing)',
    ]);
  });

  it('does not create a surface for a layout', () => {
    const result = chunkSurfaces({
      ...empty,
      routes: [route('/orders', { kind: 'layout' }), route('/orders')],
    });

    expect(result.surfaces).toHaveLength(1);
  });

  // A layout wrapping nothing is dead code, or a parser failure. Either is
  // worth surfacing in `docgen report`.
  it('reports an orphaned layout instead of dropping it', () => {
    const result = chunkSurfaces({
      ...empty,
      routes: [route('/admin', { kind: 'layout', file: 'app/admin/layout.tsx' }), route('/orders')],
    });

    expect(result.unassigned).toHaveLength(1);
    expect(result.unassigned[0]).toMatchObject({
      entryId: 'route:layout:/admin',
      reason: 'supporting-route-unattached',
    });
  });
});

describe('endpoint-group surfaces', () => {
  it('groups a REST resource into one surface', () => {
    const result = chunkSurfaces({
      ...empty,
      endpoints: [
        endpoint('GET', '/api/orders'),
        endpoint('POST', '/api/orders'),
        endpoint('GET', '/api/orders/:id'),
        endpoint('DELETE', '/api/orders/:id'),
      ],
    });

    expect(result.surfaces).toHaveLength(1);
    expect(result.surfaces[0]).toMatchObject({ id: 'api:orders', kind: 'endpoint-group', title: 'orders' });
    expect(result.surfaces[0]?.endpoints).toHaveLength(4);
  });

  it('keeps distinct resources in distinct surfaces', () => {
    const result = chunkSurfaces({
      ...empty,
      endpoints: [endpoint('GET', '/api/orders'), endpoint('GET', '/api/users')],
    });

    expect(result.surfaces.map((s) => s.id)).toEqual(['api:orders', 'api:users']);
  });
});

describe('job surfaces', () => {
  it('makes one surface per job', () => {
    const result = chunkSurfaces({
      ...empty,
      jobs: [job('reindex'), job('send-digest', { kind: 'queue-consumer' })],
    });

    expect(result.surfaces.map((s) => s.id)).toEqual(['job:reindex', 'job:send-digest']);
    expect(result.surfaces.every((s) => s.kind === 'job')).toBe(true);
  });
});

describe('ordering and determinism', () => {
  it('orders screens, then endpoint groups, then jobs', () => {
    const result = chunkSurfaces({
      routes: [route('/orders')],
      endpoints: [endpoint('GET', '/api/users')],
      jobs: [job('reindex')],
    });

    expect(result.surfaces.map((s) => s.kind)).toEqual(['screen', 'endpoint-group', 'job']);
  });

  // Byte-identical output is a hard requirement (SPEC 6.2); it starts here.
  it('produces identical output regardless of input order', () => {
    const routes = [route('/orders'), route('/'), route('/orders/[id]')];
    const endpoints = [endpoint('POST', '/api/users'), endpoint('GET', '/api/orders')];
    const jobs = [job('zeta'), job('alpha')];

    const forward = chunkSurfaces({ routes, endpoints, jobs });
    const reverse = chunkSurfaces({
      routes: [...routes].reverse(),
      endpoints: [...endpoints].reverse(),
      jobs: [...jobs].reverse(),
    });

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
  });

  it('is stable across repeated runs on the same input', () => {
    const input = { routes: [route('/a'), route('/b')], endpoints: [endpoint('GET', '/api/c')], jobs: [] };
    expect(JSON.stringify(chunkSurfaces(input))).toBe(JSON.stringify(chunkSurfaces(input)));
  });

  it('sorts member ids and source files within a surface', () => {
    const result = chunkSurfaces({
      ...empty,
      endpoints: [
        endpoint('PUT', '/api/orders', { file: 'src/z.ts' }),
        endpoint('GET', '/api/orders', { file: 'src/a.ts' }),
      ],
    });

    const surface = result.surfaces[0];
    expect(surface?.endpoints).toEqual([...(surface?.endpoints ?? [])].sort());
    expect(surface?.sourceFiles).toEqual(['src/a.ts', 'src/z.ts']);
  });
});

describe('surface overrides', () => {
  it('pulls matching entries into the named surface', () => {
    const result = chunkSurfaces({
      routes: [route('/checkout', { file: 'app/checkout/page.tsx' })],
      endpoints: [endpoint('POST', '/api/payments', { file: 'src/checkout/pay.ts' })],
      jobs: [],
      overrides: [
        { id: 'checkout-flow', kind: 'screen', title: 'Checkout', include: ['app/checkout/**', 'src/checkout/**'] },
      ],
    });

    expect(result.surfaces).toHaveLength(1);
    expect(result.surfaces[0]).toMatchObject({
      id: 'checkout-flow',
      title: 'Checkout',
      origin: 'override',
    });
    expect(result.surfaces[0]?.routes).toEqual(['route:page:/checkout']);
    expect(result.surfaces[0]?.endpoints).toEqual(['endpoint:POST:/api/payments']);
  });

  it('falls back to the id when no title is given', () => {
    const result = chunkSurfaces({
      ...empty,
      routes: [route('/x', { file: 'app/x/page.tsx' })],
      overrides: [{ id: 'custom', kind: 'screen', include: ['app/x/**'] }],
    });

    expect(result.surfaces[0]?.title).toBe('custom');
  });

  it('leaves unmatched entries on the default heuristics', () => {
    const result = chunkSurfaces({
      ...empty,
      routes: [route('/checkout', { file: 'app/checkout/page.tsx' }), route('/about', { file: 'app/about/page.tsx' })],
      overrides: [{ id: 'checkout-flow', kind: 'screen', include: ['app/checkout/**'] }],
    });

    expect(result.surfaces.map((s) => s.id).sort()).toEqual(['checkout-flow', 'screen:/about']);
  });

  // Ambiguous config produces ambiguous docs, and only the user can resolve it.
  it('errors when one file matches two overrides', () => {
    expect(() =>
      chunkSurfaces({
        ...empty,
        routes: [route('/x', { file: 'app/x/page.tsx' })],
        overrides: [
          { id: 'a', kind: 'screen', include: ['app/**'] },
          { id: 'b', kind: 'screen', include: ['app/x/**'] },
        ],
      }),
    ).toThrow(DocgenError);
  });

  // A silently inert override means the user believes a surface exists that does not.
  it('reports an override that matched nothing', () => {
    const result = chunkSurfaces({
      ...empty,
      routes: [route('/a', { file: 'app/a/page.tsx' })],
      overrides: [{ id: 'stale', kind: 'screen', include: ['app/deleted/**'] }],
    });

    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ extractor: 'surface', kind: 'override-matched-nothing' });
  });
});

describe('nothing is silently dropped', () => {
  it('places every entry in a surface or in unassigned', () => {
    const routes = [
      route('/'),
      route('/orders'),
      route('/', { kind: 'layout', file: 'app/layout.tsx' }),
      route('/ghost', { kind: 'layout', file: 'app/ghost/layout.tsx' }),
    ];
    const endpoints = [endpoint('GET', '/api/orders')];
    const jobs = [job('reindex')];

    const result = chunkSurfaces({ routes, endpoints, jobs });

    const placed = new Set(
      result.surfaces.flatMap((s) => [...s.routes, ...s.supportingRoutes, ...s.endpoints, ...s.jobs]),
    );
    for (const entry of result.unassigned) placed.add(entry.entryId);

    for (const entry of [...routes, ...endpoints, ...jobs]) {
      expect(placed.has(entry.id)).toBe(true);
    }
  });

  it('returns an empty set for an empty repo without throwing', () => {
    const result = chunkSurfaces(empty);
    expect(result).toEqual({ surfaces: [], unassigned: [], gaps: [], notes: [] });
  });
});
