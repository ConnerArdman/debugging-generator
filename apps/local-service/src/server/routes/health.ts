/**
 * `GET /health` — the service's liveness probe, and one of the only two
 * operations reachable without a bearer credential (AAP §0.5.6).
 *
 * ## What it answers, and why nothing more
 *
 * Exactly `@debuggen/protocol`'s {@link HealthResponse}: the service build's
 * `version`, the `protocolVersion` it speaks and whether `pairingAvailable`.
 * The VS Code extension host calls it to decide whether to spawn the service,
 * the DevTools panel to decide between "Service not running" and its pairing
 * dialog, and the root `playwright.config.ts` `webServer` polls it for a `200`
 * before the browser and end-to-end projects start.
 *
 * Because any local process can call it, the body is minimal by contract: no
 * session id, count or status, no project path, no `$DEBUGGEN_HOME`, no store
 * statistic, no connected-client or capture count, no credential or token
 * hash and no environment value. An unauthenticated caller learns that the
 * service is up, at which version, and whether pairing can be requested — and
 * nothing else. The body is built through protocol's strict
 * `healthResponseSchema` on every request, so a field added here or dropped
 * there fails in this process rather than in a client.
 *
 * ## Proving the service's identity to a challenging client
 *
 * A `200` from a loopback port proves only that *something* listens there. A
 * client about to send the editor credential — `scripts/dev-instrumented.mjs`
 * posting it to `POST /dev-server/credential` — must first know that the
 * listener is this service and not another local process that took the port.
 * It cannot ask by presenting the credential, because presenting it is the
 * disclosure it is guarding against. So the probe answers a challenge instead:
 *
 * 1. The client sends {@link SERVICE_IDENTITY_CHALLENGE_HEADER} with a fresh
 *    random value (base64url, 22 to 128 characters; the CLI sends 32 bytes).
 * 2. The service reads the editor credential from `$DEBUGGEN_HOME/auth.json`,
 *    the file the client itself read the credential from, and answers with
 *    {@link SERVICE_IDENTITY_PROOF_HEADER} — base64url HMAC-SHA256, keyed by the
 *    credential's UTF-8 bytes, over
 *    `debuggen-service-identity/v1\n<challenge>\n<endpoint>` — and
 *    {@link SERVICE_IDENTITY_ENDPOINT_HEADER}, the `<endpoint>` it bound.
 * 3. The client recomputes the HMAC with the credential it holds and the
 *    endpoint it dialled, compares, and sends the credential only on a match.
 *
 * Why this is safe to answer without authentication:
 *
 * - **It discloses nothing reusable.** The proof is a keyed digest; it reveals
 *   neither the credential nor the SHA-256 the store keeps of it, and the label
 *   separates it from every other use of the credential, which is only ever
 *   presented as a bearer and never used as a key elsewhere.
 * - **It cannot be relayed.** The endpoint is the service's own bound
 *   `host:port`, taken from its configuration rather than from the request's
 *   `Host`, and it is always an IP address: a proof is produced only when the
 *   configured host is an address literal, which is exactly what `listen()`
 *   bound. A host name is refused (`endpoint-not-an-address`) because it can
 *   stand for more than one listener — `localhost` is both `127.0.0.1` and
 *   `::1` on a dual-stack machine — and a listener on the address the service
 *   did not bind could relay the challenge here and receive a proof naming
 *   the shared name. A listener on another address or port that forwards the
 *   challenge gets a proof for this service's address, which a client
 *   comparing against the address it dialled refuses. The client draws a fresh
 *   random challenge for every probe, so a proof recorded earlier answers no
 *   later probe.
 * - **It reads the file the way the access boundary does.** The final
 *   component is inspected without following a link; only a regular,
 *   single-link file owned by this account whose mode grants no group or other
 *   access is opened, the open descriptor must name the inode that was
 *   inspected, at most {@link AUTH_FILE_READ_LIMIT_BYTES} are read, and the
 *   bytes must be `../auth.ts`'s strict `auth.json` record. A file the access
 *   boundary would distrust never keys a proof.
 * - **A failure only withholds the proof.** A malformed challenge, an unbound
 *   port, a missing configuration or any problem with the file leaves the reply
 *   exactly as an unchallenged probe gets it — the same body, the same `200`,
 *   no identity header — and is logged as one constant sentence with a reason
 *   code: never the path, the challenge, the credential or its digest.
 *
 * The body never changes, so a client that sends no challenge — the VS Code
 * extension host, the DevTools panel, `playwright.config.ts` — is unaffected.
 *
 * ## What this module does not do
 *
 * - **It registers nothing.** {@link createHealthRoutes} returns the handler
 *   keyed by its operation id; `../http.ts` registers it at the method and
 *   pattern of `HTTP_ROUTES.health` while iterating protocol's operation table,
 *   so no path is written here.
 * - **It applies no access policy.** `../auth.ts`'s middleware, installed by
 *   `../http.ts`, refuses every `http:`/`https:` `Origin` on this route as on
 *   every other and skips only the bearer check, because `health` is listed in
 *   protocol's `AUTH_EXEMPT_OPERATIONS`. No principal is set for this
 *   operation, so the handler never reads one, and no
 *   `Access-Control-Allow-Origin` header is set — its absence is what keeps a
 *   web page from reading the reply even if it provokes one.
 * - **A plain probe touches nothing that can fail.** No store, file system,
 *   pipeline or launched process is consulted, so the probe keeps answering
 *   while the rest of the service is degraded. The one injected input that
 *   could misbehave, the pairing-availability predicate, degrades to
 *   `pairingAvailable: false` rather than failing the request. A challenged
 *   probe additionally reads `auth.json`, and every way that read can fail
 *   degrades to "no proof" in the same way.
 * - **It does not authenticate the caller.** The identity headers let a
 *   client authenticate the service; the probe still grants the caller
 *   nothing, and the access boundary still decides every other route.
 *
 * ## Failure
 *
 * The only way the handler fails is a body that protocol's schema refuses — an
 * empty or over-long `serviceVersion` injected by the composition root. That is
 * a server defect, so it is reported as an `INTERNAL` {@link DebuggenError}
 * whose message is built by `describeZodIssues` (issue paths and codes, never
 * the rejected value) and thrown to `../http.ts`'s error boundary, which renders
 * it through `toPayload()` as protocol's `httpErrorResponseSchema` with the
 * status its code maps to. A failure is never answered as a success.
 *
 * Side-effect free and idempotent: every request reads the predicate once and
 * allocates one small body; a challenged request also reads one small file and
 * computes one HMAC, synchronously, because the read is bounded to a few
 * kibibytes of a local private file. Nothing here reads `process.env`;
 * configuration arrives through {@link HealthRoutesDeps}.
 */

