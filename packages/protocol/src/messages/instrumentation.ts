/**
 * The three `instrumentation.*` messages: the plan the service is about to
 * apply, what it actually managed to arm, and the one case where it could arm
 * nothing at all.
 *
 * ## The contract
 *
 * AAP §0.4.2 names three frames, all of them service → editor and DevTools
 * panel, all of them WebSocket:
 *
 * ```text
 * `instrumentation.plan`   · { sessionId, plan: InstrumentationPlan }
 * `instrumentation.ready`  · { sessionId, applied: ModificationRecord[],
 *                              runtimeHooks: string[],
 *                              unavailable: { signal, reason, hint }[] }
 * `instrumentation.failed` · { sessionId, error: { code, message, hint } }
 * ```
 *
 * The first two names are the user's own (prompt §16) and are preserved
 * character for character, here and in {@link INSTRUMENTATION_MESSAGE_PAYLOADS}.
 *
 * ## Why this module's fidelity is a safety property
 *
 * `instrumentation.ready` is what a developer *sees* about the edits this
 * product made to their working tree. The same payload feeds the editor's
 * modification list with its diff view and the DevTools panel's session summary
 * (AAP §0.5.1), and it is the only channel through which the three facts of an
 * install reach a human: which files were patched, which runtime hooks came up,
 * and which signals did not. A record dropped at this boundary is an edit the
 * developer does not know about; a record admitted with a malformed hash is an
 * edit whose reversal cannot be verified. So nothing here is lenient, nothing is
 * repaired, and every one of the three arrays is required — an install that
 * patched no file sends an empty `applied`, never an absent one, because "no
 * files were touched" is a fact worth transmitting and "the producer forgot the
 * field" is not the same fact.
 *
 * The journal is not restated to achieve that. `modificationRecordSchema` is
 * imported from `@debuggen/instrumentation`, the package that owns the record —
 * both content hashes against its 64-lowercase-hex rule, the backup path, the
 * unified diff, the status machine and the `previousRecordId` link — so a record
 * that would be refused by the store is refused by the transport for the same
 * reason, in the same words, and a field added to the journal appears here in
 * the same edit (AAP §0.9.1).
 *
 * ## Only the normalised plan travels
 *
 * `@debuggen/instrumentation` publishes two plan schemas and this module embeds
 * exactly one of them: `instrumentationPlanSchema`, the **normalised** artifact.
 * The authoring schema `instrumentationPlanInputSchema` — the shape a model
 * writes, with optional rationales, no ids and no adapter or mode — is not a
 * wire type and must never become one. That is AAP §0.5.3's ordering expressed
 * as a schema choice: a model's proposal is validated against the authoring
 * schema, deterministically normalised (`normalizePlan`, which resolves every
 * action to the adapter that claimed its type and to `runtime` or `patch`), then
 * re-validated against the internal schema. Only the artifact that survived all
 * three steps is allowed on the wire, so a consumer of this payload can rely on
 * every action carrying an `id`, an `adapter`, a `mode` and a `rationale`
 * without knowing anything about how it was authored — and an authoring-shaped
 * plan sent here is rejected rather than silently installed.
 *
 * Two further properties of the embedded plan matter to a reader of this
 * message and are documented rather than implemented here, because the service
 * owns them:
 *
 * - A follow-up that needs more evidence produces `planVersion n + 1` as the
 *   previous plan **plus** additive actions, never removing an installed one,
 *   and the installer applies only the delta (AAP §0.4.2). An action that
 *   carries over keeps its id, which is what makes "only the delta" decidable.
 * - When a delta action touches a file an earlier plan version already patched,
 *   the new record's `originalHash` is the earlier record's `instrumentedHash`
 *   and its `previousRecordId` names that record. Cleanup unwinds such a chain
 *   in strict reverse order, checking at each step that the file still hashes to
 *   that record's `instrumentedHash` before writing that record's backup.
 *
 * ## `failed` means nothing could be enabled — nothing narrower
 *
 * A capture that will be *narrower* than the plan asked for is a success.
 * AAP §0.5.5 is explicit: when a signal cannot be enabled the capture proceeds
 * with what is available and the developer is told "Could not enable ‹signal›:
 * ‹reason›. Continuing with: ‹enabled list›." — so a partially satisfied plan
 * arrives as `instrumentation.ready` with a non-empty {@link unavailableSignalSchema}
 * list, and `instrumentation.failed` is reserved for the case where **nothing at
 * all** could be enabled. `packages/instrumentation/src/installer.ts` is the only
 * party that can tell the two apart, because it is the only one that sees every
 * adapter's answer.
 *
 * The same rule holds one layer further on, and is worth stating because the two
 * failures look alike from a distance: a **fallback panel** is not a failure
 * either. A model panel specification that fails validation is replaced by a
 * deterministic panel built from the captured data and delivered as
 * `panel.generated` with `meta.fallback` set and a visible banner (AAP §0.5.5).
 * Neither that nor a narrowed capture may be reported through this module.
 *
 * ## The one shape this module authors
 *
 * {@link unavailableSignalSchema} validates the `{ signal, reason, hint }`
 * triple of AAP §0.4.2. Its type is owned upstream — `UnavailableSignal` in
 * `packages/instrumentation/src/adapter.ts` — but that package publishes it as a
 * TypeScript interface with no Zod schema, and a payload crossing a process
 * boundary needs a runtime check. Supplying one here is therefore sanctioned and
 * is not a second definition: the type still comes from its owner through an
 * `import type`, and {@link UnavailableSignalDriftAssertions} pins the two
 * together at compile time so they cannot drift apart unnoticed.
 *
 * ## House rules this module observes
 *
 * - **Environment-neutral.** `packages/protocol/tsconfig.json` declares
 *   `types: []` and `tsup.config.ts` builds with `platform: 'neutral'`: no
 *   `node:*` builtin, no `@debuggen/shared/node` entry and no `ws` import
 *   appears anywhere in this package, which is loaded by a Node process and by
 *   three page-side bundles alike.
 * - **One folder edge.** The import block is `zod`, `@debuggen/shared`,
 *   `@debuggen/instrumentation`, `../version.js` and `./error.js` — the last
 *   being this folder's single permitted intra-folder edge and the reason
 *   `./error.ts` imports no sibling of its own. Nothing here imports
 *   `../envelope.js`, `../http.js` or `../client/**`: those modules sit *above*
 *   this one and reach it through `./index.js`.
 * - **No import-time side effects.** `package.json` declares
 *   `sideEffects: false`; every export below is a declaration.
 * - **Byte-faithful parsing.** No `.transform()`, no `.coerce`, no `.default()`
 *   and no `.catch()`. A schema validates; it never rewrites. An empty array
 *   stays empty rather than being filled in, and an omitted optional stays
 *   omitted, so a payload survives a JSON round trip unchanged.
 * - **No rejected value in a failure message** (AAP §0.5.2). Every parse helper
 *   builds its rejection through `protocolParseError`, whose message is
 *   assembled from issue paths, issue codes and schema-declared metadata only.
 *   That matters more here than almost anywhere else in the package: a
 *   `ModificationRecord` carries a unified diff of the developer's own source,
 *   and an error path that echoed its input would put that diff into a log line
 *   and a user-interface banner.
 *
 * Every export is named; there is no default export.
 */

