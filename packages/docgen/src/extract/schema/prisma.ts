import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { SchemaEntry, SchemaField, SchemaIndex, SchemaRelation } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { EMPTY_RESULT } from './types.js';
import type { SchemaProvider, SchemaProviderContext, SchemaProviderResult } from './types.js';

/**
 * Prisma schema files.
 *
 * The `.prisma` schema is the ORM's own declaration of the database, which
 * SPEC 6.1 names as the right source to read. It is a structured DSL rather
 * than arbitrary code, so a line parser reads it exactly — this is not a regex
 * fallback over source code.
 */
export const prismaProvider: SchemaProvider = {
  id: 'prisma',
  name: 'Prisma',

  async run(context: SchemaProviderContext): Promise<SchemaProviderResult> {
    const files = (
      await fg(['**/*.prisma'], { cwd: context.root, ignore: [...context.exclude], onlyFiles: true })
    )
      .map(toPosix)
      .sort();

    if (files.length === 0) return EMPTY_RESULT;

    const entries: SchemaEntry[] = [];
    const gaps: Gap[] = [];

    for (const relative of files) {
      const contents = await fs.readFile(path.join(context.root, relative), 'utf8');
      const parsed = parsePrismaSchema(relative, contents);
      entries.push(...parsed.entries);
      gaps.push(...parsed.gaps);
    }

    return { entries, gaps };
  },
};

const MODEL_START = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/;
const ENUM_START = /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/;
const FIELD_LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?\s*(.*)$/;
const BLOCK_ATTRIBUTE = /^\s*@@([a-zA-Z]+)\s*\((.*)\)\s*$/;

export function parsePrismaSchema(
  file: string,
  contents: string,
): { entries: readonly SchemaEntry[]; gaps: readonly Gap[] } {
  const lines = contents.split(/\r?\n/);
  const entries: SchemaEntry[] = [];
  const gaps: Gap[] = [];

  // Enums and models are both block types; knowing the model names lets a
  // field's type be classified as a relation rather than a scalar.
  const modelNames = new Set<string>();
  for (const line of lines) {
    const match = MODEL_START.exec(line);
    if (match?.[1] !== undefined) modelNames.add(match[1]);
  }

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;

    if (ENUM_START.test(line)) {
      index = skipBlock(lines, index);
      continue;
    }

    const modelMatch = MODEL_START.exec(line);
    if (modelMatch === null) {
      index += 1;
      continue;
    }

    const modelName = modelMatch[1] as string;
    const startLine = index + 1;
    const fields: SchemaField[] = [];
    const relations: SchemaRelation[] = [];
    const indexes: SchemaIndex[] = [];
    let tableName = modelName;

    index += 1;
    while (index < lines.length && !/^\s*\}/.test(lines[index] as string)) {
      const body = lines[index] as string;
      const trimmed = body.trim();
      index += 1;

      if (trimmed.length === 0 || trimmed.startsWith('//')) continue;

      const blockAttribute = BLOCK_ATTRIBUTE.exec(body);
      if (blockAttribute !== null) {
        const kind = blockAttribute[1] as string;
        const argument = blockAttribute[2] as string;

        if (kind === 'map') {
          tableName = stripQuotes(argument) ?? modelName;
        } else if (kind === 'index' || kind === 'unique' || kind === 'id') {
          const columns = parseBracketList(argument);
          if (columns.length > 0) {
            indexes.push({ fields: columns, ...(kind === 'unique' ? { unique: true } : {}) });
          }
        }
        continue;
      }

      const fieldMatch = FIELD_LINE.exec(body);
      if (fieldMatch === null) continue;

      const name = fieldMatch[1] as string;
      const baseType = fieldMatch[2] as string;
      const isList = fieldMatch[3] !== undefined;
      const isOptional = fieldMatch[4] !== undefined;
      const attributes = fieldMatch[5] ?? '';

      // A field typed as another model is a relation, not a stored column.
      if (modelNames.has(baseType)) {
        relations.push({
          field: name,
          targetModel: baseType,
          cardinality: isList ? 'one-to-many' : 'many-to-one',
        });
        continue;
      }

      const defaultValue = /@default\(([^)]*)\)/.exec(attributes)?.[1];
      fields.push({
        name,
        type: `${baseType}${isList ? '[]' : ''}`,
        nullable: isOptional,
        ...(attributes.includes('@id') ? { isPrimaryKey: true } : {}),
        ...(attributes.includes('@unique') ? { isUnique: true } : {}),
        ...(defaultValue === undefined ? {} : { defaultValue }),
      });
    }
    index += 1; // consume the closing brace

    if (fields.length === 0 && relations.length === 0) {
      gaps.push({
        extractor: 'schema',
        kind: 'empty-model',
        message: `Prisma model '${modelName}' declares no readable fields.`,
        source: { file, line: startLine },
      });
    }

    entries.push({
      id: `schema:table:${tableName}`,
      source: { file, line: startLine },
      extractionMethod: 'schema',
      certainty: 'high',
      name: tableName,
      kind: 'table',
      ...(tableName === modelName ? {} : { modelName }),
      fields: sortFields(fields),
      indexes,
      relations: [...relations].sort((a, b) => a.field.localeCompare(b.field)),
    });
  }

  return { entries, gaps };
}

/** Fields keep declaration order; only the primary key is hoisted for readability. */
function sortFields(fields: readonly SchemaField[]): readonly SchemaField[] {
  return [...fields].sort((a, b) => {
    if (a.isPrimaryKey === true && b.isPrimaryKey !== true) return -1;
    if (b.isPrimaryKey === true && a.isPrimaryKey !== true) return 1;
    return 0;
  });
}

/**
 * Skip a block by counting braces rather than looking for a closing line.
 *
 * A single-line block (`enum Role { ADMIN USER }`) closes on the line it opens,
 * and scanning forward for the next `}` swallows the block that follows it —
 * which silently dropped whole models.
 */
function skipBlock(lines: readonly string[], start: number): number {
  let depth = 0;
  let index = start;

  do {
    for (const char of lines[index] as string) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    index += 1;
  } while (index < lines.length && depth > 0);

  return index;
}

function stripQuotes(value: string): string | undefined {
  const match = /^\s*["']([^"']*)["']\s*$/.exec(value);
  return match?.[1];
}

/** `[email, name]` or `fields: [a, b]` -> ['email','name'] */
function parseBracketList(argument: string): readonly string[] {
  const inner = /\[([^\]]*)\]/.exec(argument)?.[1];
  if (inner === undefined) return [];
  return inner
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter((part) => part.length > 0);
}
