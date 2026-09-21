'use client';

/*
 * CatalogToolbar - the catalog listing's search field, sort dropdown and result count.
 *
 * The row that sits above the product grid, and a pure control surface: every value it shows
 * arrives as a prop, and every change a buyer makes leaves again as a callback. `CatalogGrid` owns
 * `searchText`, `sort` and the two counts, so this module holds no state, starts nothing, reads no
 * address bar and requests nothing. That division is what lets one row serve a page that keeps its
 * filters in component state and a page that keeps them in the URL: the parent decides what the
 * filters mean, and the toolbar only ever describes what it was handed.
 *
 * WHY THE CLIENT DIRECTIVE. The two controls take `onChange`, and a function prop cannot cross the
 * server/client boundary, so the directive above is what makes the fields interactive at all.
 * Nothing else in the file needs the client: there is no hook here, and the markup below is a
 * function of the props alone.
 *
 * NAMED `CatalogToolbar`. Not `Toolbar`: `packages/panel-renderer` publishes a layout primitive of
 * that name, and this workspace's multi-token identifiers are harvested into
 * `scripts/no-hardcoding.policy.json`, so a bare `Toolbar` here would put a name into circulation
 * that the product library already owns.
 *
 * DIVISION OF LABOUR, as everywhere in this storefront's forms:
 *
 *   * `@/components/ui/FormField` owns each field's `<label htmlFor>`, its hint paragraph and the
 *     `aria-describedby` value that ties the two together. Its child is a function, so the id and
 *     that value come back to this file and are forwarded onto the control - which is why neither
 *     string is spelled out twice below.
 *   * `@/components/ui/Input` and `@/components/ui/Select` own the controls' own boxes: border,
 *     focus ring, padding and the select's caret. Both are width-filling elements, so the width
 *     decision belongs to the element around them, and that is what `.search` and `.sortField` in
 *     `CatalogToolbar.module.css` are. Neither control is given a `className` from here.
 *   * Both controls are asked for the same density, `scale="sm"`, which their stylesheets describe
 *     as the variant for a toolbar row; a field left at the default `'md'` beside one at `'sm'`
 *     would stand a few pixels taller than its neighbour on the same line.
 *
 * THE FIELD IDS ARE LITERAL, AND `useId` IS DELIBERATELY NOT USED. `FormField` takes the id from
 * its caller precisely so a form can render from a server component, and a literal id is identical
 * in the server's markup and in the browser's, which is the property that keeps hydration quiet.
 * The catalog listing mounts one toolbar, so two fixed ids cannot collide, and the rendered DOM
 * stays legible: `#catalog-search-field`, `#catalog-sort-field`.
 *
 * THE COUNT IS A POLITE LIVE REGION. Filtering changes the grid without moving focus, so a reader
 * who cannot see the cards shrink would otherwise get no confirmation that anything happened;
 * `aria-live="polite"` announces the new figures once the field falls quiet, rather than
 * interrupting each keystroke. Both numbers go through `formatQuantityLabel`, the storefront's one
 * quantity formatter, so a four-digit catalog reads the same here as it does on the dashboard.
 */

import type { ChangeEvent } from 'react';

import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatQuantityLabel } from '@/lib/format';
import type { CatalogSort } from '@/lib/types';

import styles from './CatalogToolbar.module.css';

/**
 * The toolbar's props: the two filter values, the two callbacks that report a change to them, and
 * the pair of figures the count line reads.
 *
 * Fully controlled, with no optional member. A caller that rendered the row without `searchText`
 * or without `onSortChange` would own a control whose value the grid cannot see or cannot change,
 * so both halves of each pair are required and the compiler says so at the call site.
 */
export interface CatalogToolbarProps {
  /** The current search text, exactly as it should appear in the field. */
  searchText: string;

  /**
   * Called with the field's new value on every keystroke, paste and clear - including the empty
   * string, which is how "stop filtering" is reported.
   */
  onSearchTextChange: (value: string) => void;

  /** The ordering currently applied to the listing; selects the matching option. */
  sort: CatalogSort;

  /** Called with the ordering the buyer picked. Never called with the value already in effect. */
  onSortChange: (sort: CatalogSort) => void;

