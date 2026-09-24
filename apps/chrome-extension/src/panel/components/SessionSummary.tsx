/**
 * `SessionSummary` — the "Debug Generator" DevTools panel's overview of the bound session: what was
 * asked, how far the pipeline got, which files were instrumented, which signals are live or
 * unavailable, and how cleanup ended (AAP 0.7.3, 0.5.1, 0.5.5).
 *
 * ## The honesty surface
 *
 * AAP 0.5.1 promises that "each modification is surfaced to the developer … in the DevTools
 * `SessionSummary`", and AAP 0.5.5 that an unavailable signal or a conflicting file is reported as
 * exactly that. This component is where both promises are kept on the Chrome side, so it shows
 * what the service reported and nothing else:
 *
 * - every project-specific string — the question, the project name, a progress line, a file path,
 *   a runtime hook, an unavailable signal's reason and hint, a conflict's explanation, the plan's
 *   objective — is a field of a payload the store already holds, rendered verbatim;
 * - the only copy authored here is structural: status words, block titles, the connectives of
 *   "Could not enable ‹signal›: ‹reason›. Continuing with: ‹enabled list›." and the neutral
 *   empty-state sentences. None of it names anything from an inspected application (AAP 0.5.4);
 * - nothing is re-redacted, logged or re-worded — every value arrived redacted from the service
 *   (AAP 0.5.2), and the progress wording is the service's own (AAP 0.7.1 Group 2).
 *
 * ## Composition
 *
 * ```text
 * Section (card, "Session", h2)
 * ├── identity           status Badge (tone + word) · project name · question · follow-ups
 * ├── Section "Progress"          (h3)  <ol> of service progress rows, first-arrival order
 * ├── Section "Instrumentation"   (h3)  plan objective · DataTable of modification records
 * │                                     └── conflict rows open a detail row with the explanation
 * ├── Section "Signals"           (h3)  enabled runtime hooks · unavailable signals with hints
 * └── Section "Cleanup"           (h3)  cleanup status Badge · count of files left untouched
 * ```
 *
 * The heading outline continues the panel's: the header's wordmark is level 1 and the generated
 * panel's title inside `PanelHost` is level 2, so this summary is a level-2 region whose blocks
 * are level 3. The question itself is body text, never a heading.
 *
 * ## States (AAP 0.6.2 — never a blank area)
 *
 * Every block that can lack data renders one of the renderer's three state primitives rather than
 * an empty box, with a fixed precedence of error > loading > empty > content:
 *
 * - **error** — only the instrumentation block can fail on its own (`instrumentation.failed`); its
 *   `ErrorState` names the failure, its code and its hint, and sits *beside* rows an earlier plan
 *   version applied, never instead of them, so a failure is never presented as an empty list;
 * - **loading** — while the session status says the data is still being produced (the pipeline is
 *   running, or instrumentation has not reported yet), a `LoadingState` silhouette;
 * - **empty** — a block-specific `EmptyState`: "No files were modified for this session." is the
 *   normal outcome of a runtime-only plan (AAP 0.5.1 makes runtime hooks the default).
 *
 * With no session at all the component renders nothing: `EmptyPanel` owns the no-session copy.
 *
 * ## Click-to-source, honestly
 *
 * No record this summary renders carries a resolved line and column: a `ModificationRecord`, a
 * `ModificationConflict` and a plan action name a project-relative file (and at most a symbol),
 * never a position. Paths are therefore rendered in `Code` with no interactive affordance, and no
 * `SourceLink` is built — fabricating `line: 1` would send the developer to the wrong place and
 * break the resolution contract of AAP 0.4.2, which only the service's four resolution routes may
 * satisfy. `onOpenSource` is accepted so the composition root wires every out-of-host surface
 * (this one, `EventDetails`, `LiveTail`) through one prop shape; it is invoked only from a real
 * `SourceLocation`, and this component holds none.
 *
 * ## Accessibility
 *
 * - Status is never carried by colour alone: every badge has its word, and a progress row's word
 *   is part of the row's text, so a screen reader hears "Done understand Found …".
 * - The modification list is the renderer's `DataTable`: `role="grid"` with exact
 *   `aria-rowcount`/`aria-colcount`, the file as `rowheader`, one roving Tab stop and arrow-key
 *   navigation, all owned by the primitive. No column offers sorting — the rows come from the store
 *   in journal order and `DataTable` never re-orders them locally, so a sort control would be inert.
 * - A conflict row's explanation is its full-width detail row, which the grid keeps open for every
 *   conflicting record; it holds only text, so it adds no focus stop.
 * - The progress rows and the follow-up questions are real `<ol>` lists, so assistive technology
 *   announces their order and count; the renderer's base layer draws the numerals inside the list
 *   box. The `<ol>`/`<li>` pair is the one set of raw elements used, because no primitive renders
 *   a list and the ordering semantics are required. Unavailable signals are a stack of paragraphs.
 *
 * ## Design-system compliance (AAP 0.6.4)
 *
 * Every visual value resolves through a renderer component — `Section`, `Stack`, `Badge`, `Text`,
 * `Code`, `DataTable`, `EmptyState`, `LoadingState`, `ErrorState` — and so through the `--dg-*`
 * tokens behind them. This file writes no inline style, no length, no colour and no class name of
 * its own; the `DataTable` column widths are relational grid tracks (`ch` minimums, `fr` shares),
 * the vocabulary that primitive's `width` prop accepts.
 *
 * ## Boundaries
 *
 * Presentational and pure: no store access or writes, no transport of any kind (no port, socket,
 * `fetch` or HTTP client), no validation and no `chrome.*` API, so it renders unchanged when the
 * panel document is opened directly as an extension page with `chrome.devtools` undefined. The
 * composition root reads the store and passes the slices in.
 *
 * @module apps/chrome-extension/src/panel/components/SessionSummary
 */
