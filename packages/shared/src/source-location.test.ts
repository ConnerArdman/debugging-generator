/**
 * Tests for `./source-location.ts`: the one validated description of where in
 * the developer's project a runtime item came from.
 *
 * This schema is a boundary five other layers stand on, and it is the only
 * definition of the shape each of them embeds — `TelemetryEvent.source` in
 * `@debuggen/telemetry`, the patcher's `ModificationRecord` in
 * `@debuggen/instrumentation`, the panel `sourceLink` node and
 * `Hypothesis.suggestedLocation` in `@debuggen/panel-schema`, and the
 * `source.open` message in `@debuggen/protocol`. Every one of those parses
 * through the schema under test here, so what this file pins is not a local
 * detail: it is what the whole click-to-source path is allowed to carry.
 *
 * Three different things are therefore on trial, and they fail in three
 * different places.
 *
 * 1. **`file` is a security boundary.** The refinement on it keeps an absolute
 *    developer path out of a panel, a screenshot and an outbound model prompt,
 *    and keeps a `'..'` traversal out of the `source.open` message that ends in
 *    a filesystem call. A hole in it is a path-disclosure or
 *    arbitrary-file-read hole two processes downstream, so every class of
 *    malformed path gets its own named case rather than one "rejects bad input"
 *    test.
 * 2. **The numeric contract.** `line` and `column` are 1-based integers and
 *    `confidence` is required and bounded. A `0` line silently selects the
 *    wrong region in the editor; an omitted `confidence` hands both user
 *    interfaces an unanswerable question, which is precisely why the field is
 *    required by design and why its absence is tested as a rejection rather
 *    than as a default.
 * 3. **The failure payload's privacy.** `parseSourceLocation` builds a
 *    `DebuggenError` whose `details` may be logged, persisted with a session
 *    and rendered — and the redaction layer never sees an error raised this
 *    deep in a call stack (AAP §0.5.2). The suite below feeds a recognisable
 *    sentinel through every rejection class and asserts it appears nowhere in
 *    the serialised details.
 *
 * Four habits in here are deliberate.
 *
 * - **Invalid inputs are typed `unknown`, never cast.** A rejection case that
 *   reached the parser through `as SourceLocation` would be testing a lie: the
 *   values this schema exists to refuse arrive from a WebSocket frame, a stored
 *   row or a model's structured output, where nothing has vouched for them.
 *   {@link mutate} and the literal tables below produce `unknown` for that
 *   reason.
 * - **Valid inputs are typed `SourceLocation`.** They are checked by the
 *   compiler on the way in and by the schema on the way through, so a field
 *   added to the schema without a value here fails `pnpm typecheck` in this
 *   file rather than at run time somewhere above it.
 * - **Tables with labels, one case per test.** `it.each` over a labelled table
 *   names the offending input in the failure line, so a regression reads as
 *   "rejects a NUL byte in the file path" rather than as an index.
 * - **Narrowing is exercised, not bypassed.** `isOk` and `isErr` from
 *   `./result.js` are how these tests reach `value` and `error`, so a guard
 *   that stopped narrowing fails the typecheck gate inside this file.
 *
 * Every sample value is generic (`src/lib/thing.ts`, `loadThing`,
 * `MyComponent`): `scripts/check-no-hardcoding.mjs` exists to keep knowledge of
 * the demo application out of `packages/**`, and a test fixture is no place to
 * start.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError, type DebuggenErrorCode } from './errors.js';
import { isErr, isOk, type Result } from './result.js';
import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  formatSourceLocation,
  isSourceLocation,
  parseSourceLocation,
  SOURCE_RESOLVED_BY,
  sourceLocationSchema,
  type SourceLocation,
  type SourceResolvedBy,
} from './source-location.js';

/*
 * ---------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------
 */

/** A representative project-relative file, written the way the product stores it. */
const SAFE_FILE = 'src/lib/thing.ts';

/** A representative function name, for the cases that carry a symbol. */
const SAFE_SYMBOL = 'loadThing';

/** A representative component name, for a location resolved from a React owner. */
const SAFE_COMPONENT = 'MyComponent';

/**
 * The one code every refusal reports.
 *
 * Typed as {@link DebuggenErrorCode} rather than left as a bare string literal,
 * so a code renamed in `errors.ts` fails this file at `pnpm typecheck` instead
 * of at run time.
 */
const REFUSAL_CODE: DebuggenErrorCode = 'PROTOCOL_INVALID_MESSAGE';

/**
 * The string the privacy suite hunts for in a serialised failure.
 *
 * Deliberately unmistakable and deliberately not a plausible file name: if it
 * ever shows up in `JSON.stringify(error.details)`, the only way it got there
 * is a rejected value having been copied into the payload.
 */
const LEAK_SENTINEL = 'do-not-leak-this-value';

/*
 * ---------------------------------------------------------------------------
 * Fixture shapes
 * ---------------------------------------------------------------------------
 */

/** A valid location the schema must accept unchanged, with a name for the title. */
interface AcceptedCase {
  readonly label: string;
  readonly location: SourceLocation;
}

/** A value the schema must refuse, with the issue path the refusal must report. */
interface RefusalCase {
  readonly label: string;
  readonly input: unknown;
  readonly path: string;
}

/** A rejection whose input carries {@link LEAK_SENTINEL} in the offending field. */
interface SentinelCase {
  readonly label: string;
  readonly input: unknown;
}

/** One `{ path, message }` pair as `parseSourceLocation` reports it. */
interface ReportedIssue {
  readonly path: string;
  readonly message: string;
}

