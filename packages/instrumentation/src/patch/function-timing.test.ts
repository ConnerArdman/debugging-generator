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

import {
  PATCH_NON_ADDRESSABLE_POSITIONS,
  PATCH_REACT_SITES,
  PATCH_TARGET_SHAPES,
  FunctionTimingPatcher,
  patchFunctionTiming,
} from './function-timing.js';
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
 * @param code The error code it must carry. `'PATCH_UNSUPPORTED'` by default,
 * which is every refusal of a target that *resolved*; the resolution refusals —
 * a symbol the file does not declare, one it declares in a position no wrapper
 * can replace, an ambiguous one — carry `'PATCH_TARGET_NOT_FOUND'` instead,
 * because nothing was resolved to refuse.
 * @returns The refusal's `details`, so a caller can assert on the context it
 * carries.
 */
function expectRefusal(
  result: Result<FunctionTimingPatch>,
  reason: string,
  code: 'PATCH_TARGET_NOT_FOUND' | 'PATCH_UNSUPPORTED' = 'PATCH_UNSUPPORTED',
): Readonly<Record<string, unknown>> {
  if (result.ok) {
    throw new Error(`expected the refusal ${reason}, received a patch`);
  }

  const error = result.error;

  expect(error.code).toBe(code);
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

  it('runs a patched nested function exactly once, answering identically', () => {
    // The nested case of the guarantee above. The wrapper now sits inside the
    // enclosing function's body, so the enclosing call is what exercises it,
    // and the closure the body reads — `seed` — is a binding the move must not
    // disturb.
    const text =
      'function outer(seed) {\n' +
      '  function tally(first) {\n' +
      '    globalThis.state.calls += 1;\n' +
      '    return first + seed;\n' +
      '  }\n' +
      '  const sibling = seed + 1;\n' +
      '  return tally(2) + tally(3) + sibling;\n' +
      '}\n';
    const patch = expectPatch({ file: 'src/legacy/tally.js', symbol: 'tally', text });

    expect(patch.enclosing).toBe('outer');

    const originalSandbox: Record<string, unknown> = { state: { calls: 0 } };
    const original = evaluateTarget(text, 'outer', originalSandbox);
    const withoutHelper: Record<string, unknown> = { state: { calls: 0 } };
    const patched = evaluateTarget(patch.patchedText, 'outer', withoutHelper);

    expect(patched(10)).toBe(original(10));
    expect(withoutHelper.state).toEqual({ calls: 2 });

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
    const instrumented = evaluateTarget(patch.patchedText, 'outer', withHelper);

    expect(instrumented(10)).toBe(original(10));
    expect(withHelper.state).toEqual({ calls: 2 });
    // One span per call of the nested function, each carrying the nested
    // declaration's own position rather than the enclosing function's.
    expect(spans).toEqual([
      { name: 'tally', meta: patch.meta },
      { name: 'tally', meta: patch.meta },
    ]);
  });

  it('preserves a nested body that reads an enclosing binding named __orig', () => {
    // The collision the wider identifier scan exists for: the binding the body
    // reads is declared one frame out, in the enclosing function, so a wrapper
    // that named its inner function `__orig` would shadow it and the body would
    // read a function where it expected a string.
    const text =
      'function outer(input) {\n' +
      '  const __orig = input.trim();\n' +
      '  function normalise() {\n' +
      '    return __orig.toUpperCase();\n' +
      '  }\n' +
      '  return normalise();\n' +
      '}\n';
    const patch = expectPatch({ file: 'src/legacy/tally.js', symbol: 'normalise', text });

    expect(patch.innerIdentifier).toBe('__orig_1');
    expect(patch.patchedText).toContain('return __orig.toUpperCase();');

    const original = evaluateTarget(text, 'outer');
    const patched = evaluateTarget(patch.patchedText, 'outer');

    expect(patched('  ab ')).toBe('AB');
    expect(patched('  ab ')).toBe(original('  ab '));
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

describe('nested declarations (C1-F06)', () => {
  /** A component-shaped enclosing function with a handler nested inside it. */
  const NESTED_FUNCTION_TEXT =
    'export function outer(seed: number): number {\n' +
    '  function tally(first: number): number {\n' +
    '    return first + seed;\n' +
    '  }\n' +
    '  const sibling = seed + 1;\n' +
    '\n' +
    '  return tally(2) + sibling;\n' +
    '}\n';

  it('patches a nested function declaration in place', () => {
    const patch = expectPatch({
      file: 'src/panel.ts',
      symbol: 'tally',
      text: NESTED_FUNCTION_TEXT,
    });

    expect(patch.shape).toBe('function-declaration');
    expect(patch.callStyle).toBe('arguments');
    expect(patch.enclosing).toBe('outer');
    expect(patch.container).toBeUndefined();
    // The recorded position is the nested name's own, not the enclosing one's.
    expect(patch.location.line).toBe(2);
    expect(patch.meta.symbol).toBe('tally');
  });

  it('confines a nested patch to the nested declaration', () => {
    const patch = expectPatch({
      file: 'src/panel.ts',
      symbol: 'tally',
      text: NESTED_FUNCTION_TEXT,
    });
    const bodyEdit = patch.edits.at(-1);

    expect(bodyEdit?.purpose).toBe('function-body');
    // The edit starts after the nested declaration begins and ends before the
    // next statement of the enclosing body, so everything the enclosing
    // function declares around the target is untouched.
    expect(bodyEdit?.start).toBeGreaterThan(NESTED_FUNCTION_TEXT.indexOf('  function tally('));
    expect(bodyEdit?.end).toBeLessThan(NESTED_FUNCTION_TEXT.indexOf('  const sibling'));
    expect(patch.patchedText).toContain('  const sibling = seed + 1;\n');
    expect(patch.patchedText).toContain('  return tally(2) + sibling;\n');
    // The enclosing signature is not even read, let alone rewritten.
    expect(patch.patchedText).toContain('export function outer(seed: number): number {\n');
  });

  it('indents a nested wrapper with the file\u2019s own indentation', () => {
    const patch = expectPatch({
      file: 'src/panel.ts',
      symbol: 'tally',
      text: NESTED_FUNCTION_TEXT,
    });

    // The nested body is indented four spaces in the original, and the
    // statements inserted beside it take that same indentation back.
    expect(patch.patchedText).toContain(`    const ${patch.helperIdentifier} = `);
  });

  it('patches a nested arrow declarator with the rest-parameter template', () => {
    const patch = expectPatch({
      file: 'src/panel.tsx',
      symbol: 'handleRetry',
      text:
        'export function Panel(props: { retry: () => void }): number {\n' +
        '  const handleRetry = (): void => {\n' +
        '    props.retry();\n' +
        '  };\n' +
        '\n' +
        '  handleRetry();\n' +
        '\n' +
        '  return 1;\n' +
        '}\n',
    });

    expect(patch.shape).toBe('arrow-function');
    expect(patch.callStyle).toBe('rest');
    expect(patch.restIdentifier).toBe('__args');
    expect(patch.enclosing).toBe('Panel');
    expect(patch.edits.at(-1)?.purpose).toBe('function-declaration');
  });

  it('patches a nested function expression declarator', () => {
    const patch = expectPatch({
      file: 'src/panel.ts',
      symbol: 'settle',
      text:
        'export function outer(): number {\n' +
        '  const settle = function (a: number): number {\n' +
        '    return a + 1;\n' +
        '  };\n' +
        '\n' +
        '  return settle(1);\n' +
        '}\n',
    });

    expect(patch.shape).toBe('function-expression');
    expect(patch.enclosing).toBe('outer');
  });

  it('names a nested declaration inside an arrow-bodied enclosing declaration', () => {
    // The enclosing scope has no name of its own; the declaration it
    // initialises supplies one, which is what makes `Panel.handleThing`
    // addressable for a component written as a `const`.
    const patch = expectPatch({
      file: 'src/panel.tsx',
      symbol: 'Panel.handleThing',
      text:
        'export const Panel = (): number => {\n' +
        '  function handleThing(): number {\n' +
        '    return 1;\n' +
        '  }\n' +
        '\n' +
        '  return handleThing();\n' +
        '}\n',
    });

    expect(patch.enclosing).toBe('Panel');
    expect(patch.shape).toBe('function-declaration');
  });

  it('addresses a nested declaration by the bare name and both qualified spellings', () => {
    const bare = expectPatch({ file: 'src/panel.ts', symbol: 'tally', text: NESTED_FUNCTION_TEXT });
    const dotted = expectPatch({
      file: 'src/panel.ts',
      symbol: 'outer.tally',
      text: NESTED_FUNCTION_TEXT,
    });
    const hashed = expectPatch({
      file: 'src/panel.ts',
      symbol: 'outer#tally',
      text: NESTED_FUNCTION_TEXT,
    });

    // One declaration, three spellings, one set of bytes: the spelling selects
    // the target and contributes nothing to the output.
    expect(dotted.patchedText).toBe(bare.patchedText);
    expect(hashed.patchedText).toBe(bare.patchedText);
  });

  it('lets a module-scope declaration keep the bare name', () => {
    // The precedence that keeps every target that worked before nested
    // resolution existed working: the outer declaration answers the bare name,
    // and the nested one is reachable only through its qualified spelling.
    const text =
      'export function tally(a: number): number {\n' +
      '  return a;\n' +
      '}\n' +
      '\n' +
      'export function outer(seed: number): number {\n' +
      '  function tally(first: number): number {\n' +
      '    return first + seed;\n' +
      '  }\n' +
      '\n' +
      '  return tally(2);\n' +
      '}\n';
    const outerTarget = expectPatch({ file: 'src/panel.ts', symbol: 'tally', text });

    expect(outerTarget.enclosing).toBeUndefined();
    expect(outerTarget.location.line).toBe(1);

    const nestedTarget = expectPatch({ file: 'src/panel.ts', symbol: 'outer.tally', text });

    expect(nestedTarget.enclosing).toBe('outer');
    expect(nestedTarget.location.line).toBe(6);
  });

  it('refuses two nested declarations of one name, naming the spellings that disambiguate', () => {
    const text =
      'export function First(): number {\n' +
      '  function handleThing(): number {\n' +
      '    return 1;\n' +
      '  }\n' +
      '\n' +
      '  return handleThing();\n' +
      '}\n' +
      '\n' +
      'export function Second(): number {\n' +
      '  function handleThing(): number {\n' +
      '    return 2;\n' +
      '  }\n' +
      '\n' +
      '  return handleThing();\n' +
      '}\n';
    const result = patcher.patch({ file: 'src/panel.ts', symbol: 'handleThing', text });
    const details = expectRefusal(result, 'ambiguous-symbol', 'PATCH_TARGET_NOT_FOUND');

    expect(details.candidates).toEqual([
      { container: undefined, enclosing: 'First', line: 2 },
      { container: undefined, enclosing: 'Second', line: 10 },
    ]);

    if (result.ok) {
      throw new Error('expected an ambiguity refusal');
    }

    expect(result.error.hint).toContain('First.handleThing');
    expect(result.error.hint).toContain('Second.handleThing');

    // And each spelling the hint offers actually resolves.
    expect(
      expectPatch({ file: 'src/panel.ts', symbol: 'First.handleThing', text }).location.line,
    ).toBe(2);
    expect(
      expectPatch({ file: 'src/panel.ts', symbol: 'Second.handleThing', text }).location.line,
    ).toBe(10);
  });

  it('disambiguates the inner identifier against a binding in the enclosing scope', () => {
    // `allocateIdentifiers` scans the enclosing top-level declaration for a
    // nested target precisely so this binding is seen: it is not inside the
    // nested declaration at all.
    const patch = expectPatch({
      file: 'src/panel.ts',
      symbol: 'normalise',
      text:
        'export function outer(input: string): string {\n' +
        '  const __orig = input.trim();\n' +
        '  function normalise(): string {\n' +
        '    return __orig.toUpperCase();\n' +
        '  }\n' +
        '\n' +
        '  return normalise();\n' +
        '}\n',
    });

    expect(patch.innerIdentifier).toBe('__orig_1');
    expect(patch.patchedText).toContain('function __orig_1(');
    expect(patch.patchedText).toContain('return __orig.toUpperCase();');
  });

  it('patches a declaration at the supported nesting depth and refuses one beyond it', () => {
    /**
     * Builds a file whose `target` sits `scopes` function bodies deep.
     *
     * @param scopes How many function-like scopes enclose the target.
     * @returns The source text.
     */
    function nestText(scopes: number): string {
      let text = '';

      for (let level = 0; level < scopes; level += 1) {
        text += `${'  '.repeat(level)}${level === 0 ? 'export ' : ''}function level${String(level)}(): number {\n`;
      }

      text += `${'  '.repeat(scopes)}function target(): number {\n${'  '.repeat(scopes + 1)}return 1;\n${'  '.repeat(scopes)}}\n`;
      text += `${'  '.repeat(scopes)}return target();\n`;

      for (let level = scopes - 1; level >= 0; level -= 1) {
        text += `${'  '.repeat(level)}}\n`;
      }

      return text;
    }

    const deepest = expectPatch({ file: 'src/panel.ts', symbol: 'target', text: nestText(8) });

    expect(deepest.enclosing).toBe('level7');

    const details = expectRefusal(
      patcher.patch({ file: 'src/panel.ts', symbol: 'target', text: nestText(9) }),
      'symbol-not-addressable',
      'PATCH_TARGET_NOT_FOUND',
    );

    expect(details.position).toBe('unreachable-scope');
  });
});

describe('a declaration in a position no wrapper can replace (C1-F07)', () => {
  /**
   * Asserts a target is refused as not addressable, and returns the details.
   *
   * The distinction the finding is about: this is `PATCH_TARGET_NOT_FOUND` like
   * `'symbol-not-found'` — nothing may be written either way — but it says the
   * declaration *was* found, which is what makes "re-index the project" the
   * wrong advice and the hint's own next step the right one.
   *
   * @param request The target to patch.
   * @param position The `details.position` the refusal must carry.
   * @param enclosing The declaration the hint must name, or `undefined` when
   * the declaration sits at module scope.
   * @returns The refusal's `details`.
   */
  function expectNotAddressable(
    request: FunctionTimingRequest,
    position: string,
    enclosing: string | undefined,
  ): Readonly<Record<string, unknown>> {
    const result = patcher.patch(request);
    const details = expectRefusal(result, 'symbol-not-addressable', 'PATCH_TARGET_NOT_FOUND');

    expect(details.position).toBe(position);
    expect(details.enclosing).toBe(enclosing);
    expect(details.shapes).toEqual([...PATCH_TARGET_SHAPES]);

    if (result.ok) {
      throw new Error('expected a refusal');
    }

    const hint = result.error.hint ?? '';

    if (enclosing !== undefined) {
      expect(hint).toContain(enclosing);
    }

    // Never a fragment of the developer's source, in the message or the hint.
    expect(result.error.message).not.toContain('=>');
    expect(result.error.message).not.toContain('{');

    return details;
  }

  it('refuses a destructured prop parameter', () => {
    expectNotAddressable(
      {
        file: 'src/panel.tsx',
        symbol: 'onPick',
        text:
          'export function Row({ onPick }: { onPick: () => void }): number {\n' +
          '  onPick();\n' +
          '\n' +
          '  return 1;\n' +
          '}\n',
      },
      'parameter',
      'Row',
    );
  });

  it('refuses a plain parameter', () => {
    expectNotAddressable(
      {
        file: 'src/panel.tsx',
        symbol: 'onPick',
        text:
          'export function Row(onPick: () => void): number {\n' +
          '  onPick();\n' +
          '\n' +
          '  return 1;\n' +
          '}\n',
      },
      'parameter',
      'Row',
    );
  });

  it('refuses an object binding element', () => {
    expectNotAddressable(
      {
        file: 'src/panel.tsx',
        symbol: 'onClose',
        text:
          'export function Panel(props: { onClose: () => void }): number {\n' +
          '  const { onClose } = props;\n' +
          '\n' +
          '  onClose();\n' +
          '\n' +
          '  return 1;\n' +
          '}\n',
      },
      'binding-element',
      'Panel',
    );
  });

  it('refuses an array binding element', () => {
    // The `const [q, setQ] = useState('')` shape: the second element is a
    // function at run time and no declaration at all in the syntax.
    expectNotAddressable(
      {
        file: 'src/panel.tsx',
        symbol: 'setQ',
        text:
          "import { useState } from 'react';\n" +
          '\n' +
          'export function Field(): string {\n' +
          "  const [q, setQ] = useState('');\n" +
          '\n' +
          '  return q + String(setQ);\n' +
          '}\n',
      },
      'binding-element',
      'Field',
    );
  });

  it('refuses a nested declarator whose initialiser is not a function', () => {
    expectNotAddressable(
      {
        file: 'src/panel.tsx',
        symbol: 'cb',
        text:
          "import { useCallback } from 'react';\n" +
          '\n' +
          'export function Panel(): number {\n' +
          '  const cb = useCallback(() => 1, []);\n' +
          '\n' +
          '  return cb();\n' +
          '}\n',
      },
      'non-function-declarator',
      'Panel',
    );
  });

  it('keeps unsupported-declaration for a module-scope declarator that holds no function', () => {
    // The module-scope counterpart is *resolved* and refused for holding no
    // function, which is unchanged: a plan naming it is naming a real export.
    expectRefusal(
      patcher.patch({
        file: 'src/panel.ts',
        symbol: 'limit',
        text: 'export const limit = 4;\n',
      }),
      'unsupported-declaration',
    );
  });

  it('refuses an object-literal method', () => {
    expectNotAddressable(
      {
        file: 'src/panel.ts',
        symbol: 'settle',
        text: 'export const handlers = {\n  settle() {\n    return 1;\n  },\n};\n',
      },
      'object-literal-member',
      undefined,
    );
  });

  it('refuses an object-literal property that holds a function', () => {
    expectNotAddressable(
      {
        file: 'src/panel.ts',
        symbol: 'settle',
        text: 'export const handlers = {\n  settle: (): number => 1,\n};\n',
      },
      'object-literal-member',
      undefined,
    );
  });

  it('refuses a type-level declaration', () => {
    // The more precise answer for a case that used to report "no such symbol":
    // a type alias is declared right there, and erases before anything runs.
    expectNotAddressable(
      {
        file: 'src/panel.ts',
        symbol: 'Settings',
        text: 'export type Settings = {\n  readonly mode: string;\n};\n',
      },
      'type-declaration',
      undefined,
    );

    expectNotAddressable(
      {
        file: 'src/panel.ts',
        symbol: 'Mode',
        text: 'export interface Mode {\n  readonly kind: string;\n}\n',
      },
      'type-declaration',
      undefined,
    );

    expectNotAddressable(
      {
        file: 'src/panel.ts',
        symbol: 'Level',
        text: 'export enum Level {\n  Low = 1,\n}\n',
      },
      'type-declaration',
      undefined,
    );
  });

  it('refuses a class and a member of a class it does not address', () => {
    expectNotAddressable(
      {
        file: 'src/panel.ts',
        symbol: 'Kiln',
        text: 'export class Kiln {\n  heat = 1;\n}\n',
      },
      'class-declaration',
      undefined,
    );

    expectNotAddressable(
      {
        file: 'src/panel.ts',
        symbol: 'settle',
        text:
          'export const Kiln = class {\n' +
          '  settle(): number {\n' +
          '    return 1;\n' +
          '  }\n' +
          '};\n',
      },
      'class-member',
      undefined,
    );
  });

  it('refuses an imported binding and points at the module that declares it', () => {
    const result = patcher.patch({
      file: 'src/panel.ts',
      symbol: 'load',
      text: "import { load } from './store.js';\n\nexport function run(): number {\n  return load();\n}\n",
    });
    const details = expectRefusal(result, 'symbol-not-addressable', 'PATCH_TARGET_NOT_FOUND');

    expect(details.position).toBe('import-binding');

    if (result.ok) {
      throw new Error('expected a refusal');
    }

    expect(result.error.hint).toContain('load');
  });

  it('refuses an aliased import under its local name only', () => {
    const text =
      "import { load as fetchRows } from './store.js';\n\nexport const rows = fetchRows;\n";

    expect(
      expectRefusal(
        patcher.patch({ file: 'src/panel.ts', symbol: 'fetchRows', text }),
        'symbol-not-addressable',
        'PATCH_TARGET_NOT_FOUND',
      ).position,
    ).toBe('import-binding');

    // The imported module's own spelling is not something this file declares.
    expectRefusal(
      patcher.patch({ file: 'src/panel.ts', symbol: 'load', text }),
      'symbol-not-found',
      'PATCH_TARGET_NOT_FOUND',
    );
  });

  it('refuses a function declared in a namespace body', () => {
    expectNotAddressable(
      {
        file: 'src/panel.ts',
        symbol: 'helper',
        text:
          'export namespace Support {\n' +
          '  export function helper(): number {\n' +
          '    return 1;\n' +
          '  }\n' +
          '}\n',
      },
      'unreachable-scope',
      undefined,
    );
  });

  it('refuses a qualified spelling whose container does not match, naming the one that does', () => {
    const result = patcher.patch({
      file: 'src/panel.ts',
      symbol: 'Nowhere.tally',
      text:
        'export function outer(): number {\n' +
        '  function tally(): number {\n' +
        '    return 1;\n' +
        '  }\n' +
        '\n' +
        '  return tally();\n' +
        '}\n',
    });
    const details = expectRefusal(result, 'symbol-not-addressable', 'PATCH_TARGET_NOT_FOUND');

    expect(details.position).toBe('mismatched-container');
    expect(details.container).toBe('Nowhere');

    if (result.ok) {
      throw new Error('expected a refusal');
    }

    expect(result.error.hint).toContain('outer.tally');
  });

  it('names the class a mis-qualified member really belongs to', () => {
    const text = 'export class Kiln {\n  settle(): number {\n    return 1;\n  }\n}\n';
    const result = patcher.patch({ file: 'src/kiln.ts', symbol: 'Nowhere.settle', text });
    const details = expectRefusal(result, 'symbol-not-addressable', 'PATCH_TARGET_NOT_FOUND');

    expect(details.position).toBe('mismatched-container');
    expect(details.enclosing).toBe('Kiln');

    if (result.ok) {
      throw new Error('expected a refusal');
    }

    expect(result.error.hint).toContain('Kiln.settle');

    // And the spelling the hint offers is the one that patches.
    expect(expectPatch({ file: 'src/kiln.ts', symbol: 'Kiln.settle', text }).container).toBe(
      'Kiln',
    );
  });

  it('keeps symbol-not-found for a name the file does not declare', () => {
    // The other half of the distinction, unchanged to the byte: this is the
    // answer re-indexing can act on.
    const result = patcher.patch({
      file: 'src/panel.ts',
      symbol: 'ZZZ',
      text: 'export function run(): number {\n  return 1;\n}\n',
    });

    expectRefusal(result, 'symbol-not-found', 'PATCH_TARGET_NOT_FOUND');

    if (result.ok) {
      throw new Error('expected a refusal');
    }

    expect(result.error.message).toBe(
      'The target file declares no such symbol at module scope or on a class it declares.',
    );
    expect(result.error.hint).toBe(
      'Re-index the project: the plan names a symbol this file does not declare.',
    );
  });

  it('keeps symbol-not-found for a property read that only looks like a declaration', () => {
    // `props.onClick` is a member access, not a declaration, so there is
    // nothing in this file to report as unaddressable.
    expectRefusal(
      patcher.patch({
        file: 'src/pill.tsx',
        symbol: 'onClick',
        text:
          'export function Pill(props: { onClick: () => void }): number {\n' +
          '  props.onClick();\n' +
          '\n' +
          '  return 1;\n' +
          '}\n',
      }),
      'symbol-not-found',
      'PATCH_TARGET_NOT_FOUND',
    );
  });

  it('reports positions only from its own vocabulary', () => {
    expect(Object.isFrozen(PATCH_NON_ADDRESSABLE_POSITIONS)).toBe(true);

    const reported = [
      'parameter',
      'binding-element',
      'non-function-declarator',
      'object-literal-member',
      'class-member',
      'class-declaration',
      'type-declaration',
      'namespace',
      'import-binding',
      'mismatched-container',
      'unreachable-scope',
    ];

    // Every position this suite has asserted is in the exported vocabulary, and
    // the one it has not exercised above is the function-expression name.
    expect(
      PATCH_NON_ADDRESSABLE_POSITIONS.filter((position) => !reported.includes(position)),
    ).toEqual(['function-expression-name']);

    expect(
      expectRefusal(
        patcher.patch({
          file: 'src/panel.ts',
          symbol: 'inner',
          text: 'export const settle = function inner(): number {\n  return 1;\n};\n',
        }),
        'symbol-not-addressable',
        'PATCH_TARGET_NOT_FOUND',
      ).position,
    ).toBe('function-expression-name');
  });
});

describe('React components and hooks (C1-F13)', () => {
  /**
   * Asserts a target is refused as a React render, and returns the details.
   *
   * The refusal exists because the patched file *works* — hook order is
   * preserved, since the helper invokes the callback synchronously — while the
   * developer's own lint reports every moved hook call as a rules-of-hooks
   * violation. So the assertion is on the reason, the recognised site and the
   * hint that sends the planner to the runtime route AAP §0.5.1 designates for
   * renders.
   *
   * @param request The target to patch.
   * @param site The `details.site` the refusal must carry.
   * @returns The refusal's `details`.
   */
  function expectReactRefusal(
    request: FunctionTimingRequest,
    site: string,
  ): Readonly<Record<string, unknown>> {
    const result = patcher.patch(request);
    const details = expectRefusal(result, 'unsupported-react-component');

    expect(details.site).toBe(site);

    if (result.ok) {
      throw new Error('expected a refusal');
    }

    // The next step must be an action the planner can actually emit, and one
    // that touches no file.
    expect(result.error.hint).toContain('react-render-tracking');

    return details;
  }

  it('refuses a JSX-returning function declaration', () => {
    const details = expectReactRefusal(
      {
        file: 'src/components/Notice.tsx',
        symbol: 'Notice',
        text:
          'export function Notice(props: { label: string }) {\n' +
          '  return <p>{props.label}</p>;\n' +
          '}\n',
      },
      'jsx-return',
    );

    expect(details.hook).toBeUndefined();
    expect(details.line).toBe(2);
  });

  it('refuses a self-closing element, a fragment and a conditional JSX return', () => {
    for (const returned of ['<Row />', '<>{props.label}</>', 'props.label ? <Row /> : null']) {
      expectReactRefusal(
        {
          file: 'src/components/Notice.tsx',
          symbol: 'Notice',
          text:
            'export function Notice(props: { label: string }) {\n' +
            `  return ${returned};\n` +
            '}\n',
        },
        'jsx-return',
      );
    }
  });

  it('refuses an arrow whose expression body is JSX', () => {
    // A concise-bodied component has no `return` statement for a
    // statement-wise scan to find, so the body itself is the return.
    expectReactRefusal(
      {
        file: 'src/components/Notice.tsx',
        symbol: 'Notice',
        text: 'export const Notice = (props: { label: string }) => <p>{props.label}</p>;\n',
      },
      'jsx-return',
    );
  });

  it('refuses a declaration that calls a React hook in its own scope', () => {
    const details = expectReactRefusal(
      {
        file: 'src/components/Field.tsx',
        symbol: 'Field',
        text:
          "import { useState } from 'react';\n" +
          '\n' +
          'export function Field(seed: string) {\n' +
          '  const [value, setValue] = useState(seed);\n' +
          '\n' +
          '  return value.length + Number(setValue !== undefined);\n' +
          '}\n',
      },
      'hook-call',
    );

    expect(details.hook).toBe('useState');
  });

  it('refuses a hook called through a property access', () => {
    expect(
      expectReactRefusal(
        {
          file: 'src/components/Field.tsx',
          symbol: 'Field',
          text:
            "import * as React from 'react';\n" +
            '\n' +
            'export function Field(seed: number) {\n' +
            '  React.useEffect(() => undefined, [seed]);\n' +
            '\n' +
            '  return seed;\n' +
            '}\n',
        },
        'hook-call',
      ).hook,
    ).toBe('useEffect');
  });

  it('refuses a nested custom hook that calls a hook', () => {
    // Nested resolution makes this target addressable, and the shape guard is
    // what then declines it: a custom hook is as much a rules-of-hooks subject
    // as a component.
    const details = expectReactRefusal(
      {
        file: 'src/components/Panel.tsx',
        symbol: 'useRows',
        text:
          "import { useMemo } from 'react';\n" +
          '\n' +
          'export function Panel(seed: number) {\n' +
          '  function useRows(): number {\n' +
          '    return useMemo(() => seed + 1, [seed]);\n' +
          '  }\n' +
          '\n' +
          '  return useRows();\n' +
          '}\n',
      },
      'hook-call',
    );

    expect(details.hook).toBe('useMemo');
    expect(details.shape).toBe('function-declaration');
  });

  it('patches a function whose callback returns JSX', () => {
    // The shape a whole-subtree scan would get wrong: the JSX belongs to the
    // nested arrow, which has its own scope, and this function is an ordinary
    // one that happens to build elements.
    const patch = expectPatch({
      file: 'src/components/rows.tsx',
      symbol: 'buildRows',
      text:
        'export function buildRows(items: readonly string[]) {\n' +
        '  return items.map((item) => <li key={item}>{item}</li>);\n' +
        '}\n',
    });

    expect(patch.shape).toBe('function-declaration');
  });

  it('patches a function that calls a hook only inside a nested callback', () => {
    expectPatch({
      file: 'src/components/register.tsx',
      symbol: 'register',
      text:
        "import { useState } from 'react';\n" +
        '\n' +
        'export function register(handlers: (() => unknown)[]): number {\n' +
        '  handlers.push(() => useState(1));\n' +
        '\n' +
        '  return handlers.length;\n' +
        '}\n',
    });
  });

  it('patches a PascalCase function that returns no JSX and calls no hook', () => {
    // There is no name list and no naming rule: the guard reads what the
    // declaration does, so a PascalCase helper stays patchable.
    const patch = expectPatch({
      file: 'src/components/Notice.tsx',
      symbol: 'Notice',
      text: 'export function Notice(label: string): number {\n  return label.length;\n}\n',
    });

    expect(patch.shape).toBe('function-declaration');
  });

  it('patches a use-prefixed function that calls no hook and returns no JSX', () => {
    // The other half of the same point, from the hook side.
    expectPatch({
      file: 'src/hooks/useLabel.ts',
      symbol: 'useLabel',
      text: 'export function useLabel(value: string): string {\n  return value.trim();\n}\n',
    });
  });

  it('patches a function whose call is not hook-shaped', () => {
    // `user(…)`, `used(…)` and a bare `use(…)` are not hooks, and refusing
    // them would decline ordinary functions for the shape of a prefix.
    for (const call of ['user(1)', 'used(1)', 'use(1)']) {
      expectPatch({
        file: 'src/components/Field.ts',
        symbol: 'field',
        text:
          'declare function user(a: number): number;\n' +
          'declare function used(a: number): number;\n' +
          'declare function use(a: number): number;\n' +
          '\n' +
          'export function field(): number {\n' +
          `  return ${call};\n` +
          '}\n',
      });
    }
  });

  it('recognises sites only within its own vocabulary', () => {
    expect(Object.isFrozen(PATCH_REACT_SITES)).toBe(true);
    expect([...PATCH_REACT_SITES]).toEqual(['jsx-return', 'hook-call']);
  });
});
