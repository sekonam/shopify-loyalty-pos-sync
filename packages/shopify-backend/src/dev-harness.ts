import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { Hono } from 'hono';
import { reconcileAllShops, type ReconRunStore, type SchedulerDeps } from './scheduler.js';
import { designSystemCss, faviconLink, logoMarkSvg } from './ui/theme.js';

/**
 * LOCAL DEVELOPMENT ONLY — mounted by the server exclusively when
 * DEV_HARNESS=1. Mints session tokens with the app secret so the admin page
 * and the test console below can authenticate against /api outside Shopify's
 * embedded context (no Partner app exists yet). Never enable in production:
 * this endpoint hands out staff tokens to anyone who can reach the server.
 */
export interface DevHarnessConfig {
  apiSecret: string;
  apiKey: string;
  defaultShop: string;
  /**
   * The real `shop_token` writer (PgReconRunStore), so a dev-registered Admin
   * token lands in the row OAuth would have written and `accessTokenFor` is
   * exercised for real rather than stubbed past.
   */
  tokens?: DevTokenStore;
  /**
   * The scheduler's own dependencies, so /reconcile drives the SAME sweep the
   * hourly loop drives instead of a parallel imitation of it.
   */
  scheduler?: SchedulerDeps;
  /** Present only when DEV_ADMIN_STUB=1 — see DevAdminStub. */
  adminStub?: DevAdminStub;
}

export interface DevTokenStore {
  storeToken(shopDomain: string, accessToken: string): Promise<void>;
}

