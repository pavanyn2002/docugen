import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateStaticString, type StaticModule } from '../src/extract/endpoints/static-string.js';
import { readModuleBindings } from '../src/util/modules.js';
import { parseSourceFile, ts } from '../src/util/ts-ast.js';
import { parsePrismaSchema } from '../src/extract/schema/prisma.js';
import { parseMongooseFile } from '../src/extract/schema/mongoose.js';
import { parseTypeormFile, parseSequelizeFile } from '../src/extract/schema/decorated-orm.js';
import { parsePythonModels, djangoTableName, pythonModelsProvider } from '../src/extract/schema/python-models.js';
import { extractColumnType, parseColumn, splitStatements, splitTopLevel, sqlDdlProvider } from '../src/extract/schema/sql-ddl.js';
import { parseManifestDependencies } from '../src/detect/stack.js';
import { detectStack } from '../src/detect/stack.js';
import { findWorkspaces, readIfPresent } from '../src/detect/workspaces.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function repository(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-parser-coverage-'));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents);
  }
  return root;
}

async function evaluate(expression: string, contents = '', imported: Record<string, string> = {}) {
  const modules = new Map<string, StaticModule>();
  for (const [file, text] of Object.entries({ 'main.ts': `${contents}\nconst result = ${expression};`, ...imported })) {
    const source = parseSourceFile(file, text);
    modules.set(file, { file, source, bindings: readModuleBindings(source) });
  }
  const module = modules.get('main.ts')!;
  const declaration = (module.source.statements.at(-1) as ts.VariableStatement).declarationList.declarations[0]!;
  return evaluateStaticString({ module, expression: declaration.initializer!, files: new Set(modules.keys()), aliases: [], loadModule: async file => modules.get(file) });
}

describe('static mount path evaluation boundaries', () => {
  it.each([
    ["'/'", '', '/', true],
    ["(('api' as string)!)", '', 'api', true],
    ["(<string>'/typed')", '', '/typed', true],
    ["('/typed' satisfies string)", '', '/typed', true],
    ["prefix + '/users'", "const prefix = '/v1';", '/v1/users', true],
    ["unknown + '/users'", '', '{unknown}/users', false],
    ["`/${missing}/${prefix}/end`", "const prefix = 'api';", '/{missing}/api/end', false],
    ['a', 'const a = b; const b = a;', '{a}', false],
    ['options.base', "const options = { base: '/api' };", '/api', true],
    ["options['base']", "const options = { base: '/api' };", '/api', true],
    ['options[key]', "const options = { base: '/api' };", '{options[key]}', false],
    ['options.missing', "const options = { base: '/api' };", '{options.missing}', false],
    ["options['missing']", "const options = { base: '/api' };", "{options['missing']}", false],
    ['missing.base', '', '{missing.base}', false],
    ["missing['base']", '', "{missing['base']}", false],
    ['makeOptions().base', '', '{makeOptions().base}', false],
    ['options.base', "const options = '/not-an-object';", '{options.base}', false],
    ['options.group.base', "const options = { group: { base: '/deep' } };", '/deep', true],
    ["({ base: '/literal-object' }).base", '', '/literal-object', true],
    ['options.missing.base', 'const options = {};', '{options.missing.base}', false],
    ['unknown.group.base', '', '{unknown.group.base}', false],
    ['options.base', "const base = '/api'; const options = { ...other, base, method() {}, [1]: '/one', 'other': '/two' };", '{options.base}', false],
    ["options['1']", "const options = { [1]: '/computed', 1: '/numeric' };", '/numeric', true],
    ['declared', 'let declared;', '{declared}', false],
    ['10 * 2', '', '{10 * 2}', false],
  ] as const)('evaluates %s conservatively', async (expression, contents, value, complete) => {
    expect(await evaluate(expression, contents)).toMatchObject({ value, complete, original: expression });
  });

  it('stops expansion of arbitrarily long constant chains', async () => {
    const contents = Array.from({ length: 20 }, (_, index) => `const value${index} = value${index + 1};`).join('\n') + "\nconst value20 = '/api';";
    expect(await evaluate('value0', contents)).toMatchObject({ complete: false, value: '{value17}' });
  });

  it.each(['path', 'options.base', "options['base']"])('keeps %s unknown if an imported source disappears after binding resolution', async expression => {
    const source = parseSourceFile('main.ts', `import { path, options } from './constants'; const result = ${expression};`);
    const importedSource = parseSourceFile('constants.ts', "export const path = '/api'; export const options = { base: '/api' };");
    const module = { file: 'main.ts', source, bindings: readModuleBindings(source) };
    const imported = { file: 'constants.ts', source: importedSource, bindings: readModuleBindings(importedSource) };
    let reads = 0;
    const declaration = (source.statements.at(-1) as ts.VariableStatement).declarationList.declarations[0]!;
    const result = await evaluateStaticString({ module, expression: declaration.initializer!, files: new Set(['main.ts', 'constants.ts']), aliases: [], loadModule: async file => file === 'main.ts' ? module : file === 'constants.ts' && reads++ === 0 ? imported : undefined });
    expect(result).toMatchObject({ value: `{${expression}}`, complete: false });
  });

  it.each([
    ['base', "import { base } from './constants';", "export const base = '/api';", '/api', true],
    ['base', "import base from './constants';", "export default '/default';", '/default', true],
    ['base', "import base from './constants';", "const privateBase = '/named'; export { privateBase as default };", '/named', true],
    ['base', "import { base } from './constants';", 'export function base() {}', '{base}', false],
    ['options.base', "import { options } from './constants';", "export const options = { base: '/imported' };", '/imported', true],
    ['options.base', "import options from './constants';", "export default { base: '/default-object' };", '/default-object', true],
    ['options.base', "import { options } from './constants';", 'export function options() {}', '{options.base}', false],
    ['base', "import { base } from 'external';", '', '{base}', false],
    ['options.base', "import { options } from 'external';", '', '{options.base}', false],
    ['base', "import { base } from './constants';", "import { base as other } from './main'; export const base = other;", '{other}', false],
  ] as const)('resolves imported %s', async (expression, contents, imported, value, complete) => {
    expect(await evaluate(expression, contents, { 'constants.ts': imported })).toMatchObject({ value, complete });
  });
});

