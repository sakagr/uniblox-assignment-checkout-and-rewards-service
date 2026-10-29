import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import type { Config } from '../../config.js';
import { withTransaction } from '../../db/tx.js';
import { CartParams } from '../carts/schemas.js';
import { ConfirmBody, ConfirmResponse, Quote, QuoteBody } from './schemas.js';
import { confirmCheckout, createQuote } from './service.js';

export const checkoutRoutes: FastifyPluginAsyncTypebox<{ pool: pg.Pool; config: Config }> = async (
  app,
  { pool, config },
) => {
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

  app.post(
    '/carts/:cartId/checkout',
    {
      schema: {
        tags: ['checkout'],
        summary: 'Place the order for a quote (idempotent per cart and quote)',
        params: CartParams,
        body: ConfirmBody,
        response: { 200: ConfirmResponse, 201: ConfirmResponse },
      },
    },
    async (request, reply) => {
      const { replayed, order } = await withTransaction(pool, (client) =>
        confirmCheckout(client, request.params.cartId, request.body.quoteId, config),
      );
      if (replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(replayed ? 200 : 201).send({ order, earnedCoupon: order.earnedCoupon });
    },
  );
};
