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
 *   async function __orig(): Promise<Response> {
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
 * ## The patched file must still type-check
 *
 * AAP §0.5.1 requires a strict target project to keep type-checking with no
 * new dependency, and a strict project reads more than a function's runtime
 * behaviour: its **signature** — what callers and every type derived from the
 * function see — and the **contextual types** its `return` statements and
 * parameters were checked against. Moving a body into an inner function keeps
 * the first for free in the `'arguments'` style (the outer keeps its own
 * parameter list and return type) and loses the second unless it is restated:
 * the inner function therefore declares the outer's return type (a type
 * predicate as `boolean`, an assertion signature as `void`), so a literal
 * returned against a declared union does not widen into a `TS2322` the
 * developer's build reports and a single-file check cannot see when the
 * declared type is imported.
 *
 * ## Arrow functions take the other template
 *
 * An arrow function binds no `arguments`, so forwarding through `arguments`
 * would be a syntax error inside it. Arrow targets therefore use the template's
 * `'rest'` call style: the **wrapper stays an arrow**, takes a rest parameter,
 * and forwards it to an inner arrow that holds the original head — modifiers,
 * parameter list, return type — verbatim. Keeping the wrapper an arrow is what
 * preserves lexical `this` and what keeps a callback that was passed *by
 * reference* to `Array.prototype.map` or `Array.prototype.sort` behaving
 * identically, positional arguments and all. An expression body is normalised
 * to a `return` of that expression inside the inner arrow, wrapped in
 * parentheses so no comma expression, object literal or automatic semicolon
 * insertion can change its meaning.
 *
 * Three restatements keep an arrow's types what they were. The rest parameter
 * is annotated with the arrow's own parameter list as a labelled tuple, so the
 * exported signature — and `Parameters<typeof fn>` in every consumer — is
 * unchanged. The type-parameter list stays on the outer arrow only, so the
 * inner arrow's types refer to the outer's and the forwarded call returns the
 * original's type rather than a generic erased to `unknown`. And an arrow
 * contextually typed by its binding (`const handler: Handler = (request) =>
 * …`) has that context restated on the inner arrow with `satisfies`, so its
 * parameters and returned literals are typed exactly as before.
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
 * The same holds across patches. A second symbol in a file this session already
 * patched, and a follow-up plan version over such a file, are computed against
 * text that already carries the helper alias and earlier wrappers, so its lines
 * are not the developer's. The caller then passes the developer's own text as
 * {@link FunctionTimingRequest.locationText} — `./patcher.ts` reads it from the
 * backup at the root of the file's chain — and the position is resolved there.
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
  GetAccessorDeclaration,
  Identifier,
  MethodDeclaration,
  ParameterDeclaration,
  PropertyDeclaration,
  SourceFile,
  Statement,
  TypeNode,
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

import {
  REACT_RENDER_ACTION_TYPE,
  isFunctionLikeScope,
  parseSymbolSpelling,
  refusal,
  resolveTarget,
} from './target-resolver.js';
import type {
  PatchTargetShape,
  PatchableFunctionNode,
  ResolvedTarget,
  SymbolSpelling,
} from './target-resolver.js';

// The resolution vocabulary is defined once, in `./target-resolver.ts`, which
// `../feasibility.ts` shares; it stays part of this module's public surface so
// the package entry keeps exporting it from the patcher it describes.
export {
  PATCH_NON_ADDRESSABLE_POSITIONS,
  PATCH_TARGET_SHAPES,
  QUALIFIED_SYMBOL_SEPARATORS,
} from './target-resolver.js';
export type { PatchNonAddressablePosition, PatchTargetShape } from './target-resolver.js';

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
 * The directory the parse of {@link FunctionTimingRequest.locationText} — the
 * developer's own text, when the text being patched is already layered — is
 * created under, so it never replaces the parse the rewrite is reading.
 */
