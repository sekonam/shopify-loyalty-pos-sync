import { floorProduct, mulDecimals, parseDecimal } from './money.js';
import { orderPaidKey, refundKey } from './idempotency.js';
import type { ChannelRule, LedgerEntryDraft, RuleChannel, SourceName, VipTier } from './types.js';

/**
 * Maps Shopify's Order.sourceName / order.source_name to the ledger's channel tag.
 * Shopify emits 'web', 'pos', and app-ish values ('iphone', 'android') among others;
 * anything unrecognized is tagged 'other' with the raw value preserved — never guessed
 * into a known channel.
 */
export function normalizeSourceName(raw: string | null | undefined): {
  sourceName: SourceName;
  rawSourceName?: string;
} {
  switch ((raw ?? '').toLowerCase()) {
    case 'web':
      return { sourceName: 'web' };
    case 'pos':
      return { sourceName: 'pos' };
    case 'iphone':
    case 'android':
    case 'mobile_app':
      return { sourceName: 'mobile_app' };
    default:
      return { sourceName: 'other', rawSourceName: raw ?? '' };
  }
}

/** The tier a customer qualifies for: highest minEarned365 at or below earned365. */
export function selectTier(tiers: VipTier[] | undefined, earned365: number): VipTier | undefined {
  let best: VipTier | undefined;
  for (const tier of tiers ?? []) {
    if (earned365 >= tier.minEarned365 && (!best || tier.minEarned365 > best.minEarned365)) {
      best = tier;
    }
  }
  return best;
}

export interface EarnPolicyInput {
  baseEarnRate: string;
  /** The order's raw source_name, before normalization. */
  orderSourceName: string | null | undefined;
  channelRules?: Partial<Record<RuleChannel, ChannelRule>> | undefined;
  excludedSources?: string[] | undefined;
  tiers?: VipTier[] | undefined;
  /** Points earned (purchase earns only) in the trailing 365 days. */
  earned365: number;
}

export type EarnPolicyResult =
  | { kind: 'earn'; rate: string; tier?: VipTier }
  | { kind: 'skip'; why: string };

/**
 * Resolves the effective earn rate for one order, in order of precedence:
 * excluded source (v1.x channel-filter ask) → channel rule disabled →
 * channel rate override → VIP-tier multiplier. Pure; both the webhook path
 * and the reconciliation job go through this one function.
 */
export function effectiveEarnRate(input: EarnPolicyInput): EarnPolicyResult {
  const raw = (input.orderSourceName ?? '').toLowerCase();
  if ((input.excludedSources ?? []).some((s) => s.toLowerCase() === raw && raw !== '')) {
    return { kind: 'skip', why: `source '${input.orderSourceName}' is excluded from earning` };
  }
  const { sourceName } = normalizeSourceName(input.orderSourceName);
  const channel: RuleChannel = sourceName === 'system' ? 'other' : sourceName;
  const rule = input.channelRules?.[channel];
  if (rule?.enabled === false) {
    return { kind: 'skip', why: `earning disabled for channel '${channel}'` };
  }
  let rate = rule?.earnRate ?? input.baseEarnRate;
  const tier = selectTier(input.tiers, input.earned365);
  if (tier) rate = mulDecimals(rate, tier.multiplier);
  return tier ? { kind: 'earn', rate, tier } : { kind: 'earn', rate };
}

export interface EarnInput {
  shopDomain: string;
  customerId: string;
  orderId: string;
  orderSourceName: string | null | undefined;
  /** The paid order total, as Shopify's decimal string. */
  totalPrice: string;
  earnRate: string;
}

/**
 * earn delta = floor(totalPrice * earnRate). Returns null when the computed delta
 * is zero (an order too small to earn a point produces no ledger row at all).
 */
export function earnEntryFromOrder(input: EarnInput): LedgerEntryDraft | null {
  const delta = floorProduct(input.totalPrice, input.earnRate);
  if (delta <= 0) return null;
  const { sourceName, rawSourceName } = normalizeSourceName(input.orderSourceName);
  return {
    shopDomain: input.shopDomain,
    customerId: input.customerId,
    orderId: input.orderId,
    sourceName,
    ...(rawSourceName !== undefined ? { rawSourceName } : {}),
    delta,
    reason: 'earn',
    idempotencyKey: orderPaidKey(input.orderId),
  };
}

export interface RefundReversalInput {
  shopDomain: string;
  customerId: string;
  orderId: string;
  refundId: string;
  orderSourceName: string | null | undefined;
  /** Amount refunded, as a decimal string. */
  refundedAmount: string;
  earnRate: string;
}

/**
 * reversal delta = -floor(refundedAmount * earnRate), uncapped. Write it with
 * LedgerStore.appendCapped, which re-reads the balance inside the atomic write
 * and caps the magnitude so a reversal alone can never push a balance below
 * zero (TECHNICAL-SPEC §2). Returns null when the refund rounds to zero points.
 */
export function refundReversalEntry(input: RefundReversalInput): LedgerEntryDraft | null {
  const reversible = floorProduct(input.refundedAmount, input.earnRate);
  if (reversible <= 0) return null;
  const { sourceName, rawSourceName } = normalizeSourceName(input.orderSourceName);
  return {
    shopDomain: input.shopDomain,
    customerId: input.customerId,
    orderId: input.orderId,
    refundId: input.refundId,
    sourceName,
    ...(rawSourceName !== undefined ? { rawSourceName } : {}),
    delta: -reversible,
    reason: 'refund_reversal',
    idempotencyKey: refundKey(input.refundId),
  };
}

export interface RedemptionCheckInput {
  balance: number;
  requestedPoints: number;
  minRedemption: number;
}

export type RedemptionCheck =
  | { ok: true }
  | { ok: false; status: 'rejected_below_minimum' | 'rejected_insufficient_balance' };

/** Pure validation shared by every redemption write path (web and POS alike). */
export function checkRedemption(input: RedemptionCheckInput): RedemptionCheck {
  if (
    !Number.isInteger(input.requestedPoints) ||
    input.requestedPoints <= 0 ||
    input.requestedPoints < input.minRedemption
  ) {
    return { ok: false, status: 'rejected_below_minimum' };
  }
  if (input.requestedPoints > input.balance) {
    return { ok: false, status: 'rejected_insufficient_balance' };
  }
  return { ok: true };
}

/**
 * Discount value of a redemption: points / redemptionRate, floored to cents,
 * computed exactly (no float division). Returned as a decimal string suitable
 * for a Shopify fixed-amount discount.
 */
export function redemptionDiscountAmount(points: number, redemptionRate: string): string {
  if (!Number.isInteger(points) || points < 0) {
    throw new Error(`Invalid points amount: ${points}`);
  }
  const rate = parseDecimal(redemptionRate);
  if (rate.value <= 0n) throw new Error(`Invalid redemption rate: ${redemptionRate}`);
  // cents = floor(points * 100 / rate) = floor(points * 100 * 10^scale / rateValue)
  const cents = (BigInt(points) * 100n * 10n ** BigInt(rate.scale)) / rate.value;
  const whole = cents / 100n;
  const frac = cents % 100n;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}
