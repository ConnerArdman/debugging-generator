/**
 * The error vocabulary shared by every workspace in this monorepo.
 *
 * This module is the root of the module graph. It imports nothing — no
 * workspace package, no third-party package and no Node builtin — because
 * `@debuggen/shared` is the base layer of the acyclic package graph and every
 * layer above it reports failures with the two exports defined here. Keeping
 * the import list empty is what makes that possible: `src/index.ts` re-exports
 * this module behind the browser-safe `"."` entry, which the browser telemetry
 * agent, the DevTools panel and the VS Code webview all bundle, so a single
 * Node builtin specifier here would break three bundles at once. Node-only
 * helpers live under `src/node/**` and are published through the separate
 * `"./node"` entry instead.
 *
 * Two things live here and nowhere else:
 *
 * - {@link DEBUGGEN_ERROR_CODES}, the closed set of failure codes every layer
 *   reports with, and its derived {@link DebuggenErrorCode} type.
 * - {@link DebuggenError}, the error class that carries one of those codes —
 *   plus an optional developer-facing hint and diagnostic details — across a
 *   process boundary.
 *
 * What deliberately does *not* live here is a schema validator. The wire
 * schema for the payload shape is owned by `@debuggen/protocol`, so nothing
 * below `protocol` acquires a dependency on a validation library merely by
 * throwing an error, and the browser-safe entry stays as small as it is. The
 * structural checks {@link DebuggenError.is} and {@link DebuggenError.from}
 * perform are hand-written here for that reason — an own-brand test, a `Set`
 * membership test against the code vocabulary, and one comparison per member
 * the class declares — and they are what stops a value that merely *claims* to
 * be an error from being typed as one on the way to that schema.
 */

