/**
 * Hand-written local stand-in for the shape of a generated data-access client,
 * present only as ts-morph input for the code-analysis indexing fixture: no
 * dependencies, no I/O, never installed, never built and never executed. Its
 * delegates resolve fixed in-memory values, so the corpus can carry realistic
 * `prisma.gauge.findMany(...)` and `prisma.reading.create(...)` call sites.
 */

/** A measuring gauge installed in a basin. */
export interface GaugeRow {
  id: string;
  label: string;
  basinId: string;
  installedAt: Date;
}

/** One water-level sample taken from a gauge. */
export interface ReadingRow {
  id: string;
  gaugeId: string;
  levelCm: number;
  capturedAt: Date;
}

/** Filter, page window and field projection, kept permissive on purpose. */
export interface FindManyArgs {
  where?: Record<string, unknown>;
  take?: number;
  skip?: number;
  select?: Record<string, boolean>;
}

/** Write payload, equally permissive so the service layer is never blocked. */
export interface CreateArgs {
  data: Record<string, unknown>;
}

export interface GaugeDelegate {
  findMany(args?: FindManyArgs): Promise<GaugeRow[]>;
}

export interface ReadingDelegate {
  create(args: CreateArgs): Promise<ReadingRow>;
}

/** Construction options: credential-free by design, and ignored by the stub. */
export interface PrismaClientOptions {
  log?: readonly string[];
  adapter?: unknown;
}

/**
 * Delegates are readonly instance fields, never prototype methods, so a call
 * reads as the nested member access the fixture's data-access sites rely on.
 */
export class PrismaClient {
  readonly gauge: GaugeDelegate = { findMany: () => Promise.resolve([]) };

  readonly reading: ReadingDelegate = {
    create: () =>
      Promise.resolve({
        id: 'reading-0',
        gaugeId: 'gauge-0',
        levelCm: 0,
        capturedAt: new Date(0),
      }),
  };

  constructor(readonly options: PrismaClientOptions = {}) {}

  $disconnect(): Promise<void> {
    return Promise.resolve();
  }
}
