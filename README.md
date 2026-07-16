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
