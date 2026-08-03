# India Fuel Pumps — Open Dataset

An open, machine-readable dataset of **every fuel pump across India's public-sector oil marketing companies, plus Shell**: HPCL, IndianOil (IOCL), BPCL, Jio-bp, Nayara, and Shell. **~103,000+ outlets**, each with location, contact, hours, and **every fuel product and price the source reports, captured exactly as-is** — no grade classification, no filtering, no assumptions.

> This is the raw material. Deciding what counts as "E0" or any other classification is a downstream consumer's job — see [E0 Finder](#related-projects) at the bottom.

> &#x26A0;&#xFE0F; **Unofficial. Always confirm at the pump.** This data is compiled from public sources and can be out of date or wrong. Never rely on it for a decision that a wrong answer would cost you — call the pump (numbers are included) to confirm.

---

## Coverage

| Brand | Outlets | Source |
|-------|---------|--------|
| **HPCL** | ~23,950 | `petrolpump.hpretail.in` |
| **IOCL (IndianOil)** | ~39,496 | `locator.iocl.com` |
| **BPCL** | ~27,842 | api.cep.bpcl.in (same backend as the "BharatGas" app) |
| **Jio-bp** | ~2,294 | `netmanager.ril.com` (private app backend; see [docs/jiobp-api.md](docs/jiobp-api.md)) |
| **Nayara** | ~9,050 | nayaraenergy.com "Petrol Pump Near Me" locator |
| **Shell** | ~332 | shellretaillocator.geoapp.me (third-party locator widget embedded on shell.in; see [docs/shell-api.md](docs/shell-api.md)) |

Every record carries a **`capturedAt` timestamp** (when our crawler last saw it from the source), so you always know how fresh a given row is. Coverage expanded via full national censuses across all six brands.

Shell also separately publishes an **indicative city-level price table** (22 major cities, not per-outlet) — deliberately kept out of this dataset since it's a city-average estimate, not a fact about any specific outlet. See [docs/shell-api.md](docs/shell-api.md) for what it is and why.

---

## Record shape (RawOutletRecord)

The dataset is intentionally **grade-agnostic** — no `grades`, no `confidence`, no `source` classification, no E0-or-otherwise label. Each outlet is captured as-is:

```ts
interface RawOutletRecord {
  brand: "HPCL" | "IOCL" | "BPCL" | "JioBP" | "Nayara" | "Shell";
  outletId: string;           // the source's own outlet ID (Jio-bp: its FuelStationCode, e.g. "MHC117")
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
    jiobp: number;
    nayara: number;
    shell: number;
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

A client that loads all shards at once (~103,000 records, well under 50 MB decompressed) is also fine for a national map — the shard structure is designed to enable per-viewport streaming but does not require it.

---

## Update cadence

- **Daily** at 02:07 UTC — stations not re-checked within `MAX_AGE_DAYS` (3 days) are re-scraped; most units are skipped as already-fresh, so the daily cadence is cheap. Worst-case freshness is well within E0-Finder's 14-day stale threshold, and a failed run recovers the very next day instead of waiting out a multi-day slot.
- Every run produces a GitHub Release with a human-readable diff of changes (new outlets, closed outlets, price changes).

---

## Pipeline

A single GitHub Actions workflow (`.github/workflows/census.yml`) orchestrates everything:

```
                       ┌──────────────┐
                       │  cron trigger │
                       │  (daily,      │
                       │   02:07 UTC)  │
                       └──────┬───────┘
                              │
       ┌────────────┬────────────┬────────────┬────────────┬────────────┐
       ▼            ▼            ▼            ▼            ▼            ▼
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │  HPCL    │ │  IOCL    │ │  BPCL    │ │  Jio-bp  │ │  Nayara  │ │  Shell   │
  │  census  │ │  census  │ │  census  │ │  census  │ │  census  │ │  census  │
  │ (CI)     │ │ (CI)     │ │ (CI, via │ │ (CI)     │ │ (CI)     │ │ (CI)     │
  │          │ │          │ │Tailscale)│ │          │ │          │ │          │
  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
       │            │            │            │            │            │
       └────────────┴────────────┴────────────┴────────────┴────────────┘
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

