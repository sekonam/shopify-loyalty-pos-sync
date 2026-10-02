import { designSystemCss, faviconLink, logoMarkSvg } from './ui/theme.js';

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
${faviconLink()}
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
    <div id="getting-started"></div>
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
      <div id="recent-empty" class="empty" hidden>
        <div class="empty-title">No points activity yet</div>
        <div>Points appear here the moment an order is paid — online or at the register.</div>
      </div>
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
        <div id="core-confirm"></div>
      </div>
      <div class="card-footer">
        <button class="btn btn-primary" id="saveCore" type="button">Save</button>
        <span class="badge badge-warning" id="core-dirty" hidden>Unsaved</span>
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
        <span class="badge badge-warning" id="rules-dirty" hidden>Unsaved</span>
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
        <span class="badge badge-warning" id="tiers-dirty" hidden>Unsaved</span>
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
        <span class="badge badge-warning" id="referral-dirty" hidden>Unsaved</span>
        <span class="field-error" id="referralError" role="alert"></span>
      </div>
    </div>
  </section>

  <!-- ============ LEDGER ============ -->
  <section id="panel-ledger" role="tabpanel" aria-labelledby="tab-ledger" class="stack" hidden>
    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Look up a customer</h2>
        <p class="card-description">The fastest way to answer “why do I have this many points?” — their balance, tier, and every entry behind it.</p>
      </div></div>
      <div class="card-body stack">
        <div class="row">
          <div class="field">
            <label class="visually-hidden" for="lookup-id">Customer ID</label>
            <input class="input input-md" id="lookup-id" type="search" placeholder="Customer ID, e.g. 6123456789"
                   aria-describedby="lookup-help" />
          </div>
          <button class="btn btn-primary" id="lookup-go" type="button">Look up</button>
          <button class="btn btn-plain" id="lookup-clear" type="button" hidden>Back to all entries</button>
        </div>
        <span class="field-help" id="lookup-help">Find the ID in the customer's Shopify admin URL, or click any customer in the ledger below.</span>
        <div id="lookup-result"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Points ledger</h2>
        <p class="card-description" id="ledger-count"></p>
      </div><div class="row-end"><button class="btn btn-sm" id="export" type="button">Download CSV</button></div></div>
      <div class="card-body">
        <div class="row">
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
        <div class="empty-title" id="entries-empty-title"></div>
        <div id="entries-empty-body"></div>
      </div>
      <div class="card-footer"><button class="btn" id="loadMore" type="button" hidden>Show more</button><span class="field-help" id="shown-count"></span></div>
    </div>

    <div class="card">
      <div class="card-header"><div>
        <h2 class="card-title">Award points</h2>
        <p class="card-description">Giveaways, contests, or putting things right. Awards are real money to a customer, so check the summary before applying — every one lands in the ledger with a full audit trail.</p>
      </div></div>
      <div class="card-body stack">
        <div class="field">
          <label class="field-label" for="awardList">One customer per line</label>
          <textarea class="input" id="awardList" placeholder="6123456789,250&#10;6987654321,-100"
                    aria-describedby="awardList-help"></textarea>
          <span class="field-help" id="awardList-help">Format: <code>customer ID,points</code>. Negative values deduct, and never take a balance below zero.</span>
        </div>
        <div id="award-preview"></div>
        <div id="awardResult" hidden></div>
      </div>
      <div class="card-footer">
        <button class="btn btn-primary" id="applyAwards" type="button" disabled>Apply awards</button>
        <span class="field-help" id="awardStatus" role="status"></span>
      </div>
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
// The dashboard loads a recent window rather than the whole ledger; the true
// total comes from the overview, so the table can say what it is showing.
const LEDGER_WINDOW = 500;

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat();
/** Merchants read prices, not decimals — format in the shop's own currency. */
function money(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
    } catch (err) {
      // Unknown currency code — fall through to the plain amount.
    }
  }
  return value.toFixed(2);
}
let state = {
  entries: [], shown: PAGE_SIZE, shopDomain: null, currency: null, settings: null,
  totalEntries: 0, lookup: null, outstanding: 0, entriesLoaded: false,
};

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
    $('tab-' + t).tabIndex = selected ? 0 : -1;
    $('panel-' + t).hidden = !selected;
  }
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
}
for (const [i, t] of TABS.entries()) {
  const tab = $('tab-' + t);
  tab.onclick = () => showTab(t);
  // Tabs are one stop in the tab order; arrows move between them (WAI-ARIA).
  tab.addEventListener('keydown', (e) => {
    const moves = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: TABS.length - 1 - i };
    const delta = moves[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = TABS[(i + delta + TABS.length) % TABS.length];
    showTab(next);
    $('tab-' + next).focus();
  });
}
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
  state.outstanding = o.stats.outstandingPoints;
  const stats = $('stats');
  stats.textContent = '';
  stats.append(
    statTile('Members with points', nf.format(o.stats.members), nf.format(o.stats.entryCount) + ' ledger entries'),
    statTile(
      'Points outstanding',
      nf.format(o.stats.outstandingPoints),
      o.currency ? 'Worth ' + money(o.outstandingValue, o.currency) : 'Value shown once the first order arrives',
    ),
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

  // A brand-new shop needs a path, not four zeros.
  const started = $('getting-started');
  started.textContent = '';
  if (o.stats.entryCount === 0) {
    const card = el('div', 'card');
    const header = el('div', 'card-header');
    const head = el('div');
    head.append(
      el('h2', 'card-title', 'Three steps to go live'),
      el('p', 'card-description', 'The program is already running with sensible defaults — these are the steps that make it visible to customers.'),
    );
    header.appendChild(head);
    const body = el('div', 'card-body stack');
    const steps = [
      ['Check your rates', 'Decide what a point is worth before anyone earns one. Defaults: 1 point per 1.00 spent, 100 points for 1.00 off.', 'program'],
      ['Add the loyalty block to checkout', 'In the checkout editor, add the Loyalty balance block and set its backend URL, or shoppers will never see their points.', null],
      ['Make a test sale', 'Pay a test order online or at the register — the points land here within seconds.', null],
    ];
    for (const [i, [title, detail, goto]] of steps.entries()) {
      const row = el('div', 'row');
      row.appendChild(badge(String(i + 1)));
      const text = el('div');
      text.append(el('div', null, title), el('div', 'field-help', detail));
      row.appendChild(text);
      if (goto) {
        const go = el('button', 'btn btn-sm row-end', 'Open Program');
        go.type = 'button';
        go.onclick = () => showTab(goto);
        row.appendChild(go);
      }
      body.appendChild(row);
    }
    card.append(header, body);
    started.appendChild(card);
  }

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
  remove.onclick = () => { tr.remove(); syncTiersEmpty(); markDirty('tiers'); validateTiers(); };
  actions.appendChild(remove);
  tr.appendChild(actions);
  return tr;
}
function syncTiersEmpty() {
  const rows = document.querySelectorAll('#tiers tbody tr').length;
  $('tiers-empty').hidden = rows > 0;
  document.querySelector('#tiers thead').hidden = rows === 0;
}
/*
 * Rendered per card, not as one block: saving one card must not overwrite
 * unsaved edits sitting in another.
 */
