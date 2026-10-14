'use client';

import { useEffect } from 'react';

import { getSnapshot, publishActiveProduct } from './active-product-store';

/**
 * Props of {@link ActiveProductMarker}. `productId` is the id the product route
 * already resolved for the page it is rendering, so this component never looks
 * a product up itself.
 */
interface Props {
  productId: string;
}

/**
 * Announces the product currently on screen to the site chrome.
 *
 * The header is rendered by the root layout, which makes it an *ancestor* of
 * this route rather than a descendant, so context cannot carry the id to it.
 * The product page renders this marker instead, and it writes the id into the
 * module-level store the header reads with `useSyncExternalStore`.
 *
 * Nothing is rendered: the component exists for the announcement alone. The id
 * is published from an effect and never during render, so the store is still
 * empty while the server renders and on the browser's first pass, and the
 * header's initial markup agrees on both sides.
 */
export function ActiveProductMarker({ productId }: Props) {
  useEffect(() => {
    publishActiveProduct(productId);

    return () => {
      // Moving between two products on the client mounts the next marker before
      // this one is torn down, so clear the id only while it is still ours -
      // otherwise the header would lose a product that is already on screen.
      if (getSnapshot() === productId) {
        publishActiveProduct(null);
      }
    };
  }, [productId]);

  return null;
}
