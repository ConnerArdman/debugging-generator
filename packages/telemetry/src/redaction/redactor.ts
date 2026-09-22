/**
 * The composition point of the telemetry privacy boundary: one captured event
 * in, one redacted event out.
 *
 * AAP 0.5.2 places the redaction layer at **two** pipeline points, and this
 * module is the first of them:
 *
 * 1. **Service ingest.** `apps/local-service/src/telemetry/ingest.ts` calls
 *    {@link redactEvent} on every validated event *before* it is persisted or
 *    broadcast on the `telemetry.tail` live feed. Nothing downstream — the
 *    store, the aggregates, the panel data sources, the DevTools panel — ever
 *    sees an unredacted value.
 * 2. **Outbound model guard.** `packages/model-provider/src/redact-guard.ts`
 *    re-checks every prompt payload with the same vocabulary and *refuses the
 *    call* when a denied pattern survived. A credential that slips through
 *    here therefore does not merely leak: it fails the pipeline at the second
 *    checkpoint, which is why the invariants below are absolute rather than
 *    best-effort.
 *
 * ## Where this sits in the ingest order
 *
 * `request_key` is computed **before** redaction, from the *unredacted* URL,
 * by `./request-key.ts` (an HMAC over method, path and sorted query pairs
 * under a random per-session key that never leaves the store). That ordering
 * is what lets duplicate-request detection survive redaction — two
 * byte-identical requests collide while two requests differing only in a
 * parameter value do not, even though both URLs are stored with their
 * parameter values masked. This module therefore treats every key in
 * `SERVICE_ASSIGNED_ATTRIBUTE_KEYS` as exempt: see
 * {@link redactAttributesWithFindings}.
 *
 * So the ingest sequence is: validate (`../schema/event.ts`) → key
 * (`./request-key.ts`) → **redact (this module)** → attribute → persist →
 * correlate → broadcast.
 *
 * ## What this module decides, and what it delegates
 *
 * Nothing about *what* a credential looks like is decided here. The deny-list
 * vocabulary lives in `./rules.ts`, header masking in `./headers.ts`, query
 * masking in `./url.ts` and statement masking in `./sql.ts`; the key catalog
 * and the two privacy bounds live in `../schema/attributes.ts` and the kind
 * groups in `../schema/kinds.ts`. This module owns exactly one thing: the
 * **dispatch table** that decides which of those handlers a given attribute
 * goes to, plus the bounded, cycle-safe, total walk that applies it to a
 * whole event. Every number it needs is imported; the only bounds declared
 * here are the two structural ones the walk itself needs
 * ({@link MAX_ATTRIBUTE_DEPTH}, {@link MAX_ATTRIBUTE_NODES}).
 *
 * ## The `redacted` provenance marker
 *
 * `../schema/event.ts` declares `redacted` as the **attribute paths whose
 * values the redactor replaced**, optional, and documents that only this
 * module sets it. That is the contract implemented here: the returned event
 * carries the paths of every attribute whose emitted value differs from the
 * value that arrived (masked, truncated, dropped or omitted by a bound), and
 * omits the field entirely when nothing was touched. Both event schemas are
 * `z.strictObject`, so a boolean marker or an extra key would make a redacted
 * event unparseable and break the ingest path; the paths are normalised and
 * bounded exactly like any other captured string, because an attribute *key*
 * is page-supplied too.
 *
 * Provenance itself — "has this event crossed the boundary?" — is the ingest
 * path's call ordering, not a field: an event reaches the store and the live
 * tail only through {@link redactEvent}. The {@link RedactionReport} is the
 * loggable half of that record: counts and rule ids only, never a value and
 * never a path.
 *
 * ## Guarantees
 *
 * - **Total.** Nothing here throws, for any input of any shape. A throwing
 *   getter, a hostile `Proxy`, a null-prototype object, a DOM node, a cyclic
 *   structure and a `bigint` all yield a bounded, JSON-shaped result. Ingest
 *   processes batches, and one malformed attribute must never cost the rest
 *   (AAP 0.5.5).
 * - **Non-mutating.** The input event, its `attributes` bag and every nested
 *   object and array are left untouched and are never shared into the result.
 *   The browser agent's batch is shared across events and ingest may hold the
 *   parsed event for logging.
 * - **Idempotent.** `redactEvent(redactEvent(e))` deep-equals
 *   `redactEvent(e)`, and likewise for {@link redactAttributes}: the marker is
 *   not re-marked, a `?`-masked query does not become `??`, an
 *   already-truncated preview does not shrink again, and the `redacted` path
 *   list is merged rather than recomputed.
 * - **Deterministic and cheap.** No clock, no randomness, no I/O, no logging,
 *   no module state. Work is linear in total input size, and the unchanged
 *   path — which is almost every attribute of almost every event — does no
 *   classification work at all.
 * - **Schema-preserving.** The result parses against the same schema the input
 *   did: no top-level key is added or removed, `name` never grows beyond the
 *   length it arrived with, and no emitted value is a function, a symbol, a
 *   `bigint` or `undefined`.
 */
import {
  MAX_PREVIEW_LENGTH,
  MAX_TRACKED_KEYS,
  DB_QUERY_ATTRIBUTE_KEYS,
  FETCH_ATTRIBUTE_KEYS,
  RENDER_ATTRIBUTE_KEYS,
  SERVICE_ASSIGNED_ATTRIBUTE_KEYS,
  STATE_ATTRIBUTE_KEYS,
  type ChangedPropEntry,
} from '../schema/attributes.js';
import type { TelemetryEvent, TelemetryEventIngress } from '../schema/event.js';
import {
  QUERY_KINDS,
  RENDER_KINDS,
  REQUEST_KINDS,
  STATE_KINDS,
  type TelemetryKind,
} from '../schema/kinds.js';
import {
  headerNameFromAttributeKey,
  isDeniedHeaderName,
  isHeaderAttributeKey,
  isHeaderObjectAttributeKey,
  redactHeaderValue,
  redactHeaders,
  type HeaderRecord,
  type HeaderValue,
} from './headers.js';
import {
  MAX_SCAN_LENGTH,
  REDACTION_MARKER,
  REDACTION_RULE_IDS,
  asScannableText,
  findDeniedRules,
  isSensitiveKeyName,
  scrub,
  scrubNamedValue,
  truncate,
  type RedactionRuleId,
} from './rules.js';
import { redactSqlStatement } from './sql.js';
import { URL_ATTRIBUTE_KEYS, isUrlAttributeKey, redactUrl } from './url.js';

