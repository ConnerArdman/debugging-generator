/*
 * Server-component specimen of the `sample-next-app` indexing corpus: read-only ts-morph input
 * for the @debuggen/code-analysis extractors, never installed, never built, never executed.
 *
 * The line that matters most here is the one that is missing: this module declares no
 * client-component directive, while the sibling widget it renders declares one as its first
 * statement. The classification in `extractors/react-components.ts` therefore has a pair that
 * differs by exactly that single statement and by nothing else. Adding a directive prologue
 * here — of any kind — deletes that coverage silently, which is why the file opens with a
 * comment rather than with a string-literal statement, and why the directive's own spelling is
 * deliberately absent from these bytes: a text scan of the corpus must not find it here.
 *
 * Node shapes this file guarantees:
 *   - one import declaration, relative and extensionless (`moduleResolution: "bundler"`), naming
 *     the sibling module *directly*. The barrel beside this file re-exports this module, so a
 *     specifier naming the directory itself, the barrel module or the widgets path alias would
 *     close a cycle the corpus must not contain;
 *   - three exports and no more: one exported interface, one exported non-component function and
 *     one default-exported function declaration whose declared name is `BasinSummary`. The barrel
 *     enumerates exactly these three edges — named, type-only and default;
 *   - one same-file call edge, because the component calls the exported helper below once;
 *   - one element of the sibling widget in the returned JSX, a single element rather than a
 *     mapped list, so the render edge counts unambiguously.
 *
 * The component stays synchronous and data-free: no hook, no event handler, no network call, no
 * hop into a helper module. Those shapes belong to other files of the corpus, whose per-function
 * caller counts are asserted as fixed numbers that a call from here would move.
 *
 * Nothing is installed on disk for this tree, so the JSX below stays untyped on purpose — that is
 * precisely what proves the extractors read the corpus AST-first, before any dependency exists.
 */

import { GaugeReadout } from './GaugeReadout';

/**
 * Props of {@link BasinSummary}.
 *
 * `basinId` is the heading fallback when no friendlier station name is known, `primaryGaugeId`
 * is the gauge whose readout the summary embeds, `gaugeCount` is the tally the helper below
 * renders, and `stationLabel` is the optional display name handed down to the embedded widget so
 * both headings agree.
 */
export interface BasinSummaryProps {
  basinId: string;
  primaryGaugeId: string;
  gaugeCount: number;
  stationLabel?: string;
}

/**
 * Singular/plural label for a basin's gauge tally, e.g. `1 gauge` or `12 gauges`.
 *
 * Pure by design: it reads its argument, returns a string, and touches nothing else — no state,
 * no I/O, no time. Negative and fractional inputs cannot arise from a gauge tally, so they are
 * reported verbatim rather than corrected, which keeps the function total for every `number`.
 *
 * @param count Number of gauges attributed to the basin.
 * @returns The tally rendered as display text.
 */
export function formatGaugeCount(count: number): string {
  return count === 1 ? '1 gauge' : `${count} gauges`;
}

/**
 * Basin summary: a station heading, the basin's gauge tally, and the readout of its primary
 * gauge. The default export of this module, and the server half of the corpus' widget pair.
 */
export default function BasinSummary(props: BasinSummaryProps) {
  return (
    <section>
      <h1>{props.stationLabel ?? props.basinId}</h1>
      <p>{formatGaugeCount(props.gaugeCount)}</p>
      <GaugeReadout gaugeId={props.primaryGaugeId} stationLabel={props.stationLabel} />
    </section>
  );
}
