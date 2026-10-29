import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, expectInvariants, parallel, setupTestDb, waitForLockWaiters } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  await setupTestDb();
  ctx = await createTestApp();
});

afterAll(() => ctx.close());

const newCart = async (): Promise<string> => (await ctx.app.inject({ method: 'POST', url: '/carts' })).json().id;
const getCart = async (id: string) => (await ctx.app.inject(`/carts/${id}`)).json();
const put = (cartId: string, productId: string, payload: string) =>
  ctx.app.inject({
    method: 'PUT',
    url: `/carts/${cartId}/items/${productId}`,
    payload,
    headers: { 'content-type': 'application/json' },
  });
const putQty = (cartId: string, productId: string, quantity: number) =>
  put(cartId, productId, JSON.stringify({ quantity }));
const del = (cartId: string, productId: string) =>
  ctx.app.inject({ method: 'DELETE', url: `/carts/${cartId}/items/${productId}` });

describe('GET /products', () => {
  it('lists the seeded products ordered by id with integer paise', async () => {
    const res = await ctx.app.inject('/products');
    expect(res.statusCode).toBe(200);
    const products = res.json();
    expect(products.map((p: { id: string }) => p.id)).toEqual([
      'sku-hoodie',
      'sku-limited-sneaker',
      'sku-mug',
      'sku-notebook',
      'sku-sticker-pack',
      'sku-tshirt',
    ]);
    expect(products[1]).toEqual({
      id: 'sku-limited-sneaker',
      name: 'Limited Edition Sneaker',
      unitPricePaise: 899900,
      stock: 2,
      currency: 'INR',
    });
  });
});

describe('POST /carts', () => {
  it('creates an empty cart with a Location header and a null orderId', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/carts' });
    expect(res.statusCode).toBe(201);
    const cart = res.json();
    expect(res.headers.location).toBe(`/carts/${cart.id}`);
    expect(cart).toMatchObject({ status: 'OPEN', version: 0, lines: [], subtotalPaise: 0, currency: 'INR' });
    expect(cart.orderId).toBeNull();
  });
});

describe('T2: invalid input is rejected and the cart is unchanged', () => {
  it.each([
    ['quantity -1', '{"quantity":-1}', 400, 'VALIDATION_ERROR'],
    ['quantity 1.5', '{"quantity":1.5}', 400, 'VALIDATION_ERROR'],
    ['quantity 1001', '{"quantity":1001}', 400, 'VALIDATION_ERROR'],
    ['quantity "5"', '{"quantity":"5"}', 400, 'VALIDATION_ERROR'],
    ['extra field', '{"quantity":1,"extra":1}', 400, 'VALIDATION_ERROR'],
  ])('%s', async (_name, payload, status, code) => {
    const cartId = await newCart();
    await putQty(cartId, 'sku-mug', 2);
    const before = await getCart(cartId);

    const res = await put(cartId, 'sku-mug', payload);
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
    expect(await getCart(cartId)).toEqual(before);
  });

  it('rejects a malformed cart id with 400', async () => {
    const res = await ctx.app.inject('/carts/not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('404s an unknown cart on GET, PUT and DELETE', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const res of [
      await ctx.app.inject(`/carts/${id}`),
      await putQty(id, 'sku-mug', 1),
      await del(id, 'sku-mug'),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('CART_NOT_FOUND');
    }
  });

  it('404s an unknown product without touching the cart', async () => {
    const cartId = await newCart();
    const res = await putQty(cartId, 'sku-nope', 1);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PRODUCT_NOT_FOUND');
    expect((await getCart(cartId)).version).toBe(0);
  });

  it('PUT quantity 0 on an unknown product is 404, while DELETE of it is a 200 no-op', async () => {
    const cartId = await newCart();
    const res = await putQty(cartId, 'sku-nope', 0);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PRODUCT_NOT_FOUND');

    const deleted = await del(cartId, 'sku-nope');
    expect(deleted.statusCode).toBe(200);
    expect((await getCart(cartId)).version).toBe(0);
  });

  it('409s a quantity above stock with the shortfall, cart unchanged', async () => {
    const cartId = await newCart();
    const res = await putQty(cartId, 'sku-limited-sneaker', 3);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: [{ productId: 'sku-limited-sneaker', requested: 3, available: 2 }],
    });
    const cart = await getCart(cartId);
    expect(cart.lines).toEqual([]);
    expect(cart.version).toBe(0);
  });

  it('409s edits to a checked-out cart (I4) and leaves it unchanged', async () => {
    const cartId = await newCart();
    await putQty(cartId, 'sku-mug', 1);
    await ctx.pool.query("UPDATE carts SET status = 'CHECKED_OUT' WHERE id = $1", [cartId]);
    const before = await getCart(cartId);

    for (const res of [await putQty(cartId, 'sku-mug', 5), await del(cartId, 'sku-mug')]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CART_ALREADY_CHECKED_OUT');
    }
    expect(await getCart(cartId)).toEqual(before);
  });
});

