/**
 * Acceptance test 4, "Generalization" (AAP §0.8.4): the spec that proves no demo knowledge is
 * baked into the product.
 *
 * It runs the slow-interaction workflow of `demo-slow-interaction.spec.ts` — the same question,
 * the same real pipeline — against `tests/fixtures/sample-next-app`, a Next.js App Router project
 * that shares no symbol name and no route with the demo. Everything the product needs to answer
 * has to come from code analysis, instrumentation and telemetry of that project; the behavioural
 * half of AAP §0.5.4 holds only if the session still reaches `generated` with a real trace and a
 * real panel, and if nothing it produced mentions the demo.
 *
 * ## What is asserted, test by test (serial: a failure skips its dependents)
 *
 * 1. **Launch** — the fixture is served through `POST /dev-server/launch` (the `sampleApp` worker
 *    fixture frees the port first), the launcher answered a `devServerUrl` and a `pid`, the URL
 *    answers 200, and the server behind it is the launcher's preloaded child. The pristine
 *    SHA-256 snapshot of the fixture's tracked files is taken here, before any session exists.
 * 2. **Workflow** — "Why is this button slow?" with the ping button selected through the real
 *    `$0` path reaches status `generated`; the investigation named the fixture's own widget and
 *    route handler; a plan was applied, and any unavailable signal degrades the capture with a
 *    reason and a hint instead of failing it. The generated panel renders in the panel document.
 * 3. **Trace** — one 32-hex trace spans the browser `interaction`, the `fetch` of the fixture's
 *    route, the server `http.server` span and the `route.handler` span, in that ancestor order;
 *    there is no database tier and none is required; durations respect the route's own delay.
 * 4. **Panel and analysis** — the panel passes `validatePanelSpec`, is not the fallback, composes
 *    `timeline` plus `flame` or `waterfall` from catalogued node types only, and every observed
 *    fact cites an event of this capture.
 * 5. **No demo vocabulary** — the forbidden-token list is read from the committed
 *    `scripts/no-hardcoding.policy.json`, the same list `scripts/check-no-hardcoding.mjs` enforces
 *    statically, and no artifact of the session carries any of its identifiers or routes.
 * 6. **Restoration** — the session ends through the product, `cleanup.completed` reports `clean`,
 *    every modification is `reverted`, the snapshot matches byte for byte and
 *    `scripts/check-no-residual-instrumentation.mjs --path tests/fixtures/sample-next-app` passes.
 *
 * ## Why the session outlives the test that created it
 *
 * The `sessions` fixture ends every session it tracks when its test finishes. The assertions
 * above are split into focused tests, and test 6 must observe the product's own end-of-session
 * path, so the session is registered with a module-scoped tracker instead; `test.afterAll` ends
 * whatever that tracker still holds (under a live editor announcement, which the `vscode` role
 * needs to end a session) and stops the fixture's dev server, leaving the port free.
 *
 * ## What this spec never does
 *
 * - It never writes under `tests/fixtures/sample-next-app`: the product's installer patches and
 *   the product's cleanup restores (AAP §0.5.1); the helpers only read and hash.
 * - It never starts `next dev` or sets `NODE_OPTIONS`: the launcher owns the preload and the
 *   server-agent credential.
 * - It never reads `.git/` or prints a credential; failure text names ids, kinds, paths and
 *   policy tokens only.
 * - It duplicates nothing in `tests/browser/**`, which drives a preload-free copy of the same
 *   fixture for browser-tier concerns only and never goes through the launcher.
 *
 * `tests/e2e/**` is exempt from the no-hardcoding gate; the only demo vocabulary here is the one
 * read from the policy file at run time.
 *
 * @module tests/e2e/generalization.spec
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { PANEL_NODE_CATALOG } from '@debuggen/panel-schema';
import type { PanelNodeType } from '@debuggen/panel-schema';
import type { AnalysisResult, UnavailableSignalPayload } from '@debuggen/protocol';
import { MAX_EPOCH_MS, MIN_EPOCH_MS } from '@debuggen/telemetry';
import type { TelemetryEvent, TelemetryKind } from '@debuggen/telemetry';

import {
  DEFAULT_SESSION_TIMEOUTS,
  E2E_TIMEOUTS,
  SessionWorkflowError,
  createSessionTracker,
  describeEvent,
  eventsOfKind,
  expect,
  expectAncestorKinds,
  expectAnyNodeType,
  expectEventOfKind,
  expectEvidenceResolves,
  expectFactsAndHypothesesSeparate,
  expectHexId,
  expectNoPanelErrorState,
  expectNoSpanIdCollisions,
  expectNodeTypes,
  expectSingleTrace,
  expectValidPanelSpec,
  flattenTrace,
  nodeTypesOf,
  repoPath,
  runDebugSession,
  tabIdForPage,
  test,
} from './helpers/fixtures';
import type {
  DebugSessionOutcome,
  PanelHandle,
  PanelSpec,
  SampleAppHandle,
  SampleAppLaunch,
  ServiceHandle,
  SessionInteraction,
  SessionRecord,
  SessionTracker,
  TrackedFileSnapshot,
} from './helpers/fixtures';
import {
  SAMPLE_APP_READY_PROBE_TIMEOUT_MS,
  SAMPLE_APP_REL_DIR,
  stopSampleApp,
} from './helpers/sample-app';

// ---------------------------------------------------------------------------
// The question and the fixture's published contract
// ---------------------------------------------------------------------------

/** The slow-interaction question, worded exactly as `demo-slow-interaction.spec.ts` asks it. */
const QUESTION = 'Why is this button slow?';

/** The fixture widget's button locator (`src/components/PingWidget.tsx`). */
const PING_BUTTON_TEST_ID = 'ping-button';

/** The fixture widget's `role="status"` reply region. */
const PING_RESULT_TEST_ID = 'ping-result';

/** The element the question is about, selected through the product's `$0` path. */
const PING_BUTTON_SELECTOR = `[data-testid="${PING_BUTTON_TEST_ID}"]`;

/** The fixture's one interactive component, project-relative POSIX. */
const WIDGET_FILE = 'src/components/PingWidget.tsx';

/** The fixture's one route handler, project-relative POSIX. */
const ROUTE_FILE = 'app/api/ping/route.ts';

/** The component that owns the button: the owner chain the product resolves must name it. */
const WIDGET_COMPONENT = 'PingWidget';

/** The widget's request site: `fetch('<path>', …)`. The path is read from the source, never assumed. */
const FETCH_CALL_PATTERN = /fetch\(\s*'([^']+)'/;

/** The route handler's fixed wait: `const DELAY_MS = <n>;`. */
const DELAY_PATTERN = /\bDELAY_MS\s*=\s*(\d+)/;

