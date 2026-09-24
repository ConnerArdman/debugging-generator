/**
 * `components/Timeline` — how the timeline states the lineage of an event that
 * joined its trace across an asynchronous boundary.
 *
 * ## What this suite is protecting
 *
 * AAP 0.4.2 attributes a React commit, a state transition or a further request
 * that lands after a response settled to that request's span, through a
 * *continuation window*, and records the attribution in `attributes.lineage`.
 * When more than one settled request had an open window at that moment the
 * attribution is a choice among candidates: it is flagged `lineageAmbiguous`
 * and the other candidates are listed, as span ids, in `lineageCandidates`.
 * The timeline must render the two outcomes as what they are:
 *
 *   - **Ambiguous.** The connector to the chosen parent is dashed in the
 *     warning tone, the bar itself carries the same state, and the description
 *     names every other candidate. A span id alone is not something a reader
 *     can act on, so a candidate that is a span of the same trace on screen is
 *     named by the operation it recorded — with its id kept beside it — and
 *     one that is not (another trace, a page not loaded) is stated exactly as
 *     recorded rather than guessed at.
 *   - **Inferred with a single candidate.** Not measured, so its connector is
 *     marked (`dg-is-inferred`), but not in doubt, so it is never dashed and
 *     never flagged ambiguous.
 *
 * Both the flat `spans` page — where the producer's attribute keys are the only
 * route — and the correlated `trace` — where the correlator's lineage record
 * carries them — are exercised, because the component reads each route
 * separately. The last cases pin what the stylesheet does with the state
 * classes, since happy-dom applies no stylesheet and a class no rule paints is
 * a distinction nobody sees.
 *
 * ## Harness conventions (shared with `./Timeline.test.tsx`)
 *
 *   - Test API imported explicitly from `vitest`, with `afterEach(cleanup)`
 *     registered explicitly.
 *   - Stub providers built with the library's own `createDataProvider`.
 *   - In-file synthetic builders and hand-built trees: `@debuggen/telemetry` is
 *     a type-only dependency of this package (AAP 0.2.2).
 *   - Generic fixture vocabulary only (AAP 0.5.4): no name, route or symbol of
 *     any inspected application.
 *   - Queries by role and accessible name; a class is read only off an element
 *     already obtained semantically, or off the canvas the role query returned.
 *   - A description is read while it is OPEN, opened the way a pointer opens
 *     it — by resting on its trigger — and closed again afterwards. The
 *     `Tooltip` primitive keeps a closed bubble mounted but `hidden`, so a role
 *     query finds exactly the bubble that is being shown.
 *   - No timers and no arbitrary waits: interactions go through `userEvent`,
 *     and what an interaction opens is awaited with `waitFor`.
 *
 * @see ./Timeline for the component and its class contract.
 * @see ./Timeline.test.tsx for the rest of the component's suite.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DataQuery, TimelineNode } from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';
import type {
  TelemetryEvent,
  TelemetryKind,
  TelemetryTier,
  TraceNode,
  TraceNodeLineage,
  TraceTree,
} from '@debuggen/telemetry';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataProviderContext, PanelSessionContext, createDataProvider } from '../host/DataProvider';
import type { DataProvider, DataQueryResolver, DataQueryResponse } from '../host/DataProvider';
import { PanelActionsContext } from '../host/PanelActions';
import type { PanelActions, PanelEventRef } from '../host/PanelActions';
import { alignHairline } from '../utils/scale';
import { Timeline } from './Timeline';

/*
 * ---------------------------------------------------------------------------
 * Fixture vocabulary
 * ---------------------------------------------------------------------------
 */

/** The trace every fixture span belongs to, unless it says otherwise: 32 hex digits. */
const TRACE_ID = 'c8d2e3f405162738495a6b7c8d9e0f1a';

/** A second trace on the same flat page, whose span ids must never name a candidate here. */
const OTHER_TRACE_ID = 'd9e3f40516273849506b7c8d9e0f1a2b';

/** The session and capture the persisted events are attributed to. */
const SESSION_ID = 'session-example-0002';
const CAPTURE_ID = 'capture-example-0002';

