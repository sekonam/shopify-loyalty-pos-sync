import {
  floorProduct,
  sumAmounts,
  type LedgerStore,
  type ShopSettings,
} from '@loyalty/ledger';
import { computeOrderEarn, reverseOrderRefund } from './earn-policy.js';
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

  // Referrals only for orders that actually earn — an excluded source or
  // disabled channel must not pay rewards (nor consume the friend's one slot).
  if (policy.kind === 'earn') {
    const referralAction = await processReferral(shopDomain, oid, customerId, order, settings, deps);
    if (referralAction) earnAction = `${earnAction}; ${referralAction}`;
  }

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
 * Referral rewards, triggered by the friend's first earning order carrying a
 * loyalty_referral attribute. One reward per referred customer ever (the
 * store's primary key enforces it — designed against BON's class of
 * repeatable-referral bugs); self-referral and unknown codes are ignored
 * with a log line. Both ledger writes are idempotent per order, so a
 * redelivered webhook can't double-reward.
 */
async function processReferral(
  shopDomain: string,
  orderId: string,
  customerId: string,
  order: OrdersPaidPayload,
  settings: ShopSettings,
  deps: WebhookDeps,
): Promise<string | undefined> {
  const referral = settings.referral;
  const code = (order.note_attributes ?? [])
    .find((a) => a.name === 'loyalty_referral')
    ?.value?.trim();
  if (!code) return undefined;
  const log = deps.log ?? (() => undefined);
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
