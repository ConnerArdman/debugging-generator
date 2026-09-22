/**
 * `Toolbar` — the filter, sort and search bar of `@debuggen/panel-renderer`.
 *
 * ## What this layout primitive is for
 *
 * AAP 0.6.2 lists "`Toolbar` (filters, sort, search)" among the layout
 * primitives "every panel composes from (no panel hand-rolls layout)", and the
 * node catalog leans on it by name twice: the event log is filtered "by
 * kind/text via `Toolbar`", and the sortable tables put their sort control in
 * the same row. This is that row. An interactive visualization component mounts
 * one above its body, hands it the controls it needs, and gets a bar that
 * reads and behaves identically in every other node of a generated panel —
 * which is the whole point of a design system whose panels are assembled by a
 * generator rather than by a designer.
 *
 * Four kinds of control fit in it, each optional and each independent:
 *
 *   1. one text search, rendered by the text-entry primitive,
 *   2. any number of option filters — a sort order, an event kind, a tier —
 *      rendered by the picker primitive,
 *   3. any number of action chips, rendered by the button primitive,
 *   4. any number of result indicators, rendered by the badge primitive,
 *
 * plus an escape hatch for a bespoke control and an optional keyboard-shortcut
 * hint. A bar with none of them is legal and renders an empty block: a
 * component that has nothing to offer yet must not have to branch around this
 * one.
 *
 * ## Fully controlled, and nothing more
 *
 * Every value this bar shows arrives as a prop and every change leaves through
 * a callback. It holds no state, keeps no draft of the search text, debounces
 * nothing, sorts nothing, filters nothing and remembers nothing between
 * renders. What it renders is exactly what it was handed.
 *
 * That is not stylistic. AAP 0.1.2's architecture directive against coupling a
 * UI component to transport implementation details, plus AAP 0.6.2's rule that
 * a component "reaches data exclusively through the
 * `DataProvider`/`PanelActions` interfaces", mean the bar must not know what
 * its controls are for. So there is no data query in this file, no query
 * builder, no `onQueryChange`, no socket, no HTTP call and no timer: the caller
 * translates a user's intent into whatever its own layer does with it. A
 * consequence worth stating, because it looks like a bug when it is not: a
 * caller that does not feed a changed value back sees the control snap to the
 * value it still holds, which is the correct behaviour for a filter whose state
 * lives in the surface around it.
 *
 * ## It ships no copy
 *
 * Not one string in this module reaches the screen. Every label, placeholder,
 * option label, action label, status label and shortcut key is supplied by the
 * caller, and there is no default for any of them — the same stance the empty
 * and error placeholders of this package take, and for the same reason: AAP
 * 0.5.4 forbids application vocabulary anywhere in the product's own code, so a
 * design-system file that shipped the word a filter is called would be encoding
 * knowledge of the thing being debugged.
 *
 * ## Schema-agnostic by construction
 *
 * The vocabularies this bar is pointed at in practice — the sort orders of a
 * panel specification's data query, which live in `@debuggen/panel-schema`, and
 * the event kinds and tiers of a capture, which live in `@debuggen/telemetry` —
 * are deliberately absent here, and this module imports neither package. An
 * option list arrives as the picker primitive's own plain option type, built by
 * the caller from its own domain vocabulary and mapped back from the chosen
 * string by the same caller. That is what lets the editor webview — which has
 * no panel specification in scope at all — mount the identical bar, and it is
 * why no union of schema values appears anywhere in this signature.
 *
 * ## Composition only
 *
 * Every visible element comes from `../primitives`: the text field, the picker,
 * the button, the badge, the shortcut chip and the typographic run around it.
 * There is not a single raw form control, `label` element or table element in
 * this file, because AAP 0.6.4 puts "library primitives over raw `button`,
 * `input`, `select`, `table` and heading elements" ahead of everything except
 * accessibility — this file is on the providing side of that rule, so breaking
 * it here would break it for every panel at once. The only elements authored
 * here are the section wrappers, which carry a class and no style.
 *
 * ## Grouping, and the role this bar does not take
 *
 * When the caller names the bar it becomes a labelled group, which is what
 * lets assistive technology announce "filters" (or whatever the caller calls
 * it) before its controls. Unnamed, it stays a plain container: an accessible
 * name is the caller's to supply, and inventing one would be shipping copy.
 *
 * The ARIA `toolbar` role is deliberately NOT used. That role commits its
 * container to being a single tab stop with roving-`tabindex` arrow-key
 * navigation between its controls, and this bar implements none of that: every
 * control here is an ordinary tab stop, exactly as the platform made it. A role
 * whose promised keyboard contract is unimplemented is worse for a screen
 * reader user than no role at all, because it announces a way of driving the
 * bar that does not work. AAP 0.6.4 asks for ARIA roles on the tree, table and
 * tab-list patterns specifically, and a filter bar is none of those.
 *
 * Nothing else about focus is touched: no `tabIndex` is set, no key event is
 * intercepted, no focus is moved. Each primitive keeps its own real label, so
 * the bar needs no description wiring of its own either.
 *
 * ## Class-name contract implemented by `../styles/components.css`
 *
 * This file contributes class names only — no inline style, no length, no
 * colour, no font, no shadow. The stylesheet is the defining side; the table
 * below is its specification for this block.
 *
 * | Class                  | Role                                                |
 * | ---------------------- | --------------------------------------------------- |
 * | `dg-toolbar`           | block: the bar itself                               |
 * | `dg-toolbar__search`   | element: the text-search slot, the growing section  |
 * | `dg-toolbar__controls` | element: the option filters and the sort control    |
 * | `dg-toolbar__group`    | element: the caller's own controls (`children`)     |
 * | `dg-toolbar__actions`  | element: the action chips                           |
 * | `dg-toolbar__status`   | element: the result and count indicators            |
 * | `dg-toolbar__hint`     | element: the keyboard-shortcut hint                 |
 * | `dg-toolbar--compact`  | variant: tighter gap and padding                    |
 * | `dg-toolbar--wrap`     | variant: the sections may break internally too      |
 *
 * Three facts about those rules matter to anyone reading the markup below:
 *
 *   - The bar WRAPS at narrow widths rather than scrolling horizontally. A
 *     DevTools panel is routinely around four hundred pixels wide, and the
 *     panel shell's viewport is the only `overflow: auto` container in a
 *     rendered panel; a second horizontal scroller inside it would hide
 *     controls behind a gesture nobody looks for. `dg-toolbar--wrap` goes one
 *     step further and lets the individual sections break internally as well,
 *     for the narrowest surfaces.
 *   - A wrapper element is emitted only when its section has content, so the
 *     stylesheet never has to style — or reserve the gap around — an empty box.
 *   - Spacing is the block's `gap`, never a margin between siblings, which is
 *     what keeps a wrapped bar's rows evenly spaced.
 *
 * `dg-toolbar__spacer` exists in that stylesheet for a bar composed by hand and
 * is intentionally not emitted here. The search section is the one that grows,
 * so on the panel widths this design system targets it consumes the free space
 * and the sections after it sit at the inline end; past the cap the stylesheet
 * puts on its inline size, the remaining sections pack toward the start with
 * the slack trailing them. Both are correct: a filter bar reads left to right,
 * and nothing in it is positioned relative to the bar's end.
 *
 * @see ../primitives/Input for the text field's controlled contract.
 * @see ../primitives/Select for the option type and the flat-list contract.
 * @see ../primitives/Button for the accessible-name contract of an icon chip.
 * @see ../styles/components.css for the rules the classes above resolve to.
 */

