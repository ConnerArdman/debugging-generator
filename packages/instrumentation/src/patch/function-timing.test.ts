/**
 * Tests for `./function-timing.ts`: the two ways the mandated wrapper template
 * can change what a developer's program *means*, and the refusals and the
 * annotations that stop it.
 *
 * AAP §0.5.1 states the emitted wrapper verbatim and states its mechanism — the
 * body is moved into an inner function declared inside the original — so the
 * transform cannot choose a different shape to dodge a problem. What it can do
 * is decline a target, which AAP §0.5.5 makes the product's graceful path, and
 * emit a receiver annotation that is *correct*. This suite is the evidence for
 * both, and it is organised around the two failure modes rather than around the
 * module's functions:
 *
 * 1. **A sloppy-mode `arguments` object is observably mapped to its parameter
 *    bindings.** Measured in Node 24 on exactly the shape this module emits:
 *    `arguments[0] = 9` then reading the parameter answers `9` before the patch
 *    and `1` after it; `arguments.callee === f` answers `true` before and
 *    `false` after. Strict code is immune — its arguments object is unmapped and
 *    `.callee` throws — which is why the refusal is narrow enough to matter
 *    almost never: every TypeScript file, every ES module and every class body
 *    is strict.
 * 2. **A receiver type is not a syntax question.** `this: C` on a *static*
 *    method type-checks nowhere (`TS2345`: `typeof C` is not assignable to `C`),
 *    a generic class's type arguments are illegal on a static member
 *    (`TS2302`), a polymorphic `this` cannot be named at all, and an anonymous
 *    class has no name to name. None of it is visible to a syntax-only check,
 *    which is why the module now type-checks its own output and compares the
 *    result against the original's.
 *
 * Three conventions are deliberate.
 *
 * - **Every source is inline text.** `FunctionTimingPatcher` performs no I/O and
 *   takes `text` directly, so a fixture would add a file to read without adding
 *   coverage — and the `.js` sloppy-mode scripts the first half needs do not
 *   exist as fixtures at all.
 * - **A refusal is asserted by its `code`, its `details.reason` and the
 *   presence of a `hint`**, never by its prose: rewording a message must not
 *   fail a test, while losing the machine-readable reason or the developer's
 *   next step must.
 * - **Every successful patch goes through {@link expectPatch}**, which asserts
 *   the properties that hold for *all* of them — the original text returned
 *   unchanged, byte-identical output across two calls, the AAP-verbatim inner
 *   call, and the marker literals the residual-instrumentation gate greps for —
 *   so no individual case has to restate them and none can quietly skip them.
 */

import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import type { Result } from '@debuggen/shared';

import { FunctionTimingPatcher, patchFunctionTiming } from './function-timing.js';
import type { FunctionTimingPatch, FunctionTimingRequest } from './function-timing.js';
import {
  ARGUMENTS_HAZARDS,
  INSTRUMENTATION_MARKERS,
  SPAN_HELPER_GLOBAL,
  SPAN_HELPER_TYPE_NAME,
  STRICT_MODE_DIRECTIVE,
  detectArgumentsHazard,
  isStrictModeDirective,
} from './wrap-template.js';
import type { ArgumentsHazardFacts } from './wrap-template.js';

/**
 * One patcher for every default-option case in this file.
 *
 * Shared on purpose: the class documents that it holds no per-patch state, and
 * the receiver-typing pre-flight loads the TypeScript library files into a
 * private project on first use. Reusing one instance is therefore both the
 * assertion that patches do not contaminate each other and the reason this
 * suite costs one library load rather than one per test.
 */
const patcher = new FunctionTimingPatcher();

/** A patcher with the receiver-typing pre-flight switched off. */
const unverifiedPatcher = new FunctionTimingPatcher({ verifyPatchedTypes: false });

/**
 * Asserts a request is refused, and returns the refusal for further checks.
 *
 * @param result The patch result.
 * @param reason The `details.reason` the refusal must carry.
 * @returns The refusal's `details`, so a caller can assert on the context it
 * carries.
 */
function expectRefusal(
  result: Result<FunctionTimingPatch>,
  reason: string,
): Readonly<Record<string, unknown>> {
  if (result.ok) {
    throw new Error(`expected the refusal ${reason}, received a patch`);
  }

  const error = result.error;

  expect(error.code).toBe('PATCH_UNSUPPORTED');
  expect(error.details?.reason).toBe(reason);
  // A refusal with no next step is a dead end for the developer, and AAP §0.5.5
  // makes the hint part of the graceful path rather than decoration.
  expect(typeof error.hint).toBe('string');
  expect(error.message.endsWith('.')).toBe(true);

  return error.details ?? {};
}

