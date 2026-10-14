/**
 * The source-map resolution route: a browser stack trace in, project-relative
 * {@link SourceLocation} values out.
 *
 * This is one of the four routes that put a `SourceLocation` on a runtime item
 * (AAP 0.4.2, "Source resolution path"), and the only one that starts from a
 * *generated* position. The browser agent captures an `Error().stack` at the
 * moment a `fetch` or an XHR is started
 * (`packages/telemetry/src/browser/fetch.ts`); every frame in it points into a
 * dev-server chunk, which is JavaScript nobody wrote. Mapping those frames back
 * to the TypeScript the developer is looking at is what turns "this request came
 * from somewhere in `page-3f2a.js`" into a chip that opens their editor on the
 * right line.
 *
 * The other three routes — patch metadata, the code graph and the React owner
 * chain — answer for items this one cannot, which is why **skipping is this
 * module's contract**: see "Skip, never throw" below.
 *
 * ## Three coordinate systems meet here
 *
 * This is the single most error-prone fact in the file, so it is stated once
 * here and again at each conversion site:
 *
 * | Producer | line | column |
 * | --- | --- | --- |
 * | a V8 stack frame ({@link StackFrame}) | 1-based | **1-based** |
 * | `originalPositionFor`'s needle and result | 1-based | **0-based** |
 * | {@link SourceLocation} (AAP 0.2.3) | 1-based | **1-based** |
 *
 * The two conversions therefore run in *opposite* directions and are written as
 * two named, commented steps rather than as inline arithmetic:
 * {@link toNeedleColumn} subtracts one going in, and the assembly in
 * {@link resolveMappedFrame} adds one coming out. An off-by-one here is silent:
 * `originalPositionFor` defaults to a greatest-lower-bound search, so a needle
 * one column early does not fail — it cheerfully returns the *previous*
 * segment, and the developer lands on the wrong token with full confidence.
 *
 * ## Skip, never throw
 *
 * Neither {@link resolveStackFrame} nor {@link resolveStack} ever rejects or
 * throws. A frame that cannot be resolved — no map on the chunk, no mapping at
 * that position, a source outside the project, a map that no longer matches the
 * file on disk — yields `undefined` (or is simply absent from the returned
 * array) and is explained once at `debug` level. That is not leniency: most
 * frames of a real stack are unresolvable (bundler runtime, dependencies), and
 * an exception raised here would take down the whole click-to-source feature
 * instead of one frame of one chain.
 *
 * ## Two content branches, and what the content is for
 *
 * A map either carries its originals in `sourcesContent` or it does not, and
 * both cases are supported: `sourceContentFor` first, then a read of the file
 * from the project through three layered gates — {@link resolveWithinProject},
 * then **canonical containment** (`fs.realpathSync` on the root and on the
 * target, re-checked with {@link isWithin}), then `readFileNoFollow`. The
 * content is used for exactly two things, and nothing else:
 *
 * 1. **Sanity-validating the mapped position.** A map left over from an earlier
 *    edit maps into a file that has since changed, and a location past the end
 *    of a line or of the file is worse than no location at all — the editor
 *    silently clamps it. When content is available and the position is out of
 *    range, the frame is skipped.
 * 2. **Deriving `symbol`** when the map's segment carries no `names` index, by
 *    reading the identifier at (or immediately after) the resolved column.
 *
 * When no content can be read at all the map is taken as the authority, the
 * position is emitted unvalidated, and the fact is logged at `debug`.
 *
 * ### Why the project read is canonicalised, and not merely contained
 *
 * The path that second branch opens is derived from a map's `sources` entry.
 * That entry is served by the dev server and reached from an `Error().stack`
 * captured in the inspected page, so it is untrusted input, and what it
 * produces leaves this module as protocol data: the content feeds
 * {@link positionWithinContent} and {@link symbolFor}, and a derived
 * `SourceLocation.symbol` is an identifier read out of that file.
 *
 * {@link resolveWithinProject} is a **string-level** gate and says so in its
 * own documentation; `readFileNoFollow`'s `O_NOFOLLOW` refuses a symbolic link
 * only at the **final** component. Neither sees an *interior* component that is
 * a link out of the project, so the composition of the two lets
 * `<root>/src/lib -> /etc` expose `<root>/src/lib/passwd` — a defect
 * `packages/shared/src/node/safe-fs.test.ts` proves for that exact
 * composition, and `paths.ts` states as an obligation on every caller that
 * opens a path it did not construct itself. This module discharges it:
 * {@link canonicalProjectRoot} resolves the root once per call, every candidate
 * is resolved with `fs.realpathSync` and re-checked with {@link isWithin}
 * *before* {@link ResolveStackOptions.readSourceFile} is consulted at all, the
 * **canonical** path is what the reader is handed, and the identity is
 * revalidated after the read so a swap during it is caught rather than
 * trusted. `O_NOFOLLOW` remains underneath as the backstop it is.
 *
 * A refusal is a skip like every other: `undefined`, one `debug` record, and
 * the map left as the authority.
 *
 * ## Two decisions that would break silently if reversed
 *
 * - **No `mapUrl` argument.** `TraceMap` and `FlattenMap`/`AnyMap` both accept
 *   an optional second argument that resolves each `sources` entry against the
 *   map's own URL. It is deliberately **not** passed: `./normalize.ts` speaks
 *   the bundler spellings (`webpack://_N_E/./src/x.ts`,
 *   `turbopack:///[project]/src/x.ts`), and rewriting them into
 *   `http://127.0.0.1:3000/...` URLs first would turn every source into an
 *   unrecognised absolute URL, which normalisation then rejects. What the
 *   resolved sources this module reads *do* still differ from the authored ones
 *   by is `sourceRoot` prefixing and RFC 3986 dot-segment removal — and the
 *   second of those is not cosmetic: it discards a `'..'` that leaves the root
 *   of an absolute path, so the resolved spelling of an escaping source reads
 *   as an ordinary project path. Which spellings of a source may therefore be
 *   trusted is decided in {@link sourceCandidatesFor}, and it is the one place
 *   that decision is made.
 * - **`AnyMap` for a sectioned document, `TraceMap` otherwise.** Turbopack
 *   emits index maps, and in `@jridgewell/trace-mapping` 0.3.31 the plain
 *   `TraceMap` constructor *throws* on one (it reads `sources` before it checks
 *   for `sections`). The branch is taken on
 *   {@link isSectionedSourceMap} — a statement about the document — never by
 *   trying one constructor and catching the failure.
 *
 * ## The dev-server origin pin
 *
 * `fetchSourceMap` requires a pinned dev-server origin and refuses every lookup
 * without a usable one, because loopback alone is not an authorisation on a
 * developer's machine — this product's own service is one of the things
 * listening there, and a stack string is untrusted input captured from the
 * inspected page. This module forwards
 * {@link ResolveStackOptions.devServerOrigin} verbatim and **resolves nothing
 * when it is absent**. The field is optional in the type only so that a caller
 * with no dev server (and therefore no maps to read) gets an empty result
 * rather than a type error; in behaviour it is required, and the session's
 * `devServerUrl` (AAP 0.2.3) is what to pass.
 *
 * ## Frames of a hot-updated module
 *
 * Most frames are **chunk-relative**: V8 reports the line and column in the
 * chunk file, and the chunk's map — an index map, for Turbopack — is read in
 * those absolute coordinates. One kind is not. When Turbopack's dev runtime
 * applies a hot update it `eval`s each changed module's factory with a
 * `//# sourceURL` of `<chunk>.js?id=<module id>`, so the frames of that
 * module's code — for this product, typically a file an instrumentation patch
 * just rewrote — carry the chunk's URL plus that one query parameter and
 * positions **relative to the evaluated module**. Read against the chunk's map
 * those positions land in whatever module happens to open the chunk, usually
 * a dependency, and the frame would be refused as not project source.
 *
 * Such a frame is therefore recognised by its URL ({@link moduleRelativeChunkOf})
 * and mapped differently ({@link resolveModuleRelativeFrame}):
 *
 * | Step | What happens |
 * | --- | --- |
 * | map | the chunk's map, from the URL without the query — the chunk as served now, which contains the updated module |
 * | coordinates | each project section's own map, the line moved up by Turbopack's three-line module prelude |
 * | acceptance | a segment must **start** at the position, and the location must pass every check an ordinary frame's does |
 * | choice | one distinct answer; else the one in a file known to be re-evaluated ({@link ResolveStackOptions.reevaluatedFiles}); else the one whose section names the frame's function; else nothing |
 *
 * A chunk whose map is not an index map is not Turbopack's, so a frame with
 * such a query there is mapped chunk-relative like any other. The per-module
 * map a Next.js dev server can serve is not used: that endpoint is one
 * framework's, and it needs the module id, which is redacted before a stack
 * reaches this module.
 *
 * ## Dependencies
 *
 * `@debuggen/shared` and `@debuggen/shared/node` are the only `@debuggen/*`
 * imports (AAP 0.2.2, enforced by `no-restricted-imports`), and
 * `@jridgewell/trace-mapping` is the only third-party one — no `ts-morph` (so
 * the click-to-source path stays free of the AST toolchain, which is also why
 * this module does not import `../project.ts`), no `zod` (validation goes
 * through shared's {@link parseSourceLocation}), and never the `source-map`
 * package, which AAP 0.2.4 rejects repository-wide for its WASM
 * initialisation.
 *
 * One Node built-in is imported directly, `node:fs`, and for one call:
 * `realpathSync` in {@link canonicalPathOf}, which is the canonical-containment
 * gate described above. Nothing else here touches the filesystem directly —
 * the read itself goes through `@debuggen/shared/node`'s `readFileNoFollow` —
 * and `@debuggen/shared/node` exposes no realpath helper to route it through.
 *
 * ## State
 *
 * None. Every export is a pure function or a frozen constant; the per-call
 * memoisation of maps, tracers and file content lives in a value created inside
 * each call and dropped when it returns, so one resolution can never observe
 * another's. Cross-call reuse is opt-in through
 * {@link ResolveStackOptions.cache}.
 *
 * @example
 * ```ts
 * const cache = createSourceMapCache();
 * const locations = await resolveStack(event.attributes.initiatorStack, {
 *   projectRoot: session.projectRoot,
 *   devServerOrigin: session.devServerUrl,
 *   cache,
 *   logger,
 * });
 * // locations[0] is the innermost resolvable frame: 'src/lib/thing.ts:41:5'
 * ```
 */

import { realpathSync } from 'node:fs';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isErr,
  isWithin,
  noopLogger,
  parseSourceLocation,
  resolveWithinProject,
} from '@debuggen/shared';
import type { LogFields, Logger, SourceLocation } from '@debuggen/shared';
import { readFileNoFollow } from '@debuggen/shared/node';
import {
  AnyMap,
  TraceMap,
  originalPositionFor,
  sourceContentFor,
  traceSegment,
} from '@jridgewell/trace-mapping';
import type { EncodedSourceMap, SectionedSourceMap } from '@jridgewell/trace-mapping';

import { fetchSourceMap, isSectionedSourceMap } from './fetch-map.js';
import type {
  RawSourceMapDocument,
  SectionedSourceMapDocument,
  SourceMapCache,
  SourceMapDocument,
} from './fetch-map.js';
import { hasEscapingTraversal, normalizeSourcePath, resolveSourceUnderRoot } from './normalize.js';