describe('T3: absolute quantity and version bumps', () => {
  it('bumps the version only when a line actually changes', async () => {
    const cartId = await newCart();

    expect((await putQty(cartId, 'sku-mug', 2)).json()).toMatchObject({ version: 1 });
    expect((await putQty(cartId, 'sku-mug', 2)).json()).toMatchObject({ version: 1 });
    const grown = (await putQty(cartId, 'sku-mug', 3)).json();
    expect(grown.version).toBe(2);
    expect(grown.lines).toEqual([
      {
        productId: 'sku-mug',
        name: 'Ceramic Mug',
        unitPricePaise: 29900,
        quantity: 3,
        lineTotalPaise: 89700,
        availableStock: 50,
        sufficientStock: true,
      },
    ]);
    expect(grown.subtotalPaise).toBe(89700);

    const removed = (await putQty(cartId, 'sku-mug', 0)).json();
    expect(removed).toMatchObject({ lines: [], version: 3, subtotalPaise: 0 });

    // Absent line: 200 no-op, PUT 0 and DELETE alike.
    expect((await putQty(cartId, 'sku-mug', 0)).json().version).toBe(3);
    const noop = await del(cartId, 'sku-mug');
    expect(noop.statusCode).toBe(200);
    expect(noop.json().version).toBe(3);

    await putQty(cartId, 'sku-tshirt', 1);
    const deleted = (await del(cartId, 'sku-tshirt')).json();
    expect(deleted).toMatchObject({ lines: [], version: 5 });
  });

  it('shows current price and stock, not a snapshot', async () => {
    const cartId = await newCart();
    await putQty(cartId, 'sku-hoodie', 10);
    await ctx.pool.query(
      "UPDATE products SET unit_price_paise = 100000, stock = 4 WHERE id = 'sku-hoodie'",
    );
    try {
      const cart = await getCart(cartId);
      expect(cart.lines[0]).toMatchObject({
        unitPricePaise: 100000,
        lineTotalPaise: 1000000,
        availableStock: 4,
        sufficientStock: false,
      });
      expect(cart.subtotalPaise).toBe(1000000);
    } finally {
      await ctx.pool.query(
        "UPDATE products SET unit_price_paise = 149900, stock = 25 WHERE id = 'sku-hoodie'",
      );
    }
  });
});

describe('concurrent item edits', () => {
  it('parallel PUTs for different products on one cart all land, version is exactly 6', async () => {
    const cartId = await newCart();
    const { rows } = await ctx.pool.query<{ id: string }>('SELECT id FROM products ORDER BY id');
    expect(rows).toHaveLength(6);

    const results = await parallel(rows.length, (i) => putQty(cartId, rows[i]!.id, 1));
    expect(results.map((r) => r.statusCode)).toEqual(rows.map(() => 200));

    const cart = await getCart(cartId);
    expect(cart.lines).toHaveLength(6);
    expect(cart.version).toBe(6);
    const db = await ctx.pool.query('SELECT version FROM carts WHERE id = $1', [cartId]);
    expect(db.rows[0].version).toBe(6);
  });

  // The parallel-PUT test above passes even without the cart lock: the version increment is
  // atomic and different products don't conflict. This one pins I4 by holding the lock itself.
  it('I4: a PUT waits for an in-flight checkout of the cart, then 409s and leaves the line alone', async () => {
    const cartId = await newCart();
    await putQty(cartId, 'sku-mug', 1);

    // A separate connection plays a confirm in flight: cart locked, status flipped, not yet committed.
    const blocker = await ctx.pool.connect();
    let committed = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM carts WHERE id = $1 FOR UPDATE', [cartId]);
      await blocker.query("UPDATE carts SET status = 'CHECKED_OUT' WHERE id = $1", [cartId]);

      // inject() is lazy; Promise.resolve() calls .then() and so dispatches the request now.
      const pending = Promise.resolve(putQty(cartId, 'sku-mug', 3));
      await waitForLockWaiters(ctx.pool, 1);

      await blocker.query('COMMIT');
      committed = true;
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CART_ALREADY_CHECKED_OUT');
    } finally {
      if (!committed) await blocker.query('ROLLBACK');
      blocker.release();
    }

    const line = await ctx.pool.query('SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2', [
      cartId,
      'sku-mug',
    ]);
    expect(line.rows).toEqual([{ quantity: 1 }]);
    expect((await ctx.pool.query('SELECT version FROM carts WHERE id = $1', [cartId])).rows[0].version).toBe(1);
    await expectInvariants(ctx.pool);
  });
});
