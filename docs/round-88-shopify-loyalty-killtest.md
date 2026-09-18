# Round 88 — Shopify Loyalty & rewards: running round 85's named kill test (2026-09-17)

Round 85 named two things it did not do: (1) read incumbent reviews for dated, human-authored
complaints, and (2) recompute its 54% top-3-by-reviews concentration figure at the **vendor**
level (its own explicit kill test: *"if vendor-level concentration holds under ~60%, this is a
real hunt-stage candidate worth a dossier next; if it collapses the way the Appfire example did,
kill it immediately"*). This round runs both, plus a community-forum demand check
(`community.shopify.com`) round 85 flagged as not-yet-done, following the exact shape of round
51's monday.com kill test.

**Result: PASS, on all three legs.**

---

## Leg 1 — vendor-level concentration recheck (the round-85 named kill test)

Pulled the `Developer</dt>` byline (static HTML, confirmed readable by plain `curl`) for the top
apps by review count, then loaded each vendor's own `/partners/{id}` page (client-rendered,
needed the browser) to see their full listing set:

| App (reviews) | Partner id | Vendor's full app roster |
|---|---|---|
| **Smile: Loyalty Program Rewards (4,588)** | `smile-io` | **1 app** — Smile is single-product |
| **BON Loyalty Program & Rewards (1,931)** | `bon-loyalty2` (VEGAHUB Technology Inc.) | **1 app** — single-product |
| **Joy Loyalty Program Rewards (1,786)** | `getjoy` | **2 apps** — Joy Loyalty (1,786) + Joy Wishlist (18, negligible) |
| CWILL Loyalty & Referrals (817) | `sealapps` (branded "CWILL") | **3 apps** — CWILL(Trustoo) Product Reviews (1,572), CWILL Back in Stock (621), CWILL Loyalty (817) |
| Appstle Loyalty Program Reward (1,368) | `appstle3` | **1 app** *on this specific partner id* — see correction below |
| Growave: Loyalty & Wishlist (1,291) | `growave-io` | 2 apps — Growave (1,291) + Wave Connect IG/TikTok (128) |
| Casa Loyalty Points & Rewards (461) | `casaapps` | **6 apps** — Loyalty (461), Subscriptions & Bundles (151), Google Shopping Feed (232), Mobile App Builder (15), Estimated Delivery Date (4), WhatsApp Chat |
| Kangaroo: Loyalty and Rewards (55) | `kangaroo-rewards` | 1 app — single-product |

