/**
 * The editor credential: the one module of the VS Code extension that touches
 * `$DEBUGGEN_HOME/auth.json`.
 *
 * AAP §0.5.6 authenticates every client of the local service by role and
 * scope. The extension host is the **editor** client (role `vscode`), and
 * because it runs as the same account as the service it needs no pairing
 * ceremony: it reads the service's editor credential straight from
 * `$DEBUGGEN_HOME/auth.json` (mode `0600`, in a `0700` directory) and presents
 * it as `Authorization: Bearer …` on HTTP and as `client.hello { token }` on
 * the WebSocket. When the extension is the process that starts the service, it
 * creates that file first (§0.5.6: "and creates it when the extension starts
 * the service"), so the service it spawns adopts a credential the editor
 * already holds.
 *
 * Consumers in this folder:
 *
 * - `client.ts` hands {@link asTokenProvider}'s getter — never a captured
 *   string — to the protocol's `HttpClient` and `ReconnectingWsClient`, and
 *   calls {@link EditorCredentialStore.refresh} from their unauthorized
 *   handlers, which is how a token rotation (`debuggen.rotateServiceToken`:
 *   every credential row deleted, `auth.json` regenerated, every socket closed
 *   with code 4401) is picked up.
 * - `process.ts` calls {@link EditorCredentialStore.ensure} before it spawns the
 *   embedded service, and {@link EditorCredentialStore.waitForCredential} when
 *   a service it did not create the file for is starting.
 * - `src/extension.ts` pushes the store into `context.subscriptions`; its
 *   `dispose()` drops the in-memory secret.
 *
 * ## Why the extension never pairs
 *
 * Pairing (`POST /pair/start` → one-time code → `POST /pair/complete`) exists
 * solely because the Chrome extension cannot read this file. The editor only
 * *starts* a pairing on the developer's behalf (`debuggen.pairChrome`, through
 * `client.ts`); it never redeems a code and never holds a DevTools credential.
 * Nothing in this module speaks to the service at all.
 *
 * ## The file format, shared with the service
 *
 * `apps/local-service/src/server/auth.ts` (`ensureEditorCredential()`, the
 * service's mint-or-read at start-up) is the other writer of this file, and its
 * schema is the authority: a **strict** object
 * `{ "version": 1, "token": "<credential>", "issuedAt": <epoch ms> }`. The
 * service discards and replaces a file carrying any other key, so this module
 * writes exactly those three keys — in the service's own serialisation, two-space
 * JSON with a trailing newline — and mints the token the way the service does:
 * {@link EDITOR_CREDENTIAL_TOKEN_BYTES} bytes of CSPRNG output rendered
 * base64url. A file this module writes is therefore indistinguishable from one
 * the service wrote, and the service's start-up registers its token instead of
 * replacing it.
 *
 * Reading is deliberately more tolerant than writing, because the service owns
 * the format and may extend it: only a plausible string `token` is required,
 * and unknown keys, a missing `version` and a `role` are all accepted.
 *
 * ## Race safety
 *
 * Creation is exclusive-create-or-read and never overwrites: whichever of the
 * extension and the service writes first, both end up presenting the token on
 * disk. The residual window — the service replacing a file the extension had
 * just created, or a second editor window reading a file mid-write — heals on
 * its own: an in-memory token that the service no longer accepts produces a
 * 401 or a 4401 close, `client.ts` calls {@link EditorCredentialStore.refresh},
 * and the file on disk is the answer.
 *
 * ## Credential hygiene (AAP §0.5.2, §0.5.6)
 *
 * The token value leaves this module in exactly one way: as the successful
 * value of a `Result`, or as the return value of
 * {@link EditorCredentialStore.token}. It is never logged at any level, never
 * placed in a `DebuggenError` message, hint or detail, never shown in the user
 * interface and never written anywhere but `auth.json`. Log lines carry *facts
 * about* the credential only — the file path, its mode and a length category —
 * and {@link describeCredentialForLog} is the single pure function that builds
 * them, so the rule can be checked by reading one function. Error messages
 * built for a malformed file never echo its content.
 *
 * ## Failure reporting (AAP §0.5.5)
 *
 * Every operation resolves to a `Result`; no promise returned here rejects and
 * nothing throws for an expected condition. "The service has not written a
 * credential yet" is a distinct, recognisable failure (reason `missing`), so
 * callers render "Service not running" rather than an error, and extension
 * activation is never blocked by this module. Each failure carries one reason
 * from {@link EDITOR_CREDENTIAL_FAILURE_REASONS} in `details.reason`, read back
 * with {@link editorCredentialFailureReason}.
 *
 * ## No work at load time
 *
 * Importing this module reads no environment variable, touches no file and
 * starts no timer. `DEBUGGEN_HOME` is resolved on every call, from an
 * injectable environment, because the extension-host suites run with a
 * throwaway `DEBUGGEN_HOME` (`apps/vscode-extension/.vscode-test.mjs`) and must
 * never reach a developer's real `~/.debuggen`. There is no top-level `await`:
 * the host bundle is CommonJS, emitted by `esbuild.mjs`.
 *
 * @packageDocumentation
 */

import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { homedir } from 'node:os';

import {
  DebuggenError,
  err,
  isAbsolutePosix,
  isErr,
  isWindowsAbsolute,
  joinPosix,
  noopLogger,
  normalizePosix,
  nowEpochMs,
  ok,
  toPosix,
} from '@debuggen/shared';
import type { DebuggenErrorCode, Err, LogFields, Logger, Result } from '@debuggen/shared';
import {
  SECURE_DIR_MODE,
  SECURE_FILE_MODE,
  assertSecureDir,
  createFileExclusive,
  ensureSecureDir,
  inspectPrivateFileNoFollow,
  readFileNoFollow,
} from '@debuggen/shared/node';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The environment variable naming the product's state directory.
 *
 * The same name `apps/local-service/src/config.ts` reads, so the editor and the
 * service it spawns agree on where `auth.json` lives.
 */
export const DEBUGGEN_HOME_ENV = 'DEBUGGEN_HOME';

/**
 * The state directory when `DEBUGGEN_HOME` is unset or empty, spelled as the
 * service spells it (`DEFAULT_DEBUGGEN_HOME` in `apps/local-service/src/config.ts`).
 * Outside every checkout, so a session never shows up in `git status`.
 */
export const DEFAULT_DEBUGGEN_HOME = '~/.debuggen';

/** The editor credential's file name inside the state directory (AAP §0.5.6). */
export const AUTH_FILE_NAME = 'auth.json';

