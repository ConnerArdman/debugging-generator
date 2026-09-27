/**
 * `ModificationsList` — every file the session instrumented, its journal status
 * and the exact diff that was applied (AAP 0.7.3: "file, status badge
 * applied/reverted/conflict, 'View diff' → `DiffView`"), and, for a file edited
 * while instrumented, AAP 0.5.5's conflict message with its "Open diff"
 * action.
 *
 * This is the editor-side half of a product guarantee: every modification the
 * tool makes to the developer's working tree is recorded before it is written
 * and stays visible while the session runs and after it ends (AAP 0.5.1). A
 * change the developer cannot see here is a change they cannot trust, so the
 * component renders one row for every record it is given — none is hidden,
 * grouped away or collapsed into a count — and says so when the journal holds
 * records it was not given.
 *
 * ## Data in, two callbacks out
 *
 * `props.modifications` is `WebviewState.modifications`: the session's
 * `ModificationRecord[]`, which the host keeps from the session record, from
 * `instrumentation.ready` / `cleanup.completed` and from its reads of the paged
 * journal. The rows appear in exactly that order — the order the
 * installer applied the plan in, which is meaningful when a follow-up layers a
 * second record onto the same file — and are never re-sorted. `DataTable` is
 * controlled and never re-orders rows itself, so passing the array through is
 * both the simplest and the faithful choice.
 *
 * `props.total` is `WebviewState.modificationsTotal`: the journal's length as
 * the service last counted it. When it exceeds the rows given, the list is
 * incomplete, and the component states "Showing ‹N› of ‹M› recorded file
 * modifications" instead of letting the rows pass for the whole journal.
 *
 * Two interactions leave this component. `onOpenFile(file)` is raised with the
 * record's `file` **exactly as received**: a project-relative POSIX path, with
 * no workspace root prepended and no line appended; containment is enforced
 * downstream, where a file-system decision belongs. `onLoadMore()`, the
 * missing-records warning's "Load all modifications" control, asks for the
 * whole journal. `App.tsx` owns the host bridge and turns each into its
 * request. Nothing here fetches, posts a host message or opens a socket: the
 * diff arrives on the record.
 *
 * ## The one piece of local state
 *
 * Which row's diff is open — a single record id, or none. It is transient
 * presentation, so it lives here rather than in the host's snapshot. "View diff"
 * ("Open diff" on a conflict row) toggles it through a functional update, so
 * activating the same row twice
 * always ends collapsed and activating another row moves the disclosure there.
 * The grid's own keyboard toggle (Arrow Right / Arrow Left on a row) drives the
 * same state through `onRowToggle`.
 *
 * ## Structure and the design system (AAP 0.6.2, 0.6.4)
 *
 * ```text
 * div.dgv-modifications                     root, in every state
 *   Stack                                   only while records are missing
 *     Text sm warning (p, role=status)      Showing ‹N› of ‹M› recorded …
 *     Button secondary sm                   Load all modifications (with onLoadMore)
 *   DataTable (compact, caption hidden)     role=grid, owned by the primitive
 *     File   (rowheader)                    Stack .dgv-modifications__identity
 *       Code sm                             .dgv-modifications__file — the path, as
 *         span, span                        __directory (ellipsizes first) + __name
 *       Stack horizontal                    .dgv-modifications__meta — plan version, time
 *       Text xs                             .dgv-modifications__note — status explanation;
 *         Code sm wrap (×2)                 for a conflict, its file and backup path
 *     Status                                Badge soft — tone AND text label
 *     Actions                               Stack .dgv-modifications__actions
 *       Button ghost sm                     View diff (Open diff for a conflict) /
 *                                           Hide diff (disclosure)
 *       Button ghost sm                     Open file (only with onOpenFile)
 *     detail row (aria-colspan)             Stack .dgv-modifications__detail
 *       Stack horizontal                    .dgv-modifications__hashes
 *       DiffView                            the recorded unified diff, verbatim
 * ```
 *
 * `DataTable` owns the whole ARIA grid — `role="grid"`, exact
 * `aria-rowcount`/`aria-colcount`, `rowheader`/`gridcell`, the roving tab stop
 * and the `aria-colspan` detail row — so this component adds no role of its
 * own inside it; the one role it does add, the warning's `status`, sits
 * outside the grid, and so does its control, an ordinary Tab stop. It meets
 * the primitive's two caller obligations: every control rendered in a cell or
 * in the detail row is `tabIndex={-1}` — the diff's region
 * included, through `DiffView`'s `innerTabIndex` — (the grid is one Tab stop,
 * and its arrow keys reach the controls), and the disclosure button carries
 * `aria-expanded={meta.expanded}` and `aria-controls={meta.detailRowId}`,
 * because `aria-expanded` is not valid on a `grid` row. Each button's accessible
 * name starts with its visible text and ends with the record's file, so a
 * screen-reader user hears which row it acts on.
 *
 * Column geometry is expressed only as `DataTable` width roles in the columns'
 * `width`, which the primitive resolves to token-built grid tracks, never as a
 * length literal; every other value resolves through the `dgv-modifications`
 * block of `../styles.css` to a `--dg-*` token. `clsx` is not a dependency of
 * this workspace, so class names are joined by a local helper.
 *
 * ## Status vocabulary (AAP 0.5.1)
 *
 * The five journal statuses — `pending`, `applied`, `reverted`, `conflict`,
 * `failed` — are a closed vocabulary. Their tones are the design system's
 * shared `MODIFICATION_STATUS_TONE`, the same table the DevTools panel's
 * `SessionSummary` draws from, adopted as an exhaustive `Record` over the
 * protocol's union; their words sit in a `switch` closed by `assertNever`. A
 * status added to the schema is therefore a compile error here rather than an
 * unstyled, unexplained pill. Colour is never the only carrier: every badge
 * has its text label.
 *
 * A `conflict` row says what the product did, in the row itself and in AAP
 * 0.5.5's words: "‹file› was edited while instrumented. Debug Generator will
 * not overwrite it. Original saved at ‹backup path›." — the file and the
 * backup path taken from the record, never constructed. It never says the
 * file was reverted. That keeps each row consistent with the session's cleanup
 * outcome, which `App.tsx` shows on its own and this component does not
 * restate (AAP 0.5.1, 0.5.5). The message's "Open diff" action is the row's
 * disclosure, labelled for it: it opens the recorded diff in the row's detail,
 * which is also where the editor's other "Open diff" actions lead.
 *
 * ## States (AAP 0.5.5 — never a blank area)
 *
 * Fixed precedence, highest first: `error` > `pending` > incomplete and
 * empty > empty > the table, above which the missing-records warning stands
 * while the list is incomplete. A failure is never shown as an empty list, a
 * load never flashes the empty message, and a list whose records have not
 * arrived never claims that no file was modified: with no rows and a `total`
 * above zero, the warning stands in for the empty state. `ErrorState`, `LoadingState` and
 * `EmptyState` own their live-region roles (`alert`, `status` with
 * `aria-busy`, `status`); the warning is a polite `status` line of its own.
 * The empty state is the component's own `EmptyState` rather than
 * `DataTable`'s: a runtime-only plan modifies no file, which is the good
 * outcome, so it is worded neutrally and renders without an empty grid header
 * above it.
 *
 * ## Privacy and neutrality (AAP 0.5.2, 0.5.4)
 *
 * Diffs contain source code; hashes and the backup path are local file-system
 * details. They are rendered from the record as received and are never logged —
 * this module writes nothing to any console — and nothing is constructed that
 * the record does not carry. Every project-specific string comes from the
 * records; the only copy this file owns is generic product vocabulary.
 *
 * @module apps/vscode-extension/src/webview/components/ModificationsList
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import {
  Badge,
  Button,
  Code,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  MODIFICATION_STATUS_TONE,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import type { BadgeTone, DataTableColumn } from '@debuggen/panel-renderer';
import type { ModificationRecord } from '@debuggen/protocol';
import { assertNever } from '@debuggen/shared';

import { DiffView } from './DiffView';

/**
 * The props of {@link ModificationsList}.
 *
 * Every optional member spells `| undefined` because `exactOptionalPropertyTypes`
 * is in force repository-wide, and `App.tsx` forwards values it may not have —
 * `error={state.modificationsError}` — straight through.
 */
