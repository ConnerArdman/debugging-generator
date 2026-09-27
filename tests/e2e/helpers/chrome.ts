/**
 * The browser side of the `e2e` Playwright project: one persistent Chromium
 * context with the unpacked Manifest V3 extension, the DevTools panel surface,
 * the real pairing flow, element selection, and the panel DOM accessors every
 * end-to-end spec asserts through.
 *
 * ## What this module owns
 *
 * - **The persistent context** ({@link launchExtensionContext}): the built
 *   extension from `apps/chrome-extension/dist` loaded into a fresh, temporary
 *   profile, its MV3 service worker, and the extension id derived from the
 *   worker's `chrome-extension://<id>/…` URL. The worker suspends after roughly
 *   30 seconds of idleness, so the handle re-acquires it on demand
 *   ({@link ExtensionContextHandle.getServiceWorker}) instead of trusting a
 *   cached `Worker`.
 * - **The DevTools surface** ({@link openPanelPage}): the built `devtools.html`
 *   and the built panel document, both opened as ordinary extension pages with
 *   one test-owned `chrome.devtools` stub ({@link installDevtoolsStub}). The
 *   real `src/devtools/devtools.ts` therefore runs: it creates the panel,
 *   announces the inspected tab with `devtools.hello` (which is what makes the
 *   worker send `session.bind`), keeps the DevTools port open for the binding's
 *   lifetime, and answers `panels.elements.onSelectionChanged` by evaluating its
 *   own `$0` descriptor expression. The stub's `inspectedWindow.eval` evaluates
 *   the product's expression string inside the inspected application page, with
 *   a test-supplied `$0`.
 * - **Pairing** ({@link ensurePaired}): the product's own pairing flow
 *   (`docs/SECURITY.md`, "Pairing the Chrome extension") —
 *   `POST /pair/start` with the editor credential, the one-time code typed into
 *   the panel's `PairDialog`, and `pair.complete` issued by the service worker
 *   from its `chrome-extension://<id>` origin.
 * - **Element selection** ({@link selectTarget}): `$0` → the product's
 *   descriptor expression → the MAIN-world agent's `describeTarget` → the
 *   worker → `target.selected` at the service.
 * - **The panel accessor map** ({@link panelLocators}): the single place the
 *   panel's roles, accessible names, visible strings and renderer classes are
 *   written down. `@debuggen/panel-renderer` is deliberately not resolvable from
 *   `tests/**`, so every rendering assertion goes through this DOM contract.
 *
 * ## What this module never does
 *
 * - It never mints, injects, reads out, asserts on or logs a credential or a
 *   pairing code. Storage is inspected for shape only (key present, version and
 *   token length), and console lines forwarded to the report are scrubbed.
 * - It never fabricates a `SelectedTarget` in Node and never sends
 *   `target.selected` from the editor client: that frame travels DevTools →
 *   service, and the `vscode` role is not authorised for it.
 * - It never writes under `apps/demo-app`, `tests/fixtures/sample-next-app` or
 *   `apps/chrome-extension/dist` (a build artefact this module only reads), and
 *   it never kills or restarts the service worker.
 * - It never sleeps: every wait is `expect.poll`, locator auto-waiting or a
 *   protocol message on the editor client.
 *
 * ## Relationship to `tests/browser/fixtures.ts`
 *
 * That file established the idioms this one mirrors — the persistent-context
 * launch options, the `extensionId`-from-worker-URL derivation, the worker
 * acquisition with its `waitForEvent('serviceworker')` fallback, tab resolution
 * by URL through `chrome.tabs.query`, the shape-only credential check, and
 * `resetExtensionState()` clearing `BINDING_STORAGE_KEY` while keeping the
 * paired credential. It is deliberately **not imported**: it belongs to another
 * Playwright project, wires its own app-start contract into fixtures, and types
 * a narrower `ServiceHandle`. Deliberate divergences, each for a reason:
 *
 * - The browser suite *emulates* the DevTools page (its stub opens
 *   `PORT_DEVTOOLS` and posts `devtools.hello` itself) and refuses
 *   `inspectedWindow.eval`. The e2e suite must exercise element selection
 *   end to end, so it opens the **real** built DevTools page and answers `eval`
 *   in the inspected page.
 * - Polling uses `expect.poll` rather than a hand-rolled delay loop, per this
 *   folder's no-sleep rule.
 * - The panel document's path is resolved from the built output
 *   ({@link panelPageUrl}) rather than restated, because crxjs owns the emitted
 *   layout.
 *
 * This file declares no `test(...)`, `describe(...)` or fixture.
 *
 * @module tests/e2e/helpers/chrome
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, LaunchOptions, Locator, Page, Worker } from '@playwright/test';

import {
  DEFAULT_SERVICE_BASE_URL,
  PANEL_CONNECTION_LABELS,
  PANEL_CONNECTION_STATUSES,
} from '@debuggen/chrome-extension/messages';
import type { PanelConnectionStatus } from '@debuggen/chrome-extension/messages';
import {
  DEVTOOLS_TOKEN_STORAGE_KEY,
  parseServiceEndpoint,
  SERVICE_ENDPOINT_STORAGE_KEY,
  STORED_CREDENTIAL_VERSION,
} from '@debuggen/chrome-extension/auth';
import { BINDING_STORAGE_KEY } from '@debuggen/chrome-extension/tab-registry';
import { selectedTargetSchema } from '@debuggen/instrumentation/schema';
import type { SelectedTarget } from '@debuggen/instrumentation/schema';
import {
  isPanelNodeType,
  PANEL_LAYOUT_NODE_TYPES,
  PANEL_VIZ_NODE_TYPES,
} from '@debuggen/panel-schema';
import type { PanelNodeType } from '@debuggen/panel-schema';
import { SESSION_STATUSES } from '@debuggen/protocol';
import type { SessionStatus } from '@debuggen/protocol';

import { extensionPath as configuredExtensionPath } from '../../../playwright.config';
import { repoPath } from './repo';
import { DEFAULT_WAIT_TIMEOUT_MS, POLL_INTERVALS_MS } from './service';
import type { EditorClientHandle, MessagePayload, ServiceHandle } from './service';

export type { PanelConnectionStatus, SelectedTarget };

// ---------------------------------------------------------------------------
// Budgets and bounds — named once so no caller restates a magic number
// ---------------------------------------------------------------------------

/**
 * How long the MV3 worker may take to register after launch (or after a wake).
 * Mirrors `WORKER_READY_TIMEOUT_MS` in `tests/browser/fixtures.ts`.
 */
export const WORKER_READY_TIMEOUT_MS = 15_000;

/**
 * How long each pairing phase may take (the pill settling, the code being
 * accepted). Mirrors `PAIRING_TIMEOUT_MS` in `tests/browser/fixtures.ts`.
 */
export const PAIRING_TIMEOUT_MS = 30_000;

/** How long an opened panel document may take to show its wordmark and a connection label. */
export const PANEL_READY_TIMEOUT_MS = 15_000;

/** How long the real DevTools page may take to create its panel and subscribe to selection changes. */
export const DEVTOOLS_PAGE_READY_TIMEOUT_MS = 10_000;

/** How long a freshly navigated page may take to appear in `chrome.tabs.query`. */
export const TAB_RESOLVE_TIMEOUT_MS = 10_000;

/**
 * How long the product may take to evaluate its `$0` expression after a
 * selection change (its own debounce is 75 ms and its eval budget 2 000 ms,
 * `src/devtools/devtools.ts`), before this module falls back to the panel's
 * picker.
 */
export const SELECTION_EVAL_TIMEOUT_MS = 5_000;

/** How long a selected element may take to reach the service's session record. */
export const TARGET_SELECTION_TIMEOUT_MS = 15_000;

/** How many console lines each panel handle retains (the oldest are dropped first). */
export const PANEL_CONSOLE_LOG_LIMIT = 200;

/** The longest console line retained; longer lines are truncated with an ellipsis. */
export const PANEL_CONSOLE_LINE_MAX_LENGTH = 500;

/** How many inspected-window evaluations each panel handle retains for diagnostics. */
const EVAL_LOG_LIMIT = 100;

/** How many panel-side errors a failure message quotes. */
const ERRORS_QUOTED = 5;

/**
 * How many teardown failures one rejection of a `close()` quotes; any further
 * failures are counted, not quoted.
 */
const TEARDOWN_FAILURES_QUOTED = 8;

/** The longest single teardown failure quoted, in characters (one line, scrubbed). */
const TEARDOWN_FAILURE_MAX_LENGTH = 500;

/** The longest teardown rejection message, in characters. */
const TEARDOWN_MESSAGE_MAX_LENGTH = 2_000;

/**
 * How many problems a context retains from its life for
 * {@link ExtensionContextHandle.close} to report (the oldest are kept, later
 * ones are counted), so a context that leaks a wake-up page on every worker
 * re-acquisition cannot grow without bound.
 */
const DEFERRED_PROBLEMS_LIMIT = TEARDOWN_FAILURES_QUOTED;

/** The mutable interval list `expect.poll` wants, derived from the service helper's bounds. */
const POLL_INTERVALS: number[] = [...POLL_INTERVALS_MS];

// ---------------------------------------------------------------------------
// Fixed vocabulary — each value names the file it was read from
// ---------------------------------------------------------------------------

/** The URL scheme of every extension document and of the worker. */
const EXTENSION_SCHEME = 'chrome-extension:';

/**
 * Chrome extension ids are 32 characters from `a`–`p` (a base-16 alphabet
 * shifted to letters), which is stricter than "32 lowercase characters".
 */
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/**
 * The panel document as `vite.config.ts` (`PANEL_HTML`) builds it and
 * `src/devtools/devtools.ts` (`PANEL_PAGE_PATH`) hands it to
 * `chrome.devtools.panels.create`. Only a fallback: {@link panelPageUrl} first
 * reads the path the built DevTools bundle actually passes.
 */
const PANEL_DOCUMENT_FALLBACK = 'src/panel/panel.html';

/**
 * The name of the `page.exposeBinding` the stub's `inspectedWindow.eval`
 * forwards to. Test-owned; no product code reads it.
 */
const EVAL_BINDING = '__debuggenE2eInspectedEval';

/** The window property holding the stub's test-only control surface. Test-owned. */
const STUB_CONTROL_GLOBAL = '__debuggenE2eDevtoolsStub';

/**
 * A port name the worker does not recognise. Connecting it wakes a suspended
 * MV3 worker (every `runtime.onConnect` dispatch starts the worker), and
 * `background/ports.ts` refuses and disconnects an unknown name without any
 * other effect.
 */
const WAKE_PORT_NAME = 'debuggen.e2e-wake';

/**
 * `chrome.devtools.panels.themeName` per theme, as the panel maps it
 * (`src/panel/theme.ts`): `'dark'` (like DevTools' `'default'`) selects the
 * dark token set, and `'light'` is the one name that selects the light set.
 */
const DEVTOOLS_THEME_NAMES = Object.freeze({ dark: 'dark', light: 'light' } as const);

/**
 * The panel's visible strings, each copied from the module-private constant
 * named beside it (`apps/chrome-extension/src/panel/**`). The connection
 * labels are NOT here: they are imported from `messages.ts`.
 */
const PANEL_STRINGS = Object.freeze({
  /** `components/Header.tsx` `WORDMARK`. */
  wordmark: 'Debug Generator',
  /** `components/ConnectionStatus.tsx` `PAIR_ACTION_LABEL`. */
  pairAction: 'Pair…',
  /** `components/PairDialog.tsx` `PAIR_DIALOG_TITLE`. */
  pairDialogTitle: 'Pair this panel with VS Code',
  /** `components/PairDialog.tsx` `PAIRING_FIELD_LABEL`. */
  pairingField: 'Pairing code',
  /** `components/PairDialog.tsx` `SERVICE_ADDRESS_FIELD_LABEL`. */
  serviceAddressField: 'Service address',
  /** `components/PairDialog.tsx` `PAIR_ACTION_LABEL`. */
  pairSubmit: 'Pair',
  /** `components/PairDialog.tsx` `CANCEL_ACTION_LABEL`. */
  pairCancel: 'Cancel',
  /** `components/PairDialog.tsx` `FAILURE_TITLE`. */
  pairFailure: 'Pairing failed',
  /** `components/CaptureControls.tsx` `START_CAPTURE_LABEL`. */
  startCapture: 'Start capture',
  /** `components/CaptureControls.tsx` `STOP_CAPTURE_LABEL`. */
  stopCapture: 'Stop capture',
  /** `components/CaptureControls.tsx` `LIVE_COUNTER_LABEL`. */
  liveCounter: 'Events received during the running capture',
  /** `components/CaptureControls.tsx` `LAST_COUNTER_LABEL`. */
  lastCounter: 'Events received by the last capture',
  /** `components/TargetPicker.tsx` `PICK_LABEL`. */
  pickElement: 'Pick element',
  /** `components/TargetPicker.tsx` `USE_SELECTED_LABEL`. */
  useSelectedElement: 'Use selected element',
  /** `components/TargetPicker.tsx` `NO_TARGET_LABEL`. */
  noTarget: 'No element selected',
  /** `components/TargetPicker.tsx` `TARGET_LABEL`. */
  targetLabel: 'Target',
  /** `components/EmptyPanel.tsx` `EMPTY_PANEL_HEADLINE`. */
  emptyPanel: 'No session yet — start one from the Debug Generator view in VS Code',
  /** `App.tsx`: the `lastError` ErrorState title. */
  requestFailed: 'A Debug Generator request did not complete',
  /** `components/SessionSummary.tsx`: the region's accessible name. */
  sessionSummary: 'Session',
  /** `App.tsx`: the `<aside>` wrapping `EventDetails`. */
  eventDetails: 'Selected event',
  /** `components/EventDetails.tsx` `CLOSE_ACCESSIBLE_NAME`. */
  closeEventDetails: 'Close event details',
  /** `App.tsx`: the `<section>` wrapping `LiveTail`. */
  liveTail: 'Live event tail',
  /** `components/LiveTail.tsx` `TABLE_CAPTION`. */
  liveTailCaption: 'Live events, newest first',
  /** `packages/panel-renderer/src/layout/SummaryHeader.tsx`: the observed region's heading. */
  observed: 'Observed',
  /** `packages/panel-renderer/src/layout/SummaryHeader.tsx`: the likely-cause region's heading. */
  likelyCause: 'Likely cause',
} as const);

/**
 * Renderer and panel classes, each read from the file named beside it. The
 * renderer publishes no `data-testid`; these block classes are its stable
 * styling contract (`packages/panel-renderer/src/styles/components.css`).
 */
const PANEL_CLASSES = Object.freeze({
  /** `host/PanelHost.tsx`: one per rendered panel. */
  panel: 'dg-panel',
  /** `host/PanelHost.tsx`: the fallback banner (`meta.fallback`). */
  fallbackBanner: 'dg-panel__banner--fallback',
  /** `host/NodeRenderer.tsx` `NODE_CLASS`: the wrapper of every node. */
  node: 'dg-panel__node',
  /** `host/NodeRenderer.tsx`: the wrapper of a node that could not be rendered. */
  nodeError: 'dg-panel__node-error',
  /** `primitives/ErrorState.tsx`. */
  errorState: 'dg-error-state',
  /** `primitives/LoadingState.tsx`. */
  loadingState: 'dg-loading-state',
  /** `primitives/Badge.tsx`. */
  badge: 'dg-badge',
  /** `layout/SummaryHeader.tsx`: the panel title heading. */
  summaryTitle: 'dg-summary-header__title',
  /** `layout/SummaryHeader.tsx`: the non-evidentiary headline. */
  summaryHeadline: 'dg-summary-header__headline',
  /** `layout/SummaryHeader.tsx`: one observed fact. */
  summaryFact: 'dg-summary-header__fact',
  /** `layout/SummaryHeader.tsx`: the evidence list under a fact or cause. */
  summaryEvidence: 'dg-summary-header__evidence',
  /** `layout/SummaryHeader.tsx`: a cause's confidence badge. */
  summaryConfidence: 'dg-summary-header__confidence',
  /** `components/SourceLink.tsx`: the chip. */
  sourceLink: 'dg-source-link',
  /** `primitives/DataTable.tsx`: the positioning wrapper of one virtualised row. */
  virtualRow: 'dg-virtual-row',
} as const);

/**
 * The block class each node type's component roots itself in, typed as a
 * `Record` over the imported `PanelNodeType` (the vocabulary of
 * `PANEL_NODE_TYPES`), so a new node type is a compile error here.
 * `NodeRenderer.tsx` emits no node-type attribute or class (its wrapper carries
 * only `data-node-path`, a diagnostic), so {@link panelLocators}'
 * `renderedNodeTypes()` derives the set from these per-component landmarks:
 *
 * | Node type | Component (`packages/panel-renderer/src/…`) |
 * |---|---|
 * | `section` / `split` / `stack` | `layout/Section.tsx`, `layout/Split.tsx`, `layout/Stack.tsx` |
 * | `table` | `components/SpanTable.tsx` (via `host/registry.ts` `TableNodeAdapter`) |
 * | every other type | the component of the same name in `components/` |
 */
const NODE_TYPE_BLOCK_CLASSES = Object.freeze({
  section: 'dg-section',
  split: 'dg-split',
  stack: 'dg-stack',
  timeline: 'dg-timeline',
  waterfall: 'dg-waterfall',
  eventLog: 'dg-event-log',
  metricCards: 'dg-metric-cards',
  flame: 'dg-flame',
  table: 'dg-span-table',
  renderTable: 'dg-render-table',
  componentTree: 'dg-component-tree',
  requestTable: 'dg-request-table',
  queryTable: 'dg-query-table',
  stateTransitions: 'dg-state-transitions',
  dependencyGraph: 'dg-dependency-graph',
  sourceLink: 'dg-source-link',
} satisfies Record<PanelNodeType, string>);

/**
 * The `[nodeType, blockClass]` pairs in the order they are tried: every leaf
 * first, then the containers. A leaf's root may also carry a layout class
 * (`RenderTable` roots itself in a `Stack`, so it carries both `dg-stack` and
 * `dg-render-table`), and the leaf is what it is.
 */
