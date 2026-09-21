/**
 * ProductSpecList - the specification list on a Lumen Supply product page.
 *
 * It prints the product's identifier followed by one term/value pair per published
 * specification, in the order the server sent them. A definition list rather than a table,
 * because each row is a name and its single value - material, thread pitch, finish, lead time -
 * and not a cell in a grid of comparable rows.
 *
 * MARKUP CONTRACT
 * `./ProductSpecList.module.css` supports two structures for a pair, and this file uses the
 * wrapped one: every pair sits inside a `<div class="row">`, which `.row` stretches across both
 * of the list's columns as a `subgrid` item, so a wrapped term and value land in exactly the two
 * tracks they would land in unwrapped. `<div>` is the one grouping element a `<dl>` allows around
 * a term/value pair, and giving each pair an element of its own is what carries the key React
 * needs down a mapped list without a fragment standing between the list and its grid tracks.
 *
 * WHAT THIS COMPONENT DELIBERATELY DOES NOT OWN
 * Width, placement and outer spacing, which arrive through `className` and are composed alongside
 * `.root` rather than replacing it; the heading above the list, which belongs to the page that
 * knows its own heading levels; and the wording of a specification, which is the server's. Long
 * values are not shortened here either - the stylesheet breaks them inside their track, so a
 * compound part number wraps instead of widening the page - so nothing in this file measures or
 * truncates text.
 *
 * Rendering only: no client directive, no state, no effect, no handler, no browser read and
 * nothing taken from the clock or a random source, so the markup a server render produces is the
 * markup the browser hydrates. The identifier is printed through `@/lib/format` for the same
 * reason: that module pins casing and locale, so the server and the hydrated page agree on every
 * character.
 */

import clsx from 'clsx';
import type { ReactElement } from 'react';

import { formatSkuLabel } from '@/lib/format';
import type { ProductSpec } from '@/lib/types';

import styles from './ProductSpecList.module.css';

/**
 * Props of {@link ProductSpecList}.
 *
 * Local and deliberately not exported: the product page types its own data and passes it
 * through, so nothing outside this module needs the shape.
 *
 * `specs` is `readonly` because the array arrives straight from the server payload and is shared
 * with everything else on the page that reads it; this component only ever iterates it. The
 * optional members spell `| undefined` out because this workspace compiles with
 * `exactOptionalPropertyTypes`, under which a bare `sku?: string` means "absent or a string" and
 * rejects the `string | undefined` that a caller reading an optional field - or a CSS Module
 * class, which is typed `string | undefined` under `noUncheckedIndexedAccess` - actually holds.
 */
interface Props {
  /** The published specifications, in the order they are meant to be read. */
  specs: readonly ProductSpec[];
  /** The product's stock-keeping unit. Omitted or blank, no identifier row is printed. */
  sku?: string | undefined;
  /** The consuming module's own class, composed alongside `.root` for placement and width. */
  className?: string | undefined;
}

/**
 * Render the identifier row and one row per published specification.
 *
 * Returns `null` rather than an empty list when there is nothing to print: a product whose
 * specifications have not been filled in yet should leave no trace on the page, not a bordered
 * gap where a list used to be.
 */
export function ProductSpecList({ specs, sku, className }: Props): ReactElement | null {
  // Normalised before it is measured, so a SKU that is blank or nothing but spaces counts as an
  // absent one and prints no row instead of an empty value.
  const identifier = sku === undefined ? '' : formatSkuLabel(sku);
  // A specification with no name or nothing to say is dropped for the same reason.
  const rows = specs.filter((spec) => spec.label.trim().length > 0 && spec.value.trim().length > 0);

  if (identifier.length === 0 && rows.length === 0) {
    return null;
  }

  return (
    <dl className={clsx(styles.root, className)}>
      {identifier.length === 0 ? null : (
        <div className={styles.row}>
          <dt className={styles.term}>SKU</dt>
          <dd className={clsx(styles.detail, styles.mono)}>{identifier}</dd>
        </div>
      )}
      {rows.map((spec, index) => (
        // The label is the only stable field a specification carries, and a set assembled from a
        // product's attributes can repeat one, so the position follows it to keep the key unique.
        // Order is the server's and no state lives below this list, so a positional component
        // changes nothing about what React reconciles.
        <div className={styles.row} key={`${spec.label}:${index}`}>
          <dt className={styles.term}>{spec.label}</dt>
          <dd className={styles.detail}>{spec.value}</dd>
        </div>
      ))}
    </dl>
  );
}
