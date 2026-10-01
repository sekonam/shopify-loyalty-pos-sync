/**
 * Channel a ledger entry is attributed to. Taken from the Shopify Order's
 * `sourceName`/`source_name` (normalized via `normalizeSourceName`), never inferred.
 * 'system' marks entries this app generates itself (manual adjustments, reconciliation
 * corrections); 'other' preserves an unrecognized Shopify source verbatim in `rawSourceName`
 * rather than mislabeling it as one of the known channels.
 */
export type SourceName = 'web' | 'pos' | 'mobile_app' | 'system' | 'other';

export type LedgerReason =
  | 'earn'
  | 'redeem'
  | 'refund_reversal'
  | 'adjustment'
  | 'reconciliation';

export interface PointsLedgerEntry {
  id: string;
  shopDomain: string;
  customerId: string;
  orderId?: string;
  refundId?: string;
  sourceName: SourceName;
  /** Preserved verbatim when sourceName is 'other'. */
  rawSourceName?: string;
  /** Positive = earn, negative = redeem/reversal. Never zero. */
  delta: number;
  reason: LedgerReason;
  redemptionAttemptId?: string;
  idempotencyKey: string;
  createdAt: Date;
}

/** A new entry before the store assigns id/createdAt. */
export type LedgerEntryDraft = Omit<PointsLedgerEntry, 'id' | 'createdAt'>;

export type RedemptionStatus =
  | 'applied'
  | 'rejected_insufficient_balance'
  | 'rejected_below_minimum'
  | 'rejected_stale_offline_state'
  | 'pending';

export type RedemptionChannel = 'web' | 'pos';

export interface RedemptionAttempt {
  id: string;
  shopDomain: string;
  customerId: string;
  channel: RedemptionChannel;
  requestedPoints: number;
  status: RedemptionStatus;
  posDeviceId?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface ShopSettings {
  shopDomain: string;
  /** Points earned per 1 unit of shop currency spent. */
  earnRate: string;
  /** Points required per 1 unit of shop currency of discount. */
  redemptionRate: string;
  /** Minimum points per redemption. */
  minRedemption: number;
  installedAt: Date;
  uninstalledAt?: Date;
}

export const DEFAULT_SETTINGS: Pick<
  ShopSettings,
  'earnRate' | 'redemptionRate' | 'minRedemption'
> = {
  earnRate: '1',
  redemptionRate: '100',
  minRedemption: 100,
};
