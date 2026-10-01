import {
  redemptionDiscountAmount,
  type LedgerStore,
  type RedemptionChannel,
} from '@loyalty/ledger';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { verifyWebhookHmac } from './hmac.js';
import { verifySessionToken } from './session-token.js';
import { processWebhook, type WebhookDeps } from './webhooks.js';
import type { SettingsStore } from './settings.js';

export interface AppDeps extends WebhookDeps {
  ledger: LedgerStore;
  settings: SettingsStore;
  apiSecret: string;
  apiKey: string;
}

type Env = { Variables: { shopDomain: string } };

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/healthz', (c) => c.json({ ok: true }));

  // ---- Webhooks: HMAC on the raw bytes, then dispatch. Always answer fast;
  // Shopify's delivery timeout is 5s and non-2xx (incl. redirects) counts failed.
  app.post('/webhooks', async (c) => {
    const rawBody = await c.req.text();
    const hmacOk = verifyWebhookHmac(
      rawBody,
      c.req.header('x-shopify-hmac-sha256'),
      deps.apiSecret,
    );
    if (!hmacOk) return c.json({ error: 'invalid hmac' }, 401);
    const topic = c.req.header('x-shopify-topic');
    const shopDomain = c.req.header('x-shopify-shop-domain');
    const webhookId = c.req.header('x-shopify-webhook-id');
    if (!topic || !shopDomain || !webhookId) {
      return c.json({ error: 'missing webhook headers' }, 400);
    }
    const outcome = await processWebhook({ topic, shopDomain, webhookId, rawBody }, deps);
    // Unknown topics still get 200 — retrying them cannot help and 8 failures
    // removes the subscription.
    return c.json(outcome, 200);
  });

  // ---- Extension/admin API: session-token auth (POS, checkout, and the
  // embedded admin all attach a Shopify session token). The extension worker
  // origin is not stable, so CORS is wide open and auth carries everything.
  const api = new Hono<Env>();
  api.use(
    '*',
    cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'], maxAge: 600 }),
  );
  api.use('*', async (c, next) => {
    const auth = c.req.header('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    if (!token) return c.json({ error: 'missing session token' }, 401);
    try {
      const claims = await verifySessionToken(token, deps.apiSecret, deps.apiKey);
      c.set('shopDomain', claims.shopDomain);
    } catch {
      return c.json({ error: 'invalid session token' }, 401);
    }
    return next();
  });

  api.get('/balance', async (c) => {
    const customerId = c.req.query('customerId');
    if (!customerId) return c.json({ error: 'customerId required' }, 400);
    const shopDomain = c.get('shopDomain');
    const [balance, settings] = await Promise.all([
      deps.ledger.balance(shopDomain, customerId),
      deps.settings.get(shopDomain),
    ]);
    return c.json({
      customerId,
      balance,
      minRedemption: settings.minRedemption,
      redemptionRate: settings.redemptionRate,
      maxDiscountAmount: redemptionDiscountAmount(
        Math.max(balance, 0),
        settings.redemptionRate,
      ),
    });
  });

  api.post('/redeem', async (c) => {
    const shopDomain = c.get('shopDomain');
    let body: {
      customerId?: string;
      points?: number;
      attemptId?: string;
      channel?: string;
      posDeviceId?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const { customerId, points, attemptId, channel } = body;
    if (
      !customerId ||
      !attemptId ||
      !Number.isInteger(points) ||
      (channel !== 'web' && channel !== 'pos') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
    ) {
      return c.json(
        { error: 'customerId, integer points, uuid attemptId, channel web|pos required' },
        400,
      );
    }
    const settings = await deps.settings.get(shopDomain);
    const result = await deps.ledger.redeem({
      shopDomain,
      customerId,
      channel: channel as RedemptionChannel,
      requestedPoints: points as number,
      minRedemption: settings.minRedemption,
      attemptId,
      ...(body.posDeviceId !== undefined ? { posDeviceId: body.posDeviceId } : {}),
    });
    if (result.status !== 'applied') {
      return c.json({ status: result.status, balance: result.balance }, 409);
    }
    return c.json({
      status: result.status,
      balance: result.balance,
      discountAmount: redemptionDiscountAmount(points as number, settings.redemptionRate),
      discountTitle: `${points} points redeemed`,
    });
  });

  api.get('/entries', async (c) => {
    const shopDomain = c.get('shopDomain');
    const customerId = c.req.query('customerId');
    const entries = customerId
      ? await deps.ledger.entries(shopDomain, customerId)
      : await deps.ledger.entriesForShop(shopDomain);
    return c.json({ entries });
  });

  api.get('/ledger.csv', async (c) => {
    const shopDomain = c.get('shopDomain');
    const customerId = c.req.query('customerId');
    const entries = customerId
      ? await deps.ledger.entries(shopDomain, customerId)
      : await deps.ledger.entriesForShop(shopDomain);
    const header = 'id,customer_id,order_id,refund_id,source_name,delta,reason,created_at';
    const lines = entries.map((e) =>
      [
        e.id,
        e.customerId,
        e.orderId ?? '',
        e.refundId ?? '',
        e.sourceName,
        e.delta,
        e.reason,
        e.createdAt.toISOString(),
      ]
        .map(csvCell)
        .join(','),
    );
    return c.text([header, ...lines].join('\n'), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="points-ledger.csv"',
    });
  });

  api.get('/settings', async (c) => {
    const settings = await deps.settings.get(c.get('shopDomain'));
    return c.json({
      earnRate: settings.earnRate,
      redemptionRate: settings.redemptionRate,
      minRedemption: settings.minRedemption,
    });
  });

  api.put('/settings', async (c) => {
    let body: { earnRate?: string; redemptionRate?: string; minRedemption?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const patch: Parameters<SettingsStore['upsert']>[1] = {};
    if (body.earnRate !== undefined) {
      if (!isPositiveDecimal(body.earnRate)) return c.json({ error: 'earnRate must be a positive decimal string' }, 400);
      patch.earnRate = body.earnRate;
    }
    if (body.redemptionRate !== undefined) {
      if (!isPositiveDecimal(body.redemptionRate)) return c.json({ error: 'redemptionRate must be a positive decimal string' }, 400);
      patch.redemptionRate = body.redemptionRate;
    }
    if (body.minRedemption !== undefined) {
      if (!Number.isInteger(body.minRedemption) || body.minRedemption <= 0) {
        return c.json({ error: 'minRedemption must be a positive integer' }, 400);
      }
      patch.minRedemption = body.minRedemption;
    }
    const settings = await deps.settings.upsert(c.get('shopDomain'), patch);
    return c.json({
      earnRate: settings.earnRate,
      redemptionRate: settings.redemptionRate,
      minRedemption: settings.minRedemption,
    });
  });

  app.route('/api', api);
  return app;
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function isPositiveDecimal(s: string): boolean {
  return typeof s === 'string' && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0;
}
