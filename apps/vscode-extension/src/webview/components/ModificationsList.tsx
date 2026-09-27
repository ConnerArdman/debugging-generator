/**
 * `ModificationsList` — every file the session instrumented, its journal status
 * and the exact diff that was applied (AAP 0.7.3: "file, status badge
 * applied/reverted/conflict, 'View diff' → `DiffView`"), and, for a file edited
 * while instrumented, AAP 0.5.5's conflict message with its "Open diff"
 * action, which shows the developer's edit.
 *
 * This is the editor-side half of a product guarantee: every modification the
 * tool makes to the developer's working tree is recorded before it is written
 * and stays visible while the session runs and after it ends (AAP 0.5.1). A
 * change the developer cannot see here is a change they cannot trust, so the
 * component renders one item for every record it is given — none is hidden,
 * grouped away or collapsed into a count — and says so when the journal holds
 * records it was not given.
 *
 * ## Data in, two callbacks out
 *
 * `props.modifications` is `WebviewState.modifications`: the session's
 * `ModificationRecord[]`, which the host keeps from the session record, from
 * `instrumentation.ready` / `cleanup.completed` and from its reads of the paged
 * journal. The items appear in exactly that order — the order the installer
 * applied the plan in, which is meaningful when a follow-up layers a second
 * record onto the same file — and are never re-sorted.
 *
 * `props.conflicts` is `WebviewState.cleanup.conflicts`: the service's
 * `ModificationConflict` for each record it refused to overwrite, delivered
 * while the session runs (the conflict watcher updates the session record) and
 * with `cleanup.completed`. It is matched to a record by `recordId`, and it is
 * what lets a conflict item say why the file was left alone and show the edit
 * itself (`diffs.instrumentedToCurrent`) rather than the tool's own change.
 *
 * `props.total` is `WebviewState.modificationsTotal`: the journal's length as
 * the service last counted it. When it exceeds the records given, the list is
 * incomplete, and the component states "Showing ‹N› of ‹M› recorded file
 * modifications" instead of letting the items pass for the whole journal.
 *
 * Two interactions leave this component. `onOpenFile(file)` is raised with the
 * record's `file` **exactly as received**: a project-relative POSIX path, with
 * no workspace root prepended and no line appended; containment is enforced
 * downstream, where a file-system decision belongs. `onLoadMore()`, the
 * missing-records warning's "Load all modifications" control, asks for the
 * whole journal. `App.tsx` owns the host bridge and turns each into its
 * request. Nothing here fetches, posts a host message or opens a socket: every
 * diff arrives on the record or its conflict. "Copy path" writes a backup path
 * to the clipboard from the click itself (see {@link CopyPathButton}).
 *
 * ## The one piece of local state
 *
 * Which diff is open — a record id and which of its diffs, or none. It is
 * transient presentation, so it lives here rather than in the host's snapshot.
 * Every item's "View diff" opens the change Debug Generator made; a conflict
 * item's "Open diff" opens the developer's edit on top of it. Each control is a
 * disclosure driven through a functional update, so activating the same control
 * twice always ends collapsed and activating another one moves the disclosure
 * there: one diff is open at a time.
 *
 * ## Structure and the design system (AAP 0.6.2, 0.6.4)
 *
 * ```text
 * div.dgv-modifications                     root, in every state
 *   Stack                                   only while records are missing
 *     Text sm warning (p, role=status)      Showing ‹N› of ‹M› recorded …
 *     Button secondary sm                   Load all modifications (with onLoadMore)
 *   ol.dgv-modifications__list              journal order is meaningful
 *     li.dgv-modifications__item            one per record, full width
 *       Stack                               .dgv-modifications__record
 *         Stack horizontal, wrapping        .dgv-modifications__head
 *           Text (visually hidden)          the path, whole — the item's name for AT
 *           Code sm, aria-hidden            .dgv-path — the path, middle-truncated:
 *             span, span > span, span       __lead + __tail (__context + __name)
 *           Badge soft                      .dgv-modifications__status — tone AND label
 *         Stack horizontal, wrapping        .dgv-modifications__meta — plan version, time
 *         div (Text sm)                     .dgv-modifications__note / __callout —
 *                                           the status explanation, full width; a
 *                                           conflict's or failure's callout carries
 *                                           its backup path and "Copy path"
 *         Stack horizontal, wrapping        .dgv-modifications__actions
 *           Button ghost sm                 Open diff / Hide diff (a conflict's edit)
 *           Button ghost sm                 View diff / Hide diff (the tool's change)
 *           Button ghost sm                 Open file (only with onOpenFile)
 *         div#detail                        .dgv-modifications__detail — while open
 *           Stack horizontal                .dgv-modifications__hashes (change only)
 *           DiffView                        the diff, verbatim, in the page's flow
 * ```
 *
 * The list is the page's own content, not a nested scroller: the webview's
 * `PanelShell` viewport is the one vertical scroll container, so every record
 * stays reachable however many there are, and an open diff is laid out at the
 * item's full width directly under the control that opened it, with no sticky
 * header over it and no capped viewport under it. The only other scroll axis is
 * the diff's own horizontal one, for a line wider than the view. Nothing in an
 * item has a width floor: the path truncates in the middle, the badge
 * wraps under the path when both do not fit, and the controls wrap under each
 * other — so the list fits the narrowest sidebar without a horizontal
 * scrollbar and no control is ever painted off-screen.
 *
 * Every control is an ordinary Tab stop, the diff's labelled `<pre>` region
 * included (`DiffView`'s default `innerTabIndex`), so a keyboard user reaches
 * each record's actions and scrolls a wide diff line with the arrow keys once
 * the region has focus. Each disclosure carries `aria-expanded` and, while its
 * diff is open, `aria-controls` naming the detail it opened. Each button's
 * accessible name starts with its visible text and ends with the record's
 * file, so a screen-reader user hears which record it acts on.
 *
 * Spacing is `Stack`'s; every other value resolves through the
 * `dgv-modifications` and `dgv-path` blocks of `../styles.css` to a `--dg-*`
 * token, and no length literal appears here. `clsx` is not a dependency of this
 * workspace, so class names are joined by a local helper.
 *
 * ## Paths that stay apart in a narrow column
 *
 * Two records often name files of one name — a route handler and its nested
 * route, two components in sibling directories. The path is therefore split
 * by `../path-display`'s `describePaths`, once per list, into a lead and the
 * shortest tail no other file of the list ends in, and rendered on the shared
 * `.dgv-path` contract: the lead ellipsizes first, then the tail's
 * directories, and the file name last, so every item keeps both what tells it
 * apart and its file name. A browser inserts spaces between the chip's flex
 * parts when it computes an accessible name from them, so the chip is
 * `aria-hidden` and a visually hidden copy of the whole path, byte for byte,
 * stands in for it in the accessibility tree; the chip's tooltip is the whole
 * path too.
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
 * has its text label, and every callout its sentence.
 *
 * A `conflict` item says what the product did, in AAP 0.5.5's words: "‹file›
 * was edited while instrumented. Debug Generator will not overwrite it.
 * Original saved at ‹backup path›." — the file and the backup path taken from
 * the record, never constructed. When the service reported a different reason
 * (the file was deleted, the backup could not be read, …) its own message is
 * shown instead, verbatim, because the edit sentence would then be untrue. It
 * never says the file was reverted, which keeps each item consistent with the
 * session's cleanup outcome that `App.tsx` shows on its own (AAP 0.5.1, 0.5.5).
 * A `failed` item says why it is not applied — the write stopped part-way —
 * and what cleanup will do about it, beside the saved original.
 *
 * ## States (AAP 0.5.5 — never a blank area)
 *
 * Fixed precedence, highest first: `error` > `pending` > incomplete and
 * empty > empty > the list, above which the missing-records warning stands
 * while the list is incomplete. A failure is never shown as an empty list, a
 * load never flashes the empty message, and a list whose records have not
 * arrived never claims that no file was modified: with no records and a
 * `total` above zero, the warning stands in for the empty state.
 * `ErrorState`, `LoadingState` and `EmptyState` own their live-region roles
 * (`alert`, `status` with `aria-busy`, `status`); the warning is a polite
 * `status` line of its own. The empty state is worded neutrally: a
 * runtime-only plan modifies no file, which is the good outcome. Before
 * instrumentation (`awaitingPlan`) the same state says that nothing has been
 * modified *yet*, because "no files were modified" is a verdict only an
 * applied plan can give.
 *
 * ## Privacy and neutrality (AAP 0.5.2, 0.5.4)
 *
 * Diffs contain source code; hashes and the backup path are local file-system
 * details. They are rendered from the record and its conflict as received and
 * are never logged — this module writes nothing to any console — and nothing
 * is constructed that they do not carry. A backup path reaches the clipboard
 * only from the developer's own click. Every project-specific string comes from
 * the records; the only copy this file owns is generic product vocabulary.
 *
 * @module apps/vscode-extension/src/webview/components/ModificationsList
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import {
  Badge,
  Button,
  Code,
  EmptyState,
  ErrorState,
  LoadingState,
  MODIFICATION_STATUS_TONE,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import type { BadgeTone } from '@debuggen/panel-renderer';
import type { ModificationConflict, ModificationRecord } from '@debuggen/protocol';
import { assertNever } from '@debuggen/shared';

import { describePath, describePaths } from '../path-display';
import type { PathDisplay } from '../path-display';
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
   * Rendered one item per record, in exactly this order.
   */
  modifications: readonly ModificationRecord[];

  /**
   * The service's conflict entries (`WebviewState.cleanup.conflicts`), matched
   * to a `conflict` record by `recordId`. They supply the reason a file was
   * left alone and the diff of the developer's edit that "Open diff" shows. A
   * conflict record without an entry still states AAP 0.5.5's message.
   */
  conflicts?: readonly ModificationConflict[] | undefined;

  /**
   * Raised by an item's "Open file" control with that record's `file`
   * unchanged — the project-relative POSIX path the host resolves and opens.
   * The control is rendered only when this is supplied.
   */
  onOpenFile?: ((file: string) => void) | undefined;

  /**
   * The records are still being resolved: renders the loading silhouette in
   * place of the list. Outranked only by {@link ModificationsListProps.error}.
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
   * The session has not reached instrumentation yet — its question is still
   * being understood, investigated or planned — so no modification can exist
   * so far. An empty list then says that files are modified only once the plan
   * is applied, instead of the final "no files were modified", which is only
   * true once instrumentation has run. Ignored whenever there is a record to
   * show, a missing-records warning, an error or a load in progress.
   *
   * @default false
   */
  awaitingPlan?: boolean | undefined;

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
   * One sentence explaining a status that needs it, shown under the path at
   * the item's full width. Absent for `applied` and `reverted`, whose labels
   * say everything, and for `conflict`, whose explanation names the record's
   * own file and backup path and is therefore composed from the record by
   * {@link ConflictCallout}.
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
 * The `failed` sentence is the reason the lifecycle gives a record that
 * status: the write sequence stopped part-way, after the original was saved and
 * before the change was confirmed, so the file may or may not hold it. What
 * cleanup does with such a record follows from its recorded hashes — the saved
 * original is restored over an instrumented file, and a file matching neither
 * is reported rather than overwritten — and the sentence says exactly that.
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
        note: 'Writing this change stopped part-way, before it was confirmed. Cleanup restores the saved original if the change reached the file, and reports the file instead of overwriting it if it no longer matches either version.',
      };
    default:
      return assertNever(status, 'Unhandled modification status');
  }
}

