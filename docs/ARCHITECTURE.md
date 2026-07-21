# Architecture

## Pipeline

```
                        ┌──────────────────────┐
                        │  cron trigger         │
                        │  GitHub Actions       │
                        │  (every 3 days)       │
                        └──────────┬───────────┘
                                   │
                      ┌────────────┼────────────┐
                      ▼            ▼            ▼
                ┌──────────┐ ┌──────────┐ ┌──────────┐
                │   HPCL   │ │   IOCL   │ │   BPCL   │
                │ Provider │ │ Provider │ │ Provider │
                │ (CI)     │ │ (CI)     │ │ (CI)     │
                └────┬─────┘ └────┬─────┘ └────┬─────┘
                     │            │            │
                     │  each writes:           │
                     │  output/{slug}-raw.jsonl │
                     │  output/{slug}-worklog.jsonl │
                     │  (gzipped after job)    │
                     └────────────┼────────────┘
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
                     │  + CDN (jsDelivr)        │
                     └──────────────────────────┘
```

## Components

### Provider interface (`src/provider.ts`)

The plug-in contract every brand implements. Two methods:

- **`discover(opts)`** — enumerates all units of work. Returns an `AsyncIterable<WorkUnit>`. For HPCL/IOCL this means walking a sitemap or fixed URL list to find every per-outlet page. For BPCL it means constructing a hand-curated route mesh plus an adaptive grid over India.

