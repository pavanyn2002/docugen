import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaExtractor } from '../src/extract/schema/index.js';
import { parsePrismaSchema } from '../src/extract/schema/prisma.js';
import { parseMongooseFile } from '../src/extract/schema/mongoose.js';
import { extractColumnType, parseColumn, splitStatements, splitTopLevel } from '../src/extract/schema/sql-ddl.js';
import { parsePythonModels } from '../src/extract/schema/python-models.js';
import { loadConfig } from '../src/config/load.js';
import type { SchemaEntry, SchemaResult } from '../src/types/entries.js';
import { createLogger } from '../src/util/logger.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TEST_DIR, 'fixtures');

const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

async function runOn(root: string): Promise<SchemaResult> {
  const config = await loadConfig({ root });
  return (await schemaExtractor.run({ root: config.root, config, logger: silent })) as SchemaResult;
}

const table = (result: SchemaResult, name: string): SchemaEntry | undefined =>
  result.entries.find((entry) => entry.name === name);

const field = (entry: SchemaEntry | undefined, name: string) =>
  entry?.fields.find((candidate) => candidate.name === name);

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-schema-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dir;
}

// ── Prisma ───────────────────────────────────────────────────────────────────

describe('Prisma schema', () => {
  it('extracts models with their mapped table name', async () => {
    const result = await runOn(path.join(FIXTURES, 'prisma-app'));
    expect(result.entries.map((entry) => entry.name).sort()).toEqual(['Order', 'users']);
  });

  it('records the model name when it differs from the table', async () => {
    const result = await runOn(path.join(FIXTURES, 'prisma-app'));
    expect(table(result, 'users')?.modelName).toBe('User');
  });

  it('reads nullability from the optional marker', async () => {
    const result = await runOn(path.join(FIXTURES, 'prisma-app'));
    expect(field(table(result, 'users'), 'name')?.nullable).toBe(true);
    expect(field(table(result, 'users'), 'email')?.nullable).toBe(false);
  });

  it('reads primary keys, uniqueness, and defaults', async () => {
    const result = await runOn(path.join(FIXTURES, 'prisma-app'));
    expect(field(table(result, 'users'), 'id')).toMatchObject({ isPrimaryKey: true });
    expect(field(table(result, 'users'), 'email')).toMatchObject({ isUnique: true });
    expect(field(table(result, 'users'), 'role')?.defaultValue).toBe('CUSTOMER');
  });

  // A field typed as another model is a relation, not a stored column.
  it('separates relations from scalar fields', async () => {
    const result = await runOn(path.join(FIXTURES, 'prisma-app'));
    const users = table(result, 'users');

    expect(users?.relations).toEqual([{ field: 'orders', targetModel: 'Order', cardinality: 'one-to-many' }]);
    expect(field(users, 'orders')).toBeUndefined();
  });

  it('reads block-level indexes', async () => {
    const result = await runOn(path.join(FIXTURES, 'prisma-app'));
    expect(table(result, 'users')?.indexes).toEqual([{ fields: ['email'] }]);
  });

  it('ignores enum blocks', () => {
    const parsed = parsePrismaSchema('s.prisma', 'enum Role { ADMIN USER }\n');
    expect(parsed.entries).toEqual([]);
  });
});

// ── Mongoose ─────────────────────────────────────────────────────────────────

