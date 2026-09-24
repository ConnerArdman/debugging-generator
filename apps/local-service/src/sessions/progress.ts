/**
 * `session.progress` from real pipeline findings: the module that produces the
 * developer-visible progress view both user interfaces render.
 *
 * The view the editor shows for a session reads like this (prompt §11, Step 8):
 *
 * ```text
 * Understanding problem          ← the `understand` stage's `running` row
 * Investigating code             ← the `investigate` stage's `running` row
 * ✓ Found ‹component›            ← a `done` row per component the code graph found
 * ✓ Traced ‹handler›             ← a `done` row per event handler actually traced
 * ✓ Found ‹route path›           ← a `done` row per API route actually resolved
 * ✓ Found database dependency    ← one `done` row when a database call site exists
 *
 * Preparing instrumentation      ← the `instrument` stage's `running` row
 * ✓ Browser performance          ← one `done` row per signal actually armed
 * ✓ React renders
 * ✓ Network tracing
 * ✓ Server spans
 * ✓ Database tracing
 * ✗ Could not enable ‹signal›: ‹reason›.   ← one `failed` row per unavailable signal
 *
 * Ready to capture               ← the `instrument` stage's closing `done` row
 * ```
 *
 * A **group header** is a stage's `running` row, whose `message` is the stage
 * title from {@link PROGRESS_STAGE_TITLES}; a **✓ row** is a `done` row and a
 * **✗ row** a `failed` one. Both user interfaces group whatever the service sent
 * by stage and draw it in arrival order, so neither of them restates a title, a
 * label or a step list.
 *
 * ## The rows are rendered from findings, never from canned text
 *
 * This is the constraint the product is judged on (AAP §0.5.4). Every finding
 * row is built by {@link buildInvestigationRows} or
 * {@link buildInstrumentationRows} from the structured input it was handed —
 * the names the code graph resolved, the hooks the installer armed, the signals
 * an adapter reported unavailable — and a class of finding with no input
 * produces **no row at all**: no placeholder, no "checking…" line, no default
 * name. Deleting one finding from the input deletes exactly its row. The source
 * holds only templates such as `` `Found ${name}` ``; the concrete text exists
 * only at run time. Nothing here reads, receives or branches on the developer's
 * question — it is not an input of any function in this module — and no name of
 * any particular application appears in it; `scripts/check-no-hardcoding.mjs`
 * scans this file for both.
 *
 * The stage titles and signal labels below are the product's own vocabulary
 * (its pipeline stages and its capture signals), not a description of any
 * project it debugs.
 *
 * ## Two halves: pure builders, one emitter
 *
 * - The **builders** are exported, pure, synchronous and I/O-free — no store,
 *   no transport, no clock, no logger — so the from-findings guarantee is
 *   asserted directly against them by
 *   `apps/local-service/test/integration/session-lifecycle.test.ts` (this folder
 *   ships no colocated progress suite by design).
 * - The **emitter**, {@link createSessionProgress}, turns a row into a validated
 *   `session.progress` payload, persists it through the session store's
 *   `session_progress` table and broadcasts it to the session's editor and
 *   DevTools clients. Persisting first is what lets `./reopen.ts` replay a
 *   session with every row a client ever saw.
 *
 * ## What this module never does
 *
 * - **It never changes a session's status.** Status transitions belong to
 *   `./state-machine.ts` and are applied only by `./manager.ts`; a progress row
 *   is a report of what a stage did, not a decision about the session.
 * - **It never owns transport.** It receives a broadcaster port and hands it a
 *   finished envelope; sockets, client registries and routing live in
 *   `apps/local-service/src/server/**`, which this module does not import.
 * - **It never puts a secret into a row or a log record.** Its inputs are names,
 *   project-relative paths, the product's labels and adapters' developer-facing
 *   reasons and hints. Log records carry only stages, statuses, counts and error
 *   codes — never a message, a detail or a rejected payload (AAP §0.5.2).
 *
 * @module
 */

import {
  createEnvelope,
  parseSessionProgressPayload,
  type ClientKind,
  type ProgressStage,
  type ProgressStatus,
  type ProtocolMessage,
  type RelevantFile,
  type SessionProgressPayload,
} from '@debuggen/protocol';
import {
  AGENT_HOOK_KEYS,
  CAPTURE_SIGNALS,
  READINESS_HINT_MAX_LENGTH,
  READINESS_REASON_MAX_LENGTH,
  SERVER_AGENT_SIGNAL_KEYS,
  isCaptureSignal,
  type AgentHookConfig,
  type CaptureSignal,
  type ProblemEntity,
  type ProblemEntityKind,
  type Readiness,
  type ServerAgentSignals,
  type UnavailableSignal,
} from '@debuggen/instrumentation';
import { DebuggenError, err, noopLogger, nowEpochMs, ok } from '@debuggen/shared';
import type { Logger, Result, SessionId } from '@debuggen/shared';

import { LOG_BINDING_KEYS, subsystemLogger } from '../logging.js';
import type { SessionsRepo } from '../store/sessions-repo.js';
import type { SessionFailure } from './state-machine.js';

// ---------------------------------------------------------------------------
// Section A — the display vocabulary (single definitions)
// ---------------------------------------------------------------------------

/**
 * The group header of every progress stage.
 *
 * Travels on the wire as the `message` of each stage's `running` row, which is
 * how both user interfaces obtain it: neither duplicates a title, and a stage
 * added to protocol's `PROGRESS_STAGES` is a compile error here until it has
 * one. The two titles prompt §11 prints are used verbatim; the other seven are
 * written in the same plain voice and name only the product's own pipeline
 * phases — no framework, no application, no project noun.
 */
export const PROGRESS_STAGE_TITLES = Object.freeze({
  understand: 'Understanding problem',
  investigate: 'Investigating code',
  plan: 'Planning instrumentation',
  instrument: 'Preparing instrumentation',
  capture: 'Capturing runtime evidence',
  analyze: 'Analyzing captured evidence',
  'generate-panel': 'Generating debugging panel',
  followup: 'Evaluating follow-up question',
  cleanup: 'Removing instrumentation',
} as const satisfies Readonly<Record<ProgressStage, string>>);

