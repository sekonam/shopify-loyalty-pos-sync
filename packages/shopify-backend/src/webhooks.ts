import {
  earnEntryFromOrder,
  refundReversalEntry,
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
  | { handled: true; action: 'duplicate' }
  | { handled: false; reason: string };

/** Numeric Shopify ids in webhook payloads → the GraphQL GID the ledger stores. */
const customerGid = (id: number | string): string => `gid://shopify/Customer/${id}`;
const orderGid = (id: number | string): string => `gid://shopify/Order/${id}`;
const refundGid = (id: number | string): string => `gid://shopify/Refund/${id}`;

/**
 * Dispatches a verified webhook delivery. HMAC verification happens in the
 * route layer on the raw bytes before this runs. Must stay fast — Shopify's
 * delivery timeout is 5s; nothing here does network I/O.
 */
export async function processWebhook(
  delivery: WebhookDelivery,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const log = deps.log ?? (() => undefined);
  const isNew = await deps.receipts.recordIfNew(
    delivery.shopDomain,
    delivery.webhookId,
    delivery.topic,
    hashPayload(delivery.rawBody),
  );
  if (!isNew) return { handled: true, action: 'duplicate' };

  let payload: unknown;
  try {
    payload = JSON.parse(delivery.rawBody);
  } catch {
    return { handled: false, reason: 'invalid JSON payload' };
  }

  let outcome: WebhookOutcome;
  switch (delivery.topic) {
    case 'orders/paid':
      outcome = await handleOrdersPaid(delivery.shopDomain, payload, deps);
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
  customer?: { id?: number | string; admin_graphql_api_id?: string } | null;
  note_attributes?: Array<{ name?: string; value?: string }>;
  discount_applications?: unknown[];
}

async function handleOrdersPaid(
  shopDomain: string,
  payload: unknown,
  deps: WebhookDeps,
): Promise<WebhookOutcome> {
  const log = deps.log ?? (() => undefined);
  const order = payload as OrdersPaidPayload;
  if (order.id == null || typeof order.total_price !== 'string') {
    return { handled: false, reason: 'orders/paid payload missing id or total_price' };
  }
  if (order.test) return { handled: true, action: 'skipped test order' };
  // API-created orders can have no customer — nothing to credit.
  const customerId = order.customer?.admin_graphql_api_id ??
    (order.customer?.id != null ? customerGid(order.customer.id) : undefined);
  if (!customerId) return { handled: true, action: 'skipped order without customer' };

  // Cross-check: a checkout that carried a loyalty redemption names its
  // attempt in note_attributes. A missing/unapplied attempt means the
  // discount Function was fed a hand-edited attribute — surface it loudly
  // for the merchant ledger view; the earn below still proceeds normally.
  const attemptAttr = (order.note_attributes ?? []).find((a) => a.name === 'loyalty_attempt');
  let attemptWarning: string | undefined;
  if (attemptAttr?.value) {
    const attempt = await deps.ledger.getAttempt(shopDomain, attemptAttr.value);
    if (!attempt || attempt.status !== 'applied') {
      attemptWarning = `order ${order.id} claims loyalty attempt ${attemptAttr.value} but no applied redemption exists`;
      log(attemptWarning, { shopDomain, orderId: order.id });
    }
  }

  const settings = await deps.settings.get(shopDomain);
  const draft = earnEntryFromOrder({
    shopDomain,
    customerId,
    orderId: order.admin_graphql_api_id ?? orderGid(order.id),
    orderSourceName: order.source_name,
    totalPrice: order.total_price,
    earnRate: settings.earnRate,
  });
  const suffix = attemptWarning ? '; ATTEMPT MISMATCH logged' : '';
  if (!draft) return { handled: true, action: `order earned zero points${suffix}` };
  const { inserted } = await deps.ledger.append(draft);
  return {
    handled: true,
    action: (inserted ? `earned ${draft.delta}` : 'earn already recorded') + suffix,
  };
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
  const refunded = (refund.transactions ?? [])
    .filter((t) => t.kind === 'refund' && t.status === 'success' && typeof t.amount === 'string')
    .reduce((sum, t) => sum + centsOf(t.amount as string), 0);
  if (refunded <= 0) return { handled: true, action: 'no refunded amount, nothing to reverse' };

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
    refundedAmount: (refunded / 100).toFixed(2),
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

function centsOf(amount: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) return 0;
  const [, sign, whole, frac = ''] = m;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0');
  return sign === '-' ? -cents : cents;
}

async function findEarnEntry(
  ledger: LedgerStore,
  shopDomain: string,
  orderId: string,
): Promise<PointsLedgerEntry | undefined> {
  return ledger.findByOrder(shopDomain, orderId, 'earn');
}
