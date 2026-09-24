/**
 * Colour, severity and contrast — the single home of every colour *decision*
 * in `@debuggen/panel-renderer` (AAP 0.6.2, 0.6.3).
 *
 * A generated panel colours four different vocabularies: the kind of a
 * telemetry event, the tier a lane belongs to, the participant class of a
 * dependency-graph node, and how slow a duration is. Each of those folds a
 * vocabulary owned by `@debuggen/telemetry` onto the token scale owned by
 * `../tokens/tokens`, and each fold is a design decision rather than a
 * mechanical rename. They are taken here, once: a component asks this module
 * which token to use and never decides for itself, so two visualizations of the
 * same capture can never disagree about what colour a database span is.
 *
 * This module also owns the WCAG contrast arithmetic, because
 * `src/tokens/tokens.test.ts` has to measure every text/surface and
 * status/surface pair of all three themes against the minima AAP 0.6.3 fixes,
 * and `scripts/build-tokens.mjs` — which generates the stylesheet from the same
 * token table — deliberately performs no colour maths at all. Putting the maths
 * beside the mapping keeps one implementation of the formula in the package.
 *
 * ## What this module returns, and what it never returns
 *
 * Every visual answer is either a {@link TokenKey} or a `var(--dg-*)` reference
 * produced through `cssVar`. AAP 0.6.4 permits no hardcoded CSS value anywhere
 * in this package, so no export here yields a hex colour, an `rgb()` string or
 * a length: a caller that wants a value asks the stylesheet for it through the
 * custom property, which is what makes theme switching work at all. The hex
 * strings the contrast helpers parse travel *in*, from the token table the
 * caller already holds; they are never stored here.
 *
 * Text is not this module's business either. A readable label for a kind or a
 * status belongs to `./format`, and a timeline lane's label is already carried
 * by the lane data the aggregates produce, so neither is restated here — the
 * concern is split by *kind of answer* (colour here, text there), which is what
 * keeps a legend and a table from drifting apart.
 *
 * ## Layering
 *
 * - The `utils → tokens` edge is one-way and structural. The stylesheet
 *   generator loads `../tokens/tokens` through the runtime's built-in type
 *   stripping, so that module carries no relative runtime import and can never
 *   import this one. This module imports it; only `../tokens/tokens.test.ts`
 *   imports back.
 * - `@debuggen/telemetry` is a **type-only** dependency (AAP 0.2.2). Nothing
 *   here imports a telemetry runtime value: exhaustiveness comes from typing
 *   each table as a `Record` over the closed union, so a vocabulary that gains
 *   a member upstream fails to compile here until the new member has been given
 *   a colour — which is the intended way to find this file.
 * - No sibling edge: this module imports nothing from `./format` or `./scale`.
 * - `./utils` is package-internal; `src/index.ts` does not re-export it.
 *
 * Every export is a pure function or a frozen table. Importing this module
 * reads nothing, writes nothing and touches no global.
 *
 * ## Consumers
 *
 * `../components/Timeline.tsx`, `Waterfall.tsx`, `FlameChart.tsx`,
 * `EventLog.tsx`, `SpanTable.tsx`, `RenderTable.tsx`, `ComponentTree.tsx`,
 * `RequestTable.tsx`, `QueryTable.tsx`, `StateTransitionViewer.tsx`,
 * `DependencyGraph.tsx`, `../primitives/DurationCell.tsx` and
 * `../tokens/tokens.test.ts` (the contrast helpers).
 */

import { clampNonNegative } from '@debuggen/shared';
import type {
  DependencyGraphNode,
  RenderTrigger,
  TelemetryKind,
  TelemetryStatus,
  TelemetryTier,
} from '@debuggen/telemetry';

import { cssVar, type TokenKey } from '../tokens/tokens';

/**
 * The token every defensive lookup falls back to for a value that is not in
 * the vocabulary this build was compiled against.
 *
 * Telemetry crosses three process boundaries and is read back from a store that
 * an older build may have written with a newer producer, so a kind, tier,
 * participant class, trigger or status can legitimately arrive that none of the
 * tables below has an entry for. Such a value is drawn in the muted text
 * colour: deliberately *outside* the span-kind scale, so an unclassified item
 * cannot be mistaken for a classified family, and deliberately not the error
 * colour, which would present "this build does not know what that is" as "that
 * failed". The item still renders — a panel that dropped it would be hiding
 * evidence — and its own kind string stays visible in its label.
 */
export const UNCLASSIFIED_TOKEN_KEY: TokenKey = 'textMuted';

