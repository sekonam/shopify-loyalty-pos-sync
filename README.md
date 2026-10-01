# shopify-loyalty-pos-sync

A loyalty/rewards app for the Shopify App Store, differentiated on one specific, verified defect
in every major incumbent: a reward earned or issued online does not reliably and correctly
redeem — and decrement the customer's balance — at a physical Shopify POS register, and vice
versa. Confirmed independently across dated reviews of the three largest incumbents (Smile.io,
BON, Appstle) and a 7-month `community.shopify.com` thread where an outside merchant states
plainly that "all the popular loyalty apps... fail to do this."

> **Nothing has been built yet.** This repo is the target for the idea validated in
> [`idea-lab`](../idea-lab)'s `ideas/15-shopify-loyalty-pos-sync.md` — a full dossier with the
> kill test, competitor evidence, and technical spikes already run against Shopify's own docs.
> `docs/PRODUCT-SPEC.md` is that dossier, copied in for reference. `docs/START-HERE.md` says what
> it actually takes to start. `docs/PRODUCT-PERSPECTIVES.md` is an independent second opinion on
> the dossier — where it holds up and where the go-to-market read should change.
> `docs/round-95-market-verification-independent.md` is a second-pass competitor/market re-check
> (2026-09-18, extended with a third independent pass in its §7) that mostly confirms round 94 but
> found a real gap: Joy Loyalty and Love Loyalty Points & Rewards already market in-store/POS
> redemption, untested by any research pass — see `PRODUCT-SPEC.md`'s spike list.
> `docs/round-96-refresh-2026-10-01.md` re-verified the whole baseline two weeks later: it holds
> (one correction — a one-time $19 App Store registration fee), demand signals strengthened, and
> a new open question was added (native store credit as the redemption rail). `CLAUDE.md` has
> the standing engineering/workflow rules for anyone (or any Claude session) picking this up.

**Current score:** P(≥$1,000 MRR by month 12) ≈ 8-10% — passed a real kill test against primary
evidence (three independent incumbents, one 7-month community thread) but has never had a
customer conversation. That conversation, not more code or research, is the next step.

## The wedge, in one paragraph

Shopify POS and online checkout are two separate integration surfaces sharing one customer. Every
loyalty app checked gets the sync between them wrong in production — broken redemption at POS,
unreversed refunds, silent balance drift — not because it's undocumented (Shopify's own POS UI
Extensions docs name "loyalty program integration" as a worked example) but because a correct
implementation needs two real front-end integrations against one race-safe backend ledger, and
that's genuine engineering discipline that slips under normal feature-delivery pressure. The v1
scope is exactly that: get the ledger right, everywhere, before anything else.

## Quick start

```sh
pnpm install
pnpm test        # 99 tests; the Postgres suite needs Docker (SKIP_PG_TESTS=1 to skip)
pnpm typecheck
```

Run the backend locally: copy `.env.example` to `.env`, point `DATABASE_URL` at a Postgres,
then `pnpm --filter @loyalty/shopify-backend dev` (migrations apply on boot; the embedded admin
is at `/admin`).

**Built 2026-10-01, local-first** (owner waived the validation gate — recorded in
`docs/START-HERE.md`): the full v1 codebase exists with tests, but has never run against a real
Shopify store. What still needs a Partner account: creating the app (`shopify app config push`
with the real `client_id` in `shopify.app.toml`), building the Function wasm + deploying the
extensions (`shopify app deploy`), the managed-install token exchange, and the dev-store spikes
in `docs/PRODUCT-SPEC.md` (webhook latency, real-POS offline behavior, incumbent POS testing).

## Repo layout

```
packages/ledger           the append-only points ledger — no platform dependencies; the
                          InMemoryLedgerStore is the executable spec for the SQL store
packages/shopify-backend  the authoritative service: webhook ingestion (orders/paid,
                          refunds/create, GDPR trio), atomic redemption API, reconciliation
                          job + scheduler, embedded admin page
apps/checkout-extension   discount Function (unified Discount API) + checkout UI block
apps/pos-extension        POS UI extension (customer-details block + redeem action),
                          disable-when-offline
docs/                     PRODUCT-SPEC.md (the dossier), START-HERE.md, TECHNICAL-SPEC.md,
                          PRODUCT-PERSPECTIVES.md, round-*.md
```
