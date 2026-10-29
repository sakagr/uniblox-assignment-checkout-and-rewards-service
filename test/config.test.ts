import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

function problemsFor(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('uses the spec defaults for an empty env', () => {
    expect(loadConfig({})).toEqual({
      databaseUrl: 'postgres://app:app@localhost:5432/checkout',
      testDatabaseUrl: 'postgres://app:app@localhost:5432/checkout_test',
      port: 3000,
      couponEveryNOrders: 5,
      couponPercent: 10,
      autoGenerateCoupons: true,
      pgPoolMax: 20,
    });
  });

  it('treats empty strings as unset and parses valid overrides', () => {
    const config = loadConfig({
      PORT: '',
      COUPON_EVERY_N_ORDERS: '3',
      COUPON_PERCENT: '100',
      AUTO_GENERATE_COUPONS: 'false',
      PG_POOL_MAX: '50',
    });
    expect(config).toMatchObject({
      port: 3000,
      couponEveryNOrders: 3,
      couponPercent: 100,
      autoGenerateCoupons: false,
      pgPoolMax: 50,
    });
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['COUPON_EVERY_N_ORDERS', '0'],
    ['COUPON_PERCENT', '0'],
    ['COUPON_PERCENT', '101'],
    ['PG_POOL_MAX', '0'],
    ['PORT', '-1'],
  ])('rejects %s=%s and names the variable', (name, value) => {
    const problems = problemsFor({ [name]: value });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
  });

  it.each(['5.0', '1e3', ' 5', 'abc', '0x10'])('rejects non-plain integer "%s"', (value) => {
    expect(problemsFor({ COUPON_EVERY_N_ORDERS: value })[0]).toContain('COUPON_EVERY_N_ORDERS');
  });

  it.each(['yes', 'TRUE', '1'])('rejects boolean "%s"', (value) => {
    expect(problemsFor({ AUTO_GENERATE_COUPONS: value })[0]).toContain('AUTO_GENERATE_COUPONS');
  });

  it('rejects non-postgres URLs without echoing the value', () => {
    const problems = problemsFor({ DATABASE_URL: 'mysql://user:secret@host/db' });
    expect(problems[0]).toContain('DATABASE_URL');
    expect(problems[0]).not.toContain('secret');
    expect(problemsFor({ TEST_DATABASE_URL: 'not a url' })[0]).toContain('TEST_DATABASE_URL');
  });

  it('reports every bad variable together', () => {
    const problems = problemsFor({ PORT: 'x', COUPON_PERCENT: '500', AUTO_GENERATE_COUPONS: 'maybe' });
    expect(problems).toHaveLength(3);
  });
});
