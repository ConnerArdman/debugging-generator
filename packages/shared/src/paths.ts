/**
 * POSIX path logic, and the containment gate that keeps this product inside the
 * project it was pointed at.
 *
 * Two different kinds of function live here, and the distinction matters more
 * than it looks:
 *
 * - **Lexical primitives** — {@link toPosix}, {@link normalizePosix},
 *   {@link isAbsolutePosix}, {@link isWindowsAbsolute}, {@link joinPosix},
 *   {@link relativePosix}, {@link dirnamePosix}, {@link basenamePosix} and
 *   {@link extnamePosix}. Plumbing: they compute a path from a path.
 * - **The gate** — {@link isSafeRelativePath}, {@link isWithin},
 *   {@link toProjectRelative} and {@link resolveWithinProject}. These are a
 *   **security boundary**, not a convenience. Three independent enforcement
 *   points call them: the local service's `source/open.ts`, which refuses a
 *   `source.open` request naming a path outside the session's project root; the
 *   VS Code extension's `uri-handler.ts`, which validates independently because
 *   *any* web page can trigger a `vscode://` URI; and
 *   `@debuggen/instrumentation`'s patcher, which must never write outside the
 *   project. A bug in the gate is an arbitrary-file-read or
 *   arbitrary-file-write bug, which is why every predicate here fails closed and
 *   why the sibling `paths.test.ts` is written as an attack table rather than a
 *   formatting check.
 *
 * ## No filesystem, and not even `node:path`
 *
 * Every function below is pure string logic over POSIX separators. Nothing here
 * reads the filesystem, resolves a symlink, consults `process.cwd()` or imports
 * a module. Three reasons, each load-bearing:
 *
 * 1. **The gate has to be exhaustively testable.** An attack table of a hundred
 *    adversarial strings runs as fast as a hundred function calls, with no
 *    temporary directory to create, no permissions to arrange and no case that
 *    cannot be expressed because the filesystem refuses to hold it.
 * 2. **This module is browser code too.** It is re-exported by `src/index.ts`,
 *    the browser-safe `"."` entry of `@debuggen/shared`, which the MAIN-world
 *    telemetry agent, the DevTools panel and the VS Code webview all bundle. A
 *    single `node:path` specifier would break three bundles at once. (Node-only
 *    helpers exist in this package — hashing, the hardened file creator — and
 *    they live behind the separate `"./node"` entry for exactly this reason.)
 * 3. **`node:path` changes behaviour with the platform.** `path.sep`,
 *    `path.normalize` and `path.resolve` follow the host, so the same string
 *    means one thing on a POSIX host and another on Windows. A containment
 *    check whose answer depends on where it runs is not a containment check.
 *    Everything the product stores or displays is project-relative POSIX
 *    regardless of host, so the conversion is explicit, here, once.
 *
 * ## The one guarantee, and its limit
 *
 * The gate is a **string-level** gate. It proves that a path, read as text,
 * cannot leave the project root. It cannot prove anything about what the
 * filesystem does with that path afterwards — most importantly, a symlink
 * inside the project whose target is outside it is invisible here. That escape
 * is caught by two other places, and every function in the gate repeats the
 * warning so no caller mistakes one for the other:
 *
 * - `apps/vscode-extension/src/uri-handler.ts` resolves the path with
 *   `fs.realpath` and requires the result to stay inside an open workspace
 *   folder's realpath.
 * - `packages/shared/src/node/safe-fs.ts` opens with `O_NOFOLLOW`, so the
 *   create path refuses to follow a symlink at the final component at all.
 *
 * ## Deliberate differences from `node:path`'s POSIX behaviour
 *
 * Reimplementing normalisation invites the question "does it match
 * `path.posix`?", so the answer is recorded rather than left to be discovered.
 * It matches on the cases that matter and differs on three, each on purpose:
 *
 * - A trailing separator is always stripped, except on the root `/`
 *   (`path.posix.normalize` preserves it: `'a/b/'` stays `'a/b/'`). A path is an
 *   identity in the session store, in a panel and in a prompt, so `'a/b'` and
 *   `'a/b/'` must not be two of them.
 * - {@link relativePosix} returns `'.'` for two equal paths
 *   (`path.posix.relative` returns the empty string). The empty string is not a
 *   usable path, and a caller that forgets to special-case it builds one by
 *   accident.
 * - {@link basenamePosix} never strips a suffix down to nothing
 *   (`path.posix.basename('.ts', '.ts')` returns `''`). A file name is never
 *   legitimately empty.
 *
 * @example Validating a path that arrived from outside the process
 * ```ts
 * const resolved = resolveWithinProject('/home/dev/project', 'src/lib/thing.ts');
 * if (isOk(resolved)) {
 *   await readSource(resolved.value); // '/home/dev/project/src/lib/thing.ts'
 * } else {
 *   logger.warn(resolved.error.message); // code: 'PATH_OUTSIDE_PROJECT'
 * }
 * ```
 */

import { DebuggenError } from './errors.js';
import { err, ok } from './result.js';
import type { Result } from './result.js';

/**
 * The only separator this module emits, whatever separator it was handed.
 *
 * Named rather than inlined because it appears in a dozen places below and
 * because the constant is the statement that there is exactly one: a path this
 * module produces never contains a backslash.
 */
const SEPARATOR = '/';

