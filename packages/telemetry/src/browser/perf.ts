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
 *   with. Its `url` and `startTime` are the join key `../aggregate/requests.ts`
 *   matches against the `fetch`/`xhr` span that caused the load, and
 *   {@link KEY_TRANSFER_SIZE_EXPOSED} tells that aggregate whether the byte
 *   counts beside them are a measurement or an absence.
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
 * **One observer per entry type, and buffered replay only for the document's
 * lifecycle.** The Performance Timeline specification forbids combining
 * `entryTypes` with `buffered`, so four observers it is, each created and
 * started inside its own `try`/`catch` because `observe({ type })` throws a
 * `TypeError` for a type the host does not support (`longtask` is not
 * universally available). A type that throws is recorded in
 * {@link getPerfStats}'s `unavailable` list rather than being allowed to abort
 * the other three, which is what AAP 0.5.5 asks of an unavailable signal:
 * reported, not silently missing.
 *
 * Which of those four observers replays the buffer is a separate decision, and
 * {@link BUFFERED_ENTRY_TYPES} is the whole of it. `navigation` and `paint`
 * are replayed because their entries exist **once** per document and are
 * already in the buffer by the time this hook runs: when a capture spans a
 * reload, the agent is re-armed in the new document only after it has loaded,
 * so without the flag the capture could never see that document's own
 * navigation and paints, and "did this capture span a reload?" would be
 * unanswerable. The same replay also hands over the entries of a document
 * that loaded **before** Start, and this module keeps them on purpose: its
 * own capture instant is taken when it is armed, which after a reload is
 * later than the fresh navigation it replays for, so a filter here would
 * discard the one entry the flag exists to deliver. Only the service knows
 * when the capture opened, so it discards the lifecycle entries that ended
 * before that instant at attribution — the `pre-capture` drop of
 * `apps/local-service/src/telemetry/attribute.ts` — and keeps every other
 * one, a reload's included.
 *
 * `resource` and `longtask` are **not** replayed, because their buffers hold
 * the page's whole history — every image, script and stylesheet the document
 * ever loaded, and every task that ever blocked the thread — and replaying
 * them would open a capture with up to {@link MAX_ENTRIES_PER_TYPE} entries
 * that predate the question, in one immediate batch, spending the per-type
 * bound on evidence about a moment nobody is investigating. The two streams a
 * developer arms this hook for are the ones the capture window itself
 * produces.
 *
 * Buffering is not the only guard: every entry of a non-replayed type is also
 * measured against {@link getCaptureStartTime}, the instant {@link attachPerf}
 * ran, and one that had already **finished** by then is discarded and counted
 * in {@link PerfStats.preCapture}. An entry still in flight when the capture
 * armed is kept — a resource that was loading, or a task that was blocking,
 * when the developer pressed Capture is part of what they are looking at — and
 * the two lifecycle types are exempt here by construction, since being older
 * than this hook's instant is precisely why they are replayed; their window
 * test is the service's, against the capture's own start (above).
 *
 * **Replayed entries become roots of their own traces, deliberately.** Every
 * event asks `./interaction.js` which trace it belongs to, and that module
 * answers with the interaction window that is open *at the moment of the
 * call*. When a capture starts, the replayed navigation and paint entries
 * arrive with no interaction open and so become synthetic roots — which is
 * the honest answer, because page-load timing is a fact about the document
 * and not about a click. Forcing them onto whatever interaction happens to be
 * in flight would claim a causal link the capture never observed. For the
 * same reason the resolution is asked with no timestamp argument: the
 * interaction lookup uses the value it is given for its own lifetime valve
 * rather than as a "was a window open then?" query, so handing it a replayed
 * entry's minutes-old `startTime` would both misattribute the entry and
 * suppress the valve that closes a starved window.
 *
 * ## Faithful numbers, or none
 *
 * A resource entry reports `transferSize`, `encodedBodySize` and
 * `decodedBodySize` as `0` for a cross-origin response served without
 * `Timing-Allow-Origin`, and older hosts omit some of the fields entirely.
 * That zero is **not a measurement**: it is the specification's way of saying
 * the timing-allow check failed and the byte counts are not exposed, and it is
 * indistinguishable by value from the genuine zero a same-origin cache hit
 * reports. Emitting it as a reading would let `transferred_bytes` publish "0
 * bytes transferred" for a capture in which nothing was measured, turning an
 * absence into an observation — which AAP 0.8.4 forbids structurally and
 * AAP 0.6.6 answers with `n/a`.
 *
 * So the two cases are separated at the producer, where the evidence to do it
 * exists. {@link transferSizeExposed} decides whether the host exposed byte
 * counts for an entry at all — always for a same-origin response, and for a
 * cross-origin one only when the entry carries the corroboration a passing
 * timing-allow check leaves behind — and the answer travels on every resource
 * and navigation event as {@link KEY_TRANSFER_SIZE_EXPOSED}. When it is
 * `false` the three size fields are **omitted**, because this module's rule is
 * a readable value or no key at all, and a zero that means "not exposed" is
 * not a readable value. When it is `true` the sizes are emitted exactly as
 * measured, zero included: a same-origin response served from cache really did
 * transfer nothing, and that is a fact worth reporting.
 *
 * Nothing here substitutes a plausible value for a missing one, and no
 * non-finite number is ever put on an event: JSON has no spelling for `NaN` or
 * `Infinity`, and the event contract in `../schema/event.ts` bounds the
 * numeric fields that matter.
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
 * and never the developer's application. Each of those guards also *reports*
 * what it contained, through `./transport.ts`'s `reportProducerFailure`: a
 * counter the service never sees would let a capture that lost its long-task
 * or resource timing be presented as a complete one, which AAP 0.5.5 forbids.
 * The reports carry the entry type and the thrown value's type name — never a
 * field read off an entry, because a control frame is not redacted anywhere on
 * its way to the service. {@link attachPerf} is idempotent and
 * {@link detachPerf} disconnects every observer and clears every counter,
 * because AAP 0.5.1 requires a cleared hook to be disabled rather than idled —
 * afterwards this module holds no count and no observation of the developer's
 * page, and a buffered flush that was already queued emits nothing. The one
 * thing a detach may still hold is an observer whose `disconnect()` the host
 * refused, kept precisely so a later detach can release it (see
 * {@link detachPerf}).
 *
 * That retention is keyed by **entry type**, which is the only shape of it
 * that is safe. A retained observer is still registered with the host for its
 * own type, so a later {@link attachPerf} that started a second observer for
 * that type would have two callbacks processing the same entries and would
 * emit — and count — every long task, resource, navigation and paint twice,
 * presenting a capture whose numbers are double what the page did. So
 * {@link attachPerf} deals with the retained observer for a type before it
 * considers starting one: it retries the refused `disconnect()` and starts
 * fresh if the host has changed its mind, and otherwise *adopts* the retained
 * observer for this attachment rather than adding to it. Adoption is sound
 * because an observer's callback captures nothing but its entry type — every
 * per-capture decision (whether the module is attached, the emitted counts,
 * the bound, the trace context) is read from module state at delivery — so
 * the observer a previous capture started serves this one exactly as a new
 * one would. {@link hasPerfResidue} is how `./agent.ts` sees that anything is
 * retained at all, which is what lets a cleared session say *which* hooks the
 * page still carries instead of claiming a clean release (AAP 0.5.1, 0.5.5).
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
import {
  emit,
  nowEpochMs,
  reportProducerFailure,
  toEpochMs,
  type EventDraft,
} from './transport.js';
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
 * The entry types observed with `buffered: true`, and therefore the only ones
 * this hook emits even when they predate its own attachment.
 *
 * A subset of {@link OBSERVED_ENTRY_TYPES}, and the module's whole buffering
 * policy — see the header for the reasoning. `navigation` and `paint` describe
 * the document's lifecycle, occur once, and are gone from the timeline's
 * delivery path by the time the agent is armed — after a reload during a
 * capture, only once the new document has loaded — so replaying them is the
 * only way a capture sees a reload's fresh lifecycle entries at all.
 * `resource` and `longtask` are continuous streams whose buffers hold the
 * page's entire history; replaying those would open every capture with a batch
 * of evidence about a moment nobody asked about, and would spend
 * {@link MAX_ENTRIES_PER_TYPE} before the developer had interacted with
 * anything.
 *
 * Membership also selects the capture-start filter: a type in this list is
 * exempt from it (an older entry is exactly what it was replayed for), and a
 * type outside it is measured against {@link getCaptureStartTime}. The replay
 * therefore also delivers the lifecycle entries of a document that loaded
 * before the capture started; those are discarded by the service at
 * attribution, not here — `apps/local-service/src/telemetry/attribute.ts`
 * drops a replayed entry as `pre-capture` when it ended before the capture's
 * recorded start, and keeps one that reaches into the window.
 */
