/**
 * `host/PanelHost` — the colocated suite for the renderer's entry point.
 *
 * ## What this suite is protecting
 *
 * `PanelHost` is the one component both product surfaces mount, so the
 * guarantees a generated panel makes are kept — or lost — here. Four of them are
 * product promises rather than rendering details, and each has a case below that
 * fails the moment the promise stops holding:
 *
 *   - **A fallback panel says so, in words.** A specification carrying
 *     `meta.fallback` is drawn under a visible notice, reachable by an
 *     accessible text query rather than legible only as a colour or a class, and
 *     the views below it still render — a deterministic summary of a real
 *     capture is worth reading, and a failure is never presented as a
 *     successful analysis (AAP 0.5.5, 0.5.3).
 *   - **Observed evidence never blurs into inferred cause.** The two registers
 *     render as two separately labelled regions, neither inside the other, and
 *     the summary's `headline` — non-evidentiary prose, which "can never become
 *     a Fact" — appears in the panel but never inside the observed-facts region
 *     (AAP 0.2.3, 0.8.4).
 *   - **A location travels unmodified.** Activating a `sourceLink` node's chip,
 *     and separately a likely cause's suggested-location chip, reports the very
 *     location the document carried: every field, including `symbol`,
 *     `endLine`, `resolvedBy` and `confidence`. This is hop 1 of the
 *     click-to-source chain, and the hops after it can only be as accurate as
 *     what leaves here (AAP 0.4.2).
 *   - **The document is read, never written.** The specification is held by the
 *     store, carried by the transport and rendered by two surfaces at once, so a
 *     convenience sort or a filled-in default here would change what a developer
 *     sees somewhere else. The no-mutation case clones the document before the
 *     render and compares after a render *and* after an interaction.
 *
 * Alongside those, the theme case pins the design system's own contract — the
 * theme attribute is applied for every `PanelTheme`, resolved through the
 * tokens' helper rather than through a literal (AAP 0.6.3, 0.6.4) — the
 * recursion case proves a nested layout is rendered level by level with stable
 * keys, and the empty-layout case pins the distinction between "this panel
 * specifies no views" (a state) and "this panel failed" (an error), which the
 * fallback case pins from the other side.
 *
 * Five host contracts that are not visible in a single settled render have
 * their own cases, because each is lost silently rather than loudly:
 *
 *   - **The query lifecycle, composed.** Through the real host, contexts and node
 *     renderer, a query the provider has not answered draws the loading state;
 *     the answer replaces it with the view; a rejection draws the error state,
 *     and its retry asks the provider the *same* query again. A controllable
 *     provider holds each answer until the case releases it, so every
 *     intermediate state is observed rather than raced past.
 *   - **Every query names its panel's session.** The resolver is handed the
 *     specification's `sessionId` with each query, a document that moves to
 *     another session re-asks under the new one, and a document with no usable
 *     session is an error rather than a request the service cannot route
 *     (`POST /sessions/:id/panel-data`, AAP 0.4.2). The two seam rules the host
 *     relies on — the provider refuses a blank session before its resolver
 *     runs, and the query hook hands a view the wire's `null` "last page"
 *     marker as the one end-of-data value, `undefined` — are pinned here too,
 *     because the host tier's two suites are this one and the registry's.
 *   - **Unrelated host changes re-render no view.** A surface that rebuilds its
 *     actions object from the same callbacks, or re-delivers a document whose
 *     layout nodes did not change, re-renders none of the visualizations; a
 *     callback that did change does re-render them, which is what proves the
 *     render counter is watching the right thing.
 *   - **Siblings are keyed by node id.** Reordering two sibling nodes moves the
 *     mounted view rather than remounting it, so it keeps its state and asks
 *     for nothing again — which a position-derived key cannot do.
 *   - **The outline is stated once and stepped once.** The title is an `h2`,
 *     the top-level nodes `h3`, and each titled container puts its children
 *     exactly one level deeper; an untitled container adds no level. Without a
 *     selection handler, the head's citations are inert text rather than
 *     focusable controls that do nothing.
 *
 * ## What this suite deliberately does not do
 *
 * **It never validates a specification before rendering it.** No parser and no
 * validator is imported: every document below is built by {@link makeSpec} and
 * handed to the component as it stands. That is the contract, not an oversight —
 * `PanelHost` draws a document that was parsed against the schema and checked
 * against its capture by the coordination service, and a second, weaker check
 * inside the renderer would be a second opinion about what a valid panel is. A
 * case that needed `parsePanelSpec` to make the host behave would be evidence
 * that the boundary had moved.
 *
 * **It does not re-test the components.** The stub provider answers with the
 * smallest response that lets a query-backed node settle, because what is under
 * test here is the host: the contexts it provides, the order it draws in, the
 * recursion it drives and the callbacks it wires. The lifecycle cases above
 * drive one view through its states only to prove the *composition* carries
 * them — that the provider, session and retry the host provides reach a view
 * three containers deep. How each view draws its own loading, empty and error
 * states belongs to its colocated suite, and the one-to-one coverage of the
 * node catalog belongs to the registry's own colocated suite.
 *
 * ## Harness conventions
 *
 *   - **Test API imported explicitly** from `vitest`, and `afterEach(cleanup)`
 *     registered explicitly, as every suite in this repository does: the
 *     `panel-renderer` project enables `globals` only so
 *     `@testing-library/react` can register its automatic cleanup, and a suite
 *     that leaks a mounted tree fails later with a multiple-match error that
 *     reads like a component bug.
 *   - **In-file synthetic builders, no fixture files**, and nothing imported
 *     from a sibling suite: test files in this repository do not depend on each
 *     other.
 *   - **Generic fixture vocabulary only** (AAP 0.5.4). Every title, statement,
 *     caption, id and path below is obviously synthetic product prose naming no
 *     application, demonstration or otherwise.
 *   - **Queries by role and accessible name**, scoped with `within` wherever a
 *     case is about *where* something rendered. A class is read only off an
 *     element already obtained semantically, since no `jest-dom` matcher is
 *     available in this repository.
 *   - **No copied format strings.** A source chip's accessible name is composed
 *     with the shared package's own `formatSourceLocation`, and a node's
 *     accessible name comes from the node catalog, so a change to either fails
 *     here instead of drifting past.
 *   - **No timers and no fake clocks.** A query-backed node settles through
 *     `await screen.findAllByRole(…)` inside {@link renderPanel}, which is also
 *     what keeps React state updates inside the test's own await and out of the
 *     console. A controllable provider's answer is released immediately before
 *     the `findBy…` query that waits for it, for the same reason.
 *   - **Renders are counted, not inferred.** The metric view and source chip
 *     modules are wrapped by pass-through spies (see the `vi.mock` calls
 *     below), so "this view did not re-render" is a call count rather than a
 *     guess from unchanged markup. Each wrapper calls the real component, so
 *     every other case renders exactly what it would unwrapped.
 *
 * @see ./PanelHost for the component, its four responsibilities and the four it
 * refuses.
 * @see ../layout/SummaryHeader for the observed/inferred separation this suite
 * asserts through the host.
 * @see ./DataProvider for the seam the stub below implements.
 */

import {
  PANEL_NODE_CATALOG,
  PANEL_SPEC_VERSION,
  catalogEntryFor,
  walkPanelNodes,
} from '@debuggen/panel-schema';
import type {
  DataQuery,
  Fact,
  Hypothesis,
  PanelNode,
  PanelSpec,
  PanelSummary,
} from '@debuggen/panel-schema';
import { DebuggenError, formatSourceLocation } from '@debuggen/shared';
import type { SourceLocation } from '@debuggen/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { MetricCards } from '../components/MetricCards';
import { SourceLink } from '../components/SourceLink';
import { SummaryHeader } from '../layout/SummaryHeader';
import {
  DEFAULT_PANEL_THEME,
  PANEL_THEMES,
  PANEL_THEME_ATTRIBUTE,
  panelThemeAttributeValue,
} from '../tokens/theme';
import type { PanelTheme } from '../tokens/theme';
import { DataProviderContext, PanelSessionContext, createDataProvider } from './DataProvider';
import type {
  DataProvider,
  DataQueryResolver,
  DataQueryResolverContext,
  DataQueryResponse,
  DataResultFor,
} from './DataProvider';
import { PanelHost } from './PanelHost';
import type { PanelActions, PanelEventRef } from './PanelActions';
import { useQuery } from './useQuery';

/*
 * Two views, each wrapped by a pass-through spy so its renders can be counted.
 *
 * The registry (and, for the source chip, the summary head) imports each view
 * from these modules, so the spy is what every such node in this suite renders
 * — and it calls the real component with the arguments React passed, so what
 * is drawn is unchanged. Hoisted by Vitest above the imports, as a module mock
 * must be. Two views, because they answer different questions: the metric view
 * reads data and no actions, so its count isolates the layout's own
 * memoization; the source chip reads the actions context, so its count is what
 * a changed — or needlessly rebuilt — context value shows up in.
 *
 * Counts are read as a difference across one gesture ({@link countRenders}),
 * never as an absolute: the suite's `afterEach` restores `vi.spyOn` spies only,
 * so these counts accumulate across cases by design.
 */
