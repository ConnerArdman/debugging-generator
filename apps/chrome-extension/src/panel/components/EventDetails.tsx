/**
 * `EventDetails` — the "Debug Generator" panel's right drawer, which explains
 * one selected runtime event (AAP 0.7.3): its tier, kind and status badges, its
 * duration and start time, its source chip, its parent chain, its attributes
 * table and its correlation identifiers.
 *
 * ## Where it sits, and why its handlers are props
 *
 * The composition root (`../App.tsx`) resolves the store's selected `EventRef`
 * to a stored event and renders this component as the second pane of a
 * weighted `Split`, inside its own `<aside>`. That placement is OUTSIDE
 * `PanelHost`, so no `PanelActionsContext` reaches this subtree:
 * `usePanelActions()` would answer `undefined`, and a `SourceLink` left to find
 * its handler there would degrade to an inert label. The drawer is hop 1 of the
 * click-to-source chain for every event selected in it (AAP 0.4.2):
 *
 *   SourceLink → onOpenSource (this file's required prop)
 *     → `../actions.ts` → runtime port → service worker → WS `source.open`
 *     → local service (path validated inside the project root) → VS Code
 *
 * `onOpenSource` is therefore REQUIRED at the type level and passed to the chip
 * explicitly; only a compile error can stop a dead chip, because the renderer's
 * chip degrades silently rather than failing. The location travels by
 * reference, exactly as it arrived: no field is rewritten here.
 *
 * ## Composition
 *
 *   section[aria-labelledby]      the labelled region (never an `<aside>`: the
 *   │                             root already provides that landmark)
 *   └── Stack
 *       ├── Heading (level 2) + optional "Close" Button
 *       └── one of the four states below
 *
 *   - `status === "loading"` → `LoadingState` (rows skeleton);
 *   - `status === "error"`   → `ErrorState` with the message, hint, code and a
 *                              retry action when `onRetry` is supplied — a
 *                              failure never renders as an empty drawer
 *                              (AAP 0.5.5);
 *   - no `event`             → `EmptyState` naming how to select one;
 *   - an `event`             → the body: summary line and badges, timing,
 *                              `Section`s for Source, Parent chain, Attributes
 *                              (`DataTable`) and Identity.
 *
 * The Parent chain section renders for every shown event, so "no parent",
 * "parent not in the capture" and "not looked up yet" never look alike. What it
 * holds follows from the event and the `ancestry` the composition root
 * resolved for it ({@link EventAncestry}):
 *
 *   - no `parentSpanId`      → the event is its trace's root (any `ancestry`
 *                              is ignored);
 *   - no `ancestry`          → a neutral sentence: the event has a parent span
 *                              whose ancestors have not been looked up;
 *   - `loading`              → a one-row `LoadingState`;
 *   - `complete`             → the ordered chain, trace root first and the
 *                              selected event last;
 *   - `missing`              → why the chain stops (the immediate parent, or an
 *                              ancestor's parent, is not part of the capture),
 *                              the missing span id as copyable text and the
 *                              known part of the chain beneath the gap;
 *   - `incomplete`           → how many stored events of the trace were read
 *                              without finding the parent span, the missing
 *                              span id and the known part of the chain;
 *   - `cycle`                → that the recorded parent links loop, and the
 *                              chain up to the loop;
 *   - `error`                → a polite `ErrorState` with a retry action when
 *                              `onRetryAncestry` is supplied.
 *
 * A partial chain opens with a muted, non-interactive marker saying that the
 * ancestors above it are unknown, so a fragment is never read as the whole
 * lineage. A `complete` chain that does not reach a trace root (it is empty,
 * or its first entry still names a parent) is contradictory and is shown as
 * `missing` at the first unresolved span: a false complete chain is never
 * presented.
 *
 * ## Evidence fidelity and privacy (AAP 0.5.2)
 *
 * Attribute values, URLs and SQL reach this component already redacted by the
 * service's ingest path. They are rendered byte-for-byte through `Code` — never
 * re-redacted (which would corrupt the evidence), never truncated (a long or
 * multi-line value takes `Code`'s block form instead), never logged and never
 * sent anywhere. Non-string values are stringified deterministically, with a
 * cycle-safe JSON serialisation for objects, and an unexpected value degrades
 * to a textual marker instead of throwing. The attribute paths the redactor
 * replaced (`TelemetryEvent.redacted`) are surfaced as a worded "redacted"
 * badge, so a missing value reads as policy rather than as a capture fault.
 * Times are epoch milliseconds and durations are milliseconds on every tier,
 * so no unit conversion happens here.
 *
 * ## Accessibility
 *
 * - The drawer is a labelled region; subsections are level-3 headings under
 *   its level-2 heading (the panel wordmark owns level 1).
 * - Tier, kind and status are badges whose TEXT is the word itself, so colour
 *   is never the only carrier of meaning.
 * - The attributes table is the renderer's `DataTable`: grid ARIA, one Tab
 *   stop and roving arrow-key navigation. Every focusable control inside a cell
 *   (the block form of `Code`) carries `tabIndex={-1}`, as that primitive
 *   requires, and its arrow keys still scroll the block.
 * - Ancestors in the parent chain are real buttons; the selected event is the
 *   list's final item, marked `aria-current`. Activating an ancestor makes it
 *   the current event, which unmounts the button that held focus, so focus is
 *   moved to the newly shown event's name once it arrives rather than being
 *   dropped to the document body. Focus on opening and after closing the
 *   drawer belongs to the composition root, which owns the drawer's pane.
 * - A partial chain's first item is muted text, not a control, so the list's
 *   position count stays honest and nothing in it pretends to be selectable.
 *   The missing span id is `Code` behind a visible label, so it can be read
 *   and copied into a trace search.
 * - The parent-chain lookup announces itself politely: its loading row is a
 *   `role="status"` region, and its failure is an `ErrorState` rendered with
 *   `announce="polite"`, because it is a subsection of a drawer that loaded —
 *   the assertive alert stays reserved for the drawer's own failure.
 * - "Close" is a visible text button whose accessible name contains that text.
 *   Escape anywhere in the drawer closes it too, unless a control inside
 *   already consumed the key (the table's own Escape returns focus to its row).
 *
 * ## Design-system compliance (AAP 0.6.3, 0.6.4)
 *
 * Every visual value resolves through a renderer component and therefore
 * through the `--dg-*` tokens: no inline style, no length, no colour and no
 * class of this file's own. All spacing is a `Stack`/`Section` space step.
 * The raw elements used are the ones no primitive renders: the region's
 * `<section>`, the chain's `<ol>`/`<li>` and the start time's `<time>`. The
 * drawer creates no scroll container of its own — `PanelShell` is the only
 * `overflow: auto` element in the design system, `DataTable` brings its own
 * viewport and `Code`'s block form scrolls itself — so a pane-level scroll for
 * a tall drawer belongs to the `Split` pane that hosts it in `../App.tsx`.
 *
 * ## Boundaries
 *
 * Presentational: no transport of any kind (no `WebSocket`, `fetch`, HTTP
 * client or `chrome.runtime` port), no `chrome.*` access (it renders unchanged
 * with `chrome.devtools` undefined), no store writes and no schema validation.
 * The only outbound calls are the injected `onOpenSource` and `onSelectEvent`
 * (plus `onClose`, `onRetry` and `onRetryAncestry`). The ancestry arrives
 * already resolved: this component never fetches an ancestor itself, it only
 * states what the composition root found. Protocol, schema and shared imports
 * are types, apart from `assertNever`. The copy is generic product vocabulary:
 * every name, path and statement on screen is captured data (AAP 0.5.4).
 *
 * @example
 * // The composition root, with the actions built once by `createPanelActions`
 * // and the ancestry resolved across the stored trace for the selected event:
 * <EventDetails
 *   event={selectedEvent}
 *   ancestry={{ state: 'complete', ancestors: resolvedAncestors }}
 *   onRetryAncestry={retryAncestryLookup}
 *   onOpenSource={actions.onOpenSource}
 *   onSelectEvent={actions.onSelectEvent}
 *   onClose={actions.clearSelectedEvent}
 * />
 *
 * @module apps/chrome-extension/src/panel/components/EventDetails
 */
