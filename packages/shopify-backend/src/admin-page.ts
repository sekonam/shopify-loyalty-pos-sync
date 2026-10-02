/**
 * Minimal embedded admin (v1 scope: earn/redemption rates, minimum, CSV
 * export, recent ledger entries). Served as one static page; App Bridge
 * provides the session token (`shopify.idToken()`), and every data call goes
 * through the same authed /api routes the extensions use.
 */
export function adminPageHtml(apiKey: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="shopify-api-key" content="${apiKey}" />
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>Loyalty POS Sync</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; max-width: 720px; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  input { padding: 6px 8px; width: 12rem; }
  button { margin-top: 16px; padding: 8px 14px; }
  table { border-collapse: collapse; margin-top: 24px; width: 100%; }
  td, th { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; font-size: 13px; }
  #status { margin-left: 12px; }
</style>
</head>
<body>
<h1>Loyalty POS Sync</h1>
<p>One points ledger across online checkout and POS. Balances are always derived
from the append-only ledger below — never a stored counter — and an hourly
reconciliation job checks the ledger against Shopify's own order history.</p>

<h2>Settings</h2>
<form id="settings">
  <label for="earnRate">Points earned per 1.00 spent</label>
  <input id="earnRate" name="earnRate" inputmode="decimal" />
  <label for="redemptionRate">Points per 1.00 of discount</label>
  <input id="redemptionRate" name="redemptionRate" inputmode="decimal" />
  <label for="minRedemption">Minimum points per redemption</label>
  <input id="minRedemption" name="minRedemption" inputmode="numeric" />
  <button type="submit">Save</button><span id="status"></span>
</form>

<h2>Ledger</h2>
<button id="export">Download CSV</button>
<table id="entries"><thead><tr>
  <th>When</th><th>Customer</th><th>Δ</th><th>Reason</th><th>Channel</th><th>Order</th>
</tr></thead><tbody></tbody></table>

<script>
async function getToken() {
  if (window.shopify && window.shopify.idToken) return window.shopify.idToken();
  // Local dev harness fallback (the /dev routes exist only with DEV_HARNESS=1;
  // in production this path 404s and the page correctly refuses to load data).
  const r = await fetch('/dev/token?kind=staff');
  if (!r.ok) throw new Error('no App Bridge and no dev harness');
  return (await r.json()).token;
}
async function authed(path, init) {
  const token = await getToken();
  return fetch(path, Object.assign({}, init, {
    headers: Object.assign({}, (init && init.headers) || {}, { authorization: 'Bearer ' + token }),
  }));
}
async function load() {
  const res = await authed('/api/settings');
  const s = await res.json();
  for (const k of ['earnRate', 'redemptionRate', 'minRedemption']) {
    document.getElementById(k).value = s[k];
  }
  const entriesRes = await authed('/api/entries');
  const { entries } = await entriesRes.json();
  const tbody = document.querySelector('#entries tbody');
  tbody.innerHTML = '';
  for (const e of entries.slice(-100).reverse()) {
    const tr = document.createElement('tr');
    for (const v of [
      new Date(e.createdAt).toLocaleString(),
      e.customerId.replace('gid://shopify/Customer/', ''),
      e.delta,
      e.reason,
      e.sourceName,
      (e.orderId || '').replace('gid://shopify/Order/', ''),
    ]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}
document.getElementById('settings').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = {
    earnRate: document.getElementById('earnRate').value,
    redemptionRate: document.getElementById('redemptionRate').value,
    minRedemption: Number(document.getElementById('minRedemption').value),
  };
  const res = await authed('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  document.getElementById('status').textContent = res.ok ? 'Saved.' : 'Save failed: ' + (await res.text());
  if (res.ok) load();
});
document.getElementById('export').addEventListener('click', async () => {
  const res = await authed('/api/ledger.csv');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'points-ledger.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});
load().catch((err) => {
  document.getElementById('status').textContent = 'Failed to load: ' + err;
});
</script>
</body>
</html>`;
}
