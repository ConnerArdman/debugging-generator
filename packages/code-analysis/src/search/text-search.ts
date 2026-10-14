/**
 * Bounded, deterministic text search over the files a project was opened with —
 * the package's *fallback* retrieval route, and the only one that is not an
 * abstract-syntax-tree query.
 *
 * ## Why a text search exists at all
 *
 * The pipeline's code-investigation stage lets the model propose read-only
 * queries that deterministic code executes. Nearly all of them are answered
 * from the code graph, which knows declarations, references, components,
 * handlers, routes and database calls — everything that *is* a symbol. This
 * module answers the remainder: the name that is not a symbol. A key inside a
 * configuration object, a marker in a comment, a fragment of a SQL string, a
 * class name in a template literal, a header name in a fetch call. None of
 * those is a declaration, so none of them is reachable through the graph, and a
 * question about one would otherwise return nothing at all.
 *
 * Embeddings-based retrieval is **explicitly out of scope** for this product,
 * so there is no vector index to fall back to either. That makes this module
 * the single non-graph retrieval mechanism in the whole system, and it is why
 * it is a first-class, tested, bounded component rather than a `grep` call
 * somewhere in a stage.
 *
 * ## Why every cap is enforced rather than documented
 *
 * What this function returns can be placed in a model prompt. A prompt has a
 * finite budget, a per-token cost and a latency proportional to its size, so an
 * unbounded search result is not merely untidy — it is a correctness problem
 * one layer up, where a single pathological query could crowd out the evidence
 * the stage actually needs. Every limit in {@link TEXT_SEARCH_LIMITS} is
 * therefore *applied in code*: the number of hits, the matches taken from any
 * one file, the characters of any one excerpt, the bytes examined in total, the
 * size of a single file, the length of the query, and the wall-clock time the
 * scan may take. {@link TextSearchResult.truncated} reports whenever any of
 * them clipped anything, so a caller never mistakes a bounded answer for an
 * exhaustive one.
 *
 * ## Privacy: the file set is inherited, never widened
 *
 * This module opens no file and enumerates no directory. It reads text only
 * from the `SourceFile`s that `../project.ts` already loaded, which is what
 * makes that module's guarantee this module's guarantee too: `.env` and every
 * `.env.*` variant, `node_modules`, `.next`, `dist`, `out`, `build`,
 * `coverage`, minified bundles and every hidden tree were excluded before a
 * single byte was read, and nothing here can put them back. The filter applied
 * below can only ever *remove* a file from that set.
 *
 * Do not "optimise" that inheritance away. Reading a path directly — even one
 * that looks like ordinary source — would move the privacy boundary out of the
 * one module that tests it and into this one, which is exactly the diffusion
 * `../project.ts` exists to prevent. There are no filesystem imports in this
 * file, and there must never be.
 *
 * Nothing that is matched is ever logged. The logger receives counts, cap
 * names, a query *length* and project-relative file paths, and never an
 * excerpt, a matched string or a line of a developer's code.
 *
 * ## Determinism
 *
 * Two identical calls return deeply equal results. Files are scanned in
 * ascending project-relative POSIX path order under a byte-wise comparison —
 * not a locale-aware one, so the order is identical on every machine — and
 * within a file matches are produced in ascending offset order. The function
 * holds no module-level state, caches nothing, memoises nothing and mutates
 * neither the project, its source files nor the caller's options object, so
 * ordering and content depend only on the arguments.
 *
 * @packageDocumentation
 */

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  DebuggenError,
  err,
  isErr,
  isSafeRelativePath,
  noopLogger,
  normalizePosix,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { Logger, Result, SourceLocation } from '@debuggen/shared';
import type { SourceFile } from 'ts-morph';

import { isEnvFilePath, isIndexableFile, shouldExcludePath } from '../project.js';
import type { LoadedProject } from '../project.js';

/**
 * The ceilings this module enforces, and the defaults it applies when a caller
 * does not narrow them.
 *
 * **These are prompt-budget constraints, not performance tuning.** A result
 * from {@link searchText} can be serialised into a model prompt, so each value
 * below is chosen to keep the worst case — a one-character query against a
 * large application — small enough to sit alongside the analysis it is meant to
 * support, rather than to displace it. They are deliberately conservative: a
 * caller that needs more evidence asks a *narrower question*, which is cheaper
 * and more useful than a wider answer.
 *
 * Every member is also a **hard ceiling**: the matching option on
 * {@link TextSearchOptions} can only ask for *less*. A caller passing a larger
 * value is clamped to the value here, so no caller can widen the budget.
 *
 * Frozen, because it is read on every search and a mutation would silently
 * re-budget every prompt in the process.
 */
export const TEXT_SEARCH_LIMITS = Object.freeze({
  /**
   * The greatest number of hits any search may return (50).
   *
   * Fifty `file:line` excerpts is already a long list for a human and a
   * substantial block of a prompt. Past that the marginal hit stops being
   * evidence and starts being noise, and a query that produces more than fifty
   * matches is telling the caller to narrow it.
   */
  maxResults: 50,

  /**
   * The greatest number of hits taken from any single file (5).
   *
   * Without a per-file cap one file with a hundred occurrences consumes the
   * entire result budget and the search reports nothing about the other
   * hundred files — the opposite of what an investigation needs. Five
   * occurrences are enough to show that a file is relevant and where.
   */
  maxMatchesPerFile: 5,

  /**
   * The greatest length of a single excerpt, in characters (200).
   *
   * An excerpt never spans more than the matched line (see
   * {@link TextSearchHit.excerpt}), and 200 characters covers an ordinary line
   * of formatted TypeScript whole. A longer line is clipped to a window
   * centred on the match, which keeps a minified or generated line from
   * contributing thousands of characters to a prompt.
   */
  maxExcerptChars: 200,

  /**
   * The greatest total volume of file text a single search may examine, in
   * characters (8 000 000).
   *
   * The aggregate ceiling, and the one that bounds the cost of a query that
   * matches nothing: without it, a search for a string that does not occur
   * would read every byte of every file. Eight megabytes of TypeScript is a
   * substantial application; a project larger than that is searched partially
   * and {@link TextSearchResult.truncated} says so.
   *
   * A **hard** ceiling, and the only cap whose enforcement spans files:
   * {@link TextSearchResult.bytesScanned} never exceeds it. A file that the
   * remaining budget cannot hold whole is examined only up to that budget — its
   * leading characters are searched and the rest of it is not read — so the
   * total lands *on* the ceiling rather than a file's length past it.
   *
   * That partial examination is for a **literal** query only. A regular
   * expression is never run against a clipped haystack, because `$`, `\b` and
   * every lookahead would read the cut as the end of the file and report a
   * match the file does not contain; such a file is skipped whole instead. See
   * {@link TextSearchOptions.regex}.
   */
  maxScannedBytes: 8_000_000,

  /**
   * The greatest size of a single file this module will read, in characters
   * (1 000 000).
   *
   * A megabyte in one file is not hand-written source: it is a generated
   * client, a bundled vendor file or a data blob that escaped the exclusions in
   * `../project.ts`. Its matches are not evidence about the developer's code,
   * and one such file would otherwise consume an eighth of
   * {@link TEXT_SEARCH_LIMITS.maxScannedBytes}. Not caller-overridable: unlike
   * the budget caps, this one protects the *shape* of the result rather than
   * its size.
   */
  maxFileBytes: 1_000_000,

  /**
   * The greatest length of `query`, in characters (512).
   *
   * Applies to a literal query and to a regular-expression pattern alike. A
   * longer pattern is rejected rather than truncated, because a half-pattern
   * matches the wrong thing silently. Five hundred characters is far beyond any
   * legible search term and well beyond any pattern a stage should be
   * generating.
   */
  maxQueryLength: 512,

  /**
   * The wall-clock budget for one scan, in milliseconds (250).
   *
   * A safety valve rather than a schedule. A literal search of eight megabytes
   * finishes in a small fraction of this, and a pattern that survives the
   * backtracking screen in {@link TextSearchOptions.regex} does too; the budget
   * exists so that a pathological pattern that slips past the screen degrades
   * into a truncated result instead of a hung stage. It is checked between
   * files and between matches, so it cannot interrupt a single `exec` call —
   * which is precisely why the static screen, and not this budget, is the
   * primary defence.
   */
  timeBudgetMs: 250,
});