/*
 * ---------------------------------------------------------------------------
 * Telemetry kind → span-kind token
 *
 * AAP 0.6.3 defines seven span-kind tokens, and `../tokens/tokens` adds two
 * supplementary members of the same scale — `kindService` and
 * `kindExternal` — so that each of the dependency graph's six participant
 * classes owns a colour its spans also carry. The telemetry vocabulary has
 * seventeen kinds, so the nine tokens are still a fold rather than a
 * bijection. They are read as semantic *families* — what the operation is,
 * not which producer reported it — and the fold below is the decision about
 * which family each kind belongs to.
 * ---------------------------------------------------------------------------
 */

/**
 * The span-kind token each telemetry kind is drawn in.
 *
 * One table, consumed by every visualization that colours a span: the
 * timeline's bars, the flame view's blocks, the waterfall's rows, the event
 * log's kind chips and the span table's kind column (AAP 0.6.2). The key type
 * is the closed kind union, so the table is total by construction and a kind
 * added upstream is a compile error here rather than a silently uncoloured bar.
 *
 * The families, and why each kind sits where it does:
 *
 * - `kindInteraction` — `interaction`, the user's own action. It is the root of
 *   a correlated trace and the only kind in its family, because a reader looks
 *   for "where did this start" as a single colour.
 * - `kindRender` — `render`, `commit` and `state`. The React family: a commit
 *   contains the renders it committed, and a hook transition is what caused
 *   one. Colouring a transition with the renders it explains is what lets the
 *   render panel be read as one story instead of two vocabularies.
 * - `kindFetch` — `fetch`, `xhr`, `navigation` and `perf.entry`. Transfers the
 *   *page* initiated: the two request kinds, the document's own navigation, and
 *   the performance-timeline entries, which are dominated by resource timings
 *   and are the only place a transferred size is observable at all
 *   (AAP 0.6.6). Kept apart from the server-side HTTP family below, because the
 *   client end and the server end of one request are the two rows a reader
 *   compares to see where the time went.
 * - `kindHttp` — `http.server`, the request the server answered: the incoming
 *   boundary, not the work behind it.
 * - `kindService` — `route.handler`, the server's own work behind that
 *   boundary. Kept apart from both the boundary and named application code, so
 *   a server lane reads "boundary → handler → code → datastore" instead of one
 *   undifferentiated block, and so the graph's `service` participants — which
 *   are route handlers — are drawn in the colour their spans have here.
 * - `kindFunction` — `function`, `log` and `perf.longtask`. Application code
 *   executing: a patched named function, a log record naming the code that
 *   emitted it, and a long task, which is script execution blocking the main
 *   thread.
 * - `kindExternal` — `http.client`, a request the server made onwards to
 *   another system. Its own family rather than the incoming boundary's, because
 *   "the server was asked" and "the server asked someone else" are the two ends
 *   a reader separates when a server span is slow, and because it is what the
 *   graph's `external` participants collapse.
 * - `kindDb` — `db.query`, the datastore's own family.
 * - `kindError` — `error` and `server.error`, the two kinds whose *subject* is
 *   a failure, from either tier. An operation of another kind that failed keeps
 *   its family's colour and carries its error status separately
 *   ({@link STATUS_TOKEN_KEYS}), so the scale never has to choose between
 *   telling a reader what something was and telling them it failed.
 *
 * Frozen: a read-only lookup table.
 */
export const KIND_TOKEN_KEYS: Readonly<Record<TelemetryKind, TokenKey>> = Object.freeze({
  interaction: 'kindInteraction',
  render: 'kindRender',
  commit: 'kindRender',
  fetch: 'kindFetch',
  xhr: 'kindFetch',
  navigation: 'kindFetch',
  'perf.longtask': 'kindFunction',
  'perf.entry': 'kindFetch',
  error: 'kindError',
  state: 'kindRender',
  'http.server': 'kindHttp',
  'route.handler': 'kindService',
  function: 'kindFunction',
  'db.query': 'kindDb',
  'http.client': 'kindExternal',
  'server.error': 'kindError',
  log: 'kindFunction',
});

/**
 * The token `kind` is drawn in.
 *
 * {@link KIND_TOKEN_KEYS} is total over the kind union, so the lookup is exact
 * for any value the compiler accepted. The fallback exists for the other
 * case — an event read from the wire or the session store whose kind this build
 * does not know — and is {@link UNCLASSIFIED_TOKEN_KEY}. It never throws: a
 * panel must still render every row it was given.
 */
