/**
 * The `imports` extractor: the module-graph half of a code index.
 *
 * ## What it owns
 *
 * Extractor id `imports` (see {@link IMPORTS_EXTRACTOR_ID}), the first entry of
 * `../indexer.ts`'s `DEFAULT_EXTRACTORS`, and the sole producer of three things:
 *
 * - the **`file` node** of every visited module, including its
 *   {@link FileNodeData} payload — the extension, the client-module directive
 *   and, the reason ownership sits here at all,
 *   {@link FileNodeData.externalImports};
 * - every **`imports` edge**, `file` → `file`, for a module specifier that
 *   resolves to another indexed file of the same project;
 * - every **`exports` edge**, `file` → `file`, for a re-export — an export
 *   declaration that carries a module specifier.
 *
 * `../indexer.ts` builds one {@link ExtractorContext} per file and hands it to
 * every extractor without emitting any node of its own, so a file that no other
 * extractor finds anything in still reaches the graph as the anchor of its
 * `declares`, `imports` and `exports` edges. That is the ownership decision
 * recorded here: **this module emits the `file` node**, one per visit, and no
 * other producer emits a divergent one (an identical duplicate is de-duplicated
 * silently by `../graph/graph.ts`, a divergent one is a `duplicate-node-id`
 * diagnostic). A `file` node is identified as `name` = the project-relative
 * path, at line 1, column 1 — the convention `../graph/types.ts`'s own worked
 * examples use — so that the id of a *target* file computed here is byte-equal
 * to the id emitted when the indexer visits that target.
 *
 * ## What it deliberately does not do
 *
 * - It **never emits a `references` edge.** Reference sites are the lazy path:
 *   `../indexer.ts`'s `createReferenceResolver` deepens them on demand, because
 *   `findReferences` forces whole-program type resolution.
 * - It **never emits an `exports` edge for a local export.** `export function`,
 *   `export const` and `export default` are recorded by `./symbols.ts` through
 *   `SymbolNodeData` and `CodeNodeBase.exported`; only a declaration with a
 *   module specifier is a relation between two files and therefore an edge.
 * - It **never reads another extractor's output.** Every extractor derives
 *   everything from the abstract syntax tree of the one file it was handed, and
 *   cross-extractor joins happen once, in graph assembly.
 * - It **never writes.** No filesystem access, no mutation of the project or of
 *   any node, no caching, no process state. {@link Extractor.extract} is
 *   synchronous and pure, and it is called for a *developer's working tree*.
 *
 * ## Abstract syntax tree first, never type resolution
 *
 * Resolution here means *module* resolution — ts-morph's
 * `getModuleSpecifierSourceFile()`, which walks the program's resolver and
 * honours the target project's `paths` aliases and extensionless relative
 * specifiers — and never *type* resolution. A target project is indexed exactly
 * as the developer left it, with whatever its `node_modules` does or does not
 * contain: the indexing corpus under `test/fixtures/sample-next-app` declares
 * three packages in its manifest and installs none of them, so three of its
 * specifiers resolve to nothing. `undefined` from the resolver is therefore the
 * normal answer for a package, not an error, and nothing in this module may
 * throw, warn or degrade because a module is missing. What cannot become an
 * edge becomes an {@link ExternalImportRef} on the importing file, which is the
 * single place the product learns that a dependency exists but did not resolve
 * — `../summary.ts` reads it for framework detection and the investigation
 * stage reads it as evidence.
 *
 * ## Known limitations, v1
 *
 * - **Dynamic `import()` and CommonJS `require()` specifiers are out of scope.**
 *   Neither is a static module binding, both are frequently computed rather than
 *   literal, and no invariant of the graph depends on them. They are ignored
 *   gracefully: nothing is emitted for them and nothing fails because of them.
 *   The same holds for TypeScript's `import x = require('…')` form.
 * - **The re-export *form* is not carried on the edge.** {@link CodeEdge} has
 *   no payload field — by design, since an edge is a relation rather than a
 *   record — so the four forms are distinguished by the edge *site*
 *   (`file`, `line`, `column`, plus the raw `specifier`), which is unique per
 *   declaration. {@link classifyReExportForm} is exported so a consumer holding
 *   an export declaration can recover the form the same way this module does.
 *
 * ## Consumers
 *
 * `../graph/query.ts` traverses the `imports`/`exports` edges (the alias hop and
 * the barrel chain are resolved along them), `../summary.ts` reads
 * {@link FileNodeData}, and `../indexer.ts` registers the extractor. The graph
 * these three read is what `packages/instrumentation`'s feasibility check and
 * the `code-graph` source-resolution route ultimately stand on, so a module
 * specifier that is silently dropped here is a module the product does not know
 * exists.
 */

import { Node } from 'ts-morph';
import type {
  ExportDeclaration,
  ExportSpecifier,
  ImportDeclaration,
  ImportSpecifier,
  SourceFile,
} from 'ts-morph';

import { extnamePosix, isSafeRelativePath } from '@debuggen/shared';

import { makeEdgeId, makeNodeId } from '../graph/graph.js';
import type {
  CodeEdge,
  CodeNodeOf,
  ExternalImportRef,
  Extractor,
  ExtractorContext,
  ExtractorResult,
  FileNodeData,
  IndexDiagnostic,
} from '../graph/types.js';
import { isIndexableFile, shouldExcludePath } from '../project.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabulary and constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The {@link Extractor.id} of this extractor.
 *
 * Stable across versions: it appears in {@link IndexDiagnostic.extractorId},
 * which is what makes a failure attributable, and renaming it would make
 * already-reported diagnostics untraceable. `../indexer.ts` lists it first in
 * `DEFAULT_EXTRACTORS`.
 */
