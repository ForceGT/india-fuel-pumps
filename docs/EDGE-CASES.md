# Edge Cases

## BPCL GH Actions IP block (HTTP 403)

**Symptom:** Every BPCL work unit in a CI run fails with `status: "httpFailed"`, `detail: "HTTP 403"`. The HPCL and IOCL jobs complete normally.

**Root cause:** The BPCL API (`api.cep.bpcl.in`) returns HTTP 403 from GitHub Actions datacenter IP ranges. Two independent runs confirmed this — every single unit (1,129/1,129) got 403. The token endpoint worked fine (OAuth succeeded), but the data endpoints (`rolocators`, `rolocator/route`, `rolocator/details`) block datacenter IPs.

**Resolution:** The CI workflow routes BPCL traffic through a Tailscale exit node (a Raspberry Pi on a residential IP) via `tailscale/github-action@v3`, configured with `vars.TAILSCALE_EXIT_NODE` and `secrets.TAILSCALE_AUTH_KEY`.

**Manual fallback** (if the exit node is down):
```bash
npm run census:bpcl        # Run from your own residential-IP machine
gzip -f output/bpcl-raw.jsonl
git add -f output/bpcl-raw.jsonl.gz && git push
```

**Prevention:** If the exit node isn't configured (`vars.TAILSCALE_EXIT_NODE` empty), the BPCL CI job is skipped entirely (its `if` condition requires that var) rather than failing loudly, and the publish step uses the last committed `bpcl-raw.jsonl.gz`.

---

## IOCL WAF calibration (sustained-rate blocking)

**Symptom:** IOCL `locator.iocl.com` starts returning 403 on every request mid-run, after a period of successful requests. Previously working requests suddenly all fail.

**Root cause:** IOCL uses a pattern-based WAF that detects sustained request rates, NOT a pure concurrency ceiling. At concurrency 15+, the WAF triggers and blocks all subsequent requests — even a single manual request between two fully-blocked runs succeeds, confirming it's pattern-based, not a blanket IP ban.

**Calibration history:**

| Concurrency | Result | Notes |
|-------------|--------|-------|
| 10 | 100% safe from both residential and GH Actions | Across 3,000+ requests, zero failures |
| 12 | Safe from GH Actions | Current CI default |
| 15 | 100% block within minutes | Verified twice |
| 20 | Immediate 100% block | |
| 30 | Immediate 100% block | |

**Resolution:** Restart at concurrency 10. The existing worklog preserves progress from before the block — only unprocessed units are retried.

**Prevention:** Never set IOCL concurrency above 12. For WAF calibration runs, start at 5 and step up.

---

## IOCL transient block unaffected by concurrency (distinct from the sustained-rate WAF above)

**Symptom:** IOCL's `sitemap.xml` fetch — the very FIRST request of a completely fresh run, at the normal concurrency-12 default — returns HTTP 403 immediately. No sustained load preceded it; this is the opposite failure signature from the sustained-rate WAF case above.

**Observed incident (2026-08-05):** The scheduled 05:22 UTC run failed this way, and two subsequent manual re-triggers (one plain re-run, one with `iocl_limit=50`) failed identically within seconds — always on the first `sitemap.xml` GET, never getting far enough to make a second request. A residential-IP `curl` to the same URL during this window succeeded (HTTP 200), suggesting the block was scoped to GitHub Actions' IP range specifically, not IOCL's whole userbase.

**Diagnosis approach:** Add a diagnostic step to the workflow that probes several different `locator.iocl.com` URL shapes (the sitemap, the homepage, a search-results page, a real outlet `/Home` page) from the runner via plain `curl`, to distinguish "this specific path is blocked" from "GitHub Actions' IP/ASN is blocked entirely."

**Resolution:** In this incident, the block cleared on its own — a run triggered ~1.5 hours later, with no code or configuration change, succeeded on every probed URL (all HTTP 200) and completed the full census normally. This points to a **transient** condition (a temporary WAF cooldown or IP-reputation window) rather than a lasting denylist entry, and is a genuinely different failure mode from the sustained-rate pattern documented above — that one is triggered by *this scraper's own* request pattern and is fully within our control to avoid; this one was not.

