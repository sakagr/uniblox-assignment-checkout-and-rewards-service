// Stock ownership (orders are insert-only, so consumed stock cannot be restored):
//   sku-mug              T4
//   sku-limited-sneaker  T5 (drained to 0)
//   sku-notebook         T6 (5 carts x 1)
//   sku-sticker-pack     shared filler for earning the T6 coupon (never drained)
// No direct stock or price SQL in this file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cartWith, confirm, createTestApp, expectInvariants, parallel, requestQuote, setupTestDb } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  await setupTestDb();
  // n = 1: every placed order earns a coupon, so a test can get its own. The pool must be
  // at least as large as the fan-out below or the transactions would queue instead of overlapping.
  ctx = await createTestApp({ couponEveryNOrders: 1, autoGenerateCoupons: true, pgPoolMax: 20 });
});

afterAll(() => ctx.close());

const scalar = async (sql: string, params: unknown[] = []) =>
  (await ctx.pool.query(sql, params)).rows[0] as Record<string, unknown>;

describe('concurrent confirms', () => {
  it('T4: 10 parallel confirms of one quote make exactly one order', async () => {
    const cartId = await cartWith(ctx.app, ['sku-mug', 2]);
    const quote = await requestQuote(ctx.app, cartId);
    expect(quote.statusCode).toBe(201);
    const quoteId: string = quote.json().quoteId;
    const stockBefore = (await scalar("SELECT stock FROM products WHERE id = 'sku-mug'")).stock as number;
    const placedBefore = (await scalar('SELECT placed_orders FROM store_stats')).placed_orders as number;

    const results = await parallel(10, () => confirm(ctx.app, cartId, quoteId));

    const created = results.filter((r) => r.statusCode === 201);
    const replayed = results.filter((r) => r.statusCode === 200);
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(9);
    for (const r of replayed) expect(r.headers['idempotent-replayed']).toBe('true');
    expect(created[0]!.headers['idempotent-replayed']).toBeUndefined();
    for (const r of results) expect(r.json()).toEqual(created[0]!.json());

    expect((await scalar("SELECT count(*)::int AS n FROM orders WHERE cart_id = $1", [cartId])).n).toBe(1);
    expect((await scalar("SELECT stock FROM products WHERE id = 'sku-mug'")).stock).toBe(stockBefore - 2);
    expect((await scalar('SELECT placed_orders FROM store_stats')).placed_orders).toBe(placedBefore + 1);
    await expectInvariants(ctx.pool);
  });

  it('T5: 10 carts race for the last 2 sneakers; exactly 2 win and nobody oversells', async () => {
    const carts = await parallel(10, () => cartWith(ctx.app, ['sku-limited-sneaker', 1]));
    // Every quote passes: the advisory stock check sees 2 units for all of them (D3).
    const quotes = await parallel(10, async (i) => {
      const res = await requestQuote(ctx.app, carts[i]!);
      expect(res.statusCode).toBe(201);
      return res.json().quoteId as string;
    });

    const results = await parallel(10, (i) => confirm(ctx.app, carts[i]!, quotes[i]!));

    const won = results.map((r, i) => ({ r, cartId: carts[i]! })).filter(({ r }) => r.statusCode === 201);
    const lost = results.map((r, i) => ({ r, cartId: carts[i]! })).filter(({ r }) => r.statusCode !== 201);
    expect(won).toHaveLength(2);
    expect(lost).toHaveLength(8);
    for (const { r } of lost) {
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        details: [{ productId: 'sku-limited-sneaker', requested: 1, available: 0 }],
      });
    }
    expect((await scalar("SELECT stock FROM products WHERE id = 'sku-limited-sneaker'")).stock).toBe(0);
    expect(
      (await scalar("SELECT COALESCE(sum(quantity), 0)::int AS n FROM order_lines WHERE product_id = 'sku-limited-sneaker'")).n,
    ).toBe(2);

    // Losers rolled back completely: still open, no order.
    for (const { cartId } of lost) {
      expect((await scalar('SELECT status FROM carts WHERE id = $1', [cartId])).status).toBe('OPEN');
      expect((await scalar('SELECT count(*)::int AS n FROM orders WHERE cart_id = $1', [cartId])).n).toBe(0);
    }
    await expectInvariants(ctx.pool);
  });

  it('T6: 5 carts race for one coupon; exactly one order gets the discount', async () => {
    // n = 1, so this order earns a coupon. The race is on THIS code, not on "an available coupon":
    // every winner below earns another one.
    const setupCart = await cartWith(ctx.app, ['sku-sticker-pack', 1]);
    const setup = await confirm(ctx.app, setupCart, (await requestQuote(ctx.app, setupCart)).json().quoteId);
    expect(setup.statusCode).toBe(201);
    const code: string = setup.json().earnedCoupon.code;

    const carts = await parallel(5, () => cartWith(ctx.app, ['sku-notebook', 1]));
    const quotes = await parallel(5, async (i) => {
      const res = await requestQuote(ctx.app, carts[i]!, code);
      expect(res.statusCode).toBe(201);
      expect(res.json().couponApplied).toEqual({ code, percent: 10 });
      return res.json().quoteId as string;
    });

    const results = await parallel(5, (i) => confirm(ctx.app, carts[i]!, quotes[i]!));

    const winners = results.map((r, i) => ({ r, cartId: carts[i]! })).filter(({ r }) => r.statusCode === 201);
    const losers = results.map((r, i) => ({ r, cartId: carts[i]! })).filter(({ r }) => r.statusCode !== 201);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    for (const { r } of losers) {
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('COUPON_ALREADY_REDEEMED');
    }

    const order = winners[0]!.r.json().order;
    expect(order.couponApplied).toEqual({ code, percent: 10 });
    expect(order.discountPaise).toBe(1990); // floor(19900 * 10 / 100)

    // Everything below is keyed to the raced code.
    expect((await scalar('SELECT redeemed_order_id FROM coupons WHERE code = $1', [code])).redeemed_order_id).toBe(order.id);
    expect((await scalar('SELECT count(*)::int AS n FROM orders WHERE coupon_code = $1', [code])).n).toBe(1);
    for (const { cartId } of losers) {
      expect((await scalar('SELECT status FROM carts WHERE id = $1', [cartId])).status).toBe('OPEN');
    }
    await expectInvariants(ctx.pool);
  });
});
