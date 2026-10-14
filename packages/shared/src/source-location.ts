/**
 * `SourceLocation` — the one description of where in the developer's project a
 * runtime item came from.
 *
 * Click-to-source is one of this product's two headline behaviours, and this
 * module is its type. AAP §0.9.1 lists this path among the schema sources that
 * have a **single** definition, so the shape below is defined here once and
 * embedded elsewhere rather than restated:
 *
 * - `TelemetryEvent.source` in `@debuggen/telemetry` — the code a span was
 *   produced by.
 * - the patcher's `ModificationRecord` in `@debuggen/instrumentation` — where a
 *   timing wrapper was installed, recorded before the file was written.
 * - the `sourceLink` node and `Hypothesis.suggestedLocation` in
 *   `@debuggen/panel-schema` — what a generated panel is allowed to point at.
 * - the `source.open` message in `@debuggen/protocol` — what crosses the
 *   process boundary when the developer clicks.
 *
 * A second definition of this shape anywhere in the monorepo is a defect, not a
 * convenience: four independent resolvers in three packages fill these fields
 * and three processes read them, so the only way the numbers can be trusted is
 * for there to be one place that says what they mean.
 *
 * ## The click path this type serves
 *
 * A source chip in a generated panel becomes an editor selection through a
 * fixed sequence of hops (AAP §0.2.3, §0.4.2), and every hop carries this exact
 * object:
 *
 * ```text
 * SourceLink → PanelActions.openSource → the DevTools panel's actions.ts
 *   → a runtime port → the Chrome service worker → WebSocket `source.open`
 *   → the local service, which re-validates containment against the session's
 *     projectRoot → the VS Code client → showTextDocument with a selection
 * ```
 *
 * One optional field added here is five files of change along that path, and a
 * field whose meaning is only half-agreed is a mis-navigation the developer
 * blames on the product. Hence two deliberate decisions, both visible below:
 * {@link SourceLocation} has no member beyond the seven declared, and
 * `confidence` is **required** so a resolver cannot silently omit it and leave
 * the user interface guessing — {@link DEFAULT_RESOLUTION_CONFIDENCE} exists so
 * that every resolver has a value to reach for.
 *
 * ## `file` is a security boundary, not a formatting convention
 *
 * `file` is project-relative POSIX, and {@link sourceLocationSchema} enforces
 * that with {@link isSafeRelativePath} at the *schema* boundary — before a
 * location can reach the session store, a model prompt, a panel or a filesystem
 * call. An absolute developer path in a panel leaks the machine's layout into a
 * screenshot and into an outbound model request; a `'..'` traversal in a
 * `source.open` message is an arbitrary-file-read attempt. Rejecting both where
 * the value is parsed is the only enforcement point every producer has in
 * common.
 *
 * It is a gate, not *the* gate: a string-level check cannot see that a path
 * inside the project is a symlink pointing out of it. The local service
 * re-validates containment against the session's project root, and the VS Code
 * URI handler validates independently of both with `fs.realpath`, because any
 * web page can trigger a `vscode://` URI.
 *
 * ## Why `zod` is a dependency of this package
 *
 * For this module alone. `@debuggen/shared` is the base layer of AAP §0.2.2 and
 * carries primitives, not schemas — but `SourceLocation` is a *validated* shape
 * that four layers above need, and defining it here rather than importing it
 * into here is what keeps the package graph acyclic. No sibling module in this
 * package imports `zod`, and none should start: a schema that belongs to
 * telemetry, plans, panels or messages belongs in that package.
 *
 * Everything here is browser-safe. This module is re-exported by the package's
 * `"."` entry, which the MAIN-world telemetry agent, the DevTools panel and the
 * VS Code webview all bundle, so it uses no `node:*` builtin and no Node-only
 * global.
 *
 * ## The JSON Schema caveat
 *
 * `z.toJSONSchema` — used by `@debuggen/panel-schema`'s `json-schema.ts` to
 * render schemas into the versioned prompt files — keeps the field types,
 * bounds and the `resolvedBy` enumeration, but **drops the two custom
 * refinements below**: the `isSafeRelativePath` check on `file` and the
 * `endLine >= line` check. A prompt that shows a model this schema must state
 * those two rules in prose, and runtime validation
 * ({@link parseSourceLocation}) remains the only thing that enforces them.
 *
 * @example
 * ```ts
 * const location = parseSourceLocation({
 *   file: 'src/lib/thing.ts',
 *   line: 42,
 *   column: 3,
 *   symbol: 'loadThing',
 *   resolvedBy: 'code-graph',
 *   confidence: DEFAULT_RESOLUTION_CONFIDENCE['code-graph'],
 * });
 *
 * if (location.ok) {
 *   logger.info('resolved', { at: formatSourceLocation(location.value) });
 * }
 * ```
 */

