/// <reference types="@shopify/ui-extensions/purchase.checkout.block.render" />
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * Checkout block: shows the signed-in customer's live balance and lets them
 * redeem. Identity comes from the session token's `sub` claim, verified by
 * the backend — this extension never names a customer id. The redemption is
 * written to the ledger FIRST (atomic backend call); only a confirmed
 * redemption is mirrored into cart attributes, which the discount Function
 * then materializes. One write path, shared with POS.
 *
 * Reading order on screen: what you have, then what you can spend here, then
 * the referral program. Nothing below the fold competes with the balance.
 *
 * The shopper is mid-purchase, usually one-handed on a phone, and did not come
 * here to do arithmetic: the common case ("use my points") is a single tap on
 * a button that already names the money it takes off, and typing an amount is
 * the fallback rather than the default.
 */

interface BalanceResponse {
  balance: number;
  minRedemption: number;
  redemptionRate: string;
  currency: string | null;
  tier: { name: string; multiplier: string; earned365: number } | null;
  /** Backend-computed: this customer has no purchase earns yet and the program is on. */
  referralEligible: boolean | null;
  maxDiscountAmount: string;
}

interface ReferralInfo {
  code: string;
  advocatePoints: number;
  friendPoints: number;
}

/** Presentment currency of this checkout, from the cost API. */
function presentmentCurrency(): string | undefined {
  const total = (shopify as unknown as { cost?: { totalAmount?: { value?: { currencyCode?: string } } } })
    .cost?.totalAmount?.value;
  return total?.currencyCode;
}

/**
 * Amounts arrive from the backend as plain decimal strings. Shoppers read
 * prices, not decimals, so they get the buyer's own currency formatting —
 * falling back to the bare amount if the runtime can't format that code.
 *
 * Floored to whole cents, the way the backend prices a redemption, so a figure
 * printed on a button is never a cent more than what comes off the order. The
 * epsilon absorbs binary-float dust (0.29 * 100 = 28.999999999999996).
 */
function money(amount: string | number, currency?: string | null): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return String(amount);
  const floored = Math.floor(value * 100 + 1e-6) / 100;
  const code = currency ?? presentmentCurrency();
  if (code) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code,
        // Match the storefront's own money: "$45.00", not "US$45.00".
        currencyDisplay: 'narrowSymbol',
      }).format(floored);
    } catch {
      // Unknown currency code — fall through to the plain amount.
    }
  }
  return floored.toFixed(2);
}

type QuickPickLabel = 'Minimum' | 'Half' | 'All';

interface QuickPick {
  points: number;
  label: QuickPickLabel;
}

/**
 * The one-tap amounts: the smallest allowed redemption, a round half, and
 * everything. Deduped and never above the balance — an empty list means there
 * is nothing to redeem.
 *
 * Deliberately the same rule as the POS extension's `quickPicks` (see
 * apps/pos-extension/src/state.ts). The two surfaces are separately bundled
 * packages with no shared dependency, so this is a twin rather than an import;
 * it belongs in `packages/ledger` beside the other redemption rules the day
 * that package is next opened.
 */
function quickPicks(balance: number, minRedemption: number): QuickPick[] {
  if (minRedemption <= 0 || balance < minRedemption) return [];
  const picks: QuickPick[] = [];
  const add = (points: number, label: QuickPickLabel) => {
    if (points < minRedemption || points > balance) return;
    if (picks.some((pick) => pick.points === points)) return;
    picks.push({ points, label });
  };
  add(minRedemption, 'Minimum');
  // Half, rounded down to a whole multiple of the minimum, so the suggestion
  // is a number a person would actually choose.
  add(Math.floor(balance / 2 / minRedemption) * minRedemption, 'Half');
  add(balance, 'All');
  // Biggest first: "use all my points" is what most shoppers came to do.
  return picks.sort((a, b) => b.points - a.points);
}

type Phase =
  | { name: 'idle' }
  | { name: 'redeeming' }
  | { name: 'done'; heading: string; tone: 'success' | 'warning' | 'critical'; message: string };