/**
 * How many frames of one stack {@link resolveStack} will resolve by default.
 *
 * A responsiveness bound, not a correctness one. The stacks this route sees are
 * `fetch` initiator stacks captured in the page, which are short, and the
 * caller is a click-to-source hop that has to feel instant: a developer is
 * waiting for an editor to open. Every frame past this count is skipped, and
 * the frames are considered in stack order, so the innermost — the ones a
 * developer means by "where did this come from" — are the ones resolved.
 *
 * Override with {@link ResolveStackOptions.maxFrames} when a caller genuinely
 * wants a deeper chain and can afford it.
 */
export const DEFAULT_MAX_FRAMES = 24;

/**
 * How many **distinct** chunk URLs {@link resolveStack} will look a map up for
 * in one call, by default.
 *
 * The second responsiveness bound, and the one that matters more: a map lookup
 * is an HTTP request for a chunk plus a `JSON.parse` of a document that can run
 * to megabytes, while a second frame in an already-fetched chunk costs nothing.
 * A real stack spans two or three chunks; a stack that spans a dozen is either
 * pathological or hostile. Once the budget is spent, remaining frames are
 * resolved only if their chunk's map was already loaded in this call, and are
 * otherwise skipped.
 *
 * Override with {@link ResolveStackOptions.maxMaps}.
 */
export const DEFAULT_MAX_MAPS = 8;

/**
 * One frame of a V8 stack trace, pointing at a position in a generated chunk.
 *
 * **`line` and `column` are both 1-based**, exactly as V8 reports them in the
 * `at fn (url:line:column)` form — this is the fact the whole file turns on,
 * and the reason {@link toNeedleColumn} exists. A frame whose numbers came from
 * anywhere other than a V8 stack string must be converted by its producer
 * before it arrives here.
 *
 * `url` is an absolute `http:`/`https:` URL. Frames pointing at anything else
 * (`native`, `<anonymous>`, `webpack-internal:///`, `chrome-extension://`,
 * `node:internal/…`) are dropped by {@link parseStackFrames} and refused by
 * {@link resolveStackFrame}, because no dev-server map can describe them.
 */
export interface StackFrame {
  /**
   * The function slot as the runtime printed it, with `async`/`new` decoration
   * and an `[as alias]` suffix removed, or `undefined` for an anonymous frame.
   *
   * **Informational only.** It is the name in the *generated* code, so it is
   * never used as the resolved `symbol` — see the note on
   * {@link resolveStackFrame} — and exists so a caller can log or display the
   * frame it asked about.
   */
  readonly fn?: string;

  /** The absolute `http:`/`https:` URL of the generated chunk. */
  readonly url: string;

  /** The 1-based line in the generated chunk. */
  readonly line: number;

  /** The **1-based** column in the generated chunk, as V8 reports it. */
  readonly column: number;
}

/**
 * The files a dev server re-evaluated, as {@link ResolveStackOptions.reevaluatedFiles}
 * takes them: the project-relative paths, or a function that produces them when
 * first needed.
 */
export type ReevaluatedFiles =
  readonly string[] | (() => readonly string[] | PromiseLike<readonly string[]>);

/**
 * Everything {@link resolveStack} and {@link resolveStackFrame} need.
 *
 * Passed per call; this module holds no configuration of its own, so one
 * session's project root, origin pin or cache can never leak into another's
 * resolution. Only {@link projectRoot} is required by the type — and
 * {@link devServerOrigin} is required in behaviour, for the reason given in
 * this module's overview.
 */
export interface ResolveStackOptions {
  /**
   * The absolute path of the indexed project root.
   *
   * Three things resolve against it: `normalizeSourcePath`, which turns a
   * bundler's `sources` entry into a project-relative path and rejects anything
   * that escapes the root or lives in a dependency;
   * {@link resolveWithinProject}, the only route in this file from a
   * project-relative path back to an absolute one; and its own realpath, which
   * every path this module opens must lie inside (see "Why the project read is
   * canonicalised" in the module overview). A root that is not absolute makes
   * containment meaningless, and one with no realpath makes it unprovable —
   * every source is then rejected rather than resolved against a guess.
   */
  readonly projectRoot: string;

  /**
   * The session's dev-server origin, forwarded verbatim to `fetchSourceMap` as
   * its mandatory pin — the one origin a chunk and its map may be read from.
   *
   * Pass the session record's `devServerUrl`. Omitting it is not a relaxation
   * of the policy but a refusal: no frame is resolved, and the call returns
   * nothing. See "The dev-server origin pin" in this module's overview.
   */
  readonly devServerOrigin?: string | undefined;

  /**
   * A cross-call document cache from `createSourceMapCache`.
   *
   * Optional and unshared by default. Within one call, each distinct chunk's
   * map is fetched and parsed at most once regardless of this option; a cache
   * extends that to the next call, which is what makes the second click in a
   * session cheap. Scope it to a session and drop it at `session.end`.
   */
  readonly cache?: SourceMapCache | undefined;

  /**
   * The `fetch` implementation `fetchSourceMap` should use. Defaults to the
   * global `fetch`.
   */
  readonly fetchImpl?: typeof fetch | undefined;

  /**
   * The map lookup itself. Defaults to `fetchSourceMap`.
   *
   * One of the two injection seams this module exposes for tests: a stub here
   * can count calls, which is how "one fetch per distinct chunk" is asserted,
   * and can serve a committed fixture document with no listener at all. A
   * service may also use it to answer from a document it already holds. The
   * origin pin is forwarded to whatever is injected, since the injected lookup
   * takes the same required option.
   */
  readonly fetchSourceMapImpl?: typeof fetchSourceMap | undefined;

  /**
   * How an original source is read from the project when the map does not carry
   * it. Defaults to {@link readProjectFile} — `readFileNoFollow` decoded as
   * UTF-8, with `ENOENT`, `ELOOP`, `EACCES` and `EISDIR` all meaning "no
   * content".
   *
   * The second injection seam: it makes the two content branches testable
   * without a fixture tree on disk, and lets a caller that already has the file
   * in memory avoid a read. It is called **only** with an absolute path that
   * *canonical* containment has vouched for — `fs.realpathSync` of a path
   * {@link resolveWithinProject} accepted, proven with {@link isWithin} to lie
   * inside `fs.realpathSync` of {@link projectRoot} — and never with a path
   * that only passed the string-level check. A path whose canonical form
   * escapes the project is refused *before* this function is called, so
   * injecting a reader cannot widen what the module will open. It may throw
   * freely: a throw is caught and treated as "no content".
   */
  readonly readSourceFile?: ((absPath: string) => string | undefined) | undefined;

  /** Frames to resolve at most. Defaults to {@link DEFAULT_MAX_FRAMES}. */
  readonly maxFrames?: number | undefined;

  /**
   * Distinct chunk maps to look up at most, per call. Defaults to
   * {@link DEFAULT_MAX_MAPS}.
   */
  readonly maxMaps?: number | undefined;

  /**
   * The project-relative POSIX paths of files the caller knows a dev server
   * re-evaluated in a hot update while the stack was captured — for this
   * product, the files an instrumentation patch in force at the time wrote.
   *
   * Consulted for a **module-relative** frame only (see "Frames of a
   * hot-updated module" in the module overview), and only to choose between
   * two or more module sections of its chunk that each map the frame exactly:
   * the frame ran in the module that was re-evaluated. It is never a reason to
   * accept a location on its own, and a frame no candidate section maps is
   * skipped whatever it lists. At most {@link MAX_REEVALUATED_FILES} entries
   * are read; entries that are not strings are ignored.
   *
   * Either the list itself or a function producing it. A function is called at
   * most once per call, and only when a frame actually needs the tie-breaker,
   * so a caller whose list costs a read — a modification journal — pays for it
   * only then. A function that throws or rejects reads as no list.
   */
  readonly reevaluatedFiles?: ReevaluatedFiles | undefined;

  /**
   * A caller's cancellation signal — a session ending, a panel interaction
   * superseded.
   *
   * Forwarded to the lookup and checked between frames, so an aborted call
   * returns the locations it had already resolved instead of discarding them or
   * raising.
   */
  readonly signal?: AbortSignal | undefined;

  /**
   * Where skipped frames are explained, at `debug` level only. Defaults to
   * `noopLogger`.
   *
   * Nothing here logs above `debug`: an unresolvable frame is normal operation,
   * and a higher level would fill a session's log with entries describing the
   * design working as intended.
   */
  readonly logger?: Logger | undefined;
}

// ---------------------------------------------------------------------------
// Internal bounds
// ---------------------------------------------------------------------------

/**
 * How much of a stack string {@link parseStackFrames} reads.
 *
 * A stack arrives as a captured string from the inspected page, so its length
 * is whatever that page chose. Scanning is linear, but linear over an
 * attacker-supplied megabyte is still work this product does not need to do:
 * the frames that matter are at the top, and V8 itself caps
 * `Error.stackTraceLimit` at 10 by default.
 */
const MAX_STACK_TEXT_LENGTH = 64 * 1024;

/** How many lines of a stack string are examined, for the same reason. */
const MAX_STACK_LINES = 256;

/**
 * How deeply a sectioned map may nest before this module declines to flatten
 * it.
 *
 * A section's `map` may itself be sectioned, so the shape is recursive and a
 * hostile document could nest it until the stack overflows. Real index maps
 * from Turbopack are one level deep; sixteen is generous and finite.
 */
const MAX_SECTION_DEPTH = 16;

/**
 * The longest `symbol` this module will report.
 *
 * A name longer than this is either minified machine output or not a name at
 * all, and a source chip that renders it would push everything else off the
 * panel. Names from the map's `names` array are truncated to it; a derived
 * identifier longer than it is dropped rather than cut, because half an
 * identifier is a wrong answer rather than a short one.
 */
const MAX_SYMBOL_LENGTH = 128;

/**
 * How many {@link ResolveStackOptions.reevaluatedFiles} entries are read.
 *
 * The list is a tie-breaker between a handful of module sections, so a session
 * that patched more files than this has no use for the rest, and a caller's
 * list — which may come from a journal of any length — cannot make one frame's
 * resolution walk it without bound.
 */
const MAX_REEVALUATED_FILES = 256;

/**
 * The one query key Turbopack's dev runtime puts on the `//# sourceURL` of a
 * module it re-evaluates in a hot update: `<chunk>.js?id=<module id>`.
 *
 * The runtime applies an update by `eval`-ing each changed module's factory
 * with that `sourceURL` and an inline map of its own, so V8 reports frames of
 * the re-evaluated code against the chunk's URL plus this query, at positions
 * **relative to the evaluated module** rather than to the chunk. The value is
 * the module id (and is redacted to `?` before a stack reaches this module in
 * this product), so only the key is recognised. See "Frames of a hot-updated
 * module" in the module overview.
 */
const TURBOPACK_MODULE_QUERY_KEY = 'id';

/**
 * How many lines of an evaluated Turbopack module precede the first line its
 * section of the chunk's map describes.
 *
 * Turbopack writes every ECMAScript module entry of a chunk as three lines of
 * runtime prelude — the module id and factory head
 * (`"<id>", ((__turbopack_context__) => {`), `"use strict";` and a blank line
 * — followed by the module's code, and a chunk's index map starts that
 * module's section exactly there, at the header's line plus three. A hot
 * update evaluates the same entry text, so module-relative line `L` is line
 * `L - 3` of the section's own map. Checked against the chunks of a Next.js
 * 16 (Turbopack) dev server: every ECMAScript project module's section starts
 * three lines below its header, and the probed hot-update frames map to a
 * segment start at exactly this offset and at no neighbouring one.
 */
