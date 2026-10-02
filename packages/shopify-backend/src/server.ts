import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { configFromEnv } from './config.js';
import { createPool, migrate } from './db.js';
import { PgLedgerStore } from './pg-store.js';
import { PgReceiptStore } from './receipts.js';
import { PgSettingsStore } from './settings.js';
import { PgComplianceStore } from './compliance.js';
import { PgReferralStore } from './referrals.js';
import { PgAwardBatchStore } from './awards.js';
import { createApp } from './routes.js';
import { GraphqlAdminOrdersClient } from './admin-client.js';
import { PgReconRunStore, startReconciliationLoop } from './scheduler.js';

const config = configFromEnv();
const db = createPool(config.databaseUrl);
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

await migrate(db, migrationsDir);

const log = (msg: string, extra?: Record<string, unknown>) => console.log(msg, extra ?? '');
const ledger = new PgLedgerStore(db);
const settings = new PgSettingsStore(db);
const referrals = new PgReferralStore(db);

const app = createApp({
  ledger,
  settings,
  receipts: new PgReceiptStore(db),
  compliance: new PgComplianceStore(db),
  referrals,
  awardBatches: new PgAwardBatchStore(db),
  apiSecret: config.apiSecret,
  apiKey: config.apiKey,
  log,
});

// Defense-in-depth against dropped webhooks: hourly diff of Shopify's own
// order history against the ledger, for every shop with a stored Admin token.
const runs = new PgReconRunStore(db);
startReconciliationLoop({
  runs,
  client: new GraphqlAdminOrdersClient(runs),
  ledger,
  settings,
  referrals,
  log,
});

if (process.env['DEV_HARNESS'] === '1') {
  const { createDevApp } = await import('./dev-harness.js');
  app.route(
    '/dev',
    createDevApp({
      apiSecret: config.apiSecret,
      apiKey: config.apiKey,
      defaultShop: process.env['DEV_SHOP'] ?? 'loyalty-e2e.myshopify.com',
    }),
  );
  console.warn('DEV_HARNESS enabled — /dev mints session tokens. NEVER run this in production.');
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`loyalty backend listening on :${info.port}`);
});
