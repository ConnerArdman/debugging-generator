/**
 * The process entry point and composition root of `@debuggen/local-service`.
 *
 * ## The artefact contract this file satisfies
 *
 * `tsup.config.ts` declares exactly one entry, `main: 'src/main.ts'`, so this
 * module is the whole program: everything the service runs is reached through
 * the static imports below and collapses into a single `dist/main.js`. Four
 * paths depend on that, and each of them is written down somewhere else:
 *
 * - `package.json` names `dist/main.js` as `main`, as the `import`/`default`
 *   conditions of its only `exports` entry and as the target of
 *   `"start": "node dist/main.js"`, and `dist/main.d.ts` as `types`.
 * - the root `playwright.config.ts` `webServer` entry runs
 *   `node apps/local-service/dist/main.js` from the repository root, polls
 *   `GET ${serviceUrl}/health` until it answers, and shuts the process down
 *   with **SIGTERM** and a 10 s grace period — so the health route and the
 *   signal handling below are both load-bearing for every browser and
 *   end-to-end suite (AAP 0.8.3).
 * - `apps/vscode-extension/esbuild.mjs` bundles these same sources into the
 *   VSIX, which is why every import here is static and top-level: a computed
 *   `import()` of a local module would not survive that second bundle.
 * - `src/store/schema.sql` is loaded through `new URL('./store/schema.sql',
 *   import.meta.url)`. That one relative URL is correct in both layouts —
 *   under `tsx watch src/main.ts` this module is `src/main.ts` and the DDL sits
 *   at `src/store/schema.sql`, and in the bundle it is `dist/main.js` beside the
 *   `dist/store/schema.sql` that the tsup `onSuccess` hook copies.
 *
 * ## Start-up order, and why it is this order
 *
 * {@link startService} performs five steps and reports each failure as a typed
 * `Err` rather than a throw, because the caller — {@link main}, or an
 * integration suite — is the only place that knows whether a failure should
 * print and exit or fail an assertion:
 *
 * 1. **Configuration.** `loadServiceConfig` from `./config.js`, over an
 *    **injected** environment. Nothing in {@link startService} reads
 *    `process.env`; {@link main} passes it in after `dotenv`, so a suite's
 *    injected environment is authoritative and two starts in one process cannot
 *    disagree.
 * 2. **Logging.** One root logger from `createServiceLogger`, with a child per
 *    area from `subsystemLogger`. The resolved configuration is logged once,
 *    through `describeServiceConfig`, which is the credential-free view of it —
 *    no other line in this file logs configuration.
 * 3. **The state tree.** `$DEBUGGEN_HOME` and its two subdirectories, created
 *    and verified `0700` and symlink-free by `ensureSecureDir`. The state root
 *    is created first and then declared as the boundary (`upTo`) of the two
 *    below it, which is what makes the whole chain verified rather than just its
 *    tail (AAP 0.5.6).
 * 4. **The session store.** `node:sqlite` opened at `config.databasePath`, its
 *    per-connection pragmas set here (the DDL's header and `./store/migrations.js`
 *    both state that the caller owns them), and the schema ladder applied by
 *    `applyMigrations`. The database and its write-ahead-log sidecars are then
 *    restricted to `0600`, because `DatabaseSync` creates them under the process
 *    umask and AAP 0.4.2 requires every file in the state tree to be
 *    owner-only. A failure after this point closes the handle again, so a
 *    refused start leaves no open database behind.
 * 5. **The HTTP surface.** One `Hono` app served by `@hono/node-server`'s
 *    `serve` on `config.host`/`config.port`. The returned promise settles only
 *    once the socket is listening — or once binding has failed — and the bound
 *    port is read back from the listener's `AddressInfo`, so a configured port of
 *    `0` (how a suite avoids colliding with another process) still yields a
 *    usable {@link ServiceHandle.url}.
 *
 * ## What the HTTP surface carries
 *
 * Three things, and deliberately nothing else:
 *
 * - an **origin guard** on every route (AAP 0.5.6): a request whose `Origin`
 *   header is not one of the accepted non-web origins is answered `403` with
 *   `{ code: 'FORBIDDEN_ORIGIN', message }`. No `Access-Control-Allow-Origin`
 *   header is ever set, so a web page cannot read a response even if one were
 *   answered.
 * - **`GET /health`**, unauthenticated — one of the two auth-exempt operations
 *   of AAP 0.5.6 — answering `{ status, protocolVersion }` from the moment the
 *   server listens, because that is what the Playwright `webServer` block polls.
 * - **`app.onError`**, which logs the failure and answers `500` with
 *   `{ code: 'INTERNAL', message }`. A caught value never reaches a response
 *   body.
 *
 * ## A composition root composes; it does not implement a subsystem
 *
 * This module's own code is the five steps above plus process lifecycle. Every
 * other capability of the coordination service is a module of its own in AAP
 * 0.7.1 Group 2, reached from here by calling it — and each of the four below is
 * a policy the AAP places in exactly one file, which is precisely why this file
 * does not carry a copy of it:
 *
 * - **The access boundary** — role-bound credentials, the `auth.json` editor
 *   credential, the SHA-256 hashes in the `credentials` table, pairing and
 *   rotation — is `./server/auth.js` (AAP 0.5.6). A second writer of
 *   `$DEBUGGEN_HOME/auth.json` would be a second policy, and the rotation
 *   guarantee that section states (every credential and every socket
 *   invalidated at once) holds only while there is one owner. Minting a
 *   credential from here would also put a secret on disk that no route in this
 *   file authenticates against.
 * - **The WebSocket surface** is `./server/ws.js` with `./server/clients.js`,
 *   attached to the same `node:http` server this file creates (AAP 0.4.2).
 *   Its handshake is a protocol contract, not local code: the first frame is
 *   `client.hello` and a connection that does not present a valid token inside
 *   three seconds is closed with code 4401, both defined once in
 *   `@debuggen/protocol` (`messages/agent.ts`, and the envelope that validates
 *   every frame). Accepting a socket here without those definitions would mean
 *   restating a cross-process shape in an app, which AAP 0.4.2 names a defect,
 *   and accepting one without the handshake would be a hole in the boundary
 *   above. `ws` is therefore not imported by this file at all.
 * - **Start-up modification reconciliation** is `./cleanup/cleanup.js` over the
 *   journal repository, driven by `@debuggen/instrumentation` (AAP 0.5.1). It
 *   is the one code path that writes into a developer's working tree, it is
 *   governed by the hash ladder of that section, and its correctness is
 *   established by that package's own suite — not by a copy inlined into a
 *   process entry point.
 * - **The retention purge** is `./store/retention.js` over the same
 *   repositories (AAP 0.4.2): sessions, telemetry, panels and analyses past
 *   `DEBUGGEN_RETENTION_DAYS`, stale index caches, orphan backups, with
 *   conflict backups exempt.
 *
 * The model provider and the prompt loader are likewise constructed for the
 * pipeline that consumes them; this file performs no model interaction, and
 * validating a prompt manifest while binding a socket would make the
 * availability of the unauthenticated health route depend on an artefact that
 * route does not serve.
 *
 * What this file guarantees instead is that composition itself is sound: each
 * step reports a typed failure rather than throwing, a failure after a resource
 * has been acquired closes that resource before returning, and
 * {@link ServiceHandle.close} releases the HTTP server and the store exactly
 * once however often it is called.
 */

