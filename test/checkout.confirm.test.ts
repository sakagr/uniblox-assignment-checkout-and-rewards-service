// Stock ownership (orders are insert-only, so consumed stock cannot be restored):
//   sku-mug, sku-tshirt, sku-notebook   small non-draining quantities
// No direct stock SQL in this file; prices changed by a test are restored in `finally`.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cartWith, confirm, createTestApp, requestQuote, setupTestDb } from './helpers.js';

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
