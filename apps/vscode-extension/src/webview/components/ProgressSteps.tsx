/**
 * `ProgressSteps` — the live progress list of the "Debug Generator" editor view
 * (AAP 0.7.3: "stage groups and check/spinner/cross rows using the user's
 * Step-8 wording from real progress events").
 *
 * ## It displays what arrived, and nothing else
 *
 * Every row is one `ProgressEntry` the host built from a real `session.progress`
 * frame (AAP 0.4.2). The service composes each line from what a stage actually
 * found — a file it resolved, a handler it traced, a signal it armed — so this
 * component's whole job is to render those lines faithfully (AAP 0.5.4):
 *
 * - **One row per entry, in the order given.** The host already merges repeated
 *   frames (it upserts by stage and message and preserves arrival order), so the
 *   list is never re-sorted, de-duplicated, padded with steps that have not
 *   arrived, or completed from a session status.
 * - **Groups in first-arrival order.** Entries are grouped by `stage`; the first
 *   entry of a stage fixes its group's position, and a later entry of the same
 *   stage joins that group without moving it. A stage that has reported nothing
 *   has no group.
 * - **The server's words, verbatim.** `message` and `detail` are rendered as
 *   received — never rewritten, re-capitalised or truncated. The only derived
 *   text is the group title, which is the raw `stage` value made readable by a
 *   generic transform (separators become spaces, the first letter is raised);
 *   `stage` is deliberately an open `string` on the contract, so no table keyed
 *   by stage name exists here to drift from the service.
 * - **No clock.** No timer, effect or local state advances a step: the list
 *   changes only when new props arrive.
 *
 * ## Structure and the design system (AAP 0.6.4)
 *
 * ```text
 * div.dgv-progress                              root, spaced by ../styles.css
 *   ol.dgv-progress__groups  aria-live=polite   one item per stage, when any
 *     li.dgv-progress__group
 *       Text .dgv-progress__group-title         names the rows list below
 *       ol.dgv-progress__rows  aria-labelledby
 *         li.dgv-progress__row                  two-column grid
 *           span.dgv-progress__marker--<status> glyph (aria-hidden) + hidden label
 *           Text .dgv-progress__label           the service's message
 *           Text .dgv-progress__detail          the service's detail, when sent
 *   ErrorState | LoadingState | EmptyState      the state affordance, if any
 *   Text p .dgv-progress__cta  role=status      "Reproduce the issue now."
 * ```
 *
 * The lists are real `<ol>`/`<li>` elements because order and count are the
 * information: `Stack` renders `div` containers, and a `div` cannot sit between
 * an `<ol>` and its items. The group title is body text through `Text` rather
 * than a heading, because this view is composed into `App.tsx` at an outline
 * depth this file cannot know; it names its rows list through
 * `aria-labelledby` instead. Every value behind the `dgv-progress*` classes is a
 * `--dg-*` token, and the running spinner is the design system's published
 * `dg-spinner`, whose motion the design system's reduced-motion rule already
 * stops.
 *
 * ## Status is never colour alone
 *
 * Each marker carries exactly one of `--running`, `--done` or `--failed`, a
 * decorative glyph (a spinner, `✓` or `✕`) hidden from assistive technology,
 * and a visually hidden status word that is announced before the message. A
 * failed stage is always drawn as a failed row: a failure is never restyled as
 * a success and never omitted (AAP 0.5.5).
 *
 * ## States (AAP 0.5.5)
 *
 * Precedence is error, then pending, then empty, then the list. Rows that have
 * arrived stay visible in every state — an error or a loading affordance is
 * appended below them rather than replacing them, so the failing stage's own
 * row remains on screen next to the failure. Each state is the design system's
 * primitive, which owns its own announcement: `ErrorState` is the `alert`,
 * `LoadingState` the busy `status`, `EmptyState` the settled `status`. The
 * list's own live region is `polite` and never contains them, so nothing is
 * announced twice. The armed call to action is withheld while an error is
 * shown: asking the developer to reproduce the issue after the pipeline
 * stopped would contradict the failure beside it.
 *
 * ## Privacy and neutrality (AAP 0.5.2, 0.5.4)
 *
 * Progress lines can name the developer's own files and symbols. They are
 * rendered and never logged: this module writes nothing to any console, holds
 * no socket, fetches nothing and posts nothing to the host. The only copy it
 * owns is generic product vocabulary about pipeline state; every
 * project-specific string comes from `props.entries`.
 *
 * @module apps/vscode-extension/src/webview/components/ProgressSteps
 */

