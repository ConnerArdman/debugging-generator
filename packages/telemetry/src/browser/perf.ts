/**
 * The performance timeline: the evidence the platform has already collected.
 *
 * AAP 0.5.1 makes one principle first among the instrumentation choices —
 * prefer an existing browser or runtime API, and modify a file only where no
 * hook can supply the signal — and this module is the plainest expression of
 * it. Long tasks, resource timings, the document's navigation timing and the
 * paint marks are all measured by the browser whether the agent is armed or
 * not; reading them costs the developer's page one `PerformanceObserver` per
 * entry type and changes nothing about how their application runs.
 *
 * ## What it produces, and who reads it
 *
 * Four entry types map to three event kinds:
 *
 * - **`longtask` → `perf.longtask`.** "The click was slow because the main
 *   thread was blocked." A long task that lands inside an interaction window
 *   nests under the interaction span, which is what puts the blockage on the
 *   same timeline as the gesture that waited for it. Its `blockingTime`
 *   attribute is the sole input to the `blocking_time` metric, and the events
 *   themselves are what `long_task_count` counts.
 * - **`resource` → `perf.entry`.** The only place a transferred size is
 *   observable at all (AAP 0.6.6), and the timing a request row is enriched
 *   with.
 * - **`navigation` → `navigation`.** Whether the capture spans a reload, and
 *   the document milestones the timeline marks.
 * - **`paint` → `perf.entry`.** First paint and first contentful paint, as
 *   instants rather than intervals.
 *
 * `../aggregate/summary.ts` computes `blocking_time`, `long_task_count` and
 * `transferred_bytes` from these events and `../aggregate/requests.ts` joins a
 * resource entry to the `fetch` span that caused it, so the correctness of
 * this module is visible on a generated panel rather than internal: a metric
 * card reading `n/a` next to a number the capture did record is the failure
 * mode, and it is produced by a misspelled attribute key or a normalised URL,
 * not by anything louder.
 *
 * ## The two decisions worth reading before changing anything
 *
 * **One observer per entry type, with `buffered: true`.** The Performance
 * Timeline specification forbids combining `entryTypes` with `buffered`, and
 * the buffered flag is exactly what this module needs: a capture is armed when
 * the developer asks a question, which is long after the document loaded, and
 * without buffering the navigation and paint entries — already in the
 * performance buffer, never to be delivered again — would be invisible for
 * every capture that did not happen to start during page load. So four
 * observers it is, each created and started inside its own `try`/`catch`
 * because `observe({ type })` throws a `TypeError` for a type the host does
 * not support (`longtask` is not universally available). A type that throws
 * is recorded in {@link getPerfStats}'s `unavailable` list rather than being
 * allowed to abort the other three, which is what AAP 0.5.5 asks of an
 * unavailable signal: reported, not silently missing.
 *
 * **Buffered entries become roots of their own traces, deliberately.** Every
 * event asks `./interaction.js` which trace it belongs to, and that module
 * answers with the interaction window that is open *at the moment of the
 * call*. When a capture starts, the buffered navigation and paint entries
 * arrive with no interaction open and so become synthetic roots — which is
 * the honest answer, because page-load timing is a fact about the document
 * and not about a click. Forcing them onto whatever interaction happens to be
 * in flight would claim a causal link the capture never observed. For the
 * same reason the resolution is asked with no timestamp argument: the
 * interaction lookup uses the value it is given for its own lifetime valve
 * rather than as a "was a window open then?" query, so handing it a buffered
 * entry's minutes-old `startTime` would both misattribute the entry and
 * suppress the valve that closes a starved window.
 *
 * ## Faithful numbers, or none
 *
 * A resource entry reports `transferSize`, `encodedBodySize` and
 * `decodedBodySize` as `0` for a cross-origin response served without
 * `Timing-Allow-Origin`, and older hosts omit some of the fields entirely.
 * Both are read defensively and reported as they stand: a zero is emitted as a
 * zero and an absent field is left absent, so that `transferred_bytes` can
 * report `n/a` where the browser measured nothing (AAP 0.6.6) instead of
 * presenting an invented number as evidence. Nothing here substitutes a
 * plausible value for a missing one, and no non-finite number is ever put on
 * an event: JSON has no spelling for `NaN` or `Infinity`, and the event
 * contract in `../schema/event.ts` bounds the numeric fields that matter.
 *
 * The resource and navigation URLs are emitted **raw and unredacted**. That is
 * the contract, not an oversight: the service redacts at ingest
 * (`../redaction/redactor.ts`) and needs the unredacted form to compute
 * `request_key` and to join a resource entry to its request (AAP 0.5.2,
 * 0.4.2). Normalising, trimming or truncating a URL here would break the join
 * and the duplicate-request grouping built on it.
 *
 * ## Nothing here throws, and nothing survives a detach
 *
 * Observer callbacks run on the page's own task queue, so every body in this
 * file sits inside a `try`/`catch`: a malformed entry costs itself and is
 * counted in {@link getPerfStats}'s `failures`, never the batch it arrived in
 * and never the developer's application. {@link attachPerf} is idempotent and
 * {@link detachPerf} disconnects every observer and clears every counter,
 * because AAP 0.5.1 requires a cleared hook to be disabled rather than idled —
 * afterwards this module holds no observer, no count and no observation of the
 * developer's page, and a buffered flush that was already queued emits
 * nothing.
 *
 * Nothing observable happens at import time: the module's bindings are
 * declared, and the first observer is created only when {@link attachPerf}
 * runs. Module scope is one page document, the same scope `./ids.ts` memoizes
 * its producer id in and `./transport.ts` numbers its sequence in.
 *
 * ## Imports are a constraint, not a coincidence
 *
 * `packages/telemetry/esbuild.agent.mjs` bundles this file into the IIFE
 * injected into the developer's page at `document_start` and hard-fails on any
 * input resolving to a Node builtin, `@debuggen/protocol`,
 * `@debuggen/shared/node` or `zod`. The four imports below are therefore the
 * whole list: ids and transport for minting and emitting, interaction for the
 * trace decision, and the two dependency-free schema vocabularies for the
 * kind spellings and the attribute keys. `./fetch.ts` is deliberately **not**
 * among them even though a resource entry describes the same request a `fetch`
 * span does — the two modules stay independent and the join happens
 * server-side in the aggregate, where both halves of the evidence are already
 * stored.
 *
 * @see ./interaction.ts for the trace and parent every event here adopts.
 * @see ../schema/attributes.ts for the `perf.entry`, `perf.longtask` and
 * `navigation` attribute vocabularies.
 */

