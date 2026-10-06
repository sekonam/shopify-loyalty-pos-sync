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
  tone: 'success' | 'info' | 'warning';
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
  /** True while the shown number is recent enough to call "up to date". */
  fresh?: boolean;
}

/**
 * How long a confirmed balance may keep calling itself "Up to date". A modal
 * left open through a long sale must not keep a green badge on a number the
 * backend read minutes ago — past this the chip says when it was read, and
 * offers the re-check. Redemption stays available either way: the write is
 * validated against the ledger server-side, so an aging read can make the
 * screen misleading but never makes the debit wrong.
 */
export const FRESH_FOR_MS = 60_000;

export type FetchState =
  | { ok: true; balance: number; at: Date }
  | { ok: false; lastGood?: { balance: number; at: Date } }
  | undefined;

export interface BalanceInputs {
  connection: ConnectionState;
  lastFetch: FetchState;
  /** Now, injected so freshness is testable. Defaults to the wall clock. */
  now?: number | undefined;
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
    const now = inputs.now ?? Date.now();
    const fresh = now - lastFetch.at.getTime() <= FRESH_FOR_MS;
    return {
      kind: 'live',
      balance: lastFetch.balance,
      confirmedAt: lastFetch.at,
      redeemEnabled: true,
      fresh,
      badge: fresh
        ? { label: 'Up to date', tone: 'success' }
        : { label: `Read at ${formatTime(lastFetch.at)}`, tone: 'info' },
      statusLine: fresh
        ? `Confirmed at ${formatTime(lastFetch.at)}.`
        : `Confirmed at ${formatTime(lastFetch.at)} — check again for the latest.`,
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

/**
 * Two decimals, matching the amount strings the backend sends back. Floored to
 * whole cents the way the backend prices a redemption, so a number printed on
 * a button is never a cent more than what actually comes off the sale. The
 * epsilon absorbs binary-float dust (0.29 * 100 = 28.999999999999996).
 */
export function formatAmount(value: number): string {
  return (Math.floor(value * 100 + 1e-6) / 100).toFixed(2);
}

/**
 * Every amount staff or a customer reads, in the shop's own currency. The
 * backend sends plain decimal strings and the balance response carries the
 * shop currency; a bare "2.50" at a counter is ambiguous, so the symbol goes
 * on. An unknown currency code falls back to the bare amount rather than
 * throwing in front of a queue.
 */
export function money(amount: string | number, currency?: string | null | undefined): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return String(amount);
  const floored = Math.floor(value * 100 + 1e-6) / 100;
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        // Match the storefront's own money: "$45.00", not "US$45.00".
        currencyDisplay: 'narrowSymbol',
      }).format(floored);
    } catch {
      // Unknown currency code — fall through to the bare amount.
    }
  }
  return formatAmount(floored);
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
  /** Money this pick takes off the sale. Present only when a rate was given. */
  amount?: string;
}

/** What a redemption is worth, for pricing the one-tap amounts. */
export interface Pricing {
  redemptionRate: string;
  currency?: string | null | undefined;
}

/**
 * The one-tap amounts offered beside the number field: the smallest allowed
 * redemption, a round half of the balance, and everything. Ascending, deduped,
 * never above the balance — an empty list means there's nothing to redeem.
 *
 * Pass `pricing` to price each pick, so a one-tap control can say what it does
 * in money instead of making staff convert points in their head.
 */
export function quickPicks(
  balance: number,
  minRedemption: number,
  pricing?: Pricing,
): QuickPick[] {
  if (minRedemption <= 0 || balance < minRedemption) return [];
  const picks: QuickPick[] = [];
  const add = (points: number, label: QuickPickLabel) => {
    if (points < minRedemption || points > balance) return;
    if (picks.some((pick) => pick.points === points)) return;
    const value =
      pricing === undefined ? undefined : discountValue(points, pricing.redemptionRate);
    picks.push({
      points,
      label,
      ...(value !== undefined ? { amount: money(value, pricing?.currency) } : {}),
    });
  };
  add(minRedemption, 'Minimum');
  // Half, rounded down to a whole multiple of the minimum so the suggestion
  // is a number a person would actually type.
  add(Math.floor(balance / 2 / minRedemption) * minRedemption, 'Half');
  add(balance, 'All');
  return picks.sort((a, b) => a.points - b.points);
}

/**
 * What a one-tap amount button says. The money is on the control itself —
 * "All 250 points · 2.50 off" — because the number staff and the customer
 * actually care about is the one coming off the sale, and nothing here should
 * require arithmetic at the counter. Full words, not "pts": assistive tech
 * reads this label out loud.
 */
export function quickPickLabel(pick: QuickPick): string {
  const amount = pick.amount === undefined ? '' : ` · ${pick.amount} off`;
  const scope = pick.label === 'All' ? 'All ' : pick.label === 'Half' ? 'Half · ' : '';
  return `${scope}${pick.points} points${amount}`;
}

/**
 * The primary button's words. It names the consequence in money before the
 * tap ("Take 2.50 off this sale"), never just "Redeem" — and after a call
 * that didn't come back, it names the recovery instead.
 */
export function redeemActionLabel(args: { amount?: string | undefined; retry?: boolean }): string {
  if (args.amount === undefined) return 'Choose an amount to redeem';
  return args.retry
    ? `Try again — take ${args.amount} off this sale`
    : `Take ${args.amount} off this sale`;
}

