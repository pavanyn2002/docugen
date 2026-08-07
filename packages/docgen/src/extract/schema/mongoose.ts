import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { SchemaEntry, SchemaField, SchemaIndex, SchemaRelation } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { getProperty, literalString, parseSourceFile, positionOf, ts, walk } from '../../util/ts-ast.js';
import { EMPTY_RESULT } from './types.js';
import type { SchemaProvider, SchemaProviderContext, SchemaProviderResult } from './types.js';

/**
 * Mongoose schemas, read from the AST.
 *
 * A Mongoose schema is ordinary code rather than a declarative file, so the
 * TypeScript parser does the reading. Field definitions come in several shapes
 * (`String`, `{ type: String, required: true }`, `[String]`, `Schema.Types.
 * ObjectId` with a `ref`), each handled explicitly. A shape that is not
 * recognised is reported rather than approximated: a field documented with the
 * wrong type is worse than a field documented as unknown.
 */
export const mongooseProvider: SchemaProvider = {
  id: 'mongoose',
  name: 'Mongoose',

  async run(context: SchemaProviderContext): Promise<SchemaProviderResult> {
    const files = (
      await fg(['**/*.{ts,tsx,js,jsx,mjs}'], {
        cwd: context.root,
        ignore: [...context.exclude],
        onlyFiles: true,
      })
    )
      .map(toPosix)
      .sort();

    const entries: SchemaEntry[] = [];
    const gaps: Gap[] = [];

    for (const relative of files) {
      let contents: string;
      try {
        contents = await fs.readFile(path.join(context.root, relative), 'utf8');
      } catch {
        continue;
      }
      // Cheap pre-filter; parsing every file in a large repo blows the budget.
      if (!contents.includes('Schema')) continue;
      if (!contents.includes('mongoose') && !contents.includes('Schema(')) continue;

      const parsed = parseMongooseFile(relative, contents);
      entries.push(...parsed.entries);
      gaps.push(...parsed.gaps);
    }

    return entries.length === 0 && gaps.length === 0 ? EMPTY_RESULT : { entries, gaps };
  },
};

export function parseMongooseFile(
  file: string,
  contents: string,
): { entries: readonly SchemaEntry[]; gaps: readonly Gap[] } {
  const source = parseSourceFile(file, contents);
  const entries: SchemaEntry[] = [];
  const gaps: Gap[] = [];

  // `mongoose.model('User', userSchema)` names the collection; without it the
  // variable name is the only clue available.
  const collectionByVariable = new Map<string, string>();
  const indexesByVariable = new Map<string, SchemaIndex[]>();

  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;

    const callee = calleeName(node.expression);
    if (callee === 'model' && node.arguments.length >= 2) {
      const modelName = literalString(node.arguments[0]);
      const schemaArgument = node.arguments[1];
      if (modelName !== undefined && schemaArgument !== undefined && ts.isIdentifier(schemaArgument)) {
        collectionByVariable.set(schemaArgument.text, modelName);
      }
      return;
    }

    // `userSchema.index({ email: 1 }, { unique: true })`
    if (callee === 'index' && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression;
      if (!ts.isIdentifier(target)) return;
      const keys = node.arguments[0];
      if (keys === undefined || !ts.isObjectLiteralExpression(keys)) return;

      const fields = keys.properties
        .map((property) => propertyName(property))
        .filter((name): name is string => name !== undefined);
      if (fields.length === 0) return;

      const options = node.arguments[1];
      const unique =
        options !== undefined &&
        ts.isObjectLiteralExpression(options) &&
        getProperty(options, 'unique')?.kind === ts.SyntaxKind.TrueKeyword;

      const bucket = indexesByVariable.get(target.text) ?? [];
      bucket.push({ fields, ...(unique ? { unique: true } : {}) });
      indexesByVariable.set(target.text, bucket);
    }
  });

  walk(source, (node) => {
    if (!ts.isNewExpression(node)) return;
    if (calleeName(node.expression) !== 'Schema') return;

    const definition = node.arguments?.[0];
    const position = positionOf(source, node, file);

    const variableName = enclosingVariableName(node);
    const collection = variableName === undefined ? undefined : collectionByVariable.get(variableName);
    const name = collection ?? variableName ?? 'UnnamedSchema';

    if (definition === undefined || !ts.isObjectLiteralExpression(definition)) {
      gaps.push({
        extractor: 'schema',
        kind: 'schema-definition-not-literal',
        message:
          `Mongoose schema '${name}' is built from a value docgen cannot read statically, ` +
          'so its fields are unknown.',
        source: position,
      });
      return;
    }

    const fields: SchemaField[] = [];
    const relations: SchemaRelation[] = [];
    readFields(definition, '', fields, relations, source, file, gaps);

    const options = node.arguments?.[1];
    if (
      options !== undefined &&
      ts.isObjectLiteralExpression(options) &&
      getProperty(options, 'timestamps')?.kind === ts.SyntaxKind.TrueKeyword
    ) {
      // Mongoose adds these itself; documenting the collection without them
      // would understate what is actually stored.
      fields.push({ name: 'createdAt', type: 'Date', nullable: false });
      fields.push({ name: 'updatedAt', type: 'Date', nullable: false });
    }

    if (collection === undefined) {
      gaps.push({
        extractor: 'schema',
        kind: 'collection-name-unresolved',
        message:
          `No mongoose.model() call was found for schema '${name}', so its collection name is ` +
          'not confirmed. The name shown is the variable it was assigned to.',
        source: position,
      });
    }

    entries.push({
      id: `schema:collection:${name}`,
      source: position,
      extractionMethod: 'ast',
      certainty: 'high',
      name,
      kind: 'collection',
      ...(variableName === undefined || variableName === name ? {} : { modelName: variableName }),
      fields: [...fields].sort((a, b) => a.name.localeCompare(b.name)),
      indexes: variableName === undefined ? [] : (indexesByVariable.get(variableName) ?? []),
      relations: [...relations].sort((a, b) => a.field.localeCompare(b.field)),
    });
  });

  return { entries, gaps };
}