import { serve, type ServerType } from '@hono/node-server';
import { config as loadDotenvFile } from 'dotenv';
import { Hono } from 'hono';

import { PROTOCOL_VERSION } from '@debuggen/protocol';
import {
  DebuggenError,
  err,
  isErr,
  ok,
  type LogFields,
  type Logger,
  type Result,
} from '@debuggen/shared';
import {
  SECURE_FILE_MODE,
  createFileExclusive,
  ensureSecureDir,
  readFileNoFollow,
} from '@debuggen/shared/node';

import type { EventEmitter } from 'node:events';
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  describeServiceConfig,
  loadServiceConfig,
  type ServiceConfig,
  type ServiceConfigOverrides,
} from './config.js';
import { createServiceLogger, subsystemLogger, type ServiceLoggerOptions } from './logging.js';
import { applyMigrations } from './store/migrations.js';

/* -------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * The `subsystem` bindings this file's loggers carry, one per area it composes.
 *
 * They follow the convention `./logging.js` documents for
 * `LOG_BINDING_KEYS.subsystem` — the module's source folder name — so a record
 * from the store, from the HTTP surface and from the lifecycle itself are
 * separable with one filter rather than by matching message text.
 */
const SUBSYSTEM_SERVICE = 'service';

/** The `subsystem` binding of every record about the session store. */
const SUBSYSTEM_STORE = 'store';

/** The `subsystem` binding of every record about the HTTP surface. */
const SUBSYSTEM_SERVER = 'server';

/**
 * The path of the unauthenticated health route.
 *
 * Stated as a constant because it is a contract with two readers outside this
 * repository's source: the `webServer.url` of the root `playwright.config.ts`
 * and the service-discovery probe of the VS Code extension.
 */
const HEALTH_ROUTE = '/health';

/**
 * How long a statement waits for the write lock before SQLite gives up, in
 * milliseconds.
 *
 * The store is opened in WAL mode, where a reader never blocks a writer, so the
 * only contention left is writer-versus-writer: this process against a second
 * service instance a developer started by accident, or against a `sqlite3`
 * session they left open. Five seconds is long enough that such an overlap
 * resolves itself instead of failing a request, and short enough that a
 * genuinely stuck lock surfaces as an error rather than as a hung start-up.
 */
const STORE_BUSY_TIMEOUT_MS = 5_000;

/**
 * The permission bits of a `stat` mode, masked out of the file-type bits.
 *
 * `mode` carries both, so a comparison against a permission constant has to
 * mask first; `0o777` is the mask rather than `0o7777` deliberately — the
 * set-user-id, set-group-id and sticky bits are not what this file asserts, and
 * masking them in would make an unrelated bit fail an owner-only check.
 */
const PERMISSION_BITS = 0o777;

/**
 * How long {@link ServiceHandle.close} waits for open connections to drain
 * before closing them itself, in milliseconds.
 *
 * `close()` must be bounded: Playwright sends SIGTERM and waits 10 s before
 * escalating, and `server.close()` on its own resolves only once the last
 * keep-alive connection has gone away — which a client holding an idle socket
 * can postpone indefinitely. Idle sockets are released immediately and anything
 * still open after this grace period is closed outright, so the process always
 * reaches the store checkpoint below well inside Playwright's window.
 */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * The URL schemes an `Origin` header may carry.
 *
 * AAP 0.5.6 states the accepted set positively — "accepted origins are absent
 * (Node clients), `chrome-extension://<id>` and `vscode-webview://*`" — and this
 * guard is written that way round on purpose. Refusing everything that is not on
 * this list also refuses the cases an `http:`/`https:` deny-list would let
 * through while still being a browser: the literal `Origin: null` a sandboxed
 * iframe or a `data:`/`file:` document sends, an `Origin` from another browser's
 * extension scheme, and a malformed header value. None of those is a client this
 * service has, so none of them has a reason to be accepted.
 *
 * Typed `readonly string[]` rather than as a literal tuple so a parsed
 * `URL.protocol` — a plain `string` — can be tested against it without a cast.
 */
const ACCEPTED_ORIGIN_PROTOCOLS: readonly string[] = Object.freeze([
  'chrome-extension:',
  'vscode-webview:',
]);

/**
 * The body message of a refused cross-origin request.
 *
 * It names the policy and not the request: the value that was refused is
 * already in the caller's own console, and repeating it in the response body
 * would reflect an attacker-chosen string back to them.
 */
const FORBIDDEN_ORIGIN_MESSAGE =
  'Debug Generator refuses requests from web origins. Only the Debug Generator DevTools extension, the VS Code webview and local Node clients may call this service.';

/**
 * The body message of an unhandled server-side failure.
 *
 * Fixed text, because the response must carry nothing derived from the caught
 * value: the reason is logged with the request's method and path, which is where
 * a developer looks for it.
 */
const INTERNAL_ERROR_MESSAGE =
  'The Debug Generator local service failed to handle this request. Its log holds the reason.';

/** The signals that mean "stop": the two a developer and a test runner send. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/* -------------------------------------------------------------------------------------------------
 * Public surface
 * ---------------------------------------------------------------------------------------------- */

/**
 * How a host steers {@link startService}.
 *
 * Every member is optional and accepts an explicit `undefined`, so a caller may
 * spread a partially filled record without stripping its empty members first —
 * the repository compiles with `exactOptionalPropertyTypes`.
 */
export interface StartServiceOptions {
  /**
   * The environment to resolve configuration from. Defaults to an **empty
   * object**, not to `process.env`.
   *
   * That default is the whole point of the parameter: `startService` is pure
   * with respect to the process it runs in, so an integration suite gets exactly
   * the settings it passed and cannot be perturbed by the developer's shell.
   * {@link main} passes `process.env` after `dotenv` has populated it.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;

  /**
   * Settings the host has already decided, which win over the environment per
   * setting. This is how a suite pins a temporary `$DEBUGGEN_HOME` and an
   * ephemeral port (`port: 0`) without touching the process environment.
   */
  readonly overrides?: ServiceConfigOverrides | undefined;

  /**
   * Seams for the logger `createServiceLogger` builds — a capturing
   * `destination`, a pre-built pino instance, a level override. Left absent, the
   * service logs structured JSON to stdout at the configured level.
   */
  readonly loggerOptions?: ServiceLoggerOptions | undefined;
}

/**
 * A started service: where it is listening, and how to stop it.
 *
 * Returned inside an `Ok` by {@link startService} once the socket is listening
 * and the store is migrated, so holding one of these is a statement that the
 * service is serving rather than that it was asked to.
 */
