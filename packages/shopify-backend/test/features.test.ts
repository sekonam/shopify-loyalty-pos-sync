import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { processWebhook } from '../src/webhooks.js';
import { makeDeps, makeApp, paidOrder, sessionToken, SHOP } from './helpers.js';

const CUSTOMER = 'gid://shopify/Customer/42';
const FRIEND = 'gid://shopify/Customer/77';

const deliver = (
  deps: ReturnType<typeof makeDeps>,
  payload: unknown,
  webhookId = randomUUID(),
) =>
  processWebhook(
    { topic: 'orders/paid', shopDomain: SHOP, webhookId, rawBody: JSON.stringify(payload) },
    deps,
  );

describe('v1.x channel-scoped earning rules', () => {
  it('a disabled channel earns nothing; others are unaffected', async () => {
    const deps = makeDeps();
    await deps.settings.upsert(SHOP, { channelRules: { pos: { enabled: false } } });
    const pos = await deliver(deps, paidOrder({ source_name: 'pos' }));
    expect(pos).toMatchObject({ action: "no earn: earning disabled for channel 'pos'" });
    const web = await deliver(
      deps,
      paidOrder({ id: 2, admin_graphql_api_id: 'gid://shopify/Order/2', source_name: 'web' }),
    );
    expect(web).toMatchObject({ action: 'earned 50' });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50);
  });

  it('a channel rate override changes that channel only', async () => {
    const deps = makeDeps();
    await deps.settings.upsert(SHOP, { channelRules: { pos: { enabled: true, earnRate: '2' } } });
    await deliver(deps, paidOrder({ source_name: 'pos' })); // 50.00 * 2
    await deliver(
      deps,
      paidOrder({ id: 2, admin_graphql_api_id: 'gid://shopify/Order/2', source_name: 'web' }),
    );
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(150);
  });

  it('excluded raw sources never earn (the marketplace-exclusion ask)', async () => {
    const deps = makeDeps();
    await deps.settings.upsert(SHOP, { excludedSources: ['amazon-marketplace'] });
    const outcome = await deliver(deps, paidOrder({ source_name: 'Amazon-Marketplace' }));
    expect(outcome).toMatchObject({
      action: "no earn: source 'Amazon-Marketplace' is excluded from earning",
    });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(0);
  });
});

describe('v2 VIP tiers', () => {
  const TIERS = [
    { name: 'Silver', minEarned365: 100, multiplier: '1.5' },
    { name: 'Gold', minEarned365: 1000, multiplier: '2' },
  ];

  it('the multiplier applies from the order AFTER the threshold is crossed', async () => {
    const deps = makeDeps();
    await deps.settings.upsert(SHOP, { tiers: TIERS });
    await deliver(deps, paidOrder({ total_price: '120.00' })); // earned365 0 -> base rate: +120
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(120);
    const second = await deliver(
      deps,
      paidOrder({ id: 2, admin_graphql_api_id: 'gid://shopify/Order/2', total_price: '100.00' }),
    );
    expect(second).toMatchObject({ action: 'earned 150 (Silver)' }); // 100 * 1.5
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(270);
  });

  it('balance API reports the tier', async () => {
    const { app, deps } = makeApp();
    await deps.settings.upsert(SHOP, { tiers: TIERS });
    await deliver(deps, paidOrder({ total_price: '120.00' }));
    const res = await app.request(
      new Request(
        `http://localhost/api/balance?customerId=${encodeURIComponent(CUSTOMER)}`,
        { headers: { authorization: `Bearer ${await sessionToken()}` } },
      ),
    );
    const body = (await res.json()) as { tier: { name: string; earned365: number } };
    expect(body.tier).toEqual({ name: 'Silver', multiplier: '1.5', earned365: 120 });
  });
});