/**
 * A status's badge label — the same word an item's badge shows — for another
 * surface of this view that names a record's status, such as the session
 * cleanup summary in `App.tsx`.
 *
 * @param status The record's status.
 * @returns The label.
 */
export function modificationStatusLabel(status: Status): string {
  return describeStatus(status).label;
}

/** The root class, present in every state. */
const ROOT_CLASS = 'dgv-modifications';

/**
 * The list's accessible name. Not painted: the section around this component
 * carries the visible heading, and a second line would repeat it.
 */
const CAPTION = 'Modified files';

/**
 * The empty-state sentence. Neutral by design — a plan that relies on runtime
 * hooks alone modifies nothing, which is the good outcome — and generic, since
 * `EmptyState` ships no default copy precisely so no project vocabulary can
 * leak into it.
 */
const EMPTY_MESSAGE = 'No files were modified for this session.';

/**
 * The empty-state sentence before instrumentation (`awaitingPlan`): nothing has
 * been modified yet because nothing can have been — the plan that decides which
 * files, if any, to instrument does not exist yet. Generic product copy only.
 */
const AWAITING_PLAN_MESSAGE =
  'No files have been modified yet. Any file the instrumentation plan changes is listed here, with its diff, once the plan is applied.';

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

/**
 * The two disclosures' visible text. Every item's "View diff" opens the change
 * Debug Generator made (AAP 0.7.3); a conflict item's "Open diff" opens the
 * developer's edit, the recovery action AAP 0.5.5 attaches to the conflict
 * message. Two labels because they are two diffs, never one diff under two
 * names. Open, either reads "Hide diff".
 */
