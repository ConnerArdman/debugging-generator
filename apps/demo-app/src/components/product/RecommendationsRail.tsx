'use client';

/**
 * Lumen Supply - the strip of suggested products shown beside a product.
 *
 * TWO VARIANTS
 * The strip comes in two measures, chosen by the `variant` its caller asks for. `detail` is the
 * full-size strip: its title is an `h2`, and an empty answer is met with a blank slate. `compact`
 * is a short row: it renders only the first `COMPACT_TILE_COUNT` suggestions, states its title as
 * a paragraph, reports a failed read at the smaller measure, and renders nothing for an empty
 * answer. The measurements each variant selects live in `RecommendationsRail.module.css`, and the
 * tiles' own geometry in `RecommendationTile.module.css`.
 *
 * WHAT IT OWNS
 * The labelled region, its heading, the horizontal scroll container, the list of tiles, and the
 * wording of its three quiet states - waiting, nothing to suggest, and suggestions that could not
 * be loaded. It owns no data: `@/hooks/useRecommendations` hands back the suggestions, whether the
 * first read has settled, and customer-facing wording for a read that failed. It owns no money and
 * no link either - a tile is `./RecommendationTile`, which is a link to a product page and nothing
 * else.
 *
 * THE NUMBER OF SUGGESTIONS IS THE HOOK'S TO NAME
 * The strip asks for `RECOMMENDED_ITEM_LIMIT`, the size the strip is laid out for, and takes no
 * count of its own from its caller. One number for both variants keeps the suggestions
 * for a product the same in either measure, and it leaves `@/hooks/useRecommendations` as the
 * single place that number is stated.
 *
 * THE VARIANT IS PRESENTATION, AND ONLY PRESENTATION
 * `variant` picks the title and the element that states it, how many of the suggestions are put on
 * screen, and - through the `data-variant` attribute the stylesheet selects on - the type sizes, the
 * gaps, the tile width and how a tile is laid out, which in the compact variant is a single short
 * row rather than a card.
 * It reaches nothing else: the hook call is identical in both variants, and the compact row renders
 * the first few of the suggestions rather than asking for fewer.
 *
 * ACCESSIBILITY
 * A `<section>` named by its own title, so the strip is a landmark a reader can move to and never
 * an unnamed region. The title is rendered in both variants - smaller in the compact one, never
 * removed - because the name is what makes the region findable, and only its element differs: an
 * `h2` in the detail variant, which is a section of the page under its `h1`, and a paragraph in the
 * compact variant, so the row can be placed where a level-2 heading would break the page's heading
 * outline. The scroll container is a `role="group"` with `tabIndex={0}` carrying that same name: a
 * strip that overflows has to be reachable and scrollable from the keyboard, and the stylesheet
 * draws it a focus ring for exactly that arrival. Each `ui/Skeleton` is `aria-hidden`, so the
 * waiting state states what it is waiting for in `ui/VisuallyHidden` text on the region that owns
 * the busy state.
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

/** The title of the `detail` variant, stated as its `h2`. */
const DETAIL_HEADING = 'Recommended for you';

/**
 * The title of the `compact` variant, stated as a paragraph. One word rather than the detail
 * title's sentence, because the stylesheet sets it as a label at the smallest type step.
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
 * How many suggestions the compact variant puts on screen. It is a rendering budget, not a
 * request: the hook call is identical in both variants and the compact row shows the first few of
 * the suggestions, because it has a single short row of space to spend and a buyer scanning it
 * wants the strongest suggestions rather than all of them.
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
 * Local and deliberately not exported, like every other props type in this workspace: a caller
 * writes `<RecommendationsRail …>` and lets the compiler check the attributes, and a second
 * exported name for this shape would buy nothing.
 *
 * The two optional members spell `| undefined` out, because this workspace compiles with
 * `exactOptionalPropertyTypes`, under which a bare `variant?: 'detail' | 'compact'` means "absent
 * or one of the two" and rejects a present-but-undefined value. A caller may well be holding one: a
 * CSS Module lookup is `string | undefined` under `noUncheckedIndexedAccess`, and a variant a
 * caller takes from its own optional prop is `undefined` when that prop was omitted.
 *
 * There is deliberately no count here. How many suggestions to read is the hook's to state, as the
 * note at the top of this file explains.
 */
