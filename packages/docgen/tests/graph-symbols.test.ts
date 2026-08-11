import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { enrichGraphWithTypeScriptSymbols } from '../src/graph/symbols.js';

const created: string[] = [];

async function makeRepo(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-symbols-'));
  created.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, 'utf8');
  }
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('TypeScript symbol graph', () => {
  it('extracts functions, classes, methods, containment, and local calls', async () => {
    const root = await makeRepo({
      'src/service.ts': [
        'export class PaymentService {',
        '  charge() { this.record(); }',
        '  record() {}',
        '}',
        'export function checkout() { helper(); }',
        'function helper() {}',
      ].join('\n'),
    });

    const graph = await enrichGraphWithTypeScriptSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(graph.nodes.filter((node) => node.kind === 'symbol').map((node) => node.label)).toEqual([
      'PaymentService',
      'checkout',
      'helper',
      'PaymentService.charge',
      'PaymentService.record',
    ]);
    expect(graph.edges.filter((edge) => edge.kind === 'contains')).toHaveLength(2);
    expect(
      graph.edges
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => `${edge.from}->${edge.to}`),
    ).toEqual([
      'symbol:src/service.ts#function:checkout->symbol:src/service.ts#function:helper',
      'symbol:src/service.ts#method:PaymentService.charge->symbol:src/service.ts#method:PaymentService.record',
    ]);
  });

  it('resolves direct named imports into cross-file call edges', async () => {
    const root = await makeRepo({
      'src/checkout.ts': "import { charge } from './payments';\nexport const checkout = () => charge();\n",
      'src/payments.ts': 'export function charge() {}\n',
    });

    const graph = await enrichGraphWithTypeScriptSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });
    const call = graph.edges.find((edge) => edge.kind === 'calls');

    expect(call).toMatchObject({
      from: 'symbol:src/checkout.ts#function:checkout',
      to: 'symbol:src/payments.ts#function:charge',
      provenance: { origin: 'extracted', extractionMethods: ['ast'], certainty: 'high' },
    });
    expect(call?.provenance.evidence[0]).toMatchObject({ file: 'src/checkout.ts', line: 2 });
  });

  it('resolves calls through explicit barrels, star barrels, and namespace imports', async () => {
    const root = await makeRepo({
      'src/payments.ts': 'export function charge() {}\n',
      'src/named.ts': "export { charge } from './payments';\n",
      'src/star.ts': "export * from './named';\n",
      'src/checkout.ts': [
        "import { charge as direct } from './named';",
        "import { charge as starred } from './star';",
        "import * as payments from './star';",
        'export function one() { direct(); }',
        'export function two() { starred(); }',
        'export function three() { payments.charge(); }',
      ].join('\n'),
    });

    const graph = await enrichGraphWithTypeScriptSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(
      graph.edges
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => `${edge.from}->${edge.to}`),
    ).toEqual([
      'symbol:src/checkout.ts#function:one->symbol:src/payments.ts#function:charge',
      'symbol:src/checkout.ts#function:three->symbol:src/payments.ts#function:charge',
      'symbol:src/checkout.ts#function:two->symbol:src/payments.ts#function:charge',
    ]);
  });

  it('does not invent targets for object method calls without type evidence', async () => {
    const root = await makeRepo({
      'src/app.ts': 'export function run(service: unknown) { service.execute(); }\n',
    });

    const graph = await enrichGraphWithTypeScriptSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(graph.edges.filter((edge) => edge.kind === 'calls')).toEqual([]);
  });

  it('links inheritance, interface implementation, and typed receiver calls across imports', async () => {
    const root = await makeRepo({
      'src/contracts.ts': 'export interface PaymentGateway { charge(): void; }\n',
      'src/base.ts': 'export class BaseService {}\n',
      'src/payments.ts': [
        "import { BaseService } from './base';",
        "import { PaymentGateway } from './contracts';",
        'export class PaymentService extends BaseService implements PaymentGateway {',
        '  charge() {}',
        '}',
      ].join('\n'),
      'src/checkout.ts': [
        "import { PaymentService } from './payments';",
        'export function checkout(service: PaymentService) { service.charge(); }',
      ].join('\n'),
      'src/repository.ts': 'export class PaymentRepository { save() {} }\n',
      'src/handler.ts': [
        "import { PaymentRepository } from './repository';",
        'export class Handler {',
        '  constructor(private repository: PaymentRepository) {}',
        '  run() { this.repository.save(); }',
        '}',
      ].join('\n'),
    });

    const graph = await enrichGraphWithTypeScriptSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(graph.edges.find((edge) => edge.kind === 'extends')).toMatchObject({
      from: 'symbol:src/payments.ts#class:PaymentService',
      to: 'symbol:src/base.ts#class:BaseService',
    });
    expect(graph.edges.find((edge) => edge.kind === 'implements')).toMatchObject({
      from: 'symbol:src/payments.ts#class:PaymentService',
      to: 'symbol:src/contracts.ts#interface:PaymentGateway',
    });
    expect(
      graph.edges
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => `${edge.from}->${edge.to}`),
    ).toEqual([
      'symbol:src/checkout.ts#function:checkout->symbol:src/payments.ts#method:PaymentService.charge',
      'symbol:src/handler.ts#method:Handler.run->symbol:src/repository.ts#method:PaymentRepository.save',
    ]);
  });

  it('records statically proven construction and JSX component references', async () => {
    const root = await makeRepo({
      'src/library.tsx': [
        'export class Service {}',
        'export function Badge() { return <span />; }',
      ].join('\n'),
      'src/app.tsx': [
        "import { Service } from './library';",
        "import * as ui from './library';",
        'export function create() { return new Service(); }',
        'export function Screen() { return <ui.Badge />; }',
      ].join('\n'),
    });

    const graph = await enrichGraphWithTypeScriptSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(graph.edges.find((edge) => edge.kind === 'instantiates')).toMatchObject({
      from: 'symbol:src/app.tsx#function:create',
      to: 'symbol:src/library.tsx#class:Service',
    });
    expect(graph.edges.find((edge) => edge.kind === 'references-symbol')).toMatchObject({
      from: 'symbol:src/app.tsx#function:Screen',
      to: 'symbol:src/library.tsx#function:Badge',
    });
  });

  it('records imported and local symbols used as values without treating calls as references', async () => {
    const root = await makeRepo({
      'src/library.ts': [
        'export function transform() {}',
        'export function validate() {}',
      ].join('\n'),
      'src/app.ts': [
        "import { transform } from './library';",
        "import * as validators from './library';",
        'function localFallback() {}',
        'export function configure(register: (value: unknown) => void) {',
        '  register(transform);',
        '  const fallback = localFallback;',
        '  return validators.validate;',
        '}',
      ].join('\n'),
    });

    const graph = await enrichGraphWithTypeScriptSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(
      graph.edges
        .filter((edge) => edge.kind === 'references-symbol')
        .map((edge) => `${edge.from}->${edge.to}`),
    ).toEqual([
      'symbol:src/app.ts#function:configure->symbol:src/app.ts#function:localFallback',
      'symbol:src/app.ts#function:configure->symbol:src/library.ts#function:transform',
      'symbol:src/app.ts#function:configure->symbol:src/library.ts#function:validate',
    ]);
  });

  it('does not resolve a shadowing parameter to a top-level symbol', async () => {
    const root = await makeRepo({
      'src/app.ts': [
        'function handler() {}',
        'export function run(handler: () => void) {',
        '  handler();',
        '  return handler;',
        '}',
      ].join('\n'),
    });

    const graph = await enrichGraphWithTypeScriptSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(graph.edges.filter((edge) => edge.kind === 'calls')).toEqual([]);
    expect(graph.edges.filter((edge) => edge.kind === 'references-symbol')).toEqual([]);
  });

  it('links cross-file Prisma client operations to unique schema models', async () => {
    const root = await makeRepo({
      'src/db.ts': [
        "import { PrismaClient } from '@prisma/client';",
        'export const db = new PrismaClient();',
      ].join('\n'),
      'src/repository.ts': [
        "import { db } from './db';",
        'export function listUsers() { return db.user.findMany(); }',
        'export function createUser() { return db.user.create({ data: {} }); }',
      ].join('\n'),
    });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({
      id: 'schema:users',
      kind: 'schema',
      label: 'users',
      properties: { modelName: 'User', schemaKind: 'table' },
      provenance: {
        origin: 'extracted',
        evidence: [{ file: 'prisma/schema.prisma', line: 1 }],
        extractionMethods: ['schema'],
        certainty: 'high',
      },
    });

    const graph = await enrichGraphWithTypeScriptSymbols({ graph: builder.build(), root, exclude: [] });

    expect(
      graph.edges
        .filter(
          (edge) =>
            edge.kind === 'references' && edge.properties?.referenceKind === 'database-access',
        )
        .map((edge) => `${edge.from}:${edge.properties?.operation}->${edge.to}`),
    ).toEqual([
      'symbol:src/repository.ts#function:createUser:create->schema:users',
      'symbol:src/repository.ts#function:listUsers:findMany->schema:users',
    ]);
  });

  it('does not infer Prisma access from an unproven lookalike receiver', async () => {
    const root = await makeRepo({
      'src/app.ts': 'export function run(api: unknown) { return api.user.findMany(); }\n',
    });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({
      id: 'schema:user',
      kind: 'schema',
      label: 'User',
      provenance: {
        origin: 'extracted',
        evidence: [{ file: 'schema.prisma', line: 1 }],
        extractionMethods: ['schema'],
        certainty: 'high',
      },
    });

    const graph = await enrichGraphWithTypeScriptSymbols({ graph: builder.build(), root, exclude: [] });

    expect(
      graph.edges.filter((edge) => edge.properties?.referenceKind === 'database-access'),
    ).toEqual([]);
    expect(graph.gaps.filter((gap) => gap.kind.startsWith('database-model-'))).toEqual([]);
  });

  it('proves database access through an injected PrismaClient subclass', async () => {
    const root = await makeRepo({
      'src/db.ts': [
        "import { PrismaClient } from '@prisma/client';",
        'export class PrismaService extends PrismaClient {}',
      ].join('\n'),
      'src/users.ts': [
        "import { PrismaService } from './db';",
        'export class UserRepository {',
        '  constructor(private db: PrismaService) {}',
        '  list() { return this.db.user.findMany(); }',
        '}',
      ].join('\n'),
    });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({
      id: 'schema:user',
      kind: 'schema',
      label: 'User',
      provenance: {
        origin: 'extracted',
        evidence: [{ file: 'schema.prisma', line: 1 }],
        extractionMethods: ['schema'],
        certainty: 'high',
      },
    });

    const graph = await enrichGraphWithTypeScriptSymbols({ graph: builder.build(), root, exclude: [] });

    expect(
      graph.edges.find((edge) => edge.properties?.referenceKind === 'database-access'),
    ).toMatchObject({
      from: 'symbol:src/users.ts#method:UserRepository.list',
      to: 'schema:user',
      properties: { orm: 'prisma', operation: 'findMany' },
    });
  });

  it('links an imported BullMQ producer to the consumer job for its channel', async () => {
    const root = await makeRepo({
      'src/queues.ts': [
        "import { Queue } from 'bullmq';",
        "export const emailQueue = new Queue('emails');",
      ].join('\n'),
      'src/notifications.ts': [
        "import { emailQueue } from './queues';",
        "export function notify() { return emailQueue.add('welcome', {}); }",
      ].join('\n'),
    });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({
      id: 'job:emails',
      kind: 'job',
      label: 'emails',
      properties: { jobKind: 'queue-consumer', channel: 'emails', runtime: 'bullmq' },
      provenance: {
        origin: 'extracted',
        evidence: [{ file: 'src/worker.ts', line: 1 }],
        extractionMethods: ['ast'],
        certainty: 'high',
      },
    });

    const graph = await enrichGraphWithTypeScriptSymbols({ graph: builder.build(), root, exclude: [] });

    expect(graph.edges.find((edge) => edge.properties?.referenceKind === 'queue-producer')).toMatchObject({
      from: 'symbol:src/notifications.ts#function:notify',
      to: 'job:emails',
      properties: {
        runtime: 'bullmq',
        channel: 'emails',
        operation: 'add',
        jobName: 'welcome',
      },
    });
  });

  it('does not infer a queue producer from an unproven add method', async () => {
    const root = await makeRepo({
      'src/app.ts': "export function run(queue: unknown) { return queue.add('welcome', {}); }\n",
    });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({
      id: 'job:emails',
      kind: 'job',
      label: 'emails',
      properties: { jobKind: 'queue-consumer', channel: 'emails', runtime: 'bullmq' },
      provenance: { origin: 'extracted', evidence: [{ file: 'worker.ts', line: 1 }] },
    });

    const graph = await enrichGraphWithTypeScriptSymbols({ graph: builder.build(), root, exclude: [] });

    expect(graph.edges.filter((edge) => edge.properties?.referenceKind === 'queue-producer')).toEqual([]);
  });

  it('records a gap when a proven queue publishes through a dynamic channel', async () => {
    const root = await makeRepo({
      'src/app.ts': [
        "import { Queue } from 'bullmq';",
        'const queueName = process.env.QUEUE_NAME;',
        'const queue = new Queue(queueName);',
        "export function run() { return queue.add('welcome', {}); }",
      ].join('\n'),
    });

    const graph = await enrichGraphWithTypeScriptSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(graph.gaps).toContainEqual(
      expect.objectContaining({ extractor: 'symbol', kind: 'queue-channel-unresolved' }),
    );
  });

  it('links an exported amqplib channel producer to its consumer job', async () => {
    const root = await makeRepo({
      'src/broker.ts': [
        "import amqp from 'amqplib';",
        "export const connection = await amqp.connect('amqp://localhost');",
        'export const channel = await connection.createChannel();',
      ].join('\n'),
      'src/orders.ts': [
        "import { channel } from './broker';",
        "export function submit() { return channel.sendToQueue('orders', Buffer.from('{}')); }",
      ].join('\n'),
    });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({
      id: 'job:orders',
      kind: 'job',
      label: 'orders',
      properties: { jobKind: 'queue-consumer', channel: 'orders', runtime: 'amqplib' },
      provenance: {
        origin: 'extracted',
        evidence: [{ file: 'src/consumer.ts', line: 1 }],
        extractionMethods: ['ast'],
        certainty: 'high',
      },
    });

    const graph = await enrichGraphWithTypeScriptSymbols({ graph: builder.build(), root, exclude: [] });

    expect(graph.edges.find((edge) => edge.properties?.referenceKind === 'queue-producer')).toMatchObject({
      from: 'symbol:src/orders.ts#function:submit',
      to: 'job:orders',
      properties: { runtime: 'amqplib', channel: 'orders', operation: 'sendToQueue' },
    });
  });

  it('does not infer an AMQP producer from an unproven sendToQueue method', async () => {
    const root = await makeRepo({
      'src/app.ts': "export function run(channel: unknown) { return channel.sendToQueue('orders'); }\n",
    });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({
      id: 'job:orders',
      kind: 'job',
      label: 'orders',
      properties: { jobKind: 'queue-consumer', channel: 'orders', runtime: 'amqplib' },
      provenance: { origin: 'extracted', evidence: [{ file: 'consumer.ts', line: 1 }] },
    });

    const graph = await enrichGraphWithTypeScriptSymbols({ graph: builder.build(), root, exclude: [] });

    expect(graph.edges.filter((edge) => edge.properties?.referenceKind === 'queue-producer')).toEqual([]);
  });

  it('upgrades extracted handler and component file evidence to unique symbols', async () => {
    const root = await makeRepo({
      'src/handler.ts': '// endpoint\nexport function createOrder() {}\n',
      'src/page.tsx': 'export default function OrdersPage() { return <main />; }\n',
    });
    const builder = new EvidenceGraphBuilder();
    const provenance = {
      origin: 'extracted' as const,
      evidence: [{ file: 'src/handler.ts', line: 2 }],
      extractionMethods: ['ast' as const],
      certainty: 'high' as const,
    };
    builder.addNode({ id: 'endpoint:create', kind: 'endpoint', label: 'POST /orders', provenance });
    builder.addNode({ id: 'route:orders', kind: 'route', label: '/orders', provenance });
    builder.addNode({ id: 'file:src/handler.ts', kind: 'file', label: 'src/handler.ts', provenance });
    builder.addNode({
      id: 'file:src/page.tsx',
      kind: 'file',
      label: 'src/page.tsx',
      provenance: { ...provenance, evidence: [{ file: 'src/page.tsx', line: 1 }] },
    });
    builder.addEdge({
      id: 'edge:handler-file',
      kind: 'handled-by',
      from: 'endpoint:create',
      to: 'file:src/handler.ts',
      provenance,
    });
    builder.addEdge({
      id: 'edge:component-file',
      kind: 'implemented-by',
      from: 'route:orders',
      to: 'file:src/page.tsx',
      provenance: { ...provenance, evidence: [{ file: 'src/page.tsx', line: 1 }] },
    });

    const graph = await enrichGraphWithTypeScriptSymbols({ graph: builder.build(), root, exclude: [] });

    expect(
      graph.edges.find(
        (edge) => edge.kind === 'handled-by' && edge.to.includes('#function:createOrder'),
      ),
    ).toMatchObject({ from: 'endpoint:create', properties: { resolution: 'symbol' } });
    expect(
      graph.edges.find(
        (edge) => edge.kind === 'implemented-by' && edge.to.includes('#function:OrdersPage'),
      ),
    ).toMatchObject({ from: 'route:orders', properties: { resolution: 'symbol' } });
  });
});
