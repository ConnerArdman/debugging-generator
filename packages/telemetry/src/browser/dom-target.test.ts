/**
 * Colocated tests for `./dom-target.ts` — the element descriptor the DevTools
 * "Use selected element" flow and every interaction event carry.
 *
 * **What this suite owns.** The two properties the rest of the product cannot
 * observe for itself, and that a future edit of this module would otherwise
 * break silently:
 *
 * 1. **Bounded click-path work.** `describeElement` runs in the capture phase
 *    of the developer's own click and on every Elements-panel selection
 *    change, so it may never do work proportional to the page. The module
 *    therefore never reads `textContent` (one property access that walks and
 *    concatenates a whole subtree) and never reads a text node's `data` or
 *    `nodeValue` (which materialise the node's entire string before any slice
 *    applies). Text arrives through `CharacterData.substringData` under a
 *    code-unit budget, a node budget and a depth budget. The cases below pin
 *    each budget with instrumented nodes that count their own reads and define
 *    every forbidden whole-value accessor as a getter that throws, so a
 *    regression that reaches for one produces no label instead of passing
 *    quietly.
 * 2. **Credential safety at a budget boundary.** Every rule in
 *    `../redaction/rules.ts` identifies a credential by a whitespace-free run
 *    and needs to see that run's terminator or enough of its body; text that
 *    stops in the middle of one — because a budget ended the walk — defeats
 *    `scrub`. The descriptor is stored and can reach a model provider
 *    (AAP §0.5.2), so the module drops the unterminated word, and omits the
 *    text entirely when the whole prefix is one. The cases below split a
 *    provider key, a bearer credential and a credentialed connection string
 *    across both the node budget and the depth budget.
 *
 * Alongside those, the suite pins the descriptor contract (exactly the five
 * `SelectedTarget` fields, JSON-compliant, `text` omitted rather than empty),
 * and — because bounding the read must not change what a developer sees — a
 * differential check against the whole pre-fix text pipeline over ordinary
 * subtrees, including a generated corpus.
 *
 * The last `describe` owns the **element picker** behind "Pick element": a
 * trusted primary click picks the element it lands on and is consumed so the
 * page never sees it, untrusted events pass through untouched, Escape, a
 * cancel request, a lost relay, a newer pick and a document release each end
 * the pick exactly once, and an ended pick leaves no listener and no overlay
 * behind.
 * happy-dom constructs every event without an `isTrusted` property at all, so
 * a browser-generated event is modelled by defining `isTrusted: true` as an
 * own property before dispatch — the one field the picker reads to tell the
 * two apart — and an event dispatched without it is exactly what a page
 * script's `dispatchEvent` produces.
 *
 * **Why every credential fixture is assembled at runtime.** This file is
 * tracked, and `scripts/check-secrets.mjs` scans tracked content with the same
 * rule classes the redaction module implements, against an allowlist that does
 * not name this file. No credential prefix or body therefore appears as a
 * contiguous literal: prefixes are joined from fragments and bodies are cycled
 * from character ranges, exactly as `../redaction/rules.test.ts` does it and
 * for the same reason.
 *
 * **No wall-clock assertions.** The cost claims are asserted structurally —
 * how many reads happen and how many code units they may return — because a
 * timing threshold on a shared machine measures the machine.
 *
 * **Harness.** The root `vitest.config.ts` collects this file into the
 * `telemetry` project, which runs under happy-dom; the real-DOM cases use that
 * `document`, and the budget cases use plain objects, because the module reads
 * every page value structurally rather than through `instanceof`. Nothing here
 * imports a Node built-in: `eslint.config.js` forbids one anywhere under
 * `src/browser/**`, tests included, because this directory is bundled into the
 * page-injected agent (AAP §0.2.2, §0.7.1 Group 1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cutAtCredentialBoundary, REDACTION_MARKER, scrub, truncate } from '../redaction/rules.js';
import {
  attachDomTarget,
  cancelElementPick,
  describeElement,
  detachDomTarget,
  ELEMENT_PICK_EVENT_TYPES,
  ELEMENT_PICK_HOVER_EVENT_TYPES,
  hasElementPickResidue,
  isDomTargetAttached,
  isElementPickActive,
  MAX_TEXT_LENGTH,
  startElementPick,
  type ElementPickOutcome,
} from './dom-target.js';

// ---------------------------------------------------------------------------
// Budgets under test
//
// The module keeps these internal on purpose — they are implementation
// budgets, not part of its contract — so they are restated here with the
// margins the cases need. A case that must exceed a budget exceeds it
// generously, so the test states "past the budget" rather than "exactly at
// it", and stays true if a budget is ever widened.
// ---------------------------------------------------------------------------

/** Code units the harvest may gather (`TEXT_HARVEST_WINDOW`). */
const HARVEST_WINDOW = 4096;

/** Code units the harvest keeps for redaction (`TEXT_SCAN_WINDOW`). */
const SCAN_WINDOW = 2048;

/** Nodes the walk may visit (`MAX_TEXT_NODES_SCANNED`). */
const NODE_BUDGET = 512;

/** Levels the walk may descend (`MAX_TEXT_DEPTH`). */
const DEPTH_BUDGET = 32;

// ---------------------------------------------------------------------------
// Fixture assembly
// ---------------------------------------------------------------------------

/** The inclusive character range from `first` to `last`, by code unit. */
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

/** Base64url alphabet, the body alphabet of every token fixture here. */
const URLSAFE_CHARS = UPPER_LETTERS + LOWER_LETTERS + DIGITS + '-_';

/** A deterministic body of `length` characters cycled from `alphabet`. */
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
 * Every call site exists to keep a credential prefix from appearing as one
 * contiguous literal in this tracked file; the split points carry no other
 * meaning.
 */
function assemble(...fragments: readonly string[]): string {
  return fragments.join('');
}

/** A vendor-scoped model provider credential. */
const PROVIDER_KEY = assemble('s', 'k-', 'ant-') + cycle(URLSAFE_CHARS, 40);