/**
 * Every failure this product can report, as a closed readonly tuple.
 *
 * The tuple is the single source of truth for the code vocabulary:
 * `@debuggen/protocol` enumerates it when it builds the message schemas, so a
 * code that is not listed here cannot be sent over the wire, and adding or
 * renaming one is a protocol change rather than a local edit. That is the whole
 * point of a closed set — eleven workspaces pick from this list instead of each
 * inventing a string, and a consumer can exhaustively switch on it.
 *
 * ## Where these codes surface
 *
 * - In the protocol's `error` payload (`{ code, message, ref? }`), which the
 *   service sends to any client whose request or message it refused.
 * - In `instrumentation.failed` (`{ code, message, hint }`), where the hint is
 *   the developer's recovery instruction rather than prose for a log.
 * - In the graceful-failure contract: each row there pairs a condition with a
 *   developer-facing message and a recovery path, and the code is what lets
 *   both user interfaces render the right one. A failure is never presented as
 *   a successful analysis, so choosing an accurate code matters more than
 *   choosing a flattering one.
 *
 * ## Ordering convention
 *
 * Grouped by concern, alphabetical within each group, groups ordered along the
 * path a session takes (startup, access, session lifecycle, the project on
 * disk, runtime readiness, instrumentation, analysis inputs, model artifacts,
 * persistence and transport, last resort). A new code joins the group it
 * belongs to, in alphabetical position; it never goes on the end.
 *
 * ## Choosing a code
 *
 * - **Startup** — `CONFIG_INVALID`: a process could not make sense of its own
 *   configuration or environment, and nothing else can be attempted.
 * - **Access boundary** — `UNAUTHORIZED` (missing, unknown or out-of-scope
 *   credential), `FORBIDDEN_ORIGIN` (a request or socket upgrade from a web
 *   origin, which no client of this service ever has), `PAIRING_INVALID` and
 *   `PAIRING_EXPIRED` (the one-time code that grants a DevTools credential was
 *   wrong, already used, or past its short lifetime), `RATE_LIMITED` (too many
 *   failed attempts; the caller should back off, not retry immediately).
 * - **Session and capture lifecycle** — `SESSION_NOT_FOUND` (no such session,
 *   including one already purged by retention), `SESSION_INVALID_STATE` (the
 *   operation is real but not legal from the session's current status, which
 *   the state machine refuses rather than papers over), `TAB_NOT_BOUND` (the
 *   inspected tab has not been bound to a session, so there is no deterministic
 *   recipient for agent configuration or panel data), `CAPTURE_ALREADY_ACTIVE`
 *   (one project may hold one capture at a time, so the answer names the
 *   session that owns it), `CAPTURE_EMPTY` (the capture window closed with no
 *   telemetry — the "interact with the page while capture is running, then
 *   capture again" recovery case; analysis is skipped and the session returns
 *   to its ready state, because an empty capture is a dead end, not a defect).
 * - **The project on disk** — `PROJECT_NOT_FOUND` (no project at the given
 *   root, or it is not one this product can index), `PATH_OUTSIDE_PROJECT` (the
 *   containment failure: a path escaped the project root, produced by the
 *   path helpers in `paths.ts` and checked again independently by the service's
 *   `source/open.ts` and by the editor's URI handler, because a click-to-source
 *   request can originate from a page), `FS_UNSAFE_PATH` (the *policy* failure
 *   raised by `node/safe-fs.ts` when a parent directory is not a real directory
 *   owned by the current user with private permissions, or when the final path
 *   component is a symlink — never a raw errno reported under another name).
 * - **Runtime readiness** — `DEV_SERVER_UNAVAILABLE` (no dev server answers at
 *   the expected address), `DEV_SERVER_LAUNCH_FAILED` (launching one failed),
 *   `AGENT_NOT_READY` (the page agent has not reported itself for the bound
 *   tab's current document, so a reload is needed before capture),
 *   `SERVER_AGENT_NOT_READY` (no server-side producer is attached for the
 *   project, so the planned server and database signals cannot be collected).
 * - **Instrumentation** — `INSTRUMENTATION_UNAVAILABLE` (a planned signal
 *   cannot be enabled here; capture still proceeds with the rest, and the
 *   missing signal is recorded), `INSTRUMENTATION_INSTALL_FAILED` (installation
 *   itself failed and what was applied has been reverted),
 *   `PATCH_TARGET_NOT_FOUND` (the file or symbol a patch action names is absent
 *   from the code graph), `PATCH_UNSUPPORTED` (the target exists but its form
 *   cannot be wrapped safely, which is a refusal, not an attempt),
 *   `MODIFICATION_CONFLICT` (the developer edited a file while it was
 *   instrumented: the recorded hash no longer matches, so cleanup reports the
 *   conflict and preserves both the file and the backup — it must never
 *   overwrite the developer's work), `CLEANUP_PARTIAL` (cleanup finished with
 *   some records unresolved, so the session's cleanup status says so).
 * - **Analysis inputs** — `CODE_INDEX_FAILED`: the target project could not be
 *   indexed, so investigation has nothing to query.
 * - **Model artifacts** — `MODEL_UNAVAILABLE` (the provider could not be
 *   reached or refused the call), `MODEL_OUTPUT_INVALID` (output failed its
 *   authoring schema after the permitted repair attempts), `PLAN_INVALID` and
 *   `PANEL_INVALID` (a normalised plan or panel failed its internal schema —
 *   a product defect, logged with the input rather than retried against the
 *   model), `PANEL_SEMANTIC_INVALID` (the panel is structurally valid but cites
 *   evidence or filters that do not exist in the capture, which is what
 *   separates an observed fact from an assertion).
 * - **Persistence and transport** — `STORE_ERROR` (the session store failed),
 *   `PROTOCOL_INVALID_MESSAGE` (a frame did not parse as a known message),
 *   `TRANSPORT_DISCONNECTED` (the peer is gone; the caller reconnects and
 *   retries rather than treating the operation as refused).
 * - **Last resort** — `INTERNAL` (an unexpected failure, and the default the
 *   error wrapper applies to a value it cannot classify) and `NOT_IMPLEMENTED`
 *   (a path deliberately not built). Neither is a shrug: reaching for one where
 *   a specific code fits removes the only signal a user interface has.
 *
 * @example
 * ```ts
 * function assertKnown(code: string): DebuggenErrorCode {
 *   const known = DEBUGGEN_ERROR_CODES.find((candidate) => candidate === code);
 *   if (known === undefined) {
 *     throw new DebuggenError('PROTOCOL_INVALID_MESSAGE', `Unknown code: ${code}`);
 *   }
 *   return known;
 * }
 * ```
 */
