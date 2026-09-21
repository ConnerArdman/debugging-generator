/**
 * The failure contract for the Lumen Supply server layer.
 *
 * Everything that can go wrong behind a route handler is expressed here, in two
 * halves that belong together:
 *
 * 1. **A small hierarchy of thrown errors.** A service that cannot do what it
 *    was asked throws a {@link StorefrontError} - almost always one of the four
 *    subclasses below - which carries the machine-readable
 *    `StorefrontErrorCode` the browser reads, the HTTP status the failure
 *    deserves and, when it helps, structured `details`.
 * 2. **One mapper from any thrown value to one response.** Route handlers do not
 *    classify failures themselves: they `catch` and hand the value to
 *    {@link storefrontErrorResponse}, so every endpoint answers with the same
 *    `StorefrontErrorBody` envelope and the browser client has exactly one shape
 *    to parse.
 *
 * ## What may appear in a response body
 *
 * The mapper is the application's redaction boundary, and it is deliberately
 * stingy. A body carries only a code from the closed union, a message this
 * module (or a `StorefrontError` a service raised) authored, and - for a
 * validation failure - the rejected field paths. It never carries a stack
 * trace, a message written by a library, a SQL statement, a driver's `detail`
 * or `hint` field, a connection string or a file-system path. An unexpected
 * failure is therefore opaque to the client on purpose: the developer reads the
 * server log, the visitor reads one sentence.
 *
 * That is also why the two database branches of the mapper duck-type their
 * input instead of importing `@prisma/client` or `pg`. The generated Prisma
 * client is produced by `prisma generate` and is not in version control, so an
 * import of it would make this module unbuildable on a fresh checkout, and
 * neither driver needs to be part of the error boundary's type graph for a
 * `code` string to be read off the value that was thrown.
 *
 * Nothing in this module runs at import time: it declares classes, constants
 * and functions, reads no environment variable and opens no connection.
 */

import type { StorefrontErrorBody, StorefrontErrorCode } from '@/lib/types';

/* ---------------------------------------------------------------------------
 * Fixed messages and limits
 * ------------------------------------------------------------------------- */

/** What a visitor is told when the cause is unknown, and must stay that vague. */
const GENERIC_MESSAGE = 'The storefront could not complete this request.';

/** What a visitor is told when the database refused or failed the operation. */
const DATABASE_MESSAGE = 'The storefront could not complete this database operation.';

/** What a visitor is told when the request itself did not pass validation. */
const VALIDATION_MESSAGE = 'The request did not match what this endpoint accepts.';

/** What a visitor is told when a record named by the request is gone. */
const MISSING_MESSAGE = 'The requested record no longer exists.';

/** What a visitor is told when the write collides with a record that exists. */
const CONFLICT_MESSAGE = 'The change conflicts with a record that already exists.';

/**
 * How many rejected fields a validation body reports.
 *
 * A schema rejection over a large payload can produce hundreds of issues; a
 * form only ever renders the first handful, and an unbounded list would let the
 * size of the request decide the size of the response.
 */
const MAX_ISSUES = 20;

/** How long a single reported validation message may be. */
const MAX_LENGTH = 200;

/**
 * A Prisma request error code: the letter `P` and four digits, as in `P2002`.
 *
 * PostgreSQL's own `P0001` (a `RAISE` from PL/pgSQL) has the same shape, so a
 * driver error can in principle match this pattern. It is inconsequential: only
 * two codes are mapped specifically, and every other value on either side of
 * that overlap produces the same generic database response.
 */
const PRISMA_CODE = /^P\d{4}$/;

/** A PostgreSQL `SQLSTATE`: five digits or capitals, as in `23505` or `42P01`. */
const SQL_STATE = /^[0-9A-Z]{5}$/;

/* ---------------------------------------------------------------------------
 * Thrown errors
 * ------------------------------------------------------------------------- */

/**
 * The optional third argument every storefront error accepts.
 *
 * `cause` is the standard `ErrorOptions` member and is kept for the server log
 * only - {@link mapStorefrontError} never reads it, because a cause is usually a
 * library error whose message this application did not write.
 */
