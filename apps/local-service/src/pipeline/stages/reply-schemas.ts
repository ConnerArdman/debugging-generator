/**
 * The authoring schemas of the two stage replies this folder owns: one turn of
 * the **code investigation** (a query batch or the final `CodeInvestigation`,
 * AAP §0.4.2, Code-investigation row) and the **follow-up decision**
 * (`FollowUpDecision`, AAP §0.4.2, Follow-up row).
 *
 * ## Why these schemas are structural, and why they live here
 *
 * AAP §0.5.3 routes every structured output through the model provider, whose
 * Anthropic implementation asks for the answer in one of two ways: the
 * schema-constrained route renders the stage's schema with the platform SDK's
 * `zodOutputFormat`, and the forced tool route renders it as a tool's
 * `input_schema` (`z.toJSONSchema`, `io: 'input'`). Both need a JSON Schema
 * document whose root is an object. An opaque `z.custom` root has no JSON
 * Schema form at all: the SDK renderer throws "Custom types cannot be
 * represented in JSON Schema", and the tool renderer widens it to a type-less
 * root that the provider refuses as `schema-not-an-object`. A real provider
 * therefore failed both replies before any request was sent.
 *
 * Each factory below returns `z.preprocess(admit, structural)`:
 *
 * - `admit` runs the stage's own **total guard** first (`isInvestigateReply`,
 *   `isFollowUpDecision`), then checks that the value is **plain JSON data all
 *   the way down** (`isPlainJsonData`: own enumerable data properties only, no
 *   proxy, bounded depth and size). A value either check refuses — including a
 *   hostile one (a throwing getter, a proxy whose traps throw, a cycle) on
 *   which a schema parse could itself throw, even inside a part the guard does
 *   not judge, such as a batch's proposals — never reaches the structural
 *   schema. The rejection is one root issue reading `expected <label>`, exactly
 *   the line the opaque schema produced, so a repair turn quotes no key, no
 *   value and no thrown message of the rejected reply.
 * - `structural` is a strict object schema the renderers can represent. Zod
 *   renders a pipe whose input side is a transform by its output side, in both
 *   the output and the input direction, so both routes see this document and
 *   both render an object root. The platform helper strips the keywords its
 *   format does not support (AAP §0.2.4; the tool literals, enumerations and
 *   bounds among them), so what constrains generation is the document's
 *   shape, and the local parse — which runs on every answer, whichever route
 *   produced it — is what enforces every keyword.
 *
 * The stage modules keep their guards as the single definition of each
 * artifact and pass them in, together with their bounds; this module imports
 * no stage module at run time, so there is no import cycle. It is the one
 * module of the folder that imports the validation library directly: the
 * stage modules stay free of it (their suites scan for that).
 *
 * ## What the structural half decides, and what it leaves to the stages
 *
 * - **Investigation.** A query batch's proposals are typed per catalogued tool:
 *   a discriminated union on `tool` with one branch per entry of
 *   `CODE_TOOL_NAMES`, generated from `CODE_TOOL_DESCRIPTORS` so the schema and
 *   the catalog the prompt shows cannot drift. A proposal that is not an
 *   object, names no catalogued tool, lacks a required argument or carries an
 *   argument of the wrong type is a schema rejection, repaired by the one
 *   repair loop with per-path issues. **Values** are deliberately not bounded
 *   here: blank names, unsafe paths, out-of-range integers (clamped), empty
 *   selectors and the excerpt argument rules stay `parseCodeToolRequest`'s, and
 *   its rejections remain evidence the model reads back and pays budget for.
 *   Undeclared argument keys are dropped, which is the parser's documented
 *   contract too.
 * - **Follow-up.** The decision's additions are the upstream authoring target
 *   or resolved action schemas, unchanged; the additive-only rule stays
 *   `diffAdditionalActions`'s.
 *
 * @module
 */

import { types } from 'node:util';

import { CODE_NODE_KINDS } from '@debuggen/code-analysis';
import {
  instrumentationActionSchema,
  instrumentationTargetInputSchema,
} from '@debuggen/instrumentation';
import { sessionRecordSchema } from '@debuggen/protocol';
import { DebuggenError } from '@debuggen/shared';
import { z } from 'zod';

import { INVESTIGATE_QUERY_BATCH_FIELD } from '../context-builder.js';
import { CODE_TOOL_DESCRIPTORS, CODE_TOOL_NAMES } from '../tools/code-tools.js';
import type {
  CodeToolArgumentDescriptor,
  CodeToolDescriptor,
  CodeToolName,
} from '../tools/code-tools.js';

