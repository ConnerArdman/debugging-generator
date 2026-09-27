/**
 * The service worker's devtools credential: where it is kept, how it is
 * obtained, and when it is given up — and, beside it in `chrome.storage.local`,
 * the one non-secret setting the developer may change: the local service's
 * address ({@link SERVICE_ENDPOINT_STORAGE_KEY}, Section F). Nothing else.
 *
 * ## What this module is
 *
 * The local service authenticates every client (AAP §0.5.6). The editor reads
 * its credential from `$DEBUGGEN_HOME/auth.json`; the Chrome extension cannot,
 * because it is not a filesystem client, so it earns its own by **pairing**:
 *
 * 1. the developer runs "Debug Generator: Pair Chrome DevTools Panel"
 *    (`debuggen.pairChrome`) in VS Code, which calls `POST /pair/start` with
 *    the editor credential and shows an eight-character one-time code;
 * 2. the developer types it into the DevTools panel's `PairDialog`, which sends
 *    it to the worker as the port request `pair.complete`;
 * 3. {@link DevtoolsCredentialStore.completePairing} redeems it with
 *    `HttpClient.pairComplete` — the auth-exempt `POST /pair/complete`, sent
 *    from the worker's own `chrome-extension://<id>` origin, which becomes the
 *    scope of the devtools credential the service issues;
 * 4. the credential is kept in `chrome.storage.local` under
 *    {@link DEVTOOLS_TOKEN_STORAGE_KEY} and handed, lazily, to both protocol
 *    clients through {@link DevtoolsCredentialStore.getToken};
 * 5. `debuggen.rotateServiceToken` revokes every credential and closes every
 *    socket with `WS_CLOSE_UNAUTHORIZED`; the worker reports that through
 *    {@link DevtoolsCredentialStore.handleUnauthorized}, the credential is
 *    dropped, and the panel shows "Not paired" until the developer pairs again.
 *
 * `ws-bridge.ts` owns both clients and every request; this module owns the
 * credential. It opens no socket, calls no `fetch` and registers no
 * `chrome.tabs` or `chrome.alarms` listener: the one network exchange it
 * performs goes through the injected {@link HttpClient}.
 *
 * ## The service address
 *
 * The service listens on a port the developer chooses (`DEBUGGEN_PORT`), so
 * the extension cannot assume `DEFAULT_SERVICE_BASE_URL`. The address is kept
 * under {@link SERVICE_ENDPOINT_STORAGE_KEY}, entered in the pairing dialog
 * (it must be right before a code can be redeemed) or, once paired, in that
 * dialog's address-only mode ("Change service address…"), and applied by
 * `service-worker.ts` to both the socket and every HTTP call.
 * {@link parseServiceEndpoint} is the one validator: the protocol's
 * loopback-only policy, narrowed to the two hosts the manifest's
 * `host_permissions` let the worker reach. The helpers are pure functions over
 * an injected storage area, so the panel's dialog and the worker share them
 * without sharing any state.
 *
 * ## Worker lifetime
 *
 * A Manifest V3 worker is suspended after about thirty seconds idle and
 * re-executed from scratch (AAP §0.1.1). The credential is therefore memoised
 * in the factory's closure for one worker generation only and re-read from
 * storage by the next. Only a *present* credential is memoised: while none is
 * held, every read goes back to storage, so a pairing recorded by an earlier
 * generation — or by another extension context — is picked up on the next
 * read rather than hidden behind a cached "absent".
 *
 * ## Invariants
 *
 * - **No import-time side effect.** Every top-level statement is a
 *   declaration, and {@link createDevtoolsCredentialStore} touches neither
 *   storage nor its change event until a method is called. `service-worker.ts`
 *   is the only wiring point, and `apps/chrome-extension/test/**` drives this
 *   module with fakes and no extension environment.
 * - **The credential never leaves the module except to a protocol client.** It
 *   is returned only by {@link DevtoolsCredentialStore.getToken} — the
 *   `TokenProvider` both clients call — and written only to
 *   `chrome.storage.local` under {@link DEVTOOLS_TOKEN_STORAGE_KEY}. It is
 *   never returned by pairing, never part of a state notification, a log line,
 *   an error's message, hint or `details`, a port response or a
 *   `WorkerStatusSnapshot` (which carries a boolean,
 *   {@link DevtoolsCredentialStore.hasToken}). The pairing code is a
 *   credential too, and is treated the same way.
 * - **Nothing rejects.** Every method's promise fulfils: failures arrive as a
 *   `Result` or as a named outcome, because an unhandled rejection takes the
 *   MV3 worker down and every panel's connection with it (AAP §0.5.5).
 * - **Nothing retries.** The pairing route is rate-limited (five failures, then
 *   a sixty-second lockout), so a refused code is reported once, verbatim, and
 *   the next attempt is the developer's.
 * - **Imports stay browser-safe.** `@debuggen/protocol`, `@debuggen/shared`'s
 *   root entry, `../shared/messages` and `./messages`, with extensionless
 *   relative specifiers (`moduleResolution: bundler`).
 *
 * Governed by AAP §0.5.6 (the local service access boundary and its "Chrome
 * extension" pairing flow), §0.4.2 (`client.hello { token }`,
 * `POST /pair/complete`, the 4401 close), §0.5.5 (the "Not paired" state) and
 * §0.7.1 Group 4 ("WS to the service with the paired token").
 *
 * @example
 * ```ts
 * // service-worker.ts — the only place the store is constructed.
 * const httpClient = new HttpClient({ baseUrl, token: () => store.getToken() });
 * const store = createDevtoolsCredentialStore({
 *   storage: chrome.storage.local,
 *   httpClient,
 *   changes: chrome.storage.local.onChanged,
 *   logger,
 * });
 * store.onStateChange((state) => {
 *   if (state === 'paired') wsBridge.connect();
 * });
 * ```
 *
 * @module apps/chrome-extension/src/background/auth
 */

import type {
  HttpClient,
  PairCompleteRequest,
  PairCompleteResponse,
  TokenProvider,
  WsUnauthorizedDetail,
} from '@debuggen/protocol';
import {
  isPlainRecord,
  isReadProof,
  pairCompleteResponseSchema,
  parseServiceOrigin,
  WS_CLOSE_UNAUTHORIZED,
} from '@debuggen/protocol';
import type { DebuggenError, DebuggenErrorCode, LogFields, Logger, Result } from '@debuggen/shared';
import { err, fromPromise, isErr, noopLogger, ok, tryCatch } from '@debuggen/shared';

import type { PANEL_CONNECTION_STATUSES } from '../shared/messages';
import { DEFAULT_SERVICE_BASE_URL } from '../shared/messages';
import type { WorkerStatusSnapshot } from './messages';
import { workerError } from './messages';

/*
 * ===========================================================================
 * Section A — constants and the persisted shape
 * ===========================================================================
 */

