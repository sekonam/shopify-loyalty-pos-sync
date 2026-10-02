import { checkRedemption } from './rules.js';
import { redemptionKey } from './idempotency.js';
import type {
  LedgerEntryDraft,
  LedgerReason,
  PointsLedgerEntry,
  RedemptionAttempt,
  RedemptionChannel,
  RedemptionStatus,
} from './types.js';

export interface AppendResult {
  entry: PointsLedgerEntry;
  /** false when the idempotency key already existed and the stored entry is returned. */
  inserted: boolean;
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
  /** All entries for a shop, oldest first (admin ledger view / CSV export). */
  entriesForShop(shopDomain: string, limit?: number): Promise<PointsLedgerEntry[]>;
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

  async entriesForShop(shopDomain: string, limit = 10_000): Promise<PointsLedgerEntry[]> {
    return (this.entriesByShop.get(shopDomain) ?? []).slice(0, limit);
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
