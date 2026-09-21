/**
 * @debuggen/panel-renderer - the monospace primitive.
 *
 * One component for every fragment of machine-authored text this product puts on a screen: a
 * symbol name, a project-relative file path, a parameterized database statement, a request
 * target, a stack frame, a captured attribute preview. It is used by the visualization
 * components, by the source-location chip, by the empty/loading/error states and by the editor
 * webview, so the whole product renders such text at one size, in one font and with one set of
 * overflow rules (AAP 0.6.2).
 *
 * TIER 1 ATOM
 * It imports nothing from this folder, nothing from `../layout`, `../components` or `../host`,
 * and no workspace package - React's types and `clsx` are its entire dependency surface. That is
 * what lets every other primitive and every component above them use it without a cycle, and it
 * is why this file has no notion of a panel, a query, a transport or a session.
 *
 * INLINE VERSUS BLOCK
 * The default form is a single `<code>`: a phrase-level element that flows inside a sentence, a
 * table cell or a chip, with no wrapper of its own. `block` renders `<pre><code>` instead - the
 * `<pre>` establishes the preformatted box that scrolls or wraps, the `<code>` keeps the "this is
 * code" semantic inside it. Both mark the same thing; only the box differs, which is exactly the
 * distinction HTML draws between the two elements. Nothing else changes: no border, no header, no
 * copy affordance, no line numbers.
 *
 * IT MUST NOT TRANSFORM WHAT IT IS GIVEN
 * `children` is rendered straight through. No trimming, no whitespace collapsing, no re-quoting,
 * no re-indenting, no case folding, no ellipsis, no line numbering and no syntax highlighting -
 * this package deliberately carries no highlighting dependency, because a tokenizer that
 * mis-lexes captured text would be indistinguishable, on screen, from data that really looked
 * that way. Whitespace and newlines survive byte-for-byte; the block form's `white-space`
 * handling is a stylesheet concern, not a string concern. A caller that needs a shortened value
 * shortens it before passing it in and says so with a `title`.
 *
 * PRIVACY: THIS IS THE END OF THE PIPELINE, NOT A STAGE IN IT (AAP 0.5.2)
 * Everything reaching this component has already been redacted and truncated upstream - once in
 * the telemetry layer's redaction pass before any event is persisted or broadcast, and again by
 * the model provider's outbound guard. So this component performs NO redaction, and equally it
 * must never undo any: it does not parse, re-expand, decode, re-serialise or "restore" its
 * children, it does not log them, and it has no way to send them anywhere. Anyone tempted to add
 * a helpful transformation here is looking at the wrong layer; redaction rules belong in the
 * telemetry package, and shortening belongs to the caller.
 *
 * APPEARANCE IS A CLASS CONTRACT, NEVER AN INLINE STYLE (AAP 0.6.4)
 * This file declares the class names and `src/styles/components.css` implements them. Nothing
 * here sets a colour, a length, a font or an inline style, and there is no literal CSS value in
 * this file at all:
 *
 *   `dg-code`             the base, on both forms
 *   `dg-code--block`      the preformatted box (block form only)
 *   `dg-code--md`         the `--dg-mono-md` type role - 12/16 (AAP 0.6.3)
 *   `dg-code--sm`         the `--dg-mono-sm` type role - 11/16
 *   `dg-code--numeric`    tabular figures, so digits line up in a column
 *   `dg-code--wrap`       wrap long content instead of scrolling it
 *
 * The two type roles are the only monospace sizes the design system has; both are complete `font`
 * shorthands over `--dg-font-mono`, and because that shorthand resets `font-variant`, the
 * stylesheet declares `font-variant-numeric` after it rather than before. That ordering is also
 * why `dg-code--numeric` is a class rather than nothing at all: the base layer already gives
 * every `<code>` and `<pre>` tabular figures at zero specificity, so a size class carrying the
 * shorthand resets them, and this variant is the declaration that asks for them back on the one
 * instance whose digits have to line up.
 *
 * ACCESSIBILITY
 * The block form carries `tabIndex={0}`: a box that can scroll horizontally has to be reachable
 * and scrollable with the keyboard alone (WCAG 2.1.1), and a `<pre>` is not focusable by default.
 * The inline form gets no `tabIndex` - it never scrolls, and a focus stop on every identifier in
 * a dense table would bury the real controls. No `role` is set either: `<code>` and `<pre>` carry
 * their own semantics, and `role="code"` would only restate one of them. An accessible name is
 * the caller's decision, passed as `aria-label`/`aria-labelledby` through the rest props; this
 * component never invents one, because a generic name is worse than the element's own text.
 *
 * RENDER BEHAVIOUR
 * A plain function component: no `memo`, no state, no effects, no context and nothing read from
 * the document while rendering, so it is safe to render thousands of times inside a virtualized
 * log or table and its output depends on its props alone.
 */

