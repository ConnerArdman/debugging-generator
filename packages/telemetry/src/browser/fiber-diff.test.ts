// @vitest-environment happy-dom
/**
 * Colocated tests for `./fiber-diff.ts` — the product-owned fiber differ that
 * decides **why** a React component re-rendered and what may be said about the
 * values behind that decision.
 *
 * **What this suite owns.** AAP §0.8.3 names this file in the row "React fiber
 * hook compatibility and privacy": `fiber-diff` must handle "cyclic objects,
 * DOM nodes and functions without throwing or serialising them", stop at
 * `MAX_TRACKED_KEYS`, truncate previews at `MAX_PREVIEW_LENGTH` and redact
 * values matching the secret patterns of AAP §0.5.2. Two guarantees follow
 * from that, and every test below serves one of them:
 *
 * 1. **The differ cannot be made to throw or to leak.** It runs inside React's
 *    commit callback on the page's own stack, so an exception escaping it
 *    breaks the developer's application, and it is the **first** redaction
 *    boundary — the only one that ever sees raw application values. The
 *    service redacts again at ingest and the model provider a third time on
 *    the outbound path, but neither can put back what a leak here already
 *    sent, so a value that gets past these assertions is a hole in the privacy
 *    claim of `docs/SECURITY.md`.
 * 2. **The classification is correct enough to carry two metrics.**
 *    `unchanged_render_count` means, precisely (AAP §0.2.3): props
 *    shallow-equal, own hook state unchanged **and** no consumed context value
 *    changed. A render for which any one of the three could not be evaluated
 *    is `unknown` and is counted separately as
 *    `render_trigger_unknown_count`. The "nothing changed but a dimension was
 *    unevaluable → unknown" case below is what keeps that distinction honest,
 *    and so does its harder sibling: a change hidden past `MAX_TRACKED_KEYS`
 *    leaves an empty change list, so a scan that stopped at the bound reports
 *    the dimension unevaluable rather than claiming equality it never
 *    established.
 *
 * **The exported types are part of that contract.** `PropChange`,
 * `HookChange`, `ContextChange` and `DimensionEvaluability` are what
 * `../browser/react.ts`, `../aggregate/renders.ts` and the render-event
 * attributes are written against, so the final `describe` pins each of them to
 * the function result and the `FiberDiff` member it describes. Those
 * assertions are compile-time: this file is inside
 * `packages/telemetry/tsconfig.json`'s `include`, so `pnpm typecheck` fails if
 * an `export` disappears, a member is renamed, or a shape drifts from what a
 * consumer imports.
 *
 * **Why every credential fixture is assembled at runtime.** This file is
 * tracked, and `scripts/check-secrets.mjs` scans tracked content for provider
 * key prefixes, JOSE token shapes, key-file delimiters, credentialed
 * connection strings and high-entropy values bound to key-like names. A
 * realistic credential written as a contiguous literal would fail that gate
 * even as a test fixture, so no prefix, token body or delimiter appears as one
 * literal here: alphabets come from character ranges, bodies are cycled from
 * those alphabets, and prefixes are joined from fragments through
 * {@link assemble}. The sibling suites in `../redaction/` follow the same
 * convention, and `./fiber-diff.ts` itself is written that way too.
 *
 * **Why the bounds are imported and never restated.** `MAX_TRACKED_KEYS`,
 * `MAX_PREVIEW_LENGTH` and `RENDER_TRIGGERS` come from
 * `../schema/attributes.ts` and `REDACTION_MARKER` from
 * `../redaction/rules.ts`. A suite that asserted `32` or `120` as literals
 * would keep passing while the production bound drifted — and both numbers are
 * documented privacy guarantees rather than tuning knobs, so a drift is
 * exactly what this suite exists to catch.
 *
 * **Harness.** The root `vitest.config.ts` collects this file into the
 * `telemetry` project, which runs under happy-dom with `globals: true`. The
 * environment docblock on line 1 states the requirement locally all the same:
 * the DOM-node cases construct real elements with `document.createElement`, so
 * this file needs a document whatever the project default becomes.
 * `describe`/`it`/`expect` are imported explicitly, the convention across this
 * monorepo's suites. No `node:` builtin is imported and no fixture file is
 * read: the module under test is bundled into the page-injected agent
 * (`esbuild.agent.mjs` hard-fails on a Node builtin) and must be provable
 * without any I/O, so every input below is built inline. bippy is imported
 * for two reference answers the provider-attribution cases are checked
 * against: its per-version work-tag map, so their fibers carry React's own tag
 * numbers rather than the ones the module under test declares, and its
 * `getDisplayName`, which is how `./react.ts` names the provider's own render.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { getDisplayName, getReactWorkTags } from 'bippy';

import { REDACTION_MARKER } from '../redaction/rules.js';
import { MAX_PREVIEW_LENGTH, MAX_TRACKED_KEYS, RENDER_TRIGGERS } from '../schema/attributes.js';
import type {
  CapturedFiber,
  CapturedFiberAnalysisOptions,
  ContextChange,
  DimensionEvaluability,
  FiberDiff,
  HookChange,
  PropChange,
  RenderAnalysis,
  RenderTrigger,
  SummaryMemo,
  ValueSummary,
} from './fiber-diff.js';
import {
  analyzeCapturedFiber,
  analyzeFiber,
  captureFiber,
  classifyRenderTrigger,
  createSummaryMemo,
  diffContexts,
  diffHookState,
  diffProps,
  summarizeValue,
} from './fiber-diff.js';

// ---------------------------------------------------------------------------
// Fixture assembly
//
// Three helpers stand in for every long or credential-shaped literal this
// suite would otherwise contain (see the module documentation above).
// ---------------------------------------------------------------------------

/**
 * The inclusive character range from `first` to `last`, by code unit.
 *
 * Used instead of writing an alphabet out: a 64-character alphabet literal is
 * both long and high-entropy, which is precisely the shape the repository
 * secret gate's `entropy` rule looks for.
 */
function charRange(first: string, last: string): string {
  let result = '';
  for (let code = first.charCodeAt(0); code <= last.charCodeAt(0); code += 1) {
    result += String.fromCharCode(code);
  }
  return result;
}

const DIGITS = charRange('0', '9');
const LOWER_LETTERS = charRange('a', 'z');
const UPPER_LETTERS = charRange('A', 'Z');

/** Base64url alphabet: the body characters of opaque and JOSE credentials. */
const URLSAFE_CHARS = UPPER_LETTERS + LOWER_LETTERS + DIGITS + '-_';

/** Body characters of underscore-delimited forge tokens. */
const WORD_CHARS = UPPER_LETTERS + LOWER_LETTERS + DIGITS + '_';

/** Body characters of upper-case cloud access identifiers. */
const UPPER_ID_CHARS = UPPER_LETTERS + DIGITS;

/** Credential characters permitted after an HTTP authentication scheme. */
const BEARER_CHARS = UPPER_LETTERS + LOWER_LETTERS + DIGITS + '._~+/=-';

/**
 * A deterministic body of `length` characters cycled from `alphabet`.
 *
 * Deterministic rather than random so a failure is reproducible, and cycled
 * over the whole alphabet so the result is dense enough to look like key
 * material to the redaction rules the module under test composes.
 */
function cycle(alphabet: string, length: number): string {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += alphabet.charAt(index % alphabet.length);
  }
  return result;
}

/**
 * Joins credential fragments.
 *
 * Every call site exists to keep a credential prefix or a key-file delimiter
 * from appearing as one contiguous literal in this tracked file. The split
 * points carry no meaning beyond that, which is worth knowing before
 * "simplifying" a call away.
 */
function assemble(...fragments: readonly string[]): string {
  return fragments.join('');
}

/**
 * The distinctive tail every credential fixture ends with.
 *
 * Its characters belong to each rule's body class, so a rule that consumes
 * "the whole run of credential characters, not just the length that
 * identified it" must swallow this too. Finding it anywhere in a summary is
 * therefore proof that a credential tail survived redaction, which is the
 * single assertion the secret cases below all share.
 */
const SECRET_TAIL = assemble('TAIL', 'SENTINEL', '9');

/** Low-entropy prose, cycled to any length a bounds case needs. */
const PROSE_ALPHABET = 'lorem ipsum dolor sit amet ';

/** A single astral-plane code point: two UTF-16 units, one code point. */
const ASTRAL_CHAR = '\u{1F600}';

/** Matches a high or low surrogate that is not part of a valid pair. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------------------------------------------------------------------
// Synthetic fiber builders
//
// The module under test accepts `unknown` on purpose — real fibers vary by
// React version and a synthetic fiber-shaped object is a legitimate input — so
// the builders below are typed loosely and describe the fiber fields the
// differ actually reads: `memoizedProps`, `memoizedState`, `dependencies` and
// `alternate`.
// ---------------------------------------------------------------------------

/** A loosely typed page object: what every fiber field is, as far as this suite cares. */
type Bag = Record<string, unknown>;

/** One consumed-context dependency: the context object and the value read from it. */
interface ContextEntry {
  /** The context object React records on the dependency. */
  readonly context: Bag;
  /** The value the fiber read from that context on this render. */
  readonly value: unknown;
}

/**
 * A singly-linked chain of `useState`-shaped hook nodes, one per value.
 *
 * Each node carries `memoizedState` and a `queue` whose `dispatch` is a
 * function, which is how `./fiber-diff.ts` recognises a state-bearing hook.
 * `queue.lastRenderedReducer` is deliberately absent, which the differ reads
 * as `useState` and labels `state`.
 */
function makeHookChain(values: readonly unknown[]): Bag | null {
  let head: Bag | null = null;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    head = {
      memoizedState: values[index],
      queue: {
        dispatch: (): void => {
          // Never called. The differ reads `dispatch` to recognise the hook
          // kind and must never invoke anything it finds on a page object.
        },
      },
      next: head,
    };
  }
  return head;
}

/**
 * A chain of `useReducer`-shaped hook nodes: a dispatching queue whose
 * `lastRenderedReducer` is a *named* function other than React's
 * `basicStateReducer`, which is what the differ labels `reducer`.
 */
function makeReducerHookChain(values: readonly unknown[]): Bag | null {
  let head: Bag | null = null;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    head = {
      memoizedState: values[index],
      queue: {
        dispatch: (): void => {
          // Never called; see makeHookChain.
        },
        lastRenderedReducer: function cartReducer(): number {
          throw new Error('a reducer must never be invoked by the differ');
        },
      },
      next: head,
    };
  }
  return head;
}

/**
 * A chain of effect-shaped hook nodes — `{ create, destroy, deps, tag }` — so
 * that a suite can prove an effect record is not treated as state.
 *
 * `destroy` is a function the differ must never read through and never call:
 * invoking a cleanup during a commit would tear down the developer's effects.
 */
function makeEffectHookChain(values: readonly unknown[]): Bag | null {
  let head: Bag | null = null;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    head = {
      memoizedState: {
        create: (): void => {
          throw new Error('an effect must never be created by the differ');
        },
        destroy: (): void => {
          throw new Error('an effect must never be destroyed by the differ');
        },
        deps: [values[index]],
        tag: 5,
      },
      next: head,
    };
  }
  return head;
}

/** A chain of `useRef`-shaped hook nodes: `memoizedState` is a `{ current }` box. */
function makeRefHookChain(values: readonly unknown[]): Bag | null {
  let head: Bag | null = null;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    head = { memoizedState: { current: values[index] }, next: head };
  }
  return head;
}

/** A chain of `useMemo`-shaped hook nodes: `memoizedState` is a `[value, deps]` pair. */
function makeMemoHookChain(values: readonly unknown[]): Bag | null {
  let head: Bag | null = null;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    head = { memoizedState: [values[index], [values[index]]], next: head };
  }
  return head;
}

/**
 * Links the last node of a chain back to its head, making it cyclic.
 *
 * React never produces such a chain; a page that corrupted one, or a
 * synthetic fiber, can. The differ has to survive it, so the suite has to be
 * able to build it.
 */
function closeChain(head: Bag | null): Bag | null {
  if (head === null) {
    return null;
  }
  let tail = head;
  while (tail['next'] !== null && tail['next'] !== undefined) {
    const next = tail['next'];
    if (next === head) {
      return head;
    }
    tail = next as Bag;
  }
  tail['next'] = head;
  return head;
}

/**
 * A fiber `dependencies` object: `{ firstContext: { context, memoizedValue,
 * next } }`, the shape React records consumed contexts in.
 *
 * Returns `null` for an empty list, which is what React leaves on a fiber
 * whose render read no context at all.
 */
function makeContextChain(entries: readonly ContextEntry[]): Bag | null {
  let head: Bag | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    head = { context: entry.context, memoizedValue: entry.value, next: head };
  }
  return head === null ? null : { firstContext: head };
}

/** What {@link makeFiber} accepts: this render's values, and the previous render's. */
interface FiberSpec {
  /** `memoizedProps` for this render. */
  readonly props?: Bag;
  /** `memoizedProps` for the previous render; defaults to a copy of {@link props}. */
  readonly prevProps?: Bag;
  /** `memoizedState` head for this render, from one of the hook-chain builders. */
  readonly hooks?: unknown;
  /** `memoizedState` head for the previous render. */
  readonly prevHooks?: unknown;
  /** `dependencies` for this render, from {@link makeContextChain}. */
  readonly contexts?: unknown;
  /** `dependencies` for the previous render. */
  readonly prevContexts?: unknown;
  /** `false` builds a mount: a fiber with no `alternate` at all. */
  readonly withAlternate?: boolean;
}

/**
 * A synthetic fiber, with an `alternate` mirroring the previous render's
 * values.
 *
 * The previous props default to a **shallow copy** of this render's props
 * rather than the same object, so the default fiber exercises the real
 * per-key comparison instead of the differ's identical-object fast path. A
 * test that wants the fast path passes the same object as both.
 */
function makeFiber(spec: FiberSpec = {}): Bag {
  const fiber: Bag = {
    memoizedProps: spec.props ?? {},
    memoizedState: spec.hooks ?? null,
    dependencies: spec.contexts ?? null,
  };
  if (spec.withAlternate !== false) {
    fiber['alternate'] = {
      memoizedProps: { ...(spec.prevProps ?? spec.props ?? {}) },
      memoizedState: spec.prevHooks ?? null,
      dependencies: spec.prevContexts ?? null,
    };
  }
  return fiber;
}

/**
 * The prop name at `index`, zero-padded to two digits.
 *
 * `diffProps` sorts the capped key selection, so padding is what makes
 * lexicographic order agree with numeric order up to ninety-nine keys — which
 * is what lets a bounds case name the key that must, or must not, appear in
 * the reported list.
 */
function propKeyAt(index: number): string {
  return 'p' + String(index).padStart(2, '0');
}

/** Both sides of a context comparison, as {@link makeChangingContexts} builds them. */
interface ContextsPair {
  /** `dependencies` for this render. */
  readonly contexts: unknown;
  /** `dependencies` for the previous render. */
  readonly prevContexts: unknown;
}

/**
 * Two dependency chains over the **same** `count` context objects, with either
 * every consumed value changed or exactly one.
 *
 * Sharing the context identities is what makes the differ's identity-first
 * pairing apply, so a bounds case measures the bound rather than a pairing
 * failure.
 *
 * @param count Dependencies in each chain.
 * @param changed `'all'` to change every consumed value, or the single index
 * whose value differs between the two renders.
 */
function makeChangingContexts(count: number, changed: 'all' | number): ContextsPair {
  const objects: Bag[] = Array.from({ length: count }, (_unused, index) => ({
    displayName: 'ctx' + String(index),
    _currentValue: index,
  }));
  const entries = (next: boolean): ContextEntry[] =>
    objects.map((context, index) => ({
      context,
      value: next && (changed === 'all' || changed === index) ? index + 1 : index,
    }));
  return {
    contexts: makeContextChain(entries(true)),
    prevContexts: makeContextChain(entries(false)),
  };
}

/** Both sides of a hook comparison, as {@link makeChangingHooks} builds them. */
interface HooksPair {
  /** `memoizedState` head for this render. */
  readonly hooks: unknown;
  /** `memoizedState` head for the previous render. */
  readonly prevHooks: unknown;
}

/**
 * Two `useState`-shaped chains of `length` hooks whose every value differs.
 *
 * The counterpart of {@link makeChangingProps} for the hook dimension: every
 * position changed, so the reported change count equals the number of hooks
 * the walk actually paired.
 */
function makeChangingHooks(length: number): HooksPair {
  return {
    hooks: makeHookChain(Array.from({ length }, (_unused, index) => 'next-' + String(index))),
    prevHooks: makeHookChain(Array.from({ length }, (_unused, index) => 'prev-' + String(index))),
  };
}

/** Both sides of a props comparison, as {@link makeChangingProps} builds them. */
interface PropsPair {
  /** `memoizedProps` for this render. */
  readonly props: Bag;
  /** `memoizedProps` for the previous render. */
  readonly prevProps: Bag;
}

