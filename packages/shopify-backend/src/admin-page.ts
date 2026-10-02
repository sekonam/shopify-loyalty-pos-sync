import { designSystemCss, logoMarkSvg } from './ui/theme.js';

/**
 * The embedded merchant admin: an overview dashboard (including the
 * reconciliation status that makes the app's self-checking visible — the
 * product's core trust claim), program configuration, and the ledger.
 *
 * Served as one static page. App Bridge supplies the session token, with a
 * local dev-harness fallback; every data call goes through the same authed
 * /api routes the extensions use. All dynamic values are written through DOM
 * properties — never interpolated into HTML — so stored configuration can
 * never inject markup into a page holding a live admin session.
 */
export function adminPageHtml(apiKey: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="shopify-api-key" content="${apiKey}" />
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>Loyalty POS Sync</title>
<style>${designSystemCss()}</style>
</head>
<body>
<div class="page">
  <header class="page-header">
    <span class="mark">${logoMarkSvg}</span>
    <div>
      <h1 class="page-title">Loyalty POS Sync</h1>
      <p class="page-subtitle">One points balance across online checkout and your POS register, derived from an append-only ledger and checked against Shopify's own order history.</p>
    </div>
    <div class="page-header-actions">
      <button class="btn btn-sm" id="refresh" type="button">Refresh</button>
    </div>
  </header>

  <div id="load-error" hidden></div>

  <div class="tabs" role="tablist" aria-label="Sections">
    <button class="tab" role="tab" id="tab-overview" aria-controls="panel-overview" aria-selected="true">Overview</button>
    <button class="tab" role="tab" id="tab-program" aria-controls="panel-program" aria-selected="false">Program</button>
    <button class="tab" role="tab" id="tab-ledger" aria-controls="panel-ledger" aria-selected="false">Ledger</button>
  </div>

  <!-- ============ OVERVIEW ============ -->
  <section id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" class="stack">
    <div class="grid grid-stats" id="stats"></div>
    <div id="recon"></div>
    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Program at a glance</h2>
        <p class="card-description">What's switched on right now. Change any of it under Program.</p>
      </div></div>
      <div class="card-body"><div class="row" id="program-summary"></div></div>
    </div>
    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Recent activity</h2>
        <p class="card-description">The newest entries in the points ledger.</p>
      </div><div class="row-end"><button class="btn btn-plain btn-sm" type="button" data-goto="ledger">View all</button></div></div>
      <div class="table-wrap"><table class="data" id="recent"><tbody></tbody></table></div>
    </div>
  </section>

  <!-- ============ PROGRAM ============ -->
  <section id="panel-program" role="tabpanel" aria-labelledby="tab-program" class="stack" hidden>
    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Earning and redemption</h2>
        <p class="card-description">The base rates for the whole shop. Channel rules and VIP tiers below adjust them.</p>
      </div></div>
      <div class="card-body">
        <div class="grid grid-2">
          <div class="field">
            <label class="field-label" for="earnRate">Points earned per 1.00 spent</label>
            <input class="input input-sm" id="earnRate" inputmode="decimal" aria-describedby="earnRate-help" />
            <span class="field-help" id="earnRate-help">A 50.00 order earns <span id="earn-example">50</span> points.</span>
          </div>
          <div class="field">
            <label class="field-label" for="redemptionRate">Points per 1.00 of discount</label>
            <input class="input input-sm" id="redemptionRate" inputmode="decimal" aria-describedby="redemptionRate-help" />
            <span class="field-help" id="redemptionRate-help">500 points is worth <span id="redeem-example">5.00</span> off.</span>
          </div>
          <div class="field">
            <label class="field-label" for="minRedemption">Minimum points per redemption</label>
            <input class="input input-sm" id="minRedemption" inputmode="numeric" />
            <span class="field-help">Stops one-point redemptions at the register.</span>
          </div>
        </div>
      </div>
      <div class="card-footer">
        <button class="btn btn-primary" id="saveCore" type="button">Save</button>
        <span class="field-error" id="coreError" role="alert"></span>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Earning rules by channel</h2>
        <p class="card-description">Turn earning off for a channel, or give it its own rate. Leave a rate blank to use the base rate.</p>
      </div></div>
      <div class="card-body stack">
        <div id="channels" class="stack"></div>
        <div class="field">
          <label class="field-label" for="excludedSources">Excluded order sources</label>
          <input class="input" id="excludedSources" placeholder="amazon-marketplace, faire" />
          <span class="field-help">Comma-separated. Orders from these sources never earn points — useful for marketplace channels you don't want to reward.</span>
        </div>
      </div>
      <div class="card-footer">
        <button class="btn btn-primary" id="saveRules" type="button">Save</button>
        <span class="field-error" id="rulesError" role="alert"></span>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">VIP tiers</h2>
        <p class="card-description">Members qualify on points earned in the last 365 days, so spending points never demotes anyone. The highest tier they qualify for multiplies their earn rate.</p>
      </div></div>
      <div class="card-body">
        <div class="table-wrap"><table class="data" id="tiers">
          <thead><tr><th>Tier name</th><th>Points earned (365 days)</th><th>Earn multiplier</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody></tbody>
        </table></div>
        <div id="tiers-empty" class="empty" hidden>
          <div class="empty-title">No tiers yet</div>
          <div>Everyone earns at the base rate. Add a tier to reward your best customers.</div>
        </div>
      </div>
      <div class="card-footer">
        <button class="btn btn-primary" id="saveTiers" type="button">Save</button>
        <button class="btn" id="addTier" type="button">Add tier</button>
        <span class="field-error" id="tiersError" role="alert"></span>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Referrals</h2>
        <p class="card-description">Each customer gets a share code. When someone they refer places their first paid order, both sides are rewarded — once per referred customer, and reversed if that order is refunded.</p>
      </div></div>
      <div class="card-body stack">
        <label class="checkbox"><input type="checkbox" id="refEnabled" /> <span>Run a referral program</span></label>
        <div class="grid grid-2">
          <div class="field">
            <label class="field-label" for="refAdvocate">Reward for the referrer</label>
            <input class="input input-sm" id="refAdvocate" inputmode="numeric" />
            <span class="field-help">Points, paid on the friend's first paid order.</span>
          </div>
          <div class="field">
            <label class="field-label" for="refFriend">Welcome bonus for the friend</label>
            <input class="input input-sm" id="refFriend" inputmode="numeric" />
            <span class="field-help">Points, on that same order.</span>
          </div>
        </div>
      </div>
      <div class="card-footer">
        <button class="btn btn-primary" id="saveReferral" type="button">Save</button>
        <span class="field-error" id="referralError" role="alert"></span>
      </div>
    </div>
  </section>

  <!-- ============ LEDGER ============ -->
  <section id="panel-ledger" role="tabpanel" aria-labelledby="tab-ledger" class="stack" hidden>
    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Award points</h2>
        <p class="card-description">Giveaways, contests, or putting things right. Every award lands in the ledger with a full audit trail.</p>
      </div></div>
      <div class="card-body stack">
        <div class="field">
          <label class="field-label" for="awardList">One customer per line</label>
          <textarea class="input" id="awardList" placeholder="6123456789,250&#10;6987654321,-100"></textarea>
          <span class="field-help">Format: <code>customer ID,points</code>. Negative values deduct, and never take a balance below zero.</span>
        </div>
        <div id="awardResult" hidden></div>
      </div>
      <div class="card-footer">
        <button class="btn btn-primary" id="applyAwards" type="button">Apply awards</button>
        <span class="field-help" id="awardStatus" role="status"></span>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Points ledger</h2>
        <p class="card-description" id="ledger-count"></p>
      </div><div class="row-end"><button class="btn btn-sm" id="export" type="button">Download CSV</button></div></div>
      <div class="card-body">
        <div class="row">
          <div class="field"><label class="visually-hidden" for="filter-customer">Search customer</label>
            <input class="input input-md" id="filter-customer" type="search" placeholder="Search customer ID" /></div>
          <div class="field"><label class="visually-hidden" for="filter-reason">Filter by reason</label>
            <select class="input input-md" id="filter-reason">
              <option value="">All reasons</option>
              <option value="earn">Earned</option>
              <option value="redeem">Redeemed</option>
              <option value="refund_reversal">Refund reversal</option>
              <option value="referral_reward">Referral reward</option>
              <option value="adjustment">Adjustment</option>
              <option value="reconciliation">Reconciliation</option>
            </select></div>
          <div class="field"><label class="visually-hidden" for="filter-channel">Filter by channel</label>
            <select class="input input-md" id="filter-channel">
              <option value="">All channels</option>
              <option value="pos">POS</option>
              <option value="web">Online</option>
              <option value="mobile_app">Mobile app</option>
              <option value="other">Other</option>
              <option value="system">App</option>
            </select></div>
        </div>
      </div>
      <div class="table-wrap"><table class="data" id="entries">
        <thead><tr><th>When</th><th>Customer</th><th class="num">Change</th><th>Reason</th><th>Channel</th><th>Order</th></tr></thead>
        <tbody></tbody>
      </table></div>
      <div id="entries-empty" class="empty" hidden>
        <div class="empty-title">Nothing to show</div>
        <div>No ledger entries match these filters.</div>
      </div>
      <div class="card-footer"><button class="btn" id="loadMore" type="button" hidden>Show more</button><span class="field-help" id="shown-count"></span></div>
    </div>
  </section>
</div>

<div id="toast-region" aria-live="polite" aria-atomic="true"></div>

<script>
const CHANNELS = [
  { key: 'web', label: 'Online store' },
  { key: 'pos', label: 'Point of sale' },
  { key: 'mobile_app', label: 'Mobile app' },
  { key: 'other', label: 'Other channels' },
];
const CHANNEL_LABEL = { web: 'Online', pos: 'POS', mobile_app: 'Mobile', other: 'Other', system: 'App' };
const CHANNEL_TONE = { pos: 'badge-info', system: 'badge-warning' };
const REASON_LABEL = {
  earn: 'Earned', redeem: 'Redeemed', refund_reversal: 'Refund reversal',
  referral_reward: 'Referral', adjustment: 'Adjustment', reconciliation: 'Reconciliation',
};
const REASON_TONE = {
  earn: 'badge-success', referral_reward: 'badge-success',
  refund_reversal: 'badge-warning', reconciliation: 'badge-info',
};
const PAGE_SIZE = 25;

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();
let state = { entries: [], shown: PAGE_SIZE, shopDomain: null, currency: null, settings: null };

/* ---------- plumbing ---------- */
async function getToken() {
  if (window.shopify && window.shopify.idToken) return window.shopify.idToken();
  const r = await fetch('/dev/token?kind=staff');
  if (!r.ok) throw new Error('This page must run inside the Shopify admin.');
  return (await r.json()).token;
}
async function authed(path, init) {
  const token = await getToken();
  return fetch(path, Object.assign({}, init, {
    headers: Object.assign({}, (init && init.headers) || {}, { authorization: 'Bearer ' + token }),
  }));
}
async function putSettings(patch) {
  const res = await authed('/api/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}
function toast(message, tone) {
  const el = document.createElement('div');
  el.className = 'toast' + (tone === 'critical' ? ' toast-critical' : '');
  el.textContent = message;
  $('toast-region').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
function busy(button, on, label) {
  button.disabled = on;
  button.textContent = '';
  if (on) {
    const s = document.createElement('span');
    s.className = 'spinner';
    button.append(s, label || 'Saving…');
  } else {
    button.textContent = label;
  }
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function badge(text, tone) { return el('span', 'badge ' + (tone || ''), text); }

/* ---------- tabs ---------- */
const TABS = ['overview', 'program', 'ledger'];
function showTab(name) {
  for (const t of TABS) {
    const selected = t === name;
    $('tab-' + t).setAttribute('aria-selected', String(selected));
    $('panel-' + t).hidden = !selected;
  }
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
}
for (const t of TABS) $('tab-' + t).onclick = () => showTab(t);
document.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => showTab(b.dataset.goto); });

/* ---------- overview ---------- */
function statTile(label, value, caption) {
  const card = el('div', 'card');
  const body = el('div', 'stat');
  body.append(el('div', 'stat-label', label), el('div', 'stat-value', value));
  if (caption) body.appendChild(el('div', 'stat-caption', caption));
  card.appendChild(body);
  return card;
}
function relativeTime(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hours / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}
function renderOverview(o) {
  state.shopDomain = o.shopDomain;
  state.currency = o.currency;
  const money = o.currency ? o.outstandingValue + ' ' + o.currency : o.outstandingValue;
  const stats = $('stats');
  stats.textContent = '';
  stats.append(
    statTile('Members with points', nf.format(o.stats.members), nf.format(o.stats.entryCount) + ' ledger entries'),
    statTile('Points outstanding', nf.format(o.stats.outstandingPoints), 'Worth ' + money),
    statTile('Points issued', nf.format(o.stats.issuedInWindow), 'Last ' + o.windowDays + ' days'),
    statTile('Points redeemed', nf.format(o.stats.redeemedInWindow), 'Last ' + o.windowDays + ' days'),
  );

  const recon = $('recon');
  recon.textContent = '';
  const r = o.reconciliation;
  const banner = el('div', 'banner');
  const content = el('div');
  if (!r) {
    banner.className = 'banner';
    content.append(
      el('div', 'banner-title', 'Self-check has not run yet'),
      el('p', null, 'Once the app is installed on a store, it re-checks the ledger against Shopify\\u2019s order history every hour and repairs anything a dropped webhook missed.'),
    );
  } else if (r.error) {
    banner.className = 'banner banner-critical';
    content.append(
      el('div', 'banner-title', 'Last self-check failed'),
      el('p', null, r.error),
      el('p', null, 'The same window will be retried on the next run, so nothing is skipped.'),
    );
  } else {
    banner.className = 'banner banner-success';
    const detail = r.entriesAdded === 0
      ? 'Checked ' + nf.format(r.ordersSeen) + ' orders against the ledger and found no drift.'
      : 'Checked ' + nf.format(r.ordersSeen) + ' orders and repaired ' + nf.format(r.entriesAdded) + ' missing ' + (r.entriesAdded === 1 ? 'entry' : 'entries') + '.';
    content.append(
      el('div', 'banner-title', 'Ledger verified ' + relativeTime(r.finishedAt)),
      el('p', null, detail),
    );
  }
  banner.appendChild(content);
  recon.appendChild(banner);

  const summary = $('program-summary');
  summary.textContent = '';
  summary.append(
    badge(o.program.tiers > 0 ? o.program.tiers + ' VIP ' + (o.program.tiers === 1 ? 'tier' : 'tiers') : 'No VIP tiers', o.program.tiers > 0 ? 'badge-success' : ''),
    badge(o.program.referralEnabled ? 'Referrals on' : 'Referrals off', o.program.referralEnabled ? 'badge-success' : ''),
    badge(o.program.excludedSources + ' excluded ' + (o.program.excludedSources === 1 ? 'source' : 'sources'), o.program.excludedSources > 0 ? 'badge-warning' : ''),
    badge(o.program.disabledChannels.length ? 'Earning off: ' + o.program.disabledChannels.map((c) => CHANNEL_LABEL[c] || c).join(', ') : 'Earning on everywhere', o.program.disabledChannels.length ? 'badge-warning' : ''),
  );
}

/* ---------- program ---------- */
function channelRow(channel, rule) {
  const row = el('div', 'row');
  const label = el('label', 'checkbox');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 'ch_' + channel.key;
  box.checked = !rule || rule.enabled !== false;
  label.append(box, el('span', null, channel.label));
  const rate = document.createElement('input');
  rate.className = 'input input-sm';
  rate.id = 'chrate_' + channel.key;
  rate.placeholder = 'base rate';
  rate.value = (rule && rule.earnRate) || '';
  rate.setAttribute('aria-label', channel.label + ' earn rate');
  row.append(label, el('span', 'row-end'), rate);
  return row;
}
function tierRow(tier) {
  const tr = el('tr');
  const add = (cls, attrs, value, aria) => {
    const td = el('td');
    const input = document.createElement('input');
    input.className = 'input ' + cls;
    Object.assign(input, attrs);
    input.value = value;
    input.setAttribute('aria-label', aria);
    td.appendChild(input);
    tr.appendChild(td);
    return input;
  };
  add('tier-name input-md', {}, tier ? tier.name : '', 'Tier name');
  add('tier-min input-sm', { inputMode: 'numeric' }, tier ? String(tier.minEarned365) : '', 'Minimum points earned in 365 days');
  add('tier-mult input-sm', { inputMode: 'decimal' }, tier ? tier.multiplier : '', 'Earn multiplier');
  const actions = el('td');
  const remove = el('button', 'btn btn-sm btn-critical', 'Remove');
  remove.type = 'button';
  remove.onclick = () => { tr.remove(); syncTiersEmpty(); };
  actions.appendChild(remove);
  tr.appendChild(actions);
  return tr;
}
function syncTiersEmpty() {
  const rows = document.querySelectorAll('#tiers tbody tr').length;
  $('tiers-empty').hidden = rows > 0;
  document.querySelector('#tiers thead').hidden = rows === 0;
}
function renderSettings(s) {
  state.settings = s;
  $('earnRate').value = s.earnRate;
  $('redemptionRate').value = s.redemptionRate;
  $('minRedemption').value = s.minRedemption;
  updateExamples();
  const channels = $('channels');
  channels.textContent = '';
  for (const c of CHANNELS) channels.appendChild(channelRow(c, (s.channelRules || {})[c.key]));
  $('excludedSources').value = (s.excludedSources || []).join(', ');
  const tbody = document.querySelector('#tiers tbody');
  tbody.textContent = '';
  for (const t of s.tiers || []) tbody.appendChild(tierRow(t));
  syncTiersEmpty();
  $('refEnabled').checked = !!(s.referral && s.referral.enabled);
  $('refAdvocate').value = s.referral ? s.referral.advocatePoints : 200;
  $('refFriend').value = s.referral ? s.referral.friendPoints : 100;
}
function updateExamples() {
  const earn = Number($('earnRate').value);
  const redeem = Number($('redemptionRate').value);
  $('earn-example').textContent = Number.isFinite(earn) && earn > 0 ? nf.format(Math.floor(50 * earn)) : '—';
  $('redeem-example').textContent = Number.isFinite(redeem) && redeem > 0 ? (500 / redeem).toFixed(2) : '—';
}
$('earnRate').addEventListener('input', updateExamples);
$('redemptionRate').addEventListener('input', updateExamples);

$('saveCore').onclick = async () => {
  $('coreError').textContent = '';
  busy($('saveCore'), true);
  const { ok, body } = await putSettings({
    earnRate: $('earnRate').value.trim(),
    redemptionRate: $('redemptionRate').value.trim(),
    minRedemption: Number($('minRedemption').value),
  });
  busy($('saveCore'), false, 'Save');
  if (!ok) { $('coreError').textContent = body.error || 'Could not save.'; return; }
  renderSettings(body); toast('Earning and redemption saved'); refreshOverview();
};

$('saveRules').onclick = async () => {
  $('rulesError').textContent = '';
  const channelRules = {};
  for (const c of CHANNELS) {
    const rule = { enabled: $('ch_' + c.key).checked };
    const rate = $('chrate_' + c.key).value.trim();
    if (rate !== '') rule.earnRate = rate;
    channelRules[c.key] = rule;
  }
  const excludedSources = $('excludedSources').value.split(',').map((s) => s.trim()).filter(Boolean);
  busy($('saveRules'), true);
  const { ok, body } = await putSettings({ channelRules, excludedSources });
  busy($('saveRules'), false, 'Save');
  if (!ok) { $('rulesError').textContent = body.error || 'Could not save.'; return; }
  renderSettings(body); toast('Earning rules saved'); refreshOverview();
};

$('saveTiers').onclick = async () => {
  $('tiersError').textContent = '';
  const tiers = [];
  for (const tr of document.querySelectorAll('#tiers tbody tr')) {
    const name = tr.querySelector('.tier-name').value.trim();
    const min = tr.querySelector('.tier-min').value.trim();
    const multiplier = tr.querySelector('.tier-mult').value.trim();
    // Number('') is 0 — a blank minimum would silently grant the tier to
    // every customer in the shop, so each field has to be explicit.
    if (name === '' || min === '' || !/^\\d+$/.test(min) || multiplier === '') {
      $('tiersError').textContent = 'Every tier needs a name, a whole-number minimum, and a multiplier.';
      return;
    }
    tiers.push({ name, minEarned365: Number(min), multiplier });
  }
  busy($('saveTiers'), true);
  const { ok, body } = await putSettings({ tiers });
  busy($('saveTiers'), false, 'Save');
  if (!ok) { $('tiersError').textContent = body.error || 'Could not save.'; return; }
  renderSettings(body); toast(tiers.length ? 'VIP tiers saved' : 'VIP tiers removed'); refreshOverview();
};
$('addTier').onclick = () => {
  document.querySelector('#tiers tbody').appendChild(tierRow(null));
  syncTiersEmpty();
};

$('saveReferral').onclick = async () => {
  $('referralError').textContent = '';
  busy($('saveReferral'), true);
  const { ok, body } = await putSettings({
    referral: {
      enabled: $('refEnabled').checked,
      advocatePoints: Number($('refAdvocate').value),
      friendPoints: Number($('refFriend').value),
    },
  });
  busy($('saveReferral'), false, 'Save');
  if (!ok) { $('referralError').textContent = body.error || 'Could not save.'; return; }
  renderSettings(body); toast('Referral settings saved'); refreshOverview();
};

/* ---------- awards ---------- */
// The batch id is minted once per list and reused on retries, so a request
// that times out client-side cannot double-award when clicked again.
let awardBatchId = null;
$('awardList').addEventListener('input', () => { awardBatchId = null; });
$('applyAwards').onclick = async () => {
  const awards = $('awardList').value.split('\\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [customer, points] = line.split(',');
    return { customerId: 'gid://shopify/Customer/' + (customer || '').trim(), points: Number(points) };
  });
  const status = $('awardStatus');
  if (awards.length === 0) { status.textContent = 'Add at least one line first.'; return; }
  awardBatchId = awardBatchId || crypto.randomUUID();
  busy($('applyAwards'), true, 'Applying…');
  const res = await authed('/api/awards', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchId: awardBatchId, awards }),
  });
  const body = await res.json().catch(() => ({}));
  busy($('applyAwards'), false, 'Apply awards');
  const panel = $('awardResult');
  panel.textContent = '';
  panel.hidden = false;
  if (!res.ok) {
    status.textContent = '';
    const b = el('div', 'banner banner-critical');
    b.appendChild(el('div', 'banner-title', body.error || 'Could not apply these awards.'));
    panel.appendChild(b);
    return;
  }
  status.textContent = body.replayed ? 'Already applied — nothing changed.' : '';
  const b = el('div', 'banner banner-success');
  const inner = el('div');
  inner.appendChild(el('div', 'banner-title', body.replayed ? 'This batch was already applied' : 'Awards applied'));
  const list = el('p', null, body.results.map((r) =>
    r.customerId.replace('gid://shopify/Customer/', '') + ' ' + (r.applied > 0 ? '+' : '') + nf.format(r.applied)
  ).join(' · '));
  inner.appendChild(list);
  b.appendChild(inner);
  panel.appendChild(b);
  if (!body.replayed) toast('Awards applied');
  loadEntries(); refreshOverview();
};