import { newSpanId } from './ids.js';
import { resolveEventContext, type EventContext } from './interaction.js';
import { emit, toEpochMs, type EventDraft } from './transport.js';
import {
  MAX_PREVIEW_LENGTH,
  type NAVIGATION_ATTRIBUTE_KEYS,
  type PERF_ENTRY_ATTRIBUTE_KEYS,
  type PERF_LONGTASK_ATTRIBUTE_KEYS,
} from '../schema/attributes.js';
import type { TelemetryKind } from '../schema/kinds.js';

/*
 * ---------------------------------------------------------------------------
 * Contract constants
 *
 * Exported because each one is part of a contract a consumer or a test reasons
 * about — which entry types the agent claims to cover, what `blockingTime`
 * means, and how much one capture may report — rather than a tuning knob.
 * ---------------------------------------------------------------------------
 */

/**
 * The entry types this module observes, in the order the observers are
 * created.
 *
 * The list is the module's claim about what the agent covers, and
 * {@link getPerfStats} reports one emitted count per member plus the members
 * the host refused, so a reader can tell "no long tasks happened" from "this
 * host has no long-task timing".
 *
 * Kept to the four types AAP 0.5.1 names for the runtime path. `mark` and
 * `measure` are deliberately absent: they are the application's own
 * annotations, a page that uses them heavily would flood a capture with events
 * the pipeline cannot interpret, and `event` timing belongs to
 * `./interaction.js`, which owns the interaction window and must not have a
 * second observer competing for the same entries.
 */
export const OBSERVED_ENTRY_TYPES = ['longtask', 'resource', 'navigation', 'paint'] as const;

/**
 * The long-task threshold, in milliseconds: the portion of a task's duration
 * that is *not* counted as blocking.
 *
 * Fixed at 50 by the Long Tasks specification — a task is reported only once
 * it exceeds this length — so `duration - LONG_TASK_THRESHOLD_MS` is the
 * excess over the budget, which is the definition the `blocking_time` metric
 * of AAP 0.2.3 sums (`../schema/attributes.ts` states the same contract on
 * that metric id). Written here once and read everywhere else, so the metric
 * and the attribute can never drift apart.
 */
export const LONG_TASK_THRESHOLD_MS = 50;

/**
 * The most events of any one entry type this module emits per capture.
 *
 * A media-heavy page produces hundreds of resource entries before the
 * developer has clicked anything, and a render storm can produce long tasks
 * for as long as it lasts. The bound is per type rather than shared, so a
 * flood of resources cannot starve the long tasks that answer the developer's
 * question. Entries past the bound are counted in {@link getPerfStats}'s
 * `dropped` — reported, not hidden, exactly as `./transport.ts` reports its
 * own queue losses — and the count restarts with each {@link attachPerf}, so
 * the bound is per capture and not per document.
 */
export const MAX_ENTRIES_PER_TYPE = 1000;

/**
 * The most attribution records carried on one `perf.longtask` event.
 *
 * A long task's attribution list names the container (the document, or an
 * iframe) the task was charged to. Hosts report one entry in practice and the
 * specification permits more; three is enough to see a pattern and few enough
 * that the attribute cannot become the largest thing on the event.
 */
export const MAX_ATTRIBUTION_ENTRIES = 3;

/**
 * The longest string this module writes into an attribute value, in code
 * points.
 *
 * Borrowed from `../schema/attributes.ts` rather than restated: it is the same
 * bound every summarised value in the agent obeys (AAP 0.5.2), and applying it
 * to an attribution container's name and source keeps an event small without
 * costing a reader the ability to recognise what the string names.
 *
 * Deliberately **not** applied to a resource or navigation URL — see the
 * module documentation: the raw URL is the join key, and a truncated one joins
 * to nothing.
 */
const MAX_ATTRIBUTE_STRING_LENGTH = MAX_PREVIEW_LENGTH;

/**
 * The longest `name` this module writes on an event, in code points.
 *
 * Every name it writes is a short platform token — `self`, `resource`,
 * `navigation`, `first-contentful-paint` — so the bound exists only to keep a
 * hostile or shimmed host from producing a name the event schema would reject
 * (`../schema/event.ts` caps the field, and an event rejected at ingest is an
 * observation lost for no gain).
 */
const MAX_EVENT_NAME_LENGTH = 128;

/*
 * ---------------------------------------------------------------------------
 * Kinds
 *
 * Typed as {@link TelemetryKind} rather than left as bare string literals, so
 * every spelling is checked against `../schema/kinds.ts`'s closed vocabulary
 * at compile time. All three are declared there as browser-tier kinds, which
 * is what the event schema's kind/tier agreement check requires of a producer
 * on this tier.
 * ---------------------------------------------------------------------------
 */

/** A `longtask` entry: the main thread was blocked for longer than the budget. */
const LONGTASK_KIND: TelemetryKind = 'perf.longtask';

/** A captured `PerformanceEntry` that is not a navigation: resource, paint. */
const PERF_ENTRY_KIND: TelemetryKind = 'perf.entry';