/*
 * ---------------------------------------------------------------------------
 * Key vocabularies
 *
 * Every attribute key this module names is tied back to the catalog in
 * `../schema/attributes.ts` through an annotated constant, so a key renamed
 * or removed there is a compile error here rather than a handler that
 * silently stops firing. The catalog tuples are literal (`Object.freeze([… ]
 * as const)`), which is what makes the annotation a real check.
 * ---------------------------------------------------------------------------
 */

/**
 * The `db.query` key whose value is statement text, from the catalog tuple.
 *
 * Annotated with the tuple's member union so this cannot drift from
 * `DB_QUERY_ATTRIBUTE_KEYS`.
 */
const DB_STATEMENT_KEY: (typeof DB_QUERY_ATTRIBUTE_KEYS)[number] = 'db.statement';

/** The `fetch`/`xhr` key carrying the call-site stack of a request. */
const FETCH_INITIATOR_KEY: (typeof FETCH_ATTRIBUTE_KEYS)[number] = 'initiator';

/** The `render` key carrying the changed-prop entry list. */
const CHANGED_PROPS_KEY: (typeof RENDER_ATTRIBUTE_KEYS)[number] = 'changedProps';

/** The `state` key carrying the pre-transition value summary. */
const STATE_PREVIOUS_VALUE_KEY: (typeof STATE_ATTRIBUTE_KEYS)[number] = 'previousValue';

/** The `state` key carrying the post-transition value summary. */
const STATE_NEXT_VALUE_KEY: (typeof STATE_ATTRIBUTE_KEYS)[number] = 'nextValue';

/**
 * The field of a {@link ChangedPropEntry} that holds a **prop name** rather
 * than a prop value.
 *
 * It is spelled `key`, which the deny-list's name vocabulary treats as
 * sensitive — `scrubNamedValue('key', 'itemCount')` is `[redacted]`. Applying
 * the name rule to it would therefore replace the name of *every* changed
 * prop on every render event, and `../aggregate/renders.ts` and the
 * `renderTable` node exist to show exactly those names (AAP 0.6.2). Inside a
 * preview subtree this one field is consequently exempt from the name rule
 * and scrubbed by content only; see {@link redactAttributesWithFindings}.
 *
 * Typed as a key of the interface so a rename of that field breaks the build.
 */
const CHANGED_PROP_NAME_FIELD: keyof ChangedPropEntry = 'key';

/**
 * Attribute keys whose value is dropped outright rather than masked.
 *
 * AAP 0.5.2 states that request and response **bodies are never captured**
 * ("only method, URL (redacted), status, size, timing") and that database
 * **row contents are never captured** ("only `db.rowCount`"). A value under
 * one of these names is exactly that: unbounded application data, of no
 * diagnostic use at all once its shape is known. So it is *dropped* rather
 * than replaced with the marker — the marker means "something was here and
 * was removed", which is a useful signal for a header or a prop but only
 * noise for a body nobody asked for. The key's absence is itself accurate:
 * this product never captured it.
 *
 * Matching is case- and separator-insensitive, using the same normalisation
 * `isSensitiveKeyName` applies, so `requestBody`, `request_body` and
 * `Request-Body` are one name. None of these folds onto a key the catalog
 * declares (asserted in the colocated test), so dropping them costs no
 * declared evidence.
 */
export const DROPPED_ATTRIBUTE_KEYS = Object.freeze([
  'body',
  'requestBody',
  'responseBody',
  'payload',
  'rows',
  'row',
  'result',
  'results',
  'values',
  'params',
  'parameters',
  'variables',
  'data',
] as const);

/**
 * Attribute keys exempt from preview truncation because their value is
 * structural and has its own dedicated handler.
 *
 * A statement, a URL and a call-site stack are read end to end — by
 * `../aggregate/queries.ts`, by duplicate-request analysis and by the
 * source-map resolution route respectively — and a 120-character preview of
 * any of them is useless. Each is bounded by its own handler instead
 * (`./sql.ts` and `./url.ts` bound their output to `MAX_SCAN_LENGTH`, and a
 * stack is bounded by `scrub`), so "untruncated" means "not cut to the
 * *preview* bound", never "unbounded".
 *
 * Derived from the catalog tuples rather than retyped: the statement key, the
 * URL keys `./url.ts` recognises, and the fetch initiator key.
 */
export const UNTRUNCATED_ATTRIBUTE_KEYS = Object.freeze([
  DB_STATEMENT_KEY,
  ...URL_ATTRIBUTE_KEYS,
  FETCH_INITIATOR_KEY,
] as const);

/**
 * How deep the attribute walk descends before it stops emitting containers.
 *
 * The bag itself is depth 0 and its own values are depth 1, so a scalar
 * nested six levels below the bag still travels while a *container* at that
 * depth is omitted along with everything under it. Declared structures are
 * far shallower — a `changedProps` entry's value summary is three levels
 * deep — so the bound only ever bites on an application object a producer
 * summarised badly, which is the case it exists for: a deep structure is not
 * evidence, and walking one is how an ingest loop spends a batch's budget on
 * one event.
 */
export const MAX_ATTRIBUTE_DEPTH = 6;

/**
 * How many values one attribute bag may emit in total, across every level.
 *
 * A second, orthogonal bound to the per-object key limit: 32 keys at each of
 * six levels would otherwise multiply out, and this is the total that decides
 * the size of a stored row and of a live-tail frame. Reaching it omits the
 * remainder silently — an event is evidence, not a serialisation of the
 * page's heap.
 *
 * It also bounds the `redacted` path list on the returned event, so a
 * pathological bag cannot turn one event into a large one by way of its own
 * redaction record.
 */
export const MAX_ATTRIBUTE_NODES = 512;

/*
 * ---------------------------------------------------------------------------
 * Public option, context and report shapes
 * ---------------------------------------------------------------------------
 */

/**
 * Bounds the walk applies, each defaulting to the single declaration of that
 * number.
 *
 * Callers on the ingest path pass nothing and get the product's guarantees.
 * The options exist for two legitimate uses: a test that needs a bound small
 * enough to reach in a fixture, and a caller with a tighter budget than the
 * default (a live-tail frame, say). They can only ever be *stated* here —
 * every default comes from `../schema/attributes.ts` or from the two
 * constants above — and a value of `0` means "emit nothing at that level"
 * rather than "use the default".
 *
 * Each property accepts an explicit `undefined` (matching `attributeKeysFor`
 * in `../schema/attributes.ts`), so a caller may forward a computed value
 * without narrowing it first under `exactOptionalPropertyTypes`.
 */
