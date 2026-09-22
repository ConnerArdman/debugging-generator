/**
 * The patch template: **the exact text this product writes into a developer's
 * source file**, and the one place in the repository where the two
 * instrumentation marker literals are spelled.
 *
 * Three facts govern every line below, and an editor who changes this module
 * without honouring all three breaks something that fails silently:
 *
 * 1. **This module is the only definition of the marker literals.**
 *    {@link SPAN_HELPER_GLOBAL} and {@link SPAN_HELPER_TYPE_NAME} are declared
 *    here and interpolated into every string this module emits; nothing else in
 *    the patch layer re-spells them.
 * 2. **`scripts/check-no-residual-instrumentation.mjs` searches for exactly
 *    those two literals.** Its `MARKERS` tuple is a stated contract with this
 *    file: it greps every tracked file under the instrumentation target for
 *    them and fails the build when one survives a session. If the template ever
 *    renames the span-helper global or the inserted type alias, that script must
 *    change **in the same commit** — otherwise the gate keeps passing while the
 *    cleanup guarantee has quietly become unverifiable. {@link
 *    INSTRUMENTATION_MARKERS} exists so a consumer can enumerate the literals
 *    instead of restating them.
 * 3. **The emitted text runs inside someone else's project and must never
 *    change what that project does.** This module writes no bytes to disk — it
 *    is pure text — but every character it produces ends up in a working tree
 *    the developer is actively using. A semantic slip here is invisible in this
 *    repository's tests and visible only as an application that behaves
 *    differently while it is being debugged, which is the one failure this
 *    product cannot afford.
 *
 * ## What a wrapper looks like
 *
 * The patcher moves a function's body into an inner function declared inside
 * the original — which is what preserves `this`, `arguments`, parameter
 * defaults and destructuring — and replaces the original body with the three
 * statements {@link buildWrapperBody} produces:
 *
 * ```ts
 * const __dbg = (globalThis as { __DEBUGGEN__?: __DebuggenSpanHelper }).__DEBUGGEN__;
 * if (__dbg && typeof __dbg.span === "function") return __dbg.span(name, meta, () => __orig.apply(this, arguments as never));
 * return __orig.apply(this, arguments as never);
 * ```
 *
 * plus, in a TypeScript file only, the one-line alias
 * {@link HELPER_TYPE_ALIAS_TEXT} at the top of the file so a strict target
 * project keeps type-checking without gaining a dependency.
 *
 * ## The two invariants of the emitted text
 *
 * - **The branch tests helper *availability*, never the helper's return
 *   value.** A helper whose `span` returns `null` or `undefined` must never
 *   cause the body to run a second time, which is why the condition is
 *   `__dbg && typeof __dbg.span === "function"` and why both `return`
 *   statements call the inner function directly. Any reformulation of that
 *   condition is a behaviour change and needs a test, not a review comment.
 * - **The inner function is invoked identically on both paths.** The
 *   instrumented path (inside `span`) and the fallback path use the same call
 *   expression ({@link WrapperBody.innerCall}), so behaviour with and without
 *   the helper is indistinguishable apart from the span that was recorded.
 *
 * ## What the template deliberately does not do
 *
 * The runtime guarantees live in the two span helpers
 * (`@debuggen/telemetry`'s `src/node/span-helper.ts` and its browser twin): the
 * callback runs exactly once, its value is returned unchanged — never coerced,
 * never awaited — a returned promise ends the span when it settles, and a
 * synchronous throw records the exception and rethrows the original error. The
 * emitted text depends on those guarantees, and therefore adds **no** `await`,
 * **no** `try`/`catch` and **no** handling of the returned value. Adding any of
 * them would change application semantics for asynchronous,
 * thenable-returning and throwing functions alike: a `try`/`catch` would alter
 * an error's path, an `await` would turn a synchronous function into one that
 * returns a promise, and touching the value would break identity for callers
 * that compare references.
 *
 * Generator and async-generator functions are out of scope: a wrapper that
 * calls the body as a function cannot preserve `yield`, so
 * `../feasibility.ts` refuses those targets before anything reaches this
 * module. {@link buildWrapperBody} therefore has no generator-capable template
 * and throws when asked for one, rather than emitting something plausible.
 *
 * ## Conventions
 *
 * Every string value the emitted text carries is serialised with
 * `JSON.stringify` rather than hand-quoted, so a path or symbol containing a
 * quote, a backslash or a line terminator cannot break out of its literal.
 * Expected refusals — an unsupported file extension, an unsafe `file` value, an
 * unknown call style — are returned as `Result<T, DebuggenError>` with a code
 * from the closed vocabulary in `@debuggen/shared`; only a programmer error
 * (a generator request, which `../feasibility.ts` already gates) throws.
 *
 * Importing this module has no side effect beyond freezing its own vocabulary
 * tuples: it reads no environment variable, touches no filesystem and holds no
 * state, which is what lets `package.json` declare `"sideEffects": false`.
 *
 * @module packages/instrumentation/src/patch/wrap-template
 */

import {
  DebuggenError,
  err,
  extnamePosix,
  isSafeRelativePath,
  normalizePosix,
  ok,
} from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

/**
 * The property name the patch reads on `globalThis`, and the first of the two
 * literals `scripts/check-no-residual-instrumentation.mjs` greps for.
 *
 * Declared here once and interpolated everywhere else in this module, so the
 * spelling has a single source. The same spelling is installed at runtime by
 * `@debuggen/telemetry`'s two span helpers — as `DEBUGGEN_GLOBAL_KEY` in the
 * preload and on the page agent's helper — and those modules document that this
 * template is the reason they may install it under that name at all.
 */
export const SPAN_HELPER_GLOBAL = '__DEBUGGEN__' as const;

