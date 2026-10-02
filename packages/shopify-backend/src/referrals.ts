import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';

export interface ReferralRecord {
  advocateCustomerId: string;
  friendCustomerId: string;
  code: string;
  orderId: string;
}

export interface ReferralStore {
  /** Get-or-create the advocate's share code (stable per customer). */
  codeFor(shopDomain: string, customerId: string): Promise<string>;
  /** Who owns a code; undefined for unknown codes. */
  advocateFor(shopDomain: string, code: string): Promise<string | undefined>;
  /**
   * Records the referral if this friend has never been referred before.
   * Returns false when a referral for the friend already exists (the
   * one-reward-per-friend guard — BON's class of repeatable-referral bugs).
   */
  recordIfFirst(shopDomain: string, referral: ReferralRecord): Promise<boolean>;
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

  async recordIfFirst(shopDomain: string, referral: ReferralRecord): Promise<boolean> {
    const key = `${shopDomain}${referral.friendCustomerId}`;
    if (this.referred.has(key)) return false;
    this.referred.set(key, referral);
    return true;
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

  async recordIfFirst(shopDomain: string, referral: ReferralRecord): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `insert into referral (shop_domain, friend_customer_id, advocate_customer_id, code, order_id)
       values ($1, $2, $3, $4, $5)
       on conflict (shop_domain, friend_customer_id) do nothing`,
      [
        shopDomain,
        referral.friendCustomerId,
        referral.advocateCustomerId,
        referral.code,
        referral.orderId,
      ],
    );
    return (rowCount ?? 0) > 0;
  }
}