import {
  Badge,
  Button,
  Code,
  DataTable,
  DurationCell,
  EmptyState,
  ErrorState,
  Heading,
  LoadingState,
  Section,
  SourceLink,
  Stack,
  Text,
} from '@debuggen/panel-renderer';
import type { BadgeTone, DataTableColumn } from '@debuggen/panel-renderer';
import type { EventRef } from '@debuggen/panel-schema';
import type { TelemetryEvent } from '@debuggen/protocol';
import { assertNever } from '@debuggen/shared';
import type { SourceLocation, SourceResolvedBy } from '@debuggen/shared';
import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from 'react';

/*
 * ===========================================================================
 * Section A — public types
 * ===========================================================================
 */

/**
 * What the drawer is currently able to show about the selection.
 *
 * `idle` is the settled state: the event (or the absence of one) is final.
 * `loading` and `error` describe the composition root's resolution of the
 * selected reference into a stored event.
 */
export type EventDetailsStatus = 'idle' | 'loading' | 'error';

/**
 * The failure the error state reports.
 *
 * Structural, so a `DebuggenError` from `@debuggen/shared` and the protocol's
 * `error` payload are both assignable as they stand; `hint` and `code` are
 * shown when present.
 */
export interface EventDetailsError {
  /** One complete sentence describing what failed. */
  readonly message: string;
  /** The developer's next step, when one applies. */
  readonly hint?: string | undefined;
  /** The machine-readable failure code, when one applies. */
  readonly code?: string | undefined;
}

/**
 * What the composition root found when it looked up the selected event's
 * ancestors, which the Parent chain section states as it is (see the module
 * documentation for how each state renders). It is consulted only for an event
 * that names a `parentSpanId`; a trace root needs no lookup.
 *
 * In every state that carries `ancestors`, the list is ordered from the
 * topmost ancestor that was found down to the selected event's IMMEDIATE
 * parent, and an entry with the selected event's own id is ignored. The chain
 * is assumed to be linked in that order (each entry is the parent of the next);
 * it is never synthesised from `parentSpanId` alone.
 *
 * - `loading` — the lookup is in flight.
 * - `complete` — the chain reaches the trace root, which is its first entry.
 * - `missing` — the whole trace was read and `missingSpanId`, the first span
 *   id on the way up that no stored event carries, is not part of the capture.
 *   `ancestors` is the part of the chain below that gap: empty when the
 *   immediate parent itself is missing.
 * - `incomplete` — the lookup stopped at its page bound after reading
 *   `eventsRead` stored events of the trace without finding `missingSpanId`;
 *   `ancestors` as for `missing`.
 * - `cycle` — the recorded parent links loop; `ancestors` is the chain up to
 *   the loop.
 * - `error` — the lookup failed; `onRetryAncestry` retries it.
 *
 * @example
 * // The immediate parent was found; the span it names as its own parent
 * // (`grandparentSpanId`) is carried by no stored event of the trace:
 * const ancestry: EventAncestry = {
 *   state: 'missing',
 *   missingSpanId: grandparentSpanId,
 *   ancestors: [parent],
 * };
 */
export type EventAncestry =
  | { readonly state: 'loading' }
  | { readonly state: 'complete'; readonly ancestors: readonly TelemetryEvent[] }
  | {
      readonly state: 'missing';
      readonly missingSpanId: string;
      readonly ancestors: readonly TelemetryEvent[];
    }
  | {
      readonly state: 'incomplete';
      readonly missingSpanId: string;
      readonly ancestors: readonly TelemetryEvent[];
      readonly eventsRead: number;
    }
  | { readonly state: 'cycle'; readonly ancestors: readonly TelemetryEvent[] }
  | { readonly state: 'error'; readonly error: EventDetailsError };

/**
 * Props of {@link EventDetails}.
 *
 * Every optional member states `| undefined` explicitly, because
 * `exactOptionalPropertyTypes` is on repository-wide and the composition root
 * forwards values it may not have.
 */
export interface EventDetailsProps {
  /**
   * The selected event, as the store holds it, or `undefined` when nothing is
   * selected (the empty state).
   */
  event: TelemetryEvent | undefined;

  /**
   * Opens a source location in the editor. REQUIRED: this drawer renders
   * outside `PanelHost`, so without it the source chip would be an inert label
   * (see the module documentation). The location is passed by reference,
   * unmodified.
   */
  onOpenSource: (location: SourceLocation) => void;

  /**
   * The outcome of the selected event's ancestor lookup
   * ({@link EventAncestry}). Ignored for a trace root. Omitted for an event
   * that names a parent, the Parent chain section says the ancestors have not
   * been looked up — never that they are missing.
   */
  ancestry?: EventAncestry | undefined;

  /**
   * Retries a failed ancestor lookup — the retry action of the `error`
   * ancestry state, which renders only when this is given.
   */
  onRetryAncestry?: (() => void) | undefined;

  /**
   * Selects another event — raised when an ancestor in the parent chain is
   * activated. Omitted, ancestors render as plain text rather than as buttons
   * that could do nothing.
   */
  onSelectEvent?: ((ref: EventRef) => void) | undefined;

