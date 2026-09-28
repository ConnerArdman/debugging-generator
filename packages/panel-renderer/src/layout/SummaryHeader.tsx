/**
 * The summary head of a generated panel: its title, the non-evidentiary
 * headline, the **observed** facts and the **likely causes**.
 *
 * ## What this component is, stated plainly
 *
 * It renders the head of a panel, and it is the visible form of the product's
 * central guarantee: what the capture *shows* and what the analysis *infers*
 * are kept apart, and prose can never masquerade as evidence
 * (`docs/ARCHITECTURE.md` states the rule for the analysis as a whole).
 * Three registers arrive on one object, {@link PanelSummary}, and they are
 * rendered in three structurally distinct places:
 *
 * | Register            | Source                          | Rendered as |
 * | ------------------- | ------------------------------- | ----------- |
 * | `summary.headline`  | authored prose                  | one line between the title and the first region, in neither |
 * | `summary.observed`  | the validated analysis          | the `Observed` region: one list item per fact, each with its evidence chips |
 * | `summary.likelyCauses` | the validated analysis       | the `Likely cause` region: a confidence badge, the statement, its evidence chips and an optional source chip |
 *
 * **This component invents, derives and filters nothing.** Every string it
 * renders is either a field of `summary`, one of the two region labels the
 * product fixes by name ({@link OBSERVED_LABEL}, {@link LIKELY_CAUSE_LABEL}),
 * one of the two sentences that state an empty register — {@link NO_FACTS_TEXT}
 * for the observed one and, when the caller opts in with
 * {@link SummaryHeaderProps.showEmptyCauses}, {@link NO_CAUSES_TEXT} for the
 * likely-cause one — the version wording built from the caller's own
 * {@link SummaryHeaderProps.version} number ({@link versionBadgeText},
 * {@link versionUpdatesText}), or the keyboard hint of the selectable evidence
 * chips ({@link CHIP_KEYBOARD_HINT}). It computes no statistic, drops no evidence
 * reference, deduplicates nothing, re-words nothing and reorders nothing — the
 * single exception is {@link SummaryHeaderProps.sortByConfidence}, which sorts
 * a *copy* of the hypothesis list with the schema package's own comparator and
 * is off by default, because the order the analysis supplied is itself a
 * product of the analysis.
 *
 * ## Why the headline is kept outside both regions
 *
 * The panel authoring schema accepts `summary` as a bare string, and
 * `@debuggen/panel-schema`'s normaliser stores that string as
 * `summary.headline` precisely so that it can never become a `Fact`: facts are
 * copied only from the validated analysis, and every one of them carries at
 * least one evidence reference by schema construction. Rendering
 * that prose among the observations — as a list item, with a fact's typography,
 * or beside evidence chips it did not cite — would undo the guarantee in the
 * one place the developer actually looks. So the headline is a single element
 * outside both region elements, carries no chip list, and is styled as summary
 * prose rather than as an observation.
 *
 * ## Host independence
 *
 * Nothing from the host tier (`src/host`) is imported: not the panel actions,
 * not the data provider, not the query hook, and no React context is created or
 * consumed here. Both interactions leave through plain props — `selectEvent` and
 * `openSource` — which keeps the module graph acyclic (the host renders this
 * component, never the other way round) and lets the editor webview reuse this
 * component with no provider and no transport in scope.
 *
 * The two props are spelled, and typed, as the host form of the panel action
 * contract: `selectEvent(eventId, coordinates?)` over the schema's own
 * `EventRef.eventId` and its `traceId`/`spanId` coordinates, and
 * `openSource(location)` over the shared `SourceLocation`. They are declared
 * structurally rather than imported, so a surface's host actions satisfy them
 * member for member without this module knowing that tier exists.
 *
 * ## Class-name contract implemented by `../styles/components.css`
 *
 * Block `dg-summary-header`; elements `__title-row`, `__title`, `__version`,
 * `__headline`, `__region`, `__region-heading`, `__facts`, `__fact`,
 * `__statement`, `__evidence`, `__chip`, `__confidence`, `__confidence-group`,
 * `__location`, `__none`; variants `__region--observed` and `__region--causes`.
 * `__confidence-group` keeps a cause's visible "Confidence" label and its level
 * badge together on one line when the row wraps.
 *
 * `__title-row` holds the title and, for a later generation of the document,
 * `__version` beside it: the version badge and the sentence naming the version
 * it updates, wrapping under the title when the row is too narrow for both.
 *
 * `__title` is also a focus target by contract: the heading carries
 * `tabindex="-1"`, so a host can move focus to it by script — the panel host
 * does when a replaced document took the focused element with it — while it
 * never becomes a stop in the tab order. Its focus ring is the global
 * `:focus-visible` indicator of `../styles/base.css`. It is also a name by
 * contract: a host may hand its `id` in through `titleId`, and the panel host
 * does, so the panel's scroll region is named by this visible title.
 *
 * `__none` is the muted sentence a region holds when its register is empty —
 * the observed region always, the likely-cause region only under
 * `showEmptyCauses`: it sits where the list would, on the same measured edge, so
 * "nothing was observed" or "no cause was identified" reads as the register's
 * answer rather than as a finding.
 *
 * The confidence badge (`__confidence`) grades its level three ways beside the
 * level word: by tone, by glyph ({@link CONFIDENCE_ICON}) and by fill
 * ({@link CONFIDENCE_VARIANT} — outline, soft, solid), so two levels whose
 * tones read alike on a surface are still told apart by how much of the chip is
 * filled.
 *
 * `__chip` marks a *selectable* evidence chip only. A citation rendered with no
 * selection handler is a plain outline `Badge` and carries no element class of
 * this block, so no rule here can give it a control's hover feedback. A
 * selectable chip citing the panel's selected event also carries the shared
 * `dg-is-selected` state class, always beside `aria-pressed="true"`. The class
 * is also how a region's roving tab stop finds its chips: each region's
 * selectable chips are one tab stop, moved between with the arrow keys, Home
 * and End (see `useChipRoving`), so a head citing many events adds two stops to
 * the tab order rather than one per citation.
 *
 * `__headline` must read as summary prose and must stay visually
 * distinguishable from `__statement`: that visual separation is the on-screen
 * half of the guarantee above, and a headline that looks like a fact is a
 * defect even when the markup is correct. The two region variants carry the
 * observed/inferred distinction in the visual register, and the region headings
 * and separate landmarks carry it for assistive technology, so the distinction
 * is never colour alone.
 *
 * No value in this file is a CSS literal, and there is no `style` prop, no
 * inline style and no `--dgc-*` property: appearance is selected by class name
 * and resolved against the `--dg-*` tokens in the stylesheet.
 *
 * @example The head of a generated panel, wired to the host's actions
 * ```tsx
 * <SummaryHeader
 *   title={spec.title}
 *   summary={spec.summary}
 *   version={{ current: spec.panelVersion, supersedes: spec.supersedes !== undefined }}
 *   selectEvent={hostActions.selectEvent}
 *   selectedEventId={selection?.eventId}
 *   openSource={hostActions.openSource}
 * />
 * ```
 *
 * @example The same component in the editor webview, with no host in scope
 * ```tsx
 * <SummaryHeader
 *   title={analysisTitle}
 *   summary={summary}
 *   headingLevel={3}
 *   openSource={(location) => { postToExtensionHost(location); }}
 * />
 * ```
 *
 * @module
 */

