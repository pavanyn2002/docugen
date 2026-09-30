import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { enrichGraphWithTypeScriptSymbols } from '../src/graph/symbols.js';
import { enrichGraphWithPythonSymbols } from '../src/graph/python-symbols.js';
import type { EvidenceGraph, GraphNode } from '../src/graph/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-symbol-boundaries-'));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents);
  }
  return root;
}
const provenance = { origin: 'extracted' as const, extractionMethods: ['ast' as const], certainty: 'high' as const, evidence: [{ file: 'schema.prisma', line: 1 }] };
function seed(nodes: GraphNode[] = []): EvidenceGraph {
  const builder = new EvidenceGraphBuilder();
  nodes.forEach(node => builder.addNode(node));
  return builder.build();
}
const model: GraphNode = { id: 'schema:users', kind: 'schema', label: 'users', properties: { modelName: 'User' }, provenance };
function consumer(runtime: string, channel = 'emails'): GraphNode {
  return { id: `job:${runtime}:${channel}`, kind: 'job', label: channel, properties: { runtime, channel, jobKind: 'queue-consumer' }, provenance };
}
async function typescript(files: Record<string, string>, nodes: GraphNode[] = [], partitionFiles?: ReadonlySet<string>) {
  const root = await repository(files);
  return enrichGraphWithTypeScriptSymbols({ root, exclude: [], graph: seed(nodes), ...(partitionFiles === undefined ? {} : { partitionFiles }) });
}

