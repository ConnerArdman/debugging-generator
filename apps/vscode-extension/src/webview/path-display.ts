/**
 * Path display for the "Debug Generator" webview: how a project-relative path is split so that a
 * narrow view shortens it in the middle, keeps its file name, and still tells apart every path of
 * the list it is shown in.
 *
 * ## Why a path is split at all
 *
 * The view lives in a sidebar, so a path is often wider than its column. Ellipsised at its end it
 * loses the file name first; ellipsised after its last directory, as a plain directory-and-name
 * split does, it loses whatever separates two files of the same name — `app/api/widgets/route.ts`
 * and `app/api/widgets/parts/route.ts` both read "app/api/wid…route.ts". Either way two rows
 * render one indistinguishable chip.
 *
 * ## The four parts
 *
 * {@link describePaths} gives every distinct path of a list a {@link PathDisplay}:
 *
 * ```text
 * path                            lead               tail = context + name
 * app/api/widgets/route.ts        app/api/           widgets/ + route.ts
 * app/api/widgets/parts/route.ts  app/api/widgets/   parts/   + route.ts
 * src/lib/format.ts               src/lib/           (none)   + format.ts
 * ```
 *
 * - `tail` is the shortest run of trailing `/`-separated segments that ends in the file name and
 *   that no other distinct path of the same list ends in — the way an editor labels two tabs that
 *   show files of the same name. When every shorter run is shared, the tail is the whole path and
 *   the lead is empty.
 * - `lead` is everything before the tail: the part the list does not need to tell this path apart.
 * - `context` is the tail's directories and `name` its file name, the tail's final segment.
 *
 * The stylesheet's `.dgv-path` contract (`./styles.css`) shrinks the lead first, then the context,
 * and never the name unless the name alone is wider than the column. What stays visible in a
 * narrow view is therefore the start of the lead, the start of the tail — the segment that
 * distinguishes the path, since the run one segment shorter is shared — and the file name.
 *
 * ## Invariants
 *
 * - **Byte-faithful.** `lead + tail === path` and `context + name === tail` for every path. The
 *   parts are slices of the string as received: nothing is trimmed, normalised or re-joined, so the
 *   rendered text is the path the pipeline sent.
 * - **Distinct tails.** Two distinct paths of one list never get the same tail. A tail shorter than
 *   its path is, by construction, the suffix of no other path. A tail equal to its whole path `P`
 *   is shared only by a path `Q` that ends in `/` followed by `P`; `Q`'s suffix of `P`'s length is
 *   then shared, so `Q`'s tail is longer than `P`.
 * - **Compared as received.** `/` is the only separator — the protocol's paths are project-relative
 *   POSIX paths — and segments are compared exactly: no case folding, no `.` or `..` resolution, and
 *   a backslash is an ordinary character. Repeats of one path share one entry.
 * - **The file name is always in the tail.** It is the last segment with a character in it, so a
 *   path ending in a separator keeps its final directory, separator included, as its name.
 *
 * ## Purity and cost
 *
 * Both functions are pure: they read no DOM, clock or randomness, never mutate their input and write
 * nothing to any console — a path is the developer's content (AAP 0.5.2). They hold no
 * project-specific literal (AAP 0.5.4). {@link describePaths} costs one pass over every suffix of
 * every distinct path, which suits the lists the view renders; callers compute it once per list
 * (`useMemo`), not once per row.
 *
 * @example
 * ```tsx
 * const displays = useMemo(() => describePaths(files.map((entry) => entry.file)), [files]);
 * // While rendering one row:
 * const { lead, context, name } = displays.get(entry.file) ?? describePath(entry.file);
 * ```
 *
 * @module apps/vscode-extension/src/webview/path-display
 */

/** The separator of the protocol's project-relative POSIX paths. */
const SEPARATOR = '/';

/**
 * One path split for display. Every member is a slice of the path, and
 * `lead + context + name` is the path exactly.
 */
export interface PathDisplay {
  /**
   * Everything before {@link PathDisplay.tail}: the leading directories no other path of the list
   * needs to be told apart. Empty when the whole path is needed. Ends in a separator otherwise.
   */
  readonly lead: string;

