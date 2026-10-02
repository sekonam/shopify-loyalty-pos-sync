import { describe, expect, it } from 'vitest';
import { effectiveEarnRate, selectTier } from '../src/rules.js';
import { mulDecimals } from '../src/money.js';
import { InMemoryLedgerStore } from '../src/store.js';
import type { VipTier } from '../src/types.js';

const TIERS: VipTier[] = [
  { name: 'Silver', minEarned365: 500, multiplier: '1.25' },
  { name: 'Gold', minEarned365: 2000, multiplier: '1.5' },
];

describe('mulDecimals', () => {
  it('multiplies decimal strings exactly', () => {
    expect(mulDecimals('1', '1.25')).toBe('1.25');
    expect(mulDecimals('0.5', '1.5')).toBe('0.75');
    expect(mulDecimals('2', '3')).toBe('6');
    expect(mulDecimals('1.25', '0')).toBe('0');
    expect(mulDecimals('0.1', '0.2')).toBe('0.02'); // float would give 0.020000000000000004
  });
});

describe('selectTier', () => {
  it('picks the highest qualifying tier regardless of array order', () => {
    expect(selectTier(TIERS, 0)).toBeUndefined();
    expect(selectTier(TIERS, 500)?.name).toBe('Silver');
    expect(selectTier(TIERS, 1999)?.name).toBe('Silver');
    expect(selectTier(TIERS, 2000)?.name).toBe('Gold');
    expect(selectTier([...TIERS].reverse(), 3000)?.name).toBe('Gold');
    expect(selectTier(undefined, 5000)).toBeUndefined();
    expect(selectTier([], 5000)).toBeUndefined();
  });
});

describe('effectiveEarnRate', () => {
  const base = { baseEarnRate: '1', earned365: 0 };

  it('defaults: every channel earns at the base rate', () => {
    for (const src of ['web', 'pos', 'iphone', 'amazon-handle']) {
      expect(effectiveEarnRate({ ...base, orderSourceName: src })).toEqual({
        kind: 'earn',
        rate: '1',
      });
    }
  });

  it('excluded raw sources never earn (the channel-filter ask)', () => {
    const result = effectiveEarnRate({
      ...base,
      orderSourceName: 'Amazon-Marketplace',
      excludedSources: ['amazon-marketplace'],
    });
    expect(result.kind).toBe('skip');
    // A different source still earns.
    expect(
      effectiveEarnRate({ ...base, orderSourceName: 'pos', excludedSources: ['amazon-marketplace'] })
        .kind,
    ).toBe('earn');
  });

  it('a disabled channel rule stops earning; an override changes the rate', () => {
    const channelRules = { pos: { enabled: false }, web: { enabled: true, earnRate: '2' } };
    expect(effectiveEarnRate({ ...base, orderSourceName: 'pos', channelRules }).kind).toBe('skip');
    expect(effectiveEarnRate({ ...base, orderSourceName: 'web', channelRules })).toEqual({
      kind: 'earn',
      rate: '2',
    });
    // Unlisted channel: base rate.
    expect(effectiveEarnRate({ ...base, orderSourceName: 'iphone', channelRules })).toEqual({
      kind: 'earn',
      rate: '1',
    });
    // Unknown source maps to the 'other' channel rule.
    expect(
      effectiveEarnRate({
        ...base,
        orderSourceName: 'some-app',
        channelRules: { other: { enabled: false } },
      }).kind,
    ).toBe('skip');
  });

  it('tier multiplier stacks on the channel rate', () => {
    const result = effectiveEarnRate({
      baseEarnRate: '1',
      orderSourceName: 'web',
      tiers: TIERS,
      earned365: 2500,
      channelRules: { web: { enabled: true, earnRate: '2' } },
    });
    expect(result).toEqual({ kind: 'earn', rate: '3', tier: TIERS[1] });
  });

  it('exclusion wins over everything', () => {
    const result = effectiveEarnRate({
      baseEarnRate: '1',
      orderSourceName: 'web',
      excludedSources: ['web'],
      tiers: TIERS,
      earned365: 5000,
    });
    expect(result.kind).toBe('skip');
  });
});

describe('InMemoryLedgerStore.earnedSince', () => {
  it('counts only purchase earns inside the window', async () => {
    const store = new InMemoryLedgerStore();
    const SHOP = 's.myshopify.com';
    const C = 'gid://shopify/Customer/1';
    const mk = (delta: number, reason: string, key: string) =>
      store.append({
        shopDomain: SHOP,
        customerId: C,
        sourceName: 'web',
        delta,
        reason: reason as never,
        idempotencyKey: key,
      });
    await mk(100, 'earn', 'a');
    await mk(50, 'reconciliation', 'b');
    await mk(200, 'referral_reward', 'c'); // credit, but not a purchase earn
    await mk(30, 'adjustment', 'd');
    await mk(-80, 'redeem', 'e'); // spending never affects qualification
    expect(await store.earnedSince(SHOP, C, new Date(Date.now() - 1000))).toBe(150);
    expect(await store.earnedSince(SHOP, C, new Date(Date.now() + 1000))).toBe(0);
  });
});
