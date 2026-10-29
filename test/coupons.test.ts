// Stock ownership: every order here is one sku-sticker-pack (500 in stock, never drained).
// Orders are placed through the API, never with insertCouponFixture: its milestones are not
// aligned with placement k x n, which admin generation depends on.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cartWith, confirm, createTestApp, expectInvariants, parallel, requestQuote, setupTestDb } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;

// n = 2 with auto-generation off, so every milestone coupon here comes from the admin endpoint.
beforeAll(async () => {
  await setupTestDb();
  ctx = await createTestApp({ couponEveryNOrders: 2, autoGenerateCoupons: false });
});

afterAll(() => ctx.close());

/** Places a one-sticker order and returns its id and placement number. */
const placeSticker = async (): Promise<{ id: string; placementNumber: number }> => {
  const cartId = await cartWith(ctx.app, ['sku-sticker-pack', 1]);
  const quote = await requestQuote(ctx.app, cartId);
  const res = await confirm(ctx.app, cartId, quote.json().quoteId);
  expect(res.statusCode).toBe(201);
  return res.json().order;
};

const generate = () => ctx.app.inject({ method: 'POST', url: '/admin/coupons' });

const orderIds: string[] = []; // by placement number - 1

describe('POST /admin/coupons', () => {
  it('409s with details while no milestone has been reached', async () => {
    const res = await generate();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'NO_ELIGIBLE_MILESTONE',
      details: { placedOrders: 0, rewardedMilestones: 0, nextMilestoneAtOrder: 2 },
    });
  });

  it('with auto-generation off, the milestone order has no earnedCoupon yet', async () => {
    for (let i = 0; i < 4; i++) orderIds.push((await placeSticker()).id);
    for (const id of orderIds) {
      const res = await ctx.app.inject({ method: 'GET', url: `/orders/${id}` });
      expect(res.json().earnedCoupon).toBeNull();
    }
  });

  it('T12: 10 parallel generates give exactly one coupon per reached milestone', async () => {
    const results = await parallel(10, () => generate());

    const created = results.filter((r) => r.statusCode === 201);
    const rejected = results.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(2);
    expect(rejected).toHaveLength(8);

    // The counter lock makes every loser a clean 409; a 500 would be a UNIQUE(milestone) collision.
    for (const res of rejected) {
      expect(res.json().error).toMatchObject({
        code: 'NO_ELIGIBLE_MILESTONE',
        details: { placedOrders: 4, rewardedMilestones: 2, nextMilestoneAtOrder: 6 },
      });
    }

    const bodies = created.map((r) => r.json()).sort((a, b) => a.coupon.milestone - b.coupon.milestone);
    expect(bodies.map((b) => b.coupon.milestone)).toEqual([1, 2]);
    // The lowest unrewarded milestone goes first; pending counts what is still owed afterwards.
    expect(bodies.map((b) => b.pendingMilestones).sort()).toEqual([0, 1]);
    expect(bodies[0].coupon).toMatchObject({
      percent: 10,
      source: 'ADMIN',
      status: 'AVAILABLE',
      milestoneOrderId: orderIds[1], // placement 2
      redeemedOrderId: null,
      redeemedAt: null,
    });
    expect(bodies[1].coupon.milestoneOrderId).toBe(orderIds[3]); // placement 4

    const rows = await ctx.pool.query('SELECT milestone, count(*)::int AS n FROM coupons GROUP BY milestone ORDER BY milestone');
    expect(rows.rows).toEqual([
      { milestone: 1, n: 1 },
      { milestone: 2, n: 1 },
    ]);
  });

  it('shows a backfilled coupon as earnedCoupon on the milestone order, and only there', async () => {
    const earned = async (id: string) =>
      (await ctx.app.inject({ method: 'GET', url: `/orders/${id}` })).json().earnedCoupon;

    expect(await earned(orderIds[0]!)).toBeNull();
    expect(await earned(orderIds[1]!)).toMatchObject({ percent: 10, milestone: 1 });
    expect(await earned(orderIds[2]!)).toBeNull();
    expect(await earned(orderIds[3]!)).toMatchObject({ percent: 10, milestone: 2 });
  });

  it('keeps the invariants', () => expectInvariants(ctx.pool));
});

describe('GET /admin/coupons', () => {
  let redeemedCode: string;
  let redeemedOrderId: string;

  it('lists every coupon by milestone, then filters by status', async () => {
    const all0 = (await ctx.app.inject({ method: 'GET', url: '/admin/coupons' })).json();
    expect(all0.map((c: { milestone: number }) => c.milestone)).toEqual([1, 2]);
    redeemedCode = all0[0].code;

    // Spend the milestone-1 coupon on a new order.
    const cartId = await cartWith(ctx.app, ['sku-sticker-pack', 1]);
    const quote = await requestQuote(ctx.app, cartId, redeemedCode);
    expect(quote.statusCode).toBe(201);
    const placed = await confirm(ctx.app, cartId, quote.json().quoteId);
    expect(placed.statusCode).toBe(201);
    redeemedOrderId = placed.json().order.id;
    orderIds.push(redeemedOrderId);

    const all = (await ctx.app.inject({ method: 'GET', url: '/admin/coupons' })).json();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      code: redeemedCode,
      milestone: 1,
      percent: 10,
      source: 'ADMIN',
      status: 'REDEEMED',
      milestoneOrderId: orderIds[1],
      redeemedOrderId,
    });
    expect(all[0].redeemedAt).toEqual(expect.any(String));
    expect(all[1]).toMatchObject({ milestone: 2, status: 'AVAILABLE', redeemedOrderId: null, redeemedAt: null });

    const redeemed = (await ctx.app.inject({ method: 'GET', url: '/admin/coupons?status=REDEEMED' })).json();
    expect(redeemed.map((c: { milestone: number }) => c.milestone)).toEqual([1]);
    const available = (await ctx.app.inject({ method: 'GET', url: '/admin/coupons?status=AVAILABLE' })).json();
    expect(available.map((c: { milestone: number }) => c.milestone)).toEqual([2]);
  });

  it('400s an unknown status and an unknown query parameter', async () => {
    for (const url of ['/admin/coupons?status=bogus', '/admin/coupons?foo=1']) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('GET /admin/orders', () => {
  it('lists orders by placement number with their totals and coupon', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/orders' });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.map((o: { placementNumber: number }) => o.placementNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((o: { id: string }) => o.id)).toEqual(orderIds);

    for (const o of rows) {
      expect(o.currency).toBe('INR');
      expect(o.totalPaise).toBe(o.subtotalPaise - o.discountPaise);
    }
    // Only the order that spent the milestone-1 coupon carries a code and a discount.
    expect(rows.filter((o: { couponCode: string | null }) => o.couponCode !== null)).toHaveLength(1);
    expect(rows[4]).toMatchObject({ subtotalPaise: 9900, discountPaise: 990, totalPaise: 8910 });
    expect(rows[4].couponCode).toEqual(expect.any(String));
    expect(rows[0]).toMatchObject({ couponCode: null, discountPaise: 0 });
  });

  it('keeps the invariants', () => expectInvariants(ctx.pool));
});
