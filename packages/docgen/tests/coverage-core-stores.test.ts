import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { featureRecordSchema } from '../src/features/schema.js';
import { planRecordSchema } from '../src/plans/schema.js';
import { changeRecordSchema } from '../src/changes/schema.js';
import { loadFeatureRecords, writeNewFeatureRecord } from '../src/features/store.js';
import { loadPlanRecords, updatePlanStatus, writeNewPlanRecord } from '../src/plans/store.js';
import { loadChangeRecords, writeNewChangeRecord } from '../src/changes/store.js';
import { addGovernanceException, loadGovernanceExceptions } from '../src/governance/store.js';
import { governanceExceptionsSchema } from '../src/governance/schema.js';
import { loadLegacyMigrationManifest, writeNewLegacyMigrationManifest, writeUpdatedLegacyMigrationManifest } from '../src/legacy/store.js';
import { legacyMigrationManifestSchema } from '../src/legacy/schema.js';
import { loadAnswers, recordAnswer, renderAnswersForPrompt } from '../src/questions/store.js';
import { loadRequirements, nextRequirementId, recordRequirement } from '../src/requirements/store.js';
import { ANSWERS_DIR, REQUIREMENTS_DIR, LEGACY_MIGRATION_FILE, GOVERNANCE_EXCEPTIONS_FILE } from '../src/config/paths.js';