/** The `version` the service's `auth.json` schema requires, and this module writes. */
export const AUTH_FILE_VERSION = 1;

/**
 * How many CSPRNG bytes a credential minted here carries: 32, the size AAP
 * §0.5.6 prescribes and the service's `CREDENTIAL_TOKEN_BYTES`.
 */
export const EDITOR_CREDENTIAL_TOKEN_BYTES = 32;

/**
 * The length of a credential minted by this module or by the service: 32 bytes
 * rendered base64url, unpadded.
 */
export const EDITOR_CREDENTIAL_STANDARD_LENGTH = Math.ceil((EDITOR_CREDENTIAL_TOKEN_BYTES * 4) / 3);

/**
 * The shortest token read from `auth.json` that is accepted as a credential.
 *
 * Below this the value cannot be a credential either writer minted, and
 * presenting it would only earn a 401; reporting the file as malformed names
 * the actual fix instead.
 */
export const MIN_EDITOR_CREDENTIAL_LENGTH = 16;

/**
 * The longest token read from `auth.json` that is accepted: the bound protocol's
 * `client.hello` token schema enforces, so a value accepted here is never
 * refused by the first frame it travels in.
 */
export const MAX_EDITOR_CREDENTIAL_LENGTH = 512;

/**
 * The largest `auth.json` this module parses, in bytes.
 *
 * The genuine record is about a hundred bytes; a file orders of magnitude
 * larger is not one, and is reported as malformed rather than parsed.
 */
export const MAX_AUTH_FILE_BYTES = 64 * 1024;

/**
 * Default bound on {@link EditorCredentialStore.waitForCredential}: short, so a
 * caller on the activation path is never held up for long.
 */
export const DEFAULT_CREDENTIAL_WAIT_TIMEOUT_MS = 3_000;

/** Upper bound for an injected wait timeout; larger values are clamped. */
export const MAX_CREDENTIAL_WAIT_TIMEOUT_MS = 60_000;

/** Default interval between two reads of `auth.json` while waiting for it. */
export const DEFAULT_CREDENTIAL_POLL_INTERVAL_MS = 100;

/** Lower bound for an injected poll interval; smaller values are raised to it. */
export const MIN_CREDENTIAL_POLL_INTERVAL_MS = 10;

/** Upper bound for an injected poll interval; larger values are clamped. */
export const MAX_CREDENTIAL_POLL_INTERVAL_MS = 5_000;

/**
 * How many create-then-read rounds {@link EditorCredentialStore.ensure} makes
 * before it reports a file that stays unusable.
 *
 * More than one because a second editor window may have created the file an
 * instant earlier and still be writing its bytes (an exclusive create is
 * visible before its content is), or because the file may vanish between the
 * refused create and the read.
 */
const ENSURE_SETTLE_ATTEMPTS = 5;

/** The pause between two {@link ENSURE_SETTLE_ATTEMPTS} rounds, in milliseconds. */
const ENSURE_SETTLE_DELAY_MS = 20;

/** A `DEBUGGEN_HOME` value of exactly `~`. */
const HOME_MARKER = '~';

/** The prefix that expands to the account's home directory. */
const HOME_PREFIX = '~/';

/** The two-separator prefix a UNC path carries once separators are normalised. */
const UNC_PREFIX = '//';

/** A Windows path rooted at a drive, after separators were converted: `C:/…`. */
const WINDOWS_DRIVE_ROOTED = /^[A-Za-z]:\//;

/**
 * The characters a credential may consist of: printable ASCII without the
 * space, and without the comma a bearer header refuses — the same character
 * rule the service's bearer parser applies.
 */
const CREDENTIAL_CHARACTERS = /^[\x21-\x2b\x2d-\x7e]+$/;

/** A leading UTF-8 byte-order mark, which `JSON.parse` would otherwise refuse. */
const BYTE_ORDER_MARK = /^\uFEFF/;

/** The permission bits of a mode, with the file-type and set-id bits masked off. */
const PERMISSION_BITS = 0o777;

/**
 * The permission bits that grant a group or other accounts access, derived from
 * the state-directory policy rather than restated: everything but the owner's.
 */
const GROUP_AND_OTHER_BITS = PERMISSION_BITS & ~SECURE_DIR_MODE;

/** The developer's next step whenever a file-system check of the state directory fails. */
const PRIVATE_HOME_HINT = 'Check that $DEBUGGEN_HOME is a private directory owned by this account.';

/** The developer's next step whenever `DEBUGGEN_HOME` itself is unusable. */
const DEBUGGEN_HOME_HINT =
  `Set ${DEBUGGEN_HOME_ENV} to an absolute directory path, or to a path starting with '${HOME_PREFIX}', ` +
  `in the environment VS Code was started from, or leave it unset for '${DEFAULT_DEBUGGEN_HOME}'.`;

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/**
 * Why the editor credential could not be produced, one per failure this module
 * reports (AAP §0.5.5). Carried in `details.reason` of every `DebuggenError` it
 * returns, so a caller branches on a closed set instead of on a message:
 *
 * | Reason | Meaning | Repaired by starting the service? |
 * | --- | --- | --- |
 * | `home-invalid` | `DEBUGGEN_HOME` is not usable as a state directory | no — fix the setting |
 * | `missing` | no `auth.json` yet: the service has not started (render "Service not running") | yes |
 * | `malformed` | `auth.json` holds no usable credential record | yes — the service replaces it |
 * | `exposed` | `auth.json` is readable by other accounts, so its token is not trusted | yes — the service replaces it |
 * | `unsafe-path` | a symlink, a foreign owner, a second hard link or a non-private directory | no — the developer must act |
 * | `unreadable` | the file or directory could not be inspected or read | no |
 * | `write-failed` | the state directory or `auth.json` could not be created | no |
 * | `timeout` | {@link EditorCredentialStore.waitForCredential} ran out of time | — |
 * | `aborted` | the wait was cancelled, by its caller or by `dispose()` | — |
 * | `internal` | an unexpected failure this module could not classify | — |
 */
export const EDITOR_CREDENTIAL_FAILURE_REASONS = Object.freeze([
  'home-invalid',
  'missing',
  'malformed',
  'exposed',
  'unsafe-path',
  'unreadable',
  'write-failed',
  'timeout',
  'aborted',
  'internal',
] as const);

/** One member of {@link EDITOR_CREDENTIAL_FAILURE_REASONS}. */
export type EditorCredentialFailureReason = (typeof EDITOR_CREDENTIAL_FAILURE_REASONS)[number];