/** The single-dot segment, "this directory", which normalisation drops. */
const CURRENT_DIRECTORY = '.';

/** The double-dot segment, "the parent directory" — the escape the gate exists to stop. */
const PARENT_DIRECTORY = '..';

/**
 * A Windows drive-letter prefix: one ASCII letter followed by a colon.
 *
 * The separator after the colon is deliberately not required. `'C:/dir'` and
 * `'C:\dir'` are absolute, and the drive-relative `'C:dir'` — which Windows
 * resolves against that drive's own current directory — is not a portable
 * project-relative path either, so all three are reported. Anything a caller
 * hands this module with a drive prefix is treated as rooted somewhere the
 * project root cannot vouch for, and the gate says so rather than guessing.
 *
 * The character class is ASCII-only on purpose: Windows drive letters are.
 */
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * A UNC prefix: two leading separators, in either direction and in any mix.
 *
 * `'\\\\server\\share'` names a network share on Windows, and
 * {@link toPosix} turns it into `'//server/share'` — which is why this pattern
 * accepts both slash directions and why the detectors below must run on the raw
 * *and* the converted form of the same input.
 */
const UNC_PREFIX = /^[\\/]{2}/;

/** Highest code unit of the C0 control block (U+0000–U+001F), which includes NUL. */
const LAST_C0_CONTROL = 0x1f;

/** DELETE (U+007F) — the first code unit this module treats as a C1-range control. */
const FIRST_C1_CONTROL = 0x7f;

/** Highest code unit of the C1 control block (U+009F). */
const LAST_C1_CONTROL = 0x9f;

/** U+FFFD REPLACEMENT CHARACTER, substituted for a control character in a message. */
const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * How much of a rejected path an error message repeats back.
 *
 * A rejected path is attacker-influenced input, and the error carrying it may be
 * logged, persisted with a session and rendered in two user interfaces. The
 * offending value still has to be identifiable, so it is echoed — truncated, so
 * a multi-kilobyte string cannot be copied through the whole chain.
 */
const MAX_REPORTED_PATH_LENGTH = 160;

/**
 * Why the gate refused a path. Recorded as `details.reason` on the error, so a
 * caller can branch or report without parsing a message string.
 *
 * Module-internal: the public surface of this file is the thirteen functions
 * below, and every rejection they produce carries the single error code
 * `PATH_OUTSIDE_PROJECT`. The reason is the finer-grained diagnosis underneath
 * that code.
 *
 * - `project-root-not-absolute` — the root itself was relative, so "inside the
 *   project" had no meaning to check against.
 * - `network-share-path` — an argument began with two separators.
 * - `outside-project-root` — an absolute path that is not the root and not
 *   below it.
 * - `unsafe-relative-path` — a relative path that {@link isSafeRelativePath}
 *   refused: traversal, an absolute form, a control character, or empty.
 */
type RejectionReason =
  | 'project-root-not-absolute'
  | 'network-share-path'
  | 'outside-project-root'
  | 'unsafe-relative-path';

/**
 * Whether a UTF-16 code unit is a C0 or C1 control character.
 *
 * Control characters have no place in a path this product handles: NUL
 * truncates a path at the boundary of many C string APIs (so `'a\u0000.ts'` can
 * open `'a'`), and ESC begins a terminal escape sequence, which is how a path
 * echoed into a log line rewrites the rest of the line. Both classes are
 * refused by {@link isSafeRelativePath} and neutralised by
 * {@link reportablePath}.
 *
 * Surrogate code units (U+D800–U+DFFF) are far above this range, so a non-ASCII
 * file name passes untouched.
 */
function isControlCode(code: number): boolean {
  return code <= LAST_C0_CONTROL || (code >= FIRST_C1_CONTROL && code <= LAST_C1_CONTROL);
}

/**
 * Renders a path safely for an error message: truncated, with every control
 * character replaced by U+FFFD.
 *
 * See {@link MAX_REPORTED_PATH_LENGTH} for the truncation rationale and
 * {@link isControlCode} for why the substitution is not cosmetic.
 */
function reportablePath(path: string): string {
  const truncated =
    path.length > MAX_REPORTED_PATH_LENGTH ? `${path.slice(0, MAX_REPORTED_PATH_LENGTH)}…` : path;

  let safe = '';
  for (let index = 0; index < truncated.length; index += 1) {
    safe += isControlCode(truncated.charCodeAt(index))
      ? REPLACEMENT_CHARACTER
      : truncated.charAt(index);
  }
  return safe;
}

/**
 * Converts to POSIX separators and normalises lexically, in that order.
 *
 * The order is the whole point: normalising first would leave a backslash
 * inside a segment, so `'a\\..\\..\\b'` would look like one innocent segment to
 * the `..` check and then escape the project the moment a Windows API resolved
 * it. Every function in the gate that accepts a caller-supplied path runs it
 * through here.
 */
function normalizeToPosix(path: string): string {
  return normalizePosix(toPosix(path));
}

/**
 * Splits a normalised path into its meaningful segments.
 *
 * Empty segments (from a leading separator) and `'.'` (a normalised path
 * contains one only when it *is* `'.'`) are dropped, so the root `'/'` and the
 * current directory `'.'` both yield an empty array — which is what makes
 * {@link relativePosix} and {@link isWithin} read the same way for the root as
 * for any other directory.
 */
