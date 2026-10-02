import type { Db } from './db.js';

export interface AwardResult {
  customerId: string;
  applied: number;
}

/**
 * Persisted award-batch results: a replayed batchId returns the ORIGINAL
 * outcome verbatim, which closes the idempotency gap for deductions that
 * capped to nothing (they write no ledger row for a retry to collide with).
 */
export interface AwardBatchStore {
  get(shopDomain: string, batchId: string): Promise<AwardResult[] | undefined>;
  put(shopDomain: string, batchId: string, results: AwardResult[]): Promise<void>;
}

export class InMemoryAwardBatchStore implements AwardBatchStore {
  private batches = new Map<string, AwardResult[]>();

  async get(shopDomain: string, batchId: string): Promise<AwardResult[] | undefined> {
    return this.batches.get(`${shopDomain}${batchId}`);
  }

  async put(shopDomain: string, batchId: string, results: AwardResult[]): Promise<void> {
    this.batches.set(`${shopDomain}${batchId}`, results);
  }
}

export class PgAwardBatchStore implements AwardBatchStore {
  constructor(private readonly db: Db) {}

  async get(shopDomain: string, batchId: string): Promise<AwardResult[] | undefined> {
    const { rows } = await this.db.query(
      'select results from award_batch where shop_domain = $1 and batch_id = $2',
      [shopDomain, batchId],
    );
    return rows[0]?.results as AwardResult[] | undefined;
  }

  async put(shopDomain: string, batchId: string, results: AwardResult[]): Promise<void> {
    await this.db.query(
      `insert into award_batch (shop_domain, batch_id, results)
       values ($1, $2, $3)
       on conflict (shop_domain, batch_id) do nothing`,
      [shopDomain, batchId, JSON.stringify(results)],
    );
  }
}