export interface ModificationsListProps {
  /**
   * The session's modification records, in the order they were applied.
   * Rendered one row per record, in exactly this order.
   */
  modifications: readonly ModificationRecord[];

  /**
   * Raised by a row's "Open file" control with that record's `file` unchanged —
   * the project-relative POSIX path the host resolves and opens. The control is
   * rendered only when this is supplied.
   */
  onOpenFile?: ((file: string) => void) | undefined;

  /**
   * The records are still being resolved: renders the loading silhouette in
   * place of the table. Outranked only by {@link ModificationsListProps.error}.
   */
  pending?: boolean | undefined;

  /**
   * Why the records could not be shown, as the layer that observed the failure
   * worded it. A non-blank value renders the error state, which outranks every
   * other state.
   */
  error?: string | undefined;

  /**
   * Asks for the failed step to be tried again. The error state renders its
   * retry control only when this is supplied.
   */
  onRetry?: (() => void) | undefined;

  /**
   * How many records the session's journal holds, as the service last counted
   * it (`WebviewState.modificationsTotal`). A value above the length of
   * {@link ModificationsListProps.modifications} means records are missing:
   * the component states how many of them are shown, and never says that no
   * file was modified.
   */
  total?: number | undefined;

  /**
   * Asks the host to load the whole journal. Rendered as the "Load all
   * modifications" control of the missing-records warning, only when this is
   * supplied.
   */
  onLoadMore?: (() => void) | undefined;

