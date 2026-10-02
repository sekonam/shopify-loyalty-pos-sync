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

    // 100 minimum out of 250 available: the minimum and the whole balance.
    const picks = Array.from(document.body.querySelectorAll('[id^="quick-pick-"]'));
    expect(picks.map((p) => p.textContent)).toEqual(['Minimum · 100 pts', 'All · 250 pts']);
    // The conversion rule is on the field itself, not buried in a tooltip.
    expect(
      document.body.querySelector('s-number-field')?.getAttribute('details'),
    ).toBe('100 points minimum · 100 points = 1.00 off');

    fireEvent.click(picks[1] as HTMLElement);
    await waitFor(() =>
      expect(document.body.querySelector('#redeem-preview')?.textContent).toBe(
        '250 points → 2.50 off this sale',
      ),
    );
    expect(redeemButton().textContent).toBe('Redeem 250 points');
    expect(redeemButton().hasAttribute('disabled')).toBe(false);
    expect(extension.fetch).toHaveBeenCalledTimes(1); // nothing written yet
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
    expect(document.body.querySelector('#redeem-preview')).toBeNull();

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
      expect(document.body.textContent).toContain("Couldn't confirm the balance");
    });
    // The automatic balance re-read re-enables the retry...
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());
    await waitFor(() => expect(applyCartDiscount).toHaveBeenCalledTimes(1));
    // ...and the retry carried the SAME attempt id (idempotent replay).
    expect(redeemAttemptIds).toHaveLength(2);
    expect(redeemAttemptIds[0]).toBe(redeemAttemptIds[1]);
  });
});
