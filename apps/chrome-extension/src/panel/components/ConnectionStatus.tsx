/**
 * `ConnectionStatus` — the connection pill in the header of the "Debug Generator" DevTools panel
 * (AAP 0.7.3), and the binding notice beside it (AAP 0.2.3).
 *
 * ## What it renders
 *
 * One of the four states of `PANEL_CONNECTION_STATUSES`, always as its text label from
 * `PANEL_CONNECTION_LABELS`, plus whatever that state needs next to it:
 *
 *   connected            the pill only;
 *   reconnecting         the pill only — the worker is already retrying (AAP 0.5.5), so there is
 *                        nothing for the developer to do;
 *   not-paired           the pill and a "Pair…" control that asks the composition root to open
 *                        `PairDialog` (AAP 0.5.6);
 *   service-not-running  the pill and a visible recovery line (AAP 0.7.3, "Service not running
 *                        with the start command"): always the VS Code action, named by its
 *                        command-palette title "Debug Generator: Start Local Service", and, when
 *                        the composition root supplies one, the shell command that starts the
 *                        local service, rendered verbatim through `Code` so it can be copied.
 *
 * When the inspected tab navigated away from the session's origin (a `tab-left` binding), the
 * notice built by `formatTabLeftMessage(origin)` is rendered beside the pill. Every state also
 * carries a one-sentence explanation and recovery hint in a `Tooltip`; the hint restates the
 * recovery line rather than replacing it, because a tooltip is reachable only on demand and a
 * developer whose service is down must see the remedy without hovering.
 *
 * ## Wording
 *
 * The status labels and the "Tab left ‹origin›" sentence are imported from
 * `../../shared/messages` and never re-authored here: the service worker's connection pushes and
 * `panelConnectionStatus()` speak the same vocabulary, and a second copy would drift from it. The
 * only copy in this file is generic product vocabulary — the pairing control's label, the
 * service-down recovery sentence and the tooltip hints — naming VS Code commands by their
 * contributed titles and nothing from any inspected application (AAP 0.5.4). The start-service
 * action is named by its full command-palette title, category plus title as
 * `apps/vscode-extension/package.json` contributes them, which is the string a developer types
 * into the palette. `../../shared/messages` exports no start-command constant, so the shell
 * command arrives as the optional `serviceStartCommand` prop; when it is absent or blank the
 * recovery line still names the VS Code action and simply ends there, so the service-down state
 * is never left without a visible remedy. The command is displayed as given: nothing here
 * parses, composes or extends a command or a URL.
 *
 * ## Accessibility (AAP 0.6.4)
 *
 * - **Never colour alone.** The badge tone is decoration on top of the label text, which is
 *   rendered in every state; the tab-left notice is words, not a tint.
 * - **Announced, not focus-stealing.** The pill and the notice sit inside one `role="status"`,
 *   `aria-live="polite"`, `aria-atomic="true"` region that stays mounted across every state, so a
 *   change such as "Connected" → "Reconnecting…" is announced as a whole without moving focus. The
 *   status changes only on connection events — never many times per second — so the region cannot
 *   flood a screen reader.
 * - **The hint is reachable by keyboard.** The region is a single Tab stop (`tabIndex={0}`) so the
 *   tooltip opens on focus as well as on hover; the `Tooltip` sets no focus of its own and
 *   `Escape` dismisses it, so it is never a trap. The region is named by its own visible text
 *   through `aria-labelledby` (a `status` role takes no name from its content), and the hint
 *   reaches assistive technology through the `aria-describedby` the `Tooltip` merges onto it. The
 *   tooltip bubble renders outside the live region, so opening it is not announced as a change.
 * - **The recovery line is read, not re-announced.** The service-down sentence sits beside the
 *   live region, outside it, as plain text in document order: the region announces the change to
 *   "Service not running", and the remedy is there to be read without being spoken again on
 *   every status push.
 * - **The pairing control is a real button.** A renderer `Button` (`type="button"`) with
 *   `aria-haspopup="dialog"` and, when the owner reports it, `aria-expanded` for the dialog's
 *   visibility. Every focus shows the renderer's token ring from its global `:focus-visible` rule.
 *
 * ## Design-system compliance (AAP 0.6.2, 0.6.4)
 *
 * Every visual value resolves through a renderer component — `Stack`, `Tooltip`, `Badge`,
 * `Button`, `Text` and `Code` — and therefore through the `--dg-*` tokens behind them. This file
 * writes no inline style, no length, no colour and no class name. The one raw element is the
 * live-region `<div>`: it exists for its ARIA role, which no layout primitive accepts, and carries
 * no visual value. Badge's `color` prop is never used — tone alone selects the palette.
 *
 * ## Boundaries
 *
 * Presentation only. The status is produced by `../state/connection.ts` from the worker's pushes
 * and reaches this component as a prop; nothing here polls, schedules a timer, writes the store,
 * opens a port or socket, performs a request or touches a `chrome.*` API, so it renders unchanged
 * when the panel page is opened directly with `chrome.devtools` undefined. Pairing is only an
 * intent callback: the one-time code is typed into `PairDialog`, the credential is kept by the
 * service worker in `chrome.storage.local`, and neither ever passes through this file.
 *
 * @example Wiring from the composition root, with the shell command the developer can run
 * instead of the VS Code action (omit `serviceStartCommand` and the line names the VS Code
 * action alone):
 * ```tsx
 * const connection = usePanelConnection();
 * <ConnectionStatus
 *   status={connection.status}
 *   binding={connection.binding}
 *   serviceUrl={connection.serviceUrl}
 *   serviceStartCommand="node apps/local-service/dist/main.js"
 *   pairingDialogOpen={pairOpen}
 *   onRequestPairing={() => setPairOpen(true)}
 * />
 * // In the service-not-running state this renders, beside the "Service not running" pill:
 * // Start it from VS Code with Debug Generator: Start Local Service, or run
 * // `node apps/local-service/dist/main.js` from the Debug Generator repository root.
 * ```
 *
 * @module apps/chrome-extension/src/panel/components/ConnectionStatus
 */