describe('Mongoose schemas', () => {
  it('names the collection from the model() call', async () => {
    const result = await runOn(path.join(FIXTURES, 'mongoose-service'));
    expect(table(result, 'Order')).toBeDefined();
  });

  it('reads a descriptor field with its constraints', async () => {
    const result = await runOn(path.join(FIXTURES, 'mongoose-service'));
    const orderNo = field(table(result, 'Order'), 'orderNo');

    expect(orderNo).toMatchObject({ type: 'String', nullable: false, isUnique: true });
  });

  it('treats a ref as a relation', async () => {
    const result = await runOn(path.join(FIXTURES, 'mongoose-service'));
    expect(table(result, 'Order')?.relations).toContainEqual({
      field: 'userId',
      targetModel: 'User',
      cardinality: 'many-to-one',
    });
  });

  it('flattens subdocument arrays into dotted paths', async () => {
    const result = await runOn(path.join(FIXTURES, 'mongoose-service'));
    const names = table(result, 'Order')?.fields.map((f) => f.name) ?? [];

    expect(names).toContain('items.sku');
    expect(names).toContain('items.qty');
  });

  it('reads a shorthand array type', async () => {
    const result = await runOn(path.join(FIXTURES, 'mongoose-service'));
    expect(field(table(result, 'Order'), 'tags')?.type).toBe('[String]');
  });

  // Mongoose writes these itself; omitting them understates what is stored.
  it('includes timestamp fields when timestamps are enabled', async () => {
    const result = await runOn(path.join(FIXTURES, 'mongoose-service'));
    const names = table(result, 'Order')?.fields.map((f) => f.name) ?? [];

    expect(names).toContain('createdAt');
    expect(names).toContain('updatedAt');
  });

  it('reads schema.index() calls', async () => {
    const result = await runOn(path.join(FIXTURES, 'mongoose-service'));
    expect(table(result, 'Order')?.indexes).toContainEqual({ fields: ['orderNo'], unique: true });
  });

  // The collection name is what the database actually uses; without a model()
  // call it is genuinely unknown and must not be presented as confirmed.
  it('reports an unresolved collection name', () => {
    const parsed = parseMongooseFile(
      'a.ts',
      "import { Schema } from 'mongoose';\nconst LooseSchema = new Schema({ a: String });\n",
    );
    expect(parsed.gaps.some((gap) => gap.kind === 'collection-name-unresolved')).toBe(true);
  });

  it('reports a schema built from a value it cannot read', () => {
    const parsed = parseMongooseFile(
      'a.ts',
      "import { Schema } from 'mongoose';\nconst S = new Schema(buildFields());\n",
    );
    expect(parsed.gaps.some((gap) => gap.kind === 'schema-definition-not-literal')).toBe(true);
  });
});

// ── SQL DDL ──────────────────────────────────────────────────────────────────

