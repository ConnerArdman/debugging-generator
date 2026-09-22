/**
 * The function-timing transform: the module that rewrites **one named symbol**
 * in a target project's file so its execution is timed, and that records the
 * position a resulting span will carry back to source.
 *
 * This is the one signal the product cannot obtain from a runtime hook. Every
 * other signal AAP §0.5.1 enumerates — interactions, React commits and state,
 * fetch and XHR, performance entries, incoming HTTP, route handlers, Prisma and
 * `pg` queries — arrives through an observer or an OpenTelemetry
 * instrumentation that touches nothing on disk. Timing *an arbitrary function
 * the plan named* has no such hook, so a plan whose `mode` is `'patch'` reaches
 * here, and what this module emits is the only code the product ever writes
 * into a developer's working tree.
 *
 * ## What this module does not do
 *
 * **It performs no I/O.** It reads text it is handed (or text it reads out of a
 * ts-morph `Project` the caller already built), parses a private in-memory copy
 * of it, and returns a *string* plus metadata. It never opens, writes, renames
 * or deletes a file, and it never calls ts-morph's `save`/`saveSync`.
 *
 * That boundary is not tidiness, it is the reversibility guarantee. AAP §0.5.1
 * fixes the order in which a patch is committed: read the original and hash it,
 * **produce the patched content in memory and hash that**, copy the original to
 * the backup store and `fsync`, journal a `pending` record carrying *both*
 * hashes, then write atomically and mark the record `applied`. `./patcher.ts`
 * owns that sequence, and `../cleanup.ts` reconciles against the
 * `instrumentedHash` the journal recorded *before* the write. A transform that
 * wrote its own output would skip the backup and the journal entry, and the
 * file it left behind would be one reconciliation could not classify.
 *
 * Two consequences follow for callers, and both are contractual:
 *
 * - **The output is deterministic.** The same original text and the same target
 *   produce byte-identical patched text, on every machine and in every process.
 *   Nothing here reads a clock, mints an id, consults the environment or
 *   iterates an unordered collection; the one generated identifier is derived
 *   from a fixed base name and, when it must be disambiguated, from a scan of
 *   the target declaration in source order. `instrumentedHash` is persisted
 *   before the write and is the value a restore is authorised against, so
 *   nondeterminism here would not produce a wrong span — it would produce a
 *   file the product declines to restore.
 * - **Nothing is decided twice.** The emitted text comes from
 *   `./wrap-template.js`, which owns every marker, identifier and branch this
 *   product injects. This module decides *where* the wrapper goes and *what
 *   shape* the target has; it never re-spells `__DEBUGGEN__`, the helper type's
 *   name or the guard, because `scripts/check-no-residual-instrumentation.mjs`
 *   greps for the template's two marker literals and a second spelling would
 *   escape that gate.
 *
 * ## The rewrite, in one picture
 *
 * The original body is moved into an **inner function declared inside the
 * original**, and the original body becomes the wrapper. The outer function
 * keeps its own parameter list, so arity, destructuring patterns, parameter
 * defaults, type parameters, the return-type annotation and the `async`,
 * `export` and `default` modifiers are all exactly what they were:
 *
 * ```ts
 * // before
 * export async function handle(request: Request): Promise<Response> {
 *   return respond(await load(request));
 * }
 *
 * // after
 * export async function handle(request: Request): Promise<Response> {
 *   async function __orig() {
 *   return respond(await load(request));
 * }
 *   // Debug Generator: temporary instrumentation, removed when the session ends.
 *   // The guard tests helper availability, never its result, so the body runs exactly once.
 *   const __dbg = (globalThis as { __DEBUGGEN__?: __DebuggenSpanHelper }).__DEBUGGEN__;
 *   if (__dbg && typeof __dbg.span === "function") return __dbg.span("handle", { file: "app/handler.ts", line: 4, column: 22, symbol: "handle" }, () => __orig.apply(undefined, arguments as never));
 *   return __orig.apply(undefined, arguments as never);
 * }
 * ```
 *
 * The moved body is embedded **verbatim, without re-indentation**, and that is
 * a deliberate choice with two reasons behind it. Re-indenting would rewrite
 * every line of the developer's function, so the unified diff recorded on the
 * modification record — the diff shown in the editor's modifications list —
 * would claim the whole body changed when only its surroundings did. Worse, it
 * would silently edit the *contents* of any multi-line template literal in that
 * body, because whitespace inside a template literal is part of the string. A
 * transform whose stated purpose is to change nothing about what a function
 * does cannot afford to rewrite its strings to look tidier.
 *
 * ## Arrow functions take the other template
 *
 * An arrow function binds no `arguments`, so forwarding through `arguments`
 * would be a syntax error inside it. Arrow targets therefore use the template's
 * `'rest'` call style: the **wrapper stays an arrow**, takes a rest parameter,
 * and forwards it to an inner arrow that holds the original head — modifiers,
 * type parameters, parameter list, return type — verbatim. Keeping the wrapper
 * an arrow is what preserves lexical `this` and what keeps a callback that was
 * passed *by reference* to `Array.prototype.map` or `Array.prototype.sort`
 * behaving identically, positional arguments and all. An expression body is
 * normalised to a `return` of that expression inside the inner arrow, wrapped
 * in parentheses so no comma expression, object literal or automatic semicolon
 * insertion can change its meaning.
 *
 * ## The position is recorded here, before anything moves
 *
 * AAP §0.4.2 gives the patch route its authority from exactly one fact: the
 * file, line and column a function span carries were recorded **when the patch
 * was applied**, by the code that applied it. This module reads them from the
 * pre-rewrite abstract syntax tree and emits them as a literal, so
 * `packages/telemetry`'s span helpers can mint the only `SourceLocation` in the
 * product with `resolvedBy: 'patch'` without resolving anything at run time.
 * Reading them afterwards would yield lines shifted by the wrapper, and nothing
 * anywhere would fail — the developer would simply be sent to the wrong line.
 *
 * The coordinates are the **name identifier's** 1-based line and column, and
 * `endLine` is the last line of the whole declaration. That is not an arbitrary
 * anchor: it is character-for-character the anchor
 * `packages/code-analysis/src/extractors/symbols.ts` records for the same
 * declaration, so the `'patch'` route and the `'code-graph'` route agree on
 * where a symbol is instead of disagreeing by a column.
 *
 * ## Cost, and why a caller should inject a project
 *
 * Opening a target project with ts-morph is expensive — it reads a
 * `tsconfig.json`, resolves a file set and builds a compiler program — and this
 * module never does it. Given text, it parses one private in-memory source file
 * and nothing else. A caller that already holds a `Project` (the service holds
 * one through `@debuggen/code-analysis`'s project handle, whose `project`
 * property is exactly this) should pass it as
 * {@link FunctionTimingPatcherOptions.project}, where it is used **only** to
 * look the original text up. The rewrite always runs against a private copy, so
 * no injected project is ever mutated and no developer's buffer can be
 * corrupted by a transform that was only asked to compute a string.
 *
 * @module packages/instrumentation/src/patch/function-timing
 */

import { Node, Project, ScriptKind, SyntaxKind, ts } from 'ts-morph';
import type {
  ArrowFunction,
  ClassDeclaration,
  ClassExpression,
  CommentRange,
  FunctionDeclaration,
  FunctionExpression,
  GetAccessorDeclaration,
  Identifier,
  MethodDeclaration,
  ParameterDeclaration,
  PropertyDeclaration,
  SourceFile,
  Statement,
} from 'ts-morph';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  DebuggenError,
  err,
  extnamePosix,
  isSafeRelativePath,
  joinPosix,
  noopLogger,
  normalizePosix,
  ok,
  parseSourceLocation,
  toPosix,
  toProjectRelative,
} from '@debuggen/shared';
import type { Logger, Result, SourceLocation } from '@debuggen/shared';

import type { InstrumentationAction } from '../schema/plan.js';

import {
  HELPER_LOCAL_IDENTIFIER,
  HELPER_TYPE_ALIAS_TEXT,
  INNER_FUNCTION_IDENTIFIER,
  REST_PARAMETER_IDENTIFIER,
  SPAN_HELPER_GLOBAL,
  SPAN_HELPER_TYPE_NAME,
  buildWrapperBody,
  detectArgumentsHazard,
  isDirectivePrologueLiteral,
  isStrictModeDirective,
  needsHelperTypeAlias,
  resolvePatchLanguage,
} from './wrap-template.js';
import type {
  ArgumentsHazard,
  ArgumentsHazardFacts,
  PatchLanguage,
  PatchSpanMeta,
  WrapperBody,
  WrapperCallStyle,
  WrapperReceiver,
} from './wrap-template.js';

/**
 * The declaration shapes this transform can wrap, which is the closed set of
 * forms a named, body-carrying function takes at module scope or on a class.
 *
 * - `'function-declaration'` — `function f() {}`, including `export function`,
 *   `export async function` and `export default function f`. An exported route
 *   handler is this shape and nothing more: it is recognised **structurally**,
 *   by being an exported function declaration in the module the plan named, and
 *   never by matching a route path (AAP §0.5.4).
 * - `'function-expression'` — `const f = function () {}`, and the same as a
 *   class property initialiser. Binds `arguments` and a dynamic `this`, so it
 *   takes the same template as a declaration.
 * - `'arrow-function'` — `const f = (a, b) => …`, expression- or block-bodied,
 *   and the same as a class property initialiser. Binds neither `arguments` nor
 *   its own `this`, so it takes the rest-parameter template.
 * - `'method'` — a class method. Its `this` is the instance, which the
 *   template's `'this'` receiver forwards.
 *
 * Frozen because it is vocabulary rather than state, and exported so a caller
 * or a test can enumerate the shapes instead of restating them.
 */
export const PATCH_TARGET_SHAPES = Object.freeze([
  'function-declaration',
  'function-expression',
  'arrow-function',
  'method',
] as const);

/** One member of {@link PATCH_TARGET_SHAPES}. */
export type PatchTargetShape = (typeof PATCH_TARGET_SHAPES)[number];

/**
 * What each text edit in a patch is for.
 *
 * A patch is at most two edits, and never more: the rewrite of the target, and
 * — at most once per file — the insertion of the helper type alias. Nothing
 * else in the file is touched, which is what makes the recorded diff readable
 * and what keeps a banner comment, an import order and every byte outside the
 * patched node exactly as the developer wrote them.
 */
export const PATCH_EDIT_PURPOSES = Object.freeze([
  'function-body',
  'function-declaration',
  'helper-type-alias',
] as const);

/** One member of {@link PATCH_EDIT_PURPOSES}. */
export type PatchEditPurpose = (typeof PATCH_EDIT_PURPOSES)[number];

/**
 * Qualified spellings this module accepts for a class member, in addition to
 * the bare member name.
 *
 * `packages/code-analysis/src/extractors/symbols.ts` records a class member
 * under its **bare** name with the owning class in a separate `container`
 * field, so a plan's `symbol` is normally just `'settleSegments'`. The
 * qualified spellings exist for the case a bare name cannot address: two
 * classes in one module that declare a member of the same name, which is
 * otherwise an ambiguous target and therefore a refusal.
 *
 * Accepted: `'method'`, `'Class.method'`, `'Class#method'` and
 * `'Class.prototype.method'`. Anything else — a deeper path, an empty segment —
 * is refused rather than guessed at.
 */
export const QUALIFIED_SYMBOL_SEPARATORS = Object.freeze(['.', '#'] as const);

/**
 * The segment a `'Class.prototype.method'` spelling carries in the middle,
 * which is dropped when the spelling is parsed.
 */
const PROTOTYPE_SEGMENT = 'prototype';

/**
 * How many disambiguating suffixes this module will try before refusing to
 * allocate an identifier.
 *
 * Reaching the bound means the target declaration already binds `__orig`,
 * `__orig_1` … `__orig_64` (or the equivalent for the helper local or the rest
 * parameter), which is not a file this transform should keep guessing about.
 * A refusal at that point is a refusal to touch the developer's file.
 */
const MAX_IDENTIFIER_SUFFIX = 64;

/**
 * The directory the private in-memory copies are created under.
 *
 * In-memory and never written, so the prefix only has to be a path that cannot
 * collide with a real one; the target's project-relative path is appended to
 * it so two files of the same base name stay distinct within one patcher.
 */
const SCRATCH_ROOT = '/__debuggen_patch__';

/** The directory the re-parse verification copy is created under. */
const VERIFY_ROOT = '/__debuggen_verify__';

/** The directory the receiver-typing pre-flight's copies are created under. */
const TYPE_VERIFY_ROOT = '/__debuggen_typecheck__';

/**
 * The compiler options the private in-memory project is built with.
 *
 * Parsing-only, deliberately: `noLib` and `noResolve` keep the project from
 * loading library files or resolving a single import, because this module asks
 * the compiler exactly two questions — what is the shape of this declaration,
 * and does the text I produced still parse — and neither needs a type. Keeping
 * them off is also what makes the per-patch path cheap enough that a caller
 * does not have to think about it.
 *
 * `allowJs` with `checkJs` off admits the `.js` and `.jsx` targets a real
 * project contains without asking the compiler to type-check them, and
 * `jsx: Preserve` matches what a Next.js project declares, so JSX in a `.tsx`
 * or `.jsx` target parses as JSX rather than as a comparison.
 */
const SCRATCH_COMPILER_OPTIONS = Object.freeze({
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  noLib: true,
  noResolve: true,
  target: ts.ScriptTarget.ESNext,
});

/**
 * The compiler options the receiver-typing pre-flight's project is built with.
 *
 * A **second** configuration rather than a relaxation of
 * {@link SCRATCH_COMPILER_OPTIONS}, because the two ask different questions.
 * The parse path must stay `noLib`/`noResolve` — it needs a syntax tree and
 * nothing else, and that is what keeps it cheap. This path asks whether the
 * `this` annotation the transform *wrote* type-checks, which cannot be answered
 * without the library files: `strictBindCallApply` (part of `strict`) is what
 * makes `__orig.apply(this, …)` check the receiver at all, and it lives in
 * `lib.es*.d.ts`.
 *
 * - `strict` because the developer's project is expected to be strict and
 *   because the two diagnostics the emitted annotation exists to avoid —
 *   `noImplicitThis` and `strictBindCallApply` — are both inside it. A
 *   non-strict target project simply reports fewer diagnostics, and the
 *   comparison is against the *same* configuration on both sides either way.
 * - `lib`/`target` ES2023 to match `tsconfig.base.json`, which is the floor
 *   this product's own code and the projects it patches are written against.
 * - `noResolve` because an import must not drag a dependency tree into an
 *   in-memory project; the unresolved-import noise that follows appears
 *   identically in both programs and cancels in the delta — measured as the
 *   same single `TS2307` before and after the patch.
 * - `noEmit` because nothing here is compiled; only diagnostics are read.
 */
const TYPE_VERIFY_COMPILER_OPTIONS = Object.freeze({
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  lib: ['lib.es2023.d.ts'],
  noEmit: true,
  noResolve: true,
  strict: true,
  target: ts.ScriptTarget.ES2023,
});

/**
 * How many introduced diagnostics an introduced-diagnostic refusal carries.
 *
 * Bounded because `details` travels into a log line and a user interface: the
 * first few name the problem, and a file whose patch introduces dozens of type
 * errors is refused for the same reason whether the caller can read all of them
 * or not.
 */
const MAX_REPORTED_DIAGNOSTICS = 4;

/**
 * How a {@link FunctionTimingPatcher} is configured.
 *
 * Every field is optional, because the transform's only genuine inputs are a
 * target and some text. The options exist to let a long-lived caller — the
 * service's instrumentation module, which patches several files during one
 * install — share a project handle and a logger across every patch instead of
 * rebuilding them.
 */
export interface FunctionTimingPatcherOptions {
  /**
   * The project root every target path is interpreted against: absolute, POSIX
   * separators.
   *
   * When it is given, a target `file` may be absolute (and is reduced with
   * `toProjectRelative` from `@debuggen/shared`) or already project-relative,
   * and it must resolve **inside** the root — an absolute path elsewhere or a
   * `'..'` escape is refused with `PATH_OUTSIDE_PROJECT` rather than emitted
   * into a source location that would later travel to the editor as a
   * click-to-source request.
   *
   * When it is absent, a target `file` must already be a safe project-relative
   * POSIX path, and {@link FunctionTimingPatcherOptions.project} can only be
   * consulted for text under the path as written.
   */
  readonly projectRoot?: string | undefined;

  /**
   * Where this module's diagnostics go. Defaults to `noopLogger`.
   *
   * Used for two `debug` lines per patch — what was resolved, and what was
   * emitted — and a `warn` when an identifier had to be disambiguated. Refusals
   * are returned rather than logged: the caller is about to decide whether to
   * touch a file and must not have to read a log to find out that it should
   * not.
   */
  readonly logger?: Logger | undefined;

  /**
   * A ts-morph project to read original text out of, for a caller that already
   * has the target project open.
   *
   * **Consulted only when a request carries no `text`,** and only ever read
   * from: the rewrite runs against a private in-memory copy whose script kind
   * this module derives from the target's extension, so the answer does not
   * depend on how the injected project was configured and the injected project
   * is never modified.
   *
   * Passing one is the recommended shape for a caller that patches more than a
   * single file — `@debuggen/code-analysis`'s loaded-project handle exposes
   * exactly this object — because building a project is the expensive part of
   * the whole operation and this module will never build one itself.
   */
  readonly project?: Project | undefined;