import { useCallback, useId, useMemo, useState } from 'react';
import type { FocusEvent, KeyboardEvent, ReactElement } from 'react';
import clsx from 'clsx';
import { SignalHigh, SignalLow, SignalMedium } from 'lucide-react';

import { compareConfidence } from '@debuggen/panel-schema';
import type {
  ConfidenceLevel,
  EventRef,
  Fact,
  Hypothesis,
  PanelSummary,
} from '@debuggen/panel-schema';
import type { SourceLocation } from '@debuggen/shared';

import { SourceLink } from '../components/SourceLink';
import { Badge } from '../primitives/Badge';
import type { BadgeTone, BadgeVariant } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Heading } from '../primitives/Heading';
import type { HeadingLevel } from '../primitives/Heading';
import { Text } from '../primitives/Text';

/**
 * The label of the region that lists what the capture shows.
 *
 * One of the two region labels this module owns. Both are fixed product copy:
 * the observed facts sit under an "Observed" heading and the likely causes
 * under a separate "Likely cause" heading, in the DevTools panel and in the
 * editor webview alike — so they are declared here as constants rather than
 * written twice. The other strings this file owns are the two empty-register
 * sentences, {@link NO_FACTS_TEXT} and {@link NO_CAUSES_TEXT}, the version
 * wording ({@link versionBadgeText}, {@link versionUpdatesText}) and
 * {@link CHIP_KEYBOARD_HINT}; no other caption or hint is invented here.
 */
const OBSERVED_LABEL = 'Observed';

/** The label of the separate region that lists what the analysis infers. */
const LIKELY_CAUSE_LABEL = 'Likely cause';

/**
 * What the observed region says when the summary lists no facts.
 *
 * The head states it rather than omitting the region: a panel whose head shows
 * only a title reads exactly like one whose analysis failed to reach it, and
 * "nothing was observed" is itself an answer the reader needs before the views
 * below — the shape a deterministic fallback panel over an empty capture
 * takes. It is a statement about the register, not a fact: it names no event,
 * carries no evidence chip and is never a list item. Generic product wording,
 * naming nothing of an inspected project.
 */
const NO_FACTS_TEXT = 'No facts were observed.';

/**
 * The generation a document starts at. A panel's `panelVersion` and an
 * analysis's `analysisVersion` both count from here, and a follow-up question
 * stores its answer as generation `n + 1` naming generation `n` as the one it
 * supersedes (AAP 0.4.2).
 */
const FIRST_VERSION = 1;

/**
 * What the version sentence says for a document that names a predecessor but
 * whose own number leaves that predecessor without one — a generation-1
 * document carrying a `supersedes` link. The relation is still stated, since
 * the document itself claims it; a number the caller never supplied is not
 * invented for it.
 */
const UPDATES_EARLIER_VERSION_TEXT = 'Updates an earlier version';

/**
 * The description every selectable evidence chip carries, through
 * `aria-describedby`: how to move between the chips of a region that is a
 * single tab stop, and how to select one. Visually hidden — a sighted keyboard
 * user sees the focus ring move — and generic product wording.
 */
const CHIP_KEYBOARD_HINT =
  'Use the arrow keys to move between evidence chips, Home and End to reach the first and last, and Enter or Space to select the cited event.';

/**
 * The global visually hidden utility of `../styles/base.css`: kept in the
 * accessibility tree, removed from the visual surface.
 */
const VISUALLY_HIDDEN_CLASS = 'dg-visually-hidden';

/** The region element class as a selector: the scope of one roving tab stop. */
const REGION_SELECTOR = '.dg-summary-header__region';

/**
 * The selectable chip class as a selector: how a region's chips are found, in
 * document order, when a key moves focus between them.
 */
const CHIP_SELECTOR = '.dg-summary-header__chip';

/**
 * What the likely-cause region says when the analysis infers no cause and the
 * caller asked for the region anyway ({@link SummaryHeaderProps.showEmptyCauses}).
 *
 * A surface that shows the head as its only account of the analysis — the
 * editor webview — needs the register to answer even when it is empty: without
 * it, a head whose inference found nothing reads exactly like one whose cause
 * list failed to arrive. Like {@link NO_FACTS_TEXT} it is a statement about the
 * register, not an inference: no confidence badge, no evidence chip and never a
 * list item. Generic product wording, naming nothing of an inspected project.
 */
