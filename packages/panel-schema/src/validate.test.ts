/**
 * Colocated tests for `./validate.ts` — step 3a of the panel pipeline, and the
 * checkpoint that stands between a defective panel document and a developer's
 * screen.
 *
 * ## The guarantee this suite enforces
 *
 * > "`NodeRenderer` looks the node type up in the registry; a node type with no
 * > component is a validation failure raised by
 * > `packages/panel-schema/src/validate.ts` before rendering, **never a blank
 * > area**." (AAP §0.6.2)
 *
 * AAP §0.8.3 states the same requirement from the other end for this package:
 * "an unknown node type must fail". Both halves are asserted below, and the
 * unknown node type has a test of its own.
 *
 * ## Why a false rejection is as serious as a missed defect
 *
 * A failure here is a **product bug, not a model mistake**: whatever reaches
 * this layer was already accepted by the authoring schema and produced by the
 * deterministic normaliser, so AAP §0.5.3 forbids re-prompting — "a
 * normalisation or internal-validation failure is treated as a rejection too …
 * never retried against the model" — and the service answers with the
 * deterministic fallback panel carrying `meta.fallback = true`, drawn under a
 * visible banner (AAP §0.5.5).
 *
 * That makes the quality bar two-sided, and this file is organised around it:
 *
 * - the validator must catch every real structural defect, which is what the
 *   rejection suites assert, one `it` per rule plus a table that proves every
 *   member of the closed issue vocabulary is reachable;
 * - the validator must **not** reject a well-formed panel, which is what the
 *   acceptance suites assert — including one specification per catalogued node
 *   type and one holding all sixteen at once. A false rejection does not
 *   surface as an error a developer can read: it silently degrades every real
 *   run into a fallback view, which is a materially worse answer to the
 *   question they asked.
 *
 * The node-type coverage is this package's half of the catalog↔renderer
 * invariant, which two packages enforce between them. Each half lives in the
 * suite that can see it, because the renderer depends on this package and
 * never the reverse (AAP §0.6.2):
 *
 * - **Schema side, in this package.** `./catalog.test.ts` asserts that the
 *   catalog's key set equals the node-type union exactly. This file asserts
 *   that the validator accepts every catalogued node type with each source its
 *   entry declares, and that a node type outside the catalog is rejected before
 *   rendering — "an unknown node type must fail" (AAP §0.8.3).
 * - **Renderer side, in `packages/panel-renderer/src/host`.** `registry.ts`
 *   keys the component registry by the catalog's node-type vocabulary, and the
 *   record's `satisfies` clause makes a missing or an extra entry a compile
 *   error. The colocated `registry.test.ts` pairs every catalogued node type
 *   with a component in both directions, finds no component for a type outside
 *   the catalog, renders every catalogued component against a recorded
 *   panel-data response, and renders a node type with no component as an error
 *   state, never a blank area. `PanelHost.test.tsx` covers rendering at the
 *   host level: the summary, the fallback notice and a nested layout.
 *
 * Neither side stands in for the other. The renderer's suites assume a
 * validated specification, so a catalog entry whose declared sources this
 * validator would refuse — and a node type it has no handling for — must fail
 * here.
 *
 * ## Privacy (AAP §0.5.2)
 *
 * A panel specification is model-authored prose *about* captured runtime data,
 * and a rejection built from it is logged, may be persisted with the session,
 * and travels to both user interfaces through the protocol's `error` payload
 * without passing through the redaction layer or the outbound model guard. The
 * privacy suite therefore plants distinctive sentinels in the seven fields of a
 * specification that could plausibly hold sensitive content and asserts that
 * none of them reaches `message`, `hint`, `details` or `toPayload()` — the last
 * of which `packages/shared/src/errors.ts` documents as the exact shape
 * `packages/protocol` maps onto the wire. It also asserts the converse, because
 * a report that leaks nothing and says nothing is not the goal: the message
 * must still name the issue paths the service logs for diagnosis.
 *
 * This follows the precedent set by `packages/shared/src/source-location.test.ts`
 * and `packages/telemetry/src/schema/event.test.ts`.
 *
 * ## Conventions
 *
 * Node environment (the root Vitest project `panel-schema`), no DOM, no `node:`
 * builtin — this package's compiler project declares no ambient types. No
 * fixture file either (AAP §0.2.5): every document is built in this file by the
 * small builders below, so each rejection case reads as a one-line deviation
 * from a known-good baseline and a false rejection is obvious at a glance. Every
 * vocabulary — node types, data sources, metric ids, error codes, issue codes —
 * is imported from the module that owns it rather than restated, so a rename
 * fails this file at `pnpm typecheck` or at the assertion rather than leaving it
 * passing against a list nobody maintains.
 *
 * Every identifier, title and sentinel in this file is an invented generic
 * token: no application component name, no route path and no demo identifier
 * appears anywhere (AAP §0.5.4, enforced by `scripts/check-no-hardcoding.mjs`).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DEBUGGEN_ERROR_CODES,
  DebuggenError,
  isErr,
  isOk,
  type DebuggenErrorCode,
  type Result,
  type SourceLocation,
} from '@debuggen/shared';
import { METRIC_IDS } from '@debuggen/telemetry';

import { catalogEntryFor, isKnownPanelNodeType, isSourceAllowedForNode } from './catalog.js';
import { LAYOUT_NODE_MIN_CHILDREN, isLayoutNodeType } from './nodes/layout.js';
import { DATA_QUERY_SOURCES, type DataQuerySource } from './nodes/query.js';
import {
  PANEL_CHILDREN_FIELD,
  PANEL_LAYOUT_FIELD,
  PANEL_NODE_TYPES,
  PANEL_SPEC_VERSION,
  panelNodeSchema,
  type PanelNode,
  type PanelNodeType,
  type PanelSpec,
} from './spec.js';
import type { Fact, Hypothesis, PanelSummary } from './summary.js';
import {
  PANEL_MAX_NODE_DEPTH,
  PANEL_VALIDATION_ISSUE_CODES,
  assertValidPanelSpec,
  collectPanelSpecIssues,
  isPanelValidationIssueCode,
  validatePanelSpec,
  type PanelValidationIssueCode,
} from './validate.js';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 *
 * Generic tokens only, and each one named so that a failing assertion says
 * which value it was about.
 * ---------------------------------------------------------------------------
 */

/** The id the baseline panel carries. */
const PANEL_ID = 'panel-baseline';

/** The id of the panel a regeneration supersedes. */
const PREVIOUS_PANEL_ID = 'panel-previous';

/** The session the baseline panel belongs to. */
const SESSION_ID = 'session-baseline';

/** The baseline panel's title: prose, and deliberately about nothing. */
const PANEL_TITLE = 'A generated panel';

/** The version a session's first panel carries. */
const FIRST_PANEL_VERSION = 1;

/** The version a regenerated panel carries. */
const SECOND_PANEL_VERSION = 2;

/** The event id every citation in this file points at. */
const EVENT_ID = 'evt-baseline';

/** Prefix of every node id the builders derive, so ids read as what they are. */
const NODE_ID_PREFIX = 'node';

/**
 * A node type that is not in the vocabulary, for the unknown-node-type rules.
 *
 * Invented and generic: it names no component of any application, and it is
 * asserted below to be absent from {@link PANEL_NODE_TYPES} so the case cannot
 * quietly become a valid one.
 */
const UNCATALOGUED_NODE_TYPE = 'scatterplot';

/** A data-source name that is not in the closed source vocabulary. */
const UNCATALOGUED_SOURCE = 'guesswork';

/** A metric id that is not in the telemetry package's fixed set. */
const UNCATALOGUED_METRIC = 'imaginary_duration';

/** The key used wherever a test plants an unrecognised property. */
const UNRECOGNISED_KEY = 'unrecognisedOption';

/**
 * The error code every rejection from this module carries.
 *
 * Typed as {@link DebuggenErrorCode} rather than left a bare literal, so a code
 * renamed in `packages/shared/src/errors.ts` fails this file at `pnpm typecheck`
 * instead of at run time.
 */
const REJECTION_CODE: DebuggenErrorCode = 'PANEL_INVALID';

/**
 * A resolved source location the schema accepts: project-relative, POSIX,
 * 1-based on both axes.
 *
 * Used by the `sourceLink` leaf and by a hypothesis's suggested location. The
 * path names nothing real — it is a generic file in a generic directory.
 */
const SAFE_LOCATION: SourceLocation = {
  file: 'src/module/unit.ts',
  line: 12,
  column: 5,
  symbol: 'namedUnit',
  resolvedBy: 'code-graph',
  confidence: 0.85,
};

/** Widened view of the node vocabulary, for membership tests against strings. */
const NODE_TYPE_NAMES: readonly string[] = PANEL_NODE_TYPES;