export interface RedactionOptions {
  /**
   * Longest string value emitted, in code points, outside
   * {@link UNTRUNCATED_ATTRIBUTE_KEYS}. Defaults to `MAX_PREVIEW_LENGTH`
   * (120) — a documented privacy guarantee, not a tuning knob.
   */
  maxPreviewLength?: number | undefined;
  /**
   * Most keys emitted per nested object, and most elements emitted per array.
   * Defaults to `MAX_TRACKED_KEYS` (32), the bound a diff already obeys. The
   * attribute bag itself is not subject to it — its keys are the declared
   * per-kind vocabulary — and is bounded by `maxNodes` alone.
   */
  maxTrackedKeys?: number | undefined;
  /** Deepest level whose containers are still emitted. Defaults to {@link MAX_ATTRIBUTE_DEPTH}. */
  maxDepth?: number | undefined;
  /** Most values emitted in total, and most `redacted` paths. Defaults to {@link MAX_ATTRIBUTE_NODES}. */
  maxNodes?: number | undefined;
}

/**
 * What the walk knows about the event an attribute bag belongs to.
 *
 * Only the kind, and only to choose a handler: statement masking for the
 * query kinds, preview treatment for the render and state kinds. Dispatch
 * asks `../schema/kinds.ts` for **group membership** and never compares
 * against a literal kind string, which is that module's stated contract.
 *
 * Absent kind is a legitimate input — a caller redacting a bare attribute bag
 * — and means "apply every key-driven rule, and no kind-gated one".
 */
export interface RedactionContext {
  /** The kind of the event the attributes belong to, when it is known. */
  kind?: TelemetryKind | undefined;
}

/**
 * What the redactor did, in a form that is safe to log.
 *
 * Counts and rule ids only. **No value and no attribute path appears here**:
 * a path is built from page-supplied key names, so a report written to a log
 * that a redacted payload could not be written to must not carry one. The
 * paths travel on the returned event's `redacted` field instead, where the
 * developer who owns the page is the only reader.
 *
 * `rules` comes back in `REDACTION_RULE_IDS` order and without duplicates, so
 * two reports over the same input are byte-identical.
 */
export interface RedactionReport {
  /** Deny-list rules matched anywhere in the bag, in vocabulary order. */
  rules: RedactionRuleId[];
  /** Keys whose value was not emitted: dropped by policy, untransportable, or past a bound. */
  droppedKeys: number;
  /** Values shortened to the preview bound. */
  truncatedValues: number;
  /** Values whose content was masked or replaced. A truncated value may also be masked. */
  maskedValues: number;
}

/*
 * ---------------------------------------------------------------------------
 * Folded lookup tables
 *
 * Membership tests run once per attribute of every ingested event, so each
 * vocabulary above is materialised as a `Set` here rather than scanned.
 * ---------------------------------------------------------------------------
 */

/**
 * Separators removed before a key is matched, which makes the dropped-key and
 * statement-key tests insensitive to camelCase, snake_case, kebab-case and
 * dotted spellings.
 *
 * The same character class `./rules.ts` and `./headers.ts` each use for their
 * own normalisation. Neither exports it — `./rules.ts` is deliberately
 * import-free so the page agent can bundle it — so the three copies are kept
 * in step by their colocated tests rather than by an import edge. Global, and
 * therefore used only with `replace`.
 */
const KEY_SEPARATORS = /[\s._-]/g;

/** Lower-cases an attribute key and removes its separators. */
function foldKey(key: string): string {
  return key.toLowerCase().replace(KEY_SEPARATORS, '');
}

/** Folded {@link DROPPED_ATTRIBUTE_KEYS}, for an O(1) test per attribute. */
const DROPPED_KEY_FOLDS: ReadonlySet<string> = new Set<string>(DROPPED_ATTRIBUTE_KEYS.map(foldKey));

/**
 * {@link UNTRUNCATED_ATTRIBUTE_KEYS}, matched **exactly** rather than folded.
 *
 * Exactness is the point: `db.statement` and `url` are the catalog's
 * spellings, and a loose match would exempt a producer's own `dbStatement`
 * -shaped key from the preview bound without its value having gone through
 * the statement handler. `initiator.type` — a short resource-timing enum
 * value — likewise stays truncatable, which a folded match would not manage.
 */
const UNTRUNCATED_KEYS: ReadonlySet<string> = new Set<string>(UNTRUNCATED_ATTRIBUTE_KEYS);

/**
 * {@link SERVICE_ASSIGNED_ATTRIBUTE_KEYS}, matched exactly at the top level of
 * the bag only.
 *
 * Exact, because the service writes exactly these spellings: a producer's
 * `requestKey` is not the service's `request_key` and gets no exemption.
 */
const SERVICE_ASSIGNED_KEYS: ReadonlySet<string> = new Set<string>(SERVICE_ASSIGNED_ATTRIBUTE_KEYS);

/**
 * Folded key names whose value is statement text on a query-kind event.
 *
 * `db.statement` is the catalog's key and is handled on any kind, because a
 * mislabelled event must not get a statement through unmasked. The other
 * three are the spellings a producer or an instrumentation reasonably uses
 * for the same thing, and they are honoured **only** when the event's kind is
 * in `QUERY_KINDS` — on any other kind, a key called `query` is far more
 * likely to be a query-string bag, which the generic path handles.
 */
const STATEMENT_KEY_FOLDS: ReadonlySet<string> = new Set<string>([
  foldKey(DB_STATEMENT_KEY),
  'statement',
  'sql',
  'query',
]);

/**
 * The preview families: an attribute key whose value is a React prop or hook
 * state *summary*, paired with the kinds that legitimately carry it.
 *
 * AAP 0.5.2 admits props and state only as "key names plus type/summary and
 * change flags, values truncated to 120 characters and passed through the
 * same pattern rules". The producer (`../browser/fiber-diff.ts`) already
 * builds them that way, applying the name rule with each prop's own name;
 * this module is the backstop that assumes it did not.
 *
 * Kind-gating is deliberate and is the *safe* direction: on a render or state
 * event these keys are a diff, whose structural `key` field must survive
 * (see {@link CHANGED_PROP_NAME_FIELD}); on any other kind the same key is
 * something else entirely and takes the generic path, where the name rule
 * applies to every field.
 */
const PREVIEW_FAMILIES: readonly {
  readonly kinds: readonly TelemetryKind[];
  readonly keys: ReadonlySet<string>;
}[] = Object.freeze([
  Object.freeze({ kinds: RENDER_KINDS, keys: new Set<string>([CHANGED_PROPS_KEY]) }),
  Object.freeze({
    kinds: STATE_KINDS,
    keys: new Set<string>([STATE_PREVIOUS_VALUE_KEY, STATE_NEXT_VALUE_KEY]),
  }),
]);

