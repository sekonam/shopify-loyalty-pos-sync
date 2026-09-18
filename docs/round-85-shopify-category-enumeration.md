# Round 85 — Shopify App Store: the round-28/40/49 category-enumeration treatment, finally run
(2026-09-17)

CLAUDE.md's Shopify trade-off-table row ("Yes / Strong / $9-30/mo / median app under $1,000/mo")
has stood since an early, structural-only round. This round applies the instruments developed
*after* that row was written — round 28's concentration + "won small" test, round 40's
per-sub-target check, round 49's category-level enumeration discipline — to Shopify for the first
time, and checks CLAUDE.md's own rule 4 against Shopify's expanding native feature set.

---

## 0. Method — no documented catalogue API; a working hybrid instead

**Checked first, per the task:** `shopify.dev` has no partner/public API for *browsing* the App
Store catalogue — its APIs are for building apps (Admin API, Storefront API, App Bridge), not for
reading the marketplace as a buyer would. This is a genuine, confirmed gap, unlike WooCommerce's
Store API or monday.com's bundle-grepped endpoints. Round 85 therefore used three different
surfaces of `apps.shopify.com` itself, at three different levels of blockage:

| Surface | Rendering | What it gives |
|---|---|---|
| `apps.shopify.com/` and `/categories/{slug}` | **Server-rendered (plain curl works)** | Curated 9-12-app "shelves" per (sub)category, no total count, no pagination |
| `apps.shopify.com/search?q=<term>` | **Client-rendered — needs a browser** (curl returns an empty 99KB shell; confirmed with `grep` for known app names, zero hits pre-JS) | The real thing: a total match count ("8,302 apps"), full pagination (up to 346 pages seen), and per-app rating, review count, price label, and "Built for Shopify" badge — rendered per result |
| `apps.shopify.com/{app-handle}` (app detail page) | **Server-rendered**, confirmed via curl | Schema.org JSON-LD: `"aggregateRating":{"ratingValue":X,"ratingCount":Y}`, plus a `Developer <Name>` byline and (for most apps) full plan-by-plan pricing text in the static HTML |

**No install counts anywhere** — confirmed by checking both search results and app detail pages.
This matches CLAUDE.md's standing note; **review count is the only public demand proxy**, exactly
as the task anticipated, and it is used throughout below with that caveat attached every time.

**A genuinely new, useful signal found this round:** the search results page renders a banner
directly under the query, "**Included with Shopify — Get started**", whenever Shopify's own admin
already covers that query natively. This fired for *inventory management*, *order tracking*, and
*customer accounts* (see §3) — a free, per-query, live version of rule 4's check, not previously
available to this project on any ecosystem.

---

## 1. Six categories checked

Chosen per the task's suggested list, using Shopify's real category-search terms (verified against
`apps.shopify.com`'s own nav taxonomy: *Sales channels · Finding products · Selling products ·
Orders and shipping · Store design · Marketing and conversion · Store management*, each with 3-5
sub-shelves). Numbers below are from the **top ~25-30 results by relevance** per query — the
`text=` search itself, not a full crawl of every matched app (Shopify's own match counts run into
the thousands per query because it fuzzy-matches on tagline text, not a clean category tag; see
§2 for why the top slice is what matters).

| Category (search term) | Matched-query count | Real dedicated-app count (est. from pagination × page size, sanity-checked) | Rule-4 banner? |
|---|---|---|---|
| Inventory management | 2,394 | ~100 (page count 100) | **Yes** |
| Order tracking / shipping | 5,243 / 8,302 | ~150-220 | **Yes** (order tracking) |
| Product reviews | 6,915 | ~289 | No |
| Print on demand | 3,976 | ~166 | No |
| Customer accounts | 6,709 | ~280 | **Yes** |
| Loyalty & rewards / loyalty program | 960 / 941 | ~40 | No |

⚠️ These match-counts are **keyword hits, not category populations** — "shipping" alone matches
8,302 apps because any app whose tagline mentions shipping counts. Every table below is built from
the **named, dedicated apps actually offering that function**, read off the top of the ranked
results, the same "cluster on the name, not the tagline" discipline CLAUDE.md demands (round 28
rule 3) — not from the raw match count.

---

## 2. Product reviews — dead on arrival, exactly the pattern CLAUDE.md warned about

