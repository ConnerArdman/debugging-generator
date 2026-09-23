'use client';

import clsx from 'clsx';
import Link from 'next/link';

import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { formatQuantityLabel } from '@/lib/format';

import styles from './CatalogPager.module.css';

/*
 * CatalogPager - the catalog's page navigation.
 *
 * Everything this component draws, it is handed. The page it is showing arrives as `page`,
 * `pageSize` and `total`, and the address of any other page arrives as `hrefForPage`, a function
 * the catalog surface supplies. This file reads neither the path nor the query string, so it never
 * learns what a reader typed into the address bar - only what the server made of it. A category
 * filter, a search term, a sort order and a page size still survive a page change, because the
 * query those links are built from carries them; this file simply does not have to know that any
 * of them exist.
 *
 * Why the addresses arrive as a function instead of being read from the URL here
 * -----------------------------------------------------------------------------
 * Because a link must never be able to ask for a query the server has already refused. The catalog
 * recovers such an address parameter by parameter: an unparseable one is dropped on its own, every
 * other parameter of that address is applied as it stands, and the reader is told in the page which
 * part did not take effect. A pager that copied the current query string and rewrote `page` in it -
 * which is what this file used to do - would copy the refused parameter into every one of its links
 * and so carry it forward for the rest of the reader's visit, to be stripped and reported again on
 * every page change: the notice above the grid would never clear, and the address the reader
 * copied, bookmarked or shared would keep a parameter this catalog has already said it cannot use.
 * `hrefForPage` is built from the query the server actually validated and answered with, so every
 * destination in this row is a listing the server has already agreed to, stated in the parameters
 * it agreed to - the refused one is left behind at the first page change rather than inherited.
 *
 * Why anchors rather than a router call
 * ------------------------------------
 * Every available destination is a real `next/link` anchor with a real `href`, so the platform's
 * own affordances come for free: middle-click and Ctrl/Cmd-click open a page in a new tab, the
 * status bar previews the destination on hover, "Copy link address" produces a URL that works, and
 * assistive technology announces a link as a link. A handler calling `router.push` would have to
 * reimplement all of that and would still leave the element announced as something it is not.
 *
 * The two unavailable directions - Previous on the first page, Next on the last - render as inert
 * `<span>`s instead. A `<span>` has no activation behaviour at all, so there is nothing to
 * intercept and no tab stop to remove: it is already unreachable by keyboard and unactivatable by
 * pointer, which is why `aria-disabled` here is a promise the markup keeps. It carries a link role
 * alongside that attribute so the annotation has something to annotate - without a role the node
 * reaches assistive technology as bare static text, and "unavailable link" degrades into an
 * unexplained word beside the numbers. The stylesheet carries the matching visual cue. Both are
 * rendered rather than omitted so the row keeps its shape as the reader moves through the pages.
 *
 * What it holds
 * -------------
 * No state, and no hook of any kind: the props carry everything, and the output is a pure function
 * of `page`, `pageSize`, `total` and `hrefForPage`, with no clock, no randomness, no read of the
 * address or the document, and no locale-sensitive formatting of its own - `@/lib/format` owns the
 * one number format used here - so the server and client markup of any given URL always agree.
 * `'use client'` is still declared because `hrefForPage` is a function prop, which only a client
 * component may be handed.
 *
 * Defensive arithmetic
 * --------------------
 * `page`, `pageSize` and `total` arrive from a `PagedList<T>` the server produced, which in turn
 * reflects a query string a reader can type by hand. All three are therefore treated as untrusted:
 * a zero or negative page size, a negative total, a page past the end and a non-finite value are
 * each folded into the nearest sensible whole number rather than propagated into a division, an
 * out-of-range link or a `NaN` on screen. When the result is a single page there is nothing to
 * navigate, and the component renders nothing at all.
 *
 * Accessibility
 * -------------
 * The strip is a labelled `<nav>` landmark holding one list of pages. Exactly one link carries
 * `aria-current="page"`, each numbered link carries the full `Page n` name its digit abbreviates,
 * Previous and Next extend their visible word with screen-reader-only text so they are announced
 * as "Previous page" and "Next page", and the gap markers are hidden from the accessibility tree
 * because they stand for pages rather than naming one. The active page is marked by weight as well
 * as by fill in the stylesheet, so its state does not rest on colour alone.
 */

/** How many pages are listed on either side of the page you are on. */
const NEIGHBOUR_RADIUS = 1;

/**
 * One entry of the page window: either a page to link to, or the marker that stands for a run of
 * pages left out.
 */
type PageWindowEntry = number | 'ellipsis';

/** Returns `value` when it is a usable number, and `fallback` for `NaN` and the infinities. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The pages to list for `current` out of `pageCount`: the first page, the neighbours of the
 * current one, the last page, and a marker wherever a run of pages is left out between them.
 *
 * Total, deterministic and free of any ambient input - the same arguments always produce the same
 * entries, and no argument can make it throw. Every number it returns lies within `1..pageCount`,
 * no number appears twice, and the result never exceeds seven entries, so a catalog of nine pages
 * and one of nine thousand occupy the same row.
 *
 * A gap of exactly one page is spelled out instead of being hidden behind a marker, because the
 * marker would take the same room as the page number it stands for.
 */