import {
  Badge,
  Code,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Section,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import type { BadgeTone, DataTableColumn } from '@debuggen/panel-renderer';
import type {
  CleanupStatus,
  ModificationConflict,
  ModificationRecord,
  ModificationStatus,
  ProgressStatus,
  SessionRecord,
  SessionStatus,
  SourceLocation,
} from '@debuggen/protocol';
import { useMemo } from 'react';
import type { ReactElement, ReactNode } from 'react';

import type {
  PanelCleanupSlice,
  PanelInstrumentationFailure,
  PanelProgressEntry,
  PanelRuntimeHook,
  PanelUnavailableSignal,
} from '../state/session-store';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props of {@link SessionSummary}. The names match the store's slices so the composition root
 * passes them straight through: `session` is `PanelSnapshot.session`, `progress` is
 * `PanelSnapshot.progress`, `runtimeHooks`, `unavailable` and `instrumentationFailure` are
 * `PanelSnapshot.instrumentation.{runtimeHooks, unavailable, failure}`, and `cleanup` is
 * `PanelSnapshot.cleanup`.
 *
 * Every optional member states `| undefined` explicitly because `exactOptionalPropertyTypes` is
 * on repository-wide and a caller forwarding a value it may not have must stay legal.
 */
export interface SessionSummaryProps {
  /**
   * The bound session's record, exactly as the service last broadcast it. `undefined` renders
   * nothing: the no-session state belongs to `EmptyPanel`.
   */
  session: SessionRecord | undefined;

  /**
   * The progress rows, in first-arrival order, already deduplicated by stage and message and
   * bounded by the store's `PANEL_PROGRESS_MAX_ENTRIES`. Rendered in exactly this order, all of
   * them — this component adds no second bound.
   */
  progress: readonly PanelProgressEntry[];

  /**
   * The modification records to list, in journal order, one row each. Pass
   * `session.modifications`: it is the live journal, whose statuses move through `conflict` and
   * `reverted` as `session.updated` frames arrive, whereas `PanelSnapshot.instrumentation.applied`
   * is the list as it stood when the latest `instrumentation.ready` was sent.
   */
  modifications: readonly ModificationRecord[];

  /** The runtime hooks the latest `instrumentation.ready` reported enabled. */
  runtimeHooks: readonly PanelRuntimeHook[];

  /**
   * The signals the latest `instrumentation.ready` could not enable, each with its reason and its
   * one concrete next step (AAP 0.5.5).
   */
  unavailable: readonly PanelUnavailableSignal[];

  /**
   * Why the latest installation could not enable anything, from `instrumentation.failed`. Renders
   * the instrumentation block's error state, beside any rows an earlier plan version applied.
   */
  instrumentationFailure?: PanelInstrumentationFailure | undefined;

  /**
   * The end-of-session cleanup outcome from `cleanup.completed`. When absent, the session record's
   * own `cleanup` is shown once it has moved past `pending` — the same service-reported outcome,
   * reaching a panel that opened after the push.
   */
  cleanup?: PanelCleanupSlice | undefined;

  /**
   * The click-to-source handler, for a row that carries a real `SourceLocation`. Rendered outside
   * `PanelHost`, this component has no `PanelActionsContext`, so a handler must arrive explicitly;
   * see the module header for why no record rendered here carries a location to open.
   */
  onOpenSource?: ((location: SourceLocation) => void) | undefined;

  /** Extra classes for the outermost element, forwarded to the card `Section`. */
  className?: string | undefined;
}

// ---------------------------------------------------------------------------
// Vocabulary tables — each keyed by its imported union, so a value added upstream is a compile
// error here rather than an unstyled, unexplained badge.
// ---------------------------------------------------------------------------

/** How one session status is presented, and what it implies about data still to arrive. */
interface SessionStatusPresentation {
  /** The badge's tone — additional signal only; the word carries the meaning. */
  readonly tone: BadgeTone;
  /** The status word shown on the badge. */
  readonly label: string;
  /** Whether the pipeline is still producing progress rows in this status. */
  readonly progressExpected: boolean;
  /** Whether the instrumentation report has yet to arrive in this status. */
  readonly instrumentationExpected: boolean;
}

/**
 * The eleven session statuses (`SESSION_STATUSES`). In-progress stages take `accent`, the two
 * waiting states `info`, a generated result `success`, an ended session `neutral` and a failure
 * `danger`. The two flags decide when a block shows a loading silhouette instead of its empty
 * state: before `ready` the instrumentation report has not arrived yet, and progress rows are
 * still being produced by every stage the pipeline runs on its own.
 */
const SESSION_STATUS_PRESENTATION: Readonly<Record<SessionStatus, SessionStatusPresentation>> = {
  created: {
    tone: 'info',
    label: 'Created',
    progressExpected: true,
    instrumentationExpected: true,
  },
  understanding: {
    tone: 'accent',
    label: 'Understanding',
    progressExpected: true,
    instrumentationExpected: true,
  },
  investigating: {
    tone: 'accent',
    label: 'Investigating',
    progressExpected: true,
    instrumentationExpected: true,
  },
  planning: {
    tone: 'accent',
    label: 'Planning',
    progressExpected: true,
    instrumentationExpected: true,
  },
  instrumenting: {
    tone: 'accent',
    label: 'Instrumenting',
    progressExpected: true,
    instrumentationExpected: true,
  },
  ready: { tone: 'info', label: 'Ready', progressExpected: false, instrumentationExpected: false },
  capturing: {
    tone: 'accent',
    label: 'Capturing',
    progressExpected: false,
    instrumentationExpected: false,
  },
  analyzing: {
    tone: 'accent',
    label: 'Analyzing',
    progressExpected: true,
    instrumentationExpected: false,
  },
  generated: {
    tone: 'success',
    label: 'Generated',
    progressExpected: false,
    instrumentationExpected: false,
  },
  ended: {
    tone: 'neutral',
    label: 'Ended',
    progressExpected: false,
    instrumentationExpected: false,
  },
  failed: {
    tone: 'danger',
    label: 'Failed',
    progressExpected: false,
    instrumentationExpected: false,
  },
};

/** How one progress status is presented: a tone, a decorative glyph and the word that carries it. */
interface BadgePresentation {
  /** The badge's tone — additional signal only. */
  readonly tone: BadgeTone;
  /** The status word, always visible and part of the row's text. */
  readonly label: string;
  /** A decorative glyph; the badge renders it `aria-hidden`. */
  readonly glyph: string;
}

/** The three progress statuses of AAP 0.4.2: a spinner-like mark, a check and a cross. */
const PROGRESS_STATUS_PRESENTATION: Readonly<Record<ProgressStatus, BadgePresentation>> = {
  running: { tone: 'accent', label: 'Running', glyph: '◌' },
  done: { tone: 'success', label: 'Done', glyph: '✓' },
  failed: { tone: 'danger', label: 'Failed', glyph: '✕' },
};

/**
 * The five journal statuses (`MODIFICATION_STATUSES`, AAP 0.5.1). A conflict is a refusal to
 * overwrite the developer's edit, not a failure of the tool, so it is a `warning`; a write that
 * aborted is the `danger`. A reverted record needs nothing further, so it is `neutral`.
 */
const MODIFICATION_STATUS_PRESENTATION: Readonly<Record<ModificationStatus, BadgePresentation>> = {
  pending: { tone: 'info', label: 'Pending', glyph: '◌' },
  applied: { tone: 'accent', label: 'Applied', glyph: '●' },
  reverted: { tone: 'neutral', label: 'Reverted', glyph: '↺' },
  conflict: { tone: 'warning', label: 'Conflict', glyph: '!' },
  failed: { tone: 'danger', label: 'Failed', glyph: '✕' },
};

/** The four session cleanup statuses (`CLEANUP_STATUSES`, AAP 0.5.1). */
const CLEANUP_STATUS_PRESENTATION: Readonly<Record<CleanupStatus, BadgePresentation>> = {
  pending: { tone: 'info', label: 'Pending', glyph: '◌' },
  clean: { tone: 'success', label: 'Clean', glyph: '✓' },
  partial: { tone: 'warning', label: 'Partial', glyph: '!' },
  conflict: { tone: 'warning', label: 'Conflict', glyph: '!' },
};

// ---------------------------------------------------------------------------
// Copy — structural only; every project-specific string comes from a payload field.
// ---------------------------------------------------------------------------

/** The summary's region title. */
const SUMMARY_TITLE = 'Session';

/** The block titles, in rendering order. */
const PROGRESS_TITLE = 'Progress';
const INSTRUMENTATION_TITLE = 'Instrumentation';
const SIGNALS_TITLE = 'Signals';
const CLEANUP_TITLE = 'Cleanup';

/** The label above the follow-up questions. */
const FOLLOW_UPS_LABEL = 'Follow-up questions';

/** The label above the enabled runtime hooks. */
const ENABLED_SIGNALS_LABEL = 'Enabled';

/**
 * The connectives of AAP 0.5.5's "Could not enable ‹signal›: ‹reason›. Continuing with: ‹enabled
 * list›." — the only words of that sentence this file supplies.
 */
const UNAVAILABLE_LEAD = 'Could not enable';
const CONTINUING_LEAD = 'Continuing with:';

/** The accessible name of the modification grid. */
const MODIFICATIONS_CAPTION = 'Modified files';

/** The empty states — each names what its block would have shown. */
const PROGRESS_EMPTY_MESSAGE = 'No pipeline progress has reached this panel for this session.';
const MODIFICATIONS_EMPTY_MESSAGE = 'No files were modified for this session.';
const SIGNALS_EMPTY_MESSAGE = 'No signal report has reached this panel for this session.';
const SIGNALS_NONE_AFTER_FAILURE_MESSAGE =
  'No signal was enabled, because instrumentation could not be installed.';

/** The announced (never painted) labels of the loading silhouettes. */
const PROGRESS_LOADING_LABEL = 'Waiting for pipeline progress';
const INSTRUMENTATION_LOADING_LABEL = 'Waiting for the instrumentation report';
const SIGNALS_LOADING_LABEL = 'Waiting for the signal report';

/** The first line of the instrumentation block's error state. */
const INSTRUMENTATION_FAILED_TITLE = 'Instrumentation could not be installed';

/**
 * The explanation a conflicting row carries until the service's own conflict report (with its
 * authored message) reaches the panel: the plain-terms AAP 0.5.5 statement that the file changed
 * while instrumented and will not be overwritten.
 */
const CONFLICT_FALLBACK_MESSAGE =
  'This file changed after it was instrumented. Debug Generator will not overwrite it; the original stays in the session backup.';

/** The column headers of the modification grid. */
const FILE_HEADER = 'File';
const PLAN_HEADER = 'Plan';
const STATUS_HEADER = 'Status';
const APPLIED_AT_HEADER = 'Applied at';

/**
 * The applied-at and cleanup timestamps: date and time to the second in the reader's locale. A
 * session can be reopened days later, so the date is always shown rather than inferred.
 */
const TIMESTAMP_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'medium',
});

