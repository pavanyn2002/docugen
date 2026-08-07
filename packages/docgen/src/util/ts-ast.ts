import ts from 'typescript';
import type { SourceRef } from '../types/core.js';

/**
 * Shared TypeScript AST helpers.
 *
 * SPEC 6.1 requires real parsers rather than regex. The TypeScript compiler is
 * the canonical parser for every target this tool ships against, and parsing a
 * single file needs no program, type checker, or tsconfig — so this stays fast
 * enough for the 30-second budget.
 */

/** Parse one file in isolation. Never throws: the TS parser recovers from syntax errors. */
export function parseSourceFile(fileName: string, contents: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    contents,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(fileName),
  );
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) {
    return ts.ScriptKind.JSX; // .js commonly contains JSX in React projects.
  }
  return ts.ScriptKind.TS;
}

/** 1-based line/column for a node, for `path/to/file.ts:42` links. */
export function positionOf(source: ts.SourceFile, node: ts.Node, file: string): SourceRef {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file, line: line + 1, column: character + 1 };
}

/** Depth-first walk over every descendant node. */
export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * The literal string value of a node, or undefined when it is not a plain
 * literal. Returning undefined rather than a best guess is deliberate: a
 * computed path is something the extractor cannot know, and SPEC rule 5 says
 * record the gap instead of inventing a value.
 */
export function literalString(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** Find a property on an object literal by name. */
export function getProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : undefined;
    if (key === name) return property.initializer;
  }
  return undefined;
}

/** String literal elements of an array expression; non-literal elements are skipped. */
export function literalStringArray(node: ts.Expression | undefined): readonly string[] {
  if (node === undefined || !ts.isArrayLiteralExpression(node)) return [];
  return node.elements
    .map((element) => literalString(element))
    .filter((value): value is string => value !== undefined);
}

/** Module specifiers imported by a source file. */
export function importedModules(source: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const value = literalString(statement.moduleSpecifier);
      if (value !== undefined) specifiers.push(value);
    }
  }
  return specifiers;
}

export { ts };