import { createHmac } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

import type { Context, Handler } from 'hono';

import {
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  describeZodIssues,
  healthResponseSchema,
} from '@debuggen/protocol';
import type { HealthResponse, HttpOperationId } from '@debuggen/protocol';
import { DebuggenError, err, isErr, noopLogger, ok, tryCatch } from '@debuggen/shared';
import type { Logger, Result } from '@debuggen/shared';
import { inspectPrivateFileNoFollow, isSameFileIdentity } from '@debuggen/shared/node';
import type { FileIdentity } from '@debuggen/shared/node';

import type { ServiceConfig } from '../../config.js';
import { authFileSchema } from '../auth.js';
import type { ServerEnv } from '../auth.js';

/* -------------------------------------------------------------------------------------------------
 * The operation this module owns
 * ---------------------------------------------------------------------------------------------- */

/**
 * The protocol route this module serves: method, pattern, exemption flag and
 * response schema, read from the one route table rather than restated.
 */
const HEALTH_ROUTE = HTTP_ROUTES.health;

/**
 * The operation id the handler is filed under — `health`, derived from the
 * route table's own row so the key `../http.ts` looks up cannot drift from it.
 */
export const HEALTH_OPERATION = HEALTH_ROUTE.operation satisfies HttpOperationId;

/** The literal type of {@link HEALTH_OPERATION}. */
export type HealthOperation = typeof HEALTH_OPERATION;

/**
 * `Cache-Control` for the reply: a probe answer describes one instant, and a
 * cached `pairingAvailable` would offer a pairing dialog that can no longer be
 * satisfied (or hide one that can).
 */
const CACHE_CONTROL_HEADER = 'Cache-Control';

/** The `Cache-Control` value: never store, never reuse. */
const NO_STORE = 'no-store';

/* -------------------------------------------------------------------------------------------------
 * The identity-proof contract
 *
 * Every value below is shared with the client that verifies the proof
 * (`scripts/dev-instrumented.mjs`), which imports only Node built-ins and so
 * restates them. Changing any of them is a wire break, and a change to how the
 * proof is built also bumps the label's version, so a client expecting the
 * old construction fails closed rather than trusting a new one.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The request header that carries a client's challenge. Its presence alone is
 * what asks for a proof; without it the probe answers exactly as it always does.
 */
