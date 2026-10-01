# Round 96 — platform, competitor, and demand-signal refresh

**Date:** 2026-10-01. **Purpose:** the rounds 94/95 baseline is dated 2026-09-17/18; this round
re-verifies it two weeks later via three parallel passes (Shopify platform docs, competitor
listings/changelogs, community demand signals), each run as an independent live-web check rather
than a re-read of prior rounds. **Net effect: baseline holds; one factual correction (a $19
registration fee), one strategic watch item (native store credit as a redemption rail), and a
visibly narrowing marketing-differentiation window (Joy shipping POS monthly, a small entrant
marketing this repo's wedge claim verbatim).**

## 1. Platform re-verification (shopify.dev, fetched 2026-10-01)

Everything load-bearing re-confirmed:

- **POS UI Extensions**: `pos.customer-details.block.render` and `.action.render` both exist;
  loyalty is still a named use case ("Your extension can show customer loyalty points…");
  authenticated-fetch-to-own-backend is still the documented pattern (extensions auto-include
  authorization headers on requests to the app's domain). Cart API confirmed at
  `/pos-ui-extensions/2026-07/apis/cart-api`: `applyCartDiscount`, `setLineItemDiscount`,
  `addCartCodeDiscount`, bulk variants. Current stable API version **2026-07**.
- **Shopify Functions** remain the current discount mechanism; no deprecation on the page.
- **GraphQL-only** for new public apps (since April 1, 2025): restated verbatim in current
  app-store requirements. Unchanged.
- **Revenue share**: 100% of first $1M USD gross/year, 85% above, 2.9% processing fee. Unchanged.
- **GDPR webhooks** (`customers/data_request`, `customers/redact`, `shop/redact`): still mandatory
  "regardless of whether the app collects personal data"; missing endpoints ⇒ rejection. Configured
  via `compliance_topics` in the app TOML.
- **Dev MCP**: `npx -y @shopify/dev-mcp@latest` still the documented install; the exact
  `claude mcp add` command in `CLAUDE.md` is what shopify.dev shows. `@shopify/cli` is now 4.8.3
  (major 4); `@shopify/dev-mcp` 1.16.0.
- **Webhook reliability**: Shopify's own webhooks doc now states it plainly — "Webhook delivery
  isn't always guaranteed… use reconciliation jobs to periodically fetch data from Shopify so that
  your app stays consistent," and ordering within/across topics is explicitly not guaranteed.
  **This is first-party endorsement of the reconciliation-job invariant `CLAUDE.md` already
  mandates** — quotable in listing copy ("we do what Shopify's own docs say apps must do").

### CHANGED: there is a one-time $19 App Store registration fee

The rounds 94/95 claim "no submission fee" is **outdated or was incompletely checked**. The
revenue-share page now states access to the revenue-share plan requires registering with the
Shopify App Store for a **one-time fee of $19 USD per Partner account** — corroborated by
community.shopify.dev threads (it applies even to unlisted-app review). It is one-time,
per-Partner-account, not per-submission and not recurring. Materially trivial (inside the existing
$100-500 budget), but the docs' "no fee, self-serve" language needs the correction — and it's a
useful reminder that even two-week-old "confirmed from primary docs" facts drift.

### Additive changelog items worth tracking (all Sept 2026)

- **2026-09-17**: `session.currentSession.staffMemberId` removed from POS UI Extensions as of
  2026-10. Irrelevant unless ledger entries ever attribute POS redemptions to specific staff —
  if staff attribution becomes a feature, check the migration path first.
- **2026-09-30**: discount apps can register `shopify/Discount` **app intents** so Sidekick can
  launch the app's create/edit flows. Optional, additive; a cheap discoverability win to note in
  the spec, not a v1 requirement.
- **2026-09-18**: `automaticDiscounts` query removed in Admin API 2027-01 — scaffold against the
  replacement if the backend ever queries discounts.
- **2026-09-22/29**: Events subscription query complexity capped at 100 points; "Shopify App
  Pricing" is clearly the billing direction (unlimited private plans, migration of existing
  subscriptions). **Check Shopify App Pricing before implementing billing** rather than assuming
  older Billing API patterns from the dossier.

## 2. Competitor refresh (apps.shopify.com, fetched 2026-10-01)

Counts drifted only slightly in two weeks; concentration read unchanged:

| App | Round 94/95 | Round 96 | Note |
|---|---|---|---|
| Smile | 4,588 | 4,617 (4.9★) | Mid-tier now $79; top tier $199 stands |
| BON | 1,931 | 1,948 (5.0★) | Pricing unchanged; POS gated to $29+ |
| Joy | 1,786 | 1,790 (4.9★) | **Slug changed: now `apps.shopify.com/joyio`** (old `/joy-loyalty` 404s); new $499 Ultimate tier; POS still gated at $129 Advanced |
| Appstle | 1,368 | 1,405 (5.0★) | **Fastest grower; now Built for Shopify**; POS from $10 — cheapest POS entry |
| Kangaroo | 55 | 56 (4.9★) | $199 flat, 1,000 orders incl., $0.20/order after |
| Rivo | 1,386 | 1,448 (**4.7★**, down from 4.8) | POS from $15 tier |
| Growave | 1,226 | 1,296 (4.8★) | POS QR gated to $199 Growth |
| Love Loyalty | 358 | 371 (5.0★, Built for Shopify) | Now Free/$12/$79/$399; **POS only on $79+** |

**No new 1-3★ POS/sync reviews since ~2026-09-15 on any of the eight apps** — the newest filtered
1-3★ reviews predate the window everywhere (Appstle's newest is OntarioVape's 2026-08-21 edit).
The thesis still rests on the pre-existing dated evidence; two quiet weeks neither strengthen nor
weaken it.

**New evidence for the wedge, found this round (predates the window but not in the baseline):**
**Rivo / Firepot, 2025-09-03, 1★** — a Klaviyo-integration failure after which "Rivo set the
points balance of every single one of our customers...to zero" (~23,000 customers), 3+ day support
delay, generic developer reply. This is the single best third-party evidence yet for the
append-only-ledger thesis: a mutable-balance architecture can mass-zero; an append-only ledger
structurally cannot (the worst case is a missing entry, which reconciliation self-heals).
Worth citing in listing copy and the design-partner pitch alongside the POS-sync reviews.

**Baseline defects: all still publicly unresolved.** BON's refund-reversal (Tulsa, no dev reply,
no changelog entry — only *referral*-reward revocation shipped 2025-10-15), BON's channel-filter
gap (William Glen, 2024 partial-workaround reply only), BON's referral redirect (2026-06-02,
unanswered), Appstle's POS outage (no dev reply). No vendor "fixed" statement found anywhere.

