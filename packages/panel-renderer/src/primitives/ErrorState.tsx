/**
 * `ErrorState` — the failure placeholder of `@debuggen/panel-renderer`.
 *
 * ## Why this primitive is structural, not decorative
 *
 * Every catalogued visualization component in this package has exactly three
 * structural states, each with one renderer: empty (`EmptyState`), loading
 * (`LoadingState`) and error — this component, showing the query that failed
 * and a retry action. It is the only error renderer: all thirteen
 * visualization components and the `host/` layer render it rather than
 * inventing a failure box of their own, so a failure looks and behaves
 * identically wherever in a generated panel it happens.
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
 * A failure is never presented as a successful analysis, and this component
 * is the visible half of that rule. Three consequences are requirements here
 * rather than preferences:
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
 * ## One contract, one wording
 *
 * Every query-backed node reaches this component through the same path, and a
 * reader comparing two failed nodes must see two instances of one design, not
 * two designs. So the parts are fixed and ordered — glyph, title, message,
 * hint, code, query, technical details, action — and the words that fill them
 * are composed once, in `host/useQuery` (`queryFailureProps`,
 * `formatDataQuery`), rather than by each component:
 *
 *   - **The message** is for the reader: a generic lead ("The data for this
 *     view could not be loaded.") followed, when a typed error states one, by
 *     its presentable cause — never a foreign exception's text.
 *   - **The hint** is what the reader can do about it, on its own line.
 *   - **The technical details** are for a developer: the error's allowlisted
 *     diagnostic context, already serialised, behind a native disclosure that
 *     starts closed. Integration instructions ("pass the sessionId …") live
 *     there and never on the hint line a panel user reads first.
 *   - **The query** is serialised by one formatter, so every node prints the
 *     same request the same way.
 *
 * ## Why `query` is a `string`
 *
 * The failing query's real type is the data-query object declared by
 * `@debuggen/panel-schema`, and a primitive in this folder must not import it:
 * the primitives layer is schema-agnostic by design, which is what keeps it
 * usable from the DevTools panel, the editor webview and a component test with
 * no panel specification anywhere in sight. The renderer depends on the
 * schema, never the reverse, and this folder does not depend on it at all:
 * this primitive imports no schema, host, layout or visualization module, so
 * every layer of the package can render it without an import cycle.
 *
 * So the caller — `host/useQuery` or `host/NodeRenderer`, which already hold
 * the typed object — serialises it exactly once, in pretty-printed JSON form
 * (`formatDataQuery` in `host/useQuery` is that one serialiser), and hands over
 * the resulting string. This is a deliberate API decision, not an oversight,
 * and it must not be "improved" into a typed prop. The same holds for
 * `details`: the diagnostic object belongs to `@debuggen/shared`, which this
 * folder does not import, so it arrives as a string too.
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
 * This component renders every string it is given verbatim and screens none
 * of them: it never re-parses, reformats, truncates, stores or logs what it is
 * handed, and there is no `console` call anywhere in this module, because a
 * diagnostic written from here would copy a message and a query into a log
 * this product's privacy model never accounted for. Whatever reaches it is
 * therefore its caller's responsibility, and whatever reaches it is shown.
 *
 * On the query path that caller is `queryFailureProps` in `host/useQuery`.
 * Its message is the scope's fixed lead followed, at most, by the message a
 * `DebuggenError` of typed provenance states — one whose whole `cause` chain
 * is typed. A rejection's own text — a plain exception, an HTTP or transport
 * error, a string, a salvaged error-shaped object, or a typed error built
 * around such a cause, whether it repeats the cause verbatim or embeds it in
 * prose of its own — is never shown: renderer-authored fixed text stands in
 * for it. Typed text and hints that carry an absolute path, a URL, a
 * credential, SQL or a quoted literal, control characters or an oversize run
 * are withheld as well. `details` keeps approved diagnostic fields only: a
 * secret-named key's value is always `[redacted]`, text survives only under
 * the closed diagnostic vocabulary and when it passes the same screen, counts
 * and flags survive under any identifier key, and anything nested is
 * `[redacted]`.
 *
 * A caller assembling these props by hand passes approved product copy only,
 * never an exception's `message`: an arbitrary rejection can carry a private
 * path, a token or a statement, and this component would put it in front of
 * whoever reads the panel.
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
 * surrounding structure.
 *
 * ## Live regions: the division of labour across the three states
 *
 * This component owns the failure announcement. By default it is
 * `role="alert"` — the assertive announcement, warranted when something
 * failed. The other two states are deliberately different and must stay that
 * way: `LoadingState` owns the busy announcement (`role="status"`,
 * `aria-live="polite"`, `aria-busy="true"`) while a query is in flight, and
 * `EmptyState` is the settled polite `role="status"` without `aria-busy`,
 * which states what the load resolved to ("nothing was captured") without
 * interrupting the reader.
 *
 * Assertive is right for one failure and wrong for twelve. When the service
 * goes away every query-backed node of a panel fails within a few
 * milliseconds, and twelve simultaneous alerts interrupt each other until the
 * reader hears none of them. So the politeness is a prop, `announce`:
 * `"assertive"` renders `role="alert"`, and `"polite"` renders
 * `role="status"`, an implicitly polite live region that is still announced
 * and still reachable, but queued behind the one alert instead of cutting it
 * off. Which failure of a burst gets to be the assertive one is not something
 * a pure component can know — it needs to see every other failure — so the
 * decision is made once, when each query settles, by `host/useQuery`, and
 * reaches this component through `queryFailureProps`.
 *
 * The role is set before the caller's attributes are spread, so it is the
 * default rather than a fixture: a caller rendering several failures inside a
 * region that already alerted can still override it outright. That is not the
 * normal case, and an unqualified error state alerts.
 *
 * ## Appearance is class names, and nothing else
 *
 * Not one colour, length, font or radius appears in this module, and there is
 * no inline `style` object, no width, no height and no minimum height: the
 * container's geometry and every visual value belong to
 * `../styles/components.css`, where each resolves to a `--dg-*` token and no
 * CSS value is hardcoded. The class contract this file DECLARES, and that
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
 *   dg-error-state__message     the required explanation and, when present, the
 *                               hint line beneath it — two paragraphs of the
 *                               same register, which `Text` already renders at
 *                               the `--dg-text-sm` role in
 *                               `--dg-text-secondary`
 *   dg-error-state__query       the query block and the technical-details
 *                               block — the same kind of content, preformatted
 *                               machine text, so the same box — which `Code`
 *                               already asks for
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
 * No class is declared for the technical-details disclosure either. It is a
 * native `<details>`/`<summary>` pair: the browser supplies the closed-by-
 * default state, the keyboard toggle, the disclosure triangle and the
 * expanded/collapsed announcement, none of which a hook-free component could
 * reproduce, and the elements take their spacing from the block's gap, their
 * summary text from the `Text` primitive inside it and their body from the
 * `dg-error-state__query` box. Raw markup is legitimate here: the rule is no
 * raw markup where a primitive exists — library primitives over raw buttons,
 * inputs, selects, tables and headings — and this package has no disclosure
 * primitive a raw `<details>` would bypass.
 *
 * The two global utilities of `../styles/base.css` are reused and never
 * redefined: `dg-icon` is the square on the glyph — the default one below and
 * any glyph a caller passes — and `dg-visually-hidden` stays available to
 * callers without being needed here — the query block is named with
 * `aria-label` rather than an id reference, because generating an id would
 * mean a hook, and this component has none.
 */