/** The page agent that produced every fixture span. */
const PRODUCER_ID = 'producer-example-browser';

/** The reference start time, in Unix epoch milliseconds: 2026-01-01T00:00:00Z. */
const BASE_START_MS = 1_767_225_600_000;

/** The identity of the node under test, as a normaliser would assign it. */
const NODE_ID = 'layout.0.timeline';

/** The attribution mechanism a continuation window records, verbatim. */
const ASYNC_CONTINUATION = 'async-continuation';

/** The words the description opens an ambiguous attribution's note with. */
const AMBIGUITY_SENTENCE = 'More than one parent was possible';

/** A 16-hex span id derived from a small ordinal, so ids stay readable. */
function spanIdFor(ordinal: number): string {
  return `00000000000000${ordinal.toString(16).padStart(2, '0')}`;
}

/*
 * ---------------------------------------------------------------------------
 * Synthetic builders
 * ---------------------------------------------------------------------------
 */

/** Fields a fixture span states; everything else is derived. */
interface EventSpec {
  readonly ordinal: number;
  readonly name: string;
  readonly kind: TelemetryKind;
  readonly offsetMs: number;
  readonly duration: number;
  readonly parentOrdinal?: number | undefined;
  readonly traceId?: string | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * One persisted browser span, schema-shaped: a 32-hex trace id, a 16-hex span
 * id, an epoch-millisecond start and a millisecond duration.
 *
 * @param spec The span's identity, timing, parent and attributes.
 * @returns A fresh event.
 */
function makeEvent(spec: EventSpec): TelemetryEvent {
  const { ordinal, name, kind, offsetMs, duration, parentOrdinal, traceId = TRACE_ID } = spec;

  return {
    id: `event-lineage-${String(ordinal).padStart(4, '0')}`,
    traceId,
    spanId: spanIdFor(ordinal),
    kind,
    name,
    startTime: BASE_START_MS + offsetMs,
    duration,
    tier: 'browser',
    attributes: { ...spec.attributes },
    status: 'ok',
    producerId: PRODUCER_ID,
    seq: ordinal,
    sessionId: SESSION_ID,
    captureId: CAPTURE_ID,
    ingestSeq: ordinal,
    ...(parentOrdinal === undefined ? {} : { parentSpanId: spanIdFor(parentOrdinal) }),
  };
}

/**
 * One node of a hand-built correlated trace.
 *
 * @param event The event it represents.
 * @param depth Its distance from the root.
 * @param children The nodes it caused, in canonical order.
 * @param lineage The correlator's lineage record, when it crossed an async boundary.
 * @returns A fresh node.
 */
function makeTraceNode(
  event: TelemetryEvent,
  depth: number,
  children: readonly TraceNode[] = [],
  lineage?: TraceNodeLineage,
): TraceNode {
  return {
    event,
    children,
    depth,
    orphaned: false,
    ...(lineage === undefined ? {} : { lineage }),
  };
}

/**
 * A correlated trace whose tree-level fields are derived from its own nodes, so
 * the fixture cannot claim what its nodes do not hold.
 *
 * @param roots The roots, in canonical order.
 * @returns A consistent tree.
 */
function makeTree(roots: readonly TraceNode[]): TraceTree {
  const nodes: TraceNode[] = [];
  const visit = (node: TraceNode): void => {
    nodes.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }

  const startTime = Math.min(...nodes.map((node) => node.event.startTime));
  const endTime = Math.max(...nodes.map((node) => node.event.startTime + node.event.duration));
  const tiers: TelemetryTier[] = [];
  const kinds: TelemetryKind[] = [];
  for (const node of nodes) {
    if (!tiers.includes(node.event.tier)) {
      tiers.push(node.event.tier);
    }
    if (!kinds.includes(node.event.kind)) {
      kinds.push(node.event.kind);
    }
  }
  const primaryRootSpanId = roots[0]?.event.spanId;

  return {
    traceId: TRACE_ID,
    roots,
    nodeCount: nodes.length,
    maxDepth: nodes.reduce((deepest, node) => Math.max(deepest, node.depth), 0),
    startTime,
    endTime,
    totalDuration: Math.round(endTime - startTime),
    orphanCount: 0,
    tiers,
    kinds,
    producerIds: [PRODUCER_ID],
    duplicateSpanIds: [],
    truncated: false,
    ...(primaryRootSpanId === undefined ? {} : { primaryRootSpanId }),
  };
}

/*
 * ---------------------------------------------------------------------------
 * The flow every case draws
 *
 * One page event that issued two requests. A commit landed while both had an
 * open continuation window, so it was attributed to the second — the more
 * recently settled — and the first is its other candidate. A second commit
 * landed while only the first request's window was open, so its attribution
 * had one candidate and is merely inferred.
 * ---------------------------------------------------------------------------
 */

/** The page event. */
const PRESS = makeEvent({
  ordinal: 1,
  name: 'example.press',
  kind: 'interaction',
  offsetMs: 0,
  duration: 900,
});

/** The request that settled first: the ambiguous commit's OTHER candidate. */
const FIRST_REQUEST = makeEvent({
  ordinal: 2,
  name: 'example.first-request',
  kind: 'fetch',
  offsetMs: 10,
  duration: 300,
  parentOrdinal: 1,
});

/** The request that settled last: the ambiguous commit's chosen parent. */
const SECOND_REQUEST = makeEvent({
  ordinal: 3,
  name: 'example.second-request',
  kind: 'fetch',
  offsetMs: 20,
  duration: 420,
  parentOrdinal: 1,
});

/** The ambiguous candidates' lineage record, as the correlator derives it. */
const AMBIGUOUS_LINEAGE: TraceNodeLineage = {
  value: ASYNC_CONTINUATION,
  ambiguous: true,
  candidateSpanIds: [FIRST_REQUEST.spanId],
};

/** The commit attributed to the second request with the first still open. */
const AMBIGUOUS_COMMIT = makeEvent({
  ordinal: 4,
  name: 'example.ambiguous-commit',
  kind: 'render',
  offsetMs: 450,
  duration: 40,
  parentOrdinal: 3,
  attributes: {
    lineage: ASYNC_CONTINUATION,
    lineageAmbiguous: true,
    lineageCandidates: [FIRST_REQUEST.spanId],
  },
});

/** The single-candidate lineage record. */
const INFERRED_LINEAGE: TraceNodeLineage = {
  value: ASYNC_CONTINUATION,
  ambiguous: false,
  candidateSpanIds: [],
};

/** The commit attributed to the first request, the only window open at the time. */
const INFERRED_COMMIT = makeEvent({
  ordinal: 5,
  name: 'example.inferred-commit',
  kind: 'render',
  offsetMs: 320,
  duration: 30,
  parentOrdinal: 2,
  attributes: { lineage: ASYNC_CONTINUATION },
});

/** The flow as a flat span page, in the order the service would deliver it. */
const FLOW_EVENTS: readonly TelemetryEvent[] = [
  PRESS,
  FIRST_REQUEST,
  SECOND_REQUEST,
  INFERRED_COMMIT,
  AMBIGUOUS_COMMIT,
];

/** The same flow as the correlator's tree. */
function flowTree(): TraceTree {
  return makeTree([
    makeTraceNode(PRESS, 0, [
      makeTraceNode(FIRST_REQUEST, 1, [makeTraceNode(INFERRED_COMMIT, 2, [], INFERRED_LINEAGE)]),
      makeTraceNode(SECOND_REQUEST, 1, [makeTraceNode(AMBIGUOUS_COMMIT, 2, [], AMBIGUOUS_LINEAGE)]),
    ]),
  ]);
}

/*
 * ---------------------------------------------------------------------------
 * Providers, rendering and readers
 * ---------------------------------------------------------------------------
 */

/**
 * A provider answering every query with one response.
 *
 * @param response The response to answer with.
 * @returns The provider.
 */
function answering(response: DataQueryResponse): DataProvider {
  const resolve = vi.fn<DataQueryResolver>(() => Promise.resolve(response));
  return createDataProvider(resolve);
}

/** A provider answering with one flat span page. */
function spansProvider(data: readonly TelemetryEvent[]): DataProvider {
  return answering({ source: 'spans', data, total: data.length });
}

/** A provider answering with one correlated trace. */
function traceProvider(tree: TraceTree): DataProvider {
  return answering({ source: 'trace', data: tree });
}

/** The node for a flat span page of the fixture trace. */
function spansNode(): TimelineNode {
  const query: DataQuery = { source: 'spans', filter: { traceId: TRACE_ID } };
  return { type: 'timeline', id: NODE_ID, query };
}

/** The node for the correlated fixture trace. */
function traceNode(): TimelineNode {
  const query: DataQuery = { source: 'trace', filter: { traceId: TRACE_ID } };
  return { type: 'timeline', id: NODE_ID, query };
}

/** Fresh host actions, spied on. */
function makeActions(): PanelActions {
  return {
    onSelectEvent: vi.fn<(ref: PanelEventRef) => void>(),
    onOpenSource: vi.fn<(location: SourceLocation) => void>(),
  };
}

/**
 * Renders the component inside both host contexts and waits for its canvas.
 *
 * @param node The node to draw.
 * @param provider The provider that resolves its query.
 * @returns The canvas, obtained by its role.
 */
async function renderTimeline(node: TimelineNode, provider: DataProvider): Promise<HTMLElement> {
  render(
    <DataProviderContext.Provider value={provider}>
      <PanelSessionContext.Provider value={SESSION_ID}>
        <PanelActionsContext.Provider value={makeActions()}>
          <Timeline node={node} />
        </PanelActionsContext.Provider>
      </PanelSessionContext.Provider>
    </DataProviderContext.Provider>,
  );

  return screen.findByRole('img');
}

/** The equivalent table's data rows, in document order. */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.getAttribute('data-row-index') !== null);
}

