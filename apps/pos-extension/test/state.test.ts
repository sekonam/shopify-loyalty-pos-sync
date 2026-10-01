import { describe, expect, it } from 'vitest';
import { balanceView, redeemStatusMessage } from '../src/state.js';

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