/**
 * The closed error code each reason is reported with, drawn from
 * `DEBUGGEN_ERROR_CODES` (no code is invented here): the auth family where the
 * outcome is "no credential to present", the configuration family where the
 * developer's state directory or its file is at fault, the filesystem-policy
 * code for a refused path, and `INTERNAL` only as the last resort.
 */
const REASON_CODES: Readonly<Record<EditorCredentialFailureReason, DebuggenErrorCode>> =
  Object.freeze({
    'home-invalid': 'CONFIG_INVALID',
    missing: 'UNAUTHORIZED',
    malformed: 'CONFIG_INVALID',
    exposed: 'FS_UNSAFE_PATH',
    'unsafe-path': 'FS_UNSAFE_PATH',
    unreadable: 'CONFIG_INVALID',
    'write-failed': 'CONFIG_INVALID',
    timeout: 'UNAUTHORIZED',
    aborted: 'UNAUTHORIZED',
    internal: 'INTERNAL',
  });

/** Membership test over the reason vocabulary, for reading a reason back off an error. */
const REASON_SET: ReadonlySet<string> = new Set<string>(EDITOR_CREDENTIAL_FAILURE_REASONS);

/**
 * The reasons {@link EditorCredentialStore.waitForCredential} keeps polling
 * through: each one describes a file the service is about to write or replace.
 */
const WAITABLE_REASONS: ReadonlySet<EditorCredentialFailureReason> = new Set([
  'missing',
  'malformed',
  'exposed',
]);

/**
 * The reasons {@link EditorCredentialStore.ensure} retries through: a file
 * another writer created an instant ago and is still filling, or one that
 * vanished between the refused create and the read.
 */
const SETTLING_REASONS: ReadonlySet<EditorCredentialFailureReason> = new Set([
  'missing',
  'malformed',
]);

/**
 * The failure reason carried by an error this module returned, or `undefined`
 * for any other value.
 *
 * The supported way to tell "service not running yet" (`missing`) apart from
 * "the credential file needs the developer" without parsing a message
 * (AAP §0.5.5). Structural, so it works on an error that crossed a bundle
 * boundary.
 *
 * @param error Typically the `error` of a failed `Result` from this module.
 * @returns The reason, or `undefined` when `error` carries none of them.
 */
export function editorCredentialFailureReason(
  error: unknown,
): EditorCredentialFailureReason | undefined {
  if (!DebuggenError.is(error)) {
    return undefined;
  }
  const reason = error.details?.reason;
  return isFailureReason(reason) ? reason : undefined;
}

