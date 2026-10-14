/**
 * `StatusBar` — the always-visible status line of the VS Code "Debug
 * Generator" view (AAP 0.7.3: "`StatusBar` (service connection, provider)").
 *
 * ## What it renders
 *
 * One compact, wrapping row in the view's header strip, in two groups:
 *
 *   - **Service** — the host's connection to the local service as a toned
 *     `Badge` (`Connected`, `Connecting…`, `Reconnecting…`, `Disconnected`), a
 *     short `Text` saying what a transitional or failed state means, the
 *     configured service URL as monospace `Code`, and — while the connection is
 *     not established and the parent supplied a retry — a small ghost `Button`
 *     that asks the host to reconnect now.
 *   - **Session and provider** — the active session's status as a second
 *     `Badge`, and the configured model provider's name as an outline `Badge`,
 *     rendered verbatim from the prop.
 *
 * Every value on screen is one of this component's props or a label describing
 * one of the closed state vocabularies below; nothing names the application
 * under investigation, a route or a question (AAP 0.5.4).
 *
 * ## Exhaustiveness is the point
 *
 * Both vocabularies are closed unions owned elsewhere — the connection state by
 * `WebviewState` in `../../webview-messages` (which takes it from the
 * protocol's `CONNECTION_STATES`) and the session status by the protocol's
 * `SESSION_STATUSES`. Each is mapped here twice over:
 *
 *   1. through a total `Record` keyed by the union, so a member without a tone
 *      and a label is a missing-property compile error; and
 *   2. through a `switch` that ends in `assertNever` from `@debuggen/shared`, so
 *      a member added upstream but not listed here stops the typecheck at this
 *      file, and a value that reaches the page at runtime without being part of
 *      the union (a snapshot from a newer host) fails loudly at the one place it
 *      arrives instead of rendering an unstyled, unlabelled pill.
 *
 * ## States (AAP 0.5.5 — the bar never disappears and never lies)
 *
 * This component is itself a status indicator, so the empty / loading / error
 * trio is mapped deliberately:
 *
 *   - **empty** — with no `provider`, no `serviceUrl` and no `sessionStatus`, the
 *     connection `Badge` still renders. No placeholder value is invented for an
 *     absent prop: an absent or blank value leaves no element behind.
 *   - **loading** — `connecting` and `reconnecting` render as a `Badge` plus a
 *     `Text`, never as a skeleton, so the line keeps its place. "Reconnecting…"
 *     is the wording AAP 0.5.5 sanctions for a dropped connection.
 *   - **error** — `closed` is the hard failure (nothing is connected and the
 *     client is not trying). With a retry it stays inline: the `Disconnected`
 *     badge, its explanation and the retry `Button`. Without one there is
 *     nothing the bar itself can offer, so an `ErrorState` is rendered beneath
 *     the row with a generic message and the start-the-service hint; that
 *     primitive owns `role="alert"`.
 *
 * ## Live region
 *
 * The row is a polite live region (`role="status"`) so a drop to
 * "Reconnecting…" is heard without interrupting. `aria-atomic="false"`
 * overrides the role's implicit atomicity, so only what changed — the new
 * connection label, the new session status — is read out rather than the whole
 * line on every update. `role="alert"` is deliberately not used for a transient
 * reconnect; the `ErrorState` rendered for a real failure is a sibling of the
 * region, never nested in it, so the failure is announced once, assertively.
 *
 * ## Privacy (AAP 0.5.2, 0.5.6)
 *
 * The provider is shown by **name** only; the bar never receives, and so never
 * renders, an API key, the service bearer token or a pairing code. The service
 * URL is displayed as scheme, host, port and path: user information, a query
 * and a fragment are dropped before rendering (see {@link displayServiceUrl}),
 * so a URL configured with embedded credentials cannot put them on screen.
 * Nothing here logs.
 *
 * ## Styling (AAP 0.6.4)
 *
 * Design-system primitives only (`Badge`, `Text`, `Code`, `Button`,
 * `ErrorState`), with every spacing decision made by `Stack`. The single raw
 * element is the live-region `<div>`, which exists because `Stack` accepts no
 * `role`; it carries layout-neutral classes of the `dgv-status-bar*` block in
 * `../styles.css`. Colour comes only from `Badge`'s and `Text`'s `tone`, which
 * resolve the text-safe `--dg-success`/`-warning`/`-danger`/`-info` tokens —
 * never the `--dg-kind-*` fill scale, a literal or an inline style.
 *
 * ## Boundaries
 *
 * Props in, one callback out. `App` owns the `WebviewState` snapshot the host
 * pushes and passes these values down; this component opens no socket, posts
 * nothing to the host, runs no timer and holds no state, so what it shows is
 * always the host's last report of the real client state. It does not summarise
 * cleanup, which `App` keeps visible separately (AAP 0.5.1).
 */

