import { describe, expect, it } from 'vitest';
import {
  amountIssue,
  balanceView,
  cumulativeDiscount,
  discountValue,
  failedFetch,
  findLoyaltyDiscount,
  quickPicks,
  redeemStatusMessage,
} from '../src/state.js';

const at = new Date('2026-10-01T12:00:00Z');

describe('cart discount accumulation', () => {
  const ours = (description: string, amount: number) => ({
    type: 'FixedAmount',
    amount,
    discountDescription: description,
  });

  it('recognises only this app\'s own fixed-amount discount', () => {
    expect(findLoyaltyDiscount([])).toBeUndefined();
    expect(findLoyaltyDiscount([ours('Loyalty points: 200 points redeemed', 2)])).toEqual({
      points: 200,
      amount: 2,
    });
    // Someone else's discount, a percentage, or a malformed one: not ours.
    expect(findLoyaltyDiscount([ours('Manager discount', 5)])).toBeUndefined();
    expect(
      findLoyaltyDiscount([
        { type: 'Percentage', amount: 10, discountDescription: 'Loyalty points: 200 points redeemed' },
      ]),
    ).toBeUndefined();
    expect(findLoyaltyDiscount([ours('Loyalty points: nothing', 2)])).toBeUndefined();
  });

  it('sums a second redemption onto the first instead of replacing it', () => {
    const first = cumulativeDiscount(undefined, { points: 200, amount: '2.00' });
    expect(first).toEqual({
      points: 200,
      amount: '2.00',
      title: 'Loyalty points: 200 points redeemed',
    });
    const second = cumulativeDiscount({ points: 200, amount: 2 }, { points: 150, amount: '1.50' });
    expect(second).toEqual({
      points: 350,
      amount: '3.50',
      title: 'Loyalty points: 350 points redeemed',
    });
  });

  it('adds money in whole cents so repeated redemptions cannot drift', () => {
    let running = cumulativeDiscount(undefined, { points: 10, amount: '0.10' });
    for (let i = 0; i < 2; i++) {
      running = cumulativeDiscount(
        { points: running.points, amount: Number(running.amount) },
        { points: 10, amount: '0.20' },
      );
    }
    expect(running.amount).toBe('0.50'); // float addition would give 0.5000000000000001
  });
});

describe('balanceView — the disable-when-offline rule', () => {
  it('loading: nothing fetched yet, redeem disabled', () => {
    expect(balanceView({ connection: 'Connected', lastFetch: undefined })).toMatchObject({
      kind: 'loading',
      redeemEnabled: false,
    });
  });

  it('live: connected with a confirmed balance — the only state where redeem is enabled', () => {
    const view = balanceView({
      connection: 'Connected',
      lastFetch: { ok: true, balance: 250, at },
    });
    expect(view).toMatchObject({ kind: 'live', balance: 250, redeemEnabled: true });
  });

  it('backend unreachable while online: redeem disabled, no stale number shown as live', () => {
    const view = balanceView({ connection: 'Connected', lastFetch: { ok: false } });
    expect(view).toMatchObject({ kind: 'unavailable', redeemEnabled: false });
    expect(view.balance).toBeUndefined();
  });

  it('offline with a cached balance: clearly marked stale, redeem disabled', () => {
    const view = balanceView({
      connection: 'Disconnected',
      lastFetch: { ok: true, balance: 250, at },
    });
    expect(view).toMatchObject({ kind: 'stale', balance: 250, redeemEnabled: false });
    // Scannable at a glance, then said in words, with the way out.
    expect(view.badge).toEqual({ label: 'Offline', tone: 'warning' });
    expect(view.statusLine).toContain('offline');
    expect(view.statusLine).toContain('Reconnect to redeem');
  });

  it('offline with nothing cached: unavailable, redeem disabled', () => {
    expect(balanceView({ connection: 'Disconnected', lastFetch: undefined })).toMatchObject({
      kind: 'unavailable',
      redeemEnabled: false,
    });
  });

  it('a failed refetch keeps the last confirmed balance, labeled stale, never live', () => {
    const afterFailure = failedFetch({ ok: true, balance: 250, at });
    expect(afterFailure).toEqual({ ok: false, lastGood: { balance: 250, at } });
    // Repeated failures keep the same lastGood; failure from nothing stays empty.
    expect(failedFetch(afterFailure)).toBe(afterFailure);
    expect(failedFetch(undefined)).toEqual({ ok: false });

    const connectedButDown = balanceView({ connection: 'Connected', lastFetch: afterFailure });
    expect(connectedButDown).toMatchObject({ kind: 'stale', balance: 250, redeemEnabled: false });
    expect(connectedButDown.statusLine).toContain("Can't reach the loyalty service");

    const offline = balanceView({ connection: 'Disconnected', lastFetch: afterFailure });
    expect(offline).toMatchObject({ kind: 'stale', balance: 250, redeemEnabled: false });
    expect(offline.badge?.label).toBe('Offline');
  });

  it('only the live state carries a success badge', () => {
    expect(balanceView({ connection: 'Connected', lastFetch: { ok: true, balance: 1, at } }).badge)
      .toEqual({ label: 'Up to date', tone: 'success' });
    // Loading says nothing at all rather than guessing a status.
    expect(balanceView({ connection: 'Connected', lastFetch: undefined }).badge).toBeUndefined();
    for (const view of [
      balanceView({ connection: 'Connected', lastFetch: { ok: false } }),
      balanceView({ connection: 'Disconnected', lastFetch: undefined }),
      balanceView({ connection: 'Disconnected', lastFetch: { ok: true, balance: 1, at } }),
    ]) {
      expect(view.badge?.tone).toBe('warning');
    }
  });
});

