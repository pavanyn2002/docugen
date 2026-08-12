/**
 * Where docgen keeps its own bookkeeping.
 *
 * These live here, in the static lane, rather than next to the code that writes
 * them. The README has to be able to say whether inferred documentation exists
 * without importing anything from the LLM lane — knowing the path is not the
 * same as being able to run a model, and the import boundary should not have to
 * be weakened to state a fact about the filesystem.
 */

/** Inferred feature cards, one YAML file per surface. */
export const CARDS_DIR = 'docs/.cards';

/** Recorded developer answers. Human-authored ground truth, never regenerated. */
export const ANSWERS_DIR = 'docs/.answers';

/** Triaged requirements, bugs, and decisions. Also human-authored. */
export const REQUIREMENTS_DIR = 'docs/.requirements';

/** Stable, human-owned product feature records. */
export const FEATURES_DIR = 'docs/.features';

/** Human-owned feature plans and their lifecycle history. */
export const PLANS_DIR = 'docs/.plans';

/** Attributed snapshots of governed code changes. */
export const CHANGES_DIR = 'docs/.changes';

/** Human-reviewed decisions for replacing, retaining, or archiving legacy documentation. */
export const LEGACY_DIR = 'docs/.legacy';
export const LEGACY_MIGRATION_FILE = `${LEGACY_DIR}/migration.json`;
export const LEGACY_REPLACEMENT_PLAN_FILE = `${LEGACY_DIR}/replacement-plan.json`;
export const LEGACY_ARCHIVE_PLAN_FILE = `${LEGACY_DIR}/archive-plan.json`;
export const LEGACY_ARCHIVE_DIR = 'docs/legacy-archive';

/** Human-owned, time-bounded governance exceptions. */
export const GOVERNANCE_DIR = 'docs/.governance';
export const GOVERNANCE_EXCEPTIONS_FILE = `${GOVERNANCE_DIR}/exceptions.json`;

/** Explicit schema-upgrade receipts and immutable pre-migration backups. */
export const MIGRATIONS_DIR = 'docs/.migrations';

/**
 * Where tests that cite a requirement id are looked for.
 *
 * Broad on purpose: docgen runs on any stack, and a test directory this misses
 * is reported as a requirement nothing covers — a false alarm that makes the
 * whole traceability matrix untrustworthy.
 */
export const DEFAULT_TEST_GLOBS: readonly string[] = Object.freeze([
  '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}',
  '**/test_*.py',
  '**/*_test.{py,go,rb}',
  '**/*Test.{java,kt,cs}',
  '**/*Spec.{java,kt,scala}',
  '**/tests/**/*.{ts,js,py,go,rb,java,kt,cs,php}',
  '**/__tests__/**/*.{ts,tsx,js,jsx}',
  '**/spec/**/*.{rb,ts,js}',
  '**/*.feature',
]);