export const DEBUGGEN_ERROR_CODES = [
  // Startup: a process cannot make sense of its own configuration.
  'CONFIG_INVALID',

  // Local service access boundary. The service listens on a loopback address,
  // which keeps other machines out but not other processes or web pages, so
  // every client is authenticated by role and scope.
  'FORBIDDEN_ORIGIN',
  'PAIRING_EXPIRED',
  'PAIRING_INVALID',
  'RATE_LIMITED',
  'UNAUTHORIZED',

  // Session and capture lifecycle, owned by the service's state machine.
  'CAPTURE_ALREADY_ACTIVE',
  'CAPTURE_EMPTY',
  'SESSION_INVALID_STATE',
  'SESSION_NOT_FOUND',
  'TAB_NOT_BOUND',

  // The developer's project on disk: finding it, and staying inside it.
  'FS_UNSAFE_PATH',
  'PATH_OUTSIDE_PROJECT',
  'PROJECT_NOT_FOUND',

  // Runtime readiness: the target's dev server and the two telemetry producers.
  'AGENT_NOT_READY',
  'DEV_SERVER_LAUNCH_FAILED',
  'DEV_SERVER_UNAVAILABLE',
  'SERVER_AGENT_NOT_READY',

  // Installing, tracking and reverting instrumentation.
  'CLEANUP_PARTIAL',
  'INSTRUMENTATION_INSTALL_FAILED',
  'INSTRUMENTATION_UNAVAILABLE',
  'MODIFICATION_CONFLICT',
  'PATCH_TARGET_NOT_FOUND',
  'PATCH_UNSUPPORTED',

  // Static analysis of the target project.
  'CODE_INDEX_FAILED',

  // Model interaction and the artifacts a model proposes.
  'MODEL_OUTPUT_INVALID',
  'MODEL_UNAVAILABLE',
  'PANEL_INVALID',
  'PANEL_SEMANTIC_INVALID',
  'PLAN_INVALID',

  // Persistence and the transports between the cooperating processes.
  'PROTOCOL_INVALID_MESSAGE',
  'STORE_ERROR',
  'TRANSPORT_DISCONNECTED',

  // Last resort, and only that: reaching for one of these where a specific
  // code fits removes the only signal a user interface has.
  'INTERNAL',
  'NOT_IMPLEMENTED',
] as const;

/**
 * One of the codes in {@link DEBUGGEN_ERROR_CODES}.
 *
 * Derived from the tuple rather than declared beside it, so the values and the
 * type can never drift apart: a code added to the tuple widens this union in
 * the same edit, and a consumer that switches exhaustively over it starts
 * failing to compile until it handles the new case — which is the intended way
 * to find every place that has to say something about it.
 *
 * This is the type `@debuggen/protocol` embeds in its `error` and
 * `instrumentation.failed` payload schemas, and the type of
 * {@link DebuggenError.code}.
 */
export type DebuggenErrorCode = (typeof DEBUGGEN_ERROR_CODES)[number];

/**
 * The own-property name that marks a value as a {@link DebuggenError}.
 *
 * Declared once, here, and read only by {@link hasOwnDebuggenErrorBrand} — the
 * own-property test {@link DebuggenError.is} asks — and
 * {@link claimsDebuggenErrorBrand}, the looser test {@link DebuggenError.from}
 * asks before it rebuilds. The `satisfies keyof DebuggenError` clause ties the
 * string to the class member of the same name: renaming one without the other
 * is a compile error rather than a type guard that quietly stops matching
 * anything.
 */
const DEBUGGEN_ERROR_BRAND = '__isDebuggenError__' satisfies keyof DebuggenError;

/**
 * The value of {@link DebuggenError.name}, which the class declares as that
 * exact literal rather than as a `string`.
 *
 * Declared here and *used* by the class field below, so the guard's condition
 * and the value every instance carries are one constant and cannot drift: the
 * name is part of the structure {@link DebuggenError.is} narrows to, so a value
 * naming itself something else is not this error, and one naming itself nothing
 * would be narrowed to a type whose `name` is a string while its runtime `name`
 * is `undefined`.
 */
const DEBUGGEN_ERROR_NAME = 'DebuggenError';

/**
 * The message {@link DebuggenError.from} applies when the value it was handed
 * carries none it can use.
 *
 * One sentinel, read from both places that need one — the unclassifiable-value
 * branch and the normalisation branch — so a user interface only ever has one
 * "we could not say what failed" string to recognise, and a grep for it finds
 * every producer.
 */
const UNKNOWN_ERROR_MESSAGE = 'Unknown error';

/**
 * The code vocabulary as a membership set, built once when this module loads.
 *
 * {@link DebuggenError.is} runs in every `catch` block in the product, so the
 * code condition has to be a constant-time lookup rather than a linear scan of
 * the tuple on every caught value. Declared `ReadonlySet<string>` rather than
 * `ReadonlySet<DebuggenErrorCode>` so an `unknown` can be tested against it
 * without a cast, and kept module-private so
 * {@link DEBUGGEN_ERROR_CODES} remains the single published source of truth.
 */
const DEBUGGEN_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(DEBUGGEN_ERROR_CODES);