describe('SQL statement splitting', () => {
  it('ignores semicolons inside string literals', () => {
    expect(splitStatements("insert into t values ('a;b'); select 1;")).toHaveLength(2);
  });

  it('ignores semicolons inside line comments', () => {
    expect(splitStatements('-- a; b\nselect 1;')).toHaveLength(1);
  });

  it('ignores semicolons inside dollar-quoted bodies', () => {
    const sql = '$$ begin; end $$; select 1;';
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it('splits a body only on top-level commas', () => {
    expect(splitTopLevel('a numeric(10,2), b text')).toEqual(['a numeric(10,2)', 'b text']);
  });
});

describe('SQL column parsing', () => {
  it('reads type, nullability, and default', () => {
    expect(parseColumn("amount_cents integer not null default 0")).toMatchObject({
      name: 'amount_cents',
      type: 'integer',
      nullable: false,
      defaultValue: '0',
    });
  });

  it('treats a primary key as non-nullable', () => {
    expect(parseColumn('id uuid primary key')).toMatchObject({ isPrimaryKey: true, nullable: false });
  });

  it('keeps a parameterised type intact', () => {
    expect(parseColumn('tracking text(64)')?.type).toBe('text(64)');
  });

  // Matching greedily on "words and spaces" swallowed `not null default` into
  // the type, so multi-word types need an explicit stop list.
  it.each([
    ['ratio double precision not null', 'double precision'],
    ['at timestamp with time zone default now()', 'timestamp with time zone'],
    ['label character varying(50) unique', 'character varying(50)'],
    ['price numeric(10,2) not null', 'numeric(10,2)'],
    ['tags text[] default \'{}\'', 'text[]'],
    ['id uuid primary key', 'uuid'],
  ])('reads the type from %s', (definition, expected) => {
    expect(parseColumn(definition)?.type).toBe(expected);
  });

  it('does not absorb constraint keywords into the type', () => {
    expect(extractColumnType('integer not null default 0')).toBe('integer');
    expect(extractColumnType('text references other(id)')).toBe('text');
  });
});

describe('SQL migrations fixture', () => {
  it('extracts every created table', async () => {
    const result = await runOn(path.join(FIXTURES, 'sql-migrations'));
    expect(result.entries.map((entry) => entry.name).sort()).toEqual(['customers', 'invoices']);
  });

  it('strips the schema qualifier from table names', async () => {
    const result = await runOn(path.join(FIXTURES, 'sql-migrations'));
    expect(table(result, 'customers')).toBeDefined();
  });

  it('reads a foreign key as a relation', async () => {
    const result = await runOn(path.join(FIXTURES, 'sql-migrations'));
    expect(table(result, 'invoices')?.relations).toContainEqual({
      field: 'customer_id',
      targetModel: 'customers',
      cardinality: 'many-to-one',
    });
  });

  it('reads a named index', async () => {
    const result = await runOn(path.join(FIXTURES, 'sql-migrations'));
    expect(table(result, 'invoices')?.indexes).toContainEqual({
      name: 'idx_invoices_customer',
      fields: ['customer_id'],
    });
  });

  // Migrations are a history: the final state is what the database has.
  it('applies a later ALTER ADD COLUMN', async () => {
    const result = await runOn(path.join(FIXTURES, 'sql-migrations'));
    expect(field(table(result, 'invoices'), 'currency')?.type).toBe('text');
  });

  it('applies a later DROP COLUMN', async () => {
    const result = await runOn(path.join(FIXTURES, 'sql-migrations'));
    expect(field(table(result, 'customers'), 'display_name')).toBeUndefined();
  });
});

// ── TypeORM and Sequelize ────────────────────────────────────────────────────

describe('TypeORM entities', () => {
  it('uses the table name from the decorator', async () => {
    const result = await runOn(path.join(FIXTURES, 'typeorm-app'));
    expect(table(result, 'photos')?.modelName).toBe('Photo');
  });

  it('reads column constraints and the generated primary key', async () => {
    const result = await runOn(path.join(FIXTURES, 'typeorm-app'));
    expect(field(table(result, 'photos'), 'id')).toMatchObject({ isPrimaryKey: true, nullable: false });
    expect(field(table(result, 'photos'), 'slug')).toMatchObject({ type: 'varchar', isUnique: true });
    expect(field(table(result, 'photos'), 'caption')?.nullable).toBe(true);
  });

  it('resolves a relation target from an arrow function', async () => {
    const result = await runOn(path.join(FIXTURES, 'typeorm-app'));
    expect(table(result, 'photos')?.relations).toContainEqual({
      field: 'album',
      targetModel: 'Album',
      cardinality: 'many-to-one',
    });
  });
});

describe('Sequelize models', () => {
  it('uses tableName from the options argument', async () => {
    const result = await runOn(path.join(FIXTURES, 'sequelize-app'));
    expect(table(result, 'tickets')?.modelName).toBe('Ticket');
  });

  it('reads DataTypes and allowNull', async () => {
    const result = await runOn(path.join(FIXTURES, 'sequelize-app'));
    expect(field(table(result, 'tickets'), 'reference')).toMatchObject({
      type: 'STRING',
      nullable: false,
      isUnique: true,
    });
    expect(field(table(result, 'tickets'), 'notes')?.type).toBe('TEXT');
  });

  it('reads a references block as a relation', async () => {
    const result = await runOn(path.join(FIXTURES, 'sequelize-app'));
    expect(table(result, 'tickets')?.relations).toContainEqual({
      field: 'eventId',
      targetModel: 'Events',
      cardinality: 'many-to-one',
    });
  });
});

// ── Python ───────────────────────────────────────────────────────────────────

describe('Python models', () => {
  it('reads a Django model and its db_table', async () => {
    const result = await runOn(path.join(FIXTURES, 'python-app'));
    expect(table(result, 'vendors')?.modelName).toBe('Vendor');
  });

  it('reads Django field constraints', async () => {
    const result = await runOn(path.join(FIXTURES, 'python-app'));
    expect(field(table(result, 'vendors'), 'name')).toMatchObject({ type: 'CharField', isUnique: true });
    expect(field(table(result, 'vendors'), 'gstin')?.nullable).toBe(true);
  });

  it('reads Django relations with their cardinality', async () => {
    const result = await runOn(path.join(FIXTURES, 'python-app'));
    const relations = table(result, 'vendors')?.relations ?? [];

    expect(relations).toContainEqual({ field: 'owner', targetModel: 'User', cardinality: 'many-to-one' });
    expect(relations).toContainEqual({ field: 'tags', targetModel: 'Tag', cardinality: 'many-to-many' });
  });

  it('reads a SQLAlchemy declarative model', async () => {
    const result = await runOn(path.join(FIXTURES, 'python-app'));
    expect(field(table(result, 'shipments'), 'tracking_no')).toMatchObject({
      type: 'String',
      nullable: false,
      isUnique: true,
    });
  });

  it('reads a SQLAlchemy ForeignKey', async () => {
    const result = await runOn(path.join(FIXTURES, 'python-app'));
    expect(table(result, 'shipments')?.relations).toContainEqual({
      field: 'vendor_id',
      targetModel: 'vendors',
      cardinality: 'many-to-one',
    });
  });

  it('ignores a plain class that is not a model', () => {
    const parsed = parsePythonModels('m.py', 'class Helper:\n    x = 1\n');
    expect(parsed.entries).toEqual([]);
  });

  // SPEC 6.1: a regex fallback must mark the entry low certainty, and the
  // reader must be told the parse was heuristic.
  it('marks Python entries as low certainty', async () => {
    const result = await runOn(path.join(FIXTURES, 'python-app'));
    const python = result.entries.filter((entry) => entry.extractionMethod === 'regex');

    expect(python.length).toBeGreaterThan(0);
    expect(python.every((entry) => entry.certainty === 'low')).toBe(true);
  });

  it('warns that Python was parsed heuristically', async () => {
    const result = await runOn(path.join(FIXTURES, 'python-app'));
    expect(result.gaps.some((gap) => gap.kind === 'python-parsed-heuristically')).toBe(true);
  });
});

// ── cross-provider behaviour ─────────────────────────────────────────────────

describe('multiple schema sources', () => {
  // Prisma generates its own migration SQL. Reading both double-counts every
  // table and reports the two as drifted, which is a fabricated finding.
  it('does not double-count Prisma-generated migrations', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"prisma":"^6.0.0"}}',
      'prisma/schema.prisma': 'model User {\n  id String @id\n  email String\n}\n',
      'prisma/migrations/2026_init/migration.sql':
        'create table "User" (id text primary key, email text);',
    });

    const result = await runOn(root);

    expect(result.entries).toHaveLength(1);
    expect(result.detected).toEqual(['prisma']);
    expect(result.gaps.some((gap) => gap.kind === 'duplicate-table-definition')).toBe(false);
  });

  // Two independent definitions of a table is real drift and only a human can
  // say which one the database matches.
  it('reports a table defined by two independent sources', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"mongoose":"^8.0.0"}}',
      'src/a.ts': "import mongoose, { Schema } from 'mongoose';\nconst A = new Schema({ x: String });\nmongoose.model('Thing', A);\n",
      'src/b.ts': "import mongoose, { Schema } from 'mongoose';\nconst B = new Schema({ y: Number });\nmongoose.model('Thing', B);\n",
    });

    const result = await runOn(root);
    const duplicate = result.gaps.find((gap) => gap.kind === 'duplicate-table-definition');

    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toContain('src/a.ts');
    expect(duplicate?.message).toContain('src/b.ts');
    expect(result.entries).toHaveLength(2);
  });
});

describe('degradation and determinism', () => {
  it('returns an inapplicable result when there is no schema source', async () => {
    const result = await runOn(path.join(FIXTURES, 'plain-node'));

    expect(result.applicable).toBe(false);
    expect(result.skips[0]?.kind).toBe('no-schema-source-detected');
  });

  it.each(['prisma-app', 'mongoose-service', 'sql-migrations', 'python-app'])(
    'is byte-identical across runs on %s',
    async (name) => {
      const root = path.join(FIXTURES, name);
      const strip = (result: SchemaResult): string => JSON.stringify({ ...result, durationMs: 0 });

      expect(strip(await runOn(root))).toBe(strip(await runOn(root)));
    },
  );

  it('sorts tables by name', async () => {
    const result = await runOn(path.join(FIXTURES, 'sql-migrations'));
    const names = result.entries.map((entry) => entry.name);
    expect(names).toEqual([...names].sort());
  });

  it('links every table to a source file', async () => {
    for (const name of ['prisma-app', 'mongoose-service', 'sql-migrations', 'typeorm-app']) {
      const result = await runOn(path.join(FIXTURES, name));
      expect(result.entries.every((entry) => entry.source.file.length > 0)).toBe(true);
    }
  });
});
