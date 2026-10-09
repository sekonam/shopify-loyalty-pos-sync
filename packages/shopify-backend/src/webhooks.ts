import { sumAmounts, type LedgerStore } from '@loyalty/ledger';
import {
  computeOrderEarn,
  enforceLoyaltyAttempt,
  processReferral,
  reverseOrderRefund,
} from './earn-policy.js';
import { hashPayload, type ReceiptStore } from './receipts.js';
import type { ReferralStore } from './referrals.js';
import type { SettingsStore } from './settings.js';

export interface ComplianceStore {
  /** customers/redact: strip the customer's identity, keep aggregate ledger rows valid. */
  redactCustomer(shopDomain: string, customerId: string): Promise<void>;
}

export interface WebhookDeps {
  ledger: LedgerStore;
  settings: SettingsStore;
  receipts: ReceiptStore;
  compliance: ComplianceStore;
  referrals: ReferralStore;
  /** Optional; present once an Admin API token exists. See customers/redact. */
  customers?: { forget(shopDomain: string, customerId: string): void };
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface WebhookDelivery {
  topic: string;
  shopDomain: string;
  webhookId: string;
  rawBody: string;
}

export type WebhookOutcome =
  | { handled: true; action: string }
  | { handled: false; reason: string };

/** Numeric Shopify ids in webhook payloads → the GraphQL GID the ledger stores. */
const customerGid = (id: number | string): string => `gid://shopify/Customer/${id}`;
const orderGid = (id: number | string): string => `gid://shopify/Order/${id}`;
const refundGid = (id: number | string): string => `gid://shopify/Refund/${id}`;

/**
 * Dispatches a verified webhook delivery. HMAC verification happens in the
 * route layer on the raw bytes before this runs. A handler failure THROWS —
 * the route answers non-2xx, the receipt stays unprocessed, and Shopify's
 * redelivery re-runs the handler (idempotency keys make that safe). Only a
 * completed delivery is marked processed; a replay of one is a no-op.
 */
export async function processWebhook(
  delivery: WebhookDelivery,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const log = deps.log ?? (() => undefined);
  const state = await deps.receipts.record(
    delivery.shopDomain,
    delivery.webhookId,
    delivery.topic,
    hashPayload(delivery.rawBody),
  );
  if (state === 'processed') return { handled: true, action: 'duplicate' };

  let payload: unknown;
  try {
    payload = JSON.parse(delivery.rawBody);
  } catch {
    // Unparseable payloads can't improve on retry; ack and move on.
    await deps.receipts.markProcessed(delivery.shopDomain, delivery.webhookId);
    return { handled: false, reason: 'invalid JSON payload' };
  }

  let outcome: WebhookOutcome;
  switch (delivery.topic) {
    case 'orders/paid':
      outcome = await handleOrdersPaid(delivery.shopDomain, payload, deps, log);
      break;
    case 'refunds/create':
      outcome = await handleRefundsCreate(delivery.shopDomain, payload, deps);
      break;
    case 'app/uninstalled':
      await deps.settings.markUninstalled(delivery.shopDomain, new Date());
      outcome = { handled: true, action: 'marked uninstalled' };
      break;
    case 'customers/data_request':
      // The merchant fulfils the request with the admin ledger view/CSV export;
      // acknowledging with 200 is the webhook's contract (30 days to complete).
      log('customers/data_request received', { shopDomain: delivery.shopDomain });
      outcome = { handled: true, action: 'data request acknowledged' };
      break;
    case 'customers/redact': {
      const p = payload as { customer?: { id?: number | string } };
      if (p.customer?.id == null) {
        outcome = { handled: false, reason: 'customers/redact without customer id' };
        break;
      }
      const redacted = customerGid(p.customer.id);
      await deps.compliance.redactCustomer(delivery.shopDomain, redacted);
      // The ledger rows are anonymised above; this drops the only other place
      // the person's name could still be read from — the admin's name cache.
      deps.customers?.forget(delivery.shopDomain, redacted);
      outcome = { handled: true, action: 'customer redacted' };
      break;
    }
    case 'shop/redact':
      await deps.settings.purgeShop(delivery.shopDomain);
      outcome = { handled: true, action: 'shop purged' };
      break;
    default:
      // Retrying an unknown topic cannot help; 8 failures removes the subscription.
      outcome = { handled: false, reason: `unhandled topic ${delivery.topic}` };
  }
  await deps.receipts.markProcessed(delivery.shopDomain, delivery.webhookId);
  return outcome;
}

interface OrdersPaidPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  source_name?: string | null;
  test?: boolean;
  total_price?: string;
  currency?: string;
  customer?: { id?: number | string; admin_graphql_api_id?: string } | null;
  note_attributes?: Array<{ name?: string; value?: string }>;
}

