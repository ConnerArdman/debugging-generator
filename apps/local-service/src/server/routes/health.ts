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
 * - **It touches nothing that can fail.** No store, file system, pipeline or
 *   launched process is consulted, so the probe keeps answering while the rest
 *   of the service is degraded. The one injected input that could misbehave,
 *   the pairing-availability predicate, degrades to `pairingAvailable: false`
 *   rather than failing the request.
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
 * allocates one small body. Nothing here reads `process.env`; configuration
 * arrives through {@link HealthRoutesDeps}.
 */

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
 * Public types
 * ---------------------------------------------------------------------------------------------- */

/**
 * What {@link createHealthRoutes} is built from — the narrowest set of inputs
 * that answers the probe.
 *
 * Deliberately free of the store, the configuration object and the auth
 * service: none of them is needed, and each is something that can fail.
 */
export interface HealthRoutesDeps {
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
   * the route's method and pattern and an error code — never a body, a header
   * or a thrown value's message.
   */
  readonly logger?: Logger | undefined;
}

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
 * @param deps The service version, the pairing predicate and an optional logger.
 * @returns A frozen record holding the one handler, keyed by
 * {@link HEALTH_OPERATION}.
 *
 * @example
 * ```ts
 * const routes = createHealthRoutes({
 *   serviceVersion,
 *   isPairingAvailable: () => editorConnected(),
 *   logger,
 * });
 * app.on(HTTP_ROUTES.health.method, HTTP_ROUTES.health.pattern, routes.health);
 * ```
 */
export function createHealthRoutes(deps: HealthRoutesDeps): HealthRoutes {
  const { serviceVersion, isPairingAvailable } = deps;
  const logger = deps.logger ?? noopLogger;

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

    c.header(CACHE_CONTROL_HEADER, NO_STORE);
    return c.json(body.value, 200);
  };

  return Object.freeze({ [HEALTH_OPERATION]: health });
}