/** Whether `value` is one of the {@link EDITOR_CREDENTIAL_FAILURE_REASONS}. */
function isFailureReason(value: unknown): value is EditorCredentialFailureReason {
  return typeof value === 'string' && REASON_SET.has(value);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Where `DEBUGGEN_HOME` is read from. Every member is optional; the defaults
 * are the real process environment and the account's home directory, both read
 * at call time and never at module load.
 *
 * Optional members are declared `| undefined` as well because the repository
 * compiles with `exactOptionalPropertyTypes`, which lets a caller forward its
 * own possibly-absent option unchanged.
 */
export interface DebuggenHomeOptions {
  /**
   * The environment `DEBUGGEN_HOME` is taken from. Defaults to `process.env`,
   * read on every call. Tests pass a plain record so no global is mutated.
   */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;

  /**
   * The home directory a leading `~` expands against. Defaults to
   * `os.homedir()`. Must be absolute.
   */
  readonly homeDir?: string | undefined;

  /**
   * A state directory that wins over `DEBUGGEN_HOME`, validated by the same
   * rules — the counterpart of the service configuration's own override.
   */
  readonly debuggenHome?: string | undefined;
}

/** The two paths this module derives, both absolute and in POSIX spelling. */
export interface EditorCredentialPaths {
  /** The state directory: `DEBUGGEN_HOME`, expanded and normalised. */
  readonly debuggenHome: string;

  /** `<debuggenHome>/auth.json`, the editor credential. */
  readonly authFilePath: string;
}

/** Options for {@link createEditorCredentialStore}. */
export interface EditorCredentialStoreOptions extends DebuggenHomeOptions {
  /**
   * Where facts about the credential are logged. Defaults to a no-op logger.
   * The token itself is never passed to it.
   */
  readonly logger?: Logger | undefined;

  /**
   * The CSPRNG a new credential is drawn from. Defaults to `node:crypto`'s
   * `randomBytes`. Injectable so a suite can make minting deterministic.
   */
  readonly randomBytes?: ((size: number) => Uint8Array) | undefined;

  /**
   * The clock `issuedAt` and wait deadlines are read from, in epoch
   * milliseconds. Defaults to `nowEpochMs` from `@debuggen/shared`.
   */
  readonly now?: (() => number) | undefined;
}

/** Options for {@link EditorCredentialStore.waitForCredential}. */
export interface WaitForCredentialOptions {
  /**
   * How long to wait in total, in milliseconds. Defaults to
   * {@link DEFAULT_CREDENTIAL_WAIT_TIMEOUT_MS}; clamped to
   * `[0, MAX_CREDENTIAL_WAIT_TIMEOUT_MS]`. `0` means "read once".
   */
  readonly timeoutMs?: number | undefined;

  /**
   * The pause between two reads, in milliseconds. Defaults to
   * {@link DEFAULT_CREDENTIAL_POLL_INTERVAL_MS}; clamped to
   * `[MIN_CREDENTIAL_POLL_INTERVAL_MS, MAX_CREDENTIAL_POLL_INTERVAL_MS]`.
   */
  readonly intervalMs?: number | undefined;

  /** Cancels the wait; it then resolves with reason `aborted`. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * The editor credential as the extension host holds it (AAP §0.5.6).
 *
 * Every asynchronous member resolves to a `Result` and never rejects, so a
 * caller on the activation path cannot leave an unhandled rejection behind.
 * The in-memory token mirrors the last successful read: a failed read clears
 * it, so a credential that can no longer be confirmed on disk is not presented.
 */
export interface EditorCredentialStore {
  /**
   * The resolved state directory and credential path, for `process.ts` to
   * pass to the service it spawns as `DEBUGGEN_HOME`.
   */
  paths(): Result<EditorCredentialPaths, DebuggenError>;

  /**
   * Reads `auth.json` and caches its token. The directory must pass the
   * state-directory policy, the file must be a private, regular, single-link
   * file owned by this account, and it must hold a plausible token. A file
   * that does not exist yet is the failure with reason `missing`.
   */
  read(): Promise<Result<string, DebuggenError>>;

  /**
   * Creates `auth.json` with a freshly minted credential when it does not
   * exist — never overwriting one that does — then reads it back. The call
   * `process.ts` makes before it spawns the service, so the service adopts the
   * credential the editor already holds. Idempotent, and race-safe against the
   * service's own mint-or-read.
   */
  ensure(): Promise<Result<string, DebuggenError>>;

  /**
   * The cached token, or `undefined` when none has been read. Synchronous and
   * lazy: shaped for the protocol clients' `TokenProvider`, which re-reads it
   * on every request (see {@link asTokenProvider}).
   */
  token(): string | undefined;

  /**
   * Drops the cache and reads `auth.json` again: the rotation path, called on
   * a 401 or a 4401 close.
   */
  refresh(): Promise<Result<string, DebuggenError>>;

  /**
   * Polls for a usable `auth.json` for a bounded time — the belt-and-braces
   * path for a service that is starting and will write the file itself. Stops
   * early on a failure no service start could repair.
   */
  waitForCredential(options?: WaitForCredentialOptions): Promise<Result<string, DebuggenError>>;

  /** Clears the cached token. The next {@link EditorCredentialStore.read} re-reads the file. */
  invalidate(): void;

  /**
   * The `vscode.Disposable` shape: clears the cached token and cancels every
   * in-flight {@link EditorCredentialStore.waitForCredential}, which resolves
   * with reason `aborted`. Idempotent. The store can still re-read the file
   * afterwards, which keeps a late request — `deactivate()` ending the active
   * session — able to authenticate through `refresh()`.
   */
  dispose(): void;
}

/** What {@link parseEditorCredentialRecord} found wrong with a file's content. */
export type EditorCredentialRecordProblem =
  'empty' | 'too-large' | 'not-json' | 'not-an-object' | 'no-token' | 'invalid-token';

/** How a token's length compares with a minted credential, for log lines. */
export type CredentialLengthCategory = 'standard' | 'nonstandard';

/** The only fields a log line about the credential ever carries. */
export interface CredentialLogFields extends LogFields {
  /** The credential file's absolute path. */
  readonly path: string;
  /** Its permission bits, octal, as `chmod` takes them. */
  readonly mode: string;
  /** Whether the token has the length a minted credential has. */
  readonly length: CredentialLengthCategory;
}

// ---------------------------------------------------------------------------
// Resolving $DEBUGGEN_HOME (pure apart from the default environment)
// ---------------------------------------------------------------------------

/**
 * A setting as it arrives from an environment or an option: trimmed, and
 * `undefined` when absent or blank — the service's own normalisation, so an
 * empty `DEBUGGEN_HOME=` means "use the default" on both sides.
 */
function settingValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Whether a POSIX-spelled path is a usable absolute root: POSIX-absolute or drive-rooted, never UNC. */
function isUsableAbsoluteRoot(posix: string): boolean {
  if (posix.startsWith(UNC_PREFIX) || posix.includes('\0')) {
    return false;
  }
  return isAbsolutePosix(posix) || WINDOWS_DRIVE_ROOTED.test(posix);
}

/**
 * The home directory `~` expands against, or `undefined` when none can be
 * determined: the injected one first, `os.homedir()` second (which consults the
 * password database on some systems and can throw there). The result must be
 * an absolute root, so an empty or relative home can never place the state
 * directory relative to the working directory.
 */
function resolveUserHome(injected: string | undefined): string | undefined {
  let raw = settingValue(injected);
  if (raw === undefined) {
    try {
      raw = settingValue(homedir());
    } catch {
      // Indeterminable: reported by the caller against the setting that needed it.
      return undefined;
    }
  }
  if (raw === undefined) {
    return undefined;
  }
  const posix = toPosix(raw);
  return isUsableAbsoluteRoot(posix) ? normalizePosix(posix) : undefined;
}

/** The failure for a `DEBUGGEN_HOME` value that cannot be used. The value itself is not echoed. */
function invalidHome(problem: string, source: string): DebuggenError {
  return new DebuggenError(
    REASON_CODES['home-invalid'],
    `${source} is not usable as the Debug Generator state directory: ${problem}.`,
    {
      hint: DEBUGGEN_HOME_HINT,
      details: { reason: 'home-invalid', setting: source, problem },
    },
  );
}

/**
 * Resolves the product's state directory, `$DEBUGGEN_HOME`, by the rules the
 * service applies in `apps/local-service/src/config.ts` (AAP §0.4.2, §0.5.6),
 * so the editor reads `auth.json` from exactly where the service writes it:
 *
 * | Value | Result |
 * | --- | --- |
 * | unset or blank | `~/.debuggen` |
 * | `~` / `~/x` | the account's home directory / `<home>/x` |
 * | an absolute POSIX path, or a drive-rooted Windows path (`C:\x`) | itself, normalised |
 * | `~other/x`, a relative path, a drive-relative path, a UNC path, a NUL | refused |
 *
 * Read at call time from `options.env` (default `process.env`), never at module
 * load, so the extension-host suites' throwaway `DEBUGGEN_HOME` is honoured.
 * The result is absolute and spelled with forward slashes, the service's own
 * spelling, which Node's filesystem calls accept on every platform.
 *
 * @param options An injectable environment, home directory or explicit override.
 * @returns The absolute state directory, or a `CONFIG_INVALID` failure with
 * reason `home-invalid`.
 */
export function resolveDebuggenHome(
  options: DebuggenHomeOptions = {},
): Result<string, DebuggenError> {
  const override = settingValue(options.debuggenHome);
  const fromEnv = settingValue((options.env ?? process.env)[DEBUGGEN_HOME_ENV]);
  const source = override === undefined ? DEBUGGEN_HOME_ENV : 'The configured state directory';
  const configured = override ?? fromEnv ?? DEFAULT_DEBUGGEN_HOME;
  const posix = toPosix(configured);

  if (posix.includes('\0')) {
    return err(invalidHome('the value contains a NUL character', source));
  }

  if (posix === HOME_MARKER || posix.startsWith(HOME_PREFIX)) {
    const home = resolveUserHome(options.homeDir);
    if (home === undefined) {
      return err(
        invalidHome(
          `it starts with '${HOME_MARKER}', and the home directory of this account could not be determined`,
          source,
        ),
      );
    }
    return ok(posix === HOME_MARKER ? home : joinPosix(home, posix.slice(HOME_PREFIX.length)));
  }

  if (posix.startsWith(HOME_MARKER)) {
    return err(
      invalidHome('a home-directory prefix naming another account is not supported', source),
    );
  }
  if (posix.startsWith(UNC_PREFIX)) {
    return err(invalidHome('a UNC path is not supported as a directory root', source));
  }
  if (isUsableAbsoluteRoot(posix)) {
    return ok(normalizePosix(posix));
  }
  if (isWindowsAbsolute(posix)) {
    return err(invalidHome('a drive-relative Windows path is not absolute', source));
  }
  return err(invalidHome('the value is not an absolute path', source));
}

/**
 * The editor credential's path, `<$DEBUGGEN_HOME>/auth.json` — the one place
 * the extension derives it, so `process.ts`, `client.ts` and the suites agree.
 *
 * @param options As for {@link resolveDebuggenHome}.
 * @returns The absolute path, or the failure {@link resolveDebuggenHome} reported.
 */
export function resolveAuthFilePath(
  options: DebuggenHomeOptions = {},
): Result<string, DebuggenError> {
  const paths = resolveEditorCredentialPaths(options);
  return isErr(paths) ? paths : ok(paths.value.authFilePath);
}

/**
 * Both derived paths at once: the state directory and the credential file.
 *
 * @param options As for {@link resolveDebuggenHome}.
 * @returns The paths, or the failure {@link resolveDebuggenHome} reported.
 */
export function resolveEditorCredentialPaths(
  options: DebuggenHomeOptions = {},
): Result<EditorCredentialPaths, DebuggenError> {
  const home = resolveDebuggenHome(options);
  if (isErr(home)) {
    return home;
  }
  return ok(
    Object.freeze({
      debuggenHome: home.value,
      authFilePath: joinPosix(home.value, AUTH_FILE_NAME),
    }),
  );
}

// ---------------------------------------------------------------------------
// The record format (pure)
// ---------------------------------------------------------------------------

/**
 * Whether `value` could be an editor credential: a string of
 * {@link MIN_EDITOR_CREDENTIAL_LENGTH}–{@link MAX_EDITOR_CREDENTIAL_LENGTH}
 * printable ASCII characters with no space or comma, so it can travel in a
 * bearer header and in `client.hello` unchanged.
 *
 * @param value Any value, typically the `token` of a parsed `auth.json`.
 * @returns `true` when the value is a plausible credential.
 */
export function isPlausibleEditorCredential(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_EDITOR_CREDENTIAL_LENGTH &&
    value.length <= MAX_EDITOR_CREDENTIAL_LENGTH &&
    CREDENTIAL_CHARACTERS.test(value)
  );
}

/**
 * Serialises an `auth.json` record exactly as the service does:
 * `{ version, token, issuedAt }`, two-space JSON, trailing newline. No other key
 * is written, because the service's schema is strict and replaces a file that
 * carries one.
 *
 * @param token The credential. ⚠️ The returned text contains it in plaintext;
 * it is written to `auth.json` and nowhere else.
 * @param issuedAt Epoch milliseconds; truncated to a non-negative integer.
 * @returns The file content.
 */
export function formatEditorCredentialRecord(token: string, issuedAt: number): string {
  const record = {
    version: AUTH_FILE_VERSION,
    token,
    issuedAt: Number.isFinite(issuedAt) ? Math.max(0, Math.trunc(issuedAt)) : 0,
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Extracts the credential from `auth.json` content, tolerantly: only a
 * plausible string `token` is required, and unknown keys, a missing `version`
 * and a `role` are accepted, because the service owns the format.
 *
 * The failure is an enumerated problem and never a fragment of the content, so
 * it can be logged and shown without echoing a byte of the file.
 *
 * @param content The file's bytes, or its text. A leading byte-order mark is ignored.
 * @returns The token, or the problem that makes the content unusable.
 */
export function parseEditorCredentialRecord(
  content: string | Uint8Array,
): Result<string, EditorCredentialRecordProblem> {
  const size = typeof content === 'string' ? content.length : content.byteLength;
  if (size > MAX_AUTH_FILE_BYTES) {
    return err('too-large');
  }
  const text = (
    typeof content === 'string' ? content : Buffer.from(content).toString('utf8')
  ).replace(BYTE_ORDER_MARK, '');
  if (text.trim().length === 0) {
    return err('empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err('not-json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err('not-an-object');
  }
  if (!('token' in parsed)) {
    return err('no-token');
  }
  const token: unknown = parsed.token;
  return isPlausibleEditorCredential(token) ? ok(token) : err('invalid-token');
}

/** A mode rendered the way a developer types it into `chmod`. */
function octal(mode: number): string {
  return (mode & PERMISSION_BITS).toString(8).padStart(3, '0');
}

/**
 * The fields a log line about the editor credential carries — and the only
 * place such fields are built, so "the token is never logged" is checkable by
 * reading this function: the token contributes a length category and nothing
 * else.
 *
 * @param token The credential; only its length is inspected.
 * @param authFilePath The credential file's path.
 * @param mode The file's mode; defaults to {@link SECURE_FILE_MODE}.
 * @returns `{ path, mode, length }`.
 */
export function describeCredentialForLog(
  token: string,
  authFilePath: string,
  mode: number = SECURE_FILE_MODE,
): CredentialLogFields {
  return Object.freeze({
    path: authFilePath,
    mode: octal(mode),
    length: token.length === EDITOR_CREDENTIAL_STANDARD_LENGTH ? 'standard' : 'nonstandard',
  });
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** The filesystem step a caught failure came from, which decides its reason. */
type FsOperation = 'inspect' | 'read' | 'prepare' | 'create';

/** What each {@link FsOperation} is called in a message: "could not be …". */
const OPERATION_VERBS: Readonly<Record<FsOperation, string>> = Object.freeze({
  inspect: 'inspected',
  read: 'read',
  prepare: 'given a private directory',
  create: 'created',
});

/**
 * The errno code of a caught value, when it carries one. Only the code is ever
 * read off a caught value, never its message.
 */
function errnoCodeOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code: unknown = value.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Whether this host enforces POSIX ownership and permission bits. */
function isPosixHost(): boolean {
  return typeof process.getuid === 'function';
}

/**
 * Builds a failure of this module: the reason's closed code, a message and a
 * hint that name paths and modes only, and `details` carrying the reason and
 * the credential file's path. No token and no file content ever reach it.
 */
function credentialFailure(
  reason: EditorCredentialFailureReason,
  message: string,
  hint: string,
  paths: EditorCredentialPaths,
  extra: LogFields = {},
  cause?: unknown,
): DebuggenError {
  return new DebuggenError(REASON_CODES[reason], message, {
    hint,
    details: { ...extra, reason, path: paths.authFilePath },
    cause,
  });
}

/** The failure for "no `auth.json` yet": the service has not started. */
function missingCredential(paths: EditorCredentialPaths): DebuggenError {
  return credentialFailure(
    'missing',
    `No editor credential exists at ${paths.authFilePath} yet.`,
    'Start the Debug Generator service ("Debug Generator: Start Local Service"); it writes this file when it first starts.',
    paths,
  );
}

/** The failure for a file that holds no usable record. Names the problem, never the content. */
function malformedCredential(
  paths: EditorCredentialPaths,
  problem: EditorCredentialRecordProblem,
): DebuggenError {
  return credentialFailure(
    'malformed',
    `The editor credential file ${paths.authFilePath} does not hold a usable credential record.`,
    `Delete ${paths.authFilePath} and restart the Debug Generator service.`,
    paths,
    { problem },
  );
}

/** The failure for a file other accounts can read: its token may have been read, so it is not used. */
function exposedCredential(paths: EditorCredentialPaths, mode: number): DebuggenError {
  return credentialFailure(
    'exposed',
    `The editor credential file ${paths.authFilePath} has mode ${octal(mode)}, which lets other accounts read it, so its credential is not trusted.`,
    'Restart the Debug Generator service: it replaces a credential file other accounts could read with a new, private one.',
    paths,
    { mode: octal(mode), expectedMode: octal(SECURE_FILE_MODE) },
  );
}

/**
 * Classifies a failure caught from a `@debuggen/shared/node` call.
 *
 * A policy refusal (`FS_UNSAFE_PATH`) keeps its own message and hint — they
 * name the offending path and mode, never content — and is re-coded with
 * reason `unsafe-path`, the policy's own reason moving to `details.policy`.
 * An errno becomes `unsafe-path` (a link at the final component), `home-invalid`
 * (a file where a directory of `DEBUGGEN_HOME` should be) or, by step,
 * `unreadable` / `write-failed`.
 */
function fsFailure(
  cause: unknown,
  operation: FsOperation,
  paths: EditorCredentialPaths,
): DebuggenError {
  const subject = `The editor credential file ${paths.authFilePath}`;

  if (DebuggenError.is(cause)) {
    if (cause.code === 'FS_UNSAFE_PATH') {
      return credentialFailure(
        'unsafe-path',
        cause.message,
        cause.hint ?? PRIVATE_HOME_HINT,
        paths,
        { policy: cause.details?.reason, offendingPath: cause.details?.path, operation },
        cause,
      );
    }
    return credentialFailure(
      'internal',
      `${subject} could not be ${OPERATION_VERBS[operation]}.`,
      PRIVATE_HOME_HINT,
      paths,
      { operation, errorCode: cause.code },
      cause,
    );
  }

  const errno = errnoCodeOf(cause);
  const errnoDetails: LogFields = errno === undefined ? { operation } : { operation, errno };

  if (errno === 'ELOOP') {
    return credentialFailure(
      'unsafe-path',
      `${subject} is a symbolic link, so it was not followed.`,
      'Remove the link; the Debug Generator service writes a private file in its place when it starts.',
      paths,
      errnoDetails,
      cause,
    );
  }
  if (errno === 'ENOTDIR' || (operation === 'prepare' && errno === 'EEXIST')) {
    return credentialFailure(
      'home-invalid',
      `A component of the Debug Generator state directory ${paths.debuggenHome} exists but is not a directory.`,
      DEBUGGEN_HOME_HINT,
      paths,
      errnoDetails,
      cause,
    );
  }

  const writing = operation === 'prepare' || operation === 'create';
  const suffix = errno === undefined ? '' : ` (${errno})`;
  return credentialFailure(
    writing ? 'write-failed' : 'unreadable',
    `${subject} could not be ${OPERATION_VERBS[operation]}${suffix}.`,
    writing
      ? 'Check that $DEBUGGEN_HOME is a private directory this account can write to, and that the disk is not full.'
      : PRIVATE_HOME_HINT,
    paths,
    errnoDetails,
    cause,
  );
}

/** The failure for anything this module did not anticipate, so no promise here ever rejects. */
function unexpectedFailure(cause: unknown): DebuggenError {
  return new DebuggenError(
    REASON_CODES.internal,
    'The editor credential could not be loaded because of an unexpected failure.',
    { hint: PRIVATE_HOME_HINT, details: { reason: 'internal' }, cause },
  );
}

// ---------------------------------------------------------------------------
// The filesystem layer (synchronous, like the primitives it composes)
// ---------------------------------------------------------------------------

/** A successful read: the token and the mode the file was found with. */
interface CredentialFileContents {
  readonly token: string;
  readonly mode: number;
}

/**
 * Reads `auth.json` under the same policy the service applies before it
 * adopts the file: the state directory is private and owned; the entry is a
 * regular, single-link file owned by this account and not a link; its mode
 * grants no group or other access; its content holds a plausible token.
 */
function readCredentialFile(
  paths: EditorCredentialPaths,
): Result<CredentialFileContents, DebuggenError> {
  try {
    assertSecureDir(paths.debuggenHome);
  } catch (cause) {
    // No state directory means no credential: the service has never started here.
    return err(
      errnoCodeOf(cause) === 'ENOENT'
        ? missingCredential(paths)
        : fsFailure(cause, 'inspect', paths),
    );
  }

  let state;
  try {
    state = inspectPrivateFileNoFollow(paths.authFilePath);
  } catch (cause) {
    return err(fsFailure(cause, 'inspect', paths));
  }
  if (state === undefined) {
    return err(missingCredential(paths));
  }
  if (isPosixHost() && (state.mode & GROUP_AND_OTHER_BITS) !== 0) {
    return err(exposedCredential(paths, state.mode));
  }

  let bytes: Buffer;
  try {
    bytes = readFileNoFollow(paths.authFilePath);
  } catch (cause) {
    return err(
      errnoCodeOf(cause) === 'ENOENT' ? missingCredential(paths) : fsFailure(cause, 'read', paths),
    );
  }

  const parsed = parseEditorCredentialRecord(bytes);
  if (isErr(parsed)) {
    return err(malformedCredential(paths, parsed.error));
  }
  return ok({ token: parsed.value, mode: state.mode });
}

/**
 * Creates the state directory `0700` when it does not exist, and verifies it
 * when it does — bounded by the state root, exactly as the service's start-up
 * does, so an existing directory is judged and never re-moded. When the
 * directory's own parent is missing too, the unbounded form creates every
 * missing ancestor `0700` after checking that the existing prefix contains no
 * symbolic link.
 */
function prepareStateDirectory(paths: EditorCredentialPaths): Result<void, DebuggenError> {
  try {
    ensureSecureDir(paths.debuggenHome, { upTo: paths.debuggenHome });
    return ok(undefined);
  } catch (cause) {
    if (errnoCodeOf(cause) !== 'ENOENT') {
      return err(fsFailure(cause, 'prepare', paths));
    }
  }
  try {
    ensureSecureDir(paths.debuggenHome);
    return ok(undefined);
  } catch (cause) {
    return err(fsFailure(cause, 'prepare', paths));
  }
}

/** Waits `ms`, or less when any signal aborts; resolves `true` only when the full wait elapsed. */
function delay(ms: number, signals: readonly AbortSignal[]): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signals.some((signal) => signal.aborted)) {
      resolve(false);
      return;
    }
    // The timer is armed before the listeners: nothing can abort a signal
    // between the check above and this point, because both run in one turn.
    const timer = setTimeout(() => {
      detach();
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      detach();
      resolve(false);
    };
    const detach = (): void => {
      for (const signal of signals) {
        signal.removeEventListener('abort', onAbort);
      }
    };
    for (const signal of signals) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** A finite number within `[min, max]`, or `fallback` when none was given. */
function boundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * The file-backed {@link EditorCredentialStore}. Kept private: callers depend
 * on the interface and obtain an instance from
 * {@link createEditorCredentialStore}.
 */
class FileEditorCredentialStore implements EditorCredentialStore {
  /** Where `DEBUGGEN_HOME` comes from; resolved again on every operation. */
  readonly #homeOptions: DebuggenHomeOptions;

  readonly #logger: Logger;

  readonly #randomBytes: (size: number) => Uint8Array;

  readonly #now: () => number;

  /** The last token read successfully from `auth.json`. ⚠️ Plaintext; never logged. */
  #token: string | undefined;

  /**
   * Aborted by {@link FileEditorCredentialStore.dispose} to cancel every wait
   * in flight, then replaced, so a wait started later is unaffected.
   */
  #disposal = new AbortController();

  constructor(options: EditorCredentialStoreOptions) {
    this.#homeOptions = Object.freeze({
      env: options.env,
      homeDir: options.homeDir,
      debuggenHome: options.debuggenHome,
    });
    this.#logger = (options.logger ?? noopLogger).child({ subsystem: 'editor-credential' });
    this.#randomBytes = options.randomBytes ?? ((size: number) => cryptoRandomBytes(size));
    this.#now = options.now ?? nowEpochMs;
  }

  paths(): Result<EditorCredentialPaths, DebuggenError> {
    return resolveEditorCredentialPaths(this.#homeOptions);
  }

  read(): Promise<Result<string, DebuggenError>> {
    return this.#settle(() => this.#reported(this.#readNow()));
  }

  async ensure(): Promise<Result<string, DebuggenError>> {
    try {
      const paths = this.paths();
      if (isErr(paths)) {
        return this.#reported(this.#cleared(paths));
      }

      for (let attempt = 1; ; attempt += 1) {
        const created = this.#createIfAbsent(paths.value);
        if (isErr(created)) {
          return this.#reported(this.#cleared(created));
        }

        const read = this.#readAt(paths.value);
        const reason = isErr(read) ? editorCredentialFailureReason(read.error) : undefined;
        if (
          !isErr(read) ||
          reason === undefined ||
          !SETTLING_REASONS.has(reason) ||
          attempt >= ENSURE_SETTLE_ATTEMPTS
        ) {
          return this.#reported(read);
        }
        // Another writer created the file an instant ago and is still filling
        // it, or it vanished after the refused create: settle, then try again.
        await delay(ENSURE_SETTLE_DELAY_MS, []);
      }
    } catch (cause) {
      return this.#reported(this.#cleared(err(unexpectedFailure(cause))));
    }
  }

  token(): string | undefined {
    return this.#token;
  }

  refresh(): Promise<Result<string, DebuggenError>> {
    this.invalidate();
    return this.read();
  }

  async waitForCredential(
    options: WaitForCredentialOptions = {},
  ): Promise<Result<string, DebuggenError>> {
    try {
      const paths = this.paths();
      if (isErr(paths)) {
        return this.#reported(this.#cleared(paths));
      }

      const timeoutMs = boundedNumber(
        options.timeoutMs,
        DEFAULT_CREDENTIAL_WAIT_TIMEOUT_MS,
        0,
        MAX_CREDENTIAL_WAIT_TIMEOUT_MS,
      );
      const intervalMs = boundedNumber(
        options.intervalMs,
        DEFAULT_CREDENTIAL_POLL_INTERVAL_MS,
        MIN_CREDENTIAL_POLL_INTERVAL_MS,
        MAX_CREDENTIAL_POLL_INTERVAL_MS,
      );
      const signals =
        options.signal === undefined
          ? [this.#disposal.signal]
          : [options.signal, this.#disposal.signal];
      const deadline = this.#now() + timeoutMs;

      for (;;) {
        if (signals.some((signal) => signal.aborted)) {
          return this.#reported(this.#cleared(err(this.#aborted(paths.value))));
        }

        const read = this.#readAt(paths.value);
        if (!isErr(read)) {
          return read;
        }
        const reason = editorCredentialFailureReason(read.error);
        if (reason === undefined || !WAITABLE_REASONS.has(reason)) {
          // Nothing a starting service writes can repair this one.
          return this.#reported(read);
        }

        const remaining = deadline - this.#now();
        if (remaining <= 0) {
          return this.#reported(this.#cleared(err(this.#timedOut(paths.value, timeoutMs, reason))));
        }
        if (!(await delay(Math.min(intervalMs, remaining), signals))) {
          return this.#reported(this.#cleared(err(this.#aborted(paths.value))));
        }
      }
    } catch (cause) {
      return this.#reported(this.#cleared(err(unexpectedFailure(cause))));
    }
  }

  invalidate(): void {
    this.#token = undefined;
  }

  dispose(): void {
    this.invalidate();
    this.#disposal.abort();
    this.#disposal = new AbortController();
  }

  /* ---------------------------------------------------------------------- */

  /** Resolves the paths and reads the file, caching or clearing the token. */
  #readNow(): Result<string, DebuggenError> {
    const paths = this.paths();
    return isErr(paths) ? this.#cleared(paths) : this.#readAt(paths.value);
  }

  /**
   * One read of `auth.json`. The cache mirrors its outcome: set on success,
   * cleared on failure, so a credential that can no longer be confirmed on disk
   * is never presented. Failures are not logged here; the public operation
   * reports its final outcome once.
   */
  #readAt(paths: EditorCredentialPaths): Result<string, DebuggenError> {
    const contents = readCredentialFile(paths);
    if (isErr(contents)) {
      return this.#cleared(contents);
    }
    this.#token = contents.value.token;
    this.#logger.debug(
      'editor credential read',
      describeCredentialForLog(contents.value.token, paths.authFilePath, contents.value.mode),
    );
    return ok(contents.value.token);
  }

  /**
   * Creates `auth.json` with a fresh credential unless something already
   * occupies the path — never replacing it. `exists` covers a file written by
   * the service or another editor window, and a planted link, which the read
   * that follows refuses.
   */
  #createIfAbsent(paths: EditorCredentialPaths): Result<'created' | 'exists', DebuggenError> {
    const prepared = prepareStateDirectory(paths);
    if (isErr(prepared)) {
      return prepared;
    }
    const minted = this.#mint(paths);
    if (isErr(minted)) {
      return minted;
    }

    try {
      createFileExclusive(
        paths.authFilePath,
        formatEditorCredentialRecord(minted.value, this.#now()),
        { mode: SECURE_FILE_MODE, upTo: paths.debuggenHome },
      );
    } catch (cause) {
      if (errnoCodeOf(cause) === 'EEXIST') {
        return ok('exists');
      }
      return err(fsFailure(cause, 'create', paths));
    }

    this.#logger.info(
      'editor credential created',
      describeCredentialForLog(minted.value, paths.authFilePath),
    );
    return ok('created');
  }

  /** A fresh credential: {@link EDITOR_CREDENTIAL_TOKEN_BYTES} CSPRNG bytes, base64url. */
  #mint(paths: EditorCredentialPaths): Result<string, DebuggenError> {
    let bytes: Uint8Array;
    try {
      bytes = this.#randomBytes(EDITOR_CREDENTIAL_TOKEN_BYTES);
    } catch (cause) {
      return err(
        credentialFailure(
          'internal',
          'A new editor credential could not be drawn from the random source.',
          'Restart VS Code; if this persists, the operating system random source is unavailable.',
          paths,
          { operation: 'mint' },
          cause,
        ),
      );
    }
    if (bytes.byteLength !== EDITOR_CREDENTIAL_TOKEN_BYTES) {
      return err(
        credentialFailure(
          'internal',
          'The random source returned the wrong number of bytes for a new editor credential.',
          'Restart VS Code; if this persists, the operating system random source is unavailable.',
          paths,
          { operation: 'mint', expectedBytes: EDITOR_CREDENTIAL_TOKEN_BYTES },
        ),
      );
    }
    return ok(Buffer.from(bytes).toString('base64url'));
  }

  #aborted(paths: EditorCredentialPaths): DebuggenError {
    return credentialFailure(
      'aborted',
      `Waiting for the editor credential at ${paths.authFilePath} was cancelled.`,
      'Start the Debug Generator service again when you need it.',
      paths,
    );
  }

  #timedOut(
    paths: EditorCredentialPaths,
    timeoutMs: number,
    lastReason: EditorCredentialFailureReason,
  ): DebuggenError {
    return credentialFailure(
      'timeout',
      `No usable editor credential appeared at ${paths.authFilePath} within ${String(timeoutMs)} ms.`,
      'Check that the Debug Generator service started; it writes this file before it begins serving.',
      paths,
      { timeoutMs, lastReason },
    );
  }

  /** Clears the cache and passes a failure through, for the early-return paths. */
  #cleared<F extends Err<DebuggenError>>(failure: F): F {
    this.#token = undefined;
    return failure;
  }

  /**
   * Logs the final outcome of a public operation when it failed: reason, code
   * and path only. `missing` and `aborted` are expected states — "Service not
   * running", a cancelled wait — and are logged at debug; everything else at
   * warn.
   */
  #reported(result: Result<string, DebuggenError>): Result<string, DebuggenError> {
    if (isErr(result)) {
      const reason = editorCredentialFailureReason(result.error) ?? 'internal';
      const fields: LogFields = {
        reason,
        errorCode: result.error.code,
        path: result.error.details?.path,
      };
      if (reason === 'missing' || reason === 'aborted') {
        this.#logger.debug('editor credential unavailable', fields);
      } else {
        this.#logger.warn('editor credential unusable', fields);
      }
    }
    return result;
  }

  /** Runs a synchronous operation as a promise that never rejects. */
  #settle(operation: () => Result<string, DebuggenError>): Promise<Result<string, DebuggenError>> {
    try {
      return Promise.resolve(operation());
    } catch (cause) {
      return Promise.resolve(this.#reported(this.#cleared(err(unexpectedFailure(cause)))));
    }
  }
}