const roots: string[] = [];
const date = '2026-08-12T00:00:00.000Z';
const feature = () => featureRecordSchema.parse({ schemaVersion: 1, id: 'a', title: 'A', recordedBy: 'owner', recordedAt: date });
const plan = () => planRecordSchema.parse({ schemaVersion: 1, id: 'a', featureId: 'a', title: 'A', summary: 'A', recordedBy: 'owner', recordedAt: date });
const change = () => changeRecordSchema.parse({ schemaVersion: 1, id: 'a', kind: 'fix', summary: 'A', featureIds: ['a'], base: 'HEAD', files: [{ status: 'modified', file: 'a' }], recordedBy: 'owner', recordedAt: date });
const legacy = () => legacyMigrationManifestSchema.parse({ schemaVersion: 1, createdBy: 'owner', createdAt: date, evidenceGraphSha256: 'a'.repeat(64), policy: 'no-human-document-moves-without-approval', documents: [] });
const exception = () => ({ id: 'a', policy: 'changed-feature-plan' as const, owner: 'owner', reason: 'reviewed', recordedAt: date, expiresAt: '2099-01-01T00:00:00.000Z' });
async function repo() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-core-store-')); roots.push(root); return root; }
async function write(root: string, file: string, contents: string) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), contents); }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('human-owned record publication', () => {
  it.each(['feature', 'plan', 'change'] as const)('reports invalid JSON, schema, filename and duplicate %s records', async kind => {
    const root = await repo();
    const dir = `docs/.${kind === 'feature' ? 'features' : kind === 'plan' ? 'plans' : 'changes'}`;
    const load = kind === 'feature' ? loadFeatureRecords : kind === 'plan' ? loadPlanRecords : loadChangeRecords;
    const record = kind === 'feature' ? feature() : kind === 'plan' ? plan() : change();
    await write(root, `${dir}/wrong.json`, '{');
    await expect(load(root)).rejects.toMatchObject({ code: `${kind}-record-unparseable` });
    await write(root, `${dir}/wrong.json`, '{}');
    await expect(load(root)).rejects.toMatchObject({ code: `${kind}-record-invalid` });
    await write(root, `${dir}/wrong.json`, JSON.stringify(record));
    await expect(load(root)).rejects.toMatchObject({ code: `${kind}-record-filename-mismatch` });
    await fs.rename(path.join(root, `${dir}/wrong.json`), path.join(root, `${dir}/a.json`));
    const operation = kind === 'feature' ? writeNewFeatureRecord(root, feature()) : kind === 'plan' ? writeNewPlanRecord(root, plan()) : writeNewChangeRecord(root, change());
    await expect(operation).rejects.toMatchObject({ code: `${kind}-already-exists` });
  });
  it.each(['feature', 'plan', 'change', 'legacy'] as const)('handles competing create and disk failure for %s', async kind => {
    const root = await repo();
    const operation = () => kind === 'feature' ? writeNewFeatureRecord(root, feature()) : kind === 'plan' ? writeNewPlanRecord(root, plan()) : kind === 'change' ? writeNewChangeRecord(root, change()) : writeNewLegacyMigrationManifest(root, legacy());
    const collision = Object.assign(new Error('competing create'), { code: 'EEXIST' });
    vi.spyOn(fs, 'link').mockRejectedValueOnce(collision);
    await expect(operation()).rejects.toMatchObject({ code: kind === 'legacy' ? 'legacy-migration-already-exists' : `${kind}-already-exists` });
    const disk = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    vi.spyOn(fs, 'link').mockRejectedValueOnce(disk);
    await expect(operation()).rejects.toBe(disk);
    expect((await fs.readdir(path.join(root, kind === 'legacy' ? path.dirname(LEGACY_MIGRATION_FILE) : `docs/.${kind === 'feature' ? 'features' : kind === 'plan' ? 'plans' : 'changes'}`))).filter(name => name.includes('.tmp') || name.includes('.docgen-tmp'))).toEqual([]);
  });
  it('rejects a duplicate alias across distinct features', async () => {
    const root = await repo();
    await write(root, 'docs/.features/a.json', JSON.stringify({ ...feature(), aliases: ['shared'] }));
    await write(root, 'docs/.features/b.json', JSON.stringify({ ...feature(), id: 'b', aliases: ['shared'] }));
    await expect(loadFeatureRecords(root)).rejects.toMatchObject({ code: 'feature-name-collision' });
  });
  it('validates feature and plan cross-field invariants', () => {
    expect(featureRecordSchema.safeParse({ ...feature(), aliases: ['a', 'a'], selectors: { files: ['C:/outside'], nodes: [] } }).success).toBe(false);
    const transition = (from: string, to: string) => ({ from, to, changedBy: 'owner', changedAt: date });
    const result = planRecordSchema.safeParse({ ...plan(), acceptanceCriteria: [{ id: 'AC-01', text: 'A' }, { id: 'AC-01', text: 'B' }], transitions: [transition('draft', 'approved'), transition('draft', 'completed')] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(issue => issue.message)).toEqual(expect.arrayContaining(['criterion ids must be unique', 'final transition must end at the current status', 'transition history must form a continuous chain']));
  });
  it('reports missing plans, terminal states, and interrupted status updates', async () => {
    const root = await repo();
    const args = { root, id: 'a', status: 'approved' as const, changedBy: 'owner', changedAt: date };
    await expect(updatePlanStatus(args)).rejects.toMatchObject({ code: 'plan-not-found' });
    await writeNewPlanRecord(root, plan());
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(updatePlanStatus(args)).rejects.toMatchObject({ code: 'plan-update-failed' });
    expect((await loadPlanRecords(root))[0]?.status).toBe('draft');
    await updatePlanStatus(args);
    await updatePlanStatus({ ...args, status: 'cancelled', note: 'obsolete' });
    await expect(updatePlanStatus(args)).rejects.toMatchObject({ code: 'plan-transition-invalid', remedy: expect.stringContaining('terminal state') });
  });
  it('preserves governance exceptions on parse and publication failures', async () => {
    const root = await repo();
    await write(root, GOVERNANCE_EXCEPTIONS_FILE, '{');
    await expect(loadGovernanceExceptions(root)).rejects.toMatchObject({ code: 'governance-exceptions-unparseable' });
    await write(root, GOVERNANCE_EXCEPTIONS_FILE, '{}');
    await expect(loadGovernanceExceptions(root)).rejects.toMatchObject({ code: 'governance-exceptions-invalid' });
    await fs.rm(path.join(root, GOVERNANCE_EXCEPTIONS_FILE));
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk error'));
    await expect(addGovernanceException({ root, exception: exception() })).rejects.toMatchObject({ code: 'governance-exception-write-failed' });
    await addGovernanceException({ root, exception: exception() });
    await expect(addGovernanceException({ root, exception: exception() })).rejects.toMatchObject({ code: 'governance-exception-exists' });
    expect(governanceExceptionsSchema.safeParse({ schemaVersion: 1, exceptions: [exception(), exception()] }).success).toBe(false);
    const permission = Object.assign(new Error('access denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(permission);
    await expect(loadGovernanceExceptions(root)).rejects.toBe(permission);
  });
  it('keeps the previous legacy manifest when an explicit update cannot publish', async () => {
    const root = await repo();
    await expect(loadLegacyMigrationManifest(root)).rejects.toMatchObject({ code: 'legacy-migration-missing' });
    await write(root, LEGACY_MIGRATION_FILE, '{');
    await expect(loadLegacyMigrationManifest(root)).rejects.toMatchObject({ code: 'legacy-migration-unparseable' });
    await write(root, LEGACY_MIGRATION_FILE, '{}');
    await expect(loadLegacyMigrationManifest(root)).rejects.toMatchObject({ code: 'legacy-migration-invalid' });
    await fs.rm(path.join(root, LEGACY_MIGRATION_FILE));
    await writeNewLegacyMigrationManifest(root, legacy());
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(writeUpdatedLegacyMigrationManifest(root, { ...legacy(), createdBy: 'new-owner' })).rejects.toMatchObject({ code: 'legacy-migration-update-failed' });
    expect((await loadLegacyMigrationManifest(root)).createdBy).toBe('owner');
    await writeUpdatedLegacyMigrationManifest(root, { ...legacy(), createdBy: 'new-owner' });
    expect((await loadLegacyMigrationManifest(root)).createdBy).toBe('new-owner');
  });
  it.each(['feature', 'plan', 'change', 'legacy', 'governance', 'plan-update', 'legacy-update'] as const)('preserves the original %s error when temporary cleanup also fails', async kind => {
    const root = await repo();
    if (kind === 'plan-update') await writeNewPlanRecord(root, plan());
    if (kind === 'legacy-update') await writeNewLegacyMigrationManifest(root, legacy());
    const publication = new Error('publication failure');
    vi.spyOn(fs, 'rename').mockRejectedValue(publication);
    vi.spyOn(fs, 'link').mockRejectedValue(publication);
    vi.spyOn(fs, 'rm').mockRejectedValue(new Error('cleanup failure'));
    const operation = kind === 'feature' ? writeNewFeatureRecord(root, feature()) : kind === 'plan' ? writeNewPlanRecord(root, plan()) : kind === 'change' ? writeNewChangeRecord(root, change()) : kind === 'legacy' ? writeNewLegacyMigrationManifest(root, legacy()) : kind === 'governance' ? addGovernanceException({ root, exception: exception() }) : kind === 'plan-update' ? updatePlanStatus({ root, id: 'a', status: 'approved', changedBy: 'owner', changedAt: date }) : writeUpdatedLegacyMigrationManifest(root, legacy());
    if (kind === 'governance') await expect(operation).rejects.toMatchObject({ code: 'governance-exception-write-failed', cause: publication });
    else if (kind === 'plan-update') await expect(operation).rejects.toMatchObject({ code: 'plan-update-failed', cause: publication });
    else if (kind === 'legacy-update') await expect(operation).rejects.toMatchObject({ code: 'legacy-migration-update-failed', cause: publication });
    else await expect(operation).rejects.toBe(publication);
  });
  it('canonicalizes record arrays, file order and document replacement order', async () => {
    const root = await repo();
    await writeNewChangeRecord(root, { ...change(), featureIds: ['z', 'a'], planIds: ['z', 'a'], surfaceIds: ['z', 'a'], requirementIds: ['z', 'a'], testFiles: ['z', 'a'], generatedPages: ['z', 'a'], files: [{ status: 'added', file: 'z' }, { status: 'added', file: 'a' }] });
    await writeNewChangeRecord(root, { ...change(), id: 'z' });
    expect((await loadChangeRecords(root))[0]?.files.map(file => file.file)).toEqual(['a', 'z']);
    await writeNewFeatureRecord(root, { ...feature(), id: 'z' });
    await writeNewFeatureRecord(root, feature());
    expect((await loadFeatureRecords(root)).map(feature => feature.id)).toEqual(['a', 'z']);
    await writeNewPlanRecord(root, { ...plan(), acceptanceCriteria: [{ id: 'AC-02', text: 'Z' }, { id: 'AC-01', text: 'A' }] });
    await writeNewPlanRecord(root, { ...plan(), id: 'z' });
    expect((await loadPlanRecords(root)).map(plan => plan.id)).toEqual(['a', 'z']);
  });
});

describe('partially populated human YAML', () => {
  it('skips non-record answers while applying conservative metadata defaults', async () => {
    const root = await repo();
    const values = [null, 'text', {}, { surfaceId: 'empty' }, { surfaceId: 'a', answers: [null, 'text', {}, { questionId: 1, answer: 'A' }, { questionId: 'q', answer: 1 }, { questionId: 'q', answer: 'A' }] }];
    for (const [index, value] of values.entries()) await write(root, `${ANSWERS_DIR}/${index}.yml`, YAML.stringify(value));
    const loaded = await loadAnswers(root);
    expect(loaded.size).toBe(2);
    expect(loaded.get('a')).toMatchObject({ slug: '4', answers: [{ question: '', answeredBy: 'unknown', answeredAt: '' }] });
    expect(renderAnswersForPrompt(loaded.get('a')!.answers)).toContain('**q**');
    await fs.rename(path.join(root, `${ANSWERS_DIR}/4.yml`), path.join(root, `${ANSWERS_DIR}/4.yaml`));
    await recordAnswer({ root, surfaceId: 'a', slug: '4', answer: { questionId: 'next', question: 'Next?', answer: 'yes', answeredBy: 'owner', answeredAt: date, note: 'reviewed' } });
    expect((await loadAnswers(root)).get('a')?.answers).toHaveLength(2);
  });
  it('loads only minimally valid requirements and preserves explicit metadata', async () => {
    const root = await repo();
    const entries = [null, 'text', {}, { id: 'a', questionId: 1, statement: 'A' }, { id: 'a', questionId: 'q', statement: 1 }, { id: 'REQ-a-01', questionId: 'q', statement: 'A' }, { id: 'REQ-a-02', questionId: 'q2', statement: 'B', kind: 'requirement', status: 'confirmed', title: 'B', surfaceId: 'explicit', recordedBy: 'owner', recordedAt: date, note: 'reviewed' }];
    for (const [index, value] of [null, 'text', {}, { surfaceId: 'empty' }, { surfaceId: 'a', requirements: entries }].entries()) await write(root, `${REQUIREMENTS_DIR}/${index}.yml`, YAML.stringify(value));
    const loaded = await loadRequirements(root);
    expect(loaded.size).toBe(2);
    expect(loaded.get('a')).toMatchObject({ slug: '4', requirements: [{ kind: 'context', status: 'confirmed', title: 'q', recordedBy: 'unknown', recordedAt: '' }, { surfaceId: 'explicit', note: 'reviewed' }] });
    expect(nextRequirementId([{ id: 'REQ-a-not-a-number' }, { id: 'REQ-a-03' }], 'requirement', 'a')).toBe('REQ-a-04');
    await fs.rename(path.join(root, `${REQUIREMENTS_DIR}/4.yml`), path.join(root, `${REQUIREMENTS_DIR}/4.yaml`));
    await recordRequirement({ root, surfaceId: 'a', slug: '4', kind: 'requirement', title: 'A', statement: 'updated', questionId: 'q', recordedBy: 'owner', recordedAt: date, status: 'disputed', note: 'reviewed' });
    expect((await loadRequirements(root)).get('a')?.requirements.find(item => item.questionId === 'q')).toMatchObject({ id: 'REQ-4-01', note: 'reviewed' });
  });
});