/** Widened view of the closed data-source vocabulary. */
const DATA_SOURCE_NAMES: readonly string[] = DATA_QUERY_SOURCES;

/** Widened view of the fixed metric vocabulary. */
const METRIC_ID_NAMES: readonly string[] = METRIC_IDS;

/*
 * ---------------------------------------------------------------------------
 * Builders
 *
 * Two layers, and the distinction matters throughout this file:
 *
 * - the **record** builders produce plain objects and hand them on as
 *   `unknown`, which is how a document that was never parsed reaches the
 *   validator — a row out of a JSON column, a transport frame, a normaliser
 *   with a bug. They are what the structurally invalid cases are built from,
 *   because such a document cannot be given the static type it violates;
 * - the **typed** builders parse what they build, so a baseline that is not
 *   even well-formed fails inside the builder instead of making a rejection
 *   assertion pass for the wrong reason.
 * ---------------------------------------------------------------------------
 */

/**
 * Builds one node as a plain record, from the catalog's own declarations.
 *
 * Catalog-driven rather than hand-written per type, which is what makes the
 * per-type coverage below a real check: the query source is the first source
 * the entry declares, the child count is the minimum the container's schema
 * requires, and the two option-carrying leaves get their option. A node type
 * that gains a required field therefore fails here — in one place — rather than
 * in sixteen tests.
 *
 * @param type The node type to build.
 * @param overrides Fields to add or replace, applied last so a test can deviate
 * from the baseline in exactly one respect. Values are `unknown`, because the
 * deviation is frequently the thing the node's own schema forbids.
 * @returns The node as a record, ready to be parsed or to be handed on unparsed.
 */
function nodeRecord(
  type: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const declaredId = overrides['id'];
  const id = typeof declaredId === 'string' ? declaredId : `${NODE_ID_PREFIX}.${type}`;
  const record: Record<string, unknown> = { type, id };

  // An uncatalogued type has no entry to build from: the record is the type and
  // the id, which is all an unknown-node-type case needs. The predicate the
  // catalog exports is what narrows `type` for the lookup below, so no cast is
  // needed and the two questions — "is this catalogued" and "what does the
  // catalog say" — are answered by the module that owns both.
  if (!isKnownPanelNodeType(type)) {
    return { ...record, ...overrides };
  }

  const entry = catalogEntryFor(type);

  if (entry.requiresQuery) {
    const [firstSource] = entry.sources;

    if (firstSource === undefined) {
      throw new Error(
        `The catalog entry for ${type} requires a query but declares no source; ./catalog.test.ts asserts that invariant.`,
      );
    }

    record['query'] = { source: firstSource };
  }

  if (type === 'metricCards') {
    record['metrics'] = [METRIC_IDS[0]];
  }

  if (type === 'sourceLink') {
    record['location'] = SAFE_LOCATION;
  }

  if (entry.supportsChildren) {
    const minimum = isLayoutNodeType(type) ? LAYOUT_NODE_MIN_CHILDREN[type] : 1;
    const children: Record<string, unknown>[] = [];

    for (let index = 0; index < minimum; index += 1) {
      children.push(
        nodeRecord('eventLog', { id: `${id}.${PANEL_CHILDREN_FIELD}.${String(index)}` }),
      );
    }

    record['children'] = children;
  }

  return { ...record, ...overrides };
}

/**
 * Builds one node and parses it, yielding a typed {@link PanelNode}.
 *
 * The parse is the builder's own guard rather than part of any assertion: a
 * baseline node that does not even satisfy its own schema would make every
 * rejection case built from it meaningless, so it fails loudly here instead.
 *
 * @param type The node type to build; a catalogued one, since the result is
 * typed.
 * @param overrides Fields to add or replace.
 * @returns The parsed node.
 */
function makeNode(
  type: PanelNodeType,
  overrides: Readonly<Record<string, unknown>> = {},
): PanelNode {
  return panelNodeSchema.parse(nodeRecord(type, overrides));
}

/** The fields {@link makeSpec} accepts, each replacing one baseline field. */
interface SpecOverrides {
  readonly id?: string;
  readonly sessionId?: string;
  readonly panelVersion?: number;
  readonly supersedes?: string;
  readonly title?: string;
  readonly summary?: PanelSummary;
  readonly layout?: readonly PanelNode[];
  readonly meta?: { readonly fallback?: boolean };
}

/**
 * The smallest specification the validator must accept, with any field
 * replaced.
 *
 * Assembled field by field rather than by spreading a partial, because the
 * package compiles under `exactOptionalPropertyTypes`: `supersedes` and `meta`
 * are attached only when a test asked for them, so an absent one is an absent
 * *key* and never a key holding `undefined` — which is also what a JSON
 * round-trip of a stored panel preserves.
 *
 * @param overrides The fields to replace; see {@link SpecOverrides}.
 * @returns A specification typed as {@link PanelSpec}.
 */
function makeSpec(overrides: SpecOverrides = {}): PanelSpec {
  const spec: {
    version: typeof PANEL_SPEC_VERSION;
    id: string;
    sessionId: string;
    panelVersion: number;
    supersedes?: string;
    title: string;
    summary: PanelSummary;
    layout: readonly PanelNode[];
    meta?: { readonly fallback?: boolean };
  } = {
    version: PANEL_SPEC_VERSION,
    id: overrides.id ?? PANEL_ID,
    sessionId: overrides.sessionId ?? SESSION_ID,
    panelVersion: overrides.panelVersion ?? FIRST_PANEL_VERSION,
    title: overrides.title ?? PANEL_TITLE,
    summary: overrides.summary ?? emptySummary(),
    layout: overrides.layout ?? [makeNode('eventLog')],
  };

  if (overrides.supersedes !== undefined) {
    spec.supersedes = overrides.supersedes;
  }

  if (overrides.meta !== undefined) {
    spec.meta = overrides.meta;
  }

  return spec;
}

/**
 * Builds a specification as a plain record and hands it on as `unknown`.
 *
 * The route every structurally invalid document takes. `unknown` is the point:
 * a rejection case must reach the validator exactly as a stored row or a
 * transport frame would — unvouched for — rather than wearing a static type it
 * does not satisfy.
 *
 * @param overrides Document fields to add or replace, including malformed ones.
 * @returns The document, untyped.
 */
function specRecord(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return { ...makeSpec(), ...overrides };
}

/**
 * A copy of a record with one field removed.
 *
 * The complement of an override: several rules are about a field's *absence*,
 * and a builder that omitted the field instead would need a flag per field.
 *
 * @param record The record to copy.
 * @param field The field to drop.
 * @returns The copy, without that field.
 */
function withoutField(
  record: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };

  delete copy[field];

  return copy;
}

/**
 * Parses JSON and hands the result on as `unknown`.
 *
 * The shape a stored panel actually arrives in: the service keeps every
 * specification as JSON in a `panels` row, so a reader holds whatever
 * `JSON.parse` returned and nothing more. The assertion to `unknown` is what
 * keeps that honest — `JSON.parse` is typed `any`, and letting an `any` through
 * would give a rejection case a type the validator is entitled to trust.
 *
 * @param text The JSON text.
 * @returns The parsed value, untyped.
 */
function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/**
 * The summary a deterministic fallback panel legitimately carries: no prose, no
 * model-derived facts, no hypotheses.
 *
 * A fresh object per call, so no test can mutate a shared one.
 */
function emptySummary(): PanelSummary {
  return { observed: [], likelyCauses: [] };
}

/**
 * An observed fact: a statement and the one citation the schema requires.
 *
 * @param overrides Replacements for either field.
 * @returns The fact.
 */
function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    statement: overrides.statement ?? 'The capture recorded one interaction.',
    evidence: overrides.evidence ?? [{ eventId: EVENT_ID }],
  };
}

/**
 * A likely cause: a fact plus the confidence the schema requires, and
 * optionally a location.
 *
 * @param overrides Replacements for any field.
 * @returns The hypothesis.
 */
function makeHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  const hypothesis: {
    statement: string;
    evidence: Hypothesis['evidence'];
    confidence: Hypothesis['confidence'];
    suggestedLocation?: SourceLocation;
  } = {
    statement: overrides.statement ?? 'The measured work may explain the duration.',
    evidence: overrides.evidence ?? [{ eventId: EVENT_ID }],
    confidence: overrides.confidence ?? 'medium',
  };

  if (overrides.suggestedLocation !== undefined) {
    hypothesis.suggestedLocation = overrides.suggestedLocation;
  }

  return hypothesis;
}

/**
 * The id the normaliser would derive for a node at the given nesting level of
 * the first top-level position.
 *
 * Built from the two path constants `./spec.ts` exports rather than spelled
 * out, so these ids are the very ids a real document carries.
 *
 * @param level How many containers the node sits inside; `0` is top level.
 * @returns The dotted node id.
 */