/**
 * The `chrome.storage.local` key the devtools credential is kept under — the
 * only place it is ever written.
 *
 * Owned here and nowhere else: no other module reads or writes the credential,
 * so no other module needs the key. `chrome.storage.local` rather than
 * `chrome.storage.session` because a pairing must survive a browser restart,
 * not only a worker suspension.
 */
export const DEVTOOLS_TOKEN_STORAGE_KEY = 'debuggen.devtoolsCredential';

/**
 * The version of the {@link StoredDevtoolsCredential} record this module
 * writes. A stored value with any other version is not trusted: it reads as
 * "no credential", and the next pairing overwrites it.
 */
export const STORED_CREDENTIAL_VERSION = 1;

/**
 * How many characters a pairing code has once surrounding whitespace is
 * trimmed: eight, per AAP §0.5.6.
 *
 * Checked locally so a mistyped code is refused before it costs one of the
 * five attempts the service's rate limit allows. Only the length is checked:
 * the alphabet is the service's generator detail, which the protocol
 * deliberately does not pin, so a well-sized code is sent exactly as typed and
 * judged by the service.
 */
export const PAIRING_CODE_LENGTH = 8;

/**
 * The record written under {@link DEVTOOLS_TOKEN_STORAGE_KEY}.
 *
 * Versioned so a later build can change the shape without trusting an older
 * one. What is read back is untrusted data from an earlier worker generation
 * (or an earlier build), so it is validated on every read: the version must be
 * {@link STORED_CREDENTIAL_VERSION}, and the credential and its read proof must
 * satisfy the very schema — `pairCompleteResponseSchema` — that validated them
 * when the service issued them.
 */
export interface StoredDevtoolsCredential {
  /** Always {@link STORED_CREDENTIAL_VERSION}. */
  readonly version: typeof STORED_CREDENTIAL_VERSION;
  /** The devtools credential exactly as `POST /pair/complete` returned it. */
  readonly token: PairCompleteResponse['token'];
  /**
   * The read proof `POST /pair/complete` returned with {@link token}, which
   * every DevTools read carries (`READ_PROOF_HEADER`). Every record this build
   * writes has one. A record an earlier build wrote has none: it still reads as
   * paired, and its first read — refused by the service as `UNAUTHORIZED` —
   * drops it through {@link DevtoolsCredentialStore.handleUnauthorized}, so the
   * developer pairs again. ⚠️ As secret as the token.
   */
  readonly readProof?: PairCompleteResponse['readProof'];
}

/** A credential this store holds, with the read proof issued with it when it has one. */
interface HeldCredential {
  readonly token: string;
  readonly readProof: string | undefined;
}

/**
 * The one shared error code that means "this credential is refused, obtain a
 * new one" on the HTTP path.
 *
 * The other members of the unauthorized family are deliberately excluded:
 * `FORBIDDEN_ORIGIN` is a refusal no credential can fix, `RATE_LIMITED` is a
 * lockout that ends by itself, and the two `PAIRING_*` codes are answers to a
 * pairing attempt, not to a protected request.
 */
const CREDENTIAL_REFUSED_CODE = 'UNAUTHORIZED' satisfies DebuggenErrorCode;

/** The code every locally refused pairing code is reported with. */
const PAIRING_CODE_REFUSED_CODE = 'PAIRING_INVALID' satisfies DebuggenErrorCode;

/** How the developer obtains a code: the editor command's palette title. */
const PAIRING_CODE_HINT =
  'Run "Debug Generator: Pair Chrome DevTools Panel" (debuggen.pairChrome) in VS Code and enter the 8-character code it shows.';

/**
 * Fields attached to every log record of this module: the storage key's name
 * and never its value (AAP §0.5.2).
 */
const KEY_FIELDS = Object.freeze({ key: DEVTOOLS_TOKEN_STORAGE_KEY });

/*
 * ===========================================================================
 * Section B — injected dependencies
 * ===========================================================================
 */

/**
 * The part of `chrome.storage.local` the store uses: the promise forms of
 * `get`, `set` and `remove` (Manifest V3, Chrome 95+).
 *
 * `chrome.storage.local` satisfies it —
 * {@link ChromeLocalStorageSatisfiesCredentialStorageArea} proves that at
 * compile time — and a test passes a three-method in-memory fake.
 */
export interface CredentialStorageArea {
  /** Read one key; the result holds it only when it is stored. */
  readonly get: (keys: string) => Promise<Readonly<Record<string, unknown>>>;
  /** Write every key of `items`. */
  readonly set: (items: Readonly<Record<string, unknown>>) => Promise<void>;
  /** Remove one key; removing an absent key is not an error. */
  readonly remove: (keys: string) => Promise<void>;
}

/** One key's change, as `chrome.storage` reports it. */
export interface CredentialStorageChange {
  /** The value before the change, when there was one. */
  readonly oldValue?: unknown;
  /** The value after the change, when there is one. */
  readonly newValue?: unknown;
}

/** A listener for {@link CredentialStorageChangeEvent}. */
export type CredentialStorageChangeListener = (
  changes: Readonly<Record<string, CredentialStorageChange>>,
) => void;

/**
 * The area-scoped change event, shaped like `chrome.storage.local.onChanged`,
 * which satisfies it ({@link ChromeLocalOnChangedSatisfiesCredentialStorageChangeEvent}).
 *
 * Optional: the store works without it, because a missing credential is never
 * memoised and is re-read on every use. With it, a credential removed or
 * replaced by another extension context — "Clear storage" in the extension's
 * own DevTools, for instance — takes effect in the worker at once instead of on
 * the next refusal. The listener is added on the store's first use, never by
 * the factory, and it is not a wake-up listener: nothing about the worker's
 * lifecycle depends on it.
 */
export interface CredentialStorageChangeEvent {
  /** Start delivering changes to `listener`. */
  readonly addListener: (listener: CredentialStorageChangeListener) => void;
  /** Stop delivering changes to `listener`. */
  readonly removeListener: (listener: CredentialStorageChangeListener) => void;
}

/**
 * Everything {@link createDevtoolsCredentialStore} needs, injected, so the
 * store runs against fakes in `apps/chrome-extension/test/**` and against the
 * real `chrome.*` namespaces in `service-worker.ts`.
 */
export interface DevtoolsCredentialStoreDeps {
  /** Where the credential is kept: `chrome.storage.local` in the worker. */
  readonly storage: CredentialStorageArea;

  /**
   * The worker's one {@link HttpClient} — the instance `ws-bridge.ts` shares,
   * so that installing the credential with `setToken` after a pairing affects
   * every call either module makes.
   *
   * A thunk is accepted as well, for a composition root that resolves the
   * mutual reference (the client's `token` delegates to this store, and this
   * store redeems pairing codes through the client) lazily. Either form is
   * dereferenced only inside a method, never by the factory.
   */
  readonly httpClient: HttpClient | (() => HttpClient);

  /**
   * The storage area's change event, when change tracking is wanted — see
   * {@link CredentialStorageChangeEvent}.
   */
  readonly changes?: CredentialStorageChangeEvent | undefined;

