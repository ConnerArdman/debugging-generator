/**
 * Source-URL normalisation: the path half of the product's third
 * source-resolution route.
 *
 * A runtime item a debugging panel offers a click-to-source link for needs a
 * project-relative `SourceLocation`, and four routes produce one (AAP 0.2.3,
 * 0.4.2): patch metadata, the code graph, the **source map of a generated
 * chunk**, and the React owner chain. Within that third route the work is split
 * three ways, and this module owns the last third:
 *
 * - `./fetch-map.ts` finds the map that belongs to a chunk and parses it.
 * - `./resolver.ts` owns `@jridgewell/trace-mapping` and turns a generated
 *   line/column into an original one, naming a `sources` entry of that map.
 * - **this module** turns that `sources` entry — a bundler URL, not a path —
 *   into the project-relative POSIX path the rest of the product stores,
 *   displays and opens in the editor.
 *
 * ## The input is a bundler URL, not a file path
 *
 * A dev server's `sources` entries are URLs in a scheme the bundler invented,
 * with a namespace that is not a directory:
 *
 * | Form | What the leading part is |
 * | --- | --- |
 * | `webpack://<namespace>/./src/lib/http.ts` | an output-name *namespace*, then an explicit `./` |
 * | `turbopack:///[project]/app/api/route.ts` | the `[project]` *root marker* |
 * | `turbopack:///_N_E/src/widgets/Thing.tsx` | the Next.js namespace `_N_E` |
 * | `turbopack:///./app/(group)/page.tsx` | a bare `./` under the root |
 *
 * `_N_E` and `[project]` are **markers, not directories**. Treating either as a
 * path segment yields a path that exists nowhere, and the failure is silent: the
 * editor is asked to open a file that is not there, and click-to-source appears
 * broken with nothing in a log to say why. The same is true of the namespace in
 * the webpack form, which is why the leading segment before an explicit `/./`
 * boundary is dropped as well.
 *
 * ## Two bracket conventions, pulling in opposite directions
 *
 * - **Dynamic route segments.** webpack writes them literally
 *   (`basins/[id]/page.tsx`); Turbopack percent-encodes them
 *   (`gauges/%5Bid%5D/route.ts`). So the normaliser must percent-decode, and
 *   must never mistake `[id]` for a placeholder to strip.
 * - **Route groups.** `(group)` is literal in **both** schemes and is a real
 *   directory on disk, so it must survive untouched. Nothing here re-encodes,
 *   and nothing here strips parentheses.
 *
 * Both schemes therefore converge on the same project-relative path for the same
 * file, which is the point of the route: the panel does not know, and must not
 * care, which bundler produced the chunk a frame pointed into.
 *
 * ## Rejection is silent, and that is the contract
 *
 * {@link normalizeSourcePath} returns `undefined` rather than throwing, for
 * every input. `./resolver.ts` reads `undefined` as "skip this frame and let
 * another resolution route answer" — the degradation contract of AAP 0.4.2 and
 * 0.5.5 — so a rejection is ordinary operation, not a defect: a frame pointing
 * into a dependency, a bundler runtime or a foreign origin is *expected*, and
 * three other routes remain. A throw here would deny the pipeline those
 * fallbacks and turn a routine frame into a failed session, so every rejection
 * below is logged once and never above `debug`. The level says which kind it
 * was: a rejection that is the design working — a dependency or generated tree,
 * a bundler runtime or namespace, or an absolute path outside the root that
 * lies inside a dependency tree (a workspace installs dependencies above the
 * project root) — is logged at `trace`, because every stack a session resolves
 * carries such frames and one record per frame would bury the debug log; every
 * other rejection names a source the module could not place and is logged at
 * `debug`.
 *
 * | Rejection | Why the source cannot become a project path |
 * | --- | --- |
 * | empty or whitespace-only input | nothing to resolve |
 * | bundler-internal source | generated runtime code the developer never wrote |
 * | a scheme that is not `webpack:`, `turbopack:` or `file:` | not interpretable as a file |
 * | an unusable `file:` URL (a non-local authority) | names a file on another host |
 * | a malformed percent escape | the URL cannot be decoded, so the path cannot be trusted |
 * | nothing left after the scheme, namespace and markers | the URL carried no path |
 * | a bracketed namespace segment (`[turbopack]`, `[next]`) | a bundler namespace, not a directory |
 * | an absolute path outside the project root | not this project's file |
 * | the project root itself | a directory, not a source file |
 * | a segment in {@link REJECTED_PATH_SEGMENTS} | a dependency or generated tree |
 * | anything `isSafeRelativePath` refuses | traversal, a rooted form, a control character |
 *
 * ## The security boundary
 *
 * The last row above is the boundary, and it is deliberate that it is *last*:
 * the caller-facing guarantee — that a returned path is relative, POSIX, free of
 * a surviving `..`, free of a Windows root and free of control characters — is
 * established by the final `isSafeRelativePath` gate from `@debuggen/shared`,
 * not by any of the string surgery before it. The earlier steps exist to
 * *recognise* a project path; the gate is what proves one. A future edit may
 * reorder or extend the recognition steps freely, and may not remove that gate.
 *
 * Containment against the project root is likewise delegated: an absolute source
 * (a `file:` URL, or a bundler URL carrying a filesystem path) goes through
 * `toProjectRelative`, whose `Err` is this module's "outside the root"
 * rejection. Nothing here re-implements a containment check, and nothing here
 * touches the filesystem — this module is pure string work, so it is
 * exhaustively testable with no dev server, no network and no sandbox.
 *
 * ## A rejection has to travel with the source, not with one spelling of it
 *
 * A caller rarely holds one spelling of a source. `./resolver.ts` holds two —
 * the entry the producer authored and the entry
 * `@jridgewell/trace-mapping` reports mappings against — and the second is
 * built by URI resolution, which **removes dot segments**: the escaping
 * traversal in `webpack://_N_E/../../../../etc/passwd` is gone from the
 * resolved spelling, which then normalises to `etc/passwd` and reads as an
 * ordinary project path. A rejection this module makes on the authored
 * spelling therefore has to be *askable* about the source itself, or a caller
 * will route around it without meaning to.
 *
 * That is what {@link hasEscapingTraversal} and {@link resolveSourceUnderRoot}
 * are for, and why they live here rather than in the resolver: the vocabulary
 * they need — bundler schemes, namespaces, markers, loader chains, percent
 * escapes, `sourceRoot` concatenation — is this module's, and one reading of a
 * `sources` entry is the whole point. {@link sourcePathOf} is that one reading,
 * shared by all three exports.
 *
 * ## Dependencies, deliberately one
 *
 * `@debuggen/shared` is the only import: it is the base of the acyclic package
 * graph and the only `@debuggen/*` package `packages/code-analysis` may depend
 * on (AAP 0.2.2, enforced by ESLint's `no-restricted-imports` layering block).
 * There is deliberately nothing else — no `@jridgewell/trace-mapping` (that is
 * `./resolver.ts`'s dependency and a decoder has no business in a string
 * normaliser), no `ts-morph` (the click-to-source path must stay free of the AST
 * toolchain, which is also why this module does not import `../project.ts`
 * despite mirroring part of its exclusion vocabulary), no `zod`, no `node:`
 * builtin, and never the `source-map` package, which AAP 0.2.4 rejects
 * repository-wide for its WASM initialisation.
 *
 * ## State
 *
 * None. Every export is a pure function or a frozen constant, and the module
 * reads no environment variable and performs no I/O at load time.
 */
