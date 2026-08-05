# India Fuel Pumps — Open Dataset

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Census workflow](https://img.shields.io/github/actions/workflow/status/ForceGT/india-fuel-pumps/census.yml?branch=main&label=census)](https://github.com/ForceGT/india-fuel-pumps/actions/workflows/census.yml)
[![Latest release](https://img.shields.io/github/v/release/ForceGT/india-fuel-pumps?label=dataset)](https://github.com/ForceGT/india-fuel-pumps/releases)
[![Outlets](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FForceGT%2Findia-fuel-pumps%2Fmain%2Fdataset%2Frelease-stats.json&query=%24.current.totalOutlets&label=outlets&color=orange)](./dataset/release-stats.json)

An open, machine-readable dataset of **every fuel pump across India's public-sector oil marketing companies, plus Shell**: HPCL, IndianOil (IOCL), BPCL, Jio-bp, Nayara, and Shell. **~103,000+ outlets**, each with location, contact, hours, and **every fuel product and price the source reports, captured exactly as-is**.

No login, no scraping of personal data. Four of the six sources are public locator websites (HPCL, IOCL, Nayara, Shell); the other two (BPCL, Jio-bp) are the same public backend APIs their official mobile apps call — see [Provenance & license](#provenance-license) for exactly which is which. No grade classification, no filtering, no assumptions about what any of it means: this is raw material, not a finished product. See [Methodology](#methodology) below for the full reasoning.

> &#x26A0;&#xFE0F; **Unofficial. Always confirm at the pump.** This data is compiled from public sources and can be out of date or wrong. Never rely on it for a decision that a wrong answer would cost you — call the pump (numbers are included) to confirm.

---

## 📚 Documentation map

This README is deliberately short. Everything else lives in one of these:

| Document | What's in it |
|---|---|
| **[docs/METHODOLOGY.md](./docs/METHODOLOGY.md)** | *Why* the data is shaped this way — the git-scraping pattern, what `capturedAt` guarantees, why there's no grade classification, why city/state aren't reconciled, how dedup works. Start here if you're new to the project. |
| **[docs/DATA-DICTIONARY.md](./docs/DATA-DICTIONARY.md)** | The field-by-field schema reference: `RawOutletRecord`, shard file format, `index.json`, worked examples per brand. |
| **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** | How the pipeline code is structured — the `Provider` interface, the resumable worker pool, the CI workflow, how to add a new brand. |
| **[docs/RUNBOOK.md](./docs/RUNBOOK.md)** | How to actually run the scrapers: prerequisites, per-brand env vars, resuming a killed run, common failure modes, and an operational FAQ. |
| **[docs/CI-CD.md](./docs/CI-CD.md)** | How the daily GitHub Actions pipeline is wired up — scheduling, worklog caching between runs, publish safety checks, and how failures get filed/auto-resolved as issues. Includes a diagram of every branch the pipeline can take. |
| **[docs/jiobp-api.md](./docs/jiobp-api.md)**, **[docs/nayara-api.md](./docs/nayara-api.md)**, **[docs/shell-api.md](./docs/shell-api.md)** | Full API references for each brand's undocumented locator/app backend — every request, every field. |
| **[CONTRIBUTING.md](./CONTRIBUTING.md)** | How to report a wrong pump, add a new brand, or submit a code change. |

---

## Quick start

**Use the data** — there's no publish step or CDN; the committed files in this repo
*are* the distribution. The dataset isn't one big file — it's split into ~200 small
**shards**, one per ~156 km geographic cell, so a consumer only downloads the area it
actually needs (see [why we shard](#why-the-dataset-is-sharded) below). Fetch the
manifest first, then just the shard(s) you want:

```js
const BASE = "https://raw.githubusercontent.com/ForceGT/india-fuel-pumps/main/dataset";

const index = await fetch(`${BASE}/index.json`).then((r) => r.json());

// Every shard is listed by its geohash-3 prefix — e.g. "te7" covers the
// Mumbai area. Pick whichever prefix(es) intersect your area of interest.
const mumbai = index.shards.find((s) => s.prefix === "te7");
const outlets = await fetch(`${BASE}/${mumbai.file}`).then((r) => r.json());

console.log(outlets.outlets.length, "outlets in this cell");
```

For anything beyond occasional fetches, clone the repo instead — `raw.githubusercontent.com` is unauthenticated-rate-limited per IP. Full consumption pattern (matching a bounding box to prefixes, loading everything for a national view, etc.): [docs/DATA-DICTIONARY.md](./docs/DATA-DICTIONARY.md#consumption-pattern).

**Run the scraper** — needs Node 20+, no API keys:

```bash
git clone https://github.com/ForceGT/india-fuel-pumps
cd india-fuel-pumps
npm install
npm run census:hpcl     # any single brand — see docs/RUNBOOK.md for the rest
npm run build-dataset   # regenerate dataset/ from the scraped output
```

---

## Coverage

| Brand | Outlets | Source |
|-------|---------|--------|
| **HPCL** | ~23,980 | `petrolpump.hpretail.in` |
| **IOCL (IndianOil)** | ~39,611 | `locator.iocl.com` |
| **BPCL** | ~27,961 | `api.cep.bpcl.in` (same backend as the "BharatGas" app) |
| **Jio-bp** | ~2,296 | `netmanager.ril.com` (the MyJio-bp app's backend API; see [docs/jiobp-api.md](./docs/jiobp-api.md)) |
| **Nayara** | ~9,065 | nayaraenergy.com "Petrol Pump Near Me" locator |
| **Shell** | ~332 | shellretaillocator.geoapp.me (third-party widget; see [docs/shell-api.md](./docs/shell-api.md)) |

Every record carries a `capturedAt` timestamp — see [Methodology](#methodology) for exactly what that does and doesn't guarantee.

Shell also separately publishes an **indicative city-level price table** (22 major cities, not per-outlet) — deliberately kept out of this dataset since it's a city-average estimate, not a fact about any specific outlet. See [docs/shell-api.md](./docs/shell-api.md) for what it is and why.

Updated **daily** by GitHub Actions; every run that changes data produces a [GitHub Release](https://github.com/ForceGT/india-fuel-pumps/releases) with a human-readable diff. Full pipeline details: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## Why the dataset is sharded

~103,000 records is small enough to just download as one file — so sharding
isn't about today's size, it's about not designing something that stops
working as the dataset grows. Splitting by geohash means a consumer only
ever pays for the area they actually care about, not the whole country, no
matter how large the dataset eventually gets. It also solves a caching
problem for free: each shard's filename is a hash of its own contents, so a
daily update that only changed prices in one city only invalidates that
city's file — everyone else's cached shards stay valid, forever, without
any of this needing a CDN, a database, or a cache-invalidation scheme of any
kind. See [docs/DATA-DICTIONARY.md](./docs/DATA-DICTIONARY.md#step-5-from-one-outlet-to-one-published-dataset)
for the full reasoning behind the shard size and the content-hash filenames.

---

## Methodology

The short version — full reasoning for each point is in [docs/METHODOLOGY.md](./docs/METHODOLOGY.md):

- **Git-as-database.** The dataset is committed directly into this repo, not served from a database — no backend to go down or rate-limit you, and every change is a plain `git diff`.
- **`capturedAt` is a freshness floor, not a change-detection signal.** It tells you when this repo last successfully re-fetched that outlet — not when its price actually changed.
- **Grade-agnostic, on purpose.** No `grade`/`ethanol`/`confidence` field exists anywhere in the schema. Classification is a downstream consumer's job (see [Related projects](#related-projects)).
- **Live source always wins.** If an OMC's static roster disagrees with that same OMC's live per-outlet page, the live page's data is what gets stored.
- **No reconciliation.** `city`/`state` are the raw strings the source reported — not corrected, not canonicalized against any gazetteer.
- **Deduplicated by `stationId`**, a stable hash of `{brand, outletId, lat, lng}` — the latest `capturedAt` wins per physical outlet.

---

## Contributing

- **Wrong or stale pump?** [Open an issue](https://github.com/ForceGT/india-fuel-pumps/issues/new).
- **Adding a new brand or changing code?** See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Provenance & license

No login is used anywhere, no personal/gated data is touched, and contact numbers are the pumps' own listed business numbers.

- **HPCL, IOCL, Nayara, Shell** are fetched from their public locator websites — the same pages/endpoints anyone's browser hits when using the "find a pump" search on each brand's own site.
- **BPCL and Jio-bp** are fetched from the same backend APIs their official mobile apps (BharatGas, MyJio-bp) call — these aren't documented publicly, but they're ordinary HTTP endpoints, not gated behind any login or app-specific authentication. See [docs/jiobp-api.md](./docs/jiobp-api.md) for Jio-bp's full request/response reference.
- Nayara's site blocks this project's honest, self-identifying `User-Agent` at the WAF level; a deliberate, documented call was made to send standard browser headers there instead — see [docs/nayara-api.md](./docs/nayara-api.md) for the reasoning.

**License: [MIT](./LICENSE)** — use it freely for anything, commercial or not; just keep the copyright and license notice. No warranty (see the disclaimer above).

---

## Related projects

- **[E0 Finder](https://e0fuel.in)** — a fast, mobile-first map that helps people in India find ethanol-free (E0) petrol. The primary consumer of this dataset, applying its own grade-classification and confidence rules on top of the raw records here.

---

Maintained by [Gaurav Thakkar](https://github.com/ForceGT).
