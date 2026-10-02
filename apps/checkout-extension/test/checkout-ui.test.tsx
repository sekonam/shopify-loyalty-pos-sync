/// <reference types="@shopify/ui-extensions/purchase.checkout.block.render" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/preact';
import { render } from 'preact';
import { getExtension } from '@shopify/ui-extensions-tester';

const extension = getExtension('purchase.checkout.block.render');

const balancePayload = {
  balance: 250,
  minRedemption: 100,
  redemptionRate: '100',
  currency: 'USD',
  tier: null,
  maxDiscountAmount: '2.50',
};

function primeShopify() {
  const s = extension.shopify as unknown as Record<string, unknown>;
  (s['settings'] as { value: unknown }).value = { backend_url: 'https://backend.test' };
  (s['sessionToken'] as { get: unknown }).get = vi.fn().mockResolvedValue('tok-123');
  const cost = s['cost'] as { totalAmount: { value: unknown } };
  cost.totalAmount.value = { amount: '100.00', currencyCode: 'USD' };
}

const redeemButton = () =>
  Array.from(document.body.querySelectorAll('s-button')).find((b) =>
    b.textContent?.includes('Redeem points'),
  ) as HTMLElement;

const setPoints = (value: string) => {
  const field = document.body.querySelector('s-number-field') as HTMLElement & { value: string };
  field.value = value;
  fireEvent(field, new Event('change', { bubbles: true }));
};

