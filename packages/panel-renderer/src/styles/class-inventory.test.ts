/**
 * The class-contract gate — every class a module emits is styled, and every
 * class a selector names is emitted or published (AAP 0.6.2, 0.6.4).
 *
 * `scripts/check-css-classes.mjs` is the gate itself: this package's
 * `prebuild` runs it on every build. This suite runs the same check inside
 * `pnpm test`, so a drifting class fails the blocking test gate as well as the
 * build, and it proves the check's own behaviour against synthetic package
 * trees — each of the five findings, every way a class name can be assembled at
 * run time (template substitution and string concatenation, with or without a
 * complete name in view), and each thing that must NOT be read as a class (a
 * comment, a non-class JSX attribute, a test module, a custom-property name
 * built the same way).
 *
 * ## How the script is loaded
 *
 * The specifier is a computed file URL rather than a literal, so the compiler
 * never tries to resolve an untyped `.mjs`; the loaded namespace is narrowed
 * once, to the functions used below, by {@link CheckCssClassesModule}. Unlike
 * the token generator the script has no shebang line, so the test runner
 * can import it in place without the sandbox copy `src/tokens/tokens.test.ts`
 * needs.
 *
 * ## Why this file may read from disk
 *
 * The synthetic tree lives in an OS-private `mkdtemp` directory that is removed
 * after the suite, so nothing is written into the checkout under test. Paths
 * are resolved from `import.meta.url`, never from `process.cwd()`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

/** One place a class occurs. */
interface ClassSite {
  readonly file: string;
  readonly line: number;
}

/** One finding of the check. */
interface Finding {
  readonly rule:
    | 'unstyled-class'
    | 'unreferenced-class'
    | 'published-missing'
    | 'published-emitted'
    | 'interpolated-class';
  readonly className: string;
  readonly site: ClassSite;
  readonly message: string;
}

/** The two sides of the inventory. */
interface ClassInventory {
  readonly emitted: ReadonlyMap<string, readonly ClassSite[]>;
  readonly selected: ReadonlyMap<string, readonly ClassSite[]>;
}

/** The part of the script this suite drives. */
interface CheckCssClassesModule {
  readonly PUBLISHED_CLASSES: Readonly<Record<string, string>>;
  readonly checkCssClasses: (options?: {
    readonly root?: string;
    readonly published?: Readonly<Record<string, string>>;
  }) => Promise<{ readonly inventory: ClassInventory; readonly findings: readonly Finding[] }>;
  readonly main: (
    argv?: readonly string[],
    options?: { readonly root?: string; readonly stdout?: Writable; readonly stderr?: Writable },
  ) => Promise<number>;
}

/** The package root; this file sits two levels below it. */
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The check under test. */
const SCRIPT_PATH = path.join(PACKAGE_ROOT, 'scripts', 'check-css-classes.mjs');

const loaded: unknown = await import(pathToFileURL(SCRIPT_PATH).href);
const check = loaded as CheckCssClassesModule;