export function kindTokenKey(kind: TelemetryKind): TokenKey {
  const token: TokenKey | undefined = KIND_TOKEN_KEYS[kind];
  return token ?? UNCLASSIFIED_TOKEN_KEY;
}

/**
 * The same answer as {@link kindTokenKey} as a CSS value reference, for an
 * inline `fill`, `stroke` or `background-color` computed in TypeScript.
 *
 * The convenience matters for the SVG views — a timeline bar, a flame block, a
 * waterfall segment — which style per element rather than per class, and it is
 * the reason none of them ever writes a colour of its own (AAP 0.6.4).
 */
export function kindColorVar(kind: TelemetryKind): string {
  return cssVar(kindTokenKey(kind));
}

/**
 * The label ink for text drawn *on* each fill {@link kindTokenKey} can return.
 *
 * A span-kind fill is held to the 3:1 non-text bar, but a label printed on it
 * is text and needs 4.5:1 (AAP 0.6.3). No one ink reaches that on every fill:
 * the light scale has fills that need a light ink and one — fetch — that needs
 * a dark one. So each fill is paired with its own `…Ink` token, whose value
 * `../tokens/tokens` chooses per theme by contrast, and a view that labels a
 * fill asks for the fill's ink rather than writing a colour of its own.
 *
 * The unclassified fill ({@link UNCLASSIFIED_TOKEN_KEY}, the muted text colour)
 * takes the base surface, which clears 4.5:1 on it in every theme. The token
 * test measures every pair in this table in all three themes.
 *
 * Partial over the key union only because most tokens are not fills; every fill
 * the kind table can produce has an entry, which the token test asserts.
 * Frozen: a read-only lookup table.
 */
export const KIND_FILL_INK_TOKEN_KEYS: Readonly<Partial<Record<TokenKey, TokenKey>>> =
  Object.freeze({
    kindInteraction: 'kindInteractionInk',
    kindRender: 'kindRenderInk',
    kindFetch: 'kindFetchInk',
    kindHttp: 'kindHttpInk',
    kindFunction: 'kindFunctionInk',
    kindDb: 'kindDbInk',
    kindError: 'kindErrorInk',
    kindService: 'kindServiceInk',
    kindExternal: 'kindExternalInk',
    textMuted: 'surfaceBase',
  });

/**
 * The ink a label drawn on `kind`'s fill is written in — the pair of
 * {@link kindTokenKey} for text. Falls back to the base surface for a fill the
 * table does not list, which is the ink every fill used before the pairing.
 * Never throws, for the reason given on {@link kindTokenKey}.
 */
export function kindInkTokenKey(kind: TelemetryKind): TokenKey {
  return KIND_FILL_INK_TOKEN_KEYS[kindTokenKey(kind)] ?? 'surfaceBase';
}

/**
 * {@link kindInkTokenKey} as a CSS value reference, for the inline label ink of
 * an SVG block whose fill is {@link kindColorVar}.
 */
export function kindInkColorVar(kind: TelemetryKind): string {
  return cssVar(kindInkTokenKey(kind));
}

/*
 * ---------------------------------------------------------------------------
 * Tier → lane token
 *
 * The timeline draws one lane per tier (AAP 0.6.2). A lane's *label* is not
 * decided here: the aggregate that builds the view already carries it on the
 * lane, from the one table that owns tier names in `@debuggen/telemetry`. This
 * module supplies the lane's accent token and nothing else, so there is exactly
 * one spelling of "Browser" in the product and it is data, not a duplicate
 * constant in the renderer.
 * ---------------------------------------------------------------------------
 */

/**
 * The accent token each tier's lane is drawn with: its header rule, its
 * occupancy bar and the tier chip a detail row shows.
 *
 * Each tier is given the token of the family that dominates it, so a lane's
 * accent agrees with the bars inside it instead of introducing a fourth colour
 * vocabulary: the browser tier is rooted in the interaction it starts, the
 * server tier is entered through the request boundary it answers, and the
 * database tier has a family of its own.
 *
 * Total by construction over the closed tier union, and frozen.
 */
export const TIER_TOKEN_KEYS: Readonly<Record<TelemetryTier, TokenKey>> = Object.freeze({
  browser: 'kindInteraction',
  server: 'kindHttp',
  db: 'kindDb',
});

/**
 * The accent token for `tier`, falling back to {@link UNCLASSIFIED_TOKEN_KEY}
 * for a tier this build does not know. Never throws, for the reason given on
 * {@link kindTokenKey}.
 */