/**
 * The element a description is attached to inside `scope`: the name run the
 * `Tooltip` primitive describes with `aria-describedby`, which it carries
 * whether or not its bubble is open.
 *
 * @param scope A row's header cell, or the detail strip.
 * @returns The described name, or `null` when the scope holds none.
 */
function describedNameIn(scope: HTMLElement): HTMLElement | null {
  return scope.querySelector<HTMLElement>('[aria-describedby]');
}

/**
 * The equivalent row for the named operation, read off the element its
 * header's tooltip describes — the name run and nothing else.
 *
 * @param name The operation name.
 * @returns That row.
 */
function rowNamed(name: string): HTMLElement {
  const row = dataRows().find(
    (candidate) => describedNameIn(within(candidate).getByRole('rowheader'))?.textContent === name,
  );

  if (row === undefined) {
    throw new Error(`no rendered row is named "${name}"`);
  }

  return row;
}

/**
 * The description attached to the name inside `scope`, read while it is open.
 *
 * Opened the way a pointer opens it — by resting on the name — and closed
 * again by moving away. The open bubble is found by its role, which a closed
 * (`hidden`) bubble does not answer to, and it must be the very element the
 * name is described by, so the text read is the text assistive technology
 * hears.
 *
 * @param scope A row's header cell, or the detail strip.
 * @returns The description's text.
 */