/** Terminal punctuation after which no full stop is appended to a service-supplied fragment. */
const TERMINAL_PUNCTUATION = /[.!?…]$/u;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Whether an optional string carries anything to render.
 *
 * @param value The value as received.
 * @returns `true` for a string with at least one non-whitespace character.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * Closes a service-supplied fragment as a sentence without doubling its punctuation.
 *
 * @param fragment The fragment, rendered verbatim otherwise.
 * @returns The fragment, with a full stop appended when it ends in none.
 */
function asSentence(fragment: string): string {
  const trimmed = fragment.trimEnd();
  return TERMINAL_PUNCTUATION.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Formats an epoch-millisecond timestamp for display, or `undefined` when it is not a date — so an
 * out-of-range value renders nothing rather than throwing from `Intl.DateTimeFormat#format`.
 *
 * @param epochMs The timestamp as the record carries it.
 * @returns The localised date and time, or `undefined`.
 */
function formatTimestamp(epochMs: number): string | undefined {
  if (!Number.isFinite(epochMs)) {
    return undefined;
  }
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? undefined : TIMESTAMP_FORMAT.format(date);
}

/**
 * `"1 file"` / `"3 files"`: a count with its noun, so a number is never shown without a unit.
 *
 * @param count A non-negative count.
 * @param singular The noun for one.
 * @param plural The noun for any other count.
 * @returns The count and the noun, separated by a space.
 */
function countOf(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

/**
 * Renders a status badge from its presentation: the tone, the decorative glyph and the word.
 *
 * @param presentation The row of a vocabulary table.
 * @returns The badge.
 */
function renderStatusBadge(presentation: BadgePresentation): ReactElement {
  return (
    <Badge tone={presentation.tone} icon={presentation.glyph}>
      {presentation.label}
    </Badge>
  );
}

/** The presentation of an unavailable signal's lead badge (AAP 0.5.5). */
const UNAVAILABLE_PRESENTATION: BadgePresentation = {
  tone: 'warning',
  label: 'Unavailable',
  glyph: '!',
};

/** The tone and glyph of an enabled runtime hook's badge; the hook's own label is its word. */
const ENABLED_TONE: BadgeTone = 'success';
const ENABLED_GLYPH = '✓';

// ---------------------------------------------------------------------------
// The modification grid
// ---------------------------------------------------------------------------

/**
 * The modification grid's columns: the file (the row's identity), the plan version that installed
 * it, the journal status and when the record was applied.
 *
 * Module-level and pure, so the grid receives the same column array on every render. No column is
 * sortable: the rows come from the store in journal order — the order cleanup reverses — and
 * `DataTable` never re-orders rows itself, so a sort control would be inert. The widths are
 * relational tracks: `ch` minimums sized for each column's widest form, `fr` shares of the rest.
 */
const MODIFICATION_COLUMNS: readonly DataTableColumn<ModificationRecord>[] = [
  {
    key: 'file',
    header: FILE_HEADER,
    rowHeader: true,
    sortable: false,
    width: 'minmax(24ch, 3fr)',
    // The path is shown, not linked: a modification record carries no line or column, and a
    // fabricated position would open the wrong place (AAP 0.4.2).
    cell: (row) => (
      <Code size="sm" wrap>
        {row.file}
      </Code>
    ),
  },
  {
    key: 'plan',
    header: PLAN_HEADER,
    align: 'end',
    sortable: false,
    width: '7ch',
    cell: (row) => (
      <Text size="xs" numeric>
        {String(row.planVersion)}
      </Text>
    ),
  },
  {
    key: 'status',
    header: STATUS_HEADER,
    sortable: false,
    width: 'minmax(14ch, 1fr)',
    cell: (row) => renderStatusBadge(MODIFICATION_STATUS_PRESENTATION[row.status]),
  },
  {
    key: 'appliedAt',
    header: APPLIED_AT_HEADER,
    sortable: false,
    width: 'minmax(22ch, 1fr)',
    cell: (row) => {
      const applied = formatTimestamp(row.appliedAt);
      return applied === undefined ? null : (
        <Text size="xs" tone="secondary" numeric>
          {applied}
        </Text>
      );
    },
  },
];

/**
 * The stable identity of a modification row: its journal id, which no other record shares.
 *
 * @param row The record.
 * @returns The record's id.
 */
function modificationRowKey(row: ModificationRecord): string {
  return row.id;
}

/**
 * The detail a conflicting row opens: the service's own explanation when its conflict report has
 * arrived, and otherwise the plain-terms statement that the file will not be overwritten.
 *
 * @param conflict The service's conflict report for the row's record, when one has arrived.
 * @returns The text of the detail row.
 */
function renderConflictDetail(conflict: ModificationConflict | undefined): ReactElement {
  return (
    <Text as="p" size="sm">
      {conflict === undefined ? CONFLICT_FALLBACK_MESSAGE : conflict.message}
    </Text>
  );
}

/** How the modification block decides between its states when it has no row. */
interface ModificationStates {
  /** Whether installation failed outright; its `ErrorState` is already rendered above. */
  readonly failed: boolean;
  /** Whether the instrumentation report is still to arrive. */
  readonly awaitingReport: boolean;
}

/**
 * The modification block's grid, or — with no row — nothing beside a failure, the loading
 * silhouette while the report is due, or the runtime-only empty state.
 *
 * @param modifications The records, in journal order.
 * @param conflictRowKeys The ids of the conflicting rows, whose detail stays open.
 * @param conflictsByRecord The service's conflict reports, by record id.
 * @param states Which no-row state applies.
 * @returns The block's grid or state, or `null` when the error state already stands alone.
 */
function renderModifications(
  modifications: readonly ModificationRecord[],
  conflictRowKeys: readonly string[],
  conflictsByRecord: ReadonlyMap<string, ModificationConflict>,
  states: ModificationStates,
): ReactNode {
  if (modifications.length === 0) {
    if (states.failed) {
      return null;
    }
    return states.awaitingReport ? (
      <LoadingState rows={2} label={INSTRUMENTATION_LOADING_LABEL} />
    ) : (
      <EmptyState message={MODIFICATIONS_EMPTY_MESSAGE} />
    );
  }

  return (
    <DataTable
      rows={modifications}
      columns={MODIFICATION_COLUMNS}
      rowKey={modificationRowKey}
      caption={MODIFICATIONS_CAPTION}
      expandedRowKeys={conflictRowKeys}
      renderExpandedRow={(row) => renderConflictDetail(conflictsByRecord.get(row.id))}
      virtualize={false}
      compact
    />
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * The identity block: the status badge with its word, the project name, the question as typed and
 * any follow-up questions, oldest first.
 *
 * @param session The bound session's record.
 * @returns The block.
 */
function renderIdentity(session: SessionRecord): ReactElement {
  const status = SESSION_STATUS_PRESENTATION[session.status];

  return (
    <Stack gap={1}>
      <Stack direction="horizontal" gap={2} align="center" wrap>
        <Badge tone={status.tone}>{status.label}</Badge>
        <Text size="sm" tone="secondary">
          {session.projectName}
        </Text>
      </Stack>
      <Text as="p" size="md">
        {session.question}
      </Text>
      {session.followUps.length > 0 ? (
        <Stack gap={0}>
          <Text size="xs" tone="muted">
            {FOLLOW_UPS_LABEL}
          </Text>
          <Text as="div" size="sm" tone="secondary">
            <ol>
              {session.followUps.map((followUp, index) => (
                <li key={`${String(index)}:${String(followUp.askedAt)}`}>
                  <Text size="sm">{followUp.question}</Text>
                </li>
              ))}
            </ol>
          </Text>
        </Stack>
      ) : null}
    </Stack>
  );
}

/**
 * The progress block's content: every row in first-arrival order, each with its status word and
 * glyph, the reporting stage, the service's line and its optional detail.
 *
 * @param progress The store's progress rows.
 * @param progressExpected Whether the session status says rows are still being produced.
 * @returns The list, or the loading or empty state when there is no row.
 */
function renderProgress(
  progress: readonly PanelProgressEntry[],
  progressExpected: boolean,
): ReactElement {
  if (progress.length === 0) {
    return progressExpected ? (
      <LoadingState rows={3} label={PROGRESS_LOADING_LABEL} />
    ) : (
      <EmptyState message={PROGRESS_EMPTY_MESSAGE} />
    );
  }

  return (
    <Text as="div" size="sm" tone="secondary">
      <ol>
        {progress.map((entry) => (
          // `(stage, message)` is the row's identity in the store, so it is unique here.
          <li key={`${entry.stage}\u0000${entry.message}`}>
            {renderStatusBadge(PROGRESS_STATUS_PRESENTATION[entry.status])}{' '}
            <Code size="sm">{entry.stage}</Code> <Text size="sm">{entry.message}</Text>
            {hasText(entry.detail) ? (
              <Text as="div" size="xs" tone="muted">
                {entry.detail}
              </Text>
            ) : null}
          </li>
        ))}
      </ol>
    </Text>
  );
}

/** What the signals block renders from. */
interface SignalsInput {
  /** The runtime hooks reported enabled, blank labels removed. */
  readonly runtimeHooks: readonly string[];
  /** The signals reported unavailable. */
  readonly unavailable: readonly PanelUnavailableSignal[];
  /** How many modification records are currently applied — patched signals that are live. */
  readonly appliedCount: number;
  /** Whether installation failed outright. */
  readonly failed: boolean;
  /** Whether the instrumentation report is still to arrive. */
  readonly awaitingReport: boolean;
}

/**
 * The signals block's content: the runtime hooks that came up, then every signal that could not
 * be enabled as "Could not enable ‹signal›: ‹reason›." with its hint, closed by one
 * "Continuing with: ‹enabled list›." line composed from the hooks and the applied patches
 * (AAP 0.5.5). Every noun in those sentences is a payload field.
 *
 * @param input The report to render.
 * @returns The block's content, or its loading or empty state when nothing was reported.
 */
function renderSignals(input: SignalsInput): ReactElement {
  const { runtimeHooks, unavailable, appliedCount, failed, awaitingReport } = input;

  if (runtimeHooks.length === 0 && unavailable.length === 0) {
    if (failed) {
      return <EmptyState message={SIGNALS_NONE_AFTER_FAILURE_MESSAGE} />;
    }
    return awaitingReport ? (
      <LoadingState rows={2} label={SIGNALS_LOADING_LABEL} />
    ) : (
      <EmptyState message={SIGNALS_EMPTY_MESSAGE} />
    );
  }

  const enabled =
    appliedCount > 0
      ? [...runtimeHooks, countOf(appliedCount, 'instrumented file', 'instrumented files')]
      : runtimeHooks;

  return (
    <Stack gap={2}>
      {runtimeHooks.length > 0 ? (
        <Stack gap={1}>
          <Text size="xs" tone="muted">
            {ENABLED_SIGNALS_LABEL}
          </Text>
          <Stack direction="horizontal" gap={1} wrap>
            {runtimeHooks.map((hook, index) => (
              <Badge key={`${String(index)}:${hook}`} tone={ENABLED_TONE} icon={ENABLED_GLYPH}>
                {hook}
              </Badge>
            ))}
          </Stack>
        </Stack>
      ) : null}
      {unavailable.length > 0 ? (
        <Stack gap={2}>
          {unavailable.map((signalGap, index) => (
            <Stack key={`${String(index)}:${signalGap.signal}`} gap={0}>
              <Text as="p" size="sm">
                {renderStatusBadge(UNAVAILABLE_PRESENTATION)} {UNAVAILABLE_LEAD}{' '}
                <Code size="sm">{signalGap.signal}</Code>: {asSentence(signalGap.reason)}
              </Text>
              <Text as="p" size="xs" tone="secondary">
                {signalGap.hint}
              </Text>
            </Stack>
          ))}
          {enabled.length > 0 ? (
            <Text as="p" size="sm" tone="secondary">
              {CONTINUING_LEAD} {asSentence(enabled.join(', '))}
            </Text>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}

/** What the cleanup block renders from. */
interface CleanupInput {
  /** The cleanup status to badge. */
  readonly status: CleanupStatus;
  /** How many files cleanup (or the watcher) left untouched. */
  readonly conflictCount: number;
  /** When cleanup finished, when the record says. */
  readonly completedAt: number | undefined;
  /** Conflict reports whose record is not shown as a conflicting row above. */
  readonly unlistedConflicts: readonly ModificationConflict[];
}

/**
 * The cleanup block's content: the status badge, the number of files left untouched and when
 * cleanup finished, followed by any conflict report whose record is not already explained on a
 * row of the modification grid — so every conflict message the service sent is visible once.
 *
 * @param input The cleanup outcome to render.
 * @returns The block's content.
 */
function renderCleanup(input: CleanupInput): ReactElement {
  const { status, conflictCount, completedAt, unlistedConflicts } = input;
  const completed = completedAt === undefined ? undefined : formatTimestamp(completedAt);

  return (
    <Stack gap={2}>
      <Stack direction="horizontal" gap={2} align="center" wrap>
        {renderStatusBadge(CLEANUP_STATUS_PRESENTATION[status])}
        {conflictCount > 0 ? (
          <Text size="sm">{`${countOf(conflictCount, 'file', 'files')} left untouched`}</Text>
        ) : null}
        {completed === undefined ? null : (
          <Text size="xs" tone="muted" numeric>
            {`Completed ${completed}`}
          </Text>
        )}
      </Stack>
      {unlistedConflicts.map((conflict) => (
        <Stack key={conflict.recordId} gap={0}>
          <Code size="sm" wrap>
            {conflict.file}
          </Code>
          <Text as="p" size="sm">
            {conflict.message}
          </Text>
        </Stack>
      ))}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

/**
 * Renders the bound session's overview: identity, progress, instrumentation, signals and — once
 * there is an outcome — cleanup. Renders nothing without a session.
 *
 * @param props The props documented on {@link SessionSummaryProps}.
 * @returns The summary region, or `null` when there is no session.
 *
 * @example
 * // The composition root, with the store's snapshot in hand:
 * <SessionSummary
 *   session={snapshot.session}
 *   progress={snapshot.progress}
 *   modifications={snapshot.session?.modifications ?? []}
 *   runtimeHooks={snapshot.instrumentation.runtimeHooks}
 *   unavailable={snapshot.instrumentation.unavailable}
 *   instrumentationFailure={snapshot.instrumentation.failure}
 *   cleanup={snapshot.cleanup}
 *   onOpenSource={actions.onOpenSource}
 * />
 */
export function SessionSummary(props: SessionSummaryProps): ReactElement | null {
  const {
    session,
    progress,
    modifications,
    runtimeHooks,
    unavailable,
    instrumentationFailure,
    cleanup,
    className,
  } = props;

  // Every conflict report the service sent, keyed by the record it is about. The record's own
  // cleanup state comes first and the `cleanup.completed` push overlays it, so the newest report
  // for a record wins.
  const conflictsByRecord = useMemo(() => {
    const byRecord = new Map<string, ModificationConflict>();
    for (const conflict of session?.cleanup.conflicts ?? []) {
      byRecord.set(conflict.recordId, conflict);
    }
    for (const conflict of cleanup?.conflicts ?? []) {
      byRecord.set(conflict.recordId, conflict);
    }
    return byRecord;
  }, [session, cleanup]);

  // A conflicting row keeps its explanation open: the grid renders it as the row's full-width
  // detail, which holds text only and adds no focus stop.
  const conflictRowKeys = useMemo(
    () => modifications.filter((row) => row.status === 'conflict').map(modificationRowKey),
    [modifications],
  );

  const enabledHooks = useMemo(() => runtimeHooks.filter(hasText), [runtimeHooks]);

  if (session === undefined) {
    return null;
  }

  const status = SESSION_STATUS_PRESENTATION[session.status];
  const reportArrived = enabledHooks.length > 0 || unavailable.length > 0;
  const awaitingReport =
    status.instrumentationExpected && !reportArrived && instrumentationFailure === undefined;
  const latestPlan = session.plans.at(-1);
  const appliedCount = modifications.filter((row) => row.status === 'applied').length;

  // The cleanup outcome: the push when it has arrived, otherwise the record's own state once it
  // says more than "pending with nothing to report".
  const recordCleanup = session.cleanup;
  const effectiveCleanup: PanelCleanupSlice | undefined =
    cleanup ??
    (recordCleanup.status === 'pending' && recordCleanup.conflicts.length === 0
      ? undefined
      : recordCleanup);
  const listedConflictIds = new Set(conflictRowKeys);
  const unlistedConflicts =
    effectiveCleanup === undefined
      ? []
      : [...conflictsByRecord.values()].filter(
          (conflict) => !listedConflictIds.has(conflict.recordId),
        );

  return (
    <Section variant="card" title={SUMMARY_TITLE} headingLevel={2} gap={4} className={className}>
      {renderIdentity(session)}

      <Section title={PROGRESS_TITLE} headingLevel={3} gap={2}>
        {renderProgress(progress, status.progressExpected)}
      </Section>

      <Section title={INSTRUMENTATION_TITLE} headingLevel={3} gap={2}>
        {latestPlan === undefined ? null : (
          <Text as="p" size="sm" tone="secondary">
            {`Plan ${String(latestPlan.planVersion)}: ${latestPlan.objective}`}
          </Text>
        )}
        {instrumentationFailure === undefined ? null : (
          <ErrorState
            title={INSTRUMENTATION_FAILED_TITLE}
            message={instrumentationFailure.message}
            hint={instrumentationFailure.hint}
            code={instrumentationFailure.code}
            announce="polite"
          />
        )}
        {renderModifications(modifications, conflictRowKeys, conflictsByRecord, {
          failed: instrumentationFailure !== undefined,
          awaitingReport,
        })}
      </Section>

      <Section title={SIGNALS_TITLE} headingLevel={3} gap={2}>
        {renderSignals({
          runtimeHooks: enabledHooks,
          unavailable,
          appliedCount,
          failed: instrumentationFailure !== undefined,
          awaitingReport,
        })}
      </Section>

      {effectiveCleanup === undefined ? null : (
        <Section title={CLEANUP_TITLE} headingLevel={3} gap={2}>
          {renderCleanup({
            status: effectiveCleanup.status,
            conflictCount: effectiveCleanup.conflicts.length,
            completedAt:
              effectiveCleanup.status === recordCleanup.status
                ? recordCleanup.completedAt
                : undefined,
            unlistedConflicts,
          })}
        </Section>
      )}
    </Section>
  );
}
