import { describe, expect, it } from 'vitest';
import { balanceView, failedFetch, redeemStatusMessage } from '../src/state.js';

const at = new Date('2026-10-01T12:00:00Z');

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
    expect(view.statusLine).toContain('Offline');
    expect(view.statusLine).toContain('Redemption disabled');
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
    expect(offline.statusLine).toContain('Offline');
  });
});

describe('redeemStatusMessage', () => {
  it('covers every backend status with staff-readable text', () => {
    for (const status of [
      'applied',
      'rejected_insufficient_balance',
      'rejected_below_minimum',
      'rejected_stale_offline_state',
      'something_new',
    ]) {
      expect(redeemStatusMessage(status)).toBeTruthy();
    }
  });
});
