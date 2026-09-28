/**
 * `SourceLink` — the click-to-source chip: a monospace pill naming a file, a
 * line and, when one is known, the symbol at that position (AAP 0.6.2).
 *
 * This module is the component behind the node catalog's `sourceLink` type, and
 * it is the chip every other view in this folder embeds on a row that resolved
 * to a location, plus the chip the summary header hangs off a likely cause.
 *
 * ## THE LOCATION IS FORWARDED UNMODIFIED
 *
 * A chip is hop 1 of the product's click-to-source chain (AAP 0.4.2): the chip
 * raises `onOpenSource` — the host's `PanelActions.openSource` itself — the
 * host carries the location to the coordination service, the service validates
 * the path against the session's project root, and the editor opens the
 * document with a selection. **The object this component hands to the
 * handler is the very object it was given** — not a copy, not a spread, not a
 * normalised path, not a rounded line, and never with `symbol`, `endLine`,
 * `resolvedBy` or `confidence` dropped.
 *
 * That is a deliberate non-goal, for the reasons `../host/PanelActions` records
 * at length: every axis on the wire is 1-based and the single subtraction that
 * turns a line into an editor position lives in the editor extension, so
 * arithmetic here is how an off-by-one reaches a developer; and containment is
 * enforced where it can be — by the schema that parsed the location, by the
 * service against the project root, and independently by the editor's URI
 * handler. A fourth, weaker copy of either job in a leaf component would make
 * the chip disagree with the evidence it was rendered from. Acceptance test 1
 * (AAP 0.8.4) passes only while the location that arrives is the location that
 * leaves.
 *
 * ## THREE FORMS, ONE OF THEM INERT
 *
 * A handler is resolved in a fixed order — the `onOpenSource` prop, then the
 * nearest host's actions (read through `usePanelActions`, which always yields
 * the view form, so its `onOpenSource` is the host's `openSource` whichever
 * form the host supplied), then nothing:
 *
 *   1. **Interactive.** A real `<button>` (the `Button` primitive, `ghost`
 *      variant, `sm` size), so activation, focus order, Enter and Space are the
 *      browser's own and no key handler re-implements them.
 *   2. **Inert.** No handler could be resolved, so the same chip content
 *      renders in a plain `<span>` carrying `dg-is-static`: no `role`, no
 *      `tabIndex`, no click handler. A chip that cannot open anything must read
 *      as a label rather than as a control that silently does nothing — which
 *      is also why this module exports no no-op handler.
 *   3. Either of the above, wrapped in `Tooltip` when the visible text is
 *      abbreviated, so the full `file:line:column` is always reachable.
 *
 * ## INSIDE A COMPOSITE WIDGET, THE CHIP IS NOT A TAB STOP
 *
 * A tree, a grid or a list with a roving tab index is ONE stop in the page's
 * Tab order: the composite moves focus between its own items with the arrow
 * keys, and every control nested inside an item that stays in the Tab order is
 * a second, third or fourth stop per row that the pattern forbids. The chip
 * therefore accepts `tabIndex`, restricted to `0` and `-1`, and forwards it to
 * the interactive form's `<button>` and nowhere else:
 *
 *   - `-1` takes the chip out of the Tab order while keeping it a real,
 *     pointer-activatable, programmatically focusable button. The composite
 *     that asks for it owns the keyboard route to the same intent: either it
 *     moves focus onto the chip itself (a grid's cell navigation, below), or
 *     it offers a command on its focused item that calls `onOpenSource` with
 *     the same location and advertises it (for example with
 *     `aria-keyshortcuts`).
 *   - `0`, or omitting the prop, is the browser's own order for a button: the
 *     standalone chip of a summary header or a detail drawer.
 *
 * Inside a `DataTable` cell, the caller passes `tabIndex={-1}`: the grid is the
 * page's single Tab stop, and its own arrow-key cell navigation is what moves
 * focus onto the chip, after which Enter and Space activate the `<button>`
 * natively. The index reaches the `<button>` in both interactive shapes — bare,
 * and wrapped in `Tooltip` when the visible text is abbreviated — because the
 * tooltip clones its trigger with a merged `aria-describedby` and nothing else.
 *
 * There is deliberately no automatic default: the chip never infers `-1` from
 * an enclosing grid, tree or list, because only the composite knows whether it
 * owns a keyboard route to the chip, and a chip that silently left the Tab
 * order inside a composite without one would be unreachable from the keyboard.
 *
 * A positive index is not offered: it reorders the whole page's Tab sequence
 * and is never what a leaf chip means. The inert form ignores the prop
 * entirely, because a label is never focusable in the first place.
 *
 * **Rendering without a host must never throw.** The summary header imports
 * this component and imports nothing from `../host`, and the editor webview
 * renders it with no provider mounted at all. `usePanelActions` answers
 * `undefined` outside a provider by documented contract (see that module), so
 * the absent host is an ordinary value here, resolved with `?.`, and the inert
 * form is what a surface that cannot navigate gets.
 *
 * ## NO QUERY, THEREFORE NO EMPTY / LOADING / ERROR STATE
 *
 * Every query-backed view in this folder owes the reader those three states.
 * This node carries no `DataQuery` — its content was resolved before the panel
 * was assembled — so it touches no `DataProvider`, imports no `useQuery`, and
 * has nothing to be pending or failed about. Its degenerate cases are the two
 * above: no handler (the inert form) and no symbol (`file:line` alone). Keeping
 * a transport dependency out of the leaf that nine other components embed by
 * the row is the point.
 *
 * ## A COORDINATE THAT DID NOT RESOLVE SAYS SO
 *
 * A validated location always carries a 1-based integer line and column. This
 * component is nevertheless total over the shape: a chip built from an object
 * that never passed the schema must not print `file:NaN`, and must not print
 * `0` either, since `0` is a position that exists and would send the editor
 * somewhere. An unresolved coordinate is therefore omitted from the visible
 * chip and spelled `NOT_AVAILABLE_LABEL` — this package's single spelling of
 * "not available" — in the full label.
 *
 * ## APPEARANCE IS A CLASS CONTRACT, NEVER AN INLINE STYLE (AAP 0.6.4)
 *
 * This file declares class names and nothing else. There is no inline style
 * object, no colour, no length and no literal CSS value anywhere in it; every
 * declaration behind the names below lives in `../styles/components.css` and
 * resolves to a `--dg-*` token, so a theme change is a cascade change:
 *
 *   `dg-source-link`             the block: the shared chip pill, monospace,
 *                                accent text on `--dg-surface-elevated`, at
 *                                least `--dg-space-7` (24 px) tall in both
 *                                forms — the interactive chip's pointer target
 *                                (WCAG 2.2 SC 2.5.8), mirrored by the inert one
 *                                so a row never changes height with the form
 *   `dg-source-link--compact`    the dense variant a table row embeds
 *   `dg-source-link__icon`       the leading glyph
 *   `dg-source-link__symbol`     the symbol run, in primary text
 *   `dg-source-link__file`       the `file:line` run, truncating
 *   `dg-is-static`               the inert state
 *
 * Two global utilities of `../styles/base.css` are reused and never redefined:
 * `dg-icon`, which gives the glyph its font-relative square, its
 * `currentColor` and its inertness, and — through `Tooltip` — the
 * `dg-visually-hidden` box that keeps a closed bubble's text in the
 * accessibility tree. The caller's `className` is composed last.
 *
 * ## ACCESSIBILITY
 *
 * The interactive form's accessible name states the action and always ends
 * with the full location it opens, and it always contains the text a sighted
 * reader sees on the chip (WCAG 2.5.3, label in name), so a speech-input user
 * can activate the chip by saying what is written on it. One rule, computed by
 * {@link sourceLinkAccessibleName} and nowhere else:
 *
 *   - The visible text is what the button renders, in DOM order: the symbol run
 *     when it is shown, then the chip text, joined by a single space.
 *   - When `Open <file>:<line>:<column>` already contains that text (compared
 *     lowercased with whitespace collapsed) — the compact `file:line` chip a row
 *     embeds — the name is exactly that.
 *   - Otherwise — a symbol run, a compacted directory, a caller's `label` — the
 *     name is `<visible text> — open <file>:<line>:<column>`: it starts with
 *     what is on screen and still ends with the place it opens.
 *
 * The DOM carries the same single space between the symbol run and the path
 * run, so the text an accessibility checker reads off the button is the
 * visible text this rule compared; the chip's flex layout does not render a
 * whitespace-only run, so the space changes nothing on screen. The glyph is
 * `aria-hidden` and is never part of either. Hover is not the only route to
 * the full path: a closed tooltip bubble keeps its text in the accessibility
 * tree, which is what makes the inert form's full location reachable too.
 *
 * ## WHAT THE CHIP SAYS IS THE LOGICAL TEXT
 *
 * A path, a symbol and a caller's caption are untrusted: an invisible Unicode
 * direction control in one of them (U+202E and its eleven siblings) would draw
 * the characters after it in an order that was never captured, so a chip could
 * read as one place and open another. Every string the chip shows, describes or
 * announces is therefore derived in its revealed form — each control printed as
 * its visible escape, `\u202E`, by `formatUntrustedText` — BEFORE any of them
 * is compared or joined. That is what keeps the abbreviation test, the
 * tooltip's de-duplication and the naming rule above true for such a value:
 * each compares display text with display text, and
 * {@link sourceLinkAccessibleName} returns the name the button actually
 * carries. Only the text is revealed. The location handed to `onOpenSource` is
 * still the very object received, raw code points and all.
 *
 * @see ../host/PanelActions for the interaction contract and hop 2 of the chain.
 * @see ../utils/format for the path, chip and tooltip text this file composes.
 * @see ../styles/components.css for the implementation of the classes above.
 */