/*
 * ---------------------------------------------------------------------------
 * Valid fixtures
 *
 * `MINIMAL` is the base every other case is derived from: the five required
 * fields and nothing else. It is annotated `SourceLocation` rather than left to
 * inference so the compiler checks it against the exported type, and it is the
 * object `mutate` overwrites one field of to build each rejection case.
 * ---------------------------------------------------------------------------
 */

/** The smallest location a resolver can legitimately produce. */
const MINIMAL: SourceLocation = {
  file: SAFE_FILE,
  line: 42,
  column: 3,
  resolvedBy: 'patch',
  confidence: DEFAULT_RESOLUTION_CONFIDENCE.patch,
};

/** A location carrying both optional fields, spanning several lines. */
const FULL: SourceLocation = {
  file: SAFE_FILE,
  line: 42,
  column: 3,
  symbol: SAFE_SYMBOL,
  endLine: 57,
  resolvedBy: 'code-graph',
  confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
};

/**
 * A valid base with one or more fields replaced, handed on as `unknown`.
 *
 * The return type is the point of this helper. A rejection case must reach the
 * parser exactly as a WebSocket frame or a model's structured output would —
 * unvouched-for — so the malformed object is never typed as a
 * {@link SourceLocation} on the way in, and no `as` cast hides the fact that it
 * is not one.
 *
 * @param overrides Fields to replace on {@link MINIMAL}, with any value at all.
 * @returns The merged object, typed `unknown`.
 */
function mutate(overrides: Readonly<Record<string, unknown>>): unknown {
  return { ...MINIMAL, ...overrides };
}

/*
 * ---------------------------------------------------------------------------
 * Tables: acceptance
 * ---------------------------------------------------------------------------
 */

/**
 * Every shape a resolver is allowed to produce.
 *
 * The two boundary confidences are here rather than in a suite of their own
 * because both bounds are inclusive by design: `1` is "exact by construction",
 * which a patch legitimately is, and `0` is "a guess, and known to be one" —
 * a value a user interface may badge but must never drop, since a weak pointer
 * into the code still beats none.
 */
const ACCEPTED_CASES: readonly AcceptedCase[] = [
  { label: 'a minimal location', location: MINIMAL },
  { label: 'a location carrying a symbol and a multi-line range', location: FULL },
  {
    label: 'a single-line range, where endLine equals line',
    location: { ...MINIMAL, endLine: MINIMAL.line },
  },
  {
    label: 'a range one line long',
    location: { ...MINIMAL, endLine: MINIMAL.line + 1 },
  },
  {
    label: 'a symbol without a range',
    location: { ...MINIMAL, symbol: SAFE_COMPONENT, resolvedBy: 'react-owner', confidence: 0.6 },
  },
  { label: 'confidence at the lower bound', location: { ...MINIMAL, confidence: 0 } },
  { label: 'confidence at the upper bound', location: { ...MINIMAL, confidence: 1 } },
  {
    label: 'a fractional confidence',
    location: { ...MINIMAL, confidence: 0.125 },
  },
  {
    label: 'a deeply nested project-relative file',
    location: { ...MINIMAL, file: 'src/lib/nested/deeper/thing.ts' },
  },
  {
    label: 'a file at the project root',
    location: { ...MINIMAL, file: 'thing.ts' },
  },
  {
    label: 'a dotfile',
    location: { ...MINIMAL, file: 'src/lib/.thingrc' },
  },
  {
    label: 'a unicode file name',
    location: { ...MINIMAL, file: 'src/lib/naïve-ファイル.ts' },
  },
  {
    label: 'an interior traversal that resolves back inside the project',
    location: { ...MINIMAL, file: 'src/../src/lib/thing.ts' },
  },
  {
    label: 'the first line and column of a file',
    location: { ...MINIMAL, line: 1, column: 1 },
  },
  {
    label: 'the largest line a resolver can report',
    location: { ...MINIMAL, line: Number.MAX_SAFE_INTEGER },
  },
];

/*
 * ---------------------------------------------------------------------------
 * Tables: refusal, one class per table
 *
 * Each table is one field's class of malformed input, and each entry records
 * the issue path the refusal must report — the dotted path a nested location
 * reports as `source.line`, and the empty string for an issue on the object
 * itself. Asserting the path rather than only the failure is what makes these
 * tests useful to a producer: a plan or a model output rejected with
 * "confidence" is a fixable report, while "invalid" is not.
 * ---------------------------------------------------------------------------
 */

/**
 * A `line` that is not a 1-based integer.
 *
 * `0` is the case worth stating plainly: every producer of a location already
 * speaks 1-based — a TypeScript diagnostic, a JavaScript stack frame,
 * `@jridgewell/trace-mapping` output after normalisation — and the VS Code
 * extension subtracts one when it builds an editor `Position`. A `0` that got
 * through here would select the line above the one the developer asked for,
 * which is the kind of wrongness a user blames on the product rather than
 * reports.
 */
const LINE_REFUSALS: readonly RefusalCase[] = [
  { label: 'a line of zero', input: mutate({ line: 0 }), path: 'line' },
  { label: 'a negative line', input: mutate({ line: -1 }), path: 'line' },
  { label: 'a non-integer line', input: mutate({ line: 1.5 }), path: 'line' },
  { label: 'an infinite line', input: mutate({ line: Number.POSITIVE_INFINITY }), path: 'line' },
  { label: 'a line that is not a number', input: mutate({ line: '42' }), path: 'line' },
  {
    label: 'a missing line',
    input: { file: SAFE_FILE, column: 3, resolvedBy: 'patch', confidence: 1 },
    path: 'line',
  },
];

