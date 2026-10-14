/**
 * Datastore module of the `sample-next-app` indexing fixture: the one declaration site of
 * its two database handles, built from the local stubs beside this file so nothing is
 * installed, built or executed. `prisma` and `pool` deliberately carry the names the real
 * libraries use, because the code-analysis extractors key on exactly those identifiers,
 * while every domain name around them stays invented (gauge, reading, basin, station).
 */

import { Pool } from './stubs/pg';
import { PrismaClient } from './stubs/prisma-client';

export const prisma = new PrismaClient();

export const pool = new Pool({ max: 4, idleTimeoutMillis: 10000 });
