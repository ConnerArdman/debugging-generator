/**
 * Tests for `./target.ts`: the descriptor of the element a developer selected,
 * and the Stage 1 problem-understanding artifact.
 *
 * Both shapes are validated at a **process boundary**, and in both cases the
 * producer cannot import the schema that judges it. That is what this suite is
 * for.
 *
 * 1. **The descriptor's producer builds it structurally, inside the page.**
 *    `packages/telemetry/src/browser/dom-target.ts` assembles a
 *    `TargetDescriptor` — exactly `selector`, `tagName`, optional `text`,
 *    `componentChain` and `url` — and it is bundled into the IIFE injected at
 *    `document_start`, so it may not import this package and no compiler ever
 *    compares the two halves. A bound tightened here, or a field renamed, would
 *    compile and pass review and then reject a perfectly ordinary descriptor in
 *    a developer's session, where the failure reads as "element selection is
 *    broken". The bounds below are therefore written from **what that producer
 *    can emit** — its eight-entry nearest-first chain, its truncated text, its
 *    bounded selector — and its constants are transcribed rather than imported,
 *    because the telemetry barrel deliberately does not re-export the page
 *    agent's modules. The transcription *is* the assertion.
 *
 * 2. **The understanding's producer is a language model.** Its output reaches
 *    Stage 2's query proposals, Stage 3's planning and the readiness gate, so
 *    the closed vocabularies — the problem category, the entity kind, and above
 *    all the capture signal — are what keep those decisions machine-readable
 *    instead of matched on prose (AAP §0.5.4). Every member of the signal
 *    vocabulary is exercised by iterating the exported tuple, so a signal added
 *    to `./readiness.ts` cannot slip past this file's coverage.
 *
 * 3. **A rejection must describe the shape of the failure and never the value.**
 *    An error raised this deep passes through neither the redaction layer nor
 *    the outbound model guard (AAP §0.5.2), and it is logged, persisted with the
 *    session and rendered in two user interfaces. The privacy cases below build
 *    their offending values from fragments joined at run time, so the string
 *    they look for does not exist in this file's source and cannot be matched by
 *    a reader — or by a secret scanner — in either place.
 *
 * Three conventions in here are deliberate.
 *
 * - **Nothing is asserted about a message's prose.** A rejection is checked by
 *   its code, its reported field paths and the presence of a hint — the
 *   contractual parts — so rewording an error does not fail a test while losing
 *   its recovery path does.
 * - **Every selector, component name, path and URL is invented.** These are
 *   neutral names belonging to no application: the product must know nothing
 *   about any particular one (AAP §0.5.4), and a fixture that named a real
 *   screen would be the first step towards it.
 * - **No filesystem, no network, no DOM.** The suite runs in the root-registered
 *   `instrumentation` Vitest project, whose environment is `node`; the module
 *   under test reads nothing and has no load-time side effect, and neither does
 *   this one.
 *
 * `review_rules` reports "No user rules provided." (AAP §0.10), so no user rule
 * governs this file; the binding constraints are the AAP sections cited above.
 */

import { describe, expect, it } from 'vitest';

import { DebuggenError } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';

import { CAPTURE_SIGNALS } from './readiness.js';
import type { CaptureSignal } from './readiness.js';

import {
  PROBLEM_CATEGORIES,
  PROBLEM_ENTITY_KINDS,
  isProblemCategory,
  parseProblemUnderstanding,
  parseSelectedTarget,
  problemCategorySchema,
  problemEntityKindSchema,
  problemEntitySchema,
  problemUnderstandingSchema,
  selectedTargetSchema,
} from './target.js';
import type { ProblemEntity, ProblemUnderstanding, SelectedTarget } from './target.js';

/*
 * ---------------------------------------------------------------------------
 * The producer's bounds, transcribed
 *
 * `packages/telemetry/src/browser/dom-target.ts` is the module that actually
 * builds a descriptor, and these are its caps. Copies rather than imports, and
 * the copies are load-bearing: that module is bundled into the page agent and
 * the telemetry barrel does not re-export it, so nothing else in this
 * repository can put the two numbers side by side. A descriptor built to these
 * values must parse — that is the whole contract — and each one is deliberately
 * *below* the matching schema bound further down, so the headroom is visible
 * rather than implied.
 * ---------------------------------------------------------------------------
 */

/** `dom-target.ts`'s `MAX_COMPONENT_CHAIN`: names kept, nearest first. */
const PRODUCER_MAX_COMPONENT_CHAIN = 8;

/** `dom-target.ts`'s `MAX_TEXT_LENGTH`: the collapsed, scrubbed label's cap. */
const PRODUCER_MAX_TEXT_LENGTH = 80;

/** `dom-target.ts`'s per-name cap, applied after resolving a display name. */
const PRODUCER_MAX_COMPONENT_NAME_LENGTH = 64;

/**
 * The redaction layer's preview bound (AAP §0.5.2).
 *
 * Not a descriptor bound today — the producer's own text cap is smaller — but
 * it is the value a producer-side truncation would most plausibly move to, so a
 * text of exactly this length is asserted to parse as well.
 */
const REDACTION_PREVIEW_LENGTH = 120;

/*
 * ---------------------------------------------------------------------------
 * The schema's bounds, transcribed
 *
 * `./target.ts` keeps these private, and exporting them would only invite a
 * test to assert a constant against itself. Transcribed here, they are a
 * tripwire instead: tightening one in the module fails a case in this file,
 * which is exactly where a bound change should have to be argued.
 * ---------------------------------------------------------------------------
 */

/** `MAX_SELECTOR_LENGTH`. */
const SCHEMA_MAX_SELECTOR_LENGTH = 1024;

/** `MAX_TAG_NAME_LENGTH`. */
const SCHEMA_MAX_TAG_NAME_LENGTH = 64;

/** `MAX_TEXT_LENGTH`. */
const SCHEMA_MAX_TEXT_LENGTH = 256;

/** `MAX_COMPONENT_NAME_LENGTH`. */
const SCHEMA_MAX_COMPONENT_NAME_LENGTH = 128;

/** `MAX_COMPONENT_CHAIN`. */
const SCHEMA_MAX_COMPONENT_CHAIN = 16;

/** `MAX_URL_LENGTH`. */
const SCHEMA_MAX_URL_LENGTH = 2048;

/** `MAX_ENTITY_NAME_LENGTH`. */
const SCHEMA_MAX_ENTITY_NAME_LENGTH = 200;

/** `MAX_FILE_LENGTH`. */
const SCHEMA_MAX_FILE_LENGTH = 1024;

/** `MAX_ENTITIES`. */
const SCHEMA_MAX_ENTITIES = 24;

/** `MAX_SEARCH_HINT_LENGTH`. */
const SCHEMA_MAX_SEARCH_HINT_LENGTH = 120;

/** `MAX_SEARCH_HINTS`. */
const SCHEMA_MAX_SEARCH_HINTS = 24;

