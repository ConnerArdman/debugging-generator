'use client';

/**
 * Lumen Supply - the strip of suggested products shown beside a product.
 *
 * WHERE IT APPEARS
 * Twice on a product page: full size in the detail body, under the specifications, and as a short
 * row in the site header, so a buyer who has scrolled past the detail still has somewhere else to
 * go. Both places render this same component and differ only in the `variant` they ask for; the
 * measurements that variant selects live in `RecommendationsRail.module.css`, and the tiles' own
 * geometry in `RecommendationTile.module.css`.
 *
 * WHAT IT OWNS
 * The labelled region, its heading, the horizontal scroll container, the list of tiles, and the
 * wording of its three quiet states - waiting, nothing to suggest, and the endpoint not answering.
 * It owns no data: `@/hooks/useRecommendations` reads `/api/recommendations` and hands back the
 * suggestions, whether the first read has settled, and customer-facing wording for a read that
 * failed. It owns no money and no link either - a tile is `./RecommendationTile`, which is a link
 * to a product page and nothing else.
 *
 * THE NUMBER OF SUGGESTIONS IS THE HOOK'S TO NAME
 * The strip asks for `RECOMMENDED_ITEM_LIMIT`, the size the storefront's rails are laid out for,
 * and takes no count of its own from its caller. One number for every place the strip appears is
 * what keeps a buyer seeing the same suggestions for a product wherever they meet them on the
 * page, and it leaves `@/hooks/useRecommendations` as the single place that number is stated.
 *
 * THE VARIANT IS PRESENTATION, AND ONLY PRESENTATION
 * `variant` picks a heading, how many of the suggestions are put on screen, and - through the
 * `data-variant` attribute the stylesheet selects on - the type size, the gaps and the tile width.
 * It reaches nothing else: the same suggestions are read either way, and the compact row renders
 * the first few of them rather than asking for fewer.
 *
 * ACCESSIBILITY
 * A `<section>` named by its own heading, so both strips are landmarks a reader can move between
 * and neither is an unnamed region. The heading is rendered in both variants - smaller in the
 * header, never removed - because the name is what makes the region findable. The scroll container
 * is a `role="group"` with `tabIndex={0}` carrying that same name: a strip that overflows has to be
 * reachable and scrollable from the keyboard, and the stylesheet draws it a focus ring for exactly
 * that arrival. Each `ui/Skeleton` is `aria-hidden`, so the waiting state states what it is waiting
 * for in `ui/VisuallyHidden` text on the region that owns the busy state.
 */

import clsx from 'clsx';
import { useId, type ReactElement } from 'react';

import { Alert } from '@/components/ui/Alert';
import { BlankSlate } from '@/components/ui/BlankSlate';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { RECOMMENDED_ITEM_LIMIT, useRecommendations } from '@/hooks/useRecommendations';
import type { RecommendationItem } from '@/lib/types';

import { RecommendationTile } from './RecommendationTile';
import styles from './RecommendationsRail.module.css';

/** The heading of the full-size strip in a product page's detail body. */
const DETAIL_HEADING = 'Recommended for you';

/**
 * The heading of the short row in the site header. Shorter wording rather than the same sentence
 * twice, so a reader listing the page's regions can tell the two strips apart by name.
 */
const COMPACT_HEADING = 'Recommended';

/** What the waiting state is waiting for, read out in place of the placeholder boxes. */
const WAITING_MESSAGE = 'Loading recommended products';

/**
 * The empty state's one-line answer to "why is there nothing here". A product is suggested
 * alongside the products merchandised in its own category, so an empty answer means the catalog
 * lists nothing else in this one - and the copy says that rather than implying a failure.
 */
const EMPTY_HEADING = 'Nothing else in this category yet';

/** The sentence under that heading: where a buyer can look instead. */
const EMPTY_BODY =
  'This is the only product the catalog lists in its category. Browse the full range to see what else is stocked.';

/**
 * The empty state's illustration is decorative here, because the heading beside it already says
 * everything the picture does, and `ui/BlankSlate` documents `''` as the value that keeps a reader
 * from hearing the same sentence twice.
 */
const EMPTY_ART_ALT = '';

/**
 * How many suggestions the header's row puts on screen. It is a rendering budget, not a request:
 * the strip reads the same suggestions in both variants and shows the first few of them here,
 * because the header has a single row of vertical space to spend and a buyer scanning it wants the
 * strongest suggestions rather than all of them.
 */
const COMPACT_TILE_COUNT = 2;

/**
 * The most placeholder boxes the waiting state draws. The strip reserves a row the width of the
 * tiles that are coming, so the page settles by about a caption's worth of height when they
 * arrive; past a handful, extra boxes reserve space off the edge of the viewport and reserve
 * nothing a reader can see.
 */
const MAX_PLACEHOLDERS = 4;

/**
 * The strip's inputs.
 *
 * Local and deliberately not exported, like every other props type in this workspace: the product
 * route and the site header write `<RecommendationsRail …>` and let the compiler check the
 * attributes, and a second exported name for this shape would buy nothing.
 *
 * The two optional members spell `| undefined` out, because this workspace compiles with
 * `exactOptionalPropertyTypes`, under which a bare `variant?: 'detail' | 'compact'` means "absent
 * or one of the two" and rejects a present-but-undefined value. Both callers have one in hand: a
 * CSS Module lookup is `string | undefined` under `noUncheckedIndexedAccess`, and a variant a
 * caller takes from its own optional prop is `undefined` when that prop was omitted.
 *
 * There is deliberately no count here. How many suggestions to read is the hook's to state, as the
 * note at the top of this file explains.
 */
