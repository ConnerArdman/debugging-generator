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
 *     successful analysis.
 *   - **Observed evidence never blurs into inferred cause.** The two registers
 *     render as two separately labelled regions, neither inside the other, and
 *     the summary's `headline` — non-evidentiary prose, which "can never become
 *     a Fact" — appears in the panel but never inside the observed-facts region.
 *   - **A location travels unmodified.** Activating a `sourceLink` node's chip,
 *     and separately a likely cause's suggested-location chip, reports the very
 *     location the document carried: every field, including `symbol`,
 *     `endLine`, `resolvedBy` and `confidence`. This is hop 1 of the
 *     click-to-source chain, and the hops after it can only be as accurate as
 *     what leaves here.
 *   - **The document is read, never written.** The specification is held by the
 *     store, carried by the transport and rendered by two surfaces at once, so a
 *     convenience sort or a filled-in default here would change what a developer
 *     sees somewhere else. The no-mutation case clones the document before the
 *     render and compares after a render *and* after an interaction.
 *
 * Alongside those, the theme case pins the design system's own contract — the
 * theme attribute is applied for every `PanelTheme`, resolved through the
 * tokens' helper rather than through a literal — the recursion case proves a
 * nested layout is rendered level by level with stable keys, and the
 * empty-layout case pins the distinction between "this panel
 * specifies no views" (a state) and "this panel failed" (an error), which the
 * fallback case pins from the other side.
 *
 * Seven host contracts that are not visible in a single settled render have
 * their own cases, because each is lost silently rather than loudly:
 *
 *   - **Both forms of the action contract are served.** The suite's surface
 *     supplies the host form a real surface implements — `selectEvent` and
 *     `openSource` — and an evidence chip reports the citation's `eventId`
 *     with exactly the coordinates it recorded, while every source chip hands
 *     `openSource` the document's own location object. A surface that supplies
 *     the view form (`onSelectEvent`/`onOpenSource`) is served identically
 *     through the compatibility adapter.
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
 *     (`POST /sessions/:id/panel-data`). The two seam rules the host
 *     relies on — the provider refuses a blank session before its resolver
 *     runs, and the query hook hands a view the wire's `null` "last page"
 *     marker as the one end-of-data value, `undefined` — are pinned here too,
 *     because the host tier's two suites are this one and the registry's.
 *   - **No view outlives its session or its panel.** A document for another
 *     session, another panel or another generation — even one carrying the very
 *     same node objects — replaces every mounted view with a fresh one that asks
 *     for its first page under the new session, and while that page is pending
 *     or has failed, nothing the previous session answered is on screen. The
 *     same panel re-delivered keeps every view mounted.
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
 *     exactly one level deeper; an untitled container adds no level. Every view
 *     of captured evidence is a named region in that outline: an untitled one is
 *     headed by its node type's catalogue label at the level it was given, while
 *     an untitled source link and an untitled container draw no heading at all.
 *     Without a selection handler, the head's citations are inert text rather
 *     than focusable controls that do nothing.
 *
 * The last block pins the failure contract every query-backed node renders
 * through, because the host tier is where its three halves meet: the query
 * hook's faithful error codes and one-alert-per-burst announcement policy, the
 * pure helpers that compose an error state's props (one query format, a fixed
 * lead followed only by an authored, presentable cause, allowlisted details,
 * integration remedies behind the technical details rather than on the hint
 * line), and the primitive that draws them — with the focus key on its retry
 * control and the single-ellipsis convention of the loading label beside it.
 * Hostile rejections — a private path, a statement, a credential, a salvaged
 * error-shaped object — are driven through both the hook and the helpers, and
 * none of their text may reach the screen.
 *
 * The final block pins the other half of that focus key: the node frame
 * `NodeRenderer` draws around every node keeps keyboard focus inside the node
 * while a retry remounts its view. A retry that fails again lands on the new
 * Retry, one that succeeds leaves focus on the node's heading (for an untitled
 * view, the heading its catalogue label draws, never its container's) with a
 * `tabindex` borrowed only while it is focused, focus stays in the node while
 * the retry is in flight, and nothing that settles later pulls back focus the
 * reader moved elsewhere. The unrenderable-node failure names its block for
 * what it holds — the node's definition, not a query.
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
 *   - **Generic fixture vocabulary only**, because the renderer holds no
 *     behaviour keyed to any application's names. Every title, statement,
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
import type { TelemetryEvent } from '@debuggen/telemetry';
import { cleanup, render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { MetricCards } from '../components/MetricCards';
import { SourceLink } from '../components/SourceLink';
import { SummaryHeader } from '../layout/SummaryHeader';
import {
  ERROR_STATE_RETRY_FOCUS_KEY,
  ErrorState,
  FOCUS_KEY_ATTRIBUTE,
} from '../primitives/ErrorState';
import { LoadingState } from '../primitives/LoadingState';
import {
  DEFAULT_PANEL_THEME,
  PANEL_THEMES,
  PANEL_THEME_ATTRIBUTE,
  panelThemeAttributeValue,
} from '../tokens/theme';
import type { PanelTheme } from '../tokens/theme';
import {
  DATA_QUERY_DEFAULT_LIMIT,
  DATA_QUERY_MAX_LIMIT,
  DataProviderContext,
  PanelSessionContext,
  checkDataQueryResponse,
  createDataProvider,
  createPanelDataProvider,
  mapPanelDataResult,
} from './DataProvider';
import type {
  DataProvider,
  DataQueryResolver,
  DataQueryResolverContext,
  DataQueryResponse,
  DataResultFor,
  PanelDataPage,
  PanelDataResolver,
  PanelDataResult,
} from './DataProvider';
import { PanelHost } from './PanelHost';
import {
  PanelSelectionContext,
  isPanelHostActions,
  matchesPanelSelection,
  toPanelHostActions,
  toPanelViewActions,
  usePanelSelection,
  useSelectedEventId,
  useViewSelection,
} from './PanelActions';
import type {
  PanelActions,
  PanelEventCoordinates,
  PanelEventRef,
  PanelHostActions,
  PanelSelection,
  PanelViewActions,
} from './PanelActions';
import {
  PAGE_FAILURE_TITLE,
  QUERY_FAILURE_TITLE,
  UNSUPPORTED_QUERY_TITLE,
  formatDataQuery,
  queryFailureProps,
  unsupportedQueryProps,
  useQuery,
} from './useQuery';

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

/*
 * The selection every source chip read on its latest render, oldest first.
 *
 * The source chip is the one counted view that sits both in the layout and in
 * the head, so its wrapper is also where the suite observes the panel's shared
 * selection from inside the host: each render records what
 * `usePanelSelection()` returned, and the selection cases read the last entry.
 * Hoisted with the mock that writes it, as a module mock's state must be.
 */
const selectionProbe = vi.hoisted(() => ({ seen: [] as unknown[] }));

vi.mock(import('../components/SourceLink'), async (importOriginal) => {
  const actual = await importOriginal();
  const { usePanelSelection: readSelection } = await import('./PanelActions');

  return {
    ...actual,
    SourceLink: vi.fn((props: Parameters<typeof actual.SourceLink>[0]) => {
      selectionProbe.seen.push(readSelection());
      return actual.SourceLink(props);
    }),
  };
});

/*
 * ---------------------------------------------------------------------------
 * The synthetic vocabulary
 *
 * Every string a case queries by is declared once here, so that an assertion
 * names the same value the builder wrote. Nothing below is read out of an
 * inspected project, and nothing names an application: these are placeholders
 * chosen to be unmistakably placeholders.
 * ---------------------------------------------------------------------------
 */

/** The panel's own id. A single token, which is all the schema asks of an id. */
const PANEL_ID = 'panel-under-test';

/**
 * A second panel of the same session, for the isolation cases that swap one
 * panel for another with an identical layout.
 */
const OTHER_PANEL_ID = 'panel-under-test-other';

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
 * The accessible name of the observed region, as the renderer contract in
 * `docs/ARCHITECTURE.md` names it.
 *
 * Restated here rather than imported because `../layout/SummaryHeader` keeps its
 * two captions private, which is correct — they are its copy, not a shared
 * vocabulary. Stating them in the suite is therefore also a guard on the
 * wording: renaming either region breaks this file, which is where a reader
 * would want to be told.
 */
const OBSERVED_REGION_NAME = 'Observed';

/** The accessible name of the likely-cause region, as the same renderer contract names it. */
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

  /** The observed facts; an empty array renders the region's "no facts" sentence. */
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

/** The host form's selection callback, as a spy's type. */
type SelectEventHandler = (eventId: string, coordinates?: PanelEventCoordinates) => void;

/**
 * A surface's `PanelHostActions` — the form the DevTools panel and the editor
 * webview implement — with every member a panel could raise spied on.
 */
interface ActionSpies {
  /** The object to hand to the host. */
  readonly actions: PanelHostActions;

  /** The event-selection spy, which the evidence chips report through. */
  readonly selectEvent: Mock<SelectEventHandler>;

  /** The open-source spy, which every source chip reports through. */
  readonly openSource: Mock<(location: SourceLocation) => void>;

  /** The disclosure spy, supplied so a case can assert it was not reached. */
  readonly onExpand: Mock<(nodeId: string, itemId: string, expanded: boolean) => void>;

  /** The filter spy, supplied for the same reason. */
  readonly onFilterChange: Mock<(nodeId: string, filter: Record<string, string>) => void>;
}

/**
 * Fresh host-form action spies.
 *
 * All four members are supplied, the two optional ones included: a case that
 * asserts what a gesture reported is only as strong as its ability to assert
 * what it did *not* report.
 *
 * @returns The actions object and its four spies.
 */
function makeActions(): ActionSpies {
  const selectEvent = vi.fn<SelectEventHandler>();
  const openSource = vi.fn<(location: SourceLocation) => void>();
  const onExpand = vi.fn<(nodeId: string, itemId: string, expanded: boolean) => void>();
  const onFilterChange = vi.fn<(nodeId: string, filter: Record<string, string>) => void>();

  return {
    actions: { selectEvent, openSource, onExpand, onFilterChange },
    selectEvent,
    openSource,
    onExpand,
    onFilterChange,
  };
}

/**
 * The one selection a host-form spy recorded, as its two arguments.
 *
 * @param spy The selection spy, which must have been called exactly once.
 * @returns The event id and the coordinates of that call.
 */
function soleSelection(
  spy: Mock<SelectEventHandler>,
): readonly [string, PanelEventCoordinates | undefined] {
  expect(spy).toHaveBeenCalledTimes(1);

  const [call] = spy.mock.calls;
  if (call === undefined) {
    throw new Error('the event-selection handler recorded no call');
  }

  return [call[0], call[1]];
}

/**
 * The location object the first `sourceLink` node of a document carries — the
 * very object its chip must hand the host.
 *
 * @param spec The specification to read.
 * @returns That node's location.
 */
function firstSourceLinkLocation(spec: PanelSpec): SourceLocation {
  let found: SourceLocation | undefined;

  walkPanelNodes(spec.layout, (node) => {
    if (found === undefined && node.type === 'sourceLink') {
      found = node.location;
    }
  });

  if (found === undefined) {
    throw new Error('the specification under test carries no source-link node');
  }

  return found;
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
async function clickByName(name: string | RegExp, scope?: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  const queries = scope === undefined ? screen : within(scope);

  await user.click(queries.getByRole('button', { name }));
}

/**
 * The accessible name of the chip that opens a location, as a matcher.
 *
 * A chip keeps `Open <target>` when its visible text already sits inside it
 * (the compact cause chip) and is named `<visible text> — open <target>`
 * otherwise (the leaf chip showing its symbol); either way the name ends with
 * the full target, which is what this anchors on, case-insensitively.
 */
function chipName(location: SourceLocation): RegExp {
  const target = formatSourceLocation(location).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return new RegExp(`(?:^open | — open )${target}$`, 'i');
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
 * The theme contract
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
 * The scroll region's name
 * ---------------------------------------------------------------------------
 */

/** The title of the generation that replaces the panel in the replacement case. */
const REPLACED_PANEL_TITLE = 'Panel under test, regenerated';

/**
 * The shell's one scroll viewport.
 *
 * @param container The render's container.
 * @returns The viewport element.
 */
function soleViewport(container: HTMLElement): HTMLElement {
  const viewports = container.querySelectorAll<HTMLElement>('.dg-panel-shell__viewport');
  expect(viewports).toHaveLength(1);

  const [viewport] = viewports;
  if (viewport === undefined) {
    throw new Error('the panel rendered no scroll viewport');
  }

  return viewport;
}

describe('PanelHost scroll region', () => {
  it('makes the viewport a focusable region named by the visible panel title', async () => {
    const { container } = await renderPanel(makeSpec());
    const viewport = soleViewport(container);

    // Found the way assistive technology finds it: a region, by its name.
    const region = screen.getByRole('region', { name: PANEL_TITLE });
    expect(region).toBe(viewport);
    expect(region.getAttribute('tabindex')).toBe('0');

    // The name is the head's own visible title, referenced rather than copied.
    const title = screen.getByRole('heading', { level: 2, name: PANEL_TITLE });
    expect(title.classList.contains('dg-summary-header__title')).toBe(true);
    expect(title.id).not.toBe('');
    expect(region.getAttribute('aria-labelledby')).toBe(title.id);
    expect(region.contains(title)).toBe(true);

    // No heading was added for it: the title is the one heading bearing the
    // panel's name, the one heading at its level, and the outline still opens
    // with it.
    expect(screen.getAllByRole('heading', { name: PANEL_TITLE })).toEqual([title]);
    expect(screen.getAllByRole('heading', { level: 2 })).toEqual([title]);
    expect(headingLevels()[0]).toBe(2);
  });

  it('is the first stop a keyboard user reaches, and announces the title there', async () => {
    const user = userEvent.setup();
    await renderPanel(makeSpec());

    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole('region', { name: PANEL_TITLE }));
  });

  it('stays named by the title on screen when a later generation replaces the panel', async () => {
    const spec = makeSpec();
    const { container, provider, rerender } = await renderPanel(spec);
    const viewport = soleViewport(container);

    rerender({
      ...makeSpec({ title: REPLACED_PANEL_TITLE, summary: spec.summary, layout: spec.layout }),
      panelVersion: 2,
    });
    await waitFor(() => {
      expect(provider.resolve).toHaveBeenCalledTimes(2);
    });
    await screen.findByRole('list', { name: METRIC_VIEW_NAME });

    // The same shell element, now announced by the new document's title.
    const title = screen.getByRole('heading', { level: 2, name: REPLACED_PANEL_TITLE });
    expect(screen.getByRole('region', { name: REPLACED_PANEL_TITLE })).toBe(viewport);
    expect(viewport.getAttribute('aria-labelledby')).toBe(title.id);
    expect(screen.queryByRole('region', { name: PANEL_TITLE })).toBeNull();
  });

  it('gives two hosts on one page two distinct names', async () => {
    const { container } = await renderPanel(makeSpec());
    const other = render(
      <PanelHost
        spec={{ ...makeSpec({ title: REPLACED_PANEL_TITLE }), id: OTHER_PANEL_ID }}
        dataProvider={makeDataProvider().provider}
        actions={makeActions().actions}
      />,
    );
    await within(other.container).findAllByRole('list', { name: METRIC_VIEW_NAME });

    const first = soleViewport(container);
    const second = soleViewport(other.container);
    expect(first.getAttribute('aria-labelledby')).not.toBe(second.getAttribute('aria-labelledby'));
    expect(screen.getByRole('region', { name: PANEL_TITLE })).toBe(first);
    expect(screen.getByRole('region', { name: REPLACED_PANEL_TITLE })).toBe(second);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Observed facts against inferred causes
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
 * What a gesture reports to the host
 * ---------------------------------------------------------------------------
 */

describe('PanelHost interaction reporting', () => {
  it("selects the citation's event id, with the coordinates it recorded", async () => {
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

    // The host form: the schema's `EventRef.eventId`, and beside it the trace
    // and span the citation recorded — the coordinates that let a host scope a
    // trace-filtered view without a lookup, so a selection stripped of them
    // would still pass a count.
    expect(actions.selectEvent).toHaveBeenCalledWith(FIRST_EVENT_ID, {
      traceId: CITATION_TRACE_ID,
      spanId: CITATION_SPAN_ID,
    });

    const [eventId, coordinates] = soleSelection(actions.selectEvent);
    expect(eventId).toBe(citation.eventId);
    expect(Object.keys(coordinates ?? {}).sort()).toEqual(['spanId', 'traceId']);

    // Selecting evidence is not navigation.
    expect(actions.openSource).not.toHaveBeenCalled();
  });

  it('invents no coordinate for a citation that recorded none', async () => {
    const spec = makeSpec();
    const { actions } = await renderPanel(spec);

    await clickByName(SECOND_CITATION_LABEL, observedRegion());

    // The coordinate set is present and empty — never a key written as
    // `undefined`, and never the chip's caption or kind passed off as one.
    const [eventId, coordinates] = soleSelection(actions.selectEvent);
    expect(eventId).toBe(SECOND_EVENT_ID);
    expect(coordinates).toEqual({});
    expect(Object.keys(coordinates ?? {})).toEqual([]);
    expect(actions.openSource).not.toHaveBeenCalled();
  });

  it("forwards a source-link node's location unmodified, field for field", async () => {
    const spec = makeSpec();
    const { actions } = await renderPanel(spec);

    await clickByName(chipName(NODE_LOCATION));

    const reported = soleArgument(actions.openSource, 'open source');

    // The very object the document carried, through the view form's
    // `onOpenSource` and into the host form's `openSource` without a copy.
    expect(reported).toBe(firstSourceLinkLocation(spec));

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

    expect(actions.selectEvent).not.toHaveBeenCalled();
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

    const reported = soleArgument(actions.openSource, 'open source');

    // The very object the analysis suggested, straight into `openSource`.
    expect(reported).toBe(suggested);
    expect(reported).toEqual(CAUSE_LOCATION);
    expect(Object.keys(reported).sort()).toEqual(Object.keys(CAUSE_LOCATION).sort());
    expect(reported.symbol).toBe(CAUSE_LOCATION.symbol);
    expect(reported.endLine).toBe(CAUSE_LOCATION.endLine);
    expect(reported.resolvedBy).toBe(CAUSE_LOCATION.resolvedBy);
    expect(reported.confidence).toBe(CAUSE_LOCATION.confidence);

    // The two chips of one panel point at two different places, and the one
    // that was activated is the one that was reported.
    expect(reported.file).not.toBe(NODE_LOCATION.file);
    expect(actions.selectEvent).not.toHaveBeenCalled();
  });
});

describe('PanelHost served view-form actions', () => {
  it('reports through onSelectEvent and onOpenSource when a surface supplies them', async () => {
    const spec = makeSpec();
    const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
    const onOpenSource = vi.fn<(location: SourceLocation) => void>();

    // The compatibility path: a surface written against the view names hands
    // the host `{ onSelectEvent, onOpenSource }` rather than the host form.
    render(
      <PanelHost
        spec={spec}
        dataProvider={makeDataProvider().provider}
        actions={{ onSelectEvent, onOpenSource }}
      />,
    );
    await screen.findAllByRole('list', { name: METRIC_VIEW_NAME });

    // The head reports through the host form, and the adapter hands the view
    // form the pointer: the id and the coordinates the citation recorded,
    // nothing more.
    await clickByName(FIRST_CITATION_LABEL, observedRegion());
    const reported = soleArgument(onSelectEvent, 'event selection');
    expect(reported).toEqual({
      eventId: FIRST_EVENT_ID,
      traceId: CITATION_TRACE_ID,
      spanId: CITATION_SPAN_ID,
    });
    expect(Object.keys(reported).sort()).toEqual(['eventId', 'spanId', 'traceId']);

    // A source-link node's chip reaches the surface's own `onOpenSource` with
    // the document's location object.
    await clickByName(chipName(NODE_LOCATION));
    expect(soleArgument(onOpenSource, 'open source')).toBe(firstSourceLinkLocation(spec));
    expect(onSelectEvent).toHaveBeenCalledTimes(1);
  });

  it('reports a citation without coordinates as its event id alone', async () => {
    const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
    const onOpenSource = vi.fn<(location: SourceLocation) => void>();

    render(
      <PanelHost
        spec={makeSpec()}
        dataProvider={makeDataProvider().provider}
        actions={{ onSelectEvent, onOpenSource }}
      />,
    );
    await screen.findAllByRole('list', { name: METRIC_VIEW_NAME });

    await clickByName(SECOND_CITATION_LABEL, observedRegion());

    const reported = soleArgument(onSelectEvent, 'event selection');
    expect(reported).toEqual({ eventId: SECOND_EVENT_ID });
    expect(Object.keys(reported)).toEqual(['eventId']);
    expect(onOpenSource).not.toHaveBeenCalled();
  });
});

describe('the action-form adapters the host relies on', () => {
  it('tells the host form from the view form', () => {
    const { actions } = makeActions();

    expect(isPanelHostActions(actions)).toBe(true);
    expect(isPanelHostActions({ onSelectEvent: vi.fn(), onOpenSource: vi.fn() })).toBe(false);
  });

  it('returns a value already in the asked-for form as the same object', () => {
    const { actions: host } = makeActions();
    const view: PanelViewActions = { onSelectEvent: vi.fn(), onOpenSource: vi.fn() };

    expect(toPanelHostActions(host)).toBe(host);
    expect(toPanelViewActions(view)).toBe(view);
  });

  it('adapts the host form for views without inventing a key or wrapping openSource', () => {
    const selectEvent = vi.fn<SelectEventHandler>();
    const openSource = vi.fn<(location: SourceLocation) => void>();
    const view = toPanelViewActions({ selectEvent, openSource });

    // The navigation member is the host's function itself, so a location
    // reaches it by reference with nothing in between.
    expect(view.onOpenSource).toBe(openSource);

    // A coordinate the view passed as `undefined` is not written as a key.
    view.onSelectEvent({ eventId: FIRST_EVENT_ID, traceId: CITATION_TRACE_ID, spanId: undefined });
    const [eventId, coordinates] = soleSelection(selectEvent);
    expect(eventId).toBe(FIRST_EVENT_ID);
    expect(coordinates).toEqual({ traceId: CITATION_TRACE_ID });
    expect(Object.keys(coordinates ?? {})).toEqual(['traceId']);

    // The optional members appear only where the host supplied them.
    expect(Object.keys(view).sort()).toEqual(['onOpenSource', 'onSelectEvent']);
  });

  it('adapts the view form for hosts without inventing a key or wrapping onOpenSource', () => {
    const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
    const onOpenSource = vi.fn<(location: SourceLocation) => void>();
    const onExpand = vi.fn<(nodeId: string, itemId: string, expanded: boolean) => void>();
    const host = toPanelHostActions({ onSelectEvent, onOpenSource, onExpand });

    expect(host.openSource).toBe(onOpenSource);
    expect(host.onExpand).toBe(onExpand);
    expect(Object.keys(host).sort()).toEqual(['onExpand', 'openSource', 'selectEvent']);

    host.selectEvent(SECOND_EVENT_ID);
    host.selectEvent(FIRST_EVENT_ID, { spanId: CITATION_SPAN_ID });

    expect(onSelectEvent.mock.calls.map(([ref]) => ref)).toEqual([
      { eventId: SECOND_EVENT_ID },
      { eventId: FIRST_EVENT_ID, spanId: CITATION_SPAN_ID },
    ]);
    expect(onSelectEvent.mock.calls.map(([ref]) => Object.keys(ref).sort())).toEqual([
      ['eventId'],
      ['eventId', 'spanId'],
    ]);
  });
});

/*
 * ---------------------------------------------------------------------------
 * The fallback notice
 * ---------------------------------------------------------------------------
 */

/**
 * The selection the source chips read on their latest render: what every view
 * beneath the host currently sees as the panel's selected event.
 *
 * @returns The last recorded value, `undefined` when nothing is selected.
 */
function latestSeenSelection(): PanelSelection | undefined {
  expect(selectionProbe.seen.length).toBeGreaterThan(0);

  return selectionProbe.seen.at(-1) as PanelSelection | undefined;
}

/** What {@link SelectionProbe} prints outside any host. */
const SELECTION_PROBE_LABEL = 'selection outside a host';

/**
 * The smallest reader of the selection hooks, rendered outside any host by the
 * degradation case.
 *
 * @returns The two hooks' answers, printed.
 */
function SelectionProbe(): ReactElement {
  const selection = usePanelSelection();
  const eventId = useSelectedEventId();

  return (
    <output aria-label={SELECTION_PROBE_LABEL}>
      {`${String(selection === undefined)}:${String(eventId)}`}
    </output>
  );
}

describe('PanelHost shared selection', () => {
  it('provides nothing as selected before any selection is reported', async () => {
    await renderPanel(makeSpec());

    expect(latestSeenSelection()).toBeUndefined();
  });

  it("records an evidence chip's selection, with its coordinates, for every view", async () => {
    const { actions } = await renderPanel(makeSpec());

    await clickByName(FIRST_CITATION_LABEL, observedRegion());

    // The surface is still told, exactly as before the selection was shared.
    expect(actions.selectEvent).toHaveBeenCalledWith(FIRST_EVENT_ID, {
      traceId: CITATION_TRACE_ID,
      spanId: CITATION_SPAN_ID,
    });

    // And every view beneath the host now reads the same selection, holding
    // exactly the coordinates the citation recorded and nothing else.
    const seen = latestSeenSelection();
    expect(seen).toEqual({
      eventId: FIRST_EVENT_ID,
      traceId: CITATION_TRACE_ID,
      spanId: CITATION_SPAN_ID,
    });
    expect(Object.keys(seen ?? {}).sort()).toEqual(['eventId', 'spanId', 'traceId']);
  });

  it('moves the selection when another citation is selected, inventing no coordinate', async () => {
    await renderPanel(makeSpec());

    await clickByName(FIRST_CITATION_LABEL, observedRegion());
    await clickByName(SECOND_CITATION_LABEL, observedRegion());

    const seen = latestSeenSelection();
    expect(seen).toEqual({ eventId: SECOND_EVENT_ID });
    expect(Object.keys(seen ?? {})).toEqual(['eventId']);
  });

  it('re-renders no view when the selected event is selected again', async () => {
    const { actions } = await renderPanel(makeSpec());

    await clickByName(FIRST_CITATION_LABEL, observedRegion());
    const before = vi.mocked(SourceLink).mock.calls.length;
    await clickByName(FIRST_CITATION_LABEL, observedRegion());

    // The surface hears both activations; the views re-render for neither the
    // second nor its unchanged selection value.
    expect(actions.selectEvent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(SourceLink).mock.calls.length - before).toBe(0);
  });

  it('records a selection reported through view-form actions as well', async () => {
    const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
    const onOpenSource = vi.fn<(location: SourceLocation) => void>();
    const { rerender } = await renderPanel(makeSpec());

    rerender(makeSpec(), { onSelectEvent, onOpenSource });
    await clickByName(FIRST_CITATION_LABEL, observedRegion());

    // One report, one call: the recording wrapper never calls the surface twice.
    expect(onSelectEvent).toHaveBeenCalledTimes(1);
    expect(latestSeenSelection()).toEqual({
      eventId: FIRST_EVENT_ID,
      traceId: CITATION_TRACE_ID,
      spanId: CITATION_SPAN_ID,
    });
  });

  it('drops the selection when another panel is swapped in', async () => {
    const spec = makeSpec();
    const { rerender } = await renderPanel(spec);

    await clickByName(FIRST_CITATION_LABEL, observedRegion());
    expect(latestSeenSelection()?.eventId).toBe(FIRST_EVENT_ID);

    rerender({ ...spec, id: OTHER_PANEL_ID });
    await screen.findAllByRole('list', { name: METRIC_VIEW_NAME });

    expect(latestSeenSelection()).toBeUndefined();
  });

  it('keeps the selection when the same panel is re-delivered', async () => {
    const spec = makeSpec();
    const { rerender } = await renderPanel(spec);

    await clickByName(FIRST_CITATION_LABEL, observedRegion());
    rerender(makeSpec({ title: 'A retitled panel under test', layout: spec.layout }));

    expect(latestSeenSelection()?.eventId).toBe(FIRST_EVENT_ID);
  });

  it('follows a selection the surface drives, and a cleared one', async () => {
    const actions = makeActions();
    const provider = makeDataProvider();
    const spec = makeSpec();
    const draw = (selectedEventId: string | null | undefined): ReactElement => (
      <PanelHost
        spec={spec}
        dataProvider={provider.provider}
        actions={actions.actions}
        selectedEventId={selectedEventId}
      />
    );

    const view = render(draw(CAUSE_EVENT_ID));
    await screen.findAllByRole('list', { name: METRIC_VIEW_NAME });

    // A driven id stands alone: no coordinate is invented for it.
    expect(latestSeenSelection()).toEqual({ eventId: CAUSE_EVENT_ID });

    // A report reaches the surface, and the driven selection holds until the
    // surface changes the prop.
    await clickByName(FIRST_CITATION_LABEL, observedRegion());
    expect(actions.selectEvent).toHaveBeenCalledWith(FIRST_EVENT_ID, {
      traceId: CITATION_TRACE_ID,
      spanId: CITATION_SPAN_ID,
    });
    expect(latestSeenSelection()).toEqual({ eventId: CAUSE_EVENT_ID });

    // Driving the id that was just reported keeps the reporter's coordinates.
    view.rerender(draw(FIRST_EVENT_ID));
    expect(latestSeenSelection()).toEqual({
      eventId: FIRST_EVENT_ID,
      traceId: CITATION_TRACE_ID,
      spanId: CITATION_SPAN_ID,
    });

    // `null` and a blank id both clear it.
    view.rerender(draw(null));
    expect(latestSeenSelection()).toBeUndefined();
    view.rerender(draw(CAUSE_EVENT_ID));
    view.rerender(draw('   '));
    expect(latestSeenSelection()).toBeUndefined();

    // Omitted again, the host shows what the views last reported.
    view.rerender(draw(undefined));
    expect(latestSeenSelection()?.eventId).toBe(FIRST_EVENT_ID);
  });

  it('reads as nothing selected outside a host, and never throws', () => {
    render(<SelectionProbe />);

    expect(screen.getByRole('status', { name: SELECTION_PROBE_LABEL }).textContent).toBe(
      'true:undefined',
    );
  });
});

/** The accessible name of {@link ViewSelectionProbe}'s output. */
const VIEW_SELECTION_LABEL = 'view selection';

/** The accessible name of {@link ViewSelectionProbe}'s selecting control. */
const VIEW_SELECT_LABEL = 'select the second event';

/**
 * The smallest event-bearing view: it marks what {@link useViewSelection}
 * reports and records a selection of its own when its control is pressed.
 *
 * @returns The printed selection and a selecting control.
 */
function ViewSelectionProbe(): ReactElement {
  const { selection, shared, markSelected } = useViewSelection();

  return (
    <>
      <output aria-label={VIEW_SELECTION_LABEL}>
        {`${String(shared)}:${selection?.eventId ?? 'none'}`}
      </output>
      <button
        type="button"
        onClick={() => {
          markSelected({ eventId: SECOND_EVENT_ID });
        }}
      >
        {VIEW_SELECT_LABEL}
      </button>
    </>
  );
}

describe('useViewSelection', () => {
  it('keeps a selection of its own outside a host, so a standalone view still marks', async () => {
    const user = userEvent.setup();

    render(<ViewSelectionProbe />);
    const output = screen.getByRole('status', { name: VIEW_SELECTION_LABEL });
    expect(output.textContent).toBe('false:none');

    await user.click(screen.getByRole('button', { name: VIEW_SELECT_LABEL }));
    expect(output.textContent).toBe('false:' + SECOND_EVENT_ID);
  });

  it("marks the host's shared selection, and never keeps one of its own, inside a host", async () => {
    const user = userEvent.setup();

    render(
      <PanelSelectionContext.Provider value={{ selection: { eventId: FIRST_EVENT_ID } }}>
        <ViewSelectionProbe />
      </PanelSelectionContext.Provider>,
    );
    const output = screen.getByRole('status', { name: VIEW_SELECTION_LABEL });
    expect(output.textContent).toBe('true:' + FIRST_EVENT_ID);

    // The host records every report itself; the view's own write is a no-op.
    await user.click(screen.getByRole('button', { name: VIEW_SELECT_LABEL }));
    expect(output.textContent).toBe('true:' + FIRST_EVENT_ID);
  });

  it('reads a host with nothing selected as shared and unselected', () => {
    render(
      <PanelSelectionContext.Provider value={{ selection: undefined }}>
        <ViewSelectionProbe />
      </PanelSelectionContext.Provider>,
    );

    expect(screen.getByRole('status', { name: VIEW_SELECTION_LABEL }).textContent).toBe(
      'true:none',
    );
  });
});

describe('matchesPanelSelection', () => {
  const selection: PanelSelection = {
    eventId: FIRST_EVENT_ID,
    traceId: CITATION_TRACE_ID,
    spanId: CITATION_SPAN_ID,
  };

  it('matches the selected event id', () => {
    expect(matchesPanelSelection(selection, { eventId: FIRST_EVENT_ID })).toBe(true);
    expect(matchesPanelSelection({ eventId: FIRST_EVENT_ID }, { eventId: FIRST_EVENT_ID })).toBe(
      true,
    );
  });

  it('matches the same span of the same trace under another record id', () => {
    expect(
      matchesPanelSelection(selection, {
        eventId: SECOND_EVENT_ID,
        traceId: CITATION_TRACE_ID,
        spanId: CITATION_SPAN_ID,
      }),
    ).toBe(true);
  });

  it('never matches on one shared coordinate, an absent coordinate or nothing', () => {
    expect(
      matchesPanelSelection(selection, { eventId: SECOND_EVENT_ID, spanId: CITATION_SPAN_ID }),
    ).toBe(false);
    expect(
      matchesPanelSelection(selection, { eventId: SECOND_EVENT_ID, traceId: CITATION_TRACE_ID }),
    ).toBe(false);
    expect(matchesPanelSelection({ eventId: FIRST_EVENT_ID }, { eventId: SECOND_EVENT_ID })).toBe(
      false,
    );
    expect(matchesPanelSelection(undefined, { eventId: FIRST_EVENT_ID })).toBe(false);
    expect(matchesPanelSelection(selection, undefined)).toBe(false);
  });
});

describe('PanelHost fallback notice', () => {
  it('announces a fallback panel in words, above the panel it announces', async () => {
    await renderPanel(makeSpec({ meta: { fallback: true } }));

    const banner = fallbackBanner();
    if (banner === null) {
      throw new Error('a panel carrying meta.fallback rendered no fallback notice');
    }

    // In the accessibility tree, not merely on the surface: the notice was
    // found by its words, and it is announced politely rather than left to a
    // colour or a class to carry, since neither may ever be the sole signal.
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
 * The query lifecycle, through the host
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
    expect(within(stack).queryByRole('status', { busy: true })).toBeNull();
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
    // a view drawn over no data, and never still loading: a failure is never
    // presented as a result.
    const alert = await within(stack).findByRole('alert');
    expect(alert.textContent).toContain(PROVIDER_FAILURE_CODE);
    expect(within(stack).queryByRole('list', { name: METRIC_VIEW_NAME })).toBeNull();
    expect(within(stack).queryByRole('status', { busy: true })).toBeNull();

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
 * Session routing: every query names its panel's session
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

/*
 * ---------------------------------------------------------------------------
 * Session and panel isolation: no view outlives the document it was drawn for
 * ---------------------------------------------------------------------------
 */

/**
 * Every node wrapper the node renderer drew, in document order.
 *
 * The wrapper is the element each mounted view lives in, so its identity is
 * what tells a remounted view from a reused one: a reused view keeps its
 * wrapper element, and a remounted one is drawn into a new element while the
 * old one leaves the document.
 *
 * @param container The render's container.
 * @returns The wrappers currently in the document.
 */
function nodeWrappers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.dg-panel__node'));
}

/**
 * The label of the one metric the stub provider answers with: text that only a
 * view drawn from an answered query can put on screen.
 *
 * @returns The label.
 */
function answeredMetricLabel(): string {
  const [metric] = METRIC_VALUES;
  if (metric === undefined) {
    throw new Error('the suite answers metrics queries with no value');
  }

  return metric.label;
}

describe('PanelHost session and panel isolation', () => {
  it('remounts every view when the same layout arrives for another session', async () => {
    const spec = makeSpec();
    const { container, provider, rerender } = await renderPanel(spec);

    const before = nodeWrappers(container);
    expect(before).toHaveLength(countNodes(spec));

    // The very same node objects, so node ids and queries are identical and
    // only the session differs — the shape in which a view keyed on its node
    // and query alone would carry the previous capture's rows across.
    rerender(makeSpec({ sessionId: OTHER_SESSION_ID, summary: spec.summary, layout: spec.layout }));

    const after = nodeWrappers(container);
    expect(after).toHaveLength(before.length);
    for (const wrapper of before) {
      expect(wrapper.isConnected).toBe(false);
      expect(after).not.toContain(wrapper);
    }

    // A fresh view, asked afresh: under the new session, with the node's own
    // authored query rather than a continuation of the previous page.
    await waitFor(() => {
      expect(provider.resolve).toHaveBeenCalledTimes(2);
    });
    await screen.findByRole('list', { name: METRIC_VIEW_NAME });
    expect(resolverContextAt(provider.resolve, 1).sessionId).toBe(OTHER_SESSION_ID);
    expect(resolverQueryAt(provider.resolve, 1)).toEqual(firstNodeQuery(spec));
  });

  it.each([
    { what: 'another panel', id: OTHER_PANEL_ID, panelVersion: 1 },
    { what: 'another generation of the panel', id: PANEL_ID, panelVersion: 2 },
  ])('remounts every view when $what of the same session arrives', async ({ id, panelVersion }) => {
    const spec = makeSpec();
    const { container, provider, rerender } = await renderPanel(spec);

    const before = nodeWrappers(container);
    expect(before).toHaveLength(countNodes(spec));

    // Same session, same node objects; only the document's identity moved.
    rerender({ ...makeSpec({ summary: spec.summary, layout: spec.layout }), id, panelVersion });

    const after = nodeWrappers(container);
    expect(after).toHaveLength(before.length);
    for (const wrapper of before) {
      expect(wrapper.isConnected).toBe(false);
      expect(after).not.toContain(wrapper);
    }

    await waitFor(() => {
      expect(provider.resolve).toHaveBeenCalledTimes(2);
    });
    await screen.findByRole('list', { name: METRIC_VIEW_NAME });
    expect(resolverContextAt(provider.resolve, 1).sessionId).toBe(SESSION_ID);
    expect(resolverQueryAt(provider.resolve, 1)).toEqual(firstNodeQuery(spec));
  });

  it('keeps every view mounted when the same panel is re-delivered', async () => {
    const spec = makeSpec();
    const { container, provider, rerender } = await renderPanel(spec);

    const before = nodeWrappers(container);

    // A new document object for the same session, id and generation: what a
    // store hands back when nothing about the panel's identity changed.
    rerender(makeSpec({ summary: spec.summary, layout: spec.layout }));

    const after = nodeWrappers(container);
    expect(after).toHaveLength(before.length);
    after.forEach((wrapper, index) => {
      expect(wrapper).toBe(before[index]);
      expect(wrapper.isConnected).toBe(true);
    });
    expect(provider.resolve).toHaveBeenCalledTimes(1);
  });

  it("never shows a previous session's data while the next session loads or fails", async () => {
    const spec = makeSpec();
    const provider = makeControllableProvider();
    const { actions } = makeActions();
    const metricLabel = answeredMetricLabel();

    const view = render(
      <PanelHost spec={spec} dataProvider={provider.provider} actions={actions} />,
    );

    // Session A answers, and its data is on screen.
    const first = provider.takeNext();
    expect(first.context.sessionId).toBe(SESSION_ID);
    first.answer(metricsResponse());
    await screen.findByRole('list', { name: METRIC_VIEW_NAME });
    expect(screen.getByRole('region', { name: STACK_TITLE }).textContent).toContain(metricLabel);

    // Session B, with the very same node objects, and not answered yet.
    view.rerender(
      <PanelHost
        spec={makeSpec({ sessionId: OTHER_SESSION_ID, summary: spec.summary, layout: spec.layout })}
        dataProvider={provider.provider}
        actions={actions}
      />,
    );

    const second = provider.takeNext();
    expect(second.context.sessionId).toBe(OTHER_SESSION_ID);
    expect(second.query).toEqual(firstNodeQuery(spec));

    // Pending: the loading state, and nothing session A answered with.
    const pendingStack = screen.getByRole('region', { name: STACK_TITLE });
    expect(within(pendingStack).getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(within(pendingStack).queryByRole('list', { name: METRIC_VIEW_NAME })).toBeNull();
    expect(pendingStack.textContent).not.toContain(metricLabel);

    second.fail(
      new DebuggenError(PROVIDER_FAILURE_CODE, 'The transport closed before the page arrived.', {
        hint: 'Reconnect, then retry.',
      }),
    );

    // Failed: the error state for session B, and still nothing from session A.
    const failedStack = screen.getByRole('region', { name: STACK_TITLE });
    const alert = await within(failedStack).findByRole('alert');
    expect(alert.textContent).toContain(PROVIDER_FAILURE_CODE);
    expect(within(failedStack).queryByRole('list', { name: METRIC_VIEW_NAME })).toBeNull();
    expect(failedStack.textContent).not.toContain(metricLabel);
    expect(view.container.textContent).not.toContain(metricLabel);
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
 * The host data contract: the service's body becomes the view a component
 * reads, and nothing malformed reaches a component as data
 * ---------------------------------------------------------------------------
 */

describe('the host data contract: wire-to-view mapping and the response check', () => {
  /** The code a response that breaks the panel-data contract is refused with. */
  const MALFORMED_RESPONSE_CODE = 'PROTOCOL_INVALID_MESSAGE';

  /** The paging echo of a one-item last page, exactly as the service sends it. */
  const LAST_PAGE: PanelDataPage = {
    total: 1,
    limit: DATA_QUERY_DEFAULT_LIMIT,
    offset: 0,
    nextOffset: null,
  };

  /** The paging echo of a middle page, so a real next offset is seen to cross. */
  const MIDDLE_PAGE: PanelDataPage = {
    total: 3 * DATA_QUERY_DEFAULT_LIMIT,
    limit: DATA_QUERY_DEFAULT_LIMIT,
    offset: DATA_QUERY_DEFAULT_LIMIT,
    nextOffset: 2 * DATA_QUERY_DEFAULT_LIMIT,
  };

  /** A span-shaped record carrying the identifying fields the event guards read. */
  const WIRE_EVENT = {
    id: 'evt-wire-boundary',
    traceId: CITATION_TRACE_ID,
    spanId: CITATION_SPAN_ID,
    kind: 'fetch',
    tier: 'browser',
  };

  /** A render statistic carrying the fields the render guard reads. */
  const WIRE_RENDER_STAT = {
    id: 'render:ExampleWidget',
    component: 'ExampleWidget',
    renderCount: 3,
  };

  /** A request group: well formed for `requests`, and the wrong element for `renders`. */
  const WIRE_REQUEST_GROUP = {
    id: 'request-group-example',
    method: 'GET',
    url: '/example/resource',
    count: 2,
  };

  /**
   * One well-formed payload per source, keyed exhaustively by the source
   * vocabulary: a source added to the contract fails to compile here until its
   * mapping is exercised. The array-valued payloads are the paged sources.
   */
  const WIRE_PAYLOADS = {
    trace: { traceId: CITATION_TRACE_ID, roots: [], nodeCount: 0 },
    spans: [WIRE_EVENT],
    events: [WIRE_EVENT],
    renders: [WIRE_RENDER_STAT],
    componentTree: {
      capturedAt: 0,
      origin: 'commit-snapshot',
      degraded: false,
      nodeCount: 0,
      roots: [],
    },
    requests: [WIRE_REQUEST_GROUP],
    queries: [{ id: 'query-group-example', normalizedStatement: 'SELECT $1', executionCount: 2 }],
    stateTransitions: [{ id: 'evt-state-example', eventId: 'evt-state-example' }],
    graph: { nodes: [], edges: [] },
    metrics: METRIC_VALUES,
  } satisfies { readonly [Source in DataQuery['source']]: unknown };

  /** Every source, in the order the table above lists them. */
  const WIRE_SOURCES = Object.keys(WIRE_PAYLOADS) as readonly (keyof typeof WIRE_PAYLOADS)[];

  /**
   * A service body: the payload under the source-named key and, for a paged
   * source, the paging echo beside it.
   *
   * @param source The source the body answers for.
   * @param payload The payload, under `source`.
   * @param page The paging echo; omitted for a single-value source.
   * @returns The body, as the transport would decode it.
   */
  function wireBody(
    source: DataQuery['source'],
    payload: unknown,
    page?: object,
  ): Record<string, unknown> {
    return page === undefined
      ? { source, [source]: payload }
      : { source, [source]: payload, ...page };
  }

  /**
   * The last-page echo with one counter left out, as a producer that dropped it
   * would send it.
   *
   * @param counter The counter to omit.
   * @returns The remaining counters.
   */
  function pageWithout(counter: keyof PanelDataPage): Record<string, unknown> {
    return Object.fromEntries(Object.entries(LAST_PAGE).filter(([name]) => name !== counter));
  }

  /**
   * The body every metrics query in these cases is answered with by a host
   * resolver: the suite's metric values as the service sends them.
   *
   * @returns A fresh wire-form result for the `metrics` source.
   */
  function metricsBody(): PanelDataResult {
    return { source: 'metrics', metrics: METRIC_VALUES, ...LAST_PAGE };
  }

  /**
   * A value a transport forwarded without decoding it, typed as the result it
   * claims to be. How a body built here from the minimal fixtures above — or a
   * malformed one, which the mapping must refuse — reaches a host resolver's
   * return type: only the mapping's runtime check stands between it and a view.
   *
   * @param value The body as it arrived.
   * @returns The same value, claimed to be a wire-form result.
   */
  function undecodedBody(value: unknown): PanelDataResult {
    return value as PanelDataResult;
  }

  it.each(WIRE_SOURCES)(
    'maps a "%s" body onto the view a component reads, payload and counters untouched',
    (source) => {
      const payload = WIRE_PAYLOADS[source];
      const paged = Array.isArray(payload);

      const mapped = mapPanelDataResult(
        { source },
        wireBody(source, payload, paged ? LAST_PAGE : undefined),
      );
      if (!mapped.ok) {
        throw mapped.error;
      }

      // The very payload the service sent, under `data` — not a copy, and not
      // re-ordered — with the four counters for a paged source (the last-page
      // `null` included) and none at all for a single-value one.
      expect(mapped.value.data).toBe(payload);
      expect(mapped.value).toStrictEqual(
        paged ? { source, data: payload, ...LAST_PAGE } : { source, data: payload },
      );
    },
  );

  it("carries a middle page's counters across exactly as the service stated them", () => {
    const mapped = mapPanelDataResult(
      { source: 'renders', offset: MIDDLE_PAGE.offset },
      wireBody('renders', [WIRE_RENDER_STAT], MIDDLE_PAGE),
    );
    if (!mapped.ok) {
      throw mapped.error;
    }

    expect(mapped.value).toStrictEqual({
      source: 'renders',
      data: [WIRE_RENDER_STAT],
      ...MIDDLE_PAGE,
    });
  });

  it.each(['trace', 'componentTree'] as const)(
    'maps a "%s" body of null, the wire\'s "nothing matched", to a successful view of null',
    (source) => {
      expect(mapPanelDataResult({ source }, wireBody(source, null))).toStrictEqual({
        ok: true,
        value: { source, data: null },
      });
    },
  );

  /** One malformed body, and the field its refusal must name. */
  interface WireRefusal {
    /** What is wrong, for the case title. */
    readonly name: string;
    /** The query the body claims to answer. */
    readonly query: DataQuery;
    /** The body as it arrived. */
    readonly body: unknown;
    /** The field path the refusal names. */
    readonly field: string;
  }

  const WIRE_REFUSALS: readonly WireRefusal[] = [
    { name: 'a null body', query: { source: 'renders' }, body: null, field: 'the response' },
    {
      name: 'an array body',
      query: { source: 'renders' },
      body: [WIRE_RENDER_STAT],
      field: 'the response',
    },
    { name: 'a string body', query: { source: 'renders' }, body: 'renders', field: 'the response' },
    {
      name: 'a body without its source-named member',
      query: { source: 'renders' },
      body: { source: 'renders', ...LAST_PAGE },
      field: 'renders',
    },
    {
      name: 'a view-form response handed over as a body',
      query: { source: 'spans' },
      body: { source: 'spans', data: [WIRE_EVENT], ...LAST_PAGE },
      field: 'spans',
    },
    {
      name: 'a single element where a list belongs',
      query: { source: 'renders' },
      body: wireBody('renders', WIRE_RENDER_STAT, LAST_PAGE),
      field: 'renders',
    },
    {
      name: 'an element that is not an object',
      query: { source: 'renders' },
      body: wireBody('renders', ['ExampleWidget'], LAST_PAGE),
      field: 'renders[0]',
    },
    {
      name: 'an element missing an identifying field',
      query: { source: 'events' },
      body: wireBody(
        'events',
        [
          {
            id: WIRE_EVENT.id,
            traceId: WIRE_EVENT.traceId,
            kind: WIRE_EVENT.kind,
            tier: 'browser',
          },
        ],
        LAST_PAGE,
      ),
      field: 'events[0].spanId',
    },
    {
      name: "another source's elements under the requested key",
      query: { source: 'renders' },
      body: wireBody('renders', [WIRE_REQUEST_GROUP], LAST_PAGE),
      field: 'renders[0].component',
    },
    {
      name: 'a page longer than any query may ask for',
      query: { source: 'spans' },
      body: wireBody(
        'spans',
        Array.from({ length: DATA_QUERY_MAX_LIMIT + 1 }, () => WIRE_EVENT),
        { ...LAST_PAGE, total: DATA_QUERY_MAX_LIMIT + 1, limit: DATA_QUERY_MAX_LIMIT },
      ),
      field: 'spans',
    },
    {
      name: 'a trace without its roots',
      query: { source: 'trace' },
      body: wireBody('trace', { traceId: CITATION_TRACE_ID, nodeCount: 0 }),
      field: 'trace.roots',
    },
    {
      name: 'a trace without the node count its view reads',
      query: { source: 'trace' },
      body: wireBody('trace', { traceId: CITATION_TRACE_ID, roots: [] }),
      field: 'trace.nodeCount',
    },
    {
      name: 'a component tree without its capture time',
      query: { source: 'componentTree' },
      body: wireBody('componentTree', {
        origin: 'commit-snapshot',
        degraded: false,
        nodeCount: 0,
        roots: [],
      }),
      field: 'componentTree.capturedAt',
    },
    {
      name: 'a component tree without the origin its view reads',
      query: { source: 'componentTree' },
      body: wireBody('componentTree', { capturedAt: 0, degraded: false, nodeCount: 0, roots: [] }),
      field: 'componentTree.origin',
    },
    {
      name: 'a graph of null, which a graph never is',
      query: { source: 'graph' },
      body: wireBody('graph', null),
      field: 'graph',
    },
    ...(['total', 'limit', 'offset', 'nextOffset'] as const).map((counter): WireRefusal => ({
      name: `a paged body without ${counter}`,
      query: { source: 'renders' },
      body: wireBody('renders', [WIRE_RENDER_STAT], pageWithout(counter)),
      field: counter,
    })),
    ...(
      [
        ['total', -1],
        ['total', 1.5],
        ['limit', 0.5],
        ['limit', DATA_QUERY_MAX_LIMIT + 1],
        ['offset', -DATA_QUERY_DEFAULT_LIMIT],
        ['offset', 2.25],
        ['nextOffset', 400.5],
        ['nextOffset', -1],
        ['nextOffset', '400'],
      ] as const
    ).map(([counter, value]): WireRefusal => ({
      name: `${counter} of ${JSON.stringify(value)}`,
      query: { source: 'renders' },
      body: wireBody('renders', [WIRE_RENDER_STAT], { ...LAST_PAGE, [counter]: value }),
      field: counter,
    })),
  ];

  it.each(WIRE_REFUSALS)('refuses $name, naming the field at fault', ({ query, body, field }) => {
    const mapped = mapPanelDataResult(query, body);
    if (mapped.ok) {
      throw new Error('a malformed body was mapped onto a view');
    }

    expect(mapped.error).toBeInstanceOf(DebuggenError);
    expect(mapped.error.code).toBe(MALFORMED_RESPONSE_CODE);
    expect(mapped.error.details).toMatchObject({ source: query.source, form: 'wire', field });
    // The field at fault is developer detail: it is named in the details, which
    // the error state keeps behind its closed disclosure, while the message is
    // the one reader sentence every unreadable answer shares.
    expect(mapped.error.message).toBe(
      `The "${query.source}" data for this view arrived in a form it cannot read.`,
    );
    expect(mapped.error.hint ?? '').not.toBe('');
  });

  it('refuses a body answering for another source, naming both sources', () => {
    const mapped = mapPanelDataResult(
      { source: 'renders' },
      wireBody('requests', [WIRE_REQUEST_GROUP], LAST_PAGE),
    );
    if (mapped.ok) {
      throw new Error('a misrouted body was mapped onto a view');
    }

    expect(mapped.error.code).toBe(MALFORMED_RESPONSE_CODE);

    // Both sources and the form, machine-readably, beside the integration
    // remedy that belongs to the developer rather than on the hint line.
    const { remedy, ...identity } = mapped.error.details ?? {};
    expect(identity).toEqual({
      requested: 'renders',
      received: 'requests',
      form: 'wire',
    });
    expect(remedy).toMatch(/\S/u);
  });

  it('never quotes a refused value in the message, the hint or the details', () => {
    const sentinel = 'sentinel-value-a-refusal-must-never-echo';
    const bodies: readonly unknown[] = [
      sentinel,
      { source: sentinel, renders: [WIRE_RENDER_STAT], ...LAST_PAGE },
      wireBody('renders', [sentinel], LAST_PAGE),
      wireBody('renders', { [sentinel]: sentinel }, LAST_PAGE),
      wireBody('renders', [WIRE_RENDER_STAT], { ...LAST_PAGE, nextOffset: sentinel }),
    ];

    for (const body of bodies) {
      const mapped = mapPanelDataResult({ source: 'renders' }, body);
      if (mapped.ok) {
        throw new Error('a malformed body was mapped onto a view');
      }

      const reported = JSON.stringify({
        message: mapped.error.message,
        hint: mapped.error.hint,
        details: mapped.error.details,
      });
      expect(reported).not.toContain(sentinel);
    }
  });

  it('draws a view from the service body a host resolver returns, where the body once left no data', async () => {
    const resolve = vi.fn<PanelDataResolver>((query) =>
      query.source === 'metrics'
        ? Promise.resolve(metricsBody())
        : Promise.reject(
            new DebuggenError('NOT_IMPLEMENTED', `No "${query.source}" body is served here.`),
          ),
    );
    const spec = makeSpec();

    render(
      <PanelHost
        spec={spec}
        dataProvider={createPanelDataProvider(resolve)}
        actions={makeActions().actions}
      />,
    );

    // The settled view with the metric in it: under the old contract the body's
    // `metrics` member never reached `data`, and the view drew its empty state.
    const stack = screen.getByRole('region', { name: STACK_TITLE });
    const view = await within(stack).findByRole('list', { name: METRIC_VIEW_NAME });
    expect(within(view).getAllByRole('listitem')).toHaveLength(METRIC_VALUES.length);
    expect(within(stack).queryByRole('alert')).toBeNull();

    expect(resolve).toHaveBeenCalledTimes(1);
    const [call] = resolve.mock.calls;
    if (call === undefined) {
      throw new Error('the host resolver recorded no call');
    }
    expect(call[0]).toEqual(firstNodeQuery(spec));
    expect(call[1].sessionId).toBe(SESSION_ID);
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['', BLANK_SESSION_ID])(
    'refuses a query addressed to %j before the host resolver runs',
    async (sessionId) => {
      const resolve = vi.fn<PanelDataResolver>(() => Promise.resolve(metricsBody()));

      const refused = createPanelDataProvider(resolve).query(sessionId, { source: 'metrics' });

      await expect(refused).rejects.toBeInstanceOf(DebuggenError);
      await expect(refused).rejects.toMatchObject({ code: UNADDRESSED_QUERY_CODE });
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it("turns a host resolver's synchronous throw into a rejection", async () => {
    const resolve = vi.fn<PanelDataResolver>(() => {
      throw new DebuggenError(PROVIDER_FAILURE_CODE, 'The channel is not open.');
    });

    const pending = createPanelDataProvider(resolve).query(SESSION_ID, { source: 'metrics' });

    await expect(pending).rejects.toMatchObject({ code: PROVIDER_FAILURE_CODE });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('rejects a body the mapping refuses, rather than resolving a view without data', async () => {
    const resolve = vi.fn<PanelDataResolver>(() =>
      Promise.resolve(undecodedBody({ source: 'metrics', data: METRIC_VALUES, ...LAST_PAGE })),
    );

    const refused = createPanelDataProvider(resolve).query(SESSION_ID, { source: 'metrics' });

    await expect(refused).rejects.toBeInstanceOf(DebuggenError);
    await expect(refused).rejects.toMatchObject({
      code: MALFORMED_RESPONSE_CODE,
      details: { source: 'metrics', form: 'wire', field: 'metrics' },
    });
  });

  it.each(WIRE_SOURCES)(
    'accepts, in the view check, the "%s" view the mapping produced',
    (source) => {
      const payload = WIRE_PAYLOADS[source];
      const mapped = mapPanelDataResult(
        { source },
        wireBody(source, payload, Array.isArray(payload) ? LAST_PAGE : undefined),
      );
      if (!mapped.ok) {
        throw mapped.error;
      }

      // The two paths share one set of guards, so what one produces the other
      // accepts — with the wire's counters, and without any.
      expect(checkDataQueryResponse({ source }, mapped.value)).toBeUndefined();
      expect(checkDataQueryResponse({ source }, { source, data: payload })).toBeUndefined();
    },
  );

  /** The accessible names of {@link QueryStateProbe}'s four outputs. */
  const PROBE_STATUS_LABEL = 'query status';
  const PROBE_ERROR_LABEL = 'query error code';
  const PROBE_DATA_LABEL = 'query data';
  const PROBE_PAGE_LABEL = 'query paging counters';

  /** What {@link QueryStateProbe} is asked to resolve. */
  interface QueryStateProbeProps {
    /** The query the probe hands the hook, unmodified. */
    readonly query: DataQuery;
  }

  /**
   * The smallest view over the query hook that prints everything it reports:
   * the status, the error's code, the data and the four paging counters, with
   * the retry it offers as a button.
   *
   * @param props See {@link QueryStateProbeProps}.
   * @returns The printed result.
   */
  function QueryStateProbe(props: QueryStateProbeProps): ReactElement {
    const { status, error, data, total, limit, offset, nextOffset, retry } = useQuery(props.query);

    return (
      <>
        <output aria-label={PROBE_STATUS_LABEL}>{status}</output>
        <output aria-label={PROBE_ERROR_LABEL}>{error?.code ?? ''}</output>
        <output aria-label={PROBE_DATA_LABEL}>
          {data === undefined ? 'undefined' : JSON.stringify(data)}
        </output>
        <output aria-label={PROBE_PAGE_LABEL}>
          {JSON.stringify({ total, limit, offset, nextOffset })}
        </output>
        <button type="button" onClick={retry}>
          Retry
        </button>
      </>
    );
  }

  /** A provider written by hand against the interface, and the calls it received. */
  interface HandWrittenProvider {
    /** The provider: a plain object, built by no library factory. */
    readonly provider: DataProvider;
    /** Every call, as the session and the query it was addressed with. */
    readonly calls: Mock<(sessionId: string, query: DataQuery) => void>;
  }

  /**
   * A provider implementing `DataProvider` directly, answering its calls with
   * the scripted responses in order — whatever they are.
   *
   * No factory checks anything on its way out, which is the point: the query
   * hook is the only thing between these answers and a component.
   *
   * @param answers The responses to resolve with, one per call.
   * @returns The provider and its call recorder.
   */
  function makeHandWrittenProvider(answers: readonly unknown[]): HandWrittenProvider {
    const queue = [...answers];
    const calls = vi.fn<(sessionId: string, query: DataQuery) => void>();

    const provider: DataProvider = {
      query<Source extends DataQuery['source']>(
        sessionId: string,
        query: DataQuery & { source: Source },
      ): Promise<DataQueryResponse<Source>> {
        calls(sessionId, query);

        // What a hand-written implementation does with whatever its transport
        // decoded: asserts it is the promised response. Nothing checks it here.
        return Promise.resolve(queue.shift() as DataQueryResponse<Source>);
      },
    };

    return { provider, calls };
  }

  /**
   * Mounts {@link QueryStateProbe} under a provider and the suite's session.
   *
   * @param provider The provider to resolve through.
   * @param query The query to resolve.
   */
  function renderProbe(provider: DataProvider, query: DataQuery): void {
    render(
      <DataProviderContext.Provider value={provider}>
        <PanelSessionContext.Provider value={SESSION_ID}>
          <QueryStateProbe query={query} />
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>,
    );
  }

  /**
   * The text of one of the probe's outputs.
   *
   * @param label The output's accessible name.
   * @returns Its text.
   */
  function probeText(label: string): string {
    return screen.getByLabelText(label).textContent ?? '';
  }

  /**
   * Waits for the probe's query to leave the loading state.
   *
   * @returns The status it settled in.
   */
  async function settledProbeStatus(): Promise<string> {
    await waitFor(() => {
      expect(probeText(PROBE_STATUS_LABEL)).not.toBe('loading');
    });

    return probeText(PROBE_STATUS_LABEL);
  }

  /** One answer a hand-written provider gives that the hook must refuse. */
  interface ViewRefusal {
    /** What is wrong, for the case title. */
    readonly name: string;
    /** The query the probe resolves. */
    readonly query: DataQuery;
    /** The provider's answer. */
    readonly answer: unknown;
  }

  const VIEW_REFUSALS: readonly ViewRefusal[] = [
    {
      name: 'an answer for another source',
      query: { source: 'renders' },
      answer: { source: 'requests', data: [WIRE_REQUEST_GROUP], total: 1 },
    },
    {
      name: "another source's payload under the requested source",
      query: { source: 'renders' },
      answer: { source: 'renders', data: [WIRE_REQUEST_GROUP], total: 1 },
    },
    {
      name: "the service's body, untranslated",
      query: { source: 'spans' },
      answer: { source: 'spans', spans: [WIRE_EVENT], ...LAST_PAGE },
    },
    {
      name: 'a list where a trace belongs',
      query: { source: 'trace' },
      answer: { source: 'trace', data: [WIRE_EVENT] },
    },
    { name: 'no answer at all', query: { source: 'events' }, answer: undefined },
    {
      name: 'a negative total',
      query: { source: 'events' },
      answer: { source: 'events', data: [], total: -1 },
    },
    {
      name: 'a fractional limit',
      query: { source: 'events' },
      answer: { source: 'events', data: [], limit: 0.5 },
    },
    {
      name: 'a limit beyond the page ceiling',
      query: { source: 'events' },
      answer: { source: 'events', data: [], limit: DATA_QUERY_MAX_LIMIT + 1 },
    },
    {
      name: 'an offset that is not a number',
      query: { source: 'events' },
      answer: { source: 'events', data: [], offset: '0' },
    },
    {
      name: 'a fractional next offset',
      query: { source: 'events' },
      answer: { source: 'events', data: [], nextOffset: 1.5 },
    },
  ];

  it.each(VIEW_REFUSALS)(
    'reports $name from a hand-written provider as an error with no data, not a success',
    async ({ query, answer }) => {
      const { provider, calls } = makeHandWrittenProvider([answer]);

      renderProbe(provider, query);

      expect(await settledProbeStatus()).toBe('error');
      expect(probeText(PROBE_ERROR_LABEL)).toBe(MALFORMED_RESPONSE_CODE);
      expect(probeText(PROBE_DATA_LABEL)).toBe('undefined');
      expect(JSON.parse(probeText(PROBE_PAGE_LABEL))).toEqual({});
      expect(calls).toHaveBeenCalledTimes(1);
    },
  );

  it('retries a refused answer with the very same query, and draws the corrected answer', async () => {
    const { provider, calls } = makeHandWrittenProvider([
      { source: 'requests', data: [WIRE_REQUEST_GROUP], total: 1 },
      { source: 'renders', data: [WIRE_RENDER_STAT], total: 1 },
    ]);
    const query: DataQuery = { source: 'renders', limit: DATA_QUERY_DEFAULT_LIMIT };

    renderProbe(provider, query);
    expect(await settledProbeStatus()).toBe('error');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: RETRY_PATTERN }));

    expect(await settledProbeStatus()).toBe('success');
    expect(probeText(PROBE_ERROR_LABEL)).toBe('');
    expect(JSON.parse(probeText(PROBE_DATA_LABEL))).toEqual([WIRE_RENDER_STAT]);
    expect(JSON.parse(probeText(PROBE_PAGE_LABEL))).toEqual({ total: 1 });

    // The retry re-issued the failed request itself: same session, same query.
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[1]).toEqual(calls.mock.calls[0]);
    expect(calls.mock.calls[0]).toEqual([SESSION_ID, query]);
  });

  it('reports a null trace from a hand-written provider as a success whose data is null', async () => {
    const { provider } = makeHandWrittenProvider([{ source: 'trace', data: null }]);

    renderProbe(provider, { source: 'trace', filter: { traceId: CITATION_TRACE_ID } });

    expect(await settledProbeStatus()).toBe('success');
    expect(probeText(PROBE_DATA_LABEL)).toBe('null');
    expect(probeText(PROBE_ERROR_LABEL)).toBe('');
  });

  it.each([
    { name: 'a middle page', page: MIDDLE_PAGE, reported: MIDDLE_PAGE },
    {
      name: 'the last page',
      page: LAST_PAGE,
      reported: { total: LAST_PAGE.total, limit: LAST_PAGE.limit, offset: LAST_PAGE.offset },
    },
  ])(
    "hands a view all four counters of the service's body for $name",
    async ({ page, reported }) => {
      const resolve = vi.fn<PanelDataResolver>(() =>
        Promise.resolve(undecodedBody(wireBody('events', [WIRE_EVENT], page))),
      );

      renderProbe(createPanelDataProvider(resolve), { source: 'events' });

      // The wire's `null` next offset is the one counter the hook folds, into
      // the absent value a view reads as end-of-data.
      expect(await settledProbeStatus()).toBe('success');
      expect(JSON.parse(probeText(PROBE_PAGE_LABEL))).toEqual(reported);
      expect(JSON.parse(probeText(PROBE_DATA_LABEL))).toEqual([WIRE_EVENT]);
    },
  );

  it("draws a real view's error state for a misrouted answer, and the view once a retry is answered", async () => {
    const { provider, calls } = makeHandWrittenProvider([
      { source: 'renders', data: [WIRE_RENDER_STAT], total: 1 },
      metricsResponse(),
    ]);

    render(<PanelHost spec={makeSpec()} dataProvider={provider} actions={makeActions().actions} />);

    const stack = screen.getByRole('region', { name: STACK_TITLE });
    const alert = await within(stack).findByRole('alert');
    expect(alert.textContent).toContain(MALFORMED_RESPONSE_CODE);
    expect(within(stack).queryByRole('list', { name: METRIC_VIEW_NAME })).toBeNull();

    const user = userEvent.setup();
    await user.click(within(alert).getByRole('button', { name: RETRY_PATTERN }));

    await within(stack).findByRole('list', { name: METRIC_VIEW_NAME });
    expect(within(stack).queryByRole('alert')).toBeNull();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[1]).toEqual(calls.mock.calls[0]);
  });
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

  it('re-renders no view when view-form actions are rebuilt from the same callbacks', async () => {
    const spec = makeSpec();
    const onSelectEvent = vi.fn<(ref: PanelEventRef) => void>();
    const onOpenSource = vi.fn<(location: SourceLocation) => void>();
    const { provider, rerender } = await renderPanel(spec);

    // Settle on the view form first, then rebuild it: only the second render
    // is counted, so the adaptation itself must be what stays stable.
    rerender(spec, { onSelectEvent, onOpenSource });
    const renders = countRenders(() => {
      rerender(spec, { onSelectEvent, onOpenSource });
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
 * The document outline, and inert citations
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

/**
 * The level and text of every heading inside one part of the panel, in
 * document order: the outline a layout draws, without the panel head above it.
 *
 * Exact on purpose. A heading drawn where none belongs — over a source chip, or
 * for an untitled container — is as wrong as one missing, and only a complete
 * list shows both.
 *
 * @param scope The region, or node frame, whose outline is wanted.
 * @returns One `[level, text]` pair per heading.
 */
function outlineWithin(scope: HTMLElement): (readonly [number, string])[] {
  return within(scope)
    .queryAllByRole('heading')
    .map((heading) => [Number(heading.tagName.slice(1)), heading.textContent ?? ''] as const);
}

/**
 * The node frame a rendered element belongs to: its nearest `data-node-path`
 * wrapper.
 *
 * @param element An element a node drew.
 * @returns That node's frame.
 */
function frameOf(element: HTMLElement): HTMLElement {
  const frame = element.closest<HTMLElement>('[data-node-path]');
  if (frame === null) {
    throw new Error('the element is drawn outside any node frame');
  }

  return frame;
}

/** The title a panel author gives the view of {@link metricView}, in the case that keeps it. */
const AUTHORED_VIEW_TITLE = 'Authored view title';

/** The supporting line a panel author gives an otherwise untitled view. */
const AUTHORED_VIEW_DESCRIPTION = 'An authored line saying how to read this view.';

/**
 * A query-backed metric view carrying only the labels a case gives it.
 *
 * @param id The node's id, which is also its document path.
 * @param labels The title and description to author, if any.
 * @returns The node.
 */
function metricView(
  id: string,
  labels: { readonly title?: string; readonly description?: string } = {},
): PanelNode {
  return {
    type: 'metricCards',
    id,
    query: { source: 'metrics' },
    metrics: [NODE_METRIC_ID],
    ...labels,
  };
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

  it('heads an untitled view with its catalogue label one level below the container that titled it', async () => {
    await renderPanel(makeSpec());

    // The metric view at the bottom of the nested layout carries no title, so
    // its type's catalogue label heads it, one level below the stack; the
    // source link beside it draws no heading at all.
    expect(outlineWithin(screen.getByRole('region', { name: SECTION_TITLE }))).toEqual([
      [3, SECTION_TITLE],
      [4, SPLIT_TITLE],
      [5, STACK_TITLE],
      [6, METRIC_VIEW_NAME],
    ]);
  });

  it("names an untitled view's region with its catalogue label, at the layout's level", async () => {
    await renderPanel(makeSpec({ layout: makeSiblingLayout() }));

    // A top-level view sits directly below the panel title, as a titled one would.
    const heading = screen.getByRole('heading', { level: 3, name: METRIC_VIEW_NAME });
    const region = screen.getByRole('region', { name: METRIC_VIEW_NAME });

    // A real region, named by that heading and holding the view itself, so a
    // reader who lands on the heading or the landmark is at the evidence.
    expect(region.tagName).toBe('SECTION');
    expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(region.contains(heading)).toBe(true);
    expect(within(region).getAllByRole('list', { name: METRIC_VIEW_NAME })).toHaveLength(1);

    // The `Section` primitive's own heading, which is also what the node's
    // focus keeper parks on.
    expect(heading.classList.contains('dg-section__title')).toBe(true);
    expect(outlineWithin(frameOf(region))).toEqual([[3, METRIC_VIEW_NAME]]);
  });

  it('draws no heading and no region for an untitled source link', async () => {
    await renderPanel(makeSpec({ layout: makeSiblingLayout() }));

    // One chip, whose own accessible name says where it leads: a heading over
    // it would name a control rather than a region.
    const frame = frameOf(screen.getByRole('button', { name: chipName(NODE_LOCATION) }));

    expect(outlineWithin(frame)).toEqual([]);
    expect(within(frame).queryAllByRole('region')).toEqual([]);
  });

  it('adds no level under a container that draws no heading', async () => {
    await renderPanel(makeSpec({ layout: makeUntitledMiddleLayout() }));

    screen.getByRole('heading', { level: 3, name: OUTER_TITLE });
    screen.getByRole('heading', { level: 4, name: INNER_TITLE });

    // Exactly the two titled containers: the untitled stack between them and
    // the two source links inside the split draw none.
    expect(outlineWithin(screen.getByRole('region', { name: OUTER_TITLE }))).toEqual([
      [3, OUTER_TITLE],
      [4, INNER_TITLE],
    ]);
  });

  it("heads an untitled view inside an untitled container at the container's own level", async () => {
    const { container } = await renderPanel(
      makeSpec({
        layout: [
          {
            type: 'stack',
            id: 'layout.0',
            children: [
              metricView('layout.0.children.0'),
              { type: 'sourceLink', id: 'layout.0.children.1', location: { ...NODE_LOCATION } },
            ],
          },
        ],
      }),
    );

    // The stack draws no heading and so adds no level: the view it groups is
    // headed at the layout's own level, and is the only region the stack holds.
    const stack = container.querySelector<HTMLElement>('[data-node-path="layout.0"]');
    if (stack === null) {
      throw new Error('the untitled stack drew no node frame');
    }

    expect(outlineWithin(stack)).toEqual([[3, METRIC_VIEW_NAME]]);
    expect(
      within(stack)
        .getAllByRole('region')
        .map((region) => region.getAttribute('aria-labelledby')),
    ).toEqual([within(stack).getByRole('heading', { name: METRIC_VIEW_NAME }).id]);
  });

  it('keeps a title the panel wrote instead of the catalogue label', async () => {
    await renderPanel(
      makeSpec({ layout: [metricView('layout.0', { title: AUTHORED_VIEW_TITLE })] }),
    );

    screen.getByRole('region', { name: AUTHORED_VIEW_TITLE });
    screen.getByRole('heading', { level: 3, name: AUTHORED_VIEW_TITLE });
    expect(screen.queryByRole('heading', { name: METRIC_VIEW_NAME })).toBeNull();
  });

  it('reads a blank title as none, and heads the view with its catalogue label', async () => {
    await renderPanel(makeSpec({ layout: [metricView('layout.0', { title: '   ' })] }));

    screen.getByRole('region', { name: METRIC_VIEW_NAME });
    screen.getByRole('heading', { level: 3, name: METRIC_VIEW_NAME });
  });

  it('renders a description on an untitled view under its catalogue label', async () => {
    await renderPanel(
      makeSpec({ layout: [metricView('layout.0', { description: AUTHORED_VIEW_DESCRIPTION })] }),
    );

    const region = screen.getByRole('region', { name: METRIC_VIEW_NAME });
    const heading = within(region).getByRole('heading', { level: 3, name: METRIC_VIEW_NAME });
    const description = within(region).getByText(AUTHORED_VIEW_DESCRIPTION);

    // Prose under the heading, never the region's name.
    expect(heading.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(outlineWithin(region)).toEqual([[3, METRIC_VIEW_NAME]]);
  });
});

describe('SummaryHeader citations without a selection handler', () => {
  it('renders every citation as inert text, never as a control that does nothing', async () => {
    const openSource = vi.fn<(location: SourceLocation) => void>();

    render(<SummaryHeader title={PANEL_TITLE} summary={makeSummary()} openSource={openSource} />);

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
    const selectEvent = vi.fn<SelectEventHandler>();

    render(<SummaryHeader title={PANEL_TITLE} summary={makeSummary()} selectEvent={selectEvent} />);

    for (const label of [FIRST_CITATION_LABEL, SECOND_CITATION_LABEL, CAUSE_CITATION_LABEL]) {
      screen.getByRole('button', { name: label });
    }

    await clickByName(CAUSE_CITATION_LABEL, causesRegion());

    // The citation's event id, and the coordinates it recorded — none.
    const [eventId, coordinates] = soleSelection(selectEvent);
    expect(eventId).toBe(CAUSE_EVENT_ID);
    expect(coordinates).toEqual({});
  });

  it("hands its source chip the head's openSource, with the suggested location", async () => {
    const summary = makeSummary();
    const openSource = vi.fn<(location: SourceLocation) => void>();
    const selectEvent = vi.fn<SelectEventHandler>();

    render(
      <SummaryHeader
        title={PANEL_TITLE}
        summary={summary}
        selectEvent={selectEvent}
        openSource={openSource}
      />,
    );

    const suggested = summary.likelyCauses[0]?.suggestedLocation;
    if (suggested === undefined) {
      throw new Error('the summary under test suggests no location');
    }

    await clickByName(chipName(suggested), causesRegion());

    expect(soleArgument(openSource, 'open source')).toBe(suggested);
    expect(selectEvent).not.toHaveBeenCalled();
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

    expect(actions.selectEvent).toHaveBeenCalledTimes(1);
    expect(actions.openSource).toHaveBeenCalledTimes(1);

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

/*
 * ---------------------------------------------------------------------------
 * Cross-view selection through the real host
 *
 * The panel has one selected event, and every view that draws it marks it:
 * an evidence chip selects the underlying event everywhere. These cases draw
 * the two event-bearing tables a panel most often pairs — a `table` node (the
 * span table) and an `eventLog` node — over the same three records, through
 * the real host and the real views, and select from each of the three places a
 * reader can: an evidence chip, a log line and a table row.
 *
 * The suite's shared stub answers the metric view only, so these cases build
 * their own resolver for the two sources the tables read. The records are the
 * ones the summary's citations name, with the first citation's trace and span.
 * ---------------------------------------------------------------------------
 */

/** The span table's title, which is also its grid's accessible name. */
const CROSS_VIEW_TABLE_TITLE = 'Spans under test';

/** The event log's title, which is also its grid's accessible name. */
const CROSS_VIEW_LOG_TITLE = 'Records under test';

/** A second span of the citations' trace: 16 lower-case hex digits. */
const SECOND_SPAN_ID = '00f067aa0ba902b8';

/** A third span of that trace. */
const CAUSE_SPAN_ID = '00f067aa0ba902b9';

/**
 * One captured record, as the service returns it for `spans` and `events`.
 *
 * @param overrides The identity, name, start and duration of the record.
 * @returns A fresh record.
 */
function makeCrossViewEvent(overrides: {
  readonly id: string;
  readonly spanId: string;
  readonly name: string;
  readonly startOffset: number;
  readonly duration: number;
  readonly seq: number;
}): TelemetryEvent {
  return {
    id: overrides.id,
    traceId: CITATION_TRACE_ID,
    spanId: overrides.spanId,
    kind: 'function',
    name: overrides.name,
    startTime: 1_767_225_600_000 + overrides.startOffset,
    duration: overrides.duration,
    tier: 'server',
    attributes: {},
    status: 'ok',
    producerId: 'producer-under-test',
    seq: overrides.seq,
    sessionId: SESSION_ID,
    captureId: 'capture-under-test',
    ingestSeq: overrides.seq + 1,
  };
}

/** The records both tables draw: the three the summary's citations name. */
const CROSS_VIEW_EVENTS: readonly TelemetryEvent[] = [
  makeCrossViewEvent({
    id: FIRST_EVENT_ID,
    spanId: CITATION_SPAN_ID,
    name: 'example.alpha',
    startOffset: 0,
    duration: 120,
    seq: 0,
  }),
  makeCrossViewEvent({
    id: SECOND_EVENT_ID,
    spanId: SECOND_SPAN_ID,
    name: 'example.beta',
    startOffset: 8,
    duration: 60,
    seq: 1,
  }),
  makeCrossViewEvent({
    id: CAUSE_EVENT_ID,
    spanId: CAUSE_SPAN_ID,
    name: 'example.gamma',
    startOffset: 16,
    duration: 30,
    seq: 2,
  }),
];

/** The record names, as the row queries below match them. */
const ALPHA_ROW = /example\.alpha/;
const BETA_ROW = /example\.beta/;
const GAMMA_ROW = /example\.gamma/;

/**
 * A provider answering the two record sources the tables read, with the same
 * records, and rejecting any other source as the shared stub does.
 *
 * @returns The provider and its recorded resolver.
 */
function makeCrossViewProvider(): StubProvider {
  const resolve = vi.fn<DataQueryResolver>((query) => {
    if (query.source === 'spans') {
      return Promise.resolve<DataQueryResponse>({
        source: 'spans',
        data: CROSS_VIEW_EVENTS,
        total: CROSS_VIEW_EVENTS.length,
      });
    }

    if (query.source === 'events') {
      return Promise.resolve<DataQueryResponse>({
        source: 'events',
        data: CROSS_VIEW_EVENTS,
        total: CROSS_VIEW_EVENTS.length,
      });
    }

    return Promise.reject(
      new DebuggenError(
        'NOT_IMPLEMENTED',
        `This case's stub provider answers no "${query.source}" query.`,
      ),
    );
  });

  return { provider: createDataProvider(resolve), resolve };
}

/**
 * A panel of the span table and the event log, over the default summary.
 *
 * @returns The specification.
 */
function makeCrossViewSpec(): PanelSpec {
  return makeSpec({
    layout: [
      {
        type: 'table',
        id: 'layout.0',
        title: CROSS_VIEW_TABLE_TITLE,
        query: { source: 'spans', sort: 'duration_desc', limit: DATA_QUERY_DEFAULT_LIMIT },
      },
      {
        type: 'eventLog',
        id: 'layout.1',
        title: CROSS_VIEW_LOG_TITLE,
        query: { source: 'events', sort: 'start_asc', limit: DATA_QUERY_DEFAULT_LIMIT },
      },
    ],
  });
}

/** The two grids, once both have drawn their rows. */
interface CrossViewGrids {
  /** The span table's grid. */
  readonly table: HTMLElement;

  /** The event log's grid. */
  readonly log: HTMLElement;
}

/**
 * Mounts {@link makeCrossViewSpec} in the real host and waits for both grids.
 *
 * @returns The two grids and the host-form spies.
 */
async function renderCrossViewPanel(): Promise<CrossViewGrids & { readonly actions: ActionSpies }> {
  const actions = makeActions();

  render(
    <PanelHost
      spec={makeCrossViewSpec()}
      dataProvider={makeCrossViewProvider().provider}
      actions={actions.actions}
    />,
  );

  const table = await screen.findByRole('grid', { name: CROSS_VIEW_TABLE_TITLE });
  const log = await screen.findByRole('grid', { name: CROSS_VIEW_LOG_TITLE });
  await within(table).findByRole('row', { name: ALPHA_ROW });
  await within(log).findByRole('row', { name: ALPHA_ROW });

  return { table, log, actions };
}

/**
 * Which record rows of a grid report themselves selected.
 *
 * @param grid The grid.
 * @returns For each record name, the row's `aria-selected`.
 */
function selectedStates(grid: HTMLElement): readonly (string | null)[] {
  return [ALPHA_ROW, BETA_ROW, GAMMA_ROW].map((name) =>
    within(grid).getByRole('row', { name }).getAttribute('aria-selected'),
  );
}

describe('PanelHost cross-view selection', () => {
  it("selects the cited event's rows in every table when its evidence chip is clicked", async () => {
    const { table, log, actions } = await renderCrossViewPanel();

    // Nothing is selected yet, and both tables say so rather than saying nothing.
    expect(selectedStates(table)).toEqual(['false', 'false', 'false']);
    expect(selectedStates(log)).toEqual(['false', 'false', 'false']);

    await clickByName(FIRST_CITATION_LABEL, observedRegion());

    // The surface hears the chip exactly as before...
    expect(actions.selectEvent).toHaveBeenCalledWith(FIRST_EVENT_ID, {
      traceId: CITATION_TRACE_ID,
      spanId: CITATION_SPAN_ID,
    });

    // ...and the event it cites is selected in both tables, marked by attribute
    // and by the grid's own selected state.
    await waitFor(() => {
      expect(selectedStates(table)).toEqual(['true', 'false', 'false']);
    });
    expect(selectedStates(log)).toEqual(['true', 'false', 'false']);
    expect(
      within(table).getByRole('row', { name: ALPHA_ROW }).classList.contains('dg-is-selected'),
    ).toBe(true);
    expect(
      within(log).getByRole('row', { name: ALPHA_ROW }).classList.contains('dg-is-selected'),
    ).toBe(true);
  });

  it('marks the span-table row for a record selected in the event log', async () => {
    const { table, log, actions } = await renderCrossViewPanel();
    const user = userEvent.setup();

    await user.click(within(log).getByRole('row', { name: BETA_ROW }));

    expect(actions.selectEvent).toHaveBeenCalledWith(SECOND_EVENT_ID, {
      traceId: CITATION_TRACE_ID,
      spanId: SECOND_SPAN_ID,
    });
    await waitFor(() => {
      expect(selectedStates(table)).toEqual(['false', 'true', 'false']);
    });
    expect(selectedStates(log)).toEqual(['false', 'true', 'false']);
  });

  it('marks the event-log line for a row selected in the span table, and moves every mark', async () => {
    const { table, log } = await renderCrossViewPanel();
    const user = userEvent.setup();

    await clickByName(FIRST_CITATION_LABEL, observedRegion());
    await waitFor(() => {
      expect(selectedStates(log)).toEqual(['true', 'false', 'false']);
    });

    await user.click(within(table).getByRole('row', { name: GAMMA_ROW }));

    // One selection for the panel: the chip's is replaced in both tables.
    await waitFor(() => {
      expect(selectedStates(log)).toEqual(['false', 'false', 'true']);
    });
    expect(selectedStates(table)).toEqual(['false', 'false', 'true']);
  });

  it('marks the rows of an event the surface drives', async () => {
    const actions = makeActions();
    const provider = makeCrossViewProvider();
    const spec = makeCrossViewSpec();
    const draw = (selectedEventId: string | null): ReactElement => (
      <PanelHost
        spec={spec}
        dataProvider={provider.provider}
        actions={actions.actions}
        selectedEventId={selectedEventId}
      />
    );

    const view = render(draw(CAUSE_EVENT_ID));
    const table = await screen.findByRole('grid', { name: CROSS_VIEW_TABLE_TITLE });
    const log = await screen.findByRole('grid', { name: CROSS_VIEW_LOG_TITLE });
    await within(log).findByRole('row', { name: GAMMA_ROW });

    expect(selectedStates(table)).toEqual(['false', 'false', 'true']);
    expect(selectedStates(log)).toEqual(['false', 'false', 'true']);

    // A cleared drawer clears every mark.
    view.rerender(draw(null));
    expect(selectedStates(table)).toEqual(['false', 'false', 'false']);
    expect(selectedStates(log)).toEqual(['false', 'false', 'false']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Cross-view selection between the charts and the tables
 *
 * The same one-selection rule, drawn through the real host across views of
 * different shapes: the timeline's canvas and grid, the waterfall's tree and
 * the span table's grid, over the same three calls of one interaction. A
 * selection made in any of them is the panel's, so every other one marks the
 * same call and none keeps a contradicting mark of its own.
 * ---------------------------------------------------------------------------
 */

/** The span table's title in the chart panel. */
const CHART_PANEL_TABLE_TITLE = 'Calls under test';

/** The three calls: a browser request, the server request and its statement. */
const CHART_PANEL_EVENTS: readonly TelemetryEvent[] = [
  {
    ...makeCrossViewEvent({
      id: FIRST_EVENT_ID,
      spanId: CITATION_SPAN_ID,
      name: 'example.alpha',
      startOffset: 0,
      duration: 120,
      seq: 0,
    }),
    kind: 'fetch',
    tier: 'browser',
  },
  {
    ...makeCrossViewEvent({
      id: SECOND_EVENT_ID,
      spanId: SECOND_SPAN_ID,
      name: 'example.beta',
      startOffset: 8,
      duration: 60,
      seq: 1,
    }),
    kind: 'http.server',
    tier: 'server',
  },
  {
    ...makeCrossViewEvent({
      id: CAUSE_EVENT_ID,
      spanId: CAUSE_SPAN_ID,
      name: 'example.gamma',
      startOffset: 16,
      duration: 30,
      seq: 2,
    }),
    kind: 'db.query',
    tier: 'db',
  },
];

/** The three call names, in the order the cases read their marks. */
const CHART_PANEL_NAMES = ['example.alpha', 'example.beta', 'example.gamma'] as const;

/**
 * A provider answering `spans` with the three calls, and rejecting any other
 * source as the shared stub does.
 *
 * @returns The provider.
 */
function makeChartPanelProvider(): DataProvider {
  return createDataProvider((query) =>
    query.source === 'spans'
      ? Promise.resolve<DataQueryResponse>({
          source: 'spans',
          data: CHART_PANEL_EVENTS,
          total: CHART_PANEL_EVENTS.length,
        })
      : Promise.reject(
          new DebuggenError(
            'NOT_IMPLEMENTED',
            `This case's stub provider answers no "${query.source}" query.`,
          ),
        ),
  );
}

/**
 * The block a view renders into, by its documented class.
 *
 * @param className The view's block class.
 * @returns That block.
 */
function viewBlock(className: string): HTMLElement {
  const block = document.querySelector<HTMLElement>(`.${className}`);
  if (block === null) {
    throw new Error(`no .${className} block is rendered`);
  }
  return block;
}

/**
 * For each call, whether the timeline's bar, the waterfall's row and the span
 * table's row mark it selected — each read from that view's own element, and
 * each failing when the attribute and the class disagree where a view writes
 * both.
 *
 * @returns One `[timeline, waterfall, table]` triple per call.
 */
function chartPanelMarks(): readonly (readonly [boolean, boolean, boolean])[] {
  const bars = Array.from(
    viewBlock('dg-timeline').querySelectorAll<SVGElement>('rect.dg-timeline__bar'),
  );
  const table = screen.getByRole('grid', { name: CHART_PANEL_TABLE_TITLE });

  return CHART_PANEL_NAMES.map((name) => {
    const bar = bars.find((candidate) =>
      (candidate.querySelector('title')?.textContent ?? '').startsWith(`${name} `),
    );
    const treeitem = within(viewBlock('dg-waterfall'))
      .getByText(name)
      .closest<HTMLElement>('[role="treeitem"]');
    const row = within(table).getByRole('row', { name: new RegExp(name.replace('.', '\\.')) });

    if (bar === undefined || treeitem === null) {
      throw new Error(`the charts do not both draw "${name}"`);
    }

    const waterfallMarked = treeitem.getAttribute('aria-selected') === 'true';
    expect(treeitem.classList.contains('dg-is-selected')).toBe(waterfallMarked);
    const tableMarked = row.getAttribute('aria-selected') === 'true';
    expect(row.classList.contains('dg-is-selected')).toBe(tableMarked);

    return [bar.classList.contains('dg-is-selected'), waterfallMarked, tableMarked] as const;
  });
}

describe('PanelHost cross-view selection between charts and tables', () => {
  it('marks one call in the timeline, the waterfall and the span table, wherever it was selected', async () => {
    const actions = makeActions();
    const user = userEvent.setup();

    render(
      <PanelHost
        spec={makeSpec({
          layout: [
            { type: 'timeline', id: 'layout.0', query: { source: 'spans' } },
            { type: 'waterfall', id: 'layout.1', query: { source: 'spans' } },
            {
              type: 'table',
              id: 'layout.2',
              title: CHART_PANEL_TABLE_TITLE,
              query: { source: 'spans', sort: 'start_asc', limit: DATA_QUERY_DEFAULT_LIMIT },
            },
          ],
        })}
        dataProvider={makeChartPanelProvider()}
        actions={actions.actions}
      />,
    );

    const table = await screen.findByRole('grid', { name: CHART_PANEL_TABLE_TITLE });
    await within(table).findByRole('row', { name: /example\.gamma/ });
    await within(viewBlock('dg-waterfall')).findByText('example.gamma');
    await waitFor(() => {
      expect(viewBlock('dg-timeline').querySelectorAll('rect.dg-timeline__bar')).toHaveLength(3);
    });

    const none = [false, false, false] as const;
    const all = [true, true, true] as const;
    expect(chartPanelMarks()).toEqual([none, none, none]);

    // A waterfall row: the timeline's bar and the table's row follow it.
    const statementRow = within(viewBlock('dg-waterfall'))
      .getByText('example.gamma')
      .closest<HTMLElement>('[role="treeitem"]');
    if (statementRow === null) {
      throw new Error('the waterfall draws no row for the statement');
    }
    await user.click(statementRow);

    expect(actions.selectEvent).toHaveBeenCalledTimes(1);
    expect(actions.selectEvent).toHaveBeenLastCalledWith(CAUSE_EVENT_ID, {
      traceId: CITATION_TRACE_ID,
      spanId: CAUSE_SPAN_ID,
    });
    await waitFor(() => {
      expect(chartPanelMarks()).toEqual([none, none, all]);
    });

    // A table row: the mark moves in every view at once, and no view keeps the
    // previous one.
    await user.click(within(table).getByRole('row', { name: /example\.beta/ }));

    expect(actions.selectEvent).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(chartPanelMarks()).toEqual([none, all, none]);
    });

    // An evidence chip citing the first call moves it again.
    await clickByName(FIRST_CITATION_LABEL, observedRegion());

    await waitFor(() => {
      expect(chartPanelMarks()).toEqual([all, none, none]);
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * The failure contract: one error state, one wording, no foreign text, one
 * alert per burst
 * ---------------------------------------------------------------------------
 */

describe('the failure contract every query-backed node renders', () => {
  /** The accessible name of the query block when its caller names it nothing else. */
  const FAILING_QUERY_NAME = 'Failing query';

  /** The summary of the technical-details disclosure, and the name of its block. */
  const DETAILS_NAME = 'Technical details';

  /** The generic lead every failed view's message opens with. */
  const VIEW_LEAD = 'The data for this view could not be loaded.';

  /** The generic lead every failed next page's message opens with. */
  const PAGE_LEAD =
    'The next page of this view could not be loaded. The rows already shown are unaffected.';

  /** The renderer's fixed sentence for a rejection that says nothing usable about itself. */
  const GENERIC_CAUSE = "The request for this view's data failed.";

  /** The renderer's fixed sentence for a rejection carrying HTTP 503. */
  const HTTP_503_CAUSE = "The request for this view's data failed with HTTP 503.";

  /** The renderer's fixed sentence for a transport timeout. */
  const TIMEOUT_CAUSE = "The connection carrying this view's data failed (TimeoutError).";

  /** The product-wide marker an unpresentable detail value is replaced with. */
  const REDACTED = '[redacted]';

  /** A private absolute path, of the kind an `ENOENT` message or a stack carries. */
  const PRIVATE_PATH = '/Users/dev/app/.env';

  /** An upper-case statement with a positional parameter, as a driver error quotes it. */
  const PRIVATE_STATEMENT = 'SELECT password_hash FROM accounts WHERE id = $1';

  /**
   * A provider key and a bearer credential, in the shapes the redaction layer
   * recognises. Assembled from fragments at run time so that no tracked file
   * holds a contiguous credential for the repository's secret scan to find.
   */
  const PROVIDER_KEY_SHAPE = ['sk', 'ant', 'api03', 'Qx7Lm2Pz'.repeat(3)].join('-');
  const BEARER_TOKEN_BODY = 'Rt5Vw8Yz'.repeat(2);

  /** A rejection message carrying every kind of private text at once. */
  const PRIVATE_MESSAGE = `${PRIVATE_PATH}: ENOENT while running ${PRIVATE_STATEMENT} with ${PROVIDER_KEY_SHAPE} and Bearer ${BEARER_TOKEN_BODY}`;

  /** A lower-case statement with an inline literal, as a driver error quotes it. */
  const PRIVATE_LOWER_STATEMENT = "select password_hash from accounts where id = 'alice'";

  /** A short password, which no value pattern can recognise on its own. */
  const SHORT_PASSWORD = 'hunter2';

  /**
   * Substrings of {@link PRIVATE_MESSAGE}, {@link PRIVATE_LOWER_STATEMENT} and
   * {@link SHORT_PASSWORD}, none of which may reach the screen.
   */
  const PRIVATE_FRAGMENTS: readonly string[] = [
    PRIVATE_PATH,
    'Users/dev',
    PRIVATE_STATEMENT,
    'password_hash',
    PROVIDER_KEY_SHAPE,
    BEARER_TOKEN_BODY,
    'ENOENT',
    PRIVATE_LOWER_STATEMENT,
    "'alice'",
    SHORT_PASSWORD,
  ];

  /**
   * Words that belong to whoever integrated a host, never to the reader of a
   * panel: a factory, a context, an argument name, the provider abstraction.
   */
  const INTEGRATION_VOCABULARY =
    /createPanelDataProvider|createDataProvider|DataProviderContext|PanelSessionContext|sessionId|data provider/iu;

  /** What {@link FailureProbe} resolves, and the name of the region it draws into. */
  interface FailureProbeProps {
    /** The accessible name of the probe's region. */
    readonly label: string;
    /** The query the probe hands the hook, unmodified. */
    readonly query: DataQuery;
  }

  /**
   * The smallest query-backed node: it resolves its query and, on failure,
   * spreads the composed failure props onto the error state — exactly the
   * call a catalogued view makes in its error branch. A probe rather than a
   * catalogued view, because these cases pin the contract itself — hook,
   * helpers and primitive — independent of any one component's call site.
   *
   * Anything but a failure is printed as a paragraph, which has no live-region
   * role, so every `alert` and `status` on screen is an error state.
   *
   * @param props See {@link FailureProbeProps}.
   * @returns The probe's labelled region.
   */
  function FailureProbe(props: FailureProbeProps): ReactElement {
    const { label, query } = props;
    const result = useQuery(query);

    return (
      <section aria-label={label}>
        {result.status === 'error' ? (
          <ErrorState {...queryFailureProps(result, query)} />
        ) : (
          <p>{result.status}</p>
        )}
      </section>
    );
  }

  /** What {@link FailureProbes} mounts. */
  interface FailureProbesProps {
    /** The provider in context, or `undefined` for a host that provides none. */
    readonly provider: DataProvider | undefined;
    /** The session in context. */
    readonly sessionId: string;
    /** The probes to mount, keyed by label. */
    readonly probes: readonly FailureProbeProps[];
  }

  /**
   * Several probes under one provider and one session, as a panel's nodes are.
   *
   * @param props See {@link FailureProbesProps}.
   * @returns The probes inside both contexts.
   */
  function FailureProbes(props: FailureProbesProps): ReactElement {
    return (
      <DataProviderContext.Provider value={props.provider}>
        <PanelSessionContext.Provider value={props.sessionId}>
          {props.probes.map((probe) => (
            <FailureProbe key={probe.label} label={probe.label} query={probe.query} />
          ))}
        </PanelSessionContext.Provider>
      </DataProviderContext.Provider>
    );
  }

  /**
   * A provider whose every call is rejected with a fresh cause.
   *
   * @param makeCause Builds the rejection reason for one call.
   * @returns The provider and its recorded resolver.
   */
  function makeRejectingProvider(makeCause: () => Error): StubProvider {
    const resolve = vi.fn<DataQueryResolver>(() => Promise.reject(makeCause()));

    return { provider: createDataProvider(resolve), resolve };
  }

  /**
   * A provider whose every call fails with a fresh value of any kind — a
   * string, an error-shaped object — as a hand-written provider may. The
   * resolver throws, and the factory's `async` query turns the throw into the
   * rejection the hook receives, unchanged.
   *
   * @param makeCause Builds the thrown value for one call.
   * @returns The provider and its recorded resolver.
   */
  function makeThrowingProvider(makeCause: () => unknown): StubProvider {
    const resolve = vi.fn<DataQueryResolver>(() => {
      throw makeCause();
    });

    return { provider: createDataProvider(resolve), resolve };
  }

  /**
   * The error state inside one probe's region, once it has settled.
   *
   * @param label The probe's region name.
   * @returns The error state's container, whichever live-region role it took.
   */
  async function settledFailure(label: string): Promise<HTMLElement> {
    const region = screen.getByRole('region', { name: label });
    const retryControl = await within(region).findByRole('button', { name: RETRY_PATTERN });
    const failure = retryControl.closest<HTMLElement>('[role="alert"], [role="status"]');
    if (failure === null) {
      throw new Error(`the "${label}" probe drew a retry outside any live region`);
    }

    return failure;
  }

  it('serialises a query in one canonical, pretty-printed form', () => {
    const query: DataQuery = {
      offset: 20,
      limit: 10,
      sort: 'duration_desc',
      filter: {
        tier: 'server',
        minDuration: 5,
        kinds: ['fetch', 'db.query'],
        component: undefined,
      },
      source: 'spans',
    };

    // Member order source, filter, sort, limit, offset; filter keys sorted;
    // the undefined member gone; array order kept; two-space indent.
    expect(formatDataQuery(query)).toBe(
      [
        '{',
        '  "source": "spans",',
        '  "filter": {',
        '    "kinds": [',
        '      "fetch",',
        '      "db.query"',
        '    ],',
        '    "minDuration": 5,',
        '    "tier": "server"',
        '  },',
        '  "sort": "duration_desc",',
        '  "limit": 10,',
        '  "offset": 20',
        '}',
      ].join('\n'),
    );

    // The same request assembled in another order prints the same text, and
    // the text is still the query a reader can parse back.
    expect(
      formatDataQuery({
        source: 'spans',
        filter: { kinds: ['fetch', 'db.query'], minDuration: 5, tier: 'server' },
        sort: 'duration_desc',
        limit: 10,
        offset: 20,
      }),
    ).toBe(formatDataQuery(query));
    expect(JSON.parse(formatDataQuery(query))).toEqual({
      source: 'spans',
      filter: { kinds: ['fetch', 'db.query'], minDuration: 5, tier: 'server' },
      sort: 'duration_desc',
      limit: 10,
      offset: 20,
    });
    expect(formatDataQuery({ source: 'metrics' })).toBe('{\n  "source": "metrics"\n}');
  });

  it('composes a failed view as the generic lead, the cause, the hint and the details', () => {
    const retry = vi.fn<() => void>();
    const error = new DebuggenError(
      PROVIDER_FAILURE_CODE,
      '  The transport closed before the page arrived  ',
      { hint: 'Reconnect, then retry.', details: { attempt: 2 } },
    );

    expect(
      queryFailureProps({ error, announcement: 'polite', retry }, { source: 'metrics' }),
    ).toEqual({
      title: QUERY_FAILURE_TITLE,
      message: `${VIEW_LEAD} The transport closed before the page arrived.`,
      hint: 'Reconnect, then retry.',
      code: PROVIDER_FAILURE_CODE,
      query: formatDataQuery({ source: 'metrics' }),
      details: JSON.stringify({ attempt: 2 }, null, 2),
      announce: 'polite',
      onRetry: retry,
    });
  });

  it('titles a failed next page as a page, and keeps a cause that is already a sentence', () => {
    const retry = vi.fn<() => void>();
    const error = new DebuggenError(PROVIDER_FAILURE_CODE, 'Nothing arrived in time!');

    const props = queryFailureProps(
      { error, announcement: undefined, retry },
      { source: 'renders', offset: 50 },
      { scope: 'page' },
    );

    expect(props.title).toBe(PAGE_FAILURE_TITLE);
    expect(props.message).toBe(`${PAGE_LEAD} Nothing arrived in time!`);
    expect(props.hint).toBeUndefined();
    expect(props.details).toBeUndefined();
    expect(props.announce).toBe('assertive');
  });

  it('composes the lead alone, with the INTERNAL code, when no cause is known', () => {
    const props = queryFailureProps(
      { error: undefined, announcement: undefined, retry: vi.fn<() => void>() },
      { source: 'events' },
    );

    expect(props.message).toBe(VIEW_LEAD);
    expect(props.code).toBe('INTERNAL');
    expect(props.hint).toBeUndefined();
    expect(props.details).toBeUndefined();
  });

  it("words an unsupported query from the node catalog's label and sources", () => {
    const renders = unsupportedQueryProps('renderTable', { source: 'spans' });
    expect(renders).toEqual({
      title: UNSUPPORTED_QUERY_TITLE,
      message: `The ${catalogEntryFor('renderTable').label} view reads "renders" data, but this panel asks it for "spans".`,
      code: 'PANEL_INVALID',
      query: formatDataQuery({ source: 'spans' }),
    });

    // Two sources read as alternatives, in the catalog's own order.
    expect(unsupportedQueryProps('timeline', { source: 'events' }).message).toBe(
      `The ${catalogEntryFor('timeline').label} view reads "trace" or "spans" data, but this panel asks it for "events".`,
    );
  });

  it('draws the whole contract, in order, with the details closed', () => {
    const onRetry = vi.fn<() => void>();
    const details = JSON.stringify({ attempt: 2, remedy: 'An integration step.' }, null, 2);

    render(
      <ErrorState
        title="A failure title"
        message="A failure message."
        hint="A failure hint."
        code={PROVIDER_FAILURE_CODE}
        query={formatDataQuery({ source: 'metrics' })}
        details={details}
        onRetry={onRetry}
      />,
    );

    const alert = screen.getByRole('alert');

    // The default glyph, decorative and out of the accessibility tree.
    const glyphBox = alert.querySelector('.dg-error-state__icon');
    expect(glyphBox?.getAttribute('aria-hidden')).toBe('true');
    expect(glyphBox?.querySelector('svg')).not.toBeNull();

    // The hint is its own line, in the message's register.
    expect(within(alert).getByText('A failure hint.').tagName).toBe('P');
    expect(alert.querySelectorAll('.dg-error-state__message')).toHaveLength(2);

    // The query block keeps its default name; the details sit in a closed
    // native disclosure, behind a summary a keyboard can toggle.
    within(alert).getByRole('group', { name: FAILING_QUERY_NAME });
    const summary = within(alert).getByText(DETAILS_NAME).closest('summary');
    const disclosure = summary?.closest('details');
    expect(disclosure?.open).toBe(false);
    const detailsBlock = within(alert).getByRole('group', { name: DETAILS_NAME, hidden: true });
    expect(detailsBlock.closest('details')).toBe(disclosure);
    expect(detailsBlock.textContent).toBe(details);

    // Glyph, title, message, hint, code, query, details, action.
    const text = alert.textContent ?? '';
    const positions = [
      'A failure title',
      'A failure message.',
      'A failure hint.',
      PROVIDER_FAILURE_CODE,
      '"source": "metrics"',
      DETAILS_NAME,
      'Retry',
    ].map((part) => text.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);

    // The retry control carries the focus key a remounting frame recognises.
    const retryControl = within(alert).getByRole('button', { name: RETRY_PATTERN });
    expect(FOCUS_KEY_ATTRIBUTE).toBe('data-dg-focus-key');
    expect(ERROR_STATE_RETRY_FOCUS_KEY).toBe('error-state-retry');
    expect(retryControl.getAttribute(FOCUS_KEY_ATTRIBUTE)).toBe(ERROR_STATE_RETRY_FOCUS_KEY);
  });

  it('names the query block as asked, announces politely on request, and drops the glyph on null', () => {
    render(
      <ErrorState
        message="A failure message."
        query='{ "type": "unknownNode" }'
        queryLabel="Node definition"
        announce="polite"
        icon={null}
        hint="   "
      />,
    );

    const status = screen.getByRole('status');
    expect(screen.queryByRole('alert')).toBeNull();
    within(status).getByRole('group', { name: 'Node definition' });
    expect(within(status).queryByRole('group', { name: FAILING_QUERY_NAME })).toBeNull();
    expect(status.querySelector('.dg-error-state__icon')).toBeNull();

    // A blank hint draws no line, and no retry is offered without a callback.
    expect(status.querySelectorAll('.dg-error-state__message')).toHaveLength(1);
    expect(within(status).queryByRole('button')).toBeNull();
  });

  it('falls back to the default query name for a blank label', () => {
    render(<ErrorState message="A failure message." query="{}" queryLabel="  " />);

    within(screen.getByRole('alert')).getByRole('group', { name: FAILING_QUERY_NAME });
  });

  it.each([
    { label: 'Loading captured calls', announced: 'Loading captured calls…' },
    { label: 'Loading captured calls...', announced: 'Loading captured calls…' },
    { label: 'Loading captured calls.', announced: 'Loading captured calls…' },
    { label: 'Loading captured calls…', announced: 'Loading captured calls…' },
    { label: '  Loading requests  ', announced: 'Loading requests…' },
    { label: '', announced: 'Loading…' },
    { label: '   ', announced: 'Loading…' },
    { label: '...', announced: 'Loading…' },
    { label: '…', announced: 'Loading…' },
    { label: undefined, announced: 'Loading…' },
  ])('announces the loading label $label as $announced', ({ label, announced }) => {
    render(<LoadingState label={label} />);

    expect(screen.getByRole('status').textContent).toBe(announced);
  });

  /** One rejection a provider may raise, and the code a node must report it with. */
  interface RejectionCase {
    /** What the rejection is, for the case title. */
    readonly name: string;
    /** Builds the rejection. */
    readonly cause: () => Error;
    /** The code the error state shows. */
    readonly code: string;
  }

  const REJECTIONS: readonly RejectionCase[] = [
    {
      name: 'an HTTP 503',
      cause: () => Object.assign(new Error('Service Unavailable'), { status: 503 }),
      code: 'TRANSPORT_DISCONNECTED',
    },
    {
      name: 'an HTTP 404 on statusCode',
      cause: () => Object.assign(new Error('Not Found'), { statusCode: 404 }),
      code: 'SESSION_NOT_FOUND',
    },
    {
      name: 'an HTTP 401 on the attached response',
      cause: () => Object.assign(new Error(''), { response: { status: 401 } }),
      code: 'UNAUTHORIZED',
    },
    {
      name: 'an HTTP 500',
      cause: () => Object.assign(new Error('Server Error'), { status: 500 }),
      code: 'INTERNAL',
    },
    {
      name: 'an HTTP 400',
      cause: () => Object.assign(new Error('Bad Request'), { status: 400 }),
      code: 'PROTOCOL_INVALID_MESSAGE',
    },
    {
      name: 'a timeout',
      cause: () => Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }),
      code: 'TRANSPORT_DISCONNECTED',
    },
    {
      name: 'a plain error',
      cause: () => new Error('Something unexplained happened.'),
      code: 'INTERNAL',
    },
    {
      name: 'a typed error that also carries a status',
      cause: () =>
        Object.assign(new DebuggenError('RATE_LIMITED', 'Too many requests.'), { status: 503 }),
      code: 'RATE_LIMITED',
    },
  ];

  it.each(REJECTIONS)('reports $name with the code $code', async ({ cause, code }) => {
    const { provider } = makeRejectingProvider(cause);

    render(
      <FailureProbes
        provider={provider}
        sessionId={SESSION_ID}
        probes={[{ label: 'rejected view', query: { source: 'metrics' } }]}
      />,
    );

    const failure = await settledFailure('rejected view');
    within(failure).getByText(code);
  });

  it('shows an HTTP status in the technical details, and no INTERNAL code, through a real view', async () => {
    const { provider } = makeRejectingProvider(() =>
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
    );

    render(<PanelHost spec={makeSpec()} dataProvider={provider} actions={makeActions().actions} />);

    const stack = screen.getByRole('region', { name: STACK_TITLE });
    const alert = await within(stack).findByRole('alert');
    expect(alert.textContent).toContain('TRANSPORT_DISCONNECTED');
    expect(alert.textContent).not.toContain('INTERNAL');

    cleanup();

    render(
      <FailureProbes
        provider={provider}
        sessionId={SESSION_ID}
        probes={[{ label: 'unavailable view', query: { source: 'metrics' } }]}
      />,
    );

    const failure = await settledFailure('unavailable view');
    expect(within(failure).getByText(`${VIEW_LEAD} ${HTTP_503_CAUSE}`).tagName).toBe('P');
    expect(failure.textContent).not.toContain('Service Unavailable');
    const detailsBlock = within(failure).getByRole('group', { name: DETAILS_NAME, hidden: true });
    expect(JSON.parse(detailsBlock.textContent ?? '')).toEqual({ status: 503 });
  });

  /** One hostile value a provider may fail with, and what its error state must show. */
  interface HostileRejectionCase {
    /** What the value is, for the case title. */
    readonly name: string;
    /** Builds the value the provider fails with. */
    readonly cause: () => unknown;
    /** The code the error state shows. */
    readonly code: string;
    /** The whole message line: the lead, and at most the renderer's fixed sentence. */
    readonly message: string;
    /** The technical details, parsed, or `undefined` for no details block. */
    readonly details: Readonly<Record<string, unknown>> | undefined;
  }

  const HOSTILE_REJECTIONS: readonly HostileRejectionCase[] = [
    {
      name: 'a plain error quoting a path, a statement and two credentials',
      cause: () => new Error(PRIVATE_MESSAGE),
      code: 'INTERNAL',
      message: `${VIEW_LEAD} ${GENERIC_CAUSE}`,
      details: { errorName: 'Error' },
    },
    {
      name: 'an HTTP 503 whose message is a private path',
      cause: () => Object.assign(new Error(PRIVATE_MESSAGE), { status: 503 }),
      code: 'TRANSPORT_DISCONNECTED',
      message: `${VIEW_LEAD} ${HTTP_503_CAUSE}`,
      details: { status: 503 },
    },
    {
      name: 'a timeout whose message is a private path',
      cause: () => Object.assign(new Error(PRIVATE_MESSAGE), { name: 'TimeoutError' }),
      code: 'TRANSPORT_DISCONNECTED',
      message: `${VIEW_LEAD} ${TIMEOUT_CAUSE}`,
      details: { name: 'TimeoutError' },
    },
    {
      name: 'a bare string',
      cause: () => PRIVATE_MESSAGE,
      code: 'INTERNAL',
      message: `${VIEW_LEAD} ${GENERIC_CAUSE}`,
      details: undefined,
    },
    {
      name: 'a typed error the provider copied from a plain exception',
      cause: () => DebuggenError.from(new Error(`${PRIVATE_PATH}: ENOENT`), 'STORE_ERROR'),
      code: 'STORE_ERROR',
      message: VIEW_LEAD,
      details: undefined,
    },
    {
      name: 'an error-shaped object claiming the typed brand',
      cause: () => ({
        __isDebuggenError__: true,
        name: 'DebuggenError',
        code: 'STORE_ERROR',
        message: PRIVATE_MESSAGE,
        hint: `Open ${PRIVATE_PATH} and retry.`,
      }),
      code: 'STORE_ERROR',
      message: VIEW_LEAD,
      details: undefined,
    },
    {
      name: 'a typed error embedding a lower-case statement it keeps as its cause',
      cause: () => {
        const raw = new Error(PRIVATE_LOWER_STATEMENT);
        return new DebuggenError('STORE_ERROR', `Query failed: ${raw.message}`, {
          hint: 'Retry in a moment.',
          cause: raw,
        });
      },
      code: 'STORE_ERROR',
      message: VIEW_LEAD,
      details: undefined,
    },
    {
      name: 'a typed error embedding a lower-case statement with no cause',
      cause: () => new DebuggenError('STORE_ERROR', `Query failed: ${PRIVATE_LOWER_STATEMENT}`),
      code: 'STORE_ERROR',
      message: VIEW_LEAD,
      details: undefined,
    },
    {
      name: 'a typed error with a short password under credential-named and unvouched details',
      cause: () =>
        new DebuggenError('STORE_ERROR', 'The store refused the read.', {
          details: { password: SHORT_PASSWORD, note: SHORT_PASSWORD, attempts: 2 },
        }),
      code: 'STORE_ERROR',
      message: `${VIEW_LEAD} The store refused the read.`,
      details: { password: REDACTED, note: REDACTED, attempts: 2 },
    },
  ];

  it.each(HOSTILE_REJECTIONS)(
    'shows none of the text of $name',
    async ({ cause, code, message, details }) => {
      const { provider } = makeThrowingProvider(cause);

      render(
        <FailureProbes
          provider={provider}
          sessionId={SESSION_ID}
          probes={[{ label: 'hostile view', query: { source: 'metrics' } }]}
        />,
      );

      const failure = await settledFailure('hostile view');

      // The code survives; the message is the lead and, at most, the
      // renderer's own sentence; no hint line is drawn from foreign text.
      within(failure).getByText(code);
      const lines = Array.from(failure.querySelectorAll('.dg-error-state__message'));
      expect(lines.map((line) => line.textContent)).toEqual([message]);

      const detailsBlock = within(failure).queryByRole('group', {
        name: DETAILS_NAME,
        hidden: true,
      });
      if (details === undefined) {
        expect(detailsBlock).toBeNull();
      } else {
        expect(JSON.parse(detailsBlock?.textContent ?? '')).toEqual(details);
      }

      const shown = failure.textContent ?? '';
      for (const fragment of PRIVATE_FRAGMENTS) {
        expect(shown).not.toContain(fragment);
      }
    },
  );

  it("withholds the message and hint of an error whose text is a foreign value's", () => {
    const retry = vi.fn<() => void>();
    const copied = DebuggenError.from(new Error(`${PRIVATE_PATH}: ENOENT`), 'STORE_ERROR');
    const salvaged = DebuggenError.from({
      __isDebuggenError__: true,
      code: 'STORE_ERROR',
      message: 'The store is locked.',
      hint: 'Close the other session, then retry.',
    });
    const reRaisedCopy = new DebuggenError(copied.code, copied.message, { cause: copied });
    const fromString = DebuggenError.from(PRIVATE_MESSAGE);

    // Prose of the provider's own around a foreign cause is withheld too, even
    // when the words look harmless: provenance, not the wording, decides.
    const raw = new Error('the disk is full');
    const prefixed = new DebuggenError('STORE_ERROR', `Read failed: ${raw.message}`, {
      hint: 'Free some space, then retry.',
      cause: raw,
    });
    const prefixedDeep = new DebuggenError('STORE_ERROR', 'The store could not answer.', {
      cause: prefixed,
    });

    for (const error of [copied, salvaged, reRaisedCopy, fromString, prefixed, prefixedDeep]) {
      const props = queryFailureProps(
        { error, announcement: undefined, retry },
        { source: 'spans' },
      );

      expect(props.message).toBe(VIEW_LEAD);
      expect(props.hint).toBeUndefined();
      expect(props.code).toBe(error.code);
    }

    // The salvaged code is the one the imitation named, even though its
    // words are not shown.
    expect(salvaged.code).toBe('STORE_ERROR');
  });

  it('withholds authored text that carries a path, a URL, a credential or a statement', () => {
    const retry = vi.fn<() => void>();
    const unpresentable = [
      `The index at ${PRIVATE_PATH} is stale.`,
      'The file C:\\Users\\dev\\app\\.env is locked.',
      'Open ~/.config/app to fix it.',
      'The service at http://127.0.0.1:43117/health refused the call.',
      'Write to dev@example.com for access.',
      `The key ${PROVIDER_KEY_SHAPE} was refused.`,
      `The header Bearer ${BEARER_TOKEN_BODY} was refused.`,
      'The call sent password=hunter2 to the service.',
      `The statement ${PRIVATE_STATEMENT} failed.`,
      'The statement DELETE FROM accounts failed.',
      `Query failed: ${PRIVATE_LOWER_STATEMENT}`,
      "The row where name = 'alice' is locked.",
      `The digest ${'a1b2c3d4'.repeat(6)} did not match.`,
      'The first line.\nThe stack follows.',
      `A cause that runs on ${'and on '.repeat(80)}`,
    ];

    for (const text of unpresentable) {
      const inMessage = new DebuggenError(PROVIDER_FAILURE_CODE, text, {
        hint: 'Retry in a moment.',
      });
      const inHint = new DebuggenError(PROVIDER_FAILURE_CODE, 'The request was refused.', {
        hint: text,
      });

      const messageProps = queryFailureProps(
        { error: inMessage, announcement: undefined, retry },
        { source: 'metrics' },
      );
      expect(messageProps.message).toBe(VIEW_LEAD);
      expect(messageProps.hint).toBe('Retry in a moment.');

      const hintProps = queryFailureProps(
        { error: inHint, announcement: undefined, retry },
        { source: 'metrics' },
      );
      expect(hintProps.message).toBe(`${VIEW_LEAD} The request was refused.`);
      expect(hintProps.hint).toBeUndefined();
    }
  });

  it('keeps an authored, presentable message and hint, including prose that reads like SQL', () => {
    const retry = vi.fn<() => void>();
    const presentable = [
      {
        message: 'The channel to the service is closed.',
        hint: 'Start the local service, then retry.',
      },
      {
        message: 'The selected event is no longer in the capture.',
        hint: 'Select the event again from the panel or the live tail.',
      },
      {
        message: 'The service refused the bearer credential.',
        hint: 'Update the order of the columns and set a filter, then retry.',
      },
    ];

    for (const { message, hint } of presentable) {
      const props = queryFailureProps(
        {
          error: new DebuggenError(PROVIDER_FAILURE_CODE, message, { hint }),
          announcement: undefined,
          retry,
        },
        { source: 'events' },
      );

      expect(props.message).toBe(`${VIEW_LEAD} ${message}`);
      expect(props.hint).toBe(hint);
    }

    // A typed error that re-raises another with the same words, as a host
    // adapter adding its query context does, is still authored.
    const original = new DebuggenError(
      PROVIDER_FAILURE_CODE,
      'The channel to the service is closed.',
    );
    const reRaised = new DebuggenError(original.code, original.message, { cause: original });
    expect(
      queryFailureProps({ error: reRaised, announcement: undefined, retry }, { source: 'events' })
        .message,
    ).toBe(`${VIEW_LEAD} The channel to the service is closed.`);
  });

  it('shows only approved diagnostic fields with presentable values in the details', () => {
    const retry = vi.fn<() => void>();
    const error = new DebuggenError(PROVIDER_FAILURE_CODE, 'The request was refused.', {
      details: {
        attempts: 3,
        field: 'data.origin',
        endpoint: 'panel-data',
        source: '/private/var/app/.env',
        auth: 'Bearer abc.def',
        password: SHORT_PASSWORD,
        apiToken: 42,
        note: 'panel-data',
        nested: { a: 1 },
        'bad key!': 1,
        count: Infinity,
        skipped: undefined,
        degraded: false,
        missing: null,
      },
    });

    const props = queryFailureProps({ error, announcement: undefined, retry }, { source: 'spans' });

    // Text survives only under an approved diagnostic key and only when it is
    // presentable; a secret-named key is withheld whatever its value's shape,
    // and a count, a flag or `null` survives under any other identifier key.
    expect(props.details).toBe(
      JSON.stringify(
        {
          attempts: 3,
          field: 'data.origin',
          endpoint: 'panel-data',
          source: REDACTED,
          auth: REDACTED,
          password: REDACTED,
          apiToken: REDACTED,
          note: REDACTED,
          nested: REDACTED,
          count: REDACTED,
          degraded: false,
          missing: null,
        },
        null,
        2,
      ),
    );

    // Nothing that survives the allowlist leaves no details block at all.
    const bare = new DebuggenError(PROVIDER_FAILURE_CODE, 'The request was refused.', {
      details: { 'not an identifier': PRIVATE_PATH, skipped: undefined },
    });
    expect(
      queryFailureProps({ error: bare, announcement: undefined, retry }, { source: 'spans' })
        .details,
    ).toBeUndefined();
  });

  it('draws no details, and does not throw, for details that throw when read', () => {
    const retry = vi.fn<() => void>();
    const hostile = Object.defineProperty({ attempts: 1 }, 'exploding', {
      enumerable: true,
      get(): never {
        throw new Error(PRIVATE_PATH);
      },
    });
    const error = new DebuggenError(PROVIDER_FAILURE_CODE, 'The request was refused.', {
      details: hostile,
    });

    const props = queryFailureProps({ error, announcement: undefined, retry }, { source: 'spans' });

    expect(props.details).toBeUndefined();
    expect(props.message).toBe(`${VIEW_LEAD} The request was refused.`);
  });

  it('keeps integration instructions off the hint line and in the details', async () => {
    const refusals = [
      mapPanelDataResult({ source: 'renders' }, null),
      mapPanelDataResult({ source: 'renders' }, { source: 'requests', requests: [] }),
    ].map((mapped) => (mapped.ok ? undefined : mapped.error));
    const viewRefusals = [
      checkDataQueryResponse({ source: 'spans' }, { source: 'spans', spans: [] }),
      checkDataQueryResponse({ source: 'renders' }, { source: 'requests', data: [] }),
      checkDataQueryResponse({ source: 'renders' }, { source: 42, data: [] }),
    ];
    const unaddressed = await createDataProvider(vi.fn<DataQueryResolver>())
      .query('', { source: 'metrics' })
      .then(
        () => undefined,
        (reason: unknown) => (DebuggenError.is(reason) ? reason : undefined),
      );

    const errors = [...refusals, ...viewRefusals, unaddressed];
    expect(errors).toHaveLength(6);

    for (const error of errors) {
      if (error === undefined) {
        throw new Error('a refusal under test was not refused');
      }

      // What the reader sees first names nothing from the integration…
      expect(error.message).not.toMatch(INTEGRATION_VOCABULARY);
      expect(error.hint ?? '').toMatch(/\S/u);
      expect(error.hint ?? '').not.toMatch(INTEGRATION_VOCABULARY);

      // …while the developer's instruction travels in the details.
      expect(error.details?.['remedy']).toMatch(/\S/u);
    }
  });

  it('puts the missing-session remedy behind the details, with no hint line', async () => {
    const { provider, resolve } = makeRejectingProvider(() => new Error('never asked'));

    render(
      <FailureProbes
        provider={provider}
        sessionId={BLANK_SESSION_ID}
        probes={[{ label: 'unaddressed view', query: { source: 'metrics' } }]}
      />,
    );

    const failure = await settledFailure('unaddressed view');
    within(failure).getByText(MISSING_SESSION_CODE);
    expect(resolve).not.toHaveBeenCalled();

    // One message line and no hint line; the remedy is inside the closed
    // technical details, never in the text a reader meets first.
    expect(failure.querySelectorAll('.dg-error-state__message')).toHaveLength(1);
    const detailsBlock = within(failure).getByRole('group', { name: DETAILS_NAME, hidden: true });
    expect(detailsBlock.closest('details')?.open).toBe(false);
    expect(detailsBlock.textContent).toMatch(/PanelSessionContext/u);
  });

  it('announces a burst of failures with exactly one alert and statuses for the rest', async () => {
    const { provider } = makeRejectingProvider(
      () => new DebuggenError(PROVIDER_FAILURE_CODE, 'The service is unreachable.'),
    );

    render(
      <FailureProbes
        provider={provider}
        sessionId={SESSION_ID}
        probes={[
          { label: 'first failing view', query: { source: 'metrics' } },
          { label: 'second failing view', query: { source: 'renders' } },
        ]}
      />,
    );

    const first = await settledFailure('first failing view');
    const second = await settledFailure('second failing view');

    // Both failures are announced — neither is silent — but only one of them
    // interrupts: the rest wait their turn.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect([first.getAttribute('role'), second.getAttribute('role')].sort()).toEqual([
      'alert',
      'status',
    ]);
  });

  it('draws one failure contract across every query-backed catalogued view failing together', async () => {
    // Every query-backed view the catalogue names, titled with its own label and
    // reading its first source, each failing with the same transport fault.
    // Where the probe cases above pin the hook, helpers and primitive, this case
    // pins the call sites: every view's error branch, through the host, at once.
    const layout = Object.values(PANEL_NODE_CATALOG)
      .filter((entry) => entry.requiresQuery)
      .map((entry) => {
        const source = entry.defaultSource ?? entry.sources[0];

        if (source === undefined) {
          throw new Error(`the catalogue entry for "${entry.type}" names no data source`);
        }

        return {
          type: entry.type,
          id: `node:${entry.type}`,
          title: entry.label,
          query: { source },
          ...(entry.type === 'metricCards' ? { metrics: [NODE_METRIC_ID] } : {}),
        } as PanelNode;
      });
    // Thirteen visualization components, of which only the source-link leaf
    // reads no captured data.
    expect(layout).toHaveLength(12);

    const { provider, resolve } = makeRejectingProvider(() =>
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
    );

    const { container } = render(
      <PanelHost
        spec={makeSpec({ layout })}
        dataProvider={provider}
        actions={makeActions().actions}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('.dg-error-state')).toHaveLength(layout.length);
    });
    expect(resolve).toHaveBeenCalledTimes(layout.length);

    const failures = Array.from(container.querySelectorAll<HTMLElement>('.dg-error-state'));

    for (const failure of failures) {
      // One title, one lead followed by the renderer's fixed HTTP sentence —
      // never the rejection's own text — and one code.
      expect(within(failure).getByText(QUERY_FAILURE_TITLE)).toBeTruthy();
      const messages = Array.from(failure.querySelectorAll('.dg-error-state__message'));
      expect(messages.map((line) => line.textContent)).toEqual([`${VIEW_LEAD} ${HTTP_503_CAUSE}`]);
      within(failure).getByText(PROVIDER_FAILURE_CODE);
      expect(failure.textContent).not.toMatch(INTEGRATION_VOCABULARY);

      // One glyph, and one query format: the canonical pretty-printed form of
      // the query the view actually asked, whatever defaults it applied.
      expect(failure.querySelectorAll('.dg-error-state__icon')).toHaveLength(1);
      const queryBlock = within(failure).getByRole('group', { name: FAILING_QUERY_NAME });
      const printed = queryBlock.textContent ?? '';
      const asked = JSON.parse(printed) as DataQuery;
      expect(printed).toBe(formatDataQuery(asked));

      // The same retry control, keyed so the node frame can restore focus to it.
      const retry = within(failure).getByRole('button', { name: RETRY_PATTERN });
      expect(retry.getAttribute(FOCUS_KEY_ATTRIBUTE)).toBe(ERROR_STATE_RETRY_FOCUS_KEY);
    }

    // The failures of one burst interrupt once; the rest are polite.
    expect(failures.filter((failure) => failure.getAttribute('role') === 'alert')).toHaveLength(1);
    expect(failures.filter((failure) => failure.getAttribute('role') === 'status')).toHaveLength(
      layout.length - 1,
    );
  });

  it('alerts again for a failure that follows a released one', async () => {
    const { provider, resolve } = makeRejectingProvider(
      () => new DebuggenError(PROVIDER_FAILURE_CODE, 'The service is unreachable.'),
    );
    const firstProbe: FailureProbeProps = {
      label: 'first failing view',
      query: { source: 'metrics' },
    };
    const laterProbe: FailureProbeProps = {
      label: 'later failing view',
      query: { source: 'events' },
    };

    const view = render(
      <FailureProbes provider={provider} sessionId={SESSION_ID} probes={[firstProbe]} />,
    );
    expect((await settledFailure(firstProbe.label)).getAttribute('role')).toBe('alert');

    // A retry releases the failure it replaces, so the failure that follows it
    // is not demoted by its own predecessor.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: RETRY_PATTERN }));
    await waitFor(() => {
      expect(resolve).toHaveBeenCalledTimes(2);
    });
    expect((await settledFailure(firstProbe.label)).getAttribute('role')).toBe('alert');

    // Unmounting releases it too: a failure somewhere else afterwards alerts.
    view.rerender(
      <FailureProbes provider={provider} sessionId={SESSION_ID} probes={[laterProbe]} />,
    );
    expect(screen.queryByRole('region', { name: firstProbe.label })).toBeNull();
    expect((await settledFailure(laterProbe.label)).getAttribute('role')).toBe('alert');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Focus after a retry: the node frame keeps keyboard focus inside the node
 * ---------------------------------------------------------------------------
 */

describe('PanelHost focus after a retry', () => {
  /** The title of the query-backed leaf these cases retry, and its region's name. */
  const RETRIED_VIEW_TITLE = 'Retried view';

  /**
   * The document path — and so the `data-node-path` — of the untitled metric
   * leaf of {@link makeNestedLayout}.
   */
  const UNTITLED_LEAF_PATH = 'layout.0.children.0.children.0.children.0';

  /**
   * A titled query-backed leaf followed by a standalone source chip.
   *
   * The leaf is titled so the heading its frame parks focus on carries a name
   * this suite chose (an untitled one would be headed by its catalogue label,
   * which the untitled-leaf case below covers); the chip is a control in
   * *another* node, which is where a reader who moves on while a retry is in
   * flight goes.
   *
   * @returns The two nodes, as fresh objects.
   */
  function makeRetryLayout(): readonly PanelNode[] {
    return [
      {
        type: 'metricCards',
        id: 'layout.0',
        title: RETRIED_VIEW_TITLE,
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

  /**
   * Mounts a panel over a controllable provider, so every attempt of the
   * retried query is settled by the case itself.
   *
   * @param layout The panel's layout.
   * @returns The provider, and the container the panel was drawn into.
   */
  function renderControlled(layout: readonly PanelNode[]): {
    readonly provider: ControllableProvider;
    readonly container: HTMLElement;
  } {
    const provider = makeControllableProvider();
    const { container } = render(
      <PanelHost
        spec={makeSpec({ layout })}
        dataProvider={provider.provider}
        actions={makeActions().actions}
      />,
    );

    return { provider, container };
  }

  /** A fresh transport rejection, for an attempt the case fails. */
  function transportFailure(): DebuggenError {
    return new DebuggenError(
      PROVIDER_FAILURE_CODE,
      'The transport closed before the page arrived.',
    );
  }

  /**
   * Fails the oldest pending attempt and waits for the error state's retry.
   *
   * @param provider The panel's provider.
   * @param scope The node's region, which the retry must render inside.
   * @returns The retry control of the error state that attempt produced.
   */
  async function failNext(
    provider: ControllableProvider,
    scope: HTMLElement,
  ): Promise<HTMLElement> {
    provider.takeNext().fail(transportFailure());

    return within(scope).findByRole('button', { name: RETRY_PATTERN });
  }

  /**
   * The node frame drawn at a document path.
   *
   * @param container The render's container.
   * @param path The node's document path, as `data-node-path` spells it.
   * @returns The frame.
   */
  function frameAt(container: HTMLElement, path: string): HTMLElement {
    const frame = container.querySelector<HTMLElement>(`.dg-panel__node[data-node-path="${path}"]`);
    if (frame === null) {
      throw new Error(`no node frame is drawn at "${path}"`);
    }

    return frame;
  }

  it('puts focus on the new Retry when a keyboard retry fails again', async () => {
    const { provider } = renderControlled(makeRetryLayout());
    const region = screen.getByRole('region', { name: RETRIED_VIEW_TITLE });
    const user = userEvent.setup();

    const firstRetry = await failNext(provider, region);
    firstRetry.focus();
    expect(document.activeElement).toBe(firstRetry);

    await user.keyboard('{Enter}');

    // The keyboard press retried: the old control left the document with the
    // error state it belonged to.
    expect(provider.resolve).toHaveBeenCalledTimes(2);
    expect(firstRetry.isConnected).toBe(false);

    const secondRetry = await failNext(provider, region);

    await waitFor(() => {
      expect(document.activeElement).toBe(secondRetry);
    });
    expect(secondRetry).not.toBe(firstRetry);
    expect(secondRetry.isConnected).toBe(true);
    expect(secondRetry.getAttribute(FOCUS_KEY_ATTRIBUTE)).toBe(ERROR_STATE_RETRY_FOCUS_KEY);

    // The heading focus waited on while the retry was in flight gave back the
    // tab stop it borrowed when focus moved on.
    const heading = within(region).getByRole('heading', { name: RETRIED_VIEW_TITLE });
    expect(heading.hasAttribute('tabindex')).toBe(false);
  });

  it("keeps focus on the node's heading, not the body, while a retry is in flight", async () => {
    const { provider } = renderControlled(makeRetryLayout());
    const region = screen.getByRole('region', { name: RETRIED_VIEW_TITLE });
    const user = userEvent.setup();

    const retry = await failNext(provider, region);
    retry.focus();
    await user.keyboard('{Enter}');

    // Loading, with the pressed control gone — and focus inside the node.
    expect(within(region).getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(retry.isConnected).toBe(false);

    const heading = within(region).getByRole('heading', { name: RETRIED_VIEW_TITLE });
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');

    provider.takeNext().answer(metricsResponse());
    await within(region).findByRole('list', { name: METRIC_VIEW_NAME });
  });

  it('leaves focus on the node heading when a clicked retry succeeds, borrowing tabindex only while focused', async () => {
    const { provider } = renderControlled(makeRetryLayout());
    const region = screen.getByRole('region', { name: RETRIED_VIEW_TITLE });
    const user = userEvent.setup();

    const retry = await failNext(provider, region);
    await user.click(retry);
    expect(provider.resolve).toHaveBeenCalledTimes(2);

    provider.takeNext().answer(metricsResponse());
    await within(region).findByRole('list', { name: METRIC_VIEW_NAME });

    // The recovered view has no control equivalent to Retry, so focus stays on
    // the node's own region: its heading, focusable only while it holds focus.
    const heading = within(region).getByRole('heading', { name: RETRIED_VIEW_TITLE });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(heading.getAttribute('tabindex')).toBe('-1');

    await user.tab();

    expect(document.activeElement).not.toBe(heading);
    expect(document.activeElement).not.toBe(document.body);
    expect(heading.hasAttribute('tabindex')).toBe(false);
  });

  /** How one in-flight retry settles, and what the node draws once it has. */
  interface RetryOutcome {
    /** The outcome, for the case title. */
    readonly outcome: string;
    /** Settles the pending attempt. */
    readonly settle: (pending: PendingQuery) => void;
    /** The role of what the settled node draws. */
    readonly settledRole: 'button' | 'list';
    /** The accessible name of what the settled node draws. */
    readonly settledName: string | RegExp;
  }

  const RETRY_OUTCOMES: readonly RetryOutcome[] = [
    {
      outcome: 'fails again',
      settle: (pending) => {
        pending.fail(transportFailure());
      },
      settledRole: 'button',
      settledName: RETRY_PATTERN,
    },
    {
      outcome: 'succeeds',
      settle: (pending) => {
        pending.answer(metricsResponse());
      },
      settledRole: 'list',
      settledName: METRIC_VIEW_NAME,
    },
  ];

  it.each(RETRY_OUTCOMES)(
    'leaves focus where the reader moved it while the retry was in flight, when the retry $outcome',
    async ({ settle, settledRole, settledName }) => {
      const { provider } = renderControlled(makeRetryLayout());
      const region = screen.getByRole('region', { name: RETRIED_VIEW_TITLE });
      const user = userEvent.setup();

      const retry = await failNext(provider, region);
      retry.focus();
      await user.keyboard('{Enter}');

      const heading = within(region).getByRole('heading', { name: RETRIED_VIEW_TITLE });
      expect(document.activeElement).toBe(heading);

      // The reader moves on, to the next control on the panel: a chip in
      // another node.
      await user.tab();
      const chip = screen.getByRole('button', { name: chipName(NODE_LOCATION) });
      expect(document.activeElement).toBe(chip);
      expect(heading.hasAttribute('tabindex')).toBe(false);

      settle(provider.takeNext());

      // Whatever the retry settles on — a fresh Retry or the recovered view —
      // nothing pulls focus back into the node.
      await within(region).findByRole(settledRole, { name: settledName });
      expect(document.activeElement).toBe(chip);
      expect(heading.hasAttribute('tabindex')).toBe(false);
    },
  );

  it('parks focus on the heading an untitled view draws from its catalogue label, never on its container', async () => {
    const { provider, container } = renderControlled(makeNestedLayout());
    const stack = screen.getByRole('region', { name: STACK_TITLE });
    const stackHeading = within(stack).getByRole('heading', { name: STACK_TITLE });
    const frame = frameAt(container, UNTITLED_LEAF_PATH);
    const user = userEvent.setup();

    // The untitled leaf is headed by its catalogue label inside its own frame,
    // and that heading is present in every state the view passes through.
    const heading = within(frame).getByRole('heading', { name: METRIC_VIEW_NAME });

    const retry = await failNext(provider, stack);
    expect(frame.contains(retry)).toBe(true);
    retry.focus();
    await user.keyboard('{Enter}');

    // The stack's heading belongs to the stack's own frame, so focus waits on
    // the leaf's own heading — never on its container's, and never on the
    // leaf's frame while the leaf has a heading to offer.
    expect(document.activeElement).toBe(heading);
    expect(document.activeElement).not.toBe(stackHeading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(frame.hasAttribute('tabindex')).toBe(false);

    provider.takeNext().answer(metricsResponse());
    await within(frame).findByRole('list', { name: METRIC_VIEW_NAME });

    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });

    await user.tab();

    expect(document.activeElement).not.toBe(heading);
    expect(document.activeElement).not.toBe(document.body);
    expect(heading.hasAttribute('tabindex')).toBe(false);
    expect(stackHeading.hasAttribute('tabindex')).toBe(false);
  });

  it('moves no focus for a node the reader was not in', async () => {
    const { provider } = renderControlled(makeRetryLayout());
    const region = screen.getByRole('region', { name: RETRIED_VIEW_TITLE });
    const chip = screen.getByRole('button', { name: chipName(NODE_LOCATION) });

    // Focus rests elsewhere while the node fails, and on nothing at all when
    // its retry is pressed from the pointer without taking focus. The chip's
    // tooltip follows its focus in React state, hence `act`.
    act(() => {
      chip.focus();
    });
    const retry = await failNext(provider, region);
    expect(document.activeElement).toBe(chip);

    act(() => {
      chip.blur();
    });
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(retry);
    expect(provider.resolve).toHaveBeenCalledTimes(2);

    provider.takeNext().fail(transportFailure());
    await within(region).findByRole('button', { name: RETRY_PATTERN });

    expect(document.activeElement).toBe(document.body);
    expect(region.querySelector('[tabindex="-1"]')).toBeNull();
  });

  it("names an unrenderable node's block for what it holds: the node definition, not a query", () => {
    // A type outside the vocabulary, cast because the closed union cannot
    // express it — the shape a stored panel from a newer vocabulary arrives in.
    const unrenderable = {
      type: 'unrecordedVisualization',
      id: 'layout.0',
    } as unknown as PanelNode;
    const provider = makeDataProvider();

    render(
      <PanelHost
        spec={makeSpec({ layout: [unrenderable] })}
        dataProvider={provider.provider}
        actions={makeActions().actions}
      />,
    );

    const failure = screen.getByRole('alert');
    const block = within(failure).getByRole('group', { name: 'Node definition' });

    expect(JSON.parse(block.textContent ?? '')).toEqual(unrenderable);
    expect(within(failure).queryByRole('group', { name: 'Failing query' })).toBeNull();
    expect(provider.resolve).not.toHaveBeenCalled();
  });
});