export const SERVICE_IDENTITY_CHALLENGE_HEADER = 'X-Debuggen-Identity-Challenge';

/** The response header that carries the proof: base64url, unpadded HMAC-SHA256. */
export const SERVICE_IDENTITY_PROOF_HEADER = 'X-Debuggen-Identity-Proof';

/**
 * The response header that names the endpoint the proof is bound to, in the
 * form {@link formatServiceIdentityEndpoint} produces. A client compares it
 * with the endpoint it dialled before trusting the proof.
 */
export const SERVICE_IDENTITY_ENDPOINT_HEADER = 'X-Debuggen-Identity-Endpoint';

/**
 * The domain-separation label: the first line of every proof message. It ties
 * the HMAC to this one purpose and version, so no other use of the editor
 * credential can ever produce or consume the same digest.
 */
export const SERVICE_IDENTITY_PROOF_LABEL = 'debuggen-service-identity/v1';

/**
 * A valid challenge: 22 to 128 base64url characters, so at least 16 random
 * bytes and at most 96. Nothing outside the alphabet can appear, which keeps
 * the newline-framed proof message unambiguous and a `,`-joined repeated
 * header invalid.
 */
export const SERVICE_IDENTITY_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

/**
 * The most bytes a challenged probe reads from `auth.json`. The largest record
 * `../auth.ts` admits — a credential of at most 512 characters, pretty-printed
 * with its version and issue time — stays under three kibibytes even at four
 * UTF-8 bytes per character, so a larger file is not one the service wrote and
 * is refused without being read to its end.
 */
export const AUTH_FILE_READ_LIMIT_BYTES = 16 * 1024;

/** Permission bits that grant a group or other accounts access to a file. */
const GROUP_OR_OTHER_PERMISSION_BITS = 0o077;

/** The lowest port a bound listener can report; `0` means "not bound yet". */
const MIN_BOUND_PORT = 1;

/** The highest TCP port. */
const MAX_BOUND_PORT = 65_535;

/**
 * An endpoint host as it may appear in a header value and in the proof
 * message: visible ASCII only, so no whitespace, control character or newline
 * can reach either.
 */
const ENDPOINT_HOST_PATTERN = /^[!-~]+$/;

/** The one sentence a withheld proof is logged with; the reason code says why. */
const PROOF_WITHHELD_MESSAGE = 'health probe answered a challenge without an identity proof';

/** Strict UTF-8, so a byte sequence that is not text is refused rather than replaced. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * What {@link createHealthRoutes} is built from — the narrowest set of inputs
 * that answers the probe.
 *
 * Deliberately free of the store and the auth service: neither is needed, and
 * each is something that can fail. Of the configuration only three fields are
 * read, and only to answer an identity challenge.
 */
export interface HealthRoutesDeps {
  /**
   * Where the service is bound and where its editor credential lives, read on
   * every challenged request (never cached, never on a plain probe):
   *
   * - `host` and `port` form the endpoint a proof is bound to. The composition
   *   root passes its effective configuration, whose `port` reads the **bound**
   *   port, so a service started on port `0` proves its real one; `0` means
   *   not yet bound and withholds the proof.
   * - `authFilePath` is the absolute path of `auth.json`, whose credential keys
   *   the proof.
   *
   * Optional, field by field, because the proof is: a missing field withholds
   * the proof and changes nothing else. `../http.ts` hands its whole
   * dependency aggregate through, so its own `config` reaches here unchanged.
   */
  readonly config?: Partial<Pick<ServiceConfig, 'host' | 'port' | 'authFilePath'>> | undefined;

  /**
   * The service build's own version string, reported as `version`.
   *
   * The composition root owns it (it is the `version` of
   * `apps/local-service/package.json`); protocol validates it as a non-empty,
   * bounded opaque token that clients display and never parse.
   */
  readonly serviceVersion: string;

  /**
   * Whether a pairing code can be requested right now, reported as
   * `pairingAvailable`.
   *
   * A consumer-declared port, in the style of `../auth.ts`'s
   * `ConnectionRevoker`: the composition root answers it from the connected
   * client registry — protocol defines `false` as "no editor client has
   * connected, so there is nobody to display a code". It must be cheap and
   * synchronous. A throw, or any value other than `true`, is reported as
   * unavailable.
   */
  readonly isPairingAvailable: () => boolean;

  /**
   * Where a degraded probe is reported. Defaults to `noopLogger`. Receives only
   * the route's method and pattern, the operation id, an error code or a
   * {@link ServiceIdentityWithheldReason} — never a body, a header, a file
   * path or a thrown value's message.
   */
  readonly logger?: Logger | undefined;
}