  /**
   * Whether to re-parse the emitted text and refuse it if the parse reports a
   * syntax error. Defaults to `true`.
   *
   * On by default because of what the output is *for*: the next step in the
   * sequence writes it over a file in a running developer's project, where a
   * syntax error is an application that stops compiling. Re-parsing costs one
   * more parse of one file and turns the worst failure this module could have
   * into a refusal that touches nothing. Turn it off only in a benchmark.
   */
  readonly verifyPatchedSyntax?: boolean | undefined;

  /**
   * Whether to **type-check** the emitted text for the receiver-typing errors
   * the wrapper's `this` annotation could introduce, and refuse it if it does.
   * Defaults to `true`, and applies to TypeScript targets only.
   *
   * On by default for the same reason as
   * {@link FunctionTimingPatcherOptions.verifyPatchedSyntax}, one level up: a
   * text that parses can still break the developer's build, and a syntax-only
   * check cannot see it — the parse path runs with `noLib` and `noResolve`
   * precisely so that it stays cheap. This check builds a second, lib-loaded
   * in-memory project and compares *every* semantic diagnostic of the original
   * text against those of the patched text under the same configuration,
   * refusing on any difference. It never alters the patch, so the emitted
   * bytes — and therefore `instrumentedHash` — are identical whether it runs or
   * not.
   *
   * Costs one type-check of one file per patch, twice (20–110 ms per program as
   * measured on this product's own fixtures), which is why it is a flag: turn it
   * off in a benchmark, or in a caller that type-checks the result itself.
   */
  readonly verifyPatchedTypes?: boolean | undefined;
}

/**
 * One target to patch.
 *
 * The minimum is a file and a symbol; `text` and `action` are the two ways a
 * caller supplies what it already knows.
 */
export interface FunctionTimingRequest {
  /**
   * The target file: project-relative POSIX, or absolute inside
   * {@link FunctionTimingPatcherOptions.projectRoot} when one was configured.
   *
   * Its extension decides the emitted syntax — see `resolvePatchLanguage` in
   * `./wrap-template.js` — and an extension this product cannot patch is
   * refused rather than guessed at.
   */
  readonly file: string;

  /**
   * The symbol to wrap, spelled exactly.
   *
   * Exact-name resolution, never fuzzy: a target that matches no declaration
   * and a target that matches more than one are both refusals, because a
   * transform that guessed which function a plan meant would instrument the
   * wrong one and report a source location that looked authoritative. Class
   * members accept the qualified spellings of
   * {@link QUALIFIED_SYMBOL_SEPARATORS} as well as the bare member name.
   */
  readonly symbol: string;

  /**
   * The file's current text.
   *
   * Supply it wherever the caller has it — `./patcher.ts` has just read and
   * hashed the bytes it is about to replace, and passing them guarantees the
   * transform describes *those* bytes rather than whatever is on disk a moment
   * later. When it is omitted, the text is read from
   * {@link FunctionTimingPatcherOptions.project}; when there is no project
   * either, the request is refused with `PATCH_TARGET_NOT_FOUND`.
   *
   * Text that already carries an earlier patch is expected and handled: the
   * helper type alias is inserted at most once per file, so patching a second
   * symbol in an already-patched file adds no duplicate. Patching the **same**
   * symbol twice is refused instead — see this module's rejection reasons.
   */
  readonly text?: string | undefined;

  /**
   * The plan action this patch installs, for provenance.
   *
   * Accepted because it is what the installer holds: an action's `type` is
   * `'function-timing'` or `'server-span'`, and both reduce to the same wrap
   * for a named symbol — a server span *is* a function timing on a route
   * handler. Only `id` is carried into the result, as
   * {@link FunctionTimingPatch.actionId}; `file` and `symbol` are taken from
   * the request's own fields so a caller cannot state one target and patch
   * another. Use {@link FunctionTimingPatcher.patchAction} to build a request
   * from an action directly.
   */
  readonly action?: InstrumentationAction | undefined;

  /**
   * Overrides the emitted span name, which defaults to the target's bare
   * declared name.
   *
   * The default matches the name the code graph records, which is what the
   * service matches a span back against. An adapter that wants a qualified
   * label for a class member can pass `'Class.member'` here; the recorded
   * source location is unaffected either way.
   */
  readonly spanName?: string | undefined;
}

/**
 * One replacement in the original text, as a half-open character range and the
 * text that takes its place.
 *
 * Returned so a caller can see — and a test can assert — that a patch is
 * confined to the region it claims. `./patcher.ts` does not need them to write
 * the file (it writes {@link FunctionTimingPatch.patchedText} whole), but they
 * are what makes "everything outside the patched node is byte-identical" a
 * checkable statement rather than a promise.
 */
export interface PatchEdit {
  /** The 0-based character offset the replaced range starts at, inclusive. */
  readonly start: number;

  /** The 0-based character offset the replaced range ends at, exclusive. */
  readonly end: number;

  /** The text written in place of `[start, end)`. */
  readonly replacement: string;

  /** What this edit is for. */
  readonly purpose: PatchEditPurpose;
}

/**
 * The result of a successful patch: the text to write, and everything
 * `./patcher.ts` needs to journal it.
 *
 * Nothing in here has been written anywhere. The caller decides whether to
 * commit it, and owns the backup, the journal entry and the atomic replacement
 * if it does.
 */
export interface FunctionTimingPatch {
  /** The target's project-relative POSIX path, as it was normalised. */
  readonly file: string;

  /**
   * The bare declared name of the symbol that was wrapped — the name the code
   * graph records, and the value emitted as `meta.symbol`.
   */
  readonly symbol: string;

  /** The owning class's name for a class member, `undefined` otherwise. */
  readonly container: string | undefined;

  /**
   * `'Class.member'` for a class member, the bare name otherwise.
   *
   * A label, not an identity: the identity of a patched function is its file
   * and position, which is what {@link FunctionTimingPatch.location} carries.
   */
  readonly qualifiedName: string;

  /** The span name that was emitted, defaulting to the bare declared name. */
  readonly spanName: string;

  /** The declaration shape that was recognised. */
  readonly shape: PatchTargetShape;

  /** The text exactly as it was handed in, unchanged. */
  readonly originalText: string;

  /**
   * The text to write. Byte-identical for identical inputs, which is what lets
   * `./patcher.ts` hash it as `instrumentedHash` before the write and
   * `../cleanup.ts` compare a file against that hash afterwards.
   */
  readonly patchedText: string;

  /**
   * The edits that produced it, in ascending position order and
   * non-overlapping.
   */
  readonly edits: readonly PatchEdit[];

  /**
   * The position recorded for the wrapped symbol: project-relative POSIX file,
   * the name identifier's 1-based line and column, the declaration's last line
   * as `endLine`, `resolvedBy: 'patch'` and the confidence
   * `DEFAULT_RESOLUTION_CONFIDENCE.patch` states for this route.
   *
   * Validated through `parseSourceLocation` before it is returned, so a caller
   * never has to re-check it and a malformed one is a refusal rather than a
   * location that fails later at a process boundary.
   */
  readonly location: SourceLocation;

  /**
   * The four values emitted as the wrapper's `meta` argument, built from the
   * same numbers as {@link FunctionTimingPatch.location} so the two cannot
   * disagree.
   */
  readonly meta: PatchSpanMeta;

  /** The syntax that was emitted, decided by the target's extension. */
  readonly language: PatchLanguage;

  /** How the wrapper forwards its arguments to the inner function. */
  readonly callStyle: WrapperCallStyle;

  /** What the wrapper passes as the inner function's receiver. */
  readonly receiver: WrapperReceiver;

  /** The inner function's identifier, disambiguated if the target bound it. */
  readonly innerIdentifier: string;

  /** The helper local's identifier, disambiguated if the target bound it. */
  readonly helperIdentifier: string;

  /**
   * The rest parameter's identifier for an arrow target, `undefined` for every
   * other shape.
   */
  readonly restIdentifier: string | undefined;

  /**
   * Whether this patch inserted the helper type alias.
   *
   * `false` for a JavaScript target, which needs none, and `false` for a
   * TypeScript file that already carries one — a second symbol in the same
   * file, or a second plan version patching it again.
   */
  readonly helperTypeAliasInserted: boolean;

  /** The plan action's id when one was supplied, `undefined` otherwise. */
  readonly actionId: string | undefined;
}

/**
 * The function-like nodes this transform can rewrite.
 *
 * Deliberately not `FunctionLikeDeclaration`: that union also admits
 * constructors, accessors and function types, each of which this module
 * refuses for its own stated reason.
 */
type PatchableFunctionNode =
  ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

/** A resolved target: one declaration this module knows how to wrap. */
interface ResolvedTarget {
  /** Which of the four shapes it is. */
  readonly shape: PatchTargetShape;

  /** The function-like node whose body moves. */
  readonly fn: PatchableFunctionNode;

  /**
   * That function's body: a block for the three `arguments`-style shapes, and
   * either a block or the single expression for an arrow.
   *
   * Captured at resolution time because a body is what makes a declaration a
   * target at all: an overload signature, an ambient declaration and an
   * abstract method have none and are refused before they become a resolved
   * target, so every consumer of this field has a body without re-checking for
   * one.
   */
  readonly body: Node;

  /**
   * The name identifier the recorded position points at — a declaration's or
   * method's name node, or the variable/property the function is assigned to.
   */
  readonly nameNode: Node;

  /**
   * The whole declaration, used for `endLine`, for the identifier-collision
   * scan and for the indentation of the emitted wrapper. For an assigned
   * function this is the variable or property declaration, not the function.
   */
  readonly declaration: Node;

  /** The bare declared name. */
  readonly declaredName: string;

  /** The owning class's name for a class member, `undefined` otherwise. */
  readonly container: string | undefined;
}

/** Why this module declines to wrap a declaration it did resolve. */
interface Refusal {
  /**
   * A stable machine-readable reason, carried as `details.reason` on the
   * returned error. The spellings this module uses are, in the order the checks
   * run: `'file-not-found'`, `'symbol-not-found'`, `'ambiguous-symbol'`,
   * `'unsupported-declaration'`, `'unsupported-accessor'`,
   * `'unsupported-constructor'`, `'unsupported-generator'`,
   * `'unsupported-async-generator'`, `'unsupported-super-reference'`,
   * `'unsupported-new-target'`, `'unsupported-mapped-arguments'`,
   * `'unsupported-arguments-callee'`, `'unsupported-direct-eval'`,
   * `'already-instrumented'`, `'identifier-unavailable'`,
   * `'malformed-symbol'`, `'unsupported-polymorphic-this'`,
   * `'unsupported-anonymous-class'`, `'overlapping-edits'`,
   * `'invalid-syntax'` and `'unsupported-introduced-diagnostic'`.
   *
   * Six of them are the ones a *semantics-preserving* wrapper cannot be
   * emitted for: the three `arguments` spellings come from
   * {@link detectArgumentsHazard} and cover a sloppy-mode body whose mapped
   * arguments object the move would rebind; the two `this` spellings come from
   * the receiver-typing rules and cover a receiver that cannot be named in the
   * inner function's signature; and `'unsupported-introduced-diagnostic'` is
   * the semantic pre-flight reporting that the emitted text would add a
   * compiler diagnostic the target file does not already have.
   *
   * `../feasibility.ts` gates most of these upstream against the code graph and
   * owns its own rejection vocabulary; the overlapping spellings are
   * intentional so the two agree in a log, and this module still checks every
   * one of them because it is the last thing to look at the declaration before
   * a file would be written.
   */
  readonly reason: string;

  /** A complete sentence naming what cannot be wrapped. */
  readonly message: string;

  /** The developer-facing next step, where one applies. */
  readonly hint: string | undefined;
}

/** One candidate found while resolving a symbol to a declaration. */
interface Candidate {
  /** The bare declared name, which matched the requested symbol. */
  readonly declaredName: string;

  /** The owning class's name when the candidate is a class member. */
  readonly container: string | undefined;

  /** The whole declaration, for diagnostics and for ordering. */
  readonly declaration: Node;

  /** Set when the candidate is a form this module can wrap. */
  readonly target: ResolvedTarget | undefined;

  /** Set when the candidate is a form this module refuses, with the reason. */
  readonly refusal: Refusal | undefined;
}

/** A parsed `symbol` spelling: a bare member name and an optional container. */
interface SymbolSpelling {
  /** The bare declared name to match. */
  readonly name: string;

  /** The class name the spelling qualified the member with, if any. */
  readonly container: string | undefined;
}

/**
 * The transform, as an injectable object.
 *
 * Holds no per-patch state: {@link FunctionTimingPatcher.patch} is a pure
 * function of its request and the configured options, and two calls with the
 * same request return the same bytes. The only thing the instance keeps is the
 * private in-memory project the parses run in, which exists so that patching
 * twenty files during one install parses twenty files instead of building
 * twenty projects.
 *
 * @example Patching one symbol from text the caller already read
 * ```ts
 * const patcher = new FunctionTimingPatcher({ projectRoot: '/home/dev/app' });
 * const patched = patcher.patch({
 *   file: 'src/server/load.ts',
 *   symbol: 'loadThings',
 *   text: original,
 * });
 * if (!patched.ok) {
 *   return patched; // nothing has been written; abort the patch
 * }
 * const instrumentedHash = sha256Hex(patched.value.patchedText);
 * ```
 */
export class FunctionTimingPatcher {
  /** The configured project root in POSIX form, or `undefined`. */
  readonly #projectRoot: string | undefined;

  /** Where diagnostics go; `noopLogger` when the caller supplied none. */
  readonly #logger: Logger;

  /** The caller's project, read from only when a request carries no text. */
  readonly #project: Project | undefined;

  /** Whether the emitted text is re-parsed before it is returned. */
  readonly #verifyPatchedSyntax: boolean;

  /** Whether the emitted text is type-checked before it is returned. */
  readonly #verifyPatchedTypes: boolean;

  /**
   * The private in-memory project, built on first use.
   *
   * Lazy so that constructing a patcher costs nothing, and reused so that the
   * per-patch cost is one parse. Every source file it holds is created with
   * `overwrite` and removed again before the patch returns, so the project
   * never accumulates state that could make one patch depend on another.
   */
  #scratch: Project | undefined;

  /**
   * The private **lib-loaded** project the receiver-typing pre-flight runs in,
   * built on first use and then reused.
   *
   * Separate from {@link FunctionTimingPatcher.#scratch} because the two are
   * configured for different questions — see
   * {@link TYPE_VERIFY_COMPILER_OPTIONS} — and lazy because a caller that
   * patches only JavaScript files, or that turns the check off, must not pay for
   * loading the library files at all. Its files are created with `overwrite` and
   * removed again in a `finally`, exactly as the parse project's are.
   */
  #typeScratch: Project | undefined;

  /**
   * @param options See {@link FunctionTimingPatcherOptions}. Every field is
   * optional; the defaults are no project root, `noopLogger`, no injected
   * project, and syntax and receiver-typing verification both on.
   */
  constructor(options: FunctionTimingPatcherOptions = {}) {
    this.#projectRoot =
      options.projectRoot === undefined ? undefined : toPosix(options.projectRoot);
    this.#logger = options.logger ?? noopLogger;
    this.#project = options.project;
    this.#verifyPatchedSyntax = options.verifyPatchedSyntax ?? true;
    this.#verifyPatchedTypes = options.verifyPatchedTypes ?? true;
    this.#scratch = undefined;
    this.#typeScratch = undefined;
  }

  /** The configured project root, in POSIX form, or `undefined`. */
  get projectRoot(): string | undefined {
    return this.#projectRoot;
  }

  /**
   * Computes the patched text and metadata for one target.
   *
   * Writes nothing, anywhere. Never throws: an expected failure — a path
   * outside the project, a symbol that resolves to no declaration or to
   * several, a form this transform cannot wrap — comes back as `err` with a
   * coded {@link DebuggenError}, and an unexpected one is caught and re-coded
   * as `'INTERNAL'` rather than escaping into the middle of a caller's write
   * sequence.
   *
   * @param request The target, and the text or project to read it from.
   * @returns `ok(patch)` with text to write and the position to record, or
   * `err(error)` whose `details.reason` names why nothing may be written. See
   * {@link Refusal.reason} for the reason vocabulary.
   */
  patch(request: FunctionTimingRequest): Result<FunctionTimingPatch> {
    try {
      return this.#patch(request);
    } catch (cause) {
      return err(
        new DebuggenError(
          'INTERNAL',
          'The function-timing transform failed unexpectedly, so nothing was patched.',
          {
            details: {
              reason: 'transform-failed',
              file: request.file,
              symbol: request.symbol,
            },
            hint: 'Report this with the file and symbol; the target project was not modified.',
            cause,
          },
        ),
      );
    }
  }

  /**
   * {@link FunctionTimingPatcher.patch} for a plan action.
   *
   * The action's `file` and `symbol` become the target and its `id` is carried
   * into the result, which is what the installer needs to link the resulting
   * modification record back to the action that caused it. Both
   * `'function-timing'` and `'server-span'` actions arrive here: a server span
   * is a function timing on a route handler, and the wrap is the same.
   *
   * @param action The action to install.
   * @param text The file's current text, or `undefined` to read it from the
   * configured project.
   * @returns The same result as {@link FunctionTimingPatcher.patch}.
   */
  patchAction(action: InstrumentationAction, text?: string): Result<FunctionTimingPatch> {
    return this.patch({ file: action.file, symbol: action.symbol, text, action });
  }

