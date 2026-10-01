import {
  earnEntryFromOrder,
  orderPaidKey,
  refundKey,
  refundReversalEntry,
  type LedgerStore,
} from '@loyalty/ledger';
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
  deps: { client: AdminOrdersClient; ledger: LedgerStore; settings: SettingsStore },
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

      if (!(await deps.ledger.hasEntry(shopDomain, orderPaidKey(order.id)))) {
        const draft = earnEntryFromOrder({
          shopDomain,
          customerId: order.customerId,
          orderId: order.id,
          orderSourceName: order.sourceName,
          totalPrice: order.totalPrice,
          earnRate: settings.earnRate,
        });
        if (draft) {
          const { inserted } = await deps.ledger.append({ ...draft, reason: 'reconciliation' });
          if (inserted) earnsAdded += 1;
        }
      }

      for (const refund of order.refunds) {
        if (await deps.ledger.hasEntry(shopDomain, refundKey(refund.id))) continue;
        const draft = refundReversalEntry({
          shopDomain,
          customerId: order.customerId,
          orderId: order.id,
          refundId: refund.id,
          orderSourceName: order.sourceName,
          refundedAmount: refund.totalRefunded,
          earnRate: settings.earnRate,
        });
        if (!draft) continue;
        const result = await deps.ledger.appendCapped({ ...draft, reason: 'reconciliation' });
        if (result?.inserted) reversalsAdded += 1;
      }
    }
    cursor = page.nextCursor;
  } while (cursor);

  return { ordersSeen, earnsAdded, reversalsAdded, checkpoint };
}

/** Overlap subtracted from each run's checkpoint so boundary updates are never missed. */
export const RECONCILIATION_OVERLAP_MS = 5 * 60 * 1000;
