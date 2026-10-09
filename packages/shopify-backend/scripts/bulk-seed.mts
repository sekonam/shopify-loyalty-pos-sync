/**
 * High-volume seed + full-roadmap verification against a RUNNING backend.
 *
 * Unlike `e2e-seed.mts` (which proves the v1 invariants on a few hundred
 * orders under default settings), this script seeds a store-sized dataset
 * with every v1.x/v2 feature switched ON at once — channel earn-rate
 * overrides, excluded sources, three VIP tiers, referrals — and mirrors the
 * whole earn policy in an independent oracle that does its own exact integer
 * arithmetic (no import from @loyalty/ledger, deliberately: the oracle must
 * be able to disagree with the code it is checking).
 *
 * Determinism at volume comes from sharding: one customer's events are
 * executed strictly in order, while many customers run concurrently. Tier
 * thresholds and balance caps are therefore exactly predictable per customer
 * without serialising the whole run.
 *
 *   DATABASE_URL=... SHOPIFY_API_KEY=test-client-id SHOPIFY_API_SECRET=test-secret \
 *     PORT=35800 DEV_HARNESS=1 pnpm --filter @loyalty/shopify-backend start &
 *   npx tsx scripts/bulk-seed.mts
 *
 * Scale knobs: SEED_CUSTOMERS, SEED_ORDERS, SEED_CONCURRENCY.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

const BASE = process.env['E2E_BASE'] ?? 'http://localhost:35800';
const SECRET = process.env['SHOPIFY_API_SECRET'] ?? 'test-secret';
const API_KEY = process.env['SHOPIFY_API_KEY'] ?? 'test-client-id';
const SHOP = process.env['DEV_SHOP'] ?? 'loyalty-e2e.myshopify.com';

const CUSTOMERS = Number(process.env['SEED_CUSTOMERS'] ?? 2000);
const ORDERS = Number(process.env['SEED_ORDERS'] ?? 30000);
const CONCURRENCY = Number(process.env['SEED_CONCURRENCY'] ?? 48);

/** Run-scoped id space, so reruns never collide on a shared dev database. */
const RUN = Date.now() % 100_000_000;

const failures: string[] = [];
/**
 * Things that are not oracle divergences but that a merchant would call a
 * defect — reported separately so a real behavioural surprise at volume is
 * never buried in a pass/fail exit code.
 */
const findings: string[] = [];
const check = (cond: boolean, label: string) => {
  if (!cond && failures.length < 400) failures.push(label);
  return cond;
};
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const step = (msg: string) => console.log(`[${since()}] ${msg}`);

// ---------------------------------------------------------------- program
// The settings this run configures. Rates are ALSO expressed as exact
// fractions for the oracle, so it never touches decimal strings.
type Frac = { n: bigint; d: bigint };
const frac = (n: number, d = 1): Frac => ({ n: BigInt(n), d: BigInt(d) });
const mul = (a: Frac, b: Frac): Frac => ({ n: a.n * b.n, d: a.d * b.d });

const BASE_RATE = frac(1);
const CHANNEL_RATE: Record<string, Frac | null> = {
  web: BASE_RATE,
  pos: frac(2), // channel earn-rate override
  mobile_app: BASE_RATE,
  other: BASE_RATE,
};
const EXCLUDED = ['amazon-marketplace'];
const TIERS = [
  { name: 'Silver', minEarned365: 500, multiplier: '1.5', mult: frac(3, 2) },
  { name: 'Gold', minEarned365: 2000, multiplier: '2', mult: frac(2) },
  { name: 'Platinum', minEarned365: 10000, multiplier: '3', mult: frac(3) },
];
const MIN_REDEMPTION = 100;
const REDEMPTION_RATE = '100';
const REFERRAL = { enabled: true, advocatePoints: 200, friendPoints: 100 };

/** Mirrors ledger/rules.ts normalizeSourceName. */
function channelOf(raw: string): 'web' | 'pos' | 'mobile_app' | 'other' {
  switch (raw.toLowerCase()) {
    case 'web':
      return 'web';
    case 'pos':
      return 'pos';
    case 'iphone':
    case 'android':
    case 'mobile_app':
      return 'mobile_app';
    default:
      return 'other';
  }
}

/** Mirrors ledger/rules.ts selectTier: highest threshold at or below earned365. */
function tierFor(earned365: number) {
  let best: (typeof TIERS)[number] | undefined;
  for (const t of TIERS) {
    if (earned365 >= t.minEarned365 && (!best || t.minEarned365 > best.minEarned365)) best = t;
  }
  return best;
}

/**
 * Mirrors earn-policy.computeOrderEarn + rules.effectiveEarnRate, returning
 * the exact earn in points, or null when the policy skips the order.
 * floor(totalCents/100 * rate) computed on integers only.
 */
function earnFor(totalCents: number, rawSource: string, earned365: number) {
  const raw = rawSource.toLowerCase();
  if (EXCLUDED.includes(raw)) return { skip: `source '${rawSource}' is excluded from earning` };
  const ch = channelOf(rawSource);
  const chRate = CHANNEL_RATE[ch];
  if (chRate === null) return { skip: `earning disabled for channel '${ch}'` };
  const tier = tierFor(earned365);
  const rate = tier ? mul(chRate, tier.mult) : chRate;
  const points = Number((BigInt(totalCents) * rate.n) / (100n * rate.d));
  return { points, rate, tier };
}

/** Mirrors compliance.ts redactedId — the one-way id a redacted row keeps. */
const redactedId = (customerId: string) =>
  `redacted:${createHash('sha256').update(customerId).digest('hex').slice(0, 32)}`;

/** floor(amountCents/100 * rate) — the refund-reversal cap by amount. */
const byAmount = (cents: number, rate: Frac) => Number((BigInt(cents) * rate.n) / (100n * rate.d));