export function tierTokenKey(tier: TelemetryTier): TokenKey {
  const token: TokenKey | undefined = TIER_TOKEN_KEYS[tier];
  return token ?? UNCLASSIFIED_TOKEN_KEY;
}

/**
 * {@link tierTokenKey} as a CSS value reference, for a lane's inline accent.
 */
export function tierColorVar(tier: TelemetryTier): string {
  return cssVar(tierTokenKey(tier));
}

/*
 * ---------------------------------------------------------------------------
 * Dependency-graph participant class → span-kind token
 *
 * The dependency graph collapses a correlated trace into participants: what
 * took part in the interaction, and who called whom (AAP 0.6.2). Its
 * vocabulary is coarser than the kind vocabulary — several kinds collapse into
 * one class — so a node is coloured in two steps: by the span kinds it
 * collapsed when those agree on one colour, and by its class otherwise. The
 * first step is what keeps a participant in the colour its spans have in every
 * other view; the second is the class's own, distinct colour.
 * ---------------------------------------------------------------------------
 */

/**
 * The token each participant class of the dependency graph is drawn in when
 * its span kinds do not settle a colour of their own.
 *
 * The key type is derived from the node shape itself, so the table tracks the
 * participant vocabulary automatically and a class added upstream is a compile
 * error here. The six classes take six *distinct* tokens — a legend that
 * repeats a colour tells a reader two classes apart by nothing — and each is
 * the token its class's defining kind has in {@link KIND_TOKEN_KEYS}, so the
 * class colour and the span colour of the class's typical member agree:
 *
 * - `ui-event` → `kindInteraction`, the page acting, rooted in the interaction.
 * - `api` → `kindFetch`, the request boundary as the page sees it: the class is
 *   read left to right from the page, so the caller's end names it. The
 *   server's end of the same request collapses into the class too, and is drawn
 *   in its own span colour by {@link dependencyParticipantTokenKey}.
 * - `service` → `kindService`, server-side work behind the boundary: the route
 *   handler.
 * - `function` → `kindFunction`, named application code on either tier.
 * - `database` → `kindDb`, the datastore.
 * - `external` → `kindExternal`, a request the server made onwards.
 *
 * Frozen: a read-only lookup table.
 */
export const DEPENDENCY_NODE_TOKEN_KEYS: Readonly<Record<DependencyGraphNode['kind'], TokenKey>> =
  Object.freeze({
    'ui-event': 'kindInteraction',
    function: 'kindFunction',
    api: 'kindFetch',
    service: 'kindService',
    database: 'kindDb',
    external: 'kindExternal',
  });

/**
 * The token a dependency-graph node is drawn in, falling back to
 * {@link UNCLASSIFIED_TOKEN_KEY} for a participant class this build does not
 * know. Never throws, for the reason given on {@link kindTokenKey}.
 */
export function dependencyNodeTokenKey(kind: DependencyGraphNode['kind']): TokenKey {
  const token: TokenKey | undefined = DEPENDENCY_NODE_TOKEN_KEYS[kind];
  return token ?? UNCLASSIFIED_TOKEN_KEY;
}

/**
 * {@link dependencyNodeTokenKey} as a CSS value reference, for the inline fill
 * and stroke of an SVG graph node.
 */
export function dependencyNodeColorVar(kind: DependencyGraphNode['kind']): string {
  return cssVar(dependencyNodeTokenKey(kind));
}

/**
 * The token one dependency-graph participant is drawn in.
 *
 * The participant's span kinds (`DependencyGraphNode.spanKinds`) decide first:
 * when every kind it collapsed maps to one token in {@link KIND_TOKEN_KEYS},
 * that token is the answer, so a render participant is the render colour, the
 * server's end of a request is the server-request colour and a server failure
 * is the error colour — exactly as the timeline, flame and waterfall draw the
 * same spans. A participant whose kinds span several families, or that carries
 * no kinds (one contributed without captured records), falls back to its class
 * token, {@link dependencyNodeTokenKey}.
 *
 * @param node - The participant's class and, when it has them, its span kinds.
 * @returns The token to stroke and label the participant with.
 */
export function dependencyParticipantTokenKey(
  node: Pick<DependencyGraphNode, 'kind' | 'spanKinds'>,
): TokenKey {
  const kinds = node.spanKinds ?? [];
  const [first, ...rest] = kinds.map(kindTokenKey);
  if (first !== undefined && rest.every((token) => token === first)) {
    return first;
  }
  return dependencyNodeTokenKey(node.kind);
}

/**
 * {@link dependencyParticipantTokenKey} as a CSS value reference, for the
 * inline stroke of one SVG graph node.
 */