/**
 * `count` props on both sides, every one of them changed between the two
 * renders.
 *
 * Used by the key-bound cases: with every key changed, the number of reported
 * changes is exactly the number of keys the scan examined, so "at most
 * `MAX_TRACKED_KEYS` entries are reported" becomes an equality rather than an
 * inequality.
 */
function makeChangingProps(count: number): PropsPair {
  const props: Bag = {};
  const prevProps: Bag = {};
  for (let index = 0; index < count; index += 1) {
    const key = propKeyAt(index);
    prevProps[key] = index;
    props[key] = index + 1;
  }
  return { props, prevProps };
}

/**
 * `MAX_TRACKED_KEYS + 1` props of which **only the one past the bound**
 * changed.
 *
 * The hard case for the evaluability contract: the scan stops before that key,
 * so the change list comes back empty and the render is indistinguishable from
 * one whose props were genuinely all equal. Reported as unevaluable it becomes
 * `unknown`; reported as evaluated it would become `unchanged` and enter
 * `unchanged_render_count` (AAP 0.2.3) on the strength of a prop nothing read.
 */
function makeLateChangedProps(): PropsPair {
  const props: Bag = {};
  const prevProps: Bag = {};
  for (let index = 0; index <= MAX_TRACKED_KEYS; index += 1) {
    const key = propKeyAt(index);
    prevProps[key] = index;
    props[key] = index === MAX_TRACKED_KEYS ? index + 1 : index;
  }
  return { props, prevProps };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Length in code points, which is the unit `MAX_PREVIEW_LENGTH` is counted in. */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * The invariants **every** summary must satisfy, whatever produced it: a
 * non-empty category, a preview within the bound, no lone surrogate, and a
 * `truncated` flag that is either absent or `true` (never `false`, which is
 * the shape `./fiber-diff.ts` documents under `exactOptionalPropertyTypes`).
 */
function expectWellFormedSummary(summary: ValueSummary): void {
  expect(typeof summary.type).toBe('string');
  expect(summary.type.length).toBeGreaterThan(0);
  expect(typeof summary.preview).toBe('string');
  expect(codePointLength(summary.preview)).toBeLessThanOrEqual(MAX_PREVIEW_LENGTH);
  expect(summary.preview).not.toMatch(LONE_SURROGATE);
  if (summary.truncated !== undefined) {
    expect(summary.truncated).toBe(true);
  }
}

/**
 * A JSON-safe skeleton of an arbitrary value: its keys, its primitives and the
 * *shape* of everything else, with cycles collapsed and reads guarded.
 *
 * Used only to prove {@link analyzeFiber} does not mutate its input, so it
 * must be total (a synthetic fiber can hold a throwing getter) and stable
 * (object keys are visited in sorted order) rather than faithful.
 */
type Skeleton = string | number | boolean | null | Skeleton[] | { [key: string]: Skeleton };

function structuralSnapshot(value: unknown, seen: WeakSet<object> = new WeakSet()): Skeleton {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'undefined':
      return '[undefined]';
    case 'bigint':
    case 'symbol':
      return '[' + typeof value + ']';
    case 'function':
      return '[function]';
    default:
      break;
  }
  // Every other `typeof` returned above, so the value is an object here.
  const object: object = value;
  if (seen.has(object)) {
    return '[circular]';
  }
  seen.add(object);
  if (Array.isArray(object)) {
    return (object as readonly unknown[]).map((entry) => structuralSnapshot(entry, seen));
  }
  const result: { [key: string]: Skeleton } = {};
  for (const key of Object.keys(object).sort()) {
    try {
      result[key] = structuralSnapshot((object as Bag)[key], seen);
    } catch {
      result[key] = '[unreadable]';
    }
  }
  return result;
}

/**
 * Collects `typeof` for every leaf of a diff result.
 *
 * The transport is JSON text on the private page channel to the isolated-world
 * bridge and then JSON over a WebSocket, and the event schema's attribute refinement rejects a
 * function or a symbol outright. Asserting the leaf vocabulary is how this
 * suite proves a diff can make that journey: a `function`, `symbol`,
 * `undefined` or `bigint` leaf would be dropped or rejected downstream.
 */
function collectLeafTypes(value: unknown, into: Set<string>): void {
  if (value === null || typeof value !== 'object') {
    into.add(typeof value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value as readonly unknown[]) {
      collectLeafTypes(entry, into);
    }
    return;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectLeafTypes(entry, into);
  }
}

/**
 * Asserts a diff survives the transport: only JSON primitives at the leaves,
 * `JSON.stringify` succeeds, and the parsed result is strictly equal to the
 * original (which no object holding an explicit `undefined`, a function or a
 * symbol could be). Accepts the deferred {@link RenderAnalysis} too: it is
 * what `./react.ts` builds `render` and `state` events from.
 */
function expectTransportable(diff: FiberDiff | RenderAnalysis): void {
  const leafTypes = new Set<string>();
  collectLeafTypes(diff, leafTypes);
  for (const leafType of leafTypes) {
    expect(['string', 'number', 'boolean']).toContain(leafType);
  }
  const encoded = JSON.stringify(diff);
  expect(typeof encoded).toBe('string');
  const decoded: unknown = JSON.parse(encoded);
  expect(decoded).toStrictEqual(diff);
}

// ---------------------------------------------------------------------------
// Adversarial value catalogue
//
// One factory per value, rather than one value: a revoked `Proxy` and a
// settled promise are single-use, and a shared fixture that one test mutated
// would make another test's failure a mystery.
// ---------------------------------------------------------------------------

/** A named adversarial value, built fresh on demand. */
interface ValueCase {
  /** What the case is, so a failure names the shape rather than the bytes. */
  readonly label: string;
  /** Builds the value. */
  readonly make: () => unknown;
}

/**
 * Text put inside a DOM node: the developer's page, and on a form control
 * whatever their user typed into it. Never diagnostic, so never previewed.
 */
const DOM_TEXT_CONTENT = 'Ada Lovelace, 12 Orchard Lane';

/**
 * An error message carrying what error messages routinely carry. A category
 * (`TypeError`) explains a render; the message never has to.
 */
const ERROR_MESSAGE = 'card 4111 1111 1111 1111 declined for ada@example.com';

/** The distinctive token inside every function body used as a fixture. */
const FUNCTION_BODY_TOKEN = '7919';

/**
 * Page-owned content that must never appear in a summary, whatever value it
 * was reached through.
 *
 * Each entry is a fragment of one of the fixtures below — a DOM node's text, an
 * error's message, a function's body, the leaf of a deep object, a React
 * element's prop — and the sweep over {@link ADVERSARIAL_VALUES} asserts the
 * absence of all of them for every value in the catalogue. That is one
 * assertion standing in for the whole privacy contract: a preview describes,
 * and never carries.
 */
const NEVER_TRAVELS: readonly string[] = [
  DOM_TEXT_CONTENT,
  'Lovelace',
  'Orchard',
  ERROR_MESSAGE,
  '4111',
  'example.com',
  FUNCTION_BODY_TOKEN,
  'bottom',
  'LS-4471',
  '4471',
];

/** A named function whose body carries {@link FUNCTION_BODY_TOKEN}. */
function handleCheckout(items: number): number {
  return items * 7919;
}

/** An arrow function, named through its binding, with the same body token. */
const quoteShipping = (weight: number): number => weight * 7919;

/**
 * A function with no inferable name: a function expression in an array
 * literal gets no named evaluation, so `fn.name` is the empty string.
 */
function makeAnonymousFunction(): unknown {
  return [
    function (weight: number): number {
      return weight * 7919;
    },
  ][0];
}

/** An object that refers to itself: the AAP's first named robustness case. */
function makeCyclicObject(): Bag {
  const node: Bag = { id: 1 };
  node['self'] = node;
  return node;
}

/** An array that contains itself, which is how a cycle reaches a nested walk. */
function makeCyclicArray(): unknown[] {
  const list: unknown[] = ['first'];
  list.push(list);
  return list;
}

/** A DOM element with an id, three classes and text content that must not travel. */
function makeDomElement(): HTMLElement {
  const element = document.createElement('div');
  element.id = 'checkout-root';
  element.className = 'row active extra';
  element.textContent = DOM_TEXT_CONTENT;
  return element;
}

/** A revoked `Proxy`: every operation on it throws, including enumeration. */
function makeRevokedProxy(): unknown {
  const revocable = Proxy.revocable({ shape: 1 }, {});
  revocable.revoke();
  return revocable.proxy;
}

/** An object with an enumerable getter that throws when read. */
function makeThrowingGetter(): Bag {
  const object: Bag = { ok: 1 };
  Object.defineProperty(object, 'boom', {
    enumerable: true,
    get(): never {
      throw new Error('a getter the differ must survive');
    },
  });
  return object;
}

/** An object whose `toString` and `Symbol.toPrimitive` both throw if invoked. */
function makeThrowingCoercion(): Bag {
  return {
    ok: 1,
    toString(): never {
      throw new Error('toString must never be called');
    },
    [Symbol.toPrimitive](): never {
      throw new Error('Symbol.toPrimitive must never be called');
    },
  };
}

/** How deep the nesting cases go: far past the module's preview depth bound. */
const DEEP_NESTING_LEVELS = 20;

/** A twenty-level object, to prove the depth bound elides rather than descends. */
function makeDeepObject(): Bag {
  let node: Bag = { leaf: 'bottom' };
  for (let level = 0; level < DEEP_NESTING_LEVELS; level += 1) {
    node = { nest: node };
  }
  return node;
}

/** A twenty-level array, the same case through the one type that does recurse. */
function makeDeepArray(): unknown[] {
  let node: unknown[] = ['bottom'];
  for (let level = 0; level < DEEP_NESTING_LEVELS; level += 1) {
    node = [node];
  }
  return node;
}

/** A React element, marked the way React 19 marks them. */
function makeReactElement(): Bag {
  return {
    $$typeof: Symbol.for('react.transitional.element'),
    type: { displayName: 'ProductCard' },
    key: null,
    props: { sku: 'LS-4471', onSelect: (): void => undefined },
  };
}

/**
 * Every adversarial value the robustness cases sweep over.
 *
 * The sweep asserts the two properties that must hold for all of them — no
 * throw, and a well-formed bounded summary — while the individual cases below
 * assert what each one's preview must and must not contain.
 */
const ADVERSARIAL_VALUES: readonly ValueCase[] = [
  { label: 'a self-referential object', make: makeCyclicObject },
  { label: 'a self-referential array', make: makeCyclicArray },
  { label: 'a DOM element', make: makeDomElement },
  { label: 'a detached text node', make: (): unknown => document.createTextNode(DOM_TEXT_CONTENT) },
  { label: 'a named function', make: (): unknown => handleCheckout },
  { label: 'an anonymous function', make: makeAnonymousFunction },
  { label: 'an arrow function', make: (): unknown => quoteShipping },
  { label: 'a symbol', make: (): unknown => Symbol('customer-4471') },
  { label: 'a bigint', make: (): unknown => 9007199254740993n },
  { label: 'a pending promise', make: (): unknown => new Promise<void>(() => undefined) },
  { label: 'a thenable', make: (): unknown => ({ then: (): void => undefined }) },
  { label: 'an error', make: (): unknown => new TypeError(ERROR_MESSAGE) },
  { label: 'a map', make: (): unknown => new Map([['sku', 1]]) },
  { label: 'a weak map', make: (): unknown => new WeakMap() },
  { label: 'a set', make: (): unknown => new Set([1, 2, 3]) },
  { label: 'a weak set', make: (): unknown => new WeakSet() },
  { label: 'a date', make: (): unknown => new Date(0) },
  { label: 'a regular expression', make: (): unknown => /customer-(\d+)/gi },
  {
    label: 'a prototype-less object',
    make: (): unknown => Object.assign(Object.create(null), { sku: 'LS-4471' }),
  },
  { label: 'a revoked proxy', make: makeRevokedProxy },
  { label: 'an object with a throwing getter', make: makeThrowingGetter },
  { label: 'an object with throwing coercion', make: makeThrowingCoercion },
  { label: 'a deeply nested object', make: makeDeepObject },
  { label: 'a deeply nested array', make: makeDeepArray },
  { label: 'a React element', make: makeReactElement },
  { label: 'null', make: (): unknown => null },
  { label: 'undefined', make: (): unknown => undefined },
  { label: 'not a number', make: (): unknown => Number.NaN },
  { label: 'negative infinity', make: (): unknown => Number.NEGATIVE_INFINITY },
  { label: 'a typed array', make: (): unknown => new Uint8Array([1, 2, 3]) },
  { label: 'an empty string', make: (): unknown => '' },
];

// ---------------------------------------------------------------------------
// Credential fixtures: one per content-driven class of AAP 0.5.2
//
// Every one ends in SECRET_TAIL, drawn from that class's own body characters,
// so a rule that stopped at the length which merely *identified* the
// credential would leave the tail behind and fail the shared assertion.
// ---------------------------------------------------------------------------

/** A credential-shaped value and what must survive its redaction. */
interface SecretCase {
  /** The class under test, named rather than shown. */
  readonly label: string;
  /** The value, assembled at runtime from fragments. */
  readonly value: string;
  /**
   * Text that must still be present afterwards because it is diagnostic
   * rather than secret — a scheme word, a URL's scheme and authority — or the
   * marker alone when nothing about the value may survive.
   */
  readonly survives: readonly string[];
}

/** Every credential class `scrub` replaces by content. */
const SECRET_CASES: readonly SecretCase[] = [
  {
    label: 'a vendor-scoped model provider key',
    value: assemble('s', 'k-', 'ant-') + cycle(URLSAFE_CHARS, 40) + SECRET_TAIL,
    survives: [REDACTION_MARKER],
  },
  {
    label: 'a short-form model provider key',
    value: assemble('s', 'k-') + cycle(URLSAFE_CHARS, 32) + SECRET_TAIL,
    survives: [REDACTION_MARKER],
  },
  {
    label: 'a classic forge access token',
    value: assemble('gh', 'p_') + cycle(WORD_CHARS, 36) + SECRET_TAIL,
    survives: [REDACTION_MARKER],
  },
  {
    label: 'a fine-grained forge access token',
    value: assemble('git', 'hub_', 'pat_') + cycle(WORD_CHARS, 40) + SECRET_TAIL,
    survives: [REDACTION_MARKER],
  },
  {
    label: 'a cloud access key identifier',
    value: assemble('AK', 'IA') + cycle(UPPER_ID_CHARS, 16) + SECRET_TAIL,
    survives: [REDACTION_MARKER],
  },
  {
    label: 'an HTTP bearer credential',
    value: assemble('Bea', 'rer ') + cycle(BEARER_CHARS, 40) + SECRET_TAIL,
    // The scheme word stays: that a request was authenticated is diagnostic,
    // and the credential is what must not be.
    survives: [REDACTION_MARKER, assemble('Bea', 'rer')],
  },
  {
    label: 'a JOSE compact token',
    value:
      assemble('ey', 'J') +
      cycle(URLSAFE_CHARS, 20) +
      '.' +
      cycle(URLSAFE_CHARS, 24) +
      '.' +
      cycle(URLSAFE_CHARS, 20) +
      SECRET_TAIL,
    survives: [REDACTION_MARKER],
  },
  {
    label: 'a PEM private-key block',
    value:
      assemble('-'.repeat(5), 'BEGIN RSA ', 'PRIVATE', ' KEY', '-'.repeat(5)) +
      '\n' +
      cycle(URLSAFE_CHARS, 48) +
      SECRET_TAIL +
      '\n' +
      assemble('-'.repeat(5), 'END RSA ', 'PRIVATE', ' KEY', '-'.repeat(5)),
    survives: [REDACTION_MARKER],
  },
  {
    label: 'a credentialed connection string',
    value:
      assemble('postgres', 'ql://', 'reporting', ':') +
      cycle(URLSAFE_CHARS, 16) +
      SECRET_TAIL +
      assemble('@localhost:5432/', 'lumen'),
    // Scheme and authority stay: a redacted connection string must remain
    // diagnosable, which is what tells a developer which database was reached.
    survives: [REDACTION_MARKER, 'postgres', 'localhost:5432'],
  },
];

/** Key-like names whose values are replaced whole, however short. */
const SENSITIVE_PROP_NAMES: readonly string[] = ['token', 'apiKey', 'password', 'authHeader'];

/** A short, low-entropy value: redacted under a sensitive name and only then. */
const SHORT_NAMED_VALUE = 'hunter2';

// ---------------------------------------------------------------------------
// summarizeValue
// ---------------------------------------------------------------------------

