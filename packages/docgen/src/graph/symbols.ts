import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveImport } from '../util/modules.js';
import { readModuleBindings } from '../util/modules.js';
import { compareStrings } from '../util/sort.js';
import { loadPathAliases } from '../util/tsconfig.js';
import { literalString, parseSourceFile, positionOf, ts } from '../util/ts-ast.js';
import { toPosix } from '../util/paths.js';
import type { SourceRef } from '../types/core.js';
import { EvidenceGraphBuilder } from './builder.js';
import { graphEdgeId, graphNodeId } from './ids.js';
import type { EvidenceGraph, GraphNode, GraphProvenance } from './types.js';

type SymbolKind = 'function' | 'class' | 'interface' | 'method' | 'constructor';

interface SymbolRecord {
  readonly id: string;
  readonly file: string;
  readonly name: string;
  readonly qualifiedName: string;
  /** Qualified names of lexical parents, nearest parent last. */
  readonly scope: readonly string[];
  readonly kind: SymbolKind;
  readonly source: SourceRef;
  readonly node: ts.Node;
  readonly exportedNames: readonly string[];
  readonly isAsync: boolean;
}

interface ParsedModule {
  readonly file: string;
  readonly source: ts.SourceFile;
  readonly symbols: readonly SymbolRecord[];
  readonly symbolByNode: ReadonlyMap<ts.Node, SymbolRecord>;
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function isExported(node: ts.Node): boolean {
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) return true;
  if (ts.isVariableDeclaration(node)) {
    const statement = node.parent.parent;
    return ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword);
  }
  return false;
}

function isDefaultExport(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function isAsync(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.AsyncKeyword);
}

function symbolProvenance(source: SourceRef): GraphProvenance {
  return {
    origin: 'extracted',
    extractionMethods: ['ast'],
    certainty: 'high',
    evidence: [source],
  };
}

function symbolId(file: string, qualifiedName: string, kind: SymbolKind): string {
  return graphNodeId('symbol', `${file}#${kind}:${qualifiedName}`);
}

function analyseModule(file: string, contents: string): ParsedModule {
  const source = parseSourceFile(file, contents);
  const symbols: SymbolRecord[] = [];
  const symbolByNode = new Map<ts.Node, SymbolRecord>();

  const add = (args: {
    node: ts.Node;
    name: string;
    scope: readonly string[];
    kind: SymbolKind;
    exported?: boolean;
    defaultExport?: boolean;
    async?: boolean;
  }): SymbolRecord => {
    const qualifiedName = [...args.scope, args.name].join('.');
    const exportedNames = [
      ...(args.exported === true ? [args.name] : []),
      ...(args.defaultExport === true ? ['default'] : []),
    ];
    const record: SymbolRecord = {
      id: symbolId(file, qualifiedName, args.kind),
      file,
      name: args.name,
      qualifiedName,
      scope: args.scope,
      kind: args.kind,
      source: positionOf(source, args.node, file),
      node: args.node,
      exportedNames,
      isAsync: args.async === true,
    };
    symbols.push(record);
    symbolByNode.set(args.node, record);
    return record;
  };

  const visit = (node: ts.Node, scope: readonly string[]): void => {
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? (isDefaultExport(node) ? 'default' : undefined);
      if (name !== undefined) {
        const record = add({
          node,
          name,
          scope,
          kind: 'function',
          exported: isExported(node),
          defaultExport: isDefaultExport(node),
          async: isAsync(node),
        });
        node.forEachChild((child) => visit(child, [...scope, record.name]));
        return;
      }
    }

    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text ?? (isDefaultExport(node) ? 'default' : undefined);
      if (name !== undefined) {
        const record = add({
          node,
          name,
          scope,
          kind: 'class',
          exported: isExported(node),
          defaultExport: isDefaultExport(node),
        });
        node.forEachChild((child) => visit(child, [...scope, record.name]));
        return;
      }
    }

    if (ts.isInterfaceDeclaration(node)) {
      const record = add({
        node,
        name: node.name.text,
        scope,
        kind: 'interface',
        exported: isExported(node),
      });
      node.forEachChild((child) => visit(child, [...scope, record.name]));
      return;
    }

    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isConstructorDeclaration(node)) {
      const constructor = ts.isConstructorDeclaration(node);
      const name = constructor ? 'constructor' : propertyName(node.name);
      if (name !== undefined) {
        const record = add({
          node,
          name,
          scope,
          kind: constructor ? 'constructor' : 'method',
          async: isAsync(node),
        });
        node.forEachChild((child) => visit(child, [...scope, record.name]));
        return;
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const record = add({
        node,
        name: node.name.text,
        scope,
        kind: 'function',
        exported: isExported(node),
        async: isAsync(node.initializer),
      });
      node.initializer.forEachChild((child) => visit(child, [...scope, record.name]));
      return;
    }

    node.forEachChild((child) => visit(child, scope));
  };

  visit(source, []);

  // `export { local as public }` and `export default local` are separate AST
  // statements. Attach those names after declarations have been collected.
  const bindings = readModuleBindings(source);
  const withBindings = symbols.map((record) => {
    if (record.scope.length > 0) return record;
    const aliases = [...bindings.exports.entries()]
      .filter(([, binding]) => binding.kind === 'local' && binding.localName === record.name)
      .map(([name]) => name);
    if (aliases.length === 0) return record;
    const updated = { ...record, exportedNames: [...new Set([...record.exportedNames, ...aliases])].sort(compareStrings) };
    symbolByNode.set(record.node, updated);
    return updated;
  });

  return {
    file,
    source,
    symbols: withBindings.sort((a, b) => compareStrings(a.id, b.id)),
    symbolByNode,
  };
}

function nearestCaller(node: ts.Node, symbols: ReadonlyMap<ts.Node, SymbolRecord>): SymbolRecord | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    const symbol = symbols.get(current);
    if (symbol !== undefined && symbol.kind !== 'class') return symbol;
    current = current.parent;
  }
  return undefined;
}

function scopeIsVisible(candidate: SymbolRecord, caller: SymbolRecord): boolean {
  if (candidate.scope.length > caller.scope.length) return false;
  return candidate.scope.every((part, index) => caller.scope[index] === part);
}