import { Badge, Button, Code, ErrorState, Stack, Text } from '@debuggen/panel-renderer';
import type { BadgeTone } from '@debuggen/panel-renderer';
import type { SessionStatus } from '@debuggen/protocol';
import { assertNever } from '@debuggen/shared';
import type { ReactElement } from 'react';

import type { WebviewState } from '../../webview-messages';

/**
 * Inputs of {@link StatusBar}.
 *
 * Every optional property admits `undefined` explicitly: the repository runs
 * with `exactOptionalPropertyTypes`, and `App` forwards values it holds as
 * possibly-undefined (the active session's status exists only once a question
 * has been asked).
 */
export interface StatusBarProps {
  /**
   * The host's connection to the local service — the reconnecting WebSocket
   * client's state, exactly as the snapshot carries it
   * (`WebviewState['connection']['status']`).
   */
  connection: WebviewState['connection']['status'];

  /**
   * The configured service base URL, shown as monospace text. Absent or blank
   * renders nothing. User information, a query and a fragment are never
   * displayed.
   */
  serviceUrl?: string | undefined;

  /**
   * The configured model provider's name (`DEBUGGEN_PROVIDER`, AAP 0.5.3),
   * rendered verbatim. Absent or blank renders nothing — no provider is ever
   * inferred or defaulted here.
   */
  provider?: string | undefined;

  /** The active session's status; absent before a session exists. */
  sessionStatus?: SessionStatus | undefined;

  /**
   * Asks the host to reconnect now. When supplied, a retry control is shown
   * while the connection is not established; when omitted, a `closed`
   * connection is reported with an `ErrorState` instead. Called with no
   * arguments.
   */
  onRetryConnection?: (() => void) | undefined;

  /** Extra classes for the root element, appended after `dgv-status-bar`. */
  className?: string | undefined;
}

/** One connection state as the bar draws it. */
interface ConnectionPresentation {
  /** The badge's semantic tone; status tones are text-safe (AAP 0.6.3). */
  readonly tone: BadgeTone;
  /** The badge's label, which carries the meaning in words. */
  readonly label: string;
  /** A short explanation shown beside the badge; absent when none is needed. */
  readonly detail?: string;
}

/** The connection vocabulary, read off the snapshot type rather than restated. */
type ConnectionStatus = StatusBarProps['connection'];

/** Root class of the component; declared in `../styles.css`. */
const ROOT_CLASS = 'dgv-status-bar';

/** The live-region wrapper around the row; declared in `../styles.css`. */
const STATUS_CLASS = 'dgv-status-bar__status';

/** The two groups of the row; declared in `../styles.css`. */
const GROUP_CLASS = 'dgv-status-bar__group';

/** A truncating text box for a long value; declared in `../styles.css`. */
const ITEM_CLASS = 'dgv-status-bar__item';

/** The accessible name of the live region. */
const STATUS_REGION_LABEL = 'Debug Generator status';

/** Visible label in front of the connection badge and the service URL. */
const SERVICE_LABEL = 'Service';

/** Visible label in front of the session status badge. */
const SESSION_LABEL = 'Session';

/** Visible label in front of the provider name. */
const PROVIDER_LABEL = 'Provider';

/** Label of the retry control shown while the connection is not established. */
const RETRY_LABEL = 'Retry connection';

/** First line of the error state rendered for a `closed` connection with no retry. */
const DISCONNECTED_ERROR_TITLE = 'Local service unavailable';

/** Message of that error state: what failed, never a guess at why. */
const DISCONNECTED_ERROR_MESSAGE =
  'This view is not connected to the local Debug Generator service, so sessions cannot start or update.';

/** Hint of that error state, naming the product's own command. */
const DISCONNECTED_ERROR_HINT =
  'Run “Debug Generator: Start Local Service” from the Command Palette, then reopen this view.';

/**
 * Every connection state's tone, label and explanation. Total over the union,
 * so a new state is a compile error here until it is given all three.
 */
