/**
 * End-to-end seed + verification against a RUNNING backend (DEV_HARNESS not
 * required — this script signs its own webhooks and session tokens). It
 * drives everything through real HTTP, mirrors the expected balances in an
 * independent oracle, and fails loudly on any divergence.
 *
 *   DATABASE_URL=... SHOPIFY_API_KEY=test-client-id SHOPIFY_API_SECRET=test-secret \
 *     PORT=35800 pnpm --filter @loyalty/shopify-backend dev &
 *   npx tsx scripts/e2e-seed.mts
 */
import { createHmac, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

const BASE = process.env['E2E_BASE'] ?? 'http://localhost:35800';
const SECRET = process.env['SHOPIFY_API_SECRET'] ?? 'test-secret';
const API_KEY = process.env['SHOPIFY_API_KEY'] ?? 'test-client-id';
const SHOP = process.env['DEV_SHOP'] ?? 'loyalty-e2e.myshopify.com';

// Deterministic PRNG so reruns generate the same dataset.
let seed = 0x5eedf00d;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

const failures: string[] = [];
const check = (cond: boolean, label: string) => {
  if (!cond) failures.push(label);
  return cond;
};

// ---------- oracle ----------
const balances = new Map<string, number>();
let expectedEntries = 0;
const bal = (c: string) => balances.get(c) ?? 0;
const add = (c: string, d: number) => balances.set(c, bal(c) + d);

// ---------- http helpers ----------
async function webhook(topic: string, payload: unknown, webhookId = randomUUID()) {
  const rawBody = JSON.stringify(payload);
  const res = await fetch(`${BASE}/webhooks`, {
    method: 'POST',
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': SHOP,
      'x-shopify-webhook-id': webhookId,
      'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(rawBody).digest('base64'),
    },
  });
  const body = (await res.json()) as { action?: string };
  check(res.ok, `webhook ${topic} HTTP ${res.status}`);
  return body.action ?? '';
}

async function token(kind: 'staff' | 'customer' | 'anonymous', customerId?: string) {
  const payload: Record<string, unknown> = { dest: `https://${SHOP}`, aud: API_KEY, jti: randomUUID() };
  if (kind === 'staff') payload['sub'] = '990001';
  if (kind === 'customer') payload['sub'] = customerId;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(SECRET));
}

