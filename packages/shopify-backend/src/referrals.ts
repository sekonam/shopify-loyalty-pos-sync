import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';

export interface ReferralRecord {
  advocateCustomerId: string;
  friendCustomerId: string;
  code: string;
  orderId: string;
  /** Amounts actually granted — the clawback source of truth. */
  advocatePoints: number;
  friendPoints: number;
}

export interface ReferralStore {
  /** Get-or-create the advocate's share code (stable per customer). */
  codeFor(shopDomain: string, customerId: string): Promise<string>;
  /** Who owns a code; undefined for unknown codes. */
  advocateFor(shopDomain: string, code: string): Promise<string | undefined>;
  /**
   * Records the referral unless this friend was referred before (the
   * one-reward-per-friend guard — BON's class of repeatable-referral bugs).
   * Always returns the authoritative record: `created` false means an
   * earlier one stood, and callers must check whether it names the SAME
   * order (a webhook redelivery, which must still re-append the idempotent
   * reward entries) or a different one (a real repeat attempt — refuse).
   */
  recordOrGet(
    shopDomain: string,
    referral: ReferralRecord,
  ): Promise<{ created: boolean; record: ReferralRecord }>;
  /** The referral whose qualifying order this is, if any (refund clawback). */
  byOrder(shopDomain: string, orderId: string): Promise<ReferralRecord | undefined>;
}

const newCode = (): string => randomBytes(5).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X');

export class InMemoryReferralStore implements ReferralStore {
  private codes = new Map<string, string>(); // shopcustomer -> code
  private byCode = new Map<string, string>(); // shopcode -> customer
  private referred = new Map<string, ReferralRecord>(); // shopfriend -> record

  async codeFor(shopDomain: string, customerId: string): Promise<string> {
    const key = `${shopDomain}${customerId}`;
    let code = this.codes.get(key);
    if (!code) {
      code = newCode();
      this.codes.set(key, code);
      this.byCode.set(`${shopDomain}${code}`, customerId);
    }
    return code;
  }

  async advocateFor(shopDomain: string, code: string): Promise<string | undefined> {
    return this.byCode.get(`${shopDomain}${code.toUpperCase()}`);
  }

  async recordOrGet(
    shopDomain: string,
    referral: ReferralRecord,
  ): Promise<{ created: boolean; record: ReferralRecord }> {
    const key = `${shopDomain}${referral.friendCustomerId}`;
    const existing = this.referred.get(key);
    if (existing) return { created: false, record: existing };
    this.referred.set(key, referral);
    return { created: true, record: referral };
  }

  async byOrder(shopDomain: string, orderId: string): Promise<ReferralRecord | undefined> {
    for (const [key, record] of this.referred) {
      if (key.startsWith(`${shopDomain}`) && record.orderId === orderId) return record;
    }
    return undefined;
  }
}

export class PgReferralStore implements ReferralStore {
  constructor(private readonly db: Db) {}

  async codeFor(shopDomain: string, customerId: string): Promise<string> {
    const existing = await this.db.query(
      'select code from referral_code where shop_domain = $1 and customer_id = $2',
      [shopDomain, customerId],
    );
    if (existing.rows[0]) return existing.rows[0].code as string;
    // Retry on the (unlikely) random-code collision with another customer.
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const { rows } = await this.db.query(
        `insert into referral_code (shop_domain, code, customer_id)
         values ($1, $2, $3)
         on conflict (shop_domain, code) do nothing
         returning code`,
        [shopDomain, code, customerId],
      );
      if (rows[0]) return rows[0].code as string;
      // Lost a race on (shop, customer)? Re-read.
      const reread = await this.db.query(
        'select code from referral_code where shop_domain = $1 and customer_id = $2',
        [shopDomain, customerId],
      );
      if (reread.rows[0]) return reread.rows[0].code as string;
    }
    throw new Error('could not allocate a referral code');
  }

  async advocateFor(shopDomain: string, code: string): Promise<string | undefined> {
    const { rows } = await this.db.query(
      'select customer_id from referral_code where shop_domain = $1 and code = $2',
      [shopDomain, code.toUpperCase()],
    );
    return rows[0]?.customer_id as string | undefined;
  }

  async recordOrGet(
    shopDomain: string,
    referral: ReferralRecord,
  ): Promise<{ created: boolean; record: ReferralRecord }> {
    const { rows } = await this.db.query(
      `insert into referral
         (shop_domain, friend_customer_id, advocate_customer_id, code, order_id, advocate_points, friend_points)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (shop_domain, friend_customer_id) do nothing
       returning *`,
      [
        shopDomain,
        referral.friendCustomerId,
        referral.advocateCustomerId,
        referral.code,
        referral.orderId,
        referral.advocatePoints,
        referral.friendPoints,
      ],
    );
    if (rows[0]) return { created: true, record: rowToReferral(rows[0]) };
    const existing = await this.db.query(
      'select * from referral where shop_domain = $1 and friend_customer_id = $2',
      [shopDomain, referral.friendCustomerId],
    );
    return { created: false, record: rowToReferral(existing.rows[0]) };
  }

  async byOrder(shopDomain: string, orderId: string): Promise<ReferralRecord | undefined> {
    const { rows } = await this.db.query(
      'select * from referral where shop_domain = $1 and order_id = $2 limit 1',
      [shopDomain, orderId],
    );
    return rows[0] ? rowToReferral(rows[0]) : undefined;
  }
}

function rowToReferral(row: Record<string, unknown>): ReferralRecord {
  return {
    advocateCustomerId: row['advocate_customer_id'] as string,
    friendCustomerId: row['friend_customer_id'] as string,
    code: row['code'] as string,
    orderId: row['order_id'] as string,
    advocatePoints: Number(row['advocate_points'] ?? 0),
    friendPoints: Number(row['friend_points'] ?? 0),
  };
}
