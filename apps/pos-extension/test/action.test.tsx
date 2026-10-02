/// <reference types="@shopify/ui-extensions/pos.customer-details.action.render" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/preact';
import { render } from 'preact';
import { getExtension } from '@shopify/ui-extensions-tester';

const extension = getExtension('pos.customer-details.action.render');

const balancePayload = {
  customerId: 'gid://shopify/Customer/42',
  balance: 250,
  minRedemption: 100,
  redemptionRate: '100',
  maxDiscountAmount: '2.50',
};

const redeemButton = () => document.body.querySelector('#redeem-submit') as HTMLElement;

const balanceHeading = () => document.body.querySelector('#loyalty-balance')?.textContent;

/** Banner headings live in an attribute, so they are not in textContent. */
const bannerHeadings = () =>
  Array.from(document.body.querySelectorAll('s-banner')).map((b) => b.getAttribute('heading'));

const setPoints = (value: string) => {
  const field = document.body.querySelector('s-number-field') as HTMLElement & { value: string };
  field.value = value;
  fireEvent(field, new Event('change', { bubbles: true }));
};

describe('redeem action modal', () => {
  beforeEach(() => {
    extension.setUp();
    extension.shopify.customer.id = 42;
  });
  afterEach(() => {
    render(null, document.body); // unmount the previous test's tree
    document.body.innerHTML = '';
    extension.tearDown();
  });

  it('redeems, applies the cart discount, and shows the new balance', async () => {
    extension.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/balance')) {
        return new Response(JSON.stringify(balancePayload), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          status: 'applied',
          balance: 50,
          discountAmount: '2.00',
          discountTitle: '200 points redeemed',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const applyCartDiscount = vi.fn().mockResolvedValue(undefined);
    extension.shopify.cart.applyCartDiscount = applyCartDiscount;

    await extension.render();
    await waitFor(() => expect(balanceHeading()).toBe('250 points'));

    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());

    await waitFor(() => {
      expect(applyCartDiscount).toHaveBeenCalledWith(
        'FixedAmount',
        'Loyalty points: 200 points redeemed',
        '2.00',
      );
    });
    expect(document.body.textContent).toContain('200 points redeemed. 2.00 is off this sale.');
    expect(balanceHeading()).toBe('50 points');
    // A confident finish: the form is replaced by the outcome.
    expect(redeemButton()).toBeNull();
    // ...which says what came off the sale and what the customer has left...
    expect(bannerHeadings()).toContain('Done · 2.00 off this sale');
    expect(document.body.textContent).toContain('New balance: 50 points');
    // ...and hands back the one obvious way out, instead of leaving staff
    // hunting for the modal's close button with a queue waiting.
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const back = document.body.querySelector('#redeem-close') as HTMLElement;
    expect(back.textContent).toBe('Back to the sale');
    fireEvent.click(back);
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
    const redeemCall = (extension.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([input]) => String(input) === '/api/redeem',
    );
    const body = JSON.parse((redeemCall?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({ channel: 'pos', points: 200 });
    expect(body.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a second redemption on the same sale adds to the discount instead of replacing it', async () => {
    extension.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/balance')) {
        return new Response(JSON.stringify(balancePayload), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          status: 'applied',
          balance: 50,
          discountAmount: '1.50',
          discountTitle: '150 points redeemed',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const applyCartDiscount = vi.fn().mockResolvedValue(undefined);
    extension.shopify.cart.applyCartDiscount = applyCartDiscount;
    // The sale already carries this app's discount from an earlier redemption
    // in a modal that has since been closed.
    extension.shopify.cart.current.value.cartDiscounts = [
      { type: 'FixedAmount', amount: 2, discountDescription: 'Loyalty points: 200 points redeemed' },
    ];

    await extension.render();
    await waitFor(() => expect(balanceHeading()).toBe('250 points'));
    setPoints('150');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());

    await waitFor(() =>
      expect(applyCartDiscount).toHaveBeenCalledWith(
        'FixedAmount',
        'Loyalty points: 350 points redeemed',
        '3.50',
      ),
    );
  });

  it('a rejected redemption changes nothing in the cart and explains why', async () => {
    extension.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/balance')) {
        return new Response(JSON.stringify(balancePayload), { status: 200 });
      }
      return new Response(
        JSON.stringify({ status: 'rejected_insufficient_balance', balance: 250 }),
        { status: 409 },
      );
    }) as unknown as typeof fetch;
    const applyCartDiscount = vi.fn();
    extension.shopify.cart.applyCartDiscount = applyCartDiscount;

    await extension.render();
    await waitFor(() => expect(balanceHeading()).toBe('250 points'));
    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());

    await waitFor(() => {
      expect(document.body.textContent).toContain('Not enough points');
    });
    expect(applyCartDiscount).not.toHaveBeenCalled();
  });

  it('offers one-tap amounts and prices them in money before anything is confirmed', async () => {
    extension.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(balancePayload), { status: 200 }));
    await extension.render();
    await waitFor(() => expect(balanceHeading()).toBe('250 points'));

    // 100 minimum out of 250 available: the minimum and the whole balance,
    // each already priced — no points-to-money arithmetic at the counter.
    const picks = Array.from(document.body.querySelectorAll('[id^="quick-pick-"]'));
    expect(picks.map((p) => p.textContent)).toEqual([
      '100 points · 1.00 off',
      'All 250 points · 2.50 off',
    ]);
    // The conversion rule is on the field itself, not buried in a tooltip.
    expect(
      document.body.querySelector('s-number-field')?.getAttribute('details'),
    ).toBe('100 points minimum · 100 points = 1.00 off');

    // The button names the consequence in money, not the mechanism.
    expect(redeemButton().textContent).toBe('Choose an amount to redeem');
    fireEvent.click(picks[1] as HTMLElement);
    await waitFor(() => expect(redeemButton().textContent).toBe('Take 2.50 off this sale'));
    expect(redeemButton().hasAttribute('disabled')).toBe(false);
    expect(extension.fetch).toHaveBeenCalledTimes(1); // nothing written yet
  });

  it('writes money in the shop currency once the backend knows it', async () => {
    extension.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ...balancePayload, currency: 'USD' }), { status: 200 }),
      );
    await extension.render();
    await waitFor(() => expect(balanceHeading()).toBe('250 points'));
    expect(document.body.textContent).toContain('Worth up to $2.50 off this sale');
    expect(
      document.body.querySelector('#quick-pick-all')?.textContent,
    ).toBe('All 250 points · $2.50 off');
    setPoints('200');
    await waitFor(() => expect(redeemButton().textContent).toBe('Take $2.00 off this sale'));
  });

  it('explains an impossible amount instead of just greying the button out', async () => {
    extension.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(balancePayload), { status: 200 }));
    await extension.render();
    await waitFor(() => expect(balanceHeading()).toBe('250 points'));

    setPoints('50');
    await waitFor(() =>
      expect(document.body.querySelector('s-number-field')?.getAttribute('error')).toBe(
        'Enter at least 100 points.',
      ),
    );
    expect(redeemButton().hasAttribute('disabled')).toBe(true);
    // An amount the backend would refuse is never priced on the button.
    expect(redeemButton().textContent).toBe('Choose an amount to redeem');

    setPoints('900');
    await waitFor(() =>
      expect(document.body.querySelector('s-number-field')?.getAttribute('error')).toBe(
        'Only 250 points to spend.',
      ),
    );
    expect(redeemButton().hasAttribute('disabled')).toBe(true);
  });

  it('disables redemption entirely while offline', async () => {
    extension.shopify.connectivity.current.value = { internetConnected: 'Disconnected' };
    extension.fetch = vi.fn().mockRejectedValue(new TypeError('offline'));
    await extension.render();
    await waitFor(() => expect(document.body.textContent).toContain('Offline'));
    setPoints('200');
    expect(redeemButton().hasAttribute('disabled')).toBe(true);
  });

  it('a timed-out redemption keeps its attempt id and replays it on retry — no double debit', async () => {
    const redeemAttemptIds: string[] = [];
    let failNext = true;
    extension.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/balance')) {
        return new Response(JSON.stringify(balancePayload), { status: 200 });
      }
      redeemAttemptIds.push(JSON.parse(init?.body as string).attemptId);
      if (failNext) {
        failNext = false;
        throw new TypeError('network lost mid-call');
      }
      return new Response(
        JSON.stringify({
          status: 'applied',
          balance: 50,
          discountAmount: '2.00',
          discountTitle: '200 points redeemed',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const applyCartDiscount = vi.fn().mockResolvedValue(undefined);
    extension.shopify.cart.applyCartDiscount = applyCartDiscount;

    await extension.render();
    await waitFor(() => expect(balanceHeading()).toBe('250 points'));
    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());
    await waitFor(() => {
      expect(document.body.textContent).toContain("isn't clear whether these points came off");
    });
    // It must not claim the points are safe — only that a retry can't double.
    expect(document.body.textContent).not.toContain('othing was charged');
    // The automatic balance re-read re-enables the retry...
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());
    await waitFor(() => expect(applyCartDiscount).toHaveBeenCalledTimes(1));
    // ...and the retry carried the SAME attempt id (idempotent replay).
    expect(redeemAttemptIds).toHaveLength(2);
    expect(redeemAttemptIds[0]).toBe(redeemAttemptIds[1]);
  });

  it('a debit that lands with a failed cart write never double-debits, and says so honestly', async () => {
    const redeemAttemptIds: string[] = [];
    extension.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/balance')) {
        return new Response(JSON.stringify(balancePayload), { status: 200 });
      }
      redeemAttemptIds.push(JSON.parse(init?.body as string).attemptId);
      // The backend's idempotent replay answers the retry identically.
      return new Response(
        JSON.stringify({
          status: 'applied',
          balance: 50,
          discountAmount: '2.00',
          discountTitle: '200 points redeemed',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    // POS refuses the cart discount the first time (no open cart, missing
    // discount permission, API error) and accepts it on the retry.
    let failApply = true;
    const applyCartDiscount = vi.fn(async () => {
      if (failApply) {
        failApply = false;
        throw new Error('no open cart');
      }
    });
    extension.shopify.cart.applyCartDiscount = applyCartDiscount;

    await extension.render();
    await waitFor(() => expect(balanceHeading()).toBe('250 points'));
    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());

    await waitFor(() =>
      expect(bannerHeadings()).toContain('Points taken — discount not applied'),
    );
    // The ledger debit committed, so the copy must NOT claim otherwise.
    expect(document.body.textContent).toContain('200 points were taken');
    expect(document.body.textContent).not.toContain('othing was charged');
    expect(document.body.textContent).not.toContain("can't be taken twice.");
    // The amount is locked while the discount is owed: no field to retype and
    // no quick pick to tap, either of which would mint a second attempt.
    expect(document.body.querySelector('#points-field')).toBeNull();
    expect(document.body.querySelector('[id^="quick-pick-"]')).toBeNull();

    // The single next action re-applies the SAME redemption.
    expect(redeemButton().textContent).toBe('Try again — take 2.00 off this sale');
    fireEvent.click(redeemButton());
    await waitFor(() => expect(bannerHeadings()).toContain('Done · 2.00 off this sale'));
    expect(redeemAttemptIds).toHaveLength(2);
    expect(redeemAttemptIds[0]).toBe(redeemAttemptIds[1]); // one debit, not two
    expect(applyCartDiscount).toHaveBeenLastCalledWith(
      'FixedAmount',
      'Loyalty points: 200 points redeemed',
      '2.00',
    );
  });

  it('says how far off a too-small balance is instead of offering a form that refuses everything', async () => {
    extension.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...balancePayload, balance: 40, maxDiscountAmount: '0.40' }), {
        status: 200,
      }),
    );
    await extension.render();
    await waitFor(() => expect(balanceHeading()).toBe('40 points'));
    expect(document.body.querySelector('#short-of-minimum')?.textContent).toBe(
      '60 more points and this customer can start redeeming.',
    );
    expect(document.body.querySelector('#points-field')).toBeNull();
    expect(redeemButton()).toBeNull();
    // Not a dead end: the way back to the sale is on screen.
    expect(document.body.querySelector('#redeem-close')?.textContent).toBe('Back to the sale');
  });

  it('offers a re-check when the backend fails on a device that is still online', async () => {
    let failNext = true;
    extension.fetch = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        throw new TypeError('backend blip');
      }
      return new Response(JSON.stringify(balancePayload), { status: 200 });
    }) as unknown as typeof fetch;

    await extension.render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Can't reach the loyalty service"),
    );
    // Without this the screen is a dead end: a disabled button and no refetch
    // until the device's connectivity happens to change.
    const recheck = document.body.querySelector('#balance-recheck') as HTMLElement;
    expect(recheck.textContent).toBe('Check again');
    fireEvent.click(recheck);

    await waitFor(() => expect(balanceHeading()).toBe('250 points'));
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(true)); // no amount yet
    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    // A freshly confirmed balance needs no re-check control.
    expect(document.body.querySelector('#balance-recheck')).toBeNull();
  });
});
