import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { runExtraction } from '../pipeline.js';
import { DocgenError, describeUnknownError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { compareStrings } from '../util/sort.js';
import { PILOT_MANIFEST_FILE, pilotManifestSchema } from './schema.js';
import type { PilotExpectation, PilotManifest } from './schema.js';

export interface PilotQuality {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number | null;
  readonly recall: number | null;
}

export interface PilotReport {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly repositoryClass: PilotManifest['repositoryClass'];
  readonly reviewStatus: PilotManifest['reviewStatus'];
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly observed: {
    readonly technologies: readonly string[];
    readonly unsupportedTechnologies: readonly string[];
    readonly graphNodes: number;
    readonly graphEdges: number;
    readonly graphGaps: readonly string[];
  };
  readonly quality: {
    readonly technologies: PilotQuality;
    readonly graphGaps: PilotQuality;
    readonly overall: PilotQuality;
  };
}

export async function evaluatePilot(args: {
  readonly root: string;
  readonly manifestFile?: string;
  readonly logger: Logger;
}): Promise<PilotReport> {
  const root = path.resolve(args.root);
  const manifest = await loadPilotManifest(root, args.manifestFile ?? PILOT_MANIFEST_FILE);
  const config = await loadConfig({ root });
  const run = await runExtraction({ config, logger: args.logger, includeSymbols: true });
  const technologies = run.stack.technologies.map((tech) => tech.id).sort(compareStrings);
  const graphGaps = [...new Set(run.graph.gaps.map((gap) => `${gap.extractor}:${gap.kind}`))].sort(compareStrings);
  const technologyQuality = classify(manifest.expectations.technologies, technologies);
  const graphGapQuality = classify(manifest.expectations.graphGaps, graphGaps);
  return {
    schemaVersion: 1,
    repository: manifest.repository,
    repositoryClass: manifest.repositoryClass,
    reviewStatus: manifest.reviewStatus,
    reviewedBy: manifest.reviewedBy,
    reviewedAt: manifest.reviewedAt,
    observed: {
      technologies,
      unsupportedTechnologies: run.stack.unsupported.map((tech) => tech.id).sort(compareStrings),
      graphNodes: run.graph.nodes.length,
      graphEdges: run.graph.edges.length,
      graphGaps,
    },
    quality: {
      technologies: technologyQuality,
      graphGaps: graphGapQuality,
      overall: combine(technologyQuality, graphGapQuality),
    },
  };
}

export function renderPilotReport(report: PilotReport): string {
  const metric = (quality: PilotQuality): string =>
    `TP ${quality.truePositives}, FP ${quality.falsePositives}, FN ${quality.falseNegatives}, precision ${displayRate(quality.precision)}, recall ${displayRate(quality.recall)}`;
  return `# Docgen pilot: ${report.repository}

- Repository class: ${report.repositoryClass}
- Review status: ${report.reviewStatus}
- Reviewed by: ${report.reviewedBy}
- Reviewed at: ${report.reviewedAt}
- Graph: ${report.observed.graphNodes} nodes, ${report.observed.graphEdges} edges
- Technologies: ${report.observed.technologies.join(', ') || 'none'}
- Unsupported technologies: ${report.observed.unsupportedTechnologies.join(', ') || 'none'}
- Explicit graph gaps: ${report.observed.graphGaps.join(', ') || 'none'}

## ${report.reviewStatus === 'approved' ? 'Human-reviewed quality' : 'Draft quality — maintainer approval required'}

| Surface | Result |
| --- | --- |
| Technologies | ${metric(report.quality.technologies)} |
| Graph gaps | ${metric(report.quality.graphGaps)} |
| Overall | ${metric(report.quality.overall)} |

These rates compare static output with the committed, attributed expectations in
\`${PILOT_MANIFEST_FILE}\`. A draft report is not v1 release evidence. These
rates do not measure undocumented business intent.
`;
}

async function loadPilotManifest(root: string, relative: string): Promise<PilotManifest> {
  const file = path.resolve(root, relative);
  const boundary = path.relative(root, file);
  if (boundary.startsWith('..') || path.isAbsolute(boundary)) {
    throw new DocgenError({ code: 'pilot-manifest-outside-root', message: 'Pilot manifest must be inside the target repository.', remedy: `Place it at ${PILOT_MANIFEST_FILE}.`, file });
  }
  try {
    return pilotManifestSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (cause) {
    throw new DocgenError({ code: 'pilot-manifest-invalid', message: `Pilot manifest is missing or invalid: ${describeUnknownError(cause)}`, remedy: `Create a schema-v1 ${PILOT_MANIFEST_FILE} with attributed technology and graph-gap expectations.`, file, cause });
  }
}

function classify(expectations: readonly PilotExpectation[], observed: readonly string[]): PilotQuality {
  const expected = new Map(expectations.map((item) => [item.id, item.expected]));
  const observedSet = new Set(observed);
  const truePositives = [...expected].filter(([id, wanted]) => wanted && observedSet.has(id)).length;
  const falseNegatives = [...expected].filter(([id, wanted]) => wanted && !observedSet.has(id)).length;
  const expectedFalsePositives = [...expected].filter(([id, wanted]) => !wanted && observedSet.has(id)).length;
  const unreviewedObserved = observed.filter((id) => !expected.has(id)).length;
  const falsePositives = expectedFalsePositives + unreviewedObserved;
  return rates(truePositives, falsePositives, falseNegatives);
}

function combine(a: PilotQuality, b: PilotQuality): PilotQuality {
  return rates(a.truePositives + b.truePositives, a.falsePositives + b.falsePositives, a.falseNegatives + b.falseNegatives);
}

function rates(truePositives: number, falsePositives: number, falseNegatives: number): PilotQuality {
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: truePositives + falsePositives === 0 ? null : truePositives / (truePositives + falsePositives),
    recall: truePositives + falseNegatives === 0 ? null : truePositives / (truePositives + falseNegatives),
  };
}

function displayRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}