  /** The private in-memory project, created on first use. */
  #scratchProject(): Project {
    this.#scratch ??= new Project({
      useInMemoryFileSystem: true,
      skipLoadingLibFiles: true,
      compilerOptions: { ...SCRATCH_COMPILER_OPTIONS },
    });

    return this.#scratch;
  }

  /**
   * The private lib-loaded project the receiver-typing pre-flight runs in,
   * created on first use.
   *
   * The library files are loaded — the one difference from
   * {@link FunctionTimingPatcher.#scratchProject} that matters — because
   * `strictBindCallApply` is what checks the receiver `__orig.apply(this, …)`
   * forwards, and it cannot check anything without `Function.prototype.apply`'s
   * declared signature.
   */
  #typeProject(): Project {
    this.#typeScratch ??= new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { ...TYPE_VERIFY_COMPILER_OPTIONS },
    });

    return this.#typeScratch;
  }

  /**
   * Reduces a requested path to a project-relative POSIX path, or refuses it.
   *
   * @param file The path as the request spelled it.
   * @returns The project-relative path, or `err('PATH_OUTSIDE_PROJECT')`.
   */
  #resolveFilePath(file: string): Result<string> {
    const posix = toPosix(file);

    if (this.#projectRoot !== undefined) {
      return toProjectRelative(this.#projectRoot, posix);
    }

    const normalized = normalizePosix(posix);

    if (!isSafeRelativePath(normalized)) {
      return err(
        new DebuggenError(
          'PATH_OUTSIDE_PROJECT',
          'A patch target must be a project-relative POSIX path when the patcher has no project root.',
          {
            details: { reason: 'unsafe-path', file },
            hint: 'Construct the patcher with projectRoot, or pass an already project-relative path.',
          },
        ),
      );
    }

    return ok(normalized);
  }

  /**
   * Obtains the target's current text: the request's own, or the injected
   * project's.
   *
   * @param file The project-relative POSIX path.
   * @param request The request, for its optional `text`.
   * @returns The text, or `err('PATCH_TARGET_NOT_FOUND')` when there is none
   * to read.
   */
  #resolveText(file: string, request: FunctionTimingRequest): Result<string> {
    if (request.text !== undefined) {
      return ok(request.text);
    }

    const project = this.#project;

    if (project !== undefined) {
      const candidatePaths =
        this.#projectRoot === undefined ? [file] : [joinPosix(this.#projectRoot, file), file];

      for (const candidatePath of candidatePaths) {
        const sourceFile = project.getSourceFile(candidatePath);

        if (sourceFile !== undefined) {
          return ok(sourceFile.getFullText());
        }
      }
    }

    return err(
      new DebuggenError(
        'PATCH_TARGET_NOT_FOUND',
        'The target file is not available: the request carried no text and the configured project does not hold it.',
        {
          details: {
            reason: 'file-not-found',
            file,
            hasProject: project !== undefined,
          },
          hint: 'Pass the file contents as request.text, or open the project so it holds the file.',
        },
      ),
    );
  }

  /**
   * The patch pipeline: resolve the path, the language, the spelling and the
   * text, parse a private copy, and rewrite it.
   *
   * Separated from {@link FunctionTimingPatcher.patch} so that the public
   * method is nothing but the never-throws boundary around it.
   *
   * @param request The target to patch.
   * @returns The patch, or the first refusal encountered.
   */
  #patch(request: FunctionTimingRequest): Result<FunctionTimingPatch> {
    const resolvedFile = this.#resolveFilePath(request.file);

    if (!resolvedFile.ok) {
      return resolvedFile;
    }

    const file = resolvedFile.value;
    const language = resolvePatchLanguage(file);

    if (!language.ok) {
      return language;
    }

    const spelling = parseSymbolSpelling(request.symbol);

    if (!spelling.ok) {
      return spelling;
    }

    const originalText = this.#resolveText(file, request);

    if (!originalText.ok) {
      return originalText;
    }

    const scratch = this.#scratchProject();
    const sourceFile = scratch.createSourceFile(joinPosix(SCRATCH_ROOT, file), originalText.value, {
      overwrite: true,
      scriptKind: scriptKindFor(file),
    });

    try {
      return this.#rewrite({
        file,
        language: language.value,
        originalText: originalText.value,
        request,
        sourceFile,
        spelling: spelling.value,
      });
    } finally {
      // The private project is reused across patches, so each parse is removed
      // again: nothing one patch left behind can be read by the next.
      scratch.removeSourceFile(sourceFile);
    }
  }

  /**
   * Resolves the target in a parsed copy and produces the patch.
   *
   * Every step is a refusal point, and each returns before anything is
   * assembled: resolution, supportability, identifier allocation, the template,
   * the source location, the two edits, and the re-parse.
   *
   * @param input The parsed copy and everything resolved about the request.
   * @returns The patch, or the first refusal encountered.
   */
  #rewrite(input: RewriteInput): Result<FunctionTimingPatch> {
    const { file, language, originalText, request, sourceFile, spelling } = input;

    const resolved = resolveTarget(sourceFile, spelling, file);

    if (!resolved.ok) {
      return resolved;
    }

    const target = resolved.value;
    const callStyle: WrapperCallStyle = target.shape === 'arrow-function' ? 'rest' : 'arguments';
    const unsupported = supportRefusal(target, callStyle, file);

    if (unsupported !== undefined) {
      return err(unsupported);
    }

    const identifiers = allocateIdentifiers(target, callStyle, file);

    if (!identifiers.ok) {
      return identifiers;
    }

    if (identifiers.value.disambiguated) {
      this.#logger.warn(
        'Patch identifiers disambiguated: the target already binds a default name',
        {
          file,
          symbol: target.declaredName,
          inner: identifiers.value.inner,
          helper: identifiers.value.helper,
        },
      );
    }

    // Read from the PRE-rewrite tree. Reading after the edits would report the
    // wrapper's shifted lines, and nothing downstream could tell.
    const position = sourceFile.getLineAndColumnAtPos(target.nameNode.getStart());
    const endLine = target.declaration.getEndLineNumber();
    const meta: PatchSpanMeta = {
      file,
      line: position.line,
      column: position.column,
      symbol: target.declaredName,
    };

    const spanName = request.spanName ?? target.declaredName;
    const built = buildWrapperBody({
      language,
      callStyle,
      receiver: resolveReceiver(target, language, callStyle),
      spanName,
      meta,
      innerIdentifier: identifiers.value.inner,
      helperIdentifier: identifiers.value.helper,
      restIdentifier: identifiers.value.rest,
      generator: false,
    });

    if (!built.ok) {
      return built;
    }

    // The same four numbers as `meta`, so the literal in the file and the
    // record in the store can never disagree about where the function is.
    const location = parseSourceLocation({
      file,
      line: position.line,
      column: position.column,
      symbol: target.declaredName,
      endLine,
      resolvedBy: 'patch',
      confidence: DEFAULT_RESOLUTION_CONFIDENCE.patch,
    });

    if (!location.ok) {
      return location;
    }

    const targetEdit = buildTargetEdit(target, originalText, built.value, callStyle, file);

    if (!targetEdit.ok) {
      return targetEdit;
    }

    const aliasText = needsHelperTypeAlias(file)
      ? (built.value.helperTypeAlias ?? HELPER_TYPE_ALIAS_TEXT)
      : undefined;
    const aliasEdit =
      aliasText === undefined || hasHelperTypeAlias(sourceFile)
        ? undefined
        : buildAliasEdit(sourceFile, originalText, aliasText);
    const edits: readonly PatchEdit[] =
      aliasEdit === undefined ? [targetEdit.value] : [aliasEdit, targetEdit.value];
    const patchedText = applyEdits(originalText, edits, file, target.declaredName);

    if (!patchedText.ok) {
      return patchedText;
    }

    if (this.#verifyPatchedSyntax) {
      const invalid = this.#syntaxRefusal(file, patchedText.value, target.declaredName);

      if (invalid !== undefined) {
        return err(invalid);
      }
    }

    // After the syntax check, because text that does not parse has no
    // meaningful semantic diagnostics, and only for TypeScript: a JavaScript
    // target carries no `this` annotation to be wrong about, and `checkJs` is
    // off for the same reason the parse project has it off.
    if (this.#verifyPatchedTypes && language === 'typescript') {
      const mistyped = this.#introducedDiagnosticRefusal(
        file,
        originalText,
        patchedText.value,
        target.declaredName,
      );

      if (mistyped !== undefined) {
        return err(mistyped);
      }
    }

    this.#logger.debug('Function timing patch computed', {
      file,
      symbol: target.declaredName,
      shape: target.shape,
      callStyle,
      line: position.line,
      column: position.column,
      helperTypeAliasInserted: aliasEdit !== undefined,
    });

    return ok({
      file,
      symbol: target.declaredName,
      container: target.container,
      qualifiedName:
        target.container === undefined
          ? target.declaredName
          : `${target.container}.${target.declaredName}`,
      spanName,
      shape: target.shape,
      originalText,
      patchedText: patchedText.value,
      edits,
      location: location.value,
      meta,
      language,
      callStyle,
      receiver: built.value.receiver,
      innerIdentifier: built.value.innerIdentifier,
      helperIdentifier: built.value.helperIdentifier,
      restIdentifier: built.value.restIdentifier,
      helperTypeAliasInserted: aliasEdit !== undefined,
      actionId: request.action?.id,
    });
  }

  /**
   * Re-parses the emitted text and returns a refusal when the parse reports a
   * syntax error.
   *
   * The copy is created under a directory of its own and removed again, so the
   * verification cannot disturb the parse the rewrite is still reading. Only
   * *syntactic* diagnostics are consulted: the private project resolves no
   * import and loads no library file, so a semantic diagnostic here would
   * describe the project this module deliberately did not open rather than the
   * text it produced.
   *
   * @param file The project-relative POSIX path, whose extension decides the
   * script kind.
   * @param patchedText The emitted text.
   * @param symbol The wrapped symbol, for the refusal's details.
   * @returns A `PATCH_UNSUPPORTED` error, or `undefined` when the text parses.
   */
  #syntaxRefusal(file: string, patchedText: string, symbol: string): DebuggenError | undefined {
    const scratch = this.#scratchProject();
    const verifyFile = scratch.createSourceFile(joinPosix(VERIFY_ROOT, file), patchedText, {
      overwrite: true,
      scriptKind: scriptKindFor(file),
    });

    try {
      const diagnostics = scratch.getProgram().getSyntacticDiagnostics(verifyFile);
      const first = diagnostics[0];

      if (first === undefined) {
        return undefined;
      }

      const messageText = first.getMessageText();

      return new DebuggenError(
        'PATCH_UNSUPPORTED',
        'The instrumented text did not parse, so it was discarded rather than written.',
        {
          details: {
            reason: 'invalid-syntax',
            file,
            symbol,
            diagnosticCount: diagnostics.length,
            code: first.getCode(),
            message: typeof messageText === 'string' ? messageText : messageText.getMessageText(),
          },
          hint: 'Report this with the target file and symbol; the target project was not modified.',
        },
      );
    } finally {
      scratch.removeSourceFile(verifyFile);
    }
  }

  /**
   * Type-checks the emitted text and returns a refusal when the patch
   * **introduced** a compiler diagnostic.
   *
   * The `this` annotation the wrapper's inner function carries is the one piece
   * of *semantics* this transform writes rather than moves, and
   * {@link FunctionTimingPatcher.#syntaxRefusal} cannot see a single thing wrong
   * with it: a wrong receiver type parses perfectly. So the original and the
   * patched text are type-checked under one configuration and compared.
   *
   * ## Why the comparison is sound
   *
   * The body text is unchanged by the patch, and the project resolves no import
   * and holds no `node_modules`, so a target's own pre-existing diagnostics —
   * the unresolved-import `TS2307`s above all, measured as identical in both
   * programs — appear on both sides and cancel. What survives the subtraction is
   * a diagnostic the patch is responsible for.
   *
   * ## Why every code counts, and not a list of them
   *
   * An earlier form of this check compared only the codes a receiver annotation
   * is known to cause (2302, 2322, 2339, 2345, 2526, 2683 — measured, in that
   * order, from a generic static's type arguments, a declared `this` return, a
   * shadowed class name, `this: C` on a static method, a moved body's own `this`
   * annotation, and an un-annotatable receiver). Those are still the usual
   * findings, but a list of them is a promise this module cannot keep: measured
   * on a class of two mutually recursive un-annotated methods, the wrapper adds
   * `TS7023` for the inner function and `TS7024` beside it — two more build
   * errors in the developer's project, under codes no receiver-typing list would
   * hold. Since the subtraction already removes what the file brought with it,
   * the honest comparison is over everything the compiler says.
   *
   * The two texts are checked **one at a time at the same path**, so neither can
   * see the other: two copies of one module in one program would redeclare
   * every global a script file declares and report it as a difference that is
   * really an artefact of the check.
   *
   * ## What it never does
   *
   * It never changes the patch. Its only outcomes are `undefined` and a
   * refusal, so the emitted bytes are a function of the input text alone and
   * `instrumentedHash` is unaffected by whether the check ran.
   *
   * @param file The project-relative POSIX path, whose extension decides the
   * script kind.
   * @param originalText The text the patch was computed against.
   * @param patchedText The emitted text.
   * @param symbol The wrapped symbol, for the refusal's details.
   * @returns A `PATCH_UNSUPPORTED` error, or `undefined` when the patch
   * introduced no receiver-typing diagnostic.
   */
  #introducedDiagnosticRefusal(
    file: string,
    originalText: string,
    patchedText: string,
    symbol: string,
  ): DebuggenError | undefined {
    const project = this.#typeProject();
    const path = joinPosix(TYPE_VERIFY_ROOT, file);
    const before = semanticDiagnosticKeys(project, path, file, originalText);
    const after = semanticDiagnosticKeys(project, path, file, patchedText);
    const introduced = introducedDiagnostics(before, after);

    if (introduced.length === 0) {
      return undefined;
    }

    return refusal(
      'PATCH_UNSUPPORTED',
      'unsupported-introduced-diagnostic',
      'The instrumented text would not type-check: it introduces compiler diagnostics the target file does not already have, so the text was discarded rather than written.',
      {
        file,
        symbol,
        diagnosticCount: introduced.length,
        diagnostics: introduced.slice(0, MAX_REPORTED_DIAGNOSTICS),
      },
      `Time a different symbol, or resolve the reported diagnostics for ${symbol} in ${file} — a shadowed receiver type and a missing return-type annotation are the usual causes.`,
    );
  }
}

/** Everything {@link FunctionTimingPatcher} resolves before it rewrites. */
interface RewriteInput {
  /** The target's project-relative POSIX path. */
  readonly file: string;

  /** The syntax to emit, from the target's extension. */
  readonly language: PatchLanguage;

  /** The text the patch is computed against. */
  readonly originalText: string;

  /** The request, for its `spanName` override and its action's id. */
  readonly request: FunctionTimingRequest;

  /** The private parsed copy of {@link RewriteInput.originalText}. */
  readonly sourceFile: SourceFile;

  /** The parsed `symbol` spelling. */
  readonly spelling: SymbolSpelling;
}

/**
 * {@link FunctionTimingPatcher.patch} for a caller with one target and no
 * project to reuse.
 *
 * Builds a patcher, patches, and drops it. Equivalent to constructing one and
 * calling `patch` once — which is what to do instead whenever more than one
 * target is involved, so the private in-memory project is shared rather than
 * rebuilt per file.
 *
 * @param request The target, and the text or project to read it from.
 * @param options How to configure the patcher. See
 * {@link FunctionTimingPatcherOptions}.
 * @returns The same result as {@link FunctionTimingPatcher.patch}.
 *
 * @example
 * ```ts
 * const patched = patchFunctionTiming(
 *   { file: 'src/server/load.ts', symbol: 'loadThings', text: original },
 *   { projectRoot: '/home/dev/app' },
 * );
 * ```
 */
export function patchFunctionTiming(
  request: FunctionTimingRequest,
  options: FunctionTimingPatcherOptions = {},
): Result<FunctionTimingPatch> {
  return new FunctionTimingPatcher(options).patch(request);
}

/**
 * The semantic diagnostics one text produces, as comparable keys.
 *
 * A key is `'<code>: <message>'` and deliberately carries **no position**: the
 * wrapper shifts every line below it, so a position would make every
 * pre-existing diagnostic look new. Code and message together are specific
 * enough to identify a diagnostic — both name the types involved — and
 * duplicates are kept rather than deduplicated so that
 * {@link introducedDiagnostics} can compare multiplicities.
 *
 * The file is created and removed inside this function, so the project it is
 * given holds exactly one file at a time and never accumulates state.
 *
 * @param project The lib-loaded verification project.
 * @param path The in-memory path to create the copy at.
 * @param file The project-relative path, whose extension decides the script
 * kind.
 * @param text The text to check.
 * @returns Every semantic diagnostic, in the compiler's own order.
 */
function semanticDiagnosticKeys(
  project: Project,
  path: string,
  file: string,
  text: string,
): readonly string[] {
  const sourceFile = project.createSourceFile(path, text, {
    overwrite: true,
    scriptKind: scriptKindFor(file),
  });

  try {
    return project
      .getProgram()
      .getSemanticDiagnostics(sourceFile)
      .map((diagnostic) => {
        const messageText = diagnostic.getMessageText();

        return `${String(diagnostic.getCode())}: ${
          typeof messageText === 'string' ? messageText : messageText.getMessageText()
        }`;
      });
  } finally {
    project.removeSourceFile(sourceFile);
  }
}

/**
 * The diagnostics present after the patch that were not present before it,
 * comparing multiplicities.
 *
 * Multiplicity matters: a file that already reports one `TS2339` of its own must
 * not hide a second one the patch introduced, and it must not be blamed for the
 * first. Each `after` entry cancels at most one identical `before` entry, and
 * what is left over is what the patch added.
 *
 * @param before The keys from the original text.
 * @param after The keys from the patched text.
 * @returns The introduced keys, in `after` order.
 */
