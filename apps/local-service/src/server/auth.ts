/**
 * The local service's access boundary (AAP §0.5.6): who may talk to this
 * process, from where, and with what authority.
 *
 * Binding to `127.0.0.1` keeps other machines out but not other processes or
 * web pages on the developer's own machine. This module is therefore the one
 * place that authenticates every client, refuses every web origin and binds
 * every credential to a role and a scope. Everything else in `src/server/**`
 * consumes its decisions: `http.ts` installs {@link createAuthMiddleware} in
 * front of every route, `ws.ts` runs {@link AuthService.authorizeHello} on the
 * first frame of every socket, `clients.ts` keeps the resulting
 * {@link Principal} beside each connection and satisfies
 * {@link ConnectionRevoker} structurally, and the route modules call
 * {@link requireRole}, {@link requireProjectScope}, {@link requireBoundSession}
 * and {@link requireSessionAccess} so that no rule is re-derived per route.
 *
 * ## The three credentials
 *
 * Every credential is a 32-byte CSPRNG token, rendered base64url, and stored
 * **only** as its SHA-256 digest in the `credentials` table together with its
 * role, its scope and its lifetime. The plaintext exists in exactly three
 * places in the whole system: `$DEBUGGEN_HOME/auth.json` (mode `0600`), the
 * one-time response body of `POST /pair/complete`, and the environment of a
 * dev-server process the launcher started. Nothing in this module logs,
 * persists, throws or returns a plaintext token anywhere else.
 *
 * | Role | Scope | Issued by | Lifetime |
 * | --- | --- | --- | --- |
 * | `vscode` (editor) | the machine user; acts on projects under the workspace folders its live connections announced in `client.hello` | {@link AuthService.ensureEditorCredential}, written to `auth.json` | until rotation |
 * | `devtools` | the Chrome extension id that redeemed a pairing code | {@link AuthService.completePairing} | until rotation |
 * | `server-agent` | exactly one `projectRoot` | {@link AuthService.issueServerAgentCredential}, called by the dev-server launcher | until the launched process exits ({@link AuthService.revokeServerAgentCredentials}) or an explicit expiry |
 *
 * The page agent (`client: 'agent'` in protocol's `CLIENT_KINDS`) holds no
 * credential and no socket of its own: the Chrome service worker relays its
 * frames under the tab's `devtools` connection (AAP §0.4.2). A hello claiming
 * to be the page agent is refused by {@link roleForClientKind}.
 *
 * ## The origin policy
 *
 * Accepted `Origin` values are exactly three shapes, judged on a parsed URL and
 * never on a substring: absent (Node clients — the extension host, the preload,
 * the integration suites), `chrome-extension://<id>` and `vscode-webview://<id>`.
 * Every `http:`/`https:` origin is refused without exception, as are `file:`,
 * `data:`, the literal `null` and anything unparseable. The policy is applied
 * **first**, before the exemption check, so the two unauthenticated operations
 * (`health` and `pair.complete`) refuse web origins like every other route —
 * exempt means "no bearer credential", never "unprotected".
 *
 * On top of that, each role may only be presented from the origins its client
 * can actually have: an editor credential from no origin or a VS Code webview,
 * a DevTools credential only from `chrome-extension://<the id it was issued
 * to>`, and a server-agent credential only from no origin. A credential that
 * surfaces anywhere else is refused, which is what makes a stolen DevTools
 * token useless outside the extension that paired.
 *
 * No `Access-Control-Allow-Origin` header is ever set by this module or by the
 * middleware it builds. Its absence is load-bearing: it is why a browser page
 * cannot read any response even if it provokes one, and together with the
 * bearer requirement on every state-changing route it is what closes CSRF.
 *
 * ## Authorization comes from the credential, never from the client
 *
 * `client.hello`'s `client`, `projectRoot` and `tabId` are claims. The stored
 * role and scope decide; where a claim contradicts the credential, the
 * credential wins and the connection is refused. The one claim that *narrows*
 * authority rather than asserting it is the editor's announced `projectRoot`:
 * an editor credential may act only under folders its connections announced,
 * and an announcement lives exactly as long as the connection that made it
 * ({@link AuthService.announceWorkspace}).
 *
 * ## Failure reporting
 *
 * Every fallible operation returns a `Result`; nothing here throws. Every
 * refusal is a `DebuggenError` whose code comes from the closed
 * `DEBUGGEN_ERROR_CODES` set and whose `details.reason` names one entry of
 * {@link AUTH_FAILURE_REASONS}, which fixes its HTTP status (401, 403 or 429).
 * Messages are constant sentences about the rule that was applied; no presented
 * value — token, code, header, payload — is ever interpolated into one.
 *
 * ## State and lifetime
 *
 * Durable state is the two tables `credentials` and `pairing_codes`, reached
 * through the injected {@link Store}'s statement cache. The only in-memory state
 * is the pairing lockout ledger and the workspace announcements, both bounded,
 * both dropped by {@link AuthService.close}. This module starts no timer and
 * opens no socket: lockouts expire lazily against the injected clock.
 */

import { randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';

import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';

import {
  AUTHORIZATION_HEADER,
  CLIENT_KINDS,
  PROTOCOL_VERSION,
  WS_CLOSE_UNAUTHORIZED,
  clientHelloPayloadSchema,
  describeZodIssues,
  formatBearer,
  isAuthExemptOperation,
  isCompatibleProtocolVersion,
  toErrorPayload,
} from '@debuggen/protocol';
import type {
  AuthExemptOperation,
  ClientKind,
  HttpErrorResponse,
  HttpOperationId,
} from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  isWithin,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, Result } from '@debuggen/shared';
import {
  SECURE_FILE_MODE,
  ensureSecureDir,
  inspectPrivateFileNoFollow,
  readFileNoFollow,
  sha256Hex,
  writeSecureFileAtomic,
} from '@debuggen/shared/node';

import type { ServiceConfig } from '../config.js';
import { subsystemLogger } from '../logging.js';
import type { Store } from '../store/db.js';

/* -------------------------------------------------------------------------------------------------
 * Policy constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The three roles a credential can carry, in the order AAP §0.5.6 introduces
 * them: the editor, the paired DevTools client, and a launched dev server.
 *
 * Deliberately one member shorter than protocol's `CLIENT_KINDS`, which also
 * lists `agent`: the MAIN-world page agent owns no socket and no credential, so
 * no row in `credentials` can ever name it. {@link roleForClientKind} states the
 * relationship between the two vocabularies in one place, and the `satisfies`
 * clause keeps every role a genuine protocol client kind.
 */
export const CREDENTIAL_ROLES = Object.freeze([
  'vscode',
  'devtools',
  'server-agent',
] as const satisfies readonly ClientKind[]);

/** One member of {@link CREDENTIAL_ROLES}. */
export type PrincipalRole = (typeof CREDENTIAL_ROLES)[number];

/**
 * How many random bytes every credential carries (AAP §0.5.6).
 *
 * The token is these bytes rendered base64url, so decoding a token always
 * yields exactly this many bytes.
 */
export const CREDENTIAL_TOKEN_BYTES = 32;

/** The `version` field of the `auth.json` record this module writes. */
export const AUTH_FILE_VERSION = 1;

/** How many characters a pairing code has (AAP §0.5.6). */
export const PAIRING_CODE_LENGTH = 8;

/**
 * The characters a pairing code is drawn from: upper-case Latin letters and
 * digits with the look-alikes removed (`0`/`O` and `1`/`I`), because the
 * developer reads the code off the editor and types it into the DevTools panel.
 *
 * Thirty-two symbols, so each character carries five bits and an eight
 * character code forty; a byte maps onto the alphabet without modulo bias.
 */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** How long a pairing code stays redeemable after it is issued: five minutes. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/** How many times one pairing code can be redeemed: once. */
export const PAIRING_CODE_MAX_REDEMPTIONS = 1;

/**
 * How many consecutive failed redemptions from one presenting origin trigger a
 * lockout of that origin.
 */
export const PAIRING_MAX_FAILURES = 5;

/**
 * How long a lockout lasts, and how long a failure is remembered when no
 * further failure follows it: sixty seconds.
 */
export const PAIRING_LOCKOUT_MS = 60 * 1000;

/**
 * How many failed redemptions across **all** origins within one
 * {@link PAIRING_LOCKOUT_MS} window lock pairing globally for that window.
 *
 * The per-origin ledger alone is not a brute-force defence against a local
 * process, which can put any `chrome-extension://…` value in its `Origin`
 * header and so earn five fresh attempts per invented id. This ceiling bounds
 * what such a process can try per window regardless of how many origins it
 * forges. Pairing is a rare, developer-initiated action, so a forger locking it
 * for a minute costs nothing an honest client cannot recover from by retrying.
 */
export const PAIRING_GLOBAL_MAX_FAILURES = PAIRING_MAX_FAILURES * 4;

/**
 * The most presenting origins the lockout ledger remembers at once.
 *
 * A bound on memory, not a policy: entries expire on their own after
 * {@link PAIRING_LOCKOUT_MS}, and the global ceiling above stops a forger long
 * before this many ids have been tried.
 */
const MAX_TRACKED_PAIRING_ORIGINS = 1024;

/** How many times generation retries when a fresh value collides with a stored one. */
const MAX_GENERATION_ATTEMPTS = 4;

/**
 * The reason text a rotation hands to the revoker for every socket it closes.
 * WebSocket close reasons are limited to 123 bytes, so it is short.
 */
const ROTATION_CLOSE_REASON = 'credentials rotated';

/** The request header that carries a browser client's origin, lower-case like hono's lookups. */
const ORIGIN_HEADER = 'origin';

/**
 * The accepted spelling of a Chrome extension id in an origin: what Chrome
 * mints (thirty-two letters `a`–`p`) and the hyphenated or underscored ids a
 * development build or a suite may use. Dots, credentials and ports are refused
 * by the origin parser before this is consulted, which is what stops
 * `chrome-extension://evil.example` from passing.
 */
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The accepted spelling of a VS Code webview origin's host. */
const WEBVIEW_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * The highest code unit that counts as a control character or a space in an
 * `Origin` value (U+0020); U+007F (DEL) is refused alongside it. Checked by
 * code unit rather than by a regular expression so the rule needs no control
 * characters spelled inside a pattern.
 */
const HIGHEST_CONTROL_OR_SPACE_CODE_UNIT = 0x20;

/** The DEL control character, refused in an `Origin` value like the C0 controls. */
const DELETE_CODE_UNIT = 0x7f;

/** Unicode whitespace, which no genuine `Origin` value contains. */
const WHITESPACE = /\s/;

/** Characters that cannot appear inside a bearer credential presented in a header. */
const BEARER_FORBIDDEN_CHARACTERS = /[\s,]/;

/** Permission bits that grant a group or other accounts access to a file. */
const GROUP_OR_OTHER_PERMISSION_BITS = 0o077;

/* -------------------------------------------------------------------------------------------------
 * Client kinds and roles
 * ---------------------------------------------------------------------------------------------- */

/**
 * Which credential role each protocol client kind authenticates with.
 *
 * `agent` maps to `null` on purpose: the page agent has no credential of its
 * own, so a hello claiming that kind can never be satisfied by any row.
 * `satisfies Record<ClientKind, …>` makes a kind added upstream a compile error
 * here until this table says what it means.
 */
const ROLE_BY_CLIENT_KIND = Object.freeze({
  vscode: 'vscode',
  devtools: 'devtools',
  agent: null,
  'server-agent': 'server-agent',
} as const satisfies Readonly<Record<ClientKind, PrincipalRole | null>>);