/** The document's `PerformanceNavigationTiming` entry. */
const NAVIGATION_KIND: TelemetryKind = 'navigation';

/** The `status` every event here carries: an observation, never a failure. */
const OBSERVED_STATUS = 'ok' as const;

/*
 * ---------------------------------------------------------------------------
 * Attribute keys
 *
 * Every key this module writes, bound to `../schema/attributes.ts` where that
 * module declares an equivalent. The declared ones are typed as members of the
 * relevant tuple, so renaming or dropping one there fails compilation here
 * rather than silently producing an event whose attributes no consumer reads;
 * the invented ones are typed as plain strings and each documents what
 * `attributes.ts` should adopt.
 *
 * Where the declared spelling differs from the platform's property name, the
 * declared spelling wins: the vocabulary is what the redactor, the aggregates
 * and the panel renderer agree on, and a producer that wrote `initiatorType`
 * instead of `initiator.type` would emit an attribute nothing reads.
 * ---------------------------------------------------------------------------
 */

/** One member of `PERF_ENTRY_ATTRIBUTE_KEYS`, the `perf.entry` vocabulary. */
type DeclaredPerfEntryKey = (typeof PERF_ENTRY_ATTRIBUTE_KEYS)[number];

/** One member of `PERF_LONGTASK_ATTRIBUTE_KEYS`, the `perf.longtask` vocabulary. */
type DeclaredLongTaskKey = (typeof PERF_LONGTASK_ATTRIBUTE_KEYS)[number];

/** One member of `NAVIGATION_ATTRIBUTE_KEYS`, the `navigation` vocabulary. */
type DeclaredNavigationKey = (typeof NAVIGATION_ATTRIBUTE_KEYS)[number];

/**
 * Which `PerformanceEntry` type this `perf.entry` event describes — `resource`
 * or `paint`.
 *
 * Declared, and load-bearing: `perf.entry` covers more than one entry type, so
 * a consumer reads this key instead of inferring the shape from which other
 * attributes happen to be present.
 */
const KEY_ENTRY_TYPE: DeclaredPerfEntryKey = 'entry.type';

/** The resource's or document's URL, raw and unredacted; see the module note. */
const KEY_URL: DeclaredPerfEntryKey & DeclaredNavigationKey = 'url';

/** What initiated the resource load: `script`, `link`, `fetch`, `xmlhttprequest`, … */
const KEY_INITIATOR_TYPE: DeclaredPerfEntryKey = 'initiator.type';

/** Bytes over the wire, including headers; `0` when the host will not say. */
const KEY_TRANSFER_SIZE: DeclaredPerfEntryKey & DeclaredNavigationKey = 'transferSize';

/** Payload bytes before content decoding. */
const KEY_ENCODED_BODY_SIZE: DeclaredPerfEntryKey = 'encodedBodySize';

/** Payload bytes after content decoding. */
const KEY_DECODED_BODY_SIZE: DeclaredPerfEntryKey = 'decodedBodySize';

/** Whether the resource blocked rendering: `blocking` or `non-blocking`. */
const KEY_RENDER_BLOCKING_STATUS: DeclaredPerfEntryKey = 'renderBlockingStatus';

/** The excess of a long task's duration over {@link LONG_TASK_THRESHOLD_MS}. */
const KEY_BLOCKING_TIME: DeclaredLongTaskKey = 'blockingTime';

/** The long task's reduced attribution records; see {@link LongTaskAttribution}. */
const KEY_ATTRIBUTION: DeclaredLongTaskKey = 'attribution';

/** How the document was reached: `navigate`, `reload` or `back_forward`. */
const KEY_NAVIGATION_TYPE: DeclaredNavigationKey = 'navigation.type';

/**
 * `PerformanceNavigationTiming.domContentLoadedEventEnd`, in milliseconds
 * relative to the document's time origin.
 *
 * The declared spelling is the shorter `domContentLoaded`; the platform's
 * property name is the longer one. The value is the platform's.
 */
const KEY_DOM_CONTENT_LOADED: DeclaredNavigationKey = 'domContentLoaded';

/** `PerformanceNavigationTiming.loadEventEnd`, relative to the time origin. */
const KEY_LOAD_EVENT_END: DeclaredNavigationKey = 'loadEventEnd';

/**
 * The protocol the resource was fetched over, as an ALPN identifier (`h2`,
 * `http/1.1`).
 *
 * **Invented here.** `PERF_ENTRY_ATTRIBUTE_KEYS` declares the size and
 * initiator fields of resource timing but not this one, and it is the field
 * that separates "the server was slow" from "the connection was" on a
 * waterfall row. Absent on hosts that do not expose it and for cross-origin
 * responses without `Timing-Allow-Origin`, where it reads as the empty string
 * and is therefore omitted. `../schema/attributes.ts` should adopt this
 * spelling — the platform's own property name — in the `perf.entry` tuple.
 */
const KEY_NEXT_HOP_PROTOCOL = 'nextHopProtocol';

/**
 * The HTTP status code the resource fetch returned.
 *
 * **Invented here.** The declared tuple has no equivalent, and a status is
 * what tells a failed subresource apart from a slow one — the `fetch`
 * vocabulary spells the same value `http.status_code`, which is deliberately
 * *not* reused: that key belongs to a request span, and a resource entry is a
 * separate observation of the same exchange that a consumer must be able to
 * tell apart. Reported as `0` for an opaque cross-origin response, which is
 * indistinguishable from "not exposed", so the key is written only when the
 * host reported a real status. `../schema/attributes.ts` should adopt it in
 * the `perf.entry` tuple.
 */
const KEY_RESPONSE_STATUS = 'responseStatus';

/**
 * `PerformanceNavigationTiming.responseEnd`: when the document's own response
 * finished arriving, relative to the time origin.
 *
 * **Invented here.** `NAVIGATION_ATTRIBUTE_KEYS` declares the two DOM
 * milestones but not the network one, and the split between them is what says
 * whether a slow load was spent waiting for the server or executing on the
 * client. `../schema/attributes.ts` should adopt this spelling in the
 * `navigation` tuple.
 */
