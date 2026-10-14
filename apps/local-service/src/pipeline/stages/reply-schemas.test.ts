/**
 * Colocated suite for `./reply-schemas.ts`: the authoring schemas of the code
 * investigation turn and the follow-up decision (AAP §0.4.2, §0.5.3).
 *
 * ## What this file pins
 *
 * 1. **Representability, against the real renderers.** Both stage schemas are
 *    driven through `createAnthropicProvider` over a fake transport, so the
 *    platform SDK's own `zodOutputFormat` (bundled in the model-provider build)
 *    and the forced tool route's renderer run for real: the schema-constrained
 *    route sends a `json_schema` format with an object root, the tool route
 *    declares an object `input_schema`, and both return the answer validated.
 * 2. **No drift from the tool catalog.** Every tool of `CODE_TOOL_NAMES` and
 *    every argument of `CODE_TOOL_DESCRIPTORS` appears in the rendered proposal
 *    branches, with the catalog's required arguments required.
 * 3. **The guard decides first.** Every value `isInvestigateReply` refuses is
 *    refused with the single root line `expected <label>`, quoting nothing; no
 *    hostile value makes a parse throw. A value the guard admits is parsed only
 *    when it is plain JSON data all the way down, so a hostile part the guard
 *    does not judge — an accessor, proxy, cyclic or over-deep proposal — is
 *    refused with the same line rather than thrown out of `safeParse`.
 * 4. **Structure at the schema, values at the parser.** A proposal that is not
 *    a catalogued tool call is a schema rejection at its own path; a proposal
 *    that is structurally sound but carries a bad value passes the schema and
 *    is refused by `parseCodeToolRequest`, as evidence.
 * 5. **The deterministic provider's replies still validate.**
 * 6. **The factories refuse unusable options at construction.**
 *
 * Everything is in-process: a fake Anthropic client that records what it was
 * sent, and the real deterministic provider. No network, no filesystem.
 * Fixtures use invented, generic vocabulary only.
 */

import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

import {
  PROBLEM_CATEGORIES,
  CAPTURE_SIGNALS,
  TARGETLESS_FILE,
  TARGETLESS_SYMBOL,
} from '@debuggen/instrumentation';
import {
  createAnthropicProvider,
  createDeterministicProvider,
  generateStructuredWithRepair,
  type AnthropicClientLike,
  type AnthropicMessageLike,
  type AnthropicMessageParamsLike,
  type AnthropicStructuredOutputMode,
  type JsonObject,
  type ModelRequest,
  type PromptStage,
} from '@debuggen/model-provider';
import { DebuggenError } from '@debuggen/shared';

import { INVESTIGATE_QUERY_BATCH_FIELD } from '../context-builder.js';
import {
  CODE_TOOL_DESCRIPTORS,
  CODE_TOOL_LIMITS,
  CODE_TOOL_NAMES,
  parseCodeToolRequest,
  type CodeToolName,
} from '../tools/code-tools.js';
import {
  FOLLOW_UP_DECISION_SCHEMA_NAME,
  MAX_FOLLOW_UP_ADDITIONAL_ACTIONS,
  followUpDecisionSchema,
  isFollowUpDecision,
} from './followup.js';
import {
  codeInvestigationSchema,
  investigateReplySchema,
  isCodeInvestigation,
  isInvestigateReply,
} from './investigate.js';
import { buildFollowUpDecisionSchema, buildInvestigateReplySchema } from './reply-schemas.js';

// ---------------------------------------------------------------------------
// Fixtures — invented, generic vocabulary
// ---------------------------------------------------------------------------

/** A token planted in rejected values; no rejection may carry it. */
const SENTINEL = 'nebulaquillsentinel';

const CHART_FILE = 'src/panels/StarChartPanel.tsx';
const CHART_COMPONENT = 'StarChartPanel';
const MATH_FILE = 'src/lib/orbit-math.ts';
const MATH_SYMBOL = 'projectOrbit';
const ROUTE_PATH = '/observatory/readings';

/** One structurally valid proposal per catalogued tool. */
const VALID_PROPOSALS: Readonly<Record<CodeToolName, Readonly<Record<string, unknown>>>> = {
  findByName: { tool: 'findByName', name: CHART_COMPONENT, kinds: ['component'], limit: 5 },
  findSymbol: { tool: 'findSymbol', file: MATH_FILE, symbol: MATH_SYMBOL },
  whoCalls: { tool: 'whoCalls', symbol: MATH_SYMBOL, useReferences: true },
  routeForUrl: { tool: 'routeForUrl', url: ROUTE_PATH },
  handlersFor: { tool: 'handlersFor', url: ROUTE_PATH, method: 'GET' },
  componentsRendering: { tool: 'componentsRendering', component: CHART_COMPONENT },
  pathBetween: {
    tool: 'pathBetween',
    from: { name: CHART_COMPONENT, kind: 'component' },
    to: 'node-id-from-an-earlier-result',
    direction: 'out',
    maxDepth: 4,
  },
  excerpt: { tool: 'excerpt', file: CHART_FILE, line: 10, contextLines: 2 },
};

/** A batch proposing one query per catalogued tool, in catalog order. */
const EVERY_TOOL_BATCH = {
  [INVESTIGATE_QUERY_BATCH_FIELD]: CODE_TOOL_NAMES.map((name) => VALID_PROPOSALS[name]),
};

/** A valid final investigation. */
const INVESTIGATION = {
  relevantFiles: [
    {
      file: CHART_FILE,
      symbol: CHART_COMPONENT,
      reason: 'Renders the chart and starts the plot request.',
      score: 0.9,
    },
    { file: MATH_FILE, reason: 'Computes the plotted points.', score: 0.4 },
  ],
  flows: [`${CHART_COMPONENT} → ${MATH_SYMBOL}`],
};