export function createDevApp(config: DevHarnessConfig): Hono {
  const app = new Hono();

  const shopOf = (c: { req: { query(k: string): string | undefined } }): string =>
    c.req.query('shop') ?? config.defaultShop;

  /**
   * Registers an Admin API token for a shop. Nothing here forges a token for
   * Shopify — the stub below is what accepts it; the point is that the whole
   * chain (token row → accessTokenFor → Authorization header) runs as written.
   */
  app.post('/admin-token', async (c) => {
    if (!config.tokens) return c.json({ error: 'no token store wired into the dev harness' }, 501);
    const shop = shopOf(c);
    const token = c.req.query('token') ?? `dev-admin-token-${randomUUID()}`;
    await config.tokens.storeToken(shop, token);
    return c.json({ shop, token });
  });

  /**
   * Seeds the order history the stub serves — i.e. what Shopify "knows" that
   * the ledger may not. An order seeded here with no matching webhook IS the
   * dropped-webhook case the reconciliation job exists for.
   */
  app.post('/admin-orders', async (c) => {
    const stub = config.adminStub;
    if (!stub) return c.json({ error: 'DEV_ADMIN_STUB is not enabled' }, 501);
    let body: {
      orders?: unknown;
      reset?: unknown;
      pageSize?: unknown;
      failWith?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed: StubAdminOrder[] = [];
    const problems: string[] = [];
    if (body.orders !== undefined) {
      if (!Array.isArray(body.orders)) return c.json({ error: 'orders must be an array' }, 400);
      for (const raw of body.orders) {
        const one = parseStubOrder(raw);
        if (typeof one === 'string') problems.push(one);
        else parsed.push(one);
      }
    }
    // A malformed seed must fail loudly here: accepted-but-ignored orders
    // would show up later as a reconciliation that mysteriously healed
    // nothing, which is the one conclusion this harness must never fake.
    if (problems.length) return c.json({ error: 'malformed orders', problems }, 400);
    if (body.pageSize !== undefined && !(Number.isInteger(body.pageSize) && (body.pageSize as number) > 0)) {
      return c.json({ error: 'pageSize must be a positive integer' }, 400);
    }
    if (body.failWith !== undefined && body.failWith !== null && typeof body.failWith !== 'string') {
      return c.json({ error: 'failWith must be a string or null' }, 400);
    }
    const shop = shopOf(c);
    stub.seed(shop, {
      orders: parsed,
      reset: body.reset === true,
      ...(body.pageSize !== undefined ? { pageSize: body.pageSize as number } : {}),
      ...(body.failWith !== undefined ? { failWith: body.failWith as string | null } : {}),
    });
    return c.json({ shop, ...stub.snapshot(shop) });
  });

  app.get('/admin-orders', (c) => {
    const stub = config.adminStub;
    if (!stub) return c.json({ error: 'DEV_ADMIN_STUB is not enabled' }, 501);
    const shop = shopOf(c);
    return c.json({ shop, ...stub.snapshot(shop), orders: stub.ordersFor(shop) });
  });

  /**
   * One reconciliation sweep, now, for one shop — the hourly loop is useless
   * to a script. `sinceBefore`/`sinceAfter` expose the window arithmetic a
   * caller otherwise cannot see: a FAILED run must leave it where it was, so
   * the next run retries the same slice of history.
   */
  app.post('/reconcile', async (c) => {
    const scheduler = config.scheduler;
    if (!scheduler) return c.json({ error: 'no scheduler wired into the dev harness' }, 501);
    const shop = shopOf(c);
    const eligible = (await scheduler.runs.shopsToReconcile()).includes(shop);
    const sinceBefore = await scheduler.runs.nextSince(shop);
    const callsBefore = config.adminStub?.callsFor(shop) ?? 0;
    await reconcileAllShops({ ...scheduler, runs: onlyThisShop(scheduler.runs, shop) });
    const run = await scheduler.runs.lastRun(shop);
    const sinceAfter = await scheduler.runs.nextSince(shop);
    return c.json({
      shop,
      /** False means the eligibility join refused the shop and nothing ran. */
      eligible,
      sinceBefore: sinceBefore?.toISOString() ?? null,
      sinceAfter: sinceAfter?.toISOString() ?? null,
      /** Admin API round-trips this run took — paging, observable. */
      stubCalls: (config.adminStub?.callsFor(shop) ?? 0) - callsBefore,
      run: run
        ? {
            finishedAt: run.finishedAt?.toISOString() ?? null,
            ordersSeen: run.ordersSeen,
            entriesAdded: run.entriesAdded,
            error: run.error ?? null,
          }
        : null,
    });
  });

  app.get('/token', async (c) => {
    const kind = c.req.query('kind') ?? 'staff';
    const shop = c.req.query('shop') ?? config.defaultShop;
    const customerId = c.req.query('customerId');
    const payload: Record<string, unknown> = {
      dest: `https://${shop}`,
      aud: config.apiKey,
      jti: randomUUID(),
    };
    if (kind === 'staff') payload['sub'] = '990001';
    if (kind === 'customer') {
      if (!customerId) return c.json({ error: 'customerId required for kind=customer' }, 400);
      payload['sub'] = customerId;
    }
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setNotBefore('0s')
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(config.apiSecret));
    return c.json({ token, kind, shop });
  });

  app.get('/', (c) => {
    c.header('cache-control', 'no-store');
    return c.html(consolePage(config.defaultShop));
  });
  return app;
}

/**
 * A view of the real run store narrowed to one shop. The dev sweep goes
 * through `reconcileAllShops` on purpose — window arithmetic, run recording
 * and the failure/retry path are exactly what a harness must not reimplement —
 * but a local run must never advance (or fail) another shop's checkpoint,
 * least of all a dataset another workstream is testing against.
 */
function onlyThisShop(runs: ReconRunStore, shopDomain: string): ReconRunStore {
  return {
    nextSince: (shop) => runs.nextSince(shop),
    recordRun: (run) => runs.recordRun(run),
    lastRun: (shop) => runs.lastRun(shop),
    // Still the REAL eligibility join, merely filtered: a shop with no token
    // or no installed settings row must stay ineligible here too.
    shopsToReconcile: async () =>
      (await runs.shopsToReconcile()).filter((shop) => shop === shopDomain),
  };
}

