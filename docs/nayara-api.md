# Nayara Energy locator — reverse-engineered reference

How `nayaraenergy.com`'s public "Petrol Pump Near Me" locator
(`/petrol-pump-near-me`) fetches outlet data. Captured via Chrome DevTools MCP
(live page inspection + network capture) and a standalone Node POC script
(`fetch`, no browser) to verify the findings end-to-end from a cold start.

> **Status:** working contract, verified end-to-end on 2026-07-25. Coverage
> claim (one large-radius call ≈ the full national dataset) confirmed by a
> code-verified 8-way deduped union, not just eyeballed counts — see
> "Discovery: one call is (almost) the whole census" below.

---

## Site architecture

Unlike Jio-bp (a stateless JSON-RPC-style API), this is a traditional
server-rendered **Laravel** app — the locator widget is jQuery + AJAX calling
Laravel POST routes, not a dedicated API service. Three modes on the locator
page, each its own endpoint (URLs are Laravel `route()` output, rendered into
hidden `<input>` fields on the page — not hardcoded in the JS):

| Mode | Endpoint | Body params |
|---|---|---|
| Near You (radius) | `POST /get-code-ro-radius` | `curr_lat`, `curr_long`, `radius` (km) |
| By Code | `POST /get-code-ro` | `ro_code` |
| On Route | `POST /get-ro` | `radius` (client hardcodes `1`), `route_coordinates` (array built from a Google Directions polyline computed client-side), `curr_lat`, `curr_long` |

Two more hidden-input URLs exist but weren't explored: `/current-fuel-price`,
`/search` (site-wide search autocomplete), `/ro-pumps`.

**`/get-ro` (route search) response shape was not verified** — its request
shape requires a Google Directions polyline (`route_coordinates`) computed
client-side, which wasn't reproduced in the POC. Given the radius endpoint
alone appears to return the full national dataset (see below), route search
is unlikely to be needed for a census and is not a discovery-blocking gap.

---

## Auth model: session + CSRF (unlike every other brand in this repo)

This is the one genuinely new pattern relative to HPCL/IOCL/BPCL/Jio-bp. A
bare POST to any of the above endpoints returns `419 {"message":"CSRF token
mismatch."}`. A working request needs, from ONE prior `GET` (e.g. the locator
page itself):

1. **Session cookies** — `laravel_session` + `XSRF-TOKEN`, from `Set-Cookie`
   on the GET response.
2. **CSRF token** — from `<meta name="csrf-token" content="...">` in the
   GET's HTML, sent back as the `x-csrf-token` request header on every POST.

Both must be replayed together on every subsequent POST in the same
"session." Session lifetime (Laravel default is commonly ~120 min) was not
tested — a real provider should treat this like BPCL's OAuth token (refresh
on expiry / 419, not once at startup) rather than a one-time `init()`.

---

## Blocker: Akamai WAF blocks non-browser requests (header-based, not IP-based)

This repo's normal, honestly self-identifying crawler `User-Agent`
(`IndiaFuelPumpsBot/0.1 ...`, used by every other provider in this repo — see
`src/http.ts`) gets an immediate **403 "Unauthorized Activity Detected"**
Akamai block page on the very first cold `GET` — before any rate limiting or
CSRF handling even comes into play.

**Confirmed to be header/UA-shape detection, not TLS or IP fingerprinting:**
the same machine, same Node `fetch` (undici) TLS stack, same residential-ish
IP — swapping in a full Chrome-like header set (UA + `Accept` +
`Accept-Language` + `sec-ch-ua` + `sec-ch-ua-mobile` + `sec-ch-ua-platform`)
gets a clean `200`. No further hardening (device fingerprinting, JS
challenge, TLS JA3/JA4) was observed beyond header inspection.

