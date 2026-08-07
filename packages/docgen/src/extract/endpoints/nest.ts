import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap } from '../../types/core.js';
import type { EndpointEntry, HttpMethod, ShapeRef } from '../../types/entries.js';
import { toPosix } from '../../util/paths.js';
import { literalString, parseSourceFile, positionOf, ts, walk } from '../../util/ts-ast.js';
import { joinPath, paramsOf } from './paths.js';

/**
 * NestJS controllers.
 *
 * `@Controller('orders')` sets a prefix and each `@Get(':id')` method decorator
 * gives the rest, so the full path is declared rather than inferred. Guards are
 * explicit too: `@UseGuards(JwtAuthGuard)` names the protection directly, which
 * makes Nest one of the few frameworks where auth coverage is genuinely
 * knowable from static analysis.
 */

const METHOD_DECORATORS: Readonly<Record<string, HttpMethod>> = Object.freeze({
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: 'ALL',
});

export interface NestResult {
  readonly entries: readonly EndpointEntry[];
  readonly gaps: readonly Gap[];
  readonly found: boolean;
}

export async function extractNestEndpoints(args: {
  root: string;
  exclude: readonly string[];
}): Promise<NestResult> {
  const files = (
    await fg(['**/*.ts'], { cwd: args.root, ignore: [...args.exclude], onlyFiles: true })
  )
    .map(toPosix)
    .sort();

  const entries: EndpointEntry[] = [];
  const gaps: Gap[] = [];
  let found = false;

  for (const relative of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(args.root, relative), 'utf8');
    } catch {
      continue;
    }
    if (!contents.includes('@Controller')) continue;

    found = true;
    const parsed = parseNestController(relative, contents);
    entries.push(...parsed.entries);
    gaps.push(...parsed.gaps);
  }

  return { entries, gaps, found };
}

export function parseNestController(
  file: string,
  contents: string,
): { entries: readonly EndpointEntry[]; gaps: readonly Gap[] } {
  const source = parseSourceFile(file, contents);
  const entries: EndpointEntry[] = [];
  const gaps: Gap[] = [];

  walk(source, (node) => {
    if (!ts.isClassDeclaration(node)) return;

    const controller = findDecorator(node, 'Controller');
    if (controller === undefined) return;

    const prefixArgument = controller.arguments[0];
    let prefix = literalString(prefixArgument) ?? '';
    if (prefixArgument !== undefined && prefix === '' && !ts.isObjectLiteralExpression(prefixArgument)) {
      gaps.push({
        extractor: 'endpoints',
        kind: 'controller-prefix-not-literal',
        message:
          'A @Controller prefix is a computed expression, so the URLs of its routes are not ' +
          'statically determined. Paths are shown without the prefix.',
        source: positionOf(source, controller, file),
      });
      prefix = '';
    }

    const classGuards = decoratorArgumentNames(findDecorator(node, 'UseGuards'));

    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;

      for (const decoratorName of Object.keys(METHOD_DECORATORS)) {
        const decorator = findDecorator(member, decoratorName);
        if (decorator === undefined) continue;

        const method = METHOD_DECORATORS[decoratorName] as HttpMethod;
        const routePath = literalString(decorator.arguments[0]) ?? '';
        const fullPath = joinPath(prefix, routePath);
        const position = positionOf(source, member, file);

        const middleware = [
          ...classGuards,
          ...decoratorArgumentNames(findDecorator(member, 'UseGuards')),
          ...decoratorArgumentNames(findDecorator(member, 'UseInterceptors')),
        ];

        entries.push({
          id: `endpoint:${method}:${fullPath}`,
          source: position,
          extractionMethod: 'ast',
          certainty: 'high',
          method,
          path: fullPath,
          params: paramsOf(fullPath),
          handler: position,
          middleware: [...new Set(middleware)].sort(),
          ...(bodyShape(member, source) === undefined
            ? {}
            : { requestShape: bodyShape(member, source) as ShapeRef }),
        });
      }
    }
  });

  return { entries, gaps };
}

/** The DTO type of a `@Body()` parameter, when it is annotated. */
function bodyShape(method: ts.MethodDeclaration, source: ts.SourceFile): ShapeRef | undefined {
  for (const parameter of method.parameters) {
    if (findDecorator(parameter, 'Body') === undefined) continue;
    const type = parameter.type?.getText(source);
    if (type === undefined) continue;
    return { name: type, kind: 'typescript' };
  }
  return undefined;
}

function findDecorator(node: ts.Node, name: string): ts.CallExpression | undefined {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (decorators === undefined) return undefined;

  for (const decorator of decorators) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression)) continue;
    if (ts.isIdentifier(expression.expression) && expression.expression.text === name) {
      return expression;
    }
  }
  return undefined;
}

function decoratorArgumentNames(decorator: ts.CallExpression | undefined): readonly string[] {
  if (decorator === undefined) return [];
  return decorator.arguments
    .map((argument) => (ts.isIdentifier(argument) ? argument.text : undefined))
    .filter((name): name is string => name !== undefined);
}