const KEY_RESPONSE_END = 'responseEnd';

/**
 * The navigation entry's own `duration`, restated as an attribute.
 *
 * **Invented here.** It duplicates the event's `duration` field on purpose:
 * the navigation entry's duration *is* the document's total load time, and the
 * event-detail view reads one attribute bag, so a reader comparing the
 * milestones against the total does not have to reach outside it. Nothing
 * computes a metric from this key — `total_duration` is derived from trace
 * spans — so the duplication cannot disagree with anything.
 * `../schema/attributes.ts` should adopt this spelling in the `navigation`
 * tuple.
 */
const KEY_DURATION = 'duration';

/*
 * ---------------------------------------------------------------------------
 * Types
 *
 * Three of the shapes below describe host objects TypeScript 6.0.3's
 * `lib.dom.d.ts` does not declare (the Long Tasks API in full, and resource
 * timing's `renderBlockingStatus`). They are declared structurally, with
 * `unknown`-typed members, and read through the guards further down rather
 * than through casts that would assert a field is present: an entry arriving
 * from a host that predates the field, or from a stub in a test, must produce
 * an event without it rather than an event carrying `undefined`.
 * ---------------------------------------------------------------------------
 */

/** One member of {@link OBSERVED_ENTRY_TYPES}. */
export type ObservedEntryType = (typeof OBSERVED_ENTRY_TYPES)[number];

/**
 * A long task's attribution as this module emits it: a plain object with the
 * four container fields, and nothing else.
 *
 * Reducing the host's `TaskAttributionTiming` to a plain object is required
 * rather than tidy. `./transport.ts` sanitizes attribute values for structured
 * cloning and replaces any value whose meaning lives in its prototype with a
 * type tag, so a `TaskAttributionTiming` handed over as it stands would reach
 * the service as the string `[object]`. Each field is optional and omitted
 * when the host reported an empty string, which is what it reports for a task
 * charged to the top-level document.
 */
export interface LongTaskAttribution {
  /** What kind of container the task was charged to: `iframe`, `embed`, `object`. */
  containerType?: string | undefined;
  /** The container element's `name` attribute. */
  containerName?: string | undefined;
  /** The container element's `id` attribute. */
  containerId?: string | undefined;
  /** The container element's `src` attribute. */
  containerSrc?: string | undefined;
}

/**
 * A read-only picture of what this module has observed and what it could not.
 *
 * For `./agent.ts`'s readiness and status frames, and for the tests. The shape
 * is deliberately cheap to produce and honest about the three different ways a
 * signal can come up short:
 *
 * - **`unavailable`** — the host refused the entry type, so nothing of that
 *   kind will ever arrive. This is the list AAP 0.5.5 expects a capture to
 *   report, so that "no long tasks" is never confused with "no long-task
 *   timing".
 * - **`dropped`** — real entries this module declined to emit because the
 *   per-type bound of {@link MAX_ENTRIES_PER_TYPE} was reached.
 * - **`failures`** — entries, or whole delivered batches, that could not be
 *   read at all.
 *
 * Every field describes the current attachment: {@link attachPerf} resets them
 * and {@link detachPerf} clears them, so the numbers are per capture rather
 * than per document.
 */
export interface PerfStats {
  /**
   * How many events this module emitted per entry type, keyed by the members
   * of {@link OBSERVED_ENTRY_TYPES} and always carrying all four keys.
   *
   * Counts what was handed to `./transport.ts`, which is the only thing this
   * module can know: the transport drops events outside a capture window and
   * reports that loss in its own statistics.
   */
  emitted: Record<string, number>;
  /** Entries declined because the per-type bound was reached. */
  dropped: number;
  /** The entry types the host refused, in {@link OBSERVED_ENTRY_TYPES} order. */
  unavailable: string[];
  /** Entries or batches that could not be read; each costs itself and nothing more. */
  failures: number;
}

/*
 * ---------------------------------------------------------------------------
 * Module state
 *
 * One page document's worth, and nothing observable until a function below
 * runs. A reload gives a new document, a new producer id in `./ids.ts` and a
 * fresh sequence in `./transport.ts`, so a fresh set of these bindings is
 * exactly the right scope.
 * ---------------------------------------------------------------------------
 */

/** Whether {@link attachPerf} has started at least one observer. */
let attached = false;

/**
 * The started observers, held so {@link detachPerf} can disconnect every one
 * of them.
 *
 * Only observers that actually started are in the list: a type the host
 * refused leaves nothing to release and appears in {@link unavailableTypes}
 * instead.
 */
const observers: PerformanceObserver[] = [];

/** Emitted counts per entry type; see {@link PerfStats.emitted}. */
let emittedCounts = freshCounts();

/** Entries declined because a per-type bound was reached. */
let droppedCount = 0;

/** Entries or batches that could not be read. */
let failureCount = 0;

/** The entry types this host refused, in {@link OBSERVED_ENTRY_TYPES} order. */
let unavailableTypes: ObservedEntryType[] = [];

/**
 * A zero count for every observed entry type.
 *
 * Written out rather than derived from {@link OBSERVED_ENTRY_TYPES} so the
 * compiler checks the record is total: adding a member to that tuple without
 * adding a counter here is an error, not a silently missing count. Totality is
 * also what lets every read below index the record without a fallback under
 * `noUncheckedIndexedAccess`.
 */
function freshCounts(): Record<ObservedEntryType, number> {
  return { longtask: 0, resource: 0, navigation: 0, paint: 0 };
}