/* -------------------------------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------------------------------- */

/** What {@link buildInvestigateReplySchema} needs from the investigate stage. */
export interface InvestigateReplySchemaOptions {
  /**
   * The label a guard rejection reads, as `expected <label>`: written for the
   * model, which reads it in a repair turn.
   */
  readonly label: string;
  /** The stage's total guard of a valid reply (`isInvestigateReply`); it must never throw. */
  readonly admits: (value: unknown) => boolean;
  /** The most proposals one batch may carry. */
  readonly maxQueries: number;
  /** The most flows one investigation may list. */
  readonly maxFlows: number;
  /** The longest flow line, in characters. */
  readonly maxFlowChars: number;
}

/** What {@link buildFollowUpDecisionSchema} needs from the follow-up stage. */
export interface FollowUpDecisionSchemaOptions {
  /** The label a guard rejection reads, as `expected <label>`. */
  readonly label: string;
  /** The stage's total guard of a valid decision (`isFollowUpDecision`); it must never throw. */
  readonly admits: (value: unknown) => boolean;
  /** The most additional actions one decision may propose. */
  readonly maxAdditionalActions: number;
}

/* -------------------------------------------------------------------------------------------------
 * Construction checks
 * ---------------------------------------------------------------------------------------------- */

/**
 * Refuses an option a factory cannot honour. The factories run once, at module
 * load, with the stages' own constants, so a refusal is a programmer error and
 * is raised where it is made rather than on the first model reply.
 *
 * @param condition Whether the option is acceptable.
 * @param option The option's name, for the message.
 */
function requireOption(condition: boolean, option: string): void {
  if (!condition) {
    throw new DebuggenError(
      'INTERNAL',
      `A stage reply schema was built with an unusable "${option}" option.`,
      {
        hint: 'Pass a non-blank label and positive whole-number bounds; the stage constants define both.',
        details: { reason: 'reply-schema-option', option },
      },
    );
  }
}

/** Whether a bound is a positive safe integer. */
function isPositiveBound(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/* -------------------------------------------------------------------------------------------------
 * The admission gate
 * ---------------------------------------------------------------------------------------------- */

/**
 * Whether the stage's guard admits a value, treating a guard that throws as a
 * refusal. The guards are total by contract; this keeps the gate total even if
 * one ever is not.
 *
 * @param admits The stage's guard.
 * @param value The raw reply.
 * @returns `true` only when the guard answered `true`.
 */
function admitted(admits: (value: unknown) => boolean, value: unknown): boolean {
  try {
    return admits(value);
  } catch {
    return false;
  }
}

/**
 * How deep {@link isPlainJsonData} descends before it refuses a value. A stage
 * reply nests a handful of levels at most (reply → proposal list → proposal →
 * endpoint selector → value; decision → action list → action → value), so a
 * bound far above that never refuses a real reply. It keeps the recursion
 * stack-safe and is what stops the walk on a cyclic value.
 */
const MAX_PLAIN_DATA_DEPTH = 32;

/**
 * How many values {@link isPlainJsonData} visits before it refuses a value.
 * JSON-decoded model output is a tree, so its value count is its size, and a
 * provider's output-token bound keeps that far below this figure. A value that
 * shares references can present exponentially many paths through few objects
 * (a ladder of rungs each holding the next twice); the budget caps the walk at
 * this many visits whatever the shape, so refusing such a value is cheap.
 */
const MAX_PLAIN_DATA_VALUES = 65_536;

/** The mutable state of one {@link isPlainJsonData} walk. */
interface PlainDataWalk {
  /** Values the walk may still visit. */
  remaining: number;
}

/**
 * Reads an own, enumerable data property without invoking a getter.
 *
 * @returns `{ value }`, or `undefined` for a missing key, an accessor or a
 * non-enumerable property — none of which JSON produces.
 */
function enumerableDataValue(
  container: object,
  key: string | number,
): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    return undefined;
  }
  const value: unknown = descriptor.value;
  return { value };
}

/**
 * Whether one value is plain JSON data: a string, a finite number, a boolean,
 * `null`, or a list or record of such values within the depth and value
 * budgets. Anything else — `undefined`, a non-finite number, a function, a
 * symbol, a bigint, a proxy — is refused.
 */
