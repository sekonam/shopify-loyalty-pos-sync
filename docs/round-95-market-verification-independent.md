# Round 95 — independent market/competitor re-verification

**Date:** 2026-09-18. **Purpose:** a second, independent pass over round 94's dossier claims —
re-check the numbers, look for competitors the original pull missed, and check whether the "no
incumbent solves POS sync" framing survives a closer look. Run one day after round 94, via live
web search against `apps.shopify.com` and `community.shopify.com`, not a re-read of round 94 itself.

## 1. Review counts and pricing — dossier confirmed, within noise

| App | Round 94 | Round 95 | Read |
|---|---|---|---|
| Smile.io | 4,588 reviews | 4,592 reviews, 4.9★ | Confirmed (+4, timing drift) |
| BON Loyalty | 1,931 reviews | 1,932 reviews, 5.0★, 98% 5-star | Confirmed |
| Appstle Loyalty | 1,368 reviews | 1,370 reviews, 5.0★ | Confirmed |
| Joy Loyalty | 1,786 reviews | 1,786 reviews, 4.9★ | Exact match |
| Kangaroo Rewards | 55 reviews | 46-55 depending on source, $199/mo flat | Small-sample count is volatile; a $79 "Plus" tier for growing brands also appears to now exist alongside the $199 flat plan |

Pricing detail worth a correction: Smile's "freemium" label is accurate but understates the
ceiling — paid tiers start at $49/mo, VIP tiers gate to $199/mo (Growth), and **API access is
gated behind a $999/mo Plus tier**. BON's free tier appears capped at ~150 orders/mo in current
listings (round 94 didn't specify a cap).

## 2. Competitors not in round 94's table

- **Rivo** — 1,386 reviews, 4.8★, $0/$15/$49/$499/mo. Comparable scale to Appstle/Joy. Not
  previously tracked.
- **Growave** — 1,226 reviews, 4.8★, bundles loyalty + reviews + wishlist, Built for Shopify
  certified. Not previously tracked.
- **LoyaltyLion** — ~514 reviews, $199/mo flat. Smaller than the incumbent set; noted for
  completeness.
- **Yotpo Loyalty** — review count inconsistent across its multiple Shopify listings (one listing
  reads ~900, another, differently named ("swell"), reads 2,200+); 4.7★. Needs a listing-specific
  re-check before citing a number, not resolved this round.

None of these change the concentration read materially (Smile/BON/Joy/Appstle still dominate by a
wide margin), but Rivo and Growave are large enough that a future competitive-positioning pass
(listing copy, feature comparison) should check them directly rather than assume the round
94 four-app set is exhaustive.

## 3. Material finding: Joy Loyalty already markets a POS extension — the framing needs a hands-on check

This is the one finding that should change next steps before the "no incumbent solves POS sync"
positioning goes into any listing copy: **Joy Loyalty's Advanced tier ($129/mo) explicitly
advertises a "POS loyalty extension (in-store rewards)," Shopify POS integration, and QR-code
in-store redemption.** Round 94 did not check Joy's feature marketing (its review-mining pass
focused on Smile/BON/Appstle). Smile.io also markets POS/in-store redemption as a "core feature"
in its own help docs and case studies.

This is not necessarily a contradiction of the dossier's thesis — it may sharpen it:

- A Smile help-center article titled **"Troubleshoot: POS app failed to load error"** exists,
  suggesting Smile's own POS extension has known reliability problems in the field — consistent
  with "incumbents claim this feature and it breaks in practice," not "an incumbent already solved
  it."
- A review found in this round describes Appstle's in-store-earned points **not being visible or
  usable in-store afterward** — an operational contradiction of Appstle's own POS marketing,
  again reinforcing the dossier's defect thesis rather than undermining it.
- Joy's own claim has **not been hands-on tested** by either round. It is the single highest-value
  cheap next step this round identifies: install Joy (and re-check Appstle) on a throwaway dev
  store, exercise POS earn + redeem, and confirm whether Joy's marketed feature actually works
  reliably before finalizing any "nobody solves this" language in listing copy or outreach
  messaging. If Joy's POS sync genuinely works, the wedge narrows to "everyone except Joy" and the
  competitive positioning needs to say so precisely, not generically.

**Recommendation:** add "install and POS-test Joy Loyalty + re-verify Appstle" as a spike, ahead of
writing any customer-facing claim that no incumbent solves this. This is cheap (a free dev store
and an hour), and the cost of an inaccurate competitive claim in an App Store listing — or worse,
in an outreach message to a named reviewer — is reputational, not just wasted effort.

## 4. Platform signal

Shopify has been incrementally maturing **POS UI extensions** tooling — API version 2026-04 added
`@shopify/ui-extensions-tester` for POS UI extension unit testing, with explicit loyalty-points-
display use cases in the docs. This is tooling maturity, not evidence Shopify is building loyalty
natively into POS. A February 2026 community thread ("No native loyalty program?!? mind boggling")
got no Shopify-staff roadmap commitment; a community member's own read is that Shopify deliberately
leaves loyalty to its app ecosystem as a matter of platform strategy. No evidence found of
revenue-share or app-review-process changes specific to loyalty apps since round 94's direct check.

## 5. Breadth of the complaint — stronger than round 94's single thread suggested

Round 94 cited one 7-month thread (`/t/loyalty/329812`) as the demand signal. This round found **at
least four additional, separately-dated** `community.shopify.com` threads on the same pain point:
"Loyalty Program on POS," "Loyalty redemption for Shopify POS," "How do you handle loyalty programs
on POS?," and "How to sync online and offline store loyalty programs?" — spanning September 2023
through December 2025, with recent activity. Consistent recurring themes across all of them: no
native points-as-payment-method at POS, points-as-discount workarounds, customer-record merge
failures at POS checkout. Read as a **persistent, multi-year, recurring complaint** across multiple
independent threads, not a single outlier thread — this strengthens round 94's demand-signal
finding rather than just replicating it.

## 6. Incumbent-fix race risk

No changelog, blog post, or app-update note found from Smile.io, BON, or Appstle announcing a
POS-sync fix or rebuild in 2025-2026. Combined with Smile's own troubleshooting docs still
describing POS load failures, there's no evidence a funded incumbent is actively closing this gap.
The nearest concrete competitive threat is Joy's already-shipped (marketing) claim above, and
Growave/Rivo as under-tracked mid-size players worth a feature check before finalizing
positioning — not evidence of an incumbent fix in flight.

## Net effect on round 94's conclusions

- Review counts, pricing, and the four-app concentration read: **confirmed**, no material
  correction needed.
- Demand signal: **strengthened** — four more independently-dated threads on the same defect.
- One real gap: **Joy Loyalty's POS-extension marketing claim was not checked**, and should be,
  hands-on, before any listing copy or outreach message asserts no incumbent has solved this. Added
  as a spike ahead of the existing spike list in `PRODUCT-SPEC.md`.
- No evidence of incumbent-fix race risk or platform-strategy risk (Shopify building loyalty
  natively) materializing.