**If it recurs:** Re-run the diagnostic probe step first to check whether it's the same transient pattern (succeeds after some delay with zero code changes) before assuming a WAF calibration regression — don't reflexively drop concurrency, since concurrency wasn't the cause here.

---

## Stale worklog cache

**Symptom:** After cancelling a run mid-way (Ctrl+C, CI timeout), the next run finds very few pending units. It looks like it's skipping work.

**Root cause:** A cancelled run writes worklog entries for the units it did process — including failures (`httpFailed`, `errored`). The resume logic in `computeDoneWorkUnitIds` only marks a unit as done if `status === "ok" || status === "empty"`. Failures are NEVER treated as done, regardless of recency. So a cancelled run's worklog does NOT poison the next run.

**The real stale-worklog scenario:** HPCL and IOCL cache their discovery results (sitemap walk) in `output/{slug}-discovered-urls.json` (see `urlsCachePath` in each provider). If the sitemap's district structure changes (new districts added), the per-district cache can lag. The root sitemap index URL IS fetched fresh every run, so new districts ARE discovered — only per-district URL resolution is cached. The risk is that within a known district, new outlets might be missed between full cache clearances.

**Resolution:** Use `FRESH=1` periodically to clear the discovery cache (see [RUNBOOK.md](./RUNBOOK.md)). Separately, the worklog's own `maxAgeDays` (3, by default) forces a re-crawl of every already-discovered outlet every 3 days regardless — that's a different staleness knob from the discovery-URL cache.

---

## Partial brand failure

**Symptom:** HPCL completes, BPCL fails. The publish job still runs.

**Root cause:** By design. The `publish` job's `if` condition uses `always()` plus, per brand, `result == 'success' || result == 'failure' || result == 'skipped'` — so it runs regardless of any individual brand's outcome — **and** requires that at least one brand's `result == 'success'`, so publish is only skipped entirely when every single brand failed or was skipped.

**How `build-dataset.ts` handles it:** A brand whose raw JSONL is missing/empty gets added to `missingBrands`. The release notes show the brand as "no data this run" and explicitly note the previous count:

```
> Partial dataset — BPCL did not produce data this run.
> BPCL: previous count was 27,961 — not dropped, just missing from this run
```

`index.json`'s `brands` map omits a missing brand's key entirely (not `0`).

**A second safety net:** even when a brand's job *does* report success but scraped far less than usual (a bug, a partial resume gone wrong), the publish job's **collapse guard** independently fails the build if any brand with >1,000 prior records drops below 50% of its previous count — see [ARCHITECTURE.md](./ARCHITECTURE.md)'s Workflow section.

**Fallout:** The next scheduled run (daily) retries the failed brand automatically.

---

## BPCL grid saturation

**Symptom:** BPCL logs contain `saturated: true` entries. Very dense metro areas produce subdivided grid cells.

**Mechanism:** BPCL's discovery uses an adaptive point-grid over India (`src/providers/bpcl-provider.ts`). If a single grid cell's response contains ≥100 outlets (`SATURATION_COUNT`), the provider subdivides it into 4 smaller cells (half the spacing/radius, depth+1) and pushes them as `followups` onto the same dynamic queue. This repeats up to `maxDepth` (default 4, overridable via `BPCL_CENSUS_MAX_DEPTH`).

```
Cell at depth 0 (spacing 100km, radius 75km)
  -> saturated (>=100 outlets)
  -> 4 sub-cells at depth 1 (spacing 50km, radius 37.5km)
    -> one sub-cell still saturated
    -> 4 sub-sub-cells at depth 2 (spacing 25km, radius 18.75km)
```

At `maxDepth`, any remaining saturated cell is logged explicitly: `"still saturated at maxDepth={n} — some outlets here may be missed"` — this means the cell wasn't subdivided further, so completeness in that specific cell isn't guaranteed. This is a loud, visible fallback, not silent data loss.

