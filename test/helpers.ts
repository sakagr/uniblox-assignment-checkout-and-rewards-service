import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { generateCouponCode } from '../src/domain/coupon-code.js';

/** Defaults plus TEST_DATABASE_URL; the developer's shell env never leaks in otherwise. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    ...(process.env.TEST_DATABASE_URL ? { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
  });
  return { ...base, databaseUrl: base.testDatabaseUrl, ...overrides };
}

/**
 * A real app on a real pool against the test database. Add test-only routes to
 * `app` before the first inject(); `close()` shuts down the app and pool.
 */
export async function createTestApp(overrides: Partial<Config> = {}) {
  const config = testConfig(overrides);
  const pool = createPool(config);
  const app = await buildApp({ config, pool });
  return {
    app,
    pool,
    config,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/** Drops and re-applies the schema on the test database. Call in `beforeAll`. */
export async function setupTestDb(): Promise<void> {
  await migrate(testConfig().testDatabaseUrl, { reset: true });
}

/** Runs `fn(0..n-1)` concurrently. */
export function parallel<T>(n: number, fn: (index: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
}

/**
 * Inserts a checked-out cart, its quote and an order directly. The placement
 * number comes from the store_stats counter in the same transaction, so a
 * fixture never collides with a real confirm on UNIQUE(placement_number) and
 * the counter keeps equalling the number of orders.
 */
export async function insertOrderFixture(pool: pg.Pool): Promise<string> {
  return withTransaction(pool, async (client) => {
    const orderId = randomUUID();
    const cart = await client.query<{ id: string }>("INSERT INTO carts (status) VALUES ('CHECKED_OUT') RETURNING id");
    const cartId = cart.rows[0]!.id;
    const quote = await client.query<{ id: string }>(
      `INSERT INTO checkout_quotes (cart_id, cart_version, subtotal_paise, discount_paise, total_paise)
       VALUES ($1, 0, 100, 0, 100) RETURNING id`,
      [cartId],
    );
    const stats = await client.query<{ placed_orders: number }>(
      'UPDATE store_stats SET placed_orders = placed_orders + 1 RETURNING placed_orders',
    );
    await client.query(
      `INSERT INTO orders (id, cart_id, quote_id, placement_number, subtotal_paise, discount_paise, total_paise)
       VALUES ($1, $2, $3, $4, 100, 0, 100)`,
      [orderId, cartId, quote.rows[0]!.id, stats.rows[0]!.placed_orders],
    );
    return orderId;
  });
}

/**
 * An unredeemed coupon, or with `redeemed` one spent by a second fixture order.
 * Returns its code. The milestone is the next free number.
 */
export async function insertCouponFixture(
  pool: pg.Pool,
  { percent = 10, redeemed = false }: { percent?: number; redeemed?: boolean } = {},
): Promise<string> {
  const code = generateCouponCode();
  const milestoneOrderId = await insertOrderFixture(pool);
  const redeemedBy = redeemed ? await insertOrderFixture(pool) : null;
  await pool.query(
    `INSERT INTO coupons (code, percent, milestone, milestone_order_id, source, redeemed_order_id, redeemed_at)
     VALUES ($1, $2, (SELECT COALESCE(max(milestone), 0) + 1 FROM coupons), $3, 'ADMIN', $4,
             CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END)`,
    [code, percent, milestoneOrderId, redeemedBy],
  );
  return code;
}
