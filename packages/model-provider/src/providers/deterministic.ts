/**
 * The rules-based `ModelProvider`: the implementation that answers every stage
 * without a network, without a model, and without a single fact about the
 * application being debugged.
 *
 * This is the provider the whole automated suite runs against — every unit and
 * integration test, the browser suite and the continuous-integration end-to-end
 * job, which sets the provider selector to this implementation. It is therefore
 * production code in the only sense that matters here: when it answers badly,
 * the acceptance runs fail, and when it answers by accident the acceptance runs
 * prove nothing. Nothing in this file is a stub.
 *
 * ## What it is, and what it deliberately is not
 *
 * It is a **thin, faithful adapter** over `../deterministic/rules.js`. That
 * module is the whole of the intelligence: it reads a request's structured
 * context and computes a schema-shaped answer from it. This file does three
 * things and no more — it honours cancellation, it hands the request to those
 * rules, and it packages what comes back in the response shapes `./types.js`
 * declares. The split is what keeps a rule's defect visible: a wrong answer is a
 * wrong *rule*, surfacing in the suite that covers this provider, rather than
 * something this adapter quietly patched up on the way out.
 *
 * It is **not** a recording player, and no recorded model output exists anywhere
 * in this repository. A recording would be an answer that happened to be right
 * for one project; replaying it would make an offline run prove nothing about
 * the pipeline it is supposed to exercise.
 *
 * It is **not** a network client. It imports no model SDK, opens no socket,
 * reads no environment variable and touches no file. Nothing leaves the
 * developer's machine while this provider is selected, which is the guarantee
 * the product's security documentation makes about its offline mode.
 *
 * ## Wording-invariance, by construction rather than by testing
 *
 * A developer's question reaches a model as **data**, never as a switch. The
 * only fields read from a request here are `metadata.stage` — a value from the
 * product's own closed stage vocabulary — and `input`, the structured context.
 * The rendered prompt, the system instruction and the message history are never
 * read, never inspected and never passed on, and the rules module's own
 * signature makes that unforgeable: a builder receives the structured context
 * alone, so no code path exists through which the phrasing of a request could
 * select an output. Two requests that differ only in wording therefore produce
 * byte-identical answers, and the branch the product's requirements name as
 * forbidden — a question-string test returning a pre-authored panel — has
 * nowhere in this file it could be written.
 *
 * Every sentence a caller can read comes from the fixed frames in
 * `../deterministic/templates.js`, filled with values taken from the structured
 * context. This file composes **no answer prose at all**. The strings below are
 * diagnostics — a failure's message, its developer-facing hint and a log line —
 * which never reach an artifact, a panel or a model.
 *
 * ## Purity
 *
 * No clock, no randomness, no identifier generator, no environment read, no
 * input or output, no module-level mutable state and no memoisation. The
 * identifiers this provider emits are derived from the request's stage and a
 * positional index (see {@link toolCallId}), so two invocations with the same
 * input produce the same bytes — which is what the sibling suite asserts and
 * what makes an offline run reproducible.
 *
 * ## One asymmetry with the network-backed implementation, on purpose
 *
 * {@link ModelProvider.generateStructured} returns `Err` when a construction
 * fails the caller's schema, where a network-backed provider returns `Ok` with
 * no parsed value so that `../structured.js` can spend its repair budget. The
 * reason is stated at that method and must not be "harmonised" away: re-prompting
 * a rules engine yields the identical answer, so a miss here is a defect in the
 * rules rather than a model's near-miss, and a repair loop over it would burn
 * three passes to reach the same failure.
 */

import { DebuggenError, err, noopLogger, ok, type Logger, type Result } from '@debuggen/shared';
import type { ZodType } from 'zod';

import { buildDeterministicOutput } from '../deterministic/rules.js';
import type { ModelProvider } from '../provider.js';
import {
  PROMPT_STAGES,
  isPromptStage,
  type JsonArray,
  type JsonObject,
  type JsonValue,
  type ModelProviderConfig,
  type ModelRequest,
  type ModelTextResponse,
  type PromptStage,
  type StructuredAttempt,
  type ToolCall,
  type ToolCallsResponse,
  type ToolDefinition,
} from '../types.js';

/* -------------------------------------------------------------------------------------------------
 * identity and bounds
 * ---------------------------------------------------------------------------------------------- */

/**
 * The id this implementation reports as its own.
 *
 * Declared here as a literal rather than imported from `./index.js`: that module
 * publishes the provider vocabulary the factory validates a configured value
 * against, and it imports this file, so reading the vocabulary back from it
 * would close a cycle for no benefit. `ModelProvider.id` is typed `string`
 * precisely so an implementation can narrow it to its own literal this way.
 *
 * It is **not** a model identifier. No model identifier literal appears in this
 * file: the only one that can reach a response is the value a host configured,
 * and when a host configured none this id stands in its place, which is what
 * makes a stored artifact say honestly that no model produced it.
 */
const PROVIDER_ID = 'deterministic';

/**
 * The stop reason for an answer that was built in full.
 *
 * A provider's stop reasons are its own vocabulary — `./types.js` carries the
 * value verbatim and never compares it against a literal — so these two say
 * plainly what happened here rather than imitating a service's wire values.
 */
const COMPLETE_STOP_REASON = 'complete';

