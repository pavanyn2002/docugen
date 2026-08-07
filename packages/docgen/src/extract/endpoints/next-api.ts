import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { EndpointEntry, HttpMethod } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { parseSourceFile, ts } from '../../util/ts-ast.js';
import { parseAppSegments, parsePagesSegments, stripRouteExtension } from '../routes/segments.js';
import { paramsOf } from './paths.js';
import { compareStrings } from '../../util/sort.js';

/**
 * Next.js API endpoints.
 *
 * App Router `route.ts` files export one function per HTTP method, so the
 * exported names are the methods — no inference needed. Pages Router
 * `pages/api/**` files export a single handler that branches on `req.method`
 * internally, which static analysis cannot decompose reliably; those are
 * recorded as ALL with a gap saying so, rather than guessing at GET.
 */

const ROUTE_HANDLER_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export interface NextApiResult {
  readonly entries: readonly EndpointEntry[];
  readonly gaps: readonly Gap[];
  readonly found: boolean;
}

export async function extractNextApiEndpoints(args: {
  root: string;
  exclude: readonly string[];
}): Promise<NextApiResult> {
  const entries: EndpointEntry[] = [];
  const gaps: Gap[] = [];
  let found = false;

  for (const appDir of ['app', 'src/app']) {
    const files = await fg(['**/route.{ts,tsx,js,mjs}'], {
      cwd: path.join(args.root, appDir),
      ignore: [...args.exclude],
      onlyFiles: true,
    });
    if (files.length === 0) continue;
    found = true;

    for (const relative of files.map(toPosix).sort()) {
      const file = toPosix(path.posix.join(appDir, relative));
      const dirname = path.posix.dirname(relative);
      const parsed = parseAppSegments(dirname === '.' ? '' : dirname);
      if (parsed.isPrivate) continue;

      const contents = await fs.readFile(path.join(args.root, file), 'utf8');
      const source = parseSourceFile(file, contents);
      const methods = exportedHandlerMethods(source);

      if (methods.length === 0) {
        gaps.push({
          extractor: 'endpoints',
          kind: 'route-handler-no-methods',
          message:
            'This route handler exports no recognised HTTP method function, so the methods it ' +
            'serves are unknown.',
          source: { file },
        });
        continue;
      }

      for (const { method, line } of methods) {
        entries.push({
          id: `endpoint:${method}:${parsed.path}`,
          source: { file, line },
          extractionMethod: 'manifest',
          certainty: 'high',
          method,
          path: parsed.path,
          params: parsed.params,
          handler: { file, line },
          middleware: [],
        });
      }
    }
  }

  for (const pagesDir of ['pages/api', 'src/pages/api']) {
    const files = await fg(['**/*.{ts,tsx,js,mjs}'], {
      cwd: path.join(args.root, pagesDir),
      ignore: [...args.exclude],
      onlyFiles: true,
    });
    if (files.length === 0) continue;
    found = true;

    for (const relative of files.map(toPosix).sort()) {
      const withoutExtension = stripRouteExtension(relative);
      if (withoutExtension === undefined) continue;
      if (path.posix.basename(withoutExtension).startsWith('_')) continue;

      const file = toPosix(path.posix.join(pagesDir, relative));
      const parsed = parsePagesSegments(withoutExtension);
      const apiPath = `/api${parsed.path === '/' ? '' : parsed.path}`;

      // The handler branches on req.method at runtime. Claiming a specific
      // verb here would be a guess; ALL states what is actually known.
      entries.push({
        id: `endpoint:ALL:${apiPath}`,
        source: { file, line: 1 },
        extractionMethod: 'manifest',
        certainty: 'high',
        method: 'ALL',
        path: apiPath,
        params: paramsOf(apiPath),
        handler: { file, line: 1 },
        middleware: [],
      });

      gaps.push({
        extractor: 'endpoints',
        kind: 'pages-api-method-undetermined',
        message:
          `${apiPath} is a Pages Router handler, which selects behaviour from req.method at runtime. ` +
          'The HTTP methods it actually accepts are not statically determined.',
        source: { file },
      });
    }
  }

  return { entries, gaps, found };
}

/** Exported function declarations whose name is an HTTP method. */
function exportedHandlerMethods(
  source: ts.SourceFile,
): readonly { method: HttpMethod; line: number }[] {
  const methods: { method: HttpMethod; line: number }[] = [];

  const record = (name: string, node: ts.Node): void => {
    if (!ROUTE_HANDLER_METHODS.has(name)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    methods.push({ method: name as HttpMethod, line: line + 1 });
  };

  for (const statement of source.statements) {
    const isExported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!isExported) continue;

    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      record(statement.name.text, statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) record(declaration.name.text, declaration);
      }
    }
  }

  return methods.sort((a, b) =>compareStrings(a.method, b.method));
}

/** Exposed for tests. */
export { exportedHandlerMethods };
