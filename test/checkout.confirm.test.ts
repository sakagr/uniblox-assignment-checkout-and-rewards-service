// Stock ownership (orders are insert-only, so consumed stock cannot be restored):
//   sku-sticker-pack     shared filler for placeSticker / earnCoupon (never drained)
//   sku-mug, sku-tshirt, sku-notebook   small non-draining quantities
// No direct stock SQL in this file; prices changed by a test are restored in `finally`.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cartWith, confirm, createTestApp, expectInvariants, requestQuote, setupTestDb } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  await setupTestDb();
  ctx = await createTestApp({ couponEveryNOrders: 3, autoGenerateCoupons: true });
});

afterAll(() => ctx.close());

const NO_SUCH_UUID = '00000000-0000-4000-8000-000000000000';

const quoteFor = async (cartId: string, couponCode?: string): Promise<string> => {
  const res = await requestQuote(ctx.app, cartId, couponCode);
  expect(res.statusCode).toBe(201);
  return res.json().quoteId;
};

type App = typeof ctx.app;

/** Places a one-sticker-pack order and returns the confirm body. */
const placeSticker = async (app: App = ctx.app): Promise<{ order: { id: string; placementNumber: number }; earnedCoupon: { code: string; percent: number; milestone: number } | null }> => {
  const cartId = await cartWith(app, ['sku-sticker-pack', 1]);
  const quote = await requestQuote(app, cartId);
  const res = await confirm(app, cartId, quote.json().quoteId);
  expect(res.statusCode).toBe(201);
  return res.json();
};

/**
 * Places orders until one earns a coupon and returns it. With n = 3 and auto-generation on
 * that takes at most 3 orders; if it does not, auto-generation is broken, so fail loudly
 * instead of looping on.
 */
const earnCoupon = async () => {
  const placements: number[] = [];
  for (let i = 0; i < 3; i++) {
    const placed = await placeSticker();
    placements.push(placed.order.placementNumber);
    if (placed.earnedCoupon) return { ...placed, code: placed.earnedCoupon.code };
  }
  throw new Error(`earnCoupon: no coupon earned within 3 orders (n = 3, auto on); placements: ${placements.join(', ')}`);
};

const scalar = async (sql: string, params: unknown[] = []) =>
  (await ctx.pool.query(sql, params)).rows[0] as Record<string, unknown>;

