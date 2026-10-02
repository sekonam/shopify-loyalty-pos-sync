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
  if (info === undefined) return <s-text>Loading loyalty balance…</s-text>;

  const redeemDisabled =
    redeemed ||
    phase.name === 'redeeming' ||
    points <= 0 ||
    points < info.minRedemption ||
    points > info.balance;

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
              ? 'Not enough points for that redemption.'
              : body.status === 'rejected_below_minimum'
                ? `Minimum redemption is ${info.minRedemption} points.`
                : 'Redemption was not applied.',
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
            'Points were reserved but the discount could not be attached to this checkout. Contact the store to restore your points.',
        });
        return;
      }
      setInfo({ ...info, balance: body.balance });
      setPhase({
        name: 'done',
        tone: 'success',
        message: `${points} points redeemed — ${body.discountAmount} off applied.`,
      });
    } catch {
      // attemptIdRef kept: pressing Redeem again replays the same attempt.
      setPhase({
        name: 'done',
        tone: 'critical',
        message: "Couldn't reach the loyalty service. Try again — you won't be charged twice.",
      });
    }
  };

  return (
    <s-stack direction="block">
      <s-heading>Loyalty points</s-heading>
      <s-text>{`You have ${info.balance} points (worth up to ${info.maxDiscountAmount}).`}</s-text>
      {info.tier?.name ? (
        <s-text>{`${info.tier.name} member — ${info.tier.multiplier}× points on every order.`}</s-text>
      ) : null}
      {redeemed ? null : (
        <s-number-field
          label="Points to redeem"
          value={String(points)}
          min={0}
          onChange={(e: Event) => {
            attemptIdRef.current = undefined; // new amount = new attempt
            setPoints(
              Number.parseInt((e.currentTarget as { value?: string } | null)?.value ?? '', 10) ||
                0,
            );
          }}
        ></s-number-field>
      )}
      {redeemed ? null : (
        <s-button disabled={redeemDisabled} loading={phase.name === 'redeeming'} onClick={onRedeem}>
          Redeem points
        </s-button>
      )}
      {phase.name === 'done' ? (
        <s-banner
          heading={phase.tone === 'success' ? 'Points redeemed' : 'Not applied'}
          tone={phase.tone}
        >
          {phase.message}
        </s-banner>
      ) : null}
      {info.referralEligible === true && friendCodeState !== 'applied' ? (
        <s-stack direction="block">
          <s-text-field
            label="Have a referral code?"
            value={friendCode}
            onChange={(e: Event) =>
              setFriendCode((e.currentTarget as { value?: string } | null)?.value ?? '')
            }
          ></s-text-field>
          <s-button onClick={onApplyFriendCode}>Apply referral code</s-button>
          {friendCodeState === 'failed' ? (
            <s-text tone="critical">Couldn't attach the code to this checkout.</s-text>
          ) : null}
        </s-stack>
      ) : null}
      {friendCodeState === 'applied' ? (
        <s-text>Referral code applied — the bonus lands after this order is paid.</s-text>
      ) : null}
      {referral ? (
        <s-text color="subdued">{`Share your code ${referral.code} — you get ${referral.advocatePoints} points, friends get ${referral.friendPoints}.`}</s-text>
      ) : null}
    </s-stack>
  );
}

export default async () => {
  render(<Checkout />, document.body);
};