export interface StorefrontErrorOptions extends ErrorOptions {
  /**
   * Structured context the client may render, and the one part of an error a
   * service chooses freely.
   *
   * It is serialized into the response body as it stands, so it must contain
   * only values this application authored and only values JSON can carry: the
   * conventions of `@/lib/types` apply here too - integer cents in `*Cents`
   * fields, ISO-8601 UTC strings for instants, and no `Date`, `Decimal` or
   * class instance. Never put a row, a statement or a caught library message in
   * it.
   */
  details?: unknown;
}

/**
 * What {@link mapStorefrontError} decided: the status to answer with and the
 * body to answer it with.
 */
export interface StorefrontErrorOutcome {
  /** The HTTP status code of the response. */
  status: number;
  /** The response body, in the one envelope every endpoint uses. */
  body: StorefrontErrorBody;
}

/**
 * A failure this application raised on purpose.
 *
 * Prefer one of the four subclasses; construct this class directly only for a
 * code they do not cover - `OUT_OF_STOCK` and `PAYMENT_DECLINED` are the two
 * that come up, both with a status of 409 and 402 respectively chosen by the
 * service that raises them.
 *
 * @example
 * ```ts
 * throw new StorefrontError('OUT_OF_STOCK', 409, 'Only 3 units remain in stock.', {
 *   details: { available: 3 },
 * });
 * ```
 */
export class StorefrontError extends Error {
  /** The machine-readable reason the browser client switches on. */
  readonly code: StorefrontErrorCode;

  /** The HTTP status a route handler answers with when this error escapes. */
  readonly status: number;

  /**
   * The structured context from {@link StorefrontErrorOptions.details}.
   *
   * Declared with `declare` so the class body emits no field initializer: the
   * property is assigned only when details were given, which keeps it absent -
   * rather than present and `undefined` - on an error that has none, and keeps
   * the key out of the response body.
   */
  declare readonly details?: unknown;

  /**
   * @param code The reason, from the closed union in `@/lib/types`. Choose the
   * most specific member that fits; the client's recovery paths are keyed on it.
   * @param status The HTTP status for this failure.
   * @param message A complete sentence a visitor can read. It reaches the
   * browser verbatim, so it must describe the situation without naming a file,
   * a table or a query.
   * @param options Optional `details` for the body and `cause` for the log.
   */
  constructor(
    code: StorefrontErrorCode,
    status: number,
    message: string,
    options?: StorefrontErrorOptions,
  ) {
    // `cause` is forwarded only when there is one, so an error without a cause
    // has no `cause` property at all rather than one holding `undefined`.
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);

    // Set explicitly in every constructor of this hierarchy: a class name is
    // not carried into `name` by the language, and a downlevelled or minified
    // build would otherwise report every one of these as plain "Error".
    this.name = 'StorefrontError';
    this.code = code;
    this.status = status;

    if (options?.details !== undefined) {
      this.details = options.details;
    }
  }
}

/**
 * Nothing exists at the identifier the request named - an unknown product slug,
 * a cart that has been converted, an order belonging to nobody.
 */
export class StorefrontNotFoundError extends StorefrontError {
  /**
   * @param message A sentence naming what was looked for, not where it was
   * looked for.
   * @param options Optional `details` and `cause`.
   */
  constructor(message: string, options?: StorefrontErrorOptions) {
    super('NOT_FOUND', 404, message, options);
    this.name = 'StorefrontNotFoundError';
  }
}

/**
 * The request was understood but is not acceptable: a quantity of zero, a
 * postal code the carrier cannot serve, a checkout with an empty cart.
 *
 * A schema rejection needs no such throw - {@link mapStorefrontError} turns one
 * into this same response - so this class is for the rules a schema cannot
 * express.
 */
export class StorefrontValidationError extends StorefrontError {
  /**
   * @param message A sentence stating which rule the request broke.
   * @param options Optional `details` - the field paths at fault, in the shape
   * the mapper produces for a schema rejection - and `cause`.
   */
  constructor(message: string, options?: StorefrontErrorOptions) {
    super('VALIDATION_FAILED', 400, message, options);
    this.name = 'StorefrontValidationError';
  }
}

/**
 * The request collided with the current state: a cart edited from two tabs, an
 * order already placed, a quantity that another checkout has since claimed.
 *
 * The union in `@/lib/types` has no general-purpose conflict member, so this
 * carries `CART_CONFLICT`, its closest one. A stock shortage is the other
 * common conflict and has a code of its own, `OUT_OF_STOCK`, raised through
 * {@link StorefrontError} directly.
 */
