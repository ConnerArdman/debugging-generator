/**
 * The capture-signal vocabulary, the **two runtime configuration shapes** that
 * arm the product's two telemetry producers, and the readiness report that
 * gates "Ready to capture" — all defined here, once.
 *
 * `packages/instrumentation/src/schema/**` is a schema source: every shape it
 * declares has a *single* definition, and these three shapes have more
 * independent readers than any other in the package:
 *
 * - `@debuggen/protocol` embeds {@link AgentHookConfig} in `agent.config` and
 *   {@link ServerAgentSignals} in `server-agent.config`.
 * - `apps/local-service/src/instrumentation/service.ts` sends both frames, and
 *   `.../readiness.ts` aggregates the per-adapter {@link Readiness} reports
 *   the six adapters return.
 * - `../installer.ts` derives both configurations from the actions it actually
 *   installed, with {@link deriveAgentHookConfig} and
 *   {@link deriveServerAgentSignals}.
 * - `../adapter.ts` and `./target.ts` consume the {@link CaptureSignal}
 *   vocabulary — the names that appear in an `unavailable` report and in a
 *   readiness row.
 *
 * ## These key names are a wire contract, not an implementation detail
 *
 * Neither consumer of these two configurations can import this module:
 *
 * - The page agent (`packages/telemetry/src/browser/agent.ts`) is bundled into
 *   an IIFE injected into the developer's page at `document_start`; its build
 *   refuses a cross-package runtime dependency. It therefore parses an inbound
 *   `agent.config` **structurally and permissively** — optional flags,
 *   alias-tolerant names, unknown keys ignored — which means a key renamed
 *   here does not fail anywhere: the hook is simply never attached, the
 *   developer reproduces their problem exactly as asked, and the capture comes
 *   back missing the evidence. Its canonical flag names are therefore
 *   {@link AGENT_HOOK_KEYS} verbatim, and its own alias list carries the older
 *   spellings (`interaction`, `renders`, `network`, `performance`, `error`) so
 *   that a service built against an earlier revision of that file still arms
 *   the right signal.
 * - The dev-server preload (`packages/telemetry/src/node/control.ts`) sits
 *   *below* this package in the workspace layering — `@debuggen/telemetry`
 *   may not import `@debuggen/instrumentation` — so it too keeps its own
 *   structural mirror of {@link ServerAgentSignals} and of the signal→kind
 *   policy. Its six key names are the same six declared here, and
 *   the five server rows of {@link CAPTURE_SIGNAL_TO_TELEMETRY_KIND} are the
 *   exact mirror of its `SIGNAL_KINDS` table.
 *
 * `readiness.test.ts` therefore asserts the key sets and those rows
 * mechanically. A rename that passes the compiler and the suite does not exist;
 * one that passes the compiler alone is a silently disabled signal.
 *
 * ## What this module deliberately does not carry
 *
 * **No human-facing labels.** The progress wording a developer reads while a
 * session prepares ("Browser performance", "React renders", "Network tracing",
 * "Server spans", "Database tracing" — the rows the progress display lists
 * under "Preparing instrumentation" before "Ready to capture") belongs to
 * `apps/local-service/src/sessions/progress.ts`, and the `reason`/`hint` text
 * of an unavailable signal belongs to the adapter that could not enable it. A
 * label table here would be a second source of truth for strings this module
 * has no way to keep correct, so the signal *names* below are identifiers —
 * chosen to read sensibly inside "Could not enable ‹signal›: ‹reason›." — and
 * nothing more.
 *
 * **No adapter ids.** Which adapter claims which signal lives in
 * `../registry.ts`, which imports this folder; asking the question here would
 * close a cycle. Where a derivation needs to know that an action belongs to
 * the server tier, it asks the caller through {@link ActionTierResolver}.
 *
 * ## Shape rules
 *
 * Every shape below is JSON-only — no `Date`, no `Map`, no `Set`, no class
 * instance — because all three cross a WebSocket and two are persisted on the
 * session record. The module imports no Node builtin, touches no filesystem,
 * reads no environment variable, schedules nothing and has no module-load side
 * effect beyond declaring its constants.
 */

import { z } from 'zod';

import { DebuggenError, err, nowEpochMs, ok } from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import type { TelemetryKind } from '@debuggen/telemetry';

import type {
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationMode,
} from './plan.js';

// ---------------------------------------------------------------------------
// Bounds
//
// Every string and array below is bounded, for the same reason `./plan.ts`
// bounds its fields: these values are persisted on the session record, sent
// over two transports and rendered in two user interfaces, and one of their
// producers — an adapter reporting why a signal is unavailable — composes prose
// at runtime. The numbers mirror `./plan.ts` where the same field exists there,
// so a symbol name that a plan accepts is a symbol name this module accepts.
// ---------------------------------------------------------------------------

/** Longest accepted symbol name, in characters. Mirrors `./plan.ts`. */
const MAX_SYMBOL_LENGTH = 200;

/** Longest accepted adapter id, in characters. Mirrors `./plan.ts`. */
const MAX_ADAPTER_ID_LENGTH = 64;

/**
 * Longest accepted readiness `reason`, in characters.
 *
 * A reason is the fragment that reads after "Could not enable ‹signal›: " in
 * the unavailable-signal message: one explanation, never a command or a stack
 * trace, so five hundred characters is far more than an honest one needs. It
 * is narrower than the 2000 characters `@debuggen/protocol` allows on
 * `instrumentation.ready`'s reason, which is the safe direction: a reason this
 * layer accepts is one the transport accepts too.
 *
 * Exported so an adapter composing a reason at runtime measures it against this
 * number rather than restating it.
 */
export const READINESS_REASON_MAX_LENGTH = 500;

/**
 * Longest accepted readiness `hint`, in characters.
 *
 * Wider than {@link READINESS_REASON_MAX_LENGTH} because a hint legitimately
 * carries a command: when the dev server was started without the preload, the
 * server-signal hint names the exact command that relaunches it with the
 * preload attached, and that command embeds an absolute project root, a
 * preload specifier and a dev command whose lengths this product does not
 * choose. A bound sized for a sentence would cut exactly the part of the row a
 * developer copies.
 *
 * Equal to `@debuggen/protocol`'s `MAX_HINT_LENGTH`, the bound on the same
 * words when they travel as `instrumentation.ready`'s unavailable-signal hint
 * and as `instrumentation.failed`'s error hint: a hint this layer accepts can
 * never be refused by the transport, and none the transport could carry is
 * refused here. The equality is stated here rather than imported because
 * `@debuggen/protocol` depends on this package, not the reverse, and keeps its
 * own constant module-local.
 *
 * Exported so an adapter composing a hint at runtime can fit it to this number
 * — dropping prose before it would ever cut a command — rather than restating it.
 */
export const READINESS_HINT_MAX_LENGTH = 1000;

