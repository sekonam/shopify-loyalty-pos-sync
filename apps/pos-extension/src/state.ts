/**
 * The disable-when-offline rule (TECHNICAL-SPEC §7, resolved 2026-10-01):
 * redemption is enabled ONLY with a live, just-confirmed balance. A cached
 * number is never shown as if it were live, and there is no offline queue —
 * the POS does less when the backend is unreachable, it never drifts.
 */

export type ConnectionState = 'Connected' | 'Disconnected';

export interface BalanceView {
  kind: 'loading' | 'live' | 'stale' | 'unavailable';
  balance?: number;
  /** When the shown balance was last confirmed by the backend (stale only). */
  confirmedAt?: Date;
  redeemEnabled: boolean;
  statusLine: string;
}

export interface BalanceInputs {
  connection: ConnectionState;
  lastFetch:
    | { ok: true; balance: number; at: Date }
    | { ok: false }
    | undefined;
}

export function balanceView(inputs: BalanceInputs): BalanceView {
  const { connection, lastFetch } = inputs;
  if (connection === 'Disconnected') {
    if (lastFetch?.ok) {
      return {
        kind: 'stale',
        balance: lastFetch.balance,
        confirmedAt: lastFetch.at,
        redeemEnabled: false,
        statusLine: `Offline — balance last confirmed ${formatTime(lastFetch.at)}. Redemption disabled.`,
      };
    }
    return {
      kind: 'unavailable',
      redeemEnabled: false,
      statusLine: 'Offline — balance unavailable. Redemption disabled.',
    };
  }
  if (lastFetch === undefined) {
    return { kind: 'loading', redeemEnabled: false, statusLine: 'Checking balance…' };
  }
  if (!lastFetch.ok) {
    return {
      kind: 'unavailable',
      redeemEnabled: false,
      statusLine: "Can't reach the loyalty service. Redemption disabled — try again.",
    };
  }
  return {
    kind: 'live',
    balance: lastFetch.balance,
    confirmedAt: lastFetch.at,
    redeemEnabled: true,
    statusLine: `Live balance, confirmed ${formatTime(lastFetch.at)}.`,
  };
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Human-readable messages for every redemption outcome the backend can return. */
export function redeemStatusMessage(status: string): string {
  switch (status) {
    case 'applied':
      return 'Points redeemed and discount applied to the cart.';
    case 'rejected_insufficient_balance':
      return "Not enough points — the live balance is lower than requested. The cart wasn't changed.";
    case 'rejected_below_minimum':
      return 'Below the minimum redemption for this store.';
    case 'rejected_stale_offline_state':
      return "Couldn't confirm the balance — reconnect and retry.";
    default:
      return `Redemption not applied (${status}).`;
  }
}