import clsx from 'clsx';
import { TriangleAlert } from 'lucide-react';
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
 * time. It names nothing from an inspected project and interpolates nothing:
 * product source carries no vocabulary of any particular application.
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
 * The label an unqualified dismiss control carries (see
 * {@link ErrorStateProps.onDismiss}): one generic word, like the retry's.
 */
const DEFAULT_DISMISS_LABEL = 'Dismiss';

/**
 * The attribute that marks a control as recognisable again after a remount.
 *
 * A retry replaces this component's subtree: the query returns to loading, the
 * node draws its `LoadingState`, and a moment later either the recovered view
 * or a fresh `ErrorState` takes its place. The button the reader pressed is
 * gone by then, and a focused element that leaves the document hands focus to
 * `<body>` — which, for a keyboard or screen-reader user, is the same as being
 * thrown back to the top of the panel.
 *
 * The cure cannot live here: this component is pure and holds no reference to
 * anything it rendered before, so it cannot know that it is the successor of a
 * control that had focus. What it can do is label the control with a stable
 * key, and that label is the whole of its side of the contract. The other side
 * belongs to the host's node frame (`host/NodeRenderer`), the one element that
 * outlives every state its node passes through: a control carrying this
 * attribute can be recognised again after a remount, so the frame can hand
 * focus back to the equivalent control — or to the node's own region when no
 * equivalent control exists any more.
 *
 * A `data-*` attribute rather than an id: ids must be unique in the document,
 * and a panel may render a dozen error states at once, each with a retry that
 * is equivalent only to its own successor.
 */