/**
 * The name an array element is redacted under: none.
 *
 * An element has an index, not a name, and no name-driven rule may fire from
 * one. The empty string is the honest spelling of that — every predicate in
 * the dispatch table rejects it (`isSensitiveKeyName('')` is `false` by its
 * own emptiness check, no header prefix or URL suffix matches, and no
 * vocabulary contains it) — so an element is judged purely by its content,
 * which is all that is known about it.
 */
const ARRAY_ELEMENT_KEY = '';

/*
 * ---------------------------------------------------------------------------
 * Bounds resolution
 * ---------------------------------------------------------------------------
 */

/** The four bounds, resolved once per call. */
interface ResolvedLimits {
  readonly maxPreviewLength: number;
  readonly maxTrackedKeys: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

/**
 * Resolves one bound: a finite, non-negative integer, or the default.
 *
 * A missing or non-finite value takes the default, a fraction is floored, and
 * a negative value clamps to `0` (which every consumer of a bound reads as
 * "nothing at this level"). A caller cannot therefore widen a bound into
 * `Infinity` by accident and turn the walk unbounded.
 */
function resolveBound(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

/** Resolves the whole option bag against the declared defaults. */
function resolveLimits(options: RedactionOptions | undefined): ResolvedLimits {
  return {
    maxPreviewLength: resolveBound(options?.maxPreviewLength, MAX_PREVIEW_LENGTH),
    maxTrackedKeys: resolveBound(options?.maxTrackedKeys, MAX_TRACKED_KEYS),
    maxDepth: resolveBound(options?.maxDepth, MAX_ATTRIBUTE_DEPTH),
    maxNodes: resolveBound(options?.maxNodes, MAX_ATTRIBUTE_NODES),
  };
}

/*
 * ---------------------------------------------------------------------------
 * Walk state
 *
 * One mutable record per call, threaded through the walk. It is deliberately
 * not a class: the walk is a pure function of its input, and the state exists
 * only so that counters and the path list do not have to be merged back out
 * of every recursive return.
 * ---------------------------------------------------------------------------
 */

interface WalkState {
  readonly limits: ResolvedLimits;
  /** The event's kind, when known; gates the statement and preview handlers. */
  readonly kind: TelemetryKind | undefined;
  /**
   * The containers on the path from the bag to the value being redacted.
   *
   * Ancestors, not "everything seen": a structure that references the same
   * object from two sibling positions is not cyclic, and treating it as such
   * would replace legitimate evidence with the marker. Entries are added
   * before descending and removed afterwards, so the set is exactly the
   * current path and a genuine cycle is caught on its second visit.
   */
  readonly ancestors: WeakSet<object>;
  readonly matched: Set<RedactionRuleId>;
  readonly paths: string[];
  readonly recorded: Set<string>;
  nodes: number;
  droppedKeys: number;
  truncatedValues: number;
  maskedValues: number;
}

/**
 * Normalises one attribute path for the `redacted` list.
 *
 * A path is built from page-supplied key names, so it is scrubbed and bounded
 * exactly like a captured string: a key that *is* a credential cannot ride
 * out on the redaction record of the value it named. The bound is the preview
 * bound, which makes normalisation idempotent — a path inherited from an
 * already-redacted event normalises to itself — and an empty result becomes
 * the marker, because `../schema/event.ts` requires every path to be
 * non-empty.
 */
function normalizePath(path: unknown, limits: ResolvedLimits): string {
  const cleaned = truncate(scrub(path), limits.maxPreviewLength);
  return cleaned.length > 0 ? cleaned : REDACTION_MARKER;
}

/**
 * Records that the value at `path` is not the value that arrived.
 *
 * Deduplicated after normalisation (two distinct keys can normalise to one
 * path) and capped at the node budget, so the record of a pathological bag
 * cannot itself become the large payload the budget exists to prevent.
 */
function recordPath(state: WalkState, path: string): void {
  if (state.paths.length >= state.limits.maxNodes) {
    return;
  }
  const normalised = normalizePath(path, state.limits);
  if (state.recorded.has(normalised)) {
    return;
  }
  state.recorded.add(normalised);
  state.paths.push(normalised);
}

/** Extends a path with a record key. The bag's own path is the empty string. */
function joinKeyPath(prefix: string, key: string): string {
  const segment = key.length > 0 ? key : REDACTION_MARKER;
  return prefix.length === 0 ? segment : `${prefix}.${segment}`;
}

/** Extends a path with an array index. */
function joinIndexPath(prefix: string, index: number): string {
  return `${prefix}[${String(index)}]`;
}

/**
 * Records every deny-list rule the value matched, for the report.
 *
 * Called **only when a value actually changed**, which keeps the hot path —
 * the overwhelming majority of attributes, which no rule touches — free of a
 * second scan. Detection reads at most the window `scrub` examined: a value
 * longer than that had its tail replaced wholesale, so scanning further would
 * classify text that was never emitted.
 *
 * Nothing about the value itself reaches the report; `findDeniedRules`
 * returns ids only.
 */
function classify(state: WalkState, value: unknown, name: string): void {
  const text = asScannableText(value);
  const scanned = text.length > MAX_SCAN_LENGTH ? text.slice(0, MAX_SCAN_LENGTH) : text;
  for (const rule of findDeniedRules(scanned, name)) {
    state.matched.add(rule);
  }
}

/*
 * ---------------------------------------------------------------------------
 * Shape predicates and comparisons
 *
 * Every one of these is called on a value an untrusted producer supplied, so
 * none of them reads a property that could run page code, and all of them are
 * invoked from inside the dispatcher's `try` block.
 * ---------------------------------------------------------------------------
 */

/** Whether a value is a non-array object, the shape a record walk accepts. */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether an object is a plain bag — an object literal, a parsed JSON object
 * or a null-prototype object — rather than a class instance, a `Map`, a
 * `Date`, a DOM node or a `Proxy` over one.
 *
 * Only a plain bag is walked. Anything else is replaced with the marker: its
 * data lives behind accessors or internal slots that a privacy boundary
 * cannot read without running the page's code, and a producer that meant to
 * report it should have summarised it (`AttributeValueSummary` in
 * `../schema/attributes.ts` exists for exactly that).
 *
 * Declared as a type predicate so the walk needs no cast at the one call site
 * that descends into a record: a plain bag *is* an index-signature object as
 * far as reading its own string keys goes, which is all the walk does with it.
 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Whether a value may pass through unexamined as a service-assigned scalar. */
function isTransportableScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Whether a masked header value is identical to what arrived, which decides
 * whether the attribute's path is reported as redacted.
 *
 * Compared structurally rather than by identity because `./headers.ts`
 * always returns a fresh array for the multi-value form.
 */
function sameHeaderValue(before: unknown, after: HeaderValue): boolean {
  if (typeof after === 'string') {
    return before === after;
  }
  if (!Array.isArray(before) || before.length !== after.length) {
    return false;
  }
  return after.every((element, index) => (before as readonly unknown[])[index] === element);
}

/** The record form of {@link sameHeaderValue}: same keys, same order, same values. */
function sameHeaderRecord(before: unknown, after: Record<string, HeaderValue>): boolean {
  if (!isRecordLike(before)) {
    return false;
  }
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (beforeKeys.length !== afterKeys.length) {
    return false;
  }
  for (let index = 0; index < afterKeys.length; index += 1) {
    const key = afterKeys[index];
    if (key === undefined || beforeKeys[index] !== key) {
      return false;
    }
    const masked = after[key];
    if (masked === undefined || !sameHeaderValue(before[key], masked)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether `key` names statement text: the catalog's key on any kind, or a
 * conventional spelling on a query-kind event.
 */
function isStatementKey(key: string, kind: TelemetryKind | undefined): boolean {
  if (key === DB_STATEMENT_KEY) {
    return true;
  }
  if (kind === undefined || !QUERY_KINDS.includes(kind)) {
    return false;
  }
  return STATEMENT_KEY_FOLDS.has(foldKey(key));
}

/**
 * Whether `key` opens a preview subtree on an event of this kind — see
 * {@link PREVIEW_FAMILIES}.
 */
function isPreviewFamilyKey(key: string, kind: TelemetryKind | undefined): boolean {
  for (const family of PREVIEW_FAMILIES) {
    if (!family.keys.has(key)) {
      continue;
    }
    return kind === undefined || family.kinds.includes(kind);
  }
  return false;
}

/**
 * Counts code points, which is the unit `truncate` bounds and therefore the
 * unit an input's own length has to be measured in before it can bound an
 * output. Cheaper than `Array.from(value).length`, which allocates one array
 * per call on a path that runs per event.
 */
function countCodePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      }
    }
    count += 1;
  }
  return count;
}

/*
 * ---------------------------------------------------------------------------
 * The dispatch table
 * ---------------------------------------------------------------------------
 */

/**
 * What the dispatcher decided about one value.
 *
 * `changed` means "the value at **this** path is not the value that arrived",
 * and is what makes the parent record the path. A container reports `false`
 * even when its contents were masked: its descendants record their own, more
 * precise paths, and repeating the container's path would only dilute the
 * record the developer reads.
 */
type ValueResult =
  | { readonly emit: false }
  | { readonly emit: true; readonly value: unknown; readonly changed: boolean };

/** The value is not emitted at all; the key disappears. */
const OMITTED: ValueResult = { emit: false };

/** Builds an emitting result. */
function emitted(value: unknown, changed: boolean): ValueResult {
  return { emit: true, value, changed };
}

/**
 * Redacts one attribute value, at any depth, applying the first handler that
 * claims its key and falling through to the generic value rules.
 *
 * The order is the privacy contract, and it is the reason the table is a
 * single function rather than a chain of maps:
 *
 * 1. **Dropped by policy** — a body, a row set or a parameter bag never
 *    travels ({@link DROPPED_ATTRIBUTE_KEYS}).
 * 2. **Header value** — masked positionally by `./headers.ts`, with the
 *    header's presence and multi-value count retained.
 * 3. **Header map** — masked field by field; a map that did not arrive as a
 *    record cannot be, so it is replaced whole.
 * 4. **URL** — query parameter values masked, path and authority kept
 *    (`./url.ts`).
 * 5. **Statement** — inline literals masked, placeholders and structure kept
 *    (`./sql.ts`). `db.rowCount` and `db.system` are not statements and take
 *    the generic path, which leaves them as they are: AAP 0.5.2 keeps the row
 *    *count* and never a row.
 * 6. **Preview subtree** — a React prop or hook-state summary, walked with
 *    the structural-field exemption of {@link CHANGED_PROP_NAME_FIELD}.
 * 7. **Generic** — a string is scrubbed then truncated (never the reverse:
 *    cutting first can split a credential so that no pattern matches it);
 *    a number or boolean under a key-like name is masked, because a short
 *    numeric secret is still a secret; `null` passes through; a value that
 *    cannot be transported is omitted; a container is walked within the
 *    bounds.
 *
 * Total by construction: every step runs inside one `try`, and a throwing
 * getter, an exotic host object or a hostile `Proxy` yields
 * {@link REDACTION_MARKER} for that one value while the rest of the batch
 * proceeds.
 */
function redactValue(
  key: string,
  value: unknown,
  path: string,
  depth: number,
  inPreview: boolean,
  state: WalkState,
): ValueResult {
  const { limits } = state;
  try {
    if (DROPPED_KEY_FOLDS.has(foldKey(key))) {
      return OMITTED;
    }

    if (isHeaderAttributeKey(key)) {
      const name = headerNameFromAttributeKey(key) ?? key;
      if (isDeniedHeaderName(name)) {
        state.matched.add('sensitive-header');
      }
      // `redactHeaderValue` is documented total for a value of any type; the
      // declared parameter type is the shape a well-behaved producer sends.
      const masked = redactHeaderValue(name, value as HeaderValue);
      const changed = !sameHeaderValue(value, masked);
      if (changed) {
        state.maskedValues += 1;
        classify(state, value, name);
      }
      return emitted(masked, changed);
    }

    if (isHeaderObjectAttributeKey(key)) {
      if (!isRecordLike(value)) {
        // A serialised header blob cannot be masked field by field, and the
        // content rules alone do not recognise a cookie or a session value.
        // Over-redaction is the safe direction for a header set.
        state.matched.add('sensitive-header');
        state.maskedValues += 1;
        classify(state, value, key);
        return emitted(REDACTION_MARKER, value !== REDACTION_MARKER);
      }
      const masked = redactHeaders(value as HeaderRecord);
      const changed = !sameHeaderRecord(value, masked);
      if (changed) {
        // Reported only when something was actually masked: a header set of
        // benign names is not a finding, and a second pass over an
        // already-masked set masks nothing.
        state.matched.add('sensitive-header');
        state.maskedValues += 1;
      }
      return emitted(masked, changed);
    }

    if (isUrlAttributeKey(key)) {
      const masked = redactUrl(value);
      const changed = masked !== value;
      if (changed) {
        state.maskedValues += 1;
        classify(state, value, key);
        if (asScannableText(value).includes('?')) {
          // Positional, so `findDeniedRules` cannot report it: a URL that
          // carried a query and came back different had its parameter values
          // masked by `./url.ts`.
          state.matched.add('url-query-value');
        }
      }
      return emitted(masked, changed);
    }

    if (isStatementKey(key, state.kind)) {
      const masked = redactSqlStatement(value);
      const changed = masked !== value;
      if (changed) {
        state.maskedValues += 1;
        classify(state, value, key);
      }
      return emitted(masked, changed);
    }

    // A preview key opens the subtree; the exemption applies to the fields
    // *inside* it, which is why the child flag is computed separately from
    // the one this value was reached under.
    const childPreview = inPreview || isPreviewFamilyKey(key, state.kind);

    // The one structural exemption: a changed-prop entry's `key` field holds
    // a prop *name*, and the name rule would replace every one of them.
    const applyNameRule = !(inPreview && key === CHANGED_PROP_NAME_FIELD);

    if (typeof value === 'string') {
      const scrubbed = applyNameRule ? scrubNamedValue(key, value) : scrub(value);
      const bounded = UNTRUNCATED_KEYS.has(key)
        ? scrubbed
        : truncate(scrubbed, limits.maxPreviewLength);
      if (scrubbed !== value) {
        state.maskedValues += 1;
        classify(state, value, key);
      }
      if (bounded !== scrubbed) {
        state.truncatedValues += 1;
      }
      return emitted(bounded, bounded !== value);
    }

    if (value === null) {
      // Nothing to hide: `null` is the absence of a value, and masking it
      // would turn an absence into a claim that something was removed.
      return emitted(null, false);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      if (applyNameRule && isSensitiveKeyName(key)) {
        state.maskedValues += 1;
        classify(state, value, key);
        return emitted(REDACTION_MARKER, true);
      }
      return emitted(value, false);
    }

    if (typeof value !== 'object') {
      // `undefined`, a function, a symbol or a `bigint`. None survives JSON
      // transport — the first two are rejected outright by the event schema's
      // attribute check — so the key is omitted, which keeps the emitted bag
      // parseable and says the truth: no value was captured here.
      return OMITTED;
    }

    if (applyNameRule && isSensitiveKeyName(key)) {
      // A structure under a key-like name never travels, whatever its shape:
      // `{ credentials: { … } }` is not made safe by being nested.
      state.maskedValues += 1;
      classify(state, value, key);
      return emitted(REDACTION_MARKER, true);
    }

    if (state.ancestors.has(value)) {
      // A cycle. Finite output, no stack overflow, and the marker records
      // that something was there.
      state.maskedValues += 1;
      return emitted(REDACTION_MARKER, true);
    }

    if (Array.isArray(value)) {
      if (depth >= limits.maxDepth) {
        return OMITTED;
      }
      state.ancestors.add(value);
      try {
        return emitted(redactArrayValue(value, path, depth, childPreview, state), false);
      } finally {
        state.ancestors.delete(value);
      }
    }

    if (!isPlainObject(value)) {
      // Tested before the depth bound: an exotic object is not walked at all,
      // so its depth is irrelevant, and the marker says more than an absent
      // key would about a value that was there but could not be read safely.
      state.maskedValues += 1;
      return emitted(REDACTION_MARKER, true);
    }

    if (depth >= limits.maxDepth) {
      return OMITTED;
    }

    state.ancestors.add(value);
    try {
      return emitted(redactRecordValue(value, path, depth, childPreview, state), false);
    } finally {
      state.ancestors.delete(value);
    }
  } catch {
    // Reading, iterating or comparing the value failed — a throwing getter or
    // a hostile `Proxy`. The value's presence is kept and its content is
    // reported as removed, and the rest of the batch is unaffected.
    state.maskedValues += 1;
    return emitted(REDACTION_MARKER, true);
  }
}

/**
 * Walks a record — the attribute bag itself at depth 0, or a nested object —
 * into a **new** object, preserving insertion order.
 *
 * Bounds, all silent by design (a synthetic marker key would invent a member
 * of the declared attribute vocabulary, which `../schema/attributes.ts` is
 * the only place allowed to do):
 *
 * - **Keys.** A nested object emits at most `maxTrackedKeys` keys, matching
 *   the bound a diff already obeys. The bag itself is exempt: its keys are the
 *   per-kind vocabulary plus whatever else a producer reported, and dropping
 *   the thirty-third would lose declared evidence.
 * - **Nodes.** No record emits a value once the total budget is spent.
 *
 * Only own, enumerable, string-keyed properties are read; a symbol-keyed
 * property is not attribute data. `Object.fromEntries` defines own data
 * properties, so a key literally named `__proto__` becomes a key of the
 * result instead of reassigning its prototype.
 */
function redactRecordValue(
  source: Record<string, unknown>,
  path: string,
  depth: number,
  inPreview: boolean,
  state: WalkState,
): Record<string, unknown> {
  let keys: readonly string[];
  try {
    keys = Object.keys(source);
  } catch {
    // An exotic object cannot be enumerated. Nothing is known about it, so
    // nothing is reported.
    return {};
  }

  const keyBudget = depth === 0 ? keys.length : state.limits.maxTrackedKeys;
  const entries: [string, unknown][] = [];

  for (const key of keys) {
    const childPath = joinKeyPath(path, key);

    if (entries.length >= keyBudget || state.nodes >= state.limits.maxNodes) {
      state.droppedKeys += 1;
      recordPath(state, childPath);
      continue;
    }

    // The node is reserved *before* the value is handled, which is what makes
    // the budget a hard bound: a container counted after its own children
    // would let each open container overshoot by one, and the total is what
    // decides the size of a stored row.
    state.nodes += 1;

    let value: unknown;
    try {
      value = source[key];
    } catch {
      state.maskedValues += 1;
      recordPath(state, childPath);
      entries.push([key, REDACTION_MARKER]);
      continue;
    }

    // `request_key` and every other service-assigned key passes through
    // untouched, and only at the top level of the bag, where the service
    // wrote it. This exemption is load-bearing: the name ends in "key" and
    // the value is 64 characters of high-entropy hex, so the name rule would
    // mask it and an entropy heuristic would agree — and
    // `../aggregate/requests.ts` groups duplicate requests by exactly that
    // value, so masking it would silently merge every request in the capture
    // into one group. It is computed before redaction from the *unredacted*
    // URL and is a keyed hash of the request's shape, never its data
    // (AAP 0.5.2). Only a transportable scalar is exempt, so a producer that
    // put a structure under the key still gets it redacted.
    if (depth === 0 && SERVICE_ASSIGNED_KEYS.has(key) && isTransportableScalar(value)) {
      entries.push([key, value]);
      continue;
    }

    const result = redactValue(key, value, childPath, depth + 1, inPreview, state);
    if (!result.emit) {
      state.droppedKeys += 1;
      recordPath(state, childPath);
      continue;
    }

    if (result.changed) {
      recordPath(state, childPath);
    }
    entries.push([key, result.value]);
  }

  return Object.fromEntries(entries);
}

/**
 * Walks an array into a **new** array, preserving element order.
 *
 * At most `maxTrackedKeys` elements are emitted — the same bound a nested
 * object gets, and the bound `../browser/fiber-diff.ts` already applies to a
 * diff's entry list — and the tail past the bound is omitted rather than
 * sampled, so the kept prefix's indices still mean what they did.
 *
 * An element that cannot travel (`undefined`, a function, a symbol, a
 * `bigint`, or a container past the depth bound) becomes
 * {@link REDACTION_MARKER} rather than disappearing: dropping it would shift
 * every later index, and an array's positions are part of what it says.
 */
function redactArrayValue(
  source: readonly unknown[],
  path: string,
  depth: number,
  inPreview: boolean,
  state: WalkState,
): unknown[] {
  const elementBudget = state.limits.maxTrackedKeys;
  const output: unknown[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const childPath = joinIndexPath(path, index);

    if (output.length >= elementBudget || state.nodes >= state.limits.maxNodes) {
      state.droppedKeys += 1;
      recordPath(state, childPath);
      continue;
    }

    // Reserved before the element is handled, for the reason given in
    // `redactRecordValue`.
    state.nodes += 1;

    let element: unknown;
    try {
      element = source[index];
    } catch {
      state.maskedValues += 1;
      recordPath(state, childPath);
      output.push(REDACTION_MARKER);
      continue;
    }

    const result = redactValue(ARRAY_ELEMENT_KEY, element, childPath, depth + 1, inPreview, state);

    if (!result.emit) {
      state.maskedValues += 1;
      recordPath(state, childPath);
      output.push(REDACTION_MARKER);
      continue;
    }

    if (result.changed) {
      recordPath(state, childPath);
    }
    output.push(result.value);
  }

  return output;
}

/*
 * ---------------------------------------------------------------------------
 * Public entry points
 * ---------------------------------------------------------------------------
 */

/**
 * The full result of one walk.
 *
 * The state travels with it rather than a finished report, because an event's
 * `name` is redacted outside the walk and its findings belong in the same
 * report; {@link buildReport} is therefore called once, after everything the
 * event contributes has been recorded.
 *
 * `state.paths` stays internal to this module: it feeds the event's
 * `redacted` field and is deliberately **not** part of
 * {@link RedactionReport}, which is loggable, because a path is built from
 * page-supplied key names.
 */
interface AttributeWalk {
  readonly attributes: Record<string, unknown>;
  readonly state: WalkState;
}

/** Assembles the loggable report from a finished walk. */
function buildReport(state: WalkState): RedactionReport {
  return {
    rules: REDACTION_RULE_IDS.filter((rule) => state.matched.has(rule)),
    droppedKeys: state.droppedKeys,
    truncatedValues: state.truncatedValues,
    maskedValues: state.maskedValues,
  };
}

/** Runs one walk over an attribute bag and assembles its report. */
function walkAttributes(
  attributes: Readonly<Record<string, unknown>>,
  context: RedactionContext | undefined,
  options: RedactionOptions | undefined,
): AttributeWalk {
  const limits = resolveLimits(options);
  const state: WalkState = {
    limits,
    kind: context?.kind,
    ancestors: new WeakSet<object>(),
    matched: new Set<RedactionRuleId>(),
    paths: [],
    recorded: new Set<string>(),
    nodes: 0,
    droppedKeys: 0,
    truncatedValues: 0,
    maskedValues: 0,
  };

  // Typed as a record, but this is the ingest path: a bag that is not a record
  // yields an empty one rather than an exception. The bag joins the ancestor
  // set like any other container, so a bag that references itself is caught on
  // its first repeat rather than walked twice.
  let redacted: Record<string, unknown> = {};
  if (isRecordLike(attributes)) {
    state.ancestors.add(attributes);
    redacted = redactRecordValue(attributes, '', 0, false, state);
    state.ancestors.delete(attributes);
  }

  return { attributes: redacted, state };
}

/**
 * Redacts an attribute bag and reports what was removed.
 *
 * The bag is walked into a **new** object; the input and every structure
 * inside it are left untouched and are never shared into the result. See
 * {@link redactValue} for the dispatch order, and the module documentation
 * for the totality, idempotence and determinism guarantees — all of which
 * hold for this function, since it is the whole of the attribute path.
 *
 * Two behaviours are worth stating at this level because they are what a
 * caller is most likely to get wrong:
 *
 * - **`request_key` survives unchanged**, along with every other key in
 *   `SERVICE_ASSIGNED_ATTRIBUTE_KEYS`, and only at the top level of the bag.
 *   Duplicate-request analysis depends on it (see {@link redactRecordValue}).
 * - **Nothing is added.** A bound reached means the remainder is omitted
 *   silently; there is no synthetic key announcing it. The counts in the
 *   report say how much went, and the event's `redacted` paths say which.
 *
 * @param attributes - Attribute bag as captured. Never modified.
 * @param context - What is known about the owning event; only `kind` is read.
 * @param options - Bound overrides; every default is the declared one.
 */
export function redactAttributesWithFindings(
  attributes: Readonly<Record<string, unknown>>,
  context?: RedactionContext,
  options?: RedactionOptions,
): { attributes: Record<string, unknown>; report: RedactionReport } {
  const walk = walkAttributes(attributes, context, options);
  return { attributes: walk.attributes, report: buildReport(walk.state) };
}

/**
 * Redacts an attribute bag, discarding the findings report.
 *
 * The thin wrapper over {@link redactAttributesWithFindings} for callers that
 * only need the bag — the aggregate and panel-data paths, and every test that
 * asserts on the emitted values rather than on the counts.
 *
 * @param attributes - Attribute bag as captured. Never modified.
 * @param context - What is known about the owning event; only `kind` is read.
 * @param options - Bound overrides; every default is the declared one.
 */
export function redactAttributes(
  attributes: Readonly<Record<string, unknown>>,
  context?: RedactionContext,
  options?: RedactionOptions,
): Record<string, unknown> {
  return walkAttributes(attributes, context, options).attributes;
}

/** The substring that makes a span name carry a URL rather than merely mention a path. */
const AUTHORITY_MARKER = '://';

/**
 * Redacts a span name.
 *
 * A name is a label a developer reads — `'click button'`, `'POST /api/x'`,
 * `'fetch GET http://localhost:3000/api/x?token=…'` — so the method, the
 * route and the framework's own wording all survive. Two rules apply:
 *
 * - **Always scrubbed** by content, so a credential pasted into a name by a
 *   producer or by the page goes.
 * - **Masked as a URL** when the event is a request (`REQUEST_KINDS`, asked
 *   of `../schema/kinds.ts` as group membership rather than compared against
 *   a literal) or when the name carries a `scheme://authority` marker, which
 *   is how an outgoing server-side request span names its target. Query
 *   parameter values and userinfo therefore go while the scheme, host and
 *   path stay. A name with no such marker — a statement-shaped database span
 *   name, say — is left to the content rules, so `?` placeholders in it are
 *   not reinterpreted as a query string.
 *
 * **Never longer than what arrived.** Scrubbing can lengthen a value — a
 * database URL's short userinfo becomes the marker, which is longer than the
 * credential it replaced, keeping the `@` and the host — and the event schema
 * bounds the name, so the result is cut back to the arriving name's own
 * code-point count — with a floor of the marker's length, so a short name
 * whose whole content was a credential still reads `[redacted]`. Bounding by
 * code points is what makes the emitted UTF-16 length fit too: scrubbing only
 * ever deletes text or inserts ASCII, so the output's non-ASCII content is a
 * subset of the input's.
 *
 * **Idempotent**, and never empty: a name that scrubs away entirely becomes
 * the marker, since the schema requires a non-empty name.
 *
 * @param kind - The event's kind, which decides whether URL masking applies.
 * @param name - The span name as captured.
 */
export function redactEventName(kind: TelemetryKind, name: string): string {
  const scrubbed = scrub(name);
  const masked =
    REQUEST_KINDS.includes(kind) || scrubbed.includes(AUTHORITY_MARKER)
      ? redactUrl(scrubbed)
      : scrubbed;

  if (masked === name) {
    // The common case by far, and the one that must cost nothing: no
    // code-point count, no allocation.
    return name;
  }

  const bounded = truncate(masked, Math.max(countCodePoints(name), REDACTION_MARKER.length));
  return bounded.length > 0 ? bounded : REDACTION_MARKER;
}

/**
 * Merges the `redacted` paths an event already carried with the ones this
 * pass found.
 *
 * Merging rather than replacing is what makes {@link redactEvent} idempotent:
 * a second pass finds nothing new (every emitted value is a fixed point of
 * its own treatment), so recomputing the list would empty it and the two
 * results would differ. Inherited entries are normalised by the same function
 * that produced the new ones — an already-normalised path normalises to
 * itself — which also means a producer that invented a path cannot smuggle
 * content through the field.
 */
function mergeRedactedPaths(
  inherited: readonly unknown[] | undefined,
  found: readonly string[],
  limits: ResolvedLimits,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const source of [inherited ?? [], found]) {
    for (const candidate of source) {
      if (merged.length >= limits.maxNodes) {
        return merged;
      }
      const normalised = normalizePath(candidate, limits);
      if (seen.has(normalised)) {
        continue;
      }
      seen.add(normalised);
      merged.push(normalised);
    }
  }

