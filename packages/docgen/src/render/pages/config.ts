import type { GenerationContext } from '../../types/core.js';
import type { ConfigEntry, ConfigResult } from '../../types/entries.js';
import type { StackReport } from '../../detect/stack.js';
import { renderGaps, renderInapplicable, renderProvenance } from '../common.js';
import { code, renderFrontMatter, note, section, sourceLink, table } from '../markdown.js';
import { isCredentialLikeLiteral, isSecretLikeName } from '../../privacy/redact.js';
import { workspaceLabel } from '../../detect/ownership.js';

/**
 * config.md — every environment variable, where it is read, and where declared.
 *
 * Values are never rendered, only names and locations. A `.env` file holds
 * credentials, and this page is committed to the repository.
 */
export function renderConfigPage(args: {
  result: ConfigResult;
  stack: StackReport;
  context: GenerationContext;
  outDir: string;
}): string {
  const { result, stack, context, outDir } = args;
  const head = renderFrontMatter({ title: 'Configuration', confidence: 'verified', context });

  if (!result.applicable) {
    return `${head}# Environment and configuration\n\n${renderInapplicable(result, stack)}`;
  }

  let body = `${head}# Environment and configuration\n\n`;
  body += renderProvenance(result);
  body += note([
    'Only names and locations are recorded. docgen never reads a value from a `.env` file,',
    'because this page is committed and those files hold credentials.',
  ]);

  const columns = [
    ...(result.entries.some((entry) => entry.workspace !== undefined)
      ? [{ header: 'Workspace', render: (entry: ConfigEntry) => code(workspaceLabel(entry.workspace ?? '')) }]
      : []),
    {
      header: 'Name',
      render: (entry: ConfigEntry) =>
        `${code(entry.name)}${entry.isSecretLike ? ' 🔒' : ''}`,
    },
    {
      header: 'Read at',
      render: (entry: ConfigEntry) =>
        entry.reads.length === 0
          ? '**never**'
          : entry.reads
              .slice(0, 3)
              .map((ref) => sourceLink(ref, outDir))
              .join(', ') + (entry.reads.length > 3 ? ` +${entry.reads.length - 3}` : ''),
    },
    {
      header: 'Declared in',
      render: (entry: ConfigEntry) =>
        entry.declarations.length === 0
          ? '**not declared**'
          : entry.declarations.map((ref) => sourceLink(ref, outDir)).join(', '),
    },
    {
      header: 'Default',
      render: (entry: ConfigEntry) =>
        entry.defaultValue === undefined || entry.isSecretLike || isSecretLikeName(entry.name) ||
        isCredentialLikeLiteral(entry.defaultValue)
          ? '—'
          : code(entry.defaultValue),
    },
  ];

  const used = result.entries.filter(
    (entry) => entry.reads.length > 0 && entry.declarations.length > 0,
  );
  const undeclared = result.entries.filter(
    (entry) => entry.reads.length > 0 && entry.declarations.length === 0,
  );
  const unread = result.entries.filter(
    (entry) => entry.reads.length === 0 && entry.declarations.length > 0,
  );

  body += section(`Read and declared (${used.length})`, table(columns, used));

  if (undeclared.length > 0) {
    body += section(
      `Read but never declared (${undeclared.length})`,
      `These are read by the code but appear in no \`.env\` file. They may be supplied by the ` +
        `deployment environment, or they may be missing — docgen cannot tell which.\n\n${table(
          columns,
          undeclared,
        )}`,
    );
  }

  if (unread.length > 0) {
    body += section(
      `Declared but never read (${unread.length})`,
      `Nothing in the code reads these. They are most likely dead configuration.\n\n${table(
        columns,
        unread,
      )}`,
    );
  }

  const secrets = result.entries.filter((entry) => entry.isSecretLike);
  if (secrets.length > 0) {
    body += section(
      `Secret-shaped names (${secrets.length})`,
      `Names matching a credential pattern, marked 🔒 above. Listed so they can be checked ` +
        `against a secret manager; their values are not recorded anywhere in this documentation.\n\n` +
        secrets.map((entry) =>
          `- \`${entry.workspace === undefined ? entry.name : `${workspaceLabel(entry.workspace)}:${entry.name}`}\``,
        ).join('\n') +
        '\n',
    );
  }

  body += renderGaps(result.gaps, outDir);
  return body;
}
