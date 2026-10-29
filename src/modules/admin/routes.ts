import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import type { Config } from '../../config.js';
import { withTransaction } from '../../db/tx.js';
import { AdminOrder, Coupon, CouponListQuery, GenerateCouponResponse, Report } from './schemas.js';
import { buildReport, generateMilestoneCoupon, listCoupons, listOrders } from './service.js';

/** Admin-only endpoints (no authentication, DECISIONS §7). */
export const adminRoutes: FastifyPluginAsyncTypebox<{ pool: pg.Pool; config: Config }> = async (
  app,
  { pool, config },
) => {
  app.post(
    '/admin/coupons',
    {
      schema: {
        tags: ['admin'],
        summary: '(admin) Generate the coupon for the lowest reached milestone that has none',
        response: { 201: GenerateCouponResponse },
      },
    },
    async (_request, reply) => {
      const result = await withTransaction(pool, (client) => generateMilestoneCoupon(client, config));
      return reply.status(201).send(result);
    },
  );

  app.get(
    '/admin/coupons',
    {
      schema: {
        tags: ['admin'],
        summary: '(admin) List coupons by milestone, optionally filtered by status',
        querystring: CouponListQuery,
        response: { 200: Type.Array(Coupon) },
      },
    },
    (request) => listCoupons(pool, request.query.status),
  );

  app.get(
    '/admin/orders',
    {
      schema: {
        tags: ['admin'],
        summary: '(admin) List placed orders by placement number',
        response: { 200: Type.Array(AdminOrder) },
      },
    },
    () => listOrders(pool),
  );

  app.get(
    '/admin/report',
    {
      schema: {
        tags: ['admin'],
        summary: '(admin) Sales and coupon summary',
        response: { 200: Report },
      },
    },
    () => withTransaction(pool, buildReport, { isolation: 'REPEATABLE READ', readOnly: true }),
  );
};
