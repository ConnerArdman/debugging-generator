'use client';

/**
 * Lumen Supply - one product tile in the catalog grid.
 *
 * The tile is the storefront's shopping surface: it names a product, prices it, says how freely it
 * can be sold, and offers the two things a buyer does from a listing - open the product, or put one
 * in the cart. Everything else a catalog page needs - the grid itself, the category chips, the
 * toolbar and the pager - belongs to the components around it, and the tile takes what it shows as
 * props rather than reading a query string or a route of its own.
 *
 * COMPOSED FROM THE SHARED PRIMITIVES, NEVER FROM RAW CHROME
 * The surface is `@/components/ui/Card`, the availability chip is `@/components/product/StockBadge`
 * - the same component the product page shows, so one availability sentence does not read as two
 * different chips depending on which page a buyer is standing on - the category chip is `Pill`, the
 * saving and the cart count are `Badge`, both figures are `Price`, both controls are `Button`, and
 * the category's drawing is `CategoryGlyph`. Those primitives own their padding, typography,
 * borders, hover and focus treatment; `ProductCard.module.css` owns the tile's geometry and
 * nothing about their chrome. That is why no colour, size or space is written here and no element
 * carries an inline style: a value stated in this file could only disagree with the one the
 * primitive already resolves from the token set. The add-to-cart control is asked for the same
 * `lg` step the product page's own control uses, for the same reason.
 *
 * WORDING AND MONEY BELONG TO THEIR OWNERS
 * Every string a reader sees that is derived from data comes from `@/lib/format` - the availability
 * wording, the product code, the saving and the cart count - and the two prices are handed to
 * `Price` as whole numbers of cents for it to format. Nothing here builds an `Intl` formatter,
 * spells out an amount or does arithmetic on one beyond the saving's fraction, so the catalog
 * quotes a figure exactly as the cart, the checkout summary and the dashboard quote it. Nothing
 * is read from the clock, from `Math.random()` or from the document while rendering either, so
 * the markup the server sends and the markup the browser first produces always agree.
 *
 * ONE ACCESSIBLE NAME, AND REAL CONTROLS
 * The product's name is a link inside the tile's heading, which makes it the tile's accessible name
 * and its single navigation stop; the artwork beside it is decorative and carries an empty `alt` so
 * a reader is not told the same name twice. The card is only *styled* as holding something to act
 * on - it adds no handler, no role, no tab stop and no pointer cue of its own, so the artwork, the
 * product code and the price promise nothing they cannot answer - and the specs toggle and the
 * add-to-cart control stay ordinary buttons that a keyboard reaches in the order they are written.
 * The toggle states `aria-expanded` and points `aria-controls` at the specification list it opens,
 * and the availability chip carries its wording as text, so its colour is never the only thing
 * that reports the state.
 *
 * WHAT A FAILED QUICK-ADD SAYS
 * The press goes to the cart provider, which owns the request and reads the cart back from the
 * server before it reports a failed addition - units are added to whatever the line already holds,
 * so a request that came back a failure may still have been carried out. The tile catches that
 * rejection and states it through the notification queue, because a press that went nowhere would
 * otherwise leave the button back at idle with nothing said: a failure where the cart found the
 * units absent, and otherwise a notice saying they may have gone in, with the buyer sent to look
 * at their cart rather than told it is unchanged. The tile keeps nothing of its own for the press:
 * the button reports the cart's saving status and the count beside it is the cart's own line.
 *
 * ONE DISPLAY NAME
 * The inner function and the exported component both carry the `displayName` `ProductCard`, so
 * the component is reported under that one name.
 */

import clsx from 'clsx';
import Link from 'next/link';
import { memo } from 'react';

import { StockBadge } from '@/components/product/StockBadge';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CategoryGlyph } from '@/components/ui/CategoryGlyph';
import { Pill } from '@/components/ui/Pill';
import { Price } from '@/components/ui/Price';
import { useCart } from '@/hooks/useCart';
import {
  formatDiscountLabel,
  formatQuantityLabel,
  formatSkuLabel,
  formatStockLabel,
} from '@/lib/format';
import type { ProductSummary, StockState } from '@/lib/types';
import { CartAdditionError } from '@/providers/CartProvider';
import { useToastCenter } from '@/providers/ToastProvider';

import styles from './ProductCard.module.css';