| App | Reviews | Rating | Price label |
|---|---|---|---|
| **Judge.me** | **47,104** | 5.0 | Free plan available |
| Loox | 9,606 | 4.9 | Free plan available |
| Yotpo | 4,632 | 4.8 | Free plan available |
| Vitals (bundle) | 2,954 | 4.9 | Free trial |
| AG Product Reviews | 3,164 | 5.0 | Free |
| CWILL/Trustoo | 1,572 | 4.9 | Free plan available |
| Ali Reviews | 1,453 | 4.8 | Free plan available |
| Fera | 2,030 | 4.8 | Free trial |
| Junip | 1,153 | 4.8 | Free plan available |

Top-1 (Judge.me) alone ≈ **64% of the visible top-9 apps' combined reviews.** This is Shopify's
oldest, most heavily-searched, most-written-about app category — exactly the "publicly-searchable
gaps are already taken" failure pattern (CLAUDE.md's failure-pattern list, #2) with a single
extreme incumbent on top of it. **Skip.** No further work.

---

## 3. Print on demand — dead on the money test, not on concentration

| App | Reviews | Price label |
|---|---|---|
| Printify | 4,334 | Free to install |
| Printful | 3,870 | Free to install |
| CJdropshipping | 2,845 | Free to install |
| Zendrop | 1,256 | Free to install |
| Gelato | 1,009 | Free to install |

