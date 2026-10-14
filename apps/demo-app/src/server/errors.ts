/**
 * The failure contract for the Lumen Supply server layer.
 *
 * Everything that can go wrong behind a route handler is expressed here, in
 * three parts that belong together:
 *
 * 1. **A small hierarchy of thrown errors.** A service that cannot do what it
 *    was asked throws a {@link StorefrontError} - almost always one of the six
 *    subclasses below - which carries the machine-readable
 *    `StorefrontErrorCode` the browser reads, the HTTP status the failure
 *    deserves and, when it helps, structured `details`. One failure is neither
 *    a subclass nor a service's own choice of code and status, because what it
 *    tells a customer about their money is a contract:
 *    {@link paymentStatusUnknown} builds it.
 * 2. **One mapper from any thrown value to one response.** Route handlers do not
 *    classify failures themselves: they `catch` and hand the value to
 *    {@link storefrontErrorResponse}, so every endpoint answers with the same
 *    `StorefrontErrorBody` envelope and the browser client has exactly one shape
 *    to parse.
 * 3. **One guarded reader for a JSON request body.** A state-changing endpoint
 *    reads its body through {@link readStorefrontJsonBody} rather than through
 *    `request.json()`, because two properties of a request have to be settled
 *    before its bytes are parsed and neither is the caller's to decide: whether
 *    the body was declared as JSON at all, and how many bytes of it this
 *    process is willing to hold. Refusing either is a failure of the request,
 *    which is why the reader lives beside the errors it raises and answers in
 *    the same envelope as everything else here.
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
 * What a visitor is told when the request carried a character the database's
 * encoding cannot represent.
 *
 * It is authored here, like every other message in this module, and says what
 * the store can accept rather than what the driver reported: the driver's own
 * wording quotes the offending byte and the statement it was bound to, and
 * neither belongs in a response body.
 */
const CHARSET_MESSAGE = 'The request contained a character this storefront cannot store.';

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
 * How many bytes of a request body {@link readStorefrontJsonBody} will hold:
 * 65536, which is 64 KiB.
 *
 * No body this storefront sends comes near it. The largest of them is a
 * checkout draft - a contact, an address, a chosen shipping service, a delivery
 * note and the name of the attempt - which stays under two kilobytes with every
 * field at the longest its schema allows, and a cart change or a rating request
 * is a few hundred bytes. So the ceiling is not a limit a shopper can reach; it
 * is the answer to a caller that is not the storefront.
 *
 * It has to be stated somewhere, because a route handler has no default: a body
 * is otherwise bounded only by the memory of the machine serving it, which lets
 * whoever sent the request decide how much of that memory to spend.
 */
const MAX_BYTES = 65536;

/** What a caller is told when the body carries more bytes than are read. */
const OVERSIZE_MESSAGE =
  'The request body is larger than this storefront accepts; keep it under 64 kilobytes.';

/** What a caller is told when the body was not declared as JSON. */
const MEDIA_MESSAGE = 'This endpoint accepts a JSON request body, declared as application/json.';

/** The one media type a body may be declared as. */
const MEDIA_JSON = 'application/json';

/**
 * The encodings a `charset` parameter on that media type may name.
 *
 * A JSON body is UTF-8 (RFC 8259 §8.1) and is decoded as UTF-8 here, so a
 * request declaring a different encoding is asking for bytes to be read as
 * something they will not be read as. Refusing it is more honest than decoding
 * it anyway and reporting whatever comes out as a malformed body, and it costs
 * a caller nothing: US-ASCII is a subset of UTF-8 and is accepted, and both
 * spellings of UTF-8 in the wild are listed. A body with no `charset` parameter
 * at all - which is what every client of this store sends - is the normal case
 * and is not affected.
 */
const MEDIA_CHARSET: readonly string[] = ['utf-8', 'utf8', 'us-ascii'];

/** The only shape a `content-length` may have to be believed: digits alone. */
const DIGITS = /^\d+$/;

/** The optional quoting around a media-type parameter's value. */
const QUOTES = /^"|"$/g;

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

