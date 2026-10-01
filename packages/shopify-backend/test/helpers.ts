import { createHmac, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { InMemoryLedgerStore } from '@loyalty/ledger';
import { InMemoryReceiptStore } from '../src/receipts.js';
import { InMemorySettingsStore } from '../src/settings.js';
import { InMemoryComplianceStore } from '../src/compliance.js';
import { createApp, type AppDeps } from '../src/routes.js';

export const API_SECRET = 'test-secret';
export const API_KEY = 'test-client-id';
export const SHOP = 'test-shop.myshopify.com';

export function makeDeps(): AppDeps & {
  ledger: InMemoryLedgerStore;
  settings: InMemorySettingsStore;
  receipts: InMemoryReceiptStore;
  compliance: InMemoryComplianceStore;
} {
  return {
    ledger: new InMemoryLedgerStore(),
    settings: new InMemorySettingsStore(),
    receipts: new InMemoryReceiptStore(),
    compliance: new InMemoryComplianceStore(),
    apiSecret: API_SECRET,
    apiKey: API_KEY,
  };
}

export function makeApp(deps = makeDeps()) {
  return { app: createApp(deps), deps };
}

/**
 * Default token is a STAFF session (numeric sub, like POS/admin tokens).
 * Pass { sub: '<customer gid>' } for a customer token, or { sub: undefined }
 * for an anonymous token (e.g. a signed-out checkout visitor).
 */
export async function sessionToken(
  shop = SHOP,
  overrides: Record<string, unknown> = {},
  secret = API_SECRET,
): Promise<string> {
  const payload: Record<string, unknown> = {
    dest: `https://${shop}`,
    aud: API_KEY,
    jti: randomUUID(),
    sub: '5551001',
    ...overrides,
  };
  if (payload['sub'] === undefined) delete payload['sub'];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setNotBefore('0s')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

export function webhookRequest(
  topic: string,
  payload: unknown,
  options: { shop?: string; webhookId?: string; secret?: string } = {},
): Request {
  const rawBody = JSON.stringify(payload);
  const hmac = createHmac('sha256', options.secret ?? API_SECRET).update(rawBody).digest('base64');
  return new Request('http://localhost/webhooks', {
    method: 'POST',
    body: rawBody,
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': options.shop ?? SHOP,
      'x-shopify-webhook-id': options.webhookId ?? randomUUID(),
      'x-shopify-hmac-sha256': hmac,
    },
  });
}

export const paidOrder = (over: Record<string, unknown> = {}) => ({
  id: 1001,
  admin_graphql_api_id: 'gid://shopify/Order/1001',
  source_name: 'pos',
  test: false,
  total_price: '50.00',
  currency: 'USD',
  customer: { id: 42, admin_graphql_api_id: 'gid://shopify/Customer/42' },
  ...over,
});

export const refundPayload = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  admin_graphql_api_id: 'gid://shopify/Refund/9001',
  order_id: 1001,
  transactions: [{ kind: 'refund', status: 'success', amount: '20.00' }],
  ...over,
});