const LOCATION_ROOT = '/__debuggen_location__';

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
   * refusing on any diagnostic the patch adds — with one allowance: a further
   * occurrence of a name the original text *already* failed to resolve (a DOM
   * or runtime global this library-only project does not load) is the wrapper
   * restating a declared type, not a new problem, so it is not counted. It
   * never alters the patch, so the emitted bytes — and therefore
   * `instrumentedHash` — are identical whether it runs or not.
   *
   * It is a single-file check with no import resolved, so it cannot prove the
   * patched file type-checks in the developer's project — which is why the
   * transform itself restates every declared type the moved code was checked
   * against (the inner function's return type, an arrow's parameter tuple and
   * contextual type) rather than relying on this check to catch their loss.
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
   *
   * Text that already carries an earlier patch is also text whose line numbers
   * are no longer the developer's: the helper type alias and every earlier
   * wrapper above the target shift it. Pass the developer's own text as
   * {@link FunctionTimingRequest.locationText} alongside it, so the recorded
   * position describes the file the developer has rather than the one this
   * session made.
   */
  readonly text?: string | undefined;

  /**
   * The developer's own text of the file — the bytes before **any** patch of
   * this session — when {@link FunctionTimingRequest.text} already carries one
   * or more earlier patches.
   *
   * The rewrite is always computed against `text`, because those are the bytes
   * being replaced. The recorded position — `meta.line`/`meta.column` in the
   * emitted call and {@link FunctionTimingPatch.location} — is resolved against
   * this text instead, because it is what the click-to-source route of AAP
   * §0.4.2 sends the developer to and what the code graph indexed: resolving it
   * against layered text would shift every symbol below an earlier wrapper by
   * that wrapper's lines, and the first symbol of a file by the helper alias.
   *
   * `./patcher.ts` supplies it for every chained patch, from the backup at the
   * root of the file's chain. Omitted, or equal to `text`, the position is read
   * from `text`, which is then the developer's own. The target is resolved in
   * both texts with the same spelling and must resolve to the same name, shape
   * and container in each; a target this text does not declare is refused
   * rather than given a position from the layered text.
   */
  readonly locationText?: string | undefined;

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
   * The nearest **named** declaration the wrapped declaration is nested inside,
   * for a target declared within another function's body; `undefined` for a
   * module-scope declaration and for a class member.
   *
   * Reported because it is the difference between the two kinds of target this
   * module addresses, and because it is the qualification a plan uses to name
   * this declaration unambiguously — `Enclosing.name` — when the file declares
   * the bare name more than once.
   */
  readonly enclosing: string | undefined;

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
   * `Refusal.reason` in `./target-resolver.ts` for the reason vocabulary.
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

    // Read from the PRE-rewrite tree — and, for text an earlier patch already
    // layered, from the developer's own text. Reading after the edits, or from
    // layered text, would report shifted lines, and nothing downstream could
    // tell.
    const anchored = this.#anchor(input, target);

    if (!anchored.ok) {
      return anchored;
    }

    const position = anchored.value;
    const endLine = position.endLine;
    const meta: PatchSpanMeta = {
      file,
      line: position.line,
      column: position.column,
      symbol: target.declaredName,
    };

    // The arrow's own parameter list, restated as the rest parameter's tuple so
    // the wrapper's signature is the one the developer published. TypeScript
    // only: a JavaScript wrapper carries no annotation at all.
    const restParameterType =
      callStyle === 'rest' && language === 'typescript' && Node.isArrowFunction(target.fn)
        ? restParameterTupleFor(target.fn)
        : undefined;

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
      restParameterType,
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
      enclosing: target.enclosing,
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
   * The position the patch records for its target: the name identifier's
   * 1-based line and column and the declaration's last line, in the
   * **developer's own** text.
   *
   * For a request with no {@link FunctionTimingRequest.locationText}, or one
   * whose location text is the text being patched, that is the parse the
   * rewrite is reading. Otherwise the text being patched already carries an
   * earlier patch of this session — a second symbol in the same file, or a
   * follow-up plan version over a file an earlier version instrumented — and its
   * lines are shifted by the helper alias and every wrapper above the target.
   * The location text is then parsed on its own, the same spelling is resolved
   * in it, and the position is read there: that is the line the code graph
   * indexed and the line a click on the span must open.
   *
   * The two resolutions must describe the same declaration — same bare name,
   * same shape, same container — or the request is refused. A target the
   * developer's text does not declare, or declares differently, would otherwise
   * be given a position that points at something else, which is exactly the
   * silent failure this method exists to prevent.
   *
   * @param input The parsed text being patched and everything resolved about
   * the request.
   * @param target The target as resolved in the text being patched.
   * @returns The anchor, or a `PATCH_TARGET_NOT_FOUND` refusal with reason
   * `'location-unresolved'`.
   */
  #anchor(input: RewriteInput, target: ResolvedTarget): Result<PatchAnchor> {
    const { file, originalText, request, sourceFile, spelling } = input;
    const locationText = request.locationText;

    if (locationText === undefined || locationText === originalText) {
      return ok(anchorOf(sourceFile, target));
    }

    const scratch = this.#scratchProject();
    const locationFile = scratch.createSourceFile(joinPosix(LOCATION_ROOT, file), locationText, {
      overwrite: true,
      scriptKind: scriptKindFor(file),
    });

    try {
      const resolved = resolveTarget(locationFile, spelling, file);

      if (!resolved.ok) {
        return err(
          refusal(
            'PATCH_TARGET_NOT_FOUND',
            'location-unresolved',
            "The target resolves in the file's current text but not in the developer's own text, so no position the developer can open could be recorded for it.",
            {
              file,
              symbol: target.declaredName,
              cause: resolved.error.details?.['reason'],
            },
            'Reconcile the earlier modifications of this file, then plan the target again.',
          ),
        );
      }

      const pristine = resolved.value;

      if (
        pristine.declaredName !== target.declaredName ||
        pristine.shape !== target.shape ||
        pristine.container !== target.container
      ) {
        return err(
          refusal(
            'PATCH_TARGET_NOT_FOUND',
            'location-unresolved',
            "The target resolves to a different declaration in the developer's own text than in the file's current text, so the position to record is ambiguous.",
            {
              file,
              symbol: target.declaredName,
              shape: target.shape,
              locationShape: pristine.shape,
            },
            'Name the target with its qualified spelling, or reconcile the earlier modifications of this file first.',
          ),
        );
      }

      return ok(anchorOf(locationFile, pristine));
    } finally {
      // Removed before returning, like every other parse this patcher makes:
      // the private project holds no text one patch could leave for another.
      scratch.removeSourceFile(locationFile);
    }
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
   * the honest comparison is over everything the compiler says — except a
   * further occurrence of a name the original already could not resolve, which
   * is compared by presence (see `introducedDiagnostics`): the wrapper restates
   * declared types on purpose, and a global this library-only project does not
   * load is unresolved wherever it is named.
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
 * Where a patched symbol is, as the patch records it: the coordinates the
 * emitted `meta` literal and {@link FunctionTimingPatch.location} carry.
 */
