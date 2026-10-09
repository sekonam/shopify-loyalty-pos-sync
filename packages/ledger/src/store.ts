import { checkRedemption } from './rules.js';
import { redemptionKey } from './idempotency.js';
import type {
  LedgerEntryDraft,
  LedgerReason,
  PointsLedgerEntry,
  RedemptionAttempt,
  RedemptionChannel,
  RedemptionStatus,
  SourceName,
} from './types.js';

export interface AppendResult {
  entry: PointsLedgerEntry;
  /** false when the idempotency key already existed and the stored entry is returned. */
  inserted: boolean;
}

export interface LedgerStats {
  /** Customers holding a positive balance. */
  members: number;
  /** Sum of all balances — the program's outstanding money-equivalent liability. */
  outstandingPoints: number;
  entryCount: number;
  /** Points credited / debited inside the requested window. */
  issuedInWindow: number;
  redeemedInWindow: number;
}

/**
 * Narrows the shop's ledger for the admin table and the CSV export. Every
 * field is optional and they combine with AND; an empty filter is the whole
 * shop. The same filter object drives the page the merchant looks at and the
 * file they download, so the two can never disagree about what was asked.
 */
export interface EntryFilter {
  customerId?: string;
  reason?: LedgerReason;
  /** The channel tag (`sourceName`) to narrow to. */
  channel?: SourceName;
}

export interface RedeemRequest {
  shopDomain: string;
  customerId: string;
  channel: RedemptionChannel;
  requestedPoints: number;
  minRedemption: number;
  /** Client-generated attempt id — retrying the same attempt can never double-apply. */
  attemptId: string;
  posDeviceId?: string;
}

export type RedeemResult =
  | { status: 'applied'; attempt: RedemptionAttempt; entry: PointsLedgerEntry; balance: number }
  | {
      status: Exclude<RedemptionStatus, 'applied' | 'pending'>;
      attempt: RedemptionAttempt;
      balance: number;
    };

/**
 * The one write-path contract both surfaces (checkout and POS) go through.
 * Implementations MUST make `redeem` atomic: the balance read and the ledger
 * append happen under a per-(shop, customer) critical section so a concurrent
 * redemption cannot double-spend (TECHNICAL-SPEC §4).
 */
export interface LedgerStore {
  append(draft: LedgerEntryDraft): Promise<AppendResult>;
  /**
   * Appends a negative entry (reversal) with its magnitude capped at the
   * customer's current balance, re-read inside the same critical section as
   * the write — so "a reversal alone can never push a balance negative" is an
   * atomic invariant, not a read-then-write approximation. Returns null when
   * nothing is reversible (zero or negative balance). An already-used
   * idempotency key returns the stored entry with inserted: false.
   */
  appendCapped(draft: LedgerEntryDraft): Promise<AppendResult | null>;
  balance(shopDomain: string, customerId: string): Promise<number>;
  entries(shopDomain: string, customerId: string): Promise<PointsLedgerEntry[]>;
  redeem(request: RedeemRequest): Promise<RedeemResult>;
  getAttempt(shopDomain: string, attemptId: string): Promise<RedemptionAttempt | undefined>;
  /** True when a ledger entry with this idempotency key already exists. */
  hasEntry(shopDomain: string, idempotencyKey: string): Promise<boolean>;
  /** First entry for an order, optionally filtered by reason (e.g. the earn a refund reverses). */
  findByOrder(
    shopDomain: string,
    orderId: string,
    reason?: LedgerReason,
  ): Promise<PointsLedgerEntry | undefined>;
  /**
   * One page of the shop's ledger for the admin table: the most recent
   * `limit` entries MATCHING the filter, returned oldest-first, plus how many
   * entries match in total.
   *
   * `total` is counted in the database over every matching row, not derived
   * from the page. A dashboard that filters a recent window client-side and
   * then labels the result against the shop-wide entry count tells the
   * merchant "50 of 71,363 entries match" when the real answer is 54,090 —
   * which, for a product whose claim is a trustworthy ledger, is the worst
   * kind of wrong number.
   */
  entryPage(
    shopDomain: string,
    filter: EntryFilter,
    limit: number,
  ): Promise<{ entries: PointsLedgerEntry[]; total: number }>;
  /**
   * Every entry matching the filter, oldest-first, yielded in batches.
   *
   * The CSV export is the merchant's audit artifact and the way they answer a
   * `customers/data_request` — so it has to be complete. Batching keeps a
   * full-ledger export memory-bounded instead of materialising the whole
   * table to build one string.
   */
  streamEntries(
    shopDomain: string,
    filter: EntryFilter,
    batchSize?: number,
  ): AsyncIterable<PointsLedgerEntry[]>;
  /**
   * Purchase points earned since `since` (positive deltas with reason
   * 'earn'/'reconciliation') — the VIP-tier qualification basis. Spending
   * points never demotes; referral/adjustment credits don't count.
   */
  earnedSince(shopDomain: string, customerId: string, since: Date): Promise<number>;
  /** True when the customer has a purchase earn from any OTHER order (referral first-order test). */
  hasEarnFromOtherOrder(shopDomain: string, customerId: string, orderId: string): Promise<boolean>;
  /** Totals for one order: points earned and points already reversed against it. */
  orderDeltas(shopDomain: string, orderId: string): Promise<{ earned: number; reversed: number }>;
  /** Shop-wide program metrics for the merchant dashboard. */
  stats(shopDomain: string, windowStart: Date): Promise<LedgerStats>;
}