describe('TypeScript resolution boundary evidence', () => {
  it('recovers from unnamed malformed declarations without inventing symbol identities', async () => {
    const enriched = await typescript({ 'incomplete.ts': 'function () { unknown(); }\nclass { method() {} }\n' });
    expect(enriched.nodes.filter(node => node.kind === 'symbol' && node.properties?.symbolKind !== 'method')).toEqual([]);
    expect(enriched.edges.filter(edge => edge.kind === 'calls')).toEqual([]);
  });

  it('keeps unbound this receivers and unsupported constructions unresolved', async () => {
    const enriched = await typescript({ 'app.ts': `
      class Computed extends factory() {}
      class Owner { callback() { const nested = () => this.service.execute(); return nested; } }
      function outside() { this.service.execute(); this.prisma.user.findMany(); this.queue.add('job'); }
      function computed(client: Computed) { client.user.findMany(); }
      function unsupported() {
        const first = new (factory())(); first.user.findMany();
        const second = (connectionFactory())(); const channel = second.createChannel(); channel.sendToQueue('emails', data);
        const receiver = owner.connection.connect(); const other = receiver.createChannel(); other.sendToQueue('emails', data);
      }
    ` }, [model, consumer('bullmq'), consumer('amqplib')]);
    expect(enriched.edges.filter(edge => ['calls', 'references'].includes(edge.kind))).toEqual([]);
  });

  it('links namespace JSX and repeated local receiver declarations without inventing missing methods', async () => {
    const graph = await typescript({ 'components.tsx': 'export function Widget() { return null; } export class Service { execute() {} }', 'main.tsx': `
      import * as ns from './components';
      function App() { return <ns.Widget />; }
      class Empty {}
      function callbacks() { const callback = () => 1; const nested = () => callback; return callback; }
      function use() {
        let service: Empty; service.missing();
        { let service: Empty; service.missing(); let service: Empty; service.missing(); }
        (() => 1)();
        return { node: <App></App>, imported: <ns.Widget></ns.Widget> };
      }
      function deep() { function middle() { function hidden() {} } }
      function outside() { hidden(); }
    ` });
    expect(graph.edges.find(edge => edge.from === 'symbol:main.tsx#function:App' && edge.to === 'symbol:components.tsx#function:Widget')).toBeDefined();
    expect(graph.edges.filter(edge => edge.kind === 'calls')).toEqual([]);
    expect(graph.edges.some(edge => edge.to === 'symbol:main.tsx#function:callbacks.callback')).toBe(true);
  });

  it('keeps deeply nested namespace values and an unbound this method unresolved', async () => {
    const enriched = await typescript({ 'namespace.ts': 'export const group = { callback: () => 1 };', 'app.ts': "import * as ns from './namespace'; function value() { return ns.group.callback; } function free() { this.missing(); }" });
    expect(enriched.edges.filter(edge => ['calls', 'references-symbol'].includes(edge.kind))).toEqual([]);
  });

  it('reports absent and ambiguous Prisma model evidence without falsely matching other schema providers', async () => {
    const files = { 'app.ts': `import { PrismaClient } from '@prisma/client'; import * as Prisma from '@prisma/client';
      class Derived extends Prisma.PrismaClient {}
      class Plain {}
      function run(client: Derived, plain: Plain, direct: PrismaClient, wrong: Prisma.Other) {
        client.user.findMany(); direct.unknown.findMany(); plain.user.findMany(); wrong.user.findMany();
      }
      function nestedType(client: Prisma.ns.PrismaClient) { client.user.findMany(); }
      function unknownConstruction() { const queue = new ns.Queue('emails'); queue.add('job'); const other = new Other('emails'); other.add('job'); }
      const queue = new Queue('emails'); queue.add('top-level');
    ` };
    const absent = await typescript(files, [{ ...model, provenance: { ...provenance, evidence: [{ file: 'models.ts' }] } }]);
    expect(absent.gaps.filter(gap => gap.kind === 'database-model-unresolved')).toHaveLength(2);
    const ambiguous = await typescript(files, [model, { ...model, id: 'schema:duplicate' }]);
    expect(ambiguous.gaps.some(gap => gap.kind === 'database-model-ambiguous')).toBe(true);
  });

  it('does not upgrade coarse handler evidence when its symbols are absent or ambiguous', async () => {
    const root = await repository({ 'handlers.ts': 'export function first() {} export function second() {}', 'page.ts': 'export default class Page {}', 'empty.ts': 'export const value = 1;' });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({ id: 'endpoint', kind: 'endpoint', label: '/test', provenance });
    for (const file of ['handlers.ts', 'page.ts', 'empty.ts', 'absent.ts']) builder.addNode({ id: `file:${file}`, kind: 'file', label: file, provenance });
    builder.addNode({ id: 'symbol:seed', kind: 'symbol', label: 'seed', provenance });
    for (const [id, to, kind, refs] of [
      ['ambiguous', 'file:handlers.ts', 'handled-by', [{ file: 'handlers.ts', line: 1 }]],
      ['missing-evidence', 'file:handlers.ts', 'handled-by', []],
      ['empty', 'file:empty.ts', 'implemented-by', [{ file: 'empty.ts' }]],
      ['absent', 'file:absent.ts', 'handled-by', [{ file: 'absent.ts', line: 1 }]],
      ['already-symbol', 'symbol:seed', 'handled-by', []],
      ['class-component', 'file:page.ts', 'implemented-by', [{ file: 'page.ts' }]],
    ] as const) builder.addEdge({ id, from: 'endpoint', to, kind, provenance: { ...provenance, evidence: refs } });
    const enriched = await enrichGraphWithTypeScriptSymbols({ root, exclude: [], graph: builder.build() });
    expect(enriched.edges.filter(edge => edge.properties?.resolution === 'symbol')).toEqual([expect.objectContaining({ to: 'symbol:page.ts#class:Page' })]);
  });

  it('resolves parameter, local and class-property receiver types conservatively', async () => {
    const graph = await typescript({ 'service.ts': `
      interface Contract { execute(): void }
      class Runner { execute() {} }
      class Owner {
        typed: Runner;
        untyped;
        constructor(private injected: Contract, raw: string) { this.injected.execute(); }
        run() { this.typed.execute(); this.injected.execute(); this.untyped.execute(); this.absent.execute(); }
        1() {} 'quoted'() {} [dynamic]() {}
      }
      function run(param: Contract, primitive: string, qualified: ns.Runner) {
        param.execute(); primitive.execute(); qualified.execute();
        let runner = new Runner(); runner.execute();
        { let runner: Contract; runner.execute(); }
        let unknown: Missing; unknown.execute();
        let complex = new ns.Runner(); complex.execute();
        (new Runner()).execute(); factory().execute();
      }
      const expression = function named(param: Runner) { param.execute(); };
      const arrow = (param: Runner) => param.execute();
      for (const local = () => {}; false;) { local(); }
    ` });
    expect(graph.edges.filter(edge => edge.kind === 'calls').map(edge => edge.to)).toEqual(expect.arrayContaining([
      'symbol:service.ts#method:Contract.execute', 'symbol:service.ts#method:Runner.execute',
    ]));
    expect(graph.nodes.find(node => node.label === 'Owner.1')).toBeDefined();
    expect(graph.nodes.find(node => node.label === 'Owner.quoted')).toBeDefined();
    expect(graph.nodes.find(node => node.label === 'Owner.dynamic')).toBeUndefined();
    expect(graph.edges.filter(edge => edge.from === 'symbol:service.ts#function:expression' && edge.kind === 'calls')).toHaveLength(1);
  });

  it('avoids ambiguous overloaded functions and shadowed destructured values', async () => {
    const graph = await typescript({ 'app.ts': `
      function duplicate() {}
      function duplicate() {}
      function target() {}
      function outer() {
        function first() { function hidden() {} }
        function second() { hidden(); }
        return target;
      }
      function use({ value: { target } }, [other]) { target(); other(); duplicate(); }
      function local() { const [ , { target }] = dynamic; target(); }
      function recursion() { recursion(); return recursion; }
      duplicate();
    ` });
    expect(graph.edges.filter(edge => edge.kind === 'calls')).toEqual([]);
    expect(graph.edges.find(edge => edge.kind === 'references-symbol' && edge.to.endsWith('function:target'))).toBeDefined();
  });

  it('resolves heritage through namespaces and ignores self, expressions, and ambiguous stars', async () => {
    const graph = await typescript({
      'base.ts': 'export class Base {} export interface Contract {} export function target() {}',
      'other.ts': 'export class Base {} export function target() {}',
      'barrel.ts': "export * from './base'; export * from './other'; export * from './missing';",
      'cycle.ts': "export { target } from './cycle'; export { absent } from './missing';",
      'app.ts': `import * as ns from './base'; import * as external from 'external';
        import { Base, target } from './barrel'; import { absent } from './cycle';
        class Good extends ns.Base implements ns.Contract {}
        class Self extends Self {}
        class Dynamic extends factory().Base {}
        class Unknown extends external.Base {}
        class Ambiguous extends Base {}
        function run() { target(); absent(); external.target(); return ns.target; }
      `,
      'default.ts': 'export default class { run() {} }',
      'anonymous.ts': 'export default function() { return null; }',
    });
    expect(graph.edges.filter(edge => edge.kind === 'extends')).toEqual([expect.objectContaining({ from: 'symbol:app.ts#class:Good', to: 'symbol:base.ts#class:Base' })]);
    expect(graph.edges.filter(edge => edge.kind === 'implements')).toHaveLength(1);
    expect(graph.edges.filter(edge => edge.kind === 'calls')).toEqual([]);
    expect(graph.nodes.find(node => node.label === 'default' && node.properties?.symbolKind === 'class')).toBeDefined();
  });

  it('respects explicit noncallable exports that override callable names from star barrels', async () => {
    const enriched = await typescript({
      'callables.ts': 'export function target() {} export function execute() {}',
      'barrel.ts': "const local = 1; export { local as target }; export * from './callables'; export { missing }; function unrelated() {}",
      'app.ts': "import { target, missing, execute } from './barrel'; function run() { target(); missing(); execute(); }",
    });
    expect(enriched.edges.filter(edge => edge.kind === 'calls')).toEqual([expect.objectContaining({ from: 'symbol:app.ts#function:run', to: 'symbol:callables.ts#function:execute' })]);
  });

  it('keeps duplicate exported callable names unresolved rather than choosing the last alias', async () => {
    const enriched = await typescript({
      'exports.ts': 'export function shared() {} function other() {} export { other as shared };',
      'app.ts': "import { shared } from './exports'; function run() { shared(); }",
    });
    expect(enriched.edges.filter(edge => edge.kind === 'calls')).toEqual([]);
  });

  it('limits import traversal instead of resolving arbitrarily deep barrels', async () => {
    const files: Record<string, string> = { 'impl.ts': 'export function target() {}', 'main.ts': "import { target } from './b0'; function run() { target(); }" };
    for (let index = 0; index < 20; index++) files[`b${index}.ts`] = `export { target } from './${index === 19 ? 'impl' : `b${index + 1}`}';`;
    const graph = await typescript(files);
    expect(graph.edges.filter(edge => edge.kind === 'calls')).toEqual([]);
  });

  it('records Prisma access from explicit receiver types and supported client inheritance', async () => {
    const graph = await typescript({
      'client.ts': `import { PrismaClient } from '@prisma/client';
        export class Base extends PrismaClient {}
        export class Client extends Base {}
        export const client = new PrismaClient();
      `,
      'app.ts': `import { PrismaClient } from '@prisma/client'; import * as Prisma from '@prisma/client';
        import * as lib from './client'; import { Client } from './client';
        interface Contract {}
        class Empty implements Contract {}
        class Circular extends Circular {}
        class Controller {
          own = new Prisma.PrismaClient();
          missing;
          constructor(private injected: Client) {}
          run() { this.own.user.findMany(); this.injected.user.findMany(); this.missing.user.findMany(); this.absent.user.findMany(); }
        }
        function typed(client: Prisma.PrismaClient) { client.user.findMany(); }
        function inherited(client: lib.Client) { client.user.findMany(); }
        function ignored(client: lib.Missing, nested: lib.ns.Client) { client.user.findMany(); nested.user.findMany(); }
        function circular(client: Circular) { client.user.findMany(); }
        function normal(client: Empty) { client.user.findMany(); }
        function run() {
          const local = new PrismaClient(); local.user.findMany();
          const other = new Prisma.PrismaClient(); other.user.findMany();
          const unknown = new ns.Client(); unknown.user.findMany();
          const notClient = makeClient(); notClient.user.findMany();
          lib.client.user.findMany();
        }
      `,
    }, [model]);
    const references = graph.edges.filter(edge => edge.properties?.orm === 'prisma');
    expect(references.map(edge => edge.from)).toEqual(expect.arrayContaining([
      'symbol:app.ts#method:Controller.run', 'symbol:app.ts#function:typed',
      'symbol:app.ts#function:inherited', 'symbol:app.ts#function:run',
    ]));
    expect(references.some(edge => ['ignored', 'normal', 'circular'].some(name => edge.from.endsWith(`function:${name}`)))).toBe(false);
  });

  it.each(['prisma', 'queue', 'amqp'] as const)('resolves %s producers through star/reexport barrels and rejects cycles', async runtime => {
    const implementation = runtime === 'prisma'
      ? "import { PrismaClient } from '@prisma/client'; export const resource = new PrismaClient();"
      : runtime === 'queue'
        ? "import Queue from 'bull'; export const resource = new Queue('emails');"
        : "import amqp from 'amqplib'; const connection = amqp.connect('url'); export const resource = connection.createChannel();";
    const operation = runtime === 'prisma' ? '.user.findMany()' : runtime === 'queue' ? ".add(dynamic, {})" : ".sendToQueue('emails', data)";
    const graph = await typescript({
      'resource.ts': implementation,
      'named.ts': "export { resource } from './resource';",
      'star.ts': "export * from './named'; export * from './missing';",
      'empty.ts': 'export const resource = {}',
      'cycle.ts': "export { resource } from './cycle';",
      'invalid.ts': "export { resource } from './missing';",
      'ambiguous.ts': "export * from './resource'; export * from './resource2';",
      'resource2.ts': implementation,
      'app.ts': `import { resource } from './star'; import { resource as empty } from './empty';
        import { resource as cycle } from './cycle'; import { resource as invalid } from './invalid';
        import { resource as ambiguous } from './ambiguous'; import * as ns from './resource';
        import { resource as external } from 'external';
        function good() { resource${operation}; }
        function unknown() { empty${operation}; cycle${operation}; invalid${operation}; ambiguous${operation}; external${operation}; ns${operation}; }
      `,
    }, [model, consumer(runtime === 'queue' ? 'bull' : 'amqplib'), { id: 'job:no-properties', kind: 'job', label: 'unknown', provenance }]);
    expect(graph.edges.filter(edge => edge.properties?.referenceKind === (runtime === 'prisma' ? 'database-access' : 'queue-producer'))).toEqual([
      expect.objectContaining({ from: 'symbol:app.ts#function:good' }),
    ]);
  });

  it('finds local and property queues while reporting dynamic channels', async () => {
    const graph = await typescript({ 'app.ts': `import { Queue } from 'bullmq'; import amqp from 'amqplib';
      class Controller {
        queue = new Queue('emails'); unknown = makeQueue();
        publish() { this.queue.add('welcome', {}); this.unknown.add('x', {}); this.absent.add('x', {}); }
      }
      function queue() { const local = new Queue('emails'); local.add('welcome', {}); }
      function dynamic() { const local = new Queue(channelName); local.add(); }
      async function broker() {
        const connection = await amqp.connect('url'); const channel = await connection.createChannel();
        channel.sendToQueue('emails', data); channel.sendToQueue(dynamicQueue, data);
        function nested() { channel.sendToQueue('emails', data); }
      }
      function falseConnection() { const connection = other.connect(); const channel = connection.createChannel(); channel.sendToQueue('emails', data); }
      function falseChannel() { const channel = createChannel(); channel.sendToQueue('emails', data); }
      function property() { owner.channel.sendToQueue('emails', data); }
    ` }, [consumer('bullmq'), consumer('amqplib')]);
    expect(graph.edges.filter(edge => edge.properties?.referenceKind === 'queue-producer')).toHaveLength(3);
    expect(graph.gaps.filter(gap => gap.kind === 'queue-channel-unresolved')).toHaveLength(2);
  });

  it('keeps partition outputs local while resolving external symbol dependencies', async () => {
    const files = {
      'base.ts': "export class Base {} export function execute() {}",
      'app.ts': "import { Base, execute } from './base'; export class Child extends Base { run() { execute(); return execute; } }",
    };
    const root = await repository(files);
    const baseline = await enrichGraphWithTypeScriptSymbols({ root, exclude: [], graph: seed() });
    const graph = await enrichGraphWithTypeScriptSymbols({ root, exclude: [], graph: baseline, partitionFiles: new Set(['app.ts']) });
    expect(graph.nodes.filter(node => node.kind === 'symbol' && node.id.startsWith('symbol:base.ts'))).toHaveLength(2);
    expect(graph.edges.some(edge => edge.to === 'symbol:base.ts#function:execute')).toBe(true);
    expect(graph.edges.some(edge => edge.to === 'symbol:base.ts#class:Base')).toBe(true);
  });
});

