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
import { compareStrings } from '../../util/sort.js';
import { redactSecrets } from '../../privacy/redact.js';
import { joinPath, paramsOf } from './paths.js';
import type { Workspace } from '../../detect/workspaces.js';
import { applicationScope, owningWorkspace } from '../../detect/ownership.js';
import { evaluateStaticString, type StaticModule } from './static-string.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const ROUTER_FACTORIES = new Set(['Router']);
const APP_FACTORIES = new Set(['express']);
const ROUTER_TYPE_NAMES = new Set(['Router', 'IRouter', 'express.Router', 'e.Router']);
const APP_TYPE_NAMES = new Set([
  'Application', 'Express', 'Express.Application', 'Express.Express',
  'express.Application', 'express.Express', 'e.Application', 'e.Express',
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
  readonly prefixExpression?: ts.Expression;
  readonly symbol: string;
  readonly line: number;
}

interface ApplicationRoot {
  readonly owner: string;
  readonly discriminator: string;
}

interface FileAnalysis extends StaticModule {
  readonly routerVariables: ReadonlySet<string>;
  readonly applicationRoots: readonly ApplicationRoot[];
  readonly registrations: readonly Registration[];
  readonly mounts: readonly Mount[];
  readonly unconfirmedRouters: readonly string[];
}

export interface ExpressSourceOwnership {
  readonly file: string;
  readonly workspace: string;
  readonly applications: readonly {
    readonly application: string;
    readonly prefix: string;
    readonly finalPathResolved: boolean;
    readonly origin: 'router' | 'application';
  }[];
}

export interface ExpressResult {
  readonly entries: readonly EndpointEntry[];
  readonly gaps: readonly Gap[];
  readonly found: boolean;
  /** Router/application ownership reused by inline OpenAPI cross-checking. */
  readonly sourceOwnership: readonly ExpressSourceOwnership[];
}

interface Location {
  readonly prefix: string;
  readonly resolved: boolean;
}

interface MountEdge {
  readonly to: string;
  readonly prefix: string;
  readonly resolved: boolean;
  readonly original?: string;
  readonly sourceFile: string;
  readonly line: number;
  readonly symbol: string;
}

export async function extractExpressEndpoints(args: {
  root: string;
  exclude: readonly string[];
  workspaces?: readonly Workspace[];
}): Promise<ExpressResult> {
  const files = (await fg(['**/*.{ts,js,mjs}'], {
    cwd: args.root, ignore: [...args.exclude], onlyFiles: true,
  })).map(toPosix).sort(compareStrings);
  const fileSet = new Set(files);
  const aliases = await loadPathAliases(args.root);
  const analyses = new Map<string, FileAnalysis>();
  const moduleCache = new Map<string, StaticModule | undefined>();

  const loadModule = async (file: string): Promise<StaticModule | undefined> => {
    if (moduleCache.has(file)) return moduleCache.get(file);
    try {
      const contents = await fs.readFile(path.join(args.root, file), 'utf8');
      const source = parseSourceFile(file, contents);
      const module = { file, source, bindings: readModuleBindings(source) };
      moduleCache.set(file, module);
      return module;
    } catch {
      moduleCache.set(file, undefined);
      return undefined;
    }
  };
  const loadBindings = async (file: string): Promise<ModuleBindings | undefined> =>
    (await loadModule(file))?.bindings;

  for (const relative of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(args.root, relative), 'utf8');
    } catch {
      continue;
    }
    if (!/\b(?:Router|express)\s*\(|\.(?:get|post|put|patch|delete|head|options|all|use)\s*\(/.test(contents)) continue;
    const analysis = analyseFile(relative, contents);
    moduleCache.set(relative, analysis);
    if (analysis.registrations.length === 0 && analysis.mounts.length === 0 && analysis.unconfirmedRouters.length === 0) continue;
    analyses.set(relative, analysis);
  }

  if (analyses.size === 0) return { entries: [], gaps: [], found: false, sourceOwnership: [] };

  const locationsByRouter = new Map<string, Map<string, Map<string, Location>>>();
  const mountEdges = new Map<string, MountEdge[]>();
  const gaps: Gap[] = [];
  const workspaces = args.workspaces ?? [{ dir: '', manifests: [] }];
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
    if (resolved.exportedName === 'default' && target.mounts.some((mount) => mount.routerVariable === '$default')) return '$default';
    return resolved.exportedName;
  };

  for (const analysis of analyses.values()) {
    for (const mount of analysis.mounts) {
      const evaluated = mount.prefixExpression === undefined
        ? { value: mount.prefix, complete: true, original: mount.prefix }
        : await evaluateStaticString({
            module: analysis, expression: mount.prefixExpression, files: fileSet, aliases, loadModule,
          });
      const resolved = await resolveSymbolToFile({
        fromFile: analysis.file, symbol: mount.symbol, loadBindings, files: fileSet, aliases,
      });
      if (resolved === undefined || !analyses.has(resolved.file)) {
        if (evaluated.value !== '' && evaluated.value !== '/') {
          gaps.push({
            extractor: 'endpoints', kind: 'mount-target-unresolved',
            message: `'${mount.symbol}' is mounted at '${evaluated.value}' but docgen could not resolve what it refers to.`,
            source: { file: analysis.file, line: mount.line },
          });
        }
        continue;
      }
      const from = routerKey(analysis.file, mount.routerVariable);
      const to = routerKey(resolved.file, targetVariable(resolved));
      mountEdges.set(from, [...(mountEdges.get(from) ?? []), {
        to, prefix: evaluated.value, resolved: evaluated.complete,
        ...(evaluated.complete ? {} : { original: redactSecrets(evaluated.original).text }),
        sourceFile: analysis.file, line: mount.line, symbol: mount.symbol,
      }]);
    }
    if (analysis.unconfirmedRouters.length > 0) {
      gaps.push({
        extractor: 'endpoints', kind: 'unconfirmed-router-variable',
        message: `${analysis.file} registers rooted paths on ${analysis.unconfirmedRouters.join(', ')}, which docgen could not confirm is an Express app or router. Those routes are not documented; annotate the variable with an Express type.`,
        source: { file: analysis.file },
      });
    }
  }

  const queue: Array<{ key: string; prefix: string; application: string; resolved: boolean }> = [];
  for (const analysis of analyses.values()) {
    const workspace = owningWorkspace(analysis.file, workspaces);
    for (const root of analysis.applicationRoots) {
      queue.push({
        key: routerKey(analysis.file, root.owner), prefix: '', resolved: true,
        application: applicationScope(workspace, 'express', root.discriminator),
      });
    }
  }

  const visited = new Set<string>();
  const unresolvedFindingKeys = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    const visitKey = `${current.key}\u0000${current.application}\u0000${current.prefix}\u0000${current.resolved}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    const byApplication = locationsByRouter.get(current.key) ?? new Map();
    const bucket = byApplication.get(current.application) ?? new Map();
    bucket.set(`${current.prefix}\u0000${current.resolved}`, { prefix: current.prefix, resolved: current.resolved });
    byApplication.set(current.application, bucket);
    locationsByRouter.set(current.key, byApplication);
    for (const edge of mountEdges.get(current.key) ?? []) {
      const prefix = joinPath(current.prefix, edge.prefix);
      const resolved = current.resolved && edge.resolved;
      if (!edge.resolved) {
        const findingKey = `${edge.sourceFile}\u0000${edge.line}\u0000${edge.symbol}\u0000${current.application}\u0000${prefix}`;
        if (!unresolvedFindingKeys.has(findingKey)) {
          unresolvedFindingKeys.add(findingKey);
          gaps.push({
            extractor: 'endpoints', kind: 'mount-prefix-unresolved',
            message: `Mount prefix expression '${edge.original ?? edge.prefix}' for router '${edge.symbol}' in application '${current.application}' was only partially resolvable; '${prefix}' is used as an explicit placeholder path.`,
            source: { file: edge.sourceFile, line: edge.line },
          });
        }
      }
      queue.push({ key: edge.to, prefix, application: current.application, resolved });
    }
  }

  const entries: EndpointEntry[] = [];
  for (const analysis of analyses.values()) {
    if (analysis.registrations.length === 0) continue;
    const mountedVariables = new Set(
      analysis.registrations
        .map((registration) => registration.routerVariable)
        .filter((variable) => (locationsByRouter.get(routerKey(analysis.file, variable))?.size ?? 0) > 0),
    );
    const unmountedVariables = new Set(
      analysis.registrations
        .map((registration) => registration.routerVariable)
        .filter((variable) => analysis.routerVariables.has(variable) && !mountedVariables.has(variable)),
    );
    if (unmountedVariables.size > 0) {
      gaps.push({
        extractor: 'endpoints', kind: 'router-not-mounted',
        message: `${analysis.file} declares routes on a router that docgen did not find mounted anywhere. The paths shown are relative and may be incomplete.`,
        source: { file: analysis.file },
      });
    }
    for (const registration of analysis.registrations) {
      const locations = locationsByRouter.get(routerKey(analysis.file, registration.routerVariable)) ?? new Map();
      const effective = locations.size === 0
        ? [{ application: undefined, prefix: '', resolved: false }]
        : [...locations.entries()].flatMap(([application, values]) => [...values.values()].map((value) => ({ application, ...value })))
            .sort((a, b) => compareStrings(a.application ?? '', b.application ?? '') || compareStrings(a.prefix, b.prefix));
      for (const location of effective) {
        const fullPath = joinPath(location.prefix, registration.path);
        const workspace = owningWorkspace(analysis.file, workspaces);
        entries.push({
          id: `endpoint:${registration.method}:${fullPath}`,
          source: { file: analysis.file, line: registration.line, column: registration.column },
          extractionMethod: 'ast', certainty: 'high', method: registration.method, path: fullPath,
          ...(args.workspaces !== undefined && args.workspaces.length > 1 ? { workspace } : {}),
          ...(location.application === undefined
            ? { finalPathResolved: false }
            : { application: location.application, finalPathResolved: location.resolved }),
          params: paramsOf(fullPath), handler: { file: analysis.file, line: registration.line },
          middleware: registration.middleware,
          ...(registration.requestShape === undefined ? {} : { requestShape: registration.requestShape }),
        });
      }
    }
  }

  const sourceOwnership: ExpressSourceOwnership[] = [];
  for (const analysis of analyses.values()) {
    const workspace = owningWorkspace(analysis.file, workspaces);
    const applications = new Map<string, ExpressSourceOwnership['applications'][number]>();
    const owners = new Set([
      ...analysis.routerVariables,
      ...analysis.applicationRoots.map((root) => root.owner),
      ...analysis.registrations.map((registration) => registration.routerVariable),
    ]);
    for (const owner of owners) {
      for (const [application, values] of locationsByRouter.get(routerKey(analysis.file, owner)) ?? []) {
        for (const value of values.values()) {
          const origin = analysis.routerVariables.has(owner) ? 'router' : 'application';
          applications.set(`${application}\u0000${value.prefix}\u0000${value.resolved}\u0000${origin}`, {
            application, prefix: value.prefix, finalPathResolved: value.resolved, origin,
          });
        }
      }
    }
    sourceOwnership.push({
      file: analysis.file, workspace,
      applications: [...applications.values()].sort((a, b) =>
        compareStrings(a.application, b.application) || compareStrings(a.prefix, b.prefix)),
    });
  }

  return { entries, gaps: dedupeGaps(gaps), found: true, sourceOwnership };
}

function mountedSymbolName(argument: ts.Expression): string | undefined {
  if (ts.isIdentifier(argument)) return argument.text;
  if (ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression) && argument.name.text === 'default') {
    return argument.expression.text;
  }
  return undefined;
}

export function analyseFile(file: string, contents: string): FileAnalysis {
  const source = parseSourceFile(file, contents);
  const bindings = readModuleBindings(source);
  const importsExpress = [...bindings.imports.values()].some((binding) => binding.specifier === 'express');
  const routerVariables = new Set<string>();
  const appRoots = new Map<string, ApplicationRoot>();
  const aliases = new Map<string, string>();
  const registrations: Registration[] = [];
  const mounts: Mount[] = [];
  const unconfirmed = new Set<string>();
  const addAppRoot = (owner: string, discriminator = `${file}#${owner}`): void => {
    appRoots.set(owner, { owner, discriminator });
  };

  walk(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer !== undefined && ts.isCallExpression(initializer)) {
        if (isRouterChain(initializer)) routerVariables.add(node.name.text);
        else {
          const factory = factoryName(initializer);
          if (factory !== undefined && ROUTER_FACTORIES.has(factory)) routerVariables.add(node.name.text);
          else if (factory !== undefined && APP_FACTORIES.has(factory)) addAppRoot(node.name.text);
        }
      }
      if (node.type !== undefined) classifyTyped(node.name.text, node.type.getText(source), routerVariables, addAppRoot);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type !== undefined) {
      classifyTyped(node.name.text, node.type.getText(source), routerVariables, addAppRoot);
    }
    if (ts.isPropertyDeclaration(node) && isSimplePropertyName(node.name)) {
      const className = enclosingClassName(node);
      if (className === undefined) return;
      const owner = classOwner(className, node.name.text);
      const typeText = node.type?.getText(source);
      if (typeText !== undefined && APP_TYPE_NAMES.has(typeText)) addAppRoot(owner, `${file}#${className}.${node.name.text}`);
      if (node.initializer !== undefined && ts.isCallExpression(node.initializer) && APP_FACTORIES.has(factoryName(node.initializer) ?? '')) {
        addAppRoot(owner, `${file}#${className}.${node.name.text}`);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const owner = thisPropertyOwner(node.left);
      if (owner !== undefined && ts.isCallExpression(node.right) && APP_FACTORIES.has(factoryName(node.right) ?? '')) {
        const [className, property] = splitClassOwner(owner);
        addAppRoot(owner, `${file}#${className}.${property}`);
      }
    }
    if (ts.isExportAssignment(node) && node.isExportEquals !== true && isRouterChain(node.expression)) routerVariables.add('$default');
  });

  // Resolve harmless aliases such as `const server = this.app` before calls are
  // inspected. Fixed-point iteration also handles alias-of-alias chains.
  let changed = true;
  while (changed) {
    changed = false;
    walk(source, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.initializer === undefined) return;
      const target = expressionOwner(node.initializer, aliases);
      if (target !== undefined && (appRoots.has(target) || routerVariables.has(target)) && aliases.get(node.name.text) !== target) {
        aliases.set(node.name.text, target);
        changed = true;
      }
    });
  }

  walk(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const callee = node.expression;
    const routerVariable = expressionOwner(callee.expression, aliases) ?? ownerOfChain(node);
    if (routerVariable === undefined) return;
    const methodName = callee.name.text.toLowerCase();
    const position = positionOf(source, node, file);
    if (!routerVariables.has(routerVariable) && !appRoots.has(routerVariable)) {
      const candidatePath = literalString(node.arguments[0]);
      if (importsExpress && (HTTP_METHODS.has(methodName) || methodName === 'use') && candidatePath?.startsWith('/') === true) unconfirmed.add(routerVariable);
      return;
    }
    if (methodName === 'use') {
      const first = node.arguments[0];
      const hasPrefix = first !== undefined && node.arguments.length > 1 && isPrefixExpression(first, source, bindings);
      const mounted = hasPrefix ? node.arguments.slice(1) : node.arguments;
      for (const argument of mounted) {
        const symbol = mountedSymbolName(argument);
        if (symbol !== undefined) mounts.push({
          routerVariable, prefix: hasPrefix ? literalString(first) ?? '' : '',
          ...(hasPrefix && literalString(first) === undefined ? { prefixExpression: first } : {}),
          symbol, line: position.line ?? 1,
        });
      }
      return;
    }
    if (!HTTP_METHODS.has(methodName)) return;
    const routePath = literalString(node.arguments[0]);
    if (routePath === undefined || !routePath.startsWith('/')) return;
    const middleware: string[] = [];
    let requestShape: ShapeRef | undefined;
    const handlerArguments = node.arguments.slice(1);
    const middlewareArguments = handlerArguments.length > 1 ? handlerArguments.slice(0, -1) : [];
    for (const argument of middlewareArguments) {
      if (ts.isIdentifier(argument)) middleware.push(argument.text);
      else if (ts.isCallExpression(argument) && ts.isIdentifier(argument.expression)) {
        middleware.push(`${argument.expression.text}()`);
        const shape = argument.arguments[0];
        if (requestShape === undefined && shape !== undefined && ts.isIdentifier(shape)) {
          requestShape = { name: shape.text, kind: 'validator-argument' };
        }
      }
    }
    registrations.push({
      routerVariable, method: methodName.toUpperCase() as HttpMethod, path: routePath, middleware,
      ...(requestShape === undefined ? {} : { requestShape }), line: position.line ?? 1, column: position.column ?? 1,
    });
  });

  const defaultExport = bindings.exports.get('default');
  if (defaultExport?.kind === 'local' && routerVariables.has(defaultExport.localName)) {
    mounts.push({ routerVariable: '$default', prefix: '', symbol: defaultExport.localName, line: 1 });
  }
  for (const name of [...routerVariables, ...appRoots.keys(), ...aliases.keys()]) unconfirmed.delete(name);
  return {
    file, source, bindings, routerVariables, applicationRoots: [...appRoots.values()].sort((a, b) => compareStrings(a.owner, b.owner)),
    registrations, mounts, unconfirmedRouters: [...unconfirmed].sort(compareStrings),
  };
}