/** A valid follow-up decision in both addition forms. */
const DECISION = {
  needsNewCapture: true,
  additionalActions: [
    {
      file: TARGETLESS_FILE,
      symbol: TARGETLESS_SYMBOL,
      type: 'fetch-tracking',
      rationale: 'See whether the plot request repeats.',
    },
    {
      id: 'act_0000000000000050',
      file: MATH_FILE,
      symbol: MATH_SYMBOL,
      type: 'function-timing',
      adapter: 'source-probe',
      mode: 'patch',
      rationale: 'Time the projection.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A plain object view of an unknown value, or a test failure. */
function objectOf(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${what} to be an object.`);
  }
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));
  return record;
}

/** A list view of an unknown value, or a test failure. */
function listOf(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${what} to be a list.`);
  }
  const list: readonly unknown[] = value;
  return list;
}

/** The issues of a failed parse, as plain data, or a test failure when the parse succeeded. */
function issuesOf(parsed: {
  readonly success: boolean;
  readonly error?: { readonly issues: readonly unknown[] } | undefined;
}): readonly Readonly<Record<string, unknown>>[] {
  if (parsed.success || parsed.error === undefined) {
    throw new Error('Expected the parse to fail.');
  }
  return parsed.error.issues.map((issue) => objectOf(issue, 'an issue'));
}

/** The dotted path of an issue. */
function pathOf(issue: Readonly<Record<string, unknown>>): string {
  return listOf(issue['path'], 'an issue path')
    .map((segment) => String(segment))
    .join('.');
}

/** The one root line every guard refusal of the investigate reply schema reads. */
function investigateRefusalLine(): string {
  const [issue] = issuesOf(investigateReplySchema.safeParse(null));
  const message = issue?.['message'];
  if (typeof message !== 'string') {
    throw new Error('Expected the refusal to carry a message.');
  }
  return message;
}

/**
 * A request the outbound guard clears: a neutral prompt, an empty structured
 * context and the provenance of the given stage.
 */
function requestFor(stage: PromptStage, input: JsonObject = {}): ModelRequest {
  return {
    prompt: 'Answer with the structured reply the schema describes.',
    input,
    metadata: { stage, promptVersion: 'v001' },
  };
}

// ---------------------------------------------------------------------------
// The fake transport under the real provider
// ---------------------------------------------------------------------------

/** What the fake client was sent, per method. */
interface RecordedCalls {
  readonly parse: AnthropicMessageParamsLike[];
  readonly create: AnthropicMessageParamsLike[];
}

/** The name of the first tool a request declares, or a test failure. */
function declaredToolName(params: AnthropicMessageParamsLike): string {
  const [tool] = listOf(params.tools, 'the declared tools');
  const name = objectOf(tool, 'the declared tool')['name'];
  if (typeof name !== 'string') {
    throw new Error('Expected the declared tool to carry a name.');
  }
  return name;
}

/**
 * A client that answers every call with `answer`: as JSON text on the
 * schema-constrained route, and as the forced tool's arguments on the tool
 * route. Every request is recorded unaltered.
 */
function fakeClient(answer: unknown, recorded: RecordedCalls): AnthropicClientLike {
  return {
    messages: {
      create: (params): Promise<AnthropicMessageLike> => {
        recorded.create.push(params);
        return Promise.resolve({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call_reply_schema',
              name: declaredToolName(params),
              input: answer,
            },
          ],
        });
      },
      parse: (params): Promise<AnthropicMessageLike> => {
        recorded.parse.push(params);
        return Promise.resolve({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(answer) }],
        });
      },
    },
  };
}

/** One structured call through the real Anthropic provider, pinned to one route. */
async function throughProvider<T>(
  schema: ZodType<T>,
  stage: PromptStage,
  answer: unknown,
  mode: Exclude<AnthropicStructuredOutputMode, 'auto'>,
): Promise<{ readonly value: unknown; readonly recorded: RecordedCalls }> {
  const recorded: RecordedCalls = { parse: [], create: [] };
  const created = createAnthropicProvider({
    config: { providerId: 'anthropic', model: 'test-model' },
    client: fakeClient(answer, recorded),
    structuredOutputMode: mode,
  });
  if (!created.ok) {
    throw new Error(`The provider refused construction: ${created.error.code}`);
  }
  const attempt = await created.value.generateStructured(schema, requestFor(stage));
  if (!attempt.ok) {
    const condition = attempt.error.details?.['condition'];
    throw new Error(
      `The ${mode} route failed with ${attempt.error.code} (${String(condition)}): ${attempt.error.message}`,
    );
  }
  return { value: attempt.value.value, recorded };
}

/** The JSON Schema the schema-constrained route sent, or a test failure. */
function sentFormatSchema(recorded: RecordedCalls): Readonly<Record<string, unknown>> {
  expect(recorded.parse).toHaveLength(1);
  expect(recorded.create).toHaveLength(0);
  const [call] = recorded.parse;
  const format = objectOf(objectOf(call?.output_config, 'output_config')['format'], 'the format');
  expect(format['type']).toBe('json_schema');
  return objectOf(format['schema'], 'the format schema');
}

/** The tool `input_schema` the forced tool route declared, or a test failure. */
function sentToolSchema(recorded: RecordedCalls): Readonly<Record<string, unknown>> {
  expect(recorded.create).toHaveLength(1);
  expect(recorded.parse).toHaveLength(0);
  const [call] = recorded.create;
  const tools = listOf(call?.tools, 'the declared tools');
  expect(tools).toHaveLength(1);
  return objectOf(objectOf(tools[0], 'the tool')['input_schema'], 'the input schema');
}

// ---------------------------------------------------------------------------
// Reading a rendered document
// ---------------------------------------------------------------------------