/** The route handler's literal reply: `{ reply: '<text>' }`. */
const REPLY_PATTERN = /\breply:\s*'([^']+)'/;

// ---------------------------------------------------------------------------
// Budgets and tolerances — named once
// ---------------------------------------------------------------------------

/**
 * The fraction of the route's own delay a span on the request path must at least last.
 *
 * The handler awaits a `setTimeout` of `DELAY_MS` before answering, so the `route.handler`,
 * `http.server` and `fetch` spans that enclose it cannot be shorter than that delay (timers never
 * fire early by more than a millisecond). Half of it is comfortably below that floor on any host:
 * the assertion is about which spans enclose the delay — correlation — never about machine speed.
 */
const DELAY_LOWER_BOUND_FRACTION = 0.5;

/**
 * How far outside the capture window an event's `startTime` may sit. Browser events are stamped
 * `performance.timeOrigin + entry.startTime` and server spans from the Node clock; both run on
 * this machine, so the only slack needed is monotonic-versus-wall-clock drift of a long-lived page.
 */
const CAPTURE_CLOCK_SLACK_MS = 5_000;

/** How long the reply may take to render after the click: the delay plus a cold route compile. */
const REPLY_RENDER_TIMEOUT_MS = 30_000;

/**
 * How long the capture stays open, after the reply rendered, for the click's evidence to be
 * ingested: the preload's one-second batch window, the page agent's relay, and slack for a busy
 * host. The wait ends the moment the evidence is there.
 */
const EVIDENCE_INGEST_TIMEOUT_MS = 20_000;

/** How many offending policy tokens a failure lists before it summarises the rest. */
const MAX_REPORTED_TOKENS = 20;

/** How deep the artifact walk descends before it stops (a JSON artifact is a few levels deep). */
const MAX_ARTIFACT_DEPTH = 32;

/**
 * The server signals only the dev-server preload's tracer delivers and this fixture needs: the
 * incoming request (`http.server`) and the route handler (`route.handler`). Typed against the
 * protocol's signal vocabulary, so a renamed signal fails to compile here.
 */
const REQUIRED_SERVER_SIGNALS = [
  'http',
  'routeHandlers',
] as const satisfies readonly UnavailableSignalPayload['signal'][];

/**
 * The spans that must share the widget's `fetch` trace: the click that caused it and the two
 * server spans only the dev-server preload produces. Typed against the telemetry vocabulary.
 */
const CHAIN_KINDS = [
  'interaction',
  'http.server',
  'route.handler',
] as const satisfies readonly TelemetryKind[];

/** The committed forbidden-token list of AAP §0.5.4, repository-relative. */
const POLICY_SEGMENTS = ['scripts', 'no-hardcoding.policy.json'] as const;

/** A character that may continue an identifier: a policy identifier only matches as a whole word. */
const IDENTIFIER_BOUNDARY = 'A-Za-z0-9_$';

/** The characters a route's dynamic `[segment]` stands for when it appears concretely. */
const DYNAMIC_SEGMENT_SOURCE = `[^/\\s"'?#]+`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the fixture's own source says about the interaction, read once at run time. */
interface FixtureContract {
  /** The path the widget requests (`/api/ping`). */
  readonly requestPath: string;
  /** The route handler's fixed wait, in milliseconds. */
  readonly delayMs: number;
  /** The reply the widget renders once the response settled. */
  readonly reply: string;
}

/** The committed forbidden-token list, as far as this spec reads it. */
interface ForbiddenVocabulary {
  /** Demo identifiers (components, hooks, services, schemas…). */
  readonly identifiers: readonly string[];
  /** Demo route paths, `[param]` segments included. */
  readonly routePaths: readonly string[];
  /** The corpora whose names were subtracted when the list was generated. */
  readonly exclusions: readonly string[];
}

/** One compiled policy token. */
interface TokenMatcher {
  /** The token as the policy spells it. */
  readonly token: string;
  /** A literal every match contains, checked first so most strings skip the expression. */
  readonly needle: string;
  /** The whole-token expression. */
  readonly pattern: RegExp;
}

/** One policy token found in one field of one artifact. */
interface VocabularyMatch {
  /** The offending token. */
  readonly token: string;
  /** Where it was found, as a JSON path (`panel.layout[1].title`, `progress[4].message`). */
  readonly field: string;
}

