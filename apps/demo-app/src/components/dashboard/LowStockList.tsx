/**
 * Lumen Supply - the inventory dashboard's low-stock list.
 *
 * The short ledger a buyer reads first: which products have fallen to (or close to) their reorder
 * point, at which stocking location, how many units are left to promise, and the figure that
 * classified the line. One record per row, most urgent first, so the lines worth acting on are the
 * ones at the top of the card.
 *
 * A SERVER COMPONENT
 * No `'use client'`, no hooks, no event handler, no `fetch` and nothing read from the clock: the
 * dashboard route already holds `InventorySummary` and passes `lowStock` straight in. That is what
 * keeps the markup the server sends identical to the markup the browser keeps, and it is also why
 * the retry control of the error state below arrives as a node rather than as a handler this file
 * declares - the client boundary stays in the route's `error.tsx`, where it belongs.
 *
 * WHAT THIS FILE DECIDES, AND WHAT IT DOES NOT
 * It decides how a line is worded and how urgent it looks. It decides nothing about which lines
 * arrive, in what order or how many: the server's low-stock query orders its page by how far each
 * line has fallen below its point and bounds its size, so this component renders `rows` exactly as
 * given - no sorting, no slicing, no filtering, and therefore no second, disagreeing definition of
 * "urgent" between the dashboard and the query behind it. How many lines matched in full is the
 * server's count as well: when it is larger than the rows given, the list says under its heading
 * that it shows the most urgent of that many, so a bounded list never reads as a complete one.
 *
 * COLOUR IS NEVER THE MESSAGE
 * Each row carries a `ui/Badge` whose text names the state in words, and the quantity is printed
 * with an explicit relation to the reorder point ("7 available of 40"), so the list reads the same
 * in greyscale and through a screen reader. `data-urgency` on the row adds a 2px inline-start rule
 * and nothing else; the stylesheet owns that accent, and it is additive by construction.
 *
 * THE EMPTY STATE IS GOOD NEWS
 * An empty low-stock list means every stocked line is holding more than its reorder point. It is
 * rendered through `ui/BlankSlate` with `tone="positive"` and reassuring copy - which is the whole
 * reason that component offers a `positive` framing and no `warning` one. The same illustration
 * appears on the catalog's no-match screen, where emptiness is a dead end; the framing therefore
 * has to come from this call site, and `LowStockList.module.css` contributes placement only.
 *
 * THREE STATES, ONE FRAME
 * `LowStockList`, `LowStockListPlaceholder` and `LowStockListNotice` render the same titled
 * `<section>`, so a route can substitute one for another - a `<Suspense>` fallback, an error
 * boundary - without the dashboard's heading or its reserved height moving.
 */

import clsx from 'clsx';

import type { ComponentProps, ReactElement, ReactNode } from 'react';

import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { BlankSlate } from '@/components/ui/BlankSlate';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { formatQuantityLabel, formatSkuLabel, formatStockLabel } from '@/lib/format';
import type { LowStockRow, StockState } from '@/lib/types';

import styles from './LowStockList.module.css';

/**
 * The section's title, and its accessible name.
 *
 * One constant serves both: the `<h2>` prints it so the list appears in the document outline, and
 * `aria-label` states it so the `<section>` is a named region a reader can jump to. A nested
 * heading does not name a section on its own, and the alternative - `aria-labelledby` pointing at
 * the heading - needs an `id`, which a server component cannot mint (`useId` is a hook) and which
 * a module-level constant would duplicate the moment a page rendered two of these lists. Naming
 * the region from the same constant the heading prints keeps the two identical by construction.
 */
const HEADING_TEXT = 'Low stock';

/** The heading of the empty state: the reading a warehouse manager wants, stated as such. */
const EMPTY_HEADING = 'Every line is above its reorder point';

/**
 * Alternative text for the empty state's illustration.
 *
 * It describes the drawing - a magnifier over a stocking bay - rather than restating the heading,
 * and it says what the search found rather than what the shelves hold: "nothing picked out" is the
 * good outcome here, while a description of bare shelves would read as the opposite of what this
 * screen is reporting.
 */