  /**
   * A load asked for through {@link ModificationsListProps.onLoadMore} is in
   * flight: its control is disabled until the host answers.
   */
  loadingMore?: boolean | undefined;

  /**
   * Extra classes for the root element, applied in every state and composed
   * after this component's own `dgv-modifications`.
   */
  className?: string | undefined;
}

/** A record's journal status — the closed vocabulary of AAP 0.5.1. */
type Status = ModificationRecord['status'];

/**
 * The badge tone of each status: the design system's shared
 * `MODIFICATION_STATUS_TONE`, so a status is drawn in the same colour here and
 * in the DevTools panel's `SessionSummary`. The renderer keys that table by the
 * five status literals; annotating it with the protocol's union here makes a
 * status added upstream a compile error until the shared table covers it, as
 * it is in {@link describeStatus}.
 *
 * `pending` is neutral, `applied` is informational (instrumentation is
 * present, as intended), `reverted` is the verified successful end state,
 * `conflict` is a warning — the product refused to overwrite the developer's
 * edit, which needs attention but is not a failure — and `failed` is the
 * danger.
 */
const STATUS_TONE: Readonly<Record<Status, BadgeTone>> = MODIFICATION_STATUS_TONE;

/** The words that accompany a status: its badge label and an optional note. */
interface StatusWords {
  /** The badge's text label; colour never carries the status alone. */
  readonly label: string;

  /**
   * One sentence explaining a status that needs it, shown under the file path.
   * Absent for `applied` and `reverted`, whose labels say everything, and for
   * `conflict`, whose explanation names the record's own file and backup path
   * and is therefore composed from the record by {@link ConflictNote}.
   */
  readonly note?: string | undefined;
}