import clsx from 'clsx';
import type { ReactElement, ReactNode } from 'react';

import { Badge, type BadgeTone, type BadgeVariant } from '../primitives/Badge';
import { Button, type ButtonVariant } from '../primitives/Button';
import { Input } from '../primitives/Input';
import { Kbd } from '../primitives/Kbd';
import { Select, type SelectOption } from '../primitives/Select';
import { Text } from '../primitives/Text';

/**
 * Whether a caller-supplied node is worth a wrapper element.
 *
 * `undefined`, `null`, a boolean (what `{condition && <X />}` yields when the
 * condition is false) and the empty string all mean "this section is not
 * present", so none of them produces an empty section wrapper in the DOM.
 *
 * @param node The node as the caller passed it, if at all.
 * @returns `true` when the node would render something.
 */
function isRenderableNode(node: ReactNode): boolean {
  return node !== null && node !== undefined && typeof node !== 'boolean' && node !== '';
}

/**
 * Whether an optional string carries text worth rendering.
 *
 * An absent value, an empty string and a whitespace-only string are treated
 * alike, so a caller forwarding an optional value it may not have gets the same
 * result as one that omitted the prop — and no indicator is ever rendered as a
 * blank pill.
 *
 * It is a type predicate, so the narrowed `string` can be handed to a primitive
 * that requires one with no cast and no non-null assertion.
 *
 * @param value The prop as the caller passed it, if at all.
 * @returns `true` when the value is a string with non-whitespace content.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * The text-search control of a bar: what it shows, where its changes go and
 * what it is called.
 *
 * Fully controlled, like the field that renders it: the bar keeps no draft of
 * the text and applies no debounce, so a caller that wants either owns it. Two
 * keystrokes of latency belong to the layer that knows how expensive the query
 * behind them is — which is never this one.
 *
 * Every optional member spells `| undefined`, as every optional prop in this
 * package does: `exactOptionalPropertyTypes` is in force repository-wide
 * (tsconfig.base.json), and a caller forwarding a value it may not have must
 * remain legal.
 */