/**
 * Whether `candidate` is one of the codes in {@link DEBUGGEN_ERROR_CODES}.
 *
 * This is what keeps an invented code out of a value typed
 * {@link DebuggenErrorCode}. `@debuggen/protocol` enumerates the same tuple in
 * its `error` and `instrumentation.failed` payload schemas, so a code outside
 * the set does not merely read oddly — it arrives at the receiving end as a
 * frame that fails to parse, on the failure path, where the original error is
 * then lost.
 *
 * @param candidate Any value, typically read off an object of unknown shape.
 * @returns `true` when `candidate` is a string in the closed vocabulary.
 */
function isDebuggenErrorCode(candidate: unknown): candidate is DebuggenErrorCode {
  return typeof candidate === 'string' && DEBUGGEN_ERROR_CODE_SET.has(candidate);
}

/**
 * Whether `value` is a non-null object that *claims* the brand, wherever on its
 * prototype chain the claim sits.
 *
 * This is the question {@link DebuggenError.from} asks, and only that one: a
 * value claiming to be a `DebuggenError` and failing the rest of the contract
 * is normalised into a real instance rather than wrapped as an opaque cause,
 * because its code, message and hint are worth salvaging. Reaching an
 * inherited claim is deliberate here — a value assembled behind a prototype is
 * still evidence of where it came from, and rebuilding it loses nothing.
 *
 * Exactly `true`, never merely truthy — a brand of `"true"` or `1` is what a
 * mangled revival or a hand-rolled imitation looks like, and treating one as a
 * claim would let `from` copy an arbitrary object's `code` onto a real error.
 *
 * Narrowed to an index-signature record rather than to the class, on purpose:
 * the caller then reads every further property as `unknown` and has to narrow
 * it, which is what makes the remaining conditions honest.
 *
 * @param value Any value, typically one caught or received.
 * @returns `true` when `value` is an object whose brand is `true`, own or
 * inherited.
 */
function claimsDebuggenErrorBrand(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    DEBUGGEN_ERROR_BRAND in value &&
    value[DEBUGGEN_ERROR_BRAND] === true
  );
}

/**
 * Whether `value` carries the brand as its **own** property, set to exactly
 * `true`.
 *
 * The first condition of {@link DebuggenError.is}, and stricter than
 * {@link claimsDebuggenErrorBrand} on purpose: the brand is declared as a class
 * field, so every instance of every copy of this class installs it per
 * instance, and a JSON revival, a structured clone and a hand-written literal
 * all carry it as an own key too. Nothing this product produces puts it on a
 * prototype, so requiring own-ness rejects no legitimate value while excluding
 * a chain assembled around a branded prototype — and it makes the guard do what
 * its documentation says, which is the difference between a contract and a
 * description.
 *
 * A value that only inherits the claim is still normalised by
 * {@link DebuggenError.from}; being refused the narrowing is not being
 * discarded.
 *
 * @param value Any value, typically one caught or received.
 * @returns `true` when `value` is an object with an own brand of `true`.
 */
function hasOwnDebuggenErrorBrand(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, DEBUGGEN_ERROR_BRAND) &&
    (value as Readonly<Record<string, unknown>>)[DEBUGGEN_ERROR_BRAND] === true
  );
}

/**
 * Whether `value` is usable as {@link DebuggenErrorOptions.details}: a non-null
 * object that is not an array.
 *
 * Used only while normalising a branded value, whose `details` arrived as
 * `unknown`. An array is excluded because `details` is a keyed bag of
 * diagnostic context: an array reaching a log or a user interface through it
 * would render as `{ "0": … }`, which names nothing.
 *
 * @param value Any value, typically read off an object of unknown shape.
 * @returns `true` when `value` can be attached as diagnostic details.
 */