import { z } from 'zod';

import { err, ok } from '@debuggen/shared';
import type { DebuggenError, Result } from '@debuggen/shared';
import {
  captureSignalSchema,
  instrumentationPlanSchema,
  modificationRecordSchema,
} from '@debuggen/instrumentation';
import type { UnavailableSignal } from '@debuggen/instrumentation';

import { protocolParseError } from '../version.js';
import { errorPayloadSchema } from './error.js';

// ---------------------------------------------------------------------------
// Section A — module-local bounds and primitives
//
// The canonical bounds of this folder, each stated once as a named constant so
// the schema, the expectation a rejection reports and the comment beside it
// cannot drift apart. Every sibling message module uses the same numbers for
// the same kinds of field, which is what keeps a payload assembled by one
// module and re-validated by another from being refused on a length rule the
// sender never knew about.
//
// They are module-local rather than exported for a mechanical reason: `./index.ts`
// re-exports every module in this folder wholesale, and a name exported from
// several of them would be an ambiguous re-export rather than a shared
// constant.
// ---------------------------------------------------------------------------

/**
 * The longest identifier or short name any payload in this module will
 * consider.
 *
 * The ids this product mints are twenty characters — a three-letter kind
 * prefix, an underscore and sixteen random characters — so sixty-four leaves
 * generous room for an id from an older build or a longer prefix while still
 * refusing a frame that arrived with a megabyte where a session id belonged, on
 * a length check rather than on a pattern match. It also bounds the two short
 * names this module accepts: a capture-signal name and a runtime-hook label.
 */
const MAX_ID_LENGTH = 64;