  return merged;
}

/**
 * Redacts a whole event and reports what was removed.
 *
 * Everything the returned event carries beyond `name`, `attributes` and
 * `redacted` is the value that arrived: `id`, `traceId`, `spanId`,
 * `parentSpanId`, `kind`, `startTime`, `duration`, `tier`, `status`,
 * `producerId`, `seq`, `source`, and on a persisted event `sessionId`,
 * `captureId` and `ingestSeq`. No key is added and none is removed, because
 * both event schemas are strict and a redacted event is re-parsed downstream.
 *
 * `source` is untouched by design: a `SourceLocation` is a project-relative
 * path, a line and a column, validated by
 * `packages/shared/src/source-location.ts`, and carries no runtime data.
 *
 * `redacted` lists **attribute** paths only, which is what
 * `../schema/event.ts` declares it to be. A `name` the URL or content rules
 * changed is therefore not recorded there: it has no attribute path, and
 * inventing one (`'name'`) would collide with an attribute a producer may
 * legitimately call `name`. The report covers it instead: a redacted name
 * counts as one masked value and contributes its matched rules.
 *
 * The event itself is expected to have been validated already — ingest parses
 * it with `../schema/event.ts` first — but its attribute *values* are not,
 * and cannot be: that schema's check is deliberately shallow and cycle-safe,
 * which is precisely why the walk here is defensive at every step.
 *
 * @param event - Event as its producer sent it, or as the store holds it.
 * Never modified.
 * @param options - Bound overrides; every default is the declared one.
 * @returns The redacted event, and the loggable report of what was removed.
 */