import {
  isAbsolutePosix,
  isErr,
  isSafeRelativePath,
  isWindowsAbsolute,
  noopLogger,
  normalizePosix,
  toPosix,
  toProjectRelative,
} from '@debuggen/shared';
import type { Logger } from '@debuggen/shared';

/**
 * Path segments whose presence disqualifies a source from being project source,
 * at any depth.
 *
 * Matching is by **segment equality**, never by substring: a directory named
 * `node_modules_backup` or `distribution` is ordinary project source and
 * normalises normally.
 *
 * Why each one is not the developer's code:
 *
 * - `node_modules` — an installed dependency. Required by the fixture contract
 *   (`test/fixtures/source-maps/README.md`): a development map legitimately
 *   carries a frame into a dependency's own source, and offering a
 *   click-to-source link into `react/cjs/react.development.js` points the
 *   developer at code they cannot change and away from the one file that
 *   explains their problem.
 * - `.next` — a Next.js build and dev-server cache: generated copies of the very
 *   files that *are* project source.
 * - `dist`, `out` — conventional bundler and compiler output. A frame resolving
 *   into transpiled output rather than its source is a mis-resolution, not a
 *   resolution.
 * - `coverage` — instrumented copies and report assets from a test run.
 *
 * This is the deliberate, narrower parallel of `EXCLUDED_DIRECTORY_NAMES` in
 * `../project.ts`, which the indexer applies when it walks a project tree. The
 * two are intentionally separate constants rather than one shared list: that
 * module builds ts-morph `Project`s, and importing it here would drag the AST
 * toolchain into the click-to-source path for the sake of five strings. The
 * lists differ because the inputs differ — a repository-internal tree such as
 * `.git` or a tooling cache such as `.turbo` never appears in a source map's
 * `sources`, while a caller that needs a project-specific exclusion supplies it
 * through {@link NormalizeSourcePathOptions.extraRejectedSegments}.
 */
export const REJECTED_PATH_SEGMENTS: readonly string[] = Object.freeze([
  'node_modules',
  '.next',
  'dist',
  'out',
  'coverage',
]);

/**
 * The bundler URL schemes this module interprets as a project path, including
 * the `:` so a detected scheme can be compared without re-assembling it.
 *
 * Bundler vocabulary, declared once and used by the algorithm rather than
 * inlined: `webpack:` is emitted by webpack (and by Next.js's webpack mode) and
 * `turbopack:` by Turbopack. Everything else is refused — `http:`, `https:`,
 * `data:`, `blob:`, `chrome-extension:`, `webpack-internal:`, `rsc:` and
 * `node:` among them — because none of those names a file in the project. The
 * one non-bundler scheme handled beyond this list is `file:`, which is not
 * bundler vocabulary and is converted to a path rather than stripped to a
 * project-relative one; see {@link normalizeSourcePath}.
 *
 * Scheme comparison is case-insensitive, as RFC 3986 requires.
 */
export const SOURCE_URL_SCHEMES: readonly string[] = Object.freeze(['webpack:', 'turbopack:']);

/**
 * Leading segments that are bundler *markers* rather than directories, and are
 * therefore removed.
 *
 * - `_N_E` — the namespace Next.js gives its client bundles. `webpack://_N_E/…`
 *   and `turbopack:///_N_E/…` both use it.
 * - `[project]` — Turbopack's marker for the project root itself.
 *
 * Keeping either as a path segment is the single most likely bug in this file:
 * the result looks like a path, resolves against nothing, and breaks
 * click-to-source without an error anywhere. A bracketed leading segment that is
 * *not* `[project]` — `[turbopack]`, `[next]`, `[externals]` — names a bundler
 * namespace rather than the project and is rejected outright instead of stripped
 * (see {@link normalizeSourcePath}), because the path beneath it is generated
 * runtime code with no project file behind it.
 */
export const SOURCE_URL_MARKERS: readonly string[] = Object.freeze(['_N_E', '[project]']);

/** The only path separator this module emits or recognises. */
const SEPARATOR = '/';

/** The authority prefix of a URL, `//`, as it appears after a scheme. */
const AUTHORITY_PREFIX = '//';

/** The single-dot segment with its separator: the explicit "relative to here" prefix. */
const CURRENT_DIRECTORY_PREFIX = './';

/** The single-dot segment, which a normalised path that names its own root reduces to. */
const CURRENT_DIRECTORY = '.';

/**
 * The double-dot segment: the one piece of path vocabulary that can take a path
 * *above* the root it is written against.
 *
 * Named here because two different questions turn on it —
 * {@link normalizeSourcePath}'s final safety gate refuses a path where one
 * survives normalisation, and {@link hasEscapingTraversal} answers whether one
 * escapes at all — and a literal `'..'` spelled at each of those sites is a
 * literal that can drift apart.
 */
const PARENT_DIRECTORY = '..';

/**
 * The one non-bundler scheme {@link normalizeSourcePath} interprets.
 *
 * Nothing in a dev server's own output uses it, but a source map produced by
 * `tsc`, by a library's published build or by a tool that records absolute paths
 * can carry `file:///…` entries, and those name a real file: converted to a
 * path, such an entry resolves through the same containment check as any other
 * absolute source.
 */
const FILE_URL_SCHEME = 'file:';

/**
 * The only authority a `file:` URL may carry, besides an empty one.
 *
 * `file:///home/dev/app/x.ts` (empty authority) and
 * `file://localhost/home/dev/app/x.ts` both name a local file; any other
 * authority names a file on a different host, which no project path can be
 * derived from and which this module refuses rather than silently reading as a
 * local path.
 */
