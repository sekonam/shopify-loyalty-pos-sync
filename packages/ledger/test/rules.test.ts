import { describe, expect, it } from 'vitest';
import {
  checkRedemption,
  earnEntryFromOrder,
  normalizeSourceName,
  redemptionDiscountAmount,
  refundReversalEntry,
} from '../src/rules.js';

describe('normalizeSourceName', () => {
  it('maps known channels and preserves unknown ones', () => {
    expect(normalizeSourceName('web')).toEqual({ sourceName: 'web' });
    expect(normalizeSourceName('pos')).toEqual({ sourceName: 'pos' });
    expect(normalizeSourceName('POS')).toEqual({ sourceName: 'pos' });
    expect(normalizeSourceName('iphone')).toEqual({ sourceName: 'mobile_app' });
    expect(normalizeSourceName('android')).toEqual({ sourceName: 'mobile_app' });
    expect(normalizeSourceName('shopify_draft_order')).toEqual({
      sourceName: 'other',
      rawSourceName: 'shopify_draft_order',
    });
    expect(normalizeSourceName(null)).toEqual({ sourceName: 'other', rawSourceName: '' });
  });
});

const base = {
  shopDomain: 'test.myshopify.com',
  customerId: 'gid://shopify/Customer/1',
  orderId: 'gid://shopify/Order/10',
};

describe('earnEntryFromOrder', () => {
  it('floors the earn and tags the channel', () => {
    const entry = earnEntryFromOrder({
      ...base,
      orderSourceName: 'pos',
      totalPrice: '49.99',
      earnRate: '1',
    });
    expect(entry).toMatchObject({
      delta: 49,
      reason: 'earn',
      sourceName: 'pos',
      idempotencyKey: 'order_paid:gid://shopify/Order/10',
    });
  });

  it('returns null when the order is too small to earn a point', () => {
    expect(
      earnEntryFromOrder({ ...base, orderSourceName: 'web', totalPrice: '0.99', earnRate: '1' }),
    ).toBeNull();
    expect(
      earnEntryFromOrder({ ...base, orderSourceName: 'web', totalPrice: '0', earnRate: '1' }),
    ).toBeNull();
  });

  it('supports fractional earn rates', () => {
    const entry = earnEntryFromOrder({
      ...base,
      orderSourceName: 'web',
      totalPrice: '100.00',
      earnRate: '0.5',
    });
    expect(entry?.delta).toBe(50);
  });
});

describe('refundReversalEntry', () => {
  const refundBase = { ...base, refundId: 'gid://shopify/Refund/7', orderSourceName: 'web' };

  it('reverses points for the refunded amount (uncapped — the store caps at write time)', () => {
    const entry = refundReversalEntry({
      ...refundBase,
      refundedAmount: '20.00',
      earnRate: '1',
    });
    expect(entry).toMatchObject({
      delta: -20,
      reason: 'refund_reversal',
      refundId: 'gid://shopify/Refund/7',
      idempotencyKey: 'refund:gid://shopify/Refund/7',
    });
  });

  it('produces no entry when the refund rounds to zero points', () => {
    expect(
      refundReversalEntry({ ...refundBase, refundedAmount: '0.50', earnRate: '1' }),
    ).toBeNull();
    expect(refundReversalEntry({ ...refundBase, refundedAmount: '0', earnRate: '1' })).toBeNull();
  });
});

describe('checkRedemption', () => {
  it('rejects non-integers, zero, and below-minimum requests', () => {
    expect(checkRedemption({ balance: 1000, requestedPoints: 0, minRedemption: 100 })).toEqual({
      ok: false,
      status: 'rejected_below_minimum',
    });
    expect(checkRedemption({ balance: 1000, requestedPoints: 50.5, minRedemption: 1 })).toEqual({
      ok: false,
      status: 'rejected_below_minimum',
    });
    expect(checkRedemption({ balance: 1000, requestedPoints: 99, minRedemption: 100 })).toEqual({
      ok: false,
      status: 'rejected_below_minimum',
    });
  });

  it('rejects requests above balance, allows exact balance', () => {
    expect(checkRedemption({ balance: 100, requestedPoints: 101, minRedemption: 1 })).toEqual({
      ok: false,
      status: 'rejected_insufficient_balance',
    });
    expect(checkRedemption({ balance: 100, requestedPoints: 100, minRedemption: 1 })).toEqual({
      ok: true,
    });
  });
});

describe('redemptionDiscountAmount', () => {
  it('converts points to a currency string at the redemption rate', () => {
    expect(redemptionDiscountAmount(100, '100')).toBe('1.00');
    expect(redemptionDiscountAmount(250, '100')).toBe('2.50');
    expect(redemptionDiscountAmount(1000, '200')).toBe('5.00');
    expect(redemptionDiscountAmount(0, '100')).toBe('0.00');
  });

  it('floors to the cent on uneven rates', () => {
    expect(redemptionDiscountAmount(100, '3')).toBe('33.33');
    expect(redemptionDiscountAmount(1, '3')).toBe('0.33');
  });

  it('rejects invalid input', () => {
    expect(() => redemptionDiscountAmount(-1, '100')).toThrow();
    expect(() => redemptionDiscountAmount(10, '0')).toThrow();
  });
});