export const BUFFERED_ENTRY_TYPES = ['navigation', 'paint'] as const;

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
 * A media-heavy page produces hundreds of resource entries in the course of an
 * interaction, and a render storm can produce long tasks for as long as it
 * lasts. The bound is per type rather than shared, so a flood of resources
 * cannot starve the long tasks that answer the developer's question — and
 * because the two continuous streams are not replayed, the bound is spent on
 * the capture's own entries rather than on the page's history.
 *
 * Entries past the bound are counted in {@link getPerfStats}'s `dropped` —
 * reported, not hidden, exactly as `./transport.ts` reports its own queue
 * losses — and the count restarts with each {@link attachPerf}, so the bound
 * is per capture and not per document. An entry rejected for predating the
 * capture is counted separately, in `preCapture`: it was never this capture's
 * to hold, so charging it to a bound the developer can read as "evidence I
 * lost" would misreport it.
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

/**
 * Bytes over the wire, including headers.
 *
 * Written only when {@link KEY_TRANSFER_SIZE_EXPOSED} is `true`; see the
 * header's "Faithful numbers, or none". A host that will not say reports `0`,
 * and that zero is an absence rather than a reading, so it is omitted with the
 * other two size fields instead of travelling as evidence.
 */
const KEY_TRANSFER_SIZE: DeclaredPerfEntryKey & DeclaredNavigationKey = 'transferSize';