/**
 * The ceiling on {@link unavailableSignalSchema}'s `reason`.
 *
 * Deliberately wider than the 500 characters `schema/readiness.ts` allows on
 * the readiness row built from the same words. The direction is the safe one: a
 * transport that refused a sentence the producing layer had already accepted
 * would drop a gap AAP §0.5.5 requires the developer to be told about, which is
 * the one failure mode worse than an over-long row in a list.
 */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * The ceiling on a developer-facing recovery hint — {@link unavailableSignalSchema}'s
 * `hint` and {@link instrumentationFailedErrorSchema}'s.
 *
 * A thousand characters because a hint is sometimes a command rather than a
 * sentence: AAP §0.5.5 requires that a dev server started without the telemetry
 * preload yields the exact relaunch command, composed by the adapter from the
 * project root and the package manager the project actually uses, and a command
 * line with an absolute path and an environment assignment in front of it is
 * longer than a sentence about it would be.
 */
const MAX_HINT_LENGTH = 1000;

/**
 * The ceiling on every array in this module: applied records, runtime-hook
 * labels and unavailable signals alike.
 *
 * A plan covers the files one question implicates, not a repository, so a
 * thousand is orders of magnitude above any real install and low enough that a
 * frame claiming to have patched a million files is refused before its elements
 * are validated one by one. The bound is uniform across the three arrays on
 * purpose: they are read together, rendered together and would be truncated
 * together, so a different limit per array would only add a way for one of the
 * three to be refused while its siblings were accepted.
 */
const MAX_ARRAY_LENGTH = 1000;

/**
 * An opaque identifier as a payload field: a non-empty string of at most
 * {@link MAX_ID_LENGTH} characters.
 *
 * Deliberately **not** the `ses_` prefix pattern. The prefix vocabulary and the
 * id grammar belong to `@debuggen/shared`'s `ids` module, which mints every id
 * in the product; re-deriving either here would be a second definition of a
 * shape this package does not own, and it would reject a stored session from a
 * build whose prefixes differed. The transport makes the one check a transport
 * can make — that the field is a string of plausible length — and identity is
 * established where the id is looked up, against the store.
 */
const idSchema = z
  .string({ error: 'expected an identifier string' })
  .min(1, { error: 'expected a non-empty identifier' })
  .max(MAX_ID_LENGTH, {
    error: `expected an identifier of at most ${String(MAX_ID_LENGTH)} characters`,
  });

/**
 * One runtime hook, named for a developer to read.
 *
 * A bounded string and **not** the capture-signal vocabulary, which mirrors
 * `InstallResult.runtimeHooks` upstream: a hook label is a *description* at the
 * granularity the adapter owns, and it is routinely finer than a signal — one
 * signal can arm several hooks, and an adapter names each of them in the words
 * the editor's "Preparing instrumentation" checklist displays (AAP §0.1.2,
 * Step 8). The machine-readable statement of what was enabled is the agent hook
 * configuration and the server signal set derived from the installed actions,
 * not this list, so narrowing it to an enumeration would lose the display value
 * without gaining a decidable one.
 */
const runtimeHookSchema = z
  .string({ error: 'expected a runtime hook label string' })
  .min(1, { error: 'expected a non-empty runtime hook label' })
  .max(MAX_ID_LENGTH, {
    error: `expected a runtime hook label of at most ${String(MAX_ID_LENGTH)} characters`,
  });

/**
 * A capture-signal name: one of the product's twelve known signals, or a name
 * an adapter registered at runtime defines for itself.
 *
 * The first arm is `captureSignalSchema`, imported from the package that owns
 * the vocabulary, so not one of the twelve strings is typed out here and a
 * signal added there widens this field in the same edit. The second arm is what
 * makes the field faithful to the upstream type, whose `signal` is
 * `CaptureSignal | (string & {})`: AAP §0.4.2 promises that adding an adapter
 * means implementing the interface and registering it, with no orchestrator
 * change, and such an adapter may report a gap in a signal of its own. Refusing
 * that name at the transport would silently drop the one thing AAP §0.5.5
 * guarantees reaches the developer — that a signal is missing and what to do
 * about it — so it is admitted, bounded like every other short name here.
 *
 * The second arm therefore subsumes the first at runtime, and that is the
 * intent rather than an oversight: the enum arm carries no validation weight,
 * it carries *meaning*. It keeps the known vocabulary inside the schema, in the
 * JSON Schema rendered from it and in the issue tree a rejection reports, which
 * is what a producer needs in order to discover that it misspelled one of the
 * twelve rather than defining a thirteenth.
 */
