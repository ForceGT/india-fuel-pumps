# India Fuel Pumps — Open Dataset

An open, machine-readable dataset of **every fuel pump across India's three largest public-sector oil marketing companies**: HPCL, IndianOil (IOCL), and BPCL. **~91,000+ outlets**, each with location, contact, hours, and **every fuel product and price the source reports, captured exactly as-is** — no grade classification, no filtering, no assumptions.

> This is the raw material. Deciding what counts as "E0" or any other classification is a downstream consumer's job — see [E0 Finder](#related-projects) at the bottom.

> &#x26A0;&#xFE0F; **Unofficial. Always confirm at the pump.** This data is compiled from public sources and can be out of date or wrong. Never rely on it for a decision that a wrong answer would cost you — call the pump (numbers are included) to confirm.

---

## Coverage

| Brand | Outlets | Source |
|-------|---------|--------|
| **HPCL** | ~23,950 | `petrolpump.hpretail.in` |
| **IOCL (IndianOil)** | ~39,496 | `locator.iocl.com` |
| **BPCL** | ~27,842 | api.cep.bpcl.in (same backend as the "BharatGas" app) |

Every record carries a **`capturedAt` timestamp** (when our crawler last saw it from the source), so you always know how fresh a given row is. Coverage expanded via full national censuses; new brands (Jio-bp, Nayara, Shell) are additive.

---

## Record shape (RawOutletRecord)

The dataset is intentionally **grade-agnostic** — no `grades`, no `confidence`, no `source` classification, no E0-or-otherwise label. Each outlet is captured as-is:

```ts
interface RawOutletRecord {
  brand: "hpcl" | "iocl" | "bpcl";
  outletId: string;           // the source's own outlet ID
  stationId: string;          // stable dedup key across brands
  sourceUrl: string;          // canonical source page
  capturedAt: string;         // ISO-8601 timestamp of this crawl

  name: string;               // live-scraped outlet name (always wins over static lists)
  address: string;
  city: string;               // raw, unreconciled breadcrumb/town (no canonicalization)
  state: string;              // raw, unreconciled
  pincode: string | null;
  lat: number;
  lng: number;
  geohash: string;            // precise geohash (for sharding into ~156 km cells)

  hours: string | null;       // opening hours (free text)
  contact: string | null;     // phone number (if published)
  mapsLink: string | null;    // Google Maps directions URL (if published)

  products: Array<{           // every product the source showed, one entry per row
    name: string;             // exactly as the source wrote it (e.g. "XP100", "Speed 100", "Power 100")
    priceInr: number | null;  // price per litre (null = not published for this product)
  }>;
}
```

Key design decisions:
- **Live source name beats static list.** If the official OMC roster calls an outlet one thing but its own per-outlet page shows a different name, the live page wins — dealer names change, franchises get reassigned, signs get rebranded.
- **No reconciliation.** City and state are the raw breadcrumb/town strings the source emitted, not canonicalized to any cluster. Consumers with a geo-gazetteer can do their own normalization.
- **Products are unfiltered.** If the source lists Petrol, Diesel, XP100, XP95, and XtraGreen, all five go into `products[]` with their prices. Nothing is summarised, classified, or discarded.

---

## Format

The dataset is **geohash-sharded** so a map client only downloads the tiles it needs:

```
dataset/
  index.json                      # the map-index: which shards exist + metadata
  shards/<geohash3>.<hash>.json   # outlets in one ~156 km cell
```

### index.json

```ts
interface ShardIndex {
  schemaVersion: 1;
  generatedAt: string;            // ISO-8601
  totalOutlets: number;
  brands: {
    hpcl: number;
    iocl: number;
    bpcl: number;
  };
  shards: Array<{
    prefix: string;               // 3-char geohash prefix
    file: string;                 // "shards/<geohash3>.<hash>.json"
    count: number;                // outlets in this shard
  }>;
}
```

### Shard file

```ts
interface ShardFile {
  prefix: string;                 // same geohash-3 prefix
  outlets: RawOutletRecord[];     // see record shape above
}
```

Each shard filename embeds a **content hash** (first 16 hex of SHA-256), so a shard file is **immutable** — an unchanged cell keeps the same URL across updates and stays cached; only cells whose data changed re-download. If every cell is unchanged, a new `index.json` references the same shard files and the CDN cache is untouched.

---

## Using the data

The `dataset/` directory is committed to this repo. Clone or download directly:

```
https://github.com/ForceGT/india-fuel-pumps/tree/main/dataset/
```

Consumption pattern:
1. Fetch `dataset/index.json` — read `shards[]` to know which cells exist.
2. Parallel-fetch the shards whose prefixes intersect your area of interest (bounding box / city / current location).
3. Merge the returned `RawOutletRecord[]` arrays in memory and apply your own classification / search / map rendering.

A client that loads all shards at once (~91,000 records, well under 50 MB decompressed) is also fine for a national map — the shard structure is designed to enable per-viewport streaming but does not require it.