const NODE_BLOCKS_IN_MATCH_ORDER: readonly (readonly [PanelNodeType, string])[] = [
  ...PANEL_VIZ_NODE_TYPES,
  ...PANEL_LAYOUT_NODE_TYPES,
].map((type) => [type, NODE_TYPE_BLOCK_CLASSES[type]] as const);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** A readable one-liner for an unknown failure. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Whether `value` is a plain object (not `null`, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A trimmed, non-empty string, or `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** Whether `url` is an extension document or worker URL. */
function isExtensionUrl(url: string): boolean {
  try {
    return new URL(url).protocol === EXTENSION_SCHEME;
  } catch {
    return false;
  }
}

/** The `host` of `url` (the extension id, for an extension URL), or `''`. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** The origin of `url`, or `undefined` when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Whether `url` is an absolute `http:`/`https:` URL — the only kind a tab can be inspected at. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Escape a literal for a `RegExp`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape a value for a double-quoted CSS attribute selector. */
function cssAttributeValue(text: string): string {
  return text.replace(/["\\]/g, '\\$&');
}

/** `text` cut to `max` characters, with an ellipsis when it was longer. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Anything shaped like a credential: a run of 32 or more token characters.
 * The devtools and editor credentials are 32 random bytes, so their encodings
 * are always at least this long.
 */
const TOKEN_LIKE = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/** The replacement for anything {@link scrub} removes. */
const REDACTED = '[redacted]';

/**
 * Remove every credential-shaped run and every registered one-time value (the
 * pairing code) from a line bound for a report or an error message.
 */
function scrub(text: string, secrets: ReadonlySet<string>): string {
  let clean = text.replace(TOKEN_LIKE, REDACTED);
  for (const secret of secrets) {
    if (secret !== '') {
      clean = clean.split(secret).join(REDACTED);
    }
  }
  return clean;
}

/** The running test's info, or `undefined` outside a test (module load, a worker hook). */
function currentTestInfo(): ReturnType<typeof test.info> | undefined {
  try {
    return test.info();
  } catch {
    return undefined;
  }
}

/** Whether the running test (if any) has failed or otherwise not met its expected status. */
function currentTestFailed(): boolean {
  const info = currentTestInfo();
  return info !== undefined && info.status !== undefined && info.status !== info.expectedStatus;
}

/** The state a {@link pollUntilReady} probe reports when its condition holds. */
const READY = 'ready';

/**
 * Run a bounded `expect.poll` whose probe returns {@link READY} or a
 * description of the state it saw; on timeout, throw `failure(lastSeen)` with
 * the poll's own error as the cause, so the report names the state rather than
 * "expected 'ready'".
 */
async function pollUntilReady(
  probe: () => Promise<string>,
  timeoutMs: number,
  failure: (lastSeen: string) => string,
): Promise<void> {
  let lastSeen = 'no observation yet';
  try {
    await expect
      .poll(
        async () => {
          try {
            const seen = await probe();
            lastSeen = seen;
            return seen;
          } catch (error) {
            lastSeen = `probe failed: ${describeError(error)}`;
            return lastSeen;
          }
        },
        { timeout: timeoutMs, intervals: POLL_INTERVALS },
      )
      .toBe(READY);
  } catch (error) {
    throw new Error(failure(lastSeen), { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Bounded teardown — every close attempted, every failure reported
// ---------------------------------------------------------------------------
//
// A close that fails is a leak: a Chromium process, a profile directory or a
// tab outliving the test that owned it. So no close here is ever silenced.
// Each step runs even when an earlier one failed, each failure is recorded as
// one scrubbed, bounded line, and the caller receives one rejection naming
// them (`tests/e2e/helpers/fixtures.ts` runs every close through its
// `runSteps`/`throwIfProblems`, which turn that rejection into a failed
// worker or test). The action labels are composed here from non-secret values
// (a tab id, the profile path, a page's role) and are kept verbatim; only the
// error text, which this module does not control, is scrubbed.

/** No one-time values to scrub: the context-level teardown never handles a pairing code. */
const NO_SECRETS: ReadonlySet<string> = new Set();

/** One teardown failure as a single scrubbed line of at most {@link TEARDOWN_FAILURE_MAX_LENGTH} characters. */
function teardownFailure(action: string, error: unknown, secrets: ReadonlySet<string>): string {
  const detail = scrub(describeError(error), secrets).replace(/\s+/g, ' ').trim();
  return truncate(`${action}: ${detail}`, TEARDOWN_FAILURE_MAX_LENGTH);
}

/**
 * Run one teardown step, recording its failure in `failures` instead of
 * throwing, so the next step is still attempted.
 */
async function attemptTeardown(
  failures: string[],
  action: string,
  step: () => Promise<unknown>,
  secrets: ReadonlySet<string> = NO_SECRETS,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    failures.push(teardownFailure(action, error, secrets));
  }
}

/**
 * Close `page` and confirm it reports closed. A rejected `close()` and a page
 * still open afterwards (a leaked tab) are each recorded; nothing throws.
 * Playwright's `page.close()` already resolves for a page whose context or
 * browser went away first, so a recorded rejection is a real failure.
 *
 * @param label The page's role in the failure line, for example `panel page`.
 */
async function closePageInto(
  failures: string[],
  label: string,
  page: Page,
  secrets: ReadonlySet<string> = NO_SECRETS,
): Promise<void> {
  await attemptTeardown(failures, `closing the ${label}`, () => page.close(), secrets);
  if (!page.isClosed()) {
    failures.push(`the ${label} still reports open after close() — the tab leaked`);
  }
}

/**
 * One bounded rejection message: `summary`, how many steps failed, the first
 * {@link TEARDOWN_FAILURES_QUOTED} failures and a count of the rest, cut to
 * {@link TEARDOWN_MESSAGE_MAX_LENGTH} characters. The failures come first so a
 * caller that truncates the message again still sees them.
 *
 * @example
 * teardownMessage('Closing the panel of tab 7 was incomplete', ['closing the panel page: Error: …'])
 * // → 'Closing the panel of tab 7 was incomplete: 1 teardown failure(s) — closing the panel page: Error: …'
 */
function teardownMessage(summary: string, failures: readonly string[]): string {
  const quoted = failures.slice(0, TEARDOWN_FAILURES_QUOTED);
  const unquoted = failures.length - quoted.length;
  const rest = unquoted > 0 ? `; and ${String(unquoted)} more` : '';
  return truncate(
    `${summary}: ${String(failures.length)} teardown failure(s) — ${quoted.join('; ')}${rest}`,
    TEARDOWN_MESSAGE_MAX_LENGTH,
  );
}

/** `' ' + teardownMessage(summary, failures)`, or `''` when nothing failed — a suffix for another message. */
function teardownSuffix(summary: string, failures: readonly string[]): string {
  return failures.length === 0 ? '' : ` ${teardownMessage(summary, failures)}`;
}

/**
 * The error to rethrow for a failed operation whose cleanup has run: `error`
 * itself when the cleanup was clean; otherwise a new error whose message is
 * `error`'s description first and the bounded cleanup failures after it, with
 * `error` kept as its `cause`. The failure being reported always leads — the
 * cleanup is what the operation's failure left behind.
 */
function withCleanupFailures(
  error: unknown,
  summary: string,
  failures: readonly string[],
): unknown {
  if (failures.length === 0) {
    return error;
  }
  return new Error(`${describeError(error)}${teardownSuffix(summary, failures)}`, {
    cause: error,
  });
}

/**
 * Close the pages an operation opened before it failed, then return the error
 * to rethrow ({@link withCleanupFailures}): the operation's own error when
 * every page closed, a wrapped one naming the close failures otherwise.
 */
async function errorAfterClosingPages(
  error: unknown,
  pages: readonly (readonly [label: string, page: Page | undefined])[],
  secrets: ReadonlySet<string>,
): Promise<unknown> {
  const failures: string[] = [];
  for (const [label, page] of pages) {
    if (page !== undefined) {
      await closePageInto(failures, label, page, secrets);
    }
  }
  return withCleanupFailures(error, 'Closing the pages it opened also failed', failures);
}

/**
 * Confirm `directory` is gone after a removal. `rm({ force: true })` resolves
 * without proving anything about what is left (a crash reporter that wrote
 * into the profile after the browser exited, a path it could not see), so
 * absence is established rather than inferred.
 *
 * @throws {Error} When the directory still exists, or its absence cannot be established.
 */
async function assertRemoved(directory: string): Promise<void> {
  try {
    await lstat(directory);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return;
    }
    throw new Error(`the removal of ${directory} could not be confirmed: ${describeError(error)}`, {
      cause: error,
    });
  }
  throw new Error(`${directory} still exists after it was removed`);
}

// ---------------------------------------------------------------------------
// The built extension on disk (read only — never written)
// ---------------------------------------------------------------------------

/** Whether `candidate` is an existing directory. */
function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `candidate` is an existing regular file. */
function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** The failure every build-dependent entry point reports when `dist/` is missing or incomplete. */
function notBuiltMessage(detail: string): string {
  return `the Chrome extension is not built — run \`pnpm build\` (or \`pnpm --filter @debuggen/chrome-extension build\`). ${detail}`;
}

/**
 * The unpacked extension directory: `explicit`, else the Playwright `use` key
 * `extensionPath` (playwright.config.ts), else `apps/chrome-extension/dist`.
 * Asserts the directory and its `manifest.json` exist, because an unbuilt
 * extension is the most common local failure and otherwise surfaces as an
 * opaque context-launch or worker timeout.
 *
 * @throws {Error} "the Chrome extension is not built — …" when either is absent.
 */
export function resolveExtensionPath(explicit?: string): string {
  const extensionPath = path.resolve(
    nonEmpty(explicit) ??
      nonEmpty(configuredExtensionPath) ??
      repoPath('apps', 'chrome-extension', 'dist'),
  );
  const manifest = path.join(extensionPath, 'manifest.json');
  if (!isDirectory(extensionPath)) {
    throw new Error(notBuiltMessage(`The directory ${extensionPath} does not exist.`));
  }
  if (!isFile(manifest)) {
    throw new Error(notBuiltMessage(`${manifest} does not exist.`));
  }
  return extensionPath;
}

/** The fields of the built `dist/manifest.json` this module reads. */
interface BuiltManifest {
  /** `devtools_page`, extension-root-relative (for example `src/devtools/devtools.html`). */
  readonly devtoolsPage: string;
}

/**
 * Read the BUILT manifest — the precedent `apps/chrome-extension/test/manifest.test.ts`
 * sets for resolving emitted paths at runtime instead of restating them.
 */
function readBuiltManifest(extensionPath: string): BuiltManifest {
  const file = path.join(extensionPath, 'manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(notBuiltMessage(`${file} could not be read: ${describeError(error)}`), {
      cause: error,
    });
  }
  const devtoolsPage = isRecord(parsed) ? parsed.devtools_page : undefined;
  if (typeof devtoolsPage !== 'string' || devtoolsPage.trim() === '') {
    throw new Error(
      notBuiltMessage(
        `${file} declares no "devtools_page", so the DevTools page (and the panel it creates) cannot be opened.`,
      ),
    );
  }
  return { devtoolsPage: devtoolsPage.replace(/^\/+/, '') };
}

/**
 * The absolute file an emitted path names inside `extensionPath`, or
 * `undefined` when it would escape the directory or names no file. A leading
 * `/` (how Vite links assets) is extension-root-relative; anything else is
 * relative to `fromDir`.
 */
function resolveDistFile(
  extensionPath: string,
  emitted: string,
  fromDir: string = extensionPath,
): string | undefined {
  const withoutQuery = emitted.split(/[?#]/, 1)[0] ?? '';
  if (withoutQuery === '') {
    return undefined;
  }
  const resolved = withoutQuery.startsWith('/')
    ? path.resolve(extensionPath, withoutQuery.replace(/^\/+/, ''))
    : path.resolve(fromDir, withoutQuery);
  const relative = path.relative(extensionPath, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return isFile(resolved) ? resolved : undefined;
}

/** `absolute` as an extension-root-relative POSIX path. */
function extensionRelative(extensionPath: string, absolute: string): string {
  return path.relative(extensionPath, absolute).split(path.sep).join('/');
}

/** Every `.html` file under `extensionPath`, bounded, for a failure message. */
function listHtmlFiles(extensionPath: string, maxDepth = 5, limit = 40): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || found.length >= limit) {
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = path.join(dir, entry);
      if (isDirectory(full)) {
        walk(full, depth + 1);
      } else if (entry.endsWith('.html') && found.length < limit) {
        found.push(extensionRelative(extensionPath, full));
      }
    }
  };
  walk(extensionPath, 0);
  return found;
}

/** `<script src="…">` in an emitted HTML document. */
const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

/** A static, side-effect or dynamic import of a relative or root-relative module in an emitted chunk. */
const MODULE_SPECIFIER =
  /(?:\bimport\s*\(\s*|\bimport\s*|\bfrom\s*)["'](\.{1,2}\/[^"']+|\/[^"']+)["']/g;

/** A string literal naming an `.html` document in an emitted chunk. */
const HTML_LITERAL = /["'`]([^"'`\s<>]+\.html)["'`]/g;

/** How many emitted chunks {@link panelPageUrl} follows from the DevTools page. */
const BUNDLE_SCAN_LIMIT = 32;

/** Options of the functions that read the built extension. */
export interface BuiltExtensionOptions {
  /** The unpacked extension directory; defaults to {@link resolveExtensionPath}'s answer. */
  readonly extensionPath?: string | undefined;
}

/** Assert `extensionId` has the shape Chrome gives extension ids. */
function assertExtensionId(extensionId: string, where: string): void {
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new Error(
      `${where}: "${extensionId}" is not a Chrome extension id (32 characters from a–p). Pass ExtensionContextHandle.extensionId.`,
    );
  }
}

/**
 * The URL of the built DevTools page (`devtools_page` of `dist/manifest.json`).
 *
 * @throws {Error} When the extension is not built or declares no DevTools page.
 */
export function devtoolsPageUrl(extensionId: string, options: BuiltExtensionOptions = {}): string {
  assertExtensionId(extensionId, 'devtoolsPageUrl');
  const extensionPath = resolveExtensionPath(options.extensionPath);
  const { devtoolsPage } = readBuiltManifest(extensionPath);
  if (resolveDistFile(extensionPath, `/${devtoolsPage}`) === undefined) {
    throw new Error(
      notBuiltMessage(
        `dist/manifest.json names "devtools_page": "${devtoolsPage}", but no such file was emitted. HTML documents under dist/: ${JSON.stringify(listHtmlFiles(extensionPath))}.`,
      ),
    );
  }
  return `chrome-extension://${extensionId}/${devtoolsPage}`;
}

/**
 * The emitted chunks the DevTools page loads: its `<script src>` entries and,
 * transitively, the relative modules they import (crxjs may emit a loader that
 * imports the real chunk), bounded by {@link BUNDLE_SCAN_LIMIT}.
 */
async function devtoolsBundle(extensionPath: string, devtoolsFile: string): Promise<string[]> {
  const html = await readFile(devtoolsFile, 'utf8');
  const queue: string[] = [];
  for (const match of html.matchAll(SCRIPT_SRC)) {
    const file = resolveDistFile(extensionPath, match[1] ?? '', path.dirname(devtoolsFile));
    if (file !== undefined) {
      queue.push(file);
    }
  }
  const visited = new Set<string>();
  while (queue.length > 0 && visited.size < BUNDLE_SCAN_LIMIT) {
    const file = queue.shift();
    if (file === undefined || visited.has(file)) {
      continue;
    }
    visited.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(MODULE_SPECIFIER)) {
      const imported = resolveDistFile(extensionPath, match[1] ?? '', path.dirname(file));
      if (imported !== undefined && !visited.has(imported)) {
        queue.push(imported);
      }
    }
  }
  return [...visited];
}

/**
 * The URL of the built panel document — the page the real DevTools page passes
 * to `chrome.devtools.panels.create`.
 *
 * The manifest never names the panel document (it is created at runtime), and
 * `@crxjs/vite-plugin` owns the emitted layout, so the path is read from the
 * build rather than restated: the `.html` literal the emitted DevTools bundle
 * carries that names an emitted file other than the DevTools page itself. The
 * `vite.config.ts` contract path (`src/panel/panel.html`) is the fallback. The
 * resolved document must load a module script: a panel document without one
 * is a stale or broken build that would open blank.
 *
 * Centralised here so no spec hardcodes a panel URL.
 *
 * @throws {Error} Listing the HTML documents found under `dist/` when none qualifies.
 */
export async function panelPageUrl(
  extensionId: string,
  options: BuiltExtensionOptions = {},
): Promise<string> {
  assertExtensionId(extensionId, 'panelPageUrl');
  const extensionPath = resolveExtensionPath(options.extensionPath);
  const { devtoolsPage } = readBuiltManifest(extensionPath);
  const devtoolsFile = resolveDistFile(extensionPath, `/${devtoolsPage}`);
  if (devtoolsFile === undefined) {
    throw new Error(
      notBuiltMessage(
        `dist/manifest.json names "devtools_page": "${devtoolsPage}", but no such file was emitted. HTML documents under dist/: ${JSON.stringify(listHtmlFiles(extensionPath))}.`,
      ),
    );
  }

  const scanned = await devtoolsBundle(extensionPath, devtoolsFile);
  const candidates: string[] = [];
  for (const chunk of scanned) {
    const source = await readFile(chunk, 'utf8');
    for (const match of source.matchAll(HTML_LITERAL)) {
      const literal = (match[1] ?? '').replace(/^\/+/, '');
      const file = resolveDistFile(extensionPath, `/${literal}`);
      if (file !== undefined && file !== devtoolsFile && !candidates.includes(file)) {
        candidates.push(file);
      }
    }
  }
  const fallback = resolveDistFile(extensionPath, `/${PANEL_DOCUMENT_FALLBACK}`);
  const panelFile = candidates[0] ?? fallback;
  if (panelFile === undefined) {
    throw new Error(
      notBuiltMessage(
        `No panel document was found: the DevTools bundle (${JSON.stringify(scanned.map((file) => extensionRelative(extensionPath, file)))}) names no emitted .html file, and ${PANEL_DOCUMENT_FALLBACK} was not emitted. HTML documents under dist/: ${JSON.stringify(listHtmlFiles(extensionPath))}.`,
      ),
    );
  }

  const relative = extensionRelative(extensionPath, panelFile);
  const document = await readFile(panelFile, 'utf8');
  const loadsScript = [...document.matchAll(SCRIPT_SRC)].some(
    (match) =>
      resolveDistFile(extensionPath, match[1] ?? '', path.dirname(panelFile)) !== undefined,
  );
  if (!loadsScript) {
    throw new Error(
      notBuiltMessage(
        `dist/${relative} loads no emitted module script, so the panel would open blank: the build is stale or incomplete. Rebuild the extension.`,
      ),
    );
  }
  return `chrome-extension://${extensionId}/${relative}`;
}

// ---------------------------------------------------------------------------
// The persistent context, the extension and its MV3 service worker
// ---------------------------------------------------------------------------

