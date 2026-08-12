import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { EndpointEntry, HttpMethod, ShapeRef } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { readModuleBindings, resolveSymbolToFile } from '../../util/modules.js';
import { loadPathAliases } from '../../util/tsconfig.js';
import type { ModuleBindings } from '../../util/modules.js';
import { literalString, parseSourceFile, positionOf, ts, walk } from '../../util/ts-ast.js';
import { joinPath, paramsOf } from './paths.js';
import type { Workspace } from '../../detect/workspaces.js';
import { applicationScope, owningWorkspace } from '../../detect/ownership.js';

/**
 * Express routes.
 *
 * The hard part is not finding `router.get(...)` — it is knowing what URL it
 * ends up at. A microservice typically declares its routes in one file and
 * mounts the whole router elsewhere with `app.use('/projects', projectRoutes)`,
 * often through a barrel re-export. Ignoring the mount documents every endpoint
 * at the wrong path, so mounts are resolved across files and a route whose
 * mount cannot be resolved is reported rather than published at a guessed URL.
 */

const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'all',
]);

/** Calls that produce a mountable Router. */
const ROUTER_FACTORIES = new Set(['Router']);

/** Calls that produce the application itself, which is never mounted. */
const APP_FACTORIES = new Set(['express']);

/**
 * Type names that prove a value is an Express app or router.
 *
 * The app frequently arrives as a function parameter rather than a local
 * assignment (`export default async (app: Application) => { app.use(...) }`),
 * and its type annotation is the precise signal for that — far safer than
 * guessing from the variable's name.
 */
const ROUTER_TYPE_NAMES = new Set(['Router', 'IRouter', 'express.Router', 'e.Router']);

const APP_TYPE_NAMES = new Set([
  'Application',
  'Express',
  'express.Application',
  'express.Express',
  'e.Application',
  'e.Express',
]);

interface Registration {
  readonly routerVariable: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly middleware: readonly string[];
  readonly requestShape?: ShapeRef;
  readonly line: number;
  readonly column: number;
}

interface Mount {
  readonly routerVariable: string;
  readonly prefix: string;
  /** Symbol being mounted, e.g. 'projectRoutes'. */
  readonly symbol: string;
  readonly line: number;
}

interface FileAnalysis {
  readonly file: string;
  readonly bindings: ModuleBindings;
  readonly routerVariables: ReadonlySet<string>;
  /** Variables holding the app itself, which is a root and never mounted. */
  readonly appVariables: ReadonlySet<string>;
  readonly registrations: readonly Registration[];
  readonly mounts: readonly Mount[];
  /** Variables that looked like routers but could not be confirmed. */
  readonly unconfirmedRouters: readonly string[];
}

export interface ExpressResult {
  readonly entries: readonly EndpointEntry[];
  readonly gaps: readonly Gap[];
  readonly found: boolean;
}

