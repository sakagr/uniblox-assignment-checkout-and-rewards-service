-- Runs once, on first container init (see docker-compose.yml). The entrypoint
-- executes files in /docker-entrypoint-initdb.d without --single-transaction,
-- so CREATE DATABASE (illegal inside a transaction block) is fine here.
CREATE DATABASE checkout_test OWNER app;
