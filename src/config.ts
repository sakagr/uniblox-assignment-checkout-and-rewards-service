/** Environment configuration (SPECIFICATIONS §1). Invalid values fail fast, naming the variable. */

export interface Config {
  databaseUrl: string;
  testDatabaseUrl: string;
  port: number;
  couponEveryNOrders: number;
  couponPercent: number;
  autoGenerateCoupons: boolean;
  pgPoolMax: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  // An empty string counts as unset.
  const raw = (name: string, fallback: string): string => {
    const value = env[name];
    return value === undefined || value === '' ? fallback : value;
  };

  const int = (name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const text = raw(name, String(fallback));
    const value = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      problems.push(
        `${name} must be an integer ${max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `in ${min}..${max}`}, got "${text}"`,
      );
      return fallback;
    }
    return value;
  };

  const bool = (name: string, fallback: boolean) => {
    const text = raw(name, String(fallback));
    if (text !== 'true' && text !== 'false') {
      problems.push(`${name} must be "true" or "false", got "${text}"`);
      return fallback;
    }
    return text === 'true';
  };

  const url = (name: string, fallback: string) => {
    const text = raw(name, fallback);
    try {
      const { protocol } = new URL(text);
      if (protocol === 'postgres:' || protocol === 'postgresql:') return text;
    } catch {
      // fall through to the problem below
    }
    // Deliberately not echoing the value: it may contain a password.
    problems.push(`${name} must be a postgres:// or postgresql:// URL`);
    return fallback;
  };

  const config: Config = {
    databaseUrl: url('DATABASE_URL', 'postgres://app:app@localhost:5432/checkout'),
    testDatabaseUrl: url('TEST_DATABASE_URL', 'postgres://app:app@localhost:5432/checkout_test'),
    port: int('PORT', 3000, 1, 65535),
    couponEveryNOrders: int('COUPON_EVERY_N_ORDERS', 5, 1),
    couponPercent: int('COUPON_PERCENT', 10, 1, 100),
    autoGenerateCoupons: bool('AUTO_GENERATE_COUPONS', true),
    pgPoolMax: int('PG_POOL_MAX', 20, 1),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
