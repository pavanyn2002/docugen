/**
 * SPEC rule 6: fail loudly on malformed input, silently on absent input.
 *
 * A DocgenError is the "loudly" half — a condition the user must fix, reported
 * with enough context to fix it. Absent input never produces one; it produces a
 * Skip.
 */
export class DocgenError extends Error {
  /** Stable machine-readable code, e.g. 'config-invalid'. */
  readonly code: string;
  /** Concrete next step for the user. Not optional — an error without a remedy wastes their time. */
  readonly remedy: string;
  /** File the problem was found in, when applicable. */
  readonly file?: string;

  constructor(args: { code: string; message: string; remedy: string; file?: string; cause?: unknown }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = 'DocgenError';
    this.code = args.code;
    this.remedy = args.remedy;
    if (args.file !== undefined) this.file = args.file;
  }
}

export function isDocgenError(error: unknown): error is DocgenError {
  return error instanceof DocgenError;
}

/** Best-effort message extraction from an unknown thrown value. */
export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