/**
 * The drawing shown for a product whose own artwork is missing. It lives in `public/products/`
 * beside the catalog's pictures and shares their 4:3 proportions, so a tile without a photograph
 * keeps the height of its neighbours instead of collapsing or requesting a file that is not there.
 */
const PRODUCT_IMAGE_FALLBACK = '/products/product-placeholder.svg';

/**
 * The intrinsic size of the catalog artwork, in device-independent pixels. Travelling as the
 * element's `width` and `height` attributes, it reserves the frame before the file arrives, so a
 * grid does not shift under the reader as its pictures paint. The stylesheet then fits the drawing
 * inside that frame.
 */
const PRODUCT_IMAGE_WIDTH = 400;
const PRODUCT_IMAGE_HEIGHT = 300;

/**
 * How many units the tile's add-to-cart control puts in the cart. A buyer who wants more than one
 * sets the quantity on the product page, so the listing's control stays a single press.
 */
const ADD_TO_CART_QUANTITY = 1;

/**
 * Wording for a failed quick-add the cart did not author a sentence for, which is also a failed
 * quick-add whose outcome nobody established. Units are added to whatever the line already holds,
 * so the request may have been carried out before it failed: this neither states that the cart is
 * as it was nor invites a second press, both of which would be guesses.
 */
const UNSETTLED_ADDITION_BODY = 'Check your cart before adding this product again.';

/**
 * Which availability states may be added to the cart. Low stock is still sellable - the count in
 * the chip is what tells a buyer to hurry - and only a product with nothing available to promise
 * has its control disabled, which the server enforces again when the request arrives.
 */
const STOCK_PURCHASABLE: Record<StockState, boolean> = {
  IN_STOCK: true,
  LOW_STOCK: true,
  OUT_OF_STOCK: false,
};

/** One tile's inputs. */
export interface ProductCardProps {
  /** The product to present, exactly as the catalog listing returned it. */
  product: ProductSummary;
  /** Whether this tile's quick specifications are open. The grid owns which tile that is. */
  selected: boolean;
  /** Whether the catalog is currently filtered to this product's category. */
  categoryActive: boolean;
  /** Opens or closes the quick specifications. */
  onSelect: () => void;
  /** Filters the catalog by this product's category, or clears a filter already set on it. */
  onCategorySelect: () => void;
}

