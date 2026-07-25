# Shell India locator — reverse-engineered reference

How `shell.in`'s "Shell Station Locator"
(`/shell-service-station/shell-station-locator.html`) fetches outlet data,
and how Shell separately publishes an indicative city-level price table.
Captured via Chrome DevTools MCP (live page inspection + network capture),
verified end-to-end with standalone `curl`/`python` calls from a cold start
(no browser, no cookies).

> **Status:** working contract, verified end-to-end on 2026-07-25.

---

## Site architecture

The locator page embeds an `<iframe>` pointing at a third-party locator SaaS,
**not** Shell's own infrastructure:

```
https://shellretaillocator.geoapp.me/?locale=en_IN
```

`geoapp.me` ("GeoApp") appears to be a white-labelled store/fuel-station
locator widget vendor used by multiple brands globally (the config JSON and
amenity list reference many non-Shell markets/products). The widget calls a
plain REST JSON API on the same host — no auth, no session, no CSRF, works
from a bare `curl` with only a `User-Agent` header (this repo's honest
`IndiaFuelPumpsBot` UA works fine — confirmed, unlike Nayara's Akamai WAF).

Two relevant endpoints:

| Purpose | Endpoint | Notes |
|---|---|---|
| Enumerate by bounding box | `GET /api/v2/locations/within_bounds` | Returns either individual `locations[]` or aggregated `clusters[]`, never both — see below |
| Full detail for one outlet | `GET /api/v2/locations/{id}` | No query params needed; only source of the `fuels` list, opening hours, `fuel_pricing` |

A third endpoint, `GET /api/v2/locations/nearest_to?lat&lng&limit≤50`, also
exists (used by the widget's "near me" mode) and returns richer per-location
data than `within_bounds` (includes `fuels`) but is capped at `limit=50` and
is redundant with the bbox-walk + per-id detail approach below, so it isn't
used by the provider.

There's also `GET /api/v2/on_street_charger_locations/within_bounds` — a
**separate asset class** (standalone EV street chargers, not fuel stations).
Out of scope for this repo.

---

## Enumeration: bounding-box walk with cluster/location toggle

`within_bounds` takes `sw[]=lat&sw[]=lng&ne[]=lat&ne[]=lng` plus
`with_any[fuel_type][]=conventional&with_any[fuel_type][]=ev&locale=en_IN&format=json&driving_distances=false`.

The response is **either**:
- `{"locations": [...], "clusters": []}` — full per-outlet stubs, when the
  bbox is "small enough" (empirically: some function of result density, not
  a fixed degree-span or fixed count — a 15°×20° box returned 200
  uncluttered locations in one region but clustered at 378 in a denser one),
  or
- `{"locations": [], "clusters": [...]}` — aggregated cluster blobs
  (`centroid`, `bounds`, `size`) when there are "too many" to enumerate
  individually.

No documented threshold — the provider handles this the same way this repo's
BPCL provider handles saturation: **recursive quadrant subdivision**. Query a
bbox; if it comes back clustered, split into 4 sub-bboxes and recurse; once a
sub-bbox returns `locations` (not `clusters`), that's a leaf. A full-India
walk from the same outer bounds as BPCL's grid (`6.5–37.5°N, 68–97.5°E`)
resolves to leaves within a handful of levels and no leaf has ever come back
still-clustered in testing — found **342 unique India locations**
(`country_code === "IN"`, since the bbox slightly overshoots into
Pakistan/Nepal/Bangladesh/Myanmar/Sri Lanka at the edges).

Stub fields from `within_bounds` (`id`, `name`, `lat`, `lng`, `address`,
`city`, `state`, `postcode`, `telephone`, `site_category`, ...) are missing
`fuels` and `opening_hours` — those only appear on the per-id detail call.

Categories observed in the India dataset: `conventional_fuel_site` (281),
`conventional_fuel_site_with_ev` (54), `destination_charging_ev` (7, EV-only,
no forecourt). All three are captured — this repo doesn't filter by category,
same as it doesn't filter by grade; an EV-only site's `products` list is just
empty (whatever `fuels` reports, verbatim), never fabricated.

---

## Detail: `GET /api/v2/locations/{id}`

No auth, no query params. Returns everything `within_bounds` has plus:

```json
{
  "fuels": ["premium_gasoline", "premium_diesel", "midgrade_gasoline", "shell_regular_diesel"],
  "opening_hours": [{"days": ["Mon", "Sun"], "hours": [["06:00", "22:00"]]}],
  "fuel_pricing": {"status": "unavailable"},
  "website_url": "https://find.shell.com/in/fuel/12665703-davanagere-old-pb-rd"
}
```

**`fuel_pricing.status` was `"unavailable"` on every India id sampled
(7 spot-checked across states)** — Shell's own locator does not publish
per-outlet prices for India through this API. So every `RawProduct` this
provider emits has `priceInr: null` — a real product name, no price, exactly
as the source reports (or rather, doesn't report) it. If `fuel_pricing` ever
carries real numbers for some outlet, the parser should pick it up rather
than assuming permanently unavailable, but nothing in the sampled data
suggested a different shape to code defensively against beyond the
`status` check.

`fuels` values are internal GeoApp product-type slugs (`premium_gasoline`,
`shell_regular_diesel`, `midgrade_gasoline`, `premium_diesel` seen so far) —
captured verbatim, no grade opinion, matching every other provider in this
repo.

**Note for humans reading this doc (NOT applied to scraped data — `products[].name`
stays the raw slug, per this repo's no-cleanup/no-renaming policy):** these
slugs plausibly correspond to Shell's branded fuel names as follows, going
purely by naming resemblance to the grade codes in the city-price table
below — **this mapping is an unconfirmed guess, not something either API
asserts**:

| GeoApp slug | Likely Shell branded name (unconfirmed) |
|---|---|
| `midgrade_gasoline` | Shell's regular, unbranded petrol |
| `shell_regular_diesel` | Shell's regular diesel |
| `premium_gasoline` | Shell V-Power petrol (Shell's premium petrol line) |
| `premium_diesel` | Shell V-Power diesel (Shell's premium diesel line) |

---

## Politeness / rate limits

No rate limiting observed: 15 rapid sequential `within_bounds` calls all
returned `200` with no backoff signal. Total request budget for a full
census: ~dozens of `within_bounds` calls during the bbox walk (discovery) +
~342 detail calls (one per outlet) — small compared to HPCL/IOCL/BPCL.

---

## City-level indicative price table (a separate asset, not the locator API)

Shell separately publishes a page,
`shell.in/fuels-oils-and-coolants/shell-fuels/fuel-pricing-in-india.html`,
showing indicative prices for **4 fuel grades across 22 major cities**
(state capitals and other large metros — Ahmedabad, Bangalore, Mumbai,
Chennai, ... — not anywhere close to this repo's ~342 Shell outlets, most of
which are in smaller towns). The 4 grades, spelled out (the source workbook
itself only uses the short codes shown in parentheses — see below):

- **Unleaded petrol** (`ULP`) — Shell's regular, unbranded petrol
- **High-speed diesel** (`HSD`) — Shell's regular diesel; "high-speed diesel"
  is the standard Indian fuel-industry term for ordinary automotive diesel
- **Shell V-Power petrol** (`SVPM`) — Shell's premium petrol line
- **Shell V-Power diesel** (`SVPD`) — Shell's premium diesel line

The page carries its own disclaimer, verbatim:

> "These prices are for indicative purposes only and may not reflect most
> recent price changes. Please check at your nearest shell outlet for
> up-to-date pricing information."
>
> "Prices might vary from site to site in the same city"

**This is a city-average estimate, not a per-outlet fact.** This repo's
schema (`RawOutletRecord.products[].priceInr`) means "the source reported
this exact price for this exact outlet" — every other provider in this repo
enforces that. Joining this table onto outlet records by city match would
silently violate that guarantee for anyone consuming `shell-raw.jsonl.gz` as
outlet-truth. **Deliberate decision: this data is never merged into
`RawOutletRecord` — it's a separate artifact with its own record shape**
(`output/shell-city-prices.jsonl`, via `npm run pricing:shell`), so a
downstream consumer can join on `city` themselves with full knowledge of
what it actually is.

### How the table gets onto the page

The rendered HTML does **not** contain the table server-side — confirmed by
`curl`ing the page directly: the price values and city names are absent from
the raw response. The table is built client-side (React/JS) from a
downloadable spreadsheet the page links to.

1. `GET {page}.model.json` (AEM's headless content model endpoint — same
   pattern as any AEM site's `.model.json` suffix) contains a `links[]`
   array with the CURRENT `.xlsx` asset URL, e.g.:
   ```
   https://www.shell.in/.../item0.stream/1780980161998/<hash>/india-price-update.xlsx
   ```
   **This URL is NOT stable across runs** — it's a content-hashed AEM DAM
   asset path that changes every time Shell re-uploads updated prices (the
   numeric segment is a timestamp, the hex segment a content hash). It must
   be rediscovered from `.model.json` on every run, never hardcoded or
   cached beyond a single scrape.
2. `GET` that `.xlsx` URL — a plain small (~11KB) Excel workbook, single
   sheet, no auth needed.

### The `.xlsx` itself

A `.xlsx` is a ZIP archive of small XML parts (verified with Python's
`zipfile`: 11 entries, all DEFLATE-compressed, no zip64, no encryption).
Relevant parts:

- `xl/sharedStrings.xml` — the string table (city names, header labels)
  referenced by index from cells.
- `xl/worksheets/sheet1.xml` — the grid: row 1 is the header (`City`, `ULP`,
  `HSD`, `SVPM`, `SVPD` in this file — column ORDER isn't hardcoded by the
  parser, since Shell controls the layout, not this repo), each subsequent
  row a city + its 4 prices.
- `docProps/core.xml` — the workbook's own `<dc:description>` field
  literally contains "...These prices are effective from 26 May 2026",
  which is where `effectiveDate` comes from (not scraped from the page's
  separate "Effective date - ..." heading, which is AEM content, not part of
  the spreadsheet itself).

This repo does NOT depend on a general-purpose xlsx library (`exceljs`,
`xlsx`/SheetJS, ...) for this — every one of them pulls in either a
write-path archiver with real advisories (`exceljs` → `archiver` →
`zip-stream`/`archiver-utils` → vulnerable `glob`/`minimatch`/
`brace-expansion`, none of which this read-only use case ever executes, but
which still sit in the dependency tree) or comparable supply-chain baggage,
for a need this small. Instead: `src/lib/minizip.ts` is a ~100-line
hand-rolled ZIP reader (End-Of-Central-Directory → Central Directory →
Local File Header, `node:zlib.inflateRawSync` for DEFLATE) plus a small
regex-based XML cell/shared-string parser in `src/parsers/shell-pricing.ts`.
Zero new dependencies.

### Cadence

Effective dates observed so far update roughly monthly (this snapshot: 26
May 2026). Unlike the per-outlet census, there's no meaningful concept of
"resumability" here — it's one page, one small file, ~22 rows in a single
run. `npm run pricing:shell` just re-fetches and overwrites
`output/shell-city-prices.jsonl` each time; not wired into the daily census
cron (`.github/workflows/census.yml`) — that's a separate decision for
whoever wants this published on a schedule.
