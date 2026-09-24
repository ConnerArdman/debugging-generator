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
 *                              `Section`s for Source, Parent chain (only when a
 *                              chain was supplied), Attributes (`DataTable`) and
 *                              Identity.
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
 * (plus `onClose` and `onRetry`). Protocol, schema and shared imports are
 * types, apart from `assertNever`. The copy is generic product vocabulary:
 * every name, path and statement on screen is captured data (AAP 0.5.4).
 *
 * @example
 * // The composition root, with the actions built once by `createPanelActions`:
 * <EventDetails
 *   event={selectedEvent}
 *   parentChain={ancestors}
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
   * The selected event's ancestors, ordered from the trace root to its
   * immediate parent. Omitted, no parent-chain section renders; the chain is
   * never synthesised from `parentSpanId` alone. An entry with the selected
   * event's own id is ignored, so a chain that ends with the event itself is
   * accepted too.
   */
  parentChain?: readonly TelemetryEvent[] | undefined;

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

/** The parent-chain text for an event whose parent never arrived. */
const MISSING_PARENT_MESSAGE =
  'This event names a parent span that is not part of the capture, so its ancestors are unknown.';

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
 * The tracks are `ch` minimums sharing the free width, as the table requires.
 */
const ATTRIBUTE_COLUMNS: readonly DataTableColumn<AttributeRow>[] = [
  {
    key: 'key',
    header: ATTRIBUTE_KEY_HEADER,
    rowHeader: true,
    sortable: false,
    width: 'minmax(14ch, 1fr)',
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
    width: 'minmax(18ch, 2fr)',
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

/** Props of {@link ParentChain}. */
interface ParentChainProps {
  readonly event: TelemetryEvent;
  readonly chain: readonly TelemetryEvent[];
  readonly onSelectEvent: ((ref: EventRef) => void) | undefined;
}

/**
 * The selected event's ancestry as an ordered list, from the trace root down
 * to the selected event itself (the final, `aria-current` item). Each ancestor
 * is a button selecting it when a selection handler exists, and plain text
 * otherwise. An empty chain states whether the event is a trace root or names
 * a parent the capture does not hold.
 */
function ParentChain(props: ParentChainProps): ReactElement {
  const { event, chain, onSelectEvent } = props;
  const ancestors = chain.filter((ancestor) => ancestor.id !== event.id);

  if (ancestors.length === 0) {
    return (
      <Text as="p" size="sm" tone="muted">
        {event.parentSpanId === undefined ? TRACE_ROOT_MESSAGE : MISSING_PARENT_MESSAGE}
      </Text>
    );
  }

  return (
    // The list inherits the block's type role, so its numerals match the items.
    <Text as="div" size="sm">
      <ol>
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
  readonly parentChain: readonly TelemetryEvent[] | undefined;
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
  const { event, parentChain, onOpenSource, onSelectEvent, nameRef } = props;

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

      {parentChain === undefined ? null : (
        <Section title={PARENT_CHAIN_TITLE} headingLevel={3} gap={2}>
          <ParentChain event={event} chain={parentChain} onSelectEvent={onSelectEvent} />
        </Section>
      )}

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
    parentChain,
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
            parentChain={parentChain}
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
