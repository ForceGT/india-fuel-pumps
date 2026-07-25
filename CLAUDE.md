# CLAUDE.md — agent operating guide for india-fuel-pumps

## What this project is

An open, machine-readable dataset of every fuel pump across India, produced by
scraping official OMC outlet locators (HPCL, IOCL, BPCL). The scrapers capture
**every product + price a source reports, exactly as reported** — this repo has
no opinion on what counts as ethanol-free or any other grade. That classification
is a downstream consumer's job (e.g. the private E0-Finder project at
`~/Documents/E0-Finder`).

## Non-obvious facts

1. **Grade-agnostic boundary is deliberate and enforced at the type level.**
   `RawOutletRecord` has no `grade`/`ethanol` field. Never add one — this repo
   captures everything; classification belongs downstream.

2. **BPCL must be run from a residential IP.** `api.cep.bpcl.in` returns HTTP 403
   from GH Actions datacenter IPs. The CI workflow routes BPCL traffic through a
   Tailscale exit node (Raspberry Pi at a residential location). Requires
   `TAILSCALE_AUTH_KEY` (GitHub secret) and `TAILSCALE_EXIT_NODE` (GitHub
   variable). Without these, BPCL is skipped and the publish step uses the last
   committed `bpcl-raw.jsonl.gz`. — BPCL takes ~25 min at concurrency 4.

3. **Raw JSONL files are gzip-compressed before commit** (92 MB -> 13 MB).
   `build-dataset.ts` reads `.jsonl.gz` first, falls back to `.jsonl`. CI jobs gzip
   before uploading artifacts.

4. **Resumability is cache-based.** `runProvider` writes a worklog
   (`{slug}-worklog.jsonl`). `computeDoneWorkUnitIds` skips already-ok units.
   The GitHub workflow caches worklog across runs via `actions/cache@v6` with
   `restore-keys`. To force a full fresh run, clear the cache.

5. **IOCL `locator.iocl.com` is WAF-sensitive.** Concurrency 10 is proven safe
   from both residential and GH Actions IPs; 12 is bumped but unverified above
   a single run; 15/20/30 all tripped pattern-based blocks. Do not raise
   concurrency above 10 without recalibrating.

6. **Partial failures are expected and handled.** The publish job runs even if some
   brands fail (at least one must succeed). Missing brands are flagged in release
   notes as "no data this run", not silently dropped to zero.

7. **Output files:** `{slug}-raw.jsonl.gz` (committed to git),
   `{slug}-worklog.jsonl` (cached, not committed), `{slug}-progress.txt` (live),
   `{slug}-discovered-urls.json` (HPCL/IOCL discovery cache).

8. **The `Provider` interface is the extensibility point** for new brands (HPCL,
   IOCL, BPCL, Jio-bp, Nayara, Shell). Three methods: `init` (optional), `discover` (yield `WorkUnit`s),
   `process` (unit -> `ProcessResult`). See `src/provider.ts`.

9. **Nayara requires session + CSRF auth and deliberately uses a Chrome-mimicking header set.**
   The nayaraenergy.com locator endpoint (`POST /get-code-ro-radius`) requires an Akamai
   WAF bypass: a CSRF token + session cookies bootstrapped from one GET of the locator
   page, then replayed on every POST. Instead of the honest IndiaFuelPumpsBot `User-Agent`,
   Nayara uses a Chrome browser header set because Akamai blocks the honest identity by
   header shape alone — a documented architectural tradeoff, same visibility tier as BPCL's
   Tailscale requirement. See `docs/nayara-api.md`.

10. **`build-dataset` merges all available raw JSONL** -> dedupes by `stationId`
   (latest `capturedAt` wins) -> groups by geohash[0:3] -> writes content-hashed
   shards -> writes `release-stats.json` + `release-notes.md`.

11. **Error logging pattern:** All providers log the first 3 occurrences of
    each error type (HTTP status + URL snippet). Connection exceptions are always
    logged. Format: `[brand] error {n} — url`.

12. **Shell's locator is a third-party white-labelled SaaS (`geoapp.me`), not
    Shell's own infrastructure**, and reports no prices at all for India
    (`fuel_pricing.status` is always `"unavailable"`) — every Shell `RawProduct`
    has `priceInr: null`, only product-name (`fuels`) coverage. No auth, no WAF
    (this repo's honest `IndiaFuelPumpsBot` UA works fine, unlike Nayara).
    Discovery is a recursive bounding-box walk (`within_bounds`, subdividing on
    `clusters` — mirrors BPCL's saturation-triggered grid subdivision) followed
    by one `GET /api/v2/locations/{id}` detail call per outlet (~342 total). See
    `docs/shell-api.md`.

13. **Shell also publishes a separate city-level indicative price table**
    (22 major cities, 4 grades) at `fuel-pricing-in-india.html`, sourced from
    a downloadable `.xlsx` whose URL is re-discovered from the page's AEM
    `.model.json` on every run (it changes every time Shell updates prices —
    never hardcoded). **Deliberately kept out of `RawOutletRecord`/
    `shell-raw.jsonl`** — it's a city-average estimate ("may not reflect
    most recent price changes... prices might vary from site to site in the
    same city," per Shell's own disclaimer), not a per-outlet fact, and this
    repo's `priceInr` field means "the source reported this for this exact
    outlet" everywhere else. Lives in its own artifact instead:
    `npm run pricing:shell` -> `output/shell-city-prices.jsonl`. Parsed with
    a hand-rolled zero-dependency ZIP/XLSX reader (`src/lib/minizip.ts`) —
    deliberately not a general xlsx library, which would pull in a
    write-path archiver with real vulnerabilities for a read-only need this
    small. See `docs/shell-api.md`'s "City-level indicative price table" section.

## Repo map

```
src/provider.ts           Provider interface — how to add a new brand
src/run-provider.ts       Generic resumable worker pool (consumes any Provider)
src/run-{hpcl,iocl,bpcl,jiobp,nayara,shell}.ts   Thin CLI wrappers (brand config + env vars)
src/providers/            Brand-specific Provider implementations
src/parsers/              Per-brand HTML/JSON response parsers
src/build-dataset.ts      Assembles raw JSONL -> geohash-sharded dataset
src/types.ts              RawOutletRecord, WorkLogRecord, Brand (no grades!)
src/http.ts               fetchWithBackoff: retries 429/5xx + connection errors
src/id.ts                 Stable stationId generation (brand + outletId + lat/lng)
output/                   Raw JSONL (gitignored except .gz files committed)
dataset/                  Geohash-sharded output (index.json + shards/)
.github/workflows/census.yml   Monthly + daily cron; partial-failure-tolerant
```

## Common commands

```bash
npm run census:hpcl       # Full HPCL national census
npm run census:iocl       # Full IOCL national census
npm run census:bpcl       # Full BPCL national census (residential IP via Tailscale exit node)
npm run census:jiobp      # Full Jio-bp national census
npm run census:nayara     # Full Nayara national census
npm run census:shell      # Full Shell national census
npm run build-dataset     # Assemble raw JSONL -> sharded dataset + release notes
npm run test              # Vitest suite
npm run typecheck         # tsc --noEmit
```
