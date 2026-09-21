/*
 * BreadcrumbTrail - the ancestry strip a route hands to `PageContainer`'s `breadcrumb` slot.
 *
 * A page renders it by passing an array: the storefront's entry point first, the page itself
 * last. `PageContainer` places the node it receives and adds the space around it; this component
 * owns the markup inside that space and nothing outside it.
 *
 * A PURE SERVER COMPONENT
 * There is no `'use client'` directive, no hook, no clock read and no environment read. The trail
 * is a function of its props alone, so it costs the client bundle nothing, renders identically on
 * the server and during hydration, and works inside the `not-found` and `error` routes and during
 * `next build` with no database reachable.
 *
 * THE PAGE OWNS THE ANCESTRY, NOT THIS COMPONENT
 * Nothing here looks at the URL - no `usePathname`, no `useSearchParams`, no path splitting. A
 * route has already resolved whatever entity it is showing (the product behind a slug, the order
 * behind an id, the dashboard's warehouse) and therefore already knows both the labels and the
 * destinations; deriving them a second time from the address bar would duplicate that knowledge,
 * disagree with it the moment a label is anything other than the slug, and force a client
 * boundary onto every page that shows a trail. Labels arrive in their final wording for the same
 * reason: a page holding a slug calls `formatSlugLabel` from `@/lib/format` itself rather than
 * having this component guess which of its strings is slug-shaped.
 *
 * THE LAST CRUMB IS THE PAGE ITSELF
 * The trailing entry is where the reader already is, so it is never a link - not even when the
 * caller supplied an `href`, which pages routinely do when they build a trail from the same data
 * their navigation uses. It is the single element carrying `aria-current="page"`. An earlier
 * entry with no `href` is plain text too, but it is not the current page and carries no
 * `aria-current`, which keeps exactly one such element in the document.
 *
 * SEPARATORS ARE REAL ELEMENTS, HIDDEN FROM ASSISTIVE TECHNOLOGY
 * `BreadcrumbTrail.module.css` deliberately injects no generated content, so the divider is a
 * `<span>` this component emits: one before every crumb except the first, inside that crumb's
 * `<li>`, carrying `aria-hidden="true"` so a screen reader announces the labels and not the
 * punctuation between them. Emitting a glyph here *and* styling one in with a pseudo-element
 * would paint two.
 *
 * A TRAIL OF ONE IS NOT A TRAIL
 * Fewer than two entries render nothing at all. A lone crumb states where the reader is, which
 * the page's own heading already does, and an empty `<nav>` would add a landmark to the
 * accessibility tree with nothing in it.
 *
 * STRUCTURE
 * `<nav>` with an `aria-label` (so the landmark is distinguishable from the site's primary
 * navigation) wrapping an `<ol>`: ancestry is ordered, and the list type is what says so. One
 * `<li>` per entry.
 *
 * CLASS CONTRACT
 * `BreadcrumbTrail.module.css` defines six classes and this component uses all six - `root`,
 * `list`, `item`, `link`, `current` and `separator` - composed with `clsx` and never with an
 * inline `style`. No margin is set around the trail: that gap belongs to
 * `PageContainer.module.css`'s `.breadcrumb` wrapper, its single owner.
 */

import clsx from 'clsx';
import Link from 'next/link';
import type { ReactElement } from 'react';

import styles from './BreadcrumbTrail.module.css';

/**
 * One step of a page's ancestry.
 *
 * Exported because pages build these arrays and annotate them - it is the only name this file
 * publishes besides the component - while the component's own props stay local to it.
 *
 * `href` is spelled `string | undefined` rather than with a bare `?` because the workspace
 * compiles with `exactOptionalPropertyTypes`, under which an optional property does not accept an
 * explicit `undefined`. A page can therefore forward a destination it has not resolved -
 * `href: category?.path` - instead of assembling the object conditionally. Absent and `undefined`
 * mean the same thing here: this step is text rather than a link.
 */
