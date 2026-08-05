# Nayara Energy locator — API reference

How `nayaraenergy.com`'s public "Petrol Pump Near Me" locator
(`/petrol-pump-near-me`) fetches outlet data — the same calls the page's own
search UI makes, documented here for a scraper to call directly.

> **Status:** working contract, verified end-to-end on 2026-07-25. The
> coverage claim (one large-radius call ≈ the full national dataset) is
> confirmed by a deduped union across multiple center points, not just
> eyeballed counts — see "Discovery: one call is (almost) the whole census"
> below.

---

## Site architecture

Unlike Jio-bp (a stateless JSON-RPC-style API), this is a traditional
server-rendered **Laravel** app — the locator widget is jQuery + AJAX calling
Laravel POST routes, not a dedicated API service. Three modes on the locator
page, each its own endpoint:

| Mode | Endpoint | Body params |
|---|---|---|
| Near You (radius) | `POST /get-code-ro-radius` | `curr_lat`, `curr_long`, `radius` (km) |
| By Code | `POST /get-code-ro` | `ro_code` |
| On Route | `POST /get-ro` | `radius` (client hardcodes `1`), `route_coordinates` (array built from a Google Directions polyline computed client-side), `curr_lat`, `curr_long` |

Two more endpoints exist on the page but aren't used by this provider:
`/current-fuel-price`, `/search` (site-wide search autocomplete), `/ro-pumps`.

`/get-ro` (route search) isn't used either — its request needs a Google
Directions polyline computed client-side, and the radius endpoint alone
already returns the full national dataset (see below), so route search adds
nothing for a census.

---

## Auth model: session + CSRF (unlike every other brand in this repo)

This is the one genuinely different pattern relative to HPCL/IOCL/BPCL/Jio-bp.
A bare POST to any of the above endpoints returns `419
{"message":"CSRF token mismatch."}`. A working request needs, from ONE prior
`GET` (e.g. the locator page itself):

1. **Session cookies** — `laravel_session` + `XSRF-TOKEN`, from `Set-Cookie`
   on the GET response.
2. **CSRF token** — from `<meta name="csrf-token" content="...">` in the
   GET's HTML, sent back as the `x-csrf-token` request header on every POST.

Both must be replayed together on every subsequent POST in the same
"session." This repo's provider treats session expiry like BPCL's OAuth token
— refresh on a 419, not just once at startup — since exact session lifetime
isn't guaranteed.

---

## Note: this endpoint expects browser-shaped requests

A request using this repo's normal, honestly self-identifying crawler
`User-Agent` (`IndiaFuelPumpsBot/0.1 ...`, used by every other provider —
see `src/http.ts`) gets an immediate **403 "Unauthorized Activity Detected"**
block page from Nayara's WAF, before CSRF handling even comes into play.
Sending a standard browser header set (UA + `Accept` + `Accept-Language` +
`sec-ch-ua` + `sec-ch-ua-mobile` + `sec-ch-ua-platform`) resolves it — the
block is header-shape based, not IP-based.

**Decision:** this repo's Nayara provider sends a Chrome-mimicking header set
rather than the honest `IndiaFuelPumpsBot` identity every other brand uses.
Rationale: this project consolidates already-public data for public benefit
and doesn't compete with or divert traffic from Nayara's own site, so
presenting standard browser headers to reach a public endpoint is the
project owner's considered call here — flagged in the provider's own module
doc comment for visibility.

---

## Response shape — `/get-code-ro-radius` and `/get-code-ro`

```json
{
  "ro_name": "Auto Pushp",
  "cms_code": "45839TA839",
  "address": "Survey no.56, (P), CTS no.686, Village - Nahore, Bhandup, Taluka-Kurla, Mumbai, Maharashtra",
  "address1": "Bhandup",
  "latitude": "19.162741",
  "longitude": "72.941087999999993",
  "efp": "NO",
  "distance": 11.720905582510369,
  "PETROL": "122.7",
  "DIESEL": "106.03"
}
```

