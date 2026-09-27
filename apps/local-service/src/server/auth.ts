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
 * A route that awaits its request body before acting also calls
 * {@link AuthService.requireLiveCredential} between the read and the act, so
 * a credential retired while the body was in flight authorizes nothing.
 *
 * ## The three credentials
 *
 * Every credential is a 32-byte CSPRNG token, rendered base64url, and stored
 * **only** as its SHA-256 digest in the `credentials` table together with its
 * role, its scope and its lifetime. The plaintext exists in exactly three
 * places in the whole system: `$DEBUGGEN_HOME/auth.json` (mode `0600`) — with,
 * while the editor credential is being replaced, its journal
 * `auth.json.pending` ({@link AUTH_FILE_STAGE_SUFFIX}) beside it at the same
 * mode — the one-time response body of `POST /pair/complete`, and the
 * environment of a dev-server process the launcher started. Nothing in this
 * module logs, persists, throws or returns a plaintext token anywhere else.
 *
 * | Role | Scope | Issued by | Lifetime |
 * | --- | --- | --- | --- |
 * | `vscode` (editor) | the machine user; acts on projects under the workspace folders its live connections announced in `client.hello` | {@link AuthService.ensureEditorCredential}, written to `auth.json` | until rotation |
 * | `devtools` | the Chrome extension id that redeemed a pairing code | {@link AuthService.completePairing} | until rotation |
 * | `server-agent` | exactly one `projectRoot` | {@link AuthService.issueServerAgentCredential}, called by the dev-server launcher | until the launched process exits or is stopped ({@link AuthService.revokeServerAgentCredential}, that one credential only), and never past its expiry: a launched child's credential is a lease the launcher renews ({@link AuthService.renewServerAgentCredential}) only while the child runs; a `POST /dev-server/credential` credential may also be released early by its holder ({@link AuthService.releaseServerAgentCredential}) |
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
 * a DevTools credential from `chrome-extension://<the id it was issued to>`,
 * and a server-agent credential only from no origin. A credential that
 * surfaces anywhere else is refused, which is what keeps a stolen DevTools
 * token out of every other extension, webview and web page.
 *
 * One DevTools case carries no `Origin` at all: Chrome sends the header on an
 * extension's `POST` and on its WebSocket upgrade, but not on a `GET` its
 * service worker makes to a host the extension holds a host permission for
 * (`http://127.0.0.1/*`). And an `Origin` is a claim: a local process holding
 * the credential can write the extension's origin itself. So the DevTools
 * reads — `session.get`, `panel.get`, `panel.getById` and
 * `modifications.list` — are bound to the pairing by a **read proof**: 32
 * CSPRNG bytes drawn when the one-time code is redeemed, returned exactly once
 * with the credential, and stored only as a SHA-256 digest inside the
 * credential's own record. Every DevTools read must present it as
 * {@link READ_PROOF_HEADER}, whether it arrives with no `Origin` or with the
 * issuing extension's; nothing sent on a connection registers or replaces it.
 * Every state-changing request and the `client.hello` still need the issuing
 * extension's origin.
 *
 * A read without the proof is `missing-credential`, one with a malformed or
 * repeated header `malformed-credential`, and one whose proof is not the
 * credential's — including a credential stored before proofs existed —
 * `unknown-credential`: all `UNAUTHORIZED` (401), which the extension answers
 * by dropping its pairing so the developer pairs again, because the pair it
 * holds cannot read. A proof on anything but a DevTools read — a write, an
 * exempt operation, another role's request — is `role-not-permitted`. The
 * plaintext proof is never logged, compared only by digest, and deleted with
 * the credential on rotation.
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
 * an editor credential may act only under folders its connections announced
 * ({@link AuthService.announceWorkspace}). An announcement lives as long as the
 * connection that made it plus, when that connection merely dropped, a bounded
 * **lease** ({@link WorkspaceAnnouncement.releaseAfter}, at most
 * {@link MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS}): disconnects are routine — VS
 * Code's `deactivate()` ends its sessions over HTTP after its socket is gone,
 * and a reconnect takes a moment — so the editor keeps its folders for the
 * same offline grace a suspended client keeps its registration. Rotation and
 * shutdown end every announcement and every lease at once.
 *
 * ## A DevTools credential is not a tab identity
 *
 * One paired Chrome extension holds one `devtools` credential, and its MV3
 * service worker carries **every** inspected tab over one WebSocket and one
 * HTTP client. The credential therefore proves *which extension* is asking,
 * never *which tab* it is asking for: tab B and tab A present the same digest.
 * AAP §0.5.6 lets a DevTools client act only on the session bound to its own
 * tab, so every DevTools action names its **acting tab** — the
 * {@link ACTING_TAB_HEADER} on HTTP (resolved by {@link resolveActingTab} and
 * exposed to routes as `c.get('actingTabId')`), the envelope's `tabId` (or a
 * single-tab connection's hello `tabId`) on WebSocket — and
 * {@link requireBoundSession} admits the action only when the service's own
 * live binding table says that tab is bound to that session by that
 * credential. The acting tab is a claim the extension makes from Chrome's own
 * port metadata; what makes it safe is that it is checked against the binding
 * table, never trusted as authority on its own, and that an action naming no
 * tab is refused rather than attributed to a guessed one.
 *
 * ## Failure reporting
 *
 * Every fallible operation returns a `Result`; nothing here throws to its
 * caller (the one deliberate throw, the host path resolver's, is the
 * {@link RealPathResolver} contract and is caught where it is called). Every
 * refusal is a `DebuggenError` whose code comes from the closed
 * `DEBUGGEN_ERROR_CODES` set and whose `details.reason` names one entry of
 * {@link AUTH_FAILURE_REASONS}, which fixes its HTTP status (400, 401, 403 or
 * 429).
 * Messages are constant sentences about the rule that was applied; no presented
 * value — token, code, header, payload — is ever interpolated into one.
 *
 * ## State and lifetime
 *
 * Durable state is the two tables `credentials` and `pairing_codes`, reached
 * through the injected {@link Store}'s statement cache, and `auth.json`; a
 * DevTools credential's read-proof digest lives in its own `credentials` row.
 * The only in-memory state is the one service-wide pairing lockout ledger and
 * the workspace announcements, both bounded, both dropped by
 * {@link AuthService.close} (the announcements by {@link AuthService.rotateAll}
 * as well). This
 * module starts no timer and opens no socket: lockouts and workspace leases
 * expire lazily against the injected clock, and an expired lease is pruned by
 * the scope read that finds it expired.
 *
 * ## Replacing the editor credential across two resources
 *
 * A new editor credential — minted on first start or by
 * {@link AuthService.rotateAll} — changes two resources that share no
 * transaction: a row in the store and the plaintext in `auth.json`. Renaming
 * the file inside the store transaction, as a single "atomic" step, is not
 * atomic: a failure after the rename rolls the rows back but not the file.
 * Every replacement therefore runs as a journaled sequence, and no file is
 * touched inside a store transaction:
 *
 * 1. **Stage** — the new record is written to the journal,
 *    `auth.json.pending` ({@link AUTH_FILE_STAGE_SUFFIX}), atomically at `0600`.
 * 2. **Commit** — one store transaction deletes what the replacement retires
 *    and inserts the new editor row.
 * 3. **Publish** — the journal's record is written to `auth.json`.
 * 4. **Unstage** — the journal is removed.
 *
 * The journal's own editor row is the commit marker: it is inserted in the same
 * transaction as every deletion, so a live row for the journal's credential
 * means the whole change committed and its absence means none of it did.
 * {@link AuthService.ensureEditorCredential} — every start — and
 * {@link AuthService.rotateAll} — every rotation — first recover a journal an
 * earlier call left: a committed one is published, an uncommitted one is
 * discarded. `auth.json` is therefore only ever published after the store
 * change it belongs to is durable, and a file that has fallen behind the store
 * is caught up to it — the store is never rolled back to the file. A file whose
 * credential has no row while another editor credential is registered is, for
 * the same reason, never registered again: a new credential is minted instead,
 * so no credential a committed rotation retired can come back.
 */

import { randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';

import {
  ACTING_TAB_HEADER,
  AUTHORIZATION_HEADER,
  CLIENT_KINDS,
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  READ_PROOF_BYTES,
  READ_PROOF_HEADER,
  WS_CLOSE_UNAUTHORIZED,
  clientHelloPayloadSchema,
  describeZodIssues,
  formatBearer,
  isAuthExemptOperation,
  isCompatibleProtocolVersion,
  isReadProof,
  parseActingTabHeader,
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
  basenamePosix,
  dirnamePosix,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  isWithin,
  joinPosix,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Logger, RealPathResolver, Result } from '@debuggen/shared';
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

/**
 * The suffix that names the editor credential's journal: the file
 * `<authFilePath>` + this suffix, beside `auth.json` in the same private
 * directory.
 *
 * The journal holds the record a replacement of the editor credential is about
 * to publish, in exactly `auth.json`'s format and at its mode, from before the
 * replacement's store transaction until `auth.json` holds it (see "Replacing
 * the editor credential across two resources" in the module documentation). A
 * journal that outlives the call that wrote it is finished or discarded by the
 * next {@link AuthService.ensureEditorCredential} or
 * {@link AuthService.rotateAll}; nothing else reads it.
 */
export const AUTH_FILE_STAGE_SUFFIX = '.pending';

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
 * How many failed redemptions — each within {@link PAIRING_LOCKOUT_MS} of the
 * one before it — lock pairing **for every caller at once** for
 * {@link PAIRING_LOCKOUT_MS}.
 *
 * The count is service-wide, never per caller, because nothing about a caller
 * of `POST /pair/complete` can be trusted to tell callers apart. Its only
 * identifying input is the `Origin` header, which a local process sets to any
 * `chrome-extension://…` value it likes, so a ledger keyed by origin would hand
 * a forger five fresh guesses per invented id. And every client reaches this
 * loopback-only service from the same address, so there is no peer address to
 * key on either: the one ledger *is* the trusted-peer throttle. At most this
 * many wrong guesses therefore fit in any lockout window, however many origins
 * they are spread over. Pairing is a rare, developer-initiated action, so a
 * forger pausing it for a minute costs the developer nothing a retry does not
 * recover.
 *
 * During a lockout even the right code is refused (`pairing-locked`, 429) and
 * nothing is burned: the code stays unused and redeems once the lock lifts. A
 * successful redemption clears the count, and so does a quiet window of
 * {@link PAIRING_LOCKOUT_MS} with no failure. The credential a redemption
 * issues is still scoped to the redeeming extension's id; only the throttle is
 * shared.
 */
export const PAIRING_MAX_FAILURES = 5;

/**
 * How long a lockout lasts, and how long a failure is remembered when no
 * further failure follows it: sixty seconds.
 */
export const PAIRING_LOCKOUT_MS = 60 * 1000;

/** How many times generation retries when a fresh value collides with a stored one. */
const MAX_GENERATION_ATTEMPTS = 4;

/**
 * How many times a committed editor credential is written to `auth.json` before
 * the replacement reports the file as not updated: the first write and one
 * retry. A committed credential is already the only editor credential the
 * store accepts, so one more attempt is cheap insurance against a transient
 * failure; a failure that persists leaves the journal for the next start.
 */
const PUBLISH_ATTEMPTS = 2;

/** How the editor credential file is named in failure messages. */
const AUTH_FILE_SUBJECT = 'editor credential file';

/** How the editor credential's journal is named in failure messages. */
const AUTH_STAGE_SUBJECT = 'editor credential journal';

/**
 * The reason text a rotation hands to the revoker for every socket it closes.
 * WebSocket close reasons are limited to 123 bytes, so it is short.
 */
const ROTATION_CLOSE_REASON = 'credentials rotated';

/** The close reason of a connection whose credential was revoked on its own. */
const REVOCATION_CLOSE_REASON = 'credential revoked';

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
 * A freshly issued credential: with {@link IssuedDevtoolsCredential}, the
 * **only** type in the service that carries a plaintext secret. It is returned
 * exactly once per issuance, to the one caller that hands it to its client,
 * and never persisted.
 */
export interface IssuedCredential {
  readonly token: string;
  readonly expiresAt?: number;
}

/**
 * A freshly issued DevTools credential and the read proof issued with it
 * ({@link READ_PROOF_HEADER}). Both are plaintext secrets returned exactly
 * once; the service keeps only their SHA-256 digests, the proof's inside the
 * credential's stored scope.
 */
export interface IssuedDevtoolsCredential extends IssuedCredential {
  readonly readProof: string;
}

/**
 * The hono environment of every route: the operation the registration loop in
 * `http.ts` bound the handler to, and the principal {@link createAuthMiddleware}
 * resolved for it.
 *
 * `principal` is set for every operation that requires a credential and never
 * for the two auth-exempt ones (`health`, `pair.complete`), whose handlers
 * must not read it.
 *
 * `actingTabId` is the inspected tab a DevTools request names in the
 * {@link ACTING_TAB_HEADER}, as {@link resolveActingTab} verified its shape:
 * `undefined` for every editor and server-agent request (which may not send the
 * header at all) and for a DevTools request that named none. It is a claim to
 * be checked, never authority: a route hands it to {@link requireBoundSession}
 * (directly or through {@link requireSessionAccess}), which refuses a DevTools
 * request whose acting tab is absent or is not the session's live bound tab.
 *
 * `requestRef` is the correlation reference `http.ts`'s request context minted
 * for the request — the `ref` its error body and its `X-Debuggen-Ref` header
 * carry. {@link createAuthMiddleware} hands it to the access boundary so a
 * refusal's `warn` record names the same ref as the refusal's body. It is
 * `undefined` only where no request context runs (a route composed on its own,
 * as the unit suites do); a route may read it to log under the request's ref,
 * and never treats it as input from the client — the service mints it.
 */
export type ServerEnv = {
  Variables: {
    principal: Principal;
    operation: HttpOperationId;
    actingTabId: number | undefined;
    requestRef: string | undefined;
  };
};

/**
 * A tab-to-session binding as the authorization rules need to see it.
 *
 * `boundBy` is the {@link Principal.tokenHash} of the DevTools connection that
 * bound the tab: AAP §0.5.6 records a binding "against the connection's
 * principal", which is what stops one DevTools credential from acting on a
 * session another credential's tab is bound to.
 *
 * `boundBy` names a **credential, not a tab**. Every tab one paired extension
 * inspects shares that credential, so `boundBy` alone would let tab B act on
 * the session tab A is bound to; `tabId` is what {@link requireBoundSession}
 * compares the request's acting tab against to tell them apart.
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

  /**
   * Closes the open connections authenticated with one credential — what
   * {@link AuthService.revokeServerAgentCredential} calls once that credential
   * is deleted, so a revoked dev server's socket stops receiving configuration
   * at once rather than at its next expiry check. Every other connection,
   * including another credential of the same project, is left open.
   *
   * Optional: without it a revoked credential's socket is closed by the client
   * registry's expiry sweep, which sees a revoked server-agent principal as
   * expired (see {@link AuthService.authorizeHello}).
   *
   * @param tokenHash The revoked credential's SHA-256 digest.
   * @param code The close code — protocol's `WS_CLOSE_UNAUTHORIZED`.
   * @param reason A short close reason.
   * @returns How many sockets were closed.
   */
  closeCredential?(tokenHash: string, code: number, reason?: string): number;
}

/**
 * The two filesystem writes a replacement of the editor credential makes, as a
 * port: the atomic write that stages and publishes a record, and the removal
 * of the journal.
 *
 * Production never supplies one: {@link createAuthService} defaults to
 * `writeSecureFileAtomic` from `@debuggen/shared/node` and `node:fs`'s
 * `unlinkSync`. It is a **test seam**, the same kind as the injected clock and
 * randomness source: it lets the unit suite fail exactly one step of a
 * replacement — staging, publishing, removing the journal — and prove what a
 * restart makes of the state that step left behind, which no arrangement of
 * the filesystem can do for a suite that runs as root. Reads are never routed
 * through it, and every write is still verified afterwards with
 * `inspectPrivateFileNoFollow`, so a port cannot make an unsafe file pass.
 */
export interface CredentialFileSystem {
  /**
   * Atomically creates or replaces `path` at `0600`, after verifying its parent
   * chain up to and including `upTo` is private.
   *
   * @throws Any failure; nothing may be left at `path` but the old or the new
   * content.
   */
  writeSecureFile(path: string, data: string, upTo: string): void;

