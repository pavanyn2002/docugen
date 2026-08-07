import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { SchemaEntry, SchemaField, SchemaIndex, SchemaRelation } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { EMPTY_RESULT } from './types.js';
import type { SchemaProvider, SchemaProviderContext, SchemaProviderResult } from './types.js';

/**
 * SQL DDL in migration files.
 *
 * For projects whose schema lives in raw SQL (Supabase and similar), the
 * migrations are the schema. Statements are applied in filename order so a
 * later ALTER or DROP overrides an earlier CREATE, which is what the database
 * actually ends up with — reading only CREATE TABLE would document columns that
 * were removed three migrations ago.
 */
export const sqlDdlProvider: SchemaProvider = {
  id: 'sql-ddl',
  name: 'SQL migrations',

  async run(context: SchemaProviderContext): Promise<SchemaProviderResult> {
    const files = (
      await fg(['**/migrations/**/*.sql', '**/migration/**/*.sql', '**/db/**/*.sql', '**/sql/**/*.sql'], {
        cwd: context.root,
        ignore: [...context.exclude],
        onlyFiles: true,
      })
    )
      .map(toPosix)
      // Migrations are conventionally ordered by filename; that ordering is the
      // schema's history, so it must be respected.
      .sort();

    if (files.length === 0) return EMPTY_RESULT;

    const tables = new Map<string, MutableTable>();
    const gaps: Gap[] = [];

    for (const relative of files) {
      const contents = await fs.readFile(path.join(context.root, relative), 'utf8');
      applyStatements(relative, contents, tables, gaps);
    }

    const entries: SchemaEntry[] = [...tables.values()]
      .map((table) => ({
        id: `schema:table:${table.name}`,
        source: table.source,
        extractionMethod: 'schema' as const,
        certainty: 'high' as const,
        name: table.name,
        kind: 'table' as const,
        fields: [...table.columns.values()],
        indexes: table.indexes,
        relations: table.relations,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { entries, gaps };
  },
};

interface MutableTable {
  name: string;
  source: { file: string; line: number };
  columns: Map<string, SchemaField>;
  indexes: SchemaIndex[];
  relations: SchemaRelation[];
}

/** Split SQL into statements, respecting quotes, comments, and dollar-quoted bodies. */
export function splitStatements(sql: string): readonly { text: string; line: number }[] {
  const statements: { text: string; line: number }[] = [];
  let buffer = '';
  let line = 1;
  let startLine = 1;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | undefined;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] as string;
    const next = sql[index + 1];

    if (char === '\n') {
      line += 1;
      inLineComment = false;
    }

    if (inLineComment) continue;
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    // Inside a $$...$$ body, semicolons are not statement terminators. The
    // text is still kept: dropping it would leave an empty statement that
    // vanishes from the output entirely.
    if (dollarTag !== undefined) {
      if (sql.startsWith(dollarTag, index)) {
        buffer += dollarTag;
        index += dollarTag.length - 1;
        dollarTag = undefined;
      } else {
        buffer += char;
      }
      continue;
    }

    if (!inSingle && !inDouble) {
      if (char === '-' && next === '-') {
        inLineComment = true;
        continue;
      }
      if (char === '/' && next === '*') {
        inBlockComment = true;
        index += 1;
        continue;
      }
      const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(index));
      if (dollar !== null) {
        dollarTag = dollar[0];
        if (buffer.length === 0) startLine = line;
        buffer += dollarTag;
        index += dollarTag.length - 1;
        continue;
      }
    }

    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;

    if (char === ';' && !inSingle && !inDouble) {
      if (buffer.trim().length > 0) statements.push({ text: buffer.trim(), line: startLine });
      buffer = '';
      startLine = line;
      continue;
    }

    if (buffer.length === 0 && /\S/.test(char)) startLine = line;
    buffer += char;
  }

  if (buffer.trim().length > 0) statements.push({ text: buffer.trim(), line: startLine });
  return statements;
}

