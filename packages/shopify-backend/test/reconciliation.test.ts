import { describe, expect, it } from 'vitest';
import { orderPaidKey } from '@loyalty/ledger';
import { reconcileShop, type AdminOrdersClient, type ReconOrder } from '../src/reconciliation.js';
import { makeDeps, paidOrder, SHOP } from './helpers.js';
import { processWebhook } from '../src/webhooks.js';

const CUSTOMER = 'gid://shopify/Customer/42';

const order = (over: Partial<ReconOrder> = {}): ReconOrder => ({
  id: 'gid://shopify/Order/1001',
  sourceName: 'pos',
  test: false,
  customerId: CUSTOMER,
  totalPrice: '50.00',
  refunds: [],
  ...over,
});

const clientOf = (pages: ReconOrder[][]): AdminOrdersClient => ({
  async ordersUpdatedSince(_shop, _since, cursor) {
    const i = cursor ? Number(cursor) : 0;
    const orders = pages[i] ?? [];
    const next = i + 1 < pages.length ? String(i + 1) : undefined;
    return { orders, ...(next !== undefined ? { nextCursor: next } : {}) };
  },
});

describe('reconcileShop', () => {
  it('inserts a missing earn with the canonical idempotency key', async () => {
    const deps = makeDeps();
    const result = await reconcileShop(SHOP, new Date(0), {
      client: clientOf([[order()]]),
      ledger: deps.ledger,
      settings: deps.settings,
    });
    expect(result).toMatchObject({ ordersSeen: 1, earnsAdded: 1, reversalsAdded: 0 });
    const [entry] = await deps.ledger.entries(SHOP, CUSTOMER);
    expect(entry).toMatchObject({
      delta: 50,
      reason: 'reconciliation',
      sourceName: 'pos',
      idempotencyKey: orderPaidKey('gid://shopify/Order/1001'),
    });
  });

  it('a late webhook after a reconciliation correction is a no-op (and vice versa)', async () => {
    const deps = makeDeps();
    await reconcileShop(SHOP, new Date(0), {
      client: clientOf([[order()]]),
      ledger: deps.ledger,
      settings: deps.settings,
    });
    // The dropped webhook finally arrives:
    await processWebhook(
      {
        topic: 'orders/paid',
        shopDomain: SHOP,
        webhookId: 'late-1',
        rawBody: JSON.stringify(paidOrder()),
      },
      deps,
    );
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50); // not 100
  });

  it('does not duplicate entries the webhook path already wrote', async () => {
    const deps = makeDeps();
    await processWebhook(
      {
        topic: 'orders/paid',
        shopDomain: SHOP,
        webhookId: 'wh-1',
        rawBody: JSON.stringify(paidOrder()),
      },
      deps,
    );
    const result = await reconcileShop(SHOP, new Date(0), {
      client: clientOf([[order()]]),
      ledger: deps.ledger,
      settings: deps.settings,
    });
    expect(result.earnsAdded).toBe(0);
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50);
  });

  it('adds missing refund reversals, capped at the balance', async () => {
    const deps = makeDeps();
    const withRefund = order({
      refunds: [{ id: 'gid://shopify/Refund/9001', totalRefunded: '80.00' }],
    });
    const result = await reconcileShop(SHOP, new Date(0), {
      client: clientOf([[withRefund]]),
      ledger: deps.ledger,
      settings: deps.settings,
    });
    // Earn 50 then reverse min(80, 50) = 50.
    expect(result).toMatchObject({ earnsAdded: 1, reversalsAdded: 1 });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(0);
  });

  it('skips test orders and orders without customers, and pages through cursors', async () => {
    const deps = makeDeps();
    const result = await reconcileShop(SHOP, new Date(0), {
      client: clientOf([
        [
          order({ test: true }),
          { id: 'gid://shopify/Order/2', sourceName: 'web', test: false, totalPrice: '50.00', refunds: [] },
        ],
        [order({ id: 'gid://shopify/Order/3' })],
      ]),
      ledger: deps.ledger,
      settings: deps.settings,
    });
    expect(result).toMatchObject({ ordersSeen: 3, earnsAdded: 1 });
  });
});