/**
 * Reference implementation used by unit tests and as the executable
 * specification for the SQL implementation in the backend package.
 */
export class InMemoryLedgerStore implements LedgerStore {
  private entriesByShop = new Map<string, PointsLedgerEntry[]>();
  private attemptsByShop = new Map<string, Map<string, RedemptionAttempt>>();
  private locks = new Map<string, Promise<unknown>>();
  private seq = 0;

  async append(draft: LedgerEntryDraft): Promise<AppendResult> {
    return this.withLock(this.lockKey(draft.shopDomain, draft.customerId), async () =>
      this.appendUnlocked(draft),
    );
  }

  async appendCapped(draft: LedgerEntryDraft): Promise<AppendResult | null> {
    if (!Number.isInteger(draft.delta) || draft.delta >= 0) {
      throw new Error(`appendCapped requires a negative integer delta, got ${draft.delta}`);
    }
    return this.withLock(this.lockKey(draft.shopDomain, draft.customerId), async () => {
      const shopEntries = this.entriesByShop.get(draft.shopDomain) ?? [];
      const existing = shopEntries.find((e) => e.idempotencyKey === draft.idempotencyKey);
      if (existing) return { entry: existing, inserted: false };
      const balance = this.balanceUnlocked(draft.shopDomain, draft.customerId);
      const capped = Math.min(-draft.delta, Math.max(balance, 0));
      if (capped <= 0) return null;
      return this.appendUnlocked({ ...draft, delta: -capped });
    });
  }

  async balance(shopDomain: string, customerId: string): Promise<number> {
    return this.balanceUnlocked(shopDomain, customerId);
  }

  async entries(shopDomain: string, customerId: string): Promise<PointsLedgerEntry[]> {
    return (this.entriesByShop.get(shopDomain) ?? []).filter(
      (e) => e.customerId === customerId,
    );
  }

