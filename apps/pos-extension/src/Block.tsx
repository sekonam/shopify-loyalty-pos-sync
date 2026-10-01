/// <reference types="@shopify/ui-extensions/pos.customer-details.block.render" />
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { customerGid, fetchBalance } from './client.js';
import { balanceView, failedFetch, type FetchState } from './state.js';

function Block() {
  const [lastFetch, setLastFetch] = useState<FetchState>(undefined);
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
        if (!cancelled) setLastFetch({ ok: true, balance: res.balance, at: new Date() });
      })
      .catch(() => {
        if (!cancelled) setLastFetch(failedFetch);
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const view = balanceView({ connection, lastFetch });
  return (
    <s-pos-block>
      <s-stack direction="block">
        <s-heading>Loyalty points</s-heading>
        {view.balance !== undefined ? (
          <s-text>{`${view.balance} points`}</s-text>
        ) : (
          <s-text color="subdued">—</s-text>
        )}
        <s-text color="subdued">{view.statusLine}</s-text>
        {view.kind === 'live' ? (
          <s-badge tone="success">Synced</s-badge>
        ) : view.kind === 'loading' ? null : (
          <s-badge tone="warning">Not live</s-badge>
        )}
      </s-stack>
    </s-pos-block>
  );
}

export default async () => {
  render(<Block />, document.body);
};