const LOCALHOST_AUTHORITY = 'localhost';

/**
 * The scheme webpack gives its own generated runtime modules.
 *
 * Distinct from `webpack:`: the sources behind it are the loader and HMR
 * machinery webpack injects, never project code — see
 * {@link isWebpackInternalSource}.
 */
const WEBPACK_INTERNAL_SCHEME = 'webpack-internal:';

/**
 * The leading segment webpack uses for its bootstrap and runtime chunks
 * (`webpack/bootstrap`, `webpack/runtime/…`), with or without a scheme and
 * namespace in front of it.
 */
const WEBPACK_RUNTIME_SEGMENT = 'webpack';

/**
 * webpack's legacy parenthesised internal namespaces: `(webpack)/buildin/…`,
 * `(webpack)/hot/dev-server.js`, `(webpack-dev-server)/client/index.js`.
 *
 * Anchored at the start, and deliberately tolerant of the suffix inside the
 * parentheses so a variant namespace is recognised too. It cannot collide with a
 * route group such as `(observatory)`, both because the group never leads a
 * source path and because the pattern requires the literal `webpack` prefix.
 */
const PARENTHESISED_WEBPACK_NAMESPACE = /^\(webpack[^)]*\)/;

/**
 * A URL scheme at the start of a string: a letter, then **at least one** further
 * scheme character, then `:`.
 *
 * The length requirement is what keeps a Windows drive letter from being read as
 * a scheme — `C:/Users/dev/app.ts` has no scheme and is a rooted path — and it
 * costs nothing, because no scheme this module cares about is one character
 * long. {@link schemeOf} additionally checks `isWindowsAbsolute` first, so the
 * two guards are independent.
 */
const SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]+):/;

/**
 * A single leading segment followed by an explicit `/./` boundary, which is how
 * webpack writes "namespace, then a path relative to the project".
 *
 * The lookahead keeps the `./` in place for the strip loop to remove, and the
 * optional leading separator covers the `<scheme>:///namespace/./…` form. It
 * cannot match a bare `/./…` (the segment must have at least one character), so
 * a source that carries no namespace is left alone.
 */
const NAMESPACE_BEFORE_DOT_SEGMENT = /^\/?[^/]+\/(?=\.\/)/;

/** A path segment that is entirely wrapped in square brackets. */
const BRACKETED_SEGMENT = /^\[[^\]]*\]$/;

/** Two or more consecutive separators, collapsed to one. */
const DUPLICATE_SEPARATORS = /\/{2,}/g;

/** A rooted path whose first segment is a Windows drive, as a `file:` URL writes it. */
const ROOTED_WINDOWS_DRIVE = /^\/[A-Za-z]:/;

/**
 * The separator webpack uses between the loaders of a request and the resource
 * they apply to (`…/loader.js!./src/thing.ts`, and the inline-match form
 * `…!=!./src/thing.ts`).
 *
 * The resource is always last, so the substring after the final separator is the
 * file a location refers to.
 */
const LOADER_CHAIN_SEPARATOR = '!';

/** The start of a URL query string, which a bundler appends as a cache or loader tag. */
const QUERY_START = '?';

/** The start of a URL fragment, which carries no path information. */
const FRAGMENT_START = '#';

/** The escape character percent-decoding looks for before it does any work. */
const PERCENT = '%';

/**
 * How many prefixes the strip loop removes before it stops.
 *
 * A real bundler URL carries at most three (a leading separator, a namespace or
 * marker, and a `./`), so this is pure defence against pathological input — a
 * source built of thousands of stacked `./` segments cannot turn a linear walk
 * into a quadratic one. Hitting the cap is not a rejection: whatever remains
 * still goes through `normalizePosix`, which removes `.` segments of its own
 * accord, and then through the final safety gate.
 */
const MAX_PREFIX_STRIP_ROUNDS = 64;

/** The message of the module's one log record, written once per rejected source. */
const REJECTION_MESSAGE = 'Source-map source not resolved to a project path';

/**
 * How much of a rejected source a rejection record repeats back.
 *
 * A `sources` entry is bundler output derived from a page the developer opened,
 * so it is untrusted input that must not be copied unbounded into a log.
 */
const MAX_LOGGED_SOURCE_LENGTH = 200;

/** Highest code unit of the C0 control block (U+0000–U+001F), NUL included. */
const LAST_C0_CONTROL = 0x1f;

/** DELETE (U+007F), the first code unit treated as a C1-range control. */
const FIRST_C1_CONTROL = 0x7f;

/** Highest code unit of the C1 control block (U+009F). */
const LAST_C1_CONTROL = 0x9f;

/** U+FFFD REPLACEMENT CHARACTER, substituted for a control character in a log record. */
const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * Why a source was refused, recorded as the `reason` field of the module's
 * single rejection record so a reader can tell an expected rejection (a
 * dependency frame, a bundler runtime) from a suspicious one (a path outside
 * the project) without parsing a message. {@link EXPECTED_REJECTIONS} decides
 * which of the two levels the record is written at.
 *
 * Module-internal: the public surface is the exports below, and every
 * rejection they produce is the same `undefined`.
 */
type RejectionReason =
  | 'non-string-source'
  | 'empty-source'
  | 'bundler-internal'
  | 'unsupported-scheme'
  | 'unusable-file-url'
  | 'malformed-percent-escape'
  | 'empty-after-prefix'
  | 'bundler-namespace'
  | 'project-root-not-absolute'
  | 'outside-project-root'
  | 'names-project-root'
  | 'excluded-segment'
  | 'unsafe-relative-path';

/**
 * The rejections that describe the design working rather than a source the
 * module could not place, and are therefore logged at `trace`, not `debug`.
 *
 * Every stack a session resolves runs through framework and bundler frames —
 * React's scheduler, the router, the bundler runtime — so these rejections are
 * produced once per such frame of every resolved stack. At `debug` they would
 * bury the records a reader needs; at `trace` they remain available to whoever
 * asks for them. `outside-project-root` joins this set only for a path inside a
 * dependency tree (see {@link isExpectedRejection}): an absolute path outside
 * the root anywhere else is the suspicious case and stays at `debug`.
 */
const EXPECTED_REJECTIONS: ReadonlySet<RejectionReason> = new Set<RejectionReason>([
  'bundler-internal',
  'bundler-namespace',
  'excluded-segment',
]);

