# Jio-bp (RBML) Mobility API — reverse-engineered reference

How the **MyJio-bp** Android app (`com.jiobp.myjio_bp`, a Flutter app) fetches the
national fuel-station list, per-station live prices, and amenities. Captured by
running the app in an emulator with SSL-pinning disabled (reFlutter) and an
mitmproxy reverse-proxy on `netmanager.ril.com`.

> **Status:** working contract, verified end-to-end on 2026-07-24. Prices returned
> matched the app UI exactly (Palm Beach: Petrol 111.28, Diesel 97.90 Rs/l, CNG
> 86.00 Rs/kg). **Auth is not validated** — both operations return full real data
> with a fully synthetic `MobileNumber` + `TokenNumber` + `IMEINo` (confirmed by
> replaying against the live server with random values). No login/OTP required.

---

## Endpoint

Everything runs through **one** JSON endpoint. The *operation* is selected by the
**shape of the JSON body**, not the URL path (JSON-RPC style).

```
POST https://netmanager.ril.com:4005/CustomerMobility
```

- Host is publicly reachable (resolves to `116.50.97.246`), no datacenter-IP block
  observed (unlike BPCL).
- **No `Authorization` header, no API key, no bearer.** Config was shipped in
  cleartext in the APK (`assets/flutter_assets/.env.prod`).

### Request headers (all that the app sends)

```
user-agent: Dart/3.10 (dart:io)
content-type: application/json
accept-encoding: gzip
```

Responses are gzipped JSON.

### Identity / auth model

Identity is carried **inside the body**, not in headers:

| Field          | Example                                  | Notes |
|----------------|------------------------------------------|-------|
| `MobileNumber` | `9028833886`                             | The logged-in mobile number. |
| `TokenNumber`  | `9a5848e6-8d58-7177-3da6-fb46fa8f7f4c`   | Session UUID minted at login. Rotates per response. |
| `IMEINo`       | `AE3A.240806.043`                        | Device build id (any stable string). |

**The values are not validated.** Replaying both operations against the live
server with a random 10-digit `MobileNumber`, a random UUID `TokenNumber`, and a
garbage `IMEINo` returned full, correct data (`ResponseFlag: S`) — MHC117 prices
matched the app; a Kerala station returned its own real prices. The fields must be
*present and well-formed* (a fully anonymous `GetROCNGQueueTime` with no mobile
returns `"Please provide mobile number"`), but **no login, OTP, or valid session
is needed**. `init()` can just use constants; `TokenNumber` can be any fresh UUID.

---

## Operation 1 — `FetchROMaster` (national station index)

Returns **every** Jio-bp station in one call (2294 on capture), with just code +
coordinates + state. This is the discovery/index call.

### Request

```json
{
  "CustomerRequest": {
    "ROMaster": {
      "IMEINo": "AE3A.240806.043",
      "MobileNumber": "9028833886",
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
- `FuelStationCode` is the stable outlet id (the app's "Mobility Station Code",
  e.g. `MHC117`). First two letters ≈ state (`MH`, `KL`, `UT`…); 3rd letter looks
  like a type marker (`F`/`C`/`T`).
- Field is misspelled **`Lattitude`** (two t's). `Longitude` is normal.
- No prices or names here — that's Operation 2.

---

## Operation 2 — `FindFuelStation` (details + prices + amenities)

Takes a **batch** of station codes, returns full detail for each. The app sends
the nearby codes it got from the index; batch size is flexible (18 observed).

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
> `SearchFlag":"R"` and `State":""` were the non-obvious ones. The values
> themselves are not validated (random mobile/token/IMEI work).

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

Product master list (from `GetCAMasterData`, port 4009):
`["Petrol", "Diesel", "Auto LPG", "EV", "CNG"]`. `ProductName` is captured
verbatim, so any grade string a station reports (e.g. an E12/E20/E100 variant)
would appear here as-is — no separate grade field. (Palm Beach reports only
Petrol/Diesel/CNG; grade variants would surface at whichever outlets carry them.)

---

## Mapping to `RawOutletRecord` (grade-agnostic)

| RawOutletRecord      | Source |
|----------------------|--------|
| `brand`              | `"JioBP"` (already in the `Brand` union) |
| `outletId`           | `FuelStationCode` (e.g. `MHC117`) |
| `stationId`          | `makeStationId("JioBP", FuelStationCode, lat, lng)` |
| `name`               | `FuelStationName` |
| `address`            | `Address` |
| `state`              | `State` (from index) / parse from `Address` |
| `city`, `pincode`    | parse from `Address` (raw, unreconciled) |
| `lat` / `lng`        | `Lattitude` / `Longitude` (note the typo) |
| `geohash`            | `geohashEncode(lat, lng, 7)` |
| `contact`            | `ContactNumber` |
| `products[]`         | one `{ name: ProductName, priceInr }` per `HistoryFuelProducts` entry, `priceInr` = latest `ProductPrice` trimmed→number (or `null` if missing/unparseable) |
| `sourceUrl`          | `null` (or the endpoint URL) |
| `capturedAt`         | now |

Amenities (`GetROAmenities`) have no home in `RawOutletRecord` and are **out of
scope** for this repo — drop them.

### Provider shape (fits `src/provider.ts` cleanly)

- **`discover()`** → one `FetchROMaster` call → yield `WorkUnit`s, each a **batch**
  of N `FuelStationCode`s (tune N; 18 works, larger likely fine). Batching means
  the whole census is ~`2294 / N` requests — trivial vs HPCL/IOCL/BPCL.
- **`process(unit)`** → one `FindFuelStation` call with that batch → N
  `RawOutletRecord`s.
- **`init(ctx)`** → mint/refresh the `MobileNumber`+`TokenNumber` (see below).
- Concurrency: works with the existing worker pool; be conservative (this is a
  private app backend, not a public locator).

---

## Open questions before building a census

1. ~~**Auth token.**~~ **Resolved.** No login/OTP/valid session required — synthetic
   `MobileNumber` + `TokenNumber` + `IMEINo` return full real data. `init()` uses
   constants; `TokenNumber` = any fresh UUID.
2. **Ethics / authorization.** This is a **private customer-app backend**, not the
   public store-locator. The *data* (public station locations + publicly-posted
   fuel prices) is not sensitive, but scraping it at national scale is a different
   posture than the HPCL/IOCL/BPCL public-locator scrapes. Worth a conscious call
   + a note in the README, similar to the BPCL residential-IP caveat.
3. **Rate/volume.** Batched, the census is only ~dozens of requests — keep it
   gentle and cache/resume as usual. Confirm the max batch size for
   `FindFuelStation` (18 observed in-app; larger untested).
4. **Price history vs. current.** `PriceDetails` is a dated history; some products'
   latest entry can be weeks old (Diesel/CNG at MHC117 dated May). Take the max by
   `PriceDate` and capture that date if a freshness signal is ever wanted.

## How this was captured (repro)

1. `apkeep` → XAPK; merged splits with `APKEditor` → universal APK.
2. `reFlutter` patched the APK to disable Flutter's bundled-CA cert validation.
3. arm64 emulator (`google_apis`, `adb root`); logged in; opened **Near By**.
4. reFlutter's proxy-inject didn't take (app uses a networking path that ignores
   the Dart proxy), so instead: `iptables -t nat` DNAT of `116.50.97.246:4005/4009`
   → `10.0.2.2`, with **mitmproxy in reverse mode** (`--ssl-insecure`) terminating
   TLS (accepted because reFlutter disabled verification) and forwarding upstream.
5. Decoded the flow files with mitmproxy's `FlowReader`.