const CONNECTION_PRESENTATION: Readonly<Record<ConnectionStatus, ConnectionPresentation>> = {
  connecting: {
    tone: 'info',
    label: 'Connecting…',
    detail: 'Contacting the local service.',
  },
  open: {
    tone: 'success',
    label: 'Connected',
  },
  reconnecting: {
    tone: 'warning',
    label: 'Reconnecting…',
    detail: 'Connection lost. Retrying automatically.',
  },
  closed: {
    tone: 'danger',
    label: 'Disconnected',
    detail: 'Not connected to the local service.',
  },
};

/**
 * Every session status's tone. In-flight pipeline stages read as information,
 * `ready` as the accent that invites the next action, `capturing` as a warning
 * that the app is being recorded, `generated` as success, the resting states as
 * neutral and `failed` as danger (AAP 0.5.5: a failure is shown as a failure).
 */
const SESSION_STATUS_TONE: Readonly<Record<SessionStatus, BadgeTone>> = {
  created: 'neutral',
  understanding: 'info',
  investigating: 'info',
  planning: 'info',
  instrumenting: 'info',
  ready: 'accent',
  capturing: 'warning',
  analyzing: 'info',
  generated: 'success',
  ended: 'neutral',
  failed: 'danger',
};

/** Every session status's label, total over the union for the same reason. */
const SESSION_STATUS_LABEL: Readonly<Record<SessionStatus, string>> = {
  created: 'Created',
  understanding: 'Understanding',
  investigating: 'Investigating',
  planning: 'Planning',
  instrumenting: 'Instrumenting',
  ready: 'Ready to capture',
  capturing: 'Capturing',
  analyzing: 'Analyzing',
  generated: 'Panel generated',
  ended: 'Ended',
  failed: 'Failed',
};

/** The URL schemes a service base URL is rebuilt from; anything else is scrubbed as text. */
const WEB_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * Whether a string carries something worth rendering.
 *
 * @param value A possibly-absent string.
 * @returns `true` for a string with at least one non-whitespace character.
 */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * Joins class names, dropping absent and blank entries. `clsx` is not a
 * dependency of this workspace, and two optional parts need nothing more.
 *
 * @param parts Class names in order; `undefined` entries are skipped.
 * @returns A space-separated class list.
 */
function joinClassNames(...parts: ReadonlyArray<string | undefined>): string {
  return parts.filter(hasText).join(' ');
}

/**
 * Resolves a connection state to its presentation.
 *
 * The `Record` makes the table total; the `switch` ending in `assertNever` is
 * what turns a state added to the snapshot's union into a typecheck failure at
 * this line, and a value outside the union at runtime into a loud
 * `DebuggenError` rather than a silently unstyled pill.
 *
 * @param status The host's connection state.
 * @returns Its tone, label and optional explanation.
 */
function resolveConnection(status: ConnectionStatus): ConnectionPresentation {
  switch (status) {
    case 'connecting':
    case 'open':
    case 'reconnecting':
    case 'closed':
      return CONNECTION_PRESENTATION[status];
    default:
      return assertNever(status, 'Unhandled service connection state');
  }
}

/** A session status as the bar draws it. */
interface SessionStatusPresentation {
  readonly tone: BadgeTone;
  readonly label: string;
}

/**
 * Resolves a session status to its badge, with the same double guard as
 * {@link resolveConnection}: eleven members today, and a twelfth fails the
 * typecheck here until it is given a tone and a label.
 *
 * @param status The active session's status.
 * @returns Its tone and label.
 */
function resolveSessionStatus(status: SessionStatus): SessionStatusPresentation {
  switch (status) {
    case 'created':
    case 'understanding':
    case 'investigating':
    case 'planning':
    case 'instrumenting':
    case 'ready':
    case 'capturing':
    case 'analyzing':
    case 'generated':
    case 'ended':
    case 'failed':
      return { tone: SESSION_STATUS_TONE[status], label: SESSION_STATUS_LABEL[status] };
    default:
      return assertNever(status, 'Unhandled session status');
  }
}

/**
 * Removes user information, a query and a fragment from a value that is not a
 * parseable web URL, as text: `user:secret@host:1234/path?x#y` becomes
 * `host:1234/path`.
 *
 * @param value A trimmed, non-blank string.
 * @returns The value with every credential-bearing part removed.
 */