/*
 * ---------------------------------------------------------------------------
 * Defensive reads
 *
 * Every value below comes from a host object. The guards are not ceremony:
 * cross-origin resource entries report zeros, hosts that predate a field omit
 * it entirely, and the entries a test replays are plain objects with whatever
 * the test chose to put on them. A number that is not finite must never reach
 * an event — JSON cannot spell it and the ingress schema bounds the numeric
 * fields — so the rule throughout is "a readable value or no key at all".
 * ---------------------------------------------------------------------------
 */

/**
 * Read a numeric field, accepting only a finite, non-negative value.
 *
 * Non-negative because every field this module reads is a duration, an instant
 * relative to the time origin or a byte count, and a negative one of those is
 * a host defect rather than a measurement. `0` is a legitimate reading and is
 * returned as such: it is what a cross-origin response reports for
 * `transferSize` and what a still-loading document reports for
 * `loadEventEnd`, and AAP 0.6.6 requires those to travel as measured rather
 * than as an invented substitute.
 *
 * @param value The field as the host left it.
 * @returns The value, or `undefined` when it cannot be used.
 */
function measurement(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Read a string field, accepting only a non-empty one and bounding its length.
 *
 * The empty string is how resource timing reports a field it will not expose
 * (`nextHopProtocol` on an opaque cross-origin response) and how a long task's
 * attribution reports a container that is the top-level document, so an empty
 * reading means "no value" rather than "a value that is empty".
 *
 * Bounded by code point through the spread, so a surrogate pair is never split
 * in half — the same counting `../redaction/rules.ts` applies to the previews
 * it produces.
 *
 * @param value The field as the host left it.
 * @param limit The longest result, in code points.
 * @returns The bounded string, or `undefined` when there is nothing to report.
 */
function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  const points = [...value];
  if (points.length <= limit) {
    return value;
  }
  return points.slice(0, limit).join('');
}

/**
 * The entry's start, converted to the one time base the event contract
 * defines: Unix epoch milliseconds as a double.
 *
 * `PerformanceEntry.startTime` is measured from the document's time origin, so
 * `./transport.ts`'s conversion is the whole of the work. A host that reports
 * something unusable yields `NaN`, which that function documents as degrading
 * to the current instant — a late timestamp rather than an invalid event,
 * which is the trade AAP 0.2.3's ordering rules are built to absorb (ordering
 * falls through to `(producerId, seq)` and then to the store's ingest
 * sequence).
 */
function epochStartOf(entry: PerformanceEntry): number {
  const raw: unknown = entry.startTime;
  return toEpochMs(typeof raw === 'number' ? raw : Number.NaN);
}

/**
 * The entry's duration in milliseconds, clamped to zero or more.
 *
 * The event schema rejects a negative duration (it would invert a waterfall
 * row) and has no upper bound on purpose — a long task of several seconds is
 * precisely the evidence the developer asked for.
 */
function durationOf(entry: PerformanceEntry): number {
  return measurement(entry.duration) ?? 0;
}

/**
 * The event `name` for an entry, bounded and never empty.
 *
 * @param entry The entry whose `name` is wanted.
 * @param fallback The name to use when the host reported none — always a
 * constant from this module, so an event never carries a name derived from
 * nothing.
 */
function nameOf(entry: PerformanceEntry, fallback: string): string {
  return boundedText(entry.name, MAX_EVENT_NAME_LENGTH) ?? fallback;
}

/*
 * ---------------------------------------------------------------------------
 * Event construction
 * ---------------------------------------------------------------------------
 */

/**
 * Build the draft every entry type shares, with its own attributes merged in.
 *
 * The three things worth noticing, each stated once here so no mapping below
 * has to restate it:
 *
 * 1. **The trace decision is `./interaction.js`'s**, asked for at the moment
 *    of delivery and never overridden. An entry delivered while an interaction
 *    window is open becomes a child of that interaction; one delivered outside
 *    any window becomes the root of its own trace. See the module note on why
 *    no timestamp is passed.
 * 2. **The context's attributes are merged first**, so a key the attribution
 *    contributed (the lineage annotation a continuation writes) is present and
 *    an entry's own key of the same name would win. Dropping this merge costs
 *    the panel the dashed edge that marks an ambiguous attribution, which is
 *    the easiest mistake to make in this folder.
 * 3. **`spanId` is fresh and `parentSpanId` comes from the context.** A
 *    performance entry is a leaf: nothing hangs from it, so nothing else needs
 *    to know its span id in advance.
 */
function buildDraft(
  kind: TelemetryKind,
  name: string,
  startTime: number,
  duration: number,
  context: EventContext,
  attributes: Record<string, unknown>,
): EventDraft {
  const draft: EventDraft = {
    traceId: context.traceId,
    spanId: newSpanId(),
    kind,
    name,
    startTime,
    duration,
    attributes: { ...context.attributes, ...attributes },
    status: OBSERVED_STATUS,
  };

  // Assigned only when the context resolved one: under
  // `exactOptionalPropertyTypes` an absent field and a field set to
  // `undefined` are different things, and a synthetic root has no parent.
  if (context.parentSpanId !== undefined) {
    draft.parentSpanId = context.parentSpanId;
  }

  return draft;
}

/**
 * Reduce a long task's attribution list to at most
 * {@link MAX_ATTRIBUTION_ENTRIES} plain records.
 *
 * The list is read from the entry structurally because the Long Tasks API is
 * absent from the DOM typings this project compiles against. Each host record
 * contributes only the four container fields, bounded in length, and a record
 * that reports none of them — the ordinary case for a task charged to the
 * top-level document, where every field is the empty string — is skipped
 * rather than emitted as an empty object, so the attribute is present only
 * when it says something.
 *
 * @returns The reduced records, or `undefined` when there is nothing to report.
 */
