# Product perspectives — independent assessment

*Written 2026-09-18, one day after the dossier in `PRODUCT-SPEC.md`. This is a separate voice on
purpose: the dossier is a research pipeline's output (idea-lab, rounds 85-94); this is my own
read, layered on top, including where I'd push back. Treat disagreements here as things to weigh,
not corrections — the dossier's primary-source evidence (dated reviews, the 7-month thread,
Shopify's own docs) stands regardless of what I think about the framing.*

## Where I agree, and why it matters

The core finding is unusually strong for a solo-dev-scale bet: three independent incumbents have
dated, specific, first-person evidence of the *same* structural defect, not a vague "customer
service is slow" complaint. That's a rare thing to find pre-build. Combined with a submission gate
that's genuinely cheap (no fee, no mandatory audit) and a kill test that costs literally nothing
but three messages, the downside here is about as bounded as an app-store bet gets. I'd take this
combination — strong specific evidence + cheap kill test + cheap submission — as the real reason to
attempt this, more than the $1k MRR number itself, which is a modest bar either way.

## Where I'd push back

**The MRR model assumes discovery works, and I don't think it's obviously true.** The three named
reviewers are *already in pain* — they'll respond to direct outreach regardless of how the app is
discovered. But the base-case scenario (22 customers, $50/mo blended) assumes broader ASO-driven
discovery against "POS loyalty sync" and similar queries. A merchant who hasn't yet been burned by
a competitor's POS bug isn't searching for the fix to a problem they don't know they have — they're
searching "shopify loyalty program," landing on a results page ranked substantially by review
count and install signal, where a zero-review new entrant starts at a real disadvantage against
Smile's 4,588. The named-defect ASO strategy in the dossier's Promotion plan works well for the
narrow population of *already-frustrated switchers* (small, findable, high-intent) and much less
well for cold discovery (the volume the base case actually needs). I'd treat the switcher
population as the real near-term addressable market, not a bridge to it.

**That reframing changes the go-to-market, concretely.** Don't wait for a public listing to
onboard the first real users — the 3-5 named, dated, still-frustrated reviewers already identified
(OntarioVape Orleans, William Glen, Tulsa Body Jewelry, Dream Nu) are a design-partner list, not
just a validation-call list. If the kill test passes, the highest-leverage next move isn't
"build in isolation for 11-14 weeks then submit" — it's building the smallest working slice against
one real store's actual product/order data as an unlisted custom app, getting it right for one
paying switcher, *then* generalizing. This de-risks the build (you're validating against a real
POS terminal and real transaction volume, not a synthetic dev store) and produces the first 1-2
reviews before the cold-start problem above even becomes relevant.

**A migration/import tool is underweighted.** Every named switcher candidate has an existing
points balance sitting in a competitor's database. "Switch and lose your customers' accumulated
points" is a real adoption blocker the dossier doesn't price in. A CSV or API-based balance-import
tool (even a manual, white-glove one for the first few customers) turns "would you switch" from a
hypothetical into something with a concrete zero-loss migration path — worth scoping as part of
the same kill-test conversation, not a v2 afterthought.

**Reconciliation-as-marketing, not just reconciliation-as-implementation.** `CLAUDE.md` already
states the technical requirement (poll the Admin API as a backstop against dropped/delayed
webhooks — don't trust push delivery alone). The product angle: this is the actual, provable answer
to "why would this app not have the same bug in a year." Incumbents' bugs read as webhook-trust
failures under load, not as bugs nobody thought of. "We reconcile against Shopify's own order
history on a schedule, so a dropped webhook can't silently drift your ledger" is a specific,
falsifiable claim worth putting in the listing copy once it's actually true — stronger than
generic "reliable POS sync" marketing language, and harder for a reviewer to accuse of being
unverifiable.

**Platform concentration risk is real and structurally undiversifiable.** Round 93 already closed
the second-listing search — this is a single-bet-on-one-platform's-API-surface product. POS UI
extensions are a comparatively young API surface (the dossier's own spike list treats "does this
even work reliably" as still partly open). I don't think this changes the call — the evidence for
demand is too specific to ignore — but I'd hold the 11-14 week estimate loosely and treat spike 2
(webhook latency) and the offline-race spike as true go/no-go gates, not schedule risk to absorb
silently. If either breaks, the honest move is the re-scope the dossier already names (checkout-only
v1, POS as v1.x), not quietly extending the timeline to force the original scope through.

## Addendum (2026-09-18, after round 95)

Round 95's independent re-check found one thing worth folding back into the paragraphs above:
**Joy Loyalty already markets a POS loyalty extension**, untested by either research pass. This
sharpens rather than undercuts the ASO-discovery skepticism above — if a cold-discovery merchant
searches generically and lands on Joy first, a claim like "POS sync" isn't even a differentiator
to them unless Joy's version is demonstrably worse, which is currently unverified. Spike 0 in
`PRODUCT-SPEC.md` (install and POS-test Joy) isn't just a competitive-accuracy check anymore — it's
load-bearing for the switcher-first GTM this doc argues for, since "here's specifically why we're
different from Joy" is a much stronger design-partner pitch than "here's why we're different from
the three apps you may not even be using."

## Net read

I'd rate this a reasonable bet at the size the dossier proposes it at: cheap to falsify, evidence
is specific rather than vibes-based, and the failure modes are legible in advance rather than
discovered mid-build. The 8-10% P(≥$1k MRR by month 12) estimate feels about right *for the ASO-led
base case* — but I think the realistic path to clearing that bar runs through the design-partner
motion above more than through marketplace search ranking, and the estimate should probably be read
as a floor if that motion is executed deliberately rather than treated as a launch afterthought.