const TURBOPACK_MODULE_PRELUDE_LINES = 3;

/** Line terminators a source file may use, in any combination. */
const LINE_BREAK = /\r\n|\n|\r/;

/**
 * A V8 frame line: leading whitespace, `at`, then the frame body.
 *
 * Deliberately without the `g` flag — a module-level regex with `g` carries
 * `lastIndex` between calls, which is how a shared pattern starts skipping
 * matches under concurrent use.
 */
const FRAME_LINE = /^\s*at\s+(.+)$/;

/**
 * A `url:line:column` location inside a frame body, restricted to `http:` and
 * `https:`.
 *
 * The scheme restriction is the frame filter: `webpack-internal:///./src/x.ts`,
 * `node:internal/deps/undici`, `chrome-extension://…` and `file:///…` never
 * match, so they are dropped before anything tries to fetch them. The URL's own
 * characters exclude whitespace and parentheses so a match cannot run past the
 * end of its frame, and the lookahead requires the two numbers to be the
 * location's *last* two components — without it the lazy URL would stop at the
 * port and read `:3000` as the line.
 *
 * Constructed per call in {@link locationOf} (it needs the `g` flag) from this
 * source string, for the `lastIndex` reason given on {@link FRAME_LINE}.
 */
const LOCATION_PATTERN_SOURCE = String.raw`(https?:\/\/[^\s()]*?):(\d+):(\d+)(?=[)\s,]|$)`;

/** The identifier at the start of a string, ASCII-conservative. */
const LEADING_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*/;

/** Leading spaces and tabs, for looking just past a mapped column. */
const LEADING_BLANKS = /^[ \t]+/;

/** A trailing `[as alias]` in a V8 function slot, with the name before it. */
const AS_ALIAS = /^(.*?)\s*\[as\s+[^\]]*\]$/;

/** Decoration V8 prefixes a function slot with. */
const FRAME_DECORATIONS: readonly string[] = Object.freeze(['async ', 'await ', 'new ']);

/** What V8 prints for a frame with no function name. */
const ANONYMOUS_SLOT = '<anonymous>';

/** The separator V8 puts between an `eval` wrapper and the enclosing slot. */
const EVAL_SLOT_SEPARATOR = ' at ';

/**
 * Words that are never a symbol, however identifier-shaped they look.
 *
 * Symbol derivation reads the text at the mapped column, and a segment that
 * carries no `names` index very often lands on the start of a statement rather
 * than on a declaration: `const`, `return`, `await`. Reporting `symbol:
 * 'const'` on a source chip is worse than reporting nothing — it looks like a
 * resolved name and is not one. JavaScript's reserved words are listed
 * alongside the contextual and TypeScript ones, because the originals this
 * module reads are TypeScript.
 */