/**
 * What to search for, and the budget to search within.
 *
 * `query`, `maxResults` and `maxExcerptChars` are **required**, with no
 * defaults, so that every call site states the budget it is spending. The
 * caller assembling a prompt knows how much room it has; this module does not,
 * and a default would let a new call site quietly take fifty hits when it meant
 * five.
 *
 * Every optional member spells `| undefined` explicitly. The repository
 * compiles with `exactOptionalPropertyTypes`, so a caller forwarding a value it
 * received as `boolean | undefined` — which is what a stage does with a decoded
 * model query — must be able to pass it through without first branching on it.
 */
export interface TextSearchOptions {
  /**
   * The string to find, or the regular-expression pattern when
   * {@link TextSearchOptions.regex} is `true`.
   *
   * Treated as a **literal** by default: every regular-expression
   * metacharacter in it is escaped, so `pool.query(` finds that exact text
   * rather than failing to compile. Refused when it is empty, when it is only
   * whitespace, or when it is longer than
   * {@link TEXT_SEARCH_LIMITS.maxQueryLength}.
   */
  readonly query: string;

  /**
   * The greatest number of hits to return, clamped into
   * `[1, TEXT_SEARCH_LIMITS.maxResults]`.
   *
   * Reaching this cap with input still remaining sets
   * {@link TextSearchResult.truncated}.
   */
  readonly maxResults: number;

  /**
   * The greatest length of each excerpt in characters, clamped into
   * `[1, TEXT_SEARCH_LIMITS.maxExcerptChars]`.
   *
   * Clipping any excerpt sets both {@link TextSearchHit.truncated} on that hit
   * and {@link TextSearchResult.truncated} on the envelope.
   */
  readonly maxExcerptChars: number;

  /**
   * The greatest number of hits to take from any one file.
   *
   * Defaults to {@link TEXT_SEARCH_LIMITS.maxMatchesPerFile} and is clamped
   * into `[1, TEXT_SEARCH_LIMITS.maxMatchesPerFile]`. Reaching it sets
   * {@link TextSearchResult.truncated}.
   */
  readonly maxMatchesPerFile?: number | undefined;

  /**
   * Whether to match case exactly. **Defaults to `false`** — case-insensitive.
   *
   * Case-insensitive is the friendlier default for an investigation tool: a
   * developer, or a model, asking about `checkout` should not miss `Checkout`
   * and `CHECKOUT_TIMEOUT`, and a question is rarely about the capitalisation
   * of a name. A caller that has an exact identifier in hand — one taken from
   * the code graph, say — passes `true`.
   */
  readonly caseSensitive?: boolean | undefined;

  /**
   * Whether a match must stand alone as a word.
   *
   * When `true`, a match is kept only if the character immediately before it
   * and the character immediately after it are each absent (a text edge) or a
   * **non-word** character, where a word character is ASCII `[0-9A-Za-z_]`.
   * Note that this constrains the characters *around* the whole match and is
   * therefore not identical to a regular-expression `\b`, which is evaluated
   * relative to the match's own first and last characters.
   *
   * On a line reading `// fixture-marker: basin-drift`, the query `marker`
   * matches — it is bounded by `-` and `:`, neither a word character — while
   * `marke` does not, because the character after it is `r`.
   *
   * Composes with {@link TextSearchOptions.regex}: the boundary test is applied
   * to the extent of the whole match, whatever produced it.
   */
  readonly wholeWord?: boolean | undefined;

  /**
   * Restrict the search to files matching at least one of these globs.
   *
   * When absent or empty, every file in the project's set is eligible. Patterns
   * are matched against the **project-relative POSIX path** only, so a result
   * can never depend on where the checkout lives. See {@link searchText} for
   * the supported syntax.
   */
  readonly includeGlobs?: readonly string[] | undefined;

  /**
   * Drop files matching any of these globs. Exclude wins over include.
   *
   * Because every character that is not a glob operator is matched literally,
   * a real path with regular-expression punctuation in it works as written —
   * `app/(observatory)/**` excludes that route group, parentheses and all.
   */
  readonly excludeGlobs?: readonly string[] | undefined;

  /**
   * Treat {@link TextSearchOptions.query} as a regular-expression pattern.
   *
   * Compiled with the `g` flag, plus `i` unless
   * {@link TextSearchOptions.caseSensitive} is `true`; no other flag is added,
   * so `^` and `$` anchor to the file's text rather than to each line, `.` does
   * not match a newline, and Unicode property escapes — which need a flag this
   * module does not add — fail to compile.
   *
   * An invalid pattern is reported as an `Err`, never thrown. A pattern that
   * risks catastrophic backtracking is refused by a conservative static screen
   * before it is ever run against a file: a repeated group whose body itself
   * contains a quantifier or an alternation is rejected with a hint. That screen
   * errs towards refusal — `(?:foo|bar)*` is harmless in practice and is still
   * refused — because the alternative is a stage that hangs.
   *
   * One interaction with {@link TextSearchOptions.maxScannedBytes} follows from
   * those anchoring semantics. Because a pattern is evaluated against the
   * string it is executed over, a file too large for the *remaining* aggregate
   * budget is **skipped whole** in this mode rather than examined as far as the
   * budget reaches: presenting a pattern with the leading characters of a file
   * would make the budget cut look like the end of the file, and `x$` or
   * `x(?=y$)` would then report a match the file does not contain. A literal
   * query has no such assertion to mislead, so it does examine that leading
   * text. Either way {@link TextSearchResult.truncated} reports that something
   * was not examined.
   */
  readonly regex?: boolean | undefined;

  /**
   * Cancel the scan.
   *
   * Checked before the scan starts, before each file, and periodically while a
   * single file is being matched. An aborted search returns an `Err`, never a
   * partial `Ok`: a truncated-looking success would be indistinguishable from a
   * budget-limited one, and a caller that cancelled wants to know it got
   * nothing.
   */
  readonly signal?: AbortSignal | undefined;

  /**
   * Where to report counts and cap events, at `debug` level.
   *
   * Defaults to `noopLogger`. Matched text, excerpts and file contents are
   * never logged — only counts, cap names, the query's *length* and
   * project-relative paths.
   */
  readonly logger?: Logger | undefined;

  /**
   * The greatest total volume of file text to examine, in characters.
   *
   * Defaults to {@link TEXT_SEARCH_LIMITS.maxScannedBytes} and is clamped into
   * `[1, TEXT_SEARCH_LIMITS.maxScannedBytes]`. Present so that the aggregate
   * ceiling is reachable — and therefore testable — without an eight-megabyte
   * fixture.
   *
   * A hard ceiling at whatever value it takes, including a value smaller than
   * the first file: {@link TextSearchResult.bytesScanned} never exceeds it. For
   * a literal query the budget is *spent* rather than abandoned, so a small
   * value examines the leading characters of the first files and marks the
   * result truncated; it does not scan nothing and it does not overrun by a
   * file. With {@link TextSearchOptions.regex} a file too large for the
   * remaining budget is skipped whole instead — a pattern must never be run
   * against a clipped haystack — so a small value there can leave
   * `bytesScanned` well below the ceiling.
   */
  readonly maxScannedBytes?: number | undefined;

  /**
   * The wall-clock budget for the scan, in milliseconds.
   *
   * Defaults to {@link TEXT_SEARCH_LIMITS.timeBudgetMs} and is clamped into
   * `[1, TEXT_SEARCH_LIMITS.timeBudgetMs]`. Present for the same reason as
   * {@link TextSearchOptions.maxScannedBytes}: a budget that cannot be lowered
   * cannot be exercised by a test.
   */
  readonly timeBudgetMs?: number | undefined;
}

/**
 * One match, with just enough of its line to be legible and a location that
 * opens in an editor.
 */
