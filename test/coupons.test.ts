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