/** One string of an artifact — a value or an object key — with its JSON path. */
interface ArtifactString {
  readonly field: string;
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Module state — written by the serial tests in order, read by their dependents
// ---------------------------------------------------------------------------

/** The launcher's record of the fixture's dev server (test 1). */
let launch: SampleAppLaunch | undefined;

/** The SHA-256 of every tracked fixture file before any session existed (test 1). */
let pristineSnapshot: TrackedFileSnapshot | undefined;

/** What the fixture's source says the interaction does (test 1). */
let contract: FixtureContract | undefined;

/** The module-scoped tracker the session is registered with (test 2; ended by test 6 or afterAll). */
let tracker: SessionTracker | undefined;

/** Everything the workflow observed (test 2). */
let outcome: DebugSessionOutcome | undefined;

/** The final session record (test 2). */
let session: SessionRecord | undefined;

/** Every event of the capture, walked page by page through `POST /sessions/:id/panel-data` (test 2). */
let capturedEvents: readonly TelemetryEvent[] | undefined;

/** The validated analysis `analysis.completed` carried (test 2). */
let analysis: AnalysisResult | undefined;

/** The generated panel specification `panel.generated` carried (test 2). */
let panelSpec: PanelSpec | undefined;

/**
 * The narrowing guard every dependent test starts with: a value an earlier serial test did not
 * produce fails with the reason rather than a `TypeError` deep inside an assertion.
 */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `${what} is unavailable: the serial test that produces it did not complete (see the first failure above).`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Whether `value` is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Escape `text` for literal use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A bounded, readable list for a failure message. */
function listed(values: readonly string[], limit: number = MAX_REPORTED_TOKENS): string {
  if (values.length === 0) {
    return '(none)';
  }
  const shown = values.slice(0, limit).join('; ');
  return values.length > limit ? `${shown}; (+${String(values.length - limit)} more)` : shown;
}

/** Whether `file` is a project-relative POSIX path: not absolute, no backslash, no `..` segment. */
function isProjectRelativePosix(file: string): boolean {
  return (
    file.trim() !== '' &&
    !path.posix.isAbsolute(file) &&
    !file.includes('\\') &&
    !/^[A-Za-z]:/.test(file) &&
    !file.split('/').includes('..')
  );
}

/** Whether a project-relative `file` names `suffix` itself or ends in `/<suffix>`. */
function namesFile(file: string, suffix: string): boolean {
  return file === suffix || file.endsWith(`/${suffix}`);
}

/**
 * What a project-relative path must name: a regular `file`, or — for a runtime-mode plan action,
 * which applies to the whole project and names its root (`.`) — any `entry` of the project.
 */
type FixturePathKind = 'file' | 'entry';

/**
 * Assert a project-relative path names something inside the fixture project. This is what makes
 * "the investigation found the fixture's own code" definitive: a path the product could only have
 * known from another project would not exist here.
 */
async function expectFixturePath(
  projectRoot: string,
  file: string,
  label: string,
  kind: FixturePathKind = 'file',
): Promise<void> {
  expect(isProjectRelativePosix(file), `${label}: "${file}" must be project-relative POSIX`).toBe(
    true,
  );
  const absolute = path.resolve(projectRoot, file);
  const inside =
    absolute.startsWith(`${projectRoot}${path.sep}`) ||
    (kind === 'entry' && absolute === projectRoot);
  expect(inside, `${label}: "${file}" must resolve inside ${SAMPLE_APP_REL_DIR}`).toBe(true);
  const info = await stat(absolute).catch(() => undefined);
  const present = kind === 'file' ? (info?.isFile() ?? false) : info !== undefined;
  expect(present, `${label}: "${file}" must exist in ${SAMPLE_APP_REL_DIR} (${kind})`).toBe(true);
}

/** The first capture group of `pattern` on the line of `file` it matches, read from the fixture. */
async function fixtureValue(
  sampleApp: SampleAppHandle,
  file: string,
  pattern: RegExp,
): Promise<string> {
  const match = await sampleApp.sourceLineContaining(file, pattern);
  const value = pattern.exec(match.text)?.[1];
  if (value === undefined) {
    throw new Error(
      `${SAMPLE_APP_REL_DIR}/${file}:${String(match.line)} matched ${String(pattern)} without its capture group.`,
    );
  }
  return value;
}

/**
 * Read the interaction's contract from the fixture's source (read-only): the path the widget
 * requests, the route's delay and its reply. Deriving them keeps this spec honest if the fixture's
 * wording changes, and keeps every expectation below a property of the fixture, not of the demo.
 */
async function readFixtureContract(sampleApp: SampleAppHandle): Promise<FixtureContract> {
  const requestPath = await fixtureValue(sampleApp, WIDGET_FILE, FETCH_CALL_PATTERN);
  const delayMs = Number.parseInt(await fixtureValue(sampleApp, ROUTE_FILE, DELAY_PATTERN), 10);
  const reply = await fixtureValue(sampleApp, ROUTE_FILE, REPLY_PATTERN);
  expect(
    requestPath.startsWith('/'),
    `the widget requests a same-origin path (${requestPath})`,
  ).toBe(true);
  expect(Number.isInteger(delayMs) && delayMs > 0, 'the route declares a positive delay').toBe(
    true,
  );
  return { requestPath, delayMs, reply };
}

/** The request path an attribute value names, resolved against the fixture's origin. */
function pathOfUrl(value: unknown, baseUrl: string): string | undefined {
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }
  try {
    return new URL(value, baseUrl).pathname;
  } catch {
    return undefined;
  }
}

/** Whether a browser `fetch` event requested `requestPath`. */
function isFetchOf(event: TelemetryEvent, requestPath: string, baseUrl: string): boolean {
  return (
    event.kind === 'fetch' &&
    event.tier === 'browser' &&
    pathOfUrl(event.attributes['url'], baseUrl) === requestPath
  );
}

/**
 * Whether a server span identifies `requestPath`: by its matched route (`http.route`,
 * `next.route`), its target (`url`) or its span name (`GET /api/ping`, Next.js's
 * `[http.method] [next.route]`). A route pattern names the route file's directory, so a value
 * that starts with the path counts (`/api/ping/route`).
 */
function identifiesRoute(event: TelemetryEvent, requestPath: string, baseUrl: string): boolean {
  const candidates = [
    pathOfUrl(event.attributes['http.route'], baseUrl),
    pathOfUrl(event.attributes['next.route'], baseUrl),
    pathOfUrl(event.attributes['url'], baseUrl),
  ];
  const matchesPath = (value: string | undefined): boolean =>
    value !== undefined && (value === requestPath || value.startsWith(`${requestPath}/`));
  return (
    candidates.some(matchesPath) ||
    new RegExp(`(?:^|\\s)${escapeRegExp(requestPath)}(?:/|\\s|$)`).test(event.name)
  );
}

// ---------------------------------------------------------------------------
// The forbidden vocabulary — read from the committed policy, never restated
// ---------------------------------------------------------------------------

/** `value` as a list of non-empty strings, or a failure naming the policy field. */
function policyStrings(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  ) {
    throw new Error(
      `${POLICY_SEGMENTS.join('/')}: "${field}" must be an array of non-empty strings (regenerate it with \`pnpm check:no-hardcoding --update\`).`,
    );
  }
  return value;
}

/**
 * Load `scripts/no-hardcoding.policy.json` — the list `scripts/check-no-hardcoding.mjs --update`
 * derives from the demo's code index minus every name that also occurs in this fixture — so the
 * negative assertion tracks the demo as it evolves instead of a hand-written list.
 */
