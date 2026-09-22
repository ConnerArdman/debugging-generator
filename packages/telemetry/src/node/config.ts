/**
 * The environment contract of the Node **dev-server preload**, and the one
 * place that decides whether the preload does anything at all.
 *
 * `packages/telemetry/esbuild.node.mjs` bundles `src/node/register.ts` into
 * `dist/node/register.mjs`, and the local service's launcher (or
 * `scripts/dev-instrumented.mjs`) attaches that artefact to the developer's own
 * `next dev` process with `NODE_OPTIONS=--import <file:// URL>`. Nothing in the
 * target project is edited to make that happen: the server tier's spans exist
 * because a module was loaded into the process, which is why the AAP calls this
 * signal a runtime hook rather than a patch (AAP §0.5.1).
 *
 * This module is the foundation of the `src/node` subtree. Every sibling —
 * `span-helper.ts`, `convert.ts`, `exporter.ts`, `control.ts`, `register.ts` —
 * imports it, and it imports nothing from the subtree, so the import graph here
 * has a single root and no cycle to reason about.
 *
 * ## The three variables, and nothing else
 *
 * The launcher injects exactly three variables per process. They are
 * deliberately **absent from `.env.example`** (AAP §0.3.4): they are not
 * developer configuration, they are the per-launch wiring of one dev server to
 * one session.
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `DEBUGGEN_INGEST_URL` | the **complete** ingest endpoint, `{serviceBase}/telemetry/ingest` |
 * | `DEBUGGEN_TOKEN` | the server-agent bearer credential, scoped to one project root, expiring with this process (AAP §0.5.6) |
 * | `DEBUGGEN_PROJECT_ROOT` | the absolute path of the launched project; every ingest body carries it, and the service accepts ingest only for the credential's project |
 *
 * ⚠️ **`DEBUGGEN_INGEST_URL` is an endpoint, not a base URL.** It already ends
 * in `/telemetry/ingest` — `scripts/dev-instrumented.mjs` builds it as
 * `` `${base}${INGEST_PATH}` `` — so appending a path to it produces a URL that
 * 404s on every batch. The failure is invisible until an end-to-end test looks
 * for server spans that never arrived, which is why {@link PreloadConfig.ingestUrl}
 * is documented as the POST target verbatim.
 *
 * There is **no variable for the control WebSocket**. The preload's control
 * channel (`client.hello`, then `server-agent.config`) is derived from the
 * ingest endpoint's origin by {@link deriveControlUrl}: same host and port,
 * `http:` → `ws:`, `https:` → `wss:`, path {@link CONTROL_PATH}. That mapping is
 * expressed here once and nowhere else.
 *
 * ## Inert is a normal state, not a failure
 *
 * A developer can have this module attached with no session running — the
 * artefact stays on `NODE_OPTIONS` until they restart the server, and
 * `--spawn-local` deliberately runs without a credential. In that case
 * {@link loadPreloadConfig} returns `{ mode: 'inert' }` and the preload installs
 * nothing: no tracer provider, no instrumentation, no exporter, no timers. It
 * never throws, for any input, because a thrown error inside `--import` takes
 * the developer's dev server down with it. A working dev server with no
 * telemetry is the correct outcome; a broken dev server never is.
 *
 * ## Privacy
 *
 * This is the only place the server-agent credential enters the process, so the
 * rule is absolute: **a credential value is never logged, printed, persisted,
 * interpolated into a message or attached to an error.** Every inert `reason`
 * this module produces names *variables*, never values —
 * `scripts/check-secrets.mjs` is a blocking gate, and a token in a dev-server
 * terminal survives in scrollback long after the process it belonged to.
 * An ingest URL that embeds credentials (a `user:password@` userinfo component
 * ahead of the host) is refused outright rather than carried around, which is
 * what lets `exporter.ts` and `control.ts` treat {@link PreloadConfig.ingestUrl}
 * and {@link PreloadConfig.controlUrl} as safe to print.
 *
 * The same rule decides *where* the credential may go at all. An environment
 * variable is set by whatever started the process, so the endpoint is checked
 * rather than believed: the local service is a loopback service (AAP §0.5.6),
 * and {@link isTrustedServiceEndpoint} refuses anything else — public, LAN or
 * wildcard host, `http:` or `https:` alike. That check happens here, before a
 * control URL is derived, so neither outbound path can reach an origin this
 * module did not accept.
 *
 * ## Notes for the siblings that import this
 *
 * - **No `Origin` header.** The service rejects any HTTP request or WebSocket
 *   upgrade whose `Origin` is an `http:`/`https:` web origin and accepts an
 *   absent `Origin` from Node clients (AAP §0.5.6). The preload is a Node
 *   client: it sends `Authorization: Bearer …` and sets no `Origin`. Adding one
 *   would get every batch rejected.
 * - **One producer id per process.** {@link PRODUCER_ID} is minted at module
 *   load and is the scope of the `seq` counter every event carries; see its own
 *   documentation for why a second id would corrupt trace ordering.
 * - **The tunables below are the vocabulary.** `exporter.ts` and `control.ts`
 *   take their batch sizes, timeouts and backoff from the constants here rather
 *   than inventing numbers, so the two agree and a change is a one-line change.
 *
 * @example Deciding whether to install anything
 * ```ts
 * const result = loadPreloadConfig();
 * if (result.mode === 'inert') {
 *   createPreloadLogger().debug('preload inert', { reason: result.reason });
 * } else {
 *   install(result.config); // ingestUrl, controlUrl, token, projectRoot, …
 * }
 * ```
 */