/** Whether a string is one of protocol's `CLIENT_KINDS`. */
function isClientKind(value: string): value is ClientKind {
  return (CLIENT_KINDS as readonly string[]).includes(value);
}

/**
 * The credential role a client of the given kind must present, or `undefined`
 * when no credential can authenticate that kind (the page agent) or the string
 * is not a protocol client kind at all.
 *
 * @param kind A `client.hello` `client` value.
 * @returns The role whose credential that client must hold.
 */
export function roleForClientKind(kind: string): PrincipalRole | undefined {
  if (!isClientKind(kind)) {
    return undefined;
  }
  return ROLE_BY_CLIENT_KIND[kind] ?? undefined;
}

/**
 * Whether a client announcing itself as `kind` may authenticate with a
 * credential of `role`. The credential's role is authoritative: a mismatch is a
 * refusal, never a reinterpretation of the credential.
 *
 * @param kind The claimed client kind.
 * @param role The role stored with the presented credential.
 * @returns `true` only when the kind's required role is exactly `role`.
 */
export function clientKindSatisfiesRole(kind: string, role: PrincipalRole): boolean {
  return roleForClientKind(kind) === role;
}

/* -------------------------------------------------------------------------------------------------
 * Scopes, principals and the types the server modules share
 * ---------------------------------------------------------------------------------------------- */

/**
 * The editor credential's scope: the developer's own account on this machine.
 *
 * `workspaceFolders` is **not** stored with the credential. It is what the
 * credential's live connections announced in `client.hello`, attached to the
 * principal of the connection (or, for an HTTP request, the union of the
 * folders the credential's open connections currently announce). An editor
 * principal with no announced folder may receive messages but may act on no
 * project.
 */
export interface MachineUserScope {
  readonly kind: 'machine-user';
  /** Absolute, normalised POSIX folders; frozen. */
  readonly workspaceFolders: readonly string[];
}

/** The DevTools credential's scope: the Chrome extension id that paired. */
export interface ExtensionScope {
  readonly kind: 'extension';
  /** The host of the `chrome-extension://<id>` origin that redeemed the code. */
  readonly extensionId: string;
}

/** The server-agent credential's scope: the one project it may ingest for. */
export interface ProjectScope {
  readonly kind: 'project';
  /** Absolute, normalised POSIX project root. */
  readonly projectRoot: string;
}

/** The scope a credential carries, discriminated on `kind` (AAP §0.5.6). */
export type CredentialScope = MachineUserScope | ExtensionScope | ProjectScope;

/** What every principal carries besides its role and scope. */
interface PrincipalBase {
  /**
   * The SHA-256 digest of the presented credential — the `credentials` row's
   * primary key. Safe to keep beside a connection and to compare; it is not the
   * credential and cannot be turned back into one.
   */
  readonly tokenHash: string;
  /** When the credential was issued, in epoch milliseconds. */
  readonly issuedAt: number;
  /** When the credential stops being accepted, in epoch milliseconds; absent when it does not expire on its own. */
  readonly expiresAt?: number;
}

/** A resolved editor credential. */
export interface EditorPrincipal extends PrincipalBase {
  readonly role: 'vscode';
  readonly scope: MachineUserScope;
}

/** A resolved DevTools credential. */
export interface DevtoolsPrincipal extends PrincipalBase {
  readonly role: 'devtools';
  readonly scope: ExtensionScope;
}

/** A resolved dev-server (Node preload) credential. */
export interface ServerAgentPrincipal extends PrincipalBase {
  readonly role: 'server-agent';
  readonly scope: ProjectScope;
}

/**
 * The identity a request or a connection acts with, resolved from the stored
 * credential row — never from anything the client said about itself.
 *
 * Discriminated on `role`, so narrowing the role narrows the scope. It carries
 * no plaintext credential, which makes it safe to keep in a client registry, to
 * put on a hono context and to compare.
 */
export type Principal = EditorPrincipal | DevtoolsPrincipal | ServerAgentPrincipal;

/**
 * A freshly issued credential: the **only** type in the service that carries a
 * plaintext token. It is returned exactly once per issuance, to the one caller
 * that hands it to its client, and never persisted.
 */
export interface IssuedCredential {
  readonly token: string;
  readonly expiresAt?: number;
}

/**
 * The hono environment of every route: the operation the registration loop in
 * `http.ts` bound the handler to, and the principal {@link createAuthMiddleware}
 * resolved for it.
 *
 * `principal` is set for every operation that requires a credential and never
 * for the two auth-exempt ones (`health`, `pair.complete`), whose handlers
 * must not read it.
 */
export type ServerEnv = {
  Variables: {
    principal: Principal;
    operation: HttpOperationId;
  };
};

/**
 * A tab-to-session binding as the authorization rules need to see it.
 *
 * `boundBy` is the {@link Principal.tokenHash} of the DevTools connection that
 * bound the tab: AAP §0.5.6 records a binding "against the connection's
 * principal", which is what stops one DevTools credential from acting on a
 * session another credential's tab is bound to.
 */
export interface TabBinding {
  readonly tabId: number;
  readonly sessionId: string;
  readonly boundBy: string;
}

/** The two facts about a session its access rule depends on. */
export interface SessionAccessTarget {
  readonly id: string;
  readonly projectRoot: string;
}

/**
 * The consumer-declared port rotation closes every socket through.
 *
 * Declared here rather than imported from `./clients.js`, so the edge between
 * the two modules stays one-way (`clients.ts` type-imports {@link Principal}
 * from here): the client registry satisfies this interface structurally and
 * `main.ts` injects it.
 */
export interface ConnectionRevoker {
  /**
   * Closes every open connection with the given WebSocket close code.
   *
   * @param code The close code — always protocol's `WS_CLOSE_UNAUTHORIZED` here.
   * @param reason A short close reason.
   * @returns How many sockets were closed.
   */
  revokeAll(code: number, reason?: string): number;
}

/** What {@link AuthService.ensureEditorCredential} reports. */
export interface EditorCredentialState {
  readonly principal: EditorPrincipal;
  /** Whether a new token was minted and `auth.json` written by this call. */
  readonly created: boolean;
}

/** The input of {@link AuthService.issueServerAgentCredential}. */
export interface ServerAgentCredentialRequest {
  /** The absolute project root the launched process may ingest for. */
  readonly projectRoot: string;
  /** An explicit expiry in epoch milliseconds, in the future; absent to live until revoked. */
  readonly expiresAt?: number | undefined;
}

/**
 * Headers as either transport presents them: a WHATWG `Headers` object (hono's
 * `c.req.raw.headers`) or Node's `IncomingHttpHeaders` record (a WebSocket
 * upgrade request).
 */
export type HeaderSource =
  Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

/** The input of {@link AuthService.authorizeHttpRequest}. */
export interface HttpAuthorizationRequest {
  readonly headers: HeaderSource;
  /** The raw `Origin` header value, or `undefined` when the request carried none. */
  readonly origin: string | undefined;
  /** The operation the route was registered for. */
  readonly operation: HttpOperationId;
}

/** The input of {@link AuthService.authorizeHello}. */
export interface HelloAuthorizationRequest {
  /** The first frame's `payload`, unvalidated. */
  readonly payload: unknown;
  /** The WebSocket upgrade request's `Origin` header, or `undefined`. */
  readonly origin: string | undefined;
}

/** What {@link AuthService.startPairing} returns: the code to display and when it dies. */
export interface PairingCode {
  readonly code: string;
  readonly expiresAt: number;
}

/** The input of {@link AuthService.completePairing}. */
export interface PairingCompletionRequest {
  /** The code the developer typed. */
  readonly code: string;
  /** The `Origin` of the redeeming request; must be `chrome-extension://<id>`. */
  readonly origin: string | undefined;
}

/** What {@link AuthService.rotateAll} reports. */
export interface RotationOutcome {
  /** Credential rows deleted — every credential that existed before the call. */
  readonly credentialsDeleted: number;
  /** Sockets the injected revoker closed. */
  readonly socketsClosed: number;
}

/**
 * A live workspace announcement. Released when the connection that made it
 * closes; releasing twice is harmless.
 */
export interface WorkspaceAnnouncement {
  readonly release: () => void;
}

/* -------------------------------------------------------------------------------------------------
 * Failure vocabulary
 * ---------------------------------------------------------------------------------------------- */

/** The HTTP statuses an access-boundary failure is answered with. */
export type AuthHttpStatus = 401 | 403 | 429;

/** One entry of {@link AUTH_FAILURE_REASONS}. */
interface AuthFailureDescriptor {
  /** The `DebuggenError` code the refusal carries. */
  readonly code: DebuggenErrorCode;
  /** The status an HTTP refusal is answered with. */
  readonly status: AuthHttpStatus;
  /** The constant sentence the refusal says by default. */
  readonly message: string;
  /** The developer's next step, when there is one. */
  readonly hint?: string;
}

/**
 * Every way the access boundary refuses, with the error code and HTTP status
 * each one carries.
 *
 * The table is the single place a refusal's status is decided: 401 when the
 * caller is not (or no longer) authenticated, 403 when it is authenticated but
 * the origin, role or scope does not permit the act, 429 during a pairing
 * lockout. `details.reason` on every refusal names its entry, so
 * {@link authFailureStatus} can map an error back to its status without parsing
 * a message.
 */
export const AUTH_FAILURE_REASONS = Object.freeze({
  'forbidden-origin': {
    code: 'FORBIDDEN_ORIGIN',
    status: 403,
    message:
      'Debug Generator refuses requests from web origins. Only the Debug Generator DevTools extension, the VS Code webview and local Node clients may call this service.',
  },
  'origin-not-permitted-for-role': {
    code: 'UNAUTHORIZED',
    status: 403,
    message: 'This credential may not be presented from the origin this request came from.',
    hint: 'Use the credential only from the client it was issued to; pair the DevTools extension again if it was reinstalled.',
  },
  'missing-credential': {
    code: 'UNAUTHORIZED',
    status: 401,
    message: 'This request requires a Debug Generator credential and carried none.',
    hint: 'Send the credential as an Authorization: Bearer header.',
  },
  'malformed-credential': {
    code: 'UNAUTHORIZED',
    status: 401,
    message: 'The Authorization header is not a single well-formed bearer credential.',
    hint: 'Send exactly one Authorization: Bearer header carrying the issued credential.',
  },
  'unknown-credential': {
    code: 'UNAUTHORIZED',
    status: 401,
    message: 'The presented credential is not one this service issued, or it has been revoked.',
    hint: 'Re-read the editor credential, pair the DevTools extension again, or relaunch the dev server.',
  },
  'expired-credential': {
    code: 'UNAUTHORIZED',
    status: 401,
    message: 'The presented credential has expired.',
    hint: 'Relaunch the dev server from Debug Generator to obtain a fresh credential.',
  },
  'corrupt-credential': {
    code: 'UNAUTHORIZED',
    status: 401,
    message: 'The stored record for the presented credential is not valid, so it is refused.',
    hint: 'Rotate the service credentials from VS Code (Debug Generator: Rotate Service Token).',
  },
  'role-not-permitted': {
    code: 'UNAUTHORIZED',
    status: 403,
    message: 'The presented credential does not permit this operation.',
  },
  'hello-invalid': {
    code: 'PROTOCOL_INVALID_MESSAGE',
    status: 401,
    message: 'The first frame was not a well-formed client.hello.',
  },
  'protocol-incompatible': {
    code: 'PROTOCOL_INVALID_MESSAGE',
    status: 401,
    message: `The client speaks a protocol version this service cannot talk to; this service speaks ${PROTOCOL_VERSION}.`,
    hint: 'Update the Debug Generator extensions and the local service to matching versions.',
  },
  'client-kind-mismatch': {
    code: 'UNAUTHORIZED',
    status: 401,
    message:
      'The client kind announced in client.hello does not match the role of the presented credential.',
  },
  'hello-claim-mismatch': {
    code: 'UNAUTHORIZED',
    status: 401,
    message: 'The client.hello announcement contradicts the scope of the presented credential.',
  },
  'project-out-of-scope': {
    code: 'PATH_OUTSIDE_PROJECT',
    status: 403,
    message: 'The presented credential is not scoped to this project.',
    hint: 'Open the project as a workspace folder in VS Code before debugging it.',
  },
  'session-not-bound': {
    code: 'TAB_NOT_BOUND',
    status: 403,
    message: 'This DevTools client may act only on the session its inspected tab is bound to.',
    hint: 'Open the Debug Generator panel on the tab running the session.',
  },
  'pairing-origin-required': {
    code: 'FORBIDDEN_ORIGIN',
    status: 403,
    message: 'A pairing code can only be redeemed by the Debug Generator Chrome extension.',
  },
  'pairing-invalid': {
    code: 'PAIRING_INVALID',
    status: 401,
    message: 'The pairing code is not valid.',
    hint: 'Run "Debug Generator: Pair Chrome" in VS Code and enter the code it shows.',
  },
  'pairing-used': {
    code: 'PAIRING_INVALID',
    status: 401,
    message: 'The pairing code has already been used.',
    hint: 'Run "Debug Generator: Pair Chrome" in VS Code for a new code.',
  },
  'pairing-expired': {
    code: 'PAIRING_EXPIRED',
    status: 401,
    message: 'The pairing code has expired.',
    hint: 'Run "Debug Generator: Pair Chrome" in VS Code for a new code.',
  },
  'pairing-locked': {
    code: 'RATE_LIMITED',
    status: 429,
    message: 'Too many failed pairing attempts; pairing is paused.',
    hint: `Wait ${String(PAIRING_LOCKOUT_MS / 1000)} seconds, then enter the current code again.`,
  },
} as const satisfies Readonly<Record<string, AuthFailureDescriptor>>);

