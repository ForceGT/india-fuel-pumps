# Edge Cases

## BPCL GH Actions IP block (HTTP 403)

**Symptom:** Every BPCL work unit in a CI run fails with `status: "httpFailed"`, `detail: "HTTP 403"`. The HPCL and IOCL jobs complete normally.

**Root cause:** The BPCL API (`api.cep.bpcl.in`) returns HTTP 403 from GitHub Actions datacenter IP ranges. Two independent runs have confirmed this — every single unit (1,129/1,129) gets 403. The token endpoint works fine (OAuth succeeds), but the data endpoints (`rolocators`, `rolocator/route`) block datacenter IPs.

**Diagnosis:** The GH Actions log shows `[bpcl] HTTP 403` on every unit (the first 3 are logged with full URL + body, then the logging cap kicks in). The provider summary line reads `ok=0 records=0` because all units are `httpFailed`.

**Resolution:**
1. Run BPCL from a residential IP: `npm run census:bpcl` on your local machine.
2. Compress the raw output: `gzip -f output/bpcl-raw.jsonl`
3. Force-add to git: `git add -f output/bpcl-raw.jsonl.gz && git push`
4. Trigger the GH Actions publish workflow -- it picks up the pushed BPCL data alongside HPCL/IOCL's CI outputs.

**Prevention:** None — this is the BPCL API operator's choice, not ours. BPCL is excluded from CI (`brands=bpcl` not passed) and must be run locally. The committed `bpcl-raw.jsonl.gz` is what the daily publish uses until a new local run is pushed.

---

## IOCL WAF calibration

**Symptom:** IOCL `locator.iocl.com` starts returning 403 on every request mid-run. Previously working requests suddenly all fail.

**Root cause:** IOCL uses a pattern-based WAF that detects sustained request rates, NOT a pure concurrency ceiling. At concurrency 15+, the WAF triggers and blocks all subsequent requests -- even a single manual request between two fully-blocked runs succeeds, confirming it's pattern-based, not IP-based.

**Calibration history:**

| Concurrency | Result | Notes |
|-------------|--------|-------|
| 10 | 100% safe from both residential and GH Actions | Across 3,000+ requests, zero failures |
| 12 | Safe from GH Actions | Current CI default |
| 15 | 100% block within minutes | Verified twice |
| 20 | Immediate 100% block | |
| 30 | Immediate 100% block | |

**Resolution:** Restart at concurrency 10. The existing worklog preserves progress from before the block -- only unprocessed units are retried.

**Prevention:** Never set IOCL concurrency above 12. For WAF calibration runs, start at 5 and step up.

---

## Stale worklog cache

**Symptom:** After cancelling a run mid-way (Ctrl+C, CI timeout), the next run finds very few pending units. It looks like it's skipping work.

**Root cause:** A cancelled run writes worklog entries for the units it did process -- including failures (`httpFailed`, `errored`). The resume logic in `computeDoneWorkUnitIds` only marks a unit as done if `status === "ok" || status === "empty"`. Failures are NEVER treated as done, regardless of recency. So a cancelled run's worklog does NOT poison the next run.

**The real stale-worklog scenario:** HPCL and IOCL cache their discovery results (sitemap walk) in `output/{slug}-discovered-urls.json`. If the sitemap's district structure changes (new districts added), the per-district cache can lag. The root sitemap index IS fetched fresh every run, so new districts ARE discovered -- only per-district URL resolution is cached. The risk is that within a known district, new outlets might be missed between full cache clearances.

**Resolution:** Use `FRESH=1` at least monthly. The CI monthly run's `maxAgeDays: 30` handles this automatically.

---

## Partial brand failure

**Symptom:** HPCL completes, BPCL fails. The publish job still runs.

**Root cause:** By design. The `census.yml` publish job has `always()` and checks `result == 'success' || result == 'failure'` for each brand. Without `always()`, the default `needs` behavior would skip the publish job when any dependency failed.

**How `build-dataset.ts` handles it:** A brand whose raw JSONL is missing gets added to `missingBrands`. The release notes show the brand as "no data this run" and explicitly note the previous count:

```
> Partial dataset -- BPCL did not produce data this run.
> BPCL: previous count was 27,842 -- not dropped, just missing from this run
```

The `index.json` and `shards/` only contain data from the brands that succeeded. Counts for missing brands are omitted (not set to 0).

**Fallout:** The daily recovery run (next day) retries the failed brand automatically.

---

## BPCL grid saturation

**Symptom:** BPCL logs contain `saturated: true` entries. Very dense metro areas produce subdivided grid cells.