const RESERVED_WORDS: ReadonlySet<string> = Object.freeze(
  new Set([
    'abstract',
    'as',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'declare',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'get',
    'if',
    'implements',
    'import',
    'in',
    'infer',
    'instanceof',
    'interface',
    'is',
    'keyof',
    'let',
    'namespace',
    'new',
    'null',
    'of',
    'package',
    'private',
    'protected',
    'public',
    'readonly',
    'return',
    'satisfies',
    'set',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'type',
    'typeof',
    'undefined',
    'var',
    'void',
    'while',
    'with',
    'yield',
  ]),
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * {@link ResolveStackOptions} with every default applied and every field
 * narrowed, so the resolution path below never reads a raw option.
 */
interface ResolverSettings {
  readonly projectRoot: string;
  readonly devServerOrigin: string | undefined;
  readonly cache: SourceMapCache | undefined;
  readonly fetchImpl: typeof fetch | undefined;
  readonly lookupSourceMap: typeof fetchSourceMap;
  readonly readSourceFile: (absPath: string) => string | undefined;
  readonly maxFrames: number;
  readonly maxMaps: number;

  /**
   * {@link ResolveStackOptions.reevaluatedFiles}, read at most once per call —
   * on first use — and memoised; never rejects.
   */
  readonly reevaluatedFiles: () => Promise<ReadonlySet<string>>;
  readonly signal: AbortSignal | undefined;
  readonly logger: Logger;
}

/**
 * A decoded map, with the one thing the tracer cannot report.
 *
 * `TraceMap.resolvedSources` is `sources` with `./` collapsed, and for a
 * *sectioned* document `FlattenMap` concatenates each section's already-resolved
 * sources — so the spelling the producer authored is unavailable from the
 * tracer alone. It is kept here, aligned index-for-index with
 * `tracer.sources`, because one real bundler form depends on it; see
 * {@link projectFileFor}.
 */
interface LoadedMap {
  readonly tracer: TraceMap;

  /**
   * The `sources` entries as the producer wrote them, in the tracer's own
   * source order. A `null` entry is one the producer withheld.
   */
  readonly authoredSources: readonly (string | null)[];

  /**
   * The document the tracer was built from, kept for the one reading the
   * flattened tracer cannot give: a sectioned document's sections one by one
   * ({@link moduleSectionsFor}). Treated as read-only, like every document.
   */
  readonly document: SourceMapDocument;
}

/**
 * One top-level section of a chunk's index map, loaded on its own: the unit a
 * module-relative frame is mapped in (see "Frames of a hot-updated module" in
 * the module overview).
 */
interface ModuleSection {
  /** The section's own map, in the section's own (unshifted) coordinates. */
  readonly loaded: LoadedMap;

  /** The section's `names`, for matching a frame's function name against it. */
  readonly names: ReadonlySet<string>;
}

/**
 * Per-call memoisation and the map budget.
 *
 * `maps` is keyed by chunk URL and its **presence** means "a lookup was already
 * attempted in this call", so a chunk with no map is not requested twice
 * either; that is what makes "one fetch per distinct chunk" hold even for a
 * stack whose frames alternate between two chunks. `contentLines` is keyed by
 * chunk URL and source spelling together, because two chunks may name the same
 * source and need not agree about its text.
 */
interface ResolutionBudget {
  readonly maps: Map<string, LoadedMap | undefined>;
  readonly contentLines: Map<string, readonly string[] | undefined>;

  /**
   * The project module sections of each chunk a module-relative frame pointed
   * into, keyed by chunk URL: built once per chunk per call, because a stack's
   * frames of one hot-updated module all land in the same chunk.
   */
  readonly moduleSections: Map<string, readonly ModuleSection[]>;
  remaining: number;

  /**
   * The canonicalised project root, computed at most once per call by
   * {@link canonicalProjectRoot} and `undefined` until it has been.
   *
   * A memo of the *attempt*, not of a path: `{ path: undefined }` records that
   * the root has no realpath — it does not exist, a component is not a
   * directory, or this process may not traverse it — which refuses every
   * project read for the rest of the call rather than being retried once per
   * source. One `realpathSync` per call is the reason it is memoised here:
   * click-to-source is an interactive hop, and a stack whose frames land in a
   * dozen sources would otherwise pay for the same syscall a dozen times.
   */
  canonicalRoot: CanonicalPath | undefined;
}

/**
 * The outcome of one canonicalisation: the resolved path, or `undefined` when
 * the path has no canonical form.
 *
 * A wrapper rather than a bare `string | undefined` so that "not attempted yet"
 * and "attempted, and there is no realpath" stay distinguishable in a memo —
 * the second must not be retried, because a root that cannot be canonicalised
 * is a refusal for the whole call.
 */
interface CanonicalPath {
  readonly path: string | undefined;
}

/**
 * Reads an options bag defensively and applies every default.
 *
 * Read through `unknown` for the same reason `fetchSourceMap` does: this
 * package is reachable from untyped JavaScript and from a service boundary, and
 * a caller who forgot an argument must get the same empty result a caller with
 * no origin pin gets — not a `TypeError` thrown past a caller who was promised
 * an array.
 *
 * A `maxFrames` or `maxMaps` that is not a positive safe integer falls back to
 * its default rather than being clamped: a caller who asked for `0`, `-1` or
 * `NaN` frames has a bug, and silently resolving nothing would hide it.
 */
function normalizeOptions(options: ResolveStackOptions): ResolverSettings {
  const bag: unknown = options;
  // `Partial<ResolveStackOptions>` has no required member, so a narrowed
  // `object` assigns into it without an assertion: every field is then read
  // with its own `typeof` check below.
  const given: Partial<ResolveStackOptions> = typeof bag === 'object' && bag !== null ? bag : {};

  const origin = typeof given.devServerOrigin === 'string' ? given.devServerOrigin.trim() : '';
  const logger = given.logger ?? noopLogger;

  return {
    projectRoot: typeof given.projectRoot === 'string' ? given.projectRoot : '',
    devServerOrigin: origin.length > 0 ? origin : undefined,
    cache: given.cache,
    fetchImpl: given.fetchImpl,
    lookupSourceMap: given.fetchSourceMapImpl ?? fetchSourceMap,
    readSourceFile: given.readSourceFile ?? readProjectFile,
    maxFrames: positiveIntegerOr(given.maxFrames, DEFAULT_MAX_FRAMES),
    maxMaps: positiveIntegerOr(given.maxMaps, DEFAULT_MAX_MAPS),
    reevaluatedFiles: reevaluatedFilesReader(given.reevaluatedFiles, logger),
    signal: given.signal,
    logger,
  };
}

/**
 * {@link normalizeOptions}, contained.
 *
 * The options bag is foreign data, and reading a property of a foreign object
 * can run a getter that throws. The public entry points promise never to throw,
 * so even option reading is guarded — and it is guarded *here*, before a logger
 * exists, which is why this failure is the one thing in the module that is not
 * logged: the logger that would report it is the value that could not be read.
 */
function settingsFor(options: ResolveStackOptions): ResolverSettings | undefined {
  try {
    return normalizeOptions(options);
  } catch {
    return undefined;
  }
}

/**
 * Logs at `debug`, tolerating a logger that throws.
 *
 * Used only by the two top-level catch handlers, which must not be able to fail
 * themselves: everything else logs directly, because a throw from there is
 * caught by those same handlers.
 */
function logSafely(logger: Logger, message: string, fields?: LogFields): void {
  try {
    logger.debug(message, fields);
  } catch {
    // A caller's logger is not allowed to break click-to-source.
  }
}

/** A fresh budget for one call. */
function newBudget(settings: ResolverSettings): ResolutionBudget {
  return {
    maps: new Map(),
    contentLines: new Map(),
    moduleSections: new Map(),
    remaining: settings.maxMaps,
    canonicalRoot: undefined,
  };
}

/** `value` when it is a positive safe integer, otherwise `fallback`. */
function positiveIntegerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * {@link ResolveStackOptions.reevaluatedFiles}, read defensively: the string
 * entries of an array, trimmed, non-empty, at most
 * {@link MAX_REEVALUATED_FILES} of them. Anything else reads as none.
 */
function reevaluatedFilesOf(value: unknown): ReadonlySet<string> {
  const files = new Set<string>();
  if (!Array.isArray(value)) {
    return files;
  }

  for (const entry of (value as readonly unknown[]).slice(0, MAX_REEVALUATED_FILES)) {
    if (typeof entry === 'string') {
      const file = entry.trim();
      if (file.length > 0) {
        files.add(file);
      }
    }
  }

  return files;
}

/**
 * {@link ResolveStackOptions.reevaluatedFiles} as a read made at most once,
 * on first use: a list is read as it is; a function is called then, its answer
 * awaited, and a throw or a rejection read as no list, noted at `debug`. The
 * memo is this call's, since settings are built per call.
 */
function reevaluatedFilesReader(
  value: unknown,
  logger: Logger,
): () => Promise<ReadonlySet<string>> {
  let read: Promise<ReadonlySet<string>> | undefined;

  const readOnce = async (): Promise<ReadonlySet<string>> => {
    if (typeof value !== 'function') {
      return reevaluatedFilesOf(value);
    }
    try {
      const produced: unknown = await (value as () => unknown)();
      return reevaluatedFilesOf(produced);
    } catch (error) {
      logger.debug('The re-evaluated files could not be read; no tie-breaker is applied', {
        reason: describeError(error),
      });
      return new Set<string>();
    }
  };

  return () => {
    read ??= readOnce();
    return read;
  };
}

/**
 * Renders a caught value for a log record: a message for an `Error`, the
 * runtime type otherwise.
 *
 * Never the value itself. What is caught here can be anything a dependency or a
 * caller-injected function threw, including an object built from page data, and
 * a log record is one of the places that must not become a channel for it
 * (AAP 0.5.2).
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : `[${typeof error}]`;
}

/**
 * Reads an original source from the project: the default
 * {@link ResolveStackOptions.readSourceFile}.
 *
 * `readFileNoFollow` refuses a symbolic link at the final component. That is
 * the **backstop**, not the answer, to a path derived from a map served by a
 * dev server: `O_NOFOLLOW` cannot see an interior component that is a link out
 * of the project, and neither can the string-level check
 * {@link resolveWithinProject} performs. What answers the interior-link problem
 * is the canonical containment {@link originalContentFor} applies before this
 * function is reached — so the path handed here is already a realpath proven to
 * lie inside the project's realpath, and the no-follow open adds the one thing
 * a check cannot: it refuses a link planted at the final component *between*
 * that check and this open.
 *
 * Every filesystem error means the same thing to this module — no content, so
 * no validation and no derived symbol — and none of them is a failure of the
 * resolution: `ENOENT` for a file that moved since the map was built, `ELOOP`
 * for a link planted at the final component after canonicalisation, `EACCES`
 * for a file this process may not read, `EISDIR` for a source path that names a
 * directory.
 *
 * @param absPath An absolute, canonical path that {@link resolveWithinProject}
 * accepted and {@link isWithin} proved to be inside the canonicalised project
 * root.
 * @returns The file's text with a byte-order mark removed, or `undefined`.
 */
function readProjectFile(absPath: string): string | undefined {
  try {
    return stripByteOrderMark(readFileNoFollow(absPath).toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Removes a leading byte-order mark.
 *
 * A BOM is not part of the first line's text as far as a source map is
 * concerned, so leaving it in would shift every column on line 1 by one and
 * make a valid position look out of range.
 */
function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

/**
 * Parses a V8 stack string into the frames this module can resolve.
 *
 * Exported so that frame parsing can be table-driven in tests with no I/O at
 * all: it is pure, total and synchronous, and every rejection is silent by
 * design — a stack is mostly frames this route has nothing to say about.
 *
 * What is recognised, all of it Chrome/V8 output:
 *
 * - `    at fnName (http://host/chunk.js:12:34)` — the common form.
 * - `    at http://host/chunk.js:12:34` — the bare form, with no function slot.
 * - the decorated slots `async fnName`, `new ClassName`,
 *   `Object.fnName [as alias]` and `<anonymous>`, all of which yield a cleaned
 *   {@link StackFrame.fn} or none.
 * - `eval` nesting — `at eval (eval at fnName (http://host/chunk.js:12:34),
 *   <anonymous>:1:1)` — from which the **innermost parenthesised**
 *   `(url:line:column)` is taken, since that is the position a map can describe;
 *   the `<anonymous>` position inside the `eval` cannot be mapped at all.
 *
 * What is dropped: the header line (`Error`, `Error: message`, or anything
 * before the first `at ` line and anything after that is not a frame), every
 * frame whose URL is not an absolute `http:`/`https:` URL (`native`,
 * `<anonymous>`, `webpack-internal:///`, `chrome-extension://`,
 * `node:internal/…`, `file:///…`), and every frame whose line or column is
 * absent, not an integer, or below 1.
 *
 * @param stack A stack string, typically `Error().stack` captured in the page.
 * @returns The recognised frames in stack order — innermost first, as V8 prints
 * them. Never throws, for any input, including a value that is not a string.
 */
export function parseStackFrames(stack: string): StackFrame[] {
  const text: unknown = stack;
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }

  const bounded = text.length > MAX_STACK_TEXT_LENGTH ? text.slice(0, MAX_STACK_TEXT_LENGTH) : text;
  const frames: StackFrame[] = [];

  // `split` with a limit stops after that many pieces, so a stack with more
  // lines than the bound costs nothing extra.
  for (const line of bounded.split(LINE_BREAK, MAX_STACK_LINES)) {
    // A line that is not a frame line is skipped rather than ending the scan:
    // that covers the header, a blank line and any decoration a producer added
    // between frames.
    const body = FRAME_LINE.exec(line)?.[1];
    if (body === undefined) {
      continue;
    }

    const located = locationOf(body);
    if (located === undefined) {
      continue;
    }

    const fn = functionNameOf(body.slice(0, located.start));
    frames.push({
      ...(fn === undefined ? {} : { fn }),
      url: located.url,
      line: located.line,
      column: located.column,
    });
  }

  return frames;
}

/** A location found inside a frame body, with where in the body it started. */
interface LocatedPosition {
  readonly url: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
}

/**
 * Finds the position a frame body points at.
 *
 * Every `http(s)://…:line:column` candidate in the body is collected, then one
 * is chosen: the **last parenthesised** candidate if there is one, otherwise
 * the last candidate overall. That rule is what implements "innermost" for
 * `eval` nesting — in `eval (eval at fn (http://h/a.js:1:1), http://h/a.js:2:2)`
 * the parenthesised candidate is the inner one — while still accepting the bare
 * `at http://h/a.js:1:1` form, where nothing is parenthesised at all.
 */
function locationOf(body: string): LocatedPosition | undefined {
  const pattern = new RegExp(LOCATION_PATTERN_SOURCE, 'g');
  const candidates: { position: LocatedPosition; parenthesised: boolean }[] = [];

  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    // `noUncheckedIndexedAccess`: every capture group is `string | undefined`,
    // whatever the pattern guarantees.
    const rawUrl = match[1];
    const rawLine = match[2];
    const rawColumn = match[3];
    if (rawUrl === undefined || rawLine === undefined || rawColumn === undefined) {
      continue;
    }

    const url = screenChunkUrl(rawUrl);
    const line = positiveIntegerOf(rawLine);
    const column = positiveIntegerOf(rawColumn);
    if (url === undefined || line === undefined || column === undefined) {
      continue;
    }

    candidates.push({
      position: { url, line, column, start: match.index },
      parenthesised: match.index > 0 && body.charAt(match.index - 1) === '(',
    });
  }

  const parenthesised = candidates.filter((candidate) => candidate.parenthesised);
  return (parenthesised.at(-1) ?? candidates.at(-1))?.position;
}

/**
 * Parses a decimal integer that must be at least 1.
 *
 * Both a line and a V8 column are 1-based, so `0` is not a position a frame can
 * report and is refused rather than repaired. `Number.isSafeInteger` also
 * refuses the 20-digit value a hostile stack could carry, which would otherwise
 * arrive as an imprecise float.
 */
function positiveIntegerOf(text: string): number | undefined {
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Screens a chunk URL and returns its canonical form.
 *
 * `http:`/`https:` only — the one thing a dev server can serve a map for. The
 * canonical `href` is returned rather than the matched text so that two frames
 * spelling the same chunk differently share one map lookup and one budget slot.
 */
function screenChunkUrl(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }

  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
}

/**
 * Cleans the text V8 printed before a frame's location into a function name.
 *
 * The slot can carry an `eval` wrapper (`eval (eval at fnName `), a decoration
 * (`async `, `new `), a receiver (`Object.fnName`) and an alias
 * (`fnName [as handleEvent]`). The enclosing name is the useful part of an
 * `eval` slot, the alias is dropped in favour of the declared name, and
 * anything that still does not look like a single function slot — whitespace or
 * a bracket left in it, `<anonymous>`, nothing at all — yields `undefined`.
 *
 * This value never becomes a `SourceLocation.symbol`; see
 * {@link StackFrame.fn}.
 */
function functionNameOf(prefix: string): string | undefined {
  let text = prefix.trim();

  // Drop the opening parenthesis of the `at fn (url:l:c)` form.
  if (text.endsWith('(')) {
    text = text.slice(0, -1).trimEnd();
  }

  // `eval (eval at fnName` -> `fnName`: the last ` at ` separates the wrapper
  // from the slot the eval was called in.
  const evalSeparator = text.lastIndexOf(EVAL_SLOT_SEPARATOR);
  if (evalSeparator >= 0) {
    text = text.slice(evalSeparator + EVAL_SLOT_SEPARATOR.length).trim();
  }

  // `fnName [as handleEvent]` -> `fnName`. The declared name is what a
  // developer reads in the source; the alias is the property it was reached
  // through.
  const aliased = AS_ALIAS.exec(text)?.[1];
  if (aliased !== undefined) {
    text = aliased.trim();
  }

  for (const decoration of FRAME_DECORATIONS) {
    if (text.startsWith(decoration)) {
      text = text.slice(decoration.length).trim();
    }
  }

  if (text.length === 0 || text.length > MAX_SYMBOL_LENGTH || text === ANONYMOUS_SLOT) {
    return undefined;
  }

  return /[\s()[\]<>]/.test(text) ? undefined : text;
}

/**
 * Re-screens a frame that did not come from {@link parseStackFrames}.
 *
 * {@link resolveStackFrame} and the array form of {@link resolveStack} accept
 * frames a caller built, and those carry no guarantee at all: the numbers may
 * be 0-based by mistake, the URL may be a `webpack-internal:` specifier, the
 * whole value may have arrived as JSON from another process. Every frame
 * therefore passes the same three checks the parser applies before it is used.
 */
function screenFrame(frame: unknown): StackFrame | undefined {
  if (typeof frame !== 'object' || frame === null) {
    return undefined;
  }

  const { fn, url, line, column } = frame as Partial<StackFrame>;
  if (typeof url !== 'string' || typeof line !== 'number' || typeof column !== 'number') {
    return undefined;
  }

  const screenedUrl = screenChunkUrl(url);
  if (
    screenedUrl === undefined ||
    !Number.isSafeInteger(line) ||
    !Number.isSafeInteger(column) ||
    line < 1 ||
    column < 1
  ) {
    return undefined;
  }

  return {
    ...(typeof fn === 'string' && fn.length > 0 ? { fn } : {}),
    url: screenedUrl,
    line,
    column,
  };
}

// ---------------------------------------------------------------------------
// Map loading
// ---------------------------------------------------------------------------

/**
 * The decoded map for one chunk, looked up at most once per call.
 *
 * Presence of the key in {@link ResolutionBudget.maps} — not the value — means
 * "already attempted", so a chunk that has no map, or whose map failed to
 * decode, is not requested again by a later frame pointing into it. The map
 * budget is charged only when a lookup is actually performed, and once it is
 * spent a frame is resolved only if its chunk is already in the memo.
 */
async function loadedMapFor(
  chunkUrl: string,
  settings: ResolverSettings,
  budget: ResolutionBudget,
): Promise<LoadedMap | undefined> {
  if (budget.maps.has(chunkUrl)) {
    return budget.maps.get(chunkUrl);
  }

  const devServerOrigin = settings.devServerOrigin;
  if (devServerOrigin === undefined) {
    // Unreachable through the public entry points, which refuse a call with no
    // pin before any frame is touched. Kept because this function is the only
    // thing that performs a lookup, and a pin is the one option it may not
    // default.
    return undefined;
  }

  if (budget.remaining <= 0) {
    settings.logger.debug('Source-map budget for this call is spent; frame skipped', {
      maxMaps: settings.maxMaps,
    });
    return undefined;
  }
  budget.remaining -= 1;

  const document = await lookupDocument(chunkUrl, devServerOrigin, settings);
  const loaded = document === undefined ? undefined : createLoadedMap(document, settings.logger);
  budget.maps.set(chunkUrl, loaded);
  return loaded;
}

/**
 * Asks the lookup for a chunk's map document and reduces its three outcomes to
 * "a document" or "nothing".
 *
 * The distinction `fetchSourceMap` draws between an error and a clean absence
 * matters to the log and to nothing else: this route has the same answer for
 * both, which is to let the frame fall through to the other three resolution
 * routes.
 */
async function lookupDocument(
  chunkUrl: string,
  devServerOrigin: string,
  settings: ResolverSettings,
): Promise<SourceMapDocument | undefined> {
  const lookup = await settings.lookupSourceMap(chunkUrl, {
    devServerOrigin,
    signal: settings.signal,
    fetchImpl: settings.fetchImpl,
    cache: settings.cache,
    logger: settings.logger,
  });

  if (isErr(lookup)) {
    settings.logger.debug('Source-map lookup failed; frame skipped', {
      code: lookup.error.code,
    });
    return undefined;
  }

  if (lookup.value.kind === 'none') {
    settings.logger.debug('Chunk carries no source map; frame skipped', {
      reason: lookup.value.reason,
    });
    return undefined;
  }

  return lookup.value.map;
}

/**
 * Builds the tracer for a document: `AnyMap` for a sectioned one, `TraceMap`
 * for a plain one.
 *
 * Two decisions are load-bearing, both explained at length in this module's
 * overview and restated here because this is where they are implemented:
 *
 * - The branch is taken on {@link isSectionedSourceMap}, a statement about the
 *   *document*, never by trying `TraceMap` and catching. In
 *   `@jridgewell/trace-mapping` 0.3.31 a sectioned document makes the
 *   `TraceMap` constructor throw a `TypeError` from inside `sources.map(…)`,
 *   which runs before its own `sections` guard — a failure mode no caller
 *   should be relying on. `AnyMap` is the published alias of `FlattenMap` and
 *   flattens the sections' `sources` and `names` in section order while
 *   shifting each section's mappings by its `offset`, so every position below
 *   is in absolute generated coordinates.
 * - **No `mapUrl` second argument.** Passing one would resolve each `sources`
 *   entry against the map's URL and hand `./normalize.ts` an
 *   `http://127.0.0.1:…` URL instead of the `webpack://`/`turbopack://`
 *   spelling it understands — which normalisation then rejects, silently
 *   costing every frame its location.
 *
 * The try/catch is the last resort for a document that satisfies the shape
 * check but still cannot be decoded (a `mappings` string that is not valid VLQ,
 * a `sources` array that is not an array). Such a document yields `undefined`,
 * never a throw.
 */
function createLoadedMap(document: SourceMapDocument, logger: Logger): LoadedMap | undefined {
  try {
    const authoredSources = authoredSourcesFor(document, 0);
    if (authoredSources === undefined) {
      logger.debug('Sectioned source map nests too deeply to flatten; frame skipped', {
        maxDepth: MAX_SECTION_DEPTH,
      });
      return undefined;
    }

    if (isSectionedSourceMap(document)) {
      const sectioned = sectionedInputFor(document, 0);
      if (sectioned === undefined) {
        logger.debug('Sectioned source map nests too deeply to flatten; frame skipped', {
          maxDepth: MAX_SECTION_DEPTH,
        });
        return undefined;
      }
      return { tracer: new AnyMap(sectioned), authoredSources, document };
    }

    return { tracer: new TraceMap(plainInputFor(document)), authoredSources, document };
  } catch (error) {
    logger.debug('Source map could not be decoded; frame skipped', {
      reason: describeError(error),
    });
    return undefined;
  }
}

/**
 * The `sources` entries of a document as its producer wrote them, in the order
 * the tracer will hold them.
 *
 * For a plain document that is simply its own `sources`. For a sectioned one it
 * is every section's `sources` concatenated in section order, recursively —
 * which is exactly the order `FlattenMap` appends them in, so the result lines
 * up index-for-index with the flattened tracer's `sources` and
 * `resolvedSources`. The alignment is what lets {@link projectFileFor} recover
 * the authored spelling of a resolved source.
 *
 * @returns The entries, or `undefined` when the document nests sections beyond
 * {@link MAX_SECTION_DEPTH}.
 */
function authoredSourcesFor(
  document: SourceMapDocument,
  depth: number,
): readonly (string | null)[] | undefined {
  if (!isSectionedSourceMap(document)) {
    return document.sources;
  }

  if (depth >= MAX_SECTION_DEPTH) {
    return undefined;
  }

  const flattened: (string | null)[] = [];
  for (const section of document.sections) {
    const nested = authoredSourcesFor(section.map, depth + 1);
    if (nested === undefined) {
      return undefined;
    }
    flattened.push(...nested);
  }

  return flattened;
}

/**
 * Adapts a plain document to what `TraceMap` accepts.
 *
 * One field differs: the Source Map Revision 3 specification lists `names` as
 * required and real producers omit it, so `RawSourceMapDocument` has it
 * optional while `EncodedSourceMap` demands it. Supplying `[]` is what the
 * document already means — no named segments.
 *
 * The spread is a shallow copy, so the arrays and the `mappings` string are
 * shared with the document, which may be cache-shared and is treated as
 * read-only: `TraceMap` builds its own `resolvedSources` and decodes the
 * mappings into new arrays rather than mutating either.
 */
function plainInputFor(document: RawSourceMapDocument): EncodedSourceMap {
  return { ...document, names: document.names ?? [] };
}

/**
 * Adapts a sectioned document to what `AnyMap` accepts, recursively.
 *
 * A section's `map` may itself be sectioned, so this walks the whole tree
 * filling in `names` where a producer omitted it. Depth is bounded by
 * {@link MAX_SECTION_DEPTH} and a document that exceeds it yields `undefined`
 * rather than a stack overflow.
 */
function sectionedInputFor(
  document: SectionedSourceMapDocument,
  depth: number,
): SectionedSourceMap | undefined {
  if (depth >= MAX_SECTION_DEPTH) {
    return undefined;
  }

  const sections: SectionedSourceMap['sections'] = [];
  for (const section of document.sections) {
    const nested = isSectionedSourceMap(section.map)
      ? sectionedInputFor(section.map, depth + 1)
      : plainInputFor(section.map);
    if (nested === undefined) {
      return undefined;
    }
    sections.push({ offset: section.offset, map: nested });
  }

  return { ...document, sections };
}

// ---------------------------------------------------------------------------
// Position, content and symbol
// ---------------------------------------------------------------------------

/**
 * A position in an original source, in the source map's own coordinates:
 * **1-based line, 0-based column**.
 *
 * Declared rather than inferred so the two fields `originalPositionFor` types
 * as `number | null` arrive here as numbers, and so the coordinate convention
 * is stated on the type that carries it.
 */
interface MappedPosition {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly name: string | null;
}

/**
 * **Conversion 1 of 2.** A V8 frame's 1-based column to the 0-based column
 * `originalPositionFor` takes.
 *
 * Clamped at 0 because the library throws for a negative column, and because a
 * frame reporting column 0 — which V8 does not, but a hand-built frame might —
 * means "the start of the line" rather than "one before it".
 */
function toNeedleColumn(frameColumn: number): number {
  return Math.max(0, frameColumn - 1);
}

/**
 * Looks a generated position up in a tracer.
 *
 * Returns `undefined` for the two distinct "no answer" cases, which this route
 * treats identically: there is no segment at or before this position in the
 * map, or the position is outside the map's generated range. Wrapped in a
 * try/catch because `originalPositionFor` *throws* for a line below 1 or a
 * column below 0 — inputs {@link screenFrame} and {@link toNeedleColumn}
 * already exclude, which is exactly why a throw from here would be a bug worth
 * containing rather than propagating.
 *
 * @param generatedLine The frame's 1-based line, unchanged.
 * @param needleColumn The frame's column after {@link toNeedleColumn}.
 */
function mappedPositionFor(
  tracer: TraceMap,
  generatedLine: number,
  needleColumn: number,
  logger: Logger,
): MappedPosition | undefined {
  try {
    const { source, line, column, name } = originalPositionFor(tracer, {
      line: generatedLine,
      column: needleColumn,
    });

    if (source === null || line === null || column === null) {
      logger.debug('No mapping at this generated position; frame skipped', {
        line: generatedLine,
        column: needleColumn,
      });
      return undefined;
    }

    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 0) {
      logger.debug('Source map reported an out-of-range original position; frame skipped', {
        line,
        column,
      });
      return undefined;
    }

    return { source, line, column, name };
  } catch (error) {
    logger.debug('Source-map position lookup failed; frame skipped', {
      reason: describeError(error),
    });
    return undefined;
  }
}

/**
 * A source that normalised to a path inside the project, with the spelling to
 * query the map's own content by.
 */
interface ProjectSource {
  /** The project-relative POSIX path. */
  readonly file: string;

  /**
   * The spelling to query the map's own `sourcesContent` with — the authored
   * entry whenever the producer supplied one, because `sourceContentFor`
   * indexes by `sources` before it falls back to `resolvedSources`.
   */
  readonly source: string;
}

/** The spellings of one source to try, and the key its content is stored under. */
interface SourceCandidates {
  /** The spellings, in the order they are tried. Deduplicated. */
  readonly spellings: readonly string[];

  /** What {@link ProjectSource.source} becomes when one of them normalises. */
  readonly contentKey: string;
}

/**
 * Turns the source a mapping points at into a project-relative path, trying
 * every spelling of it that may be trusted — see
 * {@link sourceCandidatesFor} for which those are and why.
 *
 * @returns The path and the content key, or `undefined` when no trustworthy
 * spelling is project source (a dependency, a bundler internal, or a path
 * escaping the project root — all already explained by `normalizeSourcePath`
 * at `debug` level).
 */
function projectFileFor(
  loaded: LoadedMap,
  resolvedSource: string,
  settings: ResolverSettings,
): ProjectSource | undefined {
  const { spellings, contentKey } = sourceCandidatesFor(loaded, resolvedSource);

  for (const spelling of spellings) {
    const file = normalizeSourcePath(spelling, {
      projectRoot: settings.projectRoot,
      logger: settings.logger,
    });
    if (file !== undefined) {
      return { file, source: contentKey };
    }
  }

  return undefined;
}

/**
 * The spellings of one source that may be trusted, authored first,
 * deduplicated.
 *
 * {@link LoadedMap.authoredSources} and `TraceMap.resolvedSources` are parallel
 * arrays, so the authored entry is the one at the resolved entry's index. A
 * `null` entry means the producer withheld the name, and an index of `-1`
 * cannot happen for a source a mapping just reported — both leave the resolved
 * spelling as the only thing there is, and it is used.
 *
 * With an authored entry in hand there are two spellings to try, and which of
 * them is admissible is a safety question rather than a preference:
 *
 * 1. **The authored entry, beneath its map's `sourceRoot` where one applies**
 *    (`resolveSourceUnderRoot`; the entry unchanged where none does).
 *    `originalPositionFor` reports `resolvedSources[i]`, which is `sources[i]`
 *    with `./` collapsed — and that collapsing loses information for one real
 *    bundler form. Turbopack marks the project root of a source with a bare
 *    `./` (`turbopack:///./app/(group)/page.tsx`); collapsed to
 *    `turbopack:///app/(group)/page.tsx` the first path segment reads as a
 *    namespace instead, and `./normalize.ts` refuses the source rather than
 *    guessing. The authored entry is also the spelling that module documents
 *    itself against. Where a `sourceRoot` applies, the entry *under* it is what
 *    is tried and the bare entry is not: the root is part of the source's
 *    location, so the entry alone is an incomplete spelling — and an
 *    incomplete spelling of `etc/passwd` beneath a root of `'../../..'` reads
 *    as an ordinary project path. Joining here rather than reading the
 *    library's joined form is what keeps an escaping `'..'` intact, which is
 *    precisely what the resolved spelling does not do.
 * 2. **The resolved spelling, only when the spelling from step 1 carries no
 *    escaping traversal** (`hasEscapingTraversal`, asked of the joined form so
 *    that a traversal in the `sourceRoot` counts as well). It remains worth
 *    trying because it is the form the library actually reports mappings
 *    against.
 *
 * That second gate is the one that has to be here. `resolvedSources` is built by
 * RFC 3986 URI resolution, whose dot-segment removal silently discards a `'..'`
 * that leaves the root of an absolute path. So a map whose `sources` reads
 * `webpack://_N_E/../../../../etc/passwd` — which `normalizeSourcePath`
 * refuses, correctly and at `debug` level — is reported by the tracer as
 * `webpack://_N_E/etc/passwd`, which normalises to `etc/passwd` and is
 * indistinguishable from a real project path. Trying that spelling would put a
 * `SourceLocation` at `source-map` confidence on a file the project does not
 * contain, and would do it from input nobody vouches for: a map's contents are
 * served by the dev server on behalf of every bundle in the graph, including
 * every third-party one. A source that cannot be read as a path at all is
 * refused by the same rule, because resolution of such a source is a
 * path-shaped string assembled from parts `./normalize.ts` rejected.
 *
 * A source with no trustworthy spelling yields no location, which is this
 * module's ordinary skip: three other resolution routes remain (AAP 0.4.2), the
 * cost of the refusal is one frame, and the cost of the opposite mistake is an
 * editor opening a file the developer never wrote.
 */
function sourceCandidatesFor(loaded: LoadedMap, resolvedSource: string): SourceCandidates {
  const index = loaded.tracer.resolvedSources.indexOf(resolvedSource);
  const authored = index === -1 ? undefined : loaded.authoredSources[index];

  if (authored === undefined || authored === null) {
    return { spellings: [resolvedSource], contentKey: resolvedSource };
  }

  const underRoot = resolveSourceUnderRoot(loaded.tracer.sourceRoot, authored);
  const spellings: string[] = [underRoot];

  if (underRoot !== resolvedSource && !hasEscapingTraversal(underRoot)) {
    spellings.push(resolvedSource);
  }

  return { spellings, contentKey: authored };
}

/**
 * The lines of an original source, from whichever of the two branches can
 * supply them, split once per call per source.
 *
 * Keyed by chunk URL *and* authored source: two chunks may name the same source
 * and need not carry the same text for it, and a stack whose frames all land in
 * one file must not re-read and re-split it once per frame — this is a
 * click-to-source hop.
 */
function contentLinesFor(
  tracer: TraceMap,
  chunkUrl: string,
  authoredSource: string,
  relativeFile: string,
  settings: ResolverSettings,
  budget: ResolutionBudget,
): readonly string[] | undefined {
  const key = `${chunkUrl}\u0000${authoredSource}`;
  if (budget.contentLines.has(key)) {
    return budget.contentLines.get(key);
  }

  const content = originalContentFor(tracer, authoredSource, relativeFile, settings, budget);
  const lines = content === undefined ? undefined : content.split(LINE_BREAK);
  budget.contentLines.set(key, lines);
  return lines;
}

/**
 * The text of an original source: the map's own copy first, the file in the
 * project second.
 *
 * **Branch A — the content travelled with the map.** `sourceContentFor` is
 * queried with the *authored* source string, the same one
 * `normalizeSourcePath` was given, because that is the string the map indexes
 * its `sourcesContent` by (the library also accepts the resolved spelling, and
 * the two differ only by `./` collapsing). A `null` entry means "content
 * withheld for this source", which is not "file missing" — so the second branch
 * still runs.
 *
 * **Branch B — read it from the project.** Three gates, layered, and none of
 * them redundant:
 *
 * 1. The project-relative path already passed `isSafeRelativePath` inside
 *    `normalizeSourcePath`; {@link resolveWithinProject} is nevertheless the
 *    only route from it to an absolute path, because layering the two is the
 *    point — the first check says the string cannot escape, the second proves
 *    the join did not. A path the `Result` rejects is never read.
 * 2. **Canonical containment**, which is the gate that answers the interior
 *    symbolic link. Gate 1 is string-level by its own documentation, and the
 *    default reader's `O_NOFOLLOW` refuses a link only at the final component,
 *    so `<root>/src/lib -> /etc` passes both and `<root>/src/lib/passwd` would
 *    be read from outside the project — the composition
 *    `packages/shared/src/node/safe-fs.test.ts` proves unsafe. So the root is
 *    canonicalised once per call ({@link canonicalProjectRoot}), the candidate
 *    is canonicalised with `fs.realpathSync`, and {@link isWithin} is applied
 *    to the two *resolved* paths. A root with no realpath, a candidate with no
 *    realpath, or a canonical candidate outside the canonical root all mean "no
 *    content" — and the refusal happens **before**
 *    {@link ResolveStackOptions.readSourceFile} is called, so no reader,
 *    injected or default, ever sees the escaping path. This matters because
 *    what the content produces leaves the module: a `symbol` derived from it
 *    becomes protocol data.
 * 3. The reader itself, handed the **canonical** path, so the default
 *    no-follow open works on a path whose final component realpath has just
 *    shown is not a link — and `O_NOFOLLOW` covers the one window a check
 *    cannot, a link planted between the two. The identity is then revalidated
 *    after the read for the other half of that window: content whose path no
 *    longer canonicalises to what was vouched for is discarded.
 *
 * One consequence is deliberate and is an improvement rather than a
 * regression: an in-project symbolic link whose canonical target is still
 * inside the project now resolves and is read, where a bare no-follow open of
 * the unresolved path failed with `ELOOP`. That file *is* project source, and
 * canonical containment is what makes reading it provably safe.
 *
 * @returns The source text, or `undefined` when neither branch can supply it —
 * in which case the caller proceeds with the map as the authority.
 */
function originalContentFor(
  tracer: TraceMap,
  authoredSource: string,
  relativeFile: string,
  settings: ResolverSettings,
  budget: ResolutionBudget,
): string | undefined {
  try {
    const embedded = sourceContentFor(tracer, authoredSource);
    if (embedded !== null) {
      return stripByteOrderMark(embedded);
    }
  } catch (error) {
    settings.logger.debug('Embedded source content could not be read', {
      reason: describeError(error),
    });
  }

  // Gate 1: string-level containment.
  const resolved = resolveWithinProject(settings.projectRoot, relativeFile);
  if (isErr(resolved)) {
    settings.logger.debug('Original source path was refused by the containment check', {
      code: resolved.error.code,
      file: relativeFile,
    });
    return undefined;
  }

  // Gate 2: canonical containment, before any read is attempted.
  const canonicalRoot = canonicalProjectRoot(settings, budget);
  if (canonicalRoot === undefined) {
    return undefined;
  }

  const canonical = canonicalPathOf(resolved.value);
  if (canonical === undefined) {
    // No realpath: the file moved since the map was built (`ENOENT`), a
    // component is not a directory (`ENOTDIR`), a link chain is circular
    // (`ELOOP`), or this process may not traverse the chain (`EACCES`).
    settings.logger.debug('Original source path has no canonical form; not read', {
      file: relativeFile,
    });
    return undefined;
  }

  if (!isWithin(canonicalRoot, canonical)) {
    // The lexically contained path resolves outside the project: an interior or
    // final component is a symbolic link pointing out of it. Refused here, with
    // no filesystem fact beyond the project-relative path already logged
    // elsewhere in this module, and with no read attempted at all.
    settings.logger.debug('Original source leaves the project once resolved; refused unread', {
      file: relativeFile,
    });
    return undefined;
  }

  // Gate 3: the read, on the canonical path, revalidated around it.
  let onDisk: string | undefined;
  try {
    onDisk = settings.readSourceFile(canonical);
  } catch (error) {
    // A caller-injected reader may throw anything; the default one never does.
    settings.logger.debug('Original source could not be read from the project', {
      reason: describeError(error),
    });
    return undefined;
  }

  if (typeof onDisk !== 'string') {
    return undefined;
  }

  const afterRead = canonicalPathOf(resolved.value);
  if (afterRead === undefined || afterRead !== canonical || !isWithin(canonicalRoot, afterRead)) {
    // Time-of-check to time-of-use: the path was replaced while it was being
    // read, so what came back cannot be attributed to a file inside the
    // project. Discarded, which leaves the map as the authority.
    settings.logger.debug('Original source path changed during the read; content discarded', {
      file: relativeFile,
    });
    return undefined;
  }

  return stripByteOrderMark(onDisk);
}

/**
 * The canonicalised project root for this call, computed once and memoised on
 * the budget.
 *
 * Fail-closed by construction: a root with no realpath refuses every project
 * read for the rest of the call, because containment cannot be proven against a
 * path that does not resolve, and a guess would be exactly the weakness gate 2
 * exists to remove. The refusal is logged once per call rather than once per
 * source — the memo records the attempt, so a second source does not re-log or
 * re-syscall it.
 *
 * @returns The root's realpath, or `undefined` when it has none.
 */
function canonicalProjectRoot(
  settings: ResolverSettings,
  budget: ResolutionBudget,
): string | undefined {
  const memo = budget.canonicalRoot;
  if (memo !== undefined) {
    return memo.path;
  }

  const path = canonicalPathOf(settings.projectRoot);
  budget.canonicalRoot = { path };

  if (path === undefined) {
    settings.logger.debug(
      'Project root has no canonical form; no original source will be read from the project',
    );
  }

  return path;
}

/**
 * `fs.realpathSync`, contained.
 *
 * Every caller treats a failure as "no content", which is this module's answer
 * to every filesystem question it asks: `realpathSync` throws `ENOENT`,
 * `ELOOP`, `EACCES` and `ENOTDIR`, all of them ordinary on a project that has
 * changed since a map was built, and none of them a reason to raise past a
 * caller promised an array. That is the "Skip, never throw" contract applied to
 * the security gate rather than exempted from it.
 *
 * @param pathAbs An absolute path to resolve.
 * @returns The fully resolved path, or `undefined` when it cannot be resolved.
 */
function canonicalPathOf(pathAbs: string): string | undefined {
  try {
    return realpathSync(pathAbs);
  } catch {
    return undefined;
  }
}

/**
 * Whether a mapped position exists in the content that was recovered for it.
 *
 * The first of the two uses of original content. A map built before an edit
 * still resolves, and it resolves to a position the file no longer has; opening
 * an editor there lands the developer somewhere arbitrary with no indication
 * that anything went wrong, which is worse than not offering the location at
 * all.
 *
 * @param line The position's 1-based line.
 * @param column The position's **0-based** column, as the map reports it. A
 * position one past the last character of a line is legitimate — it is where an
 * insertion would go — so the valid range is `0 … length`, which is the 1-based
 * `1 … length + 1` this becomes.
 */
function positionWithinContent(lines: readonly string[], line: number, column: number): boolean {
  const text = lines[line - 1];
  return text !== undefined && column <= text.length;
}

/**
 * The symbol to report, in the documented precedence order.
 *
 * 1. The map's own `names` entry for the segment, when it has one. A producer
 *    that recorded a name recorded the *original* name, which is the best
 *    answer available.
 * 2. Otherwise the identifier at the resolved column in the original content —
 *    the second of the two uses of that content.
 * 3. Otherwise nothing, and `symbol` is omitted.
 *
 * {@link StackFrame.fn} is deliberately *not* a fallback: it is the name in the
 * generated chunk, so on minified or transformed output it would report
 * something the developer's source does not contain.
 */
function symbolFor(
  name: string | null,
  lines: readonly string[] | undefined,
  line: number,
  column: number,
): string | undefined {
  const mapped = name === null ? '' : name.trim();
  if (mapped.length > 0) {
    return mapped.length > MAX_SYMBOL_LENGTH ? mapped.slice(0, MAX_SYMBOL_LENGTH) : mapped;
  }

  if (lines === undefined) {
    return undefined;
  }

  const text = lines[line - 1];
  return text === undefined ? undefined : identifierAt(text, column);
}

/**
 * The JavaScript identifier at, or immediately after, a 0-based column.
 *
 * Conservative on purpose, in three ways. Only spaces and tabs are skipped, so
 * the identifier has to be on the same line as the mapped position. The pattern
 * is ASCII, so a non-ASCII identifier yields nothing rather than a truncated
 * fragment of one. And a match that is a reserved word yields nothing: a
 * segment with no `names` index very often lands on the start of a statement,
 * and `symbol: 'const'` on a source chip reads as a resolved name while being
 * nothing of the kind.
 *
 * @returns The identifier, or `undefined` when nothing identifier-shaped — or
 * nothing reportable — is there.
 */
function identifierAt(text: string, column: number): string | undefined {
  if (column < 0 || column > text.length) {
    return undefined;
  }

  const tail = text.slice(column).replace(LEADING_BLANKS, '');
  const candidate = LEADING_IDENTIFIER.exec(tail)?.[0];
  if (candidate === undefined || candidate.length > MAX_SYMBOL_LENGTH) {
    return undefined;
  }

  return RESERVED_WORDS.has(candidate) ? undefined : candidate;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves one already-screened frame, end to end.
 *
 * The order is fixed, and every step's failure is a skip:
 *
 * 1. the chunk's map (fetched at most once per chunk per call);
 * 2. the tracer for that document;
 * 3. the mapped original position, after conversion 1 of 2;
 * 4. the project-relative path, which is where a dependency source or one
 *    escaping the project root is refused;
 * 5. the original content, from either branch, and the position check it
 *    enables;
 * 6. the symbol, in its precedence order;
 * 7. conversion 2 of 2 and validation against the shared schema.
 *
 * A frame of a hot-updated Turbopack module is module-relative rather than
 * chunk-relative, and takes {@link resolveModuleRelativeFrame} instead of
 * steps 1–3; steps 4–7 ({@link locationFor}) are the same for both.
 */
async function resolveMappedFrame(
  frame: StackFrame,
  settings: ResolverSettings,
  budget: ResolutionBudget,
): Promise<SourceLocation | undefined> {
  const moduleChunk = moduleRelativeChunkOf(frame.url);
  if (moduleChunk !== undefined) {
    return resolveModuleRelativeFrame(frame, moduleChunk, settings, budget);
  }

  const loaded = await loadedMapFor(frame.url, settings, budget);
  if (loaded === undefined) {
    return undefined;
  }

  // Conversion 1 of 2: a V8 frame's column is 1-based, `originalPositionFor`
  // takes a 0-based one. Its line is 1-based on both sides and is passed
  // through unchanged.
  const position = mappedPositionFor(
    loaded.tracer,
    frame.line,
    toNeedleColumn(frame.column),
    settings.logger,
  );
  if (position === undefined) {
    return undefined;
  }

  return locationFor(loaded, frame.url, position, settings, budget);
}

/**
 * Steps 4–7 of {@link resolveMappedFrame} for a position one map reported: the
 * project-relative path, the content and the position check it enables, the
 * symbol, and conversion 2 of 2 with schema validation. Every failure is a
 * skip, explained at `debug` (or by `normalizeSourcePath`).
 *
 * @param loaded The map that reported `position` — a chunk's, or one section's.
 * @param chunkUrl The chunk the map belongs to; keys the content memo.
 */
function locationFor(
  loaded: LoadedMap,
  chunkUrl: string,
  position: MappedPosition,
  settings: ResolverSettings,
  budget: ResolutionBudget,
): SourceLocation | undefined {
  const projectSource = projectFileFor(loaded, position.source, settings);
  if (projectSource === undefined) {
    // Not project source: a dependency, a bundler internal, or a path that
    // escapes the project root. `normalizeSourcePath` has already explained it.
    return undefined;
  }
  const { file, source } = projectSource;

  const lines = contentLinesFor(loaded.tracer, chunkUrl, source, file, settings, budget);

  if (lines !== undefined && !positionWithinContent(lines, position.line, position.column)) {
    settings.logger.debug(
      'Mapped position falls outside the original source; frame skipped as stale',
      { file, line: position.line },
    );
    return undefined;
  }

  if (lines === undefined) {
    // No content from either branch, so the position cannot be sanity-checked.
    // The map is then the authority — a location it reports is still far better
    // than none — and the fact is recorded rather than hidden.
    settings.logger.debug('Original source content unavailable; trusting the map', { file });
  }

  const symbol = symbolFor(position.name, lines, position.line, position.column);

  // Conversion 2 of 2: the map reports a 0-based column and `SourceLocation` is
  // 1-based on both axes, so one is added. The line needs no adjustment.
  const parsed = parseSourceLocation({
    file,
    line: position.line,
    column: position.column + 1,
    ...(symbol === undefined ? {} : { symbol }),
    resolvedBy: 'source-map',
    confidence: DEFAULT_RESOLUTION_CONFIDENCE['source-map'],
  });

  if (isErr(parsed)) {
    // The shared schema is the last gate before this value reaches the
    // `source.open` message and `showTextDocument`, so a location it refuses is
    // dropped, never repaired: reaching here means this module built something
    // malformed, which is a product bug to fix rather than a frame to salvage.
    settings.logger.debug('Resolved location failed schema validation; frame skipped', {
      code: parsed.error.code,
      reason: parsed.error.message,
    });
    return undefined;
  }

  return parsed.value;
}

// ---------------------------------------------------------------------------
// Frames of a hot-updated module
// ---------------------------------------------------------------------------

/**
 * The chunk a **module-relative** frame belongs to, or `undefined` for an
 * ordinary chunk-relative one.
 *
 * A module-relative frame is one Turbopack's dev runtime produced by
 * re-evaluating a module in a hot update: its URL is a `.js` chunk URL whose
 * query is exactly one {@link TURBOPACK_MODULE_QUERY_KEY} parameter, whatever
 * its value (the module id, or `?` once redacted), and it has no fragment. The
 * chunk is that URL with the query removed — the URL the chunk and its map are
 * served at, and the key its map is loaded under once per call however many
 * frames point into it.
 */
function moduleRelativeChunkOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.hash.length > 0 || !parsed.pathname.endsWith('.js')) {
    return undefined;
  }

  const keys = [...parsed.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== TURBOPACK_MODULE_QUERY_KEY) {
    return undefined;
  }

  parsed.search = '';
  return parsed.href;
}

