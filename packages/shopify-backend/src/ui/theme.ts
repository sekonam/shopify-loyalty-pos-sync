/**
 * Design system for the app's own HTML surfaces (embedded admin, dev console).
 *
 * The admin renders inside Shopify admin, so it borrows Polaris' visual
 * language — neutral surfaces, near-black primary actions, 8px grid, subtle
 * elevation — rather than inventing one. It is hand-written CSS on purpose:
 * Polaris web components only render where App Bridge is present, and this
 * page must also look right standalone (local development, screenshots).
 */
export function designSystemCss(): string {
  return `
:root {
  color-scheme: light;
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;

  --bg: #f1f1f1;
  --surface: #ffffff;
  --surface-subdued: #fafafa;
  --surface-hover: #f7f7f7;
  --border: #e3e3e3;
  --border-strong: #cdcdcd;
  --text: #303030;
  --text-subdued: #616161;
  --text-disabled: #b5b5b5;

  --primary-bg: #303030;
  --primary-bg-hover: #1a1a1a;
  --primary-text: #ffffff;

  --success-text: #0c5132;
  --success-surface: #e5f5ed;
  --success-border: #a6e0c3;
  --critical-text: #8e1f0b;
  --critical-surface: #fee9e8;
  --critical-border: #f0a7a1;
  --warning-text: #5e4200;
  --warning-surface: #fff1e3;
  --warning-border: #f0c38c;
  --info-text: #00527c;
  --info-surface: #ebf9fc;
  --info-border: #a4e8f2;

  --focus: #005bd3;
  --radius: 8px;
  --radius-sm: 6px;
  --radius-pill: 999px;
  --shadow-card: 0 1px 0 rgba(26, 26, 26, 0.07);
  --shadow-raised: 0 3px 6px -3px rgba(26, 26, 26, 0.16), 0 1px 0 rgba(26, 26, 26, 0.07);
  --shadow-button: 0 1px 0 rgba(26, 26, 26, 0.07), inset 0 -1px 0 rgba(0, 0, 0, 0.12);
  --font: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #1a1a1a;
    --surface: #242424;
    --surface-subdued: #1f1f1f;
    --surface-hover: #2b2b2b;
    --border: #3a3a3a;
    --border-strong: #4a4a4a;
    --text: #e3e3e3;
    --text-subdued: #a0a0a0;
    --text-disabled: #6b6b6b;
    --primary-bg: #e3e3e3;
    --primary-bg-hover: #ffffff;
    --primary-text: #1a1a1a;
    --success-text: #8ae0b6;
    --success-surface: #12261d;
    --success-border: #1f5137;
    --critical-text: #ffa9a0;
    --critical-surface: #2c1512;
    --critical-border: #6b2a21;
    --warning-text: #ffd79b;
    --warning-surface: #2a2112;
    --warning-border: #6b5424;
    --info-text: #a4e8f2;
    --info-surface: #11272c;
    --info-border: #1f4d57;
    --focus: #6ab8ff;
    --shadow-card: 0 1px 0 rgba(0, 0, 0, 0.3);
    --shadow-raised: 0 3px 6px -3px rgba(0, 0, 0, 0.5), 0 1px 0 rgba(0, 0, 0, 0.3);
    --shadow-button: 0 1px 0 rgba(0, 0, 0, 0.3);
  }
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 13px;
  line-height: 20px;
  -webkit-font-smoothing: antialiased;
}

:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; border-radius: var(--radius-sm); }

/* ---------- layout ---------- */
.page { max-width: 1040px; margin: 0 auto; padding: var(--space-6) var(--space-4) var(--space-10); }

.page-header { display: flex; align-items: flex-start; gap: var(--space-3); margin-bottom: var(--space-5); }
.page-header .mark {
  flex: none; width: 36px; height: 36px; border-radius: var(--radius);
  background: var(--primary-bg); color: var(--primary-text);
  display: grid; place-items: center;
}
.page-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 650; letter-spacing: -0.01em; }
.page-subtitle { margin: 2px 0 0; color: var(--text-subdued); max-width: 68ch; }
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
  font: inherit; font-weight: 550; color: var(--text-subdued);
  padding: var(--space-3) var(--space-3); border-bottom: 2px solid transparent;
  margin-bottom: -1px; border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}
.tab:hover { color: var(--text); background: var(--surface-hover); }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--text); }

/* ---------- card ---------- */
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow-card);
}
.card-header { padding: var(--space-4) var(--space-4) 0; display: flex; align-items: flex-start; gap: var(--space-3); }
.card-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 650; }
.card-description { margin: var(--space-1) 0 0; color: var(--text-subdued); max-width: 70ch; }
.card-body { padding: var(--space-4); }
.card-footer {
  padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border);
  background: var(--surface-subdued); border-radius: 0 0 var(--radius) var(--radius);
  display: flex; align-items: center; gap: var(--space-3);
}

/* ---------- stat tile ---------- */
.stat { padding: var(--space-4); }
.stat-label { color: var(--text-subdued); font-weight: 550; }
.stat-value {
  margin-top: var(--space-1); font-size: 24px; line-height: 32px; font-weight: 650;
  letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
}
.stat-caption { color: var(--text-subdued); margin-top: 2px; }

/* ---------- buttons ---------- */
.btn {
  appearance: none; cursor: pointer; font: inherit; font-weight: 600;
  padding: 7px 13px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
  box-shadow: var(--shadow-button); display: inline-flex; align-items: center; gap: var(--space-2);
  min-height: 32px; white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--surface-hover); }
.btn:active:not(:disabled) { box-shadow: none; transform: translateY(0.5px); }
.btn:disabled { cursor: not-allowed; opacity: 0.55; box-shadow: none; }
.btn-primary { background: var(--primary-bg); color: var(--primary-text); border-color: transparent; }
.btn-primary:hover:not(:disabled) { background: var(--primary-bg-hover); }
.btn-plain {
  background: none; border-color: transparent; box-shadow: none;
  color: var(--focus); padding-inline: var(--space-2);
}
.btn-plain:hover:not(:disabled) { background: var(--surface-hover); }
.btn-critical { color: var(--critical-text); }
.btn-sm { min-height: 28px; padding: 4px 10px; }

.spinner {
  width: 14px; height: 14px; border-radius: 50%; flex: none;
  border: 2px solid currentColor; border-right-color: transparent;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2s; } }

/* ---------- fields ---------- */
.field { display: flex; flex-direction: column; gap: var(--space-1); }
.field-label { font-weight: 550; }
.field-help { color: var(--text-subdued); }
.field-error { color: var(--critical-text); font-weight: 550; }
.input {
  font: inherit; color: var(--text); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  padding: 6px 10px; min-height: 32px; width: 100%;
}
.input:hover:not(:disabled) { border-color: var(--text-subdued); }
.input:focus { outline: 2px solid var(--focus); outline-offset: -1px; border-color: transparent; }
.input[aria-invalid="true"] { border-color: var(--critical-border); background: var(--critical-surface); }
.input-sm { max-width: 120px; }
.input-md { max-width: 220px; }
textarea.input { min-height: 84px; resize: vertical; font-family: var(--font-mono); }

.checkbox { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; }
.checkbox input { width: 16px; height: 16px; accent-color: var(--primary-bg); cursor: pointer; }

/* ---------- badge ---------- */
.badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: var(--radius-pill);
  background: var(--surface-hover); color: var(--text-subdued);
  border: 1px solid var(--border); font-size: 12px; font-weight: 550; white-space: nowrap;
}
.badge-success { background: var(--success-surface); color: var(--success-text); border-color: var(--success-border); }
.badge-critical { background: var(--critical-surface); color: var(--critical-text); border-color: var(--critical-border); }
.badge-warning { background: var(--warning-surface); color: var(--warning-text); border-color: var(--warning-border); }
.badge-info { background: var(--info-surface); color: var(--info-text); border-color: var(--info-border); }
.badge-dot::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

/* ---------- banner ---------- */
.banner {
  display: flex; gap: var(--space-3); padding: var(--space-3) var(--space-4);
  border: 1px solid var(--info-border); background: var(--info-surface); color: var(--info-text);
  border-radius: var(--radius);
}
.banner-success { border-color: var(--success-border); background: var(--success-surface); color: var(--success-text); }
.banner-critical { border-color: var(--critical-border); background: var(--critical-surface); color: var(--critical-text); }
.banner-warning { border-color: var(--warning-border); background: var(--warning-surface); color: var(--warning-text); }
.banner-title { font-weight: 650; }
.banner p { margin: 2px 0 0; }

/* ---------- table ---------- */
.table-wrap { overflow-x: auto; }
table.data { width: 100%; border-collapse: collapse; }
table.data th, table.data td {
  text-align: left; padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border); white-space: nowrap;
}
table.data th {
  font-size: 12px; font-weight: 600; color: var(--text-subdued);
  background: var(--surface-subdued); position: sticky; top: 0;
}
table.data tbody tr:hover { background: var(--surface-hover); }
table.data tbody tr:last-child td { border-bottom: 0; }
td.num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.delta-pos { color: var(--success-text); }
.delta-neg { color: var(--text); }
.mono { font-family: var(--font-mono); font-size: 12px; color: var(--text-subdued); }
a.mono { color: var(--focus); text-decoration: none; }
a.mono:hover { text-decoration: underline; }

/* ---------- misc ---------- */
.empty { padding: var(--space-10) var(--space-4); text-align: center; color: var(--text-subdued); }
.empty-title { font-weight: 650; color: var(--text); margin-bottom: var(--space-1); }
.skeleton {
  background: linear-gradient(90deg, var(--surface-hover) 25%, var(--border) 37%, var(--surface-hover) 63%);
  background-size: 400% 100%; animation: shimmer 1.4s ease infinite; border-radius: var(--radius-sm);
  height: 12px;
}
@keyframes shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

#toast-region { position: fixed; inset-block-end: var(--space-6); inset-inline: 0; display: grid; justify-items: center; gap: var(--space-2); pointer-events: none; z-index: 10; }
.toast {
  background: #303030; color: #fff; padding: var(--space-3) var(--space-4);
  border-radius: var(--radius); box-shadow: var(--shadow-raised); font-weight: 550;
  display: flex; align-items: center; gap: var(--space-3);
}
.toast-critical { background: var(--critical-text); }

@media (max-width: 600px) {
  .page { padding: var(--space-4) var(--space-3) var(--space-8); }
  .page-title { font-size: 18px; }
  .card-header, .card-body { padding-inline: var(--space-3); }
  table.data th, table.data td { padding: var(--space-2) var(--space-3); }
}
`;
}

/** The app's mark — a ledger line that stays level across two channels. */
export const logoMarkSvg = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
  <path d="M3 13.5h4.2l2-7 2.3 10.5 2-7h3.5" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="5" cy="5" r="1.6" fill="currentColor"/>
  <circle cx="15" cy="5" r="1.6" fill="currentColor"/>
</svg>`;
