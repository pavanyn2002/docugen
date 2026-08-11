import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceGraphBuilder } from '../src/graph/builder.js';
import { enrichGraphWithPythonSymbols } from '../src/graph/python-symbols.js';

const created: string[] = [];

async function makeRepo(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-python-symbols-'));
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

describe('Python Tree-sitter symbol graph', () => {
  it('extracts definitions, containment, imports, inheritance, calls, and construction', async () => {
    const root = await makeRepo({
      'app/__init__.py': 'from .library import charge\n',
      'app/base.py': 'class BaseService:\n    pass\n',
      'app/library.py': 'def charge():\n    pass\n',
      'app/service.py': [
        'from .base import BaseService',
        'from . import charge',
        'import app.library as library',
        '',
        'class CheckoutService(BaseService):',
        '    def __init__(self):',
        '        pass',
        '',
        '    def finish(self):',
        '        pass',
        '',
        '    def run(self):',
        '        charge()',
        '        library.charge()',
        '        self.finish()',
        '',
        'def create():',
        '    return CheckoutService()',
      ].join('\n'),
    });

    const graph = await enrichGraphWithPythonSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(graph.nodes.find((node) => node.label === 'CheckoutService.run')).toMatchObject({
      kind: 'symbol',
      properties: { symbolKind: 'method', language: 'python', parserBackend: 'tree-sitter' },
    });
    expect(graph.nodes.find((node) => node.label === 'CheckoutService.__init__')).toMatchObject({
      properties: { symbolKind: 'constructor' },
    });
    expect(graph.edges.filter((edge) => edge.kind === 'contains')).toHaveLength(3);
    expect(graph.edges.find((edge) => edge.kind === 'extends')).toMatchObject({
      from: 'symbol:app/service.py#class:CheckoutService',
      to: 'symbol:app/base.py#class:BaseService',
    });
    expect(
      graph.edges
        .filter((edge) => edge.kind === 'calls')
        .map((edge) => `${edge.from}->${edge.to}`),
    ).toEqual([
      'symbol:app/service.py#method:CheckoutService.run->symbol:app/library.py#function:charge',
      'symbol:app/service.py#method:CheckoutService.run->symbol:app/service.py#method:CheckoutService.finish',
    ]);
    expect(graph.edges.find((edge) => edge.kind === 'instantiates')).toMatchObject({
      from: 'symbol:app/service.py#function:create',
      to: 'symbol:app/service.py#class:CheckoutService',
    });
  });

  it('upgrades decorator-line endpoint evidence to the Python handler symbol', async () => {
    const root = await makeRepo({
      'api.py': '@app.get("/orders")\ndef list_orders():\n    return []\n',
    });
    const builder = new EvidenceGraphBuilder();
    const source = {
      origin: 'extracted' as const,
      evidence: [{ file: 'api.py', line: 1 }],
      extractionMethods: ['regex' as const],
      certainty: 'low' as const,
    };
    builder.addNode({ id: 'endpoint:orders', kind: 'endpoint', label: 'GET /orders', provenance: source });
    builder.addNode({ id: 'file:api.py', kind: 'file', label: 'api.py', provenance: source });
    builder.addEdge({
      id: 'edge:handler-file',
      kind: 'handled-by',
      from: 'endpoint:orders',
      to: 'file:api.py',
      provenance: source,
    });

    const graph = await enrichGraphWithPythonSymbols({ graph: builder.build(), root, exclude: [] });

    expect(
      graph.edges.find(
        (edge) => edge.kind === 'handled-by' && edge.to.includes('#function:list_orders'),
      ),
    ).toMatchObject({ properties: { resolution: 'symbol', language: 'python' } });
  });

  it('records a gap and emits no claims for a syntactically invalid file', async () => {
    const root = await makeRepo({ 'broken.py': 'def broken(:\n    pass\n' });

    const graph = await enrichGraphWithPythonSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(graph.nodes).toEqual([]);
    expect(graph.gaps).toEqual([
      expect.objectContaining({
        extractor: 'symbol',
        kind: 'python-syntax-error',
        source: expect.objectContaining({ file: 'broken.py' }),
      }),
    ]);
  });

  it('links imported Django and SQLAlchemy model operations to their schema nodes', async () => {
    const root = await makeRepo({
      'app/__init__.py': '',
      'app/models.py': [
        'class Order(models.Model):',
        '    pass',
        '',
        'class Account(Base):',
        '    pass',
      ].join('\n'),
      'app/service.py': [
        'from .models import Order, Account',
        'from sqlalchemy import select',
        '',
        'def list_orders():',
        '    return Order.objects.filter(active=True)',
        '',
        'def account_query():',
        '    return select(Account)',
      ].join('\n'),
    });
    const builder = new EvidenceGraphBuilder();
    builder.addNode({
      id: 'schema:orders',
      kind: 'schema',
      label: 'orders',
      properties: { modelName: 'Order', schemaKind: 'table' },
      provenance: {
        origin: 'extracted',
        evidence: [{ file: 'app/models.py', line: 1 }],
        extractionMethods: ['regex'],
        certainty: 'low',
      },
    });
    builder.addNode({
      id: 'schema:accounts',
      kind: 'schema',
      label: 'accounts',
      properties: { modelName: 'Account', schemaKind: 'table' },
      provenance: {
        origin: 'extracted',
        evidence: [{ file: 'app/models.py', line: 4 }],
        extractionMethods: ['regex'],
        certainty: 'low',
      },
    });

    const graph = await enrichGraphWithPythonSymbols({ graph: builder.build(), root, exclude: [] });

    expect(
      graph.edges
        .filter((edge) => edge.properties?.referenceKind === 'database-access')
        .map((edge) => `${edge.from}:${edge.properties?.operation}->${edge.to}`),
    ).toEqual([
      'symbol:app/service.py#function:account_query:select->schema:accounts',
      'symbol:app/service.py#function:list_orders:filter->schema:orders',
    ]);
    expect(
      graph.edges.filter((edge) => edge.properties?.referenceKind === 'database-access'),
    ).toEqual([
      expect.objectContaining({ provenance: expect.objectContaining({ certainty: 'low' }) }),
      expect.objectContaining({ provenance: expect.objectContaining({ certainty: 'low' }) }),
    ]);
  });

  it('does not link a manager lookalike without an extracted model declaration', async () => {
    const root = await makeRepo({
      'app.py': [
        'class Order:',
        '    pass',
        '',
        'def run():',
        '    return Order.objects.filter()',
      ].join('\n'),
    });

    const graph = await enrichGraphWithPythonSymbols({
      graph: new EvidenceGraphBuilder().build(),
      root,
      exclude: [],
    });

    expect(graph.edges.filter((edge) => edge.properties?.referenceKind === 'database-access')).toEqual([]);
  });
});
