# Data Dictionary

## RawOutletRecord

A single fuel outlet as captured from the source. One JSON object per line in `output/{brand}-raw.jsonl`.

| Field | Type | Nullable | Description | Example |
|-------|------|----------|-------------|---------|
| `schemaVersion` | `number` | No | Schema version (currently `1`). Incremented on breaking changes. | `1` |
| `brand` | `string` | No | OMC brand — one of `"HPCL"`,`"IOCL"`,`"BPCL"`,`"JioBP"`,`"Nayara"`,`"Shell"` | `"HPCL"` |
| `outletId` | `string` | No | The source's own internal ID for this outlet. HPCL/IOCL use `outletId`; BPCL uses `roId`; JioBP uses its `FuelStationCode` (e.g. `"MHC117"`); Nayara uses its `cms_code` (e.g. `"45839TA839"`). | `"398563"` |
| `stationId` | `string` | No | Stable dedup key: `makeStationId(brand, outletId, lat, lng)`. Unique across brands. | `"hpcl_398563_28.612_77.227"` |
| `sourceUrl` | `string` | Yes | Canonical source page URL. `null` for BPCL (app API, no public web page). JioBP has no per-outlet page either, but sets `sourceUrl` to the API endpoint (`https://netmanager.ril.com:4005/CustomerMobility`) rather than `null`, for traceability. | `"https://petrolpump.hpretail.in/Home/398563"` |
| `capturedAt` | `string` | No | ISO-8601 timestamp of when our crawler retrieved this data from the source. | `"2026-07-20T03:14:42.123Z"` |
| `name` | `string` | No | Outlet name from the source's live page (not from a static roster). Live name always wins over static lists. Max ~200 chars. | `"Deepak Mittal Service Provider"` |
| `address` | `string` | Yes | Full street address. `null` if the source didn't provide one. | `"NH 24, Haldwani Road, Kathgodam, Haldwani, Uttarakhand"` |
| `city` | `string` | Yes | Raw breadcrumb or town name as the source reports it. **Not reconciled** against any canonical city list. Consumers should do their own normalization. | `"Haldwani"` |
| `state` | `string` | Yes | Raw state name as the source reports it. Not reconciled. | `"Uttarakhand"` |
| `pincode` | `string` | Yes | 6-digit PIN code. `null` if not published. | `"263139"` |
| `lat` | `number` | No | Latitude in decimal degrees (WGS84). | `29.2205` |
| `lng` | `number` | No | Longitude in decimal degrees (WGS84). Should always match `geohash`. | `79.5186` |
| `geohash` | `string` | No | Geohash (precision 7, ~150 m cell). Encoding of `lat`/`lng`. Used for sharding at precision 3. | `"ttn0q70"` |
| `hours` | `string` | Yes | Opening hours as free text. HPCL/IOCL: specific times. BPCL, JioBP, Nayara: null (source doesn't report it). | `"Mon-Sat 06:00-22:00, Sun 08:00-20:00"` |
| `contact` | `string` | Yes | Phone number as published. Strips leading `tel:` prefixes. `null` if not published. BPCL, JioBP, Nayara: always null. | `"05946-123456"` |
| `mapsLink` | `string` | Yes | Google Maps directions URL if published by the source. `null` otherwise. | `"https://maps.google.com/?q=29.2205,79.5186"` |
| `products` | `RawProduct[]` | No | Every fuel product+price the source reported at this outlet. See RawProduct below. Empty array if the source reported no products (rare but possible). | See below |

---

## RawProduct

One observed fuel product/price. Part of `RawOutletRecord.products[]`.

| Field | Type | Nullable | Description | Example |
|-------|------|----------|-------------|---------|
| `name` | `string` | No | Product name exactly as the source wrote it. No cleanup, no casing fixes, no BS-suffix stripping. | `"XP100"`, `"Speed 100"`, `"Power 100"`, `"Diesel"`, `"XP95"` |
| `priceInr` | `number` | Yes | Price per litre in Indian Rupees. `null` if a product card/entry was present but the price was missing, `0.00`, or unparseable. Never fabricated. | `167.35`, `null` |

---

## WorkLogRecord

Per-unit crawl bookkeeping. One JSON per line in `output/{slug}-worklog.jsonl`. Separate from `RawOutletRecord` — describes whether the crawl *attempt* succeeded, not what the data is.

| Field | Type | Nullable | Description | Example |
|-------|------|----------|-------------|---------|
| `workUnitId` | `string` | No | Resumability key. For HPCL/IOCL: the outlet's `sourceUrl`. For BPCL: `routeChunkId` or `cellId` (never collide across the two work kinds). For JioBP: `"batch-{n}"`, a batch of ~18 station codes (JioBP's unit of work is a batch, not a single outlet — one `"ok"` record can produce multiple `RawOutletRecord`s). | `"https://petrolpump.hpretail.in/Home/398563"` |
| `status` | `string` | No | One of `"ok"`, `"empty"`, `"httpFailed"`, `"parsedNull"`, `"errored"`. Only `ok`/`empty` are treated as "done" on resume. Any other status is always retried. | `"ok"` |
| `recordCount` | `number` | No | Number of `RawOutletRecord`s this work unit produced. 0 for `empty`, `httpFailed`, etc. | `1` |
| `saturated` | `boolean` | Yes | BPCL only. `true` when a grid cell hit the saturation threshold and was subdivided. Absent for other brands. | `true` |
| `detail` | `string` | Yes | Human-readable detail about the result. For errors: the reason. For BPCL grid division: the sub-cell count. | `"HTTP 403 (site blocked datacenter IP)"` |
| `fetchedAt` | `string` | No | ISO-8601 timestamp of when the work unit was processed. Used for staleness checks on resume. | `"2026-07-20T03:14:42.123Z"` |