**Mechanism:** BPCL's discovery uses an adaptive point-grid over India. If a single grid cell contains more than ~100 outlets (saturation threshold), the provider subdivides it into 4 smaller cells (increase geohash depth) and re-processes each sub-cell. This repeats up to `MAX_DEPTH`.

```
Cell at depth 3 (geohash ~156 km)
  -> saturated (>100 outlets)
  -> 4 sub-cells at depth 4 (~39 km)
    -> one sub-cell still saturated
    -> 4 sub-sub-cells at depth 5 (~9.7 km)
```

At `MAX_DEPTH`, any remaining saturated cell is logged explicitly: "still saturated at MAX_DEPTH" -- this means all outlets in that area are captured but the cell wasn't fully subdivided. This is an accept-everything fallback, not silence.

**Route chunk vs grid cell overlap:** Route chunks (Phase 1) and grid cells (Phase 2) can be interleaved concurrently via the dynamic queue. They don't cause double processing because the resumability key (`workUnitId`) differs between route chunks and cells -- different ID formats, never collide.

---

## Content hash stability

**Requirement:** A shard whose outlet data hasn't changed must produce the exact same filename across runs. Otherwise every shard file appears new to git and the CDN cache is busted on every publish.

**How stability is enforced in `build-dataset.ts`:**

1. **Deterministic grouping:** Outlets are grouped by `geohash.slice(0, 3)`. The base32 geohash alphabet is deterministic -- same lat/lng always produces the same geohash-3 prefix.
2. **Stable sort within each shard:** Outlets are sorted by `stationId.localeCompare(stationId)` -- a pure, deterministic string comparison.
3. **Content hash:** `SHA-256(JSON.stringify(sortedOutlets)).slice(0, 16)`. The `JSON.stringify` output is deterministic because the object key order in `RawOutletRecord` is fixed in the source code and `JSON.stringify` serializes keys in insertion order.

**When a hash changes:** It means the actual data in that cell changed -- an outlet moved, a price updated, a name changed. That shard file re-downloads; other shards stay cached.

**Verified by test:** Byte-identical re-runs produce identical shard filenames (`diff -rq` on output dirs shows no differences).

---

## GitHub 50 MB file limit

**Symptom:** `git push` fails with "remote: fatal: file output/bpcl-raw.jsonl is 92 MB; this exceeds GitHub's file size limit of 50.00 MB".

**Resolution:** All raw JSONL files are gzip-compressed after the census job:

```
gzip -f output/hpcl-raw.jsonl   # 71 MB -> 8 MB
gzip -f output/iocl-raw.jsonl   # 120 MB -> 12 MB
gzip -f output/bpcl-raw.jsonl   # 92 MB -> 13 MB
```

The CI pipeline does this automatically in the "Compress raw output" step. `build-dataset.ts` reads `.jsonl.gz` files transparently (prefers them over plain `.jsonl`).

Shard files are not compressed server-side -- they are served via jsDelivr which handles gzip/Brotli at the edge. Individual shard files are small enough that even the largest (a dense metro at geohash-3) stays well under 50 MB uncompressed.

---

## Token expiry mid-census (BPCL only)

**Symptom:** BPCL work units start returning 401 after running successfully for 10+ minutes.

**Root cause:** BPCL's OAuth bearer token expires. The provider has a built-in refresh mechanism with a 5-minute margin (`TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000`). On each `process()` call, if the token has less than 5 minutes of TTL remaining, it fetches a new one.

**How it works:** The BPCL provider holds the current token in closure memory. `process()` checks expiry before making the API call -- if token expiry minus current time is under 5 minutes, a new token is fetched, the closure is updated, and processing continues.

**If refresh fails:** The unit is recorded as `errored` with `detail: "token refresh failed"` and retried on the next run. HPCL/IOCL need no auth and are unaffected.

---

## Discovery URL cache staleness (HPCL/IOCL)

**Symptom:** A new pump opened weeks ago but still isn't in the dataset.

**Root cause:** HPCL and IOCL cache their sitemap walk results in `output/{slug}-discovered-urls.json`. This cache avoids re-walking the full sitemap tree on every resume (saving ~5 min per run). The root sitemap index URL IS fetched fresh every run, so new districts in the index are discovered. But per-district URL lists are cached, so changes within a known district may be missed until the cache expires.

**Resolution:** Use `FRESH=1` at least monthly (the CI monthly run's `maxAgeDays: 30` handles this via worklog staleness, but the discovery cache is separate). The monthly full re-census clears the discovery cache via `FRESH=1` logic.

**Specifically for the monthly vs daily schedule:**
- **Monthly run (1st):** `FRESH=1` semantics -- full re-discovery, full re-crawl. All caches cleared.
- **Daily recovery (2nd-31st):** Normal resume -- uses existing discovery cache and worklog. Only re-processes failed or stale units.
