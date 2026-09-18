# Round 94 — Shopify Loyalty/POS-sync: dossier-stage research (2026-09-17)

Stage 0/1 follow-ups the PLAYBOOK requires before writing `ideas/15-shopify-loyalty-pos-sync.md`.
Five things checked: submission gate, revenue-share/billing terms, the POS-sync technical spike,
a larger incumbent-review sample for a v1 feature backlog, and build-scope/pricing. **WebSearch
budget was exhausted for this session (200/200) before this round started** — every finding below
comes from direct `WebFetch` against `shopify.dev` documentation pages and `apps.shopify.com`
review pages, not from search. Flagged per rule 10 wherever a doc page didn't contain the
answer.

---

## 1. Submission gate — favorable, comparable to Atlassian, nowhere near Salesforce

Fetched `shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements`,
`.../app-store-review`, and `.../app-store-review/review-process` directly.

- **No submission fee found anywhere** — unlike Salesforce's $999/review (CLAUDE.md's own cost
  trap). Partner Program registration is free.
- **No mandatory third-party security audit.** Requirements are self-attested engineering
  hygiene: TLS/SSL required, OAuth immediately after install, minimal access scopes ("high-risk"
  scopes like `read_all_orders` need documented justification in the listing), GraphQL Admin API
  only for new public apps (REST deprecated as a submission path since **October 2024**, mandatory
  GraphQL-only as of **April 1, 2025** — a real build-scope constraint, not a gate cost).
- **No stated review-timeline SLA in current official docs** — checked directly, three pages deep,
  none commit to a number of days/weeks. This is a genuine gap relative to Atlassian's documented
  5-10 days. PLAYBOOK.md's own prior estimate ("Shopify: 2-4 weeks standard") is not contradicted
  by anything found, just not independently reconfirmed from a dated source this round — carry it
  forward as the working assumption, labelled ASSUMED rather than newly confirmed.
- **Resubmission path exists but is undated**: a paused/rejected app can be fixed and resubmitted
  by clicking "Submit fixes"; no fee, no stated cooldown, no repeat-charge (contrast Salesforce's
  $999-per-resubmission trap).
- **Quality bar is real but mechanical**, not a business-vetting gate: no UI bugs, listing claims
  must match shipped functionality, working test credentials required, unique app name, no
  screenshots with pricing baked in. All satisfiable by a solo dev with no special standing.

**Read against CLAUDE.md's cost-trap table: this gate is Atlassian-shaped (cheap, self-serve,
engineering-hygiene-gated), not Salesforce-shaped (expensive, time-boxed at 5-9 months, paid per
attempt).** No new negative found here.

---

## 2. Revenue share / billing — confirmed better than assumed on one specific axis

Fetched `shopify.dev/docs/apps/launch/distribution/revenue-share` directly.

- **"Developers keep 100% of the first $1,000,000 USD in gross app revenue earned [per year,
  starting] January 1, 2025, and 85% of earnings above that"** — i.e. **0% take up to $1M, 15%
  above it.
- **This is an ANNUAL threshold, not Atlassian's LIFETIME $1M threshold.** At this project's
  target scale ($1k-20k MRR), the distinction is irrelevant to the dollar amount kept (both are
  100% at this scale) but it means the free-revenue allowance never exhausts and resets — a
  structurally more generous rule than Atlassian's Forge terms, though moot for a first-year
  candidate at 4-5 orders of magnitude below the threshold either way.
- **High-volume exception (not applicable here):** vendors doing $20M+/yr in app revenue or $100M+
  company-wide revenue pay 15% on all revenue, no 0% band. Irrelevant at this candidate's scale,
  noted for completeness per CLAUDE.md's own "read the exact terms" discipline.
- **All billing carries an additional 2.9% payment-processing fee plus applicable sales tax**, on
  top of the revenue-share calculation — a real, if small, deduction not to omit from unit-economics
  modelling.
- **Not found / ASSUMED:** payout frequency, currency options, and minimum payout threshold —
  the billing/managed-pricing doc page fetched was implementation-focused (recurring vs.
  usage-based billing config) and didn't carry payout-mechanics detail. Flagged as an open item
  for Stage 3, not a blocker — Atlassian and monday.com's equivalent mechanics were already
  established as unremarkable (arrive ~30 days after a qualifying month) and there's no reason to
  assume Shopify's differ materially, but this is ASSUMED, not confirmed.

