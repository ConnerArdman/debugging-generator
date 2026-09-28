/**
 * @debuggen/panel-renderer — src/primitives/untrusted-text.ts
 *
 * The one sanctioned presentation formatter for untrusted text: what every
 * string a design-system primitive renders passes through, and what a consumer
 * surface applies to a string it puts into an element or an attribute of its
 * own.
 *
 * ## The threat
 *
 * Almost every string this product displays is untrusted. Span names, request
 * targets, statements, component names, previews and file paths come from a
 * capture of an application under investigation; summaries, causes and
 * reasons come from a model reading that capture. React already keeps such a
 * string from becoming markup — it is always a text node or an attribute
 * value — but a text node can still lie. The twelve Unicode bidirectional
 * formatting controls (U+061C, U+200E, U+200F, U+202A–U+202E and
 * U+2066–U+2069) are invisible and reorder the glyphs drawn after them: a span
 * named `QA \u202E</td><script>alert(7)</script>\u202C` is drawn with its
 * tail reversed, so the panel shows a sequence the capture never contained,
 * while `textContent` still holds the truth. That is the "Trojan Source"
 * class (CVE-2021-42574) applied to a debugging surface, where a misleading
 * label is a misleading diagnosis.
 *
 * ## The remedy, and why it is not a transformation of meaning
 *
 * {@link formatUntrustedText} replaces each control with its visible
 * six-character escape — U+202E prints as `\u202E` — and changes nothing else,
 * so what is on screen is exactly the logical text: every captured character
 * in captured order, with the controls that were there shown where they were.
 * Revealing is therefore not an edit of the data but the guarantee that the
 * display matches it. The definition lives in `../utils/format`, beside the
 * other display helpers that apply it to what they return, and is re-exported
 * here so the primitives and both consumer surfaces share one spelling of it.
 *
 * ## What stays raw
 *
 * Presentation only. The stored event, the aggregate a view reads, React keys,
 * `data-*` attributes, the arguments of a selection or open-source callback
 * and anything compared or looked up all keep the raw value: revealing a key
 * would make two distinct captured values collide or a lookup miss. Reveal at
 * the point text becomes visible or announced — a child, a `title`, an
 * `aria-label`, an SVG label — and nowhere upstream of it.
 *
 * ## Position in the package
 *
 * A leaf helper of the primitives folder, not a component: it imports only the
 * pure string module `../utils/format` and React's types (type-only, so it adds
 * no runtime edge), and the primitives that render text import it. The barrel
 * publishes it from here, which is what keeps `../utils` itself unpublished.
 *
 * @example
 * ```tsx
 * // A consumer's own attribute, revealed with the same definition the primitives use.
 * <li title={formatUntrustedText(event.name)} data-event-id={event.id}>
 *   <Text size="sm">{event.name}</Text>
 * </li>
 * ```
 *
 * @module
 */

import type { ReactNode } from 'react';

import { containsDirectionControl, formatUntrustedText } from '../utils/format';

export { containsDirectionControl, formatUntrustedText };

/**
 * Reveals the direction controls in the text of a React node, for rendering.
 *
 * - A string is revealed with {@link formatUntrustedText}.
 * - An array is mapped recursively, member by member, in order: every element
 *   in it is the same object, with the same key, so React reconciles the list
 *   exactly as before. When no member changed, the original array is returned.
 * - Every other node is returned untouched: an element (its component renders
 *   its own text — a primitive nested inside reveals its own children, and a
 *   raw intrinsic element nested inside is its author's to reveal), a number, a
 *   bigint, a boolean, `null`, `undefined`, a portal, a promise, and an
 *   iterable that is not an array, which may be single-use and is not consumed
 *   here.
 *
 * Pure and allocation-free for the common case: a node with no control in it
 * comes back as the same value.
 *
 * @param node The children or content a primitive was given.
 * @returns The node to render in its place.
 *
 * @example
 * ```tsx
 * formatUntrustedNode(['GET ', <Code key="u">{url}</Code>, ' \u202Eslow']);
 * // ['GET ', <Code key="u">{url}</Code>, ' \\u202Eslow'] — the same element object
 * ```
 */
export function formatUntrustedNode(node: ReactNode): ReactNode {
  if (typeof node === 'string') {
    return formatUntrustedText(node);
  }

  if (Array.isArray(node)) {
    // `Array.isArray` narrows to `any[]`; the annotation restores the member
    // type, and the original array is returned through it when nothing changed.
    const members: readonly ReactNode[] = node;
    let changed = false;
    const shown = members.map((member) => {
      const revealed = formatUntrustedNode(member);
      if (revealed !== member) {
        changed = true;
      }
      return revealed;
    });
    return changed ? shown : members;
  }

  return node;
}