/**
 * The human label of every capture signal: the text of an instrumentation
 * stage's ✓ row, and the `‹signal›` of its ✗ row.
 *
 * The five labels prompt §11 prints are the labels of the signals behind them:
 * the performance-entry signal is "Browser performance", the fiber-hook signal
 * "React renders", request tracing "Network tracing", the incoming-request and
 * route-handler signals "Server spans", and both database signals "Database
 * tracing". Several signals legitimately share a label, which is why
 * {@link buildInstrumentationRows} de-duplicates by label.
 *
 * **Declaration order is display order.** The five labels come first, in the
 * prompt's order, so the Step-8 group reads as printed whenever those signals
 * are armed; the signals the prompt does not show follow. The signal names
 * themselves are protocol's — owned by `CAPTURE_SIGNALS` in
 * `packages/instrumentation/src/schema/readiness.ts` — and a signal added there
 * is a compile error here until it has a label.
 */
export const CAPTURE_SIGNAL_LABELS = Object.freeze({
  perf: 'Browser performance',
  react: 'React renders',
  fetch: 'Network tracing',
  http: 'Server spans',
  routeHandlers: 'Server spans',
  prisma: 'Database tracing',
  pg: 'Database tracing',
  interactions: 'Interaction timing',
  state: 'State transitions',
  componentTree: 'Component tree',
  errors: 'Runtime errors',
  functions: 'Function timing',
} as const satisfies Readonly<Record<CaptureSignal, string>>);

/** One of the labels in {@link CAPTURE_SIGNAL_LABELS}. */
export type CaptureSignalLabel = (typeof CAPTURE_SIGNAL_LABELS)[CaptureSignal];

/**
 * The stable display order of the instrumentation stage's ✓ rows: every
 * distinct label of {@link CAPTURE_SIGNAL_LABELS}, in declaration order.
 *
 * Derived rather than written out, so no signal name or label is restated and
 * the order cannot drift from the label map it describes.
 */
export const INSTRUMENTATION_ROW_ORDER: readonly CaptureSignalLabel[] = Object.freeze([
  ...new Set(Object.values(CAPTURE_SIGNAL_LABELS)),
]);

/**
 * The closing `done` row of the instrumentation stage, emitted once readiness
 * is satisfied.
 *
 * The VS Code view's "Reproduce the issue now." (AAP §0.7.3) is **not** a
 * progress row: it is the webview's own rendering of the armed state it reads
 * from the session record, and no stage emits it.
 */
export const READY_TO_CAPTURE_MESSAGE = 'Ready to capture';

/**
 * The most rows either builder returns for its stage, including the single
 * overflow row `` `+${n} more` `` that stands for the remainder.
 *
 * Every class of finding that produced anything keeps at least one visible row
 * before any class is given a second, so a large project can never crowd a
 * database dependency or an unavailable signal out of the view. Consequently no
 * single class exceeds this bound either.
 */
export const MAX_FINDING_ROWS_PER_STAGE = 12;

/**
 * The client kinds a `session.progress` frame is delivered to: the editor's
 * view and the bound tab's DevTools panel (AAP §0.4.2).
 *
 * Typed against protocol's `ClientKind`, so renaming a kind breaks this line
 * rather than silently routing progress to nobody.
 */
export const PROGRESS_RECIPIENT_KINDS: readonly ClientKind[] = Object.freeze([
  'vscode',
  'devtools',
]);

/** The one row the database class produces, whenever a call site was found. */
const DATABASE_DEPENDENCY_MESSAGE = 'Found database dependency';

/** The logger binding naming this folder, per `../logging.ts`'s convention. */
const LOG_SUBSYSTEM = 'sessions';

/**
 * Display bound for one finding name — a component, a handler symbol, a route
 * path. Far above any identifier or path the code graph produces, and far below
 * the transport's message bound, so a clipped name still makes a valid row.
 */
const MAX_FINDING_TEXT_LENGTH = 240;

/**
 * Display bound for a composed first line (a stage failure's message).
 * Half of protocol's transport bound for `message`, whose schema remains the
 * authority {@link SessionProgress.emit} validates against.
 */
const MAX_MESSAGE_TEXT_LENGTH = 1000;

/**
 * Display bound for a composed second line. A quarter of protocol's transport
 * bound for `detail`, which again stays the validator of record.
 */
const MAX_DETAIL_TEXT_LENGTH = 1000;

/** Separator between the entries a single `detail` line lists. */
const DETAIL_LIST_SEPARATOR = ', ';

/** Separator between the independent facts one `detail` line carries. */
const DETAIL_PART_SEPARATOR = ' · ';

/** Appended to a clipped display text. */
const ELLIPSIS = '…';

/**
 * A database call site in callee form — `a.b.c` or `a.b.c()` — the only shape
 * of database finding this module is willing to print. Anything else (a
 * statement, a location string) is counted but never echoed, so no SQL text can
 * reach a progress row through this path (AAP §0.5.2).
 */
const CALL_SITE_PATTERN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/u;

/** Trailing sentence punctuation stripped from a reason before it is quoted. */
const TRAILING_PUNCTUATION_PATTERN = /[\s.]+$/u;

// ---------------------------------------------------------------------------
// Section B — the builders' inputs and output
// ---------------------------------------------------------------------------

/**
 * One progress row before it is addressed to a session: exactly the fields of
 * protocol's `session.progress` payload other than `sessionId`, picked rather
 * than restated so the two cannot drift. `detail`, when present, is the
 * optional second line — a string on the wire, never a structure.
 */
export type ProgressRow = Pick<SessionProgressPayload, 'stage' | 'status' | 'message' | 'detail'>;

/**
 * What the investigation actually found, as {@link buildInvestigationRows}
 * reads it.
 *
 * Declared here rather than imported from `../pipeline/**`, which is a higher
 * layer that calls into this one. Every member is optional and each array is a
 * list of **findings**, not of guesses:
 *
 * - An explicit array — even an empty one — is authoritative for its class.
 * - When an array is absent, its class is derived from {@link entities} by
 *   entity kind (see {@link buildInvestigationRows}), so a caller holding only
 *   the Stage-1 entities and the investigation's relevant files is served too.
 * - {@link relevantFiles} is never a class of its own; it supplies the
 *   evidential origin (the file) a finding row carries as its `detail`.
 */