import { z } from 'zod';

import { DebuggenError } from './errors.js';
import { isSafeRelativePath } from './paths.js';
import { err, ok } from './result.js';
import type { Result } from './result.js';

/**
 * Every mechanism that can produce a {@link SourceLocation}.
 *
 * **Declaration order is the protocol's order, not the precedence order.** The
 * tuple is spelled exactly as AAP §0.2.3 spells it so that the enumeration a
 * message, a stored row and a rendered JSON Schema carry never depends on how
 * this file is sorted. Precedence — which resolver a consumer should believe
 * when two of them answer for the same runtime item — is the order documented
 * below, and it is expressed numerically, once, in
 * {@link DEFAULT_RESOLUTION_CONFIDENCE}.
 *
 * In precedence order, highest first, with the mechanism behind each
 * (AAP §0.4.2, "Source resolution path"):
 *
 * 1. `'patch'` — the file, line and column recorded by
 *    `@debuggen/instrumentation`'s `patch/function-timing.ts` at the moment it
 *    installed a timing wrapper around a named symbol. Exact by construction:
 *    the resolver *is* the thing that wrote the code the span comes from, so
 *    there is nothing to infer.
 * 2. `'route-map'` — a request path mapped to the module that handles it by
 *    `@debuggen/code-analysis`'s `route-map.ts`. A framework's routing
 *    convention is a documented, mechanical mapping from a URL to a file, so
 *    the only uncertainty is which route pattern a concrete URL matched.
 * 3. `'code-graph'` — a symbol found in the indexed project: a component's
 *    display name resolved to its declaration, or a database call site, through
 *    `@debuggen/code-analysis`'s `graph/query.ts`. Exact when the name is
 *    unique in the graph, and a choice between candidates when it is not.
 * 4. `'source-map'` — a stack frame in a generated dev-server chunk mapped back
 *    to TypeScript with `@jridgewell/trace-mapping`, then normalised to a
 *    project-relative path. Depends on a build's source map being present and
 *    accurate, and lands on the mapped segment rather than necessarily the
 *    statement a human would point at.
 * 5. `'react-owner'` — the React owner chain of an element the developer
 *    selected, walked by `@debuggen/telemetry`'s `browser/dom-target.ts`. The
 *    weakest route and still worth having: it answers "which component rendered
 *    this DOM node" for a selection made with no other evidence at all, and the
 *    owner it lands on can be a wrapper rather than the component the developer
 *    meant.
 *
 * Declared `as const` because {@link SourceResolvedBy} is derived from it: this
 * array is the single source of the vocabulary, and
 * {@link sourceLocationSchema} validates against it directly rather than
 * repeating the five strings.
 */
export const SOURCE_RESOLVED_BY = [
  'patch',
  'code-graph',
  'source-map',
  'react-owner',
  'route-map',
] as const;

/**
 * The mechanism that produced a {@link SourceLocation}.
 *
 * Derived from {@link SOURCE_RESOLVED_BY} rather than declared beside it, so
 * the values and the type cannot drift: adding a resolver widens this union in
 * the same edit, and every consumer that switches exhaustively over it — the
 * panel renderer's source chip, which badges a low-confidence location
 * differently, and the service's resolver, which tries the routes in order —
 * stops compiling until it says something about the new case.
 */