/**
 * The two `SQLSTATE`s that mean the client sent a character the database's
 * encoding cannot carry: `22021` (`character_not_in_repertoire`, which
 * PostgreSQL answers with for a `UTF8` parameter containing a NUL byte) and
 * `22P05` (`untranslatable_character`, which it answers with when a character
 * has no representation in the target encoding).
 *
 * They are the one family of database refusals that is the caller's mistake
 * rather than the storefront's, which is why they are the one family answered
 * with 400 instead of joining {@link DATABASE_MESSAGE}'s generic 500. Every
 * request surface validates its own characters before a query is built, so
 * reaching this mapping means a value slipped past a schema - it is defence in
 * depth, and answering it as a validation failure keeps a client-caused failure
 * from being reported as an internal one.
 *
 * Both spellings of the state are listed because the driver reports one and the
 * other appears when the encoding conversion happens on the server; matching
 * either costs nothing and missing one would answer the same mistake with two
 * different statuses.
 */
const SQL_STATE_CHARSET: readonly string[] = ['22021', '22P05'];

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
 * Prefer one of the six subclasses; construct this class directly only for a
 * code they do not cover - `OUT_OF_STOCK` and `PAYMENT_DECLINED` are the two
 * that come up, both with a status of 409 and 402 respectively chosen by the
 * service that raises them. The third, `PAYMENT_STATUS_UNKNOWN`, has a
 * constructor of its own in {@link paymentStatusUnknown}, because the body it
 * answers with is a contract rather than a service's choice.
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
 * The request body carries more bytes than the endpoint will read, so none of
 * it was parsed and nothing was written.
 *
 * It is a sibling of {@link StorefrontValidationError} rather than a variation
 * on it: the request is unacceptable for the same reason - the caller sent
 * something this endpoint does not take - and the only difference worth
 * reporting is the status, 413, which is what tells anyone reading HTTP that
 * the body's size is the problem and that shortening it is the remedy.
 *
 * The code stays `VALIDATION_FAILED`. `StorefrontErrorCode` in `@/lib/types` is
 * a closed union that the browser client's recovery paths switch on and that
 * every response body in this application is described by, so a new member
 * would be a change to a published contract for a refusal the existing member
 * already reports correctly: this request was not acceptable, and sending it
 * again unchanged will not help.
 */
export class StorefrontPayloadTooLargeError extends StorefrontError {
  /**
   * @param message A sentence telling the caller the body is too large and
   * roughly how large is acceptable. It names no limit internals.
   * @param options Optional `details` and `cause`.
   */
  constructor(message: string, options?: StorefrontErrorOptions) {
    super('VALIDATION_FAILED', 413, message, options);
    this.name = 'StorefrontPayloadTooLargeError';
  }
}

/**
 * The request declared a body this endpoint does not read: no media type at
 * all, or one that is not JSON.
 *
 * A state-changing endpoint that parses whatever it is handed, and answers on
 * the strength of the bytes happening to be JSON, cannot tell a client of this
 * store from anything else that reached the URL. So the declaration is checked,
 * and a request that does not make one is refused with 415 before its body is
 * read - which also keeps a genuinely wrong media type from being reported as a
 * field-level validation failure, a diagnosis that would send the caller
 * looking at its payload instead of at its headers.
 *
 * The code stays `VALIDATION_FAILED`, for the reason given on
 * {@link StorefrontPayloadTooLargeError}: the union is a published contract and
 * the status carries the distinction.
 */