export interface InvestigationFindings {
  /** Component or symbol names the code graph actually resolved. */
  readonly components?: readonly string[];
  /** Event-handler symbols actually traced. */
  readonly eventHandlers?: readonly string[];
  /** API route paths actually resolved to a handler. */
  readonly routes?: readonly string[];
  /** Database call sites actually found. */
  readonly databaseDependencies?: readonly string[];
  /** The Stage-1 entities, when the caller has them. */
  readonly entities?: readonly ProblemEntity[];
  /** The investigation's relevant files, used for each row's origin. */
  readonly relevantFiles?: readonly RelevantFile[];
}

/**
 * What the installer actually armed, as {@link buildInstrumentationRows} reads
 * it. Every member is optional; a signal is shown as enabled only when one of
 * {@link signals}, {@link hooks}, {@link serverSignals} or {@link runtimeHooks}
 * says so, and is never assumed.
 */
export interface InstalledSignals {
  /** Signals actually enabled, by name. */
  readonly signals?: readonly CaptureSignal[];
  /** The page-agent hook configuration actually sent (`agent.config`). */
  readonly hooks?: AgentHookConfig;
  /** The dev-server signal set actually sent (`server-agent.config`). */
  readonly serverSignals?: ServerAgentSignals;
  /**
   * `InstallResult.runtimeHooks`: an entry counts when it is exactly a signal
   * name or exactly one of {@link CAPTURE_SIGNAL_LABELS}' labels. Adapters'
   * finer-grained hook descriptions are carried by `instrumentation.ready`
   * instead and are not mapped here, because mapping free text would be a guess.
   */
  readonly runtimeHooks?: readonly string[];
  /**
   * `InstallResult.unavailable`. Protocol's `unavailableSignalSchema` is the
   * wire validator of the same shape; this module reads the instrumentation
   * type the installer produces.
   */
  readonly unavailable?: readonly UnavailableSignal[];
  /**
   * The aggregated readiness report. A row `unavailable` here withdraws the
   * signal's ✓ row (and reports it as ✗ when no `unavailable` entry already
   * did); a `degraded` row keeps the ✓ and explains itself in the detail.
   */
  readonly readiness?: Readiness;
}

/** The four classes of investigation finding, in the order they are displayed. */
type FindingClass = 'components' | 'eventHandlers' | 'routes' | 'databaseDependencies';

/**
 * Which finding class a Stage-1 entity kind seeds, when the explicit array for
 * that class is absent.
 *
 * Keyed by the closed `PROBLEM_ENTITY_KINDS` vocabulary with `satisfies`, so a
 * kind added upstream is a compile error until it is placed here. Only kinds
 * that *are* one of the four classes map to one: a `component` entity is a
 * component, a `route` a route path, a `query` a data-layer operation. No kind
 * denotes an event handler, so that class is never derived — a `function`
 * entity is not evidence that a handler was traced, and inferring one from a
 * name would be a guess.
 */
const ENTITY_KIND_FINDING_CLASS = Object.freeze({
  component: 'components',
  function: undefined,
  hook: undefined,
  route: 'routes',
  file: undefined,
  symbol: undefined,
  selector: undefined,
  url: undefined,
  query: 'databaseDependencies',
  other: undefined,
} as const satisfies Readonly<Record<ProblemEntityKind, FindingClass | undefined>>);

/** One resolved finding: its display name and, when known, its file. */
interface Finding {
  readonly name: string;
  readonly file?: string;
}

// ---------------------------------------------------------------------------
// Section C — display-text helpers (pure)
// ---------------------------------------------------------------------------

/** Highest code point of the C0 control block. */
const C0_CONTROL_MAX = 0x1f;

/** Lowest code point of the DEL/C1 control block. */
const C1_CONTROL_MIN = 0x7f;

/** Highest code point of the C1 control block. */
const C1_CONTROL_MAX = 0x9f;

/** Whether a code point is whitespace or a control character. */
function isBreakingCodePoint(codePoint: number): boolean {
  return (
    codePoint <= C0_CONTROL_MAX ||
    (codePoint >= C1_CONTROL_MIN && codePoint <= C1_CONTROL_MAX) ||
    /\s/u.test(String.fromCodePoint(codePoint))
  );
}

/**
 * Normalises a value into one line of display text: every run of whitespace
 * or control characters becomes a single space, the ends are trimmed, and a
 * value longer than `maxLength` code points is clipped with an ellipsis.
 *
 * A progress row is one line in two user interfaces and a log-free store row;
 * a name carrying a line feed would split it. Clipping counts code points, so
 * a surrogate pair is never cut in half.
 *
 * @param value Any value; a non-string yields the empty string.
 * @param maxLength The most code points to keep, ellipsis included.
 * @returns The display text, or `''` when nothing printable remains.
 */
function toDisplayText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }

  const codePoints: string[] = [];
  let pendingSpace = false;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (isBreakingCodePoint(codePoint)) {
      pendingSpace = codePoints.length > 0;
      continue;
    }

    if (pendingSpace) {
      codePoints.push(' ');
      pendingSpace = false;
    }

    codePoints.push(character);
  }

  if (codePoints.length <= maxLength) {
    return codePoints.join('');
  }

  return `${codePoints
    .slice(0, Math.max(0, maxLength - 1))
    .join('')
    .trimEnd()}${ELLIPSIS}`;
}

/**
 * Joins entries into one bounded line, stopping before the bound and saying
 * how many entries were left out.
 *
 * Stops as soon as the line is full, so a list of ten thousand names costs no
 * more than the bound to render.
 *
 * @param entries The entries, already display text.
 * @param separator What goes between two entries.
 * @param maxLength The bound on the joined entries, before the omission note.
 * @param alsoOmitted Entries the caller withheld itself (never printable), to
 * be counted in the same omission note rather than a second one.
 * @returns The line, or `''` for an empty list with nothing omitted.
 */
