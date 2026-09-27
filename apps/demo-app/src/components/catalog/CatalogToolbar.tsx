'use client';

/*
 * CatalogToolbar - the catalog listing's search field, sort dropdown and result count.
 *
 * The row that sits above the product grid, and a pure control surface: every value it shows
 * arrives as a prop, and every change a buyer makes leaves again as a callback. `CatalogGrid` owns
 * the listing and the address that describes it, so this module holds no state, starts nothing,
 * reads no address bar and requests nothing.
 *
 * WHY IT IS A FORM. The two fields are parameters of the catalog query, so applying them asks for
 * another listing rather than altering the one on screen. A `<form method="get">` is what makes the
 * markup say that too: pressing Enter in the search field, or the Search control beside it, submits
 * the row, and a browser with no scripting running builds exactly the address the grid would have
 * built - the same keys, the same values, and the page parameter absent, so the new listing starts
 * at its first page. Scripting only makes that submission quieter: `onSubmit` hands it to the grid,
 * which navigates without a full page load.
 *
 * THE FIELD NAMES ARE THE SERVER'S, AND THIS FILE DECLARES THEM. {@link CATALOG_SEARCH_PARAM} and
 * {@link CATALOG_SORT_PARAM} are two parameters of the one catalog query the endpoint and the
 * catalog page both parse with the same schema, and the fields carrying them are here, so this
 * module declares them and the grid imports them to write the same keys. They are restated rather
 * than imported from the schema that owns them, because a client component may not import server
 * code. {@link CATALOG_SEARCH_MAX_LENGTH} is that schema's bound on the term, stated here for the
 * same reason and enforced on both paths: the browser stops a longer term being typed, and the grid
 * cuts one to length on its way into an address, so no control can produce a query the endpoint
 * would refuse.
 *
 * A SUBMISSION CARRIES THE WHOLE QUERY. A GET submission replaces the entire query string with the
 * fields its form holds, so a parameter that is in force but has no field here - the category
 * filter, a page size the reader asked for - would be dropped by the browser's own submission.
 * `carriedParams` is that remainder, rendered as hidden fields, so the address a submission produces
 * is the address the grid would have written. The grid derives those pairs from the same builder it
 * navigates with, which is why this file knows none of their names.
 *
 * DIVISION OF LABOUR, as everywhere in this storefront's forms:
 *
 *   * `@/components/ui/FormField` owns each field's `<label htmlFor>`, its hint paragraph and the
 *     `aria-describedby` value that ties the two together. Its child is a function, so the id and
 *     that value come back to this file and are forwarded onto the control - which is why neither
 *     string is spelled out twice below.
 *   * `@/components/ui/Input`, `@/components/ui/Select` and `@/components/ui/Button` own the
 *     controls' own boxes: border, focus ring, padding, the select's caret and the busy treatment.
 *     Both fields are width-filling elements, so the width decision belongs to the element around
 *     them, and that is what `.search` and `.sortField` in `CatalogToolbar.module.css` are. No
 *     control is given a `className` from here.
 *   * Both fields are asked for the same density, `scale="sm"`, which their stylesheets describe as
 *     the variant for a toolbar row; one left at the default `'md'` beside the other at `'sm'`
 *     would stand a few pixels taller than its neighbour on the line. The submit control is the
 *     exception and is deliberately `size="md"`: it is the same "Search" action the site header
 *     offers at that step, and one screen showing that action at two heights would read as two
 *     different controls. The row absorbs the taller control without moving anything: it aligns
 *     its items on their bottom edge, and each field's own label already makes its wrapper the
 *     taller element.
 *
 * THE FIELD IDS ARE LITERAL, AND `useId` IS DELIBERATELY NOT USED. `FormField` takes the id from
 * its caller precisely so a form can render from a server component, and a literal id is identical
 * in the server's markup and in the browser's, which is the property that keeps hydration quiet.
 * The catalog listing mounts one toolbar, so two fixed ids cannot collide, and the rendered DOM
 * stays legible: `#catalog-search-field`, `#catalog-sort-field`.
 *
 * THE COUNT IS A POLITE LIVE REGION. A new listing arrives without moving focus, so a reader who
 * cannot see the cards change would otherwise get no confirmation that anything happened;
 * `aria-live="polite"` announces the new figures once the field falls quiet, rather than
 * interrupting each keystroke. While a listing is on its way the line says so instead of quoting
 * figures that describe the listing being replaced, and both numbers go through
 * `formatQuantityLabel`, the storefront's one quantity formatter, so a four-digit catalog reads the
 * same here as it does on the dashboard.
 */