import {
  basenamePosix,
  createConsoleLogger,
  isAbsolutePosix,
  LOG_LEVELS,
  newProducerId,
  noopLogger,
  toPosix,
} from '@debuggen/shared';
import type { Logger, LogLevelSetting, ProducerId } from '@debuggen/shared';

/**
 * The names of the three variables the launcher injects, plus the one optional
 * variable this module reads.
 *
 * Held in a frozen record rather than as four loose string constants because
 * every one of them appears twice — once to read the environment and once to
 * name the offending variable in an inert {@link PreloadConfigResult.reason} —
 * and a typo in the second occurrence would produce a diagnostic that sends a
 * developer to the wrong variable.
 *
 * `logLevel` is `DEBUGGEN_LOG_LEVEL`, which *is* documented in `.env.example`:
 * it is ordinary developer configuration shared with the local service, not
 * per-launch wiring, and it is optional everywhere.
 */
export const PRELOAD_ENV_KEYS = Object.freeze({
  /** Complete ingest endpoint; see this module's overview for the trap. */
  ingestUrl: 'DEBUGGEN_INGEST_URL',
  /** Server-agent bearer credential. Never logged, never printed. */
  token: 'DEBUGGEN_TOKEN',
  /** Absolute path of the launched project. */
  projectRoot: 'DEBUGGEN_PROJECT_ROOT',
  /** Optional logging threshold, spelled as in `.env.example`. */
  logLevel: 'DEBUGGEN_LOG_LEVEL',
} as const);

/**
 * Path of the local service's WebSocket endpoint, appended to the ingest
 * endpoint's origin by {@link deriveControlUrl}.
 *
 * The service mounts its `ws` server on the same HTTP server as its routes, at
 * `/ws` (AAP §0.4.2, §0.7.1 Group 2), so the control socket needs no variable of
 * its own — only this constant and the origin the launcher already told us
 * about.
 */
export const CONTROL_PATH = '/ws';

/**
 * Instrumentation-scope name passed to `trace.getTracer(…)` by
 * `span-helper.ts` and recorded on the OpenTelemetry resource by `register.ts`.
 *
 * It identifies *this* library as the producer of a span, which is how a
 * developer reading raw OpenTelemetry output tells a span the preload created
 * from one Next.js created. Both call sites read it from here so they cannot
 * disagree: a tracer is keyed by `(name, version)`, and two spellings would
 * silently produce two tracers.
 */
export const TRACER_NAME = '@debuggen/telemetry';

/**
 * Version half of the tracer identity, kept in step with this package's
 * `package.json` version by hand.
 *
 * Deliberately a literal rather than a `package.json` import: `resolveJsonModule`
 * would add a bundle input to an artefact that must stay a single file, and the
 * value is advisory metadata on a span — not something any behaviour branches
 * on.
 */
export const TRACER_VERSION = '0.1.0';

/**
 * The version of **the protocol**, which is what every client puts in the
 * `client.hello` frame's `version` field (AAP §0.4.2).
 *
 * ⚠️ This is **not** {@link TRACER_VERSION}, and the two must never be
 * substituted for one another. `TRACER_VERSION` is this npm package's version
 * and belongs to OpenTelemetry scope and resource metadata; this constant is
 * what the four cooperating processes have agreed to say to one another, and
 * the service compares its **major** component (`isCompatibleProtocolVersion`
 * in `packages/protocol/src/version.ts`) before it will send configuration.
 * Announcing a package version here makes the service read major `0` against
 * its own major `1` and refuse the handshake, so the preload connects, is
 * closed, and never receives `server-agent.config` — no server or database
 * spans, with nothing in the developer's terminal explaining why.
 *
 * ## Why it is mirrored rather than imported
 *
 * `PROTOCOL_VERSION` in `packages/protocol/src/version.ts` is the same string,
 * and that module is its owner. This package cannot import it: `@debuggen/protocol`
 * **depends on** `@debuggen/telemetry` (its `telemetry.event` payloads embed
 * `TelemetryEventIngress`, and its `epochMsSchema` imports our epoch bounds),
 * so the reverse import would close a cycle in the workspace graph — which is
 * why `eslint.config.js` restricts this package to `@debuggen/shared` among
 * `@debuggen/*`. AAP §0.2.2 puts `protocol` above `telemetry` for exactly this
 * reason, and `control.ts` mirrors the frame *shapes* for the same one.
 *
 * So the value is mirrored here, once, where `control.ts` can reach it — and
 * the mirror is checked rather than trusted: `./config.test.ts` reads
 * `packages/protocol/src/version.ts` and fails if the two strings drift apart.
 * A protocol bump is therefore two edits and one failing test until both land.
 */
