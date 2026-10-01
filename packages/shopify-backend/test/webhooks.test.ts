import { describe, expect, it } from 'vitest';
import { processWebhook } from '../src/webhooks.js';
import { makeDeps, paidOrder, refundPayload, SHOP } from './helpers.js';

const CUSTOMER = 'gid://shopify/Customer/42';

const deliver = (
  deps: ReturnType<typeof makeDeps>,
  topic: string,
  payload: unknown,
  webhookId = `wh-${Math.random()}`,
) =>
  processWebhook(
    { topic, shopDomain: SHOP, webhookId, rawBody: JSON.stringify(payload) },
    deps,
  );

describe('orders/paid', () => {
  it('appends a channel-tagged earn entry', async () => {
    const deps = makeDeps();
    const outcome = await deliver(deps, 'orders/paid', paidOrder());
    expect(outcome).toEqual({ handled: true, action: 'earned 50' });
    const entries = await deps.ledger.entries(SHOP, CUSTOMER);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ delta: 50, reason: 'earn', sourceName: 'pos' });
  });

  it('skips test orders and orders without a customer', async () => {
    const deps = makeDeps();
    expect(await deliver(deps, 'orders/paid', paidOrder({ test: true }))).toMatchObject({
      action: 'skipped test order',
    });
    expect(await deliver(deps, 'orders/paid', paidOrder({ customer: null }))).toMatchObject({
      action: 'skipped order without customer',
    });
    expect(await deps.ledger.entries(SHOP, CUSTOMER)).toHaveLength(0);
  });

  it('dedupes redelivered webhook ids before any processing', async () => {
    const deps = makeDeps();
    await deliver(deps, 'orders/paid', paidOrder(), 'same-id');
    const second = await deliver(deps, 'orders/paid', paidOrder(), 'same-id');
    expect(second).toEqual({ handled: true, action: 'duplicate' });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50);
  });

  it('is idempotent on the order even across distinct webhook ids', async () => {
    const deps = makeDeps();
    await deliver(deps, 'orders/paid', paidOrder(), 'id-1');
    const replay = await deliver(deps, 'orders/paid', paidOrder(), 'id-2');
    expect(replay).toMatchObject({ action: 'earn already recorded' });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50);
  });

  it('tags unknown source names as other, preserving the raw value', async () => {
    const deps = makeDeps();
    await deliver(deps, 'orders/paid', paidOrder({ source_name: '755357713' }));
    const [entry] = await deps.ledger.entries(SHOP, CUSTOMER);
    expect(entry).toMatchObject({ sourceName: 'other', rawSourceName: '755357713' });
  });
});

describe('refunds/create', () => {
  it('reverses points using the earn entry for customer and channel', async () => {
    const deps = makeDeps();
    await deliver(deps, 'orders/paid', paidOrder());
    const outcome = await deliver(deps, 'refunds/create', refundPayload());
    expect(outcome).toMatchObject({ action: 'reversed 20' });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(30);
    const entries = await deps.ledger.entries(SHOP, CUSTOMER);
    expect(entries[1]).toMatchObject({ reason: 'refund_reversal', sourceName: 'pos', delta: -20 });
  });

  it('caps the reversal at the current balance', async () => {
    const deps = makeDeps();
    await deliver(deps, 'orders/paid', paidOrder());
    // Spend 40 of the 50 first, then refund the whole order (would reverse 50).
    await deps.ledger.redeem({
      shopDomain: SHOP,
      customerId: CUSTOMER,
      channel: 'web',
      requestedPoints: 40,
      minRedemption: 1,
      attemptId: '11111111-1111-4111-8111-111111111111',
    });
    const outcome = await deliver(
      deps,
      'refunds/create',
      refundPayload({ transactions: [{ kind: 'refund', status: 'success', amount: '50.00' }] }),
    );
    expect(outcome).toMatchObject({ action: 'reversed 10' });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(0);
  });

  it('handles a refund arriving before its order (out-of-order delivery)', async () => {
    const deps = makeDeps();
    const outcome = await deliver(deps, 'refunds/create', refundPayload());
    expect(outcome).toMatchObject({
      action: 'no earn entry for refunded order yet (reconciliation will catch up)',
    });
  });

  it('ignores restock-only refunds with no money movement', async () => {
    const deps = makeDeps();
    await deliver(deps, 'orders/paid', paidOrder());
    const outcome = await deliver(deps, 'refunds/create', refundPayload({ transactions: [] }));
    expect(outcome).toMatchObject({ action: 'no refunded amount, nothing to reverse' });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50);
  });

  it('is idempotent per refund id', async () => {
    const deps = makeDeps();
    await deliver(deps, 'orders/paid', paidOrder());
    await deliver(deps, 'refunds/create', refundPayload());
    const replay = await deliver(deps, 'refunds/create', refundPayload());
    expect(replay).toMatchObject({ action: 'reversal already recorded' });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(30);
  });
});

describe('compliance and lifecycle topics', () => {
  it('app/uninstalled marks the shop uninstalled', async () => {
    const deps = makeDeps();
    await deliver(deps, 'app/uninstalled', { id: 1 });
    expect((await deps.settings.get(SHOP)).uninstalledAt).toBeInstanceOf(Date);
  });

  it('customers/redact routes to the compliance store', async () => {
    const deps = makeDeps();
    await deliver(deps, 'customers/redact', {
      shop_domain: SHOP,
      customer: { id: 42 },
      orders_to_redact: [1001],
    });
    expect(deps.compliance.redacted).toEqual([{ shopDomain: SHOP, customerId: CUSTOMER }]);
  });

  it('customers/data_request is acknowledged', async () => {
    const deps = makeDeps();
    const outcome = await deliver(deps, 'customers/data_request', {
      shop_domain: SHOP,
      customer: { id: 42 },
      orders_requested: [],
    });
    expect(outcome).toMatchObject({ handled: true });
  });

  it('shop/redact purges the tenant', async () => {
    const deps = makeDeps();
    await deps.settings.upsert(SHOP, { minRedemption: 5 });
    await deliver(deps, 'shop/redact', { shop_domain: SHOP });
    expect((await deps.settings.get(SHOP)).minRedemption).toBe(100); // back to defaults
  });

  it('unknown topics are reported unhandled but never error', async () => {
    const deps = makeDeps();
    const outcome = await deliver(deps, 'products/create', { id: 1 });
    expect(outcome).toMatchObject({ handled: false });
  });
});