/** A `column` that is not a 1-based integer. */
const COLUMN_REFUSALS: readonly RefusalCase[] = [
  { label: 'a column of zero', input: mutate({ column: 0 }), path: 'column' },
  { label: 'a negative column', input: mutate({ column: -3 }), path: 'column' },
  { label: 'a non-integer column', input: mutate({ column: 2.5 }), path: 'column' },
  { label: 'a column that is not a number', input: mutate({ column: '3' }), path: 'column' },
  {
    label: 'a missing column',
    input: { file: SAFE_FILE, line: 42, resolvedBy: 'patch', confidence: 1 },
    path: 'column',
  },
];

/**
 * Every class of path the `isSafeRelativePath` refinement exists to refuse.
 *
 * This is the security table. An absolute path leaks the developer's directory
 * layout into a panel, a screenshot and an outbound model request; a `'..'`
 * traversal in a `source.open` message is an arbitrary-file-read attempt; a NUL
 * byte terminates a path early in C string APIs, so a validated path and an
 * opened path stop being the same path; a backslash is one innocent-looking
 * segment to a `'..'` check and a traversal to any Windows API that later
 * resolves it. Refusing all of them where the value is parsed is the only
 * enforcement point every producer of a location has in common.
 */
const FILE_REFUSALS: readonly RefusalCase[] = [
  { label: 'an absolute POSIX path', input: mutate({ file: '/etc/hosts' }), path: 'file' },
  {
    label: 'an absolute path inside a project',
    input: mutate({ file: `/home/dev/project/${SAFE_FILE}` }),
    path: 'file',
  },
  { label: 'a leading traversal', input: mutate({ file: '../secret.ts' }), path: 'file' },
  {
    label: 'an interior traversal that escapes',
    input: mutate({ file: 'src/../../secret.ts' }),
    path: 'file',
  },
  { label: 'a bare traversal', input: mutate({ file: '..' }), path: 'file' },
  { label: 'a NUL byte', input: mutate({ file: 'src/lib/a\u0000.ts' }), path: 'file' },
  { label: 'an escape character', input: mutate({ file: 'src/lib/a\u001b.ts' }), path: 'file' },
  { label: 'the empty string', input: mutate({ file: '' }), path: 'file' },
  { label: 'whitespace only', input: mutate({ file: '   ' }), path: 'file' },
  {
    label: 'a Windows drive-letter path',
    input: mutate({ file: 'C:\\x.ts' }),
    path: 'file',
  },
  {
    label: 'a drive-letter path with forward slashes',
    input: mutate({ file: 'C:/x.ts' }),
    path: 'file',
  },
  {
    label: 'a relative path written with backslashes',
    input: mutate({ file: 'src\\lib\\thing.ts' }),
    path: 'file',
  },
  {
    label: 'a UNC path in POSIX form',
    input: mutate({ file: '//server/share/x.ts' }),
    path: 'file',
  },
  { label: 'a file that is not a string', input: mutate({ file: 42 }), path: 'file' },
  {
    label: 'a missing file',
    input: { line: 42, column: 3, resolvedBy: 'patch', confidence: 1 },
    path: 'file',
  },
];

/**
 * A `resolvedBy` outside the closed set of routes.
 *
 * The enumeration is validated against the `SOURCE_RESOLVED_BY` tuple itself,
 * so this table is what proves the vocabulary is closed: a route nobody
 * implemented cannot arrive over the wire and reach a user interface that has
 * no idea how much to trust it.
 */
const RESOLVED_BY_REFUSALS: readonly RefusalCase[] = [
  { label: 'an unknown route', input: mutate({ resolvedBy: 'guess' }), path: 'resolvedBy' },
  {
    label: 'a known route in the wrong case',
    input: mutate({ resolvedBy: 'PATCH' }),
    path: 'resolvedBy',
  },
  { label: 'an empty route', input: mutate({ resolvedBy: '' }), path: 'resolvedBy' },
  { label: 'a route that is not a string', input: mutate({ resolvedBy: 1 }), path: 'resolvedBy' },
  {
    label: 'a missing route',
    input: { file: SAFE_FILE, line: 42, column: 3, confidence: 1 },
    path: 'resolvedBy',
  },
];

/**
 * A `confidence` outside `[0, 1]`, of the wrong type, or absent.
 *
 * The absent case is the one that carries a design decision. `confidence` is
 * **required**: four independent resolvers in three packages fill it and two
 * user interfaces sort and badge on it, so a resolver that omits it is a
 * resolver that hands the screen an unanswerable question.
 * `DEFAULT_RESOLUTION_CONFIDENCE` exists precisely so that no resolver ever
 * needs to.
 */
const CONFIDENCE_REFUSALS: readonly RefusalCase[] = [
  { label: 'a confidence below zero', input: mutate({ confidence: -0.1 }), path: 'confidence' },
  {
    label: 'a confidence a hair below zero',
    input: mutate({ confidence: -Number.EPSILON }),
    path: 'confidence',
  },
  { label: 'a confidence above one', input: mutate({ confidence: 1.1 }), path: 'confidence' },
  {
    label: 'a confidence a hair above one',
    input: mutate({ confidence: 1 + Number.EPSILON }),
    path: 'confidence',
  },
  {
    label: 'a confidence that is not a number',
    input: mutate({ confidence: '1' }),
    path: 'confidence',
  },
  { label: 'a confidence of NaN', input: mutate({ confidence: Number.NaN }), path: 'confidence' },
  { label: 'a null confidence', input: mutate({ confidence: null }), path: 'confidence' },
  {
    label: 'a missing confidence',
    input: { file: SAFE_FILE, line: 42, column: 3, resolvedBy: 'patch' },
    path: 'confidence',
  },
];