export interface ToolbarSearch {
  /** The text the field shows. */
  value: string;

  /**
   * Raised on every keystroke with the full next string.
   *
   * The next value, not a DOM event: nothing about the change path lets a
   * consumer treat this bar as the owner of the text.
   */
  onValueChange: (next: string) => void;

  /**
   * The field's accessible name, rendered as a real label bound to the control.
   *
   * REQUIRED, and not by accident: the text-entry primitive requires a real
   * label element and explicitly refuses to degrade to an `aria-label`, because
   * a field whose only name is an attribute loses the enlarged hit area a label
   * gives a pointer user. In a bar with no room for visible text, pass
   * `labelHidden` — the primitive then applies the package's visually-hidden
   * utility and the name survives in the accessibility tree.
   */
  label: string;

  /**
   * Hint text inside the empty field, forwarded unchanged.
   *
   * There is no default: a placeholder is content, and this module ships none.
   * It is never a substitute for {@link ToolbarSearch.label}, which is why it
   * cannot be supplied without one.
   */
  placeholder?: string | undefined;

  /**
   * Take the label out of the visual surface while keeping it in the
   * accessibility tree. Defaults to `false`, which shows it.
   */
  labelHidden?: boolean | undefined;
}

/**
 * One option filter of a bar — a sort order, an event kind, a tier, or whatever
 * vocabulary the caller is filtering by.
 *
 * The caller builds the option list, which is the mechanism that keeps this
 * file free of every schema package (see the module note): a sort vocabulary
 * from the panel schema and a kind vocabulary from the telemetry package both
 * arrive here as the picker primitive's plain option type.
 *
 * An EMPTY `options` array is a legitimate state — a filter over values a
 * capture has not produced yet — and is passed straight through, because the
 * picker primitive tolerates it and renders an empty control rather than
 * pretending a choice exists. It is never guarded away here and never filled
 * with a substitute option.
 */
