/**
 * InventoryKpiCards - the figure row at the top of the Lumen Supply inventory dashboard.
 *
 * Five cards, one per figure the warehouse side of the storefront is judged by: the SKUs it
 * tracks, the units on the shelf, the units already promised to somebody, the lines that have
 * fallen to their reorder point, and the locations it stocks from. The dashboard page reads the
 * payload and hands it over; this file prints it, and the two files below it on the page - the
 * levels table and the low-stock list - print the detail behind the fourth card.
 *
 * EVERY FIGURE IS A FIELD, NEVER A CALCULATION
 * Each value printed here is one field of `InventorySummary` passed through
 * `formatQuantityLabel`, and nothing is added, subtracted or divided on the way to the screen.
 * The server computes its totals in one statement over `inventory_levels`, under whichever
 * location and state filter the reader chose, so a figure assembled here from two of them would
 * be a second, quieter answer to a question the database has already answered - and it would go
 * wrong precisely when a filter is applied. The one length taken in this file is
 * `warehouses.length`, which counts the very array it reports on.
 *
 * WHAT THE COPY MAY CLAIM
 * The notes under the figures state what a figure *is*, never what it covers: the totals honour
 * an optional location filter this component is not told about, so a note promising a figure is
 * "across every location" would be false on a filtered dashboard. `lowStockCount` also counts
 * the lines inside the reader's own reorder cushion, which is why its note says "at or near".
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 * Where the row sits and how wide it is, which arrive through `className` and are composed
 * alongside `.root` rather than replacing it; the surface of a card, which is
 * `@/components/ui/Card`; the wording of a number, which is `@/lib/format`; the instant the
 * relative timestamp is measured against, which is the `referenceIso` prop; and the heading above
 * the row, which belongs to the page that knows its own heading levels - hence the row's
 * `aria-label` rather than an `aria-labelledby` pointing at a heading this file does not render.
 *
 * MARKUP CONTRACT
 * `./InventoryKpiCards.module.css` declares exactly seven classes and its header says which
 * element each belongs on: `.root` is this `<section>` and is the grid, `.card` reaches `Card`
 * through `className`, and `.metric`, `.label`, `.value` and `.secondary` are the definition list
 * inside one card - a `<dt>` naming the figure, a `<dd>` carrying it, and the optional `<dd>`s
 * under it. A definition list rather than a heading per card, because five terms and their
 * values are what this row is, and five headings would insert a level into an outline this file
 * cannot see. `data-emphasis` on the figure's `<dd>` is what tints it, and it never carries
 * meaning alone: the `<dt>` states what the figure is, and the one card that is tinted also
 * carries a `Badge` whose word says the same thing in text.
 *
 * THREE STATES, THREE COMPONENTS
 * The loaded row, the placeholder a route's `loading.tsx` reserves the same geometry with, and
 * the notice an `error.tsx` shows instead. The notice takes its retry control as a node rather
 * than a callback: the page that owns the reset is a client component, this file is not, and a
 * slot keeps it that way.
 *
 * SERVER COMPONENT
 * No client directive, no hook, no state, no effect, no event handler, no data access, no
 * browser global, and nothing read from the clock or a random source - the relative timestamp is
 * measured against a prop for exactly that reason. The markup is a function of the props alone,
 * so what a server renders and what a browser first produces always agree.
 */

import clsx from 'clsx';
import type { ReactElement, ReactNode } from 'react';

import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import { formatQuantityLabel, formatTimeAgoLabel } from '@/lib/format';
import type { InventorySummary } from '@/lib/types';

import styles from './InventoryKpiCards.module.css';

/**
 * The row's accessible name. The row carries no visible heading - the page owns its outline - so
 * this is the only name a reader jumping between regions hears.
 */
const ROW_LABEL = 'Inventory figures';

/** What the placeholder announces when a caller states no wording, or states a blank one. */
const PLACEHOLDER_LABEL = 'Loading inventory figures';

/**
 * Cards in the row, and therefore cards the placeholder reserves. It is five because
 * `InventorySummary` carries five reportable figures; the loaded row builds its list from those
 * fields rather than from this number, which exists so the wait reserves the same geometry.
 */
const FIGURE_COUNT = 5;

/** The notice's heading. One line, naming what is missing rather than what went wrong. */
const NOTICE_TITLE = 'Inventory figures unavailable';

/**
 * The notice's body when a caller supplies none. Plain language, and deliberately reassuring
 * about the warehouse: a dashboard that cannot read its totals says nothing about the stock those
 * totals describe.
 */
const NOTICE_MESSAGE =
  'The current stock totals could not be read. Nothing about the stock itself has changed, so trying again usually shows them.';

/**
 * One card's content, assembled from the payload inside the component below.
 *
 * A descriptor rather than five hand-written cards, so that the label, the figure, the tint and
 * the status word of a card are decided in one readable place and the markup below is written
 * once. Every member is already a string a reader can see: the formatting happens while the list
 * is built, so nothing is formatted inside the loop and no branch of this file can print a raw
 * number.
 */