/**
 * Resolves the words for a status.
 *
 * Closed by {@link assertNever}: the compiler proves every member handled, and
 * a value outside the union — a record from a newer service that the protocol
 * boundary somehow let through — fails loudly here instead of rendering as a
 * blank badge.
 *
 * @param status The record's status.
 * @returns The badge label and, where one is warranted, the explanatory note.
 */
function describeStatus(status: Status): StatusWords {
  switch (status) {
    case 'pending':
      return {
        label: 'Pending',
        note: 'Recorded before writing; the change has not been confirmed as applied yet.',
      };
    case 'applied':
      return { label: 'Applied' };
    case 'reverted':
      return { label: 'Reverted' };
    case 'conflict':
      return { label: 'Conflict' };
    case 'failed':
      return {
        label: 'Failed',
        note: 'This change could not be completed.',
      };
    default:
      return assertNever(status, 'Unhandled modification status');
  }
}

/** The root class, present in every state. */
const ROOT_CLASS = 'dgv-modifications';

/**
 * The grid's accessible name. Hidden on the surface: the section around this
 * component carries the visible heading, and a second line would repeat it.
 */
const CAPTION = 'Modified files';

/**
 * The empty-state sentence. Neutral by design — a plan that relies on runtime
 * hooks alone modifies nothing, which is the good outcome — and generic, since
 * `EmptyState` ships no default copy precisely so no project vocabulary can
 * leak into it.
 */
const EMPTY_MESSAGE = 'No files were modified for this session.';

/** The error-state title; the caller's message beneath it says why. */
const ERROR_TITLE = 'Could not show the modified files';

/** The visible text of the control that asks the host for the whole journal. */
const LOAD_ALL_LABEL = 'Load all modifications';

/**
 * The missing-records warning: how many of the journal's records are shown.
 * Generic product copy, true however the records went missing.
 *
 * @param shown How many records the list renders.
 * @param total How many the journal holds.
 * @returns The sentence.
 */
function shortfallMessage(shown: number, total: number): string {
  const noun = total === 1 ? 'file modification' : 'file modifications';
  return `Showing ${String(shown)} of ${String(total)} recorded ${noun}; the rest have not been loaded.`;
}

/** Announced, never painted, while the records are resolving. */
const LOADING_LABEL = 'Loading modified files';

/** How many skeleton rows the loading silhouette draws. */
const LOADING_ROWS = 3;

/** Column headers. Plain text, so each is also its column's accessible name. */
const HEADER_FILE = 'File';
const HEADER_STATUS = 'Status';
const HEADER_ACTIONS = 'Actions';

/**
 * The disclosure control's visible text in each state. A collapsed `conflict`
 * row reads "Open diff", the recovery action AAP 0.5.5 attaches to its
 * message; every other collapsed row reads "View diff". Expanded, every row
 * reads "Hide diff".
 */
const VIEW_DIFF_LABEL = 'View diff';
const OPEN_DIFF_LABEL = 'Open diff';
const HIDE_DIFF_LABEL = 'Hide diff';

/** The open-file control's visible text. */
const OPEN_FILE_LABEL = 'Open file';

/**
 * The connectives of AAP 0.5.5's conflict message — "‹file› was edited while
 * instrumented. Debug Generator will not overwrite it. Original saved at
 * ‹backup path›." — the only words of that sentence this file supplies. The
 * file and the backup path come from the record.
 */
const CONFLICT_EDITED = ' was edited while instrumented. Debug Generator will not overwrite it.';
const CONFLICT_SAVED_AT = ' Original saved at ';
const CONFLICT_END = '.';

/** Shown in the meta line of a record layered on an earlier record's result. */
const LAYERED_LABEL = 'Layered on an earlier change';

/** Leads the formatted time in the meta line. */
const RECORDED_LABEL = 'Recorded';

/** Labels of the two content hashes in the detail row. */
const ORIGINAL_HASH_LABEL = 'Original SHA-256';
const INSTRUMENTED_HASH_LABEL = 'Instrumented SHA-256';

