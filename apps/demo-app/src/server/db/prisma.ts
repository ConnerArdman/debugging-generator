/**
 * The storefront's single Prisma client, built through the `pg` driver adapter
 * (`PrismaPg`) over the shared pool in `./pool`, so ORM queries and raw-SQL
 * statements run on one set of connections. Prisma 7 requires a driver adapter
 * and rejects a client constructed without one.
 *
 * Importing this module constructs the client and, through `./pool`, a pool
 * configured from `DATABASE_URL`. Neither connects until the first query, so
 * builds and type checks need no database, and a missing or wrong URL surfaces
 * as a failed query inside a request.
 *
 * `PrismaClient` is imported from the client generated into
 * `src/generated/prisma`, not from `@prisma/client`, which under the
 * `prisma-client` generator ships only the runtime.
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
