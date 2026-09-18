# Shopify App Store — Loyalty & Rewards for POS-Heavy Retailers

## Summary

A loyalty/rewards app for the Shopify App Store, differentiated on one specific, verified defect
in every major incumbent: a reward earned or issued online does not reliably and correctly
redeem — and decrement the customer's balance — at a physical Shopify POS register, and vice
versa. This is not a hypothesis; it is independently confirmed in dated, human-authored reviews
of the three largest incumbents (Smile.io, BON, Appstle) and in a 7-month community thread where
an outside merchant states plainly that "all the popular loyalty apps... fail to do this." The
niche clears this project's own concentration bar (top-3 by reviews ≈54%, comparable to the
"Room" example in CLAUDE.md's own table) and has a real price-ceiling lever — order-volume-gated
tiers reaching $100-199+/month — that WooCommerce's identical niche structurally lacks. This
round confirmed the submission gate is cheap and self-serve (no fee, no mandatory security audit,
0% revenue share on the first $1M/year), confirmed the core technical differentiator is buildable
using Shopify's own documented POS UI Extension and Checkout Function APIs (not blocked the way
several other ideas in this repo were), and pulled a larger review sample to convert "POS sync is
broken" into a concrete, ranked v1/v2 feature backlog.

**Score: P(≥$1,000 MRR by month 12) ≈ 8-10%** — held at round 88's post-kill-test estimate. This
round found no new fact strong enough to move it either direction: the submission and billing
terms are confirmed favorable (a mild, non-decisive positive), and the POS-sync spike is confirmed
technically feasible but genuinely nontrivial — a concrete mechanical explanation for why funded
incumbents still get it wrong, not a green light. See Validation status.

---

## Validation status

### PROVEN

- **The core defect is real, current, and independently confirmed three ways** (round 88):
  dated 1-3★ reviews on Smile.io, BON, and Appstle each describe a POS/omnichannel-redemption
  failure in their own words, and an outside merchant's 7-month `community.shopify.com` thread
  (`/t/loyalty/329812`, opened June 2024, still active January 2025) states unprompted that every
  popular loyalty app fails at exactly this integration surface. **This round added a fourth,
  independent account** (Dream Nu, Smile.io, 2025-10-28: "Tried to use for consignment and POS,
  spent hours trying to get it to work") and sharpened a fifth (OntarioVape Orleans's Appstle
  outage lasted three days, with the vendor's own stated resolution SLA quoting "up to 48 hours"
  even after escalation) — the pattern is not a one-off bug report, it recurs across every
  incumbent checked, at increasing levels of operational severity.
- **Vendor-level concentration holds at 54.1%, unchanged from the app level** (round 88) — no
  Appfire-style roll-up hiding underneath the top three (Smile, BON, Joy are each effectively
  single-product vendors). The niche clears CLAUDE.md's round-28 bar (leader <40%, top-3 <60%).
- **The submission gate is confirmed cheap and self-serve** (this round, direct fetch of
  `shopify.dev/docs/apps/launch/...`): no submission fee anywhere in the requirements docs, no
  mandatory third-party security audit (self-attested TLS/OAuth/minimal-scopes hygiene only,
  unlike Salesforce's $999 AppExchange security review), and a resubmission path with no stated
  fee or cooldown. This is Atlassian-shaped, not Salesforce-shaped.
- **Revenue share confirmed directly** (this round, `shopify.dev/docs/apps/launch/distribution/
  revenue-share`): developers keep **100% of the first $1,000,000 USD in gross app revenue per
  year** (since Jan 1, 2025), **85% above that** (i.e. 15% Shopify take past $1M/yr) — plus a
  standard 2.9% payment-processing fee on all billing. The $1M band is **annual**, not lifetime
  like Atlassian's Forge terms — moot at this candidate's target scale, but confirmed more
  generous on that specific axis, not less.
- **The core technical differentiator is buildable, confirmed against Shopify's own
  documentation, not assumed** (this round, direct fetch of `shopify.dev/docs/api/pos-ui-
  extensions*` and `.../apps/build/{pos,discounts}`): Shopify's own POS UI Extensions docs name
  **"loyalty program integration"** as an explicit use case for the Customer Details extension
  target, and give a worked example of "displaying loyalty status via authenticated requests to
  your backend service" — confirming the correct architecture (a backend-authoritative ledger,
  with POS and checkout as thin real-time clients) is the one Shopify itself documents. The POS
  Cart API supports applying discounts; the `Order` GraphQL object carries a `sourceName` field
  (`web`/`pos`/`mobile_app`) so every transaction is attributable regardless of channel; Shopify
  Functions provide the equivalent redemption-as-discount mechanism for online checkout.
