import fs from 'node:fs/promises';
import path from 'node:path';
import type { Gap, SourceRef } from '../../types/core.js';
import { getProperty, literalStringArray, parseSourceFile, positionOf, ts, walk } from '../../util/ts-ast.js';

/**
 * Next.js middleware, which is where these codebases put auth guards.
 *
 * A middleware matcher is a path pattern, not a plain string, and Next allows
 * full regex inside it. Patterns this module cannot interpret with certainty
 * are reported as gaps rather than approximated — claiming a route is
 * authenticated when it is not is precisely the sort of confident-and-wrong
 * statement the trust model exists to prevent.
 */

export interface MiddlewareInfo {
  readonly source: SourceRef;
  /** Raw matcher patterns exactly as written. */
  readonly patterns: readonly string[];
  /** Patterns reduced to something matchable. */
  readonly matchers: readonly CompiledMatcher[];
  readonly gaps: readonly Gap[];
}

export interface CompiledMatcher {
  readonly pattern: string;
  readonly test: (routePath: string) => boolean;
}

const MIDDLEWARE_FILES = ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js'];

/** Regex metacharacters that mean the pattern is beyond conservative interpretation. */
const COMPLEX_PATTERN = /[?(){}|+^$\\]/;

/**
 * Reduce a matcher pattern to a predicate, or return undefined when it cannot
 * be interpreted with confidence.
 *
 * Handles the three forms that cover ordinary usage:
 *   '/dashboard'         exact
 *   '/dashboard/:path*'  prefix (and the segment itself)
 *   '/dashboard/:id'     one dynamic segment
 */
export function compileMatcher(pattern: string): CompiledMatcher | undefined {
  if (pattern.length === 0 || !pattern.startsWith('/')) return undefined;

  // ':path*' / ':path+' style trailing wildcards mean "this prefix and below".
  const wildcard = /^(.*?)\/:[A-Za-z0-9_]+\*$/.exec(pattern);
  if (wildcard !== null) {
    const prefix = wildcard[1] as string;
    if (COMPLEX_PATTERN.test(prefix)) return undefined;
    const normalised = prefix === '' ? '/' : prefix;
    return {
      pattern,
      test: (routePath) =>
        normalised === '/' || routePath === normalised || routePath.startsWith(`${normalised}/`),
    };
  }

  if (COMPLEX_PATTERN.test(pattern)) return undefined;

  const patternSegments = pattern.split('/').filter((s) => s.length > 0);
  return {
    pattern,
    test: (routePath) => {
      const routeSegments = routePath.split('/').filter((s) => s.length > 0);
      if (routeSegments.length !== patternSegments.length) return false;
      return patternSegments.every((segment, index) => {
        const actual = routeSegments[index] as string;
        // ':id' in the matcher matches any single segment, dynamic or static.
        if (segment.startsWith(':')) return true;
        return segment === actual;
      });
    },
  };
}

/** Locate and parse the repo's middleware, if it has one. */
export async function readMiddleware(root: string): Promise<MiddlewareInfo | undefined> {
  for (const relative of MIDDLEWARE_FILES) {
    const absolute = path.join(root, relative);
    let contents: string;
    try {
      contents = await fs.readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    return analyseMiddleware(relative, contents);
  }
  return undefined;
}

export function analyseMiddleware(file: string, contents: string): MiddlewareInfo {
  const source = parseSourceFile(file, contents);
  const gaps: Gap[] = [];
  let patterns: readonly string[] = [];
  let configNode: ts.Node | undefined;

  walk(source, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== 'config') return;
    const initializer = node.initializer;
    if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) return;

    configNode = node;
    const matcher = getProperty(initializer, 'matcher');
    if (matcher === undefined) return;

    if (ts.isArrayLiteralExpression(matcher)) {
      patterns = literalStringArray(matcher);
      if (patterns.length < matcher.elements.length) {
        gaps.push({
          extractor: 'routes',
          kind: 'middleware-matcher-not-literal',
          message:
            'Some middleware matcher entries are computed rather than string literals, ' +
            'so the routes they guard cannot be determined statically.',
          source: positionOf(source, matcher, file),
        });
      }
      return;
    }

    if (ts.isStringLiteral(matcher)) {
      patterns = [matcher.text];
      return;
    }

    gaps.push({
      extractor: 'routes',
      kind: 'middleware-matcher-not-literal',
      message: 'The middleware matcher is not a string or array literal, so guarded routes are unknown.',
      source: positionOf(source, matcher, file),
    });
  });

  const middlewareRef: SourceRef =
    configNode === undefined ? { file } : positionOf(source, configNode, file);

  const matchers: CompiledMatcher[] = [];
  for (const pattern of patterns) {
    const compiled = compileMatcher(pattern);
    if (compiled === undefined) {
      gaps.push({
        extractor: 'routes',
        kind: 'middleware-matcher-uninterpretable',
        message:
          `Middleware matcher '${pattern}' uses regex syntax docgen does not interpret. ` +
          'Routes it guards are not marked as guarded, so treat auth coverage here as undetermined.',
        source: middlewareRef,
      });
      continue;
    }
    matchers.push(compiled);
  }

  // Middleware with no matcher config runs on every request. That is a real
  // Next.js default, not an assumption.
  if (patterns.length === 0 && gaps.length === 0) {
    return {
      source: middlewareRef,
      patterns: ['(no matcher — runs on every route)'],
      matchers: [{ pattern: '(all routes)', test: () => true }],
      gaps,
    };
  }

  return { source: middlewareRef, patterns, matchers, gaps };
}
