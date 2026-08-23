import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { SchemaEntry, SchemaField, SchemaRelation } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { EMPTY_RESULT } from './types.js';
import type { SchemaProvider, SchemaProviderContext, SchemaProviderResult } from './types.js';
import { compareStrings } from '../../util/sort.js';

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

    const parsed: SchemaEntry[] = [];
    const gaps: Gap[] = [];
    const classes: PythonModelClass[] = [];

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

      const result = parsePythonModels(relative, contents);
      parsed.push(...result.entries);
      gaps.push(...result.gaps);
      classes.push(...result.classes);
    }

    // Cardinality of a SQLAlchemy `relationship()` is only knowable once every
    // model has been read: which side holds the foreign key is what decides it,
    // and that lives in the other class, usually in another file.
    const entries = resolveRelationshipCardinality(parsed, classes);

    if (entries.length > 0) {
      gaps.push({
        extractor: 'schema',
        kind: 'python-parsed-heuristically',
        message:
          `${entries.length} Python model(s) were read with pattern matching rather than a real parser. ` +
          'Field types and constraints should be verified before being relied on.',
      });
    }

    const derived = classes.filter((entry) => entry.tableNameDerived).map((entry) => entry.tableName);
    if (derived.length > 0) {
      gaps.push({
        extractor: 'schema',
        kind: 'django-table-name-derived',
        message:
          `${derived.length} Django model(s) declare no explicit db_table, so the table name was ` +
          "derived from Django's default of <app_label>_<modelname>: " +
          `${[...derived].sort(compareStrings).join(', ')}. The app label was taken from the ` +
          'package directory, which is the Django convention but can be overridden in the app config.',
      });
    }

    const implicit = classes.filter((entry) => entry.hasImplicitPrimaryKey).map((entry) => entry.tableName);
    if (implicit.length > 0) {
      gaps.push({
        extractor: 'schema',
        kind: 'django-implicit-primary-key',
        message:
          `${implicit.length} Django model(s) declare no primary key, so Django adds an implicit ` +
          `'id' column: ${[...implicit].sort(compareStrings).join(', ')}. Its concrete type follows ` +
          "the project's DEFAULT_AUTO_FIELD setting (AutoField or BigAutoField) and is not read here.",
      });
    }

    return entries.length === 0 && gaps.length === 0 ? EMPTY_RESULT : { entries, gaps };
  },
};

const CLASS_HEADER = /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*:/;
const ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^=]+)?=\s*(.+)$/;
const TABLE_NAME = /^\s*__tablename__\s*=\s*["']([^"']+)["']/;
const DB_TABLE = /^\s*db_table\s*=\s*["']([^"']+)["']/;
const APP_LABEL = /^\s*app_label\s*=\s*["']([^"']+)["']/;
/** `abstract = True` / `proxy = True` in a Django `class Meta`. Neither creates a table. */
const NO_TABLE_META = /^\s*(?:abstract|proxy)\s*=\s*True\b/;

