/**
 * Element description: one DOM node turned into a stable, JSON-safe descriptor
 * carrying its React component chain, plus the best-effort React-owner source
 * hints the service needs to turn that chain into a file and a line.
 *
 * Two product paths run through this module, and they have different budgets.
 *
 * 1. **"Use selected element"** (AAP 0.1.1, 0.4.2). The DevTools page evaluates
 *    an expression of the form `window.__DEBUGGEN__.describeTarget($0)` in the
 *    inspected page with `chrome.devtools.inspectedWindow.eval`, either on
 *    demand or from `panels.elements.onSelectionChanged`. The value that
 *    expression produces is forwarded, unchanged, as the `target.selected`
 *    payload's `target` field, so {@link describeElement}'s default return
 *    shape *is* that wire contract: exactly `selector`, `tagName`, optional
 *    `text`, `componentChain` and `url`, and nothing else.
 * 2. **Interaction target attributes.** `./interaction.ts` describes the
 *    element a capture-phase listener just saw, on the user's own click path,
 *    and writes the result into an `interaction` event's `target.selector`,
 *    `target.tagName`, `target.text` and `componentChain` attributes
 *    (`../schema/attributes.ts`). That call happens before the page's own
 *    handler runs, so everything here is bounded: no unbounded DOM walk, no
 *    unbounded string, no work that scales with the size of the document.
 *
 * ## Four invariants
 *
 * **1. Nothing here throws.** A `SyntaxError` from a hand-built selector or a
 * `TypeError` from a page that replaced a DOM accessor must not escape into
 * `inspectedWindow.eval` (where it would surface as an opaque evaluation
 * failure), into a DevTools selection change, or into the click path of the
 * developer's application. Every exported function wraps its body, every
 * property read goes through {@link readProperty}, and a failure degrades to
 * the narrowest honest answer: `undefined` from {@link describeElement} and
 * {@link ownerHintsFor}, the bare tag name from {@link buildSelector}, an
 * empty array from {@link componentChainFor}.
 *
 * **2. Everything returned is strictly JSON-compliant.** `inspectedWindow.eval`
 * can only hand back JSON-compliant values, and the same descriptor is also
 * structured-cloned through `window.postMessage` on its way from the page to
 * the isolated-world bridge. So a returned object holds strings, finite
 * numbers, arrays of strings and nested plain objects only — never a DOM node,
 * never a fiber, never an `Error`, never a function or a symbol, and never a
 * key whose value is `undefined`. Optional fields are omitted rather than set
 * to `undefined`, which is also what `exactOptionalPropertyTypes` asks for.
 *
 * **3. Only `id` and `class` are read off the element.** Never `innerHTML`,
 * never `outerHTML`, never `value`, never `data-*`, never any other attribute:
 * an input's value and a page's markup are application data this product does
 * not capture (AAP 0.5.2). The element's *text* is read, because the label of
 * the thing the developer clicked is what makes a panel legible — but through
 * the budgeted walk of {@link harvestText}, never through `textContent`, whose
 * single read costs the whole subtree — and it is whitespace-collapsed and
 * passed through the redaction primitives before it leaves this module.
 *
 * **4. No side effects at import time and no module-scope DOM access.** Every
 * page global — `document`, `location`, `CSS` — is reached behind a
 * `typeof` guard inside a function, so this module is importable by the Node
 * preload's program and by a test environment without a DOM.
 *
 * ## Imports: exactly two modules
 *
 * The page-injected agent bundles this file (`esbuild.agent.mjs`), and that
 * build hard-fails when any input resolves to a Node builtin, a schema library
 * or a cross-package runtime dependency. Two imports are therefore allowed and
 * no others: `bippy` (inlined into the agent, and the reason the React
 * DevTools hook exists before React loads) and `../redaction/rules.ts` (import
 * free by contract, so that the page can use it). In particular
 * `@debuggen/protocol` is not imported even for a type — the agent never
 * speaks the envelope, the service worker wraps its output — so the
 * `SelectedTarget` shape is restated structurally as {@link TargetDescriptor}
 * and kept identical to AAP 0.4.2 by review.
 *
 * @module packages/telemetry/src/browser/dom-target
 */

import {
  getDisplayName,
  getFiberFromHostInstance,
  isCompositeFiber,
  traverseFiber,
  type Fiber,
} from 'bippy';
import { cutAtCredentialBoundary, scrub, truncate } from '../redaction/rules.js';

/*
 * ---------------------------------------------------------------------------
 * Public bounds
 *
 * Every one of these caps something a page controls: how deep a React tree
 * is, how long a class name is, how much text an element contains, how many
 * frames a stack has. A page is not hostile to be unbounded — a grid of cards
 * legitimately nests twenty levels deep and a table row legitimately holds a
 * paragraph — so the bounds are what keep a descriptor small enough to travel
 * on every interaction event.
 * ---------------------------------------------------------------------------
 */

/**
 * Most component names a {@link componentChainFor} chain carries.
 *
 * Eight is the nearest eight: the chain is ordered nearest-first, so the cap
 * removes the outer application shell (providers, layouts, the router) rather
 * than the components that explain what was clicked.
 */
export const MAX_COMPONENT_CHAIN = 8;

/**
 * Most path segments a {@link buildSelector} selector carries — the element
 * plus five ancestors — before the walk stops.
 *
 * A truncated path is still a valid selector: it is matched anywhere in the
 * document rather than from the root, and {@link buildSelector} verifies that
 * it still resolves to one node.
 */
export const MAX_SELECTOR_DEPTH = 6;

/**
 * Most code points of an element's collapsed text a descriptor carries.
 *
 * Deliberately short. This is a label — "Save", "Retry", "Sign in" — not a
 * document: enough to recognise the target in a timeline row, never enough to
 * be a copy of the page.
 */
export const MAX_TEXT_LENGTH = 80;

/** Most stack frames {@link ownerHintsFor} keeps from a React owner stack. */
export const MAX_OWNER_STACK_FRAMES = 5;

/** Most characters of the joined owner stack {@link ownerHintsFor} returns. */
export const MAX_OWNER_STACK_CHARS = 2048;

/*
 * ---------------------------------------------------------------------------
 * Public shapes
 * ---------------------------------------------------------------------------
 */

/**
 * What the developer selected or interacted with.
 *
 * Structurally identical to the `SelectedTarget` of the `target.selected`
 * message (AAP 0.4.2) — `selector`, `tagName`, optional `text`,
 * `componentChain`, `url` — and deliberately restated here rather than
 * imported: `@debuggen/protocol` sits above this package and is not available
 * inside the page bundle. The two definitions are kept in step by review, and
 * by the service rejecting a payload that does not validate.
 */
export interface TargetDescriptor {
  /**
   * A CSS selector that resolves to this element, short enough to read in a
   * panel row and specific enough to identify the node again.
   */
  selector: string;

  /** The element's tag name, lowercased (`'button'`, not `'BUTTON'`). */
  tagName: string;

  /**
   * The element's visible text: whitespace-collapsed, scrubbed of credential
   * material and bounded by {@link MAX_TEXT_LENGTH}.
   *
   * Absent — the key omitted, never `undefined` — when the element has no
   * text, which is the common case for an icon button or an input.
   */
  text?: string;