function joinBounded(
  entries: readonly string[],
  separator: string,
  maxLength: number,
  alsoOmitted = 0,
): string {
  let line = '';
  let shown = 0;

  for (const entry of entries) {
    const next = shown === 0 ? entry : `${line}${separator}${entry}`;

    if (next.length > maxLength) {
      break;
    }

    line = next;
    shown += 1;
  }

  const omitted = entries.length - shown + alsoOmitted;

  if (omitted === 0) {
    return line;
  }

  const suffix = `+${String(omitted)} more`;

  return shown === 0 ? suffix : `${line}${separator}${suffix}`;
}

/**
 * The display names of a list, normalised, with blanks dropped and duplicates
 * collapsed onto their first occurrence — so the output is deterministic for a
 * given input and follows its order.
 */
function uniqueDisplayNames(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const value of values) {
    const name = toDisplayText(value, MAX_FINDING_TEXT_LENGTH);

    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}

/**
 * A project-relative path as a display text: normalised like any other line,
 * with the cosmetic `./` prefix an authored path may carry removed.
 */
function toDisplayPath(value: unknown): string {
  let path = toDisplayText(value, MAX_FINDING_TEXT_LENGTH);

  while (path.startsWith('./')) {
    path = path.slice(2);
  }

  return path;
}

/**
 * Builds a row, adding `detail` only when there is one — an absent key rather
 * than an `undefined` value, which is how protocol spells "no detail" and what
 * survives a JSON round trip unchanged. The row is frozen: builders hand out
 * values, not state.
 */
function makeRow(
  stage: ProgressStage,
  status: ProgressStatus,
  message: string,
  detail?: string,
): ProgressRow {
  return Object.freeze(
    detail === undefined || detail.length === 0
      ? { stage, status, message }
      : { stage, status, message, detail },
  );
}

// ---------------------------------------------------------------------------
// Section D — bounding a stage's rows (pure)
// ---------------------------------------------------------------------------

/**
 * Bounds a stage's rows to {@link MAX_FINDING_ROWS_PER_STAGE}, replacing the
 * remainder with one `` `+${n} more` `` row.
 *
 * `groups` are the stage's classes of row in display order. When everything
 * fits it is returned whole. Otherwise one slot is reserved for the overflow
 * row, every non-empty group is given one slot first — so no class of finding
 * disappears behind another — and the remaining slots are filled group by
 * group in `fillOrder`. Shown rows keep their display order; the overflow row
 * comes last, is `failed` when any row it stands for is a failure (a failure is
 * never hidden under a ✓), and lists the hidden rows' messages as its detail.
 *
 * @param stage The stage every row belongs to.
 * @param groups The rows, grouped by class, in display order.
 * @param fillOrder Group indices in the order spare slots are granted.
 * @returns At most {@link MAX_FINDING_ROWS_PER_STAGE} frozen rows.
 */
function boundStageRows(
  stage: ProgressStage,
  groups: readonly (readonly ProgressRow[])[],
  fillOrder: readonly number[],
): readonly ProgressRow[] {
  const total = groups.reduce((sum, group) => sum + group.length, 0);

  if (total <= MAX_FINDING_ROWS_PER_STAGE) {
    return Object.freeze(groups.flat());
  }

  const allocation = groups.map(() => 0);
  let remaining = MAX_FINDING_ROWS_PER_STAGE - 1;

  for (const index of fillOrder) {
    if (remaining > 0 && (groups[index]?.length ?? 0) > 0) {
      allocation[index] = 1;
      remaining -= 1;
    }
  }

  for (const index of fillOrder) {
    const available = (groups[index]?.length ?? 0) - (allocation[index] ?? 0);
    const granted = Math.min(Math.max(available, 0), remaining);

    allocation[index] = (allocation[index] ?? 0) + granted;
    remaining -= granted;
  }

  const shown = groups.flatMap((group, index) => group.slice(0, allocation[index] ?? 0));
  const hidden = groups.flatMap((group, index) => group.slice(allocation[index] ?? 0));
  const overflowStatus: ProgressStatus = hidden.some((row) => row.status === 'failed')
    ? 'failed'
    : 'done';
  const overflow = makeRow(
    stage,
    overflowStatus,
    `+${String(hidden.length)} more`,
    joinBounded(
      hidden.map((row) => row.message),
      DETAIL_LIST_SEPARATOR,
      MAX_DETAIL_TEXT_LENGTH,
    ),
  );

  return Object.freeze([...shown, overflow]);
}

// ---------------------------------------------------------------------------
// Section E — the investigation rows (pure)
// ---------------------------------------------------------------------------

/**
 * Indexes the investigation's relevant files by symbol, keeping the first file
 * listed for a symbol so the origin a row shows is deterministic.
 */
function indexOriginsBySymbol(
  relevantFiles: readonly RelevantFile[] | undefined,
): Map<string, string> {
  const origins = new Map<string, string>();

  for (const relevant of relevantFiles ?? []) {
    const symbol = toDisplayText(relevant.symbol, MAX_FINDING_TEXT_LENGTH);
    const file = toDisplayPath(relevant.file);

    if (symbol.length > 0 && file.length > 0 && !origins.has(symbol)) {
      origins.set(symbol, file);
    }
  }

  return origins;
}

/**
 * Resolves one finding class to its findings.
 *
 * An explicit array is authoritative, including an empty one. Without it the
 * class is derived from the Stage-1 entities whose kind maps to it through
 * {@link ENTITY_KIND_FINDING_CLASS} — and only from **anchored** ones: an
 * entity names what the question points at, so it counts as something the run
 * *found* only when it has a file of its own or when the investigation's
 * relevant files resolved its name. An entity that is merely named in the
 * question produces no row.
 *
 * The origin is the relevant file resolved for the name, falling back to the
 * entity's own file.
 */