/** What {@link computeServiceIdentityProof} is computed from. */
export interface ServiceIdentityProofInput {
  /** The HMAC key: the editor credential, as a string (encoded UTF-8) or as its bytes. */
  readonly key: string | Uint8Array;
  /** The client's challenge, already validated with {@link isValidServiceIdentityChallenge}. */
  readonly challenge: string;
  /** The bound endpoint, from {@link formatServiceIdentityEndpoint}. */
  readonly endpoint: string;
}

/**
 * Why a challenged probe was answered without a proof. Logged as `reason`,
 * never sent to the client, which sees only the absence of the proof.
 *
 * - `challenge-invalid` — the challenge header does not match
 *   {@link SERVICE_IDENTITY_CHALLENGE_PATTERN}.
 * - `endpoint-unavailable` — no usable host, or the port is not bound.
 * - `endpoint-not-an-address` — the configured host is a name (`localhost`),
 *   not an IP address, so no proof could say which listener it came from.
 * - `credential-path-unavailable` — no absolute `authFilePath` was configured.
 * - `credential-absent` — nothing is at that path.
 * - `credential-exposed` — the file's mode grants a group or other accounts
 *   access, so its credential may have been read by someone else.
 * - `credential-unsafe` — a symbolic link, not a regular file, owned by another
 *   account, or hard-linked elsewhere.
 * - `credential-changed` — the descriptor opened is not the inode inspected.
 * - `credential-oversize` — larger than {@link AUTH_FILE_READ_LIMIT_BYTES}.
 * - `credential-unreadable` — any other filesystem failure.
 * - `credential-not-json` — not UTF-8 JSON.
 * - `credential-not-a-record` — JSON, but not the strict `auth.json` record.
 */
export type ServiceIdentityWithheldReason =
  | 'challenge-invalid'
  | 'endpoint-unavailable'
  | 'endpoint-not-an-address'
  | 'credential-path-unavailable'
  | 'credential-absent'
  | 'credential-exposed'
  | 'credential-unsafe'
  | 'credential-changed'
  | 'credential-oversize'
  | 'credential-unreadable'
  | 'credential-not-json'
  | 'credential-not-a-record';

/**
 * What one request's identity step concluded: no challenge was sent, a proof
 * was produced for `endpoint`, or it was withheld for `reason`.
 */
export type ServiceIdentityOutcome =
  | { readonly kind: 'not-requested' }
  | { readonly kind: 'proven'; readonly proof: string; readonly endpoint: string }
  | { readonly kind: 'withheld'; readonly reason: ServiceIdentityWithheldReason };

/** The handler of `GET /health`, on the service's hono environment. */
export type HealthRouteHandler = Handler<ServerEnv>;

/**
 * The handlers this module contributes to `../http.ts`'s exhaustive
 * `Record<HttpOperationId, RouteHandler>`: exactly one, keyed by its operation
 * id.
 */
export type HealthRoutes = Readonly<Record<HealthOperation, HealthRouteHandler>>;

/** The inputs of one health body: the two values that are not protocol constants. */
export interface HealthResponseInput {
  /** The service build's version string. */
  readonly serviceVersion: string;
  /** Whether a pairing code can be requested right now. */
  readonly pairingAvailable: boolean;
}

/* -------------------------------------------------------------------------------------------------
 * Pure helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the `GET /health` body and validates it against protocol's strict
 * `healthResponseSchema`.
 *
 * `satisfies HealthResponse` fixes the field set at compile time; the schema
 * then checks the values, so a version string protocol would refuse is caught
 * here rather than by every client. The failure is `INTERNAL` rather than
 * protocol's `PROTOCOL_INVALID_MESSAGE`: the body is this service's own output,
 * so a refusal is a server defect, never something the caller sent.
 *
 * @param input The service version and the pairing-availability flag.
 * @returns `ok(body)`, or `err` with an `INTERNAL` error whose message names the
 * failing fields and carries no rejected value.
 *
 * @example
 * ```ts
 * const body = buildHealthResponse({ serviceVersion: '0.1.0', pairingAvailable: false });
 * // body.value → { version: '0.1.0', protocolVersion: '1.0.0', pairingAvailable: false }
 * ```
 */