**Route chunk vs grid cell overlap:** Route chunks (Phase 1) and grid cells (Phase 2) are both yielded by `discover()` and processed on the same dynamic queue, so they can interleave concurrently. They never collide on `workUnitId` — route chunks are `"{cityA}->{cityB}#{n}"`, cells are `"d{depth}:{lat}:{lng}:{radiusM}"` — genuinely disjoint ID shapes. Any outlet found by both a route and a grid cell is simply captured twice in the raw JSONL; `build-dataset.ts` dedupes by `stationId` at merge time, so this is harmless.

---

## Content hash stability

**Requirement:** A shard whose outlet data hasn't changed must produce the exact same filename across runs. Otherwise every shard file appears new to git on every publish.

**How stability is enforced in `build-dataset.ts`:**

1. **Deterministic grouping:** Outlets are grouped by `geohash.slice(0, 3)`. The base32 geohash alphabet is deterministic — same lat/lng always produces the same geohash-3 prefix.
2. **Stable sort within each shard:** Outlets are sorted by `stationId.localeCompare(stationId)` — a pure, deterministic string comparison.
3. **Content hash:** `SHA-256(JSON.stringify(sortedOutlets)).slice(0, 16)`. `JSON.stringify`'s output is deterministic because `RawOutletRecord`'s key order is fixed by the object literal in `lib/raw-record.ts`'s `buildRawRecord`, and `JSON.stringify` serializes keys in insertion order.

**When a hash changes:** It means the actual data in that cell changed — an outlet moved, a price updated, a name changed, or the cell's outlet count changed (added/removed/pruned station). That shard file re-downloads; other shards stay cached.

**Old shard cleanup:** `build-dataset.ts` deletes every existing file in `dataset/shards/` before writing this run's shards — a shard prefix that no longer has any outlets (all pruned, or geohash grouping shifted) simply isn't recreated, rather than lingering as an orphaned file.

---

## GitHub 50 MB file limit

**Symptom:** `git push` fails with something like "remote: fatal: file output/bpcl-raw.jsonl is 92 MB; this exceeds GitHub's file size limit of 50.00 MB".

**Resolution:** Every brand's raw JSONL is gzip-compressed after the census job (the `Compress {brand} raw output` step in `census.yml`, or manually via `gzip -f output/{brand}-raw.jsonl`) — roughly a 7-9x reduction for this kind of repetitive JSON text. `build-dataset.ts` and `run-provider.ts`'s baseline reader both prefer the `.gz` variant transparently over the plain `.jsonl` if both exist.

Shard files are **not** gzip-compressed — they're committed as plain JSON. Individual shard files are small enough that even the largest (a dense metro at geohash-3) stays well under 50 MB uncompressed, so the limit never applies to them the way it does to a brand's full national raw JSONL.

---

## Token expiry / auth failure mid-census (BPCL, Nayara)

**Symptom:** BPCL work units start returning 401 after running successfully for a while. Nayara work units start returning 419.

**BPCL (OAuth bearer token):** The provider holds the current token + expiry in closure state (`tokenState`). Two independent layers guard against expiry:
1. **Proactive:** `ensureAccessToken`, called at the top of every `process()` call, refreshes the token if less than `TOKEN_REFRESH_MARGIN_MS` (5 minutes) of TTL remains.
2. **Reactive:** if a request still comes back HTTP 401 despite that (a token invalidated early, or a race), the provider refreshes once and retries the exact same request once — for both the route-mesh and grid-cell request paths.

