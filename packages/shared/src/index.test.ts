/**
 * Tests for `./index.ts` — the entry boundary of `@debuggen/shared`.
 *
 * This suite is not about behaviour. Every function behind the barrel has its
 * own colocated suite; what is on trial here is the one property of this
 * package that no other test can observe and that the compiler is happy to let
 * go: **the `"."` entry is browser-safe.**
 *
 * Why that needs a test of its own. `@debuggen/shared` publishes two entries
 * (AAP §0.2.2): `"."`, which is bundled into the MAIN-world telemetry agent
 * injected into the inspected page at `document_start`, into the DevTools panel
 * and into the editor webview; and `"./node"`, which holds the SHA-256/HMAC
 * hashing and the hardened `0700`/`0600` filesystem creator and therefore needs
 * `node:crypto` and `node:fs`. A single `export * from './node/index.js'` added
 * to the barrel for convenience would type-check, build, and pass every
 * behavioural test in this package — and then fail in a page, at
 * `document_start`, where no bundler polyfill can cover for a platform builtin.
 * That failure would land in AAP §0.8.1 slice 6 (browser capture), several
 * layers away from its cause, with nothing pointing back here.
 *
 * So the suite has two halves, and they fail in two different places.
 *
 * 1. **A static scan** (`describe('the "." entry is browser-safe')`). The
 *    modules behind the barrel are read from disk as text and searched for a
 *    platform dependency: a `node:` specifier, a bare Node built-in specifier,
 *    a `require(` call, or a specifier reaching into `./node/`. Reading the
 *    source rather than importing it is the point — an import would resolve
 *    happily under Vitest's Node environment, which is exactly the environment
 *    the browser does not provide.
 * 2. **A surface check** (`describe('the barrel surface')`). The barrel is
 *    imported and its runtime exports are compared against the documented set,
 *    in both directions: every documented symbol must be there, nothing else
 *    may be, none of the Node-only symbols may be, there is no default export,
 *    and importing it must produce no observable side effect.
 *
 * Three details of how the scan works are load-bearing.
 *
 * - **Comments are blanked before matching; string literals are not.** The
 *   modules discuss `node:crypto`, `node:path` and `node:sqlite` at length in
 *   their documentation — `paths.ts` alone has five such mentions, all prose
 *   explaining why it does *not* use them. A bare substring search for `node:`
 *   would report every one of those and the guard would be turned off within a
 *   week. A specifier, meanwhile, only ever appears inside quotes, so string
 *   contents have to survive masking for the scan to see anything at all.
 * - **A specifier is recognised by its context, not by its content.** Only a
 *   top-level string literal preceded by `from`, `import` or `require` counts,
 *   which is what keeps a quoted example *inside* a longer string (a hint that
 *   reads `import { sha256Hex } from '@debuggen/shared/node'`, say) from being
 *   read as an import of that module.
 * - **Regex literals are blanked too.** A pattern such as `/['"]/` would
 *   otherwise open a string state that swallows the rest of the file, turning a
 *   real violation invisible. The masker also asserts its own invariants — it
 *   preserves length and line breaks, and it must end in code state — so a
 *   scanning bug fails loudly instead of passing quietly.
 *
 * `node:fs`, `node:module`, `node:path` and `node:url` are imported freely
 * *here* for the same reason the constraint does not apply to this file: a test
 * is never one of the package's two tsup entries, so nothing it imports can
 * reach a browser bundle. The paths it reads are resolved from
 * `import.meta.url`, never from `process.cwd()`, because the working directory
 * differs between `pnpm --filter @debuggen/shared test` and a root `pnpm test`
 * while the location of this file relative to its siblings never does.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import * as api from './index.js';

/*
 * ---------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------
 */

/**
 * The directory holding the modules behind the `"."` entry — this file's own
 * directory, `packages/shared/src`.
 *
 * Resolved as `fileURLToPath` **then** `dirname`, deliberately not
 * `new URL('.', import.meta.url)`: the string form goes through Node's own
 * parser, so the same two lines keep working if this package's Vitest project
 * ever moves to a DOM environment, where the global `URL` resolves a relative
 * specifier against the document origin instead of the `file:` base it was
 * given.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** How a scanned file is named in a failure message, given its file name. */
function labelFor(fileName: string): string {
  return 'packages/shared/src/' + fileName;
}