const NO_CAUSES_TEXT = 'No likely cause was identified.';

/**
 * The deepest heading level the document outline has, and the ceiling the
 * region headings are clamped to.
 */
const DEEPEST_HEADING_LEVEL: HeadingLevel = 6;

/** The heading level a caller gets when it states none. */
const DEFAULT_HEADING_LEVEL: HeadingLevel = 2;

/**
 * The badge tone per confidence level — total by type, so a fourth level added
 * to the schema's vocabulary stops this file compiling until it says what the
 * new level looks like.
 *
 * **Confidence is not severity.** A low-confidence hypothesis is a weaker
 * guess, not a worse problem, so the `warning` and `danger` tones are
 * deliberately unreachable from here: they mean "this is bad" everywhere else
 * in the system, and spending them on an epistemic scale would tell the
 * developer something the analysis never said. The scale runs neutral →
 * informational → accent instead, which reads as increasing emphasis without
 * borrowing a status colour. The level word is always rendered as the badge's
 * text, every level has a glyph of its own shape ({@link CONFIDENCE_ICON}) and a
 * fill of its own weight ({@link CONFIDENCE_VARIANT}), so the ranking is never
 * carried by colour alone.
 *
 * Typed as a `Record` over the closed union rather than derived from the
 * schema's runtime vocabulary, matching how `../utils/color.ts` types its kind
 * map: the exhaustiveness is then a compile-time property of this table.
 */
const CONFIDENCE_TONE: Record<ConfidenceLevel, BadgeTone> = {
  low: 'neutral',
  medium: 'info',
  high: 'accent',
};

/**
 * The badge fill per confidence level — total by type for the same reason as
 * {@link CONFIDENCE_TONE}.
 *
 * The fill rises with the level along `Badge`'s own prominence scale: `outline`
 * (no surface) for a weak guess, `soft` for a plausible one, `solid` (the tone
 * spent on the whole chip) for the analysis's strongest inference. Tone alone
 * is not enough to grade the levels: on a card surface — and in the dark theme
 * throughout — the informational and accent tones are two blues a reader can
 * mistake for each other, and a soft chip's surface matches the card's, so
 * without a graded fill the three badges differ by text colour only. With it,
 * the level is carried by the word, the glyph's bar count and the amount of
 * fill — never by colour alone, and still borrowing no status colour. The fills
 * are the primitive's variants, so every colour still resolves through
 * `../styles/components.css` to `--dg-*` tokens in every theme.
 */
const CONFIDENCE_VARIANT: Record<ConfidenceLevel, BadgeVariant> = {
  low: 'outline',
  medium: 'soft',
  high: 'solid',
};

/**
 * The visible label beside every confidence badge. The badge prints only the
 * level word; without this a reader sees "high" or "low" and has to guess what
 * is being ranked.
 */
const CONFIDENCE_LABEL = 'Confidence';

/**
 * The glyph per confidence level — total by type for the same reason as
 * {@link CONFIDENCE_TONE}.
 *
 * A signal-strength scale whose bar count rises with the level, so the three
 * badges differ by **shape** as well as by tone: two tones that a reader cannot
 * tell apart (a colour-vision deficiency, a monochrome screen, the
 * high-contrast theme) still leave the levels distinguishable at a glance,
 * beside the level word that names them. The glyph is decorative —
 * `Badge` keeps its box `aria-hidden` — because the word already is the
 * accessible text. Each is rendered with the global `dg-icon` class, which
 * sizes it to the badge's type role and paints it in `currentColor`, so the
 * glyph never carries a colour or a size of its own.
 */
const CONFIDENCE_ICON: Record<ConfidenceLevel, ReactElement> = {
  low: <SignalLow className="dg-icon" />,
  medium: <SignalMedium className="dg-icon" />,
  high: <SignalHigh className="dg-icon" />,
};

/**
 * The heading level of a region inside a head whose title sits at `level`.
 *
 * One step deeper, clamped at {@link DEEPEST_HEADING_LEVEL}: a generated panel
 * can be nested to arbitrary depth, and a level of `7` is not an element. The
 * clamp keeps the outline legal at the bottom of the range at the cost of one
 * duplicated level there, which is the better of the two failures — a heading
 * that does not exist is announced by nothing at all.
 *
 * @param level The level of the head's own title.
 * @returns The level both region headings render at.
 */
function regionHeadingLevel(level: HeadingLevel): HeadingLevel {
  return level >= DEEPEST_HEADING_LEVEL ? DEEPEST_HEADING_LEVEL : ((level + 1) as HeadingLevel);
}

/**
 * Whether a value is a string with something visible in it.
 *
 * Used for the headline and for the chip captions. The schema already rejects a
 * blank string in both places, but this component is also rendered in the
 * editor webview from a value that crossed a message boundary, and a caption
 * that is present and blank would produce a control with no accessible name.
 *
 * @param value A possibly absent string.
 * @returns `true` when the value can be rendered as visible text.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * The visible caption of one evidence chip.
 *
 * Every candidate is data the citation carried: the author's `label` first,
 * then the event `kind`, then the `eventId` that is the one field an
 * {@link EventRef} always has. No caption is invented, and nothing is
 * truncated — a chip's width is the stylesheet's decision, not this module's.
 *
 * The final fallback is `eventId` again and stated explicitly: a chip must
 * always have an accessible name, and reaching this line means the first two
 * candidates were absent or blank.
 *
 * @param ref The citation to caption.
 * @returns The chip's visible text.
 */
function evidenceChipLabel(ref: EventRef): string {
  if (hasText(ref.label)) {
    return ref.label;
  }

  if (hasText(ref.kind)) {
    return ref.kind;
  }

  return ref.eventId;
}

/**
 * The optional coordinates a citation carries beside its id: its trace and its
 * span. Picked from the schema's own {@link EventRef}, so the head declares the
 * selection callback's second argument without restating the citation shape.
 */