async function openDescriptionIn(scope: HTMLElement): Promise<string> {
  const user = userEvent.setup();
  const name = describedNameIn(scope);

  if (name === null) {
    throw new Error('the scope holds no described name');
  }

  await user.hover(name);
  const bubble = await waitFor(() => within(scope).getByRole('tooltip'));
  expect((name.getAttribute('aria-describedby') ?? '').split(/\s+/u)).toContain(bubble.id);
  const text = bubble.textContent ?? '';
  await user.unhover(name);

  return text;
}

/** One row's description, as the tooltip in its header cell states it. */
async function descriptionOf(row: HTMLElement): Promise<string> {
  return openDescriptionIn(within(row).getByRole('rowheader'));
}

/**
 * The bar whose SVG title describes the named operation.
 *
 * @param canvas The canvas.
 * @param name The operation name.
 * @returns That bar.
 */
function barTitled(canvas: HTMLElement, name: string): Element {
  const bar = Array.from(canvas.querySelectorAll('rect.dg-timeline__bar')).find((candidate) =>
    (candidate.querySelector('title')?.textContent ?? '').startsWith(`${name} `),
  );

  if (bar === undefined) {
    throw new Error(`no bar on the canvas describes "${name}"`);
  }

  return bar;
}

/** The parent → child connectors on the canvas. */
function edgesOf(canvas: HTMLElement): Element[] {
  return Array.from(canvas.querySelectorAll('path.dg-timeline__edge'));
}