export type SourceResolvedBy = (typeof SOURCE_RESOLVED_BY)[number];

/**
 * The confidence each resolution route reports by default.
 *
 * `patch` 1, `route-map` 0.9, `code-graph` 0.85, `source-map` 0.75,
 * `react-owner` 0.6 — the precedence order documented on
 * {@link SOURCE_RESOLVED_BY}, expressed as the numbers that order it.
 *
 * This table lives in this package, next to the type, for one reason: four
 * independent resolvers in three packages fill `confidence`, and two user
 * interfaces sort and badge on it. If each resolver invented its own scale,
 * `0.8` would mean "certain" to one of them and "a guess" to another, the sort
 * order of a panel's suggested locations would be arbitrary, and the number
 * would be worse than absent because it would look authoritative. A resolver
 * with nothing better to say uses the value for its route; one that knows more
 * about a particular resolution — a code-graph lookup that matched exactly one
 * declaration rather than choosing among five — may report higher or lower,
 * which is exactly why `confidence` is a number and not this enumeration.
 *
 * Frozen because it is a shared module-level table read on every resolution: a
 * mutation would silently re-rank every panel in the process.
 */
export const DEFAULT_RESOLUTION_CONFIDENCE: Readonly<Record<SourceResolvedBy, number>> =
  Object.freeze({
    patch: 1,
    'route-map': 0.9,
    'code-graph': 0.85,
    'source-map': 0.75,
    'react-owner': 0.6,
  });

/**
 * The validator every source location passes through, and the definition of
 * {@link SourceLocation}.
 *
 * Seven fields, five required and two optional, and nothing else. Downstream
 * packages **embed this schema as a field** — `TelemetryEvent.source`, the
 * `sourceLink` node's `location`, `Hypothesis.suggestedLocation`, the
 * `source.open` payload — rather than re-declaring the shape, which is what
 * makes the refinements below run at every boundary the object crosses. Zod 4
 * keeps refinements *inside* the schema, so a location nested in a larger
 * object is still checked, and the issue it reports still carries the full
 * path (`['source', 'endLine']`, for instance) rather than a bare field name.
 *
 * Two refinements are attached, one per axis of correctness:
 *
 * - `file` must satisfy {@link isSafeRelativePath}. See the note on this
 *   module about why that is a security boundary rather than a formatting
 *   preference.
 * - `endLine`, when present, must be at least `line`. An inverted range is not
 *   a harmless oddity: the VS Code extension turns the pair into a selection,
 *   and a backwards selection either reveals the wrong region or throws inside
 *   the editor, depending on how it was built.
 *
 * Unknown keys are stripped rather than rejected, which is Zod's default for
 * `z.object` and the behaviour this product wants at a process boundary: a
 * producer built against a later version of this schema stays compatible, and
 * nothing it sent that this version does not understand can reach the store or
 * a user interface.
 *
 * @example
 * ```ts
 * const location = sourceLocationSchema.parse({
 *   file: 'src/lib/thing.ts',
 *   line: 42,
 *   column: 3,
 *   symbol: 'loadThing',
 *   endLine: 57,
 *   resolvedBy: 'patch',
 *   confidence: DEFAULT_RESOLUTION_CONFIDENCE.patch,
 * });
 * ```
 */