/** The stop reason for a turn that requested at least one tool call. */
const TOOL_CALLS_STOP_REASON = 'tool-calls';

/**
 * How many tool calls one turn may request.
 *
 * Every array this package emits is bounded, for the same reason: a structured
 * context is assembled by a pipeline stage and a degraded one can carry far more
 * candidates than a turn should act on, and an unbounded answer would push that
 * problem into whoever executes the calls. Twelve is generous for the
 * read-only graph queries the investigation stage proposes and small enough that
 * a pathological context cannot turn one turn into a workload.
 */
const MAX_TOOL_CALLS = 12;

/**
 * How many members of one candidate carrier are examined.
 *
 * Selection filters candidates against the tools actually on offer, so a context
 * carrying thousands of them would be scanned in full to emit a handful. The
 * bound keeps that scan proportional to a plausible context rather than to
 * whatever arrived, and it is applied to each of the four carriers in
 * {@link TOOL_CALL_FIELDS} independently.
 */
const MAX_CANDIDATE_SCAN = 200;

/**
 * How deep {@link stableJson} descends before it stops.
 *
 * A JSON value cannot contain a cycle, but `ModelRequest.input` is typed rather
 * than validated, so a caller that assembled a self-referential object would
 * satisfy the compiler and hang a naive serialiser. The bound turns that into a
 * truncated string instead of a stalled process, and it is far deeper than any
 * context this product assembles.
 */
const MAX_SERIALIZATION_DEPTH = 64;

/**
 * How many distinct schema-issue paths a rejection reports.
 *
 * Enough to show the shape of the failure to whoever has to fix the rule that
 * caused it, bounded so a rejection over a large array cannot produce an error
 * whose details are larger than the answer they describe.
 */
const MAX_REPORTED_ISSUE_PATHS = 10;

/**
 * Field names under which a structured context may carry the tool calls a turn
 * should request, probed in this order.
 *
 * The aliases exist because the stage that assembles a context is free to name
 * the concept its own way, which is the same tolerance `../deterministic/rules.js`
 * applies to every field it reads. All four are product vocabulary: none names
 * anything belonging to an application under test.
 */
const TOOL_CALL_FIELDS: readonly string[] = ['toolCalls', 'toolRequests', 'toolQueries', 'queries'];

/** Field names under which a candidate may carry the tool it names. */
const TOOL_NAME_FIELDS: readonly string[] = ['tool', 'toolName', 'name'];

/** Field names under which a candidate may carry the arguments for its tool. */
const TOOL_INPUT_FIELDS: readonly string[] = ['input', 'arguments', 'args', 'params'];

/**
 * The arguments emitted for a candidate that named a tool and nothing else.
 *
 * Frozen and shared: it is never handed to a mutating consumer, and building a
 * fresh empty object per call would make two otherwise identical answers differ
 * by object identity — which a test comparing structures would not see, and a
 * test comparing references would.
 */
const EMPTY_TOOL_INPUT: JsonObject = Object.freeze({});

/* -------------------------------------------------------------------------------------------------
 * diagnostics
 *
 * Messages, hints and log lines. None of these reaches an artifact, a panel or a
 * model: answer prose comes only from `../deterministic/templates.js`, through
 * the rules module. A hint is the one part of a failure a developer is expected
 * to act on, so each names the next step rather than restating the failure.
 * ---------------------------------------------------------------------------------------------- */

/** The next step for a call whose caller had already abandoned it. */
const ABANDONED_HINT =
  'The work that asked for this answer was abandoned before it was built. Start the stage again if the answer is still wanted.';

/** The next step for a request that named something outside the stage vocabulary. */
const STAGE_HINT = `Set metadata.stage to one of: ${PROMPT_STAGES.join(', ')}.`;

/** The next step for a construction that did not satisfy the caller's schema. */
const SCHEMA_MISS_HINT =
  "This is a product defect rather than a model failure: the answer is computed from the request's structured context, so asking again produces the same bytes. Fix the rule that built it, or the schema handed to this call; the failing schema paths are in this error's details.";

/** The next step for a configuration addressed to a different implementation. */
const PROVIDER_MISMATCH_HINT = `Construct the implementation the configuration names, or set ModelProviderConfig.providerId to '${PROVIDER_ID}'.`;

/** The next step for a configuration whose model identifier is blank. */
const BLANK_MODEL_HINT =
  'Give ModelProviderConfig.model a non-empty identifier, or omit the configuration entirely: this provider reaches no model and records its own id when none is configured.';

/** Logged when a caller had abandoned the work before an answer was built. */
const ABANDONED_LOG = 'Deterministic answer abandoned before it was built';

/** Logged when the rules could derive nothing from a request's context. */
const UNDERIVABLE_LOG = 'Deterministic rules derived no answer for this stage';

/** Logged when a construction failed the schema its caller supplied. */
const SCHEMA_MISS_LOG = 'Deterministic construction failed the schema supplied by its caller';

/** Logged when a request named something outside the stage vocabulary. */
const UNKNOWN_STAGE_LOG = 'Deterministic provider asked for an unimplemented stage';

/** Logged once, when a provider is constructed. */
const CONSTRUCTED_LOG = 'Deterministic model provider constructed';

/* -------------------------------------------------------------------------------------------------
 * options and resolved settings
 * ---------------------------------------------------------------------------------------------- */