describe('checkout loyalty block', () => {
  beforeEach(() => {
    extension.setUp();
    primeShopify();
  });
  afterEach(() => {
    render(null, document.body);
    document.body.innerHTML = '';
    extension.tearDown();
  });

  it('shows the balance fetched with a session token, naming no customer itself', async () => {
    extension.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(balancePayload), { status: 200 }));
    await extension.render();
    await waitFor(() => expect(document.body.textContent).toContain('You have 250 points'));
    const [url, init] = (extension.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('https://backend.test/api/balance');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok-123' });
  });

  it('redeems first, then mirrors the confirmed redemption into cart attributes', async () => {
    extension.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/balance')) {
        return new Response(JSON.stringify(balancePayload), { status: 200 });
      }
      return new Response(
        JSON.stringify({ status: 'applied', balance: 50, discountAmount: '2.00' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const applyAttributeChange = vi.fn().mockResolvedValue({ type: 'success' });
    (extension.shopify as unknown as Record<string, unknown>)['applyAttributeChange'] =
      applyAttributeChange;

    await extension.render();
    await waitFor(() => expect(document.body.textContent).toContain('You have 250 points'));
    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());

    await waitFor(() =>
      expect(document.body.textContent).toContain('200 points redeemed — 2.00 off applied'),
    );
    expect(applyAttributeChange).toHaveBeenCalledWith({
      type: 'updateAttribute',
      key: 'loyalty_discount',
      value: '2.00',
    });
    expect(applyAttributeChange).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'loyalty_attempt' }),
    );
    expect(applyAttributeChange).toHaveBeenCalledWith({
      type: 'updateAttribute',
      key: 'loyalty_currency',
      value: 'USD',
    });
    expect(document.body.textContent).toContain('You have 50 points');
    const redeemCall = (extension.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([u]) =>
      String(u).includes('/api/redeem'),
    );
    const sent = JSON.parse((redeemCall?.[1] as RequestInit).body as string);
    expect(sent).toMatchObject({ channel: 'web', points: 200 });
    expect(sent.customerId).toBeUndefined();
    // One redemption per checkout: the form is gone after success.
    expect(redeemButton()).toBeUndefined();
  });

  it('shows tier, advocate share code, and a referral input for zero-balance customers', async () => {
    extension.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/referral-code')) {
        return new Response(
          JSON.stringify({ code: 'AB12C', advocatePoints: 200, friendPoints: 100 }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          ...balancePayload,
          balance: 0,
          tier: { name: 'Gold', multiplier: '2', earned365: 1500 },
          maxDiscountAmount: '0.00',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const applyAttributeChange = vi.fn().mockResolvedValue({ type: 'success' });
    (extension.shopify as unknown as Record<string, unknown>)['applyAttributeChange'] =
      applyAttributeChange;

    await extension.render();
    await waitFor(() => expect(document.body.textContent).toContain('You have 0 points'));
    expect(document.body.textContent).toContain('Gold member — 2× points');
    await waitFor(() => expect(document.body.textContent).toContain('Share your code AB12C'));

    const field = document.body.querySelector('s-text-field') as HTMLElement & { value: string };
    field.value = 'zz99x';
    fireEvent(field, new Event('change', { bubbles: true }));
    const apply = Array.from(document.body.querySelectorAll('s-button')).find((b) =>
      b.textContent?.includes('Apply referral code'),
    ) as HTMLElement;
    fireEvent.click(apply);
    await waitFor(() => expect(document.body.textContent).toContain('Referral code applied'));
    expect(applyAttributeChange).toHaveBeenCalledWith({
      type: 'updateAttribute',
      key: 'loyalty_referral',
      value: 'ZZ99X', // normalized upper-case
    });
  });

  it('hides itself when the checkout currency differs from the shop currency', async () => {
    const s = extension.shopify as unknown as Record<string, unknown>;
    (s['cost'] as { totalAmount: { value: unknown } }).totalAmount.value = {
      amount: '15000',
      currencyCode: 'JPY',
    };
    extension.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(balancePayload), { status: 200 }));
    await extension.render();
    await waitFor(() => expect(document.body.textContent ?? '').not.toContain('Loading'));
    expect(document.body.textContent ?? '').not.toContain('Loyalty points');
  });

  it('a failed redeem keeps the attempt id so retry cannot double-debit', async () => {
    const redeemAttemptIds: string[] = [];
    let failNext = true;
    extension.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/balance')) {
        return new Response(JSON.stringify(balancePayload), { status: 200 });
      }
      redeemAttemptIds.push(JSON.parse(init?.body as string).attemptId);
      if (failNext) {
        failNext = false;
        throw new TypeError('network lost');
      }
      return new Response(
        JSON.stringify({ status: 'applied', balance: 50, discountAmount: '2.00' }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    (extension.shopify as unknown as Record<string, unknown>)['applyAttributeChange'] = vi
      .fn()
      .mockResolvedValue({ type: 'success' });

    await extension.render();
    await waitFor(() => expect(document.body.textContent).toContain('You have 250 points'));
    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());
    await waitFor(() => expect(document.body.textContent).toContain("won't be charged twice"));
    fireEvent.click(redeemButton());
    await waitFor(() => expect(document.body.textContent).toContain('200 points redeemed'));
    expect(redeemAttemptIds).toHaveLength(2);
    expect(redeemAttemptIds[0]).toBe(redeemAttemptIds[1]);
  });

  it('a rejected redemption writes no attributes', async () => {
    extension.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/balance')) {
        return new Response(JSON.stringify(balancePayload), { status: 200 });
      }
      return new Response(
        JSON.stringify({ status: 'rejected_insufficient_balance', balance: 250 }),
        { status: 409 },
      );
    }) as unknown as typeof fetch;
    const applyAttributeChange = vi.fn();
    (extension.shopify as unknown as Record<string, unknown>)['applyAttributeChange'] =
      applyAttributeChange;

    await extension.render();
    await waitFor(() => expect(document.body.textContent).toContain('You have 250 points'));
    setPoints('200');
    await waitFor(() => expect(redeemButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(redeemButton());

    await waitFor(() => expect(document.body.textContent).toContain('Not enough points'));
    expect(applyAttributeChange).not.toHaveBeenCalled();
  });

  it('hides itself when the backend refuses (signed-out customer, 400)', async () => {
    extension.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'customerId required for this session' }), {
          status: 400,
        }),
      );
    await extension.render();
    await waitFor(() => expect(document.body.textContent ?? '').not.toContain('Loading'));
    expect(document.body.textContent ?? '').not.toContain('Loyalty points');
  });

  it('renders nothing when no backend URL is configured', async () => {
    (extension.shopify as unknown as { settings: { value: unknown } }).settings.value = {};
    extension.fetch = vi.fn();
    await extension.render();
    expect(document.body.textContent ?? '').not.toContain('Loyalty points');
    expect(extension.fetch).not.toHaveBeenCalled();
  });
});