/** One key of {@link AUTH_FAILURE_REASONS}. */
export type AuthFailureReason = keyof typeof AUTH_FAILURE_REASONS;

/** Whether a string names an entry of {@link AUTH_FAILURE_REASONS}. */
function isAuthFailureReason(value: string): value is AuthFailureReason {
  return Object.hasOwn(AUTH_FAILURE_REASONS, value);
}

/**
 * Builds the refusal for one reason. The message is the table's constant unless
 * the caller supplies a more specific one, which must be a constant too: no
 * presented value is ever interpolated into it.
 */
function authFailure(reason: AuthFailureReason, message?: string): DebuggenError {
  const descriptor: AuthFailureDescriptor = AUTH_FAILURE_REASONS[reason];
  return new DebuggenError(descriptor.code, message ?? descriptor.message, {
    details: { reason },
    ...(descriptor.hint === undefined ? {} : { hint: descriptor.hint }),
  });
}

/** {@link authFailure} as an `Err`, typed for whichever `Result` the caller returns. */
function refuse<T>(reason: AuthFailureReason, message?: string): Result<T, DebuggenError> {
  return err(authFailure(reason, message));
}

/**
 * The access-boundary reason an error was raised for, or `undefined` when it is
 * not a refusal from this module (a store failure, for instance).
 *
 * @param error Any error returned by this module.
 * @returns The {@link AUTH_FAILURE_REASONS} key in `details.reason`.
 */
export function authFailureReasonOf(error: DebuggenError): AuthFailureReason | undefined {
  const reason = error.details?.['reason'];
  return typeof reason === 'string' && isAuthFailureReason(reason) ? reason : undefined;
}

/**
 * The HTTP status a refusal is answered with, or `undefined` when the error is
 * not an access-boundary refusal and should be treated as a server failure.
 *
 * @param error Any error returned by this module.
 * @returns 401, 403 or 429 per {@link AUTH_FAILURE_REASONS}.
 */
export function authFailureStatus(error: DebuggenError): AuthHttpStatus | undefined {
  const reason = authFailureReasonOf(error);
  return reason === undefined ? undefined : AUTH_FAILURE_REASONS[reason].status;
}

/** The fixed body message of an access-boundary step that failed for a reason other than a refusal. */
const AUTH_UNAVAILABLE_MESSAGE =
  'The Debug Generator local service could not check this request’s credential. Its log holds the reason.';

/**
 * The HTTP response for an error returned by this module: the protocol's error
 * body and the status from {@link AUTH_FAILURE_REASONS}, or `500` with a fixed
 * message for anything that is not a refusal, so a store or filesystem failure
 * never reaches a response body.
 *
 * @param error An error returned by {@link AuthService.authorizeHttpRequest} or a helper.
 * @returns The status and the body to send.
 */
export function authErrorResponse(error: DebuggenError): {
  readonly status: AuthHttpStatus | 500;
  readonly body: HttpErrorResponse;
} {
  const status = authFailureStatus(error);
  if (status === undefined) {
    return { status: 500, body: { code: error.code, message: AUTH_UNAVAILABLE_MESSAGE } };
  }
  return { status, body: toErrorPayload(error) };
}

/* -------------------------------------------------------------------------------------------------
 * Which roles may call which operation
 * ---------------------------------------------------------------------------------------------- */

/** Every operation that requires a credential. */
export type AuthenticatedOperation = Exclude<HttpOperationId, AuthExemptOperation>;

/**
 * The roles permitted to call each authenticated HTTP operation (AAP §0.5.6).
 *
 * Keyed by the protocol's operation ids and exhaustive by construction: an
 * operation added to `HTTP_ROUTES` without an entry here fails to compile, so a
 * new route is refused to every role until someone decides who may call it.
 * The role check is the coarse gate the middleware applies; the scope checks —
 * which project, which bound session — are the route's, through
 * {@link requireProjectScope}, {@link requireBoundSession} and
 * {@link requireSessionAccess}.
 *
 * - The editor controls sessions, dev servers and pairing.
 * - A DevTools client reads and captures only through the session its tab is
 *   bound to, and can never create, question or end a session.
 * - A server agent may only post telemetry for its project.
 */
export const OPERATION_ROLES = Object.freeze({
  'session.create': ['vscode'],
  'session.list': ['vscode'],
  'session.get': ['vscode', 'devtools'],
  'session.question': ['vscode'],
  'session.end': ['vscode'],
  'capture.start': ['vscode', 'devtools'],
  'capture.stop': ['vscode', 'devtools'],
  'panel.data': ['vscode', 'devtools'],
  'panel.get': ['vscode', 'devtools'],
  'panel.getById': ['vscode', 'devtools'],
  'modifications.list': ['vscode', 'devtools'],
  'telemetry.event': ['server-agent'],
  'devServer.launch': ['vscode'],
  'devServer.stop': ['vscode'],
  'pair.start': ['vscode'],
} as const satisfies Readonly<Record<AuthenticatedOperation, readonly PrincipalRole[]>>);

/** {@link isAuthExemptOperation} as a type guard over the operation vocabulary. */
function isExemptOperation(operation: HttpOperationId): operation is AuthExemptOperation {
  return isAuthExemptOperation(operation);
}

/* -------------------------------------------------------------------------------------------------
 * The origin policy
 * ---------------------------------------------------------------------------------------------- */

/**
 * What an `Origin` value was judged to be.
 *
 * - `absent` — no header (or an empty one): a Node client.
 * - `chrome-extension` — the Chrome extension with `extensionId`.
 * - `vscode-webview` — a VS Code webview.
 * - `refused` — every web origin, `file:`, `data:`, `null`, and anything
 *   malformed.
 */
export type OriginClass =
  | { readonly kind: 'absent' }
  | { readonly kind: 'chrome-extension'; readonly extensionId: string }
  | { readonly kind: 'vscode-webview' }
  | { readonly kind: 'refused' };

const ABSENT_ORIGIN: OriginClass = Object.freeze({ kind: 'absent' });
const VSCODE_WEBVIEW_ORIGIN: OriginClass = Object.freeze({ kind: 'vscode-webview' });
const REFUSED_ORIGIN: OriginClass = Object.freeze({ kind: 'refused' });

/** Whether a value contains whitespace, a C0 control character or DEL. */
function hasForbiddenOriginCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= HIGHEST_CONTROL_OR_SPACE_CODE_UNIT || unit === DELETE_CODE_UNIT) {
      return true;
    }
  }
  return WHITESPACE.test(value);
}

/**
 * Judges an `Origin` header value against the accepted shapes of AAP §0.5.6.
 *
 * Parsed with `URL` and compared on the parsed protocol, never by prefix, so a
 * host such as `chrome-extension.evil.example` or a value such as
 * `chrome-extension://id@evil.example` cannot pass. An accepted extension or
 * webview origin must be exactly `scheme://host`: no credentials, port, path
 * beyond `/`, query or fragment, and no whitespace or control character
 * anywhere.
 *
 * @param origin The raw header value, or `undefined` when absent.
 * @returns The classification.
 */
export function classifyOrigin(origin: string | undefined): OriginClass {
  if (origin === undefined || origin === '') {
    return ABSENT_ORIGIN;
  }
  if (hasForbiddenOriginCharacter(origin)) {
    return REFUSED_ORIGIN;
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return REFUSED_ORIGIN;
  }

  const bare =
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    (parsed.pathname === '' || parsed.pathname === '/') &&
    parsed.search === '' &&
    parsed.hash === '';
  if (!bare) {
    return REFUSED_ORIGIN;
  }

  if (parsed.protocol === 'chrome-extension:' && EXTENSION_ID_PATTERN.test(parsed.hostname)) {
    return Object.freeze({ kind: 'chrome-extension', extensionId: parsed.hostname });
  }
  if (parsed.protocol === 'vscode-webview:' && WEBVIEW_HOST_PATTERN.test(parsed.hostname)) {
    return VSCODE_WEBVIEW_ORIGIN;
  }
  return REFUSED_ORIGIN;
}

/**
 * Whether an `Origin` value is one this service accepts at all: absent,
 * `chrome-extension://<id>` or `vscode-webview://<id>`. Every `http:`/`https:`
 * origin, `file:`, `data:`, `null` and every unparseable value is refused.
 *
 * @param origin The raw header value, or `undefined` when absent.
 * @returns `true` for an accepted origin.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return classifyOrigin(origin).kind !== 'refused';
}

/**
 * Whether a credential of this principal's role may be presented from this
 * origin: editor credentials from Node or a VS Code webview, DevTools
 * credentials only from the extension they were issued to, server-agent
 * credentials only from Node.
 */
function originPermitsPrincipal(origin: OriginClass, principal: Principal): boolean {
  switch (principal.role) {
    case 'vscode':
      return origin.kind === 'absent' || origin.kind === 'vscode-webview';
    case 'devtools':
      return (
        origin.kind === 'chrome-extension' && origin.extensionId === principal.scope.extensionId
      );
    case 'server-agent':
      return origin.kind === 'absent';
  }
}

/* -------------------------------------------------------------------------------------------------
 * Paths, digests and headers
 * ---------------------------------------------------------------------------------------------- */

/**
 * A project root or workspace folder in the product's one spelling — absolute,
 * normalised POSIX — or `undefined` when the value is not an absolute path this
 * product can contain other paths against.
 *
 * A network-share prefix (`//server/share`) is refused rather than normalised,
 * because normalisation would silently turn it into a local root; a NUL byte is
 * refused because no filesystem path contains one.
 */