**Bottom line: no new negative. One confirmed positive (annual vs. lifetime $1M band) that is
real but doesn't move the score at this candidate's target revenue scale — filed per the
"desk research confirming what was already assumed doesn't raise the score" instruction.**

---

## 3. The POS-sync technical spike — the single riskiest unknown, named explicitly

This is this candidate's equivalent of the monday.com dossier's "can a Board View deliver live
status" question. Fetched `shopify.dev/docs/api/pos-ui-extensions`, `.../targets`, `.../apis`,
`shopify.dev/docs/apps/build/pos`, `shopify.dev/docs/apps/build/discounts`, and the GraphQL
`Order` object reference directly.

### What is confirmed buildable

- **Shopify's own POS UI Extensions documentation names "loyalty program integration" as an
  explicit use case** for the "Customer Details" extension target
  (`pos.customer-details.block.render` / `.action.render` / `.action.menu-item.render`) — this is
  not an inferred fit, it is Shopify's own stated use case for exactly this extension point.
- **A POS extension can call the app's own backend via authenticated network requests** — the
  docs' own worked example is literally "displaying loyalty status via authenticated requests to
  your backend service." This confirms the correct architecture: the loyalty ledger lives in the
  app's own database (not in a Shopify metafield the POS UI reads directly), and the POS extension
  is a thin real-time client against it — the same "backend is authoritative, POS/checkout are
  thin real-time clients" pattern that makes cross-channel consistency possible at all.
- **The Cart API available to POS extensions can "apply discounts... and manage cart properties"**
  — meaning points-redemption-as-a-discount is a supported, first-class operation at the physical
  register, not a workaround.
- **The `Order` GraphQL object carries `sourceName` ("web" / "pos" / "mobile_app"), `app`,
  `publication`, and `sourceIdentifier` fields** — every order, regardless of channel, is
  attributable to its origin. This is the data the backend ledger needs to award points correctly
  regardless of where the sale happened.
- **Checkout-side redemption is a separate, real, supported surface too**: Shopify Functions let
  an app "apply custom discount logic when customers complete their purchase" online — the
  checkout-side half of the same redemption feature.

### What is a genuine, unresolved risk — named for the spike, not assumed away

- **Checkout and POS discount logic are described as two distinct "surfaces"** ("Checkout,"
  "Point of Sale," "Admin"), not one unified Function that runs identically on both — the docs
  give no indication a single Shopify Function payload drives both channels. **This means v1 must
  build two separate integration points (a Checkout UI extension/Function for online, a POS UI
  extension for in-person) that both read/write one shared backend ledger** — real, non-trivial
  integration work, not a single artifact reused twice. This roughly doubles the surface-level
  build relative to a web-only loyalty app, which is exactly why three funded incumbents (Smile,
  BON, Appstle) still have it broken in production per round 88's review mining — this finding
  gives that observation a concrete mechanical cause for the first time, rather than leaving it as
  "apparently hard."
- **Real-time webhook latency for POS-originated orders was not confirmable from the docs
  fetched** — no page stated whether `orders/create`/`orders/paid` fire for POS sales with the
  same latency as online sales. ASSUMED equivalent (POS orders are ordinary `Order` objects per
  the `sourceName` field above, so there is no structural reason webhooks would behave
  differently), but not independently confirmed — this is the cheapest remaining spike item for
  Stage 2 proper (a throwaway POS test-store transaction, timing the webhook).