  /**
   * Where lifecycle events go. Defaults to `noopLogger`. Records name events
   * and the storage key only — never the credential or a pairing code.
   */
  readonly logger?: Logger | undefined;
}

/*
 * ===========================================================================
 * Section C — the store's public contract
 * ===========================================================================
 */

/**
 * The one member of the panel's connection vocabulary this module decides:
 * `'not-paired'`, taken from `PANEL_CONNECTION_STATUSES` in
 * `../shared/messages` rather than spelled again, so renaming the status there
 * fails to compile here ({@link PairingStateCoversNotPaired}).
 */
type NotPairedStatus = Extract<(typeof PANEL_CONNECTION_STATUSES)[number], 'not-paired'>;

/** The {@link NotPairedStatus} value, checked against the vocabulary. */
const NOT_PAIRED: NotPairedStatus = 'not-paired';

/**
 * The store's externally visible condition.
 *
 * - `'paired'` — a devtools credential is held; the socket may connect.
 * - `'pairing'` — a `pair.complete` exchange is in flight.
 * - `'not-paired'` — no credential is held: the panel's "Not paired" state,
 *   the same member of `PANEL_CONNECTION_STATUSES` the connection pill
 *   renders (AAP §0.5.5).
 *
 * `'paired'` and `'pairing'` have no counterpart in the pill's vocabulary on
 * purpose: holding a credential says nothing about the transport, so the pill
 * derives `'connected'`, `'reconnecting'` or `'service-not-running'` from the
 * socket and the health probe (`panelConnectionStatus` in
 * `../shared/messages`), with `hasCredential` from
 * {@link DevtoolsCredentialStore.hasToken}.
 */
export type PairingState = 'paired' | 'pairing' | NotPairedStatus;

/** Receives every change of {@link PairingState}; never the credential. */
export type PairingStateListener = (state: PairingState) => void;

/**
 * Why the worker believes a credential was refused: what the socket client
 * reported to its `onUnauthorized` hook, or the failure an HTTP call returned.
 */
export type UnauthorizedEvidence = WsUnauthorizedDetail | DebuggenError;

/**
 * What {@link DevtoolsCredentialStore.handleUnauthorized} did.
 *
 * - `'cleared'` — the credential was presented and refused; it is gone from
 *   memory and storage, and the state is `'not-paired'`.
 * - `'already-unpaired'` — no credential was held, so there was nothing to
 *   refuse; the state is `'not-paired'`.
 * - `'superseded'` — a newer credential, installed by a pairing, has not been
 *   presented to any client yet, so the refusal concerned the one it replaced;
 *   the new credential is kept.
 * - `'ignored'` — the evidence is not a credential refusal (another close
 *   code, or `FORBIDDEN_ORIGIN`/`RATE_LIMITED`, which no new credential fixes);
 *   nothing changed.
 */
export type UnauthorizedHandling = 'cleared' | 'already-unpaired' | 'superseded' | 'ignored';

/**
 * The devtools credential store.
 *
 * Every member is a function-valued property rather than a method, and none
 * uses `this`, so each can be handed on as a bare reference —
 * `tokenProvider: store.getToken`, `onUnauthorized: store.handleUnauthorized`
 * — exactly as `service-worker.ts` does. Every returned promise fulfils; none
 * rejects.
 */
export interface DevtoolsCredentialStore {
  /**
   * The lazy credential getter both protocol clients call: `HttpClient`'s
   * `token` option or `setToken` argument, and `ReconnectingWsClient`'s `token`
   * option. Assignable to `@debuggen/protocol`'s `TokenProvider`
   * ({@link StoreGetTokenIsTokenProvider}); always asynchronous, because the
   * first read of a worker generation is a storage read.
   *
   * @returns The credential, or `undefined` when none is held — a state, not an
   * error: the HTTP client then fails protected calls locally, and the socket
   * client refuses to connect, instead of sending anything unauthenticated.
   */
  readonly getToken: () => Promise<string | undefined>;

  /**
   * The read proof issued with the held credential, which the service requires
   * as `READ_PROOF_HEADER` on every DevTools read (`session.get`, `panel.get`,
   * `panel.getById`, `modifications.list`). Read with the same freshness as
   * {@link getToken}: storage first when this worker generation holds nothing.
   *
   * @returns The proof, or `undefined` when no credential is held or the held
   * one was stored by an earlier build without a proof — whose reads the
   * service then refuses as `UNAUTHORIZED`, which {@link handleUnauthorized}
   * turns into a new pairing. ⚠️ As secret as the credential: handed only to
   * the protocol HTTP client, never logged.
   */
  readonly getReadProof: () => Promise<string | undefined>;

  /**
   * Redeem a one-time pairing code for a devtools credential.
   *
   * The code is trimmed and must then have {@link PAIRING_CODE_LENGTH}
   * characters; anything else is refused locally with `PAIRING_INVALID`,
   * spending none of the service's attempts. A well-sized code is sent once
   * through `HttpClient.pairComplete`, and a refusal — `PAIRING_INVALID`,
   * `PAIRING_EXPIRED`, `RATE_LIMITED`, `FORBIDDEN_ORIGIN`, or a transport
   * failure — is returned exactly as the client produced it, never retried.
   *
   * On success the credential is installed on the shared `HttpClient`
   * (`setToken(store.getToken)`), written to storage with the read proof issued
   * with it, and the state moves to `'paired'`, which is the listeners' cue to
   * connect the socket.
   *
   * A second call while one is in flight does not spend another attempt: the
   * same code joins the attempt already running, and a different code waits for
   * it — and is not submitted at all if that attempt paired the worker.
   *
   * @param code The code as the developer typed it.
   * @returns `ok` when a credential is held and saved. An `Err` with
   * `STORE_ERROR` means the pairing itself succeeded — the credential is held
   * and the state is `'paired'` — but it could not be saved, so the next
   * worker generation will not have it. The credential is never returned.
   */
  readonly completePairing: (
    code: PairCompleteRequest['code'],
  ) => Promise<Result<void, DebuggenError>>;

  /**
   * React to a refusal of the credential: the socket client's `onUnauthorized`
   * hook (a close with `WS_CLOSE_UNAUTHORIZED`, including the client's local
   * refusal when no credential resolved) or an HTTP failure with the
   * unauthorized code.
   *
   * A refused credential is dropped from memory and storage and the state
   * moves to `'not-paired'`: `ReconnectingWsClient` treats a 4401 as terminal
   * for that credential, so pairing again is what unblocks the developer. The
   * evidence is checked before anything is dropped — see
   * {@link UnauthorizedHandling} — so a refusal that concerns an older
   * credential, or that no credential could fix, leaves a good one in place.
   *
   * @param evidence What reported the refusal. Omitted, the refusal is taken
   * as given.
   * @returns What was done.
   */
  readonly handleUnauthorized: (evidence?: UnauthorizedEvidence) => Promise<UnauthorizedHandling>;