  /** The resolution state; defaults to `idle`. */
  status?: EventDetailsStatus | undefined;

  /** What failed, shown when `status` is `error`. */
  error?: EventDetailsError | undefined;

  /** Retries the failed resolution; the retry action renders only when given. */
  onRetry?: (() => void) | undefined;

  /** Closes the drawer; the "Close" control and Escape handling need it. */
  onClose?: (() => void) | undefined;

  /**
   * Extra classes for the region element. Composition only: any class named
   * here is a renderer class defined against the `--dg-*` tokens.
   */
  className?: string | undefined;
}

/*
 * ===========================================================================
 * Section B — copy and vocabularies
 *
 * Generic product wording only; everything a developer's project contributes
 * arrives as captured data at render time (AAP 0.5.4).
 * ===========================================================================
 */

/** The region's heading, and therefore its accessible name. */
const DRAWER_TITLE = 'Event details';

/** The visible text of the close control. */
const CLOSE_LABEL = 'Close';

/** The close control's accessible name; it contains {@link CLOSE_LABEL} (WCAG 2.5.3). */
const CLOSE_ACCESSIBLE_NAME = 'Close event details';

/** The empty state: nothing is selected yet. Specific to this drawer. */
const NO_SELECTION_MESSAGE =
  'Select an event in the panel — a timeline bar, a table row or an evidence chip — to see its timing, parent chain, attributes and source location here.';

/** The loading skeleton's announced label. */
const LOADING_LABEL = 'Loading event details';

/** The number of skeleton rows, matching the drawer's dense attribute rows. */
const LOADING_ROWS = 6;

/** The error state's title. */
const ERROR_TITLE = 'Could not load this event';

/** The error message used when the composition root reported no error object. */
const ERROR_FALLBACK_MESSAGE = 'The selected event could not be loaded from the capture.';

/** Subsection headings, all at level 3 under {@link DRAWER_TITLE}. */
const SOURCE_TITLE = 'Source';
const PARENT_CHAIN_TITLE = 'Parent chain';
const ATTRIBUTES_TITLE = 'Attributes';
const IDENTITY_TITLE = 'Identity';

/** Labels of the summary fields. */
const TIER_LABEL = 'Tier';
const KIND_LABEL = 'Kind';
const STATUS_LABEL = 'Status';
const DURATION_LABEL = 'Duration';
const STARTED_LABEL = 'Started';

/** The source section's text when no resolver could place the event. */
const NO_SOURCE_MESSAGE =
  'No source location was resolved for this event, so it cannot be opened in the editor.';

/** The parent-chain text for a trace root. */
const TRACE_ROOT_MESSAGE = 'This event is the root of its trace; it has no parent span.';

/**
 * The parent-chain text for an event that names a parent span when no lookup
 * outcome was supplied. Neutral on purpose: nothing is known yet, so nothing is
 * claimed missing.
 */
const ANCESTRY_NOT_LOOKED_UP_MESSAGE =
  'This event has a parent span; its ancestors have not been looked up yet.';

/** The parent-chain loading row's announced label. */
const ANCESTRY_LOADING_LABEL = 'Loading the parent chain';

/** The number of skeleton rows while the parent chain loads. */
const ANCESTRY_LOADING_ROWS = 1;

/** The parent-chain text for an event whose immediate parent never arrived. */
const MISSING_PARENT_MESSAGE =
  'This event names a parent span that is not part of the capture, so its ancestors are unknown.';

/** The parent-chain text when an ancestor, not the immediate parent, is missing. */
const MISSING_ANCESTOR_MESSAGE =
  'An ancestor of this event names a parent span that is not part of the capture, so the chain above it is unknown.';

/** The parent-chain text when the recorded parent links loop. */
const CYCLE_MESSAGE =
  'The recorded parent links of this trace form a loop, so the full ancestry of this event cannot be stated.';

/** The label of the copyable span id the chain stops at. */
const MISSING_SPAN_LABEL = 'Missing span ID';

/**
 * The first, non-interactive item of a partial chain, stating that the
 * ancestors above the first one shown are unknown — one wording per reason the
 * chain stops there.
 */
const UNKNOWN_ABOVE_MISSING_MARKER =
  'Ancestors above this point are unknown: a parent span is not part of the capture.';
const UNKNOWN_ABOVE_INCOMPLETE_MARKER =
  'Ancestors above this point are unknown: a parent span was not among the events read.';
const UNKNOWN_ABOVE_CYCLE_MARKER =
  'Ancestors above this point are unknown: the recorded parent links form a loop.';

/** The parent-chain failure's title. */
const ANCESTRY_ERROR_TITLE = 'Could not load the parent chain';

/** The parent-chain failure's message when the reported one has no text. */
const ANCESTRY_ERROR_FALLBACK_MESSAGE =
  'The ancestors of this event could not be looked up in the capture.';

/** Marks the selected event at the end of the parent chain. */
const CURRENT_EVENT_LABEL = 'selected';

/** The attributes table's accessible name. */
const ATTRIBUTES_CAPTION = 'Attributes of the selected event';

/** The attributes table's column headers. */
const ATTRIBUTE_KEY_HEADER = 'Attribute';
const ATTRIBUTE_VALUE_HEADER = 'Value';

/** The attributes table's empty content. */
const NO_ATTRIBUTES_MESSAGE = 'This event recorded no attributes.';

/** The note shown above the table when the privacy layer replaced any value. */
const REDACTION_NOTE =
  'Values marked redacted were replaced by the privacy layer before the event was stored.';

/** The badge text on a redacted attribute. */
const REDACTED_LABEL = 'redacted';

/** Shown for an identifier or a time that is absent or unusable. */
const NOT_AVAILABLE_LABEL = 'Not available';

/** Shown in place of the parent span id of a trace root. */
const NO_PARENT_SPAN_LABEL = 'None (trace root)';

/** Placeholders for attribute values that have no printable text of their own. */
const EMPTY_STRING_LABEL = 'Empty string';
const NO_VALUE_LABEL = 'No value';
const FUNCTION_VALUE_LABEL = 'Function (not serialisable)';

/** Written in place of a reference back to an object being serialised. */
const CIRCULAR_MARKER = '[Circular]';

/** Written in place of a function nested inside a serialised object. */
const FUNCTION_MARKER = '[Function]';

/** Shown when a structured value cannot be serialised at all. */
const UNSERIALISABLE_LABEL = 'Value could not be displayed';

/**
 * The length above which a single-line attribute value takes `Code`'s block
 * form. The block wraps and keeps every byte, where an inline fragment of that
 * length would dominate a dense row.
 */