/**
 * How many leading hexadecimal digits of a hash are shown, the convention
 * version-control tools use for an abbreviated digest. The full value stays in
 * the element's tooltip.
 */
const SHORT_HASH_LENGTH = 12;

/**
 * Formats a record's time for the meta line in the reader's own locale and
 * time zone — the webview's, which is the editor's.
 */
const RECORDED_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * Joins class names, dropping absent and blank parts, so a caller's empty
 * `className` never leaves a stray space in the attribute.
 *
 * @param parts The class names, in cascade order.
 * @returns The space-separated class attribute value.
 */
function joinClassNames(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.trim() !== '').join(' ');
}

/**
 * Whether an optional string carries anything to render.
 *
 * @param value The value as received.
 * @returns `true` for a string with at least one non-whitespace character.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/** A record's time, ready for a `<time>` element. */
interface RecordedTime {
  /** The machine-readable instant, for the `dateTime` attribute. */
  readonly iso: string;
  /** The localized display text. */
  readonly text: string;
}

/**
 * Formats a record's epoch-millisecond timestamp.
 *
 * @param epochMs The record's `appliedAt`.
 * @returns The instant in both forms, or `undefined` for a value no `Date` can
 *   represent — which then renders nothing rather than "Invalid Date" or a
 *   thrown `RangeError`.
 */
function formatRecordedAt(epochMs: number): RecordedTime | undefined {
  if (!Number.isFinite(epochMs)) {
    return undefined;
  }

  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return { iso: date.toISOString(), text: RECORDED_FORMAT.format(date) };
}

/**
 * Abbreviates a content hash for display. Presentation only: the full value is
 * never altered, and it stays available as the element's tooltip.
 *
 * @param hash The record's SHA-256 digest.
 * @returns Its first {@link SHORT_HASH_LENGTH} characters.
 */
function shortHash(hash: string): string {
  return hash.slice(0, SHORT_HASH_LENGTH);
}

/** A project-relative path split for display at its last separator. */
interface PathParts {
  /** Everything up to and including the last `/`; empty for a bare name. */
  readonly directory: string;
  /** The file name after the last `/`. */
  readonly name: string;
}

/**
 * Splits a path into its directory and file name, for display only.
 *
 * Joining the two parts always gives back the path exactly, so the rendered
 * text stays byte-faithful; the split exists so the stylesheet can ellipsize
 * the directory first and keep the file name — the part that tells rows apart
 * in a narrow view — visible.
 *
 * @param file The record's project-relative POSIX path.
 * @returns The two parts.
 */
function splitPath(file: string): PathParts {
  const cut = file.lastIndexOf('/') + 1;
  return { directory: file.slice(0, cut), name: file.slice(cut) };
}

/**
 * A conflicting record's explanation, in the row itself: AAP 0.5.5's message
 * "‹file› was edited while instrumented. Debug Generator will not overwrite
 * it. Original saved at ‹backup path›." — the row's text content is exactly
 * that sentence.
 *
 * The file and the backup path are the record's own values, each rendered
 * through `Code wrap`, so they are byte-faithful and break across lines in a
 * narrow view instead of being clipped. The schema requires a non-blank backup
 * path; should a record arrive without one anyway, only the "Original saved
 * at …" sentence is left out — a path is never constructed or guessed. The
 * message says what the product did and never that the file was reverted,
 * which keeps the row consistent with the session's cleanup outcome.
 */
function ConflictNote(props: { readonly record: ModificationRecord }): ReactElement {
  const { record } = props;

  return (
    <Text size="xs" tone="secondary" className="dgv-modifications__note">
      <Code size="sm" wrap>
        {record.file}
      </Code>
      {CONFLICT_EDITED}
      {hasText(record.backupPath) ? (
        <>
          {CONFLICT_SAVED_AT}
          <Code size="sm" wrap>
            {record.backupPath}
          </Code>
          {CONFLICT_END}
        </>
      ) : null}
    </Text>
  );
}