function segmentsOf(normalized: string): string[] {
  const segments: string[] = [];
  for (const segment of normalized.split(SEPARATOR)) {
    if (segment.length > 0 && segment !== CURRENT_DIRECTORY) {
      segments.push(segment);
    }
  }
  return segments;
}

/**
 * Builds the single error every rejection in this module returns.
 *
 * One code, `PATH_OUTSIDE_PROJECT`, for every refusal: a caller reacting to a
 * refused path does the same thing whichever way the path was malformed, and the
 * finer diagnosis travels in `details.reason`.
 *
 * `details` carries only the two strings the caller already supplied, each
 * passed through {@link reportablePath}. No filesystem fact is added — not
 * whether the path exists, not what it resolves to, not where anything else
 * lives — because the answer to a refused path must not become an oracle for
 * probing the developer's disk.
 */
function outsideProject(
  message: string,
  reason: RejectionReason,
  projectRoot: string,
  path: string,
): DebuggenError {
  return new DebuggenError('PATH_OUTSIDE_PROJECT', message, {
    hint: 'Use a path inside the project root, written project-relative with forward slashes.',
    details: {
      reason,
      projectRoot: reportablePath(projectRoot),
      path: reportablePath(path),
    },
  });
}

/**
 * Replaces every backslash with a forward slash.
 *
 * The first step for any path that came from outside this module: a VS Code URI
 * on Windows, a stack frame in a bundled chunk, a `tsconfig.json` path, a value
 * a developer typed. It converts separators and nothing else — no
 * normalisation, no validation, no case folding — so it is safe to apply to a
 * path that has not been checked yet.
 *
 * A Windows UNC path is converted too: `'\\\\server\\share'` becomes
 * `'//server/share'`, gaining a *double* leading separator rather than
 * disappearing. That is exactly why {@link isWindowsAbsolute} accepts both
 * slash directions and why {@link toProjectRelative} and
 * {@link resolveWithinProject} refuse a two-separator prefix outright instead
 * of letting normalisation quietly collapse it to one.
 *
 * On a POSIX filesystem a backslash is a legal character in a file name, so
 * this conversion is lossy for such a name. That is deliberate and is the same
 * trade the rest of the product makes: a backslash is read as a separator
 * everywhere here, never as part of a name, because the alternative is a string
 * that means one thing to this module and another to a Windows API.
 *
 * @param path Any path, absolute or relative, POSIX or Windows.
 * @returns The same path with `/` as its only separator.
 *
 * @example
 * ```ts
 * toPosix('src\\lib\\thing.ts'); // 'src/lib/thing.ts'
 * toPosix('C:\\Users\\dev\\project'); // 'C:/Users/dev/project'
 * ```
 */
export function toPosix(path: string): string {
  return path.replaceAll('\\', SEPARATOR);
}

/**
 * Normalises a POSIX path lexically: no filesystem, no current directory, no
 * symlink resolution.
 *
 * The rules, in full, because the gate's correctness rests on them:
 *
 * - Repeated separators collapse (`'a//b'` → `'a/b'`).
 * - `'.'` segments are dropped (`'./a/./b'` → `'a/b'`).
 * - A `'..'` segment cancels the segment before it when there is one
 *   (`'a/b/../c'` → `'a/c'`).
 * - For an **absolute** path, a `'..'` with nothing left to cancel is dropped:
 *   the root is its own parent (`'/..'` → `'/'`, `'/a/../..'` → `'/'`).
 * - For a **relative** path, a leading `'..'` is *preserved* (`'../a'` →
 *   `'../a'`, `'a/../..'` → `'..'`): there is nothing to resolve it against
 *   without a base, and inventing one would be the bug. Callers that must not
 *   accept such a path use {@link isSafeRelativePath}, which rejects every
 *   surviving `'..'`.
 * - A single leading separator is preserved for an absolute path.
 * - A trailing separator is stripped, except on the root itself (`'/a/'` →
 *   `'/a'`, `'/'` → `'/'`).
 * - The empty string normalises to `'.'`, as does any path that reduces to
 *   nothing (`'a/..'` → `'.'`).
 *
 * Separators are expected to be forward slashes already: this function does not
 * convert them, so run {@link toPosix} first on anything that might carry a
 * backslash. Two leading separators collapse to one here, which is why the
 * `Result`-returning functions of the gate reject that prefix *before* calling
 * this — see {@link toPosix}.
 *
 * @param path A POSIX path, absolute or relative.
 * @returns The normalised path; never the empty string.
 *
 * @example
 * ```ts
 * normalizePosix('/home/dev/project/src/../src/lib/thing.ts');
 * // '/home/dev/project/src/lib/thing.ts'
 * normalizePosix('src//lib/./thing.ts/'); // 'src/lib/thing.ts'
 * normalizePosix('../../elsewhere'); // '../../elsewhere' (nothing to resolve against)
 * ```
 */
