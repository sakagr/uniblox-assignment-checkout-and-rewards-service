import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, parseSafeInteger } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { SEED_STOCK, setupTestDb, testConfig } from './helpers.js';

const config = testConfig();
const pool = createPool({ databaseUrl: config.databaseUrl, pgPoolMax: 5 });

beforeAll(setupTestDb);
afterAll(() => pool.end());

describe('parseSafeInteger', () => {
  it('accepts the safe-integer bounds', () => {
    expect(parseSafeInteger('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseSafeInteger('-9007199254740991')).toBe(Number.MIN_SAFE_INTEGER);
    expect(parseSafeInteger('0')).toBe(0);
  });

  it.each(['9007199254740992', '-9007199254740992', '1.5', '', 'abc', '1e3'])(
    'rejects "%s"',
    (text) => {
      expect(() => parseSafeInteger(text)).toThrow(RangeError);
    },
  );
});

describe('pool type parsers', () => {
  it('returns int8 and numeric aggregates as numbers', async () => {
    const { rows } = await pool.query<{ big: number; total: number }>(
      'SELECT 9007199254740991::int8 AS big, sum(g)::bigint AS total FROM generate_series(1, 4) g',
    );
    expect(rows[0]).toEqual({ big: 9007199254740991, total: 10 });

    const numeric = await pool.query<{ n: number }>('SELECT sum(g::numeric) AS n FROM generate_series(1, 4) g');
    expect(numeric.rows[0]?.n).toBe(10);
  });

  it('fails loudly on an int8 beyond the safe range', async () => {
    await expect(pool.query('SELECT 9007199254740992::int8')).rejects.toThrow(/safe-integer/);
  });

  it('leaves other types alone', async () => {
    const { rows } = await pool.query<{ i: number; t: string }>("SELECT 7::int4 AS i, 'x'::text AS t");
    expect(rows[0]).toEqual({ i: 7, t: 'x' });
  });

  it('does not change the global pg.types parser', () => {
    expect(pg.types.getTypeParser(20)('123')).toBe('123');
  });
});

describe('withTransaction', () => {
  const countCarts = async () =>
    (await pool.query<{ n: number }>('SELECT count(*)::bigint AS n FROM carts')).rows[0]?.n;

  it('commits when fn resolves', async () => {
    const before = await countCarts();
    const id = await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>('INSERT INTO carts DEFAULT VALUES RETURNING id');
      return rows[0]?.id;
    });
    expect(id).toBeTruthy();
    expect(await countCarts()).toBe((before ?? 0) + 1);
  });

  it('rolls back and rethrows the original error when fn throws', async () => {
    const before = await countCarts();
    const boom = new Error('boom');
    await expect(
      withTransaction(pool, async (client) => {
        await client.query('INSERT INTO carts DEFAULT VALUES');
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await countCarts()).toBe(before);
  });

  it('applies isolation and read-only options', async () => {
    const show = (name: string) =>
      withTransaction(
        pool,
        async (client) => (await client.query<Record<string, string>>(`SHOW ${name}`)).rows[0]?.[name],
        { isolation: 'REPEATABLE READ', readOnly: true },
      );
    expect(await show('transaction_isolation')).toBe('repeatable read');
    expect(await show('transaction_read_only')).toBe('on');

    const defaults = await withTransaction(pool, async (client) =>
      (await client.query<{ transaction_isolation: string; transaction_read_only: string }>(
        'SELECT current_setting($1) AS transaction_isolation, current_setting($2) AS transaction_read_only',
        ['transaction_isolation', 'transaction_read_only'],
      )).rows[0],
    );
    expect(defaults).toEqual({ transaction_isolation: 'read committed', transaction_read_only: 'off' });
  });

  it('rejects writes in a read-only transaction with SQLSTATE 25006', async () => {
    const error = await withTransaction(
      pool,
      (client) => client.query('INSERT INTO carts DEFAULT VALUES'),
      { readOnly: true },
    ).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe('25006');
  });

  it('destroys the client when ROLLBACK itself fails, and rethrows the original error', async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [] };
    });
    const stubPool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
    const original = new Error('original');

    await expect(
      withTransaction(stubPool, async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('returns a healthy client to the pool instead of destroying it', async () => {
    const release = vi.fn();
    const query = vi.fn(async () => ({ rows: [] }));
    const stubPool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;

    await withTransaction(stubPool, async () => 1);
    await withTransaction(stubPool, async () => {
      throw new Error('fn failed, ROLLBACK fine');
    }).catch(() => {});

    expect(release).toHaveBeenCalledTimes(2);
    for (const call of release.mock.calls) expect(call[0]).toBeUndefined();
  });
});

describe('SEED_STOCK', () => {
  it('matches migrations/002_seed.sql, the source the invariant checker relies on', () => {
    const sql = readFileSync(new URL('../migrations/002_seed.sql', import.meta.url), 'utf8');
    const seeded = [...sql.matchAll(/\('(sku-[a-z0-9-]+)',\s*'[^']*',\s*\d+,\s*(\d+)\)/g)].map(
      (m) => [m[1], Number(m[2])] as const,
    );
    expect(seeded.length).toBeGreaterThan(0);
    expect(Object.fromEntries(seeded)).toEqual(SEED_STOCK);
  });
});