/**
 * Whether rejecting `offending` for `reason` is expected — a dependency,
 * generated or bundler source — rather than a source the module could not
 * place.
 *
 * An absolute path outside the project root is expected in two spellings:
 *
 * - one of its segments is a {@link REJECTED_PATH_SEGMENTS} entry. A workspace
 *   installs its dependencies above the project root
 *   (`<workspace>/node_modules/.pnpm/…`), so a framework frame of a workspace
 *   member arrives as exactly such a path;
 * - its leading segment is a bracketed bundler namespace other than a
 *   {@link SOURCE_URL_MARKERS} entry. Turbopack writes its runtime as
 *   `turbopack:///[turbopack]/…`, whose three slashes make the path absolute.
 */
function isExpectedRejection(reason: RejectionReason, offending: string): boolean {
  if (EXPECTED_REJECTIONS.has(reason)) {
    return true;
  }
  if (reason !== 'outside-project-root') {
    return false;
  }
  const segments = toPosix(offending)
    .replace(SCHEME_PATTERN, '')
    .split(SEPARATOR)
    .filter((segment) => segment.length > 0);
  const leading = segments[0];
  if (
    leading !== undefined &&
    BRACKETED_SEGMENT.test(leading) &&
    !SOURCE_URL_MARKERS.includes(leading)
  ) {
    return true;
  }
  return segments.some((segment) => REJECTED_PATH_SEGMENTS.includes(segment));
}

/** The outcome of percent-decoding: the usable string, and whether decoding failed. */
interface PercentDecoding {
  /** The decoded value, or the input unchanged when decoding failed. */
  readonly value: string;
  /** `true` when the input carried an escape `decodeURIComponent` could not read. */
  readonly malformed: boolean;
}

/**
 * Options for {@link normalizeSourcePath}.
 *
 * Everything the function needs is passed per call: the module holds no
 * configuration of its own, so one session's project root can never leak into
 * another's resolution.
 */
export interface NormalizeSourcePathOptions {
  /**
   * The absolute path of the indexed project root, in POSIX or native form.
   *
   * Converted and normalised internally, so `'/home/dev/app'`,
   * `'/home/dev/app/'` and `'C:\\Users\\dev\\app'` are all accepted. A root that
   * is not absolute makes containment meaningless, and every source is then
   * rejected rather than resolved against a guess — the same fail-closed
   * behaviour `toProjectRelative` has for such a root.
   */
  readonly projectRoot: string;

  /**
   * Additional path segments to reject, beyond {@link REJECTED_PATH_SEGMENTS}.
   *
   * For a project with a generated or vendored tree of its own — `.turbo`,
   * `vendor`, `src/generated` — supplied by the caller that knows about it, so
   * the shared list stays the set that is true of every project. Each entry is a
   * bare segment and is compared for equality against each segment of the
   * result; an entry containing a separator matches nothing.
   */
  readonly extraRejectedSegments?: readonly string[];

  /**
   * Where a rejection is explained: at `trace` for an expected one (a
   * dependency, generated or bundler source), at `debug` for any other.
   *
   * Defaults to `noopLogger`. A rejected frame is normal operation (most maps
   * carry at least one dependency source), so this module never logs above
   * `debug`, and it keeps the expected rejections — one per framework frame of
   * every stack a session resolves — out of `debug` entirely: they describe
   * the design working as intended.
   */
  readonly logger?: Logger;
}

/** Whether a UTF-16 code unit is a C0 or C1 control character. */
function isControlCode(code: number): boolean {
  return code <= LAST_C0_CONTROL || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL);
}

/**
 * Renders an untrusted source for a log record: truncated, with every control
 * character replaced.
 *
 * NUL truncates a string at the boundary of many C APIs and ESC begins a
 * terminal escape sequence, which is how a value echoed into a log line rewrites
 * the rest of it. Both classes are neutralised here, and the whole value is
 * bounded by {@link MAX_LOGGED_SOURCE_LENGTH}.
 */
function describeSource(source: string): string {
  const truncated =
    source.length > MAX_LOGGED_SOURCE_LENGTH
      ? `${source.slice(0, MAX_LOGGED_SOURCE_LENGTH)}…`
      : source;

  let safe = '';
  for (let index = 0; index < truncated.length; index += 1) {
    safe += isControlCode(truncated.charCodeAt(index))
      ? REPLACEMENT_CHARACTER
      : truncated.charAt(index);
  }
  return safe;
}

/**
 * The lower-cased scheme of a source, including its `:`, or `undefined` when it
 * carries none.
 *
 * A Windows-rooted path is reported as scheme-less before the pattern is
 * consulted, so `'C:/Users/dev/app.ts'` cannot be read as a scheme `c:` whose
 * "path" is a drive-relative remainder.
 */
function schemeOf(source: string): string | undefined {
  if (isWindowsAbsolute(source)) {
    return undefined;
  }

  const match = SCHEME_PATTERN.exec(source);
  const name = match?.[1];
  if (name === undefined) {
    return undefined;
  }

  return `${name.toLowerCase()}:`;
}

/**
 * Removes a scheme and, when present, the `//` that introduces an authority,
 * leaving everything a bundler URL carries after them.
 *
 * `'webpack://_N_E/./src/x.ts'` becomes `'_N_E/./src/x.ts'` and
 * `'turbopack:///[project]/x.ts'` becomes `'/[project]/x.ts'` — the leading
 * separator of the three-slash form survives here and is dealt with by
 * {@link stripBundlerPrefixes}, which is the only place that can tell a root
 * marker from a filesystem path.
 */
function stripSchemeAndAuthority(source: string, scheme: string): string {
  const withoutScheme = source.slice(scheme.length);
  return withoutScheme.startsWith(AUTHORITY_PREFIX)
    ? withoutScheme.slice(AUTHORITY_PREFIX.length)
    : withoutScheme;
}

/**
 * Converts a `file:` URL to the path it names, or `undefined` when it names no
 * usable local path.
 *
 * Handles the three forms that occur — `file:///path` (empty authority),
 * `file://localhost/path` and the bare `file:/path` — refuses any other
 * authority (a file on another host is not this project's file), and drops the
 * separator that precedes a Windows drive so `'file:///C:/dir/x.ts'` yields
 * `'C:/dir/x.ts'` rather than a rooted path with a drive inside it.
 *
 * Percent-decoding is *not* done here: it happens once, for every route, in
 * {@link normalizeSourcePath}.
 */