Printify + Printful alone ≈ 52% of the visible top-10's combined reviews — concentrated on its
own — **but the more decisive kill is the money test.** Every leading app is "Free to install":
these are fulfillment/production marketplaces, not SaaS subscriptions billed through Shopify's app
platform — the merchant pays a per-unit production/shipping cost outside the app-billing rail, the
same DIY-elsewhere shape that killed Stripe Apps/Airtable/Miro elsewhere in this project. (Printify
does sell an optional $24.99/mo "Premium" tier on top — a real but secondary revenue line, not
the category's primary mechanism.) **Skip.**

---

## 3b. Order tracking / shipping — rule-4-flagged, and still concentrated underneath it

Shopify's own admin now ships basic order-status/tracking natively ("Included with Shopify — Get
started" banner). Despite that, dedicated third-party tracking apps are large:

| App | Reviews | Price label |
|---|---|---|
| 17TRACK Order Tracking | 4,351 | Free plan available |
| CWILL (Parcel Panel) | 3,171 | Free plan available |
| Track123 | 1,727 | Free plan available |
| AfterShip | 1,501 | Free to install |
| TrackingMore | 381 | Free to install |
| Tracktor | 153 | Free plan available |

Top-3 (17TRACK + CWILL + Track123) ≈ **77%** of this visible set — worse concentration than
product reviews' top-3, on top of the rule-4 flag. **Skip** — the coexistence-with-native
precedent (Shopify's own free Order Printer vs. the thriving paid Order Printer Pro, both live at
once, §4) means rule 4 alone would not have killed this, but the concentration on top of it does.

---

## 4. Rule 4 — Shopify's own free first-party roster, read off the homepage

The homepage's "**Made by Shopify**" shelf, all free, all native:

Shopify Forms (723 reviews) · **Shopify Flow (14,012)** · **Shopify Inbox (5,799)** · Checkout
Blocks (215) · Collective: Supplier (781) · Smart Pricing (139) · Subscriptions (817) · Collabs
(427) · **Order Printer (377)** · Knowledge Base (29) · Search & Discovery (505) · Bundles (571).

**This roster has grown noticeably past what CLAUDE.md's original assessment would have seen** —
Shopify now natively covers forms, workflow automation, live chat/support (Inbox), checkout
customization, supplier marketplace, AI pricing, subscriptions, influencer marketing, invoicing,
FAQ/AI knowledge base, search/discovery, and bundling, all free, all first-party. Categories
adjacent to any of these should be checked for this banner before being scored.

**But the one direct same-category coexistence measured says native-free does not always win:**
Order Printer (free, native, 377 reviews) sits in the same functional slot as **Order Printer Pro**
(paid, third-party, 2,901 reviews — 7.7× the native app's review count) and **Simple Invoice Order
Printer** (paid, 440 reviews). The free native app is not the category leader by reviews. This is
the same pattern CLAUDE.md's Confluence/Jira rule-4 note treats as usually fatal — here it is not,
which is worth flagging as a genuine exception rather than smoothing it into the general rule.

---

## 5. Loyalty & rewards — the one candidate that survives every filter checked

**No rule-4 banner fired for "loyalty rewards" or "loyalty program."** No app on the "Made by
Shopify" native roster does loyalty. This is the cleanest rule-4 pass of the six categories.

**Top of the ranked results** (two overlapping queries merged, de-duplicated by app):

| App | Reviews | Rating | Price (from app-page pricing text where fetched) | Developer |
|---|---|---|---|---|
| **Smile: Loyalty Program Rewards** | **4,588** | 4.9 | Freemium (Smile.io — legacy incumbent, ~2013-era company) | Smile.io |
| BON Loyalty Program & Rewards | 1,931 | 5.0 | Free / **$15 / $29 / $129 per month**, order-volume-gated | VEGAHUB Technology Inc. |
| Joy Loyalty Program Rewards | 1,786 | 4.9 | Freemium | — |
| Rivo: Loyalty Program, Rewards | 1,449 | 4.7 | Freemium | — |
| Appstle Loyalty Program Reward | 1,368 | 5.0 | Free / **$10 / $30 / $100 per month**, order-volume-gated | Appstle |
| Okendo: Reviews & Loyalty | 1,424 | 4.8 | Freemium | — |
| Growave: Loyalty & Wishlist | 1,291 | 4.8 | Freemium | — |
| BLOY Loyalty Points & Rewards | 843 | 5.0 | Freemium | — |
| CWILL Loyalty & Referrals | 817 | 4.9 | Freemium | Trustoo/CWILL |
| LoyaltyLion | 535 | 4.6 | Freemium | — |
| Essent Loyalty Program Rewards | 481 | 5.0 | Freemium | — |
| Casa Loyalty Points & Rewards | 461 | 5.0 | Free | **Casa Apps** |
| Love Loyalty Points & Rewards | 355 | 5.0 | Freemium | — |
| OneLoyalty | 114 | 4.5 | Freemium | — |
| Toki Loyalty Program & Rewards | 95 | 4.9 | Free to install | — |
| **Kangaroo: Loyalty and Rewards** | **55** | 4.9 | **$199/month flat, no free tier** | — |

### Concentration (review-count proxy, top ~22 apps summed ≈ 15,343 reviews)

| Measure | Value |
|---|---|
| Top-1 share (Smile) | **29.9%** |
| Top-3 share (Smile + BON + Joy) | **54.1%** |

This clears CLAUDE.md's round-28 bar (leader <40%, top-3 <60%) — comparably to, and slightly
better on the leader-share axis than, the "Room" example already in CLAUDE.md's own concentration
table (time-in-status: 33% / 56%). ⚠️ **Review count, not installs** — the same substitution
CLAUDE.md's own instrument table already flags for every ecosystem without a public install
metric; read the percentages as directional, not exact.

### The "has anyone won small here?" test — passes

**Kangaroo: Loyalty and Rewards** — 55 reviews, **$199/month flat**, no free tier at all. A real,
named, small-footprint app charging a meaningful recurring price on a low review count — the same
shape as Atlassian's Doctor Pro (188 installs, $900/yr) and AppFox Optimizer. This is existence
proof that the niche does not require Judge.me-scale review counts to charge real money.

### The multi-listing / "one engine, many listings" pattern — reproduces here too

- **Appstle** ships Appstle Subscriptions, **Appstle Loyalty**, and Appstle Memberships as
  separate listings off one company — the Getint/Terano portfolio shape CLAUDE.md documents on
  Atlassian and monday.com.
- **CWILL / Trustoo** runs the *identical* pattern across three unrelated categories under one
  brand: **CWILL Order Tracking** (3,171 reviews), **CWILL Loyalty & Referrals** (817), and
  **CWILL(Trustoo) Product Reviews** (1,572) — one vendor, three separate search-surface listings,
  each independently ranked in its own category's results. This is the first time this project has
  found the multi-listing engine strategy already running, unprompted, on a marketplace outside
  Atlassian/monday.com — it is not this project's idea here, it is an observed incumbent practice.
- **Casa Apps** runs a smaller version of the same thing: Casa Loyalty Points & Rewards (461) +
  Casa Subscriptions & Bundles (151).

### Price ceiling — higher than CLAUDE.md's old $9-30/mo row, and for a specific reason

BON and Appstle both **gate their paid tiers on monthly order volume**, not a flat SaaS fee — the
functional equivalent of Atlassian/monday.com's per-seat lever, translated to Shopify's own scale
variable (orders, not users). Ceiling tiers reach **$100-129/month** before any enterprise
negotiation, and Kangaroo prices its entire product at **$199/month flat**. This is 3-13× CLAUDE.md's
recorded $9-30/mo, and it means a merchant who grows is worth progressively more to the same app —
the one structural feature the WooCommerce round (round 47) found *missing* on that marketplace
("confirmed zero seat/tier scaling... no customer is ever worth more than any other"). **Shopify's
loyalty category has the lever WooCommerce's whole marketplace lacks.**

---

## 6. What this round could NOT measure — say so plainly, per rule 10

- **No listing-age/cohort data.** Unlike Atlassian's sequential id or monday.com's `created_at`
  field, nothing on `apps.shopify.com` exposes when a listing was created. The "Built for Shopify
  2026" / "2025" tags seen on some cards are **badge-award years, not founding dates** — Judge.me
  and Loox almost certainly predate 2020; BON and Appstle read as newer entrants by their feature
  sets and UI conventions but this is inference, not a measurement, and is flagged as such.
  **Cannot run the round-29-style cohort table on Shopify with public data alone.**
- **No true category population.** The keyword-match counts (940-8,302) are not the real
  population of dedicated apps; the dedicated-app tables above were built by reading the ranked
  top of results, which risks missing a fragmented long tail the way round 9's Atlassian
  "unclaimed-query" scan warned against. A handful of small competitors with 5-30 reviews each may
  sit un-enumerated below what was pulled.
- **No vendor-level roll-up check beyond the three spotted by name (Appstle, CWILL, Casa Apps).**
  A systematic per-app "Developer: X" pull (available on every app detail page, confirmed working)
  across the full loyalty list was not done for time; it is the single cheapest next step if this
  niche proceeds (round 28's own vendor-concentration correction — Appfire-style roll-ups can hide
  inside an app-level histogram).
- **No revenue or paying-share data**, same universal gap as every other ecosystem this project
  has measured — review counts and price ladders are the ceiling of what's public.
- **Customer accounts** (thin, all dedicated customization apps 2-90 reviews, rule-4-flagged,
  post-2024-migration-shaped) was recorded but not pursued further — it reads as either genuinely
  new-and-open or genuinely nobody-searches-it (rule 5); distinguishing the two needs the
  vote/demand instrument this round didn't have time to build for Shopify.

---

## 7. Bottom line

**Shopify passes the round-28/40/49 treatment for the first time on one specific candidate:
Loyalty & rewards.** It clears concentration (30%/54%, comparable to CLAUDE.md's own "Room"
example), passes buy-worthiness (a loyalty program recurs every purchase and is visible in every
post-purchase email/page), passes rule 4 cleanly (no first-party competitor, unlike three of the
other five categories checked), has a named small-scale earner (Kangaroo, $199/mo on 55 reviews),
and already runs the multi-listing engine pattern this project recommends elsewhere on Atlassian
and monday.com (Appstle, CWILL/Trustoo, Casa Apps) — as an *observed incumbent practice*, not a
novel proposal. Its price ceiling (order-volume-gated tiers to $100-199+/mo) beats CLAUDE.md's old
flat $9-30/mo row for this specific category, for a real structural reason (a per-order-volume
lever, the Shopify analogue of per-seat pricing) — though it does not fully close the gap to
Atlassian/monday's per-seat economics, and the $1k-MRR customer count at entry-tier pricing
($10-15/mo) still lands in the same 30-100-customer range the old row estimated for the whole
marketplace.

**Four of the other five checked categories are worse than the old row implied, not better:**
Product reviews and Print on demand are dead (extreme concentration; DIY-billed-elsewhere,
respectively); Order tracking is rule-4-flagged *and* concentrated; Inventory management and
Customer accounts are both rule-4-flagged by Shopify's now-larger native feature set. **The old
trade-off-table row undersold Shopify's native-feature growth as much as it undersold its price
ceiling** — both directions moved since the row was last touched, and neither had been checked
until this round.

**Per the standing calibration note (14 dossiers dropped 10-15 points from their hunt-stage
score, none rose): score this 12-14% at hunt stage, expect ~5-8% after a dossier.** That does not
clear the ≥10% bar this project uses for `SHORTLIST.md` inclusion once the haircut is applied —
consistent with how round 47's comparably-evidenced WooCommerce finding (10-12% hunt, expect
5-8%) was recorded in `IDEAS.md` but not added to `SHORTLIST.md`. Recorded here as a **named,
evidenced hunt-stage candidate**, not a shortlist entry.

**Named cheapest kill test, $0, one afternoon:** pull the `Developer: <Name>` byline (present in
static HTML on every app detail page, confirmed) for the top 25 loyalty apps found here, and check
whether the 54% top-3-by-reviews figure survives at the **vendor** level rather than the app level
— exactly the correction round 28 already had to make once for Atlassian's workflow-extension
niche (Appfire: 32% app-level → 81% vendor-level). If vendor-level concentration holds under 60%,
this niche is a real hunt-stage candidate worth a proper dossier next. If it collapses the way the
Appfire example did, kill it immediately without spending dossier time.
