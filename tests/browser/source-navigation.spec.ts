/**
 * Click-to-source, end to end (AAP §0.8.3 "`source-navigation`", §0.8.4
 * acceptance test 1): clicking a `SourceLink` in the DevTools panel makes the
 * local service forward a `source.open` whose `location` names the right
 * project-relative file, line and column — observed where the editor observes
 * it. This spec stands in for the VS Code client: the fixtures' `editorClient`
 * is an editor-role WebSocket announcing the fixture app's root, so it receives
 * exactly what `apps/vscode-extension/src/source/open-location.ts` would.
 *
 * The hop chain under test is the product's own, with no transport faked:
 *
 * ```text
 * SourceLink chip (packages/panel-renderer)
 *   → PanelActions.openSource → apps/chrome-extension/src/panel/actions.ts
 *   → the panel's runtime port → apps/chrome-extension/src/background/service-worker.ts
 *   → WebSocket `source.open { sessionId, location }`
 *   → apps/local-service/src/source/open.ts (validates, contains inside projectRoot)
 *   → WebSocket `source.open` to the session's editor clients   ← asserted here
 * ```
 *
 * Every assertion is on the forwarded payload's fields — `file`, `line`,
 * `column`, `resolvedBy`, `confidence`, `symbol` — never merely on a message
 * having been sent.
 *
 * ## Test 1 — a real round trip, from a real generated panel
 *
 * One click on the fixture app's `Run check` button is captured, analysed and
 * turned into a generated panel by the real pipeline (deterministic provider).
 * The location clicked is the widget's `fetch('/api/ping', …)` call site in
 * `src/components/PingWidget.tsx`, and its expected line is computed at run
 * time from the source, never written down here. The chip is looked for on a
 * fixed ladder, and the rung that supplied it is recorded as a test annotation:
 *
 * 1. a chip in the generated panel itself (a hypothesis' suggested location or
 *    a row's location chip) that opens the call site;
 * 2. the `EventDetails` drawer's chip after selecting the captured `fetch`
 *    event in the live tail — the initiator stack mapped through the dev
 *    server's source map (`apps/local-service/src/source/resolve.ts`, route
 *    `source-map`, over `packages/code-analysis/src/source-map/resolver.ts`);
 * 3. otherwise the test fails, naming the expected location and the route that
 *    should have produced it. A missing chip is a product defect against AAP
 *    §0.8.4, never a reason to relax the assertion.
 *
 * The expected line is read from the copy the service serves (the session's
 * `projectRoot`) at click time, with the fixture helper `findLineContaining`:
 * during a session that file may carry the session's own reversible
 * instrumentation, and the location a click forwards names the file as it
 * stands on disk while the editor opens it. When the served copy is untouched
 * the same helper over the tracked fixture (`readFixtureSource`) yields the
 * same line, which the test asserts too.
 *
 * ## Test 2 — a known location, independent of analysis quality
 *
 * A validated `PanelSpec` whose only node is a `sourceLink` leaf is delivered
 * to the panel as a relayed `panel.generated` frame. Its location is the
 * fixture's own `sourceLink` location (`FIXTURE_SOURCE_LINK_LOCATION` in
 * `./panel-spec.fixture.ts`, the widget's `handlePingClick`) with its line and
 * column re-derived from the fixture source at run time. The forwarded payload
 * must equal that location field for field.
 *
 * Delivery keeps the outbound path real. An init script wraps the panel's own
 * `chrome.runtime.connect` so the port it returns is the real port behind a
 * proxy that only records the listeners the panel attaches; the test then
 * hands those listeners one extra inbound frame, carrying the frame header the
 * worker itself writes on that port. Everything the chip click sends still
 * goes through the real port, the real worker, the real socket and the real
 * service. (`panel-render.spec.ts` asserts rendering from a
 * stored specification; this spec needs the reverse direction untouched, which
 * is why it owns this narrower, inbound-only delivery.)
 *
 * ## What is deliberately not asserted here
 *
 * - Path containment and traversal refusal at the service:
 *   `apps/local-service/test/integration/source-open.test.ts`.
 * - The `vscode://debuggen.debug-generator/open` URI handler's own validation:
 *   `apps/vscode-extension/test/suite/uri-handler.test.ts`.
 * - The editor's `showTextDocument` selection and highlight:
 *   `apps/vscode-extension/test/suite/open-location.test.ts`.
 * - Source-map path normalisation (`webpack://`, Turbopack):
 *   `packages/code-analysis/src/source-map/*.test.ts`.
 *
 * ## Shared state (`workers: 1`, `fullyParallel: false`, one `DEBUGGEN_HOME`)
 *
 * Every wait is scoped to this test's own session id, the editor log is cleared
 * before each click, the panel pages are closed by `openPanelPage`'s teardown
 * and every session is ended by the `sessions` fixture's tracked cleanup.
 *
 * Constraints (AAP §0.3.4, §0.5.4, §0.9.2): only the fixture app's vocabulary
 * appears; no credential is read or written here; the service runs with the
 * deterministic provider and nothing leaves localhost.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Locator, TestInfo } from '@playwright/test';

import { createEnvelope, parsePanelGeneratedPayload } from '@debuggen/protocol';
import type { MessageByType, PanelGeneratedPayload, SessionRecord } from '@debuggen/protocol';
import {
  SOURCE_RESOLVED_BY,
  formatSourceLocation,
  isAbsolutePosix,
  isWindowsAbsolute,
  newPanelId,
  parseSourceLocation,
} from '@debuggen/shared';
import type { SessionId, SourceLocation } from '@debuggen/shared';

import {
  DEFAULT_WAIT_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  SESSION_READY_TIMEOUT_MS,
  expect,
  findLineContaining,
  readFixtureSource,
  test,
} from './fixtures';
import type {
  EditorClient,
  OpenPanelOptions,
  PairingHandle,
  PanelHandle,
  RecordedMessage,
  SessionHelper,
} from './fixtures';
import { FIXTURE_SOURCE_LINK_LOCATION } from './panel-spec.fixture';

// ---------------------------------------------------------------------------
// Fixture vocabulary and named timeouts
// ---------------------------------------------------------------------------

/** The fixture widget, as a project-relative POSIX path (identical in the tracked tree and the served copy). */
const WIDGET_FILE = 'src/components/PingWidget.tsx';