export function dependencyParticipantColorVar(
  node: Pick<DependencyGraphNode, 'kind' | 'spanKinds'>,
): string {
  return cssVar(dependencyParticipantTokenKey(node));
}

/*
 * ---------------------------------------------------------------------------
 * Render trigger → token
 *
 * A render's trigger is the finding the render panel exists for, so its colour
 * answers one question: is this render evidence of wasted work? The five
 * trigger values are three determinate "an input changed" cases, one
 * determinate "nothing changed" case and one "could not be determined" case,
 * and the colour distinguishes those three answers rather than the five values.
 * The values themselves are distinguished by their labels, which keeps colour
 * from being the sole carrier of meaning.
 * ---------------------------------------------------------------------------
 */

/**
 * The token a render trigger is drawn in, in the render table's trigger column,
 * a component-tree badge and a state-transition row.
 *
 * - `props`, `state` and `context` → `info`. A render with a changed input is
 *   work the framework was asked to do: explanatory, not a defect. Which input
 *   changed is stated by the label, so the three share a colour.
 * - `unchanged` → `warning`. The actionable case, and the one the
 *   unchanged-render metric counts: every one of the three inputs was
 *   evaluated and none of them changed, so the render was caused by an ancestor
 *   rendering and cost time for nothing.
 * - `unknown` → `textMuted`. At least one input could not be evaluated, so
 *   nothing is claimed. This must never be drawn as `unchanged`: "we checked
 *   and nothing changed" and "we could not check" support opposite
 *   conclusions, and the capture counts them as separate metrics for exactly
 *   that reason (AAP 0.2.3).
 *
 * Total by construction over the closed trigger union, and frozen.
 */
export const RENDER_TRIGGER_TOKEN_KEYS: Readonly<Record<RenderTrigger, TokenKey>> = Object.freeze({
  props: 'info',
  state: 'info',
  context: 'info',
  unchanged: 'warning',
  unknown: 'textMuted',
});

/**
 * The token for `trigger`, falling back to {@link UNCLASSIFIED_TOKEN_KEY} for a
 * trigger this build does not know — which is the muted colour the `unknown`
 * trigger itself uses, so an unrecognised value makes no claim either. Never
 * throws, for the reason given on {@link kindTokenKey}.
 */
export function renderTriggerTokenKey(trigger: RenderTrigger): TokenKey {
  const token: TokenKey | undefined = RENDER_TRIGGER_TOKEN_KEYS[trigger];
  return token ?? UNCLASSIFIED_TOKEN_KEY;
}

/**
 * {@link renderTriggerTokenKey} as a CSS value reference.
 */
export function renderTriggerColorVar(trigger: RenderTrigger): string {
  return cssVar(renderTriggerTokenKey(trigger));
}

/*
 * ---------------------------------------------------------------------------
 * Status → token
 *
 * A telemetry event's status is orthogonal to its kind: an operation keeps its
 * family's colour and reports its outcome separately, which is what lets a
 * failed database query still read as a database query.
 * ---------------------------------------------------------------------------
 */

/**
 * The token an event's status is drawn in, on a detail row's status chip and an
 * event log row's outcome marker.
 *
 * `ok` → `success` and `error` → `danger` are the status tokens the theme
 * defines for exactly this purpose. `unset` → `textMuted`, because an unset
 * status is the absence of a claim about the outcome — most spans never set
 * one — and drawing it as success would invent evidence.
 *
 * Total by construction over the closed status union, and frozen.
 */
export const STATUS_TOKEN_KEYS: Readonly<Record<TelemetryStatus, TokenKey>> = Object.freeze({
  unset: 'textMuted',
  ok: 'success',
  error: 'danger',
});

/**
 * The token for `status`, falling back to {@link UNCLASSIFIED_TOKEN_KEY} for a
 * status this build does not know. Never throws, for the reason given on
 * {@link kindTokenKey}.
 */
export function statusTokenKey(status: TelemetryStatus): TokenKey {
  const token: TokenKey | undefined = STATUS_TOKEN_KEYS[status];
  return token ?? UNCLASSIFIED_TOKEN_KEY;
}

/**
 * {@link statusTokenKey} as a CSS value reference.
 */
export function statusColorVar(status: TelemetryStatus): string {
  return cssVar(statusTokenKey(status));
}