/**
 * What {@link createDeterministicProvider} accepts. Every member is optional,
 * because this implementation needs nothing to run.
 *
 * Configuration arrives here and nowhere else: no environment variable is read
 * in this file, so a host that wants to influence a response passes it in, which
 * is what keeps the provider's answers a function of its arguments alone.
 */
export interface DeterministicProviderOptions {
  /**
   * The host's provider configuration, when it has one.
   *
   * Only two of its members are meaningful to an implementation that reaches no
   * service: `providerId`, which is checked against this implementation's own id
   * so a configuration addressed to another provider fails loudly instead of
   * being answered offline by mistake, and `model`, which is recorded on every
   * response for the session's provider record. A credential, a base URL, a
   * timeout, a retry count and the sampling settings are accepted and ignored —
   * there is no transport to apply them to and no sampling to influence.
   */
  readonly config?: ModelProviderConfig;

  /**
   * Where this provider's diagnostics go. Defaults to the no-op logger, so
   * library use and a test produce no output unless a host asks for it.
   *
   * Takes precedence over `config.logger` when both are given: the argument is
   * the more specific of the two, and a caller that passes one here has said
   * where it wants this provider's records.
   */
  readonly logger?: Logger;
}

/**
 * The options, resolved once at construction into the two values every response
 * needs.
 *
 * Immutable and captured by the three answer functions below, which is what
 * makes them pure with respect to their arguments: nothing they read can change
 * between two calls.
 */
interface ProviderSettings {
  /** What every response reports as the model that answered. */
  readonly model: string;

  /** Where diagnostics go. Never `undefined`; the no-op logger stands in. */
  readonly logger: Logger;
}

/* -------------------------------------------------------------------------------------------------
 * JSON narrowing
 *
 * `ModelRequest.input` is plain JSON assembled by a pipeline stage, so every
 * read is a narrowing rather than an access: `noUncheckedIndexedAccess` makes an
 * indexed read `JsonValue | undefined`, and resolving that with a check instead
 * of an assertion is what keeps a missing field from reaching an answer.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether a JSON value is an array.
 *
 * A declared predicate rather than a bare `Array.isArray` call: that function's
 * built-in signature narrows to the *mutable* `any[]`, to which a `readonly`
 * array is not assignable, so the negative branch of a bare call would leave
 * {@link JsonArray} in the union and {@link asJsonObject} would not compile
 * without a cast. Naming the predicate keeps both branches exact.
 *
 * @param value Any value from a structured context.
 * @returns `true` when `value` is a JSON array.
 */
function isJsonArray(value: JsonValue | undefined): value is JsonArray {
  return Array.isArray(value);
}

/**
 * Narrows a JSON value to an object, excluding `null` and arrays.
 *
 * @param value Any value from a structured context.
 * @returns The object, or `undefined` for anything else.
 */
function asJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === null || value === undefined || typeof value !== 'object' || isJsonArray(value)) {
    return undefined;
  }
  return value;
}

/**
 * Narrows a JSON value to a tool name: a string with something in it, trimmed.
 *
 * Trimming is the only cleaning applied, and it is applied for lookup rather
 * than for presentation: whitespace around a name is a formatting artifact of
 * whoever assembled the context, while the name itself has to match a declared
 * tool exactly. Nothing else is altered — no case folding, no collapsing, no
 * truncation — because a tool name is an identifier a caller dispatches on.
 *
 * @param value Any value from a structured context.
 * @returns The trimmed name, or `undefined` when there is none.
 */
