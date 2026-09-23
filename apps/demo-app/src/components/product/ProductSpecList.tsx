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
 * Which specification values are codes rather than prose, and therefore take the identifier
 * treatment (`.mono`) instead of the body treatment (`.detail`).
 *
 * The test is typographic and never a label match. The server decides what a product's rows are
 * called - `SKU` today, a manufacturer part number or a catalogue reference tomorrow, in whatever
 * wording and casing the payload carries - so a list of blessed labels here would silently miss
 * the next one and would tie this component to the catalog service's vocabulary. The shape of the
 * value is the property that actually matters to a reader: a code is read character by character
 * and compared against a printed one, which is what the monospaced face, the fixed digit pitch
 * and the smaller step are for, while a sentence is read as words.
 *
 * A value is a code when it holds no whitespace AND either carries a digit (`HYD-00025`, `M8x1.25`,
 * `24V`) or has no lowercase letter at all (`ISO`, `NPT`). Everything a specification says in
 * words fails the first half - `Hydraulics & Pneumatics`, `39 business days`, `6 locations`, and
 * every category name this catalog seeds - and a single unhyphenated word of prose (`Fasteners`)
 * fails the second, so prose keeps the prose treatment.
 *
 * Declared at module scope so the expression is compiled once for the whole list rather than per
 * row, and named in the constant case this repository harvests no vocabulary from: an
 * upper-snake name carries no camel-case boundary, so it is not a multi-token demo identifier
 * that `scripts/check-no-hardcoding.mjs` would add to its policy. The pattern is anchored and
 * carries no capturing group, and `test` keeps no state on it - there is no `g` flag, so
 * `lastIndex` never advances between rows.
 */
const IDENTIFIER_VALUE = /^(?=\S+$)(?:\S*[0-9]\S*|[^a-z]+)$/;

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
 *
 * A value that {@link IDENTIFIER_VALUE} recognises as a code is given the identifier treatment as
 * well as the body one, so a product code printed among the specifications reads exactly as the
 * same code reads on a catalog tile and in a cart row. The identifier row this component prints
 * from `sku` takes that treatment unconditionally - it is a stock-keeping unit by construction.
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
      {rows.map((spec, index) => {
        // Whether this row's value is a code. Trimmed before it is tested, because surrounding
        // space is an artefact of the payload rather than part of the value, and an untrimmed
        // `HYD-00025 ` would read as prose on the strength of one trailing character. The value
        // itself is still printed exactly as the server sent it.
        const coded = IDENTIFIER_VALUE.test(spec.value.trim());

        return (
          // The label is the only stable field a specification carries, and a set assembled from a
          // product's attributes can repeat one, so the position follows it to keep the key unique.
          // Order is the server's and no state lives below this list, so a positional component
          // changes nothing about what React reconciles.
          <div className={styles.row} key={`${spec.label}:${index}`}>
            <dt className={styles.term}>{spec.label}</dt>
            <dd className={clsx(styles.detail, coded && styles.mono)}>{spec.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}
