-- Review fixes: persist each earn's effective rate (reversals must mirror
-- what the order actually earned), award-batch result persistence (true
-- idempotency incl. capped-to-nothing deductions), referral lookup by order.

alter table points_ledger_entry add column if not exists earn_rate numeric;

create table if not exists award_batch (
  shop_domain text not null,
  batch_id    text not null,
  results     jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (shop_domain, batch_id)
);

create index if not exists referral_by_order on referral (shop_domain, order_id);

-- The amounts actually granted, persisted so a later clawback (full refund of
-- the qualifying order) reverses reality, not whatever settings say that day.
alter table referral add column if not exists advocate_points int not null default 0;
alter table referral add column if not exists friend_points int not null default 0;