/**
 * Patches a request and asserts everything that must hold for every patch.
 *
 * - The request's own text comes back as `originalText`, unmodified: the caller
 *   hashed those bytes and is about to journal the pair.
 * - Two calls produce byte-identical `patchedText`. Determinism is what lets
 *   `./patcher.ts` record `instrumentedHash` before the write and
 *   `../cleanup.ts` authorise a restore against it.
 * - The emitted text contains the inner call AAP §0.5.1 states verbatim, in the
 *   language the extension implies.
 * - The emitted text contains the marker literals
 *   `scripts/check-no-residual-instrumentation.mjs` greps for: both in a
 *   TypeScript file, and the global alone in a JavaScript file, which receives
 *   no type alias.
 *
 * @param request The target to patch.
 * @param patcherToUse The patcher to run it through, defaulting to the shared
 * one.
 * @returns The patch, for case-specific assertions.
 */
function expectPatch(
  request: FunctionTimingRequest,
  patcherToUse: FunctionTimingPatcher = patcher,
): FunctionTimingPatch {
  const result = patcherToUse.patch(request);

  if (!result.ok) {
    throw new Error(
      `expected a patch, received ${String(result.error.details?.reason)}: ${result.error.message}`,
    );
  }

  const patch = result.value;

  expect(patch.originalText).toBe(request.text);

  const second = patcherToUse.patch(request);

  expect(second.ok).toBe(true);

  if (second.ok) {
    expect(second.value.patchedText).toBe(patch.patchedText);
  }

  const receiver = patch.receiver === 'this' ? 'this' : 'undefined';
  const forwarded = patch.callStyle === 'arguments' ? 'arguments' : patch.restIdentifier;
  const suffix = patch.language === 'typescript' ? ' as never' : '';

  expect(patch.patchedText).toContain(
    `${patch.innerIdentifier}.apply(${receiver}, ${String(forwarded)}${suffix})`,
  );
  expect(patch.patchedText).toContain(SPAN_HELPER_GLOBAL);

  if (patch.language === 'typescript') {
    expect(patch.patchedText).toContain(SPAN_HELPER_TYPE_NAME);
    expect(INSTRUMENTATION_MARKERS.every((marker) => patch.patchedText.includes(marker))).toBe(
      true,
    );
  } else {
    // A `type` alias is a syntax error in a `.js` file, so the second marker
    // must be absent from one.
    expect(patch.patchedText).not.toContain(SPAN_HELPER_TYPE_NAME);
  }

  return patch;
}

/** The line of a patch that declares the inner function. */
function innerDeclarationOf(patch: FunctionTimingPatch): string {
  const line = patch.patchedText
    .split('\n')
    .find((candidate) => candidate.includes(`function ${patch.innerIdentifier}`));

  if (line === undefined) {
    throw new Error('the patched text declares no inner function');
  }

  return line.trim();
}