const captureSignalNameSchema = z.union(
  [
    captureSignalSchema,
    z
      .string()
      .min(1, { error: 'expected a non-empty signal name' })
      .max(MAX_ID_LENGTH, {
        error: `expected a signal name of at most ${String(MAX_ID_LENGTH)} characters`,
      }),
  ],
  {
    error:
      'expected a capture signal name: one declared by @debuggen/instrumentation, or a bounded non-empty name defined by a registered adapter',
  },
);

// ---------------------------------------------------------------------------
// Section B — the one shape this module authors
// ---------------------------------------------------------------------------

/**
 * One signal that could not be enabled, and what the developer can do about it:
 * the `{ signal, reason, hint }` element of `instrumentation.ready`'s
 * `unavailable` list.
 *
 * All three fields are required, exactly as AAP §0.4.2 writes them and exactly
 * as the upstream `UnavailableSignal` declares them. `hint` in particular is not
 * optional: this list is the graceful-degradation channel of AAP §0.5.5, whose
 * whole point is that a narrowed capture is *actionable* rather than merely
 * honest, and a gap with no stated next step is a dead end dressed as a
 * notification.
 *
 * Both strings are rendered verbatim into the developer's sentence — "Could not
 * enable ‹signal›: ‹reason›. Continuing with: ‹enabled list›." — so this schema
 * bounds them and says nothing about their content. It does not refuse a
 * multi-line value either, though the words are written to be single-line and
 * `schema/readiness.ts` refuses a multi-line `reason` or `hint` on the readiness
 * row built from them: that opinion belongs to the layer that composes the
 * words, and duplicating it at the transport would mean a gap the producing
 * layer accepted could still be lost on its way to the surface that displays
 * it.
 *
 * `z.strictObject`, like every payload in this folder: an unrecognised key is a
 * producer working from a different contract, and naming the key in a rejection
 * is how that disagreement is found in development instead of inferred from a
 * missing value in production.
 *
 * @see {@link UnavailableSignalDriftAssertions} for the compile-time pin to the
 * upstream type.
 */
export const unavailableSignalSchema = z.strictObject({
  /**
   * Which signal is missing: one of the known capture signals, or a name a
   * registered adapter defines. See {@link captureSignalNameSchema}.
   */
  signal: captureSignalNameSchema,

  /**
   * What was observed, as a fragment that reads after the colon.
   *
   * Non-empty, because a gap with nothing to say is indistinguishable from a
   * dropped field, and bounded by {@link MAX_MESSAGE_LENGTH}.
   */
  reason: z
    .string({ error: 'expected a reason string' })
    .min(1, { error: 'expected a non-empty reason' })
    .max(MAX_MESSAGE_LENGTH, {
      error: `expected a reason of at most ${String(MAX_MESSAGE_LENGTH)} characters`,
    }),

  /**
   * The one thing the developer can do about it — a concrete action, and for a
   * missing dev-server preload the exact relaunch command (AAP §0.5.5).
   *
   * Bounded by {@link MAX_HINT_LENGTH} rather than by the reason's bound,
   * because a command is a different kind of string from a sentence.
   */
  hint: z
    .string({ error: 'expected a hint string' })
    .min(1, { error: 'expected a non-empty hint' })
    .max(MAX_HINT_LENGTH, {
      error: `expected a hint of at most ${String(MAX_HINT_LENGTH)} characters`,
    }),
});

/**
 * One unavailable signal, as validated at the transport boundary.
 *
 * Named `…Payload` rather than `UnavailableSignal` so it cannot shadow the
 * upstream type this module imports: the two are pinned to each other by
 * {@link UnavailableSignalDriftAssertions}, and a reader who sees both names in
 * one file should be able to tell at a glance which one is the owner's. The
 * upstream type is deliberately **not** re-exported from here — a consumer that
 * wants it imports it from the package that declares it.
 */
export type UnavailableSignalPayload = z.infer<typeof unavailableSignalSchema>;

// ---------------------------------------------------------------------------
// Compile-time drift guard for the authored shape
//
// `UnavailableSignal` is published by `packages/instrumentation/src/adapter.ts`
// as an interface with no Zod schema, so this module supplies the runtime check
// — and nothing but the assertion below stops the check and the type from
// drifting apart. The failure mode of drift is silent in the worst direction: a
// field added upstream would be refused by this strict parser, and a field
// removed upstream would leave a producer sending a key no consumer reads, in
// the one message whose job is to tell a developer what happened to their
// files.
//
// Everything here is type-level: helper aliases, no runtime code, no new
// dependency, nothing emitted into the bundle.
// ---------------------------------------------------------------------------

/**
 * Fails to compile unless its argument is exactly `true`.
 *
 * The whole mechanism of the assertion below: a helper that computed `false`
 * violates the `extends true` constraint, which TypeScript reports at the
 * declaration site (`TS2344`) whether or not anything reads the result.
 */
