import fs from 'node:fs/promises';
import path from 'node:path';
import { colors } from '../util/colors.js';
import { collectStatus } from '../status/collect.js';
import type { RepoStatus } from '../status/collect.js';
import { renderFleetPage } from '../status/render.js';
import { describeUnknownError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import { compareStrings } from '../util/sort.js';
import type { Logger } from '../util/logger.js';

export interface FleetCommandOptions {
  /** Directories to inspect. Each is treated as a repo root. */
  readonly paths: readonly string[];
  /** Where to write the dashboard. */
  readonly out?: string;
  readonly json?: boolean;
  readonly logger: Logger;
}

/**
 * `docgen fleet` — one page across every repository.
 *
 * The rollout problem is not any single repo, it is knowing which of forty to
 * spend an afternoon on. This reports the size of each gap per repo rather than
 * a score: a single number invites ranking teams against each other, which is
 * how a documentation effort becomes something people game or resent.
 *
 * A repo that cannot be read is listed as such, never omitted — an absent row
 * reads as "nothing to do here".
 */
export async function runFleetCommand(options: FleetCommandOptions): Promise<void> {
  const roots = [...options.paths].map((target) => path.resolve(target)).sort(compareStrings);

  const repos: RepoStatus[] = [];
  const failures: { path: string; reason: string }[] = [];

  // Each repo's own diagnostics are suppressed: forty extraction logs
  // interleaved is noise, and the per-repo detail is a `docgen status` away.
  const quiet = createLogger({ level: 'error' });

  for (const [index, root] of roots.entries()) {
    options.logger.info(
      `  ${colors().dim(`[${index + 1}/${roots.length}]`)} ${path.basename(root)}`,
    );
    try {
      repos.push(await collectStatus({ cwd: root, logger: quiet }));
    } catch (error) {
      failures.push({ path: root, reason: describeUnknownError(error) });
    }
  }

  if (options.json === true) {
    options.logger.output(JSON.stringify({ repos, failures }, null, 2));
    return;
  }

  // Stamped by the caller rather than inside the renderer, so the page stays a
  // pure function of its inputs and can be asserted on byte for byte.
  const contents = renderFleetPage({ repos, failures, generatedAt: new Date().toISOString() });

  const out = path.resolve(options.out ?? 'docgen-fleet.md');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, contents.replace(/\r\n/g, '\n'), 'utf8');

  options.logger.heading('Fleet');
  options.logger.info(`  repositories  ${repos.length}`);
  if (failures.length > 0) {
    options.logger.warn(`${failures.length} could not be read:`);
    for (const failure of failures.slice(0, 10)) {
      options.logger.warn(`  ${failure.path} — ${failure.reason}`);
    }
  }
  options.logger.info(`\n  ${colors().dim(`written to ${out}`)}`);
}