  async redeem(request: RedeemRequest): Promise<RedeemResult> {
    if (!Number.isInteger(request.requestedPoints) || request.requestedPoints <= 0) {
      throw new Error(`requestedPoints must be a positive integer, got ${request.requestedPoints}`);
    }
    return this.withLock(this.lockKey(request.shopDomain, request.customerId), async () => {
      const attempts = this.shopAttempts(request.shopDomain);
      const existing = attempts.get(request.attemptId);
      if (existing) {
        // Retried call for an already-resolved attempt: return the stored outcome.
        return this.resultFor(existing, request);
      }
      const now = new Date();
      const balance = this.balanceUnlocked(request.shopDomain, request.customerId);
      const check = checkRedemption({
        balance,
        requestedPoints: request.requestedPoints,
        minRedemption: request.minRedemption,
      });
      const attempt: RedemptionAttempt = {
        id: request.attemptId,
        shopDomain: request.shopDomain,
        customerId: request.customerId,
        channel: request.channel,
        requestedPoints: request.requestedPoints,
        status: check.ok ? 'applied' : check.status,
        ...(request.posDeviceId !== undefined ? { posDeviceId: request.posDeviceId } : {}),
        createdAt: now,
        resolvedAt: now,
      };
      attempts.set(attempt.id, attempt);
      if (!check.ok) {
        return { status: attempt.status as Exclude<RedemptionStatus, 'applied' | 'pending'>, attempt, balance };
      }
      const { entry } = this.appendUnlocked({
        shopDomain: request.shopDomain,
        customerId: request.customerId,
        sourceName: request.channel === 'pos' ? 'pos' : 'web',
        delta: -request.requestedPoints,
        reason: 'redeem',
        redemptionAttemptId: attempt.id,
        idempotencyKey: redemptionKey(attempt.id),
      });
      return {
        status: 'applied',
        attempt,
        entry,
        balance: balance - request.requestedPoints,
      };
    });
  }

  async getAttempt(shopDomain: string, attemptId: string): Promise<RedemptionAttempt | undefined> {
    return this.shopAttempts(shopDomain).get(attemptId);
  }

  async hasEntry(shopDomain: string, idempotencyKey: string): Promise<boolean> {
    return (this.entriesByShop.get(shopDomain) ?? []).some(
      (e) => e.idempotencyKey === idempotencyKey,
    );
  }

  async findByOrder(
    shopDomain: string,
    orderId: string,
    reason?: PointsLedgerEntry['reason'],
  ): Promise<PointsLedgerEntry | undefined> {
    return (this.entriesByShop.get(shopDomain) ?? []).find(
      (e) => e.orderId === orderId && (reason === undefined || e.reason === reason),
    );
  }

  async entryPage(
    shopDomain: string,
    filter: EntryFilter,
    limit: number,
  ): Promise<{ entries: PointsLedgerEntry[]; total: number }> {
    const matching = this.matching(shopDomain, filter);
    return { entries: matching.slice(-limit), total: matching.length };
  }

  async *streamEntries(
    shopDomain: string,
    filter: EntryFilter,
    batchSize = 2_000,
  ): AsyncIterable<PointsLedgerEntry[]> {
    const matching = this.matching(shopDomain, filter);
    for (let i = 0; i < matching.length; i += batchSize) {
      yield matching.slice(i, i + batchSize);
    }
  }

  /** Oldest-first, which is the order both readers above promise. */
  private matching(shopDomain: string, filter: EntryFilter): PointsLedgerEntry[] {
    return (this.entriesByShop.get(shopDomain) ?? []).filter(
      (e) =>
        (filter.customerId === undefined || e.customerId === filter.customerId) &&
        (filter.reason === undefined || e.reason === filter.reason) &&
        (filter.channel === undefined || e.sourceName === filter.channel),
    );
  }

  async earnedSince(shopDomain: string, customerId: string, since: Date): Promise<number> {
    return (this.entriesByShop.get(shopDomain) ?? [])
      .filter(
        (e) =>
          e.customerId === customerId &&
          e.delta > 0 &&
          (e.reason === 'earn' || e.reason === 'reconciliation') &&
          e.createdAt >= since,
      )
      .reduce((sum, e) => sum + e.delta, 0);
  }