interface PatchAnchor {
  /** The name identifier's 1-based line. */
  readonly line: number;

  /** The name identifier's 1-based column. */
  readonly column: number;

  /** The whole declaration's last 1-based line. */
  readonly endLine: number;
}

/**
 * Reads a target's anchor off the tree it was resolved in.
 *
 * The **name identifier's** position rather than the declaration's start, which
 * is character-for-character the anchor `@debuggen/code-analysis` records for
 * the same declaration — see this module's overview. `getLineAndColumnAtPos`
 * answers 1-based on both axes, which is the convention `SourceLocation`
 * requires.
 *
 * @param sourceFile The parse the target was resolved in.
 * @param target The resolved target.
 * @returns Its anchor in that parse.
 */
function anchorOf(sourceFile: SourceFile, target: ResolvedTarget): PatchAnchor {
  const position = sourceFile.getLineAndColumnAtPos(target.nameNode.getStart());

  return {
    line: position.line,
    column: position.column,
    endLine: target.declaration.getEndLineNumber(),
  };
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
 * The diagnostic codes that report a **name the check project cannot
 * resolve**, rather than a type that does not fit.
 *
 * The pre-flight's project loads the ES library alone and resolves no import,
 * so a global the target's real project declares — `Request` and `Response`
 * from the DOM library, a `NodeJS` namespace, a test runner's globals — is
 * reported unresolved at **every** place the file names it. The wrapper names
 * some of them once more, and on purpose: the inner function restates the
 * outer's declared return type, the rest parameter restates an arrow's
 * parameter types, and a `satisfies` restates a binding's type, each so the
 * patched file keeps type-checking in the real project. The restated text is
 * resolved in the same scope as the text it restates, so it resolves exactly
 * when the original does, and an extra occurrence of a name the original
 * already failed to resolve is an artefact of the check, not a diagnostic the
 * patch adds. A name the original text resolves everywhere and the patched text
 * does not is still reported, because its key never appears before the patch.
 *
 * - `2304` / `2552` — cannot find name (with a spelling suggestion).
 * - `2503` — cannot find namespace.
 * - `2305` / `2694` / `2724` — a module or namespace has no such exported
 *   member.
 * - `2307` — cannot find module.
 * - `2580`–`2584`, `2591`–`2593` — cannot find name, with the advice to
 *   install type definitions or change the target library.
 */
const UNRESOLVED_NAME_DIAGNOSTIC_CODES: ReadonlySet<number> = new Set([
  2304, 2305, 2307, 2503, 2552, 2580, 2581, 2582, 2583, 2584, 2591, 2592, 2593, 2694, 2724,
]);

/**
 * The diagnostic code a key from {@link semanticDiagnosticKeys} carries.
 *
 * @param key A `'<code>: <message>'` key.
 * @returns The code, or `NaN` for a key of any other form.
 */
function diagnosticCodeOf(key: string): number {
  return Number(key.slice(0, key.indexOf(':')));
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
 * The one exception is an unresolved name — see
 * {@link UNRESOLVED_NAME_DIAGNOSTIC_CODES} — which is compared by presence: an
 * extra occurrence of exactly a key the original text already reported is the
 * wrapper restating a type the check project cannot see, never a new problem.
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

  const reportedBefore = new Set(before);
  const introduced: string[] = [];

  for (const entry of after) {
    const remaining = unmatched.get(entry) ?? 0;

    if (remaining > 0) {
      unmatched.set(entry, remaining - 1);
      continue;
    }

    if (
      UNRESOLVED_NAME_DIAGNOSTIC_CODES.has(diagnosticCodeOf(entry)) &&
      reportedBefore.has(entry)
    ) {
      continue;
    }

    introduced.push(entry);
  }

  return introduced;
}

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
 * The refusal a resolved target still earns, or `undefined` when it may be
 * wrapped.
 *
 * Five conditions, each of which would otherwise produce a file that compiles
 * and misbehaves — or, in the React case, one that compiles, behaves and puts
 * errors in the developer's own editor:
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
 * - **A React component or hook.** Moving the body into an inner function moves
 *   its hook calls with it, and React's rules-of-hooks analysis then reports
 *   every one of them — measured on a real component as seven
 *   `react-hooks/rules-of-hooks` errors ("called in function `__orig` that is
 *   neither a React function component nor a custom React Hook function")
 *   where the unpatched file reported none. Hook *order* is preserved at run
 *   time, because the helper invokes the callback synchronously, so nothing
 *   misbehaves; what breaks is the developer's own lint and type-check, which a
 *   temporary patch has no business breaking. AAP §0.5.1 tracks React renders
 *   at run time and reserves patches for named function timing, so this target
 *   belongs to the runtime route rather than to a narrower wrapper. See
 *   {@link reactComponentSite}.
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

  const reactSite = reactComponentSite(target);

  if (reactSite !== undefined) {
    return refusal(
      'PATCH_UNSUPPORTED',
      'unsupported-react-component',
      reactSite.site === 'jsx-return'
        ? 'The target returns JSX, so it is a React render function: moving its body into an inner function would move the render — and any hook it calls — out of the component React analyses, which reports rules-of-hooks violations in the target file while the patch is installed.'
        : 'The target calls a React hook in its own scope, so it is a component or a hook: moving its body into an inner function would move those hook calls into a function that is neither, which reports rules-of-hooks violations in the target file while the patch is installed.',
      {
        file,
        symbol: target.declaredName,
        shape: target.shape,
        site: reactSite.site,
        hook: reactSite.hook,
        line: reactSite.line,
      },
      `Plan a ${REACT_RENDER_ACTION_TYPE} action for this component instead: it normalises to runtime mode, observes renders and commits through the page agent, and edits no file at all.`,
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
 * What made a declaration a React render function, carried as `details.site` on
 * an `'unsupported-react-component'` refusal.
 *
 * - `'jsx-return'` — it returns a JSX element, self-closing element or
 *   fragment, which is what a component *is*.
 * - `'hook-call'` — it calls a React hook in its own scope, which is what a
 *   component or a custom hook does and what no other function may do.
 *
 * Frozen because it is vocabulary rather than state, and exported so a caller
 * or a test can enumerate the two instead of restating them.
 */
export const PATCH_REACT_SITES = Object.freeze(['jsx-return', 'hook-call'] as const);

/** One member of {@link PATCH_REACT_SITES}. */
export type PatchReactSite = (typeof PATCH_REACT_SITES)[number];

/**
 * The name of React 19's `use` API — `use(promise)`, `use(context)` — which
 * React's rules-of-hooks analysis treats as a hook although no letter follows
 * the prefix.
 */
const REACT_USE_API_NAME = 'use';

/**
 * The convention that identifies a named React hook: `use` followed by an
 * upper-case letter or a digit.
 *
 * The digit matters: `use3DScene` and `use2FA` are hooks to React's own
 * analysis, and a body calling one moved into `__orig` breaks the developer's
 * lint exactly as `useState` would. See {@link isReactHookName} for the whole
 * rule.
 */
const REACT_HOOK_NAME_PATTERN = /^use[A-Z0-9]/u;

/**
 * Whether a callee's final name identifies a React hook call.
 *
 * The rule is React's own — `isHookName` in `eslint-plugin-react-hooks`, the
 * analysis whose errors a misplaced patch would produce: the bare
 * {@link REACT_USE_API_NAME}, or {@link REACT_HOOK_NAME_PATTERN}. This is the
 * whole rule, and deliberately so. AAP §0.5.4 forbids framework-specific and
 * application-specific name lists in product code, so `useState`,
 * `useTransition`, `use(context)`, a project's own `useCart`, a `use3DScene`
 * and a hook written tomorrow are all recognised by their shape, while `user`,
 * `used` and `useful` — ordinary names that merely begin with the prefix — are
 * not.
 *
 * @param name The final identifier of a call's callee.
 * @returns `true` when React would treat the call as a hook call.
 */
function isReactHookName(name: string): boolean {
  return name === REACT_USE_API_NAME || REACT_HOOK_NAME_PATTERN.test(name);
}

/** Where, and by what, a declaration was recognised as a React render. */
interface ReactSiteFinding {
  /** Which of the two recognitions fired. */
  readonly site: PatchReactSite;

  /** The hook's name for a `'hook-call'` site, `undefined` otherwise. */
  readonly hook: string | undefined;

  /** The 1-based line the recognised expression starts on. */
  readonly line: number;
}

/**
 * Whether — and where — a resolved target is a React render function, decided
 * from syntax alone.
 *
 * No type checker and no import analysis: the parse this module runs resolves
 * nothing, and a rule that depended on resolving `react` would answer
 * differently for the same file depending on whether `node_modules` happened to
 * be installed. The two recognitions are the two facts React's own static
 * analysis uses — a JSX return makes a component, and a `use`-prefixed call
 * makes a component or a hook.
 *
 * ## Only the target's own scope
 *
 * The scan descends through blocks, conditions, loops, `try` and expressions but
 * **not** into a nested function-like node, because a nested function has its
 * own returns and its own scope. That is what keeps two very ordinary shapes
 * patchable: a data function whose `items.map((item) => <li />)` callback
 * returns JSX, and one that passes a callback which itself calls a hook. Both
 * would look like components to a whole-subtree scan, and neither is one.
 *
 * An arrow's **expression body** is its return, so it is examined directly: a
 * `() => <Row />` component has no `return` statement to find.
 *
 * @param target The resolved target.
 * @returns What was recognised and where, or `undefined` for a declaration that
 * is neither a component nor a hook.
 */
function reactComponentSite(target: ResolvedTarget): ReactSiteFinding | undefined {
  const body = target.body;

  if (!Node.isBlock(body)) {
    const expression = unwrapTransparentExpression(body);

    if (expression !== undefined && isJsxValue(expression)) {
      return { site: 'jsx-return', hook: undefined, line: expression.getStartLineNumber() };
    }
  }

  return reactSiteWithin(body);
}

/**
 * The first React recognition inside one node's own scope, in source order.
 *
 * @param node The node whose children are scanned.
 * @returns The finding, or `undefined`.
 */
function reactSiteWithin(node: Node): ReactSiteFinding | undefined {
  for (const child of node.forEachChildAsArray()) {
    if (isFunctionLikeScope(child)) {
      continue;
    }

    const site = reactSiteOf(child) ?? reactSiteWithin(child);

    if (site !== undefined) {
      return site;
    }
  }

  return undefined;
}

/**
 * The React recognition one node is, or `undefined` when it is neither.
 *
 * @param node The node to test.
 * @returns The finding, or `undefined`.
 */
function reactSiteOf(node: Node): ReactSiteFinding | undefined {
  if (Node.isReturnStatement(node)) {
    const expression = unwrapTransparentExpression(node.getExpression());

    return expression !== undefined && isJsxValue(expression)
      ? { site: 'jsx-return', hook: undefined, line: node.getStartLineNumber() }
      : undefined;
  }

  if (!Node.isCallExpression(node)) {
    return undefined;
  }

  const hook = hookNameOf(node.getExpression());

  return hook === undefined
    ? undefined
    : { site: 'hook-call', hook, line: node.getStartLineNumber() };
}

/**
 * Whether an expression is JSX: an element, a self-closing element or a
 * fragment.
 *
 * A conditional or a logical expression whose branches are JSX is examined
 * branch by branch, because `return open ? <Panel /> : null` is exactly how a
 * component that renders nothing sometimes is written, and reading only the
 * outermost node would miss it.
 *
 * @param expression The expression to test.
 * @returns `true` when the expression's value is JSX.
 */
function isJsxValue(expression: Node): boolean {
  if (
    Node.isJsxElement(expression) ||
    Node.isJsxSelfClosingElement(expression) ||
    Node.isJsxFragment(expression)
  ) {
    return true;
  }

  if (Node.isConditionalExpression(expression)) {
    return isJsxBranch(expression.getWhenTrue()) || isJsxBranch(expression.getWhenFalse());
  }

  if (Node.isBinaryExpression(expression)) {
    return isJsxBranch(expression.getLeft()) || isJsxBranch(expression.getRight());
  }

  return false;
}

/**
 * {@link isJsxValue} for one branch of a conditional or logical expression,
 * looking through the same transparent wrappers a `return` is read through.
 *
 * @param branch The branch expression.
 * @returns `true` when the branch's value is JSX.
 */
function isJsxBranch(branch: Node): boolean {
  const expression = unwrapTransparentExpression(branch);

  return expression !== undefined && isJsxValue(expression);
}

/**
 * The hook name a call's callee spells, or `undefined` when the callee is not
 * hook-shaped.
 *
 * An identifier (`useState(…)`, `use(…)`) and a property access
 * (`React.useState(…)`, `React.use(…)`, `hooks.useCart(…)`) are both accepted,
 * and the **final** name is what {@link isReactHookName} is tested against. Anything else — an element access, a call
 * returning a function, a `new` expression — is not a hook call in any form
 * React's own analysis recognises.
 *
 * @param callee The call's callee expression.
 * @returns The hook's name, or `undefined`.
 */
function hookNameOf(callee: Node): string | undefined {
  const expression = unwrapTransparentExpression(callee);

  if (expression === undefined) {
    return undefined;
  }

  const name = Node.isIdentifier(expression)
    ? expression.getText()
    : Node.isPropertyAccessExpression(expression)
      ? expression.getNameNode().getText()
      : undefined;

  return name !== undefined && isReactHookName(name) ? name : undefined;
}

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
 * The scan is scoped to {@link ResolvedTarget.identifierScope} rather than to
 * the file on purpose. A binding elsewhere in the file cannot collide with a
 * name declared inside this function, and a *reference* to such a binding from
 * inside the body appears in the scanned identifiers and so is seen — which is
 * the case that actually matters, because shadowing a binding the body reads is
 * what would change its behaviour. Scoping it here is also what lets a second
 * symbol in an already-patched file keep the default names.
 *
 * For a module-scope target the scope is the declaration itself. For a
 * **nested** target it is the enclosing top-level declaration, because the
 * moved body can reference a binding the enclosing function owns — a local
 * named `__orig` one frame out is the case that matters — and that binding is
 * not inside the nested declaration at all. Widening only ever adds names, so
 * the cost of the wider scan is at most a disambiguating rename.
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

  for (const identifier of target.identifierScope.getDescendantsOfKind(SyntaxKind.Identifier)) {
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
  // synchronous. The declared return type is carried for the reason
  // `innerReturnTypeAnnotation` gives: without it the moved `return`
  // statements are typed with no contextual type, and a literal the developer
  // returned against a declared union widens into a build error.
  const returnType = innerReturnTypeAnnotation(fn, wrapper.language);
  const innerDeclaration = `${asyncPrefix}function ${wrapper.innerIdentifier}(${thisParameter.value})${returnType} ${originalText.slice(start, end)}`;

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
 * The return-type annotation the inner function of an `'arguments'`-style
 * wrapper declares — `': T'`, or the empty string when none applies.
 *
 * The moved body's `return` statements were written against the outer
 * function's declared return type, and that declaration is what types them
 * *contextually*: `return { outcome: 'placed' }` in a function declared to
 * return a type whose `outcome` is a string-literal union keeps `'placed'` as a
 * literal. Moved into an inner function with no annotation, the same statement
 * is typed with no contextual type at all, the literal widens to `string`, and
 * the wrapper's `return __orig.apply(…)` then fails the outer declaration with
 * `TS2322` — a build error in the developer's project that a single-file check
 * cannot see whenever the declared type is imported. A `never` function breaks
 * the same way: an inner function declaration that only throws is inferred as
 * `void`. So the inner function states the outer's declared return type, which
 * is exactly the type its `return` statements were checked against before the
 * patch.
 *
 * The annotation text is copied verbatim and resolves identically: the inner
 * function is declared at the top of the outer body, where the outer's type
 * parameters and parameters are in scope and nothing the original body
 * declared is (those declarations moved into the inner body with it). Two
 * forms cannot be copied, because they name the *outer* function's own
 * parameter:
 *
 * - A type predicate, `value is T`, becomes `boolean` — the type of the value
 *   such a function returns. The outer keeps the predicate, and a `boolean` is
 *   what it returns.
 * - An assertion signature, `asserts value is T` or `asserts value`, becomes
 *   `void` — an assertion function returns nothing, and the outer keeps the
 *   assertion for its callers' narrowing.
 *
 * TypeScript only: a JavaScript target carries no annotations, and one there
 * would be a syntax error. A target with no declared return type needs none
 * either, since the inner function then infers exactly what the outer would
 * have. A polymorphic `this` return type never reaches here — the receiver
 * rules refuse it first.
 *
 * @param fn The target function.
 * @param language The syntax being emitted.
 * @returns `': T'` with a leading colon, or `''`.
 */
function innerReturnTypeAnnotation(fn: PatchableFunctionNode, language: PatchLanguage): string {
  if (language !== 'typescript') {
    return '';
  }

  const returnType = fn.getReturnTypeNode();

  if (returnType === undefined) {
    return '';
  }

  if (Node.isTypePredicate(returnType)) {
    return returnType.hasAssertsModifier() ? ': void' : ': boolean';
  }

  return `: ${returnType.getText()}`;
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
 * written, less its type-parameter list (see {@link innerArrowHead}). The rest
 * parameter carries the arrow's parameter list as a tuple type (see
 * {@link restParameterTupleFor}), and an arrow contextually typed by its
 * binding keeps that context through a `satisfies` on the inner arrow (see
 * {@link contextualTypeTextOf}).
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
  const head = innerArrowHead(fn, originalText, start, arrowEnd);
  const bodyRegion = originalText.slice(arrowEnd, body.getEnd());
  const innerArrow = isBlockBody
    ? `${head}${bodyRegion}`
    : `${head} { return (${bodyRegion.trim()}); }`;
  const contextualType =
    wrapper.language === 'typescript' && fn.getTypeParameters().length === 0
      ? contextualTypeTextOf(fn)
      : undefined;
  const innerInitializer =
    contextualType === undefined ? innerArrow : `(${innerArrow}) satisfies ${contextualType}`;
  const outerHead = `${originalText.slice(start, parameters.start)}(${restParameter})${originalText.slice(
    parameters.end,
    arrowEnd,
  )}`;

  return ok({
    start,
    end,
    replacement: [
      `${outerHead} {`,
      `${innerIndent}const ${wrapper.innerIdentifier} = ${innerInitializer};`,
      indentLines(wrapper.text, innerIndent, newline),
      `${declarationIndent}}`,
    ].join(newline),
    purpose: 'function-declaration',
  });
}

/**
 * The inner arrow's head: the original head verbatim — `async`, parameter
 * list, return type and `=>` — **without** its type-parameter list.
 *
 * The outer wrapper keeps the arrow's type parameters, because they are part of
 * the signature the module published. Left on the inner arrow as well they
 * would declare a *second*, shadowing set, and `__orig.apply(…)` over a generic
 * function erases those to `unknown`, so the wrapper of `<T>(items: T[]) => T`
 * would return `unknown` — a build error against its own declared `T`, and a
 * silently widened return type for every caller when no return type is
 * declared. Without the list, every `T` in the inner head and body resolves to
 * the outer's `T`, which has the same constraint and default because it *is*
 * the declaration the developer wrote, and the forwarded call returns exactly
 * the type the original did — the same arrangement a function declaration's
 * inner function has.
 *
 * @param fn The arrow being wrapped.
 * @param originalText The text the patch is computed against.
 * @param start The arrow's start offset.
 * @param arrowEnd The offset just past its `=>`.
 * @returns The head text to give the inner arrow.
 */
function innerArrowHead(
  fn: ArrowFunction,
  originalText: string,
  start: number,
  arrowEnd: number,
): string {
  if (fn.getTypeParameters().length === 0) {
    return originalText.slice(start, arrowEnd);
  }

  // The list's own angle brackets are direct children of the arrow; those of a
  // parameter or return type sit inside that type's node and cannot be
  // mistaken for them.
  const open = fn.getFirstChildByKind(SyntaxKind.LessThanToken);
  const close = fn.getFirstChildByKind(SyntaxKind.GreaterThanToken);

  if (open === undefined || close === undefined || close.getEnd() > arrowEnd) {
    return originalText.slice(start, arrowEnd);
  }

  return `${originalText.slice(start, open.getStart())}${originalText.slice(close.getEnd(), arrowEnd)}`;
}

/**
 * The type an arrow is contextually typed by **syntactically**: the annotation
 * of the variable or class property it initialises, or the type a `satisfies`
 * around it names — or `undefined` when there is none.
 *
 * An arrow bound as `const handler: Handler = (request) => …` takes its
 * parameter types and the contextual type of its return value from `Handler`.
 * The wrapper replaces the arrow in that position, so the *outer* arrow is still
 * typed by it; the inner arrow holding the original head is not, and without a
 * context its unannotated parameters become implicit `any` and a literal it
 * returns widens — a build error in the developer's project that a single-file
 * check cannot see when `Handler` is imported. The caller restores the context
 * with `satisfies`, which types the inner arrow contextually exactly as the
 * original position did, checks the same assignability the original binding
 * checked, and — unlike an annotation — leaves the inner arrow's own type as
 * the one the forwarded call returns.
 *
 * Parentheses between the arrow and its binding are looked through. A type
 * assertion (`as T`) is deliberately not: it checks comparability rather than
 * assignability, so restating it as `satisfies` could reject what the
 * developer's assertion accepted.
 *
 * @param fn The arrow being wrapped.
 * @returns The contextual type's text, or `undefined`.
 */
function contextualTypeTextOf(fn: ArrowFunction): string | undefined {
  let current: Node = fn;
  let parent = fn.getParent();

  while (Node.isParenthesizedExpression(parent)) {
    current = parent;
    parent = parent.getParent();
  }

  if (Node.isSatisfiesExpression(parent) && parent.getExpression() === current) {
    return parent.getTypeNode()?.getText();
  }

  if (
    (Node.isVariableDeclaration(parent) || Node.isPropertyDeclaration(parent)) &&
    parent.getInitializer() === current
  ) {
    return parent.getTypeNode()?.getText();
  }

  return undefined;
}

/**
 * The wrapped arrow's parameter list, restated as the tuple type the wrapper's
 * rest parameter is annotated with.
 *
 * The rest parameter replaces the arrow's parameter list, and for an arrow bound
 * to an unannotated variable that list is the exported signature: every call
 * site's argument checking and every `Parameters<typeof fn>` a consumer derives
 * read it. Restating it as a labelled tuple keeps it exactly what it was —
 * `(width: number, label: string)` becomes `(...__args: [width: number, label:
 * string])`, which TypeScript treats as the same signature — where `unknown[]`
 * would widen every parameter and break consumers in files no single-file check
 * can see.
 *
 * Each parameter becomes one element, by these rules:
 *
 * - **Label**: the parameter's name, or `argN` (its 1-based position,
 *   disambiguated) for a destructuring pattern, because a tuple's elements are
 *   either all labelled or none are.
 * - **Type**: its annotation verbatim. Without one, the widened primitive of a
 *   literal initializer (`scale = 2` → `number`), the asserted type of an
 *   initializer written `value as T`, and otherwise `any` — the type the
 *   compiler itself gives an unannotated parameter that has no contextual type,
 *   and one that, being assignable both ways, never rejects a caller. An
 *   unannotated rest parameter is `any[]` for the same reason. (When a
 *   contextual type exists, it — not this tuple — is the binding's declared
 *   type, and `any` keeps the wrapper assignable to it.)
 * - **Optionality**: a parameter with `?` or an initializer is an optional
 *   element when every parameter after it is optional too, and a required
 *   element otherwise — the compiler's own rule for such a parameter's position
 *   in the signature. Either way its type gains `| undefined`, exactly as
 *   `Parameters<>` reports it, so a caller passing `undefined` explicitly is
 *   still accepted under `exactOptionalPropertyTypes`, where a bare optional
 *   tuple element would reject it.
 * - **Rest**: `...name: T`, a variadic element.
 *
 * @param fn The arrow being wrapped.
 * @returns The tuple type's text, `[]` for an arrow with no parameters.
 */
function restParameterTupleFor(fn: ArrowFunction): string {
  const parameters = fn.getParameters();
  const labels = tupleLabelsFor(parameters);

  // Scanned from the end: a parameter may be an optional element only when
  // every parameter after it is optional or the rest parameter.
  const optionalFrom = new Array<boolean>(parameters.length).fill(false);
  let tailIsOptional = true;

  for (let index = parameters.length - 1; index >= 0; index -= 1) {
    const parameter = parameters[index];

    if (parameter === undefined) {
      continue;
    }

    const omissible =
      parameter.isRestParameter() || parameter.hasQuestionToken() || parameter.hasInitializer();

    tailIsOptional = tailIsOptional && omissible;
    optionalFrom[index] = tailIsOptional;
  }

  const elements = parameters.map((parameter, index) => {
    const label = labels[index] ?? `arg${String(index + 1)}`;
    const annotation = parameter.getTypeNode();

    if (parameter.isRestParameter()) {
      return `...${label}: ${annotation?.getText() ?? 'any[]'}`;
    }

    const type =
      annotation === undefined
        ? inferredParameterType(parameter)
        : { text: annotation.getText(), node: annotation };
    const omissible = parameter.hasQuestionToken() || parameter.hasInitializer();

    if (!omissible) {
      return `${label}: ${type.text}`;
    }

    const withUndefined = unionWithUndefined(type.text, type.node);

    return optionalFrom[index] === true
      ? `${label}?: ${withUndefined}`
      : `${label}: ${withUndefined}`;
  });

  return `[${elements.join(', ')}]`;
}

/**
 * One tuple label per parameter: its name when it is an identifier, `argN`
 * otherwise, with `N` its 1-based position and a trailing `_` appended until
 * the label collides with no other.
 *
 * @param parameters The arrow's parameters.
 * @returns The labels, in parameter order.
 */
function tupleLabelsFor(parameters: readonly ParameterDeclaration[]): readonly string[] {
  const named = parameters.map((parameter) => {
    const name = parameter.getNameNode();

    return Node.isIdentifier(name) ? name.getText() : undefined;
  });
  const taken = new Set(named.filter((label): label is string => label !== undefined));

  return named.map((label, index) => {
    if (label !== undefined) {
      return label;
    }

    let candidate = `arg${String(index + 1)}`;

    while (taken.has(candidate)) {
      candidate = `${candidate}_`;
    }

    taken.add(candidate);

    return candidate;
  });
}

/**
 * The type of an unannotated, non-rest parameter, as far as its syntax states
 * it: the widened primitive of a literal initializer, the type an `as T`
 * initializer asserts, and `any` otherwise.
 *
 * Syntax only, on purpose: the patch is computed from one parsed file with no
 * import resolved, so anything the compiler would have to *infer* — an
 * imported constant, an object or array literal — is given `any`, which is what
 * the compiler gives an unannotated parameter with no contextual type and which
 * never rejects a caller.
 *
 * @param parameter The parameter.
 * @returns The type's text, and the type node it was copied from when there is
 * one — which decides whether a union with `undefined` must parenthesise it.
 */
function inferredParameterType(parameter: ParameterDeclaration): ElementType {
  let initializer = parameter.getInitializer();

  while (Node.isParenthesizedExpression(initializer)) {
    initializer = initializer.getExpression();
  }

  if (initializer === undefined) {
    return UNTYPED_ELEMENT;
  }

  if (Node.isPrefixUnaryExpression(initializer)) {
    const operator = initializer.getOperatorToken();
    const operand = initializer.getOperand();

    if (Node.isNumericLiteral(operand)) {
      if (operator === SyntaxKind.MinusToken || operator === SyntaxKind.PlusToken) {
        return primitiveElement('number');
      }
    }

    if (Node.isBigIntLiteral(operand) && operator === SyntaxKind.MinusToken) {
      return primitiveElement('bigint');
    }

    return UNTYPED_ELEMENT;
  }

  if (Node.isNumericLiteral(initializer)) {
    return primitiveElement('number');
  }

  if (Node.isBigIntLiteral(initializer)) {
    return primitiveElement('bigint');
  }

  if (
    Node.isStringLiteral(initializer) ||
    Node.isNoSubstitutionTemplateLiteral(initializer) ||
    Node.isTemplateExpression(initializer)
  ) {
    return primitiveElement('string');
  }

  if (Node.isTrueLiteral(initializer) || Node.isFalseLiteral(initializer)) {
    return primitiveElement('boolean');
  }

  if (Node.isAsExpression(initializer)) {
    const asserted = initializer.getTypeNode();

    // `as const` asserts no type that could be written down here.
    if (asserted !== undefined && asserted.getText() !== 'const') {
      return { text: asserted.getText(), node: asserted };
    }
  }

  return UNTYPED_ELEMENT;
}

/** A tuple element's type: its text, and the node it was copied from. */
interface ElementType {
  /** The type as it is emitted. */
  readonly text: string;

  /** The annotation the text was copied from, `undefined` for a derived one. */
  readonly node: TypeNode | undefined;
}

/** The element type of a parameter whose syntax states no type. */
const UNTYPED_ELEMENT: ElementType = Object.freeze({ text: 'any', node: undefined });

/**
 * A primitive element type derived from a literal initializer.
 *
 * @param text The primitive's keyword.
 * @returns The element type.
 */
function primitiveElement(text: 'bigint' | 'boolean' | 'number' | 'string'): ElementType {
  return { text, node: undefined };
}

/**
 * `T | undefined`, parenthesising `T` where the union would otherwise bind
 * inside it.
 *
 * A function type, a constructor type and a conditional type all extend to the
 * right, so `() => void | undefined` is a function returning `void |
 * undefined`, not an optional function. `any` and `unknown` already contain
 * `undefined` and are returned unchanged, as the compiler prints them.
 *
 * @param type The element type's text.
 * @param annotation Its type node, when the text came from one.
 * @returns The union's text.
 */
function unionWithUndefined(type: string, annotation: TypeNode | undefined): string {
  if (type === 'any' || type === 'unknown') {
    return type;
  }

  const extendsRight =
    Node.isFunctionTypeNode(annotation) ||
    Node.isConstructorTypeNode(annotation) ||
    Node.isConditionalTypeNode(annotation);

  return extendsRight ? `(${type}) | undefined` : `${type} | undefined`;
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
