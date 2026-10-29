import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { generateCouponCode } from '../src/domain/coupon-code.js';
import { calculateTotals, paise } from '../src/domain/money.js';

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
 * Inserts a coherent order directly, in one transaction and in the D9 lock
 * order: one `sku-sticker-pack` line at its current price, totals from
 * `calculateTotals()`, the matching quote and quote line, and that product's
 * stock decremented by 1. With `redeemCoupon`, the order also spends that
 * coupon (conditional update, as confirm does) and snapshots it. The
 * placement number comes from the store_stats counter, so a fixture never
 * collides with a real confirm on UNIQUE(placement_number) and the counter
 * keeps equalling the number of orders.
 */
export async function insertOrderFixture(
  pool: pg.Pool,
  { redeemCoupon }: { redeemCoupon?: string } = {},
): Promise<string> {
  return withTransaction(pool, async (client) => {
    const orderId = randomUUID();
    const cart = await client.query<{ id: string }>("INSERT INTO carts (status) VALUES ('CHECKED_OUT') RETURNING id");
    const cartId = cart.rows[0]!.id;

    let coupon: { id: string; code: string; percent: number } | null = null;
    if (redeemCoupon !== undefined) {
      const redeemed = await client.query<{ id: string; code: string; percent: number }>(
        `UPDATE coupons SET redeemed_order_id = $1, redeemed_at = now()
          WHERE code = $2 AND redeemed_order_id IS NULL RETURNING id, code, percent`,
        [orderId, redeemCoupon],
      );
      if (redeemed.rows.length === 0) throw new Error(`fixture: coupon ${redeemCoupon} is missing or already redeemed`);
      coupon = redeemed.rows[0]!;
    }

    const product = await client.query<{ unit_price_paise: number }>(
      `UPDATE products SET stock = stock - 1, updated_at = now()
        WHERE id = 'sku-sticker-pack' AND stock >= 1 RETURNING unit_price_paise`,
    );
    if (product.rows.length === 0) throw new Error('fixture: sku-sticker-pack is out of stock');
    const totals = calculateTotals(
      [{ productId: 'sku-sticker-pack', name: 'Sticker Pack', unitPricePaise: paise(product.rows[0]!.unit_price_paise), quantity: 1 }],
      coupon?.percent ?? null,
    );
    const line = totals.lines[0]!;

    const quote = await client.query<{ id: string }>(
      `INSERT INTO checkout_quotes
         (cart_id, cart_version, coupon_id, coupon_percent, subtotal_paise, discount_paise, total_paise)
       VALUES ($1, 0, $2, $3, $4, $5, $6) RETURNING id`,
      [cartId, coupon?.id ?? null, coupon?.percent ?? null, totals.subtotalPaise, totals.discountPaise, totals.totalPaise],
    );
    const quoteId = quote.rows[0]!.id;
    await client.query(
      `INSERT INTO quote_lines (quote_id, product_id, product_name, unit_price_paise, quantity, line_total_paise)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [quoteId, line.productId, line.name, line.unitPricePaise, line.lineTotalPaise],
    );

    const stats = await client.query<{ placed_orders: number }>(
      'UPDATE store_stats SET placed_orders = placed_orders + 1 RETURNING placed_orders',
    );
    await client.query(
      `INSERT INTO orders (id, cart_id, quote_id, placement_number, subtotal_paise,
                           coupon_code, coupon_percent, discount_paise, total_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        orderId,
        cartId,
        quoteId,
        stats.rows[0]!.placed_orders,
        totals.subtotalPaise,
        coupon?.code ?? null,
        coupon?.percent ?? null,
        totals.discountPaise,
        totals.totalPaise,
      ],
    );
    await client.query(
      `INSERT INTO order_lines (order_id, product_id, product_name, unit_price_paise, quantity, line_total_paise)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [orderId, line.productId, line.name, line.unitPricePaise, line.lineTotalPaise],
    );
    return orderId;
  });
}

/**
 * An unredeemed coupon, or with `redeemed` one spent by a second fixture order.
 * Returns its code. The milestone is the next free number, NOT aligned with
 * placement k x n, so do not use this in admin-generation tests (task 8): those
 * need coupons earned through real placements.
 */
export async function insertCouponFixture(
  pool: pg.Pool,
  { percent = 10, redeemed = false }: { percent?: number; redeemed?: boolean } = {},
): Promise<string> {
  const code = generateCouponCode();
  const milestoneOrderId = await insertOrderFixture(pool);
  await pool.query(
    `INSERT INTO coupons (code, percent, milestone, milestone_order_id, source)
     VALUES ($1, $2, (SELECT COALESCE(max(milestone), 0) + 1 FROM coupons), $3, 'ADMIN')`,
    [code, percent, milestoneOrderId],
  );
  if (redeemed) await insertOrderFixture(pool, { redeemCoupon: code });
  return code;
}

type TestApp = Awaited<ReturnType<typeof createTestApp>>['app'];

/** A new cart holding the given `[productId, quantity]` lines, built through the API. */
export async function cartWith(app: TestApp, ...lines: Array<[string, number]>): Promise<string> {
  const cartId: string = (await app.inject({ method: 'POST', url: '/carts' })).json().id;
  for (const [productId, quantity] of lines) {
    const res = await app.inject({ method: 'PUT', url: `/carts/${cartId}/items/${productId}`, payload: { quantity } });
    if (res.statusCode !== 200) throw new Error(`cartWith: PUT ${productId} x${quantity} gave ${res.statusCode}`);
  }
  return cartId;
}

export function requestQuote(app: TestApp, cartId: string, couponCode?: string) {
  return app.inject({
    method: 'POST',
    url: `/carts/${cartId}/checkout/quote`,
    payload: couponCode === undefined ? {} : { couponCode },
  });
}

export function confirm(app: TestApp, cartId: string, quoteId: string) {
  return app.inject({ method: 'POST', url: `/carts/${cartId}/checkout`, payload: { quoteId } });
}

/**
 * Stock each product starts with. The invariant checker's only source of seed
 * stock; never derive it from the current `products` table. A test in
 * db.test.ts checks it against migrations/002_seed.sql.
 */
export const SEED_STOCK: Readonly<Record<string, number>> = {
  'sku-tshirt': 100,
  'sku-mug': 50,
  'sku-notebook': 200,
  'sku-hoodie': 25,
  'sku-sticker-pack': 500,
  'sku-limited-sneaker': 2,
};

/**
 * T15: the invariants every test that places orders must leave intact, over
 * every order in the database (fixture orders included):
 *  - I1/I2: per product, stock + Σ sold = SEED_STOCK, and stock is not negative
 *  - I5:    orders carrying a coupon and redeemed coupons match one to one
 *  - I8:    per order, subtotal = Σ line totals and total = subtotal - discount
 *  - I9:    the counter equals the order count, and placements are exactly 1..N
 *
 * Rule for any file that calls this: never change stock with direct SQL unless
 * it is restored in `finally`. Orders are insert-only, so consumed stock cannot
 * be given back; give each test that drains a product its own product.
 */
export async function expectInvariants(pool: pg.Pool): Promise<void> {
  const products = await pool.query<{ id: string; stock: number; sold: number }>(
    `SELECT p.id, p.stock, COALESCE(sum(ol.quantity), 0)::int AS sold
       FROM products p LEFT JOIN order_lines ol ON ol.product_id = p.id
      GROUP BY p.id ORDER BY p.id`,
  );
  expect(products.rows.map((r) => r.id)).toEqual(Object.keys(SEED_STOCK).sort());
  for (const row of products.rows) {
    expect(row.stock, `${row.id} stock is negative`).toBeGreaterThanOrEqual(0);
    expect(row.stock + row.sold, `${row.id}: stock + sold != seed stock`).toBe(SEED_STOCK[row.id]);
  }

  const unmatchedOrders = await pool.query(
    `SELECT o.id FROM orders o
      WHERE o.coupon_code IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM coupons c WHERE c.code = o.coupon_code AND c.redeemed_order_id = o.id)`,
  );
  expect(unmatchedOrders.rows, 'orders whose coupon is not redeemed by them').toEqual([]);
  const unmatchedCoupons = await pool.query(
    `SELECT c.code FROM coupons c
      WHERE c.redeemed_order_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = c.redeemed_order_id AND o.coupon_code = c.code)`,
  );
  expect(unmatchedCoupons.rows, 'redeemed coupons whose order does not carry them').toEqual([]);

  const badTotals = await pool.query(
    `SELECT o.id FROM orders o
      WHERE o.subtotal_paise <> COALESCE((SELECT sum(line_total_paise) FROM order_lines WHERE order_id = o.id), -1)
         OR o.total_paise <> o.subtotal_paise - o.discount_paise`,
  );
  expect(badTotals.rows, 'orders whose totals are inconsistent').toEqual([]);

  const counter = await pool.query<{ placed: number; orders: number; min: number | null; max: number | null }>(
    `SELECT (SELECT placed_orders FROM store_stats) AS placed, count(*)::int AS orders,
            min(placement_number) AS min, max(placement_number) AS max
       FROM orders`,
  );
  const { placed, orders, min, max } = counter.rows[0]!;
  expect(placed, 'counter != order count').toBe(orders);
  // UNIQUE(placement_number) plus min 1 and max N makes the set exactly 1..N.
  if (orders > 0) expect([min, max], 'placements are not 1..N').toEqual([1, orders]);
}
