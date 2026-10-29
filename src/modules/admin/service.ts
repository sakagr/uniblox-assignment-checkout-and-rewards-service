import type pg from 'pg';
import type { Config } from '../../config.js';
import { generateCouponCode } from '../../domain/coupon-code.js';
import { Errors } from '../../domain/errors.js';

export interface CouponRow {
  code: string;
  percent: number;
  milestone: number;
  milestone_order_id: string;
  source: 'AUTO' | 'ADMIN';
  redeemed_order_id: string | null;
  created_at: Date;
  redeemed_at: Date | null;
}

export function toCoupon(row: CouponRow) {
  return {
    code: row.code,
    percent: row.percent,
    milestone: row.milestone,
    milestoneOrderId: row.milestone_order_id,
    source: row.source,
    status: row.redeemed_order_id === null ? ('AVAILABLE' as const) : ('REDEEMED' as const),
    redeemedOrderId: row.redeemed_order_id,
    createdAt: row.created_at.toISOString(),
    redeemedAt: row.redeemed_at?.toISOString() ?? null,
  };
}

export type MilestoneConfig = Pick<Config, 'couponEveryNOrders' | 'couponPercent'>;

/**
 * §6.4: one coupon for the lowest reached milestone that has none. Run in READ COMMITTED.
 *
 * The counter lock serializes admin calls, so a loser waits and then sees the winner's coupon
 * (a clean 409, never a UNIQUE(milestone) violation), and it makes admin wait for an in-flight
 * confirm, which holds the counter until commit. Lock order (D9): store_stats -> coupon insert.
 */
export async function generateMilestoneCoupon(client: pg.PoolClient, config: MilestoneConfig) {
  const n = config.couponEveryNOrders;
  const stats = await client.query<{ placed_orders: number }>('SELECT placed_orders FROM store_stats FOR UPDATE');
  const placedOrders = stats.rows[0]!.placed_orders;
  const reached = Math.floor(placedOrders / n);

  // Coupons for reached milestones only, so a coupon beyond them (n changed between runs) never
  // makes the pending count negative. In normal operation this is every coupon.
  const countRewarded = async () =>
    (
      await client.query<{ rewarded: number }>(
        'SELECT count(*)::int AS rewarded FROM coupons WHERE milestone <= $1',
        [reached],
      )
    ).rows[0]!.rewarded;

  const next = await client.query<{ k: number }>(
    `SELECT k FROM generate_series(1, $1::int) AS k
      WHERE NOT EXISTS (SELECT 1 FROM coupons c WHERE c.milestone = k)
      ORDER BY k LIMIT 1`,
    [reached],
  );
  if (next.rows.length === 0) {
    throw Errors.noEligibleMilestone({
      placedOrders,
      rewardedMilestones: await countRewarded(),
      nextMilestoneAtOrder: (reached + 1) * n,
    });
  }
  const milestone = next.rows[0]!.k;

  // The counter is gapless (I9), so the milestone order exists whenever the milestone is reached.
  const order = await client.query<{ id: string }>('SELECT id FROM orders WHERE placement_number = $1', [
    milestone * n,
  ]);
  if (order.rows.length === 0) {
    throw new Error(`invariant breach: no order at placement ${milestone * n} for reached milestone ${milestone}`);
  }

  const inserted = await client.query<CouponRow>(
    `INSERT INTO coupons (code, percent, milestone, milestone_order_id, source)
     VALUES ($1, $2, $3, $4, 'ADMIN')
     RETURNING code, percent, milestone, milestone_order_id, source, redeemed_order_id, created_at, redeemed_at`,
    [generateCouponCode(), config.couponPercent, milestone, order.rows[0]!.id],
  );

  return { coupon: toCoupon(inserted.rows[0]!), pendingMilestones: reached - (await countRewarded()) };
}

// Fixed lookup: the filter is never interpolated from the caller's string.
const COUPON_STATUS_FILTER = {
  AVAILABLE: 'WHERE redeemed_order_id IS NULL',
  REDEEMED: 'WHERE redeemed_order_id IS NOT NULL',
} as const;

/** One statement, so one snapshot; no transaction needed. */
export async function listCoupons(pool: pg.Pool, status?: keyof typeof COUPON_STATUS_FILTER) {
  const { rows } = await pool.query<CouponRow>(
    `SELECT code, percent, milestone, milestone_order_id, source, redeemed_order_id, created_at, redeemed_at
       FROM coupons ${status === undefined ? '' : COUPON_STATUS_FILTER[status]} ORDER BY milestone`,
  );
  return rows.map(toCoupon);
}

export async function listOrders(pool: pg.Pool) {
  const { rows } = await pool.query<{
    id: string;
    placement_number: number;
    subtotal_paise: number;
    discount_paise: number;
    total_paise: number;
    coupon_code: string | null;
    created_at: Date;
  }>(
    `SELECT id, placement_number, subtotal_paise, discount_paise, total_paise, coupon_code, created_at
       FROM orders ORDER BY placement_number`,
  );
  return rows.map((o) => ({
    id: o.id,
    placementNumber: o.placement_number,
    subtotalPaise: o.subtotal_paise,
    discountPaise: o.discount_paise,
    totalPaise: o.total_paise,
    couponCode: o.coupon_code,
    createdAt: o.created_at.toISOString(),
    currency: 'INR' as const,
  }));
}

/**
 * §6.5. Run in REPEATABLE READ READ ONLY: the three queries share one snapshot, so the figures
 * agree with each other (net = gross - discount, generated = available + redeemed). sum() and
 * count() arrive as numeric / int8 and go through the pool's safe-integer parser.
 */
export async function buildReport(client: pg.PoolClient) {
  const totals = await client.query<{ placed_orders: number; gross: number; discount: number; net: number }>(
    `SELECT count(*) AS placed_orders,
            COALESCE(sum(subtotal_paise), 0) AS gross,
            COALESCE(sum(discount_paise), 0) AS discount,
            COALESCE(sum(total_paise), 0)    AS net
       FROM orders`,
  );
  const sold = await client.query<{ id: string; name: string; quantity: number }>(
    `SELECT p.id, p.name, COALESCE(sum(ol.quantity), 0) AS quantity
       FROM products p LEFT JOIN order_lines ol ON ol.product_id = p.id
      GROUP BY p.id, p.name ORDER BY p.id`,
  );
  const coupons = await client.query<{ generated: number; available: number; redeemed: number }>(
    `SELECT count(*) AS generated,
            count(*) FILTER (WHERE redeemed_order_id IS NULL)     AS available,
            count(*) FILTER (WHERE redeemed_order_id IS NOT NULL) AS redeemed
       FROM coupons`,
  );
  const t = totals.rows[0]!;
  const c = coupons.rows[0]!;
  return {
    placedOrders: t.placed_orders,
    productsSold: sold.rows.map((p) => ({ productId: p.id, name: p.name, quantity: p.quantity })),
    grossRevenuePaise: t.gross,
    totalDiscountPaise: t.discount,
    netRevenuePaise: t.net,
    coupons: { generated: c.generated, available: c.available, redeemed: c.redeemed },
    currency: 'INR' as const,
    generatedAt: new Date().toISOString(),
  };
}
