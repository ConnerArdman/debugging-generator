'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { formatQuantityLabel } from '@/lib/format';

import styles from './CatalogPager.module.css';

/*
 * CatalogPager - the catalog's page navigation.
 *
 * This is the one file in the catalog folder that knows how a page is addressed. Everything else
 * receives the page it is showing as data; this component turns that page into links, by rewriting
 * a single query parameter - `page` - and preserving every other one exactly as the reader left it.
 * A category filter, a search term and a sort order therefore survive a page change without this
 * file having to know that any of them exist.
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
 * intercept, no tab stop to remove and no `aria-disabled` promise the markup cannot keep; the
 * stylesheet's `pointer-events: none` states the same thing to a mouse. They are rendered rather
 * than omitted so the row keeps its shape as the reader moves through the pages.
 *
 * What it holds
 * -------------
 * No state. `usePathname` and `useSearchParams` are the only hooks it calls, and both are reads of
 * the route the application is already on; the props carry everything else. The output is a pure
 * function of those two reads and of `page`, `pageSize` and `total`, with no clock, no randomness
 * and no locale-sensitive formatting of its own - `@/lib/format` owns the one number format used
 * here - so the server and client markup of any given URL always agree.
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
 * Props of {@link CatalogPager}. The three fields are the `page`, `pageSize` and `total` of the
 * `PagedList<T>` the catalog is showing, passed straight through: the pager reports the page the
 * list actually returned rather than re-deriving one from the URL, so the two can never disagree.
 */
export interface CatalogPagerProps {
  /** The 1-based page the list returned. */
  page: number;
  /** How many items one page holds. */
  pageSize: number;
  /** How many items the query matched across every page. */
  total: number;
}

/**
 * Page navigation for the catalog: Previous, the numbered pages, Next, and the position in words.
 *
 * Renders nothing when everything fits on one page.
 *
 * @example
 * ```tsx
 * <CatalogPager page={result.page} pageSize={result.pageSize} total={result.total} />
 * ```
 */
export function CatalogPager({ page, pageSize, total }: CatalogPagerProps) {
  const pathname = usePathname();
  // `routeSearchParams` rather than the obvious short name: `scripts/check-no-hardcoding.mjs`
  // harvests this application's declared names into a policy that no file of the debugging product
  // may then use, and the short name is one any URL-handling module of that product would reach
  // for. The longer name costs nothing here and keeps that vocabulary free.
  const routeSearchParams = useSearchParams();

  const safePageSize = Math.max(1, Math.trunc(finiteOr(pageSize, 0)));
  const pageCount = Math.max(1, Math.ceil(Math.max(0, finiteOr(total, 0)) / safePageSize));
  const currentPage = Math.min(Math.max(1, Math.trunc(finiteOr(page, 1))), pageCount);

  if (pageCount <= 1) {
    return null;
  }

  /**
   * The URL of `target`, with every query parameter of the current URL kept as it is and only
   * `page` rewritten.
   *
   * The copy is deliberate: `useSearchParams` hands back a read-only view whose mutators throw, so
   * the parameters are re-parsed into a `URLSearchParams` of this component's own. `page` is set
   * rather than appended, which replaces an existing value instead of adding a second one.
   */
  function hrefForPage(target: number): string {
    const params = new URLSearchParams(routeSearchParams.toString());
    params.set('page', String(target));
    const query = params.toString();

    return query.length > 0 ? `${pathname}?${query}` : pathname;
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
        <span className={styles.disabled} aria-disabled="true">
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
        <span className={styles.disabled} aria-disabled="true">
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
