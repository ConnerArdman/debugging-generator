/**
 * The editor's view of the latest analysis: what the capture **showed** and
 * what the analysis **infers** from it, mirroring the head of the generated
 * DevTools panel (AAP 0.7.3).
 *
 * ## Why this component owns almost no markup
 *
 * Keeping observed facts structurally apart from likely causes is a product
 * guarantee, not a styling choice (AAP 0.8.4): every fact cites evidence that
 * exists in the capture, and every inference sits under its own "Likely cause"
 * heading with a confidence level. The design system already encodes that
 * guarantee once, in `SummaryHeader` — its separately labelled regions, its
 * confidence-tone map, its evidence chips and its source chips — so this
 * component renders that head and nothing that could compete with it. It never
 * re-implements the Observed / Likely-cause markup, never derives, filters,
 * re-words or truncates a finding, and never adds a headline: an
 * `AnalysisResult` carries none, and prose written here would be a
 * non-evidentiary claim sitting where a reader looks for evidence.
 *
 * `AnalysisResult.observed` and `.likelyCauses` are the very `Fact[]` and
 * `Hypothesis[]` a panel summary holds — `@debuggen/protocol` composes the
 * panel schema's own element schemas and asserts the edge at compile time —
 * so both registers are handed to `SummaryHeader` in their own order and
 * shape, with no cast and no dependency on `@debuggen/panel-schema`, which this
 * workspace may not import (AAP 0.2.2).
 *
 * ## Line breaks in long statements
 *
 * A statement can quote a whole SQL statement shape, whose column list is one
 * run of 80 characters or more with no space in it. The line breaker offers no
 * break opportunity after `,`, `.` or `)` or before `(` when a letter or a
 * quote is adjacent, so in a narrow sidebar such a run broke mid-identifier
 * (`mo|vement_type`) under the head's `overflow-wrap`. The one display change
 * this component makes is therefore invisible: inside a whitespace-free run of
 * {@link LONG_RUN_MIN_LENGTH} characters or more, a U+200B ZERO WIDTH SPACE is
 * inserted after each `,`, `.` and `)` and before each `(`, never at either end
 * of the run and never in front of closing punctuation, so the run wraps
 * between identifiers. Nothing else changes: a finding whose statement gains no
 * break opportunity is handed on by reference, a changed one is a shallow copy
 * with only `statement` replaced, and its evidence, confidence and suggested
 * location are the analysis's own objects. The analysis itself is never
 * mutated. Copying from the head removes the inserted characters again (see
 * {@link stripBreakOpportunitiesOnCopy}), so a copied statement is the
 * statement the analysis carries.
 *
 * The analysis's generation travels the same way: `analysisVersion`, and
 * whether it `supersedes` an earlier analysis, become the head's `version`, so
 * a follow-up's answer carries the same "Version n · Updates version n-1"
 * indicator beside its title as the DevTools panel's head (AAP 0.4.2), drawn by
 * `SummaryHeader` rather than by markup of this component's own.
 *
 * ## The four states, in precedence order
 *
 * | Condition                 | Rendered as |
 * | ------------------------- | ----------- |
 * | `error` holds text        | `ErrorState` (`role="alert"`) with the message verbatim and, when `onRetry` is supplied, its retry action |
 * | `pending`                 | `LoadingState` (`role="status"`, `aria-busy`) |
 * | no `analysis`             | `EmptyState` with this component's own generic copy |
 * | otherwise                 | the fallback banner when `fallback` is set, then `SummaryHeader` |
 *
 * A failure is therefore never presented as a successful analysis (AAP 0.5.5):
 * an error string never becomes an entry of the Observed region, and an error
 * outranks a stale analysis that may still be in state.
 *
 * ## Both registers always answer
 *
 * The head is the editor's only account of an analysis — the views that carry
 * the evidence live in the DevTools panel — so both of its regions are always
 * rendered here. `SummaryHeader` states an empty Observed register on its own;
 * this component also passes `showEmptyCauses`, so an analysis that infers no
 * cause keeps its "Likely cause" heading over `SummaryHeader`'s own muted
 * sentence saying none was identified, instead of a head that reads as though
 * its inference never arrived. The sentence is the design system's, not this
 * file's, and it is never a list item, a confidence badge or a citation.
 *
 * ## The fallback banner
 *
 * When the service could not validate the generated panel it assembles a
 * deterministic one from the capture and marks it `meta.fallback` (AAP 0.5.3);
 * both surfaces must say so. The banner states AAP 0.5.5's sentence verbatim
 * beside a warning `Badge` whose text names the state, so the notice is
 * perceivable without colour. It sits above the head and outside both of its
 * regions: it is product copy about provenance, never a fact.
 *
 * ## What this component deliberately does not do
 *
 * - **No evidence selection.** `SummaryHeader`'s `selectEvent` is omitted: the
 *   editor holds no event store, so a citation renders as an inert chip rather
 *   than as a control whose activation would do nothing.
 * - **No metrics.** `analysis.metrics` feeds the panel's `metricCards` node
 *   through the panel-data pipeline; restating a subset here would invite
 *   rounding or relabelling that changes what a measurement means, and the
 *   head is the required content.
 * - **No transport, no logging.** Data arrives through props and interactions
 *   leave through `onOpenSource`/`onRetry` only. Findings are already redacted
 *   upstream (AAP 0.5.2); they are rendered, never re-redacted and never logged.
 *
 * ## Styling
 *
 * Two classes of `../styles.css`, both resolved against `--dg-*` tokens: the
 * `dgv-analysis` column and the `dgv-analysis__fallback` banner. The head's
 * markup stays `SummaryHeader`'s. Its look inside this view is adjusted by that
 * stylesheet's "Webview surface refinements" section, scoped under
 * `.dgv-analysis`: the "Observed" and "Likely cause" headings take the large
 * text role above the facts, the confidence badge is graded (high a solid
 * accent, medium a tinted info chip, low a muted outline), and the inert
 * evidence chips are drawn as neutral tags rather than the accent outline the
 * DevTools panel gives its selectable chips.
 *
 * @example Wired from `App.tsx`, which owns the state and the host bridge
 * ```tsx
 * <AnalysisSummary
 *   analysis={latestAnalysis}
 *   fallback={panelIsFallback}
 *   pending={analysisPending}
 *   onOpenSource={openSourceInEditor}
 * />
 * ```
 *
 * @module
 */

