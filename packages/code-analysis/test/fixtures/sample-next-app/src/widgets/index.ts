/*
 * The only barrel of the `sample-next-app` indexing corpus: read-only ts-morph input for the
 * @debuggen/code-analysis extractors, never installed, never built, never executed.
 *
 * Its worth is the statements below — the four re-export kinds, each present exactly once, so
 * `extractors/imports.ts` records one unambiguous specimen per kind (star, named, type-only and
 * default-as) and `extractors/symbols.ts` resolves the `@/widgets` alias through this module to
 * `GaugeReadout`, `GaugeReadoutProps`, `formatGaugeCount`, `BasinSummaryProps` and `BasinSummary`.
 * A fifth edge, a merged specifier list, a namespace re-export or any local declaration would blur
 * that one-per-kind property, so this file holds re-exports and nothing else. The type-only form is
 * what `isolatedModules: true` in this tree's tsconfig requires of a re-exported type, and the
 * specifiers stay relative and extensionless because the same tsconfig sets
 * `moduleResolution: "bundler"`.
 */

export * from './GaugeReadout';
export { formatGaugeCount } from './BasinSummary';
export type { BasinSummaryProps } from './BasinSummary';
export { default as BasinSummary } from './BasinSummary';