- HPCL, IOCL, Jio-bp, Nayara, and Shell run directly in CI — their sources accept GitHub Actions IPs.
- BPCL also runs in CI, but routed through a Tailscale exit node (a residential-IP Raspberry Pi) — `api.cep.bpcl.in` returns HTTP 403 from GitHub Actions datacenter IPs directly. If the exit node isn't configured, the BPCL job is skipped and the publish step uses the last committed `bpcl-raw.jsonl.gz` instead.
- **Partial-failure tolerant:** if one brand's census fails, the others are not blocked — the publish step merges whatever brands succeeded.
- **Resumable:** each brand's crawl writes an append-only worklog (success/failure per work unit). A killed or interrupted run resumes from where it left off by restoring the worklog from GitHub Actions cache.

---

## FAQ

**A brand's census failed in CI — does that mean the next release loses pumps for that brand?**

No. `publish` (`.github/workflows/census.yml`) only uploads a brand's raw-data artifact if that brand's job actually produced fresh output — the artifact-upload step for each brand has no `if: always()`, so a job that fails before writing `output/{brand}-raw.jsonl` uploads nothing. `publish`'s own `actions/checkout` step already has the *last committed* `{brand}-raw.jsonl.gz` in the working tree, and `download-artifact` only overwrites files it actually receives. So a failed brand silently falls back to yesterday's committed baseline for that brand — same mechanism as the documented "Tailscale exit node not configured" case — and the release shows no delta for it, not a drop to zero. Even in the case where a job *partially* scrapes before dying, `Guard against dataset collapse` fails the publish outright if any brand's count drops >50% from the previous baseline (for brands with >1,000 records), so a half-finished scrape can't silently roll the published dataset backward either.

**How do I re-run just one brand?**

Trigger `workflow_dispatch` on `census.yml` with `brands` set to a comma-separated subset, e.g. `brands=bpcl`. Only that brand's census job runs; every other brand's job is skipped, and `publish` merges the freshly-scraped brand with the already-committed raw data for the rest — it does not need every brand to run in order to produce a full release.

```bash
gh workflow run census.yml -f brands=bpcl
```

**A "Census failure" issue got filed — do I need to close it manually?**

No. The `resolve` job runs after every workflow trigger (scheduled or manual) and auto-closes any open `census-failure`-labeled issue once every brand named in its title has succeeded again — partial recoveries get a comment instead, and the issue stays open until all named brands are back. Manual closing is only needed if you're overriding that logic for some reason.

**How is stale data (used as a fallback) surfaced, since it doesn't fail the build?**

`publish`'s `Check data freshness` step compares each brand's raw file's age against `STALE_AFTER_DAYS` (3, matching the scraper's own re-scrape cadence) and writes a `⚠️ Stale data used` warning into the job summary listing the affected brands. This is visibility only — it does not block the release, since a few days' staleness is expected and safe (E0-Finder's own staleness threshold is 14 days).

**Why did a run fail with no obvious WAF/auth signature?**

