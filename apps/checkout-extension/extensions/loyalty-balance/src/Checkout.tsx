/// <reference types="@shopify/ui-extensions/purchase.checkout.block.render" />
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

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
  maxDiscountAmount: string;
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
        if (!cancelled) setInfo(body);
      })
      .catch(() => {
        if (!cancelled) setHidden(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (hidden) return null;
  if (info === undefined) return <s-text>Loading loyalty balance…</s-text>;

  const redeemDisabled =
    phase.name === 'redeeming' ||
    points <= 0 ||
    points < info.minRedemption ||
    points > info.balance;

  const onRedeem = async () => {
    setPhase({ name: 'redeeming' });
    const attemptId = crypto.randomUUID();
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
      if (attr.type !== 'success' || attr2.type !== 'success') {
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
      setPhase({
        name: 'done',
        tone: 'critical',
        message: "Couldn't reach the loyalty service — your points were not changed.",
      });
    }
  };

  return (
    <s-stack direction="block">
      <s-heading>Loyalty points</s-heading>
      <s-text>{`You have ${info.balance} points (worth up to ${info.maxDiscountAmount}).`}</s-text>
      <s-number-field
        label="Points to redeem"
        value={String(points)}
        min={0}
        onChange={(e: Event) =>
          setPoints(
            Number.parseInt((e.currentTarget as { value?: string } | null)?.value ?? '', 10) || 0,
          )
        }
      ></s-number-field>
      <s-button disabled={redeemDisabled} loading={phase.name === 'redeeming'} onClick={onRedeem}>
        Redeem points
      </s-button>
      {phase.name === 'done' ? (
        <s-banner
          heading={phase.tone === 'success' ? 'Points redeemed' : 'Not applied'}
          tone={phase.tone}
        >
          {phase.message}
        </s-banner>
      ) : null}
    </s-stack>
  );
}

export default async () => {
  render(<Checkout />, document.body);
};