import type { SourceLocation } from '@debuggen/shared';
import { basenamePosix, formatSourceLocation } from '@debuggen/shared';
import clsx from 'clsx';
import { FileCode } from 'lucide-react';
import { useCallback } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { usePanelActions } from '../host/PanelActions';
import { Button } from '../primitives/Button';
import { Code } from '../primitives/Code';
import { Tooltip } from '../primitives/Tooltip';
import {
  NOT_AVAILABLE_LABEL,
  formatCompactPath,
  formatSourceTooltip,
  formatUntrustedText,
} from '../utils/format';

/**
 * Whether a line or column can be shown as a position.
 *
 * A coordinate is usable when it is a finite integer of at least one, which is
 * exactly what the shared schema guarantees and what the editor can act on. The
 * check exists for the objects that reach a renderer without passing that
 * schema — a hand-built fixture, a value cast in a consumer — and it is what
 * keeps `NaN`, `undefined`, a fraction and a zero out of the rendered chip.
 */
function isResolvedCoordinate(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** A coordinate as text, or the package's "not available" label when it is not one. */
function coordinateText(value: number): string {
  return isResolvedCoordinate(value) ? String(value) : NOT_AVAILABLE_LABEL;
}

/**
 * The props of {@link SourceLink}.
 *
 * Every optional prop spells `| undefined`, as the primitives in this package
 * do: `exactOptionalPropertyTypes` is in force repository-wide, and a caller
 * forwarding a value it may not have — `label={row.caption}` on a row whose
 * caption is optional — has to remain legal.
 */
export interface SourceLinkProps {
  /**
   * Where in the project this chip points.
   *
   * The one required prop, and the object that travels the click path: it is
   * handed to the resolved handler by reference, exactly as received.
   */
  location: SourceLocation;

  /**
   * Replaces the chip's derived text.
   *
   * For the caller that has a better caption than a path — a phrase beside a
   * hypothesis, a column's own wording. A label also suppresses the separate
   * symbol run, since the caller is stating the whole caption. The accessible
   * name leads with the label and still ends with the location in full, and the
   * tooltip names it too, so nothing is lost by shortening what is on screen —
   * which is also why a label should describe the place the chip opens.
   */
  label?: string | undefined;

  /**
   * The whole caption a `label` stands for, when the caller had to shorten it
   * to fit its column - a long component or operation name cut to a preview.
   *
   * It changes only the tooltip: the description then leads with this caption,
   * `<caption> — <symbol-first location>`, so the value the chip abbreviates
   * stays reachable by hover and by keyboard focus (the bubble is bounded and
   * scrolls, see `../primitives/Tooltip`). A location whose own description
   * already contains the caption - its symbol is the same name - keeps that
   * description as it is. The visible text and the accessible name are
   * unchanged - the name still leads with what is on screen (WCAG 2.5.3) - and
   * it has no effect without a `label`.
   */
  labelDescription?: string | undefined;

  /**
   * Show the location's `symbol` as its own run before the path. Defaults to
   * `true`, and has no effect when the location carries no symbol, when a
   * `label` was supplied, or when `compact` is set.
   */
  showSymbol?: boolean | undefined;

  /**
   * The dense form a table, timeline or tree row embeds: the file name and line
   * only, with the symbol and the directory context suppressed. Defaults to
   * `false`, which keeps one parent directory for the reader who has two files
   * of the same name.
   */
  compact?: boolean | undefined;

  /** Extra class names, composed after this component's own. */
  className?: string | undefined;

  /**
   * Handles activation, taking precedence over the nearest host's
   * `PanelActions`. When neither is available the chip renders inert.
   */
  onOpenSource?: ((location: SourceLocation) => void) | undefined;

  /**
   * The interactive chip's place in the Tab order. `-1` for a chip nested in an
   * item of a composite widget — a tree row, a grid row, a `DataTable` cell —
   * whose roving tab stop is the item itself, and whose arrow keys reach the
   * chip; `0` or omitted for a standalone chip. Never inferred: a caller that
   * does not pass it gets the browser's own order.
   *
   * Forwarded to the `<button>` of the interactive form only, whether or not
   * that button is wrapped in the abbreviation tooltip; the inert form is never
   * focusable and ignores it. A caller passing `-1` owns the keyboard route to
   * the same intent (see this module's header).
   */
  tabIndex?: 0 | -1 | undefined;
}

/**
 * The props of {@link SourceLink} that decide what the chip says: its visible
 * runs, its tooltip and its accessible name. Everything else — the handler,
 * the Tab index, the class — changes how the chip behaves, never its text.
 */
export type SourceLinkTextInputs = Pick<
  SourceLinkProps,
  'location' | 'label' | 'labelDescription' | 'showSymbol' | 'compact'
>;

/**
 * Everything the chip shows and announces, derived from {@link SourceLinkTextInputs}.
 *
 * Every string member is display text, with its direction controls revealed
 * (see "What the chip says is the logical text" in the module header).
 */
interface SourceLinkText {
  /**
   * The canonical `file:line:column` the chip opens, never shortened: the
   * accessible name's object and the tooltip's fallback.
   */
  readonly target: string;

  /** The tooltip's text. */
  readonly description: string;

  /** The symbol run, or `undefined` when none is rendered. */
  readonly symbolText: string | undefined;

  /** The path run: the caller's label, or the visible path and the line. */
  readonly chipText: string;

  /** Whether the chip hides part of its description and so needs the tooltip. */
  readonly abbreviated: boolean;
}

/**
 * Derives the chip's text from its inputs, applying the component's defaults.
 *
 * The one derivation behind both the rendered runs and
 * {@link sourceLinkAccessibleName}, so what the chip shows and what it
 * announces are computed from the same strings and cannot drift apart.
 *
 * Every input string is revealed (`formatUntrustedText`) before it is compared
 * or joined — the two format helpers used here already return revealed text —
 * so no decision below weighs a raw value against a revealed one: a path with
 * a direction control in it is not "abbreviated" merely because its display
 * differs from its code points, and a caption is recognised inside the
 * location's own description however it was spelled. The primitives that
 * render these strings reveal them again, which changes nothing: revealing is
 * idempotent.
 *
 * @param inputs The text-bearing props, as the component receives them.
 * @returns The runs, the target, the description and the abbreviation flag.
 */
function deriveSourceLinkText(inputs: SourceLinkTextInputs): SourceLinkText {
  const { location, label, labelDescription, showSymbol = true, compact = false } = inputs;

  const lineResolved = isResolvedCoordinate(location.line);
  const positionResolved = lineResolved && isResolvedCoordinate(location.column);

  // The path as a reader sees it whole: the baseline the visible path is
  // compared against, and the head of the target when a coordinate is missing.
  const file = formatUntrustedText(location.file);

  // The canonical target: the shared package's own spelling when both
  // coordinates resolved, and the same shape with the unresolved one named when
  // they did not. This is the accessible name's object and the tooltip's
  // fallback, so the path is never shortened here.
  const target = positionResolved
    ? formatUntrustedText(formatSourceLocation(location))
    : `${file}:${coordinateText(location.line)}:${coordinateText(location.column)}`;

  // The description a tooltip shows: the shared helper's symbol-first form,
  // which is also what a row linking to the same place titles itself with, so
  // the two cannot drift apart. A shortened label's whole caption leads it, so
  // the value the chip abbreviates is never lost - unless the location's own
  // description already carries it (a symbol of the same name), which would
  // otherwise say it twice.
  const locationDescription = positionResolved ? formatSourceTooltip(location) : target;
  const caption =
    labelDescription === undefined ? undefined : formatUntrustedText(labelDescription);
  const description =
    label !== undefined &&
    caption !== undefined &&
    caption.trim() !== '' &&
    !locationDescription.includes(caption)
      ? `${caption} — ${locationDescription}`
      : locationDescription;

  // The visible path. Shortening belongs to the format helpers - this file joins
  // the line to whichever shape they returned and performs no other string work.
  const visiblePath = compact
    ? formatUntrustedText(basenamePosix(location.file))
    : formatCompactPath(location.file);
  const derivedText = lineResolved ? `${visiblePath}:${String(location.line)}` : visiblePath;
  const chipText = label === undefined ? derivedText : formatUntrustedText(label);

  const symbolText =
    label === undefined && showSymbol && !compact && location.symbol !== undefined
      ? formatUntrustedText(location.symbol)
      : undefined;

  // Wrap in a tooltip exactly when the chip is not already showing everything
  // the description would: a caller's caption replaced the path, the path lost
  // ancestors, the line could not be shown, or a known symbol is hidden.
  const abbreviated =
    label !== undefined ||
    visiblePath !== file ||
    !lineResolved ||
    (location.symbol !== undefined && symbolText === undefined);

  return { target, description, symbolText, chipText, abbreviated };
}

/** Runs of whitespace, collapsed to one space before any name comparison. */
const WHITESPACE_RUN = /\s+/g;

/**
 * Text as a reader perceives it: whitespace runs collapsed to one space and
 * trimmed, the way a rendered line and an accessible name both present it.
 */
function collapseWhitespace(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * The accessible name of the interactive chip built from these inputs.
 *
 * The chip's single naming rule (WCAG 2.5.3, label in name), exported so a
 * surface's tests can name the chip exactly as it is named rather than
 * restating the rule; the component itself calls this function.
 *
 *   1. The visible text is what the button renders, in DOM order: the symbol
 *      run when it is shown, then the chip text, joined by a single space.
 *   2. The base name is `Open <target>`, the target being the full
 *      `file:line:column`, an unresolved coordinate spelled
 *      `NOT_AVAILABLE_LABEL`.
 *   3. When the base name contains the visible text — both lowercased, with
 *      whitespace collapsed — the name is the base name.
 *   4. Otherwise it is `<visible text> — open <target>`: it starts with what is
 *      on screen, so a speech-input user can say it, and it still ends with the
 *      full location the chip opens.
 *
 * Every part is display text: a direction control in the path, the symbol or
 * the caption appears as its visible escape (`\u202E`), exactly as the chip
 * prints it and as the button's `aria-label` carries it.
 *
 * Pure: it reads nothing but its argument, and the inert form, which has no
 * accessible name of its own, never uses it.
 *
 * @param inputs The chip's text-bearing props, with the component's defaults
 * (`showSymbol` true, `compact` false) applied when omitted.
 * @returns The accessible name the interactive chip announces.
 *
 * @example The compact chip a row embeds keeps the plain form.
 * ```ts
 * sourceLinkAccessibleName({ location, compact: true });
 * // location src/example/Widget.tsx:28:17 → "Open src/example/Widget.tsx:28:17"
 * ```
 * @example A chip showing its symbol and a compacted path leads with both.
 * ```ts
 * sourceLinkAccessibleName({ location });
 * // → "renderWidget …/example/Widget.tsx:28 — open src/example/Widget.tsx:28:17"
 * ```
 */
export function sourceLinkAccessibleName(inputs: SourceLinkTextInputs): string {
  const { target, symbolText, chipText } = deriveSourceLinkText(inputs);

  const visibleText = collapseWhitespace(
    symbolText === undefined ? chipText : `${symbolText} ${chipText}`,
  );
  const baseName = `Open ${target}`;

  return collapseWhitespace(baseName).toLowerCase().includes(visibleText.toLowerCase())
    ? baseName
    : `${visibleText} — open ${target}`;
}

/**
 * A pointer into the developer's project, rendered as a chip that opens the
 * file at that line in their editor.
 *
 * @param props The props, as documented on {@link SourceLinkProps}.
 * @returns The chip: interactive when a handler is available, inert when not,
 * wrapped in a tooltip when its visible text is abbreviated.
 *
 * @example A row's location, in the dense form, opening through the host.
 * ```tsx
 * <SourceLink location={item.source} compact />
 * ```
 * @example A standalone chip with an explicit handler and its own caption.
 * ```tsx
 * <SourceLink location={location} label="The widget's click handler" onOpenSource={open} />
 * ```
 * @example A chip inside a tree row or a `DataTable` cell, where the composite
 * is the only tab stop and its arrow keys move focus onto the chip.
 * ```tsx
 * <SourceLink location={row.source} compact tabIndex={-1} />
 * ```
 */
export function SourceLink(props: SourceLinkProps): ReactElement {
  const {
    location,
    label,
    labelDescription,
    showSymbol = true,
    compact = false,
    className,
    onOpenSource,
    tabIndex,
  } = props;

  // The prop wins; the host is the fallback; `undefined` is a normal value that
  // selects the inert form. Reading the context is unconditional, as a hook must
  // be, and safe outside a provider by that module's documented contract. The
  // hook answers in the view form, so a host that supplied `openSource` is
  // reached through `onOpenSource` here with the same location object.
  const actions = usePanelActions();
  const openSource = onOpenSource ?? actions?.onOpenSource;

  // `location` is closed over and passed on by reference - the single guarantee
  // this component exists to keep. The dependency list is what makes the
  // identity correct rather than merely current: a row re-keyed to another
  // location gets a callback bound to that location.
  const handleClick = useCallback((): void => {
    openSource?.(location);
  }, [openSource, location]);

  // What the chip shows, and what it announces, from the same inputs through
  // the same derivation: the name is the exported rule's own answer, so a test
  // that names a chip with that helper names it exactly as this render does.
  const textInputs: SourceLinkTextInputs = {
    location,
    label,
    labelDescription,
    showSymbol,
    compact,
  };
  const { description, symbolText, chipText, abbreviated } = deriveSourceLinkText(textInputs);
  const accessibleName = sourceLinkAccessibleName(textInputs);

  const chipClass = clsx(
    'dg-source-link',
    compact && 'dg-source-link--compact',
    openSource === undefined && 'dg-is-static',
    className,
  );

  // One content node for both forms, so the inert chip is the interactive chip
  // minus its control - same runs, same classes, same order. The single space
  // after the symbol run is the separator the naming rule joins the runs with:
  // it puts the words apart in the text an accessibility checker reads off the
  // button, and the chip's inline-flex layout renders no whitespace-only run,
  // so the gap on screen stays the token-driven one.
  const content: ReactNode = (
    <>
      <FileCode aria-hidden="true" className="dg-icon dg-source-link__icon" />
      {symbolText === undefined ? null : (
        <>
          <Code size="sm" className="dg-source-link__symbol">
            {symbolText}
          </Code>{' '}
        </>
      )}
      <Code size="sm" className="dg-source-link__file">
        {chipText}
      </Code>
    </>
  );

  const chip =
    openSource === undefined ? (
      <span className={chipClass}>{content}</span>
    ) : (
      <Button
        variant="ghost"
        size="sm"
        className={chipClass}
        aria-label={accessibleName}
        onClick={handleClick}
        // Spread only when given, so an omitted index leaves the button's own
        // Tab order untouched rather than writing an explicit attribute.
        {...(tabIndex === undefined ? {} : { tabIndex })}
      >
        {content}
      </Button>
    );

  return abbreviated ? <Tooltip content={description}>{chip}</Tooltip> : chip;
}