- **A larger review pull (this round) converts the POS finding into a ranked, sourced v1/v2
  backlog** rather than a single headline bug — see Product requirements. New items found beyond
  round 88: refund/return point-reversal is separately broken on BON ("the rewards points still
  have not been refunded five hours later" — Tulsa Body Jewelry, 2025-06-23), a dated
  "Refer-a-Friend" redirect bug (Brewing Beauty Co., BON, 2026-06-02), and a mobile-checkout-
  button UI collision (Trail Threads Co., BON, 2024-07-12) — plus a second confirmed instance of
  the sales-channel-filtering gap (William Glen) already found in round 88.
- **Central-principle answer is now mechanical, not just observed.** Round 88 established that
  even well-resourced incumbents get this wrong in production; this round found the concrete
  reason in Shopify's own docs: checkout and POS discount logic are described as **two distinct
  integration surfaces**, not one Function reused twice, so a correct implementation requires two
  separate front-end integrations against one shared, race-safe backend ledger — real,
  double-the-surface engineering discipline, exactly the kind of thing that goes wrong under
  normal feature-delivery pressure at a multi-product company (Appstle, Smile) or gets deprioritized
  at a smaller one (BON/VEGAHUB).

### ASSUMED / unresolved

- **No revenue or paying-customer data exists anywhere on the Shopify App Store** — review count
  is the only public demand proxy, same permanent gap CLAUDE.md already documents for this
  ecosystem. All customer-count-to-MRR modelling below is a price-ladder-times-plausible-count
  model, not a measurement.
- **No customer conversation has occurred.** Per this project's own rule, only a real conversation
  can move this score further — the round 88 cheapest-next-step (contact dated reviewers still on
  a competitor) has not been run.
- **Real-time webhook latency for POS-originated orders is unconfirmed from documentation alone.**
  The `Order` object's `sourceName` field proves POS orders are ordinary `Order` objects, which is
  a strong structural reason to expect `orders/paid` to fire with comparable latency to online
  orders — but no doc page fetched this round stated this explicitly. Named as the cheapest
  remaining spike (a throwaway test-store POS transaction, timed against webhook receipt).
- **Offline-POS double-spend risk is a new design requirement this round identified, not yet
  resolved in an implementation.** Shopify POS terminals can queue transactions offline; a
  redemption applied offline against a stale cached balance, followed by a second redemption
  online before reconnection, could double-spend the same points. The fix (atomic backend
  decrement, explicit "can't confirm — reconnect" POS-side state) is a standard distributed-state
  pattern, not a novel unsolved problem, but it has not been built or tested.
- **No stated review-timeline SLA exists in Shopify's current official docs**, checked directly
  three pages deep. This project's own working assumption (2-4 weeks, from PLAYBOOK.md) is not
  contradicted by anything found, just not independently reconfirmed from a dated primary source
  this round — carried forward as ASSUMED.
- **Payout frequency, currency, and minimum threshold** were not found in the billing docs fetched
  — ASSUMED unremarkable (comparable to Atlassian/monday's ~30-day-after-qualifying-month
  mechanics), not confirmed.
- **Portfolio/second-listing angle checked and found empty** (round 93): no independent second
  Shopify category survives as a build-reuse candidate. Referrals specifically should be scoped
  as a v1.x/v2 *feature* of this app (see Product requirements), not a second Marketplace
  submission — and this round's review mining adds a concrete bug (the broken post-login
  redirect) to avoid when it's built.

### The cheapest kill test — the one this round could not run

Unchanged from round 88, and still the single highest-leverage next step, at $0: **contact the
specific dated reviewers still on a competitor** — OntarioVape Orleans (Appstle, POS outage,
still active as of August 2026), William Glen (BON, sales-channel-filter gap, unresolved since
2024), and now also Tulsa Body Jewelry (BON, refund-reversal bug, 2025-06-23) — and ask a
recalled-behaviour question: is the problem still live, and would they switch for a fix at
$39-49/mo. **Pass = ≥2 confirm**, the same bar this project set for monday.com's own equivalent
test.

