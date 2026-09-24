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
 * raises `onOpenSource`, the host carries it to the coordination service, the
 * service validates the path against the session's project root, and the editor
 * opens the document with a selection. **The object this component hands to the
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
 * nearest host's `PanelActions`, then nothing:
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
 *     that asks for it owns the keyboard route to the same intent — a command
 *     on its focused item that calls `onOpenSource` with the same location —
 *     and must advertise that command (for example with `aria-keyshortcuts`).
 *   - `0`, or omitting the prop, is the browser's own order for a button: the
 *     standalone chip of a summary header or a detail drawer.
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
 *                                accent text on `--dg-surface-elevated`
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
 * The interactive form's accessible name is built from the location alone and
 * states the action: `Open <file>:<line>:<column>`. It is deliberately
 * independent of `label`, `showSymbol` and `compact`, so shortening what a
 * sighted reader sees never changes which place the control announces. The
 * glyph is `aria-hidden` and is never the name. Hover is not the only route to
 * the full path: a closed tooltip bubble keeps its text in the accessibility
 * tree, which is what makes the inert form's full location reachable too.
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
import { NOT_AVAILABLE_LABEL, formatCompactPath, formatSourceTooltip } from '../utils/format';

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
   * symbol run, since the caller is stating the whole caption; the accessible
   * name and the tooltip still name the location in full, so nothing is lost by
   * shortening what is on screen.
   */
  label?: string | undefined;

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
   * item of a composite widget — a tree row, a grid row — whose roving tab stop
   * is the item itself; `0` or omitted for a standalone chip.
   *
   * Forwarded to the `<button>` of the interactive form only; the inert form
   * is never focusable and ignores it. A caller passing `-1` owns the keyboard
   * route to the same intent (see this module's header).
   */
  tabIndex?: 0 | -1 | undefined;
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
 * <SourceLink location={location} label="Open the handler" onOpenSource={open} />
 * ```
 * @example A chip inside a tree row, where the row is the only tab stop.
 * ```tsx
 * <SourceLink location={row.source} compact tabIndex={-1} />
 * ```
 */
export function SourceLink(props: SourceLinkProps): ReactElement {
  const {
    location,
    label,
    showSymbol = true,
    compact = false,
    className,
    onOpenSource,
    tabIndex,
  } = props;

  // The prop wins; the host is the fallback; `undefined` is a normal value that
  // selects the inert form. Reading the context is unconditional, as a hook must
  // be, and safe outside a provider by that module's documented contract.
  const actions = usePanelActions();
  const openSource = onOpenSource ?? actions?.onOpenSource;

  // `location` is closed over and passed on by reference - the single guarantee
  // this component exists to keep. The dependency list is what makes the
  // identity correct rather than merely current: a row re-keyed to another
  // location gets a callback bound to that location.
  const handleClick = useCallback((): void => {
    openSource?.(location);
  }, [openSource, location]);

  const lineResolved = isResolvedCoordinate(location.line);
  const positionResolved = lineResolved && isResolvedCoordinate(location.column);

  // The canonical target: the shared package's own spelling when both
  // coordinates resolved, and the same shape with the unresolved one named when
  // they did not. This is the accessible name's object and the tooltip's
  // fallback, so the path is never shortened here.
  const target = positionResolved
    ? formatSourceLocation(location)
    : `${location.file}:${coordinateText(location.line)}:${coordinateText(location.column)}`;

  // The description a tooltip shows: the shared helper's symbol-first form,
  // which is also what a row linking to the same place titles itself with, so
  // the two cannot drift apart.
  const description = positionResolved ? formatSourceTooltip(location) : target;

  // The visible path. Shortening belongs to the format helpers - this file joins
  // the line to whichever shape they returned and performs no other string work.
  const visiblePath = compact ? basenamePosix(location.file) : formatCompactPath(location.file);
  const derivedText = lineResolved ? `${visiblePath}:${String(location.line)}` : visiblePath;
  const chipText = label ?? derivedText;

  const symbolText = label === undefined && showSymbol && !compact ? location.symbol : undefined;

  // Wrap in a tooltip exactly when the chip is not already showing everything
  // the description would: a caller's caption replaced the path, the path lost
  // ancestors, the line could not be shown, or a known symbol is hidden.
  const abbreviated =
    label !== undefined ||
    visiblePath !== location.file ||
    !lineResolved ||
    (location.symbol !== undefined && symbolText === undefined);

  const chipClass = clsx(
    'dg-source-link',
    compact && 'dg-source-link--compact',
    openSource === undefined && 'dg-is-static',
    className,
  );

  // One content node for both forms, so the inert chip is the interactive chip
  // minus its control - same runs, same classes, same order.
  const content: ReactNode = (
    <>
      <FileCode aria-hidden="true" className="dg-icon dg-source-link__icon" />
      {symbolText === undefined ? null : (
        <Code size="sm" className="dg-source-link__symbol">
          {symbolText}
        </Code>
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
        aria-label={`Open ${target}`}
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