function fileUrlToPath(source: string): string | undefined {
  const rest = source.slice(FILE_URL_SCHEME.length);
  if (!rest.startsWith(SEPARATOR)) {
    // 'file:relative/x.ts' is not a resolvable URL: there is no base to resolve
    // the reference against, and guessing one would invent a location.
    return undefined;
  }

  let path = rest;
  if (rest.startsWith(AUTHORITY_PREFIX)) {
    const authorityAndPath = rest.slice(AUTHORITY_PREFIX.length);
    const boundary = authorityAndPath.indexOf(SEPARATOR);
    const authority = boundary === -1 ? authorityAndPath : authorityAndPath.slice(0, boundary);
    if (authority.length > 0 && authority.toLowerCase() !== LOCALHOST_AUTHORITY) {
      return undefined;
    }
    path = boundary === -1 ? '' : authorityAndPath.slice(boundary);
  }

  if (path.length === 0) {
    return undefined;
  }

  return ROOTED_WINDOWS_DRIVE.test(path) ? path.slice(1) : path;
}

/**
 * Percent-decodes a source, reporting rather than throwing when an escape is
 * malformed.
 *
 * The wrapper is what makes {@link normalizeSourcePath} total: `'%'` and
 * `'%zz'` make `decodeURIComponent` throw a `URIError`, and a source map is
 * hand-written often enough that one cannot be ruled out. The `malformed` flag
 * is then a *rejection* rather than a silent fallback, because a URL this module
 * could not decode is one whose path it cannot claim to know — and the resolver
 * has three other routes. The undecoded value is still returned so the log
 * record can name what arrived.
 */
function decodePercentEscapes(value: string): PercentDecoding {
  if (!value.includes(PERCENT)) {
    return { value, malformed: false };
  }

  try {
    return { value: decodeURIComponent(value), malformed: false };
  } catch {
    return { value, malformed: true };
  }
}

/**
 * Returns the resource of a webpack loader request: everything after the final
 * {@link LOADER_CHAIN_SEPARATOR}.
 *
 * `'…/css-loader.js!./src/thing.css'` yields `'./src/thing.css'`, and a source
 * with no loader chain is returned unchanged.
 */
function stripLoaderChain(value: string): string {
  const lastSeparator = value.lastIndexOf(LOADER_CHAIN_SEPARATOR);
  return lastSeparator === -1 ? value : value.slice(lastSeparator + 1);
}

/**
 * Drops a URL query and fragment.
 *
 * Both bundlers tag a source with a query to bust a cache or to carry loader
 * options (`./src/thing.ts?ce5f`), and neither tag is part of the file name, so
 * keeping one produces a path that exists nowhere. A file name containing a
 * literal `?` or `#` is not representable through this route as a consequence;
 * a bundler percent-encodes such a character, so the trade only costs a source
 * whose encoding was already ambiguous.
 */
function stripQueryAndFragment(value: string): string {
  let end = value.length;
  for (const marker of [QUERY_START, FRAGMENT_START]) {
    const index = value.indexOf(marker);
    if (index !== -1 && index < end) {
      end = index;
    }
  }
  return end === value.length ? value : value.slice(0, end);
}

/**
 * Removes one leading {@link SOURCE_URL_MARKERS} entry, or reports that there is
 * none.
 *
 * A value that *is* a marker becomes the empty string, which the caller reads as
 * "this URL carried no path".
 *
 * @returns The remainder, or `undefined` when no marker leads the value.
 */
function stripLeadingMarker(value: string): string | undefined {
  for (const marker of SOURCE_URL_MARKERS) {
    if (value === marker) {
      return '';
    }
    if (value.startsWith(`${marker}${SEPARATOR}`)) {
      return value.slice(marker.length + SEPARATOR.length);
    }
  }
  return undefined;
}

/**
 * Whether what follows a leading separator is namespace-relative content rather
 * than a filesystem path.
 *
 * This is the distinction that keeps the `<scheme>:///[project]/…`,
 * `<scheme>:///_N_E/…` and `<scheme>:///./…` forms apart from
 * `<scheme>:///Users/dev/app/src/x.ts`, which webpack emits when it records
 * absolute paths: the first three are project-relative once their marker is
 * gone, while the fourth is genuinely rooted and must keep its leading separator
 * so the containment check — and not a lucky string strip — decides its fate.
 */
function isNamespaceRelative(value: string): boolean {
  return (
    value.length === 0 ||
    value.startsWith(CURRENT_DIRECTORY_PREFIX) ||
    stripLeadingMarker(value) !== undefined
  );
}

/**
 * Turns the remainder of a bundler URL into the path it means, by removing the
 * namespace and marker vocabulary that is not part of any path.
 *
 * One loop rather than a case per URL shape: duplicate separators collapse
 * first (so `'[project]//src///lib/x.ts'` is reachable by the same rules as the
 * single-separator form), a namespace segment introducing an explicit `/./`
 * boundary is dropped once, and then a leading marker, a leading `./` and a
 * leading separator whose remainder {@link isNamespaceRelative} accepts are
 * removed until none applies.
 *
 * Every committed fixture form reduces through it:
 *
 * | Remainder after the scheme | Result |
 * | --- | --- |
 * | `_N_E/./src/lib/http.ts` | `src/lib/http.ts` |
 * | `/[project]/app/api/route.ts` | `app/api/route.ts` |
 * | `/_N_E/src/widgets/Thing.tsx` | `src/widgets/Thing.tsx` |
 * | `/./app/(group)/page.tsx` | `app/(group)/page.tsx` |
 * | `/Users/dev/app/src/x.ts` | unchanged — a rooted path, not a namespace |
 */
function stripBundlerPrefixes(value: string): string {
  let current = value.replace(DUPLICATE_SEPARATORS, SEPARATOR);

  const namespaceMatch = NAMESPACE_BEFORE_DOT_SEGMENT.exec(current);
  const namespace = namespaceMatch?.[0];
  if (namespace !== undefined) {
    current = current.slice(namespace.length);
  }

  for (let round = 0; round < MAX_PREFIX_STRIP_ROUNDS; round += 1) {
    const withoutMarker = stripLeadingMarker(current);
    if (withoutMarker !== undefined) {
      current = withoutMarker;
      continue;
    }

    if (current.startsWith(CURRENT_DIRECTORY_PREFIX)) {
      current = current.slice(CURRENT_DIRECTORY_PREFIX.length);
      continue;
    }

    if (current.startsWith(SEPARATOR) && isNamespaceRelative(current.slice(SEPARATOR.length))) {
      current = current.slice(SEPARATOR.length);
      continue;
    }

    break;
  }

  return current;
}

