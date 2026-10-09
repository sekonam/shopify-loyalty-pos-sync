import {
  earnEntryFromOrder,
  effectiveEarnRate,
  floorProduct,
  type EarnPolicyResult,
  type LedgerEntryDraft,
  type LedgerStore,
  type ShopSettings,
} from '@loyalty/ledger';

import type { ReferralStore } from './referrals.js';

export const TIER_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The ONE place an order's earn is computed — webhook and reconciliation
 * paths both call this, so channel rules, exclusions, and tier multipliers
 * can never drift between them.
 */
export async function computeOrderEarn(params: {
  ledger: LedgerStore;
  settings: ShopSettings;
  shopDomain: string;
  customerId: string;
  orderId: string;
  orderSourceName: string | null | undefined;
  totalPrice: string;
}): Promise<{ policy: EarnPolicyResult; draft: LedgerEntryDraft | null }> {
  const earned365 = await params.ledger.earnedSince(
    params.shopDomain,
    params.customerId,
    new Date(Date.now() - TIER_WINDOW_MS),
  );
  const policy = effectiveEarnRate({
    baseEarnRate: params.settings.earnRate,
    orderSourceName: params.orderSourceName,
    channelRules: params.settings.channelRules,
    excludedSources: params.settings.excludedSources,
    tiers: params.settings.tiers,
    earned365,
  });
  if (policy.kind === 'skip') return { policy, draft: null };
  const draft = earnEntryFromOrder({
    shopDomain: params.shopDomain,
    customerId: params.customerId,
    orderId: params.orderId,
    orderSourceName: params.orderSourceName,
    totalPrice: params.totalPrice,
    earnRate: policy.rate,
  });
  return { policy, draft };
}

/**
 * The ONE place a refund's reversal is computed. Invariants:
 * - no earn entry for the order => nothing to reverse (an excluded/disabled
 *   order that earned nothing must never be charged for its refund);
 * - the reversal rate is the rate the order ACTUALLY earned at (persisted on
 *   the earn entry), not today's settings;
 * - total reversals per order never exceed what the order earned, across any
 *   number of partial refunds;
 * - appendCapped additionally caps at the customer's live balance;
 * - a fully-reversed referral-qualifying order claws back both referral
 *   rewards (otherwise order-then-refund cycles farm advocate points).
 */
export async function reverseOrderRefund(params: {
  ledger: LedgerStore;
  referrals: ReferralStore;
  settings: ShopSettings;
  shopDomain: string;
  orderId: string;
  refundId: string;
  refundedAmount: string;
}): Promise<string> {
  const { ledger, shopDomain, orderId } = params;
  if (!(Number(params.refundedAmount) > 0)) return 'no refunded amount, nothing to reverse';

  const earnEntry = await ledger.findByOrder(shopDomain, orderId, 'earn');
  const reconEntry = earnEntry ?? (await ledger.findByOrder(shopDomain, orderId, 'reconciliation'));
  if (!reconEntry) return 'no earn entry for refunded order (nothing to reverse)';

  const rate = reconEntry.earnRate ?? params.settings.earnRate;
  const { earned, reversed } = await ledger.orderDeltas(shopDomain, orderId);
  const byAmount = floorProduct(params.refundedAmount, rate);
  const reversible = Math.min(byAmount, Math.max(earned - reversed, 0));
  if (reversible <= 0) return 'nothing reversible for this order';

  const result = await ledger.appendCapped({
    shopDomain,
    customerId: reconEntry.customerId,
    orderId,
    refundId: params.refundId,
    sourceName: reconEntry.sourceName,
    ...(reconEntry.rawSourceName !== undefined ? { rawSourceName: reconEntry.rawSourceName } : {}),
    delta: -reversible,
    reason: 'refund_reversal',
    idempotencyKey: `refund:${params.refundId}`,
  });
  if (!result) return 'reversal capped to zero (no positive balance)';
  if (!result.inserted) return 'reversal already recorded';

  let action = `reversed ${-result.entry.delta}`;
  // Referral clawback once the order's earn is fully unwound — reversing the
  // amounts ACTUALLY granted (persisted on the referral record), capped at
  // each party's live balance.
  const after = await ledger.orderDeltas(shopDomain, orderId);
  if (after.earned - after.reversed <= 0) {
    const referral = await params.referrals.byOrder(shopDomain, orderId);
    if (referral) {
      const parts: string[] = [];
      const claw = async (customerId: string, points: number, key: string, label: string) => {
        if (points <= 0) return;
        const back = await ledger.appendCapped({
          shopDomain,
          customerId,
          orderId,
          sourceName: 'system',
          delta: -points,
          reason: 'adjustment',
          idempotencyKey: `${key}:${orderId}`,
        });
        if (back?.inserted) parts.push(`${label} ${back.entry.delta}`);
      };
      await claw(referral.advocateCustomerId, referral.advocatePoints, 'referral_advocate_reversal', 'advocate');
      await claw(referral.friendCustomerId, referral.friendPoints, 'referral_friend_reversal', 'friend');
      if (parts.length) action += `; referral clawed back (${parts.join(', ')})`;
    }
  }
  return action;
}

/**
 * An order's loyalty-bearing attributes, in one shape both callers can speak.
 * The webhook reads them from `note_attributes`; reconciliation reads the
 * same values from the Admin API's `customAttributes`.
 */
export type OrderAttributes = ReadonlyArray<{ name?: string | undefined; value?: string | undefined }>;