- **`process(unit, ctx)`** — fetches the page/API for ONE work unit, parses it, returns zero or more `RawOutletRecord`s plus optional follow-up work units (BPCL's grid subdivision on saturation). Uses `ctx.fetch` (injectable for tests) and `ctx.now()` (injectable for deterministic timestamps).

- **`init?(ctx)`** — optional one-time setup. Used by BPCL to fetch its initial OAuth token so auth failures fail fast before any crawl work begins.

All brand-specific knowledge lives in the provider. The runner is generic.

### runProvider (`src/run-provider.ts`)

The generic, resumable orchestrator powering every brand:

1. Calls `provider.init()` if present.
2. Calls `provider.discover()` and collects all work units.
3. Loads the existing worklog from disk, filters out units whose latest record is `"ok"` or `"empty"` **and** fresh (within `maxAgeDays`). Failed/stale units are re-processed.
4. Drives a **dynamic queue** (`runDynamicQueue`) — `concurrency` lanes pull from the front of a shared queue. A lane's `handle()` can push follow-ups onto the back (BPCL grid subdivision). When no lanes are active and the queue is empty, the run finishes.
5. Writes every processed unit's result: `RawOutletRecord`s go to `{slug}-raw.jsonl`; worklog entries go to `{slug}-worklog.jsonl`. Both are append-only via a serialized promise chain so concurrent lanes never interleave writes.

Key properties: resumable (rerun skips done units), polite (configurable delay between lanes), single serialized writer (no corruption from concurrent lanes).

### build-dataset (`src/build-dataset.ts`)

Reads all three brands' `output/{hpcl,iocl,bpcl}-raw.jsonl.gz` (or `.jsonl`), deduplicates each brand by `stationId` (latest `capturedAt` wins), merges across brands, groups by 3-character geohash prefix, and writes:

- `dataset/shards/{prefix}.{sha256-hex-16}.json` — one file per cell, content-hashed so unchanged cells keep the same URL across runs.
- `dataset/index.json` — manifest listing every shard file, total outlet count, per-brand counts.
- `dataset/release-stats.json` — previous + current state for diff computation.
- `dataset/release-notes.md` — human-readable diff for GitHub Release body.

Missing brand files are tracked as `missingBrands` and flagged in the release notes so a single census failure doesn't look like 0 outlets for that brand.

### Workflow (`census.yml`)

Three parallel brand jobs, one publish job, one notify job:

- **HPCL** and **IOCL** run on `ubuntu-latest` at concurrency 12. HPCL ~94 min; IOCL ~3.5h.
- **BPCL** runs on `ubuntu-latest** at concurrency 4. ~25 min. OAuth token fetched dynamically.
- **Publish** runs after all three (or after whatever completed) — downloads artifacts, runs build-dataset, commits `dataset/`, creates a tagged GitHub Release with auto-generated release notes.
- **Notify** files a GitHub issue (or comments on an existing one) when any brand fails.

## Data flow

```
┌─────────────────────────────────────────────────────────────────┐
│  WorkUnit                                                       │
│  ────────                                                       │
│  { id: string, payload: unknown }                               │
│  Resumability key = id.                                         │
│  HPCL/IOCL: id = sourceUrl of the per-outlet page               │
│  BPCL:       id = routeChunkId or cellId (grid cell)            │
└─────────────────────────────────────────────────────────────────┘
         │ process()
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ProcessResult                                                  │
│  ─────────────                                                  │
│  { status, records: RawOutletRecord[], followups?, ... }        │
│  status = ok / empty / httpFailed / parsedNull / errored        │
│  ok/empty marks unit as "done" on resume                        │
│  followups = new WorkUnits (BPCL grid subdivision)              │
└─────────────────────────────────────────────────────────────────┘
         │
         ├──→ output/{slug}-raw.jsonl      (RawOutletRecord[], append-only)
         └──→ output/{slug}-worklog.jsonl   (WorkLogRecord[], append-only)
                                                │
                                                │ runProvider filters done
                                                │ units via computeDoneWorkUnitIds()
                                                ▼
                                        resumability checkpoint
```

## Grade-agnostic boundary

This is the project's single most important design constraint. `RawOutletRecord` has **no grade, no ethanol-content, no confidence, no E0/E10/E20/E85/E100 classification**. The `products` array captures every product+price the source reports, exactly as written:

```ts
// RawProduct — nothing but name + price
{ name: "XP100", priceInr: 167.35 }
{ name: "Diesel", priceInr: 94.52 }
```

Why: deciding what counts as "ethanol-free" (or any other classification) is a **subjective downstream opinion**, not a fact this dataset asserts. The private E0-Finder project applies its own `grades.ts` mapping and confidence rules on top of these raw records. This repo never touches grade logic, and never will.

A consumer consuming this dataset:
```
Fetch RawOutletRecord[] → filter/products by name pattern
→ apply own ethanol-content table → render on map
```

## Adding a new brand (Jio-bp, Nayara, Shell, etc.)

1. Create `src/parsers/{brand}.ts` — parse the brand's outlet page or API response, return outlet metadata + products.
2. Create `src/providers/{brand}-provider.ts` — implement the `Provider` interface:
   - `discover()` — how to find all outlets (sitemap walk, fixed list, API enumeration, grid crawl).
   - `process()` — fetch one unit, call parser, return `ProcessResult`.
   - `init()` — if the brand needs auth (BPCL-style OAuth).
3. Create `src/run-{brand}.ts` — CLI entrypoint wrapping `runProvider(provider, opts)`.
4. Add a `census:{brand}` script to `package.json`.
5. Add a job step to `.github/workflows/census.yml` (copy one of the existing three, adjust `timeout-minutes`, `concurrency`, and env vars).
6. Add the brand to `build-dataset.ts`'s `BRANDS` array and the publish job's artifact download pattern.

No changes needed to `types.ts`, `provider.ts`, `run-provider.ts`, or the build-dataset dedup/merge logic — those are all brand-agnostic by design.

## Technology

| Layer | Tool | Rationale |
|-------|------|-----------|
| Runtime | Node 22 + `tsx` (TypeScript runner) | No build step for scripts; widely available |
| HTTP | `fetch()` with exponential backoff (`src/http.ts`) | Zero dependencies, polite by default |
| Parsing | `node-html-parser` for HTML; `JSON.parse` for API responses | Only production dependency |
| Testing | `vitest` | Fast, TS-native, watch mode |
| Sharding | Geohash (precision 3, ~156 km cells) | Map-friendly, deterministic, content-hashed |
| Compression | gzip (`gzip -f` in CI; `.jsonl.gz` files under 50 MB) | Git-friendly, GitHub 50 MB limit compliant |
| Delivery | jsDelivr CDN (`cdn.jsdelivr.net/gh/ForceGT/...`) | Free, fast, no auth; avoids `raw.githubusercontent.com` rate limits |
| Orchestration | GitHub Actions (`.github/workflows/census.yml`) | Free compute (runs every 3 days), cron scheduling |