export function normalizePosix(path: string): string {
  if (path.length === 0) {
    return CURRENT_DIRECTORY;
  }

  const absolute = path.startsWith(SEPARATOR);
  const segments: string[] = [];

  for (const segment of path.split(SEPARATOR)) {
    if (segment.length === 0 || segment === CURRENT_DIRECTORY) {
      continue;
    }

    if (segment === PARENT_DIRECTORY) {
      const last = segments.at(-1);
      if (last !== undefined && last !== PARENT_DIRECTORY) {
        // Cancel the preceding real segment. It can never be '..' itself here:
        // a '..' only reaches the array when there was nothing to cancel.
        segments.pop();
      } else if (!absolute) {
        // Relative path with nothing to cancel: the '..' is meaningful and is
        // kept. On an absolute path it is dropped — '/' is its own parent.
        segments.push(PARENT_DIRECTORY);
      }
      continue;
    }

    segments.push(segment);
  }

  const joined = segments.join(SEPARATOR);
  if (absolute) {
    return `${SEPARATOR}${joined}`;
  }
  return joined.length === 0 ? CURRENT_DIRECTORY : joined;
}

/**
 * Whether a path is POSIX-absolute, i.e. begins with `/`.
 *
 * A pure prefix test on the string as given: it does not convert separators, so
 * `'\\dir'` is not absolute to this function (run {@link toPosix} first if that
 * is the question you mean to ask), and it says nothing about Windows roots —
 * {@link isWindowsAbsolute} answers that half.
 *
 * @param path Any path.
 * @returns `true` when the first character is `/`.
 */
export function isAbsolutePosix(path: string): boolean {
  return path.startsWith(SEPARATOR);
}

/**
 * Whether a path is rooted the Windows way: a drive-letter prefix or a UNC
 * prefix.
 *
 * Both forms are recognised in either slash direction, so the answer is the
 * same for a raw Windows path and for its {@link toPosix} conversion — which is
 * required of this function, because the gate converts separators before it
 * validates and must not lose the fact that the path was rooted:
 *
 * | Input | Result |
 * | --- | --- |
 * | `'C:\dir'`, `'C:/dir'`, `'C:'`, `'C:dir'` | `true` (drive prefix) |
 * | `'\\\\server\\share'`, `'//server/share'` | `true` (UNC prefix) |
 * | `'/home/dev/project'` | `false` (POSIX-absolute, not Windows-rooted) |
 * | `'src/lib/thing.ts'` | `false` |
 *
 * The drive-relative form `'C:dir'` is reported as well: it is not absolute in
 * the POSIX sense, but it is not a portable project-relative path either, and
 * {@link isSafeRelativePath} must refuse it rather than treat `'C:dir'` as a
 * file named `C:dir`.
 *
 * @param path Any path, raw or already converted to forward slashes.
 * @returns `true` when the path carries a drive-letter or UNC prefix.
 */
export function isWindowsAbsolute(path: string): boolean {
  return WINDOWS_DRIVE_PREFIX.test(path) || UNC_PREFIX.test(path);
}

/**
 * Joins segments with `/` and normalises the result.
 *
 * Empty segments are ignored, so a conditional piece can be passed as `''`
 * without producing a double separator. Absoluteness is that of the first
 * non-empty segment: joining onto `'/home/dev/project'` yields an absolute
 * path, joining onto `'src'` a relative one.
 *
 * The result is normalised, which means a `'..'` in a later segment is resolved
 * against an earlier one — `joinPosix('src', '../lib')` is `'lib'`, not
 * `'src/../lib'`. **That resolution is not a containment check.** Joining an
 * untrusted segment onto a trusted root can leave the root
 * (`joinPosix('/home/dev/project', '../../etc')` is `'/etc'`), so a caller
 * combining a root with a path from elsewhere uses
 * {@link resolveWithinProject}, which validates the segment first and re-checks
 * the joined result.
 *
 * @param segments Path segments, in order. Empty strings are skipped.
 * @returns The joined, normalised path; `'.'` when nothing was supplied.
 *
 * @example
 * ```ts
 * joinPosix('/home/dev/project', 'src/lib', 'thing.ts');
 * // '/home/dev/project/src/lib/thing.ts'
 * joinPosix('src', '', 'lib/thing.ts'); // 'src/lib/thing.ts'
 * joinPosix('src', '../lib'); // 'lib'
 * ```
 */
export function joinPosix(...segments: string[]): string {
  let joined = '';
  for (const segment of segments) {
    if (segment.length === 0) {
      continue;
    }
    joined = joined.length === 0 ? segment : `${joined}${SEPARATOR}${segment}`;
  }
  return normalizePosix(joined);
}

/**
 * The relative path from `from` to `to`, computed lexically.
 *
 * Both arguments are normalised first, their common leading segments are
 * dropped, one `'..'` is emitted for each segment of `from` that remains, and
 * the remaining segments of `to` follow. Two equal paths give `'.'` rather than
 * the empty string, so the result is always a usable path.
 *
 * **Both arguments must be absolute, or both relative.** There is no current
 * directory here to bridge the two, so mixing them produces a lexically
 * consistent but meaningless answer. For the same reason a leading `'..'` in
 * either argument (a relative path pointing above its own base) is treated as
 * an ordinary segment: the base it would be resolved against is not knowable
 * from the strings alone.
 *
 * @param from The path the result starts at, conventionally a directory.
 * @param to The path the result arrives at.
 * @returns The relative path, `'.'` when the two normalise to the same path.
 *
 * @example
 * ```ts
 * relativePosix('/home/dev/project', '/home/dev/project/src/lib/thing.ts');
 * // 'src/lib/thing.ts'
 * relativePosix('/home/dev/project/src', '/home/dev/project/docs'); // '../docs'
 * relativePosix('/home/dev/project', '/home/dev/project'); // '.'
 * ```
 */