vi.mock(import('../components/MetricCards'), async (importOriginal) => {
  const actual = await importOriginal();

  return { ...actual, MetricCards: vi.fn(actual.MetricCards) };
});

vi.mock(import('../components/SourceLink'), async (importOriginal) => {
  const actual = await importOriginal();

  return { ...actual, SourceLink: vi.fn(actual.SourceLink) };
});

/*
 * ---------------------------------------------------------------------------
 * The synthetic vocabulary
 *
 * Every string a case queries by is declared once here, so that an assertion
 * names the same value the builder wrote. Nothing below is read out of an
 * inspected project, and nothing names an application: these are placeholders
 * chosen to be unmistakably placeholders (AAP 0.5.4).
 * ---------------------------------------------------------------------------
 */

/** The panel's own id. A single token, which is all the schema asks of an id. */
const PANEL_ID = 'panel-under-test';

/** The session the panel claims to belong to. */
const SESSION_ID = 'session-under-test';

/** A second session, for the case that moves a panel from one session to another. */
const OTHER_SESSION_ID = 'session-under-test-other';

/**
 * A session id that names nothing: present, a string, and blank.
 *
 * The schema would reject it, and this renderer validates nothing, so a
 * document carrying it is exactly how a host bug reaches the views.
 */
const BLANK_SESSION_ID = '   ';

/** The machine code the controllable provider rejects a first attempt with. */
const PROVIDER_FAILURE_CODE = 'TRANSPORT_DISCONNECTED';

/**
 * The code the query hook reports when a view is mounted with a provider but
 * no usable session: a wiring defect in the host, not a transport failure.
 */
const MISSING_SESSION_CODE = 'INTERNAL';

/**
 * The code the provider rejects a query addressed to no session with, before
 * its resolver can put it on the wire.
 */
const UNADDRESSED_QUERY_CODE = 'PROTOCOL_INVALID_MESSAGE';

/**
 * The error state's retry control, matched by pattern: the case is about the
 * control being offered and doing the right thing, not about one wording.
 */
const RETRY_PATTERN = /retry/i;

/** The accessible name of {@link NextOffsetProbe}'s output. */
const NEXT_OFFSET_LABEL = 'next offset';

/** The title of the titled container of {@link makeUntitledMiddleLayout}. */
const OUTER_TITLE = 'Titled outer section';

/** The title of the titled container nested under an untitled one. */
const INNER_TITLE = 'Titled inner split';

/** The panel's title, rendered as the head's heading. */
const PANEL_TITLE = 'Panel under test';

/**
 * The summary's non-evidentiary prose.
 *
 * Deliberately worded as prose about the panel rather than as a claim about a
 * capture: the integrity case asserts this sentence never lands inside the
 * observed-facts region, and a reader of a failure should be able to see at a
 * glance which register it belongs to.
 */
const SUMMARY_HEADLINE = 'A headline is prose about the panel and is never an observed fact.';

/** The first observed statement. */
const FIRST_OBSERVED_STATEMENT = 'The first observed measurement was recorded during the capture.';

/** The second observed statement. */
const SECOND_OBSERVED_STATEMENT =
  'The second observed measurement was recorded during the capture.';

/** The inferred statement, which must render in the causes region and nowhere else. */
const LIKELY_CAUSE_STATEMENT = 'An explanation that the two observations above might have.';

/** The caption of the first fact's citation, and the name its chip is queried by. */
const FIRST_CITATION_LABEL = 'first citation';

/** The caption of the second fact's citation. */
const SECOND_CITATION_LABEL = 'second citation';

/** The caption of the likely cause's citation. */
const CAUSE_CITATION_LABEL = 'cause citation';

/** The event the first fact cites. */
const FIRST_EVENT_ID = 'evt-first-observation';

/** The event the second fact cites. */
const SECOND_EVENT_ID = 'evt-second-observation';

/** The event the likely cause cites. */
const CAUSE_EVENT_ID = 'evt-likely-cause';

/**
 * The trace and span coordinates the first citation records.
 *
 * Present so that the evidence-chip case asserts the *whole* reference travels
 * rather than only its id: the optional coordinates are what let a host scope a
 * trace-filtered view without a lookup, and dropping them would be invisible to
 * a case that only checked `eventId`. The two values are the canonical W3C
 * trace-context example identifiers — 32 and 16 hexadecimal characters, which
 * is exactly what the citation schema requires.
 */
const CITATION_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

/** The span coordinate of the first citation. See {@link CITATION_TRACE_ID}. */
const CITATION_SPAN_ID = '00f067aa0ba902b7';

/**
 * The accessible name of the observed region, as AAP 0.7.3 fixes it.
 *
 * Restated here rather than imported because `../layout/SummaryHeader` keeps its
 * two captions private, which is correct — they are its copy, not a shared
 * vocabulary. Stating them in the suite is therefore also a guard on the
 * wording: renaming either region breaks this file, which is where a reader
 * would want to be told.
 */
const OBSERVED_REGION_NAME = 'Observed';

/** The accessible name of the likely-cause region, as AAP 0.8.4 fixes it. */
const LIKELY_CAUSE_REGION_NAME = 'Likely cause';

/** The title of the outermost container of {@link makeNestedLayout}. */
const SECTION_TITLE = 'Outer section';

/** The title of the middle container of {@link makeNestedLayout}. */
const SPLIT_TITLE = 'Inner split';

/** The title of the innermost container of {@link makeNestedLayout}. */
const STACK_TITLE = 'Innermost stack';

/**
 * The location the standalone source-link node points at.
 *
 * Carries all seven fields, both optional ones included, because the forwarding
 * case asserts the payload field for field: a location that only ever had the
 * five required fields could not detect a component that dropped the other two.
 */
const NODE_LOCATION: SourceLocation = {
  file: 'src/example/chip-target.ts',
  line: 7,
  column: 3,
  symbol: 'chipTarget',
  endLine: 9,
  resolvedBy: 'patch',
  confidence: 1,
};

/**
 * The location the likely cause suggests.
 *
 * Every field differs from {@link NODE_LOCATION} — including the resolution
 * route and its confidence — so the two forwarding cases cannot pass by
 * accident on each other's object, and so a chip queried by its accessible name
 * is unambiguous.
 */
const CAUSE_LOCATION: SourceLocation = {
  file: 'src/example/cause-target.ts',
  line: 31,
  column: 11,
  symbol: 'causeTarget',
  endLine: 44,
  resolvedBy: 'source-map',
  confidence: 0.75,
};

/**
 * The metric id the query-backed node in {@link makeNestedLayout} asks for.
 *
 * One id, from the product's own closed metric vocabulary. The vocabulary is
 * deliberately not imported as a runtime value: this suite must not iterate it,
 * and a single id is all a host case needs to make a view settle.
 */
const NODE_METRIC_ID = 'render_count';

/**
 * The one value the stub provider answers a metrics query with.
 *
 * Typed through `DataResultFor` rather than by naming the aggregate's own type,
 * which keeps this suite's imports inside the three packages the renderer may
 * depend on while still being checked field for field against the shape the
 * contract promises.
 */
const METRIC_VALUES: DataResultFor<'metrics'> = [
  { id: NODE_METRIC_ID, label: 'Recorded renders', unit: 'count', available: true, value: 4 },
];

/**
 * The accessible name the settled metric view renders under, taken from the node
 * catalog so that the label and the assertion cannot drift apart.
 */
const METRIC_VIEW_NAME = PANEL_NODE_CATALOG.metricCards.label;

/**
 * The text a reader must be able to find when a panel arrived as a fallback.
 *
 * A pattern rather than the sentence, matched against the notice's own words:
 * the case is about the *statement* being in the accessibility tree — that what
 * is on screen is a fallback view — and not about `PanelHost` keeping one
 * particular phrasing of it.
 */
const FALLBACK_TEXT_PATTERN = /fallback view/i;

/**
 * React's warning about a list rendered without stable keys, in the two
 * spellings it has used.
 *
 * Matched against everything the render wrote to `console.error`, because a
 * missing key is not a failed render: the panel would look correct and then
 * lose a node's state on the next render of its parent.
 */
const KEY_WARNING_PATTERN = /unique .?key.? prop|each child in a list/i;

/*
 * ---------------------------------------------------------------------------
 * Builders
 * ---------------------------------------------------------------------------
 */

/** The citation shape the head renders as a chip, as this suite builds it. */
interface CitationOverrides {
  /** The cited event's id. */
  readonly eventId: string;

  /** The chip's caption, which is also the name a case queries it by. */
  readonly label: string;

  /** The trace coordinate, when the case wants the optional fields present. */
  readonly traceId?: string | undefined;

  /** The span coordinate, when the case wants the optional fields present. */
  readonly spanId?: string | undefined;
}

/**
 * One citation.
 *
 * The optional coordinates are omitted rather than stored as `undefined`, which
 * is what `exactOptionalPropertyTypes` asks of a builder and what makes the
 * forwarding assertion's key-set comparison meaningful.
 *
 * @param overrides The citation's fields.
 * @returns A fresh citation.
 */
