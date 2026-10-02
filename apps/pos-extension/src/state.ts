/**
 * The disable-when-offline rule (TECHNICAL-SPEC §7, resolved 2026-10-01):
 * redemption is enabled ONLY with a live, just-confirmed balance. A cached
 * number is never shown as if it were live, and there is no offline queue —
 * the POS does less when the backend is unreachable, it never drifts.
 *
 * Everything staff-facing in the two POS targets is worded here, so the copy
 * can be read (and tested) in one place. House style: say what is true, then
 * what to do about it. No "ledger", no "stale", no status codes.
 */

export type ConnectionState = 'Connected' | 'Disconnected';

/** The scannable chip beside the balance. One word or two, never a sentence. */
export interface StatusBadge {
  label: string;
  tone: 'success' | 'warning';
}

export interface BalanceView {
  kind: 'loading' | 'live' | 'stale' | 'unavailable';
  balance?: number;
  /** When the shown balance was last confirmed by the backend. */
  confirmedAt?: Date;
  redeemEnabled: boolean;
  /** Absent only while the very first check is still in flight. */
  badge?: StatusBadge;
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
 * confirmed balance — it stays visible, explicitly labeled as not confirmed,
 * never as live.
 */
export function failedFetch(prev: FetchState): FetchState {
  if (prev?.ok) return { ok: false, lastGood: { balance: prev.balance, at: prev.at } };
  if (prev && !prev.ok) return prev;
  return { ok: false };
}

export function balanceView(inputs: BalanceInputs): BalanceView {
  const { connection, lastFetch } = inputs;
  if (lastFetch === undefined && connection === 'Connected') {
    return { kind: 'loading', redeemEnabled: false, statusLine: 'Checking the latest balance…' };
  }
  if (lastFetch?.ok && connection === 'Connected') {
    return {
      kind: 'live',
      balance: lastFetch.balance,
      confirmedAt: lastFetch.at,
      redeemEnabled: true,
      badge: { label: 'Up to date', tone: 'success' },
      statusLine: `Confirmed at ${formatTime(lastFetch.at)}.`,
    };
  }
  // Everything below is some flavor of "not confirmed": redemption disabled,
  // and a number is shown only with an explicit last-confirmed label.
  const cached = lastFetch?.ok
    ? { balance: lastFetch.balance, at: lastFetch.at }
    : lastFetch && !lastFetch.ok
      ? lastFetch.lastGood
      : undefined;
  const offline = connection === 'Disconnected';
  const cause = offline ? 'This device is offline' : "Can't reach the loyalty service";
  const remedy = offline
    ? 'Reconnect to redeem points.'
    : 'Redeeming will work again as soon as it answers.';
  if (cached) {
    return {
      kind: 'stale',
      balance: cached.balance,
      confirmedAt: cached.at,
      redeemEnabled: false,
      badge: { label: offline ? 'Offline' : 'Not up to date', tone: 'warning' },
      statusLine: `${cause}, so this is the balance from ${formatTime(cached.at)} rather than a confirmed one. ${remedy}`,
    };
  }
  return {
    kind: 'unavailable',
    redeemEnabled: false,
    badge: { label: offline ? 'Offline' : 'Unavailable', tone: 'warning' },
    statusLine: `${cause}, so the balance can't be checked. ${remedy}`,
  };
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Two decimals, matching the amount strings the backend sends back. */
export function formatAmount(value: number): string {
  return value.toFixed(2);
}

/**
 * What a points amount is worth as a discount. `redemptionRate` is the
 * backend's "points per 1.00 off", sent as a string.
 */
export function discountValue(points: number, redemptionRate: string): number | undefined {
  const rate = Number(redemptionRate);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return points / rate;
}

export type QuickPickLabel = 'Minimum' | 'Half' | 'All';

export interface QuickPick {
  points: number;
  label: QuickPickLabel;
}

/**
 * The one-tap amounts offered beside the number field: the smallest allowed
 * redemption, a round half of the balance, and everything. Ascending, deduped,
 * never above the balance — an empty list means there's nothing to redeem.
 */
export function quickPicks(balance: number, minRedemption: number): QuickPick[] {
  if (minRedemption <= 0 || balance < minRedemption) return [];
  const picks: QuickPick[] = [];
  const add = (points: number, label: QuickPickLabel) => {
    if (points < minRedemption || points > balance) return;
    if (picks.some((pick) => pick.points === points)) return;
    picks.push({ points, label });
  };
  add(minRedemption, 'Minimum');
  // Half, rounded down to a whole multiple of the minimum so the suggestion
  // is a number a person would actually type.
  add(Math.floor(balance / 2 / minRedemption) * minRedemption, 'Half');
  add(balance, 'All');
  return picks.sort((a, b) => a.points - b.points);
}

/**
 * What's wrong with the amount typed in, if anything. Only speaks once there
 * is a number to judge — an untouched field is not an error.
 */
export function amountIssue(args: {
  points: number;
  balance?: number | undefined;
  minRedemption?: number | undefined;
}): string | undefined {
  const { points, balance, minRedemption } = args;
  if (points <= 0) return undefined;
  if (minRedemption !== undefined && points < minRedemption) {
    return `Enter at least ${minRedemption} points.`;
  }
  if (balance !== undefined && points > balance) {
    return `Only ${balance} points to spend.`;
  }
  return undefined;
}

/**
 * Marks the cart discount this app owns. POS replaces the cart-level discount
 * rather than adding to it, so a second redemption on the same sale has to
 * re-apply the RUNNING TOTAL — otherwise the customer is debited twice for
 * one discount. The marker is what lets a freshly opened modal recognise its
 * own earlier discount.
 */
export const LOYALTY_DISCOUNT_PREFIX = 'Loyalty points';

export interface AppliedLoyaltyDiscount {
  points: number;
  amount: number;
}

/** Finds this app's discount among the cart's discounts, if it already applied one. */
export function findLoyaltyDiscount(
  discounts: ReadonlyArray<{ type?: string; amount?: number; discountDescription?: string }>,
): AppliedLoyaltyDiscount | undefined {
  for (const discount of discounts) {
    const description = discount.discountDescription ?? '';
    if (discount.type !== 'FixedAmount' || !description.startsWith(LOYALTY_DISCOUNT_PREFIX)) {
      continue;
    }
    const points = Number(/(\d+)\s+points/.exec(description)?.[1] ?? 0);
    const amount = typeof discount.amount === 'number' ? discount.amount : 0;
    if (points > 0 && amount > 0) return { points, amount };
  }
  return undefined;
}

/**
 * The discount to apply after redeeming `points` more: this redemption plus
 * anything this app already put on the sale. Money is summed in whole cents
 * so repeated redemptions can't drift.
 */
export function cumulativeDiscount(
  prior: AppliedLoyaltyDiscount | undefined,
  added: { points: number; amount: string },
): { points: number; amount: string; title: string } {
  const cents = Math.round((prior?.amount ?? 0) * 100) + Math.round(Number(added.amount) * 100);
  const points = (prior?.points ?? 0) + added.points;
  return {
    points,
    amount: (cents / 100).toFixed(2),
    title: `${LOYALTY_DISCOUNT_PREFIX}: ${points} points redeemed`,
  };
}

/** Staff-readable text for every redemption outcome the backend can return. */
export function redeemStatusMessage(
  status: string,
  ctx?: {
    points?: number | undefined;
    amount?: string | undefined;
    minRedemption?: number | undefined;
  },
): string {
  switch (status) {
    case 'applied':
      return ctx?.points !== undefined && ctx.amount !== undefined
        ? `${ctx.points} points redeemed. ${ctx.amount} is off this sale.`
        : 'Points redeemed and the discount is on this sale.';
    case 'rejected_insufficient_balance':
      return "Not enough points — the confirmed balance is lower than that. Nothing was charged and the sale hasn't changed.";
    case 'rejected_below_minimum':
      return ctx?.minRedemption !== undefined
        ? `The smallest redemption at this store is ${ctx.minRedemption} points. Nothing was charged.`
        : 'That is below the smallest redemption this store allows. Nothing was charged.';
    case 'rejected_stale_offline_state':
      return "Couldn't confirm the balance, so nothing was charged. Check the connection and try again — the same points can't be taken twice.";
    default:
      return "That redemption didn't go through and nothing was charged. Try again in a moment.";
  }
}