export interface TextSearchHit {
  /**
   * Where the match is: project-relative POSIX file, 1-based line, 1-based
   * column.
   *
   * `resolvedBy` is `'code-graph'` with the confidence that route reports by
   * default, read from `DEFAULT_RESOLUTION_CONFIDENCE` rather than written out,
   * so this module cannot drift from the other three resolvers.
   *
   * `symbol` and `endLine` are deliberately absent. Naming the enclosing symbol
   * is the abstract-syntax-tree layer's job and a text match may not be inside
   * one at all; `endLine` would always equal `line`, because a hit never spans
   * more than the line it starts on.
   */
  readonly location: SourceLocation;

  /**
   * The text of the match's line, possibly clipped to a window around the
   * match.
   *
   * **Never more than one line**, and never with its line terminator. That
   * bound is what keeps neighbouring code — which the caller did not ask about
   * and may not be entitled to spend prompt budget on — out of the result.
   * Nothing is added to mark a clip: no ellipsis, no marker, because the
   * `excerpt`/{@link TextSearchHit.matchOffsetInExcerpt} invariant below has to
   * hold character for character.
   */
  readonly excerpt: string;

  /**
   * The **0-based** character offset of the match within
   * {@link TextSearchHit.excerpt}.
   *
   * The invariant, which callers may rely on and a test asserts:
   * `excerpt.slice(matchOffsetInExcerpt, matchOffsetInExcerpt + matchLength)`
   * is the matched text, or its leading portion when the match itself was
   * clipped.
   */
  readonly matchOffsetInExcerpt: number;

  /**
   * The length of the match *as it appears in the excerpt*, which is shorter
   * than the match when the match ran past the line or past the excerpt window.
   */
  readonly matchLength: number;

  /**
   * Whether **this hit's** excerpt was clipped — because its line was longer
   * than the excerpt budget, or because the match itself ran past the line or
   * the window.
   *
   * Distinct from {@link TextSearchResult.truncated}, which is about the search
   * as a whole. A hit can be untruncated in a truncated search and vice versa.
   */
  readonly truncated: boolean;
}

/**
 * The outcome of one search: the hits, and what it cost to find them.
 */
export interface TextSearchResult {
  /**
   * The query exactly as the caller supplied it, echoed so a stored or logged
   * result is self-describing.
   */
  readonly query: string;

  /**
   * The hits, in ascending project-relative path order and, within a file, in
   * ascending offset order. Frozen.
   */
  readonly hits: readonly TextSearchHit[];

  /**
   * How many matches the scan *observed*, which is at least
   * `hits.length` and can exceed it.
   *
   * The two diverge when a cap prevented a match from being recorded: the scan
   * observes one match beyond a full result quota before it stops, which is how
   * `truncated` comes to be set rather than guessed. It is a count of what this
   * scan saw and never an estimate of what the project contains — a scan that
   * stopped early saw less than there was.
   */
  readonly totalMatches: number;

  /**
   * How many files were actually examined, whole or in part.
   *
   * A file skipped for exceeding {@link TEXT_SEARCH_LIMITS.maxFileBytes} is not
   * counted, because none of it was read; neither is a file the scan never
   * reached, nor one removed by a glob or by the inherited exclusions, nor — in
   * {@link TextSearchOptions.regex} mode — one skipped because the remaining
   * scanned-bytes budget could not hold it whole. A file the scanned-bytes
   * ceiling left *partially* examined, which only a literal query does, **is**
   * counted — its leading characters were read and its matches are in `hits` —
   * so this is a count of files opened to the matcher rather than of files
   * exhausted, and {@link TextSearchResult.truncated} is what says one of them
   * was clipped.
   */
  readonly filesSearched: number;

  /**
   * How much file text was examined, in **characters** of file text (UTF-16
   * code units, the unit `String.length` counts).
   *
   * Accumulated per file, as the whole length of each file that was examined —
   * except the last file examined, which is counted only up to the budget that
   * remained when the scan reached it. **Never more than the effective
   * `maxScannedBytes`**, which is the caller's value clamped into
   * `[1, TEXT_SEARCH_LIMITS.maxScannedBytes]`; a literal scan stopped by that
   * ceiling lands exactly on it, while a {@link TextSearchOptions.regex} scan
   * can stop below it, because a file the remaining budget cannot hold whole is
   * skipped rather than clipped in that mode. A file skipped for size or for
   * that reason contributes nothing. The unit is characters rather than encoded
   * bytes because the text is already in memory as a string and re-encoding
   * every file to count its bytes would cost more than the search.
   */
  readonly bytesScanned: number;

  /**
   * Whether the search was **not exhaustive** — `true` if and only if some cap
   * clipped something.
   *
   * Set when any of these happened: the result cap was reached with input still
   * remaining, the scan stopped with files left unexamined, a per-file cap was
   * reached, the scanned-bytes ceiling was hit — including the case where it
   * left one file examined only as far as the remaining budget reached, whose
   * unread tail may hold matches this scan could not see, and the case where a
   * pattern could not be run against such a file at all and it was skipped — a
   * file was skipped for exceeding the single-file size cap, the time budget
   * expired, or any hit's excerpt was clipped. `false` means the result is
   * complete for the query as asked, within the file set the project was opened
   * with.
   *
   * Reaching a per-file cap counts even though it does not prove more matches
   * existed in that file. That is the conservative direction, and the only one
   * that is safe: a caller may treat `false` as "this is everything", so
   * `false` has to be earned.
   */
  readonly truncated: boolean;
}

/**
 * The error code every failure from this module carries.
 *
 * One code, drawn from the closed vocabulary `@debuggen/shared` owns, because
 * every way this function can fail is the same kind of event to a caller: the
 * static analysis of the target project could not answer. `details.reason`
 * discriminates the cases for a caller that wants to branch, and `hint` tells
 * the developer what to change. Neither ever carries matched text, a file's
 * contents or the query itself.
 */
const SEARCH_ERROR_CODE = 'CODE_INDEX_FAILED';

/** The value of `details.operation` on every error this module raises. */
const SEARCH_OPERATION = 'text-search';

/**
 * Builds the module's one error shape.
 *
 * @param reason A stable, machine-readable discriminator for `details.reason`.
 * @param message What went wrong, for a log or a developer.
 * @param hint The next step the developer should take.
 * @param details Extra machine context. Counts, lengths and enumerations only —
 * never the query, an excerpt or a file's contents.
 * @param cause The underlying thrown value, when there was one. Reachable
 * through the standard `Error` property and printed by every stack formatter.
 * @returns The error to wrap in `err`.
 */
function searchError(
  reason: string,
  message: string,
  hint: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): DebuggenError {
  return new DebuggenError(SEARCH_ERROR_CODE, message, {
    hint,
    details: { operation: SEARCH_OPERATION, reason, ...details },
    cause,
  });
}

/**
 * Whether an options argument is an object whose members can be read.
 *
 * An array and a function are refused along with every primitive: this module
 * reads named members off the argument, and none of those shapes carries them.
 * Refusing here is what lets the rest of the function read `options.query`,
 * `options.logger` and the caps without a per-member existence check.
 *
 * @param value The `options` argument, as it arrived.
 * @returns `true` when members can be read off it.
 */