type CitationCoordinates = Pick<EventRef, 'traceId' | 'spanId'>;

/**
 * The coordinates of one citation, holding only the keys it recorded.
 *
 * A key is never written with an `undefined` value, so a receiver sees exactly
 * the hints the analysis cited — no more, and none invented — and `kind` and
 * `label`, which are display sugar for this chip, are not coordinates and do
 * not travel.
 *
 * @param ref The activated citation.
 * @returns A fresh object with the citation's present coordinates, possibly empty.
 */
function citationCoordinates(ref: EventRef): CitationCoordinates {
  const { traceId, spanId } = ref;

  return {
    ...(traceId === undefined ? {} : { traceId }),
    ...(spanId === undefined ? {} : { spanId }),
  };
}

/**
 * The selectable chips of one region, flattened: each statement's first flat
 * index, and every chip's cited event id in document order.
 */
interface RegionChips {
  /** Per statement, in order, the flat index of its first chip. */
  readonly offsets: readonly number[];

  /** Per chip, in document order, the `eventId` it cites. */
  readonly eventIds: readonly string[];
}

/**
 * Flattens the evidence of one region's statements into {@link RegionChips}.
 *
 * @param statements The region's facts or hypotheses, in render order.
 * @returns The offsets and the cited ids.
 */
function regionChipsOf(
  statements: readonly { readonly evidence: readonly EventRef[] }[],
): RegionChips {
  const offsets: number[] = [];
  const eventIds: string[] = [];

  for (const statement of statements) {
    offsets.push(eventIds.length);
    for (const ref of statement.evidence) {
      eventIds.push(ref.eventId);
    }
  }

  return { offsets, eventIds };
}

/**
 * Where one region's roving tab stop is: the flat index of the chip focus was
 * last on, and whether focus is on one of the region's chips right now.
 */
interface ChipFocusState {
  /** The flat index of the chip that last took focus; `0` before any has. */
  readonly index: number;

  /** Whether that chip — or another of the region's chips — holds focus now. */
  readonly inside: boolean;
}

/** The roving tab stop of one region's selectable chips, as its chips use it. */
interface ChipRoving {
  /** The `tabIndex` the chip at a flat index renders with: `0` for the stop, `-1` otherwise. */
  readonly tabIndexOf: (index: number) => 0 | -1;

  /** Records that the chip at a flat index took focus — by key, pointer or script. */
  readonly onChipFocus: (index: number) => void;

  /** Notes that focus left the region's chips, unless it moved to another of them. */
  readonly onChipBlur: (event: FocusEvent<HTMLButtonElement>) => void;

  /** Moves focus between the region's chips on the arrow keys, Home and End. */
  readonly onChipKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * The roving tab stop over one region's selectable evidence chips — the APG
 * pattern `../primitives/DataTable` applies to its rows, applied here to the
 * chips of every statement in the region at once.
 *
 * **One tab stop per region.** Exactly one chip renders `tabIndex={0}` and
 * every other `-1`, so Tab enters the region on one chip and the next Tab leaves
 * it — a head citing forty events is two stops, not forty. Which chip:
 *
 * - while focus is on one of the region's chips, that chip;
 * - otherwise the chip focus was last on, if it cites the selected event;
 * - otherwise the first chip citing the selected event, when one does;
 * - otherwise the chip focus was last on, or the first chip.
 *
 * So Tab back into a region returns to where the reader was, or to the
 * evidence of the event the panel has selected when the selection moved since.
 *
 * **Keys.** ArrowRight and ArrowDown move to the next chip, ArrowLeft and
 * ArrowUp to the previous one, Home and End to the first and last; movement
 * stops at either end rather than wrapping. `preventDefault` is called only for
 * those keys, and a key with a modifier is left to the browser. Enter and Space
 * keep their native meaning on the button — they activate it, which selects
 * the cited event. The chips are found in the region's DOM in document order,
 * the same order as their flat indices.
 *
 * @param eventIds The region's chips' cited event ids, in document order.
 * @param selectedEventId The panel's selected event, if any.
 * @returns The stop and the handlers the region's chips carry.
 */
function useChipRoving(
  eventIds: readonly string[],
  selectedEventId: string | undefined,
): ChipRoving {
  const [focus, setFocus] = useState<ChipFocusState>({ index: 0, inside: false });
  const count = eventIds.length;

  // The last-focused chip, clamped: a re-delivered summary may carry fewer
  // chips than the index recorded against the previous one.
  const last = focus.index < count ? focus.index : 0;

  let stop = last;
  if (!focus.inside && selectedEventId !== undefined && eventIds[last] !== selectedEventId) {
    const selected = eventIds.indexOf(selectedEventId);
    if (selected >= 0) {
      stop = selected;
    }
  }

  const tabIndexOf = useCallback((index: number): 0 | -1 => (index === stop ? 0 : -1), [stop]);

  const onChipFocus = useCallback((index: number): void => {
    setFocus((previous) =>
      previous.index === index && previous.inside ? previous : { index, inside: true },
    );
  }, []);

  const onChipBlur = useCallback((event: FocusEvent<HTMLButtonElement>): void => {
    const next = event.relatedTarget;
    const region = event.currentTarget.closest(REGION_SELECTOR);

    // Focus moving to another chip of this region is recorded by that chip's
    // own focus handler; anything else leaves the region.
    if (next !== null && next.matches(CHIP_SELECTOR) && region?.contains(next) === true) {
      return;
    }

    setFocus((previous) => (previous.inside ? { index: previous.index, inside: false } : previous));
  }, []);

  const onChipKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }

    const region = event.currentTarget.closest(REGION_SELECTOR);
    if (region === null) {
      return;
    }

    const chips = Array.from(region.querySelectorAll<HTMLElement>(CHIP_SELECTOR));
    const from = chips.indexOf(event.currentTarget);
    if (from < 0) {
      return;
    }

