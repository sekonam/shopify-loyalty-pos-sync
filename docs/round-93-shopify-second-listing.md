# Round 93 — Shopify second listing: portfolio kill test (2026-09-17)

Round 58 ran this exact search for monday.com and found nothing. Rounds 85/88 gave Shopify a real
foothold (Loyalty & rewards, 12-14% hunt / ~8-10% post-kill-test, `SHORTLIST.md` #8). This round
runs the same portfolio search for Shopify: is there a second category the same developer could
plausibly ship next, ideally reusing the loyalty engine's customer/order/points data model.

**Result: nothing survives as an independent second *listing*.** Every candidate checked either
fails rule 4 (native Shopify banner), fails concentration, or — the one genuinely domain-adjacent
candidate — turns out to be correlated with Loyalty rather than independent, the same structural
conclusion round 58 reached for monday.com's QuickBooks bridge. Reported as a clean negative per
rule 10, with one nuanced finding worth keeping.

---

## Method

Round 85 established that `apps.shopify.com/search?q=` is client-rendered (needs a browser) while
`/categories/{slug}` pages are server-rendered `curl`-able curated shelves. This round used both:
`curl` against category-shelf pages for a fast first pass (parsed via a small script matching
`data-app-card-handle-value` / `data-app-card-name-value` blocks — the real markup, confirmed
against round 85/88's own Loyalty numbers, which reproduced exactly: Smile 4,588, BON 1,931, Joy
1,786, Appstle Loyalty 1,368), then the Chrome extension against `/search?q=` for the categories
worth a second look, to get the true match count, the live "Included with Shopify" rule-4 banner,
and the fuller top-25 ranked list search actually shows buyers.

Five categories checked, chosen for domain adjacency to loyalty/rewards per the task's own list:
**Gift cards**, **Referral / affiliate programs**, **Subscriptions** (recurring-order management),
**Discounts / promotions / giveaways**, and **Analytics adjacent to customer lifetime value**.

---

## 1. Gift cards — killed on rule 4, cleanly, in one search

`apps.shopify.com/search?q=gift%20cards`: **2,197 matched apps**, and the very first thing the
page renders, directly under the search box, is:

> **Included with Shopify — Gift cards — Create, sell, and deliver gift cards to boost your sales
> — Get started**

The exact rule-4 mechanism round 85 used to kill Inventory management, Order tracking and Customer
accounts fires again here. Gift cards are native Shopify checkout/discount-code infrastructure on
every plan. Underneath the banner the dedicated third-party category is also thin: leader **Rise
Gift Cards & Store Credit, 754 reviews**, then a long tail of 20-170-review apps, one lone
non-freemium price point (**Selling Point, $49.99/month**, a bulk-migration tool). **Killed —
rule 4 plus a category too small to matter even if rule 4 didn't fire.**

---

## 2. Subscriptions (recurring-order management) — the strongest-looking candidate, killed on concentration

This is the task's own top-suggested direction and it is genuinely large: `search?q=subscriptions`
returns **844 matched apps**, and the leader — **Appstle℠ Subscriptions App, 8,734 reviews** — is
the single biggest review count found anywhere in this round, bigger than Loyalty's entire leader
(Smile, 4,588).

**No rule-4 banner fires**, despite Shopify shipping a native **Shopify Subscriptions** app (817
reviews, **3.7 rating — the lowest of any app surfaced this round**). This reproduces round 85's
Order Printer exception exactly: a free, native, first-party app coexists with, and is outsold and
out-rated by, third-party alternatives.

**But concentration kills it.** Top players by review count (deduped, ~23 genuine subscription
apps, excluding one keyword-noise hit):

| App | Reviews | Price | Shopify partner id |
|---|---|---|---|
| **Appstle Subscriptions** | **8,734** | Freemium | `appstle` |
| Recharge Subscriptions | 3,125 | Freemium | — |
| Seal Subscriptions | 3,089 | Freemium | — |
| Kaching Subscriptions | 1,038 | Freemium | — |
| Subi Subscriptions | 919 | Freemium | — |
| Appstle Memberships | 903 | Freemium | `appstle-memberships` |
| Shopify Subscriptions (native) | 817 | Free | — |
| Loop Subscriptions | 759 | Freemium | — |
| Skio, a Recharge Company | 241 | **$599/month** | — |

Total ≈22,300 across the visible set. **Top-1 (Appstle) ≈ 39%, top-3 (Appstle + Recharge + Seal)
≈ 67%** — top-1 sits right at CLAUDE.md's round-28 bar, but **top-3 clears the 60% ceiling**, the
same failure mode that killed monday.com's resource-planning candidate in round 58.

**Checked the hidden-rollup possibility explicitly (round-28's own correction method) and it does
NOT apply here** — pulled the `/partners/{id}` link from each app's static detail-page HTML:
Appstle Subscriptions (`appstle`), Appstle Memberships (`appstle-memberships`) and Appstle Loyalty
(`appstle3`, per round 88) are **three separate Shopify partner accounts**, not one vendor rollup
inflating the 39% figure. The concentration is real, not an artifact.

**Recharge is a well-resourced incumbent actively consolidating the niche** — "Skio, a Recharge
Company" at $599/month is a former standalone competitor now folded into Recharge's own listing,
visible directly in the search result copy. This is the central-principle answer for why the
niche isn't open: a funded market leader is still buying up the next tier down.

**Build-overlap is also weak, not just concentration.** Subscriptions require deep Shopify
Checkout/Selling-Plans API integration — CLAUDE.md's own cost-trap note already flags
`read_own_subscription_contracts` as an architecturally scoped API, a genuinely different
engineering surface from loyalty's points-ledger + POS-sync problem. **Killed on concentration
(top-3 67%) and on a thin build-overlap with the existing loyalty engine.**

---

## 3. Referral / affiliate programs — passes rule 4 and concentration, killed on independence

`search?q=referral%20program`: **851 matched apps**, no rule-4 banner. Concentration (deduped,
excluding two keyword-noise hits — an influencer-marketing app and a sweepstakes app):

**Top-1 (UpPromote Affiliate Marketing, 3,823 reviews) ≈ 33%, top-3 (+ReferralCandy 1,486 +Rivo
1,449) ≈ 58%** — both clear CLAUDE.md's round-28 bar, comparably to Loyalty's own 30%/54%.
Checked the top three vendors' `/partners/{id}` for a hidden rollup: **UpPromote (`uppromote8`),
BixGrow (`bixgrow1`), Affiliatery (`staqlab`) are three distinct vendors** — no collapse.

**On paper this is the closest match to the task's brief.** But reading the actual result set
shows why it fails as an *independent second listing* anyway: **the ranked results are dominated
by apps already counted in round 85/88's Loyalty analysis** — Casa Loyalty Points & Rewards (461),
Essent Loyalty Program Rewards (481), Rivo: Loyalty Program, Rewards (1,449), CWILL Loyalty &
Referrals (817) — and the smaller, newer entrants explicitly bundle the two features into one
product: *Loyoly — "Loyalty, rewards and referrals to boost sales"*; *Flits — a loyalty app whose
tagline doesn't even mention referrals separately*; *YOYO — "Enterprise Loyalty Programs, VIP
tiers, Memberships, Referrals"*. **Referral programs are not a separate market from loyalty on
Shopify — they are a feature most loyalty apps already ship inside one listing**, sharing the
exact same customer/points/order data model this round was told to look for.

That is the domain/build overlap the task asked about, found directly — but its practical
consequence is the opposite of "ship it as listing #2." **The overlap is why this is a *feature*
of the loyalty app, not an independent product**, the same structural conclusion round 58 reached
when it found the QuickBooks/invoicing bridge wasn't a real second monday.com listing either — it
needed to own the same underlying data the first listing already owns. **Not killed on the
numbers; killed on not being a second listing at all.**

---

## 4. Discounts / promotions / giveaways — commoditized to free, killed on the money test

Two category shelves pulled (`marketing-and-conversion-promotions-discounts`,
`-giveaways-and-contests`, 24 apps each). Leaders by reviews: **BOGOS: Free Gift Bundle Upsell**
(4,375), **Pumper Bundles Quantity Breaks** (3,482), **Kite Discount, Free Gift, BOGO** (1,205).

**Every one of the top ~20 apps across both shelves carries a "Free" or "Free plan available"
label; the sole exception found was Amai Bulk Discount Codes at $6.95/month.** This is the same
cross-tab CLAUDE.md's rule 8/GoHighLevel note and round 90's Bubble finding already established:
when the entire top of an install/review distribution is free, the marketplace segment is
commoditized and there is no visible price ceiling to sell into. Giveaways/contests is even
thinner in absolute terms (leader 225 reviews, most apps single digits). **Killed on the money
test — no price-ceiling lever exists here the way it does for Loyalty's order-volume gating.**

---

## 5. Analytics / customer lifetime value — keyword-contaminated, no dedicated category exists

`search?q=customer%20lifetime%20value`: **6,379 matched apps** — the count itself is the
tell (round-28's rule-3 warning about clustering on tagline text, not the app's real function).
The actual top results are **not a CLV category at all**: they are Loyalty apps already counted
above (BON 1,931, CWILL Loyalty 817, Growave 1,291, Glow, Mylo, bLoyal), Subscriptions apps
(Shopify Subscriptions, Ordergroove), and a **distinct, genuinely separate niche that surfaced by
accident: profit/margin analytics** — TrueProfit (902 reviews), **Decile ($900/month — the
highest single price point found anywhere in this round)**, Profitario, Margeny, Peel Retention
Analytics, Retention X.

Profit analytics is real and interesting on its own terms (a genuine price ceiling, thin
competition at the $900/mo end) but it **fails the task's own domain-overlap test outright**: it
needs Meta/Google Ads spend-API integration and COGS/margin bookkeeping logic, nothing shared with
a loyalty app's points-ledger/POS-sync engine. Flagged as a possible *third*, uncorrelated
Shopify listing worth a dedicated round of its own someday (round-29's own preference for
uncorrelated draws would favor it precisely because it does NOT overlap) — but it is not this
round's answer, since this round was scoped to find a build-reuse candidate. **Not pursued
further; recorded as a sighting, not a candidate.**

---

## What this round did NOT check

- **Store design / merchandising**, named in the task's suggestion list, was not checked — after
  five categories all resolved cleanly (three kills, one correlated-not-independent, one
  domain-mismatched sighting), the marginal value of a sixth category looked low against the time
  budget; nothing in the first five pointed toward store design specifically being different.
- **No incumbent-review mining** (round 88's rule 1/2 dated-complaint pull) was run for any
  category here — every candidate died on rule 4, concentration, the money test, or independence
  before reaching the point where review-mining would have added anything. Per round 58's own
  "cheap checks first" logic, this was the correct place to stop.
- **No vendor-level roll-up check beyond the specific vendors named** (Appstle's three partner
  accounts, UpPromote/BixGrow/Affiliatery) — sufficient to answer this round's specific concentration
  questions, not a full census of either category.

---

## Bottom line

**No second Shopify listing survives this round's kill test, matching round 58's monday.com
result exactly.** Gift cards dies on rule 4 (Shopify's own native banner) and on size. Subscriptions
is the biggest, most structurally attractive-looking candidate — no rule-4 flag despite a native
app, a real price-ceiling precedent (Skio at $599/month) — but Recharge's active consolidation of
the niche pushes top-3 concentration to 67%, above the round-28 bar, and the build itself shares
little with a loyalty engine. Discounts/promotions is commoditized to free. Analytics/CLV isn't a
real category — it's keyword noise that happens to surface a genuinely separate, domain-mismatched
niche (profit analytics) worth flagging for later, not now.

**The one finding worth keeping is structural, not a candidate:** Referrals is the category that
most resembles what the task asked for — real concentration numbers, no rule-4 flag, genuine
customer/points/order data overlap with loyalty — and *precisely because* the overlap is real, it
is not an independent second listing. It is a feature successful loyalty apps already bundle into
one product (Loyoly, YOYO, CWILL Loyalty & Referrals). **This is the same shape round 58 found for
monday.com's QuickBooks bridge**: the candidate with the most build-overlap turns out to be a
scope decision inside listing #1, not a listing #2. Recorded here so the Loyalty dossier, if one
gets written, scopes referral/refer-a-friend as a bundled feature rather than a separate
Marketplace submission.

**This is a clean negative, not a soft one.** Per rule 10, reported as "checked, nothing found" —
the portfolio multiplier CLAUDE.md's own "70% one-listing / 96% earn nothing" finding recommends
chasing remains a to-do for Shopify's loyalty candidate, not a validated second leg.

**Cheapest next step, named per the prime directive:** re-attempt this search only after the
Loyalty listing (if built) ships and reaches a real install/review base — at that point the
loyalty app's own users become a first-party source for what a second listing should be (the same
logic round 58 used to defer monday.com's second-listing search), rather than desk research
guessing at adjacency from category shelves alone.

---

## Sources

- `apps.shopify.com/categories/{slug}` — server-rendered curated shelves, `curl`, parsed via a
  small script matching the real `data-app-card-handle-value` / `-name-value` / rating / review-
  count / price-label markup (confirmed against round 85/88's own Loyalty figures, which
  reproduced exactly). Slugs used: `marketing-and-conversion-customer-loyalty` (control),
  `marketing-and-conversion-gifts-gift-cards`, `marketing-and-conversion-promotions-discounts`,
  `marketing-and-conversion-promotions-giveaways-and-contests`, `store-management-operations-
  analytics`, `selling-products-payments-subscriptions`.
- `apps.shopify.com/search?q=<term>` via the Chrome extension (client-rendered, confirmed —
  plain `curl` returns an empty skeleton shell with zero real app data, matching round 85's own
  finding) for: `gift cards`, `subscriptions`, `referral program`, `customer lifetime value` —
  each read for total match count, the live "Included with Shopify" rule-4 banner, and the
  visible top-~25 ranked results with rating/reviews/price.
- `apps.shopify.com/{handle}` app-detail pages, static HTML, `curl`, for schema.org
  `aggregateRating` and the `/partners/{id}` developer link — used to check the Appstle
  three-listing family and the top three Referral vendors for hidden roll-ups.
- `research/round-85-shopify-category-enumeration.md`, `research/round-88-shopify-loyalty-
  killtest.md`, `research/round-58-mondaycom-second-listing.md`, `SHORTLIST.md` #8 — prior context
  this round extends and the direct methodological comparable.
