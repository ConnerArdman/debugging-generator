/**
 * `Header` — the header row of the "Debug Generator" DevTools panel (AAP 0.7.3): the wordmark,
 * the bound session's title and status badge, and the three control slots the composition root
 * fills — the `ConnectionStatus` pill, the `TargetPicker` and the `CaptureControls`.
 *
 * ## Ownership
 *
 * This component owns the panel document's single `<header>` element, and therefore its only
 * banner landmark: a top-level `<header>` already carries the `banner` role, so no `role` is
 * written, and nothing inside it is a landmark of its own. `App.tsx` renders this component in
 * place of a header and never wraps it in a second one.
 *
 * The three controls arrive as `ReactNode` slots rather than being imported here. That is what
 * keeps this file composition-only: the composition root keeps every piece of wiring — the store
 * reads, the memoized actions, the port-backed callbacks and the dialog visibility — and this
 * file never learns that a port, a store or a service exists.
 *
 * ## Layout (AAP 0.6.4)
 *
 * One horizontal, wrapping `Stack` with two groups, spread to the two ends of the row:
 *
 *   identity  the wordmark, then the session title and its status badge;
 *   controls  the connection pill, the target picker and the capture controls.
 *
 * Document order is reading and keyboard order — identity first, controls after — whatever the
 * row looks like, so a wrapped row never reorders focus.
 *
 * A docked DevTools drawer is narrow, so the row degrades by wrapping and never by clipping the
 * controls off-screen, in three steps:
 *
 * 1. The controls group falls onto its own line once the identity group and it no longer fit
 *    side by side.
 * 2. The session title and its badge form one unit inside the identity group, and that unit
 *    falls beneath the wordmark once they no longer fit on one line. The wordmark is therefore
 *    never a flex sibling of a shrinking title, so the product name is never squeezed onto two
 *    lines or cut short.
 * 3. On its own line the title shrinks and truncates with an ellipsis (`Text`'s `truncate`), so a
 *    long question can never push anything else out of the row. The clip is visual only: the full
 *    question stays in the accessibility tree, and it is also offered as the element's `title`.
 *
 * Every gap is a `SpaceStep` of the renderer's spacing scale, and every type role and colour comes
 * from a primitive's props, so this file writes no inline style, no length, no colour and no class
 * of its own. The one class name it uses is the renderer's global `dg-visually-hidden` utility
 * (see below), reused exactly as `TargetPicker` reuses it and never redefined.
 *
 * ## Headings
 *
 * The wordmark is the document's level-1 heading. `PanelHost` renders the generated panel's own
 * title at level 2 through `SummaryHeader`, and a generated layout nests its section titles below
 * that, so a level-1 wordmark keeps the outline unbroken for every layout a panel specification
 * can describe. The session title is deliberately *not* a heading: the question is context for
 * the view, while the panel title is the view's heading.
 *
 * ## Status (AAP 0.6.4: never colour alone)
 *
 * The status badge always shows the status as a word; its tone is additional signal only. Both
 * the tone table and the word switch are exhaustive over the eleven `SessionStatus` values, so a
 * status added to the protocol is a compile error here rather than an unexplained badge. Tones
 * and words match `SessionSummary`'s status presentation, so the header and the summary never
 * disagree about the same session. A visually hidden "Session status:" lead-in gives the word its
 * context for assistive technology without adding text to a dense row.
 *
 * ## No-session state
 *
 * Without a session the header renders the wordmark and whichever slots were supplied, and
 * nothing that reads as missing data: no empty title, no blank badge and no placeholder box. The
 * "no session yet" wording belongs to `EmptyPanel`, not to this component.
 *
 * ## Boundaries
 *
 * Presentation only: no state, no effect, no timer, no store write, no port, socket or request,
 * and no `chrome.*` access, so it renders unchanged when the panel page is opened directly as an
 * extension page with `chrome.devtools` undefined. The copy is generic product vocabulary and
 * names nothing from any inspected application (AAP 0.5.4).
 *
 * @example Wiring from the composition root:
 * ```tsx
 * const snapshot = usePanelSnapshot();
 * <Header
 *   connectionStatus={<ConnectionStatus {...connectionProps} />}
 *   targetPicker={<TargetPicker {...pickerProps} />}
 *   captureControls={<CaptureControls {...captureProps} />}
 *   sessionTitle={snapshot.session?.question}
 *   sessionStatus={snapshot.session?.status}
 * />
 * ```
 *
 * @module apps/chrome-extension/src/panel/components/Header
 */