function introducedDiagnostics(
  before: readonly string[],
  after: readonly string[],
): readonly string[] {
  const unmatched = new Map<string, number>();

  for (const entry of before) {
    unmatched.set(entry, (unmatched.get(entry) ?? 0) + 1);
  }

  const introduced: string[] = [];

  for (const entry of after) {
    const remaining = unmatched.get(entry) ?? 0;

    if (remaining > 0) {
      unmatched.set(entry, remaining - 1);
      continue;
    }

    introduced.push(entry);
  }

  return introduced;
}

/**
 * The name a class constructor is addressed by, matching the name
 * `packages/code-analysis/src/extractors/symbols.ts` records it under.
 *
 * Present so a plan that names a constructor gets the refusal that explains why
 * a constructor is not a function-timing target, rather than a misleading
 * "symbol not found".
 */
const CONSTRUCTOR_MEMBER_NAME = 'constructor';

/** How many wrapping expressions an initialiser may hide a function behind. */
const MAX_INITIALIZER_UNWRAP_DEPTH = 8;

/** The indentation one level costs when the target's own body reveals none. */
const DEFAULT_INDENT = '  ';

/**
 * Node kinds that give their own bodies a fresh `this`, `super` binding,
 * `new.target` or `arguments`, and whose subtrees are therefore skipped when
 * scanning a target's body for references to the enclosing one.
 *
 * `PropertyDeclaration` is in the list because a class field initialiser runs
 * with the instance as its receiver. `ArrowFunction` deliberately is **not**:
 * an arrow inherits all four lexically, so a `this` — or an `arguments` — inside
 * a nested arrow is one the wrapper must forward.
 *
 * The set is exactly right for `arguments` as well as for the receiver, which is
 * why one scan answers both questions: every kind listed here binds its own
 * `arguments` object, and the one kind deliberately absent inherits it.
 *
 * A class declaration is not skipped as a whole, only its members: a `this` in
 * a nested class's `extends` clause is evaluated in the enclosing scope, so
 * skipping the class outright would miss it and the wrapper would drop a
 * receiver the code depends on. For the same reason a skipped member's
 * *definition-time* expressions — its computed name and its decorators — are
 * scanned rather than skipped with it; see {@link definitionTimeExpressions}.
 */
const RECEIVER_REBINDING_KINDS: readonly SyntaxKind[] = Object.freeze([
  SyntaxKind.ClassStaticBlockDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.GetAccessor,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.SetAccessor,
]);

/** What a target's body references of the bindings its enclosing scope owns. */
interface ReceiverUsage {
  /** Whether the body reads `this`. */
  readonly referencesThis: boolean;

  /** Whether the body uses `super`, which no inner function can preserve. */
  readonly referencesSuper: boolean;

  /** Whether the body reads `new.target`, which an inner function rebinds. */
  readonly referencesNewTarget: boolean;

  /**
   * Whether the body reads the `arguments` binding of the function whose body
   * is moving — which the inner function rebinds to an arguments object of its
   * own. See `detectArgumentsHazard` in `./wrap-template.js` for what that
   * costs, and when it costs nothing.
   */
  readonly referencesArguments: boolean;

  /**
   * Whether the body reads `arguments.callee` (or `arguments['callee']`), whose
   * value is the function the arguments object was created for and therefore
   * changes when the body moves.
   */
  readonly referencesArgumentsCallee: boolean;

  /**
   * Whether the body contains a **direct** `eval(…)` call, which runs with the
   * body's own scope and can reach `arguments` or `arguments.callee` without
   * either appearing in the syntax tree.
   */
  readonly containsDirectEval: boolean;
}

/** The three identifiers a wrapper declares, once collisions are resolved. */
interface AllocatedIdentifiers {
  /** The inner function's name. */
  readonly inner: string;

  /** The helper local's name. */
  readonly helper: string;

  /** The rest parameter's name for an arrow target, `undefined` otherwise. */
  readonly rest: string | undefined;

  /** Whether any of them had to be renamed to avoid a binding in the target. */
  readonly disambiguated: boolean;
}

/**
 * Builds a coded refusal.
 *
 * Every expected failure of this module is one of these: a decision **not** to
 * produce text, carrying the code a caller branches on and the `reason` a log
 * or a test asserts against. Details are paths, names, positions and
 * vocabulary — never a fragment of the developer's source, which this module
 * reads in full and must not leak into a log line or a user interface.
 *
 * @param code The failure being reported, from the closed error vocabulary.
 * @param reason The machine-readable reason. See {@link Refusal.reason}.
 * @param message A complete sentence naming what cannot be patched.
 * @param details Diagnostic context, merged with `reason`.
 * @param hint The developer-facing next step, when one applies.
 * @returns The error, for the caller to wrap in `err`.
 */
function refusal(
  code: 'INTERNAL' | 'PATCH_TARGET_NOT_FOUND' | 'PATCH_UNSUPPORTED',
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
  hint?: string,
): DebuggenError {
  const options =
    hint === undefined
      ? { details: { reason, ...details } }
      : { details: { reason, ...details }, hint };

  return new DebuggenError(code, message, options);
}

/**
 * The script kind a target's extension implies.
 *
 * `.tsx` is TSX and `.ts`/`.mts`/`.cts` are TS, which is the distinction that
 * decides whether `<T>(x) => x` is a generic arrow or a JSX element — getting
 * it wrong would misparse ordinary TypeScript. The JavaScript extensions are
 * all parsed as JSX, which is a superset of JavaScript rather than a guess: a
 * valid JavaScript expression never begins with `<`, so JSX mode changes
 * nothing for a file without JSX while admitting the `.js` files that do carry
 * it, as a React project's often do.
 *
 * An extension this product cannot patch never reaches here — `buildWrapperBody`
 * and `resolvePatchLanguage` in `./wrap-template.js` refuse it first — so the
 * TypeScript default is the answer for the three remaining TypeScript
 * extensions and not a fallback for the unknown.
 *
 * @param file Any path; only its final extension is consulted.
 * @returns The script kind to parse the file with.
 */
function scriptKindFor(file: string): ScriptKind {
  const extension = extnamePosix(file);

  if (extension === '.tsx') {
    return ScriptKind.TSX;
  }

  if (extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs') {
    return ScriptKind.JSX;
  }

  return ScriptKind.TS;
}

/**
 * The newline sequence a file already uses.
 *
 * Every line this module inserts is joined with it, so a patch does not convert
 * a CRLF file to LF — which would rewrite every line of the file as far as a
 * diff, a hash and a version-control status are concerned, from a transform
 * that was asked to change one function.
 *
 * @param text The original text.
 * @returns `'\r\n'` when the first line ending is one, `'\n'` otherwise
 * (including for a file with no line ending at all).
 */
