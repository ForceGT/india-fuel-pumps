# India Fuel Pumps — Open Dataset

An open, machine-readable dataset of fuel pumps (petrol pumps) across India:
**location, contact, brand, the fuel types they carry, and price where available.**

It exists to make it possible to find *specific* fuel grades — starting with the hard
one: **ethanol-free (E0) premium petrol** (IndianOil **XP100**, HPCL **Power 100**, BPCL
**Speed 100**), which older engines are tuned for and which is genuinely hard to locate now
that E20 is near-universal. Coverage will expand to more brands and grades over time.

> ⚠️ **Unofficial. Always confirm at the pump.** This data is compiled from public sources
> and can be out of date or wrong. Never rely on it for a decision that a wrong answer would
> cost you — call the pump (numbers are included) to confirm availability and price.

## What's in it

- **Current coverage:** ethanol-free (E0) outlets nationwide (HPCL + IndianOil), with more
  brands (Jio-bp, Nayara, Shell) and grades planned.
- **Per pump:** id, brand, name, coordinates, address, city/state, contact number, the
  grades it carries, price (where published), and — critically — a **`lastVerifiedAt`
  timestamp, `source`, and `confidence`** on every record, so you always know how fresh and
  trustworthy a given row is.

## Format

The dataset is **geohash-sharded** so a map client only downloads the tiles it needs:

```
dataset/
  index.json                      # the map-index: which shards exist + a content hash of each
  shards/<geohash3>.<hash>.json   # pumps in one ~156 km cell; { "prefix", "stations": [...] }
```

- Read `dataset/index.json` first; it lists every non-empty shard with its file path.
- Each shard filename embeds a content hash, so a shard is **immutable** — an unchanged cell
  keeps the same URL across updates and stays cached; only cells whose data changed re-download.
- `station` records are documented in the finder project's `docs/lld-shard-format.md`.

## Update cadence

- **Ethanol-free (E0) / premium-100 outlets: refreshed daily.**
- **Other brands / grades: refreshed roughly monthly.**

Updates are produced by an automated pipeline (GitHub Actions) that re-checks the official
public outlet locators and commits the regenerated dataset here.

## Scraper code

`src/` has the crawlers that produce this data — `pnpm census:hpcl` / `census:iocl` /
`census:bpcl` (see `package.json`). Each is a `Provider` (`src/provider.ts`) run through a
shared, resumable worker pool (`src/run-provider.ts`): discover every outlet, fetch it
politely (rate-limited, identifies itself via `USER_AGENT`), and write two append-only JSONL
files per brand — `output/<brand>-raw.jsonl` (one `RawOutletRecord` per outlet: location,
contact, **every product + price the source reports, exactly as reported**) and
`output/<brand>-worklog.jsonl` (crawl-attempt bookkeeping, so a killed run resumes instead of
restarting).

**No fuel-grade classification happens here, by construction** — `src/types.ts`'s
`RawOutletRecord` has no concept of "ethanol-free" or any other grade, only raw product names
and prices. Deciding what counts as E0 (or any other classification) is a downstream
consumer's job — E0 Finder (see the footer below) is the first one, but any project can
build its own classification on top of this raw data without needing to re-scrape.

## Using it (via CDN)

Serve straight from a CDN — do **not** hammer `raw.githubusercontent.com` (rate-limited):

```
https://cdn.jsdelivr.net/gh/ForceGT/india-fuel-pumps@main/dataset/index.json
https://cdn.jsdelivr.net/gh/ForceGT/india-fuel-pumps@main/dataset/shards/<file>
```

## Provenance & license

- Data is derived from **public** official oil-company outlet locators (no login, no
  scraping of gated/personal data). Contact numbers are the pumps' listed business numbers.
- **License: [MIT](./LICENSE)** — use it freely for anything, commercial or not; just keep
  the copyright + license notice. No warranty (see the disclaimer above).

## Contributing

Corrections are welcome — if a pump is wrong, closed, or no longer carries a grade, open an
issue. A crowdsourced "was it available?" signal is planned.

---

Maintained alongside **E0 Finder**, a project to help people in India find the fuel grade
their vehicle needs. Not affiliated with any oil company.