- **Offline POS mode is a new, specific double-spend risk this round identified, not covered by
  round 85/88/93.** Shopify POS supports offline/queued transactions on some hardware; if a POS
  terminal redeems points while offline and the same customer redeems online before the terminal
  reconnects, both could succeed against a stale local balance. **This is a design requirement,
  not a blocker**: the backend ledger must decrement atomically and reject a race-losing second
  redemption; the POS extension must surface "balance last confirmed online — connect to verify"
  when it cannot reach the backend live, rather than silently trusting a cached number. Comparable
  in shape to standard e-commerce inventory-oversell handling, not a novel unsolved problem — but
  it is real scope, and no incumbent review mined so far specifically named "offline" as the
  failure mode (their bugs read as online-backend-side bugs, e.g. BON's balance simply "never
  reduced," rather than an offline-queue race) — so this is this round's own addition to the risk
  list, not a confirmation of an existing one.

### Spike verdict

**Technically feasible, confirmed via Shopify's own documentation and worked examples — not
architecturally blocked the way the killed Shopify subscription-contracts idea or the Office
add-in delegate-permission idea were.** But it is genuinely two integration surfaces against one
backend, plus an offline-consistency design problem, which is a real and specific explanation for
why incumbents with real engineering teams still get it wrong — consistent with, and now more
concrete than, round 88's "genuine integration difficulty" reading. **This is a hold, not a new
kill and not a new green light**: nothing here says the wedge is easy, and nothing here says it's
impossible. Per the task's own calibration instruction, this does not move the score.

---

## 4. Larger review sample — a concrete v1/v2 feature backlog, not just "POS is broken"

Pulled the 1-3★ filtered review pages for Smile.io, BON Loyalty (handle corrected to
`bon-loyalty-rewards`), and Appstle Loyalty directly (`apps.shopify.com/{handle}/reviews?ratings[]=1&2&3`).
Round 88 already established the headline POS-sync theme with three quotes; this pass reads
further down each list for concrete, named, non-POS asks — the equivalent of the monday.com
dossier's 132-reply-thread mining.

**Smile.io:**
- *"Tried to use for consignment and POS, spent hours trying to get it to work"* — Dream Nu,
  2025-10-28, 4 days using the app. A second, independent POS-integration-failure account beyond
  round 88's three.
- German-language review (Christian Weilert, 2026-07-31, 8 days) asking for **conditional VIP
  membership entry rules** — e.g. "customer must be newsletter-subscribed to become VIP" — not
  currently configurable. A concrete, named v2 feature gap (rule-based tier entry), not present in
  round 88's sample.
- John Franich Jewellers NZ (2026-07-27, 11 months) wanted to **run a competition/giveaway that
  awards points for entry** — a campaign-mechanics gap distinct from standard purchase-based
  earning.

**BON Loyalty Program & Rewards** (larger pull, 10 reviews vs round 88's 5):
- **Refund/return handling is broken**, independent of the POS theme: *"Customer returns and
  exchanges are a mess every time... the rewards points still have not been refunded five hours
  later"* — Tulsa Body Jewelry, 2025-06-23 (edited), 9 months using the app. This is a concrete,
  dated, distinct bug class from POS redemption — the ledger doesn't reliably reverse points on a
  refund, a second correctness bug in the same "keep the balance right across a lifecycle event"
  family as the POS-sync bug, and a **named v1 requirement**, not just a v2 nice-to-have: a
  points-refund-reversal path triggered by `refunds/create` must be in scope from day one, since
  refunds are routine retail activity, not an edge case.
- **The "Refer a Friend" flow has a real, dated, specific bug**: after the referred friend logs
  in, "[the app was] sending them to Shopify's default login page and leaving them there, instead
  of bringing them back to the referral page" — Brewing Beauty Co., 2026-06-02, 6 months. This
  independently corroborates round 93's "referrals are a feature of the loyalty app, not a
  separate listing" conclusion, and adds a concrete bug class to avoid when building it as a v2
  feature.
- **A UI-conflict complaint**: the floating on-page widget "blocks the cart drawer checkout button
  on mobile" — Trail Threads Co., 2024-07-12, ~13 hours using the app. A concrete, avoidable v1
  build requirement (don't ship a fixed-position floating launcher that can overlap the native
  checkout button) rather than a feature gap.
- William Glen's sales-channel-filtering ask (already in round 88) reproduces here too, confirming
  it as a real, persistent, unresolved multi-review gap, not a one-off.

**Appstle Loyalty Program Reward:**
- OntarioVape Orleans's POS complaint (already in round 88) reproduces with more operational
  detail on this pull: the outage lasted **three days**, support gave "scripted responses... rather
  than troubleshooting," and escalation still quoted "up to 48 hours" to fix — i.e. even after the
  merchant escalated a live, revenue-affecting redemption outage, the vendor's own stated SLA was
  two more days. This sharpens the central-principle finding: the operational failure is not just
  a bug, it's a support/ops-process failure on top of the bug, at a company (Appstle) round 85/88
  already showed runs its own multi-product engineering team.
- Jennifer Ouellette (2025-05-01, 3 months) asks for **phone support and a dedicated success
  manager on lower-tier plans** — a support-model gap, not a product-feature gap; noted but out of
  scope for a solo-dev v1 (this repo's own execution-split logic already assumes no dedicated
  success-manager tier is realistic at launch).

### The v1 backlog this sample supports, ranked by how many independent sources name it

1. **Cross-channel (online ⇄ POS) redemption sync** — 5 independent dated accounts across all
   three incumbents (round 88's 3 + this round's Dream Nu + the sharpened OntarioVape detail).
   The core wedge.
2. **Refund/return point-reversal correctness** — 1 dated account (BON/Tulsa Body Jewelry), but
   structurally the same "keep the ledger right across a lifecycle event" bug class as #1, so
   read it as a second occurrence of one underlying engineering discipline the incumbents lack,
   not a separate, weaker signal.
3. **Sales-channel-scoped earning rules** (e.g. exclude Amazon-fulfilled orders) — 2 independent
   mentions (William Glen in both round 88 and this pull) — a real, named, currently-unmet v1.x
   feature.
4. **Non-blocking widget UI** — 1 dated account, a build-quality requirement rather than a feature.
5. **Refer-a-friend, done correctly** — the bug that round 93 already flagged as "a feature of
   loyalty, not a separate listing" now has a concrete, avoidable failure mode on record (broken
   post-login redirect) to design against, for v2.
6. **Rule-based VIP tier entry conditions** — 1 account, v2.

---

## 5. Build scope and pricing

**v1 scope, sized against the backlog above (the kill-test made durable, per PLAYBOOK Stage 3's
own rule — nothing beyond what proves the wedge):**
- Points-earning ledger keyed off `orders/paid` webhooks, tagging every entry with `sourceName`
  (web/pos) for audit and reporting.
- Refund-triggered point reversal off `refunds/create` — in v1, not deferred, per backlog item #2.
- Checkout-side redemption: a Shopify Function / Checkout UI extension applying points as a
  discount online.
- POS-side redemption: a POS UI extension (Customer Details block/action) applying the *same*
  balance as a discount at the register, reading/writing the one shared backend ledger, with
  atomic decrement and an explicit "can't confirm balance — reconnect" state when the POS is
  offline.
- Minimal, non-overlapping on-page balance widget (theme app extension) — built narrow specifically
  to avoid the Trail Threads-style mobile checkout-button collision.
- Basic admin config: points-per-dollar earn rate, redemption value rate, CSV export.

**v1 explicit non-goals (deferred to v1.x/v2):**
- Referral/refer-a-friend — round 93's own finding that it's a bundled feature, not the wedge;
  building it well requires solving the exact redirect-flow bug found above, which is real but
  secondary work.
- VIP/tiered programs, rule-based tier entry conditions, birthday/anniversary rewards.
- Sales-channel-scoped earning-rule filters (William Glen's ask) — real demand, but v1.x.
- Giveaway/competition entry mechanics (Smile's John Franich Jewellers ask).
- Multi-brand/multi-store unification, non-English/localized support beyond Shopify's own
  platform i18n.
- Deep theme/CSS customization beyond the deliberately narrow v1 widget.

**Pricing.** Round 85's data: BON ($15/$29/$129) and Appstle ($10/$30/$100) both gate tiers on
monthly order volume; Kangaroo prices flat at $199/mo with no free tier at all and explicitly
markets POS reliability as its differentiator. Following the monday.com dossier's own logic
(price below the leader's ceiling, above the commodity floor, and let the specific differentiator
justify the gap): **v1 should skip the $10-15/mo freemium entry tier entirely** — competing there
means competing with free, commoditized loyalty widgets on features this app deliberately doesn't
ship in v1 (referrals, VIP tiers). Target **$39-49/mo entry, scaling via order-volume gates to
$149-199/mo** — below Smile's implied premium-support pricing tier, at parity with Kangaroo's
flat $199 ceiling, and justified specifically by the POS-reliability wedge the same way Kangaroo's
own reviewers cite it (*"Its integration with our POS system has been especially valuable... a
consistent loyalty experience whether customers shop online or in-store"* — PROCAM Photo & Video
Gear, quoted in round 88). No permanent free tier — a free trial only, to avoid the freemium-race
dynamic that commoditized Shopify's discounts/giveaways category (round 93).

---

## Net effect on the score

**No new negative strong enough to move the score down**: the submission gate is favorable, the
revenue-share terms are confirmed favorable (and marginally better than assumed on the annual-vs-
lifetime axis), and the POS-sync spike is confirmed technically feasible rather than blocked.
**No new positive strong enough to move it up either**: the same spike also surfaced a concrete,
specific reason the wedge is genuinely hard (two integration surfaces against one ledger, plus an
offline double-spend design problem this round is the first to name) — which is exactly the kind
of finding that explains persistence without proving ease. Per the task's own instruction to hold
absent a clear directional finding: **score holds at round 88's post-kill-test range, 8-10%.**