/** Follows a local `#/$defs/…` or `#/definitions/…` reference, when the node is one. */
function resolved(
  node: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const reference = node['$ref'];
  if (typeof reference !== 'string') {
    return node;
  }
  const [, section, name] = /^#\/(\$defs|definitions)\/(.+)$/u.exec(reference) ?? [];
  if (section === undefined || name === undefined) {
    throw new Error('Expected a local reference.');
  }
  return resolved(objectOf(objectOf(root[section], section)[name], name), root);
}

/** The alternatives of a union node, whichever keyword the renderer used. */
function alternativesOf(
  node: Readonly<Record<string, unknown>>,
  root: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const list = node['oneOf'] ?? node['anyOf'];
  return listOf(list, 'the union alternatives').map((member) =>
    resolved(objectOf(member, 'an alternative'), root),
  );
}

/** The constant a literal property renders as (`const`, or a one-member `enum`). */
function literalOf(node: Readonly<Record<string, unknown>>): unknown {
  if ('const' in node) {
    return node['const'];
  }
  const members = node['enum'];
  return Array.isArray(members) && members.length === 1 ? members[0] : undefined;
}

/** The proposal branches of a rendered investigate document, in rendered order. */
function renderedBranchList(
  root: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] {
  const properties = objectOf(root['properties'], 'the root properties');
  const batch = resolved(objectOf(properties[INVESTIGATE_QUERY_BATCH_FIELD], 'the batch'), root);
  const item = resolved(objectOf(batch['items'], 'the batch items'), root);
  return alternativesOf(item, root);
}

/** The proposal branches of an untransformed rendering, keyed by the literal of their `tool`. */
function renderedBranches(
  root: Readonly<Record<string, unknown>>,
): ReadonlyMap<unknown, Readonly<Record<string, unknown>>> {
  const branches = new Map<unknown, Readonly<Record<string, unknown>>>();
  for (const branch of renderedBranchList(root)) {
    const branchProperties = objectOf(branch['properties'], 'the branch properties');
    branches.set(literalOf(resolved(objectOf(branchProperties['tool'], 'tool'), root)), branch);
  }
  return branches;
}

/** The sorted property names and required names of one rendered branch. */
function keysOf(branch: Readonly<Record<string, unknown>> | undefined): {
  readonly declared: readonly string[];
  readonly required: readonly string[];
} {
  const declared = Object.keys(objectOf(branch?.['properties'], 'the branch properties')).sort();
  const required = listOf(branch?.['required'], 'the branch required list')
    .map((key) => String(key))
    .sort();
  return { declared, required };
}

/** The sorted argument names of one tool as the catalog states them, with `tool` itself. */
function cataloguedKeys(name: CodeToolName): {
  readonly declared: readonly string[];
  readonly required: readonly string[];
} {
  const args = CODE_TOOL_DESCRIPTORS[name].args;
  return {
    declared: ['tool', ...args.map((argument) => argument.name)].sort(),
    required: [
      'tool',
      ...args.filter((argument) => argument.required).map((argument) => argument.name),
    ].sort(),
  };
}

// ===========================================================================
// 1. Representability, against the real renderers
// ===========================================================================

describe('the stage reply schemas render for a real provider', () => {
  const investigateAnswers: readonly (readonly [string, unknown])[] = [
    ['a query batch naming every catalogued tool', EVERY_TOOL_BATCH],
    ['the final investigation', INVESTIGATION],
  ];

  it.each(investigateAnswers)(
    'the investigate reply schema is served on the schema-constrained route: %s',
    async (_label, answer) => {
      const { value, recorded } = await throughProvider(
        investigateReplySchema,
        'investigate',
        answer,
        'parse-only',
      );
      const schema = sentFormatSchema(recorded);
      expect(schema['type']).toBe('object');
      expect(Object.keys(objectOf(schema['properties'], 'properties')).sort()).toStrictEqual(
        [INVESTIGATE_QUERY_BATCH_FIELD, 'flows', 'relevantFiles'].sort(),
      );
      expect(value).toStrictEqual(answer);
    },
  );

  it.each(investigateAnswers)(
    'the investigate reply schema is served on the forced tool route: %s',
    async (_label, answer) => {
      const { value, recorded } = await throughProvider(
        investigateReplySchema,
        'investigate',
        answer,
        'tool-only',
      );
      const schema = sentToolSchema(recorded);
      expect(schema['type']).toBe('object');
      expect(value).toStrictEqual(answer);
    },
  );

  it('the follow-up decision schema is served on the schema-constrained route', async () => {
    const { value, recorded } = await throughProvider(
      followUpDecisionSchema,
      'followup',
      DECISION,
      'parse-only',
    );
    const schema = sentFormatSchema(recorded);
    expect(schema['type']).toBe('object');
    expect(Object.keys(objectOf(schema['properties'], 'properties')).sort()).toStrictEqual([
      'additionalActions',
      'needsNewCapture',
    ]);
    expect(value).toStrictEqual(DECISION);
  });

  it('the follow-up decision schema is served on the forced tool route', async () => {
    const { value, recorded } = await throughProvider(
      followUpDecisionSchema,
      'followup',
      DECISION,
      'tool-only',
    );
    const schema = sentToolSchema(recorded);
    expect(schema['type']).toBe('object');
    expect(schema['required']).toStrictEqual(['needsNewCapture', 'additionalActions']);
    expect(value).toStrictEqual(DECISION);
  });
});

// ===========================================================================
// 1b. The platform's grammar budget, on the format actually sent
// ===========================================================================

/**
 * The platform refuses a schema-constrained format whose schemas together hold
 * more than 24 optional parameters ("Schemas contains too many optional
 * parameters (28) … (limit: 24)") or more than 16 union-typed parameters, and
 * one whose compiled grammar grows too large. Both limits are counted over the
 * rendered document with every referenced definition counted once, which is
 * how a shared schema instance spends its budget.
 */