export interface ServiceHandle {
  /**
   * The base URL clients use, built from the configured host and the **bound**
   * port. With `port: 0` that is the port the operating system chose, which is
   * the only way a caller can learn it.
   */
  readonly url: string;

  /** The interface the server is bound to, as configured. */
  readonly host: string;

  /** The port the server is actually bound to; never `0`. */
  readonly port: number;

  /**
   * The service's root logger.
   *
   * Exposed because the process-level concerns {@link main} owns — the single
   * "listening" line, the shutdown record, an uncaught exception — must be
   * reported through the *same* logger the service uses, with its level,
   * bindings and redaction policy, rather than through a second one built from
   * the same configuration.
   */
  readonly logger: Logger;

  /**
   * Stops accepting connections, closes the open ones, checkpoints the
   * write-ahead log and closes the database.
   *
   * Idempotent and bounded: the first call performs the sequence and every
   * later or concurrent call awaits that same promise, which is what makes it
   * safe to wire to both SIGINT and SIGTERM and to call again from a crash
   * handler. It never rejects — a failure inside the sequence is logged, because
   * a caller cannot act on it and must still be allowed to exit.
   */
  close(): Promise<void>;
}

/**
 * The root logger and the per-area children derived from it, passed together.
 *
 * Internal, because it is a parameter shape rather than part of the contract a
 * caller holds: {@link ServiceHandle} exposes the root alone. The root is
 * carried alongside the children because two of this workspace's modules —
 * `./config.js`'s `describeServiceConfig` and `./store/migrations.js` — put
 * their own `subsystem` field on the records they produce, and handing those a
 * logger already bound to the same key would emit it twice in one JSON record.
 */
interface ServiceLoggers {
  /** The root, which carries no `subsystem` binding. */
  readonly root: Logger;

  /** Lifecycle records: start-up, shutdown, the state tree. */
  readonly service: Logger;

  /** Session-store records this file emits itself. */
  readonly store: Logger;

  /** HTTP-surface records: binding, refusals, unhandled request failures. */
  readonly server: Logger;
}

/* -------------------------------------------------------------------------------------------------
 * Failure reporting
 * ---------------------------------------------------------------------------------------------- */

/**
 * Wraps a caught value as the typed error a caller reports, keeping the
 * original reachable as `cause`.
 *
 * The same shape `./store/migrations.js` uses, for the same reasons: `catch`
 * binds `unknown`, `DebuggenError.from` normalises it, and a specific code
 * raised deeper survives while anything else takes `fallbackCode`. The
 * underlying message goes into `details.reason` rather than into the message
 * line, so what a user interface renders stays short and stable.
 *
 * @param cause The caught value.
 * @param fallbackCode The code to apply when `cause` carries none.
 * @param message A complete sentence naming what failed.
 * @param hint The developer's next step.
 * @param details Diagnostic context: paths, ports and reasons only. This object
 * is logged, so nothing secret belongs in it.
 * @returns The error to return inside an `Err`.
 */
function wrapStartupFailure(
  cause: unknown,
  fallbackCode: 'FS_UNSAFE_PATH' | 'INTERNAL' | 'STORE_ERROR',
  message: string,
  hint: string,
  details: LogFields,
): DebuggenError {
  const normalized = DebuggenError.from(cause, fallbackCode);
  return new DebuggenError(normalized.code, message, {
    hint,
    details: { ...details, reason: normalized.message },
    cause,
  });
}

/**
 * The loggable view of a failure: its code and hint beside the message, never
 * the message twice.
 *
 * Used for every `Err` this file logs, so a failed start reads the same however
 * deep it came from. `details` is forwarded as a nested object because the
 * scrubbing pass in `./logging.js` walks nested values.
 */
/**
 * The platform's `errno` string for a caught filesystem failure, when it has
 * one.
 *
 * The distinctions this file makes between failures are the errno's, not the
 * message's: `EEXIST` means the store file was already there, `ELOOP` means a
 * symbolic link was refused at a final component, `ENOENT` means a write-ahead
 * sidecar has not been created. Reading the code off the caught value keeps
 * those branches independent of wording, in this or any Node version.
 *
 * @param cause Anything caught from a filesystem call.
 * @returns The `code` property when the value carries a string one, otherwise
 * `undefined` — which is the answer for a `DebuggenError` and for a thrown
 * non-error alike.
 */
