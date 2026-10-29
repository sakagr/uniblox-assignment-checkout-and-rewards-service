import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { withTransaction } from '../../db/tx.js';
import { errorResponses } from '../../http/error-responses.js';
import { CartParams, CartView, ItemParams, SetQuantityBody } from './schemas.js';
import { createCart, loadCartView, removeItem, setItemQuantity } from './service.js';

export const cartRoutes: FastifyPluginAsyncTypebox<{ pool: pg.Pool }> = async (app, { pool }) => {
  app.post(
    '/carts',
    {
      schema: {
        tags: ['carts'],
        summary: 'Create an empty cart',
        response: { 201: CartView, ...errorResponses({ 503: ['TRANSIENT_CONFLICT'] }) },
      },
    },
    async (_request, reply) => {
      const view = await withTransaction(pool, async (client) => loadCartView(client, await createCart(client)));
      return reply.status(201).header('Location', `/carts/${view.id}`).send(view);
    },
  );

  app.get(
    '/carts/:cartId',
    {
      schema: {
        tags: ['carts'],
        summary: 'View a cart with current prices and stock',
        params: CartParams,
        response: {
          200: CartView,
          ...errorResponses({ 400: ['VALIDATION_ERROR'], 404: ['CART_NOT_FOUND'] }),
        },
      },
    },
    // One snapshot, so the header and the lines cannot be torn by a concurrent edit.
    (request) =>
      withTransaction(pool, (client) => loadCartView(client, request.params.cartId), {
        isolation: 'REPEATABLE READ',
        readOnly: true,
      }),
  );

  app.put(
    '/carts/:cartId/items/:productId',
    {
      schema: {
        tags: ['carts'],
        summary: 'Set the absolute quantity of a line (0 removes it)',
        description:
          'Quantity 0 on a product that is not in the catalogue returns 404 PRODUCT_NOT_FOUND, ' +
          'unlike DELETE, which is a no-op that returns 200.',
        params: ItemParams,
        body: SetQuantityBody,
        response: {
          200: CartView,
          ...errorResponses({
            400: ['VALIDATION_ERROR'],
            404: ['CART_NOT_FOUND', 'PRODUCT_NOT_FOUND'],
            409: ['CART_ALREADY_CHECKED_OUT', 'INSUFFICIENT_STOCK'],
            503: ['TRANSIENT_CONFLICT'],
          }),
        },
      },
    },
    (request) => {
      const { cartId, productId } = request.params;
      return withTransaction(pool, async (client) => {
        await setItemQuantity(client, cartId, productId, request.body.quantity);
        return loadCartView(client, cartId);
      });
    },
  );

  app.delete(
    '/carts/:cartId/items/:productId',
    {
      schema: {
        tags: ['carts'],
        summary: 'Remove a line (absent line is a no-op)',
        description: 'Always 200 for an existing open cart, even for an unknown or absent product.',
        params: ItemParams,
        response: {
          200: CartView,
          ...errorResponses({
            400: ['VALIDATION_ERROR'],
            404: ['CART_NOT_FOUND'],
            409: ['CART_ALREADY_CHECKED_OUT'],
            503: ['TRANSIENT_CONFLICT'],
          }),
        },
      },
    },
    (request) => {
      const { cartId, productId } = request.params;
      return withTransaction(pool, async (client) => {
        await removeItem(client, cartId, productId);
        return loadCartView(client, cartId);
      });
    },
  );
};