function detectNewline(text: string): string {
  const index = text.indexOf('\n');

  return index > 0 && text[index - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Parses a `symbol` spelling into a bare name and an optional container.
 *
 * Accepts `'member'`, `'Class.member'`, `'Class#member'` and
 * `'Class.prototype.member'` — see {@link QUALIFIED_SYMBOL_SEPARATORS} for why
 * the qualified forms exist — and refuses anything with an empty segment or
 * more than two meaningful ones rather than interpreting it.
 *
 * @param symbol The spelling as the request gave it.
 * @returns The parsed spelling, or a `PATCH_TARGET_NOT_FOUND` refusal.
 */
function parseSymbolSpelling(symbol: string): Result<SymbolSpelling> {
  const trimmed = symbol.trim();

  if (trimmed.length === 0) {
    return err(
      refusal(
        'PATCH_TARGET_NOT_FOUND',
        'malformed-symbol',
        'A patch target must name a symbol, and this one names none.',
        { symbol },
      ),
    );
  }

  const segments = trimmed.split(/[.#]/u);

  if (segments.some((segment) => segment.length === 0)) {
    return err(
      refusal(
        'PATCH_TARGET_NOT_FOUND',
        'malformed-symbol',
        'A patch target must not contain an empty name segment.',
        { symbol },
      ),
    );
  }

  const meaningful = segments.filter(
    (segment, index) => !(segments.length === 3 && index === 1 && segment === PROTOTYPE_SEGMENT),
  );
  const name = meaningful.at(-1);

  if (name === undefined || meaningful.length > 2) {
    return err(
      refusal(
        'PATCH_TARGET_NOT_FOUND',
        'malformed-symbol',
        'A patch target is a name, optionally qualified by the class that declares it.',
        { symbol, accepted: ['member', 'Class.member', 'Class#member', 'Class.prototype.member'] },
      ),
    );
  }

  return ok({ name, container: meaningful.length === 2 ? meaningful[0] : undefined });
}

/**
 * Resolves a spelling to exactly one declaration this module can wrap.
 *
 * Exact-name and unambiguous, in three refusal steps: nothing matched, more
 * than one matched, or the single match is a form this module declines. There
 * is no fuzzy fallback — a plan that named a symbol this file does not declare
 * is a plan built against a different file, and patching the nearest thing
 * would instrument the wrong function and report a source location that looked
 * authoritative.
 *
 * @param sourceFile The parsed copy of the target file.
 * @param spelling The parsed symbol spelling.
 * @param file The project-relative path, for the refusal details.
 * @returns The single resolved target, or a refusal.
 */
function resolveTarget(
  sourceFile: SourceFile,
  spelling: SymbolSpelling,
  file: string,
): Result<ResolvedTarget> {
  const candidates: Candidate[] = [];

  for (const statement of sourceFile.getStatements()) {
    collectFromStatement(statement, spelling, candidates);
  }

  const first = candidates[0];

  if (first === undefined) {
    return err(
      refusal(
        'PATCH_TARGET_NOT_FOUND',
        'symbol-not-found',
        'The target file declares no such symbol at module scope or on a class it declares.',
        { file, symbol: spelling.name, container: spelling.container },
        'Re-index the project: the plan names a symbol this file does not declare.',
      ),
    );
  }

  // A refusal every candidate shares is reported as that refusal rather than as
  // an ambiguity, and the case is not hypothetical: a get/set pair is two
  // declarations of one name, so "qualify it" would be advice that cannot help.
  // The developer needs to hear that an accessor is not a timing target.
  const sharedRefusal =
    first.refusal !== undefined &&
    candidates.every((candidate) => candidate.refusal?.reason === first.refusal?.reason)
      ? first.refusal
      : undefined;

  if (sharedRefusal !== undefined) {
    return err(
      refusal(
        'PATCH_UNSUPPORTED',
        sharedRefusal.reason,
        sharedRefusal.message,
        {
          file,
          symbol: spelling.name,
          container: first.container,
          declarations: candidates.length,
        },
        sharedRefusal.hint,
      ),
    );
  }

  if (candidates.length > 1) {
    return err(
      refusal(
        'PATCH_TARGET_NOT_FOUND',
        'ambiguous-symbol',
        'The target symbol resolves to more than one declaration, so it is not addressable.',
        {
          file,
          symbol: spelling.name,
          candidates: candidates.map((candidate) => ({
            container: candidate.container,
            line: candidate.declaration.getStartLineNumber(),
          })),
        },
        'Qualify the symbol as Class.member to name one of them.',
      ),
    );
  }

  if (first.target === undefined) {
    return err(
      refusal(
        'INTERNAL',
        'unresolved-candidate',
        'A patch candidate was neither wrappable nor refused, which is a defect in the resolver.',
        { file, symbol: spelling.name },
      ),
    );
  }

  return ok(first.target);
}

/**
 * Collects the candidates one top-level statement contributes.
 *
 * Module scope only, and class members of classes declared at module scope:
 * that is the surface a plan addresses, because it is the surface
 * `packages/code-analysis`'s symbol extractor records. A function declared
 * inside another function has no name a plan could address unambiguously and is
 * deliberately not collected.
 *
 * @param statement The statement to inspect.
 * @param spelling The name and optional container being resolved.
 * @param into The accumulator, appended to in source order.
 */
function collectFromStatement(
  statement: Statement,
  spelling: SymbolSpelling,
  into: Candidate[],
): void {
  if (Node.isFunctionDeclaration(statement)) {
    if (spelling.container !== undefined) {
      return;
    }

    const nameNode = statement.getNameNode();

    if (nameNode === undefined || nameNode.getText() !== spelling.name) {
      return;
    }

    // An overload signature is not the target; its implementation is. Skipping
    // it here is what keeps an overloaded function from looking ambiguous.
    if (statement.isOverload() && statement.getImplementation() !== undefined) {
      return;
    }

    const body = statement.getBody();

    into.push({
      declaredName: spelling.name,
      container: undefined,
      declaration: statement,
      target:
        body === undefined
          ? undefined
          : {
              shape: 'function-declaration',
              fn: statement,
              body,
              nameNode,
              declaration: statement,
              declaredName: spelling.name,
              container: undefined,
            },
      refusal: body === undefined ? BODYLESS_DECLARATION_REFUSAL : undefined,
    });

    return;
  }

  if (Node.isVariableStatement(statement)) {
    if (spelling.container !== undefined) {
      return;
    }

    for (const declaration of statement.getDeclarations()) {
      const nameNode = declaration.getNameNode();

      if (!Node.isIdentifier(nameNode) || nameNode.getText() !== spelling.name) {
        continue;
      }

      into.push(
        assignedFunctionCandidate(
          unwrapInitializer(declaration.getInitializer()),
          declaration,
          nameNode,
          spelling.name,
          undefined,
        ),
      );
    }

    return;
  }

  if (Node.isClassDeclaration(statement)) {
    collectFromClass(statement, spelling, into);
  }
}

/**
 * Collects the candidates one class declaration contributes.
 *
 * @param classDeclaration The class to inspect.
 * @param spelling The name and optional container being resolved.
 * @param into The accumulator, appended to in source order.
 */
function collectFromClass(
  classDeclaration: ClassDeclaration,
  spelling: SymbolSpelling,
  into: Candidate[],
): void {
  const container = classDeclaration.getName();

  if (spelling.container !== undefined && container !== spelling.container) {
    return;
  }

  for (const member of classDeclaration.getMembers()) {
    if (Node.isConstructorDeclaration(member)) {
      if (spelling.name === CONSTRUCTOR_MEMBER_NAME) {
        into.push({
          declaredName: spelling.name,
          container,
          declaration: member,
          target: undefined,
          refusal: {
            reason: 'unsupported-constructor',
            message:
              'A constructor is not a function-timing target: its body runs field initialisers and may call super, neither of which survives being moved into an inner function.',
            hint: 'Instrument a method the constructor calls instead.',
          },
        });
      }

      continue;
    }

    if (Node.isGetAccessorDeclaration(member) || Node.isSetAccessorDeclaration(member)) {
      if (declaredNameOf(member.getNameNode()) === spelling.name) {
        into.push({
          declaredName: spelling.name,
          container,
          declaration: member,
          target: undefined,
          refusal: {
            reason: 'unsupported-accessor',
            message:
              'A property accessor is not a function-timing target: a get/set pair shares one name, so a plan could not say which half to time.',
            hint: 'Instrument a method the accessor delegates to instead.',
          },
        });
      }

      continue;
    }

    if (Node.isMethodDeclaration(member)) {
      if (declaredNameOf(member.getNameNode()) !== spelling.name) {
        continue;
      }

      if (member.isOverload() && member.getImplementation() !== undefined) {
        continue;
      }

      const body = member.getBody();

      into.push({
        declaredName: spelling.name,
        container,
        declaration: member,
        target:
          body === undefined
            ? undefined
            : {
                shape: 'method',
                fn: member,
                body,
                nameNode: member.getNameNode(),
                declaration: member,
                declaredName: spelling.name,
                container,
              },
        refusal: body === undefined ? BODYLESS_DECLARATION_REFUSAL : undefined,
      });

      continue;
    }

    if (Node.isPropertyDeclaration(member)) {
      if (declaredNameOf(member.getNameNode()) !== spelling.name) {
        continue;
      }

      into.push(
        assignedFunctionCandidate(
          unwrapInitializer(member.getInitializer()),
          member,
          member.getNameNode(),
          spelling.name,
          container,
        ),
      );
    }

    // A static initialisation block and an index signature carry no name a plan
    // could address, so neither contributes a candidate.
  }
}

/**
 * The refusal every bodyless form shares: an overload signature with no
 * implementation, an ambient `declare function`, an abstract method.
 *
 * One object rather than three identical ones, because the distinction a
 * developer needs is "there is no body to time", not which syntax withheld it.
 * `../feasibility.ts` reports the same condition under the same reason from the
 * code graph, before a plan ever reaches the patcher.
 */
const BODYLESS_DECLARATION_REFUSAL: Refusal = Object.freeze({
  reason: 'unsupported-declaration',
  message:
    'The target declaration has no body, so there is nothing to time: an overload signature, an ambient declaration and an abstract member all declare a shape rather than an implementation.',
  hint: 'Name the implementation rather than the signature that declares it.',
});

/**
 * Builds the candidate for a function assigned to a variable or a class
 * property.
 *
 * The declaration that carries the name — the variable or the property — is
 * what `endLine`, the indentation and the collision scan are taken from, while
 * the function itself is what gets rewritten. Keeping them apart is what lets
 * `const f = (a) => a;` report the position of `f` and rewrite the arrow.
 *
 * @param initializer The unwrapped function-valued initialiser, or `undefined`
 * when the declaration holds something else.
 * @param declaration The variable or property declaration.
 * @param nameNode The declaration's name node.
 * @param declaredName The bare declared name.
 * @param container The owning class's name, or `undefined` at module scope.
 * @returns A wrappable candidate, or one carrying the refusal.
 */
function assignedFunctionCandidate(
  initializer: ArrowFunction | FunctionExpression | undefined,
  declaration: Node,
  nameNode: Node,
  declaredName: string,
  container: string | undefined,
): Candidate {
  if (initializer === undefined) {
    return {
      declaredName,
      container,
      declaration,
      target: undefined,
      refusal: {
        reason: 'unsupported-declaration',
        message:
          'The target names a declaration that does not hold a function, so there is no body to time.',
        hint: 'Name a function, a method, or a declaration initialised with one.',
      },
    };
  }

  return {
    declaredName,
    container,
    declaration,
    target: {
      shape: Node.isArrowFunction(initializer) ? 'arrow-function' : 'function-expression',
      fn: initializer,
      body: initializer.getBody(),
      nameNode,
      declaration,
      declaredName,
      container,
    },
    refusal: undefined,
  };
}

/**
 * The name a declaration's name node spells, or `undefined` when it has none
 * a plan could address.
 *
 * Mirrors `declaredNameOf` in `packages/code-analysis/src/extractors/symbols.ts`
 * deliberately, so a symbol the code graph recorded is a symbol this module can
 * find: a string-literal member name is unquoted, a numeric or private name is
 * kept as written, and a computed name yields `undefined` because it is not
 * statically known.
 *
 * @param nameNode The name node, or `undefined`.
 * @returns The declared name, or `undefined`.
 */
function declaredNameOf(nameNode: Node | undefined): string | undefined {
  if (nameNode === undefined) {
    return undefined;
  }

  if (Node.isIdentifier(nameNode) || Node.isPrivateIdentifier(nameNode)) {
    const text = nameNode.getText();

    return text.length === 0 ? undefined : text;
  }

  if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
    const text = nameNode.getLiteralText();

    return text.length === 0 ? undefined : text;
  }

  if (Node.isNumericLiteral(nameNode)) {
    return nameNode.getText();
  }

  return undefined;
}

/**
 * The function an initialiser holds, looking through the expressions that can
 * wrap one without changing it.
 *
 * `(f)`, `f as Fn`, `f satisfies Fn`, `f!` and `<Fn>f` all leave the function
 * itself as the node to rewrite, and the wrapper stays exactly where it was:
 * only the function's own range is replaced, so `const f = ((a) => a) as Fn;`
 * keeps both its parentheses and its assertion.
 *
 * @param expression The initialiser, or `undefined`.
 * @returns The arrow or function expression, or `undefined` when the
 * initialiser holds something else.
 */
function unwrapInitializer(
  expression: Node | undefined,
): ArrowFunction | FunctionExpression | undefined {
  let current = expression;

  for (let depth = 0; depth < MAX_INITIALIZER_UNWRAP_DEPTH; depth += 1) {
    if (current === undefined) {
      return undefined;
    }

    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      return current;
    }

    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isTypeAssertion(current)
    ) {
      current = current.getExpression();
      continue;
    }

    return undefined;
  }

  return undefined;
}

/**
 * The refusal a resolved target still earns, or `undefined` when it may be
 * wrapped.
 *
 * Four conditions, each of which would otherwise produce a file that compiles
 * and misbehaves:
 *
 * - **A generator.** A wrapper that calls the body as a function cannot
 *   preserve `yield`: the generator's consumer would receive the wrapper's
 *   return value instead of an iterator. `../feasibility.ts` rejects these from
 *   the code graph, and `buildWrapperBody` *throws* rather than refusing if one
 *   reaches it, so this check is what keeps a skipped gate from becoming an
 *   exception on a caller's stack.
 * - **A target that is already instrumented.** Wrapping a wrapper would time
 *   the wrapper, nest two spans for one call, and leave a file whose restore
 *   depends on two journal records applying in an order neither one states.
 * - **`super` or `new.target` in a body that would move into an inner
 *   function.** `super` is a syntax error inside a function declared in a
 *   method, and `new.target` would silently become `undefined` — a wrapper
 *   cannot preserve either, so the target is refused rather than broken. Arrow
 *   targets are exempt: their inner function is an arrow, which inherits both.
 * - **An observable `arguments` object in a sloppy-mode body.** The inner
 *   function binds an arguments object of its own, so a sloppy function's
 *   mapping between `arguments[i]` and its named parameters, and its
 *   `arguments.callee` identity, do not survive the move — measured in Node as
 *   `arguments[0] = 9` updating the parameter before the patch and not after.
 *   `detectArgumentsHazard` in `./wrap-template.js` owns the rule and states the
 *   measurements; this is where it is applied. Arrow targets are exempt for the
 *   same reason as above: an arrow has no `arguments` binding of its own, so a
 *   reference in its body resolves lexically and is unaffected by the move.
 *
 * Strict code is unaffected by the last condition, which is why it almost never
 * fires: every TypeScript and ES-module target is strict, and so is every class
 * member. See {@link isDefinitelyStrict}.
 *
 * @param target The resolved target.
 * @param callStyle The call style its shape implies.
 * @param file The project-relative path, for the refusal details.
 * @returns The refusal, or `undefined`.
 */
function supportRefusal(
  target: ResolvedTarget,
  callStyle: WrapperCallStyle,
  file: string,
): DebuggenError | undefined {
  const fn = target.fn;

  if (!Node.isArrowFunction(fn) && fn.isGenerator()) {
    return refusal(
      'PATCH_UNSUPPORTED',
      fn.isAsync() ? 'unsupported-async-generator' : 'unsupported-generator',
      'A generator function has no function-timing template: a wrapper that calls the body as a function cannot preserve yield.',
      { file, symbol: target.declaredName, shape: target.shape },
      'Time a function the generator delegates to instead.',
    );
  }

  if (target.declaration.getText().includes(SPAN_HELPER_GLOBAL)) {
    return refusal(
      'PATCH_UNSUPPORTED',
      'already-instrumented',
      'The target is already instrumented, and wrapping a wrapper would time the wrapper and nest two spans for one call.',
      { file, symbol: target.declaredName },
      'Revert the existing modification for this file before installing another for the same symbol.',
    );
  }

  if (callStyle === 'arguments') {
    const usage = scanReceiverUsage(target.body);

    if (usage.referencesSuper) {
      return refusal(
        'PATCH_UNSUPPORTED',
        'unsupported-super-reference',
        'The target body uses super, which is not available inside the inner function the wrapper declares.',
        { file, symbol: target.declaredName },
        'Time a method that does not reach for super, or a function it calls.',
      );
    }

    if (usage.referencesNewTarget) {
      return refusal(
        'PATCH_UNSUPPORTED',
        'unsupported-new-target',
        'The target body reads new.target, which the inner function the wrapper declares would rebind.',
        { file, symbol: target.declaredName },
        'Time a function that does not depend on how it was called.',
      );
    }

    const facts: ArgumentsHazardFacts = {
      strictMode: isDefinitelyStrict(target, file),
      ...parameterListFacts(target.fn),
      referencesArguments: usage.referencesArguments,
      referencesArgumentsCallee: usage.referencesArgumentsCallee,
      containsDirectEval: usage.containsDirectEval,
    };
    const hazard = detectArgumentsHazard(facts);

    if (hazard !== undefined) {
      const stated = ARGUMENTS_HAZARD_REFUSALS[hazard];

      return refusal(
        'PATCH_UNSUPPORTED',
        stated.reason,
        stated.message,
        {
          file,
          symbol: target.declaredName,
          hazard,
          parameterList: facts.parameterList,
          parameterCount: facts.parameterCount,
        },
        stated.hint,
      );
    }
  }

  return undefined;
}

/**
 * What each `arguments` hazard is reported as: the `reason` a caller branches
 * on, the sentence the developer reads, and the change that would make the
 * target wrappable.
 *
 * Stated as data, keyed by the hazard vocabulary `./wrap-template.js` exports,
 * so the three refusals cannot drift apart and a new hazard there is a compile
 * error here rather than a silent gap. Frozen because it is vocabulary rather
 * than state.
 *
 * Every hint is something the developer can actually do: `'use strict'` makes
 * the arguments object unmapped and the move transparent; reading the
 * parameters by name — or through a rest parameter — removes the dependency
 * altogether; and `arguments.callee` has a named-function-expression
 * replacement in every case, which is why it has been deprecated since ES5.
 */
const ARGUMENTS_HAZARD_REFUSALS: Readonly<
  Record<
    ArgumentsHazard,
    { readonly reason: string; readonly message: string; readonly hint: string }
  >
> = Object.freeze({
  'mapped-arguments': Object.freeze({
    reason: 'unsupported-mapped-arguments',
    message:
      'The target is a sloppy-mode function whose body reads arguments, and the inner function the wrapper declares binds an arguments object of its own: the mapping between arguments[0] and the first parameter would stop working while the patch is installed.',
    hint: "Add a 'use strict' directive to the file, or read the parameters by name or through a rest parameter instead of arguments.",
  }),
  'arguments-callee': Object.freeze({
    reason: 'unsupported-arguments-callee',
    message:
      'The target body reads arguments.callee, whose value is the function the arguments object was created for, so moving the body into an inner function would change what it answers.',
    hint: "Replace arguments.callee with the function's own name, or with a named function expression, and the target becomes patchable.",
  }),
  'direct-eval': Object.freeze({
    reason: 'unsupported-direct-eval',
    message:
      "The target is a sloppy-mode function whose body contains a direct eval call, which runs in that body's scope and can therefore observe the arguments object the inner function would rebind.",
    hint: "Add a 'use strict' directive to the file, or time a function that does not call eval directly.",
  }),
});

/**
 * What a body references of the bindings its enclosing function owns.
 *
 * **One** traversal for all six answers, skipping the subtrees that rebind them
 * — see {@link RECEIVER_REBINDING_KINDS} for which those are, why an arrow is
 * not among them, and why the same skip set is correct for `arguments` as for
 * the receiver.
 *
 * `new.target` and `import.meta` are the same node kind, so the keyword token
 * is checked: `import.meta` is module-scoped and survives being moved into an
 * inner function untouched, and treating it as `new.target` would refuse a
 * perfectly wrappable function.
 *
 * @param body The target's body.
 * @returns The six flags.
 */
function scanReceiverUsage(body: Node): ReceiverUsage {
  const usage: MutableReceiverUsage = {
    referencesThis: false,
    referencesSuper: false,
    referencesNewTarget: false,
    referencesArguments: false,
    referencesArgumentsCallee: false,
    containsDirectEval: false,
  };

  scanEnclosingScope(body, usage);

  return { ...usage };
}

/** {@link ReceiverUsage} while the scan is still filling it in. */
interface MutableReceiverUsage {
  referencesThis: boolean;
  referencesSuper: boolean;
  referencesNewTarget: boolean;
  referencesArguments: boolean;
  referencesArgumentsCallee: boolean;
  containsDirectEval: boolean;
}

/**
 * Records every use of the enclosing scope's bindings in one subtree.
 *
 * Skipping a nested member's subtree is not the same as skipping every
 * expression written inside it, and the difference is observable. A **computed
 * member name** and a **decorator** are evaluated where the member is
 * *defined* — in this scope, with this `arguments` object — not when the
 * member is called, so they must be scanned even though the member's own
 * parameters and body must not be. Measured on the shape this module emits,
 * with `a` assigned before the member is defined:
 *
 * ```text
 * function f(a) { a = 'after'; const o = { [arguments[0]]() {} }; … }
 * f('before')   ->  original 'after',  patched 'before'
 * ```
 *
 * so a scan that skipped the computed name would accept that target and change
 * a property key. The member's subtree is therefore skipped and its
 * definition-time expressions are re-entered through this same function, which
 * applies the same rules one scope up — including to a nested function written
 * inside a decorator argument.
 *
 * @param root The subtree to scan, whose own node is examined as well as its
 * descendants.
 * @param usage The flags to fill in.
 */
function scanEnclosingScope(root: Node, usage: MutableReceiverUsage): void {
  // `forEachDescendant` does not visit the node it is called on, and a
  // re-entered expression can *be* the reference (`{ [arguments]() {} }`).
  recordReceiverUsage(root, usage);

  root.forEachDescendant((node, traversal): undefined => {
    if (RECEIVER_REBINDING_KINDS.includes(node.getKind())) {
      traversal.skip();

      for (const expression of definitionTimeExpressions(node)) {
        scanEnclosingScope(expression, usage);
      }

      return undefined;
    }

    recordReceiverUsage(node, usage);

    return undefined;
  });
}

/**
 * Records what one node uses of the enclosing scope's bindings.
 *
 * `new.target` and `import.meta` are the same node kind, so the keyword token
 * is checked: `import.meta` is module-scoped and survives being moved into an
 * inner function untouched, and treating it as `new.target` would refuse a
 * perfectly wrappable function.
 *
 * @param node The node to examine.
 * @param usage The flags to fill in.
 */
function recordReceiverUsage(node: Node, usage: MutableReceiverUsage): void {
  const kind = node.getKind();

  if (kind === SyntaxKind.ThisKeyword) {
    usage.referencesThis = true;
  } else if (kind === SyntaxKind.SuperKeyword) {
    usage.referencesSuper = true;
  } else if (Node.isMetaProperty(node) && node.getKeywordToken() === SyntaxKind.NewKeyword) {
    usage.referencesNewTarget = true;
  }

  if (isArgumentsCalleeAccess(node)) {
    usage.referencesArgumentsCallee = true;
  }

  if (Node.isIdentifier(node) && node.getText() === ARGUMENTS_BINDING_NAME) {
    usage.referencesArguments ||= isIdentifierReference(node);
  }

  if (isDirectEvalCall(node)) {
    usage.containsDirectEval = true;
  }
}

/**
 * The expressions a nested member evaluates **where it is defined** rather than
 * where it is called, and which therefore belong to the scanned scope.
 *
 * A computed name and a decorator both run at definition time, in the
 * surrounding function's scope; a parameter decorator does too, even though the
 * parameter it decorates is bound per call. Everything else about the member —
 * its parameter defaults, its body — runs against its own `this` and its own
 * `arguments`, which is why {@link RECEIVER_REBINDING_KINDS} skips it.
 *
 * @param member The nested declaration whose subtree is being skipped.
 * @returns The expressions to scan in the enclosing scope, possibly none.
 */
function definitionTimeExpressions(member: Node): readonly Node[] {
  const expressions: Node[] = [];

  if (
    Node.isMethodDeclaration(member) ||
    Node.isPropertyDeclaration(member) ||
    Node.isGetAccessorDeclaration(member) ||
    Node.isSetAccessorDeclaration(member)
  ) {
    const nameNode = member.getNameNode();

    if (Node.isComputedPropertyName(nameNode)) {
      expressions.push(nameNode.getExpression());
    }

    for (const decorator of member.getDecorators()) {
      expressions.push(decorator.getExpression());
    }
  }

  if (
    Node.isMethodDeclaration(member) ||
    Node.isConstructorDeclaration(member) ||
    Node.isGetAccessorDeclaration(member) ||
    Node.isSetAccessorDeclaration(member)
  ) {
    for (const parameter of member.getParameters()) {
      for (const decorator of parameter.getDecorators()) {
        expressions.push(decorator.getExpression());
      }
    }
  }

  return expressions;
}

/**
 * Whether a node is a **direct** `eval(…)` call — one that evaluates its
 * argument in the scope it is written in, and can therefore read mapped
 * `arguments` or `arguments.callee` with neither identifier anywhere in the
 * syntax tree.
 *
 * Parentheses do not make a call indirect, and neither do TypeScript's
 * type-only wrappers, which erase before the code runs. Measured in Node 24,
 * in a sloppy function that assigns its parameter and then reads
 * `arguments[0]` through the call:
 *
 * ```text
 * eval('…')              -> 9   direct
 * (eval)('…')            -> 9   direct
 * ((eval))('…')          -> 9   direct
 * (0, eval)('…')         -> ReferenceError   indirect, evaluates globally
 * eval?.('…')            -> ReferenceError   indirect
 * globalThis.eval('…')   -> ReferenceError   indirect
 * ```
 *
 * The three indirect forms cannot see the body's bindings at all, so none of
 * them is a hazard — nor is the `Function` constructor, for the same reason.
 *
 * @param node Any node reached by the scan.
 * @returns `true` for a direct `eval` call.
 */
function isDirectEvalCall(node: Node): boolean {
  if (!Node.isCallExpression(node) || node.getQuestionDotTokenNode() !== undefined) {
    return false;
  }

  const callee = unwrapCalleeReference(node.getExpression());

  return callee !== undefined && Node.isIdentifier(callee) && callee.getText() === DIRECT_EVAL_NAME;
}

/**
 * The reference a callee position really names, looking through the wrappers
 * that change neither the reference nor how the call is performed.
 *
 * Grouping parentheses and the type-only assertions are transparent; a comma
 * expression is deliberately **not** unwrapped, because `(0, eval)(…)` is the
 * canonical way to ask for an *indirect* eval and reading through it would
 * refuse a target that is not a hazard.
 *
 * @param expression The callee expression.
 * @returns The innermost callee, or `undefined` past the wrapper bound.
 */
function unwrapCalleeReference(expression: Node): Node | undefined {
  let current: Node | undefined = expression;

  for (let depth = 0; depth < MAX_CALLEE_UNWRAP_DEPTH; depth += 1) {
    if (current === undefined) {
      return undefined;
    }

    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isTypeAssertion(current)
    ) {
      current = current.getExpression();
      continue;
    }

    return current;
  }

  return undefined;
}

/** How many transparent wrappers may hide the reference a call names. */
const MAX_CALLEE_UNWRAP_DEPTH = 8;

/**
 * The name of the binding every non-arrow function receives for its call's
 * arguments, and the one this module's `arguments` scan looks for.
 */
const ARGUMENTS_BINDING_NAME = 'arguments';

/** The property of an arguments object whose value is the callee itself. */
const CALLEE_PROPERTY_NAME = 'callee';

