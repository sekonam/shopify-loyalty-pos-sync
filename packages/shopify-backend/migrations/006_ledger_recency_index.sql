-- The admin's ledger page, its filtered totals, and the streamed CSV export
-- all read the shop's entries newest-first and page by (created_at, id). With
-- only the per-customer and per-order indexes from 001, every one of those
-- sorted the shop's whole partition: at 71k entries that was a parallel sort
-- of ~32k rows per page load, and it grows with the shop forever.
--
-- One composite index, matching the ORDER BY exactly (including the DESC
-- direction, so the page scan needs no sort at all and the keyset export can
-- walk it forward). Deliberately only one: this table's hot path is append on
-- every orders/paid webhook, and reason/source_name are low-cardinality
-- enough that filtering while scanning this index beats paying insert cost
-- for an index per filter.
create index if not exists points_ledger_entry_shop_recent
  on points_ledger_entry (shop_domain, created_at desc, id desc);