function normalizeRoot(path: string): string | undefined {
  if (path.length === 0 || path.includes('\u0000')) {
    return undefined;
  }
  const posix = toPosix(path);
  if (posix.startsWith('//')) {
    return undefined;
  }
  if (!isAbsolutePosix(posix) && !isWindowsAbsolute(posix)) {
    return undefined;
  }
  const normalized = normalizePosix(posix);
  return isAbsolutePosix(normalized) || isWindowsAbsolute(normalized) ? normalized : undefined;
}

/** Whether two normalised roots name the same directory, by the shared containment predicate. */
function sameRoot(left: string, right: string): boolean {
  return isWithin(left, right) && isWithin(right, left);
}

/**
 * Compares two hex digests in constant time. Digests of different lengths are
 * unequal without a comparison, which reveals only the length of a value both
 * sides already know is 64 characters.
 */
function digestsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** The outcome of reading one header from a {@link HeaderSource}. */
type HeaderRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'single'; readonly value: string }
  | { readonly kind: 'ambiguous' };

/**
 * Reads a header by its lower-case name. A header sent more than once — two
 * record keys differing only in case, an array of values — is ambiguous, and an
 * ambiguous credential is refused rather than guessed at. (A WHATWG `Headers`
 * object joins repeated values with `", "`, which the bearer parser refuses for
 * the same reason.)
 */
function readHeader(headers: HeaderSource, name: string): HeaderRead {
  if (headers instanceof Headers) {
    const value = headers.get(name);
    return value === null ? { kind: 'absent' } : { kind: 'single', value };
  }

  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name || value === undefined) {
      continue;
    }
    if (typeof value === 'string') {
      values.push(value);
    } else {
      values.push(...value);
    }
  }
  if (values.length === 0) {
    return { kind: 'absent' };
  }
  const [only] = values;
  return values.length === 1 && only !== undefined
    ? { kind: 'single', value: only }
    : { kind: 'ambiguous' };
}

/**
 * The bounds a presented credential must satisfy before it is hashed: protocol's
 * own token field schema, so the service and every client agree on them
 * without either restating a number.
 */
const presentedCredentialSchema = clientHelloPayloadSchema.shape.token;

/** Protocol's bounds for an announced project root, reused for stored scopes. */
const projectRootFieldSchema = clientHelloPayloadSchema.shape.projectRoot.unwrap();

/**
 * What an unrecognised key of a rejected `client.hello` is described as.
 *
 * Deliberately not a safe identifier, so protocol's `describeZodIssues` renders
 * it as its own redaction marker rather than as a name.
 */
const WITHHELD_KEY_NAME = '<withheld>';

/**
 * The issues of a rejected `client.hello` with every unrecognised key name
 * withheld.
 *
 * `describeZodIssues` renders the names of unrecognised keys, because a
 * misspelled field is otherwise indistinguishable from a schema mismatch. In
 * every other frame that is a sound trade; in the one frame that carries a
 * credential, a key *is* payload data and can be the credential itself — a
 * base64url token is a valid identifier and would be echoed, truncated but
 * nearly whole, into the refusal. The path and the issue code still say that an
 * unknown key was sent.
 */
function withholdKeyNames(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  return issues.map((issue) =>
    issue.code === 'unrecognized_keys'
      ? { ...issue, keys: issue.keys.map(() => WITHHELD_KEY_NAME) }
      : issue,
  );
}

/**
 * Extracts the credential from an `Authorization` header value, or `undefined`
 * when the value is not exactly one bearer credential.
 *
 * The scheme is compared case-insensitively (RFC 9110 §11.1) against the prefix
 * protocol's {@link formatBearer} writes; the credential itself must be
 * non-empty and contain no whitespace or comma, and must satisfy protocol's
 * token bounds.
 */
function parseBearer(value: string): string | undefined {
  const prefix = formatBearer('');
  if (value.length <= prefix.length) {
    return undefined;
  }
  if (value.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return undefined;
  }
  const token = value.slice(prefix.length);
  if (BEARER_FORBIDDEN_CHARACTERS.test(token)) {
    return undefined;
  }
  return presentedCredentialSchema.safeParse(token).success ? token : undefined;
}

/** Whether this host enforces POSIX ownership and permission bits. */
function isPosixHost(): boolean {
  return typeof process.getuid === 'function';
}

/* -------------------------------------------------------------------------------------------------
 * Stored shapes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `scope` column's JSON text, one shape per role.
 *
 * The editor's workspace folders are deliberately absent: they belong to a live
 * connection's announcement, never to the stored credential.
 */
const storedScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('machine-user') }),
  z.strictObject({
    kind: z.literal('extension'),
    extensionId: z.string().regex(EXTENSION_ID_PATTERN),
  }),
  z.strictObject({ kind: z.literal('project'), projectRoot: projectRootFieldSchema }),
]);

/** A stored scope. */
type StoredScope = z.infer<typeof storedScopeSchema>;

/** The editor credential's stored scope, the same for every editor credential. */
const MACHINE_USER_STORED_SCOPE: StoredScope = Object.freeze({ kind: 'machine-user' });

/** One `credentials` row as `node:sqlite` returns it. */
const credentialRowSchema = z.object({
  token_hash: z.string(),
  role: z.enum(CREDENTIAL_ROLES),
  scope: z.string(),
  issued_at: z.number().int(),
  expires_at: z.number().int().nullable(),
});

/** A validated `credentials` row. */
type CredentialRow = z.infer<typeof credentialRowSchema>;

/** One `pairing_codes` row as `node:sqlite` returns it. */
const pairingRowSchema = z.object({
  code_hash: z.string(),
  expires_at: z.number().int(),
  used: z.number().int(),
});

/**
 * The `$DEBUGGEN_HOME/auth.json` record: the editor credential in plaintext,
 * for the VS Code extension host, which runs as the same account and reads the
 * file directly (AAP §0.5.6). Written `0600` by this module only.
 */
export const authFileSchema = z.strictObject({
  version: z.literal(AUTH_FILE_VERSION),
  token: presentedCredentialSchema,
  issuedAt: z.number().int().nonnegative(),
});

/** A validated `auth.json` record. ⚠️ Holds the editor credential in plaintext. */
export type AuthFileRecord = z.infer<typeof authFileSchema>;

/**
 * Every statement this module runs. Constant text only: values are bound
 * parameters, so no credential digest, code digest or scope ever appears in a
 * statement, a cache key or an error (see `Store.statement`).
 */
const SQL = Object.freeze({
  selectCredential:
    'SELECT token_hash, role, scope, issued_at, expires_at FROM credentials WHERE token_hash = ?',
  selectCredentialsByRole:
    'SELECT token_hash, role, scope, issued_at, expires_at FROM credentials WHERE role = ?',
  insertCredential:
    'INSERT INTO credentials (token_hash, role, scope, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  deleteCredential: 'DELETE FROM credentials WHERE token_hash = ?',
  deleteCredentialsByRole: 'DELETE FROM credentials WHERE role = ?',
  deleteOtherCredentialsOfRole: 'DELETE FROM credentials WHERE role = ? AND token_hash <> ?',
  deleteExpiredCredentials:
    'DELETE FROM credentials WHERE expires_at IS NOT NULL AND expires_at <= ?',
  deleteAllCredentials: 'DELETE FROM credentials',
  insertPairingCode:
    'INSERT OR IGNORE INTO pairing_codes (code_hash, expires_at, used) VALUES (?, ?, 0)',
  selectPairingCode: 'SELECT code_hash, expires_at, used FROM pairing_codes WHERE code_hash = ?',
  redeemPairingCode:
    'UPDATE pairing_codes SET used = used + 1 WHERE code_hash = ? AND used < ? AND expires_at > ?',
  deleteExpiredPairingCodes: 'DELETE FROM pairing_codes WHERE expires_at <= ?',
  deleteAllPairingCodes: 'DELETE FROM pairing_codes',
});

