/**
 * The studio's two database handles, declared once here and imported by every module that reads or
 * writes a firing cycle. Each driver is opened at module level so a kiln log module holds a handle
 * rather than building one of its own.
 */

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

/** Generated client for the modelled tables: kilns, firing cycles and their ramp steps. */
export const prisma = new PrismaClient();

/** Pooled driver for the hand-written statements that total firing time per kiln. */
export const pool = new Pool({ connectionString: process.env.KILN_STUDIO_DATABASE_URL });
