/**
 * Backend client shared by the POS targets. Relative URLs resolve against the
 * app's application_url and POS attaches the session token automatically
 * (app authentication, POS >= 10.6.0 / API >= 2025-07) — the backend still
 * verifies that token on every call.
 */

export interface BalanceResponse {
  customerId: string;
  balance: number;
  minRedemption: number;
  redemptionRate: string;
  maxDiscountAmount: string;
}

export type RedeemResponse =
  | { status: 'applied'; balance: number; discountAmount: string; discountTitle: string }
  | { status: string; balance: number };

const TIMEOUT_MS = 5000;

async function request(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBalance(customerId: string): Promise<BalanceResponse> {
  const res = await request(`/api/balance?customerId=${encodeURIComponent(customerId)}`);
  if (!res.ok) throw new Error(`balance fetch failed: ${res.status}`);
  return (await res.json()) as BalanceResponse;
}

export async function redeemPoints(params: {
  customerId: string;
  points: number;
  attemptId: string;
  posDeviceId?: string;
}): Promise<RedeemResponse> {
  const res = await request('/api/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...params, channel: 'pos' }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`redeem failed: ${res.status}`);
  return (await res.json()) as RedeemResponse;
}

export const customerGid = (id: number): string => `gid://shopify/Customer/${id}`;