function resolveFindings(
  findingClass: FindingClass,
  explicit: readonly string[] | undefined,
  entities: readonly ProblemEntity[] | undefined,
  origins: ReadonlyMap<string, string>,
): Finding[] {
  if (explicit !== undefined) {
    return uniqueDisplayNames(explicit).map((name) => withOrigin(name, origins.get(name)));
  }

  const seen = new Set<string>();
  const findings: Finding[] = [];

  for (const entity of entities ?? []) {
    const kind: ProblemEntityKind = entity.kind;

    if (!Object.hasOwn(ENTITY_KIND_FINDING_CLASS, kind)) {
      continue;
    }

    if (ENTITY_KIND_FINDING_CLASS[kind] !== findingClass) {
      continue;
    }

    const name = toDisplayText(entity.name, MAX_FINDING_TEXT_LENGTH);
    const file = origins.get(name) ?? toDisplayPath(entity.file);

    if (name.length === 0 || file.length === 0 || seen.has(name)) {
      continue;
    }

    seen.add(name);
    findings.push({ name, file });
  }

  return findings;
}

/** A finding, with its origin file only when one is known. */
function withOrigin(name: string, file: string | undefined): Finding {
  return file === undefined || file.length === 0 ? { name } : { name, file };
}

/**
 * The single database row: emitted only when at least one call site exists,
 * with a detail listing the call sites that are in callee form and the origin
 * file of the first one that has one. A site that is not in callee form is
 * counted, never printed.
 */
function databaseRows(findings: readonly Finding[]): ProgressRow[] {
  if (findings.length === 0) {
    return [];
  }

  const printable = findings
    .map((finding) => finding.name)
    .filter((name) => CALL_SITE_PATTERN.test(name));
  const origin = findings.find((finding) => finding.file !== undefined)?.file;
  const parts: string[] = [];

  if (printable.length > 0) {
    parts.push(
      joinBounded(
        printable,
        DETAIL_LIST_SEPARATOR,
        MAX_DETAIL_TEXT_LENGTH / 2,
        findings.length - printable.length,
      ),
    );
  } else if (findings.length > 1) {
    parts.push(`${String(findings.length)} call sites`);
  }

  if (origin !== undefined) {
    parts.push(origin);
  }

  return [
    makeRow('investigate', 'done', DATABASE_DEPENDENCY_MESSAGE, parts.join(DETAIL_PART_SEPARATOR)),
  ];
}

/**
 * Builds the investigation stage's finding rows from what the investigation
 * actually found.
 *
 * - one `` `Found ${name}` `` row per component found;
 * - one `` `Traced ${symbol}` `` row per event handler traced — the symbol
 *   rather than a generic phrase, so the row is evidence;
 * - one `` `Found ${routePath}` `` row per API route resolved;
 * - one "Found database dependency" row when at least one call site was found.
 *
 * Each row's `detail` is the finding's origin file when one is known (a
 * project-relative path the editor can open). A class with no finding emits no
 * row, and an empty input returns an empty array. Output is bounded by
 * {@link MAX_FINDING_ROWS_PER_STAGE}, follows input order within each class,
 * and is identical for identical input. All rows belong to the `investigate`
 * stage and are `done`.
 *
 * Pure, synchronous and I/O-free: no store, no transport, no clock, no logger.
 *
 * @param findings What the investigation found.
 * @returns The rows, frozen, in display order.
 *
 * @example
 * ```ts
 * buildInvestigationRows({ components: [name], routes: [] });
 * // → [{ stage: 'investigate', status: 'done', message: `Found ${name}` }]
 * buildInvestigationRows({});
 * // → []
 * ```
 */
export function buildInvestigationRows(findings: InvestigationFindings): readonly ProgressRow[] {
  const origins = indexOriginsBySymbol(findings.relevantFiles);
  const entities = findings.entities;

  const components = resolveFindings('components', findings.components, entities, origins);
  const handlers = resolveFindings('eventHandlers', findings.eventHandlers, entities, origins);
  const routes = resolveFindings('routes', findings.routes, entities, origins);
  const database = resolveFindings(
    'databaseDependencies',
    findings.databaseDependencies,
    entities,
    origins,
  );

  const groups: readonly (readonly ProgressRow[])[] = [
    components.map((finding) =>
      makeRow('investigate', 'done', `Found ${finding.name}`, finding.file),
    ),
    handlers.map((finding) =>
      makeRow('investigate', 'done', `Traced ${finding.name}`, finding.file),
    ),
    routes.map((finding) => makeRow('investigate', 'done', `Found ${finding.name}`, finding.file)),
    databaseRows(database),
  ];

  return boundStageRows(
    'investigate',
    groups,
    groups.map((_group, index) => index),
  );
}

// ---------------------------------------------------------------------------
// Section F — the instrumentation rows (pure)
// ---------------------------------------------------------------------------

/** The label vocabulary widened to `string`, for membership tests only. */
const LABEL_VALUES: readonly string[] = INSTRUMENTATION_ROW_ORDER;

/** Whether a string is exactly one of {@link CAPTURE_SIGNAL_LABELS}' labels. */
function isCaptureSignalLabel(value: string): value is CaptureSignalLabel {
  return LABEL_VALUES.includes(value);
}

/**
 * The signals behind each label, derived from {@link CAPTURE_SIGNAL_LABELS}
 * over the imported `CAPTURE_SIGNALS`, so a label armed by name can be
 * withdrawn when every signal it stands for is unavailable.
 */
const SIGNALS_BY_LABEL: ReadonlyMap<CaptureSignalLabel, readonly CaptureSignal[]> = new Map(
  INSTRUMENTATION_ROW_ORDER.map((label) => [
    label,
    Object.freeze(CAPTURE_SIGNALS.filter((signal) => CAPTURE_SIGNAL_LABELS[signal] === label)),
  ]),
);

/**
 * The signals the installer actually enabled, read from every source that can
 * say so: the explicit list, the page-agent hook flags, the dev-server signal
 * set (a non-empty `functions` list is what enables function timing) and any
 * runtime hook named exactly by its signal. Runtime hooks named exactly by a
 * label are returned separately, because a label may stand for several signals
 * and choosing one would be a guess.
 */
