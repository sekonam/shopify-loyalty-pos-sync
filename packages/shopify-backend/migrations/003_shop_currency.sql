-- Shop currency, learned from the first orders/paid payload. Redemption
-- amounts are priced in this currency; checkout refuses to offer redemption
-- in a different presentment currency (v1 is single-currency).
alter table shop_settings add column if not exists currency text;
