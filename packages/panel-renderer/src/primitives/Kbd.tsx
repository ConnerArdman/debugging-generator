/**
 * `Kbd` — the keyboard-shortcut chip of `@debuggen/panel-renderer`.
 *
 * ## Why this primitive exists
 *
 * Several surfaces of this package are operable from the keyboard and have to
 * say so in the interface itself: `DataTable` moves its focused row with the
 * arrow keys and jumps with Home/End, `Toolbar` filters submit on Enter,
 * `Tooltip` dismisses on Escape, and the empty and error states tell a
 * developer which key re-runs the thing that produced them. Every one of those
 * hints is rendered through this component, so a shortcut reads and measures
 * the same in the Chrome DevTools panel and in the VS Code webview.
 *
 * ## Tier
 *
 * Tier 1 atom. It imports nothing from this package — only React's types and
 * `clsx` — so no primitive, layout element or visualization component can
 * create an import cycle through it.
 *
 * ## The two render forms
 *
 * 1. **Chord** — `keys` is a non-empty array, so one inner `<kbd>` is rendered
 *    per key inside one outer `<kbd>`, joined by a decorative separator:
 *
 *    ```tsx
 *    <Kbd keys={['Ctrl', 'K']} />
 *    // <kbd class="dg-kbd">
 *    //   <kbd class="dg-kbd__key">Ctrl</kbd>
 *    //   <span class="dg-kbd__separator" aria-hidden="true">+</span>
 *    //   <kbd class="dg-kbd__key">K</kbd>
 *    // </kbd>
 *    ```
 *
 * 2. **Single key / free form** — `keys` is absent or empty, so `children` is
 *    rendered in one `<kbd>` that carries both class names, which keeps a lone
 *    key exactly one element deep:
 *
 *    ```tsx
 *    <Kbd>Esc</Kbd>
 *    // <kbd class="dg-kbd dg-kbd__key">Esc</kbd>
 *    ```
 *
 * Nothing else is emitted in either form: no wrapper element, no spacer and no
 * margin of its own. This chip is used inside dense toolbars and state
 * components where an unexpected box would break the row's alignment.
 *
 * ## Markup and accessibility
 *
 * `<kbd>` is the element for user input, and a `<kbd>` nested inside a `<kbd>`
 * is the standard markup for one key of a chord — hence no `<span>`-with-a-class
 * substitute. The separator carries `aria-hidden="true"` so a screen reader
 * announces the keys rather than the punctuation between them. The chip is not
 * interactive: it adds no `tabIndex`, no `role` and no event handler, and it
 * never synthesises an `aria-label` — a caller whose spoken name differs from
 * the printed keys passes its own through `...rest`.
 *
 * ## Class-name contract declared by this file (AAP 0.6.3, 0.6.4)
 *
 * The rules for these class names live in `src/styles/components.css`; this
 * file contributes class names only and never a literal length, colour or
 * inline style.
 *
 * | Class                | Role                                            |
 * | -------------------- | ----------------------------------------------- |
 * | `dg-kbd`             | block: the chip, or the chord that wraps keys    |
 * | `dg-kbd__key`        | element: one printed key                        |
 * | `dg-kbd__separator`  | element: the decorative glue between two keys    |
 *
 * Tokens those rules resolve to, and the only values this chip may take:
 * `--dg-mono-sm` (the 11/16 monospace role, a complete `font` shorthand built
 * on `--dg-font-mono`) for the key text, `--dg-surface-overlay` for the key
 * face, `--dg-border-subtle` for its hairline, `--dg-radius-sm` for its
 * corners, `--dg-text-secondary` for the glyphs and `--dg-space-*` for the
 * padding inside a key and the gap around a separator. The element-level
 * default in `src/styles/base.css` sets `<kbd>` to the `--dg-mono-md` role at
 * zero specificity (`:where(...)`), so the single `.dg-kbd__key` class in the
 * component layer refines it to `--dg-mono-sm` without needing a longer
 * selector.
 *
 * Two consequences of that cascade are worth stating, because they follow from
 * the element choices made here rather than from the component layer's own
 * rules. The separator is a `<span>`, not a `<kbd>`, so no element-level rule
 * reaches it and `--dg-mono-sm` has to be declared on `.dg-kbd` (inherited) or
 * on `.dg-kbd__separator` (direct) — otherwise the glue between two keys is set
 * in the interface font while the keys around it are monospace. And because a
 * chord's keys are laid out as flex items of `.dg-kbd`, their computed `display`
 * is the blockified form of whatever the component layer authors; the chip in
 * the single-key form is not a flex item and keeps the authored value. Both are
 * cascade facts, not something this component can or should encode inline.
 */

