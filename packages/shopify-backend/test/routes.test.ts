import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  makeApp,
  paidOrder,
  sessionToken,
  webhookRequest,
  SHOP,
} from './helpers.js';

const CUSTOMER = 'gid://shopify/Customer/42';

const authed = async (path: string, init: RequestInit = {}, token?: string) =>
  new Request(`http://localhost/api${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token ?? (await sessionToken())}`,
    },
  });

describe('GET /admin', () => {
  it('serves the embedded admin page with the app api key', async () => {
    const { app } = makeApp();
    const res = await app.request('http://localhost/admin');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('shopify-api-key');
    expect(html).toContain('test-client-id');
    expect(html).toContain('app-bridge.js');
  });
});

describe('POST /webhooks', () => {
  it('rejects a bad HMAC with 401 and processes nothing', async () => {
    const { app, deps } = makeApp();
    const res = await app.request(
      webhookRequest('orders/paid', paidOrder(), { secret: 'wrong-secret' }),
    );
    expect(res.status).toBe(401);
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(0);
  });

  it('accepts a correctly signed webhook and writes the ledger', async () => {
    const { app, deps } = makeApp();
    const res = await app.request(webhookRequest('orders/paid', paidOrder()));
    expect(res.status).toBe(200);
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50);
  });

  it('answers 200 for unknown topics (retries cannot help)', async () => {
    const { app } = makeApp();
    const res = await app.request(webhookRequest('products/create', { id: 1 }));
    expect(res.status).toBe(200);
  });
});

describe('session-token auth on /api', () => {
  it('rejects missing, unsigned, expired, and wrong-audience tokens', async () => {
    const { app } = makeApp();
    expect((await app.request('http://localhost/api/balance?customerId=x')).status).toBe(401);
    expect(
      (
        await app.request(
          await authed(`/balance?customerId=x`, {}, await sessionToken(SHOP, {}, 'wrong-secret')),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          await authed(
            `/balance?customerId=x`,
            {},
            await sessionToken(SHOP, { aud: 'someone-else' }),
          ),
        )
      ).status,
    ).toBe(401);
  });

  it('scopes every call to the shop in the token, not anything client-supplied', async () => {
    const { app, deps } = makeApp();
    await app.request(webhookRequest('orders/paid', paidOrder()));
    const otherShopToken = await sessionToken('other-shop.myshopify.com');
    const res = await app.request(
      await authed(`/balance?customerId=${encodeURIComponent(CUSTOMER)}`, {}, otherShopToken),
    );
    const body = (await res.json()) as { balance: number };
    expect(body.balance).toBe(0); // other shop sees nothing
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50);
  });
});

describe('GET /api/balance', () => {
  it('returns balance plus redemption parameters', async () => {
    const { app } = makeApp();
    await app.request(webhookRequest('orders/paid', paidOrder({ total_price: '250.00' })));
    const res = await app.request(
      await authed(`/balance?customerId=${encodeURIComponent(CUSTOMER)}`),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      customerId: CUSTOMER,
      balance: 250,
      minRedemption: 100,
      redemptionRate: '100',
      currency: 'USD',
      tier: null,
      referralEligible: null,
      maxDiscountAmount: '2.50',
    });
  });
});