async function loadForbiddenVocabulary(): Promise<ForbiddenVocabulary> {
  const file = repoPath(...POLICY_SEGMENTS);
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${POLICY_SEGMENTS.join('/')} must hold a JSON object.`);
  }
  return {
    identifiers: policyStrings(parsed['identifiers'], 'identifiers'),
    routePaths: policyStrings(parsed['routePaths'], 'routePaths'),
    exclusions: policyStrings(parsed['exclusions'], 'exclusions'),
  };
}

/** A whole-word matcher for one demo identifier. */
function identifierMatcher(token: string): TokenMatcher {
  return {
    token,
    needle: token,
    pattern: new RegExp(
      `(?<![${IDENTIFIER_BOUNDARY}])${escapeRegExp(token)}(?![${IDENTIFIER_BOUNDARY}])`,
    ),
  };
}

/**
 * A matcher for one demo route: literal segments match literally and a `[param]` segment matches
 * any concrete value (`/api/products/[slug]` also catches `/api/products/any-product`). The route
 * must end at a segment boundary, so `/api/orders` does not claim an unrelated `/api/ordersX`.
 */
function routeMatcher(route: string): TokenMatcher {
  const segments = route.split('/');
  const firstDynamic = segments.findIndex((segment) => /^\[.+\]$/.test(segment));
  const literalPrefix =
    firstDynamic === -1 ? route : `${segments.slice(0, firstDynamic).join('/')}/`;
  const source = segments
    .map((segment) => (/^\[.+\]$/.test(segment) ? DYNAMIC_SEGMENT_SOURCE : escapeRegExp(segment)))
    .join('/');
  return {
    token: route,
    needle: literalPrefix,
    pattern: new RegExp(`${source}(?![A-Za-z0-9_-])`),
  };
}

/** Every matcher of the vocabulary: identifiers first, then routes. */
function compileVocabulary(vocabulary: ForbiddenVocabulary): readonly TokenMatcher[] {
  return [
    ...vocabulary.identifiers.map(identifierMatcher),
    ...vocabulary.routePaths.map(routeMatcher),
  ];
}

/**
 * Every string of a JSON artifact — values and object keys — with its JSON path. Numbers, booleans
 * and `null` carry no vocabulary and are skipped; the walk is depth-bounded.
 */
function artifactStrings(value: unknown, field: string, depth = 0): ArtifactString[] {
  if (typeof value === 'string') {
    return [{ field, text: value }];
  }
  if (depth >= MAX_ARTIFACT_DEPTH || typeof value !== 'object' || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry: unknown, position) =>
      artifactStrings(entry, `${field}[${String(position)}]`, depth + 1),
    );
  }
  return Object.entries(value).flatMap(([key, entry]) => [
    { field: `${field}{key "${key}"}`, text: key },
    ...artifactStrings(entry, `${field}.${key}`, depth + 1),
  ]);
}

/** Every policy token found in `artifacts`, with the field that carried it. */
function scanForVocabulary(
  artifacts: Readonly<Record<string, unknown>>,
  matchers: readonly TokenMatcher[],
): VocabularyMatch[] {
  const matches: VocabularyMatch[] = [];
  for (const [label, value] of Object.entries(artifacts)) {
    for (const { field, text } of artifactStrings(value, label)) {
      for (const matcher of matchers) {
        if (text.includes(matcher.needle) && matcher.pattern.test(text)) {
          matches.push({ token: matcher.token, field });
        }
      }
    }
  }
  return matches;
}

/**
 * The artifacts the product produced for the session, by name — the understanding, the relevant
 * files, every plan version (objective, hypotheses, targets), the installer's report, the analysis
 * (facts and hypotheses), the panel (title, summary, nodes), the progress rows and the selected
 * target. The raw telemetry is deliberately absent: it is the fixture's and the framework's own
 * runtime output, observed rather than produced.
 */
function sessionArtifacts(
  record: SessionRecord,
  observed: DebugSessionOutcome,
  generatedPanel: PanelSpec,
  result: AnalysisResult,
): Record<string, unknown> {
  return {
    understanding: record.understanding,
    relevantFiles: record.relevantFiles,
    plans: record.plans,
    instrumentation: observed.instrumentation,
    analysis: result,
    panel: generatedPanel,
    progress: observed.stages.map(({ stage, status, message, detail }) => ({
      stage,
      status,
      message,
      detail,
    })),
    target: observed.target,
  };
}

// ---------------------------------------------------------------------------
// The workflow's reproduction step
// ---------------------------------------------------------------------------

/**
 * The session that owns `captureId`, as the service records it.
 *
 * The session list carries rows, not records, so each listed session is read
 * whole until one records the capture — capturing sessions first, since the
 * owner of an open window is the one in `capturing`.
 */
async function sessionOwningCapture(service: ServiceHandle, captureId: string): Promise<string> {
  const rows = await service.listSessions();
  const ordered = [
    ...rows.filter((row) => row.status === 'capturing'),
    ...rows.filter((row) => row.status !== 'capturing'),
  ];
  for (const row of ordered) {
    const record = await service.getSession(row.id);
    if (record.captures.some((capture) => capture.id === captureId)) {
      return record.id;
    }
  }
  throw new Error(
    `No listed session records capture ${captureId}: the service's session list and the capture it answered disagree.`,
  );
}

/**
 * How far the open capture has got with the click's evidence: `'complete'` once it holds the
 * widget's browser `fetch` and, in that fetch's trace, the `interaction`, `http.server` and
 * `route.handler` spans; otherwise what is still missing, in words.
 */
function correlatedRequestProgress(
  events: readonly TelemetryEvent[],
  expected: FixtureContract,
  baseUrl: string,
): string {
  const request = events.find((event) => isFetchOf(event, expected.requestPath, baseUrl));
  if (request === undefined) {
    return `no browser fetch of ${expected.requestPath} ingested yet`;
  }
  const inTrace = events.filter((event) => event.traceId === request.traceId);
  const missing = CHAIN_KINDS.filter((kind) => !inTrace.some((event) => event.kind === kind));
  return missing.length === 0
    ? 'complete'
    : `trace ${request.traceId} has no ${missing.join(', ')} span yet`;
}

/**
 * Press "Run check" once inside the open capture, then keep the capture open until the evidence
 * of that click has been recorded:
 *
 * 1. the page's own signal that the delayed response settled — the reply rendered in the
 *    `role="status"` region and the button came back;
 * 2. the click's correlated chain in the capture, read through `POST /sessions/:id/panel-data`:
 *    the dev-server preload exports its spans in batches (`BATCH_FLUSH_INTERVAL_MS` of
 *    `@debuggen/telemetry`'s Node config, one second), and ingest attributes nothing to a window
 *    that has closed, so stopping the moment the reply renders would race the server tier. A
 *    developer reproducing an issue does the same: the capture stays open until the work is done.
 *
 * One click is exactly one request in this fixture, so the capture holds one interaction. The wait
 * is an `expect.poll` over the service's own data, never a pause.
 */
function pressRunCheck(
  service: ServiceHandle,
  expected: FixtureContract,
  baseUrl: string,
): SessionInteraction {
  return async ({ appPage, captureId }) => {
    const button = appPage.getByTestId(PING_BUTTON_TEST_ID);
    const result = appPage.getByTestId(PING_RESULT_TEST_ID);
    await expect(button, 'the fixture widget is interactive before the click').toBeEnabled();
    await button.click();
    await expect(result, 'the reply rendered after the delayed response').toHaveText(
      expected.reply,
      { timeout: REPLY_RENDER_TIMEOUT_MS },
    );
    await expect(button, 'the widget re-enabled its button after the reply').toBeEnabled();

    const sessionId = await sessionOwningCapture(service, captureId);
    await expect
      .poll(
        async () => {
          const recorded = await service.queryAllPanelData(sessionId, {
            source: 'events',
            filter: { kinds: [...CHAIN_KINDS, 'fetch'] },
          });
          return correlatedRequestProgress(recorded.items, expected, baseUrl);
        },
        {
          message: `capture ${captureId} never recorded the click's browser-to-server chain; a dev server without a server-agent connection for ${SAMPLE_APP_REL_DIR} produces exactly this (relaunch it through POST /dev-server/launch)`,
          timeout: EVIDENCE_INGEST_TIMEOUT_MS,
          intervals: [...E2E_TIMEOUTS.pollIntervals],
        },
      )
      .toBe('complete');
  };
}

