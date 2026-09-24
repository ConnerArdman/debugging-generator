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
 *   service-not-running  the pill and, when the composition root supplies one, the command that
 *                        starts the local service, rendered through `Code` so it can be copied.
 *
 * When the inspected tab navigated away from the session's origin (a `tab-left` binding), the
 * notice built by `formatTabLeftMessage(origin)` is rendered beside the pill. Every state also
 * carries a one-sentence explanation and recovery hint in a `Tooltip`.
 *
 * ## Wording
 *
 * The status labels and the "Tab left ‹origin›" sentence are imported from
 * `../../shared/messages` and never re-authored here: the service worker's connection pushes and
 * `panelConnectionStatus()` speak the same vocabulary, and a second copy would drift from it. The
 * only copy in this file is generic product vocabulary — the pairing control's label, the lead-in
 * of the start command and the tooltip hints — naming VS Code commands by their contributed
 * titles and nothing from any inspected application (AAP 0.5.4). `../../shared/messages` exports
 * no start-command constant, so the command arrives as the optional `serviceStartCommand` prop and
 * nothing is rendered in its place when it is absent; no command or URL is composed here.
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
 * @example Wiring from the composition root:
 * ```tsx
 * const connection = usePanelConnection();
 * <ConnectionStatus
 *   status={connection.status}
 *   binding={connection.binding}
 *   serviceUrl={connection.serviceUrl}
 *   pairingDialogOpen={pairOpen}
 *   onRequestPairing={() => setPairOpen(true)}
 * />
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

/** The lead-in rendered before the service's start command. */
const START_COMMAND_LEAD = 'Start it with';

/** How the hints name the service the panel talks to. */
const SERVICE_NAME = 'the local Debug Generator service';

/** The contributed title of the VS Code command that issues a one-time pairing code. */
const PAIR_COMMAND_TITLE = '“Pair Chrome DevTools Panel”';

/** The contributed title of the VS Code command that starts the local service. */
const START_SERVICE_COMMAND_TITLE = '“Start Local Service”';

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
   * The command that starts the local service, shown through `Code` beside the
   * `service-not-running` pill. Nothing is rendered in its place when it is absent or blank.
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
 * @param status The pill's state.
 * @param serviceUrl The service base URL the worker is trying, when known and non-blank.
 * @param hasStartCommand Whether the start command is rendered beside the pill.
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
      const remedy = hasStartCommand
        ? `Run ${START_SERVICE_COMMAND_TITLE} in VS Code or the start command shown here`
        : `Run ${START_SERVICE_COMMAND_TITLE} in VS Code`;
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
 * @param status The pill's state.
 * @param onRequestPairing The pairing intent callback.
 * @param pairingDialogOpen The dialog's visibility, when the owner reports it.
 * @param startCommand The non-blank start command, when supplied.
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
      return startCommand === undefined ? null : (
        <Stack direction="horizontal" gap={1} align="baseline" wrap>
          <Text size="sm" tone="secondary">
            {START_COMMAND_LEAD}
          </Text>
          <Code size="sm">{startCommand}</Code>
        </Stack>
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