import { Badge, Heading, Stack, Text } from '@debuggen/panel-renderer';
import type { BadgeTone } from '@debuggen/panel-renderer';
import type { SessionStatus } from '@debuggen/protocol';
import { assertNever } from '@debuggen/shared';
import type { ReactElement, ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Props of {@link Header}. */
export interface HeaderProps {
  /**
   * The connection cluster — in the panel, a `ConnectionStatus`. Always supplied by the
   * composition root, because the connection pill is shown in every state, including before a
   * session exists. A slot that renders nothing (`null`, `undefined`, a boolean or an empty
   * string) is omitted rather than given an empty box.
   */
  connectionStatus: ReactNode;

  /**
   * The capture controls — in the panel, a `CaptureControls`. Omitted, nothing is rendered in
   * its place.
   */
  captureControls?: ReactNode | undefined;

  /**
   * The element picker — in the panel, a `TargetPicker`. Omitted, nothing is rendered in its
   * place.
   */
  targetPicker?: ReactNode | undefined;

  /**
   * The bound session's title — the developer's question (`SessionRecord.question`). Rendered as
   * plain text on one line and truncated visually when the row is too narrow. Omitted or blank,
   * no title is rendered.
   */
  sessionTitle?: string | undefined;

  /**
   * The bound session's status (`SessionRecord.status`), shown as a word on a toned badge.
   * Omitted, no badge is rendered.
   */
  sessionStatus?: SessionStatus | undefined;

  /** An extra class name for the `<header>` element, appended by the composition root. */
  className?: string | undefined;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The product name, exactly as the DevTools tab and the extension manifest spell it. Never
 * abbreviated and never followed by a tagline.
 */
const WORDMARK = 'Debug Generator';

/** The visually hidden lead-in that gives the status word its context for assistive technology. */
const STATUS_LEAD_IN = 'Session status:';

/**
 * The renderer's global utility in `base.css` that keeps text in the accessibility tree while
 * painting nothing. Out of flow, so the lead-in takes no gap in the row.
 */
const VISUALLY_HIDDEN_CLASS = 'dg-visually-hidden';

/**
 * The badge tone per session status, exhaustive over the eleven `SESSION_STATUSES`: a missing or
 * misspelled key is a compile error. The in-progress pipeline stages and the capture window take
 * `accent`, the two waiting states (`created`, `ready`) `info`, a generated result `success`, an
 * ended session `neutral` and a failure `danger` — the same tones `SessionSummary` gives them.
 * The tone is never the only signal: the badge always carries {@link sessionStatusLabel}'s word.
 */
const SESSION_STATUS_TONE: Readonly<Record<SessionStatus, BadgeTone>> = Object.freeze({
  created: 'info',
  understanding: 'accent',
  investigating: 'accent',
  planning: 'accent',
  instrumenting: 'accent',
  ready: 'info',
  capturing: 'accent',
  analyzing: 'accent',
  generated: 'success',
  ended: 'neutral',
  failed: 'danger',
} satisfies Record<SessionStatus, BadgeTone>);

/** The failure message of the exhaustiveness guard in {@link sessionStatusLabel}. */
const UNHANDLED_STATUS_MESSAGE = 'Unhandled session status in the panel header';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The word shown on the status badge, matching `SessionSummary`'s status words.
 *
 * @param status A session status.
 * @returns The status as a capitalised word.
 */
function sessionStatusLabel(status: SessionStatus): string {
  switch (status) {
    case 'created':
      return 'Created';
    case 'understanding':
      return 'Understanding';
    case 'investigating':
      return 'Investigating';
    case 'planning':
      return 'Planning';
    case 'instrumenting':
      return 'Instrumenting';
    case 'ready':
      return 'Ready';
    case 'capturing':
      return 'Capturing';
    case 'analyzing':
      return 'Analyzing';
    case 'generated':
      return 'Generated';
    case 'ended':
      return 'Ended';
    case 'failed':
      return 'Failed';
    default:
      return assertNever(status, UNHANDLED_STATUS_MESSAGE);
  }
}

/**
 * Whether a value the type system calls a `SessionStatus` really is one at runtime.
 *
 * The record reaches the panel over the wire, so a service newer than this extension could relay
 * a status this build has no word for. Such a value is left out of the header rather than
 * rendered as an unexplained badge — or allowed to reach the exhaustiveness guard, which would
 * throw during render.
 *
 * @param status The status as received.
 * @returns `true` when the status is one of the eleven this build presents.
 */
function isPresentableStatus(status: SessionStatus): boolean {
  return Object.hasOwn(SESSION_STATUS_TONE, status);
}

/**
 * Whether a slot renders anything: `null`, `undefined`, booleans and the empty string render
 * nothing in React, so a slot holding one of them gets no position in the row.
 *
 * @param node A slot's content.
 * @returns `true` when the slot has something to render.
 */
function isRenderableSlot(node: ReactNode): boolean {
  return node !== null && node !== undefined && typeof node !== 'boolean' && node !== '';
}

/**
 * A title with visible characters, or `undefined` for an absent or blank one, so a whitespace-only
 * value never renders as an empty line.
 *
 * @param title The title as supplied.
 * @returns The title unchanged, or `undefined`.
 */
function visibleTitle(title: string | undefined): string | undefined {
  return title === undefined || title.trim() === '' ? undefined : title;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The panel's header row: wordmark, session title and status badge, and the control slots.
 *
 * @param props See {@link HeaderProps}.
 * @returns The panel document's single `<header>` element.
 */
export function Header(props: HeaderProps): ReactElement {
  const {
    connectionStatus,
    captureControls,
    targetPicker,
    sessionTitle,
    sessionStatus,
    className,
  } = props;

  const title = visibleTitle(sessionTitle);
  const status =
    sessionStatus !== undefined && isPresentableStatus(sessionStatus) ? sessionStatus : undefined;

  const showConnection = isRenderableSlot(connectionStatus);
  const showTargetPicker = isRenderableSlot(targetPicker);
  const showCaptureControls = isRenderableSlot(captureControls);
  const showControls = showConnection || showTargetPicker || showCaptureControls;

  return (
    <header className={className}>
      <Stack direction="horizontal" gap={4} align="center" justify="between" wrap>
        <Stack direction="horizontal" gap={3} align="center" wrap>
          <Heading level={1} size="lg">
            {WORDMARK}
          </Heading>
          {title !== undefined || status !== undefined ? (
            <Stack direction="horizontal" gap={2} align="center">
              {title === undefined ? null : (
                <Text size="md" tone="secondary" truncate title={title}>
                  {title}
                </Text>
              )}
              {status === undefined ? null : (
                <>
                  <Text className={VISUALLY_HIDDEN_CLASS}>{STATUS_LEAD_IN}</Text>
                  <Badge tone={SESSION_STATUS_TONE[status]} variant="soft">
                    {sessionStatusLabel(status)}
                  </Badge>
                </>
              )}
            </Stack>
          ) : null}
        </Stack>
        {showControls ? (
          // Reading and keyboard order: the connection pill first — it frames every other
          // control — then the picker that chooses what to ask about, then the capture that
          // answers it. Each position stays fixed whether or not its neighbours are present, so a
          // slot appearing never remounts the others.
          <Stack direction="horizontal" gap={3} align="center" wrap>
            {showConnection ? connectionStatus : null}
            {showTargetPicker ? targetPicker : null}
            {showCaptureControls ? captureControls : null}
          </Stack>
        ) : null}
      </Stack>
    </header>
  );
}