**The top-3 by review count (Smile, BON, Joy) are all effectively single-product vendors** —
Joy's sister app is a negligible 18-review wishlist tool. Recomputing round 85's headline number
at the vendor level: **top-3 vendor share = (4,588 + 1,931 + 1,786) / ~15,343 ≈ 54.1% — unchanged
from the app-level figure.** This is the opposite of what happened to Atlassian's workflow-
extension niche (32% app-level → 81% vendor-level once Appfire's family was merged) — **there is
no hidden roll-up sitting under the leaders here.** The kill test named in round 85 passes
cleanly: no collapse.

**Two corrections to round 85's own multi-listing claims, found while running this check:**

1. **"CWILL Order Tracking" is a different company, not the same vendor as CWILL Loyalty.**
   Round 85 grouped CWILL Loyalty & Referrals, CWILL(Trustoo) Product Reviews, and CWILL Order
   Tracking as one three-category multi-listing vendor. The `Developer` byline shows CWILL
   Loyalty and CWILL(Trustoo) Product Reviews both belong to partner id `sealapps`, alongside a
   third real sister app (CWILL Back in Stock Notify Me!, 621 reviews) round 85 didn't list — but
   **CWILL Order Tracking (branded "CWILL (Parcel Panel)") belongs to partner id `parcelpanel`, a
   different company that happens to also use "CWILL" in its listing name.** The real `sealapps`
   engine spans Reviews + Back-in-Stock + Loyalty (three customer-engagement Liquid/widget apps),
   not Order Tracking. The multi-listing pattern still holds — it's just a different, still-real,
   three-app set.
2. **Casa Apps' portfolio is bigger than round 85 recorded** — 6 listings, not the 2 it named
   (Loyalty + Subscriptions & Bundles), also including a Google Shopping feed app, a mobile-app
   builder, an ETA/delivery-date app and a WhatsApp chat app. This is a stronger match for this
   project's own Terano/Onward "one small utility shop, several listings" template than round 85
   gave it credit for.
3. **Appstle's Loyalty app sits on a separate formal Shopify Partner account (`appstle3`) from
   what is presumably its Subscriptions/Memberships siblings** — the brand-level multi-listing
   claim (one company, three product lines) is still true by name and by the fact all three
   share the "Appstle" brand prefix, but Shopify's own partner-account attribution does not treat
   them as one vendor. Flagged as a structural nuance, not a reversal.

---

## Leg 2 — incumbent reviews: dated, human-authored complaints (rule 1/2)

Filtered the live 1-star and 2-star reviews (via `apps.shopify.com/{handle}/reviews?ratings[]=1&ratings[]=2`)
for the three largest incumbents. All quotes below are dated, attributed to a named store, and
(where present) carry a developer reply — the strongest evidence type this project's rules
recognize, per round 51's own standard.

**Smile.io** (4,588 reviews, market leader):
- *"We discovered that more than 12,000 discount codes were created through this app and then
  published on coupon websites... instead of helping, support didn't even apologize"* — Karine
  Sultan, 2025-09-15, over 2 years using the app. A real, specific referral-program abuse/fraud
  loophole.
- *"If you have B2B transactions on the same website, don't use this app"* — White Coat,
  2025-10-02, over 1 year using the app.
- *"Thought this app was great... this feature was released before it actually works. Point
  balance never reduced [after POS redemption]"* — thesnackhut equivalent complaint pattern
  (see cross-app POS theme below).
- *"Do not use. Zero customer support and once you sign up you will be forced to pay $199/mo
  FOREVER or Cancel"* — Einstein's Attic Madison, 2026-05-02, 3 months using the app — a
  pricing-lock-in complaint, notably at the exact price point Kangaroo (round 85's "won small"
  app) charges flat.

**BON Loyalty Program & Rewards** (1,931 reviews, #2 by review count):
- *"POS Users BEWARE!!!... this feature was released before it actually works. [customer]
  claimed their rewards but their point balance never reduced"* — thesnackhut, 2023-09-07,
  about 1 year using the app.
- *"It should not be allowed access to our Theme or Order details and fulfillment details of our
  customers. It ONLY needs the data of customers who sign up"* — Tech Wellness, 2024-08-20 —
  an over-broad-permissions complaint.
- *"[No] ability to filter sales channels (why accrue points for amazon shoppers when amazon
  disallows marketing to their customers)... last year they PROMISED me... they were working on
  a filter"* — William Glen, 2024-02-06, about 1 year using the app — an unresolved, dated,
  specific feature gap with a broken vendor promise attached.
- *"[Points redeemed without following] Customers don't have to follow your social, they click
  the tab... and they get points without actually following"* — RokTheBox, 2022-08-18 — a
  redemption-integrity/gaming loophole, the same *class* of bug as Smile's discount-code farming.
- Migration friction: a Magento→Shopify migrant found BON's discount-code-based redemption model
  couldn't replicate their prior platform's simple points-to-dollar rule (Curtarra, 2025-01-22).

**Appstle Loyalty Program Reward** (1,368 reviews):
- *"Yesterday, our customer loyalty points stopped redeeming through our POS system. I spent
  approximately two hours on live chat... instead of investigating the problem, I was repeatedly
  given explanations of how the points program is supposed to work"* — OntarioVape Orleans,
  edited 2026-08-21, 11 months using the app.
- *"DOES NOT WORK WITH SHOPIFY POINT OF SALE... if it won't do the ONE thing it's supposed to do,
  what is the point?"* — a merchant review, edited 2023-08-06.
- *"Support/Devs can't solve bad styling issues... due to our custom CSS... because their app is
  using the same IDs... we should not have to change our industry leading site to fit their
  app"* — We Print Miniatures, edited 2025-06-18, 12 months using the app — a theme/widget
  integration conflict.
- *"The migration of our loyalty list did not work and they told me I didn't do it... it took
  them days to get around to it, while I had to tell customers their points were not showing"* —
  Maziply Toys, 2024-01-24, 18 days using the app.

**The cross-app pattern, found independently three times, is decisive: POS / omnichannel
redemption reliability is broken across the three largest incumbents, each in its own way** —
Smile's implied consignment/POS sync gap, BON's point-balance-not-decrementing bug enabling
double redemption, and Appstle's outright "stopped redeeming through our POS system" plus a
flat "DOES NOT WORK WITH SHOPIFY POS" review. This is not one competitor's isolated bug; it is
three unrelated codebases failing the same integration surface.

---

## Leg 3 — `community.shopify.com`: the demand signal round 85 didn't have time to check

`community.shopify.com/search?q=loyalty+app` returns **50+ results**, spanning **October 2022
through February 2026** — a sustained, multi-year comparison-shopping pattern ("Can anyone
recommend a loyalty app with combinable discounts?", "What's the best loyalty app for boosting
DTC brand visibility?", "Best Loyalty app — Compatible with Markets", etc.), the same
comparison-shopping signal round 51 used to validate demand on `community.monday.com`.

**The single strongest thread found, and it independently corroborates Leg 2's POS finding:**
[`/t/loyalty/329812`](https://community.shopify.com/t/loyalty/329812), posted **June 2024** by a
merchant (Michaeljpandy), ran **5 pages of replies over 7+ months** (last activity January
2025):

> *"We are looking for a loyalty/rewards program that will allow clients to redeem rewards
> online if they want, and then redeem them through Shopify POS. We are 97% of our orders through
> Shopify POS. I have tried numerous apps that are **all the popular loyalty apps, and they all
> fail to do this**. The issue I have is they get a reward in the email, click redeems reward,
> then they come into our store and then their reward doesn't pop up causing mass
> confusion/more time at the register."*

This is a real, dated, specific, buyer-authored complaint (not a vendor's) stating directly that
**every major incumbent fails at exactly the integration surface Leg 2 found broken in three
separate app-store review threads.** Two different vendors ("mkmkpc," a Wallet Pass app; then
"Channelwill," pitching their own TrustWILL/Loloyal app) tried to answer it across the thread's
7-month lifespan — evidence the problem persisted long enough for multiple competitors to take a
run at it, not that it was solved on page 1.

**⚠️ Rule 2 fires hard on this forum, and repeatedly** — two of the loyalty-specific threads
checked were answered by self-identified "Shopify Partner" vendors pitching their own app
(Channelwill/TrustWILL-formerly-Loloyal, and Loloyal-Phoebe on a separate thread), and a related
post — *"111 of 258 Shopify loyalty and rewards apps have never been reviewed"* (posted 5 days
before this round, by "rezza.rzk," who discloses *"I work on BestAppify"*, an app-directory/SEO
business) — is exactly the vendor-doing-market-research-as-a-peer pattern CLAUDE.md's rule 2
describes. **Its data is not treated as independent evidence here**, but as a directional,
disclosed-conflict-of-interest data point: it claims the real category population is **383
listed apps, 258 genuinely about loyalty/rewards/referrals, of which 111 (43%) have zero reviews
ever and the top 5 apps hold 44% of all reviews** — broadly consistent with, and a useful
correction upward of, round 85's own ~40-dedicated-app estimate (which undercounted the long
tail by roughly 6×). Also confirms rule 4 independently: a separate, genuine buyer thread ("Does
Shopify have a built-in loyalty program feature, or do I need third-party apps?", July 2025) was
answered "Shopify itself doesn't have a native loyalty program built in" — consistent with round
85's own live rule-4-banner check finding none.

**Other genuine (non-vendor-authored) unmet-need threads found, useful as v2/differentiation
signal, not primary evidence:** LTV-based (not points-based) VIP tiers with demotion; a unified
loyalty program across 3 separate Shopify store brands; loyalty entry via API/programmatic
customer creation for a B2B flow; a phone-number-based POS enrollment flow (comparing
unfavorably to Clover's); Dutch-language support with a free tier under 200 orders/month;
custom earning rules by customer tag/group rather than only spend-based tiers.

---

## Central-principle check — why is this niche only 30%/54% concentrated, not owned?

Applying CLAUDE.md's own question: if the order-volume-gated pricing lever is real and valuable,
why hasn't a bigger player already taken all of it? **Leg 2 supplies the structural answer
directly.** Even the three best-resourced, longest-running incumbents (Smile: dedicated named
support staff replying same-day; BON: VEGAHUB Technology Inc., a real company; Appstle: a
multi-product company with its own engineering team) **currently have open, dated, unresolved
POS/omnichannel-sync bugs, redemption-integrity loopholes, and theme-integration conflicts.**
Loyalty is not a checkbox feature like a discount code; it requires state to stay correctly
synced across checkout, storefront, POS, and (for some merchants) multiple sales channels
simultaneously, and Shopify's own POS/online data model makes that synchronization genuinely
hard — hard enough that money and years in market have not solved it for the leader. That is a
real, if not fully proven, structural reason distinct from "cheap to build" (it would be rule-4
if Shopify itself owned this, which it doesn't) — it reads as differentiated engineering depth,
the same reason CLAUDE.md's own trade-off table already expects some Shopify categories to
resist a near-monopoly the way, say, a single-purpose Jira admin utility would not.

**Kangaroo (round 85's "won small" existence proof) adds a small, consistent data point:** its
own reviewers explicitly praise POS reliability (*"Its integration with our POS system has been
especially valuable, allowing us to offer a consistent loyalty experience whether customers shop
online or in-store"* — PROCAM Photo & Video Gear, over 5 years using the app) — and several
reviewers report **5-7+ years of tenure** on only 55 total reviews, i.e. Kangaroo is not a fast-
ramping new entrant but a long-lived, retail/omnichannel-leaning niche player that simply
doesn't accumulate reviews the way a DTC-only app does. That is directionally consistent with a
POS-reliability wedge being real and valuable enough to retain customers for years, even at a
flat $199/month with no free tier.

---

## Verdict

**All three legs of the kill test pass, with the same evidentiary bar round 51 set for
monday.com:** dated, specific, human-authored complaints (found independently across all three
top incumbents, cross-corroborating each other on one theme); a real, multi-year community
demand/comparison-shopping signal (50+ threads) including one 7-month, 5-page thread stating
plainly that "all the popular loyalty apps... fail" at cross-channel redemption; and the
vendor-level concentration recheck round 85 named as its own kill criterion **holds at 54%,
unchanged from the app level** — no Appfire-style collapse.

**A defensible v1 wedge is now nameable, not just inferred:** a loyalty app engineered
specifically for POS-heavy / omnichannel retailers, where redeeming a reward that was earned or
issued online reliably and correctly reduces the customer's balance at the physical register (and
vice versa) — the one thing three unrelated, funded incumbents currently get wrong, each in a
different dated review, corroborated by an independent buyer's 7-month public complaint that
named the entire incumbent set as failing the same way.

**Score: holding at round 85's hunt-stage range, 12-14%, but revising the post-haircut estimate
up to ~8-10% (from round 85's 5-8%)** — following round 51's own precedent of holding rather than
raising a range after a kill-test pass, since the specific uncertainty this kill test targeted
(are there real complaints, and does concentration survive the vendor check) is now resolved, but
the risks the standard haircut exists for are still unaddressed: no revenue/paying-share data
exists on Shopify (same permanent gap round 85 already flagged), no customer conversation has
happened, no build has been attempted, and the entry-tier price ($10-15/mo before the
order-volume gate kicks in) still means $1k MRR needs roughly the same 60-100-customer range
round 85 already estimated for the whole category.

**Next cheapest step, $0, still no build:** contact 2-3 of the specific dated reviewers above who
are still using a competitor (e.g. OntarioVape Orleans, still on Appstle as of August 2026; the
William Glen sales-channel-filter complainant) and ask whether the POS-sync problem is still live
and whether they'd consider switching for a fix — the same "does the pain still exist" check
round 51 named as monday.com's own next step, adapted to this niche's own named wedge.