/**
 * The name of the local type alias inserted at the top of a patched TypeScript
 * file, and the second literal the residual-instrumentation gate greps for.
 *
 * A patched project cannot `import` the helper's interface — it has no
 * dependency on this product, and acquiring one would be the opposite of a
 * reversible patch — so the wrapper's type comes from a file-local alias that
 * is a structural copy of `DebuggenSpanHelper`. See
 * {@link HELPER_TYPE_ALIAS_TEXT}.
 */
export const SPAN_HELPER_TYPE_NAME = '__DebuggenSpanHelper' as const;

/**
 * Both marker literals, in the order the residual-instrumentation gate lists
 * them, as a frozen readonly tuple.
 *
 * Exported so `scripts/check-no-residual-instrumentation.mjs` and any future
 * consumer can *enumerate* the markers rather than restate them: a check that
 * knows the list can never drift from the template that writes it. The tuple is
 * frozen because it is vocabulary, not state — a consumer that could push a
 * third entry onto it would be widening a safety check at run time.
 */
export const INSTRUMENTATION_MARKERS = Object.freeze([
  SPAN_HELPER_GLOBAL,
  SPAN_HELPER_TYPE_NAME,
] as const);

/**
 * The one-line type alias inserted at the top of a patched TypeScript file.
 *
 * ```ts
 * type __DebuggenSpanHelper = { span<T>(name: string, meta: Record<string, unknown>, fn: () => T): T };
 * ```
 *
 * A **character-for-character** structural copy of the `DebuggenSpanHelper`
 * interface `@debuggen/telemetry`'s `src/node/span-helper.ts` declares as the
 * authoritative shape: three parameters in that order, `meta` as
 * `Record<string, unknown>`, a generic return of `T`. That module's own
 * documentation names this alias as the thing that must match it, and a fourth
 * *required* parameter appearing there would leave every patched function in
 * every project a session has ever touched calling a function it no longer
 * satisfies.
 *
 * Two properties of this line are load-bearing:
 *
 * - **It introduces no import.** That is the whole point of inserting it: a
 *   strict target project type-checks the wrapper with no new dependency, no
 *   `node_modules` change and nothing to undo beyond deleting the line. Wanting
 *   to import a type here means having lost the reason the alias exists.
 * - **It is a *type* alias.** It erases completely, so the patched file's
 *   runtime behaviour is untouched by its presence, and removing it during
 *   cleanup cannot change what the application did while it was there.
 *
 * The insertion *point* is the caller's business — see
 * {@link DIRECTIVE_PROLOGUE_LITERALS} for the one placement rule this module
 * states as data.
 */
export const HELPER_TYPE_ALIAS_TEXT = `type ${SPAN_HELPER_TYPE_NAME} = { span<T>(name: string, meta: Record<string, unknown>, fn: () => T): T };`;

/**
 * Directive prologues that must remain the first statement of a file.
 *
 * A directive is only a directive while it is in the prologue: a `"use client"`
 * or `"use server"` string that stops being the file's first statement becomes
 * an ordinary expression statement, and the module silently changes meaning —
 * a client component would be treated as a server component, or a server
 * function would stop being callable from the client. `"use strict"` is listed
 * for the same reason in the other direction: demoting it would change the
 * semantics of the code beneath it.
 *
 * {@link HELPER_TYPE_ALIAS_TEXT} therefore goes **after** any directive
 * prologue, never at the literal top of the file. Locating that position is a
 * node-placement decision and belongs to `./function-timing.ts`, which has the
 * abstract syntax tree; this module's job is to state the requirement as data
 * both sides can test against. Use {@link isDirectivePrologueLiteral} rather
 * than comparing against this tuple by hand.
 */
export const DIRECTIVE_PROLOGUE_LITERALS = Object.freeze([
  'use client',
  'use server',
  'use strict',
] as const);

/**
 * One of the directive strings in {@link DIRECTIVE_PROLOGUE_LITERALS}.
 */
export type DirectivePrologueLiteral = (typeof DIRECTIVE_PROLOGUE_LITERALS)[number];

/**
 * Whether `text` is a directive the type alias must be inserted after.
 *
 * Accepts the *unquoted* text of a string literal, which is what an abstract
 * syntax tree yields for the expression of a directive statement, and compares
 * exactly: a directive is matched by its precise spelling, so neither
 * surrounding whitespace nor a different case is a directive.
 *
 * @param text The literal text of a candidate directive, without its quotes.
 * @returns `true` when the alias must be inserted below this statement.
 *
 * @example
 * ```ts
 * isDirectivePrologueLiteral('use client'); // true
 * isDirectivePrologueLiteral('use cache'); // false — not one this module knows
 * ```
 */
export function isDirectivePrologueLiteral(text: string): boolean {
  const known: readonly string[] = DIRECTIVE_PROLOGUE_LITERALS;
  return known.includes(text);
}

/**
 * The two languages the template emits, which is a syntax decision rather than
 * a preference.
 *
 * TypeScript receives the `globalThis` cast and the `as never` argument
 * assertions the strict-mode helper call needs; JavaScript receives neither,
 * because both are **syntax errors** in a `.js` or `.jsx` file and would break
 * the developer's application the moment the dev server reloaded it.
 */
export const PATCH_LANGUAGES = Object.freeze(['typescript', 'javascript'] as const);

/** One member of {@link PATCH_LANGUAGES}. */
export type PatchLanguage = (typeof PATCH_LANGUAGES)[number];

/**
 * File extensions patched as TypeScript.
 *
 * `.ts` and `.tsx` are what the product's plan targets name. `.mts` and `.cts`
 * are included because they are TypeScript too, and misclassifying one would
 * emit an untyped `globalThis` property read into a file that type-checks it —
 * an error in the developer's project, from a template whose stated purpose is
 * not to cause one.
 */