Check the job's raw log before assuming a block — the issue-template's suggested checks (WAF, OAuth expiry) are common causes but not the only ones. A `getaddrinfo EAI_AGAIN <host>` error on the *first* request, especially alongside the same DNS failure on unrelated GitHub-internal hosts, points to a transient network/DNS blip (e.g. on BPCL's Tailscale exit node) rather than anything OMC-side.

**A brand's census usually takes hours — why did it finish in a few minutes?**

By design, not a fluke. `actions/cache/restore@v6`'s `restore-keys: worklog-{brand}-` always pulls in the *most recent prior* worklog (a plain prefix match, not tied to a specific run), and `runProvider`'s `computeDoneWorkUnitIds` (CLAUDE.md fact #4) treats a work unit as done — skipped with zero HTTP requests — if the worklog shows it was captured within `{BRAND}_CENSUS_MAX_AGE_DAYS` (3 days). So runtime depends entirely on how many units are still inside that 3-day window, not on total outlet count:

- IOCL run `30734379310` (2026-08-02): worklog inherited from three days earlier showed only 1,588 of 39,586 outlets still fresh → 37,998 had to be scraped → **3h12m**.
- IOCL run `30788312263` (2026-08-03, ~21h later): worklog inherited from the run directly above, which had *just* refreshed almost everything → 38,813 of 39,586 already fresh, only 735 pending → **~6 minutes**.

Because most of a brand's outlets tend to get captured in the same burst, they also cross the 3-day threshold together — so a brand cycles between one ~3-hour "cold" run roughly every 3 days and several ~minutes-long "warm" runs in between, all in the same job. A fast run isn't a sign that something was skipped or broken; check the job log for `total units / already done / pending` to confirm.

---

## Scraper code (`src/`)

Each brand is a `Provider` implementation behind a shared, resumable worker pool:

```
src/
  provider.ts             # Provider interface + worklog abstraction
  run-provider.ts         # shared resumable worker pool
  types.ts                # RawOutletRecord, WorkLogRecord types
  http.ts                 # rate-limited, self-identifying HTTP with backoff + retry
  geo.ts                  # geohash encoding
  run-hpcl.ts             # CLI entrypoint
  run-iocl.ts             # CLI entrypoint
  run-bpcl.ts             # CLI entrypoint
  run-jiobp.ts            # CLI entrypoint
  run-nayara.ts           # CLI entrypoint
  run-shell.ts            # CLI entrypoint
  scrape-shell-city-pricing.ts  # standalone: Shell's separate city-price table (NOT part of the census — see docs/shell-api.md)
  providers/
    hpcl-provider.ts      # HPCL: sitemap discovery → per-outlet page → price XHR
    iocl-provider.ts      # IOCL: fixed-outlet-list → per-outlet page → price XHR
    bpcl-provider.ts      # BPCL: app-API reverse-engineered endpoint → per-outlet detail
    jiobp-provider.ts     # Jio-bp: national index call → batched per-outlet detail call
    nayara-provider.ts    # Nayara: session+CSRF bootstrap → large-radius locator API calls
    shell-provider.ts     # Shell: bounding-box walk (geoapp.me locator) → per-outlet detail call
  parsers/
    hpcl.ts               # HPCL outlet-page HTML parser
    iocl.ts               # IOCL outlet-page HTML parser (same locator platform as HPCL)
    bpcl.ts               # BPCL JSON-API response parser
    jiobp.ts              # Jio-bp JSON-API request builders + response parser
    nayara.ts             # Nayara JSON-API response parser (products as flat keys)
    shell.ts              # Shell locator JSON-API request builders + response parser
    shell-pricing.ts      # Shell's separate city-price .xlsx parser (see lib/minizip.ts)
  lib/
    minizip.ts            # zero-dependency ZIP reader (reads Shell's price .xlsx — see docs/shell-api.md)
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
npm run census:jiobp   # full Jio-bp national census
npm run census:nayara  # full Nayara national census
npm run census:shell   # full Shell national census
npm run pricing:shell  # Shell's separate city-price table (NOT merged into the dataset — see docs/shell-api.md)
npm run build-dataset  # regenerate dataset/ from the output JSONL files
```

---

## Provenance & license

- Data is derived from **public** official oil-company outlet locators (no login, no scraping of gated or personal data). Contact numbers are the pumps' listed business numbers.
- The BPCL endpoint (api.cep.bpcl.in) was reverse-engineered from static bytecode analysis of the legitimate "BharatGas" Android app — no emulator, no RASP bypass, no authentication credentials.
- The Jio-bp endpoint (`netmanager.ril.com`) was reverse-engineered from the "MyJio-bp" Android app (SSL-pinning disabled in an emulator, traffic captured via a local mitmproxy — see [docs/jiobp-api.md](docs/jiobp-api.md) for the full repro). Unlike the public HPCL/IOCL/BPCL locators, this is a **private customer-app backend** — the underlying data (station locations, publicly-posted fuel prices) is not sensitive, but scraping it is a different posture than a public store-locator. No login/OTP/valid session is required or used; the synthetic identity fields sent are never validated by the server.
- **License: [MIT](./LICENSE)** — use it freely for anything, commercial or not; just keep the copyright and license notice. No warranty (see the disclaimer above).

---

## Contributing

- **Corrections:** if a pump is wrong, closed, or the data is stale, open an issue.
- **New brands:** other marketers are welcome as new `Provider` implementations — see `src/provider.ts` for the interface (`src/providers/shell-provider.ts` and `src/providers/nayara-provider.ts` are recent examples to model from).
- **Crowdsourced availability signals** (a "was it available?" feedback mechanism) are planned but not yet built.

---

## Related projects

- **[E0 Finder](https://gtxtreme.pages.dev/e0-finder)** — a fast, mobile-first map that helps people in India find ethanol-free (E0) petrol. This is the primary consumer of this dataset, applying its own grade-classification and confidence rules on top of the raw records here. Repository: `/Users/gtxtreme/Documents/E0-Finder` (private, not affiliated with any oil company).

Maintained by [Gaurav Thakkar](https://github.com/ForceGT).