function isReadableOptions(value: unknown): value is TextSearchOptions {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a project argument is the handle `openProject` returns.
 *
 * Structural rather than nominal — the three members this module actually uses
 * — because the handle crosses a package boundary and an `instanceof` check
 * would tie this module to a class it does not own. It is a guard against a
 * malformed call, not a validation of the project itself: a handle that has the
 * three members is used, and whatever it reports is what gets searched.
 *
 * @param value The `loaded` argument, as it arrived.
 * @returns `true` when the value can be searched through.
 */
function isProjectHandle(value: unknown): value is LoadedProject {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<Record<keyof LoadedProject, unknown>>;

  return (
    typeof candidate.projectRoot === 'string' &&
    typeof candidate.sourceFiles === 'function' &&
    typeof candidate.projectRelative === 'function'
  );
}

/**
 * A description of a refused argument that is safe to put in `details`: what
 * kind of value arrived, never the value itself.
 *
 * `details` reaches a log and a developer-facing message, and this module's
 * error contract is that neither ever carries the query, an excerpt or a file's
 * contents. A type name debugs a malformed call without breaking that.
 *
 * @param value The refused argument.
 * @returns A short type description.
 */
function describeArgument(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Escapes every regular-expression metacharacter in a literal string.
 *
 * Applied to {@link TextSearchOptions.query} whenever
 * {@link TextSearchOptions.regex} is not `true`, which is what lets a literal
 * query contain `(`, `.`, `?`, `[`, `$` or a backslash and still find exactly
 * itself. The set is the standard one plus `/`, which needs no escape in a
 * `RegExp` built from a string but costs nothing to escape and keeps the output
 * safe to paste into a regular-expression literal.
 *
 * The pattern is written inline rather than hoisted to module scope on purpose:
 * a `RegExp` literal evaluates to a *new* object each time, so this function
 * shares no `lastIndex` with anything and the module keeps no mutable state.
 *
 * @param literal The text to match exactly.
 * @returns A pattern that matches `literal` and nothing else.
 */
function escapeRegExpLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Escapes a single character for use as a literal inside a generated pattern.
 *
 * Used by {@link matchesGlob} for every character that is not one of its three
 * operators, which is what makes a path containing regular-expression
 * punctuation — `app/(observatory)/basins/[id]/page.tsx`, for instance — match
 * literally instead of being read as a group and a character class.
 *
 * @param character Exactly one character.
 * @returns The character, backslash-escaped when it is a metacharacter.
 */
function escapeGlobLiteral(character: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(character) ? `\\${character}` : character;
}

/**
 * Whether a project-relative POSIX path matches a glob pattern.
 *
 * Three operators, and nothing else:
 *
 * - `**` — any number of path segments, including none. Written as `` `**\/` ``
 *   it also consumes the separator that follows it, so `` `src/**\/*.ts` ``
 *   matches `src/a.ts` as well as `src/lib/deep/a.ts`. A `**` that is not
 *   followed by a separator matches any run of characters, separators included.
 * - `*` — any run of characters *within one segment*; it never crosses a `/`.
 * - `?` — exactly one character, never a `/`.
 *
 * Every other character is matched literally, escaped through
 * {@link escapeGlobLiteral}. There is no character-class, brace-expansion or
 * negation syntax: a caller that needs one of those is better served by naming
 * the directory, and the absence keeps `[id]` in a real Next.js route path
 * meaning `[id]`.
 *
 * The pattern is normalised first — separators converted, `.` segments dropped,
 * repeated and trailing separators collapsed — so `./src/**` and `src/**` are
 * the same pattern. The path is expected to be project-relative already, which
 * is what keeps a match independent of where the checkout lives. The whole path
 * must match: the generated pattern is anchored at both ends.
 *
 * Compilation happens per call. Glob lists in this product are a handful of
 * patterns at most while file sets run to thousands, and the arithmetic favours
 * a self-contained predicate that a test can pin over a cache this module would
 * then have to keep honest.
 *
 * @param projectRelativePosixPath The path to test, project-relative and POSIX.
 * @param pattern The glob.
 * @returns `true` when the whole path matches the whole pattern.
 */
function matchesGlob(projectRelativePosixPath: string, pattern: string): boolean {
  const normalized = normalizePosix(toPosix(pattern));

  let source = '^';
  let index = 0;

  while (index < normalized.length) {
    const character = normalized.charAt(index);

    if (character === '*') {
      if (normalized.charAt(index + 1) === '*') {
        index += 2;
        if (normalized.charAt(index) === '/') {
          // `**/` — any number of leading segments, or none at all.
          index += 1;
          source += '(?:.*/)?';
        } else {
          // A trailing or mid-segment `**` — anything, separators included.
          source += '.*';
        }
        continue;
      }

      index += 1;
      source += '[^/]*';
      continue;
    }

    if (character === '?') {
      index += 1;
      source += '[^/]';
      continue;
    }

    index += 1;
    source += escapeGlobLiteral(character);
  }

  source += '$';

  return new RegExp(source).test(projectRelativePosixPath);
}

/**
 * Whether a file survives the caller's glob filters.
 *
 * Include is a requirement only when it is present and non-empty; exclude
 * always wins. Both are evaluated against the project-relative path.
 *
 * @param projectRelativePosixPath The candidate's path.
 * @param includeGlobs Patterns at least one of which must match, or nothing.
 * @param excludeGlobs Patterns none of which may match.
 * @returns `true` when the file is eligible to be searched.
 */
function passesGlobs(
  projectRelativePosixPath: string,
  includeGlobs: readonly string[] | undefined,
  excludeGlobs: readonly string[] | undefined,
): boolean {
  if (excludeGlobs !== undefined) {
    for (const pattern of excludeGlobs) {
      if (matchesGlob(projectRelativePosixPath, pattern)) {
        return false;
      }
    }
  }

  if (includeGlobs === undefined || includeGlobs.length === 0) {
    return true;
  }

  for (const pattern of includeGlobs) {
    if (matchesGlob(projectRelativePosixPath, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Brings a caller-supplied cap into a usable range.
 *
 * Out-of-range values are **clamped, not rejected**, and consistently so for
 * every numeric cap: a value that is not a finite number — `NaN`, an infinity,
 * or anything a JavaScript caller passed that is not a number at all — becomes
 * the module's default; a fractional value is floored; anything below `1`
 * becomes `1`; anything above the module's own ceiling becomes that ceiling. A
 * caller can therefore only ever ask for *less* than
 * {@link TEXT_SEARCH_LIMITS} allows.
 *
 * Clamping rather than failing is deliberate. These are budget hints from a
 * caller that is itself assembling a prompt, and the useful response to "give
 * me 10 000 hits" is fifty hits with `truncated` set, not an error that loses
 * the investigation. The *query* is the input that fails loudly, because a
 * malformed query cannot be repaired into the search the caller meant.
 *
 * @param value The caller's value, or `undefined` to take the default.
 * @param ceiling The module's ceiling for this cap, which is also its default.
 * @returns An integer in `[1, ceiling]`.
 */
function clampCap(value: number | undefined, ceiling: number): number {
  if (value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
    return ceiling;
  }

  const floored = Math.floor(value);
  if (floored < 1) {
    return 1;
  }

  return floored > ceiling ? ceiling : floored;
}

/**
 * Whether a character code is an ASCII word character, `[0-9A-Za-z_]`.
 *
 * ASCII deliberately, and documented as such on
 * {@link TextSearchOptions.wholeWord}: a definition that included Unicode
 * letters would make `wholeWord` behave differently for identifiers in
 * different alphabets, and the identifiers this tool searches for in a
 * TypeScript project are ASCII in practice.
 *
 * A `NaN` from an out-of-range `charCodeAt` answers `false`, which is the
 * fail-open direction for a boundary test — a position off the end of the text
 * *is* a boundary.
 *
 * @param code A UTF-16 code unit.
 * @returns `true` when the code is a word character.
 */
function isWordCharCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/**
 * Whether the region `[start, end)` of `text` is bounded by non-word characters
 * or by the edges of the text.
 *
 * See {@link TextSearchOptions.wholeWord} for why this is stated in terms of
 * the characters surrounding the *whole* match rather than as a `\b`.
 *
 * @param text The file's full text.
 * @param start The match's start offset.
 * @param end The match's end offset, exclusive.
 * @returns `true` when the match stands alone as a word.
 */
function hasWordBoundaries(text: string, start: number, end: number): boolean {
  if (start > 0 && isWordCharCode(text.charCodeAt(start - 1))) {
    return false;
  }

  if (end < text.length && isWordCharCode(text.charCodeAt(end))) {
    return false;
  }

  return true;
}

/**
 * One quantifier, as the backtracking screen reads it.
 */
interface Quantifier {
  /** How many characters of the pattern the quantifier occupies. */
  readonly length: number;

  /**
   * The greatest number of repetitions it permits; `Number.POSITIVE_INFINITY`
   * for `*`, `+` and `{n,}`.
   *
   * The screen only treats a quantifier as dangerous when this exceeds `1`: a
   * group applied at most once — `(a+)?` — cannot multiply its body's
   * ambiguity, however ambiguous that body is.
   */
  readonly upperBound: number;
}

/**
 * Reads the quantifier at `index`, if there is one.
 *
 * `{` is only a quantifier when it encloses a well-formed repetition count;
 * `{foo}` is a literal brace in a JavaScript regular expression and is read as
 * one here too.
 *
 * @param pattern The caller's pattern.
 * @param index The offset to read at.
 * @returns The quantifier, or `undefined` when `index` holds something else.
 */
function readQuantifier(pattern: string, index: number): Quantifier | undefined {
  const character = pattern.charAt(index);

  if (character === '*' || character === '+') {
    return { length: 1, upperBound: Number.POSITIVE_INFINITY };
  }

  if (character === '?') {
    return { length: 1, upperBound: 1 };
  }

  if (character !== '{') {
    return undefined;
  }

  const closing = pattern.indexOf('}', index + 1);
  if (closing === -1) {
    return undefined;
  }

  const body = pattern.slice(index + 1, closing);
  const length = closing - index + 1;

  if (/^\d+$/.test(body)) {
    return { length, upperBound: Number.parseInt(body, 10) };
  }

  if (!/^\d+,\d*$/.test(body)) {
    return undefined;
  }

  const upper = body.slice(body.indexOf(',') + 1);
  return {
    length,
    upperBound: upper.length === 0 ? Number.POSITIVE_INFINITY : Number.parseInt(upper, 10),
  };
}

/**
 * How many characters after a `(` belong to the group's *type* rather than to
 * its body.
 *
 * This is what stops the screen from reading the `?` of a non-capturing group
 * as a quantifier. Without it, `(?:foo)*` would look like a repeated group
 * whose body contains a quantifier and would be refused — and `(?:…)` is the
 * most ordinary grouping form there is.
 *
 * Recognised: `?:` (non-capturing), `?=` and `?!` (lookahead), `?<=` and `?<!`
 * (lookbehind), and `?<name>` (named capture). A `(?` followed by anything else
 * is not a group JavaScript can compile, so the `?` is consumed as an opaque
 * character and compilation is left to report the fault.
 *
 * @param pattern The caller's regular-expression source.
 * @param index The offset immediately after the `(`.
 * @returns The number of characters to skip; `0` for a plain capturing group.
 */
function readGroupPrefixLength(pattern: string, index: number): number {
  if (pattern.charAt(index) !== '?') {
    return 0;
  }

  const second = pattern.charAt(index + 1);
  if (second === ':' || second === '=' || second === '!') {
    return 2;
  }

  if (second === '<') {
    const third = pattern.charAt(index + 2);
    if (third === '=' || third === '!') {
      return 3;
    }

    const closing = pattern.indexOf('>', index + 2);
    return closing === -1 ? 2 : closing - index + 1;
  }

  return 1;
}

/**
 * What the screen has seen inside one group, or at the top level.
 */
interface GroupFrame {
  /** Whether a quantifier has appeared directly inside this group. */
  hasQuantifier: boolean;

  /** Whether an alternation (`|`) has appeared directly inside this group. */
  hasAlternation: boolean;
}

/**
 * Whether a pattern is at risk of catastrophic backtracking, judged
 * conservatively and without running it.
 *
 * The rule, in one sentence: **a group that is repeated more than once and
 * whose body contains a quantifier or an alternation is refused.** That is the
 * shape behind every exponential-blowup pattern in practice — `(a+)+`,
 * `(a|a)*`, `(\s*\w+)+` — and refusing it costs the caller a rewrite while
 * admitting it can cost a stage its liveness, because a single `exec` call
 * cannot be interrupted by the time budget.
 *
 * The screen is deliberately coarse and will refuse patterns that are perfectly
 * safe: `(?:foo|bar)*` never backtracks catastrophically, and it is refused all
 * the same. The error carries a hint naming the remedy, and a literal search —
 * the default — is never screened at all, because an escaped literal has no
 * quantifiers to nest.
 *
 * It walks the pattern rather than parsing it, tracking three things: escapes
 * (`\(` is not a group), character classes (`[*+]` holds two literals, not two
 * quantifiers), and a stack of frames recording what has appeared inside each
 * open group. When a group closes, the quantifier that follows it — if any — is
 * read, and the closed frame is judged against it. A quantified group also
 * counts as a quantifier inside its *parent*, which is what makes the rule
 * apply at every depth.
 *
 * Unbalanced parentheses are left alone: the pattern will fail to compile, and
 * reporting an invalid pattern is a better error than reporting a
 * backtracking risk.
 *
 * @param pattern The caller's regular-expression source.
 * @returns `true` when the pattern must be refused.
 */
function hasBacktrackingRisk(pattern: string): boolean {
  const stack: GroupFrame[] = [{ hasQuantifier: false, hasAlternation: false }];
  let inCharacterClass = false;
  let index = 0;

  while (index < pattern.length) {
    const character = pattern.charAt(index);

    if (character === '\\') {
      // An escape and whatever it escapes are one literal unit.
      index += 2;
      continue;
    }

    if (inCharacterClass) {
      if (character === ']') {
        inCharacterClass = false;
      }
      index += 1;
      continue;
    }

    if (character === '[') {
      inCharacterClass = true;
      index += 1;
      continue;
    }

    if (character === '(') {
      stack.push({ hasQuantifier: false, hasAlternation: false });
      index += 1 + readGroupPrefixLength(pattern, index + 1);
      continue;
    }

    if (character === ')') {
      if (stack.length === 1) {
        // Unbalanced. Let compilation report it.
        index += 1;
        continue;
      }

      const closed = stack.pop();
      const enclosing = stack.at(-1);
      index += 1;

      const quantifier = readQuantifier(pattern, index);
      if (quantifier === undefined) {
        continue;
      }
      index += quantifier.length;

      if (
        quantifier.upperBound > 1 &&
        closed !== undefined &&
        (closed.hasQuantifier || closed.hasAlternation)
      ) {
        return true;
      }

      if (enclosing !== undefined) {
        enclosing.hasQuantifier = true;
      }
      continue;
    }

    if (character === '|') {
      const current = stack.at(-1);
      if (current !== undefined) {
        current.hasAlternation = true;
      }
      index += 1;
      continue;
    }

    const quantifier = readQuantifier(pattern, index);
    if (quantifier !== undefined) {
      const current = stack.at(-1);
      if (current !== undefined) {
        current.hasQuantifier = true;
      }
      index += quantifier.length;
      continue;
    }

    index += 1;
  }

  return false;
}

/**
 * How many inner-loop iterations pass between cancellation and time-budget
 * checks while a single file is being matched.
 *
 * Between *files* both are checked unconditionally, which is enough for
 * ordinary source. This interval covers the other case: one very large file in
 * which a pattern produces a great many candidate positions — zero-length
 * matches, or matches the `wholeWord` test rejects — none of which reaches the
 * per-file cap that would otherwise end the loop. A thousand iterations is
 * frequent enough to stay responsive and rare enough that the two checks do not
 * show up in the cost of the scan.
 */
const CANCELLATION_CHECK_INTERVAL = 1024;

/** A file that survived the exclusions and the caller's globs. */
interface SearchCandidate {
  /** The loaded source file; its text is already in memory. */
  readonly file: SourceFile;

  /** Its project-relative POSIX path, which is also the sort key. */
  readonly relativePath: string;
}

/**
 * Orders candidates by project-relative POSIX path, byte-wise.
 *
 * Comparison is by UTF-16 code unit rather than by locale, so the order does
 * not depend on the machine's language settings — which is what makes a
 * test expectation, and a prompt built from these hits, reproducible.
 *
 * @param left The first candidate.
 * @param right The second candidate.
 * @returns A negative number, zero or a positive number, as `Array#sort` wants.
 */
function compareCandidates(left: SearchCandidate, right: SearchCandidate): number {
  if (left.relativePath < right.relativePath) {
    return -1;
  }

  if (left.relativePath > right.relativePath) {
    return 1;
  }

  return 0;
}

/** An excerpt and the position of the match inside it. */
interface ExcerptWindow {
  /** The excerpt text: one line, or a window within it. */
  readonly excerpt: string;

  /** The 0-based offset of the match within {@link ExcerptWindow.excerpt}. */
  readonly matchOffsetInExcerpt: number;

  /** The match's length as it appears in the excerpt. */
  readonly matchLength: number;

  /** Whether anything was clipped to produce this excerpt. */
  readonly truncated: boolean;
}

/**
 * Cuts the excerpt for one match out of the file's text.
 *
 * Two rules produce everything below. **An excerpt never spans more than the
 * line the match starts on**, which is what keeps code the caller did not ask
 * about out of a prompt; and the excerpt is always a *contiguous slice* of that
 * line, with nothing inserted to mark a clip, which is what lets
 * {@link TextSearchHit.matchOffsetInExcerpt} be exact.
 *
 * The line ends at the first carriage return or line feed at or after the
 * match, so `\n`, `\r\n` and a lone `\r` all terminate it and no terminator
 * ever appears in an excerpt. When the line fits the budget it is returned
 * whole. When it does not, a window of exactly `maxExcerptChars` characters is
 * taken, positioned so the match sits in the middle of the remaining room and
 * shifted back inside the line at either edge; the match start is always inside
 * the window. A match longer than the budget is clipped to it, and a match that
 * ran past the end of its line is clipped there.
 *
 * @param text The file's full text.
 * @param lineStart The offset of the first character of the match's line.
 * @param matchStart The match's offset in `text`.
 * @param matchLength The match's full length in `text`.
 * @param maxExcerptChars The excerpt budget, already clamped.
 * @returns The excerpt, the match's offset within it, the visible match length,
 * and whether anything was clipped.
 */
function buildExcerpt(
  text: string,
  lineStart: number,
  matchStart: number,
  matchLength: number,
  maxExcerptChars: number,
): ExcerptWindow {
  let lineEnd = matchStart;
  while (lineEnd < text.length) {
    const code = text.charCodeAt(lineEnd);
    // 10 = line feed, 13 = carriage return.
    if (code === 10 || code === 13) {
      break;
    }
    lineEnd += 1;
  }

  const line = text.slice(lineStart, lineEnd);
  const startInLine = Math.min(Math.max(matchStart - lineStart, 0), line.length);
  const lengthInLine = Math.min(matchLength, line.length - startInLine);
  const clippedByLine = lengthInLine < matchLength;

  if (line.length <= maxExcerptChars) {
    return {
      excerpt: line,
      matchOffsetInExcerpt: startInLine,
      matchLength: lengthInLine,
      truncated: clippedByLine,
    };
  }

  const visibleMatchLength = Math.min(lengthInLine, maxExcerptChars);
  const contextBudget = maxExcerptChars - visibleMatchLength;
  const leftBudget = Math.floor(contextBudget / 2);
  const latestWindowStart = line.length - maxExcerptChars;
  const windowStart = Math.min(
    Math.max(startInLine - leftBudget, 0),
    latestWindowStart,
    startInLine,
  );

  const excerpt = line.slice(windowStart, windowStart + maxExcerptChars);
  const matchOffsetInExcerpt = Math.max(startInLine - windowStart, 0);

  return {
    excerpt,
    matchOffsetInExcerpt,
    matchLength: Math.max(Math.min(visibleMatchLength, excerpt.length - matchOffsetInExcerpt), 0),
    truncated: true,
  };
}

/**
 * Turns one match into a {@link TextSearchHit}.
 *
 * Line and column come from ts-morph's `getLineAndColumnAtPos`, which reports
 * both 1-based — the convention every producer in this product speaks, and the
 * one `SourceLocation` requires. The line's start offset is then derived from
 * the column rather than recomputed, which is what keeps the excerpt and the
 * reported column describing the same character.
 *
 * Returns `undefined` rather than a hit if the position is not usable. That
 * cannot happen for an offset taken from the same text, and the guard is here
 * because the alternative failure mode is a `SourceLocation` that
 * `parseSourceLocation` rejects at a boundary far away from this file.
 *
 * @param candidate The file the match is in.
 * @param text The file's full text.
 * @param matchStart The match's offset.
 * @param matchLength The match's full length.
 * @param maxExcerptChars The excerpt budget, already clamped.
 * @returns The hit, or `undefined` when no valid location could be built.
 */
function buildHit(
  candidate: SearchCandidate,
  text: string,
  matchStart: number,
  matchLength: number,
  maxExcerptChars: number,
): TextSearchHit | undefined {
  const { line, column } = candidate.file.getLineAndColumnAtPos(matchStart);

  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) {
    return undefined;
  }

  const lineStart = matchStart - (column - 1);
  if (lineStart < 0) {
    return undefined;
  }

  const window = buildExcerpt(text, lineStart, matchStart, matchLength, maxExcerptChars);

  return {
    location: {
      file: candidate.relativePath,
      line,
      column,
      resolvedBy: 'code-graph',
      confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
    },
    excerpt: window.excerpt,
    matchOffsetInExcerpt: window.matchOffsetInExcerpt,
    matchLength: window.matchLength,
    truncated: window.truncated,
  };
}

/**
 * Compiles the matcher for one search, reporting a bad pattern instead of
 * throwing.
 *
 * Both modes end up as a `RegExp`, including the literal one. That is not
 * indirection for its own sake: matching a literal case-insensitively by
 * lower-casing the haystack would be wrong, because case folding is not
 * length-preserving for every character — a single Turkish dotted capital `İ`
 * folds to two code units — and every offset after such a character, and so
 * every line, column and excerpt derived from it, would be wrong by one. The
 * regular-expression engine folds case without moving offsets.
 *
 * Flags are `g`, plus `i` unless the caller asked for case sensitivity, and
 * nothing else; see {@link TextSearchOptions.regex} for what that implies for a
 * caller's pattern.
 *
 * @param query The literal or pattern.
 * @param useRegex Whether `query` is a pattern.
 * @param caseSensitive Whether to match case exactly.
 * @returns `Ok` with the compiled matcher, or `Err` when the pattern is invalid.
 */
function compileMatcher(query: string, useRegex: boolean, caseSensitive: boolean): Result<RegExp> {
  const source = useRegex ? query : escapeRegExpLiteral(query);
  const flags = caseSensitive ? 'g' : 'gi';

  try {
    return ok(new RegExp(source, flags));
  } catch (cause) {
    return err(
      searchError(
        'pattern-invalid',
        'The regular-expression pattern could not be compiled.',
        'Check the pattern, or search for a literal string by leaving `regex` unset.',
        { syntaxError: describeThrown(cause), queryLength: query.length },
        cause,
      ),
    );
  }
}

/**
 * The message of a caught value, for `details`.
 *
 * A regular-expression compilation failure explains itself precisely — "Invalid
 * group", "Nothing to repeat" — and that sentence is worth far more to a
 * developer than the code that caught it. It describes the caller's own pattern
 * and never a file's contents, so it is safe in `details`.
 *
 * @param thrown Whatever was caught.
 * @returns The message, or a fixed description for a non-`Error` value.
 */
function describeThrown(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : 'unknown compilation failure';
}

/**
 * Whether a cancellation has been requested.
 *
 * @param signal The caller's signal, if it supplied one.
 * @returns `true` when the search must stop.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * The error an aborted search reports.
 *
 * An abort is an `Err` and never a partial `Ok`: a caller cannot tell a
 * cancelled result from a budget-limited one, and a half-finished scan
 * presented as a success would be evidence about the project that nobody
 * actually gathered.
 *
 * @param details Counts describing how far the scan had got. The signal's
 * `reason` is deliberately not included: it is an arbitrary caller value and
 * `details` may be logged and shown.
 * @returns The error to wrap in `err`.
 */
function abortError(details: Readonly<Record<string, unknown>>): DebuggenError {
  return searchError(
    'aborted',
    'The text search was cancelled before it completed.',
    'Retry the search, or narrow it so it finishes sooner.',
    details,
  );
}

/**
 * Searches the text of a project's loaded files for a literal or a pattern,
 * bounded on every axis and ordered deterministically.
 *
 * This is the package's non-abstract-syntax-tree retrieval route. Reach for it
 * when the thing being looked for is not a declaration — a key in a
 * configuration object, a marker in a comment, a fragment of a SQL string, a
 * class name in a template literal — and for anything that *is* a declaration
 * use the code graph instead, which knows what the name means rather than just
 * where the characters are.
 *
 * ## Which files are searched
 *
 * Exactly those the project was opened with, filtered down and never widened.
 * The inherited exclusions — every `.env*` file, `node_modules`, `.next`,
 * `dist`, `out`, `build`, `coverage`, minified bundles, hidden trees — are
 * applied by `../project.ts` before this function is ever called, and are
 * re-checked here so that the guarantee does not depend on a single call site
 * being correct. On top of that, {@link TextSearchOptions.includeGlobs} and
 * {@link TextSearchOptions.excludeGlobs} apply, both matched against the
 * project-relative POSIX path with the three-operator syntax documented on
 * {@link TextSearchOptions.includeGlobs}. No file is opened, no directory is
 * enumerated, and no type is resolved: the text is already in memory.
 *
 * ## Glob syntax
 *
 * `**` matches any number of path segments — written `` `**\/` `` it also
 * consumes the following separator, so `` `src/**\/*.ts` `` matches
 * `src/a.ts` as well as `src/lib/a.ts`. `*` matches within one segment and `?`
 * matches one character; neither crosses a `/`. Every other character is
 * literal, so `app/(observatory)/**` and `app/**\/[id]/page.tsx` mean what they
 * appear to mean.
 *
 * ## What bounds the result
 *
 * Six caps, each applied and each reported. `maxResults` bounds the hits,
 * `maxMatchesPerFile` stops one file monopolising them, `maxExcerptChars`
 * bounds each excerpt, `maxScannedBytes` bounds the text examined,
 * {@link TEXT_SEARCH_LIMITS.maxFileBytes} skips a file too large to be
 * hand-written source, and `timeBudgetMs` bounds the wall clock. A caller may
 * only *lower* them; a larger value is clamped. Whenever any of them clipped
 * anything, {@link TextSearchResult.truncated} is `true`, so a `false` there
 * can be read as "this is everything".
 *
 * `maxScannedBytes` is the one cap that spans files, and it is exact rather
 * than approached: the file the budget runs out in is examined only as far as
 * the budget reaches, so {@link TextSearchResult.bytesScanned} never exceeds
 * the effective ceiling. A match that touches that cut is not reported, because
 * its extent — and, under `wholeWord`, its trailing boundary — is decided by
 * characters the budget did not allow to be read. In `regex` mode that partial
 * examination does not happen at all: a pattern is evaluated against the string
 * it is run over, so a cut would present itself as the end of the file and an
 * anchor or a lookahead would report a match the file does not contain. Such a
 * file is skipped whole instead, and the result says it was truncated.
 *
 * ## Ordering
 *
 * Files in ascending project-relative POSIX path order, byte-wise; within a
 * file, matches in ascending offset order. Two identical calls return deeply
 * equal results.
 *
 * ## Failures
 *
 * Never throws. An empty or whitespace-only query, an over-long query, an
 * invalid regular expression, a pattern that risks catastrophic backtracking
 * and a cancellation each come back as `Err` with code `'CODE_INDEX_FAILED'`, a
 * `details.reason` to branch on and a `hint` naming the remedy. A cancelled
 * search is never reported as a partial success.
 *
 * "Never throws" holds for *values* as well as for types, because this is the
 * fallback retrieval route for a name a model asked about (AAP 0.4.2) and the
 * call is assembled from that model's output: an `options` argument that is not
 * an object at all — `null`, `undefined`, a number, an array — and a `loaded`
 * argument that is not a project handle are refused as `Err` with
 * `details.reason` `'options-invalid'` and `'project-invalid'`, in front of the
 * first member read. Those two checks are why a malformed tool call costs the
 * investigation one refused query rather than the whole stage (AAP 0.5.5).
 *
 * @param loaded The project to search, as `openProject` returned it.
 * @param options What to search for and the budget to spend.
 * @returns `Ok` with the hits and the scan's accounting — including for a
 * search that matched nothing — or `Err` describing why no search was run.
 *
 * @example
 * ```ts
 * const found = searchText(loaded, {
 *   query: 'pool.query(',
 *   maxResults: 20,
 *   maxExcerptChars: 160,
 *   excludeGlobs: ['**\/*.test.ts'],
 * });
 * if (isOk(found)) {
 *   for (const hit of found.value.hits) {
 *     console.log(formatSourceLocation(hit.location), hit.excerpt);
 *   }
 * }
 * ```
 */
export function searchText(
  loaded: LoadedProject,
  options: TextSearchOptions,
): Result<TextSearchResult> {
  // Both arguments are admitted before either is read. The types below are
  // what an in-process caller writes; the values are what a model-assembled
  // tool call actually passes, and reading `options.logger` off a `null` is the
  // one way this function could have thrown.
  if (!isReadableOptions(options)) {
    return err(
      searchError(
        'options-invalid',
        'A text search needs an options object naming at least a query.',
        'Pass an object such as `{ query: "pool.query(" }`; a missing, null or non-object argument names no search.',
        { received: describeArgument(options) },
      ),
    );
  }

  if (!isProjectHandle(loaded)) {
    return err(
      searchError(
        'project-invalid',
        'A text search needs the project handle `openProject` returned.',
        'Open the project with `openProject` and pass the handle it returns; this search reads source text only through that handle.',
        { received: describeArgument(loaded) },
      ),
    );
  }

  const logger = options.logger ?? noopLogger;
  const query = options.query;

  // The query is the one input that fails loudly rather than being clamped: a
  // query cannot be repaired into the search the caller meant.
  if (typeof query !== 'string' || query.length === 0 || query.trim().length === 0) {
    return err(
      searchError(
        'query-empty',
        'A text search needs a query with at least one non-whitespace character.',
        'Provide something to search for; an empty or blank query matches nothing useful.',
      ),
    );
  }

  if (query.length > TEXT_SEARCH_LIMITS.maxQueryLength) {
    return err(
      searchError(
        'query-too-long',
        `A text search query may be at most ${String(TEXT_SEARCH_LIMITS.maxQueryLength)} characters.`,
        'Shorten the query. A long query is almost always a narrower question asked the wrong way.',
        { queryLength: query.length, maxQueryLength: TEXT_SEARCH_LIMITS.maxQueryLength },
      ),
    );
  }

  const useRegex = options.regex === true;
  const caseSensitive = options.caseSensitive === true;
  const wholeWord = options.wholeWord === true;

  const maxResults = clampCap(options.maxResults, TEXT_SEARCH_LIMITS.maxResults);
  const maxExcerptChars = clampCap(options.maxExcerptChars, TEXT_SEARCH_LIMITS.maxExcerptChars);
  const maxMatchesPerFile = clampCap(
    options.maxMatchesPerFile,
    TEXT_SEARCH_LIMITS.maxMatchesPerFile,
  );
  const maxScannedBytes = clampCap(options.maxScannedBytes, TEXT_SEARCH_LIMITS.maxScannedBytes);
  const timeBudgetMs = clampCap(options.timeBudgetMs, TEXT_SEARCH_LIMITS.timeBudgetMs);

  if (useRegex && hasBacktrackingRisk(query)) {
    return err(
      searchError(
        'pattern-backtracking-risk',
        'The regular-expression pattern repeats a group that itself contains a quantifier or an alternation, which can backtrack catastrophically.',
        'Rewrite the pattern without a quantifier or an alternation inside a repeated group, or search for a literal string by leaving `regex` unset.',
        { queryLength: query.length },
      ),
    );
  }

  const compiled = compileMatcher(query, useRegex, caseSensitive);
  if (isErr(compiled)) {
    return compiled;
  }
  const matcher = compiled.value;

  if (isAborted(options.signal)) {
    return err(abortError({ filesSearched: 0, hits: 0 }));
  }

  // The file set: `loaded.sourceFiles()` and nothing else, narrowed by the
  // inherited exclusions and by the caller's globs. Every step below can only
  // remove a file. Nothing here may ever add one.
  const candidates: SearchCandidate[] = [];
  for (const file of loaded.sourceFiles()) {
    const absolutePath = file.getFilePath();

    const relativePath = loaded.projectRelative(absolutePath);
    if (relativePath === undefined || !isSafeRelativePath(relativePath)) {
      continue;
    }

    // Belt and braces. `../project.ts` has already applied all three, and the
    // guarantee is its own; repeating them costs a few string comparisons and
    // means a future change to how a project is opened cannot quietly turn this
    // module into the place a secret is read.
    if (isEnvFilePath(relativePath) || !isIndexableFile(relativePath)) {
      continue;
    }
    if (shouldExcludePath(loaded.projectRoot, absolutePath)) {
      continue;
    }

    if (!passesGlobs(relativePath, options.includeGlobs, options.excludeGlobs)) {
      continue;
    }

    candidates.push({ file, relativePath });
  }

  candidates.sort(compareCandidates);

  const hits: TextSearchHit[] = [];
  let totalMatches = 0;
  let filesSearched = 0;
  let bytesScanned = 0;
  let truncated = false;
  const startedAt = Date.now();

  for (let fileIndex = 0; fileIndex < candidates.length; fileIndex += 1) {
    const candidate = candidates[fileIndex];
    if (candidate === undefined) {
      continue;
    }

    if (isAborted(options.signal)) {
      return err(abortError({ filesSearched, hits: hits.length }));
    }

    if (bytesScanned >= maxScannedBytes) {
      truncated = true;
      logger.debug('text search stopped at the scanned-bytes ceiling', {
        bytesScanned,
        maxScannedBytes,
        filesSearched,
        filesUnexamined: candidates.length - fileIndex,
      });
      break;
    }

    if (Date.now() - startedAt > timeBudgetMs) {
      truncated = true;
      logger.debug('text search stopped at the time budget', {
        timeBudgetMs,
        filesSearched,
        filesUnexamined: candidates.length - fileIndex,
      });
      break;
    }

    const text = candidate.file.getFullText();

    if (text.length > TEXT_SEARCH_LIMITS.maxFileBytes) {
      // Not counted in `filesSearched` or `bytesScanned`: none of it was read.
      truncated = true;
      logger.debug('text search skipped a file over the single-file size cap', {
        file: candidate.relativePath,
        textLength: text.length,
        maxFileBytes: TEXT_SEARCH_LIMITS.maxFileBytes,
      });
      continue;
    }

    // The aggregate ceiling is hard, so a file the remaining budget cannot hold
    // whole is examined only up to that budget rather than in full. `remaining`
    // is strictly positive: the guard at the top of this iteration already
    // ended the scan when the budget was spent.
    const remaining = maxScannedBytes - bytesScanned;
    const clipped = text.length > remaining;

    if (clipped && useRegex) {
      // A pattern is never run against a clipped haystack. A literal has no way
      // to tell a budget cut from a file's end — an occurrence found in the
      // leading characters is an occurrence in the file, at that offset — but a
      // pattern does: `$`, `\b` and every lookahead are evaluated against the
      // *string* they are executed over, so a cut would present itself as the
      // end of the file and `…(?=x$)` would match text the budget never read.
      // A hit reported from that is not an incomplete answer, it is a false
      // one, and this module's output is evidence a model reasons over. So the
      // file is skipped whole — counted in neither `filesSearched` nor
      // `bytesScanned`, exactly like a file over the single-file size cap — and
      // the scan continues to the files that do still fit the budget.
      truncated = true;
      logger.debug('text search skipped a file a pattern could not be run against in part', {
        file: candidate.relativePath,
        textLength: text.length,
        remaining,
        maxScannedBytes,
      });
      continue;
    }

    const scanned = clipped ? text.slice(0, remaining) : text;

    // A partially examined file still counts in `filesSearched`, because part
    // of it was read and its matches are reported; `bytesScanned` grows by
    // exactly what was examined, which lands the total *on* the ceiling and
    // lets the next iteration's guard end the scan.
    filesSearched += 1;
    bytesScanned += scanned.length;

    if (clipped) {
      truncated = true;
      logger.debug('text search examined only the head of a file at the scanned-bytes ceiling', {
        file: candidate.relativePath,
        scannedLength: scanned.length,
        textLength: text.length,
        bytesScanned,
        maxScannedBytes,
      });
    }

    matcher.lastIndex = 0;
    let matchesInFile = 0;
    let iterations = 0;
    let stopScan = false;

    for (;;) {
      iterations += 1;
      if (iterations % CANCELLATION_CHECK_INTERVAL === 0) {
        if (isAborted(options.signal)) {
          return err(abortError({ filesSearched, hits: hits.length }));
        }
        if (Date.now() - startedAt > timeBudgetMs) {
          truncated = true;
          stopScan = true;
          logger.debug('text search stopped at the time budget', {
            timeBudgetMs,
            filesSearched,
            file: candidate.relativePath,
          });
          break;
        }
      }

      const match = matcher.exec(scanned);
      if (match === null) {
        break;
      }

      const matched = match[0];
      if (matched === undefined) {
        break;
      }

      if (matched.length === 0) {
        // A pattern that can match the empty string would otherwise leave
        // `lastIndex` where it was and spin here forever. Advancing by one
        // makes every iteration consume a character, so the loop terminates;
        // an empty match is not evidence of anything and is not recorded.
        matcher.lastIndex = match.index + 1;
        if (matcher.lastIndex > scanned.length) {
          break;
        }
        continue;
      }

      const matchStart = match.index;

      if (clipped && matchStart + matched.length >= scanned.length) {
        // A match that reaches the cut was decided by characters the budget did
        // not allow to be read: under `wholeWord` its trailing boundary is one
        // of them, and under `regex` a greedy match's own extent is. So the
        // rule is that an occurrence touching the cut is not reported — and not
        // counted in `totalMatches` either, which counts matches *observed* and
        // this one was not: what was seen is a prefix of something whose extent
        // is unknown. The file's scan ends here; `truncated` already says the
        // ceiling clipped this file.
        truncated = true;
        break;
      }

      if (wholeWord && !hasWordBoundaries(scanned, matchStart, matchStart + matched.length)) {
        // Retry from one character in rather than from the end of the rejected
        // match: an occurrence that does stand alone may overlap this one.
        matcher.lastIndex = matchStart + 1;
        continue;
      }

      totalMatches += 1;

      if (hits.length >= maxResults) {
        // A match the result budget has no room for. Observing it is what turns
        // "the quota filled" into the fact that input remained, which is the
        // difference between a truncated result and a complete one.
        truncated = true;
        stopScan = true;
        logger.debug('text search reached the result cap with input remaining', {
          maxResults,
          filesSearched,
          totalMatches,
        });
        break;
      }

      // The scanned prefix, never the whole text: an excerpt may only be cut
      // from text the budget paid for. Line and column still come from the
      // whole file — `buildHit` asks the `SourceFile` for them — so a hit found
      // in a clipped file points at exactly the same place it would have in a
      // complete scan, and only its excerpt window is bounded by the cut. An
      // excerpt whose line runs past the cut therefore ends at the cut; the
      // envelope's `truncated` is what reports that, since a hit's own
      // `truncated` is about the excerpt budget.
      const hit = buildHit(candidate, scanned, matchStart, matched.length, maxExcerptChars);
      if (hit === undefined) {
        continue;
      }

      hits.push(hit);
      if (hit.truncated) {
        truncated = true;
      }

      matchesInFile += 1;
      if (matchesInFile >= maxMatchesPerFile) {
        // Conservative: reaching the cap does not prove this file held more
        // matches, and `truncated` has to be earned in the safe direction.
        truncated = true;
        logger.debug('text search reached the per-file match cap', {
          file: candidate.relativePath,
          maxMatchesPerFile,
        });
        break;
      }
    }

    if (stopScan) {
      break;
    }

    if (hits.length >= maxResults) {
      // The budget is spent. Anything after this file is unexamined, and an
      // unexamined file is a search that was not exhaustive.
      if (fileIndex + 1 < candidates.length) {
        truncated = true;
      }
      break;
    }
  }

  logger.debug('text search completed', {
    queryLength: query.length,
    regex: useRegex,
    caseSensitive,
    wholeWord,
    filesEligible: candidates.length,
    filesSearched,
    bytesScanned,
    totalMatches,
    hits: hits.length,
    truncated,
  });

  return ok(
    Object.freeze({
      query,
      hits: Object.freeze(hits),
      totalMatches,
      filesSearched,
      bytesScanned,
      truncated,
    }),
  );
}