export const WIRE_PROTOCOL_VERSION = '1.0.0';

/**
 * `service.name` used when {@link PreloadConfig.serviceName} cannot be derived
 * from the project root — a root that normalises to nothing usable, such as a
 * filesystem root or a bare Windows drive.
 *
 * OpenTelemetry treats a missing `service.name` as `unknown_service`, which in a
 * developer's own dev server tells them nothing about where a span came from.
 * A stable, obviously-ours fallback is more useful than an anonymous one.
 */
export const SERVICE_NAME_FALLBACK = 'debuggen-target';

/**
 * `name` bound on every record from {@link createPreloadLogger}, and therefore
 * the `[debuggen-preload]` prefix the default console sink writes.
 *
 * This output lands in the developer's own dev-server terminal, interleaved with
 * their application's logs. The prefix is how they can tell at a glance that a
 * line is ours and not theirs.
 */
export const PRELOAD_LOGGER_NAME = 'debuggen-preload';

/**
 * Threshold {@link createPreloadLogger} uses when no level is requested.
 *
 * `warn` rather than `info`: we are a guest in someone else's terminal, so only
 * a degraded condition (a signal that could not be enabled, a rejected batch)
 * earns a line. A developer who wants the detail sets `DEBUGGEN_LOG_LEVEL`,
 * exactly as they would for the local service.
 */
export const DEFAULT_PRELOAD_LOG_LEVEL: LogLevelSetting = 'warn';

/**
 * This process's telemetry producer id, minted **once, at module load**.
 *
 * Its stability is a correctness requirement, not a convenience. AAP §0.2.3
 * defines `producerId` as a random id the agent or the preload generates per
 * page document / per process, and scopes the monotonic `seq` counter every
 * event carries to `(producerId, captureId)`. `(producerId, seq)` is in turn a
 * tie-breaker in the canonical ordering of a trace — parent before child, then
 * `startTime`, then `(producerId, seq)`, then the store-assigned ingest
 * sequence. Two ids inside one process would present as two producers whose
 * counters both start at 1, and the correlator would interleave their spans
 * arbitrarily whenever timestamps tied. So this is a module-level constant that
 * every sibling reads, and never a value anybody re-generates.
 *
 * Generated eagerly: it is one Web Crypto call, and the alternative (a lazy
 * getter) is a second code path that can be reached twice.
 *
 * It is minted even when {@link loadPreloadConfig} reports `inert`. An id costs
 * nothing, and an inert preload has nothing to report it on anyway.
 */
export const PRODUCER_ID: ProducerId = newProducerId();

/**
 * Events per ingest batch.
 *
 * A capture on a busy page produces spans in bursts — one request can yield a
 * server span, a route-handler span, several service-function spans and a query
 * span. Batching keeps that to one POST; 256 is large enough that a burst is a
 * single request and small enough that a batch stays a few tens of kilobytes,
 * which the loopback HTTP path handles without a streaming body.
 */
export const BATCH_MAX_EVENTS = 256;

/**
 * Milliseconds a partial batch waits before it is flushed anyway.
 *
 * The DevTools panel shows a live tail during capture, so latency is visible to
 * the developer: a second is short enough that events appear while they are
 * still interacting, and long enough that a quiet server is not posting empty-ish
 * batches in a tight loop.
 */
export const BATCH_FLUSH_INTERVAL_MS = 1_000;

/**
 * Hard cap on events held in memory while ingest is unavailable.
 *
 * The exporter buffers when the service is restarting or the socket is down. The
 * cap makes that bounded: at the limit the **oldest** events are dropped (the
 * newest are the ones a developer is currently reproducing) and the number of
 * drops is counted so the capture can be reported as incomplete rather than
 * silently thinned. 5 000 matches the browser agent's buffer ceiling in
 * AAP §0.5.5, so neither tier fails first for a reason the other does not share.
 */
export const MAX_BUFFERED_EVENTS = 5_000;

/**
 * Milliseconds an ingest POST may take before it is aborted and the batch is
 * re-buffered.
 *
 * The target is a loopback HTTP server, where a request that has not completed
 * in five seconds is not slow but stuck (the service is mid-restart, or the
 * socket is wedged). Aborting returns the batch to the buffer, which the backoff
 * below then retries; waiting indefinitely would stall the flush loop and turn a
 * transient failure into a lost capture.
 */
export const INGEST_TIMEOUT_MS = 5_000;

/**
 * Milliseconds allowed for the control socket's `client.hello` handshake.
 *
 * The service closes a connection that has not sent `client.hello` with its
 * token within **3 seconds** of the upgrade, using code 4401 (AAP §0.5.6).
 * Timing out just under that boundary means the preload notices its own failure
 * and reconnects on its own schedule, instead of being closed by the peer and
 * having to infer why.
 */
export const HELLO_TIMEOUT_MS = 2_500;

/**
 * First control-socket reconnect delay, in milliseconds.
 *
 * The service restarting under a developer's hands is the common case, so the
 * first retry is fast: half a second is imperceptible and usually sufficient.
 */
export const RECONNECT_MIN_MS = 500;