/** The widget's one request: the call expression every expected `line` is located by, at run time. */
const FETCH_CALL_NEEDLE = "fetch('/api/ping'";

/** The path of that request, for recognising its telemetry and its response. */
const PING_PATH = '/api/ping';

/** The kind the browser agent gives a `fetch` span (the live tail's kind badge reads it verbatim). */
const FETCH_KIND = 'fetch';

/** Generic questions about the click, in the fixture app's own terms (AAP §0.5.4). */
const ROUND_TRIP_QUESTION = 'Why does clicking the Run check button take so long to show a result?';
const CONTRACT_QUESTION = 'Which code runs when the Run check button is clicked?';

/** The injected panel's title and its one node's heading. */
const CONTRACT_PANEL_TITLE = 'Source navigation contract';
const CONTRACT_NODE_TITLE = 'Click handler';

/** Analysis and panel generation after `capture.stop`, deterministic provider, one short capture. */
const ANALYSIS_TIMEOUT_MS = 90_000;

/** A delivered specification's views resolving their data queries through the worker. */
const PANEL_SETTLE_TIMEOUT_MS = 30_000;

/** The fixture route answers after a fixed 300 ms; this absorbs a first compile of the route. */
const PING_REPLY_TIMEOUT_MS = 30_000;

/** Click → panel port → worker → socket → service → editor socket, on a loaded host. */
const SOURCE_OPEN_TIMEOUT_MS = DEFAULT_WAIT_TIMEOUT_MS;

/**
 * How long after the forwarded frame arrives a panel failure could still
 * surface: the worker answers the port request as soon as its socket took the
 * frame, so its answer is already in flight when the editor sees the forward.
 */
const PANEL_FAILURE_GRACE_MS = 1_000;

/** Window in which a second, duplicate `source.open` for the same click would have arrived. */
const DUPLICATE_OPEN_WINDOW_MS = 1_000;

/** Test 1 covers session readiness, a capture window, analysis and panel generation. */
const ROUND_TRIP_TEST_TIMEOUT_MS = SESSION_READY_TIMEOUT_MS + ANALYSIS_TIMEOUT_MS + 60_000;

/** Test 2 covers session readiness and one delivered panel. */
const CONTRACT_TEST_TIMEOUT_MS = SESSION_READY_TIMEOUT_MS + 60_000;

/** The renderer's source chip (`packages/panel-renderer/src/components/SourceLink.tsx`): an interactive `<button>`. */
const SOURCE_CHIP_SELECTOR = 'button.dg-source-link';

/** The renderer's error state (`packages/panel-renderer/src/primitives/ErrorState.tsx`). */
const ERROR_STATE_SELECTOR = '.dg-error-state';

/** A view still resolving its data query renders `LoadingState`, a busy live region. */
const BUSY_SELECTOR = '[aria-busy="true"]';

/** The window property the inbound port tap of Test 2 publishes its state on. */
const PANEL_PORT_TAP_GLOBAL = '__debuggenSourceNavigationPortTap';

/**
 * The two discriminants of a relayed protocol push on the panel port
 * (`PortProtocolPush` in `apps/chrome-extension/src/shared/messages.ts`:
 * `direction: 'push'`, `kind: 'protocol'`). The tap recognises relayed pushes
 * by them and frames an injected one with them only while the worker has
 * relayed none on the port yet; the frame header (`channel`, `version`) is
 * always read off the wire.
 */
const RELAYED_PUSH_DISCRIMINANTS = Object.freeze({ direction: 'push', kind: 'protocol' });

// ---------------------------------------------------------------------------
// Expected locations, derived from source at run time
// ---------------------------------------------------------------------------

