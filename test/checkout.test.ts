import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, insertCouponFixture, setupTestDb } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  await setupTestDb();
  ctx = await createTestApp();
});

afterAll(() => ctx.close());

const newCart = async (): Promise<string> => (await ctx.app.inject({ method: 'POST', url: '/carts' })).json().id;
const putQty = (cartId: string, productId: string, quantity: number) =>
  ctx.app.inject({ method: 'PUT', url: `/carts/${cartId}/items/${productId}`, payload: { quantity } });
const quote = (cartId: string, payload?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/carts/${cartId}/checkout/quote`,
    ...(payload === undefined ? {} : { payload, headers: { 'content-type': 'application/json' } }),
  });
const cartWith = async (...lines: Array<[string, number]>): Promise<string> => {
  const cartId = await newCart();
  for (const [productId, qty] of lines) await putQty(cartId, productId, qty);
  return cartId;
};

const quoteCount = async (cartId: string) =>
  Number((await ctx.pool.query('SELECT count(*) AS n FROM checkout_quotes WHERE cart_id = $1', [cartId])).rows[0].n);

describe('POST /carts/:cartId/checkout/quote', () => {
  it('quotes with no body and with {} identically, and stores the rows', async () => {
    const cartId = await cartWith(['sku-mug', 2], ['sku-tshirt', 1]);

    const noBody = await quote(cartId);
    const empty = await quote(cartId, '{}');
    expect(noBody.statusCode).toBe(201);
    expect(empty.statusCode).toBe(201);
    expect(noBody.json().quoteId).not.toBe(empty.json().quoteId);

    const body = noBody.json();
    expect(body).toMatchObject({
      cartId,
      cartVersion: 2,
      subtotalPaise: 109700,
      couponApplied: null,
      discountPaise: 0,
      totalPaise: 109700,
      currency: 'INR',
    });
    expect(body.lines).toEqual([
      {
        productId: 'sku-mug',
        name: 'Ceramic Mug',
        unitPricePaise: 29900,
        quantity: 2,
        lineTotalPaise: 59800,
        availableStock: 50,
        sufficientStock: true,
      },
      {
        productId: 'sku-tshirt',
        name: 'Cotton T-Shirt',
        unitPricePaise: 49900,
        quantity: 1,
        lineTotalPaise: 49900,
        availableStock: 100,
        sufficientStock: true,
      },
    ]);
    expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);

    const stored = await ctx.pool.query(
      'SELECT cart_version, coupon_id, subtotal_paise, discount_paise, total_paise FROM checkout_quotes WHERE id = $1',
      [body.quoteId],
    );
    expect(stored.rows).toEqual([
      { cart_version: 2, coupon_id: null, subtotal_paise: 109700, discount_paise: 0, total_paise: 109700 },
    ]);
    const lines = await ctx.pool.query(
      'SELECT product_id, product_name, unit_price_paise, quantity, line_total_paise FROM quote_lines WHERE quote_id = $1 ORDER BY product_id',
      [body.quoteId],
    );
    expect(lines.rows).toEqual([
      { product_id: 'sku-mug', product_name: 'Ceramic Mug', unit_price_paise: 29900, quantity: 2, line_total_paise: 59800 },
      { product_id: 'sku-tshirt', product_name: 'Cotton T-Shirt', unit_price_paise: 49900, quantity: 1, line_total_paise: 49900 },
    ]);
  });

  it('trims and uppercases the coupon code and floors the discount', async () => {
    const code = await insertCouponFixture(ctx.pool, { percent: 10 });
    const cartId = await cartWith(['sku-sticker-pack', 1], ['sku-notebook', 1]); // 9900 + 19900 = 29800
    const sloppy = `  ${code.toLowerCase()}  `;

    const res = await quote(cartId, JSON.stringify({ couponCode: sloppy }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      couponApplied: { code, percent: 10 },
      subtotalPaise: 29800,
      discountPaise: 2980,
      totalPaise: 26820,
    });

    const stored = await ctx.pool.query(
      `SELECT c.code, q.coupon_percent, q.discount_paise FROM checkout_quotes q JOIN coupons c ON c.id = q.coupon_id WHERE q.id = $1`,
      [res.json().quoteId],
    );
    expect(stored.rows).toEqual([{ code, coupon_percent: 10, discount_paise: 2980 }]);
  });

  it('rejects bad input with 400', async () => {
    const cartId = await cartWith(['sku-mug', 1]);
    for (const payload of ['{"couponCode":1}', '{"couponCode":"A","extra":1}', '{"couponCode":""}']) {
      const res = await quote(cartId, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    const badId = await ctx.app.inject({ method: 'POST', url: '/carts/not-a-uuid/checkout/quote' });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error.code).toBe('VALIDATION_ERROR');
    expect(await quoteCount(cartId)).toBe(0);
  });

  it('404s an unknown cart', async () => {
    const res = await quote('00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CART_NOT_FOUND');
  });

  it('409s a checked-out cart', async () => {
    const cartId = await cartWith(['sku-mug', 1]);
    await ctx.pool.query("UPDATE carts SET status = 'CHECKED_OUT' WHERE id = $1", [cartId]);
    const res = await quote(cartId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CART_ALREADY_CHECKED_OUT');
    expect(await quoteCount(cartId)).toBe(0);
  });

  it('422s an empty cart', async () => {
    const cartId = await newCart();
    const res = await quote(cartId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('EMPTY_CART');
    expect(await quoteCount(cartId)).toBe(0);
  });

  it('reports an empty cart before an unknown coupon (check precedence)', async () => {
    const cartId = await newCart();
    const res = await quote(cartId, JSON.stringify({ couponCode: 'ZZZZZZZZZZZZ' }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('EMPTY_CART');
    expect(await quoteCount(cartId)).toBe(0);
  });

  it('422s an unknown or blank coupon', async () => {
    const cartId = await cartWith(['sku-mug', 1]);
    for (const couponCode of ['ZZZZZZZZZZZZ', '   ']) {
      const res = await quote(cartId, JSON.stringify({ couponCode }));
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('COUPON_INVALID');
    }
    expect(await quoteCount(cartId)).toBe(0);
  });

  it('409s a redeemed coupon', async () => {
    const code = await insertCouponFixture(ctx.pool, { redeemed: true });
    const cartId = await cartWith(['sku-mug', 1]);
    const res = await quote(cartId, JSON.stringify({ couponCode: code }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('COUPON_ALREADY_REDEEMED');
    expect(await quoteCount(cartId)).toBe(0);
  });

  it('409s short stock listing every short line', async () => {
    const cartId = await cartWith(['sku-hoodie', 2], ['sku-limited-sneaker', 2], ['sku-mug', 1]);
    await ctx.pool.query("UPDATE products SET stock = 1 WHERE id IN ('sku-hoodie', 'sku-limited-sneaker')");
    try {
      const res = await quote(cartId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
      expect(res.json().error.details).toEqual([
        { productId: 'sku-hoodie', requested: 2, available: 1 },
        { productId: 'sku-limited-sneaker', requested: 2, available: 1 },
      ]);
      expect(await quoteCount(cartId)).toBe(0);
    } finally {
      await ctx.pool.query("UPDATE products SET stock = 25 WHERE id = 'sku-hoodie'");
      await ctx.pool.query("UPDATE products SET stock = 2 WHERE id = 'sku-limited-sneaker'");
    }
  });

  it('mutates nothing: stock, prices, coupon and cart are unchanged', async () => {
    const code = await insertCouponFixture(ctx.pool);
    const cartId = await cartWith(['sku-mug', 3], ['sku-limited-sneaker', 1]);

    const snapshot = async () => ({
      products: (await ctx.pool.query('SELECT * FROM products ORDER BY id')).rows,
      coupons: (await ctx.pool.query('SELECT * FROM coupons ORDER BY milestone')).rows,
      cart: (await ctx.pool.query('SELECT * FROM carts WHERE id = $1', [cartId])).rows,
      orders: (await ctx.pool.query('SELECT id FROM orders ORDER BY placement_number')).rows,
      stats: (await ctx.pool.query('SELECT * FROM store_stats')).rows,
    });
    const before = await snapshot();

    const res = await quote(cartId, JSON.stringify({ couponCode: code }));
    expect(res.statusCode).toBe(201);

    expect(await snapshot()).toEqual(before);
    const coupon = await ctx.pool.query('SELECT redeemed_order_id FROM coupons WHERE code = $1', [code]);
    expect(coupon.rows[0].redeemed_order_id).toBeNull();
    expect(before.cart[0]).toMatchObject({ status: 'OPEN', version: 2 });
  });
});
