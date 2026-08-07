import { describe, expect, it } from 'vitest';
import { chunkSurfaces } from '../src/surface/chunk.js';
import { detectServicePrefix, endpointGroupKey } from '../src/surface/group.js';
import { endpoint, route } from './helpers/entries.js';

/**
 * Chunker behaviour on the shapes real repos actually have.
 *
 * The endpoint table below is transcribed from a production Express service:
 * a single router declared in `src/routes/projectRoutes.ts` and mounted with
 * `app.use('/projects', projectRoutes)`. That mount pattern is the norm across
 * a microservice fleet, and it is what motivated automatic prefix detection —
 * without it every service collapses into one surface named after itself.
 */
const EXPRESS_SERVICE = [
  endpoint('POST', '/projects/enquiry/initiate'),
  endpoint('POST', '/projects/enquiry/:id/nextQuestion'),
  endpoint('POST', '/projects/enquiry/:id/store'),
  endpoint('GET', '/projects/enquiry/:id/summary'),
  endpoint('POST', '/projects/enquiry'),
  endpoint('GET', '/projects/enquiry'),
  endpoint('DELETE', '/projects/enquiry/:id'),
  endpoint('GET', '/projects/serviceTypes'),
  endpoint('GET', '/projects/serviceTypes/:pincode'),
  endpoint('POST', '/projects/serviceTypes/assignServiceType'),
  endpoint('GET', '/projects/pincodes'),
  endpoint('GET', '/projects/pincodes/search'),
];

describe('Express microservice mounted under its own name', () => {
  it('detects the shared mount prefix', () => {
    expect(detectServicePrefix(EXPRESS_SERVICE.map((e) => e.path))).toBe('projects');
  });

  it('produces one surface per resource rather than one for the whole service', () => {
    const result = chunkSurfaces({ routes: [], endpoints: EXPRESS_SERVICE, jobs: [] });

    expect(result.surfaces.map((s) => s.id)).toEqual(['api:enquiry', 'api:pincodes', 'api:serviceTypes']);
  });

  it('assigns every endpoint to the right resource', () => {
    const result = chunkSurfaces({ routes: [], endpoints: EXPRESS_SERVICE, jobs: [] });
    const counts = Object.fromEntries(result.surfaces.map((s) => [s.id, s.endpoints.length]));

    expect(counts).toEqual({ 'api:enquiry': 7, 'api:pincodes': 2, 'api:serviceTypes': 3 });
  });

  it('keeps an action sub-path with its resource', () => {
    const result = chunkSurfaces({ routes: [], endpoints: EXPRESS_SERVICE, jobs: [] });
    const serviceTypes = result.surfaces.find((s) => s.id === 'api:serviceTypes');

    expect(serviceTypes?.endpoints).toContain('endpoint:POST:/projects/serviceTypes/assignServiceType');
  });

  // Stripping changes every endpoint surface id, so it must never be invisible.
  it('records the stripped prefix as a note', () => {
    const result = chunkSurfaces({ routes: [], endpoints: EXPRESS_SERVICE, jobs: [] });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("'/projects'");
  });
});