### Status semantics

| Status | Meaning | Resume behavior |
|--------|---------|-----------------|
| `ok` | Unit processed successfully, produced >= 1 record | **Marked done** — skipped on resume |
| `empty` | Unit processed successfully, produced 0 records (e.g. BPCL "NoDataFoundError" over ocean) | **Marked done** — skipped on resume |
| `httpFailed` | HTTP request completed but returned a non-OK status (403, 404, 500, etc.) | **Always retried** |
| `parsedNull` | HTTP OK, but the response body couldn't be parsed into an outlet (HTML changed, unexpected JSON structure) | **Always retried** |
| `errored` | An unhandled exception occurred during processing | **Always retried** |

---

## Dataset index.json

The manifest file at `dataset/index.json`.

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `number` | Currently `1`. |
| `generatedAt` | `string` | ISO-8601 timestamp of when the dataset was built. |
| `totalOutlets` | `number` | Total unique outlets across all brands. One outlet can only appear once (deduped by `stationId`). |
| `brands` | `Record<string, number>` | Per-brand outlet counts. Keys are brand slugs (`"hpcl"`, `"iocl"`, `"bpcl"`, `"jiobp"`, `"nayara"`). Missing brands are omitted (not set to 0). |
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
  "stationId": "hpcl_398563_29.2205_79.5186",
  "sourceUrl": "https://petrolpump.hpretail.in/Home/398563",
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

### IOCL outlet (`locator.iocl.com`, same shape, more products)

Shown as diff from HPCL — only the fields that differ:

```
brand: "IOCL"
outletId: "183140"
stationId: "iocl_183140_28.612_77.227"
sourceUrl: "https://locator.iocl.com/Home/183140"
name: "COCO IT PARK NEHA HALDWANI SERVICE"
products: [
  { "name": "Petrol", "priceInr": 105.42 },
  { "name": "Diesel", "priceInr": 94.52 },
  { "name": "XP100", "priceInr": 198.25 },
  { "name": "XP95", "priceInr": 118.50 },
  { "name": "XtraGreen", "priceInr": 100.10 }
]
```

### BPCL outlet (`api.cep.bpcl.in`, no sourceUrl)

```
brand: "BPCL"
outletId: "RO-123456"
stationId: "bpcl_RO-123456_19.076_72.8777"
sourceUrl: null
name: "Bharat Petroleum Pump"
lat: 19.076, lng: 72.8777, geohash: "te7j5p0"
hours: null, mapsLink: null
products: [
  { "name": "Petrol", "priceInr": 105.42 },
  { "name": "Speed 100", "priceInr": 198.25 }
]
```

### JioBP outlet (`netmanager.ril.com`, no per-outlet page — `sourceUrl` is the API endpoint)

Shown as diff from HPCL — only the fields that differ:

```
brand: "JioBP"
outletId: "MHC117"
stationId: "jiobp_MHC117_19.05508168_73.00673056"
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
- `state` comes from the separate `FetchROMaster` index call (the per-outlet `FindFuelStation` response doesn't include it) — the provider looks it up by `outletId` from the batch's discovery payload.
- Each product's `priceInr` is the entry with the latest `PriceDate` in a dated price-history array, not necessarily the first array entry — see `docs/jiobp-api.md` for the full parsing rule.
- `city` is always `null` — JioBP's `Address` field is a single free-text string, not broken into breadcrumb components like HPCL/IOCL.

### Nayara outlet (nayaraenergy.com `POST /get-code-ro-radius`)

Shown as diff from HPCL — only the fields that differ:

```
brand: "Nayara"
outletId: "123456"
stationId: "nayara_123456_19.076_72.8777"
sourceUrl: "https://www.nayaraenergy.com/get-code-ro-radius" (API endpoint, not per-outlet page)
name: "Nayara Petrol Pump"
address: "Some address string"
city: null
state: null
pincode: null
lat: 19.076, lng: 72.8777, geohash: "te7j5p0"
hours: null, contact: null, mapsLink: null
products: [
  { "name": "Petrol", "priceInr": 105.42 },
  { "name": "Diesel", "priceInr": 94.52 }
]
```

Notes specific to Nayara:
- `city`, `state`, `pincode` are always `null` — Nayara's API doesn't provide these fields.
- `hours` and `contact` are always `null` — Nayara's API doesn't publish these.
- Products are exactly `PETROL` and/or `DIESEL` as flat top-level keys in the source API; the parser converts them to the standard `products[]` array. A station may have only one product (omitting the key entirely if unavailable).

### WorkLogRecord (success)

```json
{
  "workUnitId": "https://petrolpump.hpretail.in/Home/398563",
  "status": "ok",
  "recordCount": 1,
  "fetchedAt": "2026-07-20T03:14:42.123Z"
}
```

### WorkLogRecord (failed)

```json
{
  "workUnitId": "grid_te7_4",
  "status": "httpFailed",
  "recordCount": 0,
  "detail": "HTTP 403 (site blocked datacenter IP)",
  "fetchedAt": "2026-07-20T05:30:00.789Z"
}
```