/**
 * The modules the scan expects to find, by base name.
 *
 * This is the self-check that keeps the guard honest: a glob that stopped
 * matching, a directory that moved or an `exclude` that grew too greedy would
 * otherwise leave the scan with nothing to look at and every assertion below
 * would pass on an empty set. The list is the eight modules the barrel
 * re-exports plus the barrel itself, and it is a *subset* assertion — a new
 * sibling module is scanned the moment it lands, without a test edit.
 */
const EXPECTED_MODULE_BASENAMES: readonly string[] = [
  'assert',
  'errors',
  'ids',
  'index',
  'logger',
  'paths',
  'result',
  'source-location',
  'time',
];

/**
 * Every symbol the `"."` entry exports at run time, grouped by the module it
 * comes from and listed in the barrel's re-export order.
 *
 * Only *values* appear here. The barrel forwards types as well
 * (`Result`, `SourceLocation`, `Logger`, the branded id aliases and the rest),
 * and those are checked by the typecheck gate — `tsc -b` compiles this file,
 * and the suites of the individual modules import each type by name — but they
 * leave no trace on the namespace object at run time, so asserting on them
 * here is not possible and their absence from this list is not a gap.
 *
 * The list is exhaustive on purpose rather than illustrative: it is compared
 * against the namespace in both directions below, so it doubles as the
 * package's published-surface inventory. A symbol added to a module behind the
 * barrel is added here in the same commit.
 */
const EXPECTED_EXPORTS: readonly string[] = [
  // ./errors.js — the closed error-code vocabulary and its carrier.
  'DEBUGGEN_ERROR_CODES',
  'DebuggenError',

  // ./result.js — Result<T, E> and its combinators.
  'ok',
  'err',
  'isOk',
  'isErr',
  'unwrap',
  'unwrapOr',
  'map',
  'mapErr',
  'andThen',
  'tryCatch',
  'fromPromise',
  'collect',

  // ./assert.js — invariant checks kept in production builds.
  'assert',
  'assertDefined',
  'assertNever',
  'fail',

  // ./ids.js — trace/span ids, prefixed entity ids, and their guards.
  'TRACE_ID_PATTERN',
  'SPAN_ID_PATTERN',
  'isTraceId',
  'isSpanId',
  'newTraceId',
  'newSpanId',
  'ID_PREFIXES',
  'newId',
  'newSessionId',
  'newCaptureId',
  'newPanelId',
  'newAnalysisId',
  'newModificationId',
  'newActionId',
  'newEventId',
  'newMessageId',
  'newProducerId',

  // ./time.js — the epoch-millisecond time base every tier normalises to.
  'nowEpochMs',
  'nowEpochMsPrecise',
  'hrTimeToEpochMs',
  'epochMsToHrTime',
  'hrTimeDurationMs',
  'performanceToEpochMs',
  'roundMs',
  'clampNonNegative',
  'isoFromEpochMs',
  'epochMsFromIso',

  // ./paths.js — POSIX-only path handling and the containment gate.
  'toPosix',
  'normalizePosix',
  'isAbsolutePosix',
  'isWindowsAbsolute',
  'joinPosix',
  'relativePosix',
  'dirnamePosix',
  'basenamePosix',
  'extnamePosix',
  'isSafeRelativePath',
  'isWithin',
  'toProjectRelative',
  'resolveWithinProject',

  // ./logger.js — the Logger interface, its levels and two implementations.
  'LOG_LEVELS',
  'LOG_LEVEL_VALUES',
  'isLevelEnabled',
  'createConsoleLogger',
  'noopLogger',

  // ./source-location.js — the one source-location schema definition.
  'SOURCE_RESOLVED_BY',
  'DEFAULT_RESOLUTION_CONFIDENCE',
  'sourceLocationSchema',
  'parseSourceLocation',
  'isSourceLocation',
  'formatSourceLocation',
];

/**
 * The `"./node"` entry's surface, which must NOT appear on the `"."` entry.
 *
 * Named one by one rather than inferred, so the assertion states the boundary
 * it protects instead of restating the symmetric "nothing unexpected" check
 * above: these are the symbols whose presence here would mean `node:crypto` and
 * `node:fs` had been pulled into the page agent's bundle.
 */
