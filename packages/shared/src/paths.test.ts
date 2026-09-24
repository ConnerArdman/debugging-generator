/**
 * Tests for `./paths.ts`: the lexical path primitives, and the containment gate
 * that keeps this product inside the project it was pointed at.
 *
 * Two different things are on trial here, and the second is the reason this file
 * is written as an attack table rather than a formatting check.
 *
 * The **primitives** — `toPosix`, `normalizePosix`, `isAbsolutePosix`,
 * `isWindowsAbsolute`, `joinPosix`, `relativePosix`, `dirnamePosix`,
 * `basenamePosix` and `extnamePosix` — are a reimplementation of behaviour most
 * readers expect from `node:path`, which the module deliberately does not
 * import (it is bundled into three browser surfaces, and `node:path` changes
 * answers with the host platform). A reimplementation earns an exhaustive
 * table: the three documented divergences from `path.posix` — a trailing
 * separator always stripped, `'.'` rather than `''` for two equal paths, and a
 * suffix never stripped down to nothing — are pinned below so that neither a
 * "fix" toward `node:path` nor a drift away from it can pass unnoticed.
 *
 * The **gate** — `isSafeRelativePath`, `isWithin`, `toProjectRelative` and
 * `resolveWithinProject` — is a security boundary with three independent
 * callers: the local service refusing a `source.open` request outside the
 * session's project root, the VS Code extension's URI handler validating a path
 * that *any* web page can supply, and the instrumentation patcher, which writes
 * into the developer's working tree. A hole in it is an arbitrary-file-read or
 * arbitrary-file-write hole. So every class of malformed input gets its own
 * named case, and the single most important assertion in the file is the
 * prefix-sibling one: `/proj-evil` is not inside `/proj`, which is exactly the
 * mistake a bare `startsWith(root)` makes.
 *
 * Four habits in here are deliberate.
 *
 * 1. **No filesystem, and no `node:path`.** The module under test uses neither,
 *    and this suite mirrors that: pure string inputs, no temporary directory, no
 *    `node:fs`, nothing imported but the three source modules and `vitest`. That
 *    is what lets a hundred adversarial strings run in milliseconds, and it
 *    keeps the suite honest about what the gate actually proves.
 *
 *    The requirement that habit forces into the open: **a path that is inside
 *    the project root as text, but whose interior component is a symbolic link
 *    resolving outside the root, must be rejected.** No string can reveal that,
 *    so the four lexical gate functions accept such a path by construction —
 *    which is why `resolveRealPathWithinProject` exists and why it takes its
 *    canonicaliser as an argument. The composition (lexical gate, canonicalise,
 *    check containment again) is the module's, and it is tested here against a
 *    table of links rather than a temporary directory; the *filesystem* half of
 *    the same claim — that `O_NOFOLLOW` reaches a path's final component only
 *    and an interior link is read straight through — is proven on a real
 *    filesystem in `src/node/safe-fs.test.ts`, in the
 *    `describe('a project-internal symbolic link whose target is outside the
 *    root')` block. Neither suite is sufficient alone: one proves the rule, the
 *    other proves the rule is needed.
 * 2. **Tables with labels, one case per test.** `it.each` over a labelled table
 *    names the offending input in the failure line, so a regression reads as
 *    "rejects a NUL byte" rather than "rejects malformed input" with an index.
 * 3. **The rejection tables are reused across functions.** The same table that
 *    proves `isSafeRelativePath` refuses an input is replayed against
 *    `resolveWithinProject` and `toProjectRelative`, because a predicate and the
 *    functions built on it disagreeing about the same string is how a caller
 *    ends up validating with one and resolving with the other.
 * 4. **Narrowing is exercised, not bypassed.** `isOk` and `isErr` from
 *    `./result.js` are what these tests use to reach `value` and `error`, so a
 *    guard that stopped narrowing fails `pnpm typecheck` inside this file rather
 *    than somewhere downstream.
 *
 * Every example path is generic on purpose (`/home/dev/project`,
 * `src/lib/thing.ts`): `scripts/check-no-hardcoding.mjs` exists to keep
 * knowledge of the demo application out of `packages/**`, and a test fixture is
 * no place to start.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError, type DebuggenErrorCode } from './errors.js';
import {
  basenamePosix,
  dirnamePosix,
  extnamePosix,
  isAbsolutePosix,
  isSafeRelativePath,
  isWindowsAbsolute,
  isWithin,
  joinPosix,
  normalizePosix,
  relativePosix,
  resolveRealPathWithinProject,
  resolveWithinProject,
  toPosix,
  toProjectRelative,
  type ProjectPathResolution,
  type RealPathResolver,
} from './paths.js';
import { isErr, isOk, type Result } from './result.js';

/*
 * ---------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------
 */

/**
 * The project root every containment test measures against.
 *
 * A generic three-segment absolute path, chosen so that the cases which matter
 * can all be derived from it: its parent (`/home/dev`) is outside, its
 * prefix sibling is one string concatenation away, and its own basename is what
 * the escape-and-re-enter case needs.
 */
const PROJECT_ROOT = '/home/dev/project';

/** A representative file inside that root, written the way the product stores it. */
const SAFE_RELATIVE = 'src/lib/thing.ts';

/**
 * The single code every refusal in `paths.ts` reports, whatever the reason.
 *
 * Typed as {@link DebuggenErrorCode} rather than left as a string literal, so a
 * code renamed in `errors.ts` fails this file at `pnpm typecheck` instead of at
 * run time.
 */
const CONTAINMENT_CODE: DebuggenErrorCode = 'PATH_OUTSIDE_PROJECT';

/**
 * A short root used for the prefix-sibling table.
 *
 * Deliberately short: the attack is a candidate whose first characters are the
 * root's, and `/proj` makes `/proj-evil`, `/projx`, `/proj2` and `/project`
 * read as what they are — four different directories that a prefix test would
 * wave through.
 */
const SHORT_ROOT = '/proj';

/*
 * ---------------------------------------------------------------------------
 * Fixture shapes
 * ---------------------------------------------------------------------------
 */

/** A one-argument case for a primitive that maps a path to a path. */
interface MappedCase {
  readonly label: string;
  readonly input: string;
  readonly expected: string;
}

/** A path with a name, so `it.each` can title itself. */
interface LabelledPath {
  readonly label: string;
  readonly path: string;
}

/** A path and what the two absoluteness predicates must say about it. */
interface AbsolutenessCase {
  readonly label: string;
  readonly path: string;
  readonly posixAbsolute: boolean;
  readonly windowsAbsolute: boolean;
}

/** A {@link joinPosix} call and its result. */
interface JoinCase {
  readonly label: string;
  readonly segments: readonly string[];
  readonly expected: string;
}

/** A {@link relativePosix} call and its result. */
interface RelativeCase {
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly expected: string;
}

/** A {@link basenamePosix} call that passes the optional suffix argument. */
interface SuffixCase {
  readonly label: string;
  readonly path: string;
  readonly ext: string;
  readonly expected: string;
}

/** A root/candidate pair for {@link isWithin}. */
interface ContainmentCase {
  readonly label: string;
  readonly root: string;
  readonly candidate: string;
}

/** A path the gate must refuse, with the diagnosis it must record. */
interface RefusalCase {
  readonly label: string;
  readonly path: string;
  readonly reason: string;
}

/** A path the gate must accept, with the value it must produce. */
interface AcceptedCase {
  readonly label: string;
  readonly path: string;
  readonly expected: string;
}

/*
 * ---------------------------------------------------------------------------
 * Tables: the lexical primitives
 * ---------------------------------------------------------------------------
 */

/**
 * Separator conversion, including the UNC case that gains rather than loses a
 * separator.
 *
 * `'\\\\server\\share'` becoming `'//server/share'` is not a curiosity: it is
 * why `isWindowsAbsolute` accepts both slash directions, and why the two
 * `Result`-returning functions refuse a two-separator prefix outright instead
 * of letting normalisation collapse it to one and make an off-volume path look
 * local.
 */
const TO_POSIX_CASES: readonly MappedCase[] = [
  { label: 'a Windows relative path', input: 'src\\lib\\thing.ts', expected: SAFE_RELATIVE },
  { label: 'mixed separators', input: 'src\\lib/thing.ts', expected: SAFE_RELATIVE },
  {
    label: 'a drive-letter path',
    input: 'C:\\Users\\dev\\project',
    expected: 'C:/Users/dev/project',
  },
  {
    label: 'a UNC path, which keeps both leading separators',
    input: '\\\\server\\share\\thing.ts',
    expected: '//server/share/thing.ts',
  },
  { label: 'a lone backslash', input: '\\', expected: '/' },
  { label: 'a path that is already POSIX', input: PROJECT_ROOT, expected: PROJECT_ROOT },
  { label: 'the empty string', input: '', expected: '' },
];

/**
 * Every normalisation rule the gate's correctness rests on.
 *
 * The four entries worth reading twice are the asymmetry between absolute and
 * relative `'..'` handling (`'/a/../..'` collapses to the root, `'a/../..'`
 * keeps a meaningful `'..'` because there is no base to resolve it against),
 * the trailing-separator rule that makes `'a/b'` and `'a/b/'` one identity
 * rather than two, and the whitespace-only input that survives untouched —
 * normalisation is not a validator, which is why `isSafeRelativePath` tests
 * emptiness on both the raw and the normalised form.
 */