type Expect<TAssertion extends true> = TAssertion;

/**
 * Restates every property of `T` as required-and-possibly-`undefined`, and
 * drops the `readonly` modifiers the upstream interface declares.
 *
 * The normalisation exists because the repository compiles with
 * `exactOptionalPropertyTypes`, under which `{ hint?: string }` — how a
 * hand-written type spells an optional field — and `{ hint?: string | undefined }`
 * — what Zod infers for `.optional()` — are not mutually assignable even though
 * they describe the same wire bytes. Comparing the normalised forms asks the
 * question that matters (are these the same fields carrying the same value
 * types?) rather than the one the exactness flag answers, and
 * {@link OptionalKeysOf} covers optionality separately so neither question is
 * lost.
 */
type WithExplicitUndefined<T> = { -readonly [K in keyof T]-?: T[K] | undefined };

/**
 * `true` when `A` and `B` describe the same fields with the same value types,
 * compared through {@link WithExplicitUndefined}.
 *
 * Each side is wrapped in a one-element tuple so a union on either side is
 * compared as a whole rather than distributed over its members — which is
 * load-bearing here, since the upstream `signal` field is a union of a literal
 * enumeration and a widened string.
 */
type MutuallyAssignable<A, B> = [WithExplicitUndefined<A>] extends [WithExplicitUndefined<B>]
  ? [WithExplicitUndefined<B>] extends [WithExplicitUndefined<A>]
    ? true
    : false
  : false;

/**
 * The keys of `T` that are declared optional.
 *
 * `Pick<T, K>` is a one-property object type that the empty `object` type
 * satisfies exactly when that property may be absent, which is what
 * distinguishes an optional key from a required one whose type happens to
 * include `undefined`.
 */
type OptionalKeysOf<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/**
 * `true` when `A` and `B` are the same type by the usual invariant-position
 * comparison — stricter than mutual assignability, and used here for key
 * unions, where that strictness is what catches a key that moved between
 * required and optional.
 */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * The compile-time assertion that {@link unavailableSignalSchema} still mirrors
 * the upstream `UnavailableSignal`: same fields, same value types, same
 * optionality.
 *
 * Add a field upstream and the first element becomes `false`; change a field's
 * type — including narrowing `signal` back to the closed enumeration, or
 * widening `reason` — and it does too; move a field between required and
 * optional and the second element does. Either way this file stops compiling,
 * which is the intent: the alternative is a field that exists on one side of a
 * process boundary and is discarded at the other, in the message a developer
 * relies on to know what happened to their source files.
 *
 * Nothing is projected out of the comparison. This schema and that interface are
 * meant to be the same three fields, unlike `./error.ts`'s guard, which has two
 * documented differences to exclude.
 *
 * It is exported for a mechanical reason worth stating, since it is otherwise an
 * odd thing to publish: the repository compiles with `noUnusedLocals` and lints
 * with `@typescript-eslint/no-unused-vars`, under which an unreferenced local
 * alias is itself an error, and a JSDoc reference does not count as a use. The
 * export costs nothing at runtime — it is a type, so no value is emitted — and
 * it gives the assertion a name a reader can search for.
 */
export type UnavailableSignalDriftAssertions = [
  Expect<MutuallyAssignable<UnavailableSignal, UnavailableSignalPayload>>,
  Expect<Identical<OptionalKeysOf<UnavailableSignal>, OptionalKeysOf<UnavailableSignalPayload>>>,
];

// ---------------------------------------------------------------------------
// Section C — the three payloads
// ---------------------------------------------------------------------------

/**
 * `instrumentation.plan` — the service tells the editor and the DevTools panel
 * what it is about to do, before it does any of it.
 *
 * Sent once per plan version, after the planning stage has produced a validated
 * plan and before the installer touches anything, which is what makes the
 * message worth its own frame: a developer sees the intended edits — file,
 * symbol, action type, install mode and the rationale for each — while nothing
 * has yet been written to their working tree. The editor renders it as the plan
 * list beside the relevant-files list; the panel renders it in the session
 * summary.
 *
 * The embedded plan is the **normalised** artifact and only ever that; see the
 * module header for why an authoring-shaped plan is refused here rather than
 * accommodated.
 *
 * Both fields are required. `sessionId` is what makes the frame routable by a
 * client holding several sessions open — the envelope carries one too, and this
 * payload's copy is what a stored message or a replayed session update remains
 * self-describing by — and `plan` carries its own `sessionId` and `planVersion`
 * inside it, which a consumer may cross-check but must not substitute for the
 * routing field.
 */
