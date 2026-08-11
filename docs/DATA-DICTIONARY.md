# Data Dictionary

## The problem this schema is solving

Six sources, six completely different ideas of what a fuel outlet even *is*.
HPCL and IOCL scrape a real web page with a JSON-LD block and structured
opening hours. BPCL and Jio-bp are app backends that hand back whatever
fields their mobile app happened to need — no opening hours at all, in
BPCL's case. Nayara's API is thinner still: no city, no state, no phone
number, nothing but a name, an address string, and two prices. Shell has
locations and hours but never a price.

Two bad options were available and both were rejected. Take the *union* of
every field any source ever provides, and you get a schema that's honest but
where almost every record has a dozen `null`s — technically correct, useless
to skim. Take the *intersection* — only fields every single source agrees
on — and you'd be left with little more than a name and coordinates,
throwing away real data that five of the six sources do report.

The actual answer: **one shape wide enough for the richest source, with
explicit `null` standing in for "this source doesn't say."** Nothing is
fabricated to fill a gap, and nothing a source *does* report gets thrown
away to keep the shape uniform. What follows is that shape, built up
piece by piece in the order the problems actually showed up: first, how to
describe one outlet; then how to describe one product/price on it; then how
to recognize the *same* outlet again tomorrow, or across a different brand's
overlapping data; then how to record whether a fetch attempt worked at all;
and finally how ~103,000 of these individual records become one
downloadable dataset.

---

## Step 1 — describing one outlet: `RawOutletRecord`

This is the atomic unit. One JSON object per line in `output/{brand}-raw.jsonl`,
one object per outlet, defined in `src/types.ts`. Every field that isn't
universally available is nullable — not as a hedge, but because forcing a
value where a source has none would mean inventing data this project
explicitly promises never to invent.

A few fields carry a decision worth knowing before looking at the table:

- **`name` always comes from the live page/response, never a static roster.**
  If an OMC's own downloadable outlet list disagrees with what that same
  OMC's live per-outlet page currently shows, the live page wins — dealer
  names change, franchises get reassigned, and the live page is the more
  current signal every time.
- **`city`/`state` are the raw strings the source reports, not reconciled
  against any gazetteer.** "Bengaluru" and "Bangalore" are not merged into
  one canonical spelling here — a consumer with its own geo-normalization
  can do that; baking one reconciliation scheme into this repo would just
  mean every consumer inherits this project's specific opinion about it,
  wanted or not.
- **`schemaVersion` exists because this file is committed to git forever.**
  A future breaking change to the shape needs a way to say "records after
  this point mean something different," without silently reinterpreting old
  history.