function renderCore(s) {
  state.settings = Object.assign({}, state.settings, s);
  $('earnRate').value = s.earnRate;
  $('redemptionRate').value = s.redemptionRate;
  $('minRedemption').value = s.minRedemption;
  updateExamples();
  clearDirty('core');
  validateCore();
}
function renderRules(s) {
  state.settings = Object.assign({}, state.settings, s);
  const channels = $('channels');
  channels.textContent = '';
  for (const c of CHANNELS) channels.appendChild(channelRow(c, (s.channelRules || {})[c.key]));
  $('excludedSources').value = (s.excludedSources || []).join(', ');
  clearDirty('rules');
  validateRules();
}
function renderTiers(s) {
  state.settings = Object.assign({}, state.settings, s);
  const tbody = document.querySelector('#tiers tbody');
  tbody.textContent = '';
  // Ascending by threshold: the list then reads the way the ladder works.
  const tiers = (s.tiers || []).slice().sort((a, b) => a.minEarned365 - b.minEarned365);
  for (const t of tiers) tbody.appendChild(tierRow(t));
  syncTiersEmpty();
  clearDirty('tiers');
  validateTiers();
}
function renderReferral(s) {
  state.settings = Object.assign({}, state.settings, s);
  $('refEnabled').checked = !!(s.referral && s.referral.enabled);
  $('refAdvocate').value = s.referral ? s.referral.advocatePoints : 200;
  $('refFriend').value = s.referral ? s.referral.friendPoints : 100;
  clearDirty('referral');
  validateReferral();
}
function renderSettings(s) {
  state.settings = s;
  renderCore(s);
  renderRules(s);
  renderTiers(s);
  renderReferral(s);
}
function updateExamples() {
  const earn = Number($('earnRate').value);
  const redeem = Number($('redemptionRate').value);
  $('earn-example').textContent = Number.isFinite(earn) && earn > 0 ? nf.format(Math.floor(50 * earn)) : '—';
  $('redeem-example').textContent = Number.isFinite(redeem) && redeem > 0 ? (500 / redeem).toFixed(2) : '—';
}
$('earnRate').addEventListener('input', updateExamples);
$('redemptionRate').addEventListener('input', updateExamples);