  /**
   * The React component chain above this element, nearest-first, bounded by
   * {@link MAX_COMPONENT_CHAIN}.
   *
   * Always an array. An empty array is the honest answer for a page with no
   * React on it, for a node React never rendered, and for a production build
   * whose fibers the hook cannot reach.
   */
  componentChain: string[];

  /**
   * The document's URL, **unredacted**.
   *
   * The service redacts URL query values at ingest (AAP 0.5.2) and needs the
   * raw form to do it — and to map the URL onto a route in the code graph.
   * Redacting here would destroy that input and produce a second, divergent
   * redaction point in the product.
   */
  url: string;
}

/**
 * A source position React itself recorded for the JSX that produced a fiber,
 * exactly as the fiber carried it.
 *
 * `fileName` is whatever React stored: an absolute path from a Babel-style
 * transform, or a generated-chunk URL. It is **not** a project-relative path
 * and must not be treated as one — see the comment above
 * {@link ownerHintsFor}.
 */
export interface OwnerDebugSource {
  /** The file React recorded, verbatim (scrubbed and length-bounded). */
  fileName: string;

  /** The 1-based line React recorded. */
  lineNumber: number;

  /** The 1-based column React recorded, when it recorded one. */
  columnNumber?: number;
}

/**
 * Best-effort hints about where the code behind an element lives.
 *
 * A hint is evidence for the service's source resolver, not an answer: the
 * resolver decides, using the code graph and the dev server's source maps,
 * what any of this means in terms of the developer's project.
 */
export interface OwnerHints {
  /** React's own recorded position, when the fiber carried one. */
  debugSource?: OwnerDebugSource;

  /**
   * Filtered frames of a React 19 owner stack: at most
   * {@link MAX_OWNER_STACK_FRAMES} frames, at most
   * {@link MAX_OWNER_STACK_CHARS} characters, newline-separated, with React's
   * own frames, `node_modules` frames and this agent's frames removed.
   */
  ownerStack?: string;

  /**
   * The component chain, repeated here so a hint is self-contained: when
   * neither of the two fields above is available, the chain is the whole hint
   * and the service resolves the nearest name through the code graph.
   */
  componentChain: string[];
}

/** How much {@link describeElement} should gather. */
export interface DescribeOptions {
  /**
   * Include {@link OwnerHints} as an extra `ownerHints` key.
   *
   * Defaults to **false**, and that default is load-bearing: the descriptor
   * `describeElement` returns is forwarded verbatim as the `target.selected`
   * payload's target, whose schema admits the five fields of
   * {@link TargetDescriptor} and nothing more, so an extra key would be a
   * validation failure at the service rather than extra information. Only a
   * caller that keeps the hints locally — the source-hint path, not the
   * selection path — turns this on.
   */
  includeOwnerHints?: boolean;
}

/*
 * ---------------------------------------------------------------------------
 * Internal bounds and patterns
 *
 * Not exported: these are implementation budgets rather than parts of the
 * contract, and a caller has no reason to reason about them. The exported
 * bounds above are the ones a consumer can observe in the output.
 * ---------------------------------------------------------------------------
 */

/** `Node.ELEMENT_NODE`, spelled out so no DOM global is needed to read it. */
const ELEMENT_NODE = 1;

/** `Node.TEXT_NODE`, the node type an element's text lives in. */
const TEXT_NODE = 3;

/**
 * `Node.CDATA_SECTION_NODE`, collected alongside {@link TEXT_NODE} because
 * `textContent` concatenates both and an inline SVG or MathML subtree can
 * legitimately carry one.
 */
const CDATA_SECTION_NODE = 4;

/** `Node.DOCUMENT_NODE`, used to recognise an element's owner document. */
const DOCUMENT_NODE = 9;

/**
 * How much of an element's harvested text is kept before collapsing and
 * scrubbing, and the cut that reduces it.
 *
 * Roughly twenty-five times the text a descriptor keeps, so an ordinary label
 * is never anywhere near it. The cut goes through `cutAtCredentialBoundary`
 * rather than `slice` so a credential straddling the window is removed from
 * where it begins instead of leaving its head in the text that is kept.
 */
const TEXT_SCAN_WINDOW = 2048;

/**
 * Most code units {@link harvestText} gathers before it stops walking.
 *
 * Wider than {@link TEXT_SCAN_WINDOW} on purpose, and the margin is exactly
 * what keeps the redaction guarantee intact rather than spare room.
 * `cutAtCredentialBoundary` reads a fixed overlap — one thousand and
 * twenty-four code units, in `../redaction/rules.ts` — *past* the limit it is
 * given, so that a credential the cut would split is seen whole; and it arms
 * its strictest rules, the ones that answer "is a credential-shaped run still
 * going where the window ends?", only when the text it was handed continues
 * past that overlap. A harvest of twice the scan window satisfies both
 * conditions with the overlap to spare, so the value the cut returns is
 * identical to the one it returned when the whole of `textContent` was handed
 * to it.
 */
const TEXT_HARVEST_WINDOW = TEXT_SCAN_WINDOW * 2;

/**
 * Most nodes {@link harvestText}'s walk visits.
 *
 * The bound that matters for a subtree of many nodes holding little text: a
 * virtualised table, a sprite sheet of inline `<svg>` icons, a grid of empty
 * skeleton cells. Text-bearing subtrees stop at
 * {@link TEXT_HARVEST_WINDOW} long before this, so in practice it caps the
 * pathological case rather than the ordinary one — five hundred and twelve
 * guarded property reads, not a walk of the document. A subtree whose text
 * begins past the five-hundred-and-twelfth node yields no text, which is the
 * honest answer for a bounded look rather than a wrong one.
 */
const MAX_TEXT_NODES_SCANNED = 512;

/**
 * Deepest descent {@link harvestText}'s walk makes below the element.
 *
 * Text more than this many levels inside the thing that was clicked is not
 * its label. The bound also caps the walk's own state — one resume slot per
 * level — and keeps a cyclic or hostile object graph from growing it.
 */
const MAX_TEXT_DEPTH = 32;

/**
 * Elements whose text is not the page's visible text.
 *
 * Their content is code, markup or a data payload: a Next.js page carries its
 * server-rendered flight data in inline `<script>` blobs that are routinely
 * megabytes, and a `<style>` element carries a stylesheet. Collecting either
 * would spend the whole harvest budget on text no developer would recognise
 * in a panel row, and — since a page's inline bootstrap data can hold session
 * material — would capture application data this product does not capture
 * (AAP 0.5.2). The element the walk started from is tested too, so selecting
 * a `<script>` in the Elements panel reports no text rather than a fragment
 * of the page's own source.
 */
const NON_RENDERED_TAG = /^(?:script|style|template|noscript)$/;

/** Most class names one selector segment carries. */
const MAX_SELECTOR_CLASSES = 2;

/** Longest class name admitted into a selector segment. */
const MAX_CLASS_LENGTH = 32;

/** Most class tokens examined on one element before the rest are ignored. */
const MAX_CLASS_TOKENS_SCANNED = 16;

/**
 * Longest selector that is worth verifying with a `querySelectorAll` call.
 *
 * A selector longer than this is already so specific that a second document
 * query buys nothing, and the query itself is the one cost in this module that
 * scales with the document.
 */
const SELECTOR_VERIFY_MAX_LENGTH = 256;

