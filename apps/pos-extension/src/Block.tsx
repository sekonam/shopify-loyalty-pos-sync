/// <reference types="@shopify/ui-extensions/pos.customer-details.block.render" />
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { customerGid, fetchBalance, type BalanceResponse } from './client.js';
import {
  FRESH_FOR_MS,
  balanceView,
  balanceWorthLine,
  failedFetch,
  type FetchState,
} from './state.js';

function Block() {
  const [lastFetch, setLastFetch] = useState<FetchState>(undefined);
  const [info, setInfo] = useState<BalanceResponse | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  // Ticks so a confirmed balance can stop calling itself up to date while the
  // customer-details screen stays open.
  const [now, setNow] = useState(Date.now());
  const [connection, setConnection] = useState(
    shopify.connectivity.current.value.internetConnected,
  );

  useEffect(() => {
    const unsubscribe = shopify.connectivity.current.subscribe((state) => {
      setConnection(state.internetConnected);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), FRESH_FOR_MS / 4);
    return () => clearInterval(timer);
  }, []);

  const load = async (): Promise<void> => {
    try {
      const res = await fetchBalance(customerGid(shopify.customer.id));
      setLastFetch({ ok: true, balance: res.balance, at: new Date() });
      setInfo(res);
    } catch {
      setLastFetch(failedFetch);
    }
    setNow(Date.now());
  };

  /** The one thing to tap when the balance didn't load or has gone cold. */
  const checkAgain = async (): Promise<void> => {
    setChecking(true);
    await load();
    setChecking(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  const view = balanceView({ connection, lastFetch, now });
  const tierName = view.kind === 'live' ? info?.tier?.name : undefined;
  // Only ever paired with a confirmed balance, so it can't imply a live number.
  const worth =
    view.kind === 'live' && info !== undefined
      ? balanceWorthLine({
          balance: view.balance ?? 0,
          minRedemption: info.minRedemption,
          maxDiscountAmount: info.maxDiscountAmount,
          currency: info.currency,
        })
      : undefined;

  return (
    <s-pos-block heading="Loyalty points">
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
            {tierName ? <s-badge tone="info">{tierName}</s-badge> : null}
          </s-stack>
          {worth ? <s-text color="subdued">{worth}</s-text> : null}
          <s-text type="small" color="subdued">
            {view.statusLine}
          </s-text>
          {/*
            A failed or aging read is otherwise a dead end here: the block
            re-fetches only on mount and on a connectivity change, so without
            this there is nothing to tap when the backend blips.
          */}
          {view.fresh === true ? null : (
            <s-button
              id="balance-recheck"
              variant="secondary"
              loading={checking}
              onClick={() => void checkAgain()}
            >
              Check again
            </s-button>
          )}
        </s-stack>
      )}
    </s-pos-block>
  );
}

export default async () => {
  render(<Block />, document.body);
};