const NORMALIZE_CASES: readonly MappedCase[] = [
  { label: 'collapses duplicate separators', input: 'a//b///c', expected: 'a/b/c' },
  { label: 'drops leading and interior dot segments', input: './a/./b', expected: 'a/b' },
  { label: 'resolves a dot-dot against the preceding segment', input: 'a/b/../c', expected: 'a/c' },
  {
    label: 'resolves a dot-dot inside an absolute path',
    input: '/home/dev/project/src/../src/lib/thing.ts',
    expected: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
  },
  { label: 'preserves a single leading separator', input: '/a/b', expected: '/a/b' },
  { label: 'treats the root as its own parent', input: '/..', expected: '/' },
  { label: 'cannot escape the root with repeated dot-dots', input: '/a/../..', expected: '/' },
  { label: 'preserves a leading dot-dot on a relative path', input: '../a', expected: '../a' },
  { label: 'preserves repeated leading dot-dots', input: '../../x', expected: '../../x' },
  { label: 'lets a relative path reduce to a bare dot-dot', input: 'a/../..', expected: '..' },
  { label: 'strips a trailing separator', input: '/a/', expected: '/a' },
  { label: 'keeps the root itself', input: '/', expected: '/' },
  { label: 'collapses a doubled leading separator', input: '//', expected: '/' },
  { label: 'turns the empty string into the current directory', input: '', expected: '.' },
  { label: 'turns a path that cancels itself into a dot', input: 'a/..', expected: '.' },
  { label: 'leaves a bare dot alone', input: '.', expected: '.' },
  { label: 'reduces a trailing-separator dot to a dot', input: './', expected: '.' },
  {
    label: 'leaves a whitespace-only path alone, being no validator',
    input: '  ',
    expected: '  ',
  },
];

/**
 * What the two absoluteness predicates must say about each rooted form.
 *
 * `isAbsolutePosix` answers one question — does the string begin with `/` — and
 * `isWindowsAbsolute` the other. The POSIX-form UNC row is the interesting one:
 * it is *both*, which is why refusing a two-separator prefix has to be an
 * explicit step in the gate rather than a consequence of either predicate.
 */
const ABSOLUTENESS_CASES: readonly AbsolutenessCase[] = [
  {
    label: 'a POSIX absolute path',
    path: PROJECT_ROOT,
    posixAbsolute: true,
    windowsAbsolute: false,
  },
  {
    label: 'a drive path with backslashes',
    path: 'C:\\dir',
    posixAbsolute: false,
    windowsAbsolute: true,
  },
  {
    label: 'a drive path with forward slashes',
    path: 'C:/dir',
    posixAbsolute: false,
    windowsAbsolute: true,
  },
  { label: 'a bare drive prefix', path: 'C:', posixAbsolute: false, windowsAbsolute: true },
  { label: 'a drive-relative path', path: 'C:dir', posixAbsolute: false, windowsAbsolute: true },
  {
    label: 'a UNC path with backslashes',
    path: '\\\\server\\share',
    posixAbsolute: false,
    windowsAbsolute: true,
  },
  {
    label: 'a UNC path in POSIX form',
    path: '//server/share',
    posixAbsolute: true,
    windowsAbsolute: true,
  },
  {
    label: 'a plain relative path',
    path: SAFE_RELATIVE,
    posixAbsolute: false,
    windowsAbsolute: false,
  },
  { label: 'the empty string', path: '', posixAbsolute: false, windowsAbsolute: false },
];

/**
 * The Windows-rooted forms whose detection must survive separator conversion.
 *
 * The gate converts separators *before* it validates, so a detector that only
 * recognised backslashes would lose the fact that the path was rooted at
 * exactly the moment it mattered.
 */
const WINDOWS_ROOTED_PATHS: readonly LabelledPath[] = [
  { label: 'a drive path', path: 'C:\\Users\\dev\\project' },
  { label: 'a drive path with a single segment', path: 'D:\\dir' },
  { label: 'a UNC path', path: '\\\\server\\share\\thing.ts' },
];

/** Joining rules, including the one that is emphatically not a containment check. */
const JOIN_CASES: readonly JoinCase[] = [
  {
    label: 'joins a root with nested segments',
    segments: [PROJECT_ROOT, 'src/lib', 'thing.ts'],
    expected: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
  },
  {
    label: 'ignores empty segments',
    segments: ['src', '', 'lib/thing.ts'],
    expected: SAFE_RELATIVE,
  },
  {
    label: 'keeps a relative first segment relative',
    segments: ['src', 'lib'],
    expected: 'src/lib',
  },
  { label: 'normalises the joined result', segments: ['a', '../b'], expected: 'b' },
  {
    label: 'strips trailing separators from its segments',
    segments: ['src/', 'lib/'],
    expected: 'src/lib',
  },
  {
    label: 'lets a later segment ascend out of an absolute first segment',
    segments: ['/root', '..', 'x'],
    expected: '/x',
  },
  { label: 'returns a dot for no segments', segments: [], expected: '.' },
  { label: 'returns a dot when every segment is empty', segments: ['', ''], expected: '.' },
];

/** Relative-path computation: descent, ascent, both at once, and equality. */
const RELATIVE_CASES: readonly RelativeCase[] = [
  {
    label: 'descends into a nested file',
    from: PROJECT_ROOT,
    to: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
    expected: SAFE_RELATIVE,
  },
  {
    label: 'crosses to a sibling directory',
    from: `${PROJECT_ROOT}/src`,
    to: `${PROJECT_ROOT}/docs`,
    expected: '../docs',
  },
  {
    label: 'ascends two levels',
    from: `${PROJECT_ROOT}/src/lib`,
    to: PROJECT_ROOT,
    expected: '../..',
  },
  {
    label: 'ascends and then descends',
    from: '/a/b/c',
    to: '/a/d/e',
    expected: '../../d/e',
  },
  { label: 'starts from the filesystem root', from: '/', to: '/home', expected: 'home' },
  {
    label: 'works between two relative paths',
    from: 'src',
    to: SAFE_RELATIVE,
    expected: 'lib/thing.ts',
  },
  { label: 'returns a dot for equal paths', from: PROJECT_ROOT, to: PROJECT_ROOT, expected: '.' },
  {
    label: 'returns a dot when only a trailing separator differs',
    from: PROJECT_ROOT,
    to: `${PROJECT_ROOT}/`,
    expected: '.',
  },
];

/** Directory extraction, including the two paths that are their own directory. */
const DIRNAME_CASES: readonly MappedCase[] = [
  {
    label: 'a nested file',
    input: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
    expected: `${PROJECT_ROOT}/src/lib`,
  },
  { label: 'a child of the filesystem root', input: '/thing.ts', expected: '/' },
  { label: 'the filesystem root itself', input: '/', expected: '/' },
  { label: 'a bare file name', input: 'thing.ts', expected: '.' },
  { label: 'a directory with a trailing separator', input: 'src/lib/', expected: 'src' },
  { label: 'the empty string', input: '', expected: '.' },
];

/** Final-component extraction without the optional suffix argument. */
const BASENAME_CASES: readonly MappedCase[] = [
  { label: 'a nested file', input: SAFE_RELATIVE, expected: 'thing.ts' },
  { label: 'a directory with a trailing separator', input: 'src/lib/', expected: 'lib' },
  { label: 'a bare file name', input: 'thing.ts', expected: 'thing.ts' },
  { label: 'the project root', input: PROJECT_ROOT, expected: 'project' },
  { label: 'the filesystem root, which has no final component', input: '/', expected: '' },
];

/**
 * Suffix stripping, including the case this module handles differently from
 * `node:path`.
 *
 * `basenamePosix('.ts', '.ts')` returns `'.ts'`, where `path.posix.basename`
 * returns `''`. A file name is never legitimately empty, and an empty name
 * travelling onward as an identity — a key in the session store, a chip in a
 * panel — is worse than a name that kept its suffix.
 */
const SUFFIX_CASES: readonly SuffixCase[] = [
  { label: 'strips a matching suffix', path: SAFE_RELATIVE, ext: '.ts', expected: 'thing' },
  {
    label: 'strips a multi-part suffix',
    path: 'thing.test.ts',
    ext: '.test.ts',
    expected: 'thing',
  },
  {
    label: 'leaves a name that does not end with the suffix',
    path: SAFE_RELATIVE,
    ext: '.tsx',
    expected: 'thing.ts',
  },
  {
    label: 'never strips a name down to nothing',
    path: '.ts',
    ext: '.ts',
    expected: '.ts',
  },
  {
    label: 'never strips a nested name down to nothing',
    path: 'src/lib/.ts',
    ext: '.ts',
    expected: '.ts',
  },
  { label: 'ignores an empty suffix', path: 'thing.ts', ext: '', expected: 'thing.ts' },
];

/** Extension extraction, dotfiles and navigation components included. */
const EXTNAME_CASES: readonly MappedCase[] = [
  { label: 'a normal extension', input: 'thing.ts', expected: '.ts' },
  { label: 'a nested file', input: SAFE_RELATIVE, expected: '.ts' },
  { label: 'a double extension, taking only the last', input: 'thing.test.ts', expected: '.ts' },
  { label: 'a name with no extension', input: 'thing', expected: '' },
  { label: 'a dotfile with no further dot', input: '.gitignore', expected: '' },
  { label: 'a name ending in a dot', input: 'thing.', expected: '.' },
  { label: 'the current-directory component', input: '.', expected: '' },
  { label: 'the parent-directory component', input: '..', expected: '' },
  { label: 'the filesystem root', input: '/', expected: '' },
];