describe('schema parsers preserve uncertainty', () => {
  it('ignores unsupported Prisma attributes and emits empty-model gaps', () => {
    const result = parsePrismaSchema('schema.prisma', `enum Missing {
      NEVER
    }
    model Empty {
      @@map(computed)
      @@index(noFields)
      @@unique([])
      @@unknown([a])
      // comment

      !invalid
    }
    model Parent {
      labels String[]
      z Int
      id Int @id
      a String @unique
      children Child[]
      otherChild Child?
      @@id([id, z])
      @@unique([a, , 'z'])
    }
    model Child {
      parent Parent
    }
    enum Unterminated { VALUE`);
    expect(result.entries.map(entry => entry.name)).toEqual(['Empty', 'Parent', 'Child']);
    expect(result.gaps).toEqual([expect.objectContaining({ kind: 'empty-model' })]);
    expect(result.entries[1]?.fields[0]).toMatchObject({ name: 'id', isPrimaryKey: true });
    expect(result.entries[1]?.fields.find(field => field.name === 'labels')?.type).toBe('String[]');
    expect(result.entries[1]?.indexes).toEqual([{ fields: ['id', 'z'] }, { fields: ['a', 'z'], unique: true }]);
    expect(result.entries[2]?.relations).toEqual([{ field: 'parent', targetModel: 'Parent', cardinality: 'many-to-one' }]);
  });

  it('handles unassigned and malformed mongoose schemas without guessing fields', () => {
    const result = parseMongooseFile('models.ts', `
      new Other(); new Schema; new Schema(dynamic); new Schema({});
      const { schema } = { schema: new Schema({ 'text': String, [dynamic]: String }) };
      const complex = new mongoose.Schema({
        ...base, shortcut, method() {}, [dynamic]: String,
        title: ns.Custom, refs: [Schema.Types.ObjectId], empty: [], invalid: [12],
        nested: [{ label: String }], described: [{ type: String }],
        address: { city: String },
        unknown: 12, dynamic: { type: factory(), default: 7 },
        emptyType: { type: [] }, listType: { type: [Schema.Types.ObjectId], ref: 'User' },
        invalidType: { type: [12] }, createdAt: Date, updatedAt: Date
        , owner: { type: Schema.Types.ObjectId, ref: 'Owner' }
      }, { timestamps: true });
      complex.index({ title: 1 }); complex.index({ title: -1 }, runtime);
      complex.index({ ...keys }); complex.index(); complex.index(dynamic);
      owner.schema.index({ a: 1 }); index({ a: 1 });
      complex.index({ 'title': 1 }, { unique: true });
      model(dynamic, complex); model('Wrong', {}); model('Complex', complex);
      (factory())();
    `);
    const entry = result.entries.find(entry => entry.name === 'Complex')!;
    expect(entry.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'title', type: 'ns.Custom' }),
      expect.objectContaining({ name: 'empty', type: '[unknown]' }),
      expect.objectContaining({ name: 'invalid', type: '[unknown]' }),
      expect.objectContaining({ name: 'nested.label', type: 'String' }),
      expect.objectContaining({ name: 'described', type: 'String' }),
      expect.objectContaining({ name: 'dynamic', type: 'unknown', defaultValue: '7' }),
    ]));
    expect(entry.fields.filter(field => ['createdAt', 'updatedAt'].includes(field.name))).toHaveLength(2);
    expect(entry.relations).toEqual([{ field: 'listType', targetModel: 'User', cardinality: 'one-to-many' }, { field: 'owner', targetModel: 'Owner', cardinality: 'many-to-one' }]);
    expect(entry.indexes).toHaveLength(3);
    expect(result.gaps.map(gap => gap.kind)).toEqual(expect.arrayContaining(['schema-definition-not-literal', 'collection-name-unresolved', 'field-type-unreadable']));
  });

  it('reads all TypeORM column forms and reports unresolved relation targets', () => {
    const result = parseTypeormFile('entity.ts', `
      export default class {}
      class Undecorated {}
      @Entity() class Example {
        @Bare @ns.Other() @PrimaryColumn() key?: string;
        @Column() optional?: number;
        @Column({ type: 'decimal', nullable: true, unique: true }) amount: number;
        @Column() unknown;
        @CreateDateColumn() created: Date;
        @UpdateDateColumn() updated: Date;
        @ManyToMany('Tag') tags;
        @OneToMany(() => Child) children;
        @ManyToOne(() => factory()) dynamic;
        @OneToOne() missing;
        @Column() 'ignored': string;
        method() {}
      }
    `);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.name).toBe('Example');
    expect(entry.fields).toEqual(expect.arrayContaining([
      { name: 'key', type: 'string', nullable: false, isPrimaryKey: true },
      { name: 'optional', type: 'number', nullable: true },
      { name: 'amount', type: 'decimal', nullable: true, isUnique: true },
      { name: 'unknown', type: 'unknown', nullable: false },
    ]));
    expect(entry.relations).toHaveLength(4);
    expect(result.gaps.map(gap => gap.kind)).toEqual(['relation-target-unresolved', 'relation-target-unresolved']);
  });

  it('reads Sequelize init, omitted types, invalid references and unknown model names', () => {
    const result = parseSequelizeFile('models.js', `
      define('ignored', {}); sequelize.define(); sequelize.define('bad', runtime);
      factory().init({ field: DataTypes.STRING });
      Empty.init({ ...base });
      Model.init({
        plain: CustomType, sized: DataTypes.STRING(30),
        missing: { allowNull: false },
        ref: { type: DataTypes.INTEGER, references: { model: dynamic } },
        valid: { type: DataTypes.INTEGER, references: { model: 'Owner' }, primaryKey: true, unique: true },
        second: { type: DataTypes.INTEGER, references: { model: 'Second' } },
        external: { references: runtime }, 'ignored': DataTypes.STRING, ...base
      }, { tableName: dynamic });
      sequelize.define(dynamic, { value: DataTypes.STRING }, runtime);
    `);
    expect(result.entries.map(entry => entry.name)).toEqual(['Empty', 'Model', 'sequelize']);
    expect(result.gaps.map(gap => gap.kind)).toEqual(['empty-model']);
    const entry = result.entries[1]!;
    expect(entry.fields).toEqual(expect.arrayContaining([
      { name: 'missing', type: 'unknown', nullable: false },
      { name: 'plain', type: 'CustomType', nullable: true },
      { name: 'sized', type: 'STRING', nullable: true },
    ]));
    expect(entry.relations).toEqual([{ field: 'second', targetModel: 'Second', cardinality: 'many-to-one' }, { field: 'valid', targetModel: 'Owner', cardinality: 'many-to-one' }]);
  });

  it('retains incomplete Python declarations and skips tableless models', () => {
    const result = parsePythonModels('models.py', `class Plain(object):
    pass
class Empty(models.Model):
    pass
class Abstract(models.Model):
    class Meta:
        abstract = True
class Foreign(models.Model):
    __ignored = models.CharField()
    value = 10
    owner = models.ForeignKey(123)
    own = models.OneToOneField('Owner')
    tags = models.ManyToManyField('Tag')
class Untyped(Base):
    field = Column(123)
    ambiguous = relationship('Other')
    typed = relationship(Other)
class Unfinished(models.Model):
    name = models.CharField(
`);
    expect(result.entries.map(entry => entry.name)).toEqual(['Foreign', 'Untyped', 'Unfinished']);
    expect(result.entries[0]?.relations[1]).toMatchObject({ field: 'owner', targetModel: 'unknown' });
    expect(result.entries[1]?.fields).toEqual([{ name: 'field', type: 'unknown', nullable: true }]);
    expect(djangoTableName('blog/models/post.py', 'Post', undefined)).toBe('blog_post');
    expect(djangoTableName('models.py', 'Post', undefined)).toBeUndefined();
  });

  it('resolves Python relationship cardinality only when an actual foreign key proves it', async () => {
    const root = await repository({ 'app/models.py': `from sqlalchemy import Column
class Parent(Base):
    __tablename__ = 'parents'
    id = Column(Integer, primary_key=True)
    children = relationship('Child')
    unrelated = relationship('Other')
    missing = relationship('Missing')
    fixed = relationship('Child', uselist=False)
class Child(Base):
    __tablename__ = 'children'
    parent_id = Column(Integer, ForeignKey('parents.id'))
    parent = relationship('Parent')
class Other(Base):
    id = Column(Integer)
class Parent(Base):
    __tablename__ = 'otherparents'
    id = Column(Integer)
` });
    const result = await pythonModelsProvider.run({ root, exclude: [] });
    expect(result.entries.find(entry => entry.name === 'parents')?.relations).toEqual(expect.arrayContaining([
      { field: 'children', targetModel: 'Child', cardinality: 'one-to-many' },
      { field: 'fixed', targetModel: 'Child', cardinality: 'one-to-one' },
      { field: 'missing', targetModel: 'Missing' },
      { field: 'unrelated', targetModel: 'Other' },
    ]));
    expect(result.entries.find(entry => entry.name === 'children')?.relations).toEqual(expect.arrayContaining([{ field: 'parent', targetModel: 'Parent', cardinality: 'many-to-one' }]));
  });
});