  /**
   * The shortest separator-aligned suffix that ends in the file name and that no other distinct
   * path of the list ends in; the whole path when every shorter suffix is shared. Always
   * {@link PathDisplay.context} followed by {@link PathDisplay.name}.
   */
  readonly tail: string;

  /** The tail's directories, each with its trailing separator; empty for a bare file name. */
  readonly context: string;

  /** The file name: the tail's final segment, never empty unless the path itself is. */
  readonly name: string;
}

/** A distinct path and the offsets its candidate tails start at. */
interface Anatomy {
  /** The path as received. */
  readonly path: string;

  /**
   * Where each suffix that can be a tail starts, outermost first: `0`, the whole path, then one
   * past every separator up to the start of the file name's segment, which is the last entry.
   * Never empty.
   */
  readonly suffixStarts: readonly number[];
}

/**
 * Finds the segment boundaries of one path.
 *
 * A suffix starting after the file name's segment — only a trailing separator can produce one —
 * holds no character of a name, so it is never a candidate tail and is left out.
 *
 * @param path The path as received.
 * @returns The path with the start offset of each candidate tail.
 */
function anatomyOf(path: string): Anatomy {
  const starts: number[] = [];
  // How many leading entries of `starts` reach the file name's segment: at least the whole path.
  let candidateCount = 1;
  let offset = 0;

  // `split` always yields at least one segment, the empty string included, so `starts` is never
  // empty and its first entry is 0.
  for (const segment of path.split(SEPARATOR)) {
    starts.push(offset);
    if (segment !== '') {
      candidateCount = starts.length;
    }
    offset += segment.length + SEPARATOR.length;
  }

  return { path, suffixStarts: starts.slice(0, candidateCount) };
}

/**
 * Splits one path at the shortest tail the list does not share.
 *
 * @param anatomy The path and its candidate tail starts.
 * @param isShared Whether another distinct path of the list ends in the given suffix.
 * @returns The path's four display parts.
 */
function splitPath(anatomy: Anatomy, isShared: (suffix: string) => boolean): PathDisplay {
  const { path, suffixStarts } = anatomy;
  const nameStart = suffixStarts.at(-1) ?? 0;

  // Innermost first — the file name alone, then one more directory at a time. The whole path,
  // start 0, is the fallback when every shorter suffix is shared, and needs no check of its own.
  const tailStart =
    suffixStarts
      .slice(1)
      .reverse()
      .find((start) => !isShared(path.slice(start))) ?? 0;

  return {
    lead: path.slice(0, tailStart),
    tail: path.slice(tailStart),
    context: path.slice(tailStart, nameStart),
    name: path.slice(nameStart),
  };
}

/**
 * Splits every distinct path of a list for display, so that each keeps its file name and no two
 * show the same tail.
 *
 * Uniqueness is decided within this list only: the same path may split differently in another list
 * that holds other files, which is intended — each list is told apart on its own.
 *
 * @param paths The list's paths, in any order, repeats allowed.
 * @returns One entry per distinct path, keyed by the path exactly as received, in first-occurrence
 *   order. Empty for an empty list.
 */
export function describePaths(paths: readonly string[]): ReadonlyMap<string, PathDisplay> {
  const anatomies = Array.from(new Set(paths), anatomyOf);

  // How many distinct paths end in each candidate suffix. Suffixes of different segment counts
  // differ in how many separators they hold, so one map covers every length without collision,
  // and a path never counts one suffix twice.
  const endings = new Map<string, number>();
  for (const { path, suffixStarts } of anatomies) {
    for (const start of suffixStarts) {
      const suffix = path.slice(start);
      endings.set(suffix, (endings.get(suffix) ?? 0) + 1);
    }
  }

  const isShared = (suffix: string): boolean => (endings.get(suffix) ?? 0) > 1;

  return new Map(anatomies.map((anatomy) => [anatomy.path, splitPath(anatomy, isShared)]));
}

/**
 * Splits one path as if it were alone in its list: the tail is the file name, and every directory
 * is lead.
 *
 * The fallback for a path a {@link describePaths} result does not hold — a renderer looking up a
 * path outside the list it described — so a row always renders, and renders its file name.
 *
 * @param path The path as received.
 * @returns The path's four display parts.
 */
export function describePath(path: string): PathDisplay {
  return splitPath(anatomyOf(path), () => false);
}