  /**
   * Forget the credential unconditionally — the explicit unpair, used when
   * rotation is known to have invalidated it.
   *
   * @returns `ok` once memory and storage are clear; an `Err` with
   * `STORE_ERROR` when storage refused the removal, in which case the
   * credential is still gone from this worker generation.
   */
  readonly clearToken: () => Promise<Result<void, DebuggenError>>;

  /**
   * Whether a credential is held, reading storage when this worker generation
   * has not yet found one — the value of `WorkerStatusSnapshot.hasCredential`.
   * Always asynchronous, so a freshly revived worker answers from storage
   * rather than from an empty memo.
   */
  readonly hasToken: () => Promise<WorkerStatusSnapshot['hasCredential']>;

  /**
   * The current {@link PairingState}, reading storage first when this worker
   * generation has not established it yet.
   */
  readonly getState: () => Promise<PairingState>;

  /**
   * Subscribe to state changes. A listener is called once per transition, in
   * subscription order, with the new state only; a throwing listener is logged
   * and does not stop the others.
   *
   * @returns The unsubscribe function; calling it twice is harmless.
   */
  readonly onStateChange: (listener: PairingStateListener) => () => void;

  /**
   * Detach the storage change listener, when one was added, and drop every
   * state listener. The store keeps answering afterwards, without change
   * tracking and without notifications.
   */
  readonly dispose: () => void;
}

/*
 * ===========================================================================
 * Section D — pure helpers
 *
 * Total functions: each returns a value for every input and never throws. Not
 * one of them builds a string from a credential or a pairing code — messages
 * are built from codes, lengths and constants only, following the protocol
 * package's precedent for failure text.
 * ===========================================================================
 */

/**
 * The credential in a candidate value, when it is one: a string the protocol's
 * own `pairCompleteResponseSchema` accepts as a `token`.
 *
 * @param candidate Anything.
 * @returns The credential, or `undefined`.
 */
function wellFormedToken(candidate: unknown): string | undefined {
  const parsed = pairCompleteResponseSchema.shape.token.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Read a {@link StoredDevtoolsCredential} back from untrusted storage data.
 *
 * @param value What storage held under {@link DEVTOOLS_TOKEN_STORAGE_KEY}.
 * @returns The credential when the record has the current version, a
 * well-formed token and either a well-formed read proof or none at all (a
 * record an earlier build wrote); otherwise `undefined`, which reads as "not
 * paired". A malformed read proof makes the whole record unreadable rather than
 * a credential without one.
 */
function decodeStoredCredential(value: unknown): HeldCredential | undefined {
  if (!isPlainRecord(value) || value.version !== STORED_CREDENTIAL_VERSION) {
    return undefined;
  }
  const token = wellFormedToken(value.token);
  if (token === undefined) {
    return undefined;
  }
  const { readProof } = value;
  if (readProof === undefined) {
    return { token, readProof: undefined };
  }
  return isReadProof(readProof) ? { token, readProof } : undefined;
}

/**
 * Check a pairing code's shape before it costs a service attempt: trim it,
 * refuse it when empty, and refuse it unless {@link PAIRING_CODE_LENGTH}
 * characters remain.
 *
 * @param code The code as typed; `unknown` because it crossed a port.
 * @returns The trimmed code, or a `PAIRING_INVALID` failure whose message and
 * `details` carry lengths only.
 */
function normalizePairingCode(code: unknown): Result<string, DebuggenError> {
  if (typeof code !== 'string') {
    return err(
      workerError(PAIRING_CODE_REFUSED_CODE, 'The pairing code must be text.', {
        hint: PAIRING_CODE_HINT,
      }),
    );
  }
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return err(
      workerError(PAIRING_CODE_REFUSED_CODE, 'Enter the pairing code shown in VS Code.', {
        hint: PAIRING_CODE_HINT,
      }),
    );
  }
  if (trimmed.length !== PAIRING_CODE_LENGTH) {
    return err(
      workerError(
        PAIRING_CODE_REFUSED_CODE,
        `A pairing code has ${String(PAIRING_CODE_LENGTH)} characters; the code entered has ${String(trimmed.length)}.`,
        {
          hint: PAIRING_CODE_HINT,
          details: { expectedLength: PAIRING_CODE_LENGTH, receivedLength: trimmed.length },
        },
      ),
    );
  }
  return ok(trimmed);
}

/**
 * Whether the evidence says the credential itself was refused — the one case
 * a new pairing fixes.
 *
 * A socket close counts only with `WS_CLOSE_UNAUTHORIZED`; an HTTP failure
 * only with {@link CREDENTIAL_REFUSED_CODE}. No evidence is taken as a refusal,
 * because the caller is then asserting it.
 *
 * @param evidence The socket client's unauthorized detail, an HTTP failure, or
 * nothing.
 */
function isCredentialRefusal(evidence: UnauthorizedEvidence | undefined): boolean {
  if (evidence === undefined) {
    return true;
  }
  const code: number | DebuggenErrorCode = evidence.code;
  return typeof code === 'number'
    ? code === WS_CLOSE_UNAUTHORIZED
    : code === CREDENTIAL_REFUSED_CODE;
}

/**
 * Log fields describing where a refusal came from: the numeric close code or
 * the error code, never the close reason, the error message or any value.
 *
 * @param evidence As {@link isCredentialRefusal} receives it.
 */
function describeEvidence(evidence: UnauthorizedEvidence | undefined): LogFields {
  if (evidence === undefined) {
    return { source: 'caller' };
  }
  const code: number | DebuggenErrorCode = evidence.code;
  return typeof code === 'number'
    ? { source: 'socket', closeCode: code }
    : { source: 'http', errorCode: code };
}

/**
 * Name a thrown value for a log line without rendering it: its `Error` name,
 * or its `typeof`. A listener's exception could carry anything.
 *
 * @param thrown A caught value.
 */
function describeThrown(thrown: unknown): string {
  return thrown instanceof Error ? thrown.name : typeof thrown;
}

/*
 * ===========================================================================
 * Section E — the store
 * ===========================================================================
 */

/** One pairing exchange in flight. The code stays in this closure only. */
interface PendingPairing {
  /** The trimmed code being redeemed; compared, never logged. */
  readonly code: string;
  /** The exchange's outcome, shared by every caller that joins it. */
  readonly outcome: Promise<Result<void, DebuggenError>>;
}

/** One state subscription; a wrapper, so one function may subscribe twice. */
interface StateSubscription {
  readonly listener: PairingStateListener;
}

/** The unsubscribe handed out once the store is disposed. */
const NOOP_UNSUBSCRIBE = (): void => undefined;

