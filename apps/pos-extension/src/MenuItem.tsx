/// <reference types="@shopify/ui-extensions/pos.customer-details.action.menu-item.render" />
import { render } from 'preact';

function MenuItem() {
  return <s-button onClick={() => shopify.action.presentModal()}>Redeem loyalty points</s-button>;
}

export default async () => {
  render(<MenuItem />, document.body);
};