/**
 * Why there is nothing to redeem yet, in points rather than in a greyed-out
 * form. Said wherever the form would otherwise sit there refusing every
 * number anyone types.
 */
export function shortOfMinimumLine(balance: number, minRedemption: number): string {
  return `${Math.max(minRedemption - balance, 0)} more points and this customer can start redeeming.`;
}

/**
 * The line under a CONFIRMED balance on the customer-details block: what the
 * points are worth, or how far off being usable they are, and — because a
 * part-time staff member has no reason to know where redemption lives — where
 * to actually spend them. Never paired with an unconfirmed number.
 */
export function balanceWorthLine(args: {
  balance: number;
  minRedemption: number;
  maxDiscountAmount: string;
  currency?: string | null | undefined;
}): string {
  const { balance, minRedemption, maxDiscountAmount, currency } = args;
  if (balance <= 0) return 'No points yet — they start adding up with the next sale.';
  if (balance < minRedemption) return shortOfMinimumLine(balance, minRedemption);
  return `Worth up to ${money(maxDiscountAmount, currency)} off a sale. Tap Redeem loyalty points to use them.`;
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

export interface RedeemMessageContext {
  points?: number | undefined;
  amount?: string | undefined;
  minRedemption?: number | undefined;
  /** The balance the backend confirmed AFTER the write, when it answered. */
  balance?: number | undefined;
}

/**
 * The one status this app raises itself rather than reading off a response:
 * the call never came back, so whether the points moved is genuinely unknown.
 * It must not claim "nothing was charged" — the honest answer is "tap again,
 * and it can't happen twice".
 */
export const NETWORK_UNCONFIRMED = 'network_unconfirmed';

/**
 * The other status this app raises itself: the ledger debit is committed and
 * confirmed, but POS refused the cart discount (no open cart, missing discount
 * permission, an API error). The points ARE gone and the sale is NOT
 * discounted — the one thing this message must never do is say nothing was
 * charged. A retry replays the same attempt id, so the backend answers with
 * the redemption that already happened and the discount lands without a
 * second debit.
 */
export const CART_WRITE_FAILED = 'cart_write_failed';

/** Staff-readable text for every redemption outcome the backend can return. */
export function redeemStatusMessage(status: string, ctx?: RedeemMessageContext): string {
  // Appended to a successful redemption so the finish state answers "what's
  // left?" without staff reopening anything.
  const remaining = ctx?.balance !== undefined ? ` New balance: ${ctx.balance} points.` : '';
  switch (status) {
    case 'applied':
      return ctx?.points !== undefined && ctx.amount !== undefined
        ? `${ctx.points} points redeemed. ${ctx.amount} is off this sale.${remaining}`
        : `Points redeemed and the discount is on this sale.${remaining}`;
    case 'rejected_insufficient_balance':
      return "Not enough points — the confirmed balance is lower than that. Nothing was charged and the sale hasn't changed. Pick a smaller amount and try again.";
    case 'rejected_below_minimum':
      return ctx?.minRedemption !== undefined
        ? `The smallest redemption at this store is ${ctx.minRedemption} points. Nothing was charged.`
        : 'That is below the smallest redemption this store allows. Nothing was charged.';
    case 'rejected_stale_offline_state':
      return "Couldn't confirm the balance, so nothing was charged. Check the connection and try again — the same points can't be taken twice.";
    case NETWORK_UNCONFIRMED:
      return "The connection dropped before the loyalty service answered, so it isn't clear whether these points came off. Tap Try again — if the redemption did land, this replays it instead of taking the points twice.";
    case CART_WRITE_FAILED:
      return ctx?.points !== undefined
        ? `${ctx.points} points were taken, but the discount did NOT go on this sale. Tap Try again to put it on — it re-applies the same redemption and can't take the points twice. If it keeps failing, get a manager before taking payment.`
        : "The points were taken, but the discount did NOT go on this sale. Tap Try again to put it on — it re-applies the same redemption and can't take the points twice. If it keeps failing, get a manager before taking payment.";
    default:
      return "That redemption didn't go through and nothing was charged. Try again in a moment.";
  }
}

export interface RedeemOutcome {
  heading: string;
  tone: 'success' | 'warning' | 'critical';
  message: string;
}

/**
 * Heading, tone and body for a finished redemption attempt. The heading is
 * what a staff member reads first, so a success says the money out loud, and
 * every other heading names the state rather than the colour of the banner.
 */
export function redeemOutcome(status: string, ctx?: RedeemMessageContext): RedeemOutcome {
  const message = redeemStatusMessage(status, ctx);
  switch (status) {
    case 'applied':
      return {
        heading: ctx?.amount !== undefined ? `Done · ${ctx.amount} off this sale` : 'Points redeemed',
        tone: 'success',
        message,
      };
    case NETWORK_UNCONFIRMED:
      return { heading: "Couldn't confirm — try again", tone: 'critical', message };
    case CART_WRITE_FAILED:
      return { heading: 'Points taken — discount not applied', tone: 'critical', message };
    case 'rejected_insufficient_balance':
      return { heading: 'Not enough points', tone: 'warning', message };
    case 'rejected_below_minimum':
      return { heading: 'Below the minimum', tone: 'warning', message };
    case 'rejected_stale_offline_state':
      return { heading: "Couldn't confirm the balance", tone: 'warning', message };
    default:
      return { heading: 'Not applied', tone: 'warning', message };
  }
}