/*
 * ---------------------------------------------------------------------------
 * Duration severity
 *
 * AAP 0.6.3 fixes four buckets and three boundaries, and every duration the
 * product prints is coloured by them: a table cell, a metric card, an
 * emphasised slow span. The boundaries are named constants rather than inline
 * numbers so that no consumer re-types one, and the classifier is kept
 * separate from the token table so a caller can label a severity and colour it
 * independently.
 * ---------------------------------------------------------------------------
 */

/**
 * The four severity steps, in increasing order of concern.
 *
 * Module-internal: {@link DurationSeverity} is derived from this tuple so the
 * values and the type can never disagree, and {@link DURATION_SEVERITIES} is
 * the widened view callers iterate.
 */
const DURATION_SEVERITY_TUPLE = Object.freeze(['fast', 'normal', 'slow', 'critical'] as const);

/** One of the four duration severity steps of AAP 0.6.3. */
export type DurationSeverity = (typeof DURATION_SEVERITY_TUPLE)[number];

/**
 * The severity steps in increasing order of concern, for a legend or a filter
 * control that has to offer all of them.
 */
export const DURATION_SEVERITIES: readonly DurationSeverity[] = DURATION_SEVERITY_TUPLE;

/**
 * Milliseconds at which a duration stops being `fast` and becomes `normal`
 * (AAP 0.6.3). Inclusive: exactly this value classifies as `normal`.
 */
export const DURATION_NORMAL_THRESHOLD_MS = 50;

/**
 * Milliseconds at which a duration stops being `normal` and becomes `slow`
 * (AAP 0.6.3). Inclusive: exactly this value classifies as `slow`.
 */
export const DURATION_SLOW_THRESHOLD_MS = 200;

/**
 * Milliseconds at which a duration stops being `slow` and becomes `critical`
 * (AAP 0.6.3). Inclusive: exactly this value classifies as `critical`.
 */
export const DURATION_CRITICAL_THRESHOLD_MS = 500;

/**
 * Classifies a duration in milliseconds into one of the four severity steps.
 *
 * The intervals are half-open and the boundary belongs to the *slower* bucket,
 * which is the behaviour AAP 0.6.3 states and the one an off-by-one here would
 * silently invert in every table in the product:
 *
 * - `[0, 50)` → `fast` — so `49.9` is fast and `50` is not;
 * - `[50, 200)` → `normal` — so `199.9` is normal and `200` is not;
 * - `[200, 500)` → `slow` — so `499.9` is slow and `500` is not;
 * - `[500, ∞)` → `critical`.
 *
 * Degenerate inputs are classified rather than rejected, because this function
 * runs inside a render and a thrown error there would take a panel down over a
 * single malformed row:
 *
 * - a negative duration clamps to `0` and reads as `fast` (durations are never
 *   negative in a well-formed capture; the clamp comes from the shared
 *   `clampNonNegative`, which is also what the producers use, rather than from
 *   a second implementation here);
 * - `NaN` clamps to `0` by the same helper and therefore reads as `fast`. It is
 *   the deliberate choice for an unmeasurable value: `fast` is the muted,
 *   non-alarming end of the scale, and a caller that must distinguish "no
 *   measurement" from "fast" renders the not-available label from `./format`
 *   instead of a duration;
 * - `Infinity` is greater than every threshold and reads as `critical`.
 *
 * @param durationMs A duration in milliseconds, the canonical unit of every
 * telemetry event (AAP 0.2.3).
 */
export function durationSeverity(durationMs: number): DurationSeverity {
  const ms = clampNonNegative(durationMs);

  if (ms < DURATION_NORMAL_THRESHOLD_MS) {
    return 'fast';
  }
  if (ms < DURATION_SLOW_THRESHOLD_MS) {
    return 'normal';
  }
  if (ms < DURATION_CRITICAL_THRESHOLD_MS) {
    return 'slow';
  }
  return 'critical';
}

/**
 * The token each severity step is drawn in (AAP 0.6.3).
 *
 * The four duration tokens are theme-level aliases of the muted text, primary
 * text, warning and danger colours, and that aliasing lives in
 * `../tokens/tokens` — this table names the alias, never the colour it
 * resolves to, so a theme can re-point a step without any renderer changing.
 *
 * Total by construction over the severity union, and frozen.
 */
export const SEVERITY_TOKEN_KEYS: Readonly<Record<DurationSeverity, TokenKey>> = Object.freeze({
  fast: 'durationFast',
  normal: 'durationNormal',
  slow: 'durationSlow',
  critical: 'durationCritical',
});