export interface ToolbarSelect {
  /**
   * A stable identity for this filter within the bar, used as the React key of
   * the rendered control.
   *
   * It is NOT forwarded as a DOM `id`: the picker primitive generates and owns
   * the id that binds its label to its control, and overwriting that from here
   * would let two bars rendered from one configuration publish the same id
   * twice. A caller that must address the element should render its own control
   * through {@link ToolbarProps.children}.
   */
  id: string;

  /**
   * The control's accessible name, rendered as a real label bound to it.
   * Required for the same reason the search field's is; use `labelHidden` in a
   * bar with no room for it.
   */
  label: string;

  /** The currently selected option's value. */
  value: string;

  /** The options, in the order they are offered. */
  options: readonly SelectOption[];

  /** Raised with the newly chosen option's value. */
  onValueChange: (next: string) => void;

  /**
   * Take the label out of the visual surface while keeping it in the
   * accessibility tree. Defaults to `false`, which shows it.
   */
  labelHidden?: boolean | undefined;
}

/**
 * One action chip of a bar — a reset, a re-run, a toggle between two views, an
 * export.
 *
 * The action is the caller's: this bar calls {@link ToolbarAction.onSelect} and
 * has no opinion about what happens next, so an action that mutates a query, an
 * action that opens a drawer and an action that does nothing at all are equally
 * legal here.
 */
export interface ToolbarAction {
  /** A stable identity within the bar, used as the React key of the chip. */
  id: string;

  /**
   * The chip's label, and its accessible name.
   *
   * It is rendered as the button's content in the normal form and moved into
   * the package's visually-hidden utility by the button primitive when
   * {@link ToolbarAction.iconOnly} is set — which is why an icon-only chip
   * still announces something, and why the label is required in both forms.
   */
  label: string;

  /** Raised when the chip is activated by pointer, keyboard or assistive tech. */
  onSelect: () => void;

  /**
   * A leading glyph, supplied by the caller.
   *
   * Pass it already carrying the package's global icon class —
   * `icon={<SomeGlyph className="dg-icon" />}` — so it takes its square and its
   * `currentColor` from the base stylesheet and scales with the chip's type
   * role. Never pass an icon library's numeric size or colour prop: those are
   * hardcoded values, which AAP 0.6.4 forbids. This module imports no icon
   * library at all, so every glyph in a bar is the caller's choice.
   */
  icon?: ReactNode | undefined;

  /** The chip's visual weight. Defaults to the button primitive's own default. */
  variant?: ButtonVariant | undefined;

  /**
   * The chip is a toggle, and this is its current state.
   *
   * It drives two signals from one prop, so what a reader sees and what a
   * screen reader hears cannot drift apart: `aria-pressed` on the control, and
   * the design system's pressed state on its surface. Neither is the only
   * indicator (AAP 0.6.4), which matters most for an icon-only chip — a glyph
   * that looks identical on and off is unusable.
   *
   * Omit it for a chip that performs an action instead of holding a state:
   * `aria-pressed` on a one-shot control tells a screen reader user there is a
   * state to toggle when there is not.
   */
  pressed?: boolean | undefined;

  /**
   * Make the chip inert, through the native disabled attribute rather than an
   * ARIA attribute, so it is genuinely unfocusable. Defaults to `false`.
   */
  disabled?: boolean | undefined;

  /**
   * Render the glyph alone, with the label kept for assistive technology only —
   * the square chip form a dense bar uses. Defaults to `false`.
   *
   * Pair it with {@link ToolbarAction.icon}: an icon-only chip with no glyph is
   * a blank square, which this bar cannot detect for the caller because a glyph
   * is any node at all.
   */
  iconOnly?: boolean | undefined;
}

/**
 * One result indicator of a bar — a match count, a filtered-out count, a
 * truncation notice, a live-capture marker.
 *
 * It is a statement, not a control: it takes no click handler, and a caller
 * that wants an activatable pill is describing an action
 * ({@link ToolbarAction}) instead. The whole text is the caller's; an indicator
 * whose label is blank is skipped rather than rendered as an empty pill.
 */
