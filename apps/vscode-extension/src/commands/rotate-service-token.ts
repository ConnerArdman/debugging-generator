/**
 * `debuggen.rotateServiceToken` — "Debug Generator: Rotate Service Token".
 *
 * ## What rotation is (AAP §0.5.6)
 *
 * The local service authenticates three kinds of client, each with a
 * role-bound credential stored only as a SHA-256 hash: the editor (its token in
 * `$DEBUGGEN_HOME/auth.json`, mode `0600`), each paired Chrome DevTools panel
 * and each dev server the service launched with the telemetry preload. Rotation
 * revokes all of them at once: every credential row and every outstanding
 * pairing code is deleted, a new editor credential is minted and `auth.json` is
 * regenerated, and every open socket is closed with code 4401 — so paired
 * Chrome extensions must pair again and launched dev servers must be
 * relaunched. The service implements exactly that as one transaction
 * (`AuthService.rotateAll` in `apps/local-service/src/server/auth.ts`, pinned by
 * `apps/local-service/src/server/auth.test.ts` and the "rotation and
 * revocation" suite of `apps/local-service/test/integration/auth.test.ts`).
 *
 * ## Why this command reports instead of rotating
 *
 * The extension may reach the service only through an operation the protocol
 * declares — `ServiceClient.request(operation, args)` by operation id, never a
 * hand-written path, method or `fetch` — and the protocol declares no rotation
 * operation: `HTTP_OPERATIONS` in `packages/protocol/src/http.ts` lists the
 * session, capture, panel, modification, telemetry-ingest, dev-server, health
 * and pairing operations and nothing that rotates, and no WebSocket message
 * requests a rotation either. `AuthService.rotateAll` is therefore reachable
 * only from inside the service process.
 *
 * Inventing a route here would be worse than useless: the service registers
 * exactly the protocol's operations, so a hand-written request would reach no
 * handler (its `notFound` answer), and a command that appeared to rotate would
 * leave the developer believing credentials were revoked when every one of
 * them is still valid. The command consequently performs no request and renders exactly one
 * typed failure (`NOT_IMPLEMENTED`, built by {@link rotationUnavailableError})
 * whose message says that nothing was changed and whose hint says that nothing
 * needs to be re-paired or relaunched.
 *
 * No confirmation modal is shown. The modal guards a destructive request, and
 * this build issues none: asking the developer to accept "every credential is
 * deleted" and then reporting that nothing happened would be the misleading
 * sequence the confirmation exists to prevent.
 *
 * ## What the command never does
 *
 * - It never writes, deletes or re-reads `$DEBUGGEN_HOME/auth.json` and never
 *   mints or hashes a credential: the service owns that file, and
 *   `../service/auth.ts` is the only reader in the extension. Nothing was
 *   rotated, so the cached editor credential is still the valid one and is left
 *   untouched, as is any pairing code on display.
 * - It never opens, closes or reconnects a socket: reconnection and backoff
 *   belong to the protocol's `ReconnectingWsClient` inside
 *   `../service/client.ts`, and a 4401 close is handled there and in
 *   `src/extension.ts`.
 * - It never logs or displays a credential, a credential hash or the content of
 *   `auth.json` (AAP §0.5.2): its one log record carries the command id and the
 *   error code.
 * - It never throws for this expected condition. The failure is a
 *   `DebuggenError` rendered once through `CommandUi.notifyFailure`, so the
 *   registration wrapper in `./index.ts` never sees it.
 *
 * ## Module conventions
 *
 * Authored as ESM with extensionless relative specifiers and bundled to
 * CommonJS by `esbuild.mjs`; no top-level `await`; Node and `vscode` types
 * only. Like every command module it imports **types only** from `./index`,
 * which keeps the barrel → module edge the folder's single runtime edge.
 *
 * @packageDocumentation
 */

import { DebuggenError } from '@debuggen/shared';

import type { CommandContext, CommandId } from './index';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * This module's command id. The `satisfies` clause ties the literal to the
 * contributed vocabulary of `./index`, so a rename there is a compile error
 * here rather than a log field naming a command that no longer exists.
 */
const COMMAND_ID = 'debuggen.rotateServiceToken' satisfies CommandId;

/**
 * What was being attempted, prefixed to the failure headline by
 * `CommandUi.notifyFailure` ("Could not rotate the service token: …").
 */
export const ROTATE_SERVICE_TOKEN_FAILURE_PREFIX = 'Could not rotate the service token';

/**
 * The failure's message: why nothing happened, stated so that it cannot be
 * read as a partial rotation.
 */
const ROTATION_UNAVAILABLE_MESSAGE =
  'This build of Debug Generator has no service operation for rotating credentials, so no credential was changed.';

/**
 * The failure's actionable half: what the developer does next — nothing, which
 * is exactly what must be said, because a developer who believes a rotation ran
 * would otherwise go and re-pair Chrome and relaunch dev servers for no reason.
 */
const ROTATION_UNAVAILABLE_HINT =
  'Every existing credential stays valid: the editor, paired Chrome DevTools panels and launched dev servers keep working, and nothing needs to be re-paired or relaunched.';

/**
 * The diagnostic reason recorded in the failure's `details`. `details` never
 * reaches a notification (`CommandUi.notifyFailure` renders the message and the
 * hint only); it exists for a caller or a test that inspects the error.
 */
const ROTATION_UNAVAILABLE_REASON = 'rotation-operation-not-declared';

// ---------------------------------------------------------------------------
// The failure
// ---------------------------------------------------------------------------

/**
 * Builds the typed failure this command reports: the protocol this build
 * speaks declares no credential-rotation operation, so no request was made and
 * no credential changed.
 *
 * A fresh instance per call, so no caller can observe another's error object.
 * The error carries no credential, path or URL — only fixed sentences, the
 * command id and a reason — so it is safe to log and to render.
 *
 * @returns A `NOT_IMPLEMENTED` error with a developer-facing hint and
 *   `details: { command, reason }`.
 */
export function rotationUnavailableError(): DebuggenError {
  return new DebuggenError('NOT_IMPLEMENTED', ROTATION_UNAVAILABLE_MESSAGE, {
    hint: ROTATION_UNAVAILABLE_HINT,
    details: { command: COMMAND_ID, reason: ROTATION_UNAVAILABLE_REASON },
  });
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * Runs `debuggen.rotateServiceToken`.
 *
 * Reports, as exactly one error notice in the Debug Generator view and as a VS
 * Code notification, that credential rotation is not available in this build
 * and that every existing credential stays valid. It performs no HTTP request,
 * opens no confirmation modal (nothing destructive can follow it), leaves the
 * editor credential and any displayed pairing code untouched, and resolves
 * normally — it never throws for this expected condition.
 *
 * @param ctx The command context built by `registerCommands`.
 * @param args Whatever VS Code invoked the command with. The command takes no
 *   argument; any given is ignored, and only their count is logged.
 */
export async function rotateServiceToken(
  ctx: CommandContext,
  ...args: readonly unknown[]
): Promise<void> {
  const error = rotationUnavailableError();

  // Facts only: the command id, the error code and how many arguments were
  // ignored — never a credential, a hash or the content of auth.json.
  ctx.logger.warn('Service token rotation is not available in this build', {
    command: COMMAND_ID,
    code: error.code,
    ignoredArguments: args.length,
  });

  await ctx.ui.notifyFailure(error, { prefix: ROTATE_SERVICE_TOKEN_FAILURE_PREFIX });
}