const VIEW_DIFF_LABEL = 'View diff';
const OPEN_DIFF_LABEL = 'Open diff';
const HIDE_DIFF_LABEL = 'Hide diff';

/** The open-file control's visible text. */
const OPEN_FILE_LABEL = 'Open file';

/**
 * What each diff compares, shown in the diff's header and in its region's
 * name, so the reader never has to infer which of a conflict's two diffs is on
 * screen.
 */
const CHANGE_SUBJECT = 'Change made by Debug Generator';
const EDIT_SUBJECT = 'Your edit since instrumentation';
const CURRENT_SUBJECT = 'Changes since the saved original';

/**
 * The connectives of AAP 0.5.5's conflict message — "‹file› was edited while
 * instrumented. Debug Generator will not overwrite it. Original saved at
 * ‹backup path›." — the only words of that sentence this file supplies. The
 * file and the backup path come from the record.
 */
const CONFLICT_EDITED = ' was edited while instrumented. Debug Generator will not overwrite it.';
const CONFLICT_SAVED_AT = ' Original saved at ';
const CONFLICT_END = '.';

/** Leads the saved original's path in a callout whose message does not name it. */
const SAVED_AT_LABEL = 'Original saved at ';

/**
 * Said under a file-edit conflict whose entry carries no diff of the edit — the
 * service omits a diff it could not produce or that exceeded its size bound,
 * and never shortens one — so the absent "Open diff" control is explained.
 */
