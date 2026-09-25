/**
 * Acceptance test 3 — **Cleanup** (AAP §0.8.4): the product's reversibility
 * guarantee (AAP §0.5.1) in executable form.
 *
 * A real session instruments the demo for the slow-interaction question, a real
 * capture runs, and the session is ended through the product's own path. The
 * spec then proves, with evidence rather than status flags, that:
 *
 * 1. something was really installed — at least one `applied` patch-mode
 *    modification whose bytes were on disk while the session ran, so the
 *    restoration assertions below cannot pass vacuously;
 * 2. every tracked file under `apps/demo-app` is byte-identical to the
 *    pre-session snapshot, no `__DEBUGGEN__` / `__DebuggenSpanHelper` marker
 *    remains, `git status --porcelain -- apps/demo-app` is empty, and the
 *    backups of restored files are gone;
 * 3. the session reports `cleanup.status = clean` on the wire
 *    (`cleanup.completed`), in the HTTP answer and in the persisted record, and
 *    every journal entry is `reverted`;
 * 4. the **same** dev-server process keeps serving pages and API routes with
 *    the now-inert preload still loaded, and an interaction after cleanup adds
 *    no telemetry and produces no new panel — the hooks are disabled, not idled
 *    (`docs/SECURITY.md`, "what remains after cleanup").
 *
 * ## One test, several steps
 *
 * The phases share one session, and the fixtures that hold its context — the
 * paired DevTools panel, the application tab, the recording editor connection
 * and the session tracker — are test-scoped (`./helpers/fixtures.ts`).
 * Splitting the phases into separate tests would close the tab and the editor
 * socket between them, and the first test's teardown would end the session:
 * the very cleanup this spec must drive and observe itself. The phases are
 * therefore `test.step`s of one test in a serial group, passing their results
 * through the module-scoped state below. The tracker is handed to the workflow
 * driver only as a safety net: should an early step fail, teardown ends the
 * session so no patch leaks into the next spec. Nothing here repairs the tree
 * after a failure — a failed cleanup must fail this spec.
 *
 * ## What this spec never does (AAP §0.5.1, §0.5.2)
 *
 * - It never writes, patches or truncates a file under `apps/demo-app`, and
 *   never fabricates a modification record: instrumentation is installed only
 *   by the real installer and removed only by the real cleanup. Files are read
 *   and hashed through `./helpers/demo-app.ts`; backups are only inspected
 *   (`lstat`, `stat`, `realpath`).
 * - It never re-implements the restoration contract: the snapshot, the
 *   comparison, the marker scan and the working-tree check are the helper's,
 *   and the last two are `scripts/check-no-residual-instrumentation.mjs`'s own
 *   exports, so this spec and `pnpm check:no-residual-instrumentation` cannot
 *   disagree.
 * - It never reads `.git/`, `auth.json` or a credential, and no assertion
 *   message quotes a diff, a marker excerpt or file contents — paths, lines,
 *   statuses and hashes only.
 *
 * Out of scope here, and owned elsewhere: conflict detection
 * (`apps/local-service/test/integration/cleanup-conflict.test.ts`, which may
 * edit its own fixture copy), crash reconciliation
 * (`packages/instrumentation/src/patch/patcher.test.ts`), the unwrapped-`pg` /
 * no-span-created proof (`packages/telemetry/src/node/control.test.ts`) and the
 * fixture app's restoration (`generalization.spec.ts`).
 *
 * `tests/e2e/**` is exempt from the no-hardcoding gate (AAP §0.5.4), which is
 * why the demo's routes and controls may be named below. Which demo files the
 * plan instruments is the product's decision and is never asserted by name.
 *
 * @module tests/e2e/cleanup.spec
 */

import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { Page } from '@playwright/test';

import type { INSTRUMENTATION_MARKERS } from '@debuggen/instrumentation';

import { DEMO_LAUNCH_TIMEOUT_MS, diffSnapshots } from './helpers/demo-app';
import type { MarkerFinding } from './helpers/demo-app';
import {
  DEFAULT_SESSION_TIMEOUTS,
  E2E_TIMEOUTS,
  expect,
  repoRoot,
  runDebugSession,
  test,
} from './helpers/fixtures';
import type {
  DebugSessionOutcome,
  DemoAppHandle,
  ModificationRecord,
  ServiceHandle,
  SessionInteraction,
  SessionRecord,
  TrackedFileSnapshot,
} from './helpers/fixtures';