import type { ChangeEvent, FormEvent } from 'react';

import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { formatQuantityLabel } from '@/lib/format';
import type { CatalogQuery, CatalogSort } from '@/lib/types';

import styles from './CatalogToolbar.module.css';

/**
 * The catalog query's search parameter: the name this row's text field submits, and the key the
 * grid writes a term under.
 *
 * Exported because the two have to be the same string - the scripted path builds the address and
 * the unscripted one lets the browser build it - and a key written in two files is a key that can
 * be changed in one of them.
 *
 * `satisfies keyof CatalogQuery` ties the name to the catalog's own query vocabulary in
 * `@/lib/types`, which the endpoint's schema is built from: a field named for a parameter that
 * vocabulary does not declare fails to compile, and the constant still keeps its literal type. That
 * is the check a client component can make without importing server code.
 */
export const CATALOG_SEARCH_PARAM = 'search' satisfies keyof CatalogQuery;

/** The catalog query's ordering parameter, exported and checked for the same reasons. */
export const CATALOG_SORT_PARAM = 'sort' satisfies keyof CatalogQuery;

/**
 * The longest search term the catalog query accepts.
 *
 * The schema's own bound, restated here because a client component may not import server code, and
 * applied to the field as `maxLength` so the browser refuses a longer term while it is being typed.
 * A term past the bound would make the endpoint refuse the whole query and answer the default
 * listing, which would look to a reader like their filter had been ignored.
 */
export const CATALOG_SEARCH_MAX_LENGTH = 80;

/**
 * The toolbar's props: the two filter values, the callbacks that report a change and a submission,
 * the parameters a submission has to carry for the grid, the pair of figures the count line reads,
 * and whether a listing is on its way.
 *
 * Fully controlled, with no optional member. A caller that rendered the row without `searchText` or
 * without `onSortChange` would own a control whose value the grid cannot see or cannot change, so
 * both halves of each pair are required and the compiler says so at the call site.
 */
export interface CatalogToolbarProps {
  /** The search term as it should appear in the field: what the reader has typed, or what is applied. */
  searchText: string;

  /**
   * Called with the field's new value on every keystroke, paste and clear - including the empty
   * string. It reports what the field holds, not a term to apply; applying is `onSearchSubmit`.
   */
  onSearchTextChange: (value: string) => void;

  /**
   * Called when the reader applies the term in the field, by pressing Enter in it or the Search
   * control beside it. The value is not passed: the caller already holds it, having been told every
   * change to it.
   */
  onSearchSubmit: () => void;

  /** The ordering currently applied to the listing; selects the matching option. */
  sort: CatalogSort;

  /** Called with the ordering the buyer picked. Never called with the value already in effect. */
  onSortChange: (sort: CatalogSort) => void;

  /**
   * Name and value of every query parameter in force that this row has no field for, rendered as
   * hidden fields so a submission the browser performs itself addresses the same listing the
   * scripted path would. Empty when the two fields below are the whole of the query.
   */
  carriedParams: readonly (readonly [name: string, value: string])[];

  /** How many products the listing on screen is showing. */
  visibleCount: number;

  /** How many products the applied query matched in total, across every page. */
  totalCount: number;

  /** A listing for changed controls has been asked for and has not arrived yet. */
  pending: boolean;
}

