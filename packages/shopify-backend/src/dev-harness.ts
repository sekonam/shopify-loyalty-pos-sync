import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { Hono } from 'hono';

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

  app.get('/', (c) => c.html(consolePage(config.defaultShop)));
  return app;
}

/** A stand-in for the checkout/POS widgets: same API calls, plain browser page. */
function consolePage(shop: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Loyalty dev console</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; max-width: 760px; }
  fieldset { margin-bottom: 16px; }
  label { margin-right: 8px; }
  input { padding: 4px 6px; }
  button { padding: 6px 12px; margin-right: 8px; }
  pre { background: #f4f4f4; padding: 12px; min-height: 80px; white-space: pre-wrap; }
  .ok { color: #0a7a2f; } .err { color: #b00020; }
</style>
</head>
<body>
<h1>Loyalty dev console</h1>
<p>Shop: <code>${shop}</code> · exercises the same <code>/api</code> endpoints the POS and
checkout extensions call. <a href="/admin">Open the merchant admin →</a></p>

<fieldset>
  <legend>Customer</legend>
  <label for="customer">Customer number</label>
  <input id="customer" value="9001" inputmode="numeric" />
</fieldset>

<fieldset>
  <legend>Act as the customer (checkout widget)</legend>
  <button id="balance">Get balance</button>
  <label for="points">Points</label>
  <input id="points" value="100" inputmode="numeric" />
  <button id="redeem-web">Redeem as customer (web)</button>
</fieldset>

<fieldset>
  <legend>Act as staff (POS register)</legend>
  <button id="balance-staff">Balance via staff token</button>
  <button id="redeem-pos">Redeem as staff (pos)</button>
  <button id="forbidden">Try settings with CUSTOMER token (must fail 403)</button>
</fieldset>

<pre id="out">Ready.</pre>

<script>
const out = document.getElementById('out');
const gid = () => 'gid://shopify/Customer/' + document.getElementById('customer').value.trim();
const pts = () => Number(document.getElementById('points').value);
function show(label, status, body, good) {
  out.textContent = label + ' -> HTTP ' + status + '\\n' + JSON.stringify(body, null, 2);
  out.className = good ? 'ok' : 'err';
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
  call('balance (customer token)', 'customer', '/api/balance', {}, true);
document.getElementById('balance-staff').onclick = () =>
  call('balance (staff token)', 'staff', '/api/balance?customerId=' + encodeURIComponent(gid()), {}, true);
document.getElementById('redeem-web').onclick = () =>
  call('redeem web', 'customer', '/api/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ points: pts(), attemptId: crypto.randomUUID(), channel: 'web' }),
  }, true);
document.getElementById('redeem-pos').onclick = () =>
  call('redeem pos', 'staff', '/api/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId: gid(), points: pts(), attemptId: crypto.randomUUID(), channel: 'pos' }),
  }, true);
document.getElementById('forbidden').onclick = () =>
  call('settings with customer token (expect 403)', 'customer', '/api/settings', {}, false);
</script>
</body>
</html>`;
}