// ---------------------------------------------------------------------------
// The scenario — the slow-interaction question and its reproduction
// ---------------------------------------------------------------------------

/**
 * The developer's question, verbatim from AAP §0.6.5's first demonstrated
 * panel. It is the question whose plan times named server functions, which is
 * what makes this session apply patch-mode modifications to restore.
 */
const QUESTION = 'Why is this button slow?';

/**
 * The checkout form's submit control — "Place order" — as a CSS selector for
 * the product's element selection (`$0`). On a freshly loaded checkout page it
 * is the form's only submit button; {@link prepareCheckout} proves that before
 * the selector is used.
 */
const PLACE_ORDER_SELECTOR = 'form[aria-label="Checkout details"] button[type="submit"]';

/** The resting label of the checkout's submit control. */
const PLACE_ORDER_LABEL = 'Place order';

/** The storefront's checkout page. */
const CHECKOUT_PATH = '/checkout';

/** The route handler the "Place order" submission posts to. */
const CHECKOUT_API_PATH = '/api/checkout';

/** The storefront's catalog listing route (`PagedList<ProductSummary>`). */
const CATALOG_API_PATH = '/api/products';

/** The storefront's add-to-cart route. */
const CART_ITEMS_API_PATH = '/api/cart/items';

/** A catalog card's link to its product page. */
const PRODUCT_LINK_SELECTOR = 'a[href^="/products/"]';

/** The product page's cart control, in either of its two states. */
const PRODUCT_CART_CONTROL = /^(Add to cart|Out of stock)$/;

/** The address a placed order is pushed to (`/checkout?order=LS-…`). */
const ORDER_ADDRESS_PATTERN = /[?&]order=LS-/;

/** The storefront's name, which every page's `<title>` carries. */
const STORE_NAME = 'Lumen Supply';

// ---------------------------------------------------------------------------
// Vocabulary and budgets
// ---------------------------------------------------------------------------

/** One instrumentation marker literal, typed against the template that writes them. */
type InstrumentationMarker = (typeof INSTRUMENTATION_MARKERS)[number];

/**
 * The span-helper global every patch reads — the one marker a patched file of
 * either language carries (the `__DebuggenSpanHelper` alias is inserted into
 * TypeScript files only). Typed against `wrap-template.ts`'s tuple, so a
 * renamed marker fails to compile here instead of passing silently.
 */
const SPAN_HELPER_GLOBAL_MARKER: InstrumentationMarker = '__DEBUGGEN__';

/**
 * How long the post-cleanup interaction is watched for late telemetry and
 * frames. Live hooks would have delivered within it several times over: the
 * dev-server preload flushes its batch after 1 s and bounds one ingest request
 * at 5 s, and the page agent's transport flushes every 250 ms.
 */
const POST_CLEANUP_QUIET_MS = 6_000;

/**
 * How long the session's event count must hold still before it is taken as the
 * post-cleanup baseline. A batch the service attributed while the capture was
 * open is persisted only after its source locations resolve, and one
 * source-map fetch is bounded at 5 s (`DEFAULT_FETCH_TIMEOUT_MS` in
 * `@debuggen/code-analysis`), so the capture's own last events can land after
 * `cleanup.completed`. They belong to the capture, not to a live hook, and must
 * not be mistaken for one.
 */
const EVENT_SETTLE_QUIET_MS = 5_500;

/** How often the event count is read while it settles. */
const EVENT_SETTLE_POLL_MS = 250;

/**
 * The bound on settling. A count still growing after it is fed by something
 * other than the capture's in-flight batches, which is exactly what the spec
 * must fail on.
 */
const EVENT_SETTLE_BUDGET_MS = 30_000;

/**
 * The whole spec's budget: one complete workflow (every session budget, the
 * panel and a page load — `E2E_TIMEOUTS.longTestTimeoutMs`), four more page
 * loads (the checkout preparation and the post-cleanup interaction), the quiet
 * window, and one launcher round trip for the process-identity check.
 */
