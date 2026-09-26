/*
 * SiteFooter - the closing band of the "Lumen Supply" storefront.
 *
 * `app/layout.tsx` mounts it exactly once, after `PageContainer`, so this component renders the
 * document's single `<footer>` landmark and must never nest another one. It is the last thing in
 * the body's flex column, which - together with `margin-block-start: auto` on `.root` - is what
 * keeps the band at the bottom of a route whose content is shorter than the viewport.
 *
 * A PURE SERVER COMPONENT
 * There is no `'use client'` directive and no hook: no state, no effect, no `usePathname`. The
 * footer is the same markup on every route, so it costs the client bundle nothing and re-renders
 * with nothing. It reads no data either - no request, no service call, no environment variable -
 * which is what lets it render inside the `not-found` and `error` routes, and during `next build`,
 * with no database reachable at all.
 *
 * NO CLOCK IS READ HERE, AND THAT IS DELIBERATE
 * A year read from the system clock while rendering is evaluated once on the server and again in
 * the browser's hydration pass. The two answers differ across a year boundary, and in this
 * workspace they differ generally, because the storefront formats dates in a fixed store time zone
 * while the browser sits in the reader's local one. React reports such a difference as a hydration
 * error and regenerates that tree on the client, discarding the markup the server sent. The
 * year is therefore an input and never an observation: `copyrightYear` is optional, and when a
 * caller omits it (as the layout does) the closing line simply carries no year. Nothing here falls
 * back to a computed or a hardcoded one.
 *
 * NAVIGATION
 * The two link columns are secondary navigation - `SiteNav` owns the primary row under the header,
 * and every destination below is reachable from there as well. Each `href` is an in-app route this
 * application actually serves, so no link can 404 and none takes a shopper off the storefront.
 * There are consequently no external links, no `mailto:` and no `#` placeholders.
 *
 * STRUCTURE AND LANDMARKS
 * Column titles are `<h2>` elements, because the page's single `<h1>` belongs to the page itself,
 * and the links sit in a plain `<ul>`/`<li>` list under each title rather than inside a `<nav>`:
 * the document already carries the primary-navigation and breadcrumb landmarks, and a third and
 * fourth would make the landmark list harder to skim for no gain. Link appearance, hover gating,
 * the `:focus-visible` ring and the reduced-motion rule all live in the stylesheet.
 *
 * CLASS CONTRACT
 * `SiteFooter.module.css` defines eleven classes and this component uses all eleven - `root`,
 * `inner`, `columns`, `brand`, `blurb`, `column`, `columnTitle`, `list`, `listItem`, `link` and
 * `legal` - composed with `clsx` and never with an inline `style`. The company name inside
 * `.brand` is a plain element with no class of its own, exactly as that stylesheet specifies: it
 * inherits the block's typography.
 */

import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactElement } from 'react';

import styles from './SiteFooter.module.css';

interface Props {
  /**
   * Year printed in the closing line. Omit it - as `app/layout.tsx` does - and the line carries no
   * year at all; this component never derives one from the clock.
   */
  copyrightYear?: number;
  /** Extra class for the `<footer>` element, composed after the module's own `root` class. */
  className?: string;
}

/**
 * The footer's link columns, declared once at module scope so the arrays are built once for the
 * lifetime of the process rather than on every render.
 *
 * The type is written out rather than asserted, and every level is `readonly`, so the data is
 * immutable to the compiler as well as by convention. Each `href` names a route this application
 * serves: `/` (the catalog), `/cart`, `/checkout`, `/orders` and `/dashboard`.
 */
const FOOTER_COLUMNS: readonly {
  readonly title: string;
  readonly links: readonly { readonly label: string; readonly href: string }[];
}[] = [
  {
    title: 'Shop',
    links: [
      { label: 'Catalog', href: '/' },
      { label: 'Cart', href: '/cart' },
      { label: 'Checkout', href: '/checkout' },
    ],
  },
  {
    title: 'Operations',
    links: [
      { label: 'Orders', href: '/orders' },
      { label: 'Inventory dashboard', href: '/dashboard' },
    ],
  },
];

/** The store's name, shown in the brand block and repeated in the closing line. */
const STORE_NAME = 'Lumen Supply';

/** One sentence about the business, held to a reading measure by `.blurb`. */
const STORE_BLURB =
  'Fasteners, hand tools, valves, power tools and safety gear for maintenance teams, picked from regional warehouse stock.';

/** The note beside the closing line, which `.legal` pushes to the far end of a wide viewport. */
const DATA_NOTE = 'Catalog, stock and order figures are sample data.';

/**
 * The storefront's footer band: company blurb, secondary link columns and a neutral closing line.
 */
export function SiteFooter(props: Props): ReactElement {
  const { copyrightYear, className } = props;

  // The only conditional content in the file. `copyrightYear` is compared against `undefined`
  // explicitly: a truthiness test would also drop the year 0, and being explicit keeps the rule -
  // print a year only when a caller supplied one - readable at the point it is applied.
  const notice =
    copyrightYear === undefined
      ? `${STORE_NAME}. A demonstration storefront.`
      : `© ${copyrightYear} ${STORE_NAME}. A demonstration storefront.`;

  return (
    <footer className={clsx(styles.root, className)}>
      <div className={styles.inner}>
        <div className={styles.columns}>
          <div className={styles.brand}>
            <span>{STORE_NAME}</span>
            <p className={styles.blurb}>{STORE_BLURB}</p>
          </div>

          {/* One block per column group. `.map` keeps every element access checked, which a bare
              index would not under `noUncheckedIndexedAccess`, and the keys - the group title and
              the link href - are unique and stable across renders. */}
          {FOOTER_COLUMNS.map((group) => (
            <div key={group.title} className={styles.column}>
              <h2 className={styles.columnTitle}>{group.title}</h2>
              <ul className={styles.list}>
                {group.links.map((entry) => (
                  <li key={entry.href} className={styles.listItem}>
                    <Link href={entry.href} className={styles.link}>
                      {entry.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* `.legal` is a wrapping flex row with its items pushed apart, so the note sits at the
            far end on a wide viewport and drops onto a line of its own on a narrow one. */}
        <div className={styles.legal}>
          <span>{notice}</span>
          <span>{DATA_NOTE}</span>
        </div>
      </div>
    </footer>
  );
}