/**
 * One order as the Admin API would return it for the reconciliation query —
 * the RECON_QUERY node shape verbatim (see admin-client.ts), so what a script
 * seeds is what Shopify would actually have said.
 */
export interface StubAdminOrder {
  id: string;
  sourceName: string | null;
  test: boolean;
  displayFinancialStatus: string | null;
  customer: { id: string } | null;
  totalPriceSet: { shopMoney: { amount: string } };
  /**
   * The checkout's loyalty attributes under their Admin API name — what the
   * webhook calls note_attributes. Seedable because the sweep's clawback and
   * referral steps read them, so an order without them cannot exercise either.
   */
  customAttributes: Array<{ key: string; value: string | null }>;
  refunds: Array<{ id: string; totalRefundedSet: { shopMoney: { amount: string } } }>;
  /**
   * Not part of the query's selection set — the stub keeps it to honour the
   * `updated_at:>=` filter and UPDATED_AT sort the job relies on, and strips
   * it from responses so the client sees only fields it asked for.
   */
  updatedAt: string;
}

interface ShopStub {
  orders: StubAdminOrder[];
  /** The job asks for `first: 50`; a smaller page is how paging gets tested. */
  pageSize: number;
  /** Set to make the next calls answer a GraphQL error, as Shopify does under throttling. */
  failWith: string | undefined;
  calls: number;
}

const SINCE_PATTERN = /updated_at:>='([^']+)'/;
const ADMIN_GRAPHQL_PATH = /^\/admin\/api\/[^/]+\/graphql\.json$/;

/** Opaque to the caller, as a real cursor is — the job must not do arithmetic on it. */
const encodeCursor = (offset: number): string =>
  Buffer.from(`offset:${offset}`, 'utf8').toString('base64');

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const offset = /^offset:(\d+)$/.exec(decoded)?.[1];
  return offset === undefined ? 0 : Number(offset);
}

/**
 * A local stand-in for Shopify's Admin GraphQL API, serving the one query the
 * reconciliation job sends.
 *
 * Why it exists: "a dropped orders/paid webhook self-heals within one
 * reconciliation cycle" (TECHNICAL-SPEC §5) is the product's central claim,
 * and unit tests prove only the diff logic — not that the real client, the
 * real token lookup, the real window arithmetic and the real ledger writes
 * line up. Those meet for the first time at an Admin API, and there is no
 * Partner account to meet at yet (START-HERE.md). `GraphqlAdminOrdersClient`
 * already takes an injectable fetch for its unit tests; this reuses that seam
 * against a seeded order history.
 *
 * LOCAL ONLY. The server constructs this exclusively when DEV_HARNESS=1 AND
 * DEV_ADMIN_STUB=1; with either flag absent the orders client is built
 * against the real `fetch`, untouched.
 */
export class DevAdminStub {
  private readonly shops = new Map<string, ShopStub>();

  private state(shopDomain: string): ShopStub {
    let state = this.shops.get(shopDomain);
    if (!state) {
      state = { orders: [], pageSize: 50, failWith: undefined, calls: 0 };
      this.shops.set(shopDomain, state);
    }
    return state;
  }

  seed(
    shopDomain: string,
    patch: {
      orders?: StubAdminOrder[];
      reset?: boolean;
      pageSize?: number;
      failWith?: string | null;
    },
  ): void {
    const state = this.state(shopDomain);
    if (patch.reset) {
      state.orders = [];
      state.calls = 0;
    }
    if (patch.pageSize !== undefined) state.pageSize = patch.pageSize;
    if (patch.failWith !== undefined) state.failWith = patch.failWith ?? undefined;
    for (const order of patch.orders ?? []) {
      // Re-seeding an id replaces it, so a script can add refunds to an order
      // the ledger already earned on without growing a second copy of it.
      const at = state.orders.findIndex((o) => o.id === order.id);
      if (at >= 0) state.orders[at] = order;
      else state.orders.push(order);
    }
  }

