/**
 * Per-extractor entry shapes.
 *
 * Every field that a parser might fail to determine is optional. SPEC rule 5:
 * omit and record a Gap rather than guess. Nothing here has a default value
 * that could be mistaken for an observation.
 */
import type { EntryBase, ExtractResult, SourceRef } from './core.js';

// ── routes ───────────────────────────────────────────────────────────────────

export type RouteKind = 'page' | 'layout' | 'template' | 'error' | 'redirect';

export interface RouteEntry extends EntryBase {
  /** Normalised URL path, e.g. '/orders/[id]'. Framework syntax preserved. */
  readonly path: string;
  readonly kind: RouteKind;
  /** Dynamic segment names, e.g. ['id']. Empty for static routes. */
  readonly params: readonly string[];
  /** True for catch-all / splat segments. */
  readonly isCatchAll: boolean;
  /** The component or handler file backing this route, when resolvable. */
  readonly component?: SourceRef;
  /** Layout files wrapping this route, outermost first. */
  readonly layoutChain: readonly SourceRef[];
  /** Auth guards observed in code (middleware matchers, HOCs, decorators). */
  readonly guards: readonly RouteGuard[];
  /** Route group / segment name where the framework has one. */
  readonly group?: string;
}

export interface RouteGuard {
  /** e.g. 'middleware', 'withAuth', 'requireRole'. */
  readonly name: string;
  readonly source: SourceRef;
}

export type RoutesResult = ExtractResult<RouteEntry>;

// ── endpoints ────────────────────────────────────────────────────────────────

export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS'
  /** Registered via app.all() or equivalent. */
  | 'ALL';

export interface EndpointEntry extends EntryBase {
  readonly method: HttpMethod;
  /** Full mounted path, with router prefixes resolved where statically knowable. */
  readonly path: string;
  readonly params: readonly string[];
  /** The handler function's location. */
  readonly handler?: SourceRef;
  /** Middleware in the order it runs. Auth guards usually appear here. */
  readonly middleware: readonly string[];
  /** Statically knowable request shape (zod/joi schema name, DTO type). */
  readonly requestShape?: ShapeRef;
  readonly responseShape?: ShapeRef;
  /**
   * Cross-check against a declared OpenAPI/swagger spec. Absent when no spec
   * was found. `mismatch` is reported as a Gap, never silently reconciled —
   * code is authoritative, the annotation is not.
   */
  readonly specStatus?: 'match' | 'mismatch' | 'undeclared';
}

/** A reference to a type/validator, not the resolved type itself. */
export interface ShapeRef {
  /** e.g. 'CreateOrderSchema', 'OrderDto'. */
  readonly name: string;
  /** 'zod' | 'joi' | 'yup' | 'typescript' | 'openapi' | ... */
  readonly kind: string;
  readonly source?: SourceRef;
}

export type EndpointsResult = ExtractResult<EndpointEntry>;

// ── schema ───────────────────────────────────────────────────────────────────

export interface SchemaEntry extends EntryBase {
  /** Table or collection name as it exists in the datastore. */
  readonly name: string;
  readonly kind: 'table' | 'collection' | 'view';
  /** The model/entity name in code, when it differs from `name`. */
  readonly modelName?: string;
  readonly fields: readonly SchemaField[];
  readonly indexes: readonly SchemaIndex[];
  readonly relations: readonly SchemaRelation[];
}

export interface SchemaField {
  readonly name: string;
  /** Type as the ORM declares it. Not normalised across ORMs — that would lose information. */
  readonly type: string;
  readonly nullable?: boolean;
  readonly isPrimaryKey?: boolean;
  readonly isUnique?: boolean;
  /** Literal default as written in the schema, when there is one. */
  readonly defaultValue?: string;
}

export interface SchemaIndex {
  readonly name?: string;
  readonly fields: readonly string[];
  readonly unique?: boolean;
}

export interface SchemaRelation {
  readonly field: string;
  readonly targetModel: string;
  readonly cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
}

export type SchemaResult = ExtractResult<SchemaEntry>;

// ── deps ─────────────────────────────────────────────────────────────────────

export interface ModuleEntry extends EntryBase {
  /** Repo-relative module path; doubles as the node id in modules.mmd. */
  readonly module: string;
  /** Repo-relative paths of internal modules this one imports. */
  readonly imports: readonly string[];
  /** Bare specifiers of external packages, e.g. 'axios'. */
  readonly externals: readonly string[];
}

export interface DepsResult extends ExtractResult<ModuleEntry> {
  /** Each cycle as an ordered list of module paths. Empty when acyclic. */
  readonly cycles: readonly (readonly string[])[];
}

// ── jobs ─────────────────────────────────────────────────────────────────────

export type JobKind = 'cron' | 'queue-consumer' | 'worker' | 'scheduled-task';

export interface JobEntry extends EntryBase {
  readonly name: string;
  readonly kind: JobKind;
  /** Cron expression or interval, verbatim, when statically knowable. */
  readonly schedule?: string;
  /** Queue, topic, or exchange name for consumers. */
  readonly channel?: string;
  readonly handler?: SourceRef;
  /** Library that registers the job, e.g. 'amqplib', 'node-cron', 'bullmq'. */
  readonly runtime?: string;
}

export type JobsResult = ExtractResult<JobEntry>;

// ── config ───────────────────────────────────────────────────────────────────

export interface ConfigEntry extends EntryBase {
  /** Env var name or feature flag key. */
  readonly name: string;
  readonly kind: 'env' | 'flag';
  /** Every site that reads this value. */
  readonly reads: readonly SourceRef[];
  /** Every site that declares it (.env files, schema validators, CI manifests). */
  readonly declarations: readonly SourceRef[];
  /**
   * Default written in code, when there is a literal fallback. Values from
   * .env files are never captured — they are frequently secrets.
   */
  readonly defaultValue?: string;
  /** True when the name matched a secret-shaped pattern; value never recorded. */
  readonly isSecretLike: boolean;
}

export type ConfigResult = ExtractResult<ConfigEntry>;

// ── aggregate ────────────────────────────────────────────────────────────────

/** The complete static lane for one repo. Input to every renderer. */
export interface ExtractionBundle {
  readonly routes: RoutesResult;
  readonly endpoints: EndpointsResult;
  readonly schema: SchemaResult;
  readonly deps: DepsResult;
  readonly jobs: JobsResult;
  readonly config: ConfigResult;
}
