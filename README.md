# India Fuel Pumps — Open Dataset

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Census workflow](https://img.shields.io/github/actions/workflow/status/ForceGT/india-fuel-pumps/census.yml?branch=main&label=census)](https://github.com/ForceGT/india-fuel-pumps/actions/workflows/census.yml)
[![Latest release](https://img.shields.io/github/v/release/ForceGT/india-fuel-pumps?label=dataset)](https://github.com/ForceGT/india-fuel-pumps/releases)
[![Outlets](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FForceGT%2Findia-fuel-pumps%2Fmain%2Fdataset%2Frelease-stats.json&query=%24.current.totalOutlets&label=outlets&color=orange)](./dataset/release-stats.json)

An open, machine-readable dataset of **every fuel pump across India's public-sector oil marketing companies, plus Shell**: HPCL, IndianOil (IOCL), BPCL, Jio-bp, Nayara, and Shell. **~103,000+ outlets**, each with location, contact, hours, and **every fuel product and price the source reports, captured exactly as-is**.

No login, no scraping of private data — every source is a public store-locator. No grade classification, no filtering, no assumptions about what any of it means: this is raw material, not a finished product. See [Methodology](#methodology) below for the full reasoning.

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
| **[docs/EDGE-CASES.md](./docs/EDGE-CASES.md)** | A catalog of specific quirks and incidents per brand (WAF calibration, token expiry, cache staleness) and their root causes. |
| **[docs/jiobp-api.md](./docs/jiobp-api.md)**, **[docs/nayara-api.md](./docs/nayara-api.md)**, **[docs/shell-api.md](./docs/shell-api.md)** | Full reverse-engineering write-ups for each brand's private/undocumented API — every request, every field, and how it was found. |
| **[CONTRIBUTING.md](./CONTRIBUTING.md)** | How to report a wrong pump, add a new brand, or submit a code change. |

---

## Quick start

**Use the data** — there's no publish step or CDN; the committed files in this repo
*are* the distribution. Fetch them directly:

```js
const index = await fetch(
  "https://raw.githubusercontent.com/ForceGT/india-fuel-pumps/main/dataset/index.json"
).then((r) => r.json());

// Fetch only the shards covering your area of interest — see
// docs/DATA-DICTIONARY.md#consumption-pattern for the full pattern and shard format.
const shard = await fetch(
  `https://raw.githubusercontent.com/ForceGT/india-fuel-pumps/main/dataset/${index.shards[0].file}`
).then((r) => r.json());
```

For anything beyond occasional fetches, clone the repo instead — `raw.githubusercontent.com` is unauthenticated-rate-limited per IP.

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
| **Jio-bp** | ~2,296 | `netmanager.ril.com` (private app backend; see [docs/jiobp-api.md](./docs/jiobp-api.md)) |
| **Nayara** | ~9,065 | nayaraenergy.com "Petrol Pump Near Me" locator |
| **Shell** | ~332 | shellretaillocator.geoapp.me (third-party widget; see [docs/shell-api.md](./docs/shell-api.md)) |

Every record carries a `capturedAt` timestamp — see [Methodology](#methodology) for exactly what that does and doesn't guarantee.

Shell also separately publishes an **indicative city-level price table** (22 major cities, not per-outlet) — deliberately kept out of this dataset since it's a city-average estimate, not a fact about any specific outlet. See [docs/shell-api.md](./docs/shell-api.md) for what it is and why.

Updated **daily** by GitHub Actions; every run that changes data produces a [GitHub Release](https://github.com/ForceGT/india-fuel-pumps/releases) with a human-readable diff. Full pipeline details: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

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

- Data is derived from **public** official oil-company outlet locators (no login, no scraping of gated or personal data). Contact numbers are the pumps' listed business numbers.
- The BPCL endpoint (`api.cep.bpcl.in`) was reverse-engineered from static bytecode analysis of the legitimate "BharatGas" Android app — no emulator, no RASP bypass, no authentication credentials.
- The Jio-bp endpoint (`netmanager.ril.com`) was reverse-engineered from the "MyJio-bp" Android app (SSL-pinning disabled in an emulator, traffic captured via a local mitmproxy — see [docs/jiobp-api.md](./docs/jiobp-api.md) for the full repro). Unlike the public HPCL/IOCL/BPCL locators, this is a **private customer-app backend** — the underlying data is not sensitive, but scraping it is a different posture than a public store-locator. No login/OTP/valid session is required or used.
- **License: [MIT](./LICENSE)** — use it freely for anything, commercial or not; just keep the copyright and license notice. No warranty (see the disclaimer above).

---

## Related projects

- **[E0 Finder](https://gtxtreme.pages.dev/e0-finder)** — a fast, mobile-first map that helps people in India find ethanol-free (E0) petrol. The primary consumer of this dataset, applying its own grade-classification and confidence rules on top of the raw records here.

---

Maintained by [Gaurav Thakkar](https://github.com/ForceGT).