const NODE_ONLY_EXPORTS: readonly string[] = [
  // ./node/hash.js
  'sha256Hex',
  'sha256OfFile',
  'sha256OfFileSync',
  'stableHash',
  'hmacSha256Hex',

  // ./node/safe-fs.js
  'SECURE_DIR_MODE',
  'SECURE_FILE_MODE',
  'assertSecureDir',
  'ensureSecureDir',
  'createFileExclusive',
  'writeSecureFileAtomic',
  'atomicReplaceFile',
  'readFileNoFollow',
];

/** Console methods a module could plausibly reach for at load time. */
const CONSOLE_METHODS = ['debug', 'error', 'info', 'log', 'trace', 'warn'] as const;

/*
 * ---------------------------------------------------------------------------
 * Source masking
 * ---------------------------------------------------------------------------
 *
 * The masker turns a TypeScript source into two things: a `codeOnly` view in
 * which comment bodies, string contents and regex bodies are replaced by
 * spaces, and the list of the top-level string literals it passed through.
 * Line breaks and total length are preserved in the masked view, so an index
 * into it is an index into the original file and a reported line number is the
 * line a developer opens.
 */

/** One string literal opened directly from code (never one nested in another). */
interface StringLiteral {
  /** Index of the opening quote in the original source. */
  readonly start: number;
  /** Raw text between the quotes, with escape sequences left uninterpreted. */
  readonly value: string;
}

/** The masked view of a source file plus the literals found in it. */
interface MaskedSource {
  readonly codeOnly: string;
  readonly stringLiterals: readonly StringLiteral[];
}

/**
 * Characters after which a `/` opens a regex literal rather than dividing.
 *
 * `)` and `]` are deliberately absent: `(a + b) / 2` and `values[i] / total`
 * are divisions, and misreading one as a regex would blank real code. The
 * inverse mistake — reading a regex as a division — is caught by the
 * end-of-scan state invariant rather than by widening this set.
 */
const REGEX_PRECEDING_PUNCTUATION = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
  '{',
  '}',
  ';',
]);

/** Keywords after which a `/` opens a regex literal (`return /x/.test(s)`). */
const REGEX_PRECEDING_KEYWORD =
  /(?:^|[^\w$])(?:return|typeof|case|in|of|instanceof|new|delete|void|do|else|yield|await)$/;

/** Whether the `/` following `codeTail` opens a regex literal. */
function startsRegexLiteral(codeTail: string): boolean {
  const trimmed = codeTail.replace(/\s+$/, '');
  if (trimmed.length === 0) {
    // Start of file, or of a line whose preceding context has scrolled out of
    // the tail buffer: a statement position, where `/` cannot be division.
    return true;
  }

  const last = trimmed.charAt(trimmed.length - 1);
  return REGEX_PRECEDING_PUNCTUATION.has(last) || REGEX_PRECEDING_KEYWORD.test(trimmed);
}

/**
 * Masks comment bodies, string contents and regex bodies with spaces while
 * recording every top-level string literal.
 *
 * @throws Error when the scan does not end in code state, which means an
 *   unterminated comment, string or regex literal — or a masker bug. Either way
 *   the scan's result cannot be trusted, and a thrown error fails the test that
 *   asked for it instead of letting an unscanned file pass.
 */
