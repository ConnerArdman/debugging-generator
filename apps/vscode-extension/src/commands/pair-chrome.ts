/**
 * `debuggen.pairChrome` — the editor half of Chrome pairing (AAP §0.5.6, §0.7.3).
 *
 * The Chrome extension cannot read `$DEBUGGEN_HOME/auth.json`, so it earns its
 * devtools credential by pairing: this command asks the local service for a
 * one-time code (`pair.start`, `POST /pair/start`, editor credential required),
 * the `PairingCode` component of the Debug Generator view displays it, the
 * developer types it into the DevTools panel's Pair dialog, and the Chrome
 * service worker redeems it (`pair.complete`) from its own
 * `chrome-extension://` origin for a credential the service scopes to that
 * origin. The editor never redeems a code and never sees the devtools
 * credential.
 *
 * ## The code is a capability: displayed, never logged
 *
 * The service mints the code from a CSPRNG and accepts it once, for five
 * minutes, behind a rate limit of five failures then a sixty-second lockout.
 * Whoever holds it while it is live can pair a browser, so it has exactly one
 * display site — `PairingCode` in the view — and it appears nowhere else:
 *
 * - not in a log record: the only record written here is `Pairing started`
 *   with the command id;
 * - not in a VS Code notification: the Notifications centre keeps a message
 *   long after it is dismissed, which would retain a live capability past its
 *   lifetime. The notice below says where the code is and where to enter it,
 *   without it;
 * - not in an error: a failure is reported as a failure and is never
 *   presented as a code, and a code that arrives already expired is not shown.
 *
 * ## A thin command
 *
 * Exactly one HTTP operation, addressed by operation id through
 * `ServiceClient.pairStart` (no path is written here), then one store write and
 * one `pairing` frame carrying the same value:
 *
 * - `ExtensionState.setPairing` is what survives a webview reload — the view's
 *   `ready` handshake replays the stored code — and the store owns expiry: it
 *   arms one unreferenced timer for `expiresAt`, clears the code when it fires
 *   and omits an expired code from every snapshot, so this module schedules
 *   nothing. `dismissPairing` from the view clears it through the same store.
 * - `SessionViewProvider.postPairing` is what makes the code appear now, even
 *   when the view was already open.
 *
 * Nothing is generated, retried or polled here: the service owns the code,
 * the lockout and the redemption, and a successful redemption shows up as a
 * connected devtools client rather than as anything this command waits for.
 * No session or workspace guard applies — pairing is machine-scoped and must
 * work before any session exists.
 *
 * ## Failure (AAP §0.5.5)
 *
 * `pairStart` resolves every outcome to a `Result`, so a failure is a typed
 * `Err` rendered exactly once through `CommandUi.notifyFailure`, which shows
 * the error's own message and the service's hint. When the error code says the
 * service is unreachable (`TRANSPORT_DISCONNECTED`) or the editor credential
 * is missing or refused (`UNAUTHORIZED` — the service writes `auth.json` on its
 * first start), the notice offers "Start service", which runs
 * `debuggen.startService`. Codes are compared against the shared error
 * vocabulary, never against message text.
 *
 * ## Module conventions
 *
 * Extension-host code: Node and `vscode` types only, no DOM, no top-level
 * `await`, extensionless relative specifiers, and **type-only** imports from
 * `./index`, whose barrel is the one runtime edge into this module — so the
 * folder stays acyclic. Everything this command does at runtime arrives on the
 * {@link CommandContext} it is given.
 *
 * @example
 * ```ts
 * // Registered by ./index as:
 * 'debuggen.pairChrome': (...args) => pairChrome(ctx, ...args),
 * ```
 */

import { DebuggenError, isErr } from '@debuggen/shared';
import type { DebuggenErrorCode } from '@debuggen/shared';

import type { PairingState } from '../webview-messages';

import type { CommandContext, CommandId, CommandNotice, SESSION_VIEW_FOCUS_COMMAND } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** This command's id, checked against the contributed set. */
const PAIR_CHROME_COMMAND = 'debuggen.pairChrome' satisfies CommandId;

/** The command the "Start service" action runs, checked against the contributed set. */
const START_SERVICE_COMMAND = 'debuggen.startService' satisfies CommandId;

/**
 * The command that reveals the `debuggen.session` view, typed from the
 * barrel's own constant so a rename of the view id is a compile error here.
 */
const SESSION_VIEW_FOCUS: typeof SESSION_VIEW_FOCUS_COMMAND = 'debuggen.session.focus';

/** The label of the notification button that starts the local service. */
const START_SERVICE_ACTION = 'Start service';

/** What was being attempted, prefixed to every failure headline. */
const FAILURE_PREFIX = 'Could not start Chrome pairing';

/** Prefixed to the headline when the "Start service" action itself cannot run. */
const START_SERVICE_FAILURE_PREFIX = 'Could not start the local service';

/**
 * The failure codes for which starting the local service is the remedy:
 *
 * - `TRANSPORT_DISCONNECTED` — the request could not reach the service, or it
 *   did not answer in time;
 * - `UNAUTHORIZED` — the editor credential is missing or was refused; the
 *   service writes `auth.json` when it first starts.
 *
 * Every other code (a misconfigured service URL, an unusable state directory,
 * a rate limit) has its own remedy in the error's hint, and offering to start
 * the service would send the developer the wrong way.
 */