/**
 * The first segment of a path, or `undefined` when the path has none.
 *
 * `noUncheckedIndexedAccess` makes the indexed access `string | undefined`, and
 * an empty first segment (from a leading separator) is reported as absent rather
 * than as an empty name.
 */
function firstSegmentOf(path: string): string | undefined {
  const first = path.split(SEPARATOR)[0];
  return first === undefined || first.length === 0 ? undefined : first;
}

/**
 * The path a source URL carries, or the reason it carries none.
 *
 * A discriminated result rather than `string | undefined` because the two
 * callers need different things from a failure: {@link normalizeSourcePath}
 * logs the reason, and {@link hasEscapingTraversal} needs only to know that the
 * source could not be read as a path at all.
 */
type SourcePath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: RejectionReason };

/**
 * Steps 3 to 6 of {@link normalizeSourcePath}: everything that turns a bundler
 * URL into the path it carries, before the path is judged against a project
 * root.
 *
 * Extracted so there is exactly **one** implementation of "what path does this
 * `sources` entry name". {@link normalizeSourcePath} continues from its result
 * with containment and the safety gate; {@link hasEscapingTraversal} asks a
 * different question of the same path. Two copies of this sequence would be two
 * opinions about the same string, which is the class of divergence
 * `./resolver.ts` was found relying on: a spelling refused by one reading of a
 * source and accepted by another.
 *
 * The input must already be trimmed, and must already have been screened for
 * bundler internals by the caller — this function is about *paths*, not about
 * whether a path is the developer's code.
 *
 * @param trimmed A `sources` entry with surrounding whitespace removed.
 * @returns The path it carries, or the rejection reason that stopped it.
 */
function sourcePathOf(trimmed: string): SourcePath {
  const scheme = schemeOf(trimmed);
  const bundlerScheme = scheme !== undefined && SOURCE_URL_SCHEMES.includes(scheme);

  let candidate: string;
  if (scheme === undefined) {
    candidate = trimmed;
  } else if (bundlerScheme) {
    candidate = stripSchemeAndAuthority(trimmed, scheme);
  } else if (scheme === FILE_URL_SCHEME) {
    const filePath = fileUrlToPath(trimmed);
    if (filePath === undefined) {
      return { ok: false, reason: 'unusable-file-url' };
    }
    candidate = filePath;
  } else {
    return { ok: false, reason: 'unsupported-scheme' };
  }

  candidate = stripQueryAndFragment(stripLoaderChain(candidate));

  const decoded = decodePercentEscapes(candidate);
  if (decoded.malformed) {
    return { ok: false, reason: 'malformed-percent-escape' };
  }

  candidate = toPosix(decoded.value);
  if (bundlerScheme) {
    candidate = stripBundlerPrefixes(candidate);
  }

  if (candidate.length === 0) {
    return { ok: false, reason: 'empty-after-prefix' };
  }

  return { ok: true, path: candidate };
}

/**
 * Whether a path steps above the root it is written against.
 *
 * A segment walk with a depth counter rather than a normalisation, because
 * normalisation is exactly what *hides* the answer: `normalizePosix` drops a
 * leading `'..'` from an absolute path (`'/../../etc/passwd'` becomes
 * `'/etc/passwd'`), which is the same silent flattening RFC 3986 dot-segment
 * removal performs on a URL path — and the question here is whether that
 * flattening had anything to hide. A `'..'` met at depth zero is an escape; one
 * met deeper cancels the segment above it and is an ordinary, redundant
 * spelling.
 */
function escapesOwnRoot(path: string): boolean {
  let depth = 0;

  for (const segment of path.split(SEPARATOR)) {
    if (segment.length === 0 || segment === CURRENT_DIRECTORY) {
      continue;
    }

    if (segment === PARENT_DIRECTORY) {
      if (depth === 0) {
        return true;
      }
      depth -= 1;
      continue;
    }

    depth += 1;
  }

  return false;
}

/**
 * Whether a source names bundler-internal code rather than a file the developer
 * wrote.
 *
 * Four shapes occur, and all four are refused:
 *
 * | Shape | Example |
 * | --- | --- |
 * | the internal scheme | `webpack-internal:///./src/x.ts` |
 * | a parenthesised internal namespace | `(webpack)/hot/dev-server.js` |
 * | a bare runtime path | `webpack/bootstrap` |
 * | a runtime path behind a scheme or namespace | `webpack://webpack/bootstrap`, `webpack://_N_E/webpack/bootstrap` |
 *
 * The last row is why this predicate strips the scheme and marker vocabulary
 * before it looks at the leading segment: the namespace in front of
 * `webpack/bootstrap` varies with the build, and a check written against the raw
 * string would recognise one spelling of the same runtime module and miss the
 * other.
 *
 * Exported so a test can table-drive it, and so {@link normalizeSourcePath} has
 * exactly one definition of "internal" to reject on.
 *
 * A project file whose *first* path segment is literally `webpack` — a
 * `webpack/` directory at the project root — is refused as a consequence.
 * That is the right trade: such a file is bundler configuration rather than
 * application code, it is vanishingly rare inside a source map, and the cost of
 * the refusal is one frame resolved by another route, while the cost of the
 * opposite mistake is a click-to-source link that opens generated runtime code.
 * A `webpack` directory anywhere deeper (`config/webpack/rules.ts`) is
 * unaffected: only the leading segment is examined.
 *
 * @param source A `sources` entry from a source map.
 * @returns `true` when the source is bundler-internal.
 */
export function isWebpackInternalSource(source: string): boolean {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (trimmed.toLowerCase().startsWith(WEBPACK_INTERNAL_SCHEME)) {
    return true;
  }

  if (PARENTHESISED_WEBPACK_NAMESPACE.test(trimmed)) {
    return true;
  }

  const scheme = schemeOf(trimmed);
  const remainder =
    scheme !== undefined && SOURCE_URL_SCHEMES.includes(scheme)
      ? stripSchemeAndAuthority(trimmed, scheme)
      : trimmed;

  return firstSegmentOf(stripBundlerPrefixes(toPosix(remainder))) === WEBPACK_RUNTIME_SEGMENT;
}

