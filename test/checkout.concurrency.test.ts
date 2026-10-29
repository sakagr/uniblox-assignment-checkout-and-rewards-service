// Stock ownership (orders are insert-only, so consumed stock cannot be restored):
//   sku-mug              T4
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
});
