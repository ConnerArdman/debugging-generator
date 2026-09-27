/**
 * `webview/path-display` — how the view splits a path so a narrow column shortens it in the middle.
 *
 * What this suite protects:
 *
 *   - the split of the two shapes that collided on screen: files of one name in a directory and in
 *     its subdirectory, and files of one name under long, identical directory runs that differ in
 *     one outer segment — each tail begins at the segment that tells the paths apart;
 *   - the minimum: a file name no other path shares is its own tail, however deep the path;
 *   - the edges: an empty list, a bare file name, repeats of one path, a path that is a
 *     segment-suffix of another, leading, doubled and trailing separators, the empty path, and
 *     exact (case- and backslash-sensitive) comparison;
 *   - the invariants, over a hand-worked list and over an exhaustive enumeration checked against a
 *     brute-force reference: `lead + tail` and `context + name` rebuild their strings byte for byte,
 *     tails are pairwise distinct, and each tail is the shortest suffix no other path ends in;
 *   - purity: the input is not mutated, equal input gives equal output, and nothing reaches the
 *     console.
 *
 * The paths are neutral, synthetic vocabulary written for this suite (AAP 0.5.4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describePath, describePaths } from './path-display';
import type { PathDisplay } from './path-display';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** A file in a directory and a file of the same name in its subdirectory. */
const SIBLING_ROUTES = ['app/api/widgets/route.ts', 'app/api/widgets/parts/route.ts'] as const;

/** Files of one name under identical long directory runs that differ in one outer segment. */
const DEEP_TWINS = [
  'src/modules/first/ExtremelyLongNestedDirectoryName/View.tsx',
  'src/modules/second/ExtremelyLongNestedDirectoryName/View.tsx',
] as const;

/** A list mixing every shape above with unique names, in a deliberate, unsorted order. */
const MIXED: readonly string[] = [
  ...SIBLING_ROUTES,
  ...DEEP_TWINS,
  'src/lib/format.ts',
  'route.ts',
  'README.md',
  'docs/README.md',
];

/** Stands in for a console method, so a call is recorded by its spy and printed nowhere. */
function silence(): void {
  // Intentionally empty: the spy records the call, and the output is what is being suppressed.
}

/**
 * The entry for `path`, failing the test when the result holds none.
 *
 * @param displays A `describePaths` result.
 * @param path The path to look up.
 * @returns Its display parts.
 */
function entryOf(displays: ReadonlyMap<string, PathDisplay>, path: string): PathDisplay {
  const display = displays.get(path);
  if (display === undefined) {
    throw new Error(`expected a display entry for ${path}`);
  }
  return display;
}

/**
 * The brute-force reference: the fewest trailing segments of `path`, compared as segment arrays,
 * that no other distinct path of the list ends in — every segment when each shorter run is shared.
 * Written independently of the implementation's offset arithmetic.
 *
 * @param path The path whose tail is wanted; its last segment is non-empty.
 * @param list Every distinct path of the list, `path` included.
 * @returns The expected tail.
 */
function referenceTail(path: string, list: readonly string[]): string {
  const own = path.split('/');
  const others = list.filter((other) => other !== path).map((other) => other.split('/'));

  for (let count = 1; count < own.length; count += 1) {
    const suffix = own.slice(-count);
    const shared = others.some(
      (other) =>
        other.length >= count && other.slice(-count).every((segment, i) => segment === suffix[i]),
    );
    if (!shared) {
      return suffix.join('/');
    }
  }
  return path;
}

/**
 * Asserts the structural invariants of one `describePaths` result against its input.
 *
 * @param paths The input list.
 * @param displays Its result.
 */
function expectInvariants(
  paths: readonly string[],
  displays: ReadonlyMap<string, PathDisplay>,
): void {
  const distinct = [...new Set(paths)];
  expect([...displays.keys()]).toEqual(distinct);

  for (const path of distinct) {
    const { lead, tail, context, name } = entryOf(displays, path);
    expect(lead + tail).toBe(path);
    expect(context + name).toBe(tail);
    expect(lead === '' || lead.endsWith('/')).toBe(true);
    expect(context === '' || context.endsWith('/')).toBe(true);
    expect(tail.endsWith(name)).toBe(true);
    if (path !== '') {
      expect(name).not.toBe('');
    }
  }

  const tails = distinct.map((path) => entryOf(displays, path).tail);
  expect(new Set(tails).size).toBe(tails.length);
}

