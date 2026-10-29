import pg from 'pg';

const INT8_OID = 20;
const NUMERIC_OID = 1700;

/**
 * The one parser for int8 and numeric (DECISIONS §5). pg delivers both as
 * strings; anything that is not a safe integer fails loudly rather than
 * silently losing precision.
 */
export function parseSafeInteger(text: string): number {
  if (!/^-?\d+$/.test(text)) {
    throw new RangeError(`expected an integer from the database, got "${text}"`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`database integer ${text} is outside the safe-integer range`);
  }
  return value;
}

export interface PoolOptions {
  databaseUrl: string;
  pgPoolMax: number;
}

export function createPool({ databaseUrl, pgPoolMax }: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: pgPoolMax,
    // Per-pool, not pg.types.setTypeParser, so nothing global changes.
    types: {
      getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
        oid === INT8_OID || oid === NUMERIC_OID
          ? parseSafeInteger
          : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser,
    },
  });

  // An error on an idle client would otherwise crash the process.
  pool.on('error', (error) => {
    console.error('idle pg client error:', error.message);
  });

  return pool;
}