interface InventoryKpiFigure {
  /** Stable key for the mapped card. Names the payload field, not the card's position. */
  readonly id: string;
  /** What the figure is, in the reader's words. Becomes the `<dt>`. */
  readonly label: string;
  /** The figure itself, already formatted. Becomes the `<dd>`. */
  readonly value: string;
  /**
   * Which of the stylesheet's three tints the figure takes. `neutral` is a figure that is merely
   * current, `attention` one worth acting on, `positive` one confirming there is nothing to do.
   */
  readonly emphasis: 'neutral' | 'attention' | 'positive';
  /**
   * The optional status word beside a tinted figure, which is what keeps the tint from being the
   * only signal. Absent on a `neutral` card, because there is no state to name.
   */
  readonly status?: { readonly tone: 'success' | 'warning'; readonly label: string } | undefined;
  /** The optional note under the figure: what it counts, or how current it is. */
  readonly note?: string | undefined;
}

/**
 * Props of {@link InventoryKpiCards}.
 *
 * Local and deliberately not exported: the dashboard page holds the payload and passes it
 * through, so nothing outside this module needs the shape, and a caller that does reads it from
 * the component with `React.ComponentProps<typeof InventoryKpiCards>`.
 *
 * `className` spells `| undefined` out because this workspace compiles with
 * `exactOptionalPropertyTypes`, under which a bare `className?: string` rejects the
 * `string | undefined` that a caller reading an optional field - or a CSS Module class, which is
 * typed that way under `noUncheckedIndexedAccess` - actually holds.
 */
interface Props {
  /** The dashboard payload, exactly as the server sent it. */
  summary: InventorySummary;
  /**
   * The instant the payload's own timestamp is described relative to, as an ISO-8601 string.
   *
   * A prop rather than a clock read here, and required rather than defaulted: `formatTimeAgoLabel`
   * takes its reference as an argument so that a server render and the browser's first render
   * produce the same words, and a component that read the time itself would produce two different
   * ones and a hydration mismatch. The page supplies the instant it fetched at.
   */
  referenceIso: string;
  /** The consuming module's own class, composed alongside `.root` for placement and width. */
  className?: string | undefined;
}

/**
 * Props of {@link InventoryKpiCardsPlaceholder}.
 *
 * Named for the component rather than shortened to `PlaceholderProps`: every identifier this
 * workspace declares becomes vocabulary the product's source may not mention, so a name that is
 * unmistakably this row's costs the product nothing.
 */
interface InventoryKpiPlaceholderProps {
  /**
   * What the page is waiting for, in the reader's terms. It becomes the busy region's only
   * accessible text, so it reads as a fragment about content rather than as a component name.
   *
   * @default 'Loading inventory figures'
   */
  label?: string | undefined;
  /** The consuming module's own class, composed alongside `.root`, as in the loaded row. */
  className?: string | undefined;
}

/** Props of {@link InventoryKpiCardsNotice}. */
interface InventoryKpiNoticeProps {
  /**
   * What to tell the reader. A node so a caller can name the location it failed for or link to a
   * retry route; omitted, the default sentence is used.
   */
  message?: ReactNode;
  /**
   * The control that tries again - typically the reset button an App Router `error.tsx` owns.
   *
   * A slot, not a callback: a server component cannot hold an event handler, and the page that
   * owns the reset is already a client component, so the control is passed in rather than
   * described. Omitted, the notice renders no action row at all.
   */
  action?: ReactNode;
  /** The consuming module's own class, composed by `Alert` alongside its own root class. */
  className?: string | undefined;
}

/**
 * Render the dashboard's figure row.
 *
 * @example
 * // A server page that has just read the payload, measuring "updated" against its own fetch.
 * // The page is the side that reads the clock, once; this row never does.
 * const summary = await readInventorySummary({});
 * const fetchedAt = new Date().toISOString();
 * <InventoryKpiCards summary={summary} referenceIso={fetchedAt} />
 */