/* ---------- ledger ---------- */
function customerCell(customerId) {
  const num = customerId.replace('gid://shopify/Customer/', '');
  if (!state.shopDomain || !/^\\d+$/.test(num)) return el('span', 'mono', num);
  const a = el('a', 'mono', num);
  a.href = 'https://' + state.shopDomain + '/admin/customers/' + num;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}
function filtered() {
  const q = $('filter-customer').value.trim();
  const reason = $('filter-reason').value;
  const channel = $('filter-channel').value;
  return state.entries.filter((e) =>
    (!q || e.customerId.includes(q)) &&
    (!reason || e.reason === reason) &&
    (!channel || e.sourceName === channel)
  );
}
function entryRow(e) {
  const tr = el('tr');
  const when = el('td');
  when.appendChild(el('span', null, new Date(e.createdAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })));
  tr.appendChild(when);
  const cust = el('td');
  cust.appendChild(customerCell(e.customerId));
  tr.appendChild(cust);
  const delta = el('td', 'num ' + (e.delta > 0 ? 'delta-pos' : 'delta-neg'), (e.delta > 0 ? '+' : '') + nf.format(e.delta));
  tr.appendChild(delta);
  const reason = el('td');
  reason.appendChild(badge(REASON_LABEL[e.reason] || e.reason, REASON_TONE[e.reason]));
  tr.appendChild(reason);
  const channel = el('td');
  channel.appendChild(badge(CHANNEL_LABEL[e.sourceName] || e.sourceName, CHANNEL_TONE[e.sourceName]));
  tr.appendChild(channel);
  const order = el('td');
  order.appendChild(el('span', 'mono', (e.orderId || '').replace('gid://shopify/Order/', '') || '—'));
  tr.appendChild(order);
  return tr;
}
function renderEntries() {
  const rows = filtered();
  const tbody = document.querySelector('#entries tbody');
  tbody.textContent = '';
  for (const e of rows.slice(0, state.shown)) tbody.appendChild(entryRow(e));
  $('entries-empty').hidden = rows.length > 0;
  $('loadMore').hidden = rows.length <= state.shown;
  $('shown-count').textContent = rows.length
    ? 'Showing ' + Math.min(state.shown, rows.length) + ' of ' + nf.format(rows.length)
    : '';
  $('ledger-count').textContent = nf.format(state.entries.length) + ' entries, newest first.';

  const recent = document.querySelector('#recent tbody');
  recent.textContent = '';
  for (const e of state.entries.slice(0, 6)) recent.appendChild(entryRow(e));
}
for (const id of ['filter-customer', 'filter-reason', 'filter-channel']) {
  $(id).addEventListener('input', () => { state.shown = PAGE_SIZE; renderEntries(); });
}
$('loadMore').onclick = () => { state.shown += PAGE_SIZE; renderEntries(); };

$('export').onclick = async () => {
  const res = await authed('/api/ledger.csv');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'points-ledger.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSV downloaded');
};

/* ---------- load ---------- */
async function loadEntries() {
  const { entries } = await (await authed('/api/entries')).json();
  state.entries = entries.slice().reverse();
  renderEntries();
}
async function refreshOverview() {
  renderOverview(await (await authed('/api/overview')).json());
}
async function load() {
  $('load-error').hidden = true;
  try {
    const [settings] = await Promise.all([
      (await authed('/api/settings')).json(),
      refreshOverview(),
      loadEntries(),
    ]);
    renderSettings(settings);
  } catch (err) {
    const panel = $('load-error');
    panel.hidden = false;
    panel.textContent = '';
    const b = el('div', 'banner banner-critical');
    const inner = el('div');
    inner.append(el('div', 'banner-title', 'Could not load your loyalty data'), el('p', null, String(err && err.message ? err.message : err)));
    b.appendChild(inner);
    panel.appendChild(b);
  }
}
$('refresh').onclick = async () => {
  busy($('refresh'), true, 'Refreshing…');
  await load();
  busy($('refresh'), false, 'Refresh');
};

showTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview');
load();
</script>
</body>
</html>`;
}