export const TYPESCRIPT_PATCH_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.mts', '.cts'] as const);

/**
 * File extensions patched as JavaScript, which receive no TypeScript syntax at
 * all. `.mjs` and `.cjs` join `.js` and `.jsx` for the reason given on
 * {@link TYPESCRIPT_PATCH_EXTENSIONS}, in the safe direction.
 */
export const JAVASCRIPT_PATCH_EXTENSIONS = Object.freeze(['.js', '.jsx', '.mjs', '.cjs'] as const);

/**
 * Every extension this template can emit into, TypeScript first.
 *
 * An extension outside this list is refused by {@link resolvePatchLanguage}
 * rather than guessed at: the language decides whether type assertions are
 * syntax or an error, and guessing wrong is a broken application rather than a
 * missing span.
 */
export const PATCHABLE_EXTENSIONS = Object.freeze([
  ...TYPESCRIPT_PATCH_EXTENSIONS,
  ...JAVASCRIPT_PATCH_EXTENSIONS,
] as const);

/**
 * Which language the template must emit for `filePath`, decided solely by its
 * extension.
 *
 * The path is read with `extnamePosix` from `@debuggen/shared` — POSIX
 * semantics, no platform path module — and compared case-sensitively, which is
 * what `forceConsistentCasingInFileNames` projects expect and what keeps the
 * answer identical on every filesystem.
 *
 * @param filePath Any path; only its final extension is consulted, so a
 * project-relative path, an absolute path and a bare file name all answer the
 * same.
 * @returns The language, or a `PATCH_UNSUPPORTED` refusal naming the extension
 * when it is one this template cannot emit into.
 *
 * @example
 * ```ts
 * const language = resolvePatchLanguage('src/lib/thing.tsx'); // ok('typescript')
 * resolvePatchLanguage('src/lib/thing.txt'); // err(PATCH_UNSUPPORTED)
 * ```
 */
export function resolvePatchLanguage(filePath: string): Result<PatchLanguage> {
  const extension = extnamePosix(filePath);

  const typescriptExtensions: readonly string[] = TYPESCRIPT_PATCH_EXTENSIONS;
  if (typescriptExtensions.includes(extension)) {
    return ok('typescript');
  }

  const javascriptExtensions: readonly string[] = JAVASCRIPT_PATCH_EXTENSIONS;
  if (javascriptExtensions.includes(extension)) {
    return ok('javascript');
  }

  return refuse(
    extension.length === 0
      ? 'A patch target must be a file with a supported extension; this path has none.'
      : `Files with the extension ${JSON.stringify(extension)} cannot be instrumented.`,
    {
      filePath,
      extension,
      supported: [...PATCHABLE_EXTENSIONS],
    },
    `Function timing is emitted only into ${PATCHABLE_EXTENSIONS.join(', ')} files.`,
  );
}

/**
 * Whether a patched `filePath` needs {@link HELPER_TYPE_ALIAS_TEXT} inserted.
 *
 * `true` for the TypeScript extensions and `false` for the JavaScript ones: a
 * `type` alias is a syntax error in a `.js` or `.jsx` file, and a TypeScript
 * file without it would fail to compile on the `globalThis` cast the wrapper
 * uses. The rule is exported as one function so `./function-timing.ts`, the
 * cleanup path and the tests all ask the same question instead of each
 * re-deriving it from an extension list.
 *
 * An extension this template cannot emit into answers `false`, because there is
 * no alias to insert into a file that will never be patched;
 * {@link buildWrapperBody} refuses such a file outright, so no wrapper can
 * reach a TypeScript file without its alias by way of this answer.
 *
 * @param filePath Any path; only its final extension is consulted.
 * @returns `true` when the alias must accompany the wrapper.
 */
export function needsHelperTypeAlias(filePath: string): boolean {
  const language = resolvePatchLanguage(filePath);
  return language.ok && language.value === 'typescript';
}

/**
 * The identifier of the inner function the patcher moves the original body
 * into, and the name the emitted wrapper calls.
 *
 * Underscore-prefixed precisely because the wrapper declares it inside the
 * developer's own function, where a collision with a local, a parameter or an
 * imported binding would shadow application code: `__orig` is vanishingly
 * unlikely to occur in ordinary source, and the double underscore is the
 * convention this product uses for every name it injects. A caller that has
 * genuinely found a collision can override it through
 * {@link WrapperBodyOptions.innerIdentifier} — which is the supported way to
 * resolve one, rather than inventing a second spelling here.
 *
 * Note what this is *not*: a marker. The residual-instrumentation gate greps
 * for the two literals of {@link INSTRUMENTATION_MARKERS} only, so a new
 * `__DEBUGGEN`-prefixed spelling introduced alongside them would escape that
 * check entirely. This identifier is deliberately outside that namespace.
 */
export const INNER_FUNCTION_IDENTIFIER = '__orig' as const;

/**
 * The identifier of the local that holds the span helper for the duration of
 * the wrapper.
 *
 * Captured once, into a local, for two reasons that are both semantic rather
 * than stylistic: the guard and the call must see the *same* helper — reading
 * the global twice could observe a helper that arrived or was removed in
 * between — and a single read keeps the wrapper's cost to one property access
 * when no session is armed, which is the overwhelmingly common case in a
 * patched file. Overridable through
 * {@link WrapperBodyOptions.helperIdentifier}.
 */
export const HELPER_LOCAL_IDENTIFIER = '__dbg' as const;

/**
 * The identifier of the rest parameter the `'rest'` call style forwards
 * through.
 *
 * Used only for arrow targets, where `arguments` is not bound. Overridable
 * through {@link WrapperBodyOptions.restIdentifier}.
 */