async function handleOrdersPaid(
  shopDomain: string,
  payload: unknown,
  deps: WebhookDeps,
  log: NonNullable<WebhookDeps['log']>,
): Promise<WebhookOutcome> {
  const order = payload as OrdersPaidPayload;
  if (order.id == null || typeof order.total_price !== 'string') {
    return { handled: false, reason: 'orders/paid payload missing id or total_price' };
  }
  if (order.test) return { handled: true, action: 'skipped test order' };

  const settings = await deps.settings.get(shopDomain);
  // The shop's currency isn't known until the first order arrives; record it
  // so the balance API can tell checkout which currency redemptions price in.
  if (settings.currency === undefined && typeof order.currency === 'string') {
    await deps.settings.upsert(shopDomain, { currency: order.currency });
  }

  // API-created orders can have no customer — nothing to credit.
  const customerId =
    order.customer?.admin_graphql_api_id ??
    (order.customer?.id != null ? customerGid(order.customer.id) : undefined);
  if (!customerId) return { handled: true, action: 'skipped order without customer' };

  const oid = order.admin_graphql_api_id ?? orderGid(order.id);

  const { policy, draft } = await computeOrderEarn({
    ledger: deps.ledger,
    settings,
    shopDomain,
    customerId,
    orderId: oid,
    orderSourceName: order.source_name,
    totalPrice: order.total_price,
  });

  let earnAction: string;
  if (policy.kind === 'skip') {
    earnAction = `no earn: ${policy.why}`;
  } else {
    earnAction = draft
      ? (await deps.ledger.append(draft)).inserted
        ? `earned ${draft.delta}${policy.tier ? ` (${policy.tier.name})` : ''}`
        : 'earn already recorded'
      : 'order earned zero points';
  }

  const attributes = order.note_attributes ?? [];

  // Referrals only for orders that actually earn — an excluded source or
  // disabled channel must not pay rewards (nor consume the friend's one slot).
  if (policy.kind === 'earn') {
    const referralAction = await processReferral({
      ledger: deps.ledger,
      referrals: deps.referrals,
      settings,
      shopDomain,
      orderId: oid,
      customerId,
      attributes,
      log,
    });
    if (referralAction) earnAction = `${earnAction}; ${referralAction}`;
  }

  // After the earn, so the clawback has the order's own points to claw from.
  const clawback = await enforceLoyaltyAttempt({
    ledger: deps.ledger,
    shopDomain,
    orderId: oid,
    customerId,
    attributes,
    redemptionRate: settings.redemptionRate,
    log,
  });
  return { handled: true, action: clawback ? `${earnAction}; ${clawback}` : earnAction };
}


interface RefundsCreatePayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  order_id?: number | string;
  transactions?: Array<{ kind?: string; status?: string; amount?: string }>;
}

async function handleRefundsCreate(
  shopDomain: string,
  payload: unknown,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const refund = payload as RefundsCreatePayload;
  if (refund.id == null || refund.order_id == null) {
    return { handled: false, reason: 'refunds/create payload missing id or order_id' };
  }
  // Actual money returned = successful refund transactions. A restock-only
  // exchange moves no money and reverses no points (we earn on the paid total,
  // so the reversal mirrors the money, not the merchandise). The shared
  // reversal in earn-policy enforces the invariants: order-capped, priced at
  // the rate the order ACTUALLY earned at, referral clawback on full unwind.
  const refundedAmount = sumAmounts(
    (refund.transactions ?? [])
      .filter((t) => t.kind === 'refund' && t.status === 'success' && typeof t.amount === 'string')
      .map((t) => t.amount as string),
  );
  const settings = await deps.settings.get(shopDomain);
  const action = await reverseOrderRefund({
    ledger: deps.ledger,
    referrals: deps.referrals,
    settings,
    shopDomain,
    orderId: orderGid(refund.order_id),
    refundId: refund.admin_graphql_api_id ?? refundGid(refund.id),
    refundedAmount,
  });
  return { handled: true, action };
}