describe('POST /carts/:cartId/checkout', () => {
  it('places an order exactly as quoted', async () => {
    const cartId = await cartWith(ctx.app, ['sku-mug', 2], ['sku-tshirt', 1]);
    const quoteId = await quoteFor(cartId);
    const before = {
      stock: await scalar("SELECT stock FROM products WHERE id = 'sku-mug'"),
      placed: await scalar('SELECT placed_orders FROM store_stats'),
    };

    const res = await confirm(ctx.app, cartId, quoteId);
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();

    const { order, earnedCoupon } = res.json();
    expect(earnedCoupon).toBeNull();
    expect(order).toMatchObject({
      cartId,
      quoteId,
      placementNumber: Number(before.placed.placed_orders) + 1,
      subtotalPaise: 109700,
      couponApplied: null,
      discountPaise: 0,
      totalPaise: 109700,
      earnedCoupon: null,
      currency: 'INR',
    });
    expect(order.lines).toEqual([
      { productId: 'sku-mug', name: 'Ceramic Mug', unitPricePaise: 29900, quantity: 2, lineTotalPaise: 59800 },
      { productId: 'sku-tshirt', name: 'Cotton T-Shirt', unitPricePaise: 49900, quantity: 1, lineTotalPaise: 49900 },
    ]);

    // Stock decremented once, counter advanced once.
    expect((await scalar("SELECT stock FROM products WHERE id = 'sku-mug'")).stock).toBe(
      (before.stock.stock as number) - 2,
    );
    expect((await scalar('SELECT placed_orders FROM store_stats')).placed_orders).toBe(
      (before.placed.placed_orders as number) + 1,
    );

    // The cart is closed and points at the order.
    const cart = await ctx.app.inject({ method: 'GET', url: `/carts/${cartId}` });
    expect(cart.json()).toMatchObject({ status: 'CHECKED_OUT', orderId: order.id });

    // GET /orders/:id returns the same snapshot.
    const fetched = await ctx.app.inject({ method: 'GET', url: `/orders/${order.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(order);
  });

  it('rejects bad input with 400 and changes nothing', async () => {
    const cartId = await cartWith(ctx.app, ['sku-mug', 1]);
    const quoteId = await quoteFor(cartId);
    for (const payload of [{}, { quoteId: 'not-a-uuid' }, { quoteId, extra: 1 }, { quoteId: 5 }]) {
      const res = await ctx.app.inject({ method: 'POST', url: `/carts/${cartId}/checkout`, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    const badCart = await ctx.app.inject({ method: 'POST', url: '/carts/not-a-uuid/checkout', payload: { quoteId } });
    expect(badCart.statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: `/carts/${cartId}` })).json().status).toBe('OPEN');
  });

  it('404s an unknown cart as CART_NOT_FOUND whatever the quote id', async () => {
    const res = await confirm(ctx.app, NO_SUCH_UUID, randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CART_NOT_FOUND');
  });

  it('404s an unknown quote and another cart\'s quote as QUOTE_NOT_FOUND', async () => {
    const cartId = await cartWith(ctx.app, ['sku-mug', 1]);
    const otherCartId = await cartWith(ctx.app, ['sku-mug', 1]);
    const othersQuote = await quoteFor(otherCartId);

    for (const quoteId of [randomUUID(), othersQuote]) {
      const res = await confirm(ctx.app, cartId, quoteId);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('QUOTE_NOT_FOUND');
    }
    // Neither cart was touched.
    for (const id of [cartId, otherCartId]) {
      expect((await ctx.app.inject({ method: 'GET', url: `/carts/${id}` })).json().status).toBe('OPEN');
    }
  });
});

describe('replay', () => {
  it('answers a retry of the same quote with 200, the header and an identical body', async () => {
    const cartId = await cartWith(ctx.app, ['sku-mug', 2]);
    const quoteId = await quoteFor(cartId);
    const stockBefore = (await scalar("SELECT stock FROM products WHERE id = 'sku-mug'")).stock as number;
    const ordersBefore = (await scalar('SELECT count(*)::int AS n FROM orders')).n as number;

    const first = await confirm(ctx.app, cartId, quoteId);
    const second = await confirm(ctx.app, cartId, quoteId);
    const third = await confirm(ctx.app, cartId, quoteId);

    expect(first.statusCode).toBe(201);
    for (const replay of [second, third]) {
      expect(replay.statusCode).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(first.json());
    }
    // One order and one decrement, however many retries.
    expect((await scalar('SELECT count(*)::int AS n FROM orders')).n).toBe(ordersBefore + 1);
    expect((await scalar("SELECT stock FROM products WHERE id = 'sku-mug'")).stock).toBe(stockBefore - 2);
  });

  it('409s a different quote on a checked-out cart, and still replays the original', async () => {
    const cartId = await cartWith(ctx.app, ['sku-tshirt', 1]);
    const winning = await quoteFor(cartId);
    const other = await quoteFor(cartId); // same cart version, so it would otherwise be valid
    const placed = await confirm(ctx.app, cartId, winning);
    expect(placed.statusCode).toBe(201);

    for (const quoteId of [other, randomUUID()]) {
      const res = await confirm(ctx.app, cartId, quoteId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CART_ALREADY_CHECKED_OUT');
      expect(res.headers['idempotent-replayed']).toBeUndefined();
    }
    const replay = await confirm(ctx.app, cartId, winning);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(placed.json());
  });
});

describe('GET /orders/:orderId', () => {
  it('404s an unknown order and 400s a bad id', async () => {
    const missing = await ctx.app.inject({ method: 'GET', url: `/orders/${NO_SUCH_UUID}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('ORDER_NOT_FOUND');

    const bad = await ctx.app.inject({ method: 'GET', url: '/orders/nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('T10: an order survives later price changes unchanged', async () => {
    const cartId = await cartWith(ctx.app, ['sku-notebook', 3]);
    const placed = (await confirm(ctx.app, cartId, await quoteFor(cartId))).json().order;
    expect(placed.totalPaise).toBe(59700);

    try {
      await ctx.pool.query("UPDATE products SET unit_price_paise = 99900 WHERE id = 'sku-notebook'");
      const fetched = await ctx.app.inject({ method: 'GET', url: `/orders/${placed.id}` });
      expect(fetched.json()).toEqual(placed);
      expect(fetched.json().lines[0]).toMatchObject({ unitPricePaise: 19900, lineTotalPaise: 59700 });
    } finally {
      await ctx.pool.query("UPDATE products SET unit_price_paise = 19900 WHERE id = 'sku-notebook'");
    }
  });
});

describe('milestone coupon', () => {
  it('T11: the nth placement earns a coupon, shown on the response, the order and its replay', async () => {
    const earned = await earnCoupon();
    const { order, earnedCoupon } = earned;
    expect(order.placementNumber % 3).toBe(0);
    expect(earnedCoupon).toEqual({ code: earned.code, percent: 10, milestone: order.placementNumber / 3 });

    // Stored as an AUTO coupon linked to the order that earned it, still unspent.
    const row = await scalar(
      'SELECT percent, milestone, milestone_order_id, source, redeemed_order_id FROM coupons WHERE code = $1',
      [earned.code],
    );
    expect(row).toEqual({
      percent: 10,
      milestone: order.placementNumber / 3,
      milestone_order_id: order.id,
      source: 'AUTO',
      redeemed_order_id: null,
    });

    // GET /orders/:id and a replay of the confirm show the same earned coupon (D2).
    const fetched = await ctx.app.inject({ method: 'GET', url: `/orders/${order.id}` });
    expect(fetched.json().earnedCoupon).toEqual(earnedCoupon);
    const replay = await confirm(ctx.app, fetched.json().cartId, fetched.json().quoteId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().earnedCoupon).toEqual(earnedCoupon);
  });

  it('earns nothing on placements that are not a multiple of n', async () => {
    const orders = [];
    for (let i = 0; i < 3; i++) orders.push(await placeSticker());
    for (const { order, earnedCoupon } of orders) {
      expect(earnedCoupon === null).toBe(order.placementNumber % 3 !== 0);
    }
    expect(orders.filter((o) => o.earnedCoupon !== null)).toHaveLength(1);
  });

  it('with auto-generation off, the nth placement earns no coupon and creates no coupon row', async () => {
    const off = await createTestApp({ couponEveryNOrders: 3, autoGenerateCoupons: false });
    try {
      let milestoneOrder: { id: string; placementNumber: number } | undefined;
      for (let i = 0; i < 3 && !milestoneOrder; i++) {
        const placed = await placeSticker(off.app);
        if (placed.order.placementNumber % 3 === 0) {
          milestoneOrder = placed.order;
          expect(placed.earnedCoupon).toBeNull();
        }
      }
      expect(milestoneOrder, 'no multiple of 3 placed in 3 orders').toBeDefined();

      const coupons = await scalar(
        'SELECT count(*)::int AS n FROM coupons WHERE milestone = $1 OR milestone_order_id = $2',
        [milestoneOrder!.placementNumber / 3, milestoneOrder!.id],
      );
      expect(coupons.n).toBe(0);
      const fetched = await off.app.inject({ method: 'GET', url: `/orders/${milestoneOrder!.id}` });
      expect(fetched.json().earnedCoupon).toBeNull();
    } finally {
      await off.close();
    }
  });
});

describe('invariants', () => {
  it('hold after everything above', () => expectInvariants(ctx.pool));
});