export async function extractExpressEndpoints(args: {
  root: string;
  exclude: readonly string[];
  workspaces?: readonly Workspace[];
}): Promise<ExpressResult> {
  const files = (
    await fg(['**/*.{ts,js,mjs}'], { cwd: args.root, ignore: [...args.exclude], onlyFiles: true })
  )
    .map(toPosix)
    .sort();
  const fileSet = new Set(files);
  const aliases = await loadPathAliases(args.root);

  const analyses = new Map<string, FileAnalysis>();
  const bindingsCache = new Map<string, ModuleBindings | undefined>();

  /**
   * Bindings for any file, parsed on demand.
   *
   * A re-export barrel declares no routes of its own, so it never reaches
   * `analyses` — but mount resolution passes straight through it. Loading
   * lazily keeps the common path cheap while still following the chain.
   */
  const loadBindings = async (file: string): Promise<ModuleBindings | undefined> => {
    if (bindingsCache.has(file)) return bindingsCache.get(file);
    let bindings: ModuleBindings | undefined;
    try {
      const contents = await fs.readFile(path.join(args.root, file), 'utf8');
      bindings = readModuleBindings(parseSourceFile(file, contents));
    } catch {
      bindings = undefined;
    }
    bindingsCache.set(file, bindings);
    return bindings;
  };

  for (const relative of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(args.root, relative), 'utf8');
    } catch {
      continue;
    }
    // Cheap pre-filter; parsing every file in a large repo blows the budget.
    if (!/\b(?:Router|express)\s*\(|\.(?:get|post|put|patch|delete|use)\s*\(/.test(contents)) continue;

    const analysis = analyseFile(relative, contents);
    bindingsCache.set(relative, analysis.bindings);
    if (
      analysis.registrations.length === 0 &&
      analysis.mounts.length === 0 &&
      analysis.unconfirmedRouters.length === 0
    ) {
      continue;
    }

    analyses.set(relative, analysis);
  }

  // A file reaches `analyses` only with a registration, a mount, or a candidate
  // router in a file that imports express — so anything here is genuine
  // evidence. A repo where every router is unconfirmed still counts: producing
  // silence there would be the "empty output looks like a clean repo" failure.
  if (analyses.size === 0) return { entries: [], gaps: [], found: false };

  // Resolve every mount to the file that declares the router it points at, so
  // a registration can be given the prefix it actually runs under.
  const locationsByRouter = new Map<string, Map<string, Set<string>>>();
  const mountEdges = new Map<string, Array<{ readonly to: string; readonly prefix: string }>>();
  const gaps: Gap[] = [];

  const routerKey = (file: string, variable: string): string => `${file}\u0000${variable}`;
  const targetVariable = (resolved: { file: string; exportedName: string }): string => {
    const target = analyses.get(resolved.file);
    if (target === undefined) return resolved.exportedName;
    if (resolved.exportedName === '*') {
      const defaultBinding = target.bindings.exports.get('default');
      if (defaultBinding?.kind === 'local') return defaultBinding.localName;
      if (target.mounts.some((mount) => mount.routerVariable === '$default')) return '$default';
      if (target.routerVariables.size === 1) return [...target.routerVariables][0] as string;
    }
    const binding = target.bindings.exports.get(resolved.exportedName);
    if (binding?.kind === 'local') return binding.localName;
    if (resolved.exportedName === 'default' && target.mounts.some((mount) => mount.routerVariable === '$default')) {
      return '$default';
    }
    return resolved.exportedName;
  };

  for (const analysis of analyses.values()) {
    for (const mount of analysis.mounts) {
      const resolved = await resolveSymbolToFile({
        fromFile: analysis.file,
        symbol: mount.symbol,
        loadBindings,
        files: fileSet,
        aliases,
      });

      if (resolved === undefined || !analyses.has(resolved.file)) {
        // A mount pointing at something docgen cannot follow — commonly a
        // third-party middleware rather than a local router. Only worth
        // reporting when it carries a path prefix that would change URLs.
        if (mount.prefix !== '' && mount.prefix !== '/') {
          gaps.push({
            extractor: 'endpoints',
            kind: 'mount-target-unresolved',
            message:
              `'${mount.symbol}' is mounted at '${mount.prefix}' but docgen could not resolve what it ` +
              'refers to. Any routes it declares are documented without this prefix.',
            source: { file: analysis.file, line: mount.line },
          });
        }
        continue;
      }

      const from = routerKey(analysis.file, mount.routerVariable);
      const to = routerKey(resolved.file, targetVariable(resolved));
      const edges = mountEdges.get(from) ?? [];
      edges.push({ to, prefix: mount.prefix });
      mountEdges.set(from, edges);
    }

    if (analysis.unconfirmedRouters.length > 0) {
      gaps.push({
        extractor: 'endpoints',
        kind: 'unconfirmed-router-variable',
        message:
          `${analysis.file} registers rooted paths on ${analysis.unconfirmedRouters.join(', ')}, which ` +
          'docgen could not confirm is an Express app or router. Those routes are not documented — ' +
          'annotate the variable with an Express type to have them picked up.',
        source: { file: analysis.file },
      });
    }
  }

  const queue: Array<{ readonly key: string; readonly prefix: string; readonly application: string }> = [];
  for (const analysis of analyses.values()) {
    for (const variable of analysis.appVariables) {
      const workspace = owningWorkspace(analysis.file, args.workspaces ?? [{ dir: '', manifests: [] }]);
      queue.push({
        key: routerKey(analysis.file, variable),
        prefix: '',
        application: applicationScope(workspace, 'express', `${analysis.file}#${variable}`),
      });
    }
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    const visitKey = `${current.key}\u0000${current.application}\u0000${current.prefix}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    const byApplication = locationsByRouter.get(current.key) ?? new Map<string, Set<string>>();
    const bucket = byApplication.get(current.application) ?? new Set<string>();
    bucket.add(current.prefix);
    byApplication.set(current.application, bucket);
    locationsByRouter.set(current.key, byApplication);
    for (const edge of mountEdges.get(current.key) ?? []) {
      queue.push({
        key: edge.to,
        prefix: joinPath(current.prefix, edge.prefix),
        application: current.application,
      });
    }
  }

  const entries: EndpointEntry[] = [];

  for (const analysis of analyses.values()) {
    if (analysis.registrations.length === 0) continue;

    const registrationLocations = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>();
    for (const registration of analysis.registrations) {
      registrationLocations.set(
        registration.routerVariable,
        locationsByRouter.get(routerKey(analysis.file, registration.routerVariable)) ?? new Map(),
      );
    }

    if (
      declaresMountableRouter(analysis) &&
      [...new Set(analysis.registrations.map((registration) => registration.routerVariable))].some(
        (variable) => (locationsByRouter.get(routerKey(analysis.file, variable))?.size ?? 0) === 0,
      )
    ) {
      // Routes on a router nobody mounts have no determinable URL.
      gaps.push({
        extractor: 'endpoints',
        kind: 'router-not-mounted',
        message:
          `${analysis.file} declares routes on a router that docgen did not find mounted anywhere. ` +
          'The paths shown are relative to wherever it is mounted, so they may be incomplete.',
        source: { file: analysis.file },
      });
    }

    for (const registration of analysis.registrations) {
      const locations = registrationLocations.get(registration.routerVariable) ?? new Map();
      const effectiveLocations = locations.size === 0
        ? [{ application: undefined, prefix: '' }]
        : [...locations.entries()]
            .flatMap(([application, prefixes]) =>
              [...prefixes].sort().map((prefix) => ({ application, prefix })),
            )
            .sort((a, b) =>
              (a.application ?? '').localeCompare(b.application ?? '') || a.prefix.localeCompare(b.prefix),
            );
      for (const { application, prefix } of effectiveLocations) {
        const fullPath = joinPath(prefix, registration.path);
        const workspace = owningWorkspace(analysis.file, args.workspaces ?? [{ dir: '', manifests: [] }]);
        entries.push({
          id: `endpoint:${registration.method}:${fullPath}`,
          source: { file: analysis.file, line: registration.line, column: registration.column },
          extractionMethod: 'ast',
          certainty: 'high',
          method: registration.method,
          path: fullPath,
          ...(args.workspaces !== undefined && args.workspaces.length > 1 ? { workspace } : {}),
          ...(application === undefined ? { finalPathResolved: false } : { application, finalPathResolved: true }),
          params: paramsOf(fullPath),
          handler: { file: analysis.file, line: registration.line },
          middleware: registration.middleware,
          ...(registration.requestShape === undefined
            ? {}
            : { requestShape: registration.requestShape }),
        });
      }
    }
  }

  return { entries, gaps, found: true };
}

/**
 * Whether this file registers routes on a Router that something else must
 * mount. The application object is a root: it is never mounted, so an
 * unmounted-router warning about it would be a false alarm.
 */
function declaresMountableRouter(analysis: FileAnalysis): boolean {
  return analysis.registrations.some((registration) =>
    analysis.routerVariables.has(registration.routerVariable),
  );
}

/** The module symbol a mount refers to: `routes` or `routes.default`. */
function mountedSymbolName(argument: ts.Expression): string | undefined {
  if (ts.isIdentifier(argument)) return argument.text;
  if (
    ts.isPropertyAccessExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    ts.isIdentifier(argument.name) &&
    argument.name.text === 'default'
  ) {
    return argument.expression.text;
  }
  return undefined;
}

export function analyseFile(file: string, contents: string): FileAnalysis {
  const source = parseSourceFile(file, contents);
  const bindings = readModuleBindings(source);

  const importsExpress = [...bindings.imports.values()].some(
    (binding) => binding.specifier === 'express',
  );
  const routerVariables = new Set<string>();
  const appVariables = new Set<string>();
  const registrations: Registration[] = [];
  const mounts: Mount[] = [];
  const unconfirmed = new Set<string>();

  // `const router = Router()` / `express()` / `express.Router()`
  walk(source, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name)) return;
    const initializer = node.initializer;
    if (initializer === undefined || !ts.isCallExpression(initializer)) return;

    if (isRouterChain(initializer)) {
      routerVariables.add(node.name.text);
      return;
    }

    const callee = initializer.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
        ? callee.name.text
        : undefined;

    if (name === undefined) return;
    if (ROUTER_FACTORIES.has(name)) routerVariables.add(node.name.text);
    else if (APP_FACTORIES.has(name)) appVariables.add(node.name.text);
  });

  walk(source, (node) => {
    if (
      ts.isExportAssignment(node) && node.isExportEquals !== true &&
      isRouterChain(node.expression)
    ) {
      routerVariables.add('$default');
    }
  });

  // Anything annotated as an Express app or router, however it arrived.
  walk(source, (node) => {
    const isTyped =
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.type !== undefined;
    if (!isTyped) return;

    const declaration = node as ts.ParameterDeclaration | ts.VariableDeclaration;
    const typeText = declaration.type?.getText(source);
    const name = (declaration.name as ts.Identifier).text;
    if (typeText === undefined) return;

    if (ROUTER_TYPE_NAMES.has(typeText)) routerVariables.add(name);
    else if (APP_TYPE_NAMES.has(typeText)) appVariables.add(name);
  });

  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return;
    const routerVariable = ts.isIdentifier(callee.expression)
      ? callee.expression.text
      : ownerOfChain(node);
    if (routerVariable === undefined) return;
    const methodName = callee.name.text.toLowerCase();
    const position = positionOf(source, node, file);

    // Only a variable known to hold a Router or app counts. Without this,
    // `req.get('User-Agent')` and `axios.post('http://...')` are read as route
    // registrations and published as endpoints that do not exist.
    if (!routerVariables.has(routerVariable) && !appVariables.has(routerVariable)) {
      // It may still be a router docgen could not confirm — an untyped JS
      // parameter, say. Recorded so the omission is visible rather than
      // silent, but never emitted as an endpoint.
      const first = node.arguments[0];
      const candidatePath = literalString(first);
      // Requiring express in the file keeps HTTP clients out: `axios.get('/api/x')`
      // in a React app is a request, not a route, and reporting it as an
      // unconfirmed router would claim the repo runs a server it does not.
      if (
        importsExpress &&
        (HTTP_METHODS.has(methodName) || methodName === 'use') &&
        candidatePath !== undefined &&
        candidatePath.startsWith('/')
      ) {
        unconfirmed.add(routerVariable);
      }
      return;
    }

    if (methodName === 'use') {
      const first = node.arguments[0];
      const literalPrefix = literalString(first);
      const hasPrefix = literalPrefix?.startsWith('/') === true;
      const prefix = hasPrefix ? literalPrefix as string : '';
      const mounted = hasPrefix ? node.arguments.slice(1) : node.arguments;
      for (const argument of mounted) {
        // `app.use('/x', routes)` and the ESM/CJS interop form
        // `app.use('/x', routes.default)` both mount the same module.
        const symbol = mountedSymbolName(argument);
        if (symbol !== undefined) {
          mounts.push({ routerVariable, prefix, symbol, line: position.line ?? 1 });
        }
      }
      return;
    }

    if (!HTTP_METHODS.has(methodName)) return;

    const first = node.arguments[0];
    const routePath = literalString(first);
    if (routePath === undefined) {
      // A computed path cannot be resolved without running the module. Emitting
      // nothing here is deliberate: a wrong URL is worse than a missing one.
      return;
    }
    // Express route paths are rooted. A non-rooted string is something else —
    // a header name, an absolute URL passed to an HTTP client, an event name.
    if (!routePath.startsWith('/')) return;

    const middleware: string[] = [];
    let requestShape: ShapeRef | undefined;

    // In Express the final argument is the route handler; everything between
    // the path and it is middleware. Listing the handler as middleware would
    // misreport the auth chain, which is the field a reader most relies on.
    const handlerArguments = node.arguments.slice(1);
    const middlewareArguments =
      handlerArguments.length > 1 ? handlerArguments.slice(0, -1) : [];

    for (const argument of middlewareArguments) {
      if (ts.isIdentifier(argument)) {
        middleware.push(argument.text);
        continue;
      }
      if (ts.isCallExpression(argument) && ts.isIdentifier(argument.expression)) {
        const callName = argument.expression.text;
        middleware.push(`${callName}()`);

        // `validate(CreateOrderSchema)` names the request contract. The
        // validator library is not assumed — only that this argument is what
        // the route validates against.
        const shapeArgument = argument.arguments[0];
        if (requestShape === undefined && shapeArgument !== undefined && ts.isIdentifier(shapeArgument)) {
          requestShape = { name: shapeArgument.text, kind: 'validator-argument' };
        }
      }
    }

    registrations.push({
      routerVariable,
      method: methodName.toUpperCase() as HttpMethod,
      path: routePath,
      middleware,
      ...(requestShape === undefined ? {} : { requestShape }),
      line: position.line ?? 1,
      column: position.column ?? 1,
    });
  });

  const defaultExport = bindings.exports.get('default');
  if (defaultExport?.kind === 'local' && routerVariables.has(defaultExport.localName)) {
    mounts.push({ routerVariable: '$default', prefix: '', symbol: defaultExport.localName, line: 1 });
  }

  for (const name of [...routerVariables, ...appVariables]) unconfirmed.delete(name);
  return {
    file,
    bindings,
    routerVariables,
    appVariables,
    registrations,
    mounts,
    unconfirmedRouters: [...unconfirmed].sort(),
  };
}

function isRouterChain(expression: ts.Expression): boolean {
  let current: ts.Expression = expression;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    current = current.expression.expression;
  }
  return ts.isCallExpression(current) &&
    ((ts.isIdentifier(current.expression) && ROUTER_FACTORIES.has(current.expression.text)) ||
      (ts.isPropertyAccessExpression(current.expression) &&
        ts.isIdentifier(current.expression.name) && ROUTER_FACTORIES.has(current.expression.name.text)));
}

function ownerOfChain(node: ts.CallExpression): string | undefined {
  let current: ts.Node = node;
  while (current.parent !== undefined) {
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isExportAssignment(parent) && parent.isExportEquals !== true) return '$default';
    if (ts.isStatement(parent)) return undefined;
    current = parent;
  }
  return undefined;
}
