import { loadChangeRecords } from '../changes/store.js';
import { deriveFeatureCommitHistory } from '../features/history.js';
import type { FeatureCommitHistory } from '../features/history.js';
import { matchingFeatureNodeIds } from '../features/graph.js';
import { loadFeatureRecords } from '../features/store.js';
import { loadPlanRecords } from '../plans/store.js';
import type { RunResult } from '../pipeline.js';
import type { RenderedFile } from '../render/index.js';
import { compareStrings } from '../util/sort.js';
import { toPosix } from '../util/paths.js';
import { renderChangelog, renderFeatureIndex, renderFeaturePage, renderPlanPage } from './render.js';

export async function computeGovernanceFiles(run: RunResult): Promise<readonly RenderedFile[]> {
  const [features, plans, changes] = await Promise.all([
    loadFeatureRecords(run.config.root),
    loadPlanRecords(run.config.root),
    loadChangeRecords(run.config.root),
  ]);
  if (features.length === 0 && plans.length === 0 && changes.length === 0) return [];
  const outDir = toPosix(run.config.outDir);
  const nodeById = new Map(run.graph.nodes.map((node) => [node.id, node]));
  const histories = new Map<string, FeatureCommitHistory | undefined>();
  for (const feature of features) {
    histories.set(
      feature.id,
      await deriveFeatureCommitHistory({ root: run.config.root, graph: run.graph, record: feature }),
    );
  }
  const files: RenderedFile[] = [];
  if (features.length > 0) {
    files.push({ path: `${outDir}/features.md`, contents: renderFeatureIndex({ features, histories, context: run.context }) });
  }
  for (const feature of features) {
    const history = histories.get(feature.id);
    files.push({
      path: `${outDir}/features/${feature.id}.md`,
      contents: renderFeaturePage({
        feature,
        ...(history === undefined ? {} : { history }),
        nodes: matchingFeatureNodeIds(run.graph, feature)
          .map((id) => nodeById.get(id))
          .filter((node): node is NonNullable<typeof node> => node !== undefined),
        plans: plans.filter((plan) => plan.featureId === feature.id),
        changes: changes.filter((change) => change.featureIds.includes(feature.id)),
        context: run.context,
      }),
    });
  }
  for (const plan of plans) {
    files.push({ path: `${outDir}/plans/${plan.id}.md`, contents: renderPlanPage(plan, run.context) });
  }
  if (changes.length > 0) {
    files.push({ path: `${outDir}/changelog.md`, contents: renderChangelog(changes, run.context) });
  }
  return files.sort((a, b) => compareStrings(a.path, b.path));
}
