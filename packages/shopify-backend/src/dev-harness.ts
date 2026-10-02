import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { Hono } from 'hono';
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
}

export function createDevApp(config: DevHarnessConfig): Hono {
  const app = new Hono();

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

/** A stand-in for the checkout/POS widgets: same API calls, plain browser page. */
function consolePage(shop: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Loyalty dev console</title>
${faviconLink()}
<style>${designSystemCss()}
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
function show(label, status, body, good) {
  out.textContent = JSON.stringify(body, null, 2);
  verdict.textContent = label;
  statusBadge.textContent = '';
  const badge = document.createElement('span');
  badge.className = 'badge ' + (good ? 'badge-success' : 'badge-critical');
  badge.textContent = 'HTTP ' + status + (good ? ' · as expected' : ' · unexpected');
  statusBadge.appendChild(badge);
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
    show(label, res.status, body, expectOk ? res.ok : !res.ok);
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
  }, true);
document.getElementById('redeem-pos').onclick = () =>
  call('Redeem at POS, staff token', 'staff', '/api/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId: gid(), points: pts(), attemptId: crypto.randomUUID(), channel: 'pos' }),
  }, true);
document.getElementById('forbidden').onclick = () =>
  call('Settings with a shopper token — must be refused', 'customer', '/api/settings', {}, false);
</script>
</body>
</html>`;
}
