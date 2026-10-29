import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import type { Config } from '../../config.js';
import { withTransaction } from '../../db/tx.js';
import { errorResponses } from '../../http/error-responses.js';
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
        response: {
          201: Quote,
          ...errorResponses({
            400: ['VALIDATION_ERROR'],
            404: ['CART_NOT_FOUND'],
            409: ['CART_ALREADY_CHECKED_OUT', 'COUPON_ALREADY_REDEEMED', 'INSUFFICIENT_STOCK'],
            422: ['EMPTY_CART', 'COUPON_INVALID'],
            503: ['TRANSIENT_CONFLICT'],
          }),
        },
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
        description:
          '201 for a new order. 200 with the same body and `Idempotent-Replayed: true` when this quote already produced the order. ' +
          'Every 409 leaves the cart OPEN and the coupon available, so re-quote and confirm again. ' +
          'An unknown quote on an already checked-out cart returns 409 CART_ALREADY_CHECKED_OUT, not 404.',
        params: CartParams,
        body: ConfirmBody,
        response: {
          200: ConfirmResponse,
          201: ConfirmResponse,
          ...errorResponses({
            400: ['VALIDATION_ERROR'],
            404: ['CART_NOT_FOUND', 'QUOTE_NOT_FOUND'],
            409: [
              'CART_ALREADY_CHECKED_OUT',
              'QUOTE_STALE',
              'COUPON_ALREADY_REDEEMED',
              'INSUFFICIENT_STOCK',
            ],
            503: ['TRANSIENT_CONFLICT'],
          }),
        },
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