/**
 * Creates the extension host's holder of the editor credential (AAP §0.5.6):
 * the reader of `$DEBUGGEN_HOME/auth.json`, and its creator when the extension
 * starts the service.
 *
 * Construction does no I/O and reads no environment variable; every operation
 * resolves `DEBUGGEN_HOME` afresh from `options`.
 *
 * @example
 * ```ts
 * const credential = createEditorCredentialStore({ logger });
 * context.subscriptions.push(credential);
 * const http = new HttpClient({ baseUrl, token: asTokenProvider(credential) });
 * const ready = await credential.ensure(); // before spawning the service
 * ```
 *
 * @param options Injectable environment, home directory, logger, random source and clock.
 * @returns A store whose asynchronous members never reject.
 */
export function createEditorCredentialStore(
  options: EditorCredentialStoreOptions = {},
): EditorCredentialStore {
  return new FileEditorCredentialStore(options);
}

/**
 * The store's token getter in the shape the protocol clients take as their
 * lazy `TokenProvider`: re-read on every request and every handshake, so a
 * refreshed credential takes effect without rebuilding the client.
 *
 * @param store The credential store, or anything exposing its `token()`.
 * @returns A getter returning the cached token, or `undefined` before the first read.
 */
export function asTokenProvider(
  store: Pick<EditorCredentialStore, 'token'>,
): () => string | undefined {
  return () => store.token();
}