const START_SERVICE_REMEDY_CODES: ReadonlySet<DebuggenErrorCode> = new Set<DebuggenErrorCode>([
  'TRANSPORT_DISCONNECTED',
  'UNAUTHORIZED',
]);

/** Milliseconds per minute, for the lifetime stated in the notice. */
const MS_PER_MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Starts pairing the Chrome DevTools panel with the local service.
 *
 * Requests a one-time code, stores it for the view (which displays it until it
 * is redeemed, dismissed or expires), reveals the Debug Generator view and
 * tells the developer where to enter the code — without repeating the code.
 * Every expected failure is reported once through `ctx.ui` and the promise
 * resolves; it never rejects for one.
 *
 * @param ctx The resolved command context.
 * @param args Whatever the caller passed. Pairing takes no arguments — the
 *   Command Palette passes none, the view's pair control passes none — so any
 *   that arrive are ignored and never inspected.
 */
export async function pairChrome(ctx: CommandContext, ...args: readonly unknown[]): Promise<void> {
  // The registration signature forwards every argument; pairing reads none.
  void args;

  const started = await ctx.client.pairStart();
  if (isErr(started)) {
    await reportStartFailure(ctx, started.error);
    return;
  }

  // Only the two displayable fields travel on, whatever else a reply carries.
  const pairing: PairingState = { code: started.value.code, expiresAt: started.value.expiresAt };
  ctx.state.setPairing(pairing);

  // The store refuses a code it cannot show (already past `expiresAt` by its
  // clock) and clears the display instead; a failure must never look like a
  // usable code, so that case is reported as what it is.
  const shown = ctx.state.pairing;
  if (shown === undefined) {
    ctx.sessionView.postPairing();
    await ctx.ui.notifyFailure(
      new DebuggenError('PAIRING_EXPIRED', 'The pairing code had already expired when it arrived', {
        hint: 'Check that the system clock is correct, then run "Pair Chrome DevTools Panel" again for a new code.',
      }),
      { prefix: FAILURE_PREFIX },
    );
    return;
  }

  ctx.sessionView.postPairing(shown);
  await revealSessionView(ctx);

  ctx.logger.info('Pairing started', { command: PAIR_CHROME_COMMAND });
  await ctx.ui.notify(pairingReadyNotice(shown.expiresAt, Date.now()));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reports a failed `pair.start` once, offering "Start service" when that is
 * the remedy, and runs `debuggen.startService` when the developer chooses it.
 * Nothing is retried: the developer runs pairing again once the service is up,
 * and a rate-limited failure waits out the service's lockout.
 *
 * @param ctx The resolved command context.
 * @param error The typed failure `pairStart` returned.
 */
async function reportStartFailure(ctx: CommandContext, error: DebuggenError): Promise<void> {
  const offerStart = START_SERVICE_REMEDY_CODES.has(error.code);
  const choice = await ctx.ui.notifyFailure(
    error,
    offerStart
      ? { prefix: FAILURE_PREFIX, actions: [START_SERVICE_ACTION] }
      : { prefix: FAILURE_PREFIX },
  );
  if (!offerStart || choice !== START_SERVICE_ACTION) {
    return;
  }
  try {
    await ctx.ui.executeCommand(START_SERVICE_COMMAND);
  } catch (thrown) {
    // `debuggen.startService` reports its own failures; only a command VS Code
    // could not run at all lands here, and it is a separate failure from the
    // pairing one, reported once.
    await ctx.ui.notifyFailure(DebuggenError.from(thrown), {
      prefix: START_SERVICE_FAILURE_PREFIX,
    });
  }
}

/**
 * Reveals the Debug Generator view, the code's only display site, so a
 * pairing started from the Command Palette is visible without a hunt. A view
 * that cannot be revealed is not a pairing failure — the code is stored and
 * the notice says where it is — so that outcome is recorded by error code only.
 *
 * @param ctx The resolved command context.
 */
async function revealSessionView(ctx: CommandContext): Promise<void> {
  try {
    await ctx.ui.executeCommand(SESSION_VIEW_FOCUS);
  } catch (thrown) {
    ctx.logger.debug('Session view could not be revealed', {
      command: PAIR_CHROME_COMMAND,
      code: DebuggenError.from(thrown).code,
    });
  }
}

/**
 * The success notice: where the code is shown, where to enter it, that it
 * works once and roughly how long it stays valid. It never contains the code
 * itself.
 *
 * @param expiresAt When the code stops being accepted, in epoch milliseconds.
 * @param now The current time, in epoch milliseconds.
 */
function pairingReadyNotice(expiresAt: number, now: number): CommandNotice {
  const minutes = Math.max(1, Math.ceil((expiresAt - now) / MS_PER_MINUTE));
  const lifetime = minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  return {
    level: 'info',
    message: 'Chrome pairing code ready — it is shown in the Debug Generator view.',
    detail:
      `In Chrome DevTools, open the Debug Generator panel, choose "Not paired" and enter the code in the Pair dialog. ` +
      `It works once and expires within ${lifetime}; run "Pair Chrome DevTools Panel" again for a new code.`,
  };
}