function nestedNodeId(level: number): string {
  return `${PANEL_LAYOUT_FIELD}.0${`.${PANEL_CHILDREN_FIELD}.0`.repeat(level)}`;
}

/**
 * Builds one top-level node nested exactly `depth` levels deep: containers all
 * the way down with a leaf at the bottom.
 *
 * Programmatic, because the depth bound is a number this file imports rather
 * than one it restates, and a hand-written tree of that shape would have to be
 * rewritten every time the bound moved.
 *
 * @param depth Total levels, counting the top-level node as 1; at least 1.
 * @returns The nested node, parsed.
 */
function nestedLayout(depth: number): PanelNode {
  if (depth < 1) {
    throw new Error(`nestedLayout needs a depth of at least 1, received ${String(depth)}.`);
  }

  let node: PanelNode = makeNode('eventLog', { id: nestedNodeId(depth - 1) });

  for (let level = depth - 2; level >= 0; level -= 1) {
    node = makeNode('stack', { id: nestedNodeId(level), children: [node] });
  }

  return node;
}

/*
 * ---------------------------------------------------------------------------
 * Readers
 *
 * Each one turns a value the test cannot narrow — a `Result`, an error's
 * `details`, a path of mixed segments — into something an assertion can state
 * directly, and fails with a message naming what it actually found rather than
 * with a property read on `undefined`.
 * ---------------------------------------------------------------------------
 */

/**
 * The specification a successful validation produced.
 *
 * `isOk` from `@debuggen/shared` rather than a hand-written discriminant test,
 * so the narrowing those guards provide is exercised — and type-checked — here
 * too.
 *
 * @param result The result to read.
 * @returns The parsed specification.
 * @throws When the result was a rejection, naming its code and message.
 */
function okValue(result: Result<PanelSpec, DebuggenError>): PanelSpec {
  if (isErr(result)) {
    throw new Error(`Expected Ok, received Err ${result.error.code}: ${result.error.message}`);
  }

  return result.value;
}

/**
 * The error a rejection produced.
 *
 * @param result The result to read.
 * @returns The rejection's error.
 * @throws When the specification was accepted, naming the title that got
 * through — a title this file authored, never captured content.
 */
function errorOf(result: Result<PanelSpec, DebuggenError>): DebuggenError {
  if (isOk(result)) {
    throw new Error(`Expected Err, received Ok(${result.value.title})`);
  }

  return result.error;
}

/**
 * One issue as it appears in a rejection's `details`, for both halves of the
 * check.
 *
 * Parsed with a schema rather than read through a cast: `details` is
 * `Record<string, unknown>` by design, and a rejection whose `issues` were not
 * an array of path-and-code objects is itself a finding this reader should
 * surface rather than silently tolerate. `expected` is dropped by the schema —
 * the schema half reports it on a type mismatch and no assertion here needs it.
 */
const reportedIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
  nodeType: z.string().optional(),
});

/** One reported issue, as {@link reportedIssues} yields it. */
type ReportedIssue = z.infer<typeof reportedIssueSchema>;

/** The schema for a rejection's whole issue list. */
const reportedIssuesSchema = z.array(reportedIssueSchema);

/**
 * The issue list a rejection carries in its `details`.
 *
 * @param error The rejection.
 * @returns Every issue, in the order the validator reported it.
 */
function reportedIssues(error: DebuggenError): readonly ReportedIssue[] {
  return reportedIssuesSchema.parse(error.details?.['issues']);
}

/** The dotted paths of a rejection's issues, in report order. */
function reportedPaths(error: DebuggenError): readonly string[] {
  return reportedIssues(error).map((issue) => issue.path);
}

/** The codes of a rejection's issues, in report order. */
function reportedCodes(error: DebuggenError): readonly string[] {
  return reportedIssues(error).map((issue) => issue.code);
}

/** One invariant issue reduced to a dotted path and a code. */
interface DescribedIssue {
  readonly path: string;
  readonly code: string;
}

/**
 * The invariant issues of a document, with each path joined the way a
 * rejection's `details` renders it.
 *
 * Every assertion about {@link collectPanelSpecIssues} goes through this, so a
 * failure prints `layout.0.query.source` rather than an array of segments.
 *
 * @param spec The document to check.
 * @returns The issues, in report order.
 */
function describedIssues(spec: PanelSpec): readonly DescribedIssue[] {
  return collectPanelSpecIssues(spec).map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
  }));
}

/**
 * Hands an unparsed document to the typed invariant collector.
 *
 * The one assertion in this file, and it is the *subject* of a documented
 * contract rather than a convenience: `collectPanelSpecIssues` takes a
 * {@link PanelSpec} but promises to hold — and never to throw — for "a value
 * that was asserted rather than parsed: a row read out of a JSON column, a
 * fixture built by hand, a payload cast on arrival". That promise cannot be
 * tested without doing exactly what a caller in that position does.
 *
 * @param value Any value.
 * @returns The same value, typed as a specification.
 */
function asSpec(value: unknown): PanelSpec {
  return value as PanelSpec;
}

/**
 * The error thrown by `assertValidPanelSpec`, or a failure naming what happened
 * instead.
 *
 * @param value The document to assert.
 * @returns The thrown error.
 */
function thrownBy(value: unknown): DebuggenError {
  try {
    const accepted = assertValidPanelSpec(value);

    throw new Error(`Expected a throw, received a specification titled ${accepted.title}`);
  } catch (caught) {
    if (!DebuggenError.is(caught)) {
      throw caught;
    }

    return caught;
  }
}

/*
 * ---------------------------------------------------------------------------
 * The catalog-computed source mismatch
 * ---------------------------------------------------------------------------
 */

/** A node type paired with a source its type may not read. */
interface SourceMismatch {
  readonly type: PanelNodeType;
  readonly source: DataQuerySource;
}

/**
 * Finds a real mismatch: a query-backed node type and a member of the closed
 * source vocabulary that the catalog does **not** allow it to read.
 *
 * Computed from the catalog rather than written down, so the disallowed-source
 * assertion keeps testing the rule after a catalog entry gains or loses a
 * source. A catalog in which no such pair exists — every type allowed every
 * source — would make that rule vacuous, so the absence of a pair is a failure
 * here rather than a silently skipped test.
 *
 * @returns The first mismatch found, in vocabulary order.
 */
function findSourceMismatch(): SourceMismatch {
  for (const type of PANEL_NODE_TYPES) {
    if (!catalogEntryFor(type).requiresQuery) {
      continue;
    }

    for (const source of DATA_QUERY_SOURCES) {
      if (!isSourceAllowedForNode(type, source)) {
        return { type, source };
      }
    }
  }

  throw new Error(
    'No node type restricts any data source, so the per-type source allowance cannot be tested.',
  );
}

/** The mismatch the disallowed-source assertions use. */
const SOURCE_MISMATCH = findSourceMismatch();

/*
 * ---------------------------------------------------------------------------
 * Acceptance: the validator must not reject a well-formed panel
 * ---------------------------------------------------------------------------
 */