function resolveLocalSymbol(
  module: ParsedModule,
  caller: SymbolRecord,
  name: string,
): SymbolRecord | undefined {
  const candidates = module.symbols
    .filter((symbol) => symbol.name === name && scopeIsVisible(symbol, caller))
    .sort((a, b) => b.scope.length - a.scope.length || compareStrings(a.id, b.id));
  const best = candidates[0];
  if (best === undefined) return undefined;
  if (candidates[1]?.scope.length === best.scope.length) return undefined;
  return best;
}

function bindingContainsName(name: ts.BindingName, expected: string): boolean {
  if (ts.isIdentifier(name)) return name.text === expected;
  return name.elements.some(
    (element) => ts.isBindingElement(element) && bindingContainsName(element.name, expected),
  );
}

/** Conservatively avoid resolving a top-level symbol through a local value binding. */
function hasLocalValueBinding(
  module: ParsedModule,
  caller: SymbolRecord,
  name: string,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== caller.node && module.symbolByNode.has(node)) return;
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) &&
      bindingContainsName(node.name, name) &&
      !module.symbolByNode.has(node)
    ) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  caller.node.forEachChild(visit);
  return found;
}

function resolveValueExpression(
  module: ParsedModule,
  caller: SymbolRecord,
  expression: ts.Expression,
  context: SymbolResolutionContext,
  kinds?: ReadonlySet<SymbolKind>,
): SymbolRecord | undefined {
  if (ts.isIdentifier(expression)) {
    if (hasLocalValueBinding(module, caller, expression.text)) return undefined;
    const local = resolveLocalSymbol(module, caller, expression.text);
    if (local !== undefined && (kinds === undefined || kinds.has(local.kind))) return local;
    return resolveTopLevelSymbol(module, expression.text, context, kinds);
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return resolveNamespaceMember(
      module,
      expression.expression.text,
      expression.name.text,
      context,
      kinds,
    );
  }
  return undefined;
}

function addSymbolNodes(builder: EvidenceGraphBuilder, modules: readonly ParsedModule[]): void {
  for (const module of modules) {
    const fileId = graphNodeId('file', module.file);
    const fileRef = { file: module.file, line: 1 };
    builder.addNode({ id: fileId, kind: 'file', label: module.file, provenance: symbolProvenance(fileRef) });

    const byQualifiedName = new Map(module.symbols.map((symbol) => [symbol.qualifiedName, symbol]));
    for (const symbol of module.symbols) {
      const provenance = symbolProvenance(symbol.source);
      builder.addNode({
        id: symbol.id,
        kind: 'symbol',
        label: symbol.qualifiedName,
        provenance,
        properties: {
          symbolKind: symbol.kind,
          name: symbol.name,
          exportedNames: symbol.exportedNames,
          isAsync: symbol.isAsync,
        },
      });
      builder.addEdge({
        id: graphEdgeId('defined-in', symbol.id, fileId),
        kind: 'defined-in',
        from: symbol.id,
        to: fileId,
        provenance,
      });

      const parentName = symbol.scope.join('.');
      const parent = parentName.length === 0 ? undefined : byQualifiedName.get(parentName);
      if (parent !== undefined) {
        builder.addEdge({
          id: graphEdgeId('contains', parent.id, symbol.id),
          kind: 'contains',
          from: parent.id,
          to: symbol.id,
          provenance,
        });
      }
    }
  }
}

