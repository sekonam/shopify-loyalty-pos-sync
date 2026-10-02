/**
 * v1.x/v2 end-to-end verification over real HTTP against a running backend:
 * channel rules, excluded sources, VIP tiers, referrals, awards.
 * Uses fresh customer ids per run (timestamp-based) so reruns stay clean.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

const BASE = process.env['E2E_BASE'] ?? 'http://localhost:35800';
const SECRET = process.env['SHOPIFY_API_SECRET'] ?? 'test-secret';
const API_KEY = process.env['SHOPIFY_API_KEY'] ?? 'test-client-id';
const SHOP = process.env['DEV_SHOP'] ?? 'loyalty-e2e.myshopify.com';

const failures: string[] = [];
const check = (cond: boolean, label: string) => {
  if (!cond) failures.push(label);
};

const run = Date.now() % 1_000_000;
const CID = (n: number) => `gid://shopify/Customer/${run}${n}`;
let orderSeq = run * 10;

async function webhook(payload: Record<string, unknown>): Promise<string> {
  const rawBody = JSON.stringify(payload);
  const res = await fetch(`${BASE}/webhooks`, {
    method: 'POST',
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': 'orders/paid',
      'x-shopify-shop-domain': SHOP,
      'x-shopify-webhook-id': randomUUID(),
      'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(rawBody).digest('base64'),
    },
  });
  return ((await res.json()) as { action?: string }).action ?? '';
}

const order = (customer: string, total: string, source = 'web', extra: Record<string, unknown> = {}) => {
  const id = ++orderSeq;
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    source_name: source,
    test: false,
    total_price: total,
    currency: 'USD',
    customer: { id: 1, admin_graphql_api_id: customer },
    ...extra,
  };
};

async function token(kind: 'staff' | 'customer', customerId?: string) {
  const payload: Record<string, unknown> = { dest: `https://${SHOP}`, aud: API_KEY, jti: randomUUID() };
  payload['sub'] = kind === 'staff' ? '990001' : customerId;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(SECRET));
}

async function api(path: string, kind: 'staff' | 'customer', init: RequestInit = {}, customerId?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${await token(kind, customerId)}` },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const balance = async (c: string) =>
  (await api(`/api/balance?customerId=${encodeURIComponent(c)}`, 'staff')).body;

// ---- configure the program ----
const put = await api('/api/settings', 'staff', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    earnRate: '1',
    channelRules: {
      web: { enabled: true },
      pos: { enabled: true, earnRate: '2' },
      mobile_app: { enabled: false },
      other: { enabled: true },
    },
    excludedSources: ['amazon-marketplace'],
    tiers: [
      { name: 'Silver', minEarned365: 100, multiplier: '1.5' },
      { name: 'Gold', minEarned365: 1000, multiplier: '2' },
    ],
    referral: { enabled: true, advocatePoints: 200, friendPoints: 100 },
  }),
});
check(put.status === 200, `settings PUT ${put.status}`);

// ---- channel rules ----
const web = await webhook(order(CID(1), '50.00', 'web'));
check(web === 'earned 50', `web earn: '${web}'`);
// earned365 is 50 when this lands (below the 100 tier threshold), so just the 2x channel rate.
const pos = await webhook(order(CID(1), '50.00', 'pos'));
check(pos === 'earned 100', `pos earn at 2x channel rate: '${pos}'`);

const mobile = await webhook(order(CID(1), '50.00', 'iphone'));
check(mobile === "no earn: earning disabled for channel 'mobile_app'", `mobile skip: '${mobile}'`);
const excluded = await webhook(order(CID(1), '50.00', 'Amazon-Marketplace'));
check(
  excluded === "no earn: source 'Amazon-Marketplace' is excluded from earning",
  `excluded skip: '${excluded}'`,
);

// ---- tiers: crossing the threshold changes subsequent earns ----
const c2 = CID(2);
const first = await webhook(order(c2, '120.00'));
check(first === 'earned 120', `tier pre-threshold: '${first}'`);
const second = await webhook(order(c2, '100.00'));
check(second === 'earned 150 (Silver)', `tier post-threshold: '${second}'`);
const b2 = await balance(c2);
check(
  (b2['tier'] as { name?: string })?.name === 'Silver',
  `balance tier: ${JSON.stringify(b2['tier'])}`,
);

// ---- referrals ----
const advocate = CID(3);
await webhook(order(advocate, '10.00')); // existing customer with history
const codeRes = await api('/api/referral-code', 'customer', {}, advocate);
check(codeRes.status === 200 && typeof codeRes.body['code'] === 'string', `referral-code ${codeRes.status}`);
const code = codeRes.body['code'] as string;

const friend = CID(4);
const friendOrder = await webhook(
  order(friend, '60.00', 'web', { note_attributes: [{ name: 'loyalty_referral', value: code }] }),
);
check(
  friendOrder === 'earned 60; referral rewarded (advocate +200, friend +100)',
  `referral reward: '${friendOrder}'`,
);
check((await balance(advocate))['balance'] === 210, 'advocate balance 10+200');
check((await balance(friend))['balance'] === 160, 'friend balance 60+100');
const friendAgain = await webhook(
  order(friend, '30.00', 'web', { note_attributes: [{ name: 'loyalty_referral', value: code }] }),
);
check(friendAgain.includes('not first order'), `no repeat reward: '${friendAgain}'`);

// ---- awards ----
const awardTarget = CID(5);
const awards = await api('/api/awards', 'staff', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    batchId: randomUUID(),
    awards: [
      { customerId: awardTarget, points: 1000 },
      { customerId: awardTarget, points: -1500 },
    ],
  }),
});
check(awards.status === 200, `awards ${awards.status}`);
const results = awards.body['results'] as Array<{ applied: number }>;
check(results[0]?.applied === 1000 && results[1]?.applied === -1000, `awards capped: ${JSON.stringify(results)}`);
check((await balance(awardTarget))['balance'] === 0, 'award target ends at 0');

// ---- restore neutral settings so the dev console behaves normally ----
await api('/api/settings', 'staff', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    channelRules: {
      web: { enabled: true },
      pos: { enabled: true },
      mobile_app: { enabled: true },
      other: { enabled: true },
    },
    excludedSources: [],
  }),
});

if (failures.length) {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('V2 E2E: ALL CHECKS PASSED');
