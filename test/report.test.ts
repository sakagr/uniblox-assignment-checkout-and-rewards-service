// Stock ownership (orders are insert-only, so consumed stock cannot be restored):
//   sku-limited-sneaker  the oversell race (drained to 0)
//   everything else      small non-draining quantities
// No direct stock SQL in this file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cartWith, confirm, createTestApp, expectInvariants, parallel, requestQuote, setupTestDb } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
let off: Ctx; // n = 2, auto-generation off: milestones are backfilled through the admin endpoint
let on: Ctx; //  n = 2, auto-generation on, same database

beforeAll(async () => {
  await setupTestDb();
  off = await createTestApp({ couponEveryNOrders: 2, autoGenerateCoupons: false });
  on = await createTestApp({ couponEveryNOrders: 2, autoGenerateCoupons: true });
});

afterAll(async () => {
  await off.close();
  await on.close();
});

const getReport = async () => {
  const res = await off.app.inject({ method: 'GET', url: '/admin/report' });
  expect(res.statusCode).toBe(200);
  return res.json();
};

const withoutTimestamp = <T extends { generatedAt: string }>({ generatedAt: _generatedAt, ...rest }: T) => rest;

const place = async (app: Ctx['app'], ...lines: Array<[string, number]>) => {
  const cartId = await cartWith(app, ...lines);
  const quote = await requestQuote(app, cartId);
  const res = await confirm(app, cartId, quote.json().quoteId);
  expect(res.statusCode).toBe(201);
  return res.json().order as { id: string; placementNumber: number };
};