function asToolName(value: JsonValue | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Compares two strings by code unit, ascending.
 *
 * By code unit rather than through `localeCompare`, so the order cannot depend
 * on the locale the host process happens to run in: two runs of the same input
 * have to agree, on every machine, byte for byte.
 *
 * @param left First string.
 * @param right Second string.
 * @returns A negative number, zero, or a positive number.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * The keys of an object, ordered by {@link compareStrings}.
 *
 * `Object.keys` preserves insertion order, which belongs to whoever built the
 * object rather than to this file, so every key iteration that can reach an
 * answer starts here.
 *
 * @param source The object whose keys are needed.
 * @returns The keys, in ascending order.
 */
function sortedKeys(source: JsonObject): string[] {
  return Object.keys(source).sort(compareStrings);
}

/**
 * The first of several field names that carries a value, probed in the order
 * given.
 *
 * @param source The object to read, or `undefined`.
 * @param names The field names, most specific first.
 * @returns The first value present, or `undefined`.
 */
function readField(
  source: JsonObject | undefined,
  names: readonly string[],
): JsonValue | undefined {
  if (source === undefined) {
    return undefined;
  }
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * canonical serialisation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Serialises a JSON value canonically: object keys ascending, no whitespace.
 *
 * Two callers need it, and both need the same property — that identical input
 * produces identical bytes. {@link ModelProvider.generateText} returns this
 * string as its answer, and {@link toolAnswer} uses it as the key that
 * recognises two candidate tool calls as the same call. `JSON.stringify` alone
 * would satisfy neither: it emits keys in the insertion order of whoever built
 * the object, which belongs to the stage that assembled the context rather than
 * to this file, so a context rebuilt in a different order would serialise
 * differently while meaning exactly the same thing.
 *
 * Written here rather than taken from a dependency because `@debuggen/shared`
 * publishes no canonical serialiser and this provider's dependency set is
 * deliberately closed: `@debuggen/shared`, `zod`, and this package's own
 * modules.
 *
 * Three edge cases, each resolved the way `JSON.stringify` resolves it, so the
 * output stays parseable JSON:
 *
 * - A non-finite number becomes `null`. The JSON grammar has no `NaN` and no
 *   infinity, and a silent `0` would look like a measured zero.
 * - A member whose value is `undefined` is omitted. `JsonObject`'s index
 *   signature admits `undefined` only because `noUncheckedIndexedAccess` makes
 *   an indexed read include it; a key set to it is absent, not present-and-empty.
 * - Recursion beyond {@link MAX_SERIALIZATION_DEPTH} becomes `null`, which turns
 *   a self-referential context — buildable in TypeScript, unrepresentable in
 *   JSON — into a truncated string instead of a stalled process.
 *
 * @param value The value to serialise.
 * @param depth How deep this call already is. Callers pass nothing.
 * @returns The canonical JSON text of `value`.
 */
function stableJson(value: JsonValue, depth = 0): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (depth >= MAX_SERIALIZATION_DEPTH) {
    return 'null';
  }

  if (isJsonArray(value)) {
    const members: string[] = [];
    for (const member of value) {
      members.push(stableJson(member, depth + 1));
    }
    return `[${members.join(',')}]`;
  }

  const entries: string[] = [];
  for (const key of sortedKeys(value)) {
    const member = value[key];
    if (member === undefined) {
      continue;
    }
    entries.push(`${JSON.stringify(key)}:${stableJson(member, depth + 1)}`);
  }
  return `{${entries.join(',')}}`;
}

/* -------------------------------------------------------------------------------------------------
 * typed failures
 *
 * Every code below is a member of the closed vocabulary in `@debuggen/shared`,
 * and each is the one `./provider.js` designates for its condition:
 * `CONFIG_INVALID` for a process that cannot make sense of its own inputs,
 * `MODEL_UNAVAILABLE` for a call that never produced an answer (a cancellation
 * belongs to that family), `INTERNAL` for a failure of this code itself.
 *
 * `MODEL_OUTPUT_INVALID` appears nowhere here on purpose: `./provider.js`
 * reserves it for `./structured.js`, which is the only module allowed to reject
 * an artifact on schema grounds, and a provider that claimed it would send a
 * caller down the wrong recovery path.
 * ---------------------------------------------------------------------------------------------- */

/** How an empty path renders in a reported schema-issue path. */
const ISSUE_ROOT_MARKER = '(root)';

/** A property name that can be written after a dot without quoting. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The part of a Zod issue this file reads: where the failure was, never what
 * was there.
 *
 * Declared structurally rather than imported as `ZodError`, because the path is
 * genuinely all that is wanted. A failure's details are logged, persisted with a
 * session and rendered in two user interfaces without passing through either
 * redaction checkpoint, so a rejection here carries field paths alone — no
 * value, no message, nothing that could echo a payload.
 */
interface SchemaIssue {
  /** The path to the failing member, as Zod reports it. */
  readonly path: readonly PropertyKey[];
}

/**
 * Renders one issue path as a readable accessor chain.
 *
 * Numeric segments become `[0]`, ordinary names become `.name`, and anything
 * else — a name with a space, a symbol key — becomes a quoted subscript, so the
 * result is unambiguous for every path Zod can produce. Every segment goes
 * through `String` individually rather than through `Array.prototype.join`,
 * because joining an array that contains a symbol throws.
 *
 * `./structured.js` renders paths the same way for its own rejections. The
 * formatting is duplicated rather than imported to keep the dependency direction
 * intact: that module consumes a provider, so a provider importing it back would
 * invert the layering for the sake of nine lines.
 *
 * @param path The issue path, possibly empty.
 * @returns The rendered path, or {@link ISSUE_ROOT_MARKER} for an empty one.
 */
function formatIssuePath(path: readonly PropertyKey[]): string {
  let rendered = '';

  for (const segment of path) {
    if (typeof segment === 'number') {
      rendered += `[${String(segment)}]`;
      continue;
    }

    const name = String(segment);
    if (IDENTIFIER_PATTERN.test(name)) {
      rendered += rendered.length === 0 ? name : `.${name}`;
      continue;
    }

    rendered += `[${JSON.stringify(name)}]`;
  }

  return rendered.length === 0 ? ISSUE_ROOT_MARKER : rendered;
}

/**
 * The distinct paths of a schema failure, ordered and bounded.
 *
 * Distinct because a single wrong member commonly produces several issues at the
 * same path, ordered so two runs of the same failure report the same list, and
 * bounded by {@link MAX_REPORTED_ISSUE_PATHS} so a rejection over a large array
 * stays smaller than the answer it describes.
 *
 * @param issues The issues Zod reported.
 * @returns The rendered paths, ascending.
 */
function issuePaths(issues: readonly SchemaIssue[]): string[] {
  const rendered = new Set<string>();
  for (const issue of issues) {
    rendered.add(formatIssuePath(issue.path));
  }
  return [...rendered].sort(compareStrings).slice(0, MAX_REPORTED_ISSUE_PATHS);
}

/**
 * The failure for a call whose caller had already abandoned it.
 *
 * `MODEL_UNAVAILABLE` rather than a cancellation-specific code: the vocabulary
 * is closed, and `./provider.js` places a cancelled call in that code's family —
 * a call that produced no answer, for a reason outside the code's control.
 *
 * @param stage The stage the abandoned request belonged to.
 * @returns The typed failure.
 */
function abandonedFailure(stage: PromptStage): DebuggenError {
  return new DebuggenError(
    'MODEL_UNAVAILABLE',
    `A ${stage} request was abandoned before the deterministic rules answered it.`,
    { hint: ABANDONED_HINT, details: { stage, providerId: PROVIDER_ID } },
  );
}

/**
 * The failure for a request that named something outside the stage vocabulary.
 *
 * An absent or unknown stage is a configuration failure of the caller rather
 * than a missing answer, so it is coded and hinted as one — and it is never
 * answered with an empty output, which would let a mis-wired stage look like a
 * stage with nothing to say.
 *
 * @param stage Whatever the request's metadata carried.
 * @returns The typed failure.
 */
function stageFailure(stage: unknown): DebuggenError {
  return new DebuggenError(
    'CONFIG_INVALID',
    'A request named a stage the deterministic rules do not implement.',
    { hint: STAGE_HINT, details: { stage: String(stage), providerId: PROVIDER_ID } },
  );
}

/**
 * The failure for a construction that did not satisfy the caller's schema.
 *
 * `INTERNAL` is the honest code: the answer was built, so nothing about the
 * model boundary was unavailable, and nothing a model did is at fault — a rule
 * in `../deterministic/rules.js` produced a shape the caller's authoring schema
 * rejects, which is this package's own defect. `MODEL_OUTPUT_INVALID` belongs to
 * `./structured.js` (see this section's note) and `PLAN_INVALID` / `PANEL_INVALID`
 * belong to the packages that own those artifacts, which this one deliberately
 * cannot name.
 *
 * @param stage The stage whose rule built the rejected answer.
 * @param paths The failing schema paths, already ordered and bounded.
 * @param total How many issues the schema reported in all.
 * @returns The typed failure.
 */
function schemaMissFailure(
  stage: PromptStage,
  paths: readonly string[],
  total: number,
): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    `The deterministic rules built a ${stage} answer that does not satisfy the schema this call supplied.`,
    {
      hint: SCHEMA_MISS_HINT,
      details: {
        stage,
        providerId: PROVIDER_ID,
        schemaIssuePaths: [...paths],
        schemaIssueCount: total,
      },
    },
  );
}