function attributionOf(entry: PerformanceEntry): LongTaskAttribution[] | undefined {
  const candidate = entry as PerformanceEntry & { attribution?: unknown };
  const list: unknown = candidate.attribution;
  if (!Array.isArray(list) || list.length === 0) {
    return undefined;
  }

  const reduced: LongTaskAttribution[] = [];
  for (const item of list) {
    if (reduced.length >= MAX_ATTRIBUTION_ENTRIES) {
      break;
    }
    if (typeof item !== 'object' || item === null) {
      continue;
    }

    const source = item as {
      containerType?: unknown;
      containerName?: unknown;
      containerId?: unknown;
      containerSrc?: unknown;
    };
    const record: LongTaskAttribution = {};
    const containerType = boundedText(source.containerType, MAX_ATTRIBUTE_STRING_LENGTH);
    if (containerType !== undefined) {
      record.containerType = containerType;
    }
    const containerName = boundedText(source.containerName, MAX_ATTRIBUTE_STRING_LENGTH);
    if (containerName !== undefined) {
      record.containerName = containerName;
    }
    const containerId = boundedText(source.containerId, MAX_ATTRIBUTE_STRING_LENGTH);
    if (containerId !== undefined) {
      record.containerId = containerId;
    }
    const containerSrc = boundedText(source.containerSrc, MAX_ATTRIBUTE_STRING_LENGTH);
    if (containerSrc !== undefined) {
      record.containerSrc = containerSrc;
    }

    if (Object.keys(record).length > 0) {
      reduced.push(record);
    }
  }

  return reduced.length > 0 ? reduced : undefined;
}

/**
 * Map a `longtask` entry to a `perf.longtask` event.
 *
 * `blockingTime` is the excess over {@link LONG_TASK_THRESHOLD_MS} — the
 * definition `../schema/attributes.ts` records for the `blocking_time` metric,
 * so a 120 ms task contributes 70 ms of blocking and a task at the threshold
 * contributes none. The entry's `name` is the host's charge for the task
 * (`self`, `same-origin-descendant`, `cross-origin-ancestor`, …), which is
 * kept as the event name because it is the one word that says *whose* work
 * blocked the thread.
 */
function longTaskDraft(
  entry: PerformanceEntry,
  startTime: number,
  context: EventContext,
): EventDraft {
  const duration = durationOf(entry);
  const attributes: Record<string, unknown> = {
    [KEY_BLOCKING_TIME]: Math.max(0, duration - LONG_TASK_THRESHOLD_MS),
  };

  const attribution = attributionOf(entry);
  if (attribution !== undefined) {
    attributes[KEY_ATTRIBUTION] = attribution;
  }

  return buildDraft(
    LONGTASK_KIND,
    nameOf(entry, 'longtask'),
    startTime,
    duration,
    context,
    attributes,
  );
}

/**
 * Map a `resource` entry to a `perf.entry` event.
 *
 * The event's `name` is the constant `resource` and the URL travels in the
 * `url` attribute: a name is a label a log row shows, and putting a URL there
 * would make every row unique, defeat grouping and quietly exceed the name
 * bound the event schema applies. The URL itself is emitted **raw** — see the
 * module note; it is the join key for `../aggregate/requests.ts` and the input
 * the service hashes into `request_key`.
 *
 * Every other field is read defensively and omitted when the host will not
 * say. **This is the only source of `transferred_bytes` in the whole product**
 * (AAP 0.6.6): server spans cannot report a transferred size at all, and this
 * entry reports `0` for a cross-origin response served without
 * `Timing-Allow-Origin`. That zero is emitted as measured, so the aggregate
 * can present the metric as `n/a` rather than as a number nobody measured.
 */
function resourceDraft(
  entry: PerformanceEntry,
  startTime: number,
  context: EventContext,
): EventDraft {
  const source = entry as PerformanceEntry & {
    initiatorType?: unknown;
    transferSize?: unknown;
    encodedBodySize?: unknown;
    decodedBodySize?: unknown;
    nextHopProtocol?: unknown;
    responseStatus?: unknown;
    renderBlockingStatus?: unknown;
  };

  const attributes: Record<string, unknown> = { [KEY_ENTRY_TYPE]: 'resource' };

  // Raw, unbounded, exactly as the host reported it.
  if (typeof entry.name === 'string' && entry.name.length > 0) {
    attributes[KEY_URL] = entry.name;
  }

  const initiatorType = boundedText(source.initiatorType, MAX_ATTRIBUTE_STRING_LENGTH);
  if (initiatorType !== undefined) {
    attributes[KEY_INITIATOR_TYPE] = initiatorType;
  }

  const transferSize = measurement(source.transferSize);
  if (transferSize !== undefined) {
    attributes[KEY_TRANSFER_SIZE] = transferSize;
  }

  const encodedBodySize = measurement(source.encodedBodySize);
  if (encodedBodySize !== undefined) {
    attributes[KEY_ENCODED_BODY_SIZE] = encodedBodySize;
  }

  const decodedBodySize = measurement(source.decodedBodySize);
  if (decodedBodySize !== undefined) {
    attributes[KEY_DECODED_BODY_SIZE] = decodedBodySize;
  }

  const nextHopProtocol = boundedText(source.nextHopProtocol, MAX_ATTRIBUTE_STRING_LENGTH);
  if (nextHopProtocol !== undefined) {
    attributes[KEY_NEXT_HOP_PROTOCOL] = nextHopProtocol;
  }

  // `0` means "not exposed" for this field rather than "status zero", so it is
  // the one numeric reading here that is dropped instead of reported.
  const responseStatus = measurement(source.responseStatus);
  if (responseStatus !== undefined && responseStatus > 0) {
    attributes[KEY_RESPONSE_STATUS] = responseStatus;
  }

  const renderBlockingStatus = boundedText(
    source.renderBlockingStatus,
    MAX_ATTRIBUTE_STRING_LENGTH,
  );
  if (renderBlockingStatus !== undefined) {
    attributes[KEY_RENDER_BLOCKING_STATUS] = renderBlockingStatus;
  }

  return buildDraft(PERF_ENTRY_KIND, 'resource', startTime, durationOf(entry), context, attributes);
}