function exportedSymbol(
  module: ParsedModule,
  name: string,
  kinds?: ReadonlySet<SymbolKind>,
): SymbolRecord | undefined {
  const matches = module.symbols.filter(
    (symbol) =>
      symbol.scope.length === 0 &&
      symbol.exportedNames.includes(name) &&
      (kinds === undefined || kinds.has(symbol.kind)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

interface SymbolResolutionContext {
  modules: readonly ParsedModule[];
  moduleByFile: ReadonlyMap<string, ParsedModule>;
  bindingsByFile: ReadonlyMap<string, ReturnType<typeof readModuleBindings>>;
  files: ReadonlySet<string>;
  aliases: Awaited<ReturnType<typeof loadPathAliases>>;
  outputFiles?: ReadonlySet<string>;
}

function emitsModule(context: SymbolResolutionContext, file: string): boolean {
  return context.outputFiles === undefined || context.outputFiles.has(file);
}

/** Follow explicit and star re-exports without guessing through ambiguity. */
function resolveExportedSymbol(
  file: string,
  name: string,
  context: SymbolResolutionContext,
  kinds?: ReadonlySet<SymbolKind>,
  seen: ReadonlySet<string> = new Set(),
): SymbolRecord | undefined {
  const key = `${file}#${name}`;
  if (seen.has(key) || seen.size >= 16) return undefined;
  const nextSeen = new Set(seen).add(key);
  const module = context.moduleByFile.get(file);
  if (module === undefined) return undefined;

  const direct = exportedSymbol(module, name, kinds);
  if (direct !== undefined) return direct;

  const bindings = context.bindingsByFile.get(file);
  const explicit = bindings?.exports.get(name);
  if (explicit?.kind === 'local') {
    const matches = module.symbols.filter(
      (symbol) =>
        symbol.scope.length === 0 &&
        symbol.name === explicit.localName &&
        (kinds === undefined || kinds.has(symbol.kind)),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (explicit?.kind === 'reexport') {
    const target = resolveImport(file, explicit.specifier, context.files, context.aliases);
    return target === undefined
      ? undefined
      : resolveExportedSymbol(target, explicit.importedName, context, kinds, nextSeen);
  }

  const candidates = new Map<string, SymbolRecord>();
  for (const specifier of bindings?.starExports ?? []) {
    const target = resolveImport(file, specifier, context.files, context.aliases);
    if (target === undefined) continue;
    const candidate = resolveExportedSymbol(target, name, context, kinds, nextSeen);
    if (candidate !== undefined) candidates.set(candidate.id, candidate);
  }
  return candidates.size === 1 ? [...candidates.values()][0] : undefined;
}

function resolveTopLevelSymbol(
  module: ParsedModule,
  name: string,
  context: SymbolResolutionContext,
  kinds?: ReadonlySet<SymbolKind>,
): SymbolRecord | undefined {
  const local = module.symbols.filter(
    (symbol) =>
      symbol.scope.length === 0 &&
      symbol.name === name &&
      (kinds === undefined || kinds.has(symbol.kind)),
  );
  if (local.length === 1) return local[0];
  if (local.length > 1) return undefined;

  const imported = context.bindingsByFile.get(module.file)?.imports.get(name);
  if (imported === undefined || imported.importedName === '*') return undefined;
  const targetFile = resolveImport(module.file, imported.specifier, context.files, context.aliases);
  return targetFile === undefined
    ? undefined
    : resolveExportedSymbol(targetFile, imported.importedName, context, kinds);
}

function resolveNamespaceMember(
  module: ParsedModule,
  namespace: string,
  member: string,
  context: SymbolResolutionContext,
  kinds?: ReadonlySet<SymbolKind>,
): SymbolRecord | undefined {
  const imported = context.bindingsByFile.get(module.file)?.imports.get(namespace);
  if (imported?.importedName !== '*') return undefined;
  const target = resolveImport(module.file, imported.specifier, context.files, context.aliases);
  return target === undefined ? undefined : resolveExportedSymbol(target, member, context, kinds);
}

function resolveTopLevelExpression(
  module: ParsedModule,
  expression: ts.Expression,
  context: SymbolResolutionContext,
  kinds?: ReadonlySet<SymbolKind>,
): SymbolRecord | undefined {
  if (ts.isIdentifier(expression)) {
    return resolveTopLevelSymbol(module, expression.text, context, kinds);
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return resolveNamespaceMember(
      module,
      expression.expression.text,
      expression.name.text,
      context,
      kinds,
    );
  }
  return undefined;
}

function addHeritageEdges(
  builder: EvidenceGraphBuilder,
  context: SymbolResolutionContext,
): void {
  const typeKinds = new Set<SymbolKind>(['class', 'interface']);
  for (const module of context.modules) {
    if (!emitsModule(context, module.file)) continue;
    for (const symbol of module.symbols) {
      if (!ts.isClassDeclaration(symbol.node) && !ts.isInterfaceDeclaration(symbol.node)) continue;
      for (const clause of symbol.node.heritageClauses ?? []) {
        const kind = clause.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends';
        for (const type of clause.types) {
          const target = resolveTopLevelExpression(module, type.expression, context, typeKinds);
          if (target === undefined || target.id === symbol.id) continue;
          const source = positionOf(module.source, type.expression, module.file);
          builder.addEdge({
            id: graphEdgeId(kind, symbol.id, target.id),
            kind,
            from: symbol.id,
            to: target.id,
            provenance: symbolProvenance(source),
          });
        }
      }
    }
  }
}

function typeNameOf(node: ts.TypeNode | undefined): string | undefined {
  if (node === undefined || !ts.isTypeReferenceNode(node)) return undefined;
  return ts.isIdentifier(node.typeName) ? node.typeName.text : undefined;
}

function constructedTypeName(node: ts.Expression | undefined): string | undefined {
  if (node === undefined || !ts.isNewExpression(node)) return undefined;
  return ts.isIdentifier(node.expression) ? node.expression.text : undefined;
}

function declarationTypeName(node: ts.ParameterDeclaration | ts.VariableDeclaration | ts.PropertyDeclaration): string | undefined {
  return typeNameOf(node.type) ?? constructedTypeName(node.initializer);
}

function functionLikeNode(symbol: SymbolRecord): ts.FunctionLikeDeclaration | undefined {
  if (
    ts.isFunctionDeclaration(symbol.node) ||
    ts.isMethodDeclaration(symbol.node) ||
    ts.isConstructorDeclaration(symbol.node)
  ) {
    return symbol.node;
  }
  if (
    ts.isVariableDeclaration(symbol.node) &&
    symbol.node.initializer !== undefined &&
    (ts.isArrowFunction(symbol.node.initializer) || ts.isFunctionExpression(symbol.node.initializer))
  ) {
    return symbol.node.initializer;
  }
  return undefined;
}

function identifierReceiverType(
  caller: SymbolRecord,
  name: string,
  beforePosition: number,
): string | undefined {
  const functionNode = functionLikeNode(caller);
  const parameter = functionNode?.parameters.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
  );
  if (parameter !== undefined) return declarationTypeName(parameter);

  const candidates: { position: number; typeName: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.getStart() <= beforePosition
    ) {
      const candidate = declarationTypeName(node);
      if (candidate !== undefined) candidates.push({ position: node.getStart(), typeName: candidate });
    }
    node.forEachChild(visit);
  };
  caller.node.forEachChild(visit);
  candidates.sort((a, b) => b.position - a.position || compareStrings(a.typeName, b.typeName));
  return candidates[0]?.typeName;
}

function enclosingClass(module: ParsedModule, caller: SymbolRecord): SymbolRecord | undefined {
  for (let length = caller.scope.length; length > 0; length -= 1) {
    const qualifiedName = caller.scope.slice(0, length).join('.');
    const match = module.symbols.find(
      (symbol) => symbol.qualifiedName === qualifiedName && symbol.kind === 'class',
    );
    if (match !== undefined) return match;
  }
  return undefined;
}

function classPropertyType(classSymbol: SymbolRecord, property: string): string | undefined {
  if (!ts.isClassDeclaration(classSymbol.node)) return undefined;
  for (const member of classSymbol.node.members) {
    if (ts.isPropertyDeclaration(member) && propertyName(member.name) === property) {
      return declarationTypeName(member);
    }
    if (ts.isConstructorDeclaration(member)) {
      const parameter = member.parameters.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === property,
      );
      if (parameter !== undefined) return declarationTypeName(parameter);
    }
  }
  return undefined;
}

function receiverTypeName(
  module: ParsedModule,
  caller: SymbolRecord,
  receiver: ts.Expression,
  beforePosition: number,
): string | undefined {
  if (ts.isIdentifier(receiver)) {
    return identifierReceiverType(caller, receiver.text, beforePosition);
  }
  if (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const owner = enclosingClass(module, caller);
    return owner === undefined ? undefined : classPropertyType(owner, receiver.name.text);
  }
  return constructedTypeName(receiver);
}

function methodOnType(
  module: ParsedModule,
  caller: SymbolRecord,
  receiver: ts.Expression,
  method: string,
  beforePosition: number,
  context: SymbolResolutionContext,
): SymbolRecord | undefined {
  const typeName = receiverTypeName(module, caller, receiver, beforePosition);
  if (typeName === undefined) return undefined;
  const owner = resolveTopLevelSymbol(
    module,
    typeName,
    context,
    new Set<SymbolKind>(['class', 'interface']),
  );
  if (owner === undefined) return undefined;
  const targetModule = context.moduleByFile.get(owner.file);
  if (targetModule === undefined) return undefined;
  const matches = targetModule.symbols.filter(
    (symbol) => symbol.kind === 'method' && symbol.scope.join('.') === owner.qualifiedName && symbol.name === method,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function addCallEdges(builder: EvidenceGraphBuilder, context: SymbolResolutionContext): void {
  for (const module of context.modules) {
    if (!emitsModule(context, module.file)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const caller = nearestCaller(node, module.symbolByNode);
        if (caller !== undefined) {
          let target: SymbolRecord | undefined;
          if (ts.isIdentifier(node.expression)) {
            target = resolveValueExpression(module, caller, node.expression, context);
          } else if (ts.isPropertyAccessExpression(node.expression)) {
            if (node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
              target = resolveLocalSymbol(module, caller, node.expression.name.text);
            }
            if (ts.isIdentifier(node.expression.expression)) {
              target ??= resolveNamespaceMember(
                module,
                node.expression.expression.text,
                node.expression.name.text,
                context,
              );
            }
            target ??= methodOnType(
              module,
              caller,
              node.expression.expression,
              node.expression.name.text,
              node.getStart(),
              context,
            );
          }

          if (target !== undefined && target.id !== caller.id) {
            const source = positionOf(module.source, node.expression, module.file);
            builder.addEdge({
              id: graphEdgeId('calls', caller.id, target.id),
              kind: 'calls',
              from: caller.id,
              to: target.id,
              provenance: symbolProvenance(source),
            });
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(module.source);
  }
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent)) &&
      parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node)
  );
}

function isInsideTypeOrModuleBinding(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isStatement(current) && !ts.isSourceFile(current)) {
    if (ts.isTypeNode(current)) return true;
    if (
      ts.isImportClause(current) ||
      ts.isImportSpecifier(current) ||
      ts.isNamespaceImport(current) ||
      ts.isExportSpecifier(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isExistingRelationshipExpression(node: ts.Expression): boolean {
  const parent = node.parent;
  return (
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) ||
    ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === node) ||
    (ts.isExpressionWithTypeArguments(parent) && parent.expression === node)
  );
}

/** Add non-call value uses such as callbacks, factories, and returned implementations. */
function addValueReferenceEdges(builder: EvidenceGraphBuilder, context: SymbolResolutionContext): void {
  for (const module of context.modules) {
    if (!emitsModule(context, module.file)) continue;
    const add = (expression: ts.Expression): void => {
      if (isExistingRelationshipExpression(expression) || isInsideTypeOrModuleBinding(expression)) return;
      const caller = nearestCaller(expression, module.symbolByNode);
      if (caller === undefined) return;
      const target = resolveValueExpression(module, caller, expression, context);
      if (target === undefined || target.id === caller.id) return;
      const source = positionOf(module.source, expression, module.file);
      builder.addEdge({
        id: graphEdgeId('references-symbol', caller.id, target.id),
        kind: 'references-symbol',
        from: caller.id,
        to: target.id,
        provenance: symbolProvenance(source),
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node) add(node);
        return;
      }
      if (ts.isIdentifier(node)) {
        if (
          !isDeclarationName(node) &&
          !ts.isPropertyAccessExpression(node.parent) &&
          !ts.isQualifiedName(node.parent)
        ) {
          add(node);
        }
      }
      node.forEachChild(visit);
    };
    visit(module.source);
  }
}

const PRISMA_OPERATIONS: ReadonlySet<string> = new Set([
  'aggregate',
  'count',
  'create',
  'createMany',
  'delete',
  'deleteMany',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'groupBy',
  'update',
  'updateMany',
  'upsert',
]);

function isPrismaClientType(
  module: ParsedModule,
  node: ts.TypeNode | undefined,
  context: SymbolResolutionContext,
): boolean {
  if (node === undefined || !ts.isTypeReferenceNode(node)) return false;
  if (ts.isIdentifier(node.typeName)) {
    const binding = context.bindingsByFile.get(module.file)?.imports.get(node.typeName.text);
    if (binding?.specifier === '@prisma/client' && binding.importedName === 'PrismaClient') {
      return true;
    }
    const target = resolveTopLevelSymbol(
      module,
      node.typeName.text,
      context,
      new Set<SymbolKind>(['class']),
    );
    return target !== undefined && symbolExtendsPrismaClient(target, context);
  }
  if (ts.isQualifiedName(node.typeName) && ts.isIdentifier(node.typeName.left)) {
    const binding = context.bindingsByFile.get(module.file)?.imports.get(node.typeName.left.text);
    if (
      binding?.specifier === '@prisma/client' &&
      binding.importedName === '*' &&
      node.typeName.right.text === 'PrismaClient'
    ) {
      return true;
    }
    const target = resolveNamespaceMember(
      module,
      node.typeName.left.text,
      node.typeName.right.text,
      context,
      new Set<SymbolKind>(['class']),
    );
    return target !== undefined && symbolExtendsPrismaClient(target, context);
  }
  return false;
}

function directPrismaClientClass(
  module: ParsedModule,
  expression: ts.Expression,
  context: SymbolResolutionContext,
): boolean {
  if (ts.isIdentifier(expression)) {
    const binding = context.bindingsByFile.get(module.file)?.imports.get(expression.text);
    return binding?.specifier === '@prisma/client' && binding.importedName === 'PrismaClient';
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const binding = context.bindingsByFile.get(module.file)?.imports.get(expression.expression.text);
    return (
      binding?.specifier === '@prisma/client' &&
      binding.importedName === '*' &&
      expression.name.text === 'PrismaClient'
    );
  }
  return false;
}

function symbolExtendsPrismaClient(
  symbol: SymbolRecord,
  context: SymbolResolutionContext,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (seen.has(symbol.id) || !ts.isClassDeclaration(symbol.node)) return false;
  const module = context.moduleByFile.get(symbol.file);
  if (module === undefined) return false;
  const nextSeen = new Set(seen).add(symbol.id);
  for (const clause of symbol.node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) {
      if (directPrismaClientClass(module, type.expression, context)) return true;
      const target = resolveTopLevelExpression(
        module,
        type.expression,
        context,
        new Set<SymbolKind>(['class']),
      );
      if (target !== undefined && symbolExtendsPrismaClient(target, context, nextSeen)) return true;
    }
  }
  return false;
}

function isPrismaClientConstruction(
  module: ParsedModule,
  expression: ts.Expression | undefined,
  context: SymbolResolutionContext,
): boolean {
  if (expression === undefined || !ts.isNewExpression(expression)) return false;
  if (ts.isIdentifier(expression.expression)) {
    const binding = context.bindingsByFile.get(module.file)?.imports.get(expression.expression.text);
    return binding?.specifier === '@prisma/client' && binding.importedName === 'PrismaClient';
  }
  if (
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression)
  ) {
    const binding = context.bindingsByFile
      .get(module.file)
      ?.imports.get(expression.expression.expression.text);
    return (
      binding?.specifier === '@prisma/client' &&
      binding.importedName === '*' &&
      expression.expression.name.text === 'PrismaClient'
    );
  }
  return false;
}

function declarationIsPrismaClient(
  module: ParsedModule,
  declaration: ts.VariableDeclaration | ts.ParameterDeclaration | ts.PropertyDeclaration,
  context: SymbolResolutionContext,
): boolean {
  return (
    isPrismaClientType(module, declaration.type, context) ||
    isPrismaClientConstruction(module, declaration.initializer, context)
  );
}

function topLevelPrismaClient(
  module: ParsedModule,
  name: string,
  context: SymbolResolutionContext,
): boolean {
  for (const statement of module.source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declarationIsPrismaClient(module, declaration, context)
      ) {
        return true;
      }
    }
  }
  return false;
}