export interface ToolbarStatus {
  /** The indicator's text, rendered as the pill's content. */
  label: string;

  /**
   * The semantic tone. Defaults to the badge primitive's own neutral default.
   *
   * Tone is never the only signal — the label carries the meaning — which is
   * what keeps an indicator readable in the high-contrast theme and to a reader
   * who cannot distinguish the hues.
   */
  tone?: BadgeTone | undefined;

  /** The pill's fill treatment. Defaults to the badge primitive's own default. */
  variant?: BadgeVariant | undefined;
}

/**
 * The inputs of one bar.
 *
 * Every section is optional and every combination renders sensibly, including
 * none at all: a component that has only a search box passes only `search`, and
 * gets exactly one section wrapper and no empty siblings.
 *
 * What this interface deliberately does NOT have, and why each absence is load
 * bearing:
 *
 *   - It does not extend React's `HTMLAttributes`. The prop list is the
 *     contract; a bar that accepted arbitrary attributes would let a caller set
 *     the role this component refuses (see the module note) or re-label a group
 *     from two places.
 *   - No `style` prop and no component-scoped custom property. Every value this
 *     bar takes is in the stylesheet (AAP 0.6.4: zero hardcoded CSS values).
 *   - No `ref`. There is nothing in a bar to focus or measure that is not one of
 *     the controls the caller already owns, and the bar moves no focus itself.
 *   - No data query, no `onQueryChange`, no debounce interval, no sort state.
 *     Those belong to the caller (AAP 0.1.2).
 */
export interface ToolbarProps {
  /**
   * An accessible name for the bar as a whole — "filters", "sort and search",
   * whatever the mounting component calls its controls.
   *
   * Supplied, the bar becomes a labelled group and assistive technology
   * announces the name before entering it. Omitted, the bar carries no role and
   * no name at all, which is the correct outcome: a group whose name this file
   * invented would be shipped copy (AAP 0.5.4), and an unnamed group announces
   * a boundary that means nothing. A blank or whitespace-only value counts as
   * omitted.
   */
  label?: string | undefined;

  /** The text-search control, if the bar offers one. */
  search?: ToolbarSearch | undefined;

  /**
   * The option filters, in the order they are offered. An empty array renders
   * no section.
   */
  selects?: readonly ToolbarSelect[] | undefined;

  /** The action chips, in order. An empty array renders no section. */
  actions?: readonly ToolbarAction[] | undefined;

  /**
   * The result indicators, in order. An empty array — or one whose every label
   * is blank — renders no section.
   */
  status?: readonly ToolbarStatus[] | undefined;

  /**
   * A keyboard chord advertised at the end of the bar, rendered as printed
   * keys: the arrow/Home/End/Enter navigation the data table implements, or the
   * Escape dismissal the tooltip implements.
   *
   * The keys are the caller's, in press order, and no chord is shown unless it
   * is supplied and non-empty — a bar that promised a shortcut its host does not
   * implement would be worse than a bar that promises nothing.
   */
  shortcutKeys?: readonly string[] | undefined;

  /**
   * A bespoke control the four typed sections cannot express — a range pair, a
   * segmented toggle a component owns, a threshold field with its own unit.
   * Rendered inside the bar's own group wrapper, after the filters and before
   * the actions.
   *
   * Callers must pass library primitives only. A raw form control here would
   * defeat the rule this component exists to enforce (AAP 0.6.4) and would
   * align on nothing: the bar's grid is the primitives' field metrics, which a
   * hand-rolled control does not share.
   */
  children?: ReactNode | undefined;

  /**
   * Tighten the bar's own gap and padding for a dense host — a drawer, a
   * stacked pair of bars. Defaults to `false`.
   *
   * It changes the BAR, not its controls: the search field, the pickers and the
   * chips are always rendered at the primitives' dense scale, because a bar is
   * a dense context by definition.
   */
  compact?: boolean | undefined;

