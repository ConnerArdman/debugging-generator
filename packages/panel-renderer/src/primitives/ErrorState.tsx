/**
 * `ErrorState` — the failure placeholder of `@debuggen/panel-renderer`.
 *
 * ## Why this primitive is structural, not decorative
 *
 * Every catalogued visualization component in this package has exactly three
 * structural states, and AAP 0.6.2 names the renderer of each one: empty
 * (`EmptyState`), loading (`LoadingState`) and error — "`ErrorState` with the
 * query and a retry action". This is that third renderer, and it is the only
 * one: all thirteen visualization components and the `host/` layer render it
 * rather than inventing a failure box of their own, so a failure looks and
 * behaves identically wherever in a generated panel it happens.
 *
 * It is reached on one path. A node resolves its data query through
 * `host/useQuery` against a `DataProvider`, which crosses two process
 * boundaries — the DevTools panel, the extension service worker, then the local
 * service's panel-data route. Anything on that path can fail: the socket can be
 * reconnecting, the credential can have been rotated, the session can have
 * ended, the query can name a source the capture does not hold. When it does,
 * the node's box is occupied by this component.
 *
 * ## A failure stays a failure
 *
 * AAP 0.5.5's rule is that "a failure is never presented as a successful
 * analysis", and this component is the visible half of it. Three consequences
 * are requirements here rather than preferences:
 *
 *   1. It reads unmistakably as a failure. The title carries the `danger` text
 *      tone and the box is marked as a failure by the stylesheet, so a reader
 *      scanning a panel cannot mistake this region for a resolved one.
 *   2. It is never shaped like a result. Observed facts and likely causes are
 *      structured, evidence-bearing content that `layout/SummaryHeader` renders
 *      from a validated analysis; nothing here is styled or ordered like them,
 *      and this component never paraphrases an error into analysis-like prose.
 *      It reports what failed and shows the query that failed.
 *   3. It is not the panel-level fallback banner. A generated specification
 *      that fails validation is a different event at a different scale: the
 *      service marks the deterministic replacement it built from the capture,
 *      and `host/PanelHost` renders the banner for it from that marker. That
 *      banner is emphatically NOT this component's job and must not be
 *      rendered, defaulted or worded here — one failed query is not a failed
 *      panel, and conflating them would tell a developer their whole panel is
 *      untrustworthy because one node's request timed out.
 *
 * ## Tier 3, and the narrowest possible composition
 *
 * It composes four primitives from this folder and nothing else from the
 * package: `Text` for the copy, `Code` for the query block, `Button` for the
 * retry control and `Badge` for the optional machine code. It imports no layout
 * primitive, no visualization component, no host module, no panel schema, no
 * protocol type and no transport, so the only thing above it in the package's
 * dependency order is whoever renders it — which is what lets the whole catalog
 * and the host layer use it with no risk of a cycle (AAP 0.2.2, 0.6.2).
 *
 * ## Why `query` is a `string`
 *
 * The failing query's real type is the data-query object declared by
 * `@debuggen/panel-schema`, and a primitive in this folder must not import it:
 * the primitives layer is schema-agnostic by design, which is what keeps it
 * usable from the DevTools panel, the editor webview and a component test with
 * no panel specification anywhere in sight (AAP 0.6.2 — "the renderer depends
 * on the schema, never the reverse", and this folder does not even depend on
 * the schema).
 *
 * So the caller — `host/useQuery` or `host/NodeRenderer`, which already hold
 * the typed object — serialises it exactly once, in pretty-printed JSON form,
 * and hands over the resulting string. This is a deliberate API decision, not
 * an oversight, and it must not be "improved" into a typed prop.
 *
 * This file also never serialises anything itself. A value handed to a
 * serialiser can be cyclic or carry a throwing accessor, and the inside of an
 * error renderer is the worst possible place in a product to throw: the render
 * that was reporting a failure would fail, and the reader would be left with an
 * empty region and no explanation. Serialisation happens where the value's type
 * is known and a failure can still be handled; here the string is rendered as
 * given.
 *
 * ## Privacy
 *
 * Everything this component renders arrives already redacted. Telemetry
 * attributes, request targets and statements pass through the redaction layer
 * at ingest before any of them can reach a panel (AAP 0.5.2), so this file
 * performs no redaction of its own and — just as importantly — never reverses,
 * re-parses, reformats, truncates, stores or logs what it is handed. There is
 * no `console` call anywhere in this module: a diagnostic written from here
 * would copy a message and a query into a log this product's privacy model
 * never accounted for.
 *
 * ## No heading element, in any form
 *
 * The title is body text with a raised weight, not a heading — the same ruling
 * `EmptyState` records. An error state appears wherever a generated panel puts
 * the node that rendered it, nested at a depth this file cannot know, so
 * emitting an `h*` here would insert an outline level that the `Heading`
 * primitive and `layout/Section` never sanctioned. A skipped or duplicated
 * level is invisible on screen while being exactly what a screen-reader user
 * navigates by, so outline decisions stay with the components that own the
 * surrounding structure (AAP 0.6.4).
 *
 * ## Live regions: the division of labour across the three states
 *
 * This component owns `role="alert"` — the assertive announcement, warranted
 * precisely once: when something failed. The other two states are deliberately
 * different and must stay that way: `LoadingState` owns the busy announcement
 * (`role="status"`, `aria-live="polite"`, `aria-busy="true"`) while a query is
 * in flight, and `EmptyState` carries no live region at all, because "nothing
 * was captured" is a resting state a reader navigates to rather than an event
 * worth interrupting for. Exactly one of the three can speak at a time, which
 * is what keeps a panel resolving eight queries from talking over itself.
 *
 * The role is set before the caller's attributes are spread, so it is the
 * default rather than a fixture: a caller rendering several failures inside a
 * region that already alerted can quiet the inner ones. That is not the normal
 * case, and an unqualified error state alerts.
 *
 * ## Appearance is class names, and nothing else
 *
 * Not one colour, length, font or radius appears in this module, and there is
 * no inline `style` object, no width, no height and no minimum height: the
 * container's geometry and every visual value belong to
 * `../styles/components.css`, which resolves them to `--dg-*` tokens
 * (AAP 0.6.3, 0.6.4). The class contract this file DECLARES, and that
 * `components.css` must implement:
 *
 *   dg-error-state              the block — a column on
 *                               `--dg-surface-elevated` inside
 *                               `--dg-border-subtle`, with a `--dg-danger`
 *                               edge so the region reads as a failure even in
 *                               the minimal form, where no glyph and no chip
 *                               are passed; `--dg-space-*` for its padding and
 *                               for the gap between the parts
 *   dg-error-state__icon        the decorative glyph box, in `--dg-danger`
 *   dg-error-state__title       the first line, which `Text` already renders at
 *                               the `--dg-text-md` role, the raised weight and
 *                               the `--dg-danger` tone
 *   dg-error-state__message     the required explanation, which `Text` already
 *                               renders at the `--dg-text-sm` role in
 *                               `--dg-text-secondary`
 *   dg-error-state__query       the query block, which `Code` already asks for
 *                               at the `--dg-mono-sm` role; a scrollable,
 *                               wrapping box inside `--dg-border-strong` with
 *                               its text in `--dg-text-primary`. Its rule must
 *                               also make the inner `<code>` inherit that role
 *                               (`.dg-error-state__query > code { font:
 *                               inherit; }`): `base.css` sets the monospace
 *                               role on bare `code` and `pre` elements through
 *                               a `:where()` selector, and `Code` renders the
 *                               inner `code` without a class, so without the
 *                               inherit the glyphs paint one type step above
 *                               the role this block asked for. Verified at
 *                               runtime — the `<pre>` computes the `sm` role
 *                               while the `<code>` inside it computes the `md`
 *                               one until that declaration exists.
 *   dg-error-state__action      the control box, spaced from the copy by
 *                               `--dg-space-*`
 *
 * No element class is declared for the optional machine code: it is a `Badge`,
 * which carries its own block and tone classes, and `components.css` positions
 * it from the block (`.dg-error-state > .dg-badge`) rather than through a
 * sixth element this file would have to invent.
 *
 * The two global utilities of `../styles/base.css` are reused and never
 * redefined: `dg-icon` is the square the caller puts on its glyph, and
 * `dg-visually-hidden` stays available to callers without being needed here —
 * the query block is named with `aria-label` rather than an id reference,
 * because generating an id would mean a hook, and this component has none.
 */

