/**
 * Idempotency-key construction (TECHNICAL-SPEC §3). Keys are unique per shop
 * (the store enforces (shopDomain, idempotencyKey) uniqueness), so they embed
 * only the resource identity, not the shop.
 */

export const orderPaidKey = (orderId: string): string => `order_paid:${orderId}`;

export const refundKey = (refundId: string): string => `refund:${refundId}`;

export const redemptionKey = (attemptId: string): string => `redemption:${attemptId}`;

export const reconcileKey = (resource: string, runId: string): string =>
  `reconcile:${resource}:${runId}`;

export const adjustmentKey = (adjustmentId: string): string => `adjustment:${adjustmentId}`;