  /** How many products the listing is showing right now, after the filters. */
  visibleCount: number;

  /** How many products the filters matched in total, across every page. */
  totalCount: number;
}

/**
 * The `id` of the search field, and the stem of its hint's id. A literal, because `FormField`
 * needs the id before it renders and the value must be the same string on both sides of hydration.
 */
const SEARCH_FIELD_ID = 'catalog-search-field';

/** The `id` of the sort dropdown, for the same reason. */
const SORT_FIELD_ID = 'catalog-sort-field';

/**
 * Every ordering the catalog listing accepts, with the wording the dropdown shows for it.
 *
 * `Record<CatalogSort, string>` is what makes this list complete: add a member to the union in
 * `@/lib/types` and this object stops compiling until the new ordering has a label, so the
 * dropdown can never quietly be missing one. Iterating the object - rather than keeping a separate
 * array of values - means the options and the labels cannot drift apart either, and the insertion
 * order below is the order a buyer sees, which puts the server's default first.
 *
 * The labels state the direction rather than naming the column, because "Price" alone leaves a
 * buyer to guess which way the list runs.
 */
const CATALOG_SORT_LABELS: Record<CatalogSort, string> = {
  featured: 'Featured',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  name_asc: 'Name: A to Z',
};

/**
 * Narrow the `string` a `<select>` reports to a `CatalogSort`.
 *
 * `event.target.value` is typed `string`, and the callback this component was given takes the
 * union, so something has to bridge the two. A type predicate over the label map's own keys is
 * that bridge: it checks the value at runtime and narrows it for the compiler, where an assertion
 * would only have silenced the compiler and handed the grid whatever string arrived - which is the
 * one thing a controlled dropdown must never do.
 */
function isCatalogSort(value: string): value is CatalogSort {
  return Object.hasOwn(CATALOG_SORT_LABELS, value);
}

/**
 * Render the toolbar row: search field, sort dropdown, then the result count at the end of the
 * line.
 *
 * The search field reports every keystroke straight through `onSearchTextChange`, with no copy of
 * the value kept here and nothing done to what was typed, so the field shows exactly what the grid
 * holds and the two can never disagree. The dropdown's handler guards the reported value before
 * passing it on, so a value that is not an ordering - a stale option from a page left open across
 * a deployment, say - is ignored instead of forwarded.
 *
 * The fields are plain `<div>` wrappers rather than a `<form>`: there is nothing to submit, and no
 * form means pressing Enter in the search field cannot navigate the page away from the results it
 * has already filtered. `.spacer` is the empty element `CatalogToolbar.module.css` reserves
 * between the fields and the count; its automatic inline-start margin is what holds the count at
 * the end of the line, and the stacked layout hides it.
 */
export function CatalogToolbar({
  searchText,
  onSearchTextChange,
  sort,
  onSortChange,
  visibleCount,
  totalCount,
}: CatalogToolbarProps) {
  function handleSortChange(event: ChangeEvent<HTMLSelectElement>): void {
    if (isCatalogSort(event.target.value)) {
      onSortChange(event.target.value);
    }
  }

  const options = Object.entries(CATALOG_SORT_LABELS).map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));

  return (
    <div className={styles.root}>
      <div className={styles.search}>
        <FormField
          id={SEARCH_FIELD_ID}
          label="Search products"
          hint="Search by product name or SKU"
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="search"
              name="catalogSearch"
              value={searchText}
              onChange={(event) => onSearchTextChange(event.target.value)}
              placeholder="Search the catalog"
              autoComplete="off"
              scale="sm"
            />
          )}
        </FormField>
      </div>

      <div className={styles.sortField}>
        <FormField id={SORT_FIELD_ID} label="Sort">
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              name="catalogSort"
              value={sort}
              onChange={handleSortChange}
              scale="sm"
            >
              {options}
            </Select>
          )}
        </FormField>
      </div>

      <div className={styles.spacer} aria-hidden="true" />

      <p className={styles.count} aria-live="polite">
        {`Showing ${formatQuantityLabel(visibleCount)} of ${formatQuantityLabel(totalCount)} products`}
      </p>
    </div>
  );
}