export const REST_PARAMETER_IDENTIFIER = '__args' as const;

/**
 * How the wrapper forwards the caller's arguments to the inner function.
 *
 * - `'arguments'` — the form AAP §0.5.1 states verbatim, for every target that
 *   binds `arguments`: function declarations, function expressions, class
 *   methods and object-literal methods. The wrapper keeps the original
 *   parameter list, so parameter defaults, destructuring patterns and the
 *   function's `length` are all preserved exactly, and `arguments` carries what
 *   the caller actually passed.
 * - `'rest'` — for arrow functions, which have no `arguments` binding. The
 *   wrapper takes {@link WrapperBody.restParameter} instead of the original
 *   parameter list and forwards it by reference, so an arrow handed to a
 *   higher-order function still receives its positional arguments in order and
 *   the inner arrow's own defaults still apply to the arguments that were
 *   genuinely omitted.
 */
export const WRAPPER_CALL_STYLES = Object.freeze(['arguments', 'rest'] as const);

/** One member of {@link WRAPPER_CALL_STYLES}. */
export type WrapperCallStyle = (typeof WRAPPER_CALL_STYLES)[number];

/**
 * What the wrapper passes as the inner function's receiver.
 *
 * - `'this'` — forwards the enclosing function's `this`, which is what AAP
 *   §0.5.1 states and what a target whose body uses `this` requires: a class or
 *   object-literal method. Legal wherever `this` has a type.
 * - `'undefined'` — passes no receiver. Required for a standalone function
 *   declaration in a **TypeScript** file: `noImplicitThis` (part of `strict`)
 *   makes *any* reference to `this` there the error "'this' implicitly has type
 *   'any' because it does not have a type annotation", which a type assertion
 *   does not suppress — so a wrapper that forwarded `this` would break the
 *   developer's type-check. Nothing is lost by omitting it: a body that cannot
 *   legally mention `this` cannot observe the receiver either. Also the natural
 *   choice for an arrow target, whose `this` is lexical and which ignores a
 *   receiver altogether.
 *
 * The distinction is an abstract-syntax-tree question — is this target a method,
 * and is the file type-checked? — so the decision belongs to
 * `./function-timing.ts`, which can see the node. This module states both forms
 * and what each costs.
 */
export const WRAPPER_RECEIVERS = Object.freeze(['this', 'undefined'] as const);

/** One member of {@link WRAPPER_RECEIVERS}. */
export type WrapperReceiver = (typeof WRAPPER_RECEIVERS)[number];

/**
 * The keys of the emitted `meta` object literal, in emission order.
 *
 * A **contract with the runtime**, not a convention: the page agent's span
 * helper builds a `'patch'`-resolved `SourceLocation` by reading precisely
 * `file`, `line` and `column`, and takes `symbol` as the location's label and
 * as the span's `symbol` attribute. A misspelled or missing key throws nowhere
 * and logs nothing — click-to-source simply stops resolving, which is why the
 * key list is declared once, here, and asserted in the tests.
 */
export const PATCH_META_KEYS = Object.freeze(['file', 'line', 'column', 'symbol'] as const);

/**
 * The patch-recorded position the wrapper passes to the span helper.
 *
 * Mirrors the `'patch'` route of the product's source-location contract: a
 * project-relative POSIX `file`, a 1-based `line` and `column`, and the
 * `symbol` that was wrapped. The wrapper carries it as a literal rather than
 * resolving anything at run time, which is what makes the patch route the most
 * precise of the four — the position was recorded by the code that wrote the
 * wrapper.
 */
export interface PatchSpanMeta {
  /**
   * Project-relative POSIX path of the patched file, validated with
   * `isSafeRelativePath`: absolute paths, backslashes, control characters and
   * any `'..'` segment surviving normalisation are refused, as is the project
   * root itself, since a function lives in a file rather than a directory.
   */
  readonly file: string;

  /** 1-based line of the patched declaration. */
  readonly line: number;

  /** 1-based column of the patched declaration. */
  readonly column: number;

  /** The wrapped symbol's name, as the code graph knows it. */
  readonly symbol: string;
}

/**
 * The longest span name this module emits, in UTF-16 units.
 *
 * A name longer than this is refused rather than shortened: the service matches
 * a span name against the code graph, so a truncated name is a name that
 * matches nothing, and silently emitting one would trade a loud refusal for a
 * panel whose rows resolve to no source. The bound is generous for any real
 * symbol and agrees with the independent truncation the page agent's span
 * helper applies to whatever reaches it.
 */
export const MAX_SPAN_NAME_LENGTH = 200;

/**
 * The longest `file` value this module emits, in UTF-16 units.
 *
 * A path cannot be truncated — a shortened path is a *different* path — so an
 * over-long one is refused, matching the bound the runtime helper enforces when
 * it rebuilds the source location.
 */
export const MAX_META_FILE_LENGTH = 512;

/** Identifiers this module accepts, for its own names and for any override. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The identifier namespace the marker literals occupy, upper-cased.
 *
 * Derived from {@link SPAN_HELPER_GLOBAL} by dropping its trailing underscores
 * rather than spelled again, so the namespace cannot drift from the marker it
 * belongs to. No identifier the wrapper introduces may fall inside it: a name
 * such as a marker with a different suffix would sit in a patched file looking
 * exactly like product vocabulary while the residual-instrumentation gate —
 * which matches the two literals of {@link INSTRUMENTATION_MARKERS} exactly —
 * walked straight past it.
 */
const MARKER_NAMESPACE_PREFIX = SPAN_HELPER_GLOBAL.slice(
  0,
  SPAN_HELPER_GLOBAL.length - 2,
).toUpperCase();

