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
> (2026-09-18) that mostly confirms round 94 but found one real gap: Joy Loyalty already markets a
> POS loyalty extension, untested by either round — see `PRODUCT-SPEC.md`'s spike list. `CLAUDE.md`
> has the standing engineering/workflow rules for anyone (or any Claude session) picking this up.

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

Not yet — no code exists. See `docs/START-HERE.md` for what has to happen before there's a
`pnpm install` step worth writing.

## Repo layout (planned, per the dossier's Technical architecture)

```
packages/ledger          the append-only points ledger — no platform dependencies
packages/shopify-backend  webhook ingestion (orders/paid, refunds/create), the authoritative service
apps/checkout-extension   Shopify Function (discount) + Checkout UI extension
apps/pos-extension        POS UI extension, Customer Details target
docs/                     PRODUCT-SPEC.md (the dossier), START-HERE.md, TECHNICAL-SPEC.md (schema,
                          webhook contracts, write path), PRODUCT-PERSPECTIVES.md, round-*.md
```

Nothing under `packages/` or `apps/` exists yet — this is the intended shape, not the current
state.