function exportedPrismaClient(
  file: string,
  exportedName: string,
  context: SymbolResolutionContext,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const key = `${file}#${exportedName}`;
  if (seen.has(key) || seen.size >= 16) return false;
  const module = context.moduleByFile.get(file);
  const bindings = context.bindingsByFile.get(file);
  if (module === undefined || bindings === undefined) return false;
  const nextSeen = new Set(seen).add(key);
  const binding = bindings.exports.get(exportedName);
  if (binding?.kind === 'local') return topLevelPrismaClient(module, binding.localName, context);
  if (binding?.kind === 'reexport') {
    const target = resolveImport(file, binding.specifier, context.files, context.aliases);
    return (
      target !== undefined &&
      exportedPrismaClient(target, binding.importedName, context, nextSeen)
    );
  }
  if (topLevelPrismaClient(module, exportedName, context)) return true;
  const candidates = bindings.starExports.filter((specifier) => {
    const target = resolveImport(file, specifier, context.files, context.aliases);
    return target !== undefined && exportedPrismaClient(target, exportedName, context, nextSeen);
  });
  return candidates.length === 1;
}

function identifierIsPrismaClient(
  module: ParsedModule,
  caller: SymbolRecord,
  name: string,
  context: SymbolResolutionContext,
): boolean {
  const functionNode = functionLikeNode(caller);
  for (const parameter of functionNode?.parameters ?? []) {
    if (
      ts.isIdentifier(parameter.name) &&
      parameter.name.text === name &&
      declarationIsPrismaClient(module, parameter, context)
    ) {
      return true;
    }
  }
  let local = false;
  const visit = (node: ts.Node): void => {
    if (local || (node !== caller.node && module.symbolByNode.has(node))) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      declarationIsPrismaClient(module, node, context)
    ) {
      local = true;
      return;
    }
    node.forEachChild(visit);
  };
  caller.node.forEachChild(visit);
  if (local || topLevelPrismaClient(module, name, context)) return true;
  const imported = context.bindingsByFile.get(module.file)?.imports.get(name);
  if (imported === undefined || imported.importedName === '*') return false;
  const target = resolveImport(module.file, imported.specifier, context.files, context.aliases);
  return target !== undefined && exportedPrismaClient(target, imported.importedName, context);
}