const PLATFORM_OPTIONAL_PARAMETER_LIMIT = 24;
const PLATFORM_UNION_PARAMETER_LIMIT = 16;

/** Optional and union-typed parameters of a rendered format, each definition counted once. */
function grammarBudgetOf(root: Readonly<Record<string, unknown>>): {
  readonly optional: number;
  readonly unions: number;
  readonly definitions: number;
} {
  let optional = 0;
  let unions = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const member of node as readonly unknown[]) {
        visit(member);
      }
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    const record = node as Readonly<Record<string, unknown>>;
    const properties = record['properties'];
    if (typeof properties === 'object' && properties !== null) {
      const required = new Set(
        Array.isArray(record['required'])
          ? (record['required'] as readonly unknown[]).map(String)
          : [],
      );
      for (const [key, property] of Object.entries(properties)) {
        if (!required.has(key)) {
          optional += 1;
        }
        const target =
          typeof property === 'object' && property !== null
            ? resolved(property as Readonly<Record<string, unknown>>, root)
            : undefined;
        if (target !== undefined && ('anyOf' in target || Array.isArray(target['type']))) {
          unions += 1;
        }
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== '$defs' && key !== 'definitions') {
        visit(value);
      }
    }
  };
  visit(root);
  const definitions = objectOf(root['$defs'] ?? {}, 'the definitions');
  for (const definition of Object.values(definitions)) {
    visit(definition);
  }
  return { optional, unions, definitions: Object.keys(definitions).length };
}

describe('the schema-constrained formats stay inside the platform grammar budget', () => {
  it.each([
    ['the investigate reply', investigateReplySchema, 'investigate', EVERY_TOOL_BATCH],
    ['the follow-up decision', followUpDecisionSchema, 'followup', DECISION],
  ] as const)('%s', async (_label, schema, stage, answer) => {
    const { recorded } = await throughProvider(
      schema as ZodType<unknown>,
      stage,
      answer,
      'parse-only',
    );
    const budget = grammarBudgetOf(sentFormatSchema(recorded));
    expect(budget.optional).toBeLessThanOrEqual(PLATFORM_OPTIONAL_PARAMETER_LIMIT);
    expect(budget.unions).toBeLessThanOrEqual(PLATFORM_UNION_PARAMETER_LIMIT);
  });

  it('shares one endpoint selector definition between both pathBetween endpoints', async () => {
    const { recorded } = await throughProvider(
      investigateReplySchema,
      'investigate',
      EVERY_TOOL_BATCH,
      'parse-only',
    );
    const root = sentFormatSchema(recorded);
    const pathBetween = renderedBranchList(root).find((branch) => {
      const properties = objectOf(branch['properties'], 'the branch properties');
      return 'from' in properties && 'to' in properties;
    });
    const properties = objectOf(pathBetween?.['properties'], 'the pathBetween properties');
    /** The reference each endpoint's object alternative is written as, unresolved. */
    const selectorReferenceOf = (key: string): unknown => {
      const endpoint = resolved(objectOf(properties[key], key), root);
      const members = listOf(endpoint['anyOf'], `the ${key} alternatives`).map((member) =>
        objectOf(member, 'an alternative'),
      );
      const selector = members.find((member) => resolved(member, root)['type'] === 'object');
      return selector?.['$ref'];
    };
    expect(typeof selectorReferenceOf('from')).toBe('string');
    expect(selectorReferenceOf('from')).toBe(selectorReferenceOf('to'));
  });
});

// ===========================================================================
// 2. No drift from the tool catalog
// ===========================================================================