function backendUrl(): string {
  const settings = shopify.settings.value as { backend_url?: string } | undefined;
  return (settings?.backend_url ?? '').replace(/\/$/, '');
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await shopify.sessionToken.get();
  return fetch(`${backendUrl()}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
  });
}

function Checkout() {
  const [info, setInfo] = useState<BalanceResponse | undefined>(undefined);
  const [hidden, setHidden] = useState(false);
  // A balance that could not be read is NOT the same as one that doesn't
  // apply: hiding the block on a transient backend failure silently charges a
  // shopper with points the full price. Failures get a line and a retry.
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [points, setPoints] = useState(0);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  // One redemption per checkout: a second ledger debit would overwrite (not
  // accumulate) the single discount attribute, charging points for nothing.
  const [redeemed, setRedeemed] = useState(false);
  // Which control is mid-flight, so the spinner lands on the button the
  // shopper actually tapped rather than on all of them.
  const [pending, setPending] = useState<string | undefined>(undefined);
  // Survives a failed call so a retry replays the SAME attempt (idempotent
  // on the backend) instead of double-debiting; cleared on definitive outcome.
  const attemptIdRef = useRef<string | undefined>(undefined);
  const [referral, setReferral] = useState<ReferralInfo | undefined>(undefined);
  const [friendCode, setFriendCode] = useState('');
  const [friendCodeState, setFriendCodeState] = useState<'idle' | 'applied' | 'failed' | 'own'>(
    'idle',
  );

  useEffect(() => {
    if (backendUrl() === '') {
      setHidden(true);
      return;
    }
    let cancelled = false;
    setFailed(false);
    // No customerId: the backend reads the customer from the token's sub.
    // Signed-out checkouts get a 400 back and the block stays hidden.
    authedFetch('/api/balance')
      .then(async (res) => {
        if (cancelled) return;
        // Not applicable to this shopper (signed out, or no access): say
        // nothing at all. Anything else is a failure to recover from.
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          setHidden(true);
          return;
        }
        if (!res.ok) {
          setFailed(true);
          return;
        }
        const body = (await res.json()) as BalanceResponse;
        if (cancelled) return;
        // v1 is single-currency: redemptions are priced in the shop currency,
        // so a checkout presented in a different currency gets no widget.
        const presentment = presentmentCurrency();
        if (body.currency && presentment && body.currency !== presentment) {
          setHidden(true);
          return;
        }
        setInfo(body);
        // Referral program info is optional (404 when disabled) — never blocks.
        authedFetch('/api/referral-code')
          .then(async (r) => {
            if (r.ok && !cancelled) setReferral((await r.json()) as ReferralInfo);
          })
          .catch(() => undefined);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloads]);

  const onApplyFriendCode = async () => {
    const code = friendCode.trim().toUpperCase();
    if (code === '') return;
    // Your own code pays nothing, and the backend drops it silently — so say
    // so here instead of reporting a bonus that is never coming.
    if (referral !== undefined && code === referral.code.toUpperCase()) {
      setFriendCodeState('own');
      return;
    }
    const result = await shopify.applyAttributeChange({
      type: 'updateAttribute',
      key: 'loyalty_referral',
      value: code,
    });
    setFriendCodeState(result.type === 'success' ? 'applied' : 'failed');
  };

  if (hidden) return null;
  if (info === undefined) {
    return failed ? (
      <s-stack id="loyalty-points" direction="block" gap="small-200">
        <s-heading>Loyalty points</s-heading>
        <s-text color="subdued">
          We couldn&apos;t load your points just now. You can keep checking out — nothing has been
          charged, and your points are safe.
        </s-text>
        <s-button
          id="balance-retry"
          variant="secondary"
          inlineSize="fill"
          onClick={() => setReloads((n) => n + 1)}
        >
          Try again
        </s-button>
      </s-stack>
    ) : (
      <s-stack direction="inline" gap="small-100" alignItems="center">
        <s-spinner accessibilityLabel="Loading your points" />
        <s-text color="subdued">Loading your points…</s-text>
      </s-stack>
    );
  }

  const rate = Number(info.redemptionRate);
  const canConvert = Number.isFinite(rate) && rate > 0;
  const enoughToRedeem = info.balance >= info.minRedemption;
  /** What `points` takes off the order, floored to cents like the backend. */
  const offFor = (amount: number): string => money(amount / rate, info.currency);
  // Only ever names a number the backend would accept, so the preview can't
  // promise a discount the redeem call would then refuse.
  const amountIssue =
    points <= 0
      ? undefined
      : points < info.minRedemption
        ? `Enter at least ${info.minRedemption} points.`
        : points > info.balance
          ? `You only have ${info.balance} points.`
          : undefined;
  const picks = canConvert ? quickPicks(info.balance, info.minRedemption) : [];

  const redeemDisabled =
    redeemed ||
    phase.name === 'redeeming' ||
    points <= 0 ||
    amountIssue !== undefined ||
    !canConvert;
  // The primary button says the consequence in money, not "Redeem" — and
  // after a call that didn't come back it names the recovery instead.
  const retrying = phase.name === 'done' && phase.tone === 'critical';
  const customLabel = redeemDisabled
    ? 'Enter an amount to redeem'
    : retrying
      ? `Try again — take ${offFor(points)} off`
      : `Take ${offFor(points)} off this order`;

  /** A different amount is a different attempt, so the id is re-minted. */
  const setAmount = (next: number): void => {
    if (next === points) return;
    attemptIdRef.current = undefined;
    setPoints(next);
    if (phase.name === 'done') setPhase({ name: 'idle' });
  };

  const onRedeem = async (amount: number, control: string) => {
    // Guarded here rather than only on the button: a one-tap control must
    // never fire an amount the backend would reject.
    if (redeemed || phase.name === 'redeeming' || !canConvert) return;
    if (amount < info.minRedemption || amount > info.balance) return;
    setPending(control);
    setPhase({ name: 'redeeming' });
    const attemptId = attemptIdRef.current ?? crypto.randomUUID();
    attemptIdRef.current = attemptId;
    try {
      const res = await authedFetch('/api/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ points: amount, attemptId, channel: 'web' }),
      });
      const body = (await res.json()) as {
        status: string;
        balance: number;
        discountAmount?: string;
      };
      // Definitive answer from the backend either way.
      attemptIdRef.current = undefined;
      if (body.status !== 'applied' || body.discountAmount === undefined) {
        setInfo({ ...info, balance: body.balance ?? info.balance });
        setPhase({
          name: 'done',
          heading: 'Not applied',
          tone: 'warning',
          message:
            body.status === 'rejected_insufficient_balance'
              ? "You don't have that many points, so nothing was taken. Try a smaller amount."
              : body.status === 'rejected_below_minimum'
                ? `The smallest redemption is ${info.minRedemption} points, and nothing was taken.`
                : "That didn't go through, and no points were taken. Try again in a moment.",
        });
        return;
      }
      setRedeemed(true); // the debit landed — never offer a second one here
      const attr = await shopify.applyAttributeChange({
        type: 'updateAttribute',
        key: 'loyalty_discount',
        value: body.discountAmount,
      });
      const attr2 = await shopify.applyAttributeChange({
        type: 'updateAttribute',
        key: 'loyalty_attempt',
        value: attemptId,
      });
      const attr3 = await shopify.applyAttributeChange({
        type: 'updateAttribute',
        key: 'loyalty_currency',
        value: info.currency ?? presentmentCurrency() ?? '',
      });
      if (attr.type !== 'success' || attr2.type !== 'success' || attr3.type !== 'success') {
        setPhase({
          name: 'done',
          heading: 'Discount not added',
          tone: 'critical',
          message:
            'Your points were set aside but the discount could not be added to this order. Your card has not been charged — contact the store and they can put the points back.',
        });
        return;
      }
      setInfo({ ...info, balance: body.balance });
      setPhase({
        name: 'done',
        heading: 'Points redeemed',
        tone: 'success',
        message: `${amount} points redeemed — ${money(body.discountAmount, info.currency)} off this order. ${body.balance} points left.`,
      });
    } catch {
      // attemptIdRef kept: pressing the button again replays the same attempt.
      setPhase({
        name: 'done',
        heading: "Couldn't confirm",
        tone: 'critical',
        message:
          "We couldn't confirm that redemption. Your card has not been charged. Try again — you won't be charged twice.",
      });
    }
  };

  const showReferralSection = referral !== undefined || info.referralEligible === true;

  return (
    <s-stack id="loyalty-points" direction="block" gap="base">
      <s-heading>Loyalty points</s-heading>

      {/* 1 — what you have */}
      <s-stack direction="block" gap="small-400">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text id="loyalty-balance" type="strong">{`${info.balance} points`}</s-text>
          {info.tier?.name ? <s-badge>{info.tier.name}</s-badge> : null}
        </s-stack>
        <s-text color="subdued">
          {info.balance > 0
            ? `Worth up to ${money(info.maxDiscountAmount, info.currency)} off.`
            : 'Your first points land when this order is paid.'}
        </s-text>
        {info.tier?.name ? (
          <s-text type="small" color="subdued">
            {`Earning ${info.tier.multiplier}× points on every order.`}
          </s-text>
        ) : null}
      </s-stack>

      {/* 2 — what you can spend here */}
      <s-divider />
      {redeemed ? null : enoughToRedeem ? (
        <s-stack direction="block" gap="small-200">
          {/*
            The common case in one tap, with the money on the control itself.
            Full-width targets: this is a phone, usually one-handed.
          */}
          {picks.map((pick) => (
            <s-button
              key={pick.points}
              id={`quick-pick-${pick.label.toLowerCase()}`}
              variant={pick.label === 'All' ? 'primary' : 'secondary'}
              inlineSize="fill"
              disabled={phase.name === 'redeeming'}
              loading={phase.name === 'redeeming' && pending === `pick-${pick.points}`}
              accessibilityLabel={`Use ${pick.label === 'All' ? 'all ' : ''}${pick.points} points for ${offFor(pick.points)} off this order`}
              onClick={() => {
                setAmount(pick.points);
                void onRedeem(pick.points, `pick-${pick.points}`);
              }}
            >
              {`Use ${pick.label === 'All' ? 'all ' : ''}${pick.points} points · ${offFor(pick.points)} off`}
            </s-button>
          ))}
          {/*
            Said once, before the tap, because it is the thing a shopper
            hesitates over. It matches what the backend actually does: a refund
            reverses points EARNED on the order (earn-policy.ts), and nothing
            automatically returns points already spent — a human puts those
            back with a manual adjustment. So this promises a conversation, not
            an automatic reversal.
          */}
          <s-text id="redeem-reassurance" type="small" color="subdued">
            Points leave your balance as soon as you redeem. If this order is refunded, the store can
            put them back — just ask.
          </s-text>
          <s-divider />
          <s-number-field
            id="points-field"
            label={picks.length > 0 ? 'Or redeem a different amount' : 'Points to redeem'}
            value={String(points)}
            min={0}
            max={info.balance}
            step={info.minRedemption}
            inputMode="numeric"
            {...(amountIssue !== undefined ? { error: amountIssue } : {})}
            onChange={(e: Event) => {
              setAmount(
                Number.parseInt((e.currentTarget as { value?: string } | null)?.value ?? '', 10) ||
                  0,
              );
            }}
          ></s-number-field>
          <s-text type="small" color="subdued">
            {canConvert
              ? `${info.minRedemption} points minimum · ${info.redemptionRate} points = ${money(1, info.currency)} off`
              : `${info.minRedemption} points minimum`}
          </s-text>
          <s-button
            id="redeem-submit"
            variant={picks.length > 0 ? 'secondary' : 'primary'}
            inlineSize="fill"
            disabled={redeemDisabled}
            loading={phase.name === 'redeeming' && pending === 'field'}
            onClick={() => void onRedeem(points, 'field')}
          >
            {customLabel}
          </s-button>
        </s-stack>
      ) : (
        <s-text color="subdued">
          {`${info.minRedemption - info.balance} more points and you can start redeeming.`}
        </s-text>
      )}
      {phase.name === 'done' ? (
        <s-banner heading={phase.heading} tone={phase.tone}>
          {phase.message}
        </s-banner>
      ) : null}

      {/* 3 — the referral program, last */}
      {showReferralSection ? (
        <>
          <s-divider />
          <s-stack direction="block" gap="small-300">
            <s-text type="strong">Invite a friend</s-text>
            {referral ? (
              <s-stack
                direction="block"
                gap="small-300"
                background="subdued"
                border="base"
                borderRadius="base"
                padding="base"
              >
                <s-text type="small" color="subdued">
                  Share your code
                </s-text>
                <s-text id="referral-code" type="strong">
                  {referral.code}
                </s-text>
                <s-text color="subdued">
                  {`They get ${referral.friendPoints} points on their first order — you get ${referral.advocatePoints}.`}
                </s-text>
              </s-stack>
            ) : null}
            {info.referralEligible === true && friendCodeState !== 'applied' ? (
              <s-stack direction="block" gap="small-200">
                <s-text-field
                  id="friend-code-field"
                  label="Referral code from a friend"
                  value={friendCode}
                  onChange={(e: Event) =>
                    setFriendCode((e.currentTarget as { value?: string } | null)?.value ?? '')
                  }
                ></s-text-field>
                <s-button
                  id="friend-code-submit"
                  inlineSize="fill"
                  disabled={friendCode.trim() === ''}
                  onClick={onApplyFriendCode}
                >
                  Apply referral code
                </s-button>
                {friendCodeState === 'failed' ? (
                  <s-text tone="critical">
                    That code couldn&apos;t be added to this order. Check it and try again.
                  </s-text>
                ) : null}
                {friendCodeState === 'own' ? (
                  <s-text tone="critical">
                    That&apos;s your own code — share it with a friend instead.
                  </s-text>
                ) : null}
              </s-stack>
            ) : null}
            {friendCodeState === 'applied' ? (
              // Honest: nothing has validated this code yet. The reward is
              // decided when the order is paid, and an unknown code is simply
              // ignored there — so this says "added", not "accepted".
              <s-text tone="success">
                Referral code added. We&apos;ll check it when this order is paid, and the bonus
                points land then.
              </s-text>
            ) : null}
          </s-stack>
        </>
      ) : null}
    </s-stack>
  );
}

export default async () => {
  render(<Checkout />, document.body);
};