export const FOCUS_KEY_ATTRIBUTE = 'data-dg-focus-key';

/**
 * The {@link FOCUS_KEY_ATTRIBUTE} value of the retry control.
 *
 * One value for every error state: the frame that restores focus searches only
 * inside its own node, so the key needs to say which control of a node it is,
 * never which node.
 */
export const ERROR_STATE_RETRY_FOCUS_KEY = 'error-state-retry';

/**
 * The attributes spread onto the retry control, hoisted so the key is written
 * once and the attribute name is the exported constant rather than a second
 * copy of its spelling.
 */
const RETRY_FOCUS_ATTRIBUTES = Object.freeze({
  [FOCUS_KEY_ATTRIBUTE]: ERROR_STATE_RETRY_FOCUS_KEY,
} as const);

/**
 * The attributes a view spreads onto the ONE control that takes over from a
 * retry that succeeded: the same key as the retry itself, so the host's node
 * frame, which hands focus lost from a keyed control to the first focusable
 * element carrying the same key, moves the reader from the retry they pressed
 * onto the content that replaced the failure — instead of leaving focus parked
 * on the node's heading, or on its bare frame when the node has no heading.
 *
 * ## The successor's side of the contract
 *
 * This component cannot mark its successor: it is pure, and the successor is
 * whatever the view draws once the query settles. So the view does, under
 * three rules that keep the key meaning "where a retry's focus belongs now":
 *
 *   1. **One element, and a meaningful one.** The first control of the
 *      recovered content — the first control of a grid row, say — which is
 *      focusable in its own right (a `tabIndex={-1}` control qualifies),
 *      carries a name and draws the global `:focus-visible` ring. Never a
 *      wrapper: a frame focuses the element that carries the key.
 *   2. **Never beside a live error state.** While this component is rendered
 *      for the same node the successor carries nothing, because the frame takes
 *      the FIRST keyed element in document order: a retry that fails again must
 *      hand focus to the new Retry, not to content that precedes it.
 *   3. **Only on what the retry brought.** The successor is the first item of
 *      the result the settled request returned: the view's first row after a
 *      failed first page, the first row of the new page after a failed further
 *      page. Content that stayed on screen throughout carries nothing, so a
 *      reader who retried a page below it is not moved back up to it.
 *
 * Focus moves only when the frame itself parked it after the loss; a reader
 * who moved on while the retry was in flight is never pulled back. Between
 * retries the key moves nothing: the frame acts only on a loss, and a marked
 * control that the reader focuses and the view then replaces hands focus to
 * whichever control carries the key next, as any keyed control does.
 *
 * @example
 * // On the first control of the first row the settled page brought, and only
 * // while that page is a success:
 * <Button {...(isSuccessor ? RETRY_SUCCESSOR_FOCUS_ATTRIBUTES : NO_ATTRIBUTES)} … />
 */
export const RETRY_SUCCESSOR_FOCUS_ATTRIBUTES = RETRY_FOCUS_ATTRIBUTES;