export function relativePosix(from: string, to: string): string {
  const fromNormalized = normalizePosix(from);
  const toNormalized = normalizePosix(to);
  if (fromNormalized === toNormalized) {
    return CURRENT_DIRECTORY;
  }

  const fromSegments = segmentsOf(fromNormalized);
  const toSegments = segmentsOf(toNormalized);

  let common = 0;
  while (common < fromSegments.length && common < toSegments.length) {
    const fromSegment = fromSegments.at(common);
    const toSegment = toSegments.at(common);
    if (fromSegment === undefined || toSegment === undefined || fromSegment !== toSegment) {
      break;
    }
    common += 1;
  }

  const parts: string[] = [];
  for (let ascent = common; ascent < fromSegments.length; ascent += 1) {
    parts.push(PARENT_DIRECTORY);
  }
  for (const segment of toSegments.slice(common)) {
    parts.push(segment);
  }

  // Reachable when the two paths normalise to different strings that share every
  // segment — '/' against '.', for instance, which no caller should mix.
  return parts.length === 0 ? CURRENT_DIRECTORY : parts.join(SEPARATOR);
}

/**
 * The directory part of a path, after normalisation.
 *
 * Follows POSIX `dirname` conventions: `'/home/dev/project/thing.ts'` →
 * `'/home/dev/project'`, `'/thing.ts'` → `'/'`, `'/'` → `'/'`, `'thing.ts'` →
 * `'.'`. Because the path is normalised first, a trailing separator does not
 * change the answer (`'src/lib/'` → `'src'`, the same as `'src/lib'`).
 *
 * @param path Any path.
 * @returns The parent directory; `'.'` for a bare name, `'/'` for a root child.
 */
export function dirnamePosix(path: string): string {
  const normalized = normalizePosix(path);
  if (normalized === SEPARATOR) {
    return SEPARATOR;
  }

  const lastSeparator = normalized.lastIndexOf(SEPARATOR);
  if (lastSeparator < 0) {
    return CURRENT_DIRECTORY;
  }
  if (lastSeparator === 0) {
    return SEPARATOR;
  }
  return normalized.slice(0, lastSeparator);
}

/**
 * The final component of a path, optionally with a suffix removed.
 *
 * The path is normalised first, so a trailing separator is ignored
 * (`'src/lib/'` → `'lib'`). The root `'/'` has no final component and yields
 * the empty string.
 *
 * `ext` is removed only when the component genuinely ends with it *and* is
 * longer than it, so a suffix equal to the whole name leaves the name alone:
 * `basenamePosix('.ts', '.ts')` is `'.ts'`, not `''`. A file name is never
 * legitimately empty, and this is one of the three places where this module
 * deliberately differs from `node:path` (see the module documentation).
 *
 * @param path Any path.
 * @param ext An optional suffix to strip, with its leading dot (`'.ts'`).
 * @returns The final component, with `ext` removed when applicable.
 *
 * @example
 * ```ts
 * basenamePosix('src/lib/thing.ts'); // 'thing.ts'
 * basenamePosix('src/lib/thing.ts', '.ts'); // 'thing'
 * basenamePosix('src/lib/.ts', '.ts'); // '.ts' — never stripped to nothing
 * ```
 */
export function basenamePosix(path: string, ext?: string): string {
  const normalized = normalizePosix(path);
  if (normalized === SEPARATOR) {
    return '';
  }

  const lastSeparator = normalized.lastIndexOf(SEPARATOR);
  const base = lastSeparator < 0 ? normalized : normalized.slice(lastSeparator + 1);

  if (ext !== undefined && ext.length > 0 && base.length > ext.length && base.endsWith(ext)) {
    return base.slice(0, base.length - ext.length);
  }
  return base;
}

/**
 * The extension of a path's final component, including its leading dot.
 *
 * POSIX `extname` semantics: the suffix from the **last** dot of the component,
 * provided that dot is not the first character. So `'thing.ts'` → `'.ts'`,
 * `'thing.test.ts'` → `'.ts'`, `'thing'` → `''`, and a dotfile with no further
 * dot → `''` (`'.gitignore'` is a name, not an extension). A component ending
 * in a dot yields `'.'`, and the navigation components `'.'` and `'..'` yield
 * the empty string.
 *
 * @param path Any path.
 * @returns The extension with its dot, or the empty string when there is none.
 */
export function extnamePosix(path: string): string {
  const base = basenamePosix(path);
  if (base === CURRENT_DIRECTORY || base === PARENT_DIRECTORY) {
    return '';
  }

  const lastDot = base.lastIndexOf('.');
  return lastDot <= 0 ? '' : base.slice(lastDot);
}

