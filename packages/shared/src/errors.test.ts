/**
 * Tests for `./errors.ts`: the closed error-code vocabulary and the error class
 * every workspace in this monorepo throws and every boundary catches.
 *
 * This is the bottom of the package graph, so the two things on trial here fail
 * further away than they are raised.
 *
 * 1. **The code table is a contract, not a list.** `@debuggen/protocol`
 *    enumerates `DEBUGGEN_ERROR_CODES` when it builds its `error` and
 *    `instrumentation.failed` payload schemas, and both user interfaces pick a
 *    recovery path from the code rather than from the message text. A duplicate
 *    entry, a lowercase or hyphenated one, or a silently renamed code therefore
 *    reaches the wire as an unparseable frame or as a failure no surface knows
 *    how to render — after eleven workspaces have already imported it. The
 *    first suite below is the cheap place to catch that.
 *
 * 2. **The brand is what makes an error survive the trip.** Four processes
 *    cooperate — the local service, the VS Code extension host, the DevTools
 *    panel and the page agent — and each bundles its own copy of this module.
 *    Two copies of a class are two constructor identities, so `instanceof` says
 *    `false` for an error that is structurally exactly a `DebuggenError`; a
 *    value that arrived through `postMessage`, `structuredClone` or JSON has no
 *    prototype left at all. `DebuggenError.is` answers with an own string-keyed
 *    data property instead, and `DebuggenError.from` is built on that answer.
 *    The `is`/`from` suites assert both the positive cross-bundle cases and the
 *    shapes that must stay out.
 *
 * Two assertion habits in here are deliberate and worth keeping.
 *
 * - **Key presence, not `undefined`.** `toPayload()` output is serialised onto
 *   the wire, where a present-but-`undefined` `hint` becomes `"hint": null`
 *   after a JSON round-trip and fails the protocol's schema. So the payload
 *   tests assert `'hint' in payload` and the exact `Object.keys` list, not
 *   `payload.hint === undefined`, which a broken implementation would satisfy.
 * - **Identity, not equality.** `cause`, `details` and the value `from` returns
 *   for something already branded are asserted with `toBe`. A wrapper that
 *   copied or re-serialised any of them would pass a `toEqual` and still lose
 *   the original stack, the caller's reference, or the specific code a deeper
 *   layer chose.
 *
 * Runtime facts these tests encode, measured against Node 24 rather than
 * assumed: an instance's own enumerable properties are `name`, the brand,
 * `code` and whichever of `hint`/`details` was supplied (`message` and `stack`
 * are non-enumerable, which is exactly why the wire form is `toPayload()` and
 * not the instance); `structuredClone` of an `Error` *instance* keeps none of
 * them, while `structuredClone` of a plain object carrying the brand keeps it,
 * and symbol-keyed properties survive neither.
 */

import { describe, expect, it } from 'vitest';

import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  type DebuggenErrorCode,
  type DebuggenErrorOptions,
} from './errors.js';

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

/**
 * The own-property name that marks a value as a `DebuggenError`.
 *
 * Restated here rather than imported on purpose: `errors.ts` keeps its
 * `DEBUGGEN_ERROR_BRAND` constant module-private, and the cross-bundle contract
 * *is* this string — a copy of the class from another bundle, possibly built
 * from a different revision of the file, agrees with this one only while the
 * literal stays byte-identical. Stating it independently means a rename shows
 * up here as a failing test instead of as a guard that quietly stops matching.
 */
const BRAND_KEY = '__isDebuggenError__';

/**
 * `SCREAMING_SNAKE_CASE`: an uppercase letter, then uppercase letters and
 * digits in underscore-separated groups, with no leading, trailing or doubled
 * underscore and no lowercase or hyphen anywhere.
 */
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/**
 * Codes other workspaces are specified to report with, spot-checked so a rename
 * at the bottom of the graph cannot land quietly.
 *
 * One per concern the product actually has to distinguish: the containment
 * failure and the filesystem-policy failure that guard the developer's project,
 * the conflict that must never overwrite their edit, the empty capture that is
 * a dead end rather than a defect, the two model-artifact refusals, the
 * unparseable frame, and the last-resort code `from` defaults to.
 *
 * Typed `readonly string[]` and not `readonly DebuggenErrorCode[]` on purpose:
 * as a `DebuggenErrorCode[]` a deleted code would fail to *compile* this file,
 * which reports the loss as a type error in a test rather than as the assertion
 * below naming the missing code.
 */