export class StorefrontConflictError extends StorefrontError {
  /**
   * @param message A sentence describing the collision and what the visitor can
   * do about it.
   * @param options Optional `details` and `cause`.
   */
  constructor(message: string, options?: StorefrontErrorOptions) {
    super('CART_CONFLICT', 409, message, options);
    this.name = 'StorefrontConflictError';
  }
}

/**
 * A dependency this application calls out to did not answer usefully: a non-2xx
 * reply from the carrier or payment endpoint, or a `fetch` that rejected.
 *
 * The status is 502, because the storefront itself is healthy and the failure
 * is upstream of it. The short `upstream` label is the only thing recorded
 * about which dependency failed: a URL could carry a query string or a
 * credential, and neither belongs in a response body or a log line.
 */
export class StorefrontUpstreamError extends StorefrontError {
  /** Which dependency failed, as a short label such as `carrier` or `payment`. */
  readonly upstream: string;

  /**
   * @param message A sentence a visitor can read, naming no host or path.
   * @param upstream A short, stable label for the dependency. Keep it to a
   * word: it is reported to the browser inside `details`.
   * @param options Optional `cause`, for the log. `details` is not accepted -
   * the label is this error's detail.
   */
  constructor(message: string, upstream: string, options?: ErrorOptions) {
    super('INTERNAL_ERROR', 502, message, { details: { upstream }, cause: options?.cause });
    this.name = 'StorefrontUpstreamError';
    this.upstream = upstream;
  }
}

/**
 * Whether `error` is a failure this application raised on purpose.
 *
 * This is the question a route handler asks to tell a domain failure from a
 * bug: the former is part of the endpoint's contract, the latter is worth a log
 * line. Everything in this workspace runs in one process from one module
 * instance, so an `instanceof` test is exact here.
 *
 * @param error Any caught value; `catch` binds `unknown`.
 */
export function isStorefrontError(error: unknown): error is StorefrontError {
  return error instanceof StorefrontError;
}

/* ---------------------------------------------------------------------------
 * Mapping a thrown value to a response
 * ------------------------------------------------------------------------- */

/**
 * Builds the response envelope, omitting `details` entirely when there are
 * none so the serialized body has no null-ish key.
 */
function envelope(
  code: StorefrontErrorCode,
  message: string,
  details?: unknown,
): StorefrontErrorBody {
  if (details === undefined) {
    return { error: { code, message } };
  }

  return { error: { code, message, details } };
}

/**
 * Whether `value` is an array, narrowed to elements of `unknown` rather than
 * the `any[]` that `Array.isArray` claims - reading an element of this is then
 * a value that has to be checked before it is used, which is the point.
 */
