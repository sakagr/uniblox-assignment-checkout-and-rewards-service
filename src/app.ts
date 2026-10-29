import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import ajvFormats from 'ajv-formats';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import { registerErrorHandling } from './http/error-handler.js';
import { productRoutes } from './modules/products/routes.js';

type AjvPlugin = NonNullable<NonNullable<FastifyServerOptions['ajv']>['plugins']>[number];

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  logger?: boolean;
}

/**
 * Builds the Fastify instance without calling ready(), so tests can add
 * routes first. Route modules (tasks 5+) receive `config` and `pool` directly.
 */
export async function buildApp({ pool, logger = false }: AppDeps) {
  const app = Fastify({
    logger,
    ajv: {
      // "5" must not be accepted for an integer, and unknown fields must not be silently dropped.
      customOptions: { coerceTypes: false, removeAdditional: false, allErrors: true },
      // Under NodeNext the CJS default import is typed as the module namespace; .default is the
      // plugin, and its options parameter is narrower than Fastify's `unknown`, hence the cast.
      plugins: [ajvFormats.default as unknown as AjvPlugin],
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(swagger, {
    openapi: {
      info: { title: 'Checkout and Rewards Service', version: '0.1.0' },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  registerErrorHandling(app);

  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness and database check',
        response: { 200: Type.Object({ status: Type.Literal('ok') }) },
      },
    },
    async () => {
      await pool.query('SELECT 1');
      return { status: 'ok' as const };
    },
  );

  await app.register(productRoutes, { pool });

  return app;
}