describe('SQL migration parsing boundaries', () => {
  it('splits quoted, commented and dollar-delimited bodies without losing statements', () => {
    expect(splitStatements(`; -- skipped\n/* skipped * x */\n$body$ select ';'; $body$;\nCREATE TABLE "Odd;Name" (name text DEFAULT 'a;b');\nSELECT 1`)).toEqual([
      { text: "$body$ select ';'; $body$", line: 3 },
      { text: `CREATE TABLE "Odd;Name" (name text DEFAULT 'a;b')`, line: 4 },
      { text: 'SELECT 1', line: 5 },
    ]);
    expect(splitTopLevel("a text DEFAULT 'a,(b)', b numeric(10, 2),")).toEqual(["a text DEFAULT 'a,(b)'", 'b numeric(10, 2)']);
    expect(splitStatements('/* unclosed')).toEqual([]);
    expect(splitStatements('CREATE FUNCTION demo() RETURNS void AS $$ BEGIN SELECT 1; END; $$ LANGUAGE SQL;')).toEqual([{ text: 'CREATE FUNCTION demo() RETURNS void AS $$ BEGIN SELECT 1; END; $$ LANGUAGE SQL', line: 1 }]);
  });

  it.each([
    ['', ''], ['  ', ''], ['@bad', ''], ['NOT NULL', ''],
    ['numeric(10,(2))[][]   ', 'numeric(10,(2))[][]'],
    ['numeric(10,2', 'numeric(10,2'], ['timestamp with time zone', 'timestamp with time zone'],
  ])('reads SQL type %s', (value, expected) => { expect(extractColumnType(value)).toBe(expected); });

  it('applies only readable migration changes to existing tables', async () => {
    const root = await repository({ 'db/migrations/001.sql': `
      CREATE TABLE items (id integer, owner integer REFERENCES owners(id), broken,
        PRIMARY KEY (id, missing), FOREIGN KEY (owner,id) REFERENCES owners(id),
        UNIQUE (owner, id), CHECK (id > 0), EXCLUDE (owner));
      CREATE TABLE IF NOT EXISTS items (extra text);
      CREATE TABLE gone (id integer);
      DROP TABLE gone;
      ALTER TABLE items ADD COLUMN broken;
      ALTER TABLE missing ADD COLUMN value text;
      ALTER TABLE missing DROP COLUMN unknown;
      ALTER TABLE items DROP COLUMN extra;
      CREATE INDEX items_owner ON items (owner DESC, id ASC);
      CREATE UNIQUE INDEX items_unique ON items (id);
      CREATE INDEX missing_index ON missing (value);
      CREATE TABLE empty_parts (, id integer,,);
      DROP TABLE empty_parts;
      SELECT 1;
    ` });
    const result = await sqlDdlProvider.run({ root, exclude: [] });
    expect(result.entries.map(entry => entry.name)).toEqual(['items']);
    expect(result.entries[0]?.fields.map(field => field.name)).toEqual(['id', 'owner']);
    expect(result.entries[0]?.fields[0]?.isPrimaryKey).toBe(true);
    expect(result.entries[0]?.indexes).toEqual([{ fields: ['owner', 'id'], unique: true }, { name: 'items_owner', fields: ['owner', 'id'] }, { name: 'items_unique', fields: ['id'], unique: true }]);
    expect(result.gaps).toEqual([expect.objectContaining({ kind: 'sql-column-unreadable' })]);
    expect(parseColumn('broken')).toBeUndefined();
  });
});