import type { ClipboardEvent, ReactElement } from 'react';

import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  SummaryHeader,
  Text,
} from '@debuggen/panel-renderer';
import type { HeadingLevel, SummaryHeaderProps } from '@debuggen/panel-renderer';
import type { AnalysisResult, SourceLocation } from '@debuggen/protocol';

/**
 * The heading the summary head carries when the caller names none.
 *
 * A neutral, component-owned word: it names the register, never a finding and
 * never anything read out of an inspected project (AAP 0.5.4).
 */
const DEFAULT_TITLE = 'Analysis';

/**
 * The outline depth of the head's title.
 *
 * `App.tsx` places this component inside a `Section`, whose own title renders
 * at that primitive's default level `2`; the head's title therefore sits one
 * level below it, and `SummaryHeader` puts its "Observed" and "Likely cause"
 * region headings one level deeper again — so the outline never skips or
 * repeats a level.
 */
const HEAD_HEADING_LEVEL: HeadingLevel = 3;

/**
 * The first line the error state renders, above the service's own message.
 *
 * About the view, not the cause: the cause is the `error` text the caller
 * supplies, and a title that guessed at one would be wrong most of the time.
 */
const ERROR_TITLE = 'Analysis unavailable';

/** What the loading state announces to assistive technology while it waits. */
const LOADING_LABEL = 'Loading analysis…';

/**
 * What the empty state says before any analysis exists.
 *
 * `EmptyState` ships no default copy by design, so the wording is owned here:
 * generic product vocabulary that tells the developer what produces an
 * analysis, naming no component, route or file of an inspected project.
 */
const EMPTY_MESSAGE = 'No analysis yet. Capture an interaction to generate one.';

/** The text of the fallback banner's badge: the state, named in words. */
const FALLBACK_BADGE_LABEL = 'Fallback view';

/**
 * The developer-facing wording of AAP 0.5.5, verbatim — the same sentence the
 * DevTools panel's own fallback banner states, so the two surfaces agree.
 *
 * It makes no claim about the capture, which is what keeps it out of the
 * Observed region: it describes where the panel came from, not what happened.
 */
const FALLBACK_MESSAGE =
  'Generated panel failed validation; showing a fallback view built from captured data.';

/** The block class of this component's root, from `../styles.css`. */
const ROOT_CLASS = 'dgv-analysis';

/** The element class of the fallback banner, from `../styles.css`. */
const FALLBACK_CLASS = 'dgv-analysis__fallback';