export function buildHealthResponse(
  input: HealthResponseInput,
): Result<HealthResponse, DebuggenError> {
  const candidate = {
    version: input.serviceVersion,
    protocolVersion: PROTOCOL_VERSION,
    pairingAvailable: input.pairingAvailable,
  } satisfies HealthResponse;

  const parsed = healthResponseSchema.safeParse(candidate);

  if (!parsed.success) {
    return err(
      new DebuggenError(
        'INTERNAL',
        `The ${HEALTH_OPERATION} response could not be built: ${describeZodIssues(parsed.error.issues)}`,
        {
          hint: 'The service was started with an invalid build version; reinstall or rebuild the service.',
          details: { operation: HEALTH_OPERATION, issueCount: parsed.error.issues.length },
        },
      ),
    );
  }

  return ok(parsed.data);
}

/**
 * Reads the pairing-availability predicate without letting it fail the probe.
 *
 * Only a literal `true` counts as available: the predicate is typed `boolean`,
 * but it is injected, and a probe that reported pairing on a truthy accident
 * would offer a dialog that cannot succeed.
 *
 * @param isPairingAvailable The injected predicate.
 * @returns `ok(flag)`, or `err` with the thrown value normalised into a
 * `DebuggenError` (`INTERNAL` unless it already carried a code).
 */
export function probePairingAvailability(
  isPairingAvailable: () => boolean,
): Result<boolean, DebuggenError> {
  return tryCatch(() => isPairingAvailable() === true, 'INTERNAL');
}

/**
 * Whether `value` is a challenge this service answers: a string matching
 * {@link SERVICE_IDENTITY_CHALLENGE_PATTERN}.
 *
 * @param value The raw header value, or anything else.
 * @returns `true` only for a 22-to-128-character base64url string.
 */
export function isValidServiceIdentityChallenge(value: unknown): value is string {
  return typeof value === 'string' && SERVICE_IDENTITY_CHALLENGE_PATTERN.test(value);
}

/**
 * Whether a host is an IP address literal, bare or bracketed, once trimmed —
 * the only kind of host an identity proof names. A host name such as
 * `localhost` is not one: it can resolve to more than one address, so a proof
 * bound to it would not say which listener produced it.
 *
 * @param host The configured host.
 * @returns `true` for an IPv4 or IPv6 address literal.
 */
function isAddressLiteral(host: string): boolean {
  const trimmed = host.trim();
  const bare = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return isIP(bare) !== 0;
}

/**
 * Formats the endpoint a proof is bound to: `address:port`, the address
 * trimmed and lower-cased, and an IPv6 literal bracketed so the port stays
 * unambiguous.
 *
 * Both sides of the proof call this (or its restatement) — the service with
 * its bound address, the client with the address it dialled — so they agree
 * on one canonical string without either parsing the other's.
 *
 * @param host The bound interface, as configured: an IP address literal
 * (`127.0.0.1`, `::1`, `[::1]`). A host name (`localhost`) has no endpoint.
 * @param port The bound port; `0` (not bound yet) and anything that is not an
 * integer in 1..65535 has no endpoint.
 * @returns The endpoint, or `undefined` when either part is missing or unusable
 * — including a host name, and a host with whitespace, control or non-ASCII
 * characters, which could not travel in a header value.
 *
 * @example
 * ```ts
 * formatServiceIdentityEndpoint('127.0.0.1', 43117); // '127.0.0.1:43117'
 * formatServiceIdentityEndpoint(' ::1 ', 43117);     // '[::1]:43117'
 * formatServiceIdentityEndpoint('localhost', 43117); // undefined
 * formatServiceIdentityEndpoint('127.0.0.1', 0);     // undefined
 * ```
 */
export function formatServiceIdentityEndpoint(
  host: string | undefined,
  port: number | undefined,
): string | undefined {
  if (typeof host !== 'string' || typeof port !== 'number') {
    return undefined;
  }
  if (!Number.isInteger(port) || port < MIN_BOUND_PORT || port > MAX_BOUND_PORT) {
    return undefined;
  }
  const normalized = host.trim().toLowerCase();
  if (!ENDPOINT_HOST_PATTERN.test(normalized) || !isAddressLiteral(normalized)) {
    return undefined;
  }
  const authority =
    normalized.includes(':') && !normalized.startsWith('[') ? `[${normalized}]` : normalized;
  return `${authority}:${String(port)}`;
}