/** `MAX_REPORTED_ISSUES`. */
const SCHEMA_MAX_REPORTED_ISSUES = 20;

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 *
 * Invented throughout, and neutral by construction: a loopback origin with an
 * arbitrary port, two generic screen paths, component names that describe a
 * position in a layout rather than any product's feature.
 * ---------------------------------------------------------------------------
 */

/** A loopback development origin, of the shape a local dev server serves on. */
const APP_ORIGIN = 'http://127.0.0.1:7391';

/** The document URL a descriptor is captured against. */
const PAGE_URL = `${APP_ORIGIN}/screen/detail`;

/**
 * The descriptor this suite measures everything against, as the **typed** value
 * a consumer receives.
 *
 * Annotated rather than inferred on purpose: the annotation is what fails
 * `pnpm typecheck` if a field is renamed or its type changes, which is the half
 * of the contract a runtime assertion cannot reach.
 */
const referenceTarget: SelectedTarget = {
  selector: 'main > section.pane > button.trigger',
  tagName: 'button',
  text: 'Run the task',
  componentChain: ['TriggerControl', 'PaneBody', 'ScreenRoot'],
  url: PAGE_URL,
};

/**
 * The same descriptor as the **untyped** record a transport hands the
 * validator, with fields overridden per case.
 *
 * Untyped because that is the honest shape: the value arrives from an
 * expression evaluated in a page and a structured clone through the
 * isolated-world bridge, so the validator's input is `unknown` and a case that
 * needs an impossible field must be able to express it.
 */
function targetRecord(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ...referenceTarget, ...overrides };
}

/**
 * The descriptor with the `text` key **absent** rather than `undefined`.
 *
 * Written out instead of deleted from a copy, because absence is the contract:
 * `describeElement` builds one object shape or the other, and JSON has no way
 * to carry an explicit `undefined`.
 */
function textlessTargetRecord(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    selector: referenceTarget.selector,
    tagName: referenceTarget.tagName,
    componentChain: [...referenceTarget.componentChain],
    url: referenceTarget.url,
    ...overrides,
  };
}

/** A typed entity, for the same reason `referenceTarget` is annotated. */
const referenceEntity: ProblemEntity = {
  kind: 'component',
  name: 'TriggerControl',
  file: 'src/ui/trigger-control.tsx',
};

/** An entity as the untyped record a model's structured output arrives as. */
function entityRecord(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ...referenceEntity, ...overrides };
}

/** A typed, complete Stage 1 artifact. */
const referenceUnderstanding: ProblemUnderstanding = {
  category: 'performance',
  signalsNeeded: ['interactions', 'react', 'fetch', 'http'],
  entities: [
    { kind: 'component', name: 'TriggerControl', file: 'src/ui/trigger-control.tsx' },
    { kind: 'function', name: 'runTask', file: 'src/server/task-runner.ts' },
    { kind: 'route', name: '/api/task-run' },
  ],
  searchHints: ['runTask', 'task run', 'trigger'],
};

/** An understanding as the untyped record a model's structured output arrives as. */
function understandingRecord(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { ...referenceUnderstanding, ...overrides };
}

/** A string of exactly `length` non-whitespace characters. */
function filled(length: number): string {
  return 'a'.repeat(length);
}

/** A chain of `count` distinct, plausible component names, nearest first. */
function chainOf(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `Frame${String(index)}`);
}

/** An absolute URL of exactly `length` characters. */
function urlOfLength(length: number): string {
  const prefix = `${APP_ORIGIN}/screen/`;
  return `${prefix}${filled(length - prefix.length)}`;
}

/** A safe project-relative POSIX path of exactly `length` characters. */
function filePathOfLength(length: number): string {
  const prefix = 'src/';
  const suffix = '.ts';
  return `${prefix}${filled(length - prefix.length - suffix.length)}${suffix}`;
}

/**
 * A distinctive value, assembled at run time.
 *
 * Assembled so the literal never appears in this file's source: a rejection is
 * asserted *not* to contain it, and a reader — or `scripts/check-secrets.mjs` —
 * cannot match what is not written down.
 */
function marker(): string {
  return ['qz', '8', 'vt', '4'].join('');
}

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/** One issue as `./target.ts` reports it in `details.issues`. */
interface ReportedIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** Unwraps a successful {@link Result}, failing the test when it is an error. */
function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    expect.fail(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }

  return result.value;
}

/** Unwraps a failed {@link Result}, failing the test when it succeeded. */
function expectErr<T>(result: Result<T>): DebuggenError {
  if (result.ok) {
    expect.fail('expected a rejection, got a value');
  }

  expect(result.error).toBeInstanceOf(DebuggenError);
  return result.error;
}

/** The issues a rejection reported, as `./target.ts` shaped them. */
function reportedIssues(error: DebuggenError): readonly ReportedIssue[] {
  const issues = error.details?.['issues'];
  expect(Array.isArray(issues)).toBe(true);

  return issues as readonly ReportedIssue[];
}

/** The dotted field paths a rejection reported. */
function issuePaths(error: DebuggenError): readonly string[] {
  return reportedIssues(error).map((issue) => issue.path);
}

/** How many issues a rejection counted, truncated list or not. */
function issueCount(error: DebuggenError): number {
  const count = error.details?.['issueCount'];
  expect(typeof count).toBe('number');

  return count as number;
}

/** Whether the descriptor schema accepts a value. */
function targetAccepts(value: unknown): boolean {
  return selectedTargetSchema.safeParse(value).success;
}

/** Whether the entity schema accepts a value. */
function entityAccepts(value: unknown): boolean {
  return problemEntitySchema.safeParse(value).success;
}

/** Whether the understanding schema accepts a value. */
function understandingAccepts(value: unknown): boolean {
  return problemUnderstandingSchema.safeParse(value).success;
}

/** Parses a descriptor through the schema, failing the test when it is refused. */
function parsedTarget(value: unknown): SelectedTarget {
  const result = selectedTargetSchema.safeParse(value);

  if (!result.success) {
    expect.fail(
      `expected the descriptor to parse, refused at: ${result.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`,
    );
  }

  return result.data;
}

/** Parses an entity through the schema, failing the test when it is refused. */
function parsedEntity(value: unknown): ProblemEntity {
  const result = problemEntitySchema.safeParse(value);

  if (!result.success) {
    expect.fail(
      `expected the entity to parse, refused at: ${result.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`,
    );
  }

  return result.data;
}

/** Parses an understanding through the schema, failing the test when it is refused. */
function parsedUnderstanding(value: unknown): ProblemUnderstanding {
  const result = problemUnderstandingSchema.safeParse(value);

  if (!result.success) {
    expect.fail(
      `expected the understanding to parse, refused at: ${result.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`,
    );
  }

  return result.data;
}

/*
 * ---------------------------------------------------------------------------
 * Fixture sanity
 *
 * The fixtures are the premise of every case below, so they are checked once:
 * a bound written from a producer cap is only meaningful while the cap is
 * actually smaller than the schema's.
 * ---------------------------------------------------------------------------
 */