const EMPTY_ART_ALT = 'A magnifier held over a stocking bay, with nothing picked out.';

/** The error state's title and sentence. */
const NOTICE_TITLE = 'Low stock could not be loaded';
const NOTICE_BODY = 'The inventory figures for this list did not arrive. Try again in a moment.';

/** What the loading placeholder announces when its caller names nothing more specific. */
const DEFAULT_LOADING_LABEL = 'Loading low-stock lines';

/**
 * How many placeholder rows the loading state reserves, and the range a caller may ask for.
 *
 * Five rows is the height `LowStockList.module.css` reserves for the empty state as well, so the
 * card is the same size whether it is loading, empty or full and the dashboard never reflows as
 * one state replaces another.
 */
const DEFAULT_PLACEHOLDER_ROWS = 5;
const MIN_PLACEHOLDER_ROWS = 1;
const MAX_PLACEHOLDER_ROWS = 24;

/**
 * How pressing a line is, which is the only variant this list has.
 *
 * `critical` is a line with nothing left to promise, `low` a line at or under its reorder point,
 * and `watch` a line still above its point that appears only because the dashboard's threshold
 * widened the query. The three names are the values `LowStockList.module.css` selects its accent
 * with, so they are written to the DOM as `data-urgency` rather than looked up as a class: a
 * computed lookup into a CSS Module is `string | undefined` under this repository's
 * `noUncheckedIndexedAccess`, and it hides a typo until the row renders unstyled in a browser.
 */
type Urgency = 'critical' | 'low' | 'watch';

/**
 * The tones the badge accepts, read off the primitive rather than restated here, so a tone renamed
 * in `ui/Badge` becomes a compile error in the map below instead of a label that renders unstyled.
 */
type UrgencyTone = NonNullable<ComponentProps<typeof Badge>['tone']>;

/**
 * Which tone paints each urgency, and which stock state words it.
 *
 * `Record`s over the finite union rather than `switch`es with a `default`: a fourth urgency added
 * above becomes a compile error right here instead of falling through to a silent neutral row, and
 * indexing either map with an `Urgency` yields a value rather than `T | undefined` under
 * `noUncheckedIndexedAccess`.
 *
 * `watch` deliberately takes the quiet tone and the "in stock" wording. A line holding more than
 * its reorder point is not short of anything; it is on this list because the dashboard asked to see
 * the lines heading that way, and printing it as low stock would overstate what the figures say.
 * The relation beside it ("55 available of 40") is what tells the reader why it is here at all.
 */
const URGENCY_TONES: Record<Urgency, UrgencyTone> = {
  critical: 'danger',
  low: 'warning',
  watch: 'neutral',
};

const URGENCY_STATES: Record<Urgency, StockState> = {
  critical: 'OUT_OF_STOCK',
  low: 'LOW_STOCK',
  watch: 'IN_STOCK',
};

/**
 * How pressing one line is, from that line's own two figures and nothing else.
 *
 * Both figures are treated defensively because both cross a process boundary as JSON. A quantity
 * that is not a finite number is unknown rather than zero, so it claims the quietest urgency
 * instead of painting a row as out of stock on the strength of a missing value; a reorder point
 * that is not a finite number cannot be compared against, so a line with units left falls back to
 * `low`, which is the honest reading for a row the server already classified as short.
 */
function urgencyOf(available: number, reorderPoint: number): Urgency {
  if (!Number.isFinite(available)) {
    return 'watch';
  }

  if (available <= 0) {
    return 'critical';
  }

  if (!Number.isFinite(reorderPoint) || available <= reorderPoint) {
    return 'low';
  }

  return 'watch';
}

/**
 * The list's inputs.
 *
 * Local and deliberately not exported, like every other props type in this workspace: a page that
 * needs the shape writes `ComponentProps<typeof LowStockList>` rather than putting a second name
 * into circulation.
 */
