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

  it('shows the live balance with a Synced badge when the backend answers', async () => {
    extension.shopify.customer.id = 42;
    extension.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(balancePayload), { status: 200 }));
    await extension.render();
    await waitFor(() => {
      expect(document.body.textContent).toContain('250 points');
    });
    expect(extension.fetch).toHaveBeenCalledWith(
      '/api/balance?customerId=gid%3A%2F%2Fshopify%2FCustomer%2F42',
      expect.anything(),
    );
    expect(document.body.querySelector('s-badge')?.getAttribute('tone')).toBe('success');
    expect(document.body.textContent).toContain('Live balance');
  });

  it('never renders a number as live when the backend is unreachable', async () => {
    extension.shopify.customer.id = 42;
    extension.fetch = vi.fn().mockRejectedValue(new TypeError('network down'));
    await extension.render();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Can't reach the loyalty service");
    });
    expect(document.body.textContent).not.toContain('points available');
    expect(document.body.querySelector('s-badge')?.getAttribute('tone')).toBe('warning');
  });
});