/** The options `chromium.launchPersistentContext` accepts. */
type PersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

/** Options of {@link launchExtensionContext}. */
export interface LaunchExtensionContextOptions {
  /** The unpacked extension; defaults to the Playwright `use` key `extensionPath`, then `apps/chrome-extension/dist`. */
  readonly extensionPath?: string | undefined;
  /**
   * The profile directory. Omit it (the default) for a fresh temporary profile
   * that {@link ExtensionContextHandle.close} removes: a reused profile would
   * carry pairing state and bindings across runs. A directory passed here is
   * the caller's and is never removed.
   */
  readonly userDataDir?: string | undefined;
  /** Playwright's `headless` option; defaults to `true`, its own default. */
  readonly headless?: boolean | undefined;
  /** The browser channel; defaults to `'chromium'`, as `tests/browser/fixtures.ts` launches. */
  readonly channel?: string | undefined;
  /** Playwright's `launchOptions`; its `args` are kept ahead of the two extension flags. */
  readonly launchOptions?: LaunchOptions | undefined;
  /** The viewport; Playwright's default when omitted. */
  readonly viewport?: PersistentContextOptions['viewport'] | undefined;
}

/** Which path produced the MV3 worker handle at launch: it was already registered, or it was awaited. */
export type ServiceWorkerDiscovery = 'already-running' | 'awaited';

/** The persistent context with the unpacked extension loaded. */
export interface ExtensionContextHandle {
  /** The persistent context; every page of the suite is opened in it. */
  readonly context: BrowserContext;
  /** The extension id, from the worker's `chrome-extension://<id>/…` URL. */
  readonly extensionId: string;
  /**
   * The most recently acquired worker. Prefer {@link getServiceWorker}: the
   * MV3 worker suspends after roughly 30 s idle, and this handle may be dead.
   */
  readonly serviceWorker: Worker;
  /** The absolute unpacked-extension directory the context loaded. */
  readonly extensionPath: string;
  /** The profile directory. */
  readonly userDataDir: string;
  /** How the worker was obtained at launch, for diagnostics. */
  readonly serviceWorkerDiscovery: ServiceWorkerDiscovery;
  /**
   * The extension's live worker: the registered one, or — when Chromium
   * suspended it — the one a wake-up port connection starts. Never kills or
   * restarts the worker.
   */
  getServiceWorker(): Promise<Worker>;
  /**
   * Close every panel opened through {@link openPanelPage} (newest first),
   * then the context, then remove the temporary profile and confirm its
   * directory is gone. Every step is attempted even when an earlier one
   * failed.
   *
   * Rejects — after all of them ran — with one bounded error naming each
   * failure: a panel that did not close cleanly, the context, a profile that
   * could not be removed or still exists, and any worker wake-up page that
   * could not be closed during the context's life (see
   * {@link getServiceWorker}). Idempotent: a second call returns the first
   * call's outcome, rejection included.
   */
  close(): Promise<void>;
}

/** Per-context state that {@link openPanelPage}, {@link resetExtensionState} and the handle share. */
interface ExtensionInternals {
  /** Every open panel handle, in opening order. */
  readonly openPanels: Set<PanelHandle>;
  /**
   * Teardown failures observed while the context was in use that no caller
   * was awaiting — a worker wake-up page that would not close is a leaked
   * tab — reported by {@link ExtensionContextHandle.close}. The first
   * {@link DEFERRED_PROBLEMS_LIMIT} are kept; {@link deferredDropped} counts
   * the rest.
   */
  readonly deferredProblems: string[];
  /** How many deferred problems arrived after {@link deferredProblems} was full. */
  deferredDropped: number;
  /**
   * The worker wake-ups still in flight. Each settles to a value (never
   * rejects); {@link ExtensionContextHandle.close} awaits them once the
   * context is closed, so a wake-up page's close outcome is known before it
   * reports.
   */
  readonly pendingWakes: Set<Promise<unknown>>;
}

/** Record a teardown problem for {@link ExtensionContextHandle.close} to report, within the bound. */
function recordDeferredProblem(internals: ExtensionInternals, problem: string): void {
  if (internals.deferredProblems.length < DEFERRED_PROBLEMS_LIMIT) {
    internals.deferredProblems.push(problem);
  } else {
    internals.deferredDropped += 1;
  }
}

/** The internals of each handle this module created. */
const EXTENSION_INTERNALS = new WeakMap<ExtensionContextHandle, ExtensionInternals>();

/** The handles not yet closed, so {@link resetExtensionState} can reach their panels from a bare `Worker`. */
const LIVE_EXTENSIONS = new Set<ExtensionContextHandle>();

/** The internals of `handle`, which must come from {@link launchExtensionContext}. */
function extensionInternals(handle: ExtensionContextHandle): ExtensionInternals {
  const internals = EXTENSION_INTERNALS.get(handle);
  if (internals === undefined) {
    throw new Error(
      'This ExtensionContextHandle was not created by launchExtensionContext() in tests/e2e/helpers/chrome.ts.',
    );
  }
  return internals;
}

/**
 * Start a suspended worker without touching the product: an extension page (the
 * built DevTools page, which bootstraps nothing without `chrome.devtools`)
 * connects a port with an unknown name — every `runtime.onConnect` dispatch
 * starts the worker, and `background/ports.ts` refuses and disconnects the
 * unknown name.
 *
 * The wake-up page is always closed. A close that fails (or leaves the page
 * open) is a leaked tab: it is recorded in `internals` for
 * {@link ExtensionContextHandle.close} to report, because the caller treats
 * the wake itself as best-effort and must not fail worker acquisition over it.
 *
 * @throws {Error} When the page cannot be opened, navigated or evaluated in.
 */
async function wakeWorker(
  context: BrowserContext,
  extensionId: string,
  extensionPath: string,
  internals: ExtensionInternals,
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(devtoolsPageUrl(extensionId, { extensionPath }), {
      timeout: WORKER_READY_TIMEOUT_MS,
    });
    await page.evaluate((portName) => {
      const host = globalThis as unknown as {
        chrome?: { runtime?: { connect?: (info: { name: string }) => unknown } };
      };
      host.chrome?.runtime?.connect?.({ name: portName });
    }, WAKE_PORT_NAME);
  } finally {
    const failures: string[] = [];
    await closePageInto(failures, 'worker wake-up page', page);
    for (const failure of failures) {
      recordDeferredProblem(internals, failure);
    }
  }
}

/**
 * Launch one persistent Chromium context with the unpacked extension —
 * extensions load only in a persistent context — and obtain its MV3 worker on
 * whichever path wins the race: already registered, or awaited.
 *
 * The launch options are exactly `tests/browser/fixtures.ts`'s, so both
 * suites load the extension identically: the caller's `launchOptions` (its
 * `args` first), `headless`, `channel` (default `'chromium'`), then
 * `--disable-extensions-except=<path>` and `--load-extension=<path>`, and no
 * other flag.
 *
 * @throws {Error} "the Chrome extension is not built — …" before launching when
 * `dist/manifest.json` is missing; an actionable message when no worker
 * registers or its id is malformed (the context and profile are disposed).
 * When disposing after a failure — removing the profile after a failed
 * launch, closing the context and removing the profile after a missing or
 * malformed worker — itself fails, the error names those failures after the
 * original message, and the original error stays its `cause`.
 */
export async function launchExtensionContext(
  options: LaunchExtensionContextOptions = {},
): Promise<ExtensionContextHandle> {
  const extensionPath = resolveExtensionPath(options.extensionPath);
  const suppliedProfile = nonEmpty(options.userDataDir);
  const userDataDir =
    suppliedProfile === undefined
      ? await mkdtemp(path.join(os.tmpdir(), 'debuggen-e2e-profile-'))
      : path.resolve(suppliedProfile);
  const ownsUserDataDir = suppliedProfile === undefined;
  /** Remove the profile this call created, and confirm it is gone; a caller's profile is never touched. */
  const removeProfile = async (): Promise<void> => {
    if (ownsUserDataDir) {
      await rm(userDataDir, { recursive: true, force: true });
      await assertRemoved(userDataDir);
    }
  };
  const profileRemoval = `removing the profile ${userDataDir}`;

  const { args: extraArgs, ...launchOptions } = options.launchOptions ?? {};
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      ...launchOptions,
      headless: options.headless ?? true,
      channel: options.channel ?? 'chromium',
      args: [
        ...(extraArgs ?? []),
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
      ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
    });
  } catch (error) {
    // The launch failure leads; a profile left behind is appended, never swapped in for it.
    const failures: string[] = [];
    await attemptTeardown(failures, profileRemoval, removeProfile);
    throw withCleanupFailures(error, 'Removing its profile also failed', failures);
  }

  /**
   * Dispose of a context that never became a handle: close it, then remove the
   * owned profile — each attempted whatever the other did — and return what
   * failed, for the error that caused the disposal to carry.
   */
  const disposeContext = async (): Promise<string[]> => {
    const failures: string[] = [];
    await attemptTeardown(failures, 'closing the context', () => context.close());
    await attemptTeardown(failures, profileRemoval, removeProfile);
    return failures;
  };
  const disposalSummary = 'Disposing the context also failed';

  let worker = context.serviceWorkers().find((candidate) => isExtensionUrl(candidate.url()));
  let serviceWorkerDiscovery: ServiceWorkerDiscovery = 'already-running';
  if (worker === undefined) {
    serviceWorkerDiscovery = 'awaited';
    try {
      worker = await context.waitForEvent('serviceworker', {
        timeout: WORKER_READY_TIMEOUT_MS,
        predicate: (candidate) => isExtensionUrl(candidate.url()),
      });
    } catch (error) {
      const disposal = await disposeContext();
      throw new Error(
        `The extension's MV3 service worker did not register within ${String(WORKER_READY_TIMEOUT_MS)} ms (extension path ${extensionPath}). A manifest that loads but whose worker fails to evaluate shows up as this timeout; rebuild with \`pnpm build\` and check the worker bundle. ${describeError(error)}${teardownSuffix(disposalSummary, disposal)}`,
        { cause: error },
      );
    }
  }

  const extensionId = hostOf(worker.url());
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    const disposal = await disposeContext();
    throw new Error(
      `The extension id could not be read from the worker URL ${worker.url()}: "${extensionId}" is not a 32-character id from a–p.${teardownSuffix(disposalSummary, disposal)}`,
    );
  }

  let current: Worker = worker;
  const isOurs = (candidate: Worker): boolean => hostOf(candidate.url()) === extensionId;
  const internals: ExtensionInternals = {
    openPanels: new Set(),
    deferredProblems: [],
    deferredDropped: 0,
    pendingWakes: new Set(),
  };

  const getServiceWorker = async (): Promise<Worker> => {
    const live = context.serviceWorkers().find(isOurs);
    if (live !== undefined) {
      current = live;
      return live;
    }
    // Suspended: listen first, then wake, so the registration cannot be missed.
    // The listener settles to a value at once (never an unhandled rejection
    // while the wake is in flight), and the wake is raced against it, so the
    // whole call is bounded by WORKER_READY_TIMEOUT_MS whatever the wake does.
    const registration = context
      .waitForEvent('serviceworker', { timeout: WORKER_READY_TIMEOUT_MS, predicate: isOurs })
      .then(
        (worker): { readonly worker: Worker } => ({ worker }),
        (error: unknown): { readonly error: unknown } => ({ error }),
      );
    // The registration event is authoritative, so a wake that fails (a
    // navigation timeout, say) does not fail the acquisition: its description
    // is kept for the timeout message below. A wake-up page that would not
    // close is a leaked tab, which wakeWorker records for close() to report.
    let wakeFailure: string | undefined;
    const wake = wakeWorker(context, extensionId, extensionPath, internals).then(
      () => undefined,
      (error: unknown) => {
        wakeFailure = truncate(
          describeError(error).replace(/\s+/g, ' ').trim(),
          TEARDOWN_FAILURE_MAX_LENGTH,
        );
      },
    );
    internals.pendingWakes.add(wake);
    void wake.then(() => internals.pendingWakes.delete(wake));
    await Promise.race([wake, registration]);
    const outcome = await registration;
    if ('worker' in outcome) {
      current = outcome.worker;
      return current;
    }
    const lateArrival = context.serviceWorkers().find(isOurs);
    if (lateArrival !== undefined) {
      current = lateArrival;
      return lateArrival;
    }
    throw new Error(
      `The extension's service worker (${extensionId}) is not running and did not restart within ${String(WORKER_READY_TIMEOUT_MS)} ms after a wake-up connection. ${describeError(outcome.error)}${wakeFailure === undefined ? '' : ` (the wake-up page itself failed: ${wakeFailure})`}`,
      { cause: outcome.error },
    );
  };

  let closing: Promise<void> | undefined;

  const handle: ExtensionContextHandle = {
    context,
    extensionId,
    get serviceWorker(): Worker {
      return current;
    },
    extensionPath,
    userDataDir,
    serviceWorkerDiscovery,
    getServiceWorker,
    close(): Promise<void> {
      closing ??= (async () => {
        LIVE_EXTENSIONS.delete(handle);
        const failures: string[] = [];
        for (const panel of [...internals.openPanels].reverse()) {
          await attemptTeardown(failures, `closing the panel of tab ${String(panel.tabId)}`, () =>
            panel.close(),
          );
        }
        await attemptTeardown(failures, 'closing the context', () => context.close());
        // A wake-up still in flight settles promptly once its context is gone;
        // wait for it so a wake-up page that failed to close is reported here.
        await Promise.allSettled([...internals.pendingWakes]);
        failures.push(...internals.deferredProblems);
        if (internals.deferredDropped > 0) {
          failures.push(
            `${String(internals.deferredDropped)} further problem(s) recorded while the context was in use were not retained`,
          );
        }
        await attemptTeardown(failures, profileRemoval, removeProfile);
        if (failures.length > 0) {
          throw new Error(
            teardownMessage('Closing the extension context was incomplete', failures),
          );
        }
      })();
      return closing;
    },
  };
  EXTENSION_INTERNALS.set(handle, internals);
  LIVE_EXTENSIONS.add(handle);
  return handle;
}

/** Anything a worker can be obtained from: a `Worker`, or a handle that re-acquires it. */
export type WorkerSource = Worker | Pick<ExtensionContextHandle, 'getServiceWorker'>;

/** The live worker behind `source`. */
async function workerOf(source: WorkerSource): Promise<Worker> {
  return 'getServiceWorker' in source ? source.getServiceWorker() : source;
}

// ---------------------------------------------------------------------------
// Tabs and the worker's storage (read, or removed by key — values never read out)
// ---------------------------------------------------------------------------

/** One tab as `chrome.tabs.query` reports it (the manifest grants `tabs`). */
interface TabView {
  readonly id: number;
  readonly url: string;
  readonly active: boolean;
}

/** Every tab, from inside the worker. */
async function queryTabs(worker: Worker): Promise<TabView[]> {
  return worker.evaluate(async () => {
    const host = globalThis as unknown as {
      chrome: {
        tabs: {
          query(
            queryInfo: Record<string, never>,
          ): Promise<{ id?: number; url?: string; active: boolean }[]>;
        };
      };
    };
    const tabs = await host.chrome.tabs.query({});
    return tabs.map((tab) => ({ id: tab.id ?? -1, url: tab.url ?? '', active: tab.active }));
  });
}