  /**
   * Let the individual sections break internally as well, and let the search
   * field span its row, for the narrowest surfaces. Defaults to `false`, where
   * the bar breaks between sections and keeps each section's controls on one
   * line.
   *
   * Neither value ever produces a horizontal scroller: the bar wraps in both
   * (see the module note).
   */
  wrap?: boolean | undefined;

  /**
   * Extra classes composed after `dg-toolbar`, for the layout the mounting
   * component owns — every visualization component of the catalog composes its
   * own `dg-<node>__toolbar` class here to take the bar out of its body's flex
   * growth.
   *
   * It is composition, never an escape hatch for visual values: any class named
   * here is defined in `../styles/components.css` against `--dg-*` tokens, like
   * every other class in this package.
   */
  className?: string | undefined;

  /** A DOM id for the bar, for a caller that must reference it. */
  id?: string | undefined;
}

/**
 * Renders the bar: the search slot, the option filters, the caller's own
 * controls, the action chips, the result indicators and the shortcut hint, in
 * that order.
 *
 * Presentational and pure — no state, no effects, no hooks, no timers, nothing
 * read from the document while rendering and no memoization. It re-renders with
 * its parent deliberately: this product measures and reports React render
 * behaviour, so a primitive of its own design system does not smooth its own
 * away. The output is a function of the props alone, plus the callbacks it
 * raises.
 *
 * @param props The props documented on {@link ToolbarProps}.
 * @returns The bar, with a wrapper for each section the caller supplied and no
 *   wrapper for any it did not.
 *
 * @example
 * // The event log's bar: a text filter, a kind filter, a reset and a count.
 * <Toolbar
 *   label={labels.filterGroup}
 *   search={{ value: query, onValueChange: setQuery, label: labels.search, labelHidden: true }}
 *   selects={[
 *     {
 *       id: 'kind',
 *       label: labels.kind,
 *       value: kind,
 *       options: kindOptions,
 *       onValueChange: setKind,
 *     },
 *   ]}
 *   actions={[{ id: 'reset', label: labels.reset, onSelect: resetFilters }]}
 *   status={[{ label: matchCountLabel, tone: 'neutral' }]}
 *   shortcutKeys={['Ctrl', 'F']}
 * />
 *
 * @example
 * // The minimal form: one sort control above a table.
 * <Toolbar
 *   selects={[
 *     { id: 'sort', label: labels.sort, value: sort, options: sortOptions, onValueChange: setSort },
 *   ]}
 * />
 */