/**
 * Create the worker's devtools credential store.
 *
 * Pure construction: nothing is read, written or subscribed until a method is
 * called, so constructing the store at the top of `service-worker.ts` — where
 * every `chrome.*` listener must be registered synchronously — costs nothing.
 *
 * ## How the credential is tracked
 *
 * The closure holds the credential once it is known to exist (`memo`), a
 * generation counter bumped whenever the held credential changes, and whether
 * the held credential has been handed to a client yet (`presented`). Two races
 * follow from the worker's concurrency, and both are closed with those three:
 *
 * - **A read overtaken by a write.** A storage read that started before a
 *   pairing or a clear finished is discarded when it lands, because the
 *   generation moved: the in-memory value is the fresher one.
 * - **A refusal overtaken by a pairing.** A 4401 that arrives after a pairing
 *   installed a new credential, but before any client presented it, cannot be
 *   about that credential; {@link DevtoolsCredentialStore.handleUnauthorized}
 *   answers `'superseded'` and keeps it. The new credential is adopted in
 *   memory *before* its storage write is issued, so there is no window in
 *   which a stale refusal can see the old state.
 *
 * Whenever a credential is adopted — by pairing, by the first read of a worker
 * generation, or by a change another context made — the shared `HttpClient`
 * is pointed at {@link DevtoolsCredentialStore.getToken} with `setToken`, so a
 * client built without a credential starts authenticating without being
 * rebuilt. The socket is reconnected by the state listeners, never here.
 *
 * @param deps Storage, the shared HTTP client, and optionally the storage
 * change event and a logger.
 * @returns The store. See {@link DevtoolsCredentialStore} for each member.
 */