export const IMPORTS_EXTRACTOR_ID = 'imports';

/**
 * Every form a re-export — an export declaration carrying a module specifier —
 * can take, as a closed readonly tuple.
 *
 * The members, with the syntax each one matches:
 *
 * - `star` — `export * from './x'`: every binding of the target, unnamed.
 * - `namespace` — `export * as ns from './x'`: the target's whole namespace
 *   under one local name.
 * - `named` — `export { thing } from './x'`, with or without an alias.
 * - `type-named` — `export type { Thing } from './x'`, and equally a named form
 *   all of whose specifiers carry a per-specifier `type` modifier. A type-only
 *   re-export erases at runtime, so it says what the module was *compiled*
 *   against rather than what it *loads*.
 * - `default-as` — `export { default as Thing } from './x'`: the target's
 *   default binding re-exported under a name. The one form whose imported name
 *   is not the name a reader sees.
 *
 * Frozen, and ordered by syntax family — the two star forms, then the three
 * clause forms. That is a reading order and **not** the precedence a
 * declaration matching more than one form is resolved by, which
 * {@link classifyReExportForm} documents and owns.
 */
export const RE_EXPORT_FORMS = Object.freeze([
  'star',
  'namespace',
  'named',
  'type-named',
  'default-as',
] as const);

/**
 * One member of {@link RE_EXPORT_FORMS}.
 *
 * Derived from the runtime tuple so the two cannot disagree — the convention
 * `../graph/types.ts` uses for every vocabulary in this package.
 */
export type ReExportForm = (typeof RE_EXPORT_FORMS)[number];

/**
 * The line a `file` node is anchored at.
 *
 * A module is a point rather than a span, and `1` (never `0`) is what the
 * 1-based source-location contract requires of a node that will be turned into
 * a location an editor opens.
 */
const FILE_NODE_LINE = 1;

/** The column a `file` node is anchored at, on the same 1-based convention. */
const FILE_NODE_COLUMN = 1;

/**
 * The directive that marks a module as part of the client graph.
 *
 * Its presence is the only reliable static signal for a client component, and
 * its **absence** is what classifies a server component — see
 * {@link FileNodeData.isClientModule}.
 */
const CLIENT_MODULE_DIRECTIVE = 'use client';

/**
 * The name a default binding is recorded under in
 * {@link ExternalImportRef.names}.
 *
 * Also the imported name an export specifier carries in the `default-as` form,
 * which is how {@link classifyReExportForm} recognises it.
 */
const DEFAULT_BINDING_NAME = 'default';

/** The name a namespace binding is recorded under in {@link ExternalImportRef.names}. */
const NAMESPACE_BINDING_NAME = '*';

/**
 * The prefixes that make a module specifier unambiguously project-internal: the
 * two relative ones and the rooted one.
 *
 * A specifier starting with one of these cannot name a package, so failing to
 * resolve it is a finding worth an `unresolved-import` diagnostic rather than
 * the ordinary state of an uninstalled dependency.
 */
const PROJECT_INTERNAL_PREFIXES = Object.freeze(['./', '../', '/'] as const);

/** The two relative specifiers that carry no prefix but are still relative. */
const PROJECT_INTERNAL_LITERALS = Object.freeze(['.', '..'] as const);

/** The wildcard character a `paths` alias pattern may contain exactly once. */
const ALIAS_WILDCARD = '*';

/** Shared empty list, so the common no-alias project allocates nothing. */
const NO_ALIAS_PATTERNS: readonly string[] = Object.freeze([]);

/** Shared empty node list, for the one result that carries no file node. */
const NO_NODES: readonly CodeNodeOf<'file'>[] = Object.freeze([]);

/** Shared empty edge list, for the same result. */
const NO_EDGES: readonly CodeEdge[] = Object.freeze([]);

/** The separator that keeps an {@link ExternalImportRef} de-duplication key injective. */
const KEY_SEPARATOR = '\u0000';

/** The separator between binding names inside a de-duplication key. */
const NAME_SEPARATOR = '\u0001';

/* -------------------------------------------------------------------------------------------------
 * Internal shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * Where a module specifier led, as the three outcomes that matter to the graph.
 *
 * - `project` — it resolved to a file this index holds a `file` node for, so the
 *   relation becomes an edge. `file` is the target's project-relative POSIX
 *   path.
 * - `external` — it resolved to something outside the indexed set: an installed
 *   package, a vendored tree, a declaration file. There is no node to point at,
 *   so the specifier is recorded on the importing file instead. Ordinary, and
 *   not a finding.
 * - `unresolved` — the resolver produced nothing. Also recorded on the
 *   importing file; whether it is *also* a finding depends on whether the
 *   specifier could have named a package
 *   (see {@link isProjectInternalSpecifier}).
 */
type SpecifierTarget =
  | { readonly kind: 'project'; readonly file: string }
  | { readonly kind: 'external' }
  | { readonly kind: 'unresolved' };

/** The shared `external` outcome, so classification allocates nothing. */
const EXTERNAL_TARGET: SpecifierTarget = Object.freeze({ kind: 'external' });

/** The shared `unresolved` outcome. */
const UNRESOLVED_TARGET: SpecifierTarget = Object.freeze({ kind: 'unresolved' });

/**
 * What one declaration says, reduced to the facts both statement kinds share.
 *
 * Collected once per declaration so the import path and the re-export path can
 * be recorded, de-duplicated and turned into an edge by the same code: the two
 * differ in how the facts are *read* off the syntax and in the edge kind they
 * produce, not in what is done with them afterwards.
 */
interface DeclarationFacts {
  /** The specifier exactly as written, before any resolution. */
  readonly specifier: string;

