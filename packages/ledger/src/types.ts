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
  | 'reconciliation'
  | 'referral_reward';

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
  /**
   * The effective rate this earn was computed at (channel/tier applied).
   * Stored so refund reversals mirror what the order ACTUALLY earned, even
   * after settings change — never recomputed from current settings.
   */
  earnRate?: string;
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

/** The channels an earning rule can address (matches normalizeSourceName output). */
export type RuleChannel = 'web' | 'pos' | 'mobile_app' | 'other';

export interface ChannelRule {
  enabled: boolean;
  /** Overrides the shop earnRate for this channel when set. */
  earnRate?: string;
}

export interface VipTier {
  name: string;
  /** Points earned in the trailing 365 days to qualify. */
  minEarned365: number;
  /** Earn-rate multiplier while in this tier (decimal string, e.g. "1.5"). */
  multiplier: string;
}

export interface ReferralConfig {
  enabled: boolean;
  /** Points for the advocate when the referred friend's first paid order lands. */
  advocatePoints: number;
  /** Welcome-bonus points for the referred friend on that same order. */
  friendPoints: number;
}

export interface ShopSettings {
  shopDomain: string;
  /** Points earned per 1 unit of shop currency spent. */
  earnRate: string;
  /** Points required per 1 unit of shop currency of discount. */
  redemptionRate: string;
  /** Minimum points per redemption. */
  minRedemption: number;
  /** Shop currency (ISO code), learned from the first order webhook. */
  currency?: string;
  /** Per-channel earning rules; a missing channel means enabled at earnRate. */
  channelRules?: Partial<Record<RuleChannel, ChannelRule>>;
  /** Raw source_name values that never earn (e.g. a marketplace channel handle). */
  excludedSources?: string[];
  /** VIP tiers, any order; highest qualifying minEarned365 wins. Empty/absent = no tiers. */
  tiers?: VipTier[];
  referral?: ReferralConfig;
  installedAt: Date;
  uninstalledAt?: Date;
}

export const DEFAULT_SETTINGS: Pick<
  ShopSettings,
  'earnRate' | 'redemptionRate' | 'minRedemption'
> & { referral: ReferralConfig } = {
  earnRate: '1',
  redemptionRate: '100',
  minRedemption: 100,
  referral: { enabled: false, advocatePoints: 200, friendPoints: 100 },
};
