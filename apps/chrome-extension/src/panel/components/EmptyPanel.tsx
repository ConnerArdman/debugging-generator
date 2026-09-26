/**
 * `EmptyPanel` — the DevTools panel's no-session state (AAP 0.7.3), shown while
 * the inspected tab is bound to no debugging session. It is the single owner of
 * that state's copy: the headline and the three workflow steps.
 *
 * - The headline is announced through `EmptyState`'s polite `role="status"`.
 * - `EmptyState.message` is string-only, so the steps are a real `<ol>` beside
 *   it, wrapped in a block `Text` so the list numerals share the steps' type
 *   role.
 * - No heading element: the generated panel that replaces this state brings its
 *   own outline.
 * - No action and nothing focusable: starting a session belongs to the VS Code
 *   view.
 * - Presentational only, with no `chrome.*` access, so it renders when the panel
 *   document is opened directly as an extension page.
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