| Field | Type | Nullable | Description | Example |
|-------|------|----------|-------------|---------|
| `schemaVersion` | `number` | No | Schema version (currently `1`). Incremented on breaking changes. | `1` |
| `brand` | `string` | No | OMC brand — one of `"HPCL"`,`"IOCL"`,`"BPCL"`,`"JioBP"`,`"Nayara"`,`"Shell"` | `"HPCL"` |
| `outletId` | `string` | No | The source's own internal ID for this outlet. HPCL/IOCL: the trailing digits of the outlet's `/Home` URL. BPCL: `roId`. JioBP: `FuelStationCode` (e.g. `"MHC117"`). Nayara: `cms_code`. Shell: the `geoapp.me` location id. | `"398563"` |
| `stationId` | `string` | No | Stable dedup key — see [Step 3](#step-3-recognizing-the-same-outlet-again-stationid) below. | `"a1f9c3d7e2b60481"` |
| `sourceUrl` | `string` | Yes | Canonical source reference. HPCL/IOCL: the outlet's own `/Home` page. BPCL: the same details API endpoint the outlet's data came from — **not** `null`; there's no separate public web page, but the API URL is still a real, fetchable reference. JioBP/Nayara: the shared API endpoint constant (not per-outlet — there's no per-outlet page or id-addressable URL). Shell: the outlet's own `website_url` if published, else the detail endpoint. | `"https://petrolpump.hpretail.in/hpcl-deepak-mittal-service-provider-petrol-pump-kathgodam-haldwani-398563/Home"` |
| `capturedAt` | `string` | No | ISO-8601 timestamp of when our crawler retrieved this data from the source. | `"2026-07-20T03:14:42.123Z"` |
| `name` | `string` | No | Outlet name from the source's live page/response. | `"Deepak Mittal Service Provider"` |
| `address` | `string` | Yes | Full street address. `null` if the source didn't provide one. | `"NH 24, Haldwani Road, Kathgodam, Haldwani, Uttarakhand"` |
| `city` | `string` | Yes | Raw, unreconciled. Always `null` for JioBP (its `Address` is one free-text field) and Nayara (not provided). Populated for HPCL, IOCL, BPCL, and Shell. | `"Haldwani"` |
| `state` | `string` | Yes | Raw, unreconciled. Always `null` for Nayara (not provided). JioBP gets this from a separate index lookup, not the per-outlet response itself. | `"Uttarakhand"` |
| `pincode` | `string` | Yes | PIN code as published. `null` if not provided (always `null` for JioBP and Nayara). | `"263139"` |
| `lat` | `number` | No | Latitude in decimal degrees (WGS84). | `29.2205` |
| `lng` | `number` | No | Longitude in decimal degrees (WGS84). | `79.5186` |
| `geohash` | `string` | No | Geohash of `lat`/`lng` at precision 7 (~150 m cell), via `geohashEncode` in `src/geo.ts`. Used for sharding at precision 3 — see [Step 5](#step-5-from-one-outlet-to-one-published-dataset). | `"ttn0q70"` |
| `hours` | `string` | Yes | Opening hours as free text, where the source has a structured field for it (HPCL/IOCL's JSON-LD, Shell's location detail). Always `null` for BPCL, JioBP, and Nayara — none of their APIs publish it. | `"Mon-Sat 06:00-22:00, Sun 08:00-20:00"` |
| `contact` | `string` | Yes | Phone number as published, `tel:` prefix stripped. Always `null` for Nayara only. | `"05946-123456"` |
| `mapsLink` | `string` | Yes | Google Maps directions URL, only when the source itself publishes one (HPCL/IOCL's JSON-LD `hasMap`). Always `null` for BPCL, JioBP, Nayara, and Shell. | `"https://maps.google.com/?q=29.2205,79.5186"` |
| `amenities` | `string[]` | Yes | Raw facility/service flags exactly as the source reports them (e.g. BPCL's `"ATM"`, `"Pure_Sure"`, `"TWO_FOUR_SEVEN"`). `null` for brands/records that don't report this at all — not the same as "checked, found none". | `["ATM", "Pure_Sure"]` |
| `categories` | `string[]` | Yes | Ownership/format classification codes this repo actively checked for and confirmed — **not equally trustworthy across brands**, see [METHODOLOGY.md](./METHODOLOGY.md#why-categories-isnt-equally-trustworthy-across-brands). `[]` means "checked, matched none of the tracked categories"; `null` means "not checked at all" (no brand currently emits `null` at runtime). | `["Owned_Operated"]`, `["COCO"]`, `[]` |

---

## Step 2 — describing what's sold there: `RawProduct`

Part of `RawOutletRecord.products[]`. This shape exists because a product
card and its price are, surprisingly often, *two separate facts* — a source
can clearly say "this outlet sells XP100" while its price field is blank,
malformed, or zero. Collapsing "no price shown" into "no product" would
silently delete a true fact (the outlet does sell it); collapsing it into
"price is zero" would fabricate a false one. So the two are kept
independent: the product's presence and its price can each be true, false,
or unknown on their own terms.

| Field | Type | Nullable | Description | Example |
|-------|------|----------|-------------|---------|
| `name` | `string` | No | Product name exactly as the source wrote it. No cleanup, no casing fixes, no BS-suffix stripping. | `"XP100"`, `"Speed 100"`, `"Power 100"`, `"Diesel"`, `"XP95"` |
| `priceInr` | `number` | Yes | Price per litre in Indian Rupees. `null` if a product card/entry was present but the price was missing, non-positive, or unparseable — never fabricated. **Always `null` for every Shell product** — Shell's India locator doesn't publish per-outlet prices at all (see [shell-api.md](./shell-api.md)); the product name is still captured. | `167.35`, `null` |

---

## Step 3 — recognizing the same outlet again: `stationId`

Once individual records exist, a new problem shows up immediately: the same
physical pump can appear more than once. BPCL's route-mesh and grid-crawl
discovery overlap and can both find the same station. Nayara's two large-radius
queries deliberately overlap as a safety margin. And every brand gets
re-scraped on a rolling basis, so the same outlet is captured again and
again over time, each capture its own line in the raw file.

None of that is a bug to prevent at scrape time — it's cheaper and safer to
let duplicates happen and collapse them afterward than to try to detect
"have I already seen this one" mid-crawl. That collapsing needs a stable
key: something that comes out identical for the same physical outlet no
matter how many times, or by which discovery path, it gets captured — and
that can *never* collide between two different brands' outlets, since brand
IDs are only unique within their own source.

`stationId` (`makeStationId` in `src/id.ts`) is the first 16 hex characters
of `SHA-1("{brand}:{outletId}:{lat}:{lng}")`. Not a human-readable composite
string — a genuine hash. `brand` is folded into the input specifically so
two different brands' outlets, even at identical coordinates (a shared
forecourt, say), can never produce the same `stationId`. Wherever this
project needs to answer "is this the same outlet as that one," the answer is
just string equality on this one field — see `dedupeByStationId` in
`src/build-dataset.ts`, which keeps whichever captured copy has the newest
`capturedAt` and discards the rest.

---

## Step 4 — recording whether a fetch actually worked: `WorkLogRecord`

`RawOutletRecord` describes an outlet. It says nothing about whether *this
run's attempt* to fetch that outlet succeeded — and that's deliberate.
Whether an HTTP request came back 200 or 403 is a fact about a scrape
attempt, not a fact about a fuel pump, so it doesn't belong in the same file
or the same shape as the outlet data itself. Mixing the two would also mean
a failed attempt's leftovers (a partial parse, a stale cached value) could
end up sitting in the data file looking like a real outlet record — keeping
them in genuinely separate files makes that impossible by construction.

One JSON object per line in `output/{slug}-worklog.jsonl`, defined in
`src/types.ts`:

| Field | Type | Nullable | Description | Example |
|-------|------|----------|-------------|---------|
| `workUnitId` | `string` | No | The `WorkUnit.id` this record is for — shape varies per brand, see below. | `"https://petrolpump.hpretail.in/hpcl-.../398563/Home"` |
| `status` | `string` | No | One of `"ok"`, `"empty"`, `"httpFailed"`, `"parsedNull"`, `"errored"`. Only `ok`/`empty` are treated as "done" on resume. Any other status is always retried. | `"ok"` |
| `recordCount` | `number` | No | Number of `RawOutletRecord`s this work unit produced. `0` for `empty`, `httpFailed`, etc. | `1` |
| `saturated` | `boolean` | Yes | BPCL only. `true` when a grid cell hit the saturation threshold (≥100 results) and was subdivided. Absent for other brands. | `true` |
| `detail` | `string` | Yes | Human-readable detail about the result — the error reason for failures. | `"HTTP 403"` |
| `fetchedAt` | `string` | No | ISO-8601 timestamp of when the work unit was processed. Used for staleness checks on resume. | `"2026-07-20T03:14:42.123Z"` |

`workUnitId` isn't always "one outlet" — it's whatever unit that brand's
discovery strategy actually works in:

| Brand | Shape | Example |
|---|---|---|
| HPCL / IOCL | The outlet's `/Home` page URL (1 unit = 1 outlet) | `"https://locator.iocl.com/indianoil-patel-petroleums-petrol-pump-lulla-nagar-pune-183933/Home"` |
| BPCL (route) | `"{cityA}->{cityB}#{chunkIndex}"` | `"Delhi->Jaipur#0"` |
| BPCL (grid cell) | `"d{depth}:{lat.toFixed(5)}:{lng.toFixed(5)}:{radiusMeters}"` | `"d0:23.25990:77.41260:75000"` |
| JioBP | `"batch-{12-hex-char SHA-1 of the sorted station codes}"` — one unit = a batch of ~18 stations | `"batch-8f2a91c3d4e5"` |
| Nayara | `"center-bhopal"` or `"center-kolkata"` — one of exactly two fixed center points | `"center-bhopal"` |
| Shell | The outlet's `geoapp.me` location id (1 unit = 1 outlet) | `"12345"` |

### Status semantics

The asymmetry here is the single most load-bearing design decision in the
whole pipeline — see [ARCHITECTURE.md](./ARCHITECTURE.md#runprovider-srcrun-providerts)
for the full reasoning behind why only `ok`/`empty` can ever mark a unit as
done:

| Status | Meaning | Resume behavior |
|--------|---------|-----------------|
| `ok` | Unit processed successfully, produced ≥1 record | **Marked done** — skipped on resume |
| `empty` | Unit processed successfully, produced 0 records (e.g. BPCL's "NoDataFoundError" over open ocean) | **Marked done** — skipped on resume |
| `httpFailed` | HTTP request completed but returned a non-OK status (403, 404, 500, etc.) | **Always retried** |
| `parsedNull` | HTTP OK, but the response body couldn't be parsed into an outlet (HTML/JSON shape changed, or a response that came back structurally empty when it shouldn't have) | **Always retried** |
| `errored` | An unhandled exception occurred during processing (connection failure, missing required field, etc.) | **Always retried** |

---

## Step 5 — from one outlet to one published dataset

Individually, the pieces above answer "what is this outlet" and "did we
successfully fetch it." What's still missing is how ~103,000 of these
records, scraped independently across six brands, become the one thing a
consumer actually downloads.

The scale problem is straightforward: nobody rendering a local map wants to
download all 103,000 records to show the twelve pumps near them. So the
merged, deduped dataset (`src/build-dataset.ts`) is split by **geohash**
prefix — the first 3 characters of each outlet's geohash, which naturally
groups outlets into roughly 156 km cells without needing any external
geographic data or lookup table; the grouping falls straight out of the
coordinates themselves.

Splitting into files creates a second, smaller problem: if every publish
renamed every file, every consumer's cache would be worthless — a client
would have to re-download the whole country on every update just to catch
one changed price. The fix is naming each shard by the **SHA-256 hash of its
own contents**, not by a run number or timestamp. A cell whose outlets
haven't changed produces the exact same filename it had before, so an
unchanged cell simply isn't re-downloaded; only cells that actually changed
get a new filename, and everything else stays cached exactly where it was.

### `dataset/index.json`

The manifest — the thing a consumer fetches first to find out which shard
files currently exist.

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `number` | Currently `1`. |
| `generatedAt` | `string` | ISO-8601 timestamp of when the dataset was built. |
| `totalOutlets` | `number` | Total unique outlets across all brands. One outlet can only appear once (deduped by `stationId`). |
| `brands` | `Record<string, number>` | Per-brand outlet counts. Keys are brand slugs (`"hpcl"`, `"iocl"`, `"bpcl"`, `"jiobp"`, `"nayara"`, `"shell"`). A brand whose raw JSONL was missing/empty this run is omitted entirely (not set to `0`) — see `missingBrands` in `dataset/release-stats.json`. |
| `shards` | `ShardEntry[]` | Array of shard descriptors (see below). |

#### `ShardEntry`

| Field | Type | Description |
|-------|------|-------------|
| `prefix` | `string` | 3-character geohash prefix for this cell (~156 km). |
| `file` | `string` | Relative path to the shard file: `"shards/<prefix>.<hash>.json"`. |
| `count` | `number` | Number of outlets in this shard. |

### Shard file

Each file at `dataset/shards/{prefix}.{hash}.json`.

| Field | Type | Description |
|-------|------|-------------|
| `prefix` | `string` | Same 3-character geohash prefix as the filename. |
| `outlets` | `RawOutletRecord[]` | All outlets in this cell, sorted by `stationId` for deterministic hashing. |

### Consumption pattern

1. Fetch `dataset/index.json` — read `shards[]` to know which cells exist.
2. Parallel-fetch the shards whose `prefix` intersects your area of interest
   (bounding box / city / current location — decode each `prefix` back to a
   lat/lng box with any geohash library).
3. Merge the returned `RawOutletRecord[]` arrays in memory and apply your own
   classification / search / map rendering.

A client that loads all shards at once (~103,000 records, well under 50 MB
decompressed) is also fine for a national map — the shard structure is designed to
enable per-viewport streaming but does not require it.

---

## How it all connects

Put end to end: a scraper visits one outlet's page or API entry and produces
one `RawOutletRecord` (Step 1), whose `products[]` holds whatever prices
were actually legible (Step 2). That record gets written alongside a
`WorkLogRecord` noting the attempt succeeded (Step 4) — a record that on any
later run lets the scraper skip this outlet entirely until it's worth
re-checking. Once a brand's whole raw file exists, `stationId` (Step 3) is
what lets `build-dataset` collapse however many overlapping captures of the
same physical pump — from route/grid overlap, repeat queries, or ordinary
re-scraping over time — down to just the newest one. Every brand's deduped
records are then merged, grouped by rough geographic cell, and written out
as content-addressed shard files plus one manifest (Step 5) — which is the
form a map client, or anyone else, actually downloads.

Every step in that chain exists to solve one specific problem that showed up
when six very differently-shaped sources had to become one dataset: how to
describe an outlet without inventing data, how to tell "no price" from "no
product," how to recognize the same pump twice, how to know an attempt
actually worked, and how to hand the result to a consumer without making
them download more than they need.

---

## Worked examples

### HPCL outlet (live-scraped from `petrolpump.hpretail.in`)

```json
{
  "schemaVersion": 1,
  "brand": "HPCL",
  "outletId": "398563",
  "stationId": "a1f9c3d7e2b60481",
  "sourceUrl": "https://petrolpump.hpretail.in/hpcl-deepak-mittal-service-provider-petrol-pump-kathgodam-haldwani-398563/Home",
  "capturedAt": "2026-07-20T03:14:42.123Z",
  "name": "Deepak Mittal Service Provider",
  "address": "NH 24, Haldwani Road, Kathgodam, Haldwani, Uttarakhand",
  "city": "Haldwani",
  "state": "Uttarakhand",
  "pincode": "263139",
  "lat": 29.2205,
  "lng": 79.5186,
  "geohash": "ttn0q70",
  "hours": "Mon-Sat 06:00-23:00, Sun 08:00-17:00",
  "contact": "05946-123456",
  "mapsLink": "https://maps.google.com/?q=29.2205,79.5186",
  "products": [
    { "name": "Petrol", "priceInr": 105.42 },
    { "name": "Diesel", "priceInr": 94.52 },
    { "name": "Power 100", "priceInr": 198.25 }
  ]
}
```

### IOCL outlet (`locator.iocl.com`, same "singleinterface.com" platform as HPCL)

Shown as diff from HPCL — only the fields that differ:

```
brand: "IOCL"
outletId: "183933"
stationId: "5e8b21f4a97c0d36"
sourceUrl: "https://locator.iocl.com/indianoil-patel-petroleums-petrol-pump-lulla-nagar-pune-183933/Home"
name: "Patel Petroleums"
products: [
  { "name": "Petrol", "priceInr": 105.42 },
  { "name": "Diesel", "priceInr": 94.52 },
  { "name": "XP100", "priceInr": 198.25 },
  { "name": "XP95", "priceInr": 118.50 },
  { "name": "XtraGreen Diesel", "priceInr": 100.10 }
]
```

### BPCL outlet (`api.cep.bpcl.in`)

Shown as diff from HPCL — only the fields that differ. Note `sourceUrl` is a real,
fetchable API URL, not `null` — BPCL just has no public per-outlet *web page*.

```
brand: "BPCL"
outletId: "RO-123456"
stationId: "c47d902ea1b3f658"
sourceUrl: "https://api.cep.bpcl.in/retail/v2/bpcl/retail/rolocator/details?roId=RO-123456"
name: "Bharat Petroleum Pump"
address: "Some formatted address string"
city: "Mumbai"
state: "Maharashtra"
lat: 19.076, lng: 72.8777, geohash: "te7j5p0"
hours: null, mapsLink: null
contact: "9820012345"
products: [
  { "name": "Petrol", "priceInr": 105.42 },
  { "name": "Speed 100 BS IV", "priceInr": 198.25 }
]
```

### JioBP outlet (`netmanager.ril.com`, no per-outlet page — `sourceUrl` is the shared API endpoint)

Shown as diff from HPCL — only the fields that differ:

```
brand: "JioBP"
outletId: "MHC117"
stationId: "9b60e1d84f3a7c25"
sourceUrl: "https://netmanager.ril.com:4005/CustomerMobility"
name: "PALM BEACH"
address: "PLOT NO 7, SECTOR 18, OFF PALM BEACH MARG, BESIDES FULL STOP MALL, Sanpada, Navi Mumbai, Maharashtra 400706"
city: null
state: "Maharashtra"
lat: 19.05508168, lng: 73.00673056, geohash: "te7hz1r"
hours: null, mapsLink: null
contact: "9930505541"
products: [
  { "name": "Petrol", "priceInr": 111.28 },
  { "name": "Diesel", "priceInr": 97.90 },
  { "name": "CNG", "priceInr": 86.00 }
]
```

Notes specific to JioBP:
- `state` comes from a separate `FetchROMaster` index call (the per-outlet `FindFuelStation` response doesn't include it) — the provider looks it up from the batch's own discovery payload (`stateByCode`), not a network call in `process()`.
- Each product's `priceInr` is the entry with the latest `PriceDate` in a dated price-history array, not necessarily the first array entry — see [jiobp-api.md](./jiobp-api.md) for the full parsing rule.
- `city` is always `null` — JioBP's `Address` field is a single free-text string, not broken into breadcrumb components like HPCL/IOCL.

### Nayara outlet (nayaraenergy.com `POST /get-code-ro-radius`)

Shown as diff from HPCL — only the fields that differ:

```
brand: "Nayara"
outletId: "45839TA839"
stationId: "0d7f8a3b6e91c452"
sourceUrl: "https://www.nayaraenergy.com/get-code-ro-radius" (shared API endpoint, not a per-outlet page)
name: "Nayara Petrol Pump"
address: "Some address string"
city: null
state: null
pincode: null
lat: 19.076, lng: 72.8777, geohash: "te7j5p0"
hours: null, contact: null, mapsLink: null
products: [
  { "name": "PETROL", "priceInr": 105.42 },
  { "name": "DIESEL", "priceInr": 94.52 }
]
```

Notes specific to Nayara:
- `city`, `state`, `pincode`, `hours`, `contact`, `mapsLink` are always `null` — Nayara's `/get-code-ro-radius` response doesn't provide any of these.
- Products are exactly `PETROL` and/or `DIESEL` as flat top-level keys in the source's response, captured with the source's own casing; a station may report only one.

### Shell outlet (`shellretaillocator.geoapp.me`, third-party white-labelled locator)

Shown as diff from HPCL — only the fields that differ. Note **every product's
`priceInr` is `null`** — Shell's India locator reports no per-outlet prices at all.

```
brand: "Shell"
outletId: "12345"
stationId: "3f6c1e9b40a8d275"
sourceUrl: "https://shellretaillocator.geoapp.me/api/v2/locations/12345" (or the outlet's own website_url, if published)
name: "Shell Select Andheri"
address: "Some address string"
city: "Mumbai"
state: "Maharashtra"
pincode: "400058"
lat: 19.119, lng: 72.846, geohash: "te7mvk2"
hours: "Open 24 hours"
contact: "+912212345678"
mapsLink: null
products: [
  { "name": "V-Power", "priceInr": null },
  { "name": "FuelSave Petrol", "priceInr": null }
]
```

Notes specific to Shell:
- `mapsLink` is always `null` — the API doesn't publish one; `sourceUrl` (or the outlet's own `website_url`) is the closest equivalent.
- Discovery finds this outlet via a recursive bounding-box walk (`within_bounds`, subdividing on `clusters`), then `process()` makes one `GET /api/v2/locations/{id}` call per outlet id — see [shell-api.md](./shell-api.md).

### WorkLogRecord (success)

```json
{
  "workUnitId": "https://locator.iocl.com/indianoil-patel-petroleums-petrol-pump-lulla-nagar-pune-183933/Home",
  "status": "ok",
  "recordCount": 1,
  "fetchedAt": "2026-07-20T03:14:42.123Z"
}
```

### WorkLogRecord (failed)

```json
{
  "workUnitId": "d0:23.25990:77.41260:75000",
  "status": "httpFailed",
  "recordCount": 0,
  "detail": "HTTP 403",
  "fetchedAt": "2026-07-20T05:30:00.789Z"
}
```