/*
 * ---------------------------------------------------------------------------
 * Tables: the rejection classes
 *
 * Each table is one class of malformed input. They are declared separately, and
 * replayed against `isSafeRelativePath`, `resolveWithinProject` and
 * `toProjectRelative` further down, so the predicate and the two functions built
 * on it can never be caught disagreeing about the same string.
 * ---------------------------------------------------------------------------
 */

/**
 * Nothing, or nothing but whitespace — before or after normalisation.
 *
 * The last entry is the one that earns its place: `'a/../ '` normalises to
 * `' '`, so a predicate that tested emptiness only on the raw string would
 * accept it while the functions that normalise would then treat it as a real
 * path.
 */
const EMPTY_PATHS: readonly LabelledPath[] = [
  { label: 'the empty string', path: '' },
  { label: 'a single space', path: ' ' },
  { label: 'a tab and a newline', path: '\t\n' },
  { label: 'a path that normalises to whitespace only', path: 'a/../ ' },
];

/**
 * Rooted paths of every flavour, which a project-relative path is not.
 *
 * The drive-relative entry (`'C:dir/x.ts'`, which Windows resolves against that
 * drive's own current directory) is refused with the rest: it is not absolute in
 * the POSIX sense, and treating it as a file named `C:dir` would be worse than
 * refusing it. The second entry is a path *inside* the project root, refused
 * because it is absolute — `isSafeRelativePath` and `resolveWithinProject`
 * validate, while `toProjectRelative` converts, and that difference is asserted
 * explicitly further down.
 */
const ROOTED_PATHS: readonly LabelledPath[] = [
  { label: 'a POSIX absolute path', path: '/etc/hosts' },
  {
    label: 'a POSIX absolute path inside the project root',
    path: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
  },
  { label: 'a drive-letter path with backslashes', path: 'C:\\Windows\\x.ts' },
  { label: 'a drive-letter path with forward slashes', path: 'C:/Windows/x.ts' },
  { label: 'a bare drive prefix', path: 'C:' },
  { label: 'a drive-relative path', path: 'C:dir/x.ts' },
  { label: 'a UNC path with backslashes', path: '\\\\server\\share\\x.ts' },
  { label: 'a UNC path in POSIX form', path: '//server/share/x.ts' },
];

/** Traversal, in every position it can occupy. */
const TRAVERSAL_PATHS: readonly LabelledPath[] = [
  { label: 'a leading dot-dot', path: '../secret.ts' },
  { label: 'repeated leading dot-dots', path: '../../secret.ts' },
  { label: 'a dot-dot in the middle that escapes', path: 'src/../../secret.ts' },
  { label: 'a bare dot-dot', path: '..' },
  { label: 'a path that reduces to a bare dot-dot', path: 'src/../..' },
  {
    label: 'a traversal that escapes and re-enters a directory of the same name',
    path: `../${basenamePosix(PROJECT_ROOT)}/x.ts`,
  },
];

/**
 * Control characters, which are not cosmetic problems.
 *
 * NUL terminates a path early in C string APIs, so `'src/a\u0000.ts'` can open
 * `'src/a'` — a validated path and an opened path that are not the same path.
 * ESC begins a terminal escape sequence, which is how a path echoed into a log
 * line rewrites the rest of the line. Both the C0 block (through U+001F) and
 * DELETE with the C1 block (U+007F–U+009F) are refused.
 */
const CONTROL_CHARACTER_PATHS: readonly LabelledPath[] = [
  { label: 'a NUL byte', path: 'src/a\u0000.ts' },
  { label: 'a C0 control character (U+0001)', path: 'src/a\u0001.ts' },
  { label: 'an escape character (U+001B)', path: 'src/a\u001b.ts' },
  { label: 'a newline', path: 'src/a\n.ts' },
  { label: 'a DELETE character (U+007F)', path: 'src/a\u007f.ts' },
  { label: 'a C1 control character (U+0085)', path: 'src/a\u0085.ts' },
  { label: 'the last C1 control character (U+009F)', path: 'src/a\u009f.ts' },
  { label: 'a control character in the leading position', path: `\u0000${SAFE_RELATIVE}` },
];

/**
 * Backslashes, refused by the predicate rather than converted.
 *
 * `'..\\..\\secret.ts'` is one innocent-looking segment to a `'..'` check and a
 * traversal to any Windows API that later resolves it, so a path being
 * *validated* must arrive with its separators already converted. Conversion is
 * `toProjectRelative`'s job, and that difference between the two entry points is
 * asserted explicitly further down.
 */
const BACKSLASH_PATHS: readonly LabelledPath[] = [
  { label: 'a Windows-style relative path', path: 'src\\lib\\thing.ts' },
  { label: 'a backslash traversal', path: '..\\..\\secret.ts' },
  { label: 'a single backslash inside a name', path: 'src/a\\b.ts' },
];

/** Everything the predicate must refuse, in one list, for the cross-function replays. */
const UNSAFE_PATHS: readonly LabelledPath[] = [
  ...EMPTY_PATHS,
  ...ROOTED_PATHS,
  ...TRAVERSAL_PATHS,
  ...CONTROL_CHARACTER_PATHS,
  ...BACKSLASH_PATHS,
];

/**
 * Paths the predicate must accept, each with its normalised form.
 *
 * A file name is text: a non-ASCII name is a name, and the predicate has no
 * opinion about the alphabet it is written in. The interior-traversal entries
 * are accepted precisely because normalisation has already removed the `'..'` —
 * the check is about where a path ends up, not about which characters it used
 * to get there.
 */
const SAFE_PATHS: readonly AcceptedCase[] = [
  { label: 'a simple relative file', path: 'thing.ts', expected: 'thing.ts' },
  { label: 'a nested path', path: SAFE_RELATIVE, expected: SAFE_RELATIVE },
  {
    label: 'a file name containing dots',
    path: 'src/lib/thing.test.ts',
    expected: 'src/lib/thing.test.ts',
  },
  { label: 'a dotfile', path: 'src/lib/.keep', expected: 'src/lib/.keep' },
  {
    label: 'a non-ASCII file name',
    path: 'src/lib/naïve-ファイル.ts',
    expected: 'src/lib/naïve-ファイル.ts',
  },
  {
    label: 'a file name containing a space',
    path: 'src/lib/my thing.ts',
    expected: 'src/lib/my thing.ts',
  },
  { label: 'the project root itself', path: '.', expected: '.' },
  { label: 'a leading dot segment', path: `./${SAFE_RELATIVE}`, expected: SAFE_RELATIVE },
  { label: 'a directory with a trailing separator', path: 'src/lib/', expected: 'src/lib' },
  { label: 'duplicate separators', path: 'src//lib//thing.ts', expected: SAFE_RELATIVE },
  {
    label: 'an interior traversal that resolves back inside',
    path: 'src/../src/lib/thing.ts',
    expected: SAFE_RELATIVE,
  },
  { label: 'a trailing traversal that stays inside', path: 'src/lib/..', expected: 'src' },
];

/*
 * ---------------------------------------------------------------------------
 * Tables: containment
 * ---------------------------------------------------------------------------
 */

/** Pairs where the candidate is the root or lies beneath it. */
const CONTAINED_CASES: readonly ContainmentCase[] = [
  { label: 'a root is within itself', root: PROJECT_ROOT, candidate: PROJECT_ROOT },
  {
    label: 'a direct child',
    root: PROJECT_ROOT,
    candidate: `${PROJECT_ROOT}/src`,
  },
  {
    label: 'a deep descendant',
    root: PROJECT_ROOT,
    candidate: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
  },
  {
    label: 'a root that already ends with a separator',
    root: `${PROJECT_ROOT}/`,
    candidate: `${PROJECT_ROOT}/src`,
  },
  {
    label: 'a root with a separator and a candidate that is the root',
    root: `${PROJECT_ROOT}/`,
    candidate: PROJECT_ROOT,
  },
  {
    label: 'a candidate that ends with a separator',
    root: PROJECT_ROOT,
    candidate: `${PROJECT_ROOT}/src/`,
  },
  { label: 'the filesystem root containing anything', root: '/', candidate: '/anything' },
  { label: 'the filesystem root containing itself', root: '/', candidate: '/' },
  {
    label: 'duplicate separators on both sides',
    root: '/home//dev/project',
    candidate: '/home/dev//project//src/lib/thing.ts',
  },
  {
    label: 'dot segments on both sides',
    root: '/home/./dev/project',
    candidate: `${PROJECT_ROOT}/./src/lib/thing.ts`,
  },
  {
    label: 'an interior traversal that resolves back inside',
    root: PROJECT_ROOT,
    candidate: `${PROJECT_ROOT}/src/../src/lib/thing.ts`,
  },
  {
    label: 'a traversal in the root that resolves to the root',
    root: `${PROJECT_ROOT}/src/..`,
    candidate: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
  },
  {
    label: 'Windows separators on both sides',
    root: 'C:\\project',
    candidate: 'C:\\project\\src\\thing.ts',
  },
];

/**
 * The prefix-sibling table: candidates whose first characters are the root's and
 * which are nonetheless somewhere else entirely.
 *
 * This is the mistake a bare `startsWith(root)` makes, and it is the single most
 * important thing this file asserts. `/proj-evil` is not inside `/proj`; neither
 * are `/projx`, `/proj2`, `/project` or `/proj.bak`. Each one is a directory an
 * attacker can create next to the project the developer pointed the tool at.
 */