/**
 * Most readiness rows one report may carry.
 *
 * A single adapter reports on the signals it claims — at most a handful — and
 * the service aggregates several reports into its own view rather than growing
 * one. Thirty-two is therefore far above any real report and still low enough
 * that a runaway producer is refused rather than rendered.
 */
const MAX_READINESS_SIGNALS = 32;

/**
 * Most patched symbols one {@link ServerAgentSignals} may name.
 *
 * Twice `./plan.ts`'s ceiling of 64 targets per plan, so a configuration
 * derived from a validated plan cannot reach it — which is deliberate: the
 * derivations below never truncate, because silently dropping a symbol would
 * discard the one signal a developer paid a file modification for. An
 * over-long list is refused here, loudly, instead.
 */
const MAX_FUNCTION_SYMBOLS = 128;

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

/** Highest code point of the C0 control block. */
const C0_CONTROL_MAX = 0x1f;

/** Lowest code point of the DEL/C1 control block. */
const C1_CONTROL_MIN = 0x7f;

/** Highest code point of the C1 control block. */
const C1_CONTROL_MAX = 0x9f;

/**
 * Whether `value` is usable as a single line of display text: at least one
 * non-whitespace character, and no control character at all.
 *
 * Applied to every string in this module — an adapter id, a symbol name, a
 * `reason` and a `hint`. The two rules are there for different readers. Blank
 * rejection keeps an empty badge out of the VS Code modifications list and the
 * panel's session summary, where a readiness row is rendered as text. The
 * single-line rule is what makes the unavailable-signal message — "Could not
 * enable ‹signal›: ‹reason›." — a sentence: a `reason` carrying a line feed
 * would break the message in two, and a symbol name carrying one is not a name
 * in any language this product indexes.
 */
function isSingleLineText(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= C0_CONTROL_MAX || (code >= C1_CONTROL_MIN && code <= C1_CONTROL_MAX)) {
      return false;
    }
  }

  return true;
}

/**
 * The single-line rule stated once, because four fields quote it and a
 * rendered JSON Schema cannot carry the refinement it belongs to.
 */
const SINGLE_LINE_RULE_MESSAGE =
  'must be a single line with at least one non-whitespace character and no control character.';

/**
 * Maps validation issues to `{ path, message }` pairs, dropping the rejected
 * values.
 *
 * The same privacy rule `./modification.ts` applies, for the same reason: an
 * error raised this deep never passes through the telemetry redaction layer
 * (`packages/telemetry/src/redaction/`), and it is logged, persisted with the
 * session and rendered in two user interfaces. A readiness `hint` can name a
 * path inside the developer's home directory and a `functions` list is a slice
 * of their symbol names, so what goes into `details` is the *shape* of the
 * failure — which field, and what the schema expected — never the data that
 * caused it. Field paths and the schema's own messages are everything a
 * producer needs in order to be fixed.
 *
 * @param error The Zod error from a failed `safeParse`.
 * @returns One entry per issue, `path` being the dotted path of the offending
 * field (the empty string for an issue on the value itself).
 */
function collectIssues(error: z.ZodError): ReadonlyArray<{ path: string; message: string }> {
  // `issue.path` segments may be array indices as well as keys, so each is
  // stringified before joining.
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}

/**
 * Builds the error a schema rejection in this module is reported as.
 *
 * `'PROTOCOL_INVALID_MESSAGE'` for all three parsers, because all three shapes
 * normally arrive over a transport: a hook configuration and a signal set reach
 * a producer inside `agent.config` and `server-agent.config`, and a readiness
 * report reaches the editor and the panel inside a progress frame. A caller
 * validating a value that no transport delivered — an adapter's own report
 * constructed in process, a row read back from the session store — should
 * `mapErr` it to the code that describes *its* operation (`'INTERNAL'` and
 * `'STORE_ERROR'` respectively); the field paths are the part that matters
 * either way.
 *
 * @param subject What failed, as a sentence fragment that reads after "did not
 * match".
 * @param hint The developer's, or the producer's, next step.
 * @param error The Zod error from a failed `safeParse`.
 */
function rejection(subject: string, hint: string, error: z.ZodError): DebuggenError {
  return new DebuggenError('PROTOCOL_INVALID_MESSAGE', `A value did not match ${subject}.`, {
    hint,
    details: { issues: collectIssues(error) },
  });
}

// ---------------------------------------------------------------------------
// The capture-signal vocabulary
//
// One name per thing a capture can observe, across both tiers. These are the
// names a readiness row is keyed by, the names an install's `unavailable`
// report carries, and the names an adapter's capability catalog is written in.
// ---------------------------------------------------------------------------

/**
 * Every signal a capture can ask for: the seven browser signals first, then
 * the five that only the dev-server process can supply.
 *
 * The list is closed, and each name corresponds to a *mechanism* that already
 * exists rather than to a wish:
 *
 * - `interactions` — the capture-phase listener plus event-timing entries that
 *   mint a trace root (`packages/telemetry/src/browser/interaction.ts`).
 * - `react` — renders and commits from the fiber hook the agent installs
 *   before React loads (`.../browser/react.ts`).
 * - `state` — hook state transitions, derived during a commit
 *   (`.../browser/state.ts`).
 * - `fetch` — the patched `fetch` and `XMLHttpRequest`, which is also what
 *   injects the trace-context header (`.../browser/fetch.ts`).
 * - `perf` — long tasks, resource, navigation and paint entries
 *   (`.../browser/perf.ts`).
 * - `errors` — page errors and unhandled rejections (`.../browser/errors.ts`).
 * - `componentTree` — the component-tree snapshot taken at the last commit of
 *   the capture (`.../browser/react.ts`, emitted by `.../browser/agent.ts`).
 * - `http` — the framework's incoming-request spans, where the browser's
 *   `traceparent` is extracted.
 * - `routeHandlers` — the framework's App Router route-handler spans.
 * - `prisma` — query spans from the ORM's instrumentation.
 * - `pg` — query spans from the driver's instrumentation.
 * - `functions` — spans around the named symbols a `patch`-mode action wrapped.
 *
 * Order is browser-then-server and is preserved rather than sorted, because
 * that is the order the two configuration shapes below, the readiness rows and
 * the progress display's signal rows are read in.
 */
export const CAPTURE_SIGNALS = [
  'interactions',
  'react',
  'state',
  'fetch',
  'perf',
  'errors',
  'componentTree',
  'http',
  'routeHandlers',
  'prisma',
  'pg',
  'functions',
] as const;

/**
 * One member of the closed capture-signal vocabulary.
 *
 * Derived from {@link CAPTURE_SIGNALS} rather than declared beside it, so the
 * runtime list and the static type cannot drift.
 */
export type CaptureSignal = (typeof CAPTURE_SIGNALS)[number];

/**
 * Validator for a single signal name, used by {@link readinessSignalSchema} and
 * by anything that accepts a signal name from another process.
 *
 * Built from the tuple directly, so the twelve strings are never repeated. A
 * rejection names the whole accepted vocabulary, which is what a producer needs
 * in order to be fixed.
 */