const BLOCK_VALUE_MIN_LENGTH = 80;

/** Indentation of serialised structured values: two spaces, deterministic. */
const JSON_INDENT = 2;

/** One event's tier, kind and status: the three closed vocabularies it carries. */
type EventTier = TelemetryEvent['tier'];
type EventKind = TelemetryEvent['kind'];
type EventStatus = TelemetryEvent['status'];

/**
 * Tier to badge tone. Exhaustive over the imported union, so a tier added
 * upstream is a compile error here until it is given a tone. The badge text is
 * always the tier word itself; the tone is emphasis only.
 */
const TIER_TONE: Readonly<Record<EventTier, BadgeTone>> = {
  browser: 'info',
  server: 'accent',
  db: 'neutral',
};

/**
 * Kind to badge tone, exhaustive over the seventeen kinds. Tones group kinds
 * by what a reader should notice: the interaction root and patched functions
 * in the accent, React work in info, error kinds in danger, long tasks in
 * warning, and plain transport and timing records in neutral.
 */
const KIND_TONE: Readonly<Record<EventKind, BadgeTone>> = {
  interaction: 'accent',
  render: 'info',
  commit: 'info',
  fetch: 'neutral',
  xhr: 'neutral',
  navigation: 'neutral',
  'perf.longtask': 'warning',
  'perf.entry': 'neutral',
  error: 'danger',
  state: 'info',
  'http.server': 'neutral',
  'route.handler': 'neutral',
  function: 'accent',
  'db.query': 'neutral',
  'http.client': 'neutral',
  'server.error': 'danger',
  log: 'neutral',
};

/** Span status to badge tone, exhaustive over `unset`, `ok` and `error`. */
const STATUS_TONE: Readonly<Record<EventStatus, BadgeTone>> = {
  unset: 'neutral',
  ok: 'success',
  error: 'danger',
};

/**
 * How a location was resolved, in words, exhaustive over the resolution
 * routes (AAP 0.2.3), so the provenance of a chip is stated rather than hidden.
 */
const RESOLVED_BY_LABEL: Readonly<Record<SourceResolvedBy, string>> = {
  patch: 'the instrumentation patch',
  'code-graph': 'the code graph',
  'source-map': 'a source map',
  'react-owner': 'the React owner chain',
  'route-map': 'the route map',
};

/*
 * ===========================================================================
 * Section C — pure helpers
 *
 * Total over their inputs: none of them throws on an unexpected value, since a
 * single malformed attribute must not take the drawer down.
 * ===========================================================================
 */

/**
 * How one attribute value is shown: as captured text (inline, or in `Code`'s
 * block form when it is long or spans lines), or as a worded placeholder for a
 * value with no printable text of its own.
 */
type AttributeDisplay =
  | { readonly kind: 'text'; readonly text: string; readonly block: boolean }
  | { readonly kind: 'placeholder'; readonly text: string };

/** One row of the attributes table. */
interface AttributeRow {
  /** The attribute key, exactly as captured; also the row's identity. */
  readonly key: string;
  /** How its value renders. */
  readonly display: AttributeDisplay;
  /** Whether the privacy layer replaced this value, or a value nested in it. */
  readonly redacted: boolean;
}

/** Captured text, choosing the block form for a multi-line or long value. */
function textDisplay(text: string): AttributeDisplay {
  return {
    kind: 'text',
    text,
    block: text.includes('\n') || text.length > BLOCK_VALUE_MIN_LENGTH,
  };
}

/**
 * A `JSON.stringify` replacer that tolerates what JSON cannot express.
 *
 * A reference back to an object on the path being serialised becomes
 * {@link CIRCULAR_MARKER}; a shared object that is not an ancestor is
 * serialised normally at each occurrence. JSON.stringify calls a replacer with
 * `this` bound to the object holding the value, so unwinding the ancestor
 * stack to that holder leaves exactly the chain of containers enclosing it.
 * `bigint`, `symbol` and function values, which JSON would throw on or drop,
 * are written as text.
 */
function createCycleSafeReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];
  return function replace(this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === 'bigint') {
      return `${value.toString()}n`;
    }
    if (typeof value === 'symbol') {
      return value.toString();
    }
    if (typeof value === 'function') {
      return FUNCTION_MARKER;
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(value)) {
      return CIRCULAR_MARKER;
    }
    ancestors.push(value);
    return value;
  };
}

/**
 * Serialises an object or array deterministically: JSON with two-space
 * indentation and the insertion order of its keys, through the cycle-safe
 * replacer. A `toJSON` that throws, or one that yields nothing serialisable,
 * degrades to a placeholder.
 */
function describeStructuredValue(value: object): AttributeDisplay {
  try {
    const serialised: string | undefined = JSON.stringify(
      value,
      createCycleSafeReplacer(),
      JSON_INDENT,
    );
    return serialised === undefined
      ? { kind: 'placeholder', text: UNSERIALISABLE_LABEL }
      : textDisplay(serialised);
  } catch {
    return { kind: 'placeholder', text: UNSERIALISABLE_LABEL };
  }
}

/**
 * How an attribute value renders. Strings are shown exactly as captured;
 * numbers, booleans and big integers through `String`; `null` as `null`;
 * objects and arrays as deterministic JSON; values with no text of their own
 * as a worded placeholder — never an empty cell and never the word
 * "undefined".
 */
function describeAttributeValue(value: unknown): AttributeDisplay {
  if (typeof value === 'string') {
    return value.length === 0
      ? { kind: 'placeholder', text: EMPTY_STRING_LABEL }
      : textDisplay(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return textDisplay(String(value));
  }
  if (typeof value === 'symbol') {
    return textDisplay(value.toString());
  }
  if (typeof value === 'function') {
    return { kind: 'placeholder', text: FUNCTION_VALUE_LABEL };
  }
  if (value === null) {
    return textDisplay('null');
  }
  if (typeof value === 'object') {
    return describeStructuredValue(value);
  }
  return { kind: 'placeholder', text: NO_VALUE_LABEL };
}

/**
 * Whether the privacy layer replaced the value under `key`.
 *
 * The redactor records key-relative paths — `key`, `key.nested`, `key[0]` —
 * so a primitive value is redacted when its own key is listed, and a
 * container when its key or a path beneath it is. Restricting the prefix match
 * to containers keeps a dotted sibling key (`a` beside `a.b`) from inheriting
 * the other's marker.
 */
function isRedactedAttribute(
  key: string,
  value: unknown,
  redactedPaths: readonly string[] | undefined,
): boolean {
  if (redactedPaths === undefined || redactedPaths.length === 0) {
    return false;
  }
  const container = typeof value === 'object' && value !== null;
  return redactedPaths.some(
    (path) =>
      path === key || (container && (path.startsWith(`${key}.`) || path.startsWith(`${key}[`))),
  );
}

/**
 * The attributes table's rows, in the order the producer recorded the keys.
 * The set is local and complete, so no order is imposed on it.
 */
function buildAttributeRows(
  attributes: TelemetryEvent['attributes'],
  redactedPaths: readonly string[] | undefined,
): readonly AttributeRow[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    display: describeAttributeValue(value),
    redacted: isRedactedAttribute(key, value, redactedPaths),
  }));
}

