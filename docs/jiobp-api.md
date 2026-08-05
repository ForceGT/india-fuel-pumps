# Jio-bp (RBML) Mobility API — reference

How the same backend the **MyJio-bp** Android app uses fetches the national
fuel-station list, per-station live prices, and amenities. This is a publicly
reachable API — the app was simply the easiest way to identify and reproduce
the exact request/response shapes; the endpoint itself requires no login and
is not gated to app traffic specifically.

> **Status:** working contract, verified end-to-end on 2026-07-24. Prices
> returned matched the app UI exactly (Palm Beach: Petrol 111.28, Diesel
> 97.90 Rs/l, CNG 86.00 Rs/kg). **Identity fields are not validated** — both
> operations return full real data with synthetic `MobileNumber` +
> `TokenNumber` + `IMEINo` values. No login/OTP required.

---

## Endpoint

Everything runs through **one** JSON endpoint. The *operation* is selected by
the **shape of the JSON body**, not the URL path (JSON-RPC style).

```
POST https://netmanager.ril.com:4005/CustomerMobility
```

- Publicly reachable, no datacenter-IP block observed (unlike BPCL).
- **No `Authorization` header, no API key, no bearer token required.**

### Request headers

```
user-agent: Dart/3.10 (dart:io)
content-type: application/json
accept-encoding: gzip
```

Responses are gzipped JSON.

### Identity fields

Identity is carried **inside the body**, not in headers:

| Field          | Example                                  | Notes |
|----------------|------------------------------------------|-------|
| `MobileNumber` | `9000000000`                             | Any well-formed 10-digit number. |
| `TokenNumber`  | `9a5848e6-8d58-7177-3da6-fb46fa8f7f4c`   | A UUID. Rotates per response. |
| `IMEINo`       | `AE3A.240806.043`                        | Any stable string. |

**These values are not validated by the server.** A random 10-digit
`MobileNumber`, a random UUID `TokenNumber`, and an arbitrary `IMEINo` all
return full, correct data (`ResponseFlag: S`). The fields must be *present
and well-formed* (an empty `MobileNumber` returns `"Please provide mobile
number"`), but no login, OTP, or valid session is needed. A client can just
use constants for `MobileNumber`/`IMEINo`, and any fresh UUID for `TokenNumber`.

---

## Operation 1 — `FetchROMaster` (national station index)

Returns **every** Jio-bp station in one call (2294 at time of writing), with
just code + coordinates + state. This is the discovery/index call.

### Request

```json
{
  "CustomerRequest": {
    "ROMaster": {
      "IMEINo": "AE3A.240806.043",
      "MobileNumber": "9000000000",
      "TokenNumber": "9a5848e6-8d58-7177-3da6-fb46fa8f7f4c"
    }
  }
}
```

### Response (≈227 KB, truncated)

```json
{
  "CustomerResponse": {
    "MasterData": {
      "ResponseFlag": "S",
      "ResponseMsg": "Successful",
      "TokenNumber": "6fd73e38-ffb0-1818-a066-e830d49f23ff",
      "FetchROMaster": {
        "ROMasterData": [
          { "FuelStationCode": "UTF003", "Lattitude": "29.136124", "Longitude": "79.521523", "State": "Uttarakhand" },
          { "FuelStationCode": "UWF030", "Lattitude": "28.795584", "Longitude": "77.535108", "State": "Uttar Pradesh" },
          { "FuelStationCode": "KLF009", "Lattitude": "9.64721",   "Longitude": "76.54767",  "State": "Kerala" }
          // … 2294 total
        ]
      }
    }
  }
}
```

Notes:
- `FuelStationCode` is the stable outlet id (e.g. `MHC117`). First two letters
  ≈ state (`MH`, `KL`, `UT`…); 3rd letter looks like a type marker (`F`/`C`/`T`).
