import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createPool } from './db/pool.js';

// Node's own loader, no dotenv. Variables already in the environment win.
try {
  process.loadEnvFile('.env');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const pool = createPool(config);
const app = await buildApp({ config, pool, logger: true });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    app.log.warn({ signal }, 'second signal, forcing exit');
    process.exit(1);
  }
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');

  const forceExit = setTimeout(() => {
    app.log.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await app.close(); // stops accepting, drains in-flight requests
    await pool.end();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await pool.end();
  process.exit(1);
}