/** A start time as local text, with its ISO form for the `<time>` element. */
interface FormattedInstant {
  readonly text: string;
  readonly iso: string | undefined;
}

/**
 * Formats epoch milliseconds as a readable local date and time with
 * millisecond precision, in the reader's locale and a 24-hour clock. An
 * unusable value reads {@link NOT_AVAILABLE_LABEL} and never a fabricated
 * date.
 */
function formatStartTime(epochMs: number): FormattedInstant {
  if (!Number.isFinite(epochMs)) {
    return { text: NOT_AVAILABLE_LABEL, iso: undefined };
  }
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) {
    return { text: NOT_AVAILABLE_LABEL, iso: undefined };
  }
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23',
    });
    return { text: formatter.format(date), iso: date.toISOString() };
  } catch {
    return { text: NOT_AVAILABLE_LABEL, iso: undefined };
  }
}

/** A resolver's confidence (0–1) as a whole percentage, or `undefined` when unusable. */
function formatConfidence(confidence: number): string | undefined {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return undefined;
  }
  return `${String(Math.round(confidence * 100))}%`;
}

/**
 * The reference an ancestor is selected by: its id, plus the coordinates and
 * kind it carries, so trace-scoped views can react without a lookup.
 */
function eventRefFor(event: TelemetryEvent): EventRef {
  return { eventId: event.id, traceId: event.traceId, spanId: event.spanId, kind: event.kind };
}

/**
 * The stored events an `incomplete` lookup read, as the object of "was not
 * among …": the count in the reader's locale with digit grouping, singular for
 * one. A count that is not a non-negative whole number is left out rather than
 * printed as a fabricated figure.
 */
