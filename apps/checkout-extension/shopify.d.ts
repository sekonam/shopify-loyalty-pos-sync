import '@shopify/ui-extensions';

declare module './extensions/loyalty-balance/src/Checkout.tsx' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