function collectEnabled(installed: InstalledSignals): {
  readonly signals: ReadonlySet<CaptureSignal>;
  readonly labels: ReadonlySet<CaptureSignalLabel>;
} {
  const signals = new Set<CaptureSignal>();
  const labels = new Set<CaptureSignalLabel>();

  for (const signal of installed.signals ?? []) {
    if (isCaptureSignal(signal)) {
      signals.add(signal);
    }
  }

  const hooks = installed.hooks;

  if (hooks !== undefined) {
    for (const key of AGENT_HOOK_KEYS) {
      if (hooks[key] === true) {
        signals.add(key);
      }
    }
  }

  const serverSignals = installed.serverSignals;

  if (serverSignals !== undefined) {
    for (const key of SERVER_AGENT_SIGNAL_KEYS) {
      const value = serverSignals[key];

      if (value === true || (Array.isArray(value) && value.length > 0)) {
        signals.add(key);
      }
    }
  }

  for (const hook of installed.runtimeHooks ?? []) {
    if (isCaptureSignal(hook)) {
      signals.add(hook);
    } else if (isCaptureSignalLabel(hook)) {
      labels.add(hook);
    }
  }

  return { signals, labels };
}

/**
 * The display label of a signal named by an unavailable report: its label
 * when it is one of the twelve known signals, otherwise the reported name
 * itself (a third-party adapter's own signal), normalised.
 */
function labelForReportedSignal(signal: unknown): string {
  return isCaptureSignal(signal)
    ? CAPTURE_SIGNAL_LABELS[signal]
    : toDisplayText(signal, MAX_FINDING_TEXT_LENGTH);
}

/**
 * The AAP §0.5.5 failure row: `` `Could not enable ${label}: ${reason}.` ``,
 * with the adapter's hint as the detail. A reason that is blank after
 * normalisation leaves the sentence at `` `Could not enable ${label}.` ``; an
 * entry that does not even name its signal yields no row, since its failure
 * still reaches both user interfaces through `instrumentation.ready`.
 */
function unavailableRow(signal: unknown, reason: unknown, hint: unknown): ProgressRow | undefined {
  const label = labelForReportedSignal(signal);

  if (label.length === 0) {
    return undefined;
  }

  const because = toDisplayText(reason, READINESS_REASON_MAX_LENGTH).replace(
    TRAILING_PUNCTUATION_PATTERN,
    '',
  );
  const message =
    because.length === 0 ? `Could not enable ${label}.` : `Could not enable ${label}: ${because}.`;

  return makeRow('instrument', 'failed', message, toDisplayText(hint, READINESS_HINT_MAX_LENGTH));
}

/**
 * Builds the instrumentation stage's rows from what the installer actually
 * armed and what it could not.
 *
 * - **✓ rows** — one `done` row per enabled signal, mapped through
 *   {@link CAPTURE_SIGNAL_LABELS}, de-duplicated by label and ordered by
 *   {@link INSTRUMENTATION_ROW_ORDER}. Enablement is read from
 *   `signals`/`hooks`/`serverSignals`/`runtimeHooks` and never assumed. A
 *   signal reported unavailable — by an `unavailable` entry or by an
 *   `unavailable` readiness row — is withdrawn, so a ✓ is never shown beside
 *   its own ✗; a `degraded` readiness row keeps the ✓ and puts its reason in
 *   the detail.
 * - **✗ rows** — one `failed` row per `unavailable` entry, in input order, as
 *   AAP §0.5.5 words it (`` `Could not enable ${label}: ${reason}.` ``, the
 *   hint as detail), plus one per `unavailable` readiness row whose signal no
 *   entry already reported. Byte-identical rows are collapsed onto the first.
 *
 * When nothing at all could be enabled there are no ✓ rows; the caller
 * (`src/instrumentation/service.ts`) raises `instrumentation.failed`. Output is
 * bounded by {@link MAX_FINDING_ROWS_PER_STAGE} with failures granted spare
 * slots before successes, and is identical for identical input. All rows
 * belong to the `instrument` stage. The closing "Ready to capture" row is not
 * built here: it is emitted once readiness is satisfied, by
 * {@link SessionProgress.readyToCapture}.
 *
 * Pure, synchronous and I/O-free: no store, no transport, no clock, no logger.
 *
 * @param installed What the installer armed, and what it could not.
 * @returns The rows, frozen: ✓ rows first, then ✗ rows.
 */
export function buildInstrumentationRows(installed: InstalledSignals): readonly ProgressRow[] {
  const readinessRows = installed.readiness?.signals ?? [];
  const unavailable = installed.unavailable ?? [];

  const withdrawn = new Set<string>();

  for (const entry of unavailable) {
    withdrawn.add(entry.signal);
  }

  for (const row of readinessRows) {
    if (row.status === 'unavailable') {
      withdrawn.add(row.signal);
    }
  }

  const enabled = collectEnabled(installed);
  const enabledLabels = new Set<CaptureSignalLabel>();

  for (const signal of CAPTURE_SIGNALS) {
    if (enabled.signals.has(signal) && !withdrawn.has(signal)) {
      enabledLabels.add(CAPTURE_SIGNAL_LABELS[signal]);
    }
  }

  for (const label of enabled.labels) {
    if ((SIGNALS_BY_LABEL.get(label) ?? []).some((signal) => !withdrawn.has(signal))) {
      enabledLabels.add(label);
    }
  }

  const degradedReasons = new Map<CaptureSignalLabel, string>();

  for (const row of readinessRows) {
    const label = CAPTURE_SIGNAL_LABELS[row.signal];
    const reason = toDisplayText(row.reason, READINESS_REASON_MAX_LENGTH);

    if (
      row.status === 'degraded' &&
      enabledLabels.has(label) &&
      reason.length > 0 &&
      !degradedReasons.has(label)
    ) {
      degradedReasons.set(label, `Partially available: ${reason}`);
    }
  }

  const enabledRows = INSTRUMENTATION_ROW_ORDER.filter((label) => enabledLabels.has(label)).map(
    (label) => makeRow('instrument', 'done', label, degradedReasons.get(label)),
  );

  const failedRows: ProgressRow[] = [];
  const seenFailures = new Set<string>();
  const reported = new Set<string>();

  const pushFailure = (row: ProgressRow | undefined): void => {
    if (row === undefined) {
      return;
    }

    const key = `${row.message}\n${row.detail ?? ''}`;

    if (!seenFailures.has(key)) {
      seenFailures.add(key);
      failedRows.push(row);
    }
  };

  for (const entry of unavailable) {
    reported.add(entry.signal);
    pushFailure(unavailableRow(entry.signal, entry.reason, entry.hint));
  }

  for (const row of readinessRows) {
    if (row.status === 'unavailable' && !reported.has(row.signal)) {
      reported.add(row.signal);
      pushFailure(unavailableRow(row.signal, row.reason, row.hint));
    }
  }

  return boundStageRows('instrument', [enabledRows, failedRows], [1, 0]);
}