export const captureSignalSchema = z.enum(CAPTURE_SIGNALS);

/**
 * Widened view of {@link CAPTURE_SIGNALS} used by {@link isCaptureSignal}.
 *
 * The annotation is the point: it lets an arbitrary `string` be tested for
 * membership without the predicate asserting anything about the value under
 * test.
 */
const CAPTURE_SIGNAL_VALUES: readonly string[] = CAPTURE_SIGNALS;

/**
 * Whether a value is one of the twelve capture signals.
 *
 * The boolean form, for paths that classify a value where no schema is in play:
 * an adapter deciding whether a planned signal is one it claims, a stored
 * readiness row being triaged before it is parsed. Where the answer has to
 * explain itself, parse instead.
 *
 * @param value Any value.
 * @returns `true` when `value` is a member of {@link CAPTURE_SIGNALS},
 * narrowing it to {@link CaptureSignal}.
 */
export function isCaptureSignal(value: unknown): value is CaptureSignal {
  return typeof value === 'string' && CAPTURE_SIGNAL_VALUES.includes(value);
}

/**
 * The signals the page agent supplies — the key set of
 * {@link AgentHookConfig}.
 *
 * Note `fetch` appears here **and** in {@link SERVER_CAPTURE_SIGNALS}, and it
 * is the only name that does. That is deliberate rather than an oversight: the
 * browser tier's `fetch`/`xhr` events and the dev server's *outgoing*
 * `http.client` spans are the same signal seen from the two ends of a request,
 * and a plan that asks for request tracing wants both. It is also why each
 * configuration shape below carries its own `fetch` key: the two producers are
 * armed independently, and a capture can legitimately have one without the
 * other.
 */
export const BROWSER_CAPTURE_SIGNALS = [
  'interactions',
  'react',
  'state',
  'fetch',
  'perf',
  'errors',
  'componentTree',
] as const satisfies readonly CaptureSignal[];

/**
 * The signals the dev-server preload supplies — the key set of
 * {@link ServerAgentSignals}, in the key order of the `signals` payload that
 * `server-agent.config` carries.
 *
 * See {@link BROWSER_CAPTURE_SIGNALS} for why `fetch` is in both lists.
 */
export const SERVER_CAPTURE_SIGNALS = [
  'http',
  'routeHandlers',
  'fetch',
  'prisma',
  'pg',
  'functions',
] as const satisfies readonly CaptureSignal[];

/**
 * Which telemetry kinds each signal is responsible for.
 *
 * The table exists so the question "what evidence does this signal actually
 * produce?" has one answer, readable in one place, for three consumers: the
 * service's readiness module when it explains a missing signal, the analysis
 * stage when it decides whether the evidence a question needs is present, and
 * `readiness.test.ts`, which iterates it so no row can be forgotten.
 *
 * Three rows repay a second look.
 *
 * - **The five server rows are the exact mirror of
 *   `packages/telemetry/src/node/control.ts`'s `SIGNAL_KINDS`**: `http` →
 *   `http.server`, `routeHandlers` → `route.handler`, `prisma` → `db.query`,
 *   `pg` → `db.query`, `functions` → `function`. That file is the gate which
 *   actually drops a span whose kind no enabled signal admits, and it cannot
 *   import this one (it sits below this package), so the two tables are kept
 *   equal by a test rather than by a shared import. `prisma` and `pg` share
 *   `db.query` because the kind describes the operation, not which library
 *   reported it.
 * - **`fetch` is a deliberate superset** of that file's `fetch` →
 *   `http.client` row: the same signal name also covers the browser's `fetch`
 *   and `xhr` kinds, which the preload never sees and therefore never had to
 *   name.
 * - **`componentTree` names the kinds the service reconstructs the snapshot
 *   from**, not a kind of its own. The snapshot arrives as a commit-time event
 *   and the tree's per-node render counts come from `render` events, so the
 *   signal is gated by the agent hook flag rather than by a kind of its own.
 *
 * `as const satisfies` and not a plain annotation: the `satisfies` clause
 * checks every string against the real {@link TelemetryKind} union, so a typo
 * in a kind name fails the build, while `as const` keeps the literal tuples so
 * a reader of {@link telemetryKindsForSignal}'s result sees exactly which kinds
 * a signal admits.
 */
export const CAPTURE_SIGNAL_TO_TELEMETRY_KIND = {
  interactions: ['interaction'],
  react: ['render', 'commit'],
  state: ['state'],
  fetch: ['fetch', 'xhr', 'http.client'],
  perf: ['perf.longtask', 'perf.entry', 'navigation'],
  errors: ['error'],
  componentTree: ['commit', 'render'],
  http: ['http.server'],
  routeHandlers: ['route.handler'],
  prisma: ['db.query'],
  pg: ['db.query'],
  functions: ['function'],
} as const satisfies Readonly<Record<CaptureSignal, readonly TelemetryKind[]>>;

/**
 * The kinds one signal is responsible for.
 *
 * A function rather than leaving callers to index the table, so the lookup
 * reads the same everywhere and the table stays free to grow a second column
 * later without a caller having to change.
 *
 * @param signal The signal to describe.
 * @returns Its kinds, in declaration order. Never empty: every signal in the
 * vocabulary produces at least one kind.
 */
export function telemetryKindsForSignal(signal: CaptureSignal): readonly TelemetryKind[] {
  return CAPTURE_SIGNAL_TO_TELEMETRY_KIND[signal];
}

// ---------------------------------------------------------------------------
// The readiness report
//
// What an adapter answers when asked whether the signals it claims can
// actually be collected here, and the artifact the "Ready to capture" state of
// the session progress display is computed from.
// ---------------------------------------------------------------------------

/**
 * How ready one signal is.
 *
 * - `'available'` — it will be collected.
 * - `'degraded'` — it will be collected, with a stated limitation: a
 *   performance entry type this browser does not implement, a React build
 *   without development-mode timings. Capture proceeds and the limitation is
 *   recorded, so the analysis stage can qualify what it concludes.
 * - `'unavailable'` — it will not be collected at all. The developer-facing
 *   "Could not enable ‹signal›: ‹reason›. Continuing with: ‹enabled list›."
 *   is this status being reported.
 *
 * The three-way split is what lets readiness gate a capture without blocking
 * it for a partial signal: {@link buildReadiness} treats `'degraded'` as ready
 * and `'unavailable'` as not, which is the difference between "we will tell
 * you less than we hoped" and "we will not answer your question".
 */
export const READINESS_STATUSES = ['available', 'degraded', 'unavailable'] as const;

/** One member of the closed readiness-status vocabulary. */
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

/** Validator for a single readiness status, used by {@link readinessSignalSchema}. */
export const readinessStatusSchema = z.enum(READINESS_STATUSES);

