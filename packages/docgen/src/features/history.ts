import fg from 'fast-glob';
import type { EvidenceGraph } from '../graph/types.js';
import { resolveFileCommitHistory } from '../util/git.js';
import type { CommitInfo } from '../util/git.js';
import { compareStrings } from '../util/sort.js';
import { toPosix } from '../util/paths.js';
import { matchingFeatureNodeIds } from './graph.js';
import type { StoredFeatureRecord } from './schema.js';

export interface FeatureCommitHistory {
  readonly introduced: CommitInfo;
  readonly lastChanged: CommitInfo;
  readonly evidenceFiles: readonly string[];
}

/** Aggregate immutable Git dates across every file selected by a feature. */
export async function deriveFeatureCommitHistory(options: {
  readonly root: string;
  readonly graph: EvidenceGraph;
  readonly record: StoredFeatureRecord;
}): Promise<FeatureCommitHistory | undefined> {
  const selectedNodes = new Set(matchingFeatureNodeIds(options.graph, options.record));
  const files = new Set<string>();
  for (const node of options.graph.nodes) {
    if (!selectedNodes.has(node.id)) continue;
    if (node.kind === 'file') files.add(node.label);
    for (const ref of node.provenance.evidence) files.add(ref.file);
  }
  if (options.record.selectors.files.length > 0) {
    for (const file of await fg([...options.record.selectors.files], {
      cwd: options.root,
      onlyFiles: true,
      dot: true,
      ignore: ['**/.git/**', '**/.docgen/cache/**'],
    })) {
      files.add(toPosix(file));
    }
  }

  const histories: { readonly file: string; readonly introduced: CommitInfo; readonly lastChanged: CommitInfo }[] = [];
  for (const file of [...files].sort(compareStrings)) {
    const history = await resolveFileCommitHistory(options.root, file);
    if (history !== undefined) histories.push({ file, ...history });
  }
  if (histories.length === 0) return undefined;

  const introduced = histories.reduce((oldest, item) =>
    item.introduced.committedAt < oldest.committedAt ? item.introduced : oldest,
  histories[0]!.introduced);
  const lastChanged = histories.reduce((latest, item) =>
    item.lastChanged.committedAt > latest.committedAt ? item.lastChanged : latest,
  histories[0]!.lastChanged);
  return {
    introduced,
    lastChanged,
    evidenceFiles: histories.map((item) => item.file),
  };
}
