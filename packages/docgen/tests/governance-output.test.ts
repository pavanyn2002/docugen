import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { loadFeatureRecords } from '../src/features/store.js';
import { syncGenerated } from '../src/verify/write.js';
import { isGeneratedFile } from '../src/util/generated.js';
import { createLogger } from '../src/util/logger.js';
import { createRepository, seedGovernance } from './helpers/repository.js';

const roots: string[] = [];
const logger = createLogger({ level: 'silent' });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe('governance page ownership', () => {
  it('updates its generated pages after code changes and removes orphaned pages without deleting feature records', async () => {
    const root = await createRepository();
    roots.push(root);
    await seedGovernance(root);
    const config = await loadConfig({ root });
    await syncGenerated({ config, logger });
    for (const file of ['features.md', 'features/home.md', 'plans/home-update.md']) {
      const relative = `docs/generated/${file}`;
      expect(isGeneratedFile(relative, await fs.readFile(path.join(root, relative), 'utf8')), relative).toBe(true);
    }
    await fs.writeFile(path.join(root, 'app/page.tsx'), 'export default function Home() { return "Updated"; }\n');
    const changed = await syncGenerated({ config, logger });
    expect(changed.written).toContain('docs/generated/features/home.md');
    await fs.writeFile(path.join(root, 'docs/generated/team-guide.md'), '# Human guide\n');
    await fs.unlink(path.join(root, 'docs/.plans/home-update.json'));
    const removed = await syncGenerated({ config, logger });
    expect(removed.deleted).toContain('docs/generated/plans/home-update.md');
    expect(await fs.readFile(path.join(root, 'docs/generated/team-guide.md'), 'utf8')).toBe('# Human guide\n');
    expect((await loadFeatureRecords(root))[0]?.id).toBe('home');
  });
});
