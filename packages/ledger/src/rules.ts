import { floorProduct, parseDecimal } from './money.js';
import { orderPaidKey, refundKey } from './idempotency.js';
import type { LedgerEntryDraft, SourceName } from './types.js';

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
  /** The customer's balance at the moment of the write (the store re-reads it inside the transaction). */
  currentBalance: number;
}

/**
 * reversal delta = -min(floor(refundedAmount * earnRate), max(currentBalance, 0)):
 * a reversal claws back points earned on the refunded amount, but is capped so it
 * can never push the balance below zero on its own (TECHNICAL-SPEC §2). Returns
 * null when nothing is reversible.
 */
export function refundReversalEntry(input: RefundReversalInput): LedgerEntryDraft | null {
  const earned = floorProduct(input.refundedAmount, input.earnRate);
  const reversible = Math.min(earned, Math.max(input.currentBalance, 0));
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