export interface BreadcrumbCrumb {
  /** The words printed for this step, already in the wording the page wants to show. */
  label: string;
  /**
   * In-app route this step navigates to, for example `/` or `/orders`. Omit it for a step with
   * nowhere to go, such as a grouping level this application serves no page for.
   */
  href?: string | undefined;
}

/**
 * The props of this component, kept local to it: a page needs to name the crumb shape above, not
 * this envelope around it.
 */
interface Props {
  /**
   * The ancestry, outermost first and the current page last. Read-only because this component
   * only walks it, and a `readonly` parameter accepts a page's own frozen or mutable array alike.
   */
  items: readonly BreadcrumbCrumb[];
  /**
   * The landmark's accessible name. Defaults to `'Breadcrumb'`, which is what a page wants unless
   * it shows two trails and has to tell them apart.
   */
  label?: string | undefined;
  /** Appended to the `<nav>`'s class list, for the rare page that needs a rule of its own. */
  className?: string | undefined;
}

/** The accessible name used when a caller supplies none. */
const DEFAULT_LABEL = 'Breadcrumb';

/**
 * The divider between two crumbs. A plain solidus rather than a chevron: it is unambiguous in
 * every font the storefront falls back to, and it is decorative in any case - `aria-hidden` keeps
 * it out of the accessibility tree, and the stylesheet keeps it out of a text selection.
 */
const SEPARATOR_GLYPH = '/';

/**
 * The page's ancestry as an ordered strip of links ending in the current page.
 *
 * Returns `null` - not an empty landmark - for a trail of fewer than two entries.
 *
 * @example
 * ```tsx
 * <PageContainer
 *   title={product.name}
 *   breadcrumb={
 *     <BreadcrumbTrail
 *       items={[
 *         { label: 'Catalog', href: '/' },
 *         { label: category.name, href: category.path },
 *         { label: product.name },
 *       ]}
 *     />
 *   }
 * >
 * ```
 */
export function BreadcrumbTrail(props: Props): ReactElement | null {
  const { items, label, className } = props;

  // Two entries are the least that describes a path from somewhere to here; anything shorter is
  // the page restating its own title, so nothing is rendered.
  if (items.length < 2) {
    return null;
  }

  // The index of the final entry, computed once outside the walk below. Every position test is
  // against it rather than against an element read back out of `items`, which keeps the whole
  // component free of indexed access - the compiler types `items[i]` as possibly `undefined`
  // under `noUncheckedIndexedAccess`, and neither a non-null assertion nor a fallback crumb
  // belongs in a list this component is iterating anyway.
  //
  // The locals here and below are deliberately single-token names. `scripts/check-no-hardcoding`
  // harvests every identifier this workspace declares that has two or more camel-case tokens
  // into the shared policy the debugging product may not name, so a local called `lastIndex`
  // would make a thoroughly generic word part of that vocabulary for the whole repository.
  const end = items.length - 1;

  return (
    <nav aria-label={label ?? DEFAULT_LABEL} className={clsx(styles.root, className)}>
      <ol className={styles.list}>
        {items.map((crumb, index) => {
          const current = index === end;

          return (
            // The key pairs the position with the entry's own stable value, because two steps of
            // one path can legitimately print the same words - a category and a product named
            // alike - and `href` is optional, so neither part is unique on its own.
            <li key={`${index}-${crumb.href ?? crumb.label}`} className={styles.item}>
              {index === 0 ? null : (
                <span className={styles.separator} aria-hidden="true">
                  {SEPARATOR_GLYPH}
                </span>
              )}
              {current || crumb.href === undefined ? (
                // `aria-current` is the current page's alone. An earlier entry reaches this
                // branch only when it has no destination, and announcing it as the current page
                // would misstate where the reader is.
                <span className={styles.current} aria-current={current ? 'page' : undefined}>
                  {crumb.label}
                </span>
              ) : (
                <Link href={crumb.href} className={styles.link}>
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