describe('prefix stripping only when it helps', () => {
  // Stripping here would yield a single anonymous '(root)' group — worse than
  // the resource name it replaced.
  it('keeps the name for a service built around one resource', () => {
    const single = [endpoint('GET', '/orders'), endpoint('GET', '/orders/:id'), endpoint('POST', '/orders')];

    expect(detectServicePrefix(single.map((e) => e.path))).toBeUndefined();

    const result = chunkSurfaces({ routes: [], endpoints: single, jobs: [] });
    expect(result.surfaces.map((s) => s.id)).toEqual(['api:orders']);
    expect(result.notes).toEqual([]);
  });

  it('leaves a monolith with several top-level resources alone', () => {
    const monolith = [
      endpoint('GET', '/api/orders'),
      endpoint('GET', '/api/users'),
      endpoint('GET', '/api/invoices'),
    ];

    expect(detectServicePrefix(monolith.map((e) => e.path))).toBeUndefined();

    const result = chunkSurfaces({ routes: [], endpoints: monolith, jobs: [] });
    expect(result.surfaces.map((s) => s.id)).toEqual(['api:invoices', 'api:orders', 'api:users']);
  });

  it('does not strip when the shared segment is dynamic', () => {
    expect(detectServicePrefix(['/:tenant/orders', '/:tenant/users'])).toBeUndefined();
  });

  it('does not strip from a single endpoint', () => {
    expect(detectServicePrefix(['/projects/enquiry'])).toBeUndefined();
  });

  it('composes with api and version stripping', () => {
    const versioned = ['/api/v1/projects/enquiry', '/api/v1/projects/pincodes'];
    expect(detectServicePrefix(versioned)).toBe('projects');
    expect(endpointGroupKey('/api/v1/projects/enquiry', [], 'projects')).toBe('enquiry');
  });
});

/**
 * Next.js 15 App Router tree, modelled on a production marketing-plus-app site:
 * a root layout, a route group for marketing pages, nested dynamic segments,
 * and middleware-based auth.
 */
describe('Next.js App Router site', () => {
  const NEXT_ROUTES = [
    route('/', { kind: 'layout', file: 'src/app/layout.tsx' }),
    route('/', { file: 'src/app/page.tsx', layoutChain: ['src/app/layout.tsx'] }),
    route('/pricing', { file: 'src/app/(marketing)/pricing/page.tsx', layoutChain: ['src/app/layout.tsx'] }),
    route('/dashboard', {
      kind: 'layout',
      file: 'src/app/dashboard/layout.tsx',
    }),
    route('/dashboard', {
      file: 'src/app/dashboard/page.tsx',
      layoutChain: ['src/app/layout.tsx', 'src/app/dashboard/layout.tsx'],
      guards: [{ name: 'middleware', file: 'src/middleware.ts' }],
    }),
    route('/dashboard/projects/[id]', {
      file: 'src/app/dashboard/projects/[id]/page.tsx',
      params: ['id'],
      layoutChain: ['src/app/layout.tsx', 'src/app/dashboard/layout.tsx'],
      guards: [{ name: 'middleware', file: 'src/middleware.ts' }],
    }),
  ];

  it('lists exactly the user-facing screens, and no layouts', () => {
    const result = chunkSurfaces({ routes: NEXT_ROUTES, endpoints: [], jobs: [] });

    expect(result.surfaces.map((s) => s.title)).toEqual([
      '/',
      '/dashboard',
      '/dashboard/projects/[id]',
      '/pricing',
    ]);
  });

  it('attaches the dashboard layout to dashboard screens only', () => {
    const result = chunkSurfaces({ routes: NEXT_ROUTES, endpoints: [], jobs: [] });
    const withDashboardLayout = result.surfaces
      .filter((s) => s.supportingRoutes.includes('route:layout:/dashboard'))
      .map((s) => s.title);

    expect(withDashboardLayout).toEqual(['/dashboard', '/dashboard/projects/[id]']);
  });

  it('carries the middleware guard file onto guarded screens', () => {
    const result = chunkSurfaces({ routes: NEXT_ROUTES, endpoints: [], jobs: [] });
    const dashboard = result.surfaces.find((s) => s.title === '/dashboard');

    expect(dashboard?.sourceFiles).toContain('src/middleware.ts');
    expect(result.surfaces.find((s) => s.title === '/pricing')?.sourceFiles).not.toContain('src/middleware.ts');
  });

  it('places a route-group page at its public path, not its file path', () => {
    const result = chunkSurfaces({ routes: NEXT_ROUTES, endpoints: [], jobs: [] });
    const pricing = result.surfaces.find((s) => s.id === 'screen:/pricing');

    expect(pricing?.sourceFiles).toContain('src/app/(marketing)/pricing/page.tsx');
  });
});
