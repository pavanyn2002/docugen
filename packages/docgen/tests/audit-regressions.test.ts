import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { docgenConfigSchema } from '../src/config/schema.js';
import { runExtractCommand } from '../src/commands/extract.js';
import { runCheckCommand } from '../src/commands/check.js';
import { runBootstrapCommand } from '../src/commands/bootstrap.js';
import { runAnswerCommand } from '../src/commands/answer.js';
import { resolveInvocation } from '../src/commands/init.js';
import { runSessionStartCommand, runSessionAfterEditCommand, runSessionEndCommand } from '../src/commands/session.js';
import { installAdapters } from '../src/adapters/install.js';
import { renderPrePushHook } from '../src/adapters/hooks.js';
import { writeNewFeatureRecord } from '../src/features/store.js';
import { evaluateGovernance } from '../src/governance/evaluate.js';
import { loadCards, saveCards } from '../src/infer/store.js';
import type { FeatureCard } from '../src/infer/types.js';
import { recordAnswer } from '../src/questions/store.js';
import { runExtraction } from '../src/pipeline.js';
import { syncGenerated } from '../src/verify/write.js';
import { createLogger } from '../src/util/logger.js';
import { ENGINE_VERSION } from '../src/util/version.js';
import * as registry from '../src/agents/registry.js';

const created: string[] = [];
const logger = createLogger({ level: 'silent' });

async function repo(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-audit-regression-'));
  created.push(root);
  for (const [file, contents] of Object.entries({
    'package.json': JSON.stringify({ name: 'app', dependencies: { next: '^15.0.0' } }),
    'app/page.tsx': 'export default function Home() { return null; }\n',
    ...files,
  })) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), contents);
  }
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initGit(root: string): void {
  git(root, 'init');
  git(root, 'config', 'user.email', 'dev@example.com');
  git(root, 'config', 'user.name', 'Developer');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
}

function card(surfaceId = 'screen:/', slug = 'home', file = 'app/page.tsx'): FeatureCard {
  return {
    surfaceId, slug, title: slug, kind: 'screen', producedBy: 'fake', inputHash: 'old',
    promptVersion: 'feature-card.v2', answered: [],
    body: { summary: { text: `The ${slug} page.`, evidence: [{ file, line: 1 }] },
      userVisibleBehaviour: [], states: [], edgeCases: [], unknowns: [] },
  };
}

async function feature(root: string): Promise<void> {
  await writeNewFeatureRecord(root, {
    schemaVersion: 1, id: 'home', title: 'Home', aliases: [], status: 'active',
    owners: ['dev@example.com'], criticality: 'critical', selectors: { files: ['app/**'], nodes: [] },
    recordedBy: 'dev@example.com', recordedAt: '2026-08-01T00:00:00.000Z',
  });
}

