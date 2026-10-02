import { orderPaidKey, refundKey, type LedgerStore } from '@loyalty/ledger';
import { computeOrderEarn, reverseOrderRefund } from './earn-policy.js';
import type { ReferralStore } from './referrals.js';
import type { SettingsStore } from './settings.js';

/**
 * The slice of the GraphQL Admin API the reconciliation job needs. The real
 * implementation pages `orders(query: "updated_at:>=...")`; tests drive the
 * job with a stub. Kept minimal on purpose — the job must not grow write
 * paths of its own.
 */
export interface AdminOrdersClient {
  ordersUpdatedSince(
    shopDomain: string,
    since: Date,
    cursor?: string,
  ): Promise<{
    orders: ReconOrder[];
    nextCursor?: string;
  }>;
}

export interface ReconOrder {
  /** gid://shopify/Order/... */
  id: string;
  sourceName: string | null;
  test: boolean;
  /** Order.displayFinancialStatus — gates earning (see PAID_STATUSES). */
  financialStatus: string | null;
  customerId?: string;
  /** totalPriceSet.shopMoney.amount */
  totalPrice: string;
  refunds: Array<{
    /** gid://shopify/Refund/... */
    id: string;
    /** totalRefundedSet.shopMoney.amount */
    totalRefunded: string;
  }>;
}

/**
 * Statuses whose orders have actually been paid in full at some point — the
 * states orders/paid itself would have fired for. PENDING/AUTHORIZED/
 * PARTIALLY_PAID orders must not earn (money hasn't arrived); refunded ones
 * earned once and their refunds are reversed below.
 */
export const PAID_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);

export interface ReconciliationResult {
  ordersSeen: number;
  earnsAdded: number;
  reversalsAdded: number;
  checkpoint: Date;
}

/**
 * Defense-in-depth against dropped/late/out-of-order webhooks (TECHNICAL-SPEC
 * §5): diff Shopify's own order history against the ledger and append whatever
 * is missing. Corrections use the SAME idempotency keys as the webhook path
 * (order_paid:/refund:), with reason 'reconciliation' — so a late webhook
 * after a correction (or a correction after a processed webhook) is a
 * structural no-op, not a double-apply. The overlap window re-reads a slice
 * of already-seen history; idempotency makes that free.
 */
export async function reconcileShop(
  shopDomain: string,
  since: Date,
  deps: {
    client: AdminOrdersClient;
    ledger: LedgerStore;
    settings: SettingsStore;
    referrals: ReferralStore;
  },
  now: () => Date = () => new Date(),
): Promise<ReconciliationResult> {
  const settings = await deps.settings.get(shopDomain);
  const checkpoint = now();
  let ordersSeen = 0;
  let earnsAdded = 0;
  let reversalsAdded = 0;
  let cursor: string | undefined;

  do {
    const page = await deps.client.ordersUpdatedSince(shopDomain, since, cursor);
    for (const order of page.orders) {
      ordersSeen += 1;
      if (order.test || !order.customerId) continue;

      const paid = PAID_STATUSES.has(order.financialStatus ?? '');
      if (paid && !(await deps.ledger.hasEntry(shopDomain, orderPaidKey(order.id)))) {
        // Shared earn policy with the webhook path. The tier window is
        // evaluated at correction time, not original order time — a
        // deliberate simplification; the divergence is at most one tier
        // step on orders healed long after the fact.
        const { policy, draft } = await computeOrderEarn({
          ledger: deps.ledger,
          settings,
          shopDomain,
          customerId: order.customerId,
          orderId: order.id,
          orderSourceName: order.sourceName,
          totalPrice: order.totalPrice,
        });
        if (policy.kind === 'earn' && draft) {
          const { inserted } = await deps.ledger.append({ ...draft, reason: 'reconciliation' });
          if (inserted) earnsAdded += 1;
        }
      }

      for (const refund of order.refunds) {
        if (await deps.ledger.hasEntry(shopDomain, refundKey(refund.id))) continue;
        // Shared reversal: guarded by the order's own earn entry, so an
        // excluded/disabled order that earned nothing is never charged.
        const action = await reverseOrderRefund({
          ledger: deps.ledger,
          referrals: deps.referrals,
          settings,
          shopDomain,
          orderId: order.id,
          refundId: refund.id,
          refundedAmount: refund.totalRefunded,
        });
        if (action.startsWith('reversed')) reversalsAdded += 1;
      }
    }
    cursor = page.nextCursor;
  } while (cursor);

  return { ordersSeen, earnsAdded, reversalsAdded, checkpoint };
}

/** Overlap subtracted from each run's checkpoint so boundary updates are never missed. */
export const RECONCILIATION_OVERLAP_MS = 5 * 60 * 1000;