describe('validatePanelSpec accepts well-formed specifications', () => {
  it('accepts the minimal specification and returns the parsed document', () => {
    const spec = makeSpec();
    const result = validatePanelSpec(spec);

    expect(isOk(result)).toBe(true);
    expect(okValue(result)).toStrictEqual(spec);
  });

  it('finds no invariant issue in the minimal specification', () => {
    expect(describedIssues(makeSpec())).toStrictEqual([]);
  });

  it('accepts a specification with no layout nodes at all', () => {
    // `./spec.ts` documents the decision this asserts: "May be empty. A fallback
    // panel assembled when nothing could be validated is allowed to carry a
    // summary and no views at all". Rejecting one would leave the developer with
    // no panel and no explanation.
    const accepted = okValue(validatePanelSpec(makeSpec({ layout: [] })));

    expect(accepted.layout).toStrictEqual([]);
  });

  it('accepts the deterministic fallback panel', () => {
    // The graceful-degradation path of AAP §0.5.5: prose, no model-derived
    // facts, the fallback flag, and — as a fallback assembled from little — no
    // views. If this were rejected there would be nothing left to show.
    const spec = makeSpec({
      layout: [],
      meta: { fallback: true },
      summary: {
        headline: 'A deterministic summary of the capture.',
        observed: [],
        likelyCauses: [],
      },
    });
    const accepted = okValue(validatePanelSpec(spec));

    expect(accepted.meta?.fallback).toBe(true);
    expect(accepted.summary.observed).toStrictEqual([]);
  });

  it('accepts a summary with no observed facts but a populated likely cause', () => {
    const spec = makeSpec({
      summary: {
        observed: [],
        likelyCauses: [makeHypothesis({ suggestedLocation: SAFE_LOCATION })],
      },
    });

    expect(okValue(validatePanelSpec(spec)).summary.likelyCauses).toHaveLength(1);
  });

  it('accepts every metric id the telemetry package declares', () => {
    // The ids are imported, never restated: `packages/telemetry` owns the fixed
    // set and its own test pins the list and its order, so a rename reaches this
    // assertion without an edit here.
    const spec = makeSpec({ layout: [makeNode('metricCards', { metrics: [...METRIC_IDS] })] });

    expect(isOk(validatePanelSpec(spec))).toBe(true);
    expect(METRIC_ID_NAMES).not.toContain(UNCATALOGUED_METRIC);
  });

  it('accepts a legal four-level layout', () => {
    const spec = makeSpec({
      layout: [
        makeNode('section', {
          id: nestedNodeId(0),
          children: [
            nodeRecord('split', {
              id: nestedNodeId(1),
              direction: 'vertical',
              children: [
                nodeRecord('stack', {
                  id: nestedNodeId(2),
                  children: [nodeRecord('timeline', { id: nestedNodeId(3) })],
                }),
                nodeRecord('queryTable', { id: `${nestedNodeId(1)}.${PANEL_CHILDREN_FIELD}.1` }),
              ],
            }),
          ],
        }),
      ],
    });

    expect(describedIssues(spec)).toStrictEqual([]);
    expect(isOk(validatePanelSpec(spec))).toBe(true);
  });

  it('accepts a layout nested to exactly the documented depth limit', () => {
    const spec = makeSpec({ layout: [nestedLayout(PANEL_MAX_NODE_DEPTH)] });

    expect(isOk(validatePanelSpec(spec))).toBe(true);
  });

  it('accepts a regeneration that supersedes an earlier panel', () => {
    const spec = makeSpec({
      panelVersion: SECOND_PANEL_VERSION,
      supersedes: PREVIOUS_PANEL_ID,
    });

    expect(okValue(validatePanelSpec(spec)).supersedes).toBe(PREVIOUS_PANEL_ID);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Acceptance: the catalog ↔ validator loop
 *
 * This package's half of AAP §0.6.2's renderer contract; the renderer's half —
 * one component per catalogued node type, in both directions — is asserted by
 * `packages/panel-renderer/src/host/registry.test.ts`. Two directions are
 * closed here: a catalog entry whose declared sources this validator would
 * refuse, and a node type the validator has no handling for.
 * ---------------------------------------------------------------------------
 */

describe('validatePanelSpec accepts every catalogued node type', () => {
  it.each(PANEL_NODE_TYPES)('accepts a specification containing a %s node', (type) => {
    const spec = makeSpec({ layout: [makeNode(type)] });

    expect(describedIssues(spec)).toStrictEqual([]);
    expect(isOk(validatePanelSpec(spec))).toBe(true);
  });

  it('accepts one specification containing every node type at once', () => {
    const spec = makeSpec({ layout: PANEL_NODE_TYPES.map((type) => makeNode(type)) });
    const accepted = okValue(validatePanelSpec(spec));

    expect(accepted.layout.map((node) => node.type)).toStrictEqual([...PANEL_NODE_TYPES]);
    expect(accepted.layout).toHaveLength(PANEL_NODE_TYPES.length);
  });

  it('accepts each node type against every source its catalog entry declares', () => {
    // Not only the first source: a component that can consume two prepared
    // results has both declared, and a validator that accepted only one of them
    // would reject a legitimate panel — the false rejection this suite exists to
    // prevent.
    for (const type of PANEL_NODE_TYPES) {
      for (const source of catalogEntryFor(type).sources) {
        const spec = makeSpec({ layout: [makeNode(type, { query: { source } })] });

        expect(describedIssues(spec), `${type} reading ${source}`).toStrictEqual([]);
      }
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Acceptance: the throwing entry point
 * ---------------------------------------------------------------------------
 */

describe('assertValidPanelSpec', () => {
  it('returns the parsed specification for a valid document', () => {
    const spec = makeSpec();

    expect(assertValidPanelSpec(spec)).toStrictEqual(spec);
  });

  it('throws the rejection a caller would otherwise have inspected', () => {
    // `@debuggen/shared`'s assertion module draws the line this pair sits on: a
    // throwing assertion reports a programmer error, a `Result` reports an
    // expected failure a user interface renders. The error is the same one.
    const invalid = makeSpec({ supersedes: PANEL_ID, panelVersion: SECOND_PANEL_VERSION });
    const thrown = thrownBy(invalid);

    expect(DebuggenError.is(thrown)).toBe(true);
    expect(thrown.code).toBe(REJECTION_CODE);
    expect(thrown.message).toBe(errorOf(validatePanelSpec(invalid)).message);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Rejections, one rule per test
 *
 * Each case deviates from the baseline in exactly one respect, and each asserts
 * two things: that the document is rejected, and that the reported issue points
 * at the field at fault. Where a defect is structural — a shape the node
 * schemas forbid outright — the document travels unparsed, because that is the
 * only way such a value can exist, and both halves of the check are asserted:
 * the schema's rejection through `validatePanelSpec`, and the rule's own code
 * through `collectPanelSpecIssues`, which is documented as safe for a document
 * that was asserted rather than parsed.
 * ---------------------------------------------------------------------------
 */

describe('validatePanelSpec rejects an unknown node type', () => {
  it('is a type the vocabulary genuinely does not contain', () => {
    // Guards the guard: a case built around a type that later became valid would
    // pass for the wrong reason.
    expect(NODE_TYPE_NAMES).not.toContain(UNCATALOGUED_NODE_TYPE);
  });

  it('rejects it through the schema, naming the node index and the type key', () => {
    const document = specRecord({
      layout: [nodeRecord(UNCATALOGUED_NODE_TYPE, { id: `${PANEL_LAYOUT_FIELD}.0` })],
    });
    const error = errorOf(validatePanelSpec(document));

    expect(error.code).toBe(REJECTION_CODE);
    expect(reportedPaths(error)).toContain(`${PANEL_LAYOUT_FIELD}.0.type`);
  });

  it('reports it as an uncatalogued node through the invariant half', () => {
    // The check that stands between a node type nobody registered and a blank
    // region on a developer's screen (AAP §0.6.2). The schema's discriminated
    // union catches an unknown *string*; this catches the other drift direction —
    // a type in the union with no catalog entry — and it is the half that fires
    // for a document read back out of a store without being parsed.
    const document = specRecord({
      layout: [nodeRecord(UNCATALOGUED_NODE_TYPE, { id: `${PANEL_LAYOUT_FIELD}.0` })],
    });

    expect(describedIssues(asSpec(document))).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.0`, code: 'panel_node_type_unknown' },
    ]);
  });

  it('names no part of the rejected type string', () => {
    // The offending value is a rejected value like any other: the path already
    // identifies the node, so the string itself never enters a report
    // (AAP §0.5.2).
    const document = specRecord({
      layout: [nodeRecord(UNCATALOGUED_NODE_TYPE, { id: `${PANEL_LAYOUT_FIELD}.0` })],
    });
    const error = errorOf(validatePanelSpec(document));

    expect(JSON.stringify(error.details)).not.toContain(UNCATALOGUED_NODE_TYPE);
    expect(error.message).not.toContain(UNCATALOGUED_NODE_TYPE);
  });

  it('reports the issues before it and stops rather than throwing', () => {
    // `./spec.ts`'s traversal cannot walk past a node whose type is outside the
    // node union, so the issue list is the prefix up to that node — and the
    // collector must still return it rather than let the traversal's own failure
    // escape into the reporter.
    const document = specRecord({
      layout: [
        nodeRecord(SOURCE_MISMATCH.type, {
          id: `${PANEL_LAYOUT_FIELD}.0`,
          query: { source: SOURCE_MISMATCH.source },
        }),
        nodeRecord(UNCATALOGUED_NODE_TYPE, { id: `${PANEL_LAYOUT_FIELD}.1` }),
        nodeRecord(SOURCE_MISMATCH.type, {
          id: `${PANEL_LAYOUT_FIELD}.2`,
          query: { source: SOURCE_MISMATCH.source },
        }),
      ],
    });
    const issues = describedIssues(asSpec(document));

    expect(issues).toStrictEqual([
      {
        path: `${PANEL_LAYOUT_FIELD}.0.query.source`,
        code: 'panel_node_query_source_not_allowed',
      },
      { path: `${PANEL_LAYOUT_FIELD}.1`, code: 'panel_node_type_unknown' },
    ]);
  });
});

describe('validatePanelSpec rejects a data query a node type may not read', () => {
  it('rejects a source the catalog does not allow for the node type', () => {
    // The pair is computed from the catalog, so this keeps testing the rule when
    // an entry's declared sources change.
    const spec = makeSpec({
      layout: [
        makeNode(SOURCE_MISMATCH.type, {
          id: `${PANEL_LAYOUT_FIELD}.0`,
          query: { source: SOURCE_MISMATCH.source },
        }),
      ],
    });
    const error = errorOf(validatePanelSpec(spec));

    expect(describedIssues(spec)).toStrictEqual([
      {
        path: `${PANEL_LAYOUT_FIELD}.0.query.source`,
        code: 'panel_node_query_source_not_allowed',
      },
    ]);
    expect(reportedPaths(error)).toStrictEqual([`${PANEL_LAYOUT_FIELD}.0.query.source`]);
    expect(reportedIssues(error)[0]?.nodeType).toBe(SOURCE_MISMATCH.type);
  });

  it('rejects a source outside the closed source vocabulary', () => {
    expect(DATA_SOURCE_NAMES).not.toContain(UNCATALOGUED_SOURCE);

    const document = specRecord({
      layout: [
        nodeRecord('timeline', {
          id: `${PANEL_LAYOUT_FIELD}.0`,
          query: { source: UNCATALOGUED_SOURCE },
        }),
      ],
    });

    expect(isErr(validatePanelSpec(document))).toBe(true);
    expect(describedIssues(asSpec(document))).toStrictEqual([
      {
        path: `${PANEL_LAYOUT_FIELD}.0.query.source`,
        code: 'panel_node_query_source_unknown',
      },
    ]);
  });

  it('rejects a query-backed node carrying no query at all', () => {
    const document = specRecord({
      layout: [withoutField(nodeRecord('timeline', { id: `${PANEL_LAYOUT_FIELD}.0` }), 'query')],
    });
    const error = errorOf(validatePanelSpec(document));

    expect(reportedPaths(error)).toContain(`${PANEL_LAYOUT_FIELD}.0.query`);
    expect(describedIssues(asSpec(document))).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.0.query`, code: 'panel_node_query_missing' },
    ]);
  });

  it('rejects a source link carrying a query', () => {
    // A source link points at code rather than at evidence, so a query on one is
    // a node half-described as a data view — which would render as neither.
    const document = specRecord({
      layout: [
        nodeRecord('sourceLink', {
          id: `${PANEL_LAYOUT_FIELD}.0`,
          query: { source: DATA_QUERY_SOURCES[0] },
        }),
      ],
    });
    const error = errorOf(validatePanelSpec(document));

    expect(reportedPaths(error)).toContain(`${PANEL_LAYOUT_FIELD}.0`);
    expect(describedIssues(asSpec(document))).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.0.query`, code: 'panel_node_query_forbidden' },
    ]);
  });
});

describe('validatePanelSpec rejects malformed metric tiles', () => {
  it('rejects a metric id outside the telemetry package fixed set', () => {
    const document = specRecord({
      layout: [
        nodeRecord('metricCards', {
          id: `${PANEL_LAYOUT_FIELD}.0`,
          metrics: [UNCATALOGUED_METRIC],
        }),
      ],
    });
    const error = errorOf(validatePanelSpec(document));

    expect(reportedPaths(error)).toContain(`${PANEL_LAYOUT_FIELD}.0.metrics.0`);
    expect(describedIssues(asSpec(document))).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.0.metrics.0`, code: 'panel_node_metric_unknown' },
    ]);
  });

  it('reports one issue per unrecognised id rather than only the first', () => {
    const document = specRecord({
      layout: [
        nodeRecord('metricCards', {
          id: `${PANEL_LAYOUT_FIELD}.0`,
          metrics: [UNCATALOGUED_METRIC, METRIC_IDS[0], `${UNCATALOGUED_METRIC}_two`],
        }),
      ],
    });

    expect(describedIssues(asSpec(document))).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.0.metrics.0`, code: 'panel_node_metric_unknown' },
      { path: `${PANEL_LAYOUT_FIELD}.0.metrics.2`, code: 'panel_node_metric_unknown' },
    ]);
  });

  it('rejects an empty metric list, as the module documents', () => {
    // `./validate.ts` was asked to decide and decided invalid: "A tile row with
    // no tiles renders as an empty band — a panel claiming to present the
    // capture's headline numbers and presenting none". The node schema says the
    // same with `.min(1)`, so both halves reject.
    const document = specRecord({
      layout: [nodeRecord('metricCards', { id: `${PANEL_LAYOUT_FIELD}.0`, metrics: [] })],
    });
    const error = errorOf(validatePanelSpec(document));

    expect(reportedPaths(error)).toContain(`${PANEL_LAYOUT_FIELD}.0.metrics`);
    expect(describedIssues(asSpec(document))).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.0.metrics`, code: 'panel_node_metrics_empty' },
    ]);
  });
});

describe('validatePanelSpec rejects malformed containment', () => {
  it('rejects children on a node type that has none', () => {
    const document = specRecord({
      layout: [
        nodeRecord('timeline', {
          id: `${PANEL_LAYOUT_FIELD}.0`,
          children: [nodeRecord('eventLog', { id: `${PANEL_LAYOUT_FIELD}.0.child` })],
        }),
      ],
    });
    const error = errorOf(validatePanelSpec(document));

    expect(reportedPaths(error)).toContain(`${PANEL_LAYOUT_FIELD}.0`);
    expect(describedIssues(asSpec(document))).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.0.children`, code: 'panel_node_children_forbidden' },
    ]);
  });

  it('rejects a container whose children are missing, without throwing', () => {
    // The traversal reads a container's children, so an unparsed document with
    // no children array is the case where the collector's non-throwing promise
    // is actually load-bearing: an exception here would replace the failure being
    // reported with a crash in the reporter.
    const document = specRecord({
      layout: [withoutField(nodeRecord('stack', { id: `${PANEL_LAYOUT_FIELD}.0` }), 'children')],
    });

    expect(isErr(validatePanelSpec(document))).toBe(true);
    expect(describedIssues(asSpec(document))).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.0.children`, code: 'panel_node_children_missing' },
    ]);
  });

  it('rejects a container with an empty children array', () => {
    const document = specRecord({
      layout: [nodeRecord('stack', { id: `${PANEL_LAYOUT_FIELD}.0`, children: [] })],
    });
    const error = errorOf(validatePanelSpec(document));

    expect(reportedPaths(error)).toContain(`${PANEL_LAYOUT_FIELD}.0.children`);
    expect(describedIssues(asSpec(document))).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.0.children`, code: 'panel_node_children_empty' },
    ]);
  });

  it('rejects nesting one level beyond the documented depth limit', () => {
    const spec = makeSpec({ layout: [nestedLayout(PANEL_MAX_NODE_DEPTH + 1)] });
    const error = errorOf(validatePanelSpec(spec));

    expect(describedIssues(spec)).toStrictEqual([
      { path: nestedNodeId(PANEL_MAX_NODE_DEPTH), code: 'panel_node_depth_exceeded' },
    ]);
    expect(reportedCodes(error)).toStrictEqual(['panel_node_depth_exceeded']);
  });

  it('rejects duplicate node ids anywhere in the tree', () => {
    // Ids are derived from layout paths, so a duplicate is a normaliser bug —
    // and two nodes in different subtrees sharing one is the same defect as two
    // siblings sharing one, since an id is a list key and a selection target.
    const repeated = `${PANEL_LAYOUT_FIELD}.0`;
    const spec = makeSpec({
      layout: [
        makeNode('section', {
          id: repeated,
          children: [nodeRecord('eventLog', { id: `${repeated}.${PANEL_CHILDREN_FIELD}.0` })],
        }),
        makeNode('timeline', { id: repeated }),
      ],
    });

    expect(describedIssues(spec)).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.1.id`, code: 'panel_node_id_duplicate' },
    ]);
    expect(isErr(validatePanelSpec(spec))).toBe(true);
  });
});