---

## Market analysis

**TAM / SAM.** No install-count field exists on Shopify (confirmed, permanent gap). Review count
is the demand proxy: the loyalty/rewards niche's visible top ~22 apps sum to ≈15,343 reviews,
with a long tail estimated at ~250-380 total dedicated listings (round 85's own ~40-app estimate,
corrected upward ~6× by a disclosed-conflict-of-interest but directionally useful third-party
figure cited in round 88: 258 genuinely loyalty-shaped apps, 111 of them with zero reviews ever).

**Competitor table** (reviews as of round 85/88's pull; pricing from app-detail static HTML):

| App | Reviews | Price (50-order-equivalent tier or nearest) | Named defect found in reviews |
|---|---|---|---|
| **Smile: Loyalty Program Rewards** | 4,588 | Freemium | Referral/discount-code fraud (12,000+ codes leaked to coupon sites); B2B-transaction conflicts; POS/consignment setup failures (2 independent accounts, rounds 88+94); $199/mo lock-in complaint |
| BON Loyalty Program & Rewards | 1,931 | Free / $15 / $29 / $129/mo, order-volume-gated | **POS redemption doesn't decrement balance** (2023, dated); refund/return points not reversed (2025, dated — new this round); broken Refer-a-Friend redirect (2026, dated — new this round); no sales-channel earning filter (2024, recurring across 2 pulls); mobile checkout-button UI collision (new this round) |
| Joy Loyalty Program Rewards | 1,786 | Freemium | Not reviewed this round (single-product vendor, no portfolio angle) |
| Appstle Loyalty Program Reward | 1,368 | Free / $10 / $30 / $100/mo, order-volume-gated | **POS redemption stopped working outright**, 3-day outage, scripted support, 48hr-quoted SLA even after escalation (2026, dated, sharpened this round); theme/CSS ID conflicts (2025, dated); broken loyalty-list migration (2024, dated) |
| **Kangaroo: Loyalty and Rewards** | 55 | **$199/mo flat, no free tier** | The "won small" existence proof — reviewers explicitly praise POS reliability across 5-7+ year tenures, the opposite experience from the three leaders above |

*Round 95 (2026-09-18, independent re-verification) added two more mid-size competitors not
tracked above: **Rivo** (1,386 reviews, 4.8★, $0/$15/$49/$499/mo) and **Growave** (1,226 reviews,
4.8★, loyalty+reviews+wishlist bundle, Built for Shopify certified). Neither changes the
concentration read materially, but both are large enough to check directly in any future
competitive listing-copy pass. Round 95 also found Joy Loyalty's $129/mo tier explicitly markets a
"POS loyalty extension (in-store rewards)" with QR-code redemption — not hands-on tested by either
round; see round-95's `docs/round-95-market-verification-independent.md` for why this needs a
direct spike before any "no incumbent solves this" claim goes into listing copy or outreach.*

**Price ceiling** (round 85): BON and Appstle both gate paid tiers on **monthly order volume**,
not a flat SaaS fee — the Shopify analogue of Atlassian/monday's per-seat lever, reaching
$100-129/mo before enterprise negotiation. Kangaroo prices its entire product at $199/mo flat.
This beats CLAUDE.md's old flat $9-30/mo row for Shopify generally, for a specific structural
reason (a per-order-volume scaling lever most Shopify categories lack).

**Why now.**
1. Shopify's mandatory-native-billing infrastructure and the order-volume-gated pricing pattern
   are both recent enough (BON/Appstle read as newer entrants by UI convention, though no
   listing-age field exists to date this precisely) that the pricing lever itself is not a stale
   finding.
2. GraphQL-only submission (mandatory since April 2025) means a build started today targets
   Shopify's current API surface with no REST-to-GraphQL migration debt an incumbent carries.
3. The specific defect this app targets is dated as *currently* unresolved — OntarioVape
   Orleans's outage is from August 2026, one month before this dossier.

**Top 3 risks.**
1. **No customer conversation yet** — the largest unresolved risk, named above as the required
   next step before any build spend.
2. **The wedge requires two separate integration surfaces (checkout + POS) against one backend
   ledger, plus an offline-consistency design problem** — confirmed buildable this round, but
   genuinely more build complexity than a single-surface web loyalty app, and the exact reason
   incumbents with real engineering teams still get it wrong. A solo dev inherits the same
   difficulty, not just the opportunity.
3. **Entry-tier pricing math still requires a real customer count.** Even at the recommended
   $39-49/mo entry tier (below the freemium floor other apps compete at, above the commodity
   ceiling), $1k MRR needs roughly 20-25 customers at entry pricing, or fewer at the
   order-volume-gated upper tiers — in the same general range round 85 estimated for the whole
   category, not a materially easier bar than assumed.

---

## Product requirements

**User stories (v1):**
- As a POS-heavy/omnichannel merchant, I want a customer's loyalty points balance to be correct
  and consistent whether they last transacted online or in-store, with no manual reconciliation.
- As register staff, I want to look up a customer's points balance on the POS Customer Details
  screen and apply a points redemption as a discount on the current sale, with the balance
  decremented immediately and correctly — even if I can't currently reach the backend (in which
  case I want the POS to tell me it can't confirm the balance, not show a stale number as if it
  were live).
