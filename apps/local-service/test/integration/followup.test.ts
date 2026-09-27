/**
 * The `followup` suite of `local-service-integration` (AAP §0.8.3): both paths
 * of AAP §0.4.2's Follow-up row driven end to end through the in-process
 * service — HTTP routes, the orchestrator, the follow-up stage, the real
 * installer, the real store and the real cleanup — with nothing faked below
 * the model boundary.
 *
 * ## What this suite proves that the colocated unit suite cannot
 *
 * `src/pipeline/stages/followup.test.ts` pins `diffAdditionalActions`, the
 * decision guard and both paths against fakes. This file proves the same rules
 * hold where they matter:
 *
 * - **Real version ladders.** `analyses`, `panels` (with `supersedes`) and
 *   `plans` (by `planVersion`) are read back from the service's own SQLite
 *   store; every new rung is appended and every earlier rung is asserted
 *   byte-for-byte unchanged.
 * - **A real chain.** Plan version *n* and *n + 1* both patch
 *   `src/server/services/trail-report.service.ts` through `installPlan`, so the
 *   second record's `originalHash` equals the first record's `instrumentedHash`
 *   because the patcher genuinely wrote those bytes — never because a fixture
 *   was hand-edited to look instrumented.
 * - **Reverse-order restoration, proven by SHA-256.** `POST /sessions/:id/end`
 *   runs the real `cleanupSession`/`restoreChain`; the newest record is reverted
 *   before the one it is layered on, and the copied project is byte-identical
 *   to its pre-session snapshot afterwards.
 * - **Additive-only is enforced, not observed.** A decision proposing a
 *   removal, a replacement and a re-scope of the installed action is refused
 *   proposal by proposal, each with its own reason, and the next plan version
 *   is the previous plan plus exactly the accepted addition.
 * - **A delta that fails part-way is undone at once.** The failure is injected
 *   at the filesystem, not through a code seam: a file planted in the session's
 *   content-addressed backup directory under the digest the second delta
 *   target will need makes the backup store refuse that write, so the patcher
 *   stops after the first delta target was already applied.
 * - **A delta whose plan version cannot be stored is undone as well.** The
 *   failure is injected at the database: a temporary trigger on the service's
 *   own connection aborts every insert into `plans`, so the install completes
 *   and only recording plan version n + 1 fails. The follow-up stage then
 *   reverse-restores the delta itself, and the files, the journal and the plan
 *   ladder all stand at version n again.
 * - **A plan row and its session record are one write.** A second trigger
 *   aborts the session-record update that mirrors a new plan row, *after* that
 *   row was inserted in the same transaction: the row is rolled back with it,
 *   so the `plans` table and `SessionRecord.plans` both stay at n, the delta is
 *   undone, and the later status write that files the session `failed` goes
 *   through. In both persistence failures the undone record reaches the editor
 *   and the DevTools clients as `reverted` through `session.updated`.
 * - **An edit between two installs becomes a conflict, never an overwrite.**
 *   A second session on a second copy edits the chained file after the first
 *   install; the second install refuses to layer over it, and cleanup leaves
 *   the developer's bytes exactly as they were.
 * - **A failed follow-up is retried by its attempt id, never duplicated.** A
 *   follow-up recorded and then failed at its decision is asked again with the
 *   same `attemptId`: the ladder keeps one entry and the store one `followups`
 *   row, rewritten in place as attempt 2. The service clock is frozen across
 *   both asks, so the two carry the same `askedAt`, and the retry's decision is
 *   held, so the route can only answer by recognising the attempt's identity.
 *   Asking the answered attempt again is refused before any stage runs, and a
 *   question sent under a new id is appended as its own follow-up.
 * - **The `followups` log and the session record are one history.** After the
 *   paths above, every session's `followups` rows equal its record's ladder,
 *   outcome links included. A trigger that aborts only the record write
 *   growing the ladder makes an ask fail with nothing stored: the `followups`
 *   row inserted in the same transaction is rolled back with it, before any
 *   decision call.
 * - **A follow-up is answered on the panel it was decided against, or not at
 *   all.** A third session's existing-evidence follow-up has its decision held
 *   while another writer stores the next panel version through the service's
 *   own store; released, the follow-up regenerates nothing, stores and pushes no
 *   panel, stays unanswered and files the session `failed` as `supersedes-stale`.
 *
 * ## Rules ruling
 *
 * - **User rules (AAP §0.10).** `review_rules` answers "No user rules
 *   provided."; no user rule governs this file, so the §0.10 baseline does.
 * - **Gate membership.** Collected by `pnpm test:integration`
 *   (`vitest run --project local-service-integration`) inside `pnpm verify`,
 *   compiled by `tsc -b`, linted with `--max-warnings 0` and formatted by
 *   `prettier --check .`.
 * - **Reversible, recorded file changes.** Every patch comes from the real
 *   installer and goes back through the real cleanup; the committed corpus is
 *   only ever copied (`harness.copyFixtureProject`) and each copy is compared
 *   against its snapshot with `assertTreeUnchanged`/`diffTreeSnapshots`.
 * - **No committed secrets.** Every credential is minted by the harness through
 *   the service's own auth service; no secret-shaped literal appears here.
 * - **Closed dependency set.** `@debuggen/*` (never `panel-renderer`),
 *   `node:*`, `vitest` and the harness. No `zod`, no DOM types.
 *
 * ## The model boundary
 *
 * Every stage runs on the real deterministic provider except the follow-up
 * decision, which is scripted: the suite must force each path and hand the
 * decision real action ids from the live plan (a removal names the installed
 * action's id), so {@link enqueueDecision} feeds one `FollowUpDecision` per
 * follow-up through the harness's scripted provider. The decisions are exactly
 * the `{ needsNewCapture, additionalActions }` contract the stage validates;
 * everything after the decision — the additive-only verdict, normalisation,
 * feasibility, the install, the store writes — is the product's own.
 *
 * The first plan of every session is the deterministic provider's own answer
 * with one narrowing: its patch-mode timings are cut to the route handler's.
 * The planner times the whole request path — route handler, service loader,
 * database helper — which `pipeline-deterministic` and `cleanup-conflict`
 * prove; the scenarios here instead need the service and pool files pristine
 * at rung n, because every delta they install, chain or conflict on starts
 * from those files' original bytes. The narrowed answer still passes the plan
 * stage's structured-output gate, normalisation, feasibility and the real
 * installer, so plan version n is exactly what the product records for it.
 *
 * Two suites leave the decision to the real rules-based provider instead
 * ({@link askRealFollowUp}), proving both paths reachable without a model: a
 * capture that recorded every signal the understanding needs is answered from
 * the stored evidence (`generated → analyzing → generated`), and follow-ups
 * that name an uninstrumented function of the service module are timed as
 * additive deltas — the second one layered over the first as a
 * `previousRecordId` chain that session end unwinds in reverse.
 *
 * @module
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  INSTRUMENTATION_ACTION_TYPES,
  INSTRUMENTATION_MODES,
  MODIFICATION_STATUSES,
  actionIdentityKey,
} from '@debuggen/instrumentation';
import type {
  InstrumentationAction,
  InstrumentationActionType,
  InstrumentationPlan,
  InstrumentationTargetInput,
  ModificationRecord,
} from '@debuggen/instrumentation';
import { createDeterministicProvider } from '@debuggen/model-provider';
import type { ModelProvider, ModelRequest } from '@debuggen/model-provider';
import { validatePanelSpec } from '@debuggen/panel-schema';
import type { PanelSpec } from '@debuggen/panel-schema';
import {
  CLEANUP_STATUSES,
  FOLLOW_UP_ATTEMPT_ID_PREFIX,
  FOLLOW_UP_OUTCOME_KEYS,
  PROGRESS_STAGES,
  PROGRESS_STATUSES,
  SESSION_STATUSES,
  isFollowUpAnswered,
  isMessageOfType,
} from '@debuggen/protocol';
import type {
  AnalysisResult,
  FollowUpRecord,
  SessionRecord,
  SessionStatus,
} from '@debuggen/protocol';
import {
  DebuggenError,
  isErr,
  newActionId,
  newEventId,
  newId,
  newPanelId,
  newProducerId,
  newSpanId,
  newTraceId,
  ok,
} from '@debuggen/shared';
import type { Result } from '@debuggen/shared';
import { SECURE_FILE_MODE, sha256Hex, sha256OfFile } from '@debuggen/shared/node';
import { TELEMETRY_TIERS } from '@debuggen/telemetry';

import {
  FOLLOW_UP_DELTA_REJECTION_REASONS,
  FOLLOW_UP_PATHS,
  FOLLOW_UP_STAGE,
} from '../../src/pipeline/stages/followup.js';
import type {
  FollowUpAdditionalAction,
  FollowUpDecision,
} from '../../src/pipeline/stages/followup.js';
import { publicFailureCopy } from '../../src/sessions/progress.js';
import { transition } from '../../src/sessions/state-machine.js';
import {
  HARNESS_TIMEOUTS,
  assertTreeUnchanged,
  createHarnessClock,
  createScriptedProvider,
  diffTreeSnapshots,
  readTelemetryBatch,
  snapshotTree,
  startHarness,
  waitFor,
  waitUntil,
} from './harness.js';
import type {
  FixtureProjectCopy,
  Harness,
  HarnessMessage,
  HarnessWsClient,
  ScriptedProvider,
  ScriptedStep,
} from './harness.js';

/* -------------------------------------------------------------------------------------------------
 * Vocabularies — every status, stage, type and mode is taken from its owning package
 * ---------------------------------------------------------------------------------------------- */

/**
 * One member of a published vocabulary, checked twice: by the compiler (the
 * literal must be assignable to the tuple's member type, so a rename upstream
 * fails `tsc -b` here) and at run time (so a value removed from a frozen tuple
 * fails with the vocabulary named rather than as a confusing mismatch later).
 */
function memberOf<const T extends string>(vocabulary: readonly T[], value: NoInfer<T>): T {
  if (!vocabulary.includes(value)) {
    throw new Error(`"${value}" is not a member of [${vocabulary.join(', ')}].`);
  }
  return value;
}

/** The session statuses this suite walks through (`SESSION_STATUSES`). */
const STATUS = Object.freeze({
  ready: memberOf(SESSION_STATUSES, 'ready'),
  planning: memberOf(SESSION_STATUSES, 'planning'),
  instrumenting: memberOf(SESSION_STATUSES, 'instrumenting'),
  analyzing: memberOf(SESSION_STATUSES, 'analyzing'),
  generated: memberOf(SESSION_STATUSES, 'generated'),
  failed: memberOf(SESSION_STATUSES, 'failed'),
  ended: memberOf(SESSION_STATUSES, 'ended'),
});

/** The modification statuses this suite asserts (`MODIFICATION_STATUSES`). */
const MODIFICATION = Object.freeze({
  applied: memberOf(MODIFICATION_STATUSES, 'applied'),
  reverted: memberOf(MODIFICATION_STATUSES, 'reverted'),
  conflict: memberOf(MODIFICATION_STATUSES, 'conflict'),
});

/** The cleanup verdicts this suite expects (`CLEANUP_STATUSES`). */
const CLEANUP = Object.freeze({
  clean: memberOf(CLEANUP_STATUSES, 'clean'),
  conflict: memberOf(CLEANUP_STATUSES, 'conflict'),
});

/** The action types the scripted decisions propose (`INSTRUMENTATION_ACTION_TYPES`). */
const ACTION_TYPE = Object.freeze({
  functionTiming: memberOf(INSTRUMENTATION_ACTION_TYPES, 'function-timing'),
  serverSpan: memberOf(INSTRUMENTATION_ACTION_TYPES, 'server-span'),
});

/** The install mode that edits a developer's file (`INSTRUMENTATION_MODES`). */
const PATCH_MODE = memberOf(INSTRUMENTATION_MODES, 'patch');

/** The progress stage and status of the install's closing "ready" row. */
const INSTRUMENT_STAGE = memberOf(PROGRESS_STAGES, 'instrument');
/** The progress stage a plan version that could not be recorded is filed under. */
const PLAN_STAGE = memberOf(PROGRESS_STAGES, 'plan');
const PROGRESS_DONE = memberOf(PROGRESS_STATUSES, 'done');
const PROGRESS_FAILED = memberOf(PROGRESS_STATUSES, 'failed');

/** The tier the browser agent reports in; every other tier is the preload's. */
const BROWSER_TIER = memberOf(TELEMETRY_TIERS, 'browser');

/**
 * The message of the follow-up stage's decision record. Which proposal was
 * refused for which reason is logged there and nowhere else — the decision
 * artifact is pipeline-internal and deliberately not part of the session
 * record — so it is the witness the additive-only assertions read, through the
 * harness's capture of the service's own logger.
 */
const FOLLOW_UP_DECIDED_LOG = 'Follow-up decided.';

/**
 * The message of the follow-up stage's record of a compensation that undid an
 * installed delta in full. Its fields — counts, record ids and whether the
 * arming state was returned to plan version n — are the witness that the
 * stage, not the installer, restored the delta whose plan version could not be
 * stored, and that `restoreArming` answered.
 */
const DELTA_ROLLED_BACK_LOG =
  'An installed follow-up delta could not be kept and was reverse-restored; the session stays at its previous plan version.';

/**
 * The message `session.question` logs when it answers because it observed the
 * ask recorded — rather than because the follow-up settled — with `retried`
 * telling a retry in place from a new follow-up.
 */
const RECORDED_FOLLOW_UP_LOG = 'Recorded a follow-up question; its answer continues';

/* -------------------------------------------------------------------------------------------------
 * The corpus — `test/fixtures/sample-project`, copied, never written in place
 * ---------------------------------------------------------------------------------------------- */

/**
 * The files and symbols of the `fixture-trailhead-guide` corpus the scripted
 * decisions name. Every first plan here is narrowed to the route handler's
 * timing (see {@link withRouteHandlerFirstPlan}), so the follow-ups reach into
 * the service layer: `summarizeConditions` exists in the corpus precisely to
 * give a follow-up plan its own patchable symbol beside `loadTrailReport` (see
 * the header of `app/api/trail-report/route.ts`).
 */
const CORPUS = Object.freeze({
  routeFile: 'app/api/trail-report/route.ts',
  serviceFile: 'src/server/services/trail-report.service.ts',
  loadSymbol: 'loadTrailReport',
  summarizeSymbol: 'summarizeConditions',
  poolFile: 'src/server/db/pool.ts',
  poolQuerySymbol: 'queryTrailConditionReports',
  poolGateSymbol: 'queryTrailheadGateStatus',
});

/** The committed cross-tier batch every capture of this suite replays. */
const CROSS_TIER_BATCH = 'telemetry-trace-cross-tier.json';

/** One ingress event of a batch, typed through the harness reader. */
type IngressEvent = ReturnType<typeof readTelemetryBatch>[number];

/**
 * The batch re-identified for a later capture.
 *
 * The store refuses an event id it already holds under another session, and a
 * second capture of the same session must not collide with the first, so a
 * capture after the first gets its own id block, following the fixture README's
 * id registry: the event-id tag becomes `f<block>`, the trace id's first hex
 * digit and the span ids' twelfth position become `<block>`, and the producer
 * ordinals move past the registry's last taken value, zero-padded to the
 * registry's two final digits so every producer id keeps its 16 characters
 * after the prefix. Only identities change — kinds, timings, attributes and the
 * parent/child shape (the deliberate orphan included) are carried over
 * verbatim.
 *
 * @param events The parsed committed batch.
 * @param block A digit 1–4, unique per capture within this file.
 */