    let to: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        to = Math.min(from + 1, chips.length - 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        to = Math.max(from - 1, 0);
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = chips.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    chips[to]?.focus();
  }, []);

  return useMemo(
    () => ({ tabIndexOf, onChipFocus, onChipBlur, onChipKeyDown }),
    [tabIndexOf, onChipFocus, onChipBlur, onChipKeyDown],
  );
}

/** Props of {@link EvidenceChips}. */
interface EvidenceChipsProps {
  /**
   * The citations to render, in the order they were supplied. Never filtered,
   * never deduplicated and never sorted: the evidence list is part of the
   * validated analysis.
   */
  evidence: readonly EventRef[];

  /**
   * Invoked with the citation's `eventId` and its recorded coordinates when a
   * chip is activated. Absent, every citation renders as inert text instead of
   * a control — see {@link EvidenceChips} for why. The head's own
   * {@link SummaryHeaderProps.selectEvent}, handed down unchanged.
   */
  selectEvent?: SummaryHeaderProps['selectEvent'];

  /**
   * The id of the event the panel currently has selected, or `undefined` when
   * nothing is. The head's own {@link SummaryHeaderProps.selectedEventId},
   * handed down unchanged.
   */
  selectedEventId?: string | undefined;

  /**
   * The flat index, within this list's region, of this list's first chip —
   * the position {@link ChipRoving} knows it by.
   */
  firstIndex: number;

  /** The region's roving tab stop. Read only by selectable chips. */
  roving: ChipRoving;

  /**
   * The id of the element holding {@link CHIP_KEYBOARD_HINT}, which every
   * selectable chip is described by.
   */
  chipHintId: string;
}

/**
 * The evidence chips of one fact or hypothesis.
 *
 * A real list, so assistive technology announces how many citations a statement
 * carries. What each item holds depends on whether anything can act on it:
 *
 * - **With a selection handler**, one `Button` per chip: the design system
 *   requires its own control primitive in place of a raw element,
 *   and a `span` with a click handler would lose keyboard operation and the
 *   focus ring that `../styles/base.css` applies to every `:focus-visible`
 *   element. The chips of a whole region share one roving tab stop (see
 *   {@link useChipRoving}): one chip is in the tab order, the arrow keys, Home
 *   and End move between the others, and each chip is described by the
 *   visually hidden {@link CHIP_KEYBOARD_HINT} that says so. The region — a
 *   `section` named by its "Observed" or "Likely cause" heading — is the named
 *   container holding the set, so no second grouping role is layered on it.
 * - **Without one**, one outline `Badge` per citation: the caption is still
 *   information — which event substantiates the statement — so it is still
 *   rendered, and still carries `data-event-id`, but as a citation rather than
 *   a control. It is not focusable, has no button role and takes neither the
 *   chip's hover feedback nor its pointer, because a control whose activation
 *   does nothing tells a keyboard or screen-reader user that something happened
 *   when nothing did. `disabled` would be the wrong fix too: a disabled control
 *   is dimmed and announced as unavailable, which misreports a citation that
 *   was never meant to be operable in that surface (the editor webview renders
 *   this head with no event selection at all). Its accent outline, its place
 *   after the statement and the absence of a glyph keep it visually apart from
 *   the confidence badge, which leads the statement with its level's glyph.
 *
 * **The selected state.** A selectable chip is a toggle-like control over "is
 * this the panel's selected event", so it always carries `aria-pressed`: `true`
 * on every chip whose citation names the selected event, `false` on the rest.
 * A pressed chip also carries the design system's one selected-state class,
 * `dg-is-selected`, so the state is drawn as well as announced — the attribute
 * and the class come from one comparison and cannot drift. Matching is by
 * `eventId` alone, the one coordinate every citation has; a chip citing the
 * same event twice is pressed twice. An inert citation carries neither: it is
 * not a control, so it has no pressed state to report.
 *
 * `../components/SourceLink.tsx` is the only sibling rendered by this module's
 * exported component, and this internal one renders nothing but primitives.
 *
 * @param props See {@link EvidenceChipsProps}.
 * @returns The chip list.
 */