// ---------------------------------------------------------------------------
// Section G — the emitter
// ---------------------------------------------------------------------------

/**
 * The one transport capability this module needs: deliver a finished frame to
 * the clients of a session whose kind is listed.
 *
 * Deliberately the narrowest port that works. It is satisfied structurally by
 * the session manager's `SessionBroadcaster` (`./manager.ts`) and by the client
 * registry behind it (`apps/local-service/src/server/clients.ts`), neither of
 * which this module imports: the manager depends on this module — it applies
 * `stageFailed` as part of every transition into `failed` — so importing it back
 * would close a cycle, and the server layer sits above this folder. Declaring
 * the single method here is what keeps both edges pointing one way.
 */
export interface ProgressBroadcaster {
  /**
   * Sends `message` to every connected client of `sessionId` whose kind is in
   * `kinds`. Delivery is best effort and synchronous; a client that is offline
   * simply misses the frame and recovers it through the persisted replay.
   */
  broadcastToKinds(
    sessionId: SessionId,
    kinds: readonly ClientKind[],
    message: ProtocolMessage,
  ): void;
}

/** Everything {@link createSessionProgress} is given; all of it is injected. */
export interface SessionProgressDeps {
  /** The session store's progress log — the only store method this module calls. */
  readonly sessions: Pick<SessionsRepo, 'appendProgress'>;
  /** Where finished `session.progress` frames go. */
  readonly broadcaster: ProgressBroadcaster;
  /** The service logger; defaults to `noopLogger`. Bound to `subsystem: "sessions"`. */
  readonly logger?: Logger;
  /** The clock rows and frames are stamped with; defaults to `nowEpochMs`. */
  readonly now?: () => number;
}

/**
 * The progress emitter of one service process.
 *
 * Every method validates, persists and broadcasts, and answers with a
 * `Result` — none throws. The asymmetry between the two failure kinds is
 * deliberate:
 *
 * - **A row the protocol schema rejects is a product bug** and returns `Err`:
 *   it is neither persisted nor broadcast, and it is logged at `error` with the
 *   issue paths only, never the rejected value.
 * - **A row the store cannot persist, or the transport cannot deliver, is a
 *   degraded success**: progress is advisory, so the failure is logged at `warn`
 *   and the method still returns `ok`. Persistence precedes the broadcast, so
 *   a replayed session is never missing a row a client already saw; a
 *   persistence failure does not withhold the live row either.
 *
 * None of these methods changes a session's status (see the module overview).
 */
export interface SessionProgress {
  /**
   * The core: addresses `row` to `sessionId`, validates it against protocol's
   * `session.progress` schema, appends it to the session's progress log and
   * broadcasts it to the session's editor and DevTools clients.
   *
   * @returns The payload as sent, or `Err` when the schema rejected it.
   */
  emit(sessionId: SessionId, row: ProgressRow): Result<SessionProgressPayload, DebuggenError>;

  /**
   * A stage's group header: a `running` row whose message defaults to the
   * stage's title in {@link PROGRESS_STAGE_TITLES}.
   */
  stageStarted(
    sessionId: SessionId,
    stage: ProgressStage,
    message?: string,
  ): Result<SessionProgressPayload, DebuggenError>;

  /**
   * A stage's closing `done` row; the message defaults to the stage's title, so
   * a stage that found nothing worth a row of its own still closes its group.
   */
  stageCompleted(
    sessionId: SessionId,
    stage: ProgressStage,
    message?: string,
  ): Result<SessionProgressPayload, DebuggenError>;

  /**
   * The `failed` row of the failing stage: its stage, its message, and its hint
   * with its error code as the detail.
   *
   * This row is how the failing stage reaches both user interfaces: protocol's
   * `SessionRecord` has no failure field, so the persisted `failed` progress row,
   * together with the `error` / `instrumentation.failed` message the caller
   * sends, is the carrier (AAP §0.5.5). `./manager.ts` emits it as part of every
   * transition into `failed`.
   */
  stageFailed(
    sessionId: SessionId,
    failure: SessionFailure,
  ): Result<SessionProgressPayload, DebuggenError>;

  /** One `done` finding row, composed by the caller from what it found. */
  finding(
    sessionId: SessionId,
    stage: ProgressStage,
    message: string,
    detail?: string,
  ): Result<SessionProgressPayload, DebuggenError>;

  /**
   * Emits {@link buildInvestigationRows}' rows in order.
   *
   * @returns Every payload sent, or the first `Err` when any row was rejected —
   * the other rows are still emitted.
   */
  reportInvestigation(
    sessionId: SessionId,
    findings: InvestigationFindings,
  ): Result<readonly SessionProgressPayload[], DebuggenError>;

  /**
   * Emits {@link buildInstrumentationRows}' rows in order.
   *
   * @returns Every payload sent, or the first `Err` when any row was rejected —
   * the other rows are still emitted.
   */
  reportInstrumentation(
    sessionId: SessionId,
    installed: InstalledSignals,
  ): Result<readonly SessionProgressPayload[], DebuggenError>;

  /**
   * The instrumentation stage's closing `done` row,
   * {@link READY_TO_CAPTURE_MESSAGE}. Emitted once readiness is satisfied.
   */
  readyToCapture(sessionId: SessionId): Result<SessionProgressPayload, DebuggenError>;
}

/**
 * The first line of a stage's header or closing row: the caller's message as
 * one line of display text when given, otherwise the stage's title. A message
 * that normalises to nothing stays empty and is refused by the schema, which is
 * the right answer to a caller that passed a blank line.
 */