/** What Test 1 expects the forwarded location of the widget's call site to be. */
interface CallSiteExpectation {
  /** The project-relative POSIX path, as the service must forward it. */
  readonly file: string;
  /** The call's 1-based line in the tracked fixture (`readFixtureSource`). */
  readonly trackedLine: number;
  /** The call's 1-based line in the served copy at click time; what the editor will open. */
  readonly servedLine: number;
  /** That line's text in the served copy, bounding the forwarded column. */
  readonly servedLineText: string;
  /** Whether the served copy is byte-identical to the tracked fixture (no session patch applied). */
  readonly servedIsPristine: boolean;
  /**
   * The identifiers a forwarded `symbol` may be: the functions the file declares
   * (the widget component and its click handler) plus the identifiers written on
   * the call-site line. The source-map route reports the map's `names` entry or
   * the identifier at the resolved column (`symbolFor` in
   * `packages/code-analysis/src/source-map/resolver.ts`), never a bundler's
   * generated name, while the code-graph and React-owner routes name the
   * enclosing handler or component; every one of them is the fixture's own
   * identifier, which is what this set pins.
   */
  readonly allowedSymbols: ReadonlySet<string>;
}

/** Characters a regular expression treats specially, escaped for a literal match. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every `function <name>` declaration in a module's text, in order. */
function declaredFunctionNames(text: string): string[] {
  return [...text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** The identifiers written on one line of code, string literal contents excluded. */
function identifiersOnLine(line: string): string[] {
  const code = line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '');
  return [...code.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]);
}

/**
 * The absolute path of a project-relative POSIX `file` inside `projectRoot`,
 * refusing anything that resolves outside it — so reading the served copy can
 * never be pointed elsewhere by a malformed location.
 */
function resolveInsideProject(projectRoot: string, file: string): string {
  const resolved = path.resolve(projectRoot, ...file.split('/'));
  const relative = path.relative(projectRoot, resolved).split(path.sep).join('/');
  if (relative !== file) {
    throw new Error(
      `${file} does not name a file inside the session's project root (it resolves to ${relative}).`,
    );
  }
  return resolved;
}

/**
 * Locate the widget's `fetch` call site in both the tracked fixture and the
 * copy the service serves for `session`, with the fixture's own helpers.
 */
async function readCallSiteExpectation(session: SessionRecord): Promise<CallSiteExpectation> {
  const tracked = await readFixtureSource(WIDGET_FILE);
  const servedText = await readFile(resolveInsideProject(session.projectRoot, WIDGET_FILE), 'utf8');
  const trackedLine = findLineContaining(tracked.text, FETCH_CALL_NEEDLE);
  const servedLine = findLineContaining(servedText, FETCH_CALL_NEEDLE);
  const servedLineText = servedText.split(/\r?\n/)[servedLine - 1];
  if (servedLineText === undefined) {
    throw new Error(`Line ${String(servedLine)} of the served ${WIDGET_FILE} could not be read.`);
  }
  return {
    file: WIDGET_FILE,
    trackedLine,
    servedLine,
    servedLineText,
    servedIsPristine: servedText === tracked.text,
    allowedSymbols: new Set([
      ...declaredFunctionNames(servedText),
      ...identifiersOnLine(servedLineText),
    ]),
  };
}

/**
 * Test 2's known location: the fixture's own `sourceLink` location (the
 * widget's click handler), with `line` and `column` re-derived from the tracked
 * source at run time rather than taken from the constants that module records.
 */
async function readKnownHandlerLocation(): Promise<SourceLocation> {
  const template = FIXTURE_SOURCE_LINK_LOCATION;
  const symbol = template.symbol;
  if (template.file !== WIDGET_FILE || symbol === undefined) {
    throw new Error(
      `FIXTURE_SOURCE_LINK_LOCATION no longer names a symbol of ${WIDGET_FILE} (it is ${formatSourceLocation(template)}); update this spec's known location.`,
    );
  }
  const source = await readFixtureSource(template.file);
  const line = findLineContaining(source.text, `function ${symbol}(`);
  const lineText = source.lines[line - 1] ?? '';
  const column = lineText.indexOf(`function ${symbol}(`) + 'function '.length + 1;
  const parsed = parseSourceLocation({ ...template, line, column });
  if (!parsed.ok) {
    throw new Error(
      `The re-derived known location is not a valid SourceLocation: ${parsed.error.message}`,
    );
  }
  return parsed.value;
}

// ---------------------------------------------------------------------------
// Source chips in the panel's DOM
// ---------------------------------------------------------------------------

/**
 * The accessible name of a source chip that opens `file:line` (at `column`,
 * when given). The chip's name always ends with `open <file>:<line>:<column>`
 * — `Open …` for the plain form, `<visible text> — open …` otherwise
 * (`sourceLinkAccessibleName` in `packages/panel-renderer/src/components/SourceLink.tsx`).
 */
