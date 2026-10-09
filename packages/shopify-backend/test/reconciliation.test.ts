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
  financialStatus: 'PAID',
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
      referrals: deps.referrals,
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
      referrals: deps.referrals,
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
      referrals: deps.referrals,
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
      referrals: deps.referrals,
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
          {
            id: 'gid://shopify/Order/2',
            sourceName: 'web',
            test: false,
            financialStatus: 'PAID',
            totalPrice: '50.00',
            refunds: [],
          },
        ],
        [order({ id: 'gid://shopify/Order/3' })],
      ]),
      ledger: deps.ledger,
      settings: deps.settings,
      referrals: deps.referrals,
    });
    expect(result).toMatchObject({ ordersSeen: 3, earnsAdded: 1 });
  });

  it('unpaid orders never earn — only paid-class statuses do', async () => {
    const deps = makeDeps();
    const result = await reconcileShop(SHOP, new Date(0), {
      client: clientOf([
        [
          order({ id: 'gid://shopify/Order/10', financialStatus: 'PENDING' }),
          order({ id: 'gid://shopify/Order/11', financialStatus: 'AUTHORIZED' }),
          order({ id: 'gid://shopify/Order/12', financialStatus: 'VOIDED' }),
          order({ id: 'gid://shopify/Order/13', financialStatus: 'PARTIALLY_REFUNDED' }),
        ],
      ]),
      ledger: deps.ledger,
      settings: deps.settings,
      referrals: deps.referrals,
    });
    expect(result.earnsAdded).toBe(1); // only the PARTIALLY_REFUNDED one
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50);
  });
});

/**
 * A dropped orders/paid used to cost the shop everything the handler does
 * besides the earn. Reconciliation is the defense-in-depth for a dropped
 * webhook (CLAUDE.md), so "healed" has to mean the same ledger either way —
 * not the earn alone.
 */
describe('reconcileShop heals the whole orders/paid handler, not just the earn', () => {
  it('claws back a forged loyalty discount the dropped webhook never checked', async () => {
    const deps = makeDeps();
    const forged = order({
      id: 'gid://shopify/Order/2001',
      totalPrice: '50.00',
      sourceName: 'web',
      attributes: [
        { name: 'loyalty_discount', value: '5.00' },
        { name: 'loyalty_attempt', value: '11111111-2222-3333-4444-555555555555' },
      ],
    });
    await reconcileShop(SHOP, new Date(0), {
      client: clientOf([[forged]]),
      ledger: deps.ledger,
      settings: deps.settings,
      referrals: deps.referrals,
    });
    // 5.00 of discount at the default rate is 500 points claimed against an
    // attempt that was never applied; the balance caps the clawback at 50.
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(0);
    const reasons = (await deps.ledger.entries(SHOP, CUSTOMER)).map((e) => e.reason);
    expect(reasons).toEqual(['reconciliation', 'adjustment']);
  });

  it('pays a referral the dropped webhook never paid, exactly once', async () => {
    const deps = makeDeps();
    const advocate = 'gid://shopify/Customer/7';
    await deps.settings.upsert(SHOP, {
      referral: { enabled: true, advocatePoints: 200, friendPoints: 100 },
    });
    const code = await deps.referrals.codeFor(SHOP, advocate);
    const friendOrder = order({
      id: 'gid://shopify/Order/3001',
      totalPrice: '60.00',
      sourceName: 'web',
      attributes: [{ name: 'loyalty_referral', value: code }],
    });
    const run = {
      client: clientOf([[friendOrder]]),
      ledger: deps.ledger,
      settings: deps.settings,
      referrals: deps.referrals,
    };
    await reconcileShop(SHOP, new Date(0), run);
    expect(await deps.ledger.balance(SHOP, advocate)).toBe(200);
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(160); // 60 earned + 100 welcome

    // The overlap window re-reads the same order every hour; it must not
    // re-pay. Both reward appends are keyed per order.
    await reconcileShop(SHOP, new Date(0), run);
    expect(await deps.ledger.balance(SHOP, advocate)).toBe(200);
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(160);
  });

  it('a healed order and a delivered one leave the same ledger', async () => {
    const attributes = [
      { name: 'loyalty_discount', value: '2.00' },
      { name: 'loyalty_attempt', value: '99999999-8888-7777-6666-555555555555' },
    ];
    // Delivered: the webhook path runs earn + clawback.
    const viaWebhook = makeDeps();
    await processWebhook(
      {
        topic: 'orders/paid',
        shopDomain: SHOP,
        webhookId: 'w-1',
        rawBody: JSON.stringify(
          paidOrder({
            id: 4001,
            total_price: '50.00',
            source_name: 'web',
            note_attributes: attributes,
          }),
        ),
      },
      viaWebhook,
    );
    // Dropped: only the sweep ever sees it.
    const viaRecon = makeDeps();
    await reconcileShop(SHOP, new Date(0), {
      client: clientOf([
        [order({ id: 'gid://shopify/Order/4001', totalPrice: '50.00', sourceName: 'web', attributes })],
      ]),
      ledger: viaRecon.ledger,
      settings: viaRecon.settings,
      referrals: viaRecon.referrals,
    });
    expect(await viaRecon.ledger.balance(SHOP, CUSTOMER)).toBe(
      await viaWebhook.ledger.balance(SHOP, CUSTOMER),
    );
  });
});