const REQUIRED_CODES: readonly string[] = [
  'PATH_OUTSIDE_PROJECT',
  'FS_UNSAFE_PATH',
  'MODIFICATION_CONFLICT',
  'CAPTURE_EMPTY',
  'MODEL_OUTPUT_INVALID',
  'PANEL_SEMANTIC_INVALID',
  'PROTOCOL_INVALID_MESSAGE',
  'INTERNAL',
];

/**
 * A code used wherever a test needs one that is not the `INTERNAL` default, so
 * an assertion about a default can never pass by coincidence.
 */
const SPECIFIC_CODE: DebuggenErrorCode = 'STORE_ERROR';

/**
 * The structural shape a `DebuggenError` has after it crosses a bundle
 * boundary or a serialisation boundary: the brand, a code and a message, and
 * none of the class — no prototype, so no `toPayload`, and `instanceof` false.
 *
 * Written as a plain interface rather than by casting an instance, because a
 * cast would still produce the real class and prove nothing.
 */
interface ForeignDebuggenError {
  readonly __isDebuggenError__: true;
  readonly code: string;
  readonly message: string;
}

/** A fresh foreign-bundle value; fresh per call so identity tests are honest. */
function foreignBundleError(): ForeignDebuggenError {
  return {
    __isDebuggenError__: true,
    code: SPECIFIC_CODE,
    message: 'Raised by another copy of this module.',
  };
}

/** A node in a self-referencing object graph. */
interface CyclicNode {
  label: string;
  self?: CyclicNode;
}

/**
 * A value `JSON.stringify` refuses: an error reporter that tried to stringify
 * an unknown input would throw *from the failure path*, replacing the original
 * failure with a `TypeError` about a circular structure.
 */
function cyclicValue(): CyclicNode {
  const node: CyclicNode = { label: 'cycle' };
  node.self = node;
  return node;
}

/** A labelled case for the table-driven suites. */
interface LabelledValue {
  readonly label: string;
  readonly value: unknown;
}

/**
 * Thrown values that are neither an `Error` nor branded. JavaScript allows
 * throwing any of these, and `catch` binds `unknown`, so `from` has to produce
 * a typed error for every one of them without inspecting the value beyond its
 * type.
 *
 * `10n` is here because `JSON.stringify` throws on a `bigint` just as it does
 * on a cycle, and the symbol because it is not concatenable — both are the
 * shapes that punish a reporter for reaching for stringification.
 */
const UNCLASSIFIABLE_VALUES: readonly LabelledValue[] = [
  { label: 'null', value: null },
  { label: 'a number', value: 42 },
  { label: 'a bigint', value: 10n },
  { label: 'false', value: false },
  { label: 'an empty string', value: '' },
  { label: 'a symbol', value: Symbol('reason') },
  { label: 'a plain object', value: { kind: 'plain' } },
  { label: 'an array', value: [1, 2] },
  { label: 'a function', value: () => undefined },
];

/**
 * Values `DebuggenError.is` must reject. The last four matter most: a truthy
 * brand that is not exactly `true` (a string, a number) is what a sloppy
 * hand-rolled copy or a mangled JSON revival looks like, and accepting one
 * would let an arbitrary object through the type guard and into a `catch` block
 * that then reads `.code` off it.
 */
const UNBRANDED_VALUES: readonly LabelledValue[] = [
  { label: 'a native Error', value: new Error('plain') },
  { label: 'a native TypeError', value: new TypeError('wrong type') },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'a string', value: 'DebuggenError' },
  { label: 'a number', value: 0 },
  { label: 'an array', value: [] },
  { label: 'an object with a code but no brand', value: { code: 'INTERNAL', message: 'nope' } },
  { label: 'an object whose brand is false', value: { [BRAND_KEY]: false, code: 'INTERNAL' } },
  { label: 'an object whose brand is the string "true"', value: { [BRAND_KEY]: 'true' } },
  { label: 'an object whose brand is the number 1', value: { [BRAND_KEY]: 1 } },
];

/*
 * ---------------------------------------------------------------------------
 * The code table
 * ---------------------------------------------------------------------------
 */