- As a merchant, I want a customer's points balance to be reversed correctly when an order is
  refunded or returned, regardless of which channel the original sale happened on.
- As a customer, I want to earn and redeem the same points balance online or in the store, with no
  separate "online points" and "in-store points."

**Explicit v1 non-goals** (the durable-kill-test principle — build only what proves the wedge):
- **No referral/refer-a-friend program.** Round 93 already found this is a bundled *feature* of
  successful loyalty apps, not an independent listing — and this round found a concrete bug class
  (BON's broken post-login redirect) to design around when it is eventually built, in v2.
- **No VIP/tiered programs, rule-based tier-entry conditions, or birthday/anniversary rewards.**
  Real, named asks (Christian Weilert's conditional-VIP-entry request, this round) but not the
  core wedge.
- **No sales-channel-scoped earning-rule filters** (William Glen's Amazon-exclusion ask, confirmed
  twice) — real, unmet, and worth prioritizing as the first v1.x feature given it's independently
  requested and unaddressed by every incumbent checked, but not required to prove the core wedge.
- **No giveaway/competition-entry mechanics** (Smile's John Franich Jewellers ask) — v2 at
  earliest.
- **No multi-brand/multi-store unification, no deep theme/CSS customization** beyond a
  deliberately narrow, non-overlapping balance widget — full theme-editor-level customization is
  v2, avoided in v1 specifically to sidestep the Trail Threads Co.-style mobile checkout-button
  collision.

**In v1 scope, not deferred (a correction from a naive "just fix POS" scope):** points-refund
reversal on `refunds/create`. Round 88 read the wedge as "POS redemption sync"; this round's
larger review pull found refund non-reversal is a second, independent occurrence of the *same*
underlying engineering discipline gap (keep the ledger correct across every lifecycle event, not
just the happy-path redemption) — BON's reviewers experience it as a distinct bug, but it is
architecturally the same problem the wedge already targets, and skipping it in v1 would leave an
obvious, easily-tested hole a reviewer or early customer would find immediately.

**Data model (sketch):**
`PointsLedgerEntry {id, customerId, orderId?, refundId?, sourceName ('web'|'pos'|'mobile_app'),
delta, reason ('earn'|'redeem'|'refund_reversal'|'adjustment'), createdAt}` — an append-only
ledger, balance always derived by summing entries for a customer, never a single mutable
integer field, specifically so the offline/race-safety requirement above ("reject a race-losing
second redemption") is a query-time invariant rather than a field that can silently drift.
`RedemptionAttempt {id, customerId, channel, requestedPoints, status ('applied'|'rejected_
insufficient_balance'|'rejected_stale_offline_state'), createdAt}` — kept specifically to make
the offline-consistency behavior auditable and debuggable, the exact category of problem
("scripted responses... rather than troubleshooting") that turned OntarioVape's bug into a
three-day outage.

---

## Technical architecture

**Platform shape — two integration surfaces, one shared backend, per the confirmed spike
finding above:**
1. **Online checkout:** a Shopify Function (discount type) applying a points-redemption discount,
   plus a Checkout UI extension or theme app extension surfacing the current balance to the
   customer.
2. **Shopify POS:** a POS UI extension on the **Customer Details** target
   (`pos.customer-details.block.render` for the balance display,
   `pos.customer-details.action.render` for the redemption action), using the documented pattern
   of an authenticated network call to the app's own backend — the exact use case Shopify's own
   docs name for this target.
3. **Backend (authoritative ledger):** a single service both surfaces call. Receives
   `orders/paid` and `refunds/create` webhooks (tagging entries with the order's `sourceName`
   field so every ledger entry is attributable to its origin channel), serves real-time balance
   reads to both extensions, and executes redemption writes atomically to make the offline race
   case fail safely (reject the losing write) rather than silently double-spend.

**API surface confirmed this round, by name:**
- `shopify.dev/docs/api/pos-ui-extensions` — `pos.customer-details.*` targets, Cart API
  (`apply discounts... manage cart properties`), authenticated-fetch-to-own-backend pattern.
- `shopify.dev/docs/apps/build/discounts` — Shopify Functions for checkout-side custom discount
  logic.
- GraphQL Admin API `Order` object — `sourceName`, `app`, `publication`, `sourceIdentifier`.
- Mandatory GraphQL Admin API only for new public apps (REST deprecated as a submission path
  since October 2024, GraphQL-only enforced since April 1, 2025) — a real constraint on which API
  client library/tooling to build against from day one, not optional.

**Monetization:** Shopify Billing API, order-volume-gated recurring plans (the BON/Appstle
pattern) rather than a flat SaaS fee, since the order-volume lever is this niche's specific
advantage over WooCommerce's flat-pricing ceiling.

**Spikes, in priority order (the riskiest unknowns first, per PLAYBOOK Stage 2):**
0. **Added round 95, ahead of everything else because it's cheap and gates the positioning claim:**
   install Joy Loyalty (and re-check Appstle) on a throwaway dev store, exercise POS earn +
   redeem, and confirm whether Joy's marketed "POS loyalty extension (in-store rewards)" actually
   works reliably. Round 95 found this claim exists in Joy's marketing but neither round tested it
   hands-on — see `round-95-market-verification-independent.md`. Blocks any listing copy or
   outreach message asserting "no incumbent solves this."
1. **Confirmed this round, not a spike any more:** can a POS UI extension read/write a
   backend-hosted loyalty balance and apply it as a live discount? **Yes — Shopify's own docs
   name this exact use case.** Retained here only to record that it moved from "spike" to
   "confirmed" this round.
2. **Remaining, cheapest first:** time an `orders/paid` webhook fired by a POS-originated test
   transaction against one fired by an online test transaction on the same dev store, to confirm
   comparable latency. Named explicitly in this round's research as the cheapest unresolved item.
3. **Offline-POS race condition:** build and test the atomic-decrement-plus-reject-on-conflict
   logic against a deliberately induced offline/reconnect scenario on a real POS test device — the
   design requirement this round identified, not yet implemented or tested.
4. **Refund-reversal correctness:** confirm `refunds/create` fires reliably and quickly enough
   that a merchant doesn't experience BON's "still not refunded five hours later" symptom in this
   app's own implementation.
5. **Checkout Function + POS extension consistency test:** redeem points online, immediately
   check the POS-visible balance reflects it (and vice versa) on the same test store, to validate
   the two-surfaces-one-ledger architecture end-to-end before writing any customer-facing UI
   polish.

---

## Estimation

**Build phases (solo, full-time):**

| Phase | Duration | Output |
|---|---|---|
| Spikes 2-5 above | 1.5-2 weeks | Cross-channel consistency confirmed or the wedge is re-scoped |
| Backend ledger + webhook ingestion (`orders/paid`, `refunds/create`) | 1.5 weeks | Correct, append-only, channel-tagged points accounting |
| Checkout-side redemption (Shopify Function + balance display) | 1.5-2 weeks | Online half of the core wedge |
| POS-side redemption (POS UI extension, Customer Details target) | 2-2.5 weeks | In-person half of the core wedge — the differentiator |
| Offline-consistency handling (atomic decrement, reject-on-conflict, "can't confirm" state) | 1 week | The specific design requirement this round identified |
| Admin config (earn rate, redemption rate, CSV export) | 1 week | Merchant-facing basics |
| Listing prep (copy, screenshots, test credentials, privacy policy) | 3-4 days | Submission-ready |
| Submission + review cycle | 2-4 weeks (ASSUMED, per PLAYBOOK's own prior; no SLA found in current docs) | Listed |

**Total: ~11-14 weeks**, comfortably inside a solo dev's year and the $100-500 budget (domain
~$12/yr; no security-audit fee; no DPA/SOC2 burden — this app holds a points ledger and order
metadata inside its own tenant-scoped OAuth install, not third-party PII custody at the scale that
triggers enterprise trust requirements).

**Pricing for v1:** no permanent free tier (deliberately skips the commodity freemium floor other
loyalty apps compete on with features this app doesn't ship in v1). **Entry $39-49/mo, scaling via
order-volume gates to $149-199/mo** — below Smile's implicit premium-support pricing, at parity
with Kangaroo's flat $199 ceiling, justified specifically by the POS-reliability wedge the same
way Kangaroo's own long-tenured reviewers cite it.

**Three scenarios, 12 months out:**

| Scenario | Customers (order-volume-tier blend) | Blended price | MRR | Read |
|---|---|---|---|---|
| Bear | 8 | $45/mo | $360 | Below bar — reassess or kill |
| **Base** | **22** | **$50/mo avg** | **~$1,100** | **Clears the $1k bar** |
| Bull | 40, several on higher-volume tiers | $85/mo avg | ~$3,400 | Portfolio-worthy; still no second-listing candidate confirmed (round 93) |

All three assume **zero install/paying-customer visibility** (the same measurement gap CLAUDE.md
documents for every Shopify candidate) — these are price-ladder-times-plausible-count models, not
measurements.

---

## Implementation plan

1. **Spikes (weeks 1-2).** Webhook-latency timing, offline-race design/test, checkout↔POS
   consistency check on a dev store. **Kill point:** if POS-originated `orders/paid` webhooks
   turn out materially slower or unreliable relative to online orders, re-scope v1 around
   checkout-only redemption with a clearly-labelled "in-store redemption coming soon," and treat
   the POS half as a v1.x addition once the latency issue is understood.
2. **Ledger + webhooks (weeks 2-3.5).** Append-only points ledger, `orders/paid` and
   `refunds/create` ingestion, channel tagging.
3. **Checkout-side redemption (weeks 3.5-5.5).** Shopify Function, balance display.
4. **POS-side redemption (weeks 5.5-8).** POS UI extension on the Customer Details target,
   offline-consistency handling.
5. **Admin + listing prep (weeks 8-9.5).** Config UI, CSV export, listing copy built around the
   gap-shaped language found in reviews ("POS loyalty sync," "points redemption in store," "refund
   points reversed") rather than a generic feature list.
6. **Submit (weeks 9.5-13.5).** Budget 2-4 weeks of review-cycle buffer (ASSUMED per PLAYBOOK's
   prior, no SLA confirmed in current docs).
7. **Post-approval.** Reply, as the human, in the `community.shopify.com` thread round 88 found
   (`/t/loyalty/329812`) once the app exists — the single highest-leverage placement identified,
   since an outside merchant already publicly asked for exactly this and the thread stayed active
   for 7 months without a real answer.

---

## Roadmap

- **v1 (month 0-3.5):** cross-channel points ledger, checkout + POS redemption, refund reversal,
  offline-consistency handling, basic admin/CSV. This is the kill-test made durable.
- **v1.x (month 3.5-6):** sales-channel-scoped earning-rule filters (William Glen's ask, confirmed
  twice, unaddressed by every incumbent) — the highest-confidence next feature, since it is both
  independently requested and structurally cheap to add once the ledger exists. Non-overlapping
  balance-widget polish.
- **v2 (month 6-12):** referral/refer-a-friend, built specifically to avoid BON's dated
  post-login-redirect bug; VIP/tiered programs with rule-based entry conditions (Christian
  Weilert's ask); giveaway/competition-entry point awards (John Franich Jewellers' ask). **Second-
  listing decision point:** round 93 found no independent second Shopify category to reuse this
  engine against — re-attempt that search only after v1 ships and reaches a real review base, per
  round 93's own recommendation, rather than guessing at adjacency from category shelves alone
  again.

---

## Promotion plan

**Channel order, by ROI:**
1. **Reply in `community.shopify.com/t/loyalty/329812`, as the human, once the app exists.** An
   outside merchant already asked this exact question and got no real answer across 7 months —
   this is not cold self-promotion into a room that doesn't want it.
2. **Marketplace ASO** against the gap-shaped queries found directly in reviews and forum threads:
   "POS loyalty sync," "points redemption in store," "loyalty program POS reliable," "refund
   points reversed" — Shopify's search is fuzzy-matched against name/description, the same lever
   CLAUDE.md's Atlassian research documents.
3. **Listing copy built around the named defects**, not a generic feature list — cite the specific
   failure modes (redemption not decrementing, refunds not reversing, offline reliability) the way
   Kangaroo's own reviews already validate as a real purchase driver.
4. **Direct outreach to the named, dated reviewers still on a competitor** (OntarioVape Orleans,
   William Glen, Tulsa Body Jewelry) — the same semi-public, nameable list this project already
   uses as its highest-ROI direct channel.
5. **First 10 reviews:** onboard early POS-heavy merchants personally, free or discounted, ask
   directly once the cross-channel sync is demonstrably working for them.

**90-day week-by-week:** weeks 1-2 spikes; weeks 2-8 ledger + checkout + POS build; weeks 8-9.5
listing prep; weeks 9.5-13.5 submit-and-review buffer; from approval: community-thread reply +
ASO keyword tuning + the five named reviewers' direct outreach + first-10-customers personal
onboarding.

---

## Execution split

| I can do autonomously | The human must do |
|---|---|
| Desk research, competitor/pricing analysis, review mining (this dossier) | Create the Shopify Partner account, accept the Partner Program Agreement |
| Read `shopify.dev` docs, run the named spikes (webhook timing, offline-race test, cross-surface consistency check), report feasibility | Set up payout/tax details for Shopify Payments-linked revenue share |
| Write the app (Shopify Function, Checkout UI extension, POS UI extension, backend ledger service), tests | Submit the app for review; respond to the App Approval team as the account owner |
| Draft listing copy, keywords, screenshots (from a real test store), privacy policy/ToS text | — |
| Draft the community-thread reply and the direct-outreach messages to the named reviewers | **Post the community reply and send the outreach as themselves** — affiliation-disclosed community standing and cold contact require a real identity |
| Build the target list for the cheapest kill test (OntarioVape Orleans, William Glen, Tulsa Body Jewelry) | **Send the actual outreach / hold any resulting conversations**; make the go/no-go call at the round-88-named pass/fail bar |
| Monitor reviews/analytics once listed | Support relationships once customers exist |

---

## Assistant assessment — product perspective (2026-09-18)

This section is my own read, written by Claude Code in a working session on this repo, separate
from the automated idea-lab research pipeline that produced everything above. It agrees with most
of the dossier's structure and flags where I'd push back or add texture.

**On the 8-10% score.** I don't have a better number, but I'd note the range is doing a lot of work
compressing two very different failure modes: (a) the wedge is real but too narrow to reach $1k
MRR, vs (b) the wedge gets copied/patched by an incumbent before this app reaches distribution. The
dossier's biggest risk list names (a) implicitly (customer count) but underweights (b) — see below.

**The moat is thinner than "no customer conversation" implies.** Correct cross-channel sync is a
quality bug, not a structural moat. Smile.io, BON, and Appstle are all VC-adjacent or established
enough to fix this in a sprint once a competitor's reviews start citing "actually syncs with POS"
as a reason to switch. The defensible asset here isn't the fix — it's being first to market it
credibly *and* shipping the v1.x features (sales-channel-scoped earning rules) fast enough to build
a second differentiator before incumbents close the gap. I'd treat the roadmap's v1.x phase as
time-boxed and urgent, not a leisurely follow-on — ship it within 4-6 weeks of v1 launch, not "when
convenient."

**Cheaper validation than cold outreach may exist.** The dossier's kill test (email 3 named
reviewers, ask a recalled-behavior question) is good, but a working demo is a stronger and only
marginally more expensive proof: a 90-second screen recording showing a points balance earned
online, redeemed at a POS register, correctly decremented, posted directly into the 7-month
`community.shopify.com` thread (`/t/loyalty/329812`) where an outside merchant already asked for
exactly this. That's a warm audience with an open, unanswered ask — posting a working spike there
functions as both validation and pre-launch distribution in one move, and it only requires having
already built spikes 2-5, not a finished app. Worth sequencing as kill-test-2 if the cold outreach
is inconclusive (1 of 3 confirms, say) rather than treating outreach as pass/fail-only.

**v1 scope: consider shrinking the offline-consistency requirement.** The atomic-decrement/reject-
on-conflict design is correct engineering, but it's also the single largest, hardest-to-test piece
of v1 (needs a real POS device deliberately taken offline). A cheaper, still-correct v1 posture:
**disable redemption entirely when the POS extension can't reach the backend live** (show balance
as "last synced" and gray out the redeem action) rather than building full conflict resolution.
This is honest — it never silently drifts — and defers the harder race-condition engineering to
v1.x once real usage data shows whether offline redemption attempts are common enough to justify
building around. It directly shrinks the riskiest line item in the estimation table (spike 3 and
the "offline-consistency handling" build phase) without weakening the correctness claim the whole
app is positioned on.

**Pricing: the no-free-tier bet deserves one hedge.** Skipping freemium avoids the commodity race,
but Shopify's App Store review count is the *only* public demand/trust signal buyers see, and a
paid-only app collects reviews slower than a freemium one. I'd consider a capped free tier (e.g.
≤50 orders/month, full feature set) specifically to accumulate the first 10-20 reviews faster,
then convert those merchants onto paid tiers as they grow past the cap — not a permanent freemium
floor, just a review-velocity bootstrap. This is a reversible pricing decision, worth revisiting
after the kill test rather than deciding now.

**ICP should be stated explicitly, not left implicit.** Reading the review evidence, the real buyer
is a multi-location or POS+online boutique/specialty retailer (apparel, jewelry, vape, health &
beauty recur in the sourced reviews) doing roughly 10-500 orders/month — small enough that a
$39-199/mo tool is a meaningful line item they'll evaluate carefully, large enough that manual
balance reconciliation between channels is already a felt pain. Listing copy, the community-thread
reply, and the first-10-customers outreach should target this profile by name, not "any Shopify
merchant with a POS."

---

## Sources

- `research/round-85-shopify-category-enumeration.md` (2026-09-17) — category enumeration, money
  test, rule-4 checks across 6 categories, Loyalty & rewards identified as the survivor.
- `research/round-88-shopify-loyalty-killtest.md` (2026-09-17) — vendor-level concentration
  recheck (54.1%, holds), incumbent review mining (rounds 1), `community.shopify.com` demand check
  (leg 3), the 7-month thread.
- `research/round-93-shopify-second-listing.md` (2026-09-17) — portfolio/second-listing search,
  clean negative; referrals found to be a bundled feature, not an independent listing.
- `research/round-94-shopify-loyalty-dossier-research.md` (2026-09-17) — this round: submission
  gate and revenue-share terms confirmed directly from `shopify.dev`, POS-sync technical spike
  assessed against Shopify's own POS UI Extensions/Discounts/Order-object docs, larger
  Smile/BON/Appstle review pull, v1/v2 scope and pricing.
- `shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements`,
  `.../app-store-review`, `.../app-store-review/review-process`,
  `.../distribution/revenue-share`, `.../billing`, `.../billing/managed-pricing` — fetched
  2026-09-17.
- `shopify.dev/docs/api/pos-ui-extensions`, `.../pos-ui-extensions/targets`,
  `.../pos-ui-extensions/apis`, `shopify.dev/docs/apps/build/{pos,discounts}`,
  `shopify.dev/docs/api/admin-graphql/latest/objects/Order` — fetched 2026-09-17.
- `apps.shopify.com/smile-io/reviews`, `apps.shopify.com/bon-loyalty-rewards/reviews`,
  `apps.shopify.com/appstle-loyalty/reviews` (all `?ratings[]=1&2&3`) — fetched 2026-09-17,
  quotes attributed to named stores with dates as shown above.
- `docs/round-95-market-verification-independent.md` (2026-09-18) — independent second-pass
  verification of review counts/pricing (confirmed), two additional competitors found (Rivo,
  Growave), Joy Loyalty's untested POS-extension marketing claim (new spike added above), four
  additional community threads on the same POS-sync defect (demand signal strengthened), no
  evidence of an incumbent fix in flight.