function errnoCodeOf(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null) {
    return undefined;
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorFields(error: DebuggenError): LogFields {
  return {
    code: error.code,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

/* -------------------------------------------------------------------------------------------------
 * Step 3 — the state tree
 * ---------------------------------------------------------------------------------------------- */

/**
 * Creates `$DEBUGGEN_HOME`, the backup root and the index cache, and verifies
 * that every one of them is a private (`0700`) directory this account owns.
 *
 * The order is what makes the guarantee whole. `ensureSecureDir` without a
 * boundary vouches only for the components it created, so the state root is
 * established first; the two subdirectories then pass `upTo:
 * config.debuggenHome`, which is the declaration that turns the check from "the
 * tail this call created is private" into "every directory from the state root
 * down is private, and none of them is a symbolic link" (see that function's
 * own documentation, and AAP 0.5.6 for why it matters: this tree holds the
 * session database, the editor credential and the backups of a developer's
 * patched files).
 *
 * `config.authFilePath` and `config.databasePath` are files rather than
 * directories and are not created here: the store opens its own file in step 4,
 * and the credential is written by the module that owns credential policy.
 *
 * @param config The resolved configuration, whose paths are already absolute.
 * @returns `Ok` when the tree is present and private, `Err` naming the path
 * that could not be established.
 */
function prepareStateTree(config: ServiceConfig): Result<void, DebuggenError> {
  try {
    ensureSecureDir(config.debuggenHome);
    ensureSecureDir(config.backupsDir, { upTo: config.debuggenHome });
    ensureSecureDir(config.indexCacheDir, { upTo: config.debuggenHome });
    return ok(undefined);
  } catch (cause) {
    return err(
      wrapStartupFailure(
        cause,
        'FS_UNSAFE_PATH',
        'Could not prepare the Debug Generator state directory.',
        `Check that ${config.debuggenHome} is a directory you own, that no component of the path is a symbolic link, and that its permissions allow this account to write it; or set DEBUGGEN_HOME to another location and start again.`,
        {
          subsystem: SUBSYSTEM_SERVICE,
          debuggenHome: config.debuggenHome,
          backupsDir: config.backupsDir,
          indexCacheDir: config.indexCacheDir,
        },
      ),
    );
  }
}

/* -------------------------------------------------------------------------------------------------
 * Step 4 — the session store
 * ---------------------------------------------------------------------------------------------- */

/**
 * Reads the store's data definition from beside this module.
 *
 * One candidate, `new URL('./store/schema.sql', import.meta.url)`, because that
 * single relative URL is correct in both layouts this program runs in — see this
 * file's header for the two of them. `readFileNoFollow` rather than a plain read
 * so a symbolic link planted at the final component is refused (`ELOOP`) instead
 * of followed: the DDL is executed verbatim by SQLite, which makes it code as
 * much as data.
 *
 * @returns `Ok` with the DDL text, or `Err` with a packaging-level `STORE_ERROR`.
 */
function loadStoreDdl(): Result<string, DebuggenError> {
  const schemaUrl = new URL('./store/schema.sql', import.meta.url);
  try {
    return ok(readFileNoFollow(fileURLToPath(schemaUrl)).toString('utf8'));
  } catch (cause) {
    return err(
      wrapStartupFailure(
        cause,
        'STORE_ERROR',
        'Could not read the session store schema that ships beside the service entry point.',
        'This is a packaging fault rather than a setting: rebuild the service with `pnpm --filter @debuggen/local-service build`, which copies src/store/schema.sql to dist/store/schema.sql, or reinstall Debug Generator.',
        { subsystem: SUBSYSTEM_STORE, schemaUrl: schemaUrl.href },
      ),
    );
  }
}

/**
 * Restricts the session store's files to {@link SECURE_FILE_MODE}, and proves it.
 *
 * AAP 0.4.2 states the rule this function exists for: the `$DEBUGGEN_HOME` tree
 * is created `0700` and **every file in it is `0600`**. `ensureSecureDir`
 * discharges the directory half, but the database is not created by this
 * product's own file writers — `node:sqlite`'s `DatabaseSync` opens the path
 * itself and accepts no mode argument, so the file, and the `-wal`/`-shm`
 * sidecars WAL mode creates beside it, land with whatever the process umask
 * allows (`0644` under the common `022`). A private directory hides them from a
 * *listing*, but the modes are what decide who may read a session's captured
 * telemetry, questions and file paths if the tree is ever copied, archived, or
 * reached through a path another account may traverse.
 *
 * The sidecars are tightened opportunistically rather than required: they exist
 * only once the database has been written, and a missing one is the normal state
 * of a database that has just been opened read-only, so `ENOENT` is skipped
 * while every other failure is reported.
 *
 * A failure to establish the mode fails the start-up rather than degrading it,
 * which is the same choice `@debuggen/shared/node` makes for the directories and
 * for every file it creates: a state root whose privacy could not be established
 * is not a state root this service is willing to write a session into. The mode
 * is re-read after the change, so a successful return is a statement about the
 * filesystem rather than about the call that was attempted.
 *
 * @param config The validated configuration, for `databasePath`.
 * @returns `ok(undefined)` once the database and every present sidecar are
 * `0600`, or one `STORE_ERROR` naming the path that could not be restricted.
 */
function tightenStoreFiles(config: ServiceConfig): Result<void, DebuggenError> {
  const paths = [
    config.databasePath,
    `${config.databasePath}-wal`,
    `${config.databasePath}-shm`,
  ] as const;

  for (const [index, path] of paths.entries()) {
    const required = index === 0;
    try {
      tightenFileNoFollow(path);
    } catch (cause) {
      // A sidecar that does not exist is not a failure: WAL mode creates the two
      // of them on the first write and a truncating checkpoint removes them
      // again, so the set present at any moment is a property of the store's
      // history rather than of its correctness.
      if (!required && errnoCodeOf(cause) === 'ENOENT') {
        continue;
      }
      const unsafe = errnoCodeOf(cause) === 'ELOOP';
      return err(
        wrapStartupFailure(
          cause,
          unsafe ? 'FS_UNSAFE_PATH' : 'STORE_ERROR',
          unsafe
            ? 'The session store path is a symbolic link, which Debug Generator will not write through.'
            : 'Could not restrict the session store to owner-only access.',
          unsafe
            ? `Remove or replace ${path}: the session store must be a regular file inside the state directory, and following a link there would write a session's captured telemetry somewhere this service did not choose.`
            : `Check that ${path} is owned by this account and that its filesystem records POSIX permissions; the session store holds captured telemetry and must not be readable by other accounts.`,
          { subsystem: SUBSYSTEM_STORE, path, mode: SECURE_FILE_MODE.toString(8) },
        ),
      );
    }
  }

  return ok(undefined);
}

/**
 * Restricts one file to {@link SECURE_FILE_MODE} through a descriptor that
 * refuses to follow a symbolic link, and proves the result on that same
 * descriptor.
 *
 * Every step is deliberate, and the reason is the same one that makes
 * `@debuggen/shared/node` open its state files with `O_NOFOLLOW` and `fchmod`
 * them on the descriptor rather than `chmod` them by path:
 *
 * - `O_NOFOLLOW` makes a symbolic link at the final component fail with
 *   `ELOOP`, so a link planted at the database path is refused instead of
 *   having another file's permissions rewritten through it.
 * - `fstat` on the open descriptor establishes that the thing being restricted
 *   is a regular file — a directory or a device at that path is a broken state
 *   tree, not something to chmod.
 * - `fchmod` and the confirming `fstat` both act on the descriptor already
 *   held, so there is no second path lookup that a concurrent rename could
 *   redirect, and a successful return is a statement about the file itself.
 *
 * The descriptor is opened read-only: changing a mode requires ownership of the
 * file, never write access to its contents, and read-only is the least the call
 * needs. It is closed in a `finally`, so a failure leaks no descriptor.
 *
 * @param path The file to restrict.
 * @throws The platform's own filesystem error with its `code` intact — `ELOOP`
 * for a planted link, `ENOENT` when nothing is there, `EACCES`, `EPERM` — or a
 * `DebuggenError` with code `STORE_ERROR` when the entry is not a regular file
 * or the mode did not take. Callers map these onto their own reporting.
 */
function tightenFileNoFollow(path: string): void {
  // `O_NOFOLLOW` is POSIX and present on Linux and macOS, the two platforms this
  // product supports. The fallback keeps the flag arithmetic valid rather than
  // silently producing `NaN` where a platform omits the constant; the no-follow
  // guarantee is inherently the platform's to provide.
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);

  try {
    if (!fstatSync(fd).isFile()) {
      throw new DebuggenError(
        'STORE_ERROR',
        'expected a regular file at the session store path, found another kind of entry',
      );
    }

    fchmodSync(fd, SECURE_FILE_MODE);

    const mode = fstatSync(fd).mode & PERMISSION_BITS;
    if (mode !== SECURE_FILE_MODE) {
      throw new DebuggenError(
        'STORE_ERROR',
        `expected mode ${SECURE_FILE_MODE.toString(8)} after restricting it, found ${mode.toString(8)}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates the session store's file — or adopts the one already there — as a
 * regular, owner-only file, **before** SQLite is allowed to open the path.
 *
 * `node:sqlite`'s `DatabaseSync` takes a path and no mode, and it opens that
 * path the ordinary way: a missing database is created under the process umask
 * (`0644` under the common `022`, which AAP 0.4.2 forbids for anything in the
 * state tree) and a symbolic link at the path is followed, so a link planted
 * there would have a session's captured telemetry written through it. Neither
 * property can be fixed after the fact — by the time the handle exists the file
 * has been created and written to — so the file is established first:
 *
 * - `createFileExclusive` from `@debuggen/shared/node` creates it with
 *   `O_CREAT | O_EXCL | O_NOFOLLOW` at {@link SECURE_FILE_MODE}, after
 *   verifying that every directory from the state root down is a real
 *   directory this account owns at `0700`. A zero-byte file is a valid empty
 *   SQLite database, so the schema ladder then populates it exactly as it would
 *   a file SQLite had created itself.
 * - An existing entry surfaces as `EEXIST` — `O_EXCL` takes precedence over
 *   `O_NOFOLLOW`, so a planted link reports `EEXIST` too — and is then put
 *   through {@link tightenFileNoFollow}, which refuses the link with `ELOOP`,
 *   refuses a non-regular entry, and restricts a genuine database that an
 *   earlier build (or a permissive umask) left readable.
 *
 * Establishing the mode here rather than only after the migration also closes a
 * failure path: a database created by this call is `0600` from the moment it
 * exists, so a migration that fails part-way leaves no permissive file behind.
 *
 * @param config The validated configuration, for `databasePath` and the state
 * root that bounds the parent verification.
 * @returns `ok(undefined)` when the path holds a regular, owner-only file, or
 * one typed failure — `FS_UNSAFE_PATH` for a link or a non-directory parent,
 * `STORE_ERROR` for anything else.
 */
function prepareDatabaseFile(config: ServiceConfig): Result<void, DebuggenError> {
  try {
    createFileExclusive(config.databasePath, '', { upTo: config.debuggenHome });
  } catch (cause) {
    if (errnoCodeOf(cause) !== 'EEXIST') {
      const unsafe =
        errnoCodeOf(cause) === 'ELOOP' || DebuggenError.from(cause).code === 'FS_UNSAFE_PATH';
      return err(
        wrapStartupFailure(
          cause,
          unsafe ? 'FS_UNSAFE_PATH' : 'STORE_ERROR',
          'Could not create the Debug Generator session store file.',
          `Check that ${config.debuggenHome} is a directory you own at mode 0700, that no component of it is a symbolic link, and that ${config.databasePath} can be created inside it; or set DEBUGGEN_HOME to another location.`,
          {
            subsystem: SUBSYSTEM_STORE,
            databasePath: config.databasePath,
            debuggenHome: config.debuggenHome,
          },
        ),
      );
    }
  }

  return tightenStoreFiles(config);
}

/**
 * Opens `$DEBUGGEN_HOME/sessions.sqlite`, sets its pragmas and migrates it.
 *
 * The three pragmas are per-connection settings the DDL's header and
 * `./store/migrations.js` both assign to the caller, and none of them is
 * optional here:
 *
 * - `journal_mode = WAL` is the mode AAP 0.4.2 specifies for this store; it is
 *   persistent in the file, is set on every open because a copied or restored
 *   file may not carry it, and cannot be set from inside a transaction — which
 *   is exactly why the migration ladder refuses to own it.
 * - `foreign_keys = ON` is off by default in SQLite and is per connection, so
 *   the cascade rules the schema declares hold only while this statement has
 *   run. Without it a deleted session would leave its telemetry behind.
 * - `busy_timeout` replaces an immediate `SQLITE_BUSY` with a bounded wait; see
 *   {@link STORE_BUSY_TIMEOUT_MS}.
 *
 * The handle is closed again before returning an `Err`, so a refused start
 * leaves no open database and no stray `-wal` file behind.
 *
 * @param config The resolved configuration; `databasePath` is inside the state
 * tree step 3 has already created.
 * @param loggers The service's loggers. This function's own records go through
 * the `store` child, while the migration ladder is handed the **root**: that
 * module puts `subsystem: 'store'` on every record it emits, so a child already
 * bound to the same key would duplicate it in one JSON record.
 * @returns `Ok` with an open, migrated handle, or `Err` describing why the store
 * cannot be used.
 */
function openSessionStore(
  config: ServiceConfig,
  loggers: ServiceLoggers,
): Result<DatabaseSync, DebuggenError> {
  const logger = loggers.store;
  const ddl = loadStoreDdl();
  if (isErr(ddl)) {
    return ddl;
  }

  // Before the handle exists, because `DatabaseSync` creates a missing database
  // under the umask and follows a link at the path, and neither can be undone
  // once it has written to the file.
  const prepared = prepareDatabaseFile(config);
  if (isErr(prepared)) {
    return prepared;
  }

  // `db` is declared outside the block so that a pragma that throws *after* the
  // handle was assigned still closes it: a returned failure must not leave an
  // open connection behind, or the caller's retry meets its own predecessor.
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(config.databasePath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS};`);
  } catch (cause) {
    if (db !== undefined) {
      closeSessionStore(db, logger);
    }
    return err(
      wrapStartupFailure(
        cause,
        'STORE_ERROR',
        'Could not open the Debug Generator session store.',
        `Check that ${config.databasePath} is writable by this account and that no other Debug Generator service is already running against it; stop that service, or set DEBUGGEN_HOME to a different state directory.`,
        { subsystem: SUBSYSTEM_STORE, databasePath: config.databasePath },
      ),
    );
  }

  const outcome = applyMigrations(db, { ddl: ddl.value, logger: loggers.root });

  // Run on both paths, and before either return: the migration transaction is
  // the first write, so it is what creates the `-wal` and `-shm` sidecars — a
  // failed ladder leaves them behind exactly as a successful one does, and they
  // hold the same session data as the database itself.
  const tightened = tightenStoreFiles(config);

  if (isErr(outcome)) {
    if (isErr(tightened)) {
      logger.error(tightened.error.message, errorFields(tightened.error));
    }
    closeSessionStore(db, logger);
    return outcome;
  }

  if (isErr(tightened)) {
    closeSessionStore(db, logger);
    return tightened;
  }

  logger.info('session store ready', {
    databasePath: config.databasePath,
    fromVersion: outcome.value.fromVersion,
    toVersion: outcome.value.toVersion,
    applied: [...outcome.value.applied],
    adopted: outcome.value.adopted,
  });

  return ok(db);
}

/**
 * Checkpoints the write-ahead log and closes the database, reporting rather
 * than raising.
 *
 * `PRAGMA wal_checkpoint(TRUNCATE)` folds `sessions.sqlite-wal` back into the
 * database file and truncates it, so a stopped service leaves one file that any
 * SQLite client can read — which is what makes a session inspectable after the
 * fact, and what keeps a crash-free stop from leaving a multi-megabyte log
 * behind. It is attempted before the close and never allowed to prevent it: a
 * failed checkpoint costs disk space, while a skipped close leaks a file
 * descriptor and the store's write lock.
 *
 * Called on the failure path of {@link openSessionStore}, on the failure path of
 * {@link startService} and from {@link ServiceHandle.close}, so it tolerates a
 * handle that is already closed.
 *
 * @param db The handle to close.
 * @param logger The `store` child logger.
 */
function closeSessionStore(db: DatabaseSync, logger: Logger): void {
  if (!db.isOpen) {
    return;
  }

  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (cause) {
    logger.warn('could not checkpoint the session store write-ahead log before closing it', {
      reason: DebuggenError.from(cause, 'STORE_ERROR').message,
    });
  }

  try {
    db.close();
  } catch (cause) {
    logger.error('could not close the session store cleanly', {
      reason: DebuggenError.from(cause, 'STORE_ERROR').message,
    });
  }
}

/* -------------------------------------------------------------------------------------------------
 * Step 5 — the HTTP surface
 * ---------------------------------------------------------------------------------------------- */

/** A listening HTTP surface: the server, and where it ended up bound. */
interface HttpSurface {
  /** The Node server `serve` created, for {@link ServiceHandle.close}. */
  readonly server: ServerType;

  /** The interface it is bound to, as configured. */
  readonly host: string;

  /** The port it is actually bound to, read back from the bound socket. */
  readonly port: number;

  /** The base URL of {@link host} and {@link port}. */
  readonly url: string;
}

/**
 * Whether an `Origin` header value is one this service accepts.
 *
 * Parsed with `URL` rather than matched as a string, so a prefix that merely
 * looks like an accepted scheme (`chrome-extension://x@evil.example`, or a
 * header with leading whitespace) is judged on its parsed protocol.
 *
 * @param origin The raw header value; the caller has already established that
 * the header is present, because an absent `Origin` is a non-browser client and
 * is accepted without reaching here.
 * @returns `true` for the schemes of {@link ACCEPTED_ORIGIN_PROTOCOLS}, `false`
 * for every web origin, for `null` and for anything unparseable.
 */
function isAcceptedOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return ACCEPTED_ORIGIN_PROTOCOLS.includes(parsed.protocol);
}

/**
 * Builds the base URL of a bound socket.
 *
 * A bare IPv6 literal is bracketed, because `http://::1:43117` is not a URL and
 * `DEBUGGEN_HOST=::1` is a supported configuration: the host is validated as a
 * non-empty string without whitespace, not as an IPv4 address.
 *
 * @param host The configured interface.
 * @param port The bound port.
 * @returns An absolute `http:` URL with no trailing slash.
 */
function formatServiceUrl(host: string, port: number): string {
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

/**
 * Builds the service's Hono application: the origin guard, `GET /health` and
 * the error handler.
 *
 * Pure and synchronous — it registers handlers and nothing else — so the app can
 * be built before the socket is bound and the health route answers from the
 * first accepted connection.
 *
 * @param logger The `server` child logger, captured by the two handlers that
 * report.
 * @returns The application whose `fetch` is handed to `serve`.
 */
function createServiceApp(logger: Logger): Hono {
  const app = new Hono();

  // AAP 0.5.6, applied to every route including the ones that do not exist: a
  // refusal must not depend on whether a path happens to be registered. No
  // `Access-Control-Allow-Origin` header is set here or anywhere else in this
  // file, so a browser cannot read a response even when one is produced.
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin !== undefined && !isAcceptedOrigin(origin)) {
      logger.warn('refused a request from a forbidden origin', {
        method: c.req.method,
        path: c.req.path,
        origin,
      });
      return c.json({ code: 'FORBIDDEN_ORIGIN', message: FORBIDDEN_ORIGIN_MESSAGE }, 403);
    }
    await next();
    return undefined;
  });

  // Unauthenticated by design — one of the two auth-exempt operations of AAP
  // 0.5.6 — and therefore limited to what an unauthenticated caller may learn:
  // that a Debug Generator service is here, and which protocol version it
  // speaks. Nothing about the developer's machine, the session store or the
  // configuration belongs in this body.
  app.get(HEALTH_ROUTE, (c) => c.json({ status: 'ok', protocolVersion: PROTOCOL_VERSION }));

  // The last boundary: a handler that threw, or a middleware that rejected.
  // The caught value is logged with the request that produced it and never
  // reflected into the response, where it could carry a path, a query or a
  // fragment of a developer's data.
  app.onError((cause, c) => {
    const error = DebuggenError.from(cause, 'INTERNAL');
    logger.error('unhandled failure while serving a request', {
      method: c.req.method,
      path: c.req.path,
      ...errorFields(error),
      reason: error.message,
    });
    return c.json({ code: 'INTERNAL', message: INTERNAL_ERROR_MESSAGE }, 500);
  });

  return app;
}