function describeEventsRead(eventsRead: number): string {
  if (!Number.isSafeInteger(eventsRead) || eventsRead < 0) {
    return 'the stored events of this trace that were read';
  }
  const count = new Intl.NumberFormat(undefined, {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(eventsRead);
  return eventsRead === 1
    ? `the ${count} stored event of this trace that was read`
    : `the ${count} stored events of this trace that were read`;
}

/**
 * The parent-chain text for an `incomplete` lookup, naming the immediate
 * parent when that is the span that was not found and an ancestor's parent
 * otherwise.
 */
function incompleteAncestryMessage(immediateParentMissing: boolean, eventsRead: number): string {
  const subject = immediateParentMissing
    ? 'The parent span of this event'
    : 'A parent span further up the chain';
  return `${subject} was not among ${describeEventsRead(eventsRead)}, so the chain above it is not shown.`;
}

/** The ancestors without any entry carrying the selected event's own id. */
function withoutSelectedEvent(
  event: TelemetryEvent,
  ancestors: readonly TelemetryEvent[],
): readonly TelemetryEvent[] {
  return ancestors.filter((ancestor) => ancestor.id !== event.id);
}

/**
 * The ancestry the Parent chain section states, for an event that names
 * `parentSpanId`.
 *
 * Applies the tolerances of {@link EventAncestry} and refuses the
 * contradictions that would otherwise misstate the lineage:
 *
 * - every `ancestors` list loses entries carrying the selected event's id;
 * - a `complete` chain must reach a trace root: an empty one is `missing` at
 *   the event's own `parentSpanId`, and one whose first entry still names a
 *   parent is `missing` at that parent;
 * - a `missing` or `incomplete` gap at the event's own `parentSpanId` leaves no
 *   chain below it, so any `ancestors` supplied with it are dropped rather than
 *   shown as if they were linked to the selected event.
 */
function effectiveAncestry(
  event: TelemetryEvent,
  parentSpanId: string,
  ancestry: EventAncestry,
): EventAncestry {
  switch (ancestry.state) {
    case 'loading':
    case 'error':
      return ancestry;
    case 'complete': {
      const ancestors = withoutSelectedEvent(event, ancestry.ancestors);
      const top = ancestors[0];
      if (top === undefined) {
        return { state: 'missing', missingSpanId: parentSpanId, ancestors };
      }
      if (top.parentSpanId !== undefined) {
        return { state: 'missing', missingSpanId: top.parentSpanId, ancestors };
      }
      return { state: 'complete', ancestors };
    }
    case 'missing':
      return {
        state: 'missing',
        missingSpanId: ancestry.missingSpanId,
        ancestors:
          ancestry.missingSpanId === parentSpanId
            ? []
            : withoutSelectedEvent(event, ancestry.ancestors),
      };
    case 'incomplete':
      return {
        state: 'incomplete',
        missingSpanId: ancestry.missingSpanId,
        eventsRead: ancestry.eventsRead,
        ancestors:
          ancestry.missingSpanId === parentSpanId
            ? []
            : withoutSelectedEvent(event, ancestry.ancestors),
      };
    case 'cycle':
      return { state: 'cycle', ancestors: withoutSelectedEvent(event, ancestry.ancestors) };
    default:
      return assertNever(ancestry, 'Unhandled event ancestry state');
  }
}

/*
 * ===========================================================================
 * Section D — building blocks
 * ===========================================================================
 */

/** Props of {@link LabelledValue}. */
interface LabelledValueProps {
  readonly label: string;
  readonly children: ReactNode;
}

/**
 * A muted label followed by its value, on one wrapping line: the field pattern
 * the panel's other surfaces use, so the label is read before the value.
 */
function LabelledValue(props: LabelledValueProps): ReactElement {
  const { label, children } = props;
  return (
    <Stack direction="horizontal" gap={1} align="center" wrap>
      <Text size="xs" tone="muted">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

/** Props of {@link AttributeValue}. */
interface AttributeValueProps {
  readonly row: AttributeRow;
}

/**
 * One attribute value cell: the captured text in `Code` (block form, wrapping
 * and out of the Tab order, for a long or multi-line value), or a muted
 * placeholder, followed by a "redacted" badge when the privacy layer replaced
 * it.
 */
function AttributeValue(props: AttributeValueProps): ReactElement {
  const { row } = props;
  const { display } = row;

  let value: ReactElement;
  if (display.kind === 'placeholder') {
    value = (
      <Text size="sm" tone="muted">
        {display.text}
      </Text>
    );
  } else if (display.block) {
    // Focusable so it stays scrollable, but -1: the grid is the single Tab
    // stop and its arrow keys reach the block (DataTable's cell contract).
    value = (
      <Code block wrap size="sm" tabIndex={-1}>
        {display.text}
      </Code>
    );
  } else {
    value = (
      <Code size="sm" wrap>
        {display.text}
      </Code>
    );
  }

  if (!row.redacted) {
    return value;
  }

  const stacksBlock = display.kind === 'text' && display.block;
  return (
    <Stack
      direction={stacksBlock ? 'vertical' : 'horizontal'}
      gap={1}
      align={stacksBlock ? 'start' : 'center'}
      wrap={!stacksBlock}
    >
      {value}
      <Badge tone="warning" variant="outline">
        {REDACTED_LABEL}
      </Badge>
    </Stack>
  );
}

/**
 * The attributes table's two columns. Neither sorts: the rows are a complete
 * local object rendered in capture order, and `DataTable` never sorts locally.
 * Each width is the `DataTable` role for the column's content, never a length:
 * the attribute key is a short `label`; the value is a `name`, which takes the
 * larger share of the drawer's spare width and wraps inside its `Code` beyond
 * that. Both roles have a readable floor, so a drawer narrower than the two
 * scrolls the table instead of squeezing either column.
 */
const ATTRIBUTE_COLUMNS: readonly DataTableColumn<AttributeRow>[] = [
  {
    key: 'key',
    header: ATTRIBUTE_KEY_HEADER,
    rowHeader: true,
    sortable: false,
    width: 'label',
    cell: (row) => (
      <Code size="sm" wrap>
        {row.key}
      </Code>
    ),
  },
  {
    key: 'value',
    header: ATTRIBUTE_VALUE_HEADER,
    sortable: false,
    width: 'name',
    cell: (row) => <AttributeValue row={row} />,
  },
];

/** The attributes table's identity: the key, unique within one event. */
function attributeRowKey(row: AttributeRow): string {
  return row.key;
}

/** Props of {@link SourceDetails}. */
interface SourceDetailsProps {
  readonly source: SourceLocation | undefined;
  readonly onOpenSource: (location: SourceLocation) => void;
}

/**
 * The source chip, wired explicitly to the injected handler, with the
 * resolution route and confidence beneath it — or, when nothing resolved, a
 * sentence saying so and no chip at all (a chip that opens nothing is worse
 * than none).
 */
function SourceDetails(props: SourceDetailsProps): ReactElement {
  const { source, onOpenSource } = props;

  if (source === undefined) {
    return (
      <Text as="p" size="sm" tone="muted">
        {NO_SOURCE_MESSAGE}
      </Text>
    );
  }

  const confidence = formatConfidence(source.confidence);
  const provenance =
    confidence === undefined
      ? `Resolved by ${RESOLVED_BY_LABEL[source.resolvedBy]}.`
      : `Resolved by ${RESOLVED_BY_LABEL[source.resolvedBy]}, confidence ${confidence}.`;

  return (
    <Stack gap={1} align="start">
      <SourceLink location={source} onOpenSource={onOpenSource} />
      <Text as="p" size="xs" tone="muted">
        {provenance}
      </Text>
    </Stack>
  );
}

/** Props of {@link AncestorList}. */
interface AncestorListProps {
  readonly event: TelemetryEvent;
  /** Ordered from the topmost ancestor shown down to the immediate parent. */
  readonly ancestors: readonly TelemetryEvent[];
  /**
   * The first, non-interactive item of a partial chain, saying why the
   * ancestors above it are unknown; `undefined` for a chain that reaches the
   * trace root.
   */
  readonly unknownAboveMarker: string | undefined;
  readonly onSelectEvent: ((ref: EventRef) => void) | undefined;
}

/**
 * The known part of the selected event's ancestry as an ordered list, from the
 * topmost ancestor shown down to the selected event itself (the final,
 * `aria-current` item). A partial chain opens with a muted marker item; each
 * ancestor is a button selecting it when a selection handler exists, and plain
 * text otherwise.
 */
function AncestorList(props: AncestorListProps): ReactElement {
  const { event, ancestors, unknownAboveMarker, onSelectEvent } = props;

  return (
    // The list inherits the block's type role, so its numerals match the items.
    <Text as="div" size="sm">
      <ol>
        {unknownAboveMarker === undefined ? null : (
          <li>
            <Text size="sm" tone="muted">
              {unknownAboveMarker}
            </Text>
          </li>
        )}
        {ancestors.map((ancestor, index) => (
          // The index is part of the key: a malformed chain may repeat an id.
          <li key={`${String(index)}:${ancestor.id}`}>
            {onSelectEvent === undefined ? (
              <Text size="sm">
                {ancestor.name} <Badge tone={KIND_TONE[ancestor.kind]}>{ancestor.kind}</Badge>
              </Text>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onSelectEvent(eventRefFor(ancestor));
                }}
              >
                {ancestor.name} <Badge tone={KIND_TONE[ancestor.kind]}>{ancestor.kind}</Badge>
              </Button>
            )}
          </li>
        ))}
        <li aria-current="true">
          <Text size="sm" weight="medium">
            {event.name}
          </Text>{' '}
          <Badge tone={KIND_TONE[event.kind]}>{event.kind}</Badge>{' '}
          <Text size="xs" tone="muted">
            ({CURRENT_EVENT_LABEL})
          </Text>
        </li>
      </ol>
    </Text>
  );
}

/** Props of {@link ChainGap}. */
interface ChainGapProps {
  readonly event: TelemetryEvent;
  /** Why the chain stops, as one sentence. */
  readonly message: string;
  /** The span id the chain stops at, shown copyably; omitted for a loop. */
  readonly missingSpanId: string | undefined;
  /** The known part of the chain below the gap, possibly empty. */
  readonly ancestors: readonly TelemetryEvent[];
  /** The partial list's first item, used only when `ancestors` is non-empty. */
  readonly unknownAboveMarker: string;
  readonly onSelectEvent: ((ref: EventRef) => void) | undefined;
}

/**
 * A chain that stops short of the trace root: the sentence saying why, the
 * span id it stops at as copyable text, and — when anything below the gap is
 * known — the partial list, opened by its marker item. The parts are siblings
 * so the enclosing `Section`'s space step separates them.
 */
function ChainGap(props: ChainGapProps): ReactElement {
  const { event, message, missingSpanId, ancestors, unknownAboveMarker, onSelectEvent } = props;

  return (
    <>
      <Text as="p" size="sm" tone="muted">
        {message}
      </Text>
      {missingSpanId === undefined ? null : (
        <LabelledValue label={MISSING_SPAN_LABEL}>
          <Code size="sm" wrap>
            {missingSpanId}
          </Code>
        </LabelledValue>
      )}
      {ancestors.length === 0 ? null : (
        <AncestorList
          event={event}
          ancestors={ancestors}
          unknownAboveMarker={unknownAboveMarker}
          onSelectEvent={onSelectEvent}
        />
      )}
    </>
  );
}

/** Props of {@link ParentChain}. */
interface ParentChainProps {
  readonly event: TelemetryEvent;
  readonly ancestry: EventAncestry | undefined;
  readonly onSelectEvent: ((ref: EventRef) => void) | undefined;
  readonly onRetryAncestry: (() => void) | undefined;
}

/**
 * The Parent chain section's content for the shown event: the trace-root
 * sentence, the not-looked-up sentence, or the state of the supplied ancestry
 * (see the module documentation), after {@link effectiveAncestry} has applied
 * its tolerances.
 */
function ParentChain(props: ParentChainProps): ReactElement {
  const { event, ancestry, onSelectEvent, onRetryAncestry } = props;
  const { parentSpanId } = event;

  if (parentSpanId === undefined) {
    return (
      <Text as="p" size="sm" tone="muted">
        {TRACE_ROOT_MESSAGE}
      </Text>
    );
  }

  if (ancestry === undefined) {
    return (
      <Text as="p" size="sm" tone="muted">
        {ANCESTRY_NOT_LOOKED_UP_MESSAGE}
      </Text>
    );
  }

  const shown = effectiveAncestry(event, parentSpanId, ancestry);
  switch (shown.state) {
    case 'loading':
      return (
        <LoadingState variant="rows" rows={ANCESTRY_LOADING_ROWS} label={ANCESTRY_LOADING_LABEL} />
      );
    case 'complete':
      return (
        <AncestorList
          event={event}
          ancestors={shown.ancestors}
          unknownAboveMarker={undefined}
          onSelectEvent={onSelectEvent}
        />
      );
    case 'missing':
      return (
        <ChainGap
          event={event}
          message={
            shown.missingSpanId === parentSpanId ? MISSING_PARENT_MESSAGE : MISSING_ANCESTOR_MESSAGE
          }
          missingSpanId={shown.missingSpanId}
          ancestors={shown.ancestors}
          unknownAboveMarker={UNKNOWN_ABOVE_MISSING_MARKER}
          onSelectEvent={onSelectEvent}
        />
      );
    case 'incomplete':
      return (
        <ChainGap
          event={event}
          message={incompleteAncestryMessage(
            shown.missingSpanId === parentSpanId,
            shown.eventsRead,
          )}
          missingSpanId={shown.missingSpanId}
          ancestors={shown.ancestors}
          unknownAboveMarker={UNKNOWN_ABOVE_INCOMPLETE_MARKER}
          onSelectEvent={onSelectEvent}
        />
      );
    case 'cycle':
      return (
        <ChainGap
          event={event}
          message={CYCLE_MESSAGE}
          missingSpanId={undefined}
          ancestors={shown.ancestors}
          unknownAboveMarker={UNKNOWN_ABOVE_CYCLE_MARKER}
          onSelectEvent={onSelectEvent}
        />
      );
    case 'error':
      return (
        <ErrorState
          title={ANCESTRY_ERROR_TITLE}
          message={
            shown.error.message.trim() === ''
              ? ANCESTRY_ERROR_FALLBACK_MESSAGE
              : shown.error.message
          }
          hint={shown.error.hint}
          code={shown.error.code}
          announce="polite"
          onRetry={onRetryAncestry}
        />
      );
    default:
      return assertNever(shown, 'Unhandled event ancestry state');
  }
}

/** One copyable identifier of the identity block. */
interface IdentityField {
  readonly label: string;
  readonly value: string;
  /** Whether the value is a number (tabular figures); identifiers are not. */
  readonly numeric: boolean;
}

/**
 * The correlation identifiers a developer copies into a log search or a bug
 * report, in the order they join the event to the rest of the capture.
 */
function identityFieldsFor(event: TelemetryEvent): readonly IdentityField[] {
  return [
    { label: 'Event ID', value: event.id, numeric: false },
    { label: 'Trace ID', value: event.traceId, numeric: false },
    { label: 'Span ID', value: event.spanId, numeric: false },
    {
      label: 'Parent span ID',
      value: event.parentSpanId ?? NO_PARENT_SPAN_LABEL,
      numeric: false,
    },
    { label: 'Producer ID', value: event.producerId, numeric: false },
    { label: 'Producer sequence', value: String(event.seq), numeric: true },
    { label: 'Ingest sequence', value: String(event.ingestSeq), numeric: true },
    {
      label: 'Start (epoch ms)',
      value: Number.isFinite(event.startTime) ? String(event.startTime) : NOT_AVAILABLE_LABEL,
      numeric: true,
    },
    { label: 'Capture ID', value: event.captureId, numeric: false },
  ];
}

/** Props of {@link EventDetailsBody}. */
interface EventDetailsBodyProps {
  readonly event: TelemetryEvent;
  readonly ancestry: EventAncestry | undefined;
  readonly onRetryAncestry: (() => void) | undefined;
  readonly onOpenSource: (location: SourceLocation) => void;
  readonly onSelectEvent: ((ref: EventRef) => void) | undefined;
  /**
   * Receives the event-name element, which is programmatically focusable so
   * focus can land on the newly shown event after a parent-chain navigation.
   */
  readonly nameRef: RefObject<HTMLElement | null>;
}

/**
 * The drawer's content for one event: the summary (name, tier, kind and
 * status badges, duration, start time) followed by the Source, Parent chain,
 * Attributes and Identity sections.
 *
 * A component of its own so the memoised derivations below run
 * unconditionally, as hooks must, only when there is an event to derive from.
 */
function EventDetailsBody(props: EventDetailsBodyProps): ReactElement {
  const { event, ancestry, onRetryAncestry, onOpenSource, onSelectEvent, nameRef } = props;

  const started = useMemo(() => formatStartTime(event.startTime), [event.startTime]);
  const attributeRows = useMemo(
    () => buildAttributeRows(event.attributes, event.redacted),
    [event.attributes, event.redacted],
  );
  const identityFields = useMemo(() => identityFieldsFor(event), [event]);
  const anyRedacted = attributeRows.some((row) => row.redacted);

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        {/* The captured span name, verbatim; a label, not the region's name.
            Out of the Tab order, but focusable by script: it is where focus
            goes after an ancestor in the parent chain is selected. */}
        <Text as="p" size="lg" weight="medium" tabIndex={-1} ref={nameRef}>
          {event.name}
        </Text>
        <Stack direction="horizontal" gap={3} align="center" wrap>
          <LabelledValue label={TIER_LABEL}>
            <Badge tone={TIER_TONE[event.tier]}>{event.tier}</Badge>
          </LabelledValue>
          <LabelledValue label={KIND_LABEL}>
            <Badge tone={KIND_TONE[event.kind]}>{event.kind}</Badge>
          </LabelledValue>
          <LabelledValue label={STATUS_LABEL}>
            <Badge tone={STATUS_TONE[event.status]}>{event.status}</Badge>
          </LabelledValue>
        </Stack>
        <Stack direction="horizontal" gap={3} align="center" wrap>
          <LabelledValue label={DURATION_LABEL}>
            <DurationCell ms={event.duration} severity="auto" />
          </LabelledValue>
          <LabelledValue label={STARTED_LABEL}>
            <Text size="sm" numeric>
              <time dateTime={started.iso}>{started.text}</time>
            </Text>
          </LabelledValue>
        </Stack>
      </Stack>

      <Section title={SOURCE_TITLE} headingLevel={3} gap={2}>
        <SourceDetails source={event.source} onOpenSource={onOpenSource} />
      </Section>

      {/* Rendered for every event, so a root, a missing parent and a chain
          not looked up yet are three different statements. */}
      <Section title={PARENT_CHAIN_TITLE} headingLevel={3} gap={2}>
        <ParentChain
          event={event}
          ancestry={ancestry}
          onSelectEvent={onSelectEvent}
          onRetryAncestry={onRetryAncestry}
        />
      </Section>

      <Section title={ATTRIBUTES_TITLE} headingLevel={3} gap={2}>
        {anyRedacted ? (
          <Text as="p" size="xs" tone="muted">
            {REDACTION_NOTE}
          </Text>
        ) : null}
        <DataTable
          rows={attributeRows}
          columns={ATTRIBUTE_COLUMNS}
          rowKey={attributeRowKey}
          caption={ATTRIBUTES_CAPTION}
          compact
          empty={<EmptyState message={NO_ATTRIBUTES_MESSAGE} />}
        />
      </Section>

      <Section title={IDENTITY_TITLE} headingLevel={3} gap={2}>
        <Stack gap={1}>
          {identityFields.map((field) => (
            <LabelledValue key={field.label} label={field.label}>
              <Code size="sm" wrap numeric={field.numeric}>
                {field.value}
              </Code>
            </LabelledValue>
          ))}
        </Stack>
      </Section>
    </Stack>
  );
}

/*
 * ===========================================================================
 * Section E — the component
 * ===========================================================================
 */

/**
 * The right drawer explaining one selected event: its badges, timing, source
 * chip, parent chain, attributes and identifiers — or the empty, loading or
 * error state that stands in for them.
 *
 * @param props See {@link EventDetailsProps}.
 * @returns The labelled region holding the drawer's heading and current state.
 */
export function EventDetails(props: EventDetailsProps): ReactElement {
  const {
    event,
    onOpenSource,
    ancestry,
    onRetryAncestry,
    onSelectEvent,
    status = 'idle',
    error,
    onRetry,
    onClose,
    className,
  } = props;

  const headingId = useId();

  // Focus continuity for parent-chain navigation. Activating an ancestor turns
  // that ancestor into the drawer's current event, so the button that held
  // focus unmounts and focus would fall back to the document body. The id the
  // developer asked for is remembered here, in the component that stays
  // mounted while the composition root resolves it (possibly through a loading
  // state), and focus moves to the new event's name once that event is shown.
  const nameRef = useRef<HTMLElement | null>(null);
  const pendingFocusIdRef = useRef<string | undefined>(undefined);

  const handleSelectAncestor = useMemo(
    () =>
      onSelectEvent === undefined
        ? undefined
        : (ref: EventRef): void => {
            pendingFocusIdRef.current = ref.eventId;
            onSelectEvent(ref);
          },
    [onSelectEvent],
  );

  const shownEventId = event?.id;
  useEffect(() => {
    const pendingId = pendingFocusIdRef.current;
    // Still resolving: keep the request until the outcome is known.
    if (pendingId === undefined || status === 'loading') {
      return;
    }
    pendingFocusIdRef.current = undefined;
    // The requested event arrived; any other outcome (an error, a different
    // selection made elsewhere) leaves focus where the developer put it.
    if (status === 'idle' && shownEventId === pendingId) {
      nameRef.current?.focus();
    }
  }, [shownEventId, status]);

  // Escape closes the drawer, unless something inside already answered it —
  // the attributes grid, for one, spends Escape on returning focus to its row.
  // The key is consumed here so DevTools does not also toggle its own drawer.
  const handleKeyDown = useCallback(
    (keyEvent: ReactKeyboardEvent<HTMLElement>): void => {
      if (
        onClose === undefined ||
        keyEvent.key !== 'Escape' ||
        keyEvent.defaultPrevented ||
        keyEvent.nativeEvent.isComposing
      ) {
        return;
      }
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      onClose();
    },
    [onClose],
  );

  let content: ReactElement;
  switch (status) {
    case 'loading':
      content = <LoadingState variant="rows" rows={LOADING_ROWS} label={LOADING_LABEL} />;
      break;
    case 'error':
      content = (
        <ErrorState
          title={ERROR_TITLE}
          message={error?.message ?? ERROR_FALLBACK_MESSAGE}
          hint={error?.hint}
          code={error?.code}
          onRetry={onRetry}
        />
      );
      break;
    case 'idle':
      content =
        event === undefined ? (
          <EmptyState message={NO_SELECTION_MESSAGE} />
        ) : (
          <EventDetailsBody
            event={event}
            ancestry={ancestry}
            onRetryAncestry={onRetryAncestry}
            onOpenSource={onOpenSource}
            onSelectEvent={handleSelectAncestor}
            nameRef={nameRef}
          />
        );
      break;
    default:
      return assertNever(status, 'Unhandled event details status');
  }

  return (
    <section aria-labelledby={headingId} className={className} onKeyDown={handleKeyDown}>
      <Stack gap={4}>
        <Stack direction="horizontal" gap={2} align="center" justify="between">
          <Heading level={2} id={headingId}>
            {DRAWER_TITLE}
          </Heading>
          {onClose === undefined ? null : (
            <Button variant="ghost" size="sm" aria-label={CLOSE_ACCESSIBLE_NAME} onClick={onClose}>
              {CLOSE_LABEL}
            </Button>
          )}
        </Stack>
        {content}
      </Stack>
    </section>
  );
}