/**
 * Ceiling of the control-socket reconnect backoff, in milliseconds.
 *
 * 0.5 s → 10 s is the same exponential envelope the Chrome service worker uses
 * for its own socket (AAP §0.5.5). A dev server may outlive many service
 * restarts, so the backoff has to settle somewhere that keeps reconnecting
 * cheap and still recovers within one interaction of the service returning.
 */
export const RECONNECT_MAX_MS = 10_000;

/**
 * Everything the preload needs, validated, with every optional decision already
 * made.
 *
 * Produced only by {@link loadPreloadConfig}, and only for the `active` mode, so
 * a sibling that holds one of these needs no further checks: the endpoint parses
 * as an absolute `http(s)` URL carrying no credentials and addressing a loopback
 * host, the control URL is derived from its origin, the credential is non-empty,
 * and the project root is absolute.
 *
 * All members are `readonly`: this is a value describing one launch, and a
 * component that wants a variation builds its own object.
 */
export interface PreloadConfig {
  /**
   * The ingest endpoint, **complete** — the POST target verbatim.
   *
   * Canonicalised by the WHATWG `URL` parser and guaranteed free of embedded
   * credentials. Never append a path segment to it: it already ends in
   * `/telemetry/ingest` (see this module's overview).
   */
  readonly ingestUrl: string;

  /**
   * The control WebSocket URL, derived from {@link ingestUrl}'s origin by
   * {@link deriveControlUrl}: same host and port, `ws:`/`wss:`, path
   * {@link CONTROL_PATH}.
   *
   * `control.ts` opens this as `client: 'server-agent'` and receives
   * `server-agent.config` on it.
   */
  readonly controlUrl: string;

  /**
   * The server-agent bearer credential.
   *
   * Sent as `Authorization: Bearer …` on ingest and inside `client.hello`.
   * **Never log it, print it, persist it or interpolate it into a message** —
   * see this module's privacy section.
   */
  readonly token: string;

  /**
   * Absolute path of the launched project, exactly as the launcher supplied it
   * (trimmed of surrounding whitespace and otherwise unmodified).
   *
   * Carried in every ingest body. The service accepts ingest only for the
   * project its credential is scoped to and compares this value, so it is
   * deliberately **not** normalised or resolved here: a re-shaped path is a
   * rejected batch.
   */
  readonly projectRoot: string;

  /**
   * {@link PRODUCER_ID} — this process's producer id, repeated on the config so
   * a sibling can take everything it needs from one object.
   */
  readonly producerId: string;

  /**
   * OpenTelemetry `service.name` for the resource `register.ts` builds: the
   * final component of {@link projectRoot}, or {@link SERVICE_NAME_FALLBACK}
   * when no usable component exists.
   */
  readonly serviceName: string;
}

/**
 * The outcome of reading the environment: either a validated
 * {@link PreloadConfig}, or an inert preload with a reason.
 *
 * A discriminated union rather than a `Result`, and `inert` rather than `Err`,
 * because an absent variable is **not an error**: it is the normal state of a
 * dev server running without a session, and modelling it as a failure would
 * push every call site into treating the ordinary case as exceptional. A real
 * error would be something this module cannot produce — it validates and
 * reports, and never throws.
 *
 * `reason` is always value-free: it names variables, never their contents.
 */
export type PreloadConfigResult =
  | { readonly mode: 'active'; readonly config: PreloadConfig }
  | { readonly mode: 'inert'; readonly reason: string };

/**
 * A Windows path rooted at a drive, after {@link toPosix} conversion:
 * `C:/Users/dev/project`. The separator is required, so the drive-*relative*
 * form `C:project` — which is not an absolute path and must not be accepted as
 * one — does not match.
 *
 * A UNC root (`//server/share`) needs no pattern: it begins with `/` and is
 * therefore already accepted by {@link isAbsolutePosix}.
 */
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:\//u;

/**
 * A bare Windows drive with no component after it, as
 * {@link basenamePosix} reports for `C:/`: `C:`. Not a project name.
 */
const BARE_WINDOWS_DRIVE = /^[A-Za-z]:$/u;

/**
 * Read one environment variable as a meaningful value, or `undefined`.
 *
 * Surrounding whitespace is trimmed and a value that is empty or whitespace-only
 * is reported as absent, which collapses three indistinguishable shell mishaps
 * — unset, `VAR=`, and `VAR=" "` from a mis-quoted expansion — into the one
 * outcome they all mean: the launcher did not give us this.
 *
 * @param value The raw environment value, possibly `undefined`.
 * @returns The trimmed value, or `undefined` when there is nothing there.
 */
