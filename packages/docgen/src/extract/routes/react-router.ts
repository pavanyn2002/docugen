import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { RouteEntry } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import {
  getProperty,
  importedModules,
  literalString,
  parseSourceFile,
  positionOf,
  ts,
  walk,
} from '../../util/ts-ast.js';

/**
 * React Router, for SPAs with a central route table.
 *
 * Three authoring styles are handled: the `createBrowserRouter([...])` object
 * form, nested `<Route>` JSX, and a route-table array exported from a separate
 * module and mapped into `<Route>` elements. All three nest, so child paths are
 * resolved against their parent.
 *
 * The third form is common and easy to get wrong. A bare array of objects with
 * a `path` key could equally be a nav menu or a breadcrumb config, so a table
 * only counts when the module declaring it is imported by a file that actually
 * uses react-router. That link is what separates a real route table from a
 * lookalike, and inventing routes from a nav menu would be exactly the
 * fabrication this tool exists to stop.
 *
 * A route whose `path` is a variable or template expression cannot be resolved
 * without evaluating the module, so it is recorded as a gap. Guessing at it
 * would put a URL in the docs that may not exist.
 */

interface CollectedRoute {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly isIndex: boolean;
  readonly element?: string;
}

const ROUTER_MODULES = ['react-router', 'react-router-dom'];

/** Extensions tried when resolving a relative import to a file on disk. */
const RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/**
 * Resolve a relative import to a repo-relative file, or undefined if it does
 * not land on a file that was scanned.
 */
export function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  // TypeScript sources are frequently imported with a .js specifier.
  const withoutJs = base.replace(/\.(js|jsx|mjs)$/, '');

  for (const candidate of [base, withoutJs]) {
    for (const suffix of RESOLUTION_SUFFIXES) {
      const resolved = `${candidate}${suffix}`;
      if (files.has(resolved)) return resolved;
    }
  }
  return undefined;
}

export async function extractReactRouterRoutes(args: {
  root: string;
  include: readonly string[];
  exclude: readonly string[];
}): Promise<{ entries: readonly RouteEntry[]; gaps: readonly Gap[] }> {
  const files = (
    await fg('**/*.{tsx,jsx,ts,js}', {
      cwd: args.root,
      ignore: [...args.exclude],
      onlyFiles: true,
    })
  )
    .map(toPosix)
    .sort();
  const fileSet = new Set(files);

  const entries: RouteEntry[] = [];
  const gaps: Gap[] = [];
  const seen = new Set<string>();
  const readCache = new Map<string, string>();

  const read = async (relative: string): Promise<string | undefined> => {
    const cached = readCache.get(relative);
    if (cached !== undefined) return cached;
    try {
      const contents = await fs.readFile(path.join(args.root, relative), 'utf8');
      readCache.set(relative, contents);
      return contents;
    } catch {
      return undefined;
    }
  };

  // Pass 1: files that genuinely use react-router, and the local modules they
  // import — the only places a route table is trusted to live.
  const routerFiles: string[] = [];
  const tableCandidates = new Set<string>();

  for (const relative of files) {
    const contents = await read(relative);
    // Cheap pre-filter: parsing every file in a large repo would blow the budget.
    if (contents === undefined || !contents.includes('react-router')) continue;

    const source = parseSourceFile(relative, contents);
    const imports = importedModules(source);
    if (!imports.some((specifier) => ROUTER_MODULES.includes(specifier))) continue;

    routerFiles.push(relative);
    for (const specifier of imports) {
      const resolved = resolveRelativeImport(relative, specifier, fileSet);
      if (resolved !== undefined && resolved !== relative) tableCandidates.add(resolved);
    }
  }

  // Pass 2: route declarations in the router files themselves.
  for (const relative of routerFiles) {
    const contents = await read(relative);
    if (contents === undefined) continue;
    const source = parseSourceFile(relative, contents);

    const collected: CollectedRoute[] = [];
    collectObjectRoutes(source, relative, '', collected, gaps);
    collectJsxRoutes(source, relative, '', collected, gaps);
    collectRouteTables(source, relative, collected, gaps);

    pushEntries(collected, relative, entries, gaps, seen);
  }

  // Pass 3: route tables in modules imported by a router file.
  for (const relative of [...tableCandidates].sort()) {
    if (routerFiles.includes(relative)) continue;
    const contents = await read(relative);
    if (contents === undefined) continue;

    const source = parseSourceFile(relative, contents);
    const collected: CollectedRoute[] = [];
    collectRouteTables(source, relative, collected, gaps);

    pushEntries(collected, relative, entries, gaps, seen);
  }

  return { entries: entries, gaps };
}