interface Props {
  /**
   * The lines to print, in the order they arrive - which is the order the server's low-stock query
   * produced, most urgent first. `readonly` states that this component never reorders or edits
   * them, and it accepts a mutable array from the payload unchanged.
   */
  rows: readonly LowStockRow[];

  /**
   * The margin, in units, the dashboard added to each line's reorder point when it asked for this
   * page: `0` reports only the lines already at or under their point, and a larger value widens the
   * list to the lines heading there.
   *
   * It is the threshold *in force*, so the empty state can name it rather than claim something the
   * query did not ask. The rows themselves each carry the reorder point that classified them, so
   * nothing about a printed row is derived from this number.
   */
  threshold: number;

  /**
   * How many lines the filters matched as low in full (`InventorySummary.lowStockCount`), of which
   * `rows` is the most urgent few. When it is larger than the rows given, the list states the
   * relation under its heading ("Showing the 12 most urgent of 130 lines"); when it is not, or it
   * is omitted or not a usable number, the rows are the whole answer and nothing is added.
   */
  total?: number | undefined;

  /** The placing component's own class, for the geometry a list cannot know about. */
  className?: string | undefined;
}

/** The loading placeholder's inputs. */
interface LowStockPlaceholderProps {
  /**
   * How many placeholder rows to reserve. Truncated and clamped to the supported range, and a
   * `NaN` - the shape an unguarded `Number()` of a query string takes - falls back to the default,
   * so a caller computing this can produce neither an empty card nor an unbounded one.
   *
   * @default 5
   */
  count?: number | undefined;

  /**
   * What the card is waiting for, in the reader's terms. It becomes the busy region's only
   * accessible text, because `ui/Skeleton` is `aria-hidden`, so it reads as a sentence fragment
   * about content rather than as a component name.
   *
   * @default 'Loading low-stock lines'
   */
  label?: string | undefined;

  /** The placing component's own class, composed exactly as on the loaded list. */
  className?: string | undefined;
}

/** The error state's inputs. */
interface LowStockNoticeProps {
  /**
   * An optional control under the message - the retry button an `error.tsx` owns. A slot rather
   * than a handler: this file stays a server component, and the control brings its own behaviour.
   */
  action?: ReactNode;

  /** The placing component's own class, composed exactly as on the loaded list. */
  className?: string | undefined;
}

/**
 * Render the low-stock list, or the reassurance that there is nothing in it.
 *
 * @example
 * // On the dashboard, from the payload the route already resolved.
 * <LowStockList rows={summary.lowStock} threshold={0} total={summary.lowStockCount} />
 */