  /**
   * Removes the directory entry at `path`, never following a link there.
   *
   * @throws Any failure, `ENOENT` included, with its errno `code` intact.
   */
  removeFile(path: string): void;
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
  /**
   * Marks the credential as a **lease** this service process holds: minted by
   * the dev-server launcher for a child it supervises, renewed only while that
   * child runs, and revoked when it exits. Requires `expiresAt`. The holder's
   * process id is stored with the row, so a lease left behind by a service that
   * crashed is revoked the next time a service starts
   * ({@link AuthService.revokeOrphanedServerAgentLeases}) instead of lingering
   * until it lapses.
   */
  readonly lease?: boolean | undefined;
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
  /**
   * The correlation reference the service minted for the request (the
   * {@link ServerEnv} `requestRef`), which the refusal's body carries. A
   * refusal's `warn` record is filed under it, so a developer holding the ref
   * from a reply finds the record. Omitted where no request context minted one.
   */
  readonly ref?: string | undefined;
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
  /**
   * The code as submitted. Compared exactly — never trimmed or case-folded —
   * so it must already be the eight upper-case characters the editor showed.
   */
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
 * The longest lease {@link WorkspaceAnnouncement.releaseAfter} grants: five
 * minutes. A lease covers a routine disconnect — an editor reconnecting, or
 * VS Code's `deactivate()` ending its sessions over HTTP after its socket has
 * closed — and nothing longer; a caller asking for more is clamped to this.
 */
export const MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS = 5 * 60_000;

/**
 * A live workspace announcement: the folders one editor connection announced,
 * in the scope of its credential until the announcement is settled.
 *
 * The first call of either method settles it; every later call of either is a
 * no-op. Settling an announcement that a rotation or shutdown already cleared
 * does nothing, so a socket closed by the revocation itself cannot bring its
 * folders back.
 *
 * @example
 * ```ts
 * const announced = auth.announceWorkspace(principal);
 * // …the connection closes on its own:
 * announced.value.releaseAfter(offlineGraceMs);
 * // …or the server is closing, or the connection never registered:
 * announced.value.release();
 * ```
 */
export interface WorkspaceAnnouncement {
  /** Withdraws the folders at once — unless another connection, or its lease, still holds them. */
  readonly release: () => void;
  /**
   * Withdraws this connection's claim but keeps its folders in scope for
   * `leaseMs` more milliseconds of the service's clock, clamped to
   * `[0, MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS]` (a non-finite or negative value
   * is `0`, which is {@link WorkspaceAnnouncement.release}). The lease is judged lazily on the next
   * scope read; no timer is started.
   */
  readonly releaseAfter: (leaseMs: number) => void;
}

/**
 * One announced folder's standing for one editor credential: how many live
 * announcements name it, and until when a settled one's lease keeps it.
 */
interface FolderStanding {
  /** Announcements naming the folder that are not yet settled. */
  live: number;
  /** Epoch milliseconds before which the folder stays in scope with no live announcement; `0` for none. */
  leaseUntil: number;
}

/**
 * The lease `requested` milliseconds amounts to: whole milliseconds within
 * `[0, MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS]`, and `0` for anything non-finite
 * or negative.
 */
function workspaceLeaseMs(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) {
    return 0;
  }
  return Math.min(Math.floor(requested), MAX_WORKSPACE_ANNOUNCEMENT_LEASE_MS);
}

/* -------------------------------------------------------------------------------------------------
 * Failure vocabulary
 * ---------------------------------------------------------------------------------------------- */

/**
 * The HTTP statuses an access-boundary failure is answered with. `400` is
 * reserved for an {@link ACTING_TAB_HEADER} value that is not one tab id — a
 * malformed request rather than a refused credential.
 */