const CLEANUP_SPEC_TIMEOUT_MS =
  E2E_TIMEOUTS.longTestTimeoutMs +
  4 * E2E_TIMEOUTS.pageReady +
  POST_CLEANUP_QUIET_MS +
  EVENT_SETTLE_BUDGET_MS +
  DEMO_LAUNCH_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// State the steps pass along
// ---------------------------------------------------------------------------

/** The dev-server process as the launcher reported it before the session. */
interface LaunchIdentity {
  readonly pid: number;
  readonly devServerUrl: string;
  readonly origin: string;
}

/** What the session left on disk while it was instrumented. */
interface InstrumentedState {
  /** Everything the workflow driver observed. */
  readonly outcome: DebugSessionOutcome;
  /** The record the service answered once the panel was generated. */
  readonly session: SessionRecord;
  /** The whole modification journal while instrumented, in application order. */
  readonly journal: readonly ModificationRecord[];
  /** The journal's `applied` entries — what cleanup must undo. */
  readonly applied: readonly ModificationRecord[];
}

/** What ending the session produced, as the last step measures against it. */
interface CleanedUpState {
  /** The editor recording's index taken just before `POST /sessions/:id/end`. */
  readonly endMark: number;
  /** How many telemetry events the session held once cleanup finished. */
  readonly eventsAtEnd: number;
  /** The persisted record after the end. */
  readonly record: SessionRecord;
}

/** The SHA-256 of every tracked demo file, taken before the session existed. */
let preSessionSnapshot: TrackedFileSnapshot | undefined;

/** The launcher's dev-server process, recorded before the session. */
let launchIdentity: LaunchIdentity | undefined;

/** The instrumented state, recorded while the session was live. */
let instrumented: InstrumentedState | undefined;

/** The post-cleanup state, recorded once the session ended. */
let cleanedUp: CleanedUpState | undefined;

/** Forget everything a previous attempt recorded (a retry re-runs every step). */
function resetState(): void {
  preSessionSnapshot = undefined;
  launchIdentity = undefined;
  instrumented = undefined;
  cleanedUp = undefined;
}

/**
 * A value an earlier step must have recorded — the narrowing guard every step
 * uses instead of a non-null assertion, so a skipped prerequisite fails with
 * its name.
 */
