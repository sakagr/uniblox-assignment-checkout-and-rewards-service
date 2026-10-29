import { loadConfig, type Config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';

/** Defaults plus TEST_DATABASE_URL; the developer's shell env never leaks in otherwise. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    ...(process.env.TEST_DATABASE_URL ? { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
  });
  return { ...base, databaseUrl: base.testDatabaseUrl, ...overrides };
}

/** Drops and re-applies the schema on the test database. Call in `beforeAll`. */
export async function setupTestDb(): Promise<void> {
  await migrate(testConfig().testDatabaseUrl, { reset: true });
}

/** Runs `fn(0..n-1)` concurrently. */
export function parallel<T>(n: number, fn: (index: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
}
