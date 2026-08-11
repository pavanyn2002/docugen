import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import { compareStrings } from '../util/sort.js';
import { toPosix } from '../util/paths.js';
import { EvidenceGraphBuilder } from './builder.js';
import { graphEdgeId, graphNodeId } from './ids.js';
import type { EvidenceGraph, GraphNode, GraphProvenance } from './types.js';

type PythonSymbolKind = 'function' | 'class' | 'method' | 'constructor';

interface PythonSymbol {
  readonly id: string;
  readonly file: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly scope: readonly string[];
  readonly kind: PythonSymbolKind;
  readonly node: Parser.SyntaxNode;
  readonly line: number;
  readonly column: number;
  /** Includes decorators, allowing extracted route evidence to resolve to the definition. */
  readonly fullStartLine: number;
}

interface PythonImportBinding {
  readonly localName: string;
  readonly moduleSpecifier: string;
  readonly importedName?: string;
}

interface PythonModule {
  readonly file: string;
  readonly root: Parser.SyntaxNode;
  readonly symbols: readonly PythonSymbol[];
  readonly symbolByNodeId: ReadonlyMap<number, PythonSymbol>;
  readonly imports: ReadonlyMap<string, PythonImportBinding>;
}

interface PythonResolutionContext {
  readonly modules: readonly PythonModule[];
  readonly moduleByFile: ReadonlyMap<string, PythonModule>;
  readonly filesByModuleName: ReadonlyMap<string, readonly string[]>;
  readonly outputFiles?: ReadonlySet<string>;
}

function emitsModule(context: PythonResolutionContext, file: string): boolean {
  return context.outputFiles === undefined || context.outputFiles.has(file);
}

function provenance(file: string, line: number, column = 1): GraphProvenance {
  return {
    origin: 'extracted',
    extractionMethods: ['ast'],
    certainty: 'high',
    evidence: [{ file, line, column }],
  };
}

function definitionNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
  return node.parent?.type === 'decorated_definition' ? node.parent : node;
}

function importPart(node: Parser.SyntaxNode): { readonly name: string; readonly alias?: string } {
  if (node.type !== 'aliased_import') return { name: node.text };
  const name = node.childForFieldName('name')?.text ?? '';
  const alias = node.childForFieldName('alias')?.text;
  return { name, ...(alias === undefined ? {} : { alias }) };
}

function readImports(root: Parser.SyntaxNode): ReadonlyMap<string, PythonImportBinding> {
  const bindings = new Map<string, PythonImportBinding>();
  for (const statement of root.namedChildren) {
    if (statement.type === 'import_from_statement') {
      const moduleSpecifier = statement.childForFieldName('module_name')?.text;
      if (moduleSpecifier === undefined) continue;
      for (const node of statement.childrenForFieldName('name')) {
        const part = importPart(node);
        if (part.name === '' || part.name === '*') continue;
        const importedName = part.name.split('.').at(-1);
        if (importedName === undefined) continue;
        const localName = part.alias ?? importedName;
        bindings.set(localName, { localName, moduleSpecifier, importedName });
      }
      continue;
    }
    if (statement.type !== 'import_statement') continue;
    for (const node of statement.childrenForFieldName('name')) {
      const part = importPart(node);
      if (part.name === '') continue;
      const localName = part.alias ?? part.name.split('.')[0];
      if (localName === undefined) continue;
      bindings.set(localName, { localName, moduleSpecifier: part.name });
    }
  }
  return bindings;
}