export const sourceLocationSchema = z
  .object({
    /**
     * The file the code is in: **project-relative, POSIX separators**, never
     * absolute and never escaping the project.
     *
     * `'src/lib/thing.ts'`, not `'/home/dev/project/src/lib/thing.ts'` and not
     * `'src\\lib\\thing.ts'`. Project-relative is what makes a location
     * meaningful to the three processes that handle it — the service resolves
     * it against the session's project root, the editor against the workspace
     * folder — and what keeps a developer's directory layout out of panels,
     * prompts and screenshots. Convert a host path with `toPosix` and
     * `toProjectRelative` from this package's `paths` module *before*
     * constructing a location; this schema deliberately refuses rather than
     * repairs, because a path it cannot vouch for character-for-character is
     * one it must not pass on.
     */
    file: z.string().min(1).refine(isSafeRelativePath, {
      error:
        'file must be a project-relative POSIX path: no absolute or drive-letter path, no ".." segment, no backslash and no control character.',
    }),

    /**
     * The 1-based line the item is on.
     *
     * **1-based on both axes**, `line` and `column` alike, which is the
     * convention every producer already speaks: TypeScript and ts-morph
     * diagnostics, a JavaScript stack frame, and
     * `@jridgewell/trace-mapping`'s output after normalisation. The VS Code
     * extension subtracts one when it builds a `Position` for
     * `showTextDocument`, and that subtraction happens in exactly one place
     * (`apps/vscode-extension/src/source/open-location.ts`) precisely because
     * everything on the wire is 1-based.
     */
    line: z.int().min(1),

    /**
     * The 1-based column the item starts at.
     *
     * 1-based for the same reason `line` is, and used the same way: it becomes
     * the character offset of the editor selection's anchor, so a 0 here would
     * silently select from the wrong character. A resolver that knows the line
     * but not the column reports `1`, the start of the line, rather than
     * omitting the field.
     */
    column: z.int().min(1),

    /**
     * The name of the function, component or route handler, when one is known.
     *
     * Optional because not every route can supply it: a source-map frame
     * resolves to a position, not necessarily to a named symbol. Rendered
     * separately from the `file:line:column` label by the panel renderer's
     * source chip, which is why {@link formatSourceLocation} leaves it out.
     * Constrained to a non-empty string so an empty name cannot reach a user
     * interface as a blank label.
     */
    symbol: z.string().min(1).optional(),

    /**
     * The last line of the region, when the item spans more than one line.
     *
     * Optional: most locations are a point, and a resolver that knows only the
     * start omits this rather than guessing an end. When present it must be at
     * least `line` (enforced by the object-level refinement), and the editor
     * reveals the whole range instead of a single line — which is what makes a
     * patched function or a whole route handler land on screen as a unit.
     */
    endLine: z.int().min(1).optional(),

    /**
     * Which mechanism produced this location. See {@link SOURCE_RESOLVED_BY}.
     *
     * Validated against the tuple directly, so the enumeration can never drift
     * from the documented set of routes. It is carried all the way to the user
     * interface: a location is worth a different amount depending on how it was
     * found, and a developer who lands on the wrong line deserves to be able to
     * see why.
     */
    resolvedBy: z.enum(SOURCE_RESOLVED_BY),

    /**
     * How much the resolver trusts this location, from `0` to `1` inclusive.
     *
     * **Required.** A resolver that cannot commit to a number is a resolver
     * that hands the user interface an unanswerable question, so every route
     * has a default to reach for in {@link DEFAULT_RESOLUTION_CONFIDENCE}, and
     * a resolver that knows more about one particular resolution may report
     * something other than its route's default. Both bounds are inclusive:
     * `1` is "exact by construction", which a patch legitimately is, and `0` is
     * "this is the best guess available, and it is only a guess" — a value a
     * user interface may show with a warning, but never a reason to drop the
     * location, since a weak pointer into the code still beats none.
     */
    confidence: z.number().min(0).max(1),
  })
  .refine((location) => location.endLine === undefined || location.endLine >= location.line, {
    error: 'endLine must be greater than or equal to line.',
    path: ['endLine'],
  });

/**
 * Where in the developer's project a runtime item came from.
 *
 * Inferred from {@link sourceLocationSchema} rather than declared beside it, so
 * the validator and the type are the same statement: a field added to the
 * schema appears here in the same edit, and no consumer can be compiling
 * against a shape the validator does not accept.
 *
 * This is the type on `TelemetryEvent.source`, on the patcher's
 * `ModificationRecord`, on a panel's `sourceLink` node and
 * `Hypothesis.suggestedLocation`, and in the `source.open` message — the object
 * that travels the whole click path described at the top of this module.
 */
export type SourceLocation = z.infer<typeof sourceLocationSchema>;

