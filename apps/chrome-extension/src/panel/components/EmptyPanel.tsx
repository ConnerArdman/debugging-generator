/**
 * `EmptyPanel` — the "Debug Generator" DevTools panel's no-session state.
 *
 * AAP 0.7.3 lists this state among the panel's states: when the inspected tab
 * is not bound to a debugging session there is nothing to render, and the
 * panel says so with the headline "No session yet — start one from the Debug
 * Generator view in VS Code" followed by the three steps that lead from a
 * question to a generated panel. This module is the single owner of that copy:
 * the composition root renders `<EmptyPanel />` and never repeats the wording,
 * and the connection, pairing and service-status wording belongs to the
 * connection pill, not here.
 *
 * ## Composition
 *
 *   Section (card)        the framed region the state occupies
 *   ├── EmptyState        the headline, as the renderer's empty-state
 *   │                     primitive with its polite `role="status"` (AAP 0.6.2)
 *   └── Stack (centred)   holds the step list under the headline
 *       └── Text (div)    the list's type role, which its numerals inherit
 *           └── <ol>      three <li>, each step's sentence through `Text`
 *
 * `EmptyState` is the structural host of the state. Its `message` is typed
 * `string` and it accepts no children, so the ordered list cannot live inside
 * it; it sits beside it in the vertical flow of the `Section` body instead,
 * which is the only form the primitive's real signature allows. No `action` is
 * passed: this surface cannot start a session — that control is the VS Code
 * view's (AAP 0.7.3) — and a button that could only point elsewhere would be a
 * dead control. No `title` is passed either, so the headline is the state's
 * one line of copy and nothing is split across two props.
 *
 * ## Semantics and accessibility
 *
 * - The headline is announced through `EmptyState`'s `role="status"`, which is
 *   the settled answer "there is nothing here yet" rather than an alert.
 * - The steps are a real `<ol>`/`<li>` list, so assistive technology reads them
 *   as a numbered list of three and the numbers come from the list semantics,
 *   never from typed-in digits.
 * - No heading element is emitted. The generated panel that later replaces
 *   this state brings its own outline, and an empty state cannot know the
 *   depth it is rendered at (the same reasoning the renderer's empty-state
 *   primitive records).
 * - Nothing here is focusable and nothing is interactive, so there is no focus
 *   order to manage and no keyboard trap is possible.
 *
 * ## Why a card, and why the list sits in a `Text` block
 *
 * The composition root lays this state out in a bare `Stack` with no inset of
 * its own, so the card is what gives the state a surface and holds its copy
 * off the panel edge, in the same framed form the panel's other grouped
 * regions take. The renderer's base layer draws ordered-list numerals inside
 * the list's own box, so they stay visible at every panel width; centring the
 * list under the centred headline keeps the two reading as one block whenever
 * the steps fit on one line each.
 *
 * The numerals take their font and colour from the list element, not from the
 * text inside each item. Wrapping the list in a block-level `Text` gives the
 * `<ol>` the same type role and tone as every step, so the numerals match the
 * sentences they number instead of falling back to the document's body role.
 *
 * ## Design-system compliance (AAP 0.6.4)
 *
 * Every visual value resolves through a renderer component — `Section`,
 * `EmptyState`, `Stack` and `Text` — and therefore through the `--dg-*` tokens
 * behind them. This file writes no inline style, no length, no colour and no
 * class name of its own; all spacing is a `Stack`/`Section` space step. The
 * `<ol>`/`<li>` pair is the one set of raw elements used, because no primitive
 * renders an ordered list and the list semantics are required.
 *
 * ## Boundaries
 *
 * Presentational and pure: no state, no effects, no store access, no transport
 * of any kind and no `chrome.*` API. It therefore renders unchanged when the
 * panel document is opened directly as an extension page with
 * `chrome.devtools` undefined. The copy is generic product vocabulary and names
 * nothing from any inspected application (AAP 0.5.4).
 *
 * @module apps/chrome-extension/src/panel/components/EmptyPanel
 */
import { EmptyState, Section, Stack, Text } from '@debuggen/panel-renderer';
import type { ReactElement } from 'react';

/**
 * The no-session headline, verbatim from AAP 0.7.3 (including the em dash).
 * Rendered as the `EmptyState` message and nowhere else in the panel.
 */
const EMPTY_PANEL_HEADLINE = 'No session yet — start one from the Debug Generator view in VS Code';

/**
 * The three steps from a question to a generated panel, in workflow order
 * (AAP 0.7.3). One short sentence each, in generic product vocabulary; the
 * order of this tuple is the order the list numbers them in.
 */
const EMPTY_PANEL_STEPS = [
  'Open the Debug Generator view in VS Code and ask a question about the page you are debugging.',
  'When it reports that it is ready to capture, start capture and reproduce the problem in this tab.',
  'The generated debugging panel appears here, and every runtime item links back to its source in VS Code.',
] as const;

/**
 * Props of {@link EmptyPanel}. Both are optional, so the composition root
 * renders `<EmptyPanel />` with nothing to supply.
 *
 * Every member states `| undefined` explicitly because
 * `exactOptionalPropertyTypes` is on repository-wide and a caller forwarding a
 * value it may not have must stay legal.
 */
export interface EmptyPanelProps {
  /**
   * Extra classes for the outermost element, forwarded to the card `Section`.
   * Composition only: any class named here is a renderer class defined against
   * the `--dg-*` tokens, never a vehicle for a visual value.
   */
  className?: string | undefined;

  /** The outermost element's id, forwarded to the card `Section`. */
  id?: string | undefined;
}

/**
 * Renders the no-session state: the AAP 0.7.3 headline through the renderer's
 * `EmptyState`, followed by the three workflow steps as a numbered list, in one
 * framed card.
 *
 * @param props The props documented on {@link EmptyPanelProps}.
 * @returns The card holding the headline and the three-step list.
 *
 * @example
 * // The composition root, when the store holds no session:
 * <EmptyPanel />
 */
export function EmptyPanel(props: EmptyPanelProps): ReactElement {
  const { className, id } = props;

  return (
    <Section variant="card" gap={2} className={className} id={id}>
      <EmptyState message={EMPTY_PANEL_HEADLINE} />
      <Stack align="center">
        <Text as="div" size="sm" tone="secondary">
          <ol>
            {EMPTY_PANEL_STEPS.map((step) => (
              <li key={step}>
                <Text size="sm" tone="secondary">
                  {step}
                </Text>
              </li>
            ))}
          </ol>
        </Text>
      </Stack>
    </Section>
  );
}