/**
 * Whether Resource Timing exposed byte counts for this entry at all.
 *
 * **Invented here**, and load-bearing rather than diagnostic. Neither
 * `PERF_ENTRY_ATTRIBUTE_KEYS` nor `NAVIGATION_ATTRIBUTE_KEYS` declares a
 * counterpart, yet without it a consumer cannot tell a same-origin response
 * that genuinely transferred nothing from a cross-origin response whose sizes
 * the timing-allow check withheld — both read `transferSize: 0` — and
 * `transferred_bytes` would publish the second as an observation of zero
 * bytes (AAP 0.6.6, 0.8.4).
 *
 * Emitted on **every** resource and navigation event, `true` or `false`, so
 * its absence means "a producer that predates this contract" rather than
 * "not exposed"; `../aggregate/requests.ts` reads exactly this spelling,
 * re-declares it for the consumer side, and treats an explicit `false` as
 * decisive. `../schema/attributes.ts` should adopt it in both tuples, at
 * which point both spellings become one.
 */
const KEY_TRANSFER_SIZE_EXPOSED = 'transferSizeExposed';

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
 * - **`preCapture`** — real entries that had already finished before this
 *   capture was armed, discarded by the filter described in the header. A
 *   non-zero count is ordinary rather than a fault: it is how many pieces of
 *   somebody else's moment a host offered this capture.
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
  /** Entries discarded because they had finished before the capture was armed. */
  preCapture: number;
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
 * The started observers, keyed by the entry type each one observes, held so
 * {@link detachPerf} can disconnect every one of them.
 *
 * Only observers that actually started are in the map: a type the host refused
 * leaves nothing to release and appears in {@link unavailableTypes} instead.
 *
 * Keyed rather than listed because the key is load-bearing in two places.
 * {@link detachPerf} retains exactly the entry whose `disconnect()` the host
 * refused — that observer is still registered for *that* type — and
 * {@link attachPerf} must therefore be able to ask "is something already
 * observing `resource`?" before it starts anything. A flat list cannot answer
 * that question, and an attach that guesses wrong installs a second observer
 * for a type already being observed, which makes the capture count every entry
 * of that type twice. At most one observer per type exists here at any moment,
 * whether it was started by this attachment or adopted from a previous one.
 */
const observersByType = new Map<ObservedEntryType, PerformanceObserver>();

/** Emitted counts per entry type; see {@link PerfStats.emitted}. */
let emittedCounts = freshCounts();

/** Entries declined because a per-type bound was reached. */
let droppedCount = 0;

/** Entries discarded for having finished before this capture was armed. */
let preCaptureCount = 0;

/** Entries or batches that could not be read. */
let failureCount = 0;

/**
 * When this attachment began, in epoch milliseconds, or `undefined` while
 * detached.
 *
 * {@link attachPerf} is called by `./agent.ts` when the service arms the
 * performance hook, so this instant *is* the start of the capture as this
 * module can observe it — no clock other than the one `./transport.ts` already
 * uses to place every event on the epoch base is consulted, which keeps the
 * comparison against an entry's converted `startTime` a comparison of two
 * readings of the same clock.
 */
let captureStartedAt: number | undefined;

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