import clsx from 'clsx';
import type { HTMLAttributes, ReactElement, ReactNode } from 'react';

import { Badge } from './Badge';
import { Button } from './Button';
import { Code } from './Code';
import { Text } from './Text';

/**
 * The first line an unqualified `<ErrorState>` renders.
 *
 * Generic product vocabulary, and deliberately about the view rather than about
 * the cause: this component cannot see what failed, the `message` is where the
 * cause is stated, and a default that guessed at one would be wrong most of the
 * time. It names nothing from an inspected project and interpolates nothing
 * (AAP 0.5.4).
 */
const DEFAULT_TITLE = 'Could not load this view';

/**
 * The label an unqualified retry control carries.
 *
 * One word, because the control sits in a dense panel section, and generic
 * because the retry is always the same act — resolve the query again.
 */
const DEFAULT_RETRY_LABEL = 'Retry';

/**
 * The accessible name of the query block.
 *
 * The block is a focusable, scrollable region of preformatted text, so it needs
 * a name of its own: without one, a screen-reader user reaching it by keyboard
 * is given the serialised query with no indication of what the text is. It is
 * supplied as an `aria-label` rather than an `aria-labelledby` reference to a
 * visually hidden sibling, because a reference needs a generated id, a
 * generated id needs a hook, and this component has no hooks by contract.
 */