/* ---------- live validation ----------
 * Each card checks itself as the merchant types, so a bad value is named
 * where it was typed instead of after a round trip to the server.
 */
const positiveDecimal = (v) => /^\\d+(\\.\\d+)?$/.test(String(v).trim()) && Number(v) > 0;
const positiveInt = (v) => /^\\d+$/.test(String(v).trim()) && Number(v) > 0;
const nonNegativeInt = (v) => /^\\d+$/.test(String(v).trim());
function mark(id, ok) { $(id).setAttribute('aria-invalid', String(!ok)); return ok; }

function validateCore() {
  const problems = [];
  if (!mark('earnRate', positiveDecimal($('earnRate').value))) problems.push('Points earned per 1.00 must be a positive number.');
  if (!mark('redemptionRate', positiveDecimal($('redemptionRate').value))) problems.push('Points per 1.00 of discount must be a positive number.');
  if (!mark('minRedemption', positiveInt($('minRedemption').value))) problems.push('Minimum redemption must be a whole number above zero.');
  $('coreError').textContent = problems[0] || '';
  $('saveCore').disabled = problems.length > 0;
  return problems.length === 0;
}
function validateRules() {
  const problems = [];
  for (const c of CHANNELS) {
    const field = $('chrate_' + c.key);
    if (!field) continue;
    const value = field.value.trim();
    const ok = value === '' || positiveDecimal(value);
    field.setAttribute('aria-invalid', String(!ok));
    if (!ok) problems.push(c.label + ' rate must be a positive number, or blank to use the base rate.');
  }
  $('rulesError').textContent = problems[0] || '';
  $('saveRules').disabled = problems.length > 0;
  return problems.length === 0;
}
function readTierRows() {
  return [...document.querySelectorAll('#tiers tbody tr')].map((tr) => ({
    tr,
    name: tr.querySelector('.tier-name').value.trim(),
    min: tr.querySelector('.tier-min').value.trim(),
    multiplier: tr.querySelector('.tier-mult').value.trim(),
  }));
}
function validateTiers() {
  const rows = readTierRows();
  const problems = [];
  const seen = new Map();
  for (const row of rows) {
    // Number('') is 0 — a blank minimum would silently grant the tier to the
    // whole shop, so every field has to be filled in explicitly.
    const nameOk = row.name !== '';
    const minOk = nonNegativeInt(row.min);
    const multOk = positiveDecimal(row.multiplier);
    row.tr.querySelector('.tier-name').setAttribute('aria-invalid', String(!nameOk));
    row.tr.querySelector('.tier-min').setAttribute('aria-invalid', String(!minOk));
    row.tr.querySelector('.tier-mult').setAttribute('aria-invalid', String(!multOk));
    if (!nameOk || !minOk || !multOk) {
      problems.push('Every tier needs a name, a whole-number minimum, and a multiplier above zero.');
      continue;
    }
    // Two tiers at the same threshold: one of them can never be reached.
    if (seen.has(row.min)) {
      problems.push('Two tiers both start at ' + nf.format(Number(row.min)) + ' points — only the first would ever apply.');
      row.tr.querySelector('.tier-min').setAttribute('aria-invalid', 'true');
    }
    seen.set(row.min, row.name);
  }
  $('tiersError').textContent = problems[0] || '';
  $('saveTiers').disabled = problems.length > 0;
  return problems.length === 0;
}
function validateReferral() {
  const problems = [];
  if (!mark('refAdvocate', nonNegativeInt($('refAdvocate').value))) problems.push('Referrer reward must be a whole number of points (0 or more).');
  if (!mark('refFriend', nonNegativeInt($('refFriend').value))) problems.push('Welcome bonus must be a whole number of points (0 or more).');
  $('referralError').textContent = problems[0] || '';
  $('saveReferral').disabled = problems.length > 0;
  return problems.length === 0;
}
function validateAll() { validateCore(); validateRules(); validateTiers(); validateReferral(); }

