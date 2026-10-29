import type pg from 'pg';
import { Errors } from '../../domain/errors.js';

/** Reads an order and its snapshot lines. Nothing here depends on current product data (I7). */
export async function loadOrder(client: pg.PoolClient, orderId: string) {
  const header = await client.query<{
    id: string;
    cart_id: string;
    quote_id: string;
    placement_number: number;
    subtotal_paise: number;
    coupon_code: string | null;
    coupon_percent: number | null;
    discount_paise: number;
    total_paise: number;
    created_at: Date;
    earned_code: string | null;
    earned_percent: number | null;
    earned_milestone: number | null;
  }>(
    `SELECT o.id, o.cart_id, o.quote_id, o.placement_number, o.subtotal_paise, o.coupon_code,
            o.coupon_percent, o.discount_paise, o.total_paise, o.created_at,
            c.code AS earned_code, c.percent AS earned_percent, c.milestone AS earned_milestone
       FROM orders o LEFT JOIN coupons c ON c.milestone_order_id = o.id
      WHERE o.id = $1`,
    [orderId],
  );
  if (header.rows.length === 0) throw Errors.orderNotFound();
  const o = header.rows[0]!;

  const lines = await client.query<{
    product_id: string;
    product_name: string;
    unit_price_paise: number;
    quantity: number;
    line_total_paise: number;
  }>(
    `SELECT product_id, product_name, unit_price_paise, quantity, line_total_paise
       FROM order_lines WHERE order_id = $1 ORDER BY product_id`,
    [orderId],
  );

  return {
    id: o.id,
    cartId: o.cart_id,
    quoteId: o.quote_id,
    placementNumber: o.placement_number,
    lines: lines.rows.map((l) => ({
      productId: l.product_id,
      name: l.product_name,
      unitPricePaise: l.unit_price_paise,
      quantity: l.quantity,
      lineTotalPaise: l.line_total_paise,
    })),
    subtotalPaise: o.subtotal_paise,
    couponApplied:
      o.coupon_code !== null && o.coupon_percent !== null
        ? { code: o.coupon_code, percent: o.coupon_percent }
        : null,
    discountPaise: o.discount_paise,
    totalPaise: o.total_paise,
    earnedCoupon:
      o.earned_code !== null && o.earned_percent !== null && o.earned_milestone !== null
        ? { code: o.earned_code, percent: o.earned_percent, milestone: o.earned_milestone }
        : null,
    currency: 'INR' as const,
    createdAt: o.created_at.toISOString(),
  };
}
