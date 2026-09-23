/**
 * The **authoring schema rendered as JSON Schema**: the only form of this
 * package's panel contract a language model is ever shown.
 *
 * The panel-generation stage embeds the document this module returns in its
 * versioned prompt file — `apps/local-service/prompts/generate-panel/v001.md`
 * substitutes it for the `{{outputSchema}}` placeholder inside a fenced JSON
 * block — and the model's reply is then validated by `parsePanelSpecInput`,
 * normalised by `./normalize.ts` and validated again by `./validate.ts` and
 * `./semantic.ts` (AAP 0.4.2, AAP 0.5.3).
 *
 * ## Two properties this module exists to guarantee
 *
 * **1. It renders the authoring schema, never the internal one.** The internal
 * `PanelSpec` in `./spec.ts` carries `version`, `id`, `sessionId`,
 * `panelVersion`, `supersedes`, `meta` and a derived id on every node, all of
 * them supplied deterministically by the normaliser from its context. Showing
 * that schema to an author would invite it to write identity fields — the exact
 * coupling the two-schema design exists to prevent, and the reason the authored
 * document rejects an authored id rather than overwriting one. The guarantee is
 * structural rather than documentary: this module imports `./input.js` and does
 * **not import `./spec.js` at all**, so rendering the internal schema from here
 * is not a mistake that can be made without adding an import edge a reviewer
 * would see.
 *
 * **2. Its output is deterministic, byte for byte.** A prompt file is immutable
 * once committed — a change is a new `vNNN+1.md` plus a `manifest.json` update,
 * and the version used is recorded on the session (AAP 0.5.3) — so a rendering
 * that varied between processes would make the committed prompt drift from a
 * regenerated one, and would defeat any check that compares the two. Two
 * guarantees compose into that one: Zod's emission is itself a pure function of
 * the schema graph (verified identical across separate processes), and
 * {@link panelSpecInputJsonSchemaText} re-serialises it through a canonical
 * form whose key order does not depend on the order a third party happened to
 * build its object in.
 *
 * ## The emission settings, and why each is what it is
 *
 * - `io: 'input'` — the *input* side of the schema, because the document
 *   describes what an author may **write**, not what parsing yields. The
 *   difference is real here rather than theoretical: the authored summary's
 *   object form strips unrecognised keys instead of rejecting them, so the
 *   output side of that one object carries `additionalProperties: false` while
 *   the input side does not. Emitting the output side would tell an author that
 *   a reply this schema actually accepts is invalid, and would spend one of two
 *   repair attempts on it.
 * - `reused: 'ref'` and `cycles: 'ref'` — references, not inlining, and for
 *   this schema inlining is not merely wasteful but impossible: a container node
 *   holds child nodes, so the node union is recursive and a recursive schema can
 *   only be expressed with `$ref`. The reuse setting then earns its keep on top
 *   of that, because `./input.ts` shares one instance of each field schema
 *   across all sixteen node types: measured on this schema, references produce a
 *   document of roughly 34 KB where inlining produces roughly 157 KB of
 *   duplication that says nothing more.
 * - `unrepresentable: 'throw'` — the loud failure, deliberately. `./input.ts`
 *   constrains itself to constructs JSON Schema can express (`z.enum`,
 *   `.min`/`.max`, `.int`, `.regex`) precisely because it is rendered here, and
 *   this setting is the mechanism that keeps that constraint honest: a
 *   `.transform()`, a `.preprocess()` or a `z.custom` reaching the authoring
 *   schema fails this emission — and therefore the package's tests and the build
 *   that runs them — instead of silently vanishing from the document and leaving
 *   an author told about a looser contract than the one it is judged by.
 * - Descriptions are preserved as `description` keywords. Every `.describe()` in
 *   `./input.ts` is written for this reader and is, beside the prompt's own
 *   prose and the node catalog, the only field-level guidance an author gets.
 *
 * ## What this module adds to Zod's output, and what it never adds
 *
 * Exactly one keyword: `$id`, from {@link PANEL_SPEC_INPUT_JSON_SCHEMA_ID}. No
 * `title`, no `default`, and above all **no `examples`**. The rendered text
 * becomes prompt content, and `scripts/check-no-hardcoding.mjs` reads prompt
 * files as structured text and fails the build on an application identifier or
 * a route path found in one (AAP 0.5.4). An example panel emitted from here
 * would be pre-authored output smuggled into a prompt; a generic example, if one
 * is wanted, belongs in the prompt file, which is reviewed as prose.
 *
 * ## Who consumes this, and who does not
 *
 * The coordination service renders {@link panelSpecInputJsonSchemaText} into the
 * prompt, and `packages/model-provider` uses the same document as the
 * `input_schema` of the forced-`tool_use` **fallback** path. It is *not* on the
 * critical path of the real provider's primary path: `@anthropic-ai/sdk`'s
 * `zodOutputFormat` is handed `panelSpecInputSchema` itself and derives its own
 * JSON Schema from it (AAP 0.2.4). That provider then strips keywords it does
 * not support — numeric bounds among them — which is why nothing here is treated
 * as enforcement: `parsePanelSpecInput` is the gate, and it is the only gate.
 *
 * ## What this module deliberately does not do
 *
 * - **No file writing, and no `node:` builtin of any kind.** It returns a
 *   document and its text; putting either into a prompt file is the service's or
 *   a script's job. The package builds with `platform: 'neutral'` and is bundled
 *   into the DevTools panel and the editor webview, so a builtin here would fail
 *   the build rather than ship.
 * - **No pairing of the schema with the node catalog.** A single
 *   "schema plus catalog" renderer was considered and rejected on the evidence
 *   of the prompt file itself: it interpolates `{{nodeCatalog}}` and
 *   `{{outputSchema}}` at two different places, in two different formats — the
 *   catalog as Markdown list items under "The node types you may use", the
 *   schema as fenced JSON under "Output". The prompt's layout is the prompt
 *   file's decision, and `describeCatalogForPrompt` (`./catalog.ts`) and this
 *   module are re-exported side by side from the package entry, so the service
 *   composes the two without a third function in between deciding an order or a
 *   fence for it.
 *
 * ## Where the tests for this module live
 *
 * In **`./input.test.ts`**, not in a `json-schema.test.ts`: AAP 0.8.3 gives this
 * package five test files and none of them is named for this module, and the
 * emitted document is a projection of the authoring schema, so the file that
 * pins that schema is its natural home. That suite asserts what matters here —
 * that the emission does not throw, that it enumerates every authoring node
 * type, that the metric-id enumeration survived it, that the recursive
 * reference resolves, and that the text is byte-identical across calls.
 *
 * @example
 * ```ts
 * // Rendering the prompt's `{{outputSchema}}` block.
 * const schemaBlock = panelSpecInputJsonSchemaText();
 *
 * // A consumer that accepts a bare schema object only, such as a tool's
 * // `input_schema`: no `$id`, no dialect keyword.
 * const toolSchema = panelSpecInputJsonSchema({ id: null, includeDialect: false });
 * ```
 */

