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

  it('a staff token (no customer sub) must name the customer', async () => {
    const { app } = makeApp();
    const res = await app.request(await authed('/balance'));
    expect(res.status).toBe(400);
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
    expect(await put.json()).toEqual({ earnRate: '2', redemptionRate: '100', minRedemption: 50 });
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