const CREATE_TABLE = /^create\s+table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)\s*\(([\s\S]*)\)[^)]*$/i;
const ALTER_ADD = /^alter\s+table\s+(?:if\s+exists\s+)?([^\s]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([\s\S]+)$/i;
const ALTER_DROP = /^alter\s+table\s+(?:if\s+exists\s+)?([^\s]+)\s+drop\s+column\s+(?:if\s+exists\s+)?([^\s;]+)/i;
const DROP_TABLE = /^drop\s+table\s+(?:if\s+exists\s+)?([^\s;]+)/i;
const CREATE_INDEX = /^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([^\s]+)\s+on\s+([^\s(]+)\s*\(([^)]*)\)/i;

function applyStatements(
  file: string,
  contents: string,
  tables: Map<string, MutableTable>,
  gaps: Gap[],
): void {
  for (const statement of splitStatements(contents)) {
    const text = statement.text;

    const created = CREATE_TABLE.exec(text);
    if (created !== null) {
      const name = normaliseIdentifier(created[1] as string);
      const table: MutableTable = tables.get(name) ?? {
        name,
        source: { file, line: statement.line },
        columns: new Map(),
        indexes: [],
        relations: [],
      };
      parseTableBody(created[2] as string, table, file, statement.line, gaps);
      tables.set(name, table);
      continue;
    }

    const dropped = DROP_TABLE.exec(text);
    if (dropped !== null) {
      tables.delete(normaliseIdentifier(dropped[1] as string));
      continue;
    }

    const added = ALTER_ADD.exec(text);
    if (added !== null) {
      const table = tables.get(normaliseIdentifier(added[1] as string));
      if (table !== undefined) {
        const column = parseColumn(added[2] as string);
        if (column !== undefined) table.columns.set(column.name, column);
      }
      continue;
    }

    const droppedColumn = ALTER_DROP.exec(text);
    if (droppedColumn !== null) {
      const table = tables.get(normaliseIdentifier(droppedColumn[1] as string));
      table?.columns.delete(normaliseIdentifier(droppedColumn[2] as string));
      continue;
    }

    const indexed = CREATE_INDEX.exec(text);
    if (indexed !== null) {
      const table = tables.get(normaliseIdentifier(indexed[3] as string));
      if (table !== undefined) {
        table.indexes.push({
          name: normaliseIdentifier(indexed[2] as string),
          fields: (indexed[4] as string)
            .split(',')
            .map((part) => normaliseIdentifier(part.trim().split(/\s+/)[0] ?? ''))
            .filter((part) => part.length > 0),
          ...(indexed[1] === undefined ? {} : { unique: true }),
        });
      }
    }
  }
}

/** Split a CREATE TABLE body on commas that are not inside parentheses. */
export function splitTopLevel(body: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let buffer = '';
  let inSingle = false;

  for (const char of body) {
    if (char === "'") inSingle = !inSingle;
    if (!inSingle) {
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if (char === ',' && depth === 0) {
        parts.push(buffer.trim());
        buffer = '';
        continue;
      }
    }
    buffer += char;
  }
  if (buffer.trim().length > 0) parts.push(buffer.trim());
  return parts;
}

const TABLE_CONSTRAINT = /^(constraint\s+|primary\s+key|foreign\s+key|unique\s*\(|check\s*\(|exclude\s+)/i;
const FOREIGN_KEY = /foreign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(]+)/i;
const INLINE_REFERENCES = /references\s+([^\s(]+)/i;

function parseTableBody(
  body: string,
  table: MutableTable,
  file: string,
  line: number,
  gaps: Gap[],
): void {
  for (const part of splitTopLevel(body)) {
    if (part.length === 0) continue;

    if (TABLE_CONSTRAINT.test(part)) {
      const foreign = FOREIGN_KEY.exec(part);
      if (foreign !== null) {
        table.relations.push({
          field: normaliseIdentifier((foreign[1] as string).split(',')[0]?.trim() ?? ''),
          targetModel: normaliseIdentifier(foreign[2] as string),
          cardinality: 'many-to-one',
        });
        continue;
      }
      const primary = /^primary\s+key\s*\(([^)]*)\)/i.exec(part);
      if (primary !== null) {
        for (const raw of (primary[1] as string).split(',')) {
          const key = normaliseIdentifier(raw.trim());
          const existing = table.columns.get(key);
          if (existing !== undefined) table.columns.set(key, { ...existing, isPrimaryKey: true });
        }
        continue;
      }
      const unique = /^unique\s*\(([^)]*)\)/i.exec(part);
      if (unique !== null) {
        table.indexes.push({
          fields: (unique[1] as string).split(',').map((raw) => normaliseIdentifier(raw.trim())),
          unique: true,
        });
      }
      continue;
    }

    const column = parseColumn(part);
    if (column === undefined) {
      gaps.push({
        extractor: 'schema',
        kind: 'sql-column-unreadable',
        message: `A column definition in '${table.name}' could not be parsed: ${part.slice(0, 60)}`,
        source: { file, line },
      });
      continue;
    }
    table.columns.set(column.name, column);

    const references = INLINE_REFERENCES.exec(part);
    if (references !== null) {
      table.relations.push({
        field: column.name,
        targetModel: normaliseIdentifier(references[1] as string),
        cardinality: 'many-to-one',
      });
    }
  }
}

export function parseColumn(definition: string): SchemaField | undefined {
  const match = /^("?[A-Za-z_][A-Za-z0-9_]*"?)\s+(.+)$/s.exec(definition.trim());
  if (match === null) return undefined;

  const name = normaliseIdentifier(match[1] as string);
  const rest = match[2] as string;
  const type = extractColumnType(rest);

  const notNull = /\bnot\s+null\b/i.test(rest);
  const isPrimaryKey = /\bprimary\s+key\b/i.test(rest);
  const isUnique = /\bunique\b/i.test(rest);
  const defaultValue = /\bdefault\s+((?:'[^']*')|(?:[^\s,]+(?:\([^)]*\))?))/i.exec(rest)?.[1];

  return {
    name,
    type,
    nullable: !notNull && !isPrimaryKey,
    ...(isPrimaryKey ? { isPrimaryKey: true } : {}),
    ...(isUnique ? { isUnique: true } : {}),
    ...(defaultValue === undefined ? {} : { defaultValue }),
  };
}

/** Words that end a type and begin a constraint clause. */
const TYPE_STOP_WORDS = new Set([
  'not',
  'null',
  'primary',
  'key',
  'unique',
  'default',
  'references',
  'check',
  'constraint',
  'generated',
  'collate',
]);

/**
 * Read a column's type from the text following its name.
 *
 * SQL types can be several words (`double precision`, `timestamp with time
 * zone`) and can carry parameters (`numeric(10,2)`) or an array suffix, so the
 * type runs until a constraint keyword appears. Matching greedily on "words and
 * spaces" instead swallowed `not null default` into the type.
 */
export function extractColumnType(rest: string): string {
  const tokens: string[] = [];
  let index = 0;

  while (index < rest.length) {
    while (index < rest.length && /\s/.test(rest[index] as string)) index += 1;
    if (index >= rest.length) break;

    const wordStart = index;
    while (index < rest.length && /[A-Za-z0-9_]/.test(rest[index] as string)) index += 1;
    let token = rest.slice(wordStart, index);
    if (token.length === 0) break;
    if (TYPE_STOP_WORDS.has(token.toLowerCase())) break;

    if (rest[index] === '(') {
      const parenStart = index;
      let depth = 0;
      while (index < rest.length) {
        const char = rest[index] as string;
        if (char === '(') depth += 1;
        else if (char === ')') {
          depth -= 1;
          if (depth === 0) {
            index += 1;
            break;
          }
        }
        index += 1;
      }
      token += rest.slice(parenStart, index);
    }

    while (rest.slice(index, index + 2) === '[]') {
      token += '[]';
      index += 2;
    }

    tokens.push(token);
  }

  return tokens.join(' ');
}

/** Strip quoting and any schema qualifier: `public."Orders"` -> `Orders`. */
function normaliseIdentifier(raw: string): string {
  const last = raw.trim().split('.').pop() ?? raw;
  return last.replace(/^["`[]|["`\]]$/g, '');
}
