import { orderPaidKey, refundKey, type LedgerStore } from '@loyalty/ledger';
import {
  computeOrderEarn,
  enforceLoyaltyAttempt,
  processReferral,
  reverseOrderRefund,
  type OrderAttributes,
} from './earn-policy.js';
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
  /**
   * Order.customAttributes — the same values the webhook reads from
   * note_attributes. Without these the sweep cannot run the clawback or pay
   * a referral, so a dropped webhook silently lost both.
   */
  attributes?: OrderAttributes;
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
    log?: ((msg: string, extra?: Record<string, unknown>) => void) | undefined;
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
      // Whether this order has already earned — before this sweep touches it.
      // Used twice below: to decide if the earn needs healing at all, and to
      // decide whether a referral is payable (only earning orders pay).
      let earned = await deps.ledger.hasEntry(shopDomain, orderPaidKey(order.id));
      if (paid && !earned) {
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
        earned = policy.kind === 'earn' && draft !== null;
      }

      /**
       * A dropped webhook must not cost the shop the REST of the handler.
       * Healing only the earn left two gaps that both move real money: the
       * forged-discount clawback (the authoritative guard behind the checkout
       * Function) never ran, and a referral advocate was never paid — and
       * since the sweep only looked at earns, nothing would have paid them
       * later either.
       *
       * Deliberately OUTSIDE the missing-earn branch. Gating these on "the
       * earn was missing" would mean the sweep could never repair its own
       * partial work: an order whose earn landed and whose clawback did not
       * (a crash between the two appends, or an order healed by a deployment
       * predating this) would never be looked at again. The webhook path has
       * no such gate — a Shopify redelivery re-runs every step — and both of
       * these are idempotent per order, so they do not need the earn to be
       * missing in order to be safe to run. Each also returns before touching
       * the database when the order carries no loyalty attributes at all,
       * which is almost every order.
       */
      if (paid) {
        if (earned) {
          await processReferral({
            ledger: deps.ledger,
            referrals: deps.referrals,
            settings,
            shopDomain,
            orderId: order.id,
            customerId: order.customerId,
            attributes: order.attributes ?? [],
            ...(deps.log ? { log: deps.log } : {}),
          });
        }
        await enforceLoyaltyAttempt({
          ledger: deps.ledger,
          shopDomain,
          orderId: order.id,
          customerId: order.customerId,
          attributes: order.attributes ?? [],
          redemptionRate: settings.redemptionRate,
          ...(deps.log ? { log: deps.log } : {}),
        });
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
