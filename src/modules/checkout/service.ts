import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { normalizeCouponCode } from '../../domain/coupon-code.js';
import { Errors, type PriceChange, type StockShortfall } from '../../domain/errors.js';
import { calculateTotals, paise } from '../../domain/money.js';
import { loadCartItems } from '../carts/service.js';
import { loadOrder } from '../orders/service.js';

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

  const items = await loadCartItems(client, cartId);
  if (items.length === 0) throw Errors.emptyCart();

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
  const shortfalls: StockShortfall[] = items
    .filter((row) => row.quantity > row.stock)
    .map((row) => ({ productId: row.product_id, requested: row.quantity, available: row.stock }));
  if (shortfalls.length > 0) throw Errors.insufficientStock(shortfalls);

  const totals = calculateTotals(
    items.map((row) => ({
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

interface QuoteRow {
  cart_version: number;
  coupon_id: string | null;
  coupon_percent: number | null;
  subtotal_paise: number;
  discount_paise: number;
  total_paise: number;
}

interface QuoteLineRow {
  product_id: string;
  product_name: string;
  unit_price_paise: number;
  quantity: number;
}

/**
 * SPECIFICATIONS §6.3. Runs in READ COMMITTED. Lock order (D9): cart -> coupon
 * -> products (by id) -> store_stats. Quote rows are only read, never locked,
 * so reading the quote after the cart lock does not change that order.
 * Any error rolls the whole transaction back, so nothing is half-applied.
 */
export async function confirmCheckout(client: pg.PoolClient, cartId: string, quoteId: string) {
  // 1. Lock the cart. This serializes confirms and item edits on this cart.
  const cart = await client.query<{ status: 'OPEN' | 'CHECKED_OUT'; version: number }>(
    'SELECT status, version FROM carts WHERE id = $1 FOR UPDATE',
    [cartId],
  );
  if (cart.rows.length === 0) throw Errors.cartNotFound();
  const { status, version } = cart.rows[0]!;

  // 2. Already checked out: the same quote is a retry and replays the order; anything else is a conflict (D2).
  if (status !== 'OPEN') {
    const existing = await client.query<{ id: string; quote_id: string }>(
      'SELECT id, quote_id FROM orders WHERE cart_id = $1',
      [cartId],
    );
    if (existing.rows.length === 0 || existing.rows[0]!.quote_id !== quoteId) throw Errors.cartAlreadyCheckedOut();
    return { replayed: true, order: await loadOrder(client, existing.rows[0]!.id) };
  }

  // 3. The quote must exist and belong to this cart.
  const quoteResult = await client.query<QuoteRow>(
    `SELECT cart_version, coupon_id, coupon_percent, subtotal_paise, discount_paise, total_paise
       FROM checkout_quotes WHERE id = $1 AND cart_id = $2`,
    [quoteId, cartId],
  );
  if (quoteResult.rows.length === 0) throw Errors.quoteNotFound();
  const quote = quoteResult.rows[0]!;
  const quoteLines = (
    await client.query<QuoteLineRow>(
      `SELECT product_id, product_name, unit_price_paise, quantity
         FROM quote_lines WHERE quote_id = $1 ORDER BY product_id`,
      [quoteId],
    )
  ).rows;

  // 4. Item edits bump the version under the cart lock, so equal versions mean equal items.
  if (version !== quote.cart_version) throw Errors.quoteStale({ reason: 'CART_CHANGED' });
  const items = await loadCartItems(client, cartId);
  const sameItems =
    items.length === quoteLines.length &&
    items.every((item, i) => item.product_id === quoteLines[i]!.product_id && item.quantity === quoteLines[i]!.quantity);
  if (!sameItems) throw new Error(`cart ${cartId} items differ from quote ${quoteId} at the same version`);

  // 5. Redeem the coupon with a conditional update. The order row does not exist yet:
  //    the deferred FK is checked at COMMIT (D4).
  const orderId = randomUUID();
  let couponCode: string | null = null;
  if (quote.coupon_id !== null) {
    const redeemed = await client.query<{ code: string }>(
      `UPDATE coupons SET redeemed_order_id = $1, redeemed_at = now()
        WHERE id = $2 AND redeemed_order_id IS NULL RETURNING code`,
      [orderId, quote.coupon_id],
    );
    if (redeemed.rowCount === 0) throw Errors.couponAlreadyRedeemed();
    couponCode = redeemed.rows[0]!.code;
  }

  // 6. Lock the products in id order, THEN compare prices (closes the check-to-use gap).
  const productIds = quoteLines.map((line) => line.product_id);
  const locked = await client.query<{ id: string; unit_price_paise: number; stock: number }>(
    'SELECT id, unit_price_paise, stock FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE',
    [productIds],
  );
  const current = new Map(locked.rows.map((row) => [row.id, row]));

  const priceChanges: PriceChange[] = [];
  const shortfalls: StockShortfall[] = [];
  for (const line of quoteLines) {
    const product = current.get(line.product_id);
    if (!product) throw new Error(`product ${line.product_id} vanished under lock`);
    if (product.unit_price_paise !== line.unit_price_paise) {
      priceChanges.push({
        productId: line.product_id,
        quotedPaise: line.unit_price_paise,
        currentPaise: product.unit_price_paise,
      });
    }
    if (product.stock < line.quantity) {
      shortfalls.push({ productId: line.product_id, requested: line.quantity, available: product.stock });
    }
  }
  // A changed price makes the whole quote stale, so it is reported before any shortfall.
  if (priceChanges.length > 0) throw Errors.quoteStale({ reason: 'PRICE_CHANGED', changes: priceChanges });
  if (shortfalls.length > 0) throw Errors.insufficientStock(shortfalls);

  // 7. Guarded decrement. One statement for all lines: its row locks are taken in arbitrary
  //    order, so it is deadlock-safe ONLY because step 6 already holds every one of these
  //    rows, locked in id order. Remove that FOR UPDATE and this can deadlock with another confirm.
  const decremented = await client.query<{ id: string }>(
    `UPDATE products p SET stock = p.stock - v.qty, updated_at = now()
       FROM unnest($1::text[], $2::int[]) AS v(id, qty)
      WHERE p.id = v.id AND p.stock >= v.qty
      RETURNING p.id`,
    [productIds, quoteLines.map((line) => line.quantity)],
  );
  if (decremented.rowCount !== quoteLines.length) {
    const done = new Set(decremented.rows.map((row) => row.id));
    throw Errors.insufficientStock(
      quoteLines
        .filter((line) => !done.has(line.product_id))
        .map((line) => ({
          productId: line.product_id,
          requested: line.quantity,
          available: current.get(line.product_id)!.stock,
        })),
    );
  }

  // 8. The quote's totals were computed from these same lines; recompute and compare.
  const totals = calculateTotals(
    quoteLines.map((line) => ({
      productId: line.product_id,
      name: line.product_name,
      unitPricePaise: paise(line.unit_price_paise),
      quantity: line.quantity,
    })),
    quote.coupon_percent,
  );
  if (
    totals.subtotalPaise !== quote.subtotal_paise ||
    totals.discountPaise !== quote.discount_paise ||
    totals.totalPaise !== quote.total_paise
  ) {
    throw new Error(`quote ${quoteId} totals do not match its lines`);
  }

  // 9. The counter is locked last and held until commit.
  const counter = await client.query<{ placed_orders: number }>(
    'UPDATE store_stats SET placed_orders = placed_orders + 1 RETURNING placed_orders',
  );
  const placementNumber = counter.rows[0]!.placed_orders;

  // 10. Write the order and its snapshot, then close the cart.
  await client.query(
    `INSERT INTO orders (id, cart_id, quote_id, placement_number, subtotal_paise,
                         coupon_code, coupon_percent, discount_paise, total_paise)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      orderId,
      cartId,
      quoteId,
      placementNumber,
      totals.subtotalPaise,
      couponCode,
      quote.coupon_percent,
      totals.discountPaise,
      totals.totalPaise,
    ],
  );
  await client.query(
    `INSERT INTO order_lines (order_id, product_id, product_name, unit_price_paise, quantity, line_total_paise)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bigint[], $5::int[], $6::bigint[])`,
    [
      orderId,
      totals.lines.map((l) => l.productId),
      totals.lines.map((l) => l.name),
      totals.lines.map((l) => l.unitPricePaise),
      totals.lines.map((l) => l.quantity),
      totals.lines.map((l) => l.lineTotalPaise),
    ],
  );
  await client.query("UPDATE carts SET status = 'CHECKED_OUT', updated_at = now() WHERE id = $1", [cartId]);

  return { replayed: false, order: await loadOrder(client, orderId) };
}