  /** Whether the declaration erases at runtime — see {@link isTypeOnlyImport}. */
  readonly typeOnly: boolean;

  /**
   * The imported names the declaration binds, in source order, on
   * {@link ExternalImportRef.names}' convention: a named binding under its
   * imported name, a default under `'default'`, a namespace under `'*'`, and an
   * empty list for a side-effect-only import.
   */
  readonly names: readonly string[];

  /** The **1-based** line the declaration starts on. */
  readonly line: number;

  /** The **1-based** column the declaration starts at. */
  readonly column: number;
}

/**
 * The mutable collection one `extract` call fills.
 *
 * A single object threaded through the per-declaration helpers rather than four
 * parameters at every call site, and it never leaves the call: the arrays are
 * copied into an immutable {@link ExtractorResult} before it returns. The two
 * sets are the local uniqueness guards — an {@link ExternalImportRef} is
 * de-duplicated only when specifier, type-only flag and bindings all match, and
 * an edge id is never emitted twice even though positions already make it
 * unique per declaration.
 */
interface ExtractionSink {
  /** Edges found so far, in emission order. */
  readonly edges: CodeEdge[];

  /** Findings so far, in discovery order. */
  readonly diagnostics: IndexDiagnostic[];

  /** External and unresolved specifiers so far, in source order. */
  readonly externalImports: ExternalImportRef[];

  /** De-duplication keys of {@link ExtractionSink.externalImports}. */
  readonly externalKeys: Set<string>;

  /** Ids of {@link ExtractionSink.edges}. */
  readonly edgeIds: Set<string>;
}

/* -------------------------------------------------------------------------------------------------
 * Re-export classification
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which {@link ReExportForm} an export declaration is written in.
 *
 * Pure, total and independent of resolution: it reads the syntax and nothing
 * else, so it answers for a declaration whose target does not exist. Exported
 * because {@link CodeEdge} carries no payload field — the form cannot travel on
 * the `exports` edge, so a consumer that has the edge site and wants the form
 * asks this function about the declaration at that site, and gets exactly what
 * this module used.
 *
 * The forms are probed in the order below, and that precedence is the contract
 * for a declaration that satisfies more than one of them:
 *
 * 1. a namespace binding (`export * as ns from`) wins over everything, because
 *    the binding *is* the whole module;
 * 2. an absent named-export clause is the star form (`export * from`);
 * 3. a type-only declaration — either the declaration-level `type` modifier or
 *    a clause whose every specifier carries one — is `type-named`, so
 *    `export type { default as Thing } from './x'` reports `type-named` rather
 *    than `default-as`: what matters most about it is that it erases;
 * 4. a clause naming the target's `default` binding is `default-as`, whether or
 *    not it carries an alias, and even when other specifiers sit beside it;
 * 5. anything else is the plain `named` form.
 *
 * Classification keys on the **imported** name, so `export { Thing as default }
 * from './x'` — which re-exports a named binding *as* this module's default — is
 * `named` rather than `default-as`.
 *
 * @param declaration The export declaration to classify. A declaration without
 * a module specifier is a local export and not a re-export at all; it is
 * classified all the same, on its clause alone, rather than rejected.
 * @returns The form the declaration is written in.
 *
 * @example
 * ```ts
 * classifyReExportForm(decl); // 'default-as' for `export { default as Widget } from './widget'`
 * ```
 */
export function classifyReExportForm(declaration: ExportDeclaration): ReExportForm {
  // `export * as ns from './x'` — a namespace binding, which ts-morph reports
  // alongside `isNamespaceExport()`, hence the earlier check.
  if (declaration.getNamespaceExport() !== undefined) {
    return 'namespace';
  }

  // `export * from './x'` — no named-export clause at all.
  if (declaration.isNamespaceExport()) {
    return 'star';
  }

  const named = declaration.getNamedExports();

  // `export type { Thing } from './x'`, and the per-specifier spelling
  // `export { type Thing } from './x'`.
  if (isTypeOnlyReExport(declaration, named)) {
    return 'type-named';
  }

  // `export { default as Thing } from './x'` — the imported name is `default`.
  for (const specifier of named) {
    if (specifier.getName() === DEFAULT_BINDING_NAME) {
      return 'default-as';
    }
  }

  // `export { thing } from './x'`, with or without an alias.
  return 'named';
}

/* -------------------------------------------------------------------------------------------------
 * Reading one declaration
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether an import declaration erases at runtime.
 *
 * Two spellings mean the same thing to a consumer asking whether a dependency
 * is a *runtime* one — which is the question {@link ExternalImportRef.typeOnly}
 * exists to answer: the declaration-level modifier (`import type { T } from
 * 'pkg'`) and a clause whose every binding carries a per-specifier modifier
 * (`import { type T } from 'pkg'`). A value binding anywhere in the
 * declaration — a default import, a namespace import or one specifier without
 * the modifier — makes the whole declaration a runtime import.
 *
 * @param declaration The import declaration.
 * @returns `true` when nothing the declaration binds survives compilation.
 */
function isTypeOnlyImport(declaration: ImportDeclaration): boolean {
  if (declaration.isTypeOnly()) {
    return true;
  }

  if (declaration.getDefaultImport() !== undefined) {
    return false;
  }

  if (declaration.getNamespaceImport() !== undefined) {
    return false;
  }

  const named: readonly ImportSpecifier[] = declaration.getNamedImports();

  return named.length > 0 && named.every((specifier) => specifier.isTypeOnly());
}

/**
 * Whether a re-export erases at runtime, on the same two spellings as
 * {@link isTypeOnlyImport}.
 *
 * @param declaration The export declaration.
 * @param named The declaration's named exports, already read by the caller so
 * the syntax is walked once.
 * @returns `true` when every binding the declaration re-exports is a type.
 */