const QUERY_ACCESSIBLE_NAME = 'Failing query';

/**
 * The role the query block carries so that its name is legitimate.
 *
 * `Code`'s block form renders a `<pre>`, which HTML-AAM maps to the `generic`
 * role — and `generic` is one of the roles for which ARIA prohibits
 * `aria-label` and `aria-labelledby`, so a name placed on it is discarded by
 * some assistive technology and reported as a prohibited attribute by
 * automated checks. `group` is the lightest role that accepts a name: it makes
 * the label above take effect on a box the keyboard can reach, and unlike
 * `region` it adds no landmark to a panel that may hold a dozen nodes.
 *
 * This is invisible accessibility — it changes the accessibility tree and
 * nothing that is painted — so it applies unconditionally.
 */
const QUERY_ROLE = 'group';

/**
 * Whether a node would render anything a reader could perceive.
 *
 * `null`, `undefined` and both booleans render nothing in React, and the empty
 * string renders no text, so none of them justifies a glyph box: an empty
 * wrapper still carries that wrapper's gap, which shows up as an unexplained
 * blank strip above the copy. `0` is renderable and stays renderable, and no
 * value is ever coerced into visible text — AAP 0.6.4's defensive rule is that
 * "null" and "undefined" must never reach the screen as words.
 *
 * The predicate is local, exactly as it is in `EmptyState`: it is three
 * comparisons over a React type and nothing about it is design-system
 * vocabulary, so it stays private to this module rather than becoming a shared
 * utility the primitives layer would have to import from somewhere.
 *
 * @param node The slot content a caller supplied, if any.
 * @returns `true` when the node contributes visible or announced content.
 */
function isRenderable(node: ReactNode): boolean {
  return node !== null && node !== undefined && typeof node !== 'boolean' && node !== '';
}

/**
 * Whether an optional string carries text worth rendering.
 *
 * An absent value and an empty string are treated alike — both mean "this part
 * is not present" — so a caller forwarding an optional value it may not have
 * gets the same result as one that omitted the prop, and no part of this state
 * is ever rendered as an empty box or a blank line.
 *
 * It is a type predicate so the narrowed `string` can be handed to a primitive
 * that requires one, with no cast and no non-null assertion.
 *
 * @param value The prop as the caller passed it, if at all.
 * @returns `true` when the value is a non-empty string.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/**
 * The inputs of one error state.
 *
 * Extending React's `HTMLAttributes` is what keeps this interface short while
 * leaving the container fully addressable: `id`, every `aria-*` attribute,
 * every `data-*` attribute and the event handlers reach the rendered element
 * through `...rest` with their standard types, without being enumerated here.
 *
 * `children` is removed from that inherited set and never re-declared: the
 * parts of an error state are named props in a fixed order, so arbitrary
 * children would be a second, unordered way to put content in the same box —
 * and an error box whose content a caller can replace is no longer a guarantee
 * about how failures look (AAP 0.5.5).
 *
 * Every optional member states `| undefined` explicitly:
 * `exactOptionalPropertyTypes` is in force repository-wide
 * (tsconfig.base.json), and a caller forwarding a value it may not have —
 * `code={failure.code}`, `query={serialisedQuery}` — has to stay legal.
 */
