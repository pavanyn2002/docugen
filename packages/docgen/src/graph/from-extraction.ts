import type { EntryBase, ExtractResult, ExtractorId, SourceRef } from '../types/core.js';
import type {
  ConfigResult,
  DepsResult,
  EndpointEntry,
  EndpointsResult,
  JobEntry,
  JobsResult,
  ModuleEntry,
  RouteEntry,
  RoutesResult,
  SchemaEntry,
  SchemaResult,
  ShapeRef,
} from '../types/entries.js';
import { EvidenceGraphBuilder } from './builder.js';
import { graphEdgeId, graphNodeId } from './ids.js';
import type {
  EvidenceGraph,
  GraphEdgeKind,
  GraphNodeKind,
  GraphProperties,
  GraphProvenance,
} from './types.js';

function extractedProvenance(
  extractor: ExtractorId,
  entry: EntryBase,
  evidence: readonly SourceRef[] = [entry.source],
): GraphProvenance {
  return {
    origin: 'extracted',
    extractors: [extractor],
    extractionMethods: [entry.extractionMethod],
    certainty: entry.certainty,
    evidence,
  };
}

function addFile(builder: EvidenceGraphBuilder, ref: SourceRef, provenance: GraphProvenance): string {
  const id = graphNodeId('file', ref.file);
  builder.addNode({ id, kind: 'file', label: ref.file, provenance: { ...provenance, evidence: [ref] } });
  return id;
}

function addFileRelationship(args: {
  builder: EvidenceGraphBuilder;
  from: string;
  kind: GraphEdgeKind;
  ref: SourceRef;
  provenance: GraphProvenance;
  discriminator?: string;
  properties?: GraphProperties;
}): string {
  const target = addFile(args.builder, args.ref, args.provenance);
  args.builder.addEdge({
    id: graphEdgeId(args.kind, args.from, target, args.discriminator),
    kind: args.kind,
    from: args.from,
    to: target,
    provenance: { ...args.provenance, evidence: [args.ref] },
    ...(args.properties === undefined ? {} : { properties: args.properties }),
  });
  return target;
}

function entryNode(args: {
  builder: EvidenceGraphBuilder;
  extractor: ExtractorId;
  entry: EntryBase;
  kind: GraphNodeKind;
  label: string;
  properties?: GraphProperties;
}): string {
  const id = graphNodeId(args.kind, `${args.extractor}:${args.entry.id}`);
  const provenance = extractedProvenance(args.extractor, args.entry);
  args.builder.addNode({
    id,
    kind: args.kind,
    label: args.label,
    provenance,
    properties: {
      extractorId: args.entry.id,
      // Lossless, versioned projection used by deterministic renderers. The
      // surrounding graph properties remain query-friendly; this payload
      // preserves details such as schema indexes without reaching back into
      // extractor-private return objects.
      renderEntryV1: JSON.stringify(safeRenderEntry(args.entry)),
      ...(args.properties ?? {}),
    },
  });
  addFileRelationship({
    builder: args.builder,
    from: id,
    kind: 'defined-in',
    ref: args.entry.source,
    provenance,
  });
  return id;
}

function safeRenderEntry(entry: EntryBase): EntryBase {
  if (
    'isSecretLike' in entry && entry.isSecretLike === true &&
    'defaultValue' in entry
  ) {
    const { defaultValue: _secretDefault, ...safe } = entry;
    return safe as EntryBase;
  }
  return entry;
}

function addRoutes(builder: EvidenceGraphBuilder, result: RoutesResult): void {
  for (const route of result.entries) {
    const provenance = extractedProvenance('routes', route);
    const id = entryNode({
      builder,
      extractor: 'routes',
      entry: route,
      kind: 'route',
      label: route.path,
      properties: {
        routeKind: route.kind,
        params: route.params,
        isCatchAll: route.isCatchAll,
        ...(route.group === undefined ? {} : { group: route.group }),
      },
    });

    if (route.component !== undefined) {
      addFileRelationship({ builder, from: id, kind: 'implemented-by', ref: route.component, provenance });
    }
    for (const [index, layout] of route.layoutChain.entries()) {
      addFileRelationship({
        builder,
        from: id,
        kind: 'wrapped-by',
        ref: layout,
        provenance,
        discriminator: String(index),
        properties: { order: index },
      });
    }
    for (const guard of route.guards) addGuard(builder, route, id, guard.name, guard.source);
  }
}

function addGuard(
  builder: EvidenceGraphBuilder,
  route: RouteEntry,
  routeNode: string,
  name: string,
  source: SourceRef,
): void {
  const provenance = extractedProvenance('routes', route, [source]);
  const guardId = graphNodeId(
    'guard',
    `${route.id}:${name}:${source.file}:${source.line ?? ''}:${source.column ?? ''}`,
  );
  builder.addNode({ id: guardId, kind: 'guard', label: name, provenance });
  builder.addEdge({
    id: graphEdgeId('guarded-by', routeNode, guardId),
    kind: 'guarded-by',
    from: routeNode,
    to: guardId,
    provenance,
  });
  addFileRelationship({ builder, from: guardId, kind: 'defined-in', ref: source, provenance });
}