/**
 * The token for `severity`.
 *
 * The fallback for a severity this build does not know is `durationNormal`, the
 * neutral primary-text colour — not the muted fallback the other tables use,
 * because muted is already the `fast` colour and an unrecognised value must not
 * read as the fastest bucket; and not the danger colour, which would alarm
 * without evidence. Never throws, for the reason given on {@link kindTokenKey}.
 */
export function severityTokenKey(severity: DurationSeverity): TokenKey {
  const token: TokenKey | undefined = SEVERITY_TOKEN_KEYS[severity];
  return token ?? 'durationNormal';
}

/**
 * {@link severityTokenKey} as a CSS value reference, for the inline `color` of
 * a duration cell or the emphasis on a slow bar.
 */
export function severityColorVar(severity: DurationSeverity): string {
  return cssVar(severityTokenKey(severity));
}

/**
 * The token a duration of `durationMs` is drawn in: {@link durationSeverity}
 * followed by {@link severityTokenKey}, for the common case where a caller
 * wants the colour and not the step.
 */
export function durationTokenKey(durationMs: number): TokenKey {
  return severityTokenKey(durationSeverity(durationMs));
}

/**
 * {@link durationTokenKey} as a CSS value reference.
 */
export function durationColorVar(durationMs: number): string {
  return cssVar(durationTokenKey(durationMs));
}

/*
 * ---------------------------------------------------------------------------
 * WCAG contrast
 *
 * The one place in this package where colour *values* are parsed, and the only
 * place the contrast formula is implemented. `../tokens/tokens.test.ts`
 * measures every text/surface and status/surface pair of all three themes with
 * these helpers and fails below the minima AAP 0.6.3 fixes, which is what turns
 * "the palette is accessible" into something a gate can check.
 *
 * Values travel in from the caller. This module holds no colour table of its
 * own: the token table owns the values, the helpers own the arithmetic, and the
 * only hex strings written here are the two reference figures documented on
 * {@link contrastRatio}, which exist so a reader can confirm the
 * implementation without running the test.
 * ---------------------------------------------------------------------------
 */

/** An sRGB colour as three 8-bit channels. */
export interface RgbColor {
  /** Red channel, `0`–`255`. */
  readonly r: number;
  /** Green channel, `0`–`255`. */
  readonly g: number;
  /** Blue channel, `0`–`255`. */
  readonly b: number;
}

/** Three- or six-digit hex, with or without a leading hash, case-insensitive. */
const HEX_COLOR_PATTERN = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

/** Digit count of the shorthand form, where each digit stands for a pair. */
const SHORTHAND_DIGITS = 3;

/** The largest value a channel can hold. */
const MAX_CHANNEL = 255;

/** Radix of a hex digit pair. */
const HEX_RADIX = 16;

/**
 * Whether `value` is a colour {@link parseHexColor} can read.
 *
 * Exists for one job: selecting the *measurable* entries of a token set. Some
 * tokens hold a `var(...)` reference to another token rather than a colour of
 * their own — the four duration steps do — and a caller iterating a theme has
 * to skip those before measuring, which this predicate lets it do without
 * catching an exception.
 *
 * It is **not** a way to skip a value that fails to parse. A token that should
 * hold a colour and does not is a regression, and the caller's job is to fail
 * on it rather than to filter it away; use this to select what to measure, then
 * measure everything selected.
 */
export function isHexColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value.trim());
}

/**
 * Parses a hex colour into its three channels.
 *
 * Accepts `#abc`, `abc`, `#AABBCC` and `aabbcc`, in either case, with
 * surrounding whitespace ignored. The shorthand form expands by doubling each
 * digit, so `#abc` and `#aabbcc` parse to the same channels.
 *
 * @throws A `TypeError` whose message quotes the offending input. Throwing is
 * deliberate and so is the plain `TypeError`: an unparseable colour here is a
 * programming error at a developer-time boundary — a malformed token value or a
 * bad literal in a test — never a runtime condition any user interface reports,
 * so it does not consume one of the shared error codes, whose whole value is
 * that a code tells a surface what recovery to offer. Returning a fallback
 * colour or a neutral `1:1` ratio instead would be worse than useless: it would
 * let a contrast regression pass the token gate silently, which is the one
 * failure this module exists to prevent.
 */
