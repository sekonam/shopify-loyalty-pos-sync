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
 */
function money(amount: string | number, currency?: string | null): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return String(amount);
  const code = currency ?? presentmentCurrency();
  if (code) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(value);
    } catch {
      // Unknown currency code — fall through to the plain amount.
    }
  }
  return value.toFixed(2);
}

type Phase =
  | { name: 'idle' }
  | { name: 'redeeming' }
  | { name: 'done'; tone: 'success' | 'warning' | 'critical'; message: string };

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
  const [points, setPoints] = useState(0);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  // One redemption per checkout: a second ledger debit would overwrite (not
  // accumulate) the single discount attribute, charging points for nothing.
  const [redeemed, setRedeemed] = useState(false);
  // Survives a failed call so a retry replays the SAME attempt (idempotent
  // on the backend) instead of double-debiting; cleared on definitive outcome.
  const attemptIdRef = useRef<string | undefined>(undefined);
  const [referral, setReferral] = useState<ReferralInfo | undefined>(undefined);
  const [friendCode, setFriendCode] = useState('');
  const [friendCodeState, setFriendCodeState] = useState<'idle' | 'applied' | 'failed'>('idle');

  useEffect(() => {
    if (backendUrl() === '') {
      setHidden(true);
      return;
    }
    let cancelled = false;
    // No customerId: the backend reads the customer from the token's sub.
    // Signed-out checkouts get a 400 back and the block stays hidden.
    authedFetch('/api/balance')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
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
        if (!cancelled) setHidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onApplyFriendCode = async () => {
    const code = friendCode.trim().toUpperCase();
    if (code === '') return;
    const result = await shopify.applyAttributeChange({
      type: 'updateAttribute',
      key: 'loyalty_referral',
      value: code,
    });
    setFriendCodeState(result.type === 'success' ? 'applied' : 'failed');
  };

  if (hidden) return null;
  if (info === undefined) {
    return (
      <s-stack direction="inline" gap="small-100" alignItems="center">
        <s-spinner accessibilityLabel="Loading your points" />
        <s-text color="subdued">Loading your points…</s-text>
      </s-stack>
    );
  }

  const rate = Number(info.redemptionRate);
  const canConvert = Number.isFinite(rate) && rate > 0;
  const enoughToRedeem = info.balance >= info.minRedemption;
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
  const preview =
    canConvert && points > 0 && amountIssue === undefined
      ? `${points} points → ${money(points / rate, info.currency)} off this order`
      : undefined;

  const redeemDisabled =
    redeemed ||
    phase.name === 'redeeming' ||
    points <= 0 ||
    amountIssue !== undefined;

  /** A different amount is a different attempt, so the id is re-minted. */
  const setAmount = (next: number): void => {
    if (next === points) return;
    attemptIdRef.current = undefined;
    setPoints(next);
    if (phase.name === 'done') setPhase({ name: 'idle' });
  };

  const onRedeem = async () => {
    setPhase({ name: 'redeeming' });
    const attemptId = attemptIdRef.current ?? crypto.randomUUID();
    attemptIdRef.current = attemptId;
    try {
      const res = await authedFetch('/api/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ points, attemptId, channel: 'web' }),
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
          tone: 'warning',
          message:
            body.status === 'rejected_insufficient_balance'
              ? "You don't have that many points, so nothing was taken. Try a smaller amount."
              : body.status === 'rejected_below_minimum'
                ? `The smallest redemption is ${info.minRedemption} points.`
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
          tone: 'critical',
          message:
            'Your points were set aside but the discount could not be added to this order. Contact the store and they can put the points back.',
        });
        return;
      }
      setInfo({ ...info, balance: body.balance });
      setPhase({
        name: 'done',
        tone: 'success',
        message: `${points} points redeemed — ${money(body.discountAmount, info.currency)} off this order.`,
      });
    } catch {
      // attemptIdRef kept: pressing Redeem again replays the same attempt.
      setPhase({
        name: 'done',
        tone: 'critical',
        message: "We couldn't reach your points balance. Try again — you won't be charged twice.",
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
          <s-number-field
            id="points-field"
            label="Points to redeem"
            value={String(points)}
            min={0}
            max={info.balance}
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
          {preview ? (
            <s-text id="redeem-preview" type="strong">
              {preview}
            </s-text>
          ) : null}
          <s-button
            id="redeem-submit"
            variant="primary"
            disabled={redeemDisabled}
            loading={phase.name === 'redeeming'}
            onClick={onRedeem}
          >
            Redeem points
          </s-button>
        </s-stack>
      ) : (
        <s-text color="subdued">
          {`${info.minRedemption - info.balance} more points and you can start redeeming.`}
        </s-text>
      )}
      {phase.name === 'done' ? (
        <s-banner
          heading={phase.tone === 'success' ? 'Points redeemed' : 'Not applied'}
          tone={phase.tone}
        >
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
                  disabled={friendCode.trim() === ''}
                  onClick={onApplyFriendCode}
                >
                  Apply referral code
                </s-button>
                {friendCodeState === 'failed' ? (
                  <s-text tone="critical">
                    That code couldn't be added to this order. Check it and try again.
                  </s-text>
                ) : null}
              </s-stack>
            ) : null}
            {friendCodeState === 'applied' ? (
              <s-text tone="success">
                Referral code applied — the bonus points land once this order is paid.
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
