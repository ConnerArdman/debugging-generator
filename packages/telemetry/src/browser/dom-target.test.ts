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

import { afterEach, describe, expect, it } from 'vitest';

import { cutAtCredentialBoundary, REDACTION_MARKER, scrub, truncate } from '../redaction/rules.js';
import {
  attachDomTarget,
  describeElement,
  detachDomTarget,
  isDomTargetAttached,
  MAX_TEXT_LENGTH,
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