import { Badge, Button, Code, Stack, Text, Tooltip } from '@debuggen/panel-renderer';
import type { BadgeTone } from '@debuggen/panel-renderer';
import { assertNever } from '@debuggen/shared';
import { useId } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { PANEL_CONNECTION_LABELS, formatTabLeftMessage } from '../../shared/messages';
import type { PanelBindingState, PanelConnectionStatus } from '../../shared/messages';
import type { PanelConnectionSlice } from '../state/session-store';

// ---------------------------------------------------------------------------
// Copy — generic product vocabulary only (AAP 0.5.4)
// ---------------------------------------------------------------------------

/** The label of the control that asks the composition root to open the pairing dialog. */
const PAIR_ACTION_LABEL = 'Pair…';

/**
 * The command-palette title of the VS Code command that starts the local service
 * (`debuggen.startService`): the category and title `apps/vscode-extension/package.json`
 * contributes, joined the way the palette shows them. Rendered unquoted and emphasised in the
 * visible recovery line, and quoted in the tooltip hint, where it sits inside a plain sentence.
 */
const START_SERVICE_PALETTE_TITLE = 'Debug Generator: Start Local Service';

/** The words before the palette title in the service-down recovery line. */
const START_SERVICE_LEAD = 'Start it from VS Code with';

/** The words between the palette title and the shell command, when a command is supplied. */
const START_COMMAND_LEAD = ', or run';

/** The words after the shell command, which close the recovery sentence. */
const START_COMMAND_TRAIL = 'from the Debug Generator repository root.';

/** The punctuation that closes the recovery sentence when no shell command is supplied. */
const START_SERVICE_TRAIL = '.';

/** How the hints name the service the panel talks to. */
const SERVICE_NAME = 'the local Debug Generator service';

/** The contributed title of the VS Code command that issues a one-time pairing code. */
const PAIR_COMMAND_TITLE = '“Pair Chrome DevTools Panel”';

/** The message of the render-time guard for a status outside the imported vocabulary. */
const UNHANDLED_STATUS_MESSAGE = 'Unhandled panel connection status';

/** The message of the render-time guard for a binding kind outside the imported vocabulary. */
const UNHANDLED_BINDING_MESSAGE = 'Unhandled panel binding state';

// ---------------------------------------------------------------------------
// The tone table
// ---------------------------------------------------------------------------

/**
 * The badge tone of each connection status — additional signal on top of the label, never the
 * only one.
 *
 * Keyed by `PanelConnectionStatus`, the union derived from `PANEL_CONNECTION_STATUSES`, so a status
 * added to the vocabulary without a tone here is a compile error rather than a silently neutral
 * pill; the object literal's excess-property check rejects a misspelled key the same way.
 */
