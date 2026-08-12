import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentBackend } from '../agents/types.js';
import type { Surface } from '../surface/types.js';
import type { EvidenceGraph } from '../graph/types.js';
import type { Logger } from '../util/logger.js';
import { compareStrings } from '../util/sort.js';
import { buildSurfaceContext } from './context.js';
import type { ContextLimits } from './context.js';
import type { ExtractionBundleLike } from './facts.js';
import { featureCardSchema } from './types.js';
import type { CardFailure, FeatureCard, InferenceResult } from './types.js';
import { renderAnswersForPrompt } from '../questions/store.js';
import type { SurfaceAnswers } from '../questions/store.js';
import { redactSecrets } from '../privacy/redact.js';
import type { EvidenceExcerpt } from './context.js';
import type { FeatureCardBody } from './types.js';
import { toPosix } from '../util/paths.js';

/** Bumped whenever the prompt changes, so old cards are regenerated. */
export const PROMPT_VERSION = 'feature-card.v2';

export interface InferOptions {
  readonly root: string;
  readonly surfaces: readonly Surface[];
  readonly bundle: ExtractionBundleLike;
  readonly graph?: EvidenceGraph;
  readonly answers: ReadonlyMap<string, SurfaceAnswers>;
  readonly backend: AgentBackend;
  readonly limits: ContextLimits;
  readonly timeoutMs: number;
  readonly model?: string;
  /** Cards from a previous run, keyed by surface id, for cache reuse. */
  readonly previous?: ReadonlyMap<string, FeatureCard>;
  /** Re-run every surface even when its inputs are unchanged. */
  readonly force?: boolean;
  readonly logger: Logger;
  /** Stop after this many surfaces. Used by `--limit` to bound a first run. */
  readonly maxSurfaces?: number;
  readonly redactSecrets?: boolean;
}

/**
 * Generate a feature card per surface.
 *
 * Surfaces run one at a time. The backends are interactive coding CLIs that
 * each spawn a process and hold a model session; running many at once is a
 * reliable way to hit rate limits and to make a large repo unusable while it
 * runs.
 */
export async function inferCards(options: InferOptions): Promise<InferenceResult> {
  const template = await loadPromptTemplate();
  const cards: FeatureCard[] = [];
  const failures: CardFailure[] = [];
  const reused: string[] = [];

  const targets =
    options.maxSurfaces === undefined ? options.surfaces : options.surfaces.slice(0, options.maxSurfaces);

  for (const [index, surface] of targets.entries()) {
    const surfaceAnswers = options.answers.get(surface.id)?.answers ?? [];
    const context = await buildSurfaceContext({
      root: options.root,
      surface,
      bundle: options.bundle,
      ...(options.graph === undefined ? {} : { graph: options.graph }),
      limits: options.limits,
      redact: options.redactSecrets !== false,
    });

    const inputHash = hashInputs(context.contentHash, surfaceAnswers.map((a) => a.questionId + a.answer));

    // Reuse is the cost control that makes this affordable to run in CI. A
    // surface whose code and answers are unchanged produces the same card, so
    // there is nothing to gain from paying for it again.
    const previous = options.previous?.get(surface.id);
    if (
      options.force !== true &&
      previous !== undefined &&
      previous.inputHash === inputHash &&
      previous.promptVersion === PROMPT_VERSION
    ) {
      cards.push({ ...previous, answered: surfaceAnswers.map((answer) => answer.questionId) });
      reused.push(surface.id);
      continue;
    }

    options.logger.info(
      `  [${index + 1}/${targets.length}] ${surface.title} ${
        context.omittedFiles.length > 0 ? `(${context.omittedFiles.length} files omitted)` : ''
      }`,
    );

    const rawPrompt = template
      .replace('{{FACTS}}', context.facts)
      .replace('{{GRAPH}}', context.graph)
      .replace('{{ANSWERS}}', renderAnswersForPrompt(surfaceAnswers))
      .replace('{{CODE}}', context.code);
    const promptResult = options.redactSecrets === false
      ? { text: rawPrompt, count: 0, kinds: [] as readonly string[] }
      : redactSecrets(rawPrompt);
    const prompt = promptResult.text;

    options.logger.info(
      `    disclosure: ${context.includedFiles.length} file(s), ${Buffer.byteLength(prompt)} bytes, ` +
        `provider=${options.backend.id}, model=${options.model ?? 'backend-default'}, ` +
        `graph=${context.graphNodeCount} nodes/${context.graphEdgeCount} edges, ` +
        `redactions=${context.redactions + promptResult.count}`,
    );
    options.logger.info(`    files: ${context.includedFiles.join(', ') || '(none)'}`);

    const outcome = await options.backend.run({
      prompt,
      cwd: options.root,
      timeoutMs: options.timeoutMs,
      ...(options.model === undefined ? {} : { model: options.model }),
    });

    if (!outcome.ok) {
      failures.push({ surfaceId: surface.id, slug: surface.slug, title: surface.title, reason: outcome.reason });
      continue;
    }

    const parsed = parseCardBody(outcome.text);
    if (!parsed.ok) {
      // Unparseable output is a non-answer. Salvaging prose out of it is
      // exactly the fabrication this design exists to prevent.
      failures.push({
        surfaceId: surface.id,
        slug: surface.slug,
        title: surface.title,
        reason: parsed.reason,
      });
      continue;
    }

    const evidenceIssue = validateCardEvidence(parsed.body, context.includedEvidence);
    if (evidenceIssue !== undefined) {
      failures.push({
        surfaceId: surface.id,
        slug: surface.slug,
        title: surface.title,
        reason: evidenceIssue,
      });
      continue;
    }

    cards.push({
      surfaceId: surface.id,
      slug: surface.slug,
      title: surface.title,
      kind: surface.kind,
      body: parsed.body,
      producedBy: options.backend.id,
      inputHash,
      promptVersion: PROMPT_VERSION,
      answered: surfaceAnswers.map((answer) => answer.questionId),
    });
  }

  return {
    cards: cards.sort((a, b) => compareStrings(a.slug, b.slug)),
    failures: failures.sort((a, b) => compareStrings(a.slug, b.slug)),
    reused,
    backendId: options.backend.id,
  };
}