export class StorefrontMediaTypeError extends StorefrontError {
  /**
   * @param message A sentence naming the media type the endpoint does accept.
   * @param options Optional `details` and `cause`.
   */
  constructor(message: string, options?: StorefrontErrorOptions) {
    super('VALIDATION_FAILED', 415, message, options);
    this.name = 'StorefrontMediaTypeError';
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
 * It carries `INTERNAL_ERROR`, which on a checkout means what every code other
 * than `PAYMENT_STATUS_UNKNOWN` means there: nothing was captured. So a service
 * raises this one only for an upstream answer it can read that way - a
 * dependency refusing the request it was sent - and raises
 * {@link paymentStatusUnknown} when a payment attempt's outcome cannot be ruled
 * out.
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
 * What {@link paymentStatusUnknown} needs beyond its message.
 */
export interface PaymentStatusUnknownOptions extends ErrorOptions {
  /**
   * Which dependency the unresolved attempt involved, as the same short label
   * {@link StorefrontUpstreamError} uses - `payment`. It is reported to the
   * browser inside `details`, so keep it to a word.
   */
  upstream: string;

  /**
   * The HTTP status to answer with. It defaults to 502, for the case this
   * situation usually is: an amount was sent to the processor and no readable
   * answer came back, which is a failure upstream of a healthy storefront. Pass
   * 500 for the other case - the processor did answer and approved, and this
   * application then failed to complete the order the amount was approved for -
   * because that one is the store's own.
   */
  status?: number;
}

/**
 * A payment attempt whose outcome this application cannot rule out, as the one
 * error whose code says so.
 *
 * It exists because the alternative is worse than an error: every other failure
 * a checkout answers with means no amount was captured, and a customer reads
 * that as "place the order again". Two situations do not support it - an amount
 * sent to the processor with no readable answer back, and an approval this
 * application could not write an order against - and reporting either of them
 * as one of the definite failures would tell a customer they were not charged
 * when they may have been, and invite them to be charged twice.
 *
 * The body carries the code, the message and `{ upstream, outcome: 'unknown' }`,
 * so a client that switches on the code and a developer reading a log line are
 * told the same thing. Nothing about the attempt itself is included: an amount,
 * a reference or a processor's own wording is for the store's records.
 *
 * @param message A complete sentence a customer can act on. It reaches the
 * browser verbatim, so it must say that the outcome is unresolved and what to do
 * instead of placing the order again.
 * @param options The `upstream` label, the `status` to answer with, and `cause`
 * for the log.
 *
 * @example
 * ```ts
 * throw paymentStatusUnknown('The payment service did not answer …', {
 *   upstream: 'payment',
 *   cause,
 * });
 * ```
 */
export function paymentStatusUnknown(
  message: string,
  options: PaymentStatusUnknownOptions,
): StorefrontError {
  return new StorefrontError('PAYMENT_STATUS_UNKNOWN', options.status ?? 502, message, {
    details: { upstream: options.upstream, outcome: 'unknown' },
    cause: options.cause,
  });
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
 * Whether a Prisma request error is a driver refusal of an unrepresentable
 * character, read out of the driver-adapter cause Prisma nests inside `meta`.
 *
 * A raw `pg` error carries its `SQLSTATE` as a top-level `code`, so the mapper's
 * driver branch can read it directly. A Prisma request error does not: the query
 * it wrapped failed inside the driver adapter, so the error's own `code` is the
 * generic `P2039` and the `SQLSTATE` sits at
 * `meta.driverAdapterError.cause.code` (repeated as `originalCode`). Without
 * this reader the charset mapping would be reachable only for the one service
 * that queries the pool directly, and every request that reaches the database
 * through Prisma - which is all but one of them - would answer the same caller
 * mistake with a 500.
 *
 * Every step is duck-typed against `unknown`, exactly as the branches that call
 * it are, and for the same reason: the generated Prisma client is not in version
 * control, so this module cannot import the error class to test against, and
 * `meta` is a bag whose shape belongs to the driver rather than to this
 * application. Nothing is read out of the cause except the two code fields, and
 * neither is copied into a response - the mapper's callers only learn that the
 * answer is a 400.
 *
 * @param error A caught value already known to be an object carrying a `code`.
 * @returns `true` when the nested driver cause names a charset `SQLSTATE`.
 */
function charset(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('meta' in error)) {
    return false;
  }

  const meta: unknown = error.meta;
  if (typeof meta !== 'object' || meta === null || !('driverAdapterError' in meta)) {
    return false;
  }

  const driver: unknown = meta.driverAdapterError;
  if (typeof driver !== 'object' || driver === null || !('cause' in driver)) {
    return false;
  }

  const cause: unknown = driver.cause;
  if (typeof cause !== 'object' || cause === null) {
    return false;
  }

  // The adapter reports the state twice - as `code` and as `originalCode` - and
  // which of the two is present has changed between driver releases, so either
  // one naming a charset state is enough.
  const code: unknown = 'code' in cause ? cause.code : undefined;
  const original: unknown = 'originalCode' in cause ? cause.originalCode : undefined;

  return (
    (typeof code === 'string' && SQL_STATE_CHARSET.includes(code)) ||
    (typeof original === 'string' && SQL_STATE_CHARSET.includes(original))
  );
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
 *    an unambiguous meaning for a storefront are mapped to 404 and 409, one
 *    wrapped driver refusal - a character the database's encoding cannot carry,
 *    read out of the nested driver-adapter cause by {@link charset} - is mapped
 *    to 400, and every other one joins the generic database response.
 * 4. A PostgreSQL driver error, recognised by its `SQLSTATE` code or its
 *    `severity` field: collapsed to one generic 500, except for the two
 *    {@link SQL_STATE_CHARSET} states, which are the caller's mistake and are
 *    answered with the same 400 as the wrapped form above. The other
 *    distinctions the driver draws are for the developer reading the log, and
 *    its fields cannot be forwarded - `message` may quote the statement and
 *    `detail` may quote the row that violated a constraint.
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

      // A driver refusal Prisma wrapped: the value carried a character the
      // database's encoding cannot represent, which is the caller's mistake and
      // is answered as one. No `details` accompany it - the driver does not say
      // which parameter was at fault, and naming a field here would be a guess
      // presented as a fact.
      if (charset(error)) {
        return { status: 400, body: envelope('VALIDATION_FAILED', CHARSET_MESSAGE) };
      }

      return { status: 500, body: envelope('INTERNAL_ERROR', DATABASE_MESSAGE) };
    }

    if ((typeof code === 'string' && SQL_STATE.test(code)) || 'severity' in error) {
      // The same refusal reported by the driver directly, where the `SQLSTATE`
      // is the error's own code: answered identically, so the one service that
      // queries the pool without Prisma and the ones that go through it cannot
      // report the same mistake with two different statuses.
      if (typeof code === 'string' && SQL_STATE_CHARSET.includes(code)) {
        return { status: 400, body: envelope('VALIDATION_FAILED', CHARSET_MESSAGE) };
      }

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

/* ---------------------------------------------------------------------------
 * Reading a request body
 * ------------------------------------------------------------------------- */

/**
 * What {@link readStorefrontJsonBody} accepts beyond the request itself.
 *
 * Both members are optional, and each omitted member is a decision rather than
 * an oversight: the default ceiling is the one every endpoint wants, and a
 * reader with no `unreadable` message hands unreadable bytes on as `undefined`
 * instead of refusing them.
 */
export interface StorefrontJsonBodyOptions {
  /**
   * The sentence to refuse with when the bytes are not readable JSON - an empty
   * body, a truncated object, text that is not JSON at all.
   *
   * Supply it, and unreadable bytes become a 400 through
   * {@link StorefrontValidationError} with the caught parse failure as its
   * `cause`, which is the answer three of this application's four POST
   * endpoints give. Omit it, and the call resolves to `undefined` instead, so
   * the schema behind the handler is the one that speaks: its rejection then
   * names the fields a request of that kind needs, which is a more useful 400
   * than "the body could not be read" for an endpoint whose callers are
   * services rather than forms.
   *
   * `exactOptionalPropertyTypes` is on, so choose by including or omitting the
   * property - passing it as `undefined` does not compile.
   */
  unreadable?: string;

  /**
   * A ceiling in bytes for this one call, in place of the module's
   * {@link MAX_BYTES}.
   *
   * It is here for an endpoint whose largest legitimate body is materially
   * different from the rest, so that such a case is a value at the call site
   * rather than a raised ceiling for every route. No endpoint in this
   * application needs it today; every one of them reads its body at the default.
   */
  limit?: number;
}

/**
 * Reads and parses a JSON request body, refusing the two requests a
 * state-changing endpoint must not read at all.
 *
 * This is what every POST handler in this application calls instead of
 * `request.json()`, and what it refuses before parsing anything is the whole
 * difference:
 *
 * 1. **A body that was not declared as JSON** - no `content-type` header, an
 *    empty one, `text/plain`, a form encoding - is answered with 415 and never
 *    read. Parameters on the media type are allowed and ignored, so the
 *    `application/json; charset=utf-8` a browser or a proxy may send is
 *    accepted; a `charset` naming an encoding other than
 *    {@link MEDIA_CHARSET} is refused with the same 415, because the bytes are
 *    decoded as UTF-8 whatever the request claims.
 * 2. **A body past the ceiling** is answered with 413, and the bytes past it
 *    are never held. A declared `content-length` above the ceiling is refused
 *    without reading anything at all; a body that declares no length, or
 *    declares one it then exceeds, is cut off by the count kept while it
 *    streams. Both matter: the header is the cheap case and the stream is the
 *    honest one, since a chunked request declares no length and a declared
 *    length is a claim rather than a fact.
 *
 * The body is read through `request.body`'s own reader rather than with
 * `request.json()`, `request.text()` or `request.arrayBuffer()`. Each of those
 * buffers the entire body before anything can look at its size, which is
 * precisely what has to be prevented: the size check has to happen while the
 * bytes are arriving, not after they are all in memory. When the count passes
 * the ceiling the reader is cancelled before the refusal is thrown, which
 * releases the stream and lets the server discard the remainder of the request
 * - without that, the refusal would race the caller's upload and the caller
 * could lose the response it was answered with.
 *
 * Nothing here interprets the body: it is decoded as UTF-8, parsed, and handed
 * back as `unknown` for the endpoint's own schema to validate. Nothing is
 * logged either - a body is the caller's data, and the messages this module
 * refuses with quote none of it.
 *
 * @param request The request whose body is read. It is consumed by this call,
 * so call it once per request.
 * @param options Optional `unreadable` message and `limit`; see
 * {@link StorefrontJsonBodyOptions}.
 * @returns The parsed body as `unknown`, or `undefined` when the bytes were not
 * readable JSON and no `unreadable` message was given.
 * @throws {StorefrontMediaTypeError} 415, when the body is not declared as JSON.
 * @throws {StorefrontPayloadTooLargeError} 413, when the body is larger than
 * the ceiling.
 * @throws {StorefrontValidationError} 400, when the bytes are not readable JSON
 * and an `unreadable` message was given.
 *
 * @example
 * ```ts
 * export async function POST(request: Request): Promise<Response> {
 *   try {
 *     const payload = await readStorefrontJsonBody(request, { unreadable: UNREADABLE });
 *     return Response.json(await change(cartMutationBodySchema.parse(payload)));
 *   } catch (error) {
 *     return storefrontErrorResponse(error);
 *   }
 * }
 * ```
 */
export async function readStorefrontJsonBody(
  request: Request,
  options?: StorefrontJsonBodyOptions,
): Promise<unknown> {
  const limit = options?.limit ?? MAX_BYTES;

  // The media type is the first thing settled, because it is one header read
  // and it decides whether the body is worth reading at all. Everything before
  // the first `;` is the type; what follows are parameters.
  const parts = (request.headers.get('content-type') ?? '').split(';');
  const media = (parts[0] ?? '').trim().toLowerCase();

  if (media !== MEDIA_JSON) {
    throw new StorefrontMediaTypeError(MEDIA_MESSAGE);
  }

  for (const part of parts.slice(1)) {
    const pair = part.split('=');

    if ((pair[0] ?? '').trim().toLowerCase() !== 'charset') {
      continue;
    }

    const encoding = (pair[1] ?? '').trim().toLowerCase().replace(QUOTES, '');

    if (!MEDIA_CHARSET.includes(encoding)) {
      throw new StorefrontMediaTypeError(MEDIA_MESSAGE);
    }
  }

  // A `content-length` above the ceiling is refused here, before a single byte
  // is read. A header that is absent or is not a plain count of bytes is not
  // trusted and not used: the streaming count below holds either way.
  const declared = request.headers.get('content-length');

  if (declared !== null && DIGITS.test(declared.trim()) && Number(declared.trim()) > limit) {
    throw new StorefrontPayloadTooLargeError(OVERSIZE_MESSAGE);
  }

  const stream = request.body;
  const chunks: Uint8Array[] = [];
  let total = 0;

  // A null body is a request that carries none; it is left to the unreadable
  // branch below, which is what the endpoints already answer an empty body with.
  if (stream !== null) {
    const reader = stream.getReader();

    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      total += chunk.value.byteLength;

      if (total > limit) {
        // Cancelled rather than merely abandoned: this releases the reader and
        // lets the server drop what is still arriving, so the 413 below is
        // deliverable instead of racing the rest of the upload.
        await reader.cancel();

        throw new StorefrontPayloadTooLargeError(OVERSIZE_MESSAGE);
      }

      chunks.push(chunk.value);
    }
  }

  // One allocation of exactly the bytes that arrived - at most the ceiling, so
  // this is bounded by the constant above and never by the request.
  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    // `fatal` so that bytes which are not UTF-8 are a failure rather than a
    // string full of replacement characters: a body that cannot be decoded is
    // unreadable, and saying so is better than parsing something the caller did
    // not send.
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

    return value;
  } catch (cause) {
    if (options?.unreadable !== undefined) {
      throw new StorefrontValidationError(options.unreadable, { cause });
    }

    return undefined;
  }
}