/**
 * Validates an unknown value as a {@link SourceLocation}, without throwing.
 *
 * This is how a location that arrived from somewhere else — a WebSocket frame,
 * a stored row, a model's structured output, a page agent's event batch —
 * becomes a typed value. On failure the error is a
 * {@link DebuggenError} with code `'PROTOCOL_INVALID_MESSAGE'` and a
 * `details.issues` array of `{ path, message }` pairs, one per validation
 * issue, where `path` is the dotted path of the offending field (the empty
 * string for an issue on the object itself).
 *
 * **The rejected values are deliberately not in `details`.** That object may be
 * logged, persisted with a session and shown in a user interface, and the
 * redaction layer never sees an error raised this deep in a call stack
 * (AAP §0.5.2), so what goes in it is the *shape* of the failure and never the
 * data that caused it. The field paths and the schema's own messages are enough
 * to fix a producer.
 *
 * Callers at a stage boundary should `mapErr` to the code that describes their
 * operation — `'MODEL_OUTPUT_INVALID'` for a location inside a model-authored
 * panel, `'STORE_ERROR'` for one read back from the session store — because
 * `'PROTOCOL_INVALID_MESSAGE'` describes the transport, which is only the right
 * answer when a transport is what delivered the value.
 *
 * @param value Any value believed to be a source location.
 * @returns `ok(location)` with the parsed value, or `err(error)` describing
 * every issue found.
 *
 * @example
 * ```ts
 * const parsed = parseSourceLocation(payload.location);
 * if (!parsed.ok) {
 *   return mapErr(parsed, (error) => new DebuggenError('MODEL_OUTPUT_INVALID', error.message));
 * }
 * ```
 */
export function parseSourceLocation(value: unknown): Result<SourceLocation> {
  const parsed = sourceLocationSchema.safeParse(value);

  if (parsed.success) {
    return ok(parsed.data);
  }

  // `issue.path` holds property keys, which may be numbers (array indices) as
  // well as strings, so each segment is stringified before joining. Only the
  // path and the schema's message are kept: see the privacy note above.
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));

  return err(
    new DebuggenError(
      'PROTOCOL_INVALID_MESSAGE',
      'A value did not match the source location schema.',
      {
        hint: 'A source location needs a project-relative POSIX file, 1-based line and column, a known resolvedBy and a confidence between 0 and 1.',
        details: { issues },
      },
    ),
  );
}

/**
 * Whether a value is a {@link SourceLocation}.
 *
 * The boolean form of {@link parseSourceLocation}, over the same schema and so
 * with the same two refinements, for the paths that only need to ask: a
 * telemetry batch filtering the events that carry a usable location, a renderer
 * deciding whether to show a source chip at all. Use
 * {@link parseSourceLocation} wherever the answer has to explain itself — it is
 * the same work, and a rejection with no reason attached is a bug report nobody
 * can act on.
 *
 * @param value Any value.
 * @returns `true` when `value` satisfies {@link sourceLocationSchema},
 * narrowing it to {@link SourceLocation}.
 */
export function isSourceLocation(value: unknown): value is SourceLocation {
  return sourceLocationSchema.safeParse(value).success;
}

/**
 * Renders a location as `file:line:column`.
 *
 * The canonical short form, and it has two consumers: the label of the
 * `SourceLink` chip in `@debuggen/panel-renderer`, and log and diagnostic lines
 * anywhere a location has to appear in one piece of text. Both get the same
 * string, which is the point — a developer who reads a path in a log and the
 * same path on a chip should not have to work out whether they are the same
 * place.
 *
 * `symbol` is **not** included: the chip renders it separately, in its own
 * style, and `endLine` is not included either, since the range is a property of
 * the selection the editor makes rather than of the label. The result is
 * therefore not round-trippable into a {@link SourceLocation} and is not meant
 * to be — it is a display string, and `source.open` carries the object itself.
 *
 * @param location A validated source location.
 * @returns The `file:line:column` string, for example
 * `'src/lib/thing.ts:42:3'`.
 */
export function formatSourceLocation(location: SourceLocation): string {
  return `${location.file}:${location.line}:${location.column}`;
}