/**
 * The `id` of the search field, and the stem of its hint's id. A literal, because `FormField`
 * needs the id before it renders and the value must be the same string on both sides of hydration.
 *
 * Exported for the one caller that has to find the field again: `CatalogGrid` returns focus to the
 * control a reader used once the listing that control asked for is on screen, and it reaches this
 * field by the id this file gives it rather than by a selector of its own.
 */
export const CATALOG_SEARCH_FIELD_ID = 'catalog-search-field';

/** The `id` of the sort dropdown, a literal and exported for the same reasons. */
export const CATALOG_SORT_FIELD_ID = 'catalog-sort-field';

/** What the count line says while the listing it would describe is still being read. */
const PENDING_COUNT = 'Updating results\u2026';

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
 * buyer to guess which way the list runs. Each key is also the value the endpoint accepts for the
 * ordering parameter, so an option's `value` is submitted as it stands.
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
 * Render the toolbar row: search field, sort dropdown, the control that applies the term, then the
 * result count at the end of the line.
 *
 * The search field reports every keystroke straight through `onSearchTextChange`, with no copy of
 * the value kept here and nothing done to what was typed, so the field shows exactly what the grid
 * holds and the two can never disagree; the term is applied only when the reader submits the row.
 * The dropdown's handler guards the reported value before passing it on, so a value that is not an
 * ordering - a stale option from a page left open across a deployment, say - is ignored instead of
 * forwarded, and an ordering applies as soon as it is picked, which is what a reader expects from a
 * dropdown.
 *
 * `.spacer` is the empty element `CatalogToolbar.module.css` reserves between the controls and the
 * count; its automatic inline-start margin is what holds the count at the end of the line, and the
 * stacked layout hides it.
 */
export function CatalogToolbar({
  searchText,
  onSearchTextChange,
  onSearchSubmit,
  sort,
  onSortChange,
  carriedParams,
  visibleCount,
  totalCount,
  pending,
}: CatalogToolbarProps) {
  function handleSortChange(event: ChangeEvent<HTMLSelectElement>): void {
    if (isCatalogSort(event.target.value)) {
      onSortChange(event.target.value);
    }
  }

  /*
   * The scripted submission. The default is prevented so the grid can ask the router for the new
   * listing instead of the browser reloading the document; without scripting the same submission
   * happens unprevented and produces the same address.
   */
  function handleCatalogSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSearchSubmit();
  }

  const options = Object.entries(CATALOG_SORT_LABELS).map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));

  return (
    <form className={styles.root} method="get" onSubmit={handleCatalogSubmit}>
      {carriedParams.map(([name, value]) => (
        <Input key={name} type="hidden" name={name} value={value} readOnly />
      ))}

      <div className={styles.search}>
        <FormField
          id={CATALOG_SEARCH_FIELD_ID}
          label="Search products"
          hint="Search by product name or SKU"
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="search"
              name={CATALOG_SEARCH_PARAM}
              value={searchText}
              onChange={(event) => onSearchTextChange(event.target.value)}
              placeholder="Search the catalog"
              autoComplete="off"
              maxLength={CATALOG_SEARCH_MAX_LENGTH}
              scale="sm"
            />
          )}
        </FormField>
      </div>

      <div className={styles.sortField}>
        <FormField id={CATALOG_SORT_FIELD_ID} label="Sort">
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              name={CATALOG_SORT_PARAM}
              value={sort}
              onChange={handleSortChange}
              scale="sm"
            >
              {options}
            </Select>
          )}
        </FormField>
      </div>

      <Button type="submit" variant="secondary" size="md" busy={pending}>
        Search
      </Button>

      <div className={styles.spacer} aria-hidden="true" />

      <p className={styles.count} aria-live="polite" aria-busy={pending ? 'true' : undefined}>
        {pending
          ? PENDING_COUNT
          : `Showing ${formatQuantityLabel(visibleCount)} of ${formatQuantityLabel(totalCount)} ${totalCount === 1 ? 'product' : 'products'}`}
      </p>
    </form>
  );
}
