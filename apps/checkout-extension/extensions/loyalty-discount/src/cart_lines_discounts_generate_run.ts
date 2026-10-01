/**
 * Discount Function (unified Discount API, target cart.lines.discounts.generate.run).
 *
 * The checkout UI extension writes the cart attributes AFTER the backend's
 * atomic /api/redeem has applied the redemption to the ledger:
 *   loyalty_discount — the server-computed discount amount ("2.50")
 *   loyalty_attempt  — the redemption attempt id, cross-checked by the
 *                      orders/paid webhook against the ledger
 * This function only materializes that confirmed redemption as an order
 * discount; it never decides amounts itself. The amount is additionally
 * clamped to the cart subtotal as defense in depth against a hand-edited
 * attribute (the webhook-side attempt check is the authoritative guard).
 *
 * Types are hand-declared (the CLI's codegen needs a Partner login to fetch
 * the schema); shapes verified against the 2026-07 Discount API reference and
 * Shopify's function-examples template on 2026-10-01.
 */

export const DISCOUNT_CLASS_ORDER = 'ORDER';

export interface CartInput {
  cart: {
    redeemAmount?: { value?: string | null } | null;
    redeemAttempt?: { value?: string | null } | null;
    cost: { subtotalAmount: { amount: string } };
  };
  discount: { discountClasses: string[] };
}

export interface CartLinesDiscountsGenerateRunResult {
  operations: Array<{
    orderDiscountsAdd: {
      candidates: Array<{
        message: string;
        targets: Array<{ orderSubtotal: { excludedCartLineIds: string[] } }>;
        value: { fixedAmount: { amount: string } };
      }>;
      selectionStrategy: 'FIRST';
    };
  }>;
}

const AMOUNT_RE = /^\d+(?:\.\d{1,2})?$/;

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.discount.discountClasses.includes(DISCOUNT_CLASS_ORDER)) {
    return { operations: [] };
  }
  const raw = input.cart.redeemAmount?.value ?? '';
  const attempt = input.cart.redeemAttempt?.value ?? '';
  if (!AMOUNT_RE.test(raw) || attempt === '') return { operations: [] };

  const amount = Number(raw);
  const subtotal = Number(input.cart.cost.subtotalAmount.amount);
  if (!(amount > 0) || !Number.isFinite(subtotal)) return { operations: [] };
  const clamped = Math.min(amount, subtotal);
  if (!(clamped > 0)) return { operations: [] };

  return {
    operations: [
      {
        orderDiscountsAdd: {
          candidates: [
            {
              message: 'Loyalty points redeemed',
              targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
              value: { fixedAmount: { amount: clamped.toFixed(2) } },
            },
          ],
          selectionStrategy: 'FIRST',
        },
      },
    ],
  };
}