/**
 * Registers an `error` listener on a server of `serve`'s union return type.
 *
 * `ServerType` is `Server | Http2Server | Http2SecureServer`, and each of those
 * declares its own overload set for `on`; calling an overloaded method through
 * a union is what TypeScript refuses. Widening to the `EventEmitter` all three
 * extend is an ordinary assignment rather than a cast, and `error` is an
 * `EventEmitter` event on every one of them.
 *
 * The listener is attached immediately after `serve` returns, which is
 * race-free: `serve` calls `listen` synchronously and Node emits a bind failure
 * on a later tick.
 *
 * @param server The server `serve` returned.
 * @param listener Handler for the emitted error.
 */
function onServerError(server: ServerType, listener: (cause: unknown) => void): void {
  const emitter: EventEmitter = server;
  emitter.on('error', listener);
}

/**
 * Releases connections that are open but idle, where the runtime offers it.
 *
 * `closeIdleConnections` is declared by `node:http`'s server and not by every
 * member of `ServerType`, so it is feature-detected rather than assumed. It is
 * what lets `server.close()` complete promptly in the common case, where the
 * only thing keeping the server open is a client's idle keep-alive socket.
 *
 * @param server The server being shut down.
 */
function closeIdleConnections(server: ServerType): void {
  if ('closeIdleConnections' in server && typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }
}

