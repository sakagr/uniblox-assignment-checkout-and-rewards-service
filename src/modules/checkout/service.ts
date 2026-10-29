import type pg from 'pg';
import { normalizeCouponCode } from '../../domain/coupon-code.js';
import { Errors, type StockShortfall } from '../../domain/errors.js';
import { calculateTotals, paise } from '../../domain/money.js';

/**
 * SPECIFICATIONS §6.2. Must run in a REPEATABLE READ transaction so the cart
 * version and its items come from one snapshot. Reads only; nothing is locked
 * or reserved, the quote rows are the only writes.
 */
export async function createQuote(client: pg.PoolClient, cartId: string, couponCode: string | undefined) {
  const cart = await client.query<{ status: 'OPEN' | 'CHECKED_OUT'; version: number }>(
    'SELECT status, version FROM carts WHERE id = $1',
    [cartId],
  );
  if (cart.rows.length === 0) throw Errors.cartNotFound();
  const { status, version } = cart.rows[0]!;
  if (status !== 'OPEN') throw Errors.cartAlreadyCheckedOut();

  const items = await client.query<{
    product_id: string;
    quantity: number;
    name: string;
    unit_price_paise: number;
    stock: number;
  }>(
    `SELECT ci.product_id, ci.quantity, p.name, p.unit_price_paise, p.stock
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1 ORDER BY ci.product_id`,
    [cartId],
  );
  if (items.rows.length === 0) throw Errors.emptyCart();

  let coupon: { id: string; code: string; percent: number } | null = null;
  if (couponCode !== undefined) {
    const code = normalizeCouponCode(couponCode);
    const found = await client.query<{
      id: string;
      code: string;
      percent: number;
      redeemed_order_id: string | null;
    }>('SELECT id, code, percent, redeemed_order_id FROM coupons WHERE code = $1', [code]);
    if (found.rows.length === 0) throw Errors.couponInvalid();
    const row = found.rows[0]!;
    if (row.redeemed_order_id !== null) throw Errors.couponAlreadyRedeemed();
    coupon = { id: row.id, code: row.code, percent: row.percent };
  }

  // Advisory only (D3): report every short line, not just the first.
  const shortfalls: StockShortfall[] = items.rows
    .filter((row) => row.quantity > row.stock)
    .map((row) => ({ productId: row.product_id, requested: row.quantity, available: row.stock }));
  if (shortfalls.length > 0) throw Errors.insufficientStock(shortfalls);

  const totals = calculateTotals(
    items.rows.map((row) => ({
      productId: row.product_id,
      name: row.name,
      unitPricePaise: paise(row.unit_price_paise),
      quantity: row.quantity,
      availableStock: row.stock,
    })),
    coupon?.percent ?? null,
  );

  const inserted = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO checkout_quotes
       (cart_id, cart_version, coupon_id, coupon_percent, subtotal_paise, discount_paise, total_paise)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
    [
      cartId,
      version,
      coupon?.id ?? null,
      coupon?.percent ?? null,
      totals.subtotalPaise,
      totals.discountPaise,
      totals.totalPaise,
    ],
  );
  const quote = inserted.rows[0]!;

  await client.query(
    `INSERT INTO quote_lines (quote_id, product_id, product_name, unit_price_paise, quantity, line_total_paise)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bigint[], $5::int[], $6::bigint[])`,
    [
      quote.id,
      totals.lines.map((l) => l.productId),
      totals.lines.map((l) => l.name),
      totals.lines.map((l) => l.unitPricePaise),
      totals.lines.map((l) => l.quantity),
      totals.lines.map((l) => l.lineTotalPaise),
    ],
  );

  return {
    quoteId: quote.id,
    cartId,
    cartVersion: version,
    lines: totals.lines.map((line) => ({ ...line, sufficientStock: true })),
    subtotalPaise: totals.subtotalPaise,
    couponApplied: coupon ? { code: coupon.code, percent: coupon.percent } : null,
    discountPaise: totals.discountPaise,
    totalPaise: totals.totalPaise,
    currency: 'INR' as const,
    createdAt: quote.created_at.toISOString(),
  };
}