/** Parses the `scope` column, or `undefined` when it is not a scope this module wrote. */
function parseStoredScope(text: string): StoredScope | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = storedScopeSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** The errno `code` of a filesystem failure, when it carries one. */
function errnoCodeOf(cause: unknown): string | undefined {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const { code } = cause;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * A filesystem failure on the editor credential file, keeping a policy refusal
 * from `@debuggen/shared/node` (`FS_UNSAFE_PATH`) as it is and wrapping a raw
 * errno failure. The file's contents never enter the error.
 */
function credentialFileFailure(cause: unknown, operation: string): DebuggenError {
  if (DebuggenError.is(cause)) {
    return cause;
  }
  const errno = errnoCodeOf(cause);
  return new DebuggenError('INTERNAL', `The editor credential file could not be ${operation}.`, {
    hint: 'Check that $DEBUGGEN_HOME is a private directory owned by this account.',
    details: { operation, ...(errno === undefined ? {} : { errno }) },
    cause,
  });
}

/* -------------------------------------------------------------------------------------------------
 * The service
 * ---------------------------------------------------------------------------------------------- */

/**
 * The access boundary's operations. Every method returns a `Result` and none
 * throws; see the module documentation for the rules each one applies.
 */
export interface AuthService {
  /**
   * The start-up path: adopt the editor credential in `auth.json`, or mint one.
   *
   * Safe to call once per start and idempotent across restarts. A file whose
   * token has no live row (a store purged under it) is re-registered; a file
   * that is unreadable as a record, or readable by another account, is
   * replaced by a freshly minted credential. Expired credentials are swept.
   */
  ensureEditorCredential(): Result<EditorCredentialState, DebuggenError>;

  /** Issues a DevTools credential scoped to one extension id. */
  issueDevtoolsCredential(extensionId: string): Result<IssuedCredential, DebuggenError>;

  /**
   * Issues a server-agent credential scoped to one project root, for the
   * dev-server launcher to hand to the process it starts.
   */
  issueServerAgentCredential(
    request: ServerAgentCredentialRequest,
  ): Result<IssuedCredential, DebuggenError>;

  /**
   * Revokes every server-agent credential scoped to `projectRoot` — what the
   * launcher calls when the process it started exits.
   *
   * @returns How many credentials were revoked.
   */
  revokeServerAgentCredentials(projectRoot: string): Result<number, DebuggenError>;

  /** {@link isAllowedOrigin}, for callers that hold the service. */
  isAllowedOrigin(origin: string | undefined): boolean;

  /**
   * The HTTP middleware core: origin policy first, then the exemption, then the
   * bearer credential and the operation's role table.
   *
   * @returns The principal, or `null` for an auth-exempt operation.
   */
  authorizeHttpRequest(request: HttpAuthorizationRequest): Result<Principal | null, DebuggenError>;

  /**
   * Authenticates a `client.hello`: payload shape, protocol version, origin,
   * credential, and the claims the hello makes against the credential's role
   * and scope. An editor principal returned here carries the workspace folder
   * its hello announced.
   */
  authorizeHello(request: HelloAuthorizationRequest): Result<Principal, DebuggenError>;

  /**
   * Records an editor connection's announced workspace folders so HTTP requests
   * presenting the same credential may act under them, until `release()`.
   */
  announceWorkspace(principal: Principal): Result<WorkspaceAnnouncement, DebuggenError>;

  /** Mints a one-time pairing code, stored only as its digest. */
  startPairing(): Result<PairingCode, DebuggenError>;

  /**
   * Redeems a pairing code for a DevTools credential scoped to the redeeming
   * extension's id: single use, time-limited and rate-limited.
   */
  completePairing(request: PairingCompletionRequest): Result<IssuedCredential, DebuggenError>;

  /**
   * Deletes every credential and pairing code, regenerates `auth.json`, and
   * closes every open socket with `WS_CLOSE_UNAUTHORIZED` through the injected
   * revoker. Paired Chrome extensions must pair again and launched dev servers
   * must be relaunched (AAP §0.5.6).
   */
  rotateAll(): Result<RotationOutcome, DebuggenError>;

  /** Drops the in-memory lockout ledger and announcements. Owns no timer or socket. */
  close(): void;
}

/** What {@link createAuthService} is built from. */
export interface AuthServiceDeps {
  /** The open session store holding the `credentials` and `pairing_codes` tables. */
  readonly store: Store;
  /** Where the editor credential file lives, inside the state root. */
  readonly config: Pick<ServiceConfig, 'authFilePath' | 'debuggenHome'>;
  /** Where decisions are logged. Credentials never are. */
  readonly logger: Logger;
  /** Closes every socket on rotation; `clients.ts` satisfies it. */
  readonly revoker?: ConnectionRevoker | undefined;
  /** The clock, in epoch milliseconds. Defaults to `nowEpochMs`. */
  readonly now?: (() => number) | undefined;
  /** The randomness source. Defaults to `node:crypto`'s CSPRNG. */
  readonly randomBytes?: ((size: number) => Uint8Array) | undefined;
}

/** One origin's (or the global) pairing-failure record. */
interface PairingLedgerEntry {
  /** Failures since the last success, decayed after a quiet lockout window. */
  failures: number;
  /** When the most recent failure happened. */
  lastFailureAt: number;
  /** Until when attempts are refused; `0` when not locked. */
  lockedUntil: number;
}

/** A fresh ledger entry. */
function newLedgerEntry(): PairingLedgerEntry {
  return { failures: 0, lastFailureAt: Number.NEGATIVE_INFINITY, lockedUntil: 0 };
}

/** Whether a normalised code has the exported length and uses only the exported alphabet. */
function isWellFormedPairingCode(code: string): boolean {
  if (code.length !== PAIRING_CODE_LENGTH) {
    return false;
  }
  for (const character of code) {
    if (!PAIRING_CODE_ALPHABET.includes(character)) {
      return false;
    }
  }
  return true;
}

/** The resolved dependencies {@link CredentialAuthority} runs on. */
interface CredentialAuthorityInit {
  readonly store: Store;
  readonly authFilePath: string;
  readonly debuggenHome: string;
  readonly logger: Logger;
  readonly revoker: ConnectionRevoker | undefined;
  readonly clock: () => number;
  readonly random: (size: number) => Uint8Array;
}

/**
 * The {@link AuthService} implementation. Not exported: {@link createAuthService}
 * validates its dependencies first.
 */
class CredentialAuthority implements AuthService {
  readonly #store: Store;

  readonly #authFilePath: string;

  readonly #debuggenHome: string;

  readonly #logger: Logger;

  readonly #revoker: ConnectionRevoker | undefined;

  readonly #clock: () => number;

  readonly #random: (size: number) => Uint8Array;

  /** Pairing failures per presenting origin, in insertion (oldest-first) order. */
  readonly #ledger = new Map<string, PairingLedgerEntry>();

  /** Pairing failures across every origin. */
  #globalLedger: PairingLedgerEntry = newLedgerEntry();

  /** Announced workspace folders per editor credential digest, reference-counted. */
  readonly #announcements = new Map<string, Map<string, number>>();

  constructor(init: CredentialAuthorityInit) {
    this.#store = init.store;
    this.#authFilePath = init.authFilePath;
    this.#debuggenHome = init.debuggenHome;
    this.#logger = init.logger;
    this.#revoker = init.revoker;
    this.#clock = init.clock;
    this.#random = init.random;
  }

  /* ----------------------------------------------------------------------------------------------
   * Primitives
   * ------------------------------------------------------------------------------------------- */

  /** The current instant as a whole epoch millisecond, which is what the INTEGER columns store. */
  #now(): number {
    return Math.floor(this.#clock());
  }

  /**
   * Runs store work, turning a throw into an `Err`. A `DebuggenError` keeps its
   * code (`STORE_ERROR` from the handle, `FS_UNSAFE_PATH` or `INTERNAL` from
   * the credential file); anything else — a raw `node:sqlite` failure — becomes
   * `STORE_ERROR`. Neither statement parameters nor row contents are logged.
   */
  #guard<T>(operation: string, work: () => T): Result<T, DebuggenError> {
    try {
      return ok(work());
    } catch (cause) {
      const error = DebuggenError.is(cause)
        ? cause
        : new DebuggenError(
            'STORE_ERROR',
            'The credential store could not complete the operation.',
            {
              details: { operation },
              cause,
            },
          );
      this.#logger.error('an access-boundary operation failed', {
        operation,
        errorCode: error.code,
      });
      return err(error);
    }
  }

  /** Draws `size` bytes from the injected source, refusing a short or failed draw. */
  #draw(size: number): Result<Uint8Array, DebuggenError> {
    let bytes: Uint8Array;
    try {
      bytes = this.#random(size);
    } catch (cause) {
      return err(
        new DebuggenError('INTERNAL', 'The random source failed while generating a credential.', {
          cause,
        }),
      );
    }
    if (!(bytes instanceof Uint8Array) || bytes.length !== size) {
      return err(
        new DebuggenError(
          'INTERNAL',
          'The random source returned the wrong number of bytes for a credential.',
        ),
      );
    }
    return ok(bytes);
  }

  /** A fresh credential: {@link CREDENTIAL_TOKEN_BYTES} random bytes, base64url. */
  #mintToken(): Result<string, DebuggenError> {
    const bytes = this.#draw(CREDENTIAL_TOKEN_BYTES);
    if (isErr(bytes)) {
      return bytes;
    }
    return ok(Buffer.from(bytes.value).toString('base64url'));
  }

  /**
   * A fresh pairing code: {@link PAIRING_CODE_LENGTH} characters of
   * {@link PAIRING_CODE_ALPHABET}, by rejection sampling so no symbol is more
   * likely than another whatever the alphabet's size.
   */
  #mintPairingCode(): Result<string, DebuggenError> {
    const symbols = PAIRING_CODE_ALPHABET.length;
    const unbiasedLimit = 256 - (256 % symbols);
    let code = '';
    for (
      let batch = 0;
      batch < MAX_GENERATION_ATTEMPTS && code.length < PAIRING_CODE_LENGTH;
      batch += 1
    ) {
      const bytes = this.#draw(PAIRING_CODE_LENGTH * 2);
      if (isErr(bytes)) {
        return bytes;
      }
      for (const byte of bytes.value) {
        if (byte < unbiasedLimit) {
          code += PAIRING_CODE_ALPHABET.charAt(byte % symbols);
          if (code.length === PAIRING_CODE_LENGTH) {
            break;
          }
        }
      }
    }
    return code.length === PAIRING_CODE_LENGTH
      ? ok(code)
      : err(new DebuggenError('INTERNAL', 'The random source could not produce a pairing code.'));
  }

  /** Inserts one credential row. Throws; call inside {@link #guard}. */
  #insertCredential(
    tokenHash: string,
    role: PrincipalRole,
    scope: StoredScope,
    issuedAt: number,
    expiresAt: number | null,
  ): void {
    this.#store
      .statement(SQL.insertCredential)
      .run(tokenHash, role, JSON.stringify(scope), issuedAt, expiresAt);
  }

  /** The workspace folders the credential's live connections announce, sorted and frozen. */
  #announcedFolders(tokenHash: string): readonly string[] {
    const counts = this.#announcements.get(tokenHash);
    return Object.freeze(counts === undefined ? [] : [...counts.keys()].sort());
  }

  /**
   * Builds the principal a validated row describes, refusing a row whose scope
   * is unreadable or does not belong to its role. An editor principal carries
   * the folders currently announced for its credential.
   */
  #principalFromRow(row: CredentialRow): Result<Principal, DebuggenError> {
    const scope = parseStoredScope(row.scope);
    const base = {
      tokenHash: row.token_hash,
      issuedAt: row.issued_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    };

    if (row.role === 'vscode' && scope?.kind === 'machine-user') {
      const principal: EditorPrincipal = {
        ...base,
        role: 'vscode',
        scope: Object.freeze({
          kind: 'machine-user',
          workspaceFolders: this.#announcedFolders(row.token_hash),
        }),
      };
      return ok(Object.freeze(principal));
    }
    if (row.role === 'devtools' && scope?.kind === 'extension') {
      const principal: DevtoolsPrincipal = {
        ...base,
        role: 'devtools',
        scope: Object.freeze({ kind: 'extension', extensionId: scope.extensionId }),
      };
      return ok(Object.freeze(principal));
    }
    if (row.role === 'server-agent' && scope?.kind === 'project') {
      const projectRoot = normalizeRoot(scope.projectRoot);
      if (projectRoot !== undefined) {
        const principal: ServerAgentPrincipal = {
          ...base,
          role: 'server-agent',
          scope: Object.freeze({ kind: 'project', projectRoot }),
        };
        return ok(Object.freeze(principal));
      }
    }

    this.#logger.error('a stored credential record does not match its role; it is refused', {
      role: row.role,
    });
    return refuse('corrupt-credential');
  }

  /**
   * Resolves a presented credential to the principal its stored row describes:
   * bounds, digest lookup, constant-time digest comparison, row validation,
   * expiry, and finally whether the credential's role may be presented from
   * this origin.
   */
  #authenticate(token: string, origin: OriginClass): Result<Principal, DebuggenError> {
    if (!presentedCredentialSchema.safeParse(token).success) {
      return refuse('malformed-credential');
    }
    const tokenHash = sha256Hex(token);
    const raw = this.#guard('read-credential', () =>
      this.#store.statement(SQL.selectCredential).get(tokenHash),
    );
    if (isErr(raw)) {
      return raw;
    }
    if (raw.value === undefined) {
      return refuse('unknown-credential');
    }
    const row = credentialRowSchema.safeParse(raw.value);
    if (!row.success) {
      this.#logger.error('a stored credential record is not valid; it is refused');
      return refuse('corrupt-credential');
    }
    if (!digestsEqual(row.data.token_hash, tokenHash)) {
      return refuse('unknown-credential');
    }
    if (row.data.expires_at !== null && row.data.expires_at <= this.#now()) {
      return refuse('expired-credential');
    }
    const principal = this.#principalFromRow(row.data);
    if (isErr(principal)) {
      return principal;
    }
    if (!originPermitsPrincipal(origin, principal.value)) {
      return refuse('origin-not-permitted-for-role');
    }
    return principal;
  }

  /** Logs a refusal by its reason; never by anything the client presented. */
  #logRefusal(message: string, error: DebuggenError, fields: Record<string, unknown> = {}): void {
    this.#logger.warn(message, {
      ...fields,
      reason: authFailureReasonOf(error) ?? 'not-a-refusal',
      errorCode: error.code,
    });
  }

  /* ----------------------------------------------------------------------------------------------
   * The editor credential and auth.json
   * ------------------------------------------------------------------------------------------- */

  /** Creates or verifies the private directory `auth.json` lives in, bounded by the state root. */
  #prepareAuthDirectory(): Result<void, DebuggenError> {
    try {
      ensureSecureDir(dirname(this.#authFilePath), { upTo: this.#debuggenHome });
      return ok(undefined);
    } catch (cause) {
      const error = credentialFileFailure(cause, 'placed in a private directory');
      this.#logger.error('the editor credential directory is not safe to use', {
        errorCode: error.code,
      });
      return err(error);
    }
  }

  /**
   * Reads `auth.json` without following a link at its final component.
   *
   * @returns The record, or `undefined` when there is none to adopt: the file is
   * absent, is readable by another account (so its token may have been read and
   * is not trusted), or is not a record this module wrote. Only an unsafe path —
   * a link, a foreign owner, a second hard link — or an unreadable file is an
   * `Err`, because those need the developer rather than a new credential.
   */
  #readAuthFile(): Result<AuthFileRecord | undefined, DebuggenError> {
    let state;
    try {
      state = inspectPrivateFileNoFollow(this.#authFilePath);
    } catch (cause) {
      return err(credentialFileFailure(cause, 'inspected'));
    }
    if (state === undefined) {
      return ok(undefined);
    }
    if (isPosixHost() && (state.mode & GROUP_OR_OTHER_PERMISSION_BITS) !== 0) {
      this.#logger.warn(
        'the editor credential file was readable by other accounts; its credential is discarded and a new one issued',
        { mode: state.mode },
      );
      return ok(undefined);
    }

    let bytes: Buffer;
    try {
      bytes = readFileNoFollow(this.#authFilePath);
    } catch (cause) {
      if (errnoCodeOf(cause) === 'ENOENT') {
        return ok(undefined);
      }
      return err(credentialFileFailure(cause, 'read'));
    }

    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      this.#logger.warn('the editor credential file is not valid JSON; a new credential is issued');
      return ok(undefined);
    }
    const record = authFileSchema.safeParse(json);
    if (!record.success) {
      this.#logger.warn(
        'the editor credential file is not a record this service wrote; a new credential is issued',
      );
      return ok(undefined);
    }
    return ok(record.data);
  }

  /**
   * Writes `auth.json` atomically at `0600` and confirms the result is private.
   * Throws; called inside a store transaction so a failed write rolls the row
   * back with it.
   */
  #writeAuthFile(record: AuthFileRecord): void {
    try {
      writeSecureFileAtomic(this.#authFilePath, `${JSON.stringify(record, null, 2)}\n`, {
        upTo: this.#debuggenHome,
      });
    } catch (cause) {
      throw credentialFileFailure(cause, 'written');
    }

    let state;
    try {
      state = inspectPrivateFileNoFollow(this.#authFilePath);
    } catch (cause) {
      throw credentialFileFailure(cause, 'verified after writing');
    }
    if (state === undefined || (isPosixHost() && state.mode !== SECURE_FILE_MODE)) {
      throw new DebuggenError(
        'FS_UNSAFE_PATH',
        'The editor credential file was not left private after it was written.',
        {
          hint: 'Check that $DEBUGGEN_HOME is a private directory owned by this account.',
          details: { operation: 'verify-auth-file' },
        },
      );
    }
  }

  /**
   * Adopts the credential an existing `auth.json` holds.
   *
   * @returns The editor principal, or `undefined` when the file's credential
   * cannot be adopted (its row belongs to another role, is corrupt or has
   * expired) and a new one must be minted.
   */
  #adoptEditorToken(record: AuthFileRecord): Result<EditorPrincipal | undefined, DebuggenError> {
    const tokenHash = sha256Hex(record.token);
    const raw = this.#guard('read-editor-credential', () =>
      this.#store.statement(SQL.selectCredential).get(tokenHash),
    );
    if (isErr(raw)) {
      return raw;
    }

    if (raw.value === undefined) {
      // A stale file: the store was purged or replaced under it. The file is the
      // only holder of this credential, so it is registered again rather than
      // replaced, and every other editor row — orphans whose token nobody holds —
      // goes with the transaction.
      const registered = this.#guard('reregister-editor-credential', () => {
        this.#store.transaction(() => {
          this.#store.statement(SQL.deleteCredentialsByRole).run('vscode');
          this.#insertCredential(
            tokenHash,
            'vscode',
            MACHINE_USER_STORED_SCOPE,
            record.issuedAt,
            null,
          );
        });
      });
      if (isErr(registered)) {
        return registered;
      }
      this.#logger.info('re-registered the editor credential held in auth.json');
      return ok(this.#editorPrincipal(tokenHash, record.issuedAt));
    }

    const row = credentialRowSchema.safeParse(raw.value);
    if (!row.success) {
      return ok(undefined);
    }
    const expired = row.data.expires_at !== null && row.data.expires_at <= this.#now();
    const scope = parseStoredScope(row.data.scope);
    if (row.data.role !== 'vscode' || scope?.kind !== 'machine-user' || expired) {
      this.#logger.warn(
        'the credential in auth.json is not a live editor credential; a new one is issued',
      );
      return ok(undefined);
    }

    const pruned = this.#guard('prune-editor-credentials', () =>
      this.#store.statement(SQL.deleteOtherCredentialsOfRole).run('vscode', tokenHash),
    );
    if (isErr(pruned)) {
      return pruned;
    }
    return ok(this.#editorPrincipal(tokenHash, row.data.issued_at));
  }

  /** Mints a new editor credential, replacing every editor row and `auth.json` in one transaction. */
  #mintEditorCredential(): Result<EditorPrincipal, DebuggenError> {
    const token = this.#mintToken();
    if (isErr(token)) {
      return token;
    }
    const tokenHash = sha256Hex(token.value);
    const issuedAt = this.#now();
    const record: AuthFileRecord = { version: AUTH_FILE_VERSION, token: token.value, issuedAt };

    const minted = this.#guard('mint-editor-credential', () => {
      this.#store.transaction(() => {
        this.#store.statement(SQL.deleteCredentialsByRole).run('vscode');
        this.#insertCredential(tokenHash, 'vscode', MACHINE_USER_STORED_SCOPE, issuedAt, null);
        this.#writeAuthFile(record);
      });
    });
    if (isErr(minted)) {
      return minted;
    }
    this.#logger.info('issued a new editor credential and wrote auth.json');
    return ok(this.#editorPrincipal(tokenHash, issuedAt));
  }

  /** The editor principal for a digest, with the folders currently announced for it. */
  #editorPrincipal(tokenHash: string, issuedAt: number): EditorPrincipal {
    return Object.freeze({
      role: 'vscode',
      scope: Object.freeze({
        kind: 'machine-user',
        workspaceFolders: this.#announcedFolders(tokenHash),
      }),
      tokenHash,
      issuedAt,
    });
  }

  ensureEditorCredential(): Result<EditorCredentialState, DebuggenError> {
    const prepared = this.#prepareAuthDirectory();
    if (isErr(prepared)) {
      return prepared;
    }

    const swept = this.#guard('sweep-expired-credentials', () =>
      this.#store.statement(SQL.deleteExpiredCredentials).run(this.#now()),
    );
    if (isErr(swept)) {
      return swept;
    }

    const existing = this.#readAuthFile();
    if (isErr(existing)) {
      return existing;
    }
    if (existing.value !== undefined) {
      const adopted = this.#adoptEditorToken(existing.value);
      if (isErr(adopted)) {
        return adopted;
      }
      if (adopted.value !== undefined) {
        return ok(Object.freeze({ principal: adopted.value, created: false }));
      }
    }

    const minted = this.#mintEditorCredential();
    if (isErr(minted)) {
      return minted;
    }
    return ok(Object.freeze({ principal: minted.value, created: true }));
  }

  /* ----------------------------------------------------------------------------------------------
   * Issuing and revoking
   * ------------------------------------------------------------------------------------------- */

  issueDevtoolsCredential(extensionId: string): Result<IssuedCredential, DebuggenError> {
    if (!EXTENSION_ID_PATTERN.test(extensionId)) {
      return refuse(
        'pairing-origin-required',
        'A DevTools credential can only be issued to a well-formed Chrome extension id.',
      );
    }
    const token = this.#mintToken();
    if (isErr(token)) {
      return token;
    }
    const tokenHash = sha256Hex(token.value);
    const issuedAt = this.#now();
    const stored = this.#guard('issue-devtools-credential', () => {
      this.#insertCredential(
        tokenHash,
        'devtools',
        { kind: 'extension', extensionId },
        issuedAt,
        null,
      );
    });
    if (isErr(stored)) {
      return stored;
    }
    this.#logger.info('issued a DevTools credential', { extensionId });
    return ok(Object.freeze({ token: token.value }));
  }

  issueServerAgentCredential(
    request: ServerAgentCredentialRequest,
  ): Result<IssuedCredential, DebuggenError> {
    const projectRoot = normalizeRoot(request.projectRoot);
    if (projectRoot === undefined || !projectRootFieldSchema.safeParse(projectRoot).success) {
      return err(
        new DebuggenError(
          'PROJECT_NOT_FOUND',
          'A server-agent credential must be scoped to an absolute project root.',
          { details: { problem: 'project-root-not-absolute' } },
        ),
      );
    }

    const issuedAt = this.#now();
    let expiresAt: number | null = null;
    if (request.expiresAt !== undefined) {
      const requested = Math.floor(request.expiresAt);
      if (!Number.isSafeInteger(requested) || requested <= issuedAt) {
        return err(
          new DebuggenError(
            'INTERNAL',
            'A server-agent credential expiry must be a time in the future.',
            { details: { problem: 'expiry-not-in-future' } },
          ),
        );
      }
      expiresAt = requested;
    }

    const token = this.#mintToken();
    if (isErr(token)) {
      return token;
    }
    const tokenHash = sha256Hex(token.value);
    const stored = this.#guard('issue-server-agent-credential', () => {
      this.#insertCredential(
        tokenHash,
        'server-agent',
        { kind: 'project', projectRoot },
        issuedAt,
        expiresAt,
      );
    });
    if (isErr(stored)) {
      return stored;
    }
    this.#logger.info('issued a server-agent credential', {
      projectRoot,
      expires: expiresAt !== null,
    });
    return ok(
      Object.freeze(
        expiresAt === null ? { token: token.value } : { token: token.value, expiresAt },
      ),
    );
  }

  revokeServerAgentCredentials(projectRoot: string): Result<number, DebuggenError> {
    const root = normalizeRoot(projectRoot);
    if (root === undefined) {
      return err(
        new DebuggenError(
          'PROJECT_NOT_FOUND',
          'Server-agent credentials are revoked by an absolute project root.',
          { details: { problem: 'project-root-not-absolute' } },
        ),
      );
    }

    const revoked = this.#guard('revoke-server-agent-credentials', () =>
      this.#store.transaction(() => {
        const rows = this.#store.statement(SQL.selectCredentialsByRole).all('server-agent');
        let count = 0;
        for (const raw of rows) {
          const row = credentialRowSchema.safeParse(raw);
          if (!row.success) {
            continue;
          }
          const scope = parseStoredScope(row.data.scope);
          if (scope?.kind !== 'project') {
            continue;
          }
          const scopedRoot = normalizeRoot(scope.projectRoot);
          if (scopedRoot !== undefined && sameRoot(scopedRoot, root)) {
            this.#store.statement(SQL.deleteCredential).run(row.data.token_hash);
            count += 1;
          }
        }
        return count;
      }),
    );
    if (isErr(revoked)) {
      return revoked;
    }
    this.#logger.info('revoked server-agent credentials for a project', {
      projectRoot: root,
      revoked: revoked.value,
    });
    return revoked;
  }

  isAllowedOrigin(origin: string | undefined): boolean {
    return isAllowedOrigin(origin);
  }

  /* ----------------------------------------------------------------------------------------------
   * Authenticating requests and connections
   * ------------------------------------------------------------------------------------------- */

  authorizeHttpRequest(request: HttpAuthorizationRequest): Result<Principal | null, DebuggenError> {
    const decision = this.#decideHttpRequest(request);
    if (isErr(decision)) {
      this.#logRefusal('refused an HTTP request', decision.error, { operation: request.operation });
    }
    return decision;
  }

  /** {@link authorizeHttpRequest} without the logging, in the order AAP §0.5.6 fixes. */
  #decideHttpRequest(request: HttpAuthorizationRequest): Result<Principal | null, DebuggenError> {
    // 1. The origin policy, before anything else — the exempt operations refuse
    //    web origins exactly like every other route.
    const origin = classifyOrigin(request.origin);
    if (origin.kind === 'refused') {
      return refuse('forbidden-origin');
    }

    // 2. The exemption: no bearer credential for `health` and `pair.complete`.
    const { operation } = request;
    if (isExemptOperation(operation)) {
      return ok(null);
    }

    // 3. Exactly one well-formed bearer credential.
    const header = readHeader(request.headers, AUTHORIZATION_HEADER);
    if (header.kind === 'absent') {
      return refuse('missing-credential');
    }
    if (header.kind === 'ambiguous') {
      return refuse('malformed-credential');
    }
    const token = parseBearer(header.value);
    if (token === undefined) {
      return refuse('malformed-credential');
    }

    // 4. The stored row decides the principal, and its role must be one the
    //    operation admits.
    const principal = this.#authenticate(token, origin);
    if (isErr(principal)) {
      return principal;
    }
    const permitted: readonly PrincipalRole[] = OPERATION_ROLES[operation];
    if (!permitted.includes(principal.value.role)) {
      return refuse('role-not-permitted');
    }
    return principal;
  }

  authorizeHello(request: HelloAuthorizationRequest): Result<Principal, DebuggenError> {
    const decision = this.#decideHello(request);
    if (isErr(decision)) {
      this.#logRefusal('refused a client.hello', decision.error);
    } else {
      this.#logger.debug('authenticated a client.hello', { role: decision.value.role });
    }
    return decision;
  }

  /** {@link authorizeHello} without the logging. */
  #decideHello(request: HelloAuthorizationRequest): Result<Principal, DebuggenError> {
    const origin = classifyOrigin(request.origin);
    if (origin.kind === 'refused') {
      return refuse('forbidden-origin');
    }

    // The failure text is built from issue paths and codes only, never from the
    // rejected value — nor from the names of unknown keys, which are payload
    // data too — so a malformed hello cannot echo the credential it carried.
    const parsed = clientHelloPayloadSchema.safeParse(request.payload);
    if (!parsed.success) {
      return refuse(
        'hello-invalid',
        `The first frame was not a well-formed client.hello: ${describeZodIssues(withholdKeyNames(parsed.error.issues))}.`,
      );
    }
    const hello = parsed.data;

    if (!isCompatibleProtocolVersion(hello.version)) {
      return refuse('protocol-incompatible');
    }

    const requiredRole = roleForClientKind(hello.client);
    if (requiredRole === undefined) {
      return refuse(
        'client-kind-mismatch',
        'The page agent holds no credential of its own; its frames are relayed by the DevTools connection of its tab.',
      );
    }

    const resolved = this.#authenticate(hello.token, origin);
    if (isErr(resolved)) {
      return resolved;
    }
    const principal = resolved.value;
    if (!clientKindSatisfiesRole(hello.client, principal.role)) {
      return refuse('client-kind-mismatch');
    }

    switch (principal.role) {
      case 'vscode': {
        if (hello.tabId !== undefined) {
          return refuse(
            'hello-claim-mismatch',
            'An editor connection has no tab; a client.hello from one must not name a tabId.',
          );
        }
        let workspaceFolders: readonly string[] = Object.freeze([]);
        if (hello.projectRoot !== undefined) {
          const announced = normalizeRoot(hello.projectRoot);
          if (announced === undefined) {
            return refuse(
              'hello-claim-mismatch',
              'An editor connection must announce its workspace folder as an absolute path.',
            );
          }
          workspaceFolders = Object.freeze([announced]);
        }
        const editor: EditorPrincipal = {
          ...principal,
          scope: Object.freeze({ kind: 'machine-user', workspaceFolders }),
        };
        return ok(Object.freeze(editor));
      }
      case 'devtools':
        if (hello.projectRoot !== undefined) {
          return refuse(
            'hello-claim-mismatch',
            'A DevTools connection has no project root of its own; its session reaches it through the tab binding.',
          );
        }
        return ok(principal);
      case 'server-agent': {
        if (hello.tabId !== undefined) {
          return refuse(
            'hello-claim-mismatch',
            'A dev-server connection has no tab; a client.hello from one must not name a tabId.',
          );
        }
        if (hello.projectRoot !== undefined) {
          const claimed = normalizeRoot(hello.projectRoot);
          if (claimed === undefined || !sameRoot(claimed, principal.scope.projectRoot)) {
            return refuse(
              'hello-claim-mismatch',
              'A dev-server connection announced a project other than the one its credential is scoped to.',
            );
          }
        }
        return ok(principal);
      }
    }
  }

  announceWorkspace(principal: Principal): Result<WorkspaceAnnouncement, DebuggenError> {
    if (principal.role !== 'vscode') {
      return refuse('role-not-permitted', 'Only an editor connection announces workspace folders.');
    }
    const { tokenHash } = principal;
    const folders = principal.scope.workspaceFolders;
    const counts = this.#announcements.get(tokenHash) ?? new Map<string, number>();
    for (const folder of folders) {
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
    if (counts.size > 0) {
      this.#announcements.set(tokenHash, counts);
    }

    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      const current = this.#announcements.get(tokenHash);
      if (current === undefined) {
        return;
      }
      for (const folder of folders) {
        const remaining = (current.get(folder) ?? 0) - 1;
        if (remaining > 0) {
          current.set(folder, remaining);
        } else {
          current.delete(folder);
        }
      }
      if (current.size === 0) {
        this.#announcements.delete(tokenHash);
      }
    };
    return ok(Object.freeze({ release }));
  }

  /* ----------------------------------------------------------------------------------------------
   * Pairing
   * ------------------------------------------------------------------------------------------- */

  startPairing(): Result<PairingCode, DebuggenError> {
    const now = this.#now();
    const expiresAt = now + PAIRING_CODE_TTL_MS;

    const swept = this.#guard('sweep-expired-pairing-codes', () =>
      this.#store.statement(SQL.deleteExpiredPairingCodes).run(now),
    );
    if (isErr(swept)) {
      return swept;
    }

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const code = this.#mintPairingCode();
      if (isErr(code)) {
        return code;
      }
      const codeHash = sha256Hex(code.value);
      const inserted = this.#guard('store-pairing-code', () =>
        Number(this.#store.statement(SQL.insertPairingCode).run(codeHash, expiresAt).changes),
      );
      if (isErr(inserted)) {
        return inserted;
      }
      if (inserted.value === 1) {
        this.#logger.info('issued a pairing code', { expiresAt });
        return ok(Object.freeze({ code: code.value, expiresAt }));
      }
    }
    return err(
      new DebuggenError('INTERNAL', 'A unique pairing code could not be generated.', {
        hint: 'Run "Debug Generator: Pair Chrome" again.',
      }),
    );
  }

  completePairing(request: PairingCompletionRequest): Result<IssuedCredential, DebuggenError> {
    const decision = this.#redeemPairingCode(request);
    if (isErr(decision)) {
      this.#logRefusal('refused a pairing attempt', decision.error);
    }
    return decision;
  }

  /** {@link completePairing} without the logging. */
  #redeemPairingCode(request: PairingCompletionRequest): Result<IssuedCredential, DebuggenError> {
    // The origin decides, before the code is looked at: web origins are refused
    // outright, and only the Chrome extension can redeem, because the extension
    // id in its origin becomes the scope of the credential it receives.
    const origin = classifyOrigin(request.origin);
    if (origin.kind === 'refused') {
      return refuse('forbidden-origin');
    }
    if (origin.kind !== 'chrome-extension') {
      return refuse('pairing-origin-required');
    }
    const { extensionId } = origin;
    const ledgerKey = `chrome-extension://${extensionId}`;
    const now = this.#now();

    // A lockout refuses even the correct code; that is what makes it a lockout.
    if (this.#isLockedOut(ledgerKey, now)) {
      return refuse('pairing-locked');
    }

    const code = request.code.trim().toUpperCase();
    if (!isWellFormedPairingCode(code)) {
      return this.#pairingFailure(ledgerKey, now, 'pairing-invalid');
    }
    const codeHash = sha256Hex(code);

    const raw = this.#guard('read-pairing-code', () =>
      this.#store.statement(SQL.selectPairingCode).get(codeHash),
    );
    if (isErr(raw)) {
      return raw;
    }
    const row = pairingRowSchema.safeParse(raw.value);
    if (raw.value === undefined || !row.success || !digestsEqual(row.data.code_hash, codeHash)) {
      return this.#pairingFailure(ledgerKey, now, 'pairing-invalid');
    }
    if (row.data.used >= PAIRING_CODE_MAX_REDEMPTIONS) {
      return this.#pairingFailure(ledgerKey, now, 'pairing-used');
    }
    if (row.data.expires_at <= now) {
      return this.#pairingFailure(ledgerKey, now, 'pairing-expired');
    }

    const token = this.#mintToken();
    if (isErr(token)) {
      return token;
    }
    const tokenHash = sha256Hex(token.value);

    // Marking the code used and issuing the credential are one transaction, and
    // the UPDATE only succeeds while the code is still unused and unexpired, so
    // two redemptions of one code can never both win — in this process or in
    // another one sharing the database.
    const redeemed = this.#guard('redeem-pairing-code', () =>
      this.#store.transaction(() => {
        const changes = Number(
          this.#store
            .statement(SQL.redeemPairingCode)
            .run(codeHash, PAIRING_CODE_MAX_REDEMPTIONS, now).changes,
        );
        if (changes !== 1) {
          return false;
        }
        this.#insertCredential(
          tokenHash,
          'devtools',
          { kind: 'extension', extensionId },
          now,
          null,
        );
        return true;
      }),
    );
    if (isErr(redeemed)) {
      return redeemed;
    }
    if (!redeemed.value) {
      return this.#pairingFailure(ledgerKey, now, 'pairing-used');
    }

    this.#ledger.delete(ledgerKey);
    this.#logger.info('paired a DevTools client', { extensionId });
    return ok(Object.freeze({ token: token.value }));
  }

  /** Forgets ledger entries that are neither locked nor holding a recent failure. */
  #pruneLedger(now: number): void {
    for (const [key, entry] of this.#ledger) {
      if (entry.lockedUntil <= now && now - entry.lastFailureAt > PAIRING_LOCKOUT_MS) {
        this.#ledger.delete(key);
      }
    }
  }

  /** Whether pairing is locked for this origin, or globally, at `now`. */
  #isLockedOut(ledgerKey: string, now: number): boolean {
    this.#pruneLedger(now);
    if (this.#globalLedger.lockedUntil > now) {
      return true;
    }
    const entry = this.#ledger.get(ledgerKey);
    return entry !== undefined && entry.lockedUntil > now;
  }

  /**
   * Counts one failure against an entry: a failure after a quiet window starts
   * the count again, and reaching the threshold locks the entry for
   * {@link PAIRING_LOCKOUT_MS}.
   */
  #countFailure(entry: PairingLedgerEntry, now: number, threshold: number): void {
    if (now - entry.lastFailureAt > PAIRING_LOCKOUT_MS) {
      entry.failures = 0;
    }
    entry.failures += 1;
    entry.lastFailureAt = now;
    if (entry.failures >= threshold) {
      entry.lockedUntil = now + PAIRING_LOCKOUT_MS;
      entry.failures = 0;
    }
  }

  /** Records a failed redemption for the origin and globally, and returns the refusal. */
  #pairingFailure(
    ledgerKey: string,
    now: number,
    reason: 'pairing-invalid' | 'pairing-used' | 'pairing-expired',
  ): Result<IssuedCredential, DebuggenError> {
    let entry = this.#ledger.get(ledgerKey);
    if (entry === undefined) {
      if (this.#ledger.size >= MAX_TRACKED_PAIRING_ORIGINS) {
        const oldest = this.#ledger.keys().next();
        if (oldest.done !== true) {
          this.#ledger.delete(oldest.value);
        }
      }
      entry = newLedgerEntry();
      this.#ledger.set(ledgerKey, entry);
    }
    this.#countFailure(entry, now, PAIRING_MAX_FAILURES);
    this.#countFailure(this.#globalLedger, now, PAIRING_GLOBAL_MAX_FAILURES);
    if (entry.lockedUntil > now || this.#globalLedger.lockedUntil > now) {
      this.#logger.warn('pairing is locked after repeated failures', {
        lockedForMs: PAIRING_LOCKOUT_MS,
      });
    }
    return refuse(reason);
  }

  /* ----------------------------------------------------------------------------------------------
   * Rotation and lifetime
   * ------------------------------------------------------------------------------------------- */

  rotateAll(): Result<RotationOutcome, DebuggenError> {
    const prepared = this.#prepareAuthDirectory();
    if (isErr(prepared)) {
      return prepared;
    }
    const token = this.#mintToken();
    if (isErr(token)) {
      return token;
    }
    const tokenHash = sha256Hex(token.value);
    const issuedAt = this.#now();
    const record: AuthFileRecord = { version: AUTH_FILE_VERSION, token: token.value, issuedAt };

    // One transaction: every credential and every outstanding pairing code goes,
    // the new editor credential arrives, and auth.json is rewritten. A failed
    // write rolls the deletions back, so a rotation either happens whole or not
    // at all.
    const deleted = this.#guard('rotate-credentials', () =>
      this.#store.transaction(() => {
        const removed = Number(this.#store.statement(SQL.deleteAllCredentials).run().changes);
        this.#store.statement(SQL.deleteAllPairingCodes).run();
        this.#insertCredential(tokenHash, 'vscode', MACHINE_USER_STORED_SCOPE, issuedAt, null);
        this.#writeAuthFile(record);
        return removed;
      }),
    );
    if (isErr(deleted)) {
      return deleted;
    }
    this.#announcements.clear();

    // Every open socket authenticated with a credential that no longer exists.
    // Paired Chrome extensions must pair again, and launched dev servers must be
    // relaunched to receive a new server-agent credential (AAP §0.5.6).
    let socketsClosed = 0;
    if (this.#revoker !== undefined) {
      try {
        socketsClosed = this.#revoker.revokeAll(WS_CLOSE_UNAUTHORIZED, ROTATION_CLOSE_REASON);
      } catch (cause) {
        this.#logger.error('credentials were rotated but open connections could not be closed');
        return err(
          new DebuggenError(
            'INTERNAL',
            'Credentials were rotated, but the open connections could not all be closed.',
            { hint: 'Restart the Debug Generator service to drop every open connection.', cause },
          ),
        );
      }
    }

    this.#logger.info('rotated every service credential', {
      rowsDeleted: deleted.value,
      socketsClosed,
    });
    return ok(Object.freeze({ credentialsDeleted: deleted.value, socketsClosed }));
  }

  close(): void {
    this.#ledger.clear();
    this.#globalLedger = newLedgerEntry();
    this.#announcements.clear();
  }
}