/**
 * Line and paragraph separators, which `JSON.stringify` leaves unescaped.
 *
 * They are legal inside a JavaScript string literal from ES2019 onward, so the
 * emitted text is valid for every target this product supports — but a patched
 * file may be read by an older tool in the developer's own pipeline, and a raw
 * line terminator inside a string literal is the kind of breakage that looks
 * like a corrupt file rather than a bad patch. Escaping them costs nothing.
 */
const UNESCAPED_LINE_TERMINATORS = /[\u2028\u2029]/g;

/**
 * Serialises `value` as a JavaScript string literal.
 *
 * `JSON.stringify` is the whole mechanism, deliberately: it escapes quotes,
 * backslashes, control characters and lone surrogates, which is exactly the set
 * of characters that could otherwise let a file name or a symbol escape its
 * literal and change the meaning of the code around it. Hand-quoting is what
 * this function exists to prevent.
 *
 * @param value Any string destined for the emitted text.
 * @returns A double-quoted literal safe to splice into source.
 */
function toStringLiteral(value: string): string {
  return JSON.stringify(value).replace(UNESCAPED_LINE_TERMINATORS, (character) =>
    character === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

/**
 * Builds a `PATCH_UNSUPPORTED` refusal.
 *
 * Every expected failure in this module is a refusal to emit: the target exists
 * but its form, its position or its path cannot be wrapped safely, which is the
 * failure `PATCH_UNSUPPORTED` names in the product's closed error vocabulary.
 * The one exception is an unsafe `file`, which is a containment failure and
 * carries `PATH_OUTSIDE_PROJECT` instead.
 *
 * @param message A complete sentence naming what cannot be emitted.
 * @param details Diagnostic context. Never the developer's file contents —
 * paths, positions, identifiers and vocabulary only.
 * @param hint The developer-facing next step, when one applies.
 * @returns A failed `Result` carrying the coded error.
 */
function refuse(
  message: string,
  details: Readonly<Record<string, unknown>>,
  hint?: string,
): Result<never> {
  return err(
    new DebuggenError(
      'PATCH_UNSUPPORTED',
      message,
      hint === undefined ? { details } : { details, hint },
    ),
  );
}

/**
 * Validates one of the wrapper's identifiers, whether defaulted or overridden.
 *
 * @param role Which identifier is being checked, for the refusal message.
 * @param value The candidate identifier.
 * @returns The identifier, or a refusal naming the role.
 */
function checkIdentifier(role: string, value: string): Result<string> {
  if (!IDENTIFIER_PATTERN.test(value)) {
    return refuse(
      `The ${role} identifier ${toStringLiteral(value)} is not a JavaScript identifier, so the wrapper it would appear in could not be parsed.`,
      { role, identifier: value },
    );
  }
  return ok(value);
}

/**
 * Builds the `meta` object literal the wrapper passes to the span helper.
 *
 * Emits exactly the four keys of {@link PATCH_META_KEYS}, in that order and
 * with nothing else: `file` and `symbol` as escaped string literals, `line` and
 * `column` as integer literals. Every value is validated first, because the
 * runtime rebuilds a source location from this object all-or-nothing — a `file`
 * it refuses costs the whole location, and it has no way to report that it did.
 *
 * Exported separately from {@link buildWrapperBody} so the key names, their
 * order and the escaping can be asserted on their own, without assembling a
 * wrapper or loading an abstract syntax tree.
 *
 * @param meta The patch-recorded position.
 * @returns The object literal text, or a refusal naming the offending field.
 *
 * @example
 * ```ts
 * const literal = buildSpanMetaLiteral({
 *   file: 'src/lib/thing.ts',
 *   line: 42,
 *   column: 3,
 *   symbol: 'loadThing',
 * });
 * // ok('{ file: "src/lib/thing.ts", line: 42, column: 3, symbol: "loadThing" }')
 * ```
 */
export function buildSpanMetaLiteral(meta: PatchSpanMeta): Result<string> {
  const fileCheck = checkMetaFile(meta.file);
  if (!fileCheck.ok) {
    return fileCheck;
  }

  const lineCheck = checkPosition('line', meta.line);
  if (!lineCheck.ok) {
    return lineCheck;
  }

  const columnCheck = checkPosition('column', meta.column);
  if (!columnCheck.ok) {
    return columnCheck;
  }

  const symbolCheck = checkName('symbol name', meta.symbol);
  if (!symbolCheck.ok) {
    return symbolCheck;
  }

  return ok(
    `{ file: ${toStringLiteral(fileCheck.value)}, line: ${String(lineCheck.value)}, column: ${String(columnCheck.value)}, symbol: ${toStringLiteral(symbolCheck.value)} }`,
  );
}

/**
 * Validates `meta.file` as a project-relative POSIX path.
 *
 * Delegates the traversal, absolute-path, backslash and control-character rules
 * to `isSafeRelativePath` in `@debuggen/shared` — the product's single
 * containment predicate — and adds the two bounds this module owns: a length
 * cap, and a refusal of the project root itself, because a patched function
 * lives in a file rather than in a directory.
 *
 * @param file The candidate path.
 * @returns The path, or a `PATH_OUTSIDE_PROJECT` failure.
 */
function checkMetaFile(file: string): Result<string> {
  if (file.length === 0 || file.length > MAX_META_FILE_LENGTH || !isSafeRelativePath(file)) {
    return err(
      new DebuggenError(
        'PATH_OUTSIDE_PROJECT',
        'A patch position must name a project-relative POSIX file, and this path is not one.',
        {
          details: { length: file.length, maxLength: MAX_META_FILE_LENGTH },
          hint: 'Convert the path with toProjectRelative before recording a modification.',
        },
      ),
    );
  }

  if (normalizePosix(file) === '.') {
    return err(
      new DebuggenError(
        'PATH_OUTSIDE_PROJECT',
        'A patch position must name a file, and this path resolves to the project root.',
        { details: { file } },
      ),
    );
  }

  return ok(file);
}

/**
 * Validates a 1-based position.
 *
 * @param role `'line'` or `'column'`, for the refusal message.
 * @param value The candidate position.
 * @returns The position, or a refusal.
 */
function checkPosition(role: string, value: number): Result<number> {
  if (!Number.isInteger(value) || value < 1) {
    return refuse(
      `A patch position's ${role} must be an integer of at least one; the runtime drops a source location whose position it cannot trust.`,
      { role, value },
    );
  }
  return ok(value);
}

/**
 * Validates a name the wrapper will emit — the wrapped symbol, or the span
 * name, which are normally the same string.
 *
 * @param role Which name is being checked, for the refusal message.
 * @param value The candidate name.
 * @returns The name, or a refusal.
 */
function checkName(role: string, value: string): Result<string> {
  if (value.trim().length === 0) {
    return refuse(
      `A patch target must have a ${role}; an unnamed target cannot be matched back to the code graph.`,
      { role },
    );
  }

  if (value.length > MAX_SPAN_NAME_LENGTH) {
    return refuse(
      `A patch target's ${role} must be at most ${String(MAX_SPAN_NAME_LENGTH)} characters.`,
      { role, length: value.length, maxLength: MAX_SPAN_NAME_LENGTH },
    );
  }

  return ok(value);
}

/**
 * The comment lines emitted above the wrapper, one per array entry.
 *
 * Short on purpose. It is read by a developer who opens a file mid-session and
 * wants to know why it looks different, and by whoever reviews a diff of the
 * patch, so it says what the block is, that it is temporary, and the one
 * property of the branch below that a reader must not "simplify": the guard
 * tests whether the helper is *there*, not what it returned, which is what
 * keeps the body from running twice.
 */
export const WRAPPER_COMMENT_LINES = Object.freeze([
  '// Debug Generator: temporary instrumentation, removed when the session ends.',
  '// The guard tests helper availability, never its result, so the body runs exactly once.',
] as const);

/** Inputs for {@link buildWrapperBody}. */
export interface WrapperBodyOptions {
  /**
   * Which syntax to emit.
   *
   * Required rather than inferred, so the decision is made consciously by the
   * caller that examined the file — and then cross-checked against
   * `meta.file`'s extension, because emitting a type assertion into a `.js`
   * file is an immediate syntax error in the developer's application and
   * emitting an untyped `globalThis` read into a `.ts` file fails its
   * type-check. A declaration that disagrees with the extension is refused
   * rather than quietly preferred either way.
   */
  readonly language: PatchLanguage;

  /** How the caller's arguments reach the inner function. */
  readonly callStyle: WrapperCallStyle;

  /**
   * What the inner function receives as `this`.
   *
   * Defaults to `'this'` for the `'arguments'` call style — the form AAP §0.5.1
   * states — and to `'undefined'` for `'rest'`, whose targets are arrow
   * functions that ignore a receiver. Override it with `'undefined'` for a
   * standalone function declaration in a TypeScript file, where referencing
   * `this` is a type error; see {@link WRAPPER_RECEIVERS}.
   */
  readonly receiver?: WrapperReceiver | undefined;

  /**
   * The span name, normally the wrapped symbol's own name.
   *
   * Emitted as an escaped string literal. The service matches it against the
   * code graph, so it is a name rather than a description.
   */
  readonly spanName: string;

  /** The patch-recorded position, emitted as the `meta` argument. */
  readonly meta: PatchSpanMeta;

  /**
   * Overrides {@link INNER_FUNCTION_IDENTIFIER}, for the rare target whose
   * scope already binds that name.
   */
  readonly innerIdentifier?: string | undefined;

  /** Overrides {@link HELPER_LOCAL_IDENTIFIER}. */
  readonly helperIdentifier?: string | undefined;

  /** Overrides {@link REST_PARAMETER_IDENTIFIER}; used by the `'rest'` style. */
  readonly restIdentifier?: string | undefined;

  /**
   * Whether the target is a generator or async generator.
   *
   * Declared only so that asking for one **fails loudly**: a wrapper that calls
   * the body as a function cannot preserve `yield`, so passing `true` throws a
   * `DebuggenError` instead of returning a refusal. `../feasibility.ts` rejects
   * these targets long before a plan reaches the patcher, which makes `true`
   * here a programmer error — a gate that was skipped — rather than a condition
   * to report to the developer.
   */
  readonly generator?: boolean | undefined;
}

/**
 * The emitted wrapper, in parts and whole.
 *
 * Every field is text destined for the developer's file, apart from the four
 * that restate the resolved decisions (`language`, `callStyle`, `receiver` and
 * the identifiers) so a caller and a test can assert on what was chosen without
 * parsing the output.
 */
export interface WrapperBody {
  /** {@link WRAPPER_COMMENT_LINES}, joined with newlines. */
  readonly comment: string;

  /** `const __dbg = …;` — the single read of the span-helper global. */
  readonly helperCapture: string;

  /** `if (__dbg && typeof __dbg.span === "function") return __dbg.span(…);` */
  readonly guardedReturn: string;

  /** `return __orig.apply(…);` — the uninstrumented path. */
  readonly fallbackReturn: string;

  /**
   * The comment and the three statements, in emission order.
   *
   * Suitable for a statement-wise insertion; {@link WrapperBody.text} is the
   * same content as one string.
   */
  readonly statements: readonly string[];

  /** {@link WrapperBody.statements} joined with newlines. */
  readonly text: string;

  /**
   * The call expression both paths use, identical in each — which is what makes
   * behaviour with and without the helper indistinguishable.
   */
  readonly innerCall: string;

  /** The `meta` object literal, from {@link buildSpanMetaLiteral}. */
  readonly metaLiteral: string;

  /** The span name as an escaped string literal. */
  readonly spanNameLiteral: string;

  /**
   * The parameter list the wrapper must declare for the `'rest'` call style,
   * or `undefined` for `'arguments'`, which keeps the original parameter list.
   *
   * For TypeScript this is `...__args: unknown[]`. The annotation is
   * deliberate: `unknown[]` *widens* the wrapper's parameter types, so every
   * existing call site and every higher-order use still type-checks — an
   * arrow patched this way remains assignable to the signature it had — whereas
   * `never[]` would reject every argument at every call site and a missing
   * annotation would be an implicit `any` error. Parameter *checking* at those
   * call sites is looser while the patch is installed, which is the one
   * type-level cost of instrumenting an arrow and why the annotation is
   * documented rather than tuned.
   */
  readonly restParameter: string | undefined;

  /**
   * {@link HELPER_TYPE_ALIAS_TEXT} when the file needs it, `undefined`
   * otherwise — the resolved answer of {@link needsHelperTypeAlias} for this
   * wrapper, so the caller inserts the alias exactly when the wrapper it is
   * inserting requires one.
   */
  readonly helperTypeAlias: string | undefined;

  /** The language whose syntax was emitted. */
  readonly language: PatchLanguage;

  /** The call style that was emitted. */
  readonly callStyle: WrapperCallStyle;

  /** The receiver that was emitted. */
  readonly receiver: WrapperReceiver;

  /** The inner function's identifier, defaulted or overridden. */
  readonly innerIdentifier: string;

  /** The helper local's identifier, defaulted or overridden. */
  readonly helperIdentifier: string;

  /**
   * The rest parameter's identifier for the `'rest'` style, `undefined` for
   * `'arguments'`.
   */
  readonly restIdentifier: string | undefined;
}

/**
 * Builds the text that replaces a patched function's body.
 *
 * The caller has already moved the original body into an inner function
 * declared inside the original — that move is what preserves `this`,
 * `arguments`, parameter defaults and destructuring — and this function
 * produces the statements that call it:
 *
 * ```ts
 * // Debug Generator: temporary instrumentation, removed when the session ends.
 * // The guard tests helper availability, never its result, so the body runs exactly once.
 * const __dbg = (globalThis as { __DEBUGGEN__?: __DebuggenSpanHelper }).__DEBUGGEN__;
 * if (__dbg && typeof __dbg.span === "function") return __dbg.span("loadThing", { file: "src/lib/thing.ts", line: 42, column: 3, symbol: "loadThing" }, () => __orig.apply(this, arguments as never));
 * return __orig.apply(this, arguments as never);
 * ```
 *
 * Nothing else is emitted: no `await`, no `try`/`catch`, no inspection of the
 * returned value. See this module's overview for why each of those would change
 * the application's behaviour.
 *
 * @param options The language, call style, receiver, span name and position.
 * @returns The wrapper's parts and text, or a refusal that names what could not
 * be emitted. Every refusal is a decision **not** to touch the developer's file.
 * @throws DebuggenError When `options.generator` is `true`: generators are out
 * of scope and are rejected upstream, so reaching here with one is a skipped
 * gate rather than a reportable condition.
 *
 * @example An arrow target in a JavaScript file
 * ```ts
 * const built = buildWrapperBody({
 *   language: 'javascript',
 *   callStyle: 'rest',
 *   spanName: 'scaleEntry',
 *   meta: { file: 'src/lib/scale.js', line: 8, column: 7, symbol: 'scaleEntry' },
 * });
 * // built.value.restParameter === '...__args'
 * // built.value.innerCall === '__orig.apply(undefined, __args)'
 * ```
 */
export function buildWrapperBody(options: WrapperBodyOptions): Result<WrapperBody> {
  if (options.generator === true) {
    throw new DebuggenError(
      'PATCH_UNSUPPORTED',
      'Generator and async-generator functions have no function-timing template: a wrapper that calls the body as a function cannot preserve yield.',
      {
        details: { spanName: options.spanName, callStyle: options.callStyle },
        hint: 'Reject generator targets in feasibility before they reach the patcher.',
      },
    );
  }

  const callStyles: readonly string[] = WRAPPER_CALL_STYLES;
  if (!callStyles.includes(options.callStyle)) {
    return refuse(
      `The call style ${toStringLiteral(String(options.callStyle))} is not one this template emits.`,
      { callStyle: options.callStyle, supported: [...WRAPPER_CALL_STYLES] },
    );
  }

  const languages: readonly string[] = PATCH_LANGUAGES;
  if (!languages.includes(options.language)) {
    return refuse(
      `The language ${toStringLiteral(String(options.language))} is not one this template emits.`,
      { language: options.language, supported: [...PATCH_LANGUAGES] },
    );
  }

  const receiver: WrapperReceiver =
    options.receiver ?? (options.callStyle === 'arguments' ? 'this' : 'undefined');
  const receivers: readonly string[] = WRAPPER_RECEIVERS;
  if (!receivers.includes(receiver)) {
    return refuse(
      `The receiver ${toStringLiteral(String(receiver))} is not one this template emits.`,
      { receiver, supported: [...WRAPPER_RECEIVERS] },
    );
  }

  // The declared language and the file's extension are two statements of the
  // same fact, and a disagreement means one of them is wrong about a file this
  // module is about to rewrite — so neither is preferred over the other.
  const fileLanguage = resolvePatchLanguage(options.meta.file);
  if (!fileLanguage.ok) {
    return fileLanguage;
  }
  if (fileLanguage.value !== options.language) {
    return refuse(
      `The wrapper was requested as ${options.language} for a file whose extension is ${fileLanguage.value}.`,
      { requested: options.language, fromExtension: fileLanguage.value },
      'Derive the language from the target file rather than from the plan.',
    );
  }

  const spanName = checkName('span name', options.spanName);
  if (!spanName.ok) {
    return spanName;
  }

  const metaLiteral = buildSpanMetaLiteral(options.meta);
  if (!metaLiteral.ok) {
    return metaLiteral;
  }

  const identifiers = resolveIdentifiers(options);
  if (!identifiers.ok) {
    return identifiers;
  }
  const { inner, helper, rest } = identifiers.value;

  const isTypeScript = options.language === 'typescript';
  const receiverExpression = receiver === 'this' ? 'this' : 'undefined';
  const forwarded =
    options.callStyle === 'arguments'
      ? isTypeScript
        ? 'arguments as never'
        : 'arguments'
      : isTypeScript
        ? `${rest} as never`
        : rest;

  // `apply` rather than a spread call, in both call styles and both languages:
  // it is the only form that forwards an arbitrary argument list to a function
  // whose parameters are typed, and using one form everywhere means the
  // instrumented and uninstrumented paths are textually identical.
  const innerCall = `${inner}.apply(${receiverExpression}, ${forwarded})`;

  const helperCapture = isTypeScript
    ? `const ${helper} = (globalThis as { ${SPAN_HELPER_GLOBAL}?: ${SPAN_HELPER_TYPE_NAME} }).${SPAN_HELPER_GLOBAL};`
    : `const ${helper} = globalThis.${SPAN_HELPER_GLOBAL};`;

  // The guard tests the helper's presence and the callability of `span`, never
  // what `span` returned: a helper that answers `null` or `undefined` must not
  // send control back through the body. Both returns below call `innerCall`
  // once, and neither inspects its value.
  const guardedReturn = `if (${helper} && typeof ${helper}.span === "function") return ${helper}.span(${toStringLiteral(spanName.value)}, ${metaLiteral.value}, () => ${innerCall});`;
  const fallbackReturn = `return ${innerCall};`;

  const comment = WRAPPER_COMMENT_LINES.join('\n');
  const statements = Object.freeze([comment, helperCapture, guardedReturn, fallbackReturn]);

  return ok({
    comment,
    helperCapture,
    guardedReturn,
    fallbackReturn,
    statements,
    text: statements.join('\n'),
    innerCall,
    metaLiteral: metaLiteral.value,
    spanNameLiteral: toStringLiteral(spanName.value),
    restParameter:
      options.callStyle === 'rest'
        ? isTypeScript
          ? `...${rest}: unknown[]`
          : `...${rest}`
        : undefined,
    helperTypeAlias: isTypeScript ? HELPER_TYPE_ALIAS_TEXT : undefined,
    language: options.language,
    callStyle: options.callStyle,
    receiver,
    innerIdentifier: inner,
    helperIdentifier: helper,
    restIdentifier: options.callStyle === 'rest' ? rest : undefined,
  });
}

/** The three identifiers a wrapper introduces, resolved and validated. */
interface ResolvedIdentifiers {
  readonly inner: string;
  readonly helper: string;
  readonly rest: string;
}

/**
 * Resolves the wrapper's identifiers from the defaults and any overrides, and
 * refuses the three ways a set of them could be unsafe.
 *
 * - Not an identifier at all, which would make the wrapper unparseable.
 * - Marker-shaped: an identifier beginning `__DEBUGGEN` that is not one of
 *   {@link INSTRUMENTATION_MARKERS} would survive in a file without being
 *   caught by the residual-instrumentation gate, which greps for the two exact
 *   literals. A new spelling in that namespace is therefore refused rather than
 *   emitted.
 * - Colliding with each other, which would have one declaration shadow
 *   another inside the wrapper.
 *
 * @param options The caller's options, read for the three overrides.
 * @returns The resolved identifiers, or a refusal.
 */
function resolveIdentifiers(options: WrapperBodyOptions): Result<ResolvedIdentifiers> {
  const candidates: readonly (readonly [string, string])[] = [
    ['inner function', options.innerIdentifier ?? INNER_FUNCTION_IDENTIFIER],
    ['helper local', options.helperIdentifier ?? HELPER_LOCAL_IDENTIFIER],
    ['rest parameter', options.restIdentifier ?? REST_PARAMETER_IDENTIFIER],
  ];

  const resolved: string[] = [];
  for (const [role, candidate] of candidates) {
    const checked = checkIdentifier(role, candidate);
    if (!checked.ok) {
      return checked;
    }

    if (candidate.toUpperCase().startsWith(MARKER_NAMESPACE_PREFIX)) {
      return refuse(
        `The ${role} identifier ${toStringLiteral(candidate)} sits in the instrumentation marker namespace, where a name the residual-instrumentation check does not match exactly could be left in a file unnoticed.`,
        { role, identifier: candidate, markers: [...INSTRUMENTATION_MARKERS] },
        'Choose a name outside the marker namespace; the two markers are the only names in it.',
      );
    }

    if (resolved.includes(candidate)) {
      return refuse(
        `The ${role} identifier ${toStringLiteral(candidate)} is already used by another name the wrapper declares.`,
        { role, identifier: candidate },
      );
    }

    resolved.push(candidate);
  }

  const [inner, helper, rest] = resolved;
  if (inner === undefined || helper === undefined || rest === undefined) {
    return refuse('The wrapper identifiers could not be resolved.', {
      resolved: resolved.length,
    });
  }

  return ok({ inner, helper, rest });
}