const PREFIX_SIBLING_CASES: readonly ContainmentCase[] = [
  { label: 'a hyphenated sibling', root: SHORT_ROOT, candidate: '/proj-evil/secret.ts' },
  { label: 'a hyphenated sibling directory itself', root: SHORT_ROOT, candidate: '/proj-evil' },
  { label: 'a sibling with one extra letter', root: SHORT_ROOT, candidate: '/projx/secret.ts' },
  { label: 'a sibling with one extra digit', root: SHORT_ROOT, candidate: '/proj2' },
  { label: 'a longer sibling name', root: SHORT_ROOT, candidate: '/project/secret.ts' },
  { label: 'a dotted sibling', root: SHORT_ROOT, candidate: '/proj.bak/secret.ts' },
  {
    label: 'a hyphenated sibling of the full project root',
    root: PROJECT_ROOT,
    candidate: `${PROJECT_ROOT}-evil/secret.ts`,
  },
  {
    label: 'a suffixed sibling of the full project root',
    root: PROJECT_ROOT,
    candidate: `${PROJECT_ROOT}2/secret.ts`,
  },
];

/** Pairs where the candidate is genuinely elsewhere. */
const NOT_CONTAINED_CASES: readonly ContainmentCase[] = [
  { label: 'an unrelated absolute path', root: PROJECT_ROOT, candidate: '/etc/hosts' },
  { label: 'the parent of the root', root: PROJECT_ROOT, candidate: '/home/dev' },
  { label: 'a sibling directory', root: PROJECT_ROOT, candidate: '/home/dev/other/x.ts' },
  {
    label: 'an interior traversal that escapes the root',
    root: PROJECT_ROOT,
    candidate: `${PROJECT_ROOT}/../other/x.ts`,
  },
  {
    label: 'a traversal that escapes into a prefix sibling',
    root: PROJECT_ROOT,
    candidate: `${PROJECT_ROOT}/../${basenamePosix(PROJECT_ROOT)}-evil/x.ts`,
  },
  {
    label: 'a relative candidate against an absolute root',
    root: PROJECT_ROOT,
    candidate: SAFE_RELATIVE,
  },
  {
    label: 'an absolute candidate against a relative root',
    root: 'project',
    candidate: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
  },
  { label: 'a different drive', root: 'C:/project', candidate: 'D:/project/x.ts' },
];

/*
 * ---------------------------------------------------------------------------
 * Tables: the two `Result`-returning entry points
 * ---------------------------------------------------------------------------
 */

/**
 * Paths `toProjectRelative` must refuse, each with the diagnosis it records in
 * `details.reason`.
 *
 * This table is separate from the class tables above because the routing
 * differs: `toProjectRelative` is the product's *converter*, so an absolute path
 * takes the containment route (`outside-project-root`), a two-separator prefix
 * is refused before normalisation can collapse it (`network-share-path`), and
 * only a relative path reaches `isSafeRelativePath`
 * (`unsafe-relative-path`). Asserting the reason — not merely the failure —
 * is what proves the path took the route it was supposed to take.
 */
const TO_PROJECT_RELATIVE_REFUSALS: readonly RefusalCase[] = [
  { label: 'an unrelated absolute path', path: '/etc/hosts', reason: 'outside-project-root' },
  { label: 'the parent of the project root', path: '/home/dev', reason: 'outside-project-root' },
  {
    label: 'a prefix sibling of the project root',
    path: `${PROJECT_ROOT}-evil/secret.ts`,
    reason: 'outside-project-root',
  },
  {
    label: 'a drive-letter path with forward slashes',
    path: 'C:/Windows/x.ts',
    reason: 'outside-project-root',
  },
  {
    label: 'a drive-letter path with backslashes',
    path: 'C:\\Windows\\x.ts',
    reason: 'outside-project-root',
  },
  { label: 'a bare drive prefix', path: 'C:', reason: 'outside-project-root' },
  { label: 'a drive-relative path', path: 'C:dir/x.ts', reason: 'outside-project-root' },
  {
    label: 'an absolute path that traverses out of the root',
    path: `${PROJECT_ROOT}/../other/x.ts`,
    reason: 'outside-project-root',
  },
  {
    label: 'a UNC path in POSIX form',
    path: '//server/share/x.ts',
    reason: 'network-share-path',
  },
  {
    label: 'a UNC path with backslashes',
    path: '\\\\server\\share\\x.ts',
    reason: 'network-share-path',
  },
  { label: 'a leading traversal', path: '../secret.ts', reason: 'unsafe-relative-path' },
  {
    label: 'a traversal in the middle',
    path: 'src/../../secret.ts',
    reason: 'unsafe-relative-path',
  },
  { label: 'a bare dot-dot', path: '..', reason: 'unsafe-relative-path' },
  {
    label: 'a backslash traversal, converted and then caught',
    path: '..\\..\\secret.ts',
    reason: 'unsafe-relative-path',
  },
  {
    label: 'a traversal that escapes and re-enters a directory of the same name',
    path: `../${basenamePosix(PROJECT_ROOT)}/x.ts`,
    reason: 'unsafe-relative-path',
  },
  { label: 'the empty string', path: '', reason: 'unsafe-relative-path' },
  { label: 'a whitespace-only path', path: ' ', reason: 'unsafe-relative-path' },
  { label: 'a NUL byte', path: 'src/a\u0000.ts', reason: 'unsafe-relative-path' },
  {
    label: 'an escape character',
    path: 'src/a\u001b.ts',
    reason: 'unsafe-relative-path',
  },
];

/** Absolute and relative inputs `toProjectRelative` must reduce, with the results. */
const TO_PROJECT_RELATIVE_ACCEPTED: readonly AcceptedCase[] = [
  {
    label: 'an absolute path inside the root',
    path: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
    expected: SAFE_RELATIVE,
  },
  { label: 'the project root itself', path: PROJECT_ROOT, expected: '.' },
  { label: 'the project root with a trailing separator', path: `${PROJECT_ROOT}/`, expected: '.' },
  {
    label: 'an absolute path needing normalisation',
    path: `${PROJECT_ROOT}//src//./lib/../lib/thing.ts`,
    expected: SAFE_RELATIVE,
  },
  { label: 'an already-relative path', path: SAFE_RELATIVE, expected: SAFE_RELATIVE },
  {
    label: 'a relative path with a leading dot segment',
    path: `./${SAFE_RELATIVE}`,
    expected: SAFE_RELATIVE,
  },
  {
    label: 'a relative directory with a trailing separator',
    path: 'src/lib/',
    expected: 'src/lib',
  },
  { label: 'the current directory', path: '.', expected: '.' },
  {
    label: 'an interior traversal that resolves back inside',
    path: 'src/../src/lib/thing.ts',
    expected: SAFE_RELATIVE,
  },
  {
    label: 'a Windows-style relative path, which the converter converts',
    path: 'src\\lib\\thing.ts',
    expected: SAFE_RELATIVE,
  },
];

