/*
 * CatalogEmptyNotice - what the Lumen Supply catalog says when it has no products to show.
 *
 * Three situations reach this block, and `reason` is the discriminant between them:
 *
 *   - `no-matches`: the catalog itself has products, but the active search term and category
 *     filter select none of them. The message is about the filters, and the way out is to change
 *     them, so the caller usually supplies a "Clear filters" control as `action`.
 *   - `empty-catalog`: there is nothing published to select from in the first place. No change of
 *     filter will help, so the message says so plainly rather than inviting the reader to try
 *     again.
 *   - `page-past-end`: the filters matched products, but the page that was asked for lies beyond
 *     the last one the listing has - a bookmark to page nine of a range that has since shrunk, or a
 *     page number typed by hand. Nothing is wrong with the filters, so the message is about the
 *     page, and the way out is the listing's first page rather than a change of filter.
 *
 * Telling the three apart matters: a reader shown "try a different search term" in front of a
 * catalog that is genuinely empty, or in front of a filter that matched four hundred products they
 * simply cannot see from the page they are on, is being sent on an errand that cannot succeed.
 *
 * DIVISION OF LABOUR
 * `@/components/ui/BlankSlate` owns the inside of the block - the illustration, the heading, the
 * sentence and the action row, with their own stacking and spacing - and `CatalogEmptyNotice`
 * supplies the wording, picks the illustration by token and places the block in the catalog's own
 * field (`CatalogEmptyNotice.module.css`, whose three classes `root`, `body` and `term` are a
 * closed contract with this file). Nothing here restyles BlankSlate or reaches inside it.
 *
 * Two consequences of that contract are easy to get wrong and are therefore spelled out:
 *
 *   1. BlankSlate wraps whatever it is given as children in a paragraph of its own. The sentence
 *      below is consequently phrasing content - a `<span>` carrying this module's `body` class,
 *      with the echoed search term in a nested `<span>` - because a paragraph nested inside a
 *      paragraph is not valid HTML: the parser would close the outer one, and the resulting markup
 *      would no longer match what React rendered on the server.
 *   2. BlankSlate's `framed` variant draws a border, a radius and a recessed surface. The field
 *      declared in this module already draws exactly those, so `framed` is deliberately left at
 *      its default and the box is drawn once.
 *
 * `art` is BlankSlate's three-member token union, not a path: it resolves the token to the asset
 * under /illustrations/ and renders the image with its intrinsic width and height itself, so
 * neither an `<img>` nor a `src` appears in this file.
 *
 * NO CLIENT DIRECTIVE, NO CLOCK, NO DATA ACCESS
 * This is a plain function of its props: no state, no effect, no event handler, no timer, no
 * browser read and no query. It renders identically on the server and after hydration, and it can
 * therefore sit directly inside a server component. The one interactive element the block may
 * carry - the control that clears the filters - arrives as an already-rendered node in `action`,
 * which keeps the button, its handler and the client directive it needs with the caller that owns
 * the filter state. Keyboard users reach that control and nothing else here, because nothing else
 * here is focusable.
 *
 * WORDING AND NAMING
 * Every string the reader sees is declared in `NOTICE_COPY` below, keyed by `reason`, so a third
 * situation cannot be added without the compiler demanding its wording. The component's name is
 * deliberately specific to this folder rather than a generic name for an empty block: the
 * debugging product's own component library owns the generic names, and every name declared in
 * this application is harvested into the shared policy that keeps the two vocabularies apart.
 */

import type { ReactNode } from 'react';

import { BlankSlate } from '@/components/ui/BlankSlate';
import { formatSlugLabel } from '@/lib/format';

import styles from './CatalogEmptyNotice.module.css';

/**
 * The notice's props.
 *
 * Exported because the catalog surfaces that render the notice - the grid, the search results and
 * the category pages - pass a `reason` they have computed and benefit from naming the shape when
 * they do.
 *
 * `searchText` and `categoryName` are declared as `string | undefined` rather than with a bare
 * `?`. The workspace compiles with `exactOptionalPropertyTypes`, under which an optional property
 * does not accept an explicit `undefined`; spelling the union out lets a page forward a value it
 * read straight from the URL - `searchText={searchParams.q}` - without having to build the props
 * object conditionally. `ReactNode` already includes `undefined`, so `action` needs nothing added.
 */
export interface CatalogEmptyNoticeProps {
  /**
   * Which of the three situations this is: filters that matched nothing, nothing to match, or a
   * requested page past the end of a listing that did match something.
   */
  reason: 'no-matches' | 'empty-catalog' | 'page-past-end';
  /**
   * The search term in effect, echoed back so the reader can see exactly what was looked for.
   * Omitted, or whitespace only, means no term was searched and none is mentioned. It is not
   * mentioned for `page-past-end` either, whatever is passed: the term did match products there,
   * so echoing it under a sentence about the page would read as a statement that it had not.
   */
  searchText?: string | undefined;
  /**
   * The category filter in effect. A URL slug (`'hex-head-bolts'`) is turned into words for
   * display; a value that is already prose is printed as it stands. Not mentioned for
   * `page-past-end`, for the reason given above.
   */
  categoryName?: string | undefined;
  /**
   * Optional control below the copy - typically a button that clears the active filters, or a link
   * back to the full catalog. Rendered as given; the control's own module owns its appearance.
   */
  action?: ReactNode;
}