/** The authentication scheme word, which survives redaction by design. */
const BEARER_SCHEME = 'Bearer';

/** An opaque bearer credential, and the header-shaped value carrying it. */
const BEARER_CREDENTIAL = cycle(URLSAFE_CHARS, 40);
const BEARER_VALUE = BEARER_SCHEME + ' ' + BEARER_CREDENTIAL;

/** A credentialed connection string: scheme, userinfo, authority. */
const CONNECTION_SCHEME = assemble('postgres', 'ql', '://');
const CONNECTION_USERINFO = 'demo_user' + ':' + cycle(LOWER_LETTERS, 12);
const CONNECTION_AUTHORITY = '127.0.0.1:5432/demo_db';
const CONNECTION_STRING = CONNECTION_SCHEME + CONNECTION_USERINFO + '@' + CONNECTION_AUTHORITY;

/**
 * Each credential, split into the part a bounded walk reads and the part it
 * never reaches, with the label that must survive in front of it.
 *
 * The split point is inside the credential's run in every case: past a
 * provider prefix, one character short of the bearer rule's minimum body, and
 * before a connection string's terminating `@`. None of the three heads is
 * something `scrub` can recognise on its own, which is exactly why the head
 * must not be emitted.
 */
const LABEL = 'Place order';

interface SplitCredential {
  /** What the case is called, in the test name. */
  readonly label: string;

  /** The part the walk reads: a run `scrub` cannot recognise on its own. */
  readonly head: string;

  /** The part beyond the budget, which completes the credential. */
  readonly tail: string;

  /** A fragment of the credential that must not appear in the descriptor. */
  readonly secret: string;

  /** The whole text the descriptor must carry instead. */
  readonly expected: string;
}

const SPLIT_CREDENTIALS: readonly SplitCredential[] = [
  {
    // Thirteen body characters: three short of the provider rule's minimum of
    // sixteen, so the head is unrecognisable and the whole word has to go.
    label: 'a model provider key',
    head: PROVIDER_KEY.slice(0, 20),
    tail: PROVIDER_KEY.slice(20),
    secret: PROVIDER_KEY.slice(7, 20),
    expected: LABEL,
  },
  {
    // Seven credential characters after the scheme word: one short of the
    // bearer rule's minimum of eight. The scheme word itself is not a secret
    // and stays, exactly as it stays through redaction.
    label: 'a bearer credential',
    head: BEARER_VALUE.slice(0, BEARER_SCHEME.length + 8),
    tail: BEARER_VALUE.slice(BEARER_SCHEME.length + 8),
    secret: BEARER_CREDENTIAL.slice(0, 7),
    expected: `${LABEL} ${BEARER_SCHEME}`,
  },
  {
    // A connection string without its terminating `@`, which is what the URL
    // rule needs before it will replace the userinfo.
    label: 'a credentialed connection string',
    head: CONNECTION_SCHEME + CONNECTION_USERINFO,
    tail: '@' + CONNECTION_AUTHORITY,
    secret: CONNECTION_USERINFO,
    expected: LABEL,
  },
];

// ---------------------------------------------------------------------------
// The pre-fix pipeline, for the differential cases
// ---------------------------------------------------------------------------

/**
 * `textOf` as it read before the walk replaced its `textContent` read, applied
 * to a real `textContent`.
 *
 * Bounding the read must not change the label a developer sees, so every
 * ordinary subtree below is required to produce exactly what this produces.
 */
function preFixText(raw: string): string | undefined {
  if (raw.length === 0) {
    return undefined;
  }
  const bounded = raw.length > SCAN_WINDOW ? cutAtCredentialBoundary(raw, SCAN_WINDOW) : raw;
  const collapsed = bounded.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return undefined;
  }
  const text = truncate(scrub(collapsed), MAX_TEXT_LENGTH);
  return text.length > 0 ? text : undefined;
}

// ---------------------------------------------------------------------------
// Instrumented page objects
//
// The module reads a page's object graph structurally, so a plain object with
// the right properties is a faithful stand-in — and unlike a real DOM node it
// can count its own reads and refuse the ones that must never happen.
// ---------------------------------------------------------------------------

/** Everything the cases below measure about one synthetic subtree. */
interface Reads {
  /** `substringData(0, count)` calls, in order, with the count requested. */
  substringCounts: number[];

  /** Code units the node reads handed back in total. */
  returned: number;

  /** `nodeType` reads, which is one per node the walk visits. */
  visits: number;
}

type PageNode = Record<string, unknown>;

function newReads(): Reads {
  return { substringCounts: [], returned: 0, visits: 0 };
}

/**
 * Defines the accessors every synthetic node shares: a counted `nodeType`, and
 * the three whole-value reads that must never happen, each of which throws so
 * that a regression fails loudly instead of quietly passing.
 */
function baseNode(nodeType: number, reads: Reads): PageNode {
  const node: PageNode = {};
  Object.defineProperty(node, 'nodeType', {
    get(): number {
      reads.visits += 1;
      return nodeType;
    },
    enumerable: true,
  });
  for (const forbidden of ['textContent', 'innerText', 'data', 'nodeValue']) {
    Object.defineProperty(node, forbidden, {
      get(): never {
        throw new Error(`dom-target read ${forbidden}, which is unbounded`);
      },
      enumerable: true,
    });
  }
  node['firstChild'] = null;
  node['nextSibling'] = null;
  return node;
}

/**
 * A text node holding `length` code units of `body`, read only through
 * `substringData`.
 *
 * `body` is repeated to reach `length`, so a twenty-million-code-unit node
 * costs the test nothing until the module asks for a prefix of it.
 */
