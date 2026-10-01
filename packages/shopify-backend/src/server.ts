import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { configFromEnv } from './config.js';
import { createPool, migrate } from './db.js';
import { PgLedgerStore } from './pg-store.js';
import { PgReceiptStore } from './receipts.js';
import { PgSettingsStore } from './settings.js';
import { PgComplianceStore } from './compliance.js';
import { createApp } from './routes.js';

const config = configFromEnv();
const db = createPool(config.databaseUrl);
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

await migrate(db, migrationsDir);

const app = createApp({
  ledger: new PgLedgerStore(db),
  settings: new PgSettingsStore(db),
  receipts: new PgReceiptStore(db),
  compliance: new PgComplianceStore(db),
  apiSecret: config.apiSecret,
  apiKey: config.apiKey,
  log: (msg, extra) => console.log(msg, extra ?? ''),
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`loyalty backend listening on :${info.port}`);
});
