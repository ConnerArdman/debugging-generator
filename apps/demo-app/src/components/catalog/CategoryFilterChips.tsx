'use client';

/*
 * CategoryFilterChips - the Lumen Supply catalog's category filter row.
 *
 * A leading "All products" chip followed by one chip per category the catalog publishes. At most
 * one chip is on at a time: pressing a category narrows the listing to it, and pressing the chip
 * that is already on clears the filter, which turns "All products" back on.
 *
 * FULLY CONTROLLED, LIKE EVERY FILTER SURFACE IN THIS FOLDER
 * `CatalogGrid` owns which category is selected. The active slug arrives as a prop and every press
 * leaves again through `onSelect`, so the row shows exactly what the grid holds and the two can
 * never disagree. Nothing is kept here: no state, no effect, no timer, no query and no address-bar
 * read. That division is what lets one row serve a page that keeps its filters in component state
 * and a page that keeps them in the URL - the parent decides what a filter means, and the row only
 * ever describes what it was handed.
 *
 * WHY THE CLIENT DIRECTIVE
 * Each chip takes a click handler, and a function prop cannot cross the server/client boundary, so
 * the directive above is what makes the chips pressable at all. Nothing else in the file needs the
 * client: there is no hook below, and the markup is a function of the props alone - no clock, no
 * random value, no locale-sensitive call, nothing read from `window` or `document` - so the markup
 * the server sends and the markup the browser first produces always agree.
 *
 * DIVISION OF LABOUR
 *
 *   * `@/components/ui/Pill` owns a chip: its box, tone and size variants, its hover step, its
 *     focus ring and the inversion it shows while it is on. Handed `pressed` together with
 *     `onClick`, it renders a real `<button type="button" aria-pressed>`, so Enter, Space, the tab
 *     stop, the ring and the announced pressed state all come with that element. This file
 *     therefore adds no `role`, no `tabIndex`, no `aria-pressed` and no key handling to a chip,
 *     and sets no geometry or colour of its own.
 *   * `@/components/ui/CategoryGlyph` owns the mark before a category's name, including the
 *     asymmetry that only some categories have artwork: it renders nothing at all for a category
 *     without a drawing. That degradation is its contract, which is why no fallback icon, no
 *     `onError` handler and no presence check appears here. A chip for such a category is simply a
 *     chip with a word in it, and the primitive's height floor keeps it level with the others.
 *   * `CategoryFilterChips.module.css` arranges the chips and nothing else. Its three classes are
 *     a closed contract with this file: `root` on the row, `chip` on a category chip's content,
 *     `label` on the name inside that chip. The leading chip deliberately carries no class of its
 *     own - the stylesheet reaches it as a child of the row - because it has neither a glyph to
 *     align nor a name long enough to truncate.
 *
 * THE PRESSED STATE IS ALSO HOW THE ACTIVE CHIP IS FOUND AGAIN
 * A press asks the parent for a new listing, and a listing that arrives by remounting the surface
 * replaces this row and the chip that had focus with it. `CatalogGrid` returns focus to the chip
 * that is on once its listing is on screen, and it finds that chip by the `aria-pressed="true"`
 * the primitive renders for it - the announced state, rather than a class or a marker of this
 * file's - so the chip a reader lands on is by construction the one that describes the listing.
 * Nothing here takes or moves focus itself.
 *
 * ONE GROUP, ONE LABEL
 * The row is a single `role="group"` carrying one `aria-label`, so the set of filters is announced
 * once and each chip is then announced with its own pressed state. The group is the only accessible
 * name this file adds; a second one - a heading, a nested group, a label on each chip - would make a
 * reader hear the word "category" on every chip in the row.
 *
 * WHAT THE INPUTS MAY BE
 * An empty `categories` array renders the leading chip alone, which still reports the filter state
 * truthfully; whether a row with nothing to filter is worth showing is the caller's decision, not
 * this file's. An `activeSlug` that names no listed category leaves every chip off rather than
 * guessing at one, so the row never claims a filter it cannot name.
 */

import clsx from 'clsx';

import { CategoryGlyph } from '@/components/ui/CategoryGlyph';
import { Pill } from '@/components/ui/Pill';
import type { CategoryOption } from '@/lib/types';

import styles from './CategoryFilterChips.module.css';

/**
 * The filter row's props.
 *
 * Exported because the catalog surfaces that place the row - the listing, the search results and
 * the category pages - hold a selection of their own and benefit from naming the shape when they
 * pass it down.
 *
 * Fully controlled, with no optional member: a caller that rendered the row without `activeSlug`
 * would own a filter whose state the row cannot show, and one that rendered it without `onSelect`
 * would own chips whose presses go nowhere. Both are required, and the compiler says so at the
 * call site.
 */
export interface CategoryFilterChipsProps {
  /**
   * Every category the row offers, in the order the reader sees them. `readonly` because the row
   * only reads the list: a caller may hand over the array it already holds without copying it
   * first, and cannot have it reordered or emptied from in here.
   */
  categories: readonly CategoryOption[];

  /**
   * The slug of the category the listing is filtered to, or `null` for the unfiltered listing.
   * `null` rather than an optional prop, so "no filter" is a value the caller states deliberately
   * instead of an absence that might mean it forgot.
   */
  activeSlug: string | null;

  /**
   * Called with the slug the reader picked, or with `null` when the filter is cleared - which is
   * what pressing the "All products" chip reports, and what pressing the active category chip
   * again reports. It is never called with a category slug that is already in effect, and it
   * reports `null` for a press on the "All products" chip whether or not a filter was in effect,
   * so a handler that assigns the value it is given needs no comparison of its own.
   */
  onSelect: (slug: string | null) => void;
}

/**
 * Render the category filter row.
 *
 * Each chip's handler is declared where the chip is, because the value it reports is the chip's own
 * and the component holds nothing to derive it from later. The category handler reads the same
 * comparison the chip's `pressed` state does, so a press on the chip that is on reports `null` and
 * a press on any other reports that category's slug.
 *
 * `CategoryOption.productCount` goes straight to the chip's `count`, which the primitive declares
 * as a number and renders itself with tabular figures. Nothing is formatted here: a locally
 * formatted string would not fit that prop, and reformatting a value the primitive already presents
 * would put two spellings of one number in the row.
 *
 * `clsx` around `styles.chip` is what types the class as a `string`. A CSS Module's exports are an
 * index signature, so a class read from it is `string | undefined` under this workspace's
 * `noUncheckedIndexedAccess`, while `Pill`'s `className` is declared as a plain `string` and - with
 * `exactOptionalPropertyTypes` - does not accept an explicit `undefined`. `clsx` drops a missing
 * class and returns a string either way, which is the honest bridge between the two: the chip keeps
 * the primitive's own appearance if this stylesheet ever fails to load, rather than being asserted
 * into place with a cast.
 */
export function CategoryFilterChips({
  categories,
  activeSlug,
  onSelect,
}: CategoryFilterChipsProps) {
  return (
    <div className={styles.root} role="group" aria-label="Filter products by category">
      <Pill pressed={activeSlug === null} onClick={() => onSelect(null)} size="sm">
        All products
      </Pill>

      {categories.map((category) => {
        const selected = category.slug === activeSlug;

        return (
          <Pill
            key={category.slug}
            pressed={selected}
            onClick={() => onSelect(selected ? null : category.slug)}
            size="sm"
            count={category.productCount}
            className={clsx(styles.chip)}
          >
            <CategoryGlyph slug={category.slug} size="sm" />
            <span className={styles.label}>{category.name}</span>
          </Pill>
        );
      })}
    </div>
  );
}
