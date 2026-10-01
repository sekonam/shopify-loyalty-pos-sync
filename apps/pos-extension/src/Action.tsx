/// <reference types="@shopify/ui-extensions/pos.customer-details.action.render" />
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { customerGid, fetchBalance, redeemPoints, type BalanceResponse } from './client.js';
import { balanceView, failedFetch, redeemStatusMessage, type FetchState } from './state.js';

type Phase =
  | { name: 'idle' }
  | { name: 'redeeming' }
  | { name: 'done'; tone: 'success' | 'critical' | 'warning'; message: string };

function Action() {
  const [info, setInfo] = useState<BalanceResponse | undefined>(undefined);
  const [lastFetch, setLastFetch] = useState<FetchState>(undefined);
  // The attempt id survives a failed call: a retry after a timeout whose
  // server write actually committed must reuse the SAME id so the backend's
  // idempotent replay answers instead of double-debiting. It is cleared only
  // on a definitive outcome, and re-minted when the points amount changes.
  const attemptIdRef = useRef<string | undefined>(undefined);
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

  const loadBalance = async (): Promise<void> => {
    try {
      const res = await fetchBalance(customerGid(shopify.customer.id));
      setInfo(res);
      setLastFetch({ ok: true, balance: res.balance, at: new Date() });
    } catch {
      setLastFetch(failedFetch);
    }
  };

  useEffect(() => {
    void loadBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const attemptId = attemptIdRef.current ?? crypto.randomUUID();
    attemptIdRef.current = attemptId;
    try {
      const result = await redeemPoints({
        customerId: customerGid(shopify.customer.id),
        points,
        attemptId,
        posDeviceId: String(shopify.session.deviceId ?? ''),
      });
      // Definitive outcome either way: the next redemption is a new attempt.
      attemptIdRef.current = undefined;
      if (result.status === 'applied' && 'discountAmount' in result) {
        await shopify.cart.applyCartDiscount('FixedAmount', result.discountTitle, result.discountAmount);
        setLastFetch({ ok: true, balance: result.balance, at: new Date() });
        setPhase({ name: 'done', tone: 'success', message: redeemStatusMessage('applied') });
      } else {
        setLastFetch({ ok: true, balance: result.balance, at: new Date() });
        setPhase({ name: 'done', tone: 'warning', message: redeemStatusMessage(result.status) });
      }
    } catch {
      // The write may or may not have landed. attemptIdRef is kept, so a
      // retry replays the same attempt instead of double-debiting; the shown
      // balance is downgraded to unconfirmed and re-read so retry re-enables.
      setLastFetch(failedFetch);
      setPhase({
        name: 'done',
        tone: 'critical',
        message: redeemStatusMessage('rejected_stale_offline_state'),
      });
      void loadBalance();
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
            onChange={(e: { currentTarget: { value?: string } }) => {
              attemptIdRef.current = undefined; // new amount = new attempt
              setPoints(Number.parseInt(e.currentTarget.value ?? '', 10) || 0);
            }}
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
