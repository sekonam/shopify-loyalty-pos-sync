# CLAUDE.md — instructions for working in this repo

This file is for any Claude Code session (or human) picking up work here. Read it before writing
code or editing the docs below. It does not repeat what's already said well elsewhere — it points
to it.

## Read first, in this order

1. `docs/START-HERE.md` — what actually has to happen before build spend, and in what order.
2. `docs/PRODUCT-SPEC.md` — the full dossier: validation status, market analysis, product
   requirements, architecture, estimation, roadmap.
3. `docs/PRODUCT-PERSPECTIVES.md` — independent product judgment layered on top of the dossier:
   what I'd push back on, what's missing, and concrete additions to the wedge.
4. `docs/round-*.md` — the underlying research rounds the dossier cites. Only dig into these if
   you need a primary source the dossier's summary doesn't give you.

## The one standing rule: do not let "let's build" skip validation

Per `START-HERE.md`, **no customer conversation has happened yet.** The dossier's own kill-test
rule is that a well-argued kill costs minutes and a build without one costs months. If a future
session (or the human) asks to start full implementation — scaffolding the backend, writing the
POS extension, etc. — before `START-HERE.md`'s "pass = ≥2 confirm" test has been run and recorded,
say so explicitly and ask for confirmation it happened, rather than silently proceeding. Docs,
research, spikes against Shopify's own documentation, and throwaway dev-store experiments are all
fine to do regardless — it's *production build effort* that's gated.

## Repo shape (planned — see README.md, not yet built)

```
packages/ledger           append-only points ledger, no platform dependencies
packages/shopify-backend  webhook ingestion (orders/paid, refunds/create, mandatory GDPR webhooks),
                           the authoritative service both extensions call
apps/checkout-extension   Shopify Function (discount) + Checkout UI extension
apps/pos-extension        POS UI extension, Customer Details target
docs/                     PRODUCT-SPEC.md, START-HERE.md, PRODUCT-PERSPECTIVES.md, research rounds
```

A pnpm workspace monorepo is the natural fit for this shape (shared TS types between the ledger
package and both extensions matter — a `PointsLedgerEntry` type drifting between the backend and
an extension is exactly the class of bug this app exists to not have). Use `pnpm`, not `npm`/`yarn`,
once a package manager choice is needed — smaller node_modules footprint across many small
workspace packages, and it's Shopify CLI's own default for scaffolded apps.

## Non-negotiable architecture invariants

These come directly from `PRODUCT-SPEC.md`'s Product requirements / Technical architecture
sections. Do not "simplify" these away under delivery pressure — that's the exact failure mode
the whole product exists to avoid in incumbents:

- **The ledger is append-only.** Balance is always `SUM(delta) WHERE customerId = ?` at query
  time, never a mutable integer column. A redemption, refund reversal, or manual adjustment is a
  new row, never an UPDATE of a balance field.
- **Every ledger entry is channel-tagged** (`sourceName`: `web` | `pos` | `mobile_app`), taken
  from the `Order` object, not inferred.
- **Redemption writes must be atomic**, not read-then-write — this holds regardless of how offline
  handling is scoped below. **How offline POS redemption itself is scoped is an open design
  question, not settled** — see `docs/TECHNICAL-SPEC.md` §7 and `docs/PRODUCT-PERSPECTIVES.md` for
  two live options (support queued-offline redemption with reject-on-reconnect-conflict, vs. the
  simpler "disable redemption entirely while the POS can't reach the backend live"). Resolve this
  during the spike phase with real data, don't default to the more complex option out of habit.
- **Two front-end integration surfaces (checkout Function + POS extension), one backend.** Do not
  let either surface grow its own notion of balance or its own write path — every mutation goes
  through the shared ledger service.
- **Webhooks are not trusted as the sole source of truth.** `orders/paid` and `refunds/create`
  drive real-time updates, but Shopify webhooks can be delayed or dropped in practice. Build a
  periodic reconciliation job (poll the GraphQL Admin API for orders/refunds since last checkpoint
  and diff against the ledger) as defense-in-depth from day one, not as a v2 nice-to-have — this is
  cheap to add now and expensive to retrofit once the ledger has real customer balances in it.