/* -------------------------------------------------------------------------------------------------
 * tool-call candidates
 *
 * A turn that offers tools is answered by *requesting* calls, never by making
 * them. The candidates are read from the request's structured context — for the
 * code-investigation stage these are the read-only graph queries the stage
 * proposes — and are selected by name lookup and field presence only: no prose
 * is inspected, and no candidate is invented.
 * ---------------------------------------------------------------------------------------------- */

/** One tool call a structured context asked for. */
interface ToolCandidate {
  /** The tool's name, exactly as the context named it, trimmed. */
  readonly name: string;

  /** The arguments to pass, or an empty object when the context named none. */
  readonly input: JsonValue;
}

/**
 * Narrows a candidate's arguments to something a tool could receive.
 *
 * An object or an array is carried through untouched — a provider normalises
 * nothing, and the caller validates the arguments against the tool's own
 * `inputSchema` before executing anything. Anything else means the context
 * marked the tool as wanted without describing a call (a `true` flag, a count),
 * and that becomes an empty argument object rather than a scalar no tool schema
 * would accept.
 *
 * @param value The value read from a candidate's argument field.
 * @returns The arguments, or {@link EMPTY_TOOL_INPUT}.
 */
function asToolArguments(value: JsonValue | undefined): JsonValue {
  if (isJsonArray(value)) {
    return value;
  }
  return asJsonObject(value) ?? EMPTY_TOOL_INPUT;
}

/**
 * Reads one candidate from a carrier member, appending it when it names a tool.
 *
 * Two forms are accepted, because a stage is free to send either: a bare string,
 * which names a tool and asks for it with no arguments, and an object carrying a
 * name field and optionally an argument field. A member that names no tool is
 * dropped — there is nothing to request — rather than guessed at.
 *
 * @param member The carrier member to read.
 * @param into The list to append to. Mutated.
 * @returns `true` when a candidate was appended.
 */
function readCandidate(member: JsonValue | undefined, into: ToolCandidate[]): boolean {
  const named = asToolName(member);
  if (named !== undefined) {
    into.push({ name: named, input: EMPTY_TOOL_INPUT });
    return true;
  }

  const object = asJsonObject(member);
  if (object === undefined) {
    return false;
  }

  const name = asToolName(readField(object, TOOL_NAME_FIELDS));
  if (name === undefined) {
    return false;
  }

  into.push({ name, input: asToolArguments(readField(object, TOOL_INPUT_FIELDS)) });
  return true;
}

/**
 * Reads every candidate a carrier holds, in a deterministic order.
 *
 * Three carrier shapes are accepted:
 *
 * - **A list**, read in its own order. An array's order is data the caller
 *   assembled, so it is honoured rather than re-sorted.
 * - **A single candidate object**, recognised by its name field.
 * - **A record keyed by tool name**, whose values are each call's arguments.
 *   Its keys are iterated in ascending order, because an object's insertion
 *   order belongs to whoever built it and two contexts that are equal as data
 *   must produce equal answers.
 *
 * @param carrier The value read from one of {@link TOOL_CALL_FIELDS}.
 * @param into The list to append to. Mutated.
 */