function reidentifyBatch(events: readonly IngressEvent[], block: number): IngressEvent[] {
  if (!Number.isInteger(block) || block < 1 || block > 4) {
    throw new RangeError('A re-identified batch needs a block from 1 to 4.');
  }
  const digit = String(block);
  const span = (id: string): string => `${id.slice(0, 12)}${digit}${id.slice(13)}`;
  const ordinal = String(6 + block).padStart(2, '0');
  return events.map((event) => ({
    ...event,
    id: event.id.replace(/^evt_[a-z]{2}/u, `evt_f${digit}`),
    traceId: `${digit}${event.traceId.slice(1)}`,
    spanId: span(event.spanId),
    ...(event.parentSpanId === undefined ? {} : { parentSpanId: span(event.parentSpanId) }),
    producerId: `${event.producerId.slice(0, -2)}${ordinal}`,
  }));
}

/** The committed batch split by the producer that sends each half. */
function splitByProducer(events: readonly IngressEvent[]): {
  readonly browser: IngressEvent[];
  readonly server: IngressEvent[];
} {
  return {
    browser: events.filter((event) => event.tier === BROWSER_TIER),
    server: events.filter((event) => event.tier !== BROWSER_TIER),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Small utilities
 * ---------------------------------------------------------------------------------------------- */

/** The value of an `Ok`, or a thrown error naming the call and the refusal's code. */
function unwrap<T>(result: Result<T, DebuggenError>, what: string): T {
  if (isErr(result)) {
    throw new Error(`${what} was refused (${result.error.code}): ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.value;
}

/** The only element of a list, failing with `what` when there is not exactly one. */
function only<T>(items: readonly T[], what: string): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) {
    throw new Error(`Expected exactly one ${what}, found ${String(items.length)}.`);
  }
  return first;
}

/** The last element of a list, failing with `what` when it is empty. */
function last<T>(items: readonly T[], what: string): T {
  const found = items.at(-1);
  if (found === undefined) {
    throw new Error(`Expected at least one ${what}.`);
  }
  return found;
}

/** Whether a path exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** An absolute path inside a project copy. */
function inProject(project: FixtureProjectCopy, file: string): string {
  return join(project.root, file);
}

/* -------------------------------------------------------------------------------------------------
 * The scripted follow-up decisions
 * ---------------------------------------------------------------------------------------------- */

/**
 * How many follow-up decisions this file's model calls answer: six in the
 * first session (existing evidence, the refused-and-accepted delta, the delta
 * that fails part-way, the delta whose plan row cannot be stored, the delta
 * whose session record cannot account for its plan row, and the chain) and
 * five in the conflict session (the first delta, an attempt whose decision
 * fails, that attempt's retry, a new question under a new attempt id, and the
 * conflict), and one in the predecessor session (the existing-evidence
 * follow-up whose panel moved while its decision was held). The refused re-ask
 * of an answered attempt reaches no model call, so it has no step. Exactly this
 * many script steps exist, and the last test asserts every one was served — a
 * repair turn or an unexpected extra decision would shift the queue and fail
 * loudly.
 */
const FOLLOW_UP_COUNT = 12;

/**
 * What one follow-up's decision call answers: a decision handed to the stage's
 * structured-output gate, or a failure the provider's transport reports.
 */
type ScriptedDecision = FollowUpDecision | DebuggenError;

/** The answers the next follow-up decision calls receive, oldest first. */
const pendingDecisions: ScriptedDecision[] = [];

/** Queues the answer the next follow-up's model call receives. */
function enqueueDecision(answer: ScriptedDecision): void {
  pendingDecisions.push(answer);
}

/**
 * A decision call that fails at the transport, as an unreachable provider
 * reports it: returned as the call's `Err`, never thrown.
 */
function decisionUnavailable(): DebuggenError {
  return new DebuggenError(
    'MODEL_UNAVAILABLE',
    'The scripted provider did not answer this follow-up decision.',
    { details: { stage: FOLLOW_UP_STAGE } },
  );
}

/**
 * One script step answering only the `followup` stage. The answer is taken
 * from the queue when the call arrives — a decision can only name the live
 * plan's action ids once that plan exists — and exactly once per step, however
 * often the provider reads the step's fields: a queued failure is served as
 * `failure`, a queued decision as `raw`, handed to the stage's own
 * structured-output gate exactly as a provider's transport would hand it over.
 */
function decisionStep(): ScriptedStep {
  let answer: { readonly value: ScriptedDecision | undefined } | undefined;
  const take = (): ScriptedDecision | undefined => {
    answer ??= { value: pendingDecisions.shift() };
    return answer.value;
  };
  return {
    stage: FOLLOW_UP_STAGE,
    get failure(): DebuggenError | undefined {
      const value = take();
      return value instanceof DebuggenError ? value : undefined;
    },
    get raw(): unknown {
      const value = take();
      return value instanceof DebuggenError ? undefined : value;
    },
  };
}

/** One script step per follow-up decision, in the order they are asked. */
const DECISION_SCRIPT: readonly ScriptedStep[] = Array.from(
  { length: FOLLOW_UP_COUNT },
  decisionStep,
);

/** An authoring target for a scripted decision. */
function authoringTarget(
  file: string,
  symbol: string,
  type: InstrumentationActionType,
  rationale: string,
): InstrumentationTargetInput {
  return { file, symbol, type, rationale };
}

/**
 * A fully resolved proposal built from an installed action with some fields
 * replaced — the shape a model would use to try to change what is installed.
 */
function resolvedProposal(
  installed: InstrumentationAction,
  changes: Partial<Pick<InstrumentationAction, 'id' | 'file' | 'symbol' | 'type'>>,
  rationale: string,
): FollowUpAdditionalAction {
  return {
    id: changes.id ?? installed.id,
    file: changes.file ?? installed.file,
    symbol: changes.symbol ?? installed.symbol,
    type: changes.type ?? installed.type,
    adapter: installed.adapter,
    mode: installed.mode,
    rationale,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The harness, and the session helpers built on it
 * ---------------------------------------------------------------------------------------------- */

let harness: Harness;
let scripted: ScriptedProvider;

/**
 * The service clock: the harness's own monotonic counter clock, which a test
 * can freeze so that every read answers one millisecond — the only way to make
 * two asks carry the same `askedAt` through the real stage and store.
 */
const counterClock = createHarnessClock();
let frozenAt: number | undefined;

/** The clock handed to {@link startHarness}. */
function serviceNow(): number {
  return frozenAt ?? counterClock.now();
}

/**
 * Freezes the service clock until {@link thawServiceClock}.
 *
 * @returns The millisecond every read answers meanwhile.
 */
function freezeServiceClock(): number {
  frozenAt = counterClock.now();
  return frozenAt;
}

/** Lets the service clock move on from where it was frozen, monotonically. */
function thawServiceClock(): void {
  frozenAt = undefined;
}

/** A follow-up decision call held until its release, or `undefined` when none is held. */
let heldDecision: Promise<void> | undefined;

/**
 * Holds the next follow-up decision call until the returned function is
 * called. While it is held the follow-up cannot settle, so the route's answer
 * can only come from observing the recorded attempt.
 */
function holdNextDecision(): () => void {
  let release: () => void = () => undefined;
  heldDecision = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    heldDecision = undefined;
    release();
  };
}

/**
 * The real rules-based provider — the one `DEBUGGEN_PROVIDER=deterministic`
 * selects — which answers the follow-up decisions {@link askRealFollowUp}
 * hands it instead of the script.
 */
const realDecisionProvider: ModelProvider = unwrap(
  createDeterministicProvider(),
  'createDeterministicProvider',
);

/** How many upcoming follow-up decision calls the real provider answers instead of the script. */
let realDecisionsPending = 0;

/** Every follow-up decision request the real provider answered, oldest first. */
const realDecisionRequests: ModelRequest[] = [];

/**
 * The scripted provider with {@link holdNextDecision}'s gate in front of its
 * follow-up decision calls. Every call is still answered by the scripted
 * provider — and recorded by it — exactly once; only its timing is held. A
 * decision call {@link askRealFollowUp} claimed goes to the real rules-based
 * provider instead, and never reaches the script, so the scripted count below
 * stays exact.
 */
function withDecisionGate(provider: ModelProvider): ModelProvider {
  return {
    id: provider.id,
    generateText: (request) => provider.generateText(request),
    generateStructured: async (schema, request) => {
      if (request.metadata.stage === FOLLOW_UP_STAGE && realDecisionsPending > 0) {
        realDecisionsPending -= 1;
        realDecisionRequests.push(request);
        return realDecisionProvider.generateStructured(schema, request);
      }
      const held = request.metadata.stage === FOLLOW_UP_STAGE ? heldDecision : undefined;
      if (held !== undefined) {
        await held;
      }
      return provider.generateStructured(schema, request);
    },
    callTools: (request, tools) => provider.callTools(request, tools),
  };
}

/** The action types whose install edits a developer's file, whatever adapter claims them. */
const PATCH_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  ACTION_TYPE.functionTiming,
  ACTION_TYPE.serverSpan,
]);

/** Whether a decoded answer is a plain JSON object. */
function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether an authored plan target survives the narrowing: a runtime hook or the route timing. */
function keepsTarget(target: unknown): boolean {
  if (!isJsonRecord(target)) {
    return true;
  }
  const { file, type } = target;
  return typeof type !== 'string' || !PATCH_ACTION_TYPES.has(type) || file === CORPUS.routeFile;
}

/**
 * A plan stage's decoded answer with every patch-mode target outside the route
 * handler's file removed. Anything that is not an authored plan is handed back
 * unchanged, so the stage's own gate judges it exactly as it would have.
 */
function narrowedPlanAnswer(raw: unknown): unknown {
  if (!isJsonRecord(raw)) {
    return raw;
  }
  const targets: unknown = raw['instrumentationTargets'];
  if (!Array.isArray(targets)) {
    return raw;
  }
  const kept: unknown[] = targets.filter(keepsTarget);
  return { ...raw, instrumentationTargets: kept };
}

/**
 * The provider with every plan-stage answer narrowed by {@link narrowedPlanAnswer}
 * (see "The model boundary" in this module's header). The answer is still the
 * provider's own — only its decoded `raw` is narrowed, and the provider's
 * pre-parsed hint is dropped with it, so the stage validates what it runs on.
 */
function withRouteHandlerFirstPlan(provider: ModelProvider): ModelProvider {
  return {
    id: provider.id,
    generateText: (request) => provider.generateText(request),
    generateStructured: async (schema, request) => {
      const answered = await provider.generateStructured(schema, request);
      if (request.metadata.stage !== PLAN_STAGE || isErr(answered)) {
        return answered;
      }
      const { raw, text, model, providerId, usage, stopReason } = answered.value;
      return ok({
        raw: narrowedPlanAnswer(raw),
        model,
        providerId,
        ...(text === undefined ? {} : { text }),
        ...(usage === undefined ? {} : { usage }),
        ...(stopReason === undefined ? {} : { stopReason }),
      });
    },
    callTools: (request, tools) => provider.callTools(request, tools),
  };
}

/** A session driven through the real routes, with the connections that speak for it. */
interface LiveSession {
  /** The project copy the session instruments. */
  readonly project: FixtureProjectCopy;
  /** The session id. */
  readonly id: string;
  /** The inspected tab the DevTools connection bound. */
  readonly tabId: number;
  /** The editor connection announcing the project: the transcript every assertion reads. */
  readonly editor: HarnessWsClient;
  /** The DevTools connection, which also relays the page agent's frames. */
  readonly devtools: HarnessWsClient;
  /** The server-agent credential the dev-server preload would present. */
  readonly serverAgentToken: string;
  /** The message of the install's closing `done` row, as the first install showed it. */
  readonly readyMessage: string;
}

/** The session as the service's own store holds it. */
function storedSession(sessionId: string): SessionRecord {
  const record = unwrap(harness.repos.sessions.get(sessionId), 'sessions.get');
  if (record === undefined) {
    throw new Error(`The session ${sessionId} is not in the store.`);
  }
  return record;
}

/**
 * Waits until the stored session satisfies `predicate`. The store is read
 * directly rather than through `GET /sessions/:id`, because that route is the
 * reopen path and replays frames to every connected client — which would put
 * replays into the transcripts this suite reads pushes from.
 */
function waitForStored(
  sessionId: string,
  predicate: (record: SessionRecord) => boolean,
  description: string,
): Promise<SessionRecord> {
  return waitUntil(
    () => {
      const record = storedSession(sessionId);
      return predicate(record) ? record : undefined;
    },
    description,
    HARNESS_TIMEOUTS.pipeline,
  );
}

/** The session's modification journal, in application order. */
async function modificationsOf(sessionId: string): Promise<ModificationRecord[]> {
  return unwrap(await harness.repos.modifications.listBySession(sessionId), 'modifications');
}

/** The session's analysis ladder, oldest first. */
function analysesOf(sessionId: string): AnalysisResult[] {
  return unwrap(harness.repos.panels.listAnalyses(sessionId), 'panels.listAnalyses');
}

/** The session's panel ladder, oldest first. */
function panelsOf(sessionId: string): PanelSpec[] {
  return unwrap(harness.repos.panels.listPanels(sessionId), 'panels.listPanels');
}

/** The session's stored plan versions, oldest first. */
function plansOf(sessionId: string): InstrumentationPlan[] {
  return unwrap(harness.repos.sessions.listPlans(sessionId), 'sessions.listPlans');
}

/**
 * The ordered statuses a session moved through, as its `session.updated`
 * pushes after transcript index `from` announced them, starting from `initial`
 * and with repeats collapsed.
 */
function statusWalk(
  client: HarnessWsClient,
  sessionId: string,
  from: number,
  initial: SessionStatus,
): SessionStatus[] {
  const walk: SessionStatus[] = [initial];
  for (const message of client.received.slice(from)) {
    if (isMessageOfType(message, 'session.updated') && message.payload.session.id === sessionId) {
      const { status } = message.payload.session;
      if (walk.at(-1) !== status) {
        walk.push(status);
      }
    }
  }
  return walk;
}

/** Waits for the push announcing that the session reached `status` with `predicate` holding. */
function waitForPushedStatus(
  session: LiveSession,
  from: number,
  status: SessionStatus,
  predicate: (record: SessionRecord) => boolean = () => true,
): Promise<HarnessMessage<'session.updated'>> {
  return waitFor(
    session.editor,
    'session.updated',
    (message, index) =>
      index >= from &&
      message.payload.session.id === session.id &&
      message.payload.session.status === status &&
      predicate(message.payload.session),
    HARNESS_TIMEOUTS.pipeline,
  );
}

/**
 * Waits for the `session.updated` push, after `client`'s transcript index
 * `from`, whose record lists `recordId` as `reverted`: the mirror a follow-up
 * compensation sends so a client that was told the record was applied (by
 * `instrumentation.ready`) stops showing it so.
 */
function waitForRevertedMirror(
  client: HarnessWsClient,
  sessionId: string,
  from: number,
  recordId: string,
): Promise<HarnessMessage<'session.updated'>> {
  return waitFor(
    client,
    'session.updated',
    (message, index) =>
      index >= from &&
      message.payload.session.id === sessionId &&
      message.payload.session.modifications.some(
        (record) => record.id === recordId && record.status === MODIFICATION.reverted,
      ),
    HARNESS_TIMEOUTS.pipeline,
  );
}

/** The instrument stage's closing `done` rows pushed after transcript index `from`. */
function readyRowsSince(session: LiveSession, from: number): HarnessMessage<'session.progress'>[] {
  const rows: HarnessMessage<'session.progress'>[] = [];
  for (const [index, message] of session.editor.received.entries()) {
    if (
      index >= from &&
      isMessageOfType(message, 'session.progress') &&
      message.payload.sessionId === session.id &&
      message.payload.stage === INSTRUMENT_STAGE &&
      message.payload.status === PROGRESS_DONE
    ) {
      rows.push(message);
    }
  }
  return rows;
}

/**
 * Creates a session for `project` and drives it to `ready` through the real
 * pipeline: the launcher starts a stand-in dev server, a server-agent
 * connection stands for the preload (without one no file is ever patched), a
 * DevTools connection binds the tab and relays the page agent's `agent.ready`,
 * and the deterministic provider plans, its patch-mode timings narrowed to the
 * route handler's by {@link withRouteHandlerFirstPlan}.
 */
async function openReadySession(
  project: FixtureProjectCopy,
  tabId: number,
  question: string,
): Promise<LiveSession> {
  unwrap(await harness.launchDevServer(project.root), 'devServer.launch');
  const credential = harness.issueServerAgentCredential(project.root);
  const serverAgent = await harness.ws({
    client: 'server-agent',
    projectRoot: project.root,
    token: credential.token,
  });
  expect(serverAgent.authenticated).toBe(true);
  const editor = await harness.editor(project.root);

  const created = await harness.createSession({ projectRoot: project.root, question });
  const { client: devtools } = await harness.connectDevtools({ tabId });
  const bound = await harness.bindTab(devtools, {
    tabId,
    url: created.devServerUrl,
    origin: new URL(created.devServerUrl).origin,
    sessionId: created.id,
  });
  if (isErr(bound)) {
    throw new Error(`session.bind was refused (${bound.error.code}): ${bound.error.message}`);
  }
  const announced = devtools.send('agent.ready', {
    tabId,
    documentId: `doc_followup_tab_${String(tabId)}`,
    producerId: `prd_followup_tab_${String(tabId)}`,
    url: created.devServerUrl,
    installedBeforeReact: true,
    reactDetected: true,
  });
  unwrap(announced.result, 'agent.ready');
  expect(await devtools.flush()).toBe(true);
  expect(devtools.errorsFor(announced.id)).toEqual([]);

  await waitForStored(
    created.id,
    (record) => record.status === STATUS.ready,
    'the session is ready',
  );
  const readyRow = await waitFor(
    editor,
    'session.progress',
    (message) =>
      message.payload.sessionId === created.id &&
      message.payload.stage === INSTRUMENT_STAGE &&
      message.payload.status === PROGRESS_DONE,
  );
  return Object.freeze({
    project,
    id: created.id,
    tabId,
    editor,
    devtools,
    serverAgentToken: credential.token,
    readyMessage: readyRow.payload.message,
  });
}

/** What one capture produced. */
interface CaptureOutcome {
  readonly captureId: string;
  readonly record: SessionRecord;
}

/**
 * Opens a capture, sends the batch through both producers — the browser half
 * as a `telemetry.event` frame on the DevTools connection, the server half on
 * the preload's ingest route — closes it, and waits for the analysis and panel
 * the capture's evidence yields: in the store, and then in both clients'
 * transcripts — the editor's `generated` push and the DevTools client's
 * `panel.generated` — so a caller's next transcript marks fall after every push
 * this capture caused (the store is written before the push that announces it).
 */
async function captureAndGenerate(
  session: LiveSession,
  events: readonly IngressEvent[],
): Promise<CaptureOutcome> {
  const before = storedSession(session.id);
  const { captureId } = unwrap(await harness.startCapture(session.id), 'capture.start');
  const { browser, server } = splitByProducer(events);

  const relayed = await harness.ingestFromAgent(session.devtools, browser);
  unwrap(relayed.sent, 'telemetry.event');
  expect(relayed.settled).toBe(true);
  expect(relayed.errors).toEqual([]);
  unwrap(
    await harness.ingestFromServerAgent({
      token: session.serverAgentToken,
      projectRoot: session.project.root,
      events: server,
    }),
    'telemetry ingest',
  );

  const editorMark = session.editor.received.length;
  const devtoolsMark = session.devtools.received.length;
  unwrap(await harness.stopCapture(session.id), 'capture.stop');
  const generated = (current: SessionRecord): boolean =>
    current.status === STATUS.generated &&
    current.analyses.length === before.analyses.length + 1 &&
    current.panelIds.length === before.panelIds.length + 1;
  const record = await waitForStored(
    session.id,
    generated,
    'the capture is analysed and its panel generated',
  );
  await waitForPushedStatus(session, editorMark, STATUS.generated, generated);
  const panelId = record.panelIds.at(-1);
  await waitFor(
    session.devtools,
    'panel.generated',
    (message, index) =>
      index >= devtoolsMark &&
      message.payload.sessionId === session.id &&
      message.payload.panel.id === panelId,
    HARNESS_TIMEOUTS.pipeline,
  );
  return { captureId, record };
}

/** What asking one follow-up answered. */
interface AskedFollowUp {
  /** The editor transcript index before the question was sent. */
  readonly mark: number;
  /**
   * What `session.question` answered: the record holding the follow-up once
   * the stage has recorded it, or — when the follow-up itself settles first,
   * as a delta install that fails at once can — that settlement's own failure.
   * The route documents both answers; which one a fast failure produces is a
   * race the suite does not depend on.
   */
  readonly answered: Result<SessionRecord, DebuggenError>;
}

/**
 * Queues `answer` and asks `question` through `POST /sessions/:id/question`.
 *
 * @param attemptId The follow-up attempt to ask; omitted, the body carries
 *   none and the service mints one, which makes the ask a new follow-up.
 */
async function askFollowUp(
  session: LiveSession,
  question: string,
  answer: ScriptedDecision,
  attemptId?: string,
): Promise<AskedFollowUp> {
  enqueueDecision(answer);
  return sendFollowUp(session, question, attemptId);
}

/**
 * Asks `question` through `POST /sessions/:id/question` without queueing a
 * decision — for an ask the service must refuse before any model call.
 */
async function sendFollowUp(
  session: LiveSession,
  question: string,
  attemptId?: string,
): Promise<AskedFollowUp> {
  await harness.editor(session.project.root);
  const mark = session.editor.received.length;
  const answered = await harness.http().request('session.question', {
    params: { id: session.id },
    body: attemptId === undefined ? { question } : { question, attemptId },
  });
  return { mark, answered };
}

/**
 * Asks `question` through `POST /sessions/:id/question` with the decision left
 * to the real rules-based provider: the one call it claims is answered from the
 * structured context the service built, exactly as under
 * `DEBUGGEN_PROVIDER=deterministic`, and its request is kept in
 * {@link realDecisionRequests} for the assertions on what the decision read.
 */
async function askRealFollowUp(session: LiveSession, question: string): Promise<AskedFollowUp> {
  realDecisionsPending += 1;
  return sendFollowUp(session, question);
}

/**
 * Drops any claim {@link askRealFollowUp} made that no decision call consumed —
 * an ask the service refused before deciding — so a later suite's decision is
 * never diverted from the script. The tests assert the claim was consumed; the
 * suites that ask real follow-ups run this after every test so one failure
 * cannot cascade into the scripted suites after them.
 */
function releaseRealDecisionClaims(): void {
  realDecisionsPending = 0;
}

/** The session's stored `followups` rows, in the order they were first asked. */
function followUpRowsOf(sessionId: string): FollowUpRecord[] {
  return unwrap(harness.repos.sessions.listFollowUps(sessionId), 'sessions.listFollowUps');
}

/** The only follow-up of `followUps` carrying `attemptId`, failing when there is not exactly one. */
function attemptOf(followUps: readonly FollowUpRecord[], attemptId: string): FollowUpRecord {
  return only(
    followUps.filter((entry) => entry.attemptId === attemptId),
    `follow-up of attempt ${attemptId}`,
  );
}

/**
 * The orchestrator's record of an operation that ended well. It is written as
 * the operation releases the session, so counting it tells a settled operation
 * from one still finishing its last writes — which a following ask would meet
 * as a `pipeline-busy` refusal rather than the refusal under test.
 */
const OPERATION_COMPLETED_LOG = 'Pipeline operation completed.';

/** How many operations on `sessionId` have completed so far. */
function completedOperations(sessionId: string): number {
  return harness.logger
    .withMessage(OPERATION_COMPLETED_LOG)
    .filter((record) => record.fields['sessionId'] === sessionId).length;
}

/** Waits until more than `before` operations on `sessionId` have completed. */
function waitForCompletedOperation(sessionId: string, before: number): Promise<number> {
  return waitUntil(
    () => {
      const completed = completedOperations(sessionId);
      return completed > before ? completed : undefined;
    },
    'the follow-up operation has released the session',
    HARNESS_TIMEOUTS.pipeline,
  );
}

/**
 * Holds the answer of a follow-up whose delta install failed: either the
 * recorded follow-up, or exactly the failure `instrumentation.failed` carried —
 * never a success that hides it, and never a different error.
 */
function expectRecordedOrFailedAs(
  answered: Result<SessionRecord, DebuggenError>,
  question: string,
  failureCode: string,
): void {
  if (isErr(answered)) {
    expect(answered.error.code).toBe(failureCode);
  } else {
    expect(last(answered.value.followUps, 'follow-up').question).toBe(question);
  }
}

/** The SHA-256 of a project file's raw bytes. */
function digestOf(project: FixtureProjectCopy, file: string): Promise<string> {
  return sha256OfFile(inProject(project, file));
}

/** The digest the committed corpus holds for `file`, from the copy's pre-session snapshot. */
function pristineDigest(project: FixtureProjectCopy, file: string): string {
  const digest = project.snapshot.get(file);
  if (digest === undefined) {
    throw new Error(`The corpus has no file ${file}.`);
  }
  return digest;
}

/** The records of `records` for one file, in application order. */
function recordsFor(records: readonly ModificationRecord[], file: string): ModificationRecord[] {
  return records.filter((record) => record.file === file);
}

/** One record by id, failing when the journal no longer holds it. */
function recordById(records: readonly ModificationRecord[], id: string): ModificationRecord {
  const found = records.find((record) => record.id === id);
  if (found === undefined) {
    throw new Error(`The journal no longer holds ${id}.`);
  }
  return found;
}

/* -------------------------------------------------------------------------------------------------
 * The suite
 * ---------------------------------------------------------------------------------------------- */

/** The inspected tabs of the two sessions. */
const FIRST_TAB = 41;
const CONFLICT_TAB = 42;

beforeAll(async () => {
  scripted = createScriptedProvider(DECISION_SCRIPT);
  harness = await startHarness({
    provider: withDecisionGate(withRouteHandlerFirstPlan(scripted.provider)),
    now: serviceNow,
  });
});

afterAll(async () => {
  // `harness` is unset only when `startHarness` itself threw, which the hook reports.
  if (harness !== undefined) {
    await harness.assertNoLeaks();
  }
});

describe('the follow-up paths of one session', () => {
  /** The live session every test of this block continues. */
  let session: LiveSession;

  /** The first plan, analysis, panel and capture: the ladders' rung n. */
  let baseline: {
    readonly plan: InstrumentationPlan;
    readonly analysis: AnalysisResult;
    readonly panel: PanelSpec;
    readonly captureId: string;
    readonly records: readonly ModificationRecord[];
  };

  /** The patch-mode action of plan version n — the one file edit the first install made. */
  let installedPatch: InstrumentationAction;

  beforeAll(async () => {
    session = await openReadySession(
      harness.requireProject(),
      FIRST_TAB,
      'Why does the trail report take so long to appear after I pick a trail?',
    );
    const { captureId } = await captureAndGenerate(session, readTelemetryBatch(CROSS_TIER_BATCH));
    baseline = Object.freeze({
      plan: only(plansOf(session.id), 'plan version'),
      analysis: only(analysesOf(session.id), 'analysis'),
      panel: only(panelsOf(session.id), 'panel'),
      captureId,
      records: await modificationsOf(session.id),
    });
    installedPatch = only(
      baseline.plan.instrumentationTargets.filter((action) => action.mode === PATCH_MODE),
      'patch-mode action of the first plan',
    );
  });

  it('reaches `generated` through the real pipeline and records rung n of every ladder', async () => {
    const record = storedSession(session.id);
    expect(record.status).toBe(STATUS.generated);

    // Rung n of the plan ladder: the deterministic plan, installed once.
    expect(record.plans).toEqual([baseline.plan]);
    const firstRecord = only(baseline.records, 'modification of the first install');
    expect(firstRecord).toMatchObject({
      file: installedPatch.file,
      planVersion: baseline.plan.planVersion,
      status: MODIFICATION.applied,
      originalHash: pristineDigest(session.project, installedPatch.file),
    });
    expect(firstRecord.previousRecordId).toBeUndefined();
    expect(await digestOf(session.project, installedPatch.file)).toBe(firstRecord.instrumentedHash);

    // Rung n of the analysis and panel ladders, drawn from the first capture.
    expect(baseline.analysis.captureId).toBe(baseline.captureId);
    expect(baseline.analysis.supersedes).toBeUndefined();
    expect(baseline.panel.supersedes).toBeUndefined();
    expect(record.panelIds).toEqual([baseline.panel.id]);
    expect(record.analyses.map((analysis) => analysis.id)).toEqual([baseline.analysis.id]);
    expect(record.followUps).toEqual([]);
  });

  it('answers from the stored evidence: `generated → analyzing → generated`, rung n + 1 appended, nothing installed or captured', async () => {
    const question = 'Which step of that request accounts for most of its time?';
    const analysesBefore = analysesOf(session.id);
    const panelsBefore = panelsOf(session.id);
    const plansBefore = plansOf(session.id);
    const capturesBefore = unwrap(
      harness.repos.sessions.listCaptures(session.id),
      'sessions.listCaptures',
    );
    const recordsBefore = await modificationsOf(session.id);
    const treeBefore = await snapshotTree(session.project.root);

    const asked = await askFollowUp(session, question, {
      needsNewCapture: false,
      additionalActions: [],
    });
    const { mark } = asked;

    // The route answers with the record the question was recorded on.
    const answered = unwrap(asked.answered, 'session.question');
    expect(answered.id).toBe(session.id);
    expect(last(answered.followUps, 'follow-up').question).toBe(question);

    const done = await waitForStored(
      session.id,
      (record) =>
        record.status === STATUS.generated &&
        record.analyses.length === analysesBefore.length + 1 &&
        record.panelIds.length === panelsBefore.length + 1,
      'the follow-up regenerated the analysis and the panel',
    );
    await waitForPushedStatus(
      session,
      mark,
      STATUS.generated,
      (record) => record.panelIds.length === panelsBefore.length + 1,
    );
    expect(statusWalk(session.editor, session.id, mark, STATUS.generated)).toEqual([
      STATUS.generated,
      STATUS.analyzing,
      STATUS.generated,
    ]);

    // Nothing was captured and nothing was installed: no capture window, no new
    // or changed modification record, no plan version, no byte of the project.
    expect(
      unwrap(harness.repos.sessions.getActiveCapture(session.id), 'getActiveCapture'),
    ).toBeUndefined();
    expect(
      unwrap(harness.repos.sessions.listCaptures(session.id), 'sessions.listCaptures'),
    ).toEqual(capturesBefore);
    expect(await modificationsOf(session.id)).toEqual(recordsBefore);
    expect(plansOf(session.id)).toEqual(plansBefore);
    await assertTreeUnchanged(session.project.root, treeBefore);

    // The analysis ladder: rung n is still there, unmodified, and rung n + 1
    // supersedes it, drawn from the same stored capture.
    const analysesAfter = analysesOf(session.id);
    expect(analysesAfter.slice(0, -1)).toEqual(analysesBefore);
    const previousAnalysis = last(analysesBefore, 'analysis');
    const analysis = last(analysesAfter, 'analysis');
    expect(analysis.id).not.toBe(previousAnalysis.id);
    expect(analysis.analysisVersion).toBe(previousAnalysis.analysisVersion + 1);
    expect(analysis.supersedes).toBe(previousAnalysis.id);
    expect(analysis.captureId).toBe(previousAnalysis.captureId);
    expect(last(done.analyses, 'stored analysis')).toEqual(analysis);

    // The panel ladder, likewise: append-only, `supersedes` naming rung n.
    const panelsAfter = panelsOf(session.id);
    expect(panelsAfter.slice(0, -1)).toEqual(panelsBefore);
    const previousPanel = last(panelsBefore, 'panel');
    const panel = last(panelsAfter, 'panel');
    expect(panel.id).not.toBe(previousPanel.id);
    expect(panel.panelVersion).toBe(previousPanel.panelVersion + 1);
    expect(panel.supersedes).toBe(previousPanel.id);
    expect(done.panelIds).toEqual([...panelsBefore.map((spec) => spec.id), panel.id]);
    unwrap(validatePanelSpec(panel), 'validatePanelSpec');

    // `panel.generated` carries the new version, and — inside the specification —
    // the link to the version it replaces.
    const pushed = await waitFor(
      session.editor,
      'panel.generated',
      (message, index) => index >= mark && message.payload.panelId === panel.id,
    );
    expect(pushed.payload.sessionId).toBe(session.id);
    expect(pushed.payload.panel).toEqual(panel);
    expect(pushed.payload.panel.supersedes).toBe(previousPanel.id);
    unwrap(validatePanelSpec(pushed.payload.panel), 'validatePanelSpec(panel.generated)');

    // The follow-up is appended with the outcome it produced, and the follow-up
    // prompt version the stage actually rendered is the one recorded.
    const followUp = last(done.followUps, 'follow-up');
    expect(done.followUps).toHaveLength(1);
    expect(followUp).toMatchObject({
      question,
      needsNewCapture: false,
      captureId: previousAnalysis.captureId,
      analysisId: analysis.id,
      panelId: panel.id,
    });
    const decisionCall = last(
      scripted.calls.filter((call) => call.stage === FOLLOW_UP_STAGE),
      'follow-up model call',
    );
    expect(decisionCall.scripted).toBe(true);
    expect(done.promptVersions[FOLLOW_UP_STAGE]).toBe(decisionCall.promptVersion);
  });

  it('replays the latest analysis and panel on reopen and still serves the superseded panel', async () => {
    const latestAnalysis = last(analysesOf(session.id), 'analysis');
    const latestPanel = last(panelsOf(session.id), 'panel');
    const mark = session.editor.received.length;
    const http = harness.http();

    const reopened = unwrap(
      await http.request('session.get', { params: { id: session.id } }),
      'session.get',
    );
    expect(last(reopened.analyses, 'analysis')).toEqual(latestAnalysis);
    expect(last(reopened.panelIds, 'panel id')).toBe(latestPanel.id);

    const replayedAnalysis = await waitFor(
      session.editor,
      'analysis.completed',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(replayedAnalysis.payload.analysis).toEqual(latestAnalysis);
    const replayedPanel = await waitFor(
      session.editor,
      'panel.generated',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(replayedPanel.payload.panelId).toBe(latestPanel.id);
    expect(replayedPanel.payload.panel).toEqual(latestPanel);

    const current = unwrap(
      await http.request('panel.get', { params: { id: session.id } }),
      'panel.get',
    );
    expect(current.panel).toEqual(latestPanel);
    const superseded = unwrap(
      await http.request('panel.getById', {
        params: { id: session.id, panelId: baseline.panel.id },
      }),
      'panel.getById',
    );
    expect(superseded.panel).toEqual(baseline.panel);
  });

  it('refuses a removal, a replacement and a re-scope, then installs only the accepted addition: `generated → planning → instrumenting → ready`', async () => {
    const question = 'Is the time going into loading the trail report itself?';
    const previousPlan = last(plansOf(session.id), 'plan version');
    const recordsBefore = await modificationsOf(session.id);
    const installedRecord = only(recordsBefore, 'modification record');
    const installedFileDigest = await digestOf(session.project, installedPatch.file);
    const rationale = 'The follow-up needs this step measured rather than inferred.';
    const addition = authoringTarget(
      CORPUS.serviceFile,
      CORPUS.loadSymbol,
      ACTION_TYPE.functionTiming,
      rationale,
    );

    const asked = await askFollowUp(session, question, {
      needsNewCapture: true,
      additionalActions: [
        // A removal: the installed action's id moved onto another target.
        resolvedProposal(
          installedPatch,
          { file: CORPUS.poolFile, symbol: CORPUS.poolGateSymbol },
          rationale,
        ),
        // A replacement: the installed identity re-issued under another id.
        resolvedProposal(installedPatch, { id: newActionId() }, rationale),
        // A re-scope: the installed id kept on its target with another type.
        resolvedProposal(
          installedPatch,
          {
            type:
              installedPatch.type === ACTION_TYPE.serverSpan
                ? ACTION_TYPE.functionTiming
                : ACTION_TYPE.serverSpan,
          },
          rationale,
        ),
        // The one genuine addition.
        addition,
      ],
    });
    const { mark } = asked;
    const answered = unwrap(asked.answered, 'session.question');
    expect(last(answered.followUps, 'follow-up').question).toBe(question);

    const ready = await waitForStored(
      session.id,
      (record) => record.status === STATUS.ready && record.plans.length === 2,
      'plan version n + 1 is installed and the session is ready again',
    );
    await waitForPushedStatus(session, mark, STATUS.ready);
    expect(statusWalk(session.editor, session.id, mark, STATUS.generated)).toEqual([
      STATUS.generated,
      STATUS.planning,
      STATUS.instrumenting,
      STATUS.ready,
    ]);

    // Each refused proposal was refused for its own reason, and only the addition
    // was accepted — read from the stage's own decision record.
    const decided = last(harness.logger.withMessage(FOLLOW_UP_DECIDED_LOG), 'decision log record');
    expect(decided.fields).toMatchObject({
      path: memberOf(FOLLOW_UP_PATHS, 'new-capture'),
      needsNewCapture: true,
      proposed: 4,
      accepted: 1,
      rejected: {
        [memberOf(FOLLOW_UP_DELTA_REJECTION_REASONS, 'removal')]: 1,
        [memberOf(FOLLOW_UP_DELTA_REJECTION_REASONS, 'replacement')]: 1,
        [memberOf(FOLLOW_UP_DELTA_REJECTION_REASONS, 're-scope')]: 1,
      },
    });

    // Plan version n + 1 is the previous plan plus exactly the accepted addition:
    // every installed action is still there, verbatim and in place, and nothing a
    // refused proposal named reached the plan.
    const plans = plansOf(session.id);
    expect(plans[0]).toEqual(previousPlan);
    const plan = last(plans, 'plan version');
    expect(ready.plans).toEqual(plans);
    expect(plan.planVersion).toBe(previousPlan.planVersion + 1);
    const previousCount = previousPlan.instrumentationTargets.length;
    expect(plan.instrumentationTargets.slice(0, previousCount)).toEqual(
      previousPlan.instrumentationTargets,
    );
    const previousKeys = previousPlan.instrumentationTargets.map(actionIdentityKey);
    const keys = plan.instrumentationTargets.map(actionIdentityKey);
    expect(keys.slice(0, previousCount)).toEqual(previousKeys);
    expect(new Set(keys).size).toBe(keys.length);
    const delta = only(plan.instrumentationTargets.slice(previousCount), 'delta action');
    expect(actionIdentityKey(delta)).toBe(actionIdentityKey(addition));
    expect(delta.mode).toBe(PATCH_MODE);
    expect(previousPlan.instrumentationTargets.map((action) => action.id)).not.toContain(delta.id);
    expect(plan.instrumentationTargets.filter((action) => action.id === installedPatch.id)).toEqual(
      [installedPatch],
    );

    // The installer received only the delta: the earlier record and its file are
    // exactly as they were, and the one new record is the delta's.
    const records = await modificationsOf(session.id);
    expect(recordById(records, installedRecord.id)).toEqual(installedRecord);
    expect(await digestOf(session.project, installedPatch.file)).toBe(installedFileDigest);
    const added = records.filter((record) => record.id !== installedRecord.id);
    const deltaRecord = only(added, 'record of the delta install');
    expect(deltaRecord).toMatchObject({
      file: CORPUS.serviceFile,
      planVersion: plan.planVersion,
      status: MODIFICATION.applied,
      originalHash: pristineDigest(session.project, CORPUS.serviceFile),
    });
    expect(deltaRecord.previousRecordId).toBeUndefined();
    expect(await digestOf(session.project, CORPUS.serviceFile)).toBe(deltaRecord.instrumentedHash);
    expect(await digestOf(session.project, CORPUS.poolFile)).toBe(
      pristineDigest(session.project, CORPUS.poolFile),
    );

    // `instrumentation.ready` reports the delta install, not the whole plan again.
    const announced = await waitFor(
      session.editor,
      'instrumentation.ready',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(announced.payload.applied).toEqual([deltaRecord]);
    expect(announced.payload.unavailable).toEqual([]);
    expect(announced.payload.runtimeHooks.every((hook) => typeof hook === 'string')).toBe(true);

    // The developer is asked to reproduce again: the install closes with the same
    // "ready" row the first install ended with, and no capture has started.
    const readyRows = readyRowsSince(session, mark);
    expect(readyRows.map((row) => row.payload.message)).toContain(session.readyMessage);
    expect(
      unwrap(harness.repos.sessions.getActiveCapture(session.id), 'getActiveCapture'),
    ).toBeUndefined();
    expect(last(ready.followUps, 'follow-up')).toMatchObject({
      question,
      needsNewCapture: true,
      planVersion: plan.planVersion,
    });
  });

  it('drives the new capture through `analyzing → generated` as rung n + 2 of both ladders', async () => {
    const analysesBefore = analysesOf(session.id);
    const panelsBefore = panelsOf(session.id);
    const mark = session.editor.received.length;

    const { captureId, record } = await captureAndGenerate(
      session,
      reidentifyBatch(readTelemetryBatch(CROSS_TIER_BATCH), 1),
    );
    await waitForPushedStatus(
      session,
      mark,
      STATUS.generated,
      (pushed) => pushed.panelIds.length === panelsBefore.length + 1,
    );
    expect(statusWalk(session.editor, session.id, mark, STATUS.ready).slice(-2)).toEqual([
      STATUS.analyzing,
      STATUS.generated,
    ]);
    expect(captureId).not.toBe(baseline.captureId);

    const analysesAfter = analysesOf(session.id);
    expect(analysesAfter.slice(0, -1)).toEqual(analysesBefore);
    const analysis = last(analysesAfter, 'analysis');
    expect(analysis.analysisVersion).toBe(baseline.analysis.analysisVersion + 2);
    expect(analysis.supersedes).toBe(last(analysesBefore, 'analysis').id);
    expect(analysis.captureId).toBe(captureId);

    const panelsAfter = panelsOf(session.id);
    expect(panelsAfter.slice(0, -1)).toEqual(panelsBefore);
    const panel = last(panelsAfter, 'panel');
    expect(panel.panelVersion).toBe(baseline.panel.panelVersion + 2);
    expect(panel.supersedes).toBe(last(panelsBefore, 'panel').id);
    unwrap(validatePanelSpec(panel), 'validatePanelSpec');
    expect(record.panelIds).toEqual(panelsAfter.map((spec) => spec.id));

    // The whole ladder reads n → n + 1 → n + 2, each rung naming the one below.
    expect(analysesAfter.map((entry) => entry.supersedes)).toEqual([
      undefined,
      baseline.analysis.id,
      last(analysesBefore, 'analysis').id,
    ]);
    expect(panelsAfter.map((entry) => entry.supersedes)).toEqual([
      undefined,
      baseline.panel.id,
      last(panelsBefore, 'panel').id,
    ]);
  });

  it('undoes a delta that fails part-way at once and leaves the session at its previous plan version', async () => {
    const question = 'Does the lookup behind the report also read the trailhead gate?';
    const plansBefore = plansOf(session.id);
    const analysesBefore = analysesOf(session.id);
    const panelsBefore = panelsOf(session.id);
    const recordsBefore = await modificationsOf(session.id);
    const serviceHead = only(recordsFor(recordsBefore, CORPUS.serviceFile), 'service record');
    const routeDigest = await digestOf(session.project, installedPatch.file);

    // The injected failure: the second delta target (patched after the first, by
    // file order) must back its current bytes up under their digest, and a file
    // that does not hash to that name already sits there, so the backup store
    // refuses the write and the patcher stops with the first target applied.
    const currentDigest = await digestOf(session.project, CORPUS.serviceFile);
    expect(currentDigest).toBe(serviceHead.instrumentedHash);
    const planted = join(dirname(serviceHead.backupPath), currentDigest);
    expect(await exists(planted)).toBe(false);
    const plantedBytes = Buffer.from(
      'planted by the follow-up suite: these bytes do not hash to this name\n',
    );
    expect(sha256Hex(plantedBytes)).not.toBe(currentDigest);
    await writeFile(planted, plantedBytes, { mode: SECURE_FILE_MODE, flag: 'wx' });

    let asked: AskedFollowUp;
    let plantedAfter: Buffer;
    try {
      asked = await askFollowUp(session, question, {
        needsNewCapture: true,
        additionalActions: [
          authoringTarget(
            CORPUS.poolFile,
            CORPUS.poolQuerySymbol,
            ACTION_TYPE.functionTiming,
            'The query layer is where the report waits.',
          ),
          authoringTarget(
            CORPUS.serviceFile,
            CORPUS.summarizeSymbol,
            ACTION_TYPE.functionTiming,
            'Folding the reports may be where the time goes.',
          ),
        ],
      });
      await waitForStored(
        session.id,
        (record) => record.status === STATUS.failed,
        'the failed delta install files the session as failed',
      );
      plantedAfter = await readFile(planted);
    } finally {
      await rm(planted, { force: true });
    }
    const { mark } = asked;

    // The backup store kept the file it found rather than overwriting it.
    expect(plantedAfter).toEqual(plantedBytes);

    // The failure surfaces as `instrumentation.failed` with a hint — never as a
    // partially applied plan — and the question's answer, when it came after the
    // failure, is that same failure.
    const failed = await waitFor(
      session.editor,
      'instrumentation.failed',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(failed.payload.error.hint?.trim().length ?? 0).toBeGreaterThan(0);
    expectRecordedOrFailedAs(asked.answered, question, failed.payload.error.code);
    expect(
      session.editor.received
        .slice(mark)
        .some((message) => isMessageOfType(message, 'instrumentation.ready')),
    ).toBe(false);
    const failedRow = await waitFor(
      session.editor,
      'session.progress',
      (message, index) =>
        index >= mark &&
        message.payload.sessionId === session.id &&
        message.payload.status === PROGRESS_FAILED,
    );
    expect(failedRow.payload.message.length).toBeGreaterThan(0);

    // The plan ladder did not move: version n + 1 was never recorded.
    expect(plansOf(session.id)).toEqual(plansBefore);
    const previousVersion = last(plansBefore, 'plan version').planVersion;
    expect(unwrap(harness.repos.sessions.latestPlanVersion(session.id), 'latestPlanVersion')).toBe(
      previousVersion,
    );
    expect(
      unwrap(harness.repos.sessions.getPlan(session.id, previousVersion + 1), 'getPlan'),
    ).toBeUndefined();

    // The record the call applied was reverse-restored immediately; the earlier
    // versions' records are untouched and their files still carry their patches.
    const records = await modificationsOf(session.id);
    for (const earlier of recordsBefore) {
      expect(recordById(records, earlier.id)).toEqual(earlier);
    }
    const attempted = records.filter(
      (record) => !recordsBefore.some((earlier) => earlier.id === record.id),
    );
    const undone = only(attempted, 'record of the failed delta');
    expect(undone).toMatchObject({
      file: CORPUS.poolFile,
      planVersion: previousVersion + 1,
      status: MODIFICATION.reverted,
    });
    expect(await exists(undone.backupPath)).toBe(false);
    expect(await digestOf(session.project, CORPUS.poolFile)).toBe(
      pristineDigest(session.project, CORPUS.poolFile),
    );
    expect(await digestOf(session.project, CORPUS.serviceFile)).toBe(serviceHead.instrumentedHash);
    expect(await digestOf(session.project, installedPatch.file)).toBe(routeDigest);

    // No analysis or panel came of it, and the follow-up carries no outcome link.
    expect(analysesOf(session.id)).toEqual(analysesBefore);
    expect(panelsOf(session.id)).toEqual(panelsBefore);
    const record = storedSession(session.id);
    const followUp = last(record.followUps, 'follow-up');
    expect(followUp.question).toBe(question);
    expect(followUp.planVersion).toBeUndefined();
    expect(followUp.analysisId).toBeUndefined();
    expect(followUp.panelId).toBeUndefined();

    // `generated` is out of reach from here: the only edge into it leaves
    // `analyzing`, and only with a validated analysis and panel in hand.
    expect(record.status).toBe(STATUS.failed);
    expect(transition(record.status, STATUS.generated).ok).toBe(false);
    expect(transition(STATUS.analyzing, STATUS.generated).ok).toBe(false);
  });

  it('undoes a fully installed delta whose plan version cannot be stored and leaves the session at its previous plan version', async () => {
    const question = 'Does the condition-report query itself hold the report up?';
    const plansBefore = plansOf(session.id);
    const previousVersion = last(plansBefore, 'plan version').planVersion;
    const analysesBefore = analysesOf(session.id);
    const panelsBefore = panelsOf(session.id);
    const followUpsBefore = storedSession(session.id).followUps.length;
    const recordsBefore = await modificationsOf(session.id);
    const filesBefore = new Map<string, string>();
    for (const file of new Set(recordsBefore.map((record) => record.file))) {
      filesBefore.set(file, await digestOf(session.project, file));
    }
    // The target is a file no open record patches: the part-way delta's record on it was reverted,
    // so the install has nothing to layer over and completes on its own.
    expect(await digestOf(session.project, CORPUS.poolFile)).toBe(
      pristineDigest(session.project, CORPUS.poolFile),
    );
    expect(
      recordsFor(recordsBefore, CORPUS.poolFile).every(
        (record) => record.status === MODIFICATION.reverted,
      ),
    ).toBe(true);

    // The injected failure: plan persistence refuses at the database, not through a code seam. A
    // temporary trigger on the service's own connection aborts every insert into `plans`, so the
    // install succeeds and only recording plan version n + 1 fails.
    const trigger = 'followup_suite_refuses_plan_rows';
    harness.store.db.exec(
      `CREATE TEMP TRIGGER ${trigger} BEFORE INSERT ON plans BEGIN SELECT RAISE(ABORT, 'plan rows are refused by the follow-up suite'); END`,
    );
    const devtoolsMark = session.devtools.received.length;
    let asked: AskedFollowUp;
    try {
      asked = await askFollowUp(session, question, {
        needsNewCapture: true,
        additionalActions: [
          authoringTarget(
            CORPUS.poolFile,
            CORPUS.poolQuerySymbol,
            ACTION_TYPE.functionTiming,
            'The query layer is where the report waits.',
          ),
        ],
      });
      const from = asked.mark;
      // The session was already `failed`, so the walk — not the status alone — shows this run ended.
      await waitUntil(
        () => {
          const walk = statusWalk(session.editor, session.id, from, STATUS.failed);
          return walk.length === 4 ? walk : undefined;
        },
        'the unrecorded plan version files the session as failed again',
        HARNESS_TIMEOUTS.pipeline,
      );
    } finally {
      harness.store.db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    const { mark } = asked;
    expect(statusWalk(session.editor, session.id, mark, STATUS.failed)).toEqual([
      STATUS.failed,
      STATUS.planning,
      STATUS.instrumenting,
      STATUS.failed,
    ]);
    expectRecordedOrFailedAs(asked.answered, question, 'STORE_ERROR');

    // The install itself completed: it announced the record it applied before the plan failed.
    const records = await modificationsOf(session.id);
    const attempted = records.filter(
      (record) => !recordsBefore.some((earlier) => earlier.id === record.id),
    );
    const undone = only(attempted, 'record of the unrecorded delta');
    const announced = await waitFor(
      session.editor,
      'instrumentation.ready',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(announced.payload.applied.map((record) => record.id)).toEqual([undone.id]);

    // The plan ladder did not move: version n + 1 was never stored.
    expect(plansOf(session.id)).toEqual(plansBefore);
    expect(unwrap(harness.repos.sessions.latestPlanVersion(session.id), 'latestPlanVersion')).toBe(
      previousVersion,
    );
    expect(
      unwrap(harness.repos.sessions.getPlan(session.id, previousVersion + 1), 'getPlan'),
    ).toBeUndefined();

    // The stage reverse-restored the delta: its record is reverted, its file is pristine again and
    // its backup is gone; every earlier record and the file it patched are exactly as they were.
    expect(undone).toMatchObject({
      file: CORPUS.poolFile,
      planVersion: previousVersion + 1,
      status: MODIFICATION.reverted,
      originalHash: pristineDigest(session.project, CORPUS.poolFile),
    });
    expect(await digestOf(session.project, CORPUS.poolFile)).toBe(
      pristineDigest(session.project, CORPUS.poolFile),
    );
    expect(await exists(undone.backupPath)).toBe(false);
    for (const earlier of recordsBefore) {
      expect(recordById(records, earlier.id)).toEqual(earlier);
    }
    for (const [file, digest] of filesBefore) {
      expect(await digestOf(session.project, file)).toBe(digest);
    }
    const rolledBack = last(harness.logger.withMessage(DELTA_ROLLED_BACK_LOG), 'rollback record');
    expect(rolledBack.fields).toMatchObject({
      planVersion: previousVersion + 1,
      previousPlanVersion: previousVersion,
      trigger: 'plan-unrecorded',
      attempted: 1,
      restored: 1,
      journal: 'listed',
      arming: 'restored',
      mirrored: true,
    });

    // The clients were told the record was applied; the compensation's mirror tells both of them
    // it is reverted, and the stored record says so too.
    await waitForRevertedMirror(session.editor, session.id, mark, undone.id);
    await waitForRevertedMirror(session.devtools, session.id, devtoolsMark, undone.id);

    // No analysis or panel came of it, and the follow-up carries no outcome link.
    expect(analysesOf(session.id)).toEqual(analysesBefore);
    expect(panelsOf(session.id)).toEqual(panelsBefore);
    const record = storedSession(session.id);
    expect(record.status).toBe(STATUS.failed);
    expect(recordById(record.modifications, undone.id).status).toBe(MODIFICATION.reverted);
    expect(record.followUps).toHaveLength(followUpsBefore + 1);
    const followUp = last(record.followUps, 'follow-up');
    expect(followUp.question).toBe(question);
    expect(followUp.planVersion).toBeUndefined();
    expect(followUp.analysisId).toBeUndefined();
    expect(followUp.panelId).toBeUndefined();

    // The failure is filed under the plan stage and says what the project holds now: its first
    // line is the public copy of its code — a failed row never shows a failure's own words — and
    // its detail, the failure's product-authored hint, states what the compensation left.
    const failedRow = await waitFor(
      session.editor,
      'session.progress',
      (message, index) =>
        index >= mark &&
        message.payload.sessionId === session.id &&
        message.payload.stage === PLAN_STAGE &&
        message.payload.status === PROGRESS_FAILED,
    );
    expect(failedRow.payload.message).toBe(publicFailureCopy(PLAN_STAGE, 'STORE_ERROR').message);
    expect(failedRow.payload.detail).toContain(
      `so the project holds exactly what plan version ${String(previousVersion)} installed`,
    );
  });

  it('rolls a stored plan row back with the session record that could not account for it, and undoes the delta', async () => {
    const question = 'Is the condition-report query still the slow step after the retry?';
    const plansBefore = plansOf(session.id);
    const previousVersion = last(plansBefore, 'plan version').planVersion;
    const recordBefore = storedSession(session.id);
    const followUpsBefore = recordBefore.followUps.length;
    const recordsBefore = await modificationsOf(session.id);
    const filesBefore = new Map<string, string>();
    for (const file of new Set(recordsBefore.map((record) => record.file))) {
      filesBefore.set(file, await digestOf(session.project, file));
    }
    // As before, the target carries no open record, so the install completes on its own.
    expect(await digestOf(session.project, CORPUS.poolFile)).toBe(
      pristineDigest(session.project, CORPUS.poolFile),
    );
    expect(recordBefore.plans).toEqual(plansBefore);

    // The injected failure: the plan row is inserted, and then the session-record update that
    // mirrors it — in the same transaction — is aborted. The trigger sees the inserted row (same
    // transaction) and refuses only while the session holds more plan rows than it did, so every
    // session update after the rollback passes.
    const trigger = 'followup_suite_refuses_record_mirror';
    harness.store.db.exec(
      `CREATE TEMP TRIGGER ${trigger} BEFORE UPDATE ON sessions WHEN (SELECT COUNT(*) FROM plans WHERE session_id = NEW.id) > ${String(plansBefore.length)} BEGIN SELECT RAISE(ABORT, 'the session record may not account for a new plan in the follow-up suite'); END`,
    );
    const devtoolsMark = session.devtools.received.length;
    let asked: AskedFollowUp;
    try {
      asked = await askFollowUp(session, question, {
        needsNewCapture: true,
        additionalActions: [
          authoringTarget(
            CORPUS.poolFile,
            CORPUS.poolQuerySymbol,
            ACTION_TYPE.functionTiming,
            'The query layer is where the report waits.',
          ),
        ],
      });
      const from = asked.mark;
      await waitUntil(
        () => {
          const walk = statusWalk(session.editor, session.id, from, STATUS.failed);
          return walk.length === 4 ? walk : undefined;
        },
        'the rolled-back plan version files the session as failed again',
        HARNESS_TIMEOUTS.pipeline,
      );
    } finally {
      harness.store.db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    const { mark } = asked;
    expect(statusWalk(session.editor, session.id, mark, STATUS.failed)).toEqual([
      STATUS.failed,
      STATUS.planning,
      STATUS.instrumenting,
      STATUS.failed,
    ]);
    expectRecordedOrFailedAs(asked.answered, question, 'STORE_ERROR');

    // Atomic: the plan row went back with the record update, so the table and the record agree.
    expect(plansOf(session.id)).toEqual(plansBefore);
    expect(unwrap(harness.repos.sessions.latestPlanVersion(session.id), 'latestPlanVersion')).toBe(
      previousVersion,
    );
    expect(
      unwrap(harness.repos.sessions.getPlan(session.id, previousVersion + 1), 'getPlan'),
    ).toBeUndefined();
    const record = storedSession(session.id);
    expect(record.plans).toEqual(plansBefore);
    const pairRolledBack = last(
      harness.logger.withMessage(
        'a plan and the session record mirroring it were rolled back together; neither was stored',
      ),
      'plan-and-record rollback record',
    );
    expect(pairRolledBack.fields).toMatchObject({
      operation: 'insertPlanWithRecord',
      step: 'update',
      planVersion: previousVersion + 1,
      code: 'STORE_ERROR',
    });

    // The install completed and announced its record; the stage then reverse-restored it.
    const records = await modificationsOf(session.id);
    const undone = only(
      records.filter((entry) => !recordsBefore.some((earlier) => earlier.id === entry.id)),
      'record of the delta whose plan row was rolled back',
    );
    const announced = await waitFor(
      session.editor,
      'instrumentation.ready',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(announced.payload.applied.map((entry) => entry.id)).toEqual([undone.id]);
    expect(undone).toMatchObject({
      file: CORPUS.poolFile,
      planVersion: previousVersion + 1,
      status: MODIFICATION.reverted,
      originalHash: pristineDigest(session.project, CORPUS.poolFile),
    });
    expect(await digestOf(session.project, CORPUS.poolFile)).toBe(
      pristineDigest(session.project, CORPUS.poolFile),
    );
    expect(await exists(undone.backupPath)).toBe(false);
    for (const earlier of recordsBefore) {
      expect(recordById(records, earlier.id)).toEqual(earlier);
    }
    for (const [file, digest] of filesBefore) {
      expect(await digestOf(session.project, file)).toBe(digest);
    }
    const rolledBack = last(harness.logger.withMessage(DELTA_ROLLED_BACK_LOG), 'rollback record');
    expect(rolledBack.fields).toMatchObject({
      planVersion: previousVersion + 1,
      previousPlanVersion: previousVersion,
      trigger: 'plan-unrecorded',
      attempted: 1,
      restored: 1,
      journal: 'listed',
      arming: 'restored',
      mirrored: true,
    });

    // Both clients hear that the announced record is reverted, and the stored record lists it so —
    // written after the rollback, like the `failed` status that followed it.
    await waitForRevertedMirror(session.editor, session.id, mark, undone.id);
    await waitForRevertedMirror(session.devtools, session.id, devtoolsMark, undone.id);
    expect(record.status).toBe(STATUS.failed);
    expect(recordById(record.modifications, undone.id).status).toBe(MODIFICATION.reverted);
    expect(record.followUps).toHaveLength(followUpsBefore + 1);
    const followUp = last(record.followUps, 'follow-up');
    expect(followUp.question).toBe(question);
    expect(followUp.planVersion).toBeUndefined();

    // Filed under the plan stage, saying what the project holds now — in the row's detail, under
    // the public copy of the failure's code.
    const failedRow = await waitFor(
      session.editor,
      'session.progress',
      (message, index) =>
        index >= mark &&
        message.payload.sessionId === session.id &&
        message.payload.stage === PLAN_STAGE &&
        message.payload.status === PROGRESS_FAILED,
    );
    expect(failedRow.payload.message).toBe(publicFailureCopy(PLAN_STAGE, 'STORE_ERROR').message);
    expect(failedRow.payload.detail).toContain(
      `so the project holds exactly what plan version ${String(previousVersion)} installed`,
    );
  });

  it('layers the next plan version over an already instrumented file as a verified `previousRecordId` chain', async () => {
    const question = 'How long does folding the reports into a summary take?';
    const plansBefore = plansOf(session.id);
    const previousPlan = last(plansBefore, 'plan version');
    const recordsBefore = await modificationsOf(session.id);
    const parent = only(
      recordsFor(recordsBefore, CORPUS.serviceFile),
      'record of the first service patch',
    );
    const addition = authoringTarget(
      CORPUS.serviceFile,
      CORPUS.summarizeSymbol,
      ACTION_TYPE.functionTiming,
      'Folding the reports may be where the time goes.',
    );

    const asked = await askFollowUp(session, question, {
      needsNewCapture: true,
      additionalActions: [addition],
    });
    const { mark } = asked;
    expect(last(unwrap(asked.answered, 'session.question').followUps, 'follow-up').question).toBe(
      question,
    );
    const ready = await waitForStored(
      session.id,
      (record) => record.status === STATUS.ready && record.plans.length === plansBefore.length + 1,
      'the chained delta is installed',
    );
    await waitForPushedStatus(session, mark, STATUS.ready);
    expect(statusWalk(session.editor, session.id, mark, STATUS.failed)).toEqual([
      STATUS.failed,
      STATUS.planning,
      STATUS.instrumenting,
      STATUS.ready,
    ]);

    // The failed attempt consumed no version: this is n + 1 on top of n.
    const plan = last(plansOf(session.id), 'plan version');
    expect(plan.planVersion).toBe(previousPlan.planVersion + 1);
    expect(plan.instrumentationTargets.slice(0, -1)).toEqual(previousPlan.instrumentationTargets);
    expect(actionIdentityKey(last(plan.instrumentationTargets, 'action'))).toBe(
      actionIdentityKey(addition),
    );
    expect(ready.plans).toEqual(plansOf(session.id));

    // The chain: the new record replaced the bytes the earlier patch wrote, so its
    // originalHash is that record's instrumentedHash and it links back to it.
    const records = await modificationsOf(session.id);
    for (const earlier of recordsBefore) {
      expect(recordById(records, earlier.id)).toEqual(earlier);
    }
    const child = only(
      records.filter((record) => !recordsBefore.some((earlier) => earlier.id === record.id)),
      'record of the chained delta',
    );
    expect(child).toMatchObject({
      file: CORPUS.serviceFile,
      planVersion: plan.planVersion,
      status: MODIFICATION.applied,
      originalHash: parent.instrumentedHash,
      previousRecordId: parent.id,
    });
    expect(recordById(records, parent.id).status).toBe(MODIFICATION.applied);
    expect(child.instrumentedHash).not.toBe(parent.instrumentedHash);
    expect(await digestOf(session.project, CORPUS.serviceFile)).toBe(child.instrumentedHash);

    // The child's backup holds the bytes the parent patch wrote — exactly what a
    // reverse restore must put back before the parent's own backup is written.
    expect(await sha256OfFile(child.backupPath)).toBe(parent.instrumentedHash);
    expect(await sha256OfFile(parent.backupPath)).toBe(parent.originalHash);
    expect(parent.originalHash).toBe(pristineDigest(session.project, CORPUS.serviceFile));

    // The journal reads the chain oldest → newest, so a caller iterates it in
    // strict reverse; the head is the child.
    const chain = unwrap(await harness.repos.modifications.listChain(child.id), 'listChain');
    expect(chain.map((record) => record.id)).toEqual([parent.id, child.id]);
    const head = unwrap(
      await harness.repos.modifications.latestRecordForFile(session.id, CORPUS.serviceFile),
      'latestRecordForFile',
    );
    expect(head?.id).toBe(child.id);

    const announced = await waitFor(
      session.editor,
      'instrumentation.ready',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(announced.payload.applied).toEqual([child]);
  });

  it('restores the chain in strict reverse order on session end and leaves the copy byte-identical', async () => {
    const recordsBefore = await modificationsOf(session.id);
    const [parent, child] = recordsFor(recordsBefore, CORPUS.serviceFile).filter(
      (record) => record.status === MODIFICATION.applied,
    );
    if (parent === undefined || child === undefined) {
      throw new Error('The service file must carry a two-record chain before the session ends.');
    }
    expect(child.previousRecordId).toBe(parent.id);
    const mark = session.editor.received.length;

    const ended = unwrap(await harness.endSession(session.id), 'session.end');
    expect(ended.cleanup).toBe(CLEANUP.clean);

    // Every record is reverted, and the chain was unwound newest first: each
    // revert is stamped with its own clock reading, and the child's comes first.
    const records = await modificationsOf(session.id);
    expect(records.map((record) => record.status)).toEqual(
      records.map(() => MODIFICATION.reverted),
    );
    const revertedParent = recordById(records, parent.id);
    const revertedChild = recordById(records, child.id);
    expect(revertedChild.appliedAt).toBeLessThan(revertedParent.appliedAt);
    expect(revertedChild.appliedAt).toBeGreaterThan(child.appliedAt);

    // Byte-for-byte: the copy is the committed corpus again.
    await assertTreeUnchanged(session.project.root, session.project.snapshot);

    // Backups are deleted only once their restores verified — and all of them did.
    for (const record of records) {
      expect(await exists(record.backupPath)).toBe(false);
    }

    const record = storedSession(session.id);
    expect(record.status).toBe(STATUS.ended);
    expect(record.cleanup.status).toBe(CLEANUP.clean);
    expect(record.cleanup.conflicts).toEqual([]);
    const completed = await waitFor(
      session.editor,
      'cleanup.completed',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(completed.payload.status).toBe(CLEANUP.clean);
    expect(completed.payload.conflicts).toEqual([]);
  });
});

describe('an edit made between two installs of one file', () => {
  /** A second session, on a second copy of the corpus, so its conflict stays its own. */
  let session: LiveSession;

  /** The first install's record for the service file, which the developer's edit invalidates. */
  let firstRecord: ModificationRecord;

  /** The bytes the developer saved over the instrumented file. */
  let developerBytes: Buffer;

  /** The follow-up attempt that failed and was retried in place, once it has been. */
  let retriedAttempt: { readonly attemptId: string; readonly question: string } | undefined;

  /** The attempt {@link retriedAttempt} named, or a failure naming the test that should have set it. */
  function requireRetriedAttempt(): { readonly attemptId: string; readonly question: string } {
    if (retriedAttempt === undefined) {
      throw new Error(
        'The retried follow-up attempt was not recorded by the test before this one.',
      );
    }
    return retriedAttempt;
  }

  beforeAll(async () => {
    const project = await harness.copyFixtureProject();
    session = await openReadySession(
      project,
      CONFLICT_TAB,
      'Why is the trail report slow to load on the conditions board?',
    );
    await captureAndGenerate(session, reidentifyBatch(readTelemetryBatch(CROSS_TIER_BATCH), 2));
  });

  it('installs a first delta on the service file and captures again', async () => {
    const asked = await askFollowUp(session, 'Is loading the trail report the slow part?', {
      needsNewCapture: true,
      additionalActions: [
        authoringTarget(
          CORPUS.serviceFile,
          CORPUS.loadSymbol,
          ACTION_TYPE.functionTiming,
          'The follow-up needs the report load measured.',
        ),
      ],
    });
    const { mark } = asked;
    unwrap(asked.answered, 'session.question');
    await waitForStored(
      session.id,
      (record) => record.status === STATUS.ready && record.plans.length === 2,
      'the first delta is installed',
    );
    await waitForPushedStatus(session, mark, STATUS.ready);
    firstRecord = only(
      recordsFor(await modificationsOf(session.id), CORPUS.serviceFile),
      'record of the first service patch',
    );
    expect(firstRecord.status).toBe(MODIFICATION.applied);
    expect(await digestOf(session.project, CORPUS.serviceFile)).toBe(firstRecord.instrumentedHash);

    await captureAndGenerate(session, reidentifyBatch(readTelemetryBatch(CROSS_TIER_BATCH), 3));
  });

  it('retries a failed follow-up in place by its attempt id: one ladder entry, one stored row, answered once recorded under the same `askedAt`', async () => {
    const attemptId = newId(FOLLOW_UP_ATTEMPT_ID_PREFIX);
    const question = 'Does the conditions board wait for every trail report before it renders?';
    const before = storedSession(session.id);
    expect(before.status).toBe(STATUS.generated);
    const rowsBefore = followUpRowsOf(session.id);
    const analysesBefore = analysesOf(session.id);
    const panelsBefore = panelsOf(session.id);
    const plansBefore = plansOf(session.id);
    const recordsBefore = await modificationsOf(session.id);
    const treeBefore = await snapshotTree(session.project.root);
    const completedBefore = completedOperations(session.id);
    const recordedLogsBefore = harness.logger.withMessage(RECORDED_FOLLOW_UP_LOG).length;

    // From the first ask until the retry is recorded, every read of the service
    // clock answers one millisecond: both asks of the attempt carry the same
    // `askedAt`, and the retry keeps the ladder's length, so only the attempt's
    // identity can tell the route that the retry was recorded.
    let first: FollowUpRecord;
    let retriedMark: number;
    let release: (() => void) | undefined;
    freezeServiceClock();
    try {
      // Attempt 1 is recorded, then its decision call fails at the transport.
      const failedAsk = await askFollowUp(session, question, decisionUnavailable(), attemptId);
      const failed = await waitForStored(
        session.id,
        (record) => record.status === STATUS.failed,
        'the follow-up decision failed and the session is filed as failed',
      );
      const failedRow = await waitFor(
        session.editor,
        'session.progress',
        (message, index) =>
          index >= failedAsk.mark &&
          message.payload.sessionId === session.id &&
          message.payload.stage === FOLLOW_UP_STAGE &&
          message.payload.status === PROGRESS_FAILED,
      );
      expect(failedRow.payload.message.length).toBeGreaterThan(0);
      // The route answered with the recorded attempt, or — when the failure
      // settled first — with that failure itself.
      if (isErr(failedAsk.answered)) {
        expect(failedAsk.answered.error.code).toBe('MODEL_UNAVAILABLE');
      } else {
        expect(attemptOf(failedAsk.answered.value.followUps, attemptId).attempt).toBe(1);
      }
      first = attemptOf(failed.followUps, attemptId);
      expect(first).toMatchObject({ question, attemptId, attempt: 1 });
      expect(isFollowUpAnswered(first)).toBe(false);
      expect(failed.followUps).toEqual([...before.followUps, first]);
      expect(followUpRowsOf(session.id)).toEqual([...rowsBefore, first]);

      // The retry: the same attempt id, with its decision held so the follow-up
      // cannot settle before the route answers.
      release = holdNextDecision();
      const retried = await askFollowUp(
        session,
        question,
        { needsNewCapture: false, additionalActions: [] },
        attemptId,
      );
      retriedMark = retried.mark;
      const recorded = unwrap(retried.answered, 'session.question (retry)');
      const second = attemptOf(recorded.followUps, attemptId);
      expect(second).toEqual({ question, askedAt: first.askedAt, attemptId, attempt: 2 });
      expect(recorded.followUps).toEqual([...before.followUps, second]);
      // One row for the attempt, rewritten in place — never a second one.
      expect(followUpRowsOf(session.id)).toEqual([...rowsBefore, second]);
      const recordedLogs = harness.logger.withMessage(RECORDED_FOLLOW_UP_LOG);
      expect(recordedLogs.length).toBeGreaterThan(recordedLogsBefore);
      expect(last(recordedLogs, 'recorded follow-up log').fields).toMatchObject({ retried: true });
    } finally {
      thawServiceClock();
      release?.();
    }

    // Released, the retried attempt answers from the stored evidence:
    // `failed → analyzing → generated`, rung n + 1 of the analysis and panel ladders.
    const done = await waitForStored(
      session.id,
      (record) =>
        record.status === STATUS.generated &&
        record.analyses.length === analysesBefore.length + 1 &&
        record.panelIds.length === panelsBefore.length + 1 &&
        isFollowUpAnswered(attemptOf(record.followUps, attemptId)),
      'the retried follow-up regenerated the analysis and the panel',
    );
    await waitForPushedStatus(
      session,
      retriedMark,
      STATUS.generated,
      (record) => record.panelIds.length === panelsBefore.length + 1,
    );
    expect(statusWalk(session.editor, session.id, retriedMark, STATUS.failed)).toEqual([
      STATUS.failed,
      STATUS.analyzing,
      STATUS.generated,
    ]);
    await waitForCompletedOperation(session.id, completedBefore);

    // Still one entry for the attempt, now carrying the outcome it produced.
    const answered = attemptOf(done.followUps, attemptId);
    expect(done.followUps).toHaveLength(before.followUps.length + 1);
    expect(done.followUps.slice(0, -1)).toEqual(before.followUps);
    expect(answered).toMatchObject({
      question,
      askedAt: first.askedAt,
      attemptId,
      attempt: 2,
      needsNewCapture: false,
      analysisId: last(done.analyses, 'analysis').id,
      panelId: last(done.panelIds, 'panel id'),
    });
    expect(followUpRowsOf(session.id)).toHaveLength(rowsBefore.length + 1);
    expect(attemptOf(followUpRowsOf(session.id), attemptId).attempt).toBe(2);

    // Nothing was installed or captured, and no byte of the project moved.
    expect(plansOf(session.id)).toEqual(plansBefore);
    expect(await modificationsOf(session.id)).toEqual(recordsBefore);
    await assertTreeUnchanged(session.project.root, treeBefore);
    retriedAttempt = Object.freeze({ attemptId, question });
  });

  it('refuses to ask an answered attempt again, before any model call or write', async () => {
    const { attemptId, question } = requireRetriedAttempt();
    const before = storedSession(session.id);
    const rowsBefore = followUpRowsOf(session.id);
    const decisionCalls = scripted.calls.filter((call) => call.stage === FOLLOW_UP_STAGE).length;

    const refused = await sendFollowUp(session, question, attemptId);
    if (!isErr(refused.answered)) {
      throw new Error('Asking an answered follow-up attempt again was accepted.');
    }
    expect(refused.answered.error.code).toBe('SESSION_INVALID_STATE');
    expect(refused.answered.error.message).toMatch(/already answered/u);

    // The idempotent duplicate ran nothing: no model call, no follow-up entry
    // or row, no status change.
    expect(scripted.calls.filter((call) => call.stage === FOLLOW_UP_STAGE)).toHaveLength(
      decisionCalls,
    );
    expect(storedSession(session.id)).toEqual(before);
    expect(followUpRowsOf(session.id)).toEqual(rowsBefore);
  });

  it('appends a question sent under a new attempt id as its own follow-up', async () => {
    const retried = requireRetriedAttempt();
    const attemptId = newId(FOLLOW_UP_ATTEMPT_ID_PREFIX);
    expect(attemptId).not.toBe(retried.attemptId);
    const question = 'Which of those trail reports took the longest to load?';
    const before = storedSession(session.id);
    const rowsBefore = followUpRowsOf(session.id);
    const analysesBefore = analysesOf(session.id);
    const completedBefore = completedOperations(session.id);

    const asked = await askFollowUp(
      session,
      question,
      { needsNewCapture: false, additionalActions: [] },
      attemptId,
    );
    const recorded = unwrap(asked.answered, 'session.question (new attempt)');
    expect(attemptOf(recorded.followUps, attemptId)).toMatchObject({
      question,
      attemptId,
      attempt: 1,
    });

    const done = await waitForStored(
      session.id,
      (record) =>
        record.status === STATUS.generated &&
        record.analyses.length === analysesBefore.length + 1 &&
        isFollowUpAnswered(attemptOf(record.followUps, attemptId)),
      'the new follow-up regenerated the analysis',
    );
    await waitForCompletedOperation(session.id, completedBefore);

    // Appended after the retried attempt, which it left exactly as it was.
    expect(done.followUps).toHaveLength(before.followUps.length + 1);
    expect(done.followUps.slice(0, -1)).toEqual(before.followUps);
    expect(last(done.followUps, 'follow-up').attemptId).toBe(attemptId);
    expect(attemptOf(done.followUps, retried.attemptId)).toEqual(
      attemptOf(before.followUps, retried.attemptId),
    );
    const rows = followUpRowsOf(session.id);
    expect(rows).toHaveLength(rowsBefore.length + 1);
    expect(rows.slice(0, -1)).toEqual(rowsBefore);
    expect(attemptOf(rows, attemptId).attempt).toBe(1);
  });

  it('turns the edit into a conflict and refuses to layer the second install over it', async () => {
    const servicePath = inProject(session.project, CORPUS.serviceFile);
    developerBytes = Buffer.concat([
      await readFile(servicePath),
      Buffer.from('\n// Saved by hand while the debugging session was still running.\n'),
    ]);
    await writeFile(servicePath, developerBytes);

    // The watcher sees the file no longer hashes to what the patch wrote.
    await waitUntil(
      async () => {
        const current = unwrap(await harness.repos.modifications.get(firstRecord.id), 'get');
        return current?.status === MODIFICATION.conflict ? current : undefined;
      },
      'the edited file is reported as a conflict',
      HARNESS_TIMEOUTS.capture,
    );

    const plansBefore = plansOf(session.id);
    const question = 'How long does summarising the reports take?';
    const asked = await askFollowUp(session, question, {
      needsNewCapture: true,
      additionalActions: [
        authoringTarget(
          CORPUS.serviceFile,
          CORPUS.summarizeSymbol,
          ACTION_TYPE.functionTiming,
          'Folding the reports may be where the time goes.',
        ),
      ],
    });
    const { mark } = asked;
    await waitForStored(
      session.id,
      (record) => record.status === STATUS.failed,
      'the second install is refused',
    );
    const failed = await waitFor(
      session.editor,
      'instrumentation.failed',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(failed.payload.error.hint?.trim().length ?? 0).toBeGreaterThan(0);
    expectRecordedOrFailedAs(asked.answered, question, failed.payload.error.code);
    expect(last(storedSession(session.id).followUps, 'follow-up').question).toBe(question);

    // The chain halts at the conflict: nothing was layered over the edit, the
    // plan ladder did not move, and the developer's bytes are on disk untouched.
    const layered = recordsFor(await modificationsOf(session.id), CORPUS.serviceFile).filter(
      (record) => record.id !== firstRecord.id && record.status !== MODIFICATION.reverted,
    );
    expect(layered).toEqual([]);
    expect(plansOf(session.id)).toEqual(plansBefore);
    expect(await readFile(servicePath)).toEqual(developerBytes);
  });

  it("keeps the developer's bytes and the original through cleanup, reporting the conflict", async () => {
    const servicePath = inProject(session.project, CORPUS.serviceFile);
    const ended = unwrap(await harness.endSession(session.id), 'session.end');
    expect(ended.cleanup).toBe(CLEANUP.conflict);

    // Only the edited file differs from the corpus, and it holds exactly what the
    // developer saved; every other patched file was restored.
    expect(await readFile(servicePath)).toEqual(developerBytes);
    const difference = diffTreeSnapshots(
      session.project.snapshot,
      await snapshotTree(session.project.root),
    );
    expect(difference).toEqual({ added: [], removed: [], changed: [CORPUS.serviceFile] });

    // The conflicting record keeps its backup, and the backup is the original.
    const records = await modificationsOf(session.id);
    const conflicted = recordById(records, firstRecord.id);
    expect(conflicted.status).toBe(MODIFICATION.conflict);
    expect(await sha256OfFile(conflicted.backupPath)).toBe(
      pristineDigest(session.project, CORPUS.serviceFile),
    );
    for (const record of records.filter((entry) => entry.file !== CORPUS.serviceFile)) {
      expect(record.status).toBe(MODIFICATION.reverted);
    }

    const stored = storedSession(session.id);
    expect(stored.status).toBe(STATUS.ended);
    expect(stored.cleanup.status).toBe(CLEANUP.conflict);
    expect(stored.cleanup.conflicts.map((conflict) => conflict.file)).toContain(CORPUS.serviceFile);
  });
});

describe('a follow-up whose panel predecessor moved', () => {
  /** The inspected tab of this block's session, distinct from every other block's tab. */
  const PREDECESSOR_TAB = 43;

  /** The progress stage the stale-predecessor refusal is filed under. */
  const GENERATE_PANEL_STAGE = memberOf(PROGRESS_STAGES, 'generate-panel');

  /** The follow-up stage's record of a failed run: its fields carry the stage, code and reason. */
  const FOLLOW_UP_FAILED_LOG = 'Follow-up stage failed.';

  /** A third session, on its own copy of the corpus, whose panel another writer supersedes. */
  let session: LiveSession;

  /** The capture the session's panel was generated from. */
  let captureId: string;

  beforeAll(async () => {
    const project = await harness.copyFixtureProject();
    session = await openReadySession(
      project,
      PREDECESSOR_TAB,
      'Why does the trail report wait so long before it shows the conditions?',
    );
    ({ captureId } = await captureAndGenerate(
      session,
      reidentifyBatch(readTelemetryBatch(CROSS_TIER_BATCH), 4),
    ));
  });

  it('stores and pushes no panel, regenerates nothing and stays unanswered when another panel supersedes the one it was decided against', async () => {
    const question = 'Which part of loading the trail report is the slowest?';
    const before = storedSession(session.id);
    expect(before.status).toBe(STATUS.generated);
    const baseline = only(panelsOf(session.id), 'panel');
    const analysesBefore = analysesOf(session.id);
    const rowsBefore = followUpRowsOf(session.id);
    const devtoolsMark = session.devtools.received.length;
    const failedLogsBefore = harness.logger.withMessage(FOLLOW_UP_FAILED_LOG).length;

    // The decision is held, so the follow-up has loaded and recorded what it is
    // decided against — the baseline panel — before anything else may change.
    let asked: AskedFollowUp;
    let competing: PanelSpec;
    const release = holdNextDecision();
    try {
      asked = await askFollowUp(session, question, {
        needsNewCapture: false,
        additionalActions: [],
      });
      const recorded = unwrap(asked.answered, 'session.question');
      expect(last(recorded.followUps, 'follow-up').question).toBe(question);

      // Meanwhile another writer stores the session's next panel version, superseding the baseline.
      competing = unwrap(
        harness.repos.panels.insertPanel(
          {
            ...baseline,
            id: newPanelId(),
            panelVersion: baseline.panelVersion + 1,
            supersedes: baseline.id,
          },
          { captureId },
        ),
        'panels.insertPanel (the competing panel)',
      );
      unwrap(validatePanelSpec(competing), 'validatePanelSpec(competing panel)');
    } finally {
      release();
    }
    const { mark } = asked;

    // Released, the follow-up is refused and the session filed as failed at the panel step.
    const failed = await waitForStored(
      session.id,
      (record) => record.status === STATUS.failed,
      'the follow-up is refused and the session is filed as failed',
    );
    await waitForPushedStatus(session, mark, STATUS.failed);
    await waitFor(
      session.devtools,
      'session.updated',
      (message, index) =>
        index >= devtoolsMark &&
        message.payload.session.id === session.id &&
        message.payload.session.status === STATUS.failed,
      HARNESS_TIMEOUTS.pipeline,
    );
    expect(statusWalk(session.editor, session.id, mark, STATUS.generated)).toEqual([
      STATUS.generated,
      STATUS.analyzing,
      STATUS.failed,
    ]);
    await waitFor(
      session.editor,
      'session.progress',
      (message, index) =>
        index >= mark &&
        message.payload.sessionId === session.id &&
        message.payload.stage === GENERATE_PANEL_STAGE &&
        message.payload.status === PROGRESS_FAILED,
    );
    const refusal = last(
      harness.logger
        .withMessage(FOLLOW_UP_FAILED_LOG)
        .slice(failedLogsBefore)
        .filter((record) => record.fields['sessionId'] === session.id),
      'follow-up failure record',
    );
    expect(refusal.fields).toMatchObject({
      stage: GENERATE_PANEL_STAGE,
      code: 'SESSION_INVALID_STATE',
      reason: 'supersedes-stale',
    });

    // The panel ladder holds exactly the baseline and the competing panel: nothing
    // superseding the stale baseline was stored beside it.
    expect(panelsOf(session.id)).toEqual([baseline, competing]);
    // Refused before the analysis was regenerated: its ladder is unchanged.
    expect(analysesOf(session.id)).toEqual(analysesBefore);
    expect(failed.analyses).toEqual(before.analyses);
    expect(failed.panelIds).toEqual(before.panelIds);

    // No follow-up panel reached either user interface.
    const panelPushes = [
      ...session.editor.received.slice(mark),
      ...session.devtools.received.slice(devtoolsMark),
    ].filter(
      (message) =>
        isMessageOfType(message, 'panel.generated') && message.payload.sessionId === session.id,
    );
    expect(panelPushes).toEqual([]);

    // The follow-up is recorded, and stays unanswered — in the record and in the store.
    const followUp = last(failed.followUps, 'follow-up');
    expect(failed.followUps).toHaveLength(before.followUps.length + 1);
    expect(followUp.question).toBe(question);
    expect(isFollowUpAnswered(followUp)).toBe(false);
    const rows = followUpRowsOf(session.id);
    expect(rows).toHaveLength(rowsBefore.length + 1);
    expect(isFollowUpAnswered(last(rows, 'stored follow-up'))).toBe(false);
  });

  it('ends the failed session with every patch restored', async () => {
    const ended = unwrap(await harness.endSession(session.id), 'session.end');
    expect(ended.cleanup).toBe(CLEANUP.clean);
    await assertTreeUnchanged(session.project.root, session.project.snapshot);
    for (const record of await modificationsOf(session.id)) {
      expect(record.status).toBe(MODIFICATION.reverted);
    }
    expect(storedSession(session.id).status).toBe(STATUS.ended);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The follow-up decision made by the real rules-based provider
 *
 * Every suite above scripts the decision so it can force each path. These two
 * leave it to the provider every automated run uses: the decision is built from
 * the structured context the service itself assembled — the stored
 * understanding, the installed plan, the capture summary `computeCaptureSummary`
 * produced and the declarations the follow-up's words resolve to in the code
 * graph — so both paths, and the record chain, are proven reachable without a
 * model.
 * ---------------------------------------------------------------------------------------------- */

/** The inspected tabs of the two sessions whose follow-ups the real provider decides. */
const REAL_EVIDENCE_TAB = 45;
const REAL_CHAIN_TAB = 46;

/** The question both sessions start from, the one the scripted suites start from. */
const REAL_SESSION_QUESTION =
  'Why does the trail report take so long to appear after I pick a trail?';

/**
 * The committed batches one capture replays together. Between them they record
 * at least one event of every capture signal's telemetry kind — interactions,
 * renders and commits, state, fetch and XHR, navigation and performance entries,
 * page and server errors, the request and route-handler spans, a function span
 * and the query spans — so no signal an understanding can ask for is missing.
 */
const FULL_COVERAGE_BATCHES: readonly string[] = [
  CROSS_TIER_BATCH,
  'telemetry-perf-errors.json',
  'telemetry-renders-state.json',
  'telemetry-requests-queries.json',
];

/** One capture's events: every batch of {@link FULL_COVERAGE_BATCHES}, freshly identified. */
function fullCoverageCapture(): IngressEvent[] {
  return FULL_COVERAGE_BATCHES.flatMap((name) => freshlyIdentifiedBatch(readTelemetryBatch(name)));
}

/** A request's structured input as a plain object, failing when it is anything else. */
function structuredInputOf(request: ModelRequest): Readonly<Record<string, unknown>> {
  const { input } = request;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('The follow-up decision request carried no structured input object.');
  }
  return input;
}

/** The telemetry kinds the capture summary of a decision request counts at least once, ascending. */
function recordedKindsOf(input: Readonly<Record<string, unknown>>): string[] {
  const summary = input['captureSummary'];
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) {
    throw new Error('The follow-up decision request carried no capture summary.');
  }
  const tally: unknown = (summary as Readonly<Record<string, unknown>>)['kindCounts'];
  if (typeof tally !== 'object' || tally === null || Array.isArray(tally)) {
    throw new Error('The capture summary carried no per-kind tally.');
  }
  return Object.entries(tally)
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([kind]) => kind)
    .sort();
}

/**
 * {@link captureAndGenerate}, then waits until the operation that generated the
 * panel has released the session and its `generated` push has reached the
 * editor — so a status walk read after the next ask starts at that ask, never
 * at a late push of this capture.
 */
async function captureAndSettle(
  session: LiveSession,
  events: readonly IngressEvent[],
): Promise<CaptureOutcome> {
  const mark = session.editor.received.length;
  const completed = completedOperations(session.id);
  const outcome = await captureAndGenerate(session, events);
  await waitForCompletedOperation(session.id, completed);
  await waitForPushedStatus(
    session,
    mark,
    STATUS.generated,
    (pushed) => pushed.panelIds.length === outcome.record.panelIds.length,
  );
  return outcome;
}

/** The one real decision request made since `from`, failing when there is not exactly one. */
function realDecisionSince(from: number): ModelRequest {
  return only(realDecisionRequests.slice(from), 'follow-up decision the real provider answered');
}

describe('a follow-up the real provider answers from the stored evidence', () => {
  /** The session whose capture already holds every signal its understanding needs. */
  let session: LiveSession;

  beforeAll(async () => {
    const project = await harness.copyFixtureProject();
    session = await openReadySession(project, REAL_EVIDENCE_TAB, REAL_SESSION_QUESTION);
    await captureAndSettle(session, fullCoverageCapture());
  });

  afterEach(releaseRealDecisionClaims);

  it('decides `needsNewCapture: false` from the capture summary and goes `generated → analyzing → generated`', async () => {
    const question = 'Which step of that request accounts for most of its time?';
    const stored = storedSession(session.id);
    expect(stored.status).toBe(STATUS.generated);
    expect(stored.understanding?.signalsNeeded.length ?? 0).toBeGreaterThan(0);
    const analysesBefore = analysesOf(session.id);
    const panelsBefore = panelsOf(session.id);
    const plansBefore = plansOf(session.id);
    const capturesBefore = unwrap(
      harness.repos.sessions.listCaptures(session.id),
      'sessions.listCaptures',
    );
    const recordsBefore = await modificationsOf(session.id);
    const treeBefore = await snapshotTree(session.project.root);
    const decidedBefore = harness.logger.withMessage(FOLLOW_UP_DECIDED_LOG).length;
    const requestsBefore = realDecisionRequests.length;

    const asked = await askRealFollowUp(session, question);
    const { mark } = asked;
    expect(last(unwrap(asked.answered, 'session.question').followUps, 'follow-up').question).toBe(
      question,
    );

    const done = await waitForStored(
      session.id,
      (record) =>
        record.status === STATUS.generated &&
        record.analyses.length === analysesBefore.length + 1 &&
        record.panelIds.length === panelsBefore.length + 1,
      'the real decision regenerated the analysis and the panel from the stored capture',
    );
    await waitForPushedStatus(
      session,
      mark,
      STATUS.generated,
      (record) => record.panelIds.length === panelsBefore.length + 1,
    );
    expect(statusWalk(session.editor, session.id, mark, STATUS.generated)).toEqual([
      STATUS.generated,
      STATUS.analyzing,
      STATUS.generated,
    ]);
    expect(realDecisionsPending).toBe(0);

    // The real provider decided from the service's own capture summary, whose
    // per-kind tally recorded events, and from nothing the question's words carry.
    const request = realDecisionSince(requestsBefore);
    const input = structuredInputOf(request);
    const recorded = recordedKindsOf(input);
    for (const kind of ['http.server', 'route.handler', 'perf.entry', 'render', 'db.query']) {
      expect(recorded).toContain(kind);
    }
    expect(input['candidates']).toBeUndefined();
    expect(JSON.stringify(input)).not.toContain(question);
    const decided = only(
      harness.logger.withMessage(FOLLOW_UP_DECIDED_LOG).slice(decidedBefore),
      'decision log record',
    );
    expect(decided.fields).toMatchObject({
      path: memberOf(FOLLOW_UP_PATHS, 'existing-evidence'),
      needsNewCapture: false,
      proposed: 0,
      accepted: 0,
      namedDeclarations: 0,
    });

    // Nothing was captured or installed.
    expect(
      unwrap(harness.repos.sessions.listCaptures(session.id), 'sessions.listCaptures'),
    ).toEqual(capturesBefore);
    expect(await modificationsOf(session.id)).toEqual(recordsBefore);
    expect(plansOf(session.id)).toEqual(plansBefore);
    await assertTreeUnchanged(session.project.root, treeBefore);

    // analyses[n + 1] and panelVersion n + 1, each superseding rung n.
    const previousAnalysis = last(analysesBefore, 'analysis');
    const analysis = last(analysesOf(session.id), 'analysis');
    expect(analysis.analysisVersion).toBe(previousAnalysis.analysisVersion + 1);
    expect(analysis.supersedes).toBe(previousAnalysis.id);
    expect(analysis.captureId).toBe(previousAnalysis.captureId);
    const previousPanel = last(panelsBefore, 'panel');
    const panel = last(panelsOf(session.id), 'panel');
    expect(panel.panelVersion).toBe(previousPanel.panelVersion + 1);
    expect(panel.supersedes).toBe(previousPanel.id);
    unwrap(validatePanelSpec(panel), 'validatePanelSpec');
    const pushed = await waitFor(
      session.editor,
      'panel.generated',
      (message, index) => index >= mark && message.payload.panelId === panel.id,
    );
    expect(pushed.payload.panel.supersedes).toBe(previousPanel.id);
    expect(last(done.followUps, 'follow-up')).toMatchObject({
      question,
      needsNewCapture: false,
      captureId: previousAnalysis.captureId,
      analysisId: analysis.id,
      panelId: panel.id,
    });
  });

  it('ends the session with every patch restored and the copy byte-identical', async () => {
    const ended = unwrap(await harness.endSession(session.id), 'session.end');
    expect(ended.cleanup).toBe(CLEANUP.clean);
    await assertTreeUnchanged(session.project.root, session.project.snapshot);
    expect(storedSession(session.id).status).toBe(STATUS.ended);
  });
});

describe('a follow-up naming a declaration the real provider times as a chained delta', () => {
  /** The session whose follow-ups name the service module's two functions in turn. */
  let session: LiveSession;

  beforeAll(async () => {
    const project = await harness.copyFixtureProject();
    session = await openReadySession(project, REAL_CHAIN_TAB, REAL_SESSION_QUESTION);
    await captureAndSettle(session, fullCoverageCapture());
  });

  afterEach(releaseRealDecisionClaims);

  /**
   * Asks `question`, which names one function of the service module, and waits
   * for the plan version it installs.
   *
   * @returns The decision request, the plan versions before and after, the
   * journal before, and the transcript mark.
   */
  async function askNamingFunction(question: string): Promise<{
    readonly request: ModelRequest;
    readonly previousPlan: InstrumentationPlan;
    readonly plan: InstrumentationPlan;
    readonly recordsBefore: readonly ModificationRecord[];
    readonly mark: number;
  }> {
    const plansBefore = plansOf(session.id);
    const previousPlan = last(plansBefore, 'plan version');
    const recordsBefore = await modificationsOf(session.id);
    const requestsBefore = realDecisionRequests.length;
    const decidedBefore = harness.logger.withMessage(FOLLOW_UP_DECIDED_LOG).length;

    const asked = await askRealFollowUp(session, question);
    const { mark } = asked;
    expect(last(unwrap(asked.answered, 'session.question').followUps, 'follow-up').question).toBe(
      question,
    );
    const ready = await waitForStored(
      session.id,
      (record) => record.status === STATUS.ready && record.plans.length === plansBefore.length + 1,
      'the named function is timed by plan version n + 1',
    );
    await waitForPushedStatus(session, mark, STATUS.ready);
    expect(statusWalk(session.editor, session.id, mark, STATUS.generated)).toEqual([
      STATUS.generated,
      STATUS.planning,
      STATUS.instrumenting,
      STATUS.ready,
    ]);
    expect(realDecisionsPending).toBe(0);
    const decided = only(
      harness.logger.withMessage(FOLLOW_UP_DECIDED_LOG).slice(decidedBefore),
      'decision log record',
    );
    expect(decided.fields).toMatchObject({
      path: memberOf(FOLLOW_UP_PATHS, 'new-capture'),
      needsNewCapture: true,
      proposed: 1,
      accepted: 1,
      identifierCandidates: 1,
      namedDeclarations: 1,
    });
    const plan = last(plansOf(session.id), 'plan version');
    expect(ready.plans).toEqual(plansOf(session.id));
    return { request: realDecisionSince(requestsBefore), previousPlan, plan, recordsBefore, mark };
  }

  /** The one action plan version `plan` adds to `previousPlan`, checked to be purely additive. */
  function onlyDelta(
    previousPlan: InstrumentationPlan,
    plan: InstrumentationPlan,
  ): InstrumentationAction {
    expect(plan.planVersion).toBe(previousPlan.planVersion + 1);
    const previousCount = previousPlan.instrumentationTargets.length;
    expect(plan.instrumentationTargets.slice(0, previousCount)).toEqual(
      previousPlan.instrumentationTargets,
    );
    return only(plan.instrumentationTargets.slice(previousCount), 'delta action');
  }

  it('times a named, uninstrumented function as plan version n + 1 with one function-timing delta', async () => {
    // The premise: the first plan leaves the service module untouched, so the
    // first named function is a new file edit and the second one chains onto it.
    const firstPlan = only(plansOf(session.id), 'plan version');
    expect(firstPlan.instrumentationTargets.map((action) => action.file)).not.toContain(
      CORPUS.serviceFile,
    );

    const question = 'How long does loadTrailReport take on its own?';
    const { request, previousPlan, plan, recordsBefore, mark } = await askNamingFunction(question);

    // The decision read the declaration the follow-up named, resolved through the
    // code graph, and none of the question's prose.
    const input = structuredInputOf(request);
    expect(input['identifierCandidates']).toEqual([CORPUS.loadSymbol]);
    expect(input['candidates']).toEqual([
      expect.objectContaining({ file: CORPUS.serviceFile, symbol: CORPUS.loadSymbol, score: 1 }),
    ]);
    expect(JSON.stringify(input)).not.toContain(question);

    const delta = onlyDelta(previousPlan, plan);
    expect(delta).toMatchObject({
      file: CORPUS.serviceFile,
      symbol: CORPUS.loadSymbol,
      type: ACTION_TYPE.functionTiming,
      mode: PATCH_MODE,
    });

    const records = await modificationsOf(session.id);
    for (const earlier of recordsBefore) {
      expect(recordById(records, earlier.id)).toEqual(earlier);
    }
    const deltaRecord = only(
      records.filter((record) => !recordsBefore.some((earlier) => earlier.id === record.id)),
      'record of the delta install',
    );
    expect(deltaRecord).toMatchObject({
      file: CORPUS.serviceFile,
      planVersion: plan.planVersion,
      status: MODIFICATION.applied,
      originalHash: pristineDigest(session.project, CORPUS.serviceFile),
    });
    expect(deltaRecord.previousRecordId).toBeUndefined();
    expect(await digestOf(session.project, CORPUS.serviceFile)).toBe(deltaRecord.instrumentedHash);

    // A non-empty delta: `instrumentation.ready` lists exactly its record.
    const announced = await waitFor(
      session.editor,
      'instrumentation.ready',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(announced.payload.applied).toEqual([deltaRecord]);
  });

  it('layers a second named function over the patched file as a verified `previousRecordId` chain', async () => {
    await captureAndSettle(session, fullCoverageCapture());
    const parent = only(
      recordsFor(await modificationsOf(session.id), CORPUS.serviceFile),
      'record of the first service patch',
    );

    const { request, previousPlan, plan, recordsBefore, mark } = await askNamingFunction(
      'Does summarizeConditions take long when it folds the reports?',
    );
    const input = structuredInputOf(request);
    expect(input['identifierCandidates']).toEqual([CORPUS.summarizeSymbol]);
    expect(input['candidates']).toEqual([
      expect.objectContaining({ file: CORPUS.serviceFile, symbol: CORPUS.summarizeSymbol }),
    ]);

    const delta = onlyDelta(previousPlan, plan);
    expect(delta).toMatchObject({
      file: CORPUS.serviceFile,
      symbol: CORPUS.summarizeSymbol,
      type: ACTION_TYPE.functionTiming,
      mode: PATCH_MODE,
    });

    // The chain: the new record replaced the bytes the earlier patch wrote.
    const records = await modificationsOf(session.id);
    for (const earlier of recordsBefore) {
      expect(recordById(records, earlier.id)).toEqual(earlier);
    }
    const child = only(
      records.filter((record) => !recordsBefore.some((earlier) => earlier.id === record.id)),
      'record of the chained delta',
    );
    expect(child).toMatchObject({
      file: CORPUS.serviceFile,
      planVersion: plan.planVersion,
      status: MODIFICATION.applied,
      originalHash: parent.instrumentedHash,
      previousRecordId: parent.id,
    });
    expect(child.instrumentedHash).not.toBe(parent.instrumentedHash);
    expect(await digestOf(session.project, CORPUS.serviceFile)).toBe(child.instrumentedHash);
    expect(await sha256OfFile(child.backupPath)).toBe(parent.instrumentedHash);
    const chain = unwrap(await harness.repos.modifications.listChain(child.id), 'listChain');
    expect(chain.map((record) => record.id)).toEqual([parent.id, child.id]);

    const announced = await waitFor(
      session.editor,
      'instrumentation.ready',
      (message, index) => index >= mark && message.payload.sessionId === session.id,
    );
    expect(announced.payload.applied).toEqual([child]);
  });

  it('restores the chain in strict reverse order on session end and leaves the copy byte-identical', async () => {
    const recordsBefore = await modificationsOf(session.id);
    const [parent, child] = recordsFor(recordsBefore, CORPUS.serviceFile);
    if (parent === undefined || child === undefined) {
      throw new Error('The service file must carry a two-record chain before the session ends.');
    }
    expect(child.previousRecordId).toBe(parent.id);

    const ended = unwrap(await harness.endSession(session.id), 'session.end');
    expect(ended.cleanup).toBe(CLEANUP.clean);

    const records = await modificationsOf(session.id);
    expect(records.map((record) => record.status)).toEqual(
      records.map(() => MODIFICATION.reverted),
    );
    const revertedParent = recordById(records, parent.id);
    const revertedChild = recordById(records, child.id);
    expect(revertedChild.appliedAt).toBeLessThan(revertedParent.appliedAt);
    expect(revertedChild.appliedAt).toBeGreaterThan(child.appliedAt);
    await assertTreeUnchanged(session.project.root, session.project.snapshot);
    for (const record of records) {
      expect(await exists(record.backupPath)).toBe(false);
    }
    expect(storedSession(session.id).status).toBe(STATUS.ended);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The followups log and the session record: one durable history
 * ---------------------------------------------------------------------------------------------- */

/** The inspected tab of the session whose ask the store refuses to mirror. */
const DURABILITY_TAB = 44;

/** The shape of every session id the service mints, checked before one is spelled into DDL. */
const INJECTABLE_ID = /^[A-Za-z0-9_-]+$/u;

/**
 * The batch with every identity minted afresh — event, trace, span and
 * producer ids, each mapped consistently so the parent/child shape (the
 * deliberate orphan included) is carried over — for a capture of a session
 * outside the fixture README's id blocks, which {@link reidentifyBatch} has
 * already spent on the captures above.
 */
function freshlyIdentifiedBatch(events: readonly IngressEvent[]): IngressEvent[] {
  const traces = new Map<string, string>();
  const spans = new Map<string, string>();
  const producers = new Map<string, string>();
  const mapped = (ids: Map<string, string>, id: string, mint: () => string): string => {
    const known = ids.get(id);
    if (known !== undefined) {
      return known;
    }
    const minted = mint();
    ids.set(id, minted);
    return minted;
  };
  return events.map((event) => ({
    ...event,
    id: newEventId(),
    traceId: mapped(traces, event.traceId, newTraceId),
    spanId: mapped(spans, event.spanId, newSpanId),
    ...(event.parentSpanId === undefined
      ? {}
      : { parentSpanId: mapped(spans, event.parentSpanId, newSpanId) }),
    producerId: mapped(producers, event.producerId, newProducerId),
  }));
}

describe('the followups log and the session record hold one durable history', () => {
  it('holds every session’s followups rows equal to its record’s ladder after the follow-up paths above', () => {
    const listed = unwrap(harness.repos.sessions.list(), 'sessions.list');
    const rows: FollowUpRecord[] = [];
    for (const { id } of listed.items) {
      const logged = followUpRowsOf(id);
      expect(logged, `the followups rows of ${id}`).toEqual(storedSession(id).followUps);
      rows.push(...logged);
    }
    // Both paths stamped their outcome links on the log as well as the ladder.
    expect(rows.filter((row) => isFollowUpAnswered(row)).length).toBeGreaterThan(0);
    for (const key of FOLLOW_UP_OUTCOME_KEYS) {
      expect(
        rows.some((row) => row[key] !== undefined),
        `a followups row carrying ${key}`,
      ).toBe(true);
    }
  });

  it('rolls the followups row back when the session record cannot mirror an ask, before any decision call', async () => {
    const project = await harness.copyFixtureProject();
    const session = await openReadySession(
      project,
      DURABILITY_TAB,
      'Which step of this page waits the longest before its first rows appear?',
    );
    const completedBefore = harness.logger.withMessage(OPERATION_COMPLETED_LOG).length;
    await captureAndGenerate(session, freshlyIdentifiedBatch(readTelemetryBatch(CROSS_TIER_BATCH)));
    // The operation that generated the panel has released the session, so the
    // ask below meets the injected failure rather than a `pipeline-busy` refusal.
    await waitUntil(
      () =>
        harness.logger
          .withMessage(OPERATION_COMPLETED_LOG)
          .slice(completedBefore)
          .find(
            (record) =>
              record.fields['sessionId'] === session.id &&
              record.fields['status'] === STATUS.generated,
          ),
      'the operation that generated the panel has released the session',
      HARNESS_TIMEOUTS.pipeline,
    );
    const before = storedSession(session.id);
    expect(before.status).toBe(STATUS.generated);
    const rowsBefore = followUpRowsOf(session.id);
    const decisionCalls = scripted.calls.filter((call) => call.stage === FOLLOW_UP_STAGE).length;

    // The injected failure: a TEMP trigger on the service's own connection that
    // aborts only the record write that grows the follow-up ladder — the
    // mirror of the `followups` row the same unit inserted first. Every other
    // write of the session, the move to `failed` included, goes through.
    if (!INJECTABLE_ID.test(session.id)) {
      throw new Error('The session id cannot be quoted into a trigger.');
    }
    const trigger = `followup_suite_refuse_mirror_${session.id.replaceAll('-', '_')}`;
    harness.store.db.exec(
      `CREATE TEMP TRIGGER ${trigger} BEFORE UPDATE ON sessions
       WHEN OLD.id = '${session.id}'
         AND json_array_length(NEW.record, '$.followUps') > json_array_length(OLD.record, '$.followUps')
       BEGIN SELECT RAISE(ABORT, 'followup suite: injected follow-up mirror failure'); END;`,
    );
    try {
      const asked = await sendFollowUp(
        session,
        'Which of those steps waits on the database?',
        newId(FOLLOW_UP_ATTEMPT_ID_PREFIX),
      );
      if (!isErr(asked.answered)) {
        throw new Error('An ask whose record write the store refused was answered as recorded.');
      }
      expect(asked.answered.error.code).toBe('STORE_ERROR');
      const failed = await waitForStored(
        session.id,
        (record) => record.status === STATUS.failed,
        'the follow-up that could not be recorded is filed as failed',
      );

      // Neither durable view holds the ask: the row was rolled back with the
      // record write that could not mirror it.
      expect(failed.followUps).toEqual(before.followUps);
      expect(followUpRowsOf(session.id)).toEqual(rowsBefore);
    } finally {
      harness.store.db.exec(`DROP TRIGGER IF EXISTS temp.${trigger};`);
    }

    // The ask failed before the decision: no model call was made for it.
    expect(scripted.calls.filter((call) => call.stage === FOLLOW_UP_STAGE)).toHaveLength(
      decisionCalls,
    );
    expect(followUpRowsOf(session.id)).toEqual(storedSession(session.id).followUps);

    const ended = unwrap(await harness.endSession(session.id), 'session.end');
    expect(ended.cleanup).toBe(CLEANUP.clean);
    await assertTreeUnchanged(project.root, project.snapshot);
  });
});

it('served every scripted follow-up decision exactly once', () => {
  scripted.assertConsumed();
  expect(pendingDecisions).toEqual([]);
  expect(scripted.calls.filter((call) => call.stage === FOLLOW_UP_STAGE)).toHaveLength(
    FOLLOW_UP_COUNT,
  );
});
