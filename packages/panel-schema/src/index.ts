/**
 * `@debuggen/panel-schema` — the vocabulary a generated panel is written in.
 *
 * A panel is a document with two halves: a summary that keeps what was
 * *observed* during a capture apart from what is merely *inferred* from it, and
 * a tree of nodes that each name a prepared view of that same capture. This
 * package holds the single definition of both halves, as Zod schemas and the
 * types inferred from them, so that the process which generates a panel, the
 * process which stores it and serves its data, and the two surfaces which render
 * it cannot disagree about the shapes involved (AAP 0.2.2, AAP 0.2.3).
 *
 * ## One entry, and it is this file
 *
 * The package manifest publishes exactly one condition — `"."`, mapping to
 * `dist/index.js` with `dist/index.d.ts` beside it — and the sibling
 * `tsup.config.ts` emits both from this module alone. So this is the package's
 * only public door: a declaration that is not re-exported below is invisible to
 * `apps/local-service`, `@debuggen/protocol` and `@debuggen/panel-renderer`,
 * which depend on this package directly, to the DevTools extension, which lists
 * it in its own package manifest, and to the editor extension, which reaches it
 * through the renderer and the protocol package — however public that
 * declaration looks in the module that owns it. A second entry would be a change
 * to the `exports` map and to AAP 0.2.5, not an edit here.
 *
 * The two workspace dependencies are deliberately **not** re-exported. The
 * shapes this package borrows from them — the source-location schema from
 * `@debuggen/shared`, the telemetry kind and tier vocabularies and the fixed
 * metric ids from `@debuggen/telemetry` — keep one import path each, so a
 * consumer that needs one reaches the package that defines it rather than
 * receiving a second route to the same binding through here.
 *
 * ## What lives behind this entry
 *
 * The four modules, re-exported in dependency order, which is also this
 * package's internal layering — `summary` is the root of the module graph,
 * `nodes/query` builds on it, and the two node modules build on that:
 *
 * - `summary` — the evidence boundary, expressed as types rather than as a
 *   convention. `EventRef`; `Fact`, whose `evidence` array is bounded below by
 *   one, so a statement with nothing to cite cannot be parsed into an observed
 *   fact at all; `Hypothesis`, a `Fact` plus a required `ConfidenceLevel` and an
 *   optional `suggestedLocation`, and a distinct type so no assignment can move
 *   a guess into the observed list; and the `PanelSummary` that carries those
 *   two lists beside the one field free prose is allowed in. With them: their
 *   schemas, the exported length and cardinality bounds those schemas enforce,
 *   the confidence vocabulary with its guard and its ordering comparator, the
 *   non-throwing `parseFact` and `parseHypothesis`, and `describeIssues` — the
 *   single implementation of the rule that a validation failure is reported by
 *   its *shape* and never by the value that caused it (AAP 0.5.2).
 * - `nodes/query` — the `DataQuery` contract every query-backed node is resolved
 *   through: the ten-member source vocabulary, each member of which corresponds
 *   to exactly one prepared result shape the panel-data route serves; the sort
 *   vocabulary; the filter shape and its bounds; the paging constants a resolver
 *   applies to an omitted `limit` or `offset`, exported so both sides agree on
 *   the numbers instead of restating them; the authoritative list of flat
 *   authoring fields that a normaliser lifts into `node.query`; and the node
 *   identity, title and description primitives both node modules share, declared
 *   once here so half the node vocabulary cannot drift from the other half.
 * - `nodes/layout` — the three containers a panel may compose (`section`,
 *   `split`, `stack`): their generic interfaces, the split-direction and
 *   child-count vocabularies, and schema **factories** parameterised by the
 *   schema of a child — `sectionNodeSchema`, `splitNodeSchema`,
 *   `stackNodeSchema` and the three-at-once `layoutNodeSchemasFor`. The
 *   parameter is what keeps a recursive node union closed by the module that
 *   composes these, exactly once, rather than inside this package's node folder.
 * - `nodes/viz` — the thirteen leaves, none of which accepts children: twelve
 *   query-backed visualization node schemas with their inferred types, the
 *   `sourceLink` leaf that carries a `SourceLocation` and no query, the
 *   node-type vocabularies with their schema and guard, and
 *   `VISUALIZATION_NODE_SCHEMAS` — the ordered tuple, proved at compile time to
 *   hold one schema per node type in vocabulary order, that a node union is
 *   assembled from. No node below carries a height, a column count, a threshold
 *   or a colour: what a node may vary is which evidence it draws, and every
 *   visual value belongs to the renderer's design tokens (AAP 0.6.2).
 *
 * The re-exports are flat wildcards because the four modules share no export
 * name — each declares its own vocabulary, and the primitives two of them need
 * identically are declared once in `nodes/query` and imported, not restated. A
 * name that did collide would be resolved here, by narrowing the colliding
 * modules to explicit named re-export lists as `@debuggen/telemetry`'s barrel
 * does, rather than by renaming a symbol in the module that owns it: as the
 * modules themselves record, these names are a contract four processes share,
 * not an internal detail that may be renamed for convenience.
 *
 * Every relative specifier below carries an explicit `.js` extension, which the
 * package's `NodeNext` module resolution requires of a `"type": "module"`
 * package whose output is imported directly by a Node process; the bundler maps
 * such a specifier back to the `.ts` file on disk, so the emitted bundle is
 * unaffected.
 *
 * ## Environment-neutral, and must stay that way
 *
 * This barrel is loaded by a Node process — the coordination service validates a
 * model's panel output and resolves its data queries — and must stay loadable,
 * unchanged, in three page-side environments: the DevTools panel, the MV3
 * service worker that relays the protocol envelopes a panel specification
 * travels in, and the editor webview. Nothing reachable from here may therefore
 * import a `node:` builtin, reach for `@debuggen/shared`'s Node-only entry, or
 * touch a DOM global. Two guards keep that honest rather than aspirational: the
 * sibling build sets `platform: 'neutral'` with `removeNodeProtocol: false`, so
 * a builtin specifier has no external to fall back on and fails the build
 * instead of shipping inside this bundle, and the package's compiler project
 * omits `"DOM"` from `lib`, so a `window` or `document` reference does not
 * compile. A review of `dist/index.js` should find no `node:` specifier at all.
 *
 * Importing this module has no side effect. Every export is a declaration; the
 * vocabularies are frozen tuples and the schemas are pure values, both built
 * once at load time; and no module in the graph reads an environment variable,
 * mutates a global, starts a timer, writes to the console or performs I/O while
 * being loaded. The manifest declares `"sideEffects": false` on that basis, so a
 * bundler may drop whatever a consumer does not use.
 *
 * @example
 * ```ts
 * import {
 *   VISUALIZATION_NODE_SCHEMAS,
 *   layoutNodeSchemasFor,
 *   parseFact,
 *   type PanelSummary,
 * } from '@debuggen/panel-schema';
 * ```
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// summary — the fact/hypothesis boundary every generated panel is judged by
// ---------------------------------------------------------------------------
export * from './summary.js';

// ---------------------------------------------------------------------------
// nodes — the data-query contract, then the containers, then the leaves
// ---------------------------------------------------------------------------
export * from './nodes/query.js';
export * from './nodes/layout.js';
export * from './nodes/viz.js';