export const instrumentationPlanPayloadSchema = z.strictObject({
  /** The session this plan belongs to. */
  sessionId: idSchema,

  /**
   * The validated, normalised plan, as `@debuggen/instrumentation` defines it.
   *
   * Embedded rather than restated: the plan's own schema owns the literal shape
   * version, the revision counter, the objective, the hypotheses, the prose
   * capture list and every action's id, path normal form, type, adapter, mode
   * and rationale (AAP §0.9.1).
   */
  plan: instrumentationPlanSchema,
});

/**
 * The validated payload of an `instrumentation.plan` frame.
 *
 * Inferred from {@link instrumentationPlanPayloadSchema}, so `plan` is exactly
 * the upstream `InstrumentationPlan` and the validator and the type cannot
 * disagree about a field.
 */
export type InstrumentationPlanPayload = z.infer<typeof instrumentationPlanPayloadSchema>;

/**
 * `instrumentation.ready` — the service reports what it actually managed to arm,
 * and hands both user interfaces their entire picture of what happened.
 *
 * Sent when installation finishes and the session reaches "Ready to capture".
 * The three arrays are the whole report and are read together: the patches that
 * were applied to files, the runtime hooks that came up, and the signals that
 * did not. A developer looking at the editor's modification list or the panel's
 * session summary is looking at exactly this payload (AAP §0.5.1).
 *
 * **All three arrays are required and may be empty**, and the distinction
 * carries meaning in both directions:
 *
 * - A runtime-only plan — the common case, since AAP §0.5.1 makes runtime hooks
 *   the default and an edit the exception — applies no file modification, so
 *   `applied` is `[]`. That is the good outcome, not a missing field.
 * - A fully satisfied plan reports no gaps, so `unavailable` is `[]`. A
 *   non-empty list means the capture will be narrower than the plan asked for
 *   and the developer is told so; it does **not** mean the install failed (see
 *   the module header, and {@link instrumentationFailedPayloadSchema} for the
 *   case that does).
 *
 * None of the three is optional and none carries a default, because a consumer
 * must never have to distinguish "nothing happened" from "the producer did not
 * say".
 */
export const instrumentationReadyPayloadSchema = z.strictObject({
  /** The session whose instrumentation is now in place. */
  sessionId: idSchema,

  /**
   * The modification records this install produced, in the order they were
   * applied — which is the order cleanup must reverse.
   *
   * Each element is a journal entry the store already holds: the record is
   * appended before the write and marked `applied` after the atomic rename
   * (AAP §0.5.1), so an element here has been persisted rather than merely
   * constructed. It carries both content hashes, the backup path, the unified
   * diff the editor's diff view renders and, for a file an earlier plan version
   * already patched, the `previousRecordId` that makes the chain restorable in
   * reverse order.
   *
   * Validated by the journal's own schema, so the 64-lowercase-hex hash rule,
   * the project-relative path rule and the status vocabulary are the store's and
   * the transport's at once.
   */
  applied: z.array(modificationRecordSchema).max(MAX_ARRAY_LENGTH, {
    error: `expected at most ${String(MAX_ARRAY_LENGTH)} modification records`,
  }),

  /**
   * The runtime hooks that came up, named for a developer to read.
   *
   * The evidence behind the editor's "Preparing instrumentation" checklist. A
   * hook is listed when the adapter has contributed the configuration that
   * enables it, not when it merely intends to, so a developer told a hook is on
   * can rely on it. Kept as plain strings per the contract — see
   * {@link runtimeHookSchema}.
   */
  runtimeHooks: z.array(runtimeHookSchema).max(MAX_ARRAY_LENGTH, {
    error: `expected at most ${String(MAX_ARRAY_LENGTH)} runtime hook labels`,
  }),

  /**
   * The signals that could not be enabled here, each with its reason and its
   * one concrete next step.
   *
   * The graceful-degradation channel of AAP §0.5.5, rendered as "Could not
   * enable ‹signal›: ‹reason›. Continuing with: ‹enabled list›." — where the
   * enabled list is composed from {@link runtimeHooks} and {@link applied}
   * rather than transmitted a second time.
   */
  unavailable: z.array(unavailableSignalSchema).max(MAX_ARRAY_LENGTH, {
    error: `expected at most ${String(MAX_ARRAY_LENGTH)} unavailable signals`,
  }),
});