/* ---------- unsaved work ----------
 * Edits survive switching tabs (panels are only hidden), but a refresh or a
 * closed tab would lose them silently — so say so, and ask first.
 */
const dirty = new Set();
function markDirty(key) {
  if (dirty.has(key)) return;
  dirty.add(key);
  $(key + '-dirty').hidden = false;
}
function clearDirty(key) {
  dirty.delete(key);
  $(key + '-dirty').hidden = true;
}
function clearAllDirty() { for (const k of ['core', 'rules', 'tiers', 'referral']) clearDirty(k); }
function watchCard(key, ids, validate) {
  for (const id of ids) {
    const node = $(id);
    if (!node) continue;
    for (const evt of ['input', 'change']) {
      node.addEventListener(evt, () => { markDirty(key); validate(); });
    }
  }
}
watchCard('core', ['earnRate', 'redemptionRate', 'minRedemption'], validateCore);
watchCard('rules', ['excludedSources'], validateRules);
watchCard('referral', ['refEnabled', 'refAdvocate', 'refFriend'], validateReferral);
for (const evt of ['input', 'change']) {
  $('channels').addEventListener(evt, () => { markDirty('rules'); validateRules(); });
  $('tiers').addEventListener(evt, () => { markDirty('tiers'); validateTiers(); });
}
window.addEventListener('beforeunload', (e) => {
  if (dirty.size === 0) return;
  e.preventDefault();
  e.returnValue = '';
});