export type AuthHttpStatus = 400 | 401 | 403 | 429;

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
 * The table is the single place a refusal's status is decided: 400 when the
 * acting-tab header is not a tab id, 401 when the caller is not (or no longer)
 * authenticated — which includes a DevTools read without the read proof issued
 * with its credential —, 403 when it is authenticated but the origin, role,
 * scope or acting tab does not permit the act, 429 during a pairing lockout.
 * `details.reason` on every refusal names its entry, so
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
    hint: 'If VS Code’s own credential was refused, restart the service from VS Code (Debug Generator: Start Local Service), which re-mints it; otherwise rotate the service credentials from VS Code (Debug Generator: Rotate Service Token).',
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
  'acting-tab-required': {
    code: 'TAB_NOT_BOUND',
    status: 403,
    message: 'A DevTools request must name the inspected tab it acts for.',
    hint: 'Update the Debug Generator Chrome extension; this service needs every DevTools request to name its inspected tab.',
  },
  'acting-tab-invalid': {
    code: 'PROTOCOL_INVALID_MESSAGE',
    status: 400,
    message: `The ${ACTING_TAB_HEADER} header must be exactly one Chrome tab id.`,
    hint: 'Send the inspected tab id as a non-negative decimal integer, once.',
  },
  'acting-tab-not-permitted': {
    code: 'UNAUTHORIZED',
    status: 403,
    message: `Only a DevTools credential names an inspected tab; this request may not carry the ${ACTING_TAB_HEADER} header.`,
    hint: 'Omit the acting-tab header outside the Debug Generator Chrome extension.',
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
    // The wait is part of the message because the message is what reaches the
    // DevTools pairing dialog: the error payload carries no hint (AAP §0.4.2).
    // "Up to", because a later attempt inside the lock has less of it left;
    // the route's `Retry-After` states the same bound in seconds.
    message: `Too many failed pairing attempts; pairing is paused for up to ${String(PAIRING_LOCKOUT_MS / 1000)} seconds.`,
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
 * Builds the refusal for one reason. The message and hint are the table's
 * constants unless the caller supplies more specific ones, which must be
 * constants too: no presented value is ever interpolated into either.
 */
function authFailure(reason: AuthFailureReason, message?: string, hint?: string): DebuggenError {
  const descriptor: AuthFailureDescriptor = AUTH_FAILURE_REASONS[reason];
  const next = hint ?? descriptor.hint;
  return new DebuggenError(descriptor.code, message ?? descriptor.message, {
    details: { reason },
    ...(next === undefined ? {} : { hint: next }),
  });
}

/** {@link authFailure} as an `Err`, typed for whichever `Result` the caller returns. */
function refuse<T>(
  reason: AuthFailureReason,
  message?: string,
  hint?: string,
): Result<T, DebuggenError> {
  return err(authFailure(reason, message, hint));
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
 * @returns 400, 401, 403 or 429 per {@link AUTH_FAILURE_REASONS}.
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
 * - The four administrative operations are the editor's alone:
 *   `session.purge` (the on-demand retention sweep behind
 *   `debuggen.purgeSessions`), `devServer.credential` (a project-scoped
 *   server-agent credential for a dev server the caller starts itself, as
 *   `scripts/dev-instrumented.mjs` requests one), `credentials.release` (that
 *   credential's early revocation, which the same script requests as its dev
 *   server exits) and `credentials.rotate` (the revocation behind
 *   `debuggen.rotateServiceToken`). Each acts on state no DevTools client or
 *   server agent may reach: every session's history, the minting or
 *   revocation of a credential, and every credential at once. A server agent
 *   in particular cannot release even its own credential: its lifetime is its
 *   process's, ended by whoever started that process.
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
  'session.purge': ['vscode'],
  'capture.start': ['vscode', 'devtools'],
  'capture.stop': ['vscode', 'devtools'],
  'target.request': ['vscode'],
  'panel.data': ['vscode', 'devtools'],
  'panel.get': ['vscode', 'devtools'],
  'panel.getById': ['vscode', 'devtools'],
  'modifications.list': ['vscode', 'devtools'],
  'telemetry.event': ['server-agent'],
  'devServer.launch': ['vscode'],
  'devServer.stop': ['vscode'],
  'devServer.credential': ['vscode'],
  'pair.start': ['vscode'],
  'credentials.rotate': ['vscode'],
  'credentials.release': ['vscode'],
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

/* -------------------------------------------------------------------------------------------------
 * Logging a refused origin
 * ---------------------------------------------------------------------------------------------- */

/** The longest rendering {@link describeRefusedOrigin} returns, in characters. */
export const MAX_DESCRIBED_ORIGIN_LENGTH = 128;

/** What {@link describeRefusedOrigin} says for a request that carried no `Origin`. */
export const ABSENT_ORIGIN_DESCRIPTION = '(absent)';

/**
 * What {@link describeRefusedOrigin} says for a value it will not render: one
 * holding whitespace or a control character, or one that is not a URL.
 */
export const UNREADABLE_ORIGIN_DESCRIPTION = '(unreadable)';

/** The literal `Origin` a browser sends from an opaque context (a sandboxed frame, `data:`, a redirect). */
const OPAQUE_ORIGIN = 'null';

/** Marks a rendering cut at {@link MAX_DESCRIBED_ORIGIN_LENGTH}. */
const TRUNCATION_MARK = '…';

/**
 * A log-safe rendering of a refused `Origin`, so a refusal record says *which*
 * page knocked without carrying anything else the header held.
 *
 * - An absent (or empty) header is {@link ABSENT_ORIGIN_DESCRIPTION}; the
 *   opaque origin `null` stays `null`.
 * - A value holding whitespace, a C0 control character or DEL — the one way a
 *   header could forge a log line or smuggle a second value — or one `URL`
 *   cannot parse is {@link UNREADABLE_ORIGIN_DESCRIPTION}: such a value is
 *   never rendered at all.
 * - Anything else is parsed and re-serialised as `scheme://host` — the host
 *   keeps its port, and is the parser's normalised (punycode, lower-case)
 *   form — or as the bare `scheme:` of a URL with no host (`data:`, `file:`).
 *   Userinfo, path, query and fragment are never part of it: a crafted
 *   `Origin` that names a user and a password before `evil.example`, a path
 *   and a query is rendered `https://evil.example`.
 * - The result is at most {@link MAX_DESCRIBED_ORIGIN_LENGTH} characters; a
 *   longer host is cut and ends in `…`.
 *
 * Pure and total: it never throws, whatever it is handed.
 *
 * @param origin The raw `Origin` header value, or `undefined` when absent.
 * @returns The rendering to log under an `origin` field.
 *
 * @example
 * ```ts
 * describeRefusedOrigin('http://evil.example');                    // 'http://evil.example'
 * describeRefusedOrigin('https://evil.example:8443/a?b#c');         // 'https://evil.example:8443'
 * describeRefusedOrigin('null');                                    // 'null'
 * describeRefusedOrigin('data:text/html,<p>');                      // 'data:'
 * describeRefusedOrigin('http://evil.example\r\nX-Forged: 1');      // '(unreadable)'
 * ```
 */
export function describeRefusedOrigin(origin: string | undefined): string {
  if (origin === undefined || origin === '') {
    return ABSENT_ORIGIN_DESCRIPTION;
  }
  if (origin === OPAQUE_ORIGIN) {
    return OPAQUE_ORIGIN;
  }
  if (hasForbiddenOriginCharacter(origin)) {
    return UNREADABLE_ORIGIN_DESCRIPTION;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return UNREADABLE_ORIGIN_DESCRIPTION;
  }
  const rendered = parsed.host === '' ? parsed.protocol : `${parsed.protocol}//${parsed.host}`;
  if (hasForbiddenOriginCharacter(rendered)) {
    return UNREADABLE_ORIGIN_DESCRIPTION;
  }
  return rendered.length <= MAX_DESCRIBED_ORIGIN_LENGTH
    ? rendered
    : `${rendered.slice(0, MAX_DESCRIBED_ORIGIN_LENGTH - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
}

/** How many refusals a {@link RefusalLogThrottle} files at `warn` per window, by default. */
export const REFUSAL_LOG_BURST = 5;

/** The window a {@link RefusalLogThrottle}'s burst is counted over, in milliseconds, by default. */
export const REFUSAL_LOG_WINDOW_MS = 60_000;

/**
 * What a {@link RefusalLogThrottle} says about one refusal: file it at `warn`,
 * with the number of refusals filed at `debug` since the previous `warn`, or
 * file it at `debug`.
 */
export type RefusalLogVerdict =
  { readonly level: 'warn'; readonly suppressed: number } | { readonly level: 'debug' };

/**
 * Decides, refusal by refusal, which ones reach the default log level.
 *
 * A web page can provoke refusals as fast as it can send requests, so writing
 * every one at `warn` would let any page on the developer's machine flood the
 * service log — and bury the one that matters. The throttle keeps the first
 * few of every window visible and counts the rest, the same shape as the
 * WebSocket admission quotas' refusal log in `./ws.ts`.
 */
export interface RefusalLogThrottle {
  /** Records one refusal and returns the level to file it at. */
  next(): RefusalLogVerdict;
}

/** How a {@link RefusalLogThrottle} is built; every member has a default. */
export interface RefusalLogThrottleOptions {
  /** Refusals filed at `warn` per window; a positive integer, else {@link REFUSAL_LOG_BURST}. */
  readonly burst?: number | undefined;
  /** The window in milliseconds; a positive finite number, else {@link REFUSAL_LOG_WINDOW_MS}. */
  readonly windowMs?: number | undefined;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: (() => number) | undefined;
}

/**
 * Builds a {@link RefusalLogThrottle}: the first `burst` refusals of each
 * `windowMs` window are filed at `warn`, the rest at `debug`. A window opens
 * at the first refusal after the previous one closed, and the first `warn` of
 * a window reports, as `suppressed`, how many refusals went to `debug` since
 * the last `warn` — so the count survives even when nothing was logged at the
 * default level in between. Each owner holds its own instance; it keeps no
 * global state and no timer.
 *
 * @param options The burst, the window and the clock.
 * @returns The throttle.
 *
 * @example
 * ```ts
 * const throttle = createRefusalLogThrottle();
 * const verdict = throttle.next();
 * if (verdict.level === 'warn') {
 *   log.warn('Refused a request from a web origin', { origin, suppressed: verdict.suppressed });
 * } else {
 *   log.debug('Refused a request from a web origin', { origin });
 * }
 * ```
 */
export function createRefusalLogThrottle(
  options: RefusalLogThrottleOptions = {},
): RefusalLogThrottle {
  const burst =
    options.burst !== undefined && Number.isInteger(options.burst) && options.burst > 0
      ? options.burst
      : REFUSAL_LOG_BURST;
  const windowMs =
    options.windowMs !== undefined && Number.isFinite(options.windowMs) && options.windowMs > 0
      ? options.windowMs
      : REFUSAL_LOG_WINDOW_MS;
  const now = options.now ?? ((): number => performance.now());

  let windowStartedAt: number | undefined;
  let warnedInWindow = 0;
  let suppressedSinceWarn = 0;

  return Object.freeze({
    next(): RefusalLogVerdict {
      const at = now();
      if (windowStartedAt === undefined || at - windowStartedAt >= windowMs) {
        windowStartedAt = at;
        warnedInWindow = 0;
      }
      if (warnedInWindow < burst) {
        warnedInWindow += 1;
        const suppressed = suppressedSinceWarn;
        suppressedSinceWarn = 0;
        return { level: 'warn', suppressed };
      }
      suppressedSinceWarn += 1;
      return { level: 'debug' };
    },
  });
}

/**
 * The refusal reasons decided by a request's `Origin` — the ones whose record
 * names the origin ({@link describeRefusedOrigin}) when the request carried one.
 */
const ORIGIN_REFUSAL_REASONS: ReadonlySet<AuthFailureReason> = new Set<AuthFailureReason>([
  'forbidden-origin',
  'origin-not-permitted-for-role',
  'pairing-origin-required',
]);

/**
 * How a credential is presented, which decides whether a DevTools credential
 * may arrive without an `Origin` (see the module's origin policy): `read` for
 * an HTTP `GET`, `write` for every other HTTP request and for `client.hello`.
 */
type CredentialPresentation = 'read' | 'write';

/** The presentation of an HTTP request for `operation`, by its route's method. */
function presentationOf(operation: HttpOperationId): CredentialPresentation {
  return HTTP_ROUTES[operation].method === 'GET' ? 'read' : 'write';
}

/** What the origin rule decides for one presentation of a credential. */
type OriginDecision = 'permitted' | 'refused';

/**
 * Whether a credential of this principal's role may be presented from this
 * origin: editor credentials from Node or a VS Code webview, DevTools
 * credentials from the extension they were issued to, server-agent credentials
 * only from Node.
 *
 * A DevTools `read` is also permitted from no origin, because Chrome omits the
 * header on the `GET`s the extension's service worker sends; every other
 * origin-less DevTools presentation — a write, a hello — is refused. An
 * `Origin` is only a claim, so the origin rule is never what admits a DevTools
 * read on its own: every one of them must also carry the read proof issued
 * with its credential, checked when the credential is authenticated.
 */
function originDecisionFor(
  origin: OriginClass,
  principal: Principal,
  presentation: CredentialPresentation,
): OriginDecision {
  switch (principal.role) {
    case 'vscode':
      return origin.kind === 'absent' || origin.kind === 'vscode-webview' ? 'permitted' : 'refused';
    case 'devtools':
      if (
        origin.kind === 'chrome-extension' &&
        origin.extensionId === principal.scope.extensionId
      ) {
        return 'permitted';
      }
      return origin.kind === 'absent' && presentation === 'read' ? 'permitted' : 'refused';
    case 'server-agent':
      return origin.kind === 'absent' ? 'permitted' : 'refused';
  }
}

/*
 * The constant messages of the read-proof refusals — see the module's origin
 * policy for the reason each one reuses. None of them carries the presented
 * value.
 */
const READ_PROOF_REQUIRED_MESSAGE = `A DevTools read must carry the read proof issued with its credential in the ${READ_PROOF_HEADER} header.`;
const READ_PROOF_MALFORMED_MESSAGE = `The ${READ_PROOF_HEADER} header must be exactly one well-formed read proof.`;
const READ_PROOF_MISMATCH_MESSAGE =
  'The read proof is not the one issued with this DevTools credential.';
const READ_PROOF_NOT_PERMITTED_MESSAGE = `Only a DevTools read carries a read proof; this request may not carry the ${READ_PROOF_HEADER} header.`;

/**
 * The next step for every refused read proof, in place of the reused reason's
 * bearer-header hint: only a new pairing issues a proof.
 */
const READ_PROOF_HINT =
  'Pair the Debug Generator DevTools extension again: pairing issues the read proof its reads carry.';

/**
 * The read-proof header rule outside the one case that consults the proof: a
 * {@link READ_PROOF_HEADER} is refused on a request whose principal is not a
 * DevTools one, on an auth-exempt operation (`principal` `null`) and on a write,
 * whatever its value — only a DevTools read presents the proof. A DevTools
 * read that carries one is let through here; whether it is the credential's
 * proof was decided when the credential was authenticated.
 */
function decideReadProofHeader(
  principal: Principal | null,
  presentation: CredentialPresentation,
  header: HeaderRead,
): Result<void, DebuggenError> {
  if (header.kind === 'absent') {
    return ok(undefined);
  }
  return principal?.role === 'devtools' && presentation === 'read'
    ? ok(undefined)
    : refuse('role-not-permitted', READ_PROOF_NOT_PERMITTED_MESSAGE);
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
 * Whether this host reads a drive-rooted path (`C:/work`) as a filesystem
 * location. Only Windows does: elsewhere `realpath('C:/work')` treats `C:` as a
 * relative name under the process's working directory.
 */
const HOST_RESOLVES_DRIVE_PATHS = process.platform === 'win32';

/** A drive-letter prefix, with or without the separator that makes it absolute. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * A drive letter followed by a separator (`C:/…`, `C:\…`). The drive-relative
 * `C:dir`, which Windows resolves against that drive's current directory, does
 * not match.
 */
const DRIVE_ABSOLUTE_PREFIX = /^[A-Za-z]:[\\/]/;

/**
 * A normalised root that is only a drive — what {@link normalizeRoot} makes of
 * `C:/` and `C:\`. It names the drive's root, and is asked about as `C:/`,
 * because a Windows resolver answers the bare `C:` with that drive's current
 * directory instead.
 */
const BARE_DRIVE = /^[A-Za-z]:$/;

/** The one resolver failure {@link canonicalRoot} answers by trying the parent. */
const MISSING_COMPONENT_ERRNO = 'ENOENT';

/**
 * The resolver {@link requireProjectScope} uses when its caller injects none:
 * the host's own `realpath`, which follows every link in the path.
 *
 * A drive-rooted path on a host that is not Windows names no directory, so it
 * is refused the way the {@link RealPathResolver} contract has a resolver refuse
 * any path it cannot resolve — by throwing. The thrown error's `code` is
 * `PATH_OUTSIDE_PROJECT`, not `ENOENT`, so {@link canonicalRoot} refuses at once
 * rather than walking up through `C:`. That makes the refusal independent of
 * the working directory, which could otherwise hold an entry named `C:`.
 *
 * `realpath` answers `ENOENT` both for a path that does not exist and for a
 * **dangling** symbolic link — one whose target does not exist yet. Only the
 * first is a missing component {@link canonicalRoot} may re-append as spelled:
 * a dangling link would be kept under the workspace in spelling and then lead
 * wherever its target is later created. So an `ENOENT` is re-checked with
 * `lstat`, which does not follow a final link: an entry that is there is a
 * link `realpath` could not follow, and it is refused with a non-`ENOENT`
 * failure. A `lstat` failure other than a missing entry (`ENOTDIR`, `EACCES`)
 * propagates as it is, and is refused the same way.
 */
function resolveHostRealPath(absolutePath: string): string {
  if (!HOST_RESOLVES_DRIVE_PATHS && DRIVE_PREFIX.test(absolutePath)) {
    throw new DebuggenError(
      'PATH_OUTSIDE_PROJECT',
      'A drive-rooted path names no directory on this host.',
    );
  }
  try {
    return realpathSync.native(absolutePath);
  } catch (cause) {
    if (
      resolverFailureCode(cause) === MISSING_COMPONENT_ERRNO &&
      lstatSync(absolutePath, { throwIfNoEntry: false }) !== undefined
    ) {
      throw new DebuggenError(
        'PATH_OUTSIDE_PROJECT',
        'A symbolic link on this path points at nothing that exists, so where it leads cannot be established.',
        { cause },
      );
    }
    throw cause;
  }
}

/** The errno a resolver failure carries (`ENOENT`, `EACCES`, …), read structurally. */
function resolverFailureCode(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
}

/**
 * The canonical form of a root {@link normalizeRoot} accepted — every symbolic
 * link in the part of it that exists resolved, the part that does not exist yet
 * re-appended as spelled — or `undefined` when that cannot be established.
 *
 * The resolver is asked about the whole root; each `ENOENT` sets the final
 * component aside and asks about the parent instead, up to the filesystem root
 * (`/`, or the drive's root). The first answer is the canonical form of the
 * longest existing ancestor, and the set-aside components follow it in order.
 *
 * Tolerating a missing tail is what lets an editor name a project it is about to
 * create, and every root a test names without creating it, and it opens no
 * escape: a component that does not exist is not a link, so it redirects
 * nothing, every component that does exist has been resolved, and the root was
 * normalised first, so no `..` in the tail climbs back out. That holds because
 * the resolver's `ENOENT` means "no entry at all": the host resolver
 * ({@link resolveHostRealPath}) turns a dangling link — an entry `realpath`
 * cannot follow — into a different failure, so it is refused rather than
 * re-appended.
 *
 * `undefined` — which every caller turns into the one refusal
 * `project-out-of-scope`, so no answer here becomes a probe of the disk — for:
 * a drive-relative root (`C:dir`); a resolver failure other than `ENOENT`
 * (`EACCES`, `ENOTDIR`, `ELOOP`, the host resolver's drive-path refusal, a
 * throw with no errno); `ENOENT` all the way to the filesystem root; and an
 * answer that is not an absolute local path — a relative or drive-relative
 * answer, or a network share (which {@link normalizeRoot} refuses as a root in
 * any case, so a workspace on a Windows drive mapped to a share is refused
 * rather than contained against a spelling the product never accepts).
 */
function canonicalRoot(root: string, resolveRealPath: RealPathResolver): string | undefined {
  if (DRIVE_PREFIX.test(root) && !BARE_DRIVE.test(root) && !DRIVE_ABSOLUTE_PREFIX.test(root)) {
    return undefined;
  }

  const missing: string[] = [];
  let existing = root;
  for (;;) {
    let resolved: string;
    try {
      resolved = resolveRealPath(BARE_DRIVE.test(existing) ? `${existing}/` : existing);
    } catch (cause) {
      const atFilesystemRoot = existing === '/' || BARE_DRIVE.test(existing);
      if (resolverFailureCode(cause) !== MISSING_COMPONENT_ERRNO || atFilesystemRoot) {
        return undefined;
      }
      missing.unshift(basenamePosix(existing));
      existing = dirnamePosix(existing);
      continue;
    }

    const canonical = normalizeRoot(resolved);
    const driveRelative = DRIVE_PREFIX.test(resolved) && !DRIVE_ABSOLUTE_PREFIX.test(resolved);
    if (canonical === undefined || driveRelative) {
      return undefined;
    }
    return missing.length === 0 ? canonical : joinPosix(canonical, ...missing);
  }
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
 * The acting-tab rule over one read of the {@link ACTING_TAB_HEADER}, in the
 * order that reveals least: a request that names no tab is not refused here
 * (the per-session guard, {@link requireBoundSession}, refuses a DevTools
 * action that needs one); a header on a request whose principal is not a
 * DevTools one — an editor, a server agent, or an auth-exempt operation, which
 * has no principal — is refused whatever its value, because no such caller
 * acts for a tab; and only then is a DevTools request's value parsed, with
 * protocol's own `parseActingTabHeader`. A header sent more than once is
 * refused rather than guessed at, like an ambiguous credential. No refusal
 * carries the presented value.
 *
 * @param principal The resolved principal, or `null` for an auth-exempt operation.
 * @param header The header as {@link readHeader} read it.
 * @returns The acting tab, `undefined` when none was named, or the refusal.
 */
function decideActingTab(
  principal: Principal | null,
  header: HeaderRead,
): Result<number | undefined, DebuggenError> {
  if (header.kind === 'absent') {
    return ok(undefined);
  }
  if (principal?.role !== 'devtools') {
    return refuse('acting-tab-not-permitted');
  }
  if (header.kind === 'ambiguous') {
    return refuse('acting-tab-invalid');
  }
  const parsed = parseActingTabHeader(header.value);
  return isErr(parsed) ? refuse('acting-tab-invalid') : parsed;
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
    /**
     * The SHA-256 digest, lowercase hex, of the read proof issued with the
     * credential ({@link READ_PROOF_HEADER}). Written once, when the credential
     * is inserted, and never updated. Optional only so a credential stored
     * before read proofs existed still parses as a DevTools credential — one
     * whose every read is refused until the extension pairs again.
     */
    readProofDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('project'),
    projectRoot: projectRootFieldSchema,
    /**
     * For a lease — a credential the dev-server launcher minted for a child it
     * supervises and renews while that child runs — the process id of the
     * service that holds it. A lease whose holder is gone is revoked when the
     * service starts ({@link AuthService.revokeOrphanedServerAgentLeases}).
     */
    leaseHolder: z.number().int().positive().optional(),
  }),
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

/** The two columns {@link AuthService.revokeOrphanedServerAgentLeases} reads per row. */
const credentialScopeRowSchema = z.object({ token_hash: z.string(), scope: z.string() });

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
  selectAnyCredentialOfRole: 'SELECT 1 AS present FROM credentials WHERE role = ? LIMIT 1',
  insertCredential:
    'INSERT INTO credentials (token_hash, role, scope, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  deleteCredential: 'DELETE FROM credentials WHERE token_hash = ?',
  deleteCredentialOfRole: 'DELETE FROM credentials WHERE token_hash = ? AND role = ?',
  selectCredentialScopesOfRole: 'SELECT token_hash, scope FROM credentials WHERE role = ?',
  renewLeasedCredential:
    'UPDATE credentials SET expires_at = max(expires_at, ?) WHERE token_hash = ? AND role = ? AND expires_at IS NOT NULL AND expires_at > ?',
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
 * Whether `pid` names a live process: a signal-0 probe, which checks for the
 * process without signalling it. `EPERM` means it exists under another user,
 * so only `ESRCH` (and an unusable id) counts as gone.
 *
 * @param pid The process id a lease recorded as its holder.
 * @returns `false` only when no such process exists.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errnoCodeOf(cause) !== 'ESRCH';
  }
}

/**
 * A filesystem failure on the editor credential file or its journal, keeping a
 * policy refusal from `@debuggen/shared/node` (`FS_UNSAFE_PATH`) as it is and
 * wrapping a raw errno failure. The file's contents never enter the error.
 *
 * @param subject Which file failed: {@link AUTH_FILE_SUBJECT} or {@link AUTH_STAGE_SUBJECT}.
 */
function credentialFileFailure(
  cause: unknown,
  operation: string,
  subject: string = AUTH_FILE_SUBJECT,
): DebuggenError {
  if (DebuggenError.is(cause)) {
    return cause;
  }
  const errno = errnoCodeOf(cause);
  return new DebuggenError('INTERNAL', `The ${subject} could not be ${operation}.`, {
    hint: 'Check that $DEBUGGEN_HOME is a private directory owned by this account.',
    details: { operation, ...(errno === undefined ? {} : { errno }) },
    cause,
  });
}

/**
 * The failure a rotation reports when it stopped before its store transaction
 * committed: nothing was rotated, so every existing credential is still valid.
 * Keeps the underlying code, hint and diagnostic details, and says so.
 */
function rotationNotApplied(cause: DebuggenError): DebuggenError {
  return new DebuggenError(
    cause.code,
    'Credentials were not rotated; every existing credential is still valid.',
    {
      hint:
        cause.hint ??
        'Check that $DEBUGGEN_HOME is a private directory owned by this account and that the session store is writable, then rotate again.',
      details: { operation: 'rotate-credentials', ...cause.details, rotated: false },
      cause,
    },
  );
}

/**
 * What reading one editor credential record from disk — `auth.json` or its
 * journal — established. Only `record` carries the plaintext.
 */
type CredentialFileRead =
  | { readonly kind: 'absent' }
  /** Readable by another account, so its credential may have been read: never trusted. */
  | { readonly kind: 'exposed'; readonly mode: number }
  | { readonly kind: 'not-json' }
  | { readonly kind: 'not-a-record' }
  | { readonly kind: 'record'; readonly record: AuthFileRecord };

/**
 * What recovering the editor credential's journal did.
 *
 * - `none` — there was no journal.
 * - `completed` — the journal's store change had committed; its record is now
 *   in `auth.json`.
 * - `discarded` — the journal's store change never committed, or the journal
 *   was not a record this module wrote; it was removed and `auth.json` is
 *   judged as it stands.
 * - `exposed` — the journal was readable by another account; it was removed,
 *   and neither it nor `auth.json` is trusted, so a new credential is issued.
 */
type StageRecovery = 'none' | 'completed' | 'discarded' | 'exposed';

/** A replacement of the editor credential whose store transaction committed. */
interface CommittedReplacement<T> {
  /** What the store change returned. */
  readonly value: T;
  /**
   * Whether `auth.json` now holds the new record. An `Err` means the store
   * change is durable but the file is behind it: the journal is left in place,
   * and the next recovery publishes it.
   */
  readonly published: Result<void, DebuggenError>;
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
   * Safe to call once per start and idempotent across restarts. Expired
   * credentials are swept first. Then a journal an interrupted replacement left
   * is recovered: published to `auth.json` when its store change committed,
   * discarded when it did not. Only then is `auth.json` judged. A file whose
   * token has no row while the store holds no editor credential at all (a store
   * purged or replaced under it) is re-registered; a file whose token has no row
   * while another editor credential is registered — a file behind the store —
   * is never re-registered, because that would revive a credential a committed
   * rotation retired, so a new credential is minted instead. A file that is
   * unreadable as a record, or readable by another account, and every file
   * after a journal readable by another account, is replaced by a freshly
   * minted credential.
   */
  ensureEditorCredential(): Result<EditorCredentialState, DebuggenError>;

  /**
   * Issues a DevTools credential scoped to one extension id, with the read
   * proof its reads must carry ({@link READ_PROOF_HEADER}); the stored record
   * keeps only the proof's digest.
   */
  issueDevtoolsCredential(extensionId: string): Result<IssuedDevtoolsCredential, DebuggenError>;

  /**
   * Issues a server-agent credential scoped to one project root, for the
   * dev-server launcher to hand to the process it starts.
   */
  issueServerAgentCredential(
    request: ServerAgentCredentialRequest,
  ): Result<IssuedCredential, DebuggenError>;

  /**
   * Extends the lease of one server-agent credential: the dev-server launcher
   * renews the credential of a child it started while that child runs, so a
   * crashed service or a lost revocation leaves the credential valid for at
   * most one lease (AAP §0.5.6).
   *
   * Only a **live, expiring** server-agent credential is renewed. A credential
   * that has lapsed, was revoked or rotated away is never resurrected, and one
   * issued without an expiry is never given one — a renewal cannot turn a
   * dead credential live or a bounded one unbounded.
   *
   * @param token The plaintext credential, which the launcher holds for its child.
   * @param expiresAt The new expiry, in epoch milliseconds; must lie in the future.
   * @returns `true` when the lease was extended, `false` when no live, expiring
   *   server-agent credential has that token.
   */
  renewServerAgentCredential(token: string, expiresAt: number): Result<boolean, DebuggenError>;

  /**
   * Revokes exactly one server-agent credential, identified by its token —
   * what the launcher calls when the process it started exits or is stopped.
   *
   * Scoped to the departing child's own credential: another credential of the
   * same project — a second launched child's, or one minted for a dev server
   * the developer started themselves — keeps working. Only a `server-agent`
   * row is ever deleted by this method.
   *
   * @param token The plaintext credential being revoked.
   * @returns `true` when a credential was deleted, `false` when none had that
   *   token (already revoked, rotated away or swept): either way it no longer
   *   authenticates.
   */
  revokeServerAgentCredential(token: string): Result<boolean, DebuggenError>;

  /**
   * Releases one `POST /dev-server/credential` credential at its holder's
   * request — the store half of `POST /credentials/release`, which
   * `scripts/dev-instrumented.mjs` calls as the dev server it started exits
   * (a server-agent credential expires when its process exits).
   *
   * Narrower than {@link revokeServerAgentCredential}, on purpose: in one
   * store transaction the row is read by the token's digest and deleted
   * **only** when it is a live `server-agent` credential scoped to a project
   * and is **not a lease** — a credential with a `leaseHolder` belongs to a
   * child the dev-server launcher started and supervises, and only that
   * launcher revokes it, so a caller that learned a launched child's token
   * cannot end its telemetry through this door. An expired row is not live
   * and is left to the expiry sweep. Only when a row is deleted are the
   * sockets authenticated with it closed with `WS_CLOSE_UNAUTHORIZED`.
   *
   * Synchronous from entry to commit, so a caller that has just passed
   * {@link requireLiveCredential} reaches the store with nothing interleaved.
   * The token is hashed and dropped: it is never logged, stored or put in an
   * error.
   *
   * @param token The plaintext credential to release.
   * @returns `true` when a credential was deleted by this call; `false` when
   *   none was — a malformed, unknown, expired, lapsed or rotated-away token,
   *   another role's credential, or a launched child's lease all answer the
   *   same — and the store's own failure (`STORE_ERROR`) when the transaction
   *   could not run.
   */
  releaseServerAgentCredential(token: string): Result<boolean, DebuggenError>;

  /**
   * Revokes every server-agent **lease** whose holder process is gone — what
   * the service runs on start, before it serves (AAP §0.5.6: a launched
   * child's credential stops working when its process exits or is stopped).
   *
   * A lease is held by the service process that launched its child. When that
   * process crashed, nothing supervises the child any more and nothing retries
   * a revocation it could not finish, so its lease is revoked here instead of
   * authenticating until it lapses. A lease whose holder still runs — another
   * service on the same state root — is left to that holder. Credentials that
   * are not leases (a `POST /dev-server/credential` token for a dev server the
   * developer started) are never touched.
   *
   * @returns How many leases were revoked.
   */
  revokeOrphanedServerAgentLeases(): Result<number, DebuggenError>;

  /**
   * Revokes every server-agent credential scoped to `projectRoot` — reserved
   * for tearing a whole project down. A launched child's exit revokes only its
   * own credential, through {@link revokeServerAgentCredential}.
   *
   * @returns How many credentials were revoked.
   */
  revokeServerAgentCredentials(projectRoot: string): Result<number, DebuggenError>;

  /** {@link isAllowedOrigin}, for callers that hold the service. */
  isAllowedOrigin(origin: string | undefined): boolean;

  /**
   * The HTTP middleware core: origin policy first, then the exemption, then the
   * bearer credential — with, for every DevTools read, the
   * {@link READ_PROOF_HEADER} issued with that credential at pairing — and the
   * operation's role table, then the read-proof header rule (only on a DevTools
   * read) and last the {@link ACTING_TAB_HEADER} rule — only a DevTools
   * principal may name an acting tab, and only as one well-formed tab id.
   *
   * @returns The principal, or `null` for an auth-exempt operation.
   */
  authorizeHttpRequest(request: HttpAuthorizationRequest): Result<Principal | null, DebuggenError>;

  /**
   * Authenticates a `client.hello`: payload shape, protocol version, origin,
   * credential, and the claims the hello makes against the credential's role
   * and scope. An editor principal returned here carries the workspace folder
   * its hello announced. A DevTools hello is accepted only from the issuing
   * extension's origin; no hello carries or registers a read proof.
   */
  authorizeHello(request: HelloAuthorizationRequest): Result<Principal, DebuggenError>;

  /**
   * Records an editor connection's announced workspace folders so HTTP requests
   * presenting the same credential may act under them, until the announcement
   * is released — at once by `release()`, or once its bounded lease has passed
   * by `releaseAfter(leaseMs)`.
   */
  announceWorkspace(principal: Principal): Result<WorkspaceAnnouncement, DebuggenError>;

  /** Mints a one-time pairing code, stored only as its digest. */
  startPairing(): Result<PairingCode, DebuggenError>;

  /**
   * Redeems a pairing code for a DevTools credential scoped to the redeeming
   * extension's id: single use, time-limited and rate-limited by one
   * service-wide lockout ({@link PAIRING_MAX_FAILURES}) that no choice of
   * `Origin` escapes. The code is compared exactly as submitted. The credential
   * is issued with a fresh read proof, returned here once and stored only as a
   * digest.
   */
  completePairing(
    request: PairingCompletionRequest,
  ): Result<IssuedDevtoolsCredential, DebuggenError>;

  /**
   * Deletes every credential and pairing code, regenerates `auth.json`, and
   * closes every open socket with `WS_CLOSE_UNAUTHORIZED` through the injected
   * revoker. Paired Chrome extensions must pair again and launched dev servers
   * must be relaunched (AAP §0.5.6).
   *
   * The new editor credential is staged in the journal, the store change
   * commits, the journal's record is published to `auth.json`, the journal is
   * removed, and only then are sockets closed — so the editor client, which
   * re-reads `auth.json` when it is closed with 4401, finds the new token.
   *
   * @returns The outcome, or an `Err` whose message says which side of the
   * commit it stopped on. Before the commit (a journal that cannot be written,
   * a store that cannot commit, an earlier journal that cannot be finished):
   * nothing was rotated and every credential is still valid. After it: every
   * old credential is refused and every socket was closed, but `auth.json`
   * could not be updated — the journal stays, and restarting the service
   * finishes the rotation — or the revoker failed and some connections may
   * still be open. A journal that cannot be removed after `auth.json` was
   * updated is not a failure: the rotation is complete, and the leftover is
   * logged and cleared by the next recovery.
   */
  rotateAll(): Result<RotationOutcome, DebuggenError>;

  /**
   * The revocation fence: whether the credential a principal was resolved
   * from is still live **now** — its row still stored, still of the
   * principal's role, not expired.
   *
   * A principal is a snapshot. {@link createAuthMiddleware} resolves it once,
   * before the handler runs, and a handler that reads a request body then
   * awaits the client for as long as the client takes to send it. A rotation
   * ({@link rotateAll}), a revocation ({@link revokeServerAgentCredentials}),
   * a release ({@link releaseServerAgentCredential}) or an expiry can retire
   * the credential inside that gap, and acting on the snapshot afterwards
   * would let a credential that no longer exists mint a credential, run a
   * sweep or rotate again — exactly what the service's
   * revocation boundary forbids.
   *
   * Every route therefore calls this **between reading its body and its side
   * effect**, with no `await` between the check and the call that acts. The
   * check is synchronous, and so is every retirement (each one store
   * statement or transaction on the one `node:sqlite` connection), so no
   * retirement can interleave between a check that passed and the synchronous
   * work that follows it.
   *
   * Nothing presented or stored leaves this method: the lookup binds the
   * principal's digest as a parameter, a refusal carries only its reason, and
   * the log record names the reason and the role — never the digest.
   *
   * @param principal The principal the middleware (or `client.hello`) resolved.
   * @returns `ok` while the credential is live; otherwise `unknown-credential`
   * (401) when its row is gone or now holds another role, `corrupt-credential`
   * (401) when the row no longer validates, `expired-credential` (401) once its
   * expiry has passed, or the store's own failure (`STORE_ERROR`, answered
   * `500`) when the row cannot be read.
   *
   * @example
   * ```ts
   * const body = await readBody(c, operation);
   * const live = auth.requireLiveCredential(principal);
   * if (isErr(live)) {
   *   const { status, body: refusal } = authErrorResponse(live.error);
   *   return c.json(refusal, status);
   * }
   * sideEffect(body); // called with no await after the check
   * ```
   */
  requireLiveCredential(principal: Principal): Result<void, DebuggenError>;

  /**
   * Drops the in-memory lockout ledger, announcements and registered read
   * proofs. Owns no timer or socket.
   */
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
  /**
   * This service's process id, recorded as the holder of every lease it
   * issues. Defaults to `process.pid`.
   */
  readonly processId?: number | undefined;
  /**
   * Whether a process id names a live process — how a lease's holder is judged
   * gone. Defaults to a signal-0 probe (`process.kill(pid, 0)`).
   */
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
  /**
   * The credential file writes, a test seam ({@link CredentialFileSystem}).
   * Defaults to {@link SECURE_CREDENTIAL_FILE_SYSTEM}; production never sets it.
   */
  readonly fileSystem?: CredentialFileSystem | undefined;
}

/**
 * The real {@link CredentialFileSystem}: `writeSecureFileAtomic`, which
 * verifies the parent chain, writes an unpredictably named `0600` sibling and
 * renames it over the target; and `unlinkSync`, which removes the directory
 * entry itself and never follows a link at it. The directory both act in is
 * the one {@link CredentialAuthority} verified private before either runs.
 */
const SECURE_CREDENTIAL_FILE_SYSTEM: CredentialFileSystem = Object.freeze({
  writeSecureFile(path: string, data: string, upTo: string): void {
    writeSecureFileAtomic(path, data, { upTo });
  },
  removeFile(path: string): void {
    unlinkSync(path);
  },
});

/** The service-wide pairing-failure record ({@link PAIRING_MAX_FAILURES}). */
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

/**
 * Whether a submitted code, exactly as sent, is {@link PAIRING_CODE_LENGTH}
 * characters of {@link PAIRING_CODE_ALPHABET}. Nothing is trimmed or
 * case-folded first: whitespace and lower-case letters are outside the
 * alphabet, so a padded or lower-case submission is not well formed.
 */
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
  readonly processId: number;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly files: CredentialFileSystem;
}

/**
 * The {@link AuthService} implementation. Not exported: {@link createAuthService}
 * validates its dependencies first.
 */
class CredentialAuthority implements AuthService {
  readonly #store: Store;

  readonly #authFilePath: string;

  /** `auth.json`'s journal: {@link #authFilePath} + {@link AUTH_FILE_STAGE_SUFFIX}. */
  readonly #stagePath: string;

  readonly #debuggenHome: string;

  readonly #logger: Logger;

  readonly #revoker: ConnectionRevoker | undefined;

  readonly #clock: () => number;

  readonly #random: (size: number) => Uint8Array;

  /** The process id this service records as the holder of the leases it issues. */
  readonly #processId: number;

  readonly #isProcessAlive: (pid: number) => boolean;

  readonly #files: CredentialFileSystem;

  /**
   * The one service-wide pairing-failure record ({@link PAIRING_MAX_FAILURES}):
   * every failed redemption counts here, whatever origin presented it.
   */
  #pairingLedger: PairingLedgerEntry = newLedgerEntry();

  /**
   * Announced workspace folders per editor credential digest: each folder's
   * live-announcement count and lease. An inner map is replaced, never reused,
   * once cleared, so an announcement can tell that its own map is gone.
   */
  readonly #announcements = new Map<string, Map<string, FolderStanding>>();

  constructor(init: CredentialAuthorityInit) {
    this.#store = init.store;
    this.#authFilePath = init.authFilePath;
    this.#stagePath = `${init.authFilePath}${AUTH_FILE_STAGE_SUFFIX}`;
    this.#debuggenHome = init.debuggenHome;
    this.#logger = init.logger;
    this.#revoker = init.revoker;
    this.#clock = init.clock;
    this.#random = init.random;
    this.#processId = init.processId;
    this.#isProcessAlive = init.isProcessAlive;
    this.#files = init.files;
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
   * A fresh DevTools read proof: {@link READ_PROOF_BYTES} random bytes as
   * unpadded base64url, the {@link READ_PROOF_HEADER} value the credential's
   * reads must carry. Drawn from the same source as the credential, and
   * checked against the wire shape before it can be issued.
   */
  #mintReadProof(): Result<string, DebuggenError> {
    const bytes = this.#draw(READ_PROOF_BYTES);
    if (isErr(bytes)) {
      return bytes;
    }
    const proof = Buffer.from(bytes.value).toString('base64url');
    if (!isReadProof(proof)) {
      return err(new DebuggenError('INTERNAL', 'A minted read proof did not have the wire shape.'));
    }
    return ok(proof);
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

  /**
   * The workspace folders in the credential's scope, sorted and frozen: those a
   * live connection announces, and those a settled announcement's lease still
   * covers. A folder whose lease has passed with no live announcement is pruned
   * here — the lazy expiry that spares this module a timer.
   */
  #announcedFolders(tokenHash: string): readonly string[] {
    const standings = this.#announcements.get(tokenHash);
    if (standings === undefined) {
      return Object.freeze([]);
    }
    const now = this.#now();
    const folders: string[] = [];
    for (const [folder, standing] of standings) {
      if (standing.live > 0 || standing.leaseUntil > now) {
        folders.push(folder);
      } else {
        // Deleting the entry being visited is safe for a Map iterator.
        standings.delete(folder);
      }
    }
    if (standings.size === 0) {
      this.#announcements.delete(tokenHash);
    }
    return Object.freeze(folders.sort());
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
   * expiry, whether the credential's role may be presented from this origin in
   * this way ({@link originDecisionFor}) and, when the caller demands it for a
   * read, the read proof `readProof` carries against the one issued with a
   * DevTools credential ({@link #requireReadProof}).
   *
   * @param readProof The request's {@link READ_PROOF_HEADER} when the operation
   * is a read a DevTools credential may make, which demands the proof of a
   * DevTools principal; `undefined` when nothing demands one (every write, and
   * every hello).
   */
  #authenticate(
    token: string,
    origin: OriginClass,
    presentation: CredentialPresentation,
    readProof?: HeaderRead,
  ): Result<Principal, DebuggenError> {
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
    if (originDecisionFor(origin, principal.value, presentation) === 'refused') {
      return refuse('origin-not-permitted-for-role');
    }
    if (principal.value.role === 'devtools' && readProof !== undefined) {
      const stored = parseStoredScope(row.data.scope);
      const proven = this.#requireReadProof(
        stored?.kind === 'extension' ? stored.readProofDigest : undefined,
        readProof,
      );
      if (isErr(proven)) {
        return proven;
      }
    }
    return principal;
  }

  /**
   * The read-proof rule of a DevTools read, `Origin` or not: the request must
   * carry exactly one well-formed {@link READ_PROOF_HEADER} whose SHA-256 digest
   * is the one stored with the credential when it was issued.
   *
   * - no header — `missing-credential`;
   * - several headers, or one that is not a read proof — `malformed-credential`;
   * - a well-formed proof whose digest is not the stored one, or a credential
   *   stored before read proofs existed (no digest) — `unknown-credential`.
   *
   * Each carries {@link READ_PROOF_HINT}, to pair the extension again.
   *
   * All three are `UNAUTHORIZED` (401): the proof is half of what the pairing
   * issued, and a read without the right half is not authenticated. The digest
   * is compared in constant time, and the header's value is never logged or
   * interpolated.
   *
   * @param storedDigest The digest stored with the credential, if any.
   * @param header The request's {@link READ_PROOF_HEADER}.
   */
  #requireReadProof(
    storedDigest: string | undefined,
    header: HeaderRead,
  ): Result<void, DebuggenError> {
    if (header.kind === 'absent') {
      return refuse('missing-credential', READ_PROOF_REQUIRED_MESSAGE, READ_PROOF_HINT);
    }
    if (header.kind === 'ambiguous' || !isReadProof(header.value)) {
      return refuse('malformed-credential', READ_PROOF_MALFORMED_MESSAGE, READ_PROOF_HINT);
    }
    if (storedDigest === undefined || !digestsEqual(storedDigest, sha256Hex(header.value))) {
      return refuse('unknown-credential', READ_PROOF_MISMATCH_MESSAGE, READ_PROOF_HINT);
    }
    return ok(undefined);
  }

  /**
   * Logs a refusal by its reason; never by anything the client presented —
   * with one bounded exception: a refusal decided by the request's `Origin`
   * ({@link ORIGIN_REFUSAL_REASONS}) names that origin in its
   * {@link describeRefusedOrigin} rendering (`scheme://host`, never a path,
   * query or credential), because *which* page knocked is the one fact such a
   * record exists to tell.
   *
   * @param message The record's constant message.
   * @param error The refusal.
   * @param fields Context the caller already holds (operation, ref, role).
   * @param origin The request's raw `Origin`, when the caller has one.
   */
  #logRefusal(
    message: string,
    error: DebuggenError,
    fields: Record<string, unknown> = {},
    origin?: string,
  ): void {
    const reason = authFailureReasonOf(error);
    const namesOrigin =
      origin !== undefined &&
      origin !== '' &&
      reason !== undefined &&
      ORIGIN_REFUSAL_REASONS.has(reason);
    this.#logger.warn(message, {
      ...fields,
      reason: reason ?? 'not-a-refusal',
      errorCode: error.code,
      ...(namesOrigin ? { origin: describeRefusedOrigin(origin) } : {}),
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
   * Reads one editor credential record — `auth.json` or its journal — without
   * following a link at its final component, and without logging: each caller
   * reports what the read established in its own terms.
   *
   * @param path The file to read.
   * @param subject How failures name it ({@link AUTH_FILE_SUBJECT} or {@link AUTH_STAGE_SUBJECT}).
   * @returns What is there. The group and other permission bits are judged
   * before a byte is read, so an exposed file's content is never parsed. Only an
   * unsafe path — a link, a foreign owner, a second hard link — or an unreadable
   * file is an `Err`, because those need the developer rather than a new
   * credential.
   */
  #readCredentialRecord(path: string, subject: string): Result<CredentialFileRead, DebuggenError> {
    let state;
    try {
      state = inspectPrivateFileNoFollow(path);
    } catch (cause) {
      return err(credentialFileFailure(cause, 'inspected', subject));
    }
    if (state === undefined) {
      return ok({ kind: 'absent' });
    }
    if (isPosixHost() && (state.mode & GROUP_OR_OTHER_PERMISSION_BITS) !== 0) {
      return ok({ kind: 'exposed', mode: state.mode });
    }

    let bytes: Buffer;
    try {
      bytes = readFileNoFollow(path);
    } catch (cause) {
      if (errnoCodeOf(cause) === 'ENOENT') {
        return ok({ kind: 'absent' });
      }
      return err(credentialFileFailure(cause, 'read', subject));
    }

    let json: unknown;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      return ok({ kind: 'not-json' });
    }
    const record = authFileSchema.safeParse(json);
    return ok(record.success ? { kind: 'record', record: record.data } : { kind: 'not-a-record' });
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
    const read = this.#readCredentialRecord(this.#authFilePath, AUTH_FILE_SUBJECT);
    if (isErr(read)) {
      return read;
    }
    const found = read.value;
    switch (found.kind) {
      case 'absent':
        return ok(undefined);
      case 'exposed':
        this.#logger.warn(
          'the editor credential file was readable by other accounts; its credential is discarded and a new one issued',
          { mode: found.mode },
        );
        return ok(undefined);
      case 'not-json':
        this.#logger.warn(
          'the editor credential file is not valid JSON; a new credential is issued',
        );
        return ok(undefined);
      case 'not-a-record':
        this.#logger.warn(
          'the editor credential file is not a record this service wrote; a new credential is issued',
        );
        return ok(undefined);
      case 'record':
        return ok(found.record);
    }
  }

  /**
   * Writes one editor credential record to `path` — the journal or `auth.json`
   * — atomically at `0600`, and confirms the result is a private, regular,
   * single-link file.
   *
   * Never called inside a store transaction: a file cannot be rolled back with
   * the rows, which is the whole reason replacements are journaled (see
   * {@link #replaceEditorCredential}).
   *
   * @param subject How failures name the file.
   * @param verifyOperation The `details.operation` of a verification failure.
   * @throws {DebuggenError} `FS_UNSAFE_PATH` or `INTERNAL`; the record never
   * enters the error.
   */
  #writeCredentialFile(
    path: string,
    record: AuthFileRecord,
    subject: string,
    verifyOperation: string,
  ): void {
    try {
      this.#files.writeSecureFile(path, `${JSON.stringify(record, null, 2)}\n`, this.#debuggenHome);
    } catch (cause) {
      throw credentialFileFailure(cause, 'written', subject);
    }

    let state;
    try {
      state = inspectPrivateFileNoFollow(path);
    } catch (cause) {
      throw credentialFileFailure(cause, 'verified after writing', subject);
    }
    if (state === undefined || (isPosixHost() && state.mode !== SECURE_FILE_MODE)) {
      throw new DebuggenError(
        'FS_UNSAFE_PATH',
        `The ${subject} was not left private after it was written.`,
        {
          hint: 'Check that $DEBUGGEN_HOME is a private directory owned by this account.',
          details: { operation: verifyOperation },
        },
      );
    }
  }

  /**
   * Step 1 of a replacement: writes the new record to the journal. Runs before
   * the store transaction and outside it.
   *
   * @returns `ok` when the journal holds the record. On failure the journal is
   * removed and nothing else has changed. Removing it is always safe: a failed
   * atomic write leaves the previous journal or none, and every caller
   * recovered the previous one first, so it is either already in `auth.json`
   * or uncommitted; a failed verification leaves this record, whose credential
   * no row holds.
   */
  #stageRecord(record: AuthFileRecord): Result<void, DebuggenError> {
    try {
      this.#writeCredentialFile(this.#stagePath, record, AUTH_STAGE_SUBJECT, 'verify-auth-stage');
      return ok(undefined);
    } catch (cause) {
      const error = credentialFileFailure(cause, 'written', AUTH_STAGE_SUBJECT);
      this.#logger.error('the editor credential journal could not be written', {
        errorCode: error.code,
      });
      this.#removeStage();
      return err(error);
    }
  }

  /**
   * Step 3 of a replacement, and the completion of an interrupted one: writes
   * a record whose store change has committed to `auth.json`, trying
   * {@link PUBLISH_ATTEMPTS} times.
   *
   * @returns `ok` when `auth.json` holds the record; otherwise the last
   * failure, with the journal left untouched for the next recovery.
   */
  #publishAuthFile(record: AuthFileRecord): Result<void, DebuggenError> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        this.#writeCredentialFile(
          this.#authFilePath,
          record,
          AUTH_FILE_SUBJECT,
          'verify-auth-file',
        );
        return ok(undefined);
      } catch (cause) {
        const error = credentialFileFailure(cause, 'written');
        if (attempt >= PUBLISH_ATTEMPTS) {
          this.#logger.error(
            'the editor credential file is behind the credential store; the journal is kept for the next start',
            { attempts: attempt, errorCode: error.code },
          );
          return err(error);
        }
        this.#logger.warn('the editor credential file could not be updated; retrying', {
          attempt,
          errorCode: error.code,
        });
      }
    }
  }

  /**
   * Step 4 of a replacement: removes the journal. An absent journal counts as
   * removed.
   *
   * A failure is logged by its errno and never returned: every journal this
   * leaves behind is safe for the next recovery to judge — one whose store
   * change committed is published again (to the same content), one whose
   * change never committed is discarded.
   */
  #removeStage(): void {
    try {
      this.#files.removeFile(this.#stagePath);
    } catch (cause) {
      const errno = errnoCodeOf(cause);
      if (errno === 'ENOENT') {
        return;
      }
      this.#logger.warn(
        'the editor credential journal could not be removed; the next recovery judges it again',
        { errno: errno ?? 'unknown' },
      );
    }
  }

  /**
   * Whether a validated `credentials` row is a live editor credential: the
   * editor role, the machine-user scope and no expiry reached.
   */
  #isLiveEditorRow(row: CredentialRow): boolean {
    const expired = row.expires_at !== null && row.expires_at <= this.#now();
    return (
      row.role === 'vscode' && parseStoredScope(row.scope)?.kind === 'machine-user' && !expired
    );
  }

  /**
   * Finishes or abandons a replacement of the editor credential that an
   * earlier call — in this process, or in one that died — left journaled.
   * Runs at every start before `auth.json` is judged, and before every
   * rotation, so no replacement ever writes its journal over a committed
   * record `auth.json` does not hold yet.
   *
   * Whether the journal's store change committed is read from the store: the
   * transaction inserted the journal's editor row together with every deletion
   * it made, so a live editor row for the journal's credential means the whole
   * change committed, and its absence means none of it did.
   *
   * Logs what it did, never the token, its digest or the file's content.
   *
   * @returns The {@link StageRecovery}; an `Err` for an unsafe or unreadable
   * journal, a store failure, or a committed record that could not be
   * published — in every one of those cases `auth.json` is not yet safe to
   * judge, so the journal stays.
   */
  #recoverStagedCredential(): Result<StageRecovery, DebuggenError> {
    const read = this.#readCredentialRecord(this.#stagePath, AUTH_STAGE_SUBJECT);
    if (isErr(read)) {
      this.#logger.error('the editor credential journal is not safe to read', {
        errorCode: read.error.code,
      });
      return read;
    }
    const found = read.value;
    switch (found.kind) {
      case 'absent':
        return ok('none');
      case 'exposed':
        this.#logger.warn(
          'the editor credential journal was readable by other accounts; it is discarded and a new editor credential issued',
          { mode: found.mode },
        );
        this.#removeStage();
        return ok('exposed');
      case 'not-json':
      case 'not-a-record':
        this.#logger.warn(
          'the editor credential journal is not a record this service wrote; it is discarded',
        );
        this.#removeStage();
        return ok('discarded');
      case 'record':
        break;
    }

    const tokenHash = sha256Hex(found.record.token);
    const raw = this.#guard('read-journaled-credential', () =>
      this.#store.statement(SQL.selectCredential).get(tokenHash),
    );
    if (isErr(raw)) {
      return raw;
    }
    const row = raw.value === undefined ? undefined : credentialRowSchema.safeParse(raw.value);
    if (row?.success !== true || !this.#isLiveEditorRow(row.data)) {
      this.#logger.info('discarded an uncommitted editor credential replacement');
      this.#removeStage();
      return ok('discarded');
    }

    const published = this.#publishAuthFile(found.record);
    if (isErr(published)) {
      return published;
    }
    this.#removeStage();
    this.#logger.info('completed an interrupted editor credential replacement');
    return ok('completed');
  }

  /**
   * Replaces the editor credential across its two resources, in the order the
   * module documentation sets out: stage the record in the journal, commit
   * `change` in one store transaction, publish the record to `auth.json`,
   * remove the journal. No file is touched inside the transaction.
   *
   * @param record The new `auth.json` record.
   * @param operation The store operation's name, for {@link #guard}.
   * @param change The store change: it must insert `record`'s editor row, which
   * is the commit marker {@link #recoverStagedCredential} reads.
   * @returns An `Err` when the change did not commit — the journal could not be
   * written or the transaction failed — in which case nothing changed. Once it
   * committed, the {@link CommittedReplacement}, whose `published` says whether
   * `auth.json` caught up.
   */
  #replaceEditorCredential<T>(
    record: AuthFileRecord,
    operation: string,
    change: () => T,
  ): Result<CommittedReplacement<T>, DebuggenError> {
    const staged = this.#stageRecord(record);
    if (isErr(staged)) {
      return staged;
    }

    const committed = this.#guard(operation, () => this.#store.transaction(change));
    if (isErr(committed)) {
      // The transaction rolled back and auth.json was never touched, so the
      // journal is the only trace of the attempt; removing it restores the state
      // exactly. A journal that cannot be removed names a credential no row
      // holds, which the next recovery discards.
      this.#removeStage();
      return committed;
    }

    const published = this.#publishAuthFile(record);
    if (!isErr(published)) {
      this.#removeStage();
    }
    return ok(Object.freeze({ value: committed.value, published }));
  }

  /**
   * Adopts the credential an existing `auth.json` holds.
   *
   * @returns The editor principal, or `undefined` when the file's credential
   * cannot be adopted (its row belongs to another role, is corrupt or has
   * expired, or it has no row while another editor credential is registered)
   * and a new one must be minted.
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
      // The file names a credential the store does not hold. Two very different
      // states look like that, and the store tells them apart — inside the one
      // transaction that acts on the answer, so it cannot change in between.
      //
      // - No editor credential at all: the store was purged or replaced under
      //   the file. The file is the only holder of this credential, so it is
      //   registered again rather than replaced.
      // - Another editor credential is registered: the file is *behind* the
      //   store — a committed replacement whose journal was lost before
      //   auth.json caught up. That commit retired the file's credential, and
      //   registering it again would revive it, so a new one is minted instead.
      const registered = this.#guard('reregister-editor-credential', () =>
        this.#store.transaction(() => {
          if (this.#store.statement(SQL.selectAnyCredentialOfRole).get('vscode') !== undefined) {
            return false;
          }
          this.#insertCredential(
            tokenHash,
            'vscode',
            MACHINE_USER_STORED_SCOPE,
            record.issuedAt,
            null,
          );
          return true;
        }),
      );
      if (isErr(registered)) {
        return registered;
      }
      if (!registered.value) {
        this.#logger.warn(
          'auth.json holds a credential the store retired in favour of another; a new editor credential is issued',
        );
        return ok(undefined);
      }
      this.#logger.info('re-registered the editor credential held in auth.json');
      return ok(this.#editorPrincipal(tokenHash, record.issuedAt));
    }

    const row = credentialRowSchema.safeParse(raw.value);
    if (!row.success) {
      return ok(undefined);
    }
    if (!this.#isLiveEditorRow(row.data)) {
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

  /**
   * Mints a new editor credential that replaces every editor row and
   * `auth.json`, through the journaled {@link #replaceEditorCredential}: the
   * row commits first and `auth.json` is published after it, so neither a file
   * without a row nor a row without a file survives a failure.
   *
   * @returns The new principal; an `Err` when nothing changed, or when the row
   * committed but `auth.json` could not be written — the journal then stays and
   * the next start publishes it.
   */
  #mintEditorCredential(): Result<EditorPrincipal, DebuggenError> {
    const token = this.#mintToken();
    if (isErr(token)) {
      return token;
    }
    const tokenHash = sha256Hex(token.value);
    const issuedAt = this.#now();
    const record: AuthFileRecord = { version: AUTH_FILE_VERSION, token: token.value, issuedAt };

    const replaced = this.#replaceEditorCredential(record, 'mint-editor-credential', () => {
      this.#store.statement(SQL.deleteCredentialsByRole).run('vscode');
      this.#insertCredential(tokenHash, 'vscode', MACHINE_USER_STORED_SCOPE, issuedAt, null);
    });
    if (isErr(replaced)) {
      return replaced;
    }
    if (isErr(replaced.value.published)) {
      return replaced.value.published;
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

    // A replacement the previous run did not finish is settled before auth.json
    // is trusted: otherwise a file behind a committed rotation would be judged
    // as if the rotation had never happened.
    const recovered = this.#recoverStagedCredential();
    if (isErr(recovered)) {
      return recovered;
    }

    // An exposed journal may have handed its credential — which may also be the
    // one auth.json holds — to another account, so nothing on disk is adopted.
    if (recovered.value !== 'exposed') {
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

  issueDevtoolsCredential(extensionId: string): Result<IssuedDevtoolsCredential, DebuggenError> {
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
    const readProof = this.#mintReadProof();
    if (isErr(readProof)) {
      return readProof;
    }
    const tokenHash = sha256Hex(token.value);
    const issuedAt = this.#now();
    const stored = this.#guard('issue-devtools-credential', () => {
      this.#insertCredential(
        tokenHash,
        'devtools',
        { kind: 'extension', extensionId, readProofDigest: sha256Hex(readProof.value) },
        issuedAt,
        null,
      );
    });
    if (isErr(stored)) {
      return stored;
    }
    this.#logger.info('issued a DevTools credential', { extensionId });
    return ok(Object.freeze({ token: token.value, readProof: readProof.value }));
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
    const lease = request.lease === true;
    if (lease && expiresAt === null) {
      // A lease is bounded by definition: renewal extends it, nothing makes it unbounded.
      return err(
        new DebuggenError('INTERNAL', 'A server-agent credential lease must carry an expiry.', {
          details: { problem: 'lease-without-expiry' },
        }),
      );
    }

    const token = this.#mintToken();
    if (isErr(token)) {
      return token;
    }
    const tokenHash = sha256Hex(token.value);
    const scope: StoredScope = lease
      ? { kind: 'project', projectRoot, leaseHolder: this.#processId }
      : { kind: 'project', projectRoot };
    const stored = this.#guard('issue-server-agent-credential', () => {
      this.#insertCredential(tokenHash, 'server-agent', scope, issuedAt, expiresAt);
    });
    if (isErr(stored)) {
      return stored;
    }
    this.#logger.info('issued a server-agent credential', {
      projectRoot,
      expires: expiresAt !== null,
      lease,
    });
    return ok(
      Object.freeze(
        expiresAt === null ? { token: token.value } : { token: token.value, expiresAt },
      ),
    );
  }

  renewServerAgentCredential(token: string, expiresAt: number): Result<boolean, DebuggenError> {
    if (!presentedCredentialSchema.safeParse(token).success) {
      // A value of the wrong shape was never issued, so there is nothing live to renew.
      return ok(false);
    }
    const now = this.#now();
    const requested = Math.floor(expiresAt);
    if (!Number.isSafeInteger(requested) || requested <= now) {
      return err(
        new DebuggenError('INTERNAL', 'A server-agent credential lease must end in the future.', {
          details: { problem: 'expiry-not-in-future' },
        }),
      );
    }

    const tokenHash = sha256Hex(token);
    // One statement: the row must still be a live, expiring server-agent
    // credential at the moment it is extended, so a revocation or a lapse that
    // won the race is never undone.
    const renewed = this.#guard(
      'renew-server-agent-credential',
      () =>
        Number(
          this.#store
            .statement(SQL.renewLeasedCredential)
            .run(requested, tokenHash, 'server-agent', now).changes,
        ) > 0,
    );
    if (isErr(renewed)) {
      return renewed;
    }
    if (renewed.value) {
      this.#logger.debug('renewed a server-agent credential lease', { expiresAt: requested });
    } else {
      this.#logger.info('a server-agent credential lease was not renewed: it is no longer live');
    }
    return renewed;
  }

  revokeServerAgentCredential(token: string): Result<boolean, DebuggenError> {
    if (!presentedCredentialSchema.safeParse(token).success) {
      // A value of the wrong shape was never issued, so nothing authenticates with it.
      return ok(false);
    }

    const tokenHash = sha256Hex(token);
    const revoked = this.#guard('revoke-server-agent-credential', () =>
      this.#store.transaction((): { readonly deleted: boolean; readonly projectRoot?: string } => {
        const raw: unknown = this.#store.statement(SQL.selectCredential).get(tokenHash);
        const row = credentialRowSchema.safeParse(raw);
        if (!row.success || row.data.role !== 'server-agent') {
          // Absent, unreadable or another role's row: this method only ever
          // deletes the one server-agent credential it was handed.
          return { deleted: false };
        }
        this.#store.statement(SQL.deleteCredentialOfRole).run(tokenHash, 'server-agent');
        const scope = parseStoredScope(row.data.scope);
        const projectRoot =
          scope?.kind === 'project' ? normalizeRoot(scope.projectRoot) : undefined;
        return projectRoot === undefined ? { deleted: true } : { deleted: true, projectRoot };
      }),
    );
    if (isErr(revoked)) {
      return revoked;
    }
    // Whether or not a row was deleted just now, nothing may stay connected on
    // this credential: close its sockets, and only its sockets.
    const socketsClosed = this.#closeConnectionsOf(tokenHash);
    this.#logger.info('revoked a server-agent credential', {
      revoked: revoked.value.deleted,
      socketsClosed,
      ...(revoked.value.projectRoot === undefined
        ? {}
        : { projectRoot: revoked.value.projectRoot }),
    });
    return ok(revoked.value.deleted);
  }

  releaseServerAgentCredential(token: string): Result<boolean, DebuggenError> {
    if (!presentedCredentialSchema.safeParse(token).success) {
      // A value of the wrong shape was never issued, so nothing live has it.
      return ok(false);
    }

    const tokenHash = sha256Hex(token);
    const now = this.#now();
    const released = this.#guard('release-server-agent-credential', () =>
      this.#store.transaction((): { readonly deleted: boolean; readonly projectRoot?: string } => {
        const raw: unknown = this.#store.statement(SQL.selectCredential).get(tokenHash);
        const row = credentialRowSchema.safeParse(raw);
        if (!row.success || row.data.role !== 'server-agent') {
          // Absent, unreadable or another role's row: only a server-agent
          // credential is ever released here.
          return { deleted: false };
        }
        const scope = parseStoredScope(row.data.scope);
        if (scope?.kind !== 'project' || scope.leaseHolder !== undefined) {
          // A scope this module did not write, or a launched child's lease,
          // which the launcher supervising that child alone revokes.
          return { deleted: false };
        }
        if (row.data.expires_at !== null && row.data.expires_at <= now) {
          // Already refused on its own; the expiry sweep removes the row.
          return { deleted: false };
        }
        this.#store.statement(SQL.deleteCredentialOfRole).run(tokenHash, 'server-agent');
        const projectRoot = normalizeRoot(scope.projectRoot);
        return projectRoot === undefined ? { deleted: true } : { deleted: true, projectRoot };
      }),
    );
    if (isErr(released)) {
      return released;
    }
    if (!released.value.deleted) {
      // Nothing changed, so nothing is closed: a launched child's lease, or
      // any other row left in place, keeps its connections.
      this.#logger.debug('a server-agent credential release found no releasable credential');
      return ok(false);
    }
    const socketsClosed = this.#closeConnectionsOf(tokenHash);
    this.#logger.info("released a server-agent credential at its holder's request", {
      socketsClosed,
      ...(released.value.projectRoot === undefined
        ? {}
        : { projectRoot: released.value.projectRoot }),
    });
    return ok(true);
  }

  revokeOrphanedServerAgentLeases(): Result<number, DebuggenError> {
    const revoked = this.#guard('revoke-orphaned-server-agent-leases', () =>
      this.#store.transaction((): number => {
        const rows: unknown[] = this.#store
          .statement(SQL.selectCredentialScopesOfRole)
          .all('server-agent');
        let count = 0;
        for (const raw of rows) {
          const row = credentialScopeRowSchema.safeParse(raw);
          const scope = row.success ? parseStoredScope(row.data.scope) : undefined;
          if (!row.success || scope?.kind !== 'project') {
            continue;
          }
          const tokenHash = row.data.token_hash;
          const holder = scope.leaseHolder;
          // This process issued nothing yet, so a lease naming its pid belongs
          // to a predecessor that reused it.
          if (
            holder === undefined ||
            (holder !== this.#processId && this.#isProcessAlive(holder))
          ) {
            continue;
          }
          this.#store.statement(SQL.deleteCredentialOfRole).run(tokenHash, 'server-agent');
          count += 1;
        }
        return count;
      }),
    );
    if (isErr(revoked)) {
      return revoked;
    }
    if (revoked.value > 0) {
      this.#logger.info(
        'revoked the server-agent leases of dev servers no running service supervises',
        { revoked: revoked.value },
      );
    }
    return revoked;
  }

  /**
   * Closes the connections authenticated with one credential through the
   * injected revoker, when it can. Never throws: a revoker failure is logged
   * and the expiry sweep closes the socket instead (see {@link authorizeHello}).
   *
   * @returns How many sockets were closed.
   */
  #closeConnectionsOf(tokenHash: string): number {
    const close = this.#revoker?.closeCredential?.bind(this.#revoker);
    if (close === undefined) {
      return 0;
    }
    try {
      return close(tokenHash, WS_CLOSE_UNAUTHORIZED, REVOCATION_CLOSE_REASON);
    } catch (cause) {
      this.#logger.warn('the connections of a revoked credential could not be closed', {
        errorCode: DebuggenError.from(cause).code,
      });
      return 0;
    }
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
      this.#logRefusal(
        'refused an HTTP request',
        decision.error,
        {
          operation: request.operation,
          ...(request.ref === undefined ? {} : { ref: request.ref }),
        },
        request.origin,
      );
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

    // 2. The exemption: no bearer credential for `health` and `pair.complete` —
    //    and, with no principal, no acting tab and no read proof either.
    const { operation } = request;
    const presentation = presentationOf(operation);
    const actingTab = readHeader(request.headers, ACTING_TAB_HEADER);
    const readProof = readHeader(request.headers, READ_PROOF_HEADER);
    if (isExemptOperation(operation)) {
      const exemptTab = decideActingTab(null, actingTab);
      if (isErr(exemptTab)) {
        return exemptTab;
      }
      const exemptProof = decideReadProofHeader(null, presentation, readProof);
      return isErr(exemptProof) ? exemptProof : ok(null);
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

    // 4. The stored row decides the principal — a DevTools read, `Origin` or
    //    not, only with the read proof issued with its credential — and its
    //    role must be one the operation admits. The proof is demanded only on
    //    the reads a DevTools credential may make, so a DevTools credential on
    //    any other operation is refused by its role, as before.
    const demandsReadProof =
      presentation === 'read' &&
      (OPERATION_ROLES[operation] as readonly PrincipalRole[]).includes('devtools');
    const principal = this.#authenticate(
      token,
      origin,
      presentation,
      demandsReadProof ? readProof : undefined,
    );
    if (isErr(principal)) {
      return principal;
    }
    const permitted: readonly PrincipalRole[] = OPERATION_ROLES[operation];
    if (!permitted.includes(principal.value.role)) {
      return refuse('role-not-permitted');
    }

    // 5. A read proof only on a DevTools read.
    const proofHeader = decideReadProofHeader(principal.value, presentation, readProof);
    if (isErr(proofHeader)) {
      return proofHeader;
    }

    // 6. An acting tab only from a DevTools principal, and only one tab id.
    //    Whether the tab is bound to the session the route acts on is the
    //    route's check (`requireBoundSession`), which needs the session id.
    const tab = decideActingTab(principal.value, actingTab);
    return isErr(tab) ? tab : principal;
  }

  authorizeHello(request: HelloAuthorizationRequest): Result<Principal, DebuggenError> {
    const decision = this.#decideHello(request);
    if (isErr(decision)) {
      this.#logRefusal('refused a client.hello', decision.error, {}, request.origin);
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

    const resolved = this.#authenticate(hello.token, origin, 'write');
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
        return ok(this.#liveServerAgentPrincipal(principal));
      }
    }
  }

  /**
   * A dev-server connection's principal whose `expiresAt` follows the stored
   * credential for the life of the socket.
   *
   * A socket's principal outlives the hello that resolved it, and the client
   * registry closes a connection once `now >= principal.expiresAt`. For a
   * launched child's lease — renewed while the child runs — an expiry frozen at
   * hello would close a healthy child's socket at its first lease's end, and
   * the preload does not reconnect after an unauthorized close. So the expiry
   * is read from the credential's row whenever it is asked for: a renewal
   * extends the live socket, a revocation (the row is gone) makes it expired as
   * of that moment, and a lapse is seen as it happens. A credential without an
   * expiry is returned as it is. When the row cannot be read (the store is
   * closing), the last value read stands.
   */
  #liveServerAgentPrincipal(principal: ServerAgentPrincipal): ServerAgentPrincipal {
    const initial = principal.expiresAt;
    if (initial === undefined) {
      return principal;
    }
    const { tokenHash } = principal;
    let known = initial;
    const readExpiry = (): number => {
      known = this.#currentExpiry(tokenHash, known);
      return known;
    };
    const live: ServerAgentPrincipal = {
      role: principal.role,
      scope: principal.scope,
      tokenHash,
      issuedAt: principal.issuedAt,
      get expiresAt(): number {
        return readExpiry();
      },
    };
    return Object.freeze(live);
  }

  /**
   * The stored expiry of the credential with `tokenHash`: its row's, the
   * moment of the call when the row no longer exists, or `fallback` when the
   * row cannot be read or carries none.
   */
  #currentExpiry(tokenHash: string, fallback: number): number {
    if (this.#store.isClosed) {
      return fallback;
    }
    try {
      const raw: unknown = this.#store.statement(SQL.selectCredential).get(tokenHash);
      if (raw === undefined) {
        return Math.min(fallback, this.#now());
      }
      const row = credentialRowSchema.safeParse(raw);
      return row.success && row.data.expires_at !== null ? row.data.expires_at : fallback;
    } catch {
      return fallback;
    }
  }

  announceWorkspace(principal: Principal): Result<WorkspaceAnnouncement, DebuggenError> {
    if (principal.role !== 'vscode') {
      return refuse('role-not-permitted', 'Only an editor connection announces workspace folders.');
    }
    const { tokenHash } = principal;
    const folders = principal.scope.workspaceFolders;
    const standings = this.#announcements.get(tokenHash) ?? new Map<string, FolderStanding>();
    for (const folder of folders) {
      const standing = standings.get(folder);
      if (standing === undefined) {
        standings.set(folder, { live: 1, leaseUntil: 0 });
      } else {
        // A folder still under a lease is simply live again; the lease stays
        // as the floor it already was.
        standing.live += 1;
      }
    }
    if (standings.size > 0) {
      this.#announcements.set(tokenHash, standings);
    }

    let settled = false;
    /**
     * Withdraws this announcement's claim, keeping each folder in scope until
     * `leaseUntil` (`0`: no lease of its own). A no-op after the first call,
     * and when rotation or shutdown has cleared the map it wrote to.
     */
    const settle = (leaseMs: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (this.#announcements.get(tokenHash) !== standings) {
        return;
      }
      const now = this.#now();
      const leaseUntil = leaseMs > 0 ? now + leaseMs : 0;
      for (const folder of folders) {
        const standing = standings.get(folder);
        if (standing === undefined) {
          continue;
        }
        standing.live = Math.max(0, standing.live - 1);
        standing.leaseUntil = Math.max(standing.leaseUntil, leaseUntil);
        if (standing.live === 0 && standing.leaseUntil <= now) {
          standings.delete(folder);
        }
      }
      if (standings.size === 0) {
        this.#announcements.delete(tokenHash);
      }
    };
    return ok(
      Object.freeze({
        release: (): void => {
          settle(0);
        },
        releaseAfter: (leaseMs: number): void => {
          settle(workspaceLeaseMs(leaseMs));
        },
      }),
    );
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

  completePairing(
    request: PairingCompletionRequest,
  ): Result<IssuedDevtoolsCredential, DebuggenError> {
    const decision = this.#redeemPairingCode(request);
    if (isErr(decision)) {
      this.#logRefusal('refused a pairing attempt', decision.error, {}, request.origin);
    }
    return decision;
  }

  /** {@link completePairing} without the logging. */
  #redeemPairingCode(
    request: PairingCompletionRequest,
  ): Result<IssuedDevtoolsCredential, DebuggenError> {
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
    // The extension id scopes the credential this redemption issues, and
    // nothing else: the throttle below is service-wide, because the id is
    // whatever the caller wrote in its `Origin` header.
    const { extensionId } = origin;
    const now = this.#now();

    // A lockout refuses even the correct code, and burns nothing; that is what
    // makes it a lockout.
    if (this.#isPairingLocked(now)) {
      return refuse('pairing-locked');
    }

    // The code is judged exactly as it was sent: no trimming, no case folding.
    // A code is eight characters of one alphabet and nothing else, so a padded,
    // lower-case or otherwise re-spelled submission is not that code — it is a
    // wrong guess, counted like any other. Tidying what the developer typed is
    // the client's job (the DevTools pair dialog upper-cases and trims before it
    // submits); accepting several spellings here would only widen what a guess
    // may look like.
    const { code } = request;
    if (!isWellFormedPairingCode(code)) {
      return this.#pairingFailure(now, 'pairing-invalid');
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
      return this.#pairingFailure(now, 'pairing-invalid');
    }
    if (row.data.used >= PAIRING_CODE_MAX_REDEMPTIONS) {
      return this.#pairingFailure(now, 'pairing-used');
    }
    if (row.data.expires_at <= now) {
      return this.#pairingFailure(now, 'pairing-expired');
    }

    const token = this.#mintToken();
    if (isErr(token)) {
      return token;
    }
    // The read proof is drawn here, with the credential, and reaches only the
    // caller that redeemed the code: no later request, hello or origin can
    // obtain or replace it.
    const readProof = this.#mintReadProof();
    if (isErr(readProof)) {
      return readProof;
    }
    const tokenHash = sha256Hex(token.value);
    const scope: StoredScope = {
      kind: 'extension',
      extensionId,
      readProofDigest: sha256Hex(readProof.value),
    };

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
        this.#insertCredential(tokenHash, 'devtools', scope, now, null);
        return true;
      }),
    );
    if (isErr(redeemed)) {
      return redeemed;
    }
    if (!redeemed.value) {
      return this.#pairingFailure(now, 'pairing-used');
    }

    // A success clears the service-wide count: the failures before it were the
    // developer's own typos as likely as anyone's guesses.
    this.#pairingLedger = newLedgerEntry();
    this.#logger.info('paired a DevTools client', { extensionId });
    return ok(Object.freeze({ token: token.value, readProof: readProof.value }));
  }

  /** Whether pairing is locked, for every caller, at `now`. */
  #isPairingLocked(now: number): boolean {
    return this.#pairingLedger.lockedUntil > now;
  }

  /**
   * Records one failed redemption in the service-wide ledger and returns the
   * refusal. A failure more than {@link PAIRING_LOCKOUT_MS} after the previous
   * one starts the count again; the {@link PAIRING_MAX_FAILURES}th locks
   * pairing for {@link PAIRING_LOCKOUT_MS} and starts the count again for the
   * window after the lock.
   */
  #pairingFailure(
    now: number,
    reason: 'pairing-invalid' | 'pairing-used' | 'pairing-expired',
  ): Result<IssuedDevtoolsCredential, DebuggenError> {
    const ledger = this.#pairingLedger;
    if (now - ledger.lastFailureAt > PAIRING_LOCKOUT_MS) {
      ledger.failures = 0;
    }
    ledger.failures += 1;
    ledger.lastFailureAt = now;
    if (ledger.failures >= PAIRING_MAX_FAILURES) {
      ledger.lockedUntil = now + PAIRING_LOCKOUT_MS;
      ledger.failures = 0;
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
      return err(rotationNotApplied(prepared.error));
    }

    // A replacement an earlier call could not finish is settled first, so this
    // rotation's journal never overwrites a committed record auth.json does not
    // hold yet. One that still cannot be published means auth.json cannot be
    // written at all, which this rotation would fail on too — so it stops here,
    // having changed nothing.
    const recovered = this.#recoverStagedCredential();
    if (isErr(recovered)) {
      return err(rotationNotApplied(recovered.error));
    }

    const token = this.#mintToken();
    if (isErr(token)) {
      return err(rotationNotApplied(token.error));
    }
    const tokenHash = sha256Hex(token.value);
    const issuedAt = this.#now();
    const record: AuthFileRecord = { version: AUTH_FILE_VERSION, token: token.value, issuedAt };

    // Stage, then one transaction — every credential and every outstanding
    // pairing code goes and the new editor credential arrives — then publish
    // auth.json and remove the journal. A failure before the commit changes
    // nothing; after it, the rotation is durable whatever happens to the file.
    const replaced = this.#replaceEditorCredential(record, 'rotate-credentials', () => {
      const removed = Number(this.#store.statement(SQL.deleteAllCredentials).run().changes);
      this.#store.statement(SQL.deleteAllPairingCodes).run();
      this.#insertCredential(tokenHash, 'vscode', MACHINE_USER_STORED_SCOPE, issuedAt, null);
      return removed;
    });
    if (isErr(replaced)) {
      return err(rotationNotApplied(replaced.error));
    }
    const { value: credentialsDeleted, published } = replaced.value;
    this.#announcements.clear();

    // Every open socket authenticated with a credential the store no longer
    // holds, so every one is closed — also when auth.json could not be updated,
    // because the old credentials are refused either way. When the file was
    // updated this runs after it, so the editor client, which re-reads auth.json
    // on 4401, reconnects with the new credential. Paired Chrome extensions must
    // pair again, and launched dev servers must be relaunched to receive a new
    // server-agent credential (AAP §0.5.6).
    let socketsClosed = 0;
    let revokeFailure: { readonly cause: unknown } | undefined;
    if (this.#revoker !== undefined) {
      try {
        socketsClosed = this.#revoker.revokeAll(WS_CLOSE_UNAUTHORIZED, ROTATION_CLOSE_REASON);
      } catch (cause) {
        revokeFailure = { cause };
        this.#logger.error('credentials were rotated but open connections could not be closed');
      }
    }

    if (isErr(published)) {
      this.#logger.error('credentials were rotated but auth.json could not be updated', {
        rowsDeleted: credentialsDeleted,
        socketsClosed,
        connectionsClosed: revokeFailure === undefined,
      });
      return err(
        new DebuggenError(
          'INTERNAL',
          revokeFailure === undefined
            ? 'Credentials were rotated, but auth.json could not be updated with the new editor credential.'
            : 'Credentials were rotated, but auth.json could not be updated with the new editor credential and the open connections could not all be closed.',
          {
            hint: 'Restart the Debug Generator service: it finishes the rotation as it starts, and the editor then reconnects with the new credential.',
            details: {
              operation: 'publish-auth-file',
              rotated: true,
              credentialsDeleted,
              socketsClosed,
              publishErrorCode: published.error.code,
            },
            cause: published.error,
          },
        ),
      );
    }

    if (revokeFailure !== undefined) {
      return err(
        new DebuggenError(
          'INTERNAL',
          'Credentials were rotated, but the open connections could not all be closed.',
          {
            hint: 'Restart the Debug Generator service to drop every open connection.',
            details: { operation: 'revoke-connections', rotated: true, credentialsDeleted },
            cause: revokeFailure.cause,
          },
        ),
      );
    }

    this.#logger.info('rotated every service credential', {
      rowsDeleted: credentialsDeleted,
      socketsClosed,
    });
    return ok(Object.freeze({ credentialsDeleted, socketsClosed }));
  }

  requireLiveCredential(principal: Principal): Result<void, DebuggenError> {
    const decision = this.#decideLiveCredential(principal);
    if (isErr(decision) && authFailureReasonOf(decision.error) !== undefined) {
      // A store failure was already logged by #guard; a refusal is logged here,
      // by its reason and the principal's role only.
      this.#logRefusal(
        'refused a request whose credential was retired after it was authenticated',
        decision.error,
        { role: principal.role },
      );
    }
    return decision;
  }

  /**
   * {@link requireLiveCredential} without the logging: the principal's row by
   * digest, then the same row checks {@link #authenticate} applies, then the
   * role the principal was resolved with.
   */
  #decideLiveCredential(principal: Principal): Result<void, DebuggenError> {
    const raw = this.#guard('read-live-credential', () =>
      this.#store.statement(SQL.selectCredential).get(principal.tokenHash),
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
    if (!digestsEqual(row.data.token_hash, principal.tokenHash)) {
      return refuse('unknown-credential');
    }
    if (row.data.expires_at !== null && row.data.expires_at <= this.#now()) {
      return refuse('expired-credential');
    }
    // A digest now stored under another role is not the credential the
    // principal was resolved from, whatever the digest says.
    if (row.data.role !== principal.role) {
      return refuse('unknown-credential');
    }
    return ok(undefined);
  }

  close(): void {
    this.#pairingLedger = newLedgerEntry();
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
 * optional revoker, clock, randomness and credential-file seams.
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
      processId: deps.processId ?? process.pid,
      isProcessAlive: deps.isProcessAlive ?? isProcessAlive,
      files: deps.fileSystem ?? SECURE_CREDENTIAL_FILE_SYSTEM,
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
 *   announced, on disk as well as in spelling. For **one** announced folder
 *   both must hold: the root is that folder or lies beneath it as a string,
 *   and the root's canonical path — every symbolic link resolved, a tail that
 *   does not exist yet kept as spelled — is the folder's canonical path or
 *   lies beneath it. So `/work/shop/external`, a link to `/home/dev/private`,
 *   is refused under an announced `/work/shop`, while a link that stays inside
 *   the folder, and a folder that is itself announced through a link, are
 *   admitted. The string check runs first, so no path outside every announced
 *   folder is ever resolved, and a root or folder whose canonical path cannot
 *   be established (`EACCES`, a link loop, a dangling link whose target does
 *   not exist yet, a drive-rooted path on a host that is not Windows) is
 *   refused rather than admitted on its spelling.
 * - A server-agent principal is confined to its one project: the root must be
 *   that project root. That is identity with the root the service minted the
 *   credential for — a root an editor's session was admitted with by the rule
 *   above — and no link makes one string equal another, so it stays lexical.
 * - A DevTools principal carries no project scope and acts only through its
 *   bound session ({@link requireBoundSession}), so it is always refused here.
 *
 * Every route that takes a project root calls this — from an editor, session
 * creation and listing and dev-server launch, stop and credentials; from a
 * server agent, telemetry ingest — and {@link requireSessionAccess} re-runs it
 * on every request that names a session, so a caller inherits the canonical
 * check without passing anything.
 *
 * The canonical check is true at the moment it runs, not afterwards: a link
 * created or retargeted inside the workspace after this returns is not seen
 * here. The next request on the session re-runs this check through
 * {@link requireSessionAccess}, and the patcher re-derives the containment of
 * every file it writes from the project's own canonical root
 * (`resolveRealPathWithinProject`). Every sink that acts on a root after an
 * `await` also re-proves the identity the root was admitted under —
 * synchronously, immediately before it acts — so a link retargeted in
 * between, even to another directory inside the workspace, is refused rather
 * than followed:
 *
 * - `session.create` (`routes/sessions.ts`) admits the root with
 *   {@link admitProjectRoot} and re-proves it with {@link reconfirmProjectRoot}
 *   before the session is stored, handing the proof to `SessionManager.create`,
 *   which stores its canonical path with the new session, in the same
 *   transaction;
 * - `dev-server.launch` (`routes/dev-server.ts`) admits the root, re-proves it
 *   at its fence, and hands the launcher (`dev-server/launcher.ts`) a
 *   confirmation it runs immediately before spawning the child in the
 *   canonical root;
 * - the pipeline's indexing and patching run after the create request has
 *   answered and hold no principal, so they re-prove identity only, through
 *   `SessionManager.confirmProjectRoot` and {@link reconfirmRootIdentity},
 *   against the identity stored with the session — which survives a restart,
 *   and whose absence refuses the sink — and index and patch inside the
 *   canonical root it returns.
 *
 * @param principal The authenticated principal.
 * @param projectRoot The requested project root, as the caller sent it.
 * @param resolveRealPath The canonicaliser, `realpathSync.native` by default;
 * injected by tests. It follows the {@link RealPathResolver} contract, and a
 * throw whose `code` is `ENOENT` means only that the component does not exist.
 * @returns `ok`, or `PATH_OUTSIDE_PROJECT` (`project-out-of-scope`, 403).
 */
export function requireProjectScope(
  principal: Principal,
  projectRoot: string,
  resolveRealPath: RealPathResolver = resolveHostRealPath,
): Result<void, DebuggenError> {
  const root = normalizeRoot(projectRoot);
  if (root === undefined) {
    return refuse('project-out-of-scope', 'A project root must be an absolute path.');
  }
  switch (principal.role) {
    case 'vscode': {
      const admitted = admitProjectRoot(principal, root, resolveRealPath);
      return isErr(admitted) ? err(admitted.error) : ok(undefined);
    }
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
 * A project root and the canonical identity it was admitted under: the
 * directory every later act on the root must still find there.
 *
 * {@link requireProjectScope} answers whether a root is in scope when it runs;
 * this value is what keeps that answer usable after an `await`. It is taken by
 * {@link admitProjectRoot} (an editor principal: scope and identity) or by
 * {@link identifyProjectRoot} (no principal: identity only), and re-proved —
 * synchronously, immediately before the act — by {@link reconfirmProjectRoot}
 * or {@link reconfirmRootIdentity}. A link on the path retargeted in between,
 * even to another directory inside the workspace, is then refused rather than
 * followed, and the act runs in {@link AdmittedProjectRoot.canonicalRoot}, the
 * directory that was proven, never through the links of the spelled root
 * again.
 *
 * | Sink | Proof taken | Re-proved immediately before it acts | Acts in |
 * | --- | --- | --- | --- |
 * | `session.create` (`routes/sessions.ts`) | {@link admitProjectRoot} | {@link reconfirmProjectRoot}, before the session is stored; the proof is handed to `SessionManager.create`, which stores it with the session | — (it stores the session) |
 * | `dev-server.launch` (`routes/dev-server.ts`, `dev-server/launcher.ts`) | {@link admitProjectRoot} | {@link reconfirmProjectRoot} at the route's fence, then a confirmation the launcher runs immediately before spawning | the canonical root |
 * | indexing and patching (the session pipeline) | the proof the session was created with, persisted with it | `SessionManager.confirmProjectRoot` → {@link reconfirmRootIdentity} (no principal after the request) | the canonical root |
 *
 * The proof outlives the process that took it: the session manager stores its
 * canonical path with the session, in the transaction that inserts it
 * (`session_root_identities`, schema version 6), so a session read back from
 * the store after a restart is held to the directory it was admitted as — a
 * link retargeted while the service was down is refused like any other. A
 * session with no recorded identity (stored by a build that predates the
 * record, or created without a proof) is refused at every sink with
 * {@link unrecordedProjectRootIdentity} instead of being identified after the
 * fact. Scope for a session is re-run by {@link requireSessionAccess} on
 * every request that names it.
 *
 * @example
 * ```ts
 * // A request handler, holding the principal throughout.
 * const admitted = admitProjectRoot(principal, body.projectRoot);
 * if (isErr(admitted)) return answer(admitted.error);
 * await prepare(admitted.value.projectRoot);
 * const still = reconfirmProjectRoot(principal, admitted.value);
 * if (isErr(still)) return answer(still.error);
 * spawnIn(still.value.canonicalRoot); // no await between the two
 *
 * // A background sink, long after the request answered.
 * const root = sessionManager.confirmProjectRoot(sessionId); // reconfirmRootIdentity
 * if (isErr(root)) return fail(root.error);
 * indexIn(root.value.canonicalRoot); // no await between the two
 * ```
 */
export interface AdmittedProjectRoot {
  /** The root, absolute and normalised, exactly as it was judged. */
  readonly projectRoot: string;
  /** Its canonical path when it was admitted: every symbolic link resolved. */
  readonly canonicalRoot: string;
}

/** The refusal of a root whose canonical path changed after it was admitted. */
const PROJECT_ROOT_MOVED_MESSAGE =
  'The project root no longer resolves to the directory it was admitted as.';

/**
 * What the developer does about {@link PROJECT_ROOT_MOVED_MESSAGE}. It names no
 * path: the refusal reaches response bodies, progress rows and logs, and the
 * developer knows which folder they opened.
 */
const PROJECT_ROOT_MOVED_HINT =
  'The project folder, or a link on its path, was moved or relinked after it was admitted. Start a new session, or launch the dev server again, from the folder in VS Code.';

/**
 * The refusal of a root whose canonical path cannot be established when no
 * principal is in hand ({@link identifyProjectRoot}). One constant sentence
 * for every cause — a dangling link, a link loop, a folder that cannot be
 * read — so the answer is no probe of which one it was.
 */
const PROJECT_ROOT_UNRESOLVABLE_MESSAGE =
  'Where the project root leads on disk could not be established.';

/** What the developer does about {@link PROJECT_ROOT_UNRESOLVABLE_MESSAGE}. */
const PROJECT_ROOT_UNRESOLVABLE_HINT =
  'Check that the project folder and every link on its path still exist and can be read, then start a new session from the folder in VS Code.';

/**
 * The refusal of a session whose root has no recorded admitted identity
 * ({@link unrecordedProjectRootIdentity}). One constant sentence that names no
 * path: it reaches response bodies, progress rows and logs.
 */
const PROJECT_ROOT_UNRECORDED_MESSAGE =
  "No admitted identity is recorded for this session's project root.";

/** What the developer does about {@link PROJECT_ROOT_UNRECORDED_MESSAGE}. */
const PROJECT_ROOT_UNRECORDED_HINT =
  'This session was stored without a record of the directory its project root was admitted as, so it can no longer be indexed or instrumented. Start a new session from the folder in VS Code.';

/**
 * The refusal a sink that holds no principal answers for a session whose
 * project root has **no recorded admitted identity**: `PATH_OUTSIDE_PROJECT`
 * (`project-out-of-scope`, 403), with a constant, path-free message and a hint
 * to start a new session from the folder in VS Code.
 *
 * `SessionManager.confirmProjectRoot` answers it — failing closed — when a
 * session reaches a sink with neither an in-memory proof nor one stored with
 * it: a session stored by a build that predates the persisted identity, or
 * created without a proof. Identifying the root then, with
 * {@link identifyProjectRoot}, would accept whatever its links lead to at that
 * moment — a link retargeted while the service was down included — so the
 * sink is refused instead of being handed a canonical root nobody admitted.
 *
 * @returns A new refusal on every call, so a caller may attach it as it wishes.
 *
 * @example
 * ```ts
 * const recorded = sessions.getRootIdentity(sessionId);
 * if (isErr(recorded)) return err(recorded.error);
 * if (recorded.value === undefined) return err(unrecordedProjectRootIdentity());
 * ```
 */
export function unrecordedProjectRootIdentity(): DebuggenError {
  return authFailure(
    'project-out-of-scope',
    PROJECT_ROOT_UNRECORDED_MESSAGE,
    PROJECT_ROOT_UNRECORDED_HINT,
  );
}

/**
 * The identity of a root {@link normalizeRoot} already accepted: the root as
 * given and its {@link canonicalRoot}, frozen, or `undefined` when the
 * canonical path cannot be established. The one construction both
 * {@link admitProjectRoot} and {@link identifyProjectRoot} return.
 */
function identityOf(
  root: string,
  resolveRealPath: RealPathResolver,
): AdmittedProjectRoot | undefined {
  const canonical = canonicalRoot(root, resolveRealPath);
  return canonical === undefined
    ? undefined
    : Object.freeze({ projectRoot: root, canonicalRoot: canonical });
}

/**
 * The canonical identity of a project root, with no principal and no scope:
 * the root normalised exactly as {@link requireProjectScope} normalises it,
 * and its canonical path — every symbolic link in the part that exists
 * resolved, a tail that does not exist yet kept as spelled beneath its longest
 * existing ancestor.
 *
 * This is the half of {@link admitProjectRoot} a sink that holds no principal
 * can still run. It judges **no scope** and is never a substitute for
 * admission: a root a request names is admitted with {@link admitProjectRoot}
 * or {@link requireProjectScope}. Nor does it ever stand in for a proof a
 * session lacks: a session with no recorded identity is refused with
 * {@link unrecordedProjectRootIdentity}, because identifying its root after the
 * fact would accept wherever a relinked path leads by then.
 * {@link reconfirmRootIdentity} calls it to re-establish an admitted identity.
 *
 * Refused in exactly the cases {@link admitProjectRoot}'s own normalising and
 * canonicalising steps refuse the same root: a root that is not an absolute
 * local path (relative, empty, a NUL, a network share), and a root whose
 * canonical path cannot be established — a dangling link, a link loop,
 * `EACCES`, `ENOTDIR`, a drive-rooted path on a host that is not Windows. A
 * missing tail is not a failure.
 *
 * @param projectRoot The root, as the session or the caller holds it.
 * @param resolveRealPath The canonicaliser, `realpathSync.native` by default;
 * injected by tests. It follows the {@link RealPathResolver} contract.
 * @returns The root and its canonical path, frozen, or `PATH_OUTSIDE_PROJECT`
 * (`project-out-of-scope`, 403).
 */
export function identifyProjectRoot(
  projectRoot: string,
  resolveRealPath: RealPathResolver = resolveHostRealPath,
): Result<AdmittedProjectRoot, DebuggenError> {
  const root = normalizeRoot(projectRoot);
  if (root === undefined) {
    return refuse('project-out-of-scope', 'A project root must be an absolute path.');
  }
  const identity = identityOf(root, resolveRealPath);
  return identity === undefined
    ? refuse(
        'project-out-of-scope',
        PROJECT_ROOT_UNRESOLVABLE_MESSAGE,
        PROJECT_ROOT_UNRESOLVABLE_HINT,
      )
    : ok(identity);
}

/**
 * {@link requireProjectScope}'s editor rule, returning what the root was judged
 * on: for **one** announced workspace folder, the root lies under it both as a
 * normalised path and after both are resolved with `realpath`. The resolved
 * root is returned as {@link AdmittedProjectRoot.canonicalRoot}.
 *
 * Only an editor principal is admitted to a project by its workspace folders:
 * a server-agent principal's scope is its one project, checked by
 * {@link requireProjectScope}, and a DevTools principal has no project scope,
 * so both are refused here.
 *
 * @param principal The authenticated principal; must be an editor one.
 * @param projectRoot The requested project root, as the caller sent it.
 * @param resolveRealPath The canonicaliser, `realpathSync.native` by default.
 * @returns The admitted root and its canonical path, or `PATH_OUTSIDE_PROJECT`
 * (`project-out-of-scope`, 403).
 */
export function admitProjectRoot(
  principal: Principal,
  projectRoot: string,
  resolveRealPath: RealPathResolver = resolveHostRealPath,
): Result<AdmittedProjectRoot, DebuggenError> {
  const root = normalizeRoot(projectRoot);
  if (root === undefined) {
    return refuse('project-out-of-scope', 'A project root must be an absolute path.');
  }
  if (principal.role !== 'vscode') {
    return refuse(
      'project-out-of-scope',
      'Only an editor credential is admitted to a project by its workspace folders.',
    );
  }
  const claimingFolders = principal.scope.workspaceFolders.filter((folder) =>
    isWithin(folder, root),
  );
  if (claimingFolders.length === 0) {
    return refuse('project-out-of-scope');
  }
  // Resolved only now, after the lexical check: no root outside every
  // announced folder is ever resolved.
  const identity = identityOf(root, resolveRealPath);
  if (identity === undefined) {
    return refuse('project-out-of-scope');
  }
  return claimingFolders.some((folder) => {
    const canonicalFolder = canonicalRoot(folder, resolveRealPath);
    return canonicalFolder !== undefined && isWithin(canonicalFolder, identity.canonicalRoot);
  })
    ? ok(identity)
    : refuse('project-out-of-scope');
}

/**
 * `admitted`, when `canonicalNow` — the root's canonical path as it was just
 * established again — names the directory it was admitted under; the moved
 * refusal otherwise. The one identity comparison {@link reconfirmProjectRoot}
 * and {@link reconfirmRootIdentity} share, so both refuse a moved root with the
 * same message and hint.
 */
function confirmSameIdentity(
  admitted: AdmittedProjectRoot,
  canonicalNow: string,
): Result<AdmittedProjectRoot, DebuggenError> {
  return sameRoot(canonicalNow, admitted.canonicalRoot)
    ? ok(admitted)
    : refuse('project-out-of-scope', PROJECT_ROOT_MOVED_MESSAGE, PROJECT_ROOT_MOVED_HINT);
}

/**
 * Re-proves an admitted root immediately before a caller acts on it: the root
 * must still be in the principal's scope ({@link admitProjectRoot} again, so a
 * withdrawn workspace folder or an outward link is refused) **and** still
 * resolve to the canonical path it was admitted under, so a link retargeted
 * since — inside the workspace or out of it — is refused instead of followed.
 *
 * Synchronous, and meant to run with no `await` between it and the act it
 * guards; the residue is then the time a synchronous call takes. For a sink
 * that holds no principal, {@link reconfirmRootIdentity} re-proves the
 * identity alone.
 *
 * @param principal The principal the root was admitted for.
 * @param admitted What {@link admitProjectRoot} returned.
 * @param resolveRealPath The canonicaliser, `realpathSync.native` by default.
 * @returns `admitted`, unchanged, or `PATH_OUTSIDE_PROJECT`
 * (`project-out-of-scope`, 403): the scope refusal of {@link admitProjectRoot},
 * or, when the root is still in scope but resolves elsewhere, the moved
 * refusal.
 */
export function reconfirmProjectRoot(
  principal: Principal,
  admitted: AdmittedProjectRoot,
  resolveRealPath: RealPathResolver = resolveHostRealPath,
): Result<AdmittedProjectRoot, DebuggenError> {
  const again = admitProjectRoot(principal, admitted.projectRoot, resolveRealPath);
  return isErr(again) ? again : confirmSameIdentity(admitted, again.value.canonicalRoot);
}

/**
 * Re-proves, with no principal, that an admitted root still resolves to the
 * canonical path it was admitted under — the check a background sink runs
 * synchronously, immediately before it acts, so a link on the path retargeted
 * since, inside the workspace or out of it, is refused instead of followed.
 *
 * It exists beside {@link reconfirmProjectRoot} because the session pipeline's
 * indexing and patching act long after the `session.create` request that
 * admitted the root has answered, and hold no principal to re-run the scope
 * with. They need not: scope was proven at admission, and
 * {@link requireSessionAccess} re-runs it on every later request that names
 * the session. What can change unseen between admission and a background act
 * is where the root's links lead, and that is exactly what this re-proves.
 * Reached through `SessionManager.confirmProjectRoot`, which holds each session
 * to the proof recorded with it — in memory, and in the session store across a
 * restart — and refuses a session with none
 * ({@link unrecordedProjectRootIdentity}).
 *
 * Synchronous, and meant to run with no `await` between it and the act it
 * guards; the act then runs in the returned
 * {@link AdmittedProjectRoot.canonicalRoot}.
 *
 * @param admitted What {@link admitProjectRoot} or {@link identifyProjectRoot}
 * returned for the root.
 * @param resolveRealPath The canonicaliser, `realpathSync.native` by default.
 * @returns `admitted` (the same object), or `PATH_OUTSIDE_PROJECT`
 * (`project-out-of-scope`, 403): the moved refusal when the canonical path
 * changed, {@link identifyProjectRoot}'s when it can no longer be established.
 */
export function reconfirmRootIdentity(
  admitted: AdmittedProjectRoot,
  resolveRealPath: RealPathResolver = resolveHostRealPath,
): Result<AdmittedProjectRoot, DebuggenError> {
  const again = identifyProjectRoot(admitted.projectRoot, resolveRealPath);
  return isErr(again) ? again : confirmSameIdentity(admitted, again.value.canonicalRoot);
}

/**
 * The DevTools rule of AAP §0.5.6: a DevTools principal may bind its tab,
 * select targets, start and stop capture, query panel data and send
 * `source.open` only for the session bound to **its** tab, by a binding its
 * own credential made.
 *
 * "Its tab" is the request's acting tab, because the credential cannot say:
 * every tab one paired extension inspects presents the same credential (see
 * {@link TabBinding}). The action is admitted only when all of these hold:
 *
 * 1. the request names an acting tab — a DevTools action that names none is
 *    refused (`acting-tab-required`) rather than attributed to a guessed tab;
 * 2. the session has a live binding, and it is the binding of that session;
 * 3. the binding's tab **is** the acting tab — tab B cannot act on the session
 *    tab A is bound to, and a tab displaced by a later bind loses the session;
 * 4. the binding was made by this principal's credential (constant-time digest
 *    comparison).
 *
 * The acting tab is required as an explicit argument, never defaulted, so
 * every call site states where its tab comes from: the verified
 * `c.get('actingTabId')` of an HTTP request, the envelope or single-tab hello
 * `tabId` of a WebSocket frame, or the payload's own `tabId` for a frame about
 * one tab.
 *
 * @param principal The requesting principal; must be a DevTools one.
 * @param sessionId The session the request acts on.
 * @param binding The live tab binding recorded for that session, if any.
 * @param actingTabId The inspected tab the request acts for, or `undefined` when it named none.
 * @returns `ok`, or `TAB_NOT_BOUND` (`acting-tab-required` or `session-not-bound`,
 * 403); a non-DevTools principal is `UNAUTHORIZED` (`role-not-permitted`).
 *
 * @example
 * ```ts
 * // tab 7 is bound to session S by credential C
 * requireBoundSession(principalOfC, S, bindingOfS, 7); // ok
 * requireBoundSession(principalOfC, S, bindingOfS, 8); // TAB_NOT_BOUND — another tab of C
 * requireBoundSession(principalOfC, S, bindingOfS, undefined); // TAB_NOT_BOUND — no tab named
 * ```
 */
export function requireBoundSession(
  principal: Principal,
  sessionId: string,
  binding: TabBinding | undefined,
  actingTabId: number | undefined,
): Result<void, DebuggenError> {
  if (principal.role !== 'devtools') {
    return refuse('role-not-permitted', 'Only a DevTools credential acts through a tab binding.');
  }
  if (actingTabId === undefined) {
    return refuse('acting-tab-required');
  }
  if (
    binding === undefined ||
    binding.sessionId !== sessionId ||
    binding.tabId !== actingTabId ||
    !digestsEqual(binding.boundBy, principal.tokenHash)
  ) {
    return refuse('session-not-bound');
  }
  return ok(undefined);
}

/**
 * The whole per-session access matrix in one call: an editor principal by
 * project scope, a DevTools principal by its acting tab's binding
 * ({@link requireBoundSession}), and a server agent never (it only ingests).
 *
 * @param principal The requesting principal.
 * @param session The session's id and project root.
 * @param binding The live tab binding recorded for the session, if any.
 * @param actingTabId The inspected tab a DevTools request acts for; ignored for
 * the other roles, which never name one.
 * @returns `ok`, or the refusal of the rule that applies to the principal's role.
 */
export function requireSessionAccess(
  principal: Principal,
  session: SessionAccessTarget,
  binding?: TabBinding,
  actingTabId?: number,
): Result<void, DebuggenError> {
  switch (principal.role) {
    case 'vscode':
      return requireProjectScope(principal, session.projectRoot);
    case 'devtools':
      return requireBoundSession(principal, session.id, binding, actingTabId);
    case 'server-agent':
      return refuse('role-not-permitted', 'A dev-server credential may only post telemetry.');
  }
}

/**
 * The acting tab of an HTTP request: the {@link ACTING_TAB_HEADER} value,
 * judged against the request's principal. Pure — it reads nothing but its
 * arguments — and it is the rule {@link AuthService.authorizeHttpRequest}
 * enforces, exported so {@link createAuthMiddleware} can hand routes the same
 * verified value as `c.get('actingTabId')`.
 *
 * - No header: `ok(undefined)`. A DevTools action that needs a tab is refused
 *   later, by {@link requireBoundSession} (`acting-tab-required`).
 * - A header on a request whose principal is not a DevTools one, or on an
 *   auth-exempt operation (`principal` `null`): `acting-tab-not-permitted`
 *   (`UNAUTHORIZED`, 403) — no editor, dev server or unauthenticated caller
 *   acts for a tab.
 * - A DevTools request's header that is not exactly one tab id (protocol's
 *   `parseActingTabHeader`): `acting-tab-invalid` (`PROTOCOL_INVALID_MESSAGE`,
 *   400).
 *
 * The header value is never interpolated into a refusal or logged.
 *
 * @param principal The resolved principal, or `null` for an auth-exempt operation.
 * @param raw The header's raw value, or `undefined` when the request carried none.
 * @returns The acting tab, `undefined` when none was named, or the refusal.
 *
 * @example
 * ```ts
 * resolveActingTab(devtoolsPrincipal, '42'); // ok(42)
 * resolveActingTab(devtoolsPrincipal, undefined); // ok(undefined)
 * resolveActingTab(editorPrincipal, '42'); // err: acting-tab-not-permitted
 * resolveActingTab(devtoolsPrincipal, '-1'); // err: acting-tab-invalid
 * ```
 */
export function resolveActingTab(
  principal: Principal | null,
  raw: string | undefined,
): Result<number | undefined, DebuggenError> {
  return decideActingTab(
    principal,
    raw === undefined ? { kind: 'absent' } : { kind: 'single', value: raw },
  );
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
 * operation it was built for, sets `operation`, `actingTabId` (the verified
 * {@link ACTING_TAB_HEADER} of a DevTools request, from
 * {@link resolveActingTab}; `undefined` otherwise) and — for every non-exempt
 * operation — `principal` on the context, and otherwise answers with the
 * protocol's error body at the refusal's status (400, 401, 403 or 429).
 *
 * The refusal body carries the request's `requestRef` (see {@link ServerEnv})
 * as its `ref`, and the same ref is handed to the access boundary, whose
 * `warn` record of the refusal is filed under it — one ref for the reply and
 * the record. Composed without `http.ts`'s request context, no ref is set and
 * the body carries none.
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
    const ref = c.get('requestRef');
    /** The refusal reply: the boundary's status and body, under the request's ref. */
    const refusal = (error: DebuggenError): Response => {
      const { status, body } = authErrorResponse(error);
      return c.json(ref === undefined ? body : { ...body, ref }, status);
    };
    const decision = auth.authorizeHttpRequest({
      headers: c.req.raw.headers,
      origin: c.req.header(ORIGIN_HEADER),
      operation,
      ref,
    });
    if (isErr(decision)) {
      return refusal(decision.error);
    }
    // The same pure rule the decision above enforced, over the same headers,
    // so this only extracts the value the access boundary already accepted;
    // should the two ever disagree the request is refused, never admitted.
    const actingTab = resolveActingTab(decision.value, c.req.header(ACTING_TAB_HEADER));
    if (isErr(actingTab)) {
      return refusal(actingTab.error);
    }
    c.set('operation', operation);
    c.set('actingTabId', actingTab.value);
    if (decision.value !== null) {
      c.set('principal', decision.value);
    }
    await next();
    return undefined;
  };
}
