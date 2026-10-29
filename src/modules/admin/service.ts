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