function pushEntries(
  collected: readonly CollectedRoute[],
  relative: string,
  entries: RouteEntry[],
  gaps: Gap[],
  seen: Set<string>,
): void {
  for (const route of collected) {
      const id = `route:page:${route.path}`;
      // The same path declared twice is real duplication worth reporting, but
      // only one entry should represent it.
      if (seen.has(id)) {
        gaps.push({
          extractor: 'routes',
          kind: 'duplicate-route-path',
          message: `Route path '${route.path}' is declared more than once.`,
          source: { file: relative, line: route.line, column: route.column },
        });
        continue;
      }
      seen.add(id);

      entries.push({
        id,
        source: { file: relative, line: route.line, column: route.column },
        extractionMethod: 'ast',
        certainty: 'high',
        path: route.path,
        kind: 'page',
        params: paramsOf(route.path),
        isCatchAll: route.path.includes('*'),
        component: { file: relative, line: route.line },
        layoutChain: [],
        guards: [],
      });
  }
}

function paramsOf(routePath: string): readonly string[] {
  return routePath
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1));
}

/** Join a parent route path with a child's, honouring absolute child paths. */
export function joinRoutePaths(parent: string, child: string): string {
  if (child.startsWith('/')) return normalise(child);
  if (child === '') return normalise(parent === '' ? '/' : parent);
  return normalise(`${parent}/${child}`);
}

function normalise(value: string): string {
  const collapsed = `/${value}`.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : '/';
}

/** `createBrowserRouter([{ path, children: [...] }])` and friends. */
function collectObjectRoutes(
  source: ts.SourceFile,
  file: string,
  parentPath: string,
  out: CollectedRoute[],
  gaps: Gap[],
): void {
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    if (
      callee !== 'createBrowserRouter' &&
      callee !== 'createHashRouter' &&
      callee !== 'createMemoryRouter'
    ) {
      return;
    }
    const first = node.arguments[0];
    if (first === undefined || !ts.isArrayLiteralExpression(first)) {
      gaps.push({
        extractor: 'routes',
        kind: 'router-config-not-literal',
        message:
          `${callee}() is called with a value docgen cannot read statically, ` +
          'so the routes it declares are unknown.',
        source: positionOf(source, node, file),
      });
      return;
    }
    walkRouteArray(source, file, first, parentPath, out, gaps);
  });
}

function walkRouteArray(
  source: ts.SourceFile,
  file: string,
  array: ts.ArrayLiteralExpression,
  parentPath: string,
  out: CollectedRoute[],
  gaps: Gap[],
): void {
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;

    const pathNode = getProperty(element, 'path');
    const indexNode = getProperty(element, 'index');
    const isIndex = indexNode !== undefined && indexNode.kind === ts.SyntaxKind.TrueKeyword;

    let resolved = parentPath;
    if (pathNode !== undefined) {
      const literal = literalString(pathNode);
      if (literal === undefined) {
        gaps.push({
          extractor: 'routes',
          kind: 'route-path-not-literal',
          message:
            'A route path is a computed expression rather than a string literal, ' +
            'so its URL cannot be determined statically.',
          source: positionOf(source, pathNode, file),
        });
        continue;
      }
      resolved = joinRoutePaths(parentPath, literal);
    }

    // A layout route has children but no path of its own; only leaves and
    // index routes are addressable URLs.
    const children = getProperty(element, 'children');
    const hasChildren = children !== undefined && ts.isArrayLiteralExpression(children);

    if (pathNode !== undefined || isIndex) {
      if (!hasChildren || isIndex) {
        const position = positionOf(source, element, file);
        out.push({
          path: resolved === '' ? '/' : resolved,
          line: position.line ?? 1,
          column: position.column ?? 1,
          isIndex,
        });
      }
    }

    if (hasChildren) {
      walkRouteArray(source, file, children, resolved, out, gaps);
    }
  }
}