/**
 * Computes the identity proof: the unpadded base64url HMAC-SHA256, keyed by
 * the editor credential's UTF-8 bytes, of the UTF-8 message
 * `${SERVICE_IDENTITY_PROOF_LABEL}\n${challenge}\n${endpoint}`.
 *
 * Pure and total: it validates nothing, so a caller validates the challenge
 * with {@link isValidServiceIdentityChallenge} and builds the endpoint with
 * {@link formatServiceIdentityEndpoint} first. The same function verifies a
 * proof — recompute it and compare the two in constant time.
 *
 * @param input The key, the client's challenge and the bound endpoint.
 * @returns The 43-character proof.
 *
 * @example
 * ```ts
 * const proof = computeServiceIdentityProof({
 *   key: editorToken,
 *   challenge: randomBytes(32).toString('base64url'),
 *   endpoint: formatServiceIdentityEndpoint(config.host, config.port) ?? '',
 * });
 * ```
 */
export function computeServiceIdentityProof(input: ServiceIdentityProofInput): string {
  const key = typeof input.key === 'string' ? Buffer.from(input.key, 'utf8') : input.key;
  return createHmac('sha256', key)
    .update(`${SERVICE_IDENTITY_PROOF_LABEL}\n${input.challenge}\n${input.endpoint}`, 'utf8')
    .digest('base64url');
}

/* -------------------------------------------------------------------------------------------------
 * Reading the proof's key
 * ---------------------------------------------------------------------------------------------- */

/** A withheld outcome, the shape every failed step below returns. */
type Withheld = Extract<ServiceIdentityOutcome, { kind: 'withheld' }>;

/** What reading `auth.json` produced: the credential, or why there is none. */
type CredentialKeyRead = { readonly kind: 'key'; readonly key: string } | Withheld;

/** What the bounded read of the inspected file produced. */
type BoundedRead = { readonly kind: 'bytes'; readonly bytes: Buffer } | Withheld;

/** Builds a withheld outcome. */
function withheld(reason: ServiceIdentityWithheldReason): Withheld {
  return { kind: 'withheld', reason };
}

/**
 * An optional `open` flag, or `0` where the platform lacks it. Read through
 * `unknown` because the declarations promise the POSIX constant set while
 * Windows genuinely lacks some members, and a missing one must add nothing to
 * the mask rather than a `NaN`.
 */
function optionalOpenFlag(flag: unknown): number {
  return typeof flag === 'number' ? flag : 0;
}

/**
 * The flags `auth.json` is opened with. `O_NOFOLLOW` refuses a link swapped in
 * at the final component after it was inspected; `O_NONBLOCK` keeps a FIFO
 * swapped in the same way from blocking the event loop in `open` (on a regular
 * file it changes nothing). Where either is missing, the identity comparison
 * after `open` still refuses whatever is not the inspected inode.
 */
const AUTH_FILE_OPEN_FLAGS =
  constants.O_RDONLY |
  optionalOpenFlag(constants.O_NOFOLLOW) |
  optionalOpenFlag(constants.O_NONBLOCK);

