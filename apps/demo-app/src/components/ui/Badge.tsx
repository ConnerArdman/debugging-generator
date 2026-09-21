/**
 * Lumen Supply - the status label.
 *
 * The smallest primitive in this folder: a short, coloured label that names a state. The stock
 * marker on product detail, an order's status in the order history and a low-stock row's
 * warning on the inventory dashboard are all this component with a different tone and different
 * text.
 *
 * DOMAIN-AGNOSTIC ON PURPOSE
 * It knows nothing about stock states, order statuses or inventory levels. The caller picks a
 * tone and passes text it has already formatted with `@/lib/format`. Mapping a domain enum to a
 * colour here would make every new status a change to the storefront's smallest primitive, and
 * would tie it to a data model that the cart, the catalog and the dashboard each read
 * differently.
 *
 * THE VARIANT IS AN ATTRIBUTE, NOT A LOOKED-UP CLASS
 * `Badge.module.css` exports exactly two class names - `root` and `dot` - and selects the five
 * tones and two sizes with `.root[data-tone='…']` and `.root[data-size='…']`. So this component
 * sets two attributes and never indexes the styles object: a variant class would have to be read
 * through a computed key, which this repository's `noUncheckedIndexedAccess` types as
 * `string | undefined` and which hides a typo until the label renders unstyled in a browser. An
 * attribute is constrained by the prop union below, and it is legible in the elements tree -
 * which is what this application exists to be inspected with.
 *
 * ACCESSIBILITY
 * No `role` and no `aria-label`: the label's text *is* the information, so it stays in the
 * accessibility tree as ordinary text rather than being renamed or announced as a widget.
 * Colour only reinforces what the text already says, which is why the tone is never the sole
 * carrier of meaning and why callers always pass a textual label. The optional dot is
 * decoration - empty, `aria-hidden`, and filled with `currentColor` by the stylesheet so it
 * follows the tone without a rule of its own.
 *
 * RENDER BEHAVIOUR
 * A plain function component: no `memo`, no memoised props, no state, no effects, and nothing
 * read from `window`, `Date.now()` or `Math.random()` while rendering, so the markup the server
 * sends and the markup the browser first produces always agree. It re-renders whenever its
 * parent does, deliberately: badges sit inside catalog cards, and this application's render
 * behaviour is the subject under investigation rather than something for a primitive to smooth
 * over. Holding no hooks, and no client directive either, also lets a server component and a
 * client component render it equally.
 */

import clsx from 'clsx';

import type { ReactNode } from 'react';

import styles from './Badge.module.css';

/**
 * The label's inputs. Local and deliberately not exported: `packages/panel-renderer` declares a
 * `Badge` primitive of its own, and consumers that need this one's props read them from the
 * component itself with `React.ComponentProps<typeof Badge>` rather than importing a second
 * name. The tone union is likewise spelled out here instead of being shared with the pill, the
 * alert and the toast region: the four unions are identical by intention, and repeating five
 * string literals keeps each primitive readable on its own.
 */
interface Props {
  /**
   * The label. Always text - a state named in words, formatted by the caller. A node rather
   * than a string so a label can carry a count or an emphasised fragment, never so it can
   * nest another control.
   */
  children: ReactNode;

  /**
   * Which of the stylesheet's five tones paints the border and the text. `neutral` is the quiet
   * default for a state that is merely current; `info`, `success`, `warning` and `danger` name
   * the four status colours the whole storefront shares.
   *
   * @default 'neutral'
   */
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';

  /**
   * `sm` is the compact form for a dense table cell or a card corner; `md` is the one to read
   * beside body copy. The two differ in type size and inline padding only, so labels of either
   * size sit on the same line without disturbing it.
   *
   * @default 'md'
   */
  size?: 'sm' | 'md';

  /**
   * Renders the leading dot: a decorative circle in the tone's colour that helps the eye group
   * rows of the same status in a long list. Off by default, because a label on its own is the
   * common case and the dot buys nothing next to a single badge.
   *
   * @default false
   */
  dot?: boolean;

  /**
   * An extra class from the placing component, for the margin or the grid position the badge
   * cannot know about. It is composed after the base class, so it wins on equal specificity;
   * the tone and size rules are attribute-qualified and are not affected by it.
   */
  className?: string;
}

/**
 * Renders one status label.
 *
 * @example
 * // Stock on product detail, and a dense dashboard row.
 * <Badge tone="success">{formatStockLabel(product.stockState)}</Badge>
 * <Badge tone="danger" size="sm" dot>
 *   {formatStockLabel('out_of_stock')}
 * </Badge>
 */
export function Badge({ children, tone = 'neutral', size = 'md', dot = false, className }: Props) {
  return (
    <span className={clsx(styles.root, className)} data-tone={tone} data-size={size}>
      {/*
       * An explicit ternary, not `dot && …`: `false` renders as nothing in React, but the
       * `&&` form would put a stray `0` or an empty string on the page the day this prop is
       * fed a number or a string by a caller, and `null` says what an absent dot is.
       */}
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