/**
 * Builds the access boundary over an open store.
 *
 * Validates its dependencies and nothing else: no file is read and no row
 * written until {@link AuthService.ensureEditorCredential} is called, which is
 * `main.ts`'s start-up step once `$DEBUGGEN_HOME` exists.
 *
 * @param deps The store, the two configured paths, the logger, and the
 * optional revoker, clock and randomness seams.
 * @returns The service, or `CONFIG_INVALID` when `auth.json` would not sit
 * inside the state root, or `STORE_ERROR` when the store is already closed.
 *
 * @example
 * ```ts
 * const auth = unwrap(createAuthService({ store, config, logger, revoker: clients }));
 * const editor = auth.ensureEditorCredential();
 * ```
 */
export function createAuthService(deps: AuthServiceDeps): Result<AuthService, DebuggenError> {
  if (deps.store.isClosed) {
    return err(
      new DebuggenError('STORE_ERROR', 'The access boundary needs an open session store.'),
    );
  }

  const home = normalizeRoot(deps.config.debuggenHome);
  const authFile = normalizeRoot(deps.config.authFilePath);
  if (
    home === undefined ||
    authFile === undefined ||
    authFile === home ||
    !isWithin(home, authFile)
  ) {
    return err(
      new DebuggenError(
        'CONFIG_INVALID',
        'The editor credential file must be an absolute path inside $DEBUGGEN_HOME.',
        {
          hint: 'Leave the credential path to the service configuration; set DEBUGGEN_HOME to move it.',
        },
      ),
    );
  }

  const random = deps.randomBytes;
  return ok(
    new CredentialAuthority({
      store: deps.store,
      authFilePath: deps.config.authFilePath,
      debuggenHome: deps.config.debuggenHome,
      logger: subsystemLogger(deps.logger, 'auth'),
      revoker: deps.revoker,
      clock: deps.now ?? nowEpochMs,
      random: random ?? ((size: number): Uint8Array => cryptoRandomBytes(size)),
    }),
  );
}