  snapshot(shopDomain: string): {
    orderCount: number;
    pageSize: number;
    failWith: string | null;
    calls: number;
  } {
    const state = this.state(shopDomain);
    return {
      orderCount: state.orders.length,
      pageSize: state.pageSize,
      failWith: state.failWith ?? null,
      calls: state.calls,
    };
  }

  ordersFor(shopDomain: string): StubAdminOrder[] {
    return this.state(shopDomain).orders;
  }

  callsFor(shopDomain: string): number {
    return this.state(shopDomain).calls;
  }

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    // Anything else would be a real outbound call from a harness run. Loud,
    // not silently proxied: a dev run must not reach the internet by accident.
    if (!ADMIN_GRAPHQL_PATH.test(url.pathname)) {
      throw new Error(`dev Admin stub will not proxy ${href}`);
    }
    const shopDomain = url.hostname;
    const state = this.state(shopDomain);
    state.calls += 1;

    const headers = new Headers(init?.headers);
    // The real API answers 401 without it, and the job's token lookup is part
    // of what this harness is here to exercise.
    if (!headers.get('x-shopify-access-token')) {
      return json({ errors: [{ message: 'Invalid API key or access token' }] }, 401);
    }
    if (state.failWith) {
      return json({ errors: [{ message: state.failWith, extensions: { code: 'THROTTLED' } }] });
    }

    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : {};
    const variables = (body as { variables?: { query?: unknown; cursor?: unknown } }).variables;
    const since = SINCE_PATTERN.exec(String(variables?.query ?? ''))?.[1];
    const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
    const window = state.orders
      .filter((order) => Date.parse(order.updatedAt) >= sinceMs)
      .sort(
        (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id),
      );
    const offset = typeof variables?.cursor === 'string' ? decodeCursor(variables.cursor) : 0;
    const page = window.slice(offset, offset + state.pageSize);
    const end = offset + page.length;
    return json({
      data: {
        orders: {
          pageInfo: {
            hasNextPage: end < window.length,
            endCursor: page.length ? encodeCursor(end) : null,
          },
          nodes: page.map(({ updatedAt: _updatedAt, ...node }) => node),
        },
      },
    });
  };
}