/**
 * Run the workflow, surfacing the product's own relaunch hint when the dev server behind the page
 * turned out to have no server agent (AAP §0.5.5): that is the actionable diagnosis, where a
 * later "no server spans" failure would name only the symptom.
 */
async function runWorkflow(
  run: () => Promise<DebugSessionOutcome>,
  sampleApp: SampleAppHandle,
): Promise<DebugSessionOutcome> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SessionWorkflowError && error.code === 'relaunch-required') {
      throw new Error(
        [
          `The fixture's dev server at ${sampleApp.baseUrl} has no server-agent connection for ${SAMPLE_APP_REL_DIR}, so no http.server or route.handler span can be captured.`,
          `The product's relaunch hint: ${error.hint ?? '(none given)'}`,
          `Launch record: ${sampleApp.launch?.preloadReason ?? 'no launch recorded'}; ${sampleApp.launch?.diagnosis ?? 'no diagnosis'}.`,
          error.message,
        ].join('\n'),
        { cause: error },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

test.describe('generalization: the slow-interaction workflow on an app the product has never seen', () => {
  test.afterAll(async ({ service }) => {
    const problems: string[] = [];

    // End whatever the module tracker still holds — normally nothing, because test 6 ended it —
    // under a live editor announcement: the `vscode` role may only end sessions for a project
    // under a folder a live connection announced.
    const current = tracker;
    if (current !== undefined && current.registered.some((id) => !current.ended.includes(id))) {
      try {
        const editor = await service.connectEditor();
        try {
          const report = await current.endAll();
          if (!report.clean) {
            problems.push(report.text);
          }
        } finally {
          editor.close();
        }
      } catch (error) {
        problems.push(`ending the tracked session failed: ${String(error)}`);
      }
    }

    // Stop the fixture's dev server through POST /dev-server/stop and leave its port free for the
    // next run; the worker fixture's own teardown then finds nothing to stop.
    try {
      const stopped = await stopSampleApp(service);
      if (!stopped.portReleased) {
        problems.push(
          `the fixture's port is still answering after POST /dev-server/stop (stopped: ${String(stopped.stopped)})`,
        );
      }
    } catch (error) {
      problems.push(`stopping the fixture app failed: ${String(error)}`);
    }

    expect(problems, 'generalization teardown').toEqual([]);
  });

  test('launches the fixture through POST /dev-server/launch with the telemetry preload attached', async ({
    sampleApp,
  }) => {
    // The worker fixture already freed the port and launched; a repeated run in the same worker
    // (after this file's afterAll stopped the app) launches again through the same path.
    const current = sampleApp.launch ?? (await sampleApp.start());

    await test.step('the launcher answered for this project, on a port it found free', () => {
      expect(current.projectRoot).toBe(sampleApp.projectRoot);
      expect(current.portCheck, 'ensurePortFree ran before the launch').toBeDefined();
      expect(['free', 'stopped-ours']).toContain(current.portCheck?.state);
      expect(current.listeningBeforeLaunch, 'nothing listened on the port at launch time').toBe(
        false,
      );
      expect(current.raw.devServerUrl, 'the launch response carries devServerUrl').toBe(
        current.devServerUrl,
      );
      expect(() => new URL(current.raw.devServerUrl)).not.toThrow();
      expect(
        Number.isInteger(current.raw.pid) && current.raw.pid > 0,
        `the launch response carries a pid (${String(current.raw.pid)})`,
      ).toBe(true);
    });

    await test.step('the server behind the page the suite opens is the preloaded child', () => {
      // Throws the helper's diagnosis (`no-server-agent-connection` and the fix) when not.
      sampleApp.expectPreloadAttached();
      expect(current.preloadAttached).toBe(true);
      expect(current.preloadReason).toBe('launcher-child');
      expect(current.originMatches, `${current.origin} is the origin the suite opens`).toBe(true);
      expect(current.diagnosis).toBeUndefined();
    });

    await test.step('the dev server URL answers 200, as this fixture', async () => {
      const page = await fetch(current.devServerUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(SAMPLE_APP_READY_PROBE_TIMEOUT_MS),
      });
      await page.body?.cancel();
      expect(page.status, `GET ${current.devServerUrl}`).toBe(200);
    });

    await test.step('the fixture is pristine before any session exists', async () => {
      pristineSnapshot = await sampleApp.snapshotTrackedFiles();
      expect(pristineSnapshot.size, `git tracks files under ${SAMPLE_APP_REL_DIR}`).toBeGreaterThan(
        0,
      );
      expect(await sampleApp.findMarkers(), 'no instrumentation marker before the session').toEqual(
        [],
      );
      expect(await sampleApp.worktreeDirty(), 'a clean worktree before the session').toBe(false);
    });

    contract = await readFixtureContract(sampleApp);
    launch = current;
  });

  test('answers "Why is this button slow?" from the fixture\'s own code and reaches generated', async ({
    service,
    editorClient,
    extensionContext,
    samplePage,
    openPanelPage,
    pairing,
    sampleApp,
  }) => {
    test.setTimeout(E2E_TIMEOUTS.longTestTimeoutMs);
    const current = required(launch, 'the fixture launch');
    const expected = required(contract, 'the fixture contract');

    // The DevTools surface of the fixture tab: the real DevTools page announces the tab (so the
    // service worker sends `session.bind`), and the sticky pairing is reused or established.
    const tabId = await tabIdForPage(extensionContext, samplePage);
    const panel: PanelHandle = await openPanelPage({
      tabId,
      inspectedPage: samplePage,
      inspectedUrl: samplePage.url(),
    });
    await pairing.ensurePaired(panel);

    // Registered the moment it exists; ended by test 6, or by afterAll when anything fails first.
    tracker ??= createSessionTracker(service);
    const sessionTracker = tracker;

    const observed = await runWorkflow(
      () =>
        runDebugSession({
          service,
          editorClient,
          projectRoot: sampleApp.projectRoot,
          question: QUESTION,
          panel,
          appPage: samplePage,
          target: { selector: PING_BUTTON_SELECTOR },
          interact: pressRunCheck(service, expected, sampleApp.baseUrl),
          tracker: sessionTracker,
        }),
      sampleApp,
    );
    outcome = observed;
    const record = observed.session;
    session = record;

    await test.step('the session reached generated through the real pipeline', () => {
      expect(record.status).toBe('generated');
      expect(observed.statuses.at(-1)).toBe('generated');
      expect(observed.statuses, 'the session never failed').not.toContain('failed');
      for (const status of ['ready', 'capturing', 'analyzing'] as const) {
        expect(observed.statuses, `the session passed through ${status}`).toContain(status);
      }
      expect(record.projectRoot).toBe(sampleApp.projectRoot);
      expect(
        new URL(record.devServerUrl).origin,
        "the session debugs the launcher's preloaded child",
      ).toBe(current.origin);
      const failures = observed.errors.filter((entry) => entry.source === 'instrumentation.failed');
      expect(failures.map((entry) => `${entry.code}: ${entry.message}`)).toEqual([]);
    });

    await test.step('the ping button was selected through the product', () => {
      const target = required(observed.target, 'the selected target');
      expect(target.tagName.toLowerCase()).toBe('button');
      expect(
        target.componentChain,
        "the owner chain resolved from the fixture's React tree",
      ).toContain(WIDGET_COMPONENT);
      expect(new URL(target.url).origin).toBe(sampleApp.baseUrl);
      expect(record.target?.selector, 'the session recorded the selected target').toBe(
        target.selector,
      );
    });

    await test.step("the investigation found the fixture's own widget and route handler", async () => {
      const files = record.relevantFiles.map((entry) => entry.file);
      for (const suffix of [WIDGET_FILE, ROUTE_FILE]) {
        expect(
          files.some((file) => namesFile(file, suffix)),
          `relevantFiles names ${suffix}; got ${listed(files)}`,
        ).toBe(true);
      }
      for (const file of files) {
        await expectFixturePath(sampleApp.projectRoot, file, 'relevantFiles');
      }
    });

    await test.step('a plan was validated and applied, degrading gracefully where it must', async () => {
      const plan = required(observed.plan, 'the instrumentation.plan');
      expect(plan.sessionId).toBe(observed.sessionId);
      expect(plan.objective.trim()).not.toBe('');
      expect(plan.capture.length, 'the plan names what it captures').toBeGreaterThan(0);
      expect(plan.instrumentationTargets.length, 'the plan names targets').toBeGreaterThan(0);
      for (const action of plan.instrumentationTargets) {
        // A patch names the file it rewrites; a runtime hook applies to the whole project.
        await expectFixturePath(
          sampleApp.projectRoot,
          action.file,
          `plan target ${action.id} (${action.type}, ${action.mode})`,
          action.mode === 'patch' ? 'file' : 'entry',
        );
      }

      const ready = required(observed.instrumentation, 'the instrumentation.ready payload');
      expect(ready.runtimeHooks.length, 'runtime hooks came up').toBeGreaterThan(0);
      for (const gap of ready.unavailable) {
        expect(gap.reason.trim(), `unavailable ${gap.signal} states a reason`).not.toBe('');
        expect(gap.hint.trim(), `unavailable ${gap.signal} states a hint`).not.toBe('');
      }
      const missingServer = ready.unavailable.filter((gap) =>
        (REQUIRED_SERVER_SIGNALS as readonly string[]).includes(gap.signal),
      );
      expect(
        missingServer.map((gap) => `${gap.signal}: ${gap.hint}`),
        'the server agent delivered the request and route-handler signals',
      ).toEqual([]);

      const patchFiles = new Set(
        plan.instrumentationTargets
          .filter((action) => action.mode === 'patch')
          .map((action) => action.file),
      );
      if (patchFiles.size > 0) {
        expect(
          observed.modifications.length,
          'the plan patches files, so the installer journalled modifications',
        ).toBeGreaterThan(0);
      }
      for (const modification of observed.modifications) {
        expect(modification.status, `${modification.file} was patched by the installer`).toBe(
          'applied',
        );
        expect(patchFiles, `${modification.file} is a patch target of the plan`).toContain(
          modification.file,
        );
        await expectFixturePath(sampleApp.projectRoot, modification.file, 'modification');
      }
    });

    await test.step("the installer's patches are live in the fixture while the session runs", async () => {
      // What makes test 6's restoration meaningful: the tracked files really changed, through the
      // product's installer, and the residual gate really sees its markers.
      const pristine = required(pristineSnapshot, 'the pristine fixture snapshot');
      const live = await sampleApp.snapshotTrackedFiles();
      const markedFiles = new Set((await sampleApp.findMarkers()).map((finding) => finding.file));
      for (const modification of observed.modifications) {
        const tracked = `${SAMPLE_APP_REL_DIR}/${modification.file}`;
        expect(pristine.get(tracked), `${tracked} matched its originalHash before`).toBe(
          modification.originalHash,
        );
        expect(live.get(tracked), `${tracked} holds the installer's patch now`).toBe(
          modification.instrumentedHash,
        );
        expect(markedFiles, `the residual gate sees the patch in ${tracked}`).toContain(tracked);
      }
    });

    const generated = required(observed.panel, 'the panel.generated specification');
    panelSpec = generated;
    analysis = required(observed.analysis, 'the analysis.completed result');

    await test.step('the stored panel is the one panel.generated carried', async () => {
      const stored = await service.getCurrentPanel(observed.sessionId);
      expect(stored?.id, 'GET /sessions/:id/panel answers the generated panel').toBe(generated.id);
      expect(observed.panelId).toBe(generated.id);
    });

    await test.step('the capture is fetched page by page through the data API', async () => {
      const collected = await service.queryAllPanelData(observed.sessionId, { source: 'events' });
      expect(collected.items.length, 'the capture holds events').toBeGreaterThan(0);
      expect(collected.items.length).toBe(collected.total);
      capturedEvents = collected.items;
    });

    await test.step('the generated panel renders in the panel document', async () => {
      const locators = panel.locators;
      await expect(locators.panelView.first(), 'PanelHost rendered the panel').toBeVisible();
      await expect(locators.panelTitle.first()).toContainText(generated.title);
      await expect(locators.fallbackBanner, 'no fallback banner').toHaveCount(0);
      await expect(locators.nodeErrors, 'no node the renderer could not render').toHaveCount(0);
      await expectNoPanelErrorState(panel.page);

      // Every node type of the specification appears as a classified component; a blank node
      // (no component landmark) makes `renderedNodeTypes` throw with its layout path.
      const rendered = await locators.renderedNodeTypes();
      const notRendered = [...nodeTypesOf(generated)].filter((type) => !rendered.has(type));
      expect(notRendered, 'specification node types missing from the DOM').toEqual([]);

      await expect(locators.observedFacts).toHaveCount(generated.summary.observed.length);
      if (generated.summary.likelyCauses.length > 0) {
        await expect(locators.likelyCauses).toHaveCount(generated.summary.likelyCauses.length);
      }
    });
  });

  test('correlates the click into one browser-to-server trace without a database tier', async ({
    service,
    editorClient,
  }) => {
    const record = required(session, 'the session record');
    const observed = required(outcome, 'the workflow outcome');
    const events = required(capturedEvents, 'the captured events');
    const expected = required(contract, 'the fixture contract');
    const baseUrl = required(launch, 'the fixture launch').baseUrl;
    const captureId = required(observed.captureId, 'the capture id');
    // Session routes are scope-checked for the editor role: the announcement must cover the fixture.
    expect(
      record.projectRoot.startsWith(`${editorClient.projectRoot}${path.sep}`),
      'the live editor announcement covers the fixture project',
    ).toBe(true);

    expectNoSpanIdCollisions(events, { message: 'the fixture capture' });

    const request = expectEventOfKind(events, 'fetch', {
      predicate: (event) => isFetchOf(event, expected.requestPath, baseUrl),
      message: `the widget's browser fetch of ${expected.requestPath}`,
    });
    const { traceId } = request;
    expectHexId(traceId, 32, 'the fetch traceId');

    const routeHandler = expectEventOfKind(events, 'route.handler', {
      predicate: (event) => event.traceId === traceId,
      message: `a route.handler span in trace ${traceId}`,
    });

    // The ordered ancestor chain through the shared matcher: route.handler → http.server → fetch →
    // interaction, nearest first; intermediate spans (framework work, `function` spans of patched
    // symbols) are allowed between the steps.
    const chainMessage = `the click on ${PING_BUTTON_SELECTOR} resolved to one correlated tree`;
    const [server, chainedRequest, click] = expectAncestorKinds(
      events,
      routeHandler,
      ['http.server', 'fetch', 'interaction'],
      { message: chainMessage },
    );
    const httpServer = required(server, 'the http.server ancestor');
    const fetchSpan = required(chainedRequest, 'the fetch ancestor');
    const interaction = required(click, 'the interaction ancestor');
    const chain = [interaction, fetchSpan, httpServer, routeHandler];

    await test.step('the chain crosses tiers inside one trace of this capture', () => {
      expect(fetchSpan.spanId, "the chain's fetch is the widget's request").toBe(request.spanId);
      expect(interaction.tier).toBe('browser');
      expect(fetchSpan.tier).toBe('browser');
      expect(httpServer.tier).toBe('server');
      expect(routeHandler.tier).toBe('server');
      expect(
        identifiesRoute(httpServer, expected.requestPath, baseUrl),
        `${describeEvent(httpServer)} identifies ${expected.requestPath}`,
      ).toBe(true);
      for (const span of chain) {
        expect(span.traceId, `${describeEvent(span)} shares the trace`).toBe(traceId);
        expectHexId(span.spanId, 16, `${span.kind} spanId`);
        expect(span.sessionId, `${describeEvent(span)} is attributed to the session`).toBe(
          record.id,
        );
        expect(span.captureId, `${describeEvent(span)} is attributed to the capture`).toBe(
          captureId,
        );
      }
    });

    await test.step("the service's correlated tree agrees with the flat capture", async () => {
      const result = await service.queryPanelData(record.id, {
        source: 'trace',
        filter: { traceId },
      });
      const tree = required(result.trace ?? undefined, `the correlated tree of trace ${traceId}`);
      const treeEvents = flattenTrace(tree);
      expect(expectSingleTrace(treeEvents, { message: 'the trace data source' })).toBe(traceId);
      const treeSpanIds = new Set(treeEvents.map((event) => event.spanId));
      const absent = chain.filter((span) => !treeSpanIds.has(span.spanId)).map(describeEvent);
      expect(absent, 'chain spans missing from the correlated tree').toEqual([]);
      const treeRouteHandler = required(
        treeEvents.find((event) => event.spanId === routeHandler.spanId),
        'the route.handler node of the correlated tree',
      );
      expectAncestorKinds(treeEvents, treeRouteHandler, ['http.server', 'fetch', 'interaction'], {
        message: `${chainMessage} (trace data source)`,
      });
    });

    await test.step('no database tier exists, and its absence degrades nothing', () => {
      expect(
        eventsOfKind(events, 'db.query').map(describeEvent),
        'the fixture has no data source, so no db.query span is expected',
      ).toEqual([]);
      expect(
        events.filter((event) => event.tier === 'db').map(describeEvent),
        'no event on the db tier',
      ).toEqual([]);
      expect(record.status, 'the session still reached generated').toBe('generated');
      expect(required(panelSpec, 'the generated panel').meta?.fallback ?? false).toBe(false);
    });

    await test.step("durations enclose the route's own delay; start times are epoch milliseconds", () => {
      // See DELAY_LOWER_BOUND_FRACTION: a floor well below the handler's awaited delay.
      const floor = expected.delayMs * DELAY_LOWER_BOUND_FRACTION;
      for (const span of [routeHandler, httpServer, fetchSpan]) {
        expect(
          span.duration,
          `${describeEvent(span)} encloses the route's ${String(expected.delayMs)} ms wait`,
        ).toBeGreaterThanOrEqual(floor);
      }
      const capture = required(
        record.captures.find((entry) => entry.id === captureId),
        `the capture record ${captureId}`,
      );
      const windowStart = capture.startedAt - CAPTURE_CLOCK_SLACK_MS;
      const windowEnd = (capture.stoppedAt ?? Date.now()) + CAPTURE_CLOCK_SLACK_MS;
      for (const span of chain) {
        expect(span.startTime, `${describeEvent(span)} startTime`).toBeGreaterThanOrEqual(
          MIN_EPOCH_MS,
        );
        expect(span.startTime, `${describeEvent(span)} startTime`).toBeLessThanOrEqual(
          MAX_EPOCH_MS,
        );
        expect(
          span.startTime,
          `${describeEvent(span)} starts inside the capture window`,
        ).toBeGreaterThanOrEqual(windowStart);
        expect(
          span.startTime,
          `${describeEvent(span)} starts inside the capture window`,
        ).toBeLessThanOrEqual(windowEnd);
      }
    });
  });

  test('generates a validated, catalogued panel whose findings cite this capture', () => {
    const record = required(session, 'the session record');
    const events = required(capturedEvents, 'the captured events');
    const result = required(analysis, 'the analysis');
    const spec = expectValidPanelSpec(required(panelSpec, 'the generated panel'), {
      message: 'the generalization panel',
    });

    expect(spec.meta?.fallback ?? false, 'a generated panel, not the fallback').toBe(false);
    expect(spec.sessionId).toBe(record.id);

    const types = expectNodeTypes(spec, ['timeline'], { message: 'the slow-interaction panel' });
    expectAnyNodeType(spec, ['flame', 'waterfall'], { message: 'the slow-interaction panel' });
    const uncatalogued = [...types].filter(
      (type: PanelNodeType) => !Object.hasOwn(PANEL_NODE_CATALOG, type),
    );
    expect(uncatalogued, 'node types outside PANEL_NODE_CATALOG').toEqual([]);

    expect(result.sessionId).toBe(record.id);
    expect(result.captureId).toBe(
      required(required(outcome, 'the workflow outcome').captureId, 'the capture id'),
    );
    expectFactsAndHypothesesSeparate(result, { message: 'the generalization analysis' });
    expectEvidenceResolves(result, events, { message: 'the analysis' });
    expectEvidenceResolves(spec, events, { message: 'the panel summary' });
    for (const [position, cause] of result.likelyCauses.entries()) {
      expect(
        cause.confidence,
        `likelyCauses[${String(position)}] carries a confidence`,
      ).toBeTruthy();
    }

    // A panel fact is copied from the validated analysis, never authored alongside it.
    const analysed = new Set(result.observed.map((fact) => fact.statement));
    const unsourced = spec.summary.observed
      .map((fact, position) => ({ position, statement: fact.statement }))
      .filter((fact) => !analysed.has(fact.statement))
      .map((fact) => `summary.observed[${String(fact.position)}]`);
    expect(unsourced, 'panel facts absent from the analysis').toEqual([]);
  });

  test('carries no demo identifier or route in anything the session produced', async () => {
    const record = required(session, 'the session record');
    const observed = required(outcome, 'the workflow outcome');
    const expected = required(contract, 'the fixture contract');
    const vocabulary = await loadForbiddenVocabulary();
    const matchers = compileVocabulary(vocabulary);

    await test.step('the policy is the demo corpus minus this fixture', () => {
      expect(vocabulary.identifiers.length, 'the policy lists demo identifiers').toBeGreaterThan(0);
      expect(vocabulary.routePaths.length, 'the policy lists demo routes').toBeGreaterThan(0);
      expect(vocabulary.exclusions, 'the policy subtracts names this fixture uses').toContain(
        SAMPLE_APP_REL_DIR,
      );
      expect(vocabulary.identifiers, "the fixture's widget is not demo vocabulary").not.toContain(
        WIDGET_COMPONENT,
      );
      expect(vocabulary.routePaths, "the fixture's route is not demo vocabulary").not.toContain(
        expected.requestPath,
      );
    });

    await test.step('the scanner flags a demo identifier and a concrete demo route', () => {
      // A non-vacuous negative assertion: the matcher set must catch what it is meant to catch.
      const identifier = required(vocabulary.identifiers[0], 'a policy identifier');
      // Prefer a route with a `[param]` segment, so the concrete-value form is exercised too.
      const route = required(
        vocabulary.routePaths.find((candidate) => /\[[^\]]+\]/.test(candidate)) ??
          vocabulary.routePaths[0],
        'a policy route',
      );
      const concreteRoute = route.replace(/\[[^\]]+\]/g, 'probe-value');
      const probe = scanForVocabulary(
        { probe: { statement: `rendered by ${identifier}`, url: `GET ${concreteRoute}?q=1` } },
        matchers,
      );
      expect(probe.map((match) => match.token)).toEqual(
        expect.arrayContaining([identifier, route]),
      );
      expect(
        scanForVocabulary({ probe: `${identifier}Suffix ${WIDGET_COMPONENT}` }, matchers),
        'a policy identifier matches only as a whole word',
      ).toEqual([]);
    });

    await test.step("no artifact of this session names the demo's code", () => {
      const artifacts = sessionArtifacts(
        record,
        observed,
        required(panelSpec, 'the generated panel'),
        required(analysis, 'the analysis'),
      );
      const found = scanForVocabulary(artifacts, matchers);
      expect(
        found,
        `demo vocabulary in the session's artifacts (token @ field): ${listed(
          found.map((match) => `${match.token} @ ${match.field}`),
        )}`,
      ).toEqual([]);
    });
  });

  test('ends the session through the product and restores the fixture byte for byte', async ({
    service,
    editorClient,
    sampleApp,
  }) => {
    const record = required(session, 'the session record');
    const observed = required(outcome, 'the workflow outcome');
    const snapshot = required(pristineSnapshot, 'the pristine fixture snapshot');
    const sessionTracker = required(tracker, 'the session tracker');

    await test.step('POST /sessions/:id/end cleans up, and cleanup.completed says so', async () => {
      const mark = editorClient.snapshotIndex();
      const entry = await sessionTracker.end(record.id);
      expect(entry.error, 'the end request succeeded').toBeUndefined();
      expect(entry.outcome).toBe('ended');
      expect(entry.cleanup).toBe('clean');
      expect(entry.conflicts).toBe(0);

      const completed = await editorClient.waitFor(
        'cleanup.completed',
        (payload) => payload.sessionId === record.id,
        { sinceIndex: mark, timeoutMs: DEFAULT_SESSION_TIMEOUTS.end },
      );
      expect(completed.payload.status).toBe('clean');
      expect(completed.payload.conflicts).toEqual([]);

      const ended = await service.getSession(record.id);
      expect(ended.status).toBe('ended');
      expect(ended.cleanup.status).toBe('clean');
      expect(ended.cleanup.conflicts).toEqual([]);
    });

    await test.step('every modification the installer applied was reverted', async () => {
      const journal = await service.getModifications(record.id);
      const unreverted = journal
        .filter((modification) => modification.status !== 'reverted')
        .map((modification) => `${modification.file}: ${modification.status}`);
      expect(unreverted, 'modification records not reverted').toEqual([]);
      const journalIds = new Set(journal.map((modification) => modification.id));
      const missing = observed.modifications
        .filter((modification) => !journalIds.has(modification.id))
        .map((modification) => modification.file);
      expect(missing, 'applied modifications absent from the journal').toEqual([]);
    });

    await test.step('the fixture tree is pristine again', async () => {
      const report = await sampleApp.verifyRestored(snapshot, { message: record.id });
      expect(report.compared).toBe(snapshot.size);
      expect(await sampleApp.findMarkers(), 'no instrumentation marker remains').toEqual([]);
      expect(
        await sampleApp.worktreeDirty(),
        `git status --porcelain -- ${SAMPLE_APP_REL_DIR}`,
      ).toBe(false);
      // The repository gate itself, in its `--path tests/fixtures/sample-next-app` mode.
      const residual = await sampleApp.runResidualCheck();
      expect(residual.findings, 'residual-marker findings').toEqual([]);
      expect(residual.worktreeEntries, 'residual-worktree findings').toEqual([]);
      expect(
        residual.exitCode,
        `check-no-residual-instrumentation ${residual.argv.join(' ')}`,
      ).toBe(0);
      expect(residual.passed).toBe(true);
    });

    await test.step('the fixture keeps serving with the inert preload still attached', async () => {
      const probe = await sampleApp.expectServing();
      expect(probe.status).toBe(200);
    });
  });
});