/**
 * Map a `navigation` entry to a `navigation` event.
 *
 * The milestones are carried as the host's relative milliseconds rather than
 * as converted instants: they are offsets within the document's own load, they
 * are compared with each other, and re-basing them would make the arithmetic a
 * consumer does depend on which of two time bases it remembered. The event's
 * `startTime` and `duration` are on the epoch base like every other event's,
 * so a navigation still places itself correctly on the timeline.
 *
 * A milestone of `0` means the document had not reached it when the entry was
 * observed — the ordinary reading for `loadEventEnd` on a buffered entry taken
 * mid-load — and is emitted as measured.
 */
function navigationDraft(
  entry: PerformanceEntry,
  startTime: number,
  context: EventContext,
): EventDraft {
  const source = entry as PerformanceEntry & {
    type?: unknown;
    responseEnd?: unknown;
    domContentLoadedEventEnd?: unknown;
    loadEventEnd?: unknown;
    transferSize?: unknown;
  };

  const duration = durationOf(entry);
  const attributes: Record<string, unknown> = { [KEY_DURATION]: duration };

  if (typeof entry.name === 'string' && entry.name.length > 0) {
    attributes[KEY_URL] = entry.name;
  }

  const navigationType = boundedText(source.type, MAX_ATTRIBUTE_STRING_LENGTH);
  if (navigationType !== undefined) {
    attributes[KEY_NAVIGATION_TYPE] = navigationType;
  }

  const responseEnd = measurement(source.responseEnd);
  if (responseEnd !== undefined) {
    attributes[KEY_RESPONSE_END] = responseEnd;
  }

  const domContentLoaded = measurement(source.domContentLoadedEventEnd);
  if (domContentLoaded !== undefined) {
    attributes[KEY_DOM_CONTENT_LOADED] = domContentLoaded;
  }

  const loadEventEnd = measurement(source.loadEventEnd);
  if (loadEventEnd !== undefined) {
    attributes[KEY_LOAD_EVENT_END] = loadEventEnd;
  }

  const transferSize = measurement(source.transferSize);
  if (transferSize !== undefined) {
    attributes[KEY_TRANSFER_SIZE] = transferSize;
  }

  return buildDraft(NAVIGATION_KIND, 'navigation', startTime, duration, context, attributes);
}

/**
 * Map a `paint` entry to a `perf.entry` event.
 *
 * The name is the host's — `first-paint` or `first-contentful-paint` — because
 * those two strings are the whole content of the observation, and the duration
 * is **zero on purpose**: a paint mark is an instant. The host reports zero as
 * well; it is written explicitly here so that nobody later "fixes" a paint
 * into a span by measuring it against something.
 */
function paintDraft(entry: PerformanceEntry, startTime: number, context: EventContext): EventDraft {
  const attributes: Record<string, unknown> = { [KEY_ENTRY_TYPE]: 'paint' };
  return buildDraft(PERF_ENTRY_KIND, nameOf(entry, 'paint'), startTime, 0, context, attributes);
}

/**
 * Build the draft for one entry of a known type.
 *
 * Exhaustive over {@link ObservedEntryType}, so adding a member to
 * {@link OBSERVED_ENTRY_TYPES} without mapping it is a compile error rather
 * than an observer whose entries are silently discarded.
 */
function draftFor(type: ObservedEntryType, entry: PerformanceEntry): EventDraft {
  const startTime = epochStartOf(entry);
  const context = resolveEventContext();

  switch (type) {
    case 'longtask':
      return longTaskDraft(entry, startTime, context);
    case 'resource':
      return resourceDraft(entry, startTime, context);
    case 'navigation':
      return navigationDraft(entry, startTime, context);
    case 'paint':
      return paintDraft(entry, startTime, context);
  }
}

/*
 * ---------------------------------------------------------------------------
 * Observation
 * ---------------------------------------------------------------------------
 */

/**
 * Map one entry and hand it to the transport, within the per-type bound.
 *
 * The bound is checked before the mapping is done, so an entry past the bound
 * costs a counter increment and nothing else — which matters on the page that
 * makes the bound relevant in the first place.
 */
function observeEntry(type: ObservedEntryType, entry: PerformanceEntry): void {
  if (emittedCounts[type] >= MAX_ENTRIES_PER_TYPE) {
    droppedCount += 1;
    return;
  }

  emit(draftFor(type, entry));
  emittedCounts[type] += 1;
}

/**
 * Handle one delivered batch for one entry type.
 *
 * Two guards, and each earns its place. The outer one contains a host whose
 * entry list itself misbehaves — a stub in a test, a page that replaced
 * `PerformanceObserverEntryList` — to the batch. The inner one contains a
 * single malformed entry to itself, which is the point: a buffered flush can
 * deliver hundreds of resource entries at once, and one unreadable entry among
 * them must not cost the rest.
 *
 * The attachment check is not redundant with `disconnect()`. A batch queued
 * before the disconnect can still be delivered afterwards, and emitting then
 * would extend a capture the developer has already ended — the same reason
 * `./interaction.js` drops the interaction that was in flight when it
 * detaches.
 */
function handleEntries(type: ObservedEntryType, list: PerformanceObserverEntryList): void {
  if (!attached) {
    return;
  }

  try {
    for (const entry of list.getEntries()) {
      try {
        observeEntry(type, entry);
      } catch {
        // One entry's failure is its own: counted, and the batch continues.
        failureCount += 1;
      }
    }
  } catch {
    // The batch could not be read at all. Nothing in it is recoverable, and
    // the observer stays registered for the next one.
    failureCount += 1;
  }
}