/**
 * The accessible name of the query block when the caller names it nothing
 * else (see {@link ErrorStateProps.queryLabel}).
 *
 * The block is a focusable, scrollable region of preformatted text, so it needs
 * a name of its own: without one, a screen-reader user reaching it by keyboard
 * is given the serialised query with no indication of what the text is. It is
 * supplied as an `aria-label` rather than an `aria-labelledby` reference to a
 * visually hidden sibling, because a reference needs a generated id, a
 * generated id needs a hook, and this component has no hooks by contract.
 */
const DEFAULT_QUERY_ACCESSIBLE_NAME = 'Failing query';

/**
 * The visible summary of the technical-details disclosure, and the accessible
 * name of the block it reveals.
 *
 * Plain words for a reader who is not the developer: it says that what is
 * inside is technical, which is exactly the signal that lets everyone else
 * leave it closed.
 */
const DETAILS_LABEL = 'Technical details';

/**
 * The glyph an error state draws when its caller passes no `icon` at all.
 *
 * One glyph for every failure, so a reader scanning a panel recognises an
 * error box by its shape as well as by its words and its danger edge, whether
 * or not the rendering component passes a glyph of its own. It carries the
 * global `dg-icon` class and nothing else: its square and `currentColor` come
 * from `base.css`, the danger tint from the `dg-error-state__icon` box, and no
 * numeric size or colour prop is written, because such a prop is a hardcoded
 * visual value. Hoisted because a React element is an immutable description,
 * so one instance serves every render.
 */
const DEFAULT_ICON = <TriangleAlert className="dg-icon" />;

/** The two politenesses {@link ErrorStateProps.announce} accepts, read off the prop itself. */
type ErrorStateAnnouncement = NonNullable<ErrorStateProps['announce']>;

/**
 * The live-region role each announcement politeness renders as.
 *
 * `alert` is the implicitly assertive live region and `status` the implicitly
 * polite one; neither needs an `aria-live` restating it. A total lookup over
 * the union, so a third politeness cannot be added without choosing its role.
 */
const ANNOUNCE_ROLE: Readonly<Record<ErrorStateAnnouncement, 'alert' | 'status'>> = {
  assertive: 'alert',
  polite: 'status',
};

/** The politeness an unqualified error state announces itself with. */
const DEFAULT_ANNOUNCE: ErrorStateAnnouncement = 'assertive';

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
 * value is ever coerced into visible text, because "null" and "undefined"
 * must never reach the screen as words.
 *
 * It is applied to the glyph after the default has been substituted for an
 * omitted `icon`, so `undefined` reaching it means nothing at all, while an
 * explicit `null`, `false` or `''` is how a caller asks for no glyph.
 *
 * The predicate is local, exactly as it is in `EmptyState`: it is three
 * comparisons over a React type and nothing about it is design-system
 * vocabulary, so it stays private to this module rather than becoming a shared
 * utility the primitives layer would have to import from somewhere.
 *
 * @param node The glyph to draw, if any.
 * @returns `true` when the node contributes visible or announced content.
 */
function isRenderable(node: ReactNode): boolean {
  return node !== null && node !== undefined && typeof node !== 'boolean' && node !== '';
}