function textNode(body: string, length: number, reads: Reads): PageNode {
  const node = baseNode(3, reads);
  Object.defineProperty(node, 'length', { value: length, enumerable: true });
  Object.defineProperty(node, 'substringData', {
    value(offset: number, count: number): string {
      reads.substringCounts.push(count);
      const available = Math.max(0, length - offset);
      const wanted = Math.min(count, available);
      let result = '';
      while (result.length < wanted) {
        result += body;
      }
      const slice = result.slice(0, wanted);
      reads.returned += slice.length;
      return slice;
    },
    enumerable: true,
  });
  return node;
}

/** A text node that offers no bounded read: `substringData` is absent. */
function unreadableTextNode(length: number, reads: Reads): PageNode {
  const node = baseNode(3, reads);
  Object.defineProperty(node, 'length', { value: length, enumerable: true });
  return node;
}

/** An element node with the given tag name. */
function elementNode(tagName: string, reads: Reads): PageNode {
  const node = baseNode(1, reads);
  node['tagName'] = tagName;
  return node;
}

/** Links `children` as a sibling chain under `parent`. */
function appendAll(parent: PageNode, children: readonly PageNode[]): PageNode {
  parent['firstChild'] = children[0] ?? null;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child !== undefined) {
      child['nextSibling'] = children[index + 1] ?? null;
    }
  }
  return parent;
}

/** A `<div>` whose children are `children`, ready to describe. */
function divWith(children: readonly PageNode[], reads: Reads): PageNode {
  return appendAll(elementNode('DIV', reads), children);
}

/**
 * A chain of `depth` nested `<div>`s under `root`, with `leaf` inside the
 * innermost one.
 */
function nest(root: PageNode, depth: number, leaf: PageNode, reads: Reads): PageNode {
  let current = root;
  for (let level = 0; level < depth; level += 1) {
    const next = elementNode('DIV', reads);
    appendAll(current, [next]);
    current = next;
  }
  appendAll(current, [leaf]);
  return root;
}

/** The descriptor's text, or the empty string when the key is absent. */
function textOf(element: unknown): string {
  return describeElement(element)?.text ?? '';
}