/** The callee spelling that makes a call a *direct* `eval`. */
const DIRECT_EVAL_NAME = 'eval';

/** The parameter name TypeScript reserves for the receiver's annotation. */
const THIS_PARAMETER_NAME = 'this';

/**
 * Whether `node` reads `arguments.callee`, in either spelling.
 *
 * Both forms are checked because both answer the same value and both are
 * written in real legacy code: `arguments.callee` and `arguments['callee']`. A
 * computed read through a variable (`arguments[key]`) cannot be resolved
 * syntactically — which is one reason a body that mentions `arguments` at all is
 * treated as depending on the binding.
 *
 * @param node Any node reached by the scan.
 * @returns `true` for a property or element access of `callee` on `arguments`.
 */
function isArgumentsCalleeAccess(node: Node): boolean {
  if (Node.isPropertyAccessExpression(node)) {
    return isArgumentsIdentifier(node.getExpression()) && node.getName() === CALLEE_PROPERTY_NAME;
  }

  if (Node.isElementAccessExpression(node)) {
    const argument = node.getArgumentExpression();

    return (
      isArgumentsIdentifier(node.getExpression()) &&
      argument !== undefined &&
      (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)) &&
      argument.getLiteralText() === CALLEE_PROPERTY_NAME
    );
  }

  return false;
}

/**
 * Whether `node` is the bare identifier `arguments`.
 *
 * @param node Any node.
 * @returns `true` for the identifier, `false` for anything else.
 */
function isArgumentsIdentifier(node: Node): boolean {
  return Node.isIdentifier(node) && node.getText() === ARGUMENTS_BINDING_NAME;
}

/**
 * Whether an identifier occurrence *reads a binding*, rather than sitting in a
 * position where it names something else.
 *
 * The positions that are not reads: a property name (`o.arguments`), a
 * property-assignment key (`{ arguments: 1 }`), any declaration's own name, and
 * an import or export specifier's name. A **shorthand** property
 * (`{ arguments }`) is the one name position that *is* a read, and is reported
 * as one.
 *
 * A type-position occurrence — a type reference that happens to be spelled
 * `arguments` — is treated as a read, which is deliberately conservative and
 * costs nothing: the only decision that consults this scan's `arguments` flags
 * is gated on the body **not** being definitely strict, and a file with type
 * annotations is either an ES module or a TypeScript file, both of which are
 * strict. See {@link isDefinitelyStrict}.
 *
 * @param node The identifier the scan reached.
 * @returns `true` when the occurrence reads the binding of that name.
 */
function isIdentifierReference(node: Identifier): boolean {
  const parent = node.getParent();

  if (parent === undefined) {
    return false;
  }

  if (Node.isShorthandPropertyAssignment(parent)) {
    return true;
  }

  if (Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent)) {
    return false;
  }

  if (Node.isQualifiedName(parent) && parent.getRight() === node) {
    return false;
  }

  return !(Node.hasName(parent) && parent.getNameNode() === node);
}

/**
 * Whether the target's body is **definitely** strict code.
 *
 * Certainty in one direction only: `true` means the ECMAScript rules make the
 * body strict whatever else the project does, and `false` means this module
 * could not prove it — which is treated as sloppy, because the cost of being
 * wrong that way is a refusal the developer can read rather than an application
 * that computes different values while it is instrumented.
 *
 * The four grounds, each purely syntactic and therefore valid under the
 * `noResolve`/`noLib` parse this module runs:
 *
 * - **A class body.** Every part of a class declaration or class expression is
 *   strict, so a method — and a function or arrow in a field initialiser — is.
 * - **An `.mjs` or `.mts` file.** Always a module, and modules are strict.
 * - **An ES module.** `ts.isExternalModule` answers from the presence of a
 *   top-level `import` or `export`, which is exactly the spec's own test; a
 *   dynamic `import(…)` alone does not make a module, and it is not counted.
 * - **A `'use strict'` prologue** on the file, on the target's own body, or on
 *   any enclosing function's body.
 *
 * In the stack this product supports — TypeScript and TSX in ES modules — the
 * answer is always `true`, so the refusals it gates only ever fire for a legacy
 * script: a `.js`, `.jsx` or `.cjs` file with no `import`, no `export` and no
 * `'use strict'`.
 *
 * @param target The resolved target.
 * @param file The project-relative POSIX path, for its extension.
 * @returns `true` when the body is certainly strict.
 */