/**
 * Whether a string is a project-relative POSIX path that cannot escape the
 * project.
 *
 * This is the validator for every file path the product stores, displays or
 * accepts from another process. `source-location.ts` in this package applies it
 * to `SourceLocation.file`, so every runtime item — a span's source, a patch
 * target, a panel's source chip — is checked at the schema boundary, before it
 * can reach a filesystem call, a prompt or a user interface.
 *
 * Refused, each case fails closed:
 *
 * - The empty string, and any string that is only whitespace — judged before
 *   *and* after normalisation, so `'a/../ '` is refused exactly as `' '` is. A
 *   path that reduces to nothing but whitespace is meaningless input, and
 *   accepting one form while refusing the other would put this predicate at
 *   odds with the two functions below, which normalise.
 * - A control character anywhere: C0 (U+0000–U+001F, so NUL included), DELETE
 *   and C1 (U+007F–U+009F). NUL terminates a path early in C string APIs — so
 *   `'a\u0000.ts'` can open `'a'` — and ESC begins a terminal escape sequence.
 * - A backslash anywhere. Not as a separator and not as a file name character:
 *   the product's paths are POSIX, and `'..\\..\\elsewhere'` is a single
 *   innocent-looking segment to a `'..'` check yet a traversal to any Windows
 *   API that later resolves it. Convert with {@link toPosix} *before* asking.
 * - Anything {@link isAbsolutePosix} or {@link isWindowsAbsolute} accepts: a
 *   POSIX-absolute path, a drive-letter path in either slash direction, a UNC
 *   path. A project-relative path is relative.
 * - Any `'..'` segment that survives {@link normalizePosix} — leading
 *   (`'../secret.ts'`), interior (`'src/../../secret.ts'`), or the whole path.
 *   An interior `'..'` that resolves back inside is fine
 *   (`'src/../src/lib/thing.ts'`), because normalisation has already removed
 *   it.
 *
 * Accepted: an ordinary name, a nested path, a name with dots in it, a dotfile,
 * `'.'` for the project root itself, and a non-ASCII name — a file name is text,
 * and this predicate has no opinion about the alphabet it is written in.
 *
 * This is a **string-level** check. It cannot see that
 * `'src/lib/thing.ts'` is a symlink whose target lies outside the project;
 * `fs.realpath` in `apps/vscode-extension/src/uri-handler.ts` and `O_NOFOLLOW`
 * in this package's `src/node/safe-fs.ts` are what close that gap.
 *
 * @param path The candidate project-relative path.
 * @returns `true` only when the path is safe to treat as project-relative.
 *
 * @example
 * ```ts
 * isSafeRelativePath('src/lib/thing.ts'); // true
 * isSafeRelativePath('src/../src/lib/thing.ts'); // true — resolves back inside
 * isSafeRelativePath('../secret.ts'); // false
 * isSafeRelativePath('/home/dev/project/src/lib/thing.ts'); // false — absolute
 * ```
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.trim().length === 0) {
    return false;
  }

  for (let index = 0; index < path.length; index += 1) {
    if (isControlCode(path.charCodeAt(index))) {
      return false;
    }
  }

  if (path.includes('\\')) {
    return false;
  }

  if (isAbsolutePosix(path) || isWindowsAbsolute(path)) {
    return false;
  }

  const normalized = normalizePosix(path);

  // Normalisation cannot introduce a root prefix, but it is cheap to insist:
  // the two predicates above are the ones a future edit could weaken.
  if (isAbsolutePosix(normalized) || isWindowsAbsolute(normalized)) {
    return false;
  }

  // The same emptiness test again, on the normalised form. Without it the
  // predicate would refuse ' ' and accept 'a/../ ', which normalises to it —
  // and the two functions below, which normalise, would then disagree with the
  // predicate about the same path.
  if (normalized.trim().length === 0) {
    return false;
  }

  for (const segment of normalized.split(SEPARATOR)) {
    if (segment === PARENT_DIRECTORY) {
      return false;
    }
  }

  return true;
}

/**
 * Whether one absolute path is the other or lies beneath it.
 *
 * Both arguments are converted to POSIX separators and normalised lexically
 * first, so duplicate separators, `'.'` segments and an interior `'..'` that
 * resolves back inside do not affect the answer — while an interior `'..'` that
 * resolves *outside* makes it `false`, because normalisation is what exposes
 * that.
 *
 * The test after normalisation is exactly two cases and nothing else: the paths
 * are equal, or the candidate begins with the root followed by **one** separator
 * and at least one further character. That second condition is what rejects the
 * prefix-sibling attack, the mistake a bare `startsWith(root)` makes:
 *
 * | Root | Candidate | Result |
 * | --- | --- | --- |
 * | `/proj` | `/proj` | `true` |
 * | `/proj` | `/proj/src/lib/thing.ts` | `true` |
 * | `/proj` | `/proj-evil/secret.ts` | **`false`** |
 * | `/proj` | `/project/secret.ts` | **`false`** |
 * | `/proj/` | `/proj/src` | `true` (a trailing separator on the root is fine) |
 * | `/` | `/anything` | `true` (everything is beneath the filesystem root) |
 * | `/proj` | `/Proj/src` | `false` (case-sensitive, see below) |
 *
 * The comparison is **case-sensitive and byte-wise by design**. A
 * case-insensitive filesystem (macOS by default, Windows) will happily open
 * `/Proj/src` through a root of `/proj`, and this function still answers
 * `false`: refusing a path the product cannot vouch for character-for-character
 * is the fail-closed direction, and the alternative — folding case — would make
 * two distinct paths on a case-sensitive host compare equal, which is the
 * failure that actually lets something through.
 *
 * Both arguments are expected to be absolute already. A relative argument is
 * compared lexically all the same and simply will not match an absolute one, so
 * the answer stays `false`; {@link toProjectRelative} and
 * {@link resolveWithinProject} are the entry points that insist on an absolute
 * root and reject a two-separator (network share) prefix before they get here.
 *
 * **Limit of the guarantee.** This is the string-level gate only. A symlink
 * inside the root whose target is outside it passes this check, because a
 * string cannot reveal it. The filesystem-level checks that do are
 * `fs.realpath` in `apps/vscode-extension/src/uri-handler.ts`, which requires
 * the resolved path to stay inside an open workspace folder's realpath, and
 * `O_NOFOLLOW` in this package's `src/node/safe-fs.ts`, which refuses to follow
 * a symlink at the final component. Never treat this function as a complete
 * check on its own.
 *
 * @param rootAbs The absolute path of the directory that must contain the
 * candidate.
 * @param candidateAbs The absolute path being tested.
 * @returns `true` when the candidate is the root or lies beneath it.
 */
