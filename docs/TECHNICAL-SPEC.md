# Technical specification (v1)

This is the implementable layer under `PRODUCT-SPEC.md`'s Technical architecture section — actual
schemas, webhook contracts, and extension surfaces, not a sketch. Nothing here has been built or
tested against a real dev store yet; treat field names/types as a starting draft to validate
against Shopify's current GraphQL Admin schema during the spike phase, not as frozen.

## 1. Data model

```sql
-- Append-only. No UPDATE ever touches `delta` on an existing row. Balance is always derived.
create table points_ledger_entry (
  id              uuid primary key default gen_random_uuid(),
  shop_domain     text not null,               -- tenant key; every query is scoped by this
  customer_id     text not null,               -- Shopify Customer GID
  order_id        text,                        -- Shopify Order GID, null for manual adjustments
  refund_id       text,                        -- Shopify Refund GID, null unless reason = 'refund_reversal'
  source_name     text not null check (source_name in ('web', 'pos', 'mobile_app', 'system')),
  delta           integer not null,            -- positive = earn, negative = redeem/reversal
  reason          text not null check (reason in ('earn', 'redeem', 'refund_reversal', 'adjustment', 'reconciliation')),
  redemption_attempt_id uuid references redemption_attempt(id),
  idempotency_key text not null,               -- see §3, prevents double-processing the same webhook
  created_at      timestamptz not null default now()
);
create unique index on points_ledger_entry (shop_domain, idempotency_key);
create index on points_ledger_entry (shop_domain, customer_id, created_at);

-- Balance, always computed, never stored as a mutable field:
--   select coalesce(sum(delta), 0) from points_ledger_entry
--   where shop_domain = $1 and customer_id = $2;
-- Index above makes this cheap; if it ever isn't, add a periodically-refreshed materialized
-- balance cache with a `last_ledger_entry_id` watermark — never a field the write path mutates
-- directly, to keep the offline-race invariant a property of the write path, not the cache.

create table redemption_attempt (
  id                uuid primary key default gen_random_uuid(),
  shop_domain       text not null,
  customer_id       text not null,
  channel           text not null check (channel in ('web', 'pos')),
  requested_points  integer not null,
  status            text not null check (status in ('applied', 'rejected_insufficient_balance', 'rejected_stale_offline_state', 'pending')),
  pos_device_id     text,                      -- for offline-race debugging, POS-originated only
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);

create table shop_settings (
  shop_domain       text primary key,
  earn_rate         numeric not null default 1,   -- points per $1 spent
  redemption_rate   numeric not null default 100,  -- points per $1 of discount
  min_redemption    integer not null default 100,
  installed_at      timestamptz not null default now(),
  uninstalled_at    timestamptz
);

create table webhook_receipt (
  id                uuid primary key default gen_random_uuid(),
  shop_domain       text not null,
  topic             text not null,
  webhook_id        text not null,             -- Shopify's X-Shopify-Webhook-Id header
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  payload_hash      text not null
);
create unique index on webhook_receipt (shop_domain, webhook_id);
```