function isDiagnosticDetails(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Optional context for a {@link DebuggenError}.
 *
 * Every member is optional and readonly: an error is a value that is built once
 * and then travels, and each of the three serves a different audience — the
 * developer reading a user interface, an engineer reading a log, and the
 * runtime that has to keep the original failure reachable.
 */
export interface DebuggenErrorOptions {
  /**
   * A short, actionable instruction for the developer, in their language rather
   * than the code's.
   *
   * This is the field both user interfaces show beneath the message, and the
   * only part of an error a developer is expected to act on, so it names the
   * next step ("Reload the page and start capture again") instead of restating
   * the failure. `toPayload` forwards it verbatim, which is how it reaches the
   * protocol's `error` and `instrumentation.failed` payloads.
   */
  readonly hint?: string;

  /**
   * JSON-serialisable diagnostic context: identifiers, counts, states, a
   * project-relative file path, an enumerated reason.
   *
   * **Privacy constraint.** This object may be logged, persisted with a session
   * and shown in a user interface, so it must never carry secrets or tokens,
   * request or response bodies, SQL literals, raw file contents, or React prop
   * and state values. Those are excluded by the telemetry privacy model, and
   * the enforcement lives in two dedicated places — the redaction layer under
   * `packages/telemetry/src/redaction/`, applied before any event is persisted
   * or broadcast, and the outbound guard in
   * `packages/model-provider/src/redact-guard.ts`, which refuses a call whose
   * payload still matches a denied pattern. Neither of them can rescue a secret
   * that was put in here by hand, because an error raised deep in a call stack
   * does not pass through either one; keep this field to values that would be
   * safe to read aloud.
   *
   * Values are `unknown` rather than a narrower type so a caller never has to
   * cast to attach context, and `Readonly` so an error's context cannot be
   * mutated after the fact by whoever catches it.
   */
  readonly details?: Readonly<Record<string, unknown>>;

  /**
   * The underlying value this error was raised for: a caught exception, a
   * rejected promise's reason, or anything else that explains the failure.
   *
   * Passed straight to the native `Error` `cause` option, so the original is
   * reachable through the standard property and printed by every runtime's
   * stack formatter. It is typed `unknown` because a thrown value need not be
   * an `Error`.
   */
  readonly cause?: unknown;
}

/**
 * The error every workspace in this monorepo throws and every boundary catches.
 *
 * A `DebuggenError` is a native `Error` with three additions: a
 * {@link DebuggenErrorCode} from the closed set above, an optional developer
 * hint, and optional diagnostic details. The code is what lets a boundary
 * decide what to do — render a specific recovery path, fall back to a
 * deterministic artifact, reconnect, or refuse — without parsing a message
 * string, and {@link DebuggenError.toPayload} is the exact shape that travels
 * on the wire.
 *
 * ## Why a string brand instead of `instanceof`
 *
 * Four processes cooperate here — the local service, the VS Code extension
 * host, the DevTools panel and the page agent — and each one bundles its own
 * copy of this module through its own bundler. Two copies of a class are two
 * distinct constructor identities, so `error instanceof DebuggenError` returns
 * `false` for an error that crossed a bundle boundary even though it is exactly
 * this shape. The same is true of anything that has been serialised: a value
 * that arrived through `postMessage`, `structuredClone` or a JSON round-trip
 * has lost its prototype entirely.
 *
 * Instances therefore carry an own, enumerable data property,
 * `__isDebuggenError__: true`, and {@link DebuggenError.is} tests for that
 * property rather than for a prototype — along with the rest of the contract,
 * which the next section sets out. A string-keyed boolean is the form that
 * travels: it survives a JSON round-trip of the error's own properties, and it
 * survives `postMessage` or `structuredClone` of any plain object carrying it —
 * a payload with an error field, for instance. A symbol key would survive
 * neither, and a prototype member would survive no clone at all, which is why
 * the brand is a plain `true` on the instance.
 *
 * ## What the brand alone does *not* establish
 *
 * A structural test is the right kind of test here, but "carries the brand" is
 * not the whole of the structure. {@link DebuggenError.is} narrows to this
 * class, so whatever it accepts is thereafter entitled to every member the
 * class declares, and it consequently verifies each of them: an **own**
 * `__isDebuggenError__` of exactly `true`, a `name` of exactly
 * `"DebuggenError"`, a `code` drawn from {@link DEBUGGEN_ERROR_CODES}, a string
 * `message`, a `stack`, `hint` and `details` that are either absent or of their
 * declared type, and a callable `toPayload`. Each condition pays for itself on
 * the failure path, which is the only path this class is ever on:
 *
 * - No callable `toPayload` and `DebuggenError.from(caught).toPayload()` throws
 *   a `TypeError` from inside the error reporter — the original failure is
 *   replaced by a crash in the code that was meant to report it.
 * - A `code` outside the closed vocabulary is still typed
 *   {@link DebuggenErrorCode} once narrowed, and reaches the protocol's
 *   closed-set schema as a frame the receiving end cannot parse.
 * - A missing or non-string `message` reads as a blank line in both user
 *   interfaces, or throws where the message is measured or matched.
 * - A non-string `hint` is worse than a missing one: `toPayload` copies a
 *   defined hint through verbatim, so `hint: 42` leaves here as a payload that
 *   fails the protocol's `{ code, message, hint? }` schema — a refused frame
 *   produced by a value the guard had already called an error.
 * - A `name` that is absent or something else, a non-string `stack`, or
 *   `details` that are not a keyed object are each a member typed one way and
 *   valued another, read by a log line or a user interface that has no reason
 *   to defend itself against its own types.
 *
 * What is deliberately *not* required is a non-empty message:
 * `new DebuggenError('INTERNAL', '')` is legal, so demanding content would
 * reject a genuine instance — and the guard has to be sound in both directions.
 * For the same reason an absent `hint`, `stack` or `details` passes: those
 * members are optional, so they are checked only when they are present.
 *
 * A real error built by another bundle's copy of this class satisfies every
 * condition on its own merits: the brand, `code` and `name` are own properties,
 * `message` and `stack` come from the `Error` base and `toPayload` from its
 * prototype. No `instanceof` appears anywhere, so the cross-bundle capability
 * the brand exists for is exactly as capable as before. What the conditions do
 * exclude is the *carcass* of an error — a JSON revival, which keeps the brand,
 * the name, the code and the hint but loses the non-enumerable `message`; a
 * structured clone of a branded plain object, which cannot carry a function; a
 * hand-built object with an invented code, a numeric hint or no name at all.
 * Those are not narrowed by `is`; {@link DebuggenError.from} rebuilds them into
 * a real instance instead, salvaging what is usable, dropping what is not, and
 * keeping the original reachable as `cause`.
 *
 * One further limit is worth stating rather than discovering: cloning an
 * `Error` *instance* is lossy in every runtime — the structured-clone algorithm
 * keeps only `name`, `message`, `stack` and `cause`, so the code and the brand
 * do not survive it. An error consequently crosses a process boundary as a
 * {@link DebuggenError.toPayload} object — which the protocol validates — never
 * as a cloned instance.
 *
 * @example
 * ```ts
 * // Raising a failure with a recovery instruction.
 * throw new DebuggenError('AGENT_NOT_READY', 'The page agent has not reported in.', {
 *   hint: 'Reload the page, then start capture again.',
 *   details: { attempts: 3 },
 * });
 *
 * // Normalising anything caught at a boundary, then reporting it.
 * try {
 *   await loadThing();
 * } catch (caught) {
 *   const error = DebuggenError.from(caught, 'STORE_ERROR');
 *   send({ type: 'error', payload: error.toPayload() });
 * }
 * ```
 */
export class DebuggenError extends Error {
  /**
   * Always `"DebuggenError"`, so a formatted stack names this class rather than
   * the plain `Error` it extends.
   *
   * The `override` modifier is required: `name` is declared on the base, and
   * the repository compiles with `noImplicitOverride`.
   */
  override readonly name = DEBUGGEN_ERROR_NAME;

  /**
   * The cross-bundle brand described in the class documentation above.
   *
   * An own, enumerable, JSON-safe data property, read only by
   * {@link hasOwnDebuggenErrorBrand} and {@link claimsDebuggenErrorBrand},
   * which is how {@link DebuggenError.is} and {@link DebuggenError.from}
   * respectively consult it. Never test it by hand: the
   * brand on its own establishes only where a value came from, not that it is
   * usable, so `is` is the supported way to ask whether something is an error
   * and `from` is the supported way to turn it into one.
   *
   * `readonly` with a literal initializer, so its declared type is the literal
   * `true` rather than `boolean`: a consumer checking the brand structurally
   * gets the narrow type, and no instance can be built with it set to `false`.
   */
  readonly __isDebuggenError__ = true;

  /** The failure this error reports, from {@link DEBUGGEN_ERROR_CODES}. */
  readonly code: DebuggenErrorCode;

  /**
   * The developer-facing recovery instruction, when one applies.
   *
   * Declared with `declare` so the class body emits no field initializer for
   * it: the property is assigned in the constructor only when a hint was given,
   * which keeps it absent — rather than present and `undefined` — on an error
   * that has none, both in a `'hint' in error` check and among the own
   * properties a JSON round-trip carries.
   */
  declare readonly hint?: string;

  /**
   * The diagnostic context, when any was attached. See
   * {@link DebuggenErrorOptions.details} for the privacy constraint that
   * governs what may go in it, and {@link DebuggenError.hint} for why this is
   * declared rather than initialized.
   */
  declare readonly details?: Readonly<Record<string, unknown>>;

  /**
   * Builds an error for one code, with optional hint, details and cause.
   *
   * @param code The failure being reported. Choose the most specific code that
   * fits; the guidance on {@link DEBUGGEN_ERROR_CODES} exists so that eleven
   * workspaces choose consistently.
   * @param message A complete sentence describing what failed, for logs and for
   * the message line of a user interface. Put the developer's next step in
   * `options.hint` instead of appending it here.
   * @param options Optional hint, details and cause. `cause` is forwarded to
   * the native `Error` constructor and is omitted entirely when absent, so no
   * `cause` property is created for an error that has none.
   */
  constructor(code: DebuggenErrorCode, message: string, options?: DebuggenErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    if (options?.hint !== undefined) {
      this.hint = options.hint;
    }
    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }

  /**
   * Whether `value` is a `DebuggenError`, including one built by another
   * bundle's copy of this class.
   *
   * Verifies **every member this class declares**, because the predicate
   * narrows to the whole class and whatever it accepts is thereafter entitled
   * to all of it:
   *
   * - an own {@link DebuggenError.__isDebuggenError__} of exactly `true`;
   * - `name` exactly `"DebuggenError"`, which is the literal type the class
   *   declares rather than a plain `string`;
   * - a {@link DebuggenError.code} drawn from {@link DEBUGGEN_ERROR_CODES};
   * - a string {@link DebuggenError.message} — empty is allowed, since an
   *   instance may legally have one;
   * - `stack`, `hint` and `details` either absent or of their declared type: a
   *   string, a string, and a non-array object. An optional member is checked
   *   only when it is there, so nothing legitimate is rejected for travelling
   *   light;
   * - a callable {@link DebuggenError.toPayload}.
   *
   * The class documentation above records what each condition costs when it is
   * missing. The one it does *not* do is call `toPayload` to inspect what it
   * returns: this guard runs on every caught value, and invoking a foreign
   * function from inside a type check — on the failure path, where the original
   * error is still unreported — could throw, mutate or block. Constraining the
   * data the class's own `toPayload` reads is what keeps its output honest, and
   * it is why a non-string `hint` is refused here rather than discovered by the
   * protocol's schema at the far end of the wire.
   *
   * Deliberately **no** `instanceof`, for the reasons set out in the class
   * documentation: use this in every `catch` block and on every value received
   * from another process, where `instanceof` produces false negatives that turn
   * a precise failure into an `INTERNAL` one. A foreign-bundle instance passes
   * on its own merits — the brand, `code` and `name` are own properties,
   * `message` and `stack` come from the `Error` base, and `toPayload` is
   * reachable through its prototype, which a property read follows.
   *
   * A branded value that fails any condition is not narrowed — it is not safe
   * for a caller to read `.code` off it, print its `name` or call
   * `.toPayload()` — but it is not discarded either:
   * {@link DebuggenError.from} turns it into a real instance.
   *
   * Cheap on purpose, because this runs on every caught value: one own-property
   * test, one `Set` membership test, one string comparison and five `typeof`
   * or `undefined` comparisons, allocating nothing.
   *
   * @param value Any value, typically one caught or received.
   * @returns `true` when `value` satisfies every condition above.
   */
  static is(value: unknown): value is DebuggenError {
    if (!hasOwnDebuggenErrorBrand(value)) {
      return false;
    }

    // Read as `unknown` and narrowed one property at a time: a branded value
    // reaching this point may have come from a JSON revival, a clone or another
    // bundle, so nothing about its shape is known yet.
    const { stack, hint, details } = value;

    return (
      value.name === DEBUGGEN_ERROR_NAME &&
      isDebuggenErrorCode(value.code) &&
      typeof value.message === 'string' &&
      (stack === undefined || typeof stack === 'string') &&
      (hint === undefined || typeof hint === 'string') &&
      (details === undefined || isDiagnosticDetails(details)) &&
      typeof value.toPayload === 'function'
    );
  }

  /**
   * Normalises any caught or received value into a `DebuggenError`.
   *
   * This is the function every boundary calls first, because `catch` binds
   * `unknown`: JavaScript permits throwing a string, a number, `null` or a
   * rejected promise's arbitrary reason, and a boundary still has to report
   * something typed.
   *
   * - Already a `DebuggenError` by {@link DebuggenError.is} — so including a
   *   foreign-bundle instance, which is not `instanceof` this class: returned
   *   unchanged, by identity, which preserves the specific code a deeper layer
   *   chose along with its stack and its cause. `fallbackCode` never overrides
   *   an existing code.
   * - Claiming the brand — own or inherited — and failing that contract: a JSON
   *   revival that lost its non-enumerable `message`, a clone that could not
   *   carry `toPayload`, an object with an invented code, a numeric `hint` or no
   *   `name`: **normalised** into a real instance rather than passed through,
   *   because passing it through is what makes a later `.toPayload()` throw from
   *   inside the error reporter, lets a code outside
   *   {@link DEBUGGEN_ERROR_CODES} reach the protocol's closed-set schema, and
   *   lets a non-string hint reach it as a payload that fails to parse.
   *   Everything usable is salvaged — the `code` when it is in the vocabulary
   *   and `fallbackCode` when it is not, the `message` when it is a non-empty
   *   string and `"Unknown error"` when it is absent or unusable, a `hint` when
   *   it is a string, and `details` when they are a non-array object — while
   *   anything of the wrong type is dropped rather than copied, so the rebuilt
   *   error's own payload is valid by construction. The original value becomes
   *   the `cause`, so nothing is lost and the shape that arrived is still there
   *   to be logged. Applying `from` to the result
   *   returns it unchanged, since the result is a real instance.
   * - A native `Error` (or a subclass): wrapped with `fallbackCode`, keeping its
   *   `message` — or its `name`, when the message is empty, since an error with
   *   no message at all reads as a blank line in a user interface — and setting
   *   `cause` to the original so the stack and type survive.
   * - Anything else: wrapped with `fallbackCode` and the value itself as
   *   `cause`. The message is the value when it is a non-empty string and
   *   `"Unknown error"` otherwise. Stringification stops there on purpose:
   *   `JSON.stringify` throws on a cycle and on a `bigint`, and `String(value)`
   *   invokes a foreign `toString`, so neither belongs on the failure path of
   *   an error reporter.
   *
   * @param value The caught or received value.
   * @param fallbackCode The code to apply when `value` does not already carry
   * one. Defaults to `INTERNAL`; pass the code of the operation that failed
   * whenever it is known, because `INTERNAL` tells a user interface nothing.
   * @returns A `DebuggenError`: `value` itself when it already satisfied
   * {@link DebuggenError.is}, and otherwise a new instance — rebuilt from what
   * a branded value carried, or wrapped around anything else.
   */
  static from(value: unknown, fallbackCode: DebuggenErrorCode = 'INTERNAL'): DebuggenError {
    if (DebuggenError.is(value)) {
      return value;
    }

    if (claimsDebuggenErrorBrand(value)) {
      // Branded, but not a `DebuggenError` by the contract above. Salvaging is
      // strictly better than wrapping it as an opaque cause: whatever produced
      // it chose a code and wrote a hint, and those are the two fields a user
      // interface acts on. Every read is narrowed, because this shape came from
      // a revival, a clone or a foreign bundle and only claims the brand.
      const salvagedCode: unknown = value.code;
      const salvagedMessage: unknown = value.message;
      const salvagedHint: unknown = value.hint;
      const salvagedDetails: unknown = value.details;

      // Built as a mutable local and only then handed over as
      // `DebuggenErrorOptions`: under `exactOptionalPropertyTypes` an absent
      // hint has to be an absent *key*, never a key holding `undefined`, or the
      // rebuilt error would answer `'hint' in error` with `true` and serialise
      // a null hint onto the wire.
      const options: {
        hint?: string;
        details?: Readonly<Record<string, unknown>>;
        cause: unknown;
      } = { cause: value };
      if (typeof salvagedHint === 'string') {
        options.hint = salvagedHint;
      }
      if (isDiagnosticDetails(salvagedDetails)) {
        options.details = salvagedDetails;
      }

      return new DebuggenError(
        isDebuggenErrorCode(salvagedCode) ? salvagedCode : fallbackCode,
        typeof salvagedMessage === 'string' && salvagedMessage.length > 0
          ? salvagedMessage
          : UNKNOWN_ERROR_MESSAGE,
        options,
      );
    }

    if (value instanceof Error) {
      const message = value.message.length > 0 ? value.message : value.name;
      return new DebuggenError(fallbackCode, message, { cause: value });
    }

    const message = typeof value === 'string' && value.length > 0 ? value : UNKNOWN_ERROR_MESSAGE;
    const options: DebuggenErrorOptions = value === undefined ? {} : { cause: value };
    return new DebuggenError(fallbackCode, message, options);
  }

  /**
   * The wire form of this error.
   *
   * `@debuggen/protocol` maps this exact object onto its `error` and
   * `instrumentation.failed` payload schemas, so **changing the shape is a
   * protocol change**: both extensions and the service validate against those
   * schemas, and a field added here without being added there is dropped by
   * the parser at the receiving end.
   *
   * `hint` is present only when this error has one, so the serialised payload
   * carries no `"hint": null` and no key whose value is `undefined`. `details`
   * and `cause` are deliberately excluded: details are diagnostic context for
   * this process's log, and a cause is frequently an `Error` — neither is
   * safe to assume serialisable, and neither has a place in a message a user
   * interface renders.
   *
   * @returns A plain, JSON-safe object with the code, the message and, when
   * set, the hint.
   */
  toPayload(): { code: DebuggenErrorCode; message: string; hint?: string } {
    const payload: { code: DebuggenErrorCode; message: string; hint?: string } = {
      code: this.code,
      message: this.message,
    };
    if (this.hint !== undefined) {
      payload.hint = this.hint;
    }
    return payload;
  }
}
