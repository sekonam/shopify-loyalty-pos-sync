/// <reference types="@shopify/ui-extensions/pos.customer-details.action.render" />
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { customerGid, fetchBalance, redeemPoints, type BalanceResponse } from './client.js';
import {
  CART_WRITE_FAILED,
  FRESH_FOR_MS,
  NETWORK_UNCONFIRMED,
  amountIssue,
  balanceView,
  cumulativeDiscount,
  discountValue,
  failedFetch,
  findLoyaltyDiscount,
  money,
  quickPickLabel,
  quickPicks,
  redeemActionLabel,
  redeemOutcome,
  shortOfMinimumLine,
  type FetchState,
  type RedeemOutcome,
} from './state.js';

type Phase = { name: 'idle' } | { name: 'redeeming' } | ({ name: 'done' } & RedeemOutcome);

/**
 * The way out of the modal once the sale no longer needs it. POS owns the
 * modal chrome, so closing is the host's job — there is nothing to unmount.
 */
function closeModal(): void {
  window.close();
}

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
  const [checking, setChecking] = useState(false);
  // A confirmed debit that still owes this sale its discount: the cart write
  // failed after the ledger committed. While this is true the ONLY offered
  // actions are replaying that same attempt and leaving — changing the amount
  // would mint a new attempt id and debit the customer twice.
  const [owed, setOwed] = useState(false);
  // Re-rendered on a slow tick so the "Up to date" badge can expire on its
  // own while the modal sits open through a long sale.
  const [now, setNow] = useState(Date.now());

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

  const loadBalance = async (): Promise<void> => {
    try {
      const res = await fetchBalance(customerGid(shopify.customer.id));
      setInfo(res);
      setLastFetch({ ok: true, balance: res.balance, at: new Date() });
    } catch {
      setLastFetch(failedFetch);
    }
    setNow(Date.now());
  };

  /** The manual way back from any not-live state — without it, a backend
   * blip while the device stays online is a dead end with nothing to tap. */
  const checkAgain = async (): Promise<void> => {
    setChecking(true);
    await loadBalance();
    setChecking(false);
  };

  useEffect(() => {
    void loadBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  const view = balanceView({ connection, lastFetch, now });

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

  const currency = info?.currency;
  const value =
    info !== undefined && points > 0 ? discountValue(points, info.redemptionRate) : undefined;
  // Priced only for an amount that could actually go through, so the money on
  // the button is never a promise the backend would refuse.
  // While a debit is owed a discount, the amount is history rather than a
  // proposal: it is priced even though it now exceeds the debited balance.
  const offAmount =
    value !== undefined && (issue === undefined || owed) ? money(value, currency) : undefined;
  const pricing = info !== undefined ? { redemptionRate: info.redemptionRate, currency } : undefined;
  const picks =
    view.kind === 'live' && view.balance !== undefined && info !== undefined
      ? quickPicks(view.balance, info.minRedemption, pricing)
      : [];
  const rules =
    info !== undefined
      ? `${info.minRedemption} points minimum · ${info.redemptionRate} points = ${money(1, currency)} off`
      : undefined;
  // Nothing to redeem yet: say how far off, rather than offering a form that
  // refuses every number typed into it.
  const shortBy =
    view.kind === 'live' && view.balance !== undefined && info !== undefined
      ? view.balance < info.minRedemption
      : false;
  const succeeded = phase.name === 'done' && phase.tone === 'success';
  // After a call that didn't come back, the same button is the recovery — it
  // replays the held attempt id — so it says so instead of repeating itself.
  const retrying = phase.name === 'done' && phase.tone === 'critical';

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
      if (result.status === 'applied' && 'discountAmount' in result) {
        // The debit is committed. The attempt id is NOT released until the
        // discount is actually on the sale: if the cart write fails, the only
        // safe retry is a replay of this same attempt — a fresh id would debit
        // the customer a second time for one discount.
        setLastFetch({ ok: true, balance: result.balance, at: new Date() });
        try {
          // Applying replaces the cart-level discount, so re-apply the running
          // total — a second redemption on the same sale must add to the
          // discount, not overwrite it and charge the points twice.
          const prior = findLoyaltyDiscount(shopify.cart.current.value.cartDiscounts ?? []);
          const total = cumulativeDiscount(prior, { points, amount: result.discountAmount });
          await shopify.cart.applyCartDiscount('FixedAmount', total.title, total.amount);
        } catch {
          setOwed(true);
          setPhase({ name: 'done', ...redeemOutcome(CART_WRITE_FAILED, { points }) });
          return;
        }
        attemptIdRef.current = undefined; // done, end to end
        setOwed(false);
        setPhase({
          name: 'done',
          ...redeemOutcome('applied', {
            points,
            amount: money(result.discountAmount, currency),
            balance: result.balance,
          }),
        });
      } else {
        // A rejection wrote nothing, so the next redemption is a new attempt —
        // unless a debit is already known to have committed, in which case the
        // id stays held and no second one can ever be minted for it.
        if (!owed) attemptIdRef.current = undefined;
        setLastFetch({ ok: true, balance: result.balance, at: new Date() });
        setPhase({
          name: 'done',
          ...redeemOutcome(result.status, { minRedemption: info.minRedemption }),
        });
      }
    } catch {
      // The write may or may not have landed. attemptIdRef is kept, so a
      // retry replays the same attempt instead of double-debiting; the shown
      // balance is downgraded to unconfirmed and re-read so retry re-enables.
      // Once a debit is known to have committed, stay on that truth rather
      // than downgrading to "we're not sure" — the points are gone either way.
      setLastFetch(failedFetch);
      setPhase({
        name: 'done',
        ...redeemOutcome(owed ? CART_WRITE_FAILED : NETWORK_UNCONFIRMED, { points }),
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
                <s-text color="subdued">
                  {`Worth up to ${money(info.maxDiscountAmount, currency)} off this sale.`}
                </s-text>
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

          {/*
            Every not-live state — and a confirmed balance that has gone cold —
            gets something to tap. Without it a backend blip on a device that
            stayed online is a dead end: a disabled button and no way forward.
          */}
          {view.kind !== 'loading' && !(view.redeemEnabled && view.fresh === true) ? (
            <s-button
              id="balance-recheck"
              variant="secondary"
              loading={checking}
              onClick={() => void checkAgain()}
            >
              Check again
            </s-button>
          ) : null}

          {owed ? (
            // A committed debit with no discount on the sale. The amount is
            // locked: the only safe actions are replaying this attempt and
            // walking away, so nothing else is on screen to tap by mistake.
            <s-stack direction="block" gap="base">
              {phase.name === 'done' ? (
                <s-banner heading={phase.heading} tone={phase.tone}>
                  {phase.message}
                </s-banner>
              ) : null}
              <s-button
                id="redeem-submit"
                variant="primary"
                disabled={phase.name === 'redeeming'}
                loading={phase.name === 'redeeming'}
                onClick={onRedeem}
              >
                {redeemActionLabel({ amount: offAmount, retry: true })}
              </s-button>
              <s-button id="redeem-close" variant="secondary" onClick={closeModal}>
                Back to the sale
              </s-button>
            </s-stack>
          ) : succeeded && phase.name === 'done' ? (
            // The finish line: what came off the sale, what's left, and the one
            // tap back to the queue. Nothing here invites a second redemption —
            // reopening the modal does that, and re-opening adds to the
            // discount rather than replacing it.
            <s-stack direction="block" gap="base">
              <s-banner heading={phase.heading} tone="success">
                {phase.message}
              </s-banner>
              <s-button id="redeem-close" variant="primary" onClick={closeModal}>
                Back to the sale
              </s-button>
            </s-stack>
          ) : shortBy && info !== undefined ? (
            // Below the minimum there is nothing to type: a form that refuses
            // every number is worse than one sentence and the way out.
            <s-stack direction="block" gap="base">
              <s-divider />
              <s-text id="short-of-minimum" color="subdued">
                {shortOfMinimumLine(view.balance ?? 0, info.minRedemption)}
              </s-text>
              <s-button id="redeem-close" variant="primary" onClick={closeModal}>
                Back to the sale
              </s-button>
            </s-stack>
          ) : (
            <>
              <s-divider />
              <s-stack direction="block" gap="small-200">
                {picks.length > 0 ? (
                  <s-stack direction="block" gap="small-300">
                    <s-text type="strong">How many points?</s-text>
                    {/*
                      One pick per row, not a row of chips: a full-width target
                      is what a thumb hits first time on a counter-mounted
                      tablet, and the money fits without truncating.
                    */}
                    <s-stack direction="block" gap="small-200">
                      {picks.map((pick) => (
                        <s-button
                          key={pick.points}
                          id={`quick-pick-${pick.label.toLowerCase()}`}
                          variant="secondary"
                          disabled={phase.name === 'redeeming'}
                          onClick={() => setAmount(pick.points)}
                        >
                          {quickPickLabel(pick)}
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
                {/*
                  The outcome sits directly above the button that acts on it,
                  so the next tap is the one the banner just asked for — and
                  the heading names the state, so the tone colour is never
                  carrying the meaning on its own.
                */}
                {phase.name === 'done' ? (
                  <s-banner heading={phase.heading} tone={phase.tone}>
                    {phase.message}
                  </s-banner>
                ) : null}
                <s-button
                  id="redeem-submit"
                  variant="primary"
                  disabled={redeemDisabled}
                  loading={phase.name === 'redeeming'}
                  onClick={onRedeem}
                >
                  {redeemActionLabel({ amount: offAmount, retry: retrying })}
                </s-button>
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
