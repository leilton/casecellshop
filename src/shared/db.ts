import pg from 'pg';
import { DependencyError, isConnectionError } from './errors';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 20, connectionTimeoutMillis: 2000 });
  // An idle client losing its connection must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);
  return pool;
}

/** BEGIN/COMMIT with ROLLBACK on any error; the client is always released. */
export async function withTx<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  let client: DbClient;
  try {
    client = await db.connect();
  } catch (err) {
    throw new DependencyError('postgres', err);
  }
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isConnectionError(err)) throw new DependencyError('postgres', err);
    throw err;
  } finally {
    client.release();
  }
}
