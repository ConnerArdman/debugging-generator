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
 * The second half of the file is organised the other way round: around the case
 * list AAP §0.5.1 states by name — function declarations, exported route
 * handlers, arrow functions, class methods, async functions, throwing
 * functions, `this`-dependent methods, and single invocation of the body with
 * and without the helper present — each read out of the committed fixture
 * corpus under `test/fixtures/project-a` and, wherever a guarantee is about
 * behaviour rather than text, **executed**.
 *
 * Three conventions are deliberate.
 *
 * - **A source is inline text where the case is about a construct, and a
 *   fixture where the case is about an ordinary project.** The first half needs
 *   sloppy-mode `.js` scripts, static and generic class members and nested
 *   declarations — shapes that exist to be refused or annotated, and that a
 *   realistic corpus has no reason to contain — so those sources are written
 *   inline. The mandated case list of the second half is about patching a
 *   stranger's project, so it reads the fixture corpus (`fixture-kiln-studio`),
 *   which is an independent corpus in the sense AAP §0.5.4 requires and shares
 *   no vocabulary with the demo application. `FunctionTimingPatcher` performs no
 *   I/O, so a fixture is read as *text* and the committed bytes are asserted
 *   unchanged at the end of the run; the one case that genuinely needs a project
 *   on disk works in a `mkdtemp` copy.
 * - **A refusal is asserted by its `code`, its `details.reason` and the
 *   presence of a `hint`**, never by its prose: rewording a message must not
 *   fail a test, while losing the machine-readable reason or the developer's
 *   next step must.
 * - **Every successful patch goes through {@link expectPatch}**, which asserts
 *   the properties that hold for *all* of them — the original text returned
 *   unchanged, byte-identical output across two calls, the AAP-verbatim inner
 *   call, the marker literals the residual-instrumentation gate greps for, and
 *   an independent re-parse of the emitted text — so no individual case has to
 *   restate them and none can quietly skip them.
 */

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, runInNewContext } from 'node:vm';

import { Node, Project, ScriptKind, SyntaxKind, ts } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RESOLUTION_CONFIDENCE,
  isSafeRelativePath,
  newActionId,
  parseSourceLocation,
} from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { sha256Hex } from '@debuggen/shared/node';

import type { InstrumentationAction } from '../schema/plan.js';

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
  HELPER_LOCAL_IDENTIFIER,
  HELPER_TYPE_ALIAS_TEXT,
  INNER_FUNCTION_IDENTIFIER,
  INSTRUMENTATION_MARKERS,
  PATCH_META_KEYS,
  REST_PARAMETER_IDENTIFIER,
  SPAN_HELPER_GLOBAL,
  SPAN_HELPER_TYPE_NAME,
  STRICT_MODE_DIRECTIVE,
  detectArgumentsHazard,
  isStrictModeDirective,
  needsHelperTypeAlias,
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
 * The project every emitted text in this file is re-parsed in, independently of
 * the transform's own pre-flight.
 *
 * `FunctionTimingPatcher` re-parses its own output by default and refuses a
 * text that does not parse, so this is a check of the *checker* as much as of
 * the emitted bytes: a regression that disabled the internal pre-flight, or a
 * script kind resolved from the wrong extension, would leave the module happily
 * returning a text no compiler can read. It is the cheapest guard in this file
 * against an emitted-syntax mistake, which is why it runs for every patch
 * rather than in a case of its own.
 *
 * `allowJs` with `jsx: Preserve` so a `.js`, `.jsx` or `.tsx` fixture parses
 * under the same project as a `.ts` one; `skipLoadingLibFiles` and `noResolve`
 * because only *syntactic* diagnostics are read and neither a library
 * declaration nor an import target can change them.
 */
const reparseProject = new Project({
  useInMemoryFileSystem: true,
  skipLoadingLibFiles: true,
  compilerOptions: {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    noResolve: true,
    target: ts.ScriptTarget.ES2023,
  },
});

/**
 * The script kind a path's extension implies, spelled the way
 * `./function-timing.ts` spells it.
 *
 * `.jsx` for every JavaScript extension rather than `.js`: a `.js` file in an
 * ordinary React project legitimately holds JSX, and TypeScript's `JSX` script
 * kind parses a file without it identically.
 *
 * @param file The project-relative path.
 * @returns The script kind to parse it with.
 */
function scriptKindOf(file: string): ScriptKind {
  if (file.endsWith('.tsx')) {
    return ScriptKind.TSX;
  }

  if (
    file.endsWith('.js') ||
    file.endsWith('.jsx') ||
    file.endsWith('.mjs') ||
    file.endsWith('.cjs')
  ) {
    return ScriptKind.JSX;
  }

  return ScriptKind.TS;
}

/**
 * Parses a text in {@link reparseProject}, reads something off it, and removes
 * it again.
 *
 * The removal is in a `finally` so that one case's parse can never be read by
 * the next: the project is shared for speed, and a leaked source file would
 * make an assertion depend on execution order.
 *
 * @param text The text to parse.
 * @param file The project-relative path, whose extension decides the script
 * kind.
 * @param read What to read off the parsed file.
 * @returns Whatever `read` returned.
 */
function withParsed<T>(text: string, file: string, read: (sourceFile: SourceFile) => T): T {
  const parsed = reparseProject.createSourceFile(`/reparse/${file}`, text, {
    overwrite: true,
    scriptKind: scriptKindOf(file),
  });

  try {
    return read(parsed);
  } finally {
    reparseProject.removeSourceFile(parsed);
  }
}

/**
 * Asserts a text parses with no syntactic diagnostic at all.
 *
 * The diagnostics are reduced to `'<code>: <message>'` strings and compared
 * against an empty array, so a failure names what the parser objected to
 * instead of reporting that a number was not zero.
 *
 * @param text The emitted text.
 * @param file The project-relative path it would be written to.
 */
function expectParses(text: string, file: string): void {
  const messages = withParsed(text, file, (sourceFile) =>
    reparseProject
      .getProgram()
      .getSyntacticDiagnostics(sourceFile)
      .map((diagnostic) => {
        const messageText = diagnostic.getMessageText();

        return `${String(diagnostic.getCode())}: ${
          typeof messageText === 'string' ? messageText : messageText.getMessageText()
        }`;
      }),
  );

  expect(messages, `the emitted ${file} did not parse`).toEqual([]);
}

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
 * - The emitted text re-parses with zero syntactic diagnostics, under the script
 *   kind its extension implies. See {@link expectParses}.
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

  expectParses(patch.patchedText, patch.file);

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

/*
 * ---------------------------------------------------------------------------
 * The fixture corpus: harness
 * ---------------------------------------------------------------------------
 */

/**
 * The committed fixture project every case below reads.
 *
 * Resolved from `import.meta.url` rather than `process.cwd()`: this package's
 * Vitest project runs from the repository root, and a relative path would
 * resolve there instead of beside this file.
 *
 * The corpus is `fixture-kiln-studio`, a kiln-firing studio application that
 * exists to be patched, refused and restored. It is deliberately not the demo
 * application: AAP §0.5.4 requires the product to be provably free of demo
 * knowledge, so the suite that proves the patcher works on a stranger's project
 * uses a corpus that shares no vocabulary with the one the end-to-end run uses.
 */
const FIXTURE_PROJECT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
  'project-a',
);

/**
 * A digest of every byte of the committed fixture tree.
 *
 * Walked in a stable order, hashing each file's path beside its own digest, so
 * a changed byte, an added file and a removed file are all visible in one
 * value. Captured at module load — before any case has run — and asserted again
 * by the last case in this file.
 *
 * The transform performs no I/O, so nothing here *should* be able to touch the
 * corpus; the one case that copies it into a `mkdtemp` directory and opens a
 * real ts-morph project over the copy is exactly the case that could, and
 * `git status --porcelain packages/instrumentation` has to be empty after this
 * suite.
 *
 * @returns One digest covering the whole tree.
 */
function digestOfFixtureTree(): string {
  const lines: string[] = [];

  const walk = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );

    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(absolute, relative);
        continue;
      }

      lines.push(`${relative} ${sha256Hex(readFileSync(absolute))}`);
    }
  };

  walk(FIXTURE_PROJECT, '');

  return sha256Hex(lines.join('\n'));
}

/** The digest of the committed corpus, taken before any case has run. */
const FIXTURE_TREE_DIGEST = digestOfFixtureTree();

/**
 * Reads one fixture file as text.
 *
 * Read, never imported: the package's `tsconfig.json` excludes
 * `test/fixtures/**` from its program on purpose — the corpus holds `.js` and
 * `.jsx` modules this project does not compile and constructs the patcher must
 * refuse — so an `import` of a fixture module would be a type error and would
 * drag deliberately unidiomatic code into the typecheck gate.
 *
 * @param file The fixture-relative POSIX path.
 * @returns The file's current text.
 */
function readFixture(file: string): string {
  return readFileSync(join(FIXTURE_PROJECT, file), 'utf8');
}

/**
 * Patches one fixture symbol through {@link expectPatch}.
 *
 * Every success case in the second half of this file goes through here, so each
 * one inherits the properties that hold for all of them — the original text
 * returned unchanged, determinism across two calls, the AAP-verbatim inner
 * call, the marker literals and the independent re-parse — and stays a few
 * lines of its own.
 *
 * @param file The fixture-relative path.
 * @param symbol The symbol to wrap.
 * @param text The text to patch, defaulting to the fixture's committed bytes.
 * An earlier patch's output is passed here by the cases that patch a second
 * symbol in an already-patched file.
 * @returns The patch.
 */
function patchFixture(
  file: string,
  symbol: string,
  text: string = readFixture(file),
): FunctionTimingPatch {
  return expectPatch({ file, symbol, text });
}

/**
 * The 1-based line and column of a declared name, computed from the
 * **pre-patch** text.
 *
 * This is the whole point of the position assertions: the wrapper shifts every
 * line below it, so a position read out of the patched text would agree with a
 * transform that recorded the position *after* rewriting — which is the one
 * mistake in this module that fails nothing and simply sends the developer to
 * the wrong line (AAP §0.4.2). The anchor is asserted to occur exactly once, so
 * a fixture edit that duplicated a declaration makes the case fail loudly
 * rather than measure the wrong occurrence.
 *
 * @param text The pre-patch text.
 * @param anchor A unique substring of the declaration that contains its name.
 * @param symbol The declared name inside `anchor`.
 * @returns The name identifier's 1-based line and column.
 */
