/**
 * `ProgressSteps` — the live progress list of the "Debug Generator" editor view
 * (AAP 0.7.3: "stage groups and check/spinner/cross rows using the user's
 * Step-8 wording from real progress events").
 *
 * ## It displays what arrived, and nothing else
 *
 * Every row is one `ProgressEntry` the host built from a real `session.progress`
 * frame (AAP 0.4.2). The service composes each line from what a stage actually
 * found — a file it resolved, a handler it traced, a signal it armed — and
 * opens and closes every stage with a header row whose message is the stage's
 * title (`apps/local-service/src/sessions/progress.ts`). This component's whole
 * job is to render those lines faithfully (AAP 0.5.4), in the shape of the
 * Step-8 view (AAP 0.1.2):
 *
 * ```text
 * ✓ Understanding problem          ← heading: the `understand` header row
 *   ✓ Investigating code           ← the `investigate` header row
 *   ✓ Found ‹component›            ← investigation findings, as sent
 *   ✓ Traced event handler
 *   ✓ Found ‹route›
 *   ✓ Found database dependency
 * ✓ Preparing instrumentation      ← heading: the `instrument` header row
 *   ✓ Planning instrumentation     ← the `plan` header row
 *   ✓ Browser performance …        ← one row per signal armed
 *   ✓ Ready to capture
 * ```
 *
 * - **Every entry once, never re-sorted.** The host already merges repeated
 *   frames within a stage's latest episode (`../../state.ts`), so the list is
 *   never re-sorted, de-duplicated, padded with steps that have not arrived, or
 *   completed from a session status.
 * - **Sections are contiguous runs.** Entries are split into runs of the same
 *   section key — a stage's lead from `SECTION_LEADS` (investigation under
 *   understanding, planning under instrumentation), or the stage itself. A
 *   stage that reports again after others, as a follow-up's second plan,
 *   instrument and capture do, opens a new section in arrival order, so the
 *   view stays chronological: generated → follow-up → planning → ready.
 * - **Headings are the service's rows.** A section is headed by its lead
 *   stage's header row — marker, message and detail as sent — or, until the
 *   lead stage reports, by its first row. No title is synthesised: the only
 *   knowledge this file holds about stages is which two draw under another's
 *   heading, keyed by the protocol's own stage vocabulary; an unknown stage
 *   heads a section of its own.
 * - **The server's words, verbatim.** `message` and `detail` are rendered as
 *   received — never rewritten, re-capitalised or truncated.
 * - **No clock.** No timer or effect advances a step: the list changes only when
 *   new props arrive. The one piece of local state is which older sections the
 *   developer chose to expand.
 *
 * ## Bounded rendering (a long session stays cheap)
 *
 * The sections are rebuilt only when `entries` changes (`useMemo`). Rows and
 * headings are `memo` components over primitive props, keyed by stage, message
 * and first-arrival time rather than by list position, so an update reconciles
 * the rows that changed and every other row keeps its DOM node — also when the
 * host's bound compacts the oldest episodes to their header and failed rows
 * (`../../state.ts`), which keeps every section's heading and identity. Only
 * the latest `LIVE_SECTION_WINDOW` sections are drawn in full; an older
 * section is its keyed summary — its heading row, with the stage title and
 * status — plus a "Show N steps" disclosure, and its rows are not mounted
 * until it is expanded. A section holding a failed row is never collapsed: a
 * failure is never hidden (AAP 0.5.5).
 *
 * ## Structure and the design system (AAP 0.6.4)
 *
 * ```text
 * div.dgv-progress                              root, spaced by ../styles.css
 *   ol.dgv-progress__groups  aria-live=polite   one item per section, when any
 *     li.dgv-progress__group
 *       div.dgv-progress__row.dgv-progress__heading   the heading row
 *         span.dgv-progress__marker--<status>   glyph (aria-hidden) + hidden label
 *         Text .dgv-progress__group-title       the service's message; names the list
 *         Text .dgv-progress__detail            the service's detail, when sent
 *       Stack > Button  aria-expanded           "Show N steps" | "Hide steps", older only
 *       ol.dgv-progress__rows  aria-labelledby  the other rows, when any and shown
 *         li.dgv-progress__row                  two-column grid
 *           span.dgv-progress__marker--<status> glyph (aria-hidden) + hidden label
 *           Text .dgv-progress__label           the service's message
 *           Text .dgv-progress__detail          the service's detail, when sent
 *   ErrorState | LoadingState | EmptyState      the state affordance, if any
 *   Text p .dgv-progress__cta  role=status      "Reproduce the issue now." / "…again."
 * ```
 *
 * The lists are real `<ol>`/`<li>` elements because order and count are the
 * information: `Stack` renders `div` containers, and a `div` cannot sit between
 * an `<ol>` and its items. The heading is body text through `Text` rather than
 * a heading element, because this view is composed into `App.tsx` at an
 * outline depth this file cannot know; it names its rows list through
 * `aria-labelledby` instead. `dgv-progress__heading` is a hook only — the
 * heading reuses the row grid and the group-title type role. Every value
 * behind the `dgv-progress*` classes is a `--dg-*` token, and the running
 * spinner is the design system's published `dg-spinner`, whose motion the
 * design system's reduced-motion rule already stops.
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
 * announced twice. The armed call to action reads "Reproduce the issue now."
 * for the first capture and "Reproduce the issue again." for the capture a
 * follow-up asked for (`followUpCapture`, AAP 0.4.2); it is withheld while an
 * error is shown: asking the developer to reproduce the issue after the
 * pipeline stopped would contradict the failure beside it.
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

import { memo, useCallback, useId, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import type { ProgressStage } from '@debuggen/protocol';
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
   * `WebviewState.progress`. Rendered once each, in that order, in sections
   * headed by the service's own stage header rows.
   */
  entries: readonly ProgressEntry[];

  /**
   * The session is ready to capture and waiting for the developer to reproduce
   * the issue: renders the call to action below the list. Withheld while
   * {@link ProgressStepsProps.error} is shown.
   */
  captureArmed?: boolean | undefined;

  /**
   * The armed capture was requested by a follow-up question that needs new
   * evidence (AAP 0.4.2's new-capture path): the call to action then reads
   * "Reproduce the issue again." instead of "Reproduce the issue now.". Has an
   * effect only while {@link ProgressStepsProps.captureArmed} is `true`.
   */
  followUpCapture?: boolean | undefined;

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
 * The call to action while the capture a follow-up asked for is armed, worded
 * as AAP 0.4.2's new-capture path gives it.
 */
