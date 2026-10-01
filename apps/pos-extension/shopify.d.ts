import '@shopify/ui-extensions';

declare module './src/Block.tsx' {
  const shopify: import('@shopify/ui-extensions/pos.customer-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

declare module './src/MenuItem.tsx' {
  const shopify: import('@shopify/ui-extensions/pos.customer-details.action.menu-item.render').Api;
  const globalThis: { shopify: typeof shopify };
}

declare module './src/Action.tsx' {
  const shopify: import('@shopify/ui-extensions/pos.customer-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
