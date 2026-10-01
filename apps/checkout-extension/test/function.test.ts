import { describe, expect, it } from 'vitest';
import {
  cartLinesDiscountsGenerateRun,
  type CartInput,
} from '../extensions/loyalty-discount/src/cart_lines_discounts_generate_run.js';

const input = (over: {
  amount?: string | null;
  attempt?: string | null;
  currency?: string | null;
  subtotal?: string;
  cartCurrency?: string;
  classes?: string[];
}): CartInput => ({
  cart: {
    redeemAmount: over.amount === undefined ? null : { value: over.amount },
    redeemAttempt: over.attempt === undefined ? { value: 'a-1' } : { value: over.attempt },
    redeemCurrency: over.currency === undefined ? { value: 'USD' } : { value: over.currency },
    cost: {
      subtotalAmount: {
        amount: over.subtotal ?? '100.00',
        currencyCode: over.cartCurrency ?? 'USD',
      },
    },
  },
  discount: { discountClasses: over.classes ?? ['ORDER'] },
});

describe('cartLinesDiscountsGenerateRun', () => {
  it('materializes a confirmed redemption as a fixed-amount order discount', () => {
    const result = cartLinesDiscountsGenerateRun(input({ amount: '2.50' }));
    expect(result).toEqual({
      operations: [
        {
          orderDiscountsAdd: {
            candidates: [
              {
                message: 'Loyalty points redeemed',
                targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
                value: { fixedAmount: { amount: '2.50' } },
              },
            ],
            selectionStrategy: 'FIRST',
          },
        },
      ],
    });
  });

  it('emits nothing without the ORDER discount class', () => {
    expect(
      cartLinesDiscountsGenerateRun(input({ amount: '2.50', classes: ['PRODUCT'] })),
    ).toEqual({ operations: [] });
  });

  it('emits nothing when no redemption attributes are set', () => {
    expect(cartLinesDiscountsGenerateRun(input({}))).toEqual({ operations: [] });
    expect(cartLinesDiscountsGenerateRun(input({ amount: null }))).toEqual({ operations: [] });
  });

  it('requires the attempt id alongside the amount', () => {
    expect(cartLinesDiscountsGenerateRun(input({ amount: '2.50', attempt: null }))).toEqual({
      operations: [],
    });
    expect(cartLinesDiscountsGenerateRun(input({ amount: '2.50', attempt: '' }))).toEqual({
      operations: [],
    });
  });

  it('rejects malformed or non-positive amounts', () => {
    for (const bad of ['0', '0.00', '-5', 'abc', '1.2.3', '5.123', '1e3', ' 2.50']) {
      expect(cartLinesDiscountsGenerateRun(input({ amount: bad })), bad).toEqual({
        operations: [],
      });
    }
  });

  it('emits nothing when the redemption currency does not match the cart currency', () => {
    expect(
      cartLinesDiscountsGenerateRun(input({ amount: '10.00', cartCurrency: 'JPY' })),
    ).toEqual({ operations: [] });
    expect(cartLinesDiscountsGenerateRun(input({ amount: '10.00', currency: null }))).toEqual({
      operations: [],
    });
    expect(cartLinesDiscountsGenerateRun(input({ amount: '10.00', currency: '' }))).toEqual({
      operations: [],
    });
  });

  it('clamps the discount to the cart subtotal', () => {
    const result = cartLinesDiscountsGenerateRun(input({ amount: '500.00', subtotal: '42.10' }));
    expect(
      result.operations[0]?.orderDiscountsAdd.candidates[0]?.value.fixedAmount.amount,
    ).toBe('42.10');
  });
});
