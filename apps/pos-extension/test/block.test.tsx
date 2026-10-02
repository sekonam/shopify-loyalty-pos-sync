/// <reference types="@shopify/ui-extensions/pos.customer-details.block.render" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/preact';
import { render } from 'preact';
import { getExtension } from '@shopify/ui-extensions-tester';

const extension = getExtension('pos.customer-details.block.render');

const balancePayload = {
  customerId: 'gid://shopify/Customer/42',
  balance: 250,
  minRedemption: 100,
  redemptionRate: '100',
  maxDiscountAmount: '2.50',
};

describe('customer-details block', () => {
  beforeEach(() => {
    extension.setUp();
  });
  afterEach(() => {
    render(null, document.body); // unmount the previous test's tree
    document.body.innerHTML = '';
    extension.tearDown();
  });

  const balanceHeading = () => document.body.querySelector('#loyalty-balance')?.textContent;

  it('leads with the balance and an up-to-date badge when the backend answers', async () => {
    extension.shopify.customer.id = 42;
    extension.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(balancePayload), { status: 200 }));
    await extension.render();
    await waitFor(() => {
      expect(balanceHeading()).toBe('250 points');
    });
    expect(extension.fetch).toHaveBeenCalledWith(
      '/api/balance?customerId=gid%3A%2F%2Fshopify%2FCustomer%2F42',
      expect.anything(),
    );
    const badge = document.body.querySelector('s-badge');
    expect(badge?.getAttribute('tone')).toBe('success');
    expect(badge?.textContent).toBe('Up to date');
    // Secondary metadata: what the points are worth, then when it was checked.
    expect(document.body.textContent).toContain('Worth up to 2.50 off');
    expect(document.body.textContent).toContain('Confirmed at');
  });

  it('spins rather than printing a placeholder while the first check is in flight', async () => {
    extension.shopify.customer.id = 42;
    extension.fetch = vi.fn().mockReturnValue(new Promise(() => undefined));
    await extension.render();
    expect(document.body.querySelector('s-spinner')).not.toBeNull();
    expect(document.body.textContent).toContain('Checking the latest balance');
    expect(document.body.querySelector('#loyalty-balance')).toBeNull();
  });

  it('never renders a number as live when the backend is unreachable', async () => {
    extension.shopify.customer.id = 42;
    extension.fetch = vi.fn().mockRejectedValue(new TypeError('network down'));
    await extension.render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Can't reach the loyalty service");
    });
    expect(document.body.textContent).not.toContain('points available');
    expect(balanceHeading()).toBe('Balance unavailable');
    expect(document.body.querySelector('s-badge')?.getAttribute('tone')).toBe('warning');
  });

  it('reads a real zero balance as intentional, not broken', async () => {
    extension.shopify.customer.id = 42;
    extension.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...balancePayload, balance: 0, maxDiscountAmount: '0.00' }), {
        status: 200,
      }),
    );
    await extension.render();
    await waitFor(() => expect(balanceHeading()).toBe('0 points'));
    expect(document.body.textContent).toContain('No points yet');
    expect(document.body.textContent).not.toContain('Worth up to');
    expect(document.body.querySelector('s-badge')?.getAttribute('tone')).toBe('success');
  });
});