export function Toolbar(props: ToolbarProps): ReactElement {
  const {
    label,
    search,
    selects,
    actions,
    status,
    shortcutKeys,
    children,
    compact = false,
    wrap = false,
    className,
    id,
  } = props;

  // Absent and empty are the same thing for every list section, so each one is
  // normalised once here and the markup below asks a single question of it.
  const selectList: readonly ToolbarSelect[] = selects ?? [];
  const actionList: readonly ToolbarAction[] = actions ?? [];

  // Blank indicator labels are dropped rather than rendered as empty pills; a
  // caller computing a label from data it may not have gets nothing instead of
  // a stray chip, and the section disappears when every label is blank.
  const statusList: readonly ToolbarStatus[] = (status ?? []).filter((entry) =>
    hasText(entry.label),
  );

  // `shortcutKeys` narrows through this alias, so the chord can be handed to a
  // primitive that declares `readonly string[]` without `| undefined`, with no
  // cast and no non-null assertion.
  const hasShortcut = shortcutKeys !== undefined && shortcutKeys.length > 0;

  // A named bar is a labelled group; an unnamed one carries neither the role nor
  // an empty name (see the module note on the role this bar does not take).
  const isNamedGroup = hasText(label);

  return (
    <div
      className={clsx(
        'dg-toolbar',
        compact && 'dg-toolbar--compact',
        wrap && 'dg-toolbar--wrap',
        className,
      )}
      id={id}
      role={isNamedGroup ? 'group' : undefined}
      aria-label={isNamedGroup ? label : undefined}
    >
      {search === undefined ? null : (
        <div className="dg-toolbar__search">
          <Input
            label={search.label}
            labelHidden={search.labelHidden ?? false}
            value={search.value}
            onValueChange={search.onValueChange}
            controlSize="sm"
            fullWidth
            /* The placeholder is spread conditionally rather than forwarded as a
             * possibly-undefined value: the field declares `placeholder?: string`
             * without `| undefined`, and `exactOptionalPropertyTypes` makes the
             * difference between an omitted prop and an explicit `undefined`
             * observable to the compiler. No icon is passed: a glyph here is not
             * part of this bar's contract, and decorative markup around a control
             * is not something a layout primitive may invent. */
            {...(search.placeholder === undefined ? {} : { placeholder: search.placeholder })}
          />
        </div>
      )}

      {selectList.length === 0 ? null : (
        <div className="dg-toolbar__controls">
          {selectList.map((entry) => (
            <Select
              key={entry.id}
              label={entry.label}
              labelHidden={entry.labelHidden}
              value={entry.value}
              options={entry.options}
              onValueChange={entry.onValueChange}
              controlSize="sm"
            />
          ))}
        </div>
      )}

      {isRenderableNode(children) ? <div className="dg-toolbar__group">{children}</div> : null}

      {actionList.length === 0 ? null : (
        <div className="dg-toolbar__actions">
          {actionList.map((action) => (
            /* One form for both chip shapes: the label is always the button's
             * children, and the button primitive moves it into the package's
             * visually-hidden utility when `iconOnly` is set, so an icon chip
             * keeps the same accessible name a wide one shows. `type` is never
             * set here — the primitive already defaults it to a non-submitting
             * button, which is what stops a chip inside the editor webview's
             * form from reloading the view.
             *
             * A pressed toggle gets BOTH signals, which is the point of setting
             * the state class here: `aria-pressed` announces the state, and the
             * stylesheet's `dg-button.dg-is-active` rule — written for exactly
             * this case, "a pressed toggle … a filter that is on" — draws it.
             * `aria-pressed` alone would leave a sighted user unable to tell an
             * icon chip that is on from one that is off, and the button
             * primitive exposes no visual toggle prop, so the state class is how
             * a caller reaches that rule. It is a state class, never a visual
             * value: nothing about the appearance is decided in this file. */
            <Button
              key={action.id}
              variant={action.variant}
              size="sm"
              icon={action.icon}
              iconOnly={action.iconOnly}
              disabled={action.disabled}
              className={action.pressed === true ? 'dg-is-active' : undefined}
              aria-pressed={action.pressed}
              onClick={action.onSelect}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}

      {statusList.length === 0 ? null : (
        <div className="dg-toolbar__status">
          {statusList.map((entry, index) => (
            /* The React key pairs the position with the text: two indicators may
             * legitimately read the same, and no identity is supplied for a
             * statement that is derived from the data it describes. No `color` is
             * passed — that prop takes a token reference for a span kind or tier,
             * and a result count has no such colour to express. */
            <Badge
              key={`${String(index)}:${entry.label}`}
              tone={entry.tone}
              variant={entry.variant}
            >
              {entry.label}
            </Badge>
          ))}
        </div>
      )}

      {hasShortcut ? (
        /* The typographic primitive carries the hint's own type role and muted
         * tone, so the element class below contributes alignment only and no
         * bare span in this file does typography. */
        <Text as="span" size="xs" tone="muted" className="dg-toolbar__hint">
          <Kbd keys={shortcutKeys} />
        </Text>
      ) : null}
    </div>
  );
}