function collectCandidates(carrier: JsonValue | undefined, into: ToolCandidate[]): void {
  if (isJsonArray(carrier)) {
    for (const member of carrier.slice(0, MAX_CANDIDATE_SCAN)) {
      readCandidate(member, into);
    }
    return;
  }

  const object = asJsonObject(carrier);
  if (object === undefined) {
    return;
  }

  if (readCandidate(object, into)) {
    return;
  }

  for (const key of sortedKeys(object).slice(0, MAX_CANDIDATE_SCAN)) {
    const name = asToolName(key);
    if (name === undefined) {
      continue;
    }
    into.push({ name, input: asToolArguments(object[key]) });
  }
}

/**
 * Every tool call a structured context asked for, across all four carriers.
 *
 * The carriers are probed in the fixed order of {@link TOOL_CALL_FIELDS} and
 * their candidates concatenated, so a context that uses two of them still
 * produces one stable sequence. Nothing is filtered here: selection against the
 * tools actually on offer happens in {@link toolAnswer}, which is also where the
 * result is de-duplicated and bounded.
 *
 * @param input The request's structured context. Never mutated.
 * @returns The candidates, in order.
 */
function readToolCandidates(input: JsonObject): readonly ToolCandidate[] {
  const candidates: ToolCandidate[] = [];
  for (const field of TOOL_CALL_FIELDS) {
    collectCandidates(input[field], candidates);
  }
  return candidates;
}

/**
 * The identifier of one requested tool call.
 *
 * Derived from the request's stage and the call's one-based position in the
 * answer, which makes it unique within the response — the only scope in which a
 * tool-call id has to be unique, since a caller echoes it back with that call's
 * result — and reproducible across runs. No generated identifier is used
 * anywhere in this file: `@debuggen/shared`'s id helpers are random by design,
 * and one call to them would make every answer differ from the last.
 *
 * @param stage The stage the request belonged to.
 * @param position The call's one-based position in the answer.
 * @returns The identifier.
 */
function toolCallId(stage: PromptStage, position: number): string {
  return `${stage}-${String(position)}`;
}

/* -------------------------------------------------------------------------------------------------
 * the three answers
 *
 * Each is synchronous and total: it guards the caller's signal, asks the rules
 * for an answer, and returns a value. They are wrapped in an already-resolved
 * promise by the provider's methods rather than being declared `async`, because
 * there is nothing here to await — no transport, no filesystem, no timer — and a
 * function that awaits nothing should not claim to.
 *
 * None of the three attaches a listener to the caller's signal, so none has one
 * to remove: the check is a single read taken before any work, and a
 * cancellation that arrives afterwards has nothing left to interrupt.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Answers a free-text call with the canonical serialisation of the constructed
 * answer.
 *
 * Free text has one consumer in this product and nothing that reaches a
 * developer's project or the screen is ever taken from it, so the honest answer
 * for a rules-based provider is the constructed JSON itself, serialised
 * canonically: it carries exactly what the rules derived, in bytes that are
 * identical for identical input.
 *
 * @param request The request. Only `metadata.stage` and `input` are read.
 * @param settings The resolved options.
 * @returns `Ok` with the text, or the rules' own typed failure.
 */
function textAnswer(
  request: ModelRequest,
  settings: ProviderSettings,
): Result<ModelTextResponse, DebuggenError> {
  const stage = request.metadata.stage;

  if (request.signal?.aborted === true) {
    settings.logger.debug(ABANDONED_LOG, { stage, providerId: PROVIDER_ID });
    return err(abandonedFailure(stage));
  }

  const built = buildDeterministicOutput(request);
  if (!built.ok) {
    settings.logger.warn(UNDERIVABLE_LOG, {
      stage,
      providerId: PROVIDER_ID,
      code: built.error.code,
    });
    return built;
  }

  const response: ModelTextResponse = {
    text: stableJson(built.value),
    model: settings.model,
    providerId: PROVIDER_ID,
    stopReason: COMPLETE_STOP_REASON,
  };
  return ok(response);
}

/**
 * Answers a structured call, validated against the schema the caller supplied.
 *
 * ## Why this method validates at all
 *
 * A provider is otherwise forbidden from validating — `./structured.js` owns
 * that step, and a network-backed implementation hands its answer over
 * unvalidated so the repair loop can classify it. The check here is not a second
 * validation of a model's answer: it is a self-check of a *construction*. The
 * rules built this object from structured data, so it either satisfies the
 * caller's shape or a rule is wrong, and the schema is the only thing on this
 * machine that can tell the difference.
 *
 * ## Why a miss is terminal here and recoverable there
 *
 * `./providers/anthropic.js` returns `Ok` with no parsed value when an answer
 * misses the schema, so `../structured.js` can spend its two repair attempts
 * re-prompting with the validation errors. That is the right behaviour for a
 * model, which may well get it right the second time. It is the wrong behaviour
 * for a rules engine: the same input produces the same bytes, so three passes
 * reach the same failure three times and hide a product defect behind a
 * "model output invalid" rejection. A miss is therefore returned as `Err` — see
 * {@link schemaMissFailure} for the code and why it is that one — and logged at
 * error level with the stage, because someone has to fix a rule. **Do not
 * harmonise the two implementations on this point.**
 *
 * `raw` carries the construction on the success path regardless, exactly as the
 * network-backed implementation must: `../structured.js` re-parses that field
 * authoritatively, and an artifact admitted on the strength of a pre-parsed
 * value would have skipped whatever the parse did not enforce.
 *
 * @typeParam T The caller's authoring type, inferred from `schema`.
 * @param schema The caller's authoring schema. This package knows nothing about
 * what it describes, which is why no schema package is a dependency of it.
 * @param request The request. Only `metadata.stage` and `input` are read.
 * @param settings The resolved options.
 * @returns `Ok` with one attempt carrying both `raw` and the parsed value, the
 * rules' own typed failure, or a coded failure for a construction that missed
 * the schema.
 */