export function LowStockList({ rows, threshold, total, className }: Props): ReactElement {
  if (rows.length === 0) {
    /*
     * A whole, non-negative margin for the sentence below. The value is only ever printed, so the
     * clamp changes the wording and not the data: a negative or fractional threshold would read as
     * a figure the dashboard asked for, and it never did.
     */
    const margin = Number.isFinite(threshold) ? Math.max(0, Math.trunc(threshold)) : 0;

    /*
     * Two sentences rather than one with a conditional clause, so each reads naturally on its own.
     * Neither carries a word of alarm, and neither ends in an exclamation: an empty low-stock list
     * is the healthiest reading this card has, and the copy is the only thing that can say so -
     * `BlankSlate` supplies the framing but no wording of its own.
     */
    const body =
      margin === 0
        ? 'Every stocked line is holding more units than its reorder point, so there is nothing to reorder from this view right now.'
        : `Every stocked line is holding more than its reorder point plus the ${formatQuantityLabel(
            margin,
          )}-unit margin this view watches, so there is nothing to reorder right now.`;

    return (
      <section className={clsx(styles.root, className)} aria-label={HEADING_TEXT}>
        <h2>{HEADING_TEXT}</h2>
        {/*
          `clsx` around a single class, here and below, on purpose: a CSS Module lookup is
          `string | undefined` under `noUncheckedIndexedAccess`, while this primitive declares
          `className?: string`, which `exactOptionalPropertyTypes` reads as "absent or a string".
          `clsx` normalises the absent case to an empty string, so a stylesheet that failed to load
          leaves the block unplaced rather than failing the typecheck of every call site.
        */}
        {/* `headingAs="h3"`: the empty state is a subsection of this list's `h2` above. */}
        <BlankSlate
          art="no-results"
          alt={EMPTY_ART_ALT}
          heading={EMPTY_HEADING}
          headingAs="h3"
          tone="positive"
          className={clsx(styles.blankSlate)}
        >
          {body}
        </BlankSlate>
      </section>
    );
  }

  /*
   * How the rows relate to the server's full count, stated only when they are not the whole
   * answer. The count is truncated to a whole number and a value that is not a usable number is
   * read as absent, so the list never claims lines nobody counted. The sentence is one string, so
   * the paragraph is a single text node on both sides of hydration, and a lone row is named
   * without a figure because "the 1 most urgent" is not how a sentence reads.
   */
  const count = total !== undefined && Number.isFinite(total) ? Math.trunc(total) : 0;
  const lead =
    rows.length === 1 ? 'the most urgent' : `the ${formatQuantityLabel(rows.length)} most urgent`;
  const note =
    count > rows.length ? `Showing ${lead} of ${formatQuantityLabel(count)} lines` : null;

  return (
    <section className={clsx(styles.root, className)} aria-label={HEADING_TEXT}>
      <h2>{HEADING_TEXT}</h2>

      {note === null ? null : <p className={styles.summary}>{note}</p>}

      <ul className={styles.list}>
        {rows.map((row) => {
          const urgency = urgencyOf(row.available, row.reorderPoint);

          /*
           * A display-only clamp. A payload counting more units promised than held reaches this
           * component as a negative figure, and `0 available` is a better thing to print than
           * `-3 available`; the urgency above is decided before the clamp, so an over-promised
           * line still reads as critical. A figure that is not a number survives unchanged -
           * `Math.max` leaves `NaN` alone - and reaches `formatQuantityLabel`, which prints an em
           * dash for it rather than a zero the card would be asserting as fact.
           */
          const units = Math.max(0, Math.trunc(row.available));

          const sku = formatSkuLabel(row.sku);
          const point = formatQuantityLabel(row.reorderPoint);

          return (
            /*
             * The key is the line's identity in the data: one inventory level exists per product
             * per stocking location, so the pair is unique across the page - and it is stable
             * across renders in a way an array index is not, since the server reorders this page
             * as stock moves.
             */
            <li
              key={`${row.productId}:${row.warehouseName}`}
              className={styles.item}
              data-urgency={urgency}
            >
              <div className={styles.identity}>
                {/*
                  The separating space belongs to the name's own text node rather than to a `{' '}`
                  of its own: two adjacent text children are separated in server-rendered HTML by a
                  marker comment that tells hydration where one ends and the next begins, and a name
                  that carries its own trailing space needs no marker at all. A product with no SKU
                  prints the name alone, with nothing to separate it from.
                */}
                <span className={styles.product}>
                  {sku.length === 0 ? (
                    row.productName
                  ) : (
                    <>
                      {`${row.productName} `}
                      <span className={styles.sku}>{sku}</span>
                    </>
                  )}
                </span>
                <span className={styles.warehouse}>{row.warehouseName}</span>
              </div>

              <span className={styles.quantities}>
                <span className={styles.available}>{formatQuantityLabel(units)}</span>
                {/*
                  The comparison, twice: once dense enough for a dashboard column and once worded
                  for a reader who hears it. The visible phrase is hidden from assistive technology
                  and the spoken one is hidden from the page, so the row announces "7 available,
                  with a reorder point of 40" while it still prints "7 available of 40". Both are
                  built from the same formatted figure, so the two can never disagree, and the
                  relation is never left to position or colour to convey.
                */}
                <span className={styles.threshold}>
                  <span aria-hidden="true">{`available of ${point}`}</span>
                  <VisuallyHidden>{`available, with a reorder point of ${point}`}</VisuallyHidden>
                </span>
              </span>

              <Badge tone={URGENCY_TONES[urgency]} size="sm" dot className={clsx(styles.badge)}>
                {formatStockLabel(URGENCY_STATES[urgency], units)}
              </Badge>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Render the list's loading placeholder: the same titled section, with the rows reserved.
 *
 * @example
 * // The dashboard's own suspense boundary around the list.
 * <Suspense fallback={<LowStockListPlaceholder />}>{list}</Suspense>
 */
export function LowStockListPlaceholder({
  count = DEFAULT_PLACEHOLDER_ROWS,
  label = DEFAULT_LOADING_LABEL,
  className,
}: LowStockPlaceholderProps): ReactElement {
  /*
   * A whole number of placeholder lines inside the supported range, decided from the prop alone -
   * no clock and no randomness, so the server and the browser agree on how many children there are.
   *
   * `NaN` is the one value the clamp cannot repair, so it is answered first: `Math.trunc` returns
   * it unchanged and every comparison against it is false, which would leave `Array.from` with a
   * length of `NaN` and reserve nothing at all - the jump this placeholder exists to prevent. The
   * test is `Number.isNaN` rather than `Number.isFinite`, because the two infinities clamp
   * perfectly and mean "as many as allowed" and "as few as allowed".
   */
  const requested = Number.isNaN(count) ? DEFAULT_PLACEHOLDER_ROWS : count;
  const lines = Math.min(
    Math.max(Math.trunc(requested), MIN_PLACEHOLDER_ROWS),
    MAX_PLACEHOLDER_ROWS,
  );

  /*
   * A blank label would leave the busy region with no accessible text at all, which is a silent
   * status rather than a quiet one, so an all-whitespace string counts as absent.
   */
  const announcement = label.trim() === '' ? DEFAULT_LOADING_LABEL : label;

  /*
   * `Array.from` with a mapper rather than `new Array(n).map()`, which skips holes and would
   * produce nothing. The values are the indices, and they are the keys below: the rows are empty,
   * interchangeable placeholders in a list whose only variable is its length, so an index key
   * cannot move state or DOM to the wrong item - there is neither to move.
   */
  const placeholders = Array.from({ length: lines }, (_unused, index) => index);

  return (
    <section className={clsx(styles.root, className)} aria-label={HEADING_TEXT}>
      <h2>{HEADING_TEXT}</h2>

      {/*
        The busy region, and a plain `<div>` rather than the `<ul>` the loaded list renders: a list
        of empty boxes is not a list of anything, and `LowStockList.module.css` documents
        `.skeletonRow` as working inside `.list` or inside a plain wrapper. Each `ui/Skeleton` is
        `aria-hidden` on its own, so the only text here is the announcement.
      */}
      <div className={styles.list} role="status" aria-busy="true">
        <VisuallyHidden>{announcement}</VisuallyHidden>
        {placeholders.map((index) => (
          <Skeleton key={index} shape="block" className={styles.skeletonRow} />
        ))}
      </div>
    </section>
  );
}

/**
 * Render the list's error state: the same titled section, with what failed and what to do about it.
 *
 * The notice itself is `ui/Alert` in its `danger` tone, which renders `role="alert"` with
 * `aria-live="assertive"` - a dashboard figure that did not arrive is something the reader has to
 * know about before acting on the rest of the card.
 *
 * @example
 * // In the dashboard route's error boundary, which owns the client-side retry.
 * <LowStockListNotice action={<Button onClick={reset}>Try again</Button>} />
 */
export function LowStockListNotice({ action, className }: LowStockNoticeProps): ReactElement {
  return (
    <section className={clsx(styles.root, className)} aria-label={HEADING_TEXT}>
      <h2>{HEADING_TEXT}</h2>

      <Alert tone="danger" title={NOTICE_TITLE} actions={action}>
        {NOTICE_BODY}
      </Alert>
    </section>
  );
}
