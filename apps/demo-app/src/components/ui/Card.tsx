/**
 * Card - the surface container of the Lumen Supply storefront.
 *
 * It is the box behind a catalog product card, the checkout order summary and a dashboard KPI
 * tile: background, hairline border, corner radius, elevation and the internal padding rhythm,
 * with two optional slots divided from the body by a rule.
 *
 * What it deliberately does NOT own is where it sits or how big it is. Grid placement, column
 * span, width, aspect ratio, stickiness and outer spacing belong to the consuming group's own
 * CSS Module and arrive through `className`, which is composed alongside `.root` rather than
 * replacing it. That split is what lets the catalog lay out roughly four dozen of these without
 * the primitive fighting the grid, and it is recorded in `./Card.module.css` as well - no
 * `width`, `margin`, `position` or grid template appears in either file.
 *
 * ```tsx
 * <Card className={styles.tile} head={<h3>{product.name}</h3>} foot={<AddToCartControl />}>
 *   <Price cents={product.priceCents} />
 * </Card>
 * ```
 *
 * Variants are expressed as data attributes (`data-pad`, `data-interactive`) and styled by
 * attribute selectors in the stylesheet, never by looking a class name up in the imported
 * `styles` object. A caller therefore cannot ask for a padding step the stylesheet does not
 * define, and the union below is the whole vocabulary.
 *
 * Rendering only: no client-component directive, no state, no effect, no `style` prop, no DOM
 * measurement and nothing read from the clock, a random source or `window`, so the markup a
 * server render produces is the markup the client hydrates. The component is also intentionally
 * unmemoised - a memo wrapper here would sit across every consumer's render path, and the
 * catalog's memoisation boundary belongs to the catalog's own components, not to this
 * primitive.
 */
import clsx from 'clsx';
import type { ReactElement, ReactNode } from 'react';

import styles from './Card.module.css';

/**
 * Props of {@link Card}.
 *
 * Local and deliberately not exported: a consumer types its own props and passes them through,
 * so nothing outside this module needs the shape, and the repository's guard scripts treat any
 * exported demo identifier as vocabulary the product may never mention.
 *
 * The optional members spell `| undefined` out because this workspace compiles with
 * `exactOptionalPropertyTypes`, under which `className?: string` means "absent or a string" and
 * rejects a present-but-undefined value. Every realistic caller has one: a CSS Module lookup is
 * typed `string | undefined` under `noUncheckedIndexedAccess`, and a wrapper forwarding its own
 * optional `pad` or `interactive` hands on the same union. `head` and `foot` need no annotation
 * because `ReactNode` already includes `undefined`.
 */
interface Props {
  /** The card's main content. Required: a card with no body has nothing to be a surface for. */
  children: ReactNode;
  /**
   * Optional content above the body, divided from it by a rule. Omitted, no slot and no divider
   * is rendered. No heading is imposed here - heading level depends on the page, so a caller
   * passes its own `<h2>`/`<h3>`.
   */
  head?: ReactNode;
  /** Optional content below the body, divided from it by a rule. Omitted, neither is rendered. */
  foot?: ReactNode;
  /**
   * Internal padding step: `sm` for a dense KPI tile, `md` (the default) for a product card,
   * `lg` for a summary panel carrying a heading and a total.
   */
  pad?: 'sm' | 'md' | 'lg' | undefined;
  /**
   * Marks the card as *looking* clickable: on hover its border takes the accent colour and its
   * elevation lifts, and focus inside it draws a ring around the whole card.
   *
   * Purely visual. The card adds no `onClick`, no `role`, no `tabIndex` and no key handling, so
   * the real control stays the single link or button the caller places inside - which is what
   * keeps the card from becoming a mouse-only target that a screen reader announces twice. The
   * ring comes from the stylesheet's `:focus-within`, so that inner control's focus is visible
   * at the card level without any JavaScript.
   */
  interactive?: boolean | undefined;
  /** The consuming module's own class, composed alongside `.root` for placement and sizing. */
  className?: string | undefined;
}

/**
 * Render a card surface around `children`, with optional `head` and `foot` slots.
 *
 * The slots are tested with an explicit `=== undefined` rather than for truthiness: `head={0}`
 * and `head={''}` are content a caller chose to render - a zero count, an empty SKU line - and
 * `head && <div>` would silently swallow both while still reserving the divider's space.
 */
export function Card({
  children,
  head,
  foot,
  pad = 'md',
  interactive = false,
  className,
}: Props): ReactElement {
  return (
    <div
      className={clsx(styles.root, className)}
      data-pad={pad}
      data-interactive={interactive ? 'true' : undefined}
    >
      {head === undefined ? null : <div className={styles.head}>{head}</div>}
      <div className={styles.body}>{children}</div>
      {foot === undefined ? null : <div className={styles.foot}>{foot}</div>}
    </div>
  );
}