const STATUS_TONE: Readonly<Record<PanelConnectionStatus, BadgeTone>> = Object.freeze({
  connected: 'success',
  reconnecting: 'warning',
  'not-paired': 'info',
  'service-not-running': 'danger',
});

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props of {@link ConnectionStatus}.
 *
 * Every optional member states `| undefined` explicitly because `exactOptionalPropertyTypes` is on
 * repository-wide, and a caller forwarding a slice field it may not have must stay legal.
 */
export interface ConnectionStatusProps {
  /** The pill's state, as `../state/connection.ts` stored it from the worker's pushes. */
  status: PanelConnectionStatus;

  /**
   * The inspected tab's binding. Only a `tab-left` binding renders anything — the
   * `formatTabLeftMessage(origin)` notice; `bound` and `unbound` add nothing to the pill.
   */
  binding?: PanelBindingState | undefined;

  /**
   * Raised by the "Pair…" control in the `not-paired` state. The composition root owns
   * `PairDialog` and opens it; this component carries no code and no credential.
   */
  onRequestPairing: () => void;

  /**
   * Whether the pairing dialog is currently open, reflected as the pairing control's
   * `aria-expanded`. Omitted, the control announces only that it opens a dialog.
   */
  pairingDialogOpen?: boolean | undefined;

  /**
   * The shell command that starts the local service, shown verbatim (surrounding whitespace
   * trimmed) through `Code` in the `service-not-running` recovery line, as the alternative to the
   * VS Code action. Never parsed, composed or extended here. The VS Code "Debug Generator: Start
   * Local Service" action renders regardless: absent or blank, the recovery line names that
   * action alone.
   */
  serviceStartCommand?: string | undefined;

  /**
   * The service base URL the worker is trying (the connection slice's `serviceUrl`), named in the
   * tooltip hint. Displayed as given; never parsed, extended or used to build a request.
   */
  serviceUrl?: PanelConnectionSlice['serviceUrl'];

