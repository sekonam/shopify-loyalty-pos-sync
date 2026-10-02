-- v1.x/v2: channel rules + tiers + referral settings live in one config
-- document; referrals get their own tables; the ledger reason enum grows.

alter table shop_settings add column if not exists config jsonb not null default '{}';

alter table points_ledger_entry drop constraint if exists points_ledger_entry_reason_check;
alter table points_ledger_entry add constraint points_ledger_entry_reason_check
  check (reason in ('earn', 'redeem', 'refund_reversal', 'adjustment', 'reconciliation', 'referral_reward'));

create table if not exists referral_code (
  shop_domain text not null,
  code        text not null,
  customer_id text not null,
  created_at  timestamptz not null default now(),
  primary key (shop_domain, code)
);
create unique index if not exists referral_code_customer
  on referral_code (shop_domain, customer_id);

create table if not exists referral (
  shop_domain         text not null,
  friend_customer_id  text not null,
  advocate_customer_id text not null,
  code                text not null,
  order_id            text not null,
  created_at          timestamptz not null default now(),
  -- One referral reward per referred customer, ever.
  primary key (shop_domain, friend_customer_id)
);