/**
 * The validated payload of an `instrumentation.ready` frame.
 *
 * Inferred from {@link instrumentationReadyPayloadSchema}, so `applied` is
 * exactly `ModificationRecord[]`, `runtimeHooks` is `string[]` and
 * `unavailable` is {@link UnavailableSignalPayload}`[]`.
 */
export type InstrumentationReadyPayload = z.infer<typeof instrumentationReadyPayloadSchema>;

/**
 * The error object nested inside `instrumentation.failed`: `{ code, message,
 * hint }` — plus the optional correlation `ref` every error in this protocol
 * may carry.
 *
 * Built by extending `./error.ts`'s `errorPayloadSchema` rather than restating
 * it. That is this folder's single permitted intra-folder edge, and it is what
 * keeps the closed error-code vocabulary, the message bound and the strictness
 * of the generic frame true of this nest as well: a code added to
 * `@debuggen/shared` widens both in one edit, and an unrecognised key is refused
 * here exactly as it is there.
 *
 * The one field added is `hint`, and it is **required**. AAP §0.4.2 writes this
 * nested object as `{ code, message, hint }` without an optional marker, and
 * AAP §0.5.5 is why: when nothing at all could be enabled, the hint is what
 * makes the failure recoverable — for a dev server started without the
 * telemetry preload it is the exact relaunch command. The generic `error` frame
 * deliberately carries no `hint` (it states its recovery instruction inside the
 * sentence instead), which is precisely why the field is declared here, in the
 * one message AAP §0.4.2 gives a separately rendered next step to.
 *
 * Requiring it has a deliberate consequence for producers: `toErrorPayload`'s
 * result is not a valid nest on its own, because that projection drops the
 * class's optional hint. A producer composes the two, which is a type error
 * until it supplies a next step — the loud failure being the point.
 *
 * @example
 * ```ts
 * send({
 *   type: 'instrumentation.failed',
 *   payload: {
 *     sessionId,
 *     error: {
 *       ...toErrorPayload(error, String(plan.planVersion)),
 *       hint: error.hint ?? relaunchInstruction,
 *     },
 *   },
 * });
 * ```
 */
export const instrumentationFailedErrorSchema = errorPayloadSchema.extend({
  /**
   * The one concrete action that makes this failure recoverable.
   *
   * Non-empty and bounded by {@link MAX_HINT_LENGTH}, which is wider than a
   * sentence needs because a hint is sometimes a command.
   */
  hint: z
    .string({ error: 'expected a hint string' })
    .min(1, { error: 'expected a non-empty hint' })
    .max(MAX_HINT_LENGTH, {
      error: `expected a hint of at most ${String(MAX_HINT_LENGTH)} characters`,
    }),
});

/**
 * The error nested inside an `instrumentation.failed` frame: a code from the
 * shared vocabulary, a sentence, a required hint and an optional correlation
 * reference.
 */
export type InstrumentationFailedError = z.infer<typeof instrumentationFailedErrorSchema>;

/**
 * `instrumentation.failed` — the service reports that **nothing** could be
 * enabled.
 *
 * This frame is narrow on purpose, and the narrowness is the contract. A signal
 * that could not be armed, a plan satisfied in part, a panel specification that
 * had to fall back to a deterministic layout — none of those is a failure, and
 * none of them may be reported here: the first two arrive as
 * {@link instrumentationReadyPayloadSchema} with a non-empty `unavailable` list,
 * and the third as `panel.generated` with `meta.fallback` set and a visible
 * banner (AAP §0.5.5). Sending this frame for any of them would report a
 * failure the developer does not have, and the converse rule holds just as
 * firmly: the session's state machine reaches `generated` only with a validated
 * analysis and a validated panel, so a failure is never presented as a success
 * either.
 *
 * What a client does with it is show the failing stage and offer the hint's next
 * step; the session's status is `failed` at that stage, and nothing was left
 * behind — records the installer applied before giving up are reverse-restored
 * by the installer itself, and any record that survives a crash is reconciled on
 * the next service start (AAP §0.5.1).
 */
export const instrumentationFailedPayloadSchema = z.strictObject({
  /** The session whose instrumentation could not be installed at all. */
  sessionId: idSchema,

  /** What went wrong, and the one thing to do about it. */
  error: instrumentationFailedErrorSchema,
});

/** The validated payload of an `instrumentation.failed` frame. */
export type InstrumentationFailedPayload = z.infer<typeof instrumentationFailedPayloadSchema>;

