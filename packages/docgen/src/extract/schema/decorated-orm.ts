import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { SchemaEntry, SchemaField, SchemaRelation } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { getProperty, literalString, parseSourceFile, positionOf, ts, walk } from '../../util/ts-ast.js';
import { EMPTY_RESULT } from './types.js';
import type { SchemaProvider, SchemaProviderContext, SchemaProviderResult } from './types.js';
import { compareStrings } from '../../util/sort.js';

/**
 * TypeORM entities and Sequelize models.
 *
 * Both declare tables in TypeScript, so both are read from the AST. TypeORM
 * uses decorators on a class; Sequelize uses either `sequelize.define()` or
 * `Model.init()`. They share enough machinery to live in one provider.
 */

const RELATION_DECORATORS: Readonly<Record<string, NonNullable<SchemaRelation['cardinality']>>> = Object.freeze({
  OneToOne: 'one-to-one',
  OneToMany: 'one-to-many',
  ManyToOne: 'many-to-one',
  ManyToMany: 'many-to-many',
});

export const typeormProvider: SchemaProvider = {
  id: 'typeorm',
  name: 'TypeORM',

  async run(context: SchemaProviderContext): Promise<SchemaProviderResult> {
    return scan(context, ['@Entity'], parseTypeormFile);
  },
};

export const sequelizeProvider: SchemaProvider = {
  id: 'sequelize',
  name: 'Sequelize',

  async run(context: SchemaProviderContext): Promise<SchemaProviderResult> {
    return scan(context, ['sequelize', 'Sequelize'], parseSequelizeFile);
  },
};

async function scan(
  context: SchemaProviderContext,
  hints: readonly string[],
  parse: (file: string, contents: string) => { entries: readonly SchemaEntry[]; gaps: readonly Gap[] },
): Promise<SchemaProviderResult> {
  const files = (
    await fg(['**/*.{ts,js,mjs}'], { cwd: context.root, ignore: [...context.exclude], onlyFiles: true })
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
    if (!hints.some((hint) => contents.includes(hint))) continue;

    const parsed = parse(relative, contents);
    entries.push(...parsed.entries);
    gaps.push(...parsed.gaps);
  }

  return entries.length === 0 && gaps.length === 0 ? EMPTY_RESULT : { entries, gaps };
}

// ── TypeORM ──────────────────────────────────────────────────────────────────

export function parseTypeormFile(
  file: string,
  contents: string,
): { entries: readonly SchemaEntry[]; gaps: readonly Gap[] } {
  const source = parseSourceFile(file, contents);
  const entries: SchemaEntry[] = [];
  const gaps: Gap[] = [];

  walk(source, (node) => {
    if (!ts.isClassDeclaration(node) || node.name === undefined) return;

    const entityDecorator = findDecorator(node, 'Entity');
    if (entityDecorator === undefined) return;

    const className = node.name.text;
    const tableName = literalString(entityDecorator.arguments[0]) ?? className;

    const fields: SchemaField[] = [];
    const relations: SchemaRelation[] = [];

    for (const member of node.members) {
      if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
      const name = member.name.text;

      for (const decorator of Object.keys(RELATION_DECORATORS)) {
        const cardinality = RELATION_DECORATORS[decorator] as NonNullable<SchemaRelation['cardinality']>;
        const found = findDecorator(member, decorator);
        if (found === undefined) continue;
        const target = targetEntityName(found.arguments[0]);
        relations.push({
          field: name,
          targetModel: target ?? 'unknown',
          cardinality,
        });
        if (target === undefined) {
          gaps.push({
            extractor: 'schema',
            kind: 'relation-target-unresolved',
            message: `Relation '${className}.${name}' targets an entity docgen could not resolve statically.`,
            source: positionOf(source, member, file),
          });
        }
      }

      const column =
        findDecorator(member, 'Column') ??
        findDecorator(member, 'PrimaryGeneratedColumn') ??
        findDecorator(member, 'PrimaryColumn') ??
        findDecorator(member, 'CreateDateColumn') ??
        findDecorator(member, 'UpdateDateColumn');
      if (column === undefined) continue;

      const options = column.arguments.find((argument) => ts.isObjectLiteralExpression(argument));
      const declaredType =
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? literalString(getProperty(options, 'type'))
          : undefined;
      const typeAnnotation = member.type?.getText(source);

      const isPrimary =
        findDecorator(member, 'PrimaryGeneratedColumn') !== undefined ||
        findDecorator(member, 'PrimaryColumn') !== undefined;

      const nullable =
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? getProperty(options, 'nullable')?.kind === ts.SyntaxKind.TrueKeyword
          : member.questionToken !== undefined;

      const unique =
        options !== undefined &&
        ts.isObjectLiteralExpression(options) &&
        getProperty(options, 'unique')?.kind === ts.SyntaxKind.TrueKeyword;

      fields.push({
        name,
        type: declaredType ?? typeAnnotation ?? 'unknown',
        nullable: isPrimary ? false : nullable,
        ...(isPrimary ? { isPrimaryKey: true } : {}),
        ...(unique ? { isUnique: true } : {}),
      });
    }

    entries.push({
      id: `schema:table:${tableName}`,
      source: positionOf(source, node, file),
      extractionMethod: 'ast',
      certainty: 'high',
      name: tableName,
      kind: 'table',
      ...(tableName === className ? {} : { modelName: className }),
      fields: [...fields].sort((a, b) =>compareStrings(a.name, b.name)),
      indexes: [],
      relations: [...relations].sort((a, b) =>compareStrings(a.field, b.field)),
    });
  });

  return { entries, gaps };
}

