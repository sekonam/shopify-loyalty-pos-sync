/**
 * Exact decimal arithmetic for money/rate math. Shopify sends amounts as decimal
 * strings; multiplying them as floats can misround an earn calculation, so every
 * computation here goes through scaled BigInt.
 */

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

export interface ScaledDecimal {
  /** value * 10^-scale is the represented number */
  value: bigint;
  scale: number;
}

export function parseDecimal(input: string | number): ScaledDecimal {
  const s = typeof input === 'number' ? String(input) : input.trim();
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new Error(`Not a decimal: ${JSON.stringify(input)}`);
  const [, sign, whole, frac = ''] = m;
  const digits = (whole + frac).replace(/^0+(?=\d)/, '');
  const value = BigInt(digits) * (sign === '-' ? -1n : 1n);
  return { value, scale: frac.length };
}

/** floor(a * b) for non-negative decimals, as a plain integer. */
export function floorProduct(a: string | number, b: string | number): number {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  const product = da.value * db.value;
  const divisor = 10n ** BigInt(da.scale + db.scale);
  // BigInt division truncates toward zero == floor for non-negative products.
  const floored = product >= 0n ? product / divisor : -((-product + divisor - 1n) / divisor);
  if (floored > BigInt(Number.MAX_SAFE_INTEGER) || floored < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`Result out of safe integer range: ${floored}`);
  }
  return Number(floored);
}

/** Exact product of two decimals, as a decimal string (no float drift). */
export function mulDecimals(a: string | number, b: string | number): string {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  const value = da.value * db.value;
  const scale = da.scale + db.scale;
  if (scale === 0) return value.toString();
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const frac = (abs % divisor).toString().padStart(scale, '0').replace(/0+$/, '');
  return frac === '' ? `${sign}${abs / divisor}` : `${sign}${abs / divisor}.${frac}`;
}

/**
 * Exact sum of decimal-string amounts (e.g. refund transaction amounts),
 * returned as a decimal string. Handles any scale — 0-decimal (JPY) and
 * 3-decimal (BHD) currencies included — where cent-based math would not.
 */
export function sumAmounts(amounts: Array<string | number>): string {
  let total = 0n;
  let scale = 0;
  for (const a of amounts) {
    const d = parseDecimal(a);
    if (d.scale > scale) {
      total *= 10n ** BigInt(d.scale - scale);
      scale = d.scale;
    }
    total += d.value * 10n ** BigInt(scale - d.scale);
  }
  if (scale === 0) return total.toString();
  const sign = total < 0n ? '-' : '';
  const abs = total < 0n ? -total : total;
  const divisor = 10n ** BigInt(scale);
  return `${sign}${abs / divisor}.${(abs % divisor).toString().padStart(scale, '0')}`;
}

export function isNonNegativeDecimal(input: string | number): boolean {
  try {
    return parseDecimal(input).value >= 0n;
  } catch {
    return false;
  }
}