const FOLLOW_UP_CAPTURE_ARMED_MESSAGE = 'Reproduce the issue again.';

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

/** The accessible name of the list of sections. */
const GROUPS_LABEL = 'Session progress';

/**
 * How many of the latest sections are always drawn in full.
 *
 * A first run fills five or six sections (understanding, instrumentation,
 * capture, analysis, panel, cleanup), so an ordinary session never collapses
 * anything; each follow-up adds two to four more. An older section beyond this
 * window shows only its heading and a "Show N steps" control, and its rows are
 * not mounted until the developer expands it, so a long session keeps the
 * mounted tree — and every update's reconciliation — proportional to the live
 * window rather than to the whole history.
 */
const LIVE_SECTION_WINDOW = 6;

/** The collapse control's label while an older section is expanded. */
const HIDE_STEPS_LABEL = 'Hide steps';

/**
 * The expand control's label for an older, collapsed section.
 *
 * @param count How many rows the section holds besides its heading.
 * @returns `Show 1 step` or `Show N steps`.
 */
function showStepsLabel(count: number): string {
  return count === 1 ? 'Show 1 step' : `Show ${String(count)} steps`;
}

/** No older section expanded: the initial state, and the state after a session change. */
const NO_EXPANDED_SECTIONS: ReadonlySet<string> = new Set<string>();

/**
 * The pipeline stages the Step-8 progress view draws under another stage's
 * heading (AAP 0.1.2, prompt §11 Step 8): the code investigation belongs to
 * "Understanding problem", and planning belongs to "Preparing
 * instrumentation". Every other stage leads its own section.
 *
 * Keyed and valued by the protocol's `ProgressStage` vocabulary, so a renamed
 * stage fails to compile here. Only the relationship lives in this file: the
 * words of every heading are still the service's own header rows.
 */
const SECTION_LEADS = Object.freeze({
  investigate: 'understand',
  plan: 'instrument',
} as const satisfies Readonly<Partial<Record<ProgressStage, ProgressStage>>>);