---

## Update cadence

- **1st of each month:** full national re-census — all three brands re-crawled from scratch.
- **2nd - 31st:** daily recovery runs — any brand whose last crawl errored or went stale retries; otherwise no-op.

The monthly run produces a GitHub Release with a human-readable diff of changes (new outlets, closed outlets, price changes).

---

## Pipeline

A single GitHub Actions workflow (`.github/workflows/census.yml`) orchestrates everything:

```
                    ┌──────────────┐
                    │  cron trigger │
                    │  (monthly +   │
                    │   daily)      │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  HPCL    │ │  IOCL    │ │  BPCL    │
        │  census  │ │  census  │ │  census  │
        │ (CI)     │ │ (CI)     │ │ (local)  │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │            │            │
             └────────────┼────────────┘
                          ▼
                  ┌───────────────┐
                  │  Merge →      │
                  │  Build shards │
                  │  → Commit     │
                  │  dataset/     │
                  │  → GitHub     │
                  │  Release      │
                  └───────────────┘
```

- HPCL and IOCL run in CI — their sources accept GitHub Actions IPs.
- BPCL runs locally because `api.cep.bpcl.in` returns HTTP 403 from GitHub Actions datacenter IPs. The BPCL raw output is committed to the repo so CI publish runs can still merge all three brands.
- **Partial-failure tolerant:** if one brand's census fails, the others are not blocked — the publish step merges whatever brands succeeded.
- **Resumable:** each brand's crawl writes an append-only worklog (success/failure per work unit). A killed or interrupted run resumes from where it left off by restoring the worklog from GitHub Actions cache.

---

## Scraper code (`src/`)

Each brand is a `Provider` implementation behind a shared, resumable worker pool:

```
src/
  provider.ts             # Provider interface + worklog abstraction
  run-provider.ts         # shared resumable worker pool
  types.ts                # RawOutletRecord, WorkLogRecord types
  providers/
    hpcl-provider.ts      # HPCL: sitemap discovery → per-outlet page → price XHR
    iocl-provider.ts      # IOCL: fixed-outlet-list → per-outlet page → price XHR
    bpcl-provider.ts      # BPCL: app-API reverse-engineered endpoint → per-outlet detail
    run-hpcl.ts           # CLI entrypoint
    run-iocl.ts           # CLI entrypoint
    run-bpcl.ts           # CLI entrypoint
  parsers/
    hpcl.ts               # HPCL outlet-page HTML parser
    iocl.ts               # IOCL outlet-page HTML parser (same locator platform as HPCL)
    bpcl.ts               # BPCL JSON-API response parser
  lib/
    http.ts               # rate-limited, self-identifying HTTP with backoff + retry
    geo.ts                # geohash encoding
```

Key design features:
- **Politely rate-limited** — configurable delay between requests; ~2-3 requests/second.
- **Self-identifies** via `User-Agent` header that includes a contact URL.
- **Compressed storage** — `output/{brand}-raw.jsonl.gz` (compresses ~7x; BPCL's 92 MB → 13 MB).
- **Resumable** — run with `FRESH=1` for a full re-crawl; omit it for incremental resume.
- **Zero network calls in tests** — every parser is tested against real-browser-captured HTML/JSON fixtures from the live sites.

### Running locally

```bash
npm install
npm run census:hpcl    # full HPCL national census
npm run census:iocl    # full IOCL national census
npm run census:bpcl    # full BPCL national census (must be run locally — see above)
npm run build-dataset  # regenerate dataset/ from the output JSONL files
```

---

## Provenance & license

- Data is derived from **public** official oil-company outlet locators (no login, no scraping of gated or personal data). Contact numbers are the pumps' listed business numbers.
- The BPCL endpoint (api.cep.bpcl.in) was reverse-engineered from static bytecode analysis of the legitimate "BharatGas" Android app — no emulator, no RASP bypass, no authentication credentials.
- **License: [MIT](./LICENSE)** — use it freely for anything, commercial or not; just keep the copyright and license notice. No warranty (see the disclaimer above).

---

## Contributing

- **Corrections:** if a pump is wrong, closed, or the data is stale, open an issue.
- **New brands:** Jio-bp, Nayara Shell, and other marketers are welcome as new `Provider` implementations — see `src/provider.ts` for the interface.
- **Crowdsourced availability signals** (a "was it available?" feedback mechanism) are planned but not yet built.

---

## Related projects

- **[E0 Finder](https://gtxtreme.pages.dev/e0-finder)** — a fast, mobile-first map that helps people in India find ethanol-free (E0) petrol. This is the primary consumer of this dataset, applying its own grade-classification and confidence rules on top of the raw records here. Repository: `/Users/gtxtreme/Documents/E0-Finder` (private, not affiliated with any oil company).

Maintained by [Gaurav Thakkar](https://github.com/ForceGT).