/**
 * Turns a source map's `sources` entry into a project-relative POSIX path, or
 * reports that it cannot be one.
 *
 * The steps run in this order, and the order is the contract:
 *
 * 1. **Guard** a non-string (this is called with runtime- and model-sourced
 *    data, so the compiler's `string` is not a guarantee) and an empty or
 *    whitespace-only source.
 * 2. **Reject bundler internals** through {@link isWebpackInternalSource}.
 * 3. **Interpret the scheme.** {@link SOURCE_URL_SCHEMES} is stripped to a
 *    remainder; `file:` is converted to the path it names; every other scheme
 *    is refused, because none of them names a file in the project. A source with
 *    no scheme is taken as written.
 * 4. **Discard non-path decoration**: a webpack loader chain, then a query and
 *    fragment.
 * 5. **Percent-decode**, so Turbopack's `%5Bid%5D` becomes `[id]`. Nothing is
 *    ever re-encoded and no parenthesis is touched, so a route group such as
 *    `(group)` — a real directory — survives exactly as it arrived.
 * 6. **Remove bundler namespaces and markers** (bundler schemes only, where the
 *    vocabulary is defined), converting separators first. Steps 3 to 6 are
 *    {@link sourcePathOf}, which is shared with {@link hasEscapingTraversal} so
 *    that both exports read a `sources` entry the same way.
 * 7. **Reduce against the project root.** An absolute or Windows-rooted result
 *    goes through `toProjectRelative`, whose `Err` is the "outside the root"
 *    rejection; a relative result is normalised lexically.
 * 8. **Reject what cannot be a source file**: the project root itself, a
 *    bracketed bundler namespace, and any segment in
 *    {@link REJECTED_PATH_SEGMENTS} or
 *    {@link NormalizeSourcePathOptions.extraRejectedSegments} — by segment
 *    equality, so `node_modules_backup` is ordinary source.
 * 9. **Pass the safety gate.** `isSafeRelativePath` is the security boundary of
 *    this module: it, and not any earlier step, is what guarantees a caller
 *    never receives an absolute path, a Windows drive path, a surviving `..`, a
 *    backslash, a NUL byte or any other control character.
 *
 * This function never throws, for any input — an empty string, a lone scheme, a
 * malformed escape, a `data:` URL, a ten-thousand-character path, a string with
 * a NUL byte in it. `./resolver.ts` reads `undefined` as "skip this frame and
 * let another resolution route handle it" (AAP 0.4.2), so a rejection degrades
 * the route instead of failing the session, and each one is explained once at
 * `debug` level.
 *
 * @param source A `sources` entry from a source map, in any of the bundler forms
 * above.
 * @param options The project root to resolve against, and optional extra
 * rejected segments and logger.
 * @returns The project-relative POSIX path, or `undefined` when the source is
 * not project source.
 *
 * @example
 * ```ts
 * const options = { projectRoot: '/home/dev/app' };
 * normalizeSourcePath('webpack://_N_E/./src/lib/http.ts', options); // 'src/lib/http.ts'
 * normalizeSourcePath('turbopack:///[project]/app/api/%5Bid%5D/route.ts', options);
 * // 'app/api/[id]/route.ts'
 * normalizeSourcePath('webpack://_N_E/./node_modules/react/index.js', options); // undefined
 * ```
 */
export function normalizeSourcePath(
  source: string,
  options: NormalizeSourcePathOptions,
): string | undefined {
  const logger = options.logger ?? noopLogger;

  /**
   * Explains a rejection once — at `trace` when it is expected, at `debug`
   * otherwise — and answers the caller.
   */
  const reject = (reason: RejectionReason, offending: string): undefined => {
    const fields = { reason, source: describeSource(offending) };
    if (isExpectedRejection(reason, offending)) {
      logger.trace(REJECTION_MESSAGE, fields);
    } else {
      logger.debug(REJECTION_MESSAGE, fields);
    }
    return undefined;
  };

  if (typeof source !== 'string') {
    // Defensive: the compiler types this parameter as `string`, but the value
    // arrives from a parsed source-map document and from model-selected frames,
    // neither of which the type system vouches for at runtime. The runtime type
    // is logged rather than the value, which may not be renderable at all.
    return reject('non-string-source', `[${typeof source}]`);
  }

  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return reject('empty-source', source);
  }

  if (isWebpackInternalSource(trimmed)) {
    return reject('bundler-internal', trimmed);
  }

  const normalizedRoot = normalizePosix(toPosix(options.projectRoot));
  if (!isAbsolutePosix(normalizedRoot) && !isWindowsAbsolute(normalizedRoot)) {
    // Fail closed, exactly as `toProjectRelative` does for such a root: without
    // an absolute root, "inside the project" has nothing to mean, and a
    // relative source would be accepted on the strength of its own spelling.
    return reject('project-root-not-absolute', trimmed);
  }

  const parsed = sourcePathOf(trimmed);
  if (!parsed.ok) {
    return reject(parsed.reason, trimmed);
  }
  const candidate = parsed.path;

  let relative: string;
  if (isAbsolutePosix(candidate) || isWindowsAbsolute(candidate)) {
    const contained = toProjectRelative(normalizedRoot, candidate);
    if (isErr(contained)) {
      return reject('outside-project-root', trimmed);
    }
    relative = contained.value;
  } else {
    relative = normalizePosix(candidate);
  }

  if (relative === CURRENT_DIRECTORY) {
    // The project root is a directory; a `sources` entry that reduces to it
    // names no file, so there is nothing an editor could open.
    return reject('names-project-root', trimmed);
  }

  const leading = firstSegmentOf(relative);
  if (
    leading !== undefined &&
    BRACKETED_SEGMENT.test(leading) &&
    !SOURCE_URL_MARKERS.includes(leading)
  ) {
    // `[turbopack]`, `[next]`, `[externals]`: a bundler namespace holding
    // generated runtime code. `[project]` has already been stripped, and a
    // dynamic route segment such as `[id]` never leads a source path — a
    // Next.js route lives under `app/`, `src/` or `pages/`.
    return reject('bundler-namespace', trimmed);
  }

  const rejectedSegments = new Set<string>([
    ...REJECTED_PATH_SEGMENTS,
    ...(options.extraRejectedSegments ?? []),
  ]);
  for (const segment of relative.split(SEPARATOR)) {
    if (rejectedSegments.has(segment)) {
      return reject('excluded-segment', trimmed);
    }
  }

  // The security boundary. Everything above recognises a project path; this is
  // what proves one, and it is why no caller can receive an absolute path, a
  // Windows drive path, a surviving `..`, a backslash or a control character.
  if (!isSafeRelativePath(relative)) {
    return reject('unsafe-relative-path', trimmed);
  }

  return relative;
}