describe('Python graph import and binding boundaries', () => {
  it('rejects references to a syntactically invalid module and skips unsupported base expressions', async () => {
    const root = await repository({ 'broken.py': 'def target(', 'main.py': 'from broken import target\nclass Unsupported(factory(), metaclass=Meta):\n    pass\ndef run():\n    target()\n' });
    const enriched = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: seed() });
    expect(enriched.edges.filter(edge => ['calls', 'extends'].includes(edge.kind))).toEqual([]);
    expect(enriched.gaps).toEqual([expect.objectContaining({ kind: 'python-syntax-error', source: expect.objectContaining({ file: 'broken.py' }) })]);
  });

  it('keeps coarse Python handler links when no unique function or file target exists', async () => {
    const root = await repository({ 'empty.py': 'value = 1\n', 'main.py': 'def existing():\n    pass\n' });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({ id: 'endpoint:seed', kind: 'endpoint', label: 'seed', provenance });
    builder.addNode({ id: 'symbol:seed', kind: 'symbol', label: 'seed', provenance });
    builder.addNode({ id: 'file:empty', kind: 'file', label: 'empty.py', provenance });
    builder.addEdge({ id: 'already-resolved', kind: 'handled-by', from: 'endpoint:seed', to: 'symbol:seed', provenance });
    builder.addEdge({ id: 'empty-handler', kind: 'handled-by', from: 'endpoint:seed', to: 'file:empty', provenance: { ...provenance, evidence: [{ file: 'empty.py', line: 1 }] } });
    const enriched = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: builder.build() });
    expect(enriched.edges.filter(edge => edge.kind === 'handled-by')).toHaveLength(2);
    expect(enriched.edges.some(edge => edge.properties?.resolution === 'symbol')).toBe(false);
  });

  it('keeps partition-limited output consistent with the previously indexed graph', async () => {
    const root = await repository({ 'models.py': 'class User:\n    pass\n', 'library.py': 'def execute():\n    pass\n', 'app.py': `from models import User
from library import execute
from absent import missing
from sqlalchemy import select
from other import update
def run():
    execute()
    User.objects.get()
    select(User)
    update(User)
    missing()
` });
    const baseline = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: seed([{ id: 'schema:User', kind: 'schema', label: 'User', provenance: { ...provenance, evidence: [{ file: 'models.py' }] } }]) });
    const enriched = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: baseline, partitionFiles: new Set(['app.py']) });
    expect(enriched).toEqual(baseline);
    expect(enriched.edges.filter(edge => edge.properties?.referenceKind === 'database-access')).toHaveLength(2);
  });

  it('handles self outside classes and missing exported symbols conservatively', async () => {
    const root = await repository({ 'exports.py': 'from absent import missing\n_private = 1\n', 'main.py': `import exports
from exports import missing
from exports import _private
from exports import value as alias
class Owner:
    def run(self):
        def nested():
            self.run()
        self.run()
        self.missing()
def outside():
    self.missing()
    alias.method()
    exports.missing()
    missing()
    _private()
    value.objects.get()
    something.get()
` });
    const graph = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: seed() });
    expect(graph.edges.filter(edge => edge.kind === 'calls')).toEqual([expect.objectContaining({ from: 'symbol:main.py#function:Owner.run.nested', to: 'symbol:main.py#method:Owner.run' })]);
  });

  it('resolves module inheritance, aliases, package-relative exports and nested functions', async () => {
    const root = await repository({
      'app/base.py': 'class Base:\n    pass\ndef helper():\n    pass\ndef _private():\n    pass\n',
      'app/nested/__init__.py': 'from ..base import helper as forwarded\n',
      'app/main.py': `import app.base as base
from .base import helper as aliased
from .nested import forwarded
from .base import _private
from .base import Base
from .base import *
class Child(base.Base):
    def run(self):
        def nested():
            aliased()
        nested()
        self.missing()
class Self(Self):
    pass
class Unsupported(factory().Base):
    pass
def run():
    forwarded()
    _private()
    unknown.helper()
    base.missing()
    base.helper()
    (factory())()
    return Child()
def shadow(aliased):
    aliased()
def assignment():
    aliased = make_callback()
    aliased()
def destructured():
    aliased, other = callbacks
    aliased()
def walrus():
    (aliased := callback)
    aliased()
def free():
    self.missing()
`,
    });
    const graph = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: seed() });
    expect(graph.edges.filter(edge => edge.kind === 'extends')).toEqual([expect.objectContaining({ from: 'symbol:app/main.py#class:Child', to: 'symbol:app/base.py#class:Base' })]);
    expect(graph.edges.filter(edge => edge.kind === 'calls').map(edge => edge.from)).toEqual(expect.arrayContaining([
      'symbol:app/main.py#function:Child.run.nested', 'symbol:app/main.py#method:Child.run', 'symbol:app/main.py#function:run',
    ]));
    expect(graph.edges.filter(edge => edge.kind === 'calls' && ['shadow', 'assignment', 'destructured', 'walrus', 'free'].some(name => edge.from.endsWith(`function:${name}`)))).toEqual([]);
    expect(graph.edges.some(edge => edge.to.endsWith('function:_private'))).toBe(false);
  });

  it('rejects ambiguous modules, cyclic exports, private classes and duplicate local definitions', async () => {
    const root = await repository({
      'lib.py': 'def work():\n    pass\n',
      'src/lib.py': 'def work():\n    pass\n',
      'cycle.py': 'from cycle import work\n',
      'main.py': `from lib import work
from cycle import work as cyclic
import missing
def duplicate():
    pass
def duplicate():
    pass
def run():
    work()
    cyclic()
    missing.work()
    duplicate()
def recursive():
    recursive()
`,
    });
    const graph = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: seed() });
    expect(graph.edges.filter(edge => edge.kind === 'calls')).toEqual([]);
  });

  it('records SQLAlchemy and Django operations only for uniquely evidenced class models', async () => {
    const root = await repository({ 'models.py': 'class User:\n    pass\nclass Missing:\n    pass\ndef helper():\n    pass\n', 'app.py': `from models import User, Missing, helper
import models
from sqlalchemy import select, update, delete
def read():
    models.User.objects.filter()
    User.query.all()
    User.other.filter()
    Missing.objects.filter()
    helper.objects.filter()
    select(User)
    update(models.User)
    delete()
    select(123)
    select(helper)
` });
    const graph = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: seed([
      { ...model, provenance: { ...provenance, certainty: 'low', evidence: [{ file: 'models.py', line: 1 }] } },
      { id: 'schema:other', kind: 'schema', label: 'User', provenance: { ...provenance, evidence: [{ file: 'other.py', line: 1 }] } },
    ]) });
    expect(graph.edges.filter(edge => edge.properties?.referenceKind === 'database-access')).toHaveLength(4);
    expect(graph.edges.filter(edge => edge.properties?.referenceKind === 'database-access').every(edge => edge.provenance.certainty === 'low')).toBe(true);
    const ambiguous = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: seed([
      { ...model, provenance: { ...provenance, evidence: [{ file: 'models.py' }] } },
      { ...model, id: 'schema:duplicate', provenance: { ...provenance, evidence: [{ file: 'models.py' }] } },
    ]) });
    expect(ambiguous.gaps.some(gap => gap.kind === 'database-model-ambiguous')).toBe(true);
  });

  it('preserves input evidence and restricts syntax-error gaps to the current partition', async () => {
    const root = await repository({ 'bad.py': 'def broken(', 'excluded.py': 'def broken(', 'good.py': 'def good():\n    pass\n' });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({ id: 'endpoint:test', kind: 'endpoint', label: 'test', provenance });
    builder.addNode({ id: 'file:good.py', kind: 'file', label: 'good.py', provenance });
    builder.addGap({ extractor: 'endpoints', kind: 'seed', message: 'seed' });
    builder.addEdge({ id: 'handled-by:no-line', kind: 'handled-by', from: 'endpoint:test', to: 'file:good.py', provenance: { ...provenance, evidence: [{ file: 'good.py' }] } });
    const graph = await enrichGraphWithPythonSymbols({ root, exclude: [], graph: builder.build(), partitionFiles: new Set(['bad.py', 'good.py']) });
    expect(graph.gaps.map(gap => gap.kind)).toEqual(['seed', 'python-syntax-error']);
    expect(graph.gaps.find(gap => gap.kind === 'python-syntax-error')?.source?.file).toBe('bad.py');
    expect(graph.edges).toContainEqual(expect.objectContaining({ id: 'handled-by:no-line' }));
    expect(graph.nodes.some(node => node.label === 'excluded.py')).toBe(false);
  });
});