/** Options of {@link tabIdForPage}. */
export interface TabIdForPageOptions {
  /** How long the tab may take to appear; defaults to {@link TAB_RESOLVE_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

/**
 * The Chrome `tabId` of a Playwright page, resolved inside the worker with
 * `chrome.tabs.query` by exact URL (bringing the page to the front when several
 * tabs show the same URL, and keeping the active one). Polls briefly, because a
 * freshly navigated page reaches `chrome.tabs` a moment after Playwright
 * reports it. This is how a panel learns the tab it "inspects".
 *
 * @throws {Error} At once for a closed page or one not showing an `http(s)`
 * URL (`about:blank` before navigation has no inspectable tab); after the
 * budget, naming every tab the worker reported.
 */
export async function tabIdForPage(
  source: WorkerSource,
  page: Page,
  options: TabIdForPageOptions = {},
): Promise<number> {
  if (page.isClosed()) {
    throw new Error('tabIdForPage: the page is closed.');
  }
  if (!isWebUrl(page.url())) {
    throw new Error(
      `tabIdForPage: the page shows "${page.url()}", which is not an http(s) application URL. Navigate it to the application first — about:blank and extension pages are never an inspected tab.`,
    );
  }
  const timeoutMs = options.timeoutMs ?? TAB_RESOLVE_TIMEOUT_MS;
  let resolved: number | undefined;
  await pollUntilReady(
    async () => {
      const worker = await workerOf(source);
      const url = page.url();
      let matching = (await queryTabs(worker)).filter((tab) => tab.url === url && tab.id >= 0);
      if (matching.length > 1) {
        await page.bringToFront();
        matching = (await queryTabs(worker)).filter(
          (tab) => tab.url === url && tab.id >= 0 && tab.active,
        );
      }
      const [only] = matching;
      if (only !== undefined && matching.length === 1) {
        resolved = only.id;
        return READY;
      }
      const all = await queryTabs(worker);
      return `${String(matching.length)} tab(s) show ${url} among ${JSON.stringify(all)}`;
    },
    timeoutMs,
    (lastSeen) =>
      `tabIdForPage: could not resolve the tab of ${page.url()} within ${String(timeoutMs)} ms (${lastSeen}). Pass openPanelPage({ tabId }) explicitly if several tabs show the same URL.`,
  );
  if (resolved === undefined) {
    throw new Error(`tabIdForPage: the tab of ${page.url()} was not resolved.`);
  }
  return resolved;
}

/** The page of the context whose tab is `tabId`, or `undefined` when none (or several) qualify. */
async function pageForTab(
  handle: ExtensionContextHandle,
  tabId: number,
): Promise<Page | undefined> {
  const worker = await handle.getServiceWorker();
  const tab = (await queryTabs(worker)).find((candidate) => candidate.id === tabId);
  if (tab === undefined || !isWebUrl(tab.url)) {
    return undefined;
  }
  const candidates = handle.context
    .pages()
    .filter((page) => !page.isClosed() && page.url() === tab.url);
  if (candidates.length <= 1) {
    return candidates[0];
  }
  for (const candidate of candidates) {
    if ((await tabIdForPage(worker, candidate).catch(() => undefined)) === tabId) {
      return candidate;
    }
  }
  return undefined;
}

/** Remove one key of a `chrome.storage` area in the worker (the value is never read out). */
async function removeWorkerStorage(
  worker: Worker,
  area: 'local' | 'session',
  key: string,
): Promise<void> {
  await worker.evaluate(
    async ({ area: name, key: item }) => {
      const host = globalThis as unknown as {
        chrome: { storage: Record<'local' | 'session', { remove(key: string): Promise<void> }> };
      };
      await host.chrome.storage[name].remove(item);
    },
    { area, key },
  );
}

/**
 * Whether the worker holds a devtools credential of the stored shape
 * (`DEVTOOLS_TOKEN_STORAGE_KEY` in `chrome.storage.local`, version
 * `STORED_CREDENTIAL_VERSION`, a token of at least 32 characters). Only the
 * version and the token's LENGTH leave the worker; the token never does.
 * Mirrors `hasStoredCredential` in `tests/browser/fixtures.ts`.
 */
export async function hasStoredDevtoolsCredential(source: WorkerSource): Promise<boolean> {
  const worker = await workerOf(source);
  const shape = await worker.evaluate(async (key) => {
    const host = globalThis as unknown as {
      chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
    };
    const items = await host.chrome.storage.local.get(key);
    const stored = items[key];
    if (typeof stored !== 'object' || stored === null) {
      return { present: false, version: undefined as unknown, tokenLength: 0 };
    }
    const record = stored as { version?: unknown; token?: unknown };
    return {
      present: true,
      version: record.version,
      tokenLength: typeof record.token === 'string' ? record.token.length : 0,
    };
  }, DEVTOOLS_TOKEN_STORAGE_KEY);
  return shape.present && shape.version === STORED_CREDENTIAL_VERSION && shape.tokenLength >= 32;
}

// ---------------------------------------------------------------------------
// The test-owned `chrome.devtools` stub
// ---------------------------------------------------------------------------

/** What {@link installDevtoolsStub} needs; serialised into the page, so plain data only. */
export interface DevtoolsStubArgs {
  /**
   * The pathnames of the two documents the stub applies to — the built
   * DevTools page and the built panel document. Any other document, and every
   * sub-frame, is left untouched.
   */
  readonly documentPaths: readonly string[];
  /** `chrome.devtools.inspectedWindow.tabId`. */
  readonly inspectedTabId: number;
  /** `chrome.devtools.panels.themeName`: `'dark'` or `'light'` (see {@link DEVTOOLS_THEME_NAMES}). */
  readonly themeName: 'dark' | 'light';
  /** The `page.exposeBinding` name `inspectedWindow.eval` forwards to. */
  readonly evalBinding: string;
  /** The window property the test-only {@link DevtoolsStubControl} is published under. */
  readonly controlGlobal: string;
}

/** One `chrome.devtools.panels.create` call the DevTools page made. */
export interface CreatedPanelRecord {
  readonly title: string;
  readonly iconPath: string;
  readonly pagePath: string;
}

/**
 * The stub's test-only control surface (`window[controlGlobal]`). No product
 * code reads it; the helpers below drive DevTools events through it.
 */
export interface DevtoolsStubControl {
  /** Dispatch `panels.elements.onSelectionChanged`; returns how many listeners ran. */
  fireSelectionChanged(): number;
  /** Dispatch the created panel's `onShown`; returns how many listeners ran. */
  firePanelShown(): number;
  /** Dispatch the created panel's `onHidden`; returns how many listeners ran. */
  firePanelHidden(): number;
  /** Every `panels.create` call so far, oldest first. */
  createdPanels(): readonly CreatedPanelRecord[];
  /** How many `onSelectionChanged` listeners are registered. */
  selectionListenerCount(): number;
}

/**
 * **Test-owned.** Runs in the built DevTools page and the built panel document
 * before their bundles (installed with `page.addInitScript` before navigation,
 * since an init script added later does not apply to the current document). It
 * supplies exactly the `chrome.devtools` members the product reads and nothing
 * more:
 *
 * - `inspectedWindow.tabId` (`src/devtools/devtools.ts`,
 *   `src/panel/state/connection.ts` `readInspectedTabId`, `TargetPicker`);
 * - `inspectedWindow.eval(expression, options?, callback?)` in both callback
 *   forms (`devtools.ts` and `App.tsx` call the two-argument form), forwarded
 *   to Node through the page binding, which evaluates the product's own
 *   expression string in the inspected application page. Success calls
 *   `callback(result, undefined)`, because `App.tsx` treats any defined
 *   `exceptionInfo` as a failure;
 * - `panels.themeName` (`src/panel/theme.ts`, `devtools.ts`); the optional
 *   `panels.setThemeChangeHandler` is left out, which `theme.ts`
 *   feature-detects, re-reading `themeName` when the panel is shown instead;
 * - `panels.create(title, iconPath, pagePath, callback)` as a recording no-op
 *   whose callback receives a panel object with `onShown`/`onHidden`;
 * - `panels.elements.onSelectionChanged` with working
 *   `addListener`/`removeListener`.
 *
 * `chrome.runtime`, `chrome.storage` and the ports are NOT stubbed: inside an
 * extension page they are the real APIs, so both documents talk to the real
 * service worker. This is the e2e counterpart of `installDevtoolsEmulation` in
 * `tests/browser/fixtures.ts` — same guard (top window, named document only),
 * same `Object.defineProperty(chrome, 'devtools', …)` installation — widened
 * to the members the real DevTools page reads.
 */
export function installDevtoolsStub(args: DevtoolsStubArgs): void {
  if (window.top !== window || !args.documentPaths.includes(window.location.pathname)) {
    return;
  }
  const host = globalThis as unknown as Record<string, unknown> & { chrome?: object };
  const chromeApi = host.chrome;
  if (chromeApi === undefined) {
    return;
  }

  type Listener = (...values: unknown[]) => void;
  const makeEvent = (): {
    listeners: Set<Listener>;
    api: { addListener(listener: unknown): void; removeListener(listener: unknown): void };
  } => {
    const listeners = new Set<Listener>();
    return {
      listeners,
      api: Object.freeze({
        addListener(listener: unknown): void {
          if (typeof listener === 'function') {
            listeners.add(listener as Listener);
          }
        },
        removeListener(listener: unknown): void {
          listeners.delete(listener as Listener);
        },
      }),
    };
  };
  const dispatch = (listeners: Set<Listener>): number => {
    let ran = 0;
    for (const listener of [...listeners]) {
      try {
        // The real `onShown` passes the panel's window; no product listener
        // reads an argument, and no event here carries one.
        listener();
        ran += 1;
      } catch (error) {
        console.error('[debuggen e2e devtools stub] a DevTools event listener threw:', error);
      }
    }
    return ran;
  };

  const shown = makeEvent();
  const hidden = makeEvent();
  const selection = makeEvent();
  const created: { title: string; iconPath: string; pagePath: string }[] = [];
  const panelObject = Object.freeze({ onShown: shown.api, onHidden: hidden.api });

  const failure = (code: string, description: string): Record<string, unknown> => ({
    isError: true,
    code,
    description,
    details: [],
    isException: false,
    value: description,
  });

  const evaluate = (expression: unknown, optionsOrCallback?: unknown, maybeCallback?: unknown) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const evalOptions = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    const deliver = (result: unknown, exceptionInfo: unknown): void => {
      if (typeof callback !== 'function') {
        return;
      }
      try {
        (callback as (result: unknown, exceptionInfo: unknown) => void)(result, exceptionInfo);
      } catch (error) {
        console.error('[debuggen e2e devtools stub] an eval callback threw:', error);
      }
    };
    const binding = host[args.evalBinding];
    if (typeof binding !== 'function') {
      void Promise.resolve().then(() => {
        deliver(
          undefined,
          failure('E_FAILED', 'The e2e inspected-window binding is not installed.'),
        );
      });
      return;
    }
    const call = binding as (expression: string, options: unknown) => Promise<unknown>;
    void Promise.resolve(call(String(expression), evalOptions ?? null)).then(
      (outcome) => {
        const answer = outcome as { ok?: unknown; value?: unknown; exceptionInfo?: unknown } | null;
        if (answer !== null && answer.ok === true) {
          deliver(answer.value, undefined);
        } else {
          deliver(
            undefined,
            answer?.exceptionInfo ??
              failure('E_FAILED', 'The e2e inspected-window binding answered nothing.'),
          );
        }
      },
      (error: unknown) => {
        deliver(undefined, failure('E_FAILED', String(error)));
      },
    );
  };

  const devtools = Object.freeze({
    inspectedWindow: Object.freeze({ tabId: args.inspectedTabId, eval: evaluate }),
    panels: Object.freeze({
      themeName: args.themeName,
      create(title: unknown, iconPath: unknown, pagePath: unknown, callback?: unknown): void {
        created.push({
          title: String(title),
          iconPath: String(iconPath),
          pagePath: String(pagePath),
        });
        if (typeof callback === 'function') {
          void Promise.resolve().then(() => {
            (callback as (panel: unknown) => void)(panelObject);
          });
        }
      },
      elements: Object.freeze({ onSelectionChanged: selection.api }),
    }),
  });
  Object.defineProperty(chromeApi, 'devtools', {
    value: devtools,
    configurable: true,
    enumerable: true,
  });

  const control = Object.freeze({
    fireSelectionChanged: () => dispatch(selection.listeners),
    firePanelShown: () => dispatch(shown.listeners),
    firePanelHidden: () => dispatch(hidden.listeners),
    createdPanels: () => created.map((record) => ({ ...record })),
    selectionListenerCount: () => selection.listeners.size,
  });
  Object.defineProperty(window, args.controlGlobal, { value: control, configurable: true });
}

// ---------------------------------------------------------------------------
// Answering `inspectedWindow.eval` in the inspected application page
// ---------------------------------------------------------------------------

/** Which extension document asked for an evaluation. */
export type EvalCaller = 'devtools' | 'panel';

/** One `chrome.devtools.inspectedWindow.eval` the stub answered. */
export interface InspectedEvalRecord {
  /** Monotonic per panel handle; compare with {@link PanelHandle.evalLog} entries taken earlier. */
  readonly seq: number;
  /** The document that called `eval`. */
  readonly caller: EvalCaller;
  /** Whether the expression reads `$0` (a selection descriptor rather than, say, the location). */
  readonly usesSelection: boolean;
  /** The selector `$0` was bound to, or `undefined` when nothing was selected. */
  readonly selector: string | undefined;
  /** `value` (a JSON-compliant result), `exception` (the expression threw) or `error` (no evaluation happened). */
  readonly outcome: 'value' | 'exception' | 'error';
  /** The result, when `outcome` is `value`. */
  readonly value: unknown;
  /** The exception or error text, otherwise. */
  readonly detail: string | undefined;
  /** When the answer was produced (epoch milliseconds). */
  readonly at: number;
}

/** What the page binding answers the stub with. */
type InspectedEvalOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly exceptionInfo: Record<string, unknown> };

/** Errors that mean no evaluation happened (the page went away), rather than that the expression threw. */
const EVALUATION_UNAVAILABLE =
  /Target page, context or browser has been closed|Execution context was destroyed|frame (?:was|got) detached|navigat/i;

/**
 * The program evaluated in the inspected page: the product's expression with
 * `$0` bound to the test's selection, as DevTools binds the Elements panel's
 * selected node. A parameter named `$0` rather than `eval`, so a page's
 * content-security policy cannot interfere (Playwright evaluates the program
 * itself through the DevTools protocol). A trailing `;` is dropped because the
 * product's expressions are single expressions.
 */
function inspectedProgram(expression: string, selector: string | undefined): string {
  const body = expression.trim().replace(/;+\s*$/, '');
  const selection =
    selector === undefined
      ? 'undefined'
      : `(document.querySelector(${JSON.stringify(selector)}) ?? undefined)`;
  return `(function ($0) {\n  return (\n${body}\n  );\n})(${selection})`;
}

/** The mutable state behind one {@link PanelHandle}. */
interface PanelState {
  readonly extension: ExtensionContextHandle;
  readonly tabId: number;
  /** The inspected page, once known (given, or resolved from the tab on first use). */
  inspectedPage: Page | undefined;
  /** The selector the stub binds `$0` to; `undefined` means nothing is selected. */
  selection: string | undefined;
  evalSeq: number;
  readonly evals: InspectedEvalRecord[];
  readonly consoleLines: string[];
  readonly errors: string[];
  /** One-time values (the pairing code) scrubbed from every forwarded line. */
  readonly secrets: Set<string>;
}

/** Push `line` onto a bounded, scrubbed buffer. */
function appendBounded(buffer: string[], line: string, secrets: ReadonlySet<string>): void {
  buffer.push(truncate(scrub(line, secrets), PANEL_CONSOLE_LINE_MAX_LENGTH));
  if (buffer.length > PANEL_CONSOLE_LOG_LIMIT) {
    buffer.splice(0, buffer.length - PANEL_CONSOLE_LOG_LIMIT);
  }
}

/** Record an answered evaluation (bounded). */
function recordEval(
  state: PanelState,
  entry: Omit<InspectedEvalRecord, 'seq' | 'at'>,
): InspectedEvalRecord {
  state.evalSeq += 1;
  const record: InspectedEvalRecord = { ...entry, seq: state.evalSeq, at: Date.now() };
  state.evals.push(record);
  if (state.evals.length > EVAL_LOG_LIMIT) {
    state.evals.splice(0, state.evals.length - EVAL_LOG_LIMIT);
  }
  return record;
}

/** The inspected page of `state`, resolving it from the tab id when it was not given. */
async function inspectedPageOf(state: PanelState): Promise<Page | undefined> {
  if (state.inspectedPage !== undefined && !state.inspectedPage.isClosed()) {
    return state.inspectedPage;
  }
  state.inspectedPage = await pageForTab(state.extension, state.tabId).catch(() => undefined);
  return state.inspectedPage;
}

/**
 * Answer one `inspectedWindow.eval` from `caller`: evaluate the product's
 * expression in the inspected page with `$0` bound, and hand back either the
 * JSON-compliant result or DevTools-shaped `exceptionInfo`.
 */
async function answerInspectedEval(
  state: PanelState,
  caller: EvalCaller,
  expression: unknown,
  evalOptions: unknown,
): Promise<InspectedEvalOutcome> {
  const selector = state.selection;
  const refuse = (code: string, description: string): InspectedEvalOutcome => {
    recordEval(state, {
      caller,
      usesSelection: typeof expression === 'string' && /\$0\b/.test(expression),
      selector,
      outcome: 'error',
      value: undefined,
      detail: `${code}: ${description}`,
    });
    return {
      ok: false,
      exceptionInfo: {
        isError: true,
        code,
        description,
        details: [],
        isException: false,
        value: description,
      },
    };
  };

  if (typeof expression !== 'string') {
    return refuse('E_BADARG', 'inspectedWindow.eval was called without an expression string.');
  }
  if (
    isRecord(evalOptions) &&
    (evalOptions.useContentScriptContext === true ||
      evalOptions.scriptExecutionContext !== undefined ||
      evalOptions.frameURL !== undefined)
  ) {
    return refuse(
      'E_NOTSUPPORTED',
      "The e2e DevTools stub evaluates only in the inspected page's main world, where $0 and window.__DEBUGGEN__ live — the context the product relies on.",
    );
  }
  const page = await inspectedPageOf(state);
  if (page === undefined) {
    return refuse(
      'E_FAILED',
      `No page of the persistent context is tab ${String(state.tabId)}; open the application page before evaluating in it, or pass openPanelPage({ inspectedPage }).`,
    );
  }

  const usesSelection = /\$0\b/.test(expression);
  try {
    const value: unknown = await page.evaluate(inspectedProgram(expression, selector));
    recordEval(state, {
      caller,
      usesSelection,
      selector,
      outcome: 'value',
      value,
      detail: undefined,
    });
    return { ok: true, value };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(
      /^page\.evaluate:\s*/,
      '',
    );
    if (EVALUATION_UNAVAILABLE.test(message)) {
      return refuse('E_FAILED', `The inspected page could not evaluate: ${message}`);
    }
    recordEval(state, {
      caller,
      usesSelection,
      selector,
      outcome: 'exception',
      value: undefined,
      detail: message,
    });
    return { ok: false, exceptionInfo: { isException: true, value: message } };
  }
}

// ---------------------------------------------------------------------------
// The panel page
// ---------------------------------------------------------------------------

/** The DevTools theme the stub reports; dark is the default. */
export type DevtoolsTheme = 'dark' | 'light';

/** Options of {@link openPanelPage}. */
export interface OpenPanelPageOptions {
  /** The inspected tab (`chrome.devtools.inspectedWindow.tabId`); see {@link tabIdForPage}. */
  readonly tabId: number;
  /** `chrome.devtools.panels.themeName` as the stub reports it; defaults to `dark`. */
  readonly theme?: DevtoolsTheme | undefined;
  /**
   * The URL the inspected tab is expected to show. When given, the tab's
   * origin is checked before anything opens — the service binds a tab to the
   * session whose dev-server origin matches, so a tab on the wrong origin
   * would silently bind to another session or to none.
   */
  readonly inspectedUrl?: string | undefined;
  /**
   * The application page of `tabId`, when the caller has it; verified against
   * the tab id. Otherwise the page is resolved from the tab on first use.
   */
  readonly inspectedPage?: Page | undefined;
  /**
   * Open the real built DevTools page as well (default `true`). It is what
   * announces the tab with `devtools.hello` — so the worker sends
   * `session.bind` — keeps the binding alive while it stays open, and answers
   * `onSelectionChanged`. `false` opens the panel alone: it inspects the tab
   * but nothing announces it, so nothing is bound.
   */
  readonly announce?: boolean | undefined;
  /**
   * How long each document may take to become interactive; defaults to
   * {@link DEVTOOLS_PAGE_READY_TIMEOUT_MS} for the DevTools page and
   * {@link PANEL_READY_TIMEOUT_MS} for the panel.
   */
  readonly readyTimeoutMs?: number | undefined;
}

/** Options of {@link PanelHandle.close}. */
export interface PanelCloseOptions {
  /**
   * Attach the bounded, scrubbed console log to the report when the running
   * test failed (default `true`). Nothing is attached on success.
   */
  readonly attachOnFailure?: boolean | undefined;
}