import { z } from 'zod';

import { DebuggenError } from '@debuggen/shared';

import { panelSpecInputSchema } from './input.js';

/*
 * ---------------------------------------------------------------------------
 * Identity and dialect
 * ---------------------------------------------------------------------------
 */

/**
 * The stable `$id` of the emitted document.
 *
 * A URN, and the choice is made on two grounds. It carries **no version
 * number**: the document is generated from `./input.ts` rather than maintained
 * by hand, so an id naming a version would have to be edited in lock-step with
 * a schema change or would start lying — and the artefact that genuinely needs
 * versioning, the prompt the document is embedded in, is versioned by its own
 * file name (`vNNN.md`) and recorded on the session. And it is **not a URL**:
 * nothing resolves this identifier, no document is published at an address, and
 * an `https://` id invites a reader, a validator or a model to fetch something
 * that was never there. A URN says "this names a schema" without implying that
 * it can be retrieved.
 *
 * The three labels are the namespace, the owning package and the schema, so a
 * sibling emission — were the instrumentation plan's authoring schema ever
 * rendered the same way — reads as an obvious neighbour rather than a
 * collision.
 */
export const PANEL_SPEC_INPUT_JSON_SCHEMA_ID = 'urn:debuggen:panel-schema:panel-spec-input';

/**
 * The JSON Schema dialects this module will emit, in preference order.
 *
 * Deliberately two of the four Zod accepts. `draft-04` and `openapi-3.0` are
 * excluded rather than forgotten: the first spells exclusive bounds as booleans
 * and the second replaces `anyOf`-with-`null` by a `nullable` keyword, and
 * neither rendering of this schema has been verified against a consumer here. A
 * dialect nobody checked is worse than an unavailable one, because its document
 * looks right.
 */