function EvidenceChips(props: EvidenceChipsProps): ReactElement {
  const { evidence, selectEvent, selectedEventId, firstIndex, roving, chipHintId } = props;

  return (
    <ul className="dg-summary-header__evidence">
      {evidence.map((ref, index) => {
        const selected = selectedEventId !== undefined && ref.eventId === selectedEventId;
        const flatIndex = firstIndex + index;

        return (
          // `eventId` is not guaranteed unique inside one evidence list — a fact
          // may legitimately cite the same event twice through two coordinates —
          // so the index joins the key rather than standing in for it.
          <li key={`${ref.eventId}#${String(index)}`}>
            {selectEvent === undefined ? (
              <Badge tone="accent" variant="outline" data-event-id={ref.eventId}>
                {evidenceChipLabel(ref)}
              </Badge>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className={clsx('dg-summary-header__chip', selected && 'dg-is-selected')}
                aria-pressed={selected}
                aria-describedby={chipHintId}
                data-event-id={ref.eventId}
                tabIndex={roving.tabIndexOf(flatIndex)}
                onFocus={() => {
                  roving.onChipFocus(flatIndex);
                }}
                onBlur={roving.onChipBlur}
                onKeyDown={roving.onChipKeyDown}
                onClick={() => {
                  // The schema's `eventId` is what the host resolves; the trace
                  // and span the citation recorded travel beside it, so the host
                  // can scope a trace-filtered view without a lookup.
                  selectEvent(ref.eventId, citationCoordinates(ref));
                }}
              >
                {evidenceChipLabel(ref)}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Which generation of its document a head introduces, as the caller read it
 * off that document.
 *
 * Declared structurally, like the two callbacks: the panel host passes a
 * panel's `panelVersion` and whether it carries `supersedes`, and the editor
 * webview passes an analysis's `analysisVersion` and `supersedes`, so neither
 * surface's document type is imported here.
 */
export interface SummaryHeaderVersion {
  /**
   * The document's generation, counting from 1 — `PanelSpec.panelVersion` or
   * `AnalysisResult.analysisVersion`, handed over unchanged.
   */
  readonly current: number;

  /**
   * Whether the document names a predecessor it supersedes (its `supersedes`
   * field is set). A flag rather than the predecessor's id: the head states the
   * relation between two versions and never prints an identifier.
   */
  readonly supersedes?: boolean | undefined;
}

/**
 * Whether a version is one the head states.
 *
 * Only a later generation is: a first version has nothing it updates, and a
 * badge on every first panel would make the badge that matters — the one on
 * an answer that moved on — indistinguishable from noise. A document that
 * names a predecessor is stated whatever its number says. A number that is not
 * a whole generation of at least one — a value that crossed a message boundary
 * malformed — is not stated at all, so the head never prints "Version NaN".
 *
 * @param version The caller's version, possibly absent.
 * @returns `true` when {@link VersionIndicator} renders for it.
 */
function isStatedVersion(
  version: SummaryHeaderVersion | undefined,
): version is SummaryHeaderVersion {
  if (version === undefined || !Number.isInteger(version.current)) {
    return false;
  }

  if (version.current < FIRST_VERSION) {
    return false;
  }

  return version.current > FIRST_VERSION || version.supersedes === true;
}

/**
 * The version badge's text: "Version 2".
 *
 * @param current The document's generation.
 * @returns The badge caption.
 */
function versionBadgeText(current: number): string {
  return `Version ${String(current)}`;
}

/**
 * The sentence beside the version badge, naming the version this one updates.
 *
 * The predecessor of generation `n` is generation `n - 1`, because a follow-up
 * stores its answer as the next generation of the one it replaces (AAP 0.4.2).
 * A document at the first generation that still names a predecessor gets
 * {@link UPDATES_EARLIER_VERSION_TEXT} instead of a generation zero.
 *
 * @param version A version {@link isStatedVersion} admitted.
 * @returns The sentence, e.g. "Updates version 1".
 */
function versionUpdatesText(version: SummaryHeaderVersion): string {
  return version.current > FIRST_VERSION
    ? `Updates version ${String(version.current - 1)}`
    : UPDATES_EARLIER_VERSION_TEXT;
}

/** Props of {@link VersionIndicator}. */
interface VersionIndicatorProps {
  /** A version {@link isStatedVersion} admitted. */
  version: SummaryHeaderVersion;
}

/**
 * The version of a later-generation document, stated beside its title.
 *
 * An outline `Badge` in the informational tone names the generation and a
 * secondary `Text` names the one it updates, so the reader learns both that the
 * answer moved on and from where, in words rather than by colour. The outline
 * variant keeps it apart from the soft confidence badges and the accent-toned
 * citations below it. Neither is a control, a heading or a live region: the
 * title stays the document's own, and announcing a replacement is the business
 * of the host that performed it.
 *
 * @param props See {@link VersionIndicatorProps}.
 * @returns The badge and the sentence, in one inline group.
 */
function VersionIndicator(props: VersionIndicatorProps): ReactElement {
  const { version } = props;

  return (
    <span className="dg-summary-header__version">
      <Badge tone="info" variant="outline">
        {versionBadgeText(version.current)}
      </Badge>
      <Text size="sm" tone="secondary">
        {versionUpdatesText(version)}
      </Text>
    </span>
  );
}

/**
 * Props of {@link SummaryHeader}.
 *
 * Every optional property spells `| undefined`: `exactOptionalPropertyTypes` is
 * in force repository-wide, so a caller forwarding a value it may not have —
 * `openSource={hostActions?.openSource}` — must remain legal.
 */
export interface SummaryHeaderProps {
  /**
   * The panel's title. Rendered verbatim as the head's heading, except that the
   * `Heading` primitive prints each Unicode direction control in it as its
   * visible `\u202E`-style escape, so a model-authored title cannot display
   * its characters in an order other than the one they were written in.
   */
  title: string;

  /**
   * The panel's summary: the optional non-evidentiary headline, the observed
   * facts and the likely causes.
   *
   * Taken as **one object** rather than three props on purpose. The whole point
   * of `PanelSummary` is that its three registers arrived together from one
   * validated artifact; accepting them separately would let a caller pair
   * facts from one source with a headline from another, which is exactly the
   * recombination the schema and its normaliser exist to prevent.
   */
  summary: PanelSummary;

  /**
   * Which generation of its document this head introduces. A later generation —
   * `current` above 1, or `supersedes` set — is stated beside the title as a
   * "Version n" badge and an "Updates version n-1" sentence; a first version,
   * or no value at all, adds nothing. The title itself is never changed.
   */
  version?: SummaryHeaderVersion | undefined;

  /**
   * The outline depth of the title. Defaults to `2`, and both region headings
   * render one level deeper, clamped at `6`.
   */
  headingLevel?: HeadingLevel | undefined;

  /**
   * Called when an evidence chip is activated, with the citation's
   * `EventRef.eventId` and, as the second argument, the `traceId`/`spanId`
   * coordinates it recorded — only the keys it holds, possibly none. The host
   * form's `selectEvent`, so a surface passes its own member straight in.
   * Omitted, every citation still renders, as inert text rather than as a
   * control, so no focusable element does nothing when activated.
   */
  selectEvent?:
    | ((eventId: EventRef['eventId'], coordinates?: Pick<EventRef, 'traceId' | 'spanId'>) => void)
    | undefined;

  /**
   * The `EventRef.eventId` of the event the panel currently has selected, or
   * `undefined` while nothing is.
   *
   * Every selectable evidence chip citing that event is drawn pressed —
   * `aria-pressed="true"` and the `dg-is-selected` state class — and every
   * other selectable chip reports `aria-pressed="false"`, so the chip a reader
   * activated, and the chips of every other statement citing the same event,
   * stay marked for as long as that event is the selection. A plain string
   * rather than the host's selection object, because this component imports
   * nothing from the host tier: the panel host passes the id of its shared
   * selection, and a surface without one passes nothing. Has no effect on a
   * head rendered without {@link SummaryHeaderProps.selectEvent}, whose
   * citations are inert text.
   */
  selectedEventId?: string | undefined;

  /**
   * Called with the exact {@link SourceLocation} a hypothesis suggested when
   * its source chip is activated — the host form's `openSource`. Passed
   * explicitly to `SourceLink`'s `onOpenSource` rather than left to that
   * component's host fallback, so this head works unchanged in a surface with
   * no panel actions in scope.
   */
  openSource?: ((location: SourceLocation) => void) | undefined;

  /**
   * Render the likely causes most-confident-first instead of in the order the
   * analysis supplied. Defaults to `false`.
   */
  sortByConfidence?: boolean | undefined;

  /**
   * Render the likely-cause region even when the analysis infers no cause, with
   * its "Likely cause" heading over one muted sentence, {@link NO_CAUSES_TEXT},
   * in place of the list. Defaults to `false`, which omits the region when there
   * is no cause — the generated DevTools panel's behaviour, where the views
   * below the head carry the evidence. A surface whose head is its only account
   * of the analysis (the editor webview) opts in, so an empty inference reads as
   * the register's answer rather than as a region that failed to render.
   */
  showEmptyCauses?: boolean | undefined;

  /** Extra class names, appended after the block's own. */
  className?: string | undefined;

  /** The `id` of the rendered `header` element. */
  id?: string | undefined;

  /**
   * The `id` to give the title heading, for a host that names a region after
   * the panel title — the panel host hands the same value to `PanelShell`'s
   * `labelledBy`, so the scroll region is announced by the title the reader
   * sees. The caller keeps it unique in the document, typically with `useId`.
   * Omitted, or blank, the heading keeps an id generated here, which nothing
   * outside this head is expected to reference.
   */
  titleId?: string | undefined;
}

/**
 * Renders a panel's title, its non-evidentiary headline, its observed facts and
 * its likely causes.
 *
 * The observed region is always rendered. With no facts it holds a single
 * muted sentence, {@link NO_FACTS_TEXT}, instead of a list, so a summary with
 * neither facts nor causes — the shape a deterministic fallback panel can take
 * — still says what the capture showed rather than rendering as a bare title.
 * By default the likely-cause region is rendered only when there is a cause to
 * list: an absent inference is not a finding, and in a panel whose views carry
 * the evidence a heading over nothing would introduce nothing. With
 * {@link SummaryHeaderProps.showEmptyCauses} the region is always rendered, and
 * with no cause it holds {@link NO_CAUSES_TEXT} the way the observed region
 * holds {@link NO_FACTS_TEXT}: a muted statement about the register, never a
 * list item, never a badge and never a citation.
 *
 * @param props See {@link SummaryHeaderProps}.
 * @returns The panel head.
 *
 * @example The editor's head, which answers for an empty inference too
 * ```tsx
 * <SummaryHeader title={title} summary={summary} headingLevel={3} showEmptyCauses />
 * ```
 */
export function SummaryHeader(props: SummaryHeaderProps): ReactElement {
  const {
    title,
    summary,
    version,
    headingLevel = DEFAULT_HEADING_LEVEL,
    selectEvent,
    selectedEventId,
    openSource,
    sortByConfidence = false,
    showEmptyCauses = false,
    className,
    id,
    titleId: suppliedTitleId,
  } = props;

  // One generated prefix for the ids this head needs. `useId` rather than a
  // counter or the caller's `id`: two panels can be on one page — the editor
  // webview mirrors the DevTools panel — and a collision would point a region's
  // `aria-labelledby` at another panel's heading. The title alone may take a
  // caller's id instead, so a host can name its own region after it; a blank
  // one is ignored, because an empty `id` would leave that reference dangling.
  const generatedId = useId();
  const titleId =
    suppliedTitleId !== undefined && suppliedTitleId.trim() !== ''
      ? suppliedTitleId
      : `${generatedId}-title`;
  const observedHeadingId = `${generatedId}-observed`;
  const causesHeadingId = `${generatedId}-causes`;

  const regionLevel = regionHeadingLevel(headingLevel);

  const facts: readonly Fact[] = summary.observed;

  // A copy, always: the prop is the validated artifact and sorting in place
  // would mutate it for every other consumer of the same object. `sort` is
  // stable in this target, so hypotheses at one level keep the analysis's
  // order, and `compareConfidence` is the schema package's own comparator with
  // its arguments reversed — the documented way to ask for descending
  // confidence without restating which level outranks which.
  const causes: readonly Hypothesis[] = sortByConfidence
    ? [...summary.likelyCauses].sort((left, right) =>
        compareConfidence(right.confidence, left.confidence),
      )
    : summary.likelyCauses;

  // One roving tab stop per region (see `useChipRoving`), over every chip of
  // every statement in it, in render order. Both hooks run whether or not the
  // chips are selectable, as hooks must; an inert head simply never reads them.
  const observedChips = regionChipsOf(facts);
  const causeChips = regionChipsOf(causes);
  const observedRoving = useChipRoving(observedChips.eventIds, selectedEventId);
  const causeRoving = useChipRoving(causeChips.eventIds, selectedEventId);
  const chipHintId = `${generatedId}-chip-hint`;
  const hasSelectableChips =
    selectEvent !== undefined && observedChips.eventIds.length + causeChips.eventIds.length > 0;

  return (
    <header className={clsx('dg-summary-header', className)} id={id}>
      {/* The title keeps its own text and its own heading; a later generation's
          version sits beside it, outside the heading, so the heading's name is
          the document's title and nothing else. The heading is focusable by
          script and never a tab stop (`tabIndex={-1}`): a host that replaces
          the document under a reader's focus hands focus here, where the new
          document's name and version are the first things announced. */}
      <div className="dg-summary-header__title-row">
        <Heading
          level={headingLevel}
          id={titleId}
          tabIndex={-1}
          className="dg-summary-header__title"
        >
          {title}
        </Heading>
        {isStatedVersion(version) ? <VersionIndicator version={version} /> : null}
      </div>

      {hasText(summary.headline) ? (
        // Non-evidentiary prose, and deliberately nothing more: a single
        // paragraph between the title and the first region, inside neither, with
        // no heading of its own, no `role`, no live region, no invented label or
        // colon in front of it, and no evidence chips. It is the only place
        // authored prose may appear in this head.
        <Text as="p" tone="secondary" className="dg-summary-header__headline">
          {summary.headline}
        </Text>
      ) : null}

      <section
        className="dg-summary-header__region dg-summary-header__region--observed"
        aria-labelledby={observedHeadingId}
      >
        <Heading
          level={regionLevel}
          size="sm"
          tone="muted"
          id={observedHeadingId}
          className="dg-summary-header__region-heading"
        >
          {OBSERVED_LABEL}
        </Heading>
        {facts.length === 0 ? (
          // The register's own answer, not a fact: no list item, no evidence
          // chips, and muted so it cannot be read as a measured statement.
          <Text as="p" tone="muted" className="dg-summary-header__none">
            {NO_FACTS_TEXT}
          </Text>
        ) : (
          <ul className="dg-summary-header__facts">
            {facts.map((fact, index) => (
              <li key={`${fact.statement}#${String(index)}`} className="dg-summary-header__fact">
                {/* Verbatim: no truncation, no re-casing, no added punctuation.
                    The statement was redacted upstream, and this component
                    neither redacts nor logs it. `Text` prints a direction
                    control as its visible escape, which is display only: the
                    evidence chips below still carry the raw event ids. */}
                <Text as="p" className="dg-summary-header__statement">
                  {fact.statement}
                </Text>
                {/* `Fact.evidence` holds at least one reference by schema
                    construction, so there is no empty-evidence branch to write
                    and no reference to filter. */}
                <EvidenceChips
                  evidence={fact.evidence}
                  selectEvent={selectEvent}
                  selectedEventId={selectedEventId}
                  firstIndex={observedChips.offsets[index] ?? 0}
                  roving={observedRoving}
                  chipHintId={chipHintId}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {causes.length > 0 || showEmptyCauses ? (
        // A second, sibling region with its own heading and its own
        // `aria-labelledby` — never a subsection of the observed region and
        // never a continuation of its list. Two separately labelled regions are
        // what make the observed/inferred separation audible as well as visible.
        <section
          className="dg-summary-header__region dg-summary-header__region--causes"
          aria-labelledby={causesHeadingId}
        >
          <Heading
            level={regionLevel}
            size="sm"
            tone="muted"
            id={causesHeadingId}
            className="dg-summary-header__region-heading"
          >
            {LIKELY_CAUSE_LABEL}
          </Heading>
          {causes.length === 0 ? (
            // Reached only under `showEmptyCauses`: the register's own answer,
            // not an inference — no list item, no confidence badge, no chips,
            // and muted in the same class as the observed register's sentence.
            <Text as="p" tone="muted" className="dg-summary-header__none">
              {NO_CAUSES_TEXT}
            </Text>
          ) : (
            <ul className="dg-summary-header__facts">
              {causes.map((hypothesis, index) => (
                <li
                  key={`${hypothesis.statement}#${String(index)}`}
                  className="dg-summary-header__fact"
                >
                  {/* The level word is the badge's text and its accessible name,
                      and the visible "Confidence" label before it says what the
                      word ranks; the tone, the fill and the per-level glyph are
                      further, visual-only signals of the same level, so no
                      single one of them — and never colour alone — carries the
                      ranking. */}
                  <span className="dg-summary-header__confidence-group">
                    <Text as="span" size="xs" tone="muted">
                      {CONFIDENCE_LABEL}
                    </Text>
                    <Badge
                      tone={CONFIDENCE_TONE[hypothesis.confidence]}
                      variant={CONFIDENCE_VARIANT[hypothesis.confidence]}
                      icon={CONFIDENCE_ICON[hypothesis.confidence]}
                      className="dg-summary-header__confidence"
                      data-confidence={hypothesis.confidence}
                    >
                      {hypothesis.confidence}
                    </Badge>
                  </span>
                  <Text as="p" className="dg-summary-header__statement">
                    {hypothesis.statement}
                  </Text>
                  <EvidenceChips
                    evidence={hypothesis.evidence}
                    selectEvent={selectEvent}
                    selectedEventId={selectedEventId}
                    firstIndex={causeChips.offsets[index] ?? 0}
                    roving={causeRoving}
                    chipHintId={chipHintId}
                  />
                  {hypothesis.suggestedLocation === undefined ? null : (
                    // The location object is handed on by reference, never
                    // rebuilt field by field, so activation emits exactly what
                    // the analysis suggested. Formatting belongs to `SourceLink`.
                    <SourceLink
                      location={hypothesis.suggestedLocation}
                      onOpenSource={openSource}
                      showSymbol
                      compact
                      className="dg-summary-header__location"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {hasSelectableChips ? (
        // The description every selectable chip names through
        // `aria-describedby`. Last in the head and out of flow, so browse-mode
        // reading meets it after the evidence rather than between a heading and
        // its content, and it adds no gap to the head's layout.
        <Text id={chipHintId} className={VISUALLY_HIDDEN_CLASS}>
          {CHIP_KEYBOARD_HINT}
        </Text>
      ) : null}
    </header>
  );
}