function makeCitation(overrides: CitationOverrides): Fact['evidence'][number] {
  const { eventId, label, traceId, spanId } = overrides;

  return {
    eventId,
    label,
    ...(traceId === undefined ? {} : { traceId }),
    ...(spanId === undefined ? {} : { spanId }),
  };
}

/**
 * The two observed facts of {@link makeSummary}.
 *
 * Built fresh on every call, so a case that mutates nothing can still prove it:
 * two documents built by this suite share no object.
 *
 * @returns Two facts, each carrying at least one citation as the schema requires.
 */
function makeFacts(): readonly Fact[] {
  return [
    {
      statement: FIRST_OBSERVED_STATEMENT,
      evidence: [
        makeCitation({
          eventId: FIRST_EVENT_ID,
          label: FIRST_CITATION_LABEL,
          traceId: CITATION_TRACE_ID,
          spanId: CITATION_SPAN_ID,
        }),
      ],
    },
    {
      statement: SECOND_OBSERVED_STATEMENT,
      evidence: [makeCitation({ eventId: SECOND_EVENT_ID, label: SECOND_CITATION_LABEL })],
    },
  ];
}

/**
 * The one likely cause of {@link makeSummary}: a ranked, evidence-backed
 * explanation that also names a place in the project.
 *
 * @returns One hypothesis, with a confidence and a suggested location.
 */
function makeHypotheses(): readonly Hypothesis[] {
  return [
    {
      statement: LIKELY_CAUSE_STATEMENT,
      evidence: [makeCitation({ eventId: CAUSE_EVENT_ID, label: CAUSE_CITATION_LABEL })],
      confidence: 'high',
      suggestedLocation: { ...CAUSE_LOCATION },
    },
  ];
}

/** What a case may replace in {@link makeSummary}. */
interface SummaryOverrides {
  /** The prose, or `undefined` for a summary that carries none. */
  readonly headline?: string | undefined;

  /** The observed facts; an empty array renders no observed region. */
  readonly observed?: readonly Fact[] | undefined;

  /** The likely causes; an empty array renders no causes region. */
  readonly likelyCauses?: readonly Hypothesis[] | undefined;
}

/**
 * A summary with all three registers populated.
 *
 * @param overrides Registers to replace.
 * @returns A fresh summary.
 */
function makeSummary(overrides: SummaryOverrides = {}): PanelSummary {
  const {
    headline = SUMMARY_HEADLINE,
    observed = makeFacts(),
    likelyCauses = makeHypotheses(),
  } = overrides;

  return {
    observed: [...observed],
    likelyCauses: [...likelyCauses],
    ...(headline === undefined ? {} : { headline }),
  };
}

/**
 * A layout three containers deep with two leaves at the bottom.
 *
 * `section` → `split` → `stack` → a query-backed view, with the standalone
 * source-link leaf as the split's second pane. The shape is chosen to be the
 * one a recursion can get wrong in every interesting way: three labelled
 * levels, so a level that is skipped or drawn twice is visible; a container
 * whose children are a list, so a missing key is reported; two sibling panes,
 * which is the minimum a division has; and one leaf of each kind, so both the
 * query-resolving path and the location-carrying path are exercised.
 *
 * Node ids follow the document path the normaliser derives them from, which is
 * also the key the renderer uses, so a reader can see at a glance where each
 * node sits.
 *
 * @returns The layout, as a fresh forest.
 */
function makeNestedLayout(): readonly PanelNode[] {
  return [
    {
      type: 'section',
      id: 'layout.0',
      title: SECTION_TITLE,
      children: [
        {
          type: 'split',
          id: 'layout.0.children.0',
          title: SPLIT_TITLE,
          children: [
            {
              type: 'stack',
              id: 'layout.0.children.0.children.0',
              title: STACK_TITLE,
              children: [
                {
                  type: 'metricCards',
                  id: 'layout.0.children.0.children.0.children.0',
                  query: { source: 'metrics' },
                  metrics: [NODE_METRIC_ID],
                },
              ],
            },
            {
              type: 'sourceLink',
              id: 'layout.0.children.0.children.1',
              location: { ...NODE_LOCATION },
            },
          ],
        },
      ],
    },
  ];
}

/**
 * A titled section holding an **untitled** stack, which holds a titled split.
 *
 * The shape that separates "one level per titled container" from "one level
 * per container": the stack draws no heading, so the split must sit exactly
 * one level below the section rather than two.
 *
 * @returns The layout, as a fresh forest.
 */
