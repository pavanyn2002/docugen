import path from 'node:path';
import { literalString, ts } from './ts-ast.js';

/**
 * Cross-file symbol resolution.
 *
 * Express mounts a router declared in another module (`app.use('/projects',
 * projectRoutes)`), usually re-exported through a barrel file. Without
 * following that chain the mount prefix is lost and every endpoint is
 * documented at the wrong URL — which is worse than not documenting it.
 */

/** Extensions tried when resolving a relative import to a file on disk. */
const RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

/** Resolve a relative import to a repo-relative file that was actually scanned. */
export function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  // TypeScript sources are frequently imported with a .js specifier.
  const withoutJs = base.replace(/\.(js|jsx|mjs)$/, '');

  for (const candidate of [base, withoutJs]) {
    for (const suffix of RESOLUTION_SUFFIXES) {
      const resolved = `${candidate}${suffix}`;
      if (files.has(resolved)) return resolved;
    }
  }
  return undefined;
}

/** What a name imported into a file refers to. */
export interface ImportBinding {
  /** Module specifier it came from. */
  readonly specifier: string;
  /** Name in the source module; 'default' for a default import. */
  readonly importedName: string;
}

/** What a name exported from a file refers to. */
export type ExportBinding =
  /** Declared in this file. */
  | { readonly kind: 'local'; readonly localName: string }
  /** Re-exported from another module. */
  | { readonly kind: 'reexport'; readonly specifier: string; readonly importedName: string };

export interface ModuleBindings {
  readonly imports: ReadonlyMap<string, ImportBinding>;
  readonly exports: ReadonlyMap<string, ExportBinding>;
}

/** Collect the import and export bindings of one parsed module. */
export function readModuleBindings(source: ts.SourceFile): ModuleBindings {
  const imports = new Map<string, ImportBinding>();
  const exports = new Map<string, ExportBinding>();

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = literalString(statement.moduleSpecifier);
      const clause = statement.importClause;
      if (specifier === undefined || clause === undefined) continue;

      if (clause.name !== undefined) {
        imports.set(clause.name.text, { specifier, importedName: 'default' });
      }
      const named = clause.namedBindings;
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          imports.set(element.name.text, {
            specifier,
            importedName: element.propertyName?.text ?? element.name.text,
          });
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const specifier = literalString(statement.moduleSpecifier);
      const clause = statement.exportClause;
      if (clause === undefined || !ts.isNamedExports(clause)) continue;

      for (const element of clause.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (specifier === undefined) {
          exports.set(element.name.text, { kind: 'local', localName: importedName });
        } else {
          exports.set(element.name.text, { kind: 'reexport', specifier, importedName });
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
      // `export default router`
      if (ts.isIdentifier(statement.expression)) {
        exports.set('default', { kind: 'local', localName: statement.expression.text });
      }
      continue;
    }

    // `export const router = ...`
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          exports.set(declaration.name.text, { kind: 'local', localName: declaration.name.text });
        }
      }
    }
  }

  // Dynamic imports and require() bound to a variable, which routinely appear
  // inside a function body rather than at the top level:
  //   const userRoutes = await import('./routes/userRoutes');
  //   app.use('/api/users', userRoutes.default);
  // Missing these loses the mount prefix for every route in the module.
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const specifier = moduleSpecifierOfLoad(node.initializer);
      if (specifier !== undefined && !imports.has(node.name.text)) {
        // The binding is the module namespace; the caller narrows with
        // `.default` where needed. Only the target file matters for mounting.
        imports.set(node.name.text, { specifier, importedName: '*' });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  return { imports, exports };
}

/** `await import('x')`, `import('x')`, or `require('x')` — returns 'x'. */
function moduleSpecifierOfLoad(node: ts.Expression): string | undefined {
  const expression = ts.isAwaitExpression(node) ? node.expression : node;
  if (!ts.isCallExpression(expression)) return undefined;

  const isDynamicImport = expression.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire =
    ts.isIdentifier(expression.expression) && expression.expression.text === 'require';
  if (!isDynamicImport && !isRequire) return undefined;

  return literalString(expression.arguments[0]);
}

/**
 * Follow a symbol through imports and re-export barrels to the file that
 * declares it.
 *
 * Depth is bounded so a circular barrel cannot hang the run; hitting the bound
 * returns undefined, which callers report as an unresolved mount rather than
 * guessing a prefix.
 */
export async function resolveSymbolToFile(args: {
  fromFile: string;
  symbol: string;
  /**
   * Loads a file's bindings on demand. Resolution routinely passes through
   * barrel files that declare nothing themselves, so bindings cannot be
   * restricted to files the caller found interesting — doing so breaks the
   * chain at the first re-export and loses the mount prefix entirely.
   */
  loadBindings: (file: string) => Promise<ModuleBindings | undefined>;
  files: ReadonlySet<string>;
  maxHops?: number;
}): Promise<{ file: string; exportedName: string } | undefined> {
  let currentFile = args.fromFile;
  let currentSymbol = args.symbol;
  const maxHops = args.maxHops ?? 8;
  const seen = new Set<string>();

  for (let hop = 0; hop < maxHops; hop += 1) {
    const key = `${currentFile}#${currentSymbol}`;
    if (seen.has(key)) return undefined;
    seen.add(key);

    const bindings = await args.loadBindings(currentFile);
    if (bindings === undefined) return undefined;

    // Following an import: move to the source module.
    const imported = bindings.imports.get(currentSymbol);
    if (imported !== undefined) {
      const target = resolveRelativeImport(currentFile, imported.specifier, args.files);
      if (target === undefined) return undefined;
      currentFile = target;
      currentSymbol = imported.importedName;
      continue;
    }

    // Following a re-export barrel.
    const exported = bindings.exports.get(currentSymbol);
    if (exported !== undefined && exported.kind === 'reexport') {
      const target = resolveRelativeImport(currentFile, exported.specifier, args.files);
      if (target === undefined) return undefined;
      currentFile = target;
      currentSymbol = exported.importedName;
      continue;
    }

    return { file: currentFile, exportedName: currentSymbol };
  }

  return undefined;
}