/**
 * The `names` of a document, in the order a flattened tracer would hold them;
 * empty past {@link MAX_SECTION_DEPTH}, like every walk of a sectioned map.
 */
function namesOf(document: SourceMapDocument, depth: number): readonly string[] {
  if (!isSectionedSourceMap(document)) {
    return document.names ?? [];
  }

  if (depth >= MAX_SECTION_DEPTH) {
    return [];
  }

  return document.sections.flatMap((section) => namesOf(section.map, depth + 1));
}

/**
 * The top-level sections of a chunk's index map that describe project source,
 * each loaded as a map of its own, built at most once per chunk per call.
 *
 * A section is kept only when at least one of its sources normalises into the
 * project ({@link projectFileFor}): a module-relative frame can only be given a
 * location in project source, so a dependency's section is never traced, and
 * its refusals are `normalizeSourcePath`'s own `trace` records. A section whose
 * map cannot be decoded is dropped, like any undecodable map.
 */
function moduleSectionsFor(
  chunkUrl: string,
  loaded: LoadedMap,
  settings: ResolverSettings,
  budget: ResolutionBudget,
): readonly ModuleSection[] {
  const held = budget.moduleSections.get(chunkUrl);
  if (held !== undefined) {
    return held;
  }

  const sections: ModuleSection[] = [];
  if (isSectionedSourceMap(loaded.document)) {
    for (const section of loaded.document.sections) {
      const sectionMap = createLoadedMap(section.map, settings.logger);
      if (sectionMap === undefined) {
        continue;
      }

      const describesProject = sectionMap.tracer.resolvedSources.some(
        (source) => projectFileFor(sectionMap, source, settings) !== undefined,
      );
      if (describesProject) {
        sections.push({ loaded: sectionMap, names: new Set(namesOf(section.map, 0)) });
      }
    }
  }

  budget.moduleSections.set(chunkUrl, sections);
  return sections;
}