/**
 * Closes every remaining connection, including in-flight ones.
 *
 * The escalation behind {@link SHUTDOWN_GRACE_MS}: a request that has not
 * finished by then is abandoned so the process can exit inside the window its
 * supervisor allows. Feature-detected for the same reason as
 * {@link closeIdleConnections}.
 *
 * @param server The server being shut down.
 */
function forceCloseConnections(server: ServerType): void {
  if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
}

/**
 * Binds the socket and resolves once it is listening.
 *
 * The promise settles exactly once, on whichever of three things happens first:
 * the listening callback (`Ok`, with the bound port read back from the
 * `AddressInfo` the adapter hands over), an `error` event (`Err`), or a
 * synchronous throw from `serve` (`Err`). A bind failure therefore never
 * escapes as an unhandled `error` event, and `EADDRINUSE` — by far the most
 * common of them, and what a second service instance or a stale process
 * produces — arrives as a typed error naming the host and port a developer has
 * to free or change.
 *
 * The `error` listener stays attached after the promise has settled, because a
 * server that emits `error` with no listener throws inside Node's event
 * machinery; afterwards such an event is logged instead.
 *
 * @param app The application whose `fetch` handles requests.
 * @param config The resolved configuration: `host` and `port` are the bind
 * request, and `port: 0` asks the operating system to choose.
 * @param logger The `server` child logger.
 * @returns `Ok` with the listening surface, or `Err` explaining the refusal.
 */