/**
 * The connector that ends at a bar: the elbow path runs down from the parent
 * and then across to the child's leading edge at its vertical centre, both
 * hairline-aligned, so its last two commands name the child's bar.
 *
 * @param canvas The canvas.
 * @param bar The child's bar.
 * @returns The connector into that bar.
 */
function edgeInto(canvas: HTMLElement, bar: Element): Element {
  const x = Number(bar.getAttribute('x'));
  const centerY = Number(bar.getAttribute('y')) + Number(bar.getAttribute('height')) / 2;
  const ending = `V ${String(alignHairline(centerY))} H ${String(alignHairline(x))}`;
  const edge = edgesOf(canvas).find((candidate) =>
    (candidate.getAttribute('d') ?? '').endsWith(ending),
  );

  if (edge === undefined) {
    throw new Error('no connector ends at the given bar');
  }

  return edge;
}

/** The lineage marks an element carries, as a comparable record. */
function marksOf(element: Element): {
  readonly dashed: boolean;
  readonly ambiguous: boolean;
  readonly inferred: boolean;
} {
  return {
    dashed: element.classList.contains('dg-timeline__edge--dashed'),
    ambiguous: element.classList.contains('dg-is-ambiguous'),
    inferred: element.classList.contains('dg-is-inferred'),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/*
 * ---------------------------------------------------------------------------
 * Naming the candidates
 * ---------------------------------------------------------------------------
 */

describe('Timeline lineage candidates', () => {
  it('names another candidate by the operation it recorded, and keeps its span id', async () => {
    const canvas = await renderTimeline(spansNode(), spansProvider(FLOW_EVENTS));
    const named = `${FIRST_REQUEST.name} (${FIRST_REQUEST.spanId})`;

    // The row's description: the mechanism, the uncertainty and the named
    // candidate, with nothing left as a bare id a reader would have to look up.
    const description = await descriptionOf(rowNamed(AMBIGUOUS_COMMIT.name));
    expect(description).toContain(ASYNC_CONTINUATION);
    expect(description).toContain(AMBIGUITY_SENTENCE);
    expect(description).toContain(`the others were ${named}.`);

    // The bar's own title says the same, so the two cannot drift apart.
    expect(
      barTitled(canvas, AMBIGUOUS_COMMIT.name).querySelector('title')?.textContent ?? '',
    ).toContain(`the others were ${named}.`);

    // And so does the detail strip between the canvas and the table, once the
    // row is selected: in its own lineage note, and in the one description its
    // name carries — the only description outside the table.
    await userEvent.setup().click(rowNamed(AMBIGUOUS_COMMIT.name));
    const strip = screen.getByRole('group', { name: 'Span detail' });
    expect(within(strip).getByText('Selected')).toBeDefined();
    expect(describedNameIn(strip)?.textContent).toBe(AMBIGUOUS_COMMIT.name);
    // The note is read as visible text — outside every description bubble,
    // which stays mounted while closed and would otherwise answer for it.
    expect(
      within(strip)
        .getAllByText(`the others were ${named}.`, { exact: false })
        .filter((element) => element.closest('[role="tooltip"]') === null),
    ).toHaveLength(1);

    const grid = screen.getByRole('grid');
    expect(
      screen.getAllByRole('tooltip', { hidden: true }).filter((tooltip) => !grid.contains(tooltip)),
    ).toHaveLength(1);
    expect(await openDescriptionIn(strip)).toContain(`the others were ${named}.`);
  });

  it('names the candidate from the correlated trace’s own lineage record as well', async () => {
    await renderTimeline(traceNode(), traceProvider(flowTree()));

    const description = await descriptionOf(rowNamed(AMBIGUOUS_COMMIT.name));
    expect(description).toContain(AMBIGUITY_SENTENCE);
    expect(description).toContain(
      `the others were ${FIRST_REQUEST.name} (${FIRST_REQUEST.spanId}).`,
    );
  });

  it('states a candidate it cannot resolve in this trace exactly as it was recorded', async () => {
    // Two candidates no span of the commit's own trace answers for: one that
    // is on no loaded row at all, and one whose id is carried by a span of a
    // DIFFERENT trace on the same page — which is not the same span, and must
    // not lend it a name.
    const unloaded = spanIdFor(9);
    const foreign = makeEvent({
      ordinal: 7,
      name: 'example.foreign-request',
      kind: 'fetch',
      offsetMs: 30,
      duration: 50,
      traceId: OTHER_TRACE_ID,
    });
    const commit = makeEvent({
      ordinal: 4,
      name: 'example.ambiguous-commit',
      kind: 'render',
      offsetMs: 450,
      duration: 40,
      parentOrdinal: 3,
      attributes: {
        lineage: ASYNC_CONTINUATION,
        lineageAmbiguous: true,
        lineageCandidates: [unloaded, foreign.spanId],
      },
    });

    await renderTimeline(
      spansNode(),
      spansProvider([PRESS, FIRST_REQUEST, SECOND_REQUEST, commit, foreign]),
    );

    const description = await descriptionOf(rowNamed(commit.name));
    expect(description).toContain(`the others were ${unloaded}, ${foreign.spanId}.`);
    expect(description).not.toContain(foreign.name);
  });

  it('says nothing about candidates for an attribution that had only one', async () => {
    await renderTimeline(spansNode(), spansProvider(FLOW_EVENTS));

    const description = await descriptionOf(rowNamed(INFERRED_COMMIT.name));
    expect(description).toContain(ASYNC_CONTINUATION);
    expect(description).not.toContain(AMBIGUITY_SENTENCE);
    expect(description).not.toContain('the others were');
  });
});

/*
 * ---------------------------------------------------------------------------
 * The marks on the canvas
 * ---------------------------------------------------------------------------
 */

describe('Timeline lineage marks', () => {
  for (const [route, node, provider] of [
    ['a flat span page', spansNode, (): DataProvider => spansProvider(FLOW_EVENTS)],
    ['a correlated trace', traceNode, (): DataProvider => traceProvider(flowTree())],
  ] as const) {
    it(`marks the ambiguous bar and connector, and the inferred connector, apart, on ${route}`, async () => {
      const canvas = await renderTimeline(node(), provider());

      // The ambiguous attribution: its bar and its connector carry the
      // ambiguous state, the connector dashed, and neither reads as merely
      // inferred.
      expect(marksOf(barTitled(canvas, AMBIGUOUS_COMMIT.name))).toEqual({
        dashed: false,
        ambiguous: true,
        inferred: false,
      });
      expect(marksOf(edgeInto(canvas, barTitled(canvas, AMBIGUOUS_COMMIT.name)))).toEqual({
        dashed: true,
        ambiguous: true,
        inferred: false,
      });

      // The single-candidate attribution: inferred, solid, and never flagged
      // ambiguous on its connector or its bar.
      expect(marksOf(edgeInto(canvas, barTitled(canvas, INFERRED_COMMIT.name)))).toEqual({
        dashed: false,
        ambiguous: false,
        inferred: true,
      });
      expect(marksOf(barTitled(canvas, INFERRED_COMMIT.name)).ambiguous).toBe(false);

      // The measured relationships carry no lineage mark at all.
      for (const measured of [FIRST_REQUEST, SECOND_REQUEST]) {
        expect(marksOf(edgeInto(canvas, barTitled(canvas, measured.name)))).toEqual({
          dashed: false,
          ambiguous: false,
          inferred: false,
        });
      }
      expect(edgesOf(canvas)).toHaveLength(FLOW_EVENTS.length - 1);
    });
  }
});

/*
 * ---------------------------------------------------------------------------
 * The marks as the stylesheet paints them
 * ---------------------------------------------------------------------------
 */

describe('Timeline lineage styling', () => {
  /**
   * The component stylesheet with its comments removed, read with the
   * `import.meta.url` convention `../tokens/tokens.test.ts` documents. Joined
   * with `node:path`: under happy-dom the global `URL` is the DOM's, which
   * Node's `fileURLToPath` rejects.
   */
  const stylesheet = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'components.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//gu, '');

  /** Every rule of the stylesheet: its selector list and its declarations, in source order. */
  const rules = Array.from(stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/gu), (match) => ({
    selectors: (match[1] ?? '').split(',').map((part) => part.trim()),
    declarations: (match[2] ?? '')
      .split(';')
      .map((declaration) => declaration.replace(/\s+/gu, ' ').trim())
      .filter((declaration) => declaration !== ''),
  }));

  /** Every declaration made for one exact selector, from each rule that names it. */
  function declarationsOf(selector: string): string[] {
    return rules
      .filter((rule) => rule.selectors.includes(selector))
      .flatMap((rule) => rule.declarations);
  }

  /** The source position of the first rule naming one exact selector. */
  function positionOf(selector: string): number {
    const index = rules.findIndex((rule) => rule.selectors.includes(selector));
    expect(index, `${selector} has no rule`).toBeGreaterThanOrEqual(0);
    return index;
  }

  it('outlines an ambiguous bar with a dashed warning stroke, unlike an orphan’s solid one', () => {
    const ambiguous = declarationsOf('.dg-timeline__bar.dg-is-ambiguous');
    expect(ambiguous).toContain('stroke: var(--dg-warning)');
    expect(ambiguous).toContain('stroke-dasharray: 4 3');

    const orphan = declarationsOf('.dg-timeline__bar.dg-is-orphan');
    expect(orphan).toContain('stroke: var(--dg-warning)');
    expect(orphan.some((declaration) => declaration.startsWith('stroke-dasharray'))).toBe(false);
  });

  it('lets hover and selection win over the ambiguous bar’s outline', () => {
    // Equal specificity, so source order decides: the ambiguous rule comes
    // first, and the interaction states that follow it restroke the bar.
    const ambiguous = positionOf('.dg-timeline__bar.dg-is-ambiguous');
    for (const state of ['.dg-timeline__bar:hover', '.dg-timeline__bar.dg-is-selected']) {
      expect(positionOf(state)).toBeGreaterThan(ambiguous);
      expect(declarationsOf(state).some((declaration) => declaration.startsWith('stroke:'))).toBe(
        true,
      );
    }

    // A bar has no focus state for the outline to contend with: the canvas is
    // `role="img"` and its bars are never focusable — the keyboard reads them
    // in the table beneath, the view's one Tab stop — so the stylesheet
    // declares no bar focus rule at all.
    expect(declarationsOf('.dg-timeline__bar:focus-visible')).toEqual([]);
  });

  it('strokes an ambiguous connector dashed in the warning tone and an inferred one solid in the info tone', () => {
    const ambiguous = declarationsOf('.dg-timeline__edge.dg-is-ambiguous');
    expect(ambiguous).toContain('stroke: var(--dg-warning)');
    expect(ambiguous).toContain('stroke-dasharray: 4 3');

    const inferred = declarationsOf('.dg-timeline__edge.dg-is-inferred');
    expect(inferred).toContain('stroke: var(--dg-info)');
    expect(inferred.some((declaration) => declaration.startsWith('stroke-dasharray'))).toBe(false);

    // The measured connector keeps the connector token alone.
    expect(
      declarationsOf('.dg-timeline__edge').filter((declaration) =>
        declaration.startsWith('stroke:'),
      ),
    ).toEqual(['stroke: var(--dg-graph-edge)']);
  });
});