async function commitCore() {
  $('core-confirm').textContent = '';
  $('coreError').textContent = '';
  busy($('saveCore'), true);
  const { ok, body } = await putSettings({
    earnRate: $('earnRate').value.trim(),
    redemptionRate: $('redemptionRate').value.trim(),
    minRedemption: Number($('minRedemption').value),
  });
  busy($('saveCore'), false, 'Save');
  if (!ok) { $('coreError').textContent = body.error || 'Could not save.'; return; }
  renderCore(body); toast('Earning and redemption saved'); refreshOverview();
}
$('saveCore').onclick = () => {
  if (!validateCore()) return;
  const next = $('redemptionRate').value.trim();
  const previous = state.settings ? String(state.settings.redemptionRate) : next;
  // Changing what a point is worth silently revalues every point already in
  // customers' hands — show the before and after before committing to it.
  if (next === previous || state.outstanding <= 0 || !state.currency) return commitCore();
  const panel = $('core-confirm');
  panel.textContent = '';
  const before = state.outstanding / Number(previous);
  const after = state.outstanding / Number(next);
  const b = el('div', 'banner banner-warning');
  const inner = el('div');
  inner.append(
    el('div', 'banner-title', 'This changes what points already issued are worth'),
    el('p', null,
      'Customers hold ' + nf.format(state.outstanding) + ' points. They are worth ' +
      money(before.toFixed(2), state.currency) + ' today and would be worth ' +
      money(after.toFixed(2), state.currency) + ' after this change.'),
  );
  const actions = el('div', 'row');
  const go = el('button', 'btn btn-sm btn-primary', 'Change the rate anyway');
  go.type = 'button';
  go.onclick = () => commitCore();
  const cancel = el('button', 'btn btn-sm btn-plain', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => { panel.textContent = ''; renderCore(state.settings); };
  actions.append(go, cancel);
  inner.appendChild(actions);
  b.appendChild(inner);
  panel.appendChild(b);
  return undefined;
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
  renderRules(body); toast('Earning rules saved'); refreshOverview();
};

$('saveTiers').onclick = async () => {
  if (!validateTiers()) return;
  const tiers = readTierRows()
    .map((row) => ({ name: row.name, minEarned365: Number(row.min), multiplier: row.multiplier }))
    .sort((a, b) => a.minEarned365 - b.minEarned365);
  busy($('saveTiers'), true);
  const { ok, body } = await putSettings({ tiers });
  busy($('saveTiers'), false, 'Save');
  if (!ok) { $('tiersError').textContent = body.error || 'Could not save.'; return; }
  renderTiers(body); toast(tiers.length ? 'VIP tiers saved' : 'VIP tiers removed'); refreshOverview();
};
$('addTier').onclick = () => {
  document.querySelector('#tiers tbody').appendChild(tierRow(null));
  syncTiersEmpty();
  markDirty('tiers');
  validateTiers();
  document.querySelector('#tiers tbody tr:last-child .tier-name').focus();
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
  renderReferral(body); toast('Referral settings saved'); refreshOverview();
};

/* ---------- awards ---------- */
/**
 * Awards move money, so nothing is sent until the merchant can see exactly
 * who gets what. Every line is parsed as it is typed and shown back; a single
 * malformed line blocks the whole batch rather than silently skipping.
 */
function parseAwards(text) {
  const rows = [];
  for (const [i, raw] of text.split('\\n').entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const parts = line.split(',');
    const id = (parts[0] || '').trim().replace('gid://shopify/Customer/', '');
    const pointsText = (parts[1] || '').trim();
    const points = Number(pointsText);
    let error;
    if (parts.length !== 2) error = 'Needs exactly one comma: customer ID,points';
    else if (!/^\\d+$/.test(id)) error = 'Customer ID must be digits';
    else if (!/^-?\\d+$/.test(pointsText) || points === 0) error = 'Points must be a whole number, not zero';
    rows.push({ lineNumber: i + 1, id, points, error });
  }
  return rows;
}
function renderAwardPreview() {
  const rows = parseAwards($('awardList').value);
  const panel = $('award-preview');
  panel.textContent = '';
  const invalid = rows.filter((r) => r.error);
  $('applyAwards').disabled = rows.length === 0 || invalid.length > 0;
  if (rows.length === 0) return;

  const table = el('table', 'data');
  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Customer', 'Change', 'Status']) hrow.appendChild(el('th', null, h));
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    const cust = el('td');
    cust.appendChild(el('span', 'mono', r.id || '—'));
    tr.appendChild(cust);
    tr.appendChild(el('td', 'num ' + (r.error ? '' : r.points > 0 ? 'delta-pos' : ''), r.error ? '—' : (r.points > 0 ? '+' : '') + nf.format(r.points)));
    const status = el('td');
    status.appendChild(r.error ? badge(r.error, 'badge-critical') : badge('Ready', 'badge-success'));
    tr.appendChild(status);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const wrap = el('div', 'table-wrap');
  wrap.appendChild(table);
  panel.appendChild(wrap);

  const credited = rows.filter((r) => !r.error && r.points > 0).reduce((s, r) => s + r.points, 0);
  const deducted = rows.filter((r) => !r.error && r.points < 0).reduce((s, r) => s + r.points, 0);
  const summary = el('div', invalid.length ? 'banner banner-critical' : 'banner');
  const inner = el('div');
  inner.appendChild(el('div', 'banner-title', invalid.length
    ? invalid.length + (invalid.length === 1 ? ' line needs fixing' : ' lines need fixing')
    : 'About to award ' + rows.length + (rows.length === 1 ? ' customer' : ' customers')));
  if (!invalid.length) {
    const parts = [];
    if (credited) parts.push(nf.format(credited) + ' points credited');
    if (deducted) parts.push(nf.format(-deducted) + ' points deducted');
    inner.appendChild(el('p', null, parts.join(' · ') + '. This cannot be undone automatically — a mistake has to be corrected with another award.'));
  }
  summary.appendChild(inner);
  panel.appendChild(summary);
}

// The batch id is minted once per list and reused on retries, so a request
// that times out client-side cannot double-award when clicked again.
let awardBatchId = null;
$('awardList').addEventListener('input', () => {
  awardBatchId = null;
  $('awardResult').hidden = true;
  $('awardResult').textContent = '';
  $('awardStatus').textContent = '';
  renderAwardPreview();
});
$('applyAwards').onclick = async () => {
  const rows = parseAwards($('awardList').value);
  const status = $('awardStatus');
  if (rows.length === 0 || rows.some((r) => r.error)) {
    status.textContent = 'Fix the lines above first.';
    return;
  }
  const awards = rows.map((r) => ({
    customerId: 'gid://shopify/Customer/' + r.id,
    points: r.points,
  }));
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
  if (!body.replayed) {
    toast('Awards applied');
    // Clear the list so the applied batch can't be re-read as pending work.
    $('awardList').value = '';
    awardBatchId = null;
    renderAwardPreview();
  }
  loadEntries(); refreshOverview();
};

/* ---------- ledger ---------- */
// Drilling into a customer is the common follow-up from a ledger row, so the
// id is an in-app action; the external Shopify link lives on the detail card.
function customerCell(customerId) {
  const num = customerId.replace('gid://shopify/Customer/', '');
  if (!/^\\d+$/.test(num)) return el('span', 'mono', num);
  const button = el('button', 'btn btn-plain btn-sm mono', num);
  button.type = 'button';
  button.setAttribute('aria-label', 'Look up customer ' + num);
  button.onclick = () => {
    $('lookup-id').value = num;
    lookupCustomer();
  };
  return button;
}
function filtered() {
  const reason = $('filter-reason').value;
  const channel = $('filter-channel').value;
  return state.entries.filter((e) =>
    (!reason || e.reason === reason) && (!channel || e.sourceName === channel)
  );
}
function entryRow(e) {
  const tr = el('tr');
  const when = el('td');
  when.appendChild(el('span', null, new Date(e.createdAt).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
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
  const orderNum = (e.orderId || '').replace('gid://shopify/Order/', '');
  if (orderNum && state.shopDomain) {
    const a = el('a', 'mono', orderNum);
    a.href = 'https://' + state.shopDomain + '/admin/orders/' + orderNum;
    a.target = '_blank';
    a.rel = 'noopener';
    order.appendChild(a);
  } else {
    order.appendChild(el('span', 'mono', orderNum || '—'));
  }
  tr.appendChild(order);
  return tr;
}
function renderEntries() {
  // Until the first load lands, say so — otherwise the overview render beats
  // the entries request and a busy shop is told it has no activity.
  if (!state.entriesLoaded) {
    $('entries-empty').hidden = false;
    $('entries-empty-title').textContent = 'Loading…';
    $('entries-empty-body').textContent = '';
    $('recent-empty').hidden = false;
    $('recent-empty').querySelector('.empty-title').textContent = 'Loading…';
    $('ledger-count').textContent = '';
    return;
  }
  const rows = filtered();
  const tbody = document.querySelector('#entries tbody');
  tbody.textContent = '';
  for (const e of rows.slice(0, state.shown)) tbody.appendChild(entryRow(e));
  $('entries-empty').hidden = rows.length > 0;
  // A shop with no entries at all is a new install, not a failed search.
  const fresh = state.entries.length === 0 && !state.lookup;
  $('entries-empty-title').textContent = fresh ? 'No points activity yet' : 'Nothing matches';
  $('entries-empty-body').textContent = fresh
    ? 'Every earn, redemption, and refund reversal will be listed here as it happens.'
    : 'Try a different reason or channel.';
  $('loadMore').hidden = rows.length <= state.shown;
  $('shown-count').textContent = rows.length
    ? 'Showing ' + Math.min(state.shown, rows.length) + ' of ' + nf.format(rows.length)
    : '';
  const total = Math.max(state.totalEntries, state.entries.length);
  $('ledger-count').textContent = state.lookup
    ? 'Every entry for customer ' + state.lookup.raw + ', newest first.'
    : fresh
      ? 'Nothing recorded yet.'
      : total > state.entries.length
        ? nf.format(total) + ' entries. Showing the most recent ' + nf.format(state.entries.length) + ', newest first.'
        : nf.format(total) + ' entries, newest first.';

  const recent = document.querySelector('#recent tbody');
  recent.textContent = '';
  for (const e of state.entries.slice(0, 6)) recent.appendChild(entryRow(e));
  $('recent-empty').hidden = state.entries.length > 0;
  $('recent-empty').querySelector('.empty-title').textContent = 'No points activity yet';
}
for (const id of ['filter-reason', 'filter-channel']) {
  $(id).addEventListener('input', () => { state.shown = PAGE_SIZE; renderEntries(); });
}

/* ---------- customer lookup ---------- */
async function lookupCustomer() {
  const raw = $('lookup-id').value.trim().replace('gid://shopify/Customer/', '');
  const panel = $('lookup-result');
  panel.textContent = '';
  if (!/^\\d+$/.test(raw)) {
    const b = el('div', 'banner banner-warning');
    b.appendChild(el('div', 'banner-title', 'Enter a numeric customer ID, like 6123456789.'));
    panel.appendChild(b);
    return;
  }
  const customerId = 'gid://shopify/Customer/' + raw;
  const q = encodeURIComponent(customerId);
  busy($('lookup-go'), true, 'Looking up…');
  try {
    const [balance, entries] = await Promise.all([
      (await authed('/api/balance?customerId=' + q)).json(),
      (await authed('/api/entries?customerId=' + q)).json(),
    ]);
    // Authoritative for this customer: their whole history, not the recent window.
    state.entries = entries.entries.slice().reverse();
    state.entriesLoaded = true;
    state.lookup = { customerId, raw };
    state.shown = PAGE_SIZE;
    renderLookup(balance, entries.entries.length);
    renderEntries();
    $('lookup-clear').hidden = false;
  } catch (err) {
    const b = el('div', 'banner banner-critical');
    b.appendChild(el('div', 'banner-title', 'Could not load that customer: ' + err));
    panel.appendChild(b);
  } finally {
    busy($('lookup-go'), false, 'Look up');
  }
}
function renderLookup(balance, entryCount) {
  const panel = $('lookup-result');
  panel.textContent = '';
  if (entryCount === 0) {
    const b = el('div', 'banner');
    const inner = el('div');
    inner.append(
      el('div', 'banner-title', 'No points activity for this customer'),
      el('p', null, 'Either they have never bought anything, or this ID belongs to a different store.'),
    );
    b.appendChild(inner);
    panel.appendChild(b);
    return;
  }
  const grid = el('div', 'grid grid-stats');
  const tile = (label, value, caption) => {
    const card = el('div', 'card');
    const body = el('div', 'stat');
    body.append(el('div', 'stat-label', label), el('div', 'stat-value', value));
    if (caption) body.appendChild(el('div', 'stat-caption', caption));
    card.appendChild(body);
    return card;
  };
  grid.append(
    tile('Points balance', nf.format(balance.balance), 'Worth ' + money(balance.maxDiscountAmount, state.currency)),
    tile(
      balance.tier && balance.tier.name ? 'Tier' : 'Points earned (365 days)',
      balance.tier && balance.tier.name ? balance.tier.name : nf.format(balance.tier ? balance.tier.earned365 : 0),
      balance.tier && balance.tier.name ? nf.format(balance.tier.earned365) + ' earned in 365 days' : 'No tier reached',
    ),
    tile('Ledger entries', nf.format(entryCount), 'All time'),
  );
  panel.appendChild(grid);

  const actions = el('div', 'row');
  if (state.shopDomain) {
    const link = el('a', 'btn btn-sm', 'Open in Shopify');
    link.href = 'https://' + state.shopDomain + '/admin/customers/' + state.lookup.raw;
    link.target = '_blank';
    link.rel = 'noopener';
    actions.appendChild(link);
  }
  const award = el('button', 'btn btn-sm', 'Award points to this customer');
  award.type = 'button';
  award.onclick = () => {
    const box = $('awardList');
    const line = state.lookup.raw + ',';
    box.value = box.value.trim() ? box.value.trim() + '\\n' + line : line;
    box.dispatchEvent(new Event('input'));
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  };
  actions.appendChild(award);
  panel.appendChild(actions);
}
$('lookup-go').onclick = lookupCustomer;
$('lookup-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') lookupCustomer(); });
$('lookup-clear').onclick = async () => {
  state.lookup = null;
  $('lookup-id').value = '';
  $('lookup-result').textContent = '';
  $('lookup-clear').hidden = true;
  state.shown = PAGE_SIZE;
  await loadEntries();
};
$('loadMore').onclick = () => { state.shown += PAGE_SIZE; renderEntries(); };

$('export').onclick = async () => {
  // Export exactly what is on screen, filters and lookup included.
  const params = new URLSearchParams();
  if (state.lookup) params.set('customerId', state.lookup.customerId);
  if ($('filter-reason').value) params.set('reason', $('filter-reason').value);
  if ($('filter-channel').value) params.set('channel', $('filter-channel').value);
  const query = params.toString();
  const res = await authed('/api/ledger.csv' + (query ? '?' + query : ''));
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'points-ledger.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast(query ? 'CSV downloaded for this view' : 'CSV downloaded');
};

/* ---------- load ---------- */
async function loadEntries() {
  const { entries } = await (await authed('/api/entries?limit=' + LEDGER_WINDOW)).json();
  state.entries = entries.slice().reverse();
  state.entriesLoaded = true;
  state.lookup = null;
  $('lookup-clear').hidden = true;
  renderEntries();
}
async function refreshOverview() {
  const overview = await (await authed('/api/overview')).json();
  state.totalEntries = overview.stats.entryCount;
  renderOverview(overview);
  renderEntries();
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
async function doRefresh() {
  busy($('refresh'), true, 'Refreshing…');
  await load();
  busy($('refresh'), false, 'Refresh');
}
$('refresh').onclick = () => {
  // Reloading replaces every field from the server, so ask before throwing
  // away edits the merchant has not saved. Inline, not a browser dialog.
  if (dirty.size === 0) return doRefresh();
  const panel = $('load-error');
  panel.hidden = false;
  panel.textContent = '';
  const b = el('div', 'banner banner-warning');
  const inner = el('div');
  inner.append(
    el('div', 'banner-title', 'You have unsaved changes'),
    el('p', null, 'Refreshing reloads everything from Shopify and discards them.'),
  );
  const actions = el('div', 'row');
  const discard = el('button', 'btn btn-sm', 'Discard and refresh');
  discard.type = 'button';
  discard.onclick = async () => {
    clearAllDirty();
    panel.hidden = true;
    panel.textContent = '';
    await doRefresh();
  };
  const keep = el('button', 'btn btn-sm btn-plain', 'Keep editing');
  keep.type = 'button';
  keep.onclick = () => { panel.hidden = true; panel.textContent = ''; };
  actions.append(discard, keep);
  inner.appendChild(actions);
  b.appendChild(inner);
  panel.appendChild(b);
  return undefined;
};

showTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview');
load();
</script>
</body>
</html>`;
}
