import { describe, expect, it } from 'vitest';
import { InMemoryLedgerStore } from '../src/store.js';
import type { LedgerEntryDraft } from '../src/types.js';

const SHOP = 'test.myshopify.com';
const CUSTOMER = 'gid://shopify/Customer/1';

function earnDraft(key: string, delta = 100): LedgerEntryDraft {
  return {
    shopDomain: SHOP,
    customerId: CUSTOMER,
    orderId: `gid://shopify/Order/${key}`,
    sourceName: 'web',
    delta,
    reason: 'earn',
    idempotencyKey: `order_paid:${key}`,
  };
}

describe('InMemoryLedgerStore.append', () => {
  it('appends and derives balance as the sum of deltas', async () => {
    const store = new InMemoryLedgerStore();
    await store.append(earnDraft('1', 100));
    await store.append(earnDraft('2', 50));
    expect(await store.balance(SHOP, CUSTOMER)).toBe(150);
  });

  it('is idempotent on the idempotency key', async () => {
    const store = new InMemoryLedgerStore();
    const first = await store.append(earnDraft('1', 100));
    const second = await store.append(earnDraft('1', 100));
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(await store.balance(SHOP, CUSTOMER)).toBe(100);
  });

  it('rejects zero and non-integer deltas', async () => {
    const store = new InMemoryLedgerStore();
    await expect(store.append({ ...earnDraft('1'), delta: 0 })).rejects.toThrow();
    await expect(store.append({ ...earnDraft('2'), delta: 1.5 })).rejects.toThrow();
  });

  it('scopes balances per shop and per customer', async () => {
    const store = new InMemoryLedgerStore();
    await store.append(earnDraft('1', 100));
    await store.append({ ...earnDraft('1', 999), shopDomain: 'other.myshopify.com' });
    await store.append({ ...earnDraft('2', 30), customerId: 'gid://shopify/Customer/2' });
    expect(await store.balance(SHOP, CUSTOMER)).toBe(100);
    expect(await store.balance('other.myshopify.com', CUSTOMER)).toBe(999);
    expect(await store.balance(SHOP, 'gid://shopify/Customer/2')).toBe(30);
  });
});

describe('InMemoryLedgerStore.stats', () => {
  it('counts only positive balances as members and splits the window by direction', async () => {
    const store = new InMemoryLedgerStore();
    await store.append(earnDraft('1', 100));
    await store.append({ ...earnDraft('2', 40), customerId: 'gid://shopify/Customer/2' });
    // Spend customer 2 back down to zero: still a ledger participant, not a member.
    await store.redeem({
      shopDomain: SHOP,
      customerId: 'gid://shopify/Customer/2',
      channel: 'web',
      requestedPoints: 40,
      minRedemption: 1,
      attemptId: 'a1',
    });
    const stats = await store.stats(SHOP, new Date(Date.now() - 60_000));
    expect(stats).toEqual({
      members: 1,
      outstandingPoints: 100,
      entryCount: 3,
      issuedInWindow: 140,
      redeemedInWindow: 40,
    });
    const future = await store.stats(SHOP, new Date(Date.now() + 60_000));
    expect(future).toMatchObject({ issuedInWindow: 0, redeemedInWindow: 0, members: 1 });
  });
});

describe('InMemoryLedgerStore.redeem', () => {
  it('applies a valid redemption and decrements the balance', async () => {
    const store = new InMemoryLedgerStore();
    await store.append(earnDraft('1', 500));
    const result = await store.redeem({
      shopDomain: SHOP,
      customerId: CUSTOMER,
      channel: 'pos',
      requestedPoints: 200,
      minRedemption: 100,
      attemptId: 'attempt-1',
      posDeviceId: 'device-9',
    });
    expect(result.status).toBe('applied');
    expect(result.balance).toBe(300);
    expect(await store.balance(SHOP, CUSTOMER)).toBe(300);
    const attempt = await store.getAttempt(SHOP, 'attempt-1');
    expect(attempt).toMatchObject({ status: 'applied', channel: 'pos', posDeviceId: 'device-9' });
  });

  it('rejects below-minimum and insufficient-balance requests, recording the attempt', async () => {
    const store = new InMemoryLedgerStore();
    await store.append(earnDraft('1', 150));
    const below = await store.redeem({
      shopDomain: SHOP,
      customerId: CUSTOMER,
      channel: 'web',
      requestedPoints: 50,
      minRedemption: 100,
      attemptId: 'a-below',
    });
    expect(below.status).toBe('rejected_below_minimum');
    const over = await store.redeem({
      shopDomain: SHOP,
      customerId: CUSTOMER,
      channel: 'web',
      requestedPoints: 200,
      minRedemption: 100,
      attemptId: 'a-over',
    });
    expect(over.status).toBe('rejected_insufficient_balance');
    expect(await store.balance(SHOP, CUSTOMER)).toBe(150);
    expect((await store.getAttempt(SHOP, 'a-below'))?.status).toBe('rejected_below_minimum');
    expect((await store.getAttempt(SHOP, 'a-over'))?.status).toBe('rejected_insufficient_balance');
  });

  it('is idempotent on attemptId: a retried call returns the stored outcome without reapplying', async () => {
    const store = new InMemoryLedgerStore();
    await store.append(earnDraft('1', 500));
    const req = {
      shopDomain: SHOP,
      customerId: CUSTOMER,
      channel: 'pos' as const,
      requestedPoints: 200,
      minRedemption: 100,
      attemptId: 'attempt-retry',
    };
    const first = await store.redeem(req);
    const second = await store.redeem(req);
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    expect(await store.balance(SHOP, CUSTOMER)).toBe(300); // not 100
  });

  it('race: two concurrent redemptions that each fit, but not together — exactly one wins', async () => {
    const store = new InMemoryLedgerStore();
    await store.append(earnDraft('1', 300));
    const mk = (attemptId: string) =>
      store.redeem({
        shopDomain: SHOP,
        customerId: CUSTOMER,
        channel: 'pos',
        requestedPoints: 200,
        minRedemption: 100,
        attemptId,
      });
    const [a, b] = await Promise.all([mk('race-a'), mk('race-b')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['applied', 'rejected_insufficient_balance']);
    expect(await store.balance(SHOP, CUSTOMER)).toBe(100);
  });

  it('race: many concurrent single-point redemptions never overspend', async () => {
    const store = new InMemoryLedgerStore();
    await store.append(earnDraft('1', 5));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.redeem({
          shopDomain: SHOP,
          customerId: CUSTOMER,
          channel: 'web',
          requestedPoints: 1,
          minRedemption: 1,
          attemptId: `swarm-${i}`,
        }),
      ),
    );
    const applied = results.filter((r) => r.status === 'applied').length;
    expect(applied).toBe(5);
    expect(await store.balance(SHOP, CUSTOMER)).toBe(0);
  });
});
