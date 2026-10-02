# START HERE — what it takes to launch this, and in what order

> Read this first. It answers one question: **what is actually needed to start?**

> **2026-10-01 — validation gate explicitly waived by the owner.** Per `CLAUDE.md`'s standing
> rule, the build was not started silently: the gate was raised as a direct question and the
> owner chose "waive the gate, build anyway" (session decision, recorded here). Implementation
> proceeds local-first (no Partner account yet — full codebase + test suite against mocks; real-
> store verification deferred until an account exists). The kill test below is **still the top
> go-to-market priority** — waiving it changes the build order, not the risk it measures. Two
> further decisions made the same day: v1 POS offline handling = disable-redemption-when-offline
> (TECHNICAL-SPEC §7 resolved toward the simpler option), and v1 redemption rail = discount-based
> as spec'd (store-credit rail stays a spike for when a dev store exists).
>
> **2026-10-02 — v1-scope rule explicitly lifted by the owner.** The v1 non-goals (channel-scoped
> earning rules, VIP tiers, referrals, giveaway/point-award tooling) were confirmed as an
> intentional scope change in a direct question-and-answer and implemented as the v1.x/v2 roadmap
> phases. `PRODUCT-SPEC.md`'s non-goals list stays as the historical record of what v1 deferred.

**Where this repository stands.** Nothing has been built. The idea has been through desk
research and a passed kill test (see `PRODUCT-SPEC.md`), but no code exists, no Shopify Partner
account has been created for this app, and — the single largest open risk — **no real customer
has confirmed they'd pay for this.** A full re-verification on 2026-10-01 (round 96) confirmed
the baseline still holds: all three named reviewers below are still live and unresolved, the key
community thread is still accumulating replies into 2026, and no incumbent has shipped a fix.

## 0. One cheap check to run alongside the outreach below (round 95, 2026-09-18)

Before sending the outreach in step 1, install Joy Loyalty and Love Loyalty Points & Rewards on a
throwaway dev store and test their marketed in-store/POS redemption claims hands-on. Two
independent market re-checks (round 95 and its §7 cross-check) found both apps already advertise
this, untested by any research pass so far — see `PRODUCT-SPEC.md`'s spike 0 and
`round-95-market-verification-independent.md`. It doesn't change the outreach question below (the
three reviewers are already stuck on Appstle/BON specifically), but it matters before any messaging
claims "no loyalty app solves this" more broadly.

## 1. The one thing that has to happen before any build spend

Contact the specific, dated, named reviewers who are still stuck on a competitor's broken
POS-sync, and ask a recalled-behaviour question, not a stated-intent one:

- **OntarioVape Orleans** (Appstle, POS outage lasted 3 days, still active as of August 2026)
- **William Glen** (BON, sales-channel-filter gap, unresolved since 2024)
- **Tulsa Body Jewelry** (BON, refund-reversal bug, 2025-06-23)

Ask: *is the problem still live for you, and would you switch for a fix at $39-49/mo?*

**Pass = ≥2 confirm.** This is a $0 test that only a real identity can run — it requires posting
as yourself, not as this project. If it fails, the idea dies here, cheaply, per the prime
directive of the research project this came from: a well-argued kill costs minutes, a build
without one costs months.

## 2. What you need to actually build, once the test passes

- A **Shopify Partner account** (free) and acceptance of the Partner Program Agreement, plus a
  **one-time $19 USD App Store registration fee** per Partner account (round 96 correction —
  earlier rounds said "no fee"; it's one-time, not per-submission or recurring).
- **Payout/tax details** set up for Shopify Payments-linked revenue share (100% of the first
  $1M/year gross app revenue, 85% above that, plus Shopify's standard 2.9% payment-processing
  fee — confirmed directly from `shopify.dev` as of 2026-09-17).
- A **development store** (free, via the Partner account) to build and test against — this is
  where the two unresolved technical spikes get answered:
  1. Time an `orders/paid` webhook fired by a POS-originated test transaction against one fired
     by an online test transaction, to confirm comparable latency.
  2. Build and test the offline-POS double-spend handling (atomic backend decrement, reject a
     race-losing second redemption) against a deliberately induced offline/reconnect scenario on
     a real POS test device.
- **~11-14 weeks of solo full-time build time** (see `PRODUCT-SPEC.md` → Estimation for the
  phase breakdown), inside a **$100-500 cash budget** (domain ~$12/yr; no security-audit fee; no
  DPA/SOC2 burden — this app never holds third-party PII at a scale that triggers enterprise
  trust requirements).

## 3. What's already de-risked, so you don't re-litigate it

- **The submission gate is cheap and self-serve** — a one-time $19 registration fee (round 96
  correction), no per-submission fee, no mandatory third-party security audit, confirmed directly
  from Shopify's current app-store-requirements docs (re-confirmed 2026-10-01).
- **The core technical differentiator is buildable** — Shopify's own POS UI Extensions docs name
  "loyalty program integration" as an explicit worked example for the Customer Details target.
  This was the riskiest assumption in the whole idea and it came back "yes, and here's the
  documented pattern," not "unclear."
- **The competitive wedge is independently confirmed three separate ways**, not inferred from a
  single bad review — see `PRODUCT-SPEC.md` → Validation status for the dated quotes.

## 4. What is still genuinely unresolved

- No install or paying-customer count exists anywhere on the Shopify App Store — review count is
  the only public demand proxy, permanently. All revenue scenarios in `PRODUCT-SPEC.md` are
  price-ladder-times-plausible-count models, not measurements.
- No second-listing / portfolio candidate survived a dedicated search (round 93 in the source
  project) — this is a single-listing bet until v1 ships and its own users signal what's next.

**So the blocker is not code and it is not money. It is one thing only a real person can supply:
three conversations.**