function maskSource(source: string, label: string): MaskedSource {
  const literals: StringLiteral[] = [];
  let masked = '';
  let state: 'code' | 'lineComment' | 'blockComment' | 'string' | 'regex' = 'code';
  /** Last 32 emitted code characters, for the regex-versus-division decision. */
  let codeTail = '';
  let quote = '';
  let literalStart = 0;
  let literalValue = '';
  let inCharClass = false;

  /** One space per masked character, so indices and line numbers survive. */
  const blank = (character: string): string => {
    if (character === '\n') {
      return '\n';
    }
    return character === '' ? '' : ' ';
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index);
    // `charAt` past the end returns '', so an escape at the very last byte of a
    // file consumes nothing extra and the masked view keeps its length.
    const next = index + 1 < source.length ? source.charAt(index + 1) : '';

    if (state === 'code') {
      if (character === '/' && next === '/') {
        state = 'lineComment';
        masked += '  ';
        index += 1;
      } else if (character === '/' && next === '*') {
        state = 'blockComment';
        masked += '  ';
        index += 1;
      } else if (character === '/' && startsRegexLiteral(codeTail)) {
        state = 'regex';
        inCharClass = false;
        masked += ' ';
      } else if (character === "'" || character === '"' || character === '`') {
        state = 'string';
        quote = character;
        literalStart = index;
        literalValue = '';
        masked += ' ';
      } else {
        masked += character;
        codeTail = (codeTail + character).slice(-32);
      }
      continue;
    }

    if (state === 'lineComment') {
      if (character === '\n') {
        state = 'code';
        codeTail = '';
      }
      masked += blank(character);
      continue;
    }

    if (state === 'blockComment') {
      if (character === '*' && next === '/') {
        state = 'code';
        masked += '  ';
        index += 1;
      } else {
        masked += blank(character);
      }
      continue;
    }

    if (state === 'regex') {
      if (character === '\\') {
        masked += blank(character) + blank(next);
        index += 1;
      } else if (character === '[') {
        inCharClass = true;
        masked += ' ';
      } else if (character === ']') {
        inCharClass = false;
        masked += ' ';
      } else if (character === '/' && !inCharClass) {
        state = 'code';
        masked += ' ';
        codeTail = (codeTail + 'x').slice(-32);
      } else {
        masked += blank(character);
      }
      continue;
    }

    // state === 'string'
    if (character === '\\') {
      literalValue += character + next;
      masked += blank(character) + blank(next);
      index += 1;
    } else if (character === quote) {
      state = 'code';
      literals.push({ start: literalStart, value: literalValue });
      masked += ' ';
      codeTail = (codeTail + 'x').slice(-32);
    } else {
      literalValue += character;
      masked += blank(character);
    }
  }

  if (state !== 'code') {
    throw new Error(
      'Masking ' +
        label +
        ' ended in ' +
        state +
        ' state, so its scan cannot be trusted. Either the file has an ' +
        'unterminated comment, string or regex literal, or the masker in ' +
        labelFor('index.test.ts') +
        ' mis-read one (a regex literal read as a division is the usual cause).',
    );
  }

  return { codeOnly: masked, stringLiterals: literals };
}

/*
 * ---------------------------------------------------------------------------
 * Violation detection
 * ---------------------------------------------------------------------------
 */

/** One platform dependency found in a scanned file. */
interface Violation {
  /** Index in the original source, used only to order findings stably. */
  readonly index: number;
  readonly line: number;
  readonly reason: string;
  /** The line as written, so the failure message names what has to change. */
  readonly text: string;
}

/** Bare specifiers that resolve to a Node built-in, from the running runtime. */
const NODE_BUILTIN_SPECIFIERS = new Set(builtinModules.filter((name) => !name.startsWith('node:')));

/** A specifier reaching the Node-only entry: `./node`, `./node/hash.js`, … */
const NODE_ENTRY_SPECIFIER = /^\.{1,2}\/node(?:\/.*)?$/;

/** A module specifier position: `from '…'`, `import '…'`, `require('…')`. */
const SPECIFIER_CONTEXT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*$/;

/** A CommonJS require call. */
const REQUIRE_CALL = /\brequire\s*\(/g;

/** The 1-based line number of `index` within `source`. */
function lineAt(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source.charAt(cursor) === '\n') {
      line += 1;
    }
  }
  return line;
}