/**
 * One row of a readiness report: a signal, how ready it is, and — when it is
 * not fully ready — why, and what to do about it.
 *
 * `reason` and `hint` are optional because an `'available'` row has nothing to
 * explain, and absent rather than empty because the whole report is
 * transported and persisted as JSON, where an absent key is the one
 * representation every layer agrees on.
 *
 * Both strings are the adapter's own words, because only the adapter that
 * could not enable a signal knows why: this module bounds them and refuses a
 * blank or multi-line value, and says nothing about their content.
 */
export const readinessSignalSchema = z.strictObject({
  /** The signal this row is about. */
  signal: captureSignalSchema,

  /** How ready it is. */
  status: readinessStatusSchema,

  /**
   * Why it is not fully ready, in the adapter's words.
   *
   * Reads after "Could not enable ‹signal›: ", so it is a fragment stating the
   * obstacle — not a sentence about the product, and never a stack trace.
   * Bounded by {@link READINESS_REASON_MAX_LENGTH}.
   */
  reason: z
    .string()
    .min(1)
    .max(READINESS_REASON_MAX_LENGTH)
    .refine(isSingleLineText, { error: `reason ${SINGLE_LINE_RULE_MESSAGE}` })
    .optional(),

  /**
   * What the developer can do about it.
   *
   * The recovery path, and what makes an unavailable signal actionable rather
   * than merely honest: for a missing server signal this is the exact command
   * that relaunches the dev server with the preload attached.
   * Bounded by {@link READINESS_HINT_MAX_LENGTH}, which is wider than the
   * reason's because a command carries paths a sentence does not.
   */
  hint: z
    .string()
    .min(1)
    .max(READINESS_HINT_MAX_LENGTH)
    .refine(isSingleLineText, { error: `hint ${SINGLE_LINE_RULE_MESSAGE}` })
    .optional(),
});

/** One row of a readiness report. */
export type ReadinessSignal = z.infer<typeof readinessSignalSchema>;

/**
 * One producer's answer to "can the signals you claim be collected here?".
 *
 * Returned by every adapter's `readiness(context)` and aggregated by the
 * service; see {@link buildReadiness} for the division of labour.
 *
 * `z.strictObject`: an unknown key is rejected rather than stripped. A report
 * gates whether a developer is told to reproduce their problem, and a producer
 * sending a field this version does not understand is a version mismatch worth
 * surfacing rather than losing quietly.
 */
export const readinessSchema = z.strictObject({
  /**
   * Whether this producer is ready.
   *
   * Carried on the report rather than recomputed by every reader, so the
   * derivation lives in exactly one place ({@link buildReadiness}) and a stored
   * report says what it said when it was taken. A reader that disagrees with
   * the rows is reading a report built by something other than that
   * constructor, which is a defect worth being able to see.
   */
  ready: z.boolean(),

  /**
   * Which adapter produced the report, when one did.
   *
   * A **bounded string, not an enumeration**, for the reason `./plan.ts`'s
   * `adapter` field is one: adapter identity belongs to `../registry.ts`, a
   * third-party adapter may register at runtime, and this folder does not make
   * that import. Optional because the service's own aggregate report — which
   * adds the non-adapter preconditions — belongs to no single adapter.
   */
  adapter: z
    .string()
    .min(1)
    .max(MAX_ADAPTER_ID_LENGTH)
    .refine(isSingleLineText, { error: `adapter ${SINGLE_LINE_RULE_MESSAGE}` })
    .optional(),

  /**
   * The per-signal rows, in the producer's own order.
   *
   * May be empty: an adapter that claims nothing in this project is ready and
   * has nothing to say, which is a different statement from an adapter whose
   * signals are all unavailable.
   */
  signals: z.array(readinessSignalSchema).max(MAX_READINESS_SIGNALS),

  /**
   * When the report was taken, in epoch milliseconds.
   *
   * Readiness is a statement about a moment: a dev server can stop answering
   * and a page can navigate away between a check and a capture, so a report
   * that could not say when it was taken could not be aged out. `z.number()`
   * in Zod 4 already refuses `NaN` and both infinities, and `.positive()`
   * refuses `0` and a negative clock — which is what a stubbed clock returning
   * a falsy default looks like.
   */
  checkedAt: z.number().positive(),
});

/**
 * A producer's readiness report.
 *
 * Inferred from {@link readinessSchema}, so the validator and the type are the
 * same statement.
 */
export type Readiness = z.infer<typeof readinessSchema>;

/**
 * Validates an unknown value as a {@link Readiness}, without throwing.
 *
 * This is how a report that arrived from somewhere else becomes a typed value:
 * a progress payload received by an extension, a row read back from the session
 * store, a report handed to the service by an adapter it did not construct.
 *
 * See {@link rejection} for the error's anatomy and for when to re-code it.
 *
 * @param value Any value believed to be a readiness report.
 * @returns `ok(readiness)` with the parsed report, or `err(error)` describing
 * every issue found.
 */
export function parseReadiness(value: unknown): Result<Readiness> {
  const parsed = readinessSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    rejection(
      'the readiness report schema',
      'A readiness report needs a boolean `ready`, an array of `{ signal, status }` rows naming known signals and statuses, and a positive epoch-millisecond `checkedAt`.',
      parsed.error,
    ),
  );
}

/**
 * Everything {@link buildReadiness} needs that it cannot derive.
 *
 * Every member is `readonly`, and the constructor never mutates what it is
 * given.
 */
export interface BuildReadinessInput {
  /** The reporting adapter's id, where the report belongs to one. */
  readonly adapter?: string;

  /** The per-signal rows. May be empty. */
  readonly signals: readonly ReadinessSignal[];

  /**
   * Clock injection point, defaulting to `nowEpochMs()`.
   *
   * Present so a suite can assert an exact `checkedAt` without freezing time
   * globally — the same reason `./modification.ts` accepts an injected clock.
   */
  readonly now?: () => number;
}

/**
 * Builds a {@link Readiness} from its rows, deriving `ready` once.
 *
 * The constructor the six adapters use, so that the ready-derivation is stated
 * in one place: **`ready` is true when no row is `'unavailable'`** — a
 * `'degraded'` row does not block a capture, an `'unavailable'` one does (see
 * {@link READINESS_STATUSES}) — and an empty row list is ready, because an
 * adapter with nothing to claim cannot hold a capture back.
 *
 * What this function deliberately does **not** do is aggregate. Combining
 * several adapters' reports is the service's job
 * (`apps/local-service/src/instrumentation/readiness.ts`), and it is a
 * different question: alongside the rows, that module adds the preconditions
 * no adapter can see — a relayed `agent.ready` for the bound tab's current
 * document with `installedBeforeReact = true`, and a connected `server-agent`
 * for the project whenever server signals are planned — and turns the result
 * into the "Ready to capture" state.
 *
 * It is a constructor, not a validator: it copies its input, derives the two
 * fields it owns and returns. A blank adapter id or an over-long row list
 * produces a report {@link parseReadiness} rejects at the boundary it crosses,
 * which is the loud failure that belongs there rather than a silent repair
 * here.
 *
 * @param input The rows, the optional adapter id and the optional clock.
 * @returns A fresh report. The `signals` array and each row are copies, so a
 * later mutation of the caller's array cannot change a report already handed
 * out, and the object is JSON-serialisable with no key present-and-undefined.
 *
 * @example
 * ```ts
 * return buildReadiness({
 *   adapter: this.id,
 *   signals: [{ signal: 'prisma', status: 'unavailable', reason: 'no preload is attached' }],
 * });
 * ```
 */
