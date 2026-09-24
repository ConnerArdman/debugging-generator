/**
 * The summary head of a generated panel: its title, the non-evidentiary
 * headline, the **observed** facts and the **likely causes**.
 *
 * ## What this component is, stated plainly
 *
 * It renders the head of a panel, and it is the visible form of the product's
 * central guarantee: what the capture *shows* and what the analysis *infers*
 * are kept apart, and prose can never masquerade as evidence (AAP 0.8.4).
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
 * renders is either a field of `summary` or one of the two region labels AAP
 * 0.8.4 mandates by name. It computes no statistic, drops no evidence
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
 * least one evidence reference by schema construction (AAP 0.2.3). Rendering
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
 * consumed here. Both interactions leave through plain props — `onSelectEvent` and
 * `onOpenSource` — which keeps the module graph acyclic (the host renders this
 * component, never the other way round) and lets the editor webview reuse this
 * component with no provider and no transport in scope (AAP 0.4.2, 0.7.3).
 *
 * ## Class-name contract implemented by `../styles/components.css`
 *
 * Block `dg-summary-header`; elements `__title`, `__headline`, `__region`,
 * `__region-heading`, `__facts`, `__fact`, `__statement`, `__evidence`,
 * `__chip`, `__confidence`, `__location`; variants `__region--observed` and
 * `__region--causes`.
 *
 * `__chip` marks a *selectable* evidence chip only. A citation rendered with no
 * selection handler is a plain outline `Badge` and carries no element class of
 * this block, so no rule here can give it a control's hover feedback.
 *
 * `__headline` must read as summary prose and must stay visually
 * distinguishable from `__statement`: that visual separation is the on-screen
 * half of the guarantee above, and a headline that looks like a fact is a
 * defect even when the markup is correct. The two region variants carry the
 * observed/inferred distinction in the visual register, and the region headings
 * and separate landmarks carry it for assistive technology, so the distinction
 * is never colour alone (AAP 0.6.4).
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
 *   onSelectEvent={actions.onSelectEvent}
 *   onOpenSource={actions.onOpenSource}
 * />
 * ```
 *
 * @example The same component in the editor webview, with no host in scope
 * ```tsx
 * <SummaryHeader
 *   title={analysisTitle}
 *   summary={summary}
 *   headingLevel={3}
 *   onOpenSource={(location) => { postToExtensionHost(location); }}
 * />
 * ```
 *
 * @module
 */

import { useId } from 'react';
import type { ReactElement } from 'react';
import clsx from 'clsx';

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
import type { BadgeTone } from '../primitives/Badge';
import { Button } from '../primitives/Button';
import { Heading } from '../primitives/Heading';
import type { HeadingLevel } from '../primitives/Heading';
import { Text } from '../primitives/Text';

/**
 * The label of the region that lists what the capture shows.
 *
 * One of exactly two user-facing strings this module owns. Both are product
 * copy the specification fixes by name — AAP 0.8.4 requires that likely causes
 * are "rendered under a separate 'Likely cause' heading by `SummaryHeader`",
 * and AAP 0.7.3 names the observed region "**Observed**" — so they are declared
 * here as constants rather than written twice, and no other caption or hint is
 * invented anywhere in this file.
 */
const OBSERVED_LABEL = 'Observed';

/** The label of the region that lists what the analysis infers (AAP 0.8.4). */
const LIKELY_CAUSE_LABEL = 'Likely cause';

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
 * text, so the ranking is never carried by colour alone (AAP 0.6.3, 0.6.4).
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

/** Props of {@link EvidenceChips}. */
interface EvidenceChipsProps {
  /**
   * The citations to render, in the order they were supplied. Never filtered,
   * never deduplicated and never sorted: the evidence list is part of the
   * validated analysis.
   */
  evidence: readonly EventRef[];

  /**
   * Invoked with the whole {@link EventRef} when a chip is activated. Absent,
   * every citation renders as inert text instead of a control — see
   * {@link EvidenceChips} for why.
   */
  onSelectEvent?: ((ref: EventRef) => void) | undefined;
}

/**
 * The evidence chips of one fact or hypothesis.
 *
 * A real list, so assistive technology announces how many citations a statement
 * carries. What each item holds depends on whether anything can act on it:
 *
 * - **With a selection handler**, one `Button` per chip: the design system
 *   requires its own control primitive in place of a raw element (AAP 0.6.4),
 *   and a `span` with a click handler would lose keyboard operation and the
 *   focus ring that `../styles/base.css` applies to every `:focus-visible`
 *   element.
 * - **Without one**, one outline `Badge` per citation: the caption is still
 *   information — which event substantiates the statement — so it is still
 *   rendered, and still carries `data-event-id`, but as a citation rather than
 *   a control. It is not focusable, has no button role and takes neither the
 *   chip's hover feedback nor its pointer, because a control whose activation
 *   does nothing tells a keyboard or screen-reader user that something happened
 *   when nothing did. `disabled` would be the wrong fix too: a disabled control
 *   is dimmed and announced as unavailable, which misreports a citation that
 *   was never meant to be operable in that surface (the editor webview renders
 *   this head with no event selection at all). The outline variant keeps it
 *   visually apart from the soft confidence badge beside it.
 *
 * `../components/SourceLink.tsx` is the only sibling rendered by this module's
 * exported component, and this internal one renders nothing but primitives.
 *
 * @param props See {@link EvidenceChipsProps}.
 * @returns The chip list.
 */
