import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GOVERNANCE_EXCEPTIONS_FILE } from '../config/paths.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { compareStrings } from '../util/sort.js';
import { GOVERNANCE_EXCEPTION_SCHEMA_VERSION, governanceExceptionSchema, governanceExceptionsSchema } from './schema.js';
import type { GovernanceException, GovernanceExceptions } from './schema.js';

export function serialiseGovernanceExceptions(value: GovernanceExceptions): string {
  return `${JSON.stringify({ schemaVersion: GOVERNANCE_EXCEPTION_SCHEMA_VERSION, exceptions: [...value.exceptions].sort((a, b) => compareStrings(a.id, b.id)) }, null, 2)}\n`;
}

export async function loadGovernanceExceptions(root: string): Promise<GovernanceExceptions> {
  const file = path.join(root, GOVERNANCE_EXCEPTIONS_FILE);
  let contents: string;
  try { contents = await fs.readFile(file, 'utf8'); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: GOVERNANCE_EXCEPTION_SCHEMA_VERSION, exceptions: [] };
    throw cause;
  }
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch (cause) {
    throw new DocgenError({ code: 'governance-exceptions-unparseable', message: `${GOVERNANCE_EXCEPTIONS_FILE} is not valid JSON: ${describeUnknownError(cause)}`, remedy: 'Repair the human-owned exception record; invalid exceptions are never ignored.', file: GOVERNANCE_EXCEPTIONS_FILE, cause });
  }
  const parsed = governanceExceptionsSchema.safeParse(value);
  if (!parsed.success) throw new DocgenError({ code: 'governance-exceptions-invalid', message: `${GOVERNANCE_EXCEPTIONS_FILE} is invalid: ${parsed.error.issues[0]?.message ?? 'invalid shape'}.`, remedy: 'Fix the reported exception field. Every exception needs a policy, owner, reason, and timestamped expiry.', file: GOVERNANCE_EXCEPTIONS_FILE });
  return parsed.data;
}

export async function addGovernanceException(args: { readonly root: string; readonly exception: GovernanceException; readonly now?: Date }): Promise<string> {
  const parsed = governanceExceptionSchema.parse(args.exception);
  const now = args.now ?? new Date();
  if (Date.parse(parsed.expiresAt) <= now.getTime()) throw new DocgenError({ code: 'governance-exception-expired', message: `Exception '${parsed.id}' does not expire in the future.`, remedy: 'Pass a future ISO-8601 timestamp. Permanent exceptions are deliberately unsupported.' });
  const current = await loadGovernanceExceptions(args.root);
  if (current.exceptions.some((item) => item.id === parsed.id)) throw new DocgenError({ code: 'governance-exception-exists', message: `Governance exception '${parsed.id}' already exists.`, remedy: 'Use a new immutable exception id; do not silently replace audit history.', file: GOVERNANCE_EXCEPTIONS_FILE });
  const file = path.join(args.root, GOVERNANCE_EXCEPTIONS_FILE);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, serialiseGovernanceExceptions({ schemaVersion: GOVERNANCE_EXCEPTION_SCHEMA_VERSION, exceptions: [...current.exceptions, parsed] }), 'utf8');
    await fs.rename(temporary, file);
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new DocgenError({ code: 'governance-exception-write-failed', message: `Could not write ${GOVERNANCE_EXCEPTIONS_FILE}.`, remedy: 'Check repository permissions and retry.', file: GOVERNANCE_EXCEPTIONS_FILE, cause });
  }
  return GOVERNANCE_EXCEPTIONS_FILE;
}