function addEndpoints(builder: EvidenceGraphBuilder, result: EndpointsResult): void {
  for (const endpoint of result.entries) {
    const provenance = extractedProvenance('endpoints', endpoint);
    const id = entryNode({
      builder,
      extractor: 'endpoints',
      entry: endpoint,
      kind: 'endpoint',
      label: `${endpoint.method} ${endpoint.path}`,
      properties: {
        method: endpoint.method,
        path: endpoint.path,
        params: endpoint.params,
        middleware: endpoint.middleware,
        ...(endpoint.specStatus === undefined ? {} : { specStatus: endpoint.specStatus }),
      },
    });
    if (endpoint.handler !== undefined) {
      addFileRelationship({ builder, from: id, kind: 'handled-by', ref: endpoint.handler, provenance });
    }
    if (endpoint.requestShape !== undefined) addShape(builder, endpoint, id, 'accepts', endpoint.requestShape);
    if (endpoint.responseShape !== undefined) addShape(builder, endpoint, id, 'returns', endpoint.responseShape);
  }
}

function addShape(
  builder: EvidenceGraphBuilder,
  endpoint: EndpointEntry,
  endpointNode: string,
  relationship: 'accepts' | 'returns',
  shape: ShapeRef,
): void {
  const evidence = shape.source === undefined ? [endpoint.source] : [shape.source];
  const provenance = extractedProvenance('endpoints', endpoint, evidence);
  const shapeId = graphNodeId('shape', `${endpoint.id}:${relationship}:${shape.kind}:${shape.name}`);
  builder.addNode({
    id: shapeId,
    kind: 'shape',
    label: shape.name,
    provenance,
    properties: { shapeKind: shape.kind },
  });
  builder.addEdge({
    id: graphEdgeId(relationship, endpointNode, shapeId),
    kind: relationship,
    from: endpointNode,
    to: shapeId,
    provenance,
  });
  if (shape.source !== undefined) {
    addFileRelationship({ builder, from: shapeId, kind: 'defined-in', ref: shape.source, provenance });
  }
}

function addSchema(builder: EvidenceGraphBuilder, result: SchemaResult, seed?: EvidenceGraph): void {
  const nodeByEntry = new Map<SchemaEntry, string>();
  const nodesByName = new Map<string, string[]>();

  for (const node of seed?.nodes ?? []) {
    if (node.kind !== 'schema') continue;
    for (const name of [node.label, node.properties?.modelName].filter(
      (value): value is string => typeof value === 'string',
    )) {
      const matches = nodesByName.get(name) ?? [];
      matches.push(node.id);
      nodesByName.set(name, matches);
    }
  }

  for (const entry of result.entries) {
    const id = entryNode({
      builder,
      extractor: 'schema',
      entry,
      kind: 'schema',
      label: entry.name,
      properties: {
        schemaKind: entry.kind,
        ...(entry.modelName === undefined ? {} : { modelName: entry.modelName }),
      },
    });
    nodeByEntry.set(entry, id);
    for (const name of [entry.name, entry.modelName].filter((value): value is string => value !== undefined)) {
      const matches = nodesByName.get(name) ?? [];
      matches.push(id);
      nodesByName.set(name, matches);
    }

    const provenance = extractedProvenance('schema', entry);
    for (const field of entry.fields) {
      const fieldId = graphNodeId('field', `${entry.id}:${field.name}`);
      builder.addNode({
        id: fieldId,
        kind: 'field',
        label: field.name,
        provenance,
        properties: {
          fieldType: field.type,
          ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
          ...(field.isPrimaryKey === undefined ? {} : { isPrimaryKey: field.isPrimaryKey }),
          ...(field.isUnique === undefined ? {} : { isUnique: field.isUnique }),
          ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
        },
      });
      builder.addEdge({
        id: graphEdgeId('has-field', id, fieldId),
        kind: 'has-field',
        from: id,
        to: fieldId,
        provenance,
      });
    }
  }

  for (const entry of result.entries) {
    const from = nodeByEntry.get(entry);
    if (from === undefined) continue;
    for (const relation of entry.relations) {
      const matches = nodesByName.get(relation.targetModel) ?? [];
      if (matches.length !== 1) {
        builder.addGap({
          extractor: 'schema',
          kind: matches.length === 0 ? 'graph-relation-target-unresolved' : 'graph-relation-target-ambiguous',
          message:
            matches.length === 0
              ? `Relation target '${relation.targetModel}' was not found in the extracted schema.`
              : `Relation target '${relation.targetModel}' matched ${matches.length} schema nodes.`,
          source: entry.source,
        });
        continue;
      }
      const target = matches[0];
      if (target === undefined) continue;
      const provenance = extractedProvenance('schema', entry);
      builder.addEdge({
        id: graphEdgeId('references', from, target, relation.field),
        kind: 'references',
        from,
        to: target,
        provenance,
        properties: {
          field: relation.field,
          ...(relation.cardinality === undefined ? {} : { cardinality: relation.cardinality }),
        },
      });
    }
  }
}

