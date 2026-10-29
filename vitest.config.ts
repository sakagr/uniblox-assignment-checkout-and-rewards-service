import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files share one Postgres database (TEST_DATABASE_URL), reset per
    // file, so files must run one at a time. Concurrency within a single
    // test (e.g. Promise.all over app.inject()) is unaffected by this.
    fileParallelism: false,
  },
});