/**
 * Keys that distinguish a route definition from a lookalike object. A nav menu
 * entry has `path` and `label`; a route has `path` and something to render.
 */
const ROUTE_ELEMENT_KEYS = ['element', 'Component', 'component', 'children', 'lazy', 'loader'];

/** True when an array literal looks like a route table rather than a config list. */
function isRouteTable(array: ts.ArrayLiteralExpression): boolean {
  return array.elements.some((element) => {
    if (!ts.isObjectLiteralExpression(element)) return false;
    if (literalString(getProperty(element, 'path')) === undefined) return false;
    return ROUTE_ELEMENT_KEYS.some((key) => getProperty(element, key) !== undefined);
  });
}

/**
 * A route table declared as a standalone array, e.g.
 * `const routes = [{ path: '/about', element: <About /> }]`, later mapped into
 * `<Route>` elements.
 */
function collectRouteTables(
  source: ts.SourceFile,
  file: string,
  out: CollectedRoute[],
  gaps: Gap[],
): void {
  const visited = new Set<ts.Node>();

  walk(source, (node) => {
    if (!ts.isArrayLiteralExpression(node)) return;
    if (visited.has(node)) return;
    if (!isRouteTable(node)) return;

    // Mark descendants so a nested `children` array is not processed twice.
    walk(node, (child) => {
      if (child !== node && ts.isArrayLiteralExpression(child)) visited.add(child);
    });

    walkRouteArray(source, file, node, '', out, gaps);
  });
}

/** Nested `<Route path="..." />` JSX. */
function collectJsxRoutes(
  source: ts.SourceFile,
  file: string,
  parentPath: string,
  out: CollectedRoute[],
  gaps: Gap[],
): void {
  const visit = (node: ts.Node, inheritedPath: string): void => {
    let currentPath = inheritedPath;
    let isRouteElement = false;

    const tagName = jsxTagName(node);
    if (tagName === 'Route') {
      isRouteElement = true;
      const pathAttribute = jsxAttribute(node, 'path');
      const isIndex = jsxAttribute(node, 'index') !== undefined;
      let pathResolved = true;

      if (pathAttribute !== undefined) {
        const literal = jsxAttributeString(pathAttribute);
        if (literal === undefined) {
          // The path is computed. Record the gap and emit nothing: falling
          // through would publish a route at the parent's path, inventing a
          // URL from a parse that failed.
          pathResolved = false;
          gaps.push({
            extractor: 'routes',
            kind: 'route-path-not-literal',
            message:
              'A <Route path> is a computed expression rather than a string literal, ' +
              'so its URL cannot be determined statically.',
            source: positionOf(source, pathAttribute, file),
          });
        } else {
          currentPath = joinRoutePaths(inheritedPath, literal);
        }
      }

      const hasRouteChildren = ts.isJsxElement(node) && node.children.some((c) => jsxTagName(c) === 'Route');
      if (pathResolved && (pathAttribute !== undefined || isIndex) && !hasRouteChildren) {
        const position = positionOf(source, node, file);
        out.push({
          path: currentPath === '' ? '/' : currentPath,
          line: position.line ?? 1,
          column: position.column ?? 1,
          isIndex,
        });
      }
    }

    node.forEachChild((child) => visit(child, isRouteElement ? currentPath : inheritedPath));
  };

  visit(source, parentPath);
}

function jsxTagName(node: ts.Node): string | undefined {
  const opening = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : undefined;
  if (opening === undefined) return undefined;
  return ts.isIdentifier(opening.tagName) ? opening.tagName.text : undefined;
}

function jsxAttribute(node: ts.Node, name: string): ts.JsxAttribute | undefined {
  const opening = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : undefined;
  if (opening === undefined) return undefined;

  for (const attribute of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attribute)) continue;
    if (ts.isIdentifier(attribute.name) && attribute.name.text === name) return attribute;
  }
  return undefined;
}

function jsxAttributeString(attribute: ts.JsxAttribute): string | undefined {
  const initializer = attribute.initializer;
  if (initializer === undefined) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer)) return literalString(initializer.expression);
  return undefined;
}