function chipNamePattern(file: string, line: number, column?: number): RegExp {
  const position = `${file}:${String(line)}:`;
  const tail = column === undefined ? '\\d+' : String(column);
  return new RegExp(`(?:^|\\s)open ${escapeRegExp(position)}${tail}$`, 'i');
}

/** The `file:line:column` targets of every interactive source chip in `scope`, for diagnostics. */
async function chipTargets(scope: Locator): Promise<string[]> {
  const labels = await scope
    .locator(SOURCE_CHIP_SELECTOR)
    .evaluateAll((chips) => chips.map((chip) => chip.getAttribute('aria-label') ?? ''));
  return labels.map((label) => /open (\S+:\d+:\d+)$/i.exec(label)?.[1] ?? `unparsed "${label}"`);
}

/** A chip to click, the ladder rung that supplied it, and why. */
interface LocatedChip {
  readonly chip: Locator;
  readonly rung: 1 | 2;
  readonly description: string;
}

/**
 * Rung 1: a chip in the generated panel that opens the call site. The panel's
 * views resolve their data queries after the specification renders, so the
 * lookup waits for every busy view to settle before deciding the rung is absent.
 */
async function findGeneratedPanelChip(
  panel: PanelHandle,
  expectation: CallSiteExpectation,
): Promise<LocatedChip | undefined> {
  await expect(panel.panelView.locator(BUSY_SELECTOR)).toHaveCount(0, {
    timeout: PANEL_SETTLE_TIMEOUT_MS,
  });
  const chips = panel.panelView.getByRole('button', {
    name: chipNamePattern(expectation.file, expectation.servedLine),
  });
  if ((await chips.count()) === 0) {
    return undefined;
  }
  return {
    chip: chips.first(),
    rung: 1,
    description:
      'rung 1: a source chip rendered by the generated panel (a suggested location or a row chip)',
  };
}

/**
 * Rung 2: select the captured `fetch` event of the widget's request in the live
 * tail and take the `EventDetails` drawer's chip, which renders the event's own
 * `source` — the initiator location the source-map route resolved.
 *
 * The row is activated through its kind cell rather than its centre, so the
 * click cannot land on the row's own compact source chip and send a
 * `source.open` of its own.
 */
async function findEventDetailsChip(
  panel: PanelHandle,
  expectation: CallSiteExpectation,
): Promise<LocatedChip | undefined> {
  const fetchRows = panel.liveTail
    .getByRole('row')
    .filter({ hasText: PING_PATH })
    .filter({ has: panel.page.getByText(FETCH_KIND, { exact: true }) });
  if ((await fetchRows.count()) === 0) {
    return undefined;
  }
  await fetchRows.first().getByText(FETCH_KIND, { exact: true }).click();
  await expect(panel.eventDetails).toBeVisible();
  await expect(panel.eventDetails.locator(BUSY_SELECTOR)).toHaveCount(0, {
    timeout: PANEL_SETTLE_TIMEOUT_MS,
  });
  const chips = panel.eventDetails.getByRole('button', {
    name: chipNamePattern(expectation.file, expectation.servedLine),
  });
  try {
    await chips.first().waitFor({ state: 'visible', timeout: DEFAULT_WAIT_TIMEOUT_MS });
  } catch {
    return undefined;
  }
  return {
    chip: chips.first(),
    rung: 2,
    description:
      "rung 2: the EventDetails drawer's source chip for the captured fetch event (initiator resolved through the source map)",
  };
}

/**
 * Walk the ladder of the module header and return the first chip that opens
 * the call site, or fail with everything a developer needs to find the defect.
 */
async function locateCallSiteChip(
  panel: PanelHandle,
  expectation: CallSiteExpectation,
): Promise<LocatedChip> {
  const generated = await findGeneratedPanelChip(panel, expectation);
  if (generated !== undefined) {
    return generated;
  }
  const panelTargets = await chipTargets(panel.panelView);
  const drawer = await findEventDetailsChip(panel, expectation);
  if (drawer !== undefined) {
    return drawer;
  }
  const drawerTargets = (await panel.eventDetails.isVisible())
    ? await chipTargets(panel.eventDetails)
    : [];
  const tailRows = await panel.liveTail.getByRole('row').filter({ hasText: PING_PATH }).count();
  throw new Error(
    [
      `No source chip opens the widget's request call site ${expectation.file}:${String(expectation.servedLine)} (the \`${FETCH_CALL_NEEDLE}…\` call).`,
      "That location should come from the source-map route: the fetch initiator stack the browser agent captures (packages/telemetry/src/browser/fetch.ts), mapped through the dev server's chunk source map (packages/code-analysis/src/source-map/resolver.ts) and attached as TelemetryEvent.source by apps/local-service/src/source/resolve.ts — or from a hypothesis' suggested location resolved to the same call site.",
      `Chips in the generated panel: ${panelTargets.length === 0 ? 'none' : panelTargets.join(', ')}.`,
      `Live-tail rows naming ${PING_PATH}: ${String(tailRows)}; chips in the EventDetails drawer: ${drawerTargets.length === 0 ? 'none' : drawerTargets.join(', ')}.`,
      'This is a product defect against AAP §0.8.4 acceptance test 1 (clicking a runtime row opens the editor at the call site), not a reason to relax this assertion.',
    ].join(' '),
  );
}