function receiverIsPrismaClient(
  module: ParsedModule,
  caller: SymbolRecord,
  receiver: ts.Expression,
  context: SymbolResolutionContext,
): boolean {
  if (ts.isIdentifier(receiver)) {
    return identifierIsPrismaClient(module, caller, receiver.text, context);
  }
  if (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const owner = enclosingClass(module, caller);
    if (owner === undefined || !ts.isClassDeclaration(owner.node)) return false;
    for (const member of owner.node.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        propertyName(member.name) === receiver.name.text &&
        declarationIsPrismaClient(module, member, context)
      ) {
        return true;
      }
      if (ts.isConstructorDeclaration(member)) {
        const parameter = member.parameters.find(
          (candidate) =>
            ts.isIdentifier(candidate.name) && candidate.name.text === receiver.name.text,
        );
        if (parameter !== undefined && declarationIsPrismaClient(module, parameter, context)) {
          return true;
        }
      }
    }
  }
  return false;
}

function prismaSchemaCandidates(graph: EvidenceGraph, model: string): readonly GraphNode[] {
  const key = model.toLocaleLowerCase('en-US');
  return graph.nodes.filter((node) => {
    if (node.kind !== 'schema') return false;
    if (!node.provenance.evidence.some((ref) => ref.file.endsWith('.prisma'))) return false;
    const modelName = typeof node.properties?.modelName === 'string' ? node.properties.modelName : undefined;
    return [node.label, modelName]
      .filter((value): value is string => value !== undefined)
      .some((value) => value.toLocaleLowerCase('en-US') === key);
  });
}

