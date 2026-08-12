import path from 'node:path';
import { colors } from '../util/colors.js';
import { writeFileAtomically } from '../util/atomic.js';
import { DocgenError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { buildCycloneDxBom, serialiseCycloneDxBom } from '../security/sbom.js';
import { scanSupplyChain } from '../security/scan.js';

export const DEFAULT_SBOM_FILE = 'docs/.security/sbom.cdx.json';

export interface SecurityScanCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly strict?: boolean;
  readonly logger: Logger;
}

export async function runSecurityScanCommand(options: SecurityScanCommandOptions): Promise<void> {
  const report = await scanSupplyChain(path.resolve(options.cwd));
  if (options.json === true) {
    options.logger.output(JSON.stringify(report, null, 2));
  } else {
    options.logger.heading('docgen security scan');
    options.logger.info(`  manifests     ${report.manifests.length}`);
    options.logger.info(`  lockfiles     ${report.lockfiles.length}`);
    options.logger.info(`  components    ${report.components.length}`);
    options.logger.info(`  findings      ${report.findings.length}`);
    options.logger.info(`  format gaps   ${report.gaps.length}`);
    for (const finding of report.findings) {
      options.logger.info(
        `    ${finding.severity.padEnd(8)} ${finding.kind} — ${finding.message}`,
      );
    }
    for (const gap of report.gaps) options.logger.warn(`${gap.kind}: ${gap.message}`);
    options.logger.info(`\n  ${colors().dim(`CVE coverage: ${report.vulnerabilityCoverage.status}. ${report.vulnerabilityCoverage.reason}`)}`);
  }

  if (options.strict === true && (report.findings.length > 0 || report.gaps.length > 0)) {
    throw new DocgenError({
      code: 'supply-chain-policy-failed',
      message: `--strict: ${report.findings.length} supply-chain finding(s) and ${report.gaps.length} unsupported-format gap(s).`,
      remedy:
        'Resolve the listed lockfile, integrity, source, or pinning risks; add a current advisory scanner in CI for CVEs.',
    });
  }
}

export interface SecuritySbomCommandOptions {
  readonly cwd: string;
  readonly out?: string;
  readonly dryRun?: boolean;
  /** Print the SBOM to stdout and do not write a file. */
  readonly json?: boolean;
  readonly logger: Logger;
}

export async function runSecuritySbomCommand(options: SecuritySbomCommandOptions): Promise<void> {
  const root = path.resolve(options.cwd);
  const report = await scanSupplyChain(root);
  const bom = buildCycloneDxBom(report);
  const contents = serialiseCycloneDxBom(bom);
  if (options.json === true) {
    options.logger.output(contents.trimEnd());
    return;
  }

  const target = path.resolve(root, options.out ?? DEFAULT_SBOM_FILE);
  if (options.dryRun !== true) {
    try {
      await writeFileAtomically(target, contents);
    } catch (cause) {
      throw new DocgenError({
        code: 'sbom-write-failed',
        message: `Could not write the SBOM to ${target}.`,
        remedy: 'Check that the destination is writable, then rerun `docgen security sbom`.',
        file: target,
        cause,
      });
    }
  }
  const display = path.relative(root, target).replace(/\\/g, '/') || target;
  options.logger.heading('docgen security sbom');
  options.logger.info(`  format        CycloneDX ${bom.specVersion}`);
  options.logger.info(`  components    ${bom.components.length}`);
  options.logger.info(
    `  output        ${options.dryRun === true ? `would write ${display}` : `wrote ${display}`}`,
  );
  options.logger.info(
    `\n  ${colors().dim('The SBOM inventories dependencies; it is not evidence that dependencies are vulnerability-free.')}`,
  );
}