/**
 * Most element siblings scanned when computing a positional index.
 *
 * A container with more children than this — a virtualised table, a long
 * option list — yields no index rather than a scan proportional to its size.
 * The selector stays legible and may stay ambiguous, which is the right
 * trade on a click path.
 */
const MAX_SIBLING_SCAN = 1000;

/**
 * Most fibers the manual ascent visits, for the case where bippy's traversal
 * throws and the fallback loop runs on a structure this module did not build.
 */
const MAX_FIBER_ASCENT = 512;

/** Longest component name a chain entry carries. */
const MAX_COMPONENT_NAME_LENGTH = 64;

/** Most lines of a React owner stack examined before the rest are ignored. */
const MAX_STACK_LINES_SCANNED = 64;

/** Any run of whitespace, for collapsing text and stack frames. */
const WHITESPACE_RUN = /\s+/g;

/**
 * The last whitespace-delimited word of a value, with the whitespace that
 * precedes it — what {@link dropUnterminatedWord} removes when the text ends
 * at a budget rather than at the end of the element's own text.
 */
const TRAILING_WORD = /\s\S*$/;

/** Characters a CSS identifier may carry unescaped. */
const SAFE_IDENTIFIER_CHAR = /[A-Za-z0-9_-]/;

/** A single decimal digit. */
const DIGIT = /[0-9]/;

/**
 * A CSS-modules or BEM-with-hash suffix: `styles_card__3fD9a`,
 * `Card--a1b2c3`. The hash changes on every build, so a selector built from
 * one identifies nothing tomorrow.
 */
const HASHED_CLASS_SUFFIX = /(?:__|--)[A-Za-z0-9_-]{4,}$/;

/** A CSS-in-JS generated class: emotion's `css-1q2w3e`, styled-components' `sc-abcdef`. */
const GENERATED_CLASS_PREFIX = /^(?:css|sc|emotion)-[A-Za-z0-9]{4,}$/;

/**
 * A hash-shaped segment: at least five alphanumerics carrying at least two
 * digits, which catches `3fD9a` and `1q2w3e` while leaving legible names such
 * as `grid-2`, `col-6` and `h1` alone.
 */
const HASHED_CLASS_SEGMENT = /^(?=[A-Za-z0-9]{5,}$)(?=(?:[^0-9]*[0-9]){2,})[A-Za-z0-9]+$/;

/**
 * Frames that say nothing about the developer's code: React's own internals
 * (including the bundled copies Next.js serves out of `node_modules` chunks),
 * this agent's injected bundle, and frames with no location at all.
 */
const STACK_FRAME_NOISE =
  /node_modules|chrome-extension:\/\/|react-stack-bottom-frame|react-dom|react-refresh|react-server-dom|jsx-runtime|jsx-dev-runtime|<anonymous>/;

/** A line that looks like a stack frame rather than a message header. */
const STACK_FRAME_LINE = /^\s*at\s|@/;

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Describes a DOM element as a JSON-safe {@link TargetDescriptor}.
 *
 * This is the function the DevTools page reaches through the page global:
 * `window.__DEBUGGEN__.describeTarget($0)`. `$0` is whatever the Elements
 * panel had selected, which is routinely `null` (nothing selected), sometimes
 * a text node or a comment, and sometimes an object from another realm whose
 * prototype chain has nothing to do with this one's — so the input is typed
 * `unknown` and validated structurally rather than with `instanceof`.
 *
 * @param el - Candidate element. Anything that is not an object with
 * `nodeType === 1` and a non-empty `tagName` yields `undefined`.
 * @param options - See {@link DescribeOptions}; owner hints are off by default
 * so the result matches the `target.selected` payload shape exactly.
 * @returns The descriptor, or `undefined` when `el` is not an element or the
 * document's URL cannot be read (a required field this module will not invent).
 */
export function describeElement(
  el: unknown,
  options?: DescribeOptions,
): (TargetDescriptor & { ownerHints?: OwnerHints }) | undefined {
  try {
    if (!isElement(el)) {
      return undefined;
    }
    const url = documentUrlOf(el);
    if (url === undefined) {
      return undefined;
    }
    const tagName = tagNameOf(el);
    const componentChain = componentChainFor(el);
    const selector = buildSelector(el);
    const text = textOf(el);
    const descriptor: TargetDescriptor =
      text === undefined
        ? { selector, tagName, componentChain, url }
        : { selector, tagName, text, componentChain, url };
    if (options?.includeOwnerHints !== true) {
      return descriptor;
    }
    const ownerHints = ownerHintsFor(el);
    return ownerHints === undefined ? descriptor : { ...descriptor, ownerHints };
  } catch {
    return undefined;
  }
}

/**
 * Builds a short, legible CSS selector for an element.
 *
 * Three steps, cheapest first:
 *
 * 1. **A unique `id` wins outright.** `#save-draft` is the best selector
 *    there is: short, stable across re-renders, and legible in a panel row.
 *    Uniqueness is checked rather than assumed, because a duplicated `id` is a
 *    common bug in exactly the kind of application this tool is pointed at.
 * 2. **Otherwise a bounded path.** At most {@link MAX_SELECTOR_DEPTH} segments
 *    of `tag`, up to {@link MAX_SELECTOR_CLASSES} legible class names and a
 *    `:nth-of-type(n)` where the parent has more than one child of that tag,
 *    joined with `>`. Build-hashed class names are skipped
 *    ({@link isHashedClass}): a selector containing one stops resolving at the
 *    next build, which is worse than a selector without it.
 * 3. **An ancestor with a unique `id` ends the walk** and prefixes the path,
 *    which is both shorter and more stable than climbing further.
 *
 * The result is verified once against the document, and a leaf
 * `:nth-child(n)` is appended when the path still matches more than one node.
 * A path may be truncated by the depth bound and is then matched anywhere in
 * the document rather than from the root; that is what makes the verification
 * worth doing.
 *
 * @param el - The element to describe. Typed `Element` because the exported
 * callers validate first; a value that is not one still yields a string.
 * @returns A selector, or the element's lowercased tag name when a selector
 * cannot be built. Never throws and never returns an empty string.
 */
