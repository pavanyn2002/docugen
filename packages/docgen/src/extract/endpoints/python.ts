import path from 'node:path';

/**
 * Shared helpers for the Python endpoint extractors.
 *
 * docgen is a Node tool and bundling a Python parser is not justified for the
 * coverage it buys, so FastAPI and Django are read with regular expressions —
 * which SPEC 6.1 permits only as a last resort and only when the result is
 * marked low certainty. Route declarations in both frameworks are among the
 * most regular Python there is: a decorator with a string literal, or a list of
 * `path()` calls. Anything less regular is skipped and recorded, never guessed.
 */

/** Extraction method and certainty every Python endpoint carries. */
export const PYTHON_METHOD = 'regex' as const;

/** Strip comments so a commented-out route is never read as a live one. */
export function stripPythonComments(source: string): string {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    let inSingle = false;
    let inDouble = false;
    let cut = line.length;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === "'" && !inDouble) inSingle = !inSingle;
      else if (char === '"' && !inSingle) inDouble = !inDouble;
      else if (char === '#' && !inSingle && !inDouble) {
        cut = i;
        break;
      }
    }
    // Replaced with spaces rather than removed so line numbers stay correct;
    // a link to the wrong line is worse than no link.
    out.push(line.slice(0, cut));
  }
  return out.join('\n');
}

/**
 * Dynamic segment names in the two Python syntaxes.
 *
 *   FastAPI  /items/{item_id}
 *   Django   /users/<int:pk>/  and  /posts/<slug>/
 */
export function pythonParams(routePath: string): readonly string[] {
  const names: string[] = [];
  for (const segment of routePath.split('/')) {
    const brace = /^\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]+)?\}$/.exec(segment);
    if (brace?.[1] !== undefined) {
      names.push(brace[1]);
      continue;
    }
    const angle = /^<(?:[A-Za-z_][A-Za-z0-9_]*:)?([A-Za-z_][A-Za-z0-9_]*)>$/.exec(segment);
    if (angle?.[1] !== undefined) names.push(angle[1]);
  }
  return names;
}

/**
 * Resolve a Python import to a repo-relative file that was actually scanned.
 *
 * Handles the shapes route files actually use: `from .routers import items`,
 * `from app.routers.items import router`, and plain `import app.urls`. A
 * specifier that resolves to nothing is the caller's gap to report — guessing a
 * file would attach routes to the wrong module and therefore the wrong URL.
 */
export function resolvePythonModule(
  fromFile: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  const leadingDots = /^\.*/.exec(specifier)?.[0].length ?? 0;
  const bare = specifier.slice(leadingDots);
  const parts = bare.split('.').filter((part) => part.length > 0);

  const candidates: string[] = [];

  if (leadingDots > 0) {
    // `.` is the current package, `..` its parent, and so on.
    let base = path.posix.dirname(fromFile);
    for (let up = 1; up < leadingDots; up += 1) base = path.posix.dirname(base);
    candidates.push(path.posix.join(base, ...parts));
  } else {
    // An absolute import is rooted at the repo, or at a top-level package
    // directory next to it — both layouts are common.
    candidates.push(parts.join('/'));
    const firstSegment = path.posix.dirname(fromFile).split('/')[0];
    if (firstSegment !== undefined && firstSegment !== '' && firstSegment !== '.') {
      candidates.push(path.posix.join(firstSegment, ...parts));
    }
  }

  for (const candidate of candidates) {
    for (const suffix of ['.py', '/__init__.py']) {
      const resolved = `${candidate}${suffix}`.replace(/^\.\//, '');
      if (files.has(resolved)) return resolved;
    }
  }
  return undefined;
}

/** `from X import a, b as c` and `import X` — name in this file to its module. */
export function readPythonImports(source: string): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();

  const fromImport = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = fromImport.exec(source)) !== null) {
    const module = match[1] as string;
    const clause = (match[2] as string).replace(/[()]/g, '');
    for (const raw of clause.split(',')) {
      const piece = raw.trim();
      if (piece === '' || piece === '*') continue;
      const aliased = /^([\w.]+)\s+as\s+(\w+)$/.exec(piece);
      const localName = aliased?.[2] ?? piece.split('.')[0];
      const importedName = aliased?.[1] ?? piece;
      if (localName === undefined || localName === '') continue;
      // `from .routers import items` binds `items` to the module `.routers.items`;
      // `from .routers.items import router` binds `router` inside that module.
      // The separator is dropped when the module is itself just dots, or
      // `from . import views` would bind `..views` — the parent package, which
      // is one level too high and resolves to nothing.
      const separator = module.endsWith('.') ? '' : '.';
      bindings.set(localName, `${module}${separator}${importedName}`);
    }
  }

  const plainImport = /^[ \t]*import[ \t]+([.\w]+)(?:[ \t]+as[ \t]+(\w+))?[ \t]*$/gm;
  while ((match = plainImport.exec(source)) !== null) {
    const module = match[1] as string;
    const alias = match[2];
    bindings.set(alias ?? (module.split('.')[0] as string), module);
  }

  return bindings;
}

/** 1-based line number of a character offset. */
export function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}