function scrubUrlText(value: string): string {
  const withoutUserInfo = value.replace(/^([a-z][a-z\d+.-]*:\/\/)?[^\s/?#@]*@/i, '$1');
  const cut = withoutUserInfo.search(/[?#]/);
  return cut === -1 ? withoutUserInfo : withoutUserInfo.slice(0, cut);
}

/**
 * The service URL as the bar displays it: scheme, host, port and path only.
 *
 * A base URL is configuration the developer may need to read and correct, so
 * it is shown — but a URL is also where a credential can hide, in its user
 * information or its query (AAP 0.5.2 treats both as sensitive). A parseable
 * `http`, `https`, `ws` or `wss` URL is therefore rebuilt from its safe parts,
 * and anything else is scrubbed as text by {@link scrubUrlText}.
 *
 * @param value The configured service URL; non-blank.
 * @returns The value to render and to expose as the element's tooltip.
 */
function displayServiceUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return scrubUrlText(trimmed);
  }

  if (!WEB_SCHEMES.has(parsed.protocol)) {
    return scrubUrlText(trimmed);
  }

  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * Renders the service connection, the service URL, the session status and the
 * model provider as one compact live row, with a retry control or an error
 * state when the connection is down.
 *
 * @param props See {@link StatusBarProps}.
 * @returns The status bar; never empty — the connection badge always renders.
 *
 * @example
 * <StatusBar
 *   connection={state.connection.status}
 *   serviceUrl={state.connection.serviceUrl}
 *   provider={state.connection.provider}
 *   sessionStatus={state.session?.status}
 *   onRetryConnection={reconnect}
 * />
 */
export function StatusBar(props: StatusBarProps): ReactElement {
  const { connection, serviceUrl, provider, sessionStatus, onRetryConnection, className } = props;

  const presentation = resolveConnection(connection);
  const session = sessionStatus === undefined ? undefined : resolveSessionStatus(sessionStatus);
  const displayedUrl = hasText(serviceUrl) ? displayServiceUrl(serviceUrl) : undefined;
  const providerName = hasText(provider) ? provider : undefined;

  // `closed` is the hard failure. With no way to retry from here, the failure
  // is reported by the error-state primitive beneath the row, which also
  // carries the explanation — so the row does not repeat it.
  const hardFailure = connection === 'closed' && onRetryConnection === undefined;
  const detail = hardFailure ? undefined : presentation.detail;

  // Wrapped so the callback is invoked with no arguments: `Button` hands its
  // click handler a React event, which is not part of this contract.
  const retry =
    onRetryConnection !== undefined && connection !== 'open'
      ? (): void => {
          onRetryConnection();
        }
      : undefined;

  const hasContext = session !== undefined || providerName !== undefined;

  return (
    <Stack gap={2} className={joinClassNames(ROOT_CLASS, className)}>
      <div
        className={STATUS_CLASS}
        role="status"
        aria-atomic="false"
        aria-label={STATUS_REGION_LABEL}
        data-connection-status={connection}
      >
        <Stack direction="horizontal" wrap gap={2} align="center" justify="between">
          <Stack direction="horizontal" wrap gap={2} align="center" className={GROUP_CLASS}>
            <Stack direction="horizontal" gap={1} align="center">
              <Text size="xs" tone="muted">
                {SERVICE_LABEL}
              </Text>
              <Badge tone={presentation.tone}>{presentation.label}</Badge>
            </Stack>
            {detail === undefined ? null : (
              <Text size="xs" tone="secondary">
                {detail}
              </Text>
            )}
            {displayedUrl === undefined ? null : (
              <Code size="sm" className={ITEM_CLASS} title={displayedUrl}>
                {displayedUrl}
              </Code>
            )}
            {retry === undefined ? null : (
              <Button variant="ghost" size="sm" onClick={retry}>
                {RETRY_LABEL}
              </Button>
            )}
          </Stack>

          {hasContext ? (
            <Stack direction="horizontal" wrap gap={2} align="center" className={GROUP_CLASS}>
              {session === undefined ? null : (
                <Stack direction="horizontal" gap={1} align="center">
                  <Text size="xs" tone="muted">
                    {SESSION_LABEL}
                  </Text>
                  <Badge tone={session.tone} data-session-status={sessionStatus}>
                    {session.label}
                  </Badge>
                </Stack>
              )}
              {providerName === undefined ? null : (
                <Stack direction="horizontal" gap={1} align="center">
                  <Text size="xs" tone="muted">
                    {PROVIDER_LABEL}
                  </Text>
                  <Badge variant="outline" tone="neutral">
                    {providerName}
                  </Badge>
                </Stack>
              )}
            </Stack>
          ) : null}
        </Stack>
      </div>

      {hardFailure ? (
        <ErrorState
          title={DISCONNECTED_ERROR_TITLE}
          message={DISCONNECTED_ERROR_MESSAGE}
          hint={DISCONNECTED_ERROR_HINT}
        />
      ) : null}
    </Stack>
  );
}