function isPlainJsonValue(value: unknown, depth: number, walk: PlainDataWalk): boolean {
  walk.remaining -= 1;
  if (walk.remaining < 0) {
    return false;
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (value === null) {
    return true;
  }
  // A proxy is refused outright, because it is the one object whose property
  // reads a descriptor inspection cannot vouch for: its descriptor traps may
  // report plain data while its `get` trap throws when the structural schema
  // reads the same key. Decoded JSON never contains one.
  if (depth >= MAX_PLAIN_DATA_DEPTH || types.isProxy(value)) {
    return false;
  }
  return Array.isArray(value)
    ? isPlainJsonList(value, depth, walk)
    : isPlainJsonRecord(value, depth, walk);
}

/**
 * Whether a list is a plain JSON array: an `Array` (not a subclass), dense,
 * with no key but its indices and `length`, each index an own enumerable data
 * property holding plain data. The length is weighed against the budget before
 * any key is listed, so an enormous sparse list costs nothing to refuse.
 */
function isPlainJsonList(list: readonly unknown[], depth: number, walk: PlainDataWalk): boolean {
  if (Object.getPrototypeOf(list) !== Array.prototype) {
    return false;
  }
  const length = list.length;
  if (length > walk.remaining || Reflect.ownKeys(list).length !== length + 1) {
    return false;
  }
  for (let index = 0; index < length; index += 1) {
    const element = enumerableDataValue(list, index);
    if (element === undefined || !isPlainJsonValue(element.value, depth + 1, walk)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether an object is a plain JSON record: its prototype `Object.prototype`
 * or `null`, and every own key a string naming an enumerable data property that
 * holds plain data. A class instance, a `Date`, a `Map`, a symbol key, a
 * non-enumerable key and an accessor are refused.
 */
function isPlainJsonRecord(record: object, depth: number, walk: PlainDataWalk): boolean {
  const prototype: unknown = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const keys = Reflect.ownKeys(record);
  if (keys.length > walk.remaining) {
    return false;
  }
  for (const key of keys) {
    if (typeof key !== 'string') {
      return false;
    }
    const member = enumerableDataValue(record, key);
    if (member === undefined || !isPlainJsonValue(member.value, depth + 1, walk)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a value is plain JSON data all the way down — the only shape a
 * decoded model reply takes, and therefore a check no legitimate reply fails.
 *
 * Total and bounded: it reads own property descriptors only, so no getter
 * runs; it refuses proxies before touching them; it stops at
 * {@link MAX_PLAIN_DATA_DEPTH} levels (which also ends a cycle) and after
 * {@link MAX_PLAIN_DATA_VALUES} values; and anything that still throws — an
 * exotic host object, say — is a refusal. It is the second half of the
 * admission gate: the stage guard proves the reply's shape, and this proves the
 * structural schema can read every part of it without running code the reply
 * supplied.
 *
 * @param value The raw reply.
 * @returns `true` only for plain JSON data.
 */
function isPlainJsonData(value: unknown): boolean {
  try {
    return isPlainJsonValue(value, 0, { remaining: MAX_PLAIN_DATA_VALUES });
  } catch {
    return false;
  }
}

/**
 * Wraps a structural schema behind the admission gate: the stage's total
 * guard decides first, then {@link isPlainJsonData}, and only a value both
 * admit is parsed structurally.
 *
 * The second check exists because a guard may judge only part of a value — the
 * investigate guard counts a batch's proposals and leaves judging each one to
 * the tool parser — while the structural schema then reads all of it. An
 * accessor element, a proposal whose getter throws, a proxy or a cyclic or
 * over-deep proposal would otherwise make that read throw out of `safeParse`,
 * past the bounded repair loop and possibly carrying the getter's message.
 * Decoded JSON is always plain data, so no legitimate reply is refused by it.
 *
 * Either refusal is the same single root issue whose message is the constant
 * `expected <label>`. Zod attaches the raw input to an issue only while the
 * parse runs and drops it from the finished error (no `reportInput`), and the
 * message interpolates nothing, so no key, value or thrown message of the
 * refused value survives into the rejection.
 *
 * @param label The artifact label.
 * @param admits The stage's guard.
 * @param structural The representable schema of the admitted value.
 * @returns The authoring schema.
 */
function guarded<T extends z.ZodType>(
  label: string,
  admits: (value: unknown) => boolean,
  structural: T,
): z.ZodPreprocess<T> {
  const message = `expected ${label}`;
  return z.preprocess((value: unknown, context) => {
    if (admitted(admits, value) && isPlainJsonData(value)) {
      return value;
    }
    context.addIssue({ code: 'custom', message });
    return z.NEVER;
  }, structural);
}

/* -------------------------------------------------------------------------------------------------
 * Query proposals, generated from the tool catalog
 * ---------------------------------------------------------------------------------------------- */

/** The error a proposal naming no catalogued tool reads, at its `tool` path. */
const UNKNOWN_TOOL_MESSAGE = `expected "tool" to name one of the catalogued tools: ${CODE_TOOL_NAMES.join(', ')}`;

/**
 * A closed vocabulary as the non-empty tuple an enumeration schema needs, or
 * `undefined` for an empty one.
 *
 * @param values The vocabulary.
 * @returns The tuple, without a cast.
 */
function nonEmpty(values: readonly string[]): readonly [string, ...string[]] | undefined {
  const [first, ...rest] = values;
  return first === undefined ? undefined : [first, ...rest];
}

/**
 * One string argument: an enumeration of its closed vocabulary when the
 * catalog declares one, any string otherwise.
 *
 * An empty declared vocabulary would be a descriptor defect; the argument then
 * stays a plain string (the schema stays renderable) and the parser refuses
 * every value it receives, as evidence.
 *
 * @param allowed The declared vocabulary, when there is one.
 * @returns The value schema.
 */
function stringValue(allowed: readonly string[] | undefined): z.ZodType {
  const members = allowed === undefined ? undefined : nonEmpty(allowed);
  return members === undefined ? z.string() : z.enum(members);
}

/**
 * The selector form of a `pathBetween` endpoint. Its keys are exactly the ones
 * the parser reads (`readEndpoint` in `../tools/code-tools.ts`); that at least
 * one is present is a value rule the parser keeps.
 *
 * **One instance, shared by every endpoint argument.** The platform counts the
 * optional parameters of a schema-constrained format against a fixed budget
 * (24, "Schemas contains too many optional parameters (28) … (limit: 24)"
 * when exceeded) and refuses a format whose compiled grammar grows too large.
 * A shared instance renders as one referenced definition, so the two endpoints
 * of `pathBetween` spend its four optional keys once; two instances would
 * spend them twice and push the reply past the budget.
 */
const ENDPOINT_SELECTOR = z.object({
  file: z.string().optional(),
  symbol: z.string().optional(),
  name: z.string().optional(),
  kind: z.enum(CODE_NODE_KINDS).optional(),
});

/**
 * The `pathBetween` endpoint: a `nodeId` string from an earlier result, or
 * {@link ENDPOINT_SELECTOR}.
 */
function endpointValue(): z.ZodType {
  return z.union([z.string(), ENDPOINT_SELECTOR]);
}

/**
 * The value schema of one catalogued argument, by its catalog type word.
 * Total over `CodeToolArgumentType` by its `switch`; values are left unbounded
 * (see the module documentation).
 *
 * **No descriptions.** Every tool and argument is already described to the
 * model by the prompt's `{{toolCatalog}}`, generated from the same
 * descriptors. A description attached to a schema node is metadata that the
 * JSON Schema renderer emits as a separate referenced definition per node,
 * and that indirection alone was measured to push this reply's compiled
 * grammar past the platform's size limit on the schema-constrained route, so
 * none is attached here.
 *
 * @param argument The argument's descriptor.
 * @returns Its schema.
 */
function argumentValue(argument: CodeToolArgumentDescriptor): z.ZodType {
  let value: z.ZodType;
  switch (argument.type) {
    case 'string':
      value = stringValue(argument.allowed);
      break;
    case 'integer':
      value = z.number().int();
      break;
    case 'boolean':
      value = z.boolean();
      break;
    case 'string[]':
      value = z.array(stringValue(argument.allowed));
      break;
    case 'endpoint':
      value = endpointValue();
      break;
  }
  return argument.required ? value : value.optional();
}

/**
 * The proposal branch of one catalogued tool: `tool` fixed to its name, and one
 * key per catalogued argument. A plain (stripping) object, so an undeclared key
 * is dropped exactly as the parser drops it; the rendered format forbids
 * undeclared keys to the model regardless.
 *
 * @param name The tool.
 * @returns The branch; undescribed for the reason {@link argumentValue} gives.
 */
function proposalBranch(name: CodeToolName): z.ZodObject {
  const descriptor: CodeToolDescriptor = CODE_TOOL_DESCRIPTORS[name];
  const shape: Record<string, z.ZodType> = {};
  for (const argument of descriptor.args) {
    shape[argument.name] = argumentValue(argument);
  }
  return z.object({ tool: z.literal(name), ...shape });
}

/**
 * One proposed query: a discriminated union on `tool` with a branch per
 * catalogued tool, in catalog order. A proposal naming no catalogued tool is
 * refused at its `tool` path with {@link UNKNOWN_TOOL_MESSAGE}, which lists the
 * catalogue and quotes nothing from the proposal.
 */
function proposalItem(): z.ZodType {
  const [firstName, ...restNames] = CODE_TOOL_NAMES;
  const branches: [z.ZodObject, ...z.ZodObject[]] = [
    proposalBranch(firstName),
    ...restNames.map(proposalBranch),
  ];
  return z.discriminatedUnion('tool', branches, { error: UNKNOWN_TOOL_MESSAGE });
}

/* -------------------------------------------------------------------------------------------------
 * The factories
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the authoring schema of one investigation turn (AAP §0.4.2, §0.5.3):
 * a query batch or the final investigation, admitted by the stage's total guard
 * and then parsed by a representable structural schema.
 *
 * The structural half is one strict object whose keys are all optional —
 * `INVESTIGATE_QUERY_BATCH_FIELD`, `relevantFiles` and `flows` — because the
 * structured-output format needs an object root rather than a union of two;
 * that exactly one key set is present, and every bound of the artifact, is the
 * guard's (`isQueryBatch` / `isCodeInvestigation`), which runs first. The
 * shortlist is protocol's own `SessionRecord.relevantFiles` schema, so the
 * document the model is constrained by and the store's schema are one.
 *
 * A parse returns a structurally equal copy of the admitted reply, with the
 * undeclared keys of each proposal dropped.
 *
 * @param options The stage's label, guard and bounds.
 * @returns The schema to hand `generateStructuredWithRepair`.
 * @throws {DebuggenError} `INTERNAL` at construction for a blank label or a bound that is not a positive integer.
 *
 * @example
 * ```ts
 * export const investigateReplySchema = buildInvestigateReplySchema({
 *   label: INVESTIGATE_REPLY_LABEL,
 *   admits: isInvestigateReply,
 *   maxQueries: MAX_PROPOSED_QUERIES,
 *   maxFlows: MAX_FLOWS,
 *   maxFlowChars: MAX_FLOW_CHARS,
 * });
 * ```
 */
export function buildInvestigateReplySchema(options: InvestigateReplySchemaOptions) {
  requireOption(options.label.trim().length > 0, 'label');
  requireOption(isPositiveBound(options.maxQueries), 'maxQueries');
  requireOption(isPositiveBound(options.maxFlows), 'maxFlows');
  requireOption(isPositiveBound(options.maxFlowChars), 'maxFlowChars');

  const structural = z.strictObject({
    [INVESTIGATE_QUERY_BATCH_FIELD]: z
      .array(proposalItem())
      .min(1)
      .max(options.maxQueries)
      .optional(),
    relevantFiles: sessionRecordSchema.shape.relevantFiles.optional(),
    flows: z.array(z.string().min(1).max(options.maxFlowChars)).max(options.maxFlows).optional(),
  });
  return guarded(options.label, options.admits, structural);
}

/**
 * Builds the authoring schema of the follow-up decision (AAP §0.4.2 Follow-up
 * row, `FollowUpDecision { needsNewCapture, additionalActions }` "(Zod)";
 * §0.5.3), admitted by the stage's total guard and then parsed by a
 * representable structural schema.
 *
 * Each addition is `@debuggen/instrumentation`'s authoring target or resolved
 * action schema, reused rather than restated. Both are strict objects with
 * disjoint key sets, so the union never re-reads a resolved action as a target.
 * A parse returns a structurally equal copy of the admitted decision.
 *
 * @param options The stage's label, guard and bound.
 * @returns The schema to hand `generateStructuredWithRepair`.
 * @throws {DebuggenError} `INTERNAL` at construction for a blank label or a bound that is not a positive integer.
 *
 * @example
 * ```ts
 * export const followUpDecisionSchema = buildFollowUpDecisionSchema({
 *   label: FOLLOW_UP_DECISION_LABEL,
 *   admits: isFollowUpDecision,
 *   maxAdditionalActions: MAX_FOLLOW_UP_ADDITIONAL_ACTIONS,
 * });
 * ```
 */
export function buildFollowUpDecisionSchema(options: FollowUpDecisionSchemaOptions) {
  requireOption(options.label.trim().length > 0, 'label');
  requireOption(isPositiveBound(options.maxAdditionalActions), 'maxAdditionalActions');

  const structural = z.strictObject({
    needsNewCapture: z.boolean(),
    additionalActions: z
      .array(z.union([instrumentationTargetInputSchema, instrumentationActionSchema]))
      .max(options.maxAdditionalActions),
  });
  return guarded(options.label, options.admits, structural);
}
