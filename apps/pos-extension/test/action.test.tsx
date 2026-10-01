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

const redeemButton = () =>
  Array.from(document.body.querySelectorAll('s-button')).find((b) =>
    b.textContent?.includes('Redeem and apply discount'),
  ) as HTMLElement;

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
    await waitFor(() => expect(document.body.textContent).toContain('250 points available'));

    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());

    await waitFor(() => {
      expect(applyCartDiscount).toHaveBeenCalledWith('FixedAmount', '200 points redeemed', '2.00');
    });
    expect(document.body.textContent).toContain('Points redeemed and discount applied');
    expect(document.body.textContent).toContain('50 points available');
    const redeemCall = (extension.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([input]) => String(input) === '/api/redeem',
    );
    const body = JSON.parse((redeemCall?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({ channel: 'pos', points: 200 });
    expect(body.attemptId).toMatch(/^[0-9a-f-]{36}$/);
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
    await waitFor(() => expect(document.body.textContent).toContain('250 points available'));
    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());

    await waitFor(() => {
      expect(document.body.textContent).toContain('Not enough points');
    });
    expect(applyCartDiscount).not.toHaveBeenCalled();
  });

  it('disables redemption entirely while offline', async () => {
    extension.shopify.connectivity.current.value = { internetConnected: 'Disconnected' };
    extension.fetch = vi.fn().mockRejectedValue(new TypeError('offline'));
    await extension.render();
    await waitFor(() => expect(document.body.textContent).toContain('Offline'));
    setPoints('200');
    expect(redeemButton().hasAttribute('disabled')).toBe(true);
  });

  it('a timed-out redemption downgrades the balance to unconfirmed', async () => {
    extension.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/balance')) {
        return new Response(JSON.stringify(balancePayload), { status: 200 });
      }
      throw new TypeError('network lost mid-call');
    }) as unknown as typeof fetch;
    await extension.render();
    await waitFor(() => expect(document.body.textContent).toContain('250 points available'));
    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Couldn't confirm the balance");
    });
    expect(redeemButton().hasAttribute('disabled')).toBe(true);
  });
});