describe('GET /admin/report', () => {
  it('reports zeros, with every product listed, before any order', async () => {
    const report = await getReport();
    expect(report).toMatchObject({
      placedOrders: 0,
      grossRevenuePaise: 0,
      totalDiscountPaise: 0,
      netRevenuePaise: 0,
      coupons: { generated: 0, available: 0, redeemed: 0 },
      currency: 'INR',
    });
    expect(report.productsSold).toEqual([
      { productId: 'sku-hoodie', name: 'Fleece Hoodie', quantity: 0 },
      { productId: 'sku-limited-sneaker', name: 'Limited Edition Sneaker', quantity: 0 },
      { productId: 'sku-mug', name: 'Ceramic Mug', quantity: 0 },
      { productId: 'sku-notebook', name: 'A5 Notebook', quantity: 0 },
      { productId: 'sku-sticker-pack', name: 'Sticker Pack', quantity: 0 },
      { productId: 'sku-tshirt', name: 'Cotton T-Shirt', quantity: 0 },
    ]);
  });

  it('T14: reconciles with the order and coupon listings after a mixed run', async () => {
    // Placements 1 and 2, then an admin backfill of milestone 1 (ADMIN coupon on order 2).
    await place(off.app, ['sku-mug', 2], ['sku-notebook', 1]);
    await place(off.app, ['sku-tshirt', 1]);
    const backfill = await off.app.inject({ method: 'POST', url: '/admin/coupons' });
    expect(backfill.statusCode).toBe(201);
    const couponCode: string = backfill.json().coupon.code;

    // Placements 3 and 4; the 4th earns milestone 2 automatically.
    await place(on.app, ['sku-sticker-pack', 3]);
    const fourth = await place(on.app, ['sku-mug', 1]);
    expect(fourth.placementNumber).toBe(4);

    // Failure 1, oversell: 3 carts for the last 2 sneakers. The two winners are placements 5 and 6.
    const sneakerCarts = await parallel(3, () => cartWith(on.app, ['sku-limited-sneaker', 1]));
    const sneakerQuotes = await parallel(3, async (i) => (await requestQuote(on.app, sneakerCarts[i]!)).json().quoteId);
    const sneaker = await parallel(3, (i) => confirm(on.app, sneakerCarts[i]!, sneakerQuotes[i]!));
    expect(sneaker.map((r) => r.statusCode).sort()).toEqual([201, 201, 409]);
    expect(sneaker.find((r) => r.statusCode === 409)!.json().error.code).toBe('INSUFFICIENT_STOCK');

    // Failure 2, coupon race: one coupon quoted on 2 carts, confirmed in parallel.
    const couponCarts = await parallel(2, () => cartWith(on.app, ['sku-notebook', 1]));
    const couponQuotes = await parallel(2, async (i) => {
      const q = await requestQuote(on.app, couponCarts[i]!, couponCode);
      expect(q.statusCode).toBe(201);
      return q.json().quoteId as string;
    });
    const race = await parallel(2, (i) => confirm(on.app, couponCarts[i]!, couponQuotes[i]!));
    expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(race.find((r) => r.statusCode === 409)!.json().error.code).toBe('COUPON_ALREADY_REDEEMED');

    // Failure 3, stale quote: edit the cart after quoting.
    const staleCart = await cartWith(on.app, ['sku-tshirt', 1]);
    const staleQuote = (await requestQuote(on.app, staleCart)).json().quoteId;
    await on.app.inject({ method: 'PUT', url: `/carts/${staleCart}/items/sku-tshirt`, payload: { quantity: 2 } });
    const stale = await confirm(on.app, staleCart, staleQuote);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('QUOTE_STALE');

    // 7 orders placed: 1-4, the two sneakers (5, 6), and the winner of the coupon race (7).
    const report = await getReport();
    const orders = (await off.app.inject({ method: 'GET', url: '/admin/orders' })).json();
    const coupons = (await off.app.inject({ method: 'GET', url: '/admin/coupons' })).json();
    expect(orders).toHaveLength(7);

    // Orders: money figures recomputed from the listing.
    const sum = (key: 'subtotalPaise' | 'discountPaise' | 'totalPaise') =>
      orders.reduce((acc: number, o: Record<string, number>) => acc + o[key]!, 0);
    expect(report.placedOrders).toBe(orders.length);
    expect(report.grossRevenuePaise).toBe(sum('subtotalPaise'));
    expect(report.totalDiscountPaise).toBe(sum('discountPaise'));
    expect(report.netRevenuePaise).toBe(sum('totalPaise'));
    expect(report.netRevenuePaise).toBe(report.grossRevenuePaise - report.totalDiscountPaise);
    expect(report.totalDiscountPaise, 'the coupon path must be exercised').toBeGreaterThan(0);

    // Coupons: counts recomputed from the listing. Milestones 1 (ADMIN), 2 and 3 (AUTO) are reached.
    const redeemed = coupons.filter((c: { status: string }) => c.status === 'REDEEMED').length;
    expect(report.coupons).toEqual({ generated: coupons.length, available: coupons.length - redeemed, redeemed });
    expect(report.coupons).toEqual({ generated: 3, available: 2, redeemed: 1 });
    expect(coupons.map((c: { source: string }) => c.source)).toEqual(['ADMIN', 'AUTO', 'AUTO']);

    // Products sold: quantities recomputed from every listed order's lines.
    const sold = new Map<string, number>();
    for (const o of orders) {
      const full = (await off.app.inject({ method: 'GET', url: `/orders/${o.id}` })).json();
      for (const l of full.lines) sold.set(l.productId, (sold.get(l.productId) ?? 0) + l.quantity);
    }
    const products = (await off.app.inject({ method: 'GET', url: '/products' })).json();
    expect(report.productsSold.map((p: { productId: string }) => p.productId)).toEqual(
      products.map((p: { id: string }) => p.id),
    );
    for (const p of report.productsSold) expect(p.quantity, p.productId).toBe(sold.get(p.productId) ?? 0);
    expect(report.productsSold.find((p: { productId: string }) => p.productId === 'sku-limited-sneaker').quantity).toBe(2);
    expect(report.productsSold.find((p: { productId: string }) => p.productId === 'sku-mug').quantity).toBe(3);
  });

  it('is repeatable and changes no rows', async () => {
    const tables: Array<[string, string]> = [
      ['products', '1'],
      ['carts', '1'],
      ['cart_items', '1, 2'],
      ['coupons', '1'],
      ['checkout_quotes', '1'],
      ['quote_lines', '1, 2'],
      ['orders', '1'],
      ['order_lines', '1, 2'],
      ['store_stats', '1'],
    ];
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async ([table, order]) => [table, (await off.pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows]),
        ),
      );

    const before = await snapshot();
    const first = await getReport();
    const second = await getReport();
    expect(withoutTimestamp(second)).toEqual(withoutTimestamp(first));
    expect(await snapshot()).toEqual(before);
  });

  it('keeps the invariants', () => expectInvariants(off.pool));
});
