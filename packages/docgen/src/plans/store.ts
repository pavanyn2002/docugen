import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { PLANS_DIR } from '../config/paths.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import { toPosix } from '../util/paths.js';
import { compareStrings } from '../util/sort.js';
import { planRecordSchema } from './schema.js';
import type { PlanRecord, StoredPlanRecord } from './schema.js';
import type { PlanStatus } from './schema.js';

function planFile(id: string): string {
  return `${PLANS_DIR}/${id}.json`;
}

export function serialisePlanRecord(record: PlanRecord): string {
  const canonical: PlanRecord = {
    ...record,
    acceptanceCriteria: [...record.acceptanceCriteria].sort((a, b) => compareStrings(a.id, b.id)),
    risks: [...record.risks],
    testNotes: [...record.testNotes],
    transitions: [...record.transitions],
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

const ALLOWED_TRANSITIONS: Readonly<Record<PlanStatus, readonly PlanStatus[]>> = {
  draft: ['approved', 'cancelled'],
  approved: ['in-progress', 'cancelled'],
  'in-progress': ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export async function updatePlanStatus(args: {
  readonly root: string;
  readonly id: string;
  readonly status: PlanStatus;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly note?: string;
}): Promise<StoredPlanRecord> {
  const current = (await loadPlanRecords(args.root)).find((plan) => plan.id === args.id);
  if (current === undefined) {
    throw new DocgenError({
      code: 'plan-not-found',
      message: `Plan '${args.id}' does not exist.`,
      remedy: 'Run `docgen plan list`, or create the plan first.',
    });
  }
  if (!ALLOWED_TRANSITIONS[current.status].includes(args.status)) {
    throw new DocgenError({
      code: 'plan-transition-invalid',
      message: `Plan '${args.id}' cannot move from '${current.status}' to '${args.status}'.`,
      remedy: `Allowed next states: ${ALLOWED_TRANSITIONS[current.status].join(', ') || 'none; this is a terminal state'}.`,
      file: current.sourceFile,
    });
  }
  const { sourceFile, ...record } = current;
  const updated = planRecordSchema.parse({
    ...record,
    status: args.status,
    transitions: [
      ...record.transitions,
      {
        from: current.status,
        to: args.status,
        changedBy: args.changedBy,
        changedAt: args.changedAt,
        ...(args.note === undefined ? {} : { note: args.note }),
      },
    ],
  });
  const absolute = path.join(args.root, sourceFile);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, serialisePlanRecord(updated), 'utf8');
    await fs.rename(temporary, absolute);
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new DocgenError({
      code: 'plan-update-failed',
      message: `Could not update plan '${args.id}'.`,
      remedy: 'Check file permissions and retry the explicit status transition.',
      file: sourceFile,
      cause,
    });
  }
  return { ...updated, sourceFile };
}

export async function loadPlanRecords(root: string): Promise<readonly StoredPlanRecord[]> {
  const files = (await fg(`${PLANS_DIR}/*.json`, { cwd: root, onlyFiles: true, dot: true }))
    .map(toPosix)
    .sort(compareStrings);
  const records: StoredPlanRecord[] = [];
  for (const relative of files) {
    let json: unknown;
    try {
      json = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
    } catch (cause) {
      throw new DocgenError({
        code: 'plan-record-unparseable',
        message: `${relative} is not valid JSON: ${describeUnknownError(cause)}`,
        remedy: 'Fix the plan record. Human-owned plans are never skipped silently.',
        file: relative,
        cause,
      });
    }
    const parsed = planRecordSchema.safeParse(json);
    if (!parsed.success) {
      throw new DocgenError({
        code: 'plan-record-invalid',
        message: `${relative} is not a valid plan: ${parsed.error.issues[0]?.message ?? 'invalid shape'}.`,
        remedy: 'Fix the reported field or recreate the plan with `docgen plan create`.',
        file: relative,
      });
    }
    const expected = planFile(parsed.data.id);
    if (relative !== expected) {
      throw new DocgenError({
        code: 'plan-record-filename-mismatch',
        message: `${relative} declares plan '${parsed.data.id}', but its canonical path is ${expected}.`,
        remedy: `Rename the file to ${expected}; keep the stable plan id unchanged.`,
        file: relative,
      });
    }
    records.push({ ...parsed.data, sourceFile: relative });
  }
  return records.sort((a, b) => compareStrings(a.id, b.id));
}

export async function writeNewPlanRecord(root: string, record: PlanRecord): Promise<string> {
  const parsed = planRecordSchema.parse(record);
  const existing = await loadPlanRecords(root);
  if (existing.some((candidate) => candidate.id === parsed.id)) {
    throw new DocgenError({
      code: 'plan-already-exists',
      message: `Plan '${parsed.id}' already exists.`,
      remedy: 'Use the existing plan id; plans are never replaced implicitly.',
      file: planFile(parsed.id),
    });
  }
  const relative = planFile(parsed.id);
  const absolute = path.join(root, relative);
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(temporary, serialisePlanRecord(parsed), { encoding: 'utf8', flag: 'wx' });
    await fs.link(temporary, absolute);
    await fs.rm(temporary, { force: true });
    return relative;
  } catch (cause) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new DocgenError({
        code: 'plan-already-exists',
        message: `Plan record already exists at ${relative}.`,
        remedy: 'Edit the human-owned record deliberately instead of replacing it implicitly.',
        file: relative,
        cause,
      });
    }
    throw cause;
  }
}
