import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { paise } from '../../domain/money.js';

const Product = Type.Object({
  id: Type.String(),
  name: Type.String(),
  unitPricePaise: Type.Integer(),
  stock: Type.Integer(),
  currency: Type.Literal('INR'),
});

export const productRoutes: FastifyPluginAsyncTypebox<{ pool: pg.Pool }> = async (app, { pool }) => {
  app.get(
    '/products',
    {
      schema: {
        tags: ['products'],
        summary: 'List products',
        response: { 200: Type.Array(Product) },
      },
    },
    async () => {
      const { rows } = await pool.query<{
        id: string;
        name: string;
        unit_price_paise: number;
        stock: number;
      }>('SELECT id, name, unit_price_paise, stock FROM products ORDER BY id');
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        unitPricePaise: paise(row.unit_price_paise),
        stock: row.stock,
        currency: 'INR' as const,
      }));
    },
  );
};