const EDIT_UNAVAILABLE = 'A diff of the edit is not available.';

/** Shown in the meta line of a record layered on an earlier record's result. */
const LAYERED_LABEL = 'Layered on an earlier change';

/** Leads the formatted time in the meta line. */
const RECORDED_LABEL = 'Recorded';

/** Labels of the two content hashes in the detail. */
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

/** The copy control's visible text. */
const COPY_PATH_LABEL = 'Copy path';

/** Announced once a path is on the clipboard. */
const COPIED_MESSAGE = 'Copied.';

/**
 * Announced when the clipboard refused the write. The path's text is selected
 * instead, so the platform's own copy shortcut copies it.
 */
const COPY_FAILED_MESSAGE =
  'Could not copy. The path is selected; copy it with your copy shortcut.';

/**
 * How long "Copied." stays on screen, in milliseconds: long enough to be read,
 * short enough that a stale confirmation never sits beside a later copy. A
 * refusal stays until the next attempt, because it asks the reader to act.
 */
const COPIED_FEEDBACK_MS = 3000;

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

/**
 * The display split of every file the list names, looked up per item.
 *
 * Keyed by the record's `file` exactly as received; see `../path-display`.
 */
type PathDisplays = ReadonlyMap<string, PathDisplay>;

/**
 * The split of one record's file: its entry in the list's
 * {@link PathDisplays}, or — for a file the map was not built from, which an
 * item rendered from the same list never is — the split of the file alone, so
 * an item always renders its file name.
 *
 * @param displays The list's display splits.
 * @param file The record's project-relative POSIX path.
 * @returns The path's lead, context and file name.
 */
function displayOf(displays: PathDisplays, file: string): PathDisplay {
  return displays.get(file) ?? describePath(file);
}

/**
 * Writes `text` to the system clipboard.
 *
 * The asynchronous Clipboard API is available to a VS Code webview, whose
 * frames are granted `clipboard-write`, and it needs no host round trip. It is
 * still treated as fallible — a browser without it, a refused permission or a
 * document without focus all reject — so the caller always learns whether the
 * write happened and never claims a copy that did not occur.
 *
 * @param text The exact text to copy.
 * @returns Whether the clipboard accepted it.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  const clipboard = (window.navigator as { readonly clipboard?: Clipboard }).clipboard;
  if (clipboard === undefined) {
    return false;
  }

  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Selects the whole text of the element with `id`, so the platform's copy
 * shortcut copies it when the clipboard refused a direct write.
 *
 * @param id The element's id; nothing happens for an absent id or element.
 */
function selectTextOf(id: string | undefined): void {
  if (id === undefined) {
    return;
  }

  const element = document.getElementById(id);
  const selection = window.getSelection();
  if (element === null || selection === null) {
    return;
  }

  selection.selectAllChildren(element);
}

/** The props of {@link CopyPathButton}. */
export interface CopyPathButtonProps {
  /** The exact path to copy — a backup path as the record or conflict carries it. */
  readonly path: string;

  /**
   * The control's accessible name. It must begin with the visible "Copy path"
   * (WCAG 2.5.3) and should end with what the path belongs to, because a view
   * can hold several of these controls: "Copy path of the saved original of
   * ‹file›".
   */
  readonly accessibleLabel: string;

  /**
   * The id of the element that renders `path`. When the clipboard refuses the
   * write, that element's text is selected so the reader can copy it by hand.
   */
  readonly targetId?: string | undefined;
}