describe('describeElement — bounded click-path work', () => {
  it('produces a label without reading textContent, data or nodeValue', () => {
    const reads = newReads();
    const inner = appendAll(elementNode('SPAN', reads), [textNode('  Save  ', 8, reads)]);
    const root = divWith([inner, textNode(' draft\n', 7, reads)], reads);

    // Every forbidden accessor throws, so reaching this assertion at all is
    // half the point; the other half is that the label is still correct.
    expect(textOf(root)).toBe('Save draft');
    expect(reads.returned).toBe(15);
  });

  it('asks a twenty-million-code-unit text node for one bounded prefix', () => {
    const reads = newReads();
    const root = divWith([textNode('x', 20_000_000, reads)], reads);

    expect(Array.from(textOf(root)).length).toBe(MAX_TEXT_LENGTH);
    expect(reads.substringCounts).toEqual([HARVEST_WINDOW]);
    expect(reads.returned).toBe(HARVEST_WINDOW);
  });

  it('never returns more than the harvest window from a subtree of large nodes', () => {
    const reads = newReads();
    const nodes: PageNode[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      nodes.push(textNode('abcdefghi ', 1_000_000, reads));
    }
    const root = divWith(nodes, reads);

    expect(textOf(root).length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(reads.returned).toBeLessThanOrEqual(HARVEST_WINDOW);
    for (const count of reads.substringCounts) {
      expect(count).toBeLessThanOrEqual(HARVEST_WINDOW);
    }
    expect(reads.visits).toBeLessThan(NODE_BUDGET + 64);
  });

  it('stops visiting nodes at the node budget', () => {
    const reads = newReads();
    const nodes: PageNode[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      nodes.push(elementNode('SPAN', reads));
    }
    nodes.push(textNode('unreachable label', 17, reads));
    const root = divWith(nodes, reads);

    expect(textOf(root)).toBe('');
    expect(reads.visits).toBeLessThan(NODE_BUDGET + 64);
  });

  it('stops descending at the depth budget', () => {
    const reads = newReads();
    const deep = nest(
      elementNode('DIV', reads),
      DEPTH_BUDGET + 8,
      textNode('too deep to be a label', 22, reads),
      reads,
    );
    const shallow = nest(elementNode('DIV', reads), 8, textNode('nested label', 12, reads), reads);

    expect(textOf(deep)).toBe('');
    expect(textOf(shallow)).toBe('nested label');
  });

  it('skips a text node that offers no bounded read', () => {
    const reads = newReads();
    const root = divWith(
      [textNode('Label ', 6, reads), unreadableTextNode(20_000_000, reads)],
      reads,
    );

    // The readable node's text survives; the node that would have cost its
    // whole string contributes nothing.
    expect(textOf(root)).toBe('Label');
  });

  it('terminates on a cyclic sibling chain', () => {
    const reads = newReads();
    const root = elementNode('DIV', reads);
    const loop = textNode('loop ', 5, reads);
    root['firstChild'] = loop;
    loop['nextSibling'] = loop;

    expect(textOf(root).length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(reads.returned).toBeLessThanOrEqual(HARVEST_WINDOW);
  });

  it('does not let a throwing accessor escape', () => {
    const reads = newReads();
    const hostile: PageNode = {};
    Object.defineProperty(hostile, 'nodeType', {
      get(): never {
        throw new Error('nodeType is not available');
      },
      enumerable: true,
    });
    const root = divWith([hostile, textNode('after', 5, reads)], reads);

    expect(() => describeElement(root)).not.toThrow();
    expect(describeElement(root)?.tagName).toBe('div');
  });
});

describe('describeElement — credentials cut by a budget never reach the descriptor', () => {
  /** A text node holding exactly `value`. */
  function literal(value: string, reads: Reads): PageNode {
    return textNode(value, value.length, reads);
  }

  /**
   * A subtree whose text reads `${prefix}${head}${tail}`, with `tail` sitting
   * past the node budget.
   *
   * The filler nodes are *empty* text nodes: each costs a visit and
   * contributes nothing, so the budget is spent before the continuation is
   * reached while the text itself stays contiguous — the credential really is
   * split by the budget rather than separated by whitespace.
   */
  function splitAcrossNodeBudget(
    prefix: string,
    head: string,
    tail: string,
    reads: Reads,
  ): PageNode {
    const children: PageNode[] = [literal(prefix + head, reads)];
    for (let index = 0; index < NODE_BUDGET + 64; index += 1) {
      children.push(literal('', reads));
    }
    children.push(literal(tail, reads));
    return divWith(children, reads);
  }

  /** The same split, with `tail` buried below the depth budget instead. */
  function splitAcrossDepthBudget(
    prefix: string,
    head: string,
    tail: string,
    reads: Reads,
  ): PageNode {
    const buried = nest(elementNode('DIV', reads), DEPTH_BUDGET + 8, literal(tail, reads), reads);
    return divWith([literal(prefix + head, reads), buried], reads);
  }

  for (const credential of SPLIT_CREDENTIALS) {
    it(`omits ${credential.label} split across the node budget`, () => {
      const reads = newReads();
      const root = splitAcrossNodeBudget(`${LABEL} `, credential.head, credential.tail, reads);

      const text = textOf(root);

      expect(text).not.toContain(credential.secret);
      expect(text).not.toContain(credential.head);
      // The legible text in front of the credential stays.
      expect(text).toBe(credential.expected);
    });

    it(`omits ${credential.label} split across the depth budget`, () => {
      const reads = newReads();
      const root = splitAcrossDepthBudget(`${LABEL} `, credential.head, credential.tail, reads);

      const text = textOf(root);

      expect(text).not.toContain(credential.secret);
      expect(text).not.toContain(credential.head);
      expect(text).toBe(credential.expected);
    });

    it(`omits the text entirely when ${credential.label} is the whole prefix`, () => {
      const reads = newReads();
      const root = splitAcrossNodeBudget('', credential.head, credential.tail, reads);

      const descriptor = describeElement(root);

      // The element is still described - only its text is withheld, because
      // there is no part of it that can be shown safely.
      expect(descriptor?.tagName).toBe('div');
      expect('text' in (descriptor ?? {})).toBe(credential.head.includes(' '));
      expect(descriptor?.text ?? '').not.toContain(credential.secret);
    });
  }

  it('redacts the same credentials normally when nothing was cut', () => {
    const reads = newReads();
    for (const value of [PROVIDER_KEY, BEARER_VALUE, CONNECTION_STRING]) {
      const root = divWith([textNode(value, value.length, reads)], reads);

      const text = textOf(root);

      expect(text).toContain(REDACTION_MARKER);
      expect(text).not.toContain(value);
      expect(text).toBe(preFixText(value));
    }
  });

  it('keeps a complete final word when the text ends at a whitespace boundary', () => {
    const reads = newReads();
    const children: PageNode[] = [textNode('Place order now ', 16, reads)];
    for (let index = 0; index < NODE_BUDGET + 64; index += 1) {
      children.push(textNode('', 0, reads));
    }
    children.push(textNode('unreachable', 11, reads));

    // The harvest ends after "now " - in whitespace rather than inside a word -
    // so nothing has to be dropped.
    expect(textOf(divWith(children, reads))).toBe('Place order now');
  });
});

describe('describeElement — descriptor contract against a real DOM', () => {
  it('matches the pre-fix pipeline for an ordinary label', () => {
    document.body.innerHTML =
      '<button id="save-draft">  Save   <span>draft</span>\n  now </button>';
    const element = document.querySelector('#save-draft');
    expect(element).not.toBeNull();

    const descriptor = describeElement(element);

    expect(descriptor?.text).toBe('Save draft now');
    expect(descriptor?.text).toBe(preFixText(element?.textContent ?? ''));
    expect(Object.keys(descriptor ?? {}).sort()).toEqual([
      'componentChain',
      'selector',
      'tagName',
      'text',
      'url',
    ]);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    expect(document.querySelector(descriptor?.selector ?? '')).toBe(element);
  });

  it('matches the pre-fix pipeline across a subtree wider than the scan window', () => {
    document.body.innerHTML = `<div id="long">${'lorem ipsum dolor sit amet '.repeat(120)}</div>`;
    const element = document.querySelector('#long');

    expect((element?.textContent ?? '').length).toBeGreaterThan(SCAN_WINDOW);
    expect(describeElement(element)?.text).toBe(preFixText(element?.textContent ?? ''));
  });

  it('matches the pre-fix pipeline across a generated corpus', () => {
    let seed = 20_260_921;
    const random = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    const words = ['Save', 'Place order', 'Retry now', '42', '  ', 'Units', 'In stock'];
    const build = (depth: number): string => {
      let html = '';
      const children = random(4);
      for (let index = 0; index <= children; index += 1) {
        const word = words[random(words.length)] ?? 'x';
        html += depth > 0 && random(3) === 0 ? `<span>${build(depth - 1)}</span>` : ` ${word} `;
      }
      return html;
    };

    for (let iteration = 0; iteration < 200; iteration += 1) {
      document.body.innerHTML = `<div id="generated">${build(4)}</div>`;
      const element = document.querySelector('#generated');
      expect(describeElement(element)?.text).toBe(preFixText(element?.textContent ?? ''));
    }
  });

  it('collects text across an inline SVG subtree', () => {
    document.body.innerHTML =
      '<div id="chart"><svg><title>Units</title> <text>42</text></svg></div>';
    const element = document.querySelector('#chart');

    expect(describeElement(element)?.text).toBe('Units 42');
    expect(describeElement(element)?.text).toBe(preFixText(element?.textContent ?? ''));
  });

  it('skips non-rendered containers and keeps the visible label', () => {
    const payload = `self.__next_f.push(${JSON.stringify(cycle(LOWER_LETTERS, 200_000))})`;
    document.body.innerHTML =
      `<div id="wrap"><script>${payload}</script>` +
      `<style>.a{color:red}</style><span>Place order</span></div>`;

    expect(describeElement(document.querySelector('#wrap'))?.text).toBe('Place order');
  });

  it('reports no text for a selected script element', () => {
    document.body.innerHTML = `<script id="boot">const value = ${JSON.stringify(PROVIDER_KEY)};</script>`;
    const descriptor = describeElement(document.querySelector('#boot'));

    expect(descriptor?.tagName).toBe('script');
    expect('text' in (descriptor ?? {})).toBe(false);
  });

  it('omits the key for an element with no text', () => {
    document.body.innerHTML = '<div id="icon"><span></span></div>';
    const descriptor = describeElement(document.querySelector('#icon'));

    expect('text' in (descriptor ?? {})).toBe(false);
  });

  it('returns undefined for every value that is not an element', () => {
    document.body.innerHTML = '<div id="present">x</div>';
    const inputs: readonly unknown[] = [
      null,
      undefined,
      'div',
      42,
      {},
      document,
      document.createTextNode('x'),
      document.createComment('x'),
    ];

    for (const input of inputs) {
      expect(describeElement(input)).toBeUndefined();
    }
  });
});

describe('the lifecycle adapter', () => {
  // The family is document-scoped, so the agent arms it in its opening
  // sequence and leaves it armed; these cases drive it directly and hand the
  // module back in the state they found it — detached, as at import.
  afterEach(() => {
    detachDomTarget();
  });

  it('starts detached, so nothing is offered before the agent arms it', () => {
    expect(isDomTargetAttached()).toBe(false);
  });

  it('arms the family, and a second arm changes nothing', () => {
    attachDomTarget();
    expect(isDomTargetAttached()).toBe(true);

    // Idempotence is load-bearing rather than tidy: the agent re-arms the
    // document-scoped families on every `pageshow`, including the one an
    // ordinary load fires.
    attachDomTarget();
    expect(isDomTargetAttached()).toBe(true);
  });

  it('releases the family, and a second release changes nothing', () => {
    attachDomTarget();
    detachDomTarget();
    expect(isDomTargetAttached()).toBe(false);

    detachDomTarget();
    expect(isDomTargetAttached()).toBe(false);
  });

  it('is safe to release before it was ever armed, and to re-arm afterwards', () => {
    detachDomTarget();
    expect(isDomTargetAttached()).toBe(false);

    attachDomTarget();
    expect(isDomTargetAttached()).toBe(true);
  });

  it('arms in this environment, which has a document to describe against', () => {
    // The one prerequisite the adapter checks. Asserting it here is what makes
    // the flag meaningful: a host with no `document` leaves the family
    // detached, and the agent reports the capability as unavailable instead of
    // publishing a `describeTarget` that can only answer `undefined`.
    expect(typeof document).not.toBe('undefined');
    attachDomTarget();
    expect(isDomTargetAttached()).toBe(true);
  });

  it('never gates the descriptor functions, in either state', () => {
    // `./interaction.ts` calls `describeElement` in the capture phase of the
    // developer's own click and the DevTools page reaches it through the page
    // global, so the pure functions answer the same whatever the flag says —
    // what the flag governs is whether `./agent.ts` offers the capability.
    document.body.innerHTML = '<button id="place-order">Place order</button>';
    const element = document.querySelector('#place-order');

    detachDomTarget();
    const whileDetached = describeElement(element);
    attachDomTarget();
    const whileAttached = describeElement(element);

    expect(whileDetached).toEqual(whileAttached);
    expect(whileAttached?.selector).toBe('#place-order');
  });
});

// ---------------------------------------------------------------------------
// The element picker
//
// Every case drives the module directly against happy-dom's real document and
// window. "What the page sees" is read from listeners registered the way an
// application's are — capture on the element, bubble on `<body>` (where a
// React root sits) and bubble on `window` — and "what the picker left behind"
// from the page's own `addEventListener`/`removeEventListener` calls and the
// document's children, never from the module's internals.
// ---------------------------------------------------------------------------

/**
 * Mark an event as generated by the browser rather than by a page script.
 *
 * happy-dom gives a constructed event no `isTrusted` property at all, so it
 * reads `undefined` — which is the page-script case. Chrome's `isTrusted` is
 * an own, unforgeable property of every event, so an own data property set to
 * `true` is the faithful model of a real gesture, and it is the only field the
 * picker reads to tell the two apart.
 */
function asTrusted<T extends Event>(event: T): T {
  Object.defineProperty(event, 'isTrusted', { value: true });
  return event;
}

/**
 * A bubbling, cancelable, composed pointer-family event of `type`: a
 * `PointerEvent` for the `pointer*` types and a `MouseEvent` otherwise, as a
 * browser dispatches them. The primary button unless `init` says otherwise.
 */
function gestureEvent(type: string, init: MouseEventInit = {}): MouseEvent {
  const options: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ...init,
  };
  return type.startsWith('pointer')
    ? new PointerEvent(type, options)
    : new MouseEvent(type, options);
}

/** A bubbling, cancelable `keydown` for one key. */
function keydown(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true });
}