const attributeValue = (attrs: OrderAttributes, name: string): string | undefined =>
  attrs.find((a) => a.name === name)?.value;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Referral rewards, triggered by the friend's first earning order carrying a
 * loyalty_referral attribute. One reward per referred customer ever (the
 * store's primary key enforces it — designed against BON's class of
 * repeatable-referral bugs); self-referral and unknown codes are ignored
 * with a log line. Both ledger writes are idempotent per order, so a
 * redelivered webhook can't double-reward.
 */
export async function processReferral(params: {
  ledger: LedgerStore;
  referrals: ReferralStore;
  settings: ShopSettings;
  shopDomain: string;
  orderId: string;
  customerId: string;
  attributes: OrderAttributes;
  log?: ((msg: string, extra?: Record<string, unknown>) => void) | undefined;
}): Promise<string | undefined> {
  const { shopDomain, orderId, customerId, settings } = params;
  const deps = params;
  const referral = settings.referral;
  const code = attributeValue(params.attributes, 'loyalty_referral')?.trim();
  if (!code) return undefined;
  const log = params.log ?? (() => undefined);
  if (!referral?.enabled) return 'referral code ignored (program disabled)';
  // First-order test that survives redelivery: earns from THIS order don't
  // disqualify (the earn append above may already have landed on a previous,
  // partially-failed delivery of this same webhook).
  if (await deps.ledger.hasEarnFromOtherOrder(shopDomain, customerId, orderId)) {
    return 'referral code ignored (not first order)';
  }
  const advocate = await deps.referrals.advocateFor(shopDomain, code);
  if (!advocate) {
    log('unknown referral code', { shopDomain, orderId, code });
    return 'referral code unknown';
  }
  if (advocate === customerId) {
    log('self-referral ignored', { shopDomain, orderId });
    return 'self-referral ignored';
  }
  const { created, record } = await deps.referrals.recordOrGet(shopDomain, {
    advocateCustomerId: advocate,
    friendCustomerId: customerId,
    code,
    orderId,
    advocatePoints: referral.advocatePoints,
    friendPoints: referral.friendPoints,
  });
  // A standing record for a DIFFERENT order means the one-reward-per-friend
  // slot is spent. The same order means this is a redelivery whose reward
  // appends may not have completed — fall through and (re)append them; the
  // per-order idempotency keys make that safe.
  if (!created && record.orderId !== orderId) {
    return 'referral already rewarded for this customer';
  }
  const parts: string[] = [];
  if (record.advocatePoints > 0) {
    await deps.ledger.append({
      shopDomain,
      customerId: record.advocateCustomerId,
      orderId,
      sourceName: 'system',
      delta: record.advocatePoints,
      reason: 'referral_reward',
      idempotencyKey: `referral_advocate:${orderId}`,
    });
    parts.push(`advocate +${record.advocatePoints}`);
  }
  if (record.friendPoints > 0) {
    await deps.ledger.append({
      shopDomain,
      customerId,
      orderId,
      sourceName: 'system',
      delta: record.friendPoints,
      reason: 'referral_reward',
      idempotencyKey: `referral_friend:${orderId}`,
    });
    parts.push(`friend +${record.friendPoints}`);
  }
  return `referral rewarded (${parts.join(', ')})`;
}

/**
 * The authoritative guard behind the checkout discount Function. The cart
 * attributes are buyer-writable; the discount they produced is real money, so
 * a discount larger than what the named redemption attempt actually paid for
 * is clawed back from the customer's points (capped at their balance) as a
 * 'system' adjustment — auditable in the ledger, idempotent per order.
 */
export async function enforceLoyaltyAttempt(params: {
  ledger: LedgerStore;
  shopDomain: string;
  orderId: string;
  customerId: string;
  attributes: OrderAttributes;
  redemptionRate: string;
  log?: ((msg: string, extra?: Record<string, unknown>) => void) | undefined;
}): Promise<string | undefined> {
  const { shopDomain, orderId, customerId, redemptionRate } = params;
  const deps = params;
  const log = params.log ?? (() => undefined);
  const attemptId = attributeValue(params.attributes, 'loyalty_attempt');
  const discountAttr = attributeValue(params.attributes, 'loyalty_discount');
  if (!attemptId && !discountAttr) return undefined;

  const attempt =
    attemptId && UUID_RE.test(attemptId)
      ? await deps.ledger.getAttempt(shopDomain, attemptId)
      : undefined;
  const paidForPoints = attempt?.status === 'applied' ? attempt.requestedPoints : 0;
  const claimedPoints =
    discountAttr && /^\d+(\.\d{1,2})?$/.test(discountAttr)
      ? floorProduct(discountAttr, redemptionRate)
      : 0;
  const excess = claimedPoints - paidForPoints;
  if (excess <= 0 && attempt?.status === 'applied') return undefined;
  if (excess <= 0) {
    // An attempt id with no applied attempt but also no discount claimed:
    // suspicious but costless. Log only.
    log('loyalty attempt attribute without applied redemption', {
      shopDomain,
      orderId,
      attemptId,
    });
    return 'ATTEMPT MISMATCH logged';
  }

  log('loyalty discount exceeds applied redemption — clawing back', {
    shopDomain,
    orderId,
    attemptId,
    claimedPoints,
    paidForPoints,
  });
  const result = await deps.ledger.appendCapped({
    shopDomain,
    customerId,
    orderId,
    sourceName: 'system',
    delta: -excess,
    reason: 'adjustment',
    idempotencyKey: `attempt_mismatch:${orderId}`,
  });
  return result
    ? `ATTEMPT MISMATCH: clawed back ${-result.entry.delta}`
    : 'ATTEMPT MISMATCH: nothing clawable';
}
