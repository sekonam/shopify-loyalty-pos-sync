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
import { GraphqlAdminOrdersClient, GraphqlCustomerDirectory } from './admin-client.js';
import { PgReconRunStore, startReconciliationLoop } from './scheduler.js';

const config = configFromEnv();
const db = createPool(config.databaseUrl);
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

await migrate(db, migrationsDir);

const log = (msg: string, extra?: Record<string, unknown>) => console.log(msg, extra ?? '');
const ledger = new PgLedgerStore(db);
const settings = new PgSettingsStore(db);
const referrals = new PgReferralStore(db);
const runs = new PgReconRunStore(db);

// Imported here rather than at the usual place because the Admin stub below
// has to exist before the orders client that may use it.
const devHarness =
  process.env['DEV_HARNESS'] === '1' ? await import('./dev-harness.js') : undefined;

/**
 * The ONLY seam by which the reconciliation job talks to anything other than
 * Shopify, and it takes BOTH flags to open: there is no Partner account yet,
 * so a local run is the only way to prove the job actually heals a dropped
 * webhook end to end (see dev-harness.ts for why that needs a real HTTP
 * client rather than a unit-test double). With either flag absent this is
 * undefined and the client below is constructed exactly as in production.
 */
const adminStub =
  devHarness && process.env['DEV_ADMIN_STUB'] === '1' ? devHarness.createDevAdminStub() : undefined;

const app = createApp({
  ledger,
  settings,
  receipts: new PgReceiptStore(db),
  compliance: new PgComplianceStore(db),
  referrals,
  awardBatches: new PgAwardBatchStore(db),
  reconStatus: runs,
  // Shares the reconciliation job's token store; absent-token shops simply
  // get an admin that shows customer ids, which is what it did before.
  customers: new GraphqlCustomerDirectory(runs),
  apiSecret: config.apiSecret,
  apiKey: config.apiKey,
  log,
});

// Defense-in-depth against dropped webhooks: hourly diff of Shopify's own
// order history against the ledger, for every shop with a stored Admin token.
const scheduler = {
  runs,
  client: adminStub
    ? new GraphqlAdminOrdersClient(runs, adminStub.fetchImpl)
    : new GraphqlAdminOrdersClient(runs),
  ledger,
  settings,
  referrals,
  log,
};
startReconciliationLoop(scheduler);

if (devHarness) {
  app.route(
    '/dev',
    devHarness.createDevApp({
      apiSecret: config.apiSecret,
      apiKey: config.apiKey,
      defaultShop: process.env['DEV_SHOP'] ?? 'loyalty-e2e.myshopify.com',
      tokens: runs,
      scheduler,
      ...(adminStub ? { adminStub } : {}),
    }),
  );
  console.warn('DEV_HARNESS enabled — /dev mints session tokens. NEVER run this in production.');
  if (adminStub) {
    console.warn(
      'DEV_ADMIN_STUB enabled — reconciliation reads a LOCAL stub, not Shopify. NEVER in production.',
    );
  }
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`loyalty backend listening on :${info.port}`);
});