// ---------------------------------------------------------------------------
// The forwarded `source.open`, observed at the editor connection
// ---------------------------------------------------------------------------

/** The first `source.open` forwarded to the editor for `sessionId` at or after `since`. */
function waitForForwardedOpen(
  editor: EditorClient,
  sessionId: SessionId,
  since: number,
): Promise<RecordedMessage<'source.open'>> {
  return editor.waitFor(
    'source.open',
    (message) =>
      message.payload.sessionId === sessionId &&
      (message.sessionId === undefined || message.sessionId === sessionId) &&
      message.receivedAt >= since,
    { timeoutMs: SOURCE_OPEN_TIMEOUT_MS },
  );
}

/** One click, one forward: no second `source.open` for the session follows the first. */
async function expectSingleForward(
  editor: EditorClient,
  first: RecordedMessage<'source.open'>,
): Promise<void> {
  await editor.expectNoMessage(
    'source.open',
    (message) => message.id !== first.id && message.payload.sessionId === first.payload.sessionId,
    DUPLICATE_OPEN_WINDOW_MS,
  );
}

/**
 * The location contract every forwarded location must meet, whatever route
 * resolved it: a schema-valid location whose `file` is the project-relative
 * POSIX path of a file that exists inside the session's project root.
 */
async function expectProjectRelativeLocation(
  location: SourceLocation,
  session: SessionRecord,
): Promise<void> {
  const parsed = parseSourceLocation(location);
  expect(parsed.ok, 'the forwarded location is a valid SourceLocation').toBe(true);

  const { file } = location;
  expect(isAbsolutePosix(file), `${file} is not an absolute POSIX path`).toBe(false);
  expect(isWindowsAbsolute(file), `${file} is not a Windows absolute path`).toBe(false);
  expect(file.includes('\\'), `${file} uses POSIX separators only`).toBe(false);
  expect(file.split('/'), `${file} has no ".." segment`).not.toContain('..');
  expect(file.split('/'), `${file} has no "." segment`).not.toContain('.');

  // Relative to the session's projectRoot: it resolves back inside that root to
  // the same path, and names a file that is really there.
  const absolute = resolveInsideProject(session.projectRoot, file);
  const entry = await stat(absolute);
  expect(entry.isFile(), `${file} is a file of the served project`).toBe(true);

  expect(SOURCE_RESOLVED_BY, 'resolvedBy is a member of the enumeration').toContain(
    location.resolvedBy,
  );
  expect(typeof location.confidence, 'confidence is present').toBe('number');
  expect(location.confidence).toBeGreaterThanOrEqual(0);
  expect(location.confidence).toBeLessThanOrEqual(1);
}

/** Test 1's field assertions for the call site. */
function expectCallSiteLocation(location: SourceLocation, expectation: CallSiteExpectation): void {
  expect(location.file, 'file is the widget, project-relative').toBe(expectation.file);
  // Zero tolerance: the call expression and the statement that awaits it share
  // one line (`const res = await fetch(…)`), so a route reporting either lands
  // on the same line. A reformat that splits them would move the needle's line
  // and fail `findLineContaining` loudly instead.
  expect(
    location.line,
    `line is the fetch call site in the served ${expectation.file} (${String(expectation.servedLine)})`,
  ).toBe(expectation.servedLine);
  if (expectation.servedIsPristine) {
    expect(location.line, 'the untouched served copy agrees with the tracked fixture').toBe(
      expectation.trackedLine,
    );
  }
  expect(Number.isInteger(location.column), 'column is an integer').toBe(true);
  expect(location.column, 'column is 1-based').toBeGreaterThanOrEqual(1);
  expect(location.column, 'column lies on the call-site line').toBeLessThanOrEqual(
    expectation.servedLineText.length + 1,
  );
  if (location.symbol !== undefined) {
    expect(
      [...expectation.allowedSymbols],
      `symbol "${location.symbol}" is one of the widget's own identifiers`,
    ).toContain(location.symbol);
  }
}

// ---------------------------------------------------------------------------
// Panel health around the click
// ---------------------------------------------------------------------------

/** What the panel showed before the click, so the check after it compares like with like. */
interface PanelHealthBaseline {
  readonly consoleErrorCount: number;
  readonly errorStateCount: number;
}

async function readPanelHealth(panel: PanelHandle): Promise<PanelHealthBaseline> {
  return {
    consoleErrorCount: panel.consoleErrors().length,
    errorStateCount: await panel.page.locator(ERROR_STATE_SELECTOR).count(),
  };
}

/**
 * The editor hop is asynchronous and must not be reported as a failure in the
 * panel: no uncaught exception at any point, no new console error, and no new
 * error state (the actions surface a failed open as one) once the worker's
 * answer to the port request has had time to arrive.
 */