describe('summarizeValue', () => {
  describe('robustness', () => {
    it.each(ADVERSARIAL_VALUES)(
      'summarises $label without throwing and within the bounds',
      ({ make }) => {
        const value = make();
        const summary = summarizeValue(value);
        expectWellFormedSummary(summary);
        // Under a name as well: the name-driven path is a second code path
        // through the same composition, and it must be just as total.
        expectWellFormedSummary(summarizeValue(value, 'optionsBag'));
      },
    );

    it('describes a self-referential object by its keys rather than recursing', () => {
      const summary = summarizeValue(makeCyclicObject());

      expect(summary.type).toBe('object');
      // Key names are diagnostic (AAP 0.5.2); the value behind `self` is
      // reported as a category, which is what terminates the walk.
      expect(summary.preview).toContain('self');
      expect(summary.preview).toContain('id');
      expectWellFormedSummary(summary);
    });

    it('marks a cycle reached through a nested walk as circular rather than serialising it', () => {
      const summary = summarizeValue(makeCyclicArray());

      expect(summary.type).toBe('array');
      expect(summary.preview).toContain('[circular]');
      expect(summary.preview).toContain('first');
      expectWellFormedSummary(summary);
    });

    it('reports a repeated reference as circular even when the graph is acyclic', () => {
      const shared = { sku: 'LS-4471' };

      const summary = summarizeValue([shared, shared]);

      // The visited set is what bounds a wide graph, not just a cyclic one:
      // the second occurrence is reported rather than described again.
      expect(summary.preview).toContain('[circular]');
      expectWellFormedSummary(summary);
    });

    it('describes a DOM node by its tag and never by its content', () => {
      const summary = summarizeValue(makeDomElement());

      expect(summary.type).toBe('dom');
      expect(summary.preview).toContain('div');
      expect(summary.preview).toContain('checkout-root');
      expect(summary.preview).toContain('row');
      // The page's text is the developer's data, and on a form control it is
      // whatever their user typed.
      expect(summary.preview).not.toContain(DOM_TEXT_CONTENT);
      expect(summary.preview).not.toContain('Lovelace');
      expect(summary.preview).not.toContain('<div ');
      expect(summary.preview).not.toContain('</div>');
      expectWellFormedSummary(summary);
    });

    it('describes a DOM node nested inside a prop without walking into it', () => {
      const summary = summarizeValue({ node: makeDomElement(), rows: 3 });

      expect(summary.preview).not.toContain(DOM_TEXT_CONTENT);
      expect(summary.preview).toContain('node');
      expectWellFormedSummary(summary);
    });

    it('names a function without reading its source text', () => {
      const named = summarizeValue(handleCheckout);
      const arrow = summarizeValue(quoteShipping);
      const anonymous = summarizeValue(makeAnonymousFunction());

      expect(named.type).toBe('function');
      expect(named.preview).toBe('[function handleCheckout]');
      expect(arrow.type).toBe('function');
      expect(arrow.preview).toBe('[function quoteShipping]');
      expect(anonymous.type).toBe('function');
      expect(anonymous.preview).toBe('[function]');
      for (const summary of [named, arrow, anonymous]) {
        // A closure can hold anything, and `Function.prototype.toString`
        // returns the body, so neither is ever reached.
        expect(summary.preview).not.toContain(FUNCTION_BODY_TOKEN);
        expect(summary.preview).not.toContain('return');
        expect(summary.preview).not.toContain('=>');
        expectWellFormedSummary(summary);
      }
    });

    it('describes an error by its class and never by its message', () => {
      const summary = summarizeValue(new TypeError(ERROR_MESSAGE));

      expect(summary.type).toBe('error');
      expect(summary.preview).toContain('TypeError');
      expect(summary.preview).not.toContain('4111');
      expect(summary.preview).not.toContain('example.com');
      expect(summary.preview).not.toContain(ERROR_MESSAGE);
      expectWellFormedSummary(summary);
    });

    it('describes a symbol, a bigint, a date and a regular expression by shape', () => {
      expect(summarizeValue(Symbol('customer-4471')).preview).not.toContain('4471');
      expect(summarizeValue(Symbol('customer-4471')).type).toBe('symbol');
      // A bigint is a scalar the evidence layer legitimately carries.
      expect(summarizeValue(9007199254740993n).preview).toBe('9007199254740993');
      // A date is a value — a birth date, an appointment — so identity is
      // reported and the instant is not.
      expect(summarizeValue(new Date(86_400_000)).type).toBe('date');
      expect(summarizeValue(new Date(86_400_000)).preview).not.toContain('1970');
      expect(summarizeValue(/customer-(\d+)/gi).type).toBe('regexp');
      expect(summarizeValue(/customer-(\d+)/gi).preview).not.toContain('customer');
    });

    it('describes a collection by its size and never by its entries', () => {
      const map = summarizeValue(new Map([['ada@example.com', 3]]));
      const set = summarizeValue(new Set(['ada@example.com']));

      expect(map.type).toBe('map');
      expect(map.preview).toContain('1');
      expect(map.preview).not.toContain('example.com');
      expect(set.type).toBe('set');
      expect(set.preview).not.toContain('example.com');
      // A weak collection cannot be enumerated at all and has no size.
      expect(summarizeValue(new WeakMap()).type).toBe('map');
      expect(summarizeValue(new WeakSet()).type).toBe('set');
    });

    it('reports a value whose keys cannot be enumerated as unreadable', () => {
      const summary = summarizeValue(makeRevokedProxy());

      // Every operation on a revoked proxy throws, including `for…in`,
      // `Object.hasOwn`, `Array.isArray` and `Object.prototype.toString`.
      expect(summary.preview).toBe('[unreadable]');
      expectWellFormedSummary(summary);
    });

    it('skips a property whose getter throws while still describing the rest', () => {
      const summary = summarizeValue(makeThrowingGetter());

      expect(summary.type).toBe('object');
      expect(summary.preview).toContain('ok');
      expect(summary.preview).toContain('boom');
      expect(summary.preview).toContain('unreadable');
      expectWellFormedSummary(summary);
    });

    it('never invokes a value it found: coercion hooks that throw are not called', () => {
      // Calling `toString`, `valueOf` or `Symbol.toPrimitive` would run the
      // page's code inside React's commit callback. If any were reached the
      // fixture's throw would escape and this test would fail.
      const summary = summarizeValue(makeThrowingCoercion());

      expect(summary.type).toBe('object');
      expect(summary.preview).toContain('ok');
      expectWellFormedSummary(summary);
    });

    it('elides depth rather than descending a deeply nested value', () => {
      const object = summarizeValue(makeDeepObject());
      const array = summarizeValue(makeDeepArray());

      expect(object.preview).not.toContain('bottom');
      expect(array.preview).not.toContain('bottom');
      // Twenty levels in, a depth bound of two means the preview is a few
      // characters long — proof the walk stopped rather than being truncated
      // at the end of a 120-character serialisation.
      expect(object.preview.length).toBeLessThan(MAX_PREVIEW_LENGTH);
      expect(array.preview.length).toBeLessThan(MAX_PREVIEW_LENGTH);
      expectWellFormedSummary(object);
      expectWellFormedSummary(array);
    });

    it('names the component of a React element without walking its props', () => {
      const summary = summarizeValue(makeReactElement());

      expect(summary.type).toBe('react-element');
      expect(summary.preview).toContain('ProductCard');
      expect(summary.preview).not.toContain('LS-4471');
      expectWellFormedSummary(summary);
    });

    it.each(ADVERSARIAL_VALUES)('never lets $label carry its content out', ({ make }) => {
      const encoded = JSON.stringify(summarizeValue(make(), 'optionsBag'));

      // One assertion for the whole catalogue: whatever a value is, none of
      // the page-owned content the fixtures hold may appear in the summary
      // that leaves the page.
      for (const forbidden of NEVER_TRAVELS) {
        expect(encoded).not.toContain(forbidden);
      }
    });
  });

  describe('bounds', () => {
    it('truncates a long value to the preview bound and says so', () => {
      const summary = summarizeValue(cycle(PROSE_ALPHABET, 500));

      expect(summary.type).toBe('string');
      expect(summary.truncated).toBe(true);
      expect(codePointLength(summary.preview)).toBeLessThanOrEqual(MAX_PREVIEW_LENGTH);
      // A consumer must never present a shortened preview as a whole value,
      // which is what the flag is for.
      expect(summary.preview.length).toBeLessThan(500);
    });

    it('leaves a value of exactly the bound unmarked', () => {
      const exact = cycle(PROSE_ALPHABET, MAX_PREVIEW_LENGTH);

      const summary = summarizeValue(exact);

      expect(codePointLength(exact)).toBe(MAX_PREVIEW_LENGTH);
      expect(summary.preview).toBe(exact);
      expect(summary.truncated).toBeUndefined();
    });

    it('truncates a value one code point past the bound', () => {
      // The immediate boundary pair for the preview bound: the case above is
      // the largest value that must pass through whole, and this is the
      // smallest that must be cut. A length check written with the wrong
      // comparison — `>` where `>=` was meant, or the reverse — passes both
      // the exact-bound case and the 500-character case above while failing
      // exactly here, which is why one code point either side is asserted
      // rather than a comfortable margin.
      const justOver = cycle(PROSE_ALPHABET, MAX_PREVIEW_LENGTH + 1);

      const summary = summarizeValue(justOver);

      expect(codePointLength(justOver)).toBe(MAX_PREVIEW_LENGTH + 1);
      expect(summary.truncated).toBe(true);
      expect(codePointLength(summary.preview)).toBeLessThanOrEqual(MAX_PREVIEW_LENGTH);
      expect(summary.preview).not.toBe(justOver);
      expectWellFormedSummary(summary);
    });

    it('counts the bound in code points, not UTF-16 units', () => {
      // Half the bound in astral characters is twice the bound in code units:
      // a length check written in `String.length` would cut this value.
      const withinBound = ASTRAL_CHAR.repeat(MAX_PREVIEW_LENGTH - 20);

      const summary = summarizeValue(withinBound);

      expect(withinBound.length).toBeGreaterThan(MAX_PREVIEW_LENGTH);
      expect(summary.preview).toBe(withinBound);
      expect(summary.truncated).toBeUndefined();
    });

    it('never splits a surrogate pair when it does truncate', () => {
      const summary = summarizeValue(ASTRAL_CHAR.repeat(MAX_PREVIEW_LENGTH * 2));

      expect(summary.truncated).toBe(true);
      expect(codePointLength(summary.preview)).toBeLessThanOrEqual(MAX_PREVIEW_LENGTH);
      expect(summary.preview).not.toMatch(LONE_SURROGATE);
      // A lone surrogate would also make the preview unencodable, which the
      // round trip proves it is not.
      expect(JSON.parse(JSON.stringify(summary.preview))).toBe(summary.preview);
    });

    it('bounds a preview composed from a wide value', () => {
      const wide: Bag = {};
      for (let index = 0; index < MAX_TRACKED_KEYS + 8; index += 1) {
        wide['warehouseRegion' + String(index)] = index;
      }

      const summary = summarizeValue(wide);

      expectWellFormedSummary(summary);
      // The last key is beyond every bound the composition applies, so it
      // cannot be in the preview however the elision is spelled.
      expect(summary.preview).not.toContain('warehouseRegion' + String(MAX_TRACKED_KEYS + 7));
    });
  });

  describe('redaction', () => {
    it.each(SECRET_CASES)('removes $label from a prop value', ({ value, survives }) => {
      const summary = summarizeValue(value);
      const encoded = JSON.stringify(summary);

      expect(summary.preview).toContain(REDACTION_MARKER);
      // The tail is drawn from the credential's own body characters, so its
      // absence is what proves the whole run went and not just the prefix
      // that identified it.
      expect(encoded).not.toContain(SECRET_TAIL);
      for (const kept of survives) {
        expect(summary.preview).toContain(kept);
      }
      expectWellFormedSummary(summary);
    });

    it.each(SECRET_CASES)('removes $label nested inside a prop', ({ value }) => {
      // A credential does not have to be the prop: it can sit inside an array
      // the prop holds, which is a different composition path.
      const encoded = JSON.stringify(summarizeValue([value]));

      expect(encoded).toContain(REDACTION_MARKER);
      expect(encoded).not.toContain(SECRET_TAIL);
    });

    it.each(SENSITIVE_PROP_NAMES)('replaces a value captured under %s whole', (name) => {
      const named = summarizeValue(SHORT_NAMED_VALUE, name);

      // Name-driven redaction is stricter than content detection on purpose: a
      // four-character password is still a password, and this is the path the
      // `key` argument exists for.
      expect(named.preview).toBe(REDACTION_MARKER);
      expect(named.preview).not.toContain(SHORT_NAMED_VALUE);
    });

    it('uses the key argument: the same value under an ordinary name survives', () => {
      const anonymous = summarizeValue(SHORT_NAMED_VALUE);
      const ordinary = summarizeValue(SHORT_NAMED_VALUE, 'shippingMethod');

      // Without this pair the previous test would pass even if the name were
      // ignored and every string were replaced.
      expect(anonymous.preview).toBe(SHORT_NAMED_VALUE);
      expect(ordinary.preview).toBe(SHORT_NAMED_VALUE);
    });

    it('scrubs a credential split across the keys of one value', () => {
      // Scrubbing runs on the composed preview rather than on each piece, so a
      // credential assembled by the composition itself is still caught.
      const summary = summarizeValue([
        assemble('s', 'k-', 'ant-') + cycle(URLSAFE_CHARS, 40) + SECRET_TAIL,
        assemble('Bea', 'rer ') + cycle(BEARER_CHARS, 40) + SECRET_TAIL,
      ]);

      expect(summary.preview).toContain(REDACTION_MARKER);
      expect(JSON.stringify(summary)).not.toContain(SECRET_TAIL);
    });
  });
});

// ---------------------------------------------------------------------------
// diffProps
// ---------------------------------------------------------------------------