function findDecorator(node: ts.Node, name: string): ts.CallExpression | undefined {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (decorators === undefined) return undefined;

  for (const decorator of decorators) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression)) continue;
    if (ts.isIdentifier(expression.expression) && expression.expression.text === name) {
      return expression;
    }
  }
  return undefined;
}

/** `() => Photo` or `'Photo'` in a relation decorator. */
function targetEntityName(argument: ts.Expression | undefined): string | undefined {
  if (argument === undefined) return undefined;
  const literal = literalString(argument);
  if (literal !== undefined) return literal;
  if (ts.isArrowFunction(argument) && ts.isIdentifier(argument.body)) return argument.body.text;
  return undefined;
}

// ── Sequelize ────────────────────────────────────────────────────────────────

export function parseSequelizeFile(
  file: string,
  contents: string,
): { entries: readonly SchemaEntry[]; gaps: readonly Gap[] } {
  const source = parseSourceFile(file, contents);
  const entries: SchemaEntry[] = [];
  const gaps: Gap[] = [];

  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;

    const callee = node.expression;
    const methodName =
      ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) ? callee.name.text : undefined;
    if (methodName !== 'define' && methodName !== 'init') return;

    // define('User', { ...attrs }) | Model.init({ ...attrs }, options)
    const isDefine = methodName === 'define';
    const nameArgument = isDefine ? literalString(node.arguments[0]) : undefined;
    const attributes = isDefine ? node.arguments[1] : node.arguments[0];
    if (attributes === undefined || !ts.isObjectLiteralExpression(attributes)) return;

    const modelName =
      nameArgument ??
      (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        ? callee.expression.text
        : undefined);
    if (modelName === undefined) return;

    const optionsArgument = isDefine ? node.arguments[2] : node.arguments[1];
    const tableName =
      optionsArgument !== undefined && ts.isObjectLiteralExpression(optionsArgument)
        ? (literalString(getProperty(optionsArgument, 'tableName')) ?? modelName)
        : modelName;

    const fields: SchemaField[] = [];
    const relations: SchemaRelation[] = [];

    for (const property of attributes.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
      const name = property.name.text;
      const value = property.initializer;

      if (ts.isObjectLiteralExpression(value)) {
        const typeNode = getProperty(value, 'type');
        const references = getProperty(value, 'references');
        if (references !== undefined && ts.isObjectLiteralExpression(references)) {
          const target = literalString(getProperty(references, 'model'));
          if (target !== undefined) {
            relations.push({ field: name, targetModel: target, cardinality: 'many-to-one' });
          }
        }
        fields.push({
          name,
          type: typeNode === undefined ? 'unknown' : sequelizeTypeName(typeNode, source),
          nullable: getProperty(value, 'allowNull')?.kind !== ts.SyntaxKind.FalseKeyword,
          ...(getProperty(value, 'primaryKey')?.kind === ts.SyntaxKind.TrueKeyword
            ? { isPrimaryKey: true }
            : {}),
          ...(getProperty(value, 'unique')?.kind === ts.SyntaxKind.TrueKeyword ? { isUnique: true } : {}),
        });
        continue;
      }

      fields.push({ name, type: sequelizeTypeName(value, source), nullable: true });
    }

    if (fields.length === 0) {
      gaps.push({
        extractor: 'schema',
        kind: 'empty-model',
        message: `Sequelize model '${modelName}' declares no readable attributes.`,
        source: positionOf(source, node, file),
      });
    }

    entries.push({
      id: `schema:table:${tableName}`,
      source: positionOf(source, node, file),
      extractionMethod: 'ast',
      certainty: 'high',
      name: tableName,
      kind: 'table',
      ...(tableName === modelName ? {} : { modelName }),
      fields: [...fields].sort((a, b) =>compareStrings(a.name, b.name)),
      indexes: [],
      relations: [...relations].sort((a, b) =>compareStrings(a.field, b.field)),
    });
  });

  return { entries, gaps };
}

/** `DataTypes.STRING` / `DataTypes.STRING(255)` -> 'STRING'. */
function sequelizeTypeName(node: ts.Node, source: ts.SourceFile): string {
  const text = node.getText(source);
  const match = /DataTypes\.([A-Z_]+)/.exec(text);
  return match?.[1] ?? text;
}