export function buildSelector(el: Element): string {
  const fallback = tagNameOf(el);
  try {
    const doc = ownerDocumentOf(el);
    const ownId = identifierOf(el);
    if (ownId !== undefined && isUniqueIdentifier(doc, ownId)) {
      return `#${escapeIdentifier(ownId)}`;
    }

    const segments: string[] = [];
    let current: Element | undefined = el;
    while (current !== undefined && segments.length < MAX_SELECTOR_DEPTH) {
      segments.unshift(segmentFor(current));
      const parent = parentElementOf(current);
      if (parent === undefined) {
        break;
      }
      const parentId = identifierOf(parent);
      if (parentId !== undefined && isUniqueIdentifier(doc, parentId)) {
        segments.unshift(`#${escapeIdentifier(parentId)}`);
        break;
      }
      current = parent;
    }

    let selector = segments.join(' > ');
    if (selector.length === 0) {
      return fallback;
    }
    if (
      doc !== undefined &&
      selector.length <= SELECTOR_VERIFY_MAX_LENGTH &&
      (matchCount(doc, selector) ?? 1) > 1
    ) {
      const position = positionOf(el, false);
      const leaf = segments[segments.length - 1];
      if (position !== undefined && leaf !== undefined) {
        segments[segments.length - 1] = `${leaf}:nth-child(${position.index})`;
        selector = segments.join(' > ');
      }
    }
    return selector.length > 0 ? selector : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resolves the React component chain above an element, nearest-first.
 *
 * The chain answers "which components rendered this node", which is what makes
 * a selected `<button>` mean something: the service resolves the nearest name
 * to a declaration through the code graph, and a panel shows the chain so the
 * developer recognises where they are.
 *
 * Consecutive repeats are collapsed — a `memo(Row)` wrapping
 * `Row` is one component to a human — and fibers bippy cannot name are
 * skipped rather than reported as an empty entry.
 *
 * @param el - Candidate element, validated structurally.
 * @param limit - Most names to collect, default {@link MAX_COMPONENT_CHAIN}. A
 * limit of `0` or less yields an empty array.
 * @returns Component names, nearest-first. Always an array: an empty one means
 * "no React fiber was reachable", which is a legitimate answer and not an
 * error.
 */
export function componentChainFor(el: unknown, limit: number = MAX_COMPONENT_CHAIN): string[] {
  const names: string[] = [];
  if (!Number.isFinite(limit) || limit < 1) {
    return names;
  }
  try {
    if (!isElement(el)) {
      return names;
    }
    const fiber = fiberFor(el);
    if (fiber === undefined) {
      return names;
    }
    const visit = (node: Fiber): boolean => {
      const name = componentNameOf(node);
      if (name !== undefined && names[names.length - 1] !== name) {
        names.push(name);
      }
      return names.length >= limit;
    };
    try {
      // bippy's ascending traversal walks `fiber.return` only (siblings are
      // skipped when ascending) and visits the starting fiber first, so the
      // host fiber of the element is offered to `visit` and rejected by
      // `componentNameOf`, and the first name collected is the nearest
      // component. Returning `true` stops the walk at the limit.
      traverseFiber(fiber, visit, true);
    } catch {
      // A structure bippy cannot traverse is still worth a bounded manual
      // ascent: correctness beats helper usage here, and the partial chain the
      // failed traversal may have collected is discarded so the manual walk
      // cannot duplicate it.
      names.length = 0;
      ascend(fiber, visit);
    }
    return names;
  } catch {
    names.length = 0;
    return names;
  }
}

/**
 * The nearest React component name above an element.
 *
 * Used by `./interaction.ts` for an `interaction` event's `component`
 * attribute, and computed with a chain limit of one so a click costs a single
 * ascent to the first composite fiber rather than a full chain.
 *
 * @param el - Candidate element, validated structurally.
 * @returns The nearest component name, or `undefined` when no fiber was
 * reachable or none of the fibers could be named.
 */
export function nearestComponentName(el: unknown): string | undefined {
  return componentChainFor(el, 1)[0];
}

/*
 * ---------------------------------------------------------------------------
 * NEVER CONSTRUCT A SOURCE LOCATION HERE.
 *
 * This is the most likely mistake a future editor will make, because the data
 * below looks like it is one field rename away from being a location.
 *
 * `@debuggen/shared`'s `sourceLocationSchema` requires `file` to be a
 * **project-relative POSIX path** (`isSafeRelativePath`: no absolute or
 * drive-letter path, no `..` segment, no backslash) together with a
 * `resolvedBy` route and a confidence. What React hands over here is none of
 * those things: `_debugSource.fileName` is an absolute host path, and an owner
 * stack frame is a generated-chunk URL — `webpack://_N_E/./src/...`, a
 * Turbopack path, `http://localhost:3000/_next/static/chunks/...`. Converting
 * one into the other needs the project root, the dev server's source maps and
 * the path normalisation that lives in
 * `packages/code-analysis/src/source-map/{fetch-map,resolver,normalize}.ts`,
 * inside the service (AAP 0.4.2). None of that is available inside the page,
 * and a location built from a raw path here would be rejected by the strict
 * ingress schema — taking the whole event with it.
 *
 * So this module returns *hints*: the strings and numbers React recorded, kept
 * verbatim, and the component chain. The service turns them into a location,
 * or fails to, and says so.
 * ---------------------------------------------------------------------------
 */

/**
 * Gathers React-owner source hints for an element.
 *
 * Two routes, in precedence order:
 *
 * 1. **`_debugSource`** — React ≤ 18 and some 19 builds record the JSX call
 *    site on the fiber directly. That is an exact position, so when it is
 *    present nothing else needs parsing.
 * 2. **`_debugStack`** — React 19 removed `_debugSource`
 *    (facebook/react#28265) and DevTools now derives source lazily from
 *    component stacks instead. In a React 19 development build `_debugStack`
 *    (on the fiber, or on its `_debugOwner`) is an `Error` created at the JSX
 *    call site, so its `.stack` carries the frames this module filters down to
 *    the developer's own.
 *
 * When neither is available the chain alone is returned, and the service
 * resolves the nearest component name through the code graph.
 *
 * Only strings and numbers cross this boundary: never a fiber, never an
 * element, never the `Error` itself.
 *
 * @param el - Candidate element, validated structurally.
 * @returns Hints, or `undefined` when `el` is not an element or no React fiber
 * was reachable for it.
 */
export function ownerHintsFor(el: unknown): OwnerHints | undefined {
  try {
    if (!isElement(el)) {
      return undefined;
    }
    const fiber = fiberFor(el);
    if (fiber === undefined) {
      return undefined;
    }
    const componentChain = componentChainFor(el);
    const debugSource = debugSourceFor(fiber);
    if (debugSource !== undefined) {
      return { debugSource, componentChain };
    }
    const ownerStack = ownerStackFor(fiber);
    return ownerStack === undefined ? { componentChain } : { ownerStack, componentChain };
  } catch {
    return undefined;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Internal: guarded reads
 *
 * Everything below treats the page as a foreign object graph. A DOM accessor
 * can be overridden on a custom element's prototype, a `Proxy` can be revoked
 * between two reads, and a value from another realm shares no prototype with
 * this one — so nothing is reached with `instanceof`, no property is read
 * outside a guard, and the only page functions ever *called* are
 * `document.querySelectorAll` (there is no other way to check that a selector
 * resolves) and `CSS.escape`.
 * ---------------------------------------------------------------------------
 */

/** Selector token used where a tag name cannot be used safely. */
const UNKNOWN_TAG = '*';

/** A tag name that can be written into a selector without escaping. */
const SELECTOR_SAFE_TAG = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Reads one property off a candidate object, yielding `undefined` instead of
 * throwing when the value is not an object or the read itself fails.
 *
 * The return type is `unknown` on purpose: every caller narrows with `typeof`
 * before using what came back, which is what keeps a page-supplied value from
 * being trusted for its declared type.
 */
function readProperty(source: unknown, key: string): unknown {
  if (source === null || (typeof source !== 'object' && typeof source !== 'function')) {
    return undefined;
  }
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Whether a value is a DOM element, decided structurally.
 *
 * `$0` is `null` when nothing is selected, a text or comment node when the
 * developer clicked one in the Elements tree, and an object from another realm
 * for an element inside a same-origin iframe — so `instanceof Element` is the
 * wrong test. A non-empty `tagName` is required alongside `nodeType`, which
 * makes every later read of it total.
 */
function isElement(value: unknown): value is Element {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (readProperty(value, 'nodeType') !== ELEMENT_NODE) {
    return false;
  }
  const tagName = readProperty(value, 'tagName');
  return typeof tagName === 'string' && tagName.length > 0;
}

/** Whether a value is a DOM document that can be queried. */
function isDocumentLike(value: unknown): value is Document {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    readProperty(value, 'nodeType') === DOCUMENT_NODE &&
    typeof readProperty(value, 'querySelectorAll') === 'function'
  );
}

/**
 * The document an element belongs to, preferred over the ambient `document`.
 *
 * An element selected inside a same-origin iframe belongs to that frame's
 * document, and querying the top document for it would report it missing.
 */
function ownerDocumentOf(el: unknown): Document | undefined {
  const owner = readProperty(el, 'ownerDocument');
  if (isDocumentLike(owner)) {
    return owner;
  }
  if (typeof document !== 'undefined' && isDocumentLike(document)) {
    return document;
  }
  return undefined;
}

/** The element's tag name, lowercased, or {@link UNKNOWN_TAG} when unreadable. */
function tagNameOf(el: unknown): string {
  const tagName = readProperty(el, 'tagName');
  if (typeof tagName !== 'string' || tagName.length === 0) {
    return UNKNOWN_TAG;
  }
  return tagName.toLowerCase();
}

/**
 * The tag name as a selector token.
 *
 * An XML-namespaced tag (`svg:path`) or any other name that is not a plain
 * identifier becomes the universal selector rather than an invalid token that
 * would make the whole selector throw when it is verified.
 */
function selectorTagOf(el: unknown): string {
  const tagName = tagNameOf(el);
  return SELECTOR_SAFE_TAG.test(tagName) ? tagName : UNKNOWN_TAG;
}

/** The element's parent element, via `parentElement` then `parentNode`. */
function parentElementOf(el: unknown): Element | undefined {
  const parentElement = readProperty(el, 'parentElement');
  if (isElement(parentElement)) {
    return parentElement;
  }
  const parentNode = readProperty(el, 'parentNode');
  return isElement(parentNode) ? parentNode : undefined;
}

/** The element's trimmed, non-empty `id`, or `undefined`. */
function identifierOf(el: unknown): string | undefined {
  const id = readProperty(el, 'id');
  if (typeof id !== 'string') {
    return undefined;
  }
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The element's class attribute as a string, via `className` then
 * `classList.value`.
 *
 * The second route is what makes this work on SVG, where `className` is an
 * `SVGAnimatedString` rather than a string.
 */
function classAttributeOf(el: unknown): string | undefined {
  const className = readProperty(el, 'className');
  if (typeof className === 'string' && className.length > 0) {
    return className;
  }
  const listValue = readProperty(readProperty(el, 'classList'), 'value');
  return typeof listValue === 'string' && listValue.length > 0 ? listValue : undefined;
}

/** The `href` of a `Location`-like value, when it is a non-empty string. */
function hrefOf(candidate: unknown): string | undefined {
  const href = readProperty(candidate, 'href');
  return typeof href === 'string' && href.length > 0 ? href : undefined;
}

/**
 * The URL of the document the element belongs to, unredacted.
 *
 * The element's own document is asked first, so a selection inside a
 * same-origin iframe reports that frame's URL. A document with no location at
 * all — a detached document built by `createHTMLDocument` — falls back to the
 * ambient one, and a realm with no `location` yields `undefined`, which
 * {@link describeElement} treats as a failure rather than inventing a URL for
 * a required protocol field.
 */
function documentUrlOf(el: Element): string | undefined {
  const fromOwner = hrefOf(readProperty(readProperty(el, 'ownerDocument'), 'location'));
  if (fromOwner !== undefined) {
    return fromOwner;
  }
  return typeof location === 'undefined' ? undefined : hrefOf(location);
}

/** Collapses every run of whitespace to one space and trims the result. */
function collapse(value: string): string {
  return value.replace(WHITESPACE_RUN, ' ').trim();
}

/** A finite integer of at least 1, or `undefined`. */
function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

/*
 * ---------------------------------------------------------------------------
 * Internal: text
 * ---------------------------------------------------------------------------
 */

/**
 * The element's visible text, bounded, collapsed and scrubbed.
 *
 * Four steps, and their order is the contract rather than an accident:
 *
 * 1. **Harvest at most {@link TEXT_HARVEST_WINDOW} code units** with
 *    {@link harvestText}. `textContent` is deliberately never read: it is one
 *    property access that walks every descendant and concatenates every text
 *    node into a new string, so its cost and its allocation are whatever the
 *    subtree costs — a click on `<body>` materialises the whole page, inline
 *    bootstrap payloads included — and no budget applied afterwards can undo
 *    work that has already happened. This function runs on the developer's own
 *    click path (`./interaction.ts`, capture phase, before their handler) and
 *    on every Elements-panel selection change, so the bound has to come first.
 * 2. **Reduce the harvest to a value the redaction rules can be trusted with**
 *    ({@link boundedForRedaction}): the cut past {@link TEXT_SCAN_WINDOW}, and
 *    the unterminated-word guard for text that ended at a budget.
 * 3. **Collapse whitespace**, because a DOM subtree's text carries the source
 *    document's indentation and a panel row needs a label.
 * 4. **Scrub, then truncate — never the other way round.** This is the stated
 *    contract of `../redaction/rules.ts`: cutting first can leave a credential
 *    half-matched and therefore unreplaced, so the value is scrubbed while it
 *    is still whole and the scrubbed result is what gets shortened. UI text is
 *    scrubbed at all because a label can sit next to — or be pasted into — an
 *    input holding a token (AAP 0.5.2).
 *
 * @returns The text, or `undefined` when the element has none, so the caller
 * omits the key entirely instead of emitting an empty string.
 */
function textOf(el: Element): string | undefined {
  const harvested = harvestText(el);
  if (harvested.text.length === 0) {
    return undefined;
  }
  const bounded = boundedForRedaction(harvested);
  const collapsed = collapse(bounded);
  if (collapsed.length === 0) {
    return undefined;
  }
  const text = truncate(scrub(collapsed), MAX_TEXT_LENGTH);
  return text.length > 0 ? text : undefined;
}

/**
 * Reduces harvested text to a value `scrub` can recognise credentials in.
 *
 * Every rule in `../redaction/rules.ts` identifies a credential by a run of
 * credential characters — a provider prefix and its body, a bearer scheme word
 * and its token, a JWT's dot-separated segments, a URL's `user:password@`,
 * a PEM block — and a run is whitespace-free. A rule therefore needs to see
 * either the run's terminator or enough of its body to meet its minimum
 * length, and text that stops in the middle of a run gives it neither:
 * `postgresql://user:secret` without its `@` and `Bearer abcdefg` one
 * character short of the bearer rule's minimum both survive `scrub` verbatim.
 *
 * Text stops in the middle of a run in exactly two ways here, and each has its
 * own answer:
 *
 * - **Past {@link TEXT_SCAN_WINDOW}**, where the harvest holds more text than
 *   is kept. `cutAtCredentialBoundary` owns this: it reads past the cut, sees
 *   the run whole, and moves the cut back to where the run begins.
 * - **At a harvest budget**, where the text simply ends and there is nothing
 *   past it to read — {@link MAX_TEXT_NODES_SCANNED}, {@link MAX_TEXT_DEPTH},
 *   or a text node whose data could not be read within the budget. Nothing can
 *   establish what the run was, so the last unterminated word goes
 *   ({@link dropUnterminatedWord}), and a prefix that is one unterminated word
 *   in its entirety becomes empty and the descriptor omits `text` — no text at
 *   all is the only safe answer, since this value both is stored and can reach
 *   a model provider (AAP 0.5.2).
 *
 * @param harvested - What {@link harvestText} gathered, with its truncation
 * flag.
 * @returns Text safe to scrub: never longer than {@link TEXT_SCAN_WINDOW}, and
 * never ending inside a word the walk did not finish reading.
 */
function boundedForRedaction(harvested: HarvestedText): string {
  if (harvested.text.length > TEXT_SCAN_WINDOW) {
    return cutAtCredentialBoundary(harvested.text, TEXT_SCAN_WINDOW);
  }
  return harvested.truncated ? dropUnterminatedWord(harvested.text) : harvested.text;
}

/**
 * Drops the final whitespace-delimited word of a value.
 *
 * The word is dropped rather than trusted because the text it belonged to
 * ended at a budget: what follows was never read, so the word may be the head
 * of a credential (see {@link boundedForRedaction}). A value with no
 * whitespace in it is one such word, and yields the empty string.
 */
function dropUnterminatedWord(value: string): string {
  const match = TRAILING_WORD.exec(value);
  return match === null ? '' : value.slice(0, match.index);
}

/** What {@link harvestText} gathered, and whether it saw everything. */
interface HarvestedText {
  /**
   * The gathered text, uncollapsed and unscrubbed — {@link textOf} owns those
   * steps — and never longer than {@link TEXT_HARVEST_WINDOW} code units.
   */
  text: string;

  /**
   * Whether text the walk never read remains: a budget stopped it, a subtree
   * sat below {@link MAX_TEXT_DEPTH}, or a text node's data could not be read
   * within the budget.
   *
   * `true` means {@link text} may end in the middle of a word, which is what
   * {@link boundedForRedaction} has to answer for before the value is scrubbed.
   */
  truncated: boolean;
}

/** The head of one text node's data, and whether data past it was left unread. */
interface TextPrefix {
  /** Text taken from the node, never longer than the budget it was given. */
  text: string;

  /** Whether the node holds data this read did not return. */
  unread: boolean;
}

/**
 * A text node, as much of one as this module needs.
 *
 * `CharacterData.length` is the node's code-unit count, and `substringData`
 * returns a prefix of its data *without* handing over the rest — which is the
 * whole point: a plain `node.data` read materialises the node's entire string
 * into JavaScript before any slice can apply, at a cost proportional to the
 * node. Measured in Chromium 153 on a parser-created text node of twenty
 * million code units: the first `node.data.slice(0, 4096)` took 3.1 ms, while
 * `node.substringData(0, 4096)` took under a hundredth of a millisecond. On a
 * click path that difference is the whole budget.
 *
 * Declared structurally, like every other shape this module reads off a page,
 * and reached only after the guarded checks in {@link substringOf}.
 */
interface CharacterDataLike {
  substringData(offset: number, count: number): string;
}

/**
 * Gathers an element's own text in document order, under three budgets.
 *
 * The walk is the bounded stand-in for `textContent`, and every budget it
 * carries answers a way a page can be large (AAP 0.7.1: the agent does no
 * work that scales with the size of the document):
 *
 * - **{@link TEXT_HARVEST_WINDOW} code units.** The walk stops at the budget,
 *   and the text node that reaches it hands over only the prefix that fits
 *   ({@link textPrefixOf}) rather than its whole data.
 * - **{@link MAX_TEXT_NODES_SCANNED} nodes.** Bounds a subtree of many nodes
 *   carrying little text, where the code-unit budget would never be reached.
 * - **{@link MAX_TEXT_DEPTH} levels.** Bounds the descent, and with it the
 *   `resume` list that is the walk's only state.
 *
 * Iterative rather than recursive, and pre-order: when the walk descends into
 * an element it remembers that element's `nextSibling` in `resume`, so it
 * comes back up without reading `parentNode` and without trusting a page's
 * parent links to be consistent with its child links. Comments and processing
 * instructions are skipped, exactly as `textContent` skips them, and the
 * containers of {@link NON_RENDERED_TAG} are skipped whole.
 *
 * Every read goes through {@link readProperty}, so a replaced accessor or a
 * revoked `Proxy` ends the walk with whatever was gathered instead of throwing
 * into the page's click path.
 *
 * @param el - The element whose subtree is walked. Its own text nodes are
 * collected; the element's attributes are never read.
 * @returns The gathered text and whether anything was left unread. Empty text
 * when the element has none within the budgets.
 */
function harvestText(el: Element): HarvestedText {
  if (isNonRendered(el)) {
    return { text: '', truncated: false };
  }
  const chunks: string[] = [];
  const resume: unknown[] = [];
  let remaining = TEXT_HARVEST_WINDOW;
  let visits = 0;
  let truncated = false;
  let node: unknown = readProperty(el, 'firstChild');
  while (isNode(node) && remaining > 0 && visits < MAX_TEXT_NODES_SCANNED) {
    visits += 1;
    const nodeType = readProperty(node, 'nodeType');
    if (nodeType === TEXT_NODE || nodeType === CDATA_SECTION_NODE) {
      const prefix = textPrefixOf(node, remaining);
      chunks.push(prefix.text);
      remaining -= prefix.text.length;
      truncated = truncated || prefix.unread;
    } else if (nodeType === ELEMENT_NODE && !isNonRendered(node)) {
      const child = readProperty(node, 'firstChild');
      if (isNode(child)) {
        if (resume.length < MAX_TEXT_DEPTH) {
          resume.push(readProperty(node, 'nextSibling'));
          node = child;
          continue;
        }
        // A subtree the depth budget refused: its text was never read.
        truncated = true;
      }
    }
    let next = readProperty(node, 'nextSibling');
    while (!isNode(next) && resume.length > 0) {
      next = resume.pop();
    }
    node = next;
  }
  // A node still in hand means a budget stopped the walk rather than the end
  // of the element's own text.
  return { text: chunks.join(''), truncated: truncated || isNode(node) };
}

/**
 * Whether a value can be walked as a DOM node.
 *
 * Deliberately structural and deliberately shallow: the walk narrows each node
 * by its `nodeType` before doing anything with it, so all this has to reject
 * is the `null` that ends a sibling chain and the `undefined` a failed read or
 * an exhausted `resume` slot yields.
 */
function isNode(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/** Whether a node is one of the {@link NON_RENDERED_TAG} containers. */
function isNonRendered(node: unknown): boolean {
  return NON_RENDERED_TAG.test(tagNameOf(node));
}

/**
 * The head of a text node's data, never longer than `limit` code units.
 *
 * The node's data is *never* read whole. `CharacterData.length` is a constant-
 * time count, and `substringData` is the bounded read; a node that offers
 * neither contributes nothing and is reported as unread, because the
 * alternative — `node.data` or `node.nodeValue` — is precisely the read whose
 * cost scales with the node, and a single text node can hold megabytes. Every
 * `Text` and `CDATASection` in a browser implements both, so the refusal is a
 * guard rather than a path a page takes.
 *
 * @param node - A node already narrowed to a text or CDATA `nodeType`.
 * @param limit - Code units this read may return, always at least one.
 * @returns The prefix and whether data past it remains unread.
 */
function textPrefixOf(node: unknown, limit: number): TextPrefix {
  const declared = codeUnitLength(node);
  if (declared === 0) {
    return { text: '', unread: false };
  }
  const wanted = declared === undefined ? limit : Math.min(declared, limit);
  const read = substringOf(node, wanted);
  if (read === undefined) {
    return { text: '', unread: true };
  }
  const text = withoutTrailingHighSurrogate(read.length > limit ? read.slice(0, limit) : read);
  // With a declared length the comparison is exact; without one, a read that
  // filled the budget is assumed to have more behind it.
  const unread = declared === undefined ? text.length >= limit : declared > text.length;
  return { text, unread };
}

/** A node's `length` in code units, when it reports a usable one. */
function codeUnitLength(node: unknown): number | undefined {
  const length = readProperty(node, 'length');
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
    return undefined;
  }
  return length;
}

/**
 * `CharacterData.substringData(0, count)`, guarded.
 *
 * The method is looked up before it is called, the call is wrapped — the DOM
 * throws `IndexSizeError` for an out-of-range offset and a page may have
 * replaced the method with anything — and the result is re-checked as a string
 * rather than trusted for its declared type.
 */
function substringOf(node: unknown, count: number): string | undefined {
  if (count < 1 || typeof readProperty(node, 'substringData') !== 'function') {
    return undefined;
  }
  try {
    const read: unknown = (node as CharacterDataLike).substringData(0, count);
    return typeof read === 'string' && read.length > 0 ? read : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drops a trailing lone high surrogate.
 *
 * A read cut at a code-unit budget can split a surrogate pair, and half a pair
 * is not a character: it would travel through the descriptor as an unpaired
 * code unit. Dropping it keeps the harvest well-formed UTF-16 at no cost to
 * the label.
 */
function withoutTrailingHighSurrogate(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
}

/*
 * ---------------------------------------------------------------------------
 * Internal: selector construction
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a class name is a build artefact rather than something a developer
 * wrote, and therefore useless in a selector that has to keep resolving.
 *
 * Three shapes are rejected: a CSS-modules or BEM-with-hash suffix
 * (`styles_card__3fD9a`), a CSS-in-JS generated name (`css-1q2w3e`,
 * `sc-abcdef`), and any hyphen- or underscore-separated segment that is
 * itself hash-shaped. Legible names survive, including ones that carry a
 * digit: `grid-2`, `col-6`, `h1`.
 */
function isHashedClass(value: string): boolean {
  if (HASHED_CLASS_SUFFIX.test(value) || GENERATED_CLASS_PREFIX.test(value)) {
    return true;
  }
  for (const segment of value.split(/[-_]/)) {
    if (HASHED_CLASS_SEGMENT.test(segment)) {
      return true;
    }
  }
  return false;
}

/**
 * Up to {@link MAX_SELECTOR_CLASSES} legible class names of an element, taken
 * in document order from at most {@link MAX_CLASS_TOKENS_SCANNED} tokens.
 */
function classesFor(el: unknown): string[] {
  const kept: string[] = [];
  const attribute = classAttributeOf(el);
  if (attribute === undefined) {
    return kept;
  }
  const tokens = attribute.split(WHITESPACE_RUN);
  const scanned = Math.min(tokens.length, MAX_CLASS_TOKENS_SCANNED);
  for (let index = 0; index < scanned && kept.length < MAX_SELECTOR_CLASSES; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.length === 0 || token.length > MAX_CLASS_LENGTH) {
      continue;
    }
    if (isHashedClass(token)) {
      continue;
    }
    kept.push(token);
  }
  return kept;
}

/**
 * Escapes a value for use as a CSS identifier, preferring the platform's own
 * `CSS.escape`.
 *
 * The guard is not ceremonial: `CSS` is absent from a worker realm and from
 * some test DOMs, and this module is imported by programs that have no DOM at
 * all. {@link escapeManually} is the fallback and follows the same rules for
 * the cases that matter — a leading digit, a lone hyphen, control characters
 * and punctuation.
 */
function escapeIdentifier(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    try {
      return CSS.escape(value);
    } catch {
      // Fall through to the manual escape below.
    }
  }
  return escapeManually(value);
}

/** Conservative stand-in for `CSS.escape`. */
function escapeManually(value: string): string {
  if (value === '-') {
    return '\\-';
  }
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    const code = value.charCodeAt(index);
    // A digit that starts the identifier - or follows a leading hyphen - has to
    // be written as a code-point escape, because `#1a` is not a selector.
    const leading = index === 0 || (index === 1 && value.charAt(0) === '-');
    if ((leading && DIGIT.test(char)) || code < 0x20 || code === 0x7f) {
      escaped += `\\${code.toString(16)} `;
      continue;
    }
    escaped += SAFE_IDENTIFIER_CHAR.test(char) || code > 0x7f ? char : `\\${char}`;
  }
  return escaped;
}

/**
 * How many nodes a selector matches in a document, or `undefined` when the
 * query itself failed — an invalid selector, or a document that rejected it.
 */
function matchCount(doc: Document, selector: string): number | undefined {
  try {
    const length = readProperty(doc.querySelectorAll(selector), 'length');
    return typeof length === 'number' && Number.isFinite(length) ? length : undefined;
  } catch {
    return undefined;
  }
}

/** Whether exactly one node in the document carries this `id`. */
function isUniqueIdentifier(doc: Document | undefined, id: string): boolean {
  if (doc === undefined) {
    return false;
  }
  return matchCount(doc, `#${escapeIdentifier(id)}`) === 1;
}

/**
 * The element's 1-based position among its siblings, and how many siblings
 * were counted.
 *
 * @param sameTagOnly - Count only siblings with the same tag name, which is
 * what `:nth-of-type` means; `false` counts every element sibling, which is
 * what `:nth-child` means.
 * @returns The position, or `undefined` when the element has no parent, the
 * children cannot be read, or the parent has more than
 * {@link MAX_SIBLING_SCAN} children — a container that large is not worth a
 * scan on a click path.
 */
function positionOf(
  el: Element,
  sameTagOnly: boolean,
): { index: number; total: number } | undefined {
  const parent = parentElementOf(el);
  if (parent === undefined) {
    return undefined;
  }
  const children = readProperty(parent, 'children');
  const length = readProperty(children, 'length');
  if (typeof length !== 'number' || !Number.isInteger(length) || length > MAX_SIBLING_SCAN) {
    return undefined;
  }
  const tagName = tagNameOf(el);
  let index = 0;
  let total = 0;
  for (let position = 0; position < length; position += 1) {
    const child = readProperty(children, String(position));
    if (typeof child !== 'object' || child === null) {
      continue;
    }
    if (sameTagOnly && tagNameOf(child) !== tagName) {
      continue;
    }
    total += 1;
    if (child === el) {
      index = total;
    }
  }
  return index === 0 ? undefined : { index, total };
}

/** One selector segment: tag, legible classes, and a positional index. */
function segmentFor(el: Element): string {
  let segment = selectorTagOf(el);
  for (const className of classesFor(el)) {
    segment += `.${escapeIdentifier(className)}`;
  }
  const position = positionOf(el, true);
  if (position !== undefined && position.total > 1) {
    segment += `:nth-of-type(${position.index})`;
  }
  return segment;
}

/*
 * ---------------------------------------------------------------------------
 * Internal: React fibers
 * ---------------------------------------------------------------------------
 */

/** The fiber React associated with a host element, when one is reachable. */
function fiberFor(el: Element): Fiber | undefined {
  try {
    const fiber = getFiberFromHostInstance(el);
    return fiber === null ? undefined : fiber;
  } catch {
    return undefined;
  }
}

/** The fiber's parent, read defensively rather than through its declared type. */
function fiberParentOf(fiber: Fiber): Fiber | undefined {
  const parent = readProperty(fiber, 'return');
  if (typeof parent !== 'object' || parent === null) {
    return undefined;
  }
  return parent as Fiber;
}

/**
 * Bounded manual ascent up the `return` chain, used when bippy's traversal
 * throws. Stops when `visit` returns `true` or after
 * {@link MAX_FIBER_ASCENT} steps, so a cyclic structure cannot spin.
 */
function ascend(fiber: Fiber, visit: (node: Fiber) => boolean): void {
  let current: Fiber | undefined = fiber;
  let steps = 0;
  while (current !== undefined && steps < MAX_FIBER_ASCENT) {
    if (visit(current)) {
      return;
    }
    current = fiberParentOf(current);
    steps += 1;
  }
}

/**
 * Whether a fiber represents a component rather than a host node.
 *
 * bippy decides this from the fiber's work tag, which is the right answer; the
 * structural fallback only runs when that throws — on a fiber-shaped object
 * this module did not get from a live renderer — and then treats a non-string
 * `type` as a component, which is what distinguishes `<Row>` from
 * `<div>`.
 */
function isComponentFiber(fiber: Fiber): boolean {
  try {
    return isCompositeFiber(fiber);
  } catch {
    const type = readProperty(fiber, 'type');
    return typeof type === 'function' || (typeof type === 'object' && type !== null);
  }
}

/**
 * A component's display name, asked of the fiber's `type` first — the argument
 * bippy's helper documents — and of the fiber itself as a fallback, since the
 * helper unwraps a fiber's `type`/`render` on its own.
 *
 * A string `type` is a host tag (`'div'`), which the helper would return
 * verbatim, so it is skipped: an element's own tag name is not a component
 * name.
 */
function displayNameOf(fiber: Fiber): string | undefined {
  const type = readProperty(fiber, 'type');
  if (typeof type !== 'string') {
    const fromType = safeDisplayName(type);
    if (fromType !== undefined) {
      return fromType;
    }
  }
  return safeDisplayName(fiber);
}

/** {@link displayNameOf}'s guarded, collapsed and bounded single attempt. */
function safeDisplayName(candidate: unknown): string | undefined {
  let name: string | null;
  try {
    name = getDisplayName(candidate);
  } catch {
    return undefined;
  }
  if (typeof name !== 'string') {
    return undefined;
  }
  const collapsed = collapse(name);
  return collapsed.length > 0 ? truncate(collapsed, MAX_COMPONENT_NAME_LENGTH) : undefined;
}

/** A component name for a fiber, or `undefined` for a host or unnamed fiber. */
function componentNameOf(fiber: Fiber): string | undefined {
  if (!isComponentFiber(fiber)) {
    return undefined;
  }
  return displayNameOf(fiber);
}

/*
 * ---------------------------------------------------------------------------
 * Internal: owner hints
 * ---------------------------------------------------------------------------
 */

/** React's recorded JSX position, from the fiber or from its debug owner. */
function debugSourceFor(fiber: Fiber): OwnerDebugSource | undefined {
  const owner = readProperty(fiber, '_debugOwner');
  const candidates = [readProperty(fiber, '_debugSource'), readProperty(owner, '_debugSource')];
  for (const candidate of candidates) {
    const source = asDebugSource(candidate);
    if (source !== undefined) {
      return source;
    }
  }
  return undefined;
}

/**
 * Validates a `_debugSource`-shaped value field by field.
 *
 * `lineNumber` is required — a file without a line is not a position worth
 * carrying — and `columnNumber` is included only when it is itself a 1-based
 * integer. The file name is scrubbed and bounded like any other captured
 * string, and kept verbatim otherwise: it is React's raw path, and normalising
 * it is the service's job (see the comment above {@link ownerHintsFor}).
 */
function asDebugSource(candidate: unknown): OwnerDebugSource | undefined {
  const rawFileName = readProperty(candidate, 'fileName');
  if (typeof rawFileName !== 'string') {
    return undefined;
  }
  const fileName = truncate(scrub(collapse(rawFileName)), MAX_OWNER_STACK_CHARS);
  if (fileName.length === 0) {
    return undefined;
  }
  const lineNumber = positiveInteger(readProperty(candidate, 'lineNumber'));
  if (lineNumber === undefined) {
    return undefined;
  }
  const columnNumber = positiveInteger(readProperty(candidate, 'columnNumber'));
  return columnNumber === undefined
    ? { fileName, lineNumber }
    : { fileName, lineNumber, columnNumber };
}

/**
 * The developer-relevant frames of a React 19 owner stack, as one string.
 *
 * Both places React 19 keeps the stack are tried: the fiber's own
 * `_debugStack` and its debug owner's. Whatever is found is reduced to strings
 * immediately — the `Error` itself never leaves this function.
 */
function ownerStackFor(fiber: Fiber): string | undefined {
  const owner = readProperty(fiber, '_debugOwner');
  const candidates = [readProperty(fiber, '_debugStack'), readProperty(owner, '_debugStack')];
  for (const candidate of candidates) {
    const stack = stackTextOf(candidate);
    if (stack === undefined) {
      continue;
    }
    const frames = developerFrames(stack);
    if (frames.length === 0) {
      continue;
    }
    const text = truncate(scrub(frames.join('\n')), MAX_OWNER_STACK_CHARS);
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}

/**
 * The stack text of a `_debugStack` candidate.
 *
 * React 19 development builds store an `Error`, whose `stack` is a getter that
 * a page could have replaced — hence the guarded read. A build that stores the
 * string directly, and a value that is neither, are both handled.
 */
function stackTextOf(candidate: unknown): string | undefined {
  if (typeof candidate === 'string') {
    return candidate.length > 0 ? candidate : undefined;
  }
  const stack = readProperty(candidate, 'stack');
  return typeof stack === 'string' && stack.length > 0 ? stack : undefined;
}

/**
 * Filters a stack down to the frames that point at the developer's own code.
 *
 * Dropped: the message header (`Error`, `Error: react-stack-top-frame`), every
 * frame matching {@link STACK_FRAME_NOISE} — React's internals, the bundled
 * copies Next.js serves out of `node_modules` chunks, this agent's own
 * injected bundle, and frames with no location — and everything past
 * {@link MAX_OWNER_STACK_FRAMES} kept frames or
 * {@link MAX_STACK_LINES_SCANNED} examined lines.
 */
function developerFrames(stack: string): string[] {
  const kept: string[] = [];
  const lines = stack.split('\n');
  const scanned = Math.min(lines.length, MAX_STACK_LINES_SCANNED);
  for (let index = 0; index < scanned && kept.length < MAX_OWNER_STACK_FRAMES; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const frame = collapse(line);
    if (frame.length === 0 || !STACK_FRAME_LINE.test(frame) || STACK_FRAME_NOISE.test(frame)) {
      continue;
    }
    kept.push(frame);
  }
  return kept;
}
