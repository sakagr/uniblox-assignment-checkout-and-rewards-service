// Own file, own database reset: "placements exactly 1..20" needs a fresh counter, and the
// milestone = placement / n mapping needs one n for every order in the database.
//
// Stock ownership (orders are insert-only, so consumed stock cannot be restored):
//   sku-tshirt  T13 (20 x 1 of 100, never drained)
// No direct stock or price SQL in this file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cartWith, confirm, createTestApp, expectInvariants, parallel, requestQuote, setupTestDb } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  await setupTestDb();
  // The pool must be at least as large as the fan-out, or confirms would queue instead of overlapping.
  ctx = await createTestApp({ couponEveryNOrders: 5, autoGenerateCoupons: true, pgPoolMax: 20 });
});

afterAll(() => ctx.close());

describe('milestone coupons under concurrency', () => {
  it('T13: 20 parallel confirms with n = 5 place orders 1..20 and earn exactly 4 coupons, on 5/10/15/20', async () => {
    const carts = await parallel(20, () => cartWith(ctx.app, ['sku-tshirt', 1]));
    const quotes = await parallel(20, async (i) => {
      const res = await requestQuote(ctx.app, carts[i]!);
      expect(res.statusCode).toBe(201);
      return res.json().quoteId as string;
    });

    const results = await parallel(20, (i) => confirm(ctx.app, carts[i]!, quotes[i]!));
    for (const r of results) expect(r.statusCode).toBe(201);

    // No gaps, no duplicates: the counter hands out 1..20 exactly once each (I9).
    const placements = await ctx.pool.query<{ placement_number: number }>(
      'SELECT placement_number FROM orders ORDER BY placement_number',
    );
    expect(placements.rows.map((r) => r.placement_number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    // Exactly the orders at 5/10/15/20 report an earned coupon, whatever order the confirms finished in.
    const earnedByOrder = new Map(
      results.map((r) => [r.json().order.id as string, r.json().earnedCoupon as { code: string; milestone: number } | null]),
    );
    const earnedPlacements = (
      await ctx.pool.query<{ id: string; placement_number: number }>('SELECT id, placement_number FROM orders ORDER BY placement_number')
    ).rows.filter((o) => earnedByOrder.get(o.id) !== null);
    expect(earnedPlacements.map((o) => o.placement_number)).toEqual([5, 10, 15, 20]);

    // Exactly 4 coupons (I6), AUTO, linked to those orders and unspent.
    const coupons = await ctx.pool.query(
      `SELECT c.milestone, c.source, o.placement_number, c.redeemed_order_id, c.code, o.id AS order_id
         FROM coupons c JOIN orders o ON o.id = c.milestone_order_id ORDER BY c.milestone`,
    );
    expect(coupons.rows.map(({ code: _code, order_id: _orderId, ...rest }) => rest)).toEqual([
      { milestone: 1, source: 'AUTO', placement_number: 5, redeemed_order_id: null },
      { milestone: 2, source: 'AUTO', placement_number: 10, redeemed_order_id: null },
      { milestone: 3, source: 'AUTO', placement_number: 15, redeemed_order_id: null },
      { milestone: 4, source: 'AUTO', placement_number: 20, redeemed_order_id: null },
    ]);
    // The code in each response is the code stored for that milestone.
    for (const row of coupons.rows) {
      expect(earnedByOrder.get(row.order_id)).toMatchObject({ code: row.code, milestone: row.milestone });
    }
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM coupons')).rows[0].n).toBe(4);

    await expectInvariants(ctx.pool);
  });
});
