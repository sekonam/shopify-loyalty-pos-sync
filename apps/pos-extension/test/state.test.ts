import { describe, expect, it } from 'vitest';
import {
  CART_WRITE_FAILED,
  FRESH_FOR_MS,
  NETWORK_UNCONFIRMED,
  amountIssue,
  balanceView,
  balanceWorthLine,
  cumulativeDiscount,
  discountValue,
  failedFetch,
  findLoyaltyDiscount,
  formatAmount,
  money,
  quickPickLabel,
  quickPicks,
  redeemActionLabel,
  redeemOutcome,
  redeemStatusMessage,
  shortOfMinimumLine,
} from '../src/state.js';

const at = new Date('2026-10-01T12:00:00Z');
/** Treat `at` as a just-now read unless a test is about aging. */
const justNow = at.getTime();

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
    expect(
      balanceView({ connection: 'Connected', lastFetch: { ok: true, balance: 1, at }, now: justNow })
        .badge,
    ).toEqual({ label: 'Up to date', tone: 'success' });
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

  it('stops calling a confirmed balance up to date once it has aged', () => {
    const old = balanceView({
      connection: 'Connected',
      lastFetch: { ok: true, balance: 250, at },
      now: justNow + FRESH_FOR_MS + 1,
    });
    // Still a real, confirmed number — the backend validates the debit itself,
    // so an aging read must not strand staff with a dead button mid-sale...
    expect(old).toMatchObject({ kind: 'live', balance: 250, redeemEnabled: true, fresh: false });
    // ...but it stops claiming to be current, and says what to do about it.
    expect(old.badge?.tone).toBe('info'); // not the green "Up to date" chip
    expect(old.badge?.label).toContain('Read at');
    expect(old.statusLine).toContain('check again');

    const justRead = balanceView({
      connection: 'Connected',
      lastFetch: { ok: true, balance: 250, at },
      now: justNow + FRESH_FOR_MS - 1,
    });
    expect(justRead.fresh).toBe(true);
    expect(justRead.badge?.label).toBe('Up to date');
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

  it('prices each one-tap amount in the shop currency, right on the control', () => {
    const picks = quickPicks(1000, 100, { redemptionRate: '100', currency: 'USD' });
    expect(picks.map(quickPickLabel)).toEqual([
      '100 points · $1.00 off',
      'Half · 500 points · $5.00 off',
      'All 1000 points · $10.00 off',
    ]);
    // No currency known yet (a shop with no orders): the bare amount, never a
    // guessed symbol.
    expect(quickPickLabel(quickPicks(250, 100, { redemptionRate: '100' })[1]!)).toBe(
      'All 250 points · 2.50 off',
    );
    // Unpriced picks still read as amounts rather than breaking.
    expect(quickPickLabel({ points: 100, label: 'Minimum' })).toBe('100 points');
    // A nonsense rate prices nothing rather than printing NaN at a counter.
    expect(quickPicks(250, 100, { redemptionRate: '0' })[0]?.amount).toBeUndefined();
  });

  it('floors money to whole cents the way the backend does, and names the currency', () => {
    // 5 points at 8 points per unit is 0.625: the backend floors to 0.62, so a
    // button must not promise 0.63.
    expect(formatAmount(0.625)).toBe('0.62');
    expect(formatAmount(0.29)).toBe('0.29'); // float dust, not 0.28
    expect(money('2.50', 'USD')).toBe('$2.50');
    expect(money(2.5, null)).toBe('2.50');
    expect(money('2.50', 'NOT-A-CODE')).toBe('2.50'); // never throws at a counter
    expect(money('not-a-number')).toBe('not-a-number');
  });

  it('puts the consequence in money on the primary button, and the recovery on a retry', () => {
    expect(redeemActionLabel({ amount: '$2.50' })).toBe('Take $2.50 off this sale');
    expect(redeemActionLabel({ amount: '$2.50', retry: true })).toBe(
      'Try again — take $2.50 off this sale',
    );
    // No valid amount yet: the button says what to do, not what it would do.
    expect(redeemActionLabel({})).toBe('Choose an amount to redeem');
  });

  it('says how far off a too-small balance is, instead of offering a dead form', () => {
    expect(shortOfMinimumLine(40, 100)).toBe(
      '60 more points and this customer can start redeeming.',
    );
    expect(shortOfMinimumLine(100, 100)).toContain('0 more points');
    expect(
      balanceWorthLine({ balance: 40, minRedemption: 100, maxDiscountAmount: '0.40' }),
    ).toContain('60 more points');
    expect(
      balanceWorthLine({
        balance: 250,
        minRedemption: 100,
        maxDiscountAmount: '2.50',
        currency: 'USD',
      }),
    ).toBe('Worth up to $2.50 off a sale. Tap Redeem loyalty points to use them.');
    // A real zero reads as intentional, and points nowhere.
    expect(balanceWorthLine({ balance: 0, minRedemption: 100, maxDiscountAmount: '0.00' })).toBe(
      'No points yet — they start adding up with the next sale.',
    );
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

  it('closes the loop on success: what came off the sale, and what is left', () => {
    const outcome = redeemOutcome('applied', { points: 200, amount: '$2.00', balance: 50 });
    expect(outcome.tone).toBe('success');
    // The money is in the heading, so it is the first thing read.
    expect(outcome.heading).toBe('Done · $2.00 off this sale');
    expect(outcome.message).toBe('200 points redeemed. $2.00 is off this sale. New balance: 50 points.');
  });

  it('never claims nothing was charged when the debit actually committed', () => {
    // Points debited, discount NOT on the sale (POS refused the cart write).
    const stranded = redeemOutcome(CART_WRITE_FAILED, { points: 200 });
    expect(stranded.tone).toBe('critical');
    expect(stranded.heading).toBe('Points taken — discount not applied');
    expect(stranded.message).toContain('200 points were taken');
    expect(stranded.message).toContain('did NOT go on this sale');
    expect(stranded.message).not.toContain('Nothing was charged');
    expect(stranded.message).not.toContain('nothing was charged');
    // One next action, then the escalation if it keeps failing.
    expect(stranded.message).toContain('Tap Try again');
    expect(stranded.message).toContain('manager');

    // A call that never came back is honestly uncertain — it must not claim
    // the points are safe, only that a retry cannot take them twice.
    const unsure = redeemOutcome(NETWORK_UNCONFIRMED);
    expect(unsure.tone).toBe('critical');
    expect(unsure.message).not.toContain('othing was charged');
    expect(unsure.message).toContain("isn't clear whether these points came off");
    expect(unsure.message).toContain('Tap Try again');
  });

  it('gives every outcome a heading that carries the meaning without the colour', () => {
    for (const status of [
      'applied',
      'rejected_insufficient_balance',
      'rejected_below_minimum',
      'rejected_stale_offline_state',
      NETWORK_UNCONFIRMED,
      CART_WRITE_FAILED,
      'something_new',
    ]) {
      const outcome = redeemOutcome(status, { points: 1, amount: '0.01', minRedemption: 100 });
      expect(outcome.heading.length).toBeGreaterThan(0);
      expect(outcome.heading).not.toContain('_');
    }
  });
});
