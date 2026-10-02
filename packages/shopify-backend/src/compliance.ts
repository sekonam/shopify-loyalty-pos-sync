import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import type { ComplianceStore } from './webhooks.js';

/**
 * customers/redact: the ledger keeps aggregate rows (delta/reason/dates are
 * retained, per current Shopify redaction guidance for non-PII accounting
 * data) but the customer identity is replaced with a one-way pseudonym, so
 * rows can no longer be tied back to the person. Verified against the
 * privacy-law-compliance docs 2026-10-01; re-check before submission.
 */
export const redactedId = (customerId: string): string =>
  `redacted:${createHash('sha256').update(customerId).digest('hex').slice(0, 32)}`;

export class PgComplianceStore implements ComplianceStore {
  constructor(private readonly db: Db) {}

  async redactCustomer(shopDomain: string, customerId: string): Promise<void> {
    const pseudonym = redactedId(customerId);
    await this.db.query(
      'update points_ledger_entry set customer_id = $3 where shop_domain = $1 and customer_id = $2',
      [shopDomain, customerId, pseudonym],
    );
    await this.db.query(
      'update redemption_attempt set customer_id = $3 where shop_domain = $1 and customer_id = $2',
      [shopDomain, customerId, pseudonym],
    );
    // Referral tables hold the raw id in three columns; the aggregate rows
    // stay (one-reward-per-friend must survive redaction) but identity goes.
    await this.db.query(
      'update referral_code set customer_id = $3 where shop_domain = $1 and customer_id = $2',
      [shopDomain, customerId, pseudonym],
    );
    await this.db.query(
      'update referral set friend_customer_id = $3 where shop_domain = $1 and friend_customer_id = $2',
      [shopDomain, customerId, pseudonym],
    );
    await this.db.query(
      'update referral set advocate_customer_id = $3 where shop_domain = $1 and advocate_customer_id = $2',
      [shopDomain, customerId, pseudonym],
    );
  }
}

/** Test double mirroring PgComplianceStore against the in-memory ledger. */
export class InMemoryComplianceStore implements ComplianceStore {
  public redacted: Array<{ shopDomain: string; customerId: string }> = [];

  async redactCustomer(shopDomain: string, customerId: string): Promise<void> {
    this.redacted.push({ shopDomain, customerId });
  }
}
