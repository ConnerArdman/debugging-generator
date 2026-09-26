/**
 * The Sessions tree: the `debuggen.sessions` view of the Debug Generator
 * activity-bar container (AAP §0.7.1 Group 3, §0.7.3).
 *
 * It lists the stored debugging sessions that `GET /sessions` returns, grouped
 * by project and then by the local calendar day each session was created on,
 * and selecting a session runs `debuggen.reopenSession` with its id. That
 * command fetches the record with `GET /sessions/:id` and the service replays
 * `session.updated` and the latest `panel.generated` to every connected client
 * (AAP §0.4.2), which is how "selecting one reopens it in both surfaces" holds.
 * This module never contacts Chrome, the DevTools panel or the socket.
 *
 * ```text
 * Sessions
 * ├─ web-client                        2 sessions
 * │  └─ Fri, Sep 25, 2026              2 sessions
 * │     ├─ ✓ ‹question, one line›      generated
 * │     └─ ● ‹question, one line›      capturing
 * └─ admin-portal                      1 session
 * ```
 *
 * ## Fetch and project, nothing more
 *
 * - **The store is `ExtensionState`.** A successful `GET /sessions` is written
 *   into {@link ExtensionState.setSessionList}; every render reads
 *   {@link ExtensionState.sessionList}. This provider keeps no session array of
 *   its own, only the view nodes it rebuilds from the store on demand, so the
 *   tree and the webview can never disagree about what the service said.
 * - **The transport is `ServiceClient`.** `listSessions()` resolves to a
 *   `Result` and never rejects, so failures are branched on, not caught. A
 *   failure keeps its code, message and hint for display and logs its code
 *   only (AAP §0.5.2).
 * - **Rows, not records, and every page of them.** `GET /sessions` answers one
 *   page of `SessionListItem` rows — the fields a row renders and a diff-free
 *   cleanup summary, most recently updated first — with the listing's `total`
 *   and the `nextOffset` of the following page. One load walks the listing in
 *   bounded requests of {@link SESSION_LIST_MAX_LIMIT} rows, from offset `0`
 *   along `nextOffset` until it is `null`, so every stored session is listed
 *   and selecting any of them reopens it (AAP §0.7.3). A row that two pages
 *   both carry — the listing shifts when a session is created or updated
 *   between two requests — is kept once, as the earlier page served it. The
 *   gathered rows and the last page's `total` are written to the store once,
 *   when the walk ends, so the views render one coherent list rather than a
 *   list that grows page by page.
 * - **Bounded, and honest when bounded.** A load requests at most
 *   {@link SESSION_LIST_PAGE_CAP} pages. When that cap stops the walk, or a page
 *   after the first fails, the rows gathered so far are kept and the tree ends
 *   with one informational row that says how many sessions it does not list
 *   and why, so a shortened list is never presented as the whole one.
 * - **Every label is data.** Labels, descriptions and tooltips are derived from
 *   list-row fields and the listing's `total`; nothing inspects what a
 *   question means, nothing is seeded or canned, and the question is only
 *   whitespace-collapsed and truncated for display (AAP §0.5.4).
 *
 * ## When the tree fetches — and the loop it must never enter
 *
 * `setSessionList` raises `ExtensionState.onDidChange`, and this provider
 * answers that event by firing `onDidChangeTreeData`, which makes VS Code call
 * {@link SessionsTreeProvider.getChildren} again. If that handler — or the
 * render it triggers — fetched unconditionally, every fetch would schedule the
 * next one. Three rules keep the cycle finite:
 *
 * 1. The `onDidChange` handler only fires `onDidChangeTreeData`. It never
 *    fetches.
 * 2. The root render fetches only when a fetch is *warranted*: the list has
 *    never loaded; the last attempt failed and either the service's
 *    reachability changed since then or {@link RETRY_INTERVAL_MS} has passed;
 *    or the active session is missing from the list and has not been fetched
 *    for yet (`applySessionRecord` refreshes listed sessions but never adds one,
 *    so a newly created session appears only through this fetch).
 * 3. A load whose first page fails writes nothing to the store and fires
 *    nothing, so it cannot re-enter the render that started it. A load whose
 *    later page fails writes the rows it gathered once and records the
 *    failure, so the next render is governed by the retry rule of 2 — never
 *    by the write itself.
 *
 * Traced: `getChildren → load → setSessionList → onDidChange →
 * onDidChangeTreeData → getChildren`, and the second render finds the list
 * loaded and the active session listed, so it fetches nothing.
 *
 * Loads are single-flight: concurrent renders share one walk of the listing,
 * every page of it. An explicit {@link SessionsTreeProvider.refresh} issued
 * while a walk is in flight queues exactly one follow-up walk, because the
 * in-flight answer may predate the change the caller is refreshing for (a
 * purge, say); any number of refreshes during that window share the same
 * follow-up. Disposing the provider aborts the page request in flight through
 * the provider's lifetime signal, stops the walk and writes nothing.
 *
 * ## States that are rendered, never thrown (AAP §0.5.5)
 *
 * The root always renders something: while the first request is in flight the
 * render awaits it (VS Code shows the view's progress bar), an unreachable
 * service is a row whose click runs `debuggen.startService`, an invalid service
 * URL is a row that opens that setting, an empty store is a row inviting a
 * question, and an unexpected error is caught, logged by code and rendered as a
 * row. A list that loaded once stays visible beneath a later failure row. The
 * "sessions not listed" row appears only when the page cap stopped a walk or a
 * page after the first failed; it states which, and has no command of its own.
 * After a failed page the failure row above it carries the recovery action and
 * the view retries by itself under the rule of 2; after the cap there is
 * nothing to retry, because the next load would stop at the same cap.
 *
 * ## Module conventions
 *
 * Extension-host code: ESM authoring with extensionless relative imports,
 * bundled to CommonJS by `esbuild.mjs` (no top-level `await`), Node and
 * `vscode` types only (no DOM). Icons are built-in codicons through
 * `vscode.ThemeIcon`, the editor's own theming; this native view renders no
 * design-system token and imports no renderer package.
 *
 * @example
 * ```ts
 * const sessionsTree = new SessionsTreeProvider({ state, client, logger });
 * context.subscriptions.push(
 *   sessionsTree,
 *   vscode.window.createTreeView(SESSIONS_VIEW_ID, { treeDataProvider: sessionsTree }),
 * );
 * // …or register it in one step:
 * const { provider, disposable } = SessionsTreeProvider.register({ state, client, logger });
 * context.subscriptions.push(disposable);
 * await provider.refresh();
 * ```
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';

import { SESSION_LIST_MAX_LIMIT } from '@debuggen/protocol';
import type { SessionListItem, SessionStatus } from '@debuggen/protocol';
import { DebuggenError, assertNever, isErr } from '@debuggen/shared';
import type { DebuggenErrorCode, Logger } from '@debuggen/shared';

import type { ServiceClient } from '../service/client';
import type { ExtensionState } from '../state';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * The tree view id, exactly as `package.json` contributes it under
 * `contributes.views.debuggen`. `test/suite/activation.test.ts` checks it
 * against the manifest; a mismatch yields a permanently empty view.
 */
