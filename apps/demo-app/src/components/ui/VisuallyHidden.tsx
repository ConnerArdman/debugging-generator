/*
 * VisuallyHidden - the storefront's one screen-reader-only text primitive. It exposes its children
 * to assistive technology while hiding them visually and from layout: `.root` in
 * `VisuallyHidden.module.css` is absolutely positioned and clipped rather than merely transparent,
 * so the surrounding box is unchanged. It supplies the name where the visible content is
 * decorative - a busy control whose `Spinner` is `aria-hidden`, an icon-only button.
 *
 * Contract:
 * - One prop, `children`, in a local props type that a caller reads back with
 *   `React.ComponentProps<typeof VisuallyHidden>`. No `className`, no `as` and no variant: a
 *   caller that needs different geometry needs a different component.
 * - A `<span>`, so it is valid inline wherever the text is needed (inside a `<button>`, a `<th>`,
 *   an `<a>`) and adds no semantics of its own.
 * - Text only, never interactive children: a focusable element inside a clipped box moves focus
 *   where the eye cannot follow.
 * - Prefer a native label when one is wanted visually, and `aria-label` for a short name on a
 *   single element; this component is for names that are real content.
 *
 * No state, hooks or client directive, so it renders on either side.
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