export function buildReadiness(input: BuildReadinessInput): Readiness {
  const signals = input.signals.map((signal) => ({ ...signal }));
  const ready = signals.every((signal) => signal.status !== 'unavailable');
  const checkedAt = (input.now ?? nowEpochMs)();

  // The adapter key is added only when there is one to add: an explicit
  // `adapter: undefined` survives in memory but not through JSON, and a shape
  // that changes across a transport is a shape two readers disagree about.
  if (input.adapter === undefined) {
    return { ready, signals, checkedAt };
  }

  return { ready, adapter: input.adapter, signals, checkedAt };
}

// ---------------------------------------------------------------------------
// `AgentHookConfig` — what arms the page agent
//
// Sent as `agent.config { sessionId, captureId, hooks }`, and sent again with
// every flag false to return the agent to dormant when a capture ends. The
// seven keys mirror the page agent's attach functions one for one.
// ---------------------------------------------------------------------------

/**
 * Which signals the page agent should observe.
 *
 * All seven flags are **required**, not optional, and that is the point rather
 * than strictness for its own sake: cleanup *disables* runtime hooks rather
 * than *idling* them (`docs/ARCHITECTURE.md`, "End-of-session guarantee"), and
 * "every flag explicitly false" is how the disabled state is expressed. An
 * optional flag would make the dormant configuration and a partially-specified
 * one indistinguishable on the wire, and cleanup would have no way to say
 * "detach everything" that a reader could tell apart from "I did not mention
 * these".
 *
 * Each key names the hook it arms:
 *
 * | Key | Page agent |
 * | --- | --- |
 * | `interactions` | `attachInteractions()` |
 * | `react` | `attachReact()` |
 * | `state` | `attachState()` |
 * | `fetch` | `attachFetch()` |
 * | `perf` | `attachPerf()` |
 * | `errors` | `attachErrors()` |
 * | `componentTree` | `snapshotComponentTree()` at the capture's last commit |
 *
 * **This schema is the canonical producer-side definition.** The agent parses
 * an inbound configuration permissively — flags optional, names
 * alias-tolerant, unknown keys ignored — because it cannot import this module
 * (see this file's header), so a key renamed here does not fail: it silently
 * stops a hook from ever being attached. `readiness.test.ts` pins the key set
 * for that reason.
 *
 * `z.strictObject`: a key the sender invented is rejected rather than stripped,
 * so a service and an agent built from different versions of this contract
 * surface as a refused frame instead of a capture missing evidence nobody
 * ordered.
 */
export const agentHookConfigSchema = z.strictObject({
  /**
   * User interactions — and, because of them, the trace root.
   *
   * Never merely one signal among seven: `../../telemetry`'s
   * `browser/interaction.ts` mints the trace id every other browser event is
   * attributed to. See {@link deriveAgentHookConfig} for why the derivation
   * forces this flag on whenever anything else is on.
   */
  interactions: z.boolean(),

  /** React renders and commits, from the fiber hook. */
  react: z.boolean(),

  /**
   * React hook state transitions.
   *
   * Emitted from inside a commit by `browser/react.ts`, which is why
   * {@link deriveAgentHookConfig} treats `react` as a hard prerequisite for
   * this flag.
   */
  state: z.boolean(),

  /**
   * `fetch` and `XMLHttpRequest`, and the `traceparent` header on a
   * same-origin request that joins the browser trace to the server one.
   */
  fetch: z.boolean(),

  /** Performance entries: long tasks, resources, navigation and paint. */
  perf: z.boolean(),

  /** Page errors and unhandled rejections. */
  errors: z.boolean(),

  /**
   * The component-tree snapshot taken at the capture's last commit.
   *
   * Separate from `react` on the wire even though the agent can only produce a
   * tree while the fiber hook is attached: the snapshot is a distinct,
   * page-visiting piece of work at capture stop, and a capture that wants
   * render counts without a tree is a capture that should not pay for it.
   *
   * Being separate makes it the one flag that arms no observer, so the agent
   * honours it differently from the other six: it stores the flag as an
   * *authorisation*, takes the snapshot only when the flag is true and the
   * React hook is attached, and reports a request it cannot meet as an
   * unavailable `componentTree` signal rather than leaving the panel with an
   * empty node (`browser/agent.ts`'s `maybeEmitComponentTreeSnapshot`). An
   * on-demand snapshot request relayed to the page is governed by the same
   * authorisation: the frame asks when, this flag decides whether.
   */
  componentTree: z.boolean(),
});

/**
 * The hook configuration the service sends to the page agent.
 *
 * Inferred from {@link agentHookConfigSchema}. `@debuggen/protocol` embeds this
 * type in `agent.config`; nothing redefines it.
 */
export type AgentHookConfig = z.infer<typeof agentHookConfigSchema>;

/**
 * The seven hook keys, for iteration.
 *
 * Declared *after* the schema and checked against it with `satisfies`, which
 * gives the parity a compiler check in both directions rather than a comment: a
 * key here that the schema does not have fails this clause, and a key the
 * schema has that is missing here fails {@link deriveAgentHookConfig}, whose
 * `Record<AgentHookKey, boolean>` would then be missing a required property of
 * {@link AgentHookConfig}.
 *
 * Order is the browser-signal order of {@link BROWSER_CAPTURE_SIGNALS}; the
 * agent attaches in its own order, and that order is its business.
 */
export const AGENT_HOOK_KEYS = [
  'interactions',
  'react',
  'state',
  'fetch',
  'perf',
  'errors',
  'componentTree',
] as const satisfies readonly (keyof AgentHookConfig)[];

/** One key of {@link AgentHookConfig}. */
export type AgentHookKey = (typeof AGENT_HOOK_KEYS)[number];

/**
 * Validates an unknown value as an {@link AgentHookConfig}, without throwing.
 *
 * For the readers that receive a configuration rather than build one: the
 * Chrome service worker relaying `agent.config` to a bound tab, a test
 * asserting what the service sent.
 *
 * @param value Any value believed to be a hook configuration.
 * @returns `ok(config)` with the parsed configuration, or `err(error)`
 * describing every issue found.
 */
export function parseAgentHookConfig(value: unknown): Result<AgentHookConfig> {
  const parsed = agentHookConfigSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    rejection(
      'the agent hook configuration schema',
      'A hook configuration needs all seven boolean flags present — interactions, react, state, fetch, perf, errors, componentTree — and no other key.',
      parsed.error,
    ),
  );
}

