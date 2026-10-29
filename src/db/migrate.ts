import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';

/**
 * Global lock order (D9) does not apply here — this is a standalone session,
 * not a checkout transaction. The key just needs to be stable and unused by
 * anything else.
 */
const MIGRATION_LOCK_KEY = 0x6368_6b6f; // 'chko' in hex, arbitrary

const DEFAULT_MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

export interface MigrateOptions {
  /** Drop and recreate schema `public` before applying migrations. */
  reset?: boolean;
  /** Called with human-readable progress. Defaults to a no-op. */
  log?: (message: string) => void;
  /** Override the directory `.sql` files are read from. Mainly for tests. */
  migrationsDir?: URL | string;
}

/**
 * Applies pending `.sql` files from `migrationsDir` in filename order,
 * tracking progress in a `schema_migrations` table. Each file runs in its
 * own BEGIN / file / insert-row / COMMIT. Takes a session-scoped Postgres
 * advisory lock for the whole run, so concurrent invocations (e.g. two test
 * files migrating at once) serialize rather than race.
 *
 * Returns the filenames that were actually applied (empty if nothing was
 * pending).
 */
export async function migrate(
  databaseUrl: string,
  options: MigrateOptions = {},
): Promise<string[]> {
  const log = options.log ?? (() => {});
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;

  // A single Client, not a Pool: pg_advisory_lock is session-scoped, and a
  // pooled client could take the lock on one session and run migrations on
  // another.
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'migrate',
  });
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    try {
      if (options.reset) {
        log('resetting schema public');
        await client.query('DROP SCHEMA IF EXISTS public CASCADE');
        await client.query('CREATE SCHEMA public');
      }

      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          filename    text        PRIMARY KEY,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )
      `);

      const dirPath =
        typeof migrationsDir === 'string' ? migrationsDir : fileURLToPath(migrationsDir);
      const entries = await readdir(dirPath);
      const onDisk = entries.filter((name) => name.endsWith('.sql')).sort();

      const appliedResult = await client.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations',
      );
      const applied = new Set(appliedResult.rows.map((row) => row.filename));

      for (const filename of applied) {
        if (!onDisk.includes(filename)) {
          log(`warning: schema_migrations records "${filename}", which is missing on disk`);
        }
      }

      const pending = onDisk.filter((filename) => !applied.has(filename));

      if (pending.length === 0) {
        log('nothing pending');
        return [];
      }

      for (const filename of pending) {
        const filePath = new URL(filename, migrationsDir);
        const sql = await readFile(filePath, 'utf8');

        log(`applying ${filename}`);
        await client.query('BEGIN');
        try {
          // No values array: keeps client.query on the simple-query
          // protocol, which is what allows a multi-statement file in one
          // call.
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
          await client.query('COMMIT');
        } catch (cause) {
          await client.query('ROLLBACK');
          const sqlState = (cause as { code?: string }).code;
          throw new Error(
            `migration "${filename}" failed${sqlState ? ` (SQLSTATE ${sqlState})` : ''}`,
            { cause },
          );
        }
      }

      return pending;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

const DEFAULT_DATABASE_URL = 'postgres://app:app@localhost:5432/checkout';
const DEFAULT_TEST_DATABASE_URL = 'postgres://app:app@localhost:5432/checkout_test';

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const useTest = args.includes('--test');
  const reset = args.includes('--reset');

  const databaseUrl = useTest
    ? (process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL)
    : (process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);

  migrate(databaseUrl, { reset, log: console.log })
    .then((appliedFiles) => {
      if (appliedFiles.length > 0) {
        console.log(`applied: ${appliedFiles.join(', ')}`);
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
