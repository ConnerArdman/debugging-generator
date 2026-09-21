'use client';

/*
 * ProductGallery - the artwork on a Lumen Supply product page.
 *
 * One large frame holding the picture the reader has chosen, and beneath it a strip of
 * thumbnails, one per picture the product carries. The product route renders it beside the
 * product's name, price, stock badge and specifications, and it is the only component in this
 * workspace that reads a product's `images`.
 *
 * WHY IT IS A CLIENT COMPONENT
 * For the selection, and for nothing else. Which picture is in the frame is state the reader
 * owns, so the component holds it - and that is the whole of its interactivity. There is no
 * effect, no ref, no timer, no clock or random read, no request and no context subscription
 * here, so its first client render reproduces the server's markup exactly and it re-renders only
 * when its own props change or its parent renders.
 *
 * MARKUP CONTRACT WITH `./ProductGallery.module.css`
 * The stylesheet styles a frame (`.stage`) around the main picture (`.image`), a list (`.thumbs`)
 * of thumbnail controls (`.thumb`, each holding a `.thumbImage`), and the column that stacks the
 * two (`.root`). Three parts of that contract are load-bearing here:
 *
 *   - The strip is a `<ul>` whose every child is an `<li>` holding one control. The thumbnail
 *     rules are written as `.thumbs li .thumb`, which is what lets them outweigh the shared
 *     button's own padding and background rules; a control placed outside a list item would keep
 *     the button's text padding and shrink its picture to a fraction of the frame.
 *   - The selected thumbnail is selected by `[aria-pressed='true']`, so the attribute below is
 *     what paints it. Its inset outline is a shape rather than a tint, so the selection survives
 *     greyscale and forced colours, and it is never the only carrier of the fact: the same
 *     control announces its pressed state and names the picture it would show.
 *   - `.stage` declares the 4:3 ratio of the pictures under `public/products/`, so the frame is
 *     reserved before any file arrives. Switching pictures therefore moves nothing on the page,
 *     and with images turned off the alternative text reads inside a frame that still holds its
 *     place.
 *
 * KEYBOARD AND ASSISTIVE BEHAVIOUR
 * Each thumbnail is the shared `Button`, so it is a real `<button>`: `Tab` reaches it, `Enter`
 * and `Space` press it, and the stylesheet gives it a focus ring. It carries `aria-pressed`,
 * which makes it a toggle whose state is announced, and its name - "View image 2 of 4" - is
 * hidden text inside it, because the picture beside that text is the button's own label and has
 * nothing to add to it. The thumbnails are deliberately not a tab list: they are buttons that
 * change one picture, and nothing here overrides what the browser already does with them.
 *
 * DEGRADATION
 * A product may carry no artwork at all, and a record may carry a blank path. Both render the
 * shared placeholder drawing in the frame, described by the product's name, so the page still
 * reads as a product page. The decision is made on the value, before anything is requested -
 * there is no load-failure handler here, because a path that is present is trusted exactly as
 * the catalog stored it. With one picture, or none, the strip is not rendered: a single control
 * that switches to the picture already on screen is noise in the layout and one more stop on the
 * way through the page.
 */

import clsx from 'clsx';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { VisuallyHidden } from '@/components/ui/VisuallyHidden';
import type { ProductImage } from '@/lib/types';

import styles from './ProductGallery.module.css';

/**
 * The drawing shown for a product with no artwork of its own. It is the same file the catalog
 * records against a product whose category has no drawing, so a product that falls back here
 * looks like the rest of the catalog rather than like a broken page.
 */
const FALLBACK_IMAGE_SRC = '/products/product-placeholder.svg';

/**
 * The intrinsic size of every drawing under `public/products/`, given to each element so the
 * browser knows the picture's ratio before the file arrives. The stylesheet decides how large
 * the frames actually are; these two numbers only describe what goes in them.
 */
const FRAME_WIDTH = 400;
const FRAME_HEIGHT = 300;