export function createDevtoolsCredentialStore(
  deps: DevtoolsCredentialStoreDeps,
): DevtoolsCredentialStore {
  const { storage, changes } = deps;
  const logger = deps.logger ?? noopLogger;

  /** The credential, while one is known to exist. Never a cached absence. */
  let memo: string | undefined;
  /** The read proof issued with {@link memo}; `undefined` whenever it is, or when it has none. */
  let memoProof: string | undefined;
  /** Whether this worker generation has established the state at all. */
  let known = false;
  /** Bumped whenever {@link memo} changes. */
  let generation = 0;
  /** Whether the current {@link memo} has been handed to a client. */
  let presented = false;
  /** The storage read in flight, shared by concurrent callers. */
  let read: Promise<string | undefined> | undefined;
  /** The pairing exchange in flight, most recent first in line. */
  let pending: PendingPairing | undefined;
  /** The last state listeners were told about. */
  let announced: PairingState | undefined;
  /** Whether the storage change listener has been added. */
  let subscribed = false;
  /** Whether {@link dispose} ran. */
  let disposed = false;
  /** Whether an unreadable stored value has been reported this generation. */
  let reportedUnreadable = false;
  const subscriptions = new Set<StateSubscription>();

  /** The shared HTTP client, resolved at the moment it is needed. */
  const resolveClient = (): HttpClient =>
    typeof deps.httpClient === 'function' ? deps.httpClient() : deps.httpClient;

  /** The state as the closure now knows it; `undefined` until it is known. */
  const currentState = (): PairingState | undefined => {
    if (pending !== undefined) {
      return 'pairing';
    }
    if (memo !== undefined) {
      return 'paired';
    }
    return known ? NOT_PAIRED : undefined;
  };

  /** Tell every listener about a state it has not been told yet. */
  const publish = (): void => {
    const state = currentState();
    if (state === undefined || state === announced) {
      return;
    }
    announced = state;
    for (const subscription of [...subscriptions]) {
      try {
        subscription.listener(state);
      } catch (thrown) {
        logger.error('A pairing state listener threw; the remaining listeners still run.', {
          ...KEY_FIELDS,
          state,
          thrown: describeThrown(thrown),
        });
      }
    }
  };

  /**
   * Point the shared HTTP client at this store's getter. Guarded, because the
   * client may arrive as a thunk that the composition root has to resolve.
   */
  const installOnClient = (): void => {
    const installed = tryCatch(() => {
      resolveClient().setToken(getToken);
    }, 'INTERNAL');
    if (!installed.ok) {
      logger.error('The devtools credential could not be installed on the HTTP client.', {
        ...KEY_FIELDS,
        errorCode: installed.error.code,
      });
    }
  };

  /** Hold a credential that has not been presented to any client yet. */
  const adopt = (held: HeldCredential): void => {
    memo = held.token;
    memoProof = held.readProof;
    generation += 1;
    presented = false;
    known = true;
    installOnClient();
  };

  /** Hold no credential. */
  const forget = (): void => {
    memo = undefined;
    memoProof = undefined;
    generation += 1;
    presented = false;
    known = true;
  };

  /** Read the stored credential. Fulfils with `undefined` on any failure. */
  const readStored = async (): Promise<HeldCredential | undefined> => {
    const outcome = await fromPromise(
      Promise.resolve().then(() => storage.get(DEVTOOLS_TOKEN_STORAGE_KEY)),
      'STORE_ERROR',
    );
    if (!outcome.ok) {
      logger.warn('The devtools credential could not be read from extension storage.', {
        ...KEY_FIELDS,
        errorCode: outcome.error.code,
      });
      return undefined;
    }
    const items: unknown = outcome.value;
    const raw = isPlainRecord(items) ? items[DEVTOOLS_TOKEN_STORAGE_KEY] : undefined;
    if (raw === undefined) {
      return undefined;
    }
    const held = decodeStoredCredential(raw);
    if (held === undefined && !reportedUnreadable) {
      reportedUnreadable = true;
      logger.warn(
        'The stored devtools credential is unreadable and is ignored; pairing again replaces it.',
        KEY_FIELDS,
      );
    }
    return held;
  };

  /**
   * Resolve the held credential, reading storage when none is held. Concurrent
   * callers share one read, and a read overtaken by a pairing or a clear is
   * discarded in favour of the in-memory value.
   */
  const hydrate = (): Promise<string | undefined> => {
    if (memo !== undefined) {
      return Promise.resolve(memo);
    }
    if (read !== undefined) {
      return read;
    }
    const startedAt = generation;
    const current: Promise<string | undefined> = readStored().then((stored) => {
      if (read === current) {
        read = undefined;
      }
      if (generation === startedAt) {
        known = true;
        if (stored !== undefined) {
          adopt(stored);
          logger.debug('Devtools credential restored from extension storage.', KEY_FIELDS);
        }
      }
      publish();
      return memo;
    });
    read = current;
    return current;
  };

  /** Write the credential record. Fulfils with the outcome; never rejects. */
  const persist = (token: string, readProof: string): Promise<Result<void, DebuggenError>> => {
    const record: StoredDevtoolsCredential = {
      version: STORED_CREDENTIAL_VERSION,
      token,
      readProof,
    };
    return fromPromise(
      Promise.resolve().then(() => storage.set({ [DEVTOOLS_TOKEN_STORAGE_KEY]: record })),
      'STORE_ERROR',
    );
  };

  /** Remove the credential record. Fulfils with the outcome; never rejects. */
  const erase = (): Promise<Result<void, DebuggenError>> =>
    fromPromise(
      Promise.resolve().then(() => storage.remove(DEVTOOLS_TOKEN_STORAGE_KEY)),
      'STORE_ERROR',
    );

  /**
   * Apply a change another extension context made to the stored credential.
   *
   * A change is applied only when its old value is the credential this worker
   * holds: the worker's own writes (made after it already adopted or forgot
   * the credential) and changes that an earlier change overtook both fail
   * that test and are ignored.
   */
  const onStorageChanged = (changesByKey: unknown): void => {
    if (!isPlainRecord(changesByKey)) {
      return;
    }
    const change = changesByKey[DEVTOOLS_TOKEN_STORAGE_KEY];
    if (!isPlainRecord(change)) {
      return;
    }
    const previous = decodeStoredCredential(change.oldValue)?.token;
    const next = decodeStoredCredential(change.newValue);
    if (previous !== memo || next?.token === memo) {
      return;
    }
    if (next === undefined) {
      forget();
      logger.info(
        'The devtools credential was removed from extension storage by another context.',
        KEY_FIELDS,
      );
    } else {
      adopt(next);
      logger.info(
        'The devtools credential was replaced in extension storage by another context.',
        KEY_FIELDS,
      );
    }
    publish();
  };

  /** Add the storage change listener on first use, when one was injected. */
  const ensureSubscribed = (): void => {
    if (subscribed || disposed || changes === undefined) {
      return;
    }
    subscribed = true;
    const added = tryCatch(() => {
      changes.addListener(onStorageChanged);
    }, 'INTERNAL');
    if (!added.ok) {
      logger.warn('Storage change tracking is unavailable; the credential is re-read instead.', {
        ...KEY_FIELDS,
        errorCode: added.error.code,
      });
    }
  };

  const getToken = async (): Promise<string | undefined> => {
    ensureSubscribed();
    await hydrate();
    // Answer with the freshest value, not the one the read produced: a pairing
    // or a clear may have landed while the read was in flight.
    if (memo !== undefined) {
      presented = true;
    }
    return memo;
  };

  const getReadProof = async (): Promise<string | undefined> => {
    ensureSubscribed();
    await hydrate();
    // The proof of the credential held now, for the same reason getToken
    // answers with the freshest value.
    return memo === undefined ? undefined : memoProof;
  };

  /**
   * One pairing exchange, after the one queued before it (if any) settled.
   * Never rejects: a transport that broke `HttpClient`'s never-reject contract
   * is reported as `INTERNAL` without keeping the thrown value, which could
   * quote the code.
   */
  const attemptPairing = async (
    code: string,
    predecessor: Promise<Result<void, DebuggenError>> | undefined,
  ): Promise<Result<void, DebuggenError>> => {
    // Establish what this generation holds before the exchange, so a refused
    // code returns the state to what it was — `'paired'` when a stored
    // credential already exists, `'not-paired'` otherwise — rather than to an
    // unknown one.
    await hydrate();
    if (predecessor !== undefined) {
      const earlier = await predecessor;
      if (earlier.ok && memo !== undefined) {
        logger.info(
          'An earlier pairing attempt already paired this worker; the later code was not submitted.',
          KEY_FIELDS,
        );
        return ok(undefined);
      }
    }

    const exchanged = await fromPromise(
      Promise.resolve().then(() => resolveClient().pairComplete(code)),
      'INTERNAL',
    );
    if (!exchanged.ok) {
      logger.error('The pairing request failed outside the HTTP client contract.', {
        ...KEY_FIELDS,
        errorCode: exchanged.error.code,
      });
      return err(
        workerError('INTERNAL', 'The pairing request failed unexpectedly.', {
          hint: PAIRING_CODE_HINT,
        }),
      );
    }

    const response = exchanged.value;
    if (!response.ok) {
      // Returned unchanged — code, message and hint as the client built them —
      // so the panel renders the service's answer. Never retried: the route
      // locks out after five failures.
      logger.warn('The local service refused the pairing code.', {
        ...KEY_FIELDS,
        errorCode: response.error.code,
      });
      return err(response.error);
    }

    const token = wellFormedToken(response.value.token);
    const { readProof } = response.value;
    if (token === undefined || !isReadProof(readProof)) {
      logger.error('The pairing response carried no usable credential.', KEY_FIELDS);
      return err(
        workerError(
          'PROTOCOL_INVALID_MESSAGE',
          'The local service answered the pairing request without a usable credential.',
          { hint: PAIRING_CODE_HINT },
        ),
      );
    }

    adopt({ token, readProof });
    const saved = await persist(token, readProof);
    if (!saved.ok) {
      logger.warn('Paired, but the devtools credential could not be saved to extension storage.', {
        ...KEY_FIELDS,
        errorCode: saved.error.code,
      });
      return err(
        workerError(
          'STORE_ERROR',
          'Pairing succeeded, but the credential could not be saved in extension storage.',
          {
            hint: 'The panel stays paired until Chrome restarts the extension; pair again after that.',
            cause: saved.error,
          },
        ),
      );
    }
    logger.info('Pairing completed; the devtools credential is saved.', KEY_FIELDS);
    return ok(undefined);
  };

  const completePairing = async (
    code: PairCompleteRequest['code'],
  ): Promise<Result<void, DebuggenError>> => {
    ensureSubscribed();
    const normalized = normalizePairingCode(code);
    if (!normalized.ok) {
      logger.info('A malformed pairing code was refused before submission.', {
        ...KEY_FIELDS,
        errorCode: normalized.error.code,
      });
      return err(normalized.error);
    }
    const submitted = normalized.value;

    const inFlight = pending;
    if (inFlight !== undefined && inFlight.code === submitted) {
      return inFlight.outcome;
    }
    const entry: PendingPairing = {
      code: submitted,
      outcome: attemptPairing(submitted, inFlight?.outcome),
    };
    pending = entry;
    publish();

    const result = await entry.outcome;
    if (pending === entry) {
      pending = undefined;
    }
    publish();
    return result;
  };

  const handleUnauthorized = async (
    evidence?: UnauthorizedEvidence,
  ): Promise<UnauthorizedHandling> => {
    ensureSubscribed();
    if (!isCredentialRefusal(evidence)) {
      logger.debug('A refusal that no new credential fixes; the credential is kept.', {
        ...KEY_FIELDS,
        ...describeEvidence(evidence),
      });
      return 'ignored';
    }
    // Let a storage read in flight land first, so the decision below is made
    // against what storage holds rather than against an empty memo.
    if (read !== undefined) {
      await read;
    }
    if (memo === undefined) {
      known = true;
      publish();
      return 'already-unpaired';
    }
    if (!presented) {
      logger.info(
        'A refusal arrived before any client presented the current credential; it is kept.',
        { ...KEY_FIELDS, ...describeEvidence(evidence) },
      );
      return 'superseded';
    }

    forget();
    publish();
    const removed = await erase();
    if (!removed.ok) {
      logger.warn('The refused devtools credential could not be removed from extension storage.', {
        ...KEY_FIELDS,
        errorCode: removed.error.code,
      });
    }
    logger.info('The devtools credential was cleared after the service refused it.', {
      ...KEY_FIELDS,
      ...describeEvidence(evidence),
    });
    return 'cleared';
  };

  const clearToken = async (): Promise<Result<void, DebuggenError>> => {
    ensureSubscribed();
    forget();
    publish();
    const removed = await erase();
    if (!removed.ok) {
      logger.warn('The devtools credential could not be removed from extension storage.', {
        ...KEY_FIELDS,
        errorCode: removed.error.code,
      });
      return err(
        workerError(
          'STORE_ERROR',
          'The devtools credential was dropped by the service worker but could not be removed from extension storage.',
          { hint: 'Pair again to replace it.', cause: removed.error },
        ),
      );
    }
    logger.info('The devtools credential was cleared.', KEY_FIELDS);
    return ok(undefined);
  };

  const hasToken = async (): Promise<boolean> => {
    ensureSubscribed();
    await hydrate();
    return memo !== undefined;
  };

  const getState = async (): Promise<PairingState> => {
    ensureSubscribed();
    if (pending === undefined && memo === undefined) {
      await hydrate();
    }
    return currentState() ?? NOT_PAIRED;
  };

  const onStateChange = (listener: PairingStateListener): (() => void) => {
    if (disposed) {
      return NOOP_UNSUBSCRIBE;
    }
    const subscription: StateSubscription = { listener };
    subscriptions.add(subscription);
    return () => {
      subscriptions.delete(subscription);
    };
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    subscriptions.clear();
    if (subscribed && changes !== undefined) {
      const removed = tryCatch(() => {
        changes.removeListener(onStorageChanged);
      }, 'INTERNAL');
      if (!removed.ok) {
        logger.warn('The storage change listener could not be removed.', {
          ...KEY_FIELDS,
          errorCode: removed.error.code,
        });
      }
    }
    subscribed = false;
  };

  return Object.freeze({
    getToken,
    getReadProof,
    completePairing,
    handleUnauthorized,
    clearToken,
    hasToken,
    getState,
    onStateChange,
    dispose,
  });
}

