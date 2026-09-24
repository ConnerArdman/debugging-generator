/**
 * check-css-classes — hold this package's stylesheet and its components to
 * one class inventory, in both directions.
 *
 *   emitted    every `dg-*` class a module under `src/` writes, read from the
 *              TypeScript syntax tree of each non-test `.ts`/`.tsx` file
 *   selected   every `dg-*` class a selector in `src/styles/base.css` or
 *              `src/styles/components.css` names
 *
 * No component in this package ships an inline visual style (AAP 0.6.4), so
 * the stylesheet is the whole of the product's appearance and the class names
 * are the entire interface between the two. That interface drifts silently:
 * a class a component emits with no rule behind it renders unstyled — a state
 * that was meant to be visible is not — and a rule whose class nothing emits
 * is dead weight that reads as a feature the product does not have. The check
 * fails on five findings:
 *
 *   unstyled-class       a module emits a class no selector names
 *   unreferenced-class   a selector names a class no module emits and that is
 *                        not a published class
 *   published-missing    a class listed in {@link PUBLISHED_CLASSES} has no
 *                        selector, so the list promises a class that is gone
 *   published-emitted    a published class is emitted by a module after all,
 *                        so it is no longer an exception and the list shrinks
 *   interpolated-class   a class name is assembled at run time — from a
 *                        template literal (`dg-badge--${tone}`, `dg-${kind}`)
 *                        or by string concatenation (`'dg-' + kind`) — which
 *                        no inventory can read; spell each name out in a
 *                        lookup table instead. The check fails closed: a bare
 *                        `dg-` prefix joined to an expression is reported even
 *                        though no complete class name is visible
 *
 * A class counts as emitted when it appears in a string literal, a template
 * literal part or an object key anywhere in a module — `className` values,
 * `clsx()` arguments, lookup tables, a `querySelector` selector — except in
 * the value of a JSX attribute that does not carry classes (`id`, `aria-*`,
 * `data-*`, `title`, …). Comments are not read at all, so a class a comment
 * names is neither emitted nor missing. The inventory is class-level: a state
 * class such as `dg-is-selected` counts as styled once any compound selector
 * names it.
 *
 * `pnpm --filter @debuggen/panel-renderer build` runs this after the token
 * generator (`prebuild`), `src/styles/class-inventory.test.ts` runs it inside
 * `pnpm test`, and `pnpm --filter @debuggen/panel-renderer css:check` runs it
 * on its own. The functions below read and write nothing unless called; only
 * the entry point at the bottom acts.
 *
 * Usage: `node scripts/check-css-classes.mjs [--list]`, or `--help`.
 *
 * @module packages/panel-renderer/scripts/check-css-classes
 */

import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * This package's directory, from this module's own location rather than
 * `process.cwd()`: pnpm runs `prebuild` with the workspace as cwd, developers
 * run the script from the repository root and the test imports it from a
 * worker.
 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Package-relative directory whose modules are scanned for emitted classes. */
export const SOURCE_ROOT_REL = 'src';

/** Package-relative paths of the stylesheets whose selectors are inventoried. */
export const STYLESHEETS_REL = Object.freeze(['src/styles/base.css', 'src/styles/components.css']);

/**
 * Classes the stylesheet publishes for a host surface to apply itself, and
 * which no module in this package therefore emits. Each entry states its
 * audience; an entry is a promise the stylesheet keeps, which is why a
 * published class with no selector fails the check.
 *
 * Keep this list short. A class belongs here only when a host surface (the
 * DevTools panel, the VS Code webview) or a caller composing a primitive by
 * hand is documented as its consumer — never to silence a selector a refactor
 * orphaned; that selector is removed instead.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PUBLISHED_CLASSES = Object.freeze({
  'dg-scroll':
    'base.css global utility: the scroll behaviour a host surface gives a container of its own',
  'dg-spinner':
    'free-standing inline progress indicator for a host surface (a connection pill, a pending control)',
  'dg-toolbar__spacer':
    'documented by layout/Toolbar.tsx for a bar a host composes by hand; the component never emits it',
});

/** The command that runs this check, quoted in every failure. */
const CHECK_COMMAND = 'node scripts/check-css-classes.mjs';

/** The inventory is consistent. */
const EXIT_OK = 0;

/** At least one finding. */
const EXIT_DRIFT = 1;

/** Bad usage, a missing TypeScript compiler, or an I/O failure. */
const EXIT_ERROR = 2;

