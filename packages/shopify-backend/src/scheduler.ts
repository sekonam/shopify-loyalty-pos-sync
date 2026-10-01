import type { LedgerStore } from '@loyalty/ledger';
import type { TokenProvider } from './admin-client.js';
import { RECONCILIATION_OVERLAP_MS, reconcileShop, type AdminOrdersClient } from './reconciliation.js';
import type { SettingsStore } from './settings.js';
import type { Db } from './db.js';

export interface ReconRunStore {
  /** Start-of-window for the next run: last successful checkpoint, minus overlap. */
  nextSince(shopDomain: string): Promise<Date | undefined>;
  recordRun(run: {
    shopDomain: string;
    checkpoint: Date;
    ordersSeen: number;
    entriesAdded: number;
    error?: string;
  }): Promise<void>;
  /** Shops the scheduler should reconcile (installed, with a stored token). */
  shopsToReconcile(): Promise<string[]>;
}

export class PgReconRunStore implements ReconRunStore, TokenProvider {
  constructor(private readonly db: Db) {}

  async nextSince(shopDomain: string): Promise<Date | undefined> {
    const { rows } = await this.db.query(
      `select checkpoint from reconciliation_run
        where shop_domain = $1 and error is null
        order by started_at desc limit 1`,
      [shopDomain],
    );
    if (!rows[0]) return undefined;
    return new Date(new Date(rows[0].checkpoint as string).getTime() - RECONCILIATION_OVERLAP_MS);
  }

  async recordRun(run: {
    shopDomain: string;
    checkpoint: Date;
    ordersSeen: number;
    entriesAdded: number;
    error?: string;
  }): Promise<void> {
    await this.db.query(
      `insert into reconciliation_run
         (shop_domain, finished_at, checkpoint, orders_seen, entries_added, error)
       values ($1, now(), $2, $3, $4, $5)`,
      [run.shopDomain, run.checkpoint, run.ordersSeen, run.entriesAdded, run.error ?? null],
    );
  }

  async shopsToReconcile(): Promise<string[]> {
    const { rows } = await this.db.query(
      `select t.shop_domain from shop_token t
        left join shop_settings s on s.shop_domain = t.shop_domain
        where s.uninstalled_at is null or s.shop_domain is null`,
    );
    return rows.map((r) => r.shop_domain as string);
  }

  async accessTokenFor(shopDomain: string): Promise<string | undefined> {
    const { rows } = await this.db.query(
      'select access_token from shop_token where shop_domain = $1',
      [shopDomain],
    );
    return rows[0]?.access_token as string | undefined;
  }

  async storeToken(shopDomain: string, accessToken: string): Promise<void> {
    await this.db.query(
      `insert into shop_token (shop_domain, access_token) values ($1, $2)
       on conflict (shop_domain) do update set access_token = $2, updated_at = now()`,
      [shopDomain, accessToken],
    );
  }
}

export interface SchedulerDeps {
  runs: ReconRunStore;
  client: AdminOrdersClient;
  ledger: LedgerStore;
  settings: SettingsStore;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** First run for a shop with no prior checkpoint looks back this far. */
  initialLookbackMs?: number;
}

export async function reconcileAllShops(deps: SchedulerDeps): Promise<void> {
  const shops = await deps.runs.shopsToReconcile();
  for (const shopDomain of shops) {
    const since =
      (await deps.runs.nextSince(shopDomain)) ??
      new Date(Date.now() - (deps.initialLookbackMs ?? 24 * 60 * 60 * 1000));
    try {
      const result = await reconcileShop(shopDomain, since, deps);
      await deps.runs.recordRun({
        shopDomain,
        checkpoint: result.checkpoint,
        ordersSeen: result.ordersSeen,
        entriesAdded: result.earnsAdded + result.reversalsAdded,
      });
      if (result.earnsAdded + result.reversalsAdded > 0) {
        deps.log('reconciliation corrected the ledger', { shopDomain, ...result });
      }
    } catch (err) {
      // A failed run records the SAME since-window so the next run retries it.
      await deps.runs.recordRun({
        shopDomain,
        checkpoint: since,
        ordersSeen: 0,
        entriesAdded: 0,
        error: String(err),
      });
      deps.log('reconciliation failed', { shopDomain, error: String(err) });
    }
  }
}

export function startReconciliationLoop(
  deps: SchedulerDeps,
  intervalMs = 60 * 60 * 1000,
): () => void {
  const timer = setInterval(() => {
    void reconcileAllShops(deps).catch((err) =>
      deps.log('reconciliation sweep crashed', { error: String(err) }),
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