// ---------------------------------------------------------------------------
// Section D — parse helpers
//
// One per payload, and each of them returns its failure rather than throwing: a
// client reading a frame about an install is in no position to catch an
// exception, and the envelope's own dispatch is a `Result` pipeline.
//
// All three route their rejection through `protocolParseError`, which renders
// the issues with `describeZodIssues` — issue paths, issue codes and
// schema-declared metadata, never a rejected value. That guarantee is load
// bearing in this module beyond the package-wide reason for it: a
// `ModificationRecord` carries a unified diff of the developer's own source, so
// an error path that echoed its input would leak their code into a log line, a
// persisted session row and a banner in two user interfaces (AAP §0.5.2).
// ---------------------------------------------------------------------------

/**
 * Validates an unknown value as an {@link InstrumentationPlanPayload}, without
 * throwing.
 *
 * This is how an `instrumentation.plan` frame that arrived from the service
 * becomes a typed value in the editor host, the webview or the DevTools panel.
 * A rejection here is worth taking seriously rather than retrying: the plan the
 * service sends has already been normalised and re-validated on its side, so a
 * payload that fails is a version disagreement or a defect, never an authoring
 * mistake the model could repair (AAP §0.5.3).
 *
 * @param value Any value believed to be an `instrumentation.plan` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of the failure and nothing about its content.
 */
export function parseInstrumentationPlanPayload(
  value: unknown,
): Result<InstrumentationPlanPayload, DebuggenError> {
  const parsed = instrumentationPlanPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid instrumentation plan payload',
      parsed.error.issues,
      'This payload carries a session id and a normalised instrumentation plan, whose actions each declare an id, a project-relative file, a symbol, a type, an adapter, an install mode and a rationale. An authoring-shaped plan is not accepted here.',
    ),
  );
}

/**
 * Validates an unknown value as an {@link InstrumentationReadyPayload}, without
 * throwing.
 *
 * This is how the modification list, the diff view and the session summary get
 * the records they render. The rejection names field paths only — never the
 * diff, the hashes or the file contents behind them.
 *
 * @param value Any value believed to be an `instrumentation.ready` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of the failure.
 */
export function parseInstrumentationReadyPayload(
  value: unknown,
): Result<InstrumentationReadyPayload, DebuggenError> {
  const parsed = instrumentationReadyPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid instrumentation ready payload',
      parsed.error.issues,
      'This payload carries a session id and three required arrays, each of which may be empty: the applied modification records, the runtime hook labels that came up, and the signals that could not be enabled with their reason and hint.',
    ),
  );
}

/**
 * Validates an unknown value as an {@link InstrumentationFailedPayload}, without
 * throwing.
 *
 * A malformed failure frame yields another failure, and the payload that failed
 * to parse is not attached to it — the intended trade, since the content is
 * unvalidated data from another process and this product does not put
 * unvalidated data into an error message. A client that wants to log the frame
 * still holds it, under its own redaction rules.
 *
 * @param value Any value believed to be an `instrumentation.failed` payload.
 * @returns `ok(payload)` with the validated payload, or `err(error)` describing
 * the shape of the failure.
 */
export function parseInstrumentationFailedPayload(
  value: unknown,
): Result<InstrumentationFailedPayload, DebuggenError> {
  const parsed = instrumentationFailedPayloadSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    protocolParseError(
      'PROTOCOL_INVALID_MESSAGE',
      'Invalid instrumentation failed payload',
      parsed.error.issues,
      'This payload carries a session id and an error object with a code from the @debuggen/shared vocabulary, a non-empty message and a required hint stating one concrete next step.',
    ),
  );
}

// ---------------------------------------------------------------------------
// Section E — the payload registry
// ---------------------------------------------------------------------------

/**
 * The WebSocket message types this module contributes, with their payload
 * schemas.
 *
 * `./index.ts` spreads this object — together with the equivalent map from every
 * sibling module — into `MESSAGE_PAYLOAD_SCHEMAS`, from which `MESSAGE_TYPES`
 * and the envelope's discriminated union are derived. Contributing a map rather
 * than having the barrel name each schema is what keeps the registry complete by
 * construction: a message defined here without being registered is impossible,
 * because the definition and the registration are the same edit.
 *
 * The keys are the message type names exactly as AAP §0.4.2 and the user's
 * prompt §16 write them. Frozen so a consumer cannot extend the protocol at
 * runtime, and `as const` so the keys survive as literal types — which is what
 * lets the envelope's union be derived from this object rather than declared
 * beside it.
 */
export const INSTRUMENTATION_MESSAGE_PAYLOADS = Object.freeze({
  'instrumentation.plan': instrumentationPlanPayloadSchema,
  'instrumentation.ready': instrumentationReadyPayloadSchema,
  'instrumentation.failed': instrumentationFailedPayloadSchema,
} as const);