/**
 * An `endLine` that cannot bound a selection, and one that is not a line.
 *
 * An inverted range is not a harmless oddity: the VS Code extension turns the
 * pair into an editor selection, and a backwards selection either reveals the
 * wrong region or throws inside the editor, depending on how it was built. The
 * refinement reports on the `endLine` path rather than on the object, which is
 * what lets a user interface point at the field that has to change.
 */
const RANGE_REFUSALS: readonly RefusalCase[] = [
  {
    label: 'an endLine before line',
    input: mutate({ line: 42, endLine: 41 }),
    path: 'endLine',
  },
  {
    label: 'an endLine far before line',
    input: mutate({ line: 42, endLine: 1 }),
    path: 'endLine',
  },
  { label: 'an endLine of zero', input: mutate({ endLine: 0 }), path: 'endLine' },
  { label: 'a non-integer endLine', input: mutate({ endLine: 42.5 }), path: 'endLine' },
  {
    label: 'an endLine that is not a number',
    input: mutate({ endLine: '57' }),
    path: 'endLine',
  },
];

/**
 * A `symbol` that is present but says nothing.
 *
 * Optional, because a source-map frame resolves to a position rather than to a
 * named symbol — but never empty, because the panel renderer's source chip
 * renders the symbol in its own style and an empty name reaches the screen as a
 * blank label beside a path.
 */
const SYMBOL_REFUSALS: readonly RefusalCase[] = [
  { label: 'an empty symbol', input: mutate({ symbol: '' }), path: 'symbol' },
  { label: 'a symbol that is not a string', input: mutate({ symbol: 7 }), path: 'symbol' },
];

/**
 * Values that are not objects at all, which report on the object itself.
 *
 * Their issue path is the empty string, and that is worth pinning: a value
 * arriving as `null` from a JSON round trip, or as the `file:line:column`
 * display string {@link formatSourceLocation} produces, must be refused as a
 * whole rather than reported against a field it does not have.
 */
const NON_OBJECT_REFUSALS: readonly RefusalCase[] = [
  { label: 'null', input: null, path: '' },
  { label: 'undefined', input: undefined, path: '' },
  { label: 'a string', input: formatSourceLocation(MINIMAL), path: '' },
  { label: 'an array', input: [], path: '' },
  { label: 'an array of locations', input: [MINIMAL], path: '' },
  { label: 'a number', input: 42, path: '' },
  { label: 'a boolean', input: true, path: '' },
];

/** Every refusal class in one list, for the assertions that apply to all of them. */
const ALL_REFUSALS: readonly RefusalCase[] = [
  ...LINE_REFUSALS,
  ...COLUMN_REFUSALS,
  ...FILE_REFUSALS,
  ...RESOLVED_BY_REFUSALS,
  ...CONFIDENCE_REFUSALS,
  ...RANGE_REFUSALS,
  ...SYMBOL_REFUSALS,
  ...NON_OBJECT_REFUSALS,
];

/**
 * One rejection per field that can carry attacker- or developer-supplied text,
 * each with {@link LEAK_SENTINEL} in the value that caused the refusal.
 *
 * `file` covers the two routes a real path arrives by (absolute and
 * traversing), `symbol` and `resolvedBy` cover the string fields, and
 * `confidence` covers a field whose type error names the received *type* — the
 * one place a naive implementation would be tempted to quote the value.
 */
const SENTINEL_CASES: readonly SentinelCase[] = [
  {
    label: 'an absolute file path',
    input: mutate({ file: `/home/dev/${LEAK_SENTINEL}/thing.ts` }),
  },
  { label: 'a traversing file path', input: mutate({ file: `../${LEAK_SENTINEL}.ts` }) },
  { label: 'a file path with a NUL byte', input: mutate({ file: `${LEAK_SENTINEL}\u0000.ts` }) },
  { label: 'an unknown resolution route', input: mutate({ resolvedBy: LEAK_SENTINEL }) },
  { label: 'a confidence that is a string', input: mutate({ confidence: LEAK_SENTINEL }) },
  { label: 'a symbol that is not a string', input: mutate({ symbol: [LEAK_SENTINEL] }) },
  { label: 'a value that is not an object', input: LEAK_SENTINEL },
];

/*
 * ---------------------------------------------------------------------------
 * Narrowing helpers
 *
 * Both go through the `isOk` / `isErr` guards rather than reading `.ok`
 * directly, so a guard that stopped narrowing fails `pnpm typecheck` in this
 * file. They throw rather than assert, because the throw carries the other
 * branch's content into the failure message — "expected Ok, received
 * PROTOCOL_INVALID_MESSAGE: ..." says more than a boolean that was false.
 * ---------------------------------------------------------------------------
 */