async function expectPanelStillHealthy(
  panel: PanelHandle,
  baseline: PanelHealthBaseline,
): Promise<void> {
  await panel.page.waitForTimeout(PANEL_FAILURE_GRACE_MS);
  const errors = panel.consoleErrors();
  expect(
    errors.filter((entry) => entry.startsWith('uncaught ')),
    'no uncaught exception in the panel page',
  ).toEqual([]);
  expect(errors.slice(baseline.consoleErrorCount), 'no console error after the click').toEqual([]);
  await expect(
    panel.page.locator(ERROR_STATE_SELECTOR),
    'no error state surfaced by the click',
  ).toHaveCount(baseline.errorStateCount);
  await expect(panel.panelView.first(), 'the rendered panel is still on screen').toBeVisible();
}

// ---------------------------------------------------------------------------
// Test 2's inbound-only delivery through the panel's real port
// ---------------------------------------------------------------------------

/**
 * Runs in the panel document before its bundle (after the fixtures' DevTools
 * emulation, whose own port is therefore untouched). It wraps
 * `chrome.runtime.connect` so every port the panel bundle opens — the panel
 * connection is its only call site — is the real port behind a proxy whose
 * `onMessage` records the listeners attached to it and nothing else. It also
 * remembers each port's frame header (`channel`, `version`) from the first
 * frame the worker sent on it, and the full framing (every key but `message`)
 * of the last protocol push relayed on it, so an injected frame is framed by
 * the real wire rather than by constants restated here. `postMessage`,
 * `disconnect`, `onDisconnect` and every other member are the real port's.
 *
 * Serialised into the page: self-contained, plain data in and out.
 */