function held<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(
      `cleanup.spec: ${what} was not recorded by an earlier step, so this step cannot run.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Read-only utilities
// ---------------------------------------------------------------------------

/** Whether a value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a thrown value is a Node filesystem error with `code`. */
function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/**
 * Whether anything exists at `target` — `lstat`, so a symbolic link is
 * reported rather than followed. Only a missing entry answers `false`; any
 * other failure (a permission problem) is thrown, because it proves nothing.
 */
async function entryExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

/** Whether `child` lies strictly inside `parent` (both absolute, symbolic links already resolved). */
function isStrictlyInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** A journal entry's file as the repository-relative POSIX path the snapshot and the guard use. */
function repoRelativeFile(demoApp: DemoAppHandle, record: ModificationRecord): string {
  return `${demoApp.relDir}/${record.file}`;
}

/** Marker findings as `path:line marker` — never the script's source excerpt. */
function describeFindings(findings: readonly MarkerFinding[]): string[] {
  return findings.map((finding) => `${finding.file}:${String(finding.line)} ${finding.marker}`);
}

/** Every journal entry as `file (status)`, for a failure message. */
function describeJournal(records: readonly ModificationRecord[]): string {
  return records.length === 0
    ? 'an empty journal'
    : records.map((record) => `${record.file} (${record.status})`).join(', ');
}

/** Distinct values, first occurrence first. */
function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Code-unit order, so two path lists compare independently of the order they were built in. */
function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * How many telemetry events the service holds for `sessionId` — a count-only
 * `events` query (`limit: 0` answers the real `total` and no items).
 */
async function eventTotal(service: ServiceHandle, sessionId: string): Promise<number> {
  const page = await service.queryPanelData(sessionId, { source: 'events', limit: 0 });
  return page.total;
}

/**
 * The session's event count once the capture's in-flight batches have landed:
 * read until it holds still for {@link EVENT_SETTLE_QUIET_MS}, within
 * {@link EVENT_SETTLE_BUDGET_MS}.
 *
 * @returns The settled count, and whether it settled inside the budget.
 */
async function settledEventTotal(
  service: ServiceHandle,
  sessionId: string,
): Promise<{ readonly total: number; readonly settled: boolean }> {
  const deadline = Date.now() + EVENT_SETTLE_BUDGET_MS;
  let total = await eventTotal(service, sessionId);
  let stableSince = Date.now();
  while (Date.now() - stableSince < EVENT_SETTLE_QUIET_MS) {
    if (Date.now() >= deadline) {
      return { total, settled: false };
    }
    await delay(EVENT_SETTLE_POLL_MS);
    const next = await eventTotal(service, sessionId);
    if (next !== total) {
      total = next;
      stableSince = Date.now();
    }
  }
  return { total, settled: true };
}

/** The launcher's current account of the demo's process, as {@link LaunchIdentity}. */
function identityOf(launch: {
  readonly pid: number;
  readonly devServerUrl: string;
  readonly origin: string;
}): LaunchIdentity {
  return { pid: launch.pid, devServerUrl: launch.devServerUrl, origin: launch.origin };
}

// ---------------------------------------------------------------------------
// The demo interactions
// ---------------------------------------------------------------------------

/**
 * The id of the first catalog product with stock to promise, read from the
 * storefront's own listing route through the tab's browser context.
 */
async function firstOrderableProductId(page: Page, baseUrl: string): Promise<string> {
  const response = await page.request.get(new URL(CATALOG_API_PATH, baseUrl).toString(), {
    timeout: E2E_TIMEOUTS.pageReady,
  });
  expect(response.status(), `GET ${CATALOG_API_PATH} before the session`).toBe(200);
  const body: unknown = await response.json();
  const items = isRecord(body) && Array.isArray(body.items) ? (body.items as unknown[]) : [];
  const orderable = items.find(
    (item): item is { readonly id: string } =>
      isRecord(item) &&
      typeof item.id === 'string' &&
      typeof item.availableQuantity === 'number' &&
      item.availableQuantity >= 1,
  );
  if (orderable === undefined) {
    throw new Error(
      `cleanup.spec: GET ${CATALOG_API_PATH} listed ${String(items.length)} product(s) and none has stock to promise, so no order can be placed — re-seed the demo database (pnpm demo:seed).`,
    );
  }
  return orderable.id;
}

/**
 * Put one orderable unit in the tab's cart through the storefront's own route
 * (the same browser context, so the same cart), then open the checkout and
 * prove the target control is the form's only submit button, labelled and
 * enabled. Setup only: nothing here runs inside the capture.
 */
async function prepareCheckout(page: Page, baseUrl: string): Promise<void> {
  const productId = await firstOrderableProductId(page, baseUrl);
  const added = await page.request.post(new URL(CART_ITEMS_API_PATH, baseUrl).toString(), {
    // The storefront's `CartMutation` "add" member: one unit of one product.
    data: { operation: 'add', productId, quantity: 1 },
    timeout: E2E_TIMEOUTS.pageReady,
  });
  expect(added.ok(), `POST ${CART_ITEMS_API_PATH} answered HTTP ${String(added.status())}`).toBe(
    true,
  );

  await page.goto(new URL(CHECKOUT_PATH, baseUrl).toString(), {
    timeout: E2E_TIMEOUTS.pageReady,
  });
  const placeOrder = page.locator(PLACE_ORDER_SELECTOR);
  await expect(
    placeOrder,
    `${PLACE_ORDER_SELECTOR} must match exactly one element on a fresh checkout page`,
  ).toHaveCount(1, { timeout: E2E_TIMEOUTS.pageReady });
  await expect(placeOrder).toContainText(PLACE_ORDER_LABEL, { timeout: E2E_TIMEOUTS.pageReady });
  await expect(
    placeOrder,
    'Place order must be enabled: a cart holding an item and the prefilled checkout details',
  ).toBeEnabled({ timeout: E2E_TIMEOUTS.pageReady });
}

/**
 * The reproduction the capture records: press "Place order", require the
 * checkout route's `200`, and wait for the confirmation address the form
 * pushes once React has committed the placed order — so the capture closes
 * after the whole click → request → response → render sequence.
 */
const placeOrder: SessionInteraction = async ({ appPage }) => {
  const [response] = await Promise.all([
    appPage.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST' &&
        new URL(candidate.url()).pathname === CHECKOUT_API_PATH,
      { timeout: E2E_TIMEOUTS.pageReady },
    ),
    appPage.locator(PLACE_ORDER_SELECTOR).click(),
  ]);
  expect(response.status(), `POST ${CHECKOUT_API_PATH} inside the capture`).toBe(200);
  await expect(appPage).toHaveURL(ORDER_ADDRESS_PATTERN, { timeout: E2E_TIMEOUTS.pageReady });
};

/**
 * An interaction after cleanup that would produce browser, route-handler and
 * database telemetry if any hook were still live: load the catalog, follow the
 * first product card, and wait for the product page's cart control.
 */
async function browseAfterCleanup(page: Page, baseUrl: string): Promise<void> {
  await page.goto(new URL('/', baseUrl).toString(), { timeout: E2E_TIMEOUTS.pageReady });
  const card = page.locator(PRODUCT_LINK_SELECTOR).first();
  await expect(card, 'the catalog lists a product after cleanup').toBeVisible({
    timeout: E2E_TIMEOUTS.pageReady,
  });
  await card.click();
  await expect(page).toHaveURL(/\/products\//, { timeout: E2E_TIMEOUTS.pageReady });
  await expect(
    page.getByRole('button', { name: PRODUCT_CART_CONTROL }),
    'the product page renders its cart control after cleanup',
  ).toBeVisible({ timeout: E2E_TIMEOUTS.pageReady });
}

// ---------------------------------------------------------------------------
// The acceptance test
// ---------------------------------------------------------------------------

test.describe('cleanup — ending a session leaves the demo exactly as it was', () => {
  test.describe.configure({ mode: 'serial' });

  test('a real session patches the demo, ending it restores every byte, and the same dev server keeps serving with inert hooks', async ({
    service,
    demoApp,
    appPage,
    panel,
    editorClient,
    sessions,
  }) => {
    test.setTimeout(CLEANUP_SPEC_TIMEOUT_MS);
    resetState();

    await test.step('the demo starts clean and is snapshotted before any session exists', async () => {
      const residue = describeFindings(await demoApp.findMarkers());
      expect(
        residue,
        `${demoApp.relDir} carries instrumentation markers before this spec created a session — an earlier run left residue. Restore it through the product (start the local service once so it reconciles its journal), never by hand`,
      ).toEqual([]);
      expect(
        await demoApp.worktreeDirty(),
        `${demoApp.relDir} has uncommitted changes before the session (git status --porcelain -- ${demoApp.relDir}); a dirty starting tree would poison the byte-identical comparison, so commit, stash or restore it first`,
      ).toBe(false);

      preSessionSnapshot = await demoApp.snapshotTrackedFiles();
      expect(
        preSessionSnapshot.size,
        `the pre-session snapshot of ${demoApp.relDir} holds no file`,
      ).toBeGreaterThan(0);

      launchIdentity = identityOf(demoApp.expectPreloadAttached());
    });

    await test.step('a real session applies patch-mode instrumentation through the installer', async () => {
      const snapshot = held(preSessionSnapshot, 'the pre-session snapshot');

      await prepareCheckout(appPage, demoApp.baseUrl);
      const outcome = await runDebugSession({
        service,
        editorClient,
        projectRoot: demoApp.projectRoot,
        question: QUESTION,
        panel,
        appPage,
        target: { selector: PLACE_ORDER_SELECTOR },
        interact: placeOrder,
        tracker: sessions,
      });
      const { sessionId } = outcome;
      expect(outcome.session.status, `session ${sessionId} after its panel was generated`).toBe(
        'generated',
      );

      // The non-vacuousness guard: restoration proves nothing unless something was installed.
      const journal = await service.getModifications(sessionId);
      const applied = journal.filter((record) => record.status === 'applied');
      expect(
        applied.length,
        `GET /sessions/${sessionId}/modifications holds ${describeJournal(journal)}: with no applied patch-mode modification this spec cannot prove reversibility`,
      ).toBeGreaterThan(0);
      instrumented = { outcome, session: outcome.session, journal, applied };

      // Every applied modification came from a patch-mode action of the validated plan…
      const patchTargets = new Set(
        (outcome.plan?.instrumentationTargets ?? [])
          .filter((action) => action.mode === 'patch')
          .map((action) => action.file),
      );
      expect(
        applied.filter((record) => !patchTargets.has(record.file)).map((record) => record.file),
        `every applied modification of session ${sessionId} must implement a patch-mode action of its validated plan`,
      ).toEqual([]);

      // …and was made visible: announced by an instrumentation.ready frame of this session.
      const announced = new Set(
        editorClient
          .messagesOf('instrumentation.ready')
          .filter((message) => message.payload.sessionId === sessionId)
          .flatMap((message) => message.payload.applied.map((record) => record.id)),
      );
      expect(
        applied.filter((record) => !announced.has(record.id)).map((record) => record.file),
        `every applied modification of session ${sessionId} must have been announced in instrumentation.ready`,
      ).toEqual([]);

      // The journal entries are complete, and each describes what is on disk right now.
      const home = await realpath(service.debuggenHome);
      const checkout = await realpath(repoRoot());
      const chainHeads = new Map<string, ModificationRecord>();
      for (const record of applied) {
        // The journal is in application order, so the last record per file is the newest.
        chainHeads.set(record.file, record);
      }
      const problems: string[] = [];
      for (const record of applied) {
        const label = `${record.file} (${record.id})`;
        if (record.sessionId !== sessionId) {
          problems.push(`${label}: journaled for session ${record.sessionId}`);
        }
        if (record.originalHash === record.instrumentedHash) {
          problems.push(`${label}: originalHash equals instrumentedHash, so nothing was patched`);
        }
        if (record.diff.length === 0 || !record.diff.includes('@@')) {
          problems.push(`${label}: the recorded unified diff is empty or has no hunk`);
        }
        // A file patched by a chain of records (AAP §0.4.2) holds its newest record's bytes.
        if (chainHeads.get(record.file) === record) {
          const current = await demoApp.hashFile(record.file);
          if (current !== record.instrumentedHash) {
            problems.push(
              `${label}: hashes to ${current} on disk, not the recorded instrumentedHash ${record.instrumentedHash}`,
            );
          }
          if (current === record.originalHash) {
            problems.push(
              `${label}: still hashes to its originalHash, so the patch is not on disk`,
            );
          }
        }
        if (!(await entryExists(record.backupPath)) || !(await stat(record.backupPath)).isFile()) {
          problems.push(`${label}: its backup is not a regular file`);
          continue;
        }
        const backup = await realpath(record.backupPath);
        if (!isStrictlyInside(home, backup)) {
          problems.push(`${label}: its backup lies outside $DEBUGGEN_HOME (${home})`);
        }
        if (isStrictlyInside(checkout, backup)) {
          problems.push(`${label}: its backup lies inside the repository checkout`);
        }
      }
      expect(problems, `the applied modifications of session ${sessionId}`).toEqual([]);

      // Exactly the journaled files changed: nothing the journal does not account for.
      const patchedFiles = sorted(
        distinct(applied.map((record) => repoRelativeFile(demoApp, record))),
      );
      const midSession = diffSnapshots(snapshot, await demoApp.snapshotTrackedFiles());
      expect(
        { added: midSession.added, removed: midSession.removed, changed: midSession.changed },
        `while session ${sessionId} is instrumented, the tracked files that differ from the pre-session snapshot must be exactly the journaled ones`,
      ).toEqual({ added: [], removed: [], changed: patchedFiles });

      // The transiently dirty state cleanup must undo is visible to the same guard CI runs.
      const findings = await demoApp.findMarkers();
      const markedFiles = new Set(
        findings
          .filter((finding) => finding.marker === SPAN_HELPER_GLOBAL_MARKER)
          .map((finding) => finding.file),
      );
      expect(
        patchedFiles.filter((file) => !markedFiles.has(file)),
        `every patched file must carry the ${SPAN_HELPER_GLOBAL_MARKER} marker while instrumented`,
      ).toEqual([]);
      expect(
        describeFindings(findings.filter((finding) => !patchedFiles.includes(finding.file))),
        'no marker may appear in a file the journal does not name',
      ).toEqual([]);
      expect(
        await demoApp.worktreeDirty(),
        `${demoApp.relDir} must show the patches in git status while instrumented`,
      ).toBe(true);
      const midGate = await demoApp.runResidualCheck();
      expect(
        midGate.exitCode,
        `the residual-instrumentation gate must fail on the instrumented tree:\n${midGate.message}`,
      ).toBe(1);
    });

    await test.step('ending the session restores every tracked file byte for byte and reports clean', async () => {
      const snapshot = held(preSessionSnapshot, 'the pre-session snapshot');
      const { outcome, journal, applied } = held(instrumented, 'the instrumented state');
      const { sessionId } = outcome;

      const endMark = editorClient.snapshotIndex();
      const endRequestedAt = Date.now();
      const response = await service.endSession(sessionId);
      const completed = (
        await editorClient.waitFor(
          'cleanup.completed',
          (payload) => payload.sessionId === sessionId,
          { sinceIndex: endMark, timeoutMs: DEFAULT_SESSION_TIMEOUTS.end },
        )
      ).payload;

      // The verdict, on the wire and in the HTTP answer.
      expect(response.cleanup, `POST /sessions/${sessionId}/end`).toBe('clean');
      expect(completed.status, `cleanup.completed for session ${sessionId}`).toBe('clean');
      expect(
        completed.conflicts.map((conflict) => `${conflict.file}: ${conflict.reason}`),
        `cleanup.completed for session ${sessionId} reports no conflict`,
      ).toEqual([]);

      // The session's evidence once cleanup finished and the capture's in-flight
      // batches landed: the baseline every later request, probe and interaction is
      // measured against.
      const settledAtEnd = await settledEventTotal(service, sessionId);
      expect(
        settledAtEnd.settled,
        `the telemetry of ended session ${sessionId} must stop growing within ${String(EVENT_SETTLE_BUDGET_MS)} ms of cleanup — its hooks are disabled, not idled`,
      ).toBe(true);
      const eventsAtEnd = settledAtEnd.total;
      expect(
        eventsAtEnd,
        `session ${sessionId} must hold the telemetry of its capture, or an unchanged count proves nothing`,
      ).toBeGreaterThan(0);

      // The verdict, persisted.
      const record = await service.getSession(sessionId);
      expect(record.status, `session ${sessionId} after POST /sessions/:id/end`).toBe('ended');
      expect(record.cleanup.status, `the persisted cleanup of session ${sessionId}`).toBe('clean');
      expect(record.cleanup.conflicts, `the persisted conflicts of session ${sessionId}`).toEqual(
        [],
      );
      expect(
        { status: record.cleanup.status, conflicts: record.cleanup.conflicts },
        'the persisted cleanup carries the verdict cleanup.completed broadcast',
      ).toEqual({ status: completed.status, conflicts: completed.conflicts });
      const completedAt = held(record.cleanup.completedAt, 'the persisted cleanup.completedAt');
      expect(completedAt, 'cleanup completed after the end was requested').toBeGreaterThanOrEqual(
        endRequestedAt,
      );
      expect(completedAt, 'cleanup completed before the record was read').toBeLessThanOrEqual(
        Date.now(),
      );

      // Every journal entry is reverted, and none was lost or added on the way.
      const journalAfter = await service.getModifications(sessionId);
      expect(
        sorted(journalAfter.map((entry) => entry.id)),
        `the modification journal of session ${sessionId} keeps exactly its records`,
      ).toEqual(sorted(journal.map((entry) => entry.id)));
      expect(
        journalAfter
          .filter((entry) => entry.status !== 'reverted')
          .map((entry) => `${entry.file} (${entry.status})`),
        `every modification of session ${sessionId} must be reverted`,
      ).toEqual([]);

      // The acceptance assertion: every tracked demo file, not only the patched ones.
      const restoration = await demoApp.verifyRestored(snapshot, {
        message: `after session ${sessionId} ended`,
      });
      expect(
        diffSnapshots(snapshot, restoration.after.snapshot),
        `every tracked file under ${demoApp.relDir} must be byte-identical to the pre-session snapshot`,
      ).toEqual({ added: [], removed: [], changed: [], unchanged: snapshot.size });

      // No residue, by the guard's own exports and its own command line.
      expect(
        describeFindings(await demoApp.findMarkers()),
        `${demoApp.relDir} must carry no instrumentation marker after cleanup`,
      ).toEqual([]);
      expect(
        await demoApp.worktreeDirty(),
        `git status --porcelain -- ${demoApp.relDir} must be empty after cleanup`,
      ).toBe(false);
      const gate = await demoApp.runResidualCheck();
      expect(gate.exitCode, `pnpm check:no-residual-instrumentation:\n${gate.message}`).toBe(0);

      // A backup is deleted once the restored content verified against originalHash.
      const survivingBackups: string[] = [];
      for (const entry of applied) {
        if (await entryExists(entry.backupPath)) {
          survivingBackups.push(`${entry.file} (${entry.id})`);
        }
      }
      expect(
        survivingBackups,
        'the backup of every restored file must be deleted after its verified restore',
      ).toEqual([]);

      cleanedUp = { endMark, eventsAtEnd, record };
    });

    await test.step('the same dev server keeps serving with the inert preload, and no hook is live', async () => {
      const identity = held(launchIdentity, 'the launch identity');
      const { outcome } = held(instrumented, 'the instrumented state');
      const ended = held(cleanedUp, 'the post-cleanup state');
      const { sessionId } = outcome;

      // The process the launcher started before the session is the one still running:
      // the launcher answers with its live child and restarts nothing.
      const current = await demoApp.start();
      expect(
        identityOf(current),
        'the launcher must still report the dev-server process it launched before the session; a restarted server would make the next assertions meaningless',
      ).toEqual(identity);
      expect(current.reused, 'the launcher reused its running child').toBe(true);

      // It serves pages and API routes, with the preload still loaded but inert.
      const home = await appPage.request.get(new URL('/', demoApp.baseUrl).toString(), {
        timeout: E2E_TIMEOUTS.pageReady,
      });
      expect(home.status(), 'GET / after cleanup').toBe(200);
      expect(
        (await home.text()).includes(STORE_NAME),
        `GET / renders the ${STORE_NAME} storefront`,
      ).toBe(true);
      const catalog = await appPage.request.get(
        new URL(CATALOG_API_PATH, demoApp.baseUrl).toString(),
        {
          timeout: E2E_TIMEOUTS.pageReady,
        },
      );
      expect(catalog.status(), `GET ${CATALOG_API_PATH} after cleanup`).toBe(200);
      const listing: unknown = await catalog.json();
      expect(
        isRecord(listing) &&
          Array.isArray(listing.items) &&
          listing.items.length > 0 &&
          typeof listing.total === 'number',
        `GET ${CATALOG_API_PATH} answers a non-empty catalog page after cleanup`,
      ).toBe(true);

      // An interaction that live hooks would record adds nothing to the ended session,
      // and the session neither captures again nor generates another panel.
      await browseAfterCleanup(appPage, demoApp.baseUrl);
      await Promise.all([
        editorClient.expectNoMessage(
          'panel.generated',
          (payload) => payload.sessionId === sessionId && payload.panelId !== outcome.panelId,
          POST_CLEANUP_QUIET_MS,
          { sinceIndex: ended.endMark },
        ),
        editorClient.expectNoMessage(
          'capture.started',
          (payload) => payload.sessionId === sessionId,
          POST_CLEANUP_QUIET_MS,
          { sinceIndex: ended.endMark },
        ),
      ]);
      expect(
        await eventTotal(service, sessionId),
        `the telemetry of ended session ${sessionId} must not grow after cleanup — its hooks are disabled, not idled`,
      ).toBe(ended.eventsAtEnd);

      // The session is presented as ended, not as successful and ongoing.
      const final = await service.getSession(sessionId);
      expect(final.status, `session ${sessionId} after the post-cleanup interaction`).toBe('ended');
      expect(final.boundTab, `ended session ${sessionId} is bound to no tab`).toBeUndefined();
      expect(final.cleanup.status, `the persisted cleanup of session ${sessionId}`).toBe('clean');
      expect(final.panelIds, `ended session ${sessionId} gains no panel`).toEqual(
        ended.record.panelIds,
      );
      expect(final.captures.length, `ended session ${sessionId} gains no capture`).toBe(
        ended.record.captures.length,
      );
    });
  });
});
