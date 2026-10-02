import { describe, expect, it, vi } from 'vitest';
import { GraphqlAdminOrdersClient } from '../src/admin-client.js';
import { reconcileAllShops, type ReconRunStore } from '../src/scheduler.js';
import { RECONCILIATION_OVERLAP_MS } from '../src/reconciliation.js';
import { makeDeps, SHOP } from './helpers.js';

const CUSTOMER = 'gid://shopify/Customer/42';

const gqlPage = (nodes: unknown[], endCursor: string | null = null) => ({
  data: {
    orders: {
      pageInfo: { hasNextPage: endCursor !== null, endCursor },
      nodes,
    },
  },
});

const orderNode = (id: number, over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Order/${id}`,
  sourceName: 'pos',
  test: false,
  customer: { id: CUSTOMER },
  totalPriceSet: { shopMoney: { amount: '50.00' } },
  refunds: [],
  ...over,
});

describe('GraphqlAdminOrdersClient', () => {
  it('queries the shop, maps nodes, and follows cursors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(gqlPage([orderNode(1)], 'cur-2'))))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            gqlPage([
              orderNode(2, {
                customer: null,
                refunds: [
                  { id: 'gid://shopify/Refund/9', totalRefundedSet: { shopMoney: { amount: '10.00' } } },
                ],
              }),
            ]),
          ),
        ),
      );
    const client = new GraphqlAdminOrdersClient(
      { accessTokenFor: async () => 'tok' },
      fetchImpl as unknown as typeof fetch,
    );
    const since = new Date('2026-10-01T00:00:00Z');
    const page1 = await client.ordersUpdatedSince(SHOP, since);
    expect(page1.orders[0]).toMatchObject({ id: 'gid://shopify/Order/1', customerId: CUSTOMER });
    expect(page1.nextCursor).toBe('cur-2');
    const page2 = await client.ordersUpdatedSince(SHOP, since, page1.nextCursor);
    expect(page2.orders[0]?.customerId).toBeUndefined();
    expect(page2.orders[0]?.refunds[0]).toEqual({ id: 'gid://shopify/Refund/9', totalRefunded: '10.00' });
    expect(page2.nextCursor).toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`https://${SHOP}/admin/api/2026-07/graphql.json`);
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.variables.query).toBe("updated_at:>='2026-10-01T00:00:00.000Z'");
    expect((init as RequestInit).headers).toMatchObject({ 'x-shopify-access-token': 'tok' });
  });

  it('throws on missing token, HTTP errors, and GraphQL errors', async () => {
    const noToken = new GraphqlAdminOrdersClient({ accessTokenFor: async () => undefined });
    await expect(noToken.ordersUpdatedSince(SHOP, new Date())).rejects.toThrow(/No Admin API token/);

    const http500 = new GraphqlAdminOrdersClient(
      { accessTokenFor: async () => 'tok' },
      vi.fn().mockResolvedValue(new Response('nope', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(http500.ordersUpdatedSince(SHOP, new Date())).rejects.toThrow(/500/);

    const throttled = new GraphqlAdminOrdersClient(
      { accessTokenFor: async () => 'tok' },
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ errors: [{ message: 'Throttled' }] })),
        ) as unknown as typeof fetch,
    );
    await expect(throttled.ordersUpdatedSince(SHOP, new Date())).rejects.toThrow(/Throttled/);
  });
});

class FakeRunStore implements ReconRunStore {
  runs: Array<Parameters<ReconRunStore['recordRun']>[0]> = [];
  checkpoint: Date | undefined;
  shops = [SHOP];

  async nextSince(): Promise<Date | undefined> {
    return this.checkpoint
      ? new Date(this.checkpoint.getTime() - RECONCILIATION_OVERLAP_MS)
      : undefined;
  }
  async recordRun(run: Parameters<ReconRunStore['recordRun']>[0]): Promise<void> {
    this.runs.push(run);
    if (!run.error) this.checkpoint = run.checkpoint;
  }
  async shopsToReconcile(): Promise<string[]> {
    return this.shops;
  }
}

describe('reconcileAllShops', () => {
  it('reconciles each shop and records the run', async () => {
    const deps = makeDeps();
    const runStore = new FakeRunStore();
    await reconcileAllShops({
      runs: runStore,
      client: {
        ordersUpdatedSince: async () => ({
          orders: [
            {
              id: 'gid://shopify/Order/1',
              sourceName: 'pos',
              test: false,
              financialStatus: 'PAID',
              customerId: CUSTOMER,
              totalPrice: '50.00',
              refunds: [],
            },
          ],
        }),
      },
      ledger: deps.ledger,
      settings: deps.settings,
      referrals: deps.referrals,
      log: () => undefined,
    });
    expect(await deps.ledger.balance(SHOP, CUSTOMER)).toBe(50);
    expect(runStore.runs).toHaveLength(1);
    expect(runStore.runs[0]).toMatchObject({ shopDomain: SHOP, entriesAdded: 1, ordersSeen: 1 });
  });

  it('a failing shop records the error and keeps the retry window', async () => {
    const deps = makeDeps();
    const runStore = new FakeRunStore();
    await reconcileAllShops({
      runs: runStore,
      client: {
        ordersUpdatedSince: async () => {
          throw new Error('Admin API 500');
        },
      },
      ledger: deps.ledger,
      settings: deps.settings,
      referrals: deps.referrals,
      log: () => undefined,
    });
    expect(runStore.runs[0]).toMatchObject({ entriesAdded: 0 });
    expect(runStore.runs[0]?.error).toContain('Admin API 500');
    expect(runStore.checkpoint).toBeUndefined(); // failed run advances nothing
  });
});