import clsx from 'clsx';

import type { HTMLAttributes, ReactElement, ReactNode, Ref, RefCallback, RefObject } from 'react';

/**
 * The two monospace type roles of the design system (AAP 0.6.3), and deliberately the only two:
 * `md` resolves to `--dg-mono-md` and `sm` to `--dg-mono-sm`. There is no third monospace role to
 * select, so a caller that wants something denser or larger is asking for a token that does not
 * exist rather than for a prop value.
 */
export type CodeSize = 'md' | 'sm';

/**
 * Size to class name.
 *
 * A `Record` over the finite union rather than a name built by interpolation: interpolation would
 * accept any string at the type level, would hide a typo until the text rendered unstyled in a
 * browser, and would make the class names this file declares invisible to a grep of the
 * stylesheet. Being a total `Record` over `CodeSize` also means the lookup below yields `string`
 * under `noUncheckedIndexedAccess`, so it needs no fallback and no non-null assertion, and adding
 * a role to `CodeSize` is a compile error here until it is mapped.
 */
const SIZE_CLASS: Readonly<Record<CodeSize, string>> = {
  md: 'dg-code--md',
  sm: 'dg-code--sm',
};

/**
 * Bridged ref callbacks for the block form, keyed by the caller's own ref object.
 *
 * Why a bridge is needed at all: the public `ref` prop is typed for `HTMLElement`, because that is
 * the common supertype of the two elements this component can be, but the block form's root is a
 * `<pre>`. React's `RefObject` holds a mutable `current`, which makes it invariant, so a
 * `RefObject<HTMLElement | null>` cannot be handed to a `<pre>` - the compiler rejects it, and it
 * is right to: the object's owner would be promised an element type it never receives. A ref
 * *callback* has no such problem (it only ever receives an element), so an object ref is adapted
 * into a callback that writes through to it. The caller's own `current` still ends up holding the
 * real `<pre>`.
 *
 * Why the cache: React re-attaches a ref whose identity changed, detaching the old one first. A
 * bridge built fresh on every render would therefore write `null` and then the node into the
 * caller's ref on every single render. Caching one bridge per ref object keeps the identity stable
 * for as long as the caller's ref is stable, which is what a ref passed straight through would
 * have done. A `WeakMap` holds the caller's object weakly, so an unmounted consumer's ref is
 * collectable and this module retains nothing.
 *
 * Callback refs need none of this and are passed through untouched, identity included.
 */
const BLOCK_REF_BRIDGES = new WeakMap<RefObject<HTMLElement | null>, RefCallback<HTMLPreElement>>();

/**
 * Adapts a caller's element ref for the block form's `<pre>`.
 *
 * @param ref The `ref` prop as given: absent, explicitly `null`, a callback or an object ref.
 * @returns The value to put on the `<pre>`; `undefined` when no ref was supplied.
 */
function blockRef(ref: Ref<HTMLElement> | undefined): Ref<HTMLPreElement> | undefined {
  // `null` is a legitimate ref value and means "no ref", exactly as `undefined` does here, and a
  // callback ref is already usable as-is because a callback is only ever handed an element.
  if (ref === undefined || ref === null || typeof ref === 'function') {
    return ref;
  }

  const cached = BLOCK_REF_BRIDGES.get(ref);
  if (cached !== undefined) {
    return cached;
  }

  const bridge: RefCallback<HTMLPreElement> = (node) => {
    ref.current = node;
  };
  BLOCK_REF_BRIDGES.set(ref, bridge);
  return bridge;
}

/**
 * The monospace primitive's inputs.
 *
 * Extending `HTMLAttributes<HTMLElement>` is what makes the rest-prop passthrough below a typed
 * contract rather than an escape hatch: callers routinely need `title` (the full value behind a
 * visually shortened one), `id` (so a heading elsewhere can label this text), `aria-label` /
 * `aria-describedby`, `data-*` hooks for tests, and `onClick` on an inline fragment that sits
 * inside a larger control. All of those arrive checked, and none of them needs a prop of its own
 * here.
 *
 * Every optional property states `| undefined` explicitly. `exactOptionalPropertyTypes` is on
 * repository-wide, which distinguishes an absent property from one present and `undefined`, so
 * without it a caller could not forward a value it computed as possibly-undefined - the common
 * case, since these flags are usually derived from the data being rendered.
 */