/**
 * Whether an optional string carries text worth rendering.
 *
 * An absent value, an empty string and a string of nothing but whitespace are
 * treated alike — all three mean "this part is not present" — so a caller
 * forwarding an optional value it may not have gets the same result as one
 * that omitted the prop, and no part of this state is ever rendered as an
 * empty box, a blank line or a control whose name is a space. The test trims;
 * the value rendered never is.
 *
 * It is a type predicate so the narrowed `string` can be handed to a primitive
 * that requires one, with no cast and no non-null assertion.
 *
 * @param value The prop as the caller passed it, if at all.
 * @returns `true` when the value holds at least one non-whitespace character.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
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
 * about how failures look.
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
   * The caller owns this wording, and it is rendered verbatim (see this
   * module's privacy note): approved product copy stating the failure as the
   * layer that observed it understands it — the connection dropped, the request
   * was refused, the capture holds no such source — and never an exception's
   * own `message`. This file supplies no default for it, because a default
   * would have to be vague enough to be useless. Write what failed, not what it
   * might mean: an inference about a cause belongs to a validated analysis,
   * never to an error box, because a failure is never presented as a
   * successful analysis. A node on the query path takes it from
   * `queryFailureProps` in `host/useQuery`, which composes the scope's fixed
   * lead and, at most, a typed error's presentable cause, so every node
   * words the same failure the same way.
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
   * records. Status colours clear the 4.5:1 text-contrast minimum on every
   * surface of every theme (`tokens.test.ts` enforces it), which is what makes
   * the danger tone legitimate on text here rather than a contrast regression.
   *
   * Passing the empty string suppresses the line entirely, for a caller that
   * has stated the failure fully in `message` and wants no second line. The
   * region still announces itself as a live region and the stylesheet still
   * marks the box, so the failure remains unmistakable.
   *
   * This repurposes the inherited HTML `title` attribute: the value is rendered
   * as the line above, and is not forwarded to the container as a tooltip. A
   * hover explanation belongs to the `Tooltip` primitive.
   */
  title?: string | undefined;

  /**
   * What the reader can do about the failure, in one sentence — "Retry to
   * request the data again." — on its own line beneath the message.
   *
   * Written for whoever is reading the panel, never for whoever integrated it:
   * an instruction about how a host or provider must be wired belongs in
   * `details`, where only the reader who opens the disclosure meets it. Like
   * `message`, it is approved copy rendered verbatim, never an exception's
   * text. Rendered through `Text` as a second paragraph of the message's
   * register, at the `--dg-text-sm` role in `--dg-text-secondary`.
   *
   * Omitted, absent or blank, no line is rendered.
   */
  hint?: string | undefined;

  /**
   * A short machine-readable code for the failure — the kind a developer can
   * search a log or an issue tracker for.
   *
   * Rendered as a `Badge` with the `danger` tone, never as a bare styled
   * element, because no raw markup stands in where a primitive exists. It is a
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
   * serialises it once — through `formatDataQuery`, the one pretty-printed JSON
   * form every node uses — and hands the result over. Nothing in this file
   * serialises, re-parses or reformats it.
   *
   * Rendered through `Code` in its block form at the `--dg-mono-sm` role, with
   * wrapping on and preserved exactly as given: every newline, every space and
   * every character of indentation survives, and the text is never shortened or
   * elided, because a query a reader cannot read in full is a query they cannot
   * check. The block is focusable, so it can be scrolled from the keyboard, and
   * it is named by `aria-label` on a `group` role that accepts that name.
   *
   * Showing it is part of the error state's contract: a failure a developer
   * can act on has to say what was asked for, not only that asking failed.
   *
   * Omitted, absent or blank, no block is rendered.
   */
  query?: string | undefined;

  /**
   * The accessible name of the query block. Defaults to `"Failing query"`.
   *
   * For a caller whose block holds something other than a data query — the
   * node definition an unrenderable node reports, say — so that a
   * screen-reader user is told what the text actually is. Blank falls back to
   * the default, because a focusable block with an empty name announces as
   * nothing. Ignored when no `query` is rendered.
   */
  queryLabel?: string | undefined;

  /**
   * Developer diagnostics for the failure, already serialised to a string by
   * the caller — the error's allowlisted details as pretty-printed JSON is the
   * expected form, which `queryFailureProps` in `host/useQuery` produces. It
   * is rendered verbatim, so a hand-assembled value must hold no unscreened
   * error text.
   *
   * Rendered, when present, as a native disclosure that starts **closed**: a
   * `<summary>` reading "Technical details", which the keyboard toggles, over
   * a `Code` block in the same box as the query, named "Technical details" on
   * a `group` role. Closed by default because its audience is the developer
   * wiring a host or reporting a fault, not the reader of the panel: the
   * message and the hint are what that reader needs, and a block of
   * diagnostics in front of them is noise. Preserved exactly as given, like
   * `query`, and never parsed, shortened or reformatted here.
   *
   * Omitted, absent or blank, no disclosure is rendered.
   */
  details?: string | undefined;

  /**
   * How urgently the failure is announced. Defaults to `"assertive"`.
   *
   * `"assertive"` renders the container as `role="alert"`, which interrupts
   * whatever a screen reader is saying; `"polite"` renders it as
   * `role="status"`, which waits its turn. One failure warrants the first. A
   * burst of failures — every node of a panel whose service went away — warrants
   * one alert and a queue of polite statuses, and the query layer decides which
   * is which as each query settles (see this module's header). Either way the
   * region remains a live region, so no failure goes unannounced.
   *
   * An explicit `role` among the caller's own attributes still wins over both.
   */
  announce?: 'assertive' | 'polite' | undefined;

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
   * owns the query.
   *
   * The control carries {@link FOCUS_KEY_ATTRIBUTE} set to
   * {@link ERROR_STATE_RETRY_FOCUS_KEY}, so that when the retry replaces this
   * subtree the host's node frame can recognise the equivalent control in what
   * replaces it and keep keyboard focus inside the node: the new Retry of a
   * retry that failed again, or — once the query succeeds — the control the
   * view marked with {@link RETRY_SUCCESSOR_FOCUS_ATTRIBUTES}.
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
   * What to do when the reader closes a failure notice that is theirs to
   * close — a non-blocking notice raised above a view that keeps working, as
   * opposed to the failure of the view itself.
   *
   * The dismiss control is rendered **only** when this callback is supplied,
   * for the reason `onRetry` gives, and it sits in the same action row, after
   * the retry control: every control of an error state is part of the box it
   * acts on, so a reader can tell which failure a control closes. A node's
   * query failure omits it — its error state is the view, and removing it
   * would leave nothing in its place.
   *
   * Like `onRetry`, it is raised and nothing more: removing the notice, and
   * where keyboard focus goes once the control that held it is gone, belong
   * to the caller that owns the notice.
   */
  onDismiss?: (() => void) | undefined;

  /**
   * The dismiss control's label, its accessible name as well as its visible
   * text. Defaults to a generic one-word action, and a blank value falls back
   * to it. Ignored when `onDismiss` is omitted.
   */
  dismissLabel?: string | undefined;

  /**
   * A decorative glyph above the copy. Omitted (`undefined`), the default
   * warning triangle is drawn, so every error state carries the same glyph
   * unless its caller says otherwise.
   *
   * It is rendered inside a wrapper this component marks `aria-hidden="true"`,
   * so it is never part of the accessible name — the copy and the live-region
   * role carry the whole meaning, and the glyph reinforces it, because colour
   * and iconography are never the sole indicator of a state.
   *
   * Pass a replacement already carrying the global `dg-icon` class —
   * `icon={<SomeGlyph className="dg-icon" />}` — so it takes its square and its
   * `currentColor` from `../styles/base.css` and scales with the type role
   * around it; the box tints it with `--dg-danger`. Never pass an icon
   * library's numeric size or colour prop: those are hardcoded visual values,
   * and every visual value resolves to a `--dg-*` token. The default is drawn
   * the same way.
   *
   * `null`, `false` or `''` renders no glyph at all: no wrapper is rendered and
   * the column starts at the title.
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
 * Renders the error state of a node: a glyph (the default one unless the
 * caller replaces or suppresses it), the title, the required message, an
 * optional hint, an optional failure code, the optional failing query, an
 * optional closed technical-details disclosure and the optional retry and
 * dismiss controls, in that order.
 *
 * Presentational and pure — no state, no effects, no hooks, no timers, nothing
 * read from the document while rendering, and no memoization. It re-renders
 * with its parent deliberately: this package's own render behaviour is
 * something the product measures and reports on, so a primitive here does not
 * smooth it over. The output is a function of the props alone, plus the one
 * callback it raises; even the disclosure's open state is the browser's, not
 * this component's.
 *
 * @param props The props documented on {@link ErrorStateProps}.
 * @returns The live-region container with the parts the caller supplied — no
 *   wrapper for an omitted part, no inline style, no geometry.
 *
 * @example
 * // The query path, as every query-backed node renders it: one composed set of
 * // props from the query hook's result and the query that failed.
 * const result = useQuery(query);
 * if (result.status === 'error') {
 *   return <ErrorState {...queryFailureProps(result, query)} />;
 * }
 *
 * @example
 * // A hand-assembled failure with every part present, worded in product copy.
 * <ErrorState
 *   message="The connection to the local service was lost."
 *   hint="Retry to request the data again."
 *   code="TRANSPORT_DISCONNECTED"
 *   query={formattedQuery}
 *   details={formattedDetails}
 *   announce="polite"
 *   onRetry={retryQuery}
 * />
 *
 * @example
 * // The minimal form: a failure a second attempt cannot change, with no glyph,
 * // stated in fixed product copy rather than a caught error's message.
 * const UNDRAWABLE_NODE = 'This part of the panel could not be drawn.';
 * <ErrorState message={UNDRAWABLE_NODE} icon={null} />
 */
