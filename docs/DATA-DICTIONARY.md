# Data Dictionary

## RawOutletRecord

A single fuel outlet as captured from the source. One JSON object per line in `output/{brand}-raw.jsonl`. Defined in `src/types.ts`.

| Field | Type | Nullable | Description | Example |
|-------|------|----------|-------------|---------|
| `schemaVersion` | `number` | No | Schema version (currently `1`). Incremented on breaking changes. | `1` |
| `brand` | `string` | No | OMC brand — one of `"HPCL"`,`"IOCL"`,`"BPCL"`,`"JioBP"`,`"Nayara"`,`"Shell"` | `"HPCL"` |
| `outletId` | `string` | No | The source's own internal ID for this outlet. HPCL/IOCL: the trailing digits of the outlet's `/Home` URL. BPCL: `roId`. JioBP: `FuelStationCode` (e.g. `"MHC117"`). Nayara: `cms_code`. Shell: the `geoapp.me` location id. | `"398563"` |
| `stationId` | `string` | No | Stable dedup key — the first 16 hex characters of `SHA-1("{brand}:{outletId}:{lat}:{lng}")` (`makeStationId` in `src/id.ts`). NOT a human-readable composite string. Unique across brands (brand is part of the hash input). | `"a1f9c3d7e2b60481"` |
| `sourceUrl` | `string` | Yes | Canonical source reference. HPCL/IOCL: the outlet's own `/Home` page. BPCL: the same details API endpoint the outlet's data came from (`GET /retail/v2/bpcl/retail/rolocator/details?roId=...`) — **not** `null`; there's no separate public web page, but the API URL is still a real, fetchable reference. JioBP/Nayara: the shared API endpoint constant (not per-outlet — there's no per-outlet page or id-addressable URL). Shell: the outlet's own `website_url` if the source published one, else the `GET /api/v2/locations/{id}` detail endpoint. | `"https://petrolpump.hpretail.in/hpcl-deepak-mittal-service-provider-petrol-pump-kathgodam-haldwani-398563/Home"` |
| `capturedAt` | `string` | No | ISO-8601 timestamp of when our crawler retrieved this data from the source. | `"2026-07-20T03:14:42.123Z"` |
| `name` | `string` | No | Outlet name from the source's live page/response (not from any static roster). Live name always wins over a static list. | `"Deepak Mittal Service Provider"` |
| `address` | `string` | Yes | Full street address. `null` if the source didn't provide one. | `"NH 24, Haldwani Road, Kathgodam, Haldwani, Uttarakhand"` |
| `city` | `string` | Yes | Raw breadcrumb/town/field the source reports, **not reconciled** against any canonical city list. Always `null` for JioBP (its `Address` is one free-text field, not broken into components) and Nayara (not provided by the API). Populated for HPCL, IOCL, BPCL (`address.town`, title-cased for display only), and Shell. | `"Haldwani"` |
| `state` | `string` | Yes | Raw state name as the source reports it, not reconciled. Always `null` for Nayara (not provided). JioBP gets this from a separate index lookup (see JioBP notes below), not the per-outlet response itself. | `"Uttarakhand"` |
| `pincode` | `string` | Yes | PIN code as published. `null` if not provided (always `null` for JioBP and Nayara). | `"263139"` |
| `lat` | `number` | No | Latitude in decimal degrees (WGS84). | `29.2205` |
| `lng` | `number` | No | Longitude in decimal degrees (WGS84). | `79.5186` |
| `geohash` | `string` | No | Geohash of `lat`/`lng` at precision 7 (~150 m cell), via `geohashEncode` in `src/geo.ts`. Used for sharding at precision 3. | `"ttn0q70"` |
| `hours` | `string` | Yes | Opening hours as free text, parsed from the source's own structured field where one exists (HPCL/IOCL's JSON-LD `openingHoursSpecification`; Shell's location detail). Always `null` for BPCL (not present in its payload), JioBP, and Nayara (neither's API publishes it). | `"Mon-Sat 06:00-22:00, Sun 08:00-20:00"` |
| `contact` | `string` | Yes | Phone number as published, `tel:` prefix stripped. Always `null` for Nayara (its API doesn't publish it). Can be populated for HPCL, IOCL, BPCL, JioBP, and Shell — whichever the source actually reports. | `"05946-123456"` |
| `mapsLink` | `string` | Yes | Google Maps directions URL, only when the source itself publishes one (HPCL/IOCL's JSON-LD `hasMap`). Always `null` for BPCL, JioBP, Nayara, and Shell — none of their APIs publish a maps link. | `"https://maps.google.com/?q=29.2205,79.5186"` |
| `products` | `RawProduct[]` | No | Every fuel product+price the source reported at this outlet. Empty array if the source reported no products (rare but possible). | See below |

---

## RawProduct

One observed fuel product/price. Part of `RawOutletRecord.products[]`.

| Field | Type | Nullable | Description | Example |
|-------|------|----------|-------------|---------|
| `name` | `string` | No | Product name exactly as the source wrote it. No cleanup, no casing fixes, no BS-suffix stripping. | `"XP100"`, `"Speed 100"`, `"Power 100"`, `"Diesel"`, `"XP95"` |
| `priceInr` | `number` | Yes | Price per litre in Indian Rupees. `null` if a product card/entry was present but the price was missing, non-positive, or unparseable — never fabricated. **Always `null` for every Shell product** — Shell's India locator doesn't publish per-outlet prices at all through this API (see [shell-api.md](./shell-api.md)); the product name is still captured. | `167.35`, `null` |

---

## WorkLogRecord

Per-unit crawl bookkeeping. One JSON per line in `output/{slug}-worklog.jsonl`. Separate from `RawOutletRecord` — describes whether the crawl *attempt* succeeded, not what the data is. Defined in `src/types.ts`.

| Field | Type | Nullable | Description | Example |
|-------|------|----------|-------------|---------|
| `workUnitId` | `string` | No | The `WorkUnit.id` this record is for — see the per-brand shapes below. | `"https://petrolpump.hpretail.in/hpcl-.../398563/Home"` |
| `status` | `string` | No | One of `"ok"`, `"empty"`, `"httpFailed"`, `"parsedNull"`, `"errored"`. Only `ok`/`empty` are treated as "done" on resume. Any other status is always retried. | `"ok"` |
| `recordCount` | `number` | No | Number of `RawOutletRecord`s this work unit produced. `0` for `empty`, `httpFailed`, etc. | `1` |
| `saturated` | `boolean` | Yes | BPCL only. `true` when a grid cell hit the saturation threshold (≥100 results) and was subdivided. Absent for other brands. | `true` |
| `detail` | `string` | Yes | Human-readable detail about the result — the error reason for failures. | `"HTTP 403"` |
| `fetchedAt` | `string` | No | ISO-8601 timestamp of when the work unit was processed. Used for staleness checks on resume. | `"2026-07-20T03:14:42.123Z"` |

`workUnitId` shape per brand:

| Brand | Shape | Example |
|---|---|---|
| HPCL / IOCL | The outlet's `/Home` page URL (1 unit = 1 outlet) | `"https://locator.iocl.com/indianoil-patel-petroleums-petrol-pump-lulla-nagar-pune-183933/Home"` |
| BPCL (route) | `"{cityA}->{cityB}#{chunkIndex}"` | `"Delhi->Jaipur#0"` |
| BPCL (grid cell) | `"d{depth}:{lat.toFixed(5)}:{lng.toFixed(5)}:{radiusMeters}"` | `"d0:23.25990:77.41260:75000"` |
| JioBP | `"batch-{12-hex-char SHA-1 of the sorted station codes}"` — one unit = a batch of ~18 stations | `"batch-8f2a91c3d4e5"` |
| Nayara | `"center-bhopal"` or `"center-kolkata"` — one of exactly two fixed center points | `"center-bhopal"` |
| Shell | The outlet's `geoapp.me` location id (1 unit = 1 outlet) | `"12345"` |

### Status semantics

| Status | Meaning | Resume behavior |
|--------|---------|-----------------|
| `ok` | Unit processed successfully, produced ≥1 record | **Marked done** — skipped on resume |
| `empty` | Unit processed successfully, produced 0 records (e.g. BPCL's "NoDataFoundError" over open ocean) | **Marked done** — skipped on resume |
| `httpFailed` | HTTP request completed but returned a non-OK status (403, 404, 500, etc.) | **Always retried** |
| `parsedNull` | HTTP OK, but the response body couldn't be parsed into an outlet (HTML/JSON shape changed, or — for JioBP/Nayara — a response that came back structurally empty when it shouldn't have) | **Always retried** |
| `errored` | An unhandled exception occurred during processing (connection failure, missing required field, etc.) | **Always retried** |

---

## Dataset index.json

The manifest file at `dataset/index.json`, written by `src/build-dataset.ts`.

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `number` | Currently `1`. |
| `generatedAt` | `string` | ISO-8601 timestamp of when the dataset was built. |
| `totalOutlets` | `number` | Total unique outlets across all brands. One outlet can only appear once (deduped by `stationId`). |
| `brands` | `Record<string, number>` | Per-brand outlet counts. Keys are brand slugs (`"hpcl"`, `"iocl"`, `"bpcl"`, `"jiobp"`, `"nayara"`, `"shell"`). A brand whose raw JSONL was missing/empty this run is omitted entirely (not set to `0`) — see `missingBrands` in `dataset/release-stats.json`. |
| `shards` | `ShardEntry[]` | Array of shard descriptors (see below). |

### ShardEntry

| Field | Type | Description |
|-------|------|-------------|
| `prefix` | `string` | 3-character geohash prefix for this cell (~156 km). |
| `file` | `string` | Relative path to the shard file: `"shards/<prefix>.<hash>.json"`. |
| `count` | `number` | Number of outlets in this shard. |

---

## Shard file

Each file at `dataset/shards/{prefix}.{hash}.json`.

| Field | Type | Description |
|-------|------|-------------|
| `prefix` | `string` | Same 3-character geohash prefix as the filename. |
| `outlets` | `RawOutletRecord[]` | All outlets in this cell, sorted by `stationId` for deterministic hashing. |

Each shard filename embeds a **content hash** (first 16 hex of SHA-256), so a shard
file is **immutable** — an unchanged cell keeps the same URL across updates and stays
cached; only cells whose data actually changed get a new filename and re-download. If
every cell is unchanged, a new `index.json` references the same shard files and the
CDN cache is untouched.

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

## Example records

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