  async hasEarnFromOtherOrder(
    shopDomain: string,
    customerId: string,
    orderId: string,
  ): Promise<boolean> {
    return (this.entriesByShop.get(shopDomain) ?? []).some(
      (e) =>
        e.customerId === customerId &&
        e.delta > 0 &&
        (e.reason === 'earn' || e.reason === 'reconciliation') &&
        e.orderId !== undefined &&
        e.orderId !== orderId,
    );
  }

  async orderDeltas(
    shopDomain: string,
    orderId: string,
  ): Promise<{ earned: number; reversed: number }> {
    let earned = 0;
    let reversed = 0;
    for (const e of this.entriesByShop.get(shopDomain) ?? []) {
      if (e.orderId !== orderId) continue;
      if ((e.reason === 'earn' || e.reason === 'reconciliation') && e.delta > 0) earned += e.delta;
      if (e.reason === 'refund_reversal') reversed += -e.delta;
    }
    return { earned, reversed };
  }

  async stats(shopDomain: string, windowStart: Date): Promise<LedgerStats> {
    const entries = this.entriesByShop.get(shopDomain) ?? [];
    const balances = new Map<string, number>();
    let issuedInWindow = 0;
    let redeemedInWindow = 0;
    for (const e of entries) {
      balances.set(e.customerId, (balances.get(e.customerId) ?? 0) + e.delta);
      if (e.createdAt >= windowStart) {
        if (e.delta > 0) issuedInWindow += e.delta;
        else redeemedInWindow += -e.delta;
      }
    }
    let members = 0;
    let outstandingPoints = 0;
    for (const balance of balances.values()) {
      if (balance > 0) members += 1;
      outstandingPoints += balance;
    }
    return {
      members,
      outstandingPoints,
      entryCount: entries.length,
      issuedInWindow,
      redeemedInWindow,
    };
  }

  private appendUnlocked(draft: LedgerEntryDraft): AppendResult {
    if (!Number.isInteger(draft.delta) || draft.delta === 0) {
      throw new Error(`Ledger delta must be a nonzero integer, got ${draft.delta}`);
    }
    const shopEntries = this.entriesByShop.get(draft.shopDomain) ?? [];
    const existing = shopEntries.find((e) => e.idempotencyKey === draft.idempotencyKey);
    if (existing) return { entry: existing, inserted: false };
    const entry: PointsLedgerEntry = {
      ...draft,
      id: `mem_${++this.seq}`,
      createdAt: new Date(),
    };
    shopEntries.push(entry);
    this.entriesByShop.set(draft.shopDomain, shopEntries);
    return { entry, inserted: true };
  }

  private balanceUnlocked(shopDomain: string, customerId: string): number {
    return (this.entriesByShop.get(shopDomain) ?? [])
      .filter((e) => e.customerId === customerId)
      .reduce((sum, e) => sum + e.delta, 0);
  }

  private resultFor(attempt: RedemptionAttempt, request: RedeemRequest): RedeemResult {
    const balance = this.balanceUnlocked(request.shopDomain, request.customerId);
    if (attempt.status === 'applied') {
      const entry = (this.entriesByShop.get(request.shopDomain) ?? []).find(
        (e) => e.redemptionAttemptId === attempt.id,
      );
      if (!entry) throw new Error(`Applied attempt ${attempt.id} has no ledger entry`);
      return { status: 'applied', attempt, entry, balance };
    }
    return {
      status: attempt.status as Exclude<RedemptionStatus, 'applied' | 'pending'>,
      attempt,
      balance,
    };
  }

  private shopAttempts(shopDomain: string): Map<string, RedemptionAttempt> {
    let m = this.attemptsByShop.get(shopDomain);
    if (!m) {
      m = new Map();
      this.attemptsByShop.set(shopDomain, m);
    }
    return m;
  }

  private lockKey(shopDomain: string, customerId: string): string {
    return `${shopDomain} ${customerId}`;
  }

  /** Serializes work per key — the in-memory stand-in for a row lock. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }
}