/**
 * Whether a mapping segment **starts** at a generated position — the position
 * a V8 frame reports for a call or a property access it is paused at.
 *
 * `originalPositionFor` answers with the nearest segment at or before a
 * position, which for a position in the wrong module is simply some earlier
 * segment of that module. Requiring an exact start is what lets a
 * module-relative position be tried against every candidate section: a real
 * frame lands on a segment start in the module it ran in, and a section it did
 * not run in almost never has one at the same line and column.
 *
 * @param line The 1-based generated line, in the section's own coordinates.
 * @param needleColumn The 0-based column, after {@link toNeedleColumn}.
 */
function startsSegmentAt(tracer: TraceMap, line: number, needleColumn: number): boolean {
  try {
    // `traceSegment` takes a 0-based line, unlike `originalPositionFor`.
    const segment = traceSegment(tracer, line - 1, needleColumn);
    return segment !== null && segment[0] === needleColumn;
  } catch {
    return false;
  }
}

/** A location one module section gave a module-relative frame, and that section's names. */
interface ModuleCandidate {
  readonly location: SourceLocation;
  readonly names: ReadonlySet<string>;
}

/**
 * The one location a module-relative frame may be given, or `undefined`.
 *
 * Candidates that agree on file, line and column are one answer. More than one
 * distinct answer is narrowed, in order, by:
 *
 * 1. {@link ResolveStackOptions.reevaluatedFiles} — the frame ran in a module
 *    the dev server re-evaluated, and a file the caller knows was re-evaluated
 *    is that module;
 * 2. the frame's function name among a section's `names` — the generated name
 *    of a frame is the authored one in a dev build, and a module that does not
 *    name it did not run it.
 *
 * A step that leaves exactly one answer decides; one that leaves none is not
 * applied. Whatever is still ambiguous afterwards is skipped rather than
 * guessed: a wrong chip at `source-map` confidence opens the developer's
 * editor on code that never ran, and three other resolution routes remain.
 */