function EvidenceChips(props: EvidenceChipsProps): ReactElement {
  const { evidence, onSelectEvent } = props;

  return (
    <ul className="dg-summary-header__evidence">
      {evidence.map((ref, index) => (
        // `eventId` is not guaranteed unique inside one evidence list — a fact
        // may legitimately cite the same event twice through two coordinates —
        // so the index joins the key rather than standing in for it.
        <li key={`${ref.eventId}#${String(index)}`}>
          {onSelectEvent === undefined ? (
            <Badge tone="accent" variant="outline" data-event-id={ref.eventId}>
              {evidenceChipLabel(ref)}
            </Badge>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="dg-summary-header__chip"
              data-event-id={ref.eventId}
              onClick={() => {
                // The whole reference travels, not just its id: the caller
                // reads `ref.eventId`, and the optional trace, span and kind
                // coordinates are what let it select without a lookup.
                onSelectEvent(ref);
              }}
            >
              {evidenceChipLabel(ref)}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Props of {@link SummaryHeader}.
 *
 * Every optional property spells `| undefined`: `exactOptionalPropertyTypes` is
 * in force repository-wide, so a caller forwarding a value it may not have —
 * `onOpenSource={actions.onOpenSource}` — must remain legal.
 */
export interface SummaryHeaderProps {
  /** The panel's title. Rendered verbatim as the head's heading. */
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
   * The outline depth of the title. Defaults to `2`, and both region headings
   * render one level deeper, clamped at `6`.
   */
  headingLevel?: HeadingLevel | undefined;

  /**
   * Called with the whole {@link EventRef} when an evidence chip is activated.
   * Omitted, every citation still renders, as inert text rather than as a
   * control, so no focusable element does nothing when activated.
   */
  onSelectEvent?: ((ref: EventRef) => void) | undefined;

  /**
   * Called with the exact {@link SourceLocation} a hypothesis suggested when
   * its source chip is activated. Passed explicitly to `SourceLink` rather
   * than left to that component's host fallback, so this head works unchanged
   * in a surface with no panel actions in scope.
   */
  onOpenSource?: ((location: SourceLocation) => void) | undefined;

  /**
   * Render the likely causes most-confident-first instead of in the order the
   * analysis supplied. Defaults to `false`.
   */
  sortByConfidence?: boolean | undefined;

  /** Extra class names, appended after the block's own. */
  className?: string | undefined;

  /** The `id` of the rendered `header` element. */
  id?: string | undefined;
}

/**
 * Renders a panel's title, its non-evidentiary headline, its observed facts and
 * its likely causes.
 *
 * Neither region is rendered when its list is empty: a labelled region with no
 * items announces a heading that introduces nothing, and an empty state is the
 * business of the visualization tier rather than of the head. A summary with
 * neither facts nor causes — the shape a deterministic fallback panel can take
 * — therefore renders as a title and, if one was authored, a headline.
 *
 * @param props See {@link SummaryHeaderProps}.
 * @returns The panel head.
 */
export function SummaryHeader(props: SummaryHeaderProps): ReactElement {
  const {
    title,
    summary,
    headingLevel = DEFAULT_HEADING_LEVEL,
    onSelectEvent,
    onOpenSource,
    sortByConfidence = false,
    className,
    id,
  } = props;

  // One generated prefix for the three ids this head needs. `useId` rather than
  // a counter or the caller's `id`: two panels can be on one page — the editor
  // webview mirrors the DevTools panel — and a collision would point a region's
  // `aria-labelledby` at another panel's heading.
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
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

  return (
    <header className={clsx('dg-summary-header', className)} id={id}>
      <Heading level={headingLevel} id={titleId} className="dg-summary-header__title">
        {title}
      </Heading>

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

      {facts.length > 0 ? (
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
          <ul className="dg-summary-header__facts">
            {facts.map((fact, index) => (
              <li key={`${fact.statement}#${String(index)}`} className="dg-summary-header__fact">
                {/* Verbatim: no truncation, no re-casing, no added punctuation.
                    The statement was redacted upstream, and this component
                    neither redacts nor logs it. */}
                <Text as="p" className="dg-summary-header__statement">
                  {fact.statement}
                </Text>
                {/* `Fact.evidence` holds at least one reference by schema
                    construction, so there is no empty-evidence branch to write
                    and no reference to filter. */}
                <EvidenceChips evidence={fact.evidence} onSelectEvent={onSelectEvent} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {causes.length > 0 ? (
        // A second, sibling region with its own heading and its own
        // `aria-labelledby` — never a subsection of the observed region and
        // never a continuation of its list. Two separately labelled regions are
        // what make the observed/inferred separation audible as well as visible
        // (AAP 0.8.4).
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
          <ul className="dg-summary-header__facts">
            {causes.map((hypothesis, index) => (
              <li
                key={`${hypothesis.statement}#${String(index)}`}
                className="dg-summary-header__fact"
              >
                <Badge
                  tone={CONFIDENCE_TONE[hypothesis.confidence]}
                  className="dg-summary-header__confidence"
                >
                  {hypothesis.confidence}
                </Badge>
                <Text as="p" className="dg-summary-header__statement">
                  {hypothesis.statement}
                </Text>
                <EvidenceChips evidence={hypothesis.evidence} onSelectEvent={onSelectEvent} />
                {hypothesis.suggestedLocation === undefined ? null : (
                  // The location object is handed on by reference, never
                  // rebuilt field by field, so activation emits exactly what
                  // the analysis suggested. Formatting belongs to `SourceLink`.
                  <SourceLink
                    location={hypothesis.suggestedLocation}
                    onOpenSource={onOpenSource}
                    showSymbol
                    compact
                    className="dg-summary-header__location"
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </header>
  );
}