describe('sloppy-mode arguments (R1-F45)', () => {
  it('refuses a sloppy .js function whose body reads arguments', () => {
    const text = 'function scaleEntry(a) {\n  arguments[0] = 9;\n  return a;\n}\n';
    const result = patcher.patch({ file: 'src/scale.js', symbol: 'scaleEntry', text });
    const details = expectRefusal(result, 'unsupported-mapped-arguments');

    expect(details.hazard).toBe('mapped-arguments');
    expect(details.parameterList).toBe('simple');
    expect(details.parameterCount).toBe(1);
    // Nothing may be produced for a refused target: the caller must have no
    // text it could decide to write.
    expect('value' in result).toBe(false);
  });

  it("patches the same function under a file-level 'use strict'", () => {
    const patch = expectPatch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: "'use strict';\n\nfunction scaleEntry(a) {\n  arguments[0] = 9;\n  return a;\n}\n",
    });

    expect(patch.language).toBe('javascript');
    expect(patch.callStyle).toBe('arguments');
  });

  it("patches the same function under a function-level 'use strict'", () => {
    expectPatch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: "function scaleEntry(a) {\n  'use strict';\n  arguments[0] = 9;\n  return a;\n}\n",
    });
  });

  it('patches the same source as an ES module', () => {
    expectPatch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: 'export function scaleEntry(a) {\n  arguments[0] = 9;\n  return a;\n}\n',
    });
  });

  it('refuses arguments.callee in a sloppy file, in either spelling', () => {
    for (const body of ['arguments.callee', "arguments['callee']"]) {
      const result = patcher.patch({
        file: 'src/scale.js',
        symbol: 'scaleEntry',
        text: `function scaleEntry(a) {\n  return ${body};\n}\n`,
      });

      expect(expectRefusal(result, 'unsupported-arguments-callee').hazard).toBe('arguments-callee');
    }
  });

  it('refuses arguments.callee even when the parameter list is non-simple', () => {
    // A non-simple list makes even a sloppy function's arguments object
    // unmapped, which removes the aliasing but *adds* a `.callee` divergence:
    // measured in Node as the original throwing a TypeError while the patched
    // inner function — whose own parameter list is empty, and therefore simple —
    // answers with a function.
    const result = patcher.patch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: 'function scaleEntry(a = 1) {\n  return arguments.callee;\n}\n',
    });
    const details = expectRefusal(result, 'unsupported-arguments-callee');

    expect(details.parameterList).toBe('non-simple');
  });

  it('refuses a direct eval in a sloppy file', () => {
    const result = patcher.patch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: "function scaleEntry(a) {\n  return eval('a + 1');\n}\n",
    });

    expect(expectRefusal(result, 'unsupported-direct-eval').hazard).toBe('direct-eval');
  });

  it('refuses a parenthesised direct eval in a sloppy file', () => {
    // Parentheses do not make a call indirect. Measured in Node 24 on this
    // exact shape: `(eval)('arguments[0]')` answered 9 before the patch and 1
    // after it, and `(eval)('arguments.callee === f')` went from true to false.
    const result = patcher.patch({
      file: 'src/legacy/tally.js',
      symbol: 'tally',
      text: "function tally(first) {\n  first = 9;\n  return (eval)('arguments[0]');\n}\nmodule.exports = { tally };\n",
    });

    expect(expectRefusal(result, 'unsupported-direct-eval').hazard).toBe('direct-eval');
  });

  it('refuses a direct eval behind a type assertion', () => {
    // `as` erases, so what runs is `(eval)(…)` — direct.
    const result = patcher.patch({
      file: 'src/legacy/tally.ts',
      symbol: 'tally',
      text: "function tally(first: number) {\n  first = 9;\n  return (eval as typeof eval)('arguments[0]');\n}\n",
    });

    expect(expectRefusal(result, 'unsupported-direct-eval').hazard).toBe('direct-eval');
  });

  it('patches an optional-call eval in a sloppy file', () => {
    // Measured as indirect: `eval?.('arguments[0]')` threw a ReferenceError,
    // because an optional call evaluates in the global scope and cannot see the
    // body's bindings.
    expectPatch({
      file: 'src/legacy/tally.js',
      symbol: 'tally',
      text: "function tally(first) {\n  first = 9;\n  return eval?.('1 + 1');\n}\nmodule.exports = { tally };\n",
    });
  });

  it('refuses a computed member name that reads arguments', () => {
    // A computed name is evaluated where the member is *defined* — in this
    // scope, against this `arguments` object — so skipping the member's subtree
    // wholesale would accept this target. Measured: the key was "after"
    // before the patch and "before" after it.
    const result = patcher.patch({
      file: 'src/legacy/tally.js',
      symbol: 'tally',
      text: "function tally(first) {\n  first = 'after';\n  const bag = { [arguments[0]]() { return 1; } };\n  return Object.keys(bag)[0];\n}\nmodule.exports = { tally };\n",
    });

    expect(expectRefusal(result, 'unsupported-mapped-arguments').hazard).toBe('mapped-arguments');
  });

  it('refuses a decorator expression that reads arguments', () => {
    const result = patcher.patch({
      file: 'src/legacy/tally.ts',
      symbol: 'tally',
      text: 'function tally(first: number) {\n  class Inner {\n    @(arguments[0] as never)\n    method() {\n      return first;\n    }\n  }\n  return Inner;\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-mapped-arguments').hazard).toBe('mapped-arguments');
  });

  it('patches a target whose nested object method reads arguments', () => {
    // The nested method binds its own `arguments`, so the outer body does not
    // depend on the binding the move rebinds.
    expectPatch({
      file: 'src/legacy/tally.js',
      symbol: 'tally',
      text: 'function tally(first) {\n  const bag = { inner() { return arguments.length; } };\n  return bag.inner(first);\n}\nmodule.exports = { tally };\n',
    });
  });

  it('patches an indirect eval in a sloppy file', () => {
    // `(0, eval)(…)` evaluates in the global scope and cannot reach the body's
    // bindings, so it is not a hazard and must not be refused as one.
    expectPatch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: "function scaleEntry(a) {\n  return (0, eval)('a + 1');\n}\n",
    });
  });

  it('patches an .mjs file that reads arguments', () => {
    expectPatch({
      file: 'src/scale.mjs',
      symbol: 'scaleEntry',
      text: 'function scaleEntry(a) {\n  return arguments[0] ?? a;\n}\n',
    });
  });

  it('patches a class method that reads arguments in a .js file', () => {
    // Every part of a class declaration is strict code, whatever the file is.
    const patch = expectPatch({
      file: 'src/scale.js',
      symbol: 'settle',
      text: 'class Kiln {\n  settle(a) {\n    return arguments[0] ?? a;\n  }\n}\n',
    });

    expect(patch.shape).toBe('method');
    expect(patch.container).toBe('Kiln');
  });

  it('patches an arrow target whose body mentions arguments', () => {
    // An arrow binds no `arguments`, so the reference resolves lexically and is
    // unaffected by the move; the arrow template forwards a rest parameter.
    const patch = expectPatch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: 'const scaleEntry = (a) => {\n  return typeof arguments;\n};\n',
    });

    expect(patch.callStyle).toBe('rest');
    expect(patch.restIdentifier).toBe('__args');
  });

  it('patches a target whose nested function reads arguments', () => {
    // A nested `function` binds its own `arguments`, so the reference is not the
    // moving function's and the skip set must step over it.
    expectPatch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: 'function scaleEntry(a) {\n  function inner(b) {\n    return arguments[0] ?? b;\n  }\n  return inner(a);\n}\n',
    });
  });

  it('patches a sloppy .js function that reads a property named arguments', () => {
    // `options.arguments` is a property name, not the binding.
    expectPatch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: 'function scaleEntry(options) {\n  return options.arguments;\n}\n',
    });
  });

  it('patches a TypeScript module function that reads arguments', () => {
    expectPatch({
      file: 'src/scale.ts',
      symbol: 'scaleEntry',
      text: 'export function scaleEntry(a: number): number {\n  return (arguments as unknown as number[])[0] ?? a;\n}\n',
    });
  });

  it('patches a sloppy .js function that never mentions arguments', () => {
    expectPatch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: 'function scaleEntry(a) {\n  return a + 1;\n}\n',
    });
  });

  it('refuses a shorthand property that reads arguments', () => {
    // `{ arguments }` is the one name position that *is* a read of the binding.
    const result = patcher.patch({
      file: 'src/scale.js',
      symbol: 'scaleEntry',
      text: 'function scaleEntry(a) {\n  return { arguments };\n}\n',
    });

    expectRefusal(result, 'unsupported-mapped-arguments');
  });

  it('does not accept a template literal or an escaped spelling as a directive', () => {
    // Neither puts the code beneath it in strict mode: a directive must be a
    // string literal, and it must be the unescaped characters. Treating either
    // as strict would let the mapped-arguments divergence through.
    for (const prologue of ['`use strict`;', "'use\\u0020strict';"]) {
      const result = patcher.patch({
        file: 'src/scale.js',
        symbol: 'scaleEntry',
        text: `${prologue}\n\nfunction scaleEntry(a) {\n  arguments[0] = 9;\n  return a;\n}\n`,
      });

      expectRefusal(result, 'unsupported-mapped-arguments');
    }
  });

  it('patches a sloppy .cjs function that reads arguments under a directive', () => {
    expectPatch({
      file: 'src/scale.cjs',
      symbol: 'scaleEntry',
      text: "'use strict';\n\nfunction scaleEntry(a) {\n  return arguments[0] ?? a;\n}\n",
    });
  });
});

