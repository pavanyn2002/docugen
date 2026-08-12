import path from 'node:path';
import { evaluatePilot, renderPilotReport } from '../pilot/evaluate.js';
import type { Logger } from '../util/logger.js';
import { writeFileAtomically } from '../util/atomic.js';

export interface PilotCommandOptions {
  readonly cwd: string;
  readonly manifest?: string;
  readonly out?: string;
  readonly json?: boolean;
  readonly logger: Logger;
}

export async function runPilotCommand(options: PilotCommandOptions): Promise<void> {
  const root = path.resolve(options.cwd);
  const report = await evaluatePilot({ root, ...(options.manifest === undefined ? {} : { manifestFile: options.manifest }), logger: options.logger });
  if (options.json === true) {
    options.logger.output(JSON.stringify(report, null, 2));
    return;
  }
  const contents = renderPilotReport(report);
  if (options.out === undefined) options.logger.output(contents.trimEnd());
  else {
    const target = path.resolve(root, options.out);
    await writeFileAtomically(target, contents);
    options.logger.info(`Wrote pilot report to ${path.relative(root, target).replace(/\\/g, '/')}.`);
  }
}
