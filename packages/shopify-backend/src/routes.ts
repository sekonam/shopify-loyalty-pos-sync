import { randomUUID } from 'node:crypto';
import {
  redemptionDiscountAmount,
  selectTier,
  type LedgerStore,
  type RedemptionChannel,
  type VipTier,
} from '@loyalty/ledger';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { adminPageHtml } from './admin-page.js';
import { verifyWebhookHmac } from './hmac.js';
import { verifySessionToken } from './session-token.js';
import { processWebhook, TIER_WINDOW_MS, type WebhookDeps } from './webhooks.js';
import type { SettingsPatch, SettingsStore } from './settings.js';

export interface AppDeps extends WebhookDeps {
  ledger: LedgerStore;
  settings: SettingsStore;
  apiSecret: string;
  apiKey: string;
}

type Env = { Variables: { shopDomain: string; tokenSub: string | undefined } };

const isCustomerGid = (s: string | undefined): s is string =>
  typeof s === 'string' && s.startsWith('gid://shopify/Customer/');

/**
 * Token classification is an ALLOWLIST, never a denylist. A checkout token
 * for a signed-in customer carries the customer gid as `sub`; POS staff and
 * admin (App Bridge) tokens carry a numeric Shopify user id. A token with no
 * sub — e.g. a signed-out checkout visitor's session token, which is still
 * validly signed — is 'anonymous' and gets access to NOTHING identity-bound:
 * treating it as staff would let any storefront visitor read balances, spend
 * other customers' points, or rewrite shop settings.
 */
type TokenKind = 'customer' | 'staff' | 'anonymous';

function tokenKind(sub: string | undefined): TokenKind {
  if (isCustomerGid(sub)) return 'customer';
  if (typeof sub === 'string' && /^\d+$/.test(sub)) return 'staff';
  return 'anonymous';
}

/**
 * Who is this call about? A customer token is bound to its own customer (a
 * mismatching explicit customerId is refused); a staff token acts on an
 * explicitly named customer; an anonymous token on nobody.
 */
