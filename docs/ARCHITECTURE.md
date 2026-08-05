# Architecture

## Pipeline

```
                        ┌──────────────────────┐
                        │  cron trigger         │
                        │  GitHub Actions       │
                        │  (daily, 02:07 UTC)   │
                        └──────────┬───────────┘
                                   │
        ┌───────────┬───────────┬───────────┬───────────┬───────────┬───────────┐
        ▼            ▼           ▼           ▼           ▼           ▼
   ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐
   │   HPCL   ││   IOCL   ││   BPCL   ││  Jio-bp  ││  Nayara  ││  Shell   │
   │ Provider ││ Provider ││ Provider ││ Provider ││ Provider ││ Provider │
   │ (CI)     ││ (CI)     ││(CI, via  ││ (CI)     ││ (CI)     ││ (CI)     │
   │          ││          ││Tailscale)││          ││          ││          │
   └────┬─────┘└────┬─────┘└────┬─────┘└────┬─────┘└────┬─────┘└────┬─────┘
        │           │           │           │           │           │
        │  each writes:                                             │
        │  output/{slug}-raw.jsonl                                  │
        │  output/{slug}-worklog.jsonl                               │
        │  (gzipped after job)                                       │
        └───────────┴───────────┴─────┬─────┴───────────┴───────────┘
                                       ▼
                     ┌──────────────────────────┐
                     │  build-dataset.ts         │
                     │  (publish job)            │
                     │                           │
                     │  1. Read each brand's     │
                     │     raw JSONL             │
                     │  2. Dedup by stationId    │
                     │     (latest capturedAt)   │
                     │  3. Group by geohash-3    │
                     │     prefix                │
                     │  4. SHA-256 content-hash  │
                     │     each shard            │
                     │  5. Write:                │
                     │     dataset/              │
                     │       index.json          │
                     │       shards/*.hash.json  │
                     │       release-stats.json  │
                     │       release-notes.md    │
                     └──────────┬────────────────┘
                                ▼
                     ┌──────────────────────────┐
                     │  git commit dataset/     │
                     │  + GitHub Release        │
                     └──────────────────────────┘
```