/** What the last copy attempt produced; `attempt` restarts the confirmation timer. */
interface CopyFeedback {
  readonly outcome: 'idle' | 'copied' | 'failed';
  readonly attempt: number;
}

/**
 * The "Copy path" control shown beside a saved original's path, and the polite
 * status line that says whether the copy happened.
 *
 * A backup path is long and absolute, so the view wraps it rather than
 * shortening it, and this control copies it byte for byte — the value a
 * developer needs to restore a file by hand after a conflict or a partial
 * cleanup. It is an ordinary Tab stop. Exported for `App.tsx`, whose session
 * cleanup summary lists the same paths.
 *
 * @param props See {@link CopyPathButtonProps}.
 * @returns The control and its status line.
 */
export function CopyPathButton(props: CopyPathButtonProps): ReactElement {
  const { path, accessibleLabel, targetId } = props;
  const [feedback, setFeedback] = useState<CopyFeedback>({ outcome: 'idle', attempt: 0 });

  // A write settles asynchronously; an item that unmounted meanwhile (the list
  // changed, the session was reset) must not receive its result.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (feedback.outcome !== 'copied') {
      return undefined;
    }

    const timer = setTimeout(() => {
      setFeedback((current) =>
        current.attempt === feedback.attempt
          ? { outcome: 'idle', attempt: current.attempt }
          : current,
      );
    }, COPIED_FEEDBACK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [feedback]);

  const handleCopy = (): void => {
    void writeToClipboard(path).then((copied) => {
      if (!mountedRef.current) {
        return;
      }
      if (!copied) {
        selectTextOf(targetId);
      }
      setFeedback((current) => ({
        outcome: copied ? 'copied' : 'failed',
        attempt: current.attempt + 1,
      }));
    });
  };

  const message =
    feedback.outcome === 'copied'
      ? COPIED_MESSAGE
      : feedback.outcome === 'failed'
        ? COPY_FAILED_MESSAGE
        : '';

  return (
    <Stack direction="horizontal" gap={1} wrap align="center" className="dgv-copy-path">
      <Button variant="ghost" size="sm" aria-label={accessibleLabel} onClick={handleCopy}>
        {COPY_PATH_LABEL}
      </Button>
      <Text
        size="xs"
        tone={feedback.outcome === 'failed' ? 'warning' : 'secondary'}
        role="status"
        className="dgv-copy-path__status"
      >
        {message}
      </Text>
    </Stack>
  );
}

/**
 * The accessible name of the copy control beside a record's saved original.
 *
 * @param file The record's project-relative path.
 * @returns "Copy path of the saved original of ‹file›".
 */
export function copyBackupPathLabel(file: string): string {
  return `${COPY_PATH_LABEL} of the saved original of ${file}`;
}

/** Which of a record's diffs a disclosure opens: the tool's change, or the developer's edit. */
type DiffKind = 'change' | 'edit';

/** The one open diff: whose, and which. */
interface OpenDiff {
  readonly recordId: string;
  readonly kind: DiffKind;
}

/** A conflict's diff of the developer's edit, with what it compares. */
interface EditDiff {
  readonly diff: string;
  readonly subject: string;
}

/**
 * The diff a conflict item's "Open diff" shows: what the developer changed on
 * top of the instrumentation (`instrumentedToCurrent`, the hunks that explain
 * why the file was left alone) or, when the service could not produce that
 * one, the file's whole divergence from the saved original
 * (`originalToCurrent`), each labelled by what it compares. The tool's own
 * change is "View diff", never this.
 *
 * @param conflict The record's conflict entry, when the service reported one.
 * @returns The diff and its subject, or `undefined` when the entry carries
 *   neither diff — the control is then not rendered.
 */
function editDiffOf(conflict: ModificationConflict | undefined): EditDiff | undefined {
  const diffs = conflict?.diffs;
  if (diffs === undefined) {
    return undefined;
  }
  if (hasText(diffs.instrumentedToCurrent)) {
    return { diff: diffs.instrumentedToCurrent, subject: EDIT_SUBJECT };
  }
  if (hasText(diffs.originalToCurrent)) {
    return { diff: diffs.originalToCurrent, subject: CURRENT_SUBJECT };
  }
  return undefined;
}

/**
 * A saved original's path as a sentence of its own — "Original saved at
 * ‹path›." — with the path wrapped, never shortened, and identified so a
 * refused copy can select it.
 */
function SavedAt(props: { readonly path: string; readonly pathId: string }): ReactElement {
  return (
    <Text as="p" size="sm" tone="secondary">
      {SAVED_AT_LABEL}
      <Code size="sm" wrap id={props.pathId}>
        {props.path}
      </Code>
      {CONFLICT_END}
    </Text>
  );
}