function resolveCustomerId(
  tokenSub: string | undefined,
  requested: string | undefined,
): { ok: true; customerId: string } | { ok: false; status: 400 | 403; error: string } {
  switch (tokenKind(tokenSub)) {
    case 'customer':
      if (requested !== undefined && requested !== tokenSub) {
        return { ok: false, status: 403, error: 'customerId does not match the session customer' };
      }
      return { ok: true, customerId: tokenSub as string };
    case 'staff':
      if (requested === undefined) {
        return { ok: false, status: 400, error: 'customerId required for a staff session' };
      }
      return { ok: true, customerId: requested };
    case 'anonymous':
      return { ok: false, status: 403, error: 'a signed-in customer or staff session is required' };
  }
}

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/healthz', (c) => c.json({ ok: true }));

  // The embedded admin page; its data calls go through the authed /api routes.
  app.get('/admin', (c) => c.html(adminPageHtml(deps.apiKey)));

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
    try {
      const outcome = await processWebhook({ topic, shopDomain, webhookId, rawBody }, deps);
      // Unknown topics still get 200 — retrying them cannot help and 8 failures
      // removes the subscription.
      return c.json(outcome, 200);
    } catch (err) {
      // Handler failure: the receipt stays unprocessed, the non-2xx makes
      // Shopify redeliver, and the redelivery re-runs the handler.
      deps.log?.('webhook handler failed', { topic, shopDomain, webhookId, error: String(err) });
      return c.json({ error: 'handler failed, retry expected' }, 500);
    }
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
      c.set('tokenSub', claims.userId);
    } catch {
      return c.json({ error: 'invalid session token' }, 401);
    }
    return next();
  });

  api.get('/balance', async (c) => {
    const resolved = resolveCustomerId(c.get('tokenSub'), c.req.query('customerId'));
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const customerId = resolved.customerId;
    const shopDomain = c.get('shopDomain');
    const [balance, settings] = await Promise.all([
      deps.ledger.balance(shopDomain, customerId),
      deps.settings.get(shopDomain),
    ]);
    let tier: { name: string; multiplier: string; earned365: number } | null = null;
    if (settings.tiers?.length) {
      const earned365 = await deps.ledger.earnedSince(
        shopDomain,
        customerId,
        new Date(Date.now() - TIER_WINDOW_MS),
      );
      const t = selectTier(settings.tiers, earned365);
      tier = t ? { name: t.name, multiplier: t.multiplier, earned365 } : { name: '', multiplier: '1', earned365 };
    }
    return c.json({
      customerId,
      balance,
      minRedemption: settings.minRedemption,
      redemptionRate: settings.redemptionRate,
      // Redemptions are priced in the shop currency; checkout must not offer
      // redemption in a different presentment currency (v1 single-currency).
      currency: settings.currency ?? null,
      tier,
      maxDiscountAmount: redemptionDiscountAmount(
        Math.max(balance, 0),
        settings.redemptionRate,
      ),
    });
  });

  // Advocate's shareable referral code — customer sessions only (the code
  // belongs to the signed-in customer; staff have no advocate identity here).
  api.get('/referral-code', async (c) => {
    const sub = c.get('tokenSub');
    if (tokenKind(sub) !== 'customer') {
      return c.json({ error: 'a signed-in customer session is required' }, 403);
    }
    const settings = await deps.settings.get(c.get('shopDomain'));
    if (!settings.referral?.enabled) return c.json({ error: 'referral program disabled' }, 404);
    const code = await deps.referrals.codeFor(c.get('shopDomain'), sub as string);
    return c.json({
      code,
      advocatePoints: settings.referral.advocatePoints,
      friendPoints: settings.referral.friendPoints,
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
    const { points, attemptId, channel } = body;
    if (
      !attemptId ||
      !Number.isInteger(points) ||
      (points as number) <= 0 ||
      (channel !== 'web' && channel !== 'pos') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)
    ) {
      return c.json(
        { error: 'integer points, uuid attemptId, channel web|pos required' },
        400,
      );
    }
    const tokenSub = c.get('tokenSub');
    const kind = tokenKind(tokenSub);
    // Channel/identity pairing is strict: web redemptions only for the
    // signed-in customer the token names; POS redemptions only by staff.
    if (channel === 'web' && kind !== 'customer') {
      return c.json({ error: 'web redemption requires a signed-in customer session' }, 403);
    }
    if (channel === 'pos' && kind !== 'staff') {
      return c.json({ error: 'pos redemption requires a staff session' }, 403);
    }
    const resolved = resolveCustomerId(tokenSub, body.customerId);
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const customerId = resolved.customerId;
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

  // ---- Merchant-only routes. A checkout session token identifies a CUSTOMER
  // (sub is a Customer gid); customers must never read other customers' data
  // or rewrite shop configuration. Staff (POS) and admin (App Bridge) tokens
  // carry a staff user sub instead and pass.
  const merchant = new Hono<Env>();
  merchant.use('*', async (c, next) => {
    if (tokenKind(c.get('tokenSub')) !== 'staff') {
      return c.json({ error: 'merchant session required' }, 403);
    }
    return next();
  });

  merchant.get('/entries', async (c) => {
    const shopDomain = c.get('shopDomain');
    const customerId = c.req.query('customerId');
    const entries = customerId
      ? await deps.ledger.entries(shopDomain, customerId)
      : await deps.ledger.entriesForShop(shopDomain);
    return c.json({ entries });
  });

  merchant.get('/ledger.csv', async (c) => {
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

  /**
   * Giveaway/contest/goodwill point awards (v2): positive deltas append,
   * negative ones go through appendCapped so a deduction can never push a
   * balance below zero. batchId + row index form the idempotency key, so a
   * retried request can't double-award.
   */
  merchant.post('/awards', async (c) => {
    let body: {
      batchId?: string;
      awards?: Array<{ customerId?: string; points?: number }>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const batchId = body.batchId ?? randomUUID();
    const awards = body.awards ?? [];
    if (
      awards.length === 0 ||
      awards.length > 500 ||
      !awards.every(
        (a) =>
          typeof a.customerId === 'string' &&
          a.customerId !== '' &&
          Number.isInteger(a.points) &&
          a.points !== 0,
      )
    ) {
      return c.json(
        { error: '1-500 awards of {customerId, nonzero integer points} required' },
        400,
      );
    }
    const shopDomain = c.get('shopDomain');
    const results: Array<{ customerId: string; applied: number }> = [];
    for (const [i, award] of awards.entries()) {
      const draft = {
        shopDomain,
        customerId: award.customerId as string,
        sourceName: 'system' as const,
        delta: award.points as number,
        reason: 'adjustment' as const,
        idempotencyKey: `award:${batchId}:${i}`,
      };
      if ((award.points as number) > 0) {
        const { entry, inserted } = await deps.ledger.append(draft);
        results.push({ customerId: draft.customerId, applied: inserted ? entry.delta : 0 });
      } else {
        const result = await deps.ledger.appendCapped(draft);
        results.push({
          customerId: draft.customerId,
          applied: result?.inserted ? result.entry.delta : 0,
        });
      }
    }
    return c.json({ batchId, results });
  });

  merchant.get('/settings', async (c) => {
    const settings = await deps.settings.get(c.get('shopDomain'));
    return c.json(settingsView(settings));
  });

  merchant.put('/settings', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = parseSettingsPatch(body);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const settings = await deps.settings.upsert(c.get('shopDomain'), parsed.patch);
    return c.json(settingsView(settings));
  });

  api.route('/', merchant);
  app.route('/api', api);
  return app;
}

function settingsView(settings: Awaited<ReturnType<SettingsStore['get']>>) {
  return {
    earnRate: settings.earnRate,
    redemptionRate: settings.redemptionRate,
    minRedemption: settings.minRedemption,
    channelRules: settings.channelRules ?? {},
    excludedSources: settings.excludedSources ?? [],
    tiers: settings.tiers ?? [],
    referral: settings.referral,
  };
}

const RULE_CHANNELS = ['web', 'pos', 'mobile_app', 'other'] as const;

function parseSettingsPatch(body: Record<string, unknown>): { patch: SettingsPatch } | { error: string } {
  const patch: SettingsPatch = {};
  if (body['earnRate'] !== undefined) {
    if (!isPositiveDecimal(body['earnRate'] as string)) return { error: 'earnRate must be a positive decimal string' };
    patch.earnRate = body['earnRate'] as string;
  }
  if (body['redemptionRate'] !== undefined) {
    if (!isPositiveDecimal(body['redemptionRate'] as string)) return { error: 'redemptionRate must be a positive decimal string' };
    patch.redemptionRate = body['redemptionRate'] as string;
  }
  if (body['minRedemption'] !== undefined) {
    if (!Number.isInteger(body['minRedemption']) || (body['minRedemption'] as number) <= 0) {
      return { error: 'minRedemption must be a positive integer' };
    }
    patch.minRedemption = body['minRedemption'] as number;
  }
  if (body['channelRules'] !== undefined) {
    const rules = body['channelRules'];
    if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
      return { error: 'channelRules must be an object keyed by channel' };
    }
    for (const [channel, rule] of Object.entries(rules as Record<string, unknown>)) {
      if (!RULE_CHANNELS.includes(channel as (typeof RULE_CHANNELS)[number])) {
        return { error: `unknown channel '${channel}' (use ${RULE_CHANNELS.join('/')})` };
      }
      const r = rule as { enabled?: unknown; earnRate?: unknown };
      if (typeof r?.enabled !== 'boolean') return { error: `channelRules.${channel}.enabled must be boolean` };
      if (r.earnRate !== undefined && !isPositiveDecimal(r.earnRate as string)) {
        return { error: `channelRules.${channel}.earnRate must be a positive decimal string` };
      }
    }
    patch.channelRules = rules as NonNullable<SettingsPatch['channelRules']>;
  }
  if (body['excludedSources'] !== undefined) {
    const list = body['excludedSources'];
    if (!Array.isArray(list) || !list.every((s) => typeof s === 'string' && s.trim() !== '')) {
      return { error: 'excludedSources must be an array of non-empty strings' };
    }
    patch.excludedSources = (list as string[]).map((s) => s.trim());
  }
  if (body['tiers'] !== undefined) {
    const tiers = body['tiers'];
    if (
      !Array.isArray(tiers) ||
      tiers.length > 20 ||
      !tiers.every(
        (t: { name?: unknown; minEarned365?: unknown; multiplier?: unknown }) =>
          typeof t?.name === 'string' &&
          t.name.trim() !== '' &&
          Number.isInteger(t.minEarned365) &&
          (t.minEarned365 as number) >= 0 &&
          isPositiveDecimal(t.multiplier as string),
      )
    ) {
      return { error: 'tiers must be [{name, minEarned365 >= 0, positive decimal multiplier}] (max 20)' };
    }
    patch.tiers = tiers as VipTier[];
  }
  if (body['referral'] !== undefined) {
    const r = body['referral'] as { enabled?: unknown; advocatePoints?: unknown; friendPoints?: unknown };
    if (
      typeof r?.enabled !== 'boolean' ||
      !Number.isInteger(r.advocatePoints) ||
      (r.advocatePoints as number) < 0 ||
      !Number.isInteger(r.friendPoints) ||
      (r.friendPoints as number) < 0
    ) {
      return { error: 'referral must be {enabled, advocatePoints >= 0, friendPoints >= 0}' };
    }
    patch.referral = {
      enabled: r.enabled,
      advocatePoints: r.advocatePoints as number,
      friendPoints: r.friendPoints as number,
    };
  }
  return { patch };
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function isPositiveDecimal(s: string): boolean {
  return typeof s === 'string' && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0;
}
