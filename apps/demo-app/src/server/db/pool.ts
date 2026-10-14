/**
 * The storefront's PostgreSQL connection pool.
 *
 * Every database access in this application goes through this one pool: the
 * Prisma client in `./prisma.ts` is built over it with the `pg` driver
 * adapter, and the handful of statements that run as raw SQL run on it
 * directly. Sharing a single pool is what keeps those two styles of access on
 * the same connections, the same limits and the same lifetime, instead of two
 * pools competing for the database's connection slots.
 *
 * Constructing the pool opens nothing. `pg` connects on the first query, so
 * importing this module performs no I/O and reads nothing but `DATABASE_URL` -
 * which is what lets `next build` and `tsc -b` succeed on a fresh checkout
 * with no database running and no credentials configured. An absent
 * `DATABASE_URL` is deliberately not an error here: it surfaces as a
 * connection failure on the first query, where a route handler can turn it
 * into a response, rather than as a crash at import time.
 */

import { Pool } from 'pg';

declare global {
  /**
   * The pool this process has already opened, if any.
   *
   * `next dev` re-evaluates a server module whenever it or one of its
   * dependencies changes. A pool kept in module scope alone would be replaced
   * on every one of those reloads while the previous pool held its clients, so
   * an afternoon of editing would end in "too many clients already". Parking
   * it on `globalThis` outlives module identity and keeps one pool per
   * process.
   */
  var __lumenpool: Pool | undefined;
}

/**
 * Builds the pool.
 *
 * The options are stated rather than left to the driver's defaults, and are
 * sized for how this application actually runs - one server process against
 * one local PostgreSQL: eight clients are more than a storefront serving a
 * single visitor checks out at once, a thirty-second idle window keeps a warm
 * client between page views so a query's measured time is not dominated by
 * connection setup, and a five-second connection timeout makes a request fail
 * outright when nothing is listening instead of hanging.
 */
function open(): Pool {
  const opened = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // `pg` reports a failure on an idle client - a dropped connection, a server
  // restart - on the pool itself. The pool discards that client on its own, so
  // there is nothing to recover here; the listener exists because an 'error'
  // event with no listener is an uncaught exception that would take the whole
  // server process down. Only the message is logged: an error's remaining
  // fields can carry statement text and row values.
  opened.on('error', (error: Error) => {
    console.error('Lumen Supply: idle database client dropped:', error.message);
  });

  return opened;
}

/** The single `pg.Pool` this application queries through. */
export const pool: Pool = globalThis.__lumenpool ?? open();

// Cached unconditionally rather than only outside production: a production
// server evaluates this module once, so the assignment costs a single property
// write and keeps the reload path and the deployed path identical.
globalThis.__lumenpool = pool;