function addPrismaAccessEdges(
  builder: EvidenceGraphBuilder,
  graph: EvidenceGraph,
  context: SymbolResolutionContext,
): void {
  for (const module of context.modules) {
    if (!emitsModule(context, module.file)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        PRISMA_OPERATIONS.has(node.expression.name.text) &&
        ts.isPropertyAccessExpression(node.expression.expression)
      ) {
        const caller = nearestCaller(node, module.symbolByNode);
        const delegate = node.expression.expression;
        if (
          caller !== undefined &&
          receiverIsPrismaClient(module, caller, delegate.expression, context)
        ) {
          const candidates = prismaSchemaCandidates(graph, delegate.name.text);
          const source = positionOf(module.source, delegate.name, module.file);
          if (candidates.length === 1) {
            const target = candidates[0];
            if (target !== undefined) {
              builder.addEdge({
                id: graphEdgeId(
                  'references',
                  caller.id,
                  target.id,
                  `database:prisma:${node.expression.name.text}`,
                ),
                kind: 'references',
                from: caller.id,
                to: target.id,
                provenance: symbolProvenance(source),
                properties: {
                  referenceKind: 'database-access',
                  orm: 'prisma',
                  operation: node.expression.name.text,
                  model: delegate.name.text,
                },
              });
            }
          } else {
            builder.addGap({
              extractor: 'symbol',
              kind: candidates.length === 0 ? 'database-model-unresolved' : 'database-model-ambiguous',
              message:
                candidates.length === 0
                  ? `Prisma delegate '${delegate.name.text}' did not match an extracted Prisma model.`
                  : `Prisma delegate '${delegate.name.text}' matched ${candidates.length} extracted Prisma models.`,
              source,
            });
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(module.source);
  }
}

interface QueueDescriptor {
  readonly runtime: 'amqplib' | 'bull' | 'bullmq';
  readonly channel?: string;
}

function queueConstruction(
  module: ParsedModule,
  expression: ts.Expression | undefined,
  context: SymbolResolutionContext,
): QueueDescriptor | undefined {
  if (expression === undefined || !ts.isNewExpression(expression)) return undefined;
  if (!ts.isIdentifier(expression.expression)) return undefined;
  const binding = context.bindingsByFile.get(module.file)?.imports.get(expression.expression.text);
  let runtime: QueueDescriptor['runtime'] | undefined;
  if (binding?.specifier === 'bullmq' && binding.importedName === 'Queue') runtime = 'bullmq';
  if (binding?.specifier === 'bull' && binding.importedName === 'default') runtime = 'bull';
  if (runtime === undefined) return undefined;
  const channel = literalString(expression.arguments?.[0]);
  return { runtime, ...(channel === undefined ? {} : { channel }) };
}

function topLevelQueue(
  module: ParsedModule,
  name: string,
  context: SymbolResolutionContext,
): QueueDescriptor | undefined {
  for (const statement of module.source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        const descriptor = queueConstruction(module, declaration.initializer, context);
        if (descriptor !== undefined) return descriptor;
      }
    }
  }
  return undefined;
}

function exportedQueue(
  file: string,
  exportedName: string,
  context: SymbolResolutionContext,
  seen: ReadonlySet<string> = new Set(),
): QueueDescriptor | undefined {
  const key = `${file}#${exportedName}`;
  if (seen.has(key) || seen.size >= 16) return undefined;
  const module = context.moduleByFile.get(file);
  const bindings = context.bindingsByFile.get(file);
  if (module === undefined || bindings === undefined) return undefined;
  const nextSeen = new Set(seen).add(key);
  const binding = bindings.exports.get(exportedName);
  if (binding?.kind === 'local') return topLevelQueue(module, binding.localName, context);
  if (binding?.kind === 'reexport') {
    const target = resolveImport(file, binding.specifier, context.files, context.aliases);
    return target === undefined
      ? undefined
      : exportedQueue(target, binding.importedName, context, nextSeen);
  }
  const direct = topLevelQueue(module, exportedName, context);
  if (direct !== undefined) return direct;
  const candidates = bindings.starExports
    .map((specifier) => {
      const target = resolveImport(file, specifier, context.files, context.aliases);
      return target === undefined ? undefined : exportedQueue(target, exportedName, context, nextSeen);
    })
    .filter((value): value is QueueDescriptor => value !== undefined);
  if (candidates.length !== 1) return undefined;
  return candidates[0];
}

function identifierQueue(
  module: ParsedModule,
  caller: SymbolRecord,
  name: string,
  context: SymbolResolutionContext,
): QueueDescriptor | undefined {
  let local: QueueDescriptor | undefined;
  const visit = (node: ts.Node): void => {
    if (local !== undefined || (node !== caller.node && module.symbolByNode.has(node))) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      local = queueConstruction(module, node.initializer, context);
      if (local !== undefined) return;
    }
    node.forEachChild(visit);
  };
  caller.node.forEachChild(visit);
  if (local !== undefined) return local;
  const direct = topLevelQueue(module, name, context);
  if (direct !== undefined) return direct;
  const imported = context.bindingsByFile.get(module.file)?.imports.get(name);
  if (imported === undefined || imported.importedName === '*') return undefined;
  const target = resolveImport(module.file, imported.specifier, context.files, context.aliases);
  return target === undefined ? undefined : exportedQueue(target, imported.importedName, context);
}

function queueReceiver(
  module: ParsedModule,
  caller: SymbolRecord,
  receiver: ts.Expression,
  context: SymbolResolutionContext,
): QueueDescriptor | undefined {
  if (ts.isIdentifier(receiver)) return identifierQueue(module, caller, receiver.text, context);
  if (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const owner = enclosingClass(module, caller);
    if (owner === undefined || !ts.isClassDeclaration(owner.node)) return undefined;
    for (const member of owner.node.members) {
      if (ts.isPropertyDeclaration(member) && propertyName(member.name) === receiver.name.text) {
        const descriptor = queueConstruction(module, member.initializer, context);
        if (descriptor !== undefined) return descriptor;
      }
    }
  }
  return undefined;
}

function queueConsumerJobs(
  graph: EvidenceGraph,
  descriptor: QueueDescriptor,
): readonly GraphNode[] {
  if (descriptor.channel === undefined) return [];
  return graph.nodes.filter((node) => {
    const properties = node.properties;
    return (
      node.kind === 'job' &&
      properties !== undefined &&
      properties.channel === descriptor.channel &&
      properties.runtime === descriptor.runtime &&
      properties.jobKind === 'queue-consumer'
    );
  });
}