function startHttpServer(
  app: Hono,
  config: ServiceConfig,
  logger: Logger,
): Promise<Result<HttpSurface, DebuggenError>> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: Result<HttpSurface, DebuggenError>): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let server: ServerType;

    const handleFailure = (cause: unknown): void => {
      if (settled) {
        logger.error('the HTTP server reported an error after start-up', {
          reason: DebuggenError.from(cause, 'INTERNAL').message,
        });
        return;
      }
      settle(
        err(
          wrapStartupFailure(
            cause,
            'INTERNAL',
            `Could not bind the Debug Generator service to ${formatServiceUrl(config.host, config.port)}.`,
            `Another process is most likely already listening on ${config.host} port ${config.port}: stop it, set DEBUGGEN_PORT to a free port, or set DEBUGGEN_PORT=0 to let the operating system choose one.`,
            { subsystem: SUBSYSTEM_SERVER, host: config.host, port: config.port },
          ),
        ),
      );
    };

    const handleListening = (info: AddressInfo): void => {
      settle(
        ok({
          server,
          host: config.host,
          port: info.port,
          url: formatServiceUrl(config.host, info.port),
        }),
      );
    };

    try {
      server = serve(
        { fetch: app.fetch, hostname: config.host, port: config.port },
        handleListening,
      );
      onServerError(server, handleFailure);
    } catch (cause) {
      handleFailure(cause);
    }
  });
}

/**
 * Stops the server accepting connections and waits, bounded, for the open ones
 * to end.
 *
 * Never rejects: a shutdown that cannot complete still has to let the process
 * exit, so the outcome is logged and the promise resolves either way.
 *
 * @param server The listening server.
 * @param logger The `server` child logger.
 * @returns A promise that resolves once the server is closed, or once
 * {@link SHUTDOWN_GRACE_MS} has elapsed and the remaining connections have been
 * closed outright.
 */
function closeHttpServer(server: ServerType, logger: Logger): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;

    // Declared before the timer it clears, which it can only ever run after:
    // `finish` is reached from the timer's own callback or from the server's
    // close callback, both of which are later ticks.
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(graceTimer);
      resolve();
    };

    const graceTimer = setTimeout(() => {
      logger.warn('connections were still open after the shutdown grace period; closing them', {
        graceMs: SHUTDOWN_GRACE_MS,
      });
      forceCloseConnections(server);
      finish();
    }, SHUTDOWN_GRACE_MS);

    // Unreferenced so the grace period cannot itself keep the event loop alive
    // once the server has closed on time, which is the ordinary case.
    graceTimer.unref();

    server.close(() => {
      finish();
    });

    // After `close()`, so a socket that goes idle between the two calls is
    // still released rather than waited on.
    closeIdleConnections(server);
  });
}

/* -------------------------------------------------------------------------------------------------
 * The handle
 * ---------------------------------------------------------------------------------------------- */

/**
 * Assembles the {@link ServiceHandle} a successful start returns.
 *
 * The shutdown sequence is memoised in one promise, which is what makes
 * {@link ServiceHandle.close} idempotent under the two signals, a suite's
 * explicit call and a crash handler all at once: the first caller runs the
 * sequence, every other caller awaits it, and nobody closes a database twice.
 * The sequence is ordered — the socket stops accepting *before* the store is
 * checkpointed — so no request can be part-way through a write when the handle
 * goes away.
 *
 * @param surface The listening HTTP surface.
 * @param db The open, migrated store.
 * @param loggers The root logger and its children.
 * @returns A frozen handle; frozen because it is shared with signal handlers
 * and must not be re-pointed by whoever holds it.
 */
function createServiceHandle(
  surface: HttpSurface,
  db: DatabaseSync,
  loggers: ServiceLoggers,
): ServiceHandle {
  let closing: Promise<void> | undefined;

  const shutdown = async (): Promise<void> => {
    loggers.service.info('stopping the Debug Generator service', { url: surface.url });
    try {
      await closeHttpServer(surface.server, loggers.server);
      closeSessionStore(db, loggers.store);
      loggers.service.info('the Debug Generator service has stopped', { url: surface.url });
    } catch (cause) {
      // Neither helper is expected to throw — both report internally — so this
      // is the guard that keeps the memoised promise resolvable even if one of
      // them ever does. A rejected `closing` would make every later `close()`
      // reject too, including the one a signal handler awaits before exit.
      loggers.service.error('the shutdown sequence failed', {
        reason: DebuggenError.from(cause, 'INTERNAL').message,
      });
    }
  };

  return Object.freeze({
    url: surface.url,
    host: surface.host,
    port: surface.port,
    logger: loggers.root,
    close: (): Promise<void> => {
      closing ??= shutdown();
      return closing;
    },
  });
}

/* -------------------------------------------------------------------------------------------------
 * Starting the service
 * ---------------------------------------------------------------------------------------------- */

/**
 * Starts the local service: configuration, logging, state tree, store, HTTP.
 *
 * The five steps and their order are documented in this module's header. Every
 * failure is a typed `Err` rather than a throw, and every step that has already
 * taken a resource releases it before the `Err` is returned, so a refused start
 * leaves the machine as it found it: no open database, no bound socket.
 *
 * Reads no `process` state whatsoever — not the environment, not the working
 * directory, not the signals — which is what lets an integration suite start
 * several services in one process, each with its own temporary state root and
 * an ephemeral port.
 *
 * @param options The environment, the overrides and the logger seams. Defaults
 * to an empty record, which resolves the service's own defaults.
 * @returns `Ok` with a listening {@link ServiceHandle}, or `Err` with the first
 * failure that prevented the start — `CONFIG_INVALID` from the configuration
 * loader, `FS_UNSAFE_PATH` from the state tree, `STORE_ERROR` from the store, or
 * `INTERNAL` from the bind.
 *
 * @example Starting a throwaway instance in a suite
 * ```ts
 * const started = await startService({
 *   overrides: { debuggenHome: tempDir, port: 0 },
 * });
 * if (isErr(started)) {
 *   throw started.error;
 * }
 * const response = await fetch(`${started.value.url}/health`);
 * await started.value.close();
 * ```
 */
export async function startService(
  options: StartServiceOptions = {},
): Promise<Result<ServiceHandle, DebuggenError>> {
  // 1 — configuration, from the injected environment only.
  const loaded = loadServiceConfig(options.env ?? {}, options.overrides);
  if (isErr(loaded)) {
    return loaded;
  }
  const config = loaded.value;

  // 2 — logging. `describeServiceConfig` is logged through the ROOT logger
  // because those fields already carry their own `subsystem`, and it is the one
  // credential-free view of the configuration: nothing else here logs it.
  const root = createServiceLogger(config, options.loggerOptions);
  const loggers: ServiceLoggers = {
    root,
    service: subsystemLogger(root, SUBSYSTEM_SERVICE),
    store: subsystemLogger(root, SUBSYSTEM_STORE),
    server: subsystemLogger(root, SUBSYSTEM_SERVER),
  };
  root.info('service configuration resolved', describeServiceConfig(config));

  // 3 — the state tree, before anything writes into it.
  const tree = prepareStateTree(config);
  if (isErr(tree)) {
    loggers.service.error(tree.error.message, errorFields(tree.error));
    return tree;
  }

  // 4 — the session store, before the surface that serves from it.
  const store = openSessionStore(config, loggers);
  if (isErr(store)) {
    loggers.store.error(store.error.message, errorFields(store.error));
    return store;
  }
  const db = store.value;

  // 5 — the HTTP surface. On failure the store is closed again, so the `Err`
  // this returns describes a process that holds nothing.
  const surface = await startHttpServer(createServiceApp(loggers.server), config, loggers.server);
  if (isErr(surface)) {
    loggers.server.error(surface.error.message, errorFields(surface.error));
    closeSessionStore(db, loggers.store);
    return surface;
  }

  return ok(createServiceHandle(surface.value, db, loggers));
}