import { useId } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { EmptyState, ErrorState, LoadingState, Text } from '@debuggen/panel-renderer';
import { assertNever } from '@debuggen/shared';

import type { ProgressEntry } from '../../webview-messages';

/**
 * The props of {@link ProgressSteps}.
 *
 * Every optional member spells `| undefined` because `exactOptionalPropertyTypes`
 * is in force repository-wide, and `App.tsx` forwards values it may not have —
 * `error={state.failure?.message}` — straight through.
 */
export interface ProgressStepsProps {
  /**
   * The progress rows in arrival order, exactly as the host holds them in
   * `WebviewState.progress`. Rendered one row per entry, grouped by stage.
   */
  entries: readonly ProgressEntry[];

  /**
   * The session is ready to capture and waiting for the developer to reproduce
   * the issue: renders the call to action below the list. Withheld while
   * {@link ProgressStepsProps.error} is shown.
   */
  captureArmed?: boolean | undefined;

  /**
   * The pipeline is working and more rows are expected. With no rows yet this
   * renders the loading silhouette in place of the list; with rows, the
   * silhouette is appended below them. Outranked only by
   * {@link ProgressStepsProps.error}.
   */
  pending?: boolean | undefined;

  /**
   * Why the pipeline stopped, as the layer that observed the failure worded
   * it. A non-blank value renders the error state, which outranks every other
   * state; rows that already arrived — including the failed stage's own row —
   * stay visible above it.
   */
  error?: string | undefined;

  /**
   * Asks for the failed stage to be tried again. The error state renders its
   * retry control only when this is supplied.
   */
  onRetry?: (() => void) | undefined;

  /**
   * Extra classes for the root element — layout the surrounding section owns.
   * Composed after this component's own class.
   */
  className?: string | undefined;
}

/** The call to action while a capture is armed, worded as AAP 0.7.3 gives it. */
const CAPTURE_ARMED_MESSAGE = 'Reproduce the issue now.';

/**
 * The empty-state sentence. Generic by design: `EmptyState` ships no default
 * copy precisely so that no project vocabulary can leak into it.
 */
const EMPTY_MESSAGE = 'No progress yet. Ask a question to start a session.';

/**
 * The error state's first line. The primitive's own default speaks of a view
 * that could not load, which is not what a stopped pipeline is; the cause
 * itself is the caller's `error`.
 */
const ERROR_TITLE = 'The pipeline stopped';

/** Announced, never painted, while further progress is awaited. */
const LOADING_LABEL = 'Waiting for progress…';

/** Skeleton rows while nothing has arrived yet: a list-shaped silhouette. */
const LOADING_ROWS_EMPTY = 3;

/** Skeleton rows appended below rows that have arrived: one more to come. */
const LOADING_ROWS_APPENDED = 1;

/** The accessible name of the list of stage groups. */
const GROUPS_LABEL = 'Session progress';

/** A progress row's status, read off the contract rather than restated. */
type ProgressStatus = ProgressEntry['status'];

/**
 * How one status is drawn: the marker's modifier class, the decorative glyph
 * and the word announced in place of that glyph.
 */
interface StatusPresentation {
  /** Exactly one of the three marker modifiers of `../styles.css`. */
  readonly modifierClass: string;
  /** Decoration only; always rendered inside an `aria-hidden` wrapper. */
  readonly glyph: ReactNode;
  /** The status as words, so colour and shape are never the sole signal. */
  readonly spokenLabel: string;
}

/**
 * The design system's inline spinner, hoisted because a React element is an
 * immutable description and one instance serves every running row. The
 * view's own `dgv-progress__spinner` class only centres it on the text line,
 * as the check and cross glyphs are; the ring itself stays the design
 * system's.
 */