// ---------------------------------------------------------------------------
// describePaths
// ---------------------------------------------------------------------------

describe('describePaths — the shapes that collided', () => {
  it('starts each tail at the directory that tells same-named files apart', () => {
    const displays = describePaths(SIBLING_ROUTES);

    expect(entryOf(displays, 'app/api/widgets/route.ts')).toEqual({
      lead: 'app/api/',
      tail: 'widgets/route.ts',
      context: 'widgets/',
      name: 'route.ts',
    });
    expect(entryOf(displays, 'app/api/widgets/parts/route.ts')).toEqual({
      lead: 'app/api/widgets/',
      tail: 'parts/route.ts',
      context: 'parts/',
      name: 'route.ts',
    });
  });

  it('reaches past identical directory runs to the one segment that differs', () => {
    const displays = describePaths(DEEP_TWINS);

    expect(entryOf(displays, DEEP_TWINS[0])).toEqual({
      lead: 'src/modules/',
      tail: 'first/ExtremelyLongNestedDirectoryName/View.tsx',
      context: 'first/ExtremelyLongNestedDirectoryName/',
      name: 'View.tsx',
    });
    expect(entryOf(displays, DEEP_TWINS[1])).toEqual({
      lead: 'src/modules/',
      tail: 'second/ExtremelyLongNestedDirectoryName/View.tsx',
      context: 'second/ExtremelyLongNestedDirectoryName/',
      name: 'View.tsx',
    });
  });

  it('keeps a file name no other path shares as its own tail, however deep the path', () => {
    const displays = describePaths([...SIBLING_ROUTES, 'src/lib/deeply/nested/format.ts']);

    expect(entryOf(displays, 'src/lib/deeply/nested/format.ts')).toEqual({
      lead: 'src/lib/deeply/nested/',
      tail: 'format.ts',
      context: '',
      name: 'format.ts',
    });
  });

  it('splits each list on its own: a path alone in a list keeps only its file name', () => {
    const alone = describePaths(['app/api/widgets/route.ts']);

    expect(entryOf(alone, 'app/api/widgets/route.ts').tail).toBe('route.ts');
    expect(entryOf(describePaths(SIBLING_ROUTES), 'app/api/widgets/route.ts').tail).toBe(
      'widgets/route.ts',
    );
  });
});

describe('describePaths — edges', () => {
  it('returns an empty map for an empty list', () => {
    expect(describePaths([]).size).toBe(0);
  });

  it('gives a bare file name no lead and no context', () => {
    expect(entryOf(describePaths(['README.md']), 'README.md')).toEqual({
      lead: '',
      tail: 'README.md',
      context: '',
      name: 'README.md',
    });
  });

  it('gives repeats of one path a single entry that never counts as a collision', () => {
    const displays = describePaths(['src/a/one.ts', 'src/b/two.ts', 'src/a/one.ts']);

    expect(displays.size).toBe(2);
    expect(entryOf(displays, 'src/a/one.ts')).toEqual({
      lead: 'src/a/',
      tail: 'one.ts',
      context: '',
      name: 'one.ts',
    });
  });

  it('keys entries in first-occurrence order', () => {
    const displays = describePaths(['z/last.ts', 'a/first.ts', 'z/last.ts', 'm/middle.ts']);

    expect([...displays.keys()]).toEqual(['z/last.ts', 'a/first.ts', 'm/middle.ts']);
  });

  it('keeps a path that is a segment-suffix of another, and the longer one, whole', () => {
    const displays = describePaths(['route.ts', 'app/route.ts']);

    expect(entryOf(displays, 'route.ts')).toEqual({
      lead: '',
      tail: 'route.ts',
      context: '',
      name: 'route.ts',
    });
    expect(entryOf(displays, 'app/route.ts')).toEqual({
      lead: '',
      tail: 'app/route.ts',
      context: 'app/',
      name: 'route.ts',
    });
  });

  it('lengthens the outer tail past a whole inner path it ends in', () => {
    const displays = describePaths(['a/app/route.ts', 'app/route.ts', 'b/other/route.ts']);

    expect(entryOf(displays, 'app/route.ts').tail).toBe('app/route.ts');
    expect(entryOf(displays, 'a/app/route.ts')).toEqual({
      lead: '',
      tail: 'a/app/route.ts',
      context: 'a/app/',
      name: 'route.ts',
    });
    expect(entryOf(displays, 'b/other/route.ts')).toEqual({
      lead: 'b/',
      tail: 'other/route.ts',
      context: 'other/',
      name: 'route.ts',
    });
  });

  it('treats leading and doubled separators as empty segments, byte for byte', () => {
    const displays = describePaths(['/root/x/file.ts', '/root/y/file.ts', 'a//b.ts']);

    expect(entryOf(displays, '/root/x/file.ts')).toEqual({
      lead: '/root/',
      tail: 'x/file.ts',
      context: 'x/',
      name: 'file.ts',
    });
    expect(entryOf(displays, 'a//b.ts')).toEqual({
      lead: 'a//',
      tail: 'b.ts',
      context: '',
      name: 'b.ts',
    });
  });

  it('keeps the final directory of a path ending in a separator as its name', () => {
    const displays = describePaths(['src/generated/', 'lib/generated/']);

    expect(entryOf(displays, 'src/generated/')).toEqual({
      lead: '',
      tail: 'src/generated/',
      context: 'src/',
      name: 'generated/',
    });
    expect(entryOf(displays, 'lib/generated/').tail).toBe('lib/generated/');
  });

  it('renders the empty path, and a separator alone, whole', () => {
    const displays = describePaths(['', '/']);

    expect(entryOf(displays, '')).toEqual({ lead: '', tail: '', context: '', name: '' });
    expect(entryOf(displays, '/')).toEqual({ lead: '', tail: '/', context: '', name: '/' });
  });

  it('compares segments exactly: case matters and a backslash is not a separator', () => {
    const displays = describePaths(['Src/one/a.ts', 'src/one/a.ts', 'win\\dir\\a.ts']);

    expect(entryOf(displays, 'Src/one/a.ts').tail).toBe('Src/one/a.ts');
    expect(entryOf(displays, 'src/one/a.ts').tail).toBe('src/one/a.ts');
    expect(entryOf(displays, 'win\\dir\\a.ts')).toEqual({
      lead: '',
      tail: 'win\\dir\\a.ts',
      context: '',
      name: 'win\\dir\\a.ts',
    });
  });
});