export const PANEL_SPEC_INPUT_SCHEMA_TARGETS = Object.freeze([
  'draft-2020-12',
  'draft-07',
] as const);

/** One of the dialects {@link PANEL_SPEC_INPUT_SCHEMA_TARGETS} allows. */
export type PanelSpecInputSchemaTarget = (typeof PANEL_SPEC_INPUT_SCHEMA_TARGETS)[number];

/**
 * The dialect emitted unless a caller asks for another: **JSON Schema 2020-12**.
 *
 * Recursion forces definitions into the document, and this is the choice that
 * decides what they are called. Three things follow from it, all pointing the
 * same way:
 *
 * - **It is the dialect the real provider's own emission speaks.**
 *   `@anthropic-ai/sdk`'s `zodOutputFormat` renders `panelSpecInputSchema` with
 *   Zod's default target, which is this one, so the document embedded in the
 *   prompt and the format the provider sends describe the same contract in the
 *   same spelling.
 * - **`$defs` is the spelling that provider's schema transform recognises.** It
 *   walks `$defs` and passes anything it does not recognise through as
 *   descriptive text, so a `draft-07` document's `definitions` would arrive as
 *   a prose blob of the entire definition set rather than as definitions.
 * - **Nothing is lost for an older validator.** Every keyword this schema uses
 *   — `type`, `properties`, `required`, `additionalProperties`, `enum`, `const`,
 *   `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `minItems`,
 *   `maxItems`, `anyOf`, `oneOf`, `$ref`, `description` — has meant the same
 *   thing since draft-06; only the *location* of the definitions differs, and
 *   `draft-07` remains available through
 *   {@link PanelSpecInputJsonSchemaOptions.target} for a consumer that needs it.
 *
 * The consequence to keep in mind is the one AAP 0.2.4 records: a provider
 * strips the keywords it does not support, numeric bounds included, so what a
 * model was shown is guidance and never enforcement. The bounds are re-checked
 * by `parsePanelSpecInput` after the reply is parsed.
 */
export const PANEL_SPEC_INPUT_SCHEMA_TARGET: PanelSpecInputSchemaTarget = 'draft-2020-12';

/** The `$id` keyword, named once so the emitter and the remover agree. */
const JSON_SCHEMA_ID_KEYWORD = '$id';

/** The `$schema` dialect keyword, named once for the same reason. */
const JSON_SCHEMA_DIALECT_KEYWORD = '$schema';

/**
 * The indentation of the rendered text: **two spaces**, fixed rather than
 * configurable.
 *
 * The text is embedded in a prompt and compared for equality; an indent a
 * caller could vary would be one more way for two renderings of one schema to
 * differ without disagreeing about anything.
 */
const JSON_TEXT_INDENT = 2;

/** The name this module reports for the schema it renders, in a failure. */
const PANEL_SPEC_INPUT_SCHEMA_NAME = 'panelSpecInput';

/*
 * ---------------------------------------------------------------------------
 * Options
 * ---------------------------------------------------------------------------
 */

/** How to render the authoring schema. Every field is optional. */
export interface PanelSpecInputJsonSchemaOptions {
  /**
   * The dialect to emit. Defaults to {@link PANEL_SPEC_INPUT_SCHEMA_TARGET};
   * must be one of {@link PANEL_SPEC_INPUT_SCHEMA_TARGETS}.
   */
  readonly target?: PanelSpecInputSchemaTarget;