function isTypeOnlyReExport(
  declaration: ExportDeclaration,
  named: readonly ExportSpecifier[],
): boolean {
  if (declaration.isTypeOnly()) {
    return true;
  }

  return named.length > 0 && named.every((specifier) => specifier.isTypeOnly());
}

/**
 * The imported names an import declaration binds, in source order.
 *
 * {@link ExternalImportRef.names}' convention, which is about what the *target*
 * module is asked for rather than what the importing module calls it: a named
 * binding under its imported name (`{ thing as other }` records `'thing'`), a
 * default under `'default'`, a namespace under `'*'`. A side-effect-only import
 * binds nothing and yields an empty array — empty rather than absent, so a
 * consumer iterates without a guard.
 *
 * @param declaration The import declaration.
 * @returns The imported names.
 */
function importBindingNames(declaration: ImportDeclaration): readonly string[] {
  const names: string[] = [];

  if (declaration.getDefaultImport() !== undefined) {
    names.push(DEFAULT_BINDING_NAME);
  }

  if (declaration.getNamespaceImport() !== undefined) {
    names.push(NAMESPACE_BINDING_NAME);
  }

  for (const specifier of declaration.getNamedImports()) {
    names.push(specifier.getName());
  }

  return names;
}

/**
 * The imported names a re-export names, in source order, on the same convention
 * as {@link importBindingNames}.
 *
 * Derived from the classified form rather than from the syntax a second time:
 * both star forms ask the target for everything it has, so both record `'*'`,
 * and every clause form records the names it lists — `'default'` among them for
 * the `default-as` form, which is what it actually imports.
 *
 * @param form The form {@link classifyReExportForm} reported.
 * @param named The declaration's named exports, already read by the caller.
 * @returns The imported names.
 */
function reExportBindingNames(
  form: ReExportForm,
  named: readonly ExportSpecifier[],
): readonly string[] {
  if (form === 'star' || form === 'namespace') {
    return [NAMESPACE_BINDING_NAME];
  }

  return named.map((specifier) => specifier.getName());
}

/**
 * The 1-based line and column a declaration starts at.
 *
 * ts-morph's `getLineAndColumnAtPos` is already 1-indexed on both axes, which is
 * the convention every position in an index carries, and `getStart()` is the
 * first character of the declaration itself rather than of its leading comment
 * — so the position names the statement a developer would be taken to.
 *
 * @param sourceFile The file the declaration belongs to.
 * @param declaration The declaration.
 * @returns Its 1-based start position.
 */
function declarationPosition(
  sourceFile: SourceFile,
  declaration: ExportDeclaration | ImportDeclaration,
): { readonly line: number; readonly column: number } {
  return sourceFile.getLineAndColumnAtPos(declaration.getStart());
}

/**
 * Whether a module carries the client-component directive at the top of the
 * file.
 *
 * Only the directive prologue is examined — the leading run of statements that
 * are nothing but a string literal — because that is the only position the
 * directive has any effect in. The scan stops at the first statement that is
 * not one, so a string expression further down the module is never mistaken for
 * a directive, and a `'use strict'` sitting in front of the directive does not
 * hide it.
 *
 * @param sourceFile The module to inspect.
 * @returns `true` when the module declares itself part of the client graph.
 */
function hasClientDirective(sourceFile: SourceFile): boolean {
  for (const statement of sourceFile.getStatements()) {
    if (!Node.isExpressionStatement(statement)) {
      return false;
    }

    const expression = statement.getExpression();
    if (!Node.isStringLiteral(expression)) {
      return false;
    }

    if (expression.getLiteralValue() === CLIENT_MODULE_DIRECTIVE) {
      return true;
    }
  }

  return false;
}

/* -------------------------------------------------------------------------------------------------
 * Specifier resolution
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `paths` alias patterns the target project declares, or an empty list.
 *
 * Read from the compiler options the project was opened with — the target's own
 * configuration, never this repository's — and used for one purpose only:
 * deciding whether an *unresolved* specifier could have named a package. A
 * project without a configuration has no aliases, which is why
 * `LoadedProject.tsConfigFilePath` being `undefined` is worth acting on.
 *
 * @param ctx The extractor context.
 * @returns The alias patterns, in configuration order.
 */
function readAliasPatterns(ctx: ExtractorContext): readonly string[] {
  const { paths } = ctx.loaded.project.getCompilerOptions();

  if (paths === undefined) {
    return NO_ALIAS_PATTERNS;
  }

  return Object.keys(paths);
}

/**
 * Whether a specifier matches one `paths` alias pattern.
 *
 * TypeScript's own pattern grammar: at most one `*`, matched as a prefix and a
 * suffix around it, and an exact comparison when there is none. The length
 * guard is what stops the prefix and the suffix from overlapping in a candidate
 * too short to hold both — for the pattern `'a*b'`, `'ab'` matches with the
 * wildcard capturing nothing while `'a'` must not match at all.
 *
 * @param specifier The specifier as written.
 * @param pattern One key of the target's `paths` map.
 * @returns `true` when the pattern covers the specifier.
 */
function matchesAliasPattern(specifier: string, pattern: string): boolean {
  const wildcard = pattern.indexOf(ALIAS_WILDCARD);

  if (wildcard === -1) {
    return specifier === pattern;
  }

  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + ALIAS_WILDCARD.length);

  return (
    specifier.length >= prefix.length + suffix.length &&
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix)
  );
}