There is no separate publish/CDN step — the git commit above is the distribution.
Consumers fetch the committed files directly (`raw.githubusercontent.com` or a
clone); see the main [README](../README.md#quick-start).

---

## Components

### Provider interface (`src/provider.ts`)

The plug-in contract every brand implements. Three methods, two required:

- **`discover(opts)`** (required) — enumerates all units of work as an
  `AsyncIterable<WorkUnit>`, where `WorkUnit = { id: string; payload: unknown }`.
  `id` is the resumability key and must be stable + collision-free across a
  provider's entire discovery stream. `discover()` deliberately does **not**
  receive `ctx` — any network call it needs runs on its own injectable
  `fetchImpl`, not `ctx.fetch`, since `ctx` doesn't exist yet at discovery time.
- **`process(unit, ctx)`** (required) — fetches/parses ONE work unit, returns a
  `ProcessResult`: `{ status, records: RawOutletRecord[], followups?, saturated? }`.
  `status` is one of `ok | empty | httpFailed | parsedNull | errored` — the exact
  same enum as `WorkLogRecord["status"]`. `ctx.fetch` and `ctx.now()` are both
  injectable, so tests never make a real network call or depend on wall-clock time.
- **`init?(ctx)`** (optional) — one-time setup before discovery/processing starts.
  BPCL uses it to fetch an initial OAuth token; Nayara uses it to bootstrap
  session cookies + a CSRF token from one GET of the locator page. Both exist so
  a broken auth setup fails fast, before any crawl work is attempted, rather than
  failing on every individual unit. HPCL, IOCL, Jio-bp, and Shell need no auth
  and skip this.

Discovery strategy per brand, briefly (see each brand's own doc for the full
reverse-engineering writeup where one exists):

| Brand | Discovery | Auth |
|---|---|---|
| HPCL | Sitemap walk (`petrolpump.hpretail.in/sitemap.xml`) → per-district `.xml.gz` files → per-outlet `/Home` URLs | None |
| IOCL | Same "singleinterface.com" platform as HPCL, same shape (`locator.iocl.com/sitemap.xml`) | None |
| BPCL | Hand-curated route mesh (city-pair corridors) **+** an adaptive point-grid over India with saturation-triggered subdivision (see [EDGE-CASES.md](./EDGE-CASES.md)) | OAuth token, fetched in `init()` |
| Jio-bp | One `FetchROMaster` call for the national station index, then batches of station codes (default 18/batch) as work units | None — identity fields are unvalidated constants (see [jiobp-api.md](./jiobp-api.md)) |
| Nayara | Two large-radius (`3000km`) `/get-code-ro-radius` calls from widely separated center points — each alone returns close to the entire national roster (see [nayara-api.md](./nayara-api.md)) | Session cookies + CSRF token, bootstrapped in `init()`, refreshed on HTTP 419 |
| Shell | Recursive bounding-box walk over India via `within_bounds` (subdivides when the response signals `clusters`), then one `GET /api/v2/locations/{id}` per outlet id (see [shell-api.md](./shell-api.md)) | None |

All brand-specific knowledge lives in the provider; the runner is fully generic.

### runProvider (`src/run-provider.ts`)

The generic, resumable orchestrator every `run-{brand}.ts` CLI entrypoint calls:

1. Calls `provider.init()` if present.
2. Calls `provider.discover()` and collects every work unit.
3. Loads the existing worklog (`{slug}-worklog.jsonl`) and computes the
   already-done set via `computeDoneWorkUnitIds` — a unit counts as done only
   if its **latest** record has `status` `"ok"` or `"empty"` **and** was fetched
   within `maxAgeDays` (default 3). Any other status is *never* treated as
   done, regardless of recency, so a transient failure always gets retried on
   the next run instead of becoming a silent permanent gap.
4. **Seeds the raw output from the committed baseline.** Before processing
   anything new, it reads the existing `{slug}-raw.jsonl(.gz)`, dedupes it by
   `stationId` (latest `capturedAt` wins), drops any record whose
   `capturedAt` is older than `staleAfterDays` (default 14 — a station that
   hasn't been re-captured in two weeks is treated as likely closed/moved and
   aged out), and rewrites `{slug}-raw.jsonl` with what's left. This is why a
   partial or interrupted run never collapses the published dataset back to
   whatever fraction it managed to scrape this run — the file always starts
   from everything still-fresh that was ever captured, and this run's results
   accumulate on top of that.
5. Drives a **dynamic queue** (`runDynamicQueue`) — `concurrency` lanes pull
   from the front of a shared, mutable queue array. A lane's `handle()` can
   push follow-up units onto the back of the same queue (BPCL's grid
   subdivision is the only current user of this). A lane only exits once the
   queue is empty **and** no lane is still mid-`handle()` — a momentarily
   empty queue doesn't mean done, since a sibling lane's in-flight call might
   be about to push more work.
6. Writes every processed unit's result through one serialized promise-chain
   writer (`createWriter`) shared across all lanes: `RawOutletRecord`s append
   to `{slug}-raw.jsonl`, worklog entries append to `{slug}-worklog.jsonl`, and
   a progress line (`{slug}-progress.txt`) is rewritten every `progressEvery`
   (default 25) processed units. Serializing through one writer is what
   guarantees concurrent lanes never interleave or corrupt either file.

A run is "finished" once every discovered unit is either already-done or
processed this run — `run-{brand}.ts` prints whether that happened and, if
not, how many units remain (safe to just re-run the same command; already-done
units are skipped).

### build-dataset (`src/build-dataset.ts`)

Reads all six brands' `output/{hpcl,iocl,bpcl,jiobp,nayara,shell}-raw.jsonl`
(preferring the `.gz` variant if present), deduplicates each brand
independently by `stationId` (latest `capturedAt` wins), merges across brands,
groups by 3-character geohash prefix, and writes:

- `dataset/shards/{prefix}.{sha256-hex-16}.json` — one file per cell, content-hashed
  so an unchanged cell keeps the same filename/URL across runs (old shard files
  are deleted and rewritten fresh every run, so a shard that moved geohash cells
  or emptied out doesn't linger).
- `dataset/index.json` — manifest: `schemaVersion`, `generatedAt`, `totalOutlets`,
  per-brand `brands` counts, and the `shards[]` array.
- `dataset/release-stats.json` — `{ previous, current }`, where `previous` is
  whatever `current` was in the release-stats.json this run overwrote — this is
  how the diff in release notes gets computed without needing separate state.
- `dataset/release-notes.md` — human-readable diff (or a baseline snapshot, on
  the very first publish) for the GitHub Release body.

A brand whose raw JSONL is missing/empty is tracked in `missingBrands` rather
than silently counted as zero — `release-notes.md` then shows "no data this
run" for that brand instead of a misleading "-23,980" drop. If every brand
produces zero outlets, `build-dataset` exits without touching `dataset/` at all
(a fully-failed run doesn't wipe the published dataset).

### Workflow (`census.yml`)

Six parallel brand jobs, then a publish job, a notify job, and a resolve job.
Triggered by the daily cron (`7 2 * * *`, i.e. 02:07 UTC) or manually via
`workflow_dispatch`, which additionally accepts: a comma-separated `brands`
subset (skip the rest), a per-brand `*_limit` (stop after roughly N new
units — smoke-test only), a `concurrency` override, and `publish_dataset`
(set `false` to dry-run without committing). Overlapping runs are prevented —
a `concurrency: group: census-${{ github.ref }}` with `cancel-in-progress:
false` queues a new run behind one still in progress rather than racing it.

Each brand job follows the same shape: checkout → restore its worklog from
GH Actions cache (`restore-keys` falls back to the most recent prior worklog,
so even a first-time cache miss on a brand-new run id degrades gracefully) →
`npm run census:{brand}` with that brand's env vars → gzip the raw output →
save the worklog back to cache (`if: always()`, so even a killed/timed-out job
preserves progress for the next run) → upload the gzipped raw output as a
build artifact.

- **HPCL** and **IOCL** run at concurrency 12 (`hpcl_limit`/`iocl_limit`
  configurable). Both use the same "singleinterface.com" locator platform.
  IOCL is WAF-sensitive to sustained request rate — see
  [EDGE-CASES.md](./EDGE-CASES.md) for calibration history. Runtime varies
  hugely depending on how many units are inside the 3-day freshness window
  already (a "cold" run after a gap can take hours; a "warm" run the next day
  can take minutes) — see [RUNBOOK.md](./RUNBOOK.md)'s FAQ for a concrete
  worked example.
- **BPCL** runs at concurrency 10, routed through a Tailscale exit node
  (`tailscale/github-action`) onto a residential-IP Raspberry Pi —
  `api.cep.bpcl.in` blocks GitHub Actions' datacenter IPs directly. The job's
  `if` condition requires `vars.TAILSCALE_EXIT_NODE` to be set; if it isn't,
  the whole job is skipped (not failed) and publish falls back to the last
  committed `bpcl-raw.jsonl.gz`.
- **Jio-bp** and **Nayara** each need only a handful of requests to enumerate
  their entire national roster (Jio-bp: one index call + batched detail
  calls; Nayara: two large-radius calls), so both finish in minutes even at
  low default concurrency (2 and 1 respectively).
- **Shell** walks a bounding-box grid (~342 outlets total) at concurrency 5;
  no rate limiting has been observed against `geoapp.me`.

**Publish** runs once all six brand jobs have reached a terminal state
(`success`, `failure`, or `skipped` — `always()` so it still runs even if
some brands failed), and only if **at least one** brand succeeded. It:

1. Downloads whatever brand artifacts were actually uploaded (a
   single-brand calibration run only produces one).
2. Checks each brand's committed raw file's age against `STALE_AFTER_DAYS`
   (3) and records a `{brand}_stale`/`{brand}_age` output for the job
   summary — visibility only, doesn't block anything.
3. Runs `build-dataset`.
4. **Guards against dataset collapse** — a Python step compares
   `release-stats.json`'s `previous` vs `current` per brand; if a brand had
   >1,000 records previously and now has less than half that, the publish
   job **fails outright** rather than committing what looks like a
   resume/scrape bug. This is a second, coarser safety net on top of
   `runProvider`'s own baseline-accumulation behavior.
5. Writes a job summary table (brand / census result / raw line count / data
   age) with a staleness warning banner if any brand is using fallback data.
6. Commits `dataset/` plus any freshly-produced `{brand}-raw.jsonl.gz` files
   (only on `schedule` or explicit `publish_dataset: true`) and pushes.
7. If something was actually committed, tags and creates a GitHub Release
   (`dataset-<UTC timestamp>`) with `release-notes.md` as the body.

**Notify** runs if any brand job failed: it files a GitHub issue labeled
`census-failure` (or comments on an existing open one instead of duplicating).
**Resolve** runs after every trigger regardless of outcome: it closes that
issue once every brand named in its title has succeeded again, or comments
on partial recovery. See [RUNBOOK.md](./RUNBOOK.md)'s FAQ for exactly how the
fallback/staleness/issue-lifecycle mechanics interact.

---

## Data flow

```
┌─────────────────────────────────────────────────────────────────┐
│  WorkUnit                                                        │
│  ────────                                                        │
│  { id: string, payload: unknown }                                │
│  Resumability key = id.                                          │
│  HPCL/IOCL:  id = sourceUrl of the per-outlet page                │
│  BPCL:       id = routeChunkId or cellId (grid cell)              │
│  Jio-bp:     id = "batch-{hash}" (a batch of station codes)       │
│  Nayara:     id = "center-{name}" (one of two fixed center points)│
│  Shell:      id = the outlet's geoapp.me location id               │
└─────────────────────────────────────────────────────────────────┘
         │ process()
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ProcessResult                                                   │
│  ─────────────                                                   │
│  { status, records: RawOutletRecord[], followups?, saturated? }  │
│  status = ok / empty / httpFailed / parsedNull / errored         │
│  ok/empty marks unit as "done" on resume                         │
│  followups = new WorkUnits (BPCL grid subdivision only)          │
└─────────────────────────────────────────────────────────────────┘
         │
         ├──→ output/{slug}-raw.jsonl      (RawOutletRecord[], append-only,
         │                                   seeded from the deduped, staleness-
         │                                   pruned baseline before this run's
         │                                   results are appended)
         └──→ output/{slug}-worklog.jsonl   (WorkLogRecord[], append-only)
                                                 │
                                                 │ runProvider filters done
                                                 │ units via computeDoneWorkUnitIds()
                                                 ▼
                                         resumability checkpoint
```

---

## Grade-agnostic boundary

This is the project's single most important design constraint. `RawOutletRecord`
has **no grade, no ethanol-content, no confidence, no E0/E10/E20/E85/E100
classification**. The `products` array captures every product+price the source
reports, exactly as written:

```ts
// RawProduct — nothing but name + price
{ name: "XP100", priceInr: 167.35 }
{ name: "Diesel", priceInr: 94.52 }
```

Why: deciding what counts as "ethanol-free" (or any other classification) is a
**subjective downstream opinion**, not a fact this dataset asserts. See
[docs/METHODOLOGY.md](./METHODOLOGY.md) for the full reasoning — this repo
never touches grade logic, and never will.

---

## Adding a new brand

1. Create `src/parsers/{brand}.ts` — parse the brand's outlet page or API
   response, return outlet metadata + products. Test against real,
   browser/proxy-captured fixtures — no live network calls in tests (every
   existing `src/parsers/*.test.ts` follows this pattern).
2. Create `src/providers/{brand}-provider.ts` — implement the `Provider`
   interface: `discover()` (how to find every outlet), `process()` (fetch one
   unit, call the parser, build a `RawOutletRecord` via
   `buildRawRecord`/`priceMapToProducts` from `lib/raw-record.ts`), and
   `init()` only if the brand needs auth.
3. Create `src/run-{brand}.ts` — a thin CLI entrypoint reading
   `{BRAND}_CENSUS_*` env vars and calling `runProvider(provider, opts)`.
4. Add a `census:{brand}` script to `package.json`.
5. Add a job to `.github/workflows/census.yml` (copy an existing brand job,
   adjust `timeout-minutes`/`concurrency`/env vars and the `*_limit` input),
   and extend the `needs:`/brand-tracking arrays in `publish`, `notify`, and
   `resolve`.
6. Add the brand's slug to `build-dataset.ts`'s `BRANDS` array.

No changes needed to `types.ts`, `provider.ts`, `run-provider.ts`, or
`build-dataset.ts`'s dedup/merge logic — all of it is brand-agnostic by
design. Shell (`src/providers/shell-provider.ts`, a recursive bounding-box
walk against an unauthenticated JSON API) and Nayara (session+CSRF auth
against a WAF-protected endpoint) are the two most recently added brands and
the most representative worked examples to model a new one from — see
[shell-api.md](./shell-api.md) and [nayara-api.md](./nayara-api.md) for their
full reverse-engineering writeups.

---

## Technology

| Layer | Tool | Rationale |
|-------|------|-----------|
| Runtime | Node 22 + `tsx` (TypeScript runner) | No build step for scripts; widely available |
| HTTP | `fetch()` with exponential backoff (`src/http.ts`) | Zero dependencies, polite by default; also retries connection-level failures (DNS/TCP/TLS), not just 429/5xx |
| Parsing | `node-html-parser` for HTML; `JSON.parse` for API responses | Only production dependency |
| Testing | `vitest` | Fast, TS-native, watch mode |
| Sharding | Geohash (precision 3, ~156 km cells) via `src/geo.ts`'s `geohashEncode` | Map-friendly, deterministic, content-hashed |
| Compression | gzip (`gzip -f` in CI; `.jsonl.gz` files under GitHub's 50 MB limit) | Git-friendly, GitHub 50 MB limit compliant |
| Delivery | Direct from git (`raw.githubusercontent.com` or clone) | No separate publish step — the committed repo *is* the distribution |
| Orchestration | GitHub Actions (`.github/workflows/census.yml`) | Free compute (runs daily), cron scheduling |

`src/geo.ts` also exports `neighborPrefixes`/`geohashDecodeBounds`/
`neighborCoverageKm` — bounding-box/neighbor-cell helpers for a spatial
*query* layer (a downstream consumer's map API). This repo's own pipeline
doesn't call them; only `geohashEncode` (sharding) and `haversineKm` (BPCL's
route-point interpolation) are actually used here.