function makeUntitledMiddleLayout(): readonly PanelNode[] {
  return [
    {
      type: 'section',
      id: 'layout.0',
      title: OUTER_TITLE,
      children: [
        {
          type: 'stack',
          id: 'layout.0.children.0',
          children: [
            {
              type: 'split',
              id: 'layout.0.children.0.children.0',
              title: INNER_TITLE,
              children: [
                {
                  type: 'sourceLink',
                  id: 'layout.0.children.0.children.0.children.0',
                  location: { ...NODE_LOCATION },
                },
                {
                  type: 'sourceLink',
                  id: 'layout.0.children.0.children.0.children.1',
                  location: { ...CAUSE_LOCATION },
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Two top-level siblings of different types: the query-backed view first, the
 * source link second.
 *
 * Different types on purpose. A position-derived key would hand the first slot
 * to whichever node arrives first, and React remounts a slot whose component
 * type changed — so reordering these two is the gesture that tells an id key
 * from a position key.
 *
 * @returns The two nodes, as fresh objects, in that order.
 */
function makeSiblingLayout(): readonly [PanelNode, PanelNode] {
  return [
    {
      type: 'metricCards',
      id: 'layout.0',
      query: { source: 'metrics' },
      metrics: [NODE_METRIC_ID],
    },
    {
      type: 'sourceLink',
      id: 'layout.1',
      location: { ...NODE_LOCATION },
    },
  ];
}

/** What a case may replace in {@link makeSpec}. */
interface SpecOverrides {
  /** The panel's title. */
  readonly title?: string | undefined;

  /**
   * The session the panel belongs to, {@link SESSION_ID} by default. Replaced
   * only by the routing cases, which move a panel between sessions or hand the
   * host one that names nothing.
   */
  readonly sessionId?: string | undefined;

  /** The summary; a case that is about the head replaces this. */
  readonly summary?: PanelSummary | undefined;

  /** The layout; an empty array is a validated panel with no views. */
  readonly layout?: readonly PanelNode[] | undefined;

  /**
   * The provenance metadata, omitted by default.
   *
   * Omitted rather than defaulted to `{ fallback: false }`, because that is how
   * an ordinary generated panel actually arrives — nothing fills the field in on
   * parse — and the banner's absence must be asserted against the real shape.
   */
  readonly meta?: PanelSpec['meta'];
}

/**
 * A valid, normalized panel specification.
 *
 * Built, never parsed: see this module's header on why no validator appears in
 * this suite. The shape is the one the normaliser produces — `version` at the
 * document format, an id and a session, a first-generation `panelVersion`, a
 * summary whose registers are populated and a layout of already-identified
 * nodes.
 *
 * @param overrides Fields to replace.
 * @returns A fresh specification sharing no object with any other.
 */
function makeSpec(overrides: SpecOverrides = {}): PanelSpec {
  const {
    title = PANEL_TITLE,
    sessionId = SESSION_ID,
    summary = makeSummary(),
    layout = makeNestedLayout(),
    meta,
  } = overrides;

  return {
    version: PANEL_SPEC_VERSION,
    id: PANEL_ID,
    sessionId,
    panelVersion: 1,
    title,
    summary,
    layout: [...layout],
    ...(meta === undefined ? {} : { meta }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The stub host: data provider and actions
 * ---------------------------------------------------------------------------
 */

/** A stub provider, its resolver and the queries it was asked. */
interface StubProvider {
  /** The provider to hand to the host. */
  readonly provider: DataProvider;

  /** The recorded resolver, for call counts and payloads. */
  readonly resolve: Mock<DataQueryResolver>;
}

/**
 * A provider that answers the one source this suite's specifications name.
 *
 * Built through the library's own `createDataProvider`, so these cases exercise
 * the very seam the DevTools panel and the editor webview implement, including
 * its guarantee that a response answers for the source it was asked about.
 *
 * A query for any other source is **rejected**, not answered with emptiness: the
 * provider contract forbids dressing a failure as data, and a silent empty
 * answer here would let a case pass against a node nobody meant to render.
 *
 * @returns The provider and its recorded resolver.
 */
function makeDataProvider(): StubProvider {
  const resolve = vi.fn<DataQueryResolver>((query) => {
    if (query.source === 'metrics') {
      return Promise.resolve(metricsResponse());
    }

    return Promise.reject(
      new DebuggenError(
        'NOT_IMPLEMENTED',
        `This suite's stub provider answers no "${query.source}" query.`,
        { hint: 'Name a source the suite resolves, or extend the stub deliberately.' },
      ),
    );
  });

  return { provider: createDataProvider(resolve), resolve };
}

/**
 * The response every metrics query in this suite is answered with.
 *
 * @returns A fresh response for the `metrics` source.
 */
function metricsResponse(): DataQueryResponse {
  return { source: 'metrics', data: METRIC_VALUES, total: METRIC_VALUES.length };
}

/** One query a {@link ControllableProvider} was asked and has not yet answered. */
interface PendingQuery {
  /** The query exactly as the resolver received it. */
  readonly query: DataQuery;

  /** The resolver context it arrived with: the session, and the abort signal. */
  readonly context: DataQueryResolverContext;

  /** Settles the call with a response. */
  readonly answer: (response: DataQueryResponse) => void;

  /** Settles the call with a rejection. */
  readonly fail: (error: Error) => void;
}

/** A provider whose every answer is held until the case releases it. */
interface ControllableProvider extends StubProvider {
  /**
   * The oldest query not yet taken, removed from the queue. Throws when the
   * provider has been asked nothing new, so a case that expected a request
   * fails at the line that expected it.
   */
  readonly takeNext: () => PendingQuery;
}

/**
 * A provider that answers nothing on its own.
 *
 * Each call parks a {@link PendingQuery} and returns a promise only the case can
 * settle, which is what makes the loading state observable at all: a provider
 * that answers on the next microtask settles before a case can look. Built
 * through `createDataProvider`, like the answering stub, so the seam under test
 * is the library's own — source check and session hand-over included.
 *
 * @returns The provider, its recorded resolver, and the queue of open calls.
 */
function makeControllableProvider(): ControllableProvider {
  const pending: PendingQuery[] = [];

  const resolve = vi.fn<DataQueryResolver>(
    (query, context) =>
      new Promise<DataQueryResponse>((answer, fail) => {
        pending.push({ query, context, answer, fail });
      }),
  );

  const takeNext = (): PendingQuery => {
    const next = pending.shift();
    if (next === undefined) {
      throw new Error('the controllable provider has no unanswered query');
    }

    return next;
  };

  return { provider: createDataProvider(resolve), resolve, takeNext };
}

/**
 * The resolver context of the `index`-th call a recorded resolver received.
 *
 * @param resolve The recorded resolver.
 * @param index The zero-based call index.
 * @returns The context of that call.
 */
function resolverContextAt(
  resolve: Mock<DataQueryResolver>,
  index: number,
): DataQueryResolverContext {
  const call = resolve.mock.calls[index];
  if (call === undefined) {
    throw new Error(`the data provider recorded no call at index ${String(index)}`);
  }

  return call[1];
}

/**
 * The query of the `index`-th call a recorded resolver received.
 *
 * @param resolve The recorded resolver.
 * @param index The zero-based call index.
 * @returns The query of that call.
 */
function resolverQueryAt(resolve: Mock<DataQueryResolver>, index: number): DataQuery {
  const call = resolve.mock.calls[index];
  if (call === undefined) {
    throw new Error(`the data provider recorded no call at index ${String(index)}`);
  }

  return call[0];
}

/** A host's `PanelActions`, with every member a panel could raise spied on. */
interface ActionSpies {
  /** The object to hand to the host. */
  readonly actions: PanelActions;

  /** The event-selection spy, which the evidence chips report through. */
  readonly onSelectEvent: Mock<(ref: PanelEventRef) => void>;

  /** The open-source spy, which every source chip reports through. */
  readonly onOpenSource: Mock<(location: SourceLocation) => void>;

  /** The disclosure spy, supplied so a case can assert it was not reached. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;

  /** The filter spy, supplied for the same reason. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh action spies.
 *
 * All four members are supplied, the two optional ones included: a case that
 * asserts what a gesture reported is only as strong as its ability to assert
 * what it did *not* report.
 *
 * @returns The actions object and its four spies.
 */
function makeActions(): ActionSpies {
  const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
  const onOpenSource = vi.fn<(location: SourceLocation) => void>();
  const onExpand = vi.fn<(nodeId: string, itemId: string, expanded: boolean) => void>();
  const onFilterChange = vi.fn<(nodeId: string, filter: Record<string, string>) => void>();

  return {
    actions: { onSelectEvent, onOpenSource, onExpand, onFilterChange },
    onSelectEvent,
    onOpenSource,
    onExpand,
    onFilterChange,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------------
 */

/** What {@link renderPanel} needs beyond the specification. */
interface RenderPanelOptions {
  /** The host actions. Fresh spies by default. */
  readonly actions?: ActionSpies | undefined;

  /** The provider resolving every node's query. A fresh stub by default. */
  readonly provider?: StubProvider | undefined;

  /** The theme to apply. Omitted, the shell applies the product default. */
  readonly theme?: PanelTheme | undefined;
}

/** What {@link renderPanel} hands a case. */
interface RenderedPanel {
  /** The container the tree was rendered into. */
  readonly container: HTMLElement;

  /** The action spies in scope for this render. */
  readonly actions: ActionSpies;

  /** The provider stub in scope for this render. */
  readonly provider: StubProvider;

  /**
   * Re-renders the same host with another document and, optionally, another
   * actions object — the provider and theme stay what they were, which is how
   * a surface re-delivers a panel. Does not wait for anything to settle.
   */
  readonly rerender: (spec: PanelSpec, actions?: PanelActions) => void;
}

/**
 * How many nodes of a specification need data fetched for them.
 *
 * Derived from the node catalog through `walkPanelNodes` rather than from a list
 * of type names kept here: "does this node need a query" is a fact the schema
 * owns, so a suite that restated it would be a second source for it.
 *
 * @param spec The specification about to be rendered.
 * @returns The number of query-backed nodes anywhere in its layout.
 */
function countQueryBackedNodes(spec: PanelSpec): number {
  let count = 0;

  walkPanelNodes(spec.layout, (node) => {
    if (catalogEntryFor(node.type).requiresQuery) {
      count += 1;
    }
  });

  return count;
}

/**
 * How many nodes a specification's layout holds in total, containers included.
 *
 * Walked rather than counted by hand, so the assertion about one wrapper per
 * node stays true of whatever layout a case builds.
 *
 * @param spec The specification about to be rendered.
 * @returns The number of nodes anywhere in its layout.
 */
function countNodes(spec: PanelSpec): number {
  let count = 0;

  walkPanelNodes(spec.layout, () => {
    count += 1;
  });

  return count;
}

/**
 * The query of the first query-backed node of a layout, in reading order.
 *
 * Read off the document with an `in` narrowing rather than by naming the node
 * types that carry a query: the catalogue is what classifies a node, and a
 * suite that listed the twelve query-backed types would be a second list of
 * them.
 *
 * @param spec The specification to read.
 * @returns That node's query, or `undefined` when the layout has none.
 */
function firstNodeQuery(spec: PanelSpec): DataQuery | undefined {
  let found: DataQuery | undefined;

  walkPanelNodes(spec.layout, (node) => {
    if (found === undefined && 'query' in node) {
      found = node.query;
    }
  });

  return found;
}

/**
 * Renders a specification and waits until every query-backed node has settled.
 *
 * The wait is what keeps a resolved promise's state update inside the test's own
 * `await`: without it a case would assert against a tree that is still loading,
 * and React would report the late update to the console, which the recursion
 * case reads. Every query-backed node in this suite is the one metric view, so
 * its settled form — the named view the node catalog labels — is what is waited
 * for, and the count is asserted so that a node which failed to render at all
 * fails here rather than three assertions later.
 *
 * @param spec The specification to draw.
 * @param options See {@link RenderPanelOptions}.
 * @returns The container and the stubs the render was given.
 */
async function renderPanel(
  spec: PanelSpec,
  options: RenderPanelOptions = {},
): Promise<RenderedPanel> {
  const { actions = makeActions(), provider = makeDataProvider(), theme } = options;

  const view = render(
    <PanelHost
      spec={spec}
      dataProvider={provider.provider}
      actions={actions.actions}
      theme={theme}
    />,
  );

  const expected = countQueryBackedNodes(spec);
  if (expected > 0) {
    const views = await screen.findAllByRole('list', { name: METRIC_VIEW_NAME });
    expect(views).toHaveLength(expected);
  }

  const rerender = (next: PanelSpec, nextActions: PanelActions = actions.actions): void => {
    view.rerender(
      <PanelHost
        spec={next}
        dataProvider={provider.provider}
        actions={nextActions}
        theme={theme}
      />,
    );
  };

  return { container: view.container, actions, provider, rerender };
}

/** How many times each counted view rendered during one gesture. */
interface RenderCounts {
  /** Renders of the metric view, which reads data and no actions. */
  readonly metricViews: number;

  /** Renders of every source chip — layout node and head alike — which read the actions. */
  readonly sourceLinks: number;
}

/**
 * How many times each counted view renders while `gesture` runs.
 *
 * Differences rather than absolutes, because the spies' counts accumulate
 * across the whole suite (see the module mocks above).
 *
 * @param gesture What the case does to the mounted panel.
 * @returns The renders the gesture caused, per view.
 */
function countRenders(gesture: () => void): RenderCounts {
  const metricViews = vi.mocked(MetricCards).mock.calls.length;
  const sourceLinks = vi.mocked(SourceLink).mock.calls.length;

  gesture();

  return {
    metricViews: vi.mocked(MetricCards).mock.calls.length - metricViews,
    sourceLinks: vi.mocked(SourceLink).mock.calls.length - sourceLinks,
  };
}

/** What {@link NextOffsetProbe} is asked to read. */
interface NextOffsetProbeProps {
  /** The query the probe hands the hook, unmodified. */
  readonly query: DataQuery;
}

/**
 * The smallest view over the query hook: it prints what the hook reports as the
 * next page's offset once the query settles, and the status until then.
 *
 * Rendered only by the paging-marker case, which is about the one value no
 * catalogued view prints directly.
 *
 * @param props See {@link NextOffsetProbeProps}.
 * @returns The printed value, in a live output element.
 */
function NextOffsetProbe(props: NextOffsetProbeProps): ReactElement {
  const { status, nextOffset } = useQuery(props.query);

  return (
    <output aria-label={NEXT_OFFSET_LABEL}>
      {status === 'success' ? String(nextOffset) : status}
    </output>
  );
}

/*
 * ---------------------------------------------------------------------------
 * DOM readers
 *
 * Each one fails loudly rather than answering `null`, so a case reads as the
 * property it is about instead of as a chain of optional access.
 * ---------------------------------------------------------------------------
 */

/** The observed-facts region of the head. */
function observedRegion(): HTMLElement {
  return screen.getByRole('region', { name: OBSERVED_REGION_NAME });
}

/** The likely-cause region of the head. */
function causesRegion(): HTMLElement {
  return screen.getByRole('region', { name: LIKELY_CAUSE_REGION_NAME });
}

/**
 * Every element carrying the theme attribute.
 *
 * A case asserts both the value and the count: the theme root is the only
 * element in a panel that selects a value set, and a second one would mean two
 * halves of a panel could render in different themes.
 *
 * @param container The render's container.
 * @returns The themed elements, in document order.
 */
function themedElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${PANEL_THEME_ATTRIBUTE}]`));
}

/**
 * The one themed element of a rendered panel.
 *
 * Asserts the count on the way past, because "exactly one" is as much of the
 * contract as the value: two theme roots would let two halves of a panel render
 * in different value sets.
 *
 * @param container The render's container.
 * @returns The theme root.
 */
function soleThemeRoot(container: HTMLElement): HTMLElement {
  const themed = themedElements(container);
  expect(themed).toHaveLength(1);

  const [root] = themed;
  if (root === undefined) {
    throw new Error('the panel rendered no theme root');
  }

  return root;
}

/**
 * The fallback notice, or `null` when the panel carries none.
 *
 * Found by its words — an accessible text query, which is the point of the
 * requirement — and then resolved to the live region that announces them, so
 * the case proves the statement is both readable and announced rather than
 * merely present in the markup.
 *
 * @returns The banner element, or `null` when no fallback text is on screen.
 */
function fallbackBanner(): HTMLElement | null {
  const message = screen.queryByText(FALLBACK_TEXT_PATTERN);
  if (message === null) {
    return null;
  }

  const banner = message.closest('[role="status"]');
  if (!(banner instanceof HTMLElement)) {
    throw new Error('the fallback message is not inside a live region');
  }

  return banner;
}

/**
 * The library's empty state inside the panel body, or `null` when the body drew
 * something else.
 *
 * Read by class, off the body it must sit in: the empty state is a passive
 * element with no role of its own, and what the case is about is *which region
 * of the panel* is empty.
 *
 * @param container The render's container.
 * @returns The empty-state element, or `null`.
 */
function bodyEmptyState(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('.dg-panel__body > .dg-empty-state');
}

/**
 * The sole argument of a spy that must have been called exactly once.
 *
 * @param spy The spy to read.
 * @param what What the spy stands for, for the failure message.
 * @returns The single recorded argument.
 */
function soleArgument<TArgument>(spy: Mock<(value: TArgument) => void>, what: string): TArgument {
  expect(spy).toHaveBeenCalledTimes(1);

  const [call] = spy.mock.calls;
  if (call === undefined) {
    throw new Error(`the ${what} handler recorded no call`);
  }

  return call[0];
}

/**
 * Activates the control with the given accessible name, optionally scoped to a
 * region of the panel.
 *
 * @param name The control's accessible name.
 * @param scope The element to search inside, or the whole screen when omitted.
 */
async function clickByName(name: string, scope?: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  const queries = scope === undefined ? screen : within(scope);

  await user.click(queries.getByRole('button', { name }));
}

/** The accessible name of the chip that opens a location. */
function chipName(location: SourceLocation): string {
  return `Open ${formatSourceLocation(location)}`;
}

/**
 * Records everything a render writes to `console.error`, silencing it.
 *
 * Returned as the recorded calls rather than as the spy: what a case wants to
 * assert is the *content* of the warnings, and the spy itself is restored by the
 * suite's `afterEach` either way.
 *
 * @returns The array the mock appends each call's arguments to.
 */
function captureConsoleErrors(): unknown[][] {
  const calls: unknown[][] = [];

  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    calls.push(args);
  });

  return calls;
}

/** One captured `console.error` call as a single searchable string. */
function messageOf(call: unknown[]): string {
  return call.map((part) => String(part)).join(' ');
}

// Explicit, as in every suite of this package: the runner's configuration is
// what registers automatic cleanup, and this is the suite's own guarantee.
// Restoring spies in the same place keeps a `console` spy from one case out of
// the next.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/*
 * ---------------------------------------------------------------------------
 * The theme contract (AAP 0.6.3, 0.6.4)
 * ---------------------------------------------------------------------------
 */

describe('PanelHost theme application', () => {
  it.each(PANEL_THEMES)(
    'writes the "%s" theme onto the panel root through the tokens\' own mapping',
    async (theme) => {
      const { container } = await renderPanel(makeSpec(), { theme });

      // Resolved through `panelThemeAttributeValue`, never against a literal:
      // the DOM spelling of a theme is the tokens module's statement, and the
      // kebab-case value of the high-contrast set is exactly the sort of
      // translation a copied string gets wrong.
      expect(soleThemeRoot(container).getAttribute(PANEL_THEME_ATTRIBUTE)).toBe(
        panelThemeAttributeValue(theme),
      );
    },
  );

  it('falls back to the product default theme when the host states none', async () => {
    const { container } = await renderPanel(makeSpec());

    expect(soleThemeRoot(container).getAttribute(PANEL_THEME_ATTRIBUTE)).toBe(
      panelThemeAttributeValue(DEFAULT_PANEL_THEME),
    );
  });

  it('draws the whole panel inside the theme root', async () => {
    const { container } = await renderPanel(makeSpec());
    const root = soleThemeRoot(container);

    // A value set that does not enclose the summary, the layout or the notice
    // would leave part of a panel rendering against the wrong tokens.
    expect(root.contains(observedRegion())).toBe(true);
    expect(root.contains(screen.getByRole('region', { name: SECTION_TITLE }))).toBe(true);
    expect(root.contains(screen.getByRole('heading', { name: PANEL_TITLE }))).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Observed facts against inferred causes (AAP 0.2.3, 0.8.4)
 * ---------------------------------------------------------------------------
 */

describe('PanelHost summary registers', () => {
  it('renders the observed facts and the likely causes as two separate regions', async () => {
    const spec = makeSpec();
    await renderPanel(spec);

    const observed = observedRegion();
    const causes = causesRegion();

    // Siblings, not one inside the other: the separation has to survive being
    // read by a screen reader that announces regions, not only being looked at.
    expect(observed).not.toBe(causes);
    expect(observed.contains(causes)).toBe(false);
    expect(causes.contains(observed)).toBe(false);

    for (const fact of spec.summary.observed) {
      // `getByText` is itself the assertion — it throws when the statement is
      // not inside the region it was scoped to.
      within(observed).getByText(fact.statement);
      expect(within(causes).queryByText(fact.statement)).toBeNull();
    }

    for (const hypothesis of spec.summary.likelyCauses) {
      within(causes).getByText(hypothesis.statement);
      expect(within(observed).queryByText(hypothesis.statement)).toBeNull();

      // The confidence is rendered as its word, so the ranking is never carried
      // by colour alone.
      within(causes).getByText(hypothesis.confidence);
      expect(within(observed).queryByText(hypothesis.confidence)).toBeNull();
    }
  });

  it('never renders the headline inside the observed-facts register', async () => {
    await renderPanel(makeSpec());

    // Present: the prose is not dropped, it is placed. The three assertions
    // below are about *where*.
    const headline = screen.getByText(SUMMARY_HEADLINE);

    expect(observedRegion().contains(headline)).toBe(false);
    expect(causesRegion().contains(headline)).toBe(false);
    expect(within(observedRegion()).queryByText(SUMMARY_HEADLINE)).toBeNull();

    // And not marked up as one either: a fact is a list item of a register's
    // list and carries its citations, so prose that ended up in either
    // structure would read as evidence whatever region it sat in.
    expect(headline.closest('.dg-summary-header__fact')).toBeNull();
    expect(headline.closest('ul')).toBeNull();
    expect(headline.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders no region for a register the summary leaves empty', async () => {
    await renderPanel(makeSpec({ summary: makeSummary({ likelyCauses: [] }) }));

    // A labelled region with nothing in it announces a heading that introduces
    // nothing; the facts it does have must still render.
    observedRegion();
    expect(screen.queryByRole('region', { name: LIKELY_CAUSE_REGION_NAME })).toBeNull();
    expect(screen.queryByText(LIKELY_CAUSE_STATEMENT)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * What a gesture reports to the host (AAP 0.4.2)
 * ---------------------------------------------------------------------------
 */

describe('PanelHost interaction reporting', () => {
  it('reports the whole citation when an evidence chip is activated', async () => {
    const spec = makeSpec();
    const { actions } = await renderPanel(spec);

    const [firstFact] = spec.summary.observed;
    if (firstFact === undefined) {
      throw new Error('the specification under test carries no observed fact');
    }

    const [citation] = firstFact.evidence;
    if (citation === undefined) {
      throw new Error('the first observed fact carries no citation');
    }

    await clickByName(FIRST_CITATION_LABEL, observedRegion());

    const reported = soleArgument(actions.onSelectEvent, 'event selection');

    // The payload, not the call count: the optional trace and span coordinates
    // are what let a host scope a trace-filtered view without a lookup, so a
    // reference that arrived stripped of them would still pass a count.
    expect(reported).toEqual(citation);
    expect(Object.keys(reported).sort()).toEqual(Object.keys(citation).sort());
    expect(reported.eventId).toBe(FIRST_EVENT_ID);
    expect(reported.traceId).toBe(CITATION_TRACE_ID);
    expect(reported.spanId).toBe(CITATION_SPAN_ID);

    // Selecting evidence is not navigation.
    expect(actions.onOpenSource).not.toHaveBeenCalled();
  });

  it("forwards a source-link node's location unmodified, field for field", async () => {
    const { actions } = await renderPanel(makeSpec());

    await clickByName(chipName(NODE_LOCATION));

    const reported = soleArgument(actions.onOpenSource, 'open source');

    // Hop 1 of the click-to-source chain. Every field is named individually as
    // well as compared as a whole, because each one is a way the chain has gone
    // wrong before: a dropped `symbol` loses the editor's selection target, a
    // dropped `endLine` collapses a range to a point, and a rewritten
    // `resolvedBy` or `confidence` misreports how much the location is worth.
    expect(reported).toEqual(NODE_LOCATION);
    expect(Object.keys(reported).sort()).toEqual(Object.keys(NODE_LOCATION).sort());
    expect(reported.file).toBe(NODE_LOCATION.file);
    expect(reported.line).toBe(NODE_LOCATION.line);
    expect(reported.column).toBe(NODE_LOCATION.column);
    expect(reported.symbol).toBe(NODE_LOCATION.symbol);
    expect(reported.endLine).toBe(NODE_LOCATION.endLine);
    expect(reported.resolvedBy).toBe(NODE_LOCATION.resolvedBy);
    expect(reported.confidence).toBe(NODE_LOCATION.confidence);

    expect(actions.onSelectEvent).not.toHaveBeenCalled();
  });

  it("forwards a likely cause's suggested location unmodified, field for field", async () => {
    const spec = makeSpec();
    const { actions } = await renderPanel(spec);

    const [hypothesis] = spec.summary.likelyCauses;
    const suggested = hypothesis?.suggestedLocation;
    if (suggested === undefined) {
      throw new Error('the specification under test suggests no location');
    }

    // Scoped to the causes region: the chip under test is the one hanging off
    // the hypothesis, never the standalone node's chip elsewhere in the panel.
    await clickByName(chipName(suggested), causesRegion());

    const reported = soleArgument(actions.onOpenSource, 'open source');

    expect(reported).toEqual(suggested);
    expect(reported).toEqual(CAUSE_LOCATION);
    expect(Object.keys(reported).sort()).toEqual(Object.keys(CAUSE_LOCATION).sort());
    expect(reported.symbol).toBe(CAUSE_LOCATION.symbol);
    expect(reported.endLine).toBe(CAUSE_LOCATION.endLine);
    expect(reported.resolvedBy).toBe(CAUSE_LOCATION.resolvedBy);
    expect(reported.confidence).toBe(CAUSE_LOCATION.confidence);

    // The two chips of one panel point at two different places, and the one
    // that was activated is the one that was reported.
    expect(reported.file).not.toBe(NODE_LOCATION.file);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The fallback notice (AAP 0.5.5, 0.5.3)
 * ---------------------------------------------------------------------------
 */

describe('PanelHost fallback notice', () => {
  it('announces a fallback panel in words, above the panel it announces', async () => {
    await renderPanel(makeSpec({ meta: { fallback: true } }));

    const banner = fallbackBanner();
    if (banner === null) {
      throw new Error('a panel carrying meta.fallback rendered no fallback notice');
    }

    // In the accessibility tree, not merely on the surface: the notice was
    // found by its words, and it is announced politely rather than left to a
    // colour or a class to carry (AAP 0.6.4 forbids either as the sole signal).
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');

    // First in the panel column, so the provenance of what follows is read
    // before the summary makes any claim.
    expect(banner.parentElement?.firstElementChild).toBe(banner);
  });

  it('still renders the summary and every layout node beneath the notice', async () => {
    const spec = makeSpec({ meta: { fallback: true } });
    const { container } = await renderPanel(spec);

    // The banner does not replace the panel: a deterministic summary of a real
    // capture is worth reading, which is the whole difference between honest
    // degradation and an error in place of an answer.
    expect(fallbackBanner()).not.toBeNull();
    observedRegion();
    causesRegion();
    screen.getByRole('region', { name: SECTION_TITLE });
    screen.getByRole('region', { name: SPLIT_TITLE });
    screen.getByRole('region', { name: STACK_TITLE });
    screen.getByRole('button', { name: chipName(NODE_LOCATION) });
    expect(screen.getAllByRole('list', { name: METRIC_VIEW_NAME })).toHaveLength(1);
    expect(container.querySelectorAll('.dg-panel__node')).toHaveLength(countNodes(spec));
  });

  it('renders no notice for an ordinary generated panel', async () => {
    await renderPanel(makeSpec());

    // The metadata is absent, which is how a generated panel actually arrives:
    // nothing fills the flag in on parse.
    expect(fallbackBanner()).toBeNull();
    expect(screen.queryByText(FALLBACK_TEXT_PATTERN)).toBeNull();
  });

  it('renders no notice when the flag is present and false', async () => {
    await renderPanel(makeSpec({ meta: { fallback: false } }));

    // The host reads the flag as `=== true`, so a stored document that spells
    // the ordinary case out explicitly is still an ordinary panel.
    expect(fallbackBanner()).toBeNull();
    expect(screen.queryByText(FALLBACK_TEXT_PATTERN)).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The layout: recursion, the ambient contracts, and an empty document
 * ---------------------------------------------------------------------------
 */

describe('PanelHost layout rendering', () => {
  it('renders every level of a nested layout exactly once, with stable keys', async () => {
    const consoleErrors = captureConsoleErrors();
    const spec = makeSpec();
    const { container } = await renderPanel(spec);

    // One region per labelled container, and exactly one of each: a level drawn
    // twice is as wrong as a level missing, and both are invisible to a query
    // that only asks whether the innermost leaf arrived.
    expect(screen.getAllByRole('region', { name: SECTION_TITLE })).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: SPLIT_TITLE })).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: STACK_TITLE })).toHaveLength(1);

    const section = screen.getByRole('region', { name: SECTION_TITLE });
    const split = screen.getByRole('region', { name: SPLIT_TITLE });
    const stack = screen.getByRole('region', { name: STACK_TITLE });

    // Nested as the document nests them, rather than flattened into siblings.
    expect(section.contains(split)).toBe(true);
    expect(split.contains(stack)).toBe(true);

    // Each leaf once, in the container the document put it in.
    expect(within(stack).getAllByRole('list', { name: METRIC_VIEW_NAME })).toHaveLength(1);
    expect(within(split).getAllByRole('button', { name: chipName(NODE_LOCATION) })).toHaveLength(1);
    expect(within(stack).queryByRole('button', { name: chipName(NODE_LOCATION) })).toBeNull();

    // One wrapper per node of the document, and no node rendered as a failure.
    expect(container.querySelectorAll('.dg-panel__node')).toHaveLength(countNodes(spec));
    expect(container.querySelectorAll('.dg-panel__node-error')).toHaveLength(0);

    // A missing key is not a failed render: the panel looks correct and then
    // loses a node's state the next time its parent renders, so the warning is
    // the only signal there is.
    const keyWarnings = consoleErrors
      .map(messageOf)
      .filter((message) => KEY_WARNING_PATTERN.test(message));
    expect(keyWarnings).toEqual([]);

    // Nothing else was reported either. Every query-backed node settled inside
    // `renderPanel`'s await, so a late state update — the other thing React
    // reports here — would show up as a call too.
    expect(consoleErrors.map(messageOf)).toEqual([]);
  });

  it('provides the data contract to a node three containers deep', async () => {
    const spec = makeSpec();
    const { provider } = await renderPanel(spec);

    // The provider is ambient, so a leaf reaches it without any intervening
    // layer threading it through — and the query it asks with is the one the
    // document wrote, neither rebuilt nor defaulted on the way.
    expect(provider.resolve).toHaveBeenCalledTimes(1);

    const [call] = provider.resolve.mock.calls;
    if (call === undefined) {
      throw new Error('the data provider recorded no query');
    }

    expect(call[0]).toEqual(firstNodeQuery(spec));
  });

  it('renders the library empty state, and no error, for a panel with no views', async () => {
    const spec = makeSpec({ layout: [] });
    const { container } = await renderPanel(spec);

    // A validated panel may legitimately carry a summary and nothing else, so
    // this is a state rather than a gap — and deliberately neither the error
    // state, which is what failed *validation* looks like, nor the fallback
    // notice, which is what a rejected generation looks like.
    screen.getByRole('heading', { name: PANEL_TITLE });
    observedRegion();
    causesRegion();

    const empty = bodyEmptyState(container);
    if (empty === null) {
      throw new Error('a panel with an empty layout rendered no empty state');
    }

    expect((empty.textContent ?? '').trim()).not.toBe('');
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.querySelectorAll('.dg-panel__node')).toHaveLength(0);
    expect(fallbackBanner()).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * The query lifecycle, through the host (AAP 0.6.2, 0.5.5)
 * ---------------------------------------------------------------------------
 */

describe('PanelHost query lifecycle', () => {
  it('draws the loading state until the provider answers, then the resolved view', async () => {
    const spec = makeSpec();
    const provider = makeControllableProvider();

    render(
      <PanelHost spec={spec} dataProvider={provider.provider} actions={makeActions().actions} />,
    );

    const stack = screen.getByRole('region', { name: STACK_TITLE });

    // Asked once, with the document's own query, and not answered yet.
    expect(provider.resolve).toHaveBeenCalledTimes(1);
    const request = provider.takeNext();
    expect(request.query).toEqual(firstNodeQuery(spec));

    // Loading, announced as such, and nothing drawn in the view's place: no
    // resolved view, and no error for a request that has not failed.
    const loading = within(stack).getByRole('status');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(within(stack).queryByRole('list', { name: METRIC_VIEW_NAME })).toBeNull();
    expect(within(stack).queryByRole('alert')).toBeNull();

    request.answer(metricsResponse());

    // The answer replaces the loading state with the view it describes.
    await within(stack).findByRole('list', { name: METRIC_VIEW_NAME });
    expect(within(stack).queryByRole('status')).toBeNull();
    expect(within(stack).queryByRole('alert')).toBeNull();
    expect(provider.resolve).toHaveBeenCalledTimes(1);
  });

  it('maps a provider rejection to the error state, and retries the very same query', async () => {
    const spec = makeSpec();
    const provider = makeControllableProvider();

    render(
      <PanelHost spec={spec} dataProvider={provider.provider} actions={makeActions().actions} />,
    );

    const stack = screen.getByRole('region', { name: STACK_TITLE });
    const first = provider.takeNext();

    first.fail(
      new DebuggenError(PROVIDER_FAILURE_CODE, 'The transport closed before the page arrived.', {
        hint: 'Reconnect, then retry.',
      }),
    );

    // The rejection is an error state carrying the failure's own code — never
    // a view drawn over no data, and never still loading (AAP 0.5.5).
    const alert = await within(stack).findByRole('alert');
    expect(alert.textContent).toContain(PROVIDER_FAILURE_CODE);
    expect(within(stack).queryByRole('list', { name: METRIC_VIEW_NAME })).toBeNull();
    expect(within(stack).queryByRole('status')).toBeNull();

    const user = userEvent.setup();
    await user.click(within(alert).getByRole('button', { name: RETRY_PATTERN }));

    // The retry asks again — the same query, for the same session — and the
    // superseded attempt's request is aborted rather than left to land late.
    expect(provider.resolve).toHaveBeenCalledTimes(2);
    const second = provider.takeNext();
    expect(second.query).toEqual(first.query);
    expect(second.query).toEqual(firstNodeQuery(spec));
    expect(second.context.sessionId).toBe(first.context.sessionId);
    expect(first.context.signal?.aborted).toBe(true);
    expect(second.context.signal?.aborted).toBe(false);

    // While it is in flight the view is loading again, not still in error.
    expect(within(stack).getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(within(stack).queryByRole('alert')).toBeNull();

    second.answer(metricsResponse());

    await within(stack).findByRole('list', { name: METRIC_VIEW_NAME });
    expect(within(stack).queryByRole('alert')).toBeNull();
    expect(provider.resolve).toHaveBeenCalledTimes(2);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Session routing: every query names its panel's session (AAP 0.4.2)
 * ---------------------------------------------------------------------------
 */

describe('PanelHost session routing', () => {
  it('addresses every query to the session its specification names', async () => {
    const spec = makeSpec();
    const { provider } = await renderPanel(spec);

    expect(provider.resolve).toHaveBeenCalledTimes(1);

    // The session travels beside the query rather than inside it: the query is
    // the document's own, and the session is what the route is addressed by.
    const context = resolverContextAt(provider.resolve, 0);
    expect(context.sessionId).toBe(spec.sessionId);
    expect(context.sessionId).toBe(SESSION_ID);
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(resolverQueryAt(provider.resolve, 0)).toEqual(firstNodeQuery(spec));
  });

  it('asks again, under the new session, when a panel moves to another session', async () => {
    const spec = makeSpec();
    const { provider, rerender } = await renderPanel(spec);

    // The same node objects, so the only thing that changed is the session:
    // an answer for the old session must not stand in for the new one.
    rerender(makeSpec({ sessionId: OTHER_SESSION_ID, summary: spec.summary, layout: spec.layout }));

    await waitFor(() => {
      expect(provider.resolve).toHaveBeenCalledTimes(2);
    });
    await screen.findByRole('list', { name: METRIC_VIEW_NAME });

    expect(resolverContextAt(provider.resolve, 1).sessionId).toBe(OTHER_SESSION_ID);
    expect(resolverQueryAt(provider.resolve, 1)).toEqual(resolverQueryAt(provider.resolve, 0));
  });

  it('draws an error, and asks the provider nothing, for a document naming no session', async () => {
    const provider = makeDataProvider();

    render(
      <PanelHost
        spec={makeSpec({ sessionId: BLANK_SESSION_ID })}
        dataProvider={provider.provider}
        actions={makeActions().actions}
      />,
    );

    const stack = screen.getByRole('region', { name: STACK_TITLE });

    // A request the service cannot route is not made at all, and the view says
    // why instead of loading forever.
    const alert = await within(stack).findByRole('alert');
    expect(alert.textContent).toContain(MISSING_SESSION_CODE);
    expect(provider.resolve).not.toHaveBeenCalled();
    expect(within(stack).queryByRole('list', { name: METRIC_VIEW_NAME })).toBeNull();
  });
});

describe('the session-addressed data seam the host relies on', () => {
  it('hands the resolver the session it was asked for, beside the abort signal', async () => {
    const resolve = vi.fn<DataQueryResolver>(() => Promise.resolve(metricsResponse()));
    const provider = createDataProvider(resolve);
    const controller = new AbortController();

    const response = await provider.query(
      SESSION_ID,
      { source: 'metrics' },
      { signal: controller.signal },
    );

    expect(response.source).toBe('metrics');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolverQueryAt(resolve, 0)).toEqual({ source: 'metrics' });

    const context = resolverContextAt(resolve, 0);
    expect(context.sessionId).toBe(SESSION_ID);
    expect(context.signal).toBe(controller.signal);
  });

  it.each(['', BLANK_SESSION_ID])(
    'refuses a query addressed to %j before its resolver runs',
    async (sessionId) => {
      const resolve = vi.fn<DataQueryResolver>(() => Promise.resolve(metricsResponse()));
      const provider = createDataProvider(resolve);

      const refused = provider.query(sessionId, { source: 'metrics' });

      await expect(refused).rejects.toBeInstanceOf(DebuggenError);
      await expect(refused).rejects.toMatchObject({ code: UNADDRESSED_QUERY_CODE });
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it.each([
    { wire: null, total: 0, printed: 'undefined' },
    { wire: 200, total: 400, printed: '200' },
  ])(
    'hands a view the next page offset $printed when the wire reports $wire',
    async ({ wire, total, printed }) => {
      // `null` is the wire's "this is the last page"; a view reads exactly one
      // end-of-data value, `undefined`, so the hook folds one into the other
      // and passes every real offset through unchanged.
      const resolve = vi.fn<DataQueryResolver>(() =>
        Promise.resolve<DataQueryResponse>({ source: 'events', data: [], total, nextOffset: wire }),
      );

      render(
        <DataProviderContext.Provider value={createDataProvider(resolve)}>
          <PanelSessionContext.Provider value={SESSION_ID}>
            <NextOffsetProbe query={{ source: 'events' }} />
          </PanelSessionContext.Provider>
        </DataProviderContext.Provider>,
      );

      await waitFor(() => {
        expect(screen.getByLabelText(NEXT_OFFSET_LABEL).textContent).toBe(printed);
      });
      expect(resolverContextAt(resolve, 0).sessionId).toBe(SESSION_ID);
    },
  );
});

/*
 * ---------------------------------------------------------------------------
 * Re-rendering and keys: unrelated host changes leave the views alone
 * ---------------------------------------------------------------------------
 */

describe('PanelHost re-rendering', () => {
  it('re-renders no view when a surface rebuilds its actions from the same callbacks', async () => {
    const spec = makeSpec();
    const { actions, provider, rerender } = await renderPanel(spec);

    // A fresh object literal, as a surface writes one inline in its JSX.
    const renders = countRenders(() => {
      rerender(spec, { ...actions.actions });
    });

    expect(renders).toEqual({ metricViews: 0, sourceLinks: 0 });
    expect(provider.resolve).toHaveBeenCalledTimes(1);
  });

  it('re-renders the views that read the actions when a callback did change', async () => {
    const spec = makeSpec();
    const { actions, provider, rerender } = await renderPanel(spec);
    const onExpand = vi.fn<(nodeId: string, itemId: string, expanded: boolean) => void>();

    // The control case for the one above: a changed handler is a real change,
    // and the views that could call it must see it.
    const renders = countRenders(() => {
      rerender(spec, { ...actions.actions, onExpand });
    });

    expect(renders.sourceLinks).toBeGreaterThan(0);

    // The metric view reads no actions, and its layout did not change.
    expect(renders.metricViews).toBe(0);
    expect(provider.resolve).toHaveBeenCalledTimes(1);
  });

  it('re-renders no view when a re-delivered document keeps its layout nodes', async () => {
    const spec = makeSpec();
    const { provider, rerender } = await renderPanel(spec);
    const retitled = 'A retitled panel under test';

    // A new document object and a new layout array, holding the very same node
    // objects: what a store hands back when only the head changed.
    const renders = countRenders(() => {
      rerender(makeSpec({ title: retitled, summary: spec.summary, layout: spec.layout }));
    });

    screen.getByRole('heading', { name: retitled });
    expect(renders.metricViews).toBe(0);
    expect(provider.resolve).toHaveBeenCalledTimes(1);
  });

  it('moves a mounted view, rather than remounting it, when siblings are reordered', async () => {
    const [metrics, link] = makeSiblingLayout();
    const spec = makeSpec({ layout: [metrics, link] });
    const { provider, rerender } = await renderPanel(spec);

    const viewBefore = screen.getByRole('list', { name: METRIC_VIEW_NAME });
    const pathBefore = viewBefore.closest('[data-node-path]')?.getAttribute('data-node-path');

    rerender(makeSpec({ summary: spec.summary, layout: [link, metrics] }));

    // The same element, still in the document: keyed by node id, the view
    // moved with its node. A position key would have handed its slot to the
    // source link and mounted a fresh view — and a fresh query — in the other.
    const viewAfter = screen.getByRole('list', { name: METRIC_VIEW_NAME });
    expect(viewAfter).toBe(viewBefore);
    expect(viewAfter.isConnected).toBe(true);
    expect(provider.resolve).toHaveBeenCalledTimes(1);

    // The document order did change, and the diagnostic path followed it.
    const chip = screen.getByRole('button', { name: chipName(NODE_LOCATION) });
    expect(chip.compareDocumentPosition(viewAfter) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const pathAfter = viewAfter.closest('[data-node-path]')?.getAttribute('data-node-path');
    expect(pathBefore).toBeDefined();
    expect(pathAfter).toBeDefined();
    expect(pathAfter).not.toBe(pathBefore);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The document outline, and inert citations (AAP 0.6.4)
 * ---------------------------------------------------------------------------
 */

/**
 * The level of every heading on screen, in document order.
 *
 * Read off the element's tag, which is what the heading primitive chooses by
 * level, so a level that is stated but not rendered cannot pass.
 *
 * @returns One level per heading.
 */
function headingLevels(): number[] {
  return screen.getAllByRole('heading').map((heading) => Number(heading.tagName.slice(1)));
}

describe('PanelHost document outline', () => {
  it('draws the title at level 2 and steps one level per titled container', async () => {
    await renderPanel(makeSpec());

    screen.getByRole('heading', { level: 2, name: PANEL_TITLE });
    screen.getByRole('heading', { level: 3, name: OBSERVED_REGION_NAME });
    screen.getByRole('heading', { level: 3, name: LIKELY_CAUSE_REGION_NAME });
    screen.getByRole('heading', { level: 3, name: SECTION_TITLE });
    screen.getByRole('heading', { level: 4, name: SPLIT_TITLE });
    screen.getByRole('heading', { level: 5, name: STACK_TITLE });

    // And, whatever the layout, the outline starts at the title and never
    // skips a level on the way down.
    const levels = headingLevels();
    expect(levels[0]).toBe(2);
    levels.forEach((level, index) => {
      const previous = levels[index - 1];
      if (previous !== undefined) {
        expect(level).toBeLessThanOrEqual(previous + 1);
      }
    });
  });

  it('adds no level under a container that draws no heading', async () => {
    await renderPanel(makeSpec({ layout: makeUntitledMiddleLayout() }));

    screen.getByRole('heading', { level: 3, name: OUTER_TITLE });
    screen.getByRole('heading', { level: 4, name: INNER_TITLE });
  });
});

describe('SummaryHeader citations without a selection handler', () => {
  it('renders every citation as inert text, never as a control that does nothing', async () => {
    const onOpenSource = vi.fn<(location: SourceLocation) => void>();

    render(
      <SummaryHeader title={PANEL_TITLE} summary={makeSummary()} onOpenSource={onOpenSource} />,
    );

    const citations: readonly (readonly [string, string, HTMLElement])[] = [
      [FIRST_CITATION_LABEL, FIRST_EVENT_ID, observedRegion()],
      [SECOND_CITATION_LABEL, SECOND_EVENT_ID, observedRegion()],
      [CAUSE_CITATION_LABEL, CAUSE_EVENT_ID, causesRegion()],
    ];

    for (const [label, eventId, region] of citations) {
      // Still there, still in its register, still naming its event…
      const citation = within(region).getByText(label);
      expect(citation.getAttribute('data-event-id')).toBe(eventId);

      // …but not a control: nothing to press, nothing to focus.
      expect(screen.queryByRole('button', { name: label })).toBeNull();
      expect(citation.closest('button')).toBeNull();
      expect(citation.hasAttribute('tabindex')).toBe(false);
    }

    // The one control left is the source chip, which has a handler to reach.
    const chip = screen.getByRole('button', { name: chipName(CAUSE_LOCATION) });
    expect(screen.getAllByRole('button')).toEqual([chip]);

    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(chip);
  });

  it('renders every citation as a selectable chip once a handler is supplied', async () => {
    const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();

    render(
      <SummaryHeader title={PANEL_TITLE} summary={makeSummary()} onSelectEvent={onSelectEvent} />,
    );

    for (const label of [FIRST_CITATION_LABEL, SECOND_CITATION_LABEL, CAUSE_CITATION_LABEL]) {
      screen.getByRole('button', { name: label });
    }

    await clickByName(CAUSE_CITATION_LABEL, causesRegion());
    expect(soleArgument(onSelectEvent, 'event selection').eventId).toBe(CAUSE_EVENT_ID);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The document is read, never written — and never re-validated
 * ---------------------------------------------------------------------------
 */

describe('PanelHost treatment of the specification', () => {
  it('does not write to the specification it renders', async () => {
    const spec = makeSpec({ meta: { fallback: true } });

    // A structural clone is a complete copy for this document: a specification
    // is JSON — strings, numbers, booleans, arrays and plain objects — with no
    // function, no class instance and no shared mutable handle anywhere in it.
    const pristine = structuredClone(spec);

    const { actions } = await renderPanel(spec);

    // After the render: no sort, no default filled in, no id derived into it,
    // no `meta` normalised. The same object is held by the store, carried by
    // the transport and rendered by the other surface at the same time.
    expect(spec).toEqual(pristine);

    await clickByName(FIRST_CITATION_LABEL, observedRegion());
    await clickByName(chipName(NODE_LOCATION));

    expect(actions.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(actions.onOpenSource).toHaveBeenCalledTimes(1);

    // And after the interactions, which is the half a clone taken before the
    // render would otherwise miss: a handler that recorded a selection onto the
    // document it was rendered from would pass the assertion above.
    expect(spec).toEqual(pristine);

    // Nothing a panel did not offer was reported either.
    expect(actions.onExpand).not.toHaveBeenCalled();
    expect(actions.onFilterChange).not.toHaveBeenCalled();
  });

  it('renders a document handed to it without any validation step', async () => {
    // The mechanical half of this guarantee is the import boundary: this suite
    // imports no parser, no validator and no normaliser, so every document it
    // renders — including this one — reached the component exactly as
    // `makeSpec` built it. Validation belongs to the coordination service,
    // which is the only side that can also check a panel against its capture;
    // a second, weaker check inside the renderer would be a second opinion
    // about what a valid document is.
    const spec = makeSpec();
    const { container } = await renderPanel(spec);

    screen.getByRole('heading', { name: PANEL_TITLE });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.querySelectorAll('.dg-panel__node-error')).toHaveLength(0);
    expect(container.querySelectorAll('.dg-panel__node')).toHaveLength(countNodes(spec));
  });
});