function classifyTyped(
  name: string,
  typeText: string,
  routers: Set<string>,
  addApp: (owner: string) => void,
): void {
  if (ROUTER_TYPE_NAMES.has(typeText)) routers.add(name);
  else if (APP_TYPE_NAMES.has(typeText)) addApp(name);
}

function factoryName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  return ts.isIdentifier(callee) ? callee.text
    : ts.isPropertyAccessExpression(callee) ? callee.name.text
    : undefined;
}

function classOwner(className: string, property: string): string {
  return `this:${className}:${property}`;
}

function splitClassOwner(owner: string): [string, string] {
  const [, className = 'Anonymous', property = 'app'] = owner.split(':');
  return [className, property];
}

function enclosingClassName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if ((ts.isClassDeclaration(current) || ts.isClassExpression(current)) && current.name !== undefined) return current.name.text;
    current = current.parent;
  }
  return undefined;
}

function thisPropertyOwner(node: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(node) || node.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  const className = enclosingClassName(node);
  return className === undefined ? undefined : classOwner(className, node.name.text);
}

function expressionOwner(expression: ts.Expression, aliases: ReadonlyMap<string, string>): string | undefined {
  if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? expression.text;
  return thisPropertyOwner(expression);
}

function isSimplePropertyName(name: ts.PropertyName): name is ts.Identifier | ts.StringLiteral {
  return ts.isIdentifier(name) || ts.isStringLiteral(name);
}