function readTrimmed(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parse a string as an absolute `http:`/`https:` URL, without throwing.
 *
 * `new URL(value)` throws on anything it cannot parse, and a throw inside a
 * module loaded through `--import` would take the developer's dev server down,
 * so the constructor is wrapped here and nowhere else in this file. The
 * protocol check rejects the shapes that parse but cannot be posted to —
 * `file:`, `ws:`, a bare `localhost:43117` read as the `localhost:` scheme.
 *
 * @param value A trimmed candidate URL.
 * @returns The parsed URL, or `undefined` when it is not an absolute http(s) URL.
 */
function parseHttpUrl(value: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  if (parsed.host.length === 0) {
    return undefined;
  }
  return parsed;
}

/**
 * The one host name this module accepts as loopback.
 *
 * `localhost` is the product's documented loopback name — the Chrome
 * extension's `host_permissions` are `http://localhost/*` and
 * `http://127.0.0.1/*` (AAP §0.7.1 Group 4) — so refusing it would refuse an
 * address the rest of the product offers. Its resolution does ultimately come
 * from the host's resolver, which this process cannot verify; that is a
 * property of the developer's own machine, and it is the same assumption every
 * other surface of the product already makes about this one name.
 *
 * Subdomains (`app.localhost`) are deliberately **not** accepted: RFC 6761
 * reserves them, but whether they resolve to loopback is resolver-dependent, so
 * they are not verifiable loopback and nothing in this product uses them.
 */
const LOOPBACK_HOST_NAME = 'localhost';

/**
 * An IPv4 dotted quad, with each octet captured.
 *
 * Only the canonical form needs matching: {@link isTrustedServiceEndpoint}
 * reads `URL.hostname`, and the WHATWG parser has already rewritten every
 * shorthand an environment variable can carry — `127.1`, `0177.0.0.1`,
 * `2130706433` and `0x7f000001` all arrive here as `127.0.0.1`.
 */
const IPV4_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/**
 * An IPv4-mapped IPv6 address in the two spellings that reach this module:
 * the parser's normalised hextet form (`::ffff:7f00:1`, which is how
 * `[::ffff:127.0.0.1]` serialises) and the dotted form a caller can pass
 * directly (`::ffff:127.0.0.1`).
 *
 * The capture is everything after the `ffff:` prefix, which
 * {@link isLoopbackHostname} then decodes to an IPv4 address.
 */
const IPV4_MAPPED_IPV6 = /^::ffff:([0-9a-f.:]+)$/u;

/** The first octet of the IPv4 loopback range, 127.0.0.0/8 (RFC 1122 §3.2.1.3). */
const IPV4_LOOPBACK_FIRST_OCTET = 127;

/** The largest value an IPv4 octet can hold. */
const MAX_OCTET = 255;

/** The largest value one IPv6 hextet can hold. */
const MAX_HEXTET = 0xffff;

/**
 * Whether a dotted-quad string is an address inside 127.0.0.0/8.
 *
 * Each octet is range-checked as well as matched, because `999.0.0.1` satisfies
 * the pattern and is not an address at all.
 *
 * @param value A candidate dotted-quad string.
 * @returns `true` when the value is a well-formed IPv4 address in the loopback
 * range.
 */
function isIpv4LoopbackAddress(value: string): boolean {
  const match = IPV4_QUAD.exec(value);
  if (match === null) {
    return false;
  }
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > MAX_OCTET)) {
    return false;
  }
  return octets[0] === IPV4_LOOPBACK_FIRST_OCTET;
}

/**
 * Whether the IPv4 address embedded in an IPv4-mapped IPv6 address is loopback.
 *
 * Accepts either spelling of the embedded address: two hextets
 * (`7f00:1` — `::ffff:127.0.0.1` as the WHATWG parser serialises it) or a
 * dotted quad (`127.0.0.1`). The hextet form is decoded to octets rather than
 * pattern-matched on its text, so `7f00:1` and `7f00:0001` are the one address
 * they both denote.
 *
 * @param embedded Everything after the `::ffff:` prefix.
 * @returns `true` when the embedded IPv4 address is in 127.0.0.0/8.
 */
function isMappedIpv4Loopback(embedded: string): boolean {
  if (embedded.includes('.')) {
    return isIpv4LoopbackAddress(embedded);
  }

  const hextets = embedded.split(':');
  if (hextets.length !== 2) {
    return false;
  }
  const [high, low] = hextets;
  if (high === undefined || low === undefined) {
    return false;
  }
  if (!/^[0-9a-f]{1,4}$/u.test(high) || !/^[0-9a-f]{1,4}$/u.test(low)) {
    return false;
  }
  const highValue = Number.parseInt(high, 16);
  const lowValue = Number.parseInt(low, 16);
  if (highValue > MAX_HEXTET || lowValue > MAX_HEXTET) {
    return false;
  }
  // The high hextet's upper byte is the first octet of the embedded address.
  return highValue >>> 8 === IPV4_LOOPBACK_FIRST_OCTET;
}

