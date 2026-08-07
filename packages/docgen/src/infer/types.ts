import { z } from 'zod';

/**
 * What the LLM is allowed to return, and nothing else.
 *
 * The schema is the enforcement point for the trust model. Every claim carries
 * evidence; every gap the model could not close becomes a question rather than
 * a confident sentence. Output that does not validate is discarded — a
 * malformed card is treated as "the model did not answer", never salvaged into
 * plausible prose.
 */

const evidenceSchema = z
  .object({
    /** Repo-relative file the claim is based on. */
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
  })
  .strict();

const claimSchema = z
  .object({
    text: z.string().min(1).max(2000),
    /**
     * Required. A claim with no evidence is exactly the kind of confident
     * invention this tool exists to prevent, so the schema refuses it.
     */
    evidence: z.array(evidenceSchema).min(1),
  })
  .strict();

const unknownSchema = z
  .object({
    /** Stable within a card, so an answer stays attached across regenerations. */
    id: z.string().min(1).max(80),
    /** Phrased as a question a developer can answer in one sentence. */
    question: z.string().min(1).max(500),
    /** Why it could not be determined from the code. */
    why: z.string().min(1).max(500),
    /**
     * Multiple choice where possible. Answering a question should be a tap,
     * not a writing task — that is the whole reason this loop works at all.
     */
    options: z.array(z.string().min(1).max(200)).max(6).default([]),
  })
  .strict();

export const featureCardSchema = z
  .object({
    /** One sentence: what this surface is for. */
    summary: claimSchema,
    /** What a user can observe it doing. */
    userVisibleBehaviour: z.array(claimSchema).max(12).default([]),
    /** States it can be in, including error and empty states. */
    states: z.array(claimSchema).max(12).default([]),
    /** Edge cases actually present in the code, not imagined ones. */
    edgeCases: z.array(claimSchema).max(12).default([]),
    /** Everything the model could not determine. */
    unknowns: z.array(unknownSchema).max(10).default([]),
  })
  .strict();

export type FeatureCardBody = z.infer<typeof featureCardSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Unknown = z.infer<typeof unknownSchema>;

/** A rendered card plus the provenance needed to decide whether to re-run it. */
export interface FeatureCard {
  readonly surfaceId: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: string;
  readonly body: FeatureCardBody;
  /** Backend id that produced it, for the front matter. */
  readonly producedBy: string;
  /** Hash of every input; an unchanged hash means no need to re-run. */
  readonly inputHash: string;
  /** Prompt pack version, so a prompt change invalidates old cards. */
  readonly promptVersion: string;
  /** Ids of unknowns that a recorded human answer has since resolved. */
  readonly answered: readonly string[];
}

/** A surface the model was asked about but could not be described. */
export interface CardFailure {
  readonly surfaceId: string;
  readonly slug: string;
  readonly title: string;
  /** Why — a backend error, a timeout, or output that did not validate. */
  readonly reason: string;
}

export interface InferenceResult {
  readonly cards: readonly FeatureCard[];
  readonly failures: readonly CardFailure[];
  /** Surfaces skipped because their inputs were unchanged. */
  readonly reused: readonly string[];
  readonly backendId: string;
}
