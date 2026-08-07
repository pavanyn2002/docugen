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