export const SESSIONS_VIEW_ID = 'debuggen.sessions';

/**
 * The `contextValue` of every session row, so a `view/item/context` menu can
 * target session rows alone (`viewItem == debuggen.session`) and never a
 * project, day or message row. `package.json`'s inline reopen action uses it.
 */
export const SESSION_CONTEXT_VALUE = 'debuggen.session';

/** The longest session label, in code points, including the trailing ellipsis. */
export const MAX_SESSION_LABEL_LENGTH = 80;

/**
 * The shortest pause between two automatic retries after a failed fetch,
 * unless the service's reachability changed in between (then the retry is
 * immediate). Bounds the requests a view makes while the service is down.
 */
export const RETRY_INTERVAL_MS = 2_000;

/**
 * The most `GET /sessions` pages one load of the tree requests: 20 pages of
 * {@link SESSION_LIST_MAX_LIMIT} (500) rows, so up to 10 000 sessions.
 *
 * A load follows `nextOffset` to the end of the listing, and the protocol's
 * page validation guarantees each `nextOffset` advances, so a walk always
 * ends; the cap bounds what one load may cost — requests, rows held, and the
 * time the first render waits — against a store far larger than the product
 * produces. At the default 30-day retention (`DEBUGGEN_RETENTION_DAYS`),
 * 10 000 sessions is more than 300 a day, every day. A walk the cap stops keeps
 * the 10 000 most recently updated rows, and the tree's "not listed" row states
 * how many older sessions it leaves out and why.
 */
export const SESSION_LIST_PAGE_CAP = 20;

// ---------------------------------------------------------------------------
// Module constants (immutable)
// ---------------------------------------------------------------------------

/** Contributed by `package.json`; the session row's click action. */
const REOPEN_SESSION_COMMAND = 'debuggen.reopenSession';

/** Contributed by `package.json`; the unreachable-service row's click action. */
const START_SERVICE_COMMAND = 'debuggen.startService';

/**
 * Generated by VS Code for the contributed `debuggen.session` webview view
 * (`<viewId>.focus`); the empty-state row's click action. Written here rather
 * than imported from `../commands`, which imports this module.
 */
const SESSION_VIEW_FOCUS_COMMAND = 'debuggen.session.focus';

/** Built-in command that opens the Settings editor filtered to its argument. */
const OPEN_SETTINGS_COMMAND = 'workbench.action.openSettings';

/** The setting an invalid-service-URL failure points the developer to. */
const SERVICE_URL_SETTING = 'debuggen.serviceUrl';

/**
 * The bound on one `GET /sessions` page request. The route is an indexed store
 * read, so anything slower is a hung service; without a bound the first render
 * would never end. A page that times out fails like any other page.
 */
const LIST_TIMEOUT_MS = 10_000;

/** The longest question excerpt a session row's tooltip shows, in code points. */
const MAX_TOOLTIP_QUESTION_LENGTH = 600;

/** The label of a session whose question is blank once whitespace is collapsed. */
const UNTITLED_SESSION_LABEL = 'Untitled session';

/** Runs of whitespace and control characters, collapsed to one space for a single row. */
const WHITESPACE_RUN = /[\s\p{Cc}]+/gu;

/** The day key of a timestamp that is not a finite number; sorts after every real day. */
const UNKNOWN_DAY_KEY = '0000-00-00';

