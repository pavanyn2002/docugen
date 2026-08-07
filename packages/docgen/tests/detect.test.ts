import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectStack, parseManifestDependencies } from '../src/detect/stack.js';
import { findWorkspaces } from '../src/detect/workspaces.js';
import { TECH_SIGNATURES } from '../src/detect/signatures.js';
import { detectRouters } from '../src/extract/routes/detect.js';
import { routesExtractor } from '../src/extract/routes/index.js';
import { loadConfig } from '../src/config/load.js';
import { ALWAYS_EXCLUDE } from '../src/config/schema.js';
import { DocgenError } from '../src/util/errors.js';
import { createLogger } from '../src/util/logger.js';
import type { RoutesResult } from '../src/types/entries.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TEST_DIR, 'fixtures');

const silent = createLogger({
  level: 'silent',
  stderr: { write: () => true } as unknown as NodeJS.WritableStream,
  stdout: { write: () => true } as unknown as NodeJS.WritableStream,
});

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docgen-detect-'));
  created.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dir;
}

const detect = (root: string) => detectStack({ root, exclude: ALWAYS_EXCLUDE });

describe('manifest dependency parsing', () => {
  it('reads all package.json dependency sections', () => {
    const names = parseManifestDependencies(
      'package.json',
      '{"dependencies":{"next":"1"},"devDependencies":{"vitest":"1"},"peerDependencies":{"react":"1"}}',
    );
    expect([...names].sort()).toEqual(['next', 'react', 'vitest']);
  });

  it('strips version specifiers and extras from requirements.txt', () => {
    const names = parseManifestDependencies(
      'requirements.txt',
      '# comment\nfastapi[all]>=0.115.0\nSQLAlchemy==2.0.1\n-r other.txt\n\nuvicorn\n',
    );
    expect(names).toEqual(['fastapi', 'SQLAlchemy', 'uvicorn']);
  });

  it('reads gems from a Gemfile', () => {
    expect(parseManifestDependencies('Gemfile', "gem 'rails', '~> 7.1'\ngem 'puma'\n")).toEqual([
      'rails',
      'puma',
    ]);
  });

  it('reads modules from go.mod', () => {
    const names = parseManifestDependencies('go.mod', 'module x\n\nrequire gorm.io/gorm v1.25.0\n');
    expect(names).toContain('gorm.io/gorm');
  });

  it('reads composer require sections', () => {
    expect(
      parseManifestDependencies('composer.json', '{"require":{"laravel/framework":"^11.0"}}'),
    ).toEqual(['laravel/framework']);
  });

  it('returns nothing for a manifest format it does not know', () => {
    expect(parseManifestDependencies('mix.exs', 'defmodule X do end')).toEqual([]);
  });

  // Silently failing here would disable detection for the whole repo and emit
  // empty documentation that looks like a clean result.
  it('reports a corrupt package.json loudly', () => {
    expect(() => parseManifestDependencies('package.json', '{ bad')).toThrow(DocgenError);
  });
});

describe('workspace discovery', () => {
  it('finds a manifest in each sub-project', async () => {
    const workspaces = await findWorkspaces(path.join(FIXTURES, 'monorepo'), ALWAYS_EXCLUDE);
    expect(workspaces.map((workspace) => workspace.dir)).toEqual(['', 'backend', 'frontend']);
  });

  it('always includes the root even with no manifest there', async () => {
    const root = await makeRepo({ 'sub/package.json': '{}' });
    const workspaces = await findWorkspaces(root, ALWAYS_EXCLUDE);
    expect(workspaces.map((workspace) => workspace.dir)).toContain('');
  });

  it('excludes dependency directories', async () => {
    const root = await makeRepo({
      'package.json': '{}',
      'node_modules/lib/package.json': '{}',
    });
    const workspaces = await findWorkspaces(root, ALWAYS_EXCLUDE);
    expect(workspaces.map((workspace) => workspace.dir)).toEqual(['']);
  });
});