/** Walk a schema definition object, flattening nested field paths with dots. */
function readFields(
  definition: ts.ObjectLiteralExpression,
  prefix: string,
  fields: SchemaField[],
  relations: SchemaRelation[],
  source: ts.SourceFile,
  file: string,
  gaps: Gap[],
): void {
  for (const property of definition.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyName(property);
    if (key === undefined) continue;

    const name = prefix === '' ? key : `${prefix}.${key}`;
    const value = property.initializer;

    // `field: String`
    const simple = typeNameOf(value);
    if (simple !== undefined) {
      fields.push({ name, type: simple, nullable: true });
      continue;
    }

    // `field: [String]` or `field: [{ ... }]`
    if (ts.isArrayLiteralExpression(value)) {
      const element = value.elements[0];
      const elementType = element === undefined ? undefined : typeNameOf(element);
      if (elementType !== undefined) {
        fields.push({ name, type: `[${elementType}]`, nullable: true });
        continue;
      }
      if (element !== undefined && ts.isObjectLiteralExpression(element)) {
        const inner = readNestedOrDescriptor(element, name, fields, relations, source, file, gaps);
        if (!inner) readFields(element, name, fields, relations, source, file, gaps);
        continue;
      }
      fields.push({ name, type: '[unknown]', nullable: true });
      continue;
    }

    if (ts.isObjectLiteralExpression(value)) {
      const handled = readNestedOrDescriptor(value, name, fields, relations, source, file, gaps);
      if (!handled) readFields(value, name, fields, relations, source, file, gaps);
      continue;
    }

    gaps.push({
      extractor: 'schema',
      kind: 'field-type-unreadable',
      message: `Field '${name}' has a definition docgen cannot read statically; its type is unknown.`,
      source: positionOf(source, property, file),
    });
  }
}

/**
 * Handle `{ type: X, required: true, ref: 'Other' }`.
 * Returns false when the object is a nested subdocument rather than a descriptor.
 */
function readNestedOrDescriptor(
  object: ts.ObjectLiteralExpression,
  name: string,
  fields: SchemaField[],
  relations: SchemaRelation[],
  source: ts.SourceFile,
  file: string,
  gaps: Gap[],
): boolean {
  const typeNode = getProperty(object, 'type');
  if (typeNode === undefined) return false;

  let type = typeNameOf(typeNode);
  if (type === undefined && ts.isArrayLiteralExpression(typeNode)) {
    const element = typeNode.elements[0];
    const elementType = element === undefined ? undefined : typeNameOf(element);
    type = elementType === undefined ? '[unknown]' : `[${elementType}]`;
  }
  if (type === undefined) {
    gaps.push({
      extractor: 'schema',
      kind: 'field-type-unreadable',
      message: `Field '${name}' declares a type docgen cannot read statically.`,
      source: positionOf(source, typeNode, file),
    });
    type = 'unknown';
  }

  const required = getProperty(object, 'required');
  const unique = getProperty(object, 'unique');
  const defaultNode = getProperty(object, 'default');
  const ref = literalString(getProperty(object, 'ref'));

  if (ref !== undefined) {
    relations.push({
      field: name,
      targetModel: ref,
      cardinality: type.startsWith('[') ? 'one-to-many' : 'many-to-one',
    });
  }

  fields.push({
    name,
    type,
    nullable: required?.kind !== ts.SyntaxKind.TrueKeyword,
    ...(unique?.kind === ts.SyntaxKind.TrueKeyword ? { isUnique: true } : {}),
    ...(defaultNode === undefined ? {} : { defaultValue: defaultNode.getText(source) }),
  });
  return true;
}

/** Recognised Mongoose type expressions: `String`, `Schema.Types.ObjectId`, `Date`. */
function typeNameOf(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const text = node.getText();
    if (text.includes('Types.')) return text.split('Types.').pop() ?? text;
    return text;
  }
  return undefined;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    return expression.name.text;
  }
  return undefined;
}

/** The variable a `new Schema(...)` expression is assigned to. */
function enclosingVariableName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    current = current.parent;
  }
  return undefined;
}