async function chooseModuleCandidate(
  candidates: readonly ModuleCandidate[],
  frame: StackFrame,
  settings: ResolverSettings,
): Promise<SourceLocation | undefined> {
  const distinct: ModuleCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const { file, line, column } = candidate.location;
    const key = `${file}:${String(line)}:${String(column)}`;
    if (!seen.has(key)) {
      seen.add(key);
      distinct.push(candidate);
    }
  }

  if (distinct.length <= 1) {
    return distinct[0]?.location;
  }

  // Read only now: most frames have one answer, and the list may cost a read.
  const reevaluatedFiles = await settings.reevaluatedFiles();
  let pool: readonly ModuleCandidate[] = distinct;
  const reevaluated = pool.filter((candidate) => reevaluatedFiles.has(candidate.location.file));
  if (reevaluated.length === 1) {
    return reevaluated[0]?.location;
  }
  if (reevaluated.length > 1) {
    pool = reevaluated;
  }

  const fn = frame.fn;
  if (fn !== undefined) {
    const named = pool.filter((candidate) => candidate.names.has(fn));
    if (named.length === 1) {
      return named[0]?.location;
    }
  }

  settings.logger.debug('A hot-updated module frame maps into several project modules; skipped', {
    candidates: distinct.length,
    reevaluatedCandidates: reevaluated.length,
  });
  return undefined;
}

