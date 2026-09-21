/*
 * VisuallyHidden - the storefront's one screen-reader-only text primitive.
 *
 * It renders its children into the accessibility tree while removing them from the visual
 * rendering and from layout, which is the whole of its job: the geometry lives in
 * VisuallyHidden.module.css (`.root`, the module's only class), and this file is the component
 * that applies it.
 *
 * Why the application needs it
 * ----------------------------
 * `Spinner` and `Skeleton` are decorative - they carry `aria-hidden`, so a control that is busy
 * has no accessible name of its own and the caller must supply one. Icon-only controls in the
 * layout and cart groups are in the same position: the glyph is a picture, the name is text, and
 * the text must not be painted. Wrapping that text here is how both cases get a name without a
 * visible label:
 *
 *     <button type="button" disabled={submitting}>
 *       <Spinner />
 *       <VisuallyHidden>Placing order</VisuallyHidden>
 *     </button>
 *
 * The button's accessible name becomes "Placing order" while its box is unchanged, because
 * `.root` is absolutely positioned and clipped rather than merely transparent.
 *
 * Contract
 * --------
 * - One named export, `VisuallyHidden`, and one prop, `children`. There is no `as`, no `className`
 *   passthrough and no variant: a caller that needs different geometry needs a different component,
 *   not an escape hatch through this one. Sibling groups that need this shape read it back with
 *   `React.ComponentProps<typeof VisuallyHidden>` rather than importing a props type from here.
 * - No client-component directive at the top of this file, so it renders in a Server Component as
 *   happily as in a Client one. That holds only while the component stays free of hooks, state,
 *   event handlers and browser globals - it takes props and returns markup, and nothing more.
 * - A `<span>`, deliberately: an inline element is valid wherever the accessible text is needed
 *   (inside a `<button>`, a `<th>`, an `<a>`, a `<li>`) and it adds no semantics of its own, so it
 *   never changes how the surrounding element is announced.
 * - Render-pure and hydration-safe: the output is a function of `children` alone, with no clock,
 *   no randomness and no `window`/`document` read, so the server and client markup always agree.
 *
 * Usage notes
 * -----------
 * - Prefer a native label where one is wanted visually; this is for text that must exist only for
 *   assistive technology. Overusing it produces an interface that reads differently from how it
 *   looks.
 * - Interactive children are a mistake, not a feature: a focusable element inside a clipped box
 *   moves focus to a place the eye cannot follow. Pass text (or text plus inline formatting).
 * - `aria-label` is the better tool when the name belongs to a single element and is a short
 *   string; this component wins when the name is real content - it can be translated as markup,
 *   selected by the accessibility tree as text, and can contain inline elements.
 */

import type { ReactNode } from 'react';

import styles from './VisuallyHidden.module.css';

/**
 * Props of `VisuallyHidden`, intentionally local to this module (see the contract above).
 *
 * `children` is `ReactNode`, so text, numbers, fragments and `null` are all accepted; rendering
 * nothing is legitimate, because a caller may hold the announcement until it has one to make.
 */
interface Props {
  /** The text to expose to assistive technology and hide from the visual rendering. */
  children: ReactNode;
}

/**
 * Expose `children` to assistive technology without painting them or affecting layout.
 *
 * `styles.root` is typed `string | undefined` under `noUncheckedIndexedAccess`, which `className`
 * accepts as-is: an undefined class would mean the stylesheet failed to load, and the text would
 * then be visible rather than silently dropped - the safe direction to fail in.
 */
export function VisuallyHidden({ children }: Props) {
  return <span className={styles.root}>{children}</span>;
}