/*
 * ===========================================================================
 * Section F — the service endpoint setting
 *
 * Pure functions over an injected storage area: no closure state, no
 * listener, nothing at import. The value is not a secret, but a value that was
 * *refused* may be anything a developer pasted — a URL carrying a credential,
 * for instance — so no message, hint, `details` field or log line built here
 * contains it. Refusals carry the rule that was broken and nothing else.
 * ===========================================================================
 */

/**
 * The `chrome.storage.local` key the configured service address is kept
 * under: its canonical origin (`http://127.0.0.1:<port>`), and only when it
 * differs from `DEFAULT_SERVICE_BASE_URL` — an absent key means "the default".
 *
 * `chrome.storage.local`, beside the credential, because the address belongs
 * to the same pairing and must survive a browser restart; the pairing dialog
 * writes it and the worker reads it and follows its changes.
 */
export const SERVICE_ENDPOINT_STORAGE_KEY = 'debuggen.serviceEndpoint';

/**
 * The hosts a configured service address may name: `127.0.0.1` and
 * `localhost`.
 *
 * The protocol's policy accepts every loopback host, but the worker can reach
 * only the origins its manifest grants: `host_permissions` holds
 * `http://127.0.0.1/*` and `http://localhost/*` — match patterns without a
 * port, which match **every** port, and which is what lets a service on any
 * port the developer chose answer the worker. Another loopback spelling
 * (`127.0.0.2`, `[::1]`) or `https:` is outside those grants, and is refused
 * here with a rule rather than left to fail at the first request.
 */
export const SERVICE_ENDPOINT_HOSTNAMES: readonly string[] = Object.freeze([
  '127.0.0.1',
  'localhost',
]);

/**
 * How the developer corrects a refused address. Constant, and names only the
 * accepted shapes and the default — never the value that was refused.
 */
const SERVICE_ENDPOINT_HINT = `Enter the address the local service listens on as http://127.0.0.1:<port> or http://localhost:<port>, the only hosts this extension may reach (the default is ${DEFAULT_SERVICE_BASE_URL}); leave it blank to use the default.`;

/** The code every refused service address is reported with. */
const SERVICE_ENDPOINT_REFUSED_CODE = 'CONFIG_INVALID' satisfies DebuggenErrorCode;

/** Fields attached to every log record about the setting: the key's name, never its value. */
const ENDPOINT_KEY_FIELDS = Object.freeze({ key: SERVICE_ENDPOINT_STORAGE_KEY });

/**
 * One refusal of {@link parseServiceEndpoint}: `CONFIG_INVALID`, a constant
 * message, {@link SERVICE_ENDPOINT_HINT}, and the broken rule as the only
 * detail — the shape the protocol's own `parseServiceOrigin` refusals have.
 */
function serviceEndpointError(rule: string, message: string): DebuggenError {
  return workerError(SERVICE_ENDPOINT_REFUSED_CODE, message, {
    hint: SERVICE_ENDPOINT_HINT,
    details: { rule },
  });
}

/**
 * Validate a service address as the extension can use it.
 *
 * 1. It must be text; surrounding whitespace is ignored.
 * 2. It must satisfy the protocol's `parseServiceOrigin` — an absolute
 *    loopback origin with no user information, path, query or fragment. That
 *    refusal is returned as the protocol built it (`CONFIG_INVALID`, a
 *    constant message and hint, `details: { rule }`).
 * 3. It must be `http:` on one of {@link SERVICE_ENDPOINT_HOSTNAMES}, the
 *    origins the manifest grants (`details.rule` `'scheme'` or
 *    `'host-permission'`).
 *
 * Total: returns for every input and never throws.
 *
 * @example
 * ```ts
 * parseServiceEndpoint(' http://localhost:20150 '); // ok('http://localhost:20150')
 * parseServiceEndpoint('https://127.0.0.1:20150');   // err: rule 'scheme'
 * parseServiceEndpoint('http://[::1]:20150');        // err: rule 'host-permission'
 * ```
 *
 * @param raw The value as entered or as read back from storage.
 * @returns The canonical origin (`http://<host>:<port>`, the port omitted only
 * when it is 80), or the refusal. The refusal never contains the value.
 */
export function parseServiceEndpoint(raw: unknown): Result<string, DebuggenError> {
  if (typeof raw !== 'string') {
    return err(serviceEndpointError('unparseable', 'The service address is not text.'));
  }
  const origin = parseServiceOrigin(raw);
  if (isErr(origin)) {
    return origin;
  }
  const parsed = tryCatch(() => new URL(origin.value), SERVICE_ENDPOINT_REFUSED_CODE);
  if (isErr(parsed)) {
    return err(serviceEndpointError('unparseable', 'The service address is not a URL.'));
  }
  if (parsed.value.protocol !== 'http:') {
    return err(
      serviceEndpointError(
        'scheme',
        'The service address must use http: the local service listens over plain HTTP.',
      ),
    );
  }
  if (!SERVICE_ENDPOINT_HOSTNAMES.includes(parsed.value.hostname)) {
    return err(
      serviceEndpointError(
        'host-permission',
        'The service address must name 127.0.0.1 or localhost, the hosts this extension may reach.',
      ),
    );
  }
  return ok(origin.value);
}