/* -------------------------------------------------------------------------------------------------
 * The process
 * ---------------------------------------------------------------------------------------------- */

/**
 * Writes a start-up failure to stderr in the form a developer reads in a
 * terminal or in Playwright's captured output.
 *
 * stderr rather than the logger: a failure before or during
 * {@link startService} may predate a usable logger — a rejected
 * `DEBUGGEN_LOG_LEVEL` is itself a configuration failure — and the message has
 * to arrive regardless. Written in one call so the lines cannot interleave with
 * another writer's.
 *
 * @param error The failure to report. Its `details` are deliberately omitted:
 * they are diagnostic context for the log, while this is the message a
 * developer acts on.
 */
function reportStartupFailure(error: DebuggenError): void {
  const lines = [`debuggen: ${error.code}: ${error.message}`];
  if (error.hint !== undefined) {
    lines.push(`debuggen: hint: ${error.hint}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

/**
 * Wires the process's signals and crash handlers to one shutdown.
 *
 * - **SIGINT and SIGTERM** close the handle once and then let the process end
 *   naturally. The re-entry guard matters: Playwright sends SIGTERM and waits
 *   10 s, a developer may press Ctrl-C twice, and a second sequence must not
 *   start while the first is running. `close()` is itself idempotent, so the
 *   guard is about not logging the decision twice.
 * - **`uncaughtException` and `unhandledRejection`** are the two ways this
 *   process could otherwise die silently or, worse, keep listening in a state
 *   nobody can reason about. Both are logged at `fatal` through the service's
 *   own logger, set a non-zero exit code and then run the same shutdown, which
 *   is what turns a crash into an orderly stop with a checkpointed store rather
 *   than a lingering socket and a `-wal` file.
 *
 * `process.exitCode` is set instead of calling `process.exit`, which would
 * discard whatever stdout still holds — including the very record that explains
 * the exit.
 *
 * @param handle The started service to stop.
 */
function installProcessHandlers(handle: ServiceHandle): void {
  const lifecycle = subsystemLogger(handle.logger, SUBSYSTEM_SERVICE);
  let stopping = false;

  const stop = (reason: string, fields: LogFields): void => {
    if (stopping) {
      lifecycle.debug('ignoring a repeated shutdown request', { reason, ...fields });
      return;
    }
    stopping = true;
    lifecycle.info(reason, fields);
    handle.close().catch((cause: unknown) => {
      // `close()` is documented never to reject; this keeps even a broken
      // promise from becoming an unhandled rejection inside a signal handler.
      lifecycle.error('the shutdown request failed', {
        reason: DebuggenError.from(cause, 'INTERNAL').message,
      });
    });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      stop('received a shutdown signal', { signal });
    });
  }

  process.on('uncaughtException', (cause: unknown) => {
    const error = DebuggenError.from(cause, 'INTERNAL');
    lifecycle.fatal('an uncaught exception reached the process boundary', {
      ...errorFields(error),
      reason: error.message,
    });
    process.exitCode = 1;
    stop('stopping after an uncaught exception', {});
  });

  process.on('unhandledRejection', (cause: unknown) => {
    const error = DebuggenError.from(cause, 'INTERNAL');
    lifecycle.fatal('a promise rejection reached the process boundary unhandled', {
      ...errorFields(error),
      reason: error.message,
    });
    process.exitCode = 1;
    stop('stopping after an unhandled rejection', {});
  });
}

/**
 * The process entry: loads `.env`, starts the service and wires the signals.
 *
 * The process-facing half of this module: {@link startService} reads no
 * `process` state at all, and everything that does — the environment, the exit
 * code, the signals and the crash handlers — is reached from here or from the
 * helpers this function calls.
 *
 * `dotenv` runs here and nowhere else, quietly (it otherwise prints a banner
 * that would be the first thing in an otherwise structured log stream), and its
 * result is not inspected on purpose: an absent `.env` is the normal case —
 * every setting has a default or is supplied by the environment the service was
 * started with — so treating it as a failure would break `node dist/main.js` on
 * a clean checkout.
 *
 * On failure it prints the code, message and hint to stderr and sets
 * `process.exitCode = 1` rather than calling `process.exit`, so the streams
 * flush. On success it logs the listening URL once, which is the line a
 * developer looks for and the line Playwright's captured output makes visible.
 *
 * @returns A promise that resolves once the service is listening, or once the
 * failure has been reported. It does not wait for the service to stop: the
 * bound socket keeps the process alive, and the signal handlers end it.
 */
export async function main(): Promise<void> {
  loadDotenvFile({ quiet: true });

  const started = await startService({ env: process.env });
  if (isErr(started)) {
    reportStartupFailure(started.error);
    process.exitCode = 1;
    return;
  }

  const handle = started.value;
  installProcessHandlers(handle);
  handle.logger.info('the Debug Generator service is listening', {
    subsystem: SUBSYSTEM_SERVICE,
    url: handle.url,
    host: handle.host,
    port: handle.port,
    protocolVersion: PROTOCOL_VERSION,
    healthRoute: HEALTH_ROUTE,
  });
}

/**
 * Whether this module is the program the runtime was asked to run.
 *
 * `import.meta.url` is compared with `process.argv[1]` resolved through
 * `pathToFileURL`, which is what makes the comparison hold for both supported
 * invocations — `node dist/main.js`, where Node resolves the argument to an
 * absolute path, and `tsx watch src/main.ts`, where the loader keeps the
 * TypeScript path — without matching a filename by hand.
 *
 * The check is what lets an integration suite `import` this module for
 * {@link startService} without a listener appearing as a side effect of the
 * import.
 *
 * @param argv The process arguments, injectable so the decision can be
 * exercised directly.
 * @returns `true` only when the entry script is this module.
 */
function isProcessEntry(argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (entry === undefined || entry.length === 0) {
    return false;
  }
  return pathToFileURL(entry).href === import.meta.url;
}

if (isProcessEntry()) {
  main().catch((cause: unknown) => {
    // `main` handles every failure it can name; this covers the ones it cannot,
    // so the process still reports a reason and a non-zero status instead of
    // exiting 0 on a rejected promise.
    reportStartupFailure(DebuggenError.from(cause, 'INTERNAL'));
    process.exitCode = 1;
  });
}