describe('validatePanelSpec rejects malformed document bookkeeping', () => {
  it('rejects a panel that supersedes itself', () => {
    const spec = makeSpec({
      id: PANEL_ID,
      supersedes: PANEL_ID,
      panelVersion: SECOND_PANEL_VERSION,
    });

    expect(describedIssues(spec)).toStrictEqual([
      { path: 'supersedes', code: 'panel_supersedes_self' },
    ]);
    expect(reportedPaths(errorOf(validatePanelSpec(spec)))).toStrictEqual(['supersedes']);
  });

  it('rejects a first-version panel that supersedes another', () => {
    const spec = makeSpec({ supersedes: PREVIOUS_PANEL_ID, panelVersion: FIRST_PANEL_VERSION });

    expect(describedIssues(spec)).toStrictEqual([
      { path: 'panelVersion', code: 'panel_supersedes_on_first_version' },
    ]);
    expect(isErr(validatePanelSpec(spec))).toBe(true);
  });

  it('rejects a document format version other than the current one', () => {
    const document = specRecord({ version: PANEL_SPEC_VERSION + 1 });
    const error = errorOf(validatePanelSpec(document));

    expect(reportedPaths(error)).toContain('version');
  });

  it('rejects an observed fact that cites nothing', () => {
    // The mechanical half of the product's evidence boundary: a statement with
    // nothing to cite cannot reach a panel's "Observed" heading. The schema's
    // `.min(1)` rejects it, and the invariant check states the same rule for a
    // document that never passed the schema.
    const spec = makeSpec({
      summary: { observed: [makeFact({ evidence: [] })], likelyCauses: [] },
    });
    const error = errorOf(validatePanelSpec(spec));

    expect(reportedPaths(error)).toContain('summary.observed.0.evidence');
    expect(describedIssues(spec)).toStrictEqual([
      { path: 'summary.observed.0.evidence', code: 'panel_fact_evidence_empty' },
    ]);
  });

  it('rejects a likely cause that cites nothing', () => {
    const spec = makeSpec({
      summary: { observed: [], likelyCauses: [makeHypothesis({ evidence: [] })] },
    });

    expect(describedIssues(spec)).toStrictEqual([
      { path: 'summary.likelyCauses.0.evidence', code: 'panel_fact_evidence_empty' },
    ]);
    expect(isErr(validatePanelSpec(spec))).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Rejections: strictness and untrusted input
 * ---------------------------------------------------------------------------
 */

/** An unrecognised key planted in one place, with the path the rejection names. */
interface StrictnessCase {
  readonly label: string;
  readonly document: unknown;
  readonly path: string;
}

/**
 * One unrecognised key in each object of a specification.
 *
 * Every shape in this package is a strict object, and that strictness is what
 * proves the normaliser did its job: a flat authoring field left behind, or a
 * dimension its author invented, fails here instead of travelling to a renderer
 * that never reads it. The reported path is the *object's* path, because the
 * offending key name is dropped from the report — a key is usually authored
 * code, but it can be computed, so it is treated as a rejected value like any
 * other.
 */
const STRICTNESS_CASES: readonly StrictnessCase[] = [
  {
    label: 'the document itself',
    document: specRecord({ [UNRECOGNISED_KEY]: true }),
    path: '',
  },
  {
    label: 'the metadata',
    document: specRecord({ meta: { fallback: true, [UNRECOGNISED_KEY]: true } }),
    path: 'meta',
  },
  {
    label: 'the summary',
    document: specRecord({
      summary: { observed: [], likelyCauses: [], [UNRECOGNISED_KEY]: true },
    }),
    path: 'summary',
  },
  {
    label: 'an evidence citation',
    document: specRecord({
      summary: {
        observed: [
          {
            statement: 'One event was recorded.',
            evidence: [{ eventId: EVENT_ID, [UNRECOGNISED_KEY]: true }],
          },
        ],
        likelyCauses: [],
      },
    }),
    path: 'summary.observed.0.evidence.0',
  },
  {
    label: 'a node',
    document: specRecord({
      layout: [nodeRecord('eventLog', { id: `${PANEL_LAYOUT_FIELD}.0`, [UNRECOGNISED_KEY]: true })],
    }),
    path: `${PANEL_LAYOUT_FIELD}.0`,
  },
  {
    label: 'a nested node',
    document: specRecord({
      layout: [
        nodeRecord('stack', {
          id: `${PANEL_LAYOUT_FIELD}.0`,
          children: [
            nodeRecord('eventLog', {
              id: `${PANEL_LAYOUT_FIELD}.0.${PANEL_CHILDREN_FIELD}.0`,
              [UNRECOGNISED_KEY]: true,
            }),
          ],
        }),
      ],
    }),
    path: `${PANEL_LAYOUT_FIELD}.0.${PANEL_CHILDREN_FIELD}.0`,
  },
  {
    label: 'a data query',
    document: specRecord({
      layout: [
        nodeRecord('eventLog', {
          id: `${PANEL_LAYOUT_FIELD}.0`,
          query: { source: 'events', [UNRECOGNISED_KEY]: true },
        }),
      ],
    }),
    path: `${PANEL_LAYOUT_FIELD}.0.query`,
  },
  {
    label: 'a query filter',
    document: specRecord({
      layout: [
        nodeRecord('eventLog', {
          id: `${PANEL_LAYOUT_FIELD}.0`,
          query: { source: 'events', filter: { [UNRECOGNISED_KEY]: true } },
        }),
      ],
    }),
    path: `${PANEL_LAYOUT_FIELD}.0.query.filter`,
  },
];

describe('validatePanelSpec rejects an unrecognised key', () => {
  it.each(STRICTNESS_CASES)('rejects one on $label', ({ document, path }) => {
    const error = errorOf(validatePanelSpec(document));

    expect(error.code).toBe(REJECTION_CODE);
    expect(reportedPaths(error)).toContain(path);
    expect(JSON.stringify(error.details)).not.toContain(UNRECOGNISED_KEY);
  });
});

/**
 * Values that are not documents at all.
 *
 * The entry point accepts `unknown` precisely because the service reads
 * specifications back out of a SQLite JSON column, so a row holding a string, a
 * number or a JSON-parsed fragment has to be a rejection rather than a crash.
 */
const NON_DOCUMENT_VALUES: readonly { readonly label: string; readonly value: unknown }[] = [
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: 'a string', value: 'a stored value that is not a panel' },
  { label: 'a number', value: 42 },
  { label: 'a boolean', value: true },
  { label: 'an array', value: [] },
  { label: 'a JSON-parsed fragment', value: parseJson('{"version":"one"}') },
  { label: 'an empty object', value: {} },
];

describe('validatePanelSpec handles values that are not documents', () => {
  it.each(NON_DOCUMENT_VALUES)('rejects $label without throwing', ({ value }) => {
    const result = validatePanelSpec(value);

    expect(isErr(result)).toBe(true);
    expect(errorOf(result).code).toBe(REJECTION_CODE);
    expect(reportedIssues(errorOf(result)).length).toBeGreaterThan(0);
  });

  it.each(NON_DOCUMENT_VALUES)(
    'collects no invariant issue for $label, leaving the shape to the schema',
    ({ value }) => {
      expect(describedIssues(asSpec(value))).toStrictEqual([]);
    },
  );

  it('rejects a document whose layout is not an array', () => {
    const document = specRecord({ layout: 'not an array' });

    expect(reportedPaths(errorOf(validatePanelSpec(document)))).toContain(PANEL_LAYOUT_FIELD);
    expect(describedIssues(asSpec(document))).toStrictEqual([]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Rejections: every issue at once
 *
 * A rejection here means the panel pipeline produced a defective document, and
 * the developer diagnosing that pipeline needs the whole list: a validator that
 * stopped at the first issue would turn one investigation into as many rounds as
 * there are defects.
 * ---------------------------------------------------------------------------
 */

/**
 * A document with three independent defects, each of which the *schema*
 * accepts.
 *
 * Schema-legal on purpose: a defect the schema rejects would end the check
 * before the invariants ran, and this suite is about the invariant half
 * reporting everything it finds. The three are a document-level rule, a
 * whole-tree rule and a node-level rule, so they also prove the reporting order
 * is the document's own reading order.
 */
function threeDefectSpec(): PanelSpec {
  const repeated = `${PANEL_LAYOUT_FIELD}.0`;

  return makeSpec({
    id: PANEL_ID,
    supersedes: PANEL_ID,
    panelVersion: SECOND_PANEL_VERSION,
    layout: [
      makeNode('timeline', { id: repeated }),
      makeNode(SOURCE_MISMATCH.type, {
        id: repeated,
        query: { source: SOURCE_MISMATCH.source },
      }),
    ],
  });
}

describe('validatePanelSpec reports every issue it finds', () => {
  it('collects all three defects, in document reading order', () => {
    expect(describedIssues(threeDefectSpec())).toStrictEqual([
      { path: 'supersedes', code: 'panel_supersedes_self' },
      { path: `${PANEL_LAYOUT_FIELD}.1.id`, code: 'panel_node_id_duplicate' },
      {
        path: `${PANEL_LAYOUT_FIELD}.1.query.source`,
        code: 'panel_node_query_source_not_allowed',
      },
    ]);
  });

  it('reports the same issues in the same order on every call', () => {
    // Determinism matters beyond tidiness: a rejection is logged and may be
    // persisted with the session, and two runs of one defective document must be
    // comparable.
    expect(describedIssues(threeDefectSpec())).toStrictEqual(describedIssues(threeDefectSpec()));
  });

  it('carries all three in the rejection details and names each in the message', () => {
    const spec = threeDefectSpec();
    const error = errorOf(validatePanelSpec(spec));
    const issues = describedIssues(spec);

    expect(error.details?.['issueCount']).toBe(issues.length);
    expect(reportedIssues(error)).toStrictEqual(
      collectPanelSpecIssues(spec).map((issue) =>
        issue.nodeType === undefined
          ? { path: issue.path.join('.'), code: issue.code }
          : { path: issue.path.join('.'), code: issue.code, nodeType: issue.nodeType },
      ),
    );

    for (const issue of issues) {
      expect(error.message).toContain(issue.path);
      expect(error.message).toContain(issue.code);
    }
  });

  it('bounds the message and keeps the complete list in the details', () => {
    // The message is one line in a log and in two user interfaces; the full list
    // always travels in `details`, so truncating the line loses nothing. The
    // bound itself is private to `./validate.ts`, so this asserts the
    // arithmetic of the truncation rather than the number: whatever the bound
    // is, the line names some issues, says how many it omitted, and the two add
    // up to the list in `details`.
    const repeated = `${PANEL_LAYOUT_FIELD}.0`;
    const defectiveNodes: PanelNode[] = [];

    for (let index = 0; index < 20; index += 1) {
      defectiveNodes.push(
        makeNode(SOURCE_MISMATCH.type, {
          id: repeated,
          query: { source: SOURCE_MISMATCH.source },
        }),
      );
    }

    const spec = makeSpec({
      id: PANEL_ID,
      supersedes: PANEL_ID,
      panelVersion: SECOND_PANEL_VERSION,
      layout: defectiveNodes,
    });
    const error = errorOf(validatePanelSpec(spec));
    const issues = describedIssues(spec);
    const omission = /and (\d+) more/.exec(error.message);

    expect(reportedIssues(error)).toHaveLength(issues.length);
    expect(omission).not.toBeNull();

    const omitted = Number(omission?.[1] ?? '0');
    const listed = issues.length - omitted;

    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(issues.length);

    for (const issue of issues.slice(0, listed)) {
      expect(error.message).toContain(issue.path);
    }
  });

  it('reports only codes from the closed invariant vocabulary', () => {
    const error = errorOf(validatePanelSpec(threeDefectSpec()));

    for (const code of reportedCodes(error)) {
      expect(isPanelValidationIssueCode(code)).toBe(true);
    }
  });

  it('distinguishes its own codes from the schema library codes', () => {
    // Both kinds share one `issues` array, and the predicate is how a reader
    // tells them apart — a schema issue code is deliberately not a member.
    const schemaError = errorOf(validatePanelSpec(specRecord({ version: PANEL_SPEC_VERSION + 1 })));
    const schemaCodes = reportedCodes(schemaError);

    expect(schemaCodes.length).toBeGreaterThan(0);

    for (const code of schemaCodes) {
      expect(isPanelValidationIssueCode(code)).toBe(false);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * The closed issue vocabulary, and one defective document per member
 *
 * The table below is the completeness statement: a code added to
 * `PANEL_VALIDATION_ISSUE_CODES` without a document that produces it fails the
 * final test in this block, so the vocabulary cannot grow a member nothing
 * exercises.
 * ---------------------------------------------------------------------------
 */

/** One invariant rule, the document that breaks it, and the path it reports. */
interface InvariantCase {
  readonly code: PanelValidationIssueCode;
  readonly path: string;
  readonly document: unknown;
}

/** The first node's path, which every single-node case below reports against. */
const FIRST_NODE_PATH = `${PANEL_LAYOUT_FIELD}.0`;

/** A document holding exactly one node, built from a record. */
function oneNodeDocument(record: Readonly<Record<string, unknown>>): unknown {
  return specRecord({ layout: [record] });
}

const INVARIANT_CASES: readonly InvariantCase[] = [
  {
    code: 'panel_node_type_unknown',
    path: FIRST_NODE_PATH,
    document: oneNodeDocument(nodeRecord(UNCATALOGUED_NODE_TYPE, { id: FIRST_NODE_PATH })),
  },
  {
    code: 'panel_node_query_missing',
    path: `${FIRST_NODE_PATH}.query`,
    document: oneNodeDocument(withoutField(nodeRecord('table', { id: FIRST_NODE_PATH }), 'query')),
  },
  {
    code: 'panel_node_query_forbidden',
    path: `${FIRST_NODE_PATH}.query`,
    document: oneNodeDocument(
      nodeRecord('section', { id: FIRST_NODE_PATH, query: { source: DATA_QUERY_SOURCES[0] } }),
    ),
  },
  {
    code: 'panel_node_query_source_missing',
    path: `${FIRST_NODE_PATH}.query.source`,
    document: oneNodeDocument(nodeRecord('table', { id: FIRST_NODE_PATH, query: {} })),
  },
  {
    code: 'panel_node_query_source_unknown',
    path: `${FIRST_NODE_PATH}.query.source`,
    document: oneNodeDocument(
      nodeRecord('table', { id: FIRST_NODE_PATH, query: { source: UNCATALOGUED_SOURCE } }),
    ),
  },
  {
    code: 'panel_node_query_source_not_allowed',
    path: `${FIRST_NODE_PATH}.query.source`,
    document: oneNodeDocument(
      nodeRecord(SOURCE_MISMATCH.type, {
        id: FIRST_NODE_PATH,
        query: { source: SOURCE_MISMATCH.source },
      }),
    ),
  },
  {
    code: 'panel_node_metrics_missing',
    path: `${FIRST_NODE_PATH}.metrics`,
    document: oneNodeDocument(
      withoutField(nodeRecord('metricCards', { id: FIRST_NODE_PATH }), 'metrics'),
    ),
  },
  {
    code: 'panel_node_metrics_empty',
    path: `${FIRST_NODE_PATH}.metrics`,
    document: oneNodeDocument(nodeRecord('metricCards', { id: FIRST_NODE_PATH, metrics: [] })),
  },
  {
    code: 'panel_node_metric_unknown',
    path: `${FIRST_NODE_PATH}.metrics.0`,
    document: oneNodeDocument(
      nodeRecord('metricCards', { id: FIRST_NODE_PATH, metrics: [UNCATALOGUED_METRIC] }),
    ),
  },
  {
    code: 'panel_node_children_forbidden',
    path: `${FIRST_NODE_PATH}.${PANEL_CHILDREN_FIELD}`,
    document: oneNodeDocument(nodeRecord('flame', { id: FIRST_NODE_PATH, children: [] })),
  },
  {
    code: 'panel_node_children_missing',
    path: `${FIRST_NODE_PATH}.${PANEL_CHILDREN_FIELD}`,
    document: oneNodeDocument(
      withoutField(nodeRecord('section', { id: FIRST_NODE_PATH }), PANEL_CHILDREN_FIELD),
    ),
  },
  {
    code: 'panel_node_children_empty',
    path: `${FIRST_NODE_PATH}.${PANEL_CHILDREN_FIELD}`,
    document: oneNodeDocument(nodeRecord('split', { id: FIRST_NODE_PATH, children: [] })),
  },
  {
    code: 'panel_node_depth_exceeded',
    path: nestedNodeId(PANEL_MAX_NODE_DEPTH),
    document: makeSpec({ layout: [nestedLayout(PANEL_MAX_NODE_DEPTH + 1)] }),
  },
  {
    code: 'panel_node_id_duplicate',
    path: `${PANEL_LAYOUT_FIELD}.1.id`,
    document: makeSpec({
      layout: [
        makeNode('timeline', { id: FIRST_NODE_PATH }),
        makeNode('waterfall', { id: FIRST_NODE_PATH }),
      ],
    }),
  },
  {
    code: 'panel_supersedes_self',
    path: 'supersedes',
    document: makeSpec({
      id: PANEL_ID,
      supersedes: PANEL_ID,
      panelVersion: SECOND_PANEL_VERSION,
    }),
  },
  {
    code: 'panel_supersedes_on_first_version',
    path: 'panelVersion',
    document: makeSpec({ supersedes: PREVIOUS_PANEL_ID, panelVersion: FIRST_PANEL_VERSION }),
  },
  {
    code: 'panel_fact_evidence_empty',
    path: 'summary.observed.0.evidence',
    document: makeSpec({
      summary: { observed: [makeFact({ evidence: [] })], likelyCauses: [] },
    }),
  },
];

describe('the closed invariant issue vocabulary', () => {
  it.each(INVARIANT_CASES)('reports $code at $path', ({ code, path, document }) => {
    expect(describedIssues(asSpec(document))).toContainEqual({ path, code });
  });

  it.each(INVARIANT_CASES)('rejects the document that produces $code', ({ document }) => {
    // Whichever half catches it, the document must not be accepted: an invariant
    // defect and a schema defect are one branch for the caller — "this panel
    // cannot be shown, use the fallback".
    expect(isErr(validatePanelSpec(document))).toBe(true);
  });

  it('covers every member of the vocabulary', () => {
    const covered = [...new Set(INVARIANT_CASES.map((testCase) => testCase.code))].sort();

    expect(covered).toStrictEqual([...PANEL_VALIDATION_ISSUE_CODES].sort());
  });

  it('answers the membership predicate for every member', () => {
    for (const code of PANEL_VALIDATION_ISSUE_CODES) {
      expect(isPanelValidationIssueCode(code)).toBe(true);
    }

    expect(isPanelValidationIssueCode('panel_not_a_real_code')).toBe(false);
    expect(isPanelValidationIssueCode(undefined)).toBe(false);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Privacy: a rejection carries shape, never content (AAP §0.5.2)
 *
 * A panel specification is model-authored prose *about* captured runtime data,
 * and the error a rejection produces is logged, may be persisted with the
 * session, and travels to the DevTools panel and the editor webview through the
 * protocol's `error` payload — passing through neither the redaction layer nor
 * the outbound model guard on the way. The only safe rule is that the offending
 * data never enters the report, so this suite plants sentinels in the seven
 * fields that could plausibly hold sensitive content and hunts for them in every
 * rendering of the failure.
 * ---------------------------------------------------------------------------
 */

/**
 * The string the privacy suite hunts for.
 *
 * Deliberately unmistakable and deliberately not a plausible panel value: if it
 * appears in a serialised failure, the only way it got there is a rejected value
 * having been copied into the report.
 */
const LEAK_SENTINEL = 'do-not-leak-this-value';

/** One field a sentinel is planted in, with a name for the test title. */
interface SentinelField {
  readonly label: string;
  readonly value: string;
}

/**
 * The seven places a sentinel is planted, each a field that carries content
 * derived from the capture or from the model's reading of it.
 *
 * Each value embeds {@link LEAK_SENTINEL} with its own suffix, so a failing
 * assertion names the field that leaked rather than merely reporting that
 * something did.
 */
const SENTINEL_FIELDS: readonly SentinelField[] = [
  { label: 'the panel title', value: `${LEAK_SENTINEL}-panel-title` },
  { label: 'a node title', value: `${LEAK_SENTINEL}-node-title` },
  { label: 'a query filter trace id', value: `${LEAK_SENTINEL}-trace-id` },
  { label: 'a query filter component name', value: `${LEAK_SENTINEL}-component` },
  { label: 'an observed statement', value: `${LEAK_SENTINEL}-statement` },
  { label: 'an evidence label', value: `${LEAK_SENTINEL}-evidence-label` },
  { label: 'a suggested location file', value: `src/${LEAK_SENTINEL}/module.ts` },
];

/** A sentinel value by the label it was planted under. */
function sentinel(label: string): string {
  const field = SENTINEL_FIELDS.find((candidate) => candidate.label === label);

  if (field === undefined) {
    throw new Error(`No sentinel is planted for ${label}.`);
  }

  return field.value;
}

/**
 * The summary of the sentinel-bearing document: one observed fact, one likely
 * cause, prose, and a resolved location.
 *
 * Every field is schema-legal, so the document reaches the invariant half of the
 * check rather than being turned back by the schema — which is the half whose
 * messages name issue paths, and therefore the half where a leak would be
 * hardest to notice.
 */
function sentinelSummary(): PanelSummary {
  return {
    observed: [
      makeFact({
        statement: sentinel('an observed statement'),
        evidence: [{ eventId: EVENT_ID, label: sentinel('an evidence label') }],
      }),
    ],
    likelyCauses: [
      makeHypothesis({
        suggestedLocation: {
          ...SAFE_LOCATION,
          file: sentinel('a suggested location file'),
        },
      }),
    ],
  };
}

/**
 * A document carrying every sentinel and exactly one invariant defect: two
 * nodes sharing an id.
 *
 * The defect is deliberately unrelated to the sentinels, so a leak would have to
 * come from the report's construction rather than from the field that failed.
 */
function sentinelSpec(): PanelSpec {
  const repeated = `${PANEL_LAYOUT_FIELD}.0`;

  return makeSpec({
    title: sentinel('the panel title'),
    summary: sentinelSummary(),
    layout: [
      makeNode('timeline', {
        id: repeated,
        title: sentinel('a node title'),
        query: {
          source: 'trace',
          filter: {
            traceId: sentinel('a query filter trace id'),
            component: sentinel('a query filter component name'),
          },
        },
      }),
      makeNode('timeline', { id: repeated }),
    ],
  });
}

/** Every rendering of a failure that can reach a log, a store or a screen. */
function renderingsOf(
  error: DebuggenError,
): readonly { readonly label: string; readonly text: string }[] {
  return [
    { label: 'message', text: error.message },
    { label: 'hint', text: error.hint ?? '' },
    { label: 'details', text: JSON.stringify(error.details) },
    { label: 'payload', text: JSON.stringify(error.toPayload()) },
  ];
}

describe('a rejection leaks no panel content', () => {
  it.each(SENTINEL_FIELDS)(
    'keeps $label out of every rendering of an invariant failure',
    ({ value }) => {
      const error = errorOf(validatePanelSpec(sentinelSpec()));

      for (const rendering of renderingsOf(error)) {
        expect(rendering.text, `${rendering.label} leaked the sentinel`).not.toContain(value);
      }
    },
  );

  it.each(SENTINEL_FIELDS)(
    'keeps $label out of every rendering of a schema failure',
    ({ value }) => {
      // The other half of the check, reached by adding a key the strict document
      // schema refuses. Its rejection is built by `./summary.ts`'s issue
      // describer, so this asserts the one privacy rule through both paths.
      const document = { ...sentinelSpec(), [UNRECOGNISED_KEY]: sentinel('the panel title') };
      const error = errorOf(validatePanelSpec(document));

      for (const rendering of renderingsOf(error)) {
        expect(rendering.text, `${rendering.label} leaked the sentinel`).not.toContain(value);
      }
    },
  );

  it.each(SENTINEL_FIELDS)('keeps $label out of the error the assertion throws', ({ value }) => {
    const thrown = thrownBy(sentinelSpec());

    for (const rendering of renderingsOf(thrown)) {
      expect(rendering.text, `${rendering.label} leaked the sentinel`).not.toContain(value);
    }
  });

  it('never carries the sentinel string in any form', () => {
    // A single composite assertion beside the per-field ones: a leak through a
    // rendering this file has not enumerated would still have to contain the base
    // sentinel.
    const error = errorOf(validatePanelSpec(sentinelSpec()));
    const serialised = renderingsOf(error)
      .map((rendering) => rendering.text)
      .join('|');

    expect(serialised).not.toContain(LEAK_SENTINEL);
  });

  it('still names the issue paths, which is what the service logs', () => {
    // Leaking nothing is necessary but not sufficient: a message that says
    // nothing leaves a developer with a rejection they cannot locate.
    const spec = sentinelSpec();
    const error = errorOf(validatePanelSpec(spec));

    expect(describedIssues(spec)).toStrictEqual([
      { path: `${PANEL_LAYOUT_FIELD}.1.id`, code: 'panel_node_id_duplicate' },
    ]);
    expect(error.message).toContain(`${PANEL_LAYOUT_FIELD}.1.id`);
    expect(error.message).toContain('panel_node_id_duplicate');
    expect(reportedPaths(error)).toStrictEqual([`${PANEL_LAYOUT_FIELD}.1.id`]);
  });

  it('reports a node type only from the closed vocabulary', () => {
    // The one value-like field an issue may carry. It is a member of the node
    // vocabulary by construction, never the string that caused a rejection.
    const error = errorOf(validatePanelSpec(sentinelSpec()));

    for (const issue of reportedIssues(error)) {
      if (issue.nodeType !== undefined) {
        expect(NODE_TYPE_NAMES).toContain(issue.nodeType);
      }
    }
  });

  it('uses a code from the closed shared vocabulary rather than an invented one', () => {
    // Mechanically proves no code was invented: the tuple is imported from
    // `@debuggen/shared`, and the protocol's `error` payload parses against the
    // same closed set at the far end of the wire.
    const invariantCode = errorOf(validatePanelSpec(sentinelSpec())).code;
    const schemaCode = errorOf(
      validatePanelSpec(specRecord({ version: PANEL_SPEC_VERSION + 1 })),
    ).code;

    expect(DEBUGGEN_ERROR_CODES).toContain(invariantCode);
    expect(DEBUGGEN_ERROR_CODES).toContain(schemaCode);
    expect(invariantCode).toBe(REJECTION_CODE);
    expect(schemaCode).toBe(REJECTION_CODE);
  });

  it('keeps the structured issue list out of the wire payload', () => {
    // `toPayload()` deliberately does not forward `details`: the structured list
    // is diagnostic context for this process's log, and the payload is what both
    // user interfaces render.
    const error = errorOf(validatePanelSpec(threeDefectSpec()));
    const payload = error.toPayload();

    expect(reportedIssues(error).length).toBeGreaterThan(0);
    expect(Object.keys(payload).sort()).toStrictEqual(['code', 'hint', 'message']);
    expect(JSON.stringify(payload)).not.toContain('issues');
  });
});