const SPINNER_GLYPH = <span className="dg-spinner dgv-progress__spinner" />;

/**
 * Resolves how a status is drawn.
 *
 * A `switch` closed by `assertNever` rather than a lookup table, so a fourth
 * status added to the protocol's vocabulary is a compile error here instead of
 * a row drawn with no marker.
 *
 * @param status The entry's status.
 * @returns The marker class, glyph and announced word for it.
 */
function statusPresentation(status: ProgressStatus): StatusPresentation {
  switch (status) {
    case 'running':
      return {
        modifierClass: 'dgv-progress__marker--running',
        glyph: SPINNER_GLYPH,
        spokenLabel: 'In progress',
      };
    case 'done':
      return { modifierClass: 'dgv-progress__marker--done', glyph: '✓', spokenLabel: 'Done' };
    case 'failed':
      return { modifierClass: 'dgv-progress__marker--failed', glyph: '✕', spokenLabel: 'Failed' };
    default:
      return assertNever(status, 'Unhandled progress status');
  }
}

/** One entry together with its position in `props.entries`. */
interface PositionedEntry {
  /** The entry as received. */
  readonly entry: ProgressEntry;
  /** Its zero-based position in the received list; part of the row's key. */
  readonly index: number;
}

/** The rows of one stage, in the order they arrived. */
interface StageGroup {
  /** The stage exactly as the service named it. */
  readonly stage: string;
  /** Every entry of that stage, in arrival order. */
  readonly rows: readonly PositionedEntry[];
}

/**
 * Groups entries by stage without reordering anything.
 *
 * A `Map` preserves insertion order, so the first entry of a stage fixes its
 * group's position and a later entry of the same stage is appended to that
 * group. Within a group the rows keep their arrival order. Every entry lands
 * in exactly one group, so the rows rendered are the entries received,
 * one-for-one.
 *
 * @param entries The entries in arrival order.
 * @returns The stage groups in first-arrival order.
 */
function groupByStage(entries: readonly ProgressEntry[]): StageGroup[] {
  const groups = new Map<string, PositionedEntry[]>();

  entries.forEach((entry, index) => {
    const rows = groups.get(entry.stage);
    if (rows === undefined) {
      groups.set(entry.stage, [{ entry, index }]);
    } else {
      rows.push({ entry, index });
    }
  });

  return Array.from(groups, ([stage, rows]) => ({ stage, rows }));
}

/** Separator runs a stage name may contain: hyphens, underscores, whitespace. */
const STAGE_SEPARATORS = /[-_\s]+/u;

/**
 * Makes a stage name readable as a group title with a generic transform — the
 * separators become single spaces and the first letter is raised — so the
 * title is always the service's own stage, never a label this file chose.
 *
 * @param stage The stage exactly as the service named it.
 * @returns The title, or `''` for a stage with no letters to show.
 */