// ---------------------------------------------------------------- http
async function webhook(topic: string, payload: unknown, opts: { webhookId?: string; shop?: string } = {}) {
  const rawBody = JSON.stringify(payload);
  const res = await fetch(`${BASE}/webhooks`, {
    method: 'POST',
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': opts.shop ?? SHOP,
      'x-shopify-webhook-id': opts.webhookId ?? randomUUID(),
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

async function token(kind: 'staff' | 'customer' | 'anonymous', customerId?: string, shop = SHOP) {
  const payload: Record<string, unknown> = { dest: `https://${shop}`, aud: API_KEY, jti: randomUUID() };
  if (kind === 'staff') payload['sub'] = '990001';
  if (kind === 'customer') payload['sub'] = customerId;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(SECRET));
}

// One staff token reused across the run — minting a JWT per call dominated
// the wall clock at this volume.
let staffToken: string | undefined;
const staff = async () => (staffToken ??= await token('staff'));

async function api(
  path: string,
  kind: 'staff' | 'customer' | 'anonymous',
  init: RequestInit = {},
  customerId?: string,
) {
  const t = kind === 'staff' ? await staff() : await token(kind, customerId);
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${t}` },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const postJson = (path: string, kind: 'staff' | 'customer', body: unknown, customerId?: string) =>
  api(path, kind, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, customerId);

const redeem = (
  kind: 'staff' | 'customer',
  customerId: string,
  points: number,
  attemptId = randomUUID(),
) =>
  postJson(
    '/api/redeem',
    kind,
    kind === 'staff'
      ? { customerId, points, attemptId, channel: 'pos', posDeviceId: `till-${points % 7}` }
      : { points, attemptId, channel: 'web' },
    customerId,
  );

// ---------------------------------------------------------------- oracle
interface OrderRec {
  gid: string;
  cents: number;
  rate: Frac;
  earned: number;
  reversed: number;
}
interface Cust {
  idx: number;
  gid: string;
  balance: number;
  earned365: number;
  entries: number;
  orders: OrderRec[];
}
const custs: Cust[] = [];
const cgid = (n: number) => `gid://shopify/Customer/${RUN}${String(n).padStart(5, '0')}`;
let totalEntries = 0;
const tally = { orders: 0, earns: 0, skipped: 0, redeemApplied: 0, redeemRejected: 0, refunds: 0, reversals: 0 };

/** Deterministic PRNG, seeded per customer so each shard is reproducible. */
function prng(seedValue: number) {
  let s = (seedValue * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const SOURCES: Array<[string, number]> = [
  ['web', 0.38],
  ['pos', 0.3],
  ['iphone', 0.09],
  ['android', 0.04],
  ['shopify_draft_order', 0.08],
  ['Amazon-Marketplace', 0.07],
  ['web', 0.04],
];
function pickSource(r: number): string {
  let acc = 0;
  for (const [s, w] of SOURCES) {
    acc += w;
    if (r < acc) return s;
  }
  return 'web';
}

/** Runs `work` over `items` with a bounded pool. */
async function pool<T>(items: T[], limit: number, work: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await work(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

// ------------------------------------------------- phase 1: program config
/**
 * Shop-wide aggregates (entry count, outstanding points, members) can only be
 * asserted exactly against a known starting point. SEED_RESET=1 (the default)
 * erases this tenant first via its own shop/redact path, so the dataset the
 * admin then shows is precisely the one this run verified; SEED_RESET=0 keeps
 * whatever is already there and the aggregates are checked as deltas instead.
 */
let baseline = { entryCount: 0, outstandingPoints: 0, members: 0 };

async function phaseReset() {
  if (process.env['SEED_RESET'] !== '0') {
    const purge = await webhook('shop/redact', { shop_domain: SHOP });
    check(purge === 'shop purged', `reset ${SHOP}: '${purge}'`);
  }
  const ov = await api('/api/overview', 'staff');
  const stats = ov.body['stats'] as Record<string, number>;
  baseline = {
    entryCount: stats['entryCount'] ?? 0,
    outstandingPoints: stats['outstandingPoints'] ?? 0,
    members: stats['members'] ?? 0,
  };
  step(
    process.env['SEED_RESET'] === '0'
      ? `keeping existing data; baseline ${baseline.entryCount} entries`
      : `tenant reset; baseline ${baseline.entryCount} entries`,
  );
}

async function phaseConfigure() {
  const put = await api('/api/settings', 'staff', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      earnRate: '1',
      redemptionRate: REDEMPTION_RATE,
      minRedemption: MIN_REDEMPTION,
      channelRules: {
        web: { enabled: true },
        pos: { enabled: true, earnRate: '2' },
        mobile_app: { enabled: true },
        other: { enabled: true },
      },
      excludedSources: EXCLUDED,
      tiers: TIERS.map((t) => ({ name: t.name, minEarned365: t.minEarned365, multiplier: t.multiplier })),
      referral: REFERRAL,
    }),
  });
  check(put.status === 200, `settings PUT ${put.status}`);

  // Round-trip: what the admin reads back must be what was written.
  const got = await api('/api/settings', 'staff');
  const s = got.body;
  check(String(s?.['earnRate']) === '1', `earnRate round-trip: ${s?.['earnRate']}`);
  check(String(s?.['redemptionRate']) === '100', `redemptionRate round-trip: ${s?.['redemptionRate']}`);
  check(Number(s?.['minRedemption']) === 100, `minRedemption round-trip: ${s?.['minRedemption']}`);
  check(
    (s?.['tiers'] as unknown[])?.length === 3,
    `tiers round-trip: ${JSON.stringify(s?.['tiers'])}`,
  );
  check(
    (s?.['excludedSources'] as string[])?.[0] === 'amazon-marketplace',
    `excludedSources round-trip: ${JSON.stringify(s?.['excludedSources'])}`,
  );
  check(
    (s?.['referral'] as { enabled?: boolean })?.enabled === true,
    `referral round-trip: ${JSON.stringify(s?.['referral'])}`,
  );
  check(
    (s?.['channelRules'] as Record<string, { earnRate?: string }>)?.['pos']?.earnRate === '2',
    `channelRules round-trip: ${JSON.stringify(s?.['channelRules'])}`,
  );
}

// ---------------------------- phase 2: the bulk timeline, sharded per customer
let orderSeq = 0;
const nextOrderId = () => `${RUN}${String(orderSeq++).padStart(7, '0')}`;

async function phaseBulk() {
  for (let i = 0; i < CUSTOMERS; i++) {
    custs.push({ idx: i, gid: cgid(i), balance: 0, earned365: 0, entries: 0, orders: [] });
  }
  // A long tail: a few customers carry many orders, most carry a handful —
  // that shape is what makes tier thresholds actually get crossed.
  const perCustomer: number[] = custs.map((_, i) => {
    const r = prng(1000 + i)();
    return r < 0.02 ? 120 : r < 0.1 ? 40 : r < 0.4 ? 14 : 5;
  });
  const scale = ORDERS / perCustomer.reduce((a, b) => a + b, 0);
  perCustomer.forEach((n, i) => (perCustomer[i] = Math.max(1, Math.round(n * scale))));

  await pool(custs, CONCURRENCY, async (cust) => {
    const rand = prng(7_000_000 + cust.idx);
    const n = perCustomer[cust.idx]!;
    for (let k = 0; k < n; k++) {
      const cents = Math.floor(rand() * 48_000) + 150;
      const src = pickSource(rand());
      const isTest = rand() < 0.03;
      const noCustomer = rand() < 0.02;
      const oid = nextOrderId();
      const payload: Record<string, unknown> = {
        id: Number(oid),
        admin_graphql_api_id: `gid://shopify/Order/${oid}`,
        source_name: src,
        test: isTest,
        total_price: (cents / 100).toFixed(2),
        currency: 'USD',
        customer: noCustomer ? null : { id: 1, admin_graphql_api_id: cust.gid },
      };
      const action = await webhook('orders/paid', payload);
      tally.orders++;

      if (isTest) {
        check(action === 'skipped test order', `test order: '${action}'`);
        continue;
      }
      if (noCustomer) {
        check(action === 'skipped order without customer', `no-customer order: '${action}'`);
        continue;
      }
      const policy = earnFor(cents, src, cust.earned365);
      if ('skip' in policy) {
        check(action === `no earn: ${policy.skip}`, `skip order: '${action}' want 'no earn: ${policy.skip}'`);
        tally.skipped++;
        continue;
      }
      const want =
        policy.points <= 0
          ? 'order earned zero points'
          : `earned ${policy.points}${policy.tier ? ` (${policy.tier.name})` : ''}`;
      check(action === want, `earn order ${oid} (${src}, ${cents}c, e365=${cust.earned365}): '${action}' want '${want}'`);
      if (policy.points > 0) {
        cust.balance += policy.points;
        cust.earned365 += policy.points;
        cust.entries++;
        totalEntries++;
        tally.earns++;
        cust.orders.push({
          gid: `gid://shopify/Order/${oid}`,
          cents,
          rate: policy.rate,
          earned: policy.points,
          reversed: 0,
        });
      }

      // Interleave redemptions into the same sequential timeline, so the
      // expected balance at the moment of each redeem is exact.
      if (rand() < 0.22) {
        const roll = rand();
        const points =
          roll < 0.15
            ? 50 // below the minimum
            : roll < 0.35
              ? cust.balance + 1000 // insufficient
              : Math.max(100, Math.floor(cust.balance * rand() * 0.6));
        const kind = rand() < 0.5 ? 'staff' : 'customer';
        const { status, body } = await redeem(kind, cust.gid, points);
        const ok = points >= MIN_REDEMPTION && points <= cust.balance;
        if (ok) {
          check(
            status === 200 && body['status'] === 'applied',
            `redeem ${points} of ${cust.balance} should apply: ${status} ${String(body['status'])}`,
          );
          cust.balance -= points;
          cust.entries++;
          totalEntries++;
          tally.redeemApplied++;
        } else {
          const wantStatus = points < MIN_REDEMPTION ? 'rejected_below_minimum' : 'rejected_insufficient_balance';
          check(
            status === 409 && body['status'] === wantStatus,
            `redeem ${points} of ${cust.balance} should be ${wantStatus}: ${status} ${String(body['status'])}`,
          );
          tally.redeemRejected++;
        }
      }

      // And refunds, against this customer's own earlier orders.
      if (cust.orders.length > 0 && rand() < 0.18) {
        const target = cust.orders[Math.floor(rand() * cust.orders.length)]!;
        const oversize = rand() < 0.15;
        const refundCents = oversize
          ? target.cents * 3
          : Math.max(50, Math.floor(target.cents * rand()));
        const refundId = `${RUN}9${String(orderSeq++).padStart(7, '0')}`;
        const action2 = await webhook('refunds/create', {
          id: Number(refundId),
          admin_graphql_api_id: `gid://shopify/Refund/${refundId}`,
          order_id: Number(target.gid.split('/').pop()),
          transactions: [{ kind: 'refund', status: 'success', amount: (refundCents / 100).toFixed(2) }],
        });
        tally.refunds++;
        const cap = target.earned - target.reversed;
        const reversible = Math.min(byAmount(refundCents, target.rate), Math.max(cap, 0));
        if (reversible <= 0) {
          check(action2 === 'nothing reversible for this order', `exhausted refund: '${action2}'`);
        } else {
          const applied = Math.min(reversible, Math.max(cust.balance, 0));
          if (applied <= 0) {
            check(
              action2 === 'reversal capped to zero (no positive balance)',
              `zero-balance refund: '${action2}'`,
            );
          } else {
            check(action2 === `reversed ${applied}`, `refund order ${target.gid}: '${action2}' want 'reversed ${applied}'`);
            cust.balance -= applied;
            target.reversed += applied;
            cust.entries++;
            totalEntries++;
            tally.reversals++;
          }
        }
      }
    }
  });
  step(
    `bulk: ${tally.orders} orders (${tally.earns} earned, ${tally.skipped} policy-skipped), ` +
      `${tally.redeemApplied}+${tally.redeemRejected} redemptions, ${tally.refunds} refunds (${tally.reversals} reversals)`,
  );
}

// ------------------------------------------- phase 3: idempotency + ordering
async function phaseIdempotency() {
  const c = custs.find((x) => x.orders.length > 0)!;
  const o = c.orders[0]!;
  const payload = {
    id: Number(o.gid.split('/').pop()),
    admin_graphql_api_id: o.gid,
    source_name: 'web',
    test: false,
    total_price: (o.cents / 100).toFixed(2),
    currency: 'USD',
    customer: { id: 1, admin_graphql_api_id: c.gid },
  };
  const wid = randomUUID();
  await webhook('orders/paid', payload, { webhookId: wid });
  const dup = await webhook('orders/paid', payload, { webhookId: wid });
  check(dup === 'duplicate', `same webhook id → duplicate: '${dup}'`);
  const replay = await webhook('orders/paid', payload);
  check(replay === 'earn already recorded', `order replay → already recorded: '${replay}'`);

  // Redemption attempt retry must not double-debit.
  const r = custs.find((x) => x.balance >= 300);
  if (r) {
    const attemptId = randomUUID();
    const a = await redeem('staff', r.gid, 100, attemptId);
    const b = await redeem('staff', r.gid, 100, attemptId);
    check(a.body['status'] === 'applied' && b.body['status'] === 'applied', `attempt retry: ${String(a.body['status'])}/${String(b.body['status'])}`);
    r.balance -= 100;
    r.entries++;
    totalEntries++;
    check(b.body['balance'] === r.balance, `retry balance ${String(b.body['balance'])} vs oracle ${r.balance}`);
  } else {
    check(false, 'no customer with >=300 points for the retry check');
  }

  // Refund delivered before its order, then redelivered after it lands.
  const late = { idx: -1, gid: cgid(900_001), balance: 0, earned365: 0, entries: 0, orders: [] } as Cust;
  custs.push(late);
  const oid = nextOrderId();
  const rid = `${RUN}8${String(orderSeq++).padStart(7, '0')}`;
  const refundBody = {
    id: Number(rid),
    admin_graphql_api_id: `gid://shopify/Refund/${rid}`,
    order_id: Number(oid),
    transactions: [{ kind: 'refund', status: 'success', amount: '10.00' }],
  };
  const before = await webhook('refunds/create', refundBody);
  check(
    before === 'no earn entry for refunded order (nothing to reverse)',
    `refund before order: '${before}'`,
  );
  const landed = await webhook('orders/paid', {
    id: Number(oid),
    admin_graphql_api_id: `gid://shopify/Order/${oid}`,
    source_name: 'pos',
    test: false,
    total_price: '80.00',
    currency: 'USD',
    customer: { id: 1, admin_graphql_api_id: late.gid },
  });
  check(landed === 'earned 160', `late order earns at the pos 2x rate: '${landed}'`);
  late.balance += 160;
  late.earned365 += 160;
  late.entries++;
  totalEntries++;
  const after = await webhook('refunds/create', refundBody);
  check(after === 'reversed 20', `redelivered refund applies at the order's own rate: '${after}'`);
  late.balance -= 20;
  late.entries++;
  totalEntries++;

  // A refund that moved no money reverses nothing.
  const restock = await webhook('refunds/create', {
    id: Number(`${RUN}8${String(orderSeq++).padStart(7, '0')}`),
    order_id: Number(oid),
    transactions: [],
  });
  check(restock === 'no refunded amount, nothing to reverse', `restock-only refund: '${restock}'`);
}

// -------------------------------------------------- phase 4: the race itself
async function phaseRace() {
  let applied = 0;
  let rejected = 0;
  const racers: Cust[] = [];
  for (let i = 0; i < 40; i++) {
    const c = { idx: -1, gid: cgid(910_000 + i), balance: 0, earned365: 0, entries: 0, orders: [] } as Cust;
    custs.push(c);
    racers.push(c);
  }
  await pool(racers, 20, async (c) => {
    const oid = nextOrderId();
    const a = await webhook('orders/paid', {
      id: Number(oid),
      admin_graphql_api_id: `gid://shopify/Order/${oid}`,
      source_name: 'web',
      test: false,
      total_price: '300.00',
      currency: 'USD',
      customer: { id: 1, admin_graphql_api_id: c.gid },
    });
    check(a === 'earned 300', `race customer earn: '${a}'`);
    c.balance += 300;
    c.earned365 += 300;
    c.entries++;
    totalEntries++;
    // Two tills, same customer, same instant, 200 points each: exactly one
    // must win. This is the double-spend the product exists to prevent.
    const [x, y] = await Promise.all([redeem('staff', c.gid, 200), redeem('staff', c.gid, 200)]);
    const statuses = [String(x.body['status']), String(y.body['status'])].sort();
    check(
      statuses[0] === 'applied' && statuses[1] === 'rejected_insufficient_balance',
      `race outcome for ${c.gid}: ${statuses.join(',')}`,
    );
    c.balance -= 200;
    c.entries++;
    totalEntries++;
    applied += statuses.filter((s) => s === 'applied').length;
    rejected += statuses.filter((s) => s !== 'applied').length;
  });
  step(`race: ${racers.length} simultaneous double-redemptions → ${applied} applied, ${rejected} rejected`);
}

// --------------------------------------- phase 5: forged-discount clawback
async function phaseClawback() {
  const c = { idx: -1, gid: cgid(920_001), balance: 0, earned365: 0, entries: 0, orders: [] } as Cust;
  custs.push(c);
  const o1 = nextOrderId();
  await webhook('orders/paid', {
    id: Number(o1),
    admin_graphql_api_id: `gid://shopify/Order/${o1}`,
    source_name: 'web',
    test: false,
    total_price: '120.00',
    currency: 'USD',
    customer: { id: 1, admin_graphql_api_id: c.gid },
  });
  c.balance += 120;
  c.earned365 += 120;
  c.entries++;
  totalEntries++;

  const o2 = nextOrderId();
  const action = await webhook('orders/paid', {
    id: Number(o2),
    admin_graphql_api_id: `gid://shopify/Order/${o2}`,
    source_name: 'web',
    test: false,
    total_price: '60.00',
    currency: 'USD',
    customer: { id: 1, admin_graphql_api_id: c.gid },
    note_attributes: [
      { name: 'loyalty_discount', value: '5.00' },
      { name: 'loyalty_attempt', value: randomUUID() },
    ],
  });
  c.balance += 60;
  c.earned365 += 60;
  c.entries++;
  totalEntries++;
  const clawable = Math.min(500, c.balance);
  check(
    action === `earned 60; ATTEMPT MISMATCH: clawed back ${clawable}`,
    `forged discount clawback: '${action}'`,
  );
  c.balance -= clawable;
  c.entries++;
  totalEntries++;

  // A discount backed by a real applied attempt is left alone.
  const legit = { idx: -1, gid: cgid(920_002), balance: 0, earned365: 0, entries: 0, orders: [] } as Cust;
  custs.push(legit);
  const o3 = nextOrderId();
  await webhook('orders/paid', {
    id: Number(o3),
    admin_graphql_api_id: `gid://shopify/Order/${o3}`,
    source_name: 'web',
    test: false,
    total_price: '400.00',
    currency: 'USD',
    customer: { id: 1, admin_graphql_api_id: legit.gid },
  });
  legit.balance += 400;
  legit.earned365 += 400;
  legit.entries++;
  totalEntries++;
  const attemptId = randomUUID();
  const r = await redeem('customer', legit.gid, 300, attemptId);
  check(r.body['status'] === 'applied', `legit redemption: ${String(r.body['status'])}`);
  check(r.body['discountAmount'] === '3.00', `300 points at rate 100 → 3.00 off: ${String(r.body['discountAmount'])}`);
  legit.balance -= 300;
  legit.entries++;
  totalEntries++;
  const o4 = nextOrderId();
  const honest = await webhook('orders/paid', {
    id: Number(o4),
    admin_graphql_api_id: `gid://shopify/Order/${o4}`,
    source_name: 'web',
    test: false,
    total_price: '97.00',
    currency: 'USD',
    customer: { id: 1, admin_graphql_api_id: legit.gid },
    note_attributes: [
      { name: 'loyalty_discount', value: '3.00' },
      { name: 'loyalty_attempt', value: attemptId },
    ],
  });
  check(honest === 'earned 97', `honest discount left alone: '${honest}'`);
  legit.balance += 97;
  legit.earned365 += 97;
  legit.entries++;
  totalEntries++;
}

// ------------------------------------------------------ phase 6: referrals
async function phaseReferrals() {
  const mk = (n: number) => {
    const c = { idx: -1, gid: cgid(930_000 + n), balance: 0, earned365: 0, entries: 0, orders: [] } as Cust;
    custs.push(c);
    return c;
  };
  const order = async (c: Cust, total: string, extra: Record<string, unknown> = {}, source = 'web') => {
    const oid = nextOrderId();
    const action = await webhook('orders/paid', {
      id: Number(oid),
      admin_graphql_api_id: `gid://shopify/Order/${oid}`,
      source_name: source,
      test: false,
      total_price: total,
      currency: 'USD',
      customer: { id: 1, admin_graphql_api_id: c.gid },
      ...extra,
    });
    return { action, oid };
  };

  const advocate = mk(1);
  await order(advocate, '40.00');
  advocate.balance += 40;
  advocate.earned365 += 40;
  advocate.entries++;
  totalEntries++;

  const codeRes = await api('/api/referral-code', 'customer', {}, advocate.gid);
  check(codeRes.status === 200 && typeof codeRes.body['code'] === 'string', `referral code: ${codeRes.status}`);
  const code = codeRes.body['code'] as string;
  // Stable per customer.
  const again = await api('/api/referral-code', 'customer', {}, advocate.gid);
  check(again.body['code'] === code, `referral code stable: ${String(again.body['code'])} vs ${code}`);

  // Friend's first order pays both sides.
  const friend = mk(2);
  const first = await order(friend, '60.00', { note_attributes: [{ name: 'loyalty_referral', value: code }] });
  check(
    first.action === 'earned 60; referral rewarded (advocate +200, friend +100)',
    `referral reward: '${first.action}'`,
  );
  friend.balance += 160;
  friend.earned365 += 60;
  friend.entries += 2;
  advocate.balance += 200;
  advocate.entries++;
  totalEntries += 3;

  // The friend's second order does not pay again.
  const second = await order(friend, '30.00', { note_attributes: [{ name: 'loyalty_referral', value: code }] });
  check(second.action === 'earned 30; referral code ignored (not first order)', `repeat referral: '${second.action}'`);
  friend.balance += 30;
  friend.earned365 += 30;
  friend.entries++;
  totalEntries++;

  // Self-referral and unknown codes are refused, not rewarded.
  const selfRef = mk(3);
  const selfCode = (await api('/api/referral-code', 'customer', {}, selfRef.gid)).body['code'] as string;
  const selfOrder = await order(selfRef, '25.00', { note_attributes: [{ name: 'loyalty_referral', value: selfCode }] });
  check(selfOrder.action === 'earned 25; self-referral ignored', `self-referral: '${selfOrder.action}'`);
  selfRef.balance += 25;
  selfRef.earned365 += 25;
  selfRef.entries++;
  totalEntries++;

  const stranger = mk(4);
  const bogus = await order(stranger, '25.00', { note_attributes: [{ name: 'loyalty_referral', value: 'NOPE-NOPE' }] });
  check(bogus.action === 'earned 25; referral code unknown', `unknown code: '${bogus.action}'`);
  stranger.balance += 25;
  stranger.earned365 += 25;
  stranger.entries++;
  totalEntries++;

  // An excluded source must not pay a referral (nor burn the friend's slot).
  const excludedFriend = mk(5);
  const exc = await order(
    excludedFriend,
    '90.00',
    { note_attributes: [{ name: 'loyalty_referral', value: code }] },
    'Amazon-Marketplace',
  );
  check(
    exc.action === "no earn: source 'Amazon-Marketplace' is excluded from earning",
    `referral on excluded source: '${exc.action}'`,
  );

  // Fully refunding the qualifying order claws both rewards back.
  const advocate2 = mk(6);
  await order(advocate2, '40.00');
  advocate2.balance += 40;
  advocate2.earned365 += 40;
  advocate2.entries++;
  totalEntries++;
  const code2 = (await api('/api/referral-code', 'customer', {}, advocate2.gid)).body['code'] as string;
  const friend2 = mk(7);
  const qualifying = await order(friend2, '50.00', { note_attributes: [{ name: 'loyalty_referral', value: code2 }] });
  check(qualifying.action === 'earned 50; referral rewarded (advocate +200, friend +100)', `second referral: '${qualifying.action}'`);
  friend2.balance += 150;
  friend2.earned365 += 50;
  friend2.entries += 2;
  advocate2.balance += 200;
  advocate2.entries++;
  totalEntries += 3;

  const rid = `${RUN}7${String(orderSeq++).padStart(7, '0')}`;
  const clawed = await webhook('refunds/create', {
    id: Number(rid),
    admin_graphql_api_id: `gid://shopify/Refund/${rid}`,
    order_id: Number(qualifying.oid),
    transactions: [{ kind: 'refund', status: 'success', amount: '50.00' }],
  });
  check(
    clawed === 'reversed 50; referral clawed back (advocate -200, friend -100)',
    `referral clawback on full refund: '${clawed}'`,
  );
  friend2.balance -= 150;
  friend2.entries += 2;
  advocate2.balance -= 200;
  advocate2.entries++;
  totalEntries += 3;
}

// -------------------------------------------------------- phase 7: awards
async function phaseAwards() {
  // A giveaway: 400 winners in one batch.
  const winners: Cust[] = [];
  for (let i = 0; i < 400; i++) {
    const c = { idx: -1, gid: cgid(940_000 + i), balance: 0, earned365: 0, entries: 0, orders: [] } as Cust;
    custs.push(c);
    winners.push(c);
  }
  const batchId = randomUUID();
  const res = await postJson('/api/awards', 'staff', {
    batchId,
    awards: winners.map((c, i) => ({ customerId: c.gid, points: 250 + (i % 5) * 50 })),
  });
  check(res.status === 200, `awards batch: ${res.status}`);
  winners.forEach((c, i) => {
    c.balance += 250 + (i % 5) * 50;
    c.entries++;
    totalEntries++;
  });

  // Replaying the batch returns the original outcome and writes nothing new.
  const replay = await postJson('/api/awards', 'staff', {
    batchId,
    awards: winners.map((c, i) => ({ customerId: c.gid, points: 250 + (i % 5) * 50 })),
  });
  check(replay.body['replayed'] === true, `award batch replay flagged: ${JSON.stringify(replay.body['replayed'])}`);

  // A deduction can never take a balance below zero.
  const target = winners[0]!;
  const deduct = await postJson('/api/awards', 'staff', {
    batchId: randomUUID(),
    awards: [{ customerId: target.gid, points: -(target.balance + 5000) }],
  });
  const applied = (deduct.body['results'] as Array<{ applied: number }>)[0]!.applied;
  check(applied === -target.balance, `capped deduction: ${applied} want ${-target.balance}`);
  target.balance = 0;
  target.entries++;
  totalEntries++;

  // A deduction against a zero balance writes no row at all.
  const noop = await postJson('/api/awards', 'staff', {
    batchId: randomUUID(),
    awards: [{ customerId: target.gid, points: -100 }],
  });
  check(
    (noop.body['results'] as Array<{ applied: number }>)[0]!.applied === 0,
    `zero-balance deduction applies nothing: ${JSON.stringify(noop.body['results'])}`,
  );

  // Malformed batches are refused.
  const bad = await postJson('/api/awards', 'staff', { batchId: randomUUID(), awards: [{ customerId: 'nope', points: 5 }] });
  check(bad.status === 400, `malformed award rejected: ${bad.status}`);
  const zero = await postJson('/api/awards', 'staff', { batchId: randomUUID(), awards: [{ customerId: target.gid, points: 0 }] });
  check(zero.status === 400, `zero-point award rejected: ${zero.status}`);
  step(`awards: 400-winner giveaway + replay + capped deduction`);
}

// ------------------------------------------------- phase 8: auth boundaries
async function phaseAuth() {
  const victim = custs[0]!.gid;
  const other = custs[1]!.gid;
  const cases: Array<[string, Promise<{ status: number }>, number]> = [
    ['anonymous balance', api('/api/balance', 'anonymous'), 403],
    ['customer reads settings', api('/api/settings', 'customer', {}, victim), 403],
    ['customer writes settings', api('/api/settings', 'customer', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"earnRate":"99"}' }, victim), 403],
    ['customer reads another customer', api(`/api/balance?customerId=${encodeURIComponent(other)}`, 'customer', {}, victim), 403],
    ['customer reads overview', api('/api/overview', 'customer', {}, victim), 403],
    ['customer reads entries', api('/api/entries', 'customer', {}, victim), 403],
    ['customer awards points', postJson('/api/awards', 'customer', { batchId: randomUUID(), awards: [{ customerId: victim, points: 10_000 }] }, victim), 403],
    ['anonymous referral code', api('/api/referral-code', 'anonymous'), 403],
  ];
  for (const [label, p, want] of cases) {
    const { status } = await p;
    check(status === want, `${label} → ${want}, got ${status}`);
  }
  // Channel/identity pairing.
  const webByStaff = await postJson('/api/redeem', 'staff', { customerId: victim, points: 100, attemptId: randomUUID(), channel: 'web' });
  check(webByStaff.status === 403, `web redemption by staff → 403, got ${webByStaff.status}`);
  const posByCustomer = await postJson('/api/redeem', 'customer', { points: 100, attemptId: randomUUID(), channel: 'pos' }, victim);
  check(posByCustomer.status === 403, `pos redemption by customer → 403, got ${posByCustomer.status}`);
  // Malformed redemptions.
  const badAttempt = await postJson('/api/redeem', 'staff', { customerId: victim, points: 100, attemptId: 'not-a-uuid', channel: 'pos' });
  check(badAttempt.status === 400, `non-uuid attemptId → 400, got ${badAttempt.status}`);
  const badChannel = await postJson('/api/redeem', 'staff', { customerId: victim, points: 100, attemptId: randomUUID(), channel: 'mail_order' });
  check(badChannel.status === 400, `unknown channel → 400, got ${badChannel.status}`);
  const fractional = await postJson('/api/redeem', 'staff', { customerId: victim, points: 10.5, attemptId: randomUUID(), channel: 'pos' });
  check(fractional.status === 400, `fractional points → 400, got ${fractional.status}`);
  // No token at all.
  const unauthed = await fetch(`${BASE}/api/overview`);
  check(unauthed.status === 401, `no token → 401, got ${unauthed.status}`);
  const badToken = await fetch(`${BASE}/api/overview`, { headers: { authorization: 'Bearer garbage' } });
  check(badToken.status === 401, `garbage token → 401, got ${badToken.status}`);
  // A token minted for a different shop must not read this one's ledger.
  const foreign = await fetch(`${BASE}/api/overview`, {
    headers: { authorization: `Bearer ${await token('staff', undefined, 'someone-else.myshopify.com')}` },
  });
  check(foreign.status === 200, `foreign-shop token is scoped, not rejected: ${foreign.status}`);
  const foreignBody = (await foreign.json()) as { shopDomain?: string; stats?: { entryCount?: number } };
  check(
    foreignBody.shopDomain === 'someone-else.myshopify.com' && foreignBody.stats?.entryCount === 0,
    `foreign shop sees its own empty ledger: ${JSON.stringify(foreignBody.stats)}`,
  );
  step('auth: 16 boundary cases');
}

// ----------------------------------------------- phase 9: GDPR compliance
async function phaseCompliance() {
  const c = { idx: -1, gid: cgid(950_001), balance: 0, earned365: 0, entries: 0, orders: [] } as Cust;
  const numericId = `${RUN}950001`;
  const oid = nextOrderId();
  await webhook('orders/paid', {
    id: Number(oid),
    admin_graphql_api_id: `gid://shopify/Order/${oid}`,
    source_name: 'web',
    test: false,
    total_price: '75.00',
    currency: 'USD',
    customer: { id: Number(numericId), admin_graphql_api_id: `gid://shopify/Customer/${numericId}` },
  });

  const dataReq = await webhook('customers/data_request', { customer: { id: Number(numericId) } });
  check(dataReq === 'data request acknowledged', `customers/data_request: '${dataReq}'`);

  const before = await api(`/api/balance?customerId=${encodeURIComponent(`gid://shopify/Customer/${numericId}`)}`, 'staff');
  check(before.body['balance'] === 75, `pre-redact balance: ${String(before.body['balance'])}`);

  const redact = await webhook('customers/redact', { customer: { id: Number(numericId) } });
  check(redact === 'customer redacted', `customers/redact: '${redact}'`);
  const after = await api(`/api/balance?customerId=${encodeURIComponent(`gid://shopify/Customer/${numericId}`)}`, 'staff');
  check(after.body['balance'] === 0, `redacted customer's id holds no balance: ${String(after.body['balance'])}`);
  // The accounting row is retained under a one-way pseudonym: the points are
  // still on the books, the person is no longer identifiable from them.
  const pseudonym = redactedId(`gid://shopify/Customer/${numericId}`);
  const kept = await api(`/api/balance?customerId=${encodeURIComponent(pseudonym)}`, 'staff');
  check(kept.body['balance'] === 75, `redacted row kept its 75 points under the pseudonym: ${String(kept.body['balance'])}`);
  c.gid = pseudonym;
  c.balance = 75;
  c.earned365 = 75;
  c.entries = 1;
  custs.push(c);
  totalEntries++;

  // shop/redact on a THROWAWAY tenant — it is irreversible erasure, and the
  // seeded shop must survive this run.
  const victimShop = `redact-me-${RUN}.myshopify.com`;
  const vOid = nextOrderId();
  await webhook(
    'orders/paid',
    {
      id: Number(vOid),
      admin_graphql_api_id: `gid://shopify/Order/${vOid}`,
      source_name: 'pos',
      test: false,
      total_price: '200.00',
      currency: 'USD',
      customer: { id: 1, admin_graphql_api_id: cgid(960_001) },
    },
    { shop: victimShop },
  );
  const vTok = await token('staff', undefined, victimShop);
  const vBefore = await (await fetch(`${BASE}/api/overview`, { headers: { authorization: `Bearer ${vTok}` } })).json() as { stats?: { entryCount?: number } };
  check(vBefore.stats?.entryCount === 1, `throwaway tenant has 1 entry: ${JSON.stringify(vBefore.stats)}`);
  const purge = await webhook('shop/redact', { shop_domain: victimShop }, { shop: victimShop });
  check(purge === 'shop purged', `shop/redact: '${purge}'`);
  const vAfter = await (await fetch(`${BASE}/api/overview`, { headers: { authorization: `Bearer ${vTok}` } })).json() as { stats?: { entryCount?: number } };
  check(vAfter.stats?.entryCount === 0, `throwaway tenant erased: ${JSON.stringify(vAfter.stats)}`);

  // app/uninstalled on another throwaway tenant.
  const uninstallShop = `uninstall-me-${RUN}.myshopify.com`;
  const un = await webhook('app/uninstalled', { domain: uninstallShop }, { shop: uninstallShop });
  check(un === 'marked uninstalled', `app/uninstalled: '${un}'`);

  // Unknown topic and bad HMAC.
  const unknown = await webhook('orders/cancelled', { id: 1 });
  check(unknown === 'reason:unhandled topic orders/cancelled', `unknown topic acked: '${unknown}'`);
  const forged = await fetch(`${BASE}/webhooks`, {
    method: 'POST',
    body: '{"id":1,"total_price":"5.00"}',
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': 'orders/paid',
      'x-shopify-shop-domain': SHOP,
      'x-shopify-webhook-id': randomUUID(),
      'x-shopify-hmac-sha256': 'ZGVmaW5pdGVseS1ub3QtdmFsaWQ=',
    },
  });
  check(forged.status === 401, `forged HMAC → 401, got ${forged.status}`);
  step('compliance: data_request, customers/redact, shop/redact, app/uninstalled, HMAC');
}

// ------------------------------------------------------- phase 10: verify
async function phaseVerify() {
  // Every balance, against the oracle.
  let worst = '';
  let divergences = 0;
  await pool(custs, CONCURRENCY, async (c) => {
    const { status, body } = await api(`/api/balance?customerId=${encodeURIComponent(c.gid)}`, 'staff');
    if (status !== 200) {
      check(false, `balance HTTP ${status} for ${c.gid}`);
      return;
    }
    if (body['balance'] !== c.balance) {
      divergences++;
      if (!worst) worst = `${c.gid}: server ${String(body['balance'])} vs oracle ${c.balance}`;
      check(false, `BALANCE DIVERGENCE ${c.gid}: server ${String(body['balance'])} vs oracle ${c.balance}`);
    }
    if (Number(body['balance']) < 0) check(false, `negative balance for ${c.gid}: ${String(body['balance'])}`);
    if (body['earned365'] !== c.earned365) {
      check(false, `EARNED365 MISMATCH ${c.gid}: server ${String(body['earned365'])} vs oracle ${c.earned365}`);
    }
    // The tier the API reports must be the tier the oracle's earn history implies.
    const wantTier = tierFor(c.earned365)?.name ?? '';
    // With tiers configured the API always answers a tier object; an empty
    // name is its way of saying "qualifies for none yet".
    const gotTier = (body['tier'] as { name?: string } | null)?.name ?? '';
    if (wantTier !== gotTier) {
      check(false, `TIER MISMATCH ${c.gid}: server '${gotTier}' vs oracle '${wantTier}' (earned365=${c.earned365})`);
    }
  });
  step(`verified ${custs.length} balances + tiers (${divergences} divergences)${worst ? ` first: ${worst}` : ''}`);

  // Shop-wide aggregates.
  const ov = await api('/api/overview', 'staff');
  const stats = ov.body['stats'] as Record<string, number>;
  const oracleOutstanding = custs.reduce((a, c) => a + c.balance, 0);
  const oracleMembers = custs.filter((c) => c.balance > 0).length;
  check(
    stats['entryCount']! - baseline.entryCount === totalEntries,
    `entryCount: server +${stats['entryCount']! - baseline.entryCount} vs oracle ${totalEntries}`,
  );
  check(
    stats['outstandingPoints']! - baseline.outstandingPoints === oracleOutstanding,
    `outstandingPoints: server +${stats['outstandingPoints']! - baseline.outstandingPoints} vs oracle ${oracleOutstanding}`,
  );
  check(
    stats['members']! - baseline.members === oracleMembers,
    `members: server +${stats['members']! - baseline.members} vs oracle ${oracleMembers}`,
  );
  // Everything in this run landed inside the 30-day stats window.
  const oracleIssued = custs.reduce((a, c) => a + c.orders.reduce((x, o) => x + o.earned, 0), 0);
  check(stats['issuedInWindow']! >= oracleIssued, `issuedInWindow ${stats['issuedInWindow']} >= purchase earns ${oracleIssued}`);
  check(
    stats['outstandingPoints'] === stats['issuedInWindow']! - stats['redeemedInWindow']!,
    `outstanding == issued - redeemed: ${stats['outstandingPoints']} vs ${stats['issuedInWindow']! - stats['redeemedInWindow']!}`,
  );
  check(
    (ov.body['outstandingValue'] as string) === (stats['outstandingPoints']! / 100).toFixed(2),
    `outstandingValue at rate 100: ${String(ov.body['outstandingValue'])} vs ${(stats['outstandingPoints']! / 100).toFixed(2)}`,
  );
  const program = ov.body['program'] as Record<string, unknown>;
  check(program['tiers'] === 3, `overview reports 3 tiers: ${String(program['tiers'])}`);
  check(program['referralEnabled'] === true, `overview reports referrals on: ${String(program['referralEnabled'])}`);
  check(program['excludedSources'] === 1, `overview reports 1 excluded source: ${String(program['excludedSources'])}`);
  check(ov.body['currency'] === 'USD', `currency learned from the first order: ${String(ov.body['currency'])}`);
  check(ov.body['reconciliation'] === null, `reconciliation never ran (no Admin token): ${JSON.stringify(ov.body['reconciliation'])}`);

  // Per-customer entry view.
  const sample = custs.filter((c) => c.entries > 0).slice(0, 25);
  for (const c of sample) {
    const { body } = await api(`/api/entries?customerId=${encodeURIComponent(c.gid)}`, 'staff');
    const rows = body['entries'] as Array<{ delta: number; sourceName: string; reason: string }>;
    check(rows.length === c.entries, `entry count for ${c.gid}: ${rows.length} vs ${c.entries}`);
    check(rows.reduce((a, r) => a + r.delta, 0) === c.balance, `entries sum to balance for ${c.gid}`);
    check(
      rows.every((r) => ['web', 'pos', 'mobile_app', 'other', 'system'].includes(r.sourceName)),
      `every entry is channel-tagged for ${c.gid}: ${JSON.stringify(rows.map((r) => r.sourceName))}`,
    );
  }
  step(`entry views verified for ${sample.length} customers`);

  // CSV export: header, row count, and that filters actually narrow it.
  const csvRes = await fetch(`${BASE}/api/ledger.csv`, { headers: { authorization: `Bearer ${await staff()}` } });
  const csv = await csvRes.text();
  const lines = csv.trim().split('\n');
  check(
    lines[0] === 'id,customer_id,order_id,refund_id,source_name,delta,reason,created_at',
    `csv header: ${lines[0]}`,
  );
  const csvRows = lines.length - 1;
  const shopEntries = stats['entryCount']!;
  // entriesForShop defaults to 10_000 and /api/ledger.csv passes no limit, so
  // the export is the 10k MOST RECENT entries. Below that cap the export must
  // be complete and must match the oracle exactly.
  if (shopEntries <= 10_000) {
    const mine = new Set(custs.map((c) => c.gid));
    const runRows = lines.slice(1).filter((l) => mine.has(l.split(',')[1] ?? '')).length;
    check(runRows === totalEntries, `csv rows for this run: ${runRows} vs ${totalEntries}`);
  } else {
    check(csvRows === 10_000, `csv capped at 10000 rows, got ${csvRows} of ${shopEntries}`);
    findings.push(
      `CSV export returns only the 10,000 most recent of ${shopEntries} ledger entries ` +
        `(entriesForShop's default limit; /api/ledger.csv passes none). Nothing in the file or ` +
        `the admin says the export is partial — a merchant reconciling a full year would not know.`,
    );
  }
  check(
    csvRes.headers.get('content-disposition')?.includes('points-ledger.csv') === true,
    `csv filename: ${csvRes.headers.get('content-disposition')}`,
  );
  for (const [reason, channel] of [['earn', ''], ['redeem', ''], ['refund_reversal', ''], ['', 'pos'], ['', 'web'], ['earn', 'pos']] as const) {
    const q = new URLSearchParams();
    if (reason) q.set('reason', reason);
    if (channel) q.set('channel', channel);
    const r = await fetch(`${BASE}/api/ledger.csv?${q}`, { headers: { authorization: `Bearer ${await staff()}` } });
    const rows = (await r.text()).trim().split('\n').slice(1).filter(Boolean);
    check(rows.length > 0, `filtered csv (${reason || '*'}/${channel || '*'}) returned rows`);
    check(
      rows.every((l) => {
        const cols = l.split(',');
        return (!reason || cols[6] === reason) && (!channel || cols[4] === channel);
      }),
      `filtered csv (${reason || '*'}/${channel || '*'}) respects the filter`,
    );
    check(rows.length < csvRows, `filtered csv (${reason || '*'}/${channel || '*'}) is narrower than the whole ledger`);
  }
  step(`csv: ${csvRows} rows + 6 filter combinations`);

  // The ledger-wide invariants, asserted over the whole table via the API's
  // own 10k-row window plus the aggregate checks above.
  const all = await api('/api/entries?limit=10000', 'staff');
  const rows = all.body['entries'] as Array<{ delta: number; reason: string; sourceName: string; orderId?: string }>;
  check(
    rows.length === Math.min(10_000, stats['entryCount']!),
    `entries window: ${rows.length} vs min(10000, ${stats['entryCount']})`,
  );
  check(rows.every((r) => Number.isInteger(r.delta) && r.delta !== 0), 'no zero-delta rows');
  check(
    rows.every((r) => ['earn', 'redeem', 'refund_reversal', 'adjustment', 'referral_reward', 'reconciliation'].includes(r.reason)),
    `reasons are all known: ${JSON.stringify([...new Set(rows.map((r) => r.reason))])}`,
  );
  check(
    rows.filter((r) => r.reason === 'earn').every((r) => r.delta > 0 && !!r.orderId),
    'every earn is positive and carries its order id',
  );
  check(
    rows.filter((r) => r.reason === 'refund_reversal').every((r) => r.delta < 0 && !!r.orderId),
    'every reversal is negative and carries its order id',
  );
  check(rows.filter((r) => r.reason === 'redeem').every((r) => r.delta < 0), 'every redemption is negative');
  const channels = [...new Set(rows.map((r) => r.sourceName))].sort();
  check(channels.length >= 4, `channels present in the ledger: ${channels.join(',')}`);
  step(`ledger invariants over ${rows.length} rows; channels: ${channels.join(', ')}`);
}

// ---------------------------------------------------------------- run
step(`seeding ${CUSTOMERS} customers / ~${ORDERS} orders into ${SHOP} (run ${RUN})`);
await phaseReset();
await phaseConfigure();
step('program configured (channel rates, exclusions, 3 tiers, referrals)');
await phaseBulk();
await phaseIdempotency();
step('idempotency + out-of-order delivery');
await phaseRace();
await phaseClawback();
step('forged-discount clawback');
await phaseReferrals();
step('referrals: reward, repeat-block, self, unknown, excluded, clawback');
await phaseAwards();
await phaseAuth();
await phaseCompliance();
await phaseVerify();

const outstanding = custs.reduce((a, c) => a + c.balance, 0);
console.log(
  `\ncustomers: ${custs.length}  ledger entries: ${totalEntries}  outstanding points: ${outstanding} ` +
    `(worth ${(outstanding / 100).toFixed(2)} USD at rate ${REDEMPTION_RATE})`,
);
console.log(`elapsed: ${since()}`);
if (findings.length) {
  console.log(`\nFINDINGS (${findings.length}) — not oracle divergences, but worth a merchant's attention:`);
  for (const f of findings) console.log(' * ' + f);
}
if (failures.length) {
  console.error(`\nFAILURES (${failures.length}${failures.length >= 400 ? '+, truncated' : ''}):`);
  for (const f of failures.slice(0, 60)) console.error(' - ' + f);
  process.exit(1);
}
console.log('\nBULK SEED + VERIFY: ALL CHECKS PASSED');