describe('stack detection', () => {
  it('identifies technologies per workspace', async () => {
    const report = await detect(path.join(FIXTURES, 'monorepo'));
    const byId = new Map(report.technologies.map((tech) => [tech.id, tech]));

    expect(byId.get('fastapi')?.workspace).toBe('backend');
    expect(byId.get('next')?.workspace).toBe('frontend');
  });

  // This is the whole point: an unsupported stack must be named, because an
  // empty section is otherwise indistinguishable from a clean repo.
  it('reports a detected technology it cannot document', async () => {
    const report = await detect(path.join(FIXTURES, 'monorepo'));
    const fastapi = report.unsupported.find((tech) => tech.id === 'fastapi');

    expect(fastapi).toBeDefined();
    expect(fastapi?.unsupportedNote).toContain('not extracted');
    expect(fastapi?.evidence.file).toBe('backend/requirements.txt');
  });

  it('detects an entirely unsupported stack rather than reporting nothing', async () => {
    const report = await detect(path.join(FIXTURES, 'unsupported-stack'));

    expect(report.technologies.map((tech) => tech.id)).toContain('rails');
    expect(report.unsupported.map((tech) => tech.id)).toContain('rails');
  });

  // "docgen cannot document PostgreSQL" is a meaningless warning that would
  // train users to ignore the ones that matter.
  it('does not treat a datastore or a language as a coverage gap', async () => {
    const root = await makeRepo({
      'package.json': '{"dependencies":{"pg":"^8.0.0","ioredis":"^5.0.0","next":"^15.0.0"}}',
      'tsconfig.json': '{}',
      'app/page.tsx': 'export default function P(){return null}',
    });
    const report = await detect(root);

    expect(report.technologies.map((tech) => tech.id)).toEqual(
      expect.arrayContaining(['postgres', 'redis', 'typescript']),
    );
    expect(report.unsupported).toEqual([]);
  });

  it('marks a supported technology with the extractors that cover it', async () => {
    const report = await detect(path.join(FIXTURES, 'mongoose-service'));
    const mongoose = report.technologies.find((tech) => tech.id === 'mongoose');

    expect(mongoose?.covers).toContain('schema');
  });

  it('is deterministic', async () => {
    const root = path.join(FIXTURES, 'monorepo');
    expect(JSON.stringify(await detect(root))).toBe(JSON.stringify(await detect(root)));
  });
});

describe('signature table integrity', () => {
  it('has unique ids', () => {
    const ids = TECH_SIGNATURES.map((signature) => signature.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every unsupported framework or ORM a note explaining what is missing', () => {
    const missing = TECH_SIGNATURES.filter(
      (signature) =>
        signature.covers.length === 0 &&
        (signature.category === 'web-framework' || signature.category === 'orm') &&
        signature.unsupportedNote === undefined,
    );
    expect(missing.map((signature) => signature.id)).toEqual([]);
  });

  it('gives every signature something to match on', () => {
    const unmatched = TECH_SIGNATURES.filter(
      (signature) => signature.dependencies === undefined && signature.files === undefined,
    );
    expect(unmatched.map((signature) => signature.id)).toEqual([]);
  });
});

describe('monorepo route detection', () => {
  // Looking only at the repo root finds nothing in a backend/frontend split,
  // producing empty output that reads as "this project has no screens".
  it('detects a router in a sub-project', async () => {
    const detections = await detectRouters(path.join(FIXTURES, 'monorepo'), ['', 'backend', 'frontend']);
    expect(detections).toEqual([{ kind: 'next-app', dir: 'frontend/src/app' }]);
  });

  it('extracts routes from a sub-project with workspace-prefixed paths', async () => {
    const root = path.join(FIXTURES, 'monorepo');
    const config = await loadConfig({ root });
    const result = (await routesExtractor.run({
      root: config.root,
      config,
      logger: silent,
    })) as RoutesResult;

    expect(result.applicable).toBe(true);
    expect(result.entries.map((entry) => entry.source.file)).toEqual([
      'frontend/src/app/page.tsx',
    ]);
  });
});