function stageLine(stage: ProgressStage, message: string | undefined): string {
  return message === undefined
    ? PROGRESS_STAGE_TITLES[stage]
    : toDisplayText(message, MAX_MESSAGE_TEXT_LENGTH);
}

/**
 * The detail of a stage-failure row: the developer's next step first, then the
 * error code a report or a log search can be matched on.
 */
function failureDetail(failure: SessionFailure): string {
  const hint = toDisplayText(failure.hint, MAX_DETAIL_TEXT_LENGTH);
  const code = toDisplayText(failure.code, MAX_FINDING_TEXT_LENGTH);

  if (code.length === 0) {
    return hint;
  }

  return hint.length === 0 ? `Error code: ${code}` : `${hint} (error code: ${code})`;
}

/**
 * Creates the progress emitter.
 *
 * @param deps The store, the broadcaster, and optionally a logger and a clock.
 * @returns The emitter; it holds no state beyond its dependencies.
 *
 * @example
 * ```ts
 * const progress = createSessionProgress({ sessions, broadcaster: clients, logger });
 *
 * progress.stageStarted(sessionId, 'investigate');
 * progress.reportInvestigation(sessionId, { components, eventHandlers, routes, relevantFiles });
 * progress.stageCompleted(sessionId, 'investigate');
 * ```
 */
export function createSessionProgress(deps: SessionProgressDeps): SessionProgress {
  const { sessions, broadcaster } = deps;
  const clock = deps.now ?? nowEpochMs;
  const log = subsystemLogger(deps.logger ?? noopLogger, LOG_SUBSYSTEM);

  /**
   * One timestamp per row, shared by the stored line and the frame so a replay
   * carries the same time a live client saw. A clock that throws or answers
   * something other than a positive finite number is replaced by the wall
   * clock rather than allowed to fail the row.
   */
  function stamp(): number {
    try {
      const value = clock();

      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    } catch {
      // Fall through to the wall clock: an injected clock is a test seam, and
      // its failure must not cost the developer a progress row.
    }

    return nowEpochMs();
  }

  function emit(
    sessionId: SessionId,
    row: ProgressRow,
  ): Result<SessionProgressPayload, DebuggenError> {
    const candidate =
      row.detail === undefined
        ? { sessionId, stage: row.stage, status: row.status, message: row.message }
        : {
            sessionId,
            stage: row.stage,
            status: row.status,
            message: row.message,
            detail: row.detail,
          };

    const parsed = parseSessionProgressPayload(candidate);

    if (!parsed.ok) {
      log.error('a progress row was rejected by the session.progress schema and was not sent', {
        [LOG_BINDING_KEYS.sessionId]: sessionId,
        code: parsed.error.code,
        issues: parsed.error.details,
      });

      return parsed;
    }

    const payload = parsed.value;
    const ts = stamp();
    const fields = {
      [LOG_BINDING_KEYS.sessionId]: payload.sessionId,
      stage: payload.stage,
      status: payload.status,
    };

    const stored = sessions.appendProgress(
      payload.detail === undefined
        ? {
            sessionId: payload.sessionId,
            stage: payload.stage,
            status: payload.status,
            message: payload.message,
            ts,
          }
        : {
            sessionId: payload.sessionId,
            stage: payload.stage,
            status: payload.status,
            message: payload.message,
            detail: payload.detail,
            ts,
          },
    );

    if (!stored.ok) {
      log.warn('a progress row could not be persisted; it is broadcast but will not replay', {
        ...fields,
        code: stored.error.code,
      });
    }

    try {
      broadcaster.broadcastToKinds(
        payload.sessionId,
        PROGRESS_RECIPIENT_KINDS,
        createEnvelope('session.progress', payload, { ts }),
      );
    } catch (thrown) {
      log.warn('a progress row could not be broadcast; connected clients will see it on replay', {
        ...fields,
        code: DebuggenError.from(thrown, 'TRANSPORT_DISCONNECTED').code,
      });
    }

    log.debug('progress row sent', fields);

    return ok(payload);
  }

  function emitAll(
    sessionId: SessionId,
    rows: readonly ProgressRow[],
  ): Result<readonly SessionProgressPayload[], DebuggenError> {
    const payloads: SessionProgressPayload[] = [];
    let firstError: DebuggenError | undefined;

    for (const row of rows) {
      const sent = emit(sessionId, row);

      if (sent.ok) {
        payloads.push(sent.value);
      } else {
        firstError ??= sent.error;
      }
    }

    return firstError === undefined ? ok(Object.freeze(payloads)) : err(firstError);
  }

  return Object.freeze({
    emit,

    stageStarted(sessionId: SessionId, stage: ProgressStage, message?: string) {
      return emit(sessionId, makeRow(stage, 'running', stageLine(stage, message)));
    },

    stageCompleted(sessionId: SessionId, stage: ProgressStage, message?: string) {
      return emit(sessionId, makeRow(stage, 'done', stageLine(stage, message)));
    },

    stageFailed(sessionId: SessionId, failure: SessionFailure) {
      const stated = toDisplayText(failure.message, MAX_MESSAGE_TEXT_LENGTH);
      const message = stated.length > 0 ? stated : `${PROGRESS_STAGE_TITLES[failure.stage]} failed`;

      return emit(sessionId, makeRow(failure.stage, 'failed', message, failureDetail(failure)));
    },

    finding(sessionId: SessionId, stage: ProgressStage, message: string, detail?: string) {
      return emit(
        sessionId,
        makeRow(
          stage,
          'done',
          toDisplayText(message, MAX_MESSAGE_TEXT_LENGTH),
          detail === undefined ? undefined : toDisplayText(detail, MAX_DETAIL_TEXT_LENGTH),
        ),
      );
    },

    reportInvestigation(sessionId: SessionId, findings: InvestigationFindings) {
      return emitAll(sessionId, buildInvestigationRows(findings));
    },

    reportInstrumentation(sessionId: SessionId, installed: InstalledSignals) {
      return emitAll(sessionId, buildInstrumentationRows(installed));
    },

    readyToCapture(sessionId: SessionId) {
      return emit(sessionId, makeRow('instrument', 'done', READY_TO_CAPTURE_MESSAGE));
    },
  } satisfies SessionProgress);
}