/** Findings printed before the report is summarised, so a wholesale rename does not scroll away. */
const MAX_REPORTED_FINDINGS = 60;

/**
 * One `dg-*` class name. Parts are joined by `-`, `--` or `__`, which is the
 * block/element/modifier convention the stylesheet header documents. The
 * look-behind stops a match inside a longer identifier or a custom property
 * (`--dg-space-1`, `--dgc-depth`) and inside a word (`data-dg-…`).
 */
const CLASS_NAME_PATTERN = /(?<![\w-])dg-[a-z0-9]+(?:(?:--|__|-)[a-z0-9]+)*/gu;

/**
 * The start of a `dg-*` class name, complete or not. A fragment joined to an
 * expression is judged by this rather than by {@link CLASS_NAME_PATTERN}, so
 * that `dg-${kind}` and `'dg-' + kind` — whose visible text is no complete
 * name — are still recognised as assembling one. The look-behind is the same,
 * which is what keeps a custom-property name built the same way
 * (`--dg-${key}`, the token-name helper in `src/tokens/tokens.ts`) out of it.
 */
const CLASS_PREFIX_PATTERN = /(?<![\w-])dg-/u;

/** A class name as a selector names it: a dot, then the name. */
const SELECTOR_CLASS_PATTERN = /\.(dg-[a-z0-9]+(?:(?:--|__|-)[a-z0-9]+)*)(?![\w-])/gu;

/**
 * JSX attribute names whose values carry classes. Every other attribute's
 * string value — an `id`, an ARIA reference, a data attribute, a title — is
 * content, and a `dg-` prefix inside it is not a class.
 */
const CLASS_ATTRIBUTE_PATTERN = /^(?:class|className|[A-Za-z]+ClassName)$/u;

/** Source files that are tests or declarations, which ship nothing. */
const NON_PRODUCT_FILE_PATTERN = /(?:\.test\.tsx?|\.d\.ts)$/u;

/**
 * A usage, loading or I/O failure — distinct from a finding, which is the
 * check doing its job. Carries an optional hint printed after the message.
 */
export class CheckCssClassesError extends Error {
  /**
   * @param {string} message
   * @param {{ hint?: string, showUsage?: boolean, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CheckCssClassesError';
    /** @type {string | undefined} */
    this.hint = options.hint;
    /** @type {boolean} */
    this.showUsage = options.showUsage === true;
  }
}

/**
 * @typedef {object} ClassSite
 * @property {string} file package-relative POSIX path
 * @property {number} line 1-based line, or 0 for a finding about a whole file
 */

/**
 * @typedef {object} ClassOccurrence
 * @property {string} className the class, or the visible fragment of an interpolated one
 * @property {ClassSite} site where it occurs
 */

/**
 * @typedef {object} Finding
 * @property {'unstyled-class' | 'unreferenced-class' | 'published-missing' | 'published-emitted' | 'interpolated-class'} rule
 * @property {string} className the class, or the visible fragment of an interpolated one
 * @property {ClassSite} site where the finding points
 * @property {string} message one sentence, with the fix
 */

/**
 * @typedef {object} ClassInventory
 * @property {ReadonlyMap<string, readonly ClassSite[]>} emitted class → every site a module emits it
 * @property {ReadonlyMap<string, readonly ClassSite[]>} selected class → every selector naming it
 * @property {readonly ClassOccurrence[]} interpolated every class name assembled by interpolation
 */

/**
 * Load the TypeScript compiler. It is the repository's own pinned toolchain
 * (the root `typescript` dev dependency that `tsc -b` already runs), resolved
 * from this script's location so the check needs no dependency of its own.
 *
 * @returns {typeof import('typescript')}
 * @throws {CheckCssClassesError} when the compiler cannot be resolved
 */
function loadTypeScript() {
  const require = createRequire(import.meta.url);
  try {
    return /** @type {typeof import('typescript')} */ (require('typescript'));
  } catch (error) {
    throw new CheckCssClassesError('the TypeScript compiler could not be resolved', {
      hint: 'Install the workspace dependencies first: `pnpm install --frozen-lockfile`.',
      cause: error,
    });
  }
}

/**
 * Every product module under `src/`, as package-relative POSIX paths in a
 * stable order.
 *
 * @param {string} root package root
 * @returns {Promise<string[]>}
 */
async function listSourceModules(root) {
  const base = path.join(root, SOURCE_ROOT_REL);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .map((rel) => rel.split(path.sep).join('/'))
    .filter((rel) => !NON_PRODUCT_FILE_PATTERN.test(rel))
    .sort();
}