/**
 * Every word the reader sees, keyed by `reason`.
 *
 * A `Record` over the closed `reason` union rather than a lookup with a default: adding a fourth
 * reason to the props above without writing its wording here is a compile error, which is the
 * point. Indexing it with a `reason` therefore yields a complete entry, so no fallback is needed
 * at the point of use.
 *
 * `echoesFilters` is part of the wording rather than a condition at the point of use: it says
 * whether this situation's sentence is a statement about what the filters selected, and so whether
 * naming the term and the category in front of it is true. Two of the three are such statements;
 * the page-past-end sentence is about the address, and prefixing it with "No products are listed
 * for ..." would contradict the count that produced it.
 *
 * `alt` is empty on purpose, and is kept per reason so that a future situation whose artwork does
 * carry information of its own can describe it. BlankSlate renders the same drawing for all three
 * situations here, and in each the heading already says what is missing: an empty `alt` marks the
 * drawing as decorative, which is what stops a screen reader from announcing the same sentence
 * twice.
 */
const NOTICE_COPY: Record<
  CatalogEmptyNoticeProps['reason'],
  { heading: string; body: string; alt: string; echoesFilters: boolean }
> = {
  'no-matches': {
    heading: 'No products match your filters',
    body: 'Try a different search term, or clear the category filter to see the full range.',
    alt: '',
    echoesFilters: true,
  },
  'empty-catalog': {
    heading: 'No products are available yet',
    body: 'This catalog has no published products at the moment.',
    alt: '',
    echoesFilters: true,
  },
  'page-past-end': {
    heading: 'That page is past the end of this listing',
    body: 'The listing has fewer pages than the address asked for. Go to the first page to see the products it does have.',
    alt: '',
    echoesFilters: false,
  },
};

/**
 * A lower-case, hyphen-separated URL slug and nothing else: `'hex-head-bolts'` matches,
 * `'Hand Tools'` does not.
 *
 * The guard is what keeps `formatSlugLabel` to the input it is written for. That helper splits on
 * hyphens and lower-cases the tail of every word it produces, so handing it prose that is already
 * capitalised would quietly rewrite it - `'Hand Tools'` would come back as `'Hand tools'`. A value
 * that is not slug-shaped is therefore printed exactly as the caller supplied it, and no value is
 * ever both re-cased here and re-cased by the helper.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The catalog's empty and no-match block.
 *
 * @example
 * ```tsx
 * <CatalogEmptyNotice
 *   reason="no-matches"
 *   searchText="bolt"
 *   categoryName="hex-head-bolts"
 *   action={<ClearFiltersButton />}
 * />
 *
 * <CatalogEmptyNotice reason="empty-catalog" />
 *
 * <CatalogEmptyNotice reason="page-past-end" action={<FirstPageButton />} />
 * ```
 */
export function CatalogEmptyNotice({
  reason,
  searchText,
  categoryName,
  action,
}: CatalogEmptyNoticeProps) {
  const copy = NOTICE_COPY[reason];

  /*
   * A term of spaces is not a term. The length check is deliberate rather than a truthiness test:
   * it also rejects `'   '`, which reads as a search for nothing and would put an empty pair of
   * quotation marks in front of the reader. A situation whose sentence is not about what the
   * filters selected mentions neither the term nor the category, whatever the caller passed, for
   * the reason given with `echoesFilters` above.
   */
  const term =
    copy.echoesFilters && searchText !== undefined && searchText.trim().length > 0
      ? searchText
      : undefined;

  let category: string | undefined;
  if (copy.echoesFilters && categoryName !== undefined && categoryName.trim().length > 0) {
    const name = categoryName.trim();
    category = SLUG_PATTERN.test(name) ? formatSlugLabel(name) : name;
  }

  /*
   * The sentence. When something was asked for, an opening clause names it before the standing
   * advice; otherwise the advice stands alone.
   *
   * Two details of the assembly are deliberate. The spaces between the pieces live inside the
   * string expressions rather than in the source layout, because JSX drops the whitespace around a
   * line break - text left to the indentation would lose those gaps the moment the formatter
   * rewrapped these lines. And no two pieces are adjacent strings: the echoed term always sits
   * between them, so the sentence is one text node, or a text node either side of that element,
   * and never two text nodes in a row. React separates neighbouring text children in
   * server-rendered HTML with a marker comment that tells hydration where one ends and the next
   * begins; a sentence that needs no marker survives any pipeline that rewrites or strips comments
   * on its way to the browser.
   */
  let sentence: ReactNode = copy.body;
  if (term !== undefined) {
    const tail = category === undefined ? '\u201d. ' : `\u201d in ${category}. `;
    sentence = (
      <>
        {'No products are listed for \u201c'}
        <span className={styles.term}>{term}</span>
        {`${tail}${copy.body}`}
      </>
    );
  } else if (category !== undefined) {
    sentence = `No products are listed in ${category}. ${copy.body}`;
  }

  return (
    <div className={styles.root}>
      <BlankSlate
        art="no-results"
        alt={copy.alt}
        heading={copy.heading}
        tone="neutral"
        action={action}
      >
        <span className={styles.body}>{sentence}</span>
      </BlankSlate>
    </div>
  );
}