/**
 * Every hook off: the configuration that returns the page agent to dormant.
 *
 * This is what the service sends when a capture stops, when a session ends and
 * during cleanup. Receiving it makes the agent detach its listeners, restore
 * the original `fetch` and `XMLHttpRequest`, and unsubscribe its fiber-hook
 * handlers — disabled, not idled.
 *
 * Frozen, and safe to hand out directly: every value is a boolean, so there is
 * nothing inside it a recipient could mutate. {@link deriveAgentHookConfig}
 * still returns a fresh copy, because its result is something the caller may
 * reasonably keep and adjust.
 */
export const DORMANT_AGENT_HOOK_CONFIG: AgentHookConfig = Object.freeze({
  interactions: false,
  react: false,
  state: false,
  fetch: false,
  perf: false,
  errors: false,
  componentTree: false,
});

// ---------------------------------------------------------------------------
// `ServerAgentSignals` — what arms the dev-server preload
//
// Sent as `server-agent.config { sessionId?, captureId?, signals }`, where an
// absent `captureId` means disable. The six key names are the ones
// `packages/telemetry/src/node/control.ts` reads structurally.
// ---------------------------------------------------------------------------

/**
 * Which signals the dev-server preload should collect.
 *
 * The key names are a **wire contract**: the preload parses this object key
 * by key without importing this module, and its gate drops every span whose
 * kind no enabled signal admits. A rename here therefore does not fail a
 * build — it silently disables a signal, and the developer gets a capture
 * missing the backend evidence their question needed.
 *
 * `functions` is a list rather than a flag because function timing is planned
 * per symbol: it is the one signal that costs a modification to the
 * developer's file, so it is never enabled wholesale.
 *
 * `z.strictObject`, for the reason {@link agentHookConfigSchema} is strict.
 */
export const serverAgentSignalsSchema = z.strictObject({
  /**
   * Incoming request spans.
   *
   * The server-side root of a correlated trace: this is the span the browser's
   * `traceparent` is extracted into, so every other server span hangs off it.
   */
  http: z.boolean(),

  /** App Router route-handler spans. */
  routeHandlers: z.boolean(),

  /**
   * Outgoing server-side request spans.
   *
   * The dev server's own `fetch` calls — how a call to an external service
   * reaches the correlated trace's timeline as a child of the route handler
   * that made it. Distinct from the browser's `fetch` flag; see
   * {@link BROWSER_CAPTURE_SIGNALS}.
   */
  fetch: z.boolean(),

  /** Query spans from the ORM's instrumentation. */
  prisma: z.boolean(),

  /** Query spans from the driver's instrumentation. */
  pg: z.boolean(),

  /**
   * The named symbols whose patched bodies emit `function`-kind spans through
   * `globalThis.__DEBUGGEN__.span`.
   *
   * A **non-empty list is what admits that kind** at all: the preload's gate
   * treats the list's presence as the switch, because a function span's name
   * comes from the patch this plan itself applied, so an unplanned function
   * span cannot exist and filtering by name could only discard a wanted one.
   * The list is still sent because it is the record of what was patched, and
   * because it lets a future refinement narrow the gate without a protocol
   * change.
   *
   * Kept deterministically ordered by {@link deriveServerAgentSignals}
   * (deduplicated, then sorted) so two identical plans produce byte-identical
   * frames.
   */
  functions: z
    .array(
      z
        .string()
        .min(1)
        .max(MAX_SYMBOL_LENGTH)
        .refine(isSingleLineText, { error: `each function name ${SINGLE_LINE_RULE_MESSAGE}` }),
    )
    .max(MAX_FUNCTION_SYMBOLS),
});

/**
 * The signal set the service sends to the dev-server preload.
 *
 * Inferred from {@link serverAgentSignalsSchema}. `@debuggen/protocol` embeds
 * this type in `server-agent.config`; `packages/telemetry/src/node/control.ts`
 * keeps a structural mirror because it sits below this package and may not
 * import it.
 */
export type ServerAgentSignals = z.infer<typeof serverAgentSignalsSchema>;

/**
 * The six signal keys, for iteration.
 *
 * Declared after the schema and `satisfies`-checked against it, for the reason
 * {@link AGENT_HOOK_KEYS} is; the omission direction is covered by
 * {@link deriveServerAgentSignals}, which returns an object literal typed as
 * {@link ServerAgentSignals} and so cannot omit a key.
 */
export const SERVER_AGENT_SIGNAL_KEYS = [
  'http',
  'routeHandlers',
  'fetch',
  'prisma',
  'pg',
  'functions',
] as const satisfies readonly (keyof ServerAgentSignals)[];

/** One key of {@link ServerAgentSignals}. */
export type ServerAgentSignalKey = (typeof SERVER_AGENT_SIGNAL_KEYS)[number];

/**
 * Validates an unknown value as a {@link ServerAgentSignals}, without throwing.
 *
 * For the readers that receive a signal set rather than build one, and for the
 * assertions that keep the derivation honest.
 *
 * @param value Any value believed to be a server signal set.
 * @returns `ok(signals)` with the parsed set, or `err(error)` describing every
 * issue found.
 */
export function parseServerAgentSignals(value: unknown): Result<ServerAgentSignals> {
  const parsed = serverAgentSignalsSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    rejection(
      'the server agent signal schema',
      'A server signal set needs the five boolean flags http, routeHandlers, fetch, prisma and pg, a `functions` array of non-empty single-line names, and no other key.',
      parsed.error,
    ),
  );
}

/**
 * Every server signal off and no patched symbols: what the service sends
 * whenever no capture is active.
 *
 * `server-agent.config` with no `captureId` carries this set, and receiving it
 * makes the preload disable its instrumentations and drop its tracer provider
 * so the framework's own spans become no-ops. It is also the value
 * {@link deriveServerAgentSignals} reports — as a fresh, value-equal object —
 * for a plan that asks for nothing on this tier.
 *
 * Frozen. Note that freezing reaches the flags but not the elements of
 * `functions`, which is why the derivation never hands this object itself to a
 * caller: an empty array a recipient sorted or appended to would be a shared
 * constant quietly carrying another capture's symbols.
 */
export const DISABLED_SERVER_AGENT_SIGNALS: ServerAgentSignals = Object.freeze({
  http: false,
  routeHandlers: false,
  fetch: false,
  prisma: false,
  pg: false,
  functions: [],
});

// ---------------------------------------------------------------------------
// The two derivations
//
// `../installer.ts` calls both with the actions it actually installed, and the
// service sends the results. Both are pure, order-independent, non-mutating and
// JSON-serialisable: the same multiset of actions in any order yields the same
// configuration, which is what makes a stored session reproducible and a frame
// comparable between two runs.
// ---------------------------------------------------------------------------

