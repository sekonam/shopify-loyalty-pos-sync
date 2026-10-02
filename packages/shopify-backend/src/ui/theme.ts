/**
 * Design system for the app's own HTML surfaces (embedded admin, dev console).
 *
 * Token values are the real Polaris ones, read from the published
 * @shopify/polaris-tokens package and the live polaris-1.js bundle and
 * measured in a browser (2026-10-02), so the admin reads as native inside
 * Shopify admin rather than merely Polaris-flavoured.
 *
 * It is hand-written CSS rather than Polaris web components on purpose: the
 * components supply no page chrome (background, body font, page width all
 * come from the admin frame) and style themselves differently depending on
 * whether App Bridge is present, so a standalone render — local development,
 * screenshots — would not match what a merchant sees. One stylesheet renders
 * identically everywhere.
 *
 * `dark` is opt-in and off for the admin by design: Shopify admin has no dark
 * mode (verified — the Polaris bundle contains no prefers-color-scheme rule
 * and ignores the OS setting), so a dark app frame inside a light admin would
 * look broken rather than considerate. The dev console, which never renders
 * inside the admin, opts in.
 */
export function designSystemCss(options: { dark?: boolean } = {}): string {
  return `
:root {
  color-scheme: light;
  /* 4px grid — the admin's own spacing scale. */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;

  --bg: #f1f1f1;
  --surface: #ffffff;
  --surface-subdued: #f7f7f7;
  --surface-hover: #f7f7f7;
  --surface-tertiary: #f3f3f3;
  --border: #e3e3e3;
  --border-hover: #cccccc;
  --text: #303030;
  --text-subdued: #616161;
  --text-disabled: #b5b5b5;
  --text-link: #005bd3;

  --primary-bg: #303030;
  --primary-bg-hover: #1a1a1a;
  --primary-text: #ffffff;

  --input-bg: #fdfdfd;
  --input-bg-hover: #fafafa;
  --input-border: #8a8a8a;
  --input-border-hover: #616161;

  --success-text: #014b40;
  --success-surface: #cdfed4;
  --success-border: #92fcac;
  --success-badge-bg: #affebf;
  --critical-text: #8e0b21;
  --critical-surface: #fee8eb;
  --critical-border: #fec1c7;
  --critical-badge-bg: #fed1d7;
  --warning-text: #5e4200;
  --warning-surface: #fff1e3;
  --warning-border: #ffc879;
  --warning-badge-bg: #ffd6a4;
  --info-text: #003a5a;
  --info-surface: #eaf4ff;
  --info-border: #a8d8ff;
  --info-badge-bg: #d5ebff;

  --focus: #005bd3;
  /* Cards 12px, controls 8px — the admin's semantic radii. */
  --radius-container: 12px;
  --radius-control: 8px;
  --radius-pill: 999px;
  --shadow-container:
    0 .3125rem .3125rem -.15625rem rgba(0,0,0,.03),
    0 .1875rem .1875rem -.09375rem rgba(0,0,0,.02),
    0 .125rem .125rem -.0625rem rgba(0,0,0,.02),
    0 .0625rem .0625rem -.03125rem rgba(0,0,0,.03),
    0 .03125rem .03125rem 0 rgba(0,0,0,.04),
    0 0 0 .0625rem rgba(0,0,0,.06);
  --shadow-button:
    0 -.0625rem 0 0 #b5b5b5 inset,
    0 0 0 .0625rem rgba(0,0,0,.1) inset,
    0 .03125rem 0 .09375rem #fff inset;
  --shadow-button-primary:
    0 -.0625rem 0 .0625rem rgba(0,0,0,.8) inset,
    0 0 0 .0625rem #303030 inset,
    0 .03125rem 0 .09375rem rgba(255,255,255,.25) inset;
  --shadow-raised:
    0 .5rem 1.5rem -.5rem rgba(0,0,0,.28), 0 .5rem 1rem -.25rem rgba(0,0,0,.05),
    0 .1875rem .375rem 0 rgba(0,0,0,.05), 0 0 0 .0625rem rgba(0,0,0,.06);
  --font: Inter, "Noto Sans Arabic", "Noto Sans Hebrew", -apple-system, BlinkMacSystemFont,
          "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
}
${options.dark ? darkTokens() : ''}

*, *::before, *::after { box-sizing: border-box; }

/*
 * The UA's [hidden] rule is only "display: none" at the lowest specificity, so
 * any layout class (.stack, .row, .grid) silently defeats it — which showed up
 * as every tab panel rendering at once. Make hiding win.
 */
[hidden] { display: none !important; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  font-weight: 450;
  line-height: 20px;
  font-feature-settings: 'calt' 0;
  -webkit-font-smoothing: antialiased;
}

:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; border-radius: 4px; }

/* ---------- layout ---------- */
.page { max-width: 1000px; margin: 0 auto; padding: var(--space-4) var(--space-4) var(--space-10); }

.page-header { display: flex; align-items: flex-start; gap: var(--space-3); margin-bottom: var(--space-5); }
.page-header .mark {
  flex: none; width: 32px; height: 32px; border-radius: var(--radius-control);
  background: var(--primary-bg); color: var(--primary-text);
  display: grid; place-items: center;
}
.page-title { margin: 0; font-size: 18px; line-height: 24px; font-weight: 600; letter-spacing: -0.00833em; }
.page-subtitle { margin: var(--space-1) 0 0; color: var(--text-subdued); max-width: 68ch; }
.page-header-actions { margin-left: auto; display: flex; gap: var(--space-2); align-items: center; }

.stack { display: flex; flex-direction: column; gap: var(--space-4); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.row-end { margin-left: auto; }
.grid { display: grid; gap: var(--space-4); }
.grid-stats { grid-template-columns: repeat(auto-fit, minmax(176px, 1fr)); }
.grid-2 { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }

/* ---------- tabs ---------- */
.tabs { display: flex; gap: var(--space-1); border-bottom: 1px solid var(--border); margin-bottom: var(--space-5); }
.tab {
  appearance: none; background: none; border: 0; cursor: pointer;
  font: inherit; font-size: 13px; font-weight: 600; color: var(--text-subdued);
  padding: var(--space-3); border-bottom: 2px solid transparent;
  margin-bottom: -1px; border-radius: var(--radius-control) var(--radius-control) 0 0;
}
.tab:hover { color: var(--text); background: var(--surface-hover); }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--text); }

/* ---------- card ---------- */
.card { background: var(--surface); border-radius: var(--radius-container); box-shadow: var(--shadow-container); }
.card-header { padding: var(--space-4) var(--space-4) 0; display: flex; align-items: flex-start; gap: var(--space-3); }
.card-title { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; }
.card-description { margin: var(--space-1) 0 0; color: var(--text-subdued); max-width: 70ch; }
.card-body { padding: var(--space-4); }
.card-footer {
  padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border);
  background: var(--surface-subdued); border-radius: 0 0 var(--radius-container) var(--radius-container);
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
}

/* ---------- stat tile ---------- */
.stat { padding: var(--space-4); }
.stat-label { color: var(--text-subdued); font-weight: 550; }
.stat-value {
  margin-top: var(--space-1); font-size: 24px; line-height: 32px; font-weight: 650;
  letter-spacing: -0.00833em; font-variant-numeric: tabular-nums;
}
.stat-caption { color: var(--text-subdued); margin-top: 2px; }

/* ---------- buttons ---------- */
.btn {
  appearance: none; cursor: pointer; font-family: inherit;
  font-size: 12px; line-height: 16px; font-weight: 550;
  padding: 6px 12px; min-height: 28px; border-radius: var(--radius-control);
  border: 0; background: var(--surface); color: var(--text);
  box-shadow: var(--shadow-button); display: inline-flex; align-items: center;
  justify-content: center; gap: var(--space-2); white-space: nowrap; text-decoration: none;
}
.btn:hover:not(:disabled) { background: #fafafa; }
.btn:active:not(:disabled) { background: var(--surface-hover); }
.btn:disabled { cursor: not-allowed; color: var(--text-disabled); box-shadow: var(--shadow-button); }
.btn-primary { background: var(--primary-bg); color: var(--primary-text); box-shadow: var(--shadow-button-primary); }
.btn-primary:hover:not(:disabled), .btn-primary:active:not(:disabled) { background: var(--primary-bg-hover); }
.btn-primary:disabled { background: rgba(0,0,0,.17); color: #fff; }
.btn-plain { background: none; box-shadow: none; color: var(--text-link); }
.btn-plain:hover:not(:disabled) { background: var(--surface-hover); }
.btn-critical { color: var(--critical-text); }

.spinner {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 2px solid currentColor; border-right-color: transparent;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2s; } }

/* ---------- fields ---------- */
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-weight: 450; }
.field-help { color: var(--text-subdued); font-size: 12px; line-height: 16px; }
.field-error { color: var(--critical-text); font-size: 12px; line-height: 16px; font-weight: 550; }
.input {
  font-family: inherit; font-size: 13px; line-height: 20px; font-weight: 450;
  color: var(--text); background: var(--input-bg);
  border: 0; box-shadow: inset 0 0 0 1px var(--input-border);
  border-radius: var(--radius-control); padding: 5px 12px; min-height: 32px; width: 100%;
}
.input:hover:not(:disabled) { background: var(--input-bg-hover); box-shadow: inset 0 0 0 1px var(--input-border-hover); }
.input:focus { outline: 0; box-shadow: inset 0 0 0 2px var(--focus); }
.input[aria-invalid="true"] { background: var(--critical-surface); box-shadow: inset 0 0 0 1px var(--critical-text); }
.input-sm { max-width: 120px; }
.input-md { max-width: 220px; }
textarea.input { min-height: 84px; resize: vertical; font-family: var(--font-mono); font-size: 12px; }
select.input { padding-right: var(--space-2); }

.checkbox { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; }
.checkbox input { width: 16px; height: 16px; accent-color: var(--primary-bg); cursor: pointer; }

/* ---------- badge ---------- */
.badge {
  display: inline-flex; align-items: center; gap: var(--space-1);
  padding: 2px 8px; min-height: 20px; border-radius: var(--radius-control);
  background: var(--surface-tertiary); color: var(--text);
  font-size: 12px; line-height: 16px; font-weight: 550; white-space: nowrap;
}
.badge-success { background: var(--success-badge-bg); color: var(--success-text); }
.badge-critical { background: var(--critical-badge-bg); color: var(--critical-text); }
.badge-warning { background: var(--warning-badge-bg); color: var(--warning-text); }
.badge-info { background: var(--info-badge-bg); color: var(--info-text); }

/* ---------- banner ---------- */
.banner {
  display: flex; gap: var(--space-3); padding: var(--space-3) var(--space-4);
  border: 1px solid var(--info-border); background: var(--info-surface); color: var(--info-text);
  border-radius: var(--radius-control);
}
.banner-success { border-color: var(--success-border); background: var(--success-surface); color: var(--success-text); }
.banner-critical { border-color: var(--critical-border); background: var(--critical-surface); color: var(--critical-text); }
.banner-warning { border-color: var(--warning-border); background: var(--warning-surface); color: var(--warning-text); }
.banner-title { font-weight: 600; }
.banner p { margin: 2px 0 0; }

/* ---------- table ---------- */
.table-wrap { overflow-x: auto; }
table.data { width: 100%; border-collapse: collapse; }
table.data th, table.data td { text-align: start; white-space: nowrap; }
table.data th {
  padding: 6px var(--space-3); font-size: 12px; line-height: 16px; font-weight: 550;
  color: var(--text-subdued); background: var(--surface-subdued);
  border-bottom: 1px solid var(--border); position: sticky; top: 0;
}
table.data td { padding: var(--space-2) var(--space-3); font-size: 12px; line-height: 16px; border-bottom: 1px solid var(--border); }
table.data tbody tr:hover { background: var(--surface-hover); }
table.data tbody tr:last-child td { border-bottom: 0; }
td.num { text-align: end; font-variant-numeric: tabular-nums; font-weight: 550; }
.delta-pos { color: var(--success-text); }
.mono { font-family: var(--font-mono); font-size: 12px; color: var(--text-subdued); }
a.mono { color: var(--text-link); text-decoration: none; }
a.mono:hover { text-decoration: underline; }

/* ---------- misc ---------- */
.empty { padding: var(--space-10) var(--space-4); text-align: center; color: var(--text-subdued); }
.empty-title { font-weight: 600; color: var(--text); margin-bottom: var(--space-1); }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
code { font-family: var(--font-mono); font-size: 12px; }

#toast-region { position: fixed; inset-block-end: var(--space-6); inset-inline: 0; display: grid; justify-items: center; gap: var(--space-2); pointer-events: none; z-index: 10; }
.toast {
  background: #303030; color: #fff; padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-control); box-shadow: var(--shadow-raised); font-weight: 550;
  display: flex; align-items: center; gap: var(--space-3);
}
.toast-critical { background: var(--critical-text); }

/* Touch and narrow screens get the admin's larger tap targets. */
@media (max-width: 768px), (pointer: coarse) {
  .btn { min-height: 44px; padding: 10px 16px; }
  .input { min-height: 44px; }
}
@media (max-width: 600px) {
  .page { padding: var(--space-3) var(--space-3) var(--space-8); }
  .card-header, .card-body { padding-inline: var(--space-3); }
}
`;
}

