/**
 * Shared parameterised query client.
 *
 * Wraps node-postgres so service code never builds SQL by string
 * concatenation. The same interface is consumed by the action audit
 * recorder (FEAT.MACGRUBER.6), the friction writer (FEAT.MACGRUBER.7),
 * and the poller's unhandled-failures query (FEAT.MACGRUBER.9).
 *
 * Establishes the client referenced as "the shared parameterised query
 * client established in FEAT.MACGRUBER.2" by sibling clauses.
 */

export interface QueryResult<R = unknown> {
  rows: R[];
}

export interface ParamQueryClient {
  query<R = unknown>(text: string, params: unknown[]): Promise<QueryResult<R>>;
}

export interface PoolLike {
  query(text: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface DbConfig {
  connectionString: string;
  applicationName?: string;
  max?: number;
  idleTimeoutMillis?: number;
}

export interface PoolFactory {
  (config: DbConfig): PoolLike;
}

export interface MacgruberDb extends ParamQueryClient {
  close(): Promise<void>;
}

let defaultFactory: PoolFactory | null = null;

export function registerPoolFactory(factory: PoolFactory): void {
  defaultFactory = factory;
}

export function createDb(config: DbConfig, factory?: PoolFactory): MacgruberDb {
  const f = factory ?? defaultFactory;
  if (!f) {
    throw new Error(
      'no pool factory registered; call registerPoolFactory or pass one in (lib/db.ts)',
    );
  }
  const pool = f(config);
  return {
    async query<R = unknown>(text: string, params: unknown[]): Promise<QueryResult<R>> {
      const result = await pool.query(text, params);
      return { rows: result.rows as R[] };
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