**The marketing-differentiation window is narrowing:**

- **Joy is the most aggressive POS shipper** — roughly monthly POS-touching releases through
  Sept 2026 (v1.202: loyalty page rebuild, store-credit earning, QR deep-linking; earlier in 2026:
  POS wallet-pass QR enrollment, POS points-preview tiles). Round 95's "untested marketing claim"
  framing is aging; spike 0 (hands-on POS test of Joy + Love Loyalty) matters more, not less.
- **New watch-list entrants** (not in rounds 94/95): **BLOY** (840 reviews, 5.0★, launched
  2024-10, Free/$10/$49/$129, markets POS integration) and **Nector** (~89 reviews, which markets
  "**real-time sync between web and POS**" — this repo's wedge claim, verbatim, POS from $179/mo).
  Neither is tested; Nector in particular means "nobody even claims this" is no longer sayable —
  differentiation must be *proven* reliability (append-only ledger + reconciliation + the Firepot
  counter-example), not the claim itself.

## 3. Demand signals (community.shopify.com, fetched 2026-10-01)

- **The key thread (`/t/loyalty/329812`) is now ~19 months old and still live** — replies dated
  Nov 2025, Nov 2025, and Jan 21, 2026. The OP's complaint is unchanged and unfixed. Notably,
  **three vendors (Froonze, AiTrillion, TrustWILL) have now posted marketing replies into it** —
  claims, not demonstrated fixes; the pain point is being used as a sales hook, which itself
  confirms vendors see demand here. The dossier's promotion plan (post a working demo there) now
  enters a thread with competing claims in it — a demo video outcompetes a marketing reply, but
  "first real answer" is no longer the framing.
- **Three more on-thesis threads** (new to the dossier, all within the last ~13 months):
  "No native loyalty program?!? mind boggling" (Feb 2026 — "POS and Online does not push sync and
  sometimes takes hours to update"), "Shopify POS" (Feb 2026 — can't reliably apply account-level
  store credit at POS checkout), "Loyalty redemption for Shopify POS" (Aug 2025 — wants points as
  POS payment, not a discount-code workaround).
- **All three named kill-test reviewers verified still live and unresolved** — OntarioVape Orleans
  (Appstle, edited 2026-08-21, no dev reply), William Glen (BON, 2024, partial workaround only),
  Tulsa Body Jewelry (BON, updated 2025-06-23, no reply to the update). The `START-HERE.md`
  outreach list stands exactly as written.
- **Reddit could not be checked** — reddit.com blocks the crawler used for this pass. No claim
  either way about Reddit signals; needs a human browser session if it matters for the kill test.

### New strategic watch item: Shopify's native store-credit ledger

2026 commentary (e.g. BLOY's April 2026 platform-updates post) describes loyalty apps migrating
redemption onto **Shopify's native store-credit ledger**, which is natively visible at checkout in
new customer accounts. If store credit becomes the common redemption rail across POS and online,
Shopify's own ledger starts absorbing part of the sync problem this app exists to fix — though the
Feb 2026 threads above show account-level store credit still fails to apply reliably at POS today.
**Add to the spike list: should this app's redemption rail *be* native store credit** (points
ledger stays ours, redemption converts points → store credit via the Admin API) **rather than a
discount-based mechanism competing with it?** This could simplify both integration surfaces and
future-proof against the platform — or founder on the same POS store-credit reliability gaps the
threads describe. A dev-store spike answers it cheaply. No evidence of native *loyalty* (earning,
tiers, rules) shipping or being announced — loyalty remains app territory per Shopify's own
non-committal Feb 2026 staff responses.

## Net effect on rounds 94/95 conclusions

- Platform facts: **confirmed**, except the **$19 one-time registration fee correction** (§1).
- Concentration, pricing, review-count reads: **confirmed within drift**; Appstle growing fastest
  and now Built for Shopify; Rivo's rating slipped to 4.7★.
- Demand: **strengthened** (thread still accumulating into 2026; three more threads; all named
  reviewers' complaints live and unresolved; Rivo/Firepot mass-zeroing adds a new evidence class).
- Competitive urgency: **raised, not lowered** — Joy's monthly POS shipping cadence and Nector's
  verbatim wedge marketing mean spike 0 (hands-on incumbent POS testing) and the switcher-first
  GTM from `PRODUCT-PERSPECTIVES.md` are both more load-bearing than they were two weeks ago.
- Score: no basis to move the 8-10% P(≥$1k MRR by month 12) either direction. The blocker remains
  the same one thing: the three customer conversations in `START-HERE.md`.

## Sources

Fetched 2026-10-01: `shopify.dev/docs/api/pos-ui-extensions{,/targets,/2026-07/apis/cart-api}`,
`shopify.dev/docs/apps/build/{discounts,webhooks,devmcp,privacy-law-compliance}`,
`shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements`,
`shopify.dev/docs/apps/launch/distribution/revenue-share`, `shopify.dev/changelog`,
`community.shopify.dev/t/does-shopify-charge-19-for-unlisted-app-review/7880`;
`apps.shopify.com/{smile-io,bon-loyalty-rewards,joyio,appstle-loyalty,rivo-loyalty,growave,kangaroo-rewards,loyalty-program-2,bloy-loyalty,nector-rewards-loyalty}`
(+ each `/reviews?ratings[]=1&2&3`), `bonloyalty.com/changelog`, `help.joy.so/product-roadmap/changelog`,
`news.smile.io`, `nector.io`; `community.shopify.com/t/loyalty/329812`,
`.../t/no-native-loyalty-program-mind-boggling/586848`, `.../t/shopify-pos/586863`,
`.../t/loyalty-redemption-for-shopify-pos/560740`,
`bloy.io/blog/shopify-updates-news-2026-what-actually-impact-your-revenue/`.