async function api(path: string, kind: 'staff' | 'customer' | 'anonymous', init: RequestInit = {}, customerId?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${await token(kind, customerId)}` },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown>, res };
}

async function redeem(
  kind: 'staff' | 'customer',
  customerId: string,
  points: number,
  attemptId = randomUUID(),
) {
  const body: Record<string, unknown> = { points, attemptId, channel: kind === 'staff' ? 'pos' : 'web' };
  if (kind === 'staff') body['customerId'] = customerId;
  return api('/api/redeem', kind, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }, customerId);
}

const gid = (n: number) => `gid://shopify/Customer/${n}`;
const orderPayload = (id: number, customer: number | null, total: string, source: string, extra: Record<string, unknown> = {}) => ({
  id,
  admin_graphql_api_id: `gid://shopify/Order/${id}`,
  source_name: source,
  test: false,
  total_price: total,
  currency: 'USD',
  customer: customer === null ? null : { id: customer, admin_graphql_api_id: gid(customer) },
  ...extra,
});

// ---------- phases ----------
async function phaseOrders() {
  const sources = ['web', 'pos', 'pos', 'web', 'iphone', 'shopify_draft_order'];
  let orderId = 100000;
  let sent = 0;
  const batch: Promise<void>[] = [];
  for (let i = 0; i < 300; i++) {
    const customer = 9001 + Math.floor(rand() * 30);
    const total = (Math.floor(rand() * 39500 + 500) / 100).toFixed(2);
    const source = pick(sources);
    const isTest = rand() < 0.05;
    const noCustomer = rand() < 0.04;
    const id = orderId++;
    const payload = orderPayload(id, noCustomer ? null : customer, total, source, isTest ? { test: true } : {});
    if (!isTest && !noCustomer) {
      const earn = Math.floor(Number(total));
      if (earn > 0) {
        add(gid(customer), earn);
        expectedEntries++;
      }
    }
    batch.push(webhook('orders/paid', payload).then(() => void sent++));
    if (batch.length >= 20) {
      await Promise.all(batch.splice(0));
    }
    orders.push({ id, customer: noCustomer ? null : customer, total, isTest });
  }
  await Promise.all(batch);
  console.log(`orders sent: ${sent}`);
}
const orders: Array<{ id: number; customer: number | null; total: string; isTest: boolean }> = [];

async function phaseIdempotency() {
  // Redeliver an existing order under the SAME webhook id → duplicate.
  const target = orders.find((o) => o.customer !== null && !o.isTest)!;
  const wid = randomUUID();
  const payload = orderPayload(target.id, target.customer, target.total, 'web');
  await webhook('orders/paid', payload, wid);
  const dup = await webhook('orders/paid', payload, wid);
  check(dup === 'duplicate', `same webhook id → duplicate, got '${dup}'`);
  // Same order under a NEW webhook id → earn already recorded.
  const replay = await webhook('orders/paid', payload);
  check(replay.startsWith('earn already recorded'), `order replay → already recorded, got '${replay}'`);
}

async function phaseRedemptions() {
  let applied = 0;
  let rejected = 0;
  for (let i = 0; i < 80; i++) {
    const customer = gid(9001 + Math.floor(rand() * 30));
    const kind = rand() < 0.5 ? 'staff' : 'customer';
    const current = bal(customer);
    const wantReject = rand() < 0.25;
    const points = wantReject
      ? current + 500 // guaranteed insufficient
      : Math.max(100, Math.floor(current * rand() * 0.5));
    const { status, body } = await redeem(kind as 'staff' | 'customer', customer, points);
    if (points >= 100 && points <= current) {
      check(status === 200 && body['status'] === 'applied', `redeem ${points}<=${current} should apply (got ${status} ${body['status']})`);
      add(customer, -points);
      expectedEntries++;
      applied++;
    } else {
      check(status === 409, `redeem ${points} vs ${current} should 409 (got ${status})`);
      rejected++;
    }
  }
  console.log(`redemptions applied: ${applied}, rejected: ${rejected}`);

  // Retry with the same attemptId must not double-debit.
  const c = gid(9001);
  if (bal(c) >= 100) {
    const attemptId = randomUUID();
    const first = await redeem('staff', c, 100, attemptId);
    const second = await redeem('staff', c, 100, attemptId);
    check(first.body['status'] === 'applied' && second.body['status'] === 'applied', 'attempt retry statuses');
    add(c, -100);
    expectedEntries++;
    check((second.body['balance'] as number) === bal(c), `retry balance ${second.body['balance']} vs oracle ${bal(c)}`);
  }
}

async function phaseRefunds() {
  let refundId = 700000;
  let reversed = 0;
  const refundable = orders.filter((o) => o.customer !== null && !o.isTest).slice(0, 60);
  for (const o of refundable) {
    const customer = gid(o.customer as number);
    const oversize = rand() < 0.15;
    const amount = oversize
      ? (Number(o.total) * 3).toFixed(2)
      : (Math.max(1, Number(o.total) * rand())).toFixed(2);
    const action = await webhook('refunds/create', {
      id: refundId,
      admin_graphql_api_id: `gid://shopify/Refund/${refundId}`,
      order_id: o.id,
      transactions: [{ kind: 'refund', status: 'success', amount }],
    });
    refundId++;
    const expected = Math.min(Math.floor(Number(amount)), Math.max(bal(customer), 0));
    if (expected > 0) {
      check(action === `reversed ${expected}`, `refund ${amount} of order ${o.id}: expected 'reversed ${expected}', got '${action}'`);
      add(customer, -expected);
      expectedEntries++;
      reversed++;
    } else {
      check(
        action.includes('capped to zero') || action.includes('zero points'),
        `refund with nothing reversible: got '${action}'`,
      );
    }
  }
  console.log(`refunds processed: ${refundable.length}, reversals: ${reversed}`);

  // Restock-only refund (no money moved) reverses nothing.
  const o = refundable[0]!;
  const action = await webhook('refunds/create', {
    id: refundId++,
    order_id: o.id,
    transactions: [],
  });
  check(action.includes('no refunded amount'), `restock-only refund: '${action}'`);
}

async function phaseOutOfOrder() {
  // Refund arrives before its order; after the order lands, the refund is
  // redelivered (as Shopify's retry would) and then applies.
  const customer = 9031;
  const before = await webhook('refunds/create', {
    id: 710001,
    admin_graphql_api_id: 'gid://shopify/Refund/710001',
    order_id: 200001,
    transactions: [{ kind: 'refund', status: 'success', amount: '10.00' }],
  });
  check(before.includes('no earn entry'), `refund-before-order: '${before}'`);
  await webhook('orders/paid', orderPayload(200001, customer, '80.00', 'pos'));
  add(gid(customer), 80);
  expectedEntries++;
  const after = await webhook('refunds/create', {
    id: 710001,
    admin_graphql_api_id: 'gid://shopify/Refund/710001',
    order_id: 200001,
    transactions: [{ kind: 'refund', status: 'success', amount: '10.00' }],
  });
  check(after === 'reversed 10', `redelivered refund applies: '${after}'`);
  add(gid(customer), -10);
  expectedEntries++;
}

async function phaseClawback() {
  // Forged discount attribute: order claims a 5.00 loyalty discount (=500
  // points) with no applied attempt → clawed back, capped at the balance.
  const customer = 9033;
  await webhook('orders/paid', orderPayload(200002, customer, '120.00', 'web'));
  add(gid(customer), 120);
  expectedEntries++;
  const action = await webhook(
    'orders/paid',
    orderPayload(200003, customer, '60.00', 'web', {
      note_attributes: [
        { name: 'loyalty_discount', value: '5.00' },
        { name: 'loyalty_attempt', value: randomUUID() },
      ],
    }),
  );
  add(gid(customer), 60);
  expectedEntries++;
  const clawable = Math.min(500, bal(gid(customer)));
  check(
    action === `earned 60; ATTEMPT MISMATCH: clawed back ${clawable}`,
    `clawback action: '${action}' (expected clawed back ${clawable})`,
  );
  add(gid(customer), -clawable);
  expectedEntries++;
}

async function phaseRace() {
  const customer = 9032;
  await webhook('orders/paid', orderPayload(200004, customer, '300.00', 'pos'));
  add(gid(customer), 300);
  expectedEntries++;
  const [a, b] = await Promise.all([
    redeem('staff', gid(customer), 200),
    redeem('staff', gid(customer), 200),
  ]);
  const statuses = [a.body['status'], b.body['status']].sort();
  check(
    statuses[0] === 'applied' && statuses[1] === 'rejected_insufficient_balance',
    `race outcome: ${statuses.join(',')}`,
  );
  add(gid(customer), -200);
  expectedEntries++;
}

async function phaseAuth() {
  const anon = await api('/api/balance', 'anonymous');
  check(anon.status === 403, `anonymous balance → 403, got ${anon.status}`);
  const custSettings = await api('/api/settings', 'customer', {}, gid(9001));
  check(custSettings.status === 403, `customer settings → 403, got ${custSettings.status}`);
  const crossRead = await api(
    `/api/balance?customerId=${encodeURIComponent(gid(9002))}`,
    'customer',
    {},
    gid(9001),
  );
  check(crossRead.status === 403, `cross-customer read → 403, got ${crossRead.status}`);
}

async function phaseVerify() {
  let checked = 0;
  for (const [customer, expected] of balances) {
    const { status, body } = await api(
      `/api/balance?customerId=${encodeURIComponent(customer)}`,
      'staff',
    );
    check(status === 200, `balance HTTP ${status} for ${customer}`);
    check(
      body['balance'] === expected,
      `BALANCE DIVERGENCE ${customer}: server ${body['balance']} vs oracle ${expected}`,
    );
    check(Number(body['balance']) >= 0, `negative balance for ${customer}: ${body['balance']}`);
    checked++;
  }
  const entries = await api('/api/entries', 'staff');
  const count = (entries.body['entries'] as unknown[]).length;
  check(count === expectedEntries, `entry count: server ${count} vs oracle ${expectedEntries}`);

  const csvRes = await fetch(`${BASE}/api/ledger.csv`, {
    headers: { authorization: `Bearer ${await token('staff')}` },
  });
  const csv = await csvRes.text();
  const lines = csv.trim().split('\n');
  check(
    lines[0] === 'id,customer_id,order_id,refund_id,source_name,delta,reason,created_at',
    'csv header',
  );
  check(lines.length - 1 === expectedEntries, `csv rows ${lines.length - 1} vs ${expectedEntries}`);

  console.log(`verified ${checked} customer balances, ${count} ledger entries, csv ok`);
}

// ---------- run ----------
const started = Date.now();
await phaseOrders();
await phaseIdempotency();
await phaseRedemptions();
await phaseRefunds();
await phaseOutOfOrder();
await phaseClawback();
await phaseRace();
await phaseAuth();
await phaseVerify();

const totalPoints = [...balances.values()].reduce((a, b) => a + b, 0);
console.log(`\ncustomers: ${balances.size}, total outstanding points: ${totalPoints}`);
console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failures.length) {
  console.error(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('\nE2E SEED + VERIFY: ALL CHECKS PASSED');