function positionOfDeclaredName(
  text: string,
  anchor: string,
  symbol: string,
): { readonly line: number; readonly column: number } {
  const anchorIndex = text.indexOf(anchor);

  expect(anchorIndex, `the fixture no longer contains ${JSON.stringify(anchor)}`).toBeGreaterThan(
    -1,
  );
  expect(
    text.indexOf(anchor, anchorIndex + 1),
    `${JSON.stringify(anchor)} occurs more than once in the fixture`,
  ).toBe(-1);

  const withinAnchor = anchor.indexOf(symbol);

  expect(withinAnchor, `${JSON.stringify(anchor)} does not contain ${symbol}`).toBeGreaterThan(-1);

  const nameOffset = anchorIndex + withinAnchor;
  const before = text.slice(0, nameOffset);

  return { line: before.split('\n').length, column: nameOffset - before.lastIndexOf('\n') };
}

/** The 1-based line an absolute character offset falls on. */
function lineOfOffset(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

/**
 * Replays a patch's edits against the original text.
 *
 * Reproducing `patchedText` byte-for-byte from `originalText` plus the reported
 * edits is what makes "everything outside the patched node is untouched" a
 * checkable statement: every byte the replay copies is a byte the patch did not
 * write. The edits are sorted defensively, and an overlap would corrupt the
 * replay rather than pass it, so the case that calls this also asserts they do
 * not overlap.
 *
 * @param patch The patch to replay.
 * @returns The text the edits produce.
 */
function replayEdits(patch: FunctionTimingPatch): string {
  const ordered = [...patch.edits].sort((left, right) => left.start - right.start);

  let replayed = '';
  let cursor = 0;

  for (const edit of ordered) {
    replayed += patch.originalText.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }

  return replayed + patch.originalText.slice(cursor);
}

/**
 * The lines of a patched text that carry the inserted helper type alias.
 *
 * Compared against `HELPER_TYPE_ALIAS_TEXT` rather than a literal, so the
 * template and this suite cannot drift apart while both look correct.
 *
 * @param patchedText The emitted text.
 * @returns The matching lines, in file order, trimmed.
 */
function aliasLinesOf(patchedText: string): string[] {
  return patchedText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === HELPER_TYPE_ALIAS_TEXT);
}

/**
 * The keys of the `meta` object literal the wrapper actually emits, read off
 * the parsed output.
 *
 * Read from the abstract syntax tree rather than matched with an expression:
 * the keys are a contract with the runtime — the page agent's span helper
 * builds a `'patch'`-resolved source location by reading `file`, `line` and
 * `column`, and takes `symbol` as the label — and a misspelled key throws
 * nowhere and logs nothing.
 *
 * @param patch The patch whose emitted text to read.
 * @returns The property names of the second argument of the single
 * `__dbg.span(…)` call, in emission order.
 */
function emittedMetaKeys(patch: FunctionTimingPatch): string[] {
  return withParsed(patch.patchedText, patch.file, (sourceFile) => {
    const calls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText() === `${patch.helperIdentifier}.span`);

    expect(calls.length, 'the wrapper emits exactly one span call').toBe(1);

    const literal = calls[0]?.getArguments()[1];

    if (literal === undefined || !Node.isObjectLiteralExpression(literal)) {
      throw new Error('the span call does not carry an object literal as its meta argument');
    }

    return literal.getProperties().map((property) => {
      if (!Node.isPropertyAssignment(property)) {
        throw new Error(
          `the meta literal carries a non-assignment property: ${property.getText()}`,
        );
      }

      return property.getName();
    });
  });
}

/*
 * ---------------------------------------------------------------------------
 * The fixture corpus: executing a patched module
 * ---------------------------------------------------------------------------
 */

/** A module's exports, as an evaluated fixture hands them back. */
type EvaluatedModule = Record<string, unknown>;

/** A callable an evaluated module exported. */
type EvaluatedFunction = (this: unknown, ...args: readonly unknown[]) => unknown;

/** A constructor an evaluated module exported. */
type EvaluatedClass = new (...args: readonly unknown[]) => EvaluatedModule;

/** What an evaluated fixture module is given to run against. */
interface ModuleWorld {
  /**
   * Values installed as globals of the fresh context.
   *
   * Two distinct uses, and both matter. A fresh V8 context has its own
   * intrinsics, so `error instanceof RangeError` measured from *this* realm is
   * `false` for an error the fixture threw unless the host `RangeError` is
   * installed here — an assertion about an error's type has to install the
   * constructor it asserts against. And because a global installed here shadows
   * the context's own binding of that name, installing a counting `Number` is
   * how a body with no injectable dependency still yields a body-execution
   * count.
   */
  readonly globals?: EvaluatedModule;

  /**
   * The modules the fixture imports, keyed by the specifier it imports them
   * under.
   *
   * A fixture that reaches a database handle or a sibling module is given a
   * counting stand-in, which is what turns "the body ran exactly once" into a
   * number. An unexpected specifier throws rather than answering an empty
   * object, so a fixture that grows an import fails the case that has not been
   * told about it.
   */
  readonly deps?: Record<string, EvaluatedModule>;
}

/**
 * Compiles a fixture's text the way the developer's own toolchain would.
 *
 * The patched text is real project source, so running it means compiling it:
 * the fixture corpus is TypeScript and ES modules, and the target project's dev
 * server compiles exactly this text before any of it executes. Compiling to
 * CommonJS is what lets a single `vm` context evaluate it with an injectable
 * `require`, and it erases precisely what a TypeScript build erases — the
 * emitted `as never` assertion and the inserted type alias — leaving the
 * wrapper's *runtime* behaviour to be measured.
 *
 * @param text The original or patched source.
 * @param file The project-relative path, which decides how JSX and TypeScript
 * syntax are read.
 * @returns Executable CommonJS.
 */