/** Reject citations to source that was not present in the transmitted prompt. */
export function validateCardEvidence(
  body: FeatureCardBody,
  excerpts: readonly EvidenceExcerpt[],
): string | undefined {
  const claims = [body.summary, ...body.userVisibleBehaviour, ...body.states, ...body.edgeCases];
  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      const file = normaliseCitationPath(evidence.file);
      if (file === undefined) {
        return `The model cited an invalid or non-relative source path: '${evidence.file}'.`;
      }
      const fileRanges = excerpts.filter((excerpt) => excerpt.file === file);
      if (fileRanges.length === 0) {
        return `The model cited '${evidence.file}', but that file was not included in its context.`;
      }
      if (evidence.line === undefined) {
        return `The model cited '${evidence.file}' without a line number; exact source evidence is required.`;
      }
      if (
        !fileRanges.some(
          (excerpt) => evidence.line! >= excerpt.startLine && evidence.line! <= excerpt.endLine,
        )
      ) {
        return `The model cited '${evidence.file}:${evidence.line}', but that line was not included in its context.`;
      }
    }
  }
  return undefined;
}

function normaliseCitationPath(value: string): string | undefined {
  const normalised = path.posix.normalize(toPosix(value).replace(/^\.\//, ''));
  if (path.posix.isAbsolute(normalised) || normalised === '..' || normalised.startsWith('../')) {
    return undefined;
  }
  return normalised;
}

type ParseOutcome =
  | { readonly ok: true; readonly body: ReturnType<typeof featureCardSchema.parse> }
  | { readonly ok: false; readonly reason: string };

/**
 * Extract and validate the JSON object from a model response.
 *
 * CLI backends wrap output in prose or a code fence however they like, so the
 * object is located rather than assumed. Validation is strict: unknown keys and
 * evidence-free claims are rejected, because a claim with no citation is the
 * thing this whole design is built to keep out.
 */
export function parseCardBody(text: string): ParseOutcome {
  const json = extractJsonObject(text);
  if (json === undefined) {
    return { ok: false, reason: 'The model returned no JSON object.' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'The model returned malformed JSON.' };
  }

  const result = featureCardSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      reason: `The model's JSON did not match the required shape: ${
        issue === undefined ? 'unknown issue' : `${issue.path.join('.') || '(root)'} — ${issue.message}`
      }`,
    };
  }

  return { ok: true, body: result.data };
}

/** The outermost balanced `{...}`, ignoring braces inside strings. */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index] as string;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return undefined;
}

function hashInputs(contentHash: string, answerKeys: readonly string[]): string {
  return createHash('sha256')
    .update(PROMPT_VERSION)
    .update(' ')
    .update(contentHash)
    .update(' ')
    .update([...answerKeys].sort(compareStrings).join('|'))
    .digest('hex')
    .slice(0, 32);
}

/** Prompts ship as plain files so they can be reviewed and versioned. */
async function loadPromptTemplate(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'prompts', `${PROMPT_VERSION}.md`),
    path.resolve(here, '..', '..', '..', 'prompts', `${PROMPT_VERSION}.md`),
  ];

  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch {
      // Try the next location.
    }
  }
  throw new Error(`Could not locate prompt pack ${PROMPT_VERSION}.md`);
}