/** How a row states the time a session was created or updated. */
const TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = Object.freeze({
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** How a day row names its day. */
const DAY_FORMAT: Intl.DateTimeFormatOptions = Object.freeze({
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The session fields the tree renders: the protocol's `GET /sessions` row,
 * re-exported under the name this module has always exported it by.
 *
 * The protocol's type rather than a local projection, so the row the service
 * sends, the row `ExtensionState.sessionList` keeps and the row the pure
 * helpers below read are one definition. A whole `SessionRecord` becomes one
 * through the protocol's `toSessionListItem`. The `debuggen.reopenSession`
 * quick pick passes rows from `ExtensionState.sessionList` straight through.
 */
export type { SessionListItem };

/** Formatting options shared by the pure helpers. */
export interface SessionFormatOptions {
  /**
   * The BCP 47 locale timestamps and names are formatted and collated in.
   * Omitted means the extension host's default locale; an unsupported tag
   * falls back to that default rather than throwing.
   */
  readonly locale?: string | undefined;
}

/** Options for {@link groupSessions}. */
export interface GroupSessionsOptions extends SessionFormatOptions {
  /**
   * The active session's project root. That project sorts first and starts
   * expanded; without one, the project holding the most recently updated
   * session starts expanded instead.
   */
  readonly activeProjectRoot?: string | undefined;
}

/** A project row: one `projectRoot`, holding its sessions grouped by day. */
export interface ProjectNode {
  readonly kind: 'project';
  /** The grouping key: the listed sessions' absolute project root. */
  readonly projectRoot: string;
  /** The label: the `projectName` of the project's most recently updated session. */
  readonly projectName: string;
  /**
   * Whether another listed project's name collates equal to this one (case
   * and accents ignored), so the row also shows its root.
   */
  readonly nameIsAmbiguous: boolean;
  /** Every listed session of the project, most recently updated first. */
  readonly sessions: readonly SessionListItem[];
  /** The project's day rows, newest day first. */
  readonly days: readonly DateNode[];
  /** Whether the row starts expanded; VS Code keeps the developer's choice afterwards. */
  readonly expanded: boolean;
}

/** A day row: the sessions of one project created on one local calendar day. */
export interface DateNode {
  readonly kind: 'date';
  /** The owning project's root. */
  readonly projectRoot: string;
  /** The local calendar day, `YYYY-MM-DD`. */
  readonly dayKey: string;
  /** Local midnight of that day in epoch milliseconds; `NaN` when `createdAt` was not finite. */
  readonly dayStart: number;
  /** The day's sessions: `updatedAt` descending, then `createdAt` descending, then `id`. */
  readonly sessions: readonly SessionListItem[];
  /** Whether the row starts expanded: true for each project's newest day. */
  readonly expanded: boolean;
}

/** A session row. */
export interface SessionNode {
  readonly kind: 'session';
  /**
   * The session's id, at the top level so a command that receives the node
   * itself (the inline `view/item/context` action) can resolve it without
   * knowing the record's shape. The row's click passes the bare id.
   */
  readonly sessionId: string;
  /** The list row the tree item renders. */
  readonly session: SessionListItem;
}

/** Which non-data state a {@link MessageNode} renders. */
export type MessageKey =
  | 'service-unreachable'
  | 'invalid-service-url'
  | 'load-failed'
  | 'empty'
  | 'render-failed'
  | 'sessions-not-listed';

/**
 * A single-row state in place of (or around) the data: offline, empty, failed,
 * or the stored sessions a shortened load leaves out.
 */
export interface MessageNode {
  readonly kind: 'message';
  /** The state this row renders; also its stable tree item id. */
  readonly key: MessageKey;
  readonly label: string;
  readonly description?: string | undefined;
  readonly tooltip?: string | undefined;
  /** A built-in codicon id, rendered through `vscode.ThemeIcon`. */
  readonly icon?: string | undefined;
  /** What a click runs — the recovery action for the state. */
  readonly command?: vscode.Command | undefined;
}

/** Every node of the tree, discriminated on `kind`. */
export type SessionsTreeNode = ProjectNode | DateNode | SessionNode | MessageNode;

/** The part of `ExtensionState` the tree reads and writes. */
export type SessionsTreeState = Pick<
  ExtensionState,
  | 'sessionList'
  | 'sessionListTotal'
  | 'setSessionList'
  | 'onDidChange'
  | 'activeSession'
  | 'connectionStatus'
  | 'serviceReachable'
>;

/** The part of `ServiceClient` the tree calls. */
export type SessionsTreeClient = Pick<ServiceClient, 'listSessions'>;

/**
 * What the provider is constructed with. Injected rather than imported, so the
 * provider holds no module-level singleton and reads no configuration.
 */
export interface SessionsTreeDeps {
  /** The host's single store of server state (`src/state.ts`). */
  readonly state: SessionsTreeState;
  /** The host's service client (`src/service/client.ts`). */
  readonly client: SessionsTreeClient;
  /** Where the provider logs; records carry error codes only. */
  readonly logger: Logger;
  /** The clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** See {@link SessionFormatOptions.locale}. */
  readonly locale?: string | undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers — no editor state, assertable without a live TreeView
// ---------------------------------------------------------------------------

/**
 * A session's question as one tree row: whitespace and control characters
 * collapsed to single spaces, trimmed, and cut at
 * {@link MAX_SESSION_LABEL_LENGTH} code points with an ellipsis.
 *
 * Display normalisation only — the text's content is never inspected
 * (AAP §0.5.4). Truncation counts code points, so a surrogate pair is never
 * split.
 *
 * @example
 * ```ts
 * formatSessionLabel('  Why does\nthis   happen?  '); // 'Why does this happen?'
 * ```
 *
 * @param question The session's question, as typed.
 * @returns The label; `Untitled session` when nothing printable remains.
 */
export function formatSessionLabel(question: string): string {
  const label = collapseText(question, MAX_SESSION_LABEL_LENGTH);
  return label.length === 0 ? UNTITLED_SESSION_LABEL : label;
}

/**
 * A session's metadata for a tooltip, one fact per line: project name,
 * project root, status, created and updated timestamps, and the cleanup
 * status unless it is `clean`.
 *
 * The project root is the developer's own local path, shown on their own
 * machine; this helper transmits nothing.
 *
 * @param session The record, or any projection carrying the rendered fields.
 * @param options The locale timestamps are formatted in.
 * @returns A multi-line string (`\n`-separated).
 */
export function describeSession(
  session: SessionListItem,
  options: SessionFormatOptions = {},
): string {
  const timestamps = createDateTimeFormat(options.locale, TIMESTAMP_FORMAT);
  const lines = [
    `Project: ${session.projectName}`,
    `Location: ${session.projectRoot}`,
    `Status: ${session.status}`,
    `Created: ${formatTimestamp(session.createdAt, timestamps)}`,
    `Updated: ${formatTimestamp(session.updatedAt, timestamps)}`,
  ];
  if (session.cleanup.status !== 'clean') {
    lines.push(`Cleanup: ${describeCleanup(session.cleanup)}`);
  }
  return lines.join('\n');
}

/**
 * A session's metadata on one line — project name, status and last update —
 * for single-line surfaces such as a `QuickPickItem.detail`, where the
 * multi-line {@link describeSession} would not render.
 *
 * @param session The record, or any projection carrying the rendered fields.
 * @param options The locale the timestamp is formatted in.
 * @returns For example `web-client · generated · updated Sep 25, 2026, 10:02 AM`.
 */
export function summarizeSession(
  session: SessionListItem,
  options: SessionFormatOptions = {},
): string {
  const timestamps = createDateTimeFormat(options.locale, TIMESTAMP_FORMAT);
  return [
    session.projectName,
    session.status,
    `updated ${formatTimestamp(session.updatedAt, timestamps)}`,
  ].join(' · ');
}

/**
 * Groups sessions into the tree's project → day → session hierarchy, with a
 * deterministic order so the tree never reshuffles between refreshes.
 *
 * - **Projects** are keyed by `projectRoot` and labelled with the
 *   `projectName` of their most recently updated session. The active
 *   session's project sorts first; the rest sort by name (collated, numeric
 *   aware), then by root.
 * - **Days** are the local calendar day of `createdAt`, newest first.
 * - **Sessions** within a day sort by `updatedAt` descending, then
 *   `createdAt` descending, then `id`.
 * - **Expansion:** each project's newest day starts expanded, as does the
 *   active session's project — or, with no active session, the project holding
 *   the most recently updated session. Everything else starts collapsed.
 *
 * A row listed twice under one id is kept once, in its newest version, so
 * the tree never registers two items with one id.
 *
 * @param sessions The listed session rows, in any order.
 * @param options The active session's project and the collation locale.
 * @returns The project rows; empty when there are no sessions.
 */
export function groupSessions(
  sessions: readonly SessionListItem[],
  options: GroupSessionsOptions = {},
): readonly ProjectNode[] {
  const byProject = new Map<string, SessionListItem[]>();
  for (const session of latestById(sessions)) {
    const listed = byProject.get(session.projectRoot);
    if (listed === undefined) {
      byProject.set(session.projectRoot, [session]);
    } else {
      listed.push(session);
    }
  }

  const drafts: Omit<ProjectNode, 'nameIsAmbiguous' | 'expanded'>[] = [];
  for (const [projectRoot, listed] of byProject) {
    const ordered = [...listed].sort(compareSessions);
    const newest = ordered[0];
    if (newest === undefined) {
      continue;
    }
    drafts.push({
      kind: 'project',
      projectRoot,
      projectName: newest.projectName,
      sessions: ordered,
      days: groupByDay(projectRoot, ordered),
    });
  }

  const collator = createCollator(options.locale);
  const activeRoot = options.activeProjectRoot;
  drafts.sort((a, b) => {
    const activeRank = Number(b.projectRoot === activeRoot) - Number(a.projectRoot === activeRoot);
    return (
      activeRank ||
      collator.compare(a.projectName, b.projectName) ||
      compareCodeUnits(a.projectRoot, b.projectRoot)
    );
  });

  const expandedRoot =
    activeRoot !== undefined && byProject.has(activeRoot)
      ? activeRoot
      : mostRecentlyUpdatedProject(drafts);
  // Ambiguity uses the same collation the order uses, so names that sort as
  // equal ("Web" and "web") both show their roots. Project counts are small,
  // so the pairwise scan costs nothing measurable.
  return drafts.map((draft) => ({
    ...draft,
    nameIsAmbiguous: drafts.some(
      (other) => other !== draft && collator.compare(other.projectName, draft.projectName) === 0,
    ),
    expanded: draft.projectRoot === expandedRoot,
  }));
}

/**
 * Splits one project's already-ordered sessions into day rows, newest day
 * first. Grouping preserves input order, so each day's sessions stay sorted.
 */
function groupByDay(projectRoot: string, ordered: readonly SessionListItem[]): readonly DateNode[] {
  const byDay = new Map<
    string,
    { readonly dayStart: number; readonly sessions: SessionListItem[] }
  >();
  for (const session of ordered) {
    const day = localDayOf(session.createdAt);
    const bucket = byDay.get(day.key);
    if (bucket === undefined) {
      byDay.set(day.key, { dayStart: day.start, sessions: [session] });
    } else {
      bucket.sessions.push(session);
    }
  }
  const dayKeys = [...byDay.keys()].sort((a, b) => compareCodeUnits(b, a));
  const days: DateNode[] = [];
  for (const dayKey of dayKeys) {
    const bucket = byDay.get(dayKey);
    if (bucket === undefined) {
      continue;
    }
    days.push({
      kind: 'date',
      projectRoot,
      dayKey,
      dayStart: bucket.dayStart,
      sessions: bucket.sessions,
      expanded: days.length === 0,
    });
  }
  return days;
}

/**
 * The root of the project holding the most recently updated session; the
 * first project in display order wins a tie.
 */
function mostRecentlyUpdatedProject(
  projects: readonly Pick<ProjectNode, 'projectRoot' | 'sessions'>[],
): string | undefined {
  let chosen: string | undefined;
  let chosenUpdatedAt = Number.NEGATIVE_INFINITY;
  for (const project of projects) {
    const updatedAt = project.sessions[0]?.updatedAt ?? Number.NEGATIVE_INFINITY;
    if (chosen === undefined || updatedAt > chosenUpdatedAt) {
      chosen = project.projectRoot;
      chosenUpdatedAt = updatedAt;
    }
  }
  return chosen;
}

/** Each id once, in its newest version (`updatedAt`; on a tie, the later entry). */
function latestById(sessions: readonly SessionListItem[]): readonly SessionListItem[] {
  const byId = new Map<string, SessionListItem>();
  for (const session of sessions) {
    const held = byId.get(session.id);
    if (held === undefined || session.updatedAt >= held.updatedAt) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()];
}

/** `updatedAt` descending, then `createdAt` descending, then `id` ascending. */
function compareSessions(a: SessionListItem, b: SessionListItem): number {
  return (
    compareNumbersDescending(a.updatedAt, b.updatedAt) ||
    compareNumbersDescending(a.createdAt, b.createdAt) ||
    compareCodeUnits(a.id, b.id)
  );
}

/** Descending numeric order that also orders a non-finite value last. */
function compareNumbersDescending(a: number, b: number): number {
  const aFinite = Number.isFinite(a);
  const bFinite = Number.isFinite(b);
  if (aFinite !== bFinite) {
    return aFinite ? -1 : 1;
  }
  if (!aFinite || a === b) {
    return 0;
  }
  return a > b ? -1 : 1;
}

/** Locale-independent string order: by UTF-16 code unit. */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * The local calendar day of an epoch-millisecond timestamp: its `YYYY-MM-DD`
 * key and its local midnight. Computed from `Date`'s local-time accessors, the
 * same time zone `Intl.DateTimeFormat` formats the day row in.
 */
function localDayOf(epochMs: number): { readonly key: string; readonly start: number } {
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) {
    return { key: UNKNOWN_DAY_KEY, start: Number.NaN };
  }
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const key = [
    String(year).padStart(4, '0'),
    String(month + 1).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
  return { key, start: new Date(year, month, day).getTime() };
}

/**
 * Collapses whitespace and control characters to single spaces, trims, and
 * cuts the result at `maxCodePoints` code points with a trailing ellipsis.
 */
function collapseText(text: string, maxCodePoints: number): string {
  const collapsed = text.replace(WHITESPACE_RUN, ' ').trim();
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= maxCodePoints) {
    return collapsed;
  }
  return `${codePoints
    .slice(0, Math.max(maxCodePoints - 1, 0))
    .join('')
    .trimEnd()}…`;
}

/**
 * A cleanup state in words, with the number of files it refused to overwrite.
 * The row carries that number as `conflictCount`; the conflicts themselves,
 * and their diffs, stay on the whole record.
 */
function describeCleanup(cleanup: SessionListItem['cleanup']): string {
  const conflicts = cleanup.conflictCount;
  if (conflicts === 0) {
    return cleanup.status;
  }
  return `${cleanup.status} (${formatCount(conflicts, 'conflicting file', 'conflicting files')} kept)`;
}

/** `1 session`, `3 sessions`. */
function formatCount(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

/** A timestamp in the given format, or `unknown` when it is not a finite number. */
function formatTimestamp(epochMs: number, format: Intl.DateTimeFormat): string {
  return Number.isFinite(epochMs) ? format.format(epochMs) : 'unknown';
}

/** A day row's label: the weekday and date of its local midnight. */
function formatDay(node: DateNode, locale: string | undefined): string {
  if (node.dayKey === UNKNOWN_DAY_KEY || !Number.isFinite(node.dayStart)) {
    return 'Unknown date';
  }
  return createDateTimeFormat(locale, DAY_FORMAT).format(node.dayStart);
}

/**
 * An `Intl.DateTimeFormat` for `locale`, falling back to the host's default
 * locale when the tag is not one the runtime supports (the constructor throws
 * `RangeError` for a malformed tag).
 */
function createDateTimeFormat(
  locale: string | undefined,
  format: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, format);
  } catch {
    return new Intl.DateTimeFormat(undefined, format);
  }
}

/** A base-sensitivity, numeric-aware collator for `locale`, with the same fallback. */
function createCollator(locale: string | undefined): Intl.Collator {
  const collation: Intl.CollatorOptions = { sensitivity: 'base', numeric: true };
  try {
    return new Intl.Collator(locale, collation);
  } catch {
    return new Intl.Collator(undefined, collation);
  }
}

// ---------------------------------------------------------------------------
// Non-data states
// ---------------------------------------------------------------------------

/** Why the last `GET /sessions` failed: the three displayable fields of the error. */
interface SessionsLoadError {
  readonly code: DebuggenErrorCode;
  readonly message: string;
  readonly hint?: string | undefined;
}

/**
 * Why the rows a load stored may stop short of the listing:
 *
 * - `page-cap` — {@link SESSION_LIST_PAGE_CAP} pages were read and the last one
 *   still named a `nextOffset`;
 * - `page-failed` — a page after the first failed, and the rows of the pages
 *   before it were stored.
 *
 * A walk that reached a `null` `nextOffset` has no shortfall.
 */
type ListingShortfall = 'page-cap' | 'page-failed';

/** Reachable, and nothing is stored yet. */
const EMPTY_NODE: MessageNode = Object.freeze({
  kind: 'message',
  key: 'empty',
  label: 'No sessions yet',
  description: 'Ask a question to start one',
  tooltip:
    'Ask a question in the Debug Generator Session view to start a debugging session. ' +
    'Stored sessions appear here, grouped by project and by day.',
  icon: 'comment-discussion',
  command: { command: SESSION_VIEW_FOCUS_COMMAND, title: 'Show the Session View' },
});

/** An unexpected error while building the tree; the details are in the log. */
const RENDER_FAILED_NODE: MessageNode = Object.freeze({
  kind: 'message',
  key: 'render-failed',
  label: 'Could not show sessions',
  tooltip:
    'An unexpected error occurred while building the Sessions view. ' +
    'Details are in the Debug Generator output channel.',
  icon: 'warning',
});

/**
 * The row for a failed `GET /sessions`, carrying the recovery action for its
 * cause: an invalid service URL opens that setting, anything else offers to
 * start the local service (AAP §0.5.5). The tooltip is the service client's
 * own message and hint, which never contain a credential.
 */
function failureNode(failure: SessionsLoadError): MessageNode {
  const tooltip =
    failure.hint === undefined ? failure.message : `${failure.message}\n${failure.hint}`;
  if (failure.code === 'CONFIG_INVALID') {
    return {
      kind: 'message',
      key: 'invalid-service-url',
      label: 'Service URL is not valid',
      description: 'Open settings',
      tooltip,
      icon: 'settings-gear',
      command: {
        command: OPEN_SETTINGS_COMMAND,
        title: 'Open Settings',
        arguments: [SERVICE_URL_SETTING],
      },
    };
  }
  const unreachable = failure.code === 'TRANSPORT_DISCONNECTED';
  return {
    kind: 'message',
    key: unreachable ? 'service-unreachable' : 'load-failed',
    label: unreachable ? 'Local service unreachable' : 'Could not load sessions',
    description: 'Start the local service',
    tooltip,
    icon: unreachable ? 'debug-disconnect' : 'warning',
    command: { command: START_SERVICE_COMMAND, title: 'Start Local Service' },
  };
}

/**
 * The informational row for the stored sessions a shortened load leaves out,
 * or `undefined` when its rows account for the whole `total`.
 *
 * A load walks `GET /sessions` page by page to the end of the listing, so this
 * row is rendered only for a load with a {@link ListingShortfall}: the page cap
 * stopped the walk, or a page after the first failed. Its tooltip names that
 * cause, because the two call for different expectations — the cap is a fixed
 * bound the next load meets again, while a failed page is retried and the
 * failure row above this one says why it failed. The row never offers an
 * action of its own.
 *
 * @param total The listing's `total`, as `ExtensionState.sessionListTotal` holds it.
 * @param listed How many rows the load stored.
 * @param shortfall Why the load stopped before the end of the listing.
 * @returns The row, or `undefined` when nothing is left out.
 */
function notListedNode(
  total: number,
  listed: number,
  shortfall: ListingShortfall,
): MessageNode | undefined {
  const omitted = total - listed;
  if (!Number.isSafeInteger(omitted) || omitted <= 0) {
    return undefined;
  }
  const stored = formatCount(total, 'stored session', 'stored sessions');
  const rest = omitted === 1 ? 'the other one is' : `the other ${String(omitted)} are`;
  return {
    kind: 'message',
    key: 'sessions-not-listed',
    label: `${formatCount(omitted, 'more session', 'more sessions')} not listed`,
    description: `${String(listed)} of ${String(total)} shown`,
    tooltip: `The local service holds ${stored} for this workspace. ${shortfallReason(
      shortfall,
      listed,
      rest,
    )}`,
    icon: 'info',
  };
}

/**
 * The sentence of the "not listed" tooltip that says why the load stopped
 * short. Exhaustive over {@link ListingShortfall}.
 *
 * @param shortfall Why the load stopped.
 * @param listed How many rows the load stored.
 * @param rest The omitted sessions as a sentence subject, e.g. `the other 250 are`.
 * @returns One sentence, ending with a full stop.
 */
function shortfallReason(shortfall: ListingShortfall, listed: number, rest: string): string {
  switch (shortfall) {
    case 'page-cap': {
      const perLoad = SESSION_LIST_PAGE_CAP * SESSION_LIST_MAX_LIMIT;
      return (
        `This view lists at most ${String(perLoad)} sessions per load ` +
        `(${String(SESSION_LIST_PAGE_CAP)} pages of ${String(SESSION_LIST_MAX_LIMIT)}), ` +
        `the most recently updated first; ${rest} not listed here.`
      );
    }
    case 'page-failed': {
      const shown =
        listed > 0
          ? `only the ${String(listed)} most recently updated`
          : 'none of the stored sessions';
      return (
        `A later page of the listing could not be loaded, so this view lists ${shown}; ` +
        `${rest} not listed until the listing loads again.`
      );
    }
    default:
      return assertNever(shortfall, 'Unhandled Sessions tree listing shortfall');
  }
}

/**
 * The codicon for a session status. An exhaustive `switch` closed with
 * `assertNever`, so a status added to the protocol's vocabulary fails to
 * compile here instead of rendering a blank icon. Colour is never the only
 * signal: the row's description always names the status.
 */
function statusIcon(status: SessionStatus): vscode.ThemeIcon {
  switch (status) {
    case 'created':
      return new vscode.ThemeIcon('circle-large-outline');
    case 'understanding':
      return new vscode.ThemeIcon('lightbulb');
    case 'investigating':
      return new vscode.ThemeIcon('search');
    case 'planning':
      return new vscode.ThemeIcon('checklist');
    case 'instrumenting':
      return new vscode.ThemeIcon('tools');
    case 'ready':
      return new vscode.ThemeIcon('play-circle');
    case 'capturing':
      return new vscode.ThemeIcon('record');
    case 'analyzing':
      return new vscode.ThemeIcon('graph');
    case 'generated':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'ended':
      return new vscode.ThemeIcon('history');
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    default:
      return assertNever(status, 'Unhandled session status in the Sessions tree');
  }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * The `TreeDataProvider` behind `debuggen.sessions`; see the module
 * documentation for the fetch policy and the rendered states.
 *
 * Disposable: {@link dispose} cancels an in-flight request, drops the store
 * subscription and the change emitter, and every later call renders nothing.
 */
export class SessionsTreeProvider
  implements vscode.TreeDataProvider<SessionsTreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<SessionsTreeNode | undefined>();

  /** Fires `undefined` — a whole-tree refresh — whenever the store changes or {@link refresh} completes. */
  readonly onDidChangeTreeData: vscode.Event<SessionsTreeNode | undefined> = this.emitter.event;

  private readonly state: SessionsTreeState;
  private readonly client: SessionsTreeClient;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly locale: string | undefined;
  private readonly storeSubscription: vscode.Disposable;
  /** Cancels an in-flight request on dispose. */
  private readonly lifetime = new AbortController();

  /** The walk of the listing in flight, shared by every caller (single-flight). */
  private pending: Promise<void> | undefined;
  /** The one follow-up walk an explicit refresh queued behind {@link pending}. */
  private queued: Promise<void> | undefined;
  /** Whether a load has stored rows at least once. */
  private loaded = false;
  /** The last load's failure, cleared by the next load that reaches the end of the listing. */
  private lastError: SessionsLoadError | undefined;
  /**
   * Why the stored rows stop short of the listing, as the load that stored
   * them found; `undefined` when that load reached the end. Left as it is by a
   * load whose first page fails, because such a load stores nothing and the
   * rows it describes are still the ones rendered.
   */
  private shortfall: ListingShortfall | undefined;
  /** The service's reachability when {@link lastError} was recorded. */
  private failureSignature: string | undefined;
  /** When the last request started, in epoch milliseconds. */
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  /** The active session id the last successful request was issued for. */
  private syncedActiveSessionId: string | undefined;
  private disposed = false;

  /**
   * @param deps The store, the service client and the logger; optionally a
   *   clock and a formatting locale.
   */
  constructor(deps: SessionsTreeDeps) {
    this.state = deps.state;
    this.client = deps.client;
    this.log = deps.logger.child({ component: 'sessions-tree' });
    this.now = deps.now ?? Date.now;
    this.locale = deps.locale;

    // RE-ENTRANCY GUARD: this handler fires `onDidChangeTreeData` and must
    // NEVER fetch. A successful fetch calls `setSessionList`, which raises this
    // very event, so fetching here would schedule a request per request — an
    // endless loop against the service. Whether a render fetches is decided in
    // `fetchWarranted()` alone. `onDidChange` is already coalesced by the
    // store, so no debounce is added here either.
    this.storeSubscription = this.state.onDidChange(() => {
      if (!this.disposed) {
        this.emitter.fire(undefined);
      }
    });
  }

  /**
   * Creates a provider and registers it for {@link SESSIONS_VIEW_ID} with
   * `vscode.window.registerTreeDataProvider`. `src/extension.ts` may instead
   * construct the provider itself and pass it to `createTreeView`.
   *
   * @returns The provider and one disposable that releases the registration
   *   and the provider together.
   */
  static register(deps: SessionsTreeDeps): {
    readonly provider: SessionsTreeProvider;
    readonly disposable: vscode.Disposable;
  } {
    const provider = new SessionsTreeProvider(deps);
    try {
      const registration = vscode.window.registerTreeDataProvider(SESSIONS_VIEW_ID, provider);
      return { provider, disposable: vscode.Disposable.from(registration, provider) };
    } catch (error) {
      provider.dispose();
      throw error;
    }
  }

  /**
   * Walks `GET /sessions` into the store, then fires a whole-tree refresh.
   *
   * Joins nothing stale: with a walk already in flight it waits for one
   * follow-up walk issued after that one settles, shared by every refresh
   * made meanwhile. A failure is recorded and rendered, never thrown.
   */
  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.reload();
    if (!this.disposed) {
      this.emitter.fire(undefined);
    }
  }

  /** The tree row for a node. Exhaustive over the node union. */
  getTreeItem(element: SessionsTreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'project':
        return this.projectItem(element);
      case 'date':
        return this.dateItem(element);
      case 'session':
        return this.sessionItem(element);
      case 'message':
        return messageItem(element);
      default:
        return assertNever(element, 'Unhandled Sessions tree node');
    }
  }

  /**
   * The children of a node, or the root rows. Never throws: an unexpected
   * error is logged by code and rendered as a row, so the view keeps a
   * recovery affordance instead of VS Code's generic error.
   *
   * Only the root may fetch, and only when {@link fetchWarranted} says so;
   * project and day rows derive their children from the node alone.
   */
  async getChildren(element?: SessionsTreeNode): Promise<SessionsTreeNode[]> {
    try {
      if (this.disposed) {
        return [];
      }
      return element === undefined ? await this.rootChildren() : childrenOf(element);
    } catch (error) {
      this.log.error('The Sessions view could not be built', { code: errorCode(error) });
      return [RENDER_FAILED_NODE];
    }
  }

  /**
   * Cancels an in-flight request and releases the store subscription and the
   * change emitter. Idempotent.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifetime.abort();
    this.storeSubscription.dispose();
    this.emitter.dispose();
  }

  // -------------------------------------------------------------------------
  // Root rendering and the fetch policy
  // -------------------------------------------------------------------------

  /**
   * The root rows: a failure row when the last load failed, then the project
   * rows the store holds, then — when the load that stored them stopped short
   * of the listing and its `total` exceeds the rows stored — the one
   * "sessions not listed" row. The empty-state row replaces all of them only
   * when the store holds no row, nothing is left out and nothing failed.
   */
  private async rootChildren(): Promise<SessionsTreeNode[]> {
    await this.synchronize();
    if (this.disposed) {
      return [];
    }
    const rows: SessionsTreeNode[] = [];
    const failure = this.lastError;
    if (failure !== undefined) {
      rows.push(failureNode(failure));
    }
    const listed = this.state.sessionList;
    const projects = groupSessions(listed, {
      activeProjectRoot: this.state.activeSession?.projectRoot,
      locale: this.locale,
    });
    rows.push(...projects);
    const notListed =
      this.shortfall === undefined
        ? undefined
        : notListedNode(this.state.sessionListTotal, listed.length, this.shortfall);
    if (notListed !== undefined) {
      rows.push(notListed);
    } else if (projects.length === 0 && failure === undefined) {
      rows.push(EMPTY_NODE);
    }
    return rows;
  }

  /**
   * Brings the store up to date before a root render: waits for a walk
   * already in flight, or starts one when {@link fetchWarranted}. A render
   * that waited does not fetch again — the answer it waited for is fresh.
   */
  private async synchronize(): Promise<void> {
    const inFlight = this.queued ?? this.pending;
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    if (this.fetchWarranted()) {
      await this.load();
    }
  }

  /**
   * Whether a root render should request `GET /sessions`. This predicate is
   * the only place that decision is made; see the module documentation for
   * why each rule keeps the render/fetch cycle finite.
   */
  private fetchWarranted(): boolean {
    if (this.lastError !== undefined) {
      return (
        this.reachabilitySignature() !== this.failureSignature ||
        this.now() - this.lastAttemptAt >= RETRY_INTERVAL_MS
      );
    }
    if (!this.loaded) {
      return true;
    }
    const activeId = this.state.activeSession?.id;
    return (
      activeId !== undefined &&
      activeId !== this.syncedActiveSessionId &&
      !this.state.sessionList.some((listed) => listed.id === activeId)
    );
  }

  /** The service's reachability as the store reports it; a change warrants a retry. */
  private reachabilitySignature(): string {
    return `${this.state.connectionStatus}:${String(this.state.serviceReachable)}`;
  }

  /** Joins the walk in flight, or starts one. */
  private load(): Promise<void> {
    if (this.pending === undefined) {
      const attempt: Promise<void> = this.fetchSessions().finally(() => {
        if (this.pending === attempt) {
          this.pending = undefined;
        }
      });
      this.pending = attempt;
    }
    return this.pending;
  }

  /**
   * A walk that starts after this call: the in-flight one's answer may
   * predate the caller's change, so one follow-up is queued behind it and
   * shared by every caller until it starts.
   */
  private reload(): Promise<void> {
    const inFlight = this.pending;
    if (inFlight === undefined) {
      return this.load();
    }
    if (this.queued === undefined) {
      const next: Promise<void> = inFlight
        .catch(() => undefined)
        .then(() => {
          if (this.queued === next) {
            this.queued = undefined;
          }
          return this.load();
        });
      this.queued = next;
    }
    return this.queued;
  }

  /**
   * One load: walks `GET /sessions` from offset `0` along `nextOffset`, in
   * pages of {@link SESSION_LIST_MAX_LIMIT} rows, until `nextOffset` is `null`
   * or {@link SESSION_LIST_PAGE_CAP} pages have been read.
   *
   * - Rows are de-duplicated by id, the first occurrence kept: offset paging
   *   over a listing ordered by `updatedAt` shifts when a session is created or
   *   updated between two requests, and the shifted row then appears on both
   *   pages.
   * - The gathered rows and the last page's `total` are written to the store
   *   once, after the walk (the store then notifies the views).
   * - A first page that fails is recorded for the failure row, logged by code
   *   and written nowhere, so it notifies nothing.
   * - A later page that fails keeps and stores the rows already gathered, with
   *   the last `total` a page reported, and is recorded like a first-page
   *   failure, so the failure row renders above the rows and the retry rule
   *   applies.
   * - Disposal aborts the page request in flight through the lifetime signal;
   *   the walk then stops and writes nothing.
   */
  private async fetchSessions(): Promise<void> {
    const activeAtStart = this.state.activeSession?.id;
    this.lastAttemptAt = this.now();

    const gathered: SessionListItem[] = [];
    const seen = new Set<string>();
    let total = 0;
    let pages = 0;
    let offset: number | null = 0;
    let failure: SessionsLoadError | undefined;

    while (offset !== null && pages < SESSION_LIST_PAGE_CAP) {
      const answer = await this.client.listSessions(
        { limit: SESSION_LIST_MAX_LIMIT, offset },
        { timeoutMs: LIST_TIMEOUT_MS, signal: this.lifetime.signal },
      );
      if (this.disposed) {
        return;
      }
      if (isErr(answer)) {
        const { code, message, hint } = answer.error;
        failure = { code, message, hint };
        break;
      }
      pages += 1;
      const page = answer.value;
      total = page.total;
      for (const session of page.sessions) {
        if (!seen.has(session.id)) {
          seen.add(session.id);
          gathered.push(session);
        }
      }
      offset = page.nextOffset;
    }

    let shortfall: ListingShortfall | undefined;
    if (failure !== undefined) {
      this.lastError = failure;
      this.failureSignature = this.reachabilitySignature();
      if (pages === 0) {
        // The first page failed: nothing was gathered, so nothing is written
        // and the rows of the last load that stored any stay as they are.
        this.log.warn('Stored sessions could not be listed', { code: failure.code });
        return;
      }
      this.log.warn('Stored sessions could not be listed past a page', { code: failure.code });
      shortfall = 'page-failed';
    } else {
      this.lastError = undefined;
      this.failureSignature = undefined;
      // Still a `nextOffset` after the last page read: the cap ended the walk.
      shortfall = offset === null ? undefined : 'page-cap';
    }

    // Set before the write: the write notifies the views, and a render it
    // triggers must find the shortfall that describes the rows it renders.
    this.loaded = true;
    this.syncedActiveSessionId = activeAtStart;
    this.shortfall = shortfall;
    this.state.setSessionList({ sessions: gathered, total });
    // Counts only: how many pages were read, how many distinct rows they
    // carried and the listing's size — never a row's content.
    this.log.debug(
      shortfall === 'page-cap'
        ? 'Stored sessions listed up to the page cap'
        : 'Stored sessions listed',
      { pages, rows: gathered.length, total },
    );
  }

  // -------------------------------------------------------------------------
  // Tree items
  // -------------------------------------------------------------------------

  private projectItem(node: ProjectNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.projectName, collapsible(node.expanded));
    const count = formatCount(node.sessions.length, 'session', 'sessions');
    item.id = `project:${node.projectRoot}`;
    item.description = node.nameIsAmbiguous ? `${node.projectRoot} · ${count}` : count;
    item.tooltip = `${node.projectName}\n${node.projectRoot}\n${count}`;
    item.iconPath = new vscode.ThemeIcon('root-folder');
    item.contextValue = 'debuggen.project';
    return item;
  }

  private dateItem(node: DateNode): vscode.TreeItem {
    const item = new vscode.TreeItem(formatDay(node, this.locale), collapsible(node.expanded));
    item.id = `date:${node.projectRoot}:${node.dayKey}`;
    item.description = formatCount(node.sessions.length, 'session', 'sessions');
    item.iconPath = new vscode.ThemeIcon('calendar');
    item.contextValue = 'debuggen.sessionDay';
    return item;
  }

  private sessionItem(node: SessionNode): vscode.TreeItem {
    const { session } = node;
    const item = new vscode.TreeItem(
      formatSessionLabel(session.question),
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `session:${node.sessionId}`;
    item.description = session.status;
    const excerpt = collapseText(session.question, MAX_TOOLTIP_QUESTION_LENGTH);
    const details = describeSession(session, { locale: this.locale });
    item.tooltip = excerpt.length === 0 ? details : `${excerpt}\n\n${details}`;
    item.iconPath = statusIcon(session.status);
    item.contextValue = SESSION_CONTEXT_VALUE;
    // The bare id is the argument `debuggen.reopenSession` resolves; the
    // command fetches the record and the service replays it to both surfaces.
    item.command = {
      command: REOPEN_SESSION_COMMAND,
      title: 'Reopen Session',
      arguments: [node.sessionId],
    };
    return item;
  }
}

// ---------------------------------------------------------------------------
// Provider helpers (stateless)
// ---------------------------------------------------------------------------

/** A container row's initial state; VS Code preserves the developer's choice per item id. */
function collapsible(expanded: boolean): vscode.TreeItemCollapsibleState {
  return expanded
    ? vscode.TreeItemCollapsibleState.Expanded
    : vscode.TreeItemCollapsibleState.Collapsed;
}

/** The children a non-root node derives from itself; never fetches. */
function childrenOf(element: SessionsTreeNode): SessionsTreeNode[] {
  switch (element.kind) {
    case 'project':
      return [...element.days];
    case 'date':
      return element.sessions.map((session): SessionNode => ({
        kind: 'session',
        sessionId: session.id,
        session,
      }));
    case 'session':
    case 'message':
      return [];
    default:
      return assertNever(element, 'Unhandled Sessions tree node');
  }
}

/** The row for a non-data state. */
function messageItem(node: MessageNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.id = `message:${node.key}`;
  item.contextValue = 'debuggen.message';
  if (node.description !== undefined) {
    item.description = node.description;
  }
  if (node.tooltip !== undefined) {
    item.tooltip = node.tooltip;
  }
  if (node.icon !== undefined) {
    item.iconPath = new vscode.ThemeIcon(node.icon);
  }
  if (node.command !== undefined) {
    item.command = node.command;
  }
  return item;
}

/** The code to log for an unexpected error; never its message, which may carry data. */
function errorCode(error: unknown): DebuggenErrorCode {
  return DebuggenError.is(error) ? error.code : 'INTERNAL';
}
