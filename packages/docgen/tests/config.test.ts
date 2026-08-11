import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, findConfigFile } from '../src/config/load.js';
import { ALWAYS_EXCLUDE } from '../src/config/schema.js';
import { DocgenError } from '../src/util/errors.js';

const created: string[] = [];

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-config-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('config discovery', () => {
  it('returns undefined for a repo with no config', async () => {
    const root = await makeRepo();
    await expect(findConfigFile(root)).resolves.toBeUndefined();
  });

  it('errors when two config files are present rather than picking one', async () => {
    const root = await makeRepo({
      'docgen.config.json': '{}',
      'docgen.config.mjs': 'export default {};',
    });
    await expect(findConfigFile(root)).rejects.toThrow(DocgenError);
  });
});

describe('loadConfig', () => {
  // SPEC rule 6: absent input is silent. A repo that has never heard of docgen must work.
  it('falls back to defaults when no config exists', async () => {
    const root = await makeRepo();
    const config = await loadConfig({ root });

    expect(config.outDir).toBe('docs/generated');
    expect(config.configFile).toBeUndefined();
    expect(config.extractors).toEqual({
      routes: true,
      schema: true,
      deps: true,
      endpoints: true,
      jobs: true,
      config: true,
    });
    expect(config.diagrams.maxNodes).toBe(40);
    expect(config.openapi.mode).toBe('cross-check');
    expect(config.governance.policies).toEqual({
      changedFeaturesRequirePlan: false,
      changesRequireHandoff: false,
      criticalFeaturesRequireVerification: false,
      requirementsRequireTests: false,
    });
    expect(config.privacy).toEqual({
      localOnly: false,
      redactSecrets: true,
      allowedAgents: ['claude', 'codex', 'cursor', 'api'],
    });
  });

  it('loads a JSON config and merges it over defaults', async () => {
    const root = await makeRepo({
      'docgen.config.json': JSON.stringify({ outDir: 'docs/api', extractors: { jobs: false } }),
    });
    const config = await loadConfig({ root });

    expect(config.outDir).toBe('docs/api');
    expect(config.extractors.jobs).toBe(false);
    expect(config.extractors.routes).toBe(true);
  });

  it('loads a TypeScript config through jiti', async () => {
    const root = await makeRepo({
      'docgen.config.ts': "export default { outDir: 'generated-docs', exclude: ['src/legacy/**'] };\n",
    });
    const config = await loadConfig({ root });

    expect(config.outDir).toBe('generated-docs');
    expect(config.exclude).toEqual(['src/legacy/**']);
  });

  it('always applies the built-in excludes on top of the user list', async () => {
    const root = await makeRepo({
      'docgen.config.json': JSON.stringify({ exclude: ['vendor/**'] }),
    });
    const config = await loadConfig({ root });

    expect(config.effectiveExclude).toEqual([...ALWAYS_EXCLUDE, 'vendor/**']);
  });

  // SPEC rule 6: malformed input is loud. A typo'd key would otherwise quietly
  // produce wrong documentation.
  it('rejects unknown keys', async () => {
    const root = await makeRepo({ 'docgen.config.json': JSON.stringify({ outDirr: 'docs' }) });
    await expect(loadConfig({ root })).rejects.toThrow(/outDirr|Unrecognized/i);
  });

  it('rejects an absolute path in a glob list', async () => {
    const root = await makeRepo({ 'docgen.config.json': JSON.stringify({ exclude: ['/etc/**'] }) });
    await expect(loadConfig({ root })).rejects.toThrow(DocgenError);
  });

  it('rejects a Windows absolute path in a glob list', async () => {
    const root = await makeRepo({ 'docgen.config.json': JSON.stringify({ exclude: ['C:\\vendor\\**'] }) });
    await expect(loadConfig({ root })).rejects.toThrow(DocgenError);
  });

  it('reports unparseable JSON with the file name', async () => {
    const root = await makeRepo({ 'docgen.config.json': '{ not json' });
    await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'config-unparseable' });
  });

  it('rejects a config that exports a non-object', async () => {
    const root = await makeRepo({ 'docgen.config.mjs': 'export default 42;\n' });
    await expect(loadConfig({ root })).rejects.toMatchObject({ code: 'config-invalid' });
  });

  it('errors when an explicit --config path does not exist', async () => {
    const root = await makeRepo();
    await expect(loadConfig({ root, configFile: 'nope.config.ts' })).rejects.toMatchObject({
      code: 'config-not-found',
    });
  });

  it('rejects a negative diagram node budget', async () => {
    const root = await makeRepo({ 'docgen.config.json': JSON.stringify({ diagrams: { maxNodes: -1 } }) });
    await expect(loadConfig({ root })).rejects.toThrow(DocgenError);
  });

  it('has no trust-spec mode for openapi', async () => {
    const root = await makeRepo({ 'docgen.config.json': JSON.stringify({ openapi: { mode: 'trust-spec' } }) });
    await expect(loadConfig({ root })).rejects.toThrow(DocgenError);
  });

  it('loads opt-in governance policies and rejects unknown policy names', async () => {
    const root = await makeRepo({ 'docgen.config.json': JSON.stringify({ governance: { policies: { requirementsRequireTests: true } } }) });
    expect((await loadConfig({ root })).governance.policies.requirementsRequireTests).toBe(true);
    const invalid = await makeRepo({ 'docgen.config.json': JSON.stringify({ governance: { policies: { trustEverything: true } } }) });
    await expect(loadConfig({ root: invalid })).rejects.toThrow(DocgenError);
  });

  it('validates privacy provider and model allowlists', async () => {
    const root = await makeRepo({ 'docgen.config.json': JSON.stringify({ privacy: { allowedAgents: ['codex'], allowedModels: ['gpt-approved'] } }) });
    expect((await loadConfig({ root })).privacy).toMatchObject({ allowedAgents: ['codex'], allowedModels: ['gpt-approved'] });
    const invalid = await makeRepo({ 'docgen.config.json': JSON.stringify({ privacy: { allowedAgents: [] } }) });
    await expect(loadConfig({ root: invalid })).rejects.toThrow(DocgenError);
  });
});