/** Project-relative inputs `resolveWithinProject` must resolve, with the results. */
const RESOLVE_ACCEPTED: readonly AcceptedCase[] = [
  {
    label: 'a nested file',
    path: SAFE_RELATIVE,
    expected: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
  },
  { label: 'the current directory', path: '.', expected: PROJECT_ROOT },
  {
    label: 'a leading dot segment',
    path: `./${SAFE_RELATIVE}`,
    expected: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
  },
  {
    label: 'a directory with a trailing separator',
    path: 'src/lib/',
    expected: `${PROJECT_ROOT}/src/lib`,
  },
  {
    label: 'an interior traversal that resolves back inside',
    path: 'src/../src/lib/thing.ts',
    expected: `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
  },
  {
    label: 'a trailing traversal that stays inside',
    path: 'src/lib/..',
    expected: `${PROJECT_ROOT}/src`,
  },
  {
    label: 'a non-ASCII file name',
    path: 'src/lib/naïve-ファイル.ts',
    expected: `${PROJECT_ROOT}/src/lib/naïve-ファイル.ts`,
  },
];

/*
 * ---------------------------------------------------------------------------
 * Narrowing helpers
 *
 * Both go through the `isOk` / `isErr` guards rather than reading `.ok`
 * directly, so a guard that stopped narrowing fails `pnpm typecheck` in this
 * file. They throw rather than assert, because the throw carries the other
 * branch's content into the failure message — "expected Ok, received
 * PATH_OUTSIDE_PROJECT: ..." says more than a boolean that was false.
 * ---------------------------------------------------------------------------
 */

/** The value of a successful result, or a failed test naming the error. */
function okValue(result: Result<string>): string {
  if (isErr(result)) {
    throw new Error(`Expected Ok, received Err ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** The error of a failed result, or a failed test naming the value. */
function errorOf(result: Result<string>): DebuggenError {
  if (isOk(result)) {
    throw new Error(`Expected Err, received Ok('${result.value}')`);
  }
  return result.error;
}

/** The `details.reason` a refusal recorded, read defensively since `details` is untyped. */
function reasonOf(error: DebuggenError): unknown {
  return error.details?.reason;
}

/*
 * ---------------------------------------------------------------------------
 * toPosix
 * ---------------------------------------------------------------------------
 */

describe('toPosix', () => {
  it.each(TO_POSIX_CASES)('converts $label', ({ input, expected }: MappedCase) => {
    expect(toPosix(input)).toBe(expected);
  });

  it('leaves no backslash behind, whatever it was handed', () => {
    for (const { input } of TO_POSIX_CASES) {
      expect(toPosix(input)).not.toContain('\\');
    }
  });

  it('converts separators and nothing else', () => {
    // No normalisation, no validation, no case folding: it must be safe to run
    // on a path that has not been checked yet, which is every path arriving
    // from a URI, a stack frame or a developer's keyboard.
    expect(toPosix('./a//b/../c/')).toBe('./a//b/../c/');
    expect(toPosix('../SECRET.ts')).toBe('../SECRET.ts');
  });

  it('is idempotent', () => {
    for (const { input } of TO_POSIX_CASES) {
      const once = toPosix(input);

      expect(toPosix(once)).toBe(once);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * normalizePosix
 * ---------------------------------------------------------------------------
 */

describe('normalizePosix', () => {
  it.each(NORMALIZE_CASES)('$label', ({ input, expected }: MappedCase) => {
    expect(normalizePosix(input)).toBe(expected);
  });

  it('never returns the empty string', () => {
    // The empty string is not a usable path, and a caller that received one
    // would build an absolute path out of it by accident.
    for (const { input } of NORMALIZE_CASES) {
      expect(normalizePosix(input).length).toBeGreaterThan(0);
    }
  });

  it('is idempotent', () => {
    for (const { input } of NORMALIZE_CASES) {
      const once = normalizePosix(input);

      expect(normalizePosix(once)).toBe(once);
    }
  });

  it('keeps an absolute path absolute and a relative path relative', () => {
    for (const { input } of NORMALIZE_CASES) {
      if (input.startsWith('/')) {
        expect(isAbsolutePosix(normalizePosix(input))).toBe(true);
      } else {
        expect(isAbsolutePosix(normalizePosix(input))).toBe(false);
      }
    }
  });

  it('strips a trailing separator everywhere except the root', () => {
    // A path is an identity — a row in the session store, a key in a panel, a
    // value in a prompt — so 'src/lib' and 'src/lib/' must not be two of them.
    expect(normalizePosix('src/lib/')).toBe('src/lib');
    expect(normalizePosix(`${PROJECT_ROOT}/`)).toBe(PROJECT_ROOT);
    expect(normalizePosix('/')).toBe('/');
  });
});

/*
 * ---------------------------------------------------------------------------
 * isAbsolutePosix and isWindowsAbsolute
 * ---------------------------------------------------------------------------
 */

describe('isAbsolutePosix', () => {
  it.each(ABSOLUTENESS_CASES)('answers for $label', ({ path, posixAbsolute }: AbsolutenessCase) => {
    expect(isAbsolutePosix(path)).toBe(posixAbsolute);
  });

  it('does not convert separators before answering', () => {
    // A backslash path is not POSIX-absolute to this predicate. Callers that
    // mean to ask about the converted form run `toPosix` first, which is what
    // the gate does.
    expect(isAbsolutePosix('\\dir')).toBe(false);
    expect(isAbsolutePosix(toPosix('\\dir'))).toBe(true);
  });
});

describe('isWindowsAbsolute', () => {
  it.each(ABSOLUTENESS_CASES)(
    'answers for $label',
    ({ path, windowsAbsolute }: AbsolutenessCase) => {
      expect(isWindowsAbsolute(path)).toBe(windowsAbsolute);
    },
  );

  it.each(WINDOWS_ROOTED_PATHS)(
    'detects $label both raw and converted to forward slashes',
    ({ path }: LabelledPath) => {
      // Required of this predicate: the gate converts separators before it
      // validates, so a detector blind to forward slashes would lose the fact
      // that the path was rooted at exactly the moment it matters.
      expect(isWindowsAbsolute(path)).toBe(true);
      expect(isWindowsAbsolute(toPosix(path))).toBe(true);
    },
  );

  it('accepts a lowercase drive letter as readily as an uppercase one', () => {
    expect(isWindowsAbsolute('c:/dir')).toBe(true);
    expect(isWindowsAbsolute('Z:\\dir')).toBe(true);
  });

  it('is not fooled by a colon that is not a drive prefix', () => {
    expect(isWindowsAbsolute('src/lib/thing:ts')).toBe(false);
    expect(isWindowsAbsolute('ab:/dir')).toBe(false);
    expect(isWindowsAbsolute('1:/dir')).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * joinPosix
 * ---------------------------------------------------------------------------
 */

describe('joinPosix', () => {
  it.each(JOIN_CASES)('$label', ({ segments, expected }: JoinCase) => {
    expect(joinPosix(...segments)).toBe(expected);
  });

  it('is not a containment check', () => {
    // Documented and load-bearing: joining an untrusted segment onto a trusted
    // root can leave the root, which is why `resolveWithinProject` validates
    // the segment first and re-checks the joined result.
    expect(joinPosix(PROJECT_ROOT, '../../etc/hosts')).toBe('/home/etc/hosts');
    expect(joinPosix(PROJECT_ROOT, '../../../../etc')).toBe('/etc');
  });
});

/*
 * ---------------------------------------------------------------------------
 * relativePosix
 * ---------------------------------------------------------------------------
 */

describe('relativePosix', () => {
  it.each(RELATIVE_CASES)('$label', ({ from, to, expected }: RelativeCase) => {
    expect(relativePosix(from, to)).toBe(expected);
  });

  it('returns a dot rather than the empty string for equal paths', () => {
    // The documented divergence from `path.posix.relative`, which returns ''.
    // A caller that forgot to special-case the empty string would build a path
    // out of it.
    expect(relativePosix(PROJECT_ROOT, PROJECT_ROOT)).toBe('.');
    expect(relativePosix('/', '/')).toBe('.');
    expect(relativePosix('.', '.')).toBe('.');
  });

  it('round-trips with joinPosix for a descendant', () => {
    const absolute = `${PROJECT_ROOT}/${SAFE_RELATIVE}`;

    expect(joinPosix(PROJECT_ROOT, relativePosix(PROJECT_ROOT, absolute))).toBe(absolute);
  });
});

/*
 * ---------------------------------------------------------------------------
 * dirnamePosix, basenamePosix and extnamePosix
 * ---------------------------------------------------------------------------
 */

describe('dirnamePosix', () => {
  it.each(DIRNAME_CASES)('handles $label', ({ input, expected }: MappedCase) => {
    expect(dirnamePosix(input)).toBe(expected);
  });

  it('ignores a trailing separator, having normalised first', () => {
    expect(dirnamePosix('src/lib/')).toBe(dirnamePosix('src/lib'));
  });
});

describe('basenamePosix', () => {
  it.each(BASENAME_CASES)('handles $label', ({ input, expected }: MappedCase) => {
    expect(basenamePosix(input)).toBe(expected);
  });

  it.each(SUFFIX_CASES)('$label', ({ path, ext, expected }: SuffixCase) => {
    expect(basenamePosix(path, ext)).toBe(expected);
  });

  it('keeps the whole name when the suffix is the entire name, unlike path.posix.basename', () => {
    // The documented divergence from `path.posix.basename('.ts', '.ts')`, which
    // returns ''. A file name is never legitimately empty, and an empty one
    // travelling onward as an identity is worse than a name that kept its
    // suffix.
    expect(basenamePosix('.ts', '.ts')).toBe('.ts');
    expect(basenamePosix('thing.ts', 'thing.ts')).toBe('thing.ts');
  });
});

describe('extnamePosix', () => {
  it.each(EXTNAME_CASES)('handles $label', ({ input, expected }: MappedCase) => {
    expect(extnamePosix(input)).toBe(expected);
  });

  it('agrees with basenamePosix about what the suffix is', () => {
    const base = basenamePosix(SAFE_RELATIVE);
    const ext = extnamePosix(SAFE_RELATIVE);

    expect(base.endsWith(ext)).toBe(true);
    expect(basenamePosix(SAFE_RELATIVE, ext)).toBe('thing');
  });
});

/*
 * ---------------------------------------------------------------------------
 * isSafeRelativePath — the rejection table
 *
 * One test per case, named by the case, so a regression reads as "rejects a NUL
 * byte" rather than "rejects malformed input" with an index to look up.
 * ---------------------------------------------------------------------------
 */

describe('isSafeRelativePath', () => {
  describe('rejects', () => {
    it.each(EMPTY_PATHS)('$label', ({ path }: LabelledPath) => {
      expect(isSafeRelativePath(path)).toBe(false);
    });

    it.each(ROOTED_PATHS)('$label', ({ path }: LabelledPath) => {
      expect(isSafeRelativePath(path)).toBe(false);
    });

    it.each(TRAVERSAL_PATHS)('$label', ({ path }: LabelledPath) => {
      expect(isSafeRelativePath(path)).toBe(false);
    });

    it.each(CONTROL_CHARACTER_PATHS)('$label', ({ path }: LabelledPath) => {
      expect(isSafeRelativePath(path)).toBe(false);
    });

    it.each(BACKSLASH_PATHS)('$label', ({ path }: LabelledPath) => {
      expect(isSafeRelativePath(path)).toBe(false);
    });
  });

  describe('accepts', () => {
    it.each(SAFE_PATHS)('$label', ({ path }: LabelledPath) => {
      expect(isSafeRelativePath(path)).toBe(true);
    });

    it.each(SAFE_PATHS)('$label after normalisation too', ({ path }: LabelledPath) => {
      // The predicate and normalisation must not disagree: everything the
      // predicate accepts has a normalised form it also accepts, which is what
      // lets the two functions below normalise after validating.
      expect(isSafeRelativePath(normalizePosix(path))).toBe(true);
    });
  });

  it('judges emptiness on the normalised form as well as the raw one', () => {
    // Without the second check the predicate would refuse ' ' and accept
    // 'a/../ ', which normalises to it — and the two functions below, which
    // normalise, would then disagree with the predicate about the same path.
    expect(isSafeRelativePath(' ')).toBe(false);
    expect(isSafeRelativePath('a/../ ')).toBe(false);
    expect(normalizePosix('a/../ ')).toBe(' ');
  });

  it('accepts a traversal that cancels itself and refuses one that does not', () => {
    // The pair that states the rule: the check is about where a path ends up,
    // not which characters it used on the way. Both inputs contain '..'.
    expect(isSafeRelativePath('src/../src/lib/thing.ts')).toBe(true);
    expect(isSafeRelativePath('src/../../src/lib/thing.ts')).toBe(false);
  });

  it('refuses every control code point in the two blocks it names', () => {
    // The tables above sample the blocks; this sweeps them, so a range
    // boundary that moved by one (0x1f, 0x7f, 0x9f) cannot slip through
    // between samples.
    for (const code of [0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f]) {
      expect(isSafeRelativePath(`src/a${String.fromCharCode(code)}.ts`)).toBe(false);
    }
  });

  it('accepts the code points just outside those blocks', () => {
    // The complement of the sweep: a predicate that over-reached would start
    // refusing ordinary names, and a path being refused is a feature the
    // developer cannot use rather than a hole — but it is still a bug.
    for (const code of [0x20, 0x21, 0x7e, 0xa0, 0xa1]) {
      expect(isSafeRelativePath(`src/a${String.fromCharCode(code)}b.ts`)).toBe(true);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * isWithin — the prefix-sibling case above all
 * ---------------------------------------------------------------------------
 */

describe('isWithin', () => {
  it.each(CONTAINED_CASES)('contains $label', ({ root, candidate }: ContainmentCase) => {
    expect(isWithin(root, candidate)).toBe(true);
  });

  it.each(PREFIX_SIBLING_CASES)('rejects $label', ({ root, candidate }: ContainmentCase) => {
    // THE case this function exists for. Each candidate below is a genuine
    // string prefix match — asserted on the next line, so this test cannot
    // pass by accident on a candidate that was never a prefix in the first
    // place — and each is a different directory, which an attacker can create
    // next to the project the developer pointed the tool at.
    expect(candidate.startsWith(root)).toBe(true);
    expect(isWithin(root, candidate)).toBe(false);
  });

  it.each(NOT_CONTAINED_CASES)('rejects $label', ({ root, candidate }: ContainmentCase) => {
    expect(isWithin(root, candidate)).toBe(false);
  });

  it('treats a root that already ends with a separator without doubling it', () => {
    expect(isWithin(`${PROJECT_ROOT}/`, `${PROJECT_ROOT}/src`)).toBe(true);
    expect(isWithin(`${PROJECT_ROOT}//`, `${PROJECT_ROOT}/src`)).toBe(true);
    // The negative half of the same question: a doubled separator in the
    // computed prefix would make every candidate fail instead.
    expect(isWithin(`${PROJECT_ROOT}/`, `${PROJECT_ROOT}-evil/src`)).toBe(false);
  });

  it('treats the filesystem root as containing everything but stays exact about it', () => {
    expect(isWithin('/', '/')).toBe(true);
    expect(isWithin('/', '/anything')).toBe(true);
    expect(isWithin('/', `${PROJECT_ROOT}/${SAFE_RELATIVE}`)).toBe(true);
    // A relative candidate is not below the filesystem root: it is not rooted
    // at all, and answering otherwise would make the root a wildcard.
    expect(isWithin('/', SAFE_RELATIVE)).toBe(false);
  });

  it('normalises both sides before comparing', () => {
    expect(isWithin('/home//dev/./project', `${PROJECT_ROOT}/src/lib/../lib/thing.ts`)).toBe(true);
    expect(isWithin(`${PROJECT_ROOT}/src/..`, `${PROJECT_ROOT}/src`)).toBe(true);
  });

  it('returns false for an interior traversal that resolves outside', () => {
    // Normalisation is what exposes this: before it, the candidate looks as
    // though it starts inside the root.
    expect(isWithin(PROJECT_ROOT, `${PROJECT_ROOT}/../other/x.ts`)).toBe(false);
    expect(isWithin(PROJECT_ROOT, `${PROJECT_ROOT}/src/../../../etc/hosts`)).toBe(false);
  });

  it('is case-sensitive, which is the fail-closed direction', () => {
    // Intended byte-wise behaviour, not an oversight. A case-insensitive
    // filesystem (macOS by default, Windows) will happily open '/Proj/src'
    // through a root of '/proj', and this function still says no: refusing a
    // path the product cannot vouch for character-for-character is the safe
    // direction, while folding case would make two distinct paths on a
    // case-sensitive host compare equal — the failure that actually lets
    // something through.
    //
    // The filesystem-level requirement this leaves open, named rather than
    // gestured at: a path inside the root as text whose interior component is
    // a symbolic link resolving outside the root must be rejected, and the way
    // a caller does that is `fs.realpath` first, then this gate on the
    // resolved path. It is proven in `src/node/safe-fs.test.ts`, in
    // `describe('a project-internal symbolic link whose target is outside the
    // root')`, which asserts in that order: this gate accepting the unresolved
    // path, the realpath-aware composition rejecting it, and safe-fs's own
    // narrower refusals — `O_NOFOLLOW` at a path's *final* component and the
    // directory policy on a chain it is given to verify. That block also
    // records the limit those refusals have: an interior link is read through,
    // so they are a backstop and never a substitute for the realpath step.
    expect(isWithin(SHORT_ROOT, '/Proj/src')).toBe(false);
    expect(isWithin('/Proj', `${SHORT_ROOT}/src`)).toBe(false);
    expect(isWithin(PROJECT_ROOT, `/home/dev/Project/${SAFE_RELATIVE}`)).toBe(false);
  });

  it('compares two relative paths lexically, as documented', () => {
    // Both arguments are expected to be absolute; the two `Result`-returning
    // entry points are what insist on it. Given two relative paths this
    // function still answers lexically rather than inventing a base, and the
    // answer is recorded here so a caller cannot mistake it for a containment
    // guarantee about the filesystem.
    expect(isWithin('project', 'project/src/lib/thing.ts')).toBe(true);
    expect(isWithin('project', 'project-evil/secret.ts')).toBe(false);
  });

  it('converts separators before comparing, so a Windows pair is understood', () => {
    expect(isWithin('C:\\project', 'C:\\project\\src\\thing.ts')).toBe(true);
    expect(isWithin('C:\\project', 'C:\\project-evil\\secret.ts')).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * toProjectRelative — the converter
 * ---------------------------------------------------------------------------
 */

describe('toProjectRelative', () => {
  it.each(TO_PROJECT_RELATIVE_ACCEPTED)('reduces $label', ({ path, expected }: AcceptedCase) => {
    expect(okValue(toProjectRelative(PROJECT_ROOT, path))).toBe(expected);
  });

  it('returns a path with no leading separator and no leading dot segment', () => {
    // The canonical form every layer above depends on: a path is an identity in
    // the session store, a key in a panel and a value in a prompt, and an
    // absolute one would also leak the developer's directory layout into all
    // three.
    for (const { path } of TO_PROJECT_RELATIVE_ACCEPTED) {
      const relative = okValue(toProjectRelative(PROJECT_ROOT, path));

      expect(relative.startsWith('/')).toBe(false);
      expect(relative.startsWith('./')).toBe(false);
      expect(relative).not.toContain('\\');
      expect(isSafeRelativePath(relative)).toBe(true);
    }
  });

  it('reduces the root itself to a dot rather than to the empty string', () => {
    expect(okValue(toProjectRelative(PROJECT_ROOT, PROJECT_ROOT))).toBe('.');
  });

  it('accepts a Windows-rooted path under a Windows-rooted project root', () => {
    // Separator conversion applies to both arguments, so a developer on Windows
    // gets the same project-relative POSIX identity as one on Linux.
    expect(okValue(toProjectRelative('C:\\project', 'C:\\project\\src\\thing.ts'))).toBe(
      'src/thing.ts',
    );
  });

  it.each(TO_PROJECT_RELATIVE_REFUSALS)('refuses $label', ({ path, reason }: RefusalCase) => {
    const error = errorOf(toProjectRelative(PROJECT_ROOT, path));

    expect(DebuggenError.is(error)).toBe(true);
    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(reasonOf(error)).toBe(reason);
  });

  it.each(TRAVERSAL_PATHS)(
    'refuses $label, replaying the traversal class',
    ({ path }: LabelledPath) => {
      // Replay of the traversal class against the converter: the predicate and
      // the function built on it must never disagree about the same string.
      expect(isSafeRelativePath(path)).toBe(false);
      expect(isErr(toProjectRelative(PROJECT_ROOT, path))).toBe(true);
    },
  );

  it.each(CONTROL_CHARACTER_PATHS)(
    'refuses $label, replaying the control-character class',
    ({ path }: LabelledPath) => {
      expect(isErr(toProjectRelative(PROJECT_ROOT, path))).toBe(true);
    },
  );

  it.each(EMPTY_PATHS)('refuses $label, replaying the empty class', ({ path }: LabelledPath) => {
    // The empty string must not be read as "the project root": normalisation
    // would turn it into '.', which is why the converter validates before it
    // normalises.
    expect(isErr(toProjectRelative(PROJECT_ROOT, path))).toBe(true);
  });

  it('refuses a relative project root, which makes containment unanswerable', () => {
    const error = errorOf(toProjectRelative('project/subdir', SAFE_RELATIVE));

    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(reasonOf(error)).toBe('project-root-not-absolute');
  });

  it('refuses a project root that names a network share', () => {
    // Refused rather than normalised: on Windows '//server/share' is a
    // different volume, and collapsing the prefix to one separator could make
    // an off-volume path look as though it sat inside the root.
    const error = errorOf(toProjectRelative('//server/share', SAFE_RELATIVE));

    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(reasonOf(error)).toBe('network-share-path');
  });

  it('narrows through isOk so the reduced path is typed', () => {
    const result = toProjectRelative(PROJECT_ROOT, `${PROJECT_ROOT}/${SAFE_RELATIVE}`);

    if (isOk(result)) {
      const relative: string = result.value;

      expect(relative).toBe(SAFE_RELATIVE);
    } else {
      expect.unreachable(`Expected Ok, received ${result.error.code}`);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * resolveWithinProject — the validator
 * ---------------------------------------------------------------------------
 */

describe('resolveWithinProject', () => {
  it.each(RESOLVE_ACCEPTED)('resolves $label', ({ path, expected }: AcceptedCase) => {
    expect(okValue(resolveWithinProject(PROJECT_ROOT, path))).toBe(expected);
  });

  it('resolves against the filesystem root as well as a nested root', () => {
    expect(okValue(resolveWithinProject('/', 'thing.ts'))).toBe('/thing.ts');
    expect(okValue(resolveWithinProject('/', SAFE_RELATIVE))).toBe(`/${SAFE_RELATIVE}`);
  });

  it('normalises a root it was handed unnormalised', () => {
    expect(okValue(resolveWithinProject('/home/dev//project/./', SAFE_RELATIVE))).toBe(
      `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
    );
    expect(okValue(resolveWithinProject(`${PROJECT_ROOT}/src/..`, SAFE_RELATIVE))).toBe(
      `${PROJECT_ROOT}/${SAFE_RELATIVE}`,
    );
  });

  it('returns a path that is inside the root by its own containment check', () => {
    // The third of the three deliberately redundant steps in the function: the
    // join is not trusted, and this is the property that says so.
    for (const { path } of RESOLVE_ACCEPTED) {
      const resolved = okValue(resolveWithinProject(PROJECT_ROOT, path));

      expect(isWithin(PROJECT_ROOT, resolved)).toBe(true);
      expect(isAbsolutePosix(resolved)).toBe(true);
      expect(resolved).not.toContain('\\');
    }
  });

  describe('refuses', () => {
    it.each(UNSAFE_PATHS)('$label', ({ path }: LabelledPath) => {
      // Every class replayed against the validator, and with one diagnosis:
      // `resolveWithinProject` asks `isSafeRelativePath` first, so an input
      // this predicate refuses can never reach the join.
      const error = errorOf(resolveWithinProject(PROJECT_ROOT, path));

      expect(DebuggenError.is(error)).toBe(true);
      expect(error.code).toBe(CONTAINMENT_CODE);
      expect(reasonOf(error)).toBe('unsafe-relative-path');
    });
  });

  it('refuses a traversal that escapes and then re-enters a directory of the same name', () => {
    // The case a string-level gate can most plausibly be talked into
    // accepting: '../project/x.ts' under a root whose own basename is
    // 'project' resolves to a sibling directory that merely shares the name.
    // The join would land on '/home/dev/project/x.ts' only if the root's
    // parent happened to contain a second directory of that name — so the
    // refusal happens before the join, on the surviving '..'.
    const reentry = `../${basenamePosix(PROJECT_ROOT)}/x.ts`;
    const error = errorOf(resolveWithinProject(PROJECT_ROOT, reentry));

    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(reasonOf(error)).toBe('unsafe-relative-path');
  });

  it('refuses an absolute path even when it is inside the root', () => {
    // This function takes a project-relative path. Accepting an absolute one
    // "because it happens to be inside" would make the same argument mean two
    // things depending on its first character, which is how a caller ends up
    // passing an attacker-supplied absolute path and having it honoured.
    const inside = `${PROJECT_ROOT}/${SAFE_RELATIVE}`;

    expect(isWithin(PROJECT_ROOT, inside)).toBe(true);
    expect(reasonOf(errorOf(resolveWithinProject(PROJECT_ROOT, inside)))).toBe(
      'unsafe-relative-path',
    );
  });

  it('refuses a relative project root and a network-share root', () => {
    expect(reasonOf(errorOf(resolveWithinProject('project/subdir', SAFE_RELATIVE)))).toBe(
      'project-root-not-absolute',
    );
    expect(reasonOf(errorOf(resolveWithinProject('//server/share', SAFE_RELATIVE)))).toBe(
      'network-share-path',
    );
    expect(reasonOf(errorOf(resolveWithinProject('\\\\server\\share', SAFE_RELATIVE)))).toBe(
      'network-share-path',
    );
  });

  it('narrows through isErr so the error is typed', () => {
    const result = resolveWithinProject(PROJECT_ROOT, '../secret.ts');

    if (isErr(result)) {
      const code: DebuggenErrorCode = result.error.code;

      expect(code).toBe(CONTAINMENT_CODE);
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(result.error.hint).toBeDefined();
    } else {
      expect.unreachable(`Expected Err, received Ok('${result.value}')`);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The gate as a whole
 * ---------------------------------------------------------------------------
 */

describe('the containment gate', () => {
  it.each(SAFE_PATHS)('round-trips $label through both directions', ({ path }: LabelledPath) => {
    const resolved = okValue(resolveWithinProject(PROJECT_ROOT, path));
    const back = okValue(toProjectRelative(PROJECT_ROOT, resolved));

    expect(back).toBe(normalizePosix(path));
  });

  it('reports every refusal under one error code', () => {
    // One code for every refusal, because a caller reacting to a refused path
    // does the same thing whichever way the path was malformed; the finer
    // diagnosis travels in `details.reason`.
    for (const { path } of UNSAFE_PATHS) {
      expect(errorOf(resolveWithinProject(PROJECT_ROOT, path)).code).toBe(CONTAINMENT_CODE);
    }
    for (const { path } of TO_PROJECT_RELATIVE_REFUSALS) {
      expect(errorOf(toProjectRelative(PROJECT_ROOT, path)).code).toBe(CONTAINMENT_CODE);
    }
  });

  it('discloses nothing about the filesystem in a refusal', () => {
    // The answer to a refused path must not become an oracle for probing the
    // developer's disk, so `details` carries only the two strings the caller
    // already supplied.
    const error = errorOf(toProjectRelative(PROJECT_ROOT, '/etc/hosts'));

    expect(Object.keys(error.details ?? {}).toSorted()).toEqual(['path', 'projectRoot', 'reason']);
    expect(error.details?.projectRoot).toBe(PROJECT_ROOT);
    expect(error.details?.path).toBe('/etc/hosts');
  });

  it('neutralises control characters in the path it echoes back', () => {
    // A rejected path is attacker-influenced input, and the error carrying it
    // is logged, persisted with a session and rendered in two user interfaces.
    // An escape sequence surviving into a log line would rewrite the rest of
    // the line.
    const error = errorOf(resolveWithinProject(PROJECT_ROOT, 'src/a\u001b[2Kb.ts'));
    const reported = error.details?.path;

    expect(typeof reported).toBe('string');
    expect(reported).not.toContain('\u001b');
    expect(error.message).not.toContain('\u001b');
  });

  it('truncates a very long path before echoing it back', () => {
    // Bounded so a multi-kilobyte string cannot be copied through the whole
    // chain, while the offending value stays identifiable.
    const longPath = `../${'a'.repeat(4_000)}.ts`;
    const error = errorOf(resolveWithinProject(PROJECT_ROOT, longPath));
    const reported = error.details?.path;

    expect(typeof reported).toBe('string');
    if (typeof reported === 'string') {
      expect(reported.length).toBeLessThan(longPath.length);
      expect(reported.endsWith('…')).toBe(true);
    }
    expect(error.code).toBe(CONTAINMENT_CODE);
  });

  it('keeps the three enforcement points asking the same question', () => {
    // The service's `source.open`, the VS Code URI handler and the
    // instrumentation patcher each validate independently, and all three go
    // through these functions. What must hold is that a path one of them would
    // accept is a path the others accept: `isSafeRelativePath` is true exactly
    // when `resolveWithinProject` succeeds, for every case in this file.
    for (const { path } of [...SAFE_PATHS, ...UNSAFE_PATHS]) {
      expect(isOk(resolveWithinProject(PROJECT_ROOT, path))).toBe(isSafeRelativePath(path));
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * resolveRealPathWithinProject
 * ---------------------------------------------------------------------------
 *
 * The one function here that can see a symbolic link, because it is the one
 * that is handed a resolver. The cases below are the escape the lexical gate
 * accepts by construction, plus the three ways the composition could go wrong
 * in the other direction: refusing a project whose *root* is reached through a
 * link, calling the filesystem for a path the lexical gate should have refused
 * outright, and resolving the final component (which would follow a link
 * planted at the target instead of leaving it for the caller's `O_NOFOLLOW`).
 *
 * The resolver is a table rather than a filesystem, exactly as habit 1 above
 * requires: each entry maps one absolute path to what it really points at, and
 * resolution walks the components so an entry for a *directory* applies to
 * every path beneath it — which is what an interior link does.
 */

/** A recorded call to the fake resolver, so a test can assert what was asked. */
interface ResolverProbe {
  /** The resolver to pass to the function under test. */
  readonly resolve: RealPathResolver;

  /** Every path the function asked about, in order. */
  readonly calls: readonly string[];
}

/**
 * A resolver over a link table, recording what it is asked.
 *
 * Components are walked outermost first and a matching entry replaces the
 * prefix accumulated so far, so `{'/a/b': '/x'}` resolves `/a/b/c/d.ts` to
 * `/x/c/d.ts` — the behaviour of a directory symlink, and the case no string
 * check can reach. A link target is taken to be canonical already, which keeps
 * the fake honest about `realpath`'s contract without giving it a loop
 * detector it would never exercise.
 */
function linkResolver(links: Readonly<Record<string, string>>): ResolverProbe {
  const calls: string[] = [];

  return {
    calls,
    resolve: (absolutePath) => {
      calls.push(absolutePath);

      let resolved = '/';
      for (const segment of absolutePath.split('/')) {
        if (segment.length === 0) {
          continue;
        }
        const joined = joinPosix(resolved, segment);
        resolved = links[joined] ?? joined;
      }
      return resolved;
    },
  };
}

/** A resolver that fails the way `realpath` fails, with the platform errno. */
function failingResolver(code: string): ResolverProbe {
  const calls: string[] = [];

  return {
    calls,
    resolve: (absolutePath) => {
      calls.push(absolutePath);
      throw Object.assign(new Error(`${code}: cannot resolve '${absolutePath}'`), { code });
    },
  };
}

/** The resolution of a successful result, or a failed test naming the error. */
function resolutionOf(result: Result<ProjectPathResolution>): ProjectPathResolution {
  if (isErr(result)) {
    throw new Error(`Expected Ok, received Err ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** The error of a refused resolution, or a failed test naming the value. */
function refusalOf(result: Result<ProjectPathResolution>): DebuggenError {
  if (isOk(result)) {
    throw new Error(`Expected Err, received Ok('${result.value.path}')`);
  }
  return result.error;
}

describe('resolveRealPathWithinProject', () => {
  it('resolves an ordinary path exactly as the lexical gate does', () => {
    const probe = linkResolver({});

    const resolution = resolutionOf(
      resolveRealPathWithinProject(PROJECT_ROOT, SAFE_RELATIVE, probe.resolve),
    );

    expect(resolution.projectRoot).toBe(PROJECT_ROOT);
    expect(resolution.path).toBe(`${PROJECT_ROOT}/${SAFE_RELATIVE}`);
    expect(resolution.directory).toBe(`${PROJECT_ROOT}/src/lib`);
    expect(resolution.relative).toBe(SAFE_RELATIVE);
    expect(okValue(resolveWithinProject(PROJECT_ROOT, SAFE_RELATIVE))).toBe(resolution.path);
  });

  it('refuses a path whose interior directory component links outside the root', () => {
    // The whole point of the function: 'src/vendor/thing.ts' has no traversal
    // in it, lands under the root when joined, and would be read and written
    // at '/etc/thing.ts' by a caller that stopped at the lexical gate.
    const probe = linkResolver({ [`${PROJECT_ROOT}/src/vendor`]: '/etc' });

    const result = resolveRealPathWithinProject(PROJECT_ROOT, 'src/vendor/thing.ts', probe.resolve);
    const error = refusalOf(result);

    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(reasonOf(error)).toBe('symlink-escapes-project-root');
    // The lexical gate, asked the same question, says yes — which is the
    // reason this function is not optional for a caller that opens a file.
    expect(isOk(resolveWithinProject(PROJECT_ROOT, 'src/vendor/thing.ts'))).toBe(true);
  });

  it('refuses a path whose interior link lands on the prefix sibling of the root', () => {
    // `/home/dev/project-evil` shares the root's first characters, so this is
    // the prefix-sibling mistake arriving by link instead of by string.
    const probe = linkResolver({ [`${PROJECT_ROOT}/src`]: `${PROJECT_ROOT}-evil/src` });

    const error = refusalOf(
      resolveRealPathWithinProject(PROJECT_ROOT, SAFE_RELATIVE, probe.resolve),
    );

    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(reasonOf(error)).toBe('symlink-escapes-project-root');
  });

  it('accepts a project whose root is itself reached through a link', () => {
    // Both sides of the comparison are canonical, so a checkout under a linked
    // parent - a linked home directory, macOS /tmp - is not refused wholesale.
    const real = '/var/checkouts/project';
    const probe = linkResolver({ [PROJECT_ROOT]: real });

    const resolution = resolutionOf(
      resolveRealPathWithinProject(PROJECT_ROOT, SAFE_RELATIVE, probe.resolve),
    );

    expect(resolution.projectRoot).toBe(real);
    expect(resolution.path).toBe(`${real}/${SAFE_RELATIVE}`);
    expect(resolution.relative).toBe(SAFE_RELATIVE);
  });

  it('reports a different relative path when a link stays inside the project', () => {
    // Contained, so not a refusal here - but the file now has two
    // project-relative names, and a caller that records a path as an identity
    // has to notice. That is what `relative` is for.
    const probe = linkResolver({ [`${PROJECT_ROOT}/src/vendor`]: `${PROJECT_ROOT}/lib` });

    const resolution = resolutionOf(
      resolveRealPathWithinProject(PROJECT_ROOT, 'src/vendor/thing.ts', probe.resolve),
    );

    expect(resolution.relative).toBe('lib/thing.ts');
    expect(resolution.path).toBe(`${PROJECT_ROOT}/lib/thing.ts`);
  });

  it('leaves the final component unresolved, so the caller keeps O_NOFOLLOW', () => {
    // A link planted at the target must surface as ELOOP from the caller's
    // no-follow open, not as a silent read of what it points at - so the
    // returned path still names the target, and the resolver is never asked
    // about it.
    const target = `${PROJECT_ROOT}/${SAFE_RELATIVE}`;
    const probe = linkResolver({ [target]: '/etc/shadow' });

    const resolution = resolutionOf(
      resolveRealPathWithinProject(PROJECT_ROOT, SAFE_RELATIVE, probe.resolve),
    );

    expect(resolution.path).toBe(target);
    expect(probe.calls).not.toContain(target);
  });

  it('refuses a traversal without consulting the resolver at all', () => {
    // The lexical gate runs first, so a hostile path never reaches the
    // filesystem: no existence probe, no permission error, no oracle.
    const probe = linkResolver({});

    const error = refusalOf(
      resolveRealPathWithinProject(PROJECT_ROOT, '../../../etc/passwd', probe.resolve),
    );

    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(reasonOf(error)).toBe('unsafe-relative-path');
    expect(probe.calls).toEqual([]);
  });

  it.each([...UNSAFE_PATHS])('refuses $label without consulting the resolver', ({ path }) => {
    const probe = linkResolver({});

    const error = refusalOf(resolveRealPathWithinProject(PROJECT_ROOT, path, probe.resolve));

    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(probe.calls).toEqual([]);
  });

  it('refuses a relative project root before consulting the resolver', () => {
    const probe = linkResolver({});

    const error = refusalOf(
      resolveRealPathWithinProject('relative/root', SAFE_RELATIVE, probe.resolve),
    );

    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(reasonOf(error)).toBe('project-root-not-absolute');
    expect(probe.calls).toEqual([]);
  });

  it('converts a resolver failure into a refusal that keeps the platform errno', () => {
    // The caller needs "that file is not there" to read differently from "that
    // file is not yours", and the errno is how it tells them apart. `details`
    // still carries nothing but the two strings the caller supplied.
    const probe = failingResolver('ENOENT');

    const error = refusalOf(
      resolveRealPathWithinProject(PROJECT_ROOT, SAFE_RELATIVE, probe.resolve),
    );

    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(reasonOf(error)).toBe('path-not-resolvable');
    expect((error.cause as { code?: unknown } | undefined)?.code).toBe('ENOENT');
    expect(error.details?.path).toBe(SAFE_RELATIVE);
    expect(error.details?.projectRoot).toBe(PROJECT_ROOT);
  });

  it('refuses a resolver that answers with something other than an absolute path', () => {
    const error = refusalOf(
      resolveRealPathWithinProject(PROJECT_ROOT, SAFE_RELATIVE, () => 'not/absolute'),
    );

    expect(error.code).toBe(CONTAINMENT_CODE);
    expect(reasonOf(error)).toBe('resolved-path-not-absolute');
  });

  it('answers for the project root itself without climbing out of it', () => {
    // The root has no parent inside the project, so asking `dirname` for one
    // would canonicalise a directory the caller never named.
    const probe = linkResolver({});

    const resolution = resolutionOf(resolveRealPathWithinProject(PROJECT_ROOT, '.', probe.resolve));

    expect(resolution.relative).toBe('.');
    expect(resolution.path).toBe(PROJECT_ROOT);
    expect(resolution.directory).toBe(PROJECT_ROOT);
    expect(probe.calls).toEqual([PROJECT_ROOT]);
  });

  it('normalises a host-flavoured spelling of the target before resolving it', () => {
    const probe = linkResolver({});

    const resolution = resolutionOf(
      resolveRealPathWithinProject(PROJECT_ROOT, './src/lib/./thing.ts', probe.resolve),
    );

    expect(resolution.relative).toBe(SAFE_RELATIVE);
    expect(resolution.path).toBe(`${PROJECT_ROOT}/${SAFE_RELATIVE}`);
  });
});