/**
 * Which process an action's instrumentation runs in.
 *
 * `'unknown'` is a real answer rather than a failure: the action types of
 * `./plan.ts` already imply a tier for every case that matters, and a caller
 * with no tier information at all is the normal case in a test.
 */
export type ActionTier = 'browser' | 'server' | 'unknown';

/**
 * The one question the derivations ask their caller.
 *
 * Structural on purpose, and deliberately *not* an adapter lookup: the
 * registry owns adapter identity (`../registry.ts` imports this folder, so the
 * reverse import would close a cycle), and the installer already knows which
 * adapter installed each action. It therefore supplies the tier and this module
 * never learns an adapter id — the same seam `./plan.ts` opens for adapter
 * resolution.
 *
 * An implementation must be free of side effects and stable within a call: both
 * derivations may ask about the same action once and rely on the answer.
 */
export interface ActionTierResolver {
  /**
   * Which tier this action's instrumentation runs in.
   *
   * @param action The action to classify.
   * @returns `'browser'`, `'server'`, or `'unknown'` when the caller cannot
   * say.
   */
  tierOf(action: InstrumentationAction): ActionTier;
}

/** Optional inputs both derivations accept. */
export interface DeriveOptions {
  /**
   * Tier information from the installer, when it has any.
   *
   * Omitted — the default — means every action is classified `'unknown'`, and
   * both derivations then work from the action type alone, which is what the
   * eight types of `./plan.ts` were designed to support.
   */
  readonly tiers?: ActionTierResolver;
}

/** No hooks, for an action type that arms none. */
const NO_AGENT_HOOKS: readonly AgentHookKey[] = Object.freeze([]);

/**
 * Which page-agent hooks each action type arms.
 *
 * A total table over the eight action types rather than a `switch`, so adding a
 * type to `./plan.ts` fails this declaration until it says something about the
 * new case, and so `readiness.test.ts` can iterate the policy instead of
 * restating it.
 *
 * Two rows encode a prerequisite that follows from how the agent's modules are
 * wired rather than from any prose, and both would fail silently if dropped:
 *
 * - `'react-render-tracking'` arms `componentTree` as well as `react`, because
 *   the tree the `componentTree` data source serves is reconstructed from the
 *   commit-time snapshot and the `render` events of the same capture. A render
 *   question answered without a tree loses the structural half of its answer.
 *   The pairing is also what satisfies the page agent's prerequisite: a tree is
 *   walked from the fiber root `browser/react.ts` retains, so the agent refuses
 *   a `componentTree` request whose `react` flag is off and reports it as an
 *   unavailable signal. No derivation here can produce that combination — this
 *   row is the only source of the flag — so the refusal is a guard against a
 *   hand-built configuration, not a case the planner reaches.
 * - `'state-tracking'` arms `react` as well as `state`, because
 *   `browser/state.ts`'s transitions are recorded *by* `browser/react.ts` while
 *   it walks a commit. Without the fiber hook there is no commit to walk, so
 *   `state` alone collects nothing at all.
 *
 * `'perf-tracking'` arms `errors` alongside `perf`: page errors are the cheap,
 * non-interfering companion signal the browser-performance adapter owns, and a
 * capture that recorded a long task while hiding the exception that caused it
 * would be actively misleading.
 *
 * `'function-timing'` arms **nothing**. The browser's span helper is installed
 * by the agent itself and gated by the capture, not by a hook flag, so a
 * function-timing action needs no hook — and must not imply one, or a purely
 * server-side patch plan would arm the whole page agent.
 *
 * `'server-span'` and `'db-query-tracking'` arm nothing for the same kind of
 * reason: neither signal exists in the page.
 */
const AGENT_HOOKS_BY_ACTION_TYPE = {
  'function-timing': [],
  'server-span': [],
  'react-render-tracking': ['react', 'componentTree'],
  'fetch-tracking': ['fetch'],
  'db-query-tracking': [],
  'state-tracking': ['state', 'react'],
  'interaction-tracking': ['interactions'],
  'perf-tracking': ['perf', 'errors'],
} as const satisfies Readonly<Record<InstrumentationActionType, readonly AgentHookKey[]>>;

/**
 * The install mode a patch-mode check compares against, named once.
 *
 * Typed as {@link InstrumentationMode} so a typo is a compile error rather than
 * a comparison that is always false — which is the failure mode that would
 * quietly empty the `functions` list.
 */
const PATCH_MODE: InstrumentationMode = 'patch';

/**
 * The action types whose `patch`-mode installs produce `function`-kind spans
 * through the span helper, and therefore belong in
 * {@link ServerAgentSignals.functions}.
 *
 * Both patch-mode action types: `'function-timing'` times an arbitrary named
 * function, and `'server-span'` wraps a named server entry point the same
 * way. The distinction between them is which adapter planned it and what the
 * developer is told, not how the span is emitted.
 */
const PATCHED_FUNCTION_ACTION_TYPES = [
  'function-timing',
  'server-span',
] as const satisfies readonly InstrumentationActionType[];

/** Widened view of {@link PATCHED_FUNCTION_ACTION_TYPES}, for membership tests. */
const PATCHED_FUNCTION_ACTION_TYPE_VALUES: readonly string[] = PATCHED_FUNCTION_ACTION_TYPES;

/**
 * Classifies one action's tier through the caller's resolver, defensively.
 *
 * A resolver is ordinary caller-supplied code: it can be absent, it can return
 * something outside the three values, and it can throw. None of those is worth
 * failing an install for, because the fallback — `'unknown'`, meaning "decide
 * from the action type alone" — is exactly what the derivations do when no
 * resolver is supplied at all. What must not happen is a configuration derived
 * from a half-classified action list, so a faulty resolver degrades the whole
 * answer for that action rather than part of it.
 *
 * @param action The action to classify.
 * @param options The derivation options, possibly carrying a resolver.
 * @returns The resolver's answer when it is one of the three tiers, otherwise
 * `'unknown'`.
 */
