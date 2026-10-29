import { Type } from '@fastify/type-provider-typebox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Errors } from '../src/domain/errors.js';
import { createTestApp, setupTestDb } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  await setupTestDb();
  ctx = await createTestApp();
  const { app, pool } = ctx;

  app.put(
    '/test/qty',
    { schema: { body: Type.Object({ quantity: Type.Integer({ minimum: 0, maximum: 1000 }) }, { additionalProperties: false }) } },
    async (request) => ({ quantity: request.body.quantity }),
  );
  app.get('/test/domain', async () => {
    throw Errors.insufficientStock([{ productId: 'sku-mug', requested: 3, available: 1 }]);
  });
  app.get('/test/plain', async () => {
    throw new Error('secret internal detail');
  });
  const raise = (sqlstate: string, constraint?: string) => async () => {
    await pool.query(
      `DO $$ BEGIN RAISE EXCEPTION 'forced' USING ERRCODE = '${sqlstate}'${constraint ? `, CONSTRAINT = '${constraint}'` : ''}; END $$`,
    );
  };
  app.get('/test/deadlock', raise('40P01'));
  app.get('/test/coupon-collision', raise('23505', 'coupons_code_key'));
  app.get('/test/other-unique', raise('23505', 'orders_cart_id_key'));
});

afterAll(() => ctx.close());

const envelopeKeys = ['code', 'details', 'message'];

describe('GET /health', () => {
  it('returns ok after a database round trip', async () => {
    const res = await ctx.app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('error envelope', () => {
  it('answers unknown routes with ROUTE_NOT_FOUND', async () => {
    const res = await ctx.app.inject('/nope?x=1');
    expect(res.statusCode).toBe(404);
    const { error } = res.json();
    expect(Object.keys(error).sort()).toEqual(envelopeKeys);
    expect(error.code).toBe('ROUTE_NOT_FOUND');
    expect(error.details).toEqual({ method: 'GET', url: '/nope?x=1' });
  });

  it('maps a DomainError to its status, code and details', async () => {
    const res = await ctx.app.inject('/test/domain');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: [{ productId: 'sku-mug', requested: 3, available: 1 }],
    });
  });

  it.each([
    ['deadlock 40P01', '/test/deadlock'],
    ['coupon code collision', '/test/coupon-collision'],
  ])('maps %s to 503 TRANSIENT_CONFLICT', async (_name, url) => {
    const res = await ctx.app.inject(url);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('TRANSIENT_CONFLICT');
  });

  it('does not treat other unique violations as transient', async () => {
    const res = await ctx.app.inject('/test/other-unique');
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
  });

  it('hides internals of unknown errors but includes a request id', async () => {
    const res = await ctx.app.inject('/test/plain');
    expect(res.statusCode).toBe(500);
    const { error } = res.json();
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.details.requestId).toBeTruthy();
    expect(res.body).not.toContain('secret internal detail');
    expect(res.body).not.toContain('at ');
  });
});

describe('request validation', () => {
  const put = (payload: string, contentType = 'application/json') =>
    ctx.app.inject({ method: 'PUT', url: '/test/qty', payload, headers: { 'content-type': contentType } });

  it('accepts a valid integer', async () => {
    const res = await put('{"quantity":5}');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ quantity: 5 });
  });

  it('rejects "5" for an integer field (coerceTypes: false)', async () => {
    const res = await put('{"quantity":"5"}');
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details[0]).toMatchObject({ location: 'body', path: '/quantity' });
  });

  it.each(['1.5', '-1', '1001'])('rejects quantity %s', async (value) => {
    expect((await put(`{"quantity":${value}}`)).statusCode).toBe(400);
  });

  it('rejects unknown properties instead of stripping them (removeAdditional: false)', async () => {
    const res = await put('{"quantity":5,"extra":true}');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe('/extra');
  });

  it('names a missing required property', async () => {
    const res = await put('{}');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe('/quantity');
  });

  it('answers malformed JSON with a 400 envelope', async () => {
    const res = await put('{"quantity":');
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().error).sort()).toEqual(envelopeKeys);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('OpenAPI', () => {
  it('serves the document and lists /health', async () => {
    const res = await ctx.app.inject('/docs/json');
    expect(res.statusCode).toBe(200);
    expect(res.json().paths['/health']).toBeDefined();
  });
});