- Field is misspelled **`Lattitude`** (two t's). `Longitude` is normal.
- No prices or names here — that's Operation 2.

---

## Operation 2 — `FindFuelStation` (details + prices + amenities)

Takes a **batch** of station codes, returns full detail for each. Batch size
is flexible (18 used by this project's own scraper).

### Request

```json
{
  "CustomerRequest": {
    "FuelStation": {
      "FindFuelStation": {
        "FuelStations": [
          { "FuelStationCode": "MHC117" },
          { "FuelStationCode": "MHF175" },
          { "FuelStationCode": "MHT008" }
          // … batch as many as needed
        ],
        "IMEINo": "any-stable-string",
        "MobileNumber": "9812345678",
        "TokenNumber": "any-fresh-uuid",
        "SearchFlag": "R",
        "State": ""
      }
    }
  }
}
```

> **All five trailing fields are required.** Omitting `IMEINo` / `MobileNumber` /
> `TokenNumber` / `SearchFlag` / `State` — sending only the `FuelStations` array —
> returns `{"ResponseFlag":"E","ResponseMsg":"An error occurred while processing"}`.
> `SearchFlag":"R"` and `State":""` are required exact values. The identity
> field values themselves are not validated (random mobile/token/IMEI work).

### Response (one station, full object)

```json
{
  "CustomerResponse": {
    "FuelStation": {
      "FindFuelStation": {
        "ResponseFlag": "S",
        "ResponseMsg": "Successful",
        "TokenNumber": "94eb6e66-83e4-cd81-4c62-0a7e1b104b03",
        "FuelStations": [
          {
            "FuelStationCode": "MHC117",
            "FuelStationName": "PALM BEACH",
            "FavouriteFlag": "N",
            "ContactNumber": "9930505541",
            "Address": "PLOT NO 7, SECTOR 18, OFF PALM BEACH MARG, BESIDES FULL STOP MALL, Sanpada, Navi Mumbai, Maharashtra 400706",
            "Lattitude": "19.05508168",
            "Longitude": "73.00673056",
            "GetROAmenities": [
              { "FacilityCode": "2", "FacilityName": "Petrol" },
              { "FacilityCode": "3", "FacilityName": "Diesel" },
              { "FacilityCode": "5", "FacilityName": "ALPG" },
              { "FacilityCode": "8", "FacilityName": "Washroom" }
            ],
            "HistoryFuelProducts": [
              {
                "ProductName": "Petrol",
                "PriceDetails": [
                  {
                    "ProductPrice": "     111.28",
                    "PriceDate": "05-07-2026 06:00:00",
                    "LatestDate": "06:00 Sun,5th Jul 26",
                    "ProductUnit": "Rs/liter",
                    "CNGQueueTime": null,
                    "CNGQueueWaiteDateTime": null,
                    "OrderAllowed": null
                  }
                  // … older dated entries precede this
                ]
              }
              // … one entry per ProductName offered
            ]
          }
        ]
      }
    }
  }
}
```

### Reading prices

- `HistoryFuelProducts` is **one entry per product** (`ProductName`), each with a
  `PriceDetails` **history array**. The **current price is the entry with the
  latest `PriceDate`** (`dd-MM-yyyy HH:mm:ss`). Do not assume array order — sort by
  `PriceDate` and take the max.
- `ProductPrice` is a **space-padded string** (`"     111.28"`) — trim + parse to
  number.
- `ProductUnit` is `Rs/liter` (Petrol/Diesel/ALPG) or `Rs/kg` (CNG).

Latest prices decoded for `MHC117 / PALM BEACH` (matched the app UI exactly):

| ProductName | Price   | Unit     | PriceDate            |
|-------------|---------|----------|----------------------|
| Petrol      | 111.28  | Rs/liter | 05-07-2026 06:00:00  |
| Diesel      | 97.90   | Rs/liter | 25-05-2026 07:44:00  |
| CNG         | 86.00   | Rs/kg    | 30-05-2026 00:00:00  |

Product master list: `["Petrol", "Diesel", "Auto LPG", "EV", "CNG"]`.
`ProductName` is captured verbatim, so any grade string a station reports
(e.g. an E12/E20/E100 variant) would appear here as-is — no separate grade
field. (Palm Beach reports only Petrol/Diesel/CNG; grade variants would
surface at whichever outlets carry them.)

---

## Mapping to `RawOutletRecord` (grade-agnostic)

| RawOutletRecord      | Source |
|----------------------|--------|
| `brand`              | `"JioBP"` (already in the `Brand` union) |
| `outletId`           | `FuelStationCode` (e.g. `MHC117`) |
| `stationId`          | `makeStationId("JioBP", FuelStationCode, lat, lng)` |
| `name`               | `FuelStationName` |
| `address`            | `Address` |
| `state`              | `State`, looked up from the `FetchROMaster` index entry for this code (carried through `discover()`'s batch payload — never re-fetched or parsed from `Address`) |
| `city`, `pincode`    | **always `null`** — the implementation does not attempt to parse these out of the single free-text `Address` field |
| `lat` / `lng`        | `Lattitude` / `Longitude` (note the typo) |
| `geohash`            | `geohashEncode(lat, lng, 7)` |
| `contact`            | `ContactNumber` |
| `products[]`         | one `{ name: ProductName, priceInr }` per `HistoryFuelProducts` entry, `priceInr` = latest `ProductPrice` trimmed→number (or `null` if missing/unparseable) |
| `sourceUrl`          | the shared endpoint constant, `https://netmanager.ril.com:4005/CustomerMobility` — **not** `null`; there's no per-outlet page, so every JioBP record's `sourceUrl` is identical |
| `hours` / `mapsLink` | always `null` — neither operation's response carries them |
| `capturedAt`         | now |

Amenities (`GetROAmenities`) have no home in `RawOutletRecord` and are **out of
scope** for this repo — dropped.

### Provider shape (`src/providers/jiobp-provider.ts`, as actually built)

- **`discover()`** → one `FetchROMaster` call → yields `WorkUnit`s, each a **batch**
  of `batchSize` (default 18, `JIOBP_CENSUS_BATCH_SIZE`) `FuelStationCode`s, plus a
  `stateByCode` map built from that batch's own index entries (so `process()` never
  needs a second lookup for `state`). Batching means the whole census is
  `~2294 / batchSize` requests — trivial vs HPCL/IOCL/BPCL.
- **`process(unit)`** → one `FindFuelStation` call with that batch → up to
  `batchSize` `RawOutletRecord`s.
- **No `init()`.** Since neither `MobileNumber`/`TokenNumber`/`IMEINo` is actually
  validated by the server, there's no session or token to bootstrap —
  `TokenNumber` is just a fresh `crypto.randomUUID()` generated inline on
  every request, and `MobileNumber`/`IMEINo` are hardcoded constants. There's
  nothing for a one-time setup step to do.
- Concurrency defaults conservatively (2, via `JIOBP_CENSUS_CONCURRENCY`).

---

## Notes on the census

1. **Auth.** No login/OTP/valid session required — synthetic identity fields
   return full real data. No `init()` needed; `TokenNumber` is a fresh UUID
   per request.
2. **Rate/volume.** Batched at 18 codes/request (`JIOBP_CENSUS_BATCH_SIZE`),
   the whole national census is only ~128 requests — trivial vs HPCL/IOCL/BPCL,
   and finishes in minutes even at low concurrency.
3. **Price history vs. current.** `PriceDetails` is a dated history; some
   products' latest entry can be weeks old. `src/parsers/jiobp.ts`'s
   `latestProductPrice` takes the max by `PriceDate` — see
   [EDGE-CASES.md](./EDGE-CASES.md)'s Jio-bp entry for the full detail.