/**
 * Create and start one observer for one entry type.
 *
 * Both steps are guarded, for different reasons. The constructor is absent in
 * a host without the Performance Timeline at all (and is stubbed away in the
 * tests that prove this module degrades), while `observe` throws a `TypeError`
 * in a host that has `PerformanceObserver` but does not support the type
 * asked for — which is the ordinary case for `longtask`. A failed `observe`
 * disconnects what was constructed, so no half-started observer is left
 * holding a callback.
 *
 * `{ type, buffered: true }` and never `entryTypes`: the Performance Timeline
 * specification forbids combining the two, and buffering is what lets a
 * capture armed after page load still see the navigation and paint entries the
 * document produced once.
 *
 * @returns The started observer, or `undefined` when this host cannot deliver
 * the type — in which case the caller records it as unavailable.
 */
function startObserver(type: ObservedEntryType): PerformanceObserver | undefined {
  let created: PerformanceObserver;
  try {
    created = new PerformanceObserver((list) => {
      handleEntries(type, list);
    });
  } catch {
    // No usable observer could be constructed; the type is unavailable.
    return undefined;
  }

  try {
    const init: PerformanceObserverInit = { type, buffered: true };
    created.observe(init);
    return created;
  } catch {
    try {
      created.disconnect();
    } catch {
      // Nothing was observing, so there is nothing left to release.
    }
    return undefined;
  }
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/**
 * Start harvesting the performance timeline: one buffered observer per entry
 * type in {@link OBSERVED_ENTRY_TYPES}.
 *
 * Called by `./agent.ts` when the service arms the performance hook through
 * `agent.config`, and never at import time — a page the developer is merely
 * browsing gets no observer at all.
 *
 * **Idempotent.** A second call while attached does nothing: it neither
 * double-registers (which would emit every entry twice) nor resets the
 * counters, so a re-configuration after a reconnect cannot make one capture
 * look like two.
 *
 * **The counters are reset here**, which is what makes
 * {@link MAX_ENTRIES_PER_TYPE} a per-capture bound and
 * {@link getPerfStats}'s numbers a description of the capture in progress
 * rather than of the document's whole lifetime.
 *
 * In a host with no `PerformanceObserver` — and in one that refuses every type
 * — this is a safe no-op: nothing is registered, the module stays detached,
 * and every entry type is reported as unavailable so the capture can say which
 * signals it does not have (AAP 0.5.5) instead of appearing to have collected
 * nothing.
 *
 * Never throws. A failure part-way through registration detaches, so the
 * module is either attached with every observer it could start or fully
 * detached, and never holding an observer it cannot release.
 */
export function attachPerf(): void {
  try {
    if (attached) {
      return;
    }

    emittedCounts = freshCounts();
    droppedCount = 0;
    failureCount = 0;
    unavailableTypes = [];

    if (typeof PerformanceObserver === 'undefined') {
      unavailableTypes = [...OBSERVED_ENTRY_TYPES];
      return;
    }

    // Published before the loop so a callback that fires during registration —
    // a buffered flush is delivered in a task of its own, but a host is free to
    // be eager — finds the module attached rather than dropping its batch.
    attached = true;

    for (const type of OBSERVED_ENTRY_TYPES) {
      const observer = startObserver(type);
      if (observer === undefined) {
        unavailableTypes.push(type);
        continue;
      }
      observers.push(observer);
    }

    if (observers.length === 0) {
      // Every type was refused. Nothing was registered, so there is nothing to
      // disconnect and no signal to claim: clearing the flag keeps
      // `isPerfAttached()` honest, and the unavailable list stays for the
      // readiness report — which is the whole value of this state.
      attached = false;
    }
  } catch {
    detachPerf();
  }
}

/**
 * Stop harvesting and release every observer.
 *
 * Called by `./agent.ts` when the service clears the hooks — an `agent.config`
 * with every hook false — which AAP 0.5.1 requires to leave the agent
 * "disabled, not merely idled". Afterwards this module holds no registered
 * observer, no counter and no observation of the developer's page, and a
 * buffered batch that was already queued emits nothing.
 *
 * The counters and the unavailable list are cleared with the observers: the
 * next {@link attachPerf} is a new capture, states its own availability and
 * counts its own entries, so carrying either across a detach would attribute
 * one capture's evidence to another.
 *
 * Safe to call when already detached, and never throws — each observer is
 * disconnected inside its own guard, so a host that throws on `disconnect`
 * costs that one reference rather than the teardown.
 */
export function detachPerf(): void {
  try {
    // Cleared first: a batch delivered while the loop runs must find the
    // module detached and drop itself.
    attached = false;

    for (const observer of observers.splice(0, observers.length)) {
      try {
        observer.disconnect();
      } catch {
        // A host that throws on disconnect has already stopped delivering; the
        // reference is dropped either way.
      }
    }

    emittedCounts = freshCounts();
    droppedCount = 0;
    failureCount = 0;
    unavailableTypes = [];
  } catch {
    // Best effort by construction: the steps above are independent, so a
    // failure in one leaves the others done.
  } finally {
    attached = false;
  }
}

/**
 * Whether any observer is registered right now.
 *
 * `./agent.ts` reports this in its readiness and status frames. It is `false`
 * in a host with no Performance Timeline even after {@link attachPerf} was
 * called, because nothing was registered there — which is the distinction a
 * reader needs: the hook was asked for, and the host could not provide it.
 */
export function isPerfAttached(): boolean {
  return attached;
}

/**
 * What this attachment has observed, and what it could not.
 *
 * A fresh object with a copied count record and a copied list on every call,
 * so a reader — `./agent.ts`'s status frame, a test — cannot disturb the
 * module's state by holding on to the result.
 */
export function getPerfStats(): PerfStats {
  return {
    emitted: { ...emittedCounts },
    dropped: droppedCount,
    unavailable: [...unavailableTypes],
    failures: failureCount,
  };
}