If refresh itself fails, the unit is recorded as `errored` (the thrown error's message, e.g. `"token refresh failed: HTTP {status}"`) and retried on the next run.

**Nayara (session cookies + CSRF token):** `init()` bootstraps one session via a GET of the locator page before any work starts (fail-fast, same rationale as BPCL's `init()`). If a subsequent request comes back HTTP 419 (CSRF/session expiry), the provider re-bootstraps the session once and retries the same request once — mirroring BPCL's 401-retry pattern. See [nayara-api.md](./nayara-api.md)'s "Auth model" section for why a one-time `init()` alone isn't relied on for the whole run.

HPCL, IOCL, Jio-bp, and Shell need no auth and are unaffected by either of these.

---

## Jio-bp: discover() throws (loudly) if the ROMaster index call fails

**Symptom:** A Jio-bp census run crashes immediately with `[census:jiobp] fatal (safe to re-run — already-done batches will be skipped): Error: [jiobp-provider] discover: ROMaster fetch failed HTTP {status}` (or `...fetch threw: {error}`), non-zero exit code, zero units processed.

**Root cause:** Unlike HPCL/IOCL/BPCL/Shell, Jio-bp's `discover()` depends on a SINGLE upstream call (`FetchROMaster`, the national station index) before it can yield any work units at all. Both a non-OK HTTP response and a thrown network error from that one call cause `discover()` itself to `throw` — this propagates straight out of `runProvider`'s discovery-collection loop, out of `main()` in `run-jiobp.ts`, and is caught only by the top-level `.catch()`, which logs it and sets `process.exitCode = 1`. This is a **loud, unambiguous crash**, not a silent zero-output success — a CI run failing this way shows up as a failed job, not a suspiciously-fast green one.

**Diagnosis:** The job log directly names the failure: `discover: ROMaster fetch failed HTTP {status}` or `discover: ROMaster fetch threw: {error}`. On success, the log instead shows `[jiobp-provider] discovered {N} stations from ROMaster index` (N should be in the low thousands) before any batch processing starts.

**Resolution:** Re-run — this is almost always transient (a single failed request, not a per-outlet failure resumability could partially recover from, since nothing was discovered yet). If it persists, the ROMaster response shape may have changed upstream; check [jiobp-api.md](./jiobp-api.md)'s Operation 1 reference against a fresh capture.

**Contrast with other brands:** HPCL/IOCL/BPCL/Shell discovery failures are per-unit (one district's sitemap file 404s, one bbox's `within_bounds` call fails) and don't block the rest of the census. Jio-bp's discovery is a single point of failure by design — the whole national index comes back in one API call, so there's no partial-discovery state to resume from; either that one call succeeds and the full census proceeds, or it fails and the run produces nothing, loudly.

---

## Jio-bp: price is the LATEST dated entry, not the first array entry

**Symptom:** A station's `products[].priceInr` doesn't match the first `PriceDetails` entry in the raw API response.

**Root cause:** `HistoryFuelProducts[].PriceDetails` is a dated price *history*, not a single current price — and it is not guaranteed to be in any particular order. The parser (`latestProductPrice` in `src/parsers/jiobp.ts`) picks the entry with the greatest `PriceDate` (format `"dd-MM-yyyy HH:mm:ss"`, parsed manually — `Date.parse` would misread day/month on this format). A product can legitimately show a `PriceDate` weeks old if that product's price hasn't changed recently (e.g. Diesel/CNG updating less often than Petrol).

**Also:** `ProductPrice` is a space-padded string (`"     111.28"`) — trimmed and parsed to a number. If unparseable, non-numeric, or non-positive, `priceInr` is `null` but the product name is still kept (same "keep the card, null the price" convention as HPCL/IOCL).

**Prevention:** Don't index into `PriceDetails[0]` when reading this dataset's raw source, and don't assume every product in `products[]` has a recent price — check `capturedAt` (when we scraped it) rather than assuming freshness from price presence alone.

---

## Discovery URL cache staleness (HPCL/IOCL)

**Symptom:** A new pump opened weeks ago but still isn't in the dataset.

**Root cause:** HPCL and IOCL cache their sitemap walk results in `output/{slug}-discovered-urls.json`. This cache avoids re-walking the full sitemap tree on every resume (saving several minutes per run). The root sitemap index URL IS fetched fresh every run, so new districts in the index are discovered. But per-district URL lists are cached, so a new outlet appearing within an already-known district may be missed until the discovery cache is cleared.

**Resolution:** Use `FRESH=1` periodically (see [RUNBOOK.md](./RUNBOOK.md)) — this is a separate knob from the worklog's `maxAgeDays` staleness, which only controls re-crawling *already-discovered* outlets, not re-discovering new ones.

**Schedule:** daily at 02:07 UTC. Each run resumes from the worklog — units scraped within `maxAgeDays` (3 days) are skipped, older/stale units are re-processed.
