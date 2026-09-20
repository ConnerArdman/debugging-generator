/**
 * The id of the product currently being viewed, shared with the site chrome.
 *
 * The header is rendered by the root layout, so it sits *above* the product
 * route rather than inside it. React context only flows from an ancestor to
 * its descendants, which is the wrong direction here: the page knows the id
 * and the header needs it. A small module-level subscribable bridges the
 * gap: the product page publishes the id it resolved, and the header reads it
 * with `useSyncExternalStore`.
 *
 * The store deliberately holds one nullable string and nothing else. It does
 * no fetching, caching or formatting; that belongs to the components that use
 * it.
 */

type ActiveProductListener = () => void;

let activeProductId: string | null = null;

const listeners = new Set<ActiveProductListener>();

/**
 * Registers `listener`, which is invoked after every change to the active
 * product id, and returns a function that removes it again. The returned
 * cleanup is idempotent, so calling it more than once is harmless.
 */
export function subscribe(listener: ActiveProductListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reads the active product id, or `null` when no product page is mounted.
 *
 * The value is a primitive rather than a freshly built object, so repeated
 * reads without an intervening publish are `Object.is`-equal and subscribers
 * stay still.
 */
export function getSnapshot(): string | null {
  return activeProductId;
}

/**
 * The value readers see while rendering on the server, and on their very first
 * render in the browser. It is always `null`: the id is published from an
 * effect and never during render, so both renders agree and the markup the
 * server sent matches what the client first produces.
 */
export function getServerSnapshot(): string | null {
  return null;
}

/**
 * Publishes the id of the product being viewed, or `null` once the viewer has
 * moved on. A value equal to the one already held is ignored, so subscribers
 * are only woken when something actually changed.
 */
export function publishActiveProduct(productId: string | null): void {
  if (productId === activeProductId) {
    return;
  }

  activeProductId = productId;

  // Iterate over a copy: a listener is free to unsubscribe while it runs.
  for (const listener of Array.from(listeners)) {
    listener();
  }
}