export function InventoryKpiCards({ summary, referenceIso, className }: Props): ReactElement {
  /*
   * The one comparison in this file, and it is a comparison rather than a calculation: whether
   * the payload reported any line worth reordering decides a tint and a word, not a figure.
   */
  const reorderNeeded = summary.lowStockCount > 0;

  const figures: readonly InventoryKpiFigure[] = [
    {
      id: 'skus',
      label: 'Tracked SKUs',
      value: formatQuantityLabel(summary.totalSkus),
      emphasis: 'neutral',
      // The payload's own timestamp, which is what tells a reader whether they are looking at
      // this minute's figures or at a page left open over lunch.
      note: `Updated ${formatTimeAgoLabel(summary.generatedAt, referenceIso)}`,
    },
    {
      id: 'on-hand',
      label: 'Units on hand',
      value: formatQuantityLabel(summary.totalOnHand),
      emphasis: 'neutral',
    },
    {
      id: 'reserved',
      label: 'Units reserved',
      value: formatQuantityLabel(summary.totalReserved),
      emphasis: 'neutral',
      note: 'Already promised to open orders',
    },
    {
      id: 'low-stock',
      label: 'Lines to reorder',
      value: formatQuantityLabel(summary.lowStockCount),
      emphasis: reorderNeeded ? 'attention' : 'positive',
      status: reorderNeeded
        ? { tone: 'warning', label: 'Attention' }
        : { tone: 'success', label: 'Clear' },
      note: 'Available units at or near the reorder point',
    },
    {
      id: 'warehouses',
      label: 'Stocking locations',
      value: formatQuantityLabel(summary.warehouses.length),
      emphasis: 'neutral',
    },
  ];

  return (
    <section className={clsx(styles.root, className)} aria-label={ROW_LABEL}>
      {figures.map((figure) => (
        <Card key={figure.id} pad="sm" className={styles.card}>
          <dl className={styles.metric}>
            <dt className={styles.label}>{figure.label}</dt>
            <dd className={styles.value} data-emphasis={figure.emphasis}>
              {figure.value}
            </dd>
            {/*
             * The status word and the note are two values of the same term, which is what a
             * second and third `<dd>` mean. Both are compared against `undefined` rather than
             * tested for truthiness, so a card that legitimately has nothing to add renders no
             * empty line in the card's rhythm.
             */}
            {figure.status === undefined ? null : (
              <dd className={styles.secondary}>
                <Badge tone={figure.status.tone} size="sm" dot>
                  {figure.status.label}
                </Badge>
              </dd>
            )}
            {figure.note === undefined ? null : <dd className={styles.secondary}>{figure.note}</dd>}
          </dl>
        </Card>
      ))}
    </section>
  );
}

/**
 * Render the row's loading state: the same grid, the same five cards, a bar where each figure
 * will be.
 *
 * ONE MESSAGE, ONE BUSY REGION
 * `Skeleton` is `aria-hidden` by construction and each card's contents are hidden as a group, so
 * a reader is told what is loading once instead of hearing ten empty boxes. `role="status"` and
 * `aria-busy="true"` sit on the same element as that single piece of text, which is what lets the
 * wait be announced politely and be reported as over when the real row replaces this subtree. The
 * announcement is absolutely positioned by `VisuallyHidden`, so it takes no grid track.
 *
 * `.metric` wraps the two bars on a `<div>` here rather than on the `<dl>` it wraps in the loaded
 * row: the class carries the label-to-figure rhythm, which the bars need, while a definition list
 * of empty terms would put five nameless entries into the accessibility tree.
 *
 * @example
 * // A route's loading state, and a surface that names what it is waiting for.
 * <InventoryKpiCardsPlaceholder />
 * <InventoryKpiCardsPlaceholder label="Loading warehouse figures" />
 */
export function InventoryKpiCardsPlaceholder({
  label = PLACEHOLDER_LABEL,
  className,
}: InventoryKpiPlaceholderProps): ReactElement {
  /*
   * A blank label would leave the busy region with no accessible text, which is a silent status
   * message rather than a quiet one, so an all-whitespace string counts as absent.
   */
  const announcement = label.trim() === '' ? PLACEHOLDER_LABEL : label;

  /*
   * `Array.from` with a mapper rather than `new Array(n).map()`, which skips holes and would
   * produce nothing. The values are the indices and they are the keys: the cards are empty,
   * interchangeable placeholders in a list whose only variable is its length, so an index key
   * cannot move state or DOM to the wrong card - there is neither to move.
   */
  const slots = Array.from({ length: FIGURE_COUNT }, (_unused, index) => index);

  return (
    <section className={clsx(styles.root, className)} role="status" aria-busy="true">
      <VisuallyHidden>{announcement}</VisuallyHidden>

      {slots.map((index) => (
        <Card key={index} pad="sm" className={styles.card}>
          <div className={styles.metric} aria-hidden="true">
            <Skeleton shape="text" />
            {/*
             * The figure's bar is sized by `.skeletonValue`, which reserves exactly the line box
             * the real figure occupies, so the row keeps its height when the numbers land.
             */}
            <Skeleton shape="block" className={styles.skeletonValue} />
          </div>
        </Card>
      ))}
    </section>
  );
}

/**
 * Render the row's error state: one notice in place of the five cards.
 *
 * `Alert`'s `danger` tone announces itself assertively and carries `role="alert"`, which is what
 * a dashboard whose figures failed to load needs - the reader is looking at the space where the
 * numbers should be. The retry control arrives through `action` and is positioned by the alert;
 * nothing about it is decided here.
 *
 * @example
 * // An App Router error boundary, which owns the reset and is a client component.
 * <InventoryKpiCardsNotice action={<Button onClick={reset}>Try again</Button>} />
 */
export function InventoryKpiCardsNotice({
  message = NOTICE_MESSAGE,
  action,
  className,
}: InventoryKpiNoticeProps): ReactElement {
  return (
    /*
     * `clsx` rather than the class straight through: `Alert` declares `className?: string`, and
     * under `exactOptionalPropertyTypes` a present-but-undefined value is not assignable to it.
     * `clsx` answers an absent class with an empty string, which the alert composes away.
     */
    <Alert tone="danger" title={NOTICE_TITLE} actions={action} className={clsx(className)}>
      {message}
    </Alert>
  );
}