  /**
   * The document's `$id`. Defaults to
   * {@link PANEL_SPEC_INPUT_JSON_SCHEMA_ID}; pass `null` to omit the keyword
   * entirely, which is what a consumer accepting a bare schema object — a
   * tool's `input_schema`, for instance — wants.
   */
  readonly id?: string | null;

  /**
   * Whether to keep the `$schema` dialect keyword. Defaults to `true`; pass
   * `false` alongside `id: null` for a document carrying schema keywords and
   * nothing else.
   */
  readonly includeDialect?: boolean;
}

/*
 * ---------------------------------------------------------------------------
 * Emission
 * ---------------------------------------------------------------------------
 */

/**
 * Renders {@link panelSpecInputSchema} with the settings the module
 * documentation justifies, and turns a rendering failure into a typed one.
 *
 * Every failure reaching the `catch` is a **product bug** rather than bad input
 * — there is no input, only this package's own schema — so it is reported as
 * `INTERNAL` with the offending target in its details and the original error as
 * its cause. The hint names the actual remedy, because the only way to provoke
 * this is to put a construct JSON Schema cannot express into `./input.ts`.
 *
 * @param target The dialect to emit.
 * @returns The rendered document, exactly as Zod produced it.
 * @throws DebuggenError `INTERNAL` if the authoring schema cannot be rendered.
 */
function emitAuthoringSchema(target: PanelSpecInputSchemaTarget): Record<string, unknown> {
  try {
    return z.toJSONSchema(panelSpecInputSchema, {
      target,
      io: 'input',
      unrepresentable: 'throw',
      reused: 'ref',
      cycles: 'ref',
    });
  } catch (cause) {
    throw new DebuggenError(
      'INTERNAL',
      `The ${PANEL_SPEC_INPUT_SCHEMA_NAME} schema could not be rendered as ${target} JSON Schema.`,
      {
        hint: 'A construct reachable from the authoring schema has no JSON Schema equivalent. Express the constraint with an enumeration, a bound or a pattern instead of a transform, a preprocess step or a custom check.',
        details: { schema: PANEL_SPEC_INPUT_SCHEMA_NAME, target },
        cause,
      },
    );
  }
}

/*
 * ---------------------------------------------------------------------------
 * Canonical form
 * ---------------------------------------------------------------------------
 */

/**
 * Raises the one failure the canonicaliser can hit: a value JSON cannot carry.
 *
 * The path is included and the **value is not**, which is this repository's
 * rule for every validation failure (AAP 0.5.2): a message that quotes the
 * value it rejected is a message that can leak one. A type name and a location
 * are enough to find the construct that produced it.
 */
function unrepresentableValue(path: string, what: string): DebuggenError {
  return new DebuggenError(
    'INTERNAL',
    `The rendered ${PANEL_SPEC_INPUT_SCHEMA_NAME} JSON Schema holds ${what} at "${path}", which JSON cannot represent.`,
    {
      hint: 'The emitted document must be a plain JSON value. Check the authoring schema for metadata attached to it that is not JSON-serialisable.',
      details: { schema: PANEL_SPEC_INPUT_SCHEMA_NAME, path },
    },
  );
}