/**
 * Whether entries of `type` are replayed from the performance buffer.
 *
 * The one place {@link BUFFERED_ENTRY_TYPES} is interpreted, read by both the
 * observer setup (which passes the flag) and the capture filter (which exempts
 * the replayed types), so the two can never disagree about which streams carry
 * pre-capture history on purpose.
 */
function isBufferedType(type: ObservedEntryType): boolean {
  return (BUFFERED_ENTRY_TYPES as readonly ObservedEntryType[]).includes(type);
}

/**
 * Whether an entry belongs to the capture in progress.
 *
 * The test is on the entry's **end**, not its start: a resource that was still
 * downloading, or a task that was still blocking, when the developer armed the
 * capture is part of what they are looking at, while one that had already
 * finished belongs to a moment nobody asked about. A replayed type is exempt
 * (see {@link isBufferedType}) and so is the state before an attachment has
 * recorded its instant, which cannot happen through {@link attachPerf} but
 * must not become a silent discard if it ever did.
 *
 * @param type The entry's type.
 * @param startTime The entry's start, already on the epoch base.
 * @param duration The entry's duration in milliseconds.
 * @returns `true` when the entry may be emitted.
 */
function withinCapture(type: ObservedEntryType, startTime: number, duration: number): boolean {
  if (captureStartedAt === undefined || isBufferedType(type)) {
    return true;
  }
  return startTime + duration >= captureStartedAt;
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
 * The byte-count fields of resource timing, read defensively.
 *
 * Grouped into one shape because they are exposed or withheld together — the
 * timing-allow check governs all three — so they are read once and decided on
 * once.
 */
interface ResourceByteSizes {
  /** `transferSize`: bytes over the wire, headers included. */
  readonly transferSize: number | undefined;
  /** `encodedBodySize`: payload bytes before content decoding. */
  readonly encodedBodySize: number | undefined;
  /** `decodedBodySize`: payload bytes after content decoding. */
  readonly decodedBodySize: number | undefined;
}

/**
 * Whether a URL string names the document's own origin.
 *
 * Resolved against `location.href` so a relative entry name — which resource
 * timing does not produce, but a stub in a test and a shimmed host both can —
 * is treated as same-origin rather than as unknown. A host with no `URL` or no
 * `location`, and a name no parser accepts, both answer `false`: the
 * conservative direction, because the caller uses a `false` to demand
 * corroboration before it trusts a byte count.
 */
function isSameOriginUrl(url: string | undefined): boolean {
  try {
    if (url === undefined || typeof URL === 'undefined' || typeof location === 'undefined') {
      return false;
    }
    return new URL(url, location.href).origin === location.origin;
  } catch {
    // An unparseable name cannot establish an origin, which is the same answer
    // as "not the document's".
    return false;
  }
}

/**
 * Whether this entry's byte counts are a measurement rather than an absence.
 *
 * Two routes, and a resource entry needs only one of them:
 *
 * 1. **Same origin.** The timing-allow check passes unconditionally for the
 *    document's own origin, so every field is exposed and a zero is a real
 *    zero — a response served from cache transferred nothing, which is
 *    evidence rather than a gap.
 * 2. **Corroboration, from TAO-gated fields only.** A cross-origin response
 *    served *with* `Timing-Allow-Origin` exposes the same fields as a
 *    same-origin one, so any positive size or a non-empty `nextHopProtocol`
 *    is proof the check passed — those are withheld together, all reading `0`
 *    or `""`, when it fails. `responseStatus` is deliberately **not** among
 *    them: Resource Timing exposes a response status for a CORS response
 *    whether or not the timing-allow check passed, so a plain
 *    `Access-Control-Allow-Origin` response reports `responseStatus: 200`
 *    beside three zero sizes and an empty protocol. Treating that status as
 *    corroboration would certify exactly the case this predicate exists to
 *    catch.
 *
 * The cost of the conservative answer is narrow and worth naming: a
 * cross-origin response that passed the check and genuinely transferred zero
 * bytes over every field reads as unexposed. That capture reports `n/a`
 * instead of `0` — the same answer it would give if the check had failed,
 * which is the honest one when the two are indistinguishable.
 *
 * @param sizes The three byte counts as read from the entry.
 * @param url The entry's URL, for the origin route.
 * @param nextHopProtocol The entry's ALPN identifier, when it reported one.
 */
function transferSizeExposed(
  sizes: ResourceByteSizes,
  url: string | undefined,
  nextHopProtocol: string | undefined,
): boolean {
  if (isSameOriginUrl(url)) {
    return true;
  }
  if (nextHopProtocol !== undefined) {
    return true;
  }
  return (
    (sizes.transferSize ?? 0) > 0 ||
    (sizes.encodedBodySize ?? 0) > 0 ||
    (sizes.decodedBodySize ?? 0) > 0
  );
}

/**
 * Write the byte counts onto an attribute bag, or record that there were none.
 *
 * The single place the decision of {@link transferSizeExposed} is applied, so
 * a resource entry and a navigation entry can never disagree about what an
 * unexposed size looks like on the wire. {@link KEY_TRANSFER_SIZE_EXPOSED} is
 * written either way — a consumer needs to know the question was asked — and
 * the sizes are written only when the answer is `true`, each still subject to
 * its own defensive read, so a host that exposes two of the three fields
 * reports two.
 */
function applyByteSizes(
  attributes: Record<string, unknown>,
  sizes: ResourceByteSizes,
  exposed: boolean,
): void {
  attributes[KEY_TRANSFER_SIZE_EXPOSED] = exposed;
  if (!exposed) {
    return;
  }

  if (sizes.transferSize !== undefined) {
    attributes[KEY_TRANSFER_SIZE] = sizes.transferSize;
  }
  if (sizes.encodedBodySize !== undefined) {
    attributes[KEY_ENCODED_BODY_SIZE] = sizes.encodedBodySize;
  }
  if (sizes.decodedBodySize !== undefined) {
    attributes[KEY_DECODED_BODY_SIZE] = sizes.decodedBodySize;
  }
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
 * (AAP 0.6.6): server spans cannot report a transferred size at all. The byte
 * counts therefore carry {@link KEY_TRANSFER_SIZE_EXPOSED} beside them and are
 * omitted when the host withheld them, so the aggregate presents the metric as
 * `n/a` rather than as a zero nobody measured — see the header.
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
  const url = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : undefined;
  if (url !== undefined) {
    attributes[KEY_URL] = url;
  }

  const initiatorType = boundedText(source.initiatorType, MAX_ATTRIBUTE_STRING_LENGTH);
  if (initiatorType !== undefined) {
    attributes[KEY_INITIATOR_TYPE] = initiatorType;
  }

  const nextHopProtocol = boundedText(source.nextHopProtocol, MAX_ATTRIBUTE_STRING_LENGTH);
  if (nextHopProtocol !== undefined) {
    attributes[KEY_NEXT_HOP_PROTOCOL] = nextHopProtocol;
  }

  // `0` means "not exposed" for this field rather than "status zero", so it is
  // the one numeric reading here that is dropped instead of reported.
  const responseStatusReading = measurement(source.responseStatus);
  const responseStatus =
    responseStatusReading !== undefined && responseStatusReading > 0
      ? responseStatusReading
      : undefined;
  if (responseStatus !== undefined) {
    attributes[KEY_RESPONSE_STATUS] = responseStatus;
  }

  // Decided together and written together: the timing-allow check governs all
  // three sizes, so one predicate answers for them.
  const sizes: ResourceByteSizes = {
    transferSize: measurement(source.transferSize),
    encodedBodySize: measurement(source.encodedBodySize),
    decodedBodySize: measurement(source.decodedBodySize),
  };
  applyByteSizes(attributes, sizes, transferSizeExposed(sizes, url, nextHopProtocol));

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

  const url = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : undefined;
  if (url !== undefined) {
    attributes[KEY_URL] = url;
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

  // The document's own response, so the origin route of
  // `transferSizeExposed` answers for it in the ordinary case; the
  // corroboration route covers a document served from another origin, and a
  // navigation entry carries neither body sizes nor an ALPN identifier to
  // corroborate with, which is why only `transferSize` is passed.
  const sizes: ResourceByteSizes = {
    transferSize: measurement(source.transferSize),
    encodedBodySize: undefined,
    decodedBodySize: undefined,
  };
  applyByteSizes(attributes, sizes, transferSizeExposed(sizes, url, undefined));

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
 *
 * `startTime` is supplied by the caller, which has already converted it to
 * decide whether the entry belongs to this capture: one conversion per entry,
 * and the instant the event carries is the instant that decision was made
 * against.
 */
function draftFor(type: ObservedEntryType, entry: PerformanceEntry, startTime: number): EventDraft {
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
 * Map one entry and hand it to the transport, within the per-type bound and
 * the capture window.
 *
 * Both guards are checked before the mapping is done, so a rejected entry
 * costs two field reads and a counter increment and nothing else — which
 * matters on exactly the page that makes either guard relevant. The window
 * check runs first because a host that ignored `buffered: false` would
 * otherwise spend the whole per-type bound on history before the capture's own
 * first entry arrived.
 *
 * The two readings the window check needs are the same ones the draft would
 * compute, so they are computed here and handed down rather than read twice:
 * `epochStartOf` consults the clock, and a second reading could place the same
 * entry on either side of the boundary.
 */
function observeEntry(type: ObservedEntryType, entry: PerformanceEntry): void {
  const startTime = epochStartOf(entry);
  const duration = type === 'paint' ? 0 : durationOf(entry);

  if (!withinCapture(type, startTime, duration)) {
    preCaptureCount += 1;
    return;
  }
  if (emittedCounts[type] >= MAX_ENTRIES_PER_TYPE) {
    droppedCount += 1;
    return;
  }

  emit(draftFor(type, entry, startTime));
  emittedCounts[type] += 1;
}

/**
 * Handle one delivered batch for one entry type.
 *
 * Two guards, and each earns its place. The outer one contains a host whose
 * entry list itself misbehaves — a stub in a test, a page that replaced
 * `PerformanceObserverEntryList` — to the batch. The inner one contains a
 * single malformed entry to itself, which is the point: one flush can deliver
 * many entries at once, and one unreadable entry among them must not cost the
 * rest.
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
      } catch (error) {
        // One entry's failure is its own: counted, reported and the batch
        // continues. The report is what makes the loss visible off this page —
        // `getPerfStats().failures` is read by a diagnostics view and by
        // nothing else, so on its own it lets a capture present incomplete
        // timing as complete (AAP 0.5.5). The entry type is agent vocabulary
        // and safe to carry; nothing read off the entry is.
        failureCount += 1;
        reportProducerFailure('perf', 'entry-convert', error, { entryType: type });
      }
    }
  } catch (error) {
    // The batch could not be read at all. Nothing in it is recoverable, and
    // the observer stays registered for the next one.
    failureCount += 1;
    reportProducerFailure('perf', 'entry-batch', error, { entryType: type });
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
 * `{ type, buffered }` and never `entryTypes`: the Performance Timeline
 * specification forbids combining the two, and the flag is per type rather
 * than uniform — {@link BUFFERED_ENTRY_TYPES} holds the document-lifecycle
 * types a capture armed after page load could not otherwise see, while the
 * continuous streams start empty so a capture observes its own moment. The
 * header states the reasoning in full.
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
  } catch (error) {
    // No usable observer could be constructed; the type is unavailable.
    reportProducerFailure('perf', 'observer-construct', error, { entryType: type });
    return undefined;
  }

  try {
    const init: PerformanceObserverInit = { type, buffered: isBufferedType(type) };
    created.observe(init);
    return created;
  } catch (error) {
    // Reported as well as listed in `unavailable`: the caller's list reaches
    // the service only when the *whole* hook is refused, while a single type
    // the host declined is otherwise silent — and "no long tasks" must never
    // read as "no long-task timing" (AAP 0.5.5).
    reportProducerFailure('perf', 'observer-start', error, { entryType: type });
    try {
      created.disconnect();
    } catch (disconnectError) {
      // Nothing was observing, so there is nothing left to release — but the
      // host refusing both calls is worth saying, because it is the state in
      // which a half-started observer could still hold a callback.
      reportProducerFailure('perf', 'observer-rollback', disconnectError, { entryType: type });
    }
    return undefined;
  }
}

/**
 * Settle whatever a previous {@link detachPerf} retained for one entry type,
 * before this attachment considers starting an observer for it.
 *
 * A retained observer is one whose `disconnect()` the host refused while it
 * was still registered for this type. Two outcomes, and the distinction is the
 * whole point of keying retention by type:
 *
 * - **The retry succeeds.** The observer is released and forgotten, and the
 *   caller starts a fresh one — the ordinary path once a transient host
 *   failure has passed.
 * - **The retry throws again.** The observer stays registered and stays in
 *   {@link observersByType}, and the caller *adopts* it: it is already
 *   observing exactly this type, so starting a second one would deliver every
 *   entry of the type to two callbacks and count it twice. The refusal is
 *   reported, because a capture running on an observer it could not release is
 *   a fact about the page rather than an internal detail (AAP 0.5.5), and the
 *   observer's callback needs no rebinding: it captures only the entry type
 *   and reads this module's per-capture state when a batch arrives.
 *
 * Never throws: the only host call it makes is guarded.
 *
 * @param type The entry type whose retained observer, if any, to settle.
 * @returns `true` when a retained observer is still registered for this type
 * and has been adopted for this attachment — the caller must not start
 * another. `false` when nothing was retained, or when the retained observer
 * was successfully released and a fresh one is needed.
 */
function adoptRetainedObserver(type: ObservedEntryType): boolean {
  const retained = observersByType.get(type);
  if (retained === undefined) {
    return false;
  }

  // Removed before the call, as in `detachPerf`, so a host that throws is the
  // only thing that puts it back: a `disconnect()` that succeeded must not
  // leave a reference behind for a later detach to disconnect twice.
  observersByType.delete(type);

  try {
    retained.disconnect();
    return false;
  } catch (error) {
    observersByType.set(type, retained);
    reportProducerFailure('perf', 'observer-adopt', error, { entryType: type });
    return true;
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
 * **At most one observer per entry type, across a refused detach.** An
 * observer a previous {@link detachPerf} could not disconnect is still
 * registered with the host for its own entry type, so this function settles
 * that retention per type before it starts anything (see
 * {@link adoptRetainedObserver}): the refused `disconnect()` is retried, and
 * either it succeeds and a fresh observer is started, or the retained observer
 * is adopted as this attachment's observer for that type. The alternative —
 * starting a second observer for a type something is already observing — is
 * the one failure mode that corrupts the numbers rather than losing them: two
 * callbacks would emit and count each of that type's entries twice, and a
 * capture that reports double the long tasks the page ran is worse than one
 * that reports none. An adopted observer counts as started, because the type
 * *is* being observed.
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
 * detached — in the second case holding nothing but an observer the host
 * itself refused to release, which {@link hasPerfResidue} makes visible and
 * the next call adopts or retries rather than duplicating.
 */
export function attachPerf(): void {
  try {
    if (attached) {
      return;
    }

    emittedCounts = freshCounts();
    droppedCount = 0;
    preCaptureCount = 0;
    failureCount = 0;
    unavailableTypes = [];

    // Recorded before the first observer exists, so no entry this attachment
    // delivers can be measured against an instant later than its own arrival.
    captureStartedAt = nowEpochMs();

    if (typeof PerformanceObserver === 'undefined') {
      unavailableTypes = [...OBSERVED_ENTRY_TYPES];
      // Nothing was registered, so this attachment never began: the boundary
      // is cleared with the same reasoning that clears `attached` below, and
      // the unavailable list stays for the readiness report.
      captureStartedAt = undefined;
      return;
    }

    // Published before the loop so a callback that fires during registration —
    // a buffered flush is delivered in a task of its own, but a host is free to
    // be eager — finds the module attached rather than dropping its batch.
    attached = true;

    let started = 0;
    for (const type of OBSERVED_ENTRY_TYPES) {
      // Anything a previous detach retained for this type is settled first: it
      // is either released and replaced, or adopted as this attachment's
      // observer for the type. Either way exactly one observer observes the
      // type afterwards, which is what keeps a capture from counting every
      // entry twice.
      if (adoptRetainedObserver(type)) {
        started += 1;
        continue;
      }

      const observer = startObserver(type);
      if (observer === undefined) {
        unavailableTypes.push(type);
        continue;
      }
      observersByType.set(type, observer);
      started += 1;
    }

    if (started === 0) {
      // Every type was refused. Nothing was registered, so there is nothing to
      // disconnect and no signal to claim: clearing the flag keeps
      // `isPerfAttached()` honest, clearing the boundary keeps
      // `getCaptureStartTime()` honest with it — both report the detached
      // state, which is what this is — and the unavailable list stays for the
      // readiness report, which is the whole value of it.
      //
      // Counted rather than measured as `observersByType.size`, because
      // `started` is the statement being made — "this attachment observes n of
      // the four types" — and an adopted observer counts towards it exactly as
      // a freshly started one does. Reading the container's size would tie a
      // readiness decision to how retention happens to be stored.
      attached = false;
      captureStartedAt = undefined;
    }
  } catch (error) {
    // Registration failed in a way none of the per-type guards covered. The
    // module is returned to fully detached — never attached with an observer
    // it cannot release — and the failure is reported rather than left to be
    // inferred from an empty `perf` signal (AAP 0.5.5).
    detachPerf();
    reportProducerFailure('perf', 'attach', error);
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
 * costs that one observer rather than the teardown.
 *
 * **An observer that refused to disconnect is kept under its entry type, not
 * forgotten.** It is still registered with the host, so releasing the last
 * reference to it would leave the page delivering batches to a callback
 * nothing can ever stop; the reference stays in {@link observersByType} keyed
 * by the type it observes, the failure is reported as an `agent.error` frame
 * (AAP 0.5.5), {@link hasPerfResidue} then answers `true` so `./agent.ts` can
 * name this hook in its `hooks-not-released` announcement, and the next
 * {@link detachPerf} tries again. Keying the retention by type is what lets
 * the next {@link attachPerf} adopt that observer instead of starting a second
 * one for a type already being observed, which would count every entry of the
 * type twice. The module is detached either way — `isPerfAttached()` is
 * `false` and a delivered batch is dropped on arrival — so a retained observer
 * costs a callback that returns immediately, never an event.
 */
export function detachPerf(): void {
  try {
    // Cleared first: a batch delivered while the loop runs must find the
    // module detached and drop itself.
    attached = false;

    // Taken out of the map before the loop so a re-entrant call cannot
    // disconnect the same observer twice, and put back under its own entry
    // type when the host refuses: an observer whose `disconnect()` threw is
    // still registered, so dropping the only reference to it would leave the
    // page holding a callback this module can never release — the opposite of
    // AAP 0.5.1's "disabled, not merely idled". Retained *with its type*, a
    // later {@link detachPerf} retries it and a later {@link attachPerf} knows
    // that type is already being observed instead of starting a second
    // observer for it.
    const pending = [...observersByType];
    observersByType.clear();

    for (const [type, observer] of pending) {
      try {
        observer.disconnect();
      } catch (error) {
        observersByType.set(type, observer);
        reportProducerFailure('perf', 'observer-disconnect', error);
      }
    }

    emittedCounts = freshCounts();
    droppedCount = 0;
    preCaptureCount = 0;
    failureCount = 0;
    unavailableTypes = [];
    captureStartedAt = undefined;
  } catch (error) {
    // Best effort by construction: the steps above are independent, so a
    // failure in one leaves the others done. Reported for the same reason
    // every other guard here reports — a teardown that half-succeeded is a
    // fact about the page, not an internal detail (AAP 0.5.5).
    reportProducerFailure('perf', 'detach', error);
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
 * When the current attachment began, in epoch milliseconds, or `undefined`
 * while detached.
 *
 * The boundary every non-replayed entry is measured against, exposed so that
 * `./agent.ts`'s status frame and a test can state the capture's own window
 * rather than infer it from the events that survived the filter. A reading
 * from `./transport.ts`'s clock, so it is directly comparable with any
 * event's `startTime`.
 *
 * Defined exactly when {@link isPerfAttached} is `true`. The two states agree
 * on every path, including the two on which {@link attachPerf} is asked for a
 * hook the host cannot provide — no `PerformanceObserver` at all, or every
 * entry type refused — because a boundary without an observer behind it would
 * describe a capture that never began.
 */
export function getCaptureStartTime(): number | undefined {
  return captureStartedAt;
}

/**
 * Whether the page still carries an observer this module's last detach
 * could not disconnect — residue, as distinct from an observation.
 *
 * `isPerfAttached()` answers "is this module observing?", which is what a
 * readiness or status frame reports, and it is deliberately `false` after a
 * detach that the host refused: nothing is being harvested and every delivered
 * batch is dropped on arrival. But the observer is still registered, and
 * AAP 0.5.1 requires a cleared hook to be *disabled* rather than idled — so
 * `./agent.ts` needs a second question it can ask, or its
 * `hooks-not-released` announcement could not name which hooks the page is
 * still carrying and a session would end claiming a clean release it did not
 * achieve (AAP 0.5.5). This is that question, with the same name, signature
 * and meaning in every producer of this folder.
 *
 * - `true` while any observer whose `disconnect()` the host refused is still
 *   held. There is exactly one such observer per entry type at most, and the
 *   developer clears them by reloading the tab.
 * - `false` when nothing is retained, and `false` whenever the module is
 *   armed: an armed module's observers are live observation, not residue —
 *   including one adopted from a refused detach, which this attachment is
 *   using as its own (see {@link attachPerf}).
 *
 * Never throws: it reads two module bindings and makes no host call. Cheap
 * enough to ask on every status frame.
 */
export function hasPerfResidue(): boolean {
  return !attached && observersByType.size > 0;
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
    preCapture: preCaptureCount,
    unavailable: [...unavailableTypes],
    failures: failureCount,
  };
}