/** The props of {@link ConflictCallout}. */
interface ConflictCalloutProps {
  readonly record: ModificationRecord;
  readonly conflict: ModificationConflict | undefined;
  readonly edit: EditDiff | undefined;
  readonly pathId: string;
}

/**
 * A conflicting record's explanation, at the item's full width.
 *
 * For a file the developer edited — the `content-changed` reason, or a record
 * whose conflict entry has not arrived — the message is AAP 0.5.5's sentence,
 * "‹file› was edited while instrumented. Debug Generator will not overwrite
 * it. Original saved at ‹backup path›.", composed from the record's own file
 * and backup path. For any other reason the service reported, its own message
 * is shown verbatim instead, and the saved original follows as a sentence of
 * its own — except when the reason is that the backup is missing, where naming
 * its path would promise a file that is not there.
 *
 * Both values render through `Code wrap`, byte-faithful and broken across lines
 * in a narrow view rather than clipped or ellipsized, and "Copy path" copies
 * the backup path exactly. The schema requires a non-blank backup path; should
 * a record arrive without one anyway, only the saved-at sentence and its copy
 * control are left out — a path is never constructed or guessed. The message
 * never says the file was reverted, which keeps the item consistent with the
 * session's cleanup outcome.
 */
function ConflictCallout(props: ConflictCalloutProps): ReactElement {
  const { record, conflict, edit, pathId } = props;
  const reason = conflict?.reason;
  const serviceMessage =
    conflict !== undefined && reason !== 'content-changed' && hasText(conflict.message)
      ? conflict.message
      : undefined;
  const showPath = hasText(record.backupPath) && reason !== 'backup-missing';

  return (
    <div className="dgv-modifications__note dgv-modifications__callout dgv-modifications__callout--warning">
      {serviceMessage === undefined ? (
        <Text as="p" size="sm" className="dgv-modifications__message">
          <Code size="sm" wrap>
            {record.file}
          </Code>
          {CONFLICT_EDITED}
          {showPath ? (
            <>
              {CONFLICT_SAVED_AT}
              <Code size="sm" wrap id={pathId}>
                {record.backupPath}
              </Code>
              {CONFLICT_END}
            </>
          ) : null}
        </Text>
      ) : (
        <>
          <Text as="p" size="sm" className="dgv-modifications__message">
            {serviceMessage}
          </Text>
          {showPath ? <SavedAt path={record.backupPath} pathId={pathId} /> : null}
        </>
      )}
      {reason === 'content-changed' && edit === undefined ? (
        <Text as="p" size="xs" tone="secondary">
          {EDIT_UNAVAILABLE}
        </Text>
      ) : null}
      {showPath ? (
        <CopyPathButton
          path={record.backupPath}
          accessibleLabel={copyBackupPathLabel(record.file)}
          targetId={pathId}
        />
      ) : null}
    </div>
  );
}

/**
 * A failed record's explanation, at the item's full width: why it is not
 * applied and what cleanup will do (see {@link describeStatus}), then the
 * saved original with its copy control, which the lifecycle keeps for exactly
 * this record.
 */