describe('manifest format boundaries', () => {
  it('reads Rust manifest dependencies and combines multiple manifest files in one workspace', async () => {
    const root = await repository({ 'Cargo.toml': '[dependencies]\nactix-web = "4"\nserde = "1"\n# ignored\n', 'package.json': '{}', 'service/package.json': '{"dependencies":{"express":"*"}}', 'service/requirements.txt': '# comment\nfastapi>=1\n', 'service/pyproject.toml': '[dependencies]\nfastapi = "*"' });
    expect(parseManifestDependencies('Cargo.toml', await fs.readFile(path.join(root, 'Cargo.toml'), 'utf8'))).toEqual(['actix-web', 'serde']);
    expect(await findWorkspaces(root, [])).toEqual([{ dir: '', manifests: ['Cargo.toml', 'package.json'] }, { dir: 'service', manifests: ['package.json', 'pyproject.toml', 'requirements.txt'] }]);
    expect(await readIfPresent(path.join(root, 'absent'))).toBeUndefined();
    expect((await detectStack({ root, exclude: [] })).technologies.map(technology => technology.id)).toEqual(expect.arrayContaining(['express', 'fastapi']));
    expect((await detectStack({ root, exclude: [] })).technologies.filter(technology => technology.id === 'fastapi')).toHaveLength(1);
  });

  it.each([
    ['package.json', 'null', []], ['package.json', '7', []],
    ['composer.json', '{', []], ['composer.json', 'null', []], ['composer.json', 'false', []],
    ['composer.json', '{"require":{"laravel/framework":"*"},"require-dev":{"phpunit/phpunit":"*"}}', ['laravel/framework', 'phpunit/phpunit']],
    ['composer.json', '{"require":null,"require-dev":7}', []],
    ['pom.xml', '<artifactId>spring-web</artifactId>\n<artifactId>spring-web</artifactId>', ['spring-web']],
    ['build.gradle.kts', 'implementation("org.springframework:spring-web:6.0")', ['org.springframework:spring-web']],
    ['Pipfile', '[packages]\n"fastapi" = "*"\n# ignored', ['fastapi']],
    ['pyproject.toml', 'dependencies = [\n "fastapi>=1",\n "django[all]>=5"\n]', ['dependencies', 'fastapi', 'django']],
    ['requirements.txt', '# ignored\n-r nested.txt\n[extra]\n', []],
    ['unknown.json', '{}', []],
  ] as const)('reads %s safely', (file, contents, expected) => {
    expect(parseManifestDependencies(file, contents)).toEqual(expected);
  });
});
