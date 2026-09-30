import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { EndpointEntry } from '../../types/entries.js';
import { parseSourceFile, positionOf, ts } from '../../util/ts-ast.js';
import { toPosix } from '../../util/paths.js';
import { paramsOf } from './paths.js';

/** Standalone Vercel functions live directly under each application's api/. */
export async function extractVercelEndpoints(args: {
  root: string;
  exclude: readonly string[];
  workspaces: readonly string[];
}): Promise<{ entries: readonly EndpointEntry[]; gaps: readonly Gap[]; found: boolean }> {
  const entries: EndpointEntry[] = [];
  const gaps: Gap[] = [];
  const directories = [...new Set(['', ...args.workspaces])].map(dir => path.posix.join(dir, 'api'));
  const files = await fg(directories.map(dir => `${fg.escapePath(dir)}/**/*.{js,ts,mjs,cjs}`), {
    cwd: args.root, ignore: [...args.exclude], onlyFiles: true,
  });
  for (const file of files.map(toPosix).sort()) {
    if (file.endsWith('.d.ts')) continue;
    const source = parseSourceFile(file, await fs.readFile(path.join(args.root, file), 'utf8'));
    const handler = source.statements.find(statement => {
      if (ts.isFunctionDeclaration(statement)) {
        return statement.body !== undefined && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) === true;
      }
      const expression = ts.isExportAssignment(statement) && !statement.isExportEquals
        ? statement.expression
        : ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
          && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && statement.expression.left.getText(source) === 'module.exports'
          ? statement.expression.right : undefined;
      return expression !== undefined && (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression));
    });
    if (handler === undefined) continue;
    const dir = directories.filter(candidate => file.startsWith(candidate + '/')).sort((a, b) => b.length - a.length)[0];
    if (dir === undefined) continue;
    const segments = file.slice(dir.length + 1).replace(/\.(?:js|ts|mjs|cjs)$/, '').split('/');
    if (segments.at(-1) === 'index') segments.pop();
    const route = '/api' + (segments.length === 0 ? '' : '/' + segments.map(segment =>
      /^\[\.\.\.[^\]]+\]$/.test(segment) ? '*' : segment.replace(/^\[([^\]]+)\]$/, ':$1'),
    ).join('/'));
    const ref = positionOf(source, handler, file);
    entries.push({ id: `endpoint:ALL:${route}`, source: ref, handler: ref,
      extractionMethod: 'ast', certainty: 'high', method: 'ALL', path: route,
      params: paramsOf(route), middleware: [],
    });
    gaps.push({ extractor: 'endpoints', kind: 'vercel-method-undetermined',
      message: `${route} is a Vercel function. The HTTP methods it accepts are not statically determined.`, source: ref,
    });
  }
  return { entries, gaps, found: entries.length > 0 };
}
