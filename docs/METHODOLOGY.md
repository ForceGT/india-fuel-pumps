# Methodology

This document explains *how* this dataset is produced and *why* it's shaped the way
it is — no prior context assumed. If you just want the field-by-field schema, see
[DATA-DICTIONARY.md](./DATA-DICTIONARY.md) instead; this doc is about the reasoning
behind the design, not the reference itself.

---

## What "git scraping" means, and why this repo uses it

Most scrapers dump their output into a database that only the scraper's owner can
query. This repo does something different, sometimes called **git scraping**: the
scraper's output is committed directly into this git repository as plain files, and
every commit is a permanent, publicly-diffable snapshot of the data at that point in
time.

That has a few concrete consequences:

- **No database, no API server, no hosting bill.** The data lives in git. Anyone can
  clone the repo, or fetch the raw files over HTTPS from GitHub or a CDN mirror (see
  the Quick Start in the main [README](../README.md)) — there is no backend to go
  down, rate-limit you, or require an API key.
- **Every change is a diff you can inspect.** `git log -- dataset/` shows every
  update ever made. If a pump's price changed, or an outlet disappeared, that's a
  visible commit, not a silent overwrite.
- **History is free.** Because commits accumulate, you get a time series of the
  Indian fuel-retail market's pricing and footprint for free, without having stood up
  any infrastructure for it in advance.
- **Trust is verifiable.** Because the pipeline code that produced any given commit
  is itself in this repo (and the CI logs for scheduled runs are public), you can
  check *how* a number was derived, not just take it on faith.

The tradeoff is that git isn't a real database — there's no query language, and a
consumer has to fetch whole files rather than run a `WHERE` clause. The
[geohash-sharding scheme](./DATA-DICTIONARY.md#step-5-from-one-outlet-to-one-published-dataset) exists specifically
to make that tradeoff cheap: a map client only downloads the shards covering the area
it actually needs, instead of the whole country.

---

## What `capturedAt` actually guarantees

Every record carries a `capturedAt` timestamp — the moment this repo's crawler last
successfully fetched *that specific outlet's page* and parsed a result from it. It is
**not**:

- the time the outlet's price last changed (we don't know that — only the OMC does),
- the time the national dataset was last rebuilt (see `dataset/release-stats.json`'s
  `generatedAt` for that), or
- a guarantee that the outlet is still open today (see staleness pruning, below).

It **is** a hard lower bound on freshness: if `capturedAt` says a record was captured
3 days ago, then as of 3 days ago, that outlet's page returned exactly what's stored
here. How much can change in 3 days is up to real-world price volatility, not this
pipeline.

**Staleness pruning.** Each brand's scraper re-checks any outlet not captured within
`{BRAND}_CENSUS_MAX_AGE_DAYS` (3 days, by default) on its next run. An outlet not
successfully re-captured within `{BRAND}_CENSUS_STALE_AFTER_DAYS` (14 days) is pruned
from the published dataset entirely — the assumption being that an outlet the source
hasn't returned valid data for in two weeks is more likely closed, relocated, or
broken upstream than merely slow to re-crawl.

---

## Why the dataset has no grade classification

`RawOutletRecord` has no `grade`, no `confidence`, no "is this E0" field — and that's
deliberate, enforced at the type level (see `src/types.ts`). Every product name and
price a source reports is captured exactly as written: if IOCL's page shows "XP100",
this dataset stores the string `"XP100"`, not a inferred classification of what
`"XP100"` means.

The reason is separation of concerns. Deciding what counts as "ethanol-free" (or any
other classification) requires domain judgment calls — how to handle ambiguous
product names, how confident to be in an inference, how to treat sources that
disagree — that are a **downstream consumer's job**, not this pipeline's. Baking a
classification in here would mean every consumer inherits this repo's specific
judgment calls whether they want them or not. The [E0 Finder](../README.md#related-projects)
project is one example of a consumer that applies its own classification logic on
top of these raw records; a different consumer could apply a different one from the
same underlying data.

---

## Why city/state/name are not reconciled against any external list

`city` and `state` in this dataset are the **raw strings the source itself reported**
— usually a breadcrumb or address field on the outlet's page — not looked up against
a gazetteer, not deduplicated across spelling variants ("Bengaluru" vs "Bangalore"),
and not corrected for typos. Same for `name`: if the source's live per-outlet page
disagrees with that same source's static roster/CSV (dealer names change, franchises
get reassigned, signs get repainted), the **live per-outlet page always wins** — it's
the more authoritative signal at capture time.

This is intentional for the same reason as the grade-agnostic boundary above:
normalizing city/state names requires picking a canonicalization scheme (which
gazetteer? which transliteration convention?), and different consumers may already
have their own. Storing the raw, unreconciled value lets any consumer apply whichever
scheme fits their use case, instead of inheriting one baked in here.

---

## Why `categories` isn't equally trustworthy across brands

The grade-agnostic boundary above means this repo asserts **zero** opinion on
product classification. `categories` (company-owned/company-operated status
and similar outlet-format flags) is a different situation: this repo *does*
assert something here, but at three genuinely different confidence levels
depending on the brand, and a consumer that treats all of them as equally
reliable will draw wrong conclusions.

- **BPCL — closest to ground truth.** `fuelStationCategory` values (e.g.
  `"Owned_Operated"`) come from re-querying BPCL's own live locator API
  filtered to one category at a time — the same backend BPCL's own app uses.
  It's reverse-engineered (no public docs), but it's BPCL's own system
  classifying BPCL's own outlets.
- **IOCL — a verified heuristic, not a live signal.** IOCL's API exposes no
  ownership field at all. `"COCO"` is derived from a case-insensitive
  substring match on the outlet's own name (verified against IOCL's own
  naming convention, not fabricated), and `"Swagat"` from a static,
  hand-verified list coordinate-joined against IOCL's official Swagat
  program page (see `src/parsers/iocl.ts`). This has good precision but
  incomplete recall — an IOCL outlet with neither signal is *unknown*, not
  confirmed non-COCO.
- **HPCL, Jio-bp, Nayara, Shell — a one-time community cross-reference.**
  These four brands report no ownership signal of their own at all. Their
  `categories` come entirely from a single coordinate-join against a
  crowdsourced Google Maps list, run once by hand (see
  `src/build-community-coco-list.ts`), not from anything the brand itself
  publishes.

The practical rule for any consumer: `categories` is a **whitelist of
confirmed positives, not a complete classification**. An empty array means
"not confirmed by whichever signal that brand has," never "confirmed not
this category" — and the strength of a "confirmed" varies by exactly which
brand and which signal produced it, per the tiers above.

---

## How outlets are deduplicated (`stationId`)

A single physical fuel station can appear more than once in a source's own data (a
sitemap listing an outlet under two slightly different URLs, for instance), and the
same physical station will never appear across two different brands' raw JSONL files
(each brand only reports its own outlets) but can, in principle, be captured multiple
times across days as `capturedAt` refreshes accumulate.

`stationId` is a stable hash derived from `{brand, outletId, lat, lng}` (see
`src/id.ts`) — the same physical outlet, re-captured on a later day, produces the
same `stationId`. When `build-dataset` assembles the final sharded output, it groups
all raw records by `stationId` and keeps only the one with the latest `capturedAt`
per station — so the published dataset never contains duplicate rows for the same
outlet, and always reflects the most recently captured version of it.

---

## Further reading

- [DATA-DICTIONARY.md](./DATA-DICTIONARY.md) — the field-by-field schema reference.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — how the pipeline code itself is structured.
- [RUNBOOK.md](./RUNBOOK.md) — how to actually run the scrapers, including the FAQ.