  /**
   * Extra classes for the outer `Stack`. Composition only: any class named here is a renderer
   * class defined against the `--dg-*` tokens, never a vehicle for a visual value.
   */
  className?: string | undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * `value` without surrounding whitespace when it holds visible text, otherwise `undefined` — so
 * a blank string never renders an empty `Code` chip or a dangling "at" in a hint.
 */
function visibleText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The binding notice to render beside the pill, or `undefined` when the binding needs none.
 *
 * The sentence is `formatTabLeftMessage`'s, verbatim apart from trailing whitespace, which an
 * empty origin would otherwise leave behind.
 *
 * @param binding The inspected tab's binding, when the owner has one.
 * @returns The "Tab left ‹origin›" notice for a `tab-left` binding; otherwise `undefined`.
 */
function bindingNotice(binding: PanelBindingState | undefined): string | undefined {
  if (binding === undefined) {
    return undefined;
  }
  switch (binding.kind) {
    case 'unbound':
    case 'bound':
      return undefined;
    case 'tab-left':
      return formatTabLeftMessage(binding.origin).trimEnd();
    default:
      return assertNever(binding, UNHANDLED_BINDING_MESSAGE);
  }
}

/**
 * The tooltip hint for a status: what the state means and how to recover from it.
 *
 * For `service-not-running` the hint restates the visible recovery line — the same palette
 * title, and the shell command only when that line shows one — so the two never disagree; the
 * line, not the hint, is what carries the remedy (see {@link renderRecoveryAction}).
 *
 * @param status The pill's state.
 * @param serviceUrl The service base URL the worker is trying, when known and non-blank.
 * @param hasStartCommand Whether the recovery line beside the pill shows a shell command.
 * @returns One or two plain sentences; never interactive content.
 */
function describeStatus(
  status: PanelConnectionStatus,
  serviceUrl: string | undefined,
  hasStartCommand: boolean,
): string {
  const service = serviceUrl === undefined ? SERVICE_NAME : `${SERVICE_NAME} at ${serviceUrl}`;
  switch (status) {
    case 'connected':
      return `This panel is connected to ${service}.`;
    case 'reconnecting':
      return `The connection to ${service} dropped. The extension is retrying automatically; no action is needed unless this persists.`;
    case 'not-paired':
      return `This panel is not paired with the local service yet. Run ${PAIR_COMMAND_TITLE} in VS Code, then choose ${PAIR_ACTION_LABEL} and enter the one-time code it shows.`;
    case 'service-not-running': {
      const action = `Run “${START_SERVICE_PALETTE_TITLE}” in VS Code`;
      const remedy = hasStartCommand
        ? `${action}, or run the command shown beside this status from the Debug Generator repository root`
        : action;
      return `${capitalize(service)} is not answering. ${remedy}; this panel reconnects automatically once it is up.`;
    }
    default:
      return assertNever(status, UNHANDLED_STATUS_MESSAGE);
  }
}

/** `text` with its first character upper-cased, for a phrase that opens a sentence. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The control or detail a status renders beside the pill, if any.
 *
 * `service-not-running` always renders its recovery line, so the remedy is visible rather than
 * tooltip-only (AAP 0.7.3). It is one inline `Text` run, so the sentence wraps as prose inside
 * the header's wrapping `Stack` and its punctuation stays attached to the words it follows:
 *
 *   without a command  Start it from VS Code with **Debug Generator: Start Local Service**.
 *   with a command     Start it from VS Code with **Debug Generator: Start Local Service**, or
 *                      run `‹command›` from the Debug Generator repository root.
 *
 * The palette title is a nested `Text` at the medium weight and primary tone, so it stands out
 * from the secondary-tone sentence through tokens alone; the command is a `Code` fragment so it
 * reads, and copies, as the literal it is.
 *
 * @param status The pill's state.
 * @param onRequestPairing The pairing intent callback.
 * @param pairingDialogOpen The dialog's visibility, when the owner reports it.
 * @param startCommand The non-blank shell command that starts the service, when supplied.
 * @returns The recovery affordance, or `null` when the state needs none.
 */
function renderRecoveryAction(
  status: PanelConnectionStatus,
  onRequestPairing: () => void,
  pairingDialogOpen: boolean | undefined,
  startCommand: string | undefined,
): ReactNode {
  switch (status) {
    case 'connected':
    case 'reconnecting':
      return null;
    case 'not-paired':
      return (
        <Button
          variant="secondary"
          size="sm"
          aria-haspopup="dialog"
          aria-expanded={pairingDialogOpen}
          onClick={() => {
            onRequestPairing();
          }}
        >
          {PAIR_ACTION_LABEL}
        </Button>
      );
    case 'service-not-running':
      return (
        <Text size="sm" tone="secondary">
          {START_SERVICE_LEAD}{' '}
          <Text size="sm" tone="primary" weight="medium">
            {START_SERVICE_PALETTE_TITLE}
          </Text>
          {startCommand === undefined ? (
            START_SERVICE_TRAIL
          ) : (
            <>
              {START_COMMAND_LEAD} <Code size="sm">{startCommand}</Code> {START_COMMAND_TRAIL}
            </>
          )}
        </Text>
      );
    default:
      return assertNever(status, UNHANDLED_STATUS_MESSAGE);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The panel's connection pill, the binding notice beside it, and the state's recovery affordance.
 *
 * @param props See {@link ConnectionStatusProps}.
 * @returns The header's connection cluster.
 */
export function ConnectionStatus(props: ConnectionStatusProps): ReactElement {
  const {
    status,
    binding,
    onRequestPairing,
    pairingDialogOpen,
    serviceStartCommand,
    serviceUrl,
    className,
  } = props;

  const baseId = useId();
  const pillLabelId = `${baseId}-label`;
  const noticeId = `${baseId}-notice`;

  const notice = bindingNotice(binding);
  const startCommand = visibleText(serviceStartCommand);
  const hint = describeStatus(status, visibleText(serviceUrl), startCommand !== undefined);

  return (
    <Stack direction="horizontal" gap={2} align="center" wrap className={className}>
      <Tooltip content={hint} placement="bottom">
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-labelledby={notice === undefined ? pillLabelId : `${pillLabelId} ${noticeId}`}
          tabIndex={0}
        >
          <Stack direction="horizontal" gap={2} align="center" wrap>
            <Badge id={pillLabelId} tone={STATUS_TONE[status]} variant="soft">
              {PANEL_CONNECTION_LABELS[status]}
            </Badge>
            {notice === undefined ? null : (
              <Text id={noticeId} size="sm" tone="warning">
                {notice}
              </Text>
            )}
          </Stack>
        </div>
      </Tooltip>
      {renderRecoveryAction(status, onRequestPairing, pairingDialogOpen, startCommand)}
    </Stack>
  );
}