interface Props {
  /** The product on screen, as `/api/recommendations` identifies one. */
  productId: string;

  /**
   * Which of the stylesheet's two measures to paint: `detail` for the strip in a product page's
   * body, `compact` for the short row in the site header.
   *
   * @default 'detail'
   */
  variant?: 'detail' | 'compact' | undefined;

  /**
   * The placing component's own class, carrying the width, margin or grid placement the strip
   * cannot know about. It is composed after the base class, so it wins on equal specificity; the
   * variant rules are attribute-qualified and are unaffected by it.
   */
  className?: string | undefined;
}

/**
 * Render the suggestions for `productId`.
 *
 * The region is rendered whenever there is something to put in it: tiles once the suggestions have
 * arrived, placeholder boxes while the first read is in flight, and - in the detail body, where a
 * page region is expected to account for itself - a blank slate when there is nothing to suggest
 * or an inline notice when the read failed. The header's row stays silent in those last two cases
 * and renders nothing at all: a buyer who came for the page above it is not helped by an
 * illustration or a warning wedged into the site header, and an empty row would only take height
 * from the navigation beside it.
 *
 * @example
 * ```tsx
 * // In the product page's detail body.
 * <RecommendationsRail productId={product.id} />
 *
 * // In the site header, beside the navigation.
 * <RecommendationsRail productId={activeProductId} variant="compact" className={styles.rail} />
 * ```
 */
export function RecommendationsRail({
  productId,
  variant = 'detail',
  className,
}: Props): ReactElement | null {
  // The heading's id, which names both the region and the scroll container inside it. `useId`
  // rather than a counter or a random value: React produces the same id on the server and during
  // hydration, so `aria-labelledby` is valid in the first frame, and two strips on one page get
  // two distinct ids without either knowing about the other.
  const railHeadingId = useId();

  const { items, isLoading, error } = useRecommendations({
    productId,
    limit: RECOMMENDED_ITEM_LIMIT,
  });

  const compact = variant === 'compact';

  // What goes on screen, which is the whole of what the variant decides here. `slice` is safe on a
  // shorter list - it simply yields all of it - so a reply carrying fewer suggestions than the
  // header's budget needs no check of its own.
  const tiles: readonly RecommendationItem[] = compact ? items.slice(0, COMPACT_TILE_COUNT) : items;

  // The region's contents, decided once so that the section, its heading and its name are written
  // once below. `null` means this variant has nothing worth occupying the page with, and it is
  // reachable only in the header: the detail body always has something to render.
  let body: ReactElement | null;

  if (error !== null) {
    // The hook's wording, printed as it stands. It is written for a buyer - a sentence about what
    // is missing, at most carrying the status the endpoint answered with, and never a URL, a stack
    // or anything out of the reply - so there is nothing here to interpret, shorten or hide.
    // `warning` rather than `danger`: suggestions are an aside, and `ui/Alert` announces a warning
    // politely instead of interrupting a reader who is reading the product itself.
    body = compact ? null : (
      <Alert tone="warning" className={clsx(styles.state)}>
        {error}
      </Alert>
    );
  } else if (tiles.length > 0) {
    body = (
      <div className={styles.viewport} tabIndex={0} role="group" aria-labelledby={railHeadingId}>
        <ul className={styles.list}>
          {tiles.map((item) => (
            <li key={item.productId} className={styles.item}>
              <RecommendationTile item={item} variant={variant} />
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (isLoading) {
    // How many boxes to draw: the number of suggestions on the way, held to what this variant has
    // room for and to at least one. The limit is typed as a plain number, so it is truncated and
    // checked for finiteness before it becomes an array length - a fractional or non-finite value
    // would otherwise reach `Array.from`, which throws on the first and yields nothing on the
    // second, and a waiting strip that reserved no space would let the page jump when the tiles
    // land.
    const room = compact ? COMPACT_TILE_COUNT : MAX_PLACEHOLDERS;
    const asked = Math.trunc(RECOMMENDED_ITEM_LIMIT);
    const count = Number.isFinite(asked) ? Math.min(room, Math.max(1, asked)) : room;

    body = (
      <div className={styles.state} role="status" aria-busy="true">
        <VisuallyHidden>{WAITING_MESSAGE}</VisuallyHidden>
        {/*
          The boxes are keyed by index, which is correct in precisely this case: they are empty,
          interchangeable placeholders in a list whose only variable is its length, so an index key
          can never move state or DOM to the wrong item - there is neither to move.
        */}
        {Array.from({ length: count }, (_unused, index) => (
          <Skeleton key={index} shape="block" className={styles.skeleton} />
        ))}
      </div>
    );
  } else {
    body = compact ? null : (
      <BlankSlate
        art="no-results"
        alt={EMPTY_ART_ALT}
        heading={EMPTY_HEADING}
        tone="neutral"
        className={clsx(styles.state)}
      >
        {EMPTY_BODY}
      </BlankSlate>
    );
  }

  if (body === null) {
    return null;
  }

  return (
    <section
      className={clsx(styles.root, className)}
      data-variant={variant}
      aria-labelledby={railHeadingId}
    >
      <div className={styles.head}>
        <h2 id={railHeadingId} className={styles.heading}>
          {compact ? COMPACT_HEADING : DETAIL_HEADING}
        </h2>
      </div>
      {body}
    </section>
  );
}
