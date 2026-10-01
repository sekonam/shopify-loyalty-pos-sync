import {
  earnEntryFromOrder,
  floorProduct,
  refundReversalEntry,
  sumAmounts,
  type LedgerStore,
  type PointsLedgerEntry,
} from '@loyalty/ledger';
import { hashPayload, type ReceiptStore } from './receipts.js';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      await deps.compliance.redactCustomer(delivery.shopDomain, customerGid(p.customer.id));
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
  const draft = earnEntryFromOrder({
    shopDomain,
    customerId,
    orderId: oid,
    orderSourceName: order.source_name,
    totalPrice: order.total_price,
    earnRate: settings.earnRate,
  });
  const earnAction = draft
    ? (await deps.ledger.append(draft)).inserted
      ? `earned ${draft.delta}`
      : 'earn already recorded'
    : 'order earned zero points';

  // After the earn, so the clawback has the order's own points to claw from.
  const clawback = await enforceLoyaltyAttempt(
    shopDomain,
    oid,
    customerId,
    order,
    deps,
    log,
    settings.redemptionRate,
  );
  return { handled: true, action: clawback ? `${earnAction}; ${clawback}` : earnAction };
}

/**
 * The authoritative guard behind the checkout discount Function. The cart
 * attributes are buyer-writable; the discount they produced is real money, so
 * a discount larger than what the named redemption attempt actually paid for
 * is clawed back from the customer's points (capped at their balance) as a
 * 'system' adjustment — auditable in the ledger, idempotent per order.
 */
async function enforceLoyaltyAttempt(
  shopDomain: string,
  orderId: string,
  customerId: string,
  order: OrdersPaidPayload,
  deps: WebhookDeps,
  log: NonNullable<WebhookDeps['log']>,
  redemptionRate: string,
): Promise<string | undefined> {
  const attrs = order.note_attributes ?? [];
  const attemptId = attrs.find((a) => a.name === 'loyalty_attempt')?.value;
  const discountAttr = attrs.find((a) => a.name === 'loyalty_discount')?.value;
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
  // so the reversal mirrors the money, not the merchandise).
  const refundedAmount = sumAmounts(
    (refund.transactions ?? [])
      .filter((t) => t.kind === 'refund' && t.status === 'success' && typeof t.amount === 'string')
      .map((t) => t.amount as string),
  );
  if (!(Number(refundedAmount) > 0)) {
    return { handled: true, action: 'no refunded amount, nothing to reverse' };
  }

  // The refund payload carries no customer and no source_name for the order:
  // both come from the order's own earn entry in the ledger. No earn entry =>
  // nothing to reverse yet; the reconciliation job self-heals that ordering
  // (refunds/create before orders/paid is possible — ordering isn't guaranteed).
  const orderId = orderGid(refund.order_id);
  const earnEntry = await findEarnEntry(deps.ledger, shopDomain, orderId);
  if (!earnEntry) {
    return {
      handled: true,
      action: 'no earn entry for refunded order yet (reconciliation will catch up)',
    };
  }

  const settings = await deps.settings.get(shopDomain);
  const draft = refundReversalEntry({
    shopDomain,
    customerId: earnEntry.customerId,
    orderId,
    refundId: refund.admin_graphql_api_id ?? refundGid(refund.id),
    orderSourceName: earnEntry.rawSourceName ?? earnEntry.sourceName,
    refundedAmount,
    earnRate: settings.earnRate,
  });
  if (!draft) return { handled: true, action: 'refund reversed zero points' };
  const result = await deps.ledger.appendCapped(draft);
  if (!result) return { handled: true, action: 'reversal capped to zero (no positive balance)' };
  return {
    handled: true,
    action: result.inserted ? `reversed ${-result.entry.delta}` : 'reversal already recorded',
  };
}

async function findEarnEntry(
  ledger: LedgerStore,
  shopDomain: string,
  orderId: string,
): Promise<PointsLedgerEntry | undefined> {
  return ledger.findByOrder(shopDomain, orderId, 'earn');
}