/**
 * The explanatory note under a record's path: the conflict message for a
 * `conflict`, the status's own sentence for `pending` and `failed`, and
 * nothing for `applied` and `reverted`, whose labels say everything.
 */
function RecordNote(props: { readonly record: ModificationRecord }): ReactElement | null {
  const { record } = props;
  if (record.status === 'conflict') {
    return <ConflictNote record={record} />;
  }

  const { note } = describeStatus(record.status);
  if (note === undefined) {
    return null;
  }

  return (
    <Text size="xs" tone="secondary" className="dgv-modifications__note">
      {note}
    </Text>
  );
}

/**
 * The identity cell: the path, the meta line and — for a status that needs it —
 * the explanatory note.
 *
 * The path renders through `Code`, which is byte-faithful: its text is the
 * record's `file` exactly, in two spans so a long directory is shortened
 * visually by the stylesheet's ellipsis before the file name is, never by
 * slicing the string. The full value stays in the accessibility tree and the
 * tooltip.
 */
function RecordIdentity(props: { readonly record: ModificationRecord }): ReactElement {
  const { record } = props;
  const recorded = formatRecordedAt(record.appliedAt);
  const path = splitPath(record.file);

  return (
    <Stack gap={0} className="dgv-modifications__identity">
      <Code size="sm" className="dgv-modifications__file" title={record.file}>
        {path.directory === '' ? null : (
          <span className="dgv-modifications__directory">{path.directory}</span>
        )}
        <span className="dgv-modifications__name">{path.name}</span>
      </Code>
      <Stack direction="horizontal" gap={2} wrap align="center" className="dgv-modifications__meta">
        <Text size="xs" tone="secondary">
          Plan v{String(record.planVersion)}
        </Text>
        {record.previousRecordId === undefined ? null : (
          <Text size="xs" tone="secondary">
            {LAYERED_LABEL}
          </Text>
        )}
        {recorded === undefined ? null : (
          <Text size="xs" tone="secondary">
            {RECORDED_LABEL} <time dateTime={recorded.iso}>{recorded.text}</time>
          </Text>
        )}
      </Stack>
      <RecordNote record={record} />
    </Stack>
  );
}

/**
 * The status cell: a soft badge whose tone and text label both carry the
 * status, so colour is never its only signal.
 */
function RecordStatus(props: { readonly status: Status }): ReactElement {
  const { label } = describeStatus(props.status);

  return (
    <Badge tone={STATUS_TONE[props.status]} variant="soft">
      {label}
    </Badge>
  );
}

/**
 * One labelled, abbreviated hash in the detail row, or nothing for a blank
 * value.
 */
function HashItem(props: { readonly label: string; readonly hash: string }): ReactElement | null {
  if (!hasText(props.hash)) {
    return null;
  }

  return (
    <Text size="xs" tone="secondary">
      {props.label}{' '}
      <Code size="sm" title={props.hash}>
        {shortHash(props.hash)}
      </Code>
    </Text>
  );
}

/**
 * The detail row of an expanded record: the two content hashes the journal
 * recorded, and the diff.
 *
 * A conflicting record's backup path is not repeated here: the row itself
 * already states where the original is saved (see {@link ConflictNote}).
 *
 * `innerTabIndex={-1}` makes every focusable element `DiffView` renders - its
 * labelled `<pre>` region and the controls that move a long diff's window of
 * lines - `tabIndex={-1}`, as `DataTable` requires of every control in a
 * detail row. That is the grid's navigation model, not an exclusion from it:
 * the grid is one Tab stop, and from the row ArrowRight expands the diff and
 * then walks the row's controls in document order onto the window controls,
 * when there are any, and then the region, which keeps the horizontal keys to
 * scroll a wide line.
 */