export interface ErrorStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * What went wrong, in one sentence, and the only required prop.
   *
   * The caller owns this wording: it is the failure as the layer that observed
   * it understands it — a transport error, a rejected request, a source the
   * capture does not hold — and this file supplies no default for it, because a
   * default would have to be vague enough to be useless. Write what failed, not
   * what it might mean: an inference about a cause belongs to a validated
   * analysis, never to an error box (AAP 0.5.5).
   *
   * Rendered as body text through `Text` at the `--dg-text-sm` role in
   * `--dg-text-secondary`, beneath the title.
   */
  message: string;

  /**
   * The first line, above the message. Defaults to a generic statement that the
   * view could not be loaded.
   *
   * Rendered through `Text` at the `--dg-text-md` role, with the raised weight
   * and the `--dg-danger` tone, as a paragraph. It is NOT a heading and no
   * heading element is emitted for it, for the reason this module's header
   * records. Status colours are text-safe in every theme (AAP 0.6.3), which is
   * what makes the danger tone legitimate on text here rather than a contrast
   * regression.
   *
   * Passing the empty string suppresses the line entirely, for a caller that
   * has stated the failure fully in `message` and wants no second line. The
   * region still announces itself as an alert and the stylesheet still marks
   * the box, so the failure remains unmistakable.
   *
   * This repurposes the inherited HTML `title` attribute: the value is rendered
   * as the line above, and is not forwarded to the container as a tooltip. A
   * hover explanation belongs to the `Tooltip` primitive.
   */
  title?: string | undefined;

  /**
   * A short machine-readable code for the failure — the kind a developer can
   * search a log or an issue tracker for.
   *
   * Rendered as a `Badge` with the `danger` tone, never as a bare styled
   * element (AAP 0.6.4 permits no raw markup where a primitive exists). It is a
   * code, not a sentence: the human-readable form of the same failure is
   * `message`, and a code is useless to a reader who is not given both.
   *
   * Omitted, absent or blank, no chip is rendered.
   */
  code?: string | undefined;

  /**
   * The query that failed, already serialised to a string by the caller.
   *
   * It is a `string` deliberately — see this module's header for the full
   * rationale: the typed query object belongs to the panel schema, which this
   * folder does not depend on, so `host/useQuery` or `host/NodeRenderer`
   * serialises it once (pretty-printed JSON is the expected form) and hands the
   * result over. Nothing in this file serialises, re-parses or reformats it.
   *
   * Rendered through `Code` in its block form at the `--dg-mono-sm` role, with
   * wrapping on and preserved exactly as given: every newline, every space and
   * every character of indentation survives, and the text is never shortened or
   * elided, because a query a reader cannot read in full is a query they cannot
   * check. The block is focusable, so it can be scrolled from the keyboard, and
   * it is named by `aria-label` on a `group` role that accepts that name.
   *
   * Showing it is what AAP 0.6.2 asks of this component: a failure a developer
   * can act on has to say what was asked for, not only that asking failed.
   *
   * Omitted, absent or blank, no block is rendered.
   */
  query?: string | undefined;

  /**
   * What to do when the reader asks for the query to be tried again.
   *
   * The retry affordance is rendered **only** when this callback is supplied. A
   * control that cannot retry is worse than no control at all: it invites the
   * one action a reader has, does nothing, and leaves them unsure whether the
   * click registered. A caller with no retry path — a failure that a second
   * attempt cannot change — simply omits it, and the state stays purely
   * informational.
   *
   * This component raises the callback and nothing more. It never re-issues a
   * query, never fetches, never touches a data provider and never disables or
   * rate-limits itself after a click: deciding whether a retry is in flight,
   * whether to back off and what to render next belongs to the host layer that
   * owns the query (AAP 0.4.2).
   */
  onRetry?: (() => void) | undefined;

  /**
   * The retry control's label. Defaults to a generic one-word action.
   *
   * It is the control's accessible name as well as its visible text, so a blank
   * value falls back to the default rather than producing a button that
   * assistive technology announces as nothing at all.
   *
   * Ignored when `onRetry` is omitted, because no control is rendered then.
   */
  retryLabel?: string | undefined;

  /**
   * A decorative glyph above the copy.
   *
   * It is rendered inside a wrapper this component marks `aria-hidden="true"`,
   * so it is never part of the accessible name — the copy and the alert role
   * carry the whole meaning, and the glyph reinforces it (AAP 0.6.4: colour and
   * iconography are never the sole indicator of a state).
   *
   * Pass the glyph already carrying the global `dg-icon` class —
   * `icon={<SomeGlyph className="dg-icon" />}` — so it takes its square and its
   * `currentColor` from `../styles/base.css` and scales with the type role
   * around it; the box tints it with `--dg-danger`. Never pass an icon
   * library's numeric size or colour prop: those are hardcoded values, which
   * AAP 0.6.4 forbids. This module imports no icon library at all.
   *
   * Omitted, absent or blank, no wrapper is rendered and the column starts at
   * the title.
   */
  icon?: ReactNode | undefined;

  /**
   * Extra classes composed after `dg-error-state`, for the layout the
   * surrounding node owns — the column span of a section, an alignment a
   * specific container needs.
   *
   * It is composition, never an escape hatch for visual values: any class named
   * here is defined in `../styles/components.css` against `--dg-*` tokens like
   * every other class in this package.
   */
  className?: string | undefined;
}