/**
 * Record one class at one site.
 *
 * @param {Map<string, ClassSite[]>} map
 * @param {string} className
 * @param {ClassSite} site
 * @returns {void}
 */
function addSite(map, className, site) {
  const sites = map.get(className);
  if (sites === undefined) {
    map.set(className, [site]);
  } else {
    sites.push(site);
  }
}

/**
 * Whether a node is a string `+` concatenation.
 *
 * @param {typeof import('typescript')} ts
 * @param {import('typescript').Node | undefined} node
 * @returns {node is import('typescript').BinaryExpression}
 */
function isConcatenation(ts, node) {
  return (
    node !== undefined &&
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  );
}

/**
 * The outermost expression a literal is part of through parentheses and `+`
 * concatenation only — the whole value the literal contributes text to.
 *
 * @param {typeof import('typescript')} ts
 * @param {import('typescript').Node} node
 * @returns {import('typescript').Node}
 */
function concatenationRoot(ts, node) {
  let current = node;
  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) || isConcatenation(ts, current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * Whether a literal is, as a whole, the value of a JSX attribute that does not
 * carry classes — written directly (`id="…"`), as the attribute's expression
 * (`aria-label={`…`}`) or as a concatenation that is the expression
 * (`title={'Open ' + name}`). A literal nested deeper, such as an argument of a
 * call inside the expression, is read like any other.
 *
 * @param {typeof import('typescript')} ts
 * @param {import('typescript').Node} node
 * @returns {boolean}
 */
function isNonClassAttributeValue(ts, node) {
  let { parent } = concatenationRoot(ts, node);
  if (parent !== undefined && ts.isJsxExpression(parent)) parent = parent.parent;
  if (parent === undefined || !ts.isJsxAttribute(parent)) return false;
  return !CLASS_ATTRIBUTE_PATTERN.test(parent.name.getText());
}

/**
 * Whether a literal's text is joined, by string concatenation, to an operand
 * written immediately before it and immediately after it. Such a join is a
 * substitution in all but syntax — `'dg-badge--' + tone` assembles exactly the
 * name `dg-badge--${tone}` does — so the literal's edges are read with the same
 * rule as a template literal's. Parentheses are transparent; a literal on the
 * right of `+=` is joined to whatever the target already holds.
 *
 * @param {typeof import('typescript')} ts
 * @param {import('typescript').Node} node the literal
 * @returns {{ before: boolean, after: boolean }}
 */
function concatenationEdges(ts, node) {
  /** @param {'before' | 'after'} side */
  const joined = (side) => {
    let current = node;
    for (;;) {
      let { parent } = current;
      while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
        current = parent;
        parent = parent.parent;
      }
      if (
        side === 'before' &&
        parent !== undefined &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
      ) {
        return parent.right === current;
      }
      if (!isConcatenation(ts, parent)) return false;
      // The operand on the requested side of this `+` is adjacent to the
      // literal only when the literal is the edge of its own operand; otherwise
      // the literal is interior to that operand and the search moves outward.
      if (side === 'after' ? parent.left === current : parent.right === current) return true;
      current = parent;
    }
  };
  return { before: joined('before'), after: joined('after') };
}

/**
 * The classes one module emits, and the class names it assembles by
 * interpolation.
 *
 * A template literal is read part by part, and a literal joined to another
 * operand by `+` is read with the same edges. A class name that runs up to a
 * substitution or a concatenated operand — `dg-badge--${tone}`,
 * `'dg-badge--' + tone` — or starts right after one — `${block}dg-…` — is a
 * name no reader can know, and is reported instead of being recorded under its
 * visible fragment. So is a bare prefix in that position (`dg-${kind}`,
 * `'dg-' + kind`), although it holds no complete name: the check fails closed
 * on anything that begins a `dg-*` class and is completed at run time.
 *
 * @param {typeof import('typescript')} ts
 * @param {string} rel package-relative path
 * @param {string} text module source
 * @returns {{ emitted: ClassOccurrence[], interpolated: ClassOccurrence[] }}
 */