/**
 * Read the configured service address.
 *
 * @param storage The area it is kept in — `chrome.storage.local`.
 * @param logger Where a failure is noted (the key's name and the error code,
 * never the value); defaults to no logging.
 * @returns `ok(undefined)` when none is configured (use the default),
 * `ok(origin)` for a valid stored value, or an `Err` — `STORE_ERROR` when
 * storage could not be read, the {@link parseServiceEndpoint} refusal when the
 * stored value is not one the extension can use. A stored value is never
 * silently replaced by the default: the caller shows the refusal.
 */
export async function readServiceEndpoint(
  storage: Pick<CredentialStorageArea, 'get'>,
  logger: Logger = noopLogger,
): Promise<Result<string | undefined, DebuggenError>> {
  const read = await fromPromise(
    Promise.resolve().then(() => storage.get(SERVICE_ENDPOINT_STORAGE_KEY)),
    'STORE_ERROR',
  );
  if (isErr(read)) {
    logger.warn('The service address could not be read from extension storage.', {
      ...ENDPOINT_KEY_FIELDS,
      errorCode: read.error.code,
    });
    return err(
      workerError('STORE_ERROR', 'The service address could not be read from extension storage.', {
        cause: read.error,
      }),
    );
  }
  const stored: unknown = isPlainRecord(read.value)
    ? read.value[SERVICE_ENDPOINT_STORAGE_KEY]
    : undefined;
  if (stored === undefined) {
    return ok(undefined);
  }
  const endpoint = parseServiceEndpoint(stored);
  if (isErr(endpoint)) {
    logger.warn('The stored service address is not one this extension can use.', {
      ...ENDPOINT_KEY_FIELDS,
      errorCode: endpoint.error.code,
    });
  }
  return endpoint;
}

/**
 * Validate and save the service address the developer entered.
 *
 * A blank value, or one whose canonical form is `DEFAULT_SERVICE_BASE_URL`,
 * removes the key — "use the default" is stored as absence, so a later build
 * with another default is followed. An invalid value is refused **without
 * writing**, so a typo never replaces an address that works.
 *
 * @param storage The area it is kept in — `chrome.storage.local`.
 * @param raw The value as entered.
 * @returns `ok(origin)` when a non-default address was saved, `ok(undefined)`
 * when the default now applies, or an `Err`: the {@link parseServiceEndpoint}
 * refusal, or `STORE_ERROR` when storage refused the write.
 */
export async function writeServiceEndpoint(
  storage: Pick<CredentialStorageArea, 'set' | 'remove'>,
  raw: unknown,
): Promise<Result<string | undefined, DebuggenError>> {
  const blank = typeof raw === 'string' && raw.trim().length === 0;
  const endpoint: Result<string | undefined, DebuggenError> = blank
    ? ok(undefined)
    : parseServiceEndpoint(raw);
  if (isErr(endpoint)) {
    return endpoint;
  }
  const defaultEndpoint = parseServiceEndpoint(DEFAULT_SERVICE_BASE_URL);
  const value =
    endpoint.value === undefined ||
    (!isErr(defaultEndpoint) && endpoint.value === defaultEndpoint.value)
      ? undefined
      : endpoint.value;
  const written = await fromPromise(
    Promise.resolve().then(() =>
      value === undefined
        ? storage.remove(SERVICE_ENDPOINT_STORAGE_KEY)
        : storage.set({ [SERVICE_ENDPOINT_STORAGE_KEY]: value }),
    ),
    'STORE_ERROR',
  );
  if (isErr(written)) {
    return err(
      workerError('STORE_ERROR', 'The service address could not be saved in extension storage.', {
        hint: 'Try again; if it keeps failing, reload the extension from chrome://extensions.',
        cause: written.error,
      }),
    );
  }
  return ok(value);
}

/**
 * The service-address setting as the pairing dialog uses it: read the current
 * value, and validate-and-save a new one. The dialog renders its field only
 * when it has one of these, which keeps it free of any `chrome.*` reference.
 */
export interface ServiceEndpointAccessor {
  /** {@link readServiceEndpoint} over the accessor's storage. */
  readonly read: () => Promise<Result<string | undefined, DebuggenError>>;
  /** {@link writeServiceEndpoint} over the accessor's storage. */
  readonly write: (raw: string) => Promise<Result<string | undefined, DebuggenError>>;
}

/**
 * Bind {@link readServiceEndpoint} and {@link writeServiceEndpoint} to one
 * storage area. Pure construction: nothing is read until a member is called.
 *
 * @param storage `chrome.storage.local`, or a test's in-memory fake.
 */
export function createServiceEndpointAccessor(
  storage: Pick<CredentialStorageArea, 'get' | 'set' | 'remove'>,
): ServiceEndpointAccessor {
  return Object.freeze({
    read: () => readServiceEndpoint(storage),
    write: (raw: string) => writeServiceEndpoint(storage, raw),
  });
}

/*
 * ===========================================================================
 * Section G — compile-time contract proofs
 *
 * Type-level only: they emit nothing, and are exported solely so
 * `noUnusedLocals` accepts them — the convention `./messages` and
 * `@debuggen/protocol` follow. Each fails `tsc -b` (TS2344) at this line if
 * the contract it names drifts, rather than at the wiring in
 * `service-worker.ts` or `ws-bridge.ts`.
 * ===========================================================================
 */

/** Fails to compile unless its argument is exactly `true`. */
type AssertTrue<Assertion extends true> = Assertion;

/** `chrome.storage.local` can be passed as {@link DevtoolsCredentialStoreDeps.storage}. */
export type ChromeLocalStorageSatisfiesCredentialStorageArea = AssertTrue<
  typeof chrome.storage.local extends CredentialStorageArea ? true : false
>;

/** `chrome.storage.local.onChanged` can be passed as {@link DevtoolsCredentialStoreDeps.changes}. */
export type ChromeLocalOnChangedSatisfiesCredentialStorageChangeEvent = AssertTrue<
  typeof chrome.storage.local.onChanged extends CredentialStorageChangeEvent ? true : false
>;

/** `store.getToken` is a `TokenProvider` both protocol clients accept. */
export type StoreGetTokenIsTokenProvider = AssertTrue<
  DevtoolsCredentialStore['getToken'] extends TokenProvider ? true : false
>;

/** `store.handleUnauthorized` can be the socket client's `onUnauthorized` hook. */
export type StoreHandleUnauthorizedAcceptsSocketDetail = AssertTrue<
  DevtoolsCredentialStore['handleUnauthorized'] extends (detail: WsUnauthorizedDetail) => unknown
    ? true
    : false
>;

/** The panel's connection vocabulary still contains the "Not paired" status. */
export type PairingStateCoversNotPaired = AssertTrue<
  [NotPairedStatus] extends [never] ? false : true
>;