describe('executed semantics of an accepted patch', () => {
  /**
   * Evaluates a target's text in a fresh V8 context and hands back the
   * function it declares.
   *
   * A real context rather than a stub: the emitted wrapper reads
   * `globalThis.__DEBUGGEN__`, so the only way to know that an accepted patch
   * behaves identically is to run both texts and compare what they answer. The
   * sandbox is the context's global, which is how a helper — and anything the
   * body reports back — is passed in and read out. A script's top level is
   * sloppy unless its own text says otherwise, so a `'use strict'` target is
   * strict here exactly as it would be in the developer's file.
   *
   * @param text The original or patched source.
   * @param symbol The declared name to hand back.
   * @param sandbox The context's global, seeded by the caller.
   * @returns The declared function.
   */
  function evaluateTarget(
    text: string,
    symbol: string,
    sandbox: Record<string, unknown> = {},
  ): (this: unknown, ...args: readonly unknown[]) => unknown {
    const evaluated: unknown = runInNewContext(`${text}\n;${symbol};`, sandbox);

    if (typeof evaluated !== 'function') {
      throw new Error(`the text does not declare a callable ${symbol}`);
    }

    return evaluated as (this: unknown, ...args: readonly unknown[]) => unknown;
  }

  it('answers identically with and without the patch', () => {
    // Parameter defaults, a destructuring pattern, the receiver and the
    // argument count all survive because the *outer* function keeps its own
    // parameter list; this runs both texts to prove it rather than asserting
    // it about the emitted string.
    const text =
      'function tally(first, { factor = 2 } = {}, third = first + 1) {\n' +
      '  return [first, factor, third, this === undefined ? "none" : this.label].join("|");\n' +
      '}\n';
    const patch = expectPatch({ file: 'src/legacy/tally.js', symbol: 'tally', text });
    const original = evaluateTarget(text, 'tally');
    const patched = evaluateTarget(patch.patchedText, 'tally');
    const receiver = { label: 'kiln' };

    for (const args of [[1], [1, { factor: 5 }], [1, {}, 9], [2, undefined, undefined]]) {
      expect(Reflect.apply(patched, receiver, args)).toBe(Reflect.apply(original, receiver, args));
      expect(Reflect.apply(patched, undefined, args)).toBe(
        Reflect.apply(original, undefined, args),
      );
    }
  });

  it('does not change what strict code observes through arguments', () => {
    // The acceptance of every strict target rests on this: a strict arguments
    // object is unmapped, so assigning the parameter does not show up in
    // `arguments[0]` either before or after the move.
    const text =
      "'use strict';\nfunction tally(first) {\n  first = 9;\n  return [first, arguments[0], arguments.length].join('|');\n}\n";
    const patch = expectPatch({ file: 'src/legacy/tally.js', symbol: 'tally', text });
    const original = evaluateTarget(text, 'tally');
    const patched = evaluateTarget(patch.patchedText, 'tally');

    expect(original(1)).toBe('9|1|1');
    expect(patched(1)).toBe('9|1|1');
    expect(patched(1, 2)).toBe(original(1, 2));
  });

  it('runs the body exactly once, with and without the helper', () => {
    const text =
      'function tally(first) {\n  globalThis.state.calls += 1;\n  return first * 2;\n}\n';
    const patch = expectPatch({ file: 'src/legacy/tally.js', symbol: 'tally', text });
    const withoutHelper: Record<string, unknown> = { state: { calls: 0 } };
    const patchedPlain = evaluateTarget(patch.patchedText, 'tally', withoutHelper);

    expect(patchedPlain(3)).toBe(6);
    expect(withoutHelper.state).toEqual({ calls: 1 });

    const spans: { name: unknown; meta: unknown }[] = [];
    const withHelper: Record<string, unknown> = {
      state: { calls: 0 },
      __DEBUGGEN__: {
        span: (name: unknown, meta: unknown, fn: () => unknown): unknown => {
          spans.push({ name, meta });

          return fn();
        },
      },
    };
    const patchedInstrumented = evaluateTarget(patch.patchedText, 'tally', withHelper);

    expect(patchedInstrumented(4)).toBe(8);
    expect(withHelper.state).toEqual({ calls: 1 });
    expect(spans).toEqual([{ name: 'tally', meta: patch.meta }]);
  });

  it('propagates a thrown error unchanged', () => {
    const text = "function tally(first) {\n  throw new RangeError('too cold: ' + first);\n}\n";
    const patch = expectPatch({ file: 'src/legacy/tally.js', symbol: 'tally', text });
    const original = evaluateTarget(text, 'tally');
    const patched = evaluateTarget(patch.patchedText, 'tally');

    expect(() => original(1)).toThrow('too cold: 1');
    expect(() => patched(1)).toThrow('too cold: 1');
  });
});