function FailedCallout(props: {
  readonly record: ModificationRecord;
  readonly note: string;
  readonly pathId: string;
}): ReactElement {
  const { record, note, pathId } = props;

  return (
    <div className="dgv-modifications__note dgv-modifications__callout dgv-modifications__callout--danger">
      <Text as="p" size="sm" className="dgv-modifications__message">
        {note}
      </Text>
      {hasText(record.backupPath) ? (
        <>
          <SavedAt path={record.backupPath} pathId={pathId} />
          <CopyPathButton
            path={record.backupPath}
            accessibleLabel={copyBackupPathLabel(record.file)}
            targetId={pathId}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * The explanation under a record's path, at the item's full width: the
 * conflict callout for a `conflict`, the failure callout for `failed`, the
 * status's own sentence for `pending`, and nothing for `applied` and
 * `reverted`, whose labels say everything.
 */
function RecordNote(props: {
  readonly record: ModificationRecord;
  readonly conflict: ModificationConflict | undefined;
  readonly edit: EditDiff | undefined;
  readonly pathId: string;
}): ReactElement | null {
  const { record, conflict, edit, pathId } = props;
  if (record.status === 'conflict') {
    return <ConflictCallout record={record} conflict={conflict} edit={edit} pathId={pathId} />;
  }

  const { note } = describeStatus(record.status);
  if (note === undefined) {
    return null;
  }

  if (record.status === 'failed') {
    return <FailedCallout record={record} note={note} pathId={pathId} />;
  }

  return (
    <Text as="p" size="xs" tone="secondary" className="dgv-modifications__note">
      {note}
    </Text>
  );
}

/**
 * One labelled, abbreviated hash in the detail, or nothing for a blank value.
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

/** The props of {@link DiffToggle}. */
interface DiffToggleProps {
  /** The visible text while collapsed: "View diff" or "Open diff". */
  readonly label: string;
  /** What follows the visible text in the accessible name: "of ‹file›". */
  readonly target: string;
  readonly expanded: boolean;
  /** The id of the open detail; set only while this toggle's diff is open. */
  readonly controls: string | undefined;
  readonly onToggle: () => void;
}

/**
 * A disclosure button: `aria-expanded` always, `aria-controls` while the
 * detail it opened exists, and an accessible name that starts with its visible
 * text — "View diff of ‹file›", "Hide diff of ‹file›".
 */
function DiffToggle(props: DiffToggleProps): ReactElement {
  const { label, target, expanded, controls, onToggle } = props;
  const text = expanded ? HIDE_DIFF_LABEL : label;

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`${text} ${target}`}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {text}
    </Button>
  );
}

/** The props of {@link ModificationItem}. */
interface ModificationItemProps {
  readonly record: ModificationRecord;
  /** The record's conflict entry; considered only for a `conflict` record. */
  readonly conflict: ModificationConflict | undefined;
  /** Which of this record's diffs is open, if any. */
  readonly openKind: DiffKind | undefined;
  readonly onToggle: (recordId: string, kind: DiffKind) => void;
  readonly onOpenFile: ((file: string) => void) | undefined;
  /** A document-unique prefix for this item's element ids. */
  readonly idBase: string;
  /** The display split of the record's file within this list. */
  readonly display: PathDisplay;
}

/**
 * One record, at the list's full width: its path and status badge, the meta
 * line, the explanation, the actions, and — while one of its disclosures is
 * open — the diff it opened, directly under those actions and in the page's
 * own flow.
 *
 * The path renders through `Code`, which is byte-faithful: its text is the
 * record's `file` exactly, in the spans of the `.dgv-path` contract, so a
 * narrow view shortens the lead, then the tail's directories, and the file
 * name last — visually, by the stylesheet's ellipsis, never by slicing the
 * string. Because the tail is the shortest suffix no other file of the list
 * ends in, two items never read alike. The chip is `aria-hidden`: the item's
 * path reaches the accessibility tree through a visually hidden copy of the
 * whole path, which a browser reads without the spaces it inserts between
 * flex parts. The chip's tooltip is the whole path.
 */
function ModificationItem(props: ModificationItemProps): ReactElement {
  const { record, conflict, openKind, onToggle, onOpenFile, idBase, display } = props;
  const recorded = formatRecordedAt(record.appliedAt);
  const tone = STATUS_TONE[record.status];
  const { label } = describeStatus(record.status);
  const entry = record.status === 'conflict' ? conflict : undefined;
  const edit = editDiffOf(entry);
  const detailId = `${idBase}-diff`;
  const pathId = `${idBase}-backup`;

  // An "edit" disclosure whose diff has since gone (a newer conflict entry
  // without one) shows nothing rather than a stale diff.
  const shown: DiffKind | undefined =
    openKind === 'edit' && edit === undefined ? undefined : openKind;

  return (
    <Stack gap={1} className="dgv-modifications__record">
      <Stack
        direction="horizontal"
        gap={2}
        wrap
        align="center"
        justify="between"
        className="dgv-modifications__head"
      >
        <Text className="dg-visually-hidden">{record.file}</Text>
        <Code size="sm" className="dgv-path" title={record.file} aria-hidden="true">
          {display.lead === '' ? null : <span className="dgv-path__lead">{display.lead}</span>}
          <span className="dgv-path__tail">
            {display.context === '' ? null : (
              <span className="dgv-path__context">{display.context}</span>
            )}
            <span className="dgv-path__name">{display.name}</span>
          </span>
        </Code>
        <Badge tone={tone} variant="soft" className="dgv-modifications__status">
          {label}
        </Badge>
      </Stack>
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
      <RecordNote record={record} conflict={entry} edit={edit} pathId={pathId} />
      <Stack
        direction="horizontal"
        gap={1}
        wrap
        align="center"
        className="dgv-modifications__actions"
      >
        {edit === undefined ? null : (
          <DiffToggle
            label={OPEN_DIFF_LABEL}
            target={`of your edit to ${record.file}`}
            expanded={shown === 'edit'}
            controls={shown === 'edit' ? detailId : undefined}
            onToggle={() => {
              onToggle(record.id, 'edit');
            }}
          />
        )}
        <DiffToggle
          label={VIEW_DIFF_LABEL}
          target={`of ${record.file}`}
          expanded={shown === 'change'}
          controls={shown === 'change' ? detailId : undefined}
          onToggle={() => {
            onToggle(record.id, 'change');
          }}
        />
        {onOpenFile === undefined ? null : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${OPEN_FILE_LABEL} ${record.file}`}
            onClick={() => {
              onOpenFile(record.file);
            }}
          >
            {OPEN_FILE_LABEL}
          </Button>
        )}
      </Stack>
      {shown === undefined ? null : (
        <Stack id={detailId} gap={2} className="dgv-modifications__detail">
          {shown === 'edit' && edit !== undefined ? (
            <DiffView diff={edit.diff} fileLabel={record.file} subject={edit.subject} />
          ) : (
            <>
              <Stack direction="horizontal" gap={3} wrap className="dgv-modifications__hashes">
                <HashItem label={ORIGINAL_HASH_LABEL} hash={record.originalHash} />
                <HashItem label={INSTRUMENTED_HASH_LABEL} hash={record.instrumentedHash} />
              </Stack>
              <DiffView diff={record.diff} fileLabel={record.file} subject={CHANGE_SUBJECT} />
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
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
 * flight. The tone reinforces the words; it never carries the warning alone.
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

/** The conflict entries a list without `props.conflicts` matches against. */
const NO_CONFLICTS: readonly ModificationConflict[] = Object.freeze([]);

/**
 * Renders the session's modification records as a list with one full-width
 * item per record and an expandable diff, or the error, loading or empty state
 * in its place, and warns — above the list, or instead of the empty state —
 * when the journal holds records the list does not.
 *
 * @param props See {@link ModificationsListProps}.
 * @returns One root element carrying `dgv-modifications` and `props.className`,
 *   holding the list or the state primitive that stands in for it.
 */
export function ModificationsList(props: ModificationsListProps): ReactElement {
  const {
    modifications,
    conflicts = NO_CONFLICTS,
    onOpenFile,
    pending = false,
    error,
    onRetry,
    total,
    onLoadMore,
    loadingMore = false,
    awaitingPlan = false,
    className,
  } = props;

  // Hooks run before any branch, as they must. The open diff is the only
  // local state: whose, and which of its diffs, or none.
  const [open, setOpen] = useState<OpenDiff | undefined>(undefined);
  const idPrefix = useId();

  const toggle = useCallback((recordId: string, kind: DiffKind): void => {
    setOpen((current) =>
      current?.recordId === recordId && current.kind === kind ? undefined : { recordId, kind },
    );
  }, []);

  // The first entry for a record wins: the service reports one conflict per
  // record, and a duplicate must not swap the message under the reader.
  const conflictByRecord = useMemo(() => {
    const byRecord = new Map<string, ModificationConflict>();
    for (const conflict of conflicts) {
      if (!byRecord.has(conflict.recordId)) {
        byRecord.set(conflict.recordId, conflict);
      }
    }
    return byRecord;
  }, [conflicts]);

  // Computed once per list, not per item: whether a path's tail is unique is a
  // property of the whole list.
  const displays = useMemo<PathDisplays>(
    () => describePaths(modifications.map((record) => record.file)),
    [modifications],
  );

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
    // With records missing, an empty list is not "nothing was modified"; and
    // before instrumentation it is "nothing modified yet", not the final word.
    body = shortfall ?? (
      <EmptyState message={awaitingPlan ? AWAITING_PLAN_MESSAGE : EMPTY_MESSAGE} />
    );
  } else {
    const list = (
      <ol className="dgv-modifications__list" aria-label={CAPTION}>
        {modifications.map((record) => (
          <li key={record.id} className="dgv-modifications__item">
            <ModificationItem
              record={record}
              conflict={conflictByRecord.get(record.id)}
              openKind={open?.recordId === record.id ? open.kind : undefined}
              onToggle={toggle}
              onOpenFile={onOpenFile}
              idBase={`${idPrefix}-${record.id}`}
              display={displayOf(displays, record.file)}
            />
          </li>
        ))}
      </ol>
    );
    body =
      shortfall === null ? (
        list
      ) : (
        <Stack gap={2}>
          {shortfall}
          {list}
        </Stack>
      );
  }

  return <div className={joinClassNames(ROOT_CLASS, className)}>{body}</div>;
}