function stageTitle(stage: string): string {
  const words = stage.split(STAGE_SEPARATORS).filter((word) => word !== '');
  const title = words.join(' ');
  return title === '' ? '' : `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
}

/**
 * Joins class names, dropping absent and blank parts.
 *
 * `clsx` is not a dependency of this workspace, and two parts do not justify
 * one; blank parts are dropped so a caller's empty `className` never leaves a
 * stray space in the attribute.
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

/**
 * Renders one progress row: the status marker, the service's message and, when
 * the service sent one, its detail line.
 *
 * @param positioned The entry and its position in the received list.
 * @returns The row's list item.
 */
function renderRow(positioned: PositionedEntry): ReactElement {
  const { entry, index } = positioned;
  const presentation = statusPresentation(entry.status);

  return (
    // Position plus content: unique even if the host ever delivers two equal
    // rows, and stable for as long as the list only grows or updates in place.
    <li key={`${String(index)}:${entry.stage}:${entry.message}`} className="dgv-progress__row">
      <span className={joinClassNames('dgv-progress__marker', presentation.modifierClass)}>
        <span aria-hidden="true">{presentation.glyph}</span>
        <Text className="dg-visually-hidden">{presentation.spokenLabel}</Text>
      </span>
      <Text size="sm" className="dgv-progress__label">
        {entry.message}
      </Text>
      {hasText(entry.detail) ? (
        <Text size="xs" tone="secondary" className="dgv-progress__detail">
          {entry.detail}
        </Text>
      ) : null}
    </li>
  );
}

/**
 * Renders one stage group: its title, when the stage has letters to show, and
 * the ordered list of its rows, named by that title.
 *
 * @param group The stage and its rows.
 * @param titleId The id the title carries and the rows list references.
 * @returns The group's list item.
 */
function renderGroup(group: StageGroup, titleId: string): ReactElement {
  const title = stageTitle(group.stage);
  const titled = title !== '';

  return (
    <li key={`stage:${group.stage}`} className="dgv-progress__group">
      {titled ? (
        <Text id={titleId} className="dgv-progress__group-title">
          {title}
        </Text>
      ) : null}
      <ol className="dgv-progress__rows" aria-labelledby={titled ? titleId : undefined}>
        {group.rows.map(renderRow)}
      </ol>
    </li>
  );
}

/**
 * The state affordance shown with (or instead of) the list, by precedence:
 * error, then pending, then empty.
 *
 * @param state What the root knows about the pipeline's state.
 * @returns The design-system state primitive to render, or `null` when the
 *   list — and the call to action, if armed — is the whole content.
 */
function renderState(state: {
  readonly error: string | undefined;
  readonly onRetry: (() => void) | undefined;
  readonly pending: boolean;
  readonly hasEntries: boolean;
  readonly captureArmed: boolean;
}): ReactElement | null {
  if (hasText(state.error)) {
    return <ErrorState title={ERROR_TITLE} message={state.error} onRetry={state.onRetry} />;
  }

  if (state.pending) {
    return (
      <LoadingState
        variant="rows"
        rows={state.hasEntries ? LOADING_ROWS_APPENDED : LOADING_ROWS_EMPTY}
        label={LOADING_LABEL}
      />
    );
  }

  // An armed capture with no rows (a reopened session, say) still has
  // something to say — the call to action — so the empty sentence, which
  // invites a first question, would contradict it.
  if (!state.hasEntries && !state.captureArmed) {
    return <EmptyState message={EMPTY_MESSAGE} />;
  }

  return null;
}

/**
 * Renders the pipeline's progress rows grouped by stage, the state affordance
 * for an error, a pending pipeline or an empty session, and the call to action
 * while a capture is armed.
 *
 * Pure output of its props: no state, no effect and no timer — `useId` only
 * wires each group's title to its list.
 *
 * @param props See {@link ProgressStepsProps}.
 * @returns The progress view's root element.
 *
 * @example
 * ```tsx
 * <ProgressSteps
 *   entries={state.progress}
 *   captureArmed={state.session?.status === 'ready'}
 *   pending={awaitingProgress}
 *   error={state.failure?.message}
 *   onRetry={retryFailedStage}
 * />
 * ```
 */
export function ProgressSteps(props: ProgressStepsProps): ReactElement {
  const { entries, captureArmed = false, pending = false, error, onRetry, className } = props;

  const baseId = useId();
  const hasEntries = entries.length > 0;
  const groups = groupByStage(entries);
  const stateAffordance = renderState({ error, onRetry, pending, hasEntries, captureArmed });
  const showCallToAction = captureArmed && !hasText(error);

  return (
    <div className={joinClassNames('dgv-progress', className)}>
      {hasEntries ? (
        <ol className="dgv-progress__groups" aria-live="polite" aria-label={GROUPS_LABEL}>
          {groups.map((group, groupIndex) =>
            renderGroup(group, `${baseId}-stage-${String(groupIndex)}`),
          )}
        </ol>
      ) : null}
      {stateAffordance}
      {showCallToAction ? (
        <Text as="p" role="status" className="dgv-progress__cta">
          {CAPTURE_ARMED_MESSAGE}
        </Text>
      ) : null}
    </div>
  );
}