/**
 * Whether a host name denotes this machine's loopback interface.
 *
 * The three accepted shapes, and nothing else:
 *
 * - the host name {@link LOOPBACK_HOST_NAME};
 * - any IPv4 address in 127.0.0.0/8, the whole loopback range rather than only
 *   `127.0.0.1`, because a developer may legitimately bind another address in
 *   it;
 * - IPv6 `::1`, and an IPv4-mapped address whose embedded IPv4 is loopback.
 *
 * `0.0.0.0` and `::` are **refused**: they are wildcards, not loopback — a
 * service reachable at `0.0.0.0` is reachable from the network, which is the
 * boundary this predicate exists to hold.
 *
 * Exported so `./exporter.ts` can re-check an endpoint it was handed without
 * restating the policy, and so `./config.test.ts` can assert the boundary
 * case by case. `scripts/dev-instrumented.mjs` implements the same policy
 * separately because that script may import nothing but `node:` builtins; a
 * change here belongs there too.
 *
 * @param hostname A host name or IP literal, as `URL.hostname` reports it
 * (IPv6 literals may be bracketed or bare, and matching is case-insensitive).
 * @returns `true` when the host is verifiably loopback.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalised = hostname.trim().toLowerCase();
  if (normalised.length === 0) {
    return false;
  }

  if (normalised === LOOPBACK_HOST_NAME) {
    return true;
  }

  // `URL.hostname` brackets IPv6 literals; a direct caller may not.
  const bare =
    normalised.startsWith('[') && normalised.endsWith(']') ? normalised.slice(1, -1) : normalised;

  if (bare === '::1') {
    return true;
  }

  const mapped = IPV4_MAPPED_IPV6.exec(bare);
  if (mapped !== null) {
    const embedded = mapped[1];
    return embedded !== undefined && isMappedIpv4Loopback(embedded);
  }

  return isIpv4LoopbackAddress(bare);
}

/**
 * Whether a URL is an endpoint this preload may send its credential to.
 *
 * The launcher mints a server-agent credential per dev-server launch and hands
 * it to this process alongside the endpoint it was minted for (AAP §0.5.6).
 * The endpoint arrives in an environment variable, which anything with a hand
 * on the process's environment can set, so it is checked rather than believed:
 * the local service is a **loopback** service (AAP §0.5.6 — "Binding to
 * `127.0.0.1` keeps other machines out"), and an endpoint that is not loopback
 * is not the service. Sending to one would disclose the bearer credential and
 * the developer's telemetry — URLs, SQL statements, component names — to
 * another origin, in cleartext when the scheme is `http:` (CWE-200, CWE-319).
 *
 * The requirements, all of which must hold:
 *
 * - it parses as an absolute `http:`/`https:` URL with a host;
 * - it embeds no userinfo, so nothing that is printed can carry a credential;
 * - its host is loopback per {@link isLoopbackHostname}, whatever the scheme —
 *   which is what refuses non-loopback cleartext HTTP along with everything
 *   else off this machine.
 *
 * @param value A candidate endpoint, as a string or an already-parsed URL.
 * @returns `true` when the endpoint may be used.
 */
export function isTrustedServiceEndpoint(value: string | URL): boolean {
  const parsed = typeof value === 'string' ? parseHttpUrl(value) : value;
  if (parsed === undefined) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  return isLoopbackHostname(parsed.hostname);
}

/**
 * Whether a project root is absolute, on either kind of host.
 *
 * POSIX-absolute (`/home/dev/project`) and UNC (`//server/share`) are accepted
 * by the leading separator; a Windows drive root (`C:\Users\dev\project`, or its
 * {@link toPosix} form) by {@link WINDOWS_DRIVE_ROOT}. The drive-relative form
 * `C:project` is refused: it resolves against a per-drive working directory, so
 * it names a different place depending on who reads it, and the service's
 * comparison against the credential's project root would fail in a way no
 * message explains.
 *
 * @param value A trimmed candidate path.
 * @returns `true` when the path is absolute.
 */
function isAbsoluteProjectRoot(value: string): boolean {
  const posix = toPosix(value);
  return isAbsolutePosix(posix) || WINDOWS_DRIVE_ROOT.test(posix);
}

/**
 * Derive the OpenTelemetry `service.name` from a project root: its final path
 * component, or {@link SERVICE_NAME_FALLBACK}.
 *
 * `basenamePosix` normalises first, so a trailing separator is ignored
 * (`/home/dev/project/` → `project`). The fallback covers every root with no
 * component to name: the filesystem root (`/` → `''`), a bare Windows drive
 * (`C:/` → `C:`), and the navigation components a hand-set variable can still
 * contain (`.`, `..`).
 *
 * @param projectRoot An absolute project root.
 * @returns A non-empty service name.
 */
function deriveServiceName(projectRoot: string): string {
  const base = basenamePosix(toPosix(projectRoot));
  if (base.length === 0 || base === '.' || base === '..' || BARE_WINDOWS_DRIVE.test(base)) {
    return SERVICE_NAME_FALLBACK;
  }
  return base;
}

/**
 * Build the inert half of a {@link PreloadConfigResult}.
 *
 * Exists so that every inert return in {@link loadPreloadConfig} is one line and
 * one shape, which is what makes the "no value ever reaches a reason" rule
 * reviewable: the reasons are all in this file, all built from
 * {@link PRELOAD_ENV_KEYS} entries, and none of them interpolates a variable's
 * contents.
 *
 * @param reason A short, actionable, value-free explanation.
 * @returns An inert result.
 */
function inert(reason: string): PreloadConfigResult {
  return { mode: 'inert', reason };
}