Notes:
- `cms_code` is the stable outlet ID (e.g. `45839TA839`). No typo in
  `latitude`/`longitude` (unlike Jio-bp's `Lattitude`) — both are strings,
  parse with `Number(...)`.
- `distance` (km from the query point) is present on radius-search results,
  absent on by-code lookup results.
- **`efp`**: an unexplained `"YES"`/`"NO"` flag. Meaning not established —
  per this repo's grade-agnostic policy, it's not interpreted or mapped into
  `RawOutletRecord` at all.
- **Products are FLAT keys, not an array** — every record observed across
  ~9065 stations had exactly `PETROL` and `DIESEL` as top-level string keys.
  No CNG, no premium/branded grade names, no per-product array like every
  other brand's `products[]` source shape. A parser for this brand needs a
  fixed two-key extraction, not an array iteration.
- **No contact number, no hours, no pincode anywhere in this API** — the
  thinnest metadata of any brand in this repo. `address`/`address1` are the
  only location-adjacent text fields (full string vs. a short
  locality/village name).
- No unexpected/extra keys observed beyond `ro_name`, `cms_code`, `address`,
  `address1`, `latitude`, `longitude`, `efp`, `distance`, `PETROL`, `DIESEL`
  across the full ~9065-record union.

---

## Discovery: one call is (almost) the whole census

Radius genuinely filters at small values — `radius=1` km returns 0 results
near arbitrary points; growing it (`5,10,20,30,40,50,60,80,100`) produces
`0,0,1,1,1,3,3,5,12,24` results from one test center. But well before the UI
dropdown's max (25km), the behavior diverges sharply from a real geographic
filter: at `radius=500`+ from a central-India point, the response approaches
the **entire national dataset**, and stays roughly flat from there —
`radius=500 → 1391`, `radius=1000 → 7061`, `radius=3000 → ~9066`,
`radius=10000 → ~9075` (same order of magnitude, not 3x more coverage for a
3x bigger radius).

Querying `radius=3000` from 8 widely-separated center points (central Madhya
Pradesh, Delhi, Kanyakumari, Srinagar, Guwahati, Kolkata, Mumbai, Porbandar)
and deduplicating by `cms_code` gives a stable **9065 unique stations** — the
same number whether merging 2 centers or all 8. Every individual center
returns 9065 or 9066 raw records on its own.

**Practical implication:** unlike BPCL's route-mesh + adaptive-grid discovery
or Jio-bp's batched-index-then-detail two-call shape, Nayara's whole national
census is captured with **two** `/get-code-ro-radius` calls at a large
radius (`radius=3000` from a central point, plus a second call from a
different center as a cheap safety margin against edge gaps) — no grid, no
batching, no pagination needed. This is exactly what
`src/providers/nayara-provider.ts` does.

**The total will drift — don't hardcode it.** Different capture sessions
have recorded anywhere from ~9065 to ~9075 unique stations at the same
radius. A ~10-station difference is more likely real-world roster churn
(stations opening/closing) than a bug — treat ~9000-9100 as the expected
order of magnitude, not an exact target to assert against.

---

## Data quality (over the 9065-record deduped union)

```
missingCode:     0      missingCoords: 0      missingName: 0
missingPetrol:   2      missingDiesel: 0
petrolOnly:      0      dieselOnly:    2      both: 9063   neither: 0
extraKeysSeen:   []
```

- Every record has a valid `cms_code`, finite `latitude`/`longitude`, and a
  non-empty `ro_name`.
- Only 2 of 9065 stations are missing `PETROL` (both have `DIESEL` — likely
  genuine diesel-only outlets, not a parsing gap). None are missing both.
- **One known bad-coordinate outlier:** a `radius=10000` query returned a
  record with `distance ≈ 6988 km` from its query center — physically
  impossible within India's ~3000km extent, implying at least one station in
  Nayara's own database has a corrupted lat/lng. The parser doesn't hard-fail
  on this — it keeps the record as-reported, consistent with this repo's
  "capture exactly as the source reports it" policy, rather than silently
  dropping it.

---

## Mapping to `RawOutletRecord` (grade-agnostic — as actually implemented)

`src/providers/nayara-provider.ts` is built and shipping in the daily census.
Where a field has no reliable source in this API, it's left `null`
nationally rather than parsed out of free text with a real risk of getting
it wrong.

| RawOutletRecord | Source |
|---|---|
| `brand` | `"Nayara"` (already in the `Brand` union, `src/types.ts`) |
| `outletId` | `cms_code` |
| `stationId` | `makeStationId("Nayara", cms_code, lat, lng)` |
| `name` | `ro_name` |
| `address` | `address` (full string) |
| `city` | **always `null`.** `address1` reads more like a village/locality name than a city, unlike HPCL/IOCL's breadcrumb-derived `city` — rather than guess, the implementation leaves it unset and keeps the full text in `address` only. |
| `state` | **always `null`.** Not present anywhere in this API; parsing it out of the free-text `address` string was considered and rejected as too fragile/unreconciled to trust — see [METHODOLOGY.md](./METHODOLOGY.md) on why this repo doesn't guess at fields the source didn't structure. Nayara is the one brand in this dataset with no `state` at all. |
| `lat` / `lng` | `Number(latitude)` / `Number(longitude)` |
| `geohash` | `geohashEncode(lat, lng, 7)` |
| `contact` | always `null` — not in this API |
| `hours` | always `null` — not in this API |
| `pincode` | always `null` — not in this API |
| `mapsLink` | always `null` — not in this API |
| `products[]` | exactly two possible entries: `{ name: "PETROL", priceInr: Number(PETROL) }`, `{ name: "DIESEL", priceInr: Number(DIESEL) }` — an entry is omitted if its key is absent from the response (the 2 known petrol-missing cases), never fabricated as `0`/`null`. |
| `sourceUrl` | the shared `/get-code-ro-radius` endpoint constant (`NAYARA_RADIUS_ENDPOINT`) — **not** `null`; same convention as Jio-bp, since there's no per-outlet page. |