/**
 * Props of {@link ProductGallery}.
 *
 * Local and not exported: the product route types its own payload and passes it through, so no
 * other module needs this shape.
 *
 * `images` is `readonly` because it arrives straight from the product payload and is shared with
 * everything else on the page that reads it; this component only ever iterates it. `className`
 * spells `| undefined` out because this workspace compiles with `exactOptionalPropertyTypes`,
 * under which a bare `className?: string` rejects the `string | undefined` a caller reading an
 * optional field of its own actually holds.
 */
interface Props {
  /** The product's pictures, in the order the catalog returned them. An empty list is normal. */
  images: readonly ProductImage[];
  /** The product's name, used to describe a picture that carries no description of its own. */
  productName: string;
  /** The placing module's class, composed alongside `.root` for width and placement. */
  className?: string | undefined;
}

/**
 * The path to show for one picture: what the catalog stored, or the placeholder when it stored
 * nothing usable. A missing record and a blank path are the same case deliberately - neither
 * names a file, and both would otherwise render an empty frame.
 */
function source(image: ProductImage | undefined): string {
  return image === undefined || image.url.trim().length === 0 ? FALLBACK_IMAGE_SRC : image.url;
}

/**
 * The description to read for the picture in the frame: the one stored against it, or the
 * product's name. Never empty, because the frame is the page's picture of the product and
 * carries meaning that the surrounding copy does not repeat.
 */
function caption(image: ProductImage | undefined, name: string): string {
  return image === undefined || image.alt.trim().length === 0 ? name : image.alt;
}

/** Render the product's artwork: the chosen picture, and the strip that chooses it. */
export function ProductGallery({ images, productName, className }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const total = images.length;
  // A client navigation between two products replaces `images` while this component stays
  // mounted, and the remembered position can then point past the end of a shorter gallery.
  // Clamping it here - rather than resetting it from an effect - keeps the frame and the pressed
  // thumbnail describing the same picture on the render the new product first appears in.
  const active = selectedIndex < total ? selectedIndex : 0;
  // Indexed reads are `ProductImage | undefined` in this workspace, which is exactly the case a
  // product with no artwork presents; `source` and `caption` answer for it rather than a
  // non-null assertion claiming it cannot happen.
  const current = images[active];

  return (
    <div className={clsx(styles.root, className)}>
      <div className={styles.stage}>
        {/*
          A plain image element with a string path, not a static asset import and not the
          framework's image component. An imported asset is typed by the generated, git-ignored
          next-env.d.ts, so a clean clone that has never run a build would fail `tsc` on it; and
          the optimiser passes SVG through untouched unless the project configures it to do
          otherwise, which this one deliberately does not. The intrinsic size travels as the
          width and height attributes so the ratio is known before the file arrives.
        */}
        <img
          className={styles.image}
          src={source(current)}
          width={FRAME_WIDTH}
          height={FRAME_HEIGHT}
          alt={caption(current, productName)}
        />
      </div>
      {total <= 1 ? null : (
        <ul className={styles.thumbs}>
          {images.map((image, index) => (
            // The stored path is the only field a picture carries that could identify it, and a
            // gallery can hold the same path twice - two records sharing the placeholder - so the
            // position follows it to keep the key unique. Order is the catalog's and no state
            // lives below this list, so a positional component reconciles cleanly.
            <li key={`${image.url}:${index}`}>
              <Button
                variant="ghost"
                // A class from a CSS Module is `string | undefined` in this workspace, and the
                // shared button takes a plain optional string, so the value is narrowed through
                // `clsx` here: a class the stylesheet failed to provide becomes no class at all
                // rather than the word "undefined" in the attribute.
                className={clsx(styles.thumb)}
                aria-pressed={index === active}
                onClick={() => {
                  setSelectedIndex(index);
                }}
              >
                {/* Described by the control's own hidden name, so the picture adds nothing. */}
                <img
                  className={styles.thumbImage}
                  src={source(image)}
                  width={FRAME_WIDTH}
                  height={FRAME_HEIGHT}
                  alt=""
                />
                <VisuallyHidden>{`View image ${String(index + 1)} of ${String(total)}`}</VisuallyHidden>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
