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

export type FetchState =
  | { ok: true; balance: number; at: Date }
  | { ok: false; lastGood?: { balance: number; at: Date } }
  | undefined;

export interface BalanceInputs {
  connection: ConnectionState;
  lastFetch: FetchState;
}

/**
 * Downgrades the fetch state after a failed call WITHOUT losing the last
 * confirmed balance — it stays visible, explicitly labeled stale, never live.
 */
export function failedFetch(prev: FetchState): FetchState {
  if (prev?.ok) return { ok: false, lastGood: { balance: prev.balance, at: prev.at } };
  if (prev && !prev.ok) return prev;
  return { ok: false };
}

export function balanceView(inputs: BalanceInputs): BalanceView {
  const { connection, lastFetch } = inputs;
  if (lastFetch === undefined && connection === 'Connected') {
    return { kind: 'loading', redeemEnabled: false, statusLine: 'Checking balance…' };
  }
  if (lastFetch?.ok && connection === 'Connected') {
    return {
      kind: 'live',
      balance: lastFetch.balance,
      confirmedAt: lastFetch.at,
      redeemEnabled: true,
      statusLine: `Live balance, confirmed ${formatTime(lastFetch.at)}.`,
    };
  }
  // Everything below is some flavor of "not live": redemption disabled, and a
  // number is shown only with an explicit last-confirmed label.
  const cached = lastFetch?.ok
    ? { balance: lastFetch.balance, at: lastFetch.at }
    : lastFetch && !lastFetch.ok
      ? lastFetch.lastGood
      : undefined;
  const prefix =
    connection === 'Disconnected' ? 'Offline' : "Can't reach the loyalty service";
  if (cached) {
    return {
      kind: 'stale',
      balance: cached.balance,
      confirmedAt: cached.at,
      redeemEnabled: false,
      statusLine: `${prefix} — balance last confirmed ${formatTime(cached.at)}. Redemption disabled.`,
    };
  }
  return {
    kind: 'unavailable',
    redeemEnabled: false,
    statusLine: `${prefix} — balance unavailable. Redemption disabled.`,
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