export const createDevAdminStub = (): DevAdminStub => new DevAdminStub();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Validated seed input, or the reason it was refused. */
function parseStubOrder(raw: unknown): StubAdminOrder | string {
  const order = raw as Partial<StubAdminOrder> & { updatedAt?: unknown };
  const id = order?.id;
  if (typeof id !== 'string' || !id.startsWith('gid://shopify/Order/')) {
    return `id must be an Order gid, got ${JSON.stringify(order?.id)}`;
  }
  if (typeof order.test !== 'boolean') return `${id}: test must be a boolean`;
  if (order.sourceName !== null && typeof order.sourceName !== 'string') {
    return `${id}: sourceName must be a string or null`;
  }
  if (order.displayFinancialStatus !== null && typeof order.displayFinancialStatus !== 'string') {
    return `${id}: displayFinancialStatus must be a string or null`;
  }
  const customer = order.customer;
  if (customer !== null && typeof customer?.id !== 'string') {
    return `${id}: customer must be null or { id }`;
  }
  const amount = order.totalPriceSet?.shopMoney?.amount;
  if (typeof amount !== 'string') {
    return `${id}: totalPriceSet.shopMoney.amount must be a string`;
  }
  const attributesRaw = order.customAttributes ?? [];
  if (!Array.isArray(attributesRaw)) return `${id}: customAttributes must be an array`;
  const customAttributes: StubAdminOrder['customAttributes'] = [];
  for (const attribute of attributesRaw) {
    const key = (attribute as { key?: unknown })?.key;
    const value = (attribute as { value?: unknown })?.value;
    if (typeof key !== 'string') {
      return `${id}: customAttributes key must be a string, got ${JSON.stringify(key)}`;
    }
    // Shopify returns a valueless attribute as an explicit null, not an
    // absent field, and the client's mapping depends on that distinction.
    if (value !== null && value !== undefined && typeof value !== 'string') {
      return `${id}: customAttributes ${key} value must be a string or null`;
    }
    customAttributes.push({ key, value: value ?? null });
  }
  const refundsRaw = order.refunds ?? [];
  if (!Array.isArray(refundsRaw)) return `${id}: refunds must be an array`;
  const refunds: StubAdminOrder['refunds'] = [];
  for (const refund of refundsRaw) {
    const refundId = (refund as { id?: unknown })?.id;
    const refunded = (refund as { totalRefundedSet?: { shopMoney?: { amount?: unknown } } })
      ?.totalRefundedSet?.shopMoney?.amount;
    if (typeof refundId !== 'string' || !refundId.startsWith('gid://shopify/Refund/')) {
      return `${id}: refund id must be a Refund gid, got ${JSON.stringify(refundId)}`;
    }
    if (typeof refunded !== 'string') {
      return `${id}: refund ${refundId} totalRefundedSet.shopMoney.amount must be a string`;
    }
    refunds.push({ id: refundId, totalRefundedSet: { shopMoney: { amount: refunded } } });
  }
  // An order with no explicit timestamp is one that just changed, which is
  // the common case a script wants: inside whatever window the next run uses.
  const updatedAt = order.updatedAt === undefined ? new Date().toISOString() : order.updatedAt;
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
    return `${id}: updatedAt must be an ISO timestamp`;
  }
  return {
    id,
    sourceName: order.sourceName,
    test: order.test,
    displayFinancialStatus: order.displayFinancialStatus,
    customer: customer === null ? null : { id: customer.id as string },
    totalPriceSet: { shopMoney: { amount } },
    customAttributes,
    refunds,
    updatedAt,
  };
}

