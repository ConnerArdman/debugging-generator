/**
 * BlankSlate - the storefront's "there is nothing here" block.
 *
 * Four screens share it: a cart with no lines in it, an order history with no orders yet, a
 * catalog search or filter combination that matched no products, and the inventory dashboard's
 * low-stock list when no product is running low. Every one of them renders the same three pieces -
 * one of the three illustrations under /illustrations/, a heading and a sentence - plus an optional
 * control underneath, and the stylesheet beside this file (BlankSlate.module.css) owns how they
 * are stacked, measured and coloured.
 *
 * WHAT THIS COMPONENT DELIBERATELY DOES NOT SUPPLY
 * Copy, an icon, a retry handler and any sense of alarm. /illustrations/no-results.svg appears on
 * two of those four screens whose emptiness means opposite things: in the catalog it is a dead end
 * worth acting on, and on the dashboard it is the healthiest reading the low-stock list can have.
 * A block that brought its own wording or its own warning colour would make one of the two lie, so
 * `tone` offers exactly two framings - `neutral` and `positive` - and every word stays with the
 * caller. There is no `warning` variant to reach for, by design.
 *
 * It is an ordinary server-renderable function component: props in, markup out. No client
 * directive, no state, no effect, no timer and no browser read, so the markup is identical on the
 * server and after hydration, and a server component can render it without pulling anything else
 * in - which is also why the control below the copy arrives as a node rather than as a button this
 * file imports.
 */

import clsx from 'clsx';
import type { ReactNode } from 'react';

import styles from './BlankSlate.module.css';

interface Props {
  /**
   * Which illustration to show. Closed to the three assets that exist, because the developer
   * writing the page picks it: a name with no file behind it should be a compile error, not a
   * broken image in front of a customer.
   */
  art: 'empty-cart' | 'empty-orders' | 'no-results';
  /**
   * Alternative text for the illustration, always chosen by the caller, and `''` is a legitimate
   * value: the artwork is decorative whenever the heading already carries the meaning, and an
   * empty string is what keeps assistive technology from announcing the same sentence twice.
   * Nothing here invents a description, because only the caller knows what its heading says.
   */
  alt: string;
  /** The one-line answer to "what is missing here". */
  heading: ReactNode;
  /** Optional sentence under the heading: why the list is empty, or what to do about it. */
  children?: ReactNode;
  /**
   * Optional control below the copy - a button that clears the active filters, a link back to the
   * catalog. Rendered as given; the control's own module owns its size, colour and focus ring.
   */
  action?: ReactNode;
  /**
   * How the emptiness is framed. `positive` says "this list is empty and that is the good
   * outcome", which is the dashboard's low-stock list with nothing in it. Defaults to `neutral`.
   */
  tone?: 'neutral' | 'positive';
  /**
   * Draws the quiet border and recessed surface, for a block standing alone in a page region
   * rather than inside a card that already draws a box. Defaults to unframed.
   */
  framed?: boolean;
  /** Extra class for the caller's own placement; the module owns everything inside the block. */
  className?: string;
}

export function BlankSlate({
  art,
  alt,
  heading,
  children,
  action,
  tone = 'neutral',
  framed = false,
  className,
}: Props) {
  return (
    <div
      className={clsx(styles.root, className)}
      data-tone={tone}
      data-framed={framed ? 'true' : undefined}
    >
      {/*
        The source is a literal path built from the closed union above, never a static asset
        import: that form resolves through the ambient declarations Next.js generates into the
        git-ignored next-env.d.ts, so a clean clone that has only run `prisma generate` would fail
        `pnpm typecheck` on it. The assets' intrinsic 240x180 travels as the width and height
        attributes so the box is reserved before the file arrives and nothing below it shifts, and
        a plain img element needs no image configuration of any kind - the optimiser skips SVG
        regardless.
      */}
      <img
        className={styles.art}
        src={`/illustrations/${art}.svg`}
        width={240}
        height={180}
        alt={alt}
      />
      {/*
        A paragraph styled as a heading rather than an h2 or h3, and no prop to choose the level:
        the right level depends on what the page around the block already declares, and the same
        block appears at four different depths. A caller that needs it in the document outline
        wraps it in its own labelled section, which keeps that decision where the context is.
      */}
      <p className={styles.heading}>{heading}</p>
      {children === undefined ? null : <p className={styles.body}>{children}</p>}
      {action === undefined ? null : <div className={styles.action}>{action}</div>}
    </div>
  );
}