/**
 * Renders the error state of a node: an optional glyph, the title, the required
 * message, an optional failure code, the optional failing query and an optional
 * retry control, in that order.
 *
 * Presentational and pure — no state, no effects, no hooks, no timers, nothing
 * read from the document while rendering, and no memoization. It re-renders
 * with its parent deliberately: this package's own render behaviour is
 * something the product measures and reports on, so a primitive here does not
 * smooth it over. The output is a function of the props alone, plus the one
 * callback it raises.
 *
 * @param props The props documented on {@link ErrorStateProps}.
 * @returns The alert container with the parts the caller supplied — no wrapper
 *   for an omitted part, no inline style, no geometry.
 *
 * @example
 * // The complete form, as the host layer renders it: the failure as observed,
 * // a code to search for, the serialised query, and one retry.
 * <ErrorState
 *   icon={<SomeGlyph className="dg-icon" />}
 *   message={failure.message}
 *   code={failure.code}
 *   query={serialisedQuery}
 *   onRetry={retryQuery}
 * />
 *
 * @example
 * // The minimal form: a failure a second attempt cannot change.
 * <ErrorState message={failure.message} />
 */
export function ErrorState(props: ErrorStateProps): ReactElement {
  const {
    message,
    title = DEFAULT_TITLE,
    code,
    query,
    onRetry,
    retryLabel,
    icon,
    className,
    ...rest
  } = props;

  // A control that announces nothing is not shippable, so a blank label falls
  // back to the default rather than reaching `Button` as empty children.
  const retryText = hasText(retryLabel) ? retryLabel : DEFAULT_RETRY_LABEL;

  // `className` is merged deliberately and the alert role is set before the
  // caller's attributes are spread, which leaves the role overridable (see the
  // file note on live regions) while keeping the composed class name beyond
  // reach of a stray passthrough. The order below is the contract: glyph,
  // title, message, code, query, action.
  return (
    <div className={clsx('dg-error-state', className)} role="alert" {...rest}>
      {isRenderable(icon) ? (
        <span className="dg-error-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {hasText(title) ? (
        <Text as="p" size="md" weight="medium" tone="danger" className="dg-error-state__title">
          {title}
        </Text>
      ) : null}
      <Text as="p" size="sm" tone="secondary" className="dg-error-state__message">
        {message}
      </Text>
      {hasText(code) ? <Badge tone="danger">{code}</Badge> : null}
      {hasText(query) ? (
        <Code
          block
          wrap
          size="sm"
          className="dg-error-state__query"
          role={QUERY_ROLE}
          aria-label={QUERY_ACCESSIBLE_NAME}
        >
          {query}
        </Code>
      ) : null}
      {onRetry === undefined ? null : (
        <div className="dg-error-state__action">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {retryText}
          </Button>
        </div>
      )}
    </div>
  );
}