describe('DEBUGGEN_ERROR_CODES', () => {
  it('is a non-empty table', () => {
    expect(DEBUGGEN_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it('contains no duplicate codes', () => {
    const seen = new Set<string>();
    const duplicates = DEBUGGEN_ERROR_CODES.filter((code) => {
      const repeated = seen.has(code);
      seen.add(code);
      return repeated;
    });

    // Reported as the offending list rather than as a size comparison, so a
    // failure names the code that was added twice.
    expect(duplicates).toEqual([]);
    expect(seen.size).toBe(DEBUGGEN_ERROR_CODES.length);
  });

  it('spells every code in SCREAMING_SNAKE_CASE', () => {
    const malformed = DEBUGGEN_ERROR_CODES.filter(
      (code: string) =>
        typeof code !== 'string' || code.length === 0 || !SCREAMING_SNAKE.test(code),
    );

    expect(malformed).toEqual([]);
  });

  it('includes every code the rest of the product is specified to report', () => {
    const present = new Set<string>(DEBUGGEN_ERROR_CODES);
    const missing = REQUIRED_CODES.filter((code) => !present.has(code));

    expect(missing).toEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Construction
 * ---------------------------------------------------------------------------
 */

describe('new DebuggenError', () => {
  it('stores the code, the message, the hint and the details', () => {
    const details = { attempts: 3, stage: 'instrumenting' } as const;
    const options: DebuggenErrorOptions = {
      hint: 'Reload the page, then start capture again.',
      details,
    };
    const error = new DebuggenError(
      'AGENT_NOT_READY',
      'The page agent has not reported in.',
      options,
    );

    expect(error.code).toBe('AGENT_NOT_READY');
    expect(error.message).toBe('The page agent has not reported in.');
    expect(error.hint).toBe('Reload the page, then start capture again.');
    // Identity, not equality: details are handed through, never copied, so a
    // caller's object and the error's are the same reference.
    expect(error.details).toBe(details);
  });

  it('is an Error named DebuggenError', () => {
    const error = new DebuggenError('INTERNAL', 'Something gave way.');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DebuggenError);
    expect(error.name).toBe('DebuggenError');
    // The point of overriding `name`: both the standard string form and the
    // formatted stack name this class rather than the plain Error it extends.
    expect(String(error)).toBe('DebuggenError: Something gave way.');
    expect(error.stack ?? '').toContain('DebuggenError: Something gave way.');
  });

  it('preserves the cause it was given, by identity', () => {
    const root = new Error('root');
    const error = new DebuggenError('STORE_ERROR', 'The session store failed.', { cause: root });

    expect(error.cause).toBe(root);
  });

  it('creates no hint, details or cause property when none was given', () => {
    const error = new DebuggenError('CAPTURE_EMPTY', 'No telemetry was captured.');

    // `in`, not `=== undefined`: these properties must be absent, so that a
    // JSON round-trip of the error's own properties carries no null-valued key
    // and a `'hint' in error` check downstream answers honestly.
    expect('hint' in error).toBe(false);
    expect('details' in error).toBe(false);
    expect('cause' in error).toBe(false);
  });

  it('carries the brand as an own enumerable property', () => {
    const error = new DebuggenError(SPECIFIC_CODE, 'Branded.');

    // Own and enumerable is the requirement, not merely readable: a prototype
    // member would be invisible to every clone and to JSON, which is the whole
    // reason the brand is set on the instance.
    expect(Object.hasOwn(error, BRAND_KEY)).toBe(true);
    expect(Object.keys(error)).toContain(BRAND_KEY);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The wire form
 * ---------------------------------------------------------------------------
 */

describe('DebuggenError#toPayload', () => {
  it('returns exactly the code and the message when no hint was given', () => {
    const error = new DebuggenError('CAPTURE_EMPTY', 'No telemetry was captured.');
    const payload = error.toPayload();

    expect(payload).toEqual({ code: 'CAPTURE_EMPTY', message: 'No telemetry was captured.' });
    // The absence of the key itself, not an `undefined` value: this object is
    // serialised onto the wire, where a present `undefined` becomes `null` and
    // fails the protocol's schema at the receiving end.
    expect('hint' in payload).toBe(false);
    expect(Object.keys(payload)).toEqual(['code', 'message']);
  });

  it('includes the hint when the error has one', () => {
    const error = new DebuggenError('DEV_SERVER_UNAVAILABLE', 'No dev server answered.', {
      hint: 'Start the dev server, then try again.',
    });
    const payload = error.toPayload();

    expect(payload).toEqual({
      code: 'DEV_SERVER_UNAVAILABLE',
      message: 'No dev server answered.',
      hint: 'Start the dev server, then try again.',
    });
    expect(Object.keys(payload)).toEqual(['code', 'message', 'hint']);
  });

  it('never carries details or cause', () => {
    const error = new DebuggenError('STORE_ERROR', 'The session store failed.', {
      hint: 'Check the session store.',
      details: { table: 'sessions' },
      cause: new Error('SQLITE_BUSY'),
    });
    const payload = error.toPayload();

    // Details are diagnostic context for this process's log and a cause is
    // frequently an Error: neither is safe to assume serialisable, and neither
    // belongs in a message a user interface renders.
    expect('details' in payload).toBe(false);
    expect('cause' in payload).toBe(false);
    expect(Object.keys(payload)).toEqual(['code', 'message', 'hint']);
  });

  it('is JSON-safe and survives a round-trip unchanged', () => {
    const error = new DebuggenError('PANEL_SEMANTIC_INVALID', 'The panel cited absent evidence.', {
      hint: 'Regenerate the panel.',
      details: { missingEventIds: ['evt-1'] },
      cause: new Error('validation'),
    });
    const payload = error.toPayload();
    // Typed `unknown` rather than left as `JSON.parse`'s `any`, so nothing in
    // this assertion is exempt from the type-aware lint rules.
    const roundTripped: unknown = JSON.parse(JSON.stringify(payload));

    expect(roundTripped).toEqual(payload);
  });

  it('returns a fresh object each call, so a caller cannot mutate the error', () => {
    const error = new DebuggenError(SPECIFIC_CODE, 'The session store failed.');
    const first = error.toPayload();
    const second = error.toPayload();

    expect(first).not.toBe(second);

    first.hint = 'mutated';

    expect('hint' in second).toBe(false);
    expect('hint' in error).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Normalising anything a boundary catches
 * ---------------------------------------------------------------------------
 */

describe('DebuggenError.from', () => {
  it('returns the very same instance when the value already is a DebuggenError', () => {
    const existing = new DebuggenError('MODIFICATION_CONFLICT', 'The file was edited.', {
      hint: 'Open the diff.',
    });

    expect(DebuggenError.from(existing)).toBe(existing);
  });

  it('never lets a fallback code override an existing one', () => {
    const existing = new DebuggenError('MODIFICATION_CONFLICT', 'The file was edited.');

    // The specific code a deeper layer chose is the whole value of the code:
    // re-labelling it at a boundary would erase what the surface renders.
    expect(DebuggenError.from(existing, 'INTERNAL').code).toBe('MODIFICATION_CONFLICT');
  });

  it('is idempotent', () => {
    const first = DebuggenError.from(new Error('boom'));

    expect(DebuggenError.from(first)).toBe(first);
  });

  it('returns a foreign-bundle value unchanged rather than rebuilding it', () => {
    const foreign = foreignBundleError();

    // Rebuilding would mint a new instance with a new stack and would drop
    // whatever else the other copy attached; the brand exists so this value can
    // be recognised and passed through instead.
    expect(DebuggenError.from(foreign)).toBe(foreign);
  });

  it('wraps a native Error with the INTERNAL default, its message and itself as cause', () => {
    const native = new Error('boom');
    const error = DebuggenError.from(native);

    expect(DebuggenError.is(error)).toBe(true);
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('boom');
    expect(error.cause).toBe(native);
  });

  it('uses an explicit fallback code instead of the default', () => {
    const error = DebuggenError.from(new Error('boom'), SPECIFIC_CODE);

    expect(error.code).toBe(SPECIFIC_CODE);
    expect(error.message).toBe('boom');
  });

  it('falls back to an Error subclass name when the message is empty', () => {
    // An error with no message at all reads as a blank line in a user
    // interface, so the name is used rather than nothing.
    expect(DebuggenError.from(new Error('')).message).toBe('Error');
    expect(DebuggenError.from(new TypeError('')).message).toBe('TypeError');
  });

  it('keeps a non-empty string as both the message and the cause', () => {
    const error = DebuggenError.from('Serialised failure text', SPECIFIC_CODE);

    expect(error.code).toBe(SPECIFIC_CODE);
    expect(error.message).toBe('Serialised failure text');
    expect(error.cause).toBe('Serialised failure text');
  });

  it('wraps undefined without inventing a cause property', () => {
    const error = DebuggenError.from(undefined);

    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('Unknown error');
    expect('cause' in error).toBe(false);
  });

  it('does not throw on a cyclic value, and keeps it as the cause', () => {
    const cyclic = cyclicValue();

    // The fixture is genuinely hostile: stringifying it is what an
    // over-eager reporter would do, and it throws.
    expect(() => JSON.stringify(cyclic)).toThrow(TypeError);

    let error: DebuggenError | undefined;
    expect(() => {
      error = DebuggenError.from(cyclic, SPECIFIC_CODE);
    }).not.toThrow();

    expect(error?.code).toBe(SPECIFIC_CODE);
    expect(error?.message).toBe('Unknown error');
    expect(error?.cause).toBe(cyclic);
  });

  it.each(UNCLASSIFIABLE_VALUES)(
    'produces a DebuggenError for $label without throwing',
    ({ value }: LabelledValue) => {
      let error: DebuggenError | undefined;
      expect(() => {
        error = DebuggenError.from(value);
      }).not.toThrow();

      expect(DebuggenError.is(error)).toBe(true);
      expect(error?.code).toBe('INTERNAL');
      expect(error?.message).toBe('Unknown error');
      expect(error?.cause).toBe(value);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * The cross-bundle guard
 * ---------------------------------------------------------------------------
 */

describe('DebuggenError.is', () => {
  it('accepts a real instance', () => {
    expect(DebuggenError.is(new DebuggenError('INTERNAL', 'Something gave way.'))).toBe(true);
  });

  it('accepts a plain object carrying the brand: the foreign-bundle case', () => {
    // This is the case the brand exists for. The local service, the VS Code
    // extension host, the DevTools panel and the page agent each bundle their
    // own copy of this module, so two copies of the class are two constructor
    // identities and `instanceof` answers false for a value that is exactly
    // this shape. A structural test is the only one that can answer true —
    // which is also why `is` accepts a hand-built object, and why `from`
    // returns such a value unchanged instead of pretending to rebuild it.
    const foreign = foreignBundleError();

    expect(foreign instanceof DebuggenError).toBe(false);
    expect(DebuggenError.is(foreign)).toBe(true);
  });

  it('accepts an instance revived from its own JSON', () => {
    const error = new DebuggenError(SPECIFIC_CODE, 'The session store failed.', {
      hint: 'Check the session store.',
    });
    const revived: unknown = JSON.parse(JSON.stringify(error));

    // `message` and `stack` are non-enumerable, so a JSON round-trip of an
    // instance keeps the brand, the name, the code and the hint but loses the
    // message — which is precisely why an error crosses a process boundary as a
    // `toPayload()` object, and why `is` must still recognise what arrives.
    expect(DebuggenError.is(revived)).toBe(true);
    expect(DebuggenError.is(revived) && revived.code).toBe(SPECIFIC_CODE);
  });

  it('accepts a plain-object copy that has been through structuredClone', () => {
    const clone: unknown = structuredClone(foreignBundleError());

    // A string-keyed boolean is the form that travels. A symbol key would not:
    // structuredClone drops symbol-keyed properties entirely, so a private
    // symbol brand would vanish on exactly the hop it was meant to survive.
    expect(DebuggenError.is(clone)).toBe(true);
    expect(Object.getOwnPropertySymbols(structuredClone({ [Symbol('brand')]: true }))).toEqual([]);
  });

  it('rejects a cloned Error instance, because cloning an Error is lossy', () => {
    const error = new DebuggenError(SPECIFIC_CODE, 'The session store failed.');
    const clone: unknown = structuredClone(error);

    // The structured-clone algorithm keeps only `name`, `message`, `stack` and
    // `cause` of an Error, so the code and the brand do not survive it. Stated
    // as a test rather than left to be discovered: an error travels as a
    // payload the protocol validates, never as a cloned instance.
    expect(DebuggenError.is(clone)).toBe(false);
  });

  it.each(UNBRANDED_VALUES)('rejects $label', ({ value }: LabelledValue) => {
    expect(DebuggenError.is(value)).toBe(false);
  });
});