/**
 * Derive the control WebSocket URL from the ingest endpoint.
 *
 * The launcher gives the preload one address, and the control channel has to
 * reach the same service: this is the whole of that mapping —
 *
 * - the origin is kept (same host, same port);
 * - `http:` becomes `ws:` and `https:` becomes `wss:`;
 * - the path becomes {@link CONTROL_PATH}, discarding `/telemetry/ingest`;
 * - any query, fragment or embedded userinfo is discarded, because only the
 *   origin is meaningful for the socket (and a credential must never be carried
 *   into a URL that gets logged).
 *
 * Built by re-parsing `` `${scheme}//${host}` `` rather than by assigning
 * `url.protocol`: the WHATWG setter's behaviour across special schemes is a
 * detail nobody reading this should have to recall, and string surgery on the
 * original would have to re-implement host and port handling that the parser
 * already does.
 *
 * Exported because `control.ts` may hold an ingest URL from somewhere other than
 * a {@link PreloadConfig} (a test harness, a re-read of the environment) and
 * must not grow a second copy of this rule.
 *
 * @param ingestUrl The ingest endpoint, as a string or an already-parsed URL.
 * @returns The control URL — `http://127.0.0.1:43117/telemetry/ingest` yields
 * `ws://127.0.0.1:43117/ws` — or `undefined` when the input is not an absolute
 * http(s) URL with a host.
 */
export function deriveControlUrl(ingestUrl: string | URL): string | undefined {
  const parsed = typeof ingestUrl === 'string' ? parseHttpUrl(ingestUrl) : ingestUrl;
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  if (parsed.host.length === 0) {
    return undefined;
  }

  const scheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    return new URL(CONTROL_PATH, `${scheme}//${parsed.host}`).toString();
  } catch {
    return undefined;
  }
}

/**
 * Read the environment and decide whether this process instruments anything.
 *
 * The contract, in order of the checks it performs:
 *
 * 1. All three launcher variables must be present and non-blank. Any that are
 *    not are named together in one reason (`… is not set` / `… are not set`).
 * 2. `DEBUGGEN_INGEST_URL` must parse as an absolute `http:`/`https:` URL with a
 *    host, and must not embed credentials.
 * 3. That endpoint's host must be loopback ({@link isLoopbackHostname}). The
 *    local service is a loopback service, so this is the trust boundary for
 *    both outbound paths — and it is checked here, before a control URL is
 *    derived, because the socket inherits this origin.
 * 4. A control URL must be derivable from that endpoint's origin.
 * 5. `DEBUGGEN_PROJECT_ROOT` must be an absolute path.
 *
 * Anything else is `{ mode: 'inert', reason }` and the preload installs nothing.
 * **This function never throws**, for any input, including a `process.env`
 * populated by hand with hostile values: the only constructor that can throw is
 * wrapped, and every other step is a string test.
 *
 * It has no side effects. {@link PRODUCER_ID} is generated at module load, not
 * here, so calling this twice yields the same producer id and touches nothing
 * else — which is what lets `control.test.ts` drive it repeatedly with
 * synthesised environments.
 *
 * @param env The environment to read; defaults to `process.env` and is
 * injectable so a test never has to mutate the real one.
 * @returns An active result carrying a validated {@link PreloadConfig}, or an
 * inert result carrying a value-free reason.
 *
 * @example An instrumented launch
 * ```ts
 * loadPreloadConfig({
 *   DEBUGGEN_INGEST_URL: 'http://127.0.0.1:43117/telemetry/ingest',
 *   DEBUGGEN_TOKEN: token,
 *   DEBUGGEN_PROJECT_ROOT: '/home/dev/lumen-supply',
 * });
 * // → { mode: 'active', config: { controlUrl: 'ws://127.0.0.1:43117/ws',
 * //      serviceName: 'lumen-supply', … } }
 * ```
 *
 * @example A dev server with the module attached and no session
 * ```ts
 * loadPreloadConfig({});
 * // → { mode: 'inert', reason: 'DEBUGGEN_INGEST_URL, DEBUGGEN_TOKEN,
 * //      DEBUGGEN_PROJECT_ROOT are not set' }
 * ```
 */
