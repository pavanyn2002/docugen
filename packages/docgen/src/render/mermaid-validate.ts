/**
 * Structural validation for generated Mermaid.
 *
 * A diagram that fails to parse renders as an error box in GitHub, which is
 * worse than no diagram: it makes the whole documentation set look broken. The
 * checks here are the failure modes Mermaid actually has, not a full grammar —
 * enough to catch anything docgen could plausibly emit.
 */

export interface MermaidProblem {
  readonly line: number;
  readonly kind: string;
  readonly message: string;
}

/**
 * Node ids Mermaid treats as syntax.
 *
 * `end` is the notorious one: a node called `end` closes the enclosing
 * subgraph and breaks the diagram silently.
 */
const RESERVED_NODE_IDS = new Set(['end', 'graph', 'subgraph', 'class', 'click', 'style', 'o', 'x']);

const SUPPORTED_HEADERS = [
  /^graph\s+(TD|TB|BT|RL|LR)$/,
  /^flowchart\s+(TD|TB|BT|RL|LR)$/,
  /^erDiagram$/,
  /^sequenceDiagram$/,
];

export function validateMermaid(source: string): readonly MermaidProblem[] {
  const problems: MermaidProblem[] = [];
  const lines = source.split('\n');

  const meaningful = lines
    .map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter((entry) => entry.text.length > 0 && !entry.text.startsWith('%%'));

  const header = meaningful[0];
  if (header === undefined) {
    return [{ line: 1, kind: 'empty-diagram', message: 'The diagram has no content.' }];
  }
  if (!SUPPORTED_HEADERS.some((pattern) => pattern.test(header.text))) {
    problems.push({
      line: header.line,
      kind: 'unknown-diagram-type',
      message: `'${header.text}' is not a diagram type docgen emits.`,
    });
  }

  const isEr = header.text === 'erDiagram';

  // Block balance. An erDiagram whose entity blocks are not all closed parses
  // as far as the missing brace and then fails — which is exactly what happens
  // if identical `}` lines are ever deduplicated away.
  let depth = 0;
  for (const { text, line } of meaningful.slice(1)) {
    // ER cardinality tokens contain braces (`}o--||`, `}o--o{`) and are not
    // block delimiters. Quoted labels can contain them too.
    if (/--/.test(text)) continue;
    const withoutLabels = text.replace(/"[^"]*"/g, '""');

    for (const character of withoutLabels) {
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      if (depth < 0) {
        problems.push({
          line,
          kind: 'unbalanced-block',
          message: 'A block is closed that was never opened.',
        });
        depth = 0;
      }
    }
  }
  if (depth > 0) {
    problems.push({
      line: lines.length,
      kind: 'unbalanced-block',
      message: `${depth} block(s) were never closed.`,
    });
  }

  for (const { text, line } of meaningful.slice(1)) {
    // Unbalanced quotes swallow the rest of the diagram.
    const quotes = (text.match(/"/g) ?? []).length;
    if (quotes % 2 !== 0) {
      problems.push({
        line,
        kind: 'unbalanced-quotes',
        message: `Odd number of quote characters: ${text.slice(0, 60)}`,
      });
    }

    // A label containing an unescaped quote terminates it early.
    for (const match of text.matchAll(/\[\s*"((?:[^"\\]|\\.)*)"\s*\]/g)) {
      if ((match[1] ?? '').includes('"')) {
        problems.push({
          line,
          kind: 'unescaped-quote-in-label',
          message: `Label contains a raw quote: ${match[1] ?? ''}`,
        });
      }
    }

    if (!isEr) {
      // Bracketed label text must be quoted; otherwise brackets and parentheses
      // inside it are read as shape syntax.
      for (const match of text.matchAll(/(?:^|\s)([A-Za-z0-9_]+)\[([^\]]*)\]/g)) {
        const id = match[1] ?? '';
        const label = match[2] ?? '';

        if (RESERVED_NODE_IDS.has(id.toLowerCase())) {
          problems.push({
            line,
            kind: 'reserved-node-id',
            message: `'${id}' is reserved by Mermaid and breaks the diagram.`,
          });
        }
        if (!/^".*"$/s.test(label)) {
          problems.push({
            line,
            kind: 'unquoted-label',
            message: `Node label is not quoted: ${label.slice(0, 40)}`,
          });
        }
      }

      // Edge endpoints must be plain ids.
      for (const match of text.matchAll(/([A-Za-z0-9_]+)\s*-->/g)) {
        const id = match[1] ?? '';
        if (RESERVED_NODE_IDS.has(id.toLowerCase())) {
          problems.push({
            line,
            kind: 'reserved-node-id',
            message: `'${id}' is reserved by Mermaid and breaks the diagram.`,
          });
        }
      }
    }
  }

  return problems;
}

/**
 * Make an identifier safe as a Mermaid node id.
 *
 * Reserved words are suffixed rather than rejected, so a route legitimately
 * called `end` still appears in the diagram.
 */
export function safeNodeId(prefix: string, value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const base = cleaned.length === 0 ? 'root' : cleaned;
  const id = `${prefix}_${base}`;
  // A prefix already removes the collision in practice, but an empty prefix
  // must not be able to produce a bare reserved word.
  const collides =
    RESERVED_NODE_IDS.has(id.toLowerCase()) ||
    (prefix.length === 0 && RESERVED_NODE_IDS.has(base.toLowerCase()));
  return collides ? `${id}_node` : id;
}
