/*
 * Hand-written local stand-in for the node-postgres client surface: zero dependencies and
 * zero I/O, every member resolving an in-memory value, so this corpus parses with nothing
 * installed on disk. It exists only as ts-morph input for the code-analysis indexing
 * fixture, whose extractors read `pool.query`, `pool.connect`, `client.query` and
 * `client.release` call sites out of the sibling modules.
 */

/** What a statement resolves to: the rows it returned, and how many rows those are. */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/**
 * Construction options for {@link Pool}. Deliberately limited to pool-sizing fields: this
 * fixture names no database, no machine and no credential of any kind.
 */
export interface PoolConfig {
  max?: number;
  idleTimeoutMillis?: number;
  allowExitOnIdle?: boolean;
}

/** A connection borrowed from a {@link Pool} with `connect()` and handed back with `release()`. */
export interface PoolClient {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

/** The pooled handle the fixture's datastore module constructs once at module scope. */
export class Pool {
  /** The options this pool was constructed with; kept for realism and never acted upon. */
  readonly options: PoolConfig;

  constructor(options: PoolConfig = {}) {
    this.options = options;
  }

  /**
   * Runs a parameterised statement. The statement and its values are accepted and then
   * discarded (the `void` discards state that explicitly), and an empty result is resolved,
   * so nothing is sent anywhere and no state is kept between calls.
   */
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
    void text;
    void values;
    const result: QueryResult<T> = { rows: [], rowCount: 0 };
    return Promise.resolve(result);
  }

  /** Borrows a connection. The returned handle is a plain object, safe to obtain repeatedly. */
  connect(): Promise<PoolClient> {
    const client: PoolClient = {
      query<T = Record<string, unknown>>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<T>> {
        void text;
        void values;
        const result: QueryResult<T> = { rows: [], rowCount: 0 };
        return Promise.resolve(result);
      },
      release(): void {},
    };
    return Promise.resolve(client);
  }

  /** Closes the pool. A no-op here, kept because real callers conventionally have one. */
  end(): Promise<void> {
    return Promise.resolve();
  }
}