export function loadPreloadConfig(env: NodeJS.ProcessEnv = process.env): PreloadConfigResult {
  const rawIngestUrl = readTrimmed(env[PRELOAD_ENV_KEYS.ingestUrl]);
  const rawToken = readTrimmed(env[PRELOAD_ENV_KEYS.token]);
  const rawProjectRoot = readTrimmed(env[PRELOAD_ENV_KEYS.projectRoot]);

  // Reported together rather than one at a time: a developer who exported none
  // of them (the `--spawn-local` case, or a stale terminal) learns that in one
  // line instead of three runs. The compound condition is what narrows all
  // three values for the rest of the function.
  if (rawIngestUrl === undefined || rawToken === undefined || rawProjectRoot === undefined) {
    const missing: string[] = [];
    if (rawIngestUrl === undefined) {
      missing.push(PRELOAD_ENV_KEYS.ingestUrl);
    }
    if (rawToken === undefined) {
      missing.push(PRELOAD_ENV_KEYS.token);
    }
    if (rawProjectRoot === undefined) {
      missing.push(PRELOAD_ENV_KEYS.projectRoot);
    }
    const verb = missing.length === 1 ? 'is' : 'are';
    return inert(`${missing.join(', ')} ${verb} not set`);
  }

  const endpoint = parseHttpUrl(rawIngestUrl);
  if (endpoint === undefined) {
    return inert(`${PRELOAD_ENV_KEYS.ingestUrl} is not a valid absolute http(s) URL`);
  }

  // Refused, not stripped. The service authenticates with a bearer credential,
  // so userinfo in this URL is never something we should be using — and once
  // refused, `ingestUrl` and `controlUrl` are safe for a sibling to log.
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    return inert(`${PRELOAD_ENV_KEYS.ingestUrl} must not embed credentials in the URL`);
  }

  // The trust boundary, checked before a control URL is derived from this
  // origin and therefore before either outbound path can exist. The local
  // service is a loopback service, so an endpoint that is not loopback is not
  // the service, and following it would hand the server-agent credential and
  // the developer's telemetry to another origin.
  if (!isLoopbackHostname(endpoint.hostname)) {
    return inert(
      `${PRELOAD_ENV_KEYS.ingestUrl} must address the local service on a loopback host (localhost, 127.0.0.0/8 or [::1])`,
    );
  }

  const controlUrl = deriveControlUrl(endpoint);
  if (controlUrl === undefined) {
    return inert(
      `${PRELOAD_ENV_KEYS.ingestUrl} has no origin a control socket can be derived from`,
    );
  }

  if (!isAbsoluteProjectRoot(rawProjectRoot)) {
    return inert(`${PRELOAD_ENV_KEYS.projectRoot} is not an absolute path`);
  }

  return {
    mode: 'active',
    config: {
      // The parser's canonical form of the same endpoint: the path is preserved
      // exactly as given and nothing is appended to it.
      ingestUrl: endpoint.toString(),
      controlUrl,
      token: rawToken,
      projectRoot: rawProjectRoot,
      producerId: PRODUCER_ID,
      serviceName: deriveServiceName(rawProjectRoot),
    },
  };
}

/**
 * Resolve a requested logging threshold to a {@link LogLevelSetting}.
 *
 * Matching is trimmed and case-insensitive, `'silent'` is honoured, and an
 * unrecognised value falls back to {@link DEFAULT_PRELOAD_LOG_LEVEL} rather than
 * being rejected: a typo in a log level must not change whether the preload
 * runs, and it must not raise inside someone else's dev server. `LOG_LEVELS` is
 * the vocabulary, iterated rather than restated, so a level added to
 * `@debuggen/shared` is understood here without an edit.
 *
 * @param requested A candidate level, possibly `undefined`.
 * @returns A valid threshold.
 */
function resolveLogLevel(requested: string | undefined): LogLevelSetting {
  const candidate = readTrimmed(requested)?.toLowerCase();
  if (candidate === undefined) {
    return DEFAULT_PRELOAD_LOG_LEVEL;
  }
  if (candidate === 'silent') {
    return 'silent';
  }
  return LOG_LEVELS.find((level) => level === candidate) ?? DEFAULT_PRELOAD_LOG_LEVEL;
}

/**
 * Build the preload's logger: quiet by default, named, and free of transports.
 *
 * Precedence is explicit `level` → `DEBUGGEN_LOG_LEVEL` →
 * {@link DEFAULT_PRELOAD_LOG_LEVEL}. A resolved `'silent'` returns
 * {@link noopLogger}, so a silenced call site allocates nothing at all; anything
 * else returns a `createConsoleLogger` bound to {@link PRELOAD_LOGGER_NAME},
 * whose records reach the developer's own terminal through the default console
 * sink.
 *
 * The console is the only honest destination available here. The preload runs
 * inside the target project's process: it has no output channel, and routing its
 * own diagnostics through the ingest endpoint would mean a transport failure
 * could not be reported. Hence the conservative default — see
 * {@link DEFAULT_PRELOAD_LOG_LEVEL}.
 *
 * Remember the two rules that apply to every call made on the result: message
 * first, fields second, and **nothing secret in either** — never the
 * credential, and never a captured attribute that has not been through
 * redaction.
 *
 * @param level An explicit threshold, overriding the environment.
 * @param env The environment to read `DEBUGGEN_LOG_LEVEL` from; defaults to
 * `process.env` and is injectable for tests.
 * @returns A {@link Logger}; the call performs no I/O.
 *
 * @example
 * ```ts
 * const log = createPreloadLogger();
 * log.warn('server spans unavailable', { reason: result.reason });
 * // console.warn('[debuggen-preload] server spans unavailable', { … })
 * ```
 */
export function createPreloadLogger(level?: string, env: NodeJS.ProcessEnv = process.env): Logger {
  const setting = resolveLogLevel(level ?? env[PRELOAD_ENV_KEYS.logLevel]);
  if (setting === 'silent') {
    return noopLogger;
  }
  return createConsoleLogger({ level: setting, name: PRELOAD_LOGGER_NAME });
}