describe('diffProps', () => {
  it('reports a changed primitive prop with both ends of the transition', () => {
    const result = diffProps(
      makeFiber({ props: { count: 2, label: 'cart' }, prevProps: { count: 1, label: 'cart' } }),
    );

    expect(result.evaluable).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.changed).toHaveLength(1);
    const change = result.changed[0];
    expect(change?.key).toBe('count');
    expect(change?.from.preview).toBe('1');
    expect(change?.to.preview).toBe('2');
  });

  it('reports a prop that changed identity while its contents stayed equal', () => {
    // The point of a shallow comparison: React's own bailout works on
    // identity, so a new object or a new inline callback with identical
    // contents is a prop that caused the render.
    const result = diffProps(
      makeFiber({ props: { filters: { region: 'eu' } }, prevProps: { filters: { region: 'eu' } } }),
    );

    expect(result.evaluable).toBe(true);
    expect(result.changed.map((change) => change.key)).toStrictEqual(['filters']);
    expect(result.changed[0]?.from.preview).toBe(result.changed[0]?.to.preview);
  });

  it('reports a new inline callback as a changed prop', () => {
    const result = diffProps(
      makeFiber({
        props: { onSelect: (): void => undefined },
        prevProps: { onSelect: (): void => undefined },
      }),
    );

    expect(result.changed.map((change) => change.key)).toStrictEqual(['onSelect']);
    expect(result.changed[0]?.to.type).toBe('function');
  });

  it('reports nothing when every prop is the same value', () => {
    const result = diffProps(makeFiber({ props: { count: 1, label: 'cart' } }));

    expect(result).toStrictEqual({ changed: [], evaluable: true, truncated: false });
  });

  it('reports nothing when React reused the props object', () => {
    const shared = { count: 1 };

    const result = diffProps({ memoizedProps: shared, alternate: { memoizedProps: shared } });

    // The bailout path hands the same object to both renders; the same object
    // cannot differ from itself, so no key is read at all.
    expect(result).toStrictEqual({ changed: [], evaluable: true, truncated: false });
  });

  it('reports an added and a removed prop as transitions with both ends', () => {
    const result = diffProps(makeFiber({ props: { added: 1 }, prevProps: { removed: 2 } }));

    expect(result.changed.map((change) => change.key)).toStrictEqual(['added', 'removed']);
    expect(result.changed[0]?.from.type).toBe('undefined');
    expect(result.changed[1]?.to.type).toBe('undefined');
  });

  it('examines at most the tracked-key bound and reports the overflow', () => {
    const props: Bag = {};
    const prevProps: Bag = {};
    for (let index = 0; index < MAX_TRACKED_KEYS + 8; index += 1) {
      prevProps[propKeyAt(index)] = index;
      props[propKeyAt(index)] = index + 1;
    }

    const result = diffProps(makeFiber({ props, prevProps }));

    // Truncated, so equality across the dimension was never established: the
    // keys past the bound were not read at all. The changes found are still
    // reported — they are real, and a positive finding outranks an unknown in
    // `classifyRenderTrigger` — but the dimension may not be read as "these
    // are all of them", which is what `evaluable` claims.
    expect(result.evaluable).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.changed).toHaveLength(MAX_TRACKED_KEYS);
    const reported = result.changed.map((change) => change.key);
    // The bound caps exposure as well as size: a key past it is dropped
    // rather than summarised more coarsely.
    expect(reported).toContain(propKeyAt(0));
    expect(reported).not.toContain(propKeyAt(MAX_TRACKED_KEYS + 7));
    // Deterministic order, so two captures of the same render agree.
    expect(reported).toStrictEqual([...reported].sort());
  });

  it('compares a props object of exactly the tracked-key bound in full', () => {
    const { props, prevProps } = makeChangingProps(MAX_TRACKED_KEYS);

    const result = diffProps(makeFiber({ props, prevProps }));

    // The largest props object that fits: every key is read, so the dimension
    // is complete and nothing is dropped.
    expect(Object.keys(props)).toHaveLength(MAX_TRACKED_KEYS);
    expect(result.truncated).toBe(false);
    expect(result.evaluable).toBe(true);
    expect(result.changed).toHaveLength(MAX_TRACKED_KEYS);
  });

  it('drops exactly one key from a props object one past the bound', () => {
    const { props, prevProps } = makeChangingProps(MAX_TRACKED_KEYS + 1);

    const result = diffProps(makeFiber({ props, prevProps }));

    // One key more than the case above, and the only thing that may differ is
    // the overflow: still exactly `MAX_TRACKED_KEYS` reported, now flagged
    // truncated and therefore incomplete. Asserting the pair one key apart is
    // what pins the bound itself rather than "somewhere around thirty-two".
    expect(Object.keys(props)).toHaveLength(MAX_TRACKED_KEYS + 1);
    expect(result.truncated).toBe(true);
    expect(result.evaluable).toBe(false);
    expect(result.changed).toHaveLength(MAX_TRACKED_KEYS);
    expect(result.changed.map((change) => change.key)).not.toContain(propKeyAt(MAX_TRACKED_KEYS));
  });

  it('is unevaluable when the only changed prop sits past the tracked-key bound', () => {
    const result = diffProps(makeFiber(makeLateChangedProps()));

    // The visible evidence is identical to a props object that genuinely did
    // not change — empty change list — so reporting the dimension as evaluated
    // would let this render be counted in `unchanged_render_count` while the
    // prop that caused it sat unread past the bound (AAP 0.2.3).
    expect(result.changed).toStrictEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.evaluable).toBe(false);
  });

  it('skips a prop whose getter throws and keeps comparing the rest', () => {
    const props = makeThrowingGetter();

    const result = diffProps(makeFiber({ props, prevProps: { ok: 2, boom: 3 } }));

    // One hostile prop must not blind the comparison of its neighbours, and
    // must not make the dimension unevaluable either.
    expect(result.evaluable).toBe(true);
    expect(result.changed.map((change) => change.key)).toStrictEqual(['ok']);
  });

  it('is unevaluable for a mount, because there is nothing to compare against', () => {
    const result = diffProps(makeFiber({ props: { count: 1 }, withAlternate: false }));

    expect(result).toStrictEqual({ changed: [], evaluable: false, truncated: false });
  });

  it('is unevaluable when either side of the props is not an object', () => {
    expect(
      diffProps({ memoizedProps: 'text', alternate: { memoizedProps: { a: 1 } } }).evaluable,
    ).toBe(false);
    expect(
      diffProps({ memoizedProps: { a: 1 }, alternate: { memoizedProps: null } }).evaluable,
    ).toBe(false);
  });

  it('is unevaluable when the props cannot be enumerated at all', () => {
    const result = diffProps({
      memoizedProps: makeRevokedProxy(),
      alternate: { memoizedProps: { a: 1 } },
    });

    // An empty key list is indistinguishable from an unchanged one, so a
    // value that cannot be enumerated must never read as "nothing changed".
    expect(result.evaluable).toBe(false);
    expect(result.changed).toStrictEqual([]);
  });

  it('summarises a changed prop under its own name, so name-driven redaction applies', () => {
    const result = diffProps(
      makeFiber({ props: { apiKey: SHORT_NAMED_VALUE }, prevProps: { apiKey: 'previous' } }),
    );

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.to.preview).toBe(REDACTION_MARKER);
    expect(result.changed[0]?.from.preview).toBe(REDACTION_MARKER);
    expect(JSON.stringify(result)).not.toContain(SHORT_NAMED_VALUE);
  });

  it('never throws for a fiber that is not a fiber', () => {
    for (const fiber of [null, undefined, 7, 'fiber', makeRevokedProxy()]) {
      const result = diffProps(fiber);
      expect(result.evaluable).toBe(false);
      expect(result.changed).toStrictEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// diffHookState
// ---------------------------------------------------------------------------

describe('diffHookState', () => {
  it('pairs hooks positionally and reports the one that changed', () => {
    const result = diffHookState(
      makeFiber({
        hooks: makeHookChain(['stable', 2]),
        prevHooks: makeHookChain(['stable', 1]),
      }),
    );

    expect(result.evaluable).toBe(true);
    expect(result.changed).toHaveLength(1);
    // Hooks are anonymous; their position in the list is the only stable
    // identifier they have.
    expect(result.changed[0]?.index).toBe(1);
    expect(result.changed[0]?.label).toBe('state');
    expect(result.changed[0]?.from.preview).toBe('1');
    expect(result.changed[0]?.to.preview).toBe('2');
  });

  it('labels a reducer hook as a reducer', () => {
    const result = diffHookState(
      makeFiber({ hooks: makeReducerHookChain([2]), prevHooks: makeReducerHookChain([1]) }),
    );

    expect(result.changed[0]?.label).toBe('reducer');
  });

  it('reports nothing when every hook holds the same value', () => {
    const result = diffHookState(
      makeFiber({ hooks: makeHookChain(['a', 'b']), prevHooks: makeHookChain(['a', 'b']) }),
    );

    expect(result).toStrictEqual({ changed: [], evaluable: true, truncated: false });
  });

  it('treats a component with no hooks as evaluable and unchanged', () => {
    const result = diffHookState(makeFiber({ props: { count: 1 } }));

    // Without this case `unchanged` would be unreachable for most components
    // and `unchanged_render_count` would always read zero.
    expect(result).toStrictEqual({ changed: [], evaluable: true, truncated: false });
  });

  it('ignores an effect record, which is a queue entry and not state', () => {
    const result = diffHookState(
      makeFiber({
        hooks: makeEffectHookChain(['next']),
        prevHooks: makeEffectHookChain(['previous']),
      }),
    );

    // Reading through an effect's `destroy`, let alone calling it, would tear
    // down the developer's effects during a commit; the fixture's functions
    // throw if either happens.
    expect(result).toStrictEqual({ changed: [], evaluable: true, truncated: false });
  });

  it('ignores a ref box, which cannot be the reason a render happened', () => {
    const result = diffHookState(
      makeFiber({ hooks: makeRefHookChain([2]), prevHooks: makeRefHookChain([1]) }),
    );

    expect(result.changed).toStrictEqual([]);
    expect(result.evaluable).toBe(true);
  });

  it('ignores a memo cache, which is replaced during the render it would be blamed for', () => {
    const result = diffHookState(
      makeFiber({ hooks: makeMemoHookChain([2]), prevHooks: makeMemoHookChain([1]) }),
    );

    // Counting a memo cache as state would report "state changed" for exactly
    // the renders that make `unchanged_render_count` meaningful.
    expect(result.changed).toStrictEqual([]);
    expect(result.evaluable).toBe(true);
  });

  it('bounds a long hook chain and reports the overflow', () => {
    const result = diffHookState(makeFiber(makeChangingHooks(MAX_TRACKED_KEYS + 6)));

    // Truncated, so the tail of the chain was never walked and the dimension
    // cannot claim that the hooks it did not reach are unchanged.
    expect(result.evaluable).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.changed).toHaveLength(MAX_TRACKED_KEYS);
    expect(result.changed.at(-1)?.index).toBe(MAX_TRACKED_KEYS - 1);
  });

  it('walks a hook chain of exactly the tracked-key bound in full', () => {
    const result = diffHookState(makeFiber(makeChangingHooks(MAX_TRACKED_KEYS)));

    // The longest chain that fits: every hook is paired and compared.
    expect(result.truncated).toBe(false);
    expect(result.evaluable).toBe(true);
    expect(result.changed).toHaveLength(MAX_TRACKED_KEYS);
    expect(result.changed.at(-1)?.index).toBe(MAX_TRACKED_KEYS - 1);
  });

  it('drops exactly one hook from a chain one past the bound', () => {
    const result = diffHookState(makeFiber(makeChangingHooks(MAX_TRACKED_KEYS + 1)));

    // One hook longer than the case above: the same thirty-two reported, now
    // flagged truncated and therefore incomplete.
    expect(result.truncated).toBe(true);
    expect(result.evaluable).toBe(false);
    expect(result.changed).toHaveLength(MAX_TRACKED_KEYS);
    expect(result.changed.map((change) => change.index)).not.toContain(MAX_TRACKED_KEYS);
  });

  it('is unevaluable when the only changed hook sits past the tracked-key bound', () => {
    const length = MAX_TRACKED_KEYS + 1;
    const shared = Array.from({ length }, (_unused, index) => 'hook-' + String(index));
    const changedTail = [...shared.slice(0, MAX_TRACKED_KEYS), 'hook-changed'];

    const result = diffHookState(
      makeFiber({ hooks: makeHookChain(changedTail), prevHooks: makeHookChain(shared) }),
    );

    // Same shape as the props case: nothing visible changed, but the hook that
    // did change was never walked, so `unchanged` would be a claim about a
    // value this capture never read.
    expect(result.changed).toStrictEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.evaluable).toBe(false);
  });

  it('terminates on a cyclic hook chain and reports the dimension unevaluable', () => {
    // Both sides cycle, and with the same period: a walk that only stopped at
    // the tracked-key bound would collect equal-length lists on both sides,
    // pair them happily and report a comparison over a chain it had walked
    // eleven times round. Detecting the cycle is what makes this unevaluable,
    // and having both sides cycle is what makes the detection observable.
    const result = diffHookState(
      makeFiber({
        hooks: closeChain(makeHookChain(['a', 'b', 'c'])),
        prevHooks: closeChain(makeHookChain(['x', 'y', 'z'])),
      }),
    );

    expect(result).toStrictEqual({ changed: [], evaluable: false, truncated: false });
  });

  it('reports an asymmetrically cyclic chain as unevaluable rather than mispairing it', () => {
    const result = diffHookState(
      makeFiber({
        hooks: closeChain(makeHookChain(['a', 'b', 'c'])),
        prevHooks: makeHookChain(['a', 'b', 'c']),
      }),
    );

    expect(result).toStrictEqual({ changed: [], evaluable: false, truncated: false });
  });

  it('is unevaluable when the chains cannot be paired', () => {
    const mismatched = diffHookState(
      makeFiber({ hooks: makeHookChain(['a', 'b']), prevHooks: makeHookChain(['a']) }),
    );
    const appeared = diffHookState(makeFiber({ hooks: makeHookChain(['a']), prevHooks: null }));

    // A mispaired chain would compare one hook's value against another's and
    // invent a state change out of nothing.
    expect(mismatched.evaluable).toBe(false);
    expect(mismatched.changed).toStrictEqual([]);
    expect(appeared.evaluable).toBe(false);
  });

  it('is unevaluable for a class component, whose memoizedState is not a hook list', () => {
    const result = diffHookState(makeFiber({ hooks: { count: 2 }, prevHooks: { count: 1 } }));

    // "We could not check the fiber's hook state" is the honest answer for a
    // shape this code would otherwise have to guess at.
    expect(result.evaluable).toBe(false);
  });

  it('is unevaluable for a mount and never throws for a non-fiber', () => {
    expect(
      diffHookState(makeFiber({ hooks: makeHookChain(['a']), withAlternate: false })),
    ).toStrictEqual({ changed: [], evaluable: false, truncated: false });
    for (const fiber of [null, undefined, 7, makeRevokedProxy()]) {
      expect(diffHookState(fiber).evaluable).toBe(false);
    }
  });

  it('summarises hook values without a name, and still scrubs by content', () => {
    const credential = assemble('s', 'k-', 'ant-') + cycle(URLSAFE_CHARS, 40) + SECRET_TAIL;

    const result = diffHookState(
      makeFiber({ hooks: makeHookChain([credential]), prevHooks: makeHookChain(['empty']) }),
    );

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.to.preview).toContain(REDACTION_MARKER);
    expect(JSON.stringify(result)).not.toContain(SECRET_TAIL);
  });
});

// ---------------------------------------------------------------------------
// diffContexts
// ---------------------------------------------------------------------------

describe('diffContexts', () => {
  /** A context object with a display name, as React records one. */
  const shippingContext: Bag = { displayName: 'ShippingEta', _currentValue: { etaMinutes: 2 } };

  /** A context object with no display name: the label falls back to a category. */
  const cartContext: Bag = { _currentValue: 0 };

  it('reports a consumed context whose value changed', () => {
    const result = diffContexts(
      makeFiber({
        contexts: makeContextChain([{ context: shippingContext, value: { etaMinutes: 2 } }]),
        prevContexts: makeContextChain([{ context: shippingContext, value: { etaMinutes: 3 } }]),
      }),
    );

    expect(result.evaluable).toBe(true);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.index).toBe(0);
    expect(result.changed[0]?.label).toBe('ShippingEta');
  });

  it('reports nothing when the consumed value is the same reference', () => {
    const value = { etaMinutes: 4 };

    const result = diffContexts(
      makeFiber({
        contexts: makeContextChain([{ context: shippingContext, value }]),
        prevContexts: makeContextChain([{ context: shippingContext, value }]),
      }),
    );

    // `Object.is` is the comparison React itself uses to decide whether to
    // propagate a context change to its consumers.
    expect(result).toStrictEqual({ changed: [], evaluable: true, truncated: false });
  });

  it('treats a component that consumes no context as evaluable and unchanged', () => {
    const result = diffContexts(makeFiber({ props: { count: 1 } }));

    expect(result).toStrictEqual({ changed: [], evaluable: true, truncated: false });
  });

  it('pairs dependencies by context identity, not by position', () => {
    const result = diffContexts(
      makeFiber({
        contexts: makeContextChain([
          { context: cartContext, value: 5 },
          { context: shippingContext, value: 9 },
        ]),
        prevContexts: makeContextChain([
          { context: shippingContext, value: 9 },
          { context: cartContext, value: 5 },
        ]),
      }),
    );

    // A conditional `useContext` can reorder the chain between renders, and
    // comparing two different contexts' values would manufacture a change.
    expect(result.changed).toStrictEqual([]);
    expect(result.evaluable).toBe(true);
  });

  it('compares a dependency chain of exactly the tracked-key bound in full', () => {
    const result = diffContexts(makeFiber(makeChangingContexts(MAX_TRACKED_KEYS, 'all')));

    // The longest chain that fits: every dependency is paired by identity and
    // compared, so the dimension is complete.
    expect(result.truncated).toBe(false);
    expect(result.evaluable).toBe(true);
    expect(result.changed).toHaveLength(MAX_TRACKED_KEYS);
  });

  it('drops exactly one dependency from a chain one past the bound', () => {
    const result = diffContexts(makeFiber(makeChangingContexts(MAX_TRACKED_KEYS + 1, 'all')));

    // One dependency more than the case above, and the difference is the
    // overflow alone: still thirty-two reported, now incomplete.
    expect(result.truncated).toBe(true);
    expect(result.evaluable).toBe(false);
    expect(result.changed).toHaveLength(MAX_TRACKED_KEYS);
    expect(result.changed.map((change) => change.index)).not.toContain(MAX_TRACKED_KEYS);
  });

  it('is unevaluable when the only changed context sits past the tracked-key bound', () => {
    const result = diffContexts(
      makeFiber(makeChangingContexts(MAX_TRACKED_KEYS + 1, MAX_TRACKED_KEYS)),
    );

    // The third instance of the same rule: a consumed context value that
    // changed beyond the bound leaves no visible trace, so the dimension must
    // report that it could not be evaluated rather than that nothing changed.
    expect(result.changed).toStrictEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.evaluable).toBe(false);
  });

  it('is unevaluable when the previous value of a consumed context is unavailable', () => {
    const result = diffContexts({
      dependencies: makeContextChain([{ context: shippingContext, value: 1 }]),
      alternate: { memoizedProps: {} },
    });

    // This is the case AAP 0.7.1 names as producing `unknown`: the context is
    // consumed now, and what it held before cannot be known.
    expect(result).toStrictEqual({ changed: [], evaluable: false, truncated: false });
  });

  it('is unevaluable for a mount and never throws for a non-fiber', () => {
    expect(
      diffContexts(
        makeFiber({
          contexts: makeContextChain([{ context: cartContext, value: 1 }]),
          withAlternate: false,
        }),
      ).evaluable,
    ).toBe(false);
    for (const fiber of [null, undefined, 7, makeRevokedProxy()]) {
      expect(diffContexts(fiber).evaluable).toBe(false);
    }
  });

  it('summarises a context value without carrying it', () => {
    const credential = assemble('Bea', 'rer ') + cycle(BEARER_CHARS, 40) + SECRET_TAIL;

    const result = diffContexts(
      makeFiber({
        contexts: makeContextChain([{ context: cartContext, value: credential }]),
        prevContexts: makeContextChain([{ context: cartContext, value: 'anonymous' }]),
      }),
    );

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.to.preview).toContain(REDACTION_MARKER);
    expect(JSON.stringify(result)).not.toContain(SECRET_TAIL);
  });
});