function ProductCardBody({
  product,
  selected,
  categoryActive,
  onSelect,
  onCategorySelect,
}: ProductCardProps) {
  const { lines, addLine, syncStatus } = useCart();
  const { showToast } = useToastCenter();

  // `find` answers `undefined` for a product that is not in the cart yet, which is the common case
  // and not a failure, so it is read as "no units" rather than asserted away.
  const cartLine = lines.find((line) => line.productId === product.id);
  const quantityInCart = cartLine === undefined ? 0 : cartLine.quantity;

  // A product without a picture arrives as `null`, and a row holding an empty string says the same
  // thing, so both resolve to the shared drawing before anything renders: there is no request to
  // fail and no broken-image frame to appear while it does. An address that is present but wrong
  // shows as the picture it names, which is the payload's problem and not this tile's to hide.
  const imageSrc =
    product.imageUrl === null || product.imageUrl.length === 0
      ? PRODUCT_IMAGE_FALLBACK
      : product.imageUrl;

  // The comparison price and the saving it implies are one decision, so they are resolved together:
  // a product is on offer only when a list price was recorded AND it is above what the product
  // sells for today. Holding both in one value keeps the comparison out of the markup and gives the
  // struck figure a `number` to render, with no assertion and no second null check below.
  const discount =
    product.listPriceCents === null || product.listPriceCents <= product.priceCents
      ? null
      : {
          listPriceCents: product.listPriceCents,
          fraction: (product.listPriceCents - product.priceCents) / product.listPriceCents,
        };

  const stockLabel = formatStockLabel(product.stockState, product.availableQuantity);
  const skuLabel = formatSkuLabel(product.sku);

  // The slug identifies one product within a listing, so it is enough to tie the toggle to the list
  // it controls without a generated id - which would differ between the server's markup and the
  // browser's first render.
  const specsId = `product-specs-${product.slug}`;

  function handleAdd(): void {
    // The provider owns the request: it publishes `saving` while the cart is written and the cart
    // the server answered with afterwards. What it cannot do is tell this tile how the press went,
    // so the rejection is caught here and announced - a press that went nowhere would otherwise
    // return the button to idle with nothing said about it. The press is not awaited: a tile in a
    // grid holds no state of its own, so there is nothing here for an answer to come back to.
    void addLine({ productId: product.id, quantity: ADD_TO_CART_QUANTITY }).catch(
      (cause: unknown) => {
        // Only an addition the cart read back and found had added nothing may be announced as a
        // failure. Anything else it could not settle, so the notice says the units may not have
        // gone in and sends the buyer to their cart rather than claiming it is unchanged.
        const unitsFoundAbsent =
          cause instanceof CartAdditionError && cause.outcome === 'not-applied';

        showToast({
          tone: 'danger',
          title: unitsFoundAbsent
            ? `${product.name} could not be added to your cart`
            : `${product.name} may not have been added to your cart`,
          body: cause instanceof CartAdditionError ? cause.message : UNSETTLED_ADDITION_BODY,
        });
      },
    );
  }

  return (
    <Card pad="md" interactive className={clsx(styles.root, selected && styles.selected)}>
      <div className={styles.media}>
        <img
          className={styles.image}
          src={imageSrc}
          alt=""
          width={PRODUCT_IMAGE_WIDTH}
          height={PRODUCT_IMAGE_HEIGHT}
          loading="lazy"
          decoding="async"
        />
        {/*
         * Availability is the one statement this tile and the product page make about the same
         * product in the same words, so it is the same component in both places: `StockBadge`
         * owns the state-to-tone decision and hands `Badge` the wording `@/lib/format` produced.
         * Rendering a `Pill` here instead would have put that sentence on the page at a second
         * size, weight and corner radius - the tile's own class only positions the chip over the
         * artwork, and the chip's appearance stays the primitive's.
         */}
        <StockBadge
          state={product.stockState}
          available={product.availableQuantity}
          className={clsx(styles.stock)}
        />
      </div>

      <div className={styles.body}>
        <h3 className={styles.title}>
          <Link className={styles.link} href={`/products/${product.slug}`}>
            {product.name}
          </Link>
        </h3>

        <p className={styles.sku}>{skuLabel}</p>

        <div className={styles.priceRow}>
          <Price cents={product.priceCents} size="md" />
          {discount === null ? null : (
            <>
              <Price cents={discount.listPriceCents} size="sm" tone="muted" strike />
              <Badge tone="success" size="sm">
                {formatDiscountLabel(discount.fraction)}
              </Badge>
            </>
          )}
        </div>
      </div>

      <div className={styles.category}>
        <Pill pressed={categoryActive} onClick={onCategorySelect} size="sm">
          <CategoryGlyph slug={product.categorySlug} size="sm" />
          {product.categoryName}
        </Pill>
      </div>

      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          onClick={onSelect}
          aria-expanded={selected}
          aria-controls={specsId}
        >
          {selected ? 'Hide specs' : 'Quick specs'}
        </Button>

        {/*
         * The committing action, asked for the same `lg` step as `../product/AddToCartControl` on
         * the product page, so "Add to cart" is one control at one size across the storefront.
         * `Button.module.css` owns what that step measures; `styles.add` places the control and
         * narrows only its inline padding so the label fits the narrowest column.
         *
         * It stays second in the DOM, after the specifications toggle, so the tab order follows
         * the markup: `.actions` gives it a row of its own by spanning both of the row's columns,
         * which moves nothing in the document.
         */}
        <Button
          variant="primary"
          size="lg"
          className={clsx(styles.add)}
          busy={syncStatus === 'saving'}
          disabled={!STOCK_PURCHASABLE[product.stockState]}
          onClick={handleAdd}
        >
          Add to cart
        </Button>

        {quantityInCart > 0 ? (
          <Badge tone="info" size="sm">{`${formatQuantityLabel(quantityInCart)} in cart`}</Badge>
        ) : null}
      </div>

      {selected ? (
        <dl id={specsId} className={styles.specs}>
          <dt className={styles.specsTerm}>SKU</dt>
          <dd className={styles.specsValue}>{skuLabel}</dd>

          <dt className={styles.specsTerm}>Category</dt>
          <dd className={styles.specsValue}>{product.categoryName}</dd>

          <dt className={styles.specsTerm}>Stock</dt>
          <dd className={styles.specsValue}>{stockLabel}</dd>
        </dl>
      ) : null}
    </Card>
  );
}

ProductCardBody.displayName = 'ProductCard';

/** Render one product tile. */
export const ProductCard = memo(ProductCardBody);

ProductCard.displayName = 'ProductCard';
