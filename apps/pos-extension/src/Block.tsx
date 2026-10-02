/// <reference types="@shopify/ui-extensions/pos.customer-details.block.render" />
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { customerGid, fetchBalance, type BalanceResponse } from './client.js';
import { balanceView, failedFetch, type FetchState } from './state.js';

function Block() {
  const [lastFetch, setLastFetch] = useState<FetchState>(undefined);
  const [info, setInfo] = useState<BalanceResponse | undefined>(undefined);
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
    let cancelled = false;
    fetchBalance(customerGid(shopify.customer.id))
      .then((res) => {
        if (cancelled) return;
        setLastFetch({ ok: true, balance: res.balance, at: new Date() });
        setInfo(res);
      })
      .catch(() => {
        if (!cancelled) setLastFetch(failedFetch);
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const view = balanceView({ connection, lastFetch });
  const tierName = view.kind === 'live' ? info?.tier?.name : undefined;
  // Only ever paired with a confirmed balance, so it can't imply a live number.
  const worth =
    view.kind === 'live' && info !== undefined && (view.balance ?? 0) > 0
      ? `Worth up to ${info.maxDiscountAmount} off a sale.`
      : view.kind === 'live'
        ? 'No points yet — they start adding up with the next sale.'
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
        </s-stack>
      )}
    </s-pos-block>
  );
}

export default async () => {
  render(<Block />, document.body);
};