function installPanelPortTap(args: {
  readonly key: string;
  readonly direction: string;
  readonly kind: string;
}): void {
  if (window.top !== window) {
    return;
  }
  const { key, direction, kind } = args;
  type Listener = (message: unknown, port: unknown) => void;
  interface RealEvent {
    addListener(listener: Listener): void;
    removeListener(listener: Listener): void;
    hasListener(listener: Listener): boolean;
  }
  interface RealPort {
    readonly onMessage: RealEvent;
    readonly onDisconnect: RealEvent;
  }
  interface TapRecord {
    port: unknown;
    open: boolean;
    listeners: Set<Listener>;
    header: Record<string, unknown> | undefined;
    pushFraming: Record<string, unknown> | undefined;
    seen: string[];
  }
  const host = globalThis as unknown as {
    chrome?: { runtime?: { connect?: (...args: unknown[]) => RealPort } };
  };
  const runtime = host.chrome?.runtime;
  const connect = runtime?.connect;
  if (runtime === undefined || typeof connect !== 'function') {
    return;
  }
  const records: TapRecord[] = [];
  Object.defineProperty(window, key, { value: { records }, configurable: true });

  const tapped = (...args: unknown[]): unknown => {
    const real = connect.apply(runtime, args);
    const record: TapRecord = {
      port: real,
      open: true,
      listeners: new Set(),
      header: undefined,
      pushFraming: undefined,
      seen: [],
    };
    real.onMessage.addListener((message) => {
      if (typeof message !== 'object' || message === null) {
        return;
      }
      const frame = message as Record<string, unknown>;
      record.seen = [...record.seen, `${String(frame.direction)}:${String(frame.kind)}`].slice(-20);
      // Every frame on the port opens with the same header; the first one
      // (the hydration answer every new port receives) is enough.
      record.header ??= { channel: frame.channel, version: frame.version };
      if (frame.direction === direction && frame.kind === kind && 'message' in frame) {
        const framing: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(frame)) {
          if (name !== 'message') {
            framing[name] = value;
          }
        }
        record.pushFraming = framing;
      }
    });
    real.onDisconnect.addListener(() => {
      record.open = false;
    });
    const onMessage: RealEvent = {
      addListener(listener) {
        record.listeners.add(listener);
        real.onMessage.addListener(listener);
      },
      removeListener(listener) {
        record.listeners.delete(listener);
        real.onMessage.removeListener(listener);
      },
      hasListener(listener) {
        return real.onMessage.hasListener(listener);
      },
    };
    const proxy = new Proxy(real, {
      get(target, property) {
        if (property === 'onMessage') {
          return onMessage;
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...inner: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    record.port = proxy;
    records.push(record);
    return proxy;
  };
  Object.defineProperty(runtime, 'connect', { value: tapped, configurable: true, writable: true });
}

/** The tap installer as an init-script body, for `openPanelPage({ initScripts })`. */
const PANEL_PORT_TAP_SCRIPT = `(${installPanelPortTap.toString()})(${JSON.stringify({
  key: PANEL_PORT_TAP_GLOBAL,
  ...RELAYED_PUSH_DISCRIMINANTS,
})});`;

/** What the in-page tap reports: whether a frame can be delivered yet, and what the port carried. */
interface TapState {
  readonly readiness: 'ready' | 'no-tap' | 'no-open-port' | 'no-frame-yet';
  /** `direction:kind` of the newest frames on the newest open port, oldest first. */
  readonly seen: readonly string[];
}

/** Runs in the panel page: the tap's readiness to deliver a frame. */
function readTapState(key: string): TapState {
  const tap = (window as unknown as Record<string, unknown>)[key] as
    | { records: { open: boolean; listeners: Set<unknown>; header: unknown; seen: string[] }[] }
    | undefined;
  if (tap === undefined) {
    return { readiness: 'no-tap', seen: [] };
  }
  const open = tap.records.filter((record) => record.open && record.listeners.size > 0);
  const newest = open.at(-1);
  if (newest === undefined) {
    return { readiness: 'no-open-port', seen: [] };
  }
  return { readiness: newest.header === undefined ? 'no-frame-yet' : 'ready', seen: newest.seen };
}

/**
 * Runs in the panel page: hand `message` to the listeners of the newest open
 * panel port, framed exactly like a protocol push that port already relayed
 * when there was one, else with the port's own header and the two push
 * discriminants. Answers how many listeners received it.
 */
function deliverRelayedMessage(args: {
  readonly key: string;
  readonly direction: string;
  readonly kind: string;
  readonly message: unknown;
}): number {
  type Listener = (message: unknown, port: unknown) => void;
  const tap = (window as unknown as Record<string, unknown>)[args.key] as
    | {
        records: {
          port: unknown;
          open: boolean;
          listeners: Set<Listener>;
          header: Record<string, unknown> | undefined;
          pushFraming: Record<string, unknown> | undefined;
        }[];
      }
    | undefined;
  const record = tap?.records
    .filter((candidate) => candidate.open && candidate.listeners.size > 0)
    .at(-1);
  if (record?.header === undefined) {
    return 0;
  }
  const framing = record.pushFraming ?? {
    ...record.header,
    direction: args.direction,
    kind: args.kind,
  };
  const frame = { ...framing, message: args.message };
  const listeners = [...record.listeners];
  for (const listener of listeners) {
    listener(frame, record.port);
  }
  return listeners.length;
}

/**
 * Deliver one relayed protocol frame to the panel through its real port's
 * listeners, once the worker has answered on that port at least once.
 */
async function deliverToPanel(
  panel: PanelHandle,
  message: MessageByType<'panel.generated'>,
): Promise<void> {
  let state: TapState = { readiness: 'no-tap', seen: [] };
  await expect
    .poll(
      async () => {
        state = await panel.page.evaluate(readTapState, PANEL_PORT_TAP_GLOBAL);
        return state.readiness;
      },
      {
        message: 'the panel port tap is installed and the worker has answered on the port',
        timeout: DEFAULT_WAIT_TIMEOUT_MS,
        intervals: [POLL_INTERVAL_MS],
      },
    )
    .toBe('ready');
  const received = await panel.page.evaluate(deliverRelayedMessage, {
    key: PANEL_PORT_TAP_GLOBAL,
    ...RELAYED_PUSH_DISCRIMINANTS,
    message,
  });
  expect(
    received,
    `the panel connection received the delivered frame (port carried: ${state.seen.join(', ')})`,
  ).toBeGreaterThan(0);
}

/**
 * A validated `panel.generated` payload whose panel holds exactly one node: a
 * `sourceLink` leaf pointing at `location`. Validated by the protocol's own
 * payload schema, which embeds the one panel specification schema.
 */
function buildSourceLinkPanel(
  sessionId: SessionId,
  location: SourceLocation,
): PanelGeneratedPayload {
  const panelId = newPanelId();
  const candidate = {
    sessionId,
    panelId,
    panel: {
      version: 1,
      id: panelId,
      sessionId,
      panelVersion: 1,
      title: CONTRACT_PANEL_TITLE,
      summary: { observed: [], likelyCauses: [] },
      layout: [{ type: 'sourceLink', id: 'layout.0', title: CONTRACT_NODE_TITLE, location }],
    },
  };
  const parsed = parsePanelGeneratedPayload(candidate);
  if (!parsed.ok) {
    throw new Error(
      `The contract panel is not a valid panel.generated payload: ${parsed.error.message}`,
    );
  }
  return parsed.value;
}

// ---------------------------------------------------------------------------
// The documented working order, up to a session that is ready to capture
// ---------------------------------------------------------------------------

/** The fixtures `startBoundSession` drives. */
interface SessionFixtures {
  readonly pairing: PairingHandle;
  readonly sessions: SessionHelper;
  readonly openPanelPage: (options?: OpenPanelOptions) => Promise<PanelHandle>;
  readonly editorClient: EditorClient;
}

/** A session bound to the inspected fixture-app tab, and the panel inspecting it. */
interface BoundSession {
  readonly session: SessionRecord;
  readonly panel: PanelHandle;
}

/**
 * Pair, create the session, open the panel (which binds the inspected tab by
 * origin), then wait for the binding on both sides and for the session to be
 * ready — every wait scoped to this session's id.
 */
async function startBoundSession(
  fixtures: SessionFixtures,
  question: string,
  panelOptions?: OpenPanelOptions,
): Promise<BoundSession> {
  const { pairing, sessions, openPanelPage, editorClient } = fixtures;
  await pairing.ensurePaired();
  editorClient.clear();
  const created = await sessions.create(question);
  const panel = await openPanelPage(panelOptions);
  await panel.waitForConnected();
  await panel.waitForBound(created.id);
  await editorClient.waitFor(
    'session.bound',
    (message) => message.payload.sessionId === created.id && message.payload.tabId === panel.tabId,
  );
  const session = await sessions.waitForReady(created.id);
  return { session, panel };
}

// ---------------------------------------------------------------------------
// The specs
// ---------------------------------------------------------------------------

test.describe('source navigation: a SourceLink click reaches the editor as source.open', () => {
  test('a chip for the captured fetch call site opens it at the right file, line and column', async ({
    pairing,
    sessions,
    openPanelPage,
    editorClient,
    appPage,
  }, testInfo: TestInfo) => {
    test.setTimeout(ROUND_TRIP_TEST_TIMEOUT_MS);
    const { session, panel } = await startBoundSession(
      { pairing, sessions, openPanelPage, editorClient },
      ROUND_TRIP_QUESTION,
    );

    // Reproduce: one click on the widget, inside one capture window.
    await appPage.bringToFront();
    await sessions.capture(session.id, async () => {
      const reply = appPage.waitForResponse(
        (response) => new URL(response.url()).pathname === PING_PATH,
        { timeout: PING_REPLY_TIMEOUT_MS },
      );
      await appPage.getByTestId('ping-button').click();
      expect((await reply).ok(), `${PING_PATH} answered`).toBe(true);
      await expect(appPage.getByTestId('ping-button')).toBeEnabled({
        timeout: PING_REPLY_TIMEOUT_MS,
      });
      await expect(appPage.getByTestId('ping-result')).not.toBeEmpty();
    });

    // The real pipeline answers: an analysis, then a generated panel.
    await editorClient.waitFor(
      'analysis.completed',
      (message) => message.payload.sessionId === session.id,
      { timeoutMs: ANALYSIS_TIMEOUT_MS },
    );
    const generated = await editorClient.waitFor(
      'panel.generated',
      (message) => message.payload.sessionId === session.id,
      { timeoutMs: ANALYSIS_TIMEOUT_MS },
    );
    await panel.page.bringToFront();
    await panel.waitForPanelSpec({
      title: generated.payload.panel.title,
      timeoutMs: PANEL_SETTLE_TIMEOUT_MS,
    });

    const expectation = await readCallSiteExpectation(session);
    const located = await locateCallSiteChip(panel, expectation);
    testInfo.annotations.push({ type: 'source-navigation-rung', description: located.description });

    const baseline = await readPanelHealth(panel);
    editorClient.clear();
    const clickedAt = Date.now();
    await located.chip.click();
    const forwarded = await waitForForwardedOpen(editorClient, session.id, clickedAt);

    await expectProjectRelativeLocation(forwarded.payload.location, session);
    expectCallSiteLocation(forwarded.payload.location, expectation);
    await expectSingleForward(editorClient, forwarded);
    await expectPanelStillHealthy(panel, baseline);
  });

  test('a sourceLink node with a known location is forwarded to the editor field for field', async ({
    pairing,
    sessions,
    openPanelPage,
    editorClient,
  }) => {
    test.setTimeout(CONTRACT_TEST_TIMEOUT_MS);
    const known = await readKnownHandlerLocation();
    const { session, panel } = await startBoundSession(
      { pairing, sessions, openPanelPage, editorClient },
      CONTRACT_QUESTION,
      { initScripts: [PANEL_PORT_TAP_SCRIPT] },
    );

    const payload = buildSourceLinkPanel(session.id, known);
    await deliverToPanel(panel, createEnvelope('panel.generated', payload));
    await panel.waitForPanelSpec({
      title: payload.panel.title,
      timeoutMs: PANEL_SETTLE_TIMEOUT_MS,
    });

    const chip = panel.panelView.getByRole('button', {
      name: chipNamePattern(known.file, known.line, known.column),
    });
    await expect(chip, `one interactive chip opens ${formatSourceLocation(known)}`).toHaveCount(1);

    const baseline = await readPanelHealth(panel);
    editorClient.clear();
    const clickedAt = Date.now();
    await chip.click();
    const forwarded = await waitForForwardedOpen(editorClient, session.id, clickedAt);

    await expectProjectRelativeLocation(forwarded.payload.location, session);
    expect(
      forwarded.payload.location,
      'the forwarded location is the clicked one: file, line, column, symbol, resolvedBy and confidence',
    ).toStrictEqual(known);
    await expectSingleForward(editorClient, forwarded);
    await expectPanelStillHealthy(panel, baseline);
  });
});
