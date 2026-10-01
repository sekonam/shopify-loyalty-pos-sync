import { describe, expect, it } from 'vitest';
import { floorProduct, isNonNegativeDecimal, parseDecimal, sumAmounts } from '../src/money.js';

describe('parseDecimal', () => {
  it('parses integers, decimals, and negatives', () => {
    expect(parseDecimal('123')).toEqual({ value: 123n, scale: 0 });
    expect(parseDecimal('123.45')).toEqual({ value: 12345n, scale: 2 });
    expect(parseDecimal('-0.5')).toEqual({ value: -5n, scale: 1 });
    expect(parseDecimal(2.5)).toEqual({ value: 25n, scale: 1 });
  });

  it('rejects junk', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e5', 'NaN', '--1', '.5']) {
      expect(() => parseDecimal(bad), bad).toThrow();
    }
  });
});

describe('floorProduct', () => {
  it('floors exactly where float math would misround', () => {
    // 19.99 * 10 = 199.9 → 199; naive float gives 199.89999... too, but e.g.
    // 0.29 * 100 = 28.999999... as floats would floor to 28 — exact math gives 29.
    expect(floorProduct('0.29', '100')).toBe(29);
    expect(floorProduct('19.99', '10')).toBe(199);
    expect(floorProduct('19.99', '1')).toBe(19);
    expect(floorProduct('100', '0.5')).toBe(50);
    expect(floorProduct('99.99', '0.5')).toBe(49);
    expect(floorProduct('0.99', '1')).toBe(0);
  });

  it('handles zero and large values', () => {
    expect(floorProduct('0', '1')).toBe(0);
    expect(floorProduct('123456789.99', '2')).toBe(246913579);
  });
});

describe('sumAmounts', () => {
  it('sums mixed-scale decimal strings exactly', () => {
    expect(sumAmounts(['10.00', '5.5', '0.05'])).toBe('15.55');
    expect(sumAmounts(['12.345', '0.005'])).toBe('12.350'); // 3-dp currency (BHD)
    expect(sumAmounts(['100', '200'])).toBe('300'); // 0-dp currency (JPY)
    expect(sumAmounts([])).toBe('0');
    expect(sumAmounts(['10.00', '-2.50'])).toBe('7.50');
  });
});

describe('isNonNegativeDecimal', () => {
  it('accepts non-negatives, rejects negatives and junk', () => {
    expect(isNonNegativeDecimal('0')).toBe(true);
    expect(isNonNegativeDecimal('10.25')).toBe(true);
    expect(isNonNegativeDecimal('-1')).toBe(false);
    expect(isNonNegativeDecimal('nope')).toBe(false);
  });
});