/**
 * Whether a specifier claims to name something inside the project.
 *
 * The question only arises once resolution has already failed, and it decides
 * between two very different silences. A relative specifier, or one matching a
 * declared `paths` alias, names a file that is supposed to be there: failing to
 * resolve it is a hole in the graph and earns an `unresolved-import`
 * diagnostic. A bare specifier names a package, and an uninstalled or external
 * package is the ordinary state of a working tree — recorded, never reported.
 *
 * A bare specifier that a `baseUrl` could have mapped into the project is
 * treated as external too: it is indistinguishable from a package name without
 * attempting the resolution the compiler has already attempted, and only the
 * diagnostic is affected — the specifier is recorded either way.
 *
 * @param specifier The specifier as written.
 * @param aliasPatterns The target project's `paths` patterns.
 * @returns `true` when the specifier addresses the project rather than a
 * package.
 */
function isProjectInternalSpecifier(specifier: string, aliasPatterns: readonly string[]): boolean {
  for (const prefix of PROJECT_INTERNAL_PREFIXES) {
    if (specifier.startsWith(prefix)) {
      return true;
    }
  }

  for (const literal of PROJECT_INTERNAL_LITERALS) {
    if (specifier === literal) {
      return true;
    }
  }

  for (const pattern of aliasPatterns) {
    if (matchesAliasPattern(specifier, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Where one declaration's module specifier led.
 *
 * Module resolution only: `getModuleSpecifierSourceFile()` asks the program's
 * resolver, which honours the target's `paths` aliases and extensionless
 * relative specifiers without demanding that anything type-check. A resolver
 * that throws for an exotic specifier is treated exactly as one that returns
 * nothing, because the outcome for the graph is the same and an indexing run
 * must not depend on an edge case of a third-party resolver.
 *
 * A resolved file becomes an edge endpoint only when this index will hold a
 * `file` node for it. Three cheap lexical screens run first — outside the
 * project root, not an indexable extension, inside an excluded directory — and
 * the authoritative test is membership of `LoadedProject.sourceFiles()`, the
 * frozen set the index is defined over, compared by identity because ts-morph
 * hands out one wrapper per file. Anything else resolved is external: a
 * package, a vendored tree, a declaration file, a file the project loader
 * refused.
 *
 * @param ctx The extractor context.
 * @param declaration The declaration whose specifier is being resolved.
 * @returns Where the specifier led.
 */
function resolveSpecifierTarget(
  ctx: ExtractorContext,
  declaration: ExportDeclaration | ImportDeclaration,
): SpecifierTarget {
  let target: SourceFile | undefined;

  try {
    target = declaration.getModuleSpecifierSourceFile();
  } catch {
    // Indistinguishable from "resolved to nothing", which is a normal answer.
    return UNRESOLVED_TARGET;
  }

  if (target === undefined) {
    return UNRESOLVED_TARGET;
  }

  const absolutePath: string = target.getFilePath();
  const relativePath = ctx.loaded.projectRelative(absolutePath);

  if (relativePath === undefined || !isSafeRelativePath(relativePath)) {
    return EXTERNAL_TARGET;
  }

  if (!isIndexableFile(relativePath) || shouldExcludePath(ctx.projectRoot, absolutePath)) {
    return EXTERNAL_TARGET;
  }

  if (!ctx.loaded.sourceFiles().includes(target)) {
    return EXTERNAL_TARGET;
  }

  return { kind: 'project', file: relativePath };
}

/* -------------------------------------------------------------------------------------------------
 * Recording
 * ---------------------------------------------------------------------------------------------- */

/**
 * The two edge kinds this module produces, as a union narrow enough to be
 * checked in both directions.
 *
 * Assigning it to {@link CodeEdge.kind} is what proves both members are part of
 * the vocabulary, and naming just these two here is what stops a third kind —
 * `references` above all — from being emitted by accident through a shared
 * helper.
 */
type ModuleEdgeKind = 'imports' | 'exports';

/**
 * The id of a `file` node, from the project-relative path alone.
 *
 * The single place this module composes a file-node identity, for its own file
 * and for a resolved target alike, so the two cannot drift: an edge is only
 * connected because the id computed for a target here is byte-equal to the id
 * emitted when the indexer visits that target. The name of a `file` node *is*
 * its project-relative path, and a module is a point at line 1, column 1.
 *
 * @param file The project-relative POSIX path.
 * @returns The node id.
 */
function fileNodeIdFor(file: string): string {
  return makeNodeId({
    kind: 'file',
    file,
    name: file,
    line: FILE_NODE_LINE,
    column: FILE_NODE_COLUMN,
  });
}

/**
 * Appends one edge, unless an identical id was already emitted for this file.
 *
 * Positions already make an edge id unique per declaration — two declarations
 * cannot start at the same line *and* column — so the guard never fires for
 * well-formed input. It is kept because the alternative failure mode is silent:
 * a duplicate id costs the graph a `duplicate-edge-id` diagnostic and drops the
 * second edge anyway, so a local check is strictly cheaper than the same
 * conclusion reached during assembly.
 *
 * @param sink The collection being filled.
 * @param kind Which relation this edge expresses.
 * @param siteFile The project-relative path of the file the declaration is
 * written in.
 * @param from The importing file's node id.
 * @param to The target file's node id.
 * @param facts The declaration the edge was read from.
 */
function recordEdge(
  sink: ExtractionSink,
  kind: ModuleEdgeKind,
  siteFile: string,
  from: string,
  to: string,
  facts: DeclarationFacts,
): void {
  const id = makeEdgeId({ kind, from, to, line: facts.line, column: facts.column });

  if (sink.edgeIds.has(id)) {
    return;
  }

  sink.edgeIds.add(id);
  sink.edges.push({
    id,
    kind,
    from,
    to,
    file: siteFile,
    line: facts.line,
    column: facts.column,
    specifier: facts.specifier,
  });
}

/**
 * Appends one external or unresolved specifier to the importing file's payload.
 *
 * De-duplicated exactly as {@link FileNodeData.externalImports} specifies —
 * "only when the same specifier appears twice with identical bindings" — so a
 * module that imports different names from one package keeps both records,
 * while a literally repeated declaration collapses to one. The key is injective
 * because its separators cannot occur in a module specifier or an identifier.
 *
 * @param sink The collection being filled.
 * @param facts The declaration the specifier was read from.
 */
function recordExternalImport(sink: ExtractionSink, facts: DeclarationFacts): void {
  const key = [
    facts.typeOnly ? 'type' : 'value',
    facts.specifier,
    facts.names.join(NAME_SEPARATOR),
  ].join(KEY_SEPARATOR);

  if (sink.externalKeys.has(key)) {
    return;
  }

  sink.externalKeys.add(key);
  sink.externalImports.push({
    specifier: facts.specifier,
    typeOnly: facts.typeOnly,
    names: facts.names,
  });
}

/**
 * Resolves one declaration and records whichever of the two outcomes applies.
 *
 * The single decision point of this module, and the reason the import path and
 * the re-export path share it: a specifier that lands on an indexed file
 * becomes an edge, and a specifier that lands anywhere else — a package, a
 * vendored file, nothing at all — becomes a record on the importing file, never
 * an edge whose endpoint the graph would have to drop.
 *
 * @param ctx The extractor context.
 * @param sink The collection being filled.
 * @param kind The edge kind the declaration would produce.
 * @param fileNodeId The importing file's node id.
 * @param aliasPatterns The target project's `paths` patterns.
 * @param declaration The declaration being resolved.
 * @param facts What the declaration says.
 */
function recordDeclaration(
  ctx: ExtractorContext,
  sink: ExtractionSink,
  kind: ModuleEdgeKind,
  fileNodeId: string,
  aliasPatterns: readonly string[],
  declaration: ExportDeclaration | ImportDeclaration,
  facts: DeclarationFacts,
): void {
  const target = resolveSpecifierTarget(ctx, declaration);

  if (target.kind === 'project') {
    recordEdge(sink, kind, ctx.file, fileNodeId, fileNodeIdFor(target.file), facts);
    return;
  }

  recordExternalImport(sink, facts);

  if (target.kind === 'unresolved' && isProjectInternalSpecifier(facts.specifier, aliasPatterns)) {
    sink.diagnostics.push(unresolvedImportDiagnostic(ctx.file, kind, facts.line));
  }
}

/* -------------------------------------------------------------------------------------------------
 * Diagnostics
 * ---------------------------------------------------------------------------------------------- */

/**
 * The position and statement kind a diagnostic is about, as a phrase.
 *
 * **Names, never quotes.** Every diagnostic this module emits is built from
 * this phrase plus a file path, and it carries no module specifier and no
 * fragment of the developer's source — the privacy constraint on the diagnostic
 * vocabulary, which matters here because a diagnostic is persisted with a
 * session and can reach model prompt context. The specifier itself is on the
 * file node's {@link FileNodeData.externalImports}, where it belongs to the
 * graph rather than to a message, and the file and line pinpoint the statement
 * exactly.
 *
 * @param kind The edge kind the declaration would have produced.
 * @param line The **1-based** line, or `0` when it could not be determined.
 * @returns The phrase naming the statement.
 */
function describeSite(kind: ModuleEdgeKind, line: number): string {
  const statement = kind === 'imports' ? 'import declaration' : 'export declaration';

  return line > 0
    ? `the ${statement} at line ${String(line)}`
    : `an ${statement} at an undetermined position`;
}

/**
 * A finding that a specifier addressing the project resolved to nothing.
 *
 * `unresolved-import` is this extractor's own code, and its meaning is exactly
 * this: the specifier resolves neither to a project file nor to a package, so
 * the graph has no edge for it. A `warning`, because the index stays usable
 * while being incomplete in a way that can change a result — a path through the
 * module graph now has a gap. An uninstalled *package* is not reported at all;
 * see {@link isProjectInternalSpecifier}.
 *
 * @param file The importing file, project-relative POSIX.
 * @param kind The edge kind that was not emitted.
 * @param line The **1-based** line of the declaration.
 * @returns The diagnostic.
 */
function unresolvedImportDiagnostic(
  file: string,
  kind: ModuleEdgeKind,
  line: number,
): IndexDiagnostic {
  return {
    severity: 'warning',
    code: 'unresolved-import',
    message: `${describeSite(kind, line)} of ${file} names a project module that could not be resolved; no ${kind} edge was recorded for it`,
    file,
    extractorId: IMPORTS_EXTRACTOR_ID,
  };
}

/**
 * A finding that a declaration carries a module specifier with no usable text.
 *
 * An empty specifier does not resolve and cannot be attributed to a package, so
 * it is reported under the same code as any other unresolvable project
 * reference and contributes nothing to the graph — recording an
 * {@link ExternalImportRef} with an empty specifier would put a value in the
 * index that no dependency lookup could ever match.
 *
 * @param file The importing file, project-relative POSIX.
 * @param kind The edge kind that was not emitted.
 * @param line The **1-based** line of the declaration.
 * @returns The diagnostic.
 */
function emptySpecifierDiagnostic(
  file: string,
  kind: ModuleEdgeKind,
  line: number,
): IndexDiagnostic {
  return {
    severity: 'warning',
    code: 'unresolved-import',
    message: `${describeSite(kind, line)} of ${file} carries an empty module specifier; no ${kind} edge was recorded for it`,
    file,
    extractorId: IMPORTS_EXTRACTOR_ID,
  };
}

/**
 * How a thrown value is described in a diagnostic: by its type, never by its
 * message.
 *
 * A third-party parser's error message can and does embed the text of the node
 * it choked on, which would smuggle source into a persisted diagnostic. The
 * constructor name is enough to tell a maintainer what kind of failure occurred
 * and carries nothing from the developer's file.
 *
 * @param cause The value that was thrown.
 * @returns Its constructor name, or the name of its primitive type.
 */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.constructor.name : typeof cause;
}

/**
 * A finding that one declaration could not be read.
 *
 * `error` severity: a part of the index is genuinely missing — whatever that
 * declaration would have contributed is absent — which is precisely how the
 * severity vocabulary defines the level. It is attributed to this extractor by
 * id, exactly as `../indexer.ts` attributes a failure it catches itself, and
 * every other declaration in the file is still processed: one malformed
 * construct costs one relation, never a file.
 *
 * @param file The file being visited, project-relative POSIX.
 * @param kind The edge kind that was not emitted.
 * @param line The **1-based** line, or `0` when it could not be determined.
 * @param cause The value that was thrown.
 * @returns The diagnostic.
 */
function declarationFailureDiagnostic(
  file: string,
  kind: ModuleEdgeKind,
  line: number,
  cause: unknown,
): IndexDiagnostic {
  return {
    severity: 'error',
    code: 'extractor-failed',
    message: `${describeSite(kind, line)} of ${file} could not be read; the module reference it declares is absent from the index`,
    file,
    extractorId: IMPORTS_EXTRACTOR_ID,
    detail: describeCause(cause),
  };
}

/**
 * A finding that the scan of a whole module failed.
 *
 * The outer guard behind the per-declaration ones. It should be unreachable —
 * every risky operation is already wrapped — and it exists so that
 * {@link Extractor.extract} cannot throw whatever a future ts-morph version
 * does: the file node is still emitted, so the file remains the anchor of the
 * other extractors' edges, and the failure is stated rather than inferred from
 * a suspiciously empty result.
 *
 * @param file The file being visited, project-relative POSIX.
 * @param cause The value that was thrown.
 * @returns The diagnostic.
 */
function moduleScanDiagnostic(file: string, cause: unknown): IndexDiagnostic {
  return {
    severity: 'error',
    code: 'extractor-failed',
    message: `the module references of ${file} could not be scanned; its imports and re-exports are absent from the index`,
    file,
    extractorId: IMPORTS_EXTRACTOR_ID,
    detail: describeCause(cause),
  };
}

/**
 * A finding that the context supplied a path this module refuses to build a
 * node from.
 *
 * `../indexer.ts` computes {@link ExtractorContext.file} through
 * `LoadedProject.projectRelative` and would drop an unsafe node itself, so this
 * is a defence against a hand-built context rather than an expected state. The
 * path is **not** quoted: it is exactly the value that failed the safety
 * refinement, which means it may be absolute or hold a traversal, and repeating
 * it in a persisted message would leak the directory layout the refinement
 * exists to keep out of the index.
 *
 * @returns The diagnostic.
 */
function unsafeContextPathDiagnostic(): IndexDiagnostic {
  return {
    severity: 'error',
    code: 'extractor-failed',
    message:
      'a file was visited with a path that is not a safe project-relative POSIX path; no file node, import edge or export edge was emitted for it',
    extractorId: IMPORTS_EXTRACTOR_ID,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Visiting declarations
 * ---------------------------------------------------------------------------------------------- */

/**
 * Reads one `import` declaration and records what it says.
 *
 * Every syntactic form is covered by the facts collected here: a default
 * import, a namespace import, named bindings with or without aliases, the
 * type-only spellings, and the side-effect-only form `import './x'` whose
 * binding list is legitimately empty.
 *
 * Failure is contained to this declaration. The position is taken before
 * anything that can fail, so a diagnostic can still name the line; a throw
 * after that costs one relation and the loop continues with the next
 * declaration.
 *
 * @param ctx The extractor context.
 * @param sink The collection being filled.
 * @param fileNodeId The importing file's node id.
 * @param aliasPatterns The target project's `paths` patterns.
 * @param declaration The declaration to visit.
 */
function visitImportDeclaration(
  ctx: ExtractorContext,
  sink: ExtractionSink,
  fileNodeId: string,
  aliasPatterns: readonly string[],
  declaration: ImportDeclaration,
): void {
  let line = 0;

  try {
    const position = declarationPosition(ctx.sourceFile, declaration);
    line = position.line;

    const specifier = declaration.getModuleSpecifierValue();

    if (specifier.length === 0) {
      sink.diagnostics.push(emptySpecifierDiagnostic(ctx.file, 'imports', line));
      return;
    }

    const facts: DeclarationFacts = {
      specifier,
      typeOnly: isTypeOnlyImport(declaration),
      names: importBindingNames(declaration),
      line: position.line,
      column: position.column,
    };

    recordDeclaration(ctx, sink, 'imports', fileNodeId, aliasPatterns, declaration, facts);
  } catch (cause) {
    sink.diagnostics.push(declarationFailureDiagnostic(ctx.file, 'imports', line, cause));
  }
}

/**
 * Reads one `export … from` declaration — a re-export — and records what it
 * says.
 *
 * A declaration **without** a module specifier is a local export
 * (`export { thing }` re-exporting a local binding) and returns silently: local
 * exports are `./symbols.ts`'s business, recorded through `SymbolNodeData` and
 * `CodeNodeBase.exported`, and a file-to-file edge for one would be a self-loop
 * that says nothing.
 *
 * All five re-export forms are classified explicitly — see
 * {@link classifyReExportForm} — and the classification drives the recorded
 * binding names. The form does not travel on the edge, because
 * {@link CodeEdge} has no payload field; the edge site does, and it is unique
 * per declaration, which is what lets a barrel carrying several re-exports of
 * one module produce one distinct edge each.
 *
 * @param ctx The extractor context.
 * @param sink The collection being filled.
 * @param fileNodeId The re-exporting file's node id.
 * @param aliasPatterns The target project's `paths` patterns.
 * @param declaration The declaration to visit.
 */
function visitExportDeclaration(
  ctx: ExtractorContext,
  sink: ExtractionSink,
  fileNodeId: string,
  aliasPatterns: readonly string[],
  declaration: ExportDeclaration,
): void {
  let line = 0;

  try {
    const specifier = declaration.getModuleSpecifierValue();

    if (specifier === undefined) {
      return;
    }

    const position = declarationPosition(ctx.sourceFile, declaration);
    line = position.line;

    if (specifier.length === 0) {
      sink.diagnostics.push(emptySpecifierDiagnostic(ctx.file, 'exports', line));
      return;
    }

    const named = declaration.getNamedExports();
    const form = classifyReExportForm(declaration);

    const facts: DeclarationFacts = {
      specifier,
      typeOnly: isTypeOnlyReExport(declaration, named),
      names: reExportBindingNames(form, named),
      line: position.line,
      column: position.column,
    };

    recordDeclaration(ctx, sink, 'exports', fileNodeId, aliasPatterns, declaration, facts);
  } catch (cause) {
    sink.diagnostics.push(declarationFailureDiagnostic(ctx.file, 'exports', line, cause));
  }
}

/* -------------------------------------------------------------------------------------------------
 * The extractor
 * ---------------------------------------------------------------------------------------------- */

/**
 * Extracts the module graph of one file.
 *
 * Emission order is source order — the import declarations as written, then the
 * re-exports as written — and every value is derived from the abstract syntax
 * tree and the project's module resolution alone. Two runs over unchanged
 * source therefore produce deeply equal, identically ordered output, which is
 * the property `../indexer.ts` turns into a byte-identical serialised index.
 *
 * The `file` node is always emitted for a file with a safe project-relative
 * path, whatever the scan found: a module with no imports at all is still the
 * anchor every other extractor's `declares` edges point at. Its payload is
 * complete — the extension as the loader judged it, the client-module
 * directive, and every specifier that did not become an edge.
 *
 * Never throws. Per-declaration guards contain a malformed construct to the one
 * relation it describes, and an outer guard turns anything they missed into a
 * diagnostic while still emitting the node.
 *
 * @param ctx The file being visited and the project it belongs to.
 * @returns The file node, the `imports` and `exports` edges, and any findings.
 */
function extract(ctx: ExtractorContext): ExtractorResult {
  if (!isSafeRelativePath(ctx.file)) {
    return { nodes: NO_NODES, edges: NO_EDGES, diagnostics: [unsafeContextPathDiagnostic()] };
  }

  const sink: ExtractionSink = {
    edges: [],
    diagnostics: [],
    externalImports: [],
    externalKeys: new Set<string>(),
    edgeIds: new Set<string>(),
  };
  const fileNodeId = fileNodeIdFor(ctx.file);
  let isClientModule = false;

  try {
    isClientModule = hasClientDirective(ctx.sourceFile);

    const aliasPatterns = readAliasPatterns(ctx);

    for (const declaration of ctx.sourceFile.getImportDeclarations()) {
      visitImportDeclaration(ctx, sink, fileNodeId, aliasPatterns, declaration);
    }

    for (const declaration of ctx.sourceFile.getExportDeclarations()) {
      visitExportDeclaration(ctx, sink, fileNodeId, aliasPatterns, declaration);
    }
  } catch (cause) {
    sink.diagnostics.push(moduleScanDiagnostic(ctx.file, cause));
  }

  const data: FileNodeData = {
    // Lower-cased because that is the form the project loader compared when it
    // judged the file indexable, on a case-insensitive filesystem included.
    extension: extnamePosix(ctx.file).toLowerCase(),
    isClientModule,
    externalImports: sink.externalImports,
  };

  const node: CodeNodeOf<'file'> = {
    id: fileNodeId,
    kind: 'file',
    name: ctx.file,
    file: ctx.file,
    line: FILE_NODE_LINE,
    column: FILE_NODE_COLUMN,
    data,
  };

  // Absent rather than empty for a clean extraction, as the result contract
  // requires, so the indexer does not merge an empty array into the envelope.
  if (sink.diagnostics.length === 0) {
    return { nodes: [node], edges: sink.edges };
  }

  return { nodes: [node], edges: sink.edges, diagnostics: sink.diagnostics };
}

/**
 * The import/export extractor of `@debuggen/code-analysis`.
 *
 * Registered first in `../indexer.ts`'s `DEFAULT_EXTRACTORS`, which is a
 * determinism and diagnostics-ordering choice and nothing more: this extractor
 * reads no other extractor's output and none reads its own, so the order it
 * runs in cannot change what any of them produces.
 *
 * Frozen, because it is a module-level singleton that the indexer, the tests
 * and any caller assembling a custom extractor list all share.
 *
 * @example
 * ```ts
 * const result = importsExtractor.extract({
 *   loaded,
 *   sourceFile,
 *   file: 'src/widgets/index.ts',
 *   projectRoot: loaded.projectRoot,
 *   logger: noopLogger,
 * });
 * ```
 */
export const importsExtractor: Extractor = Object.freeze({
  id: IMPORTS_EXTRACTOR_ID,
  extract,
});