/** A stand-in for the checkout/POS widgets: same API calls, plain browser page. */
function consolePage(shop: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Loyalty dev console</title>
${faviconLink()}
<style>${designSystemCss({ dark: true })}
  .result { font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; margin: 0;
            padding: var(--space-4); background: var(--surface-subdued); border-radius: var(--radius);
            border: 1px solid var(--border); min-height: 96px; }
</style>
</head>
<body>
<div class="page">
  <header class="page-header">
    <span class="mark">${logoMarkSvg}</span>
    <div>
      <h1 class="page-title">Dev console</h1>
      <p class="page-subtitle">Drives the same <code>/api</code> endpoints the POS and checkout extensions call, against <strong>${shop}</strong>. Local development only.</p>
    </div>
    <div class="page-header-actions">
      <a class="btn btn-sm" href="/admin">Merchant admin</a>
    </div>
  </header>

  <div class="stack">
    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Customer</h2>
        <p class="card-description">The customer every call below acts on.</p>
      </div></div>
      <div class="card-body">
        <div class="row">
          <div class="field">
            <label class="field-label" for="customer">Customer number</label>
            <input class="input input-md" id="customer" value="9001" inputmode="numeric" />
          </div>
          <div class="field">
            <label class="field-label" for="points">Points to redeem</label>
            <input class="input input-sm" id="points" value="100" inputmode="numeric" />
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-header"><div>
          <h2 class="card-title">As the shopper</h2>
          <p class="card-description">Customer session token, as the checkout extension holds.</p>
        </div></div>
        <div class="card-body"><div class="row">
          <button class="btn" id="balance" type="button">Get balance</button>
          <button class="btn btn-primary" id="redeem-web" type="button">Redeem online</button>
          <button class="btn" id="referral" type="button">Referral code</button>
        </div></div>
      </div>

      <div class="card">
        <div class="card-header"><div>
          <h2 class="card-title">As store staff</h2>
          <p class="card-description">Staff session token, as the POS extension holds.</p>
        </div></div>
        <div class="card-body"><div class="row">
          <button class="btn" id="balance-staff" type="button">Get balance</button>
          <button class="btn btn-primary" id="redeem-pos" type="button">Redeem at POS</button>
          <button class="btn btn-critical" id="forbidden" type="button">Shopper hits settings (expect 403)</button>
        </div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Response</h2>
        <p class="card-description" id="verdict">Pick an action above.</p>
      </div><div class="row-end" id="status-badge"></div></div>
      <div class="card-body"><pre class="result" id="out">Ready.</pre></div>
    </div>
  </div>
</div>

<script>
const out = document.getElementById('out');
const verdict = document.getElementById('verdict');
const statusBadge = document.getElementById('status-badge');
const gid = () => 'gid://shopify/Customer/' + document.getElementById('customer').value.trim();
const pts = () => Number(document.getElementById('points').value);
function show(label, status, body, good, note) {
  out.textContent = JSON.stringify(body, null, 2);
  verdict.textContent = label;
  statusBadge.textContent = '';
  const badge = document.createElement('span');
  badge.className = 'badge ' + (good ? 'badge-success' : 'badge-critical');
  badge.textContent = 'HTTP ' + status + (note || (good ? ' · as expected' : ' · unexpected'));
  statusBadge.appendChild(badge);
}
/*
 * A redemption the rules refuse — below the minimum, more points than the
 * customer has — answers 409 and is the backend working, not failing. Marking
 * it red "unexpected" would teach whoever runs the dev-store spikes to
 * distrust exactly the behaviour they are there to confirm.
 */
function redemptionVerdict(res, body) {
  if (res.ok) return { good: true };
  if (res.status === 409 && typeof body.status === 'string' && body.status.indexOf('rejected_') === 0) {
    return { good: true, note: ' · refused by the rules, as it should be' };
  }
  return { good: false };
}
async function token(kind) {
  const q = kind === 'customer' ? '?kind=customer&customerId=' + encodeURIComponent(gid()) : '?kind=' + kind;
  const r = await fetch('/dev/token' + q);
  return (await r.json()).token;
}
async function call(label, kind, path, init, expectOk) {
  try {
    const t = await token(kind);
    const res = await fetch(path, Object.assign({}, init, {
      headers: Object.assign({}, (init && init.headers) || {}, { authorization: 'Bearer ' + t }),
    }));
    const body = await res.json().catch(() => ({}));
    const v =
      typeof expectOk === 'function' ? expectOk(res, body) : { good: expectOk ? res.ok : !res.ok };
    show(label, res.status, body, v.good, v.note);
  } catch (err) {
    show(label, 'ERR', String(err), false);
  }
}
document.getElementById('balance').onclick = () =>
  call('Balance, shopper token', 'customer', '/api/balance', {}, true);
document.getElementById('referral').onclick = () =>
  call('Referral code, shopper token', 'customer', '/api/referral-code', {}, true);
document.getElementById('balance-staff').onclick = () =>
  call('Balance, staff token', 'staff', '/api/balance?customerId=' + encodeURIComponent(gid()), {}, true);
document.getElementById('redeem-web').onclick = () =>
  call('Redeem online, shopper token', 'customer', '/api/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ points: pts(), attemptId: crypto.randomUUID(), channel: 'web' }),
  }, redemptionVerdict);
document.getElementById('redeem-pos').onclick = () =>
  call('Redeem at POS, staff token', 'staff', '/api/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId: gid(), points: pts(), attemptId: crypto.randomUUID(), channel: 'pos' }),
  }, redemptionVerdict);
document.getElementById('forbidden').onclick = () =>
  call('Settings with a shopper token — must be refused', 'customer', '/api/settings', {}, false);
</script>
</body>
</html>`;
}