export function parseHexColor(value: string): RgbColor {
  const normalized = value.trim();

  if (!HEX_COLOR_PATTERN.test(normalized)) {
    throw new TypeError(
      `Not a hex colour: ${JSON.stringify(value)}. Expected three or six hex digits, ` +
        `optionally prefixed with "#". A token that holds a var(...) reference to another ` +
        `token is not a colour: resolve it to the token it aliases before measuring it.`,
    );
  }

  const digits = normalized.startsWith('#') ? normalized.slice(1) : normalized;
  const expanded =
    digits.length === SHORTHAND_DIGITS
      ? Array.from(digits, (digit) => `${digit}${digit}`).join('')
      : digits;

  return {
    r: Number.parseInt(expanded.slice(0, 2), HEX_RADIX),
    g: Number.parseInt(expanded.slice(2, 4), HEX_RADIX),
    b: Number.parseInt(expanded.slice(4, 6), HEX_RADIX),
  };
}

/**
 * Linearises one 8-bit sRGB channel, the inner step of the WCAG 2.x relative
 * luminance definition: the channel is scaled to `0`–`1` and then either
 * divided by `12.92` or raised through the gamma curve
 * `((c + 0.055) / 1.055) ** 2.4`.
 *
 * The published threshold is written both as `0.03928` and as `0.04045`
 * depending on the revision; for 8-bit channels the two select the same branch
 * for every possible value — `10 / 255` is `0.0392`, below both, and `11 / 255`
 * is `0.0431`, above both — so the choice cannot change a ratio computed from a
 * hex colour.
 *
 * A channel outside `0`–`255` is bounded into range rather than rejected, and
 * a `NaN` channel bounds to `0`, so a hand-built {@link RgbColor} cannot
 * produce a nonsensical luminance. Values parsed by {@link parseHexColor} are
 * always in range already.
 */
function linearizeChannel(channel: number): number {
  const scaled = Math.min(MAX_CHANNEL, clampNonNegative(channel)) / MAX_CHANNEL;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/**
 * The relative luminance of a colour, `0` for black and `1` for white: the
 * WCAG 2.x weighting `0.2126 R + 0.7152 G + 0.0722 B` over the linearised
 * channels.
 *
 * Accepts either a hex string — the form token values are written in — or
 * already-parsed channels, so a caller measuring one colour against several
 * others can parse once. A hex string is parsed with {@link parseHexColor} and
 * therefore throws on a malformed value.
 */
export function relativeLuminance(color: string | RgbColor): number {
  const { r, g, b } = typeof color === 'string' ? parseHexColor(color) : color;
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

/**
 * The WCAG 2.x contrast ratio between two colours:
 * `(lighter + 0.05) / (darker + 0.05)` over their relative luminances.
 *
 * Order-independent — the arguments are named for readability, and swapping
 * them returns the same number — and always at least `1`, which is the ratio of
 * a colour with itself.
 *
 * The ratio this returns is the raw one. Round it with
 * {@link roundContrastRatio} for reporting, and compare the raw value with
 * {@link meetsContrast}, so a pair that misses a minimum in the fourth decimal
 * cannot be rounded into compliance.
 *
 * Reference figures from AAP 0.6.3, reproduced by this implementation to two
 * decimals: the muted text colour on the darkest surface the dark theme permits
 * measures `5.09:1`, and the light theme's muted text on its overlay surface
 * measures `4.82:1`. `../tokens/tokens.test.ts` asserts the whole matrix; those
 * two are the worst pairs in each theme, and a change here that does not
 * reproduce them is an error in the arithmetic rather than in the palette.
 */
export function contrastRatio(
  foreground: string | RgbColor,
  background: string | RgbColor,
): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * A contrast ratio rounded to two decimals — the precision AAP 0.6.3 quotes
 * its figures in, and therefore the form an assertion or a diagnostic message
 * states.
 *
 * For reporting only. Compare the raw ratio with {@link meetsContrast}.
 */
export function roundContrastRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}

/**
 * Whether a contrast ratio meets a minimum.
 *
 * Pass the raw ratio from {@link contrastRatio}, not a rounded one: `4.4996`
 * rounds to `4.5` and would pass a check it should fail. The comparison is
 * inclusive, so a ratio exactly equal to the minimum meets it.
 */
export function meetsContrast(ratio: number, minimum: number): boolean {
  return ratio >= minimum;
}

/**
 * The contrast a text colour must reach against the surface behind it: WCAG AA
 * for normal-size text, the bar AAP 0.6.3 holds every text and status colour of
 * every theme to.
 */
export const WCAG_AA_TEXT_CONTRAST = 4.5;

/**
 * The contrast a non-text visual must reach: WCAG AA for large text, user
 * interface components and graphical objects. AAP 0.6.3 holds the span-kind
 * scale to this bar rather than the text bar, because those tokens are used as
 * fills that carry their own labels.
 */
export const WCAG_AA_NON_TEXT_CONTRAST = 3;