/**
 * The canonicalisation rule, applied to one value and its whole subtree.
 *
 * **The rule, stated once.** Object keys are ordered by
 * `Array.prototype.sort()`'s default comparison — UTF-16 code units, ascending,
 * with no collator — at every level of the document; array order is the
 * emitter's and is never touched, because an `enum`, a `required` list, a
 * `oneOf` branch list and a `prefixItems` tuple all mean something different
 * when reordered. A key whose value is `undefined` is dropped, exactly as
 * `JSON.stringify` would drop it, so the returned object and its serialisation
 * cannot disagree. `localeCompare` is deliberately not used: it consults the
 * runtime's collation, which is the one part of a sort that can differ between
 * two machines rendering the same schema.
 *
 * **Why walk at all**, rather than trusting `JSON.stringify` over the emitted
 * object: insertion order is a property of how a third-party emitter happened to
 * build its object, and a future version of it may traverse the schema graph in
 * another order without changing the meaning of a single keyword. This walk
 * makes the rendering depend on the document's *content* alone. It also returns
 * a **plain** structure built here, which is what keeps the non-enumerable
 * `~standard` property Zod attaches to its result — a function-bearing helper,
 * not schema content — out of the document this module hands to its callers.
 *
 * Shared sub-objects are fine and common: `seen` tracks only the current
 * ancestor chain, so a definition referenced twice is rendered twice while a
 * genuine cycle is reported instead of overflowing the stack. The emission is
 * configured to express recursion as `$ref`, so a cycle here would mean the
 * emitter had ignored that setting.
 *
 * @param value The value to canonicalise.
 * @param path Where `value` sits, for a failure message.
 * @param seen The object identities on the path from the root to `value`.
 * @returns A plain JSON value with every object's keys in sorted order.
 * @throws DebuggenError `INTERNAL` on a value JSON cannot represent, including
 * a cyclic one.
 */
function canonicaliseJsonValue(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === null) {
    return null;
  }

  const kind = typeof value;

  if (kind === 'string' || kind === 'boolean') {
    return value;
  }

  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw unrepresentableValue(path, 'a non-finite number');
    }
    return value;
  }

  if (kind !== 'object') {
    throw unrepresentableValue(path, `a value of type "${kind}"`);
  }

  const container = value as object;

  if (seen.has(container)) {
    throw unrepresentableValue(path, 'a circular reference');
  }
  seen.add(container);

  try {
    if (Array.isArray(container)) {
      const entries = container as readonly unknown[];
      return entries.map((entry, index) =>
        canonicaliseJsonValue(entry, `${path}[${String(index)}]`, seen),
      );
    }

    const source = container as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};

    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) {
        continue;
      }
      canonical[key] = canonicaliseJsonValue(entry, path === '' ? key : `${path}.${key}`, seen);
    }

    return canonical;
  } finally {
    seen.delete(container);
  }
}

/**
 * Canonicalises a whole document and proves the result is an object.
 *
 * The narrowing exists because {@link canonicaliseJsonValue} is honest about
 * returning `unknown` for an arbitrary input, while a JSON Schema document is
 * an object by definition — a bare `true` or `false` schema is legal JSON Schema
 * but is not what a schema for an object with three required properties can
 * render to, so anything else is a bug worth reporting at the boundary rather
 * than a case to widen the return type for.
 *
 * @param document The rendered document.
 * @returns The same document, canonicalised.
 * @throws DebuggenError `INTERNAL` if the canonical form is not an object.
 */
function canonicaliseDocument(document: Record<string, unknown>): Record<string, unknown> {
  const canonical = canonicaliseJsonValue(document, '', new Set<object>());

  if (typeof canonical !== 'object' || canonical === null || Array.isArray(canonical)) {
    throw unrepresentableValue('', 'a document that is not a JSON object');
  }

  return canonical as Record<string, unknown>;
}

/*
 * ---------------------------------------------------------------------------
 * The public rendering API
 * ---------------------------------------------------------------------------
 */

/**
 * Resolves the requested dialect, rejecting one this module has not verified.
 *
 * The type parameter already constrains a TypeScript caller, so this guard is
 * for the boundary the types do not cover — a value that arrived as data, from
 * configuration or from a JavaScript consumer of the built package — where
 * silently emitting an unverified dialect is the failure mode worth preventing.
 */
function resolveTarget(target: PanelSpecInputSchemaTarget | undefined): PanelSpecInputSchemaTarget {
  if (target === undefined) {
    return PANEL_SPEC_INPUT_SCHEMA_TARGET;
  }

  if (!PANEL_SPEC_INPUT_SCHEMA_TARGETS.includes(target)) {
    throw new DebuggenError(
      'INTERNAL',
      `"${String(target)}" is not a JSON Schema dialect this package emits.`,
      {
        hint: `Choose one of: ${PANEL_SPEC_INPUT_SCHEMA_TARGETS.join(', ')}.`,
        details: { supported: [...PANEL_SPEC_INPUT_SCHEMA_TARGETS] },
      },
    );
  }

  return target;
}