function list(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Reduces the issue list of a schema rejection to the two fields a form needs:
 * the dotted path of the value at fault and the message explaining it.
 *
 * Every other field an issue carries is dropped rather than copied, because
 * several of them (`input`, `received`, `expected`, the nested errors of a
 * union) quote the caller's own payload back at it, and a payload may hold an
 * address, a contact name or a card detail. Each entry is validated on the way
 * in: a validator's issue shape is not this application's to guarantee, and an
 * entry that yields no message is skipped.
 *
 * @param value The rejection's issue array, already known to be an array.
 * @returns At most {@link MAX_ISSUES} entries, each message at most
 * {@link MAX_LENGTH} characters.
 */
function issues(value: readonly unknown[]): { path: string; message: string }[] {
  const rows: { path: string; message: string }[] = [];

  for (const entry of value) {
    if (rows.length >= MAX_ISSUES) {
      break;
    }

    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const text: unknown = 'message' in entry ? entry.message : undefined;
    if (typeof text !== 'string' || text.length === 0) {
      continue;
    }

    // A path is a list of property names and array indices, and is absent on an
    // issue about the payload as a whole. Anything that is neither a string nor
    // a number - a symbol key, say - is left out rather than stringified.
    const raw: unknown = 'path' in entry ? entry.path : undefined;
    const path = list(raw)
      ? raw
          .filter(
            (segment): segment is string | number =>
              typeof segment === 'string' || typeof segment === 'number',
          )
          .join('.')
      : '';

    rows.push({
      path,
      message: text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text,
    });
  }

  return rows;
}

/**
 * Classifies any thrown value into the status and body to answer with.
 *
 * The parameter is `unknown` because that is what `catch` binds and because
 * JavaScript permits throwing anything at all. The branches run from the most
 * specific to the least, and the last one is unconditional, so every possible
 * input has an answer:
 *
 * 1. A {@link StorefrontError}: answered with its own status, code, message and
 *    details, since a service raised it deliberately.
 * 2. A schema rejection - recognised by its issue list, not by an import, which
 *    keeps this module independent of the validator and works for a rejection
 *    from any copy of it: 400, with the rejected field paths as details. The
 *    rejection's own `message` is never used; in the validator this application
 *    uses it is a serialization of every issue, including the input values.
 * 3. A Prisma request error, recognised by its `P####` code: the two codes with
 *    an unambiguous meaning for a storefront are mapped to 404 and 409, and
 *    every other one joins the generic database response.
 * 4. A PostgreSQL driver error, recognised by its `SQLSTATE` code or its
 *    `severity` field: collapsed to one generic 500. The distinctions the driver
 *    draws are for the developer reading the log, and its fields cannot be
 *    forwarded - `message` may quote the statement and `detail` may quote the
 *    row that violated a constraint.
 * 5. Anything else, including a plain `Error`, a string or `undefined`: a fixed
 *    500 whose message says nothing about the cause.
 *
 * @param error Any caught value.
 */
export function mapStorefrontError(error: unknown): StorefrontErrorOutcome {
  if (isStorefrontError(error)) {
    return {
      status: error.status,
      body: envelope(error.code, error.message, error.details),
    };
  }

  if (typeof error === 'object' && error !== null && 'issues' in error) {
    const raw: unknown = error.issues;
    if (list(raw)) {
      const rows = issues(raw);

      // A readable issue is what makes this a validation failure. A value that
      // merely happens to carry an empty or unreadable `issues` array is left
      // to the branches below rather than reported as the caller's mistake.
      if (rows.length > 0) {
        return {
          status: 400,
          body: envelope('VALIDATION_FAILED', VALIDATION_MESSAGE, rows),
        };
      }
    }
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;

    if (typeof code === 'string' && PRISMA_CODE.test(code)) {
      // P2025: an update or delete matched no row.
      if (code === 'P2025') {
        return { status: 404, body: envelope('NOT_FOUND', MISSING_MESSAGE) };
      }

      // P2002: a unique constraint rejected the write.
      if (code === 'P2002') {
        return { status: 409, body: envelope('CART_CONFLICT', CONFLICT_MESSAGE) };
      }

      return { status: 500, body: envelope('INTERNAL_ERROR', DATABASE_MESSAGE) };
    }

    if ((typeof code === 'string' && SQL_STATE.test(code)) || 'severity' in error) {
      return { status: 500, body: envelope('INTERNAL_ERROR', DATABASE_MESSAGE) };
    }
  }

  // The failure is a bug rather than a condition this endpoint accounts for, so
  // it is worth one line in the server log. Only a stable label and the value's
  // kind are printed: a message or a stack may hold a path, a statement or a
  // customer's data, and this line is written for whoever is watching the dev
  // server rather than for whoever filed the request.
  console.error(
    'Lumen Supply: unhandled server failure:',
    error instanceof Error ? error.name : typeof error,
  );

  return { status: 500, body: envelope('INTERNAL_ERROR', GENERIC_MESSAGE) };
}

/**
 * Turns any thrown value into the `Response` a route handler returns.
 *
 * This is the one line every handler's `catch` block needs, and the reason all
 * of them answer identically. It is built on the global `Response` rather than
 * on a framework helper, so a server component can call it too.
 *
 * `no-store` is set because a failure is a moment in time: the status and body
 * describe the state of a cart, a stock level or a dependency as it was, and
 * neither the dev server nor the browser should serve it again.
 *
 * @param error Any caught value.
 *
 * @example
 * ```ts
 * export async function GET(request: Request): Promise<Response> {
 *   try {
 *     return Response.json(await catalog(request));
 *   } catch (error) {
 *     return storefrontErrorResponse(error);
 *   }
 * }
 * ```
 */
export function storefrontErrorResponse(error: unknown): Response {
  const { status, body } = mapStorefrontError(error);

  return Response.json(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