export function scanModule(ts, rel, text) {
  const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  /** @type {ClassOccurrence[]} */
  const emitted = [];
  /** @type {ClassOccurrence[]} */
  const interpolated = [];

  /** @param {import('typescript').Node} node */
  const siteOf = (node) => ({
    file: rel,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
  });

  /**
   * @param {string} value
   * @param {ClassSite} site
   * @param {{ opensOnSubstitution: boolean, closesOnSubstitution: boolean }} edges
   */
  const readValue = (value, site, edges) => {
    const tokens = value.split(/\s+/u);
    tokens.forEach((token, index) => {
      if (token === '') return;
      const touchesStart = index === 0 && edges.opensOnSubstitution;
      const touchesEnd = index === tokens.length - 1 && edges.closesOnSubstitution;
      if ((touchesStart || touchesEnd) && CLASS_PREFIX_PATTERN.test(token)) {
        interpolated.push({ className: token, site });
        return;
      }
      for (const match of token.matchAll(CLASS_NAME_PATTERN)) {
        emitted.push({ className: match[0], site });
      }
    });
  };

  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isNonClassAttributeValue(ts, node)) {
        const joined = concatenationEdges(ts, node);
        readValue(node.text, siteOf(node), {
          opensOnSubstitution: joined.before,
          closesOnSubstitution: joined.after,
        });
      }
    } else if (ts.isTemplateExpression(node)) {
      if (isNonClassAttributeValue(ts, node)) {
        for (const span of node.templateSpans) visit(span.expression);
        return;
      }
      const site = siteOf(node);
      const joined = concatenationEdges(ts, node);
      readValue(node.head.text, site, {
        opensOnSubstitution: joined.before,
        closesOnSubstitution: true,
      });
      node.templateSpans.forEach((span, index) => {
        const last = index === node.templateSpans.length - 1;
        readValue(span.literal.text, site, {
          opensOnSubstitution: true,
          closesOnSubstitution: !last || joined.after,
        });
        visit(span.expression);
      });
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { emitted, interpolated };
}

/**
 * The classes one stylesheet's selectors name. Comments are removed first, so
 * a class a comment mentions is not a selector; declaration bodies are never
 * read, so a string value cannot be mistaken for one either.
 *
 * @param {string} rel package-relative path
 * @param {string} text stylesheet source
 * @returns {{ className: string, site: ClassSite }[]}
 */
export function scanStylesheet(rel, text) {
  // Comments are blanked rather than deleted so every offset, and therefore
  // every line number, stays true.
  const rules = text.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, ' '));
  /** @type {number[]} offsets at which each line starts */
  const lineStarts = [0];
  for (let index = rules.indexOf('\n'); index !== -1; index = rules.indexOf('\n', index + 1)) {
    lineStarts.push(index + 1);
  }
  /** @param {number} offset */
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };

  /** @type {ClassOccurrence[]} */
  const selected = [];

  // A prelude is the text before a `{`. An at-rule's prelude (`@media …`,
  // `@keyframes …`) names no class; a keyframe step's (`from`, `to`) names
  // none either and simply matches nothing.
  for (const prelude of rules.matchAll(/[^{}]+(?=\{)/gu)) {
    const selector = prelude[0];
    if (selector.trim().startsWith('@')) continue;
    for (const match of selector.matchAll(SELECTOR_CLASS_PATTERN)) {
      const offset = (prelude.index ?? 0) + (match.index ?? 0);
      selected.push({ className: match[1] ?? '', site: { file: rel, line: lineOf(offset) } });
    }
  }

  return selected;
}

/**
 * Build the inventory of a package tree.
 *
 * @param {{ root?: string }} [options] package root; defaults to this package
 * @returns {Promise<ClassInventory>}
 * @throws {CheckCssClassesError} when a file cannot be read or TypeScript cannot be loaded
 */
export async function buildInventory({ root = PACKAGE_ROOT } = {}) {
  const ts = loadTypeScript();
  /** @type {Map<string, ClassSite[]>} */
  const emitted = new Map();
  /** @type {Map<string, ClassSite[]>} */
  const selected = new Map();
  /** @type {ClassOccurrence[]} */
  const interpolated = [];

  let modules;
  try {
    modules = await listSourceModules(root);
  } catch (error) {
    throw new CheckCssClassesError(`${SOURCE_ROOT_REL}/: could not be listed`, { cause: error });
  }

  for (const rel of modules) {
    const scanned = scanModule(ts, rel, await readPackageFile(root, rel));
    for (const { className, site } of scanned.emitted) addSite(emitted, className, site);
    interpolated.push(...scanned.interpolated);
  }

  for (const rel of STYLESHEETS_REL) {
    for (const { className, site } of scanStylesheet(rel, await readPackageFile(root, rel))) {
      addSite(selected, className, site);
    }
  }

  return { emitted, selected, interpolated };
}