// ---------------------------------------------------------------------------
// diffContexts — provider attribution
//
// A `context` trigger has to say which context changed, by the component that
// provides it (AAP 0.8.2: "context change: ‹provider›"). The lookup walks the
// consumer's `return` chain, so the cases below build that chain by hand, and
// every work tag in it comes from bippy's own version map rather than from a
// literal: a provider tag that drifted from React's would stop matching these
// fibers and fail here. React 18 and 19 shape a provider — and a consumer —
// differently, and both are covered, because the two majors swap shapes
// between the two roles.
// ---------------------------------------------------------------------------

describe('diffContexts — provider attribution', () => {
  /** React 19.3.0's work tags, the version this repository renders against. */
  const REACT_19_TAGS = getReactWorkTags('19.3.0');

  /** React 18.3.1's work tags, for the `Ctx.Provider`-object provider shape. */
  const REACT_18_TAGS = getReactWorkTags('18.3.1');

  /** The work tags one major assigns, as far as these builders read them. */
  interface Tags {
    readonly FunctionComponent: number;
    readonly HostComponent: number;
  }

  /** A fresh context object in the shape `createContext` returns. */
  function makeContextObject(displayName?: string): Bag {
    const context: Bag = { $$typeof: Symbol.for('react.context'), _currentValue: 0 };
    if (displayName !== undefined) {
      context['displayName'] = displayName;
    }
    return context;
  }

  /** A component function carrying an explicit display name. */
  function namedComponent(name: string): () => null {
    const component = (): null => null;
    component.displayName = name;
    return component;
  }

  /** A function-component fiber for `name`, as React tags one. */
  function componentFiber(tags: Tags, name: string): Bag {
    const component = namedComponent(name);
    return { tag: tags.FunctionComponent, elementType: component, type: component };
  }

  /** A host (`div`) fiber: stepped over, never named. */
  function hostFiber(tags: Tags): Bag {
    return { tag: tags.HostComponent, elementType: 'div', type: 'div' };
  }

  /** React 19's provider fiber: `<Ctx value>` puts the context itself on `type`. */
  function provider19(context: Bag): Bag {
    return { tag: REACT_19_TAGS.ContextProvider, elementType: context, type: context };
  }

  /** React 18's provider fiber: `<Ctx.Provider>` puts `{ _context: Ctx }` on `type`. */
  function provider18(context: Bag): Bag {
    const providerType: Bag = { $$typeof: Symbol.for('react.provider'), _context: context };
    return { tag: REACT_18_TAGS.ContextProvider, elementType: providerType, type: providerType };
  }

  /** React 19's `<Ctx.Consumer>` fiber: `{ _context: Ctx }`, React 18's provider shape. */
  function consumer19(context: Bag): Bag {
    const consumerType: Bag = { $$typeof: Symbol.for('react.consumer'), _context: context };
    return { tag: REACT_19_TAGS.ContextConsumer, elementType: consumerType, type: consumerType };
  }

  /** React 18's production `<Ctx.Consumer>` fiber: the context itself, React 19's provider shape. */
  function consumer18(context: Bag): Bag {
    return { tag: REACT_18_TAGS.ContextConsumer, elementType: context, type: context };
  }

  /** Links `fiber` under `ancestors`, nearest first, through `return`, and returns it. */
  function underAncestors(fiber: Bag, ancestors: readonly Bag[]): Bag {
    let child = fiber;
    for (const ancestor of ancestors) {
      child['return'] = ancestor;
      child = ancestor;
    }
    return fiber;
  }

  /** A consuming fiber whose value of every one of `contexts` changed. */
  function changedConsumer(contexts: readonly Bag[]): Bag {
    return makeFiber({
      contexts: makeContextChain(contexts.map((context, index) => ({ context, value: index + 1 }))),
      prevContexts: makeContextChain(
        contexts.map((context, index) => ({ context, value: -index })),
      ),
    });
  }

  /** The single change `diffContexts` reports for `fiber`, or a failure saying so. */
  function onlyChange(fiber: unknown): ContextChange {
    const result = diffContexts(fiber);
    expect(result.changed).toHaveLength(1);
    const change = result.changed[0];
    if (change === undefined) {
      throw new Error('expected exactly one context change, found none');
    }
    return change;
  }

  it('names the component rendering a React 19 provider (`<Ctx value>`)', () => {
    const context = makeContextObject();
    const fiber = underAncestors(changedConsumer([context]), [
      hostFiber(REACT_19_TAGS),
      provider19(context),
      hostFiber(REACT_19_TAGS),
      componentFiber(REACT_19_TAGS, 'PreferencesProvider'),
      componentFiber(REACT_19_TAGS, 'AppRoot'),
    ]);

    // The host fibers either side of the provider are not components; the
    // first composite above the provider is the one that renders it.
    expect(onlyChange(fiber).provider).toBe('PreferencesProvider');
  });

  it('names the component rendering a React 18 provider (`Ctx.Provider` object)', () => {
    const context = makeContextObject();
    const fiber = underAncestors(changedConsumer([context]), [
      provider18(context),
      componentFiber(REACT_18_TAGS, 'PreferencesProvider'),
    ]);

    expect(onlyChange(fiber).provider).toBe('PreferencesProvider');
  });

  it('takes the nearest provider when the same context is provided twice', () => {
    const context = makeContextObject();
    const fiber = underAncestors(changedConsumer([context]), [
      provider19(context),
      componentFiber(REACT_19_TAGS, 'InnerPreferencesProvider'),
      provider19(context),
      componentFiber(REACT_19_TAGS, 'OuterPreferencesProvider'),
    ]);

    // React resolves a read against the nearest provider, so that is the one
    // whose value changed.
    expect(onlyChange(fiber).provider).toBe('InnerPreferencesProvider');
  });

  it('never takes a consumer fiber for a provider, in either major', () => {
    const context = makeContextObject();
    for (const consumer of [consumer19(context), consumer18(context)]) {
      const fiber = underAncestors(changedConsumer([context]), [
        consumer,
        componentFiber(REACT_19_TAGS, 'ConsumerWrapper'),
        provider19(context),
        componentFiber(REACT_19_TAGS, 'PreferencesProvider'),
      ]);

      // Each consumer carries the context in the other major's provider
      // shape; only its tag keeps `ConsumerWrapper` from being blamed.
      expect(onlyChange(fiber).provider).toBe('PreferencesProvider');
    }
  });

  it('leaves provider absent when only a consumer, or nothing, provides the context', () => {
    const context = makeContextObject();
    const onlyConsumer = underAncestors(changedConsumer([context]), [
      consumer19(context),
      componentFiber(REACT_19_TAGS, 'ConsumerWrapper'),
    ]);
    const noProvider = underAncestors(changedConsumer([context]), [
      hostFiber(REACT_19_TAGS),
      componentFiber(REACT_19_TAGS, 'AppRoot'),
    ]);

    for (const fiber of [onlyConsumer, noProvider, changedConsumer([context])]) {
      const change = onlyChange(fiber);
      // Still a change — attribution is never classification — but no
      // component is named that does not provide the context.
      expect('provider' in change).toBe(false);
    }
  });

  it('leaves provider absent rather than naming a component further up', () => {
    const context = makeContextObject();
    const anonymous = (): null => null;
    Object.defineProperty(anonymous, 'name', { value: '' });
    const fiber = underAncestors(changedConsumer([context]), [
      provider19(context),
      { tag: REACT_19_TAGS.FunctionComponent, elementType: anonymous, type: anonymous },
      componentFiber(REACT_19_TAGS, 'AppRoot'),
    ]);

    // The unnamed component is the one that renders the provider; `AppRoot`
    // only renders that component, so naming it would blame the wrong one.
    expect('provider' in onlyChange(fiber)).toBe(false);
  });

  it('reports the context displayName as contextName and keeps label as it was', () => {
    const namedChange = onlyChange(changedConsumer([makeContextObject('PreferencesContext')]));
    expect(namedChange.contextName).toBe('PreferencesContext');
    expect(namedChange.label).toBe('PreferencesContext');

    const unnamedChange = onlyChange(changedConsumer([makeContextObject()]));
    expect('contextName' in unnamedChange).toBe(false);
    // The existing fallback: the category of the context's current value.
    expect(unnamedChange.label).toBe('number');
  });

  it('attributes several changed contexts in one walk, and only the changed ones', () => {
    const preferences = makeContextObject('PreferencesContext');
    const session = makeContextObject('SessionContext');
    const stable = makeContextObject('StableContext');
    const consumer = makeFiber({
      contexts: makeContextChain([
        { context: preferences, value: 2 },
        { context: stable, value: 7 },
        { context: session, value: 'next' },
      ]),
      prevContexts: makeContextChain([
        { context: preferences, value: 1 },
        { context: stable, value: 7 },
        { context: session, value: 'previous' },
      ]),
    });
    const fiber = underAncestors(consumer, [
      provider19(session),
      componentFiber(REACT_19_TAGS, 'SessionProvider'),
      provider19(stable),
      componentFiber(REACT_19_TAGS, 'StableProvider'),
      provider18(preferences),
      componentFiber(REACT_19_TAGS, 'PreferencesProvider'),
    ]);

    const result = diffContexts(fiber);

    expect(result.evaluable).toBe(true);
    expect(
      result.changed.map((change) => [change.index, change.provider, change.contextName]),
    ).toStrictEqual([
      [0, 'PreferencesProvider', 'PreferencesContext'],
      [2, 'SessionProvider', 'SessionContext'],
    ]);
    expect(JSON.stringify(result)).not.toContain('StableProvider');
  });

  it('names a memo or forwardRef provider component the way its own render is named', () => {
    const context = makeContextObject();
    const inner = namedComponent('PreferencesProviderImplementation');
    const memoWrapper: Bag = { $$typeof: Symbol.for('react.memo'), type: inner };
    const namedMemo: Bag = { ...memoWrapper, displayName: 'PreferencesProvider' };
    const forwardRefWrapper: Bag = { $$typeof: Symbol.for('react.forward_ref'), render: inner };
    // `memo(forwardRef(…))`: two wrappers deep, named by the function inside.
    const memoOfForwardRef: Bag = { $$typeof: Symbol.for('react.memo'), type: forwardRefWrapper };
    // A wrapper whose `type` is itself: React never builds one, and the lookup
    // must end rather than spin, leaving the provider unnamed.
    const selfWrapped: Bag = { $$typeof: Symbol.for('react.memo') };
    selfWrapped['type'] = selfWrapped;
    const cases: readonly (readonly [Bag, string | undefined])[] = [
      // `displayName` on the wrapper wins, as it does for the render event.
      [
        { tag: REACT_19_TAGS.MemoComponent, elementType: namedMemo, type: namedMemo },
        'PreferencesProvider',
      ],
      // An unnamed simple-memo wrapper falls through to the inner function.
      [
        { tag: REACT_19_TAGS.SimpleMemoComponent, elementType: memoWrapper, type: inner },
        'PreferencesProviderImplementation',
      ],
      [
        { tag: REACT_19_TAGS.ForwardRef, elementType: forwardRefWrapper, type: forwardRefWrapper },
        'PreferencesProviderImplementation',
      ],
      [
        { tag: REACT_19_TAGS.MemoComponent, elementType: memoOfForwardRef, type: memoOfForwardRef },
        'PreferencesProviderImplementation',
      ],
      [
        { tag: REACT_19_TAGS.MemoComponent, elementType: selfWrapped, type: selfWrapped },
        undefined,
      ],
    ];

    for (const [component, expected] of cases) {
      const fiber = underAncestors(changedConsumer([context]), [provider19(context), component]);
      expect(onlyChange(fiber).provider).toBe(expected);
      if (expected !== undefined) {
        // The name `./react.ts` gives the same component's own render, which
        // is bippy's `getDisplayName` of its `elementType`. (Not asked of the
        // self-wrapped case: bippy's unwrapping has no bound.)
        expect(getDisplayName(component['elementType'])).toBe(expected);
      }
    }
  });

  it('cuts a very long provider name as an unmarked prefix', () => {
    const context = makeContextObject();
    const longName = 'Provider' + cycle(UPPER_LETTERS + LOWER_LETTERS, 600);
    const fiber = underAncestors(changedConsumer([context]), [
      provider19(context),
      componentFiber(REACT_19_TAGS, longName),
    ]);

    const provider = onlyChange(fiber).provider ?? '';

    // A prefix and never a marked one: the name has to equal the provider's
    // own `component` attribute, which `./react.ts` cuts the same way (its
    // suite asserts that equality against a real render).
    expect(provider.length).toBeGreaterThan(0);
    expect(provider.length).toBeLessThan(longName.length);
    expect(longName.startsWith(provider)).toBe(true);
  });

  it('finds a provider below a deep chain and stops on a chain no real tree has', () => {
    const context = makeContextObject();
    const deep = (hosts: number): Bag =>
      underAncestors(changedConsumer([context]), [
        ...Array.from({ length: hosts }, () => hostFiber(REACT_19_TAGS)),
        provider19(context),
        componentFiber(REACT_19_TAGS, 'PreferencesProvider'),
      ]);

    // Three hundred fibers between a consumer and its provider is deeper than
    // a framework router's layers make it in practice, and is still walked.
    expect(onlyChange(deep(300)).provider).toBe('PreferencesProvider');
    // Ten thousand is not a real tree; the walk's bound ends it first.
    expect('provider' in onlyChange(deep(10_000))).toBe(false);
  });

  it('terminates on a cyclic return chain', () => {
    const context = makeContextObject();
    const firstHost = hostFiber(REACT_19_TAGS);
    const secondHost = hostFiber(REACT_19_TAGS);
    firstHost['return'] = secondHost;
    secondHost['return'] = firstHost;
    const loopedProvider = provider19(context);
    const loopedHost = hostFiber(REACT_19_TAGS);
    loopedProvider['return'] = loopedHost;
    loopedHost['return'] = loopedProvider;

    // No provider on the first cycle, and a provider whose component never
    // comes on the second: both walks end at the bound instead of spinning.
    for (const head of [firstHost, loopedProvider]) {
      const consumer = changedConsumer([context]);
      consumer['return'] = head;
      expect('provider' in onlyChange(consumer)).toBe(false);
    }
  });

  it('never throws, and costs a hostile fiber only its own attribution', () => {
    const context = makeContextObject();
    const throwing = (): never => {
      throw new Error('a hostile getter must never escape the differ');
    };
    const withThrowing = (bag: Bag, key: string): Bag =>
      Object.defineProperty(bag, key, { enumerable: true, get: throwing });

    const hostileContext = withThrowing(makeContextObject(), 'displayName');
    const scenarios: readonly {
      readonly ancestors: readonly Bag[];
      readonly context: Bag;
      readonly provider: string | undefined;
    }[] = [
      // An unreadable `return` ends the walk with nothing found.
      {
        ancestors: [withThrowing(hostFiber(REACT_19_TAGS), 'return')],
        context,
        provider: undefined,
      },
      // An unreadable `tag` is "not a provider", and the walk goes on.
      {
        ancestors: [
          withThrowing({}, 'tag'),
          provider19(context),
          componentFiber(REACT_19_TAGS, 'PreferencesProvider'),
        ],
        context,
        provider: 'PreferencesProvider',
      },
      // A provider-tagged fiber whose `type` cannot be read provides nothing.
      {
        ancestors: [
          withThrowing({ tag: REACT_19_TAGS.ContextProvider }, 'type'),
          componentFiber(REACT_19_TAGS, 'AppRoot'),
        ],
        context,
        provider: undefined,
      },
      // An unreadable `elementType` falls back to a readable `type`.
      {
        ancestors: [
          provider19(context),
          withThrowing(componentFiber(REACT_19_TAGS, 'PreferencesProvider'), 'elementType'),
        ],
        context,
        provider: 'PreferencesProvider',
      },
      // A revoked Proxy in the chain throws for every read.
      { ancestors: [makeRevokedProxy() as Bag], context, provider: undefined },
      // A context whose `displayName` throws is still attributed by provider.
      {
        ancestors: [provider19(hostileContext), componentFiber(REACT_19_TAGS, 'AppRoot')],
        context: hostileContext,
        provider: 'AppRoot',
      },
    ];

    for (const scenario of scenarios) {
      const fiber = underAncestors(changedConsumer([scenario.context]), scenario.ancestors);
      let change: ContextChange | undefined;
      expect(() => {
        change = onlyChange(fiber);
      }).not.toThrow();
      expect(change?.provider).toBe(scenario.provider);
      expect(analyzeFiber(fiber).trigger).toBe('context');
    }
  });

  it('never reads the value a provider fiber holds', () => {
    const context = makeContextObject();
    const provider = provider19(context);
    let propsRead = false;
    Object.defineProperty(provider, 'memoizedProps', {
      enumerable: true,
      get: (): Bag => {
        propsRead = true;
        return { value: SECRET_TAIL };
      },
    });
    const fiber = underAncestors(changedConsumer([context]), [
      provider,
      componentFiber(REACT_19_TAGS, 'PreferencesProvider'),
    ]);

    const diff = analyzeFiber(fiber);

    expect(diff.contextChanges[0]?.provider).toBe('PreferencesProvider');
    expect(propsRead).toBe(false);
    expect(JSON.stringify(diff)).not.toContain(SECRET_TAIL);
  });

  it('carries the attribution through analyzeFiber, and none when nothing changed', () => {
    const context = makeContextObject('PreferencesContext');
    const ancestors = (): Bag[] => [
      provider19(context),
      componentFiber(REACT_19_TAGS, 'PreferencesProvider'),
    ];
    const value = { mode: 'compact' };

    const changed = analyzeFiber(underAncestors(changedConsumer([context]), ancestors()));
    expect(changed.trigger).toBe('context');
    expect(changed.contextChanges).toHaveLength(1);
    expect(changed.contextChanges[0]).toMatchObject({
      index: 0,
      label: 'PreferencesContext',
      provider: 'PreferencesProvider',
      contextName: 'PreferencesContext',
    });

    const unchanged = analyzeFiber(
      underAncestors(
        makeFiber({
          contexts: makeContextChain([{ context, value }]),
          prevContexts: makeContextChain([{ context, value }]),
        }),
        ancestors(),
      ),
    );
    expect(unchanged.trigger).toBe('unchanged');
    expect(unchanged.contextChanges).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// classifyRenderTrigger
//
// The precedence rules of AAP 0.7.1, asserted twice over: once on the
// classifier in isolation, where the inputs can be stated exactly, and once
// end to end through `analyzeFiber` on a synthetic fiber, where they have to
// survive the three comparisons that produce them.
// ---------------------------------------------------------------------------

/** A stand-in summary: the classifier never looks inside a change. */
const STUB_SUMMARY: ValueSummary = { type: 'number', preview: '1' };

/** Every dimension compared successfully. */
const ALL_EVALUABLE: FiberDiff['evaluable'] = { props: true, state: true, context: true };

/** How many changes each dimension found. */
interface ChangeCounts {
  readonly props: number;
  readonly state: number;
  readonly context: number;
}

/** Runs the classifier on stated inputs rather than on a fiber. */
function classify(counts: ChangeCounts, evaluable: FiberDiff['evaluable']): RenderTrigger {
  return classifyRenderTrigger({
    propChanges: Array.from({ length: counts.props }, (_unused, index) => ({
      key: 'prop' + String(index),
      from: STUB_SUMMARY,
      to: STUB_SUMMARY,
    })),
    hookChanges: Array.from({ length: counts.state }, (_unused, index) => ({
      index,
      from: STUB_SUMMARY,
      to: STUB_SUMMARY,
    })),
    contextChanges: Array.from({ length: counts.context }, (_unused, index) => ({
      index,
      from: STUB_SUMMARY,
      to: STUB_SUMMARY,
    })),
    evaluable,
  });
}

/** One row of the classification matrix. */
interface TriggerCase {
  /** What the render looked like. */
  readonly label: string;
  /** The change counts the dimensions reported. */
  readonly counts: ChangeCounts;
  /** Which dimensions could be compared. */
  readonly evaluable: FiberDiff['evaluable'];
  /** The one value the classifier may return. */
  readonly expected: RenderTrigger;
}

const TRIGGER_MATRIX: readonly TriggerCase[] = [
  {
    label: 'only props changed',
    counts: { props: 1, state: 0, context: 0 },
    evaluable: ALL_EVALUABLE,
    expected: 'props',
  },
  {
    label: 'only own hook state changed',
    counts: { props: 0, state: 1, context: 0 },
    evaluable: ALL_EVALUABLE,
    expected: 'state',
  },
  {
    label: 'only a consumed context value changed',
    counts: { props: 0, state: 0, context: 1 },
    evaluable: ALL_EVALUABLE,
    expected: 'context',
  },
  {
    label: 'nothing changed and all three dimensions were evaluated',
    counts: { props: 0, state: 0, context: 0 },
    evaluable: ALL_EVALUABLE,
    expected: 'unchanged',
  },
  {
    label: 'nothing changed but the context dimension was unevaluable',
    counts: { props: 0, state: 0, context: 0 },
    evaluable: { props: true, state: true, context: false },
    expected: 'unknown',
  },
  {
    label: 'nothing changed but the props dimension was unevaluable',
    counts: { props: 0, state: 0, context: 0 },
    evaluable: { props: false, state: true, context: true },
    expected: 'unknown',
  },
  {
    label: 'nothing changed but the state dimension was unevaluable',
    counts: { props: 0, state: 0, context: 0 },
    evaluable: { props: true, state: false, context: true },
    expected: 'unknown',
  },
  {
    label: 'no dimension could be evaluated at all',
    counts: { props: 0, state: 0, context: 0 },
    evaluable: { props: false, state: false, context: false },
    expected: 'unknown',
  },
  {
    label: 'props changed while the context dimension was unevaluable',
    counts: { props: 1, state: 0, context: 0 },
    evaluable: { props: true, state: true, context: false },
    expected: 'props',
  },
  {
    label: 'state changed while the props dimension was unevaluable',
    counts: { props: 0, state: 1, context: 0 },
    evaluable: { props: false, state: true, context: true },
    expected: 'state',
  },
  {
    label: 'props and state both changed',
    counts: { props: 1, state: 1, context: 0 },
    evaluable: ALL_EVALUABLE,
    expected: 'props',
  },
  {
    label: 'state and context both changed',
    counts: { props: 0, state: 1, context: 1 },
    evaluable: ALL_EVALUABLE,
    expected: 'state',
  },
  {
    label: 'all three changed',
    counts: { props: 2, state: 2, context: 2 },
    evaluable: ALL_EVALUABLE,
    expected: 'props',
  },
];

describe('classifyRenderTrigger', () => {
  it.each(TRIGGER_MATRIX)('classifies $label as $expected', ({ counts, evaluable, expected }) => {
    const trigger = classify(counts, evaluable);

    expect(trigger).toBe(expected);
    // The catalog vocabulary is the contract with every consumer: a trigger
    // outside it would reach a panel that cannot render it.
    expect(RENDER_TRIGGERS).toContain(trigger);
  });

  it('never returns unchanged unless all three dimensions were evaluated', () => {
    const dimensions: readonly (keyof FiberDiff['evaluable'])[] = ['props', 'state', 'context'];

    for (const dimension of dimensions) {
      const trigger = classify(
        { props: 0, state: 0, context: 0 },
        { ...ALL_EVALUABLE, [dimension]: false },
      );

      // This is what keeps `unchanged_render_count` meaning what AAP 0.2.3
      // says it means, and what sends an unobservable render to
      // `render_trigger_unknown_count` instead.
      expect(trigger).not.toBe('unchanged');
      expect(trigger).toBe('unknown');
    }
  });

  it('covers the whole catalog vocabulary', () => {
    const produced = new Set(TRIGGER_MATRIX.map((row) => row.expected));

    // A value the matrix never produces is a value nothing asserts about.
    for (const trigger of RENDER_TRIGGERS) {
      expect(produced).toContain(trigger);
    }
  });

  it('classifies an empty truncated scan as unknown, on what the dimension reports', () => {
    // The matrix above states evaluability directly, which proves the
    // classifier but not the hand-off. This case takes the flags from a real
    // overflowed comparison instead: `diffProps` reports a dimension it could
    // not finish as unevaluable, so an empty truncated scan arrives here as
    // `unknown` rather than as `unchanged`.
    const props = diffProps(makeFiber(makeLateChangedProps()));

    const trigger = classifyRenderTrigger({
      propChanges: props.changed,
      hookChanges: [],
      contextChanges: [],
      evaluable: { props: props.evaluable, state: true, context: true },
    });

    expect(props.truncated).toBe(true);
    expect(props.changed).toStrictEqual([]);
    expect(trigger).not.toBe('unchanged');
    expect(trigger).toBe('unknown');
  });

  it('still names the dimension that overflowed but found a change', () => {
    // The other half of the rule: truncation makes a dimension incomplete, not
    // silent. A change the capped scan did see explains the render, so it
    // outranks the unknown its own incompleteness would otherwise produce.
    const props = diffProps(makeFiber(makeChangingProps(MAX_TRACKED_KEYS + 1)));

    const trigger = classifyRenderTrigger({
      propChanges: props.changed,
      hookChanges: [],
      contextChanges: [],
      evaluable: { props: props.evaluable, state: true, context: true },
    });

    expect(props.truncated).toBe(true);
    expect(props.evaluable).toBe(false);
    expect(props.changed.length).toBeGreaterThan(0);
    expect(trigger).toBe('props');
  });
});

// ---------------------------------------------------------------------------
// analyzeFiber
// ---------------------------------------------------------------------------

/** A context object used by the end-to-end fiber fixtures. */
const ETA_CONTEXT: Bag = { displayName: 'ShippingEta', _currentValue: { etaMinutes: 1 } };

/** One end-to-end classification case, built from a real synthetic fiber. */
interface FiberTriggerCase {
  readonly label: string;
  readonly make: () => unknown;
  readonly expected: RenderTrigger;
}

const FIBER_TRIGGER_CASES: readonly FiberTriggerCase[] = [
  {
    label: 'a render whose props changed',
    make: (): unknown => makeFiber({ props: { count: 2 }, prevProps: { count: 1 } }),
    expected: 'props',
  },
  {
    label: 'a render whose own hook state changed',
    make: (): unknown =>
      makeFiber({
        props: { count: 1 },
        hooks: makeHookChain([2]),
        prevHooks: makeHookChain([1]),
      }),
    expected: 'state',
  },
  {
    label: 'a render whose consumed context value changed',
    make: (): unknown =>
      makeFiber({
        props: { count: 1 },
        contexts: makeContextChain([{ context: ETA_CONTEXT, value: { etaMinutes: 2 } }]),
        prevContexts: makeContextChain([{ context: ETA_CONTEXT, value: { etaMinutes: 3 } }]),
      }),
    expected: 'context',
  },
  {
    label: 'a re-render with stable inputs',
    make: (): unknown => makeFiber({ props: { count: 1, label: 'cart' } }),
    expected: 'unchanged',
  },
  {
    label: 'a render whose context history is unavailable',
    make: (): unknown => ({
      memoizedProps: { count: 1 },
      memoizedState: null,
      dependencies: makeContextChain([{ context: ETA_CONTEXT, value: 1 }]),
      alternate: { memoizedProps: { count: 1 }, memoizedState: null, dependencies: null },
    }),
    expected: 'unknown',
  },
  {
    label: 'a mount',
    make: (): unknown => makeFiber({ props: { count: 1 }, withAlternate: false }),
    expected: 'unknown',
  },
  {
    label: 'a render whose props changed while its context history is unavailable',
    make: (): unknown => ({
      memoizedProps: { count: 2 },
      memoizedState: null,
      dependencies: makeContextChain([{ context: ETA_CONTEXT, value: 1 }]),
      alternate: { memoizedProps: { count: 1 }, memoizedState: null, dependencies: null },
    }),
    expected: 'props',
  },
  {
    label: 'a render whose props and hook state both changed',
    make: (): unknown =>
      makeFiber({
        props: { count: 2 },
        prevProps: { count: 1 },
        hooks: makeHookChain([2]),
        prevHooks: makeHookChain([1]),
      }),
    expected: 'props',
  },
  {
    label: 'a render whose only changed prop sits past the tracked-key bound',
    make: (): unknown => makeFiber(makeLateChangedProps()),
    expected: 'unknown',
  },
  {
    label: 'a render with a visible prop change and more props than the bound allows',
    make: (): unknown => makeFiber(makeChangingProps(MAX_TRACKED_KEYS + 1)),
    expected: 'props',
  },
];

/**
 * A fiber exercising all three dimensions at once, with more props and more
 * hooks than the tracked-key bound allows.
 */
function makeRichFiber(): Bag {
  const props: Bag = {};
  const prevProps: Bag = {};
  for (let index = 0; index < MAX_TRACKED_KEYS + 4; index += 1) {
    const key = 'field' + String(index).padStart(2, '0');
    prevProps[key] = index;
    props[key] = index % 2 === 0 ? index : index + 1;
  }
  return makeFiber({
    props,
    prevProps,
    hooks: makeHookChain([{ items: 2 }, 'checkout']),
    prevHooks: makeHookChain([{ items: 1 }, 'checkout']),
    contexts: makeContextChain([{ context: ETA_CONTEXT, value: { etaMinutes: 2 } }]),
    prevContexts: makeContextChain([{ context: ETA_CONTEXT, value: { etaMinutes: 5 } }]),
  });
}

describe('analyzeFiber', () => {
  it.each(FIBER_TRIGGER_CASES)('classifies $label as $expected', ({ make, expected }) => {
    const diff = analyzeFiber(make());

    expect(diff.trigger).toBe(expected);
    expect(RENDER_TRIGGERS).toContain(diff.trigger);
    expectTransportable(diff);
  });

  it('reports a result consistent with the three dimensions it composed', () => {
    const fiber = makeRichFiber();

    const diff = analyzeFiber(fiber);
    const props = diffProps(fiber);
    const hooks = diffHookState(fiber);
    const contexts = diffContexts(fiber);

    expect(diff.propChanges).toStrictEqual(props.changed);
    expect(diff.hookChanges).toStrictEqual(hooks.changed);
    expect(diff.contextChanges).toStrictEqual(contexts.changed);
    // `changedProps` is the plain key list the render event carries; it must
    // name exactly the transitions behind it, in the same order.
    expect(diff.changedProps).toStrictEqual(props.changed.map((change) => change.key));
    expect(diff.evaluable).toStrictEqual({
      props: props.evaluable,
      state: hooks.evaluable,
      context: contexts.evaluable,
    });
    expect(diff.truncated).toBe(props.truncated || hooks.truncated || contexts.truncated);
    expect(diff.truncated).toBe(true);
    expect(diff.trigger).toBe(
      classifyRenderTrigger({
        propChanges: props.changed,
        hookChanges: hooks.changed,
        contextChanges: contexts.changed,
        evaluable: diff.evaluable,
      }),
    );
  });

  it('never reports unchanged for a render whose evidence was cut off by a bound', () => {
    const diff = analyzeFiber(makeFiber(makeLateChangedProps()));

    // End to end, through the three real comparisons: a prop changed past
    // `MAX_TRACKED_KEYS`, nothing else did, and the capped scan saw none of
    // it. `unchanged` here would put the render into `unchanged_render_count`
    // — "props shallow-equal, own hook state unchanged and no consumed
    // context value changed" — on the strength of a prop that was never read,
    // so it belongs in `render_trigger_unknown_count` instead (AAP 0.2.3).
    expect(diff.trigger).not.toBe('unchanged');
    expect(diff.trigger).toBe('unknown');
    expect(diff.changedProps).toStrictEqual([]);
    expect(diff.truncated).toBe(true);
    // Only the dimension that overflowed loses its claim; the other two were
    // compared in full and say so, which is what keeps `truncated` readable as
    // "this one was cut off" rather than "something somewhere was".
    expect(diff.evaluable).toStrictEqual({ props: false, state: true, context: true });
  });

  it('keeps a change the capped scan did see, even though the dimension is incomplete', () => {
    const diff = analyzeFiber(makeFiber(makeChangingProps(MAX_TRACKED_KEYS + 1)));

    expect(diff.trigger).toBe('props');
    expect(diff.changedProps).toHaveLength(MAX_TRACKED_KEYS);
    expect(diff.truncated).toBe(true);
    expect(diff.evaluable.props).toBe(false);
    expectTransportable(diff);
  });

  it('leaves the fiber and its alternate exactly as it found them', () => {
    const fiber = makeRichFiber();
    const before = structuralSnapshot(fiber);

    analyzeFiber(fiber);

    // The differ reads the developer's live fiber tree during a commit.
    // Writing anything back — a cached diff, a marker, a normalised prop —
    // would change the behaviour of the application under observation.
    expect(structuralSnapshot(fiber)).toStrictEqual(before);
  });

  it('does not share mutable state between results', () => {
    const first = analyzeFiber(null);
    const second = analyzeFiber(null);

    first.changedProps.push('mutated');

    // Each call allocates its own arrays, so a consumer that appends to one
    // result cannot reach into another's.
    expect(second.changedProps).toStrictEqual([]);
    expect(first).not.toBe(second);
  });

  it.each([
    { label: 'null', make: (): unknown => null },
    { label: 'undefined', make: (): unknown => undefined },
    { label: 'a number', make: (): unknown => 7 },
    { label: 'a string', make: (): unknown => 'fiber' },
    { label: 'a revoked proxy', make: makeRevokedProxy },
    { label: 'an object of throwing getters', make: makeThrowingGetter },
  ])('degrades to an unknown diff for $label', ({ make }) => {
    const diff = analyzeFiber(make());

    // "The debugger threw inside a commit" is the one outcome this module may
    // never produce; an honest "could not be analysed" is what it produces
    // instead, and it keeps the render out of `unchanged_render_count`.
    expect(diff).toStrictEqual({
      trigger: 'unknown',
      changedProps: [],
      propChanges: [],
      hookChanges: [],
      contextChanges: [],
      changedContexts: [],
      evaluable: { props: false, state: false, context: false },
      truncated: false,
    });
  });

  it('makes a mount indistinguishable from an unanalysable fiber, which is why phase decides', () => {
    const mount = analyzeFiber(makeFiber({ props: { count: 1 }, withAlternate: false }));

    // A mount has no alternate, so all three dimensions are unevaluable and
    // the diff is byte-identical to the one an unanalysable fiber produces.
    // Nothing in this result can tell the two apart, which is exactly why
    // `../browser/react.ts` must decide from the render's `phase` and OMIT the
    // `trigger` attribute for a mount: a mount's cause is not in doubt, and
    // emitting this `unknown` would inflate `render_trigger_unknown_count`
    // with the one case nobody needs explained (AAP 0.2.3).
    expect(mount).toStrictEqual(analyzeFiber(null));
    expect(mount.trigger).toBe('unknown');
    expect(mount.evaluable).toStrictEqual({ props: false, state: false, context: false });
  });

  it.each(ADVERSARIAL_VALUES)(
    'survives $label in a prop slot and stays transportable',
    ({ make }) => {
      // The baseline is a fresh object, so the prop changes for every value in
      // the catalogue — including `null`, `undefined` and `NaN`, each of which
      // would compare equal to a fixed baseline of its own kind.
      const baseline = { baseline: true };
      const diff = analyzeFiber(
        makeFiber({
          props: { payload: make(), count: 2 },
          prevProps: { payload: baseline, count: 1 },
        }),
      );

      expect(diff.trigger).toBe('props');
      expect(diff.changedProps).toContain('payload');
      expectTransportable(diff);
      for (const forbidden of NEVER_TRAVELS) {
        expect(JSON.stringify(diff)).not.toContain(forbidden);
      }
    },
  );

  it.each(ADVERSARIAL_VALUES)(
    'survives $label in a hook slot and stays transportable',
    ({ make }) => {
      const diff = analyzeFiber(
        makeFiber({
          props: { count: 1 },
          hooks: makeHookChain([make()]),
          prevHooks: makeHookChain(['initial']),
        }),
      );

      expect(RENDER_TRIGGERS).toContain(diff.trigger);
      expectTransportable(diff);
      for (const forbidden of NEVER_TRAVELS) {
        expect(JSON.stringify(diff)).not.toContain(forbidden);
      }
    },
  );

  it.each(SECRET_CASES)('never carries $label out of a prop slot', ({ value }) => {
    // An ordinary prop name, so the credential has to be caught by content
    // rather than by the name rule: this is the path a credential that arrived
    // in a response payload takes.
    const diff = analyzeFiber(
      makeFiber({ props: { lastResponse: value }, prevProps: { lastResponse: 'anonymous' } }),
    );

    const encoded = JSON.stringify(diff);
    expect(diff.trigger).toBe('props');
    expect(encoded).not.toContain(SECRET_TAIL);
    expect(encoded).toContain(REDACTION_MARKER);
  });
});

// ---------------------------------------------------------------------------
// Capture now, analyse later
//
// `./react.ts` no longer analyses a fiber inside React's commit: it calls
// `captureFiber` there — a handful of guarded pointer reads — and runs
// `analyzeCapturedFiber` from an idle slice afterwards. The suites below pin
// the three properties that split rests on:
//
// - **Equivalence.** The deferred answer classifies every fiber exactly as the
//   synchronous `analyzeFiber` does, so moving the work changed when it runs
//   and nothing about what `render_count`, `unchanged_render_count` and
//   `render_trigger_unknown_count` report.
// - **Deferral is safe.** After the commit, React reuses the alternate as the
//   next work-in-progress and detaches a deleted fiber's fields. A capture
//   holds the objects the commit held, so neither rewrite reaches it.
// - **Less description.** The render path composes no prop preview, and hook
//   and context previews only on request, through a per-pass memo.
// ---------------------------------------------------------------------------

/** What {@link analyzeFiber} reports minus the prop summaries the render path never composes. */
function renderPathOf(diff: FiberDiff): RenderAnalysis {
  return {
    trigger: diff.trigger,
    changedProps: diff.changedProps,
    hookChanges: diff.hookChanges,
    contextChanges: diff.contextChanges,
    changedContexts: diff.changedContexts,
    evaluable: diff.evaluable,
    truncated: diff.truncated,
  };
}

/** A fiber input for the capture suites, named so a failure says which shape broke. */
interface CaptureCase {
  /** What the fiber exercises. */
  readonly label: string;
  /** Builds the fiber fresh, so no case can leak state into another. */
  readonly make: () => unknown;
}

/**
 * Every fiber shape the equivalence suite sweeps: the trigger catalogue, the
 * three bounds, each hook kind, cyclic chains, the identical-props fast path
 * and every unanalysable input.
 */
const CAPTURE_CASES: readonly CaptureCase[] = [
  ...FIBER_TRIGGER_CASES.map(({ label, make }) => ({ label, make })),
  { label: 'a fiber changing all three dimensions past the key bound', make: makeRichFiber },
  {
    label: 'more changed hooks than the bound',
    make: (): unknown => makeFiber({ ...makeChangingHooks(MAX_TRACKED_KEYS + 2) }),
  },
  {
    label: 'more changed contexts than the bound',
    make: (): unknown => makeFiber({ ...makeChangingContexts(MAX_TRACKED_KEYS + 2, 'all') }),
  },
  {
    label: 'one changed context among many',
    make: (): unknown => makeFiber({ ...makeChangingContexts(6, 3) }),
  },
  {
    label: 'a changed reducer hook',
    make: (): unknown =>
      makeFiber({ hooks: makeReducerHookChain([2]), prevHooks: makeReducerHookChain([1]) }),
  },
  {
    label: 'a changed effect hook',
    make: (): unknown =>
      makeFiber({ hooks: makeEffectHookChain([2]), prevHooks: makeEffectHookChain([1]) }),
  },
  {
    label: 'a changed ref hook',
    make: (): unknown =>
      makeFiber({ hooks: makeRefHookChain([2]), prevHooks: makeRefHookChain([1]) }),
  },
  {
    label: 'a changed memo hook',
    make: (): unknown =>
      makeFiber({ hooks: makeMemoHookChain([2]), prevHooks: makeMemoHookChain([1]) }),
  },
  {
    label: 'cyclic hook chains',
    make: (): unknown =>
      makeFiber({
        hooks: closeChain(makeHookChain(['a', 'b'])),
        prevHooks: closeChain(makeHookChain(['a', 'c'])),
      }),
  },
  {
    label: 'the same props object on both sides',
    make: (): unknown => {
      const props: Bag = { count: 1 };
      return { memoizedProps: props, alternate: { memoizedProps: props } };
    },
  },
  {
    label: 'a fiber whose alternate getter throws',
    make: (): unknown =>
      Object.defineProperty({ memoizedProps: { count: 1 } }, 'alternate', {
        enumerable: true,
        get(): never {
          throw new Error('an alternate the differ must survive');
        },
      }),
  },
  {
    label: 'an alternate whose memoizedProps getter throws',
    make: (): unknown => ({
      memoizedProps: { count: 1 },
      alternate: Object.defineProperty({}, 'memoizedProps', {
        enumerable: true,
        get(): never {
          throw new Error('previous props the differ must survive');
        },
      }),
    }),
  },
  {
    label: 'dependencies without a firstContext',
    make: (): unknown =>
      makeFiber({ props: { count: 1 }, contexts: {}, prevContexts: { firstContext: null } }),
  },
  { label: 'null', make: (): unknown => null },
  { label: 'a number', make: (): unknown => 7 },
  { label: 'a revoked proxy', make: makeRevokedProxy },
  { label: 'an object of throwing getters', make: makeThrowingGetter },
];

/**
 * Rewrites a captured fiber the way React does after its commit returns: the
 * alternate becomes the next render's work-in-progress (new props, a new hook
 * list, its context chain reset by `prepareToReadContext`), and a deletion
 * detaches the committed fiber's own fields.
 */
function simulateReuseAndDeletion(fiber: Bag): void {
  const alternate = fiber['alternate'];
  if (typeof alternate === 'object' && alternate !== null) {
    const reused = alternate as Bag;
    reused['memoizedProps'] = { rewritten: true };
    reused['memoizedState'] = makeHookChain(['rewritten']);
    const dependencies = reused['dependencies'];
    if (typeof dependencies === 'object' && dependencies !== null) {
      (dependencies as Bag)['firstContext'] = null;
    }
  }
  const dependencies = fiber['dependencies'];
  if (typeof dependencies === 'object' && dependencies !== null) {
    (dependencies as Bag)['firstContext'] = null;
  }
  fiber['memoizedProps'] = null;
  fiber['memoizedState'] = null;
  fiber['dependencies'] = null;
  fiber['alternate'] = null;
}

/**
 * An object with one enumerable getter that counts its reads.
 *
 * Summarising an object previews its keys by reading them, so a read count of
 * zero is a behavioural proof that no summary was composed for the value.
 */
function makeCountingValue(): { readonly value: Bag; readonly reads: () => number } {
  let reads = 0;
  const value: Bag = {};
  Object.defineProperty(value, 'probe', {
    enumerable: true,
    get(): number {
      reads += 1;
      return reads;
    },
  });
  return { value, reads: () => reads };
}

/** Keys every {@link RenderAnalysis} carries, and the only ones. */
const RENDER_ANALYSIS_KEYS = [
  'changedContexts',
  'changedProps',
  'contextChanges',
  'evaluable',
  'hookChanges',
  'trigger',
  'truncated',
];

describe('captureFiber', () => {
  it('records the six pointers the commit held, by identity', () => {
    const fiber = makeRichFiber();
    const alternate = fiber['alternate'] as Bag;

    const captured = captureFiber(fiber);

    expect(captured.hasAlternate).toBe(true);
    expect(captured.nextProps).toBe(fiber['memoizedProps']);
    expect(captured.previousProps).toBe(alternate['memoizedProps']);
    expect(captured.nextHooks).toBe(fiber['memoizedState']);
    expect(captured.previousHooks).toBe(alternate['memoizedState']);
    // The chain head rather than the `dependencies` object: React resets
    // `dependencies.firstContext` on the object it reuses, so only the head
    // still names the contexts this render read.
    expect(captured.nextContexts).toBe((fiber['dependencies'] as Bag)['firstContext']);
    expect(captured.previousContexts).toBe((alternate['dependencies'] as Bag)['firstContext']);
  });

  it('shares one frozen record across every mount', () => {
    const first = captureFiber(makeFiber({ props: { count: 1 }, withAlternate: false }));
    const second = captureFiber(makeFiber({ props: { count: 2 }, withAlternate: false }));

    // A commit that mounts a whole page captures one record per fiber on the
    // commit path; a mount has nothing worth pointing at, so it allocates none.
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toStrictEqual({
      hasAlternate: false,
      nextProps: undefined,
      previousProps: undefined,
      nextHooks: undefined,
      previousHooks: undefined,
      nextContexts: undefined,
      previousContexts: undefined,
    });
  });

  it.each(CAPTURE_CASES)('never throws for $label', ({ make }) => {
    const fiber = make();

    expect(() => captureFiber(fiber)).not.toThrow();
    expect(typeof captureFiber(fiber).hasAlternate).toBe('boolean');
  });

  it('leaves the fiber and its alternate exactly as it found them', () => {
    const fiber = makeRichFiber();
    const before = structuralSnapshot(fiber);

    analyzeCapturedFiber(captureFiber(fiber), { transitions: true, memo: createSummaryMemo() });

    expect(structuralSnapshot(fiber)).toStrictEqual(before);
  });
});

describe('analyzeCapturedFiber', () => {
  it.each(CAPTURE_CASES)(
    'classifies $label exactly as analyzeFiber does, transitions included',
    ({ make }) => {
      const fiber = make();
      const expected = renderPathOf(analyzeFiber(fiber));

      const analysis = analyzeCapturedFiber(captureFiber(fiber), { transitions: true });

      expect(analysis).toStrictEqual(expected);
      expect(RENDER_TRIGGERS).toContain(analysis.trigger);
      expectTransportable(analysis);
    },
  );

  it.each(CAPTURE_CASES)(
    'classifies $label identically without describing a transition',
    ({ make }) => {
      const fiber = make();
      const expected = analyzeFiber(fiber);

      const analysis = analyzeCapturedFiber(captureFiber(fiber));

      // Without `transitions` the changes are counted, which is all the
      // trigger needs, and described nowhere: an empty list here means "not
      // summarised", and `trigger` is what says whether anything changed.
      expect(analysis.trigger).toBe(expected.trigger);
      expect(analysis.changedProps).toStrictEqual(expected.changedProps);
      expect(analysis.evaluable).toStrictEqual(expected.evaluable);
      expect(analysis.truncated).toBe(expected.truncated);
      expect(analysis.hookChanges).toStrictEqual([]);
      expect(analysis.contextChanges).toStrictEqual([]);
      expectTransportable(analysis);
    },
  );

  it.each(CAPTURE_CASES)(
    'reports the commit it captured for $label after React reuses and detaches the fiber',
    ({ make }) => {
      const fiber = make();
      const atCommit = renderPathOf(analyzeFiber(fiber));
      const captured = captureFiber(fiber);

      if (typeof fiber === 'object' && fiber !== null) {
        try {
          simulateReuseAndDeletion(fiber as Bag);
        } catch {
          // A hostile fiber (a revoked proxy, a throwing accessor) cannot be
          // rewritten, which is fine: its capture is already unevaluable.
        }
      }

      expect(analyzeCapturedFiber(captured, { transitions: true })).toStrictEqual(atCommit);
    },
  );

  it('keeps the classification but reflects an in-place mutation in a preview', () => {
    // The documented limit of deferral: a capture holds the value *objects* the
    // commit held, so identity — and with it every trigger — is exactly the
    // commit's. A preview is composed from the object as it is when analysed,
    // so a page that mutates a context value in place between its commit and
    // the idle slice shows the mutated keys.
    const value: Bag = { etaMinutes: 2 };
    const fiber = makeFiber({
      contexts: makeContextChain([{ context: ETA_CONTEXT, value }]),
      prevContexts: makeContextChain([{ context: ETA_CONTEXT, value: { etaMinutes: 5 } }]),
    });
    const captured = captureFiber(fiber);

    value['carrier'] = 'ground';
    const analysis = analyzeCapturedFiber(captured, { transitions: true });

    expect(analysis.trigger).toBe('context');
    expect(analysis.contextChanges[0]?.to.preview).toContain('carrier');
  });

  it('carries no prop summaries at all', () => {
    const analysis = analyzeCapturedFiber(captureFiber(makeRichFiber()), { transitions: true });

    expect(Object.keys(analysis).sort()).toStrictEqual(RENDER_ANALYSIS_KEYS);
    expect(analysis).not.toHaveProperty('propChanges');
  });

  it('never reads a changed prop value, with or without transitions', () => {
    const counting = makeCountingValue();
    const make = (): Bag =>
      makeFiber({ props: { payload: counting.value }, prevProps: { payload: { before: true } } });

    const quiet = analyzeCapturedFiber(captureFiber(make()));
    const described = analyzeCapturedFiber(captureFiber(make()), { transitions: true });

    // A prop is compared by identity and reported by name; its value is never
    // previewed on the render path, so its getter never runs.
    expect(quiet.changedProps).toStrictEqual(['payload']);
    expect(described.changedProps).toStrictEqual(['payload']);
    expect(counting.reads()).toBe(0);

    // The synchronous analysis does preview it, which is the work deferral
    // stopped doing.
    analyzeFiber(make());
    expect(counting.reads()).toBeGreaterThan(0);
  });

  it('previews a hook value only when transitions are requested', () => {
    const counting = makeCountingValue();
    const make = (): Bag =>
      makeFiber({
        props: { count: 1 },
        hooks: makeHookChain([counting.value]),
        prevHooks: makeHookChain(['initial']),
      });

    const quiet = analyzeCapturedFiber(captureFiber(make()));

    expect(quiet.trigger).toBe('state');
    expect(quiet.hookChanges).toStrictEqual([]);
    expect(counting.reads()).toBe(0);

    const described = analyzeCapturedFiber(captureFiber(make()), { transitions: true });

    expect(described.trigger).toBe('state');
    expect(described.hookChanges).toHaveLength(1);
    expect(counting.reads()).toBeGreaterThan(0);
  });

  it('previews a context value only when transitions are requested', () => {
    const counting = makeCountingValue();
    const make = (): Bag =>
      makeFiber({
        contexts: makeContextChain([{ context: ETA_CONTEXT, value: counting.value }]),
        prevContexts: makeContextChain([{ context: ETA_CONTEXT, value: { etaMinutes: 5 } }]),
      });

    const quiet = analyzeCapturedFiber(captureFiber(make()));

    expect(quiet.trigger).toBe('context');
    expect(quiet.contextChanges).toStrictEqual([]);
    expect(counting.reads()).toBe(0);

    const described = analyzeCapturedFiber(captureFiber(make()), { transitions: true });

    expect(described.contextChanges).toHaveLength(1);
    expect(described.contextChanges[0]?.label).toBe('ShippingEta');
    expect(counting.reads()).toBeGreaterThan(0);
  });

  it.each(SECRET_CASES)('carries no trace of $label from a prop slot', ({ value }) => {
    const analysis = analyzeCapturedFiber(
      captureFiber(
        makeFiber({ props: { lastResponse: value }, prevProps: { lastResponse: 'anonymous' } }),
      ),
      { transitions: true },
    );

    // Not a redacted preview: no preview at all. The prop's name is the only
    // thing about it the render path reports.
    const encoded = JSON.stringify(analysis);
    expect(analysis.trigger).toBe('props');
    expect(analysis.changedProps).toStrictEqual(['lastResponse']);
    expect(encoded).not.toContain(SECRET_TAIL);
    expect(encoded).not.toContain(REDACTION_MARKER);
  });

  it.each(SECRET_CASES)('redacts $label from a described hook transition', ({ value }) => {
    const analysis = analyzeCapturedFiber(
      captureFiber(
        makeFiber({ hooks: makeHookChain([value]), prevHooks: makeHookChain(['anonymous']) }),
      ),
      { transitions: true, memo: createSummaryMemo() },
    );

    const encoded = JSON.stringify(analysis);
    expect(analysis.trigger).toBe('state');
    expect(encoded).not.toContain(SECRET_TAIL);
    expect(encoded).toContain(REDACTION_MARKER);
  });

  it('degrades to an unknown, unevaluable answer for a capture that defeats every read', () => {
    const hostile: CapturedFiber = {
      hasAlternate: true,
      nextProps: makeRevokedProxy(),
      previousProps: makeRevokedProxy(),
      nextHooks: makeRevokedProxy(),
      previousHooks: makeRevokedProxy(),
      nextContexts: makeRevokedProxy(),
      previousContexts: makeRevokedProxy(),
    };

    const analysis = analyzeCapturedFiber(hostile, { transitions: true });

    expect(analysis.trigger).toBe('unknown');
    expect(analysis.changedProps).toStrictEqual([]);
    expect(analysis.evaluable.props).toBe(false);
    expectTransportable(analysis);
  });
});

describe('createSummaryMemo', () => {
  /** A fiber whose one consumed context changed to `value`. */
  function makeConsumer(value: unknown): Bag {
    return makeFiber({
      contexts: makeContextChain([{ context: ETA_CONTEXT, value }]),
      prevContexts: makeContextChain([{ context: ETA_CONTEXT, value: { etaMinutes: 5 } }]),
    });
  }

  it('summarises a value shared by many consumers once per pass', () => {
    // The demo's cart provider publishes one value object that close to a
    // hundred consumers report as a changed context in the same commit.
    const shared: Bag = { items: 3, subtotalCents: 12900 };
    const memo = createSummaryMemo();

    const analyses = Array.from({ length: 5 }, () =>
      analyzeCapturedFiber(captureFiber(makeConsumer(shared)), { transitions: true, memo }),
    );

    const first = analyses[0]?.contextChanges[0]?.to;
    expect(first).toBeDefined();
    for (const analysis of analyses) {
      expect(analysis.contextChanges[0]?.to).toBe(first);
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toStrictEqual(summarizeValue(shared));
  });

  it('keys by identity, never by appearance', () => {
    const memo = createSummaryMemo();

    const one = analyzeCapturedFiber(captureFiber(makeConsumer({ items: 3 })), {
      transitions: true,
      memo,
    });
    const other = analyzeCapturedFiber(captureFiber(makeConsumer({ items: 3 })), {
      transitions: true,
      memo,
    });

    // Two equal-looking objects are two values: a page may mutate either one.
    expect(one.contextChanges[0]?.to).not.toBe(other.contextChanges[0]?.to);
    expect(one.contextChanges[0]?.to).toStrictEqual(other.contextChanges[0]?.to);
  });

  it('composes afresh for every analysis when no memo is passed', () => {
    const shared: Bag = { items: 3 };

    const one = analyzeCapturedFiber(captureFiber(makeConsumer(shared)), { transitions: true });
    const other = analyzeCapturedFiber(captureFiber(makeConsumer(shared)), { transitions: true });

    expect(one.contextChanges[0]?.to).not.toBe(other.contextChanges[0]?.to);
    expect(one.contextChanges[0]?.to).toStrictEqual(other.contextChanges[0]?.to);
  });

  it('never remembers a prop, which is summarised under its name if at all', () => {
    const memo = createSummaryMemo();

    analyzeCapturedFiber(
      captureFiber(makeFiber({ props: { count: 2 }, prevProps: { count: 1 } })),
      { transitions: true, memo },
    );

    expect(memo.summaries.size).toBe(0);
  });

  it('stays usable when the page has broken Map', () => {
    /** A Map whose lookup throws, as a page that patched `Map.prototype.get` would. */
    class BrokenMap extends Map<unknown, ValueSummary> {
      override get(): never {
        throw new Error('a Map the memo must survive');
      }
    }
    const broken: SummaryMemo = { summaries: new BrokenMap() };
    const shared: Bag = { items: 3 };

    const analysis = analyzeCapturedFiber(captureFiber(makeConsumer(shared)), {
      transitions: true,
      memo: broken,
    });

    expect(analysis.trigger).toBe('context');
    expect(analysis.contextChanges[0]?.to).toStrictEqual(summarizeValue(shared));
  });

  it('stops remembering at its ceiling while still summarising every value', () => {
    // `MAX_MEMOIZED_SUMMARIES` in `./fiber-diff.ts`: a memo is a per-pass
    // cache, never a second copy of the page's state.
    const documentedCeiling = 4096;
    const consumers = documentedCeiling / 2 + 50;
    const memo = createSummaryMemo();

    for (let index = 0; index < consumers; index += 1) {
      const analysis = analyzeCapturedFiber(
        captureFiber(
          makeFiber({
            hooks: makeHookChain([{ next: index }]),
            prevHooks: makeHookChain([{ previous: index }]),
          }),
        ),
        { transitions: true, memo },
      );
      const change = analysis.hookChanges[0];
      expect(change).toBeDefined();
      if (change !== undefined) {
        expectWellFormedSummary(change.from);
        expectWellFormedSummary(change.to);
      }
    }

    expect(memo.summaries.size).toBe(documentedCeiling);
  });
});

// ---------------------------------------------------------------------------
// Public type surface
//
// `./fiber-diff.ts` exports eleven types, and a consumer imports them: the
// render event's `changedProps` attribute is built from `PropChange`, a
// `state` event's previous/next pair from `HookChange` and `ContextChange`,
// and the two render-trigger metrics are bucketed from
// `DimensionEvaluability`. `./react.ts` holds a `CapturedFiber` per rendered
// fiber between its commit and the idle slice that analyses it, passes
// `CapturedFiberAnalysisOptions` with a pass's `SummaryMemo`, and builds its
// events from the `RenderAnalysis` it gets back. The behavioural suites above
// would all keep passing if any of those `export` modifiers were dropped, a
// member renamed or a summary slot widened, because Vitest erases types and
// never sees them.
//
// The assertions below close that gap, and they are checked by `tsc -b` rather
// than at run time: this file is inside `packages/telemetry/tsconfig.json`'s
// `include`, so a drift here fails `pnpm typecheck`. Each one binds an
// exported type to a real value — a function result or a `FiberDiff` member —
// so a type that still exists but no longer describes what the module produces
// fails too. `keyof` is asserted as an exact union for the same reason: it is
// what catches an added, removed or renamed member, which an assignability
// check on its own would let through.
// ---------------------------------------------------------------------------

describe('the exported type surface', () => {
  /** A fiber exercising all three dimensions with one change in each. */
  function makeTypedFiber(): Bag {
    return makeFiber({
      props: { count: 2 },
      prevProps: { count: 1 },
      hooks: makeHookChain([2]),
      prevHooks: makeHookChain([1]),
      contexts: makeContextChain([{ context: ETA_CONTEXT, value: { etaMinutes: 2 } }]),
      prevContexts: makeContextChain([{ context: ETA_CONTEXT, value: { etaMinutes: 5 } }]),
    });
  }

  it('types diffProps results and FiberDiff.propChanges as PropChange', () => {
    const result = diffProps(makeTypedFiber());

    expectTypeOf(result.changed).toEqualTypeOf<PropChange[]>();
    expectTypeOf<FiberDiff['propChanges']>().toEqualTypeOf<PropChange[]>();
    expectTypeOf<keyof PropChange>().toEqualTypeOf<'key' | 'from' | 'to'>();
    expectTypeOf<PropChange['key']>().toEqualTypeOf<string>();
    expectTypeOf<PropChange['from']>().toEqualTypeOf<ValueSummary>();
    expectTypeOf<PropChange['to']>().toEqualTypeOf<ValueSummary>();

    // A runtime witness for the compile-time claim: the annotation is what
    // makes this assignment an assertion, and the checks below prove the value
    // really carries the members the type promises.
    const change: PropChange | undefined = result.changed[0];
    expect(change?.key).toBe('count');
    expect(change?.from.preview).toBe('1');
    expect(change?.to.preview).toBe('2');
  });

  it('types diffHookState results and FiberDiff.hookChanges as HookChange', () => {
    const result = diffHookState(makeTypedFiber());

    expectTypeOf(result.changed).toEqualTypeOf<HookChange[]>();
    expectTypeOf<FiberDiff['hookChanges']>().toEqualTypeOf<HookChange[]>();
    expectTypeOf<keyof HookChange>().toEqualTypeOf<'index' | 'label' | 'from' | 'to'>();
    expectTypeOf<HookChange['index']>().toEqualTypeOf<number>();
    // `label` is optional because a hook whose kind could not be inferred
    // carries none; `exactOptionalPropertyTypes` makes that "absent", never
    // "present and undefined".
    expectTypeOf<HookChange['label']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<HookChange['from']>().toEqualTypeOf<ValueSummary>();

    const change: HookChange | undefined = result.changed[0];
    expect(change?.index).toBe(0);
    expect(change?.label).toBe('state');
  });

  it('types diffContexts results and FiberDiff.contextChanges as ContextChange', () => {
    const result = diffContexts(makeTypedFiber());

    expectTypeOf(result.changed).toEqualTypeOf<ContextChange[]>();
    expectTypeOf<FiberDiff['contextChanges']>().toEqualTypeOf<ContextChange[]>();
    expectTypeOf<keyof ContextChange>().toEqualTypeOf<
      'index' | 'label' | 'provider' | 'contextName' | 'from' | 'to'
    >();
    expectTypeOf<ContextChange['index']>().toEqualTypeOf<number>();
    expectTypeOf<ContextChange['label']>().toEqualTypeOf<string | undefined>();
    // The two attribution names are optional for the same reason `label` is:
    // absent when they could not be read, never present and undefined.
    expectTypeOf<ContextChange['provider']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ContextChange['contextName']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ContextChange['to']>().toEqualTypeOf<ValueSummary>();

    const change: ContextChange | undefined = result.changed[0];
    expect(change?.index).toBe(0);
    expect(change?.label).toBe('ShippingEta');
  });

  it('types FiberDiff.evaluable as DimensionEvaluability with exactly three flags', () => {
    const diff = analyzeFiber(makeTypedFiber());

    expectTypeOf(diff.evaluable).toEqualTypeOf<DimensionEvaluability>();
    expectTypeOf<FiberDiff['evaluable']>().toEqualTypeOf<DimensionEvaluability>();
    // Exactly the three dimensions AAP 0.2.3 requires for `unchanged`: props
    // shallow-equal, own hook state unchanged and no consumed context value
    // changed. A fourth flag, or a missing one, changes what that metric
    // means.
    expectTypeOf<keyof DimensionEvaluability>().toEqualTypeOf<'props' | 'state' | 'context'>();
    expectTypeOf<DimensionEvaluability['props']>().toEqualTypeOf<boolean>();
    expectTypeOf<DimensionEvaluability['state']>().toEqualTypeOf<boolean>();
    expectTypeOf<DimensionEvaluability['context']>().toEqualTypeOf<boolean>();

    const evaluable: DimensionEvaluability = diff.evaluable;
    expect(evaluable).toStrictEqual({ props: true, state: true, context: true });
  });

  it('types the classifier over exactly the four parts of a FiberDiff it reads', () => {
    const diff = analyzeFiber(makeTypedFiber());

    // The classifier's input is a `Pick` of the four members asserted above,
    // so a rename on either side is a compile error here rather than a silent
    // mis-read at the one call site that matters.
    expectTypeOf(classifyRenderTrigger).parameters.toEqualTypeOf<
      [Pick<FiberDiff, 'propChanges' | 'hookChanges' | 'contextChanges' | 'evaluable'>]
    >();
    expectTypeOf(classifyRenderTrigger).returns.toEqualTypeOf<RenderTrigger>();
    expectTypeOf(diff.trigger).toEqualTypeOf<RenderTrigger>();

    const trigger: RenderTrigger = classifyRenderTrigger(diff);
    expect(trigger).toBe(diff.trigger);
  });

  it('types the capture record as exactly the six pointers and the mount flag', () => {
    const captured = captureFiber(makeTypedFiber());

    expectTypeOf(captureFiber).parameters.toEqualTypeOf<[fiber: unknown]>();
    expectTypeOf(captured).toEqualTypeOf<CapturedFiber>();
    // A seventh pointer is a seventh reference into the page held across an
    // idle slice; a missing one is a dimension the deferred analysis cannot
    // compare. Either is a change to what the queue in `./react.ts` retains.
    expectTypeOf<keyof CapturedFiber>().toEqualTypeOf<
      | 'hasAlternate'
      | 'nextProps'
      | 'previousProps'
      | 'nextHooks'
      | 'previousHooks'
      | 'nextContexts'
      | 'previousContexts'
    >();
    expectTypeOf<CapturedFiber['hasAlternate']>().toEqualTypeOf<boolean>();
    expectTypeOf<CapturedFiber['nextProps']>().toEqualTypeOf<unknown>();

    const record: CapturedFiber = captured;
    expect(record.hasAlternate).toBe(true);
  });

  it('types the deferred analysis as FiberDiff without its prop summaries', () => {
    const memo: SummaryMemo = createSummaryMemo();
    const options: CapturedFiberAnalysisOptions = { transitions: true, memo };
    const analysis = analyzeCapturedFiber(captureFiber(makeTypedFiber()), options);

    expectTypeOf(analyzeCapturedFiber).parameter(0).toEqualTypeOf<CapturedFiber>();
    expectTypeOf(analyzeCapturedFiber)
      .parameter(1)
      .toEqualTypeOf<CapturedFiberAnalysisOptions | undefined>();
    expectTypeOf(analysis).toEqualTypeOf<RenderAnalysis>();
    // Exactly `FiberDiff` minus `propChanges`: the render path reads prop
    // names only, and a member that drifted on one side and not the other
    // would make the two analyses disagree about what a render carries.
    expectTypeOf<keyof RenderAnalysis>().toEqualTypeOf<Exclude<keyof FiberDiff, 'propChanges'>>();
    expectTypeOf<RenderAnalysis['hookChanges']>().toEqualTypeOf<HookChange[]>();
    expectTypeOf<RenderAnalysis['contextChanges']>().toEqualTypeOf<ContextChange[]>();
    expectTypeOf<RenderAnalysis['evaluable']>().toEqualTypeOf<DimensionEvaluability>();
    expectTypeOf<RenderAnalysis['trigger']>().toEqualTypeOf<RenderTrigger>();
    expectTypeOf<keyof CapturedFiberAnalysisOptions>().toEqualTypeOf<'transitions' | 'memo'>();
    expectTypeOf(createSummaryMemo).returns.toEqualTypeOf<SummaryMemo>();
    expectTypeOf<SummaryMemo['summaries']>().toEqualTypeOf<Map<unknown, ValueSummary>>();

    expect(analysis.trigger).toBe('props');
    expect(analysis.hookChanges[0]?.label).toBe('state');
    expect(analysis.contextChanges[0]?.label).toBe('ShippingEta');
  });
});