/**
 * Whether a `sources` entry steps above the root it is written against — or
 * cannot be read as a path at all.
 *
 * ## Why a caller needs this, when {@link normalizeSourcePath} already refuses
 *
 * Because a caller may hold a *second spelling* of the same source, and the
 * refusal does not travel with it. `@jridgewell/trace-mapping` reports
 * mappings against `resolvedSources`, which it builds by handing
 * `sourceRoot + '/' + source` to RFC 3986 URI resolution — and dot-segment
 * removal **silently drops** a `'..'` that would leave the root of an absolute
 * path. So `'webpack://_N_E/../../../../etc/passwd'`, which
 * {@link normalizeSourcePath} refuses, is reported as
 * `'webpack://_N_E/etc/passwd'`, which it accepts as `'etc/passwd'`: a
 * project-relative path, indistinguishable from a real one, for a file the
 * project does not contain. Map contents come from the dev server and from
 * every third-party bundle it serves, so that is attacker-influenced input
 * turned into a trusted-looking click-to-source target.
 *
 * `./resolver.ts` therefore asks this question of the *authored* entry (under
 * its map's `sourceRoot`, see {@link resolveSourceUnderRoot}) before it will
 * consider a resolved spelling of it. A `true` answer means no derived
 * spelling may be trusted, because the derivation is free to have normalised
 * the escape away; a `false` answer means resolution had no traversal to
 * remove, so the two spellings can differ only by the prefixing and `./`
 * collapsing that carry no such risk.
 *
 * ## What counts as escaping
 *
 * The path is read with {@link escapesOwnRoot}, so an *interior* traversal that
 * cancels a real segment above it —
 * `'webpack://_N_E/./src/widgets/../lib/http.ts'` — is not an escape and this
 * predicate reports `false` for it, exactly as {@link normalizeSourcePath}
 * resolves it. A rooted spelling is read the same way, because `'/../etc'`
 * escapes just as `'../etc'` does: the leading separator is where the
 * flattening happens, not a reason to trust it.
 *
 * ## An unreadable source is reported as escaping
 *
 * `true` is also the answer for a source this module cannot turn into a path at
 * all: a non-string, an empty one, a foreign scheme, an unusable `file:` URL, a
 * malformed percent escape, or a URL carrying no path. That is not a claim that
 * such a source traverses — it is the same fail-closed rule the question is
 * asked for. A source whose own path cannot be read cannot vouch for a spelling
 * derived from it, and resolution of such a source is a path-shaped string
 * built out of parts this module rejected: `'http://evil.example/x.ts'` under
 * `sourceRoot: 'src/'` resolves to `'src/http:/evil.example/x.ts'`, which reads
 * as an ordinary relative path and is not one.
 *
 * Total, like every export here: never throws, for any input.
 *
 * @param source A `sources` entry from a source map.
 * @returns `true` when no spelling derived from this source may be trusted.
 *
 * @example
 * ```ts
 * hasEscapingTraversal('webpack://_N_E/../../../../etc/passwd'); // true
 * hasEscapingTraversal('webpack://_N_E/./src/widgets/../lib/http.ts'); // false
 * hasEscapingTraversal('webpack://_N_E/./src/lib/http.ts'); // false
 * ```
 */
export function hasEscapingTraversal(source: string): boolean {
  if (typeof source !== 'string') {
    // Defensive for the same reason `normalizeSourcePath` is: the value arrives
    // from a parsed source-map document, which the type system does not vouch
    // for at runtime.
    return true;
  }

  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return true;
  }

  const parsed = sourcePathOf(trimmed);
  if (!parsed.ok) {
    return true;
  }

  return escapesOwnRoot(parsed.path);
}

/**
 * A `sources` entry as it reads beneath its map's `sourceRoot`, with any
 * traversal left intact.
 *
 * The concatenation is `@jridgewell/trace-mapping`'s own: its resolver prefixes
 * every entry with `sourceRoot + '/'` before resolving it, so this produces the
 * same string that library starts from — and stops there, handing it to
 * {@link normalizeSourcePath}, whose POSIX normalisation keeps an escaping
 * `'..'` where URI resolution would drop it. That is the whole difference, and
 * it is the point: `sourceRoot: 'webpack://_N_E/./src/deep/deeper/'` with
 * `'../../real.ts'` yields `'src/real.ts'` either way, while
 * `sourceRoot: 'webpack://_N_E/./src/'` with `'../../../../etc/passwd'` yields
 * a refusal here and `'etc/passwd'` there. A traversal in the *root* is caught
 * by the same reading, which a check on the entry alone would miss.
 *
 * The entry is returned unchanged — the root deliberately ignored — when it is
 * an **absolute reference**: it carries a scheme, or it is POSIX- or
 * Windows-rooted. That is URI semantics (an absolute reference resolves against
 * no base) and it is also what stops a root from being pasted onto a spelling
 * that is not a path: `'http://evil.example/x.ts'` under `sourceRoot: 'src/'`
 * would otherwise read as the relative path `'src/http:/evil.example/x.ts'`.
 * A blank root and an empty entry likewise change nothing.
 *
 * Duplicate separators are not trimmed: `normalizeSourcePath` collapses them,
 * so a root written with or without a trailing `'/'` resolves identically.
 *
 * Total, like every export here. A `sourceRoot` or entry that is not a string
 * at runtime — both arrive from a parsed source-map document, which the type
 * system does not vouch for — leaves the entry untouched rather than throwing,
 * and the guards in {@link normalizeSourcePath} and
 * {@link hasEscapingTraversal} refuse it downstream.
 *
 * @param sourceRoot The map's `sourceRoot`, or `undefined` when it declares none.
 * @param source A `sources` entry from that map.
 * @returns The entry beneath the root, or the entry unchanged.
 *
 * @example
 * ```ts
 * resolveSourceUnderRoot('webpack://_N_E/./src/', 'lib/http.ts');
 * // 'webpack://_N_E/./src//lib/http.ts' — normalises to 'src/lib/http.ts'
 * resolveSourceUnderRoot('webpack://_N_E/./src/', 'webpack://_N_E/./app/page.tsx');
 * // 'webpack://_N_E/./app/page.tsx' — an absolute reference ignores the root
 * ```
 */
export function resolveSourceUnderRoot(sourceRoot: string | undefined, source: string): string {
  if (typeof sourceRoot !== 'string' || typeof source !== 'string') {
    return source;
  }

  const root = sourceRoot.trim();
  const trimmed = source.trim();
  if (root.length === 0 || trimmed.length === 0) {
    return source;
  }

  if (schemeOf(trimmed) !== undefined || isAbsolutePosix(trimmed) || isWindowsAbsolute(trimmed)) {
    return source;
  }

  return `${root}${SEPARATOR}${trimmed}`;
}