/** The nodes {@link mountTarget} builds. */
interface MountedTarget {
  readonly section: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly label: HTMLSpanElement;
}

/** `<section><button><span>Label</span></button></section>`, in the document. */
function mountTarget(): MountedTarget {
  const section = document.createElement('section');
  const button = document.createElement('button');
  const label = document.createElement('span');
  label.textContent = 'Label';
  button.appendChild(label);
  section.appendChild(button);
  document.body.appendChild(section);
  return { section, button, label };
}

/** Removes what {@link listenLikeThePage} registered; drained after each case. */
const pageListenerDisposers: (() => void)[] = [];

/**
 * Register listeners where an application would — capture on `target`, bubble
 * on `<body>` and bubble on `window` — and record every one that runs.
 *
 * @returns The record, as `‹where›:‹type›` entries in the order they ran.
 */
function listenLikeThePage(target: EventTarget, types: readonly string[]): string[] {
  const ran: string[] = [];
  for (const type of types) {
    const onTarget = (): void => {
      ran.push(`target-capture:${type}`);
    };
    const onBody = (): void => {
      ran.push(`body-bubble:${type}`);
    };
    const onWindow = (): void => {
      ran.push(`window-bubble:${type}`);
    };
    target.addEventListener(type, onTarget, { capture: true });
    document.body.addEventListener(type, onBody);
    window.addEventListener(type, onWindow);
    pageListenerDisposers.push(() => {
      target.removeEventListener(type, onTarget, { capture: true });
      document.body.removeEventListener(type, onBody);
      window.removeEventListener(type, onWindow);
    });
  }
  return ran;
}

