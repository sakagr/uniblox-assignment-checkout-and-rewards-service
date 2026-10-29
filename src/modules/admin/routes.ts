import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import type { Config } from '../../config.js';
import { withTransaction } from '../../db/tx.js';
import { GenerateCouponResponse } from './schemas.js';
import { generateMilestoneCoupon } from './service.js';

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
};