function addQueueProducerEdges(
  builder: EvidenceGraphBuilder,
  graph: EvidenceGraph,
  context: SymbolResolutionContext,
): void {
  for (const module of context.modules) {
    if (!emitsModule(context, module.file)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'add'
      ) {
        const caller = nearestCaller(node, module.symbolByNode);
        if (caller !== undefined) {
          const descriptor = queueReceiver(module, caller, node.expression.expression, context);
          if (descriptor !== undefined) {
            const source = positionOf(module.source, node.expression, module.file);
            if (descriptor.channel === undefined) {
              builder.addGap({
                extractor: 'symbol',
                kind: 'queue-channel-unresolved',
                message: `A proven ${descriptor.runtime} queue publishes with a non-literal channel name.`,
                source,
              });
            } else {
              const jobName = literalString(node.arguments[0]);
              for (const job of queueConsumerJobs(graph, descriptor)) {
                builder.addEdge({
                  id: graphEdgeId(
                    'references',
                    caller.id,
                    job.id,
                    `queue-producer:${descriptor.runtime}:${descriptor.channel}`,
                  ),
                  kind: 'references',
                  from: caller.id,
                  to: job.id,
                  provenance: symbolProvenance(source),
                  properties: {
                    referenceKind: 'queue-producer',
                    runtime: descriptor.runtime,
                    channel: descriptor.channel,
                    operation: 'add',
                    ...(jobName === undefined ? {} : { jobName }),
                  },
                });
              }
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(module.source);
  }
}

function unwrapAwait(expression: ts.Expression | undefined): ts.Expression | undefined {
  return expression !== undefined && ts.isAwaitExpression(expression)
    ? expression.expression
    : expression;
}

function amqpConnectionConstruction(
  module: ParsedModule,
  expression: ts.Expression | undefined,
  context: SymbolResolutionContext,
): boolean {
  const value = unwrapAwait(expression);
  if (
    value === undefined ||
    !ts.isCallExpression(value) ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== 'connect' ||
    !ts.isIdentifier(value.expression.expression)
  ) {
    return false;
  }
  const binding = context.bindingsByFile
    .get(module.file)
    ?.imports.get(value.expression.expression.text);
  return binding?.specifier === 'amqplib';
}

function topLevelAmqpConnection(
  module: ParsedModule,
  name: string,
  context: SymbolResolutionContext,
): boolean {
  for (const statement of module.source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        amqpConnectionConstruction(module, declaration.initializer, context)
      ) {
        return true;
      }
    }
  }
  return false;
}

function identifierIsAmqpConnection(
  module: ParsedModule,
  caller: SymbolRecord | undefined,
  name: string,
  context: SymbolResolutionContext,
): boolean {
  let local = false;
  const visit = (node: ts.Node): void => {
    if (local || (caller !== undefined && node !== caller.node && module.symbolByNode.has(node))) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      amqpConnectionConstruction(module, node.initializer, context)
    ) {
      local = true;
      return;
    }
    node.forEachChild(visit);
  };
  if (caller !== undefined) caller.node.forEachChild(visit);
  return local || topLevelAmqpConnection(module, name, context);
}

function amqpChannelConstruction(
  module: ParsedModule,
  caller: SymbolRecord | undefined,
  expression: ts.Expression | undefined,
  context: SymbolResolutionContext,
): boolean {
  const value = unwrapAwait(expression);
  if (
    value === undefined ||
    !ts.isCallExpression(value) ||
    !ts.isPropertyAccessExpression(value.expression) ||
    value.expression.name.text !== 'createChannel' ||
    !ts.isIdentifier(value.expression.expression)
  ) {
    return false;
  }
  return identifierIsAmqpConnection(module, caller, value.expression.expression.text, context);
}

function topLevelAmqpChannel(
  module: ParsedModule,
  name: string,
  context: SymbolResolutionContext,
): boolean {
  for (const statement of module.source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        amqpChannelConstruction(module, undefined, declaration.initializer, context)
      ) {
        return true;
      }
    }
  }
  return false;
}

function exportedAmqpChannel(
  file: string,
  exportedName: string,
  context: SymbolResolutionContext,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  const key = `${file}#${exportedName}`;
  if (seen.has(key) || seen.size >= 16) return false;
  const module = context.moduleByFile.get(file);
  const bindings = context.bindingsByFile.get(file);
  if (module === undefined || bindings === undefined) return false;
  const nextSeen = new Set(seen).add(key);
  const binding = bindings.exports.get(exportedName);
  if (binding?.kind === 'local') return topLevelAmqpChannel(module, binding.localName, context);
  if (binding?.kind === 'reexport') {
    const target = resolveImport(file, binding.specifier, context.files, context.aliases);
    return target !== undefined && exportedAmqpChannel(target, binding.importedName, context, nextSeen);
  }
  if (topLevelAmqpChannel(module, exportedName, context)) return true;
  const candidates = bindings.starExports.filter((specifier) => {
    const target = resolveImport(file, specifier, context.files, context.aliases);
    return target !== undefined && exportedAmqpChannel(target, exportedName, context, nextSeen);
  });
  return candidates.length === 1;
}

function receiverIsAmqpChannel(
  module: ParsedModule,
  caller: SymbolRecord,
  receiver: ts.Expression,
  context: SymbolResolutionContext,
): boolean {
  if (!ts.isIdentifier(receiver)) return false;
  let local = false;
  const visit = (node: ts.Node): void => {
    if (local || (node !== caller.node && module.symbolByNode.has(node))) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === receiver.text &&
      amqpChannelConstruction(module, caller, node.initializer, context)
    ) {
      local = true;
      return;
    }
    node.forEachChild(visit);
  };
  caller.node.forEachChild(visit);
  if (local || topLevelAmqpChannel(module, receiver.text, context)) return true;
  const imported = context.bindingsByFile.get(module.file)?.imports.get(receiver.text);
  if (imported === undefined || imported.importedName === '*') return false;
  const target = resolveImport(module.file, imported.specifier, context.files, context.aliases);
  return target !== undefined && exportedAmqpChannel(target, imported.importedName, context);
}