describe('describePaths — invariants', () => {
  it('holds every invariant over a mixed list, and matches the reference tails', () => {
    const displays = describePaths(MIXED);

    expectInvariants(MIXED, displays);
    for (const path of new Set(MIXED)) {
      expect({ path, tail: entryOf(displays, path).tail }).toEqual({
        path,
        tail: referenceTail(path, [...new Set(MIXED)]),
      });
    }
  });

  it('matches the brute-force reference over every path of up to three directories', () => {
    // Directory names chosen so that one is a character-prefix of another ("a", "ab"): a split
    // that compared characters instead of segments would disagree with the reference here.
    const directories = ['a', 'b', 'ab'];
    const names = ['x.ts', 'y.ts'];
    let prefixes: string[] = [''];
    const all: string[] = [];
    for (let depth = 0; depth <= 3; depth += 1) {
      for (const prefix of prefixes) {
        for (const name of names) {
          all.push(`${prefix}${name}`);
        }
      }
      prefixes = prefixes.flatMap((prefix) => directories.map((dir) => `${prefix}${dir}/`));
    }
    // 2 + 6 + 18 + 54 paths.
    expect(all).toHaveLength(80);

    const displays = describePaths(all);

    expectInvariants(all, displays);
    const mismatches = all.filter(
      (path) => entryOf(displays, path).tail !== referenceTail(path, all),
    );
    expect(mismatches).toEqual([]);
  });
});

describe('describePaths — purity', () => {
  it('leaves its input untouched and gives equal output for equal input', () => {
    const input = Object.freeze([...MIXED]);

    const first = describePaths(input);
    const second = describePaths(input);

    expect(input).toEqual(MIXED);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it('writes nothing to the console', () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(silence));

    describePaths(MIXED);
    describePath('src/lib/format.ts');

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// describePath
// ---------------------------------------------------------------------------

describe('describePath', () => {
  it('splits a path as if alone: every directory is lead and the file name is the tail', () => {
    expect(describePath('app/api/widgets/parts/route.ts')).toEqual({
      lead: 'app/api/widgets/parts/',
      tail: 'route.ts',
      context: '',
      name: 'route.ts',
    });
  });

  it('agrees with a one-path list for every shape', () => {
    for (const path of ['README.md', '', '/', 'dir/', 'a//b.ts', '/root/file.ts', ...MIXED]) {
      expect(describePath(path)).toEqual(entryOf(describePaths([path]), path));
    }
  });
});