describe('detectArgumentsHazard', () => {
  /**
   * The predicate is exported by `./wrap-template.ts`, which has no suite of
   * its own in this checkpoint, and it is the rule the refusals above apply —
   * so it is asserted here, directly, where a change to either side shows up.
   */
  const facts: ArgumentsHazardFacts = {
    strictMode: false,
    parameterList: 'simple',
    parameterCount: 1,
    referencesArguments: false,
    referencesArgumentsCallee: false,
    containsDirectEval: false,
  };

  it('answers undefined for a body that observes nothing', () => {
    expect(detectArgumentsHazard(facts)).toBeUndefined();
  });

  it('answers undefined for strict code whatever it references', () => {
    expect(
      detectArgumentsHazard({
        ...facts,
        strictMode: true,
        referencesArguments: true,
        referencesArgumentsCallee: true,
        containsDirectEval: true,
      }),
    ).toBeUndefined();
  });

  it('reports the sharpest reason first', () => {
    expect(
      detectArgumentsHazard({
        ...facts,
        referencesArguments: true,
        referencesArgumentsCallee: true,
        containsDirectEval: true,
      }),
    ).toBe('arguments-callee');
    expect(
      detectArgumentsHazard({ ...facts, referencesArguments: true, containsDirectEval: true }),
    ).toBe('mapped-arguments');
    expect(detectArgumentsHazard({ ...facts, containsDirectEval: true })).toBe('direct-eval');
  });

  it('does not decide on the parameter list alone', () => {
    expect(detectArgumentsHazard({ ...facts, parameterList: 'non-simple' })).toBeUndefined();
    expect(
      detectArgumentsHazard({
        ...facts,
        parameterList: 'non-simple',
        parameterCount: 0,
        referencesArgumentsCallee: true,
      }),
    ).toBe('arguments-callee');
  });

  it('answers only within its own vocabulary', () => {
    const answers = [
      detectArgumentsHazard({ ...facts, referencesArguments: true }),
      detectArgumentsHazard({ ...facts, referencesArgumentsCallee: true }),
      detectArgumentsHazard({ ...facts, containsDirectEval: true }),
    ];

    // One answer per hazard, in the vocabulary's own order: a new hazard in
    // `./wrap-template.ts` fails here until it has a case of its own.
    expect(answers).toStrictEqual([...ARGUMENTS_HAZARDS]);
  });
});