function addDependencies(builder: EvidenceGraphBuilder, result: DepsResult, seed?: EvidenceGraph): void {
  const nodeByModule = new Map<string, string>();
  const entryByModule = new Map<string, ModuleEntry>();

  for (const node of seed?.nodes ?? []) {
    if (node.kind === 'module') nodeByModule.set(node.label, node.id);
  }

  for (const entry of result.entries) {
    const id = entryNode({
      builder,
      extractor: 'deps',
      entry,
      kind: 'module',
      label: entry.module,
      properties: { externalPackages: entry.externals },
    });
    nodeByModule.set(entry.module, id);
    entryByModule.set(entry.module, entry);

    for (const specifier of entry.externals) {
      const packageId = graphNodeId('package', specifier);
      const provenance = extractedProvenance('deps', entry);
      builder.addNode({ id: packageId, kind: 'package', label: specifier, provenance });
      builder.addEdge({
        id: graphEdgeId('imports', id, packageId),
        kind: 'imports',
        from: id,
        to: packageId,
        provenance,
      });
    }
  }

  for (const [module, entry] of entryByModule) {
    const from = nodeByModule.get(module);
    if (from === undefined) continue;
    for (const imported of entry.imports) {
      const target = nodeByModule.get(imported);
      if (target === undefined) {
        builder.addGap({
          extractor: 'deps',
          kind: 'graph-import-target-unresolved',
          message: `Internal import '${imported}' from '${module}' has no extracted module node.`,
          source: entry.source,
        });
        continue;
      }
      const provenance = extractedProvenance('deps', entry);
      builder.addEdge({
        id: graphEdgeId('imports', from, target),
        kind: 'imports',
        from,
        to: target,
        provenance,
      });
    }
  }
}

function addJobs(builder: EvidenceGraphBuilder, result: JobsResult): void {
  for (const job of result.entries) {
    const provenance = extractedProvenance('jobs', job);
    const id = entryNode({
      builder,
      extractor: 'jobs',
      entry: job,
      kind: 'job',
      label: job.name,
      properties: jobProperties(job),
    });
    if (job.handler !== undefined) {
      addFileRelationship({ builder, from: id, kind: 'handled-by', ref: job.handler, provenance });
    }
  }
}

function jobProperties(job: JobEntry): GraphProperties {
  return {
    jobKind: job.kind,
    ...(job.schedule === undefined ? {} : { schedule: job.schedule }),
    ...(job.channel === undefined ? {} : { channel: job.channel }),
    ...(job.runtime === undefined ? {} : { runtime: job.runtime }),
  };
}

function addConfig(builder: EvidenceGraphBuilder, result: ConfigResult): void {
  for (const entry of result.entries) {
    const provenance = extractedProvenance('config', entry);
    const id = entryNode({
      builder,
      extractor: 'config',
      entry,
      kind: 'config',
      label: entry.name,
      properties: {
        configKind: entry.kind,
        isSecretLike: entry.isSecretLike,
        ...(!entry.isSecretLike && entry.defaultValue !== undefined
          ? { defaultValue: entry.defaultValue }
          : {}),
      },
    });
    for (const ref of entry.declarations) {
      addFileRelationship({ builder, from: id, kind: 'declared-in', ref, provenance });
    }
    for (const ref of entry.reads) {
      addFileRelationship({ builder, from: id, kind: 'read-by', ref, provenance });
    }
  }
}

/** Translate the current static extractors into the first evidence-graph schema. */
export function buildEvidenceGraph(
  results: ReadonlyMap<ExtractorId, ExtractResult>,
  seed?: EvidenceGraph,
): EvidenceGraph {
  const builder = new EvidenceGraphBuilder();
  for (const node of seed?.nodes ?? []) builder.addNode(node);
  for (const edge of seed?.edges ?? []) builder.addEdge(edge);
  for (const gap of seed?.gaps ?? []) builder.addGap(gap);
  for (const result of results.values()) {
    for (const gap of result.gaps) builder.addGap(gap);
  }

  const routes = results.get('routes') as RoutesResult | undefined;
  const endpoints = results.get('endpoints') as EndpointsResult | undefined;
  const schema = results.get('schema') as SchemaResult | undefined;
  const deps = results.get('deps') as DepsResult | undefined;
  const jobs = results.get('jobs') as JobsResult | undefined;
  const config = results.get('config') as ConfigResult | undefined;

  if (routes !== undefined) addRoutes(builder, routes);
  if (endpoints !== undefined) addEndpoints(builder, endpoints);
  if (schema !== undefined) addSchema(builder, schema, seed);
  if (deps !== undefined) addDependencies(builder, deps, seed);
  if (jobs !== undefined) addJobs(builder, jobs);
  if (config !== undefined) addConfig(builder, config);

  return builder.build();
}