import { clsx } from 'clsx';
import type { HTMLAttributes, ReactElement, ReactNode, Ref } from 'react';

/**
 * Props of {@link Kbd}.
 *
 * Every remaining attribute of an HTML element is accepted and forwarded to the
 * rendered `<kbd>` — `id`, `title`, `aria-label`, `data-*`, `onMouseEnter` for a
 * surrounding tooltip — because a shortcut hint is frequently labelled or
 * described by the control it belongs to. `children` is removed from that
 * inherited set and re-declared below so the two render forms can be documented
 * against each other.
 */
export interface KbdProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  /**
   * The keys of a chord, in the order they are pressed, each rendered as its
   * own `<kbd>` chip inside the outer one — for example `['Ctrl', 'Shift', 'P']`
   * or `['Home']`.
   *
   * Takes precedence over {@link KbdProps.children}: when both are supplied the
   * chord is rendered and `children` is ignored, which keeps a caller that
   * spreads a props object from silently rendering two things. An empty array
   * is treated as "no chord" and falls back to the `children` form, so a
   * computed list of modifiers needs no guard at the call site.
   *
   * Duplicate entries are legal — `['G', 'G']` is a real shortcut — because the
   * React key of each chip combines the key's text with its position.
   */
  readonly keys?: readonly string[];

  /**
   * The single-key or free-form content, used when {@link KbdProps.keys} is
   * absent or empty: a key name, a glyph, or an icon element for a key with no
   * good textual form.
   */
  readonly children?: ReactNode;

  /**
   * The decorative glue printed between two consecutive keys of a chord.
   *
   * Defaults to `'+'` (a simultaneous chord). Pass `'then'` or `' '` for a
   * sequence. Ignored in the single-key form, and never printed after the last
   * key. It is hidden from assistive technology, so its value is a visual
   * choice only.
   */
  readonly separator?: string;

  /**
   * Ref to the outer `<kbd>` element — the chip itself in the single-key form,
   * the chord wrapper otherwise. A plain prop, as React 19 passes it: this
   * component is not wrapped in `forwardRef`.
   */
  readonly ref?: Ref<HTMLElement>;
}

/**
 * Renders a keyboard shortcut as a monospace chip.
 *
 * See the file-level documentation for the two render forms, the class-name
 * contract and the tokens the chip resolves to.
 *
 * @example A chord in a toolbar hint
 * ```tsx
 * <Text>
 *   Filter rows with <Kbd keys={['Ctrl', 'F']} />
 * </Text>
 * ```
 *
 * @example A sequence, with an explicit separator and a spoken name
 * ```tsx
 * <Kbd keys={['G', 'G']} separator=" then " aria-label="Press G twice" />
 * ```
 *
 * @example A single key
 * ```tsx
 * <Kbd>Esc</Kbd>
 * ```
 */
export function Kbd(props: KbdProps): ReactElement {
  const { keys, children, separator = '+', className, ref, ...rest } = props;

  // `keys` decides the form. The length test is what makes `keys={[]}` fall
  // back to `children` instead of rendering an empty chip, and it also narrows
  // `keys` for the branch below without an index access or a non-null
  // assertion.
  if (keys !== undefined && keys.length > 0) {
    // A flat array of children rather than a fragment per key: it emits exactly
    // one element per key and one per separator, with no extra node in the DOM
    // and no React value import. Each React key pairs the position with the
    // key's text, so duplicates inside one chord stay distinct and reordering a
    // chord does not reuse the wrong node.
    const chord: ReactNode[] = keys.flatMap((key, index) => {
      const printedKey = (
        <kbd key={`key:${String(index)}:${key}`} className="dg-kbd__key">
          {key}
        </kbd>
      );

      if (index === 0) {
        return [printedKey];
      }

      return [
        <span key={`separator:${String(index)}`} className="dg-kbd__separator" aria-hidden="true">
          {separator}
        </span>,
        printedKey,
      ];
    });

    return (
      <kbd className={clsx('dg-kbd', className)} ref={ref} {...rest}>
        {chord}
      </kbd>
    );
  }

  // Single-key form: one element carrying both the block and the key class, so
  // a lone key is styled identically to a key inside a chord.
  return (
    <kbd className={clsx('dg-kbd', 'dg-kbd__key', className)} ref={ref} {...rest}>
      {children}
    </kbd>
  );
}