function analysePythonModule(file: string, root: Parser.SyntaxNode): PythonModule {
  const symbols: PythonSymbol[] = [];
  const symbolByNodeId = new Map<number, PythonSymbol>();

  const visit = (
    node: Parser.SyntaxNode,
    scope: readonly string[],
    directClass?: string,
  ): void => {
    if (node.type === 'class_definition') {
      const name = node.childForFieldName('name')?.text;
      if (name !== undefined) {
        const qualifiedName = [...scope, name].join('.');
        const start = definitionNode(node).startPosition;
        const symbol: PythonSymbol = {
          id: graphNodeId('symbol', `${file}#class:${qualifiedName}`),
          file,
          name,
          qualifiedName,
          scope,
          kind: 'class',
          node,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          fullStartLine: start.row + 1,
        };
        symbols.push(symbol);
        symbolByNodeId.set(node.id, symbol);
        const body = node.childForFieldName('body');
        for (const child of body?.namedChildren ?? []) visit(child, [...scope, name], qualifiedName);
        return;
      }
    }
    if (node.type === 'function_definition') {
      const name = node.childForFieldName('name')?.text;
      if (name !== undefined) {
        const qualifiedName = [...scope, name].join('.');
        const kind: PythonSymbolKind =
          directClass === undefined ? 'function' : name === '__init__' ? 'constructor' : 'method';
        const start = definitionNode(node).startPosition;
        const symbol: PythonSymbol = {
          id: graphNodeId('symbol', `${file}#${kind}:${qualifiedName}`),
          file,
          name,
          qualifiedName,
          scope,
          kind,
          node,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          fullStartLine: start.row + 1,
        };
        symbols.push(symbol);
        symbolByNodeId.set(node.id, symbol);
        const body = node.childForFieldName('body');
        for (const child of body?.namedChildren ?? []) visit(child, [...scope, name]);
        return;
      }
    }
    for (const child of node.namedChildren) visit(child, scope, directClass);
  };

  visit(root, []);
  return {
    file,
    root,
    symbols: symbols.sort((a, b) => compareStrings(a.id, b.id)),
    symbolByNodeId,
    imports: readImports(root),
  };
}

function moduleNames(file: string): readonly string[] {
  const withoutExtension = file.replace(/\.py$/, '');
  const canonical = withoutExtension.endsWith('/__init__')
    ? withoutExtension.slice(0, -'/__init__'.length)
    : withoutExtension;
  const names = [canonical.replaceAll('/', '.')];
  if (canonical.startsWith('src/')) names.push(canonical.slice('src/'.length).replaceAll('/', '.'));
  return [...new Set(names.filter((name) => name.length > 0))];
}

function moduleNameIndex(files: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const file of files) {
    for (const name of moduleNames(file)) {
      const matches = result.get(name) ?? [];
      matches.push(file);
      result.set(name, matches);
    }
  }
  return new Map(
    [...result].map(([name, matches]) => [name, [...new Set(matches)].sort(compareStrings)]),
  );
}

function resolveModuleFile(
  sourceFile: string,
  specifier: string,
  context: PythonResolutionContext,
): string | undefined {
  const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  let name: string;
  if (leadingDots === 0) {
    name = specifier;
  } else {
    const sourceNames = moduleNames(sourceFile);
    const sourceName = sourceNames.at(-1) ?? '';
    const packageParts = sourceFile.endsWith('/__init__.py')
      ? sourceName.split('.').filter(Boolean)
      : sourceName.split('.').slice(0, -1);
    const keep = Math.max(0, packageParts.length - (leadingDots - 1));
    const suffix = specifier.slice(leadingDots);
    name = [...packageParts.slice(0, keep), ...suffix.split('.').filter(Boolean)].join('.');
  }
  const matches = context.filesByModuleName.get(name) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function nearestCaller(node: Parser.SyntaxNode, module: PythonModule): PythonSymbol | undefined {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current !== null) {
    const symbol = module.symbolByNodeId.get(current.id);
    if (symbol !== undefined && symbol.kind !== 'class') return symbol;
    current = current.parent;
  }
  return undefined;
}

function scopeVisible(candidate: PythonSymbol, caller: PythonSymbol): boolean {
  return (
    candidate.scope.length <= caller.scope.length &&
    candidate.scope.every((part, index) => caller.scope[index] === part)
  );
}

function resolveLocal(module: PythonModule, caller: PythonSymbol, name: string): PythonSymbol | undefined {
  const matches = module.symbols
    .filter((symbol) => symbol.name === name && scopeVisible(symbol, caller))
    .sort((a, b) => b.scope.length - a.scope.length || compareStrings(a.id, b.id));
  const best = matches[0];
  if (best === undefined || matches[1]?.scope.length === best.scope.length) return undefined;
  return best;
}