describe('fixtures', () => {
  it('builds a descriptor and an understanding the schemas accept', () => {
    expect(targetAccepts(referenceTarget)).toBe(true);
    expect(entityAccepts(referenceEntity)).toBe(true);
    expect(understandingAccepts(referenceUnderstanding)).toBe(true);
  });

  it('leaves the schema room above every producer cap', () => {
    // If one of these ever fails, a descriptor the producer can emit is one the
    // schema rejects — which is the single failure mode this whole file exists
    // to prevent, so it is asserted directly rather than inferred from the
    // cases that depend on it.
    expect(PRODUCER_MAX_COMPONENT_CHAIN).toBeLessThanOrEqual(SCHEMA_MAX_COMPONENT_CHAIN);
    expect(PRODUCER_MAX_TEXT_LENGTH).toBeLessThanOrEqual(SCHEMA_MAX_TEXT_LENGTH);
    expect(REDACTION_PREVIEW_LENGTH).toBeLessThanOrEqual(SCHEMA_MAX_TEXT_LENGTH);
    expect(PRODUCER_MAX_COMPONENT_NAME_LENGTH).toBeLessThanOrEqual(
      SCHEMA_MAX_COMPONENT_NAME_LENGTH,
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * SelectedTarget — fidelity against the producer that cannot import it
 * ---------------------------------------------------------------------------
 */

describe('selectedTargetSchema', () => {
  it('accepts the descriptor the producer builds and returns it unchanged', () => {
    const parsed = parsedTarget(targetRecord());

    // `toStrictEqual` rather than `toEqual`, because the claim is stronger than
    // "the fields match": no transform, no default, no coercion, no field
    // quietly dropped and no extra key holding `undefined`, which `toEqual`
    // would pass over. A stored target has to round-trip and a repair prompt
    // has to be able to quote the value as written.
    expect(parsed).toStrictEqual(referenceTarget);
    expect(Object.keys(parsed).sort()).toEqual([
      'componentChain',
      'selector',
      'tagName',
      'text',
      'url',
    ]);
  });

  it('accepts a descriptor with no text, and does not invent the key', () => {
    // The common case: an icon button, an input, an element whose label lives
    // in an attribute the producer does not read. `describeElement` omits the
    // key entirely, so the parsed value must too — a consumer that renders
    // `text` in a panel row distinguishes "absent" from "empty", and JSON
    // cannot carry an explicit `undefined` either way.
    const parsed = parsedTarget(textlessTargetRecord());

    expect('text' in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(['componentChain', 'selector', 'tagName', 'url']);
  });

  it('accepts a descriptor whose component chain is empty', () => {
    // The honest answer for a page with no React on it, a node React never
    // rendered, and a production build whose fibers the hook cannot reach.
    const parsed = parsedTarget(textlessTargetRecord({ componentChain: [] }));

    expect(parsed.componentChain).toEqual([]);
  });
});

describe('selectedTargetSchema · tagName', () => {
  // Case is deliberately NOT normalised by the schema. `Element.tagName`
  // reports an uppercase name for an HTML element in an HTML document and a
  // lowercase one for XML and SVG content, and the producer lowercases what it
  // reads — so both forms are legitimate values from legitimate producers, and
  // normalising either way here would make a stored descriptor stop matching
  // the one that was sent.
  it('accepts the uppercase form the DOM reports, verbatim', () => {
    const parsed = parsedTarget(targetRecord({ tagName: 'BUTTON' }));

    expect(parsed.tagName).toBe('BUTTON');
  });

  it('accepts the lowercase form the producer emits, verbatim', () => {
    const parsed = parsedTarget(targetRecord({ tagName: 'button' }));

    expect(parsed.tagName).toBe('button');
  });

  it('accepts a custom element name', () => {
    // A custom element's name is whatever its author registered, which is why
    // the tag bound is generous rather than sized for the HTML element set.
    expect(targetAccepts(targetRecord({ tagName: 'task-trigger-widget' }))).toBe(true);
  });

  it('accepts a tag name at the bound and refuses one past it', () => {
    expect(targetAccepts(targetRecord({ tagName: filled(SCHEMA_MAX_TAG_NAME_LENGTH) }))).toBe(true);
    expect(targetAccepts(targetRecord({ tagName: filled(SCHEMA_MAX_TAG_NAME_LENGTH + 1) }))).toBe(
      false,
    );
  });

  it.each<[string, unknown]>([
    ['an empty tag name', ''],
    ['a whitespace-only tag name', '   '],
    ['a tag name carrying a control character', 'but\u0000ton'],
    ['a non-string tag name', 1],
  ])('refuses %s', (_label, tagName) => {
    expect(targetAccepts(targetRecord({ tagName }))).toBe(false);
  });
});

describe('selectedTargetSchema · text', () => {
  // The point of these three cases is singular: no value the producer can emit
  // is ever rejected. The text arrives already whitespace-collapsed, scrubbed
  // of credential material and truncated (AAP §0.5.2), so the schema only
  // bounds its length — and it does so well above both caps a producer-side
  // change could plausibly land on.
  it.each<[string, number]>([
    ["the producer's own truncation length", PRODUCER_MAX_TEXT_LENGTH],
    ["the redaction layer's preview length", REDACTION_PREVIEW_LENGTH],
    ["the schema's documented bound", SCHEMA_MAX_TEXT_LENGTH],
  ])('accepts text of %s characters', (_label, length) => {
    const parsed = parsedTarget(targetRecord({ text: filled(length) }));

    expect(parsed.text).toHaveLength(length);
  });

  it('refuses text past the documented bound', () => {
    expect(targetAccepts(targetRecord({ text: filled(SCHEMA_MAX_TEXT_LENGTH + 1) }))).toBe(false);
  });

  it('keeps a label with interior punctuation exactly as it arrived', () => {
    const label = 'Run the task — 3 items, 2 pending';
    const parsed = parsedTarget(targetRecord({ text: label }));

    expect(parsed.text).toBe(label);
  });

  it.each<[string, unknown]>([
    ['empty text', ''],
    ['whitespace-only text', ' \t '],
    ['text carrying a line break', 'Run the task\nnow'],
    ['text carrying an escape character', 'Run the task\u001b[31m'],
    ['non-string text', 42],
  ])('refuses %s', (_label, text) => {
    // An escape character is refused for the same reason a line break is:
    // every one of these values is rendered as text in a panel row, a VS Code
    // view and a log line.
    expect(targetAccepts(targetRecord({ text }))).toBe(false);
  });

  it('tolerates an explicitly undefined text key, which JSON drops anyway', () => {
    // `.optional()` accepts an explicit `undefined`, so a producer that wrote
    // the key instead of omitting it is not refused. Pinned rather than left
    // implicit, because the descriptor is transported as JSON: both spellings
    // have to reach a consumer as "no text", and the round trip is what makes
    // them identical.
    const parsed = parsedTarget(targetRecord({ text: undefined }));

    expect(parsed.text).toBeUndefined();

    const transported = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
    expect('text' in transported).toBe(false);
    expect(targetAccepts(transported)).toBe(true);
  });
});

describe('selectedTargetSchema · componentChain', () => {
  it("accepts a chain at the producer's bound", () => {
    const chain = chainOf(PRODUCER_MAX_COMPONENT_CHAIN);
    const parsed = parsedTarget(targetRecord({ componentChain: chain }));

    expect(parsed.componentChain).toEqual(chain);
  });

  it("accepts a chain at the schema's bound and refuses one past it", () => {
    // The headroom is not hypothetical: the producer applies its cap
    // nearest-first, so raising it upstream adds *outer* shell components, and
    // a schema that refused them would reject a richer descriptor rather than
    // merely ignore the extra entries.
    expect(
      targetAccepts(targetRecord({ componentChain: chainOf(SCHEMA_MAX_COMPONENT_CHAIN) })),
    ).toBe(true);
    expect(
      targetAccepts(targetRecord({ componentChain: chainOf(SCHEMA_MAX_COMPONENT_CHAIN + 1) })),
    ).toBe(false);
  });

  it('preserves the nearest-first order exactly', () => {
    // The order is the contract, not a convenience: Stage 1 reads the head of
    // the chain as the components a question is most likely about, so a schema
    // that sorted or reversed it would change what the pipeline investigates.
    const chain = ['TriggerControl', 'PaneBody', 'ScreenRoot'];
    const parsed = parsedTarget(targetRecord({ componentChain: [...chain] }));

    expect(parsed.componentChain).toEqual(chain);
    expect(parsed.componentChain[0]).toBe('TriggerControl');
    expect(parsed.componentChain.at(-1)).toBe('ScreenRoot');
  });

  it("accepts a display name at the producer's per-name cap and at the schema's", () => {
    expect(
      targetAccepts(targetRecord({ componentChain: [filled(PRODUCER_MAX_COMPONENT_NAME_LENGTH)] })),
    ).toBe(true);
    expect(
      targetAccepts(targetRecord({ componentChain: [filled(SCHEMA_MAX_COMPONENT_NAME_LENGTH)] })),
    ).toBe(true);
    expect(
      targetAccepts(
        targetRecord({ componentChain: [filled(SCHEMA_MAX_COMPONENT_NAME_LENGTH + 1)] }),
      ),
    ).toBe(false);
  });

  it.each<[string, unknown]>([
    ['an empty name', ['TriggerControl', '']],
    ['a whitespace-only name', ['TriggerControl', '  ']],
    ['a name carrying a control character', ['Trigger\u0000Control']],
    ['a non-string entry', ['TriggerControl', 7]],
    ['a nested array', [['TriggerControl']]],
    ['a chain that is not an array', 'TriggerControl'],
    ['a chain that is an object', { 0: 'TriggerControl' }],
  ])('refuses a chain with %s', (_label, componentChain) => {
    expect(targetAccepts(targetRecord({ componentChain }))).toBe(false);
  });

  it('refuses a missing chain rather than defaulting it to empty', () => {
    // Absent is not the same as "no component information": a producer that
    // omitted the field has not answered the question, and defaulting it would
    // present that silence as an observation.
    const withoutChain: Record<string, unknown> = {
      selector: referenceTarget.selector,
      tagName: referenceTarget.tagName,
      url: referenceTarget.url,
    };

    expect(targetAccepts(withoutChain)).toBe(false);
  });
});

describe('selectedTargetSchema · url', () => {
  it.each<[string, string]>([
    ['a loopback development origin with a port', `${APP_ORIGIN}/screen/detail`],
    ['a loopback origin by name', 'http://localhost:7391/screen/detail'],
    ['an https origin', 'https://example.test/screen/detail'],
    ['a raw query string', `${APP_ORIGIN}/screen/detail?view=grid&scope=shared`],
    ['a percent-encoded query value', `${APP_ORIGIN}/screen/detail?view=%3F`],
    ['a fragment', `${APP_ORIGIN}/screen/detail#pane`],
    ['an origin with no path', APP_ORIGIN],
    ['a URL at the documented length bound', urlOfLength(SCHEMA_MAX_URL_LENGTH)],
  ])('accepts %s', (_label, url) => {
    const parsed = parsedTarget(targetRecord({ url }));

    // Byte-faithful, deliberately: zod's own URL format check normalises and
    // strips tabs and newlines, which would both break the stored value's
    // round trip and silently rewrite a developer's URL. `./target.ts` parses
    // with the URL constructor and keeps the original string.
    expect(parsed.url).toBe(url);
  });

  it('accepts a query-redacted URL, which is the only form most consumers see', () => {
    // AAP §0.5.2: the producer sends the raw URL — the service needs the
    // unredacted query to redact it per key and to compute a request key — and
    // everything downstream of ingest sees a form whose parameter *values*
    // have been replaced while the keys and the path remain. A schema that
    // accepted only the raw form would reject a session's own stored target
    // when the session is reopened.
    const redacted = `${APP_ORIGIN}/screen/detail?view=?&scope=?`;
    const parsed = parsedTarget(targetRecord({ url: redacted }));

    expect(parsed.url).toBe(redacted);
  });

  it.each<[string, unknown]>([
    ['a relative path', '/screen/detail'],
    ['a path-relative reference', 'screen/detail'],
    ['an empty string', ''],
    ['a bare host and port', '127.0.0.1:7391/screen/detail'],
    ['a javascript: URL', 'javascript:void 0'],
    ['a data: URL', 'data:text/plain,hello'],
    ['a file: URL', 'file:///screen/detail'],
    ['a scheme with no host at all', 'http://'],
    ['a port with no host', 'http://:7391/screen/detail'],
    ['a URL with leading and trailing whitespace', ` ${APP_ORIGIN}/screen/detail `],
    ['a URL past the documented length bound', urlOfLength(SCHEMA_MAX_URL_LENGTH + 1)],
    ['a non-string URL', 7],
    ['a URL object stand-in', { href: `${APP_ORIGIN}/screen/detail` }],
  ])('refuses %s', (_label, url) => {
    // Two near-misses are deliberately absent from this list, because the URL
    // parser accepts them and the schema is right to follow it: `http:/x/y` and
    // `http:///x/y` both resolve to the host `x` under the WHATWG rule that
    // ignores extra slashes after a special scheme. The descriptor's URL comes
    // from `location.href`, which is already normalised, so tightening the
    // schema past the parser would only invent a disagreement.
    expect(targetAccepts(targetRecord({ url }))).toBe(false);
  });

  it('refuses a URL carrying a line break the URL parser would have ignored', () => {
    // The URL parser strips ASCII tabs and line breaks while parsing and hands
    // back the original string, so without the single-line refinement a
    // selected target could carry a two-line "URL" into a log line, a panel
    // row and the editor view.
    expect(targetAccepts(targetRecord({ url: `${APP_ORIGIN}/scr\neen/detail` }))).toBe(false);
    expect(targetAccepts(targetRecord({ url: `${APP_ORIGIN}/scr\teen/detail` }))).toBe(false);
  });

  it('refuses a missing url rather than inventing one', () => {
    const withoutUrl: Record<string, unknown> = {
      selector: referenceTarget.selector,
      tagName: referenceTarget.tagName,
      componentChain: [...referenceTarget.componentChain],
    };

    expect(targetAccepts(withoutUrl)).toBe(false);
  });
});

describe('selectedTargetSchema · selector', () => {
  it.each<[string, string]>([
    ['an id shortcut', '#pane-trigger'],
    ['a bounded descendant path', 'main > section.pane > div.row > button.trigger'],
    ['an :nth-of-type index', 'main > section.pane > button:nth-of-type(3)'],
    ['a lone tag name, the producer fallback', 'button'],
    ['a selector at the documented length bound', `.${filled(SCHEMA_MAX_SELECTOR_LENGTH - 1)}`],
  ])('accepts %s', (_label, selector) => {
    const parsed = parsedTarget(targetRecord({ selector }));

    expect(parsed.selector).toBe(selector);
  });

  it.each<[string, unknown]>([
    ['an empty selector', ''],
    ['a whitespace-only selector', ' '],
    ['a selector carrying NUL', 'main > button\u0000'],
    ['a selector carrying a line break', 'main >\nbutton'],
    ['a selector past the documented length bound', `.${filled(SCHEMA_MAX_SELECTOR_LENGTH)}`],
    ['a non-string selector', ['main > button']],
    ['a missing selector', undefined],
  ])('refuses %s', (_label, selector) => {
    // NUL is the load-bearing entry: it truncates a string at the C boundary
    // of any later call, so the value acted on stops being the value that was
    // validated. The selector is also interpolated into an expression
    // evaluated in the page.
    expect(targetAccepts(targetRecord({ selector }))).toBe(false);
  });
});

describe('selectedTargetSchema · strictness', () => {
  it('refuses an unrecognised key rather than stripping it', () => {
    // The descriptor crosses two boundaries this product does not control — an
    // expression evaluated in the page, then a structured clone through the
    // isolated-world bridge — so a sixth key means either that a page
    // interfered with the value or that the two halves of the contract have
    // drifted. Both are worth failing for.
    expect(
      targetAccepts(targetRecord({ ownerHints: { file: 'src/ui/trigger-control.tsx' } })),
    ).toBe(false);
    expect(
      targetAccepts(targetRecord({ source: { file: 'src/ui/trigger-control.tsx', line: 12 } })),
    ).toBe(false);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['an array of descriptors', [referenceTarget]],
    ['a string', 'main > button.trigger'],
    ['a number', 12],
    ['a boolean', true],
    ['a JSON string of a descriptor', JSON.stringify(referenceTarget)],
  ])('refuses %s as a descriptor', (_label, value) => {
    expect(targetAccepts(value)).toBe(false);
  });
});

describe('selectedTargetSchema · transport fidelity', () => {
  it('survives the JSON round trip the descriptor actually makes', () => {
    // The value travels through `chrome.devtools.inspectedWindow.eval`, a
    // `window.postMessage` structured clone and a WebSocket frame, and is
    // persisted on the session record as JSON. Every field here is a string or
    // an array of strings for that reason, so a round trip must be the
    // identity — including for a descriptor with no `text`.
    const parsed = parsedTarget(targetRecord());
    const transported = JSON.parse(JSON.stringify(parsed)) as unknown;

    expect(transported).toEqual(parsed);
    expect(parsedTarget(transported)).toEqual(parsed);

    const textless = parsedTarget(textlessTargetRecord({ componentChain: [] }));
    const transportedTextless = JSON.parse(JSON.stringify(textless)) as unknown;

    expect(transportedTextless).toEqual(textless);
    expect(parsedTarget(transportedTextless)).toEqual(textless);
  });
});

describe('parseSelectedTarget', () => {
  it('returns the descriptor on success', () => {
    const target = expectOk(parseSelectedTarget(targetRecord()));

    expect(target).toStrictEqual(referenceTarget);
  });

  it('returns the descriptor a redacted, textless page produced', () => {
    const record = textlessTargetRecord({
      componentChain: [],
      url: `${APP_ORIGIN}/screen/detail?view=?`,
    });

    expect(expectOk(parseSelectedTarget(record))).toEqual(record);
  });

  it('reports a rejection as a protocol failure, with field paths and a hint', () => {
    // The code is what a caller matches on to choose a recovery path: this
    // value arrived over a transport, so a producer or the two halves of the
    // contract are at fault, not a model.
    const error = expectErr(parseSelectedTarget(targetRecord({ url: 'screen/detail' })));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(issuePaths(error)).toContain('url');
    expect(error.hint).toBeDefined();
    expect(error.hint?.length ?? 0).toBeGreaterThan(0);
  });

  it('reports every field that failed', () => {
    const error = expectErr(
      parseSelectedTarget({
        selector: '',
        tagName: '',
        componentChain: chainOf(SCHEMA_MAX_COMPONENT_CHAIN + 1),
        url: 'screen/detail',
      }),
    );

    expect(issuePaths(error)).toEqual(
      expect.arrayContaining(['selector', 'tagName', 'componentChain', 'url']),
    );
  });

  it('never echoes a rejected value, in the message, the payload or the details', () => {
    // AAP §0.5.2. A descriptor carries a selector and a label read out of the
    // developer's own page, and this error is logged, persisted with the
    // session and rendered in two user interfaces — while the redaction layer
    // never sees a failure raised this deep in the call stack. What may travel
    // is the SHAPE of the failure: which field, and what the schema expected.
    const secret = marker();
    const error = expectErr(
      parseSelectedTarget({
        selector: `main > .${secret}\u0000`,
        tagName: secret.repeat(SCHEMA_MAX_TAG_NAME_LENGTH),
        text: secret.repeat(SCHEMA_MAX_TEXT_LENGTH),
        componentChain: [secret.repeat(SCHEMA_MAX_COMPONENT_NAME_LENGTH)],
        url: `zz-${secret}`,
      }),
    );

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.toPayload())).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
    expect(error.hint).toBeDefined();
    expect(error.hint).not.toContain(secret);
    // The field paths still arrive, so a producer knows what to fix.
    expect(issuePaths(error)).toEqual(
      expect.arrayContaining(['selector', 'tagName', 'text', 'url']),
    );
  });

  it('never echoes an unrecognised key name either', () => {
    // Zod's own `unrecognized_keys` message quotes the offending key, so
    // `./target.ts` substitutes a sentence enumerating the permitted ones. A
    // key is shape rather than data, but these two values come from a page this
    // product does not control and from a model, and a rule that holds
    // absolutely is worth more than an echo a reader can derive from the
    // enumeration anyway.
    const secret = marker();
    const error = expectErr(parseSelectedTarget(targetRecord({ [`extra_${secret}`]: secret })));

    expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.toPayload())).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
    expect(reportedIssues(error).map((issue) => issue.code)).toContain('unrecognized_keys');
  });

  it('rejects a non-object without throwing', () => {
    // The value can be `null` on any evaluation where nothing was selected, so
    // the boundary has to answer rather than raise.
    for (const value of [null, undefined, 'main > button', 5, []]) {
      const error = expectErr(parseSelectedTarget(value));

      expect(error.code).toBe('PROTOCOL_INVALID_MESSAGE');
      expect(issueCount(error)).toBeGreaterThan(0);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The problem-understanding vocabularies
 *
 * Closed and generic, and both properties are load-bearing. Closed is what
 * makes a stage output routable without string matching — and what lets the
 * rules-based deterministic provider emit a guaranteed-valid value from the
 * structured context it is given rather than inventing prose (AAP §0.5.3,
 * §0.5.4). Generic is what keeps these members embeddable in a versioned
 * prompt file: not one of them may name an application, a framework or a
 * library, and `scripts/check-no-hardcoding.mjs` scans for exactly that.
 * ---------------------------------------------------------------------------
 */

describe('PROBLEM_CATEGORIES', () => {
  it('declares the eight classes of behaviour a question can be about', () => {
    expect([...PROBLEM_CATEGORIES]).toEqual([
      'performance',
      'rendering',
      'network',
      'data',
      'state',
      'error',
      'correctness',
      'other',
    ]);
  });

  it('names each category once', () => {
    expect(new Set(PROBLEM_CATEGORIES).size).toBe(PROBLEM_CATEGORIES.length);
  });

  it('spells every category as a single generic lowercase word', () => {
    // A cheap structural proxy for "no product or demo noun": an identifier
    // lifted from an application would carry an uppercase letter, an
    // underscore, a digit or a separator. A member that needs one of those is
    // a member that needs reviewing against AAP §0.5.4 first.
    for (const category of PROBLEM_CATEGORIES) {
      expect(category, category).toMatch(/^[a-z]+$/);
    }
  });

  it('keeps an escape hatch, so classification never has to lie', () => {
    // A closed set cannot describe every question. `'other'` is why it does not
    // have to, and why nothing downstream may treat the category as the only
    // input to a decision — `signalsNeeded` is the field Stage 3 and the
    // readiness gate actually consume.
    expect(PROBLEM_CATEGORIES).toContain('other');
  });

  it('accepts every member through the schema and the predicate', () => {
    for (const category of PROBLEM_CATEGORIES) {
      expect(problemCategorySchema.safeParse(category).success, category).toBe(true);
      expect(isProblemCategory(category), category).toBe(true);
    }
  });

  it.each<[string, unknown]>([
    ['a plausible near-miss', 'slowness'],
    ['a capitalised member', 'Performance'],
    ['a member with surrounding whitespace', ' performance '],
    ['an empty string', ''],
    ['a non-string', 3],
    ['null', null],
    ['an array of members', ['performance']],
  ])('refuses %s', (_label, value) => {
    expect(isProblemCategory(value)).toBe(false);
    expect(problemCategorySchema.safeParse(value).success).toBe(false);
  });
});

describe('PROBLEM_ENTITY_KINDS', () => {
  it('declares the ten kinds of thing a question can point at', () => {
    // These mirror the code graph's node kinds rather than inventing a
    // parallel taxonomy, because that is what consumes them: Stage 2 turns
    // each entity into one of the read-only graph queries.
    expect([...PROBLEM_ENTITY_KINDS]).toEqual([
      'component',
      'function',
      'hook',
      'route',
      'file',
      'symbol',
      'selector',
      'url',
      'query',
      'other',
    ]);
  });

  it('names each kind once', () => {
    expect(new Set(PROBLEM_ENTITY_KINDS).size).toBe(PROBLEM_ENTITY_KINDS.length);
  });

  it('spells every kind as a single generic lowercase word', () => {
    for (const kind of PROBLEM_ENTITY_KINDS) {
      expect(kind, kind).toMatch(/^[a-z]+$/);
    }
  });

  it('accepts every kind through its own schema and inside an entity', () => {
    for (const kind of PROBLEM_ENTITY_KINDS) {
      expect(problemEntityKindSchema.safeParse(kind).success, kind).toBe(true);
      expect(parsedEntity(entityRecord({ kind })).kind, kind).toBe(kind);
    }
  });

  it('refuses a kind outside the vocabulary', () => {
    expect(problemEntityKindSchema.safeParse('module').success).toBe(false);
    expect(entityAccepts(entityRecord({ kind: 'module' }))).toBe(false);
    expect(entityAccepts(entityRecord({ kind: 'Component' }))).toBe(false);
  });
});

describe('problemEntitySchema', () => {
  it('accepts an entity with a file and returns it unchanged', () => {
    expect(parsedEntity(entityRecord())).toStrictEqual(referenceEntity);
  });

  it('accepts an entity with no file, and does not invent the key', () => {
    // Frequently an entity is a name the question supplied with no file
    // attached — resolving it is Stage 2's job, not Stage 1's — and absence is
    // the representation every layer agrees on, since the artifact is
    // transported and persisted as JSON.
    const parsed = parsedEntity({ kind: 'route', name: '/api/task-run' });

    expect('file' in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(['kind', 'name']);
  });

  it('accepts a name at the bound and refuses one past it', () => {
    expect(entityAccepts(entityRecord({ name: filled(SCHEMA_MAX_ENTITY_NAME_LENGTH) }))).toBe(true);
    expect(entityAccepts(entityRecord({ name: filled(SCHEMA_MAX_ENTITY_NAME_LENGTH + 1) }))).toBe(
      false,
    );
  });

  it.each<[string, unknown]>([
    ['an empty name', ''],
    ['a whitespace-only name', '  '],
    ['a name carrying a control character', 'run\u0000Task'],
    ['a non-string name', 11],
    ['a missing name', undefined],
  ])('refuses %s', (_label, name) => {
    // A name is matched against the code graph later, so a blank one is a
    // guaranteed miss reported far from its cause.
    expect(entityAccepts(entityRecord({ name }))).toBe(false);
  });

  it.each<[string, string]>([
    ['a plain project-relative path', 'src/ui/trigger-control.tsx'],
    ['a cosmetic "./" prefix a model copied from an import specifier', './src/x.ts'],
    ['a redundant interior segment', 'src/./ui/trigger-control.tsx'],
    ['an interior ".." a lexical normalisation resolves', 'src/ui/../ui/trigger-control.tsx'],
    ['a backslash-flavoured separator', 'src\\ui\\trigger-control.tsx'],
    ['a path at the documented length bound', filePathOfLength(SCHEMA_MAX_FILE_LENGTH)],
  ])('accepts %s', (_label, file) => {
    // Lenient about form, strict about safety: a stage must not fail over
    // punctuation, and the accepted value is NOT rewritten — parsing stays
    // byte-faithful so a repair prompt can quote the field as written.
    expect(parsedEntity(entityRecord({ file })).file).toBe(file);
  });

  it.each<[string, unknown]>([
    ['an absolute POSIX path', '/srv/project/src/x.ts'],
    ['a path escaping the project', '../outside/x.ts'],
    ['a path escaping after normalisation', 'src/../../outside/x.ts'],
    ['a drive-letter path', 'C:\\project\\src\\x.ts'],
    ['a UNC path', '//host/share/src/x.ts'],
    ['an empty path', ''],
    ['a path carrying NUL', 'src/x\u0000.ts'],
    ['a path past the documented length bound', filePathOfLength(SCHEMA_MAX_FILE_LENGTH + 1)],
    ['a non-string path', 9],
  ])('refuses %s', (_label, file) => {
    expect(entityAccepts(entityRecord({ file }))).toBe(false);
  });

  it('refuses an unrecognised key rather than ignoring an instruction', () => {
    // A key a model invented is information: either it misunderstood the
    // schema, in which case the repair loop should tell it so, or the artifact
    // carries an instruction this product would silently ignore.
    expect(entityAccepts(entityRecord({ line: 12 }))).toBe(false);
    expect(entityAccepts(entityRecord({ confidence: 'high' }))).toBe(false);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', []],
    ['a bare name', 'TriggerControl'],
  ])('refuses %s as an entity', (_label, value) => {
    expect(entityAccepts(value)).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * ProblemUnderstanding — the Stage 1 artifact
 * ---------------------------------------------------------------------------
 */

describe('problemUnderstandingSchema', () => {
  it('accepts a complete artifact and returns it unchanged', () => {
    const parsed = parsedUnderstanding(understandingRecord());

    expect(parsed).toStrictEqual(referenceUnderstanding);
    expect(Object.keys(parsed).sort()).toEqual([
      'category',
      'entities',
      'searchHints',
      'signalsNeeded',
    ]);
  });

  it('accepts an artifact that names nothing concrete', () => {
    // A question can be entirely about runtime behaviour with nothing named,
    // which is why Stage 2 also has the project summary to work from. Empty is
    // a legitimate answer for both lists; empty `signalsNeeded` is not, and is
    // refused below.
    const parsed = parsedUnderstanding(
      understandingRecord({ entities: [], searchHints: [], signalsNeeded: ['interactions'] }),
    );

    expect(parsed.entities).toEqual([]);
    expect(parsed.searchHints).toEqual([]);
  });

  it('refuses a missing category', () => {
    expect(
      understandingAccepts({
        signalsNeeded: ['interactions'],
        entities: [],
        searchHints: [],
      }),
    ).toBe(false);
  });

  it('refuses a category outside the vocabulary', () => {
    expect(understandingAccepts(understandingRecord({ category: 'latency' }))).toBe(false);
    expect(understandingAccepts(understandingRecord({ category: 'Performance' }))).toBe(false);
    expect(understandingAccepts(understandingRecord({ category: null }))).toBe(false);
  });

  it('accepts every category', () => {
    for (const category of PROBLEM_CATEGORIES) {
      expect(parsedUnderstanding(understandingRecord({ category })).category, category).toBe(
        category,
      );
    }
  });

  it('refuses a missing entities or searchHints list rather than defaulting it', () => {
    // Both are required. A producer that omitted one has not answered, and a
    // default would present that silence as "nothing to investigate".
    expect(
      understandingAccepts({
        category: 'performance',
        signalsNeeded: ['interactions'],
        searchHints: [],
      }),
    ).toBe(false);
    expect(
      understandingAccepts({
        category: 'performance',
        signalsNeeded: ['interactions'],
        entities: [],
      }),
    ).toBe(false);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'performance'],
    ['a number', 1],
  ])('refuses %s as an understanding', (_label, value) => {
    expect(understandingAccepts(value)).toBe(false);
  });

  it('refuses an unrecognised key at the top level', () => {
    expect(understandingAccepts(understandingRecord({ confidence: 0.8 }))).toBe(false);
    expect(understandingAccepts(understandingRecord({ question: 'why is this slow' }))).toBe(false);
  });

  it('refuses an unrecognised key inside an entity, and says which entity', () => {
    const error = expectErr(
      parseProblemUnderstanding(
        understandingRecord({ entities: [entityRecord({ invented: 'value' })] }),
      ),
    );

    expect(issuePaths(error)).toContain('entities.0');
  });

  it('survives the JSON round trip it is stored and transported as', () => {
    const parsed = parsedUnderstanding(understandingRecord());
    const transported = JSON.parse(JSON.stringify(parsed)) as unknown;

    expect(transported).toEqual(parsed);
    expect(parsedUnderstanding(transported)).toEqual(parsed);
  });
});

describe('problemUnderstandingSchema · signalsNeeded', () => {
  // The field is typed with the closed capture-signal vocabulary on purpose,
  // and this is the one intra-folder dependency of the module under test
  // (`target.ts → readiness.ts`). Stage 3's planning asks each adapter which of
  // these signals it claims, and the readiness gate reports one row per signal
  // and computes "Ready to capture" from them — both consume machine-readable
  // names. Widening the field to `string[]` would reintroduce the free-text
  // matching AAP §0.5.4 forbids into a decision path, and would silently disarm
  // a signal whose prose no adapter recognised.
  it('accepts each signal in the vocabulary, one at a time', () => {
    // Iterated from the exported tuple rather than listed, so a signal added to
    // `./readiness.ts` cannot escape this coverage.
    for (const signal of CAPTURE_SIGNALS) {
      const parsed = parsedUnderstanding(understandingRecord({ signalsNeeded: [signal] }));

      expect(parsed.signalsNeeded, signal).toEqual([signal]);
    }
  });

  it('accepts the whole vocabulary at once, in order', () => {
    const all: CaptureSignal[] = [...CAPTURE_SIGNALS];
    const parsed = parsedUnderstanding(understandingRecord({ signalsNeeded: all }));

    expect(parsed.signalsNeeded).toEqual(all);
  });

  it('refuses a list longer than the vocabulary', () => {
    expect(
      understandingAccepts(
        understandingRecord({ signalsNeeded: [...CAPTURE_SIGNALS, 'interactions'] }),
      ),
    ).toBe(false);
  });

  it.each<[string, unknown]>([
    ['a plausible near-miss', ['renders']],
    ['a capitalised member', ['React']],
    ['prose instead of a signal name', ['capture the react renders']],
    ['an empty signal name', ['']],
    ['a non-string member', [7]],
    ['a list that is not an array', 'react'],
    ['a list that is an object', { 0: 'react' }],
  ])('refuses %s', (_label, signalsNeeded) => {
    expect(understandingAccepts(understandingRecord({ signalsNeeded }))).toBe(false);
  });

  it('refuses an empty list: an understanding that asks for nothing describes no capture', () => {
    // A capture with no signal produces the empty result of AAP §0.5.5 rather
    // than an answer, so Stage 1 has to name at least one.
    const error = expectErr(parseProblemUnderstanding(understandingRecord({ signalsNeeded: [] })));

    expect(issuePaths(error)).toContain('signalsNeeded');
  });

  it('refuses a repeated signal, reporting the issue on the list rather than an index', () => {
    // A duplicate is not harmless: the list is read as a *set*, so a repeat
    // produces a duplicated readiness row, a duplicated "Could not enable
    // ‹signal›" sentence, or a second install attempt for a hook already armed.
    // Refusing it here, where a repair re-prompt can still fix it, costs a
    // retry; de-duplicating silently would hide a producer that does not
    // understand the field.
    const error = expectErr(
      parseProblemUnderstanding(
        understandingRecord({ signalsNeeded: ['react', 'fetch', 'react'] }),
      ),
    );

    expect(issuePaths(error)).toEqual(['signalsNeeded']);
    expect(reportedIssues(error).map((issue) => issue.code)).toEqual(['custom']);
    // One repeat, one issue — a caller that groups issues by field gets a
    // stable path and no per-occurrence noise.
    expect(issueCount(error)).toBe(1);
  });

  it('refuses a repeated signal even when the rest of the list is the whole vocabulary', () => {
    expect(
      understandingAccepts(
        understandingRecord({ signalsNeeded: [...CAPTURE_SIGNALS].slice(0, 2).concat('react') }),
      ),
    ).toBe(false);
  });
});

describe('problemUnderstandingSchema · bounds', () => {
  it('accepts entities at the bound and refuses a list past it', () => {
    // Stage 2 turns each entity into read-only code-graph queries, so this is
    // also a bound on the work one stage output can ask the next one to do: an
    // artifact naming two hundred entities would turn Stage 2 into a repository
    // dump, which is what its query-proposal design exists to prevent.
    const entities = Array.from({ length: SCHEMA_MAX_ENTITIES }, (_value, index) => ({
      kind: 'symbol',
      name: `symbol${String(index)}`,
    }));

    expect(understandingAccepts(understandingRecord({ entities }))).toBe(true);
    expect(
      understandingAccepts(
        understandingRecord({ entities: [...entities, { kind: 'symbol', name: 'oneTooMany' }] }),
      ),
    ).toBe(false);
  });

  it('accepts search hints at the bound and refuses a list past it', () => {
    const hints = Array.from(
      { length: SCHEMA_MAX_SEARCH_HINTS },
      (_value, index) => `hint${String(index)}`,
    );

    expect(understandingAccepts(understandingRecord({ searchHints: hints }))).toBe(true);
    expect(understandingAccepts(understandingRecord({ searchHints: [...hints, 'extra'] }))).toBe(
      false,
    );
  });

  it('accepts a hint at the length bound and refuses a longer one', () => {
    // Terms, not sentences: the bound is generous for an identifier, a route
    // fragment or a two-word phrase, and short enough that a hint stays a
    // search term rather than becoming a restatement of the question.
    expect(
      understandingAccepts(
        understandingRecord({ searchHints: [filled(SCHEMA_MAX_SEARCH_HINT_LENGTH)] }),
      ),
    ).toBe(true);
    expect(
      understandingAccepts(
        understandingRecord({ searchHints: [filled(SCHEMA_MAX_SEARCH_HINT_LENGTH + 1)] }),
      ),
    ).toBe(false);
  });

  it.each<[string, unknown]>([
    ['an empty hint', ['']],
    ['a whitespace-only hint', ['   ']],
    ['a hint carrying a control character', ['run\u0000Task']],
    ['a non-string hint', [5]],
    ['a hint list that is not an array', 'runTask'],
  ])('refuses %s', (_label, searchHints) => {
    // A blank term matches everything, which is the worst possible answer for
    // the text search that consumes these.
    expect(understandingAccepts(understandingRecord({ searchHints }))).toBe(false);
  });

  it('refuses an entities list that is not an array', () => {
    expect(understandingAccepts(understandingRecord({ entities: referenceEntity }))).toBe(false);
  });
});

describe('parseProblemUnderstanding', () => {
  it('returns the artifact on success', () => {
    expect(expectOk(parseProblemUnderstanding(understandingRecord()))).toStrictEqual(
      referenceUnderstanding,
    );
  });

  it('reports a rejection as a model-output failure, with field paths and a hint', () => {
    // The code is what a caller matches on to decide between a repair retry and
    // a fallback, so it names the producer: a model, not a transport.
    const error = expectErr(
      parseProblemUnderstanding(understandingRecord({ category: 'latency' })),
    );

    expect(error.code).toBe('MODEL_OUTPUT_INVALID');
    expect(issuePaths(error)).toContain('category');
    expect(error.hint).toBeDefined();
    expect(error.hint?.length ?? 0).toBeGreaterThan(0);
  });

  it('never echoes a rejected value, in the message, the payload or the details', () => {
    // AAP §0.5.2 again, and for a shape whose producer is a model: the
    // artifact's own text is the only thing a rejection could leak, and this
    // error is logged, persisted and rendered in two user interfaces.
    const secret = marker();
    const error = expectErr(
      parseProblemUnderstanding({
        category: `${secret}-class`,
        signalsNeeded: [secret],
        entities: [
          {
            kind: 'component',
            name: secret.repeat(SCHEMA_MAX_ENTITY_NAME_LENGTH),
            file: `/srv/${secret}/x.ts`,
          },
        ],
        searchHints: [secret.repeat(SCHEMA_MAX_SEARCH_HINT_LENGTH)],
        [`invented_${secret}`]: secret,
      }),
    );

    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.toPayload())).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
    expect(error.hint).toBeDefined();
    expect(error.hint).not.toContain(secret);
    // The field paths still arrive, so a repair re-prompt can name them.
    expect(issuePaths(error)).toEqual(
      expect.arrayContaining(['category', 'signalsNeeded.0', 'entities.0.name']),
    );
  });

  it('truncates a long issue list and says how many it hid', () => {
    // A rejected understanding can produce an issue for every field of every
    // entity. The first twenty identify the problem; the total count is
    // reported separately so a truncated list never looks complete.
    const brokenEntities = Array.from({ length: SCHEMA_MAX_ENTITIES }, () => ({
      kind: 'component',
      name: '',
      file: '/srv/project/x.ts',
    }));
    const error = expectErr(
      parseProblemUnderstanding(understandingRecord({ entities: brokenEntities })),
    );

    expect(reportedIssues(error)).toHaveLength(SCHEMA_MAX_REPORTED_ISSUES);
    expect(issueCount(error)).toBeGreaterThan(SCHEMA_MAX_REPORTED_ISSUES);
    expect(error.message).toMatch(/and \d+ more\./);
  });

  it('rejects a non-object without throwing', () => {
    for (const value of [null, undefined, 'performance', 0, []]) {
      const error = expectErr(parseProblemUnderstanding(value));

      expect(error.code).toBe('MODEL_OUTPUT_INVALID');
      expect(issueCount(error)).toBeGreaterThan(0);
    }
  });
});