function addAmqpProducerEdges(
  builder: EvidenceGraphBuilder,
  graph: EvidenceGraph,
  context: SymbolResolutionContext,
): void {
  for (const module of context.modules) {
    if (!emitsModule(context, module.file)) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'sendToQueue'
      ) {
        const caller = nearestCaller(node, module.symbolByNode);
        if (
          caller !== undefined &&
          receiverIsAmqpChannel(module, caller, node.expression.expression, context)
        ) {
          const source = positionOf(module.source, node.expression, module.file);
          const channel = literalString(node.arguments[0]);
          if (channel === undefined) {
            builder.addGap({
              extractor: 'symbol',
              kind: 'queue-channel-unresolved',
              message: 'A proven amqplib channel publishes with a non-literal queue name.',
              source,
            });
          } else {
            const descriptor: QueueDescriptor = { runtime: 'amqplib', channel };
            for (const job of queueConsumerJobs(graph, descriptor)) {
              builder.addEdge({
                id: graphEdgeId(
                  'references',
                  caller.id,
                  job.id,
                  `queue-producer:amqplib:${channel}`,
                ),
                kind: 'references',
                from: caller.id,
                to: job.id,
                provenance: symbolProvenance(source),
                properties: {
                  referenceKind: 'queue-producer',
                  runtime: 'amqplib',
                  channel,
                  operation: 'sendToQueue',
                },
              });
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(module.source);
  }
}

function addReferenceEdges(builder: EvidenceGraphBuilder, context: SymbolResolutionContext): void {
  const classKinds = new Set<SymbolKind>(['class']);
  const componentKinds = new Set<SymbolKind>(['function', 'class']);
  for (const module of context.modules) {
    if (!emitsModule(context, module.file)) continue;
    const add = (
      node: ts.Node,
      expression: ts.Expression,
      kind: 'instantiates' | 'references-symbol',
      kinds: ReadonlySet<SymbolKind>,
    ): void => {
      const caller = nearestCaller(node, module.symbolByNode);
      if (caller === undefined) return;
      const target = resolveTopLevelExpression(module, expression, context, kinds);
      if (target === undefined || target.id === caller.id) return;
      const source = positionOf(module.source, expression, module.file);
      builder.addEdge({
        id: graphEdgeId(kind, caller.id, target.id),
        kind,
        from: caller.id,
        to: target.id,
        provenance: symbolProvenance(source),
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        add(node, node.expression, 'instantiates', classKinds);
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        if (ts.isIdentifier(tag)) {
          add(node, tag, 'references-symbol', componentKinds);
        } else if (ts.isPropertyAccessExpression(tag)) {
          add(node, tag, 'references-symbol', componentKinds);
        }
      }
      node.forEachChild(visit);
    };
    visit(module.source);
  }
}

/** Replace coarse file-only handler/component evidence with a symbol link when unique. */
function addExtractedSymbolLinks(
  builder: EvidenceGraphBuilder,
  graph: EvidenceGraph,
  context: SymbolResolutionContext,
): void {
  for (const edge of graph.edges) {
    if (edge.kind !== 'handled-by' && edge.kind !== 'implemented-by') continue;
    const target = graph.nodes.find((node) => node.id === edge.to);
    if (target?.kind !== 'file') continue;
    const module = context.moduleByFile.get(target.label);
    if (module === undefined) continue;
    const evidence = edge.provenance.evidence.find((ref) => ref.file === module.file);

    let candidates: readonly SymbolRecord[];
    if (edge.kind === 'handled-by') {
      candidates = module.symbols.filter(
        (symbol) =>
          (symbol.kind === 'function' || symbol.kind === 'method') &&
          evidence?.line !== undefined &&
          symbol.source.line === evidence.line,
      );
    } else {
      candidates = module.symbols.filter(
        (symbol) =>
          symbol.scope.length === 0 &&
          (symbol.kind === 'function' || symbol.kind === 'class') &&
          symbol.exportedNames.includes('default'),
      );
    }
    if (candidates.length !== 1) continue;
    const symbol = candidates[0];
    if (symbol === undefined) continue;
    builder.addEdge({
      id: graphEdgeId(edge.kind, edge.from, symbol.id, 'resolved-symbol'),
      kind: edge.kind,
      from: edge.from,
      to: symbol.id,
      provenance: edge.provenance,
      properties: { resolution: 'symbol' },
    });
  }
}

export interface TypeScriptSymbolOptions {
  readonly graph: EvidenceGraph;
  readonly root: string;
  readonly exclude: readonly string[];
  readonly partitionFiles?: ReadonlySet<string>;
}

/** Add symbol definitions and statically provable calls to an existing graph. */
export async function enrichGraphWithTypeScriptSymbols(
  options: TypeScriptSymbolOptions,
): Promise<EvidenceGraph> {
  const files = (
    await fg(['**/*.{ts,tsx,js,jsx,mjs,cjs}'], {
      cwd: options.root,
      ignore: [...options.exclude],
      onlyFiles: true,
    })
  )
    .map(toPosix)
    .sort(compareStrings);

  const modules: ParsedModule[] = [];
  for (const file of files) {
    try {
      modules.push(analyseModule(file, await fs.readFile(path.join(options.root, file), 'utf8')));
    } catch {
      // Other extractors follow the same read-failure policy: a file that
      // disappears during a scan is skipped rather than crashing the run.
    }
  }

  const builder = new EvidenceGraphBuilder();
  for (const node of options.graph.nodes) builder.addNode(node);
  for (const edge of options.graph.edges) builder.addEdge(edge);
  for (const gap of options.graph.gaps) builder.addGap(gap);

  addSymbolNodes(
    builder,
    options.partitionFiles === undefined
      ? modules
      : modules.filter((module) => options.partitionFiles?.has(module.file) === true),
  );
  const context: SymbolResolutionContext = {
    modules,
    moduleByFile: new Map(modules.map((module) => [module.file, module])),
    bindingsByFile: new Map(modules.map((module) => [module.file, readModuleBindings(module.source)])),
    files: new Set(files),
    aliases: await loadPathAliases(options.root),
    ...(options.partitionFiles === undefined ? {} : { outputFiles: options.partitionFiles }),
  };
  addExtractedSymbolLinks(builder, options.graph, context);
  addHeritageEdges(builder, context);
  addCallEdges(builder, context);
  addReferenceEdges(builder, context);
  addValueReferenceEdges(builder, context);
  addPrismaAccessEdges(builder, options.graph, context);
  addQueueProducerEdges(builder, options.graph, context);
  addAmqpProducerEdges(builder, options.graph, context);
  return builder.build();
}
