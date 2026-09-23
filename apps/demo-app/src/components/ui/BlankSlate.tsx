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
  /**
   * Which element the heading is rendered as. Defaults to `'p'`, which is what every block nested
   * inside a screen that already declares its own title wants: a paragraph carrying the heading's
   * type role without adding a level to that screen's outline.
   *
   * A screen whose whole content is this block is the other case - the not-found route is one -
   * and there the visible title is the page's title, so it is passed `'h1'` and becomes a real
   * heading a reader can navigate to. The level stays the caller's decision because only the
   * caller knows what the page around the block already declares; this prop only makes that
   * decision expressible instead of forcing a paragraph on both cases.
   */
  headingAs?: 'p' | 'h1' | 'h2' | 'h3';
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
  headingAs = 'p',
  children,
  action,
  tone = 'neutral',
  framed = false,
  className,
}: Props) {
  /*
    The heading's element, held in a capitalised local because a lower-case JSX tag is read as a
    literal DOM tag name and a capitalised one as a value. The union above is what keeps this safe:
    every member of it is an intrinsic element React knows, so there is no assertion here and no
    component type to widen.
  */
  const Heading = headingAs;

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

        `loading="lazy"` is here for the document head rather than for the network. React's server
        renderer hoists a `<link rel="preload" as="image">` into the head for every non-lazy image
        it renders, and the App Router serialises the not-found slot - one of this component's
        callers - into the payload of every route, so that a notFound() raised on the client can be
        shown without a round trip. The artwork is decorative and branch-conditional, so without
        this attribute a screen that merely carries an empty state it never displays still asks the
        browser to preload the illustration, wastes the request that follows, and earns the "was
        preloaded using link preload but not used" advisory. Declaring the image lazy is the
        honest description of that artwork and it is also what both renderers check: the HTML
        renderer and the Flight serialiser each skip the hint when the element says `loading="lazy"`.
        Nothing changes where the block does render - a lazy image already in the viewport, which is
        where this one sits whenever an empty state is on screen, is fetched immediately - and the
        width and height above keep the box reserved either way.
      */}
      <img
        className={styles.art}
        src={`/illustrations/${art}.svg`}
        width={240}
        height={180}
        alt={alt}
        loading="lazy"
      />
      {/*
        A paragraph by default, styled as a heading, with `headingAs` as the opt-in for a real
        heading level: the right level depends on what the page around the block already declares,
        and the same block appears at four different depths, so the choice stays with the caller
        rather than being fixed here. Whichever element turns up, it carries the one `heading`
        class, and BlankSlate.module.css states that class's margin reset, colour, size, weight and
        line height outright - a CSS-module class outranks the element rules in app/globals.css, so
        `headingAs="h1"` renders exactly what the paragraph rendered.
      */}
      <Heading className={styles.heading}>{heading}</Heading>
      {children === undefined ? null : <p className={styles.body}>{children}</p>}
      {action === undefined ? null : <div className={styles.action}>{action}</div>}
    </div>
  );
}