/**
 * {@link SECTION_LEADS} as a lookup over the contract's open `stage` string.
 * `ProgressEntry.stage` is deliberately a `string`, so a `Map` answers for any
 * value — an unknown stage simply has no lead — without an unchecked cast.
 */
const SECTION_LEAD_BY_STAGE: ReadonlyMap<string, ProgressStage> = new Map(
  Object.entries(SECTION_LEADS),
);

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

/** One received entry and the React key that identifies it across updates. */
interface KeyedEntry {
  /** The entry as received. */
  readonly entry: ProgressEntry;
  /**
   * Stage, message and the host's first-arrival time (`ts`, which the host
   * keeps when it updates a row in place), plus how many earlier entries
   * carried that same triple — independent of list position and of how many
   * older rows the host has compacted away, so a row keeps its key (and its
   * DOM node, and its section keeps its disclosure state) while rows are added
   * or removed around it and while it moves from running to done. The host
   * stamps every row it holds with a distinct time, so the count is `0` for
   * each of them and never shifts when an older row leaves; it only
   * disambiguates a list whose times repeat.
   */
  readonly key: string;
}

/**
 * One section of the view: a contiguous run of entries sharing a section key
 * (see {@link sectionKeyOf}), headed by one of them.
 */
interface ProgressSection {
  /** The key of the section's first entry, prefixed; stable while the run grows. */
  readonly key: string;
  /** The entry drawn as the section heading. */
  readonly heading: KeyedEntry;
  /** Every other entry of the run, in arrival order. */
  readonly rows: readonly KeyedEntry[];
  /** Whether the heading or any row failed: such a section is never collapsed. */
  readonly failed: boolean;
}

/**
 * The section a stage's entries are drawn in: the stage's lead from
 * {@link SECTION_LEADS}, or the stage itself. An unknown stage leads a section
 * of its own.
 *
 * @param stage The stage exactly as the service named it.
 * @returns The section key.
 */
function sectionKeyOf(stage: string): string {
  return SECTION_LEAD_BY_STAGE.get(stage) ?? stage;
}

/**
 * Splits the entries into sections without reordering, merging or dropping
 * anything.
 *
 * A section is a **contiguous run** of entries with the same section key, so
 * a stage that reports again later — the second plan, instrument and capture
 * a follow-up runs (AAP 0.4.2) — opens a new section after the stages that
 * preceded it instead of joining its first one: the view stays chronological.
 *
 * The heading is the run's first entry of the lead stage itself — the
 * service's `running`/`done` header row whose message is the stage title
 * (`apps/local-service/src/sessions/progress.ts`) — or, while the lead stage
 * has not reported yet, the run's first entry. Every other entry is a row of
 * the section, in arrival order, so each entry is rendered exactly once.
 *
 * @param entries The entries in arrival order.
 * @returns The sections in arrival order.
 */