/* -------------------------------------------------------------------------------------------------
 * Authorization helpers for the route and WebSocket modules
 * ---------------------------------------------------------------------------------------------- */

/**
 * Requires the principal to hold one of `roles`.
 *
 * @returns `ok` when it does; `UNAUTHORIZED` (`role-not-permitted`, 403) otherwise.
 */
export function requireRole(
  principal: Principal,
  ...roles: readonly PrincipalRole[]
): Result<void, DebuggenError> {
  return roles.includes(principal.role) ? ok(undefined) : refuse('role-not-permitted');
}

/**
 * Requires the principal's scope to cover `projectRoot`, by the product's single
 * containment predicate (`isWithin` over `toPosix`-normalised paths), so a
 * `..` traversal or a sibling that merely shares a string prefix never passes.
 *
 * - An editor principal is confined to the workspace folders its connections
 *   announced: the root must be one of them or lie beneath one.
 * - A server-agent principal is confined to its one project: the root must be
 *   that project root.
 * - A DevTools principal carries no project scope and acts only through its
 *   bound session ({@link requireBoundSession}), so it is always refused here.
 *
 * @returns `ok`, or `PATH_OUTSIDE_PROJECT` (`project-out-of-scope`, 403).
 */
export function requireProjectScope(
  principal: Principal,
  projectRoot: string,
): Result<void, DebuggenError> {
  const root = normalizeRoot(projectRoot);
  if (root === undefined) {
    return refuse('project-out-of-scope', 'A project root must be an absolute path.');
  }
  switch (principal.role) {
    case 'vscode':
      return principal.scope.workspaceFolders.some((folder) => isWithin(folder, root))
        ? ok(undefined)
        : refuse('project-out-of-scope');
    case 'server-agent':
      return sameRoot(principal.scope.projectRoot, root)
        ? ok(undefined)
        : refuse('project-out-of-scope');
    case 'devtools':
      return refuse(
        'project-out-of-scope',
        'A DevTools credential carries no project scope; it acts only through the session its tab is bound to.',
      );
  }
}

