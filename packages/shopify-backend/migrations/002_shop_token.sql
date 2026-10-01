-- Offline Admin API access tokens (from managed-install token exchange),
-- needed by the reconciliation job. One row per installed shop.
create table if not exists shop_token (
  shop_domain  text primary key,
  access_token text not null,
  updated_at   timestamptz not null default now()
);