/** Whether this host enforces POSIX ownership and permission bits. */
function isPosixHost(): boolean {
  return typeof process.getuid === 'function';
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
 * Reads at most {@link AUTH_FILE_READ_LIMIT_BYTES} of the file at `path`,
 * provided the descriptor opened names the `expected` inode and a regular
 * file.
 *
 * One descriptor answers every question — type, identity, size, bytes — so the
 * answers cannot describe two different files. The buffer is one byte larger
 * than the limit, so a file that grows past it between `fstat` and the last
 * `read` is still caught.
 *
 * @throws The runtime's filesystem error when `read` or `close` fails; the
 * caller maps it to `credential-unreadable`.
 */
function readInspectedFileBounded(path: string, expected: FileIdentity): BoundedRead {
  let fd: number;
  try {
    fd = openSync(path, AUTH_FILE_OPEN_FLAGS);
  } catch (cause) {
    const code = errnoCodeOf(cause);
    if (code === 'ENOENT') {
      return withheld('credential-absent');
    }
    // `ELOOP` is what `O_NOFOLLOW` reports for a link on Linux and macOS;
    // FreeBSD reports `EMLINK`.
    return withheld(
      code === 'ELOOP' || code === 'EMLINK' ? 'credential-unsafe' : 'credential-unreadable',
    );
  }

  try {
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isFile()) {
      return withheld('credential-unsafe');
    }
    if (!isSameFileIdentity(expected, { dev: stats.dev, ino: stats.ino })) {
      return withheld('credential-changed');
    }
    if (stats.size > BigInt(AUTH_FILE_READ_LIMIT_BYTES)) {
      return withheld('credential-oversize');
    }

    const buffer = Buffer.alloc(AUTH_FILE_READ_LIMIT_BYTES + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const count = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (count === 0) {
        break;
      }
      filled += count;
    }
    if (filled > AUTH_FILE_READ_LIMIT_BYTES) {
      return withheld('credential-oversize');
    }
    return { kind: 'bytes', bytes: buffer.subarray(0, filled) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads the editor credential from `auth.json` under the access boundary's own
 * rules, without following a link and without trusting a file another account
 * could have read.
 *
 * The final component is inspected with `lstat` first: anything but a regular,
 * single-link file owned by this account is refused, and so is a mode with a
 * group or other bit (off POSIX, where there are no such bits, that test is
 * skipped as it is in `../auth.ts`). Only then is it opened, and only when the
 * descriptor names the inspected inode are its bytes read, bounded, decoded as
 * strict UTF-8, parsed as JSON and validated with `../auth.ts`'s strict
 * {@link authFileSchema}.
 *
 * @param authFilePath The absolute path of `auth.json`.
 * @returns The credential, or the reason there is none. Never throws for a
 * refusal; a filesystem failure while reading or closing propagates to the
 * caller, which maps it to `credential-unreadable`.
 */
function readEditorCredentialKey(authFilePath: string): CredentialKeyRead {
  let inspected;
  try {
    inspected = inspectPrivateFileNoFollow(authFilePath);
  } catch (cause) {
    // `DebuggenError.is` is the brand check, not `instanceof`: `@debuggen/shared/node`
    // is a separate entry point whose errors need not share this module's class.
    return withheld(
      DebuggenError.is(cause) && cause.code === 'FS_UNSAFE_PATH'
        ? 'credential-unsafe'
        : 'credential-unreadable',
    );
  }
  if (inspected === undefined) {
    return withheld('credential-absent');
  }
  if (isPosixHost() && (inspected.mode & GROUP_OR_OTHER_PERMISSION_BITS) !== 0) {
    return withheld('credential-exposed');
  }

  const read = readInspectedFileBounded(authFilePath, inspected.identity);
  if (read.kind === 'withheld') {
    return read;
  }

  let json: unknown;
  try {
    json = JSON.parse(STRICT_UTF8.decode(read.bytes));
  } catch {
    return withheld('credential-not-json');
  }
  const record = authFileSchema.safeParse(json);
  return record.success
    ? { kind: 'key', key: record.data.token }
    : withheld('credential-not-a-record');
}

/**
 * Answers one request's identity challenge, or explains why it does not.
 *
 * Every step that can fail is a {@link ServiceIdentityOutcome} of kind
 * `withheld`, never a throw, so the probe it serves always answers `200`.
 * The configuration is read here, per request, because its `port` is live.
 *
 * @param challenge The raw challenge header, or `undefined` when none was sent.
 * @param config The configuration slice of {@link HealthRoutesDeps}.
 * @returns `not-requested`, `proven` with the proof and endpoint, or `withheld`
 * with its reason.
 */
function resolveServiceIdentity(
  challenge: string | undefined,
  config: HealthRoutesDeps['config'],
): ServiceIdentityOutcome {
  if (challenge === undefined) {
    return { kind: 'not-requested' };
  }
  if (!isValidServiceIdentityChallenge(challenge)) {
    return withheld('challenge-invalid');
  }

  let host: string | undefined;
  let endpoint: string | undefined;
  let authFilePath: string | undefined;
  try {
    host = config?.host;
    endpoint = formatServiceIdentityEndpoint(host, config?.port);
    authFilePath = config?.authFilePath;
  } catch {
    // An injected configuration whose getter throws has no usable endpoint.
    return withheld('endpoint-unavailable');
  }
  if (endpoint === undefined) {
    // A readable host name is refused for what it is, so the log says what to
    // change; everything else is a host or port that is not usable at all.
    const isHostName =
      typeof host === 'string' &&
      ENDPOINT_HOST_PATTERN.test(host.trim()) &&
      !isAddressLiteral(host);
    return withheld(isHostName ? 'endpoint-not-an-address' : 'endpoint-unavailable');
  }
  if (typeof authFilePath !== 'string' || !isAbsolute(authFilePath)) {
    return withheld('credential-path-unavailable');
  }

  let read: CredentialKeyRead;
  try {
    read = readEditorCredentialKey(authFilePath);
  } catch {
    return withheld('credential-unreadable');
  }
  if (read.kind === 'withheld') {
    return read;
  }
  return {
    kind: 'proven',
    proof: computeServiceIdentityProof({ key: read.key, challenge, endpoint }),
    endpoint,
  };
}

/**
 * The reasons worth a warning, because the developer may need to act on them:
 * the state of `auth.json` itself, and a service configured with a host name,
 * which never proves its identity until `DEBUGGEN_HOST` names an address. The
 * rest describe the caller's input or a service that is not bound yet, and
 * are logged at debug.
 */
const WARNED_REASONS: ReadonlySet<ServiceIdentityWithheldReason> = new Set([
  'endpoint-not-an-address',
  'credential-absent',
  'credential-exposed',
  'credential-unsafe',
  'credential-changed',
  'credential-oversize',
  'credential-unreadable',
  'credential-not-json',
  'credential-not-a-record',
]);

/* -------------------------------------------------------------------------------------------------
 * The route factory
 * ---------------------------------------------------------------------------------------------- */

/**
 * Builds the `GET /health` handler for `../http.ts` to register.
 *
 * Registers nothing, builds no application and opens no socket. The handler
 * reads the pairing predicate once per request, degrades a failing predicate
 * to `pairingAvailable: false` with a warning, and answers `200` with the
 * schema-validated body and `Cache-Control: no-store`. A body the schema
 * refuses is thrown as its `INTERNAL` {@link DebuggenError} to the error
 * boundary of `../http.ts`, which maps the code to a status and renders the
 * payload.
 *
 * A request carrying {@link SERVICE_IDENTITY_CHALLENGE_HEADER} additionally
 * gets {@link SERVICE_IDENTITY_PROOF_HEADER} and
 * {@link SERVICE_IDENTITY_ENDPOINT_HEADER} when a proof can be produced, and
 * the unchanged reply when it cannot. A withheld proof is logged with its
 * reason: a file-state reason, or a host name where an address belongs, as a
 * warning the first time it is seen since the last proof or the last different
 * reason, every repeat and every other reason at debug — so a client that
 * keeps probing a broken `auth.json` cannot flood the log.
 *
 * @param deps The service version, the pairing predicate, the optional
 * configuration slice and an optional logger.
 * @returns A frozen record holding the one handler, keyed by
 * {@link HEALTH_OPERATION}.
 *
 * @example
 * ```ts
 * const routes = createHealthRoutes({
 *   serviceVersion,
 *   isPairingAvailable: () => editorConnected(),
 *   config, // host, bound port and authFilePath
 *   logger,
 * });
 * app.on(HTTP_ROUTES.health.method, HTTP_ROUTES.health.pattern, routes.health);
 * ```
 */
export function createHealthRoutes(deps: HealthRoutesDeps): HealthRoutes {
  const { serviceVersion, isPairingAvailable, config } = deps;
  const logger = deps.logger ?? noopLogger;

  // The reason last reported as a warning, cleared by a proof.
  let lastWarnedReason: ServiceIdentityWithheldReason | undefined;

  const reportIdentity = (outcome: ServiceIdentityOutcome): void => {
    if (outcome.kind === 'not-requested') {
      return;
    }
    if (outcome.kind === 'proven') {
      lastWarnedReason = undefined;
      return;
    }
    const fields = { operation: HEALTH_OPERATION, reason: outcome.reason };
    if (WARNED_REASONS.has(outcome.reason) && outcome.reason !== lastWarnedReason) {
      lastWarnedReason = outcome.reason;
      logger.warn(PROOF_WITHHELD_MESSAGE, fields);
      return;
    }
    logger.debug(PROOF_WITHHELD_MESSAGE, fields);
  };

  const health: HealthRouteHandler = (c: Context<ServerEnv>) => {
    const pairing = probePairingAvailability(isPairingAvailable);

    if (isErr(pairing)) {
      logger.warn('health probe could not read pairing availability; reporting it unavailable', {
        method: HEALTH_ROUTE.method,
        path: HEALTH_ROUTE.pattern,
        code: pairing.error.code,
      });
    }

    const body = buildHealthResponse({
      serviceVersion,
      pairingAvailable: pairing.ok ? pairing.value : false,
    });

    if (isErr(body)) {
      logger.error('health response failed its protocol schema', {
        method: HEALTH_ROUTE.method,
        path: HEALTH_ROUTE.pattern,
        code: body.error.code,
        reason: body.error.message,
      });
      throw body.error;
    }

    const identity = resolveServiceIdentity(
      c.req.header(SERVICE_IDENTITY_CHALLENGE_HEADER),
      config,
    );
    reportIdentity(identity);
    if (identity.kind === 'proven') {
      c.header(SERVICE_IDENTITY_PROOF_HEADER, identity.proof);
      c.header(SERVICE_IDENTITY_ENDPOINT_HEADER, identity.endpoint);
    }

    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    return c.json(body.value, 200);
  };

  return Object.freeze({ [HEALTH_OPERATION]: health });
}
