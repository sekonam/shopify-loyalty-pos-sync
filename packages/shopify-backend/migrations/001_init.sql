-- TECHNICAL-SPEC §1. Append-only: no UPDATE ever touches delta on an existing row.
-- Balance is always derived as SUM(delta); never stored as a mutable column.

create table if not exists points_ledger_entry (
  id                    uuid primary key default gen_random_uuid(),
  shop_domain           text not null,
  customer_id           text not null,
  order_id              text,
  refund_id             text,
  -- 'other' preserves an unrecognized Shopify source_name (kept verbatim in
  -- raw_source_name) instead of mislabeling it as a known channel.
  source_name           text not null check (source_name in ('web', 'pos', 'mobile_app', 'system', 'other')),
  raw_source_name       text,
  delta                 integer not null check (delta <> 0),
  reason                text not null check (reason in ('earn', 'redeem', 'refund_reversal', 'adjustment', 'reconciliation')),
  redemption_attempt_id uuid,
  idempotency_key       text not null,
  created_at            timestamptz not null default now()
);
create unique index if not exists points_ledger_entry_idem
  on points_ledger_entry (shop_domain, idempotency_key);
create index if not exists points_ledger_entry_customer
  on points_ledger_entry (shop_domain, customer_id, created_at);
create index if not exists points_ledger_entry_order
  on points_ledger_entry (shop_domain, order_id) where order_id is not null;

create table if not exists redemption_attempt (
  id               uuid primary key,
  shop_domain      text not null,
  customer_id      text not null,
  channel          text not null check (channel in ('web', 'pos')),
  requested_points integer not null check (requested_points > 0),
  status           text not null check (status in ('applied', 'rejected_insufficient_balance', 'rejected_below_minimum', 'rejected_stale_offline_state', 'pending')),
  pos_device_id    text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);
create index if not exists redemption_attempt_customer
  on redemption_attempt (shop_domain, customer_id, created_at);

create table if not exists shop_settings (
  shop_domain     text primary key,
  earn_rate       numeric not null default 1 check (earn_rate > 0),
  redemption_rate numeric not null default 100 check (redemption_rate > 0),
  min_redemption  integer not null default 100 check (min_redemption > 0),
  installed_at    timestamptz not null default now(),
  uninstalled_at  timestamptz
);

create table if not exists webhook_receipt (
  id           uuid primary key default gen_random_uuid(),
  shop_domain  text not null,
  topic        text not null,
  webhook_id   text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  payload_hash text not null
);
create unique index if not exists webhook_receipt_id
  on webhook_receipt (shop_domain, webhook_id);

create table if not exists reconciliation_run (
  id             uuid primary key default gen_random_uuid(),
  shop_domain    text not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  checkpoint     timestamptz not null,
  orders_seen    integer not null default 0,
  entries_added  integer not null default 0,
  error          text
);
create index if not exists reconciliation_run_shop
  on reconciliation_run (shop_domain, started_at desc);