/** Dev-console only: the admin itself is light-only, matching Shopify. */
function darkTokens(): string {
  return `
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #1a1a1a; --surface: #242424; --surface-subdued: #1f1f1f;
    --surface-hover: #2b2b2b; --surface-tertiary: #303030;
    --border: #3a3a3a; --border-hover: #4a4a4a;
    --text: #e3e3e3; --text-subdued: #a0a0a0; --text-disabled: #6b6b6b; --text-link: #6ab8ff;
    --primary-bg: #e3e3e3; --primary-bg-hover: #ffffff; --primary-text: #1a1a1a;
    --input-bg: #1f1f1f; --input-bg-hover: #262626; --input-border: #5a5a5a; --input-border-hover: #808080;
    --success-text: #8ae0b6; --success-surface: #12261d; --success-border: #1f5137; --success-badge-bg: #163020;
    --critical-text: #ffa9a0; --critical-surface: #2c1512; --critical-border: #6b2a21; --critical-badge-bg: #3a1a16;
    --warning-text: #ffd79b; --warning-surface: #2a2112; --warning-border: #6b5424; --warning-badge-bg: #342a16;
    --info-text: #a4e8f2; --info-surface: #11272c; --info-border: #1f4d57; --info-badge-bg: #16323a;
    --focus: #6ab8ff;
    --shadow-container: 0 1px 0 rgba(0,0,0,.3), 0 0 0 1px rgba(255,255,255,.06);
    --shadow-button: 0 0 0 1px rgba(255,255,255,.12) inset;
    --shadow-button-primary: none;
    --shadow-raised: 0 8px 24px -8px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08);
  }
}
`;
}

/** The app's mark — a ledger line that stays level across two channels. */
export const logoMarkSvg = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
  <path d="M3 13.5h4.2l2-7 2.3 10.5 2-7h3.5" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="5" cy="5" r="1.6" fill="currentColor"/>
  <circle cx="15" cy="5" r="1.6" fill="currentColor"/>
</svg>`;

/**
 * Inline favicon, so a pinned admin tab is identifiable. Self-contained data
 * URI — no extra request, and nothing to serve or cache-bust.
 */
export function faviconLink(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">` +
    `<rect width="20" height="20" rx="4.5" fill="#303030"/>` +
    `<path d="M3.5 13h3.8l1.9-6.5L11.4 16l1.9-6.5h3.2" stroke="#fff" stroke-width="1.6" ` +
    `fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}" />`;
}