export interface CodeProps extends HTMLAttributes<HTMLElement> {
  /**
   * Renders the preformatted box form, `<pre><code>`, instead of a bare inline `<code>`. Use it
   * for content that owns a line or more of its own - a multi-line statement, a stack, the text
   * behind a failed request - and leave it off for a fragment that belongs inside running text, a
   * chip or a table cell.
   *
   * The block form is focusable so that it can be scrolled from the keyboard; see the file note
   * on accessibility.
   *
   * @default false
   */
  block?: boolean | undefined;

  /**
   * Which monospace type role to apply: `md` for text read on its own or beside body copy, `sm`
   * for a dense row where the surrounding interface text is already at its smallest. `md`
   * resolves to `--dg-mono-md` (12/16) and `sm` to `--dg-mono-sm` (11/16); those are the design
   * system's only two monospace roles (AAP 0.6.3).
   *
   * @default 'md'
   */
  size?: CodeSize | undefined;

  /**
   * Opts into tabular figures, so digits occupy identical widths and a column of numbers aligns
   * on the decimal point rather than drifting. Worth setting for counts, durations, sizes and
   * identifiers made of digits; it changes nothing about non-numeric text.
   *
   * @default false
   */
  numeric?: boolean | undefined;

  /**
   * Wraps content that is wider than the box instead of letting it scroll horizontally. Long
   * statements and long request targets are routinely wider than the cell that holds them, and a
   * horizontal scrollbar inside a table row is worse than a taller row - so a cell that shows
   * such a value sets this, while a block the reader is expected to scan line by line does not.
   *
   * It carries the most weight on the block form, which is the form that scrolls: there the
   * variant is what turns a scrolling box into a growing one. On the inline form the base layer
   * already breaks an over-long unbroken value rather than let a panel grow a horizontal
   * scrollbar, so the variant is asking for the preformatted wrapping behaviour - internal
   * whitespace runs kept while lines still break - rather than rescuing the layout.
   *
   * @default false
   */
  wrap?: boolean | undefined;

  /**
   * The text to render, rendered exactly as given. Redeclared from the inherited attributes only
   * to carry that guarantee: whitespace, indentation and newlines are preserved byte-for-byte and
   * nothing here reformats, highlights or shortens them (see the file notes on transformation and
   * privacy). A node rather than a string so a caller may emphasise a fragment of it - never so
   * it can nest an interactive control.
   */
  children?: ReactNode;

  /**
   * The rendered element: the `<code>` in the inline form, the `<pre>` in the block form - the
   * component's own root in both cases. React 19 takes `ref` as an ordinary prop, so this
   * component needs no `forwardRef` wrapper.
   *
   * Typed for `HTMLElement`, the supertype of both, which is also all a consumer can rely on
   * without knowing which form it asked for. A measuring or scrolling consumer that needs the
   * `<pre>` specifically already knows it passed `block`.
   */
  ref?: Ref<HTMLElement> | undefined;
}

/**
 * Renders monospace text.
 *
 * @param props See {@link CodeProps}.
 * @returns A `<code>`, or a `<pre><code>` when `block` is set.
 *
 * @example
 * // An identifier inside running text, and a dense numeric cell.
 * <Code>{event.name}</Code>
 * <Code size="sm" numeric>{formatDuration(event.duration)}</Code>
 *
 * @example
 * // A long value in a narrow cell wraps rather than scrolling; the untruncated value is the
 * // element's own tooltip.
 * <Code wrap title={value}>{value}</Code>
 *
 * @example
 * // A multi-line block, named by a heading that lives outside it.
 * <Code block aria-labelledby={headingId}>{text}</Code>
 */
export function Code(props: CodeProps): ReactElement {
  const {
    block = false,
    size = 'md',
    numeric = false,
    wrap = false,
    children,
    className,
    ref,
    ...rest
  } = props;

  const sizeClass = SIZE_CLASS[size];

  if (block) {
    return (
      // `tabIndex` is placed before the rest props on purpose: the focusable default is what a
      // scrollable box needs, and a caller that has a reason to change it - a block inside a
      // composite widget that manages its own focus order - can still pass its own.
      <pre
        className={clsx(
          'dg-code',
          'dg-code--block',
          sizeClass,
          numeric && 'dg-code--numeric',
          wrap && 'dg-code--wrap',
          className,
        )}
        tabIndex={0}
        ref={blockRef(ref)}
        {...rest}
      >
        <code>{children}</code>
      </pre>
    );
  }

  return (
    <code
      className={clsx(
        'dg-code',
        sizeClass,
        numeric && 'dg-code--numeric',
        wrap && 'dg-code--wrap',
        className,
      )}
      ref={ref}
      {...rest}
    >
      {children}
    </code>
  );
}