/** The DevTools surface for one inspected tab: the panel document and (normally) the real DevTools page. */
export interface PanelHandle {
  /** The panel document, opened as an extension page. */
  readonly page: Page;
  /** The built DevTools page, or `undefined` when opened with `announce: false`. */
  readonly devtoolsPage: Page | undefined;
  /** The context the pages live in. */
  readonly extension: ExtensionContextHandle;
  /** The inspected tab. */
  readonly tabId: number;
  /** The theme the stub reports. */
  readonly theme: DevtoolsTheme;
  /** The expected inspected URL, when one was given. */
  readonly inspectedUrl: string | undefined;
  /** The panel document's URL. */
  readonly url: string;
  /** The accessor map over {@link page}. */
  readonly locators: PanelLocators;
  /** The pill's current state, one of `PANEL_CONNECTION_STATUSES`. */
  connectionStatus(): Promise<PanelConnectionStatus | undefined>;
  /** Resolve once the pill reads `status`'s imported label. */
  waitForConnectionStatus(
    status: PanelConnectionStatus,
    options?: { readonly timeoutMs?: number | undefined },
  ): Promise<void>;
  /**
   * Set the element DevTools reports as selected (`$0`) to the first match of
   * `selector` in the inspected page, or clear it with `undefined`. Nothing is
   * dispatched: see {@link triggerElementSelectionChanged} and {@link selectTarget}.
   */
  setSelectedElement(selector: string | undefined): void;
  /** The current `$0` selector. */
  selectedElement(): string | undefined;
  /** The inspected application page, resolved from the tab when it was not given. */
  inspectedPage(): Promise<Page | undefined>;
  /** Every evaluation the stub answered (bounded to the most recent 100), oldest first. */
  evalLog(): readonly InspectedEvalRecord[];
  /** The bounded, scrubbed console and uncaught-error log of both documents, oldest first. */
  consoleLog(): readonly string[];
  /** Console errors and uncaught exceptions only, oldest first (scrubbed). */
  panelErrors(): readonly string[];
  /** Attach {@link consoleLog} to the running test's report (a no-op outside a test). */
  attachConsoleLog(name?: string): Promise<void>;
  /**
   * Reload the DevTools page (which unbinds and re-announces the tab) and the
   * panel, then wait until both are interactive again.
   */
  reload(): Promise<void>;
  /** Whether {@link close} has been called. */
  isClosed(): boolean;
  /**
   * Attach the console log when the running test failed (see
   * {@link PanelCloseOptions.attachOnFailure}), close the panel page, then the
   * DevTools page (unbinding the tab), and confirm both report closed. Every
   * step is attempted even when an earlier one failed.
   *
   * Rejects — after all of them ran — with one bounded, scrubbed error naming
   * each failure: the attachment, a `close()` that rejected, a page still open
   * afterwards. Idempotent: a second call returns the first call's outcome,
   * rejection included.
   */
  close(options?: PanelCloseOptions): Promise<void>;
}

/** Internals the pairing and selection helpers reach through a {@link PanelHandle}. */
const PANEL_STATES = new WeakMap<PanelHandle, PanelState>();

/** The state of `panel`, which must come from {@link openPanelPage}. */
function panelState(panel: PanelHandle): PanelState {
  const state = PANEL_STATES.get(panel);
  if (state === undefined) {
    throw new Error(
      'This PanelHandle was not created by openPanelPage() in tests/e2e/helpers/chrome.ts.',
    );
  }
  return state;
}

/** The recent panel-side errors, as a failure-message suffix. */
function errorsSuffix(state: PanelState): string {
  const recent = state.errors.slice(-ERRORS_QUOTED);
  return recent.length === 0 ? '' : ` Recent panel errors: ${recent.join(' | ')}`;
}

/**
 * Forward a document's console messages and uncaught exceptions into the
 * handle's bounded, scrubbed log — a panel-side exception otherwise shows up
 * only as a mysteriously empty DOM.
 */
function forwardConsole(state: PanelState, page: Page, caller: EvalCaller): void {
  page.on('console', (message) => {
    const line = `[${caller}] console.${message.type()}: ${message.text()}`;
    appendBounded(state.consoleLines, line, state.secrets);
    if (message.type() === 'error') {
      appendBounded(state.errors, line, state.secrets);
    }
  });
  page.on('pageerror', (error) => {
    const line = `[${caller}] uncaught ${error.name}: ${error.message}`;
    appendBounded(state.consoleLines, line, state.secrets);
    appendBounded(state.errors, line, state.secrets);
  });
}

/** The role of each document's page in a teardown failure line. */
const PAGE_LABELS = Object.freeze({
  devtools: 'DevTools page',
  panel: 'panel page',
} as const satisfies Record<EvalCaller, string>);

/**
 * Open a page of the context with the eval binding and the stub installed
 * ahead of navigation. A page whose preparation fails is closed before the
 * error propagates — the caller never received it, so nothing else could —
 * and a failure to close it is appended to that error.
 */
async function prepareStubbedPage(
  state: PanelState,
  caller: EvalCaller,
  stubArgs: DevtoolsStubArgs,
): Promise<Page> {
  const page = await state.extension.context.newPage();
  try {
    forwardConsole(state, page, caller);
    await page.exposeBinding(
      EVAL_BINDING,
      (_source: unknown, expression: unknown, evalOptions: unknown) =>
        answerInspectedEval(state, caller, expression, evalOptions),
    );
    await page.addInitScript(installDevtoolsStub, stubArgs);
    return page;
  } catch (error) {
    throw await errorAfterClosingPages(error, [[PAGE_LABELS[caller], page]], state.secrets);
  }
}

/** What the stub in one document has observed. */
interface StubSnapshot {
  /** Whether the stub applied to this document at all. */
  readonly installed: boolean;
  /** The `panels.create` calls. */
  readonly created: readonly CreatedPanelRecord[];
  /** The registered `onSelectionChanged` listeners. */
  readonly selectionListeners: number;
}

/** Read the stub's observations in `page`. */
async function stubSnapshot(page: Page): Promise<StubSnapshot> {
  return page.evaluate((name) => {
    const control = (window as unknown as Record<string, DevtoolsStubControl | undefined>)[name];
    return control === undefined
      ? { installed: false, created: [], selectionListeners: 0 }
      : {
          installed: true,
          created: control.createdPanels(),
          selectionListeners: control.selectionListenerCount(),
        };
  }, STUB_CONTROL_GLOBAL);
}

/** A DevTools event the stub can dispatch. */
type StubEvent = 'selectionChanged' | 'panelShown' | 'panelHidden';

/** Dispatch `event` in `page`; resolves with how many listeners ran, or `-1` when no stub is installed. */
async function fireStubEvent(page: Page, event: StubEvent): Promise<number> {
  return page.evaluate(
    ({ name, which }) => {
      const control = (window as unknown as Record<string, DevtoolsStubControl | undefined>)[name];
      if (control === undefined) {
        return -1;
      }
      switch (which) {
        case 'selectionChanged':
          return control.fireSelectionChanged();
        case 'panelShown':
          return control.firePanelShown();
        default:
          return control.firePanelHidden();
      }
    },
    { name: STUB_CONTROL_GLOBAL, which: event },
  );
}

/**
 * Wait until the real `src/devtools/devtools.ts` has bootstrapped in `page`:
 * it created the panel (and named the document {@link panelPageUrl} resolved)
 * and subscribed to `onSelectionChanged`.
 */
async function waitForDevtoolsBootstrap(
  state: PanelState,
  page: Page,
  panelPath: string,
  timeoutMs: number,
): Promise<void> {
  await pollUntilReady(
    async () => {
      const snapshot = await stubSnapshot(page);
      if (!snapshot.installed) {
        return 'the chrome.devtools stub did not apply to the DevTools page';
      }
      const [first] = snapshot.created;
      if (first === undefined) {
        return 'devtools.ts has not called chrome.devtools.panels.create';
      }
      if (first.pagePath.replace(/^\/+/, '') !== panelPath) {
        return `devtools.ts created its panel from "${first.pagePath}", but the panel document resolved from dist/ is "${panelPath}"`;
      }
      if (snapshot.selectionListeners === 0) {
        return 'devtools.ts has not subscribed to chrome.devtools.panels.elements.onSelectionChanged';
      }
      return READY;
    },
    timeoutMs,
    (lastSeen) =>
      `The built DevTools page did not bootstrap within ${String(timeoutMs)} ms: ${lastSeen}.${errorsSuffix(state)}`,
  );
}

/** Wait until the panel document shows its wordmark and one of the four imported connection labels. */
async function waitForPanelInteractive(
  state: PanelState,
  locators: PanelLocators,
  timeoutMs: number,
): Promise<void> {
  try {
    await expect(locators.wordmark).toBeVisible({ timeout: timeoutMs });
  } catch (error) {
    throw new Error(
      `The panel document did not render its "${PANEL_STRINGS.wordmark}" wordmark within ${String(timeoutMs)} ms.${errorsSuffix(state)}`,
      { cause: error },
    );
  }
  await pollUntilReady(
    async () => {
      const status = await locators.connectionStatus();
      return status === undefined ? 'the connection pill shows no recognisable label' : READY;
    },
    timeoutMs,
    (lastSeen) =>
      `The panel's connection pill did not show one of ${JSON.stringify(Object.values(PANEL_CONNECTION_LABELS))} within ${String(timeoutMs)} ms (${lastSeen}).${errorsSuffix(state)}`,
  );
}

/**
 * Open the DevTools surface for `options.tabId`: the real built DevTools page
 * first (as Chrome loads it when DevTools opens), then the panel document —
 * both with the test-owned `chrome.devtools` stub and the eval binding
 * installed BEFORE navigation — and wait until both are interactive by
 * locator and stub state, never by timeout.
 *
 * The DevTools page announces the tab (`devtools.hello`), so the worker sends
 * `session.bind`; the service answers with `session.bound` for the session
 * whose dev-server origin matches (see {@link waitForBound}). Keep the handle
 * open for as long as the binding is needed: closing the DevTools page is the
 * worker's `session.unbind` signal.
 *
 * @throws {Error} For an invalid tab id, a tab on an unexpected origin, an
 * `inspectedPage` that is another tab, or a document that never becomes
 * interactive — with the panel's recent console errors. Pages opened before
 * the failure are closed; when one of them does not close cleanly, the error
 * names that failure after the original description and keeps the original
 * error as its `cause`.
 */
export async function openPanelPage(
  handle: ExtensionContextHandle,
  options: OpenPanelPageOptions,
): Promise<PanelHandle> {
  const internals = extensionInternals(handle);
  const { tabId } = options;
  if (!Number.isSafeInteger(tabId) || tabId < 0) {
    throw new Error(
      `openPanelPage: tabId must be a non-negative integer (got ${String(tabId)}); resolve it with tabIdForPage().`,
    );
  }
  const theme = options.theme ?? 'dark';
  const announce = options.announce ?? true;
  const readyTimeoutMs = options.readyTimeoutMs ?? PANEL_READY_TIMEOUT_MS;
  const devtoolsReadyTimeoutMs = options.readyTimeoutMs ?? DEVTOOLS_PAGE_READY_TIMEOUT_MS;
  const builtOptions = { extensionPath: handle.extensionPath };
  const panelUrl = await panelPageUrl(handle.extensionId, builtOptions);
  const devtoolsUrl = devtoolsPageUrl(handle.extensionId, builtOptions);
  const panelPath = new URL(panelUrl).pathname.replace(/^\/+/, '');

  if (options.inspectedUrl !== undefined) {
    const expectedOrigin = originOf(options.inspectedUrl);
    const tab = (await queryTabs(await handle.getServiceWorker())).find(
      (candidate) => candidate.id === tabId,
    );
    if (tab === undefined) {
      throw new Error(`openPanelPage: no tab ${String(tabId)} exists in the context.`);
    }
    if (expectedOrigin === undefined || originOf(tab.url) !== expectedOrigin) {
      throw new Error(
        `openPanelPage: tab ${String(tabId)} shows ${tab.url}, not the expected origin of ${options.inspectedUrl}. The service binds a tab by dev-server origin; note the app must be served on localhost or 127.0.0.1 (the extension's host_permissions) for the content scripts to run.`,
      );
    }
  }
  if (options.inspectedPage !== undefined) {
    const actual = await tabIdForPage(handle, options.inspectedPage);
    if (actual !== tabId) {
      throw new Error(
        `openPanelPage: inspectedPage is tab ${String(actual)}, not the requested tab ${String(tabId)}.`,
      );
    }
  }

  const state: PanelState = {
    extension: handle,
    tabId,
    inspectedPage: options.inspectedPage,
    selection: undefined,
    evalSeq: 0,
    evals: [],
    consoleLines: [],
    errors: [],
    secrets: new Set(),
  };
  const stubArgs: DevtoolsStubArgs = {
    documentPaths: [new URL(panelUrl).pathname, new URL(devtoolsUrl).pathname],
    inspectedTabId: tabId,
    themeName: DEVTOOLS_THEME_NAMES[theme],
    evalBinding: EVAL_BINDING,
    controlGlobal: STUB_CONTROL_GLOBAL,
  };

  let devtoolsPage: Page | undefined;
  let page: Page | undefined;
  let locators: PanelLocators | undefined;
  const openBoth = async (): Promise<void> => {
    if (announce) {
      devtoolsPage = await prepareStubbedPage(state, 'devtools', stubArgs);
      await devtoolsPage.goto(devtoolsUrl, { timeout: devtoolsReadyTimeoutMs });
      await waitForDevtoolsBootstrap(state, devtoolsPage, panelPath, devtoolsReadyTimeoutMs);
    }
    page = await prepareStubbedPage(state, 'panel', stubArgs);
    await page.goto(panelUrl, { timeout: readyTimeoutMs });
    locators = panelLocators(page);
    await waitForPanelInteractive(state, locators, readyTimeoutMs);
    if (devtoolsPage !== undefined) {
      await fireStubEvent(devtoolsPage, 'panelShown');
    }
  };
  try {
    await openBoth();
  } catch (error) {
    // Both pages are attempted; the opening failure leads the rethrown error.
    throw await errorAfterClosingPages(
      error,
      [
        [PAGE_LABELS.panel, page],
        [PAGE_LABELS.devtools, devtoolsPage],
      ],
      state.secrets,
    );
  }
  if (page === undefined || locators === undefined) {
    throw new Error('openPanelPage: the panel page was not opened.');
  }
  const panelPage: Page = page;
  const panelLocatorMap: PanelLocators = locators;
  const devtools: Page | undefined = devtoolsPage;

  let closing: Promise<void> | undefined;
  const panel: PanelHandle = {
    page: panelPage,
    devtoolsPage: devtools,
    extension: handle,
    tabId,
    theme,
    inspectedUrl: options.inspectedUrl,
    url: panelUrl,
    locators: panelLocatorMap,
    connectionStatus: () => panelLocatorMap.connectionStatus(),
    async waitForConnectionStatus(status, waitOptions) {
      const timeoutMs = waitOptions?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      await pollUntilReady(
        async () => {
          const seen = await panelLocatorMap.connectionStatus();
          return seen === status
            ? READY
            : `the pill reads ${seen === undefined ? 'nothing recognisable' : `"${PANEL_CONNECTION_LABELS[seen]}"`}`;
        },
        timeoutMs,
        (lastSeen) =>
          `The panel's connection pill did not read "${PANEL_CONNECTION_LABELS[status]}" within ${String(timeoutMs)} ms (${lastSeen}).${errorsSuffix(state)}`,
      );
    },
    setSelectedElement(selector) {
      if (selector !== undefined && selector.trim() === '') {
        throw new Error('setSelectedElement: the selector is empty.');
      }
      state.selection = selector;
    },
    selectedElement: () => state.selection,
    inspectedPage: () => inspectedPageOf(state),
    evalLog: () => [...state.evals],
    consoleLog: () => state.consoleLines.map((line) => scrub(line, state.secrets)),
    panelErrors: () => state.errors.map((line) => scrub(line, state.secrets)),
    async attachConsoleLog(name = 'debug-generator-panel-console') {
      const info = currentTestInfo();
      if (info === undefined) {
        return;
      }
      const lines = state.consoleLines.map((line) => scrub(line, state.secrets));
      await info.attach(name, {
        body: [
          `Panel tab ${String(tabId)} — the last ${String(lines.length)} console line(s) (capped at ${String(PANEL_CONSOLE_LOG_LIMIT)} lines of ${String(PANEL_CONSOLE_LINE_MAX_LENGTH)} characters; credential-shaped values redacted).`,
          ...lines,
        ].join('\n'),
        contentType: 'text/plain',
      });
    },
    async reload() {
      if (closing !== undefined) {
        throw new Error('reload: this panel handle is closed.');
      }
      if (devtools !== undefined) {
        await devtools.reload({ timeout: devtoolsReadyTimeoutMs });
        await waitForDevtoolsBootstrap(state, devtools, panelPath, devtoolsReadyTimeoutMs);
      }
      await panelPage.reload({ timeout: readyTimeoutMs });
      await waitForPanelInteractive(state, panelLocatorMap, readyTimeoutMs);
      if (devtools !== undefined) {
        await fireStubEvent(devtools, 'panelShown');
      }
    },
    isClosed: () => closing !== undefined,
    close(closeOptions) {
      closing ??= (async () => {
        internals.openPanels.delete(panel);
        const failures: string[] = [];
        if ((closeOptions?.attachOnFailure ?? true) && currentTestFailed()) {
          await attemptTeardown(
            failures,
            "attaching the panel's console log",
            () => panel.attachConsoleLog(),
            state.secrets,
          );
        }
        await closePageInto(failures, PAGE_LABELS.panel, panelPage, state.secrets);
        if (devtools !== undefined) {
          await closePageInto(failures, PAGE_LABELS.devtools, devtools, state.secrets);
        }
        if (failures.length > 0) {
          throw new Error(
            teardownMessage(`Closing the panel of tab ${String(tabId)} was incomplete`, failures),
          );
        }
      })();
      return closing;
    },
  };
  PANEL_STATES.set(panel, state);
  internals.openPanels.add(panel);
  return panel;
}

/** Options of {@link waitForBound}. */
export interface WaitForBoundOptions {
  /** Require this tab (normally the panel's `tabId`). */
  readonly tabId?: number | undefined;
  /**
   * Require the bound document to be this URL's document — compared by origin
   * and path, because the service stores the URL with query values redacted.
   */
  readonly url?: string | undefined;
  /** Only consider frames recorded at or after this index (`editorClient.snapshotIndex()`). */
  readonly sinceIndex?: number | undefined;
  /** The wait's budget; defaults to `DEFAULT_WAIT_TIMEOUT_MS`. */
  readonly timeoutMs?: number | undefined;
}

/** The `session.bound` payload. */
export type SessionBoundPayload = MessagePayload<'session.bound'>;

/**
 * Whether a `session.bound` frame announces a binding that now holds: an
 * establishment (no `reason`, or `bound`). `replaced` is told to the DISPLACED
 * tab, and `navigated`, `origin-changed` and `unbound` describe an existing or
 * ended binding (`packages/protocol/src/messages/binding.ts` `BINDING_REASONS`).
 */