function buildPageWindow(current: number, pageCount: number): readonly PageWindowEntry[] {
  const lastPage = Math.max(1, Math.trunc(finiteOr(pageCount, 1)));
  const centre = Math.min(Math.max(1, Math.trunc(finiteOr(current, 1))), lastPage);

  if (lastPage === 1) {
    return [1];
  }

  // The interior run, clamped inside the first and last pages: those two are always listed, so the
  // neighbourhood of `centre` never has to repeat them.
  const runStart = Math.max(2, centre - NEIGHBOUR_RADIUS);
  const runEnd = Math.min(lastPage - 1, centre + NEIGHBOUR_RADIUS);
  const run =
    runEnd >= runStart
      ? Array.from({ length: runEnd - runStart + 1 }, (_, offset) => runStart + offset)
      : [];

  const entries: PageWindowEntry[] = [1];

  if (runStart === 3) {
    entries.push(2);
  } else if (runStart > 3) {
    entries.push('ellipsis');
  }

  entries.push(...run);

  if (runEnd === lastPage - 2) {
    entries.push(lastPage - 1);
  } else if (runEnd < lastPage - 2) {
    entries.push('ellipsis');
  }

  entries.push(lastPage);

  return entries;
}

/**
 * Props of {@link CatalogPager}.
 *
 * The first three are the `page`, `pageSize` and `total` of the `PagedList<T>` the catalog is
 * showing, passed straight through: the pager reports the page the list actually returned rather
 * than re-deriving one from the URL, so the two can never disagree. The fourth is how a page is
 * addressed, which for the same reason is not derived here either.
 */
export interface CatalogPagerProps {
  /** The 1-based page the list returned. */
  page: number;
  /** How many items one page holds. */
  pageSize: number;
  /** How many items the query matched across every page. */
  total: number;
  /**
   * The address of a given 1-based page of the listing on screen.
   *
   * Required rather than optional, and a function rather than a template, because the caller is the
   * only party that holds the query the listing was actually read under - the validated one - and a
   * link built from anything else can address a query the server refuses. It is called once per
   * rendered control and must be a pure function of its argument: no state is kept between calls.
   */
  hrefForPage: (page: number) => string;
}

/**
 * Page navigation for the catalog: Previous, the numbered pages, Next, and the position in words.
 *
 * Renders nothing when everything fits on one page.
 *
 * @example
 * ```tsx
 * <CatalogPager
 *   page={result.page}
 *   pageSize={result.pageSize}
 *   total={result.total}
 *   hrefForPage={hrefForCatalogPage}
 * />
 * ```
 */
export function CatalogPager({ page, pageSize, total, hrefForPage }: CatalogPagerProps) {
  const safePageSize = Math.max(1, Math.trunc(finiteOr(pageSize, 0)));
  const pageCount = Math.max(1, Math.ceil(Math.max(0, finiteOr(total, 0)) / safePageSize));
  const currentPage = Math.min(Math.max(1, Math.trunc(finiteOr(page, 1))), pageCount);

  if (pageCount <= 1) {
    return null;
  }

  const pageWindow = buildPageWindow(currentPage, pageCount);

  return (
    <nav className={styles.root} aria-label="Catalog pages">
      {currentPage > 1 ? (
        <Link className={styles.link} href={hrefForPage(currentPage - 1)} rel="prev">
          Previous
          <VisuallyHidden>{' page'}</VisuallyHidden>
        </Link>
      ) : (
        // A link that is not available, rather than a word: the role gives `aria-disabled`
        // something to annotate, so the strip is announced as "Previous page, link, unavailable"
        // instead of leaving the label loose in the text. No `tabIndex` and no handler, because a
        // control nothing can reach and nothing can activate is the whole point of the <span>.
        <span className={styles.disabled} role="link" aria-disabled="true">
          Previous
          <VisuallyHidden>{' page'}</VisuallyHidden>
        </span>
      )}

      <ul className={styles.list}>
        {pageWindow.map((entry, index) =>
          entry === 'ellipsis' ? (
            // The marker stands for pages rather than naming one, so it is hidden from assistive
            // technology; its position in the window is the only stable key it has.
            <li key={`ellipsis-${index}`} className={styles.ellipsis} aria-hidden="true">
              …
            </li>
          ) : (
            <li key={entry} className={styles.item}>
              <Link
                className={clsx(styles.link, entry === currentPage && styles.current)}
                href={hrefForPage(entry)}
                aria-current={entry === currentPage ? 'page' : undefined}
                aria-label={`Page ${entry}`}
              >
                {entry}
              </Link>
            </li>
          ),
        )}
      </ul>

      {currentPage < pageCount ? (
        <Link className={styles.link} href={hrefForPage(currentPage + 1)} rel="next">
          Next
          <VisuallyHidden>{' page'}</VisuallyHidden>
        </Link>
      ) : (
        // Unavailable on the last page, annotated exactly as Previous is on the first.
        <span className={styles.disabled} role="link" aria-disabled="true">
          Next
          <VisuallyHidden>{' page'}</VisuallyHidden>
        </span>
      )}

      <p className={styles.summary}>
        {`Page ${formatQuantityLabel(currentPage)} of ${formatQuantityLabel(pageCount)}`}
      </p>
    </nav>
  );
}