/** The location a successful parse produced, or a failed test naming the error. */
function okValue(result: Result<SourceLocation>): SourceLocation {
  if (isErr(result)) {
    throw new Error(`Expected Ok, received Err ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** The error a refusal produced, or a failed test naming the value that got through. */
function errorOf(result: Result<SourceLocation>): DebuggenError {
  if (isOk(result)) {
    throw new Error(`Expected Err, received Ok(${formatSourceLocation(result.value)})`);
  }
  return result.error;
}

/**
 * Whether a value is an array of plain objects.
 *
 * A hand-written guard rather than a bare `Array.isArray`, so the entries are
 * reached as `Record<string, unknown>` and every field read below stays
 * `unknown` — the same discipline the module under test applies to its own
 * input, and the reason this file needs no type assertion anywhere.
 *
 * @param value Any value, typically `error.details?.issues`.
 * @returns `true` when every element is a non-null object.
 */
function isRecordArray(value: unknown): value is readonly Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => typeof entry === 'object' && entry !== null)
  );
}

/**
 * The issues a refusal reported, with the privacy constraint checked on the way
 * through.
 *
 * Every entry is asserted to have exactly the two keys `path` and `message` —
 * that assertion lives here rather than in one dedicated test so it holds for
 * every case in every refusal table, which is what AAP §0.5.2 needs of a
 * payload that may be logged, persisted with a session and rendered.
 *
 * @param error The error a refusal produced.
 * @returns The reported issues, in the order the schema produced them.
 */
function issuesOf(error: DebuggenError): readonly ReportedIssue[] {
  const raw: unknown = error.details?.issues;

  if (!isRecordArray(raw)) {
    throw new Error(`Expected details.issues to be an array of objects: ${JSON.stringify(raw)}`);
  }

  return raw.map((entry, index): ReportedIssue => {
    expect(Object.keys(entry).sort()).toEqual(['message', 'path']);

    const path = entry['path'];
    const message = entry['message'];

    if (typeof path !== 'string' || typeof message !== 'string') {
      throw new Error(`Issue ${index} is not a { path, message } pair: ${JSON.stringify(entry)}`);
    }

    return { path, message };
  });
}

/**
 * Asserts that a value is refused by all three entry points, and returns the
 * issues so a caller can go on to assert the path.
 *
 * The three entry points are asserted together on purpose: `safeParse`,
 * `parseSourceLocation` and `isSourceLocation` are one decision expressed three
 * ways, and a producer validating with one while a consumer filters with
 * another is exactly the disagreement that would let a malformed location reach
 * the screen.
 *
 * @param input The value under test, unvouched-for.
 * @returns The `{ path, message }` issues the refusal reported.
 */
function expectRefused(input: unknown): readonly ReportedIssue[] {
  expect(sourceLocationSchema.safeParse(input).success).toBe(false);
  expect(isSourceLocation(input)).toBe(false);

  const error = errorOf(parseSourceLocation(input));

  expect(DebuggenError.is(error)).toBe(true);
  expect(error.code).toBe(REFUSAL_CODE);

  return issuesOf(error);
}

/**
 * Compile-time proof that {@link SourceLocation} is the schema's output type
 * rather than a shape declared beside it.
 *
 * The two functions below assign in opposite directions, so both compile only
 * if the types are mutually assignable. A field added to the schema without
 * being reflected in the exported type — or the type hand-written to drift from
 * the validator — fails `pnpm typecheck` here.
 *
 * @param value A value the schema produced.
 * @returns The same value, seen as the exported type.
 */
function asDeclaredType(value: ReturnType<typeof sourceLocationSchema.parse>): SourceLocation {
  return value;
}

/**
 * The reverse direction of {@link asDeclaredType}.
 *
 * @param value A value of the exported type.
 * @returns The same value, seen as the schema's output type.
 */
function asSchemaOutput(value: SourceLocation): ReturnType<typeof sourceLocationSchema.parse> {
  return value;
}

/*
 * ---------------------------------------------------------------------------
 * Acceptance
 * ---------------------------------------------------------------------------
 */

describe('sourceLocationSchema', () => {
  it.each(ACCEPTED_CASES)('accepts $label', ({ location }: AcceptedCase) => {
    const parsed = sourceLocationSchema.safeParse(location);

    if (!parsed.success) {
      throw new Error(`Expected success, received ${JSON.stringify(parsed.error.issues)}`);
    }

    expect(parsed.data).toEqual(location);
  });

  it.each(ACCEPTED_CASES)(
    'accepts $label through every entry point',
    ({ location }: AcceptedCase) => {
      // One decision expressed three ways: the schema, the Result-returning
      // parser every boundary uses, and the predicate the renderer filters
      // with. They must never disagree about the same value.
      expect(okValue(parseSourceLocation(location))).toEqual(location);
      expect(isSourceLocation(location)).toBe(true);
    },
  );

  it('accepts a location whose range is a single line', () => {
    // Stated on its own because the refinement is `>=`, not `>`: a one-line
    // function is a legitimate patch target, and its start and end are the same
    // line.
    const single: SourceLocation = { ...MINIMAL, endLine: MINIMAL.line };

    expect(okValue(parseSourceLocation(single)).endLine).toBe(MINIMAL.line);
  });

  it('accepts a location whose range spans several lines', () => {
    const parsed = okValue(parseSourceLocation(FULL));

    expect(parsed).toEqual(FULL);
    expect(parsed.endLine).toBe(57);
    expect(parsed.line).toBe(42);
  });

  it('accepts both confidence bounds, because both are inclusive', () => {
    expect(okValue(parseSourceLocation({ ...MINIMAL, confidence: 0 })).confidence).toBe(0);
    expect(okValue(parseSourceLocation({ ...MINIMAL, confidence: 1 })).confidence).toBe(1);
  });

  it('keeps the optional fields absent rather than present and undefined', () => {
    // A location with no symbol and no range must not acquire the keys: it is
    // serialised onto the wire, where a present-but-undefined field becomes
    // `null` after a JSON round trip and fails the protocol's own schema.
    const parsed = okValue(parseSourceLocation(MINIMAL));

    expect(Object.keys(parsed).sort()).toEqual([
      'column',
      'confidence',
      'file',
      'line',
      'resolvedBy',
    ]);
    expect('symbol' in parsed).toBe(false);
    expect('endLine' in parsed).toBe(false);
  });

  it('strips a field it does not know about instead of carrying it onward', () => {
    // Zod's default for `z.object`, and the behaviour this product wants at a
    // process boundary: a producer built against a later version of the schema
    // stays compatible, and nothing it sent that this version does not
    // understand can reach the store, a prompt or a user interface.
    const parsed = okValue(parseSourceLocation({ ...MINIMAL, extra: LEAK_SENTINEL }));

    expect(parsed).toEqual(MINIMAL);
    expect(JSON.stringify(parsed)).not.toContain(LEAK_SENTINEL);
  });

  it('exports a type that is the schema output type, in both directions', () => {
    // No cast anywhere in this test: the parsed value is handed to a function
    // that demands the exported type, and back to one that demands the
    // schema's, so the two must be mutually assignable for this file to
    // compile.
    const fromSchema = sourceLocationSchema.parse(MINIMAL);
    const declared: SourceLocation = asDeclaredType(fromSchema);

    expect(asSchemaOutput(declared)).toEqual(MINIMAL);
    expect(formatSourceLocation(declared)).toBe(formatSourceLocation(MINIMAL));
  });

  it('yields a value usable as a SourceLocation without a cast', () => {
    const location: SourceLocation = okValue(parseSourceLocation(MINIMAL));
    const route: SourceResolvedBy = location.resolvedBy;

    expect(route).toBe('patch');
    expect(location.file).toBe(SAFE_FILE);
    expect(location.line).toBe(42);
    expect(location.column).toBe(3);
    expect(location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE.patch);
  });

  it('narrows an unknown value through isSourceLocation', () => {
    const received: unknown = MINIMAL;

    if (!isSourceLocation(received)) {
      throw new Error('Expected the minimal location to satisfy the predicate');
    }

    // Reachable only because the predicate narrowed `received`; a guard that
    // stopped narrowing fails the typecheck gate on the next line.
    expect(formatSourceLocation(received)).toBe(`${SAFE_FILE}:42:3`);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Refusal
 *
 * One `it` per case, so a failure names the input rather than an index, and
 * every case asserts the same three things through `expectRefused`: the schema
 * refuses it, the predicate refuses it, and the Result-returning parser refuses
 * it with a `DebuggenError` carrying `PROTOCOL_INVALID_MESSAGE`. Each suite
 * then adds the issue path its field must report.
 * ---------------------------------------------------------------------------
 */

describe('parseSourceLocation refuses', () => {
  describe('a line that is not a 1-based integer', () => {
    it.each(LINE_REFUSALS)('$label', ({ input, path }: RefusalCase) => {
      expect(expectRefused(input).map((issue) => issue.path)).toContain(path);
    });
  });

  describe('a column that is not a 1-based integer', () => {
    it.each(COLUMN_REFUSALS)('$label', ({ input, path }: RefusalCase) => {
      expect(expectRefused(input).map((issue) => issue.path)).toContain(path);
    });
  });

  describe('a file that is not a project-relative POSIX path', () => {
    it.each(FILE_REFUSALS)('$label', ({ input, path }: RefusalCase) => {
      expect(expectRefused(input).map((issue) => issue.path)).toContain(path);
    });
  });

  describe('a resolution route outside the closed set', () => {
    it.each(RESOLVED_BY_REFUSALS)('$label', ({ input, path }: RefusalCase) => {
      expect(expectRefused(input).map((issue) => issue.path)).toContain(path);
    });
  });

  describe('a confidence that is missing or out of range', () => {
    it.each(CONFIDENCE_REFUSALS)('$label', ({ input, path }: RefusalCase) => {
      expect(expectRefused(input).map((issue) => issue.path)).toContain(path);
    });
  });

  describe('a range that cannot bound a selection', () => {
    it.each(RANGE_REFUSALS)('$label', ({ input, path }: RefusalCase) => {
      expect(expectRefused(input).map((issue) => issue.path)).toContain(path);
    });
  });

  describe('a symbol that says nothing', () => {
    it.each(SYMBOL_REFUSALS)('$label', ({ input, path }: RefusalCase) => {
      expect(expectRefused(input).map((issue) => issue.path)).toContain(path);
    });
  });

  describe('a value that is not an object', () => {
    it.each(NON_OBJECT_REFUSALS)('$label', ({ input, path }: RefusalCase) => {
      // The path is the empty string: the issue is with the value as a whole,
      // and reporting it against a field the value does not have would send a
      // producer looking in the wrong place.
      expect(expectRefused(input).map((issue) => issue.path)).toContain(path);
    });
  });

  it('reports the inverted range on the endLine path and nowhere else', () => {
    // The refinement declares `path: ['endLine']` precisely so a user interface
    // can point at the field that has to change. With every other field valid,
    // that must be the only issue reported.
    const issues = expectRefused(mutate({ line: 42, endLine: 41 }));

    expect(issues.map((issue) => issue.path)).toEqual(['endLine']);
    expect(issues.map((issue) => issue.message).join(' ')).toContain(
      'endLine must be greater than or equal to line.',
    );
  });

  it('reports the inverted range even when another field is also wrong', () => {
    // Both issues must arrive together: a producer fixing one at a time is a
    // producer making two round trips through a validation boundary that
    // already knew both answers.
    const paths = expectRefused(mutate({ line: 42, column: 0, endLine: 41 })).map(
      (issue) => issue.path,
    );

    expect(paths).toContain('column');
    expect(paths).toContain('endLine');
  });

  it('reports every missing required field for an empty object', () => {
    // The five fields a resolver cannot omit. `symbol` and `endLine` must not
    // appear: they are optional, and demanding them would make a point location
    // — the common case — unrepresentable.
    const paths = expectRefused({}).map((issue) => issue.path);

    expect([...paths].sort()).toEqual(['column', 'confidence', 'file', 'line', 'resolvedBy']);
  });

  it('reports both the length and the safety issue for an empty file', () => {
    // Two checks apply to the same field, and both are reported: the non-empty
    // constraint and the project-relative refinement. Either one alone would
    // let the other regress unnoticed.
    const messages = expectRefused(mutate({ file: '' })).map((issue) => issue.message);

    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message.includes('project-relative'))).toBe(true);
  });

  describe('every refusal class', () => {
    it.each(ALL_REFUSALS)('reports a branded error for $label', ({ input }: RefusalCase) => {
      // `DebuggenError.is` rather than `instanceof`: this error is built in one
      // process and read in another, where two bundles mean two constructor
      // identities and `instanceof` answers false for a structurally perfect
      // error (AAP §0.4.2).
      const error = errorOf(parseSourceLocation(input));
      // Coalesced rather than asserted non-null: an absent hint leaves the
      // empty string, which contains nothing, so the assertion below still
      // fails — and it fails naming the missing content instead of throwing.
      const hint: string = error.hint ?? '';

      expect(DebuggenError.is(error)).toBe(true);
      expect(error.code).toBe(REFUSAL_CODE);
      expect(error.name).toBe('DebuggenError');
      expect(error.message).toBe('A value did not match the source location schema.');
      expect(hint).toContain('project-relative');
      expect(issuesOf(error).length).toBeGreaterThan(0);
    });

    it.each(ALL_REFUSALS)(
      'never narrows $label through the predicate',
      ({ input }: RefusalCase) => {
        expect(isSourceLocation(input)).toBe(false);
      },
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * Privacy of the failure payload
 *
 * `details` is the one object in this package that could carry a rejected value
 * outward. It is attached to an error raised deep in a call stack, where the
 * redaction layer of AAP §0.5.2 never sees it, and it is then logged, persisted
 * with the session and rendered in two user interfaces. So the rule is that the
 * payload describes the *shape* of the failure and never the data that caused
 * it: field paths and the schema's own messages are enough to fix a producer.
 * ---------------------------------------------------------------------------
 */

describe('the failure payload', () => {
  it.each(SENTINEL_CASES)(
    'does not echo the rejected value of $label',
    ({ input }: SentinelCase) => {
      const error = errorOf(parseSourceLocation(input));
      const serialized = JSON.stringify(error.details);

      expect(serialized).not.toContain(LEAK_SENTINEL);
      expect(error.message).not.toContain(LEAK_SENTINEL);
      expect(error.hint ?? '').not.toContain(LEAK_SENTINEL);
    },
  );

  it.each(SENTINEL_CASES)(
    'carries only a path and a message for $label',
    ({ input }: SentinelCase) => {
      // `issuesOf` asserts the two-key shape of every entry as it reads them,
      // so this test states the consequence: nothing beyond a path and a
      // message exists to leak.
      for (const issue of issuesOf(errorOf(parseSourceLocation(input)))) {
        expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
        expect(issue.path).not.toContain(LEAK_SENTINEL);
        expect(issue.message).not.toContain(LEAK_SENTINEL);
      }
    },
  );

  it('attaches nothing to details beyond the issue list', () => {
    const error = errorOf(parseSourceLocation(mutate({ file: `/home/dev/${LEAK_SENTINEL}` })));

    expect(Object.keys(error.details ?? {})).toEqual(['issues']);
  });

  it.each(ALL_REFUSALS)(
    'serialises to a JSON-safe payload for $label',
    ({ input }: RefusalCase) => {
      // The payload crosses a process boundary as JSON (AAP §0.4.2), so it must
      // survive a round trip without losing or changing anything. A value that
      // stringified to `undefined` — a function, a symbol — would make this
      // comparison fail rather than pass quietly.
      const error = errorOf(parseSourceLocation(input));
      const serialized = JSON.stringify(error.details);

      expect(typeof serialized).toBe('string');
      expect(serialized).toBe(JSON.stringify({ issues: issuesOf(error) }));
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * The resolution-route vocabulary and its confidence table
 *
 * `SOURCE_RESOLVED_BY` is the enumeration a message, a stored row and a
 * rendered JSON Schema all carry, so its members and their order are a
 * contract. `DEFAULT_RESOLUTION_CONFIDENCE` is the numeric expression of the
 * documented precedence, and it is the table every resolver reaches for when it
 * has nothing more specific to say — which only works if the two cannot drift
 * apart. Both directions are asserted: every route has an entry, and every
 * entry is a route.
 * ---------------------------------------------------------------------------
 */

describe('SOURCE_RESOLVED_BY', () => {
  it('lists exactly the five resolution routes, in the protocol order', () => {
    expect([...SOURCE_RESOLVED_BY]).toEqual([
      'patch',
      'code-graph',
      'source-map',
      'react-owner',
      'route-map',
    ]);
  });

  it('contains no duplicate', () => {
    // A duplicate would widen nothing and break nothing loudly: the derived
    // union would be unchanged, while the confidence table below would quietly
    // stop having one entry per member.
    expect(new Set(SOURCE_RESOLVED_BY).size).toBe(SOURCE_RESOLVED_BY.length);
    expect(SOURCE_RESOLVED_BY).toHaveLength(5);
  });

  it.each([...SOURCE_RESOLVED_BY])('accepts %s as a resolvedBy value', (route) => {
    const parsed = okValue(parseSourceLocation({ ...MINIMAL, resolvedBy: route }));

    expect(parsed.resolvedBy).toBe(route);
  });
});

describe('DEFAULT_RESOLUTION_CONFIDENCE', () => {
  it.each([...SOURCE_RESOLVED_BY])('has an entry for %s within the valid range', (route) => {
    // Derived from the tuple rather than from a hand-written key list, so a
    // sixth route added to the vocabulary without a default fails here instead
    // of reaching a user interface as `undefined`.
    expect(Object.hasOwn(DEFAULT_RESOLUTION_CONFIDENCE, route)).toBe(true);

    const confidence: number = DEFAULT_RESOLUTION_CONFIDENCE[route];

    expect(Number.isFinite(confidence)).toBe(true);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  it('has no entry that is not a resolution route', () => {
    // The reverse direction: the forward check above cannot see a stale key
    // left behind by a renamed route, and a table with an extra entry is a
    // table somebody is reading with a string that no longer exists.
    const keys = Object.keys(DEFAULT_RESOLUTION_CONFIDENCE);

    expect([...keys].sort()).toEqual([...SOURCE_RESOLVED_BY].sort());
    expect(keys).toHaveLength(SOURCE_RESOLVED_BY.length);
  });

  it('orders the routes by how much each can be trusted', () => {
    // The documented precedence of AAP §0.2.3, expressed as the numbers that
    // order it: a patch knows where it wrote, a route map follows a mechanical
    // convention, a code-graph lookup may choose between candidates, a source
    // map depends on a build artefact, and a React owner chain can land on a
    // wrapper rather than the component the developer meant.
    expect(DEFAULT_RESOLUTION_CONFIDENCE.patch).toBeGreaterThan(
      DEFAULT_RESOLUTION_CONFIDENCE['route-map'],
    );
    expect(DEFAULT_RESOLUTION_CONFIDENCE['route-map']).toBeGreaterThan(
      DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
    );
    expect(DEFAULT_RESOLUTION_CONFIDENCE['code-graph']).toBeGreaterThan(
      DEFAULT_RESOLUTION_CONFIDENCE['source-map'],
    );
    expect(DEFAULT_RESOLUTION_CONFIDENCE['source-map']).toBeGreaterThan(
      DEFAULT_RESOLUTION_CONFIDENCE['react-owner'],
    );
  });

  it('puts patch at the top and the React owner chain at the bottom', () => {
    const values = SOURCE_RESOLVED_BY.map((route) => DEFAULT_RESOLUTION_CONFIDENCE[route]);

    expect(Math.max(...values)).toBe(DEFAULT_RESOLUTION_CONFIDENCE.patch);
    expect(Math.min(...values)).toBe(DEFAULT_RESOLUTION_CONFIDENCE['react-owner']);
  });

  it.each([...SOURCE_RESOLVED_BY])('is accepted by the schema for %s', (route) => {
    // The defaults and the schema cannot drift apart: a default nudged outside
    // `[0, 1]` would make every location a resolver produced unparseable, and
    // this is where that shows up.
    const parsed = okValue(
      parseSourceLocation({
        ...MINIMAL,
        resolvedBy: route,
        confidence: DEFAULT_RESOLUTION_CONFIDENCE[route],
      }),
    );

    expect(parsed.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE[route]);
    expect(parsed.resolvedBy).toBe(route);
  });

  it('is frozen, because it is read on every resolution', () => {
    // A shared module-level table: a mutation would silently re-rank every
    // panel's suggested locations for the lifetime of the process.
    expect(Object.isFrozen(DEFAULT_RESOLUTION_CONFIDENCE)).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * formatSourceLocation
 *
 * The display string, and only that. It is the label of the `SourceLink` chip
 * and the form a location takes in a log line, which is the whole point: a
 * developer who reads a path in a log and the same path on a chip should not
 * have to work out whether they are the same place. `symbol` and `endLine` stay
 * out — the chip renders the symbol separately, and the range belongs to the
 * selection the editor makes rather than to the label.
 * ---------------------------------------------------------------------------
 */

describe('formatSourceLocation', () => {
  it('renders exactly file:line:column', () => {
    expect(formatSourceLocation(MINIMAL)).toBe(`${SAFE_FILE}:42:3`);
  });

  it('omits the symbol, which the source chip renders separately', () => {
    const formatted = formatSourceLocation(FULL);

    expect(formatted).toBe(`${SAFE_FILE}:42:3`);
    expect(formatted).not.toContain(SAFE_SYMBOL);
  });

  it('omits the range, which belongs to the editor selection', () => {
    expect(formatSourceLocation(FULL)).not.toContain('57');
  });

  it('is not round-trippable, and is not meant to be', () => {
    // Stated as a test because it is a boundary decision, not an oversight:
    // `source.open` carries the object itself (AAP §0.2.3), so the display
    // string never has to be parsed back — and must not be, since it has
    // dropped two fields by then.
    expect(isSourceLocation(formatSourceLocation(MINIMAL))).toBe(false);
  });

  it.each(ACCEPTED_CASES)(
    'renders $label as three colon-separated parts',
    ({ location }: AcceptedCase) => {
      const formatted = formatSourceLocation(location);

      expect(formatted).toBe(`${location.file}:${location.line}:${location.column}`);
      expect(formatted.startsWith('/')).toBe(false);
      expect(formatted).not.toContain('\\');
    },
  );
});
