import type { GenerationContext } from '../../types/core.js';
import type { SchemaEntry, SchemaField, SchemaResult } from '../../types/entries.js';
import type { StackReport } from '../../detect/stack.js';
import { renderGaps, renderInapplicable, renderProvenance, renderUnsupportedForPage } from '../common.js';
import { certaintyBadge, cell, code, renderFrontMatter, note, section, sourceLink, table } from '../markdown.js';

/** schema.md — every table and collection, with its columns and relations. */
export function renderSchemaPage(args: {
  result: SchemaResult;
  stack: StackReport;
  context: GenerationContext;
  outDir: string;
}): string {
  const { result, stack, context, outDir } = args;
  const head = renderFrontMatter({ title: 'Schema', confidence: 'verified', context });

  if (!result.applicable) {
    return `${head}# Database schema\n\n${renderInapplicable(result, stack)}`;
  }

  let body = `${head}# Database schema\n\n`;
  body += renderProvenance(result);
  body += renderUnsupportedForPage(stack, 'schema', (id) =>
    ['mikro-orm', 'drizzle', 'knex', 'gorm', 'medusa'].includes(id),
  );

  if (result.entries.some((entry) => entry.certainty === 'low')) {
    body += note([
      'Entries marked `~heuristic` were read with pattern matching rather than a real parser.',
      'Their field types and constraints should be verified before being relied on.',
    ]);
  }

  body += section(
    `Tables and collections (${result.entries.length})`,
    table(
      [
        { header: 'Name', render: (entry: SchemaEntry) => `[${entry.name}](#${anchorFor(entry.name)})` },
        { header: 'Kind', render: (entry: SchemaEntry) => cell(entry.kind) },
        { header: 'Fields', render: (entry: SchemaEntry) => String(entry.fields.length) },
        { header: 'Relations', render: (entry: SchemaEntry) => String(entry.relations.length) },
        {
          header: 'Source',
          render: (entry: SchemaEntry) =>
            `${sourceLink(entry.source, outDir)}${certaintyBadge(entry.certainty)}`,
        },
      ],
      result.entries,
    ),
  );

  for (const entry of result.entries) {
    let detail = '';
    if (entry.modelName !== undefined) {
      detail += `Declared in code as \`${entry.modelName}\`.\n\n`;
    }
    detail += `Source: ${sourceLink(entry.source, outDir)}${certaintyBadge(entry.certainty)}\n\n`;

    detail += table(
      [
        { header: 'Field', render: (field: SchemaField) => code(field.name) },
        { header: 'Type', render: (field: SchemaField) => code(field.type) },
        {
          header: 'Nullable',
          // Omitted means the parser could not tell — which is not the same as "no".
          render: (field: SchemaField) =>
            field.nullable === undefined ? '_unknown_' : field.nullable ? 'yes' : 'no',
        },
        {
          header: 'Key',
          render: (field: SchemaField) =>
            [field.isPrimaryKey === true ? 'PK' : '', field.isUnique === true ? 'unique' : '']
              .filter((part) => part.length > 0)
              .join(', ') || '—',
        },
        { header: 'Default', render: (field: SchemaField) => (field.defaultValue === undefined ? '—' : code(field.defaultValue)) },
      ],
      entry.fields,
    );

    if (entry.relations.length > 0) {
      detail += `\n**Relations**\n\n${table(
        [
          { header: 'Field', render: (relation: { field: string }) => code(relation.field) },
          { header: 'Targets', render: (relation: { targetModel: string }) => code(relation.targetModel) },
          {
            header: 'Cardinality',
            render: (relation: { cardinality?: string }) => cell(relation.cardinality),
          },
        ],
        entry.relations,
      )}`;
    }

    if (entry.indexes.length > 0) {
      detail += `\n**Indexes**\n\n${table(
        [
          { header: 'Name', render: (index: { name?: string }) => cell(index.name) },
          {
            header: 'Fields',
            render: (index: { fields: readonly string[] }) =>
              index.fields.map((field) => `\`${field}\``).join(', '),
          },
          { header: 'Unique', render: (index: { unique?: boolean }) => (index.unique === true ? 'yes' : 'no') },
        ],
        entry.indexes,
      )}`;
    }

    body += section(entry.name, detail, 3);
  }

  body += renderGaps(result.gaps, outDir);
  return body;
}

/** GitHub's heading anchor rules, for the in-page links above. */
function anchorFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