/**
 * Resolves the document's `$id`: the default, an explicit replacement, or none.
 *
 * A blank replacement is refused rather than emitted. `$id` establishes the base
 * against which this document's own `#/$defs/…` references resolve, so an empty
 * string is not a harmless label but a malformed identity for a document whose
 * references all depend on it.
 */
function resolveDocumentId(id: string | null | undefined): string | null {
  if (id === undefined) {
    return PANEL_SPEC_INPUT_JSON_SCHEMA_ID;
  }

  if (id !== null && id.trim().length === 0) {
    throw new DebuggenError('INTERNAL', 'A JSON Schema $id must not be blank.', {
      hint: 'Pass a non-blank identifier, omit the option to accept the default, or pass null to emit no $id at all.',
    });
  }

  return id;
}

/**
 * The authoring schema as a JSON Schema document: what a model is shown, and
 * what a tool's `input_schema` is built from.
 *
 * Deterministic — the same options return an equal document in any process —
 * and a plain JSON value throughout: objects with sorted keys, arrays in the
 * emitter's order, nothing that `JSON.stringify` would drop or choke on.
 * {@link panelSpecInputJsonSchemaText} is exactly this document serialised, so
 * the two can be used interchangeably without one of them describing something
 * the other does not.
 *
 * The document is a fresh structure on every call and is safe for a caller to
 * mutate — the `input_schema` path does adapt it — which is also why it is not
 * memoised: a shared frozen instance would make one consumer's adaptation
 * another's surprise, and rendering is cheap next to the model call it is for.
 *
 * @param options See {@link PanelSpecInputJsonSchemaOptions}. Omit for the
 * dialect, `$id` and dialect keyword the prompt uses.
 * @returns The rendered, canonicalised document.
 * @throws DebuggenError `INTERNAL` if the options name an unsupported dialect or
 * a blank `$id`, or if the authoring schema holds a construct JSON Schema cannot
 * express.
 */
export function panelSpecInputJsonSchema(
  options?: PanelSpecInputJsonSchemaOptions,
): Record<string, unknown> {
  const target = resolveTarget(options?.target);
  const id = resolveDocumentId(options?.id);
  const includeDialect = options?.includeDialect ?? true;

  // Spreading copies own *enumerable* properties only, which is what leaves
  // Zod's non-enumerable `~standard` helper behind before anything else runs.
  const document: Record<string, unknown> = { ...emitAuthoringSchema(target) };

  if (id === null) {
    delete document[JSON_SCHEMA_ID_KEYWORD];
  } else {
    document[JSON_SCHEMA_ID_KEYWORD] = id;
  }

  if (!includeDialect) {
    delete document[JSON_SCHEMA_DIALECT_KEYWORD];
  }

  return canonicaliseDocument(document);
}

/**
 * The same document as text, ready to substitute into a prompt.
 *
 * Two spaces of indentation, keys in the canonical order
 * {@link canonicaliseJsonValue} defines, and **no trailing newline** — the
 * convention `describeCatalogForPrompt` (`./catalog.ts`) already follows in this
 * package, and the one the prompt file needs: the `{{outputSchema}}` placeholder
 * sits alone on a line inside a fenced JSON block, so the template supplies the
 * newline and a second one would open a blank line before the closing fence.
 *
 * Byte-identical for equal options, call after call and process after process,
 * which is what lets a committed prompt file be compared against a fresh
 * rendering of the schema it was built from.
 *
 * @param options See {@link PanelSpecInputJsonSchemaOptions}.
 * @returns The document as JSON text, without a trailing newline.
 * @throws DebuggenError `INTERNAL` under the conditions
 * {@link panelSpecInputJsonSchema} documents.
 */
export function panelSpecInputJsonSchemaText(options?: PanelSpecInputJsonSchemaOptions): string {
  return JSON.stringify(panelSpecInputJsonSchema(options), null, JSON_TEXT_INDENT);
}
