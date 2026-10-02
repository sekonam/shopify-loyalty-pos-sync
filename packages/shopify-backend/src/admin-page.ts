/**
 * Embedded admin (v1 basics + v1.x/v2: channel rules, excluded sources, VIP
 * tiers, referral program, point awards). Served as one static page; App
 * Bridge provides the session token (`shopify.idToken()`), with the local
 * dev-harness fallback, and every data call goes through the same authed
 * /api routes the extensions use.
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
  body { font: 14px system-ui, sans-serif; margin: 24px; max-width: 860px; }
  fieldset { margin: 16px 0; border: 1px solid #ccc; }
  label { display: block; margin: 10px 0 4px; font-weight: 600; }
  label.inline { display: inline-flex; gap: 6px; align-items: center; font-weight: 400; margin-right: 16px; }
  input[type="text"], input:not([type]) { padding: 6px 8px; width: 12rem; }
  input.narrow { width: 6rem; }
  button { margin-top: 12px; padding: 7px 14px; }
  table { border-collapse: collapse; margin-top: 16px; width: 100%; }
  td, th { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; font-size: 13px; }
  .status { margin-left: 12px; }
  pre { background: #f4f4f4; padding: 10px; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>Loyalty POS Sync</h1>
<p>One points ledger across online checkout and POS. Balances are always derived
from the append-only ledger below — never a stored counter — and an hourly
reconciliation job checks the ledger against Shopify's own order history.</p>

<fieldset>
<legend><b>Core settings</b></legend>
<label for="earnRate">Points earned per 1.00 spent</label>
<input id="earnRate" inputmode="decimal" />
<label for="redemptionRate">Points per 1.00 of discount</label>
<input id="redemptionRate" inputmode="decimal" />
<label for="minRedemption">Minimum points per redemption</label>
<input id="minRedemption" inputmode="numeric" />
<br /><button id="saveCore">Save core settings</button><span class="status" id="coreStatus"></span>
</fieldset>

<fieldset>
<legend><b>Earning rules by channel</b></legend>
<div id="channels"></div>
<label for="excludedSources">Excluded sources (comma-separated raw source names, e.g. a marketplace handle — these never earn)</label>
<input id="excludedSources" style="width: 100%" />
</fieldset>

<fieldset>
<legend><b>VIP tiers</b> (by points earned in the trailing 365 days)</legend>
<table><thead><tr><th>Name</th><th>Min earned (365d)</th><th>Earn multiplier</th><th></th></tr></thead>
<tbody id="tiers"></tbody></table>
<button id="addTier" type="button">Add tier</button>
</fieldset>

<fieldset>
<legend><b>Referral program</b></legend>
<label class="inline"><input type="checkbox" id="refEnabled" /> Enabled</label>
<label for="refAdvocate">Advocate reward (points, on friend's first paid order)</label>
<input id="refAdvocate" class="narrow" inputmode="numeric" />
<label for="refFriend">Friend welcome bonus (points)</label>
<input id="refFriend" class="narrow" inputmode="numeric" />
</fieldset>

<button id="saveRules">Save program rules</button><span class="status" id="rulesStatus"></span>

<fieldset>
<legend><b>Award points</b> (giveaways, contests, goodwill — audited as ledger adjustments)</legend>
<label for="awardList">One per line: <code>customerNumber,points</code> (negative deducts, capped at zero)</label>
<textarea id="awardList" rows="4" style="width: 100%"></textarea>
<button id="applyAwards">Apply awards</button><span class="status" id="awardStatus"></span>
<pre id="awardResult" hidden></pre>
</fieldset>

<h2>Ledger</h2>
<button id="export">Download CSV</button>
<table id="entries"><thead><tr>
  <th>When</th><th>Customer</th><th>Δ</th><th>Reason</th><th>Channel</th><th>Order</th>
</tr></thead><tbody></tbody></table>

<script>
const CHANNELS = ['web', 'pos', 'mobile_app', 'other'];
const $ = (id) => document.getElementById(id);

async function getToken() {
  if (window.shopify && window.shopify.idToken) return window.shopify.idToken();
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
const putJson = (path, body) => authed(path, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// All dynamic values are assigned via DOM properties, NEVER interpolated
// into HTML — stored config (e.g. a tier name) must not be able to inject
// markup into a page that holds a live admin session.
function channelRow(channel, rule) {
  const frag = document.createDocumentFragment();
  const label = document.createElement('label');
  label.className = 'inline';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 'ch_' + channel;
  box.checked = !rule || rule.enabled !== false;
  label.append(box, ' ' + channel);
  const rate = document.createElement('input');
  rate.className = 'narrow';
  rate.id = 'chrate_' + channel;
  rate.placeholder = 'rate';
  rate.value = (rule && rule.earnRate) || '';
  frag.append(label, rate, ' ');
  return frag;
}

function tierRow(tier) {
  const tr = document.createElement('tr');
  const mk = (cls, extra, value) => {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.className = cls;
    Object.assign(input, extra);
    input.value = value;
    td.appendChild(input);
    tr.appendChild(td);
  };
  mk('tier-name', {}, tier ? tier.name : '');
  mk('tier-min narrow', { inputMode: 'numeric' }, tier ? String(tier.minEarned365) : '');
  mk('tier-mult narrow', { inputMode: 'decimal' }, tier ? tier.multiplier : '');
  const td = document.createElement('td');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.onclick = () => tr.remove();
  td.appendChild(remove);
  tr.appendChild(td);
  return tr;
}

async function load() {
  const s = await (await authed('/api/settings')).json();
  for (const k of ['earnRate', 'redemptionRate', 'minRedemption']) $(k).value = s[k];
  $('channels').textContent = '';
  for (const c of CHANNELS) $('channels').appendChild(channelRow(c, (s.channelRules || {})[c]));
  $('excludedSources').value = (s.excludedSources || []).join(', ');
  const tbody = $('tiers');
  tbody.innerHTML = '';
  for (const t of s.tiers || []) tbody.appendChild(tierRow(t));
  $('refEnabled').checked = !!(s.referral && s.referral.enabled);
  $('refAdvocate').value = s.referral ? s.referral.advocatePoints : 200;
  $('refFriend').value = s.referral ? s.referral.friendPoints : 100;
  await loadEntries();
}

async function loadEntries() {
  const { entries } = await (await authed('/api/entries')).json();
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

$('saveCore').onclick = async () => {
  const res = await putJson('/api/settings', {
    earnRate: $('earnRate').value,
    redemptionRate: $('redemptionRate').value,
    minRedemption: Number($('minRedemption').value),
  });
  $('coreStatus').textContent = res.ok ? 'Saved.' : 'Failed: ' + (await res.text());
  if (res.ok) loadEntries();
};

$('saveRules').onclick = async () => {
  const channelRules = {};
  for (const c of CHANNELS) {
    const rule = { enabled: $('ch_' + c).checked };
    const rate = $('chrate_' + c).value.trim();
    if (rate !== '') rule.earnRate = rate;
    channelRules[c] = rule;
  }
  const tiers = [];
  for (const tr of document.querySelectorAll('#tiers tr')) {
    const name = tr.querySelector('.tier-name').value.trim();
    const minRaw = tr.querySelector('.tier-min').value.trim();
    const multiplier = tr.querySelector('.tier-mult').value.trim();
    // Number('') is 0 — a blank minimum would silently grant the tier to
    // the whole shop, so every field must be explicit.
    if (name === '' || minRaw === '' || !/^\\d+$/.test(minRaw) || multiplier === '') {
      $('rulesStatus').textContent =
        'Not saved: every tier needs a name, a whole-number minimum, and a multiplier.';
      return;
    }
    tiers.push({ name, minEarned365: Number(minRaw), multiplier });
  }
  const excludedSources = $('excludedSources').value.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await putJson('/api/settings', {
    channelRules,
    excludedSources,
    tiers,
    referral: {
      enabled: $('refEnabled').checked,
      advocatePoints: Number($('refAdvocate').value),
      friendPoints: Number($('refFriend').value),
    },
  });
  $('rulesStatus').textContent = res.ok ? 'Saved.' : 'Failed: ' + (await res.text());
};

$('addTier').onclick = () => $('tiers').appendChild(tierRow(null));

// The batch id is minted once per textarea content and reused on retries, so
// a timed-out request clicked again cannot double-award (the server replays
// the stored result for a known batch id). Editing the list starts a new batch.
let awardBatchId = null;
$('awardList').addEventListener('input', () => {
  awardBatchId = null;
});
$('applyAwards').onclick = async () => {
  const awards = $('awardList').value.split('\\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const [customer, points] = line.split(',');
      return {
        customerId: 'gid://shopify/Customer/' + customer.trim(),
        points: Number(points),
      };
    });
  if (awards.length === 0) {
    $('awardStatus').textContent = 'Nothing to apply.';
    return;
  }
  awardBatchId = awardBatchId || crypto.randomUUID();
  const res = await authed('/api/awards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchId: awardBatchId, awards }),
  });
  const body = await res.json();
  $('awardStatus').textContent = res.ok
    ? body.replayed
      ? 'Already applied (replay).'
      : 'Applied.'
    : 'Failed.';
  $('awardResult').hidden = false;
  $('awardResult').textContent = JSON.stringify(body, null, 2);
  if (res.ok) loadEntries();
};

$('export').addEventListener('click', async () => {
  const res = await authed('/api/ledger.csv');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'points-ledger.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

load().catch((err) => {
  $('coreStatus').textContent = 'Failed to load: ' + err;
});
</script>
</body>
</html>`;
}