function compileForExecution(text: string, file: string): string {
  return ts.transpileModule(text, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
}

/**
 * Evaluates a fixture module in a fresh context and hands back its exports.
 *
 * A real evaluation rather than a stub of the emitted shape: the wrapper reads
 * `globalThis.__DEBUGGEN__` and calls the inner function through `apply`, so
 * the only way to know that a patch changed nothing is to run both texts and
 * compare what they answer. A *fresh* context per call is what keeps one case's
 * helper, counter and intrinsics out of the next one's.
 *
 * Nothing here touches this process's own `globalThis`: the context's global is
 * the object built below, which is what the `afterEach` guard at the end of the
 * harness asserts.
 *
 * @param text The original or patched source.
 * @param file The project-relative path.
 * @param world The globals and module stand-ins to evaluate it against.
 * @returns The module's exports.
 */
function evaluateModule(text: string, file: string, world: ModuleWorld = {}): EvaluatedModule {
  const moduleExports: EvaluatedModule = {};
  const deps = world.deps ?? {};
  const context = createContext({
    exports: moduleExports,
    module: { exports: moduleExports },
    require: (specifier: string): EvaluatedModule => {
      const dependency = deps[specifier];

      if (dependency === undefined) {
        throw new Error(`${file} imported ${specifier}, which this case did not provide`);
      }

      return dependency;
    },
    ...world.globals,
  });

  runInContext(compileForExecution(text, file), context, { filename: `/evaluated/${file}` });

  return moduleExports;
}

/**
 * Reads an exported function off an evaluated module.
 *
 * @param module The evaluated module.
 * @param name The export to read.
 * @returns The exported function.
 */
function exportedFunction(module: EvaluatedModule, name: string): EvaluatedFunction {
  const exported = module[name];

  if (typeof exported !== 'function') {
    throw new Error(`the evaluated module exports no callable ${name}`);
  }

  return exported as EvaluatedFunction;
}

/**
 * Reads an exported class off an evaluated module.
 *
 * @param module The evaluated module.
 * @param name The export to read.
 * @returns The exported constructor.
 */
function exportedClass(module: EvaluatedModule, name: string): EvaluatedClass {
  const exported = module[name];

  if (typeof exported !== 'function') {
    throw new Error(`the evaluated module exports no constructor ${name}`);
  }

  return exported as EvaluatedClass;
}

/**
 * Calls a method **on its instance**, preserving the receiver.
 *
 * Written as one helper because losing the receiver is the exact bug the
 * `this`-dependent cases exist to catch: a method read off an instance and
 * called bare would fail those cases for the test's reason rather than the
 * transform's.
 *
 * @param instance The evaluated instance.
 * @param name The method to call.
 * @param args The call's arguments.
 * @returns Whatever the method returned.
 */
function callMethod(instance: EvaluatedModule, name: string, ...args: readonly unknown[]): unknown {
  const method = instance[name];

  if (typeof method !== 'function') {
    throw new Error(`the evaluated instance carries no callable ${name}`);
  }

  return Reflect.apply(method as EvaluatedFunction, instance, args);
}

/** One `span(name, meta, fn)` call a fake helper recorded. */
interface RecordedSpan {
  /** The span name the wrapper passed. */
  readonly name: unknown;

  /** The `meta` literal the wrapper passed. */
  readonly meta: unknown;
}

/** One state `globalThis.__DEBUGGEN__` can be in when a patched body runs. */
interface HelperState {
  /** What the case reports when it fails. */
  readonly label: string;

  /**
   * The value to install as the global, or `undefined` to install nothing at
   * all — which is not the same as installing `undefined`, since the wrapper's
   * guard reads the property either way but a declared global would change
   * what a `typeof` check in the developer's own code sees.
   */
  readonly helper: EvaluatedModule | undefined;

  /** The spans this state's helper recorded, in call order. */
  readonly spans: RecordedSpan[];

  /**
   * Whether this state's helper is one the wrapper can call at all.
   *
   * `false` for the absent helper and for the two malformed ones, whose
   * `span` is not a function — those take the fallback path, so nothing is
   * recorded and a recorded span would mean the guard admitted a helper it
   * cannot call.
   */
  readonly records: boolean;

  /**
   * What the patched function answers.
   *
   * `'body'` for a state whose helper passes the callback's value through, and
   * for every state that takes the fallback path. `'null'` and `'undefined'`
   * for the two states whose helper *returns* a falsy value: a correct wrapper
   * returns what the helper returned, which is precisely how a wrapper that
   * branched on the helper's **result** rather than its availability is caught
   * — that one would answer the body's value instead, and would have run the
   * body twice to get it.
   */
  readonly answers: 'body' | 'null' | 'undefined';
}

/**
 * The five states AAP §0.5.1's "with and without the helper present" covers,
 * plus the sixth that spells the malformed helper a second way.
 *
 * Each has caught a real class of template bug: no helper at all (the fallback
 * path), a working helper (the instrumented path), a helper that answers `null`
 * and one that answers `undefined` (a guard that tested the *result*), and a
 * helper whose `span` is not callable, either declared-but-not-a-function or
 * absent (a guard that tested only the helper object).
 *
 * Built fresh on every call, so the recorded spans of one case can never be
 * read by another.
 *
 * @returns The states, each with its own recording array.
 */
function helperStates(): readonly HelperState[] {
  const passthrough: RecordedSpan[] = [];
  const nullReturning: RecordedSpan[] = [];
  const undefinedReturning: RecordedSpan[] = [];

  return [
    { label: 'no helper at all', helper: undefined, spans: [], records: false, answers: 'body' },
    {
      label: 'a helper whose span returns fn()',
      helper: {
        span: (name: unknown, meta: unknown, fn: () => unknown): unknown => {
          passthrough.push({ name, meta });

          return fn();
        },
      },
      spans: passthrough,
      records: true,
      answers: 'body',
    },
    {
      label: 'a helper whose span returns null',
      helper: {
        span: (name: unknown, meta: unknown, fn: () => unknown): unknown => {
          nullReturning.push({ name, meta });
          fn();

          return null;
        },
      },
      spans: nullReturning,
      records: true,
      answers: 'null',
    },
    {
      label: 'a helper whose span returns undefined',
      helper: {
        span: (name: unknown, meta: unknown, fn: () => unknown): unknown => {
          undefinedReturning.push({ name, meta });
          fn();

          return undefined;
        },
      },
      spans: undefinedReturning,
      records: true,
      answers: 'undefined',
    },
    {
      label: 'a helper whose span is not a function',
      helper: { span: 42 },
      spans: [],
      records: false,
      answers: 'body',
    },
    {
      label: 'a helper with no span at all',
      helper: {},
      spans: [],
      records: false,
      answers: 'body',
    },
  ];
}

/**
 * The globals a helper state contributes to an evaluated module.
 *
 * @param state The state to install.
 * @returns Globals carrying the helper, or none for the absent state.
 */
function globalsFor(state: HelperState): EvaluatedModule {
  return state.helper === undefined ? {} : { [SPAN_HELPER_GLOBAL]: state.helper };
}

/**
 * Asserts a patched function's answer against what its helper state implies.
 *
 * @param answer What the patched function returned.
 * @param state The helper state it ran under.
 * @param bodyAnswer What the body itself computes.
 */
function expectAnswer(answer: unknown, state: HelperState, bodyAnswer: unknown): void {
  if (state.answers === 'null') {
    expect(answer, state.label).toBeNull();

    return;
  }

  if (state.answers === 'undefined') {
    expect(answer, state.label).toBeUndefined();

    return;
  }

  // `toEqual` rather than `toStrictEqual`: an object the fixture built inside a
  // `vm` context has that context's `Object.prototype`, so a strict comparison
  // would report a realm boundary as a difference in the value.
  expect(answer, state.label).toEqual(bodyAnswer);
}

afterEach(() => {
  // Every evaluation in this file runs in its own `vm` context, so a fake
  // helper must never reach this process's own global. Asserting it — and
  // deleting it if it ever appears — keeps one leaked assignment from silently
  // instrumenting the rest of the run.
  const host = globalThis as Record<string, unknown>;
  const leaked = SPAN_HELPER_GLOBAL in host;

  delete host[SPAN_HELPER_GLOBAL];

  expect(leaked, 'a fake span helper leaked onto the host global').toBe(false);
});

/*
 * ---------------------------------------------------------------------------
 * The four declaration shapes
 * ---------------------------------------------------------------------------
 */

describe('function declarations', () => {
  const file = 'src/server/cycle-planner.ts';

  it('keeps a destructured parameter list, with its defaults, on the outer function', () => {
    const patch = patchFixture(file, 'planCycleSegments');

    expect(patch.shape).toBe('function-declaration');
    expect(patch.callStyle).toBe('arguments');
    // The head is reproduced verbatim, which is what preserves the pattern, the
    // two defaults, the parameter's type annotation and the return type. A
    // transform that rebuilt the head instead of keeping it would be free to
    // drop a default and nothing in the emitted text would look wrong.
    expect(patch.patchedText).toContain(
      'export function planCycleSegments({\n  kilnId,\n  targetConeValue = 6,\n  segments = [],\n}: PlanCycleSegmentsInput): CyclePlan {',
    );
    // The parameter list moved nowhere: the inner function takes none and reads
    // the bindings the outer one destructured.
    expect(innerDeclarationOf(patch)).toBe(`function ${INNER_FUNCTION_IDENTIFIER}() {`);
    expect(patch.patchedText).not.toContain('targetConeValue = 6,\n}: PlanCycleSegmentsInput');
  });

  it('answers identically, with the same arity, for a destructured parameter', () => {
    const patch = patchFixture(file, 'planCycleSegments');
    const coneRules = { assertConeValue: (value: unknown): unknown => value };
    const before = evaluateModule(patch.originalText, file, {
      deps: { './cone-rules': coneRules },
    });
    const after = evaluateModule(patch.patchedText, file, { deps: { './cone-rules': coneRules } });
    const original = exportedFunction(before, 'planCycleSegments');
    const patched = exportedFunction(after, 'planCycleSegments');

    // One declared parameter before and after: the wrapper keeps the original
    // head, so `Function.prototype.length` cannot change.
    expect(patched.length).toBe(original.length);
    expect(patched.length).toBe(1);

    for (const input of [
      { kilnId: 'kiln-north-02' },
      { kilnId: 'kiln-north-02', targetConeValue: 10 },
      {
        kilnId: 'kiln-south-01',
        segments: [
          { label: 'candle', targetTemperatureC: 120, rampRateCPerHour: 40, holdMinutes: 60 },
          { label: 'climb to peak', targetTemperatureC: 1222, rampRateCPerHour: 108 },
        ],
      },
    ]) {
      expect(patched(input)).toEqual(original(input));
    }

    // The default survives where the studio names no cone.
    expect(patched({ kilnId: 'kiln-north-02' })).toMatchObject({ coneValue: 6, segmentCount: 0 });
  });

  it('answers identically for a plain positional parameter list', () => {
    const patch = patchFixture(file, 'estimateSoakMinutes');

    expect(patch.shape).toBe('function-declaration');
    expect(patch.patchedText).toContain(
      'export function estimateSoakMinutes(targetConeValue: number, wallThicknessMm: number): number {',
    );

    const before = evaluateModule(patch.originalText, file, {
      deps: { './cone-rules': { assertConeValue: (value: unknown): unknown => value } },
    });
    const after = evaluateModule(patch.patchedText, file, {
      deps: { './cone-rules': { assertConeValue: (value: unknown): unknown => value } },
    });
    const original = exportedFunction(before, 'estimateSoakMinutes');
    const patched = exportedFunction(after, 'estimateSoakMinutes');

    expect(patched.length).toBe(2);
    expect(patched.length).toBe(original.length);

    for (const args of [
      [6, 12],
      [10, 0],
      [-4, 30],
      [Number.NaN, 12],
      [6, Number.POSITIVE_INFINITY],
      [6],
    ]) {
      expect(patched(...args)).toBe(original(...args));
    }
  });
});

describe('an exported route handler', () => {
  const file = 'app/api/firings/route.ts';

  it('keeps the export modifier, the binding name and the return type annotation', () => {
    const patch = patchFixture(file, 'POST');

    // Recognised structurally — an exported function declaration in the module
    // the plan named — and not by matching a route path (AAP §0.5.4).
    expect(patch.shape).toBe('function-declaration');
    expect(patch.patchedText).toContain(
      'export async function POST(request: Request): Promise<Response> {',
    );
    expect(patch.spanName).toBe('POST');
    expect(patch.symbol).toBe('POST');
    // The framework resolves the handler by its exported name, so the export
    // must survive as exactly one declaration of exactly that name.
    expect(patch.patchedText.split('export async function POST(').length - 1).toBe(1);
    // `async` is on the inner function too, because the moved body awaits.
    expect(innerDeclarationOf(patch)).toBe(`async function ${INNER_FUNCTION_IDENTIFIER}() {`);
  });

  it('answers the same responses as the unpatched handler', async () => {
    const patch = patchFixture(file, 'POST');
    const firingLog = {
      logFiringCycle: (draft: unknown): Promise<unknown> =>
        Promise.resolve({ entry: draft, recent: [] }),
    };
    const module = evaluateModule(patch.patchedText, file, {
      globals: { Response, JSON },
      deps: { '@/server/firing-log': firingLog },
    });
    const handler = exportedFunction(module, 'POST');

    const accepted = await handler({
      json: (): Promise<unknown> => Promise.resolve({ kilnId: 'kiln-north-02', coneValue: 6 }),
    });

    expect(accepted).toBeInstanceOf(Response);
    expect((accepted as Response).status).toBe(201);
    expect(await (accepted as Response).text()).toBe(
      JSON.stringify({ entry: { kilnId: 'kiln-north-02', coneValue: 6 }, recent: [] }),
    );

    const refused = await handler({ json: (): Promise<unknown> => Promise.resolve(null) });

    expect((refused as Response).status).toBe(400);
  });
});

describe('arrow functions', () => {
  it('wraps a TypeScript arrow with the rest-parameter template', () => {
    const patch = patchFixture('src/server/glaze-rules.ts', 'scoreShelfSlot');

    expect(patch.shape).toBe('arrow-function');
    expect(patch.callStyle).toBe('rest');
    expect(patch.restIdentifier).toBe(REST_PARAMETER_IDENTIFIER);
    // An arrow binds no `arguments`, so forwarding through one would be a
    // syntax error inside it: the wrapper must stay an arrow taking a rest
    // parameter, and the emitted text may not mention `arguments` at all.
    expect(patch.patchedText).toContain(
      `export const scoreShelfSlot = (...${REST_PARAMETER_IDENTIFIER}: unknown[]): number => {`,
    );
    expect(patch.patchedText).not.toContain('arguments');
    // The original head — parameters, their types and the return type — moved
    // to the inner arrow untouched.
    expect(patch.patchedText).toContain(
      `const ${INNER_FUNCTION_IDENTIFIER} = (slot: ShelfSlot, index: number): number => {`,
    );
  });

  it('normalises an expression body to a parenthesised return', () => {
    const patch = patchFixture('src/legacy/rack-tally.js', 'tallyRackSlots');

    expect(patch.shape).toBe('arrow-function');
    // The parentheses are what keep a comma expression, an object literal or
    // automatic semicolon insertion from changing the expression's meaning.
    expect(patch.patchedText).toContain(
      `const ${INNER_FUNCTION_IDENTIFIER} = (racks) => { return (racks.reduce((total, rack) => total + rack.slots, 0)); };`,
    );
  });

  it('normalises a nested-conditional expression body without reordering it', () => {
    const patch = patchFixture('src/legacy/rack-tally.js', 'gradeRackDensity');

    expect(patch.patchedText).toContain(
      `const ${INNER_FUNCTION_IDENTIFIER} = (rack) => { return (rack.slots > PACKED_RACK_SLOTS ? 'packed' : rack.slots > STEADY_RACK_SLOTS ? 'steady' : 'sparse'); };`,
    );

    const file = 'src/legacy/rack-tally.js';
    const original = exportedFunction(evaluateModule(patch.originalText, file), 'gradeRackDensity');
    const patched = exportedFunction(evaluateModule(patch.patchedText, file), 'gradeRackDensity');

    for (const slots of [0, 9, 10, 18, 19, 40]) {
      expect(patched({ rackId: 'A1', slots })).toBe(original({ rackId: 'A1', slots }));
    }
  });

  it('wraps a block-bodied TypeScript arrow, keeping its parameter and return types', () => {
    const file = 'src/server/glaze-rules.ts';
    const patch = patchFixture(file, 'pickGlazeProfile');
    const load = {
      kilnId: 'kiln-south-01',
      slots: [
        { label: 'A1', widthMm: 420, heightMm: 260, bisque: true },
        { label: 'B2', widthMm: 180, heightMm: 140, bisque: false },
      ],
    };

    expect(patch.shape).toBe('arrow-function');
    expect(patch.callStyle).toBe('rest');
    expect(patch.patchedText).toContain(
      `export const pickGlazeProfile = (...${REST_PARAMETER_IDENTIFIER}: unknown[]): GlazeProfile => {`,
    );
    expect(patch.patchedText).toContain(
      `const ${INNER_FUNCTION_IDENTIFIER} = (load: ShelfLoad): GlazeProfile => {`,
    );

    const original = exportedFunction(evaluateModule(patch.originalText, file), 'pickGlazeProfile');
    const patched = exportedFunction(evaluateModule(patch.patchedText, file), 'pickGlazeProfile');

    expect(patched(load)).toEqual(original(load));
    // An empty rack still chooses a glaze, and a rack the book cannot carry
    // still lands on the house glaze — the two branches the block body holds.
    expect(patched({ kilnId: 'kiln-south-01', slots: [] })).toEqual(
      original({ kilnId: 'kiln-south-01', slots: [] }),
    );
  });

  it('keeps a block-bodied arrow answering identically', () => {
    const file = 'src/legacy/rack-tally.js';
    const patch = patchFixture(file, 'orderRacksByLoad');
    const racks = [
      { rackId: 'A1', slots: 12 },
      { rackId: 'B2', slots: 3 },
      { rackId: 'C3', slots: 19 },
    ];
    const original = exportedFunction(evaluateModule(patch.originalText, file), 'orderRacksByLoad');
    const patched = exportedFunction(evaluateModule(patch.patchedText, file), 'orderRacksByLoad');

    expect(patched(racks)).toEqual(original(racks));
    // The sheet it was handed is still in loading order afterwards.
    expect(racks.map((rack) => rack.rackId)).toEqual(['A1', 'B2', 'C3']);
  });

  it('still receives (value, index) positionally when it is passed to map by reference', () => {
    // `pickGlazeProfile` passes `scoreShelfSlot` to `Array.prototype.map`, so
    // the patched arrow is called by the runtime with three arguments and must
    // read the first two exactly as before. A wrapper that bound its own
    // parameters, or that was no longer an arrow, would change what the
    // callback sees.
    const file = 'src/server/glaze-rules.ts';
    const patch = patchFixture(file, 'scoreShelfSlot');
    const load = {
      kilnId: 'kiln-north-02',
      slots: [
        { label: 'A1', widthMm: 300, heightMm: 200, bisque: true },
        { label: 'B2', widthMm: 150, heightMm: 120, bisque: false },
        { label: 'C3', widthMm: 420, heightMm: 260, bisque: true },
      ],
    };
    const before = evaluateModule(patch.originalText, file);
    const after = evaluateModule(patch.patchedText, file);

    expect(exportedFunction(after, 'pickGlazeProfile')(load)).toEqual(
      exportedFunction(before, 'pickGlazeProfile')(load),
    );

    const original = exportedFunction(before, 'scoreShelfSlot');
    const patched = exportedFunction(after, 'scoreShelfSlot');

    for (const [index, slot] of load.slots.entries()) {
      expect(patched(slot, index)).toBe(original(slot, index));
    }

    // Called the way `map` calls it, with the array as a third argument.
    expect(patched(load.slots[0], 0, load.slots)).toBe(original(load.slots[0], 0, load.slots));
  });

  it('still orders a sort by reference identically', () => {
    // The other by-reference contract: `orderRacksByLoad` hands
    // `compareRackLoad` to `Array.prototype.sort`, which calls it with two
    // positional arguments and reads the sign of its answer.
    const file = 'src/legacy/rack-tally.js';
    const patch = patchFixture(file, 'compareRackLoad');
    const racks = [
      { rackId: 'A1', slots: 12 },
      { rackId: 'B2', slots: 3 },
      { rackId: 'C3', slots: 19 },
      { rackId: 'D4', slots: 3 },
    ];
    const before = evaluateModule(patch.originalText, file);
    const after = evaluateModule(patch.patchedText, file);

    expect(exportedFunction(after, 'orderRacksByLoad')(racks)).toEqual(
      exportedFunction(before, 'orderRacksByLoad')(racks),
    );

    const patched = exportedFunction(after, 'compareRackLoad');

    expect(patched({ slots: 3 }, { slots: 12 })).toBeLessThan(0);
    expect(patched({ slots: 12 }, { slots: 3 })).toBeGreaterThan(0);
    expect(patched({ slots: 3 }, { slots: 3 })).toBe(0);
  });
});

describe('class methods', () => {
  const file = 'src/server/kiln-controller.ts';

  /** The cycle every case below measures against. */
  const segments = [
    { label: 'bisque ramp', targetTemperatureC: 600, holdMinutes: 10 },
    { label: 'climb to peak', targetTemperatureC: 1222, holdMinutes: 3 },
    { label: 'cone 6 soak', targetTemperatureC: 1222, holdMinutes: 20 },
  ];

  it('wraps a method that never touches this', () => {
    const patch = patchFixture(file, 'normalizeRampRate');

    expect(patch.shape).toBe('method');
    expect(patch.container).toBe('KilnController');
    expect(patch.qualifiedName).toBe('KilnController.normalizeRampRate');
    // The span name stays the bare declared name, which is what the code graph
    // records and what the service matches a span back against.
    expect(patch.spanName).toBe('normalizeRampRate');

    const before = evaluateModule(patch.originalText, file);
    const after = evaluateModule(patch.patchedText, file);
    const original = new (exportedClass(before, 'KilnController'))(segments);
    const patched = new (exportedClass(after, 'KilnController'))(segments);

    for (const rate of [Number.NaN, 0, 9, 10, 108.4, 300, 900]) {
      expect(callMethod(patched, 'normalizeRampRate', rate)).toBe(
        callMethod(original, 'normalizeRampRate', rate),
      );
    }
  });

  it('keeps a this-dependent method reading the instance', () => {
    const patch = patchFixture(file, 'totalSoakMinutes');

    // The receiver is forwarded rather than dropped, and the inner function
    // declares the receiver type so a strict target project still compiles.
    expect(patch.receiver).toBe('this');
    expect(innerDeclarationOf(patch)).toBe(
      `function ${INNER_FUNCTION_IDENTIFIER}(this: KilnController) {`,
    );

    const before = evaluateModule(patch.originalText, file);
    const after = evaluateModule(patch.patchedText, file);
    const original = new (exportedClass(before, 'KilnController'))(segments);
    const patched = new (exportedClass(after, 'KilnController'))(segments);

    // 33 minutes of holding, folded out of `this.segments`. An inner function
    // that lost its receiver would throw here instead of answering.
    expect(callMethod(patched, 'totalSoakMinutes')).toBe(33);
    expect(callMethod(patched, 'totalSoakMinutes')).toBe(callMethod(original, 'totalSoakMinutes'));

    // A second instance, to prove the receiver is the instance rather than
    // anything the wrapper captured when the module was evaluated.
    const other = new (exportedClass(after, 'KilnController'))([
      { label: 'candle', targetTemperatureC: 120, holdMinutes: 60 },
    ]);

    expect(callMethod(other, 'totalSoakMinutes')).toBe(60);
  });

  it('keeps an async this-dependent method reading the instance', async () => {
    const patch = patchFixture(file, 'settleSegments');

    expect(patch.receiver).toBe('this');
    expect(innerDeclarationOf(patch)).toBe(
      `async function ${INNER_FUNCTION_IDENTIFIER}(this: KilnController) {`,
    );

    const before = evaluateModule(patch.originalText, file, { globals: { Promise } });
    const after = evaluateModule(patch.patchedText, file, { globals: { Promise } });
    const original = new (exportedClass(before, 'KilnController'))(segments);
    const patched = new (exportedClass(after, 'KilnController'))(segments);

    const settled = callMethod(patched, 'settleSegments');

    // Thenable rather than `instanceof Promise`: an `async` function builds its
    // promise from the intrinsic of the realm it runs in, and this one runs in
    // its own `vm` context. What matters is that the wrapper handed the
    // promise back rather than awaiting or coercing it.
    expect(typeof (settled as { then?: unknown }).then).toBe('function');
    // Two of the three segments carry a hold the kiln has to sit through.
    expect(await settled).toBe(2);
    expect(await settled).toBe(await callMethod(original, 'settleSegments'));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Single invocation, with and without the helper
 * ---------------------------------------------------------------------------
 */

describe('single invocation of the body, in every helper state', () => {
  it('runs a function declaration body exactly once', () => {
    // The body calls `assertConeValue` out of a sibling module, so a counting
    // stand-in for that module counts body executions directly.
    const file = 'src/server/cycle-planner.ts';
    const patch = patchFixture(file, 'planCycleSegments');

    for (const state of helperStates()) {
      let coneChecks = 0;
      const coneRules = {
        assertConeValue: (value: unknown): unknown => {
          coneChecks += 1;

          return value;
        },
      };
      const module = evaluateModule(patch.patchedText, file, {
        globals: globalsFor(state),
        deps: { './cone-rules': coneRules },
      });
      const answer = exportedFunction(module, 'planCycleSegments')({ kilnId: 'kiln-north-02' });

      expect(coneChecks, state.label).toBe(1);
      expectAnswer(answer, state, {
        kilnId: 'kiln-north-02',
        coneValue: 6,
        segmentCount: 0,
        peakTemperatureC: 0,
        totalHoldMinutes: 0,
        slowestRampCPerHour: 0,
        stepLabels: [],
      });
      // A callable helper saw exactly one span for that one call; the
      // absent and malformed helpers saw none, because the guard sent the
      // wrapper down the fallback path instead of calling them.
      expect(state.spans.length, state.label).toBe(state.records ? 1 : 0);

      if (state.records) {
        expect(state.spans[0], state.label).toEqual({
          name: patch.spanName,
          meta: patch.meta,
        });
      }
    }
  });

  it('runs an exported route handler body exactly once', async () => {
    const file = 'app/api/firings/route.ts';
    const patch = patchFixture(file, 'POST');

    for (const state of helperStates()) {
      let reads = 0;
      let writes = 0;
      const module = evaluateModule(patch.patchedText, file, {
        globals: { ...globalsFor(state), Response, JSON },
        deps: {
          '@/server/firing-log': {
            logFiringCycle: (draft: unknown): Promise<unknown> => {
              writes += 1;

              return Promise.resolve({ entry: draft, recent: [] });
            },
          },
        },
      });
      const answer = await exportedFunction(
        module,
        'POST',
      )({
        json: (): Promise<unknown> => {
          reads += 1;

          return Promise.resolve({ kilnId: 'kiln-north-02' });
        },
      });

      // One body execution means one read of the submitted draft and one write
      // to the log — a body that ran twice would open two entries.
      expect(reads, state.label).toBe(1);
      expect(writes, state.label).toBe(1);

      if (state.answers === 'body') {
        expect((answer as Response).status, state.label).toBe(201);
      } else if (state.answers === 'null') {
        expect(answer, state.label).toBeNull();
      } else {
        expect(answer, state.label).toBeUndefined();
      }
    }
  });

  it('runs an arrow body exactly once', () => {
    // `tallyRackSlots` reduces the argument it is handed, so an argument that
    // counts its own `reduce` counts body executions.
    const file = 'src/legacy/rack-tally.js';
    const patch = patchFixture(file, 'tallyRackSlots');

    for (const state of helperStates()) {
      let reductions = 0;
      const racks = {
        reduce: (
          fold: (total: number, rack: { slots: number }) => number,
          seed: number,
        ): number => {
          reductions += 1;

          return fold(seed, { slots: 7 });
        },
      };
      const module = evaluateModule(patch.patchedText, file, { globals: globalsFor(state) });
      const answer = exportedFunction(module, 'tallyRackSlots')(racks);

      expect(reductions, state.label).toBe(1);
      expectAnswer(answer, state, 7);
    }
  });

  it('runs a class method body exactly once', () => {
    // The method folds `this.segments`, so a segment whose `holdMinutes` is a
    // counting getter counts body executions — and proves the fold still reads
    // the instance.
    const file = 'src/server/kiln-controller.ts';
    const patch = patchFixture(file, 'totalSoakMinutes');

    for (const state of helperStates()) {
      let reads = 0;
      const module = evaluateModule(patch.patchedText, file, { globals: globalsFor(state) });
      const controller = new (exportedClass(module, 'KilnController'))([
        {
          label: 'cone 6 soak',
          targetTemperatureC: 1222,
          get holdMinutes(): number {
            reads += 1;

            return 20;
          },
        },
      ]);
      const answer = callMethod(controller, 'totalSoakMinutes');

      expect(reads, state.label).toBe(1);
      expectAnswer(answer, state, 20);
    }
  });

  it('passes the span name and the recorded meta to the helper, once per call', () => {
    const file = 'src/legacy/rack-tally.js';
    const patch = patchFixture(file, 'gradeRackDensity');
    const spans: RecordedSpan[] = [];
    let bodyRuns = 0;
    const module = evaluateModule(patch.patchedText, file, {
      globals: {
        [SPAN_HELPER_GLOBAL]: {
          span: (name: unknown, meta: unknown, fn: () => unknown): unknown => {
            spans.push({ name, meta });
            bodyRuns += 1;

            return fn();
          },
        },
      },
    });
    const graded = exportedFunction(module, 'gradeRackDensity');

    expect(graded({ rackId: 'A1', slots: 19 })).toBe('packed');
    expect(graded({ rackId: 'B2', slots: 4 })).toBe('sparse');

    // One span per call, each carrying the patch-recorded position rather than
    // anything resolved at run time.
    expect(bodyRuns).toBe(2);
    expect(spans).toEqual([
      { name: patch.spanName, meta: patch.meta },
      { name: patch.spanName, meta: patch.meta },
    ]);
  });
});

describe('functions whose own answer is falsy', () => {
  const file = 'src/server/cone-rules.ts';

  it('answers exactly null for a lookup that misses', () => {
    const patch = patchFixture(file, 'findConeProfile');

    for (const state of helperStates()) {
      const module = evaluateModule(patch.patchedText, file, { globals: globalsFor(state) });
      const found = exportedFunction(module, 'findConeProfile');

      // A cone the studio does not fire. `toBeNull` rather than a truthiness
      // check: a wrapper that answered `undefined` here would pass a falsy
      // assertion while changing the function's contract. The one state that
      // legitimately answers `undefined` is the helper that returns it, whose
      // value the wrapper is supposed to hand back.
      if (state.answers === 'undefined') {
        expect(found(3), state.label).toBeUndefined();
      } else {
        expect(found(3), state.label).toBeNull();
      }

      // And the case this fixture exists for: with a helper that *returns*
      // null, a correct wrapper answers null even for a cone that hits,
      // because it returns what the helper returned. A wrapper that branched
      // on the helper's result instead would answer the profile — having run
      // the body a second time to obtain it.
      if (state.answers === 'null') {
        expect(found(6), state.label).toBeNull();
      } else if (state.answers === 'undefined') {
        expect(found(6), state.label).toBeUndefined();
      } else {
        expect(found(6), state.label).toMatchObject({ coneValue: 6, peakTemperatureC: 1222 });
      }
    }
  });

  it('answers exactly undefined for a ceiling that misses', () => {
    const patch = patchFixture(file, 'findRampCeiling');

    for (const state of helperStates()) {
      const module = evaluateModule(patch.patchedText, file, { globals: globalsFor(state) });
      const ceiling = exportedFunction(module, 'findRampCeiling');

      if (state.answers === 'null') {
        expect(ceiling(3), state.label).toBeNull();
      } else {
        expect(ceiling(3), state.label).toBeUndefined();
      }

      if (state.answers === 'null') {
        expect(ceiling(6), state.label).toBeNull();
      } else if (state.answers === 'undefined') {
        expect(ceiling(6), state.label).toBeUndefined();
      } else {
        expect(ceiling(6), state.label).toBe(108);
      }
    }
  });
});

describe('throwing functions', () => {
  it('propagates a TypeScript function’s error unchanged, running the body once', () => {
    // `Number.isInteger` is reached through a global reference, so installing a
    // counting `Number` in the context counts body executions for a function
    // with no injectable dependency at all.
    const file = 'src/server/cone-rules.ts';
    const patch = patchFixture(file, 'assertConeValue');

    for (const state of helperStates()) {
      let checks = 0;
      const module = evaluateModule(patch.patchedText, file, {
        globals: {
          ...globalsFor(state),
          RangeError,
          Number: {
            isInteger: (value: unknown): boolean => {
              checks += 1;

              return Number.isInteger(value);
            },
          },
        },
      });
      const assertCone = exportedFunction(module, 'assertConeValue');

      let thrown: unknown;

      try {
        assertCone(99);
      } catch (error: unknown) {
        thrown = error;
      }

      // The same error type and the same message, thrown synchronously out of
      // the wrapper rather than wrapped, replaced or swallowed.
      expect(thrown, state.label).toBeInstanceOf(RangeError);
      expect((thrown as Error).message, state.label).toBe(
        'Cone 99 is outside the rated band of -22 to 14.',
      );
      expect(checks, state.label).toBe(1);

      // A cone inside the band still comes back, and the body still ran once.
      const answer = assertCone(6);

      expect(checks, state.label).toBe(2);
      expectAnswer(answer, state, 6);
    }
  });

  it('propagates a JavaScript function’s error unchanged, running the body once', () => {
    const file = 'src/legacy/bisque-schedule.js';
    const patch = patchFixture(file, 'assertBisqueCone');

    for (const state of helperStates()) {
      let checks = 0;
      const module = evaluateModule(patch.patchedText, file, {
        globals: {
          ...globalsFor(state),
          RangeError,
          Number: {
            isInteger: (value: unknown): boolean => {
              checks += 1;

              return Number.isInteger(value);
            },
          },
        },
      });
      const assertCone = exportedFunction(module, 'assertBisqueCone');

      expect(() => assertCone(1.5), state.label).toThrowError(RangeError);
      expect(checks, state.label).toBe(1);

      try {
        assertCone(1.5);
      } catch (error: unknown) {
        expect((error as Error).message, state.label).toBe(
          'Cone 1.5 is outside the band of -22 to 14.',
        );
      }

      expect(checks, state.label).toBe(2);
      expectAnswer(assertCone(-4), state, -4);
    }
  });
});

describe('async and promise-returning functions', () => {
  const firingLogFile = 'src/server/firing-log.ts';

  /** One stored entry, shaped the way the log reads its rows back. */
  const entry = {
    id: 'fc_0001',
    kilnId: 'kiln-north-02',
    coneValue: 6,
    soakMinutes: 20,
    glazeCode: null,
    startedAt: new Date('2026-02-01T09:00:00.000Z'),
  };

  it('resolves an async function to the same value, running the body once', async () => {
    const patch = patchFixture(firingLogFile, 'logFiringCycle');

    for (const state of helperStates()) {
      let creates = 0;
      let reads = 0;
      const module = evaluateModule(patch.patchedText, firingLogFile, {
        globals: { ...globalsFor(state), Date, Promise },
        deps: {
          './db-handles': {
            prisma: {
              firingCycle: {
                create: (): Promise<unknown> => {
                  creates += 1;

                  return Promise.resolve(entry);
                },
                findMany: (): Promise<unknown> => {
                  reads += 1;

                  return Promise.resolve([entry]);
                },
              },
            },
          },
        },
      });
      const answer: unknown = await exportedFunction(
        module,
        'logFiringCycle',
      )({
        kilnId: 'kiln-north-02',
        coneValue: 6,
        soakMinutes: 20,
      });

      // One entry opened and one history read: a body that ran twice would
      // write a second row into the studio's log.
      expect(creates, state.label).toBe(1);
      expect(reads, state.label).toBe(1);

      if (state.answers === 'body') {
        expect(answer, state.label).toEqual({ entry, recent: [entry] });
      } else if (state.answers === 'null') {
        expect(answer, state.label).toBeNull();
      } else {
        expect(answer, state.label).toBeUndefined();
      }
    }
  });

  it('hands back the identical promise of a non-async function that returns one', async () => {
    // This fixture is the one that catches a wrapper assuming the `async`
    // keyword: `loadRecentFiringCycles` is a plain function that returns the
    // client's own promise, and the wrapper must neither await it nor wrap it
    // in a promise of its own.
    const patch = patchFixture(firingLogFile, 'loadRecentFiringCycles');

    expect(patch.patchedText).toContain(`function ${INNER_FUNCTION_IDENTIFIER}() {`);
    expect(patch.patchedText).not.toContain(`async function ${INNER_FUNCTION_IDENTIFIER}`);

    for (const state of helperStates()) {
      const rows = Promise.resolve([entry]);
      const module = evaluateModule(patch.patchedText, firingLogFile, {
        globals: { ...globalsFor(state), Promise },
        deps: {
          './db-handles': {
            prisma: { firingCycle: { findMany: (): Promise<unknown> => rows } },
          },
        },
      });
      const returned: unknown = exportedFunction(module, 'loadRecentFiringCycles')('kiln-north-02');

      if (state.answers === 'body') {
        // Identity, not equality: the very promise the client returned.
        expect(returned, state.label).toBe(rows);
        expect(await returned, state.label).toEqual([entry]);
      } else if (state.answers === 'null') {
        expect(returned, state.label).toBeNull();
      } else {
        expect(returned, state.label).toBeUndefined();
      }
    }
  });

  it('rejects with the identical reason', async () => {
    const patch = patchFixture(firingLogFile, 'loadRecentFiringCycles');
    const reason = new Error('The kiln log is offline.');
    const module = evaluateModule(patch.patchedText, firingLogFile, {
      globals: {
        Promise,
        [SPAN_HELPER_GLOBAL]: {
          span: (_name: unknown, _meta: unknown, fn: () => unknown): unknown => fn(),
        },
      },
      deps: {
        './db-handles': {
          prisma: { firingCycle: { findMany: (): Promise<unknown> => Promise.reject(reason) } },
        },
      },
    });

    await expect(exportedFunction(module, 'loadRecentFiringCycles')('kiln-north-02')).rejects.toBe(
      reason,
    );
  });

  it('resolves a JavaScript async function to the same value, running the body once', async () => {
    const file = 'src/legacy/bisque-schedule.js';
    const patch = patchFixture(file, 'resolveBisqueSoak');

    for (const state of helperStates()) {
      let resolutions = 0;
      const module = evaluateModule(patch.patchedText, file, {
        globals: {
          ...globalsFor(state),
          Math,
          Promise: {
            resolve: (value: unknown): Promise<unknown> => {
              resolutions += 1;

              return Promise.resolve(value);
            },
          },
        },
      });
      const returned: unknown = exportedFunction(module, 'resolveBisqueSoak')('kiln-north-02', 4);

      // The outer function keeps its own `async` keyword, so *whatever* the
      // wrapper returns comes back as a promise — including a falsy value a
      // helper handed it. The answer is therefore read after awaiting.
      expect(typeof (returned as { then?: unknown }).then, state.label).toBe('function');

      const settled: unknown = await returned;

      if (state.answers === 'body') {
        expect(settled, state.label).toEqual({ kilnId: 'kiln-north-02', soakMinutes: 10 });
      } else if (state.answers === 'null') {
        expect(settled, state.label).toBeNull();
      } else {
        expect(settled, state.label).toBeUndefined();
      }

      // The body awaits exactly one `Promise.resolve`, whatever the helper
      // state: an `async` body moved into an `async` inner function, called
      // once.
      expect(resolutions, state.label).toBe(1);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The helper type alias, the directive prologue and the file's own formatting
 * ---------------------------------------------------------------------------
 */

describe('the helper type alias', () => {
  it('is the template’s own line, introducing no import', () => {
    const patch = patchFixture('src/server/cone-rules.ts', 'findConeProfile');
    const aliasLines = aliasLinesOf(patch.patchedText);

    // Compared against the exported constant, never a literal: a test that
    // restated the line could drift from the template while both looked
    // correct.
    expect(aliasLines).toEqual([HELPER_TYPE_ALIAS_TEXT]);
    expect(patch.helperTypeAliasInserted).toBe(true);
    expect(needsHelperTypeAlias(patch.file)).toBe(true);

    // The whole point of an alias over an import: a strict target project
    // type-checks the wrapper with no new dependency and nothing to undo
    // beyond deleting one line. The patched file therefore declares exactly
    // the imports it declared before.
    const importsBefore = patch.originalText
      .split('\n')
      .filter((line) => line.startsWith('import'));
    const importsAfter = patch.patchedText.split('\n').filter((line) => line.startsWith('import'));

    expect(importsAfter).toEqual(importsBefore);
    expect(HELPER_TYPE_ALIAS_TEXT).not.toContain('import');
    expect(HELPER_TYPE_ALIAS_TEXT.startsWith(`type ${SPAN_HELPER_TYPE_NAME} =`)).toBe(true);
  });

  it('is a structural copy of the runtime helper’s authoritative signature', () => {
    // `packages/telemetry/src/node/span-helper.ts` declares the shape the
    // patched wrapper calls. The alias cannot import it — a patched project has
    // no dependency on this product — so the two are held together by this
    // assertion instead: read the authoritative declaration as text and require
    // the alias to spell the same three parameters, in the same order, with the
    // same types.
    const signature = 'span<T>(name: string, meta: Record<string, unknown>, fn: () => T';
    const authoritative = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'telemetry',
        'src',
        'node',
        'span-helper.ts',
      ),
      'utf8',
    );

    expect(HELPER_TYPE_ALIAS_TEXT).toContain(`${signature}): T`);
    expect(
      authoritative,
      'the authoritative DebuggenSpanHelper signature changed; the inserted alias must match it',
    ).toContain(signature);
    // The authoritative interface may carry further **optional** parameters —
    // the span kind is one — and an alias that omits an optional parameter
    // still satisfies every call the wrapper makes. A further *required*
    // parameter would leave every patched function in every project a session
    // has ever touched calling a function it no longer satisfies, so the text
    // between this signature and the end of its declaration may not introduce
    // one.
    const declaration = authoritative.slice(
      authoritative.indexOf(signature) + signature.length,
      authoritative.indexOf(';', authoritative.indexOf(signature)),
    );

    expect(declaration.replace(/kind\?: SpanKind/u, '')).not.toMatch(/,\s*[A-Za-z_$][\w$]*\s*:/u);
  });

  it('is inserted at most once per file, however many symbols are patched', () => {
    const file = 'src/server/cycle-planner.ts';
    const first = patchFixture(file, 'planCycleSegments');
    // The second patch is computed against the first one's output, which is
    // exactly what the installer does when a plan names two symbols in one
    // file, and what a follow-up plan version does when it adds another.
    const second = patchFixture(file, 'estimateSoakMinutes', first.patchedText);

    expect(first.helperTypeAliasInserted).toBe(true);
    expect(second.helperTypeAliasInserted).toBe(false);
    expect(aliasLinesOf(first.patchedText)).toEqual([HELPER_TYPE_ALIAS_TEXT]);
    expect(aliasLinesOf(second.patchedText)).toEqual([HELPER_TYPE_ALIAS_TEXT]);
    expect(second.edits.filter((edit) => edit.purpose === 'helper-type-alias')).toEqual([]);

    // Both wrappers are present, so the second patch instrumented the second
    // symbol rather than quietly replacing the first one's work.
    expect(second.patchedText).toContain('"planCycleSegments"');
    expect(second.patchedText).toContain('"estimateSoakMinutes"');
    expect(second.patchedText.split(`const ${HELPER_LOCAL_IDENTIFIER} =`).length - 1).toBe(2);
  });

  it('goes after a directive prologue, which stays the file’s first statement', () => {
    const file = 'src/components/FiringLogForm.tsx';
    const patch = patchFixture(file, 'handleFiringSubmit');

    // A `"use client"` that stops being the first statement stops being a
    // directive, and the module silently becomes a server component.
    expect(patch.patchedText.startsWith("'use client';\n")).toBe(true);

    const statements = withParsed(patch.patchedText, file, (sourceFile) =>
      sourceFile.getStatements().map((statement) => statement.getText()),
    );

    expect(statements[0]).toBe("'use client';");
    expect(statements[1]).toBe(HELPER_TYPE_ALIAS_TEXT);
    expect(aliasLinesOf(patch.patchedText)).toEqual([HELPER_TYPE_ALIAS_TEXT]);
  });

  it('is absent from a JavaScript module that carries a directive prologue', () => {
    const file = 'src/legacy/ShelfPlaqueCard.jsx';
    const patch = patchFixture(file, 'handlePlaqueSelect');

    // A `type` alias is a syntax error in a `.jsx` file, so the directive is
    // still first *and* nothing was inserted above or below it.
    expect(patch.patchedText.startsWith("'use client';\n")).toBe(true);
    expect(patch.language).toBe('javascript');
    expect(patch.helperTypeAliasInserted).toBe(false);
    expect(needsHelperTypeAlias(file)).toBe(false);
    expect(aliasLinesOf(patch.patchedText)).toEqual([]);
    expect(patch.patchedText).not.toContain(SPAN_HELPER_TYPE_NAME);
    expect(patch.edits.map((edit) => edit.purpose)).toEqual(['function-body']);

    const statements = withParsed(patch.patchedText, file, (sourceFile) =>
      sourceFile.getStatements().map((statement) => statement.getText()),
    );

    expect(statements[0]).toBe("'use client';");
  });
});

describe('a JavaScript target', () => {
  it('receives no TypeScript syntax at all', () => {
    for (const [file, symbol] of [
      ['src/legacy/bisque-schedule.js', 'planBisqueRamp'],
      ['src/legacy/rack-tally.js', 'orderRacksByLoad'],
    ] as const) {
      const patch = patchFixture(file, symbol);
      // Asserted against what the patch *wrote* rather than the whole file:
      // these fixtures are ordinary studio modules whose prose legitimately
      // contains English that a substring match on the whole text would find
      // ("has never been converted" ends in the letters of a type assertion).
      const written = patch.edits.map((edit) => edit.replacement).join('\n');

      expect(patch.language).toBe('javascript');
      // The three TypeScript-only spellings the wrapper uses in a `.ts` file,
      // each of which would be a syntax error here.
      expect(written).not.toContain('as never');
      expect(written).not.toContain('globalThis as {');
      expect(written).not.toContain(SPAN_HELPER_TYPE_NAME);
      // The plain global read instead of the cast one.
      expect(patch.patchedText).toContain(
        `const ${HELPER_LOCAL_IDENTIFIER} = globalThis.${SPAN_HELPER_GLOBAL};`,
      );
      // `expectPatch` already re-parsed it under the JavaScript script kind;
      // this is the statement that a reader should not have to go and check.
      expectParses(patch.patchedText, file);
    }
  });

  it('carries only the global marker, which is the gate’s agreement', () => {
    const javascriptPatch = patchFixture('src/legacy/rack-tally.js', 'compareRackLoad');
    const typescriptPatch = patchFixture('src/server/kiln-controller.ts', 'normalizeRampRate');

    // `scripts/check-no-residual-instrumentation.mjs` greps for exactly these
    // two literals, enumerated here rather than restated.
    expect([...INSTRUMENTATION_MARKERS]).toEqual([SPAN_HELPER_GLOBAL, SPAN_HELPER_TYPE_NAME]);

    for (const marker of INSTRUMENTATION_MARKERS) {
      expect(typescriptPatch.patchedText).toContain(marker);
    }

    expect(javascriptPatch.patchedText).toContain(SPAN_HELPER_GLOBAL);
    expect(javascriptPatch.patchedText).not.toContain(SPAN_HELPER_TYPE_NAME);
    // Neither marker was in the developer's file before the patch, which is
    // what makes the gate's grep meaningful.
    expect(javascriptPatch.originalText).not.toContain(SPAN_HELPER_GLOBAL);
    expect(typescriptPatch.originalText).not.toContain(SPAN_HELPER_GLOBAL);
  });
});

describe('the file’s own formatting', () => {
  const file = 'src/components/KilnShelfMap.tsx';

  it('keeps a leading banner comment and the import order byte-for-byte', () => {
    const original = readFixture(file);
    const banner = original.slice(0, original.indexOf('*/') + 2);
    const patch = patchFixture(file, 'formatSoakLabel');

    // The banner is the file's first bytes — a copyright notice a project is
    // entitled to keep exactly as written — and the alias goes below it, not
    // above.
    expect(banner.startsWith('/*\n * Copyright')).toBe(true);
    expect(patch.patchedText.startsWith(banner)).toBe(true);
    expect(patch.patchedText.indexOf(HELPER_TYPE_ALIAS_TEXT)).toBeGreaterThan(banner.length);

    // The three imports, in the order the file declares them, neither
    // reordered, merged nor duplicated.
    const imports = patch.patchedText.split('\n').filter((line) => line.startsWith('import'));

    expect(imports).toEqual([
      "import { Fragment } from 'react';",
      "import type { ReactElement } from 'react';",
      "import { FiringLogForm } from './FiringLogForm';",
    ]);
    expect(imports).toEqual(original.split('\n').filter((line) => line.startsWith('import')));

    // And this is a real rewrite rather than a no-op: the wrapper is there.
    expect(patch.patchedText).toContain(
      `export function formatSoakLabel(minutes: number): string {\n  function ${INNER_FUNCTION_IDENTIFIER}() {`,
    );
  });

  it('answers identically after that rewrite', () => {
    const patch = patchFixture(file, 'formatSoakLabel');
    // The component in this module is never called here, but its JSX compiles
    // to calls into the automatic runtime, so both specifiers have to resolve
    // for the module to evaluate at all.
    const deps = {
      react: { Fragment: 'Fragment' },
      'react/jsx-runtime': { jsx: (): null => null, jsxs: (): null => null },
      './FiringLogForm': { FiringLogForm: (): null => null },
    };
    const before = evaluateModule(patch.originalText, file, { deps });
    const after = evaluateModule(patch.patchedText, file, { deps });
    const original = exportedFunction(before, 'formatSoakLabel');
    const patched = exportedFunction(after, 'formatSoakLabel');

    for (const minutes of [Number.NaN, -5, 0, 20, 45, 59, 60, 90, 120, 185]) {
      expect(patched(minutes)).toBe(original(minutes));
    }
  });

  it('refuses the render function in the same file, so only the helper is patched', () => {
    // AAP §0.5.1 tracks React renders at run time instead of patching them, so
    // the component beside the helper is a refusal rather than a second
    // wrapper. Asserted here because it is what makes the case above the
    // *complete* account of this file: one symbol is patched, the other is
    // declined with a hint naming the runtime route.
    const refusal = patcher.patch({
      file,
      symbol: 'KilnShelfMap',
      text: readFixture(file),
    });
    const details = expectRefusal(refusal, 'unsupported-react-component');

    expect(details.file).toBe(file);
    expect(details.symbol).toBe('KilnShelfMap');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The recorded position
 * ---------------------------------------------------------------------------
 */

describe('the emitted meta object', () => {
  it('carries exactly file, line, column and symbol', () => {
    // A contract with the runtime, not a convention: the page agent's span
    // helper reads `file`, `line` and `column` to build the only
    // `'patch'`-resolved source location in the product, and takes `symbol` as
    // its label. A misspelled or extra key throws nowhere and logs nothing —
    // click-to-source simply stops resolving.
    for (const [file, symbol] of [
      ['src/server/cycle-planner.ts', 'planCycleSegments'],
      ['app/api/firings/route.ts', 'POST'],
      ['src/server/glaze-rules.ts', 'pickGlazeProfile'],
      ['src/server/kiln-controller.ts', 'settleSegments'],
      ['src/legacy/rack-tally.js', 'tallyRackSlots'],
      ['src/components/KilnShelfMap.tsx', 'formatSoakLabel'],
    ] as const) {
      const patch = patchFixture(file, symbol);

      expect(emittedMetaKeys(patch), `${file}#${symbol}`).toEqual([...PATCH_META_KEYS]);
      expect(Object.keys(patch.meta), `${file}#${symbol}`).toEqual([...PATCH_META_KEYS]);
    }

    expect([...PATCH_META_KEYS]).toEqual(['file', 'line', 'column', 'symbol']);
  });

  it('carries the same numbers as the recorded source location', () => {
    const patch = patchFixture('src/server/firing-log.ts', 'logFiringCycle');

    // Built from one set of numbers, so the location the store records and the
    // meta the span carries cannot disagree about where the function is.
    expect(patch.meta).toEqual({
      file: patch.location.file,
      line: patch.location.line,
      column: patch.location.column,
      symbol: patch.symbol,
    });
    expect(patch.patchedText).toContain(
      `{ file: "${patch.meta.file}", line: ${String(patch.meta.line)}, column: ${String(
        patch.meta.column,
      )}, symbol: "${patch.meta.symbol}" }`,
    );
  });
});

describe('the recorded source location', () => {
  it('points at the pre-patch position of the declared name', () => {
    // Computed from the *pre-patch* text on purpose. Reading the position after
    // the rewrite would agree with a transform that recorded it late — and that
    // is the one mistake here that fails nothing and simply sends the developer
    // to the wrong line.
    for (const [file, symbol, anchor] of [
      ['src/server/cycle-planner.ts', 'planCycleSegments', 'export function planCycleSegments({'],
      [
        'src/server/cycle-planner.ts',
        'estimateSoakMinutes',
        'export function estimateSoakMinutes(',
      ],
      ['app/api/firings/route.ts', 'POST', 'export async function POST('],
      ['src/server/cone-rules.ts', 'findRampCeiling', 'export function findRampCeiling('],
      ['src/server/glaze-rules.ts', 'scoreShelfSlot', 'export const scoreShelfSlot = ('],
      ['src/server/kiln-controller.ts', 'totalSoakMinutes', '  totalSoakMinutes(): number {'],
      ['src/legacy/rack-tally.js', 'compareRackLoad', 'export const compareRackLoad = ('],
      [
        'src/legacy/bisque-schedule.js',
        'resolveBisqueSoak',
        'export async function resolveBisqueSoak(',
      ],
      ['src/components/KilnShelfMap.tsx', 'formatSoakLabel', 'export function formatSoakLabel('],
      [
        'src/legacy/ShelfPlaqueCard.jsx',
        'handlePlaqueSelect',
        'export function handlePlaqueSelect(',
      ],
    ] as const) {
      const original = readFixture(file);
      const expected = positionOfDeclaredName(original, anchor, symbol);
      const patch = patchFixture(file, symbol);

      expect(
        { line: patch.location.line, column: patch.location.column },
        `${file}#${symbol}`,
      ).toEqual(expected);
      // 1-based, both of them, and the last line of the whole declaration is
      // at or below the name's line.
      expect(patch.location.line, `${file}#${symbol}`).toBeGreaterThan(0);
      expect(patch.location.column, `${file}#${symbol}`).toBeGreaterThan(0);
      expect(patch.location.endLine ?? patch.location.line).toBeGreaterThanOrEqual(
        patch.location.line,
      );
      // The line really is the declaration's: reading it back out of the
      // original text finds the anchor there.
      expect(
        original.split('\n')[patch.location.line - 1],
        `${file}#${symbol} line content`,
      ).toContain(symbol);
    }
  });

  it('is project-relative POSIX, patch-resolved, and parses through the schema', () => {
    const patch = patchFixture('app/api/firings/route.ts', 'POST');
    const location = patch.location;

    expect(location.file).toBe('app/api/firings/route.ts');
    expect(location.file.startsWith('/')).toBe(false);
    expect(location.file).not.toContain('\\');
    expect(location.file).not.toContain('..');
    expect(isSafeRelativePath(location.file)).toBe(true);
    expect(location.symbol).toBe('POST');
    expect(location.resolvedBy).toBe('patch');
    // Read from the shared table rather than restated: the patch route's
    // confidence is a property of the route, and a literal here would let the
    // two drift.
    expect(location.confidence).toBe(DEFAULT_RESOLUTION_CONFIDENCE.patch);

    const parsed: Result<unknown> = parseSourceLocation(location);

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(parsed.value).toEqual(location);
    }
  });

  it('is reduced to project-relative form when the target is named absolutely', () => {
    const caseRoot = mkdtempSync(join(tmpdir(), 'debuggen-function-timing-'));

    try {
      const projectRoot = join(caseRoot, 'project');

      cpSync(FIXTURE_PROJECT, projectRoot, { recursive: true });

      // A real project on disk, opened over the copy: this is the one case that
      // needs one, because it exercises the route where the caller passes no
      // text and the transform reads it out of the project the service already
      // holds open.
      const project = new Project({ tsConfigFilePath: join(projectRoot, 'tsconfig.json') });
      const withProject = new FunctionTimingPatcher({ projectRoot, project });
      const relative = withProject.patch({
        file: 'src/server/cone-rules.ts',
        symbol: 'findConeProfile',
      });

      expect(relative.ok).toBe(true);

      if (relative.ok) {
        expect(relative.value.originalText).toBe(readFixture('src/server/cone-rules.ts'));
        expect(relative.value.location.file).toBe('src/server/cone-rules.ts');
        expectParses(relative.value.patchedText, relative.value.file);
      }

      const absolute = withProject.patch({
        file: join(projectRoot, 'src/server/cone-rules.ts'),
        symbol: 'findConeProfile',
      });

      expect(absolute.ok).toBe(true);

      if (absolute.ok && relative.ok) {
        // Same target, named two ways, patched identically — and the recorded
        // path is the project-relative one either way, because an absolute
        // developer path in a source location leaks the machine's layout into
        // a panel and into an outbound model request.
        expect(absolute.value.location.file).toBe('src/server/cone-rules.ts');
        expect(absolute.value.patchedText).toBe(relative.value.patchedText);
      }

      // A path that escapes the project is refused before anything is emitted.
      const escaping = withProject.patch({ file: '../escape.ts', symbol: 'findConeProfile' });

      expect(escaping.ok).toBe(false);

      if (!escaping.ok) {
        expect(escaping.error.code).toBe('PATH_OUTSIDE_PROJECT');
      }

      // Nothing was written anywhere: the transform performs no I/O, so even
      // the copy it read is byte-identical to the committed corpus.
      expect(digestOfFixtureTree()).toBe(FIXTURE_TREE_DIGEST);
      expect(sha256Hex(readFileSync(join(projectRoot, 'src/server/cone-rules.ts')))).toBe(
        sha256Hex(readFileSync(join(FIXTURE_PROJECT, 'src/server/cone-rules.ts'))),
      );
    } finally {
      rmSync(caseRoot, { recursive: true, force: true });
    }
  });

  it('carries the plan action’s id when the patch installs one', () => {
    const file = 'src/server/cone-rules.ts';
    const action: InstrumentationAction = {
      id: newActionId(),
      file,
      symbol: 'findRampCeiling',
      type: 'function-timing',
      adapter: 'nextjs',
      mode: 'patch',
      rationale: 'Time the cone-table lookup the handler waits on.',
    };
    const result = patcher.patchAction(action, readFixture(file));

    expect(result.ok).toBe(true);

    if (result.ok) {
      // The action's id is what links the resulting modification record back to
      // the plan action that caused it.
      expect(result.value.actionId).toBe(action.id);
      expect(result.value.file).toBe(action.file);
      expect(result.value.symbol).toBe(action.symbol);
      // And a patch built from the request alone carries none.
      expect(patchFixture(file, 'findRampCeiling').actionId).toBeUndefined();
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Refusals on the fixture corpus
 * ---------------------------------------------------------------------------
 */

describe('targets in the corpus that cannot be wrapped', () => {
  it('refuses a generator and an async generator, emitting nothing', () => {
    const file = 'src/server/segment-stream.ts';

    for (const [symbol, reason] of [
      ['walkRampSegments', 'unsupported-generator'],
      ['streamKilnSamples', 'unsupported-async-generator'],
    ] as const) {
      const result = patcher.patch({ file, symbol, text: readFixture(file) });
      const details = expectRefusal(result, reason);

      // A wrapper that called the body as a function cannot preserve `yield`,
      // so there is no template for this shape and nothing may be produced:
      // the caller must have no text it could decide to write.
      expect(details.file).toBe(file);
      expect(details.symbol).toBe(symbol);
      expect('value' in result).toBe(false);
    }
  });

  it('refuses a symbol the file does not declare', () => {
    const file = 'src/server/cone-rules.ts';
    const result = patcher.patch({
      file,
      symbol: 'findGlazeCeiling',
      text: readFixture(file),
    });

    expectRefusal(result, 'symbol-not-found', 'PATCH_TARGET_NOT_FOUND');
    expect('value' in result).toBe(false);
  });

  it('refuses a file it has no text for', () => {
    // No `text` and no configured project: the transform reads nothing off a
    // disk it never touches, so a target it cannot see is a refusal rather
    // than an exception thrown into the middle of a caller's write sequence.
    const result = patcher.patch({ file: 'src/server/absent-module.ts', symbol: 'whatever' });
    const details = expectRefusal(result, 'file-not-found', 'PATCH_TARGET_NOT_FOUND');

    expect(details.hasProject).toBe(false);
    expect('value' in result).toBe(false);
  });

  it('refuses a symbol that is already instrumented', () => {
    const file = 'src/server/cone-rules.ts';
    const once = patchFixture(file, 'findConeProfile');
    const twice = patcher.patch({ file, symbol: 'findConeProfile', text: once.patchedText });

    // Patching the same symbol twice would nest one wrapper inside another and
    // leave a modification chain the cleanup path could not unwind in order.
    expectRefusal(twice, 'already-instrumented');
    expect('value' in twice).toBe(false);
  });

  it('addresses a class member by its bare and qualified spellings alike', () => {
    const file = 'src/server/kiln-controller.ts';
    const bare = patchFixture(file, 'totalSoakMinutes');

    for (const separator of ['.', '#']) {
      const qualified = patchFixture(file, `KilnController${separator}totalSoakMinutes`);

      // The spelling names the target; it never changes what is emitted.
      expect(qualified.patchedText).toBe(bare.patchedText);
      expect(qualified.qualifiedName).toBe('KilnController.totalSoakMinutes');
      expect(qualified.spanName).toBe('totalSoakMinutes');
    }

    // A container the file does not declare is a refusal rather than a
    // fallback to the bare name, and the refusal names the container that does
    // hold the member so the plan can be corrected.
    const mismatched = patcher.patch({
      file,
      symbol: 'GlazeController.totalSoakMinutes',
      text: readFixture(file),
    });
    const details = expectRefusal(mismatched, 'symbol-not-addressable', 'PATCH_TARGET_NOT_FOUND');

    expect(details.position).toBe('mismatched-container');
    expect(details.container).toBe('GlazeController');

    if (!mismatched.ok) {
      expect(mismatched.error.hint).toContain('KilnController.totalSoakMinutes');
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Determinism and confinement
 * ---------------------------------------------------------------------------
 */

describe('determinism and confinement on the fixture corpus', () => {
  /** Every shape, one target each, for the properties that hold for all of them. */
  const targets = [
    ['src/server/cycle-planner.ts', 'planCycleSegments'],
    ['app/api/firings/route.ts', 'POST'],
    ['src/server/glaze-rules.ts', 'scoreShelfSlot'],
    ['src/server/kiln-controller.ts', 'settleSegments'],
    ['src/legacy/rack-tally.js', 'gradeRackDensity'],
    ['src/legacy/bisque-schedule.js', 'assertBisqueCone'],
    ['src/components/FiringLogForm.tsx', 'handleFiringSubmit'],
    ['src/legacy/ShelfPlaqueCard.jsx', 'handlePlaqueSelect'],
  ] as const;

  it('emits byte-identical text from two independent patchers', () => {
    for (const [file, symbol] of targets) {
      const text = readFixture(file);
      const first = new FunctionTimingPatcher().patch({ file, symbol, text });
      const second = new FunctionTimingPatcher().patch({ file, symbol, text });

      expect(first.ok && second.ok, `${file}#${symbol}`).toBe(true);

      if (first.ok && second.ok) {
        // `./patcher.ts` hashes this text as `instrumentedHash` *before* the
        // write and `../cleanup.ts` authorises a restore against that hash, so
        // nondeterminism here would not produce a wrong span — it would
        // produce a file the product declines to restore.
        expect(second.value.patchedText, `${file}#${symbol}`).toBe(first.value.patchedText);
        expect(second.value.meta, `${file}#${symbol}`).toEqual(first.value.meta);
        expect(second.value.location, `${file}#${symbol}`).toEqual(first.value.location);
      }
    }
  });

  it('confines every byte it changes to the declaration and the alias line', () => {
    for (const [file, symbol] of targets) {
      const patch = patchFixture(file, symbol);
      const ordered = [...patch.edits].sort((left, right) => left.start - right.start);

      // At most two edits, and never more: the rewrite of the target, and — at
      // most once per file — the alias.
      expect(patch.edits.length, `${file}#${symbol}`).toBeLessThanOrEqual(2);
      expect(
        patch.edits.map((edit) => edit.start),
        `${file}#${symbol}`,
      ).toEqual(ordered.map((edit) => edit.start));

      let previousEnd = 0;

      for (const edit of ordered) {
        expect(edit.start, `${file}#${symbol}`).toBeGreaterThanOrEqual(previousEnd);
        expect(edit.end, `${file}#${symbol}`).toBeGreaterThanOrEqual(edit.start);
        previousEnd = edit.end;

        if (edit.purpose === 'helper-type-alias') {
          continue;
        }

        // The rewrite is inside the declaration it claims: the edited range
        // starts and ends within the lines the recorded location spans.
        expect(
          lineOfOffset(patch.originalText, edit.start),
          `${file}#${symbol}`,
        ).toBeGreaterThanOrEqual(patch.location.line);
        expect(lineOfOffset(patch.originalText, edit.end), `${file}#${symbol}`).toBeLessThanOrEqual(
          patch.location.endLine ?? patch.location.line,
        );
      }

      // Replaying the reported edits reproduces the emitted text exactly, so
      // every byte the replay copied is a byte the patch did not write — which
      // is what makes "everything outside the patched node is untouched" a
      // checkable statement rather than a promise.
      expect(replayEdits(patch), `${file}#${symbol}`).toBe(patch.patchedText);

      const firstEdit = ordered[0];
      const lastEdit = ordered.at(-1);

      expect(firstEdit, `${file}#${symbol}`).toBeDefined();

      if (firstEdit !== undefined && lastEdit !== undefined) {
        expect(
          patch.patchedText.startsWith(patch.originalText.slice(0, firstEdit.start)),
          `${file}#${symbol} prefix`,
        ).toBe(true);
        expect(
          patch.patchedText.endsWith(patch.originalText.slice(lastEdit.end)),
          `${file}#${symbol} suffix`,
        ).toBe(true);
      }
    }
  });

  it('reports a shape from its own vocabulary, and the same text through the one-shot helper', () => {
    for (const [file, symbol] of targets) {
      const patch = patchFixture(file, symbol);
      const oneShot = patchFunctionTiming({ file, symbol, text: readFixture(file) });

      expect([...PATCH_TARGET_SHAPES], `${file}#${symbol}`).toContain(patch.shape);
      expect(oneShot.ok, `${file}#${symbol}`).toBe(true);

      if (oneShot.ok) {
        // A caller with one target and no project to reuse gets the same bytes
        // as the shared patcher.
        expect(oneShot.value.patchedText, `${file}#${symbol}`).toBe(patch.patchedText);
      }
    }
  });
});

describe('the committed fixture corpus', () => {
  it('is byte-identical after the whole suite has run against its text', () => {
    // The transform performs no I/O and every case here reads the corpus rather
    // than writing it, so this is the tripwire for the opposite: a case that
    // opened a real project over the committed tree, or that wrote a patched
    // text back beside the fixture it came from, would leave
    // `git status --porcelain packages/instrumentation` non-empty and this
    // repository carrying instrumentation in its own fixtures. The digest is
    // taken at module load — before any case runs — and compared here, which is
    // the last case in the file.
    expect(digestOfFixtureTree()).toBe(FIXTURE_TREE_DIGEST);
  });
});
