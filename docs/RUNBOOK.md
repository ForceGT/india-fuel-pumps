# Runbook

## Prerequisites

```bash
git clone https://github.com/ForceGT/india-fuel-pumps
cd india-fuel-pumps
npm install
```

Requires Node 20+ (tested on Node 22). No API keys or secrets — all three sources are public and require no authentication (except BPCL's OAuth, which is fetched dynamically).

---

## Running a full census (all brands)

```bash
# Run all three (locally, sequentially — CI runs them in parallel)
npm run census:hpcl && npm run census:iocl && npm run census:bpcl && npm run build-dataset
```

### What each step produces

| Step | Output files |
|------|-------------|
| `census:hpcl` | `output/hpcl-raw.jsonl`, `output/hpcl-worklog.jsonl` |
| `census:iocl` | `output/iocl-raw.jsonl`, `output/iocl-worklog.jsonl` |
| `census:bpcl` | `output/bpcl-raw.jsonl`, `output/bpcl-worklog.jsonl` |
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
```

---

## BPCL — GH Actions IP block workaround

The BPCL API (`api.cep.bpcl.in`) occasionally returns 403 from GitHub Actions datacenter IPs. When this happens:

**Diagnose:** Look for `"status":"httpFailed"` entries in `output/bpcl-worklog.jsonl` with `detail` mentioning 403. A full-block scenario shows all work units failing with 403.

**Workaround:** Run BPCL from a residential/mobile IP:

```bash
# On your local machine (not GH Actions)
git clone … && cd india-fuel-pumps && npm install
npm run census:bpcl

# Compress and commit the raw output the publish job expects
gzip -f output/bpcl-raw.jsonl
git add -f output/bpcl-raw.jsonl.gz
git push
```

Then trigger the GH Actions publish workflow manually (`workflow_dispatch`) — it will find the pushed BPCL output alongside HPCL/IOCL's CI-generated outputs and build the complete dataset.

**Root cause:** The BPCL API likely has geo-IP or cloud-provider-IP-range filtering, not an explicit block of this project. It works intermittently from GH Actions. A residential IP always works.

---

## Environment variables per brand

### HPCL

| Variable | Default | Purpose |
|----------|---------|---------|
| `HPCL_CENSUS_CONCURRENCY` | `12` | Concurrent lanes |
| `HPCL_CENSUS_LIMIT` | (no limit) | Stop after N new units (smoke tests) |
| `HPCL_CENSUS_MAX_AGE_DAYS` | `30` | Staleness threshold for resume |
| `HPCL_CENSUS_STATE_ALLOWLIST` | (all) | Comma-separated states to scope crawl |
| `FRESH` | (unset) | Set to `1` to delete cache + worklog and restart from scratch |

### IOCL

| Variable | Default | Purpose |
|----------|---------|---------|
| `IOCL_CENSUS_CONCURRENCY` | `12` | Concurrent lanes (max safe = 12 from CI, 10 from residential) |
| `IOCL_CENSUS_LIMIT` | (no limit) | Stop after N new units |
| `IOCL_CENSUS_MAX_AGE_DAYS` | `30` | Staleness threshold |
| `FRESH` | (unset) | Set to `1` to restart from scratch |

### BPCL

| Variable | Default | Purpose |
|----------|---------|---------|
| `BPCL_CENSUS_CONCURRENCY` | `4` | Concurrent lanes |
| `BPCL_CENSUS_LIMIT` | (no limit) | Stop after N new units |
| `BPCL_CENSUS_MAX_AGE_DAYS` | `30` | Staleness threshold |
| `FRESH` | (unset) | Set to `1` to restart from scratch |

---

## Concurrency tuning and WAF limits

| Brand | Safe concurrency | Time | WAF observed? |
|-------|-----------------|------|---------------|
| HPCL | 12 | ~94 min | No |
| IOCL | 12 (CI), 10 (residential) | ~3.5h | Yes — pattern-based, triggers at 15+. If failures persist, drop to 10. |
| BPCL | 4 | ~25 min | No — app API, not a website.

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

The dataset is served via jsDelivr:

```
https://cdn.jsdelivr.net/gh/ForceGT/india-fuel-pumps@main/dataset/index.json
https://cdn.jsdelivr.net/gh/ForceGT/india-fuel-pumps@main/dataset/shards/<prefix>.<hash>.json
```

---

## Common failure modes

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| All IOCL requests 403 mid-run | WAF block | `FRESH=1` with concurrency 10, wait 30 min, restart |
| BPCL all 401 at startup | OAuth token fetch failed | Re-run — token refresh self-heals |
| BPCL all 403 | GH Actions IP blocked | Run locally, commit raw output, re-trigger CI |
| HPCL "no such sitemap" | Sitemap structure changed | Check `petrolpump.hpretail.in/sitemap.xml` |
| `build-dataset` exits with 0 outlets | No raw JSONL files exist | Run censuses first |
| Stale data after resume | Worklog records >3 days old | Set `maxAgeDays` lower or `FRESH=1` |