function resolveActionTier(action: InstrumentationAction, options?: DeriveOptions): ActionTier {
  const resolver = options?.tiers;

  if (resolver === undefined) {
    return 'unknown';
  }

  try {
    const tier = resolver.tierOf(action);
    return tier === 'browser' || tier === 'server' ? tier : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Derives the page agent's hook configuration from the actions that were
 * installed.
 *
 * Starts from {@link DORMANT_AGENT_HOOK_CONFIG} and turns on only what an
 * action asks for, per {@link AGENT_HOOKS_BY_ACTION_TYPE}. Two rules sit on top
 * of that table.
 *
 * **Actions the resolver classifies as `'server'` are skipped**, so a plan's
 * server-side half cannot arm a browser hook. An action classified `'unknown'`
 * is *not* skipped: the action types the table maps to hooks exist only in the
 * page, so treating an unclassified `'react-render-tracking'` as browser work
 * is the correct reading — and is what makes a caller with no resolver get the
 * right answer.
 *
 * **If anything ended up on, `interactions` is forced on.** This is the rule
 * worth reading the mechanism for. `browser/fetch.ts` injects the `traceparent`
 * header only while `isTracedContext()` holds, and that context is opened by
 * `browser/interaction.ts` — which also mints the trace root every browser
 * event is attributed to. Without the interaction listener, requests go out
 * untraced, the server's spans start a trace of their own, and the
 * browser↔server correlation the cross-tier timeline is built on breaks
 * *silently*: the capture still fills with events, and the timeline still
 * renders — as two unrelated trees. Forcing the flag costs one capture-phase
 * listener; omitting it costs the product's central claim.
 *
 * An empty action list, or one whose every action arms nothing, returns the
 * dormant configuration unchanged — including the forced flag, which is not
 * applied when nothing else is on.
 *
 * @param actions The actions the installer installed.
 * @param options Optional tier information.
 * @returns A fresh configuration; the input array and its actions are not
 * touched.
 */
export function deriveAgentHookConfig(
  actions: readonly InstrumentationAction[],
  options?: DeriveOptions,
): AgentHookConfig {
  const hooks: Record<AgentHookKey, boolean> = { ...DORMANT_AGENT_HOOK_CONFIG };
  let anyEnabled = false;

  for (const action of actions) {
    if (resolveActionTier(action, options) === 'server') {
      continue;
    }

    // The table is total over the declared action types; the fallback covers an
    // action that reached here without passing `./plan.ts`'s schema, which must
    // not throw inside an install.
    const keys: readonly AgentHookKey[] = AGENT_HOOKS_BY_ACTION_TYPE[action.type] ?? NO_AGENT_HOOKS;

    for (const key of keys) {
      hooks[key] = true;
      anyEnabled = true;
    }
  }

  if (anyEnabled) {
    hooks.interactions = true;
  }

  return hooks;
}

/**
 * Orders two symbol names by code unit, without a locale.
 *
 * `localeCompare` is deliberately avoided: its result depends on the host's
 * locale data, so the same plan would produce differently ordered frames on two
 * machines — and a test asserting an order would pass or fail by environment.
 *
 * @param left First name.
 * @param right Second name.
 * @returns A negative number, zero, or a positive number, as `Array#sort`
 * expects.
 */
function compareSymbolNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

/**
 * Derives the dev-server preload's signal set from the actions that were
 * installed.
 *
 * The gating is deliberately conservative, and that is a guarantee rather than
 * an optimisation: a plan that does not ask for the server tier collects no
 * backend or database telemetry (`docs/SECURITY.md`, "What is captured, and
 * what is never captured"). A developer asking why a component re-renders has
 * not asked this product to read their SQL, so a purely browser-side plan must
 * produce {@link DISABLED_SERVER_AGENT_SIGNALS} — not "the server signals with
 * nothing much on them".
 *
 * The derivation, in order:
 *
 * 1. `functions` — the `symbol` of every `patch`-mode action whose type is one
 *    of {@link PATCHED_FUNCTION_ACTION_TYPES}, minus any the resolver
 *    classifies as `'browser'` (a patched React callback is timed by the page's
 *    own span helper, not by the preload). Deduplicated, then sorted by
 *    {@link compareSymbolNames}, so one plan always produces one frame.
 * 2. `serverRequested` — true when the plan contains a `'server-span'` action,
 *    a `'db-query-tracking'` action, any action the resolver classifies as
 *    `'server'`, or at least one patched function name.
 * 3. When nothing was requested, the disabled set is reported and nothing else
 *    is considered.
 * 4. Otherwise `http`, `routeHandlers` and `fetch` are switched on regardless
 *    of what was asked for, because they are the spine a server trace hangs
 *    off: the incoming-request span is where the browser's `traceparent` is
 *    extracted and the route-handler span is what parents the rest, so a
 *    database or function span collected without them arrives as a flagged
 *    orphan instead of a row in a tree. `fetch` — the dev server's outgoing
 *    requests — belongs to the same spine: an external call a handler or a
 *    service function awaits is part of that request's time (the correlated
 *    trace of AAP §0.1.1 places it under the route handler, beside the SQL), so
 *    a server trace without it has an unexplained gap exactly where a
 *    third-party dependency spends its time. It is therefore not left to an
 *    explicit `'fetch-tracking'` action, which the planner writes for the
 *    *page's* requests and which, on its own, never arms this tier (a
 *    browser-only plan stays disabled). `prisma` and `pg` both follow
 *    `'db-query-tracking'`: reading a project's SQL is opt-in per plan.
 *
 * Why `prisma` and `pg` are not narrowed per driver: telling them apart would
 * mean knowing which adapter planned the action, and adapter ids live in
 * `../registry.ts`, which this folder may not import. Enabling both is
 * equivalent in effect — the preload's gate maps both to the same `db.query`
 * kind (see {@link CAPTURE_SIGNAL_TO_TELEMETRY_KIND}) — and it is the honest
 * reading of a plan that asked for database tracing in a project that uses
 * both.
 *
 * The function validates nothing. Its result is checked against
 * {@link serverAgentSignalsSchema} where it crosses a boundary (and in
 * `readiness.test.ts` for every case), which keeps "what is derived" and "what
 * is valid" separately testable.
 *
 * @param actions The actions the installer installed.
 * @param options Optional tier information.
 * @returns A fresh signal set; the input array and its actions are not touched,
 * and the returned `functions` array is never a shared constant.
 */
export function deriveServerAgentSignals(
  actions: readonly InstrumentationAction[],
  options?: DeriveOptions,
): ServerAgentSignals {
  const functionSymbols = new Set<string>();
  let serverSpanRequested = false;
  let dbQueryRequested = false;
  let serverTierSeen = false;

  for (const action of actions) {
    const tier = resolveActionTier(action, options);

    if (tier === 'server') {
      serverTierSeen = true;
    }

    if (action.type === 'server-span') {
      serverSpanRequested = true;
    } else if (action.type === 'db-query-tracking') {
      dbQueryRequested = true;
    }

    if (
      action.mode === PATCH_MODE &&
      PATCHED_FUNCTION_ACTION_TYPE_VALUES.includes(action.type) &&
      tier !== 'browser'
    ) {
      functionSymbols.add(action.symbol);
    }
  }

  const functions = [...functionSymbols].sort(compareSymbolNames);
  const serverRequested =
    serverSpanRequested || dbQueryRequested || serverTierSeen || functions.length > 0;

  if (!serverRequested) {
    // A fresh object rather than the shared constant: see
    // DISABLED_SERVER_AGENT_SIGNALS for why its `functions` array must not be
    // handed out.
    return { ...DISABLED_SERVER_AGENT_SIGNALS, functions: [] };
  }

  return {
    http: true,
    routeHandlers: true,
    // Part of the spine (step 4): the outgoing calls a server request awaits.
    fetch: true,
    prisma: dbQueryRequested,
    pg: dbQueryRequested,
    functions,
  };
}