/**
 * Read one package file, as a check failure rather than a crash when absent.
 *
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<string>}
 */
async function readPackageFile(root, rel) {
  try {
    return await readFile(path.join(root, rel), 'utf8');
  } catch (error) {
    throw new CheckCssClassesError(`${rel}: could not be read`, { cause: error });
  }
}

/**
 * Compare the two sides of an inventory and list every finding, in a stable
 * order: by rule, then by class name.
 *
 * @param {ClassInventory} inventory
 * @param {Readonly<Record<string, string>>} [published] classes allowed to have no emitter
 * @returns {Finding[]}
 */
export function findDrift(inventory, published = PUBLISHED_CLASSES) {
  /** @type {Finding[]} */
  const findings = [];
  const byName = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

  for (const className of [...inventory.emitted.keys()].sort(byName)) {
    if (inventory.selected.has(className)) continue;
    const [site] = inventory.emitted.get(className) ?? [];
    if (site === undefined) continue;
    findings.push({
      rule: 'unstyled-class',
      className,
      site,
      message:
        `"${className}" is emitted but no selector in ${STYLESHEETS_REL.join(' or ')} names it; ` +
        'add the rule the class exists for, or stop emitting it',
    });
  }

  for (const className of [...inventory.selected.keys()].sort(byName)) {
    if (inventory.emitted.has(className) || Object.hasOwn(published, className)) continue;
    const [site] = inventory.selected.get(className) ?? [];
    if (site === undefined) continue;
    findings.push({
      rule: 'unreferenced-class',
      className,
      site,
      message:
        `"${className}" is selected but no module under ${SOURCE_ROOT_REL}/ emits it; remove the ` +
        'selector, or list the class in PUBLISHED_CLASSES if a host surface applies it',
    });
  }

  for (const className of Object.keys(published).sort(byName)) {
    if (inventory.selected.has(className)) continue;
    findings.push({
      rule: 'published-missing',
      className,
      site: { file: 'scripts/check-css-classes.mjs', line: 0 },
      message:
        `"${className}" is listed in PUBLISHED_CLASSES but no selector names it; restore its ` +
        'rule or drop the entry',
    });
  }

  for (const className of Object.keys(published).sort(byName)) {
    const [site] = inventory.emitted.get(className) ?? [];
    if (site === undefined) continue;
    findings.push({
      rule: 'published-emitted',
      className,
      site,
      message:
        `"${className}" is listed in PUBLISHED_CLASSES but a module emits it, so it is no ` +
        'longer an exception; drop the entry',
    });
  }

  for (const { className, site } of inventory.interpolated) {
    findings.push({
      rule: 'interpolated-class',
      className,
      site,
      message:
        `"${className}" builds a class name by interpolation, which no inventory can read; ` +
        'spell each class out in a lookup table',
    });
  }

  return findings;
}

/**
 * Build the inventory of a package tree and list its findings.
 *
 * @param {{ root?: string, published?: Readonly<Record<string, string>> }} [options]
 * @returns {Promise<{ inventory: ClassInventory, findings: Finding[] }>}
 */
export async function checkCssClasses({ root = PACKAGE_ROOT, published = PUBLISHED_CLASSES } = {}) {
  const inventory = await buildInventory({ root });
  return { inventory, findings: findDrift(inventory, published) };
}

/**
 * Command-line usage, printed by `--help` and beside a usage error.
 *
 * @returns {string}
 */
function usage() {
  return `usage: ${CHECK_COMMAND} [--list]

Checks that every dg-* class a module under ${SOURCE_ROOT_REL}/ emits has a selector
in one of
  ${STYLESHEETS_REL.join('\n  ')}
and that every class a selector names is emitted by a module or listed as a
published class. Paths resolve from this script's own location, so the result
is identical from any working directory. Reads only.

Options:
  --list       also print the inventory: every class with its emitting modules
  -h, --help   print this help and exit

Exit codes:
  0  the inventory is consistent
  1  at least one finding
  2  bad usage, an unresolvable TypeScript compiler, or an I/O failure`;
}

/**
 * Parse the command line. The script takes no positional arguments, so an
 * unrecognised token is a usage error rather than something silently ignored.
 *
 * @param {readonly string[]} argv arguments after the script path
 * @returns {{ list: boolean, help: boolean }}
 * @throws {CheckCssClassesError} on an unrecognised argument
 */