/** Every event type the picker registers on `window`. */
const PICKER_TYPES: readonly string[] = [
  ...ELEMENT_PICK_EVENT_TYPES,
  ...ELEMENT_PICK_HOVER_EVENT_TYPES,
];

/** What {@link watchPickerRegistrations} reports and lets a case control. */
interface RegistrationWatch {
  /** The picker event types with a live registration on `window`, sorted. */
  readonly liveTypes: () => string[];
  /** Every type an add was attempted for, refused ones included, in call order. */
  readonly addsAttempted: () => string[];
  /** Make adds of one type throw before reaching the page; `undefined` stops refusing. */
  readonly refuseAddOf: (type: string | undefined) => void;
  /** Make removals of one type throw before reaching the page; `undefined` stops refusing. */
  readonly refuseRemovalOf: (type: string | undefined) => void;
}

/**
 * Stand in for the page's `window.addEventListener`/`removeEventListener`,
 * forwarding to happy-dom, and report which picker event types have a live
 * registration.
 *
 * A registration is keyed by type, listener identity and capture flag — what
 * `removeEventListener` matches on — so a removal that did not match what was
 * added leaves the registration counted. There is exactly one spy per method,
 * switched through the returned handles: a second `vi.spyOn` over an active
 * spy would make the first one's forwarding call the second one's mock.
 */
function watchPickerRegistrations(): RegistrationWatch {
  const live = new Map<string, Set<unknown>>();
  const attempted: string[] = [];
  let refusedAdd: string | undefined;
  let refusedRemoval: string | undefined;
  const keyOf = (type: string, options: boolean | EventListenerOptions | undefined): string =>
    `${type}|${String(typeof options === 'boolean' ? options : options?.capture === true)}`;
  const realAdd = window.addEventListener.bind(window);
  const realRemove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      attempted.push(type);
      if (type === refusedAdd) {
        throw new TypeError('the page will not take this listener');
      }
      realAdd(type, listener, options);
      const key = keyOf(type, options);
      const listeners = live.get(key) ?? new Set<unknown>();
      listeners.add(listener);
      live.set(key, listeners);
    },
  );
  vi.spyOn(window, 'removeEventListener').mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === refusedRemoval) {
        throw new TypeError('the page will not remove this listener');
      }
      realRemove(type, listener, options);
      live.get(keyOf(type, options))?.delete(listener);
    },
  );
  return {
    liveTypes: () =>
      [...live.entries()]
        .filter(([key, listeners]) => {
          const type = key.split('|')[0] ?? '';
          return listeners.size > 0 && PICKER_TYPES.includes(type);
        })
        .map(([key]) => key.split('|')[0] ?? '')
        .sort(),
    addsAttempted: () => [...attempted],
    refuseAddOf: (type) => {
      refusedAdd = type;
    },
    refuseRemovalOf: (type) => {
      refusedRemoval = type;
    },
  };
}

/** The picker's overlay: an `aria-hidden` `<div>` child of the root element. */
function pickerOverlays(): HTMLElement[] {
  return [...document.documentElement.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.tagName === 'DIV' &&
      child.getAttribute('aria-hidden') === 'true',
  );
}

/** The element of the single `'picked'` outcome recorded, or a failure. */
function thePickedElement(outcomes: readonly ElementPickOutcome[]): Element {
  expect(outcomes).toHaveLength(1);
  const outcome = outcomes[0];
  if (outcome?.kind !== 'picked') {
    throw new Error(
      `dom-target.test.ts: expected one picked outcome, got ${JSON.stringify(outcomes)}`,
    );
  }
  return outcome.element;
}