/**
 * The invisible line-break opportunity inserted into a statement's display
 * copy: U+200B ZERO WIDTH SPACE. It has no width and no glyph, and assistive
 * technology does not announce it.
 */
const BREAK_OPPORTUNITY = '\u200B';

/**
 * The shortest whitespace-free run that receives break opportunities.
 *
 * Twenty characters of the 13 px fact role span roughly two thirds of the fact
 * column in a 300 px sidebar, so a shorter run always fits on a line of its
 * own and prose — "e.g.", "1,535.1", "f(x)" — is left exactly as written.
 */
const LONG_RUN_MIN_LENGTH = 20;

/** A whitespace-free run of at least {@link LONG_RUN_MIN_LENGTH} characters. */
const LONG_RUN = new RegExp(`\\S{${String(LONG_RUN_MIN_LENGTH)},}`, 'gu');

/**
 * The positions inside one run where a break opportunity is inserted, matched
 * as zero-width positions:
 *
 * - after `,`, `.` or `)`, unless the run ends there or closing punctuation
 *   follows — a line never starts with `.`, `,`, `;`, `:`, `!`, `?`, `)`, `]`,
 *   `}` or `…`;
 * - before `(`, unless the run starts there or another `(` precedes it.
 *
 * A position that qualifies both ways (`)(`) is matched once.
 */