function RecordDetail(props: { readonly record: ModificationRecord }): ReactElement {
  const { record } = props;

  return (
    <Stack gap={2} className="dgv-modifications__detail">
      <Stack direction="horizontal" gap={3} wrap className="dgv-modifications__hashes">
        <HashItem label={ORIGINAL_HASH_LABEL} hash={record.originalHash} />
        <HashItem label={INSTRUMENTED_HASH_LABEL} hash={record.instrumentedHash} />
      </Stack>
      <DiffView diff={record.diff} fileLabel={record.file} innerTabIndex={-1} />
    </Stack>
  );
}

/**
 * The detail renderer handed to `DataTable`. Module-level, so its identity is
 * stable across renders.
 */
function renderRecordDetail(record: ModificationRecord): ReactElement {
  return <RecordDetail record={record} />;
}

/**
 * A record's row identity: its journal id, which is unique and derived from the
 * record itself, so the expansion survives any re-render of the list.
 */
function recordKey(record: ModificationRecord): string {
  return record.id;
}

/**
 * Builds the three columns.
 *
 * Each width is the `DataTable` role for the column's content, never a length
 * (AAP 0.6.4). The file column is a `name`: the path is the row's identity, so
 * it takes the largest share of spare width, and it truncates from the
 * directory end to keep the file name. The status column is a `status` badge.
 * The actions column is `status` too, the role for compact action controls:
 * its two buttons wrap onto a second line when the track is narrower than
 * both. Every role has a non-zero floor, so a view narrower than the three
 * floors together scrolls the table horizontally rather than painting one
 * cell over the next. The file and status columns take the same roles as the
 * DevTools panel's modification grid, so the two surfaces size the same
 * content alike.
 *
 * @param toggle Opens or closes a record's diff by id.
 * @param onOpenFile The caller's open-file callback; the open control renders
 *   only when it is supplied.
 * @returns The columns, left to right.
 */
function buildColumns(
  toggle: (id: string) => void,
  onOpenFile: ((file: string) => void) | undefined,
): readonly DataTableColumn<ModificationRecord>[] {
  return [
    {
      key: 'file',
      header: HEADER_FILE,
      rowHeader: true,
      width: 'name',
      cell: (record) => <RecordIdentity record={record} />,
    },
    {
      key: 'status',
      header: HEADER_STATUS,
      width: 'status',
      cell: (record) => <RecordStatus status={record.status} />,
    },
    {
      key: 'actions',
      header: HEADER_ACTIONS,
      width: 'status',
      cell: (record, _rowIndex, meta) => {
        // A conflict's disclosure is AAP 0.5.5's "Open diff" recovery action:
        // the diff it opens is this row's own detail, the same destination the
        // editor's other "Open diff" actions (the end-session notice and
        // `debuggen.showModifications`) reveal. It is the same toggle as every
        // other row's, so no host message is involved.
        const collapsedLabel = record.status === 'conflict' ? OPEN_DIFF_LABEL : VIEW_DIFF_LABEL;
        const diffLabel = meta.expanded ? HIDE_DIFF_LABEL : collapsedLabel;

        return (
          <Stack
            direction="horizontal"
            gap={1}
            wrap
            align="center"
            className="dgv-modifications__actions"
          >
            <Button
              variant="ghost"
              size="sm"
              tabIndex={-1}
              aria-label={`${diffLabel} of ${record.file}`}
              aria-expanded={meta.expanded}
              aria-controls={meta.detailRowId}
              onClick={() => {
                toggle(record.id);
              }}
            >
              {diffLabel}
            </Button>
            {onOpenFile === undefined ? null : (
              <Button
                variant="ghost"
                size="sm"
                tabIndex={-1}
                aria-label={`${OPEN_FILE_LABEL} ${record.file}`}
                onClick={() => {
                  onOpenFile(record.file);
                }}
              >
                {OPEN_FILE_LABEL}
              </Button>
            )}
          </Stack>
        );
      },
    },
  ];
}