describe('v2 referrals', () => {
  async function enable(deps: ReturnType<typeof makeDeps>) {
    await deps.settings.upsert(SHOP, {
      referral: { enabled: true, advocatePoints: 200, friendPoints: 100 },
    });
  }
  const friendOrder = (code: string, over: Record<string, unknown> = {}) =>
    paidOrder({
      id: 10,
      admin_graphql_api_id: 'gid://shopify/Order/10',
      customer: { id: 77, admin_graphql_api_id: FRIEND },
      note_attributes: [{ name: 'loyalty_referral', value: code }],
      ...over,
    });

  it('rewards both sides on the friend\'s first order, exactly once', async () => {
    const deps = makeDeps();
    await enable(deps);
    const code = await deps.referrals.codeFor(SHOP, CUSTOMER);
    const outcome = await deliver(deps, friendOrder(code));
    expect(outcome).toMatchObject({
      action: 'earned 50; referral rewarded (advocate +200, friend +100)',
    });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(200);
    expect(await deps.ledger.balance(SHOP, FRIEND)).toBe(150);
    // A second order with the same (or any) code rewards nothing more.
    const again = await deliver(
      deps,
      friendOrder(code, { id: 11, admin_graphql_api_id: 'gid://shopify/Order/11' }),
    );
    expect(again).toMatchObject({ action: 'earned 50; referral code ignored (not first order)' });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(200);
  });

  it('ignores self-referral, unknown codes, and disabled program', async () => {
    const deps = makeDeps();
    await enable(deps);
    const code = await deps.referrals.codeFor(SHOP, FRIEND); // friend's own code
    const self = await deliver(deps, friendOrder(code));
    expect(self).toMatchObject({ action: 'earned 50; self-referral ignored' });
    expect(await deps.ledger.balance(SHOP, FRIEND)).toBe(50); // just the earn

    const unknown = await deliver(
      deps,
      paidOrder({
        id: 20,
        admin_graphql_api_id: 'gid://shopify/Order/20',
        customer: { id: 78, admin_graphql_api_id: 'gid://shopify/Customer/78' },
        note_attributes: [{ name: 'loyalty_referral', value: 'NOPE1' }],
      }),
    );
    expect(unknown).toMatchObject({ action: 'earned 50; referral code unknown' });

    const disabledDeps = makeDeps();
    const code2 = await disabledDeps.referrals.codeFor(SHOP, CUSTOMER);
    const disabled = await deliver(disabledDeps, friendOrder(code2));
    expect(disabled).toMatchObject({
      action: 'earned 50; referral code ignored (program disabled)',
    });
  });

  it('a redelivered webhook cannot double-reward', async () => {
    const deps = makeDeps();
    await enable(deps);
    const code = await deps.referrals.codeFor(SHOP, CUSTOMER);
    const wid = randomUUID();
    await deliver(deps, friendOrder(code), wid);
    await deliver(deps, friendOrder(code), wid); // duplicate delivery
    await deliver(deps, friendOrder(code)); // replay, new webhook id
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(200);
    expect(await deps.ledger.balance(SHOP, FRIEND)).toBe(150);
  });

  it('GET /api/referral-code: customer-only, stable, 404 when disabled', async () => {
    const { app, deps } = makeApp();
    await deps.settings.upsert(SHOP, {
      referral: { enabled: true, advocatePoints: 200, friendPoints: 100 },
    });
    const customerToken = await sessionToken(SHOP, { sub: CUSTOMER });
    const mk = () =>
      app.request(
        new Request('http://localhost/api/referral-code', {
          headers: { authorization: `Bearer ${customerToken}` },
        }),
      );
    const first = (await (await mk()).json()) as { code: string };
    const second = (await (await mk()).json()) as { code: string };
    expect(first.code).toBe(second.code);
    expect(first.code).toMatch(/^[A-Z0-9]+$/);

    const staff = await app.request(
      new Request('http://localhost/api/referral-code', {
        headers: { authorization: `Bearer ${await sessionToken()}` },
      }),
    );
    expect(staff.status).toBe(403);

    await deps.settings.upsert(SHOP, {
      referral: { enabled: false, advocatePoints: 200, friendPoints: 100 },
    });
    expect((await mk()).status).toBe(404);
  });
});

describe('v2 awards tool', () => {
  const authedPost = async (body: unknown) =>
    new Request('http://localhost/api/awards', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await sessionToken()}`,
      },
    });

  it('awards and deducts with idempotent retry, deductions capped at zero', async () => {
    const { app, deps } = makeApp();
    const batchId = randomUUID();
    const body = {
      batchId,
      awards: [
        { customerId: CUSTOMER, points: 500 },
        { customerId: FRIEND, points: 250 },
        { customerId: FRIEND, points: -1000 }, // capped at the 250 just granted
      ],
    };
    const res = await app.request(await authedPost(body));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([
      { customerId: CUSTOMER, applied: 500 },
      { customerId: FRIEND, applied: 250 },
      { customerId: FRIEND, applied: -250 },
    ]);
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(500);
    expect(await deps.ledger.balance(SHOP, FRIEND)).toBe(0);
    // Retry of the whole batch applies nothing new.
    const retry = await app.request(await authedPost(body));
    expect(((await retry.json()) as { results: { applied: number }[] }).results.every((r) => r.applied === 0)).toBe(true);
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(500);
  });

  it('validates the batch and refuses customer tokens', async () => {
    const { app } = makeApp();
    for (const bad of [
      { awards: [] },
      { awards: [{ customerId: CUSTOMER, points: 0 }] },
      { awards: [{ customerId: '', points: 10 }] },
      { awards: [{ customerId: CUSTOMER, points: 1.5 }] },
    ]) {
      const res = await app.request(await authedPost(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const customer = await app.request(
      new Request('http://localhost/api/awards', {
        method: 'POST',
        body: JSON.stringify({ awards: [{ customerId: CUSTOMER, points: 10 }] }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await sessionToken(SHOP, { sub: CUSTOMER })}`,
        },
      }),
    );
    expect(customer.status).toBe(403);
  });
});

describe('extended settings round-trip', () => {
  it('accepts and returns the full v1.x/v2 configuration', async () => {
    const { app } = makeApp();
    const put = await app.request(
      new Request('http://localhost/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          channelRules: { pos: { enabled: false }, web: { enabled: true, earnRate: '2' } },
          excludedSources: ['amazon-marketplace'],
          tiers: [{ name: 'Gold', minEarned365: 1000, multiplier: '2' }],
          referral: { enabled: true, advocatePoints: 300, friendPoints: 150 },
        }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await sessionToken()}`,
        },
      }),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      channelRules: { pos: { enabled: false }, web: { enabled: true, earnRate: '2' } },
      excludedSources: ['amazon-marketplace'],
      tiers: [{ name: 'Gold', minEarned365: 1000, multiplier: '2' }],
      referral: { enabled: true, advocatePoints: 300, friendPoints: 150 },
    });
  });

  it('rejects malformed configuration', async () => {
    const { app } = makeApp();
    for (const bad of [
      { channelRules: { kiosk: { enabled: true } } },
      { channelRules: { pos: { enabled: 'yes' } } },
      { excludedSources: ['ok', ''] },
      { tiers: [{ name: '', minEarned365: 0, multiplier: '1' }] },
      { tiers: [{ name: 'x', minEarned365: -1, multiplier: '1' }] },
      { tiers: [{ name: 'x', minEarned365: 0, multiplier: '0' }] },
      { referral: { enabled: true, advocatePoints: -1, friendPoints: 0 } },
    ]) {
      const res = await app.request(
        new Request('http://localhost/api/settings', {
          method: 'PUT',
          body: JSON.stringify(bad),
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await sessionToken()}`,
          },
        }),
      );
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});
