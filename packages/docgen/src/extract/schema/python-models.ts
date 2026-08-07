import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { SchemaEntry, SchemaField, SchemaRelation } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { EMPTY_RESULT } from './types.js';
import type { SchemaProvider, SchemaProviderContext, SchemaProviderResult } from './types.js';

/**
 * Django and SQLAlchemy models.
 *
 * This is the one provider that reads source code without a real parser, which
 * SPEC 6.1 permits only as a last resort: docgen is a Node tool and bundling a
 * Python parser is not justified for the coverage it buys. Every entry is
 * therefore marked `regex` / low certainty, and the extractor reports that
 * Python models were read heuristically so a reader knows to verify them.
 *
 * Model declarations are among the most regular Python there is — a class
 * header and one assignment per field — which is what makes this tolerable
 * rather than reckless. Anything less regular is skipped, not guessed.
 */
export const pythonModelsProvider: SchemaProvider = {
  id: 'python-models',
  name: 'Django / SQLAlchemy models',

  async run(context: SchemaProviderContext): Promise<SchemaProviderResult> {
    const files = (
      await fg(['**/*.py'], { cwd: context.root, ignore: [...context.exclude], onlyFiles: true })
    )
      .map(toPosix)
      .sort();

    if (files.length === 0) return EMPTY_RESULT;

    const entries: SchemaEntry[] = [];
    const gaps: Gap[] = [];

    for (const relative of files) {
      let contents: string;
      try {
        contents = await fs.readFile(path.join(context.root, relative), 'utf8');
      } catch {
        continue;
      }
      if (!/models\.Model|declarative_base|DeclarativeBase|__tablename__|\bColumn\s*\(/.test(contents)) {
        continue;
      }

      const parsed = parsePythonModels(relative, contents);
      entries.push(...parsed.entries);
      gaps.push(...parsed.gaps);
    }

    if (entries.length > 0) {
      gaps.push({
        extractor: 'schema',
        kind: 'python-parsed-heuristically',
        message:
          `${entries.length} Python model(s) were read with pattern matching rather than a real parser. ` +
          'Field types and constraints should be verified before being relied on.',
      });
    }

    return entries.length === 0 && gaps.length === 0 ? EMPTY_RESULT : { entries, gaps };
  },
};

const CLASS_HEADER = /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:/;
const ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^=]+)?=\s*(.+)$/;
const TABLE_NAME = /^\s*__tablename__\s*=\s*["']([^"']+)["']/;
const DB_TABLE = /^\s*db_table\s*=\s*["']([^"']+)["']/;

const DJANGO_FIELD = /^models\.([A-Za-z]+)\s*\(([\s\S]*)$/;
const SQLALCHEMY_COLUMN = /^(?:mapped_column|Column)\s*\(([\s\S]*)$/;

export function parsePythonModels(
  file: string,
  contents: string,
): { entries: readonly SchemaEntry[]; gaps: readonly Gap[] } {
  const lines = contents.split(/\r?\n/);
  const entries: SchemaEntry[] = [];
  const gaps: Gap[] = [];

  let index = 0;
  while (index < lines.length) {
    const header = CLASS_HEADER.exec(lines[index] as string);
    if (header === null) {
      index += 1;
      continue;
    }

    const indent = (header[1] as string).length;
    const className = header[2] as string;
    const bases = header[3] as string;
    const startLine = index + 1;

    const isDjango = /models\.Model|\bModel\b/.test(bases);
    const isSqlAlchemy = /Base|DeclarativeBase/.test(bases);
    if (!isDjango && !isSqlAlchemy) {
      index += 1;
      continue;
    }

    const fields: SchemaField[] = [];
    const relations: SchemaRelation[] = [];
    let tableName: string | undefined;

    index += 1;
    while (index < lines.length) {
      const line = lines[index] as string;
      if (line.trim().length === 0) {
        index += 1;
        continue;
      }
      // Dedent to or past the class header ends the body.
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) break;

      const explicitTable = TABLE_NAME.exec(line) ?? DB_TABLE.exec(line);
      if (explicitTable?.[1] !== undefined) {
        tableName = explicitTable[1];
        index += 1;
        continue;
      }

      const assignment = ASSIGNMENT.exec(line);
      if (assignment === null) {
        index += 1;
        continue;
      }

      const name = assignment[1] as string;
      if (name.startsWith('__')) {
        index += 1;
        continue;
      }

      // A call can span lines; gather until parentheses balance.
      let expression = assignment[2] as string;
      let cursor = index;
      while (unbalanced(expression) && cursor + 1 < lines.length) {
        cursor += 1;
        expression += ` ${(lines[cursor] as string).trim()}`;
      }
      index = cursor + 1;

      const field = readPythonField(name, expression, relations);
      if (field !== undefined) fields.push(field);
    }

    if (fields.length === 0 && relations.length === 0) continue;

    const resolved = tableName ?? className;
    entries.push({
      id: `schema:table:${resolved}`,
      source: { file, line: startLine },
      extractionMethod: 'regex',
      certainty: 'low',
      name: resolved,
      kind: 'table',
      ...(resolved === className ? {} : { modelName: className }),
      fields: [...fields].sort((a, b) => a.name.localeCompare(b.name)),
      indexes: [],
      relations: [...relations].sort((a, b) => a.field.localeCompare(b.field)),
    });
  }

  return { entries, gaps };
}

function readPythonField(
  name: string,
  expression: string,
  relations: SchemaRelation[],
): SchemaField | undefined {
  const django = DJANGO_FIELD.exec(expression.trim());
  if (django !== null) {
    const type = django[1] as string;
    const args = django[2] as string;

    if (type === 'ForeignKey' || type === 'OneToOneField' || type === 'ManyToManyField') {
      const target = /^\s*["']?([A-Za-z_][A-Za-z0-9_.]*)["']?/.exec(args)?.[1];
      relations.push({
        field: name,
        targetModel: target ?? 'unknown',
        cardinality:
          type === 'ManyToManyField'
            ? 'many-to-many'
            : type === 'OneToOneField'
              ? 'one-to-one'
              : 'many-to-one',
      });
    }

    return {
      name,
      type,
      nullable: /\bnull\s*=\s*True\b/.test(args),
      ...(/\bprimary_key\s*=\s*True\b/.test(args) ? { isPrimaryKey: true } : {}),
      ...(/\bunique\s*=\s*True\b/.test(args) ? { isUnique: true } : {}),
    };
  }

  const column = SQLALCHEMY_COLUMN.exec(expression.trim());
  if (column !== null) {
    const args = column[1] as string;
    const type = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(args)?.[1] ?? 'unknown';

    const foreignKey = /ForeignKey\s*\(\s*["']([^"'.]+)/.exec(args)?.[1];
    if (foreignKey !== undefined) {
      relations.push({ field: name, targetModel: foreignKey, cardinality: 'many-to-one' });
    }

    return {
      name,
      type,
      nullable: !/\bnullable\s*=\s*False\b/.test(args) && !/\bprimary_key\s*=\s*True\b/.test(args),
      ...(/\bprimary_key\s*=\s*True\b/.test(args) ? { isPrimaryKey: true } : {}),
      ...(/\bunique\s*=\s*True\b/.test(args) ? { isUnique: true } : {}),
    };
  }

  const relationship = /^relationship\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/.exec(expression.trim());
  if (relationship?.[1] !== undefined) {
    relations.push({ field: name, targetModel: relationship[1], cardinality: 'one-to-many' });
  }

  return undefined;
}

function unbalanced(expression: string): boolean {
  let depth = 0;
  for (const char of expression) {
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
  }
  return depth > 0;
}