function buildSections(entries: readonly ProgressEntry[]): ProgressSection[] {
  const occurrences = new Map<string, number>();
  const runs: { readonly sectionKey: string; readonly items: KeyedEntry[] }[] = [];

  for (const entry of entries) {
    const identity = JSON.stringify([entry.stage, entry.message, entry.ts]);
    const seen = occurrences.get(identity) ?? 0;
    occurrences.set(identity, seen + 1);
    const keyed: KeyedEntry = { entry, key: `${identity}#${String(seen)}` };

    const sectionKey = sectionKeyOf(entry.stage);
    const current = runs.at(-1);
    if (current?.sectionKey === sectionKey) {
      current.items.push(keyed);
    } else {
      runs.push({ sectionKey, items: [keyed] });
    }
  }

  return runs.flatMap(({ sectionKey, items }) => {
    const first = items[0];
    if (first === undefined) {
      return [];
    }
    const heading = items.find((item) => item.entry.stage === sectionKey) ?? first;
    const rows = items.filter((item) => item !== heading);
    return [
      {
        key: `section:${first.key}`,
        heading,
        rows,
        failed: items.some((item) => item.entry.status === 'failed'),
      },
    ];
  });
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
 * Renders a status marker: the modifier class, the decorative glyph hidden
 * from assistive technology, and the status word announced in its place.
 *
 * @param status The entry's status.
 * @returns The marker element.
 */
function renderMarker(status: ProgressStatus): ReactElement {
  const presentation = statusPresentation(status);

  return (
    <span className={joinClassNames('dgv-progress__marker', presentation.modifierClass)}>
      <span aria-hidden="true">{presentation.glyph}</span>
      <Text className="dg-visually-hidden">{presentation.spokenLabel}</Text>
    </span>
  );
}

/**
 * Renders the service's detail line under a message, when it sent one.
 *
 * @param detail The entry's detail, as received.
 * @returns The detail element, or `null`.
 */
function renderDetail(detail: string | undefined): ReactElement | null {
  return hasText(detail) ? (
    <Text size="xs" tone="secondary" className="dgv-progress__detail">
      {detail}
    </Text>
  ) : null;
}

/** The props of {@link ProgressRow}: the entry's three rendered fields. */
interface ProgressRowProps {
  /** The entry's status. */
  readonly status: ProgressStatus;
  /** The service's message, rendered verbatim. */
  readonly message: string;
  /** The service's detail line, rendered verbatim when present. */
  readonly detail: string | undefined;
}

/**
 * One progress row: the status marker, the service's message and, when the
 * service sent one, its detail line.
 *
 * Memoised on its three primitive props, so a progress update re-renders only
 * the rows whose status, message or detail actually changed — typically the
 * one row that moved from running to done, and the row that arrived.
 *
 * @param props See {@link ProgressRowProps}.
 * @returns The row's list item.
 */
const ProgressRow = memo(function ProgressRow(props: ProgressRowProps): ReactElement {
  const { status, message, detail } = props;

  return (
    <li className="dgv-progress__row">
      {renderMarker(status)}
      <Text size="sm" className="dgv-progress__label">
        {message}
      </Text>
      {renderDetail(detail)}
    </li>
  );
});

/** The props of {@link ProgressHeading}. */
interface ProgressHeadingProps extends ProgressRowProps {
  /** The id the title carries, so the section's rows list can name itself by it. */
  readonly titleId: string;
}

/**
 * A section heading: the service's own stage header row — its status marker
 * and its message verbatim, with its detail when sent — laid out on the row
 * grid and titled by the group-title role. A `div` rather than a heading
 * element, because this view's outline depth belongs to `App.tsx`. Memoised
 * on its primitive props, like {@link ProgressRow}.
 *
 * @param props See {@link ProgressHeadingProps}.
 * @returns The heading element.
 */
const ProgressHeading = memo(function ProgressHeading(props: ProgressHeadingProps): ReactElement {
  const { status, message, detail, titleId } = props;

  return (
    <div className="dgv-progress__row dgv-progress__heading">
      {renderMarker(status)}
      <Text id={titleId} className="dgv-progress__group-title">
        {message}
      </Text>
      {renderDetail(detail)}
    </div>
  );
});

/** How {@link renderSection} draws one section, as the root decided it. */
interface SectionPresentation {
  /** The id the heading's title carries; the rows list is named by it. */
  readonly titleId: string;
  /** The id of the rows list, which the expand control references. */
  readonly rowsId: string;
  /** Whether the section is older than the live window and may be collapsed. */
  readonly collapsible: boolean;
  /** Whether the developer expanded it; meaningful only when collapsible. */
  readonly expanded: boolean;
  /** Flips the section between collapsed and expanded. */
  readonly onToggle: (sectionKey: string) => void;
}

/**
 * Renders one section: its heading and, when it has any, the ordered list of
 * its other rows, named by the heading's title.
 *
 * A collapsible section also renders a disclosure control after its heading;
 * while it is collapsed its rows list is not mounted at all, so older history
 * costs one heading and one button until it is asked for.
 *
 * @param section The section.
 * @param presentation Its ids and its collapse state.
 * @returns The section's list item.
 */
function renderSection(section: ProgressSection, presentation: SectionPresentation): ReactElement {
  const { heading, rows } = section;
  const { titleId, rowsId, collapsible, expanded, onToggle } = presentation;
  const hasRows = rows.length > 0;
  const showToggle = collapsible && hasRows;
  const showRows = hasRows && (!showToggle || expanded);

  return (
    <li key={section.key} className="dgv-progress__group">
      <ProgressHeading
        status={heading.entry.status}
        message={heading.entry.message}
        detail={heading.entry.detail}
        titleId={titleId}
      />
      {showToggle ? (
        <Stack direction="horizontal">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            // Only while the list is mounted: an IDREF must name an element that exists.
            aria-controls={expanded ? rowsId : undefined}
            // Names the section the control opens, beside its own short label.
            aria-describedby={titleId}
            onClick={() => {
              onToggle(section.key);
            }}
          >
            {expanded ? HIDE_STEPS_LABEL : showStepsLabel(rows.length)}
          </Button>
        </Stack>
      ) : null}
      {showRows ? (
        <ol id={rowsId} className="dgv-progress__rows" aria-labelledby={titleId}>
          {rows.map(({ entry, key }) => (
            <ProgressRow
              key={key}
              status={entry.status}
              message={entry.message}
              detail={entry.detail}
            />
          ))}
        </ol>
      ) : null}
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
 * Renders the pipeline's progress rows in chronological sections headed by the
 * service's own stage header rows, the state affordance for an error, a
 * pending pipeline or an empty session, and the call to action while a
 * capture is armed.
 *
 * No effect and no timer. `useId` wires each heading to its rows list and each
 * disclosure control to the list it opens; the only state is the set of older
 * sections the developer expanded, cleared whenever the list is empty (a
 * session boundary).
 *
 * @param props See {@link ProgressStepsProps}.
 * @returns The progress view's root element.
 *
 * @example
 * ```tsx
 * <ProgressSteps
 *   entries={state.progress}
 *   captureArmed={state.session?.status === 'ready'}
 *   followUpCapture={latestFollowUp !== undefined && latestFollowUp.needsNewCapture !== false}
 *   pending={awaitingProgress}
 *   error={state.failure?.message}
 *   onRetry={retryFailedStage}
 * />
 * ```
 */
export function ProgressSteps(props: ProgressStepsProps): ReactElement {
  const {
    entries,
    captureArmed = false,
    followUpCapture = false,
    pending = false,
    error,
    onRetry,
    className,
  } = props;

  const baseId = useId();
  const hasEntries = entries.length > 0;
  // Rebuilt only when the host delivers a new list, not when a section is toggled.
  const sections = useMemo(() => buildSections(entries), [entries]);

  // The older sections the developer expanded, by section key. An empty list
  // is a session boundary — the host clears progress when a session starts or
  // another one is reopened — and has nothing to expand, so the choice is
  // dropped there and never carries over to the next session's sections.
  const [expandedSections, setExpandedSections] =
    useState<ReadonlySet<string>>(NO_EXPANDED_SECTIONS);
  if (!hasEntries && expandedSections.size > 0) {
    setExpandedSections(NO_EXPANDED_SECTIONS);
  }
  const toggleSection = useCallback((sectionKey: string): void => {
    setExpandedSections((held) => {
      const next = new Set(held);
      if (!next.delete(sectionKey)) {
        next.add(sectionKey);
      }
      return next;
    });
  }, []);

  const firstLiveSection = Math.max(sections.length - LIVE_SECTION_WINDOW, 0);
  const stateAffordance = renderState({ error, onRetry, pending, hasEntries, captureArmed });
  const showCallToAction = captureArmed && !hasText(error);

  return (
    <div className={joinClassNames('dgv-progress', className)}>
      {hasEntries ? (
        <ol className="dgv-progress__groups" aria-live="polite" aria-label={GROUPS_LABEL}>
          {sections.map((section, sectionIndex) => {
            const sectionId = `${baseId}-section-${String(sectionIndex)}`;
            return renderSection(section, {
              titleId: sectionId,
              rowsId: `${sectionId}-rows`,
              // A failure is never hidden (AAP 0.5.5): its section stays open.
              collapsible: sectionIndex < firstLiveSection && !section.failed,
              expanded: expandedSections.has(section.key),
              onToggle: toggleSection,
            });
          })}
        </ol>
      ) : null}
      {stateAffordance}
      {showCallToAction ? (
        <Text as="p" role="status" className="dgv-progress__cta">
          {followUpCapture ? FOLLOW_UP_CAPTURE_ARMED_MESSAGE : CAPTURE_ARMED_MESSAGE}
        </Text>
      ) : null}
    </div>
  );
}