function isEstablishment(payload: SessionBoundPayload): boolean {
  return payload.reason === undefined || payload.reason === 'bound';
}

/** Whether two URLs name the same document, ignoring query and fragment. */
function sameDocument(expected: string, actual: string): boolean {
  try {
    const a = new URL(expected);
    const b = new URL(actual);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/**
 * Wait for the service to announce that a tab was bound — `session.bound`
 * establishing a binding, received on the recording editor client (which
 * searches its buffer first, so a frame that arrived before this call is
 * found). The panel's DevTools page sends `session.bind` on open; this never
 * sends it.
 *
 * @throws {Error} On timeout, listing every `session.bound` frame seen in the
 * window (session, tab, reason) — a replacement or an unbind reads differently
 * from silence.
 */
export async function waitForBound(
  editorClient: EditorClientHandle,
  sessionId?: string,
  options: WaitForBoundOptions = {},
): Promise<SessionBoundPayload> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const matches = (payload: SessionBoundPayload): boolean =>
    isEstablishment(payload) &&
    (sessionId === undefined || payload.sessionId === sessionId) &&
    (options.tabId === undefined || payload.tabId === options.tabId) &&
    (options.url === undefined || sameDocument(options.url, payload.url));
  try {
    const message = await editorClient.waitFor('session.bound', (payload) => matches(payload), {
      sinceIndex: options.sinceIndex,
      timeoutMs,
    });
    return message.payload;
  } catch (error) {
    const seen = editorClient
      .messagesOf('session.bound', { sinceIndex: options.sinceIndex })
      .map(
        ({ payload }) =>
          `{ session ${payload.sessionId}, tab ${String(payload.tabId)}, reason ${payload.reason ?? '(establishment)'} }`,
      );
    throw new Error(
      `waitForBound: no session.bound establishing a binding${sessionId === undefined ? '' : ` of session ${sessionId}`}${options.tabId === undefined ? '' : ` to tab ${String(options.tabId)}`} arrived within ${String(timeoutMs)} ms. session.bound frames seen: ${seen.length === 0 ? 'none' : seen.join(', ')}. The panel's DevTools page must stay open (it announces the tab), the extension must be paired (ensurePaired), and the service binds by dev-server origin, so the session's dev server must serve the tab's origin. ${describeError(error)}`,
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// Pairing (the devtools credential is minted at runtime, by the product)
// ---------------------------------------------------------------------------

/** How {@link ensurePaired} found the extension: already paired, or paired by this call. */
export type PairingOutcome = 'already' | 'paired';

/** The result of {@link ensurePaired} — never the credential, which stays in the worker. */
export interface PairingResult {
  readonly paired: PairingOutcome;
}

/** Options of {@link ensurePaired}. */
export interface EnsurePairedOptions {
  /** The worker to inspect storage in; defaults to the panel's context (re-acquired when suspended). */
  readonly serviceWorker?: Worker | undefined;
  /** Each pairing phase's budget; defaults to {@link PAIRING_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

/** A pill state for a failure message. */
function describeStatus(status: PanelConnectionStatus | undefined): string {
  return status === undefined ? 'nothing recognisable' : `"${PANEL_CONNECTION_LABELS[status]}"`;
}

/** The failure for a worker that cannot reach the service. */
function serviceUnreachable(dialled: string): string {
  return `the service is not running for the extension: its worker dials ${dialled} (the pairing dialog's saved service address) and reports "${PANEL_CONNECTION_LABELS['service-not-running']}". Start the service there (the Playwright webServer runs node apps/local-service/dist/main.js on DEBUGGEN_HOST/DEBUGGEN_PORT)`;
}

/**
 * The canonical service origin the extension would store for `address`, by the
 * extension's own rule (`parseServiceEndpoint`: `http:` on `127.0.0.1` or
 * `localhost`, the hosts its manifest grants). An address the worker cannot
 * reach is named as a configuration error rather than left to time out.
 */
function serviceEndpointOf(address: string, source: string): string {
  const parsed = parseServiceEndpoint(address);
  if (!parsed.ok) {
    throw new Error(
      `ensurePaired: ${source} ${address} is not an address the extension's worker can dial: ${parsed.error.message} Set DEBUGGEN_HOST to 127.0.0.1 or localhost.`,
    );
  }
  return parsed.value;
}

/**
 * What the worker has saved under `SERVICE_ENDPOINT_STORAGE_KEY` — written by
 * the pairing dialog's "Service address" field, absent when the default
 * applies. The value is an origin, not a secret. `refused` when the stored
 * value is one the extension itself would not dial.
 */
type StoredServiceEndpoint =
  | { readonly kind: 'default' }
  | { readonly kind: 'configured'; readonly origin: string }
  | { readonly kind: 'refused' };

async function readStoredServiceEndpoint(source: WorkerSource): Promise<StoredServiceEndpoint> {
  const worker = await workerOf(source);
  const stored: unknown = await worker.evaluate(async (key) => {
    const host = globalThis as unknown as {
      chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
    };
    const items = await host.chrome.storage.local.get(key);
    return items[key];
  }, SERVICE_ENDPOINT_STORAGE_KEY);
  if (stored === undefined) {
    return { kind: 'default' };
  }
  const parsed = parseServiceEndpoint(stored);
  return parsed.ok ? { kind: 'configured', origin: parsed.value } : { kind: 'refused' };
}

/** The origin the worker dials for `stored`, or `undefined` when the stored value is refused. */
function dialledOrigin(stored: StoredServiceEndpoint, defaultOrigin: string): string | undefined {
  switch (stored.kind) {
    case 'default':
      return defaultOrigin;
    case 'configured':
      return stored.origin;
    case 'refused':
      return undefined;
  }
}

/**
 * The value the dialog's "Service address" field shows once it has read the
 * saved setting: the saved origin, or blank for the default and for a refused
 * value (which the dialog reports as a field error instead).
 */
function prefilledAddress(stored: StoredServiceEndpoint): string {
  return stored.kind === 'configured' ? stored.origin : '';
}

/**
 * Explain why pairing did not reach "Connected", distinguishing the three
 * realistic causes: the service is unreachable, the code was refused (expired
 * after 5 minutes, already used, or locked out for 60 s after 5 failures), or
 * the panel never reached the state that accepts a code.
 */
async function pairingFailureReason(
  panel: PanelHandle,
  state: PanelState,
  dialled: string,
): Promise<string> {
  const status = await panel.locators.connectionStatus().catch(() => undefined);
  if (status === 'service-not-running') {
    return serviceUnreachable(dialled);
  }
  const dialogOpen = await panel.locators.pairDialog.isVisible().catch(() => false);
  if (dialogOpen) {
    const text = ((await panel.locators.pairDialog.textContent().catch(() => null)) ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return `the pairing code was refused — a code is valid for 5 minutes and for one use, and 5 failed attempts lock pairing for 60 seconds; the dialog reads "${truncate(scrub(text, state.secrets), 300)}"`;
  }
  return `the code was submitted but the pill reads ${describeStatus(status)} rather than "${PANEL_CONNECTION_LABELS.connected}"`;
}

/**
 * Pair the extension with the service through the product's own flow, unless
 * it is already paired.
 *
 * Idempotent: when the pill settles on "Connected" and the worker holds a
 * credential of the stored shape, it returns `{ paired: 'already' }` at once —
 * the suite shares one context, `tests/browser/extension-connect.spec.ts`
 * leaves pairing established, and {@link resetExtensionState} keeps it.
 * Otherwise: `service.pairStart()` (the editor credential) yields the one-time
 * code; the panel's `PairDialog` is opened (through `ConnectionStatus`'s
 * "Pair…" action when not already open), the suite's service origin is typed
 * into its "Service address" field (blank when that origin is
 * `DEFAULT_SERVICE_BASE_URL`) and the code is submitted; the dialog saves the
 * address first, and the service worker then calls `POST /pair/complete` at
 * that address from its `chrome-extension://<id>` origin and stores the
 * devtools credential. A per-clone `DEBUGGEN_HOST`/`DEBUGGEN_PORT` therefore
 * reaches the worker exactly as a developer's non-default port does. This
 * process never calls `/pair/complete`, and the code is never printed: it is
 * registered for scrubbing before it is typed.
 *
 * A stored credential counts as "already paired" only while the worker's saved
 * address is the suite's service; one paired with another address is removed
 * and pairing starts afresh.
 *
 * @throws {Error} Naming the cause: the service is unreachable, the code was
 * refused, or the panel never offered its pairing dialog (a UI regression).
 */
export async function ensurePaired(
  service: ServiceHandle,
  panel: PanelHandle,
  options: EnsurePairedOptions = {},
): Promise<PairingResult> {
  const state = panelState(panel);
  if (panel.isClosed()) {
    throw new Error('ensurePaired: the panel handle is closed; open one with openPanelPage().');
  }
  const target = serviceEndpointOf(service.baseUrl, "the suite's service address");
  const defaultOrigin = serviceEndpointOf(
    DEFAULT_SERVICE_BASE_URL,
    "the extension's DEFAULT_SERVICE_BASE_URL",
  );
  const timeoutMs = options.timeoutMs ?? PAIRING_TIMEOUT_MS;
  const source: WorkerSource = options.serviceWorker ?? panel.extension;
  const { locators } = panel;
  const storedEndpoint = await readStoredServiceEndpoint(source);

  if (dialledOrigin(storedEndpoint, defaultOrigin) === target) {
    // 1. The worker dials the suite's service. Let the pill settle: a stored
    //    credential either connects or is refused by the service (a rotated
    //    token, a fresh DEBUGGEN_HOME) and cleared by the worker, which shows
    //    as "Not paired".
    let settled: PanelConnectionStatus | undefined;
    try {
      await pollUntilReady(
        async () => {
          settled = await locators.connectionStatus();
          return settled === 'connected' || settled === 'not-paired'
            ? READY
            : `the pill reads ${describeStatus(settled)}`;
        },
        timeoutMs,
        (lastSeen) =>
          `ensurePaired: the pill did not settle on "${PANEL_CONNECTION_LABELS.connected}" or "${PANEL_CONNECTION_LABELS['not-paired']}" within ${String(timeoutMs)} ms (${lastSeen}).${errorsSuffix(state)}`,
      );
    } catch (error) {
      if (settled === 'service-not-running') {
        throw new Error(`ensurePaired: ${serviceUnreachable(target)}.${errorsSuffix(state)}`, {
          cause: error,
        });
      }
      throw error;
    }
    if (settled === 'connected') {
      if (await hasStoredDevtoolsCredential(source)) {
        return { paired: 'already' };
      }
      throw new Error(
        `ensurePaired: the panel reports "${PANEL_CONNECTION_LABELS.connected}" but no devtools credential of the stored shape is under ${DEVTOOLS_TOKEN_STORAGE_KEY} in chrome.storage.local.`,
      );
    }
  }
  if (await hasStoredDevtoolsCredential(source)) {
    // A credential the suite's service does not accept — refused and not yet
    // cleared, or paired with another address: remove it (by key; its value is
    // never read) so the dialog pairs afresh.
    await removeWorkerStorage(await workerOf(source), 'local', DEVTOOLS_TOKEN_STORAGE_KEY);
  }
  await panel.waitForConnectionStatus('not-paired', { timeoutMs });

  // 2. The one-time code, registered for scrubbing before it goes anywhere.
  const { code } = await service.pairStart();
  state.secrets.add(code);

  // 3. The panel's own pairing affordance: ConnectionStatus → PairDialog.
  try {
    if (!(await locators.pairDialog.isVisible())) {
      await locators.pairButton.click({ timeout: timeoutMs });
    }
    await expect(locators.pairCodeInput).toBeVisible({ timeout: timeoutMs });
  } catch (error) {
    throw new Error(
      `ensurePaired: the panel never offered its pairing dialog — "${PANEL_STRINGS.pairAction}" in the connection pill must open "${PANEL_STRINGS.pairDialogTitle}" while the pill reads "${PANEL_CONNECTION_LABELS['not-paired']}" (a UI regression in ConnectionStatus or PairDialog).${errorsSuffix(state)}`,
      { cause: error },
    );
  }
  // The dialog prefills the address field from the saved setting; typing only
  // after that read has landed means the value submitted is the one typed
  // here, never a late prefill over it.
  await expect(locators.pairServiceAddressInput).toHaveValue(prefilledAddress(storedEndpoint), {
    timeout: timeoutMs,
  });
  await locators.pairServiceAddressInput.fill(target === defaultOrigin ? '' : target);
  await locators.pairCodeInput.fill(code);
  await locators.pairSubmitButton.click();

  // 4. The worker completes pairing from its own origin and connects.
  try {
    await panel.waitForConnectionStatus('connected', { timeoutMs });
  } catch (error) {
    throw new Error(
      `ensurePaired: pairing did not reach "${PANEL_CONNECTION_LABELS.connected}" within ${String(timeoutMs)} ms: ${await pairingFailureReason(panel, state, target)}.${errorsSuffix(state)}`,
      { cause: error },
    );
  }
  const savedEndpoint = dialledOrigin(await readStoredServiceEndpoint(source), defaultOrigin);
  if (savedEndpoint !== target) {
    throw new Error(
      `ensurePaired: pairing connected, but the worker's saved service address (${SERVICE_ENDPOINT_STORAGE_KEY}) is ${savedEndpoint ?? 'a value the extension refuses'}, not the suite's service ${target}.`,
    );
  }
  if (!(await hasStoredDevtoolsCredential(source))) {
    throw new Error(
      `ensurePaired: the panel reports "${PANEL_CONNECTION_LABELS.connected}" but no devtools credential of the stored shape is under ${DEVTOOLS_TOKEN_STORAGE_KEY}.`,
    );
  }
  return { paired: 'paired' };
}

// ---------------------------------------------------------------------------
// Element selection — `$0` and the owner chain, through the product
// ---------------------------------------------------------------------------

/** Which product path produced a selection. */
export type TargetSelectionRoute = 'devtools-eval' | 'panel-picker';

/** Options of {@link selectTarget}. */
export interface SelectTargetOptions {
  /** The DevTools surface of the application's tab. */
  readonly panel: PanelHandle;
  /** The application page — the panel's inspected tab. */
  readonly appPage: Page;
  /** The element to select, as a CSS selector in `appPage` (its first match is `$0`). */
  readonly selector: string;
  /**
   * The recording editor client. With it, the result is the target the
   * service recorded (`session.updated` carrying `session.target`); without
   * it, the panel's rendering of the target is awaited instead.
   */
  readonly editorClient?: EditorClientHandle | undefined;
  /** The session the target must be recorded on (with `editorClient`). */
  readonly sessionId?: string | undefined;
  /** Force one route instead of preferring `devtools-eval`. */
  readonly route?: TargetSelectionRoute | undefined;
  /** The overall budget for the target to be observable; defaults to {@link TARGET_SELECTION_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /**
   * Accept only a descriptor that carries a React owner chain, describing `$0`
   * again (`devtools-eval`) until it does and waiting for a recorded target
   * that carries one. On a React page the chain exists only once React owns the
   * element, so this rides out a page that is still hydrating or is reloading
   * after an instrumentation patch reached a client module.
   */
  readonly requireOwnerChain?: boolean | undefined;
}

/** The result of {@link selectTarget}. */
export interface SelectTargetResult {
  /** The target, validated against `selectedTargetSchema`. */
  readonly target: SelectedTarget;
  /** The product path that produced it. */
  readonly route: TargetSelectionRoute;
  /** Why `devtools-eval` could not be driven, when the panel's picker was used instead. */
  readonly fallbackReason: string | undefined;
}

/** A validated descriptor, or a readable failure naming the schema issues. */
function validateTarget(value: unknown, where: string): SelectedTarget {
  const parsed = selectedTargetSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `${where} is not a valid SelectedTarget: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}.`,
    );
  }
  return parsed.data;
}

/** Whether two descriptors name the same element on the same document. */
function sameTarget(a: SelectedTarget, b: SelectedTarget): boolean {
  return a.selector === b.selector && a.tagName === b.tagName && a.url === b.url;
}

/** The newest evaluation after `sinceSeq` from `caller` that read `$0`, if any. */
function selectionEvalAfter(
  state: PanelState,
  caller: EvalCaller,
  sinceSeq: number,
): InspectedEvalRecord | undefined {
  return state.evals
    .filter((record) => record.seq > sinceSeq && record.caller === caller && record.usesSelection)
    .at(-1);
}

/** Wait for a selection evaluation from `caller` after `sinceSeq`; `undefined` when none arrived in time. */
async function awaitSelectionEval(
  state: PanelState,
  caller: EvalCaller,
  sinceSeq: number,
  timeoutMs: number,
): Promise<InspectedEvalRecord | undefined> {
  try {
    await pollUntilReady(
      () =>
        Promise.resolve(
          selectionEvalAfter(state, caller, sinceSeq) === undefined
            ? `no $0 evaluation from the ${caller} document yet`
            : READY,
        ),
      timeoutMs,
      (lastSeen) => lastSeen,
    );
  } catch {
    return undefined;
  }
  return selectionEvalAfter(state, caller, sinceSeq);
}

/** The descriptor the product's DevTools-page expression answered (`{ ok, target } | { ok: false, reason }`). */
function descriptorFromDevtoolsEval(record: InspectedEvalRecord): SelectedTarget {
  if (record.outcome !== 'value') {
    throw new Error(
      `selectTarget: the DevTools page's $0 expression did not evaluate (${record.outcome}: ${record.detail ?? 'no detail'}).`,
    );
  }
  const value = record.value;
  if (isRecord(value) && value.ok === true) {
    return validateTarget(value.target, "The DevTools page's selection descriptor");
  }
  const reason = isRecord(value) && typeof value.reason === 'string' ? value.reason : 'unknown';
  const hint =
    reason === 'agent-unavailable'
      ? " The MAIN-world agent's describeTarget is missing: the page must be served on localhost or 127.0.0.1 (the extension's host_permissions) and navigated after the context started."
      : '';
  throw new Error(
    `selectTarget: the product's selection expression answered { ok: false, reason: "${reason}" } for ${record.selector ?? '(no selection)'}.${hint}`,
  );
}

/** The descriptor the panel's "Use selected element" expression answered (`describeTarget($0)` or `null`). */
function descriptorFromPanelEval(record: InspectedEvalRecord): SelectedTarget {
  if (record.outcome !== 'value') {
    throw new Error(
      `selectTarget: the panel's $0 expression did not evaluate (${record.outcome}: ${record.detail ?? 'no detail'}).`,
    );
  }
  if (record.value === null || record.value === undefined) {
    throw new Error(
      `selectTarget: window.__DEBUGGEN__.describeTarget answered nothing for ${record.selector ?? '(no selection)'} — the MAIN-world agent is not armed in the inspected page.`,
    );
  }
  return validateTarget(record.value, "The panel's selection descriptor");
}

/**
 * Drive `devtools-eval`: set `$0` and dispatch `onSelectionChanged` in the real
 * DevTools page, whose `devtools.ts` evaluates `SELECTION_DESCRIPTOR_EXPRESSION`
 * (answered in the inspected page) and posts `devtools.element` to the worker,
 * which forwards `target.selected` for the bound session. Resolves with the
 * descriptor, or with a reason when this route cannot be driven.
 */
async function driveDevtoolsEval(
  panel: PanelHandle,
  state: PanelState,
  selector: string,
): Promise<{ descriptor: SelectedTarget } | { unavailable: string }> {
  const devtools = panel.devtoolsPage;
  if (devtools === undefined || devtools.isClosed()) {
    return { unavailable: 'the panel was opened without its DevTools page (announce: false)' };
  }
  const snapshot = await stubSnapshot(devtools);
  if (snapshot.selectionListeners === 0) {
    return { unavailable: 'devtools.ts has no onSelectionChanged listener registered' };
  }
  const mark = state.evalSeq;
  state.selection = selector;
  await fireStubEvent(devtools, 'selectionChanged');
  const record = await awaitSelectionEval(state, 'devtools', mark, SELECTION_EVAL_TIMEOUT_MS);
  if (record === undefined) {
    return {
      unavailable: `the DevTools page evaluated no $0 expression within ${String(SELECTION_EVAL_TIMEOUT_MS)} ms of the selection change`,
    };
  }
  return { descriptor: descriptorFromDevtoolsEval(record) };
}

/**
 * Drive `devtools-eval` until the product describes the element with a React
 * owner chain.
 *
 * The chain exists only once React owns the element: a page still hydrating
 * answers with none, and so does one that Next.js Fast Refresh is reloading
 * because an instrumentation patch reached a module outside a component
 * boundary. Each attempt is a real selection change the DevTools page answers
 * and posts; an attempt that fails while the page navigates is retried. The
 * poll is bounded by `timeoutMs` and reports the last description it saw.
 */
async function driveOwnedDescription(
  caller: string,
  panel: PanelHandle,
  state: PanelState,
  selector: string,
  timeoutMs: number,
): Promise<{ descriptor: SelectedTarget } | { unavailable: string }> {
  let described: SelectedTarget | undefined;
  let unavailable: string | undefined;
  await pollUntilReady(
    async () => {
      const attempt = await driveDevtoolsEval(panel, state, selector);
      if ('unavailable' in attempt) {
        unavailable = attempt.unavailable;
        return READY;
      }
      if (attempt.descriptor.componentChain.length === 0) {
        return `<${attempt.descriptor.tagName}> ${attempt.descriptor.selector} was described with no owner chain`;
      }
      described = attempt.descriptor;
      return READY;
    },
    timeoutMs,
    (lastSeen) =>
      `${caller}: the product never described "${selector}" with a React owner chain within ${String(timeoutMs)} ms; last seen: ${lastSeen}.${errorsSuffix(state)}`,
  );
  if (unavailable !== undefined) {
    return { unavailable };
  }
  if (described === undefined) {
    throw new Error(`${caller}: the owner-chain poll settled without a description.`);
  }
  return { descriptor: described };
}

/**
 * Drive `panel-picker`: set `$0` and press the panel's "Use selected element",
 * whose `App.tsx` evaluates its own `$0` expression and sends the
 * `target.selected` port request.
 */
async function drivePanelPicker(
  panel: PanelHandle,
  state: PanelState,
  selector: string,
  timeoutMs: number,
): Promise<SelectedTarget> {
  const button = panel.locators.useSelectedElementButton;
  try {
    await expect(button).toBeEnabled({ timeout: timeoutMs });
  } catch (error) {
    throw new Error(
      `selectTarget: "${PANEL_STRINGS.useSelectedElement}" is unavailable — it needs chrome.devtools (the stub) and a panel bound to a session (waitForBound).${errorsSuffix(state)}`,
      { cause: error },
    );
  }
  const mark = state.evalSeq;
  state.selection = selector;
  await button.click();
  const record = await awaitSelectionEval(state, 'panel', mark, SELECTION_EVAL_TIMEOUT_MS);
  if (record === undefined) {
    throw new Error(
      `selectTarget: pressing "${PANEL_STRINGS.useSelectedElement}" evaluated no $0 expression within ${String(SELECTION_EVAL_TIMEOUT_MS)} ms.${errorsSuffix(state)}`,
    );
  }
  return descriptorFromPanelEval(record);
}

/**
 * Wait until the descriptor the product produced is observable downstream:
 * recorded on the session at the service (via `session.updated` on the editor
 * client), or — without an editor client — rendered by the panel's target area.
 *
 * A selection of the very descriptor the session already records changes
 * nothing, so the service worker answers it as already recorded and sends no
 * `target.selected` (`sendSelectedTarget` in
 * apps/chrome-extension/src/background/service-worker.ts) — and no
 * `session.updated` follows. That is the case when an element picked before the
 * question (sent with `session.create`) is picked again once the session is
 * ready. The session's newest record is therefore checked first: when it
 * already holds this descriptor, it is the recorded target.
 */
async function observeSelection(
  options: SelectTargetOptions,
  state: PanelState,
  descriptor: SelectedTarget,
  sinceIndex: number | undefined,
  timeoutMs: number,
): Promise<SelectedTarget> {
  const { editorClient, sessionId, panel } = options;
  if (editorClient !== undefined) {
    const ofSession = ({ session }: MessagePayload<'session.updated'>): boolean =>
      sessionId === undefined || session.id === sessionId;
    const records = ({ session }: MessagePayload<'session.updated'>): boolean =>
      session.target !== undefined &&
      sameTarget(session.target, descriptor) &&
      (options.requireOwnerChain !== true || session.target.componentChain.length > 0);
    const newest =
      sessionId === undefined ? undefined : editorClient.lastOf('session.updated', ofSession);
    if (newest !== undefined && records(newest.payload)) {
      return validateTarget(newest.payload.session.target, "The session record's target");
    }
    try {
      const message = await editorClient.waitFor(
        'session.updated',
        (payload) => ofSession(payload) && records(payload),
        { sinceIndex, timeoutMs },
      );
      return validateTarget(message.payload.session.target, "The session record's target");
    } catch (error) {
      throw new Error(
        `selectTarget: the service never recorded the selected <${descriptor.tagName}> (${descriptor.selector}) on ${sessionId === undefined ? 'any session' : `session ${sessionId}`} within ${String(timeoutMs)} ms. The worker drops a selection from a tab that is not bound — wait for the binding first (waitForBound). ${describeError(error)}${errorsSuffix(state)}`,
        { cause: error },
      );
    }
  }
  try {
    await expect(panel.locators.targetDescriptor).toContainText(descriptor.selector, {
      timeout: timeoutMs,
    });
  } catch (error) {
    throw new Error(
      `selectTarget: the panel never showed the selected <${descriptor.tagName}> (${descriptor.selector}) as its target within ${String(timeoutMs)} ms. The worker drops a selection from a tab that is not bound — wait for the binding first (waitForBound).${errorsSuffix(state)}`,
      { cause: error },
    );
  }
  return descriptor;
}

/**
 * The checks every selection starts with, and the panel state it drives.
 *
 * @param caller The exported function, named in every failure.
 * @returns The panel's state, with the application page as the inspected page.
 * @throws {Error} When the selector is empty or matches nothing, a handle is
 * closed, or `appPage` is not the panel's tab.
 */
async function prepareSelection(
  caller: string,
  panel: PanelHandle,
  appPage: Page,
  selector: string,
  timeoutMs: number,
): Promise<PanelState> {
  const state = panelState(panel);
  if (selector.trim() === '') {
    throw new Error(`${caller}: the selector is empty.`);
  }
  if (panel.isClosed() || appPage.isClosed()) {
    throw new Error(`${caller}: the panel handle or the application page is closed.`);
  }
  try {
    await expect(appPage.locator(selector).first()).toBeAttached({ timeout: timeoutMs });
  } catch (error) {
    throw new Error(
      `${caller}: "${selector}" matches no element in ${appPage.url()} within ${String(timeoutMs)} ms.`,
      { cause: error },
    );
  }
  const appTab = await tabIdForPage(panel.extension, appPage);
  if (appTab !== panel.tabId) {
    throw new Error(
      `${caller}: the panel inspects tab ${String(panel.tabId)}, but the application page is tab ${String(appTab)}.`,
    );
  }
  state.inspectedPage = appPage;
  return state;
}

/**
 * Select an element of the application page through the product and return
 * the `SelectedTarget` it produced.
 *
 * Routes, preferred in this order and recorded in the result:
 * 1. `devtools-eval` — the real DevTools page's `onSelectionChanged` handler
 *    evaluates the product's own `$0` descriptor expression (answered in the
 *    inspected page by the MAIN-world agent's `describeTarget`, which resolves
 *    the owner chain) and posts `devtools.element`; the worker forwards
 *    `target.selected` to the service.
 * 2. `panel-picker` — when (1) cannot be driven: the panel's "Use selected
 *    element", which evaluates the panel's `$0` expression and sends the
 *    `target.selected` port request.
 *
 * A `SelectedTarget` is never fabricated here and `target.selected` is never
 * sent from the editor client (the `vscode` role is not authorised for it).
 *
 * The tab must already be bound (see {@link waitForBound}): the worker
 * forwards selections only for a bound tab.
 *
 * @throws {Error} When the selector matches nothing, `appPage` is not the
 * panel's tab, the product's expression reports a failure (for example
 * `agent-unavailable`), or the target never becomes observable.
 */
export async function selectTarget(options: SelectTargetOptions): Promise<SelectTargetResult> {
  const { panel, appPage, selector } = options;
  const timeoutMs = options.timeoutMs ?? TARGET_SELECTION_TIMEOUT_MS;
  const state = await prepareSelection('selectTarget', panel, appPage, selector, timeoutMs);
  const sinceIndex = options.editorClient?.snapshotIndex();

  let fallbackReason: string | undefined;
  if (options.route !== 'panel-picker') {
    const attempt =
      options.requireOwnerChain === true
        ? await driveOwnedDescription('selectTarget', panel, state, selector, timeoutMs)
        : await driveDevtoolsEval(panel, state, selector);
    if ('descriptor' in attempt) {
      const target = await observeSelection(
        options,
        state,
        attempt.descriptor,
        sinceIndex,
        timeoutMs,
      );
      return { target, route: 'devtools-eval', fallbackReason: undefined };
    }
    if (options.route === 'devtools-eval') {
      throw new Error(
        `selectTarget: the devtools-eval route cannot be driven: ${attempt.unavailable}.`,
      );
    }
    fallbackReason = attempt.unavailable;
  }
  const descriptor = await drivePanelPicker(panel, state, selector, timeoutMs);
  const target = await observeSelection(options, state, descriptor, sinceIndex, timeoutMs);
  return { target, route: 'panel-picker', fallbackReason };
}

/** Options of {@link describeSelection}. */
export interface DescribeSelectionOptions {
  /** The DevTools surface of the application's tab. */
  readonly panel: PanelHandle;
  /** The application page — the panel's inspected tab. */
  readonly appPage: Page;
  /** The element to select, as a CSS selector in `appPage` (its first match is `$0`). */
  readonly selector: string;
  /** The budget for the element to attach and be described; defaults to {@link TARGET_SELECTION_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Describe `$0` again until the descriptor carries a React owner chain (see {@link SelectTargetOptions.requireOwnerChain}). */
  readonly requireOwnerChain?: boolean | undefined;
}

/**
 * Select an element in the Elements panel *before* any question is asked, and
 * return the `SelectedTarget` the product described it as.
 *
 * This is the developer pointing at something first, the optional element
 * selection of the session workflow (`README.md`, "Session workflow"), made
 * here before the question is asked. The real DevTools page's
 * `onSelectionChanged` handler evaluates the product's own `$0` descriptor
 * expression, answered in the inspected page by the MAIN-world agent's
 * `describeTarget` — a capability the dormant agent arms before any session
 * exists for exactly this purpose (`packages/telemetry/src/browser/agent.ts`).
 * The page then posts `devtools.element`; with no session bound to the tab the
 * worker forwards nothing, so the descriptor is an input to the *next*
 * `session.create` — the role the VS Code view's pending target plays
 * (`apps/vscode-extension/src/state.ts`). Only the `devtools-eval` route can run
 * here: the panel's "Use selected element" needs a bound session.
 *
 * A `SelectedTarget` is never fabricated here: the result is the product's
 * answer, validated against `selectedTargetSchema`.
 *
 * @throws {Error} When the selector matches nothing, `appPage` is not the
 * panel's tab, the DevTools page cannot evaluate the selection, or the
 * product's expression reports a failure (for example `agent-unavailable`).
 */
export async function describeSelection(
  options: DescribeSelectionOptions,
): Promise<SelectedTarget> {
  const { panel, appPage, selector } = options;
  const timeoutMs = options.timeoutMs ?? TARGET_SELECTION_TIMEOUT_MS;
  const state = await prepareSelection('describeSelection', panel, appPage, selector, timeoutMs);
  const attempt =
    options.requireOwnerChain === true
      ? await driveOwnedDescription('describeSelection', panel, state, selector, timeoutMs)
      : await driveDevtoolsEval(panel, state, selector);
  if ('descriptor' in attempt) {
    return attempt.descriptor;
  }
  throw new Error(
    `describeSelection: the DevTools page could not describe the selection: ${attempt.unavailable}.`,
  );
}

/**
 * Dispatch `chrome.devtools.panels.elements.onSelectionChanged` in the panel's
 * real DevTools page, as the Elements panel does when the developer selects a
 * node (set `$0` first with {@link PanelHandle.setSelectedElement}).
 *
 * @returns How many listeners ran.
 * @throws {Error} When the panel has no DevTools page or nothing listens.
 */
export async function triggerElementSelectionChanged(panel: PanelHandle): Promise<number> {
  const devtools = panel.devtoolsPage;
  if (devtools === undefined || devtools.isClosed()) {
    throw new Error(
      'triggerElementSelectionChanged: the panel has no open DevTools page (it was opened with announce: false or closed).',
    );
  }
  const ran = await fireStubEvent(devtools, 'selectionChanged');
  if (ran <= 0) {
    throw new Error(
      `triggerElementSelectionChanged: no onSelectionChanged listener ran (${ran < 0 ? 'the stub is not installed' : 'devtools.ts registered none'}).`,
    );
  }
  return ran;
}

// ---------------------------------------------------------------------------
// `panelLocators` — the single accessor map over the panel document
// ---------------------------------------------------------------------------

/** Options of {@link PanelLocators.sourceLinkByFile}. */
export interface SourceLinkQuery {
  /** Require this 1-based line (the chip reads `file:line`). */
  readonly line?: number | undefined;
  /** Where to look; defaults to the panel document's `<main>` (summary and generated panel). */
  readonly within?: Locator | undefined;
}

/**
 * Every Playwright locator the specs address the panel through, built on
 * roles, accessible names, the imported connection labels and the renderer's
 * block classes — never on test ids, which the panel components declare none of.
 */
export interface PanelLocators {
  /** The panel document. */
  readonly page: Page;

  // --- header ------------------------------------------------------------
  /** The panel's `<header>` landmark (`components/Header.tsx`). */
  readonly header: Locator;
  /** The "Debug Generator" wordmark, a level-1 heading. */
  readonly wordmark: Locator;
  /** The connection pill (`components/ConnectionStatus.tsx`), matched by the imported labels. */
  readonly connectionPill: Locator;
  /** The pill's label text — one of the `PANEL_CONNECTION_LABELS` values — or `undefined`. */
  connectionLabel(): Promise<string | undefined>;
  /** The pill's state, or `undefined` when it shows no recognisable label. */
  connectionStatus(): Promise<PanelConnectionStatus | undefined>;
  /** The pill's "Pair…" action, present while not paired. */
  readonly pairButton: Locator;
  /** The session status badge beside the wordmark (`Created` … `Failed`). */
  readonly sessionStatusBadge: Locator;
  /** The session status the badge shows, or `undefined` when none is shown. */
  sessionStatus(): Promise<SessionStatus | undefined>;

  // --- capture controls ---------------------------------------------------
  /** The capture toggle while it offers to start. */
  readonly startCaptureButton: Locator;
  /** The capture toggle while it offers to stop. */
  readonly stopCaptureButton: Locator;
  /** The live (or last) capture's event counter. */
  readonly captureEventCounter: Locator;
  /** The counter's value, or `undefined` when no capture has run. */
  captureEventCount(): Promise<number | undefined>;

  // --- target picker ---------------------------------------------------------
  /** "Pick element" (`aria-pressed` reflects picker mode). */
  readonly pickElementButton: Locator;
  /** "Use selected element". */
  readonly useSelectedElementButton: Locator;
  /** Whether "Pick element" is pressed. */
  pickerActive(): Promise<boolean>;
  /** The "No element selected" badge. */
  readonly noTargetBadge: Locator;
  /** The session target's descriptor (tag, selector, text, component chain, page). */
  readonly targetDescriptor: Locator;

  // --- pairing -------------------------------------------------------------
  /** The pairing dialog (`role="dialog"`, `aria-modal`). */
  readonly pairDialog: Locator;
  /** Its "Pairing code" field. */
  readonly pairCodeInput: Locator;
  /** Its "Service address" field (the loopback origin the worker dials; blank = the default). */
  readonly pairServiceAddressInput: Locator;
  /** Its "Pair" submit button. */
  readonly pairSubmitButton: Locator;
  /** Its "Cancel" button. */
  readonly pairCancelButton: Locator;
  /** Its "Pairing failed" error state. */
  readonly pairFailure: Locator;

  // --- body ----------------------------------------------------------------
  /** The panel's `<main>`. */
  readonly main: Locator;
  /** The empty state shown before any session exists (`components/EmptyPanel.tsx`). */
  readonly emptyPanel: Locator;
  /** The non-blocking "A Debug Generator request did not complete" error. */
  readonly requestError: Locator;
  /** The "Session" summary region (`components/SessionSummary.tsx`). */
  readonly sessionSummary: Locator;

  // --- the generated panel (`packages/panel-renderer`) ----------------------
  /** The rendered panel (`PanelHost`'s `.dg-panel`). */
  readonly panelView: Locator;
  /** The panel title (`SummaryHeader`'s heading). */
  readonly panelTitle: Locator;
  /** The non-evidentiary headline, when the specification has one. */
  readonly panelHeadline: Locator;
  /** The "Observed" region. */
  readonly observedRegion: Locator;
  /** Each observed fact. */
  readonly observedFacts: Locator;
  /** The "Likely cause" region (rendered only when causes exist). */
  readonly likelyCauseRegion: Locator;
  /** Each likely cause (a list item carrying a confidence badge). */
  readonly likelyCauses: Locator;
  /** Every evidence chip (facts and causes), each carrying `data-event-id`. */
  readonly evidenceChips: Locator;
  /** Each cause's confidence badge (`low` / `medium` / `high`). */
  readonly confidenceBadges: Locator;
  /** Every source-link chip inside `<main>` (monospace `file:line`). */
  readonly sourceLinks: Locator;
  /** The interactive source-link chip(s) opening `file` (optionally at `line`). */
  sourceLinkByFile(file: string, query?: SourceLinkQuery): Locator;
  /** The fallback banner (`meta.fallback`). */
  readonly fallbackBanner: Locator;
  /** Nodes the renderer could not render (registry miss or malformed node). */
  readonly nodeErrors: Locator;
  /**
   * The node types the rendered panel contains, derived from each node's
   * component landmark (see {@link NODE_TYPE_BLOCK_CLASSES}). Waits for the
   * panel's loading states to settle first.
   *
   * @throws {Error} When no panel is rendered, or a node cannot be classified.
   */
  renderedNodeTypes(): Promise<Set<PanelNodeType>>;

  // --- live tail and event details ---------------------------------------
  /** The "Live event tail" region (present while a session exists). */
  readonly liveTail: Locator;
  /** Its "Show/Hide live events (n)" toggle (`aria-expanded`). */
  readonly liveTailToggle: Locator;
  /** Its data rows (newest first). */
  readonly liveTailRows: Locator;
  /** The "Selected event" drawer (`components/EventDetails.tsx`). */
  readonly eventDetails: Locator;
  /** The drawer's close button. */
  readonly eventDetailsClose: Locator;
}

/** The session status labels `components/Header.tsx` (`sessionStatusLabel`) shows: each status, capitalised. */
const SESSION_STATUS_LABELS: Readonly<Record<SessionStatus, string>> = Object.freeze(
  Object.fromEntries(
    SESSION_STATUSES.map((status) => [
      status,
      `${status.charAt(0).toUpperCase()}${status.slice(1)}`,
    ]),
  ) as Record<SessionStatus, string>,
);

/** A regular expression matching exactly one of `labels`. */
function exactAlternation(labels: readonly string[]): RegExp {
  return new RegExp(`^\\s*(?:${labels.map(escapeRegExp).join('|')})\\s*$`);
}

/** How long a locator reader waits for text before answering `undefined`. */
const READER_TIMEOUT_MS = 1_000;

/**
 * The accessor map over a panel document (normally `panel.locators`; exported
 * for a page opened some other way).
 */
export function panelLocators(page: Page): PanelLocators {
  const header = page.getByRole('banner');
  const connectionLabels = PANEL_CONNECTION_STATUSES.map(
    (status) => [status, PANEL_CONNECTION_LABELS[status]] as const,
  );
  const labelPrefix = new RegExp(
    `^\\s*(?:${connectionLabels.map(([, label]) => escapeRegExp(label)).join('|')})`,
  );
  const connectionPill = header.getByRole('status').filter({ hasText: labelPrefix });
  // The header's only badge whose whole text is a session status word
  // (`components/Header.tsx`): the pill's labels, "Picker on", "No element
  // selected" and the target's tag name never equal one.
  const sessionStatusBadge = header
    .locator(`.${PANEL_CLASSES.badge}`)
    .filter({ hasText: exactAlternation(Object.values(SESSION_STATUS_LABELS)) });
  const captureEventCounter = header.getByRole('group', {
    name: exactAlternation([PANEL_STRINGS.liveCounter, PANEL_STRINGS.lastCounter]),
  });
  const pickElementButton = header.getByRole('button', {
    name: PANEL_STRINGS.pickElement,
    exact: true,
  });
  const pairDialog = page.getByRole('dialog', { name: PANEL_STRINGS.pairDialogTitle });
  const main = page.getByRole('main');
  const panelView = main.locator(`.${PANEL_CLASSES.panel}`);
  const observedRegion = panelView.getByRole('region', {
    name: PANEL_STRINGS.observed,
    exact: true,
  });
  const likelyCauseRegion = panelView.getByRole('region', {
    name: PANEL_STRINGS.likelyCause,
    exact: true,
  });
  const liveTail = page.getByRole('region', { name: PANEL_STRINGS.liveTail, exact: true });
  const eventDetails = page.getByRole('complementary', {
    name: PANEL_STRINGS.eventDetails,
    exact: true,
  });

  const connectionLabel = async (): Promise<string | undefined> => {
    const text =
      (await connectionPill
        .first()
        .textContent({ timeout: READER_TIMEOUT_MS })
        .catch(() => null)) ?? '';
    return connectionLabels.find(([, label]) => text.trim().startsWith(label))?.[1];
  };

  return {
    page,
    header,
    wordmark: header.getByRole('heading', { level: 1, name: PANEL_STRINGS.wordmark, exact: true }),
    connectionPill,
    connectionLabel,
    async connectionStatus() {
      const label = await connectionLabel();
      return connectionLabels.find(([, candidate]) => candidate === label)?.[0];
    },
    pairButton: header.getByRole('button', { name: PANEL_STRINGS.pairAction, exact: true }),
    sessionStatusBadge,
    async sessionStatus() {
      if ((await sessionStatusBadge.count()) === 0) {
        return undefined;
      }
      const text = (
        (await sessionStatusBadge
          .first()
          .textContent({ timeout: READER_TIMEOUT_MS })
          .catch(() => null)) ?? ''
      ).trim();
      return SESSION_STATUSES.find((status) => SESSION_STATUS_LABELS[status] === text);
    },
    startCaptureButton: header.getByRole('button', {
      name: PANEL_STRINGS.startCapture,
      exact: true,
    }),
    stopCaptureButton: header.getByRole('button', { name: PANEL_STRINGS.stopCapture, exact: true }),
    captureEventCounter,
    async captureEventCount() {
      if ((await captureEventCounter.count()) === 0) {
        return undefined;
      }
      const text =
        (await captureEventCounter
          .first()
          .textContent({ timeout: READER_TIMEOUT_MS })
          .catch(() => null)) ?? '';
      const digits = text.replace(/\D/g, '');
      return digits === '' ? undefined : Number.parseInt(digits, 10);
    },
    pickElementButton,
    useSelectedElementButton: header.getByRole('button', {
      name: PANEL_STRINGS.useSelectedElement,
      exact: true,
    }),
    async pickerActive() {
      return (await pickElementButton.getAttribute('aria-pressed')) === 'true';
    },
    noTargetBadge: header.getByText(PANEL_STRINGS.noTarget, { exact: true }),
    // The descriptor's own Stack is the innermost one holding the "Target"
    // label (`components/TargetPicker.tsx` `TargetDescriptor`); outer stacks
    // come earlier in document order, so the last match is the descriptor.
    targetDescriptor: header
      .locator('.dg-stack')
      .filter({ has: page.getByText(PANEL_STRINGS.targetLabel, { exact: true }) })
      .last(),
    pairDialog,
    pairCodeInput: pairDialog.getByRole('textbox', { name: PANEL_STRINGS.pairingField }),
    pairServiceAddressInput: pairDialog.getByRole('textbox', {
      name: PANEL_STRINGS.serviceAddressField,
    }),
    pairSubmitButton: pairDialog.getByRole('button', {
      name: PANEL_STRINGS.pairSubmit,
      exact: true,
    }),
    pairCancelButton: pairDialog.getByRole('button', {
      name: PANEL_STRINGS.pairCancel,
      exact: true,
    }),
    pairFailure: pairDialog
      .locator(`.${PANEL_CLASSES.errorState}`)
      .filter({ hasText: PANEL_STRINGS.pairFailure }),
    main,
    emptyPanel: main.getByText(PANEL_STRINGS.emptyPanel, { exact: true }),
    requestError: main
      .locator(`.${PANEL_CLASSES.errorState}`)
      .filter({ hasText: PANEL_STRINGS.requestFailed }),
    sessionSummary: main.getByRole('region', { name: PANEL_STRINGS.sessionSummary, exact: true }),
    panelView,
    panelTitle: panelView.locator(`.${PANEL_CLASSES.summaryTitle}`),
    panelHeadline: panelView.locator(`.${PANEL_CLASSES.summaryHeadline}`),
    observedRegion,
    observedFacts: observedRegion.locator(`.${PANEL_CLASSES.summaryFact}`),
    likelyCauseRegion,
    likelyCauses: likelyCauseRegion
      .getByRole('listitem')
      .filter({ has: page.locator(`.${PANEL_CLASSES.summaryConfidence}`) }),
    evidenceChips: panelView.locator(`.${PANEL_CLASSES.summaryEvidence} [data-event-id]`),
    confidenceBadges: likelyCauseRegion.locator(`.${PANEL_CLASSES.summaryConfidence}`),
    sourceLinks: main.locator(`.${PANEL_CLASSES.sourceLink}`),
    sourceLinkByFile(file, query = {}) {
      // An interactive chip's accessible name always carries the full
      // location — "Open <file>:<line>:<column>" or "<visible> — open <file>:…"
      // (`components/SourceLink.tsx` `sourceLinkAccessibleName`) — even when
      // the visible `file:line` is abbreviated. Every chip in the extension
      // panel is interactive, because the panel supplies `openSource`.
      const scope = query.within ?? main;
      const chips = scope.locator(
        `.${PANEL_CLASSES.sourceLink}[aria-label*="open ${cssAttributeValue(file)}:" i]`,
      );
      return query.line === undefined
        ? chips
        : chips.filter({ hasText: new RegExp(`:${String(query.line)}(?!\\d)`) });
    },
    fallbackBanner: page.locator(`.${PANEL_CLASSES.fallbackBanner}`),
    nodeErrors: panelView.locator(`.${PANEL_CLASSES.nodeError}`),
    renderedNodeTypes: () => readRenderedNodeTypes(page, DEFAULT_WAIT_TIMEOUT_MS),
    liveTail,
    liveTailToggle: liveTail.getByRole('button', { name: /^(?:Show|Hide) live events \(/ }),
    // `primitives/DataTable.tsx`: each data row is the first `role="row"` child
    // of its `.dg-virtual-row` positioning wrapper (an expanded detail row
    // follows it), so header and detail rows are excluded.
    liveTailRows: liveTail
      .getByRole('grid', { name: PANEL_STRINGS.liveTailCaption })
      .locator(`.${PANEL_CLASSES.virtualRow} > [role="row"]:first-child`),
    eventDetails,
    eventDetailsClose: eventDetails.getByRole('button', {
      name: PANEL_STRINGS.closeEventDetails,
      exact: true,
    }),
  };
}

// ---------------------------------------------------------------------------
// Rendered node types and error states
// ---------------------------------------------------------------------------

/** Wait until at least one panel is rendered and none of its views is still loading. */
async function waitForPanelSettled(page: Page, timeoutMs: number): Promise<void> {
  const panels = page.getByRole('main').locator(`.${PANEL_CLASSES.panel}`);
  const loading = panels.locator(`.${PANEL_CLASSES.loadingState}`);
  await pollUntilReady(
    async () => {
      const rendered = await panels.count();
      if (rendered === 0) {
        return 'no rendered panel (.dg-panel) in <main>';
      }
      const pending = await loading.count();
      return pending === 0 ? READY : `${String(pending)} view(s) still loading`;
    },
    timeoutMs,
    (lastSeen) => `The rendered panel did not settle within ${String(timeoutMs)} ms (${lastSeen}).`,
  );
}

/**
 * Classify every node wrapper of the rendered panel(s). `NodeRenderer.tsx`
 * emits no node-type marker, so the type is derived from the component
 * landmark inside each `.dg-panel__node` wrapper:
 *
 * - a wrapper containing further wrappers is a container, typed by the
 *   closest layout block (`dg-section`, `dg-split`, `dg-stack`, or one of
 *   their `__` elements) between it and its first child wrapper;
 * - any other wrapper is a leaf, typed by the shallowest descendant carrying a
 *   leaf block class — or an element of that block (`block__…`), which is how
 *   some components root their loading, empty and error states. A titled leaf
 *   sits inside a `Section`, which this search passes through.
 */
async function readRenderedNodeTypes(page: Page, timeoutMs: number): Promise<Set<PanelNodeType>> {
  await waitForPanelSettled(page, timeoutMs);
  const blocks = NODE_BLOCKS_IN_MATCH_ORDER.map(([type, block]) => ({
    type,
    block,
    layout: (PANEL_LAYOUT_NODE_TYPES as readonly string[]).includes(type),
  }));
  const result = await page.evaluate(
    ({ blockList, panelClass, nodeClass, nodeErrorClass }) => {
      const belongsTo = (element: Element, block: string): boolean => {
        for (const cls of Array.from(element.classList)) {
          if (cls === block || cls.startsWith(`${block}__`)) {
            return true;
          }
        }
        return false;
      };
      const types: string[] = [];
      const unclassified: string[] = [];
      const main = document.querySelector('main') ?? document.body;
      const wrappers = Array.from(main.querySelectorAll(`.${panelClass} .${nodeClass}`));
      for (const wrapper of wrappers) {
        const where = wrapper.getAttribute('data-node-path') ?? '(no data-node-path)';
        if (wrapper.classList.contains(nodeErrorClass)) {
          unclassified.push(`${where}: rendered as a node failure`);
          continue;
        }
        let found: string | undefined;
        const nested = wrapper.querySelector(`.${nodeClass}`);
        if (nested !== null) {
          for (
            let element = nested.parentElement;
            element !== null && element !== wrapper && found === undefined;
            element = element.parentElement
          ) {
            const current = element;
            found = blockList.find(
              (entry) => entry.layout && belongsTo(current, entry.block),
            )?.type;
          }
        } else {
          let level = Array.from(wrapper.children);
          while (level.length > 0 && found === undefined) {
            for (const element of level) {
              found = blockList.find(
                (entry) => !entry.layout && belongsTo(element, entry.block),
              )?.type;
              if (found !== undefined) {
                break;
              }
            }
            level = level.flatMap((element) => Array.from(element.children));
          }
        }
        if (found === undefined) {
          const root = wrapper.firstElementChild;
          unclassified.push(
            `${where}: no component landmark (root classes "${root === null ? '' : root.className}")`,
          );
        } else {
          types.push(found);
        }
      }
      return { types, unclassified, wrappers: wrappers.length };
    },
    {
      blockList: blocks,
      panelClass: PANEL_CLASSES.panel,
      nodeClass: PANEL_CLASSES.node,
      nodeErrorClass: PANEL_CLASSES.nodeError,
    },
  );
  if (result.unclassified.length > 0) {
    throw new Error(
      `renderedNodeTypes: ${String(result.unclassified.length)} of ${String(result.wrappers)} node(s) could not be classified: ${result.unclassified.join('; ')}. Check NODE_TYPE_BLOCK_CLASSES against packages/panel-renderer/src/components.`,
    );
  }
  return new Set(result.types.filter(isPanelNodeType));
}

/** Options of {@link expectNoPanelErrorState}. */
export interface NoPanelErrorStateOptions {
  /** How long the panel may take to settle first; defaults to `DEFAULT_WAIT_TIMEOUT_MS`. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Assert the panel document's `<main>` shows no error state: no node the
 * renderer failed to render (`.dg-panel__node-error`, a registry miss or a
 * malformed node — `NodeRenderer` renders a visible failure rather than a
 * blank area) and no `ErrorState` anywhere in `<main>` (a view whose query
 * failed, "Could not generate the debugging panel", or the non-blocking
 * request error). A silent blank is impossible; an unnoticed error state is
 * not. Waits for the rendered panel's loading states to settle first when a
 * panel is present.
 */
export async function expectNoPanelErrorState(
  page: Page,
  options: NoPanelErrorStateOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const main = page.getByRole('main');
  if ((await main.locator(`.${PANEL_CLASSES.panel}`).count()) > 0) {
    await waitForPanelSettled(page, timeoutMs);
  }
  const found = await main
    .locator(`.${PANEL_CLASSES.nodeError}, .${PANEL_CLASSES.errorState}`)
    .evaluateAll((elements) =>
      elements.map((element) =>
        (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      ),
    );
  expect(found, 'the panel document shows error state(s)').toEqual([]);
}

// ---------------------------------------------------------------------------
// State reset
// ---------------------------------------------------------------------------

/** Options of {@link resetExtensionState}. */
export interface ResetExtensionStateOptions {
  /**
   * Keep the paired devtools credential in `chrome.storage.local` (default
   * `true`). Pairing is deliberately sticky across specs in the shared context:
   * `tests/browser/extension-connect.spec.ts` leaves it established, and
   * re-pairing per spec would spend a one-time code each time and invite the
   * 5-failure / 60-second lockout.
   */
  readonly keepPairing?: boolean | undefined;
}

/**
 * Reset the extension between specs, mirroring `resetExtensionState()` in
 * `tests/browser/fixtures.ts`: remove the persisted tab ↔ session bindings
 * (`BINDING_STORAGE_KEY`, the worker's only `chrome.storage.session` key —
 * `background/service-worker.ts`) and clear the `$0` selection of every open
 * panel of this extension, keeping the paired credential unless
 * `keepPairing: false`. The worker's live registry forgets a tab when that
 * tab's DevTools port disconnects, which {@link PanelHandle.close} does; this
 * clears what a restarted worker would otherwise re-associate. The worker is
 * never killed or restarted — a suspended one is re-acquired.
 */
export async function resetExtensionState(
  source: WorkerSource,
  options: ResetExtensionStateOptions = {},
): Promise<void> {
  const worker = await workerOf(source);
  await removeWorkerStorage(worker, 'session', BINDING_STORAGE_KEY);
  if (!(options.keepPairing ?? true)) {
    await removeWorkerStorage(worker, 'local', DEVTOOLS_TOKEN_STORAGE_KEY);
  }
  const extensionId = hostOf(worker.url());
  for (const handle of LIVE_EXTENSIONS) {
    if (handle.extensionId !== extensionId) {
      continue;
    }
    for (const panel of extensionInternals(handle).openPanels) {
      const state = PANEL_STATES.get(panel);
      if (state !== undefined) {
        state.selection = undefined;
      }
    }
  }
}