export function redactEventWithFindings<T extends TelemetryEventIngress | TelemetryEvent>(
  event: T,
  options?: RedactionOptions,
): { event: T; report: RedactionReport } {
  const limits = resolveLimits(options);
  const walk = walkAttributes(event.attributes, { kind: event.kind }, options);
  const paths = mergeRedactedPaths(event.redacted, walk.state.paths, limits);

  const name = redactEventName(event.kind, event.name);
  if (name !== event.name) {
    // The name is part of the event, so its findings belong in the event's
    // report: one masked value, plus whichever content rules matched it. Its
    // own length bound is not counted as a truncation — a name is a label,
    // not a preview of captured data.
    walk.state.maskedValues += 1;
    classify(walk.state, event.name, '');
  }

  const base = { ...event, name, attributes: walk.attributes };

  // `redacted` is attached conditionally so that an untouched event does not
  // gain the key: an explicit `undefined` would survive into the store's JSON
  // as a present field, and both event schemas are strict about the key set.
  const next: T = paths.length > 0 ? { ...base, redacted: paths } : base;

  return { event: next, report: buildReport(walk.state) };
}

/**
 * Redacts a whole event: the first checkpoint of the privacy boundary
 * (AAP 0.5.2).
 *
 * The function `apps/local-service/src/telemetry/ingest.ts` calls on every
 * validated event before it is persisted or broadcast, and the one every
 * other consumer of an event is entitled to assume has already run. See
 * {@link redactEventWithFindings} for what is preserved and
 * {@link redactValue} for the dispatch order; the module documentation states
 * the guarantees.
 *
 * @param event - Event as its producer sent it, or as the store holds it.
 * Never modified.
 * @param options - Bound overrides; every default is the declared one.
 * @returns A new event of the same shape, safe to store, broadcast and
 * summarise.
 */
export function redactEvent<T extends TelemetryEventIngress | TelemetryEvent>(
  event: T,
  options?: RedactionOptions,
): T {
  return redactEventWithFindings(event, options).event;
}