export function ErrorState(props: ErrorStateProps): ReactElement {
  const {
    message,
    title = DEFAULT_TITLE,
    hint,
    code,
    query,
    queryLabel,
    details,
    announce = DEFAULT_ANNOUNCE,
    onRetry,
    retryLabel,
    onDismiss,
    dismissLabel,
    icon,
    className,
    ...rest
  } = props;

  // A control that announces nothing is not shippable, so a blank label falls
  // back to the default rather than reaching `Button` as empty children. The
  // query block's name follows the same rule for the same reason.
  const retryText = hasText(retryLabel) ? retryLabel : DEFAULT_RETRY_LABEL;
  const dismissText = hasText(dismissLabel) ? dismissLabel : DEFAULT_DISMISS_LABEL;
  const queryName = hasText(queryLabel) ? queryLabel : DEFAULT_QUERY_ACCESSIBLE_NAME;

  // Only an omitted glyph is defaulted: an explicit `null`, `false` or `''` is a
  // caller asking for none, and `isRenderable` honours it below.
  const glyph = icon === undefined ? DEFAULT_ICON : icon;

  // `className` is merged deliberately and the live-region role is set before
  // the caller's attributes are spread, which leaves the role overridable (see
  // the file note on live regions) while keeping the composed class name beyond
  // reach of a stray passthrough. The order below is the contract: glyph,
  // title, message, hint, code, query, technical details, action.
  return (
    <div className={clsx('dg-error-state', className)} role={ANNOUNCE_ROLE[announce]} {...rest}>
      {isRenderable(glyph) ? (
        <span className="dg-error-state__icon" aria-hidden="true">
          {glyph}
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
      {hasText(hint) ? (
        <Text as="p" size="sm" tone="secondary" className="dg-error-state__message">
          {hint}
        </Text>
      ) : null}
      {hasText(code) ? <Badge tone="danger">{code}</Badge> : null}
      {hasText(query) ? (
        <Code
          block
          wrap
          size="sm"
          className="dg-error-state__query"
          role={QUERY_ROLE}
          aria-label={queryName}
        >
          {query}
        </Code>
      ) : null}
      {hasText(details) ? (
        // Native and closed by default: the browser owns the open state, the
        // keyboard toggle and its announcement, which is what keeps this
        // component free of state (see the class contract in the header).
        <details>
          <summary>
            <Text as="span" size="sm" tone="secondary">
              {DETAILS_LABEL}
            </Text>
          </summary>
          <Code
            block
            wrap
            size="sm"
            className="dg-error-state__query"
            role={QUERY_ROLE}
            aria-label={DETAILS_LABEL}
          >
            {details}
          </Code>
        </details>
      ) : null}
      {onRetry === undefined && onDismiss === undefined ? null : (
        <div className="dg-error-state__action">
          {onRetry === undefined ? null : (
            <Button variant="secondary" size="sm" onClick={onRetry} {...RETRY_FOCUS_ATTRIBUTES}>
              {retryText}
            </Button>
          )}
          {onDismiss === undefined ? null : (
            <Button variant="secondary" size="sm" onClick={onDismiss}>
              {dismissText}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