function capture() {
  const chunks: string[] = [];
  const sink = { write: (chunk: string) => (chunks.push(chunk), true) } as unknown as NodeJS.WritableStream;
  return { logger: createLogger({ level: 'silent', stdout: sink }), json: () => JSON.parse(chunks.join('')) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(created.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('generated artifact ownership', () => {
  it('preserves unmarked documents in a shared output directory', async () => {
    const root = await repo({ 'docgen.config.json': '{"outDir":"docs","gitattributes":false}', 'docs/manual.md': '# Human guide\n' });
    const config = await loadConfig({ root });
    const preview = await syncGenerated({ config, logger, dryRun: true });
    expect(preview.deleted).not.toContain('docs/manual.md');
    await syncGenerated({ config, logger });
    expect(await fs.readFile(path.join(root, 'docs/manual.md'), 'utf8')).toBe('# Human guide\n');
    await expect(runCheckCommand({ cwd: root, logger })).resolves.toBeUndefined();
  });

  it('refuses to overwrite a human document at an expected output path before any write', async () => {
    const root = await repo({ 'docs/generated/api.md': '# Human API guide\n' });
    await expect(syncGenerated({ config: await loadConfig({ root }), logger })).rejects.toMatchObject({ code: 'generated-file-owned' });
    expect(await fs.readFile(path.join(root, 'docs/generated/api.md'), 'utf8')).toBe('# Human API guide\n');
    await expect(fs.stat(path.join(root, 'docs/generated/README.md'))).rejects.toThrow();
  });

  it.each(['.', '..', '../other', '/tmp/docs', 'C:\\outside', '.git', 'docs/.answers', 'docs\nother', '.GIT', 'NODE_MODULES', 'docs/.ANSWERS', '.git.', 'docs/.answers '])('rejects unsafe output directory %s', (outDir) => {
    expect(docgenConfigSchema.safeParse({ outDir }).success).toBe(false);
  });

  it('validates the CLI output override too', async () => {
    const root = await repo();
    await expect(runExtractCommand({ cwd: root, outDir: '../outside', dryRun: true, json: false, logger })).rejects.toMatchObject({ code: 'output-directory-invalid' });
  });

  it('rejects output symlinks without modifying their target', async () => {
    const root = await repo();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-symlink-target-'));
    created.push(outside);
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(outside, 'README.md'), '# Outside document\n');
    await fs.symlink(outside, path.join(root, 'docs/generated'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(syncGenerated({ config: await loadConfig({ root }), logger })).rejects.toMatchObject({ code: 'generated-path-symlink' });
    expect(await fs.readFile(path.join(outside, 'README.md'), 'utf8')).toBe('# Outside document\n');
  });

  it('removes only marked orphan pages', async () => {
    const root = await repo();
    const config = await loadConfig({ root });
    await syncGenerated({ config, logger });
    await fs.writeFile(path.join(root, 'docs/generated/old.md'), '<!-- docgen:generated -->\n# Old page\n');
    await fs.writeFile(path.join(root, 'docs/generated/manual.md'), '# Human guide\n');
    const report = await syncGenerated({ config, logger });
    expect(report.deleted).toEqual(['docs/generated/old.md']);
    expect(await fs.readFile(path.join(root, 'docs/generated/manual.md'), 'utf8')).toContain('Human guide');
  });

  it('preserves a human guide that quotes the generated marker', async () => {
    const manual = '# Guide\n\nExample:\n```html\n<!-- docgen:generated -->\n```\n';
    const root = await repo({ 'docs/generated/manual.md': manual });
    await syncGenerated({ config: await loadConfig({ root }), logger });
    expect(await fs.readFile(path.join(root, 'docs/generated/manual.md'), 'utf8')).toBe(manual);
  });
});

describe('behavior cache lifecycle', () => {
  it('refuses to prune or write through a linked card store', async () => {
    const root = await repo();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-card-symlink-'));
    created.push(outside);
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(outside, 'old.yaml'), '# Generated by docgen.\nkeep: true\n');
    await fs.symlink(outside, path.join(root, 'docs/.cards'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(saveCards(root, [], { replace: true })).rejects.toMatchObject({ code: 'generated-path-symlink' });
    expect(await fs.readFile(path.join(outside, 'old.yaml'), 'utf8')).toContain('keep: true');
    await expect(saveCards(root, [card()])).rejects.toMatchObject({ code: 'generated-path-symlink' });
  });

  it('removes behavior pages for deleted surfaces while retaining human answers', async () => {
    const root = await repo();
    await saveCards(root, [card()]);
    await recordAnswer({ root, surfaceId: 'screen:/', slug: 'home', answer: { questionId: 'public', question: 'Public?', answer: 'Yes', answeredBy: 'dev@example.com', answeredAt: '2026-08-01T00:00:00.000Z' } });
    const config = await loadConfig({ root });
    await syncGenerated({ config, logger });
    await fs.unlink(path.join(root, 'app/page.tsx'));
    await expect(runCheckCommand({ cwd: root, logger })).rejects.toMatchObject({ code: 'documentation-drift' });
    const report = await syncGenerated({ config, logger });
    expect(report.deleted).toContain('docs/generated/behaviour/home.md');
    await expect(fs.stat(path.join(root, 'docs/.answers/home.yaml'))).resolves.toBeDefined();
    await expect(runCheckCommand({ cwd: root, logger })).resolves.toBeUndefined();
    await runExtractCommand({ cwd: root, json: false, logger });
    await expect(runCheckCommand({ cwd: root, logger })).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(root, 'docs/generated/README.md'), 'utf8')).not.toContain('(behaviour.md)');
  });

  it('preserves unselected cards and pages during bounded bootstrap', async () => {
    const root = await repo({ 'app/orders/page.tsx': 'export default function Orders() { return null; }\n' });
    const home = card();
    const orders = card('screen:/orders', 'orders', 'app/orders/page.tsx');
    await saveCards(root, [home, orders]);
    await syncGenerated({ config: await loadConfig({ root }), logger });
    const backend = { id: 'fake', name: 'Fake', setupHint: '', isAvailable: async () => true,
      run: vi.fn(async () => ({ ok: true as const, text: JSON.stringify(home.body) })) };
    vi.spyOn(registry, 'resolveBackend').mockResolvedValue(backend);
    await runBootstrapCommand({ cwd: root, limit: 1, force: true, logger });
    expect(backend.run).toHaveBeenCalledTimes(1);
    expect((await loadCards(root)).has('screen:/orders')).toBe(true);
    await expect(fs.stat(path.join(root, 'docs/generated/behaviour/orders.md'))).resolves.toBeDefined();
    await expect(runCheckCommand({ cwd: root, logger })).resolves.toBeUndefined();
  });

  it('does not resurrect a failed regeneration from its old stored card', async () => {
    const root = await repo();
    await saveCards(root, [card()]);
    await syncGenerated({ config: await loadConfig({ root }), logger });
    vi.spyOn(registry, 'resolveBackend').mockResolvedValue({ id: 'fake', name: 'Fake', setupHint: '', isAvailable: async () => true,
      run: async () => ({ ok: false, reason: 'test failure' }) });
    await runBootstrapCommand({ cwd: root, force: true, logger });
    expect((await loadCards(root)).size).toBe(0);
    await expect(runCheckCommand({ cwd: root, logger })).resolves.toBeUndefined();
  });
});

describe('deleted evidence across session updates', () => {
  it('retains prior evidence after an unrelated commit advances HEAD', async () => {
    const root = await repo();
    await feature(root);
    initGit(root);
    await runSessionStartCommand({ cwd: root, logger });
    await fs.writeFile(path.join(root, 'README.md'), '# Unrelated guide\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'unrelated docs');
    await fs.unlink(path.join(root, 'app/page.tsx'));
    const result = capture();
    await runSessionAfterEditCommand({ cwd: root, json: true, logger: result.logger });
    expect(result.json().impact.featureIds).toContain('home');
  }, 20_000);

  it('retains deleted features across repeated after-edit calls and the final handoff', async () => {
    const root = await repo();
    await feature(root);
    initGit(root);
    await runSessionStartCommand({ cwd: root, logger });
    await fs.unlink(path.join(root, 'app/page.tsx'));
    for (let index = 0; index < 2; index += 1) {
      const result = capture();
      await runSessionAfterEditCommand({ cwd: root, json: true, logger: result.logger });
      expect(result.json().impact.featureIds).toContain('home');
      expect(result.json().impact.files.find((file: { change: { file: string } }) => file.change.file === 'app/page.tsx').totalImpacted).toBeGreaterThan(0);
    }
    const result = capture();
    await runSessionEndCommand({ cwd: root, json: true, logger: result.logger });
    expect(result.json().handoff.affectedFeatures).toBe(1);
    await fs.writeFile(path.join(root, 'docgen.config.json'), '{"governance":{"policies":{"changedFeaturesRequirePlan":true}}}');
    await expect(runSessionEndCommand({ cwd: root, logger })).rejects.toMatchObject({ code: 'governance-policy-failed' });
  }, 20_000);
});

describe('critical feature human confirmation', () => {
  it('blocks a confident model card until a developer explicitly confirms it', async () => {
    const root = await repo({ 'docgen.config.json': '{"governance":{"policies":{"criticalFeaturesRequireVerification":true}}}' });
    await feature(root);
    initGit(root);
    await saveCards(root, [card()]);
    const config = await loadConfig({ root });
    const run = await runExtraction({ config, logger, includeSymbols: true });
    expect((await evaluateGovernance({ config, graph: run.graph })).ok).toBe(false);
    await runAnswerCommand({ cwd: root, surface: 'home', questionId: 'behavior-confirmation', answer: 'Reviewed and confirmed the documented behavior.', logger });
    expect((await evaluateGovernance({ config, graph: run.graph })).ok).toBe(true);
  });

  it('does not accept an unattributed or unrelated answer as verification', async () => {
    const root = await repo({ 'docgen.config.json': '{"governance":{"policies":{"criticalFeaturesRequireVerification":true}}}' });
    await feature(root);
    await saveCards(root, [card()]);
    await recordAnswer({ root, surfaceId: 'screen:/', slug: 'home', answer: { questionId: 'unrelated', question: 'Old question', answer: 'Yes', answeredBy: 'unknown', answeredAt: '' } });
    const config = await loadConfig({ root });
    const run = await runExtraction({ config, logger, includeSymbols: true });
    expect((await evaluateGovernance({ config, graph: run.graph })).ok).toBe(false);
  });
});

describe('portable integrations and strict configuration', () => {
  it('generates a pinned npx invocation and matching MCP and CI settings without a local dependency', async () => {
    const root = await repo({ 'package.json': '{"name":"consumer"}' });
    const invocation = await resolveInvocation(root);
    expect(invocation).toBe(`npx --yes @pavanyn/docugen@${ENGINE_VERSION}`);
    await installAdapters({ root, invocation, version: ENGINE_VERSION, all: true });
    const mcp = JSON.parse(await fs.readFile(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.docgen).toEqual({ command: 'npx', args: ['--yes', `@pavanyn/docugen@${ENGINE_VERSION}`, 'mcp'] });
    const workflow = await fs.readFile(path.join(root, '.github/workflows/docgen.yml'), 'utf8');
    expect(workflow).not.toContain('run: npm ci');
    expect(workflow).toContain(`@pavanyn/docugen@${ENGINE_VERSION} check --base`);
    await expect(fs.stat(path.join(root, '.github/dependabot.yml'))).rejects.toThrow();
  });

  it('gives the pre-push check an explicit comparison base', () => {
    expect(renderPrePushHook('npx docgen')).toContain('check --base "$base"');
  });

  it('uses the actual remote revision when pushing and skips deleted refs', async () => {
    const root = await repo({ 'check.cjs': 'require("node:fs").appendFileSync("hook-calls.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");\n' });
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-hook-remote-'));
    created.push(remote);
    git(remote, 'init', '--bare');
    initGit(root);
    const branch = git(root, 'branch', '--show-current');
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', 'origin', `HEAD:refs/heads/${branch}`);
    await fs.mkdir(path.join(root, '.githooks'));
    await fs.writeFile(path.join(root, '.githooks/pre-push'), renderPrePushHook('node ./check.cjs'), { mode: 0o755 });
    git(root, 'config', 'core.hooksPath', '.githooks');
    await fs.writeFile(path.join(root, 'app/page.tsx'), 'export default function Home() { return "updated"; }\n');
    git(root, 'add', 'app/page.tsx');
    git(root, 'commit', '-m', 'update');
    git(root, 'push', 'origin', `HEAD:refs/heads/${branch}`);
    const calls = await fs.readFile(path.join(root, 'hook-calls.jsonl'), 'utf8');
    expect(JSON.parse(calls.trim())).toEqual(['check', '--base', base]);
    git(remote, 'config', 'receive.denyDeleteCurrent', 'ignore');
    git(root, 'push', 'origin', `:refs/heads/${branch}`);
    expect(await fs.readFile(path.join(root, 'hook-calls.jsonl'), 'utf8')).toBe(calls);
  });

  it('uses the remote default branch as the base for a new branch', async () => {
    const root = await repo({ 'check.cjs': 'require("node:fs").writeFileSync("hook-call.json", JSON.stringify(process.argv.slice(2)));\n' });
    const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-hook-new-remote-'));
    created.push(remote);
    git(remote, 'init', '--bare');
    initGit(root);
    const branch = git(root, 'branch', '--show-current');
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', 'origin', `HEAD:refs/heads/${branch}`);
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`);
    git(root, 'checkout', '-b', 'feature');
    await fs.mkdir(path.join(root, '.githooks'));
    await fs.writeFile(path.join(root, '.githooks/pre-push'), renderPrePushHook('node ./check.cjs'), { mode: 0o755 });
    git(root, 'config', 'core.hooksPath', '.githooks');
    await fs.writeFile(path.join(root, 'app/page.tsx'), 'export default function Home() { return "new"; }\n');
    git(root, 'add', 'app/page.tsx');
    git(root, 'commit', '-m', 'new branch');
    git(root, 'push', 'origin', 'HEAD:refs/heads/feature');
    expect(JSON.parse(await fs.readFile(path.join(root, 'hook-call.json'), 'utf8'))).toEqual(['check', '--base', base]);
  });

  it('rejects misspelled extractor keys', () => {
    expect(docgenConfigSchema.safeParse({ extractors: { endponts: false } }).success).toBe(false);
  });
});