/**
 * The DevTools rule of AAP §0.5.6: a DevTools principal may bind its tab,
 * select targets, start and stop capture, query panel data and send
 * `source.open` only for the session bound to its tab, by a binding its own
 * credential made.
 *
 * @param principal The requesting principal; must be a DevTools one.
 * @param sessionId The session the request acts on.
 * @param binding The tab binding recorded for that session, if any.
 * @returns `ok`, or `TAB_NOT_BOUND` (`session-not-bound`, 403); a non-DevTools
 * principal is `UNAUTHORIZED` (`role-not-permitted`).
 */
export function requireBoundSession(
  principal: Principal,
  sessionId: string,
  binding: TabBinding | undefined,
): Result<void, DebuggenError> {
  if (principal.role !== 'devtools') {
    return refuse('role-not-permitted', 'Only a DevTools credential acts through a tab binding.');
  }
  if (
    binding === undefined ||
    binding.sessionId !== sessionId ||
    !digestsEqual(binding.boundBy, principal.tokenHash)
  ) {
    return refuse('session-not-bound');
  }
  return ok(undefined);
}

/**
 * The whole per-session access matrix in one call: an editor principal by
 * project scope, a DevTools principal by its tab binding, and a server agent
 * never (it only ingests).
 *
 * @param principal The requesting principal.
 * @param session The session's id and project root.
 * @param binding The tab binding recorded for the session, if any.
 * @returns `ok`, or the refusal of the rule that applies to the principal's role.
 */
export function requireSessionAccess(
  principal: Principal,
  session: SessionAccessTarget,
  binding?: TabBinding,
): Result<void, DebuggenError> {
  switch (principal.role) {
    case 'vscode':
      return requireProjectScope(principal, session.projectRoot);
    case 'devtools':
      return requireBoundSession(principal, session.id, binding);
    case 'server-agent':
      return refuse('role-not-permitted', 'A dev-server credential may only post telemetry.');
  }
}

/* -------------------------------------------------------------------------------------------------
 * The hono middleware
 * ---------------------------------------------------------------------------------------------- */

/** Builds the middleware for one registered operation. */
export type AuthMiddlewareFactory = (operation: HttpOperationId) => MiddlewareHandler<ServerEnv>;

/**
 * The bearer-and-origin middleware `http.ts` installs in front of every route.
 *
 * The registration loop passes each route's operation id, so this code never
 * matches a path: it asks {@link AuthService.authorizeHttpRequest} about the
 * operation it was built for, sets `operation` and — for every non-exempt
 * operation — `principal` on the context, and otherwise answers with the
 * protocol's error body at the refusal's status (401, 403 or 429).
 *
 * ⚠️ It sets **no `Access-Control-Allow-Origin` header, deliberately**, and
 * nothing else may add one. Its absence is why a browser page cannot read any
 * response of this service, and together with the bearer requirement it is what
 * closes CSRF (AAP §0.5.6). A missing CORS header here is the design, not a bug
 * to fix.
 *
 * @param auth The access boundary.
 * @returns A factory from operation id to middleware.
 *
 * @example
 * ```ts
 * const authFor = createAuthMiddleware(auth);
 * for (const operation of HTTP_OPERATIONS) {
 *   const { method, pattern } = HTTP_ROUTES[operation];
 *   app.on(method, pattern, authFor(operation), handlers[operation]);
 * }
 * ```
 */
export function createAuthMiddleware(
  auth: Pick<AuthService, 'authorizeHttpRequest'>,
): AuthMiddlewareFactory {
  return (operation) => async (c, next) => {
    const decision = auth.authorizeHttpRequest({
      headers: c.req.raw.headers,
      origin: c.req.header(ORIGIN_HEADER),
      operation,
    });
    if (isErr(decision)) {
      const { status, body } = authErrorResponse(decision.error);
      return c.json(body, status);
    }
    c.set('operation', operation);
    if (decision.value !== null) {
      c.set('principal', decision.value);
    }
    await next();
    return undefined;
  };
}