function structuredAnswer<T>(
  schema: ZodType<T>,
  request: ModelRequest,
  settings: ProviderSettings,
): Result<StructuredAttempt<T>, DebuggenError> {
  const stage = request.metadata.stage;

  if (request.signal?.aborted === true) {
    settings.logger.debug(ABANDONED_LOG, { stage, providerId: PROVIDER_ID });
    return err(abandonedFailure(stage));
  }

  const built = buildDeterministicOutput(request);
  if (!built.ok) {
    settings.logger.warn(UNDERIVABLE_LOG, {
      stage,
      providerId: PROVIDER_ID,
      code: built.error.code,
    });
    return built;
  }

  const parsed = schema.safeParse(built.value);
  if (!parsed.success) {
    const paths = issuePaths(parsed.error.issues);
    settings.logger.error(SCHEMA_MISS_LOG, {
      stage,
      providerId: PROVIDER_ID,
      schemaIssuePaths: paths,
      schemaIssueCount: parsed.error.issues.length,
    });
    return err(schemaMissFailure(stage, paths, parsed.error.issues.length));
  }

  const attempt: StructuredAttempt<T> = {
    raw: built.value,
    value: parsed.data,
    model: settings.model,
    providerId: PROVIDER_ID,
    stopReason: COMPLETE_STOP_REASON,
  };
  return ok(attempt);
}

/**
 * Answers a tool-offering turn with the calls the structured context asked for.
 *
 * ## What it does
 *
 * Builds a lookup from the offered tools' names, reads the candidates the
 * context carries, and emits a call for each candidate whose name is on offer —
 * in that order, de-duplicated on the tool's name and the canonical form of its
 * arguments, and bounded by {@link MAX_TOOL_CALLS}. Every step is a lookup, a
 * field-presence check or a comparison of structured values; nothing reads the
 * prose of a request, and nothing depends on an order this file did not
 * establish.
 *
 * An emitted call carries the **declared** tool's name rather than the
 * context's spelling of it, so whatever a caller dispatches on is the name it
 * itself declared.
 *
 * ## What it never does
 *
 * It never executes a tool, never reads a file and never touches the developer's
 * project. A {@link ToolDefinition} is a declaration — a name, a purpose and an
 * argument schema — and the answer is *data*: the calls a turn asked for, for the
 * caller to decide about. The service's own tool module runs the read-only graph
 * queries, against a code graph it has already built, and it is the only thing
 * that runs anything.
 *
 * No matching tool is an ordinary outcome, not a failure: the answer is `Ok`
 * with an empty call list and a completed stop reason. An invented tool name
 * would be the only way to produce a non-empty answer there, and inventing one
 * is exactly what a caller could not defend against.
 *
 * @param request The request. Only `metadata.stage` and `input` are read.
 * @param tools The tools on offer. Read, never modified.
 * @param settings The resolved options.
 * @returns `Ok` with the requested calls, or a coded failure for an abandoned
 * call or an unimplemented stage.
 */
function toolAnswer(
  request: ModelRequest,
  tools: readonly ToolDefinition[],
  settings: ProviderSettings,
): Result<ToolCallsResponse, DebuggenError> {
  if (request.signal?.aborted === true) {
    settings.logger.debug(ABANDONED_LOG, {
      stage: request.metadata.stage,
      providerId: PROVIDER_ID,
    });
    return err(abandonedFailure(request.metadata.stage));
  }

  // Typed as a stage by the request, but a request crosses a process boundary
  // before it reaches here, so the vocabulary is checked rather than trusted —
  // the same check the rules module makes before it dispatches.
  const declaredStage: unknown = request.metadata.stage;
  if (!isPromptStage(declaredStage)) {
    settings.logger.warn(UNKNOWN_STAGE_LOG, { providerId: PROVIDER_ID });
    return err(stageFailure(declaredStage));
  }

  const offered = new Map<string, ToolDefinition>();
  for (const definition of tools) {
    const name = asToolName(definition.name);
    if (name !== undefined && !offered.has(name)) {
      offered.set(name, definition);
    }
  }

  const calls: ToolCall[] = [];
  const requested = new Set<string>();

  for (const candidate of readToolCandidates(request.input)) {
    const definition = offered.get(candidate.name);
    if (definition === undefined) {
      continue;
    }

    // `\u0000` cannot occur in a tool name, so the two halves of the key cannot
    // run together: two different calls can never collide, and the same call
    // asked for twice always does.
    const key = `${definition.name}\u0000${stableJson(candidate.input)}`;
    if (requested.has(key)) {
      continue;
    }
    requested.add(key);

    calls.push({
      id: toolCallId(declaredStage, calls.length + 1),
      name: definition.name,
      input: candidate.input,
    });

    if (calls.length >= MAX_TOOL_CALLS) {
      break;
    }
  }

  const response: ToolCallsResponse = {
    calls,
    model: settings.model,
    providerId: PROVIDER_ID,
    stopReason: calls.length === 0 ? COMPLETE_STOP_REASON : TOOL_CALLS_STOP_REASON,
  };
  return ok(response);
}