describe('the strict-mode directive', () => {
  it('is read out of the directive vocabulary', () => {
    expect(STRICT_MODE_DIRECTIVE).toBe('use strict');
    expect(isStrictModeDirective(STRICT_MODE_DIRECTIVE)).toBe(true);
  });

  it('is not satisfied by another directive or a different spelling', () => {
    expect(isStrictModeDirective('use client')).toBe(false);
    expect(isStrictModeDirective('use server')).toBe(false);
    expect(isStrictModeDirective(' use strict ')).toBe(false);
    expect(isStrictModeDirective('USE STRICT')).toBe(false);
  });
});

describe('receiver typing (R1-F46)', () => {
  it('types a static method with the constructor type', () => {
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'build',
      text: 'export class Kiln {\n  heat = 1;\n  static build(count: number): number {\n    return count + 1;\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain('this: typeof Kiln');
  });

  it("types a generic class's static method without type arguments", () => {
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'build',
      text: 'export class Kiln<T> {\n  items: T[] = [];\n  static build(count: number): number {\n    return count + 1;\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain('this: typeof Kiln');
    // `typeof Kiln<T>` would be TS2302: a static member may not reference the
    // class's type parameters.
    expect(patch.patchedText).not.toContain('typeof Kiln<');
  });

  it("types a generic class's instance method with its type parameters", () => {
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'first',
      text: 'export class Kiln<T, U extends object = object> {\n  items: T[] = [];\n  #tag: U | undefined;\n  first(): T | undefined {\n    return this.items[0] ?? undefined;\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain('this: Kiln<T, U>');
  });

  it('copies an explicit this annotation verbatim', () => {
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'settle',
      text: 'export interface Ctx {\n  id: string;\n}\n\nexport function settle(this: Ctx, extra: number): string {\n  return this.id + String(extra);\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain('this: Ctx');
    expect(patch.receiver).toBe('this');
  });

  it('refuses a method declared as returning this', () => {
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'step',
      text: 'export class Kiln {\n  count = 0;\n  step(): this {\n    this.count += 1;\n    return this;\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('signature');
  });

  it('refuses a method with no return type that returns this', () => {
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'step',
      text: 'export class Kiln {\n  count = 0;\n  step() {\n    this.count += 1;\n    return this;\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('returned-this');
  });

  it('refuses a method that returns an arrow closing over this', () => {
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'lazy',
      text: 'export class Kiln {\n  count = 0;\n  lazy() {\n    return () => this;\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('returned-this');
  });

  it('refuses a method that hands back a sibling answering the this type', () => {
    // The fluent shape, and the one no same-file check can catch: measured, the
    // patched method type-checks cleanly and the narrowing from `this` to
    // `Kiln` surfaces as `TS2741` at a subclass call site in another file.
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'run',
      text: 'export class Kiln {\n  step(): this {\n    return this;\n  }\n  run() {\n    return this.step();\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('delegated-this');
  });

  it('refuses a delegation through a sibling whose return type is inferred', () => {
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'run',
      text: 'export class Kiln {\n  step() {\n    return this;\n  }\n  run() {\n    return this.step();\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('delegated-this');
  });

  it('refuses a delegation through an awaited sibling promise of this', () => {
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'load',
      text: 'export class Kiln {\n  settle(): Promise<this> {\n    return Promise.resolve(this);\n  }\n  async load() {\n    return await this.settle();\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('delegated-this');
  });

  it('refuses a delegation through a field that holds the receiver', () => {
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'own',
      text: 'export class Kiln {\n  self = this;\n  own() {\n    return this.self;\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('delegated-this');
  });

  it('refuses a delegation inside a concise arrow body', () => {
    // `() => this.step()` answers `() => this`, and a concise body has no
    // `return` statement for a statement-wise scan to find.
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'lazy',
      text: 'export class Kiln {\n  step(): this {\n    return this;\n  }\n  lazy() {\n    return () => this.step();\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('delegated-this');
  });

  it('refuses a delegation inside a block-bodied arrow', () => {
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'lazy',
      text: 'export class Kiln {\n  step(): this {\n    return this;\n  }\n  lazy() {\n    return () => {\n      return this.step();\n    };\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('delegated-this');
  });

  it('patches a method whose un-returned arrow delegates', () => {
    // The arrow never leaves the method, so the method's type does not carry
    // what it answers and there is nothing to narrow.
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'total',
      text: 'export class Kiln {\n  heat = 1;\n  step(): this {\n    return this;\n  }\n  total() {\n    const again = () => this.step();\n    return this.heat + (again === undefined ? 1 : 0);\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain('this: Kiln');
  });

  it('patches a delegation to a sibling that answers a concrete type', () => {
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'run',
      text: 'export class Kiln {\n  heat = 1;\n  step(): number {\n    return this.heat;\n  }\n  run() {\n    return this.step();\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain('this: Kiln');
  });

  it('patches a delegation the method declares a return type for', () => {
    // With the return type written down there is nothing left to infer, so the
    // annotation cannot narrow what a caller sees.
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'run',
      text: 'export class Kiln {\n  step(): this {\n    return this;\n  }\n  run(): Kiln {\n    return this.step();\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain('this: Kiln');
  });

  it('patches a method that returns a member of a member', () => {
    // `this.items.map(…)` answers with an array's member, not the receiver's,
    // and a chain past the receiver is deliberately not followed.
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'listed',
      text: 'export class Kiln {\n  items: number[] = [];\n  listed() {\n    return this.items.map((item) => item + 1);\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain('this: Kiln');
  });

  it('does not reach an instance member from a static delegation', () => {
    // A `this.make()` in a static method names the static `make`; blaming it
    // for the instance member of the same name would be a refusal the
    // developer cannot act on. (`static make(): this` is not expressible —
    // TypeScript answers `TS2526` — so the static side has no polymorphic
    // case to find.)
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'Kiln.run',
      text: 'export class Kiln {\n  make(): this {\n    return this;\n  }\n  static make(): number {\n    return 1;\n  }\n  static run() {\n    return this.make();\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain('this: typeof Kiln');
  });

  it('terminates on a cycle of sibling delegations', () => {
    // Mutually recursive members would walk for ever without the visited set.
    // The scan runs to an answer — "not polymorphic" — which is what patching
    // with the pre-flight off demonstrates.
    const request = {
      file: 'src/kiln.ts',
      symbol: 'first',
      text: 'export class Kiln {\n  first() {\n    return this.second();\n  }\n  second() {\n    return this.first();\n  }\n}\n',
    };
    const patch = expectPatch(request, unverifiedPatcher);

    expect(innerDeclarationOf(patch)).toContain('this: Kiln');

    // With the pre-flight on it is refused for a different and correct reason:
    // TypeScript cannot infer a return type through the cycle, so the file
    // already carries two `TS7023`s and the wrapper adds a third for the inner
    // function plus a `TS7024` — build errors under codes no receiver-typing
    // list would hold, which is why the comparison is over every diagnostic.
    const details = expectRefusal(patcher.patch(request), 'unsupported-introduced-diagnostic');

    expect(String(JSON.stringify(details.diagnostics))).toContain('7023');
  });

  it('refuses a delegation through element access', () => {
    // `this['self']` names the member exactly as `this.self` does. Verified
    // independently: this source has no diagnostics, and the patched text with
    // an inner `this: Base` produces `TS2741` at the subclass call site.
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'own',
      text: "export class Base {\n  self: this = this;\n  own() {\n    return this['self'];\n  }\n}\n",
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('delegated-this');
  });

  it('refuses a delegation to a member the class could have inherited', () => {
    // `Kiln` extends something declared elsewhere, so `step` may answer `this`
    // and no reading of this file can say. Unprovable is a refusal.
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'run',
      text: "import { Furnace } from './furnace.js';\n\nexport class Kiln extends Furnace {\n  run() {\n    return this.step();\n  }\n}\n",
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('delegated-this');
  });

  it('refuses a computed delegation the class could have inherited', () => {
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'run',
      text: "import { Furnace } from './furnace.js';\n\nexport class Kiln extends Furnace {\n  run() {\n    const key = 'step' as const;\n    return this[key];\n  }\n}\n",
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('delegated-this');
  });

  it('patches a delegation to a member no base class could supply', () => {
    // No heritage clause, so an unresolved name is the developer's own error
    // rather than a member that might answer `this`, and nothing is refused
    // over it.
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'run',
      text: "export class Kiln {\n  heat = 1;\n  run() {\n    const key = 'heat' as const;\n    return this[key];\n  }\n}\n",
    });

    expect(innerDeclarationOf(patch)).toContain('this: Kiln');
  });

  it('refuses a method whose own this parameter is the this type', () => {
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'step',
      text: 'export class Kiln {\n  count = 0;\n  step(this: this, extra: number): number {\n    return this.count + extra;\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('this-parameter');
  });

  it('refuses a method whose body annotates a local with the this type', () => {
    // The annotation moves into a plain function, where the `this` type does
    // not exist at all (`TS2526`).
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'settle',
      text: 'export class Kiln {\n  heat = 1;\n  settle(extra: number): number {\n    const self: this = this;\n    return self.heat + extra;\n  }\n}\n',
    });

    expect(expectRefusal(result, 'unsupported-polymorphic-this').site).toBe('body-annotation');
  });

  it('refuses a this-using method of an anonymous class', () => {
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'total',
      text: 'export default class {\n  heat = 2;\n  total(extra: number): number {\n    return this.heat + extra;\n  }\n}\n',
    });
    const details = expectRefusal(result, 'unsupported-anonymous-class');

    expect(details.symbol).toBe('total');
  });

  it('patches a method of an anonymous class that does not read this', () => {
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'total',
      text: 'export default class {\n  heat = 2;\n  total(extra: number): number {\n    return extra + 1;\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).not.toContain('this:');
  });

  it('patches a method that only reads through this', () => {
    // The overwhelmingly common case, and the one a naive `return this` scan
    // would refuse: `this.heat` yields the property's type, not the receiver's,
    // so nothing about the method's type narrows.
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'total',
      text: 'export class Kiln {\n  heat = 3;\n  total(extra: number) {\n    return this.heat + extra;\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain('this: Kiln');
  });

  it('patches an async method that awaits inside the moved body', () => {
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'load',
      text: 'export class Kiln {\n  heat = 3;\n  async load(): Promise<number> {\n    return await Promise.resolve(this.heat);\n  }\n}\n',
    });

    expect(innerDeclarationOf(patch)).toContain(`async function ${patch.innerIdentifier}`);
  });

  it('refuses a receiver type a method type parameter shadows', () => {
    // The one shadowing form that actually reaches the annotation: a method type
    // parameter named after its class is in scope where the inner function's
    // `this` annotation is written, so `this: Kiln` resolves to the parameter.
    // No syntax check can see it; the pre-flight reads it off the compiler.
    const result = patcher.patch({
      file: 'src/kiln.ts',
      symbol: 'pick',
      text: 'export class Kiln {\n  heat = 1;\n  pick<Kiln>(candidate: Kiln): number {\n    return this.heat;\n  }\n}\n',
    });
    const details = expectRefusal(result, 'unsupported-introduced-diagnostic');
    const diagnostics = details.diagnostics;

    expect(Array.isArray(diagnostics)).toBe(true);
    expect(typeof details.diagnosticCount).toBe('number');
    expect(JSON.stringify(diagnostics)).toContain('2345');
  });

  it('does not refuse that target when verifyPatchedTypes is off', () => {
    // Proves the option is wired rather than merely accepted: the same source,
    // the same refusal path, one flag apart.
    const patch = expectPatch(
      {
        file: 'src/kiln.ts',
        symbol: 'pick',
        text: 'export class Kiln {\n  heat = 1;\n  pick<Kiln>(candidate: Kiln): number {\n    return this.heat;\n  }\n}\n',
      },
      unverifiedPatcher,
    );

    expect(innerDeclarationOf(patch)).toContain('this: Kiln');
  });

  it("does not blame the patch for the target's own type errors", () => {
    // An unresolved import reports TS2307 in both programs, so the delta
    // cancels and the patch is returned; `patchFunctionTiming` is exercised here
    // as the one-shot entry point callers with a single target use.
    const result = patchFunctionTiming({
      file: 'src/kiln.ts',
      symbol: 'total',
      text: "import { missing } from './nowhere.js';\n\nexport class Kiln {\n  heat = 3;\n  total(extra: number): number {\n    return this.heat + extra + missing;\n  }\n}\n",
    });

    expect(result.ok).toBe(true);
  });

  it('emits no annotation for a standalone TypeScript function', () => {
    const patch = expectPatch({
      file: 'src/kiln.ts',
      symbol: 'settle',
      text: 'export function settle(extra: number): number {\n  return extra + 1;\n}\n',
    });

    expect(patch.receiver).toBe('undefined');
    expect(innerDeclarationOf(patch)).toContain(`function ${patch.innerIdentifier}()`);
  });

  it('emits no annotation into a JavaScript class method', () => {
    // A parameter annotation is a syntax error in a `.js` file.
    const patch = expectPatch({
      file: 'src/kiln.js',
      symbol: 'settle',
      text: 'export class Kiln {\n  settle(extra) {\n    return this.heat + extra;\n  }\n}\n',
    });

    expect(patch.receiver).toBe('this');
    expect(innerDeclarationOf(patch)).toContain(`function ${patch.innerIdentifier}()`);
  });
});
