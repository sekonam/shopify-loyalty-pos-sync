/// <reference types="@shopify/ui-extensions/pos.customer-details.action.render" />
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { customerGid, fetchBalance, redeemPoints, type BalanceResponse } from './client.js';
import {
  amountIssue,
  balanceView,
  discountValue,
  failedFetch,
  formatAmount,
  quickPicks,
  redeemStatusMessage,
  type FetchState,
} from './state.js';

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

  /**
   * A different amount is a different attempt, so the id is re-minted — but
   * only on a real change: re-selecting the amount already in the field must
   * not throw away an in-doubt attempt id that a retry needs to replay.
   */
  const setAmount = (next: number): void => {
    if (next === points) return;
    attemptIdRef.current = undefined;
    setPoints(next);
    if (phase.name === 'done') setPhase({ name: 'idle' });
  };

  const issue = amountIssue({
    points,
    balance: view.balance,
    minRedemption: info?.minRedemption,
  });
  const redeemDisabled =
    !view.redeemEnabled ||
    phase.name === 'redeeming' ||
    info === undefined ||
    points <= 0 ||
    issue !== undefined;

  const value =
    info !== undefined && points > 0 ? discountValue(points, info.redemptionRate) : undefined;
  // Previewed only for an amount that could actually go through, so the number
  // on screen is never a promise the backend would refuse.
  const preview =
    value !== undefined && issue === undefined
      ? `${points} points → ${formatAmount(value)} off this sale`
      : undefined;
  const picks =
    view.kind === 'live' && view.balance !== undefined && info !== undefined
      ? quickPicks(view.balance, info.minRedemption)
      : [];
  const rules =
    info !== undefined
      ? `${info.minRedemption} points minimum · ${info.redemptionRate} points = 1.00 off`
      : undefined;
  const succeeded = phase.name === 'done' && phase.tone === 'success';

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
        setPhase({
          name: 'done',
          tone: 'success',
          message: redeemStatusMessage('applied', {
            points,
            amount: result.discountAmount,
          }),
        });
      } else {
        setLastFetch({ ok: true, balance: result.balance, at: new Date() });
        setPhase({
          name: 'done',
          tone: 'warning',
          message: redeemStatusMessage(result.status, { minRedemption: info.minRedemption }),
        });
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
    <s-page heading="Redeem points">
      <s-section>
        <s-stack direction="block" gap="base">
          {view.kind === 'loading' ? (
            <s-stack direction="inline" gap="small-100" alignItems="center">
              <s-spinner accessibilityLabel="Checking the loyalty balance" />
              <s-text color="subdued">{view.statusLine}</s-text>
            </s-stack>
          ) : (
            <s-stack direction="block" gap="small-300">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-heading id="loyalty-balance">
                  {view.balance !== undefined ? `${view.balance} points` : 'Balance unavailable'}
                </s-heading>
                {view.badge ? <s-badge tone={view.badge.tone}>{view.badge.label}</s-badge> : null}
              </s-stack>
              {view.kind === 'live' && info !== undefined && (view.balance ?? 0) > 0 ? (
                <s-text color="subdued">{`Worth up to ${info.maxDiscountAmount} off this sale.`}</s-text>
              ) : null}
              {view.kind === 'live' ? (
                <s-text type="small" color="subdued">
                  {view.statusLine}
                </s-text>
              ) : null}
            </s-stack>
          )}

          {/* The one reason redemption is off, said once, with the way out. */}
          {view.kind !== 'loading' && !view.redeemEnabled ? (
            <s-banner heading="Can't redeem right now" tone="warning">
              {view.statusLine}
            </s-banner>
          ) : null}

          {succeeded && phase.name === 'done' ? (
            <s-banner heading="Points redeemed" tone="success">
              {phase.message}
            </s-banner>
          ) : (
            <>
              <s-divider />
              <s-stack direction="block" gap="small-200">
                {picks.length > 0 ? (
                  <s-stack direction="block" gap="small-300">
                    <s-text type="strong">How many points?</s-text>
                    <s-stack direction="inline" gap="small-200">
                      {picks.map((pick) => (
                        <s-button
                          key={pick.points}
                          id={`quick-pick-${pick.label.toLowerCase()}`}
                          variant="secondary"
                          onClick={() => setAmount(pick.points)}
                        >
                          {`${pick.label} · ${pick.points} pts`}
                        </s-button>
                      ))}
                    </s-stack>
                  </s-stack>
                ) : null}
                {/*
                  controls="none" is deliberate: stepper controls drop the
                  label, details and error text, and +/- is useless at
                  100-point minimums — the quick picks above are the fast path.
                */}
                <s-number-field
                  id="points-field"
                  label="Points to redeem"
                  value={String(points)}
                  min={0}
                  {...(view.balance !== undefined ? { max: view.balance } : {})}
                  inputMode="numeric"
                  controls="none"
                  disabled={!view.redeemEnabled || phase.name === 'redeeming'}
                  details={rules}
                  error={issue}
                  onChange={(e: { currentTarget: { value?: string } }) => {
                    setAmount(Number.parseInt(e.currentTarget.value ?? '', 10) || 0);
                  }}
                ></s-number-field>
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
                  {points > 0 ? `Redeem ${points} points` : 'Redeem points'}
                </s-button>
                {phase.name === 'done' ? (
                  <s-banner
                    heading={phase.tone === 'critical' ? "Couldn't confirm" : 'Not applied'}
                    tone={phase.tone}
                  >
                    {phase.message}
                  </s-banner>
                ) : null}
              </s-stack>
            </>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export default async () => {
  render(<Action />, document.body);
};