function isDefinitelyStrict(target: ResolvedTarget, file: string): boolean {
  const extension = extnamePosix(file);

  if (extension === '.mjs' || extension === '.mts') {
    return true;
  }

  const sourceFile = target.fn.getSourceFile();

  if (ts.isExternalModule(sourceFile.compilerNode)) {
    return true;
  }

  if (hasStrictDirectivePrologue(sourceFile.getStatements())) {
    return true;
  }

  if (Node.isBlock(target.body) && hasStrictDirectivePrologue(target.body.getStatements())) {
    return true;
  }

  for (const ancestor of target.fn.getAncestors()) {
    if (Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor)) {
      return true;
    }

    // Only these three can enclose a target without also being inside a class
    // body, which the branch above has already answered for.
    const body =
      Node.isFunctionDeclaration(ancestor) ||
      Node.isFunctionExpression(ancestor) ||
      Node.isArrowFunction(ancestor)
        ? ancestor.getBody()
        : undefined;

    if (
      body !== undefined &&
      Node.isBlock(body) &&
      hasStrictDirectivePrologue(body.getStatements())
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Whether a statement list opens with a `'use strict'` directive.
 *
 * Stricter than {@link isDirectivePrologueStatement} on purpose, in the two
 * ways that decide whether code is actually strict:
 *
 * - **Only a string literal is a directive.** A template-literal spelling of
 *   `` `use strict` `` is an ordinary expression statement and enables nothing.
 * - **Only the unescaped spelling is a directive.** The raw source characters
 *   are compared, so `'use\u0020strict'` — which cooks to the same string — is
 *   correctly *not* a directive.
 *
 * The scan stops at the first statement that is not a string-literal
 * expression, because a directive is only a directive inside the prologue.
 *
 * @param statements A file's or a body's statements, in source order.
 * @returns `true` when one of the leading directives is `'use strict'`.
 */
function hasStrictDirectivePrologue(statements: readonly Statement[]): boolean {
  for (const statement of statements) {
    if (!Node.isExpressionStatement(statement)) {
      return false;
    }

    const expression = statement.getExpression();

    if (!Node.isStringLiteral(expression)) {
      return false;
    }

    const raw = expression.getText();

    if (isStrictModeDirective(raw.slice(1, raw.length - 1))) {
      return true;
    }
  }

  return false;
}

/**
 * The two parameter-list facts `detectArgumentsHazard` records in a refusal.
 *
 * A list is *simple* when every parameter is a plain identifier with no
 * initialiser and no rest element — the condition under which a sloppy
 * function's arguments object is **mapped** to its parameter bindings. A
 * TypeScript `this` parameter is excluded from the count because it erases and
 * binds nothing at run time.
 *
 * @param fn The target's function-like node.
 * @returns The list's shape and its runtime parameter count.
 */
function parameterListFacts(fn: PatchableFunctionNode): {
  readonly parameterList: 'simple' | 'non-simple';
  readonly parameterCount: number;
} {
  const parameters = fn.getParameters();
  let parameterCount = 0;
  let simple = true;

  for (const [index, parameter] of parameters.entries()) {
    if (index === 0 && isThisParameter(parameter)) {
      continue;
    }

    parameterCount += 1;

    if (
      !Node.isIdentifier(parameter.getNameNode()) ||
      parameter.hasInitializer() ||
      parameter.isRestParameter()
    ) {
      simple = false;
    }
  }

  return { parameterList: simple ? 'simple' : 'non-simple', parameterCount };
}

/**
 * Whether a parameter is TypeScript's `this` parameter — the annotation-only
 * first parameter that types the receiver and emits nothing.
 *
 * @param parameter The parameter to test.
 * @returns `true` for a `this` parameter.
 */
function isThisParameter(parameter: ParameterDeclaration): boolean {
  return parameter.getName() === THIS_PARAMETER_NAME && !parameter.isRestParameter();
}

/**
 * What the wrapper passes as the inner function's receiver.
 *
 * The rule, in the order it is applied:
 *
 * - An **arrow** target ignores a receiver entirely — its `this` is lexical and
 *   its inner function is another arrow — so it passes `undefined`.
 * - A **method** passes `this`: the receiver is the instance, and it is typed,
 *   so forwarding it costs nothing and a method body that uses `this` requires
 *   it.
 * - In a **JavaScript** file, every remaining shape passes `this`. There is no
 *   type-check to satisfy, and a function declaration can legitimately be
 *   called as a method, so forwarding is the behaviour-preserving choice.
 * - In a **TypeScript** file, a standalone function passes `this` only when it
 *   declares a `this` parameter or its body actually reads `this`. Otherwise it
 *   passes `undefined`, because `noImplicitThis` — part of `strict` — makes
 *   *any* mention of `this` in a standalone function an error that no type
 *   assertion suppresses, and a wrapper that broke the developer's type-check
 *   would be a wrapper they had to undo.
 *
 * The last case is the one worth stating plainly: when the body does read
 * `this`, behaviour preservation wins over the type-check. Such a file already
 * fails `noImplicitThis` on its own body, so forwarding the receiver cannot
 * make it worse — while dropping the receiver would change what the function
 * computes.
 *
 * @param target The resolved target.
 * @param language The syntax being emitted.
 * @param callStyle The call style its shape implies.
 * @returns The receiver to emit.
 */
function resolveReceiver(
  target: ResolvedTarget,
  language: PatchLanguage,
  callStyle: WrapperCallStyle,
): WrapperReceiver {
  if (callStyle === 'rest') {
    return 'undefined';
  }

  if (target.shape === 'method' || language === 'javascript') {
    return 'this';
  }

  const firstParameter = target.fn.getParameters()[0];

  if (firstParameter !== undefined && firstParameter.getName() === 'this') {
    return 'this';
  }

  return scanReceiverUsage(target.body).referencesThis ? 'this' : 'undefined';
}

/**
 * Allocates the wrapper's identifiers, renaming them only if the target
 * already binds one.
 *
 * The defaults from `./wrap-template.js` are used unchanged in the
 * overwhelmingly common case, which is what keeps the emitted text — and
 * therefore `instrumentedHash` — the same for the same input. When the target
 * *does* bind `__orig`, `__dbg` or `__args`, a numbered suffix is appended: the
 * scan is over the identifiers of the target declaration in source order, so
 * the choice is a function of the input text and nothing else.
 *
 * The scan is scoped to the declaration rather than the file on purpose. A
 * binding elsewhere in the file cannot collide with a name declared inside this
 * function, and a *reference* to such a binding from inside the body would
 * appear in this declaration's identifiers and so be seen — which is the case
 * that actually matters, because shadowing a binding the body reads is what
 * would change its behaviour. Scoping it here is also what lets a second symbol
 * in an already-patched file keep the default names.
 *
 * @param target The resolved target.
 * @param callStyle The call style its shape implies.
 * @param file The project-relative path, for the refusal details.
 * @returns The identifiers, or a refusal when no free name could be found.
 */
function allocateIdentifiers(
  target: ResolvedTarget,
  callStyle: WrapperCallStyle,
  file: string,
): Result<AllocatedIdentifiers> {
  const taken = new Set<string>([target.declaredName]);

  for (const identifier of target.declaration.getDescendantsOfKind(SyntaxKind.Identifier)) {
    taken.add(identifier.getText());
  }

  const inner = allocateIdentifier(INNER_FUNCTION_IDENTIFIER, taken);
  const helper = allocateIdentifier(HELPER_LOCAL_IDENTIFIER, taken);
  const rest =
    callStyle === 'rest' ? allocateIdentifier(REST_PARAMETER_IDENTIFIER, taken) : undefined;

  if (inner === undefined || helper === undefined || (callStyle === 'rest' && rest === undefined)) {
    return err(
      refusal(
        'PATCH_UNSUPPORTED',
        'identifier-unavailable',
        'No free name was available for the wrapper: the target already binds every candidate.',
        { file, symbol: target.declaredName, maxSuffix: MAX_IDENTIFIER_SUFFIX },
        'Rename the conflicting local in the target function, or time a different symbol.',
      ),
    );
  }

  return ok({
    inner,
    helper,
    rest,
    disambiguated:
      inner !== INNER_FUNCTION_IDENTIFIER ||
      helper !== HELPER_LOCAL_IDENTIFIER ||
      (rest !== undefined && rest !== REST_PARAMETER_IDENTIFIER),
  });
}

/**
 * The first unused name in the deterministic sequence `base`, `base_1`,
 * `base_2`, …
 *
 * Reserves the name it returns by adding it to `taken`, so three allocations
 * from one set cannot answer with the same name.
 *
 * @param base The template's default identifier.
 * @param taken The names already bound, mutated to include the answer.
 * @returns The allocated name, or `undefined` when the bound was reached.
 */
function allocateIdentifier(base: string, taken: Set<string>): string | undefined {
  if (!taken.has(base)) {
    taken.add(base);

    return base;
  }

  for (let suffix = 1; suffix <= MAX_IDENTIFIER_SUFFIX; suffix += 1) {
    const candidate = `${base}_${String(suffix)}`;

    if (!taken.has(candidate)) {
      taken.add(candidate);

      return candidate;
    }
  }

  return undefined;
}

/**
 * The edit that rewrites the target, chosen by its call style.
 *
 * @param target The resolved target.
 * @param originalText The text the patch is computed against.
 * @param wrapper The built wrapper.
 * @param callStyle The call style the target's shape implies.
 * @param file The project-relative path, for the refusal details.
 * @returns The edit, or a refusal when the target's syntax could not be read or
 * its receiver could not be typed.
 */
function buildTargetEdit(
  target: ResolvedTarget,
  originalText: string,
  wrapper: WrapperBody,
  callStyle: WrapperCallStyle,
  file: string,
): Result<PatchEdit> {
  return callStyle === 'rest'
    ? buildArrowEdit(target, originalText, wrapper)
    : buildBodyEdit(target, originalText, wrapper, file);
}

/**
 * Replaces the body of a function declaration, function expression or method.
 *
 * Only the body's own range changes, so the signature the module exports — the
 * parameter list with its destructuring patterns and defaults, the type
 * parameters, the return-type annotation, the `async`, `export` and `default`
 * modifiers, any decorator and the declaration's own leading comments — is not
 * even read, let alone rewritten. The framework that resolves an exported route
 * handler by name still finds it under that name.
 *
 * The original body is embedded **verbatim** as the inner function's body: not
 * re-indented, not reformatted, not re-emitted from the syntax tree. See this
 * module's overview for the two reasons — a diff that claims only what changed,
 * and multi-line template literals whose contents are part of the string.
 *
 * @param target The resolved target, whose `body` is the block to move.
 * @param originalText The text the patch is computed against.
 * @param wrapper The built wrapper.
 * @param file The project-relative path, for the refusal details.
 * @returns The edit, or the refusal {@link innerThisParameter} returns for a
 * receiver the inner function cannot declare.
 */
function buildBodyEdit(
  target: ResolvedTarget,
  originalText: string,
  wrapper: WrapperBody,
  file: string,
): Result<PatchEdit> {
  const thisParameter = innerThisParameter(target, wrapper, file);

  if (!thisParameter.ok) {
    return thisParameter;
  }

  const start = target.body.getStart();
  const end = target.body.getEnd();
  const newline = detectNewline(originalText);
  const declarationIndent = lineIndentAt(originalText, start);
  const innerIndent = innerIndentFor(originalText, start, end, declarationIndent);
  const fn = target.fn;
  const asyncPrefix = !Node.isArrowFunction(fn) && fn.isAsync() ? 'async ' : '';

  // `async` is carried onto the inner function because the body may contain
  // `await`, and it stays on the outer one because that is the signature the
  // module published. The wrapper returns the inner call unchanged either way:
  // it never awaits, so a promise stays a promise and a synchronous throw stays
  // synchronous.
  const innerDeclaration = `${asyncPrefix}function ${wrapper.innerIdentifier}(${thisParameter.value}) ${originalText.slice(start, end)}`;

  return ok({
    start,
    end,
    replacement: [
      '{',
      `${innerIndent}${innerDeclaration}`,
      indentLines(wrapper.text, innerIndent, newline),
      `${declarationIndent}}`,
    ].join(newline),
    purpose: 'function-body',
  });
}

/**
 * The `this` parameter the inner function declares, the empty string when none
 * applies, or a refusal when the receiver cannot be typed at all.
 *
 * A TypeScript-only annotation, and the reason it exists is a type error that
 * would otherwise be *introduced* by the patch. The moved body keeps whatever
 * `this` references it had, but it now sits inside a function of its own, where
 * `noImplicitThis` — part of `strict` — reports "'this' implicitly has type
 * 'any'" for every one of them. The receiver is forwarded correctly at run time
 * either way; what the annotation fixes is the developer's type-check, which a
 * temporary patch has no business breaking.
 *
 * `this: this` is not an option — TypeScript allows the `this` *type* only in a
 * class or interface member, not in a function nested inside one, and answers
 * `TS2526` when asked — so the receiver's type is **named**, by these rules in
 * this order:
 *
 * 1. A target that declares its own `this` parameter **with** a type lends that
 *    annotation verbatim: it is exactly the type the body was written against.
 * 2. A `this` parameter with no type yields no annotation. Such a file already
 *    fails `noImplicitThis` on its own, and guessing a type for it would be
 *    this function inventing a receiver the developer did not state.
 * 3. A target that is not a method yields no annotation: a standalone
 *    function's `this` is the call-time receiver and no type names it.
 * 4. A **static** method names the constructor: `this: typeof C`, never with
 *    type arguments. `this: C` there is wrong — the receiver is the class
 *    object, measured as `TS2345` "Argument of type 'typeof C' is not
 *    assignable to parameter of type 'C'" — and `this: typeof C<T>` is wrong
 *    twice over, because a static member may not reference the class's type
 *    parameters at all (`TS2302`).
 * 5. An **instance** method names the class with its type parameters applied by
 *    name (`this: C<T, U>`), all of which are in scope inside the method.
 * 6. A method that relies on the **polymorphic `this` type** is refused; see
 *    {@link polymorphicThisSite} for what that means and why naming the
 *    concrete class instead would be a silent behaviour change in files this
 *    module cannot see.
 * 7. A method of an **anonymous** class — reachable as
 *    `export default class { … }` — is refused when its body reads `this`,
 *    because there is no name to put in the annotation and leaving it off
 *    produces `TS2683` ("'this' implicitly has type 'any'") in the developer's
 *    build. When the body does not read `this`, nothing is emitted and the
 *    patch proceeds.
 *
 * Name **shadowing** needs no rule of its own. A binding that hides the class
 * name at the annotation's position surfaces as `TS2339`/`TS2345`, and
 * `FunctionTimingPatcher`'s receiver-typing pre-flight refuses on exactly those
 * codes — measured for the case that actually shadows the annotation, a method
 * type parameter named after its class. Writing a scanner for it here would
 * duplicate a check that already answers from the compiler.
 *
 * Emitted only when the wrapper actually forwards a receiver, and never into a
 * JavaScript file, where a parameter annotation is a syntax error. It erases
 * completely, so arity, `arguments` and the forwarded call are untouched.
 *
 * @param target The resolved target.
 * @param wrapper The built wrapper, for its language and receiver.
 * @param file The project-relative path, for the refusal details.
 * @returns `ok('this: T')`, `ok('')` when no annotation applies, or a refusal.
 */
function innerThisParameter(
  target: ResolvedTarget,
  wrapper: WrapperBody,
  file: string,
): Result<string> {
  if (wrapper.language !== 'typescript' || wrapper.receiver !== 'this') {
    return ok('');
  }

  const fn = target.fn;
  const firstParameter = fn.getParameters()[0];

  if (firstParameter !== undefined && isThisParameter(firstParameter)) {
    const typeNode = firstParameter.getTypeNode();

    if (typeNode === undefined) {
      return ok('');
    }

    // A declared receiver of `this` — or one containing it, such as
    // `this[]` — is the polymorphic type again, under rule 6 rather than 1.
    if (containsThisType(typeNode)) {
      return err(polymorphicThisRefusal(target, file, 'this-parameter'));
    }

    return ok(`this: ${typeNode.getText()}`);
  }

  if (target.shape !== 'method') {
    return ok('');
  }

  const owner = fn.getParent();

  if (!Node.isClassDeclaration(owner) && !Node.isClassExpression(owner)) {
    return ok('');
  }

  const polymorphicSite = polymorphicThisSite(target, owner);

  if (polymorphicSite !== undefined) {
    return err(polymorphicThisRefusal(target, file, polymorphicSite));
  }

  const name = owner.getName();

  if (name === undefined) {
    if (!scanReceiverUsage(target.body).referencesThis) {
      return ok('');
    }

    return err(
      refusal(
        'PATCH_UNSUPPORTED',
        'unsupported-anonymous-class',
        'The target is a method of an anonymous class and its body reads this, so there is no class name the inner function could annotate its receiver with.',
        { file, symbol: target.declaredName, shape: target.shape },
        'Give the class a name — export default class Name { … } — and the method becomes patchable.',
      ),
    );
  }

  if (Node.isMethodDeclaration(fn) && fn.isStatic()) {
    return ok(`this: typeof ${name}`);
  }

  const typeParameters = owner.getTypeParameters().map((parameter) => parameter.getName());

  return ok(`this: ${name}${typeParameters.length === 0 ? '' : `<${typeParameters.join(', ')}>`}`);
}

/**
 * Where a method was found to depend on the polymorphic `this` type, as the
 * value carried in the refusal's details.
 *
 * - `'this-parameter'` — its own `this` parameter is declared as `this`.
 * - `'signature'` — a `this` type in the return type, a parameter type, or a
 *   type parameter's constraint or default.
 * - `'body-annotation'` — a `this` type in an annotation inside the body, which
 *   would move into a plain function where no `this` type exists (`TS2526`).
 * - `'returned-this'` — no declared return type, and the receiver escapes
 *   through a `return`, so the method's *inferred* return type is `this`.
 * - `'delegated-this'` — no declared return type, and the method returns the
 *   result of a sibling member that itself answers with the `this` type, so the
 *   inferred return type is `this` at one remove.
 */
type PolymorphicThisSite =
  'this-parameter' | 'signature' | 'body-annotation' | 'returned-this' | 'delegated-this';

/**
 * Whether — and where — a method relies on the polymorphic `this` type.
 *
 * The `this` *type* means "the type of the receiver at the call site", which is
 * what makes a fluent API work through a subclass: `class B extends A` inherits
 * a method declared `(): this` and callers of `new B().step()` receive a `B`.
 * The inner function the patch declares cannot carry that type — `this: this` is
 * `TS2526` — and naming the concrete class instead is worse than an error,
 * because it *compiles*: the method's type quietly narrows from `this` to the
 * class, and the chained call in some other file that relied on the subclass
 * type stops type-checking, or silently loses members. Measured on this
 * module's own emitted shape, `return () => this` annotated with `this: C`
 * produces **no diagnostic at all** in the patched file — so no same-file check,
 * including the semantic pre-flight, can catch it. Refusing the target is the
 * only honest answer.
 *
 * The scan of the fourth case skips nested `function`s, methods, accessors and
 * static blocks — each of which has a `this` of its own — but deliberately not
 * arrows: `return () => this` returns a closure over the method's receiver, and
 * its type carries `this` just as `return this` does.
 *
 * The fifth case is the same dependency at one remove, and it is the one a
 * fluent class is most likely to be written with: `run() { return this.step(); }`
 * beside `step(): this`. Nothing in the patched file is wrong — measured, the
 * patched method type-checks cleanly — but the method's inferred return type has
 * narrowed from `this` to the class, and the breakage lands at a *call site*:
 * `const x: B = new B().run()` becomes `TS2741` in a file the in-memory
 * verification project never loads. See {@link delegatesReceiverType} for the
 * bound on how far that is followed.
 *
 * @param target The resolved target, a class method.
 * @param owner The class that declares it, whose members the fifth case reads.
 * @returns The site, or `undefined` when nothing depends on the `this` type.
 */
function polymorphicThisSite(
  target: ResolvedTarget,
  owner: ReceiverOwner,
): PolymorphicThisSite | undefined {
  const fn = target.fn;
  const returnTypeNode = fn.getReturnTypeNode();
  const signatureTypes: readonly (Node | undefined)[] = [
    returnTypeNode,
    ...fn.getParameters().map((parameter) => parameter.getTypeNode()),
    ...fn
      .getTypeParameters()
      .flatMap((parameter) => [parameter.getConstraint(), parameter.getDefault()]),
  ];

  for (const node of signatureTypes) {
    if (node !== undefined && containsThisType(node)) {
      return 'signature';
    }
  }

  if (target.body.getDescendantsOfKind(SyntaxKind.ThisType).length > 0) {
    return 'body-annotation';
  }

  // With a declared return type there is nothing to infer: a `return this`
  // under an annotation that is not `this` is already an error in the
  // developer's own file, and one under `(): this` was caught above.
  if (returnTypeNode !== undefined) {
    return undefined;
  }

  if (returnsReceiver(target.body)) {
    return 'returned-this';
  }

  if (
    delegatesReceiverType(
      owner,
      target.body,
      Node.isMethodDeclaration(fn) && fn.isStatic(),
      new Set<string>(),
      0,
    )
  ) {
    return 'delegated-this';
  }

  return undefined;
}

/**
 * Whether a type node is, or contains, the `this` type.
 *
 * Containment rather than identity because `this` composes: `this[]`,
 * `Promise<this>`, `this | undefined` and `Readonly<this>` all carry the
 * polymorphic type into the annotation.
 *
 * @param typeNode The type node to inspect.
 * @returns `true` when the `this` type appears anywhere inside it.
 */
function containsThisType(typeNode: Node): boolean {
  return (
    Node.isThisTypeNode(typeNode) ||
    typeNode.getFirstDescendantByKind(SyntaxKind.ThisType) !== undefined
  );
}

/**
 * Whether the receiver escapes through one of a body's `return` statements.
 *
 * A `this` that is only ever the *object* of a property or element access —
 * `return this.total`, `return this.load()`, `return this['key']` — does not
 * escape: what is returned is the property's type, not the receiver's, so the
 * annotation cannot narrow anything a caller can observe. That distinction is
 * what keeps the overwhelmingly common `this`-reading method patchable, which
 * AAP §0.5.1 requires of this transform; every other position (`return this`,
 * `return [this]`, `return { self: this }`, `return () => this`,
 * `return cond ? this : other`) is treated as an escape, erring towards a
 * refusal the developer can read.
 *
 * @param body The method's body.
 * @returns `true` when a `return` carries the receiver out of the method.
 */
function returnsReceiver(body: Node): boolean {
  let escapes = false;

  body.forEachDescendant((node, traversal): undefined => {
    if (RECEIVER_REBINDING_KINDS.includes(node.getKind())) {
      traversal.skip();

      return undefined;
    }

    if (!Node.isReturnStatement(node)) {
      return undefined;
    }

    const expression = node.getExpression();

    if (expression !== undefined && carriesReceiver(expression)) {
      escapes = true;
    }

    return undefined;
  });

  return escapes;
}

/**
 * Whether an expression carries the receiver itself, rather than reading
 * through it.
 *
 * @param expression The returned expression.
 * @returns `true` when a `this` appears in a position whose value is the
 * receiver.
 */
function carriesReceiver(expression: Node): boolean {
  if (expression.getKind() === SyntaxKind.ThisKeyword) {
    return true;
  }

  let carries = false;

  expression.forEachDescendant((node, traversal): undefined => {
    if (RECEIVER_REBINDING_KINDS.includes(node.getKind())) {
      traversal.skip();

      return undefined;
    }

    if (node.getKind() !== SyntaxKind.ThisKeyword) {
      return undefined;
    }

    const parent = node.getParent();
    const readThrough =
      (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) &&
      parent.getExpression() === node;

    if (!readThrough) {
      carries = true;
    }

    return undefined;
  });

  return carries;
}

/** A class-like declaration that can own a method and type its receiver. */
type ReceiverOwner = ClassDeclaration | ClassExpression;

/** A class member whose declared type can carry the polymorphic `this`. */
type ReceiverMember = GetAccessorDeclaration | MethodDeclaration | PropertyDeclaration;

/**
 * How many sibling members deep the delegated-receiver scan follows an
 * undeclared return type.
 *
 * Bounded because the scan is a graph walk over a class's own members and a
 * class may be written with any amount of internal delegation; four is past
 * every shape this is meant to catch — a method returning a builder step that
 * itself returns `this`. Reaching the bound means the scan ran out of budget
 * with the question still open, which is **not** an answer of "safe": it
 * refuses, like every other case this module cannot prove.
 */
const MAX_DELEGATION_DEPTH = 4;

/** How many transparent wrappers may hide the expression a `return` answers. */
const MAX_RETURN_UNWRAP_DEPTH = 8;

/**
 * Whether a method's inferred return type is the polymorphic `this` because it
 * hands back what a **sibling member** answered.
 *
 * `run() { return this.step(); }` beside `step(): this` is the fluent shape
 * this exists for: the receiver never appears in `run`'s own `return`, so
 * {@link returnsReceiver} does not see it, and the patched file type-checks
 * perfectly — the narrowing shows up only where the method is *called*, in a
 * file the verification project holds no copy of. A syntactic answer is the only
 * one available, so this is deliberately narrow and deliberately honest about
 * where it stops:
 *
 * - Only a member read **directly** off the receiver counts — `this.m`,
 *   `this['m']` or either of them called, through any number of parentheses,
 *   `await`s and type assertions. A longer chain (`this.items.map(…)`,
 *   `this.service.load()`) answers with some other object's member and is not
 *   followed, which is what keeps the commonest method bodies patchable.
 * - A member that **declares** a return type is decided by that type alone.
 * - A member that declares none is followed into its own body, up to
 *   {@link MAX_DELEGATION_DEPTH}, with each member visited once so a cycle
 *   (`a() { return this.b(); } b() { return this.a(); }`) terminates.
 * - Static and instance members are looked up separately: a static method
 *   delegating to `this.make()` reaches the static `make`, never an instance
 *   member of the same name.
 * - A name the class does **not** declare is a refusal when the class extends
 *   or implements anything, and otherwise is not: a base class in another file
 *   may well answer `this` and nothing readable here will say, whereas a name
 *   no base could supply is the developer's own error and already reported in
 *   their file. A computed access (`this[key]`) resolves to no name and is
 *   decided by that same rule.
 *
 * @param owner The class that declares both members.
 * @param body The body to read the `return` statements of.
 * @param isStatic Whether the receiver is the constructor rather than an
 * instance, which decides which members `this.m` can name.
 * @param seen The members already followed, keyed by staticness and name.
 * @param depth How many members have been followed to get here.
 * @returns `true` when the receiver type escapes through a sibling member.
 */
function delegatesReceiverType(
  owner: ReceiverOwner,
  body: Node,
  isStatic: boolean,
  seen: Set<string>,
  depth: number,
): boolean {
  // Exhausting the bound is "not proven safe", not "proven safe": the scan ran
  // out of budget with the question open, and the answer to an open question
  // about a developer's build is a refusal.
  if (depth >= MAX_DELEGATION_DEPTH) {
    return true;
  }

  let delegates = false;

  /**
   * Decides one expression that leaves the method as its value.
   *
   * @param expression The answered expression, or `undefined`.
   */
  const consider = (expression: Node | undefined): void => {
    const name = delegatedMemberName(expression);

    if (name === undefined) {
      return;
    }

    const key = `${isStatic ? 'static' : 'instance'}:${name}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    const member = findReceiverMember(owner, name, isStatic);

    if (member === undefined) {
      // The class does not declare it. Either the member does not exist — which
      // is the developer's own error, already reported in their file, and not
      // something to refuse over — or it is inherited from, or mixed in by, a
      // base class whose declaration is in another file this module holds no
      // copy of. In that second case the member may well answer `this`, and no
      // amount of reading this file will say, so a heritage clause turns the
      // unresolved name into a refusal.
      delegates = owner.getHeritageClauses().length > 0;

      return;
    }

    if (memberAnswersReceiver(owner, member, isStatic, seen, depth)) {
      delegates = true;
    }
  };

  body.forEachDescendant((node, traversal): undefined => {
    if (RECEIVER_REBINDING_KINDS.includes(node.getKind())) {
      traversal.skip();

      return undefined;
    }

    if (delegates) {
      return undefined;
    }

    if (Node.isReturnStatement(node)) {
      consider(node.getExpression());
    }

    return undefined;
  });

  return delegates;
}

/**
 * The name of the receiver's own member a `return` hands back, or `undefined`
 * when it hands back something else.
 *
 * A returned **concise arrow** is looked through, because its type is the type
 * of the expression it answers: `return () => this.step()` is `() => this` when
 * `step` answers `this`, and a concise body has no `return` statement for the
 * caller's statement scan to reach. A *block*-bodied arrow needs nothing here —
 * arrows are not in {@link RECEIVER_REBINDING_KINDS}, so its own `return`
 * statements are reached by that same scan, which is exactly how
 * {@link returnsReceiver} treats the two forms.
 *
 * @param expression The returned expression, or `undefined` for a bare
 * `return`.
 * @returns The member's name, or `undefined`.
 */
function delegatedMemberName(expression: Node | undefined): string | undefined {
  let returned = unwrapTransparentExpression(expression);

  for (let depth = 0; depth < MAX_RETURN_UNWRAP_DEPTH; depth += 1) {
    if (returned === undefined || !Node.isArrowFunction(returned)) {
      break;
    }

    const arrowBody = returned.getBody();

    if (Node.isBlock(arrowBody)) {
      return undefined;
    }

    returned = unwrapTransparentExpression(arrowBody);
  }

  if (returned === undefined) {
    return undefined;
  }

  const accessed = Node.isCallExpression(returned)
    ? unwrapTransparentExpression(returned.getExpression())
    : returned;

  if (accessed === undefined) {
    return undefined;
  }

  if (Node.isPropertyAccessExpression(accessed)) {
    return accessed.getExpression().getKind() === SyntaxKind.ThisKeyword
      ? accessed.getName()
      : undefined;
  }

  // `this['self']` names a member exactly as `this.self` does, and
  // `this[key]` names one this module cannot know: the first is looked up, and
  // the second answers with a name no class declares, which
  // `delegatesReceiverType` turns into a refusal whenever the class could have
  // inherited the member — the conservative reading of "cannot be proven".
  if (Node.isElementAccessExpression(accessed)) {
    if (accessed.getExpression().getKind() !== SyntaxKind.ThisKeyword) {
      return undefined;
    }

    const argument = accessed.getArgumentExpression();

    if (argument === undefined) {
      return undefined;
    }

    return Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)
      ? argument.getLiteralText()
      : UNRESOLVED_MEMBER_NAME;
  }

  return undefined;
}

/**
 * The name stood in for a member read off the receiver whose spelling is not
 * statically known, as in `return this[key]`.
 *
 * Deliberately a name no class can declare — a computed access is the one form
 * whose target cannot be looked up — so
 * {@link delegatesReceiverType}'s unresolved-member branch decides it, under
 * the same rule as an inherited member.
 */
const UNRESOLVED_MEMBER_NAME = '\u0000unresolved';

/**
 * The expression a `return` really answers, looking through the wrappers that
 * do not change its value.
 *
 * `await` is included because `Promise<this>` carries the polymorphic type just
 * as `this` does, and the type assertions are included because a target may
 * well be written with one.
 *
 * @param expression The expression to unwrap, or `undefined`.
 * @returns The innermost expression, or `undefined`.
 */
function unwrapTransparentExpression(expression: Node | undefined): Node | undefined {
  let current = expression;

  for (let depth = 0; depth < MAX_RETURN_UNWRAP_DEPTH; depth += 1) {
    if (current === undefined) {
      return undefined;
    }

    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAwaitExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isTypeAssertion(current)
    ) {
      current = current.getExpression();
      continue;
    }

    return current;
  }

  return undefined;
}

/**
 * The class's own method, get accessor or property of that name and staticness.
 *
 * @param owner The class to search.
 * @param name The member name read off the receiver.
 * @param isStatic Whether a static or an instance member is wanted.
 * @returns The member, or `undefined` when the class declares none — an
 * inherited one, whose declaration is in another file this module holds no copy
 * of, included.
 */
function findReceiverMember(
  owner: ReceiverOwner,
  name: string,
  isStatic: boolean,
): ReceiverMember | undefined {
  const members: readonly ReceiverMember[] = [
    ...owner.getMethods(),
    ...owner.getGetAccessors(),
    ...owner.getProperties(),
  ];

  return members.find((member) => member.getName() === name && member.isStatic() === isStatic);
}

/**
 * Whether a member answers with the polymorphic `this` type.
 *
 * Decided by its declared type where it has one, and otherwise by following it:
 * a method or accessor into its body, and a property into its initialiser,
 * which is the one shape a field can carry the receiver in (`self = this`).
 *
 * @param owner The class that declares it.
 * @param member The member being followed.
 * @param isStatic The staticness the lookup was made under.
 * @param seen The members already followed.
 * @param depth How many members have been followed to get here.
 * @returns `true` when the member's type is, or contains, the `this` type.
 */
function memberAnswersReceiver(
  owner: ReceiverOwner,
  member: ReceiverMember,
  isStatic: boolean,
  seen: Set<string>,
  depth: number,
): boolean {
  if (Node.isPropertyDeclaration(member)) {
    const typeNode = member.getTypeNode();

    if (typeNode !== undefined) {
      return containsThisType(typeNode);
    }

    const initializer = member.getInitializer();

    return initializer !== undefined && carriesReceiver(initializer);
  }

  const returnTypeNode = member.getReturnTypeNode();

  if (returnTypeNode !== undefined) {
    return containsThisType(returnTypeNode);
  }

  const memberBody = member.getBody();

  if (memberBody === undefined) {
    return false;
  }

  return (
    returnsReceiver(memberBody) ||
    delegatesReceiverType(owner, memberBody, isStatic, seen, depth + 1)
  );
}

/**
 * The refusal a polymorphic-`this` target earns.
 *
 * @param target The resolved target.
 * @param file The project-relative path, for the refusal details.
 * @param site Where the dependency was found.
 * @returns The coded refusal.
 */
function polymorphicThisRefusal(
  target: ResolvedTarget,
  file: string,
  site: PolymorphicThisSite,
): DebuggenError {
  return refusal(
    'PATCH_UNSUPPORTED',
    'unsupported-polymorphic-this',
    "The target depends on the polymorphic this type, which the inner function cannot declare: naming the concrete class instead would narrow the method's type and break subclass call sites in other files without any error in this one.",
    { file, symbol: target.declaredName, container: target.container, site },
    'Declare the receiver and return types concretely, or time a method that does not hand its receiver back to its caller.',
  );
}

/**
 * Replaces an arrow function with an arrow wrapper around an inner arrow.
 *
 * The wrapper **stays an arrow**, which is the whole point: an arrow's `this`
 * is lexical, and a callback handed by reference to `Array.prototype.map` or
 * `Array.prototype.sort` must keep receiving its positional arguments and
 * producing the same values. The rest parameter replaces the original parameter
 * list — an arrow binds no `arguments` to forward — and the original parameter
 * list, with its own defaults and destructuring, moves to the inner arrow where
 * those defaults still apply to the arguments that were genuinely omitted.
 *
 * Three slices of the original are reused verbatim, so nothing about the head is
 * re-emitted: everything before the parameter list (the `async` modifier and any
 * type parameters), everything between the parameter list and the `=>` (the
 * return-type annotation), and — for the inner arrow — the whole head as
 * written.
 *
 * An expression body is normalised to a `return` of that expression, wrapped in
 * parentheses: a comma expression, an object literal and a multi-line
 * expression all keep their meaning, and no automatic semicolon can be inserted
 * between the keyword and the value.
 *
 * @param target The resolved target, whose `fn` is the arrow to replace.
 * @param originalText The text the patch is computed against.
 * @param wrapper The built wrapper, whose `restParameter` is required here.
 * @returns The edit, or a refusal when the arrow's syntax could not be read.
 */
function buildArrowEdit(
  target: ResolvedTarget,
  originalText: string,
  wrapper: WrapperBody,
): Result<PatchEdit> {
  const fn = target.fn;

  if (!Node.isArrowFunction(fn)) {
    return err(
      refusal(
        'INTERNAL',
        'shape-mismatch',
        'The rest-parameter wrapper was built for a target that is not an arrow function.',
        { symbol: target.declaredName, shape: target.shape },
      ),
    );
  }

  const restParameter = wrapper.restParameter;

  if (restParameter === undefined) {
    return err(
      refusal(
        'INTERNAL',
        'missing-rest-parameter',
        'The rest-parameter wrapper was built without a rest parameter.',
        { symbol: target.declaredName },
      ),
    );
  }

  const start = fn.getStart();
  const end = fn.getEnd();
  const arrowEnd = fn.getEqualsGreaterThan().getEnd();
  const openParen = fn.getFirstChildByKind(SyntaxKind.OpenParenToken);
  const closeParen = fn.getLastChildByKind(SyntaxKind.CloseParenToken);
  const soleParameter = fn.getParameters()[0];

  // A parenthesised list is the usual form; `x => x` has no parentheses at all,
  // and its single parameter's own range is what the rest parameter replaces.
  // The parentheses of a parenthesised return type are inside that type node
  // rather than direct children of the arrow, so they cannot be mistaken for
  // the list's.
  const parameters =
    openParen !== undefined && closeParen !== undefined
      ? { start: openParen.getStart(), end: closeParen.getEnd() }
      : soleParameter === undefined
        ? undefined
        : { start: soleParameter.getStart(), end: soleParameter.getEnd() };

  if (parameters === undefined) {
    return err(
      refusal(
        'INTERNAL',
        'arrow-parameters-unreadable',
        'The arrow function declares neither a parenthesised parameter list nor a single parameter.',
        { symbol: target.declaredName },
      ),
    );
  }

  const newline = detectNewline(originalText);
  const declarationIndent = lineIndentAt(originalText, start);
  const body = target.body;
  const isBlockBody = Node.isBlock(body);
  const innerIndent = isBlockBody
    ? innerIndentFor(originalText, body.getStart(), body.getEnd(), declarationIndent)
    : `${declarationIndent}${DEFAULT_INDENT}`;
  const head = originalText.slice(start, arrowEnd);
  const bodyRegion = originalText.slice(arrowEnd, body.getEnd());
  const innerArrow = isBlockBody
    ? `${head}${bodyRegion}`
    : `${head} { return (${bodyRegion.trim()}); }`;
  const outerHead = `${originalText.slice(start, parameters.start)}(${restParameter})${originalText.slice(
    parameters.end,
    arrowEnd,
  )}`;

  return ok({
    start,
    end,
    replacement: [
      `${outerHead} {`,
      `${innerIndent}const ${wrapper.innerIdentifier} = ${innerArrow};`,
      indentLines(wrapper.text, innerIndent, newline),
      `${declarationIndent}}`,
    ].join(newline),
    purpose: 'function-declaration',
  });
}

/**
 * Whether the file already declares the helper type alias.
 *
 * Asked before every insertion, which is what makes "one alias per file" true
 * across a second symbol in the same file and across a second plan version
 * patching it again. The question is asked of the syntax tree rather than of
 * the text, so a mention of the name in a comment or a string is not mistaken
 * for a declaration.
 *
 * @param sourceFile The parsed copy of the target file.
 * @returns `true` when a type alias of that name is already declared.
 */
function hasHelperTypeAlias(sourceFile: SourceFile): boolean {
  return sourceFile.getTypeAlias(SPAN_HELPER_TYPE_NAME) !== undefined;
}

/**
 * The edit that inserts the helper type alias, at the one position that is safe.
 *
 * Three placements, in order of precedence:
 *
 * 1. **After the directive prologue.** A `"use client"` or `"use server"`
 *    string that stops being the first statement stops being a directive, and
 *    the module silently changes meaning — a client component treated as a
 *    server component, or a server function no longer callable from the client.
 *    `./wrap-template.js` states the directives as data; this is the placement
 *    that honours them.
 * 2. **After a banner comment.** A leading comment separated from the code by a
 *    blank line, or a non-documentation block comment at the very first byte, is
 *    a file banner — a licence, a provenance note — and belongs above whatever
 *    this module inserts. Inserting after it keeps it the file's first bytes,
 *    unchanged.
 * 3. **At the first statement's full start.** Which deliberately means *above* a
 *    documentation comment attached to that statement, so the alias cannot come
 *    between a declaration and its own documentation.
 *
 * @param sourceFile The parsed copy of the target file.
 * @param originalText The text the patch is computed against.
 * @param aliasText The alias line from `./wrap-template.js`.
 * @returns The insertion, as a zero-width edit.
 */
function buildAliasEdit(
  sourceFile: SourceFile,
  originalText: string,
  aliasText: string,
): PatchEdit {
  const newline = detectNewline(originalText);
  const statements = sourceFile.getStatements();
  const lastDirective = lastDirectivePrologueStatement(statements);

  if (lastDirective !== undefined) {
    const position = lastDirective.getEnd();

    return {
      start: position,
      end: position,
      replacement: `${newline}${aliasText}`,
      purpose: 'helper-type-alias',
    };
  }

  const firstStatement = statements[0];

  if (firstStatement === undefined) {
    const position = sourceFile.getEnd();

    return {
      start: position,
      end: position,
      replacement: `${newline}${aliasText}${newline}`,
      purpose: 'helper-type-alias',
    };
  }

  const bannerEnd = bannerCommentEnd(originalText, firstStatement);

  if (bannerEnd !== undefined) {
    return {
      start: bannerEnd,
      end: bannerEnd,
      replacement: `${newline}${aliasText}`,
      purpose: 'helper-type-alias',
    };
  }

  const position = firstStatement.getFullStart();

  return {
    start: position,
    end: position,
    replacement: `${aliasText}${newline}`,
    purpose: 'helper-type-alias',
  };
}

/**
 * The last statement of the file's directive prologue, or `undefined` when it
 * has none.
 *
 * The prologue is the unbroken run of string-expression statements at the top of
 * the file whose literal text `./wrap-template.js` recognises as a directive; a
 * directive is only a directive while it is in that run, so the scan stops at
 * the first statement that is not one.
 *
 * @param statements The file's top-level statements, in source order.
 * @returns The last directive statement, or `undefined`.
 */
function lastDirectivePrologueStatement(statements: readonly Statement[]): Statement | undefined {
  let last: Statement | undefined;

  for (const statement of statements) {
    if (!isDirectivePrologueStatement(statement)) {
      return last;
    }

    last = statement;
  }

  return last;
}

/**
 * Whether a statement is a directive this module must insert below.
 *
 * @param statement The statement to test.
 * @returns `true` for a string-expression statement whose unquoted text is one
 * of `./wrap-template.js`'s directive literals.
 */
function isDirectivePrologueStatement(statement: Statement): boolean {
  if (!Node.isExpressionStatement(statement)) {
    return false;
  }

  const expression = statement.getExpression();

  if (!Node.isStringLiteral(expression) && !Node.isNoSubstitutionTemplateLiteral(expression)) {
    return false;
  }

  return isDirectivePrologueLiteral(expression.getLiteralText());
}

/**
 * The end of the file's banner comment, or `undefined` when it has none.
 *
 * A comment counts as a banner when a blank line separates it from what
 * follows, or when it is a block comment at the very first byte that is not a
 * documentation comment. Both tests exist to tell a file-level banner apart from
 * a documentation comment attached to the first declaration: the first belongs
 * above the alias, the second must stay with its declaration.
 *
 * @param originalText The text the patch is computed against.
 * @param firstStatement The file's first statement, whose leading trivia holds
 * the candidates.
 * @returns The offset just past the banner, or `undefined`.
 */
function bannerCommentEnd(originalText: string, firstStatement: Statement): number | undefined {
  const ranges: readonly CommentRange[] = firstStatement.getLeadingCommentRanges();
  let bannerEnd: number | undefined;

  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];

    if (range === undefined) {
      continue;
    }

    const nextStart = ranges[index + 1]?.getPos() ?? firstStatement.getStart();
    const commentText = originalText.slice(range.getPos(), range.getEnd());
    const detached = countNewlines(originalText.slice(range.getEnd(), nextStart)) >= 2;
    const leadingBlock =
      range.getPos() === 0 && commentText.startsWith('/*') && !commentText.startsWith('/**');

    if (detached || leadingBlock) {
      bannerEnd = range.getEnd();
    }
  }

  return bannerEnd;
}

/**
 * Applies the edits and returns the patched text.
 *
 * Assembled forward in one pass, which is what makes "everything outside the
 * edits is byte-identical" a property of the algorithm rather than a claim: the
 * regions between the edits are copied out of the original untouched.
 *
 * The edits are required to be in ascending order and non-overlapping rather
 * than sorted into it. An overlap would mean this module had computed two
 * rewrites of the same characters — a defect, not a condition to recover from —
 * and the honest answer to a defect that would corrupt a developer's file is to
 * write nothing.
 *
 * @param originalText The text the patch is computed against.
 * @param edits The edits, ascending and non-overlapping.
 * @param file The project-relative path, for the refusal details.
 * @param symbol The wrapped symbol, for the refusal details.
 * @returns The patched text, or an `INTERNAL` refusal.
 */
function applyEdits(
  originalText: string,
  edits: readonly PatchEdit[],
  file: string,
  symbol: string,
): Result<string> {
  let cursor = 0;
  let patched = '';

  for (const edit of edits) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > originalText.length) {
      return err(
        refusal(
          'INTERNAL',
          'overlapping-edits',
          'The computed patch edits overlap or fall outside the file, so nothing was patched.',
          { file, symbol, start: edit.start, end: edit.end, length: originalText.length },
        ),
      );
    }

    patched += originalText.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }

  return ok(patched + originalText.slice(cursor));
}

/**
 * The leading whitespace of the line a position sits on.
 *
 * Used as the indentation of the wrapper's closing brace, so a patched
 * declaration closes where it opened whatever the file's indentation style is.
 *
 * @param text The text to read.
 * @param position The offset whose line is measured.
 * @returns The line's leading spaces and tabs, possibly empty.
 */
function lineIndentAt(text: string, position: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  let index = lineStart;

  while (index < position) {
    const character = text[index];

    if (character !== ' ' && character !== '\t') {
      break;
    }

    index += 1;
  }

  return text.slice(lineStart, index);
}

/**
 * The indentation to give the statements inserted inside a body.
 *
 * Taken from the body's own first indented line, so a project that indents with
 * four spaces or with tabs gets its own style back instead of this
 * repository's. A single-line body reveals nothing to copy, so one default
 * level is added to the declaration's indentation.
 *
 * Purely cosmetic, and deterministic: it is a function of the original text, so
 * it cannot make two patches of the same input differ.
 *
 * @param text The text to read.
 * @param start The body's start offset.
 * @param end The body's end offset.
 * @param declarationIndent The indentation of the line the body opens on.
 * @returns The indentation for the inserted statements.
 */
function innerIndentFor(
  text: string,
  start: number,
  end: number,
  declarationIndent: string,
): string {
  const lines = text.slice(start, end).split('\n');

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (line === undefined) {
      continue;
    }

    const trimmed = line.trimStart();

    if (trimmed.length === 0) {
      continue;
    }

    const indent = line.slice(0, line.length - trimmed.length);

    return indent.length > declarationIndent.length && indent.startsWith(declarationIndent)
      ? indent
      : `${declarationIndent}${DEFAULT_INDENT}`;
  }

  return `${declarationIndent}${DEFAULT_INDENT}`;
}

/**
 * Indents every line of a block of text.
 *
 * The wrapper's text arrives newline-separated from `./wrap-template.js`, which
 * knows nothing about where it will be placed; this is what places it. The
 * lines are re-joined with the file's own newline sequence, so a patch does not
 * change the line endings of the file it is inserted into.
 *
 * @param text The text to indent, newline-separated.
 * @param indent The indentation to prepend to each line.
 * @param newline The newline sequence to join with.
 * @returns The indented text.
 */
function indentLines(text: string, indent: string, newline: string): string {
  return text
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join(newline);
}

/**
 * How many line breaks a span of text contains.
 *
 * @param text The text to measure.
 * @returns The number of `'\n'` characters.
 */
function countNewlines(text: string): number {
  let count = 0;

  for (const character of text) {
    if (character === '\n') {
      count += 1;
    }
  }

  return count;
}
