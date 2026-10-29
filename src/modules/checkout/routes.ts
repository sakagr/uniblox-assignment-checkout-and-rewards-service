import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { withTransaction } from '../../db/tx.js';
import { CartParams } from '../carts/schemas.js';
import { Quote, QuoteBody } from './schemas.js';
import { createQuote } from './service.js';

export const checkoutRoutes: FastifyPluginAsyncTypebox<{ pool: pg.Pool }> = async (app, { pool }) => {
  app.post(
    '/carts/:cartId/checkout/quote',
    {
      schema: {
        tags: ['checkout'],
        summary: 'Price a cart (optionally with a coupon) and store the quote',
        params: CartParams,
        body: QuoteBody,
        response: { 201: Quote },
      },
      // A missing body is the same as `{}`; Ajv still validates what is there.
      preValidation: async (request) => {
        request.body ??= {};
      },
    },
    async (request, reply) => {
      const quote = await withTransaction(
        pool,
        (client) => createQuote(client, request.params.cartId, request.body.couponCode),
        // One snapshot for the cart version and its items (§6.2).
        { isolation: 'REPEATABLE READ' },
      );
      return reply.status(201).send(quote);
    },
  );
};
