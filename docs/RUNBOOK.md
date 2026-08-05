# Runbook

## Prerequisites

```bash
git clone https://github.com/ForceGT/india-fuel-pumps
cd india-fuel-pumps
npm install
```

Requires Node 20+ (tested on Node 22). No API keys or secrets — all sources are public APIs and require no authentication (except BPCL's OAuth, which is fetched dynamically; Jio-bp's identity fields are unvalidated constants, see `docs/jiobp-api.md`; Nayara's session+CSRF auth is bootstrapped dynamically, see `docs/nayara-api.md`).

---

## Running a full census (all brands)

```bash
# Run all five (locally, sequentially — CI runs them in parallel)
npm run census:hpcl && npm run census:iocl && npm run census:bpcl && npm run census:jiobp && npm run census:nayara && npm run build-dataset
```

### What each step produces

| Step | Output files |
|------|-------------|
| `census:hpcl` | `output/hpcl-raw.jsonl`, `output/hpcl-worklog.jsonl` |
| `census:iocl` | `output/iocl-raw.jsonl`, `output/iocl-worklog.jsonl` |
| `census:bpcl` | `output/bpcl-raw.jsonl`, `output/bpcl-worklog.jsonl` |
| `census:jiobp` | `output/jiobp-raw.jsonl`, `output/jiobp-worklog.jsonl` |
| `census:nayara` | `output/nayara-raw.jsonl`, `output/nayara-worklog.jsonl` |
| `build-dataset` | `dataset/index.json`, `dataset/shards/*.json`, `dataset/release-notes.md` |

---

## Running a single brand

```bash
# HPCL — state filter + limit for smoke tests
HPCL_CENSUS_STATE_ALLOWLIST=maharashtra HPCL_CENSUS_LIMIT=5 npm run census:hpcl

# IOCL — limit only
IOCL_CENSUS_LIMIT=5 npm run census:iocl

# BPCL — limit only
BPCL_CENSUS_LIMIT=5 npm run census:bpcl

# Jio-bp — limit only (limit counts BATCHES, not individual outlets)
JIOBP_CENSUS_LIMIT=2 npm run census:jiobp

# Nayara — limit only (limit counts BATCHES of large-radius API calls)
NAYARA_CENSUS_LIMIT=1 npm run census:nayara
```

---

## BPCL — GH Actions IP block workaround

The BPCL API (`api.cep.bpcl.in`) blocks datacenter IPs. BPCL census in CI routes through a Tailscale exit node (Raspberry Pi at a residential location).

**Prerequisites:**
- A Raspberry Pi running Tailscale, configured as an exit node
- `TAILSCALE_AUTH_KEY` (GitHub secret — an ephemeral or tagged auth key)
- `TAILSCALE_EXIT_NODE` (GitHub variable — the RPi's Tailscale hostname)

**How it works:** The BPCL CI job connects to Tailscale, routes all traffic through the RPi exit node, and scrapes from a residential IP. If the secrets aren't configured, the BPCL job is skipped and the publish step uses the last committed `bpcl-raw.jsonl.gz`.

**Manual fallback** (if Tailscale is down):
```bash
npm run census:bpcl        # Run from your local machine
gzip -f output/bpcl-raw.jsonl
git add -f output/bpcl-raw.jsonl.gz && git push
```

**Root cause:** The BPCL API has geo-IP/cloud-provider-IP-range filtering. A residential IP always works.

### Tailscale exit node setup (one-time)

**On the Raspberry Pi** (residential location):
```bash
# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh

# Advertise as exit node
sudo tailscale up --advertise-exit-node

# Approve the exit node in the Tailscale admin console (admin.tailscale.com)
# Then verify: tailscale status | grep "exit node"
```

**On GitHub** (repo settings):
1. Generate an auth key at [admin.tailscale.com](https://admin.tailscale.com) → Settings → Keys → Generate auth key (ephemeral or tagged)
2. Add `TAILSCALE_AUTH_KEY` as a repository secret
3. Add `TAILSCALE_EXIT_NODE` as a repository variable (the RPi's Tailscale hostname, e.g. `raspberrypi`)

Once configured, the BPCL CI job connects via Tailscale and scrapes through the residential IP. If either value is missing, the BPCL job is skipped and the publish step uses the last committed `bpcl-raw.jsonl.gz`.

---

## Environment variables per brand

### HPCL

| Variable | Default | Purpose |
|----------|---------|---------|
| `HPCL_CENSUS_CONCURRENCY` | `12` | Concurrent lanes |
| `HPCL_CENSUS_LIMIT` | (no limit) | Stop after N new units (smoke tests) |
| `HPCL_CENSUS_MAX_AGE_DAYS` | `3` | Staleness threshold for resume |
| `HPCL_CENSUS_STATE_ALLOWLIST` | (all) | Comma-separated states to scope crawl |
| `FRESH` | (unset) | Set to `1` to delete cache + worklog and restart from scratch |

### IOCL

| Variable | Default | Purpose |
|----------|---------|---------|
| `IOCL_CENSUS_CONCURRENCY` | `12` | Concurrent lanes (max safe = 12 from CI, 10 from residential) |
| `IOCL_CENSUS_LIMIT` | (no limit) | Stop after N new units |
| `IOCL_CENSUS_MAX_AGE_DAYS` | `3` | Staleness threshold |
| `FRESH` | (unset) | Set to `1` to restart from scratch |

### BPCL

| Variable | Default | Purpose |
|----------|---------|---------|
| `BPCL_CENSUS_CONCURRENCY` | `10` | Concurrent lanes |
| `BPCL_CENSUS_LIMIT` | (no limit) | Stop after N new units |
| `BPCL_CENSUS_MAX_AGE_DAYS` | `3` | Staleness threshold |
| `FRESH` | (unset) | Set to `1` to restart from scratch |

### Jio-bp

| Variable | Default | Purpose |
|----------|---------|---------|
| `JIOBP_CENSUS_CONCURRENCY` | `2` | Concurrent lanes — kept low out of politeness; the national census is small enough that higher concurrency wouldn't meaningfully speed it up |
| `JIOBP_CENSUS_LIMIT` | (no limit) | Stop after N new **batches** (not individual outlets — a batch is ~18 outlets) |
| `JIOBP_CENSUS_BATCH_SIZE` | `18` | Station codes per `FindFuelStation` call (18 is the observed in-app batch size) |
| `JIOBP_CENSUS_MAX_AGE_DAYS` | `3` | Staleness threshold |
| `JIOBP_CENSUS_STALE_AFTER_DAYS` | `14` | Baseline records not refreshed within this many days are pruned |

### Nayara

| Variable | Default | Purpose |
|----------|---------|---------|
| `NAYARA_CENSUS_CONCURRENCY` | `1` | Concurrent lanes — only 2 work units total, so concurrency doesn't meaningfully speed this up |
| `NAYARA_CENSUS_LIMIT` | (no limit) | Stop after N new units (there are only 2 total — the two center-point calls) |
| `NAYARA_CENSUS_MAX_AGE_DAYS` | `3` | Staleness threshold |
| `NAYARA_CENSUS_STALE_AFTER_DAYS` | `14` | Baseline records not refreshed within this many days are pruned |

---

## Concurrency tuning and WAF limits

| Brand | Safe concurrency | Time | WAF observed? |
|-------|-----------------|------|---------------|
| HPCL | 12 | ~94 min | No |
| IOCL | 12 (CI), 10 (residential) | ~3.5h | Yes — pattern-based, triggers at 15+. If failures persist, drop to 10. |
| BPCL | 10 (residential, via Tailscale) | ~25 min | No — app API, not a website. |
| Jio-bp | 2 (default, deliberately conservative) | minutes — whole census is only ~dozens of batched requests | Not calibrated; untested at higher concurrency, and there's little reason to push it given how few requests the whole census needs. |
| Nayara | 1 (default) | minutes — only ~2 large-radius API calls needed to enumerate ~9000+ stations | No — simple POST API. Only 2 work units total, so concurrency barely matters. |

---

## Resuming a killed run

By default, every census resumes — it reads the existing worklog and skips units whose latest record is `"ok"` or `"empty"` and was fetched within `maxAgeDays` (default 3).

Just re-run the same command:

```bash
# If the previous HPCL run was killed after 50%, this resumes from ~50%
npm run census:hpcl
```

The runner logs at startup: `{N} total units, {M} already done, {P} pending`.

If the worklog has been corrupted (torn write from `kill -9` mid-append), malformed lines are silently skipped and those units are re-processed.

---

## Starting fresh (clearing cache + worklog)

```bash
# Delete the worklog so every unit is re-processed
FRESH=1 npm run census:hpcl

# Or manually:
rm output/hpcl-raw.jsonl output/hpcl-worklog.jsonl
npm run census:hpcl
```

`FRESH=1` also deletes brand-specific discovery caches:

- **HPCL:** deletes `output/hpcl-discovered-urls.json` so the sitemap walk re-runs.
- **IOCL:** same as HPCL (same `locator-platform` sitemap cache).
- **BPCL:** deletes any cached route/cell discovery state.
- **Jio-bp:** nothing to delete — `discover()` has no on-disk cache, it re-fetches the full `FetchROMaster` index on every run (that call is cheap; see `docs/EDGE-CASES.md`'s Jio-bp entry for what happens if it fails).

---

## Publishing a dataset manually

```bash
npm run build-dataset                           # builds dataset/
git add dataset/
git add -f output/*-raw.jsonl.gz                # gitignored raw files
git commit -m "chore(dataset): manual publish"
git tag dataset-$(date -u +%Y%m%dT%H%M%SZ)
git push --tags
```

Then trigger `workflow_dispatch` on GH Actions with `publish_dataset: true` to run the CI publish job (or just commit directly to main if you pushed from your local machine).

There is no separate publish/CDN step — the commit above *is* the publish. Consumers fetch the committed files directly:

```
https://raw.githubusercontent.com/ForceGT/india-fuel-pumps/main/dataset/index.json
https://raw.githubusercontent.com/ForceGT/india-fuel-pumps/main/dataset/shards/<prefix>.<hash>.json
```

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| All IOCL requests 403 mid-run | WAF block | `FRESH=1` with concurrency 10, wait 30 min, restart |
| BPCL all 401 at startup | OAuth token fetch failed | Re-run — token refresh self-heals |
| BPCL all 403 | GH Actions IP blocked / Tailscale exit node unreachable | Check Tailscale connectivity, or run locally and commit raw output |
| Jio-bp census reports 0/0/0 units, finishes instantly | `FetchROMaster` index call failed (see `docs/EDGE-CASES.md`) | Re-run — usually transient; check job log for the ROMaster fetch error |
| Nayara all 419 or persistent httpFailed | CSRF token / session cookie bootstrap broke | Nayara's page structure or WAF rules changed; check `docs/nayara-api.md` and verify the session/CSRF flow still works, then re-run |
| HPCL "no such sitemap" | Sitemap structure changed | Check `petrolpump.hpretail.in/sitemap.xml` |
| `build-dataset` exits with 0 outlets | No raw JSONL files exist | Run censuses first |
| Stale data after resume | Worklog records >3 days old | Set `maxAgeDays` lower or `FRESH=1` |

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

**So we only fetch everything fresh once every 3 days, and other days just top up the leftovers?**

Close, but worth being precise about, because it's not quite a scheduled "on day 3, do a full refresh" special case — there's no such logic anywhere in the code. The rule is the exact same **every single day**: "skip any outlet whose last successful capture is less than 3 days old; scrape everything else." That's it. There's no day-counter, no "is this day 3" check.

What makes it *look* like a periodic full-refresh cycle is that outlets tend to get captured in bursts — a cold run refreshes most of a brand's outlets in one sitting, so a few days later, most of them cross the 3-day line at roughly the same time, and the next run has to re-scrape most of them again (a "cold" run). Then the day after that, almost everything is freshly captured again, so the following day's run finds almost nothing to do (a "warm" run). That rhythm repeats — but it's an emergent pattern from the same daily rule being applied to a population that happens to move together, not a special case for a specific day. If outlets got captured at staggered times instead of in one burst, you'd see a smoother, less bursty pattern with no obvious "every 3rd day" feel to it at all.

**How does "resuming" actually work, in plain terms?**

Every brand keeps a running log file (`output/{brand}-worklog.jsonl`) — one line per outlet (or batch, for Jio-bp) per attempt, recording whether that attempt succeeded and when. Before a run starts scraping anything, it reads this log and asks, for every outlet it knows about: "does the *most recent* line for this outlet say it succeeded, and was that within the last 3 days?" If yes, that outlet is skipped entirely — zero requests made for it this run. If no — either it's never been captured, or its last attempt failed, or its last success is now too old — it goes into this run's queue to be (re-)scraped.

The important asymmetry: a **failure is never treated as "done."** No matter how recent a failed attempt was, that outlet stays in the queue and gets retried on every subsequent run until it actually succeeds. Only a genuine success (or a confirmed "nothing here," which counts the same way) can mark an outlet as done. This is deliberate — it means a transient blip can never quietly turn into a permanent gap in the data, because nothing except an actual successful fetch is ever allowed to stop the retries.

On top of that, before writing anything new, each run also reloads whatever was already published for that brand, drops any single duplicate outlet down to just its most-recently-captured version, and throws out anything that hasn't had a successful capture in the last 14 days (on the assumption that a station nobody's been able to re-confirm for two weeks has probably closed or moved). Everything newly scraped this run gets added on top of that. So the published data for a brand is always "everything still recently confirmed alive," continuously topped up — never something that resets to empty and rebuilds from scratch, even if a run gets killed halfway through.

**What actually protects us if the internet breaks mid-run — Tailscale dropping, a DNS blip, a site briefly unreachable, etc.?**

There are a few independent layers, each catching a different kind of failure:

1. **Every single HTTP request already retries itself.** Any request that gets a 429 (rate-limited), a 5xx server error, or an outright connection failure (DNS lookup failing, a TCP reset, a timeout — the kind of thing a flaky network link causes) is automatically retried up to 3 times with an increasing delay between attempts, before the scraper even considers it a failure. Most brief blips never even show up as a failure — they just cost a couple of extra seconds.
2. **If a request still fails after those retries, the worklog catches it.** As explained above, that outlet just gets marked as failed (not done) and automatically retried on the *next* run — tomorrow's scheduled run, or a manual re-trigger. No one has to notice and manually re-queue anything.
3. **Progress is saved even if the whole job gets killed.** The worklog is written back to GitHub's cache with a setting that says "do this even if an earlier step in the job failed or the job timed out" — so if, say, the network drops entirely halfway through a 3-hour run and the whole job dies, everything successfully scraped up to that point is still preserved for the next run to build on, rather than being thrown away.
4. **BPCL's Tailscale link specifically degrades gracefully, not silently.** If the residential-IP exit node isn't configured at all, that day's BPCL job is skipped outright (not attempted, not marked as failed) and the published dataset just keeps using the last successfully-committed BPCL data. If it *is* configured but happens to be unreachable at that exact moment, connecting to it fails as a normal job failure — which triggers the same fallback (last committed data used) plus an automatic GitHub issue getting filed so it's visible, and an automatic close/comment on that issue once BPCL succeeds again on a later run.
5. **One last backstop at publish time:** even if a run *reports* success but something went wrong in a way that made it scrape far less than usual (a bug, a bad partial resume), the publish step independently checks whether any brand's count dropped by more than half from what was previously published — and refuses to publish if so, rather than trusting the run's own "success" verdict blindly.

Put together: single-request blips are absorbed silently, request-level failures are retried automatically the next day, whole-job failures don't lose progress, a broken Tailscale link degrades to "use yesterday's data and tell someone" instead of breaking the whole pipeline, and a final sanity check guards against a subtly-broken run corrupting the published dataset. Nothing in this pipeline assumes the network will behave — every layer assumes it won't, and has a specific fallback for it.

*(If any of the above doesn't match what you were expecting — say so and we'll dig into the specific piece further.)*
