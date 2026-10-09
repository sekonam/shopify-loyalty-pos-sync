/**
 * The reconciliation job, driven end to end against a RUNNING backend and a
 * local stand-in for Shopify's Admin GraphQL API.
 *
 * What this proves that unit tests cannot: the central claim of the whole
 * product — "a dropped orders/paid webhook self-heals within one
 * reconciliation cycle" (TECHNICAL-SPEC §5) — only holds if the real HTTP
 * client, the real `shop_token` lookup, the real since-window arithmetic, the
 * real eligibility join, the real ledger writes and the real run recording all
 * line up. They meet for the first time at an Admin API, and there is no
 * Partner account to meet at yet (START-HERE.md), so they meet at the dev
 * harness's stub instead (DEV_ADMIN_STUB; see dev-harness.ts for the gating).
 *
 * As in bulk-seed.mts, the expectations here are an INDEPENDENT oracle: the
 * script imports nothing from @loyalty/ledger and does its own arithmetic, so
 * it is able to disagree with the code it is checking. Idempotency keys are
 * asserted as literal strings for the same reason — the canonical
 * `order_paid:<orderId>` is what makes a late webhook after a correction a
 * structural no-op, and a key format silently drifting to the older
 * `reconcile:` sketch in §3 would reintroduce exactly the double-apply this
 * job exists to prevent.
 *
 *   cd packages/shopify-backend
 *   DATABASE_URL=... SHOPIFY_API_KEY=test-client-id SHOPIFY_API_SECRET=test-secret \
 *     PORT=35801 DEV_HARNESS=1 DEV_ADMIN_STUB=1 DEV_SHOP=recon-e2e.myshopify.com \
 *     node_modules/.bin/tsx src/server.ts &
 *   E2E_BASE=http://localhost:35801 DEV_SHOP=recon-e2e.myshopify.com npx tsx scripts/recon-e2e.mts
 *
 * The shop domain is dedicated on purpose: phase 0 purges the tenant, so
 * pointing this at a seeded store would delete that store's ledger.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

const BASE = process.env['E2E_BASE'] ?? 'http://localhost:35801';
const SECRET = process.env['SHOPIFY_API_SECRET'] ?? 'test-secret';
const API_KEY = process.env['SHOPIFY_API_KEY'] ?? 'test-client-id';
const SHOP = process.env['DEV_SHOP'] ?? 'recon-e2e.myshopify.com';

/**
 * Deliberately far below the job's `first: 50`, so every run in this script
 * pages more than once and the cursor path is never the untested one.
 */
const PAGE_SIZE = 3;

/** Run-scoped id space, so reruns are safe on a dirty database. */
const RUN = Date.now() % 100_000_000;

/** The referral program this run configures, mirrored for the oracle. */
const REFERRAL = { advocate: 200, friend: 100 };

const failures: string[] = [];
/** Real behaviour worth a human's attention that is not an oracle divergence. */
const findings: string[] = [];
const check = (cond: boolean, label: string) => {
  if (!cond) failures.push(label);
  return cond;
};
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const step = (msg: string) => console.log(`[${elapsed()}] ${msg}`);

// ---------------------------------------------------------------- ids
let seq = 0;
const nextNum = () => `${RUN}${String(seq++).padStart(4, '0')}`;
const customerNum = () => nextNum();
const customerGid = (num: string) => `gid://shopify/Customer/${num}`;
const orderGid = (num: string) => `gid://shopify/Order/${num}`;
const refundGid = (num: string) => `gid://shopify/Refund/${num}`;

// ---------------------------------------------------------------- http
async function webhook(topic: string, payload: unknown, webhookId: string = randomUUID()) {
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
  if (!res.ok) {
    check(false, `webhook ${topic} HTTP ${res.status}`);
    return '';
  }
  const body = (await res.json()) as { action?: string; reason?: string };
  return body.action ?? `reason:${body.reason}`;
}