- **Mandatory GDPR compliance webhooks are a submission requirement, not optional**:
  `customers/data_request`, `customers/redact`, `shop/redact` must be implemented even though this
  app's PII footprint is small — Shopify's app review checks for these regardless of scale.

## v1 scope discipline

`PRODUCT-SPEC.md`'s "Explicit v1 non-goals" list is deliberate, not an oversight: no referral
program, no VIP/tiered programs, no sales-channel-scoped earning filters, no giveaway mechanics,
no deep theme/CSS customization. If a session is asked to add one of these, point back to that
list and confirm it's an intentional scope change before building it — these were cut specifically
to keep the wedge provable before general feature-building starts.

## Tech stack notes

- **GraphQl Admin API only.** REST is deprecated for new public-app submissions (enforced since
  April 2025 per the dossier). Don't scaffold against REST examples found in older tutorials.
- **Shopify CLI (`@shopify/cli`)** is the standard scaffold/dev tool — `shopify app init`, `shopify
  app generate extension` for both the POS UI extension and the checkout Function. Confirm current
  major version before scaffolding (`npm view @shopify/cli version`) — don't assume a version from
  training data without checking, this platform moves fast.
- **TypeScript everywhere.** The whole point of the shared `packages/ledger` types is to make a
  channel-tagging or reason-enum mismatch a compile error, not a production bug discovered via a
  bad review — don't let any surface fall back to loose JS.

## MCP servers for this repo

- **Shopify Dev MCP** — verified against `shopify.dev/docs/apps/build/devmcp` on 2026-09-18:
  `claude mcp add --transport stdio shopify-dev-mcp -- npx -y @shopify/dev-mcp@latest`. Runs
  locally, no authentication required. Exposes developer-doc/API-schema lookup, GraphQL
  query/Liquid/Extension code validation, and (via authenticated Shopify CLI) store management.
  Add this before starting real implementation — it replaces manual `shopify.dev` WebFetch
  round-trips with schema-accurate answers. Re-verify the command if it's been more than a few
  months since 2026-09-18; this tooling is young enough to still be churning.
- **GitHub**: Claude Code's built-in `gh` CLI access covers standard PR/issue workflows already —
  don't add a GitHub MCP server on top of that unless a specific gap shows up (e.g. needing
  structured PR review comment data an MCP server exposes that `gh api` doesn't conveniently).
- **Postgres MCP** (or equivalent for whatever DB is chosen for the ledger), once the backend
  exists — for schema introspection and query debugging during ledger/webhook development. Not
  needed before there's a real database to point it at.

Don't add MCP servers speculatively. Each one is something a future session has to trust; add one
when a concrete task needs it, not because it might be handy.

## Skills relevant to this repo

- **`run`** — once there's an app to launch, use this to actually start the dev server / Shopify
  CLI dev process and confirm behavior, rather than reasoning about whether code "should" work.
- **`browser-automation`** / **`claude-in-chrome`** — for verifying the checkout UI extension and
  admin surfaces render and behave correctly against a real dev store, not just unit tests.
- **`code-review`** — run before merging any nontrivial change, especially anything touching the
  ledger write path or offline-conflict logic, given how easy this exact class of bug is to get
  wrong (that's the entire market thesis).
- **`security-review`** — run before submission and after any change to OAuth scopes, webhook
  verification, or the GDPR compliance webhooks. This app's blast radius is small but a loyalty
  ledger is still real customer value (points ⇒ money-equivalent) — treat balance-mutation paths
  with the same care as a payments path.

## Workflow

- **Commit at each logical step**, not in one giant batch — a schema change, a webhook handler, an
  extension scaffold, a doc update are each their own commit. This repo is solo-maintained; small
  commits are the only review trail that will ever exist.
- **Push after each commit** unless told otherwise — `origin/main` is the backup and the record,
  and there's no branch-protection/PR workflow set up yet to make holding commits locally useful.
- Never force-push `main`. Never commit `.env`, Shopify API secrets, or a database URL — `.gitignore`
  already excludes `.env*` and `.shopify/`; keep it that way if either directory structure changes.
- Prefer small, real commits over "WIP" — if a step isn't done enough to describe in one line, it
  isn't done enough to commit yet either.