interface Props {
  /** The id of the product the suggestions are for. */
  productId: string;

  /**
   * Which of the stylesheet's two measures to paint: `detail` for the full-size strip, `compact`
   * for the short row.
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
 * arrived, placeholder boxes while the first read is in flight, an inline notice when the read
 * failed, and - in the detail variant, where a page region is expected to account for itself - a
 * blank slate when there is nothing to suggest. The compact row reports a failed read too, at the
 * smaller measure the stylesheet gives it, because a buyer has to be able to tell "the suggestions
 * could not be loaded" from "there is no strip here" - a row that disappeared would say the second
 * while the first is what happened. It stays silent in one case only, when there is nothing to
 * suggest: a blank slate's illustration and copy do not fit the compact measure, and an empty row
 * would only take room from whatever sits beside it.
 *
 * @example
 * ```tsx
 * <RecommendationsRail productId={product.id} variant="compact" />
 * ```
 */
export function RecommendationsRail({
  productId,
  variant = 'detail',
  className,
}: Props): ReactElement | null {
  // The heading's id, which names both the region and the scroll container inside it. `useId`
  // rather than a counter or a random value: React produces the same id on the server and during
  // hydration, so `aria-labelledby` is valid in the first frame, and the id is distinct per
  // instance without any instance knowing about another.
  const railHeadingId = useId();

  const { items, isLoading, error } = useRecommendations({
    productId,
    limit: RECOMMENDED_ITEM_LIMIT,
  });

  const compact = variant === 'compact';

  // What goes on screen, which is the whole of what the variant decides here. `slice` is safe on a
  // shorter list - it simply yields all of it - so a reply carrying fewer suggestions than the
  // compact budget needs no check of its own.
  const tiles: readonly RecommendationItem[] = compact ? items.slice(0, COMPACT_TILE_COUNT) : items;

  // The region's contents, decided once so that the section, its heading and its name are written
  // once below. `null` means this variant has nothing worth occupying the page with, and it is
  // reachable in one case only - the compact variant with nothing to suggest: a failed read is
  // reported in both variants, and the detail variant always has something to render.
  let body: ReactElement | null;

  if (error !== null) {
    // The hook's wording, printed as it stands and in both variants. It is written for a buyer - a
    // sentence about what is missing, at most carrying the status the server answered with, and
    // never a URL, a stack or anything out of the reply - so there is nothing here to interpret,
    // shorten, hide or restate per variant. The compact row says the same sentence at the smaller
    // measure the stylesheet gives it, because a row that vanished on a failed read would tell a
    // buyer there is no strip here rather than that its suggestions could not be fetched.
    // `warning` rather than `danger`: suggestions are an aside, and `ui/Alert` derives
    // `role="status"` with `aria-live="polite"` from that tone, so the notice is queued behind
    // whatever a reader is doing instead of interrupting the product they came for.
    body = (
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
        {/*
          The title, and the one place the variant decides an element rather than a measurement.
          The detail strip is a section of the page, so its title is a real `h2` under the page's
          `h1`. The compact row states its title as a paragraph, so it can be placed where a
          level-2 heading would break the page's heading outline. It keeps the same id and the
          same class, and `aria-labelledby` takes a name from the referenced element's text
          whatever that element is, so the region is named the same way in either variant and only
          the heading outline differs.
        */}
        {compact ? (
          <p id={railHeadingId} className={styles.heading}>
            {COMPACT_HEADING}
          </p>
        ) : (
          <h2 id={railHeadingId} className={styles.heading}>
            {DETAIL_HEADING}
          </h2>
        )}
      </div>
      {body}
    </section>
  );
}
