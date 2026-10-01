/// <reference types="@shopify/ui-extensions/pos.customer-details.action.render" />
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { customerGid, fetchBalance, redeemPoints, type BalanceResponse } from './client.js';
import { balanceView, redeemStatusMessage, type BalanceInputs } from './state.js';

type Phase =
  | { name: 'idle' }
  | { name: 'redeeming' }
  | { name: 'done'; tone: 'success' | 'critical' | 'warning'; message: string };

function Action() {
  const [info, setInfo] = useState<BalanceResponse | undefined>(undefined);
  const [lastFetch, setLastFetch] = useState<BalanceInputs['lastFetch']>(undefined);
  const [connection, setConnection] = useState(
    shopify.connectivity.current.value.internetConnected,
  );
  const [points, setPoints] = useState(0);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });

  useEffect(() => {
    const unsubscribe = shopify.connectivity.current.subscribe((state) => {
      setConnection(state.internetConnected);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchBalance(customerGid(shopify.customer.id))
      .then((res) => {
        if (cancelled) return;
        setInfo(res);
        setLastFetch({ ok: true, balance: res.balance, at: new Date() });
      })
      .catch(() => {
        if (!cancelled) setLastFetch({ ok: false });
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const view = balanceView({ connection, lastFetch });
  const redeemDisabled =
    !view.redeemEnabled ||
    phase.name === 'redeeming' ||
    info === undefined ||
    points <= 0 ||
    points < info.minRedemption ||
    points > (view.balance ?? 0);

  const onRedeem = async () => {
    if (info === undefined) return;
    setPhase({ name: 'redeeming' });
    // The attempt id is minted at the moment staff confirms: a timed-out call
    // retried with the same id can never double-apply (backend contract).
    const attemptId = crypto.randomUUID();
    try {
      const result = await redeemPoints({
        customerId: customerGid(shopify.customer.id),
        points,
        attemptId,
        posDeviceId: String(shopify.session.deviceId ?? ''),
      });
      if (result.status === 'applied' && 'discountAmount' in result) {
        await shopify.cart.applyCartDiscount('FixedAmount', result.discountTitle, result.discountAmount);
        setLastFetch({ ok: true, balance: result.balance, at: new Date() });
        setPhase({ name: 'done', tone: 'success', message: redeemStatusMessage('applied') });
      } else {
        setLastFetch({ ok: true, balance: result.balance, at: new Date() });
        setPhase({ name: 'done', tone: 'warning', message: redeemStatusMessage(result.status) });
      }
    } catch {
      // The write may or may not have landed; the balance shown is no longer
      // confirmed. Same attemptId retry is safe, but we force a re-read first.
      setLastFetch({ ok: false });
      setPhase({
        name: 'done',
        tone: 'critical',
        message: redeemStatusMessage('rejected_stale_offline_state'),
      });
    }
  };

  return (
    <s-page heading="Redeem loyalty points">
      <s-section>
        <s-stack direction="block">
          {view.balance !== undefined ? (
            <s-heading>{`${view.balance} points available`}</s-heading>
          ) : (
            <s-heading>Balance unavailable</s-heading>
          )}
          <s-text color="subdued">{view.statusLine}</s-text>
          {info !== undefined ? (
            <s-text color="subdued">{`Minimum redemption: ${info.minRedemption} points. ${info.redemptionRate} points = 1.00 off.`}</s-text>
          ) : null}
          <s-number-field
            label="Points to redeem"
            value={String(points)}
            min={0}
            onChange={(e: { currentTarget: { value?: string } }) =>
              setPoints(Number.parseInt(e.currentTarget.value ?? '', 10) || 0)
            }
          ></s-number-field>
          <s-button
            variant="primary"
            disabled={redeemDisabled}
            loading={phase.name === 'redeeming'}
            onClick={onRedeem}
          >
            Redeem and apply discount
          </s-button>
          {phase.name === 'done' ? (
            <s-banner
              heading={phase.tone === 'success' ? 'Redeemed' : 'Not applied'}
              tone={phase.tone}
            >
              {phase.message}
            </s-banner>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export default async () => {
  render(<Action />, document.body);
};