const RUN_BREAK_POINT = /(?<=[,.)])(?=[^.,;:!?)\]}…])|(?<=[^(])(?=\()/gu;

/**
 * A statement's display copy, with break opportunities inside its long runs.
 *
 * @param statement The statement as the analysis carries it.
 * @returns The same characters, with {@link BREAK_OPPORTUNITY} inserted at
 *   every {@link RUN_BREAK_POINT} of every {@link LONG_RUN}; the input itself
 *   when it has no such run.
 */
function withBreakOpportunities(statement: string): string {
  return statement.replace(LONG_RUN, (run) => run.replace(RUN_BREAK_POINT, BREAK_OPPORTUNITY));
}

/**
 * The display form of one fact or hypothesis.
 *
 * @param finding A finding of the analysis.
 * @returns The finding itself when its statement gains no break opportunity;
 *   otherwise a shallow copy whose `statement` is the display copy and whose
 *   every other member — evidence, confidence, suggested location — is the
 *   original's.
 */
function displayFinding<Finding extends { readonly statement: string }>(finding: Finding): Finding {
  const statement = withBreakOpportunities(finding.statement);
  return statement === finding.statement ? finding : { ...finding, statement };
}

/**
 * Copies a selection from the head without the inserted break opportunities.
 *
 * Only a selection that contains {@link BREAK_OPPORTUNITY} is rewritten, and
 * then as plain text; any other copy keeps the browser's default behaviour.
 * Nothing is logged, and the clipboard receives exactly the selected text less
 * those characters.
 *
 * @param event The copy event raised inside the analysis root.
 */
function stripBreakOpportunitiesOnCopy(event: ClipboardEvent<HTMLDivElement>): void {
  const selection = event.currentTarget.ownerDocument.getSelection();
  if (selection === null) {
    return;
  }
  const selected = selection.toString();
  if (!selected.includes(BREAK_OPPORTUNITY)) {
    return;
  }
  event.clipboardData.setData('text/plain', selected.replaceAll(BREAK_OPPORTUNITY, ''));
  event.preventDefault();
}

/**
 * Props of {@link AnalysisSummary}.
 *
 * Every optional property spells `| undefined`: `exactOptionalPropertyTypes` is
 * in force repository-wide, and `App.tsx` forwards values it may not have —
 * `analysis={state.analysis}` before the first capture — which must stay legal.
 */
export interface AnalysisSummaryProps {
  /**
   * The latest validated analysis of the session, exactly as the service
   * broadcast it (`analysis.completed`) or stored it (`SessionRecord.analyses`).
   * Authoritative: nothing in it is recomputed, reordered or reworded here.
   * Absent until an analysis exists, which renders the empty state.
   */
  analysis?: AnalysisResult | undefined;

  /**
   * The head's heading. Defaults to a neutral "Analysis"; a blank string falls
   * back to the same default so the heading always has an accessible name.
   */
  title?: string | undefined;

  /**
   * Whether the panel generated from this analysis is the service's
   * deterministic fallback (`PanelSpec.meta.fallback`). When `true`, the
   * fallback banner is rendered above the head.
   */
  fallback?: boolean | undefined;

  /**
   * Called with the exact `SourceLocation` a hypothesis suggested when its
   * source chip is activated — the host's open-location path
   * (`source.open` → `showTextDocument`). Omitted, the chip still shows where
   * the analysis points.
   */
  onOpenSource?: ((location: SourceLocation) => void) | undefined;

  /** Whether an analysis is being produced; renders the loading state. */
  pending?: boolean | undefined;

  /**
   * Why the analysis could not be produced or shown. Any text renders the
   * error state, which outranks every other state; a blank string is treated
   * as no error.
   */
  error?: string | undefined;

  /** Offered as the error state's retry action when supplied. */
  onRetry?: (() => void) | undefined;

  /** Extra class names, appended after `dgv-analysis`. */
  className?: string | undefined;
}

/**
 * Whether a value is a string with something visible in it.
 *
 * Props cross the host↔webview message boundary, so a present but blank string
 * is possible; rendering it would produce an error with no message or a
 * heading with no accessible name.
 *
 * @param value A possibly absent string.
 * @returns `true` when the value can be rendered as visible text.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * The root's class list: the block class, then the caller's.
 *
 * Composed by hand because `clsx` is not a dependency of this workspace; a
 * blank caller value adds nothing rather than a stray space.
 *
 * @param className The caller's extra class names, possibly absent.
 * @returns The class attribute value.
 */
function rootClassName(className: string | undefined): string {
  return hasText(className) ? `${ROOT_CLASS} ${className.trim()}` : ROOT_CLASS;
}

/**
 * The fallback banner.
 *
 * `role="status"` with `aria-live="polite"`, the pairing the panel's own
 * fallback notice uses: the notice is advisory — the summary beneath it is
 * still worth reading — and a regenerated analysis whose panel arrives as a
 * fallback is a change a reader needs told without losing their place. Not
 * `role="alert"`: this is not a failure, it is a panel of a different
 * provenance. The badge names the state in words and the sentence explains it,
 * so neither colour nor the badge's tone carries the meaning alone.
 *
 * @returns The banner element.
 */
function FallbackBanner(): ReactElement {
  return (
    <div className={FALLBACK_CLASS} role="status" aria-live="polite">
      <Badge tone="warning">{FALLBACK_BADGE_LABEL}</Badge>
      <Text as="p" size="sm">
        {FALLBACK_MESSAGE}
      </Text>
    </div>
  );
}

/**
 * Renders the latest analysis — or the state that stands in for it — as the
 * editor's mirror of the DevTools panel head.
 *
 * @param props See {@link AnalysisSummaryProps}.
 * @returns The analysis summary.
 */
export function AnalysisSummary(props: AnalysisSummaryProps): ReactElement {
  const {
    analysis,
    title,
    fallback = false,
    onOpenSource,
    pending = false,
    error,
    onRetry,
  } = props;
  const className = rootClassName(props.className);

  // Precedence: error > pending > empty > data (AAP 0.5.5). The error comes
  // first so a stale analysis still in state can never be read as the answer
  // to a run that failed.
  if (hasText(error)) {
    return (
      <div className={className}>
        <ErrorState title={ERROR_TITLE} message={error} onRetry={onRetry} />
      </div>
    );
  }

  if (pending) {
    return (
      <div className={className}>
        <LoadingState variant="block" label={LOADING_LABEL} />
      </div>
    );
  }

  if (analysis === undefined) {
    return (
      <div className={className}>
        <EmptyState message={EMPTY_MESSAGE} />
      </div>
    );
  }

  // The two registers, together and in the validated analysis's own order —
  // no headline, because an analysis has none and prose invented here would
  // sit where a reader expects evidence. Each finding is its display form:
  // itself, or a copy whose statement carries break opportunities.
  const summary: SummaryHeaderProps['summary'] = {
    observed: analysis.observed.map(displayFinding),
    likelyCauses: analysis.likelyCauses.map(displayFinding),
  };

  return (
    <div className={className} onCopy={stripBreakOpportunitiesOnCopy}>
      {fallback ? <FallbackBanner /> : null}
      <SummaryHeader
        title={hasText(title) ? title : DEFAULT_TITLE}
        summary={summary}
        version={{
          current: analysis.analysisVersion,
          supersedes: analysis.supersedes !== undefined,
        }}
        headingLevel={HEAD_HEADING_LEVEL}
        openSource={onOpenSource}
        showEmptyCauses
      />
    </div>
  );
}
