/**
 * The storefront's Prisma client.
 *
 * Every module in the server layer that speaks to the database through the ORM
 * queries through this one client, and this client is built over the one pool
 * in `./pool`: `PrismaPg` hands Prisma the same `pg` connections that the
 * handful of statements written as raw SQL run on directly. One pool underneath
 * both styles of access is the point - they share its connections, its limit
 * and its lifetime, and a query's measured time means the same thing whichever
 * style issued it. Building a client from a connection string instead would
 * work against the database just as well and would quietly be a second,
 * independent set of connections.
 *
 * The adapter is a requirement rather than a preference. Prisma 7 carries no
 * query engine inside the client, so a driver adapter is how a client reaches a
 * database at all, and `new PrismaClient()` with no options is rejected outright
 * rather than falling back to a URL. The schema states only the datasource's
 * provider to match: the connection URL is the Prisma CLI's business through
 * this workspace's prisma.config.ts, and the application's through `./pool`.
 * Nothing about it is this module's business, which is why no environment
 * variable is read here.
 *
 * Constructing the client opens nothing. Prisma connects on the first query, so
 * importing this module performs no I/O, reads no configuration and cannot
 * fail. That is what lets `next build` and `tsc -b` run to completion on a
 * checkout with no database and nothing configured - every page of this
 * application renders dynamically, so a build never queries - and it leaves a
 * misconfigured environment to surface as a failed query inside a request,
 * where a route handler can answer it, instead of as a server that will not
 * start.
 *
 * `PrismaClient` comes from the client this workspace's schema generates into
 * `src/generated/prisma`, never from the `@prisma/client` package: under the
 * `prisma-client` generator that package ships the runtime alone, and importing
 * the class from it is the mistake that ends in a client which "did not
 * initialize yet".
 */

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '@/generated/prisma/client';

import { pool } from './pool';

declare global {
  /**
   * The client this process has already built, if any.
   *
   * `next dev` re-evaluates a server module whenever it or one of its
   * dependencies changes. A client held in module scope alone would be built
   * again on every one of those reloads, and each of the replaced clients would
   * keep the connections it had checked out of the pool along with the prepared
   * statements it had registered on them - so an afternoon of editing would end
   * against a pool with nothing left to hand out. Parking the client on
   * `globalThis` outlives module identity and keeps one client per process,
   * exactly as `./pool` does for the pool underneath it.
   */
  var __lumenprisma: PrismaClient | undefined;
}

/** The single Prisma client this application queries through. */
export const prisma: PrismaClient =
  globalThis.__lumenprisma ?? new PrismaClient({ adapter: new PrismaPg(pool) });

// Cached unconditionally rather than only outside production, for the reason
// `./pool` gives for the pool: a production server evaluates this module once,
// so the assignment costs a single property write and keeps the reload path and
// the deployed path identical.
globalThis.__lumenprisma = prisma;