export function isWithin(rootAbs: string, candidateAbs: string): boolean {
  const root = normalizeToPosix(rootAbs);
  const candidate = normalizeToPosix(candidateAbs);

  if (root === candidate) {
    return true;
  }

  // After normalisation only the filesystem root ends with a separator, so this
  // is what keeps '/' from producing the doubled prefix '//'.
  const prefix = root.endsWith(SEPARATOR) ? root : `${root}${SEPARATOR}`;

  return candidate.startsWith(prefix) && candidate.length > prefix.length;
}

/**
 * Validates the project root itself, the precondition both `Result`-returning
 * functions share.
 *
 * "Inside the project" is only a meaningful question when the root is rooted,
 * so a relative root is refused rather than silently compared. A two-separator
 * prefix is refused as well — see {@link toProjectRelative} for why a network
 * share cannot be reduced to a project-relative path.
 *
 * @returns The rejection, or `undefined` when the root is usable.
 */
function projectRootRejection(projectRoot: string, path: string): DebuggenError | undefined {
  if (UNC_PREFIX.test(projectRoot)) {
    return outsideProject(
      `The project root '${reportablePath(projectRoot)}' begins with two separators, which names a network share rather than a local project directory.`,
      'network-share-path',
      projectRoot,
      path,
    );
  }

  const root = normalizeToPosix(projectRoot);
  if (!isAbsolutePosix(root) && !isWindowsAbsolute(root)) {
    return outsideProject(
      `The project root '${reportablePath(projectRoot)}' is not an absolute path, so containment cannot be established.`,
      'project-root-not-absolute',
      projectRoot,
      path,
    );
  }

  return undefined;
}

/**
 * Reduces a path to the project-relative POSIX form the product stores and
 * displays, or refuses it.
 *
 * Both arguments are converted to POSIX separators and normalised, and then the
 * path takes one of two routes:
 *
 * - **Absolute** (POSIX-absolute or Windows-rooted): it must satisfy
 *   {@link isWithin} against the root, and is then reduced to its remainder
 *   below the root. The root itself reduces to `'.'`.
 * - **Relative**: it is taken to be project-relative already and must satisfy
 *   {@link isSafeRelativePath}, which is where traversal, control characters,
 *   the empty string and disguised absolute forms are caught.
 *
 * This function is the product's *converter*, so it validates the path with its
 * separators already converted: a Windows-style relative path
 * (`'src\\lib\\thing.ts'`) is accepted and comes back in POSIX form, while a
 * backslash traversal (`'..\\..\\secret.ts'`) is still refused, because the
 * `'..'` check runs after conversion. Callers that must *reject* rather than
 * convert — anything validating a stored or received path — use
 * {@link isSafeRelativePath} or {@link resolveWithinProject}, which judge the
 * string exactly as given.
 *
 * The returned path never begins with `'/'` or `'./'` and never contains a
 * backslash — this is the canonical form every layer above depends on, because
 * a path is an identity in the session store, a key in a panel and a value in a
 * prompt. Returning an absolute path would also leak the developer's directory
 * layout into all three.
 *
 * Every refusal is an `Err` carrying a `DebuggenError` with code
 * `PATH_OUTSIDE_PROJECT`, whatever the reason; `details.reason` distinguishes
 * them, and nothing about the filesystem is disclosed — not whether the path
 * exists, not what it points at.
 *
 * A two-separator prefix on either argument is refused rather than normalised.
 * On Windows `'//server/share'` is a different volume, and collapsing it to one
 * separator could make an off-volume path look as though it sat inside the root.
 *
 * **Limit of the guarantee.** String level only: a symlink inside the project
 * whose target is outside it satisfies this function. `fs.realpath` in
 * `apps/vscode-extension/src/uri-handler.ts` and `O_NOFOLLOW` in this package's
 * `src/node/safe-fs.ts` are the checks that catch that escape.
 *
 * @param projectRoot The absolute path of the project root.
 * @param path The path to reduce: absolute and inside the root, or already
 * project-relative.
 * @returns `Ok` with the project-relative POSIX path, or `Err` with code
 * `PATH_OUTSIDE_PROJECT`.
 *
 * @example
 * ```ts
 * toProjectRelative('/home/dev/project', '/home/dev/project/src/lib/thing.ts');
 * // Ok('src/lib/thing.ts')
 * toProjectRelative('/home/dev/project', './src/lib/thing.ts'); // Ok('src/lib/thing.ts')
 * toProjectRelative('/home/dev/project', '/etc/hosts'); // Err('PATH_OUTSIDE_PROJECT')
 * toProjectRelative('/home/dev/project', '../secret.ts'); // Err('PATH_OUTSIDE_PROJECT')
 * ```
 */