describe('the rendered proposal branches are the tool catalog', () => {
  it('declares one branch per catalogued tool on the tool route, each with the catalog’s arguments', async () => {
    const { recorded } = await throughProvider(
      investigateReplySchema,
      'investigate',
      EVERY_TOOL_BATCH,
      'tool-only',
    );
    const branches = renderedBranches(sentToolSchema(recorded));

    expect([...branches.keys()]).toStrictEqual([...CODE_TOOL_NAMES]);
    for (const name of CODE_TOOL_NAMES) {
      expect(keysOf(branches.get(name)), name).toStrictEqual(cataloguedKeys(name));
    }
  });

  it('declares the same branches, in catalog order, on the schema-constrained route', async () => {
    // The platform helper strips the keywords its format does not support
    // (AAP §0.2.4) — the tool literal and the enumerations among them — so the
    // branches are matched by position and key set here; the local parse is
    // what enforces every stripped keyword on either route.
    const { recorded } = await throughProvider(
      investigateReplySchema,
      'investigate',
      EVERY_TOOL_BATCH,
      'parse-only',
    );
    const branches = renderedBranchList(sentFormatSchema(recorded));

    expect(branches).toHaveLength(CODE_TOOL_NAMES.length);
    for (const [index, name] of CODE_TOOL_NAMES.entries()) {
      expect(keysOf(branches[index]), name).toStrictEqual(cataloguedKeys(name));
      expect(branches[index]?.['additionalProperties'], name).toBe(false);
    }
  });

  it('renders each closed vocabulary the catalog declares as an enumeration', async () => {
    const { recorded } = await throughProvider(
      investigateReplySchema,
      'investigate',
      EVERY_TOOL_BATCH,
      'tool-only',
    );
    const root = sentToolSchema(recorded);
    const branches = renderedBranches(root);
    let vocabularies = 0;
    for (const name of CODE_TOOL_NAMES) {
      const properties = objectOf(branches.get(name)?.['properties'], `the ${name} properties`);
      for (const argument of CODE_TOOL_DESCRIPTORS[name].args) {
        if (argument.allowed === undefined) {
          continue;
        }
        vocabularies += 1;
        const rendered = resolved(objectOf(properties[argument.name], argument.name), root);
        const values =
          argument.type === 'string[]'
            ? resolved(objectOf(rendered['items'], `${argument.name} items`), root)
            : rendered;
        expect(values['enum'], `${name}.${argument.name}`).toStrictEqual([...argument.allowed]);
      }
    }
    expect(vocabularies).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3. The guard decides first
// ===========================================================================

describe('the investigate reply schema refuses what the guard refuses, quoting nothing', () => {
  const tooMany = Array.from(
    { length: CODE_TOOL_LIMITS.maxCallsPerStage + 1 },
    () => VALID_PROPOSALS.findByName,
  );
  const hostileProxy = new Proxy(
    {},
    {
      ownKeys: () => {
        throw new Error('hostile ownKeys');
      },
      getOwnPropertyDescriptor: () => {
        throw new Error('hostile descriptor');
      },
      getPrototypeOf: () => Object.prototype,
    },
  );
  const throwingGetter = Object.defineProperty({ flows: [] }, 'relevantFiles', {
    enumerable: true,
    get: () => {
      throw new Error('the getter must never run');
    },
  });

  const refused: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', SENTINEL],
    ['a number', 42],
    ['an array', [INVESTIGATION]],
    ['an empty object', {}],
    ['an empty batch', { [INVESTIGATE_QUERY_BATCH_FIELD]: [] }],
    ['an over-long batch', { [INVESTIGATE_QUERY_BATCH_FIELD]: tooMany }],
    ['both key sets at once', { ...INVESTIGATION, ...EVERY_TOOL_BATCH }],
    ['an investigation without flows', { relevantFiles: INVESTIGATION.relevantFiles }],
    ['a blank flow', { ...INVESTIGATION, flows: ['   '] }],
    [
      'an unsafe shortlist path',
      {
        ...INVESTIGATION,
        relevantFiles: [{ file: `../${SENTINEL}.ts`, reason: 'Outside.', score: 0.5 }],
      },
    ],
    ['an unknown top-level key', { ...INVESTIGATION, notes: SENTINEL }],
    ['prose only', { [SENTINEL]: SENTINEL, notes: `I would rather explain ${SENTINEL}.` }],
    ['a null-prototype object', Object.assign(Object.create(null) as object, INVESTIGATION)],
    ['a throwing getter', throwingGetter],
    ['a proxy whose traps throw', hostileProxy],
  ];

  it('every fixture is one the guard refuses', () => {
    for (const [label, value] of refused) {
      expect(isInvestigateReply(value), label).toBe(false);
    }
  });

  it.each(refused)('refuses %s with the one root line, and never throws', (_label, value) => {
    expect(() => investigateReplySchema.safeParse(value)).not.toThrow();
    const issues = issuesOf(investigateReplySchema.safeParse(value));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.['code']).toBe('custom');
    expect(issues[0]?.['path']).toStrictEqual([]);
    expect(issues[0]?.['message']).toBe(investigateRefusalLine());
    expect(Object.keys(issues[0] ?? {})).not.toContain('input');
    expect(JSON.stringify(issues)).not.toContain(SENTINEL);
  });

  it('reads as the label written for the model, naming both key sets', () => {
    const line = investigateRefusalLine();
    expect(line.startsWith('expected ')).toBe(true);
    for (const key of [INVESTIGATE_QUERY_BATCH_FIELD, 'relevantFiles', 'flows']) {
      expect(line).toContain(`"${key}"`);
    }
  });

  it('accepts exactly the investigations the artifact guard accepts, returning an equal copy', () => {
    const accepted: readonly unknown[] = [
      INVESTIGATION,
      { relevantFiles: [], flows: [] },
      { relevantFiles: INVESTIGATION.relevantFiles, flows: [] },
    ];
    for (const value of accepted) {
      expect(isCodeInvestigation(value)).toBe(true);
      expect(codeInvestigationSchema.safeParse(value).success).toBe(true);
      const parsed = investigateReplySchema.safeParse(value);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toStrictEqual(value);
    }
  });
});

describe('a reply the guard admits is parsed only when it is plain data all the way down', () => {
  /** A batch whose proposal list is `proposals`, which the batch guard admits by its length alone. */
  const batchWith = (...proposals: readonly unknown[]): unknown => ({
    [INVESTIGATE_QUERY_BATCH_FIELD]: proposals,
  });

  /** A batch whose first proposal is an accessor of the list, not a data element. */
  function accessorElement(): unknown {
    const proposals: unknown[] = [];
    Object.defineProperty(proposals, 0, {
      enumerable: true,
      get: () => {
        throw new Error(SENTINEL);
      },
    });
    return { [INVESTIGATE_QUERY_BATCH_FIELD]: proposals };
  }

  /** A proposal whose `tool` is a getter that throws a message carrying the sentinel. */
  const throwingTool = Object.defineProperty({ name: CHART_COMPONENT }, 'tool', {
    enumerable: true,
    get: () => {
      throw new Error(SENTINEL);
    },
  });

  /**
   * A proxy over a well-formed proposal whose descriptor and prototype traps
   * forward faithfully — so a descriptor-only inspection sees plain data — but
   * whose `get` trap throws the sentinel on the first property read.
   */
  const readTrapProxy = new Proxy(
    { ...VALID_PROPOSALS.findByName },
    {
      get: () => {
        throw new Error(SENTINEL);
      },
    },
  );

  /** A proxy whose every trap throws, and one that has been revoked. */
  const trapEverything = new Proxy(
    {},
    {
      get: () => {
        throw new Error(SENTINEL);
      },
      getPrototypeOf: () => {
        throw new Error(SENTINEL);
      },
      ownKeys: () => {
        throw new Error(SENTINEL);
      },
      getOwnPropertyDescriptor: () => {
        throw new Error(SENTINEL);
      },
      has: () => {
        throw new Error(SENTINEL);
      },
    },
  );
  const revocable = Proxy.revocable({ ...VALID_PROPOSALS.findByName }, {});
  revocable.revoke();

  /** A proposal that holds itself. */
  function cyclicProposal(): unknown {
    const proposal: Record<string, unknown> = { ...VALID_PROPOSALS.findByName };
    proposal['self'] = proposal;
    return proposal;
  }

  /** A proposal carrying an extra key nested `depth` objects deep. */
  function deepProposal(depth: number): unknown {
    let nested: unknown = SENTINEL;
    for (let level = 0; level < depth; level += 1) {
      nested = { [SENTINEL]: nested };
    }
    return { ...VALID_PROPOSALS.findByName, extra: nested };
  }

  /**
   * A proposal whose extra key is a shared-reference ladder: every rung holds
   * the next one under two keys, so a walk that followed every reference would
   * visit 2^depth values although only `depth` objects exist.
   */
  function fanOutProposal(depth: number): unknown {
    let rung: unknown = SENTINEL;
    for (let level = 0; level < depth; level += 1) {
      rung = { left: rung, right: rung };
    }
    return { ...VALID_PROPOSALS.findByName, extra: rung };
  }

  const hostile: readonly (readonly [string, unknown])[] = [
    ['an accessor element of the proposal list', accessorElement()],
    ['a proposal whose tool getter throws', batchWith(throwingTool)],
    ['a proxy proposal whose read trap throws', batchWith(readTrapProxy)],
    ['a proxy proposal whose every trap throws', batchWith(trapEverything)],
    ['a revoked proxy proposal', batchWith(revocable.proxy)],
    ['a proxy proposal list', { [INVESTIGATE_QUERY_BATCH_FIELD]: new Proxy([readTrapProxy], {}) }],
    ['a cyclic proposal', batchWith(cyclicProposal())],
    ['an over-deep proposal', batchWith(deepProposal(40))],
    ['a shared-reference fan-out proposal', batchWith(fanOutProposal(28))],
    [
      'a proposal holding a class instance',
      batchWith({ ...VALID_PROPOSALS.findByName, at: new Date(0) }),
    ],
    [
      'a proposal holding a non-finite number',
      batchWith({ ...VALID_PROPOSALS.findByName, limit: Number.NaN }),
    ],
    [
      'a proposal holding undefined',
      batchWith({ ...VALID_PROPOSALS.findByName, kinds: undefined }),
    ],
    [
      'a proposal with a symbol key',
      batchWith({ ...VALID_PROPOSALS.findByName, [Symbol(SENTINEL)]: 1 }),
    ],
  ];

  it('every fixture is one the stage guard admits, so the plain-data check is what refuses it', () => {
    for (const [label, value] of hostile) {
      expect(isInvestigateReply(value), label).toBe(true);
    }
  });

  it.each(hostile)(
    'refuses %s with the one root line, never throwing and never quoting the getter',
    (_label, value) => {
      let parsed: ReturnType<typeof investigateReplySchema.safeParse> | undefined;
      expect(() => {
        parsed = investigateReplySchema.safeParse(value);
      }).not.toThrow();
      if (parsed === undefined) {
        throw new Error('Expected a parse result.');
      }
      expect(parsed.success).toBe(false);
      const issues = issuesOf(parsed);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.['code']).toBe('custom');
      expect(issues[0]?.['path']).toStrictEqual([]);
      expect(issues[0]?.['message']).toBe(investigateRefusalLine());
      expect(Object.keys(issues[0] ?? {})).not.toContain('input');
      expect(JSON.stringify(issues)).not.toContain(SENTINEL);
    },
  );

  it('refuses the fan-out proposal without walking every path through it', () => {
    // Inside the depth bound, so only the value budget can stop the walk: 2^28
    // paths through 28 objects.
    const started = performance.now();
    expect(investigateReplySchema.safeParse(batchWith(fanOutProposal(28))).success).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('refuses a follow-up decision that is not plain data with the one root line', () => {
    // The follow-up guard reads descriptors, which this proxy forwards, so it
    // admits the decision; reading an element through the proxy throws.
    const additionalActions = new Proxy([...DECISION.additionalActions], {
      get: (target, key, receiver) => {
        if (key === 'length') {
          return Reflect.get(target, key, receiver);
        }
        throw new Error(SENTINEL);
      },
    });
    const decision = { needsNewCapture: true, additionalActions };
    expect(isFollowUpDecision(decision)).toBe(true);

    let parsed: ReturnType<typeof followUpDecisionSchema.safeParse> | undefined;
    expect(() => {
      parsed = followUpDecisionSchema.safeParse(decision);
    }).not.toThrow();
    if (parsed === undefined) {
      throw new Error('Expected a parse result.');
    }
    const issues = issuesOf(parsed);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.['path']).toStrictEqual([]);
    expect(issues[0]?.['message']).toBe('expected FollowUpDecision');
    expect(JSON.stringify(issues)).not.toContain(SENTINEL);
  });

  it('changes nothing for plain data: decoded, frozen and null-prototype replies still parse', () => {
    const decoded: unknown = JSON.parse(JSON.stringify(EVERY_TOOL_BATCH));
    expect(investigateReplySchema.safeParse(decoded).data).toStrictEqual(EVERY_TOOL_BATCH);

    const frozen = Object.freeze({
      [INVESTIGATE_QUERY_BATCH_FIELD]: Object.freeze([
        Object.freeze({ ...VALID_PROPOSALS.findSymbol }),
      ]),
    });
    expect(investigateReplySchema.safeParse(frozen).success).toBe(true);

    const bare: unknown = Object.assign(Object.create(null) as object, {
      ...VALID_PROPOSALS.routeForUrl,
    });
    expect(investigateReplySchema.safeParse(batchWith(bare)).success).toBe(true);

    // The same proposal object twice is data, not a cycle.
    const shared = { ...VALID_PROPOSALS.findByName };
    expect(investigateReplySchema.safeParse(batchWith(shared, shared)).success).toBe(true);

    // A proposal nesting well inside the depth bound is still data.
    expect(investigateReplySchema.safeParse(batchWith(deepProposal(8))).success).toBe(true);

    const decision: unknown = JSON.parse(JSON.stringify(DECISION));
    expect(followUpDecisionSchema.safeParse(decision).data).toStrictEqual(DECISION);
  });
});

// ===========================================================================
// 4. Structure at the schema, values at the parser
// ===========================================================================

describe('a batch is accepted only when each proposal is structurally a catalogued tool call', () => {
  /** A batch of the given proposals. */
  const batchOf = (...proposals: readonly unknown[]): unknown => ({
    [INVESTIGATE_QUERY_BATCH_FIELD]: [...proposals],
  });

  it('accepts one call of every catalogued tool, returning an equal copy', () => {
    expect(Object.keys(VALID_PROPOSALS)).toStrictEqual([...CODE_TOOL_NAMES]);
    const parsed = investigateReplySchema.safeParse(EVERY_TOOL_BATCH);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toStrictEqual(EVERY_TOOL_BATCH);
  });

  it('accepts a key a tool does not declare, and drops it as the parser does', () => {
    const untidy = { ...VALID_PROPOSALS.findByName, verbose: true };
    const parsed = investigateReplySchema.safeParse(batchOf(untidy));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toStrictEqual(batchOf(VALID_PROPOSALS.findByName));
  });

  const malformed: readonly (readonly [string, unknown, string])[] = [
    ['a bare string', `findByName ${SENTINEL}`, `${INVESTIGATE_QUERY_BATCH_FIELD}.0`],
    [
      'an unknown tool',
      { tool: SENTINEL, name: SENTINEL },
      `${INVESTIGATE_QUERY_BATCH_FIELD}.0.tool`,
    ],
    ['no tool at all', { name: CHART_COMPONENT }, `${INVESTIGATE_QUERY_BATCH_FIELD}.0.tool`],
    [
      'a missing required argument',
      { tool: 'findByName' },
      `${INVESTIGATE_QUERY_BATCH_FIELD}.0.name`,
    ],
    [
      'a string argument of the wrong type',
      { tool: 'findSymbol', file: SENTINEL, symbol: 7 },
      `${INVESTIGATE_QUERY_BATCH_FIELD}.0.symbol`,
    ],
    [
      'an integer argument that is not a whole number',
      { tool: 'whoCalls', symbol: MATH_SYMBOL, limit: 2.5 },
      `${INVESTIGATE_QUERY_BATCH_FIELD}.0.limit`,
    ],
    [
      'a boolean argument of the wrong type',
      { tool: 'findByName', name: CHART_COMPONENT, exact: 'yes' },
      `${INVESTIGATE_QUERY_BATCH_FIELD}.0.exact`,
    ],
    [
      'a value outside a closed vocabulary',
      { tool: 'handlersFor', url: ROUTE_PATH, method: SENTINEL },
      `${INVESTIGATE_QUERY_BATCH_FIELD}.0.method`,
    ],
    [
      'an endpoint that is neither a node id nor a selector',
      { tool: 'pathBetween', from: 3, to: { name: MATH_SYMBOL } },
      `${INVESTIGATE_QUERY_BATCH_FIELD}.0.from`,
    ],
  ];

  it.each(malformed)(
    'refuses %s at the proposal’s own path, quoting nothing',
    (_label, proposal, path) => {
      // The reply is a batch as far as the guard is concerned: the refusal is structural.
      expect(isInvestigateReply(batchOf(proposal))).toBe(true);
      const issues = issuesOf(investigateReplySchema.safeParse(batchOf(proposal)));
      expect(issues.map(pathOf)).toContain(path);
      expect(JSON.stringify(issues)).not.toContain(SENTINEL);
      for (const issue of issues) {
        expect(Object.keys(issue)).not.toContain('input');
      }
    },
  );

  it('names the catalogue when a proposal names no catalogued tool', () => {
    const issues = issuesOf(investigateReplySchema.safeParse(batchOf({ tool: SENTINEL })));
    const message = String(issues[0]?.['message']);
    for (const name of CODE_TOOL_NAMES) {
      expect(message).toContain(name);
    }
  });

  const valueLevel: readonly (readonly [string, unknown])[] = [
    ['a blank name', { tool: 'findByName', name: '   ' }],
    ['a negative limit', { tool: 'findByName', name: CHART_COMPONENT, limit: -3 }],
    ['an unsafe file path', { tool: 'findSymbol', file: `../${SENTINEL}.ts`, symbol: MATH_SYMBOL }],
    ['a selector naming no field', { tool: 'pathBetween', from: {}, to: { name: MATH_SYMBOL } }],
    ['an excerpt naming neither a node nor a file', { tool: 'excerpt', line: 3 }],
    [
      'an excerpt naming both a node and a file',
      { tool: 'excerpt', nodeId: 'n', file: CHART_FILE },
    ],
    ['an empty kind filter', { tool: 'findByName', name: CHART_COMPONENT, kinds: [] }],
  ];

  it.each(valueLevel)(
    'passes %s to the parser, which refuses it as evidence',
    (_label, proposal) => {
      const parsed = investigateReplySchema.safeParse(batchOf(proposal));
      expect(parsed.success).toBe(true);
      expect(parseCodeToolRequest(proposal).ok).toBe(false);
    },
  );

  it('passes an over-range integer to the parser, which clamps it', () => {
    const proposal = { tool: 'findByName', name: CHART_COMPONENT, limit: 1_000_000 };
    expect(investigateReplySchema.safeParse(batchOf(proposal)).success).toBe(true);
    const request = parseCodeToolRequest(proposal);
    expect(request.ok).toBe(true);
    if (request.ok && request.value.tool === 'findByName') {
      expect(request.value.limit).toBe(CODE_TOOL_LIMITS.maxResultsPerCall);
    }
  });
});

describe('the follow-up decision schema is the guard behind a representable structure', () => {
  it('refuses what the guard refuses with the one root line, and accepts an equal copy of the rest', () => {
    const refusedLine = `expected FollowUpDecision`;
    const values: readonly unknown[] = [
      null,
      { needsNewCapture: 'true', additionalActions: [] },
      { needsNewCapture: true, additionalActions: [{ file: `/${SENTINEL}.ts` }] },
      { ...DECISION, [SENTINEL]: true },
      DECISION,
      { needsNewCapture: false, additionalActions: [] },
    ];
    for (const value of values) {
      const parsed = followUpDecisionSchema.safeParse(value);
      expect(parsed.success).toBe(isFollowUpDecision(value));
      if (parsed.success) {
        expect(parsed.data).toStrictEqual(value);
      } else {
        const issues = issuesOf(parsed);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.['message']).toBe(refusedLine);
        expect(issues[0]?.['path']).toStrictEqual([]);
        expect(JSON.stringify(issues)).not.toContain(SENTINEL);
      }
    }
    expect(FOLLOW_UP_DECISION_SCHEMA_NAME.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 5. The deterministic provider's replies still validate
// ===========================================================================

describe('the deterministic provider answers both stages within the schemas', () => {
  /** The real deterministic provider, or a test failure. */
  function deterministic() {
    const created = createDeterministicProvider();
    if (!created.ok) {
      throw new Error(`The deterministic provider refused construction: ${created.error.code}`);
    }
    return created.value;
  }

  const understanding: JsonObject = {
    category: PROBLEM_CATEGORIES[0],
    signalsNeeded: [CAPTURE_SIGNALS[0]],
    entities: [{ kind: 'component', name: CHART_COMPONENT }],
    searchHints: [],
  };
  const candidates: JsonObject[] = [
    { file: CHART_FILE, symbol: CHART_COMPONENT, kind: 'component' },
  ];

  it('proposes a batch the investigate reply schema accepts while budget remains', async () => {
    const answered = await generateStructuredWithRepair(
      deterministic(),
      investigateReplySchema,
      requestFor('investigate', {
        understanding,
        candidates,
        queryResults: [],
        remainingQueries: 3,
      }),
      { maxRepairs: 0 },
    );
    if (!answered.ok) {
      throw new Error(`Expected a validated reply: ${answered.error.message}`);
    }
    expect(answered.value.repairs).toBe(0);
    expect(objectOf(answered.value.value, 'the reply')).toHaveProperty(
      INVESTIGATE_QUERY_BATCH_FIELD,
    );
  });

  it('emits an investigation the schema accepts once the budget is spent', async () => {
    const answered = await generateStructuredWithRepair(
      deterministic(),
      investigateReplySchema,
      requestFor('investigate', {
        understanding,
        candidates,
        queryResults: [],
        remainingQueries: 0,
      }),
      { maxRepairs: 0 },
    );
    if (!answered.ok) {
      throw new Error(`Expected a validated reply: ${answered.error.message}`);
    }
    expect(isCodeInvestigation(answered.value.value)).toBe(true);
  });

  it('emits a decision the follow-up decision schema accepts', async () => {
    const answered = await generateStructuredWithRepair(
      deterministic(),
      followUpDecisionSchema,
      requestFor('followup', { followUpQuestion: 'Does the request repeat?', understanding }),
      { maxRepairs: 0 },
    );
    if (!answered.ok) {
      throw new Error(`Expected a validated decision: ${answered.error.message}`);
    }
    expect(isFollowUpDecision(answered.value.value)).toBe(true);
  });
});

// ===========================================================================
// 6. Construction
// ===========================================================================

describe('the factories refuse options they cannot honour', () => {
  const investigateOptions = {
    label: 'a reply',
    admits: (): boolean => true,
    maxQueries: 4,
    maxFlows: 4,
    maxFlowChars: 80,
  };

  it.each([
    ['a blank label', { ...investigateOptions, label: '  ' }],
    ['a zero query bound', { ...investigateOptions, maxQueries: 0 }],
    ['a fractional flow bound', { ...investigateOptions, maxFlows: 1.5 }],
    [
      'a non-finite length bound',
      { ...investigateOptions, maxFlowChars: Number.POSITIVE_INFINITY },
    ],
  ])('buildInvestigateReplySchema refuses %s', (_label, options) => {
    let thrown: unknown;
    try {
      buildInvestigateReplySchema(options);
    } catch (caught) {
      thrown = caught;
    }
    expect(DebuggenError.is(thrown)).toBe(true);
    if (DebuggenError.is(thrown)) {
      expect(thrown.code).toBe('INTERNAL');
    }
  });

  it('buildFollowUpDecisionSchema refuses a negative bound and a blank label', () => {
    expect(() =>
      buildFollowUpDecisionSchema({ label: 'd', admits: () => true, maxAdditionalActions: -1 }),
    ).toThrow(DebuggenError);
    expect(() =>
      buildFollowUpDecisionSchema({
        label: '',
        admits: () => true,
        maxAdditionalActions: MAX_FOLLOW_UP_ADDITIONAL_ACTIONS,
      }),
    ).toThrow(DebuggenError);
  });

  it('treats a guard that throws as a refusal rather than letting the parse throw', () => {
    const schema = buildInvestigateReplySchema({
      ...investigateOptions,
      admits: () => {
        throw new Error('a defective guard');
      },
    });
    expect(() => schema.safeParse(INVESTIGATION)).not.toThrow();
    expect(schema.safeParse(INVESTIGATION).success).toBe(false);
  });
});
