import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { withTransaction } from '../../db/tx.js';
import { errorResponses } from '../../http/error-responses.js';
import { Order, OrderParams } from './schemas.js';
import { loadOrder } from './service.js';

export const orderRoutes: FastifyPluginAsyncTypebox<{ pool: pg.Pool }> = async (app, { pool }) => {
  app.get(
    '/orders/:orderId',
    {
      schema: {
        tags: ['orders'],
        summary: 'View a placed order (an immutable snapshot)',
        params: OrderParams,
        response: {
          200: Order,
          ...errorResponses({ 400: ['VALIDATION_ERROR'], 404: ['ORDER_NOT_FOUND'] }),
        },
      },
    },
    // One snapshot, so the header and the lines cannot be torn.
    (request) =>
      withTransaction(pool, (client) => loadOrder(client, request.params.orderId), {
        isolation: 'REPEATABLE READ',
        readOnly: true,
      }),
  );
};
