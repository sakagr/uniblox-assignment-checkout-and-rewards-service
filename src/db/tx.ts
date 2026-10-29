import type pg from 'pg';

/**
 * Every write path runs through withTransaction.
 *
 * Inside `fn`, use ONLY the client it receives. Never call `pool.query`: that
 * runs on a different connection, outside the transaction and its locks.
 *
 * Global lock order (D9), for any path touching these rows:
 *
 *   cart -> coupon -> products (sorted by id) -> store_stats
 *
 * Admin coupon generation takes store_stats -> coupon insert; it never locks
 * an existing coupon row, so it cannot form a cycle with confirm.
 */

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface TransactionOptions {
  isolation?: IsolationLevel;
  readOnly?: boolean;
}

// Fixed lookup: the isolation level is never interpolated from the caller's string.
const BEGIN_SQL: Record<IsolationLevel, string> = {
  'READ COMMITTED': 'BEGIN ISOLATION LEVEL READ COMMITTED',
  'REPEATABLE READ': 'BEGIN ISOLATION LEVEL REPEATABLE READ',
  SERIALIZABLE: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
};

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  { isolation = 'READ COMMITTED', readOnly = false }: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  // pg-pool destroys the client when release() gets a truthy argument.
  let destroyWith: Error | undefined;

  try {
    await client.query(`${BEGIN_SQL[isolation]}${readOnly ? ' READ ONLY' : ''}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // The connection is in an unknown state: destroy it rather than return it to the pool.
      destroyWith = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(destroyWith);
  }
}