/** A writable stream that keeps what is written to it. */
function captureStream(): { readonly stream: Writable; readonly text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback): void {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/* -------------------------------------------------------------------------- */
/* A synthetic package tree with one example of every case                    */
/* -------------------------------------------------------------------------- */

const SANDBOX = mkdtempSync(path.join(tmpdir(), 'debuggen-class-inventory-'));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

/** Writes one file of the synthetic tree. */
function writeTreeFile(rel: string, text: string): void {
  const file = path.join(SANDBOX, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

writeTreeFile(
  'src/components/Widget.tsx',
  [
    "import { clsx } from 'clsx';",
    '',
    '// A comment naming dg-widget__from-a-comment is not an emitted class.',
    "const SIZE_CLASS = { big: 'dg-widget--big' } as const;",
    '',
    'export function Widget(props: { on: boolean; size: string; id: string }) {',
    '  return (',
    '    <div',
    "      className={clsx('dg-widget', props.on && 'dg-is-on', SIZE_CLASS.big)}",
    '      id="dg-not-a-class"',
    '      aria-label={`dg-not-a-class-either ${props.id}`}',
    '    >',
    '      <span className="dg-widget__label dg-widget__icon" />',
    '      <span className="dg-widget__missing" />',
    '      <span className={`dg-widget--${props.size}`} />',
    '      <span className="dg-published-and-emitted" />',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n'),
);

writeTreeFile(
  'src/components/Widget.test.tsx',
  "export const TEST_ONLY = 'dg-emitted-only-by-a-test';\n",
);

writeTreeFile(
  'src/styles/base.css',
  '.dg-published,\n.dg-published-and-emitted {\n  flex: none;\n}\n',
);

writeTreeFile(
  'src/styles/components.css',
  [
    '/* .dg-selected-only-in-a-comment { } */',
    '.dg-widget,',
    '.dg-widget--big {',
    '  display: flex;',
    '}',
    '',
    '.dg-widget.dg-is-on .dg-widget__label {',
    '  color: var(--dg-accent);',
    '}',
    '',
    '@media (prefers-reduced-motion: reduce) {',
    '  .dg-widget__icon {',
    '    animation: none;',
    '  }',
    '}',
    '',
    '.dg-orphaned-rule {',
    '  flex: none;',
    '}',
    '',
  ].join('\n'),
);

/** The published list the synthetic tree is checked against. */
const SYNTHETIC_PUBLISHED = {
  'dg-published': 'a host surface applies it',
  'dg-published-and-emitted': 'listed, although a module emits it',
  'dg-published-but-gone': 'promised, but no selector names it',
} as const;

/* -------------------------------------------------------------------------- */
/* The package's own tree                                                     */
/* -------------------------------------------------------------------------- */

describe('the stylesheet and its components', () => {
  it('share one class inventory, with nothing unstyled and nothing orphaned', async () => {
    const { inventory, findings } = await check.checkCssClasses();

    expect(
      findings.map((finding) => `${finding.site.file}: ${finding.rule}: ${finding.className}`),
      'the class inventory drifted: run `node scripts/check-css-classes.mjs` for the full report',
    ).toEqual([]);
    expect(inventory.emitted.size, 'no emitted class was found at all').toBeGreaterThan(0);
    expect(inventory.selected.size, 'no selector class was found at all').toBeGreaterThan(0);
  });

  it('publishes only classes the stylesheet actually defines and no module emits', async () => {
    const { inventory } = await check.checkCssClasses();

    for (const className of Object.keys(check.PUBLISHED_CLASSES)) {
      expect(inventory.selected.has(className), `${className} has no selector`).toBe(true);
      expect(
        inventory.emitted.has(className),
        `${className} is emitted by a module, so it no longer needs to be published`,
      ).toBe(false);
    }
  });

  it('passes as a command, exiting 0', async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    await expect(check.main([], { stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(0);
    expect(stdout.text()).toContain('class inventory consistent');
    expect(stderr.text()).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* The check's own behaviour                                                  */
/* -------------------------------------------------------------------------- */

describe('the class inventory check', () => {
  const run = () => check.checkCssClasses({ root: SANDBOX, published: SYNTHETIC_PUBLISHED });

  it('reports each kind of drift exactly once, and nothing else', async () => {
    const { findings } = await run();

    expect(findings.map((finding) => [finding.rule, finding.className])).toEqual([
      ['unstyled-class', 'dg-widget__missing'],
      ['unreferenced-class', 'dg-orphaned-rule'],
      ['published-missing', 'dg-published-but-gone'],
      ['published-emitted', 'dg-published-and-emitted'],
      ['interpolated-class', 'dg-widget--'],
    ]);
  });

  it('points each finding at the line it is about', async () => {
    const { findings } = await run();
    const siteOf = (rule: Finding['rule']) => findings.find((f) => f.rule === rule)?.site;

    expect(siteOf('unstyled-class')).toEqual({ file: 'src/components/Widget.tsx', line: 14 });
    expect(siteOf('unreferenced-class')).toEqual({ file: 'src/styles/components.css', line: 17 });
    expect(siteOf('published-emitted')).toEqual({ file: 'src/components/Widget.tsx', line: 16 });
    expect(siteOf('interpolated-class')).toEqual({ file: 'src/components/Widget.tsx', line: 15 });
  });

  it('reads classes from every emitting form and every selector form', async () => {
    const { inventory } = await run();

    // className strings, clsx arguments, a lookup table, a compound selector,
    // a grouped selector and a rule nested in a grouping at-rule.
    for (const className of [
      'dg-widget',
      'dg-widget--big',
      'dg-widget__label',
      'dg-widget__icon',
      'dg-is-on',
    ]) {
      expect(inventory.emitted.has(className), `${className} emitted`).toBe(true);
      expect(inventory.selected.has(className), `${className} selected`).toBe(true);
    }
  });

  it('ignores comments, non-class attributes and test modules', async () => {
    const { inventory } = await run();

    for (const className of [
      'dg-widget__from-a-comment',
      'dg-not-a-class',
      'dg-not-a-class-either',
      'dg-emitted-only-by-a-test',
    ]) {
      expect(inventory.emitted.has(className), `${className} must not count as emitted`).toBe(
        false,
      );
    }
    expect(inventory.selected.has('dg-selected-only-in-a-comment')).toBe(false);
  });

  it('fails as a command with exit 1 and one line per finding', async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    await expect(
      check.main([], { root: SANDBOX, stdout: stdout.stream, stderr: stderr.stream }),
    ).resolves.toBe(1);

    const report = stderr.text();
    expect(report).toContain('src/components/Widget.tsx:14: unstyled-class:');
    expect(report).toContain('src/styles/components.css:17: unreferenced-class:');
    expect(report).toContain('interpolated-class:');
    expect(stdout.text()).toBe('');
  });

  it('refuses an unknown argument with exit 2', async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    await expect(
      check.main(['--no-such-flag'], { stdout: stdout.stream, stderr: stderr.stream }),
    ).resolves.toBe(2);
    expect(stderr.text()).toContain('unrecognised argument: --no-such-flag');
  });
});

/* -------------------------------------------------------------------------- */
/* Class names assembled at run time                                          */
/* -------------------------------------------------------------------------- */

/** The stylesheets every assembly tree shares: they style the one static class. */
const ASSEMBLY_STYLESHEETS = {
  'src/styles/base.css': '.dg-assembled {\n  flex: none;\n}\n',
  'src/styles/components.css': '.dg-assembled {\n  display: flex;\n}\n',
} as const;

/**
 * Writes one package tree whose only module holds `body`, and returns its root.
 * The module also emits the one static class the shared stylesheets select, so
 * that the only finding a tree can produce is the one its case is about.
 *
 * @param name the tree's directory under the sandbox
 * @param body the module's source
 */
function writeAssemblyTree(name: string, body: string): string {
  writeTreeFile(
    `${name}/src/components/Assembled.tsx`,
    `export const STATIC_CLASS = 'dg-assembled';\n\n${body}`,
  );
  for (const [rel, text] of Object.entries(ASSEMBLY_STYLESHEETS)) {
    writeTreeFile(`${name}/${rel}`, text);
  }
  return path.join(SANDBOX, name);
}

/**
 * Every form in which a module can complete a `dg-*` class name at run time,
 * with the fragment the check must report. Two of them show no complete name
 * at all — only the `dg-` prefix — which is exactly the case a check matching
 * whole names would pass silently.
 */
const ASSEMBLY_FORMS = [
  {
    form: 'a bare prefix in a template literal',
    expression: '`dg-${props.kind}`',
    fragment: 'dg-',
  },
  {
    form: 'a bare prefix concatenated with +',
    expression: "'dg-' + props.kind",
    fragment: 'dg-',
  },
  {
    form: 'a modifier prefix concatenated with +',
    expression: "'dg-assembled--' + props.kind",
    fragment: 'dg-assembled--',
  },
  {
    form: 'a name concatenated onto an expression',
    expression: "props.kind + 'dg-tail'",
    fragment: 'dg-tail',
  },
  {
    form: 'a prefix concatenated inside parentheses',
    expression: "'dg-assembled ' + ('dg-assembled__' + props.kind)",
    fragment: 'dg-assembled__',
  },
] as const;

describe('the class inventory check, on class names assembled at run time', () => {
  it.each(ASSEMBLY_FORMS)('fails the gate for $form', async ({ form, expression, fragment }) => {
    const root = writeAssemblyTree(
      `assembled-${String(ASSEMBLY_FORMS.findIndex((entry) => entry.form === form))}`,
      [
        'export function Assembled(props: { kind: string }) {',
        `  return <div className={${expression}} />;`,
        '}',
        '',
      ].join('\n'),
    );

    const { findings } = await check.checkCssClasses({ root, published: {} });
    expect(findings.map((finding) => [finding.rule, finding.className])).toEqual([
      ['interpolated-class', fragment],
    ]);

    const stdout = captureStream();
    const stderr = captureStream();
    await expect(
      check.main([], { root, stdout: stdout.stream, stderr: stderr.stream }),
    ).resolves.toBe(1);
    expect(stderr.text()).toContain(`interpolated-class: "${fragment}"`);
  });

  it('reads a class appended with += as assembled', async () => {
    const root = writeAssemblyTree(
      'assembled-append',
      [
        'export function assembledClass(kind: string): string {',
        '  let className = kind;',
        "  className += 'dg-appended';",
        '  return className;',
        '}',
        '',
      ].join('\n'),
    );

    const { findings } = await check.checkCssClasses({ root, published: {} });
    expect(findings.map((finding) => [finding.rule, finding.className])).toEqual([
      ['interpolated-class', 'dg-appended'],
    ]);
  });

  it('leaves static names, custom-property names and non-class attributes alone', async () => {
    const root = writeAssemblyTree(
      'assembled-negative',
      [
        'export const tokenName = (key: string): string => `--dg-${key}`;',
        "export const tokenNameJoined = (key: string): string => '--dg-' + key;",
        '',
        'export function Assembled(props: { kind: string; name: string }) {',
        '  return (',
        "    <div className={'dg-assembled ' + props.kind} title={'dg-open ' + props.name}>",
        '      <span className={`dg-assembled ${props.kind}`} />',
        '    </div>',
        '  );',
        '}',
        '',
      ].join('\n'),
    );

    const { inventory, findings } = await check.checkCssClasses({ root, published: {} });
    expect(findings).toEqual([]);
    expect([...inventory.emitted.keys()]).toEqual(['dg-assembled']);
  });
});