**Why `redemption_attempt` is a separate table from the ledger entry it produces:** an attempt can
be rejected and produce no ledger entry at all. Keeping rejections queryable is what makes the
offline-race behavior debuggable — the exact category of problem ("scripted responses... rather
than troubleshooting") that turned a competitor's bug into a three-day outage per the dossier.

## 2. Webhook contracts consumed

| Topic | Trigger | Ledger effect |
|---|---|---|
| `orders/paid` | Any paid order, any channel | One `earn` entry: `delta = floor(order.totalPrice * earn_rate)`, `source_name = order.sourceName` |
| `refunds/create` | Any refund, any channel | One `refund_reversal` entry per affected order: `delta = -floor(refundedAmount * earn_rate)`, capped so a customer's balance can't go negative from a reversal alone (see §4) |
| `app/uninstalled` | Merchant uninstalls | Mark `shop_settings.uninstalled_at`; retain ledger per GDPR data-retention terms, don't delete on uninstall alone |
| `customers/data_request` | Mandatory GDPR compliance webhook | Export that customer's ledger entries |
| `customers/redact` | Mandatory GDPR compliance webhook | Redact PII fields; ledger `delta`/`reason`/dates may be retained if aggregate-only, per current Shopify redaction guidance — confirm exact requirement against current docs before implementing, this is a compliance-critical detail not to build from memory |
| `shop/redact` | Mandatory GDPR compliance webhook, 48h after uninstall | Full tenant data erasure |

All webhook handlers: verify HMAC signature first, then check `webhook_receipt` for the
`X-Shopify-Webhook-Id` header before processing (Shopify's own docs note webhooks can be delivered
more than once) — this table is the idempotency guard, separate from the ledger's own
`idempotency_key` uniqueness, because a redelivered webhook must be a no-op at the receipt layer,
not rely on the ledger's constraint to silently swallow the duplicate.

## 3. Idempotency key construction

- `orders/paid` → `idempotency_key = 'order_paid:' || order.id`
- `refunds/create` → `idempotency_key = 'refund:' || refund.id`
- POS redemption write → `idempotency_key = 'redemption:' || redemption_attempt.id` (the attempt
  ID is generated client-side by the POS extension at the moment the staff member confirms the
  redemption, so a retried network call after a timeout can't double-apply)
- Reconciliation job corrections → `idempotency_key = 'reconcile:' || order.id || ':' || run_id`

## 4. Redemption write path (the atomic, reject-on-conflict core)

```
BEGIN transaction, isolation level SERIALIZABLE (or SELECT ... FOR UPDATE on a per-customer row lock)
  balance := SELECT SUM(delta) FROM points_ledger_entry WHERE customer_id = $1
  IF requested_points > balance:
    INSERT redemption_attempt (status = 'rejected_insufficient_balance')
    ROLLBACK, return 409 to caller
  ELSE:
    INSERT points_ledger_entry (delta = -requested_points, reason = 'redeem', ...)
    UPDATE redemption_attempt SET status = 'applied', resolved_at = now()
    COMMIT
    return 200 with new balance to caller
```

The offline case: a POS terminal caches the balance it last saw and lets staff queue a redemption
while offline. On reconnect, the queued write replays through this exact path — if the balance has
since dropped below what's needed (an online redemption cleared it first), the write is rejected
with `rejected_stale_offline_state`, and the POS extension must show "can't confirm balance,
reconnect and retry" rather than silently accepting the queued action as if it succeeded. This is
the one behavior that most needs a real POS-device test before it ships — a transaction-level
guarantee on the backend is necessary but not sufficient if the extension's offline-queue UX
doesn't communicate the rejection correctly to staff.

## 5. Reconciliation job

Runs on a schedule (start with hourly; tune after real webhook-delivery data exists). For each
installed shop: query the GraphQL Admin API for orders/refunds updated since the last checkpoint,
diff against `points_ledger_entry` by `order_id`/`refund_id`, and insert any missing entries with
`reason = 'reconciliation'` and a `reconcile:` idempotency key so it can never double-apply
alongside a webhook that arrives late. This is the defense-in-depth `CLAUDE.md` names as a day-one
requirement, not a v2 addition — a dropped `orders/paid` webhook should self-heal within one
reconciliation cycle, not require a support ticket.

## 6. Extension surfaces

**POS UI extension** (`pos.customer-details.block.render` + `pos.customer-details.action.render`
targets, per Shopify's documented pattern for this exact use case):
- Block: read-only balance display, fetched from the backend on render, with a visible
  "last confirmed <timestamp>" / "offline — showing cached balance" state distinction — never show
  a stale number as if it were live.
- Action: redemption flow — staff enters a points amount (or selects a preset), extension calls the
  backend's redemption endpoint, applies the returned discount to the current POS cart via the Cart
  API, and reflects `applied` / `rejected_*` status back to staff immediately.

**Checkout (Shopify Function + Checkout UI extension):**
- Function: a discount-type function that reads a redemption request (points amount encoded as a
  cart/checkout attribute set by the UI extension) and applies the equivalent discount — validated
  server-side against the same backend redemption endpoint the POS action calls, so there is truly
  one write path, not two.
- UI extension: balance display + redemption input on the checkout page, calling the same backend
  endpoint pattern as the POS action for consistency.

**Admin (embedded app, Remix template or current Shopify-recommended equivalent):**
- Settings: earn rate, redemption rate, minimum redemption threshold.
- Ledger view: per-customer entry history (for support/debugging), CSV export.
- Reconciliation status: last run time, entries corrected, for merchant-visible trust-building
  ("this app checks itself") — a direct product expression of `PRODUCT-PERSPECTIVES.md`'s
  reconciliation-as-marketing point.

## 7. Open questions to resolve during the spike phase, not before

- Exact GDPR redaction requirements for ledger rows (§2) — confirm against current
  `shopify.dev` docs, this is compliance-critical and platform requirements can change.
  Note that both round 94 and round 95 confirmed the current Shopify billing/review-process terms
  directly from primary docs — do the same for the compliance-webhook requirements before
  implementing, rather than relying on this draft.
- Whether `SELECT ... FOR UPDATE` per-customer row locking or full `SERIALIZABLE` isolation is the
  right choice depends on the actual DB and expected concurrent-redemption volume per customer
  (almost certainly low — a customer is rarely mid-redemption on two channels simultaneously
  outside the deliberate offline-race test) — don't over-engineer this before the offline-race spike
  gives real data on how contested this path actually is.
- Materialized balance cache (§1) — only add if the `SUM(delta)` query actually shows up as a
  bottleneck under real load; don't build it speculatively.