function hasLocalBinding(caller: PythonSymbol, name: string): boolean {
  const parameters = caller.node.childForFieldName('parameters');
  if (parameters?.descendantsOfType('identifier').some((node) => node.text === name) === true) return true;
  for (const assignment of caller.node.descendantsOfType(['assignment', 'named_expression'])) {
    const left = assignment.childForFieldName('left') ?? assignment.childForFieldName('name');
    if (left?.descendantsOfType('identifier').some((node) => node.text === name) === true) return true;
    if (left?.type === 'identifier' && left.text === name) return true;
  }
  return false;
}

function topLevelSymbol(module: PythonModule, name: string): PythonSymbol | undefined {
  const matches = module.symbols.filter((symbol) => symbol.scope.length === 0 && symbol.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveExported(
  file: string,
  name: string,
  context: PythonResolutionContext,
  seen: ReadonlySet<string> = new Set(),
): PythonSymbol | undefined {
  const key = `${file}#${name}`;
  if (seen.has(key) || seen.size >= 16) return undefined;
  const module = context.moduleByFile.get(file);
  if (module === undefined) return undefined;
  const direct = topLevelSymbol(module, name);
  if (direct !== undefined && !direct.name.startsWith('_')) return direct;
  const binding = module.imports.get(name);
  if (binding?.importedName === undefined) return undefined;
  const targetFile = resolveModuleFile(file, binding.moduleSpecifier, context);
  return targetFile === undefined
    ? undefined
    : resolveExported(targetFile, binding.importedName, context, new Set(seen).add(key));
}

function resolveImported(
  module: PythonModule,
  localName: string,
  context: PythonResolutionContext,
): PythonSymbol | undefined {
  const binding = module.imports.get(localName);
  if (binding?.importedName === undefined) return undefined;
  const targetFile = resolveModuleFile(module.file, binding.moduleSpecifier, context);
  return targetFile === undefined
    ? undefined
    : resolveExported(targetFile, binding.importedName, context);
}

function resolveIdentifier(
  module: PythonModule,
  caller: PythonSymbol,
  name: string,
  context: PythonResolutionContext,
): PythonSymbol | undefined {
  if (hasLocalBinding(caller, name)) return undefined;
  return resolveLocal(module, caller, name) ?? resolveImported(module, name, context);
}

function enclosingClass(module: PythonModule, caller: PythonSymbol): PythonSymbol | undefined {
  for (let length = caller.scope.length; length > 0; length -= 1) {
    const qualified = caller.scope.slice(0, length).join('.');
    const symbol = module.symbols.find(
      (candidate) => candidate.kind === 'class' && candidate.qualifiedName === qualified,
    );
    if (symbol !== undefined) return symbol;
  }
  return undefined;
}

function resolveAttribute(
  module: PythonModule,
  caller: PythonSymbol,
  node: Parser.SyntaxNode,
  context: PythonResolutionContext,
): PythonSymbol | undefined {
  const object = node.childForFieldName('object');
  const attribute = node.childForFieldName('attribute')?.text;
  if (object === null || attribute === undefined) return undefined;
  if (object.type === 'identifier' && (object.text === 'self' || object.text === 'cls')) {
    const owner = enclosingClass(module, caller);
    if (owner === undefined) return undefined;
    const matches = module.symbols.filter(
      (symbol) => symbol.scope.join('.') === owner.qualifiedName && symbol.name === attribute,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (object.type !== 'identifier') return undefined;
  const binding = module.imports.get(object.text);
  if (binding?.importedName !== undefined) return undefined;
  const targetFile =
    binding === undefined ? undefined : resolveModuleFile(module.file, binding.moduleSpecifier, context);
  return targetFile === undefined ? undefined : resolveExported(targetFile, attribute, context);
}

function addPythonNodes(builder: EvidenceGraphBuilder, modules: readonly PythonModule[]): void {
  for (const module of modules) {
    const fileId = graphNodeId('file', module.file);
    builder.addNode({ id: fileId, kind: 'file', label: module.file, provenance: provenance(module.file, 1) });
    const byQualified = new Map(module.symbols.map((symbol) => [symbol.qualifiedName, symbol]));
    for (const symbol of module.symbols) {
      const source = provenance(symbol.file, symbol.line, symbol.column);
      builder.addNode({
        id: symbol.id,
        kind: 'symbol',
        label: symbol.qualifiedName,
        provenance: source,
        properties: {
          symbolKind: symbol.kind,
          name: symbol.name,
          language: 'python',
          parserBackend: 'tree-sitter',
          exportedNames: symbol.scope.length === 0 && !symbol.name.startsWith('_') ? [symbol.name] : [],
          isAsync: symbol.node.text.trimStart().startsWith('async '),
        },
      });
      builder.addEdge({
        id: graphEdgeId('defined-in', symbol.id, fileId),
        kind: 'defined-in',
        from: symbol.id,
        to: fileId,
        provenance: source,
      });
      const parent = byQualified.get(symbol.scope.join('.'));
      if (parent !== undefined) {
        builder.addEdge({
          id: graphEdgeId('contains', parent.id, symbol.id),
          kind: 'contains',
          from: parent.id,
          to: symbol.id,
          provenance: source,
        });
      }
    }
  }
}

function addPythonInheritance(builder: EvidenceGraphBuilder, context: PythonResolutionContext): void {
  for (const module of context.modules) {
    if (!emitsModule(context, module.file)) continue;
    for (const symbol of module.symbols) {
      if (symbol.kind !== 'class') continue;
      const superclasses = symbol.node.childForFieldName('superclasses');
      for (const base of superclasses?.namedChildren ?? []) {
        let target: PythonSymbol | undefined;
        if (base.type === 'identifier') {
          target = topLevelSymbol(module, base.text) ?? resolveImported(module, base.text, context);
        } else if (base.type === 'attribute') {
          const fakeCaller = symbol;
          target = resolveAttribute(module, fakeCaller, base, context);
        }
        if (target === undefined || target.kind !== 'class' || target.id === symbol.id) continue;
        builder.addEdge({
          id: graphEdgeId('extends', symbol.id, target.id),
          kind: 'extends',
          from: symbol.id,
          to: target.id,
          provenance: provenance(module.file, base.startPosition.row + 1, base.startPosition.column + 1),
        });
      }
    }
  }
}

function addPythonCalls(builder: EvidenceGraphBuilder, context: PythonResolutionContext): void {
  for (const module of context.modules) {
    if (!emitsModule(context, module.file)) continue;
    for (const call of module.root.descendantsOfType('call')) {
      const caller = nearestCaller(call, module);
      const expression = call.childForFieldName('function');
      if (caller === undefined || expression === null) continue;
      let target: PythonSymbol | undefined;
      if (expression.type === 'identifier') {
        target = resolveIdentifier(module, caller, expression.text, context);
      } else if (expression.type === 'attribute') {
        target = resolveAttribute(module, caller, expression, context);
      }
      if (target === undefined || target.id === caller.id) continue;
      const kind = target.kind === 'class' ? 'instantiates' : 'calls';
      builder.addEdge({
        id: graphEdgeId(kind, caller.id, target.id),
        kind,
        from: caller.id,
        to: target.id,
        provenance: provenance(
          module.file,
          expression.startPosition.row + 1,
          expression.startPosition.column + 1,
        ),
      });
    }
  }
}

const PYTHON_MODEL_OPERATIONS: ReadonlySet<string> = new Set([
  'add',
  'aggregate',
  'all',
  'bulk_create',
  'count',
  'create',
  'delete',
  'exclude',
  'filter',
  'first',
  'get',
  'get_or_create',
  'last',
  'order_by',
  'select_related',
  'update',
  'update_or_create',
]);

const SQLALCHEMY_MODEL_OPERATIONS: ReadonlySet<string> = new Set([
  'delete',
  'insert',
  'select',
  'update',
]);

function pythonSchemaCandidates(graph: EvidenceGraph, symbol: PythonSymbol): readonly GraphNode[] {
  const key = symbol.name.toLocaleLowerCase('en-US');
  return graph.nodes.filter((node) => {
    if (node.kind !== 'schema') return false;
    if (!node.provenance.evidence.some((ref) => ref.file === symbol.file)) return false;
    const modelName = typeof node.properties?.modelName === 'string' ? node.properties.modelName : undefined;
    return [node.label, modelName]
      .filter((value): value is string => value !== undefined)
      .some((value) => value.toLocaleLowerCase('en-US') === key);
  });
}

function resolvePythonExpression(
  module: PythonModule,
  caller: PythonSymbol,
  node: Parser.SyntaxNode,
  context: PythonResolutionContext,
): PythonSymbol | undefined {
  if (node.type === 'identifier') return resolveIdentifier(module, caller, node.text, context);
  if (node.type === 'attribute') return resolveAttribute(module, caller, node, context);
  return undefined;
}

function addPythonDatabaseReference(args: {
  readonly builder: EvidenceGraphBuilder;
  readonly graph: EvidenceGraph;
  readonly caller: PythonSymbol;
  readonly model: PythonSymbol;
  readonly operation: string;
  readonly orm: 'django-or-sqlalchemy' | 'sqlalchemy';
  readonly sourceNode: Parser.SyntaxNode;
}): void {
  const candidates = pythonSchemaCandidates(args.graph, args.model);
  const source = {
    file: args.caller.file,
    line: args.sourceNode.startPosition.row + 1,
    column: args.sourceNode.startPosition.column + 1,
  };
  if (candidates.length !== 1) {
    if (candidates.length > 1) {
      args.builder.addGap({
        extractor: 'symbol',
        kind: 'database-model-ambiguous',
        message: `Python model '${args.model.name}' matched ${candidates.length} schema nodes from ${args.model.file}.`,
        source,
      });
    }
    return;
  }
  const target = candidates[0];
  if (target === undefined) return;
  args.builder.addEdge({
    id: graphEdgeId(
      'references',
      args.caller.id,
      target.id,
      `database:${args.orm}:${args.operation}`,
    ),
    kind: 'references',
    from: args.caller.id,
    to: target.id,
    provenance: {
      origin: 'extracted',
      extractionMethods: ['ast'],
      certainty: target.provenance.certainty === 'high' ? 'high' : 'low',
      evidence: [source],
    },
    properties: {
      referenceKind: 'database-access',
      orm: args.orm,
      operation: args.operation,
      model: args.model.name,
    },
  });
}

function addPythonDatabaseEdges(
  builder: EvidenceGraphBuilder,
  graph: EvidenceGraph,
  context: PythonResolutionContext,
): void {
  for (const module of context.modules) {
    if (!emitsModule(context, module.file)) continue;
    for (const call of module.root.descendantsOfType('call')) {
      const caller = nearestCaller(call, module);
      const expression = call.childForFieldName('function');
      if (caller === undefined || expression === null) continue;

      if (expression.type === 'attribute' && PYTHON_MODEL_OPERATIONS.has(expression.childForFieldName('attribute')?.text ?? '')) {
        const operation = expression.childForFieldName('attribute')?.text;
        const manager = expression.childForFieldName('object');
        if (operation !== undefined && manager?.type === 'attribute') {
          const managerName = manager.childForFieldName('attribute')?.text;
          const modelExpression = manager.childForFieldName('object');
          if (
            (managerName === 'objects' || managerName === 'query') &&
            modelExpression !== null
          ) {
            const model = resolvePythonExpression(module, caller, modelExpression, context);
            if (model?.kind === 'class') {
              addPythonDatabaseReference({
                builder,
                graph,
                caller,
                model,
                operation,
                orm: 'django-or-sqlalchemy',
                sourceNode: modelExpression,
              });
            }
          }
        }
      }

      if (
        expression.type === 'identifier' &&
        SQLALCHEMY_MODEL_OPERATIONS.has(expression.text)
      ) {
        const binding = module.imports.get(expression.text);
        if (
          binding?.importedName === expression.text &&
          (binding.moduleSpecifier === 'sqlalchemy' || binding.moduleSpecifier.startsWith('sqlalchemy.'))
        ) {
          const argument = call.childForFieldName('arguments')?.namedChildren[0];
          if (argument !== undefined) {
            const model = resolvePythonExpression(module, caller, argument, context);
            if (model?.kind === 'class') {
              addPythonDatabaseReference({
                builder,
                graph,
                caller,
                model,
                operation: expression.text,
                orm: 'sqlalchemy',
                sourceNode: argument,
              });
            }
          }
        }
      }
    }
  }
}

function addPythonExtractedLinks(
  builder: EvidenceGraphBuilder,
  graph: EvidenceGraph,
  context: PythonResolutionContext,
): void {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    if (edge.kind !== 'handled-by' && edge.kind !== 'implemented-by') continue;
    const target = nodeById.get(edge.to);
    if (target?.kind !== 'file') continue;
    const module = context.moduleByFile.get(target.label);
    const evidence = edge.provenance.evidence.find((item) => item.file === target.label);
    if (module === undefined || evidence?.line === undefined) continue;
    const candidates = module.symbols.filter(
      (symbol) =>
        symbol.kind !== 'class' &&
        symbol.fullStartLine <= (evidence.line as number) &&
        symbol.line >= (evidence.line as number),
    );
    if (candidates.length !== 1) continue;
    const symbol = candidates[0];
    if (symbol === undefined) continue;
    builder.addEdge({
      id: graphEdgeId(edge.kind, edge.from, symbol.id, 'resolved-python-symbol'),
      kind: edge.kind,
      from: edge.from,
      to: symbol.id,
      provenance: edge.provenance,
      properties: { resolution: 'symbol', language: 'python' },
    });
  }
}

function firstError(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  if (node.isError || node.isMissing) return node;
  for (const child of node.children) {
    const error = firstError(child);
    if (error !== undefined) return error;
  }
  return undefined;
}

export interface PythonSymbolOptions {
  readonly graph: EvidenceGraph;
  readonly root: string;
  readonly exclude: readonly string[];
  readonly partitionFiles?: ReadonlySet<string>;
}

/** Add Python symbol evidence using the official Tree-sitter Python grammar. */
export async function enrichGraphWithPythonSymbols(options: PythonSymbolOptions): Promise<EvidenceGraph> {
  const files = (
    await fg(['**/*.py'], {
      cwd: options.root,
      ignore: [...options.exclude],
      onlyFiles: true,
      followSymbolicLinks: false,
    })
  )
    .map(toPosix)
    .sort(compareStrings);

  // Most repositories in a mixed fleet are not Python projects. Avoid loading
  // and initialising the native parser when this adapter has nothing to do.
  if (files.length === 0) return options.graph;

  const parser = new Parser();
  parser.setLanguage(Python);
  const modules: PythonModule[] = [];
  const syntaxErrors: { readonly file: string; readonly node: Parser.SyntaxNode }[] = [];
  for (const file of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(options.root, file), 'utf8');
    } catch (error) {
      // A disappearing file is handled consistently with the other static analyzers;
      // parser and adapter failures are deliberately not swallowed.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const root = parser.parse(contents).rootNode;
    if (root.hasError) {
      syntaxErrors.push({ file, node: firstError(root) ?? root });
      continue;
    }
    modules.push(analysePythonModule(file, root));
  }

  const builder = new EvidenceGraphBuilder();
  for (const node of options.graph.nodes) builder.addNode(node);
  for (const edge of options.graph.edges) builder.addEdge(edge);
  for (const gap of options.graph.gaps) builder.addGap(gap);
  for (const error of syntaxErrors) {
    if (options.partitionFiles !== undefined && !options.partitionFiles.has(error.file)) continue;
    builder.addGap({
      extractor: 'symbol',
      kind: 'python-syntax-error',
      message: 'Python symbol indexing skipped this file because Tree-sitter found invalid syntax.',
      source: {
        file: error.file,
        line: error.node.startPosition.row + 1,
        column: error.node.startPosition.column + 1,
      },
    });
  }

  const context: PythonResolutionContext = {
    modules,
    moduleByFile: new Map(modules.map((module) => [module.file, module])),
    filesByModuleName: moduleNameIndex(files),
    ...(options.partitionFiles === undefined ? {} : { outputFiles: options.partitionFiles }),
  };
  addPythonNodes(
    builder,
    options.partitionFiles === undefined
      ? modules
      : modules.filter((module) => options.partitionFiles?.has(module.file) === true),
  );
  addPythonExtractedLinks(builder, options.graph, context);
  addPythonInheritance(builder, context);
  addPythonCalls(builder, context);
  addPythonDatabaseEdges(builder, options.graph, context);
  return builder.build();
}