const DJANGO_FIELD = /^models\.([A-Za-z]+)\s*\(([\s\S]*)$/;
const SQLALCHEMY_COLUMN = /^(?:mapped_column|Column)\s*\(([\s\S]*)$/;
/**
 * `relationship("Item", ...)` and `relationship(Item, ...)`.
 *
 * The unquoted alternative excludes an identifier followed by `=`, or
 * `relationship(back_populates="owner")` would be read as a relation to a class
 * named `back_populates`. The lookahead also forbids a further word character,
 * without which the match simply gives one back and lands on `back_populate`.
 */
const SQLALCHEMY_RELATIONSHIP =
  /^relationship\s*\(\s*(?:["']([A-Za-z_][A-Za-z0-9_]*)["']|([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_]|\s*=))?([\s\S]*)$/;

/**
 * What a parsed class contributes beyond its entry.
 *
 * Kept alongside the entries rather than inside them because it answers
 * cross-file questions — which side of a relationship holds the foreign key,
 * and which table names were derived rather than declared.
 */
export interface PythonModelClass {
  readonly file: string;
  readonly className: string;
  readonly tableName: string;
  readonly orm: 'django' | 'sqlalchemy';
  /** True when the table name came from Django's naming convention, not the source. */
  readonly tableNameDerived: boolean;
  /** True when Django will add the implicit `id` column recorded on the entry. */
  readonly hasImplicitPrimaryKey: boolean;
  /** Table names this class holds a ForeignKey to. */
  readonly foreignKeyTargets: readonly string[];
  /** `relationship()` fields whose cardinality needs the other class to decide. */
  readonly pendingRelations: readonly { readonly field: string; readonly targetClass: string }[];
}

export interface PythonModelParse {
  readonly entries: readonly SchemaEntry[];
  readonly gaps: readonly Gap[];
  readonly classes: readonly PythonModelClass[];
}

export function parsePythonModels(file: string, contents: string): PythonModelParse {
  const lines = contents.split(/\r?\n/);
  const entries: SchemaEntry[] = [];
  const gaps: Gap[] = [];
  const classes: PythonModelClass[] = [];

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
    const foreignKeyTargets: string[] = [];
    const pendingRelations: { field: string; targetClass: string }[] = [];
    let tableName: string | undefined;
    let appLabel: string | undefined;
    let createsNoTable = false;

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

      const declaredLabel = APP_LABEL.exec(line);
      if (declaredLabel?.[1] !== undefined) {
        appLabel = declaredLabel[1];
        index += 1;
        continue;
      }

      // An abstract base or a proxy is a Python class, not a table. Deriving a
      // name for one invents a table that does not exist in the database.
      if (NO_TABLE_META.test(line)) {
        createsNoTable = true;
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

      const field = readPythonField(name, expression, relations, {
        foreignKeyTargets,
        pendingRelations,
      });
      if (field !== undefined) fields.push(field);
    }

    if (createsNoTable) {
      // The class is real and its fields land on every concrete model that
      // inherits it — but this reader does not follow Django inheritance, so
      // those columns are absent from the tables below. Said outright, because
      // a table missing `created_at` otherwise reads as a schema defect.
      if (fields.length > 0) {
        gaps.push({
          extractor: 'schema',
          kind: 'python-abstract-model-not-expanded',
          message:
            `'${className}' is an abstract or proxy Django model, so it is not a table of its own. ` +
            `Its ${fields.length} field(s) are inherited by the concrete models below it, which ` +
            'docgen does not resolve — those tables are listed without them.',
          source: { file, line: startLine },
        });
      }
      continue;
    }
    if (fields.length === 0 && relations.length === 0) continue;

    // Django adds `id` to any model that declares no primary key of its own.
    // Omitting it showed a table with no key at all, which reads as a defect in
    // the schema rather than a limit of the reader.
    const hasImplicitPrimaryKey =
      isDjango && !fields.some((candidate) => candidate.isPrimaryKey === true);
    if (hasImplicitPrimaryKey) {
      fields.push({ name: 'id', type: 'AutoField', nullable: false, isPrimaryKey: true });
    }

    const derivedName = isDjango && tableName === undefined
      ? djangoTableName(file, className, appLabel)
      : undefined;
    const resolved = tableName ?? derivedName ?? className;

    entries.push({
      id: `schema:table:${resolved}`,
      source: { file, line: startLine },
      extractionMethod: 'regex',
      certainty: 'low',
      name: resolved,
      kind: 'table',
      ...(resolved === className ? {} : { modelName: className }),
      fields: [...fields].sort((a, b) =>compareStrings(a.name, b.name)),
      indexes: [],
      relations: [...relations].sort((a, b) =>compareStrings(a.field, b.field)),
    });

    classes.push({
      file,
      className,
      tableName: resolved,
      orm: isDjango ? 'django' : 'sqlalchemy',
      tableNameDerived: derivedName !== undefined,
      hasImplicitPrimaryKey,
      foreignKeyTargets,
      pendingRelations,
    });
  }

  return { entries, gaps, classes };
}

/**
 * Django's default table name: `<app_label>_<modelname>`, lowercased.
 *
 * The app label defaults to the name of the app package, which is the directory
 * holding `models.py` (or the parent of a `models/` package). Falling back to
 * the class name instead named a table `Tag` when the database holds `blog_tag`
 * — a statement about the datastore that the datastore does not agree with.
 * Returns undefined when no package directory can be identified, so the caller
 * degrades to the class name rather than inventing a prefix.
 */
export function djangoTableName(
  file: string,
  className: string,
  declaredAppLabel: string | undefined,
): string | undefined {
  const label = declaredAppLabel ?? appLabelFromPath(file);
  if (label === undefined) return undefined;
  return `${label}_${className.toLowerCase()}`;
}

function appLabelFromPath(file: string): string | undefined {
  const segments = path.posix.dirname(file).split('/').filter((segment) => segment.length > 0 && segment !== '.');
  // `blog/models/post.py` is a models package; the app is its parent.
  const withoutModelsPackage = segments[segments.length - 1] === 'models' ? segments.slice(0, -1) : segments;
  const label = withoutModelsPackage[withoutModelsPackage.length - 1];
  return label === undefined || label.length === 0 ? undefined : label.toLowerCase();
}

/**
 * Fill in the cardinality of every `relationship()` that needed another class.
 *
 * The side holding the foreign key is the many side. That is provable once both
 * classes have been read, so it is resolved here rather than guessed at parse
 * time — every `relationship()` used to be recorded as one-to-many, which
 * labelled the child side of an ordinary parent/child pair backwards.
 */
function resolveRelationshipCardinality(
  entries: readonly SchemaEntry[],
  classes: readonly PythonModelClass[],
): readonly SchemaEntry[] {
  const pending = classes.filter((entry) => entry.pendingRelations.length > 0);
  if (pending.length === 0) return entries;

  const byClassName = new Map<string, PythonModelClass>();
  for (const info of classes) {
    if (!byClassName.has(info.className)) byClassName.set(info.className, info);
  }
  const byEntryKey = new Map<string, PythonModelClass>();
  for (const info of pending) byEntryKey.set(`${info.file} ${info.tableName}`, info);

  return entries.map((entry) => {
    const owner = byEntryKey.get(`${entry.source.file} ${entry.name}`);
    if (owner === undefined) return entry;

    const targets = new Map(owner.pendingRelations.map((item) => [item.field, item.targetClass]));
    let changed = false;
    const relations = entry.relations.map((relation) => {
      const targetClass = targets.get(relation.field);
      if (targetClass === undefined || relation.cardinality !== undefined) return relation;

      const target = byClassName.get(targetClass);
      if (target === undefined) return relation;

      // Whichever class holds the ForeignKey is the many side.
      if (owner.foreignKeyTargets.includes(target.tableName)) {
        changed = true;
        return { ...relation, cardinality: 'many-to-one' as const };
      }
      if (target.foreignKeyTargets.includes(owner.tableName)) {
        changed = true;
        return { ...relation, cardinality: 'one-to-many' as const };
      }
      // Neither side proves it. Omitted rather than guessed (SPEC rule 5).
      return relation;
    });

    return changed ? { ...entry, relations } : entry;
  });
}

function readPythonField(
  name: string,
  expression: string,
  relations: SchemaRelation[],
  collect: {
    foreignKeyTargets: string[];
    pendingRelations: { field: string; targetClass: string }[];
  },
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
      collect.foreignKeyTargets.push(foreignKey);
    }

    return {
      name,
      type,
      nullable: !/\bnullable\s*=\s*False\b/.test(args) && !/\bprimary_key\s*=\s*True\b/.test(args),
      ...(/\bprimary_key\s*=\s*True\b/.test(args) ? { isPrimaryKey: true } : {}),
      ...(/\bunique\s*=\s*True\b/.test(args) ? { isUnique: true } : {}),
    };
  }

  const relationship = SQLALCHEMY_RELATIONSHIP.exec(expression.trim());
  if (relationship !== null) {
    const targetClass = relationship[1] ?? relationship[2];
    if (targetClass === undefined) return undefined;
    const args = relationship[3] ?? '';

    // An association table and an explicit scalar are stated outright; anything
    // else needs the other class, so it is left for the cross-file pass.
    if (/\bsecondary\s*=/.test(args)) {
      relations.push({ field: name, targetModel: targetClass, cardinality: 'many-to-many' });
      return undefined;
    }
    if (/\buselist\s*=\s*False\b/.test(args)) {
      relations.push({ field: name, targetModel: targetClass, cardinality: 'one-to-one' });
      return undefined;
    }

    relations.push({ field: name, targetModel: targetClass });
    collect.pendingRelations.push({ field: name, targetClass });
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
