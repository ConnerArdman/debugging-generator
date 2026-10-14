/**
 * `GET /api/ping` - the single route handler of this application.
 *
 * WHAT IT DOES
 *
 * It waits for a fixed interval and then answers HTTP 200 with a small JSON object. That is the
 * whole of its behaviour: nothing about the request is read, no data source is consulted - this
 * application has none - and no branch of any kind is taken, so every call follows the same code
 * path and returns the same bytes.
 *
 * THE CONTRACT IT PUBLISHES
 *
 * `src/components/PingWidget.tsx` is the only caller. It requests this endpoint once per click,
 * reads exactly one field from the body - `reply` - and narrows that field to a string before
 * rendering it; a body without a string `reply` shows up in the page as a failed check instead.
 * The response therefore always carries a string `reply`, and carries nothing besides: a second
 * field would be a property of this endpoint that no caller asked for and that a later change
 * could only get wrong.
 *
 * THE INTERVAL BEFORE THE REPLY
 *
 * The endpoint answers after a fixed interval rather than immediately, so a request to it has a
 * duration for a caller to wait on. The interval is declared once, at module scope and as a plain
 * constant, which makes it a stated property of this file instead of a number buried in the
 * expression that consumes it, and keeps it the same in every copy of this directory.
 *
 * WHY EVERY RESPONSE IS IDENTICAL
 *
 * There is no clock read, no random value, no counter and no environment lookup anywhere below, and
 * nothing from the request reaches the response. Two calls a second apart are byte-identical, which
 * is what lets one run of this check be compared against the next; a timestamp or a sequence number
 * in the body would turn every such comparison into a difference.
 *
 * WHY THE DECLARATIONS BELOW LOOK THE WAY THEY DO
 *
 * Three shapes in this file are chosen rather than incidental:
 *
 *   - the route segment configuration `dynamic = 'force-dynamic'` keeps every call on this
 *     function. Without it the framework is free to answer a later call from a cache, and the
 *     second click on the page would produce no request and no reply of its own;
 *   - both functions are named `async function` declarations, not arrow constants and not
 *     generators. A name is what makes a function's own work attributable to that function - in a
 *     stack trace, in a profiler and to a reader of this file - and a declaration is what carries
 *     the name into the compiled output;
 *   - there is no import. The response is built with the global `Response.json` and the wait with
 *     the global `setTimeout`, so this file depends on nothing but the runtime it executes in. That
 *     also keeps it correct when this directory is copied somewhere else and run from there, which
 *     no relative or aliased import could survive.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 *   - no second HTTP method: one route, one verb, one behaviour. `GET` is the only export a caller
 *     may reach, so the set of things this endpoint can do is closed;
 *   - no `Request` parameter, and so no header, cookie, search parameter or body read: a handler
 *     that varied with its input would have as many behaviours as there are callers;
 *   - no `try`/`catch`, no error branch, no status override and no custom header: nothing below can
 *     fail in a way this file could handle better than the runtime, and an unreachable error path
 *     is an untested one;
 *   - no framework response helper, no validation library and no logging: each would be a
 *     dependency this endpoint does not need in order to answer.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/route
 */

/**
 * Route segment configuration: every request runs this handler.
 *
 * The framework is otherwise free to treat a handler with no request input as static and to serve a
 * stored answer, which would silently reduce the second and later calls to no work at all.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config
 */
export const dynamic = 'force-dynamic';

/**
 * How long a single call waits before answering, in milliseconds.
 *
 * Kept a literal constant - not exported, not configurable and not read from the environment - so
 * that every call of this endpoint, in every copy of this directory, waits exactly as long as every
 * other.
 */
const DELAY_MS = 300;

/**
 * Waits `DELAY_MS` and returns the body of the response.
 *
 * `setTimeout` is resolved through a promise so the wait is awaited rather than blocking, which is
 * what keeps the handler above free to be served concurrently. Nothing is computed afterwards: the
 * payload is a literal.
 *
 * @returns The response body, whose `reply` is always a string.
 */
async function buildPingPayload(): Promise<{ reply: string }> {
  await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  return { reply: 'Check complete' };
}

/**
 * Answers `GET /api/ping` with HTTP 200 and the JSON body above.
 *
 * The handler takes no parameter and makes no decision: it awaits the payload and serialises it.
 * `Response.json` is the platform's own helper, so the status is 200, the content type is JSON and
 * no header has to be written by hand.
 *
 * @returns A 200 response carrying `{ reply: string }` as JSON.
 */
export async function GET(): Promise<Response> {
  return Response.json(await buildPingPayload());
}