function isPrefixExpression(expression: ts.Expression, source: ts.SourceFile, bindings: ModuleBindings): boolean {
  const literal = literalString(expression);
  if (literal !== undefined) return literal.startsWith('/');
  if (
    ts.isTemplateExpression(expression) || ts.isBinaryExpression(expression) ||
    ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression) ||
    ts.isCallExpression(expression) || ts.isParenthesizedExpression(expression)
  ) return true;
  if (!ts.isIdentifier(expression)) return false;
  if (bindings.imports.has(expression.text)) return /(?:path|prefix|base|mount|url)$/i.test(expression.text);
  let initializer: ts.Expression | undefined;
  walk(source, (node) => {
    if (initializer !== undefined || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (node.name.text === expression.text) initializer = node.initializer;
  });
  return initializer !== undefined;
}

function isRouterChain(expression: ts.Expression): boolean {
  let current = expression;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) current = current.expression.expression;
  return ts.isCallExpression(current) && (
    (ts.isIdentifier(current.expression) && ROUTER_FACTORIES.has(current.expression.text)) ||
    (ts.isPropertyAccessExpression(current.expression) && ROUTER_FACTORIES.has(current.expression.name.text))
  );
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

function dedupeGaps(gaps: readonly Gap[]): readonly Gap[] {
  const unique = new Map<string, Gap>();
  for (const gap of gaps) unique.set(`${gap.kind}\u0000${gap.source?.file ?? ''}\u0000${gap.source?.line ?? 0}\u0000${gap.message}`, gap);
  return [...unique.values()].sort((a, b) =>
    compareStrings(a.kind, b.kind) || compareStrings(a.source?.file ?? '', b.source?.file ?? '') ||
    (a.source?.line ?? 0) - (b.source?.line ?? 0) || compareStrings(a.message, b.message));
}