describe('what points are worth before anyone confirms a redemption', () => {
  it('converts points to money at the backend rate, and refuses a nonsense rate', () => {
    expect(discountValue(250, '100')).toBe(2.5);
    expect(discountValue(300, '20')).toBe(15);
    expect(discountValue(100, '0')).toBeUndefined();
    expect(discountValue(100, 'not-a-number')).toBeUndefined();
  });

  it('offers minimum / half / all as one-tap amounts, deduped and in range', () => {
    expect(quickPicks(1000, 100)).toEqual([
      { points: 100, label: 'Minimum' },
      { points: 500, label: 'Half' },
      { points: 1000, label: 'All' },
    ]);
    // Half rounds down to a whole multiple of the minimum, so it can collapse
    // into the minimum rather than suggesting an amount nobody would type.
    expect(quickPicks(250, 100)).toEqual([
      { points: 100, label: 'Minimum' },
      { points: 250, label: 'All' },
    ]);
    expect(quickPicks(100, 100)).toEqual([{ points: 100, label: 'Minimum' }]);
    // Nothing to offer below the minimum, or with no points at all.
    expect(quickPicks(99, 100)).toEqual([]);
    expect(quickPicks(0, 100)).toEqual([]);
  });

  it('names the problem with an amount, and stays quiet about an untouched field', () => {
    expect(amountIssue({ points: 0, balance: 250, minRedemption: 100 })).toBeUndefined();
    expect(amountIssue({ points: 200, balance: 250, minRedemption: 100 })).toBeUndefined();
    expect(amountIssue({ points: 50, balance: 250, minRedemption: 100 })).toContain('at least 100');
    expect(amountIssue({ points: 900, balance: 250, minRedemption: 100 })).toContain('Only 250');
  });
});

describe('redeemStatusMessage', () => {
  it('covers every backend status with staff-readable text, and leaks no status codes', () => {
    for (const status of [
      'applied',
      'rejected_insufficient_balance',
      'rejected_below_minimum',
      'rejected_stale_offline_state',
      'something_new',
    ]) {
      const message = redeemStatusMessage(status);
      expect(message).toBeTruthy();
      expect(message).not.toContain('rejected_');
      expect(message).not.toContain('something_new');
    }
  });

  it('gets specific when the caller knows the numbers', () => {
    expect(redeemStatusMessage('applied', { points: 200, amount: '2.00' })).toBe(
      '200 points redeemed. 2.00 is off this sale.',
    );
    expect(redeemStatusMessage('rejected_below_minimum', { minRedemption: 100 })).toContain(
      'is 100 points',
    );
    // Every rejection says the customer wasn't charged.
    expect(redeemStatusMessage('rejected_insufficient_balance')).toContain('Nothing was charged');
    expect(redeemStatusMessage('rejected_stale_offline_state')).toContain("can't be taken twice");
  });
});