/** The line containing `index`, trimmed, for a failure message. */
function textAt(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

/** One module specifier, with where it was written. */
interface Specifier {
  readonly index: number;
  readonly value: string;
}

/**
 * Every module specifier in a masked source.
 *
 * A specifier is a top-level string literal whose immediately preceding code is
 * a specifier position, which is what distinguishes the real thing from a
 * specifier quoted *inside* a longer string — and comment bodies were blanked
 * before this ran, so a `node:` mention in prose is invisible here. The window
 * looked at is the 64 characters before the quote, which is ample: the pattern
 * is anchored at the end, so only the tail of a multi-line `import { … } from`
 * ever has to fit.
 */
function moduleSpecifiers(masked: MaskedSource): Specifier[] {
  return masked.stringLiterals
    .filter((literal) =>
      SPECIFIER_CONTEXT.test(masked.codeOnly.slice(Math.max(0, literal.start - 64), literal.start)),
    )
    .map((literal) => ({ index: literal.start, value: literal.value }));
}

/** Every platform dependency in one scanned module. */
function findPlatformDependencies(source: string, masked: MaskedSource): Violation[] {
  const violations: Violation[] = [];

  const record = (index: number, reason: string): void => {
    violations.push({ index, line: lineAt(source, index), reason, text: textAt(source, index) });
  };

  for (const { index, value } of moduleSpecifiers(masked)) {
    if (value.startsWith('node:')) {
      record(index, "a `node:` module specifier ('" + value + "')");
    } else if (NODE_BUILTIN_SPECIFIERS.has(value)) {
      record(index, "a bare Node built-in specifier ('" + value + "')");
    } else if (NODE_ENTRY_SPECIFIER.test(value)) {
      record(index, "a specifier reaching the Node-only entry ('" + value + "')");
    }
  }

  for (const match of masked.codeOnly.matchAll(REQUIRE_CALL)) {
    record(match.index, 'a require() call');
  }

  return violations.sort((left, right) => left.index - right.index);
}

/** Renders violations so a failure names every line that has to change. */
function describeViolations(label: string, violations: readonly Violation[]): string {
  return violations
    .map(
      (violation) =>
        label + ':' + violation.line + ' has ' + violation.reason + '\n    ' + violation.text,
    )
    .join('\n');
}

/*
 * ---------------------------------------------------------------------------
 * The scanned set
 * ---------------------------------------------------------------------------
 */

/** One module behind the `"."` entry, read from disk as text. */
interface ScannedModule {
  readonly fileName: string;
  readonly basename: string;
  readonly label: string;
  readonly source: string;
  readonly masked: MaskedSource;
}

/**
 * Every `*.ts` directly inside `src`, excluding the colocated `*.test.ts`
 * suites and everything under `src/node`.
 *
 * `readdirSync` without `recursive` is what excludes `src/node`: the directory
 * arrives as a single non-file entry and is skipped, so the exclusion is a
 * property of the traversal rather than a pattern that could drift. Tests are
 * excluded because they are not part of either published entry — this file
 * imports `node:fs` itself.
 */
function scanBrowserSafeModules(): ScannedModule[] {
  return readdirSync(SRC_DIR, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => {
      const label = labelFor(entry.name);
      const source = readFileSync(join(SRC_DIR, entry.name), 'utf8');
      return {
        fileName: entry.name,
        basename: entry.name.slice(0, -'.ts'.length),
        label,
        source,
        masked: maskSource(source, label),
      };
    })
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

const BROWSER_SAFE_MODULES = scanBrowserSafeModules();

/** The barrel itself, singled out for the targeted `./node/` check. */
const BARREL = BROWSER_SAFE_MODULES.find((module) => module.basename === 'index');

/*
 * ---------------------------------------------------------------------------
 * Suites
 * ---------------------------------------------------------------------------
 */

describe('the "." entry is browser-safe', () => {
  it('scanned the modules behind the barrel', () => {
    // Without this, every assertion in this describe block would pass on an
    // empty set the day the traversal stopped finding files.
    expect(BROWSER_SAFE_MODULES.length).toBeGreaterThan(0);

    const basenames = BROWSER_SAFE_MODULES.map((module) => module.basename);
    const missing = EXPECTED_MODULE_BASENAMES.filter((name) => !basenames.includes(name));

    expect(
      missing,
      'The scan of ' +
        SRC_DIR +
        ' found [' +
        basenames.join(', ') +
        '] and so missed [' +
        missing.join(', ') +
        ']. Every module behind the "." entry must be scanned; if one was ' +
        'renamed, update EXPECTED_MODULE_BASENAMES in the same commit.',
    ).toEqual([]);

    for (const module of BROWSER_SAFE_MODULES) {
      expect(module.source.length, module.label + ' was read as an empty file').toBeGreaterThan(0);
    }
  });

  it('excludes the test suites and the Node-only entry from the scan', () => {
    const scanned = BROWSER_SAFE_MODULES.map((module) => module.fileName);

    expect(
      scanned.filter((fileName) => fileName.endsWith('.test.ts')),
      'Test files are not part of either published entry and must not be scanned: ' +
        'this suite imports node:fs itself, so scanning tests would make the guard ' +
        'fail on its own tooling.',
    ).toEqual([]);

    expect(
      scanned.filter((fileName) => fileName === 'node' || fileName.includes('/')),
      'The scan must stay directly inside ' +
        SRC_DIR +
        ': src/node is the Node-only entry, where node:crypto and node:fs are ' +
        'expected rather than forbidden.',
    ).toEqual([]);
  });

  it.each(
    BROWSER_SAFE_MODULES.map((module) => ({
      label: module.label,
      module,
    })),
  )('$label declares no platform dependency', ({ label, module }) => {
    const violations = findPlatformDependencies(module.source, module.masked);

    expect(
      violations,
      label +
        ' is behind the "." entry, which is bundled into the MAIN-world ' +
        'telemetry agent, the DevTools panel and the editor webview, so it may ' +
        'not reach for a platform builtin (AAP 0.2.2). Move the code that ' +
        'needs one into src/node, behind the "./node" entry:\n' +
        describeViolations(label, violations),
    ).toEqual([]);
  });

  it('never re-exports the Node-only entry from the barrel', () => {
    // Targeted rather than incidental: this is the single edit most likely to
    // be made in good faith - one import path instead of two - and the one
    // whose consequence is worst.
    expect(
      BARREL,
      'The barrel ' + labelFor('index.ts') + ' was not found by the scan',
    ).toBeDefined();

    const barrel = BARREL;
    if (barrel === undefined) {
      return;
    }

    const reExports = moduleSpecifiers(barrel.masked)
      .filter(({ value }) => NODE_ENTRY_SPECIFIER.test(value))
      .map(
        ({ index, value }) =>
          barrel.label + ':' + lineAt(barrel.source, index) + " → '" + value + "'",
      );

    expect(
      reExports,
      labelFor('index.ts') +
        ' must not re-export anything under ./node/. One such re-export pulls ' +
        'node:crypto (hashing) and node:fs (the secure filesystem creator) into ' +
        'the browser agent bundle, which then fails to load at document_start ' +
        'and takes browser capture (AAP 0.8.1 slice 6) with it. A consumer that ' +
        'needs both entries imports both: `import { sha256Hex } from ' +
        "'@debuggen/shared/node'`. Found:\n" +
        reExports.join('\n'),
    ).toEqual([]);
  });

  it('sees through prose and quoted examples while still catching real imports', () => {
    // The scan's passing result is only worth something if it would fail. This
    // exercises the masker and the matcher on a source carrying one of every
    // shape that must be caught and one of every shape that must be ignored -
    // including the two that actually occur in this package: `node:` in a TSDoc
    // comment (five times in paths.ts) and a regex literal.
    const synthetic = [
      "// import { createHash } from 'node:crypto';", // 1 comment - ignored
      "/* see `from 'node:fs'` in the docs */ const documented = 1;", // 2 ignored
      'const hint = "import { sha256Hex } from \'@debuggen/shared/node\'";', // 3 ignored
      'const quoted = /[\'"]/;', // 4 regex with quotes - must not open a string
      "import { createHash } from 'node:crypto';", // 5 node: specifier
      "const fsModule = require('fs');", // 6 require() AND a bare builtin
      "const lazy = import('node:fs/promises');", // 7 dynamic node: specifier
      "export * from './node/index.js';", // 8 the Node-only entry
      "import { z } from 'zod';", // 9 a dependency - allowed
      "export * from './errors.js';", // 10 a sibling - allowed
    ].join('\n');

    const masked = maskSource(synthetic, 'the synthetic fixture');

    // Masking moves no character and no line, so reported lines are real.
    expect(masked.codeOnly).toHaveLength(synthetic.length);
    expect(masked.codeOnly.split('\n')).toHaveLength(10);

    const violations = findPlatformDependencies(synthetic, masked);

    expect(violations.map((violation) => violation.line)).toEqual([5, 6, 6, 7, 8]);
    expect(violations.map((violation) => violation.reason)).toEqual([
      "a `node:` module specifier ('node:crypto')",
      'a require() call',
      "a bare Node built-in specifier ('fs')",
      "a `node:` module specifier ('node:fs/promises')",
      "a specifier reaching the Node-only entry ('./node/index.js')",
    ]);
    expect(describeViolations('fixture.ts', violations)).toContain('fixture.ts:5');
  });

  it('refuses to report a scan it could not complete', () => {
    // An unterminated literal means the masker lost track of the source, so the
    // result must be an error rather than a clean bill of health.
    expect(() => maskSource("const unterminated = 'oops;", 'the synthetic fixture')).toThrow(
      /ended in string state/,
    );
    expect(() => maskSource('/* never closed', 'the synthetic fixture')).toThrow(
      /ended in blockComment state/,
    );
  });
});

describe('the barrel surface', () => {
  /** The barrel's runtime exports, as the namespace object presents them. */
  const exportedNames = new Set(Object.keys(api));

  it('lists each documented symbol exactly once', () => {
    // A duplicate would make the two comparisons below disagree about the size
    // of the surface without either of them failing.
    const duplicates = EXPECTED_EXPORTS.filter(
      (name, position) => EXPECTED_EXPORTS.indexOf(name) !== position,
    );

    expect(duplicates, 'EXPECTED_EXPORTS lists a symbol twice').toEqual([]);
  });

  it('exports every documented symbol', () => {
    const missing = EXPECTED_EXPORTS.filter((name) => !exportedNames.has(name));

    expect(
      missing,
      'The "." entry is missing [' +
        missing.join(', ') +
        ']. Every workspace in the monorepo imports this entry, so a symbol ' +
        'that disappears from it breaks consumers at build time; if it moved ' +
        'deliberately, update EXPECTED_EXPORTS and the consumers together.',
    ).toEqual([]);
  });

  it('exports nothing beyond the documented symbols', () => {
    const unexpected = [...exportedNames].filter((name) => !EXPECTED_EXPORTS.includes(name));

    expect(
      unexpected,
      'The "." entry exports [' +
        unexpected.join(', ') +
        '], which is not in EXPECTED_EXPORTS. If the symbol is a deliberate ' +
        'addition to the browser-safe surface, add it to that list in the same ' +
        'commit; if it arrived through a re-export of src/node, remove the ' +
        're-export - see the browser-safety suite above.',
    ).toEqual([]);
  });

  it('exports none of the Node-only symbols', () => {
    const leaked = NODE_ONLY_EXPORTS.filter((name) => exportedNames.has(name));

    expect(
      leaked,
      'The "." entry exports [' +
        leaked.join(', ') +
        '], which belong to @debuggen/shared/node. They need node:crypto and ' +
        'node:fs, so their presence here means the browser agent bundle can no ' +
        'longer be built.',
    ).toEqual([]);

    // The Node entry really does own them, so the boundary is a split rather
    // than a deletion. Asserting on the list itself keeps the two halves of
    // this claim from drifting apart silently.
    expect(NODE_ONLY_EXPORTS).toContain('sha256Hex');
    expect(NODE_ONLY_EXPORTS).toContain('createFileExclusive');
  });

  it('has no default export', () => {
    // Named exports only: the barrel is `export *` over eight modules, and a
    // default would have to come from a hand-written re-export.
    expect(
      exportedNames.has('default'),
      'The "." entry has a default export. The barrel is named-exports-only, ' +
        'so every consumer imports by name and a default would give the same ' +
        'symbol two spellings across the monorepo.',
    ).toBe(false);
  });

  it('evaluates with no observable side effect', async () => {
    // AAP 0.2.2 requires `"sideEffects": false` to be true of this entry, so a
    // bundler may drop whatever a consumer does not use. Console output is the
    // side effect a module actually tends to acquire (a stray debug line, an
    // eager configuration warning), and it is the one observable here.
    //
    // `vi.resetModules()` before a dynamic import is what makes the spies
    // meaningful: without it the statically imported module above is already
    // evaluated and cached, so nothing would run inside the spied window.
    // Measured under Vitest 5.0.1: after the reset the dynamic import returns a
    // different namespace object, which is re-evaluation. A cache-busting
    // `?query` on the specifier - the other way to force it - is rejected by
    // Vite as a non-analysable dynamic import, so it is not used.
    const spies = CONSOLE_METHODS.map((method) => ({
      method,
      spy: vi.spyOn(console, method).mockImplementation(() => undefined),
    }));

    try {
      vi.resetModules();
      const reloaded = await import('./index.js');

      // Proves the import above actually loaded the module rather than being
      // served from a cache the reset was supposed to clear.
      expect([...Object.keys(reloaded)].sort()).toEqual([...exportedNames].sort());

      const noisy = spies
        .filter(({ spy }) => spy.mock.calls.length > 0)
        .map(({ method }) => method);

      expect(
        noisy,
        'Importing the "." entry wrote to console.' +
          noisy.join(', console.') +
          '. Loading this package must do nothing: it is imported by the page ' +
          'agent, the DevTools panel, the editor webview, the local service and ' +
          'the repository scripts alike, none of which asked for output.',
      ).toEqual([]);
    } finally {
      for (const { spy } of spies) {
        spy.mockRestore();
      }
    }
  });
});