function parseArgs(argv) {
  const args = { list: false, help: false };

  for (const arg of argv) {
    switch (arg) {
      case '--list':
        args.list = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new CheckCssClassesError(`unrecognised argument: ${arg}`, { showUsage: true });
    }
  }

  return args;
}

/**
 * Write one line to a stream, instead of `console`, so output is exactly one
 * line per message and a caller can capture it.
 *
 * @param {import("node:stream").Writable} stream
 * @param {string} text
 * @returns {void}
 */
function writeLine(stream, text) {
  stream.write(`${text}\n`);
}

/**
 * Print a failure that is not a finding and return its exit code.
 *
 * @param {unknown} error
 * @param {import("node:stream").Writable} stream
 * @returns {number}
 */
function reportFailure(error, stream) {
  if (error instanceof CheckCssClassesError) {
    writeLine(stream, `check-css-classes: ${error.message}`);
    if (error.hint !== undefined) writeLine(stream, `\n${error.hint}`);
    if (error.showUsage) writeLine(stream, `\n${usage()}`);
    return EXIT_ERROR;
  }

  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeLine(stream, `check-css-classes: unexpected failure\n${detail}`);
  return EXIT_ERROR;
}

/**
 * Command-line entry point. Prints its own output and returns the exit code
 * instead of ending the process, so a caller can drive it and read the result.
 *
 * @param {readonly string[]} [argv] arguments after the script path
 * @param {{ root?: string, stdout?: import("node:stream").Writable, stderr?: import("node:stream").Writable }} [options]
 * @returns {Promise<number>} 0 consistent, 1 findings, 2 failure
 */
export async function main(argv = [], options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const root = options.root ?? PACKAGE_ROOT;

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return reportFailure(error, stderr);
  }

  if (args.help) {
    writeLine(stdout, usage());
    return EXIT_OK;
  }

  try {
    const { inventory, findings } = await checkCssClasses({ root });

    if (args.list) {
      for (const className of [...inventory.emitted.keys()].sort()) {
        const files = [...new Set((inventory.emitted.get(className) ?? []).map((s) => s.file))];
        writeLine(stdout, `${className}  ${files.join(', ')}`);
      }
      for (const className of Object.keys(PUBLISHED_CLASSES).sort()) {
        writeLine(stdout, `${className}  (published) ${PUBLISHED_CLASSES[className] ?? ''}`);
      }
    }

    if (findings.length === 0) {
      writeLine(
        stdout,
        `class inventory consistent: ${String(inventory.emitted.size)} emitted classes, ` +
          `${String(inventory.selected.size)} selected classes, ` +
          `${String(Object.keys(PUBLISHED_CLASSES).length)} published`,
      );
      return EXIT_OK;
    }

    for (const finding of findings.slice(0, MAX_REPORTED_FINDINGS)) {
      const at =
        finding.site.line > 0
          ? `${finding.site.file}:${String(finding.site.line)}`
          : finding.site.file;
      writeLine(stderr, `${at}: ${finding.rule}: ${finding.message}`);
    }
    const hidden = findings.length - MAX_REPORTED_FINDINGS;
    if (hidden > 0) writeLine(stderr, `… and ${String(hidden)} more`);
    writeLine(
      stderr,
      `${String(findings.length)} class inventory finding(s); re-run "${CHECK_COMMAND}" after fixing`,
    );
    return EXIT_DRIFT;
  } catch (error) {
    return reportFailure(error, stderr);
  }
}

/**
 * Whether this module is the process entry point, so importing it — which
 * `src/styles/class-inventory.test.ts` does — never runs the CLI. The entry
 * path is resolved through `realpath` because the runtime reports
 * `import.meta.url` as a real path, and a workspace reached through a symbolic
 * link would otherwise compare unequal.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;

  let resolved;
  try {
    resolved = realpathSync(entry);
  } catch {
    resolved = path.resolve(entry);
  }

  return import.meta.url === pathToFileURL(resolved).href;
}

if (isEntryPoint()) {
  // A reader that closes the pipe early — `--list | head` — is not a failure
  // of the check: stop writing and keep the exit code the check produced.
  // Any other stream error is real and is rethrown.
  process.stdout.on('error', (error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EPIPE') return;
    throw error;
  });
  // `process.exitCode` rather than `process.exit()`, so buffered output is
  // flushed before the process ends.
  process.exitCode = await main(process.argv.slice(2));
}