/**
 * Resolves a module-relative frame — one of a module Turbopack re-evaluated in
 * a hot update — against the sections of its chunk's map.
 *
 * The chunk's map is loaded as for any frame, from the chunk URL without the
 * module query, and describes the chunk as the dev server serves it now: the
 * rebuilt chunk, which contains the updated module. The frame's position is
 * relative to the evaluated module, so it is mapped in each project section's
 * *own* coordinates, {@link TURBOPACK_MODULE_PRELUDE_LINES} lines up, and a
 * section answers only where a segment starts exactly there
 * ({@link startsSegmentAt}); the answers then pass every check an ordinary
 * frame's does ({@link locationFor}) and one is chosen
 * ({@link chooseModuleCandidate}).
 *
 * A chunk whose map is not an index map is not a Turbopack chunk — its query is
 * the application's own — so its frame is mapped like any other,
 * chunk-relative.
 */
async function resolveModuleRelativeFrame(
  frame: StackFrame,
  chunkUrl: string,
  settings: ResolverSettings,
  budget: ResolutionBudget,
): Promise<SourceLocation | undefined> {
  const loaded = await loadedMapFor(chunkUrl, settings, budget);
  if (loaded === undefined) {
    return undefined;
  }

  // Conversion 1 of 2, as for every frame: the needle column is 0-based.
  const needleColumn = toNeedleColumn(frame.column);

  if (!isSectionedSourceMap(loaded.document)) {
    const position = mappedPositionFor(loaded.tracer, frame.line, needleColumn, settings.logger);
    return position === undefined
      ? undefined
      : locationFor(loaded, chunkUrl, position, settings, budget);
  }

  const line = frame.line - TURBOPACK_MODULE_PRELUDE_LINES;
  if (line < 1) {
    settings.logger.debug('Hot-updated module frame lies in the module prelude; frame skipped', {
      line: frame.line,
    });
    return undefined;
  }

  const sections = moduleSectionsFor(chunkUrl, loaded, settings, budget);
  const candidates: ModuleCandidate[] = [];
  for (const section of sections) {
    if (!startsSegmentAt(section.loaded.tracer, line, needleColumn)) {
      continue;
    }

    const position = mappedPositionFor(section.loaded.tracer, line, needleColumn, settings.logger);
    const location =
      position === undefined
        ? undefined
        : locationFor(section.loaded, chunkUrl, position, settings, budget);
    if (location !== undefined) {
      candidates.push({ location, names: section.names });
    }
  }

  const chosen = await chooseModuleCandidate(candidates, frame, settings);
  settings.logger.debug('Mapped a hot-updated module frame against its chunk sections', {
    projectSections: sections.length,
    candidates: candidates.length,
    resolved: chosen !== undefined,
  });
  return chosen;
}

/**
 * Resolves a single stack frame to a {@link SourceLocation}.
 *
 * Every frame is re-screened first, whatever its type says: the numbers may
 * have been built 0-based by mistake, the URL may be a `webpack-internal:`
 * specifier, and the whole value may have arrived as JSON from another process.
 *
 * `undefined` is the normal answer for a frame this route cannot map, and it is
 * never an error: the caller falls through to the other three resolution routes
 * (AAP 0.4.2). Nothing thrown inside — by the lookup, by an injected
 * `fetchSourceMapImpl` or `readSourceFile`, by the decoder — escapes.
 *
 * The returned `symbol`, when present, is the *original* name: the map's
 * `names` entry, or the identifier at the resolved column. It is never
 * {@link StackFrame.fn}, which names the generated function.
 *
 * @param frame The frame to resolve. 1-based line and 1-based column.
 * @param options See {@link ResolveStackOptions};
 * {@link ResolveStackOptions.devServerOrigin} is required in behaviour.
 * @returns The validated location, or `undefined`.
 */
export async function resolveStackFrame(
  frame: StackFrame,
  options: ResolveStackOptions,
): Promise<SourceLocation | undefined> {
  const settings = settingsFor(options);
  if (settings === undefined) {
    return undefined;
  }

  try {
    const screened = screenFrame(frame);
    if (screened === undefined) {
      settings.logger.debug('Stack frame is not a resolvable http(s) position; frame skipped');
      return undefined;
    }

    if (settings.devServerOrigin === undefined) {
      settings.logger.debug(
        'No dev-server origin was supplied, so no source map may be read; frame skipped',
      );
      return undefined;
    }

    return await resolveMappedFrame(screened, settings, newBudget(settings));
  } catch (error) {
    logSafely(settings.logger, 'Source-map resolution threw and was contained; frame skipped', {
      reason: describeError(error),
    });
    return undefined;
  }
}

/**
 * Resolves a whole stack to the locations of the frames that could be mapped.
 *
 * Accepts the raw stack string — parsed with {@link parseStackFrames} — or
 * frames a caller already parsed, which are re-screened individually.
 *
 * The result is **in original frame order and is not deduplicated**: the caller
 * wants the chain, and two frames in one function (a callback and its
 * enclosing call, a loop body) are two rungs of it. Frames that could not be
 * resolved are simply absent, so the array is shorter than the stack and its
 * indices do not correspond to frame positions.
 *
 * Three bounds apply, all of them about a click-to-source hop staying instant
 * rather than about correctness:
 *
 * - at most {@link ResolveStackOptions.maxFrames} frames are considered, taken
 *   from the top of the stack;
 * - at most {@link ResolveStackOptions.maxMaps} **distinct** chunk maps are
 *   looked up, after which a frame is resolved only if its chunk's map was
 *   already loaded in this call;
 * - each distinct chunk is looked up exactly once per call, whatever the cache
 *   option, because a per-call memo sits in front of it.
 *
 * Frames are resolved one at a time rather than concurrently: that is what lets
 * {@link ResolveStackOptions.signal} stop the work between frames, keeps the
 * dev server to one in-flight request from this route, and makes the per-chunk
 * memo effective instead of racing several lookups of the same map.
 *
 * Never throws and never rejects. An aborted call returns what it had already
 * resolved.
 *
 * @param stack A stack string or pre-parsed frames.
 * @param options See {@link ResolveStackOptions};
 * {@link ResolveStackOptions.devServerOrigin} is required in behaviour.
 * @returns The resolved locations, in frame order. Empty when nothing resolved.
 */
export async function resolveStack(
  stack: string | readonly StackFrame[],
  options: ResolveStackOptions,
): Promise<SourceLocation[]> {
  const located: SourceLocation[] = [];

  const settings = settingsFor(options);
  if (settings === undefined) {
    return located;
  }

  try {
    const frames = framesOf(stack, settings).slice(0, settings.maxFrames);
    if (frames.length === 0) {
      return located;
    }

    if (settings.devServerOrigin === undefined) {
      settings.logger.debug(
        'No dev-server origin was supplied, so no source map may be read; stack skipped',
        { frames: frames.length },
      );
      return located;
    }

    const budget = newBudget(settings);

    for (const frame of frames) {
      if (settings.signal?.aborted === true) {
        settings.logger.debug('Stack resolution stopped: the caller aborted', {
          resolved: located.length,
        });
        break;
      }

      try {
        const location = await resolveMappedFrame(frame, settings, budget);
        if (location !== undefined) {
          located.push(location);
        }
      } catch (error) {
        // One frame can never abort the rest: this is a chain of independent
        // lookups, and the other frames' locations are still worth returning.
        settings.logger.debug('A stack frame threw during resolution and was skipped', {
          reason: describeError(error),
        });
      }
    }
  } catch (error) {
    // Reached only by something outside the per-frame guard above — parsing the
    // stack, reading the abort signal, a logger that threw. Whatever resolved
    // before it is still returned, because a partial chain is useful and an
    // exception here is not.
    logSafely(settings.logger, 'Stack resolution threw and was contained', {
      reason: describeError(error),
      resolved: located.length,
    });
  }

  return located;
}

/**
 * Normalises the two accepted stack forms into screened frames.
 *
 * Read through `unknown` for the same reason {@link normalizeOptions} is: a
 * value that is neither a string nor an array yields no frames instead of a
 * `TypeError` thrown past a caller who was promised an array.
 */
function framesOf(stack: string | readonly StackFrame[], settings: ResolverSettings): StackFrame[] {
  const given: unknown = stack;

  if (typeof given === 'string') {
    return parseStackFrames(given);
  }

  if (!Array.isArray(given)) {
    settings.logger.debug('Stack was neither a string nor an array of frames; nothing to resolve');
    return [];
  }

  const frames: StackFrame[] = [];
  for (const candidate of given as readonly unknown[]) {
    const screened = screenFrame(candidate);
    if (screened !== undefined) {
      frames.push(screened);
    }
  }

  return frames;
}