/** The props of {@link JournalShortfall}. */
interface JournalShortfallProps {
  /** How many records the list renders. */
  readonly shown: number;
  /** How many the journal holds; greater than `shown`. */
  readonly total: number;
  /** Asks the host for the whole journal; the control renders only with it. */
  readonly onLoadMore: (() => void) | undefined;
  /** Whether that request is in flight. */
  readonly loadingMore: boolean;
}

/**
 * The missing-records warning: a polite status line saying how many of the
 * journal's records are shown, and — when the caller can ask the host for the
 * rest — the "Load all modifications" control, disabled while that load is in
 * flight. The control sits outside the grid, so it is an ordinary Tab stop.
 * The tone reinforces the words; it never carries the warning alone.
 */
function JournalShortfall(props: JournalShortfallProps): ReactElement {
  const { shown, total, onLoadMore, loadingMore } = props;

  return (
    <Stack gap={2} align="start">
      <Text as="p" size="sm" tone="warning" role="status">
        {shortfallMessage(shown, total)}
      </Text>
      {onLoadMore === undefined ? null : (
        <Button
          variant="secondary"
          size="sm"
          disabled={loadingMore}
          aria-busy={loadingMore}
          onClick={() => {
            onLoadMore();
          }}
        >
          {LOAD_ALL_LABEL}
        </Button>
      )}
    </Stack>
  );
}

/**
 * Renders the session's modification records as a grid with one row per
 * record and an expandable diff, or the error, loading or empty state in its
 * place, and warns — above the grid, or instead of the empty state — when the
 * journal holds records the list does not.
 *
 * @param props See {@link ModificationsListProps}.
 * @returns One root element carrying `dgv-modifications` and `props.className`,
 *   holding the table or the state primitive that stands in for it.
 */
export function ModificationsList(props: ModificationsListProps): ReactElement {
  const {
    modifications,
    onOpenFile,
    pending = false,
    error,
    onRetry,
    total,
    onLoadMore,
    loadingMore = false,
    className,
  } = props;

  // Hooks run before any branch, as they must. The expanded id is the only
  // local state: which record's diff is open, or none.
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);

  const toggle = useCallback((id: string): void => {
    setExpandedId((current) => (current === id ? undefined : id));
  }, []);

  const handleRowToggle = useCallback(
    (record: ModificationRecord): void => {
      toggle(record.id);
    },
    [toggle],
  );

  const expandedRowKeys = useMemo<readonly string[]>(
    () => (expandedId === undefined ? [] : [expandedId]),
    [expandedId],
  );

  const columns = useMemo(() => buildColumns(toggle, onOpenFile), [toggle, onOpenFile]);

  // Records the journal holds that the list does not: stated, never hidden.
  const shortfall =
    total !== undefined && total > modifications.length ? (
      <JournalShortfall
        shown={modifications.length}
        total={total}
        onLoadMore={onLoadMore}
        loadingMore={loadingMore}
      />
    ) : null;

  let body: ReactElement;
  if (hasText(error)) {
    body = <ErrorState message={error} title={ERROR_TITLE} onRetry={onRetry} />;
  } else if (pending) {
    body = <LoadingState variant="rows" rows={LOADING_ROWS} label={LOADING_LABEL} />;
  } else if (modifications.length === 0) {
    // With records missing, an empty list is not "nothing was modified".
    body = shortfall ?? <EmptyState message={EMPTY_MESSAGE} />;
  } else {
    const table = (
      <DataTable
        rows={modifications}
        columns={columns}
        rowKey={recordKey}
        caption={CAPTION}
        compact
        expandedRowKeys={expandedRowKeys}
        onRowToggle={handleRowToggle}
        renderExpandedRow={renderRecordDetail}
      />
    );
    body =
      shortfall === null ? (
        table
      ) : (
        <Stack gap={2}>
          {shortfall}
          {table}
        </Stack>
      );
  }

  return <div className={joinClassNames(ROOT_CLASS, className)}>{body}</div>;
}