/* -------------------------------------------------------------------------------------------------
 * construction
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the rules-based provider.
 *
 * `./factory.js` calls this by name when a host selects the offline provider,
 * and every automated test calls it directly — which is the point: the suite and
 * a developer's session travel the identical code path through the pipeline, and
 * only the implementation behind this interface differs.
 *
 * ## What can fail here, and what cannot
 *
 * Construction needs no credential, opens no transport and reads no environment
 * variable, so none of the failures a network-backed provider raises at
 * construction exists here. The `Result` is for a genuinely misconfigured host,
 * and there are exactly two such cases, both about a supplied configuration
 * rather than about a missing one:
 *
 * - **A configuration addressed to another implementation.** A non-blank
 *   `providerId` that names a different provider is refused rather than
 *   honoured: a host that asked for a network-backed provider and silently got
 *   an offline one would see a session answered without a model and no
 *   indication why. A blank `providerId` is treated as unstated and accepted.
 * - **A blank `model`.** The field is required by its type; blank means a host
 *   wired it and left it empty, and accepting it would record an empty model
 *   identifier on every response and on the session's provider record. The hint
 *   says to omit the configuration instead, which is the supported way to ask
 *   this provider to record its own id.
 *
 * Everything else a configuration can carry — a credential, a base URL, a
 * timeout, a retry count, the sampling settings — is accepted and ignored, and
 * nothing is sent anywhere. A credential in particular is *never* read, which is
 * what makes selecting this provider a complete answer to "does anything leave
 * this machine".
 *
 * ## What the returned value is
 *
 * A frozen object implementing {@link ModelProvider}: an id narrowed to this
 * implementation's own literal and the three methods, each returning an
 * already-resolved promise. It implements no disposal member, because it holds
 * nothing to release — `./provider.js` makes `close()` optional for exactly this
 * implementation, and a caller that disposes providers asks with `hasClose`
 * rather than assuming.
 *
 * @param options The host's configuration and logger. Both optional.
 * @returns `Ok` with the provider, or `Err` with a `CONFIG_INVALID` failure for
 * one of the two misconfigurations above.
 *
 * @example Constructing the provider a test runs the real pipeline against
 * ```ts
 * const constructed = createDeterministicProvider({ logger });
 * if (!constructed.ok) {
 *   // A misconfigured host: `error.hint` names the next step.
 *   return constructed;
 * }
 * const result = await generateStructuredWithRepair(constructed.value, schema, request);
 * ```
 */
export function createDeterministicProvider(
  options?: DeterministicProviderOptions,
): Result<ModelProvider, DebuggenError> {
  const config = options?.config;

  if (config !== undefined) {
    const declaredProvider = config.providerId.trim();
    if (declaredProvider.length > 0 && declaredProvider !== PROVIDER_ID) {
      return err(
        new DebuggenError(
          'CONFIG_INVALID',
          'A provider configuration addressed to another implementation was given to the deterministic provider.',
          {
            hint: PROVIDER_MISMATCH_HINT,
            details: { providerId: PROVIDER_ID, configuredProviderId: declaredProvider },
          },
        ),
      );
    }

    if (config.model.trim().length === 0) {
      return err(
        new DebuggenError(
          'CONFIG_INVALID',
          'A provider configuration carried a blank model identifier.',
          { hint: BLANK_MODEL_HINT, details: { providerId: PROVIDER_ID } },
        ),
      );
    }
  }

  const settings: ProviderSettings = {
    // No model identifier literal is written anywhere in this file: the only one
    // that can reach a response is what a host configured, and this provider's
    // own id stands in when a host configured none, so a stored artifact says
    // honestly that no model produced it.
    model: config?.model.trim() ?? PROVIDER_ID,
    logger: options?.logger ?? config?.logger ?? noopLogger,
  };

  settings.logger.debug(CONSTRUCTED_LOG, { providerId: PROVIDER_ID, model: settings.model });

  const provider: ModelProvider = {
    id: PROVIDER_ID,

    generateText(request: ModelRequest): Promise<Result<ModelTextResponse, DebuggenError>> {
      return Promise.resolve(textAnswer(request, settings));
    },

    generateStructured<T>(
      schema: ZodType<T>,
      request: ModelRequest,
    ): Promise<Result<StructuredAttempt<T>, DebuggenError>> {
      return Promise.resolve(structuredAnswer(schema, request, settings));
    },

    callTools(
      request: ModelRequest,
      tools: readonly ToolDefinition[],
    ): Promise<Result<ToolCallsResponse, DebuggenError>> {
      return Promise.resolve(toolAnswer(request, tools, settings));
    },
  };

  return ok(Object.freeze(provider));
}
