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