export function toProjectRelative(projectRoot: string, path: string): Result<string> {
  const rootRejection = projectRootRejection(projectRoot, path);
  if (rootRejection !== undefined) {
    return err(rootRejection);
  }

  if (UNC_PREFIX.test(path)) {
    return err(
      outsideProject(
        `The path '${reportablePath(path)}' begins with two separators, which names a network share rather than a location inside the project.`,
        'network-share-path',
        projectRoot,
        path,
      ),
    );
  }

  const root = normalizeToPosix(projectRoot);

  // Separators are converted but normalisation is deferred: `normalizePosix`
  // turns the empty string into '.', which would silently reinterpret "no path"
  // as "the project root". The validator below therefore sees the path as the
  // caller wrote it, modulo separators, and normalisation happens afterwards.
  const posixPath = toPosix(path);

  if (isAbsolutePosix(posixPath) || isWindowsAbsolute(posixPath)) {
    const candidate = normalizePosix(posixPath);
    if (!isWithin(root, candidate)) {
      return err(
        outsideProject(
          `The path '${reportablePath(path)}' is outside the project root '${reportablePath(projectRoot)}'.`,
          'outside-project-root',
          projectRoot,
          path,
        ),
      );
    }

    const relative = relativePosix(root, candidate);

    // The remainder of a contained path cannot traverse, but it can still carry
    // a control character the absolute form smuggled in, so it is validated too.
    if (!isSafeRelativePath(relative)) {
      return err(
        outsideProject(
          `The path '${reportablePath(path)}' is inside the project root but is not a usable project-relative path.`,
          'unsafe-relative-path',
          projectRoot,
          path,
        ),
      );
    }

    return ok(relative);
  }

  if (!isSafeRelativePath(posixPath)) {
    return err(
      outsideProject(
        `The path '${reportablePath(path)}' is not a safe project-relative path.`,
        'unsafe-relative-path',
        projectRoot,
        path,
      ),
    );
  }

  return ok(normalizePosix(posixPath));
}

/**
 * Turns a project-relative path back into an absolute POSIX path inside the
 * project, or refuses it.
 *
 * The inverse of {@link toProjectRelative}, and the function every caller that
 * is about to touch the filesystem on behalf of another process goes through:
 * the service resolving a `source.open` request, the VS Code URI handler
 * resolving a path a web page supplied, the patcher resolving a plan's target.
 *
 * Three steps, deliberately redundant:
 *
 * 1. `relPath` must satisfy {@link isSafeRelativePath} — checked on the string
 *    as given, so a backslash traversal is refused instead of being converted
 *    into one that looks innocent.
 * 2. It is joined onto the normalised root and normalised again.
 * 3. The joined result is re-checked with {@link isWithin}. The join is not
 *    trusted: step 1 is the argument that it cannot escape, and step 3 is the
 *    proof that it did not.
 *
 * Every refusal is an `Err` carrying a `DebuggenError` with code
 * `PATH_OUTSIDE_PROJECT` and a `details.reason`, and discloses no filesystem
 * fact.
 *
 * **Limit of the guarantee.** String level only. The returned path is inside
 * the project *as text*; whether opening it stays inside the project is a
 * question for `fs.realpath` in `apps/vscode-extension/src/uri-handler.ts`,
 * which requires the resolved path to stay inside an open workspace folder's
 * realpath, and for `O_NOFOLLOW` in this package's `src/node/safe-fs.ts`, which
 * refuses to follow a symlink at the final component. A caller that opens a
 * file uses one of those as well as this.
 *
 * @param projectRoot The absolute path of the project root.
 * @param relPath The project-relative POSIX path to resolve.
 * @returns `Ok` with the absolute POSIX path, or `Err` with code
 * `PATH_OUTSIDE_PROJECT`.
 *
 * @example
 * ```ts
 * resolveWithinProject('/home/dev/project', 'src/lib/thing.ts');
 * // Ok('/home/dev/project/src/lib/thing.ts')
 * resolveWithinProject('/home/dev/project', '../secret.ts'); // Err('PATH_OUTSIDE_PROJECT')
 * resolveWithinProject('/home/dev/project', '/etc/hosts'); // Err('PATH_OUTSIDE_PROJECT')
 * ```
 */
export function resolveWithinProject(projectRoot: string, relPath: string): Result<string> {
  const rootRejection = projectRootRejection(projectRoot, relPath);
  if (rootRejection !== undefined) {
    return err(rootRejection);
  }

  if (!isSafeRelativePath(relPath)) {
    return err(
      outsideProject(
        `The path '${reportablePath(relPath)}' is not a safe project-relative path.`,
        'unsafe-relative-path',
        projectRoot,
        relPath,
      ),
    );
  }

  const root = normalizeToPosix(projectRoot);
  const resolved = joinPosix(root, relPath);

  if (!isWithin(root, resolved)) {
    return err(
      outsideProject(
        `The path '${reportablePath(relPath)}' resolves outside the project root '${reportablePath(projectRoot)}'.`,
        'outside-project-root',
        projectRoot,
        relPath,
      ),
    );
  }

  return ok(resolved);
}
