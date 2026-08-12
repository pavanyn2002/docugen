import type { ModuleBindings } from '../../util/modules.js';
import { resolveSymbolToFile } from '../../util/modules.js';
import type { PathAlias } from '../../util/tsconfig.js';
import { literalString, ts, walk } from '../../util/ts-ast.js';

export interface StaticStringValue {
  readonly value: string;
  readonly complete: boolean;
  readonly original: string;
}

export interface StaticModule {
  readonly file: string;
  readonly source: ts.SourceFile;
  readonly bindings: ModuleBindings;
}

/**
 * Conservatively evaluate a string without loading or executing the module.
 * Unknown pieces survive as stable `{expression}` placeholders so a mounted
 * router is never mistaken for an unmounted router or shown at a relative URL.
 */
export async function evaluateStaticString(args: {
  module: StaticModule;
  expression: ts.Expression;
  files: ReadonlySet<string>;
  aliases: readonly PathAlias[];
  loadModule: (file: string) => Promise<StaticModule | undefined>;
}): Promise<StaticStringValue> {
  const original = compact(args.expression.getText(args.module.source));
  const evaluated = await evaluate(args.module, args.expression, args, new Set(), 0);
  return { ...evaluated, original };
}

async function evaluate(
  module: StaticModule,
  expression: ts.Expression,
  context: Omit<Parameters<typeof evaluateStaticString>[0], 'module' | 'expression'>,
  seen: Set<string>,
  depth: number,
): Promise<{ value: string; complete: boolean }> {
  if (depth > 16) return unknown(expression, module.source);
  const unwrapped = unwrap(expression);
  const literal = literalString(unwrapped);
  if (literal !== undefined) return { value: literal, complete: true };

  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = await evaluate(module, unwrapped.left, context, seen, depth + 1);
    const right = await evaluate(module, unwrapped.right, context, seen, depth + 1);
    return { value: `${left.value}${right.value}`, complete: left.complete && right.complete };
  }

  if (ts.isTemplateExpression(unwrapped)) {
    let value = unwrapped.head.text;
    let complete = true;
    for (const span of unwrapped.templateSpans) {
      const part = await evaluate(module, span.expression, context, seen, depth + 1);
      value += part.value + span.literal.text;
      complete &&= part.complete;
    }
    return { value, complete };
  }

  const resolved = await resolveExpression(module, unwrapped, context, seen, depth);
  if (resolved !== undefined) return resolved;
  return unknown(unwrapped, module.source);
}

async function resolveExpression(
  module: StaticModule,
  expression: ts.Expression,
  context: Omit<Parameters<typeof evaluateStaticString>[0], 'module' | 'expression'>,
  seen: Set<string>,
  depth: number,
): Promise<{ value: string; complete: boolean } | undefined> {
  if (ts.isIdentifier(expression)) {
    const local = localInitializer(module.source, expression.text);
    if (local !== undefined) {
      const key = `${module.file}#${expression.text}`;
      if (seen.has(key)) return undefined;
      const nextSeen = new Set(seen).add(key);
      return evaluate(module, local, context, nextSeen, depth + 1);
    }
    const imported = module.bindings.imports.get(expression.text);
    if (imported === undefined) return undefined;
    const target = await resolveSymbolToFile({
      fromFile: module.file,
      symbol: expression.text,
      loadBindings: async (file) => (await context.loadModule(file))?.bindings,
      files: context.files,
      aliases: context.aliases,
    });
    if (target === undefined) return undefined;
    const targetModule = await context.loadModule(target.file);
    if (targetModule === undefined) return undefined;
    const targetExpression = exportedInitializer(targetModule.source, targetModule.bindings, target.exportedName);
    if (targetExpression === undefined) return undefined;
    const key = `${target.file}#${target.exportedName}`;
    if (seen.has(key)) return undefined;
    return evaluate(targetModule, targetExpression, context, new Set(seen).add(key), depth + 1);
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const root = await expressionInitializer(module, expression.expression, context, seen, depth + 1);
    if (root === undefined) return undefined;
    const property = objectProperty(root.expression, expression.name.text, root.module.source);
    if (property === undefined) return undefined;
    return evaluate(root.module, property, context, seen, depth + 1);
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression !== undefined) {
    const propertyName = literalString(expression.argumentExpression);
    if (propertyName === undefined) return undefined;
    const root = await expressionInitializer(module, expression.expression, context, seen, depth + 1);
    if (root === undefined) return undefined;
    const property = objectProperty(root.expression, propertyName, root.module.source);
    if (property === undefined) return undefined;
    return evaluate(root.module, property, context, seen, depth + 1);
  }
  return undefined;
}

async function expressionInitializer(
  module: StaticModule,
  expression: ts.Expression,
  context: Omit<Parameters<typeof evaluateStaticString>[0], 'module' | 'expression'>,
  seen: Set<string>,
  depth: number,
): Promise<{ module: StaticModule; expression: ts.Expression } | undefined> {
  const unwrapped = unwrap(expression);
  if (ts.isObjectLiteralExpression(unwrapped)) return { module, expression: unwrapped };
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const root = await expressionInitializer(module, unwrapped.expression, context, seen, depth + 1);
    if (root === undefined) return undefined;
    const property = objectProperty(root.expression, unwrapped.name.text, root.module.source);
    return property === undefined ? undefined : { module: root.module, expression: unwrap(property) };
  }
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const local = localInitializer(module.source, unwrapped.text);
  if (local !== undefined) return { module, expression: unwrap(local) };
  const imported = module.bindings.imports.get(unwrapped.text);
  if (imported === undefined) return undefined;
  const target = await resolveSymbolToFile({
    fromFile: module.file,
    symbol: unwrapped.text,
    loadBindings: async (file) => (await context.loadModule(file))?.bindings,
    files: context.files,
    aliases: context.aliases,
  });
  if (target === undefined) return undefined;
  const targetModule = await context.loadModule(target.file);
  if (targetModule === undefined) return undefined;
  const targetExpression = exportedInitializer(targetModule.source, targetModule.bindings, target.exportedName);
  return targetExpression === undefined ? undefined : { module: targetModule, expression: unwrap(targetExpression) };
}

function localInitializer(source: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  walk(source, (node) => {
    if (found !== undefined || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (node.name.text === name && node.initializer !== undefined) found = node.initializer;
  });
  return found;
}

function exportedInitializer(
  source: ts.SourceFile,
  bindings: ModuleBindings,
  exportedName: string,
): ts.Expression | undefined {
  if (exportedName === 'default') {
    for (const statement of source.statements) {
      if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) return statement.expression;
    }
  }
  const binding = bindings.exports.get(exportedName);
  const localName = binding?.kind === 'local' ? binding.localName : exportedName;
  return localInitializer(source, localName);
}

function objectProperty(expression: ts.Expression, name: string, source: ts.SourceFile): ts.Expression | undefined {
  const object = unwrap(expression);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : property.name.getText(source);
    if (propertyName === name) return property.initializer;
  }
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}

function unknown(expression: ts.Expression, source: ts.SourceFile): { value: string; complete: false } {
  return { value: `{${compact(expression.getText(source))}}`, complete: false };
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