describe('the element picker', () => {
  /** What the pick under test reported, in order. */
  let outcomes: ElementPickOutcome[] = [];
  const record = (outcome: ElementPickOutcome): void => {
    outcomes.push(outcome);
  };

  beforeEach(() => {
    outcomes = [];
    // The agent arms the document-scoped family at `document_start`.
    attachDomTarget();
  });

  afterEach(() => {
    cancelElementPick();
    // Restored before the page's own listeners are removed and the family is
    // released, so neither goes through a case's stub.
    vi.restoreAllMocks();
    for (const dispose of pageListenerDisposers.splice(0)) {
      dispose();
    }
    detachDomTarget();
    for (const overlay of pickerOverlays()) {
      overlay.remove();
    }
    document.body.replaceChildren();
  });

  it('refuses to arm while the family is detached, and never calls back', () => {
    detachDomTarget();
    expect(startElementPick(record)).toBe(false);
    expect(isElementPickActive()).toBe(false);

    mountTarget().label.dispatchEvent(asTrusted(gestureEvent('click')));
    expect(outcomes).toEqual([]);
  });

  it('picks the nested element a trusted primary click lands on, then ends', () => {
    const { label } = mountTarget();
    expect(startElementPick(record)).toBe(true);
    expect(isElementPickActive()).toBe(true);

    label.dispatchEvent(asTrusted(gestureEvent('click')));

    expect(thePickedElement(outcomes)).toBe(label);
    expect(isElementPickActive()).toBe(false);
  });

  it('resolves a click inside an open shadow root to the inner element, not its host', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const inner = document.createElement('strong');
    host.attachShadow({ mode: 'open' }).appendChild(inner);
    startElementPick(record);

    inner.dispatchEvent(asTrusted(gestureEvent('click')));

    expect(thePickedElement(outcomes)).toBe(inner);
  });

  it('consumes the whole picking gesture before any page listener sees it', () => {
    const { label } = mountTarget();
    const gestureTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    const ran = listenLikeThePage(label, gestureTypes);
    startElementPick(record);

    const gesture = gestureTypes.map((type) => asTrusted(gestureEvent(type)));
    for (const event of gesture) {
      label.dispatchEvent(event);
    }

    // Capture on the element, bubble on `<body>` and bubble on `window`: none
    // of the page's handlers ran for any part of the gesture, and no default
    // action — focus, activation, submission, navigation — is left to happen.
    expect(ran).toEqual([]);
    for (const event of gesture) {
      expect(event.defaultPrevented, event.type).toBe(true);
    }
    expect(thePickedElement(outcomes)).toBe(label);
  });

  it('lets untrusted events through untouched: no pick, no cancel, no suppression', () => {
    const { label } = mountTarget();
    const ran = listenLikeThePage(label, ['click', 'keydown']);
    startElementPick(record);

    const scriptedClick = gestureEvent('click');
    label.dispatchEvent(scriptedClick);
    const scriptedEscape = keydown('Escape');
    label.dispatchEvent(scriptedEscape);

    expect(scriptedClick.defaultPrevented).toBe(false);
    expect(scriptedEscape.defaultPrevented).toBe(false);
    expect(ran).toEqual([
      'target-capture:click',
      'body-bubble:click',
      'window-bubble:click',
      'target-capture:keydown',
      'body-bubble:keydown',
      'window-bubble:keydown',
    ]);
    expect(outcomes).toEqual([]);
    expect(isElementPickActive()).toBe(true);
  });

  it('consumes every pointer and mouse type of another button without picking', () => {
    const { label } = mountTarget();
    const pointerTypes = ELEMENT_PICK_EVENT_TYPES.filter((type) => type !== 'keydown');
    const ran = listenLikeThePage(label, pointerTypes);
    startElementPick(record);

    // The secondary button: a right-click's press, release, auxclick and
    // context menu, plus a click and a double click reported for it.
    const events = pointerTypes.map((type) => asTrusted(gestureEvent(type, { button: 2 })));
    for (const event of events) {
      label.dispatchEvent(event);
    }

    expect(ran).toEqual([]);
    for (const event of events) {
      expect(event.defaultPrevented, event.type).toBe(true);
    }
    expect(outcomes).toEqual([]);
    expect(isElementPickActive()).toBe(true);
  });

  it('cancels on Escape and consumes the key', () => {
    const { button } = mountTarget();
    const ran = listenLikeThePage(button, ['keydown']);
    startElementPick(record);

    const escape = asTrusted(keydown('Escape'));
    button.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(ran).toEqual([]);
    expect(outcomes).toEqual([{ kind: 'cancelled', reason: 'escape' }]);
    expect(isElementPickActive()).toBe(false);
  });

  it('passes every other key through, so a keyboard-activated click picks', () => {
    const { button } = mountTarget();
    const ran = listenLikeThePage(button, ['keydown']);
    startElementPick(record);

    const enter = asTrusted(keydown('Enter'));
    button.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(ran).toEqual(['target-capture:keydown', 'body-bubble:keydown', 'window-bubble:keydown']);
    expect(isElementPickActive()).toBe(true);

    // Enter on a focused button makes the browser dispatch its own trusted
    // click with the primary button and no pointer (`detail: 0`): the keyboard
    // path picks exactly as a pointer click does, and is consumed like one.
    const activation = asTrusted(gestureEvent('click', { detail: 0 }));
    button.dispatchEvent(activation);
    expect(activation.defaultPrevented).toBe(true);
    expect(thePickedElement(outcomes)).toBe(button);
  });

  it('ends as a request when cancelled, exactly once', () => {
    startElementPick(record);

    expect(cancelElementPick()).toBe(true);
    expect(outcomes).toEqual([{ kind: 'cancelled', reason: 'request' }]);
    expect(isElementPickActive()).toBe(false);

    expect(cancelElementPick()).toBe(false);
    expect(outcomes).toHaveLength(1);
  });

  it('ends as relay-lost when the relay goes, handing the next click back and staying attached', () => {
    const { label } = mountTarget();
    const ran = listenLikeThePage(label, ['click']);
    startElementPick(record);

    expect(cancelElementPick('relay-lost')).toBe(true);
    expect(outcomes).toEqual([{ kind: 'cancelled', reason: 'relay-lost' }]);
    expect(isElementPickActive()).toBe(false);
    expect(hasElementPickResidue()).toBe(false);

    // Unlike `'released'`, only the pick ended: the family stays attached, the
    // developer's next click is the page's again, and a new pick can arm.
    expect(isDomTargetAttached()).toBe(true);
    const click = asTrusted(gestureEvent('click'));
    label.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(ran).toEqual(['target-capture:click', 'body-bubble:click', 'window-bubble:click']);
    expect(outcomes).toHaveLength(1);
    expect(startElementPick(record)).toBe(true);
  });

  it('supersedes the pick in flight, telling it before the new one arms', () => {
    const { label } = mountTarget();
    const first: ElementPickOutcome[] = [];
    let activeWhenFirstWasTold: boolean | undefined;
    startElementPick((outcome) => {
      first.push(outcome);
      activeWhenFirstWasTold = isElementPickActive();
    });

    expect(startElementPick(record)).toBe(true);
    expect(first).toEqual([{ kind: 'cancelled', reason: 'superseded' }]);
    expect(activeWhenFirstWasTold).toBe(false);

    label.dispatchEvent(asTrusted(gestureEvent('click')));
    expect(thePickedElement(outcomes)).toBe(label);
    expect(first).toHaveLength(1);
  });

  it('ends as released when the family detaches, and cannot re-arm until attached', () => {
    startElementPick(record);

    detachDomTarget();

    expect(outcomes).toEqual([{ kind: 'cancelled', reason: 'released' }]);
    expect(isElementPickActive()).toBe(false);
    expect(startElementPick(record)).toBe(false);

    attachDomTarget();
    expect(startElementPick(record)).toBe(true);
  });

  it('leaves no listener behind once the pick has settled', () => {
    const registrations = watchPickerRegistrations();
    const { label } = mountTarget();
    startElementPick(record);
    expect(registrations.liveTypes()).toEqual([...PICKER_TYPES].sort());

    label.dispatchEvent(asTrusted(gestureEvent('click')));

    expect(registrations.liveTypes()).toEqual([]);
    expect(hasElementPickResidue()).toBe(false);

    // And behaviourally: the next trusted gesture reaches the page untouched.
    const ran = listenLikeThePage(label, ['pointerdown', 'click']);
    const later = [asTrusted(gestureEvent('pointerdown')), asTrusted(gestureEvent('click'))];
    for (const event of later) {
      label.dispatchEvent(event);
      expect(event.defaultPrevented, event.type).toBe(false);
    }
    expect(ran).toHaveLength(6);
    expect(outcomes).toHaveLength(1);
  });

  it('highlights the hovered element with an inert overlay, and removes it when the pick ends', () => {
    const { section, button } = mountTarget();
    const measure = vi
      .spyOn(button, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(20, 10, 30, 40));
    startElementPick(record);

    // Created lazily, and never for a scripted hover.
    expect(pickerOverlays()).toEqual([]);
    button.dispatchEvent(gestureEvent('pointerover'));
    expect(pickerOverlays()).toEqual([]);

    button.dispatchEvent(asTrusted(gestureEvent('pointerover')));
    const [overlay] = pickerOverlays();
    if (overlay === undefined) {
      throw new Error('dom-target.test.ts: a trusted hover showed no overlay');
    }
    expect(overlay.parentNode).toBe(document.documentElement);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.style.getPropertyValue('pointer-events')).toBe('none');
    expect(overlay.style.getPropertyValue('position')).toBe('fixed');
    expect(overlay.style.getPropertyValue('z-index')).toBe('2147483647');
    expect(overlay.style.getPropertyValue('top')).toBe('10px');
    expect(overlay.style.getPropertyValue('left')).toBe('20px');
    expect(overlay.style.getPropertyValue('width')).toBe('30px');
    expect(overlay.style.getPropertyValue('height')).toBe('40px');

    // A scroll moves the element under a still pointer; the overlay follows.
    measure.mockReturnValue(new DOMRect(20, 4, 30, 40));
    document.dispatchEvent(asTrusted(new Event('scroll', { bubbles: true })));
    expect(overlay.style.getPropertyValue('top')).toBe('4px');

    // Moving to another element reuses the one overlay.
    section.dispatchEvent(asTrusted(gestureEvent('mouseover')));
    expect(pickerOverlays()).toEqual([overlay]);

    // The overlay is never the pick: a click that reaches it resolves to the
    // next element of its path.
    overlay.dispatchEvent(asTrusted(gestureEvent('click')));
    expect(thePickedElement(outcomes)).toBe(document.documentElement);

    expect(overlay.isConnected).toBe(false);
    expect(pickerOverlays()).toEqual([]);
    expect(hasElementPickResidue()).toBe(false);
  });

  it('reports a listener the page would not remove as residue, inert, and clears it on the next teardown', () => {
    const registrations = watchPickerRegistrations();
    registrations.refuseRemovalOf('click');
    startElementPick(record);
    cancelElementPick();

    expect(outcomes).toEqual([{ kind: 'cancelled', reason: 'request' }]);
    expect(registrations.liveTypes()).toEqual(['click']);
    expect(hasElementPickResidue()).toBe(true);

    // The surviving registration is inert: a trusted click is not consumed.
    const { label } = mountTarget();
    const click = asTrusted(gestureEvent('click'));
    label.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(outcomes).toHaveLength(1);

    // The document's release retries it.
    registrations.refuseRemovalOf(undefined);
    detachDomTarget();
    expect(registrations.liveTypes()).toEqual([]);
    expect(hasElementPickResidue()).toBe(false);
  });

  it('adopts a surviving registration instead of adding a second one', () => {
    const registrations = watchPickerRegistrations();
    registrations.refuseRemovalOf('click');
    startElementPick(record);
    cancelElementPick();
    registrations.refuseRemovalOf(undefined);

    const clickAdds = (): number =>
      registrations.addsAttempted().filter((type) => type === 'click').length;
    const addsBefore = clickAdds();
    startElementPick(record);

    // Adding again would put two consuming listeners on one gesture.
    expect(clickAdds()).toBe(addsBefore);
    const { label } = mountTarget();
    label.dispatchEvent(asTrusted(gestureEvent('click')));
    expect(outcomes[0]).toEqual({ kind: 'cancelled', reason: 'request' });
    expect(thePickedElement(outcomes.slice(1))).toBe(label);
    expect(registrations.liveTypes()).toEqual([]);
    expect(hasElementPickResidue()).toBe(false);
  });

  it('refuses to arm, leaving nothing registered, when the page will not take a consuming listener', () => {
    const registrations = watchPickerRegistrations();
    registrations.refuseAddOf('mousedown');

    expect(startElementPick(record)).toBe(false);

    // Every consuming type was attempted — the refusal did not stop the loop —
    // and everything that did register was removed again.
    expect(registrations.addsAttempted()).toEqual(
      expect.arrayContaining([...ELEMENT_PICK_EVENT_TYPES]),
    );
    expect(registrations.liveTypes()).toEqual([]);
    expect(isElementPickActive()).toBe(false);
    expect(hasElementPickResidue()).toBe(false);
    expect(outcomes).toEqual([]);
  });
});