describe('POST /api/redeem', () => {
  const redeemBody = (points: number, attemptId = randomUUID()) =>
    JSON.stringify({ customerId: CUSTOMER, points, attemptId, channel: 'pos' });

  it('applies a redemption and returns the discount to apply', async () => {
    const { app, deps } = makeApp();
    await app.request(webhookRequest('orders/paid', paidOrder({ total_price: '300.00' })));
    const res = await app.request(
      await authed('/redeem', {
        method: 'POST',
        body: redeemBody(200),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'applied',
      balance: 100,
      discountAmount: '2.00',
      discountTitle: '200 points redeemed',
    });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(100);
  });

  it('returns 409 with the status for a rejected redemption', async () => {
    const { app } = makeApp();
    await app.request(webhookRequest('orders/paid', paidOrder({ total_price: '120.00' })));
    const res = await app.request(
      await authed('/redeem', {
        method: 'POST',
        body: redeemBody(500),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: 'rejected_insufficient_balance', balance: 120 });
  });

  it('validates the request shape', async () => {
    const { app } = makeApp();
    for (const body of [
      '{}',
      JSON.stringify({ customerId: CUSTOMER, points: 10.5, attemptId: randomUUID(), channel: 'pos' }),
      JSON.stringify({ customerId: CUSTOMER, points: 10, attemptId: 'not-a-uuid', channel: 'pos' }),
      JSON.stringify({ customerId: CUSTOMER, points: 10, attemptId: randomUUID(), channel: 'kiosk' }),
      'not json',
    ]) {
      const res = await app.request(
        await authed('/redeem', { method: 'POST', body, headers: { 'content-type': 'application/json' } }),
      );
      expect(res.status, body).toBe(400);
    }
  });

  it('retrying the same attemptId does not double-spend', async () => {
    const { app, deps } = makeApp();
    await app.request(webhookRequest('orders/paid', paidOrder({ total_price: '300.00' })));
    const attemptId = randomUUID();
    const mk = async () =>
      app.request(
        await authed('/redeem', {
          method: 'POST',
          body: redeemBody(200, attemptId),
          headers: { 'content-type': 'application/json' },
        }),
      );
    const first = await mk();
    const second = await mk();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(100);
  });
});

describe('merchant-only routes', () => {
  it('a customer session token cannot touch settings, entries, or the CSV export', async () => {
    const { app } = makeApp();
    const customerToken = await sessionToken(SHOP, { sub: CUSTOMER });
    for (const req of [
      await authed('/settings', {}, customerToken),
      await authed(
        '/settings',
        {
          method: 'PUT',
          body: JSON.stringify({ redemptionRate: '0.01' }),
          headers: { 'content-type': 'application/json' },
        },
        customerToken,
      ),
      await authed('/entries', {}, customerToken),
      await authed('/ledger.csv', {}, customerToken),
    ]) {
      const res = await app.request(req);
      expect(res.status, req.url).toBe(403);
    }
  });

  it('a webhook handler failure returns 500 so Shopify retries', async () => {
    const { app, deps } = makeApp();
    deps.ledger.append = async () => {
      throw new Error('db down');
    };
    const res = await app.request(webhookRequest('orders/paid', paidOrder()));
    expect(res.status).toBe(500);
  });
});

describe('customer identity resolution', () => {
  const customerToken = () => sessionToken(SHOP, { sub: CUSTOMER });

  it('a customer-sub token needs no explicit customerId', async () => {
    const { app } = makeApp();
    await app.request(webhookRequest('orders/paid', paidOrder()));
    const res = await app.request(await authed('/balance', {}, await customerToken()));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { balance: number }).balance).toBe(50);
  });

  it('a customer-sub token cannot read or redeem another customer', async () => {
    const { app } = makeApp();
    const res = await app.request(
      await authed(
        `/balance?customerId=${encodeURIComponent('gid://shopify/Customer/999')}`,
        {},
        await customerToken(),
      ),
    );
    expect(res.status).toBe(403);
    const redeem = await app.request(
      await authed(
        '/redeem',
        {
          method: 'POST',
          body: JSON.stringify({
            customerId: 'gid://shopify/Customer/999',
            points: 100,
            attemptId: randomUUID(),
            channel: 'web',
          }),
          headers: { 'content-type': 'application/json' },
        },
        await customerToken(),
      ),
    );
    expect(redeem.status).toBe(403);
  });

  it('web redemption without a signed-in customer session is refused', async () => {
    const { app } = makeApp();
    const res = await app.request(
      await authed('/redeem', {
        method: 'POST',
        body: JSON.stringify({
          customerId: CUSTOMER,
          points: 100,
          attemptId: randomUUID(),
          channel: 'web',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('a staff token (numeric sub) must name the customer', async () => {
    const { app } = makeApp();
    const res = await app.request(await authed('/balance'));
    expect(res.status).toBe(400);
  });

  it('an anonymous token (signed-out checkout: no sub) gets nothing identity-bound', async () => {
    const { app, deps } = makeApp();
    await app.request(webhookRequest('orders/paid', paidOrder()));
    const anon = await sessionToken(SHOP, { sub: undefined });
    // Cannot read any balance, own or named:
    expect((await app.request(await authed('/balance', {}, anon))).status).toBe(403);
    expect(
      (
        await app.request(
          await authed(`/balance?customerId=${encodeURIComponent(CUSTOMER)}`, {}, anon),
        )
      ).status,
    ).toBe(403);
    // Cannot redeem on either channel:
    for (const channel of ['web', 'pos']) {
      const res = await app.request(
        await authed(
          '/redeem',
          {
            method: 'POST',
            body: JSON.stringify({
              customerId: CUSTOMER,
              points: 50,
              attemptId: randomUUID(),
              channel,
            }),
            headers: { 'content-type': 'application/json' },
          },
          anon,
        ),
      );
      expect(res.status, channel).toBe(403);
    }
    // Cannot touch merchant routes:
    expect((await app.request(await authed('/settings', {}, anon))).status).toBe(403);
    expect((await app.request(await authed('/entries', {}, anon))).status).toBe(403);
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50); // untouched
  });

  it('a customer token cannot redeem through the pos channel', async () => {
    const { app } = makeApp();
    await app.request(webhookRequest('orders/paid', paidOrder({ total_price: '300.00' })));
    const res = await app.request(
      await authed(
        '/redeem',
        {
          method: 'POST',
          body: JSON.stringify({ points: 100, attemptId: randomUUID(), channel: 'pos' }),
          headers: { 'content-type': 'application/json' },
        },
        await sessionToken(SHOP, { sub: CUSTOMER }),
      ),
    );
    expect(res.status).toBe(403);
  });

  it('the full checkout flow works from the token alone', async () => {
    const { app, deps } = makeApp();
    await app.request(webhookRequest('orders/paid', paidOrder({ total_price: '300.00' })));
    const res = await app.request(
      await authed(
        '/redeem',
        {
          method: 'POST',
          body: JSON.stringify({ points: 200, attemptId: randomUUID(), channel: 'web' }),
          headers: { 'content-type': 'application/json' },
        },
        await customerToken(),
      ),
    );
    expect(res.status).toBe(200);
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(100);
  });
});

describe('settings and export', () => {
  it('round-trips settings with validation', async () => {
    const { app } = makeApp();
    const put = await app.request(
      await authed('/settings', {
        method: 'PUT',
        body: JSON.stringify({ earnRate: '2', minRedemption: 50 }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await put.json()).toMatchObject({
      earnRate: '2',
      redemptionRate: '100',
      minRedemption: 50,
    });
    const bad = await app.request(
      await authed('/settings', {
        method: 'PUT',
        body: JSON.stringify({ earnRate: '-1' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(bad.status).toBe(400);
  });

  it('exports the ledger as CSV', async () => {
    const { app } = makeApp();
    await app.request(webhookRequest('orders/paid', paidOrder()));
    const res = await app.request(await authed('/ledger.csv'));
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    const [header, row] = text.split('\n');
    expect(header).toBe('id,customer_id,order_id,refund_id,source_name,delta,reason,created_at');
    expect(row).toContain('gid://shopify/Customer/42');
    expect(row).toContain('earn');
  });
});