**Decision (explicit, made 2026-07-25):** this repo will use a Chrome-mimicking
`User-Agent` + header set for the Nayara provider, rather than the honest
`IndiaFuelPumpsBot` identity every other brand uses. Rationale (project
owner's call): this project consolidates already-public data for public
benefit and doesn't compete with or divert traffic/revenue from Nayara's own
site, so presenting as a normal browser to get past a WAF that blocks
identified crawlers indiscriminately is considered fair here — a different
tradeoff than BPCL's residential-IP routing or Jio-bp's already-private-app
posture, but a deliberate one, not an oversight. Flag this decision
prominently wherever the Nayara provider is implemented (module doc comment,
same visibility as BPCL's Tailscale note in `CLAUDE.md`).

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
  **absent** on by-code lookup results (confirmed — `/get-code-ro` for a
  known `cms_code` returns the same object minus `distance`).
- **`efp`**: an unexplained `"YES"`/`"NO"` flag. Meaning not established (best
  guess: some Nayara-internal designation, possibly "Extended Fuel Pump" or
  similar) — per this repo's grade-agnostic policy, don't interpret it or map
  it into `RawOutletRecord`; if captured at all it should be raw/unlabeled,
  same as HPCL/IOCL/BPCL/Jio-bp never editorializing on price-card fields.
- **Products are FLAT keys, not an array** — every single record observed
  across ~9065 stations had exactly `PETROL` and `DIESEL` as top-level string
  keys. No CNG, no premium/branded grade names, no per-product array like
  every other brand's `products[]` source shape. A parser for this brand
  needs a fixed two-key extraction, not an array iteration.
- **No contact number, no hours, no pincode anywhere in this API** — the
  thinnest metadata of any brand in this repo. `address`/`address1` are the
  only location-adjacent text fields (full string vs. a short
  locality/village name).
- No unexpected/extra keys observed beyond `ro_name`, `cms_code`, `address`,
  `address1`, `latitude`, `longitude`, `efp`, `distance`, `PETROL`, `DIESEL`
  — checked programmatically across the full ~9065-record union, not just a
  handful of samples.

---

## Discovery: one call is (almost) the whole census

Radius genuinely filters at small values — `radius=1` km returns 0 results
near arbitrary points; growing it (`5,10,20,30,40,50,60,80,100`) produces
`0,0,1,1,1,3,3,5,12,24` results from one test center. But well before the UI
dropdown's max (25km), the true behavior diverges sharply from a real
geographic filter: at `radius=500`+ from a central-India point, the response
approaches the **entire national dataset**, and it stays roughly flat from
there — `radius=500 → 1391`, `radius=1000 → 7061`, `radius=3000 → ~9066`,
`radius=10000 → ~9075` (same order of magnitude, not 3x more coverage for a
3x bigger radius). One observed record even carried `"distance": 1138` in a
`radius=3000` response — descriptive, not enforced.

**Verified, not assumed:** ran the full flow (cold session bootstrap → CSRF
extraction → `radius=3000` query) from **8 widely-separated center points**
(central Madhya Pradesh, Delhi, Kanyakumari, Srinagar, Guwahati, Kolkata,
Mumbai, Porbandar), deduplicated the results by `cms_code` in code (not by
eyeballing counts), and got a stable **9065 unique stations** — the exact
same number whether merging 2 centers or all 8. Every individual center
returned 9065 or 9066 raw records on its own.

**Practical implication:** unlike BPCL's route-mesh + adaptive-grid discovery
or Jio-bp's batched-index-then-detail two-call shape, Nayara's whole national
census can likely be captured with **one or two** `/get-code-ro-radius` calls
at a large radius (e.g. `radius=3000` from a central point, optionally a
second call from a different center as a cheap safety margin against edge
gaps) — no grid, no batching, no pagination needed.

**Caveat — number will drift, don't hardcode it:** an earlier exploratory
session (interactive Chrome MCP, same day but a different capture) recorded
9074–9075 unique stations at similar radii; this POC's scripted run recorded
9065. A ~10-station difference across sessions is more likely real-world
roster churn (stations opening/closing) than a methodology bug, but it's a
signal that the total is not a fixed constant to assert against in tests —
treat ~9000-9100 as the expected order of magnitude, not an exact target.

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
- **One known bad-coordinate outlier** from an earlier exploration (not
  reproduced/quantified in the final POC run): a `radius=10000` query
  returned a record with `distance ≈ 6988 km` from its query center —
  physically impossible within India's ~3000km extent, implying at least one
  station in Nayara's own database has a corrupted lat/lng. A real parser
  should not hard-fail on this; either keep it as-reported (consistent with
  this repo's "capture exactly as the source reports it" policy) or flag
  suspicious coordinates for a follow-up look — a decision to make explicitly
  when building the provider, not silently drop.

---

## Mapping to `RawOutletRecord` (grade-agnostic, sketch — not yet implemented)

| RawOutletRecord | Source |
|---|---|
| `brand` | `"Nayara"` (already in the `Brand` union, `src/types.ts`) |
| `outletId` | `cms_code` |
| `stationId` | `makeStationId("Nayara", cms_code, lat, lng)` |
| `name` | `ro_name` |
| `address` | `address` (full string) |
| `city` | `address1`? — needs a decision; it reads more like a village/locality name than a city, unlike HPCL/IOCL's breadcrumb-derived `city`. Possibly leave `city: null` and let `address1` inform `address` only. |
| `state` | Not present anywhere in this API — would have to be parsed out of the free-text `address` string (raw, unreconciled per this repo's policy), or left `null`. |
| `lat` / `lng` | `Number(latitude)` / `Number(longitude)` |
| `geohash` | `geohashEncode(lat, lng, 7)` |
| `contact` | always `null` — not in this API |
| `hours` | always `null` — not in this API |
| `pincode` | always `null` — not in this API |
| `mapsLink` | always `null` — not in this API |
| `products[]` | exactly two fixed entries: `{ name: "PETROL", priceInr: Number(PETROL) }`, `{ name: "DIESEL", priceInr: Number(DIESEL) }` — omit an entry if its key is absent (2 known cases for PETROL), never fabricate a `0`/`null` placeholder for a genuinely-missing key. |
| `sourceUrl` | the `/get-code-ro-radius` endpoint URL, or `null` — same open question Jio-bp had; resolved there as "set to the endpoint for traceability," likely the same call here. |

Open design question not yet resolved: `state` has no source field at all
here (every other brand has at least a raw state string). Worth a decision
before implementation — parse from `address`'s trailing state name (fragile,
free text) vs. leaving it `null` nationally.

---

## Repro (how this was captured)

1. Chrome DevTools MCP: navigated to `nayaraenergy.com` → `/petrol-pump-near-me`,
   used the page's own "Near You" search UI once to find the underlying AJAX
   call in Network, then used `evaluate_script` to call `fetch()` directly
   from the page's own JS context (reusing its live session/CSRF) to probe
   response shape and radius behavior quickly.
2. Found the other two endpoint URLs (`/get-ro`, `/get-code-ro`) by fetching
   and grepping `js/map.js` for its jQuery `$.ajax` calls, then reading the
   hidden `<input>` elements those calls source their URLs from
   (`$('.find-ro-url').val()` etc. — Laravel `route()` helper output, not
   hardcoded in JS).
3. Standalone Node POC (`fetch`, no browser, no cookies pre-seeded) to prove
   the flow works cold, exactly as a real scraper would run it: `GET` the
   locator page fresh → extract CSRF token (regex on the meta tag) +
   `Set-Cookie` → `POST /get-code-ro-radius` from 8 center points with
   `radius=3000`, deduping by `cms_code` in code and persisting incrementally
   to disk (`nayara-union.json`) so a mid-run failure couldn't lose earlier
   results.
4. First POC attempt used this repo's honest `IndiaFuelPumpsBot` UA and hit
   the Akamai 403 immediately; second attempt swapped in a Chrome-mimicking
   header set and succeeded end-to-end.