const sign = (sub: string) =>
  new SignJWT({ dest: `https://${SHOP}`, aud: API_KEY, jti: randomUUID(), sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(SECRET));

const staffToken = await sign('990001');

async function api(path: string, init: RequestInit = {}, token = staffToken) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** A shopper's own session, as checkout holds it — the only way to read an advocate's code. */
const asCustomer = async (gid: string, path: string) => api(path, {}, await sign(gid));

async function dev(path: string, body?: unknown) {
  const res = await fetch(`${BASE}/dev${path}${path.includes('?') ? '&' : '?'}shop=${encodeURIComponent(SHOP)}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

// ---------------------------------------------------------------- oracle
/** Expected balance per customer, maintained by this script alone. */
const expected = new Map<string, number>();
const credit = (gid: string, points: number) =>
  expected.set(gid, (expected.get(gid) ?? 0) + points);

/**
 * How many seeded orders the next run should SEE. Every order this script
 * seeds is timestamped "now" unless it is deliberately stale, and the window
 * only ever starts in the past, so an in-window order stays in-window for the
 * rest of the run — which makes both ordersSeen and the page count exactly
 * predictable.
 */
let inWindow = 0;

interface SeedOrder {
  num: string;
  customerNum: string | null;
  total: string;
  source: string | null;
  status: string | null;
  test?: boolean;
  refunds?: Array<{ num: string; amount: string }>;
  /**
   * The checkout's loyalty attributes. One order object serves both delivery
   * paths below — `note_attributes` on the webhook, `customAttributes` on the
   * Admin API — which is what makes a parity claim about the two paths mean
   * anything: it is demonstrably the same order either way.
   */
  attributes?: Array<{ name: string; value: string }>;
  /** Set to put the order outside the next run's window. */
  updatedAt?: string;
}

/** One order exactly as the Admin API's RECON_QUERY would return it. */
const asAdminNode = (o: SeedOrder) => ({
  id: orderGid(o.num),
  sourceName: o.source,
  test: o.test ?? false,
  displayFinancialStatus: o.status,
  customer: o.customerNum === null ? null : { id: customerGid(o.customerNum) },
  totalPriceSet: { shopMoney: { amount: o.total } },
  customAttributes: (o.attributes ?? []).map((a) => ({ key: a.name, value: a.value })),
  refunds: (o.refunds ?? []).map((r) => ({
    id: refundGid(r.num),
    totalRefundedSet: { shopMoney: { amount: r.amount } },
  })),
  ...(o.updatedAt !== undefined ? { updatedAt: o.updatedAt } : {}),
});

/** Every order id this run has put into Shopify's history. */
const seeded = new Set<string>();

/** Puts orders into Shopify's history — i.e. what the ledger may be missing. */
async function seedAdmin(orders: SeedOrder[], opts: { stale?: boolean } = {}) {
  const res = await dev('/admin-orders', { orders: orders.map(asAdminNode) });
  check(res.status === 200, `seed ${orders.length} admin orders: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  // A re-seeded order id REPLACES its earlier copy, so adding refunds to an
  // order already in the stub must not inflate the expected ordersSeen.
  if (!opts.stale) inWindow += orders.filter((o) => !seeded.has(o.num)).length;
  for (const o of orders) seeded.add(o.num);
}

/** One paid order delivered the normal way: an orders/paid webhook. */
const paidWebhook = (o: SeedOrder, webhookId?: string) =>
  webhook(
    'orders/paid',
    {
      id: o.num,
      admin_graphql_api_id: orderGid(o.num),
      source_name: o.source,
      test: o.test ?? false,
      total_price: o.total,
      currency: 'USD',
      customer:
        o.customerNum === null
          ? null
          : { id: o.customerNum, admin_graphql_api_id: customerGid(o.customerNum) },
      note_attributes: o.attributes ?? [],
    },
    webhookId,
  );

interface RunResult {
  eligible?: boolean;
  sinceBefore?: string | null;
  sinceAfter?: string | null;
  stubCalls?: number;
  run?: { finishedAt: string | null; ordersSeen: number; entriesAdded: number; error: string | null } | null;
}

/**
 * One synchronous sweep, with the whole run asserted: what it saw, what it
 * added, and that it took exactly the number of Admin API round-trips the
 * page size implies — the only way paging failing open (one page, rest
 * silently dropped) would ever be visible.
 */
async function reconcile(
  label: string,
  want: { ordersSeen: number; entriesAdded: number } | { fails: string },
): Promise<RunResult> {
  const res = await dev('/reconcile');
  check(res.status === 200, `${label}: reconcile HTTP ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as RunResult;
  check(body.eligible === true, `${label}: shop is eligible for reconciliation`);
  const run = body.run ?? undefined;
  if (!check(!!run, `${label}: a run was recorded`)) return body;
  if ('fails' in want) {
    check(
      (run?.error ?? '').includes(want.fails),
      `${label}: run records the failure (${JSON.stringify(run?.error)})`,
    );
    check(run?.ordersSeen === 0 && run?.entriesAdded === 0, `${label}: a failed run adds nothing`);
    check(
      body.sinceBefore === body.sinceAfter,
      `${label}: failure keeps the retry window (${body.sinceBefore} -> ${body.sinceAfter})`,
    );
  } else {
    check(run?.error === null, `${label}: run has no error (${JSON.stringify(run?.error)})`);
    check(run?.ordersSeen === want.ordersSeen, `${label}: ordersSeen ${run?.ordersSeen} vs ${want.ordersSeen}`);
    check(
      run?.entriesAdded === want.entriesAdded,
      `${label}: entriesAdded ${run?.entriesAdded} vs ${want.entriesAdded}`,
    );
    const pages = Math.max(1, Math.ceil(want.ordersSeen / PAGE_SIZE));
    check(body.stubCalls === pages, `${label}: ${body.stubCalls} admin calls vs ${pages} pages`);
  }
  return body;
}

interface Entry {
  orderId?: string;
  refundId?: string;
  customerId: string;
  sourceName: string;
  delta: number;
  reason: string;
  idempotencyKey: string;
}

const entriesOf = async (gid: string): Promise<Entry[]> =>
  ((await api(`/api/entries?customerId=${encodeURIComponent(gid)}`)).body['entries'] as Entry[]) ?? [];

const shopEntries = async (): Promise<Entry[]> =>
  ((await api('/api/entries?limit=10000')).body['entries'] as Entry[]) ?? [];

const balanceOf = async (gid: string): Promise<number> =>
  Number((await api(`/api/balance?customerId=${encodeURIComponent(gid)}`)).body['balance']);

/** Every customer the script has an expectation for, checked in one pass. */
async function assertBalances(label: string) {
  for (const [gid, points] of expected) {
    const got = await balanceOf(gid);
    check(got === points, `${label}: balance ${gid} is ${got}, expected ${points}`);
  }
}

const oneEntryFor = (entries: Entry[], orderNum: string) =>
  entries.filter((e) => e.orderId === orderGid(orderNum));

// ---------------------------------------------------------------- phase 0
async function phaseReset() {
  const purge = await webhook('shop/redact', { shop_domain: SHOP });
  check(purge === 'shop purged', `reset ${SHOP}: '${purge}'`);

  const put = await api('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    // Flat 1 point per unit, no tiers or exclusions: this script is about the
    // diff, and earn arithmetic is bulk-seed.mts's job. Referrals ARE on,
    // because a referral reward is one of the two things a dropped webhook
    // used to lose for good.
    body: JSON.stringify({
      earnRate: '1',
      redemptionRate: '100',
      minRedemption: 100,
      channelRules: {
        web: { enabled: true },
        pos: { enabled: true },
        mobile_app: { enabled: true },
        other: { enabled: true },
      },
      excludedSources: [],
      tiers: [],
      referral: { enabled: true, advocatePoints: REFERRAL.advocate, friendPoints: REFERRAL.friend },
    }),
  });
  check(put.status === 200, `settings PUT ${put.status}`);

  // A purged tenant has no run history, which is also the dashboard's
  // "never checked itself" state.
  const fresh = await api('/api/overview');
  check(fresh.body['reconciliation'] === null, `fresh tenant has no reconciliation run: ${JSON.stringify(fresh.body['reconciliation'])}`);

  // shop/redact deletes the Admin token too (it is tenant credentials), so
  // the token has to be registered AFTER the purge, not before.
  const token = await dev('/admin-token');
  check(
    token.status === 200 && typeof token.body['token'] === 'string',
    `register admin token: HTTP ${token.status} ${JSON.stringify(token.body)}`,
  );
  const stub = await dev('/admin-orders', { reset: true, pageSize: PAGE_SIZE, failWith: null });
  check(
    stub.status === 200 && stub.body['pageSize'] === PAGE_SIZE,
    `reset admin stub: ${JSON.stringify(stub.body)}`,
  );
  step(`tenant reset; admin stub paging at ${PAGE_SIZE}; run ${RUN}`);
}

// ---------------------------------------------------------------- phase A
/** The invariant: an order Shopify knows about and the ledger does not. */
let droppedOrder: SeedOrder;
let deliveredOrder: SeedOrder;

async function phaseDroppedEarn() {
  const c1 = customerNum();
  const c1gid = customerGid(c1);
  deliveredOrder = { num: nextNum(), customerNum: c1, total: '50.00', source: 'web', status: 'PAID' };
  droppedOrder = { num: nextNum(), customerNum: c1, total: '30.00', source: 'pos', status: 'PAID' };

  const action = await paidWebhook(deliveredOrder);
  check(action === 'earned 50', `delivered order earns on the webhook: '${action}'`);
  credit(c1gid, 50);
  check((await balanceOf(c1gid)) === 50, 'balance after the delivered webhook is 50');

  // Shopify's history holds both. The second webhook never arrived — nothing
  // is sent for it, which is precisely what a dropped delivery looks like.
  await seedAdmin([deliveredOrder, droppedOrder]);

  const before = await entriesOf(c1gid);
  check(before.length === 1, `ledger is missing the dropped order before the run (${before.length} entries)`);

  await reconcile('dropped earn', { ordersSeen: inWindow, entriesAdded: 1 });
  credit(c1gid, 30);

  const after = await entriesOf(c1gid);
  check((await balanceOf(c1gid)) === 80, 'the dropped earn self-healed within one cycle (balance 80)');
  const healed = oneEntryFor(after, droppedOrder.num);
  check(healed.length === 1, `exactly one entry for the healed order (${healed.length})`);
  const h = healed[0];
  check(h?.reason === 'reconciliation', `healed entry reason: '${h?.reason}'`);
  check(h?.delta === 30, `healed entry delta: ${h?.delta}`);
  // Channel-tagged from the Order itself, never inferred and never 'system':
  // a correction that lost the channel would corrupt the per-channel reporting
  // this app is sold on.
  check(h?.sourceName === 'pos', `healed entry is channel-tagged from the order: '${h?.sourceName}'`);
  check(
    h?.idempotencyKey === `order_paid:${orderGid(droppedOrder.num)}`,
    `healed entry uses the canonical webhook key: '${h?.idempotencyKey}'`,
  );

  // (c) reconciliation must not duplicate what the webhook path already wrote.
  const untouched = oneEntryFor(after, deliveredOrder.num);
  check(untouched.length === 1, `the already-earned order still has one entry (${untouched.length})`);
  check(untouched[0]?.reason === 'earn', `the already-earned order keeps reason 'earn': '${untouched[0]?.reason}'`);
  step('dropped orders/paid self-healed with the canonical key; the delivered one was left alone');
}

// ---------------------------------------------------------------- phase B
async function phaseNoDoubleCounting() {
  const c1gid = customerGid(deliveredOrder.customerNum as string);

  // The late webhook, arriving after the correction. Shopify redelivers for
  // up to ~48h, so this is the common case, not an exotic one.
  const late = await paidWebhook(droppedOrder);
  check(late === 'earn already recorded', `late webhook after the correction is a no-op: '${late}'`);
  check((await balanceOf(c1gid)) === 80, 'balance unchanged by the late webhook');
  const entries = await entriesOf(c1gid);
  check(oneEntryFor(entries, droppedOrder.num).length === 1, 'still exactly one entry for the healed order');
  check(
    oneEntryFor(entries, droppedOrder.num)[0]?.reason === 'reconciliation',
    'the healed entry is not rewritten by the late webhook',
  );

  // The same delivery twice is stopped a layer earlier, at the receipt.
  const sameId = randomUUID();
  await paidWebhook(droppedOrder, sameId);
  const replay = await paidWebhook(droppedOrder, sameId);
  check(replay === 'duplicate', `a redelivered webhook id is a receipt-layer no-op: '${replay}'`);

  // And the reverse order: webhook first, reconciliation after.
  const c2 = customerNum();
  const c2gid = customerGid(c2);
  const order = { num: nextNum(), customerNum: c2, total: '20.00', source: 'web', status: 'PAID' };
  const earned = await paidWebhook(order);
  check(earned === 'earned 20', `webhook-first order earns: '${earned}'`);
  credit(c2gid, 20);
  await seedAdmin([order]);
  await reconcile('webhook then reconcile', { ordersSeen: inWindow, entriesAdded: 0 });
  const c2entries = await entriesOf(c2gid);
  check(c2entries.length === 1, `webhook-first order has one entry after a sweep (${c2entries.length})`);
  check((await balanceOf(c2gid)) === 20, 'webhook-first balance unchanged by the sweep');
  step('no double-counting in either arrival order');
}

// ---------------------------------------------------------------- phase C
async function phaseMissingRefund() {
  const c3 = customerNum();
  const c3gid = customerGid(c3);
  const order = { num: nextNum(), customerNum: c3, total: '500.00', source: 'pos', status: 'PAID' };
  check((await paidWebhook(order)) === 'earned 500', 'refund scenario: the order earns 500');
  credit(c3gid, 500);

  // Spend most of it, so the reversal has to be capped at the live balance
  // rather than at what the order earned.
  const redeemed = await api('/api/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId: c3gid, points: 400, attemptId: randomUUID(), channel: 'pos', posDeviceId: 'till-1' }),
  });
  check(redeemed.status === 200, `redeem 400 at POS: HTTP ${redeemed.status} ${JSON.stringify(redeemed.body)}`);
  credit(c3gid, -400);
  check((await balanceOf(c3gid)) === 100, 'balance is 100 before the missing refund');

  // The refund exists in Shopify; refunds/create never arrived.
  const refundNum = nextNum();
  await seedAdmin([{ ...order, status: 'PARTIALLY_REFUNDED', refunds: [{ num: refundNum, amount: '300.00' }] }]);
  await reconcile('missing refund', { ordersSeen: inWindow, entriesAdded: 1 });

  // 300.00 at rate 1 is 300 reversible points, but only 100 are there to take.
  credit(c3gid, -100);
  check((await balanceOf(c3gid)) === 0, 'the reversal is capped at the live balance (0, not -200)');
  const reversal = (await entriesOf(c3gid)).filter((e) => e.refundId === refundGid(refundNum));
  check(reversal.length === 1, `exactly one reversal entry (${reversal.length})`);
  const r = reversal[0];
  check(r?.reason === 'refund_reversal', `reversal reason: '${r?.reason}'`);
  check(r?.delta === -100, `reversal delta: ${r?.delta}`);
  check(r?.orderId === orderGid(order.num), `reversal carries its order id: '${r?.orderId}'`);
  check(r?.sourceName === 'pos', `reversal keeps the order's channel: '${r?.sourceName}'`);
  check(
    r?.idempotencyKey === `refund:${refundGid(refundNum)}`,
    `reversal uses the canonical refund key: '${r?.idempotencyKey}'`,
  );

  // The late refunds/create, after the correction.
  const late = await webhook('refunds/create', {
    id: refundNum,
    admin_graphql_api_id: refundGid(refundNum),
    order_id: order.num,
    transactions: [{ kind: 'refund', status: 'success', amount: '300.00' }],
  });
  check(late === 'reversal already recorded', `late refunds/create is a no-op: '${late}'`);
  check((await balanceOf(c3gid)) === 0, 'balance unchanged by the late refund webhook');
  step('a refund Shopify knew about and the ledger did not was reversed, capped, and not re-applied');
}

// ---------------------------------------------------------------- phase D
async function phaseSkipped() {
  const c4 = customerNum();
  const c4gid = customerGid(c4);
  expected.set(c4gid, 0);
  const testOrder: SeedOrder = { num: nextNum(), customerNum: c4, total: '70.00', source: 'web', status: 'PAID', test: true };
  const noCustomer: SeedOrder = { num: nextNum(), customerNum: null, total: '70.00', source: 'web', status: 'PAID' };

  const viaWebhook = await paidWebhook(testOrder);
  check(viaWebhook === 'skipped test order', `the webhook path skips test orders: '${viaWebhook}'`);

  await seedAdmin([testOrder, noCustomer]);
  await reconcile('test and customerless orders', { ordersSeen: inWindow, entriesAdded: 0 });

  check((await balanceOf(c4gid)) === 0, 'a test order never earns, not even via reconciliation');
  const all = await shopEntries();
  check(
    oneEntryFor(all, testOrder.num).length === 0 && oneEntryFor(all, noCustomer.num).length === 0,
    'neither the test order nor the customerless order left a ledger entry',
  );
  step('test orders and orders without a customer are skipped by the sweep too');
}

// ---------------------------------------------------------------- phase E
async function phaseFinancialStatus() {
  // Only statuses whose money actually arrived may earn. A PENDING or
  // AUTHORIZED order earning would be the app paying out points for money the
  // merchant has not been given.
  const unpaid = ['PENDING', 'AUTHORIZED', 'PARTIALLY_PAID', 'VOIDED', 'EXPIRED', null];
  const c5 = customerNum();
  const c5gid = customerGid(c5);
  expected.set(c5gid, 0);
  await seedAdmin(
    unpaid.map((status) => ({ num: nextNum(), customerNum: c5, total: '80.00', source: 'web', status })),
  );

  // The paid-class statuses an order can be in after the fact still earn —
  // orders/paid fired for them once, so a dropped one must still heal.
  const c6 = customerNum();
  const c6gid = customerGid(c6);
  const partially = { num: nextNum(), customerNum: c6, total: '40.00', source: 'web', status: 'PARTIALLY_REFUNDED' };
  const c7 = customerNum();
  const c7gid = customerGid(c7);
  const refunded = { num: nextNum(), customerNum: c7, total: '25.00', source: 'mobile_app', status: 'REFUNDED' };
  await seedAdmin([partially, refunded]);

  await reconcile('financial statuses', { ordersSeen: inWindow, entriesAdded: 2 });
  credit(c6gid, 40);
  credit(c7gid, 25);

  check((await balanceOf(c5gid)) === 0, 'no unpaid-status order earned anything');
  check((await entriesOf(c5gid)).length === 0, 'no unpaid-status order left an entry');
  check((await balanceOf(c6gid)) === 40, 'a PARTIALLY_REFUNDED order still heals its earn');
  check((await balanceOf(c7gid)) === 25, 'a REFUNDED order still heals its earn');
  step(`${unpaid.length} non-paid statuses earned nothing; PARTIALLY_REFUNDED/REFUNDED still healed`);
}

// ---------------------------------------------------------------- phase F
/**
 * Parity between the two paths that write earns. The webhook path does three
 * things with a paid order: earn it, pay referral rewards, and claw back a
 * checkout discount larger than the redemption that actually paid for it. A
 * dropped webhook must cost the shop none of them — whichever of the three it
 * is, the money has already moved, and the sweep is the only thing left that
 * can notice. So the test is literally the same order down both paths, and
 * the assertion is that the balances agree.
 */
async function phaseClawbackParity() {
  // A forged discount: 5.00 off at rate 100 claims 500 points against a
  // redemption attempt that was never applied.
  const forged = [
    { name: 'loyalty_attempt', value: randomUUID() },
    { name: 'loyalty_discount', value: '5.00' },
  ];

  const c11 = customerNum();
  const c11gid = customerGid(c11);
  const delivered: SeedOrder = {
    num: nextNum(),
    customerNum: c11,
    total: '50.00',
    source: 'web',
    status: 'PAID',
    attributes: forged,
  };
  const c12 = customerNum();
  const c12gid = customerGid(c12);
  const dropped: SeedOrder = { ...delivered, num: nextNum(), customerNum: c12 };

  // One arrives as a webhook, one only ever exists in Shopify's history.
  const action = await paidWebhook(delivered);
  check(action.includes('clawed back 50'), `forged discount is clawed back on delivery: '${action}'`);
  await seedAdmin([delivered, dropped]);
  await reconcile('clawback parity', { ordersSeen: inWindow, entriesAdded: 1 });
  // Earned 50, clawed back to 0 — the claim was for 500, capped at what the
  // order itself was worth.
  expected.set(c11gid, 0);
  expected.set(c12gid, 0);

  const deliveredEntries = await entriesOf(c11gid);
  const healedEntries = await entriesOf(c12gid);
  const clawbackOf = (entries: Entry[], orderNum: string) =>
    entries.find(
      (e) => e.reason === 'adjustment' && e.idempotencyKey === `attempt_mismatch:${orderGid(orderNum)}`,
    );
  check(!!clawbackOf(deliveredEntries, delivered.num), 'the delivered order has its clawback adjustment');
  const healedClawback = clawbackOf(healedEntries, dropped.num);
  check(!!healedClawback, 'the HEALED order has its clawback adjustment too');
  check(healedClawback?.delta === -50, `healed clawback delta: ${healedClawback?.delta}`);
  check(healedClawback?.sourceName === 'system', `healed clawback is a system entry: '${healedClawback?.sourceName}'`);
  check(
    (await balanceOf(c12gid)) === (await balanceOf(c11gid)),
    `dropped and delivered end at the same balance (${await balanceOf(c12gid)} vs ${await balanceOf(c11gid)})`,
  );
  check(healedEntries.length === 2, `healed order: earn + clawback (${healedEntries.length} entries)`);

  // The overlap window re-reads this order on every later sweep; the clawback
  // is keyed per order, so a second pass must take nothing more.
  await reconcile('clawback re-read', { ordersSeen: inWindow, entriesAdded: 0 });
  check((await entriesOf(c12gid)).length === 2, 'a second sweep does not claw back twice');
  step('a dropped webhook no longer costs the shop its forged-discount clawback');
}

// ---------------------------------------------------------------- phase G
/**
 * The other half: the advocate. A referral reward is paid off the friend's
 * first earning order, so a dropped orders/paid used to mean the advocate was
 * simply never paid — and nothing would ever pay them, which is a support
 * ticket the merchant cannot answer. The sweep must pay it, exactly once
 * however many times the overlap re-reads the order.
 */
async function phaseDroppedReferral() {
  const advocate = customerNum();
  const advocateGid = customerGid(advocate);
  const code = await asCustomer(advocateGid, '/api/referral-code');
  check(code.status === 200, `advocate referral code: HTTP ${code.status} ${JSON.stringify(code.body)}`);
  check(
    code.body['advocatePoints'] === REFERRAL.advocate,
    `advocate reward configured: ${code.body['advocatePoints']}`,
  );

  const friend = customerNum();
  const friendGid = customerGid(friend);
  const order: SeedOrder = {
    num: nextNum(),
    customerNum: friend,
    total: '60.00',
    source: 'web',
    status: 'PAID',
    attributes: [{ name: 'loyalty_referral', value: String(code.body['code']) }],
  };
  // Dropped: seeded into Shopify's history, no webhook ever sent.
  await seedAdmin([order]);
  await reconcile('dropped referral', { ordersSeen: inWindow, entriesAdded: 1 });
  credit(advocateGid, REFERRAL.advocate);
  credit(friendGid, 60 + REFERRAL.friend);

  const advocateEntries = await entriesOf(advocateGid);
  const rewards = advocateEntries.filter(
    (e) => e.idempotencyKey === `referral_advocate:${orderGid(order.num)}`,
  );
  check(rewards.length === 1, `advocate was paid exactly once (${rewards.length} entries)`);
  check(rewards[0]?.reason === 'referral_reward', `advocate reward reason: '${rewards[0]?.reason}'`);
  check(rewards[0]?.delta === REFERRAL.advocate, `advocate reward delta: ${rewards[0]?.delta}`);
  check(rewards[0]?.sourceName === 'system', `advocate reward channel: '${rewards[0]?.sourceName}'`);
  const friendEntries = await entriesOf(friendGid);
  check(
    friendEntries.filter((e) => e.reason === 'referral_reward').length === 1,
    `friend welcome bonus paid once (${friendEntries.filter((e) => e.reason === 'referral_reward').length})`,
  );
  check((await balanceOf(friendGid)) === 160, `friend balance: earn 60 + bonus 100 = ${await balanceOf(friendGid)}`);

  // Exactly once across two sweeps: the overlap re-reads the same order, and
  // the per-order reward keys are what make that free.
  await reconcile('referral re-read', { ordersSeen: inWindow, entriesAdded: 0 });
  check(
    (await entriesOf(advocateGid)).length === advocateEntries.length &&
      (await balanceOf(advocateGid)) === REFERRAL.advocate,
    'a second sweep pays the advocate nothing more',
  );
  check((await entriesOf(friendGid)).length === friendEntries.length, 'a second sweep pays the friend nothing more');
  step('a dropped referral order now pays both parties, exactly once across two sweeps');
}

// ---------------------------------------------------------------- phase H
/**
 * What the fix does NOT reach, probed rather than asserted — the attribute
 * steps sit inside the sweep's `earn is missing` branch, so once an order has
 * an earn the sweep never looks at its attributes again. The webhook path has
 * no such gate: a Shopify redelivery re-runs every step. This is therefore
 * the one shape of partial work the sweep cannot repair — an order whose earn
 * landed while its clawback did not (a crash between the two appends, or any
 * order healed by a deployment older than the clawback fix).
 */
async function phaseSelfRepair() {
  const c13 = customerNum();
  const c13gid = customerGid(c13);
  const order: SeedOrder = { num: nextNum(), customerNum: c13, total: '50.00', source: 'web', status: 'PAID' };
  await seedAdmin([order]);
  await reconcile('heal the earn alone', { ordersSeen: inWindow, entriesAdded: 1 });
  check((await balanceOf(c13gid)) === 50, 'the earn healed on its own');

  // The same order, now carrying the forged discount — as it would have all
  // along had the first sweep been able to act on it.
  await seedAdmin([
    {
      ...order,
      attributes: [
        { name: 'loyalty_attempt', value: randomUUID() },
        { name: 'loyalty_discount', value: '5.00' },
      ],
    },
  ]);
  await reconcile('second look at the same order', { ordersSeen: inWindow, entriesAdded: 0 });
  const entries = await entriesOf(c13gid);
  const clawback = entries.filter((e) => e.reason === 'adjustment');
  // The attribute steps sit OUTSIDE the missing-earn branch precisely so this
  // works: an order whose earn landed and whose clawback did not — a crash
  // between the two appends, or an order healed by a build predating that
  // step — must still be put right. The webhook path has no such gate either,
  // since a Shopify redelivery re-runs every step.
  check(clawback.length === 1, `the second sweep clawed back once, got ${clawback.length} adjustments`);
  check(
    (await balanceOf(c13gid)) === 0,
    `a 500-point claim against 50 points leaves nothing: ${await balanceOf(c13gid)}`,
  );

  // And a third sweep over the same order must take nothing further.
  await reconcile('third look, nothing left to do', { ordersSeen: inWindow, entriesAdded: 0 });
  check(
    (await entriesOf(c13gid)).filter((e) => e.reason === 'adjustment').length === 1,
    'repeated sweeps never double-claw',
  );
  step('the sweep repairs its own partial work on an order, and only once');
}

// ---------------------------------------------------------------- phase I
async function phasePaging() {
  const c8 = customerNum();
  const c8gid = customerGid(c8);
  const batch: SeedOrder[] = Array.from({ length: 7 }, () => ({
    num: nextNum(),
    customerNum: c8,
    total: '10.00',
    source: 'web',
    status: 'PAID',
  }));
  await seedAdmin(batch);

  const result = await reconcile('paging', { ordersSeen: inWindow, entriesAdded: 7 });
  credit(c8gid, 70);
  check(
    (result.stubCalls ?? 0) > 1,
    `the sweep actually paged (${result.stubCalls} admin calls for ${inWindow} orders at page size ${PAGE_SIZE})`,
  );
  check((await balanceOf(c8gid)) === 70, 'every order across every page healed (balance 70)');
  check((await entriesOf(c8gid)).length === 7, 'seven healed entries, one per order');
  step(`paged ${inWindow} orders in ${result.stubCalls} admin calls`);
}

// ---------------------------------------------------------------- phase J
async function phaseWindow() {
  // The job asks for `updated_at:>=` the last checkpoint minus an overlap, so
  // history older than the window is out of scope by design — worth asserting
  // rather than assuming, because a sweep that re-read everything every hour
  // would be the version that falls over on a real store.
  const c9 = customerNum();
  const c9gid = customerGid(c9);
  expected.set(c9gid, 0);
  const stale = {
    num: nextNum(),
    customerNum: c9,
    total: '99.00',
    source: 'web',
    status: 'PAID',
    updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
  await seedAdmin([stale], { stale: true });

  const result = await reconcile('stale order', { ordersSeen: inWindow, entriesAdded: 0 });
  check(typeof result.sinceBefore === 'string', `the window has a start after earlier runs: ${result.sinceBefore}`);
  check((await balanceOf(c9gid)) === 0, 'an order updated before the window is not even seen');
  step('the since-window is honoured: a 30-day-old order is out of scope');
}

// ---------------------------------------------------------------- phase K
async function phaseRunRecording() {
  // What the merchant dashboard reads. "This app checks itself, and here is
  // when it last did" is the product claim; an unreported run is a broken one.
  const ok = await api('/api/overview');
  const recon = ok.body['reconciliation'] as
    | { finishedAt: string | null; ordersSeen: number; entriesAdded: number; error: string | null }
    | null;
  if (check(!!recon, 'overview reports a reconciliation run')) {
    const age = Date.now() - Date.parse(recon?.finishedAt ?? '');
    check(
      Number.isFinite(age) && age >= 0 && age < 120_000,
      `overview finishedAt is this run's (${recon?.finishedAt})`,
    );
    check(recon?.ordersSeen === inWindow, `overview ordersSeen ${recon?.ordersSeen} vs ${inWindow}`);
    check(recon?.entriesAdded === 0, `overview entriesAdded ${recon?.entriesAdded} vs 0`);
    check(recon?.error === null, `overview error ${JSON.stringify(recon?.error)}`);
  }

  // A failing Admin API: the run must be recorded as failed AND leave the
  // window alone, or the dropped orders in that slice are lost for good.
  const throttled = 'Throttled by the dev stub';
  await dev('/admin-orders', { failWith: throttled });
  const failed = await reconcile('throttled admin api', { fails: throttled });
  const afterFailure = (await api('/api/overview')).body['reconciliation'] as { error: string | null } | null;
  check(
    typeof afterFailure?.error === 'string' && afterFailure.error.includes(throttled),
    `overview surfaces the failure: ${JSON.stringify(afterFailure?.error)}`,
  );

  // The retried window must still heal what it was going to heal.
  await dev('/admin-orders', { failWith: null });
  const c10 = customerNum();
  const c10gid = customerGid(c10);
  await seedAdmin([{ num: nextNum(), customerNum: c10, total: '15.00', source: 'web', status: 'PAID' }]);
  const retried = await reconcile('retry after failure', { ordersSeen: inWindow, entriesAdded: 1 });
  credit(c10gid, 15);
  check(
    retried.sinceBefore === failed.sinceAfter,
    `the retry re-read the failed run's window (${failed.sinceAfter} -> ${retried.sinceBefore})`,
  );
  check(
    typeof retried.sinceAfter === 'string' && retried.sinceAfter > (retried.sinceBefore ?? ''),
    `a successful run advances the window (${retried.sinceBefore} -> ${retried.sinceAfter})`,
  );
  check((await balanceOf(c10gid)) === 15, 'the order seeded around the failure healed on the retry');
  const healedOverview = (await api('/api/overview')).body['reconciliation'] as
    | { ordersSeen: number; entriesAdded: number; error: string | null }
    | null;
  check(healedOverview?.error === null, 'overview clears the error after a good run');
  check(healedOverview?.entriesAdded === 1, `overview entriesAdded after the retry: ${healedOverview?.entriesAdded}`);
  step('runs are recorded, failures are visible, and a failed window is retried');
}

// ---------------------------------------------------------------- verify
async function phaseVerify() {
  await assertBalances('final');

  const all = await shopEntries();
  const corrections = all.filter((e) => e.reason === 'reconciliation');
  check(corrections.length === 14, `reconciliation corrections in the ledger: ${corrections.length} vs 14`);
  check(
    corrections.every((e) => e.idempotencyKey === `order_paid:${e.orderId}`),
    `every correction carries the canonical key: ${JSON.stringify(
      corrections.filter((e) => e.idempotencyKey !== `order_paid:${e.orderId}`).map((e) => e.idempotencyKey),
    )}`,
  );
  check(
    corrections.every((e) => !e.idempotencyKey.startsWith('reconcile:')),
    'no correction uses the superseded reconcile: key format',
  );
  check(
    corrections.every((e) => e.delta > 0 && !!e.orderId),
    'every correction is a positive earn carrying its order id',
  );
  check(
    corrections.every((e) => ['web', 'pos', 'mobile_app', 'other'].includes(e.sourceName)),
    `every correction is channel-tagged from the order: ${JSON.stringify([...new Set(corrections.map((e) => e.sourceName))])}`,
  );

  // The append-only invariant, from outside: the ledger's own rows must still
  // sum to every balance the API reports.
  const summed = new Map<string, number>();
  for (const e of all) summed.set(e.customerId, (summed.get(e.customerId) ?? 0) + e.delta);
  for (const [gid, points] of expected) {
    check((summed.get(gid) ?? 0) === points, `entries for ${gid} sum to ${summed.get(gid) ?? 0}, expected ${points}`);
  }
  check(all.every((e) => e.delta !== 0), 'no zero-delta rows');
  step(`verified ${all.length} ledger rows across ${expected.size} customers`);
}

// ---------------------------------------------------------------- run
step(`driving reconciliation for ${SHOP} at ${BASE}`);
const health = await fetch(`${BASE}/healthz`).catch(() => undefined);
if (!health?.ok) {
  console.error(`no backend at ${BASE} — start one with DEV_HARNESS=1 DEV_ADMIN_STUB=1 first`);
  process.exit(1);
}
await phaseReset();
await phaseDroppedEarn();
await phaseNoDoubleCounting();
await phaseMissingRefund();
await phaseSkipped();
await phaseFinancialStatus();
await phaseClawbackParity();
await phaseDroppedReferral();
await phaseSelfRepair();
await phasePaging();
await phaseWindow();
await phaseRunRecording();
await phaseVerify();

console.log(`\norders in Shopify's history: ${seeded.size}  in-window: ${inWindow}  customers: ${expected.size}`);
console.log(`elapsed: ${elapsed()}`);
if (findings.length) {
  console.log(`\nFINDINGS (${findings.length}) — not oracle divergences, but worth attention:`);
  for (const f of findings) console.log(' * ' + f);
}
if (failures.length) {
  console.error(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('\nRECONCILIATION E2E: ALL CHECKS PASSED');
