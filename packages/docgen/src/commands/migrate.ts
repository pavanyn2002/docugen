import path from 'node:path';
import { applyMigrations, inspectMigrations, rollbackMigration } from '../migrations/engine.js';
import type { Logger } from '../util/logger.js';

export interface MigrateCommandOptions {
  readonly cwd: string;
  readonly rollback?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly logger: Logger;
}

export async function runMigrateCommand(options: MigrateCommandOptions): Promise<void> {
  const root = path.resolve(options.cwd);
  if (options.rollback !== undefined) {
    const receipt = await rollbackMigration(root, options.rollback);
    if (options.json === true) options.logger.output(JSON.stringify(receipt, null, 2));
    else options.logger.info(`Rolled back ${receipt.id}: ${receipt.changes.length} artifact(s) restored.`);
    return;
  }
  if (options.dryRun === true) {
    const inspections = await inspectMigrations(root);
    const pending = inspections.filter((item) => item.status === 'pending');
    if (options.json === true) options.logger.output(JSON.stringify({ inspections, pending: pending.length }, null, 2));
    else options.logger.info(`${pending.length} artifact(s) require migration.`);
    return;
  }
  const receipt = await applyMigrations(root);
  if (options.json === true) options.logger.output(JSON.stringify(receipt ?? { changes: [] }, null, 2));
  else if (receipt === undefined) options.logger.info('All governed artifacts already use current schemas.');
  else options.logger.info(`Applied ${receipt.id}: ${receipt.changes.length} artifact(s) upgraded with backups.`);
}
