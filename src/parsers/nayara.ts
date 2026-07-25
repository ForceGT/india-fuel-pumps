/**
 * Nayara Energy locator parser — pure request-builders + response parser,
 * no fetch/fs. See docs/nayara-api.md for the full reverse-engineered
 * reference this is built from.
 *
 * DELIBERATE DECISION (see docs/nayara-api.md's "Blocker: Akamai WAF blocks
 * non-browser requests" section, made 2026-07-25): this brand's requests use
 * a Chrome-mimicking User-Agent + header set instead of this repo's honest
 * IndiaFuelPumpsBot identity every other brand uses. Nayara's Akamai WAF
 * blocks this repo's normal crawler UA on the very first request (header
 * shape alone, not IP/TLS fingerprinting — confirmed in docs/nayara-api.md).
 * The project owner made a conscious call that presenting as a normal
 * browser to consolidate already-public data for public benefit is a fair
 * tradeoff here — a different posture than BPCL's residential-IP routing or
 * Jio-bp's already-private-app posture, but a deliberate one, not an
 * oversight. Flag this decision prominently wherever this module is read.
 *
 * Auth model (unlike every other brand): session cookies + a CSRF token
 * minted from ONE prior GET of the locator page, replayed together on every
 * POST (see docs/nayara-api.md's "Auth model" section). There is no
 * long-lived API key.
 *
 * No grade opinion anywhere in this module — PETROL/DIESEL are captured
 * verbatim as two fixed product keys (the source's only two products,
 * flat top-level keys, not an array); classifying them is a downstream
 * consumer's job, not this repo's.
 */

export const NAYARA_BASE_URL = "https://www.nayaraenergy.com";
export const NAYARA_LOCATOR_PAGE_URL = `${NAYARA_BASE_URL}/petrol-pump-near-me`;
export const NAYARA_RADIUS_ENDPOINT = `${NAYARA_BASE_URL}/get-code-ro-radius`;

/** Number(null)/Number("")/Number("  ") all coerce to 0, which would silently accept a missing coordinate as (0,0) — this only accepts a real number or a non-blank numeric-looking string. */
function toCoord(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
  return NaN;
}

/** Chrome-mimicking header set — see module doc comment above for why this (not the honest IndiaFuelPumpsBot UA) is used for this brand only. */
export const NAYARA_CHROME_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

export interface NayaraSession {
  /** Full `Cookie` header value, e.g. "laravel_session=...; XSRF-TOKEN=...". */
  cookieHeader: string;
  /** From `<meta name="csrf-token" content="...">`, replayed as the `x-csrf-token` header on every POST. */
  csrfToken: string;
}

export interface NayaraRequestSpec {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

/** GET the locator page — the one prior request needed to mint a session (cookies + the CSRF meta tag). */
export function buildSessionBootstrapRequest(): NayaraRequestSpec {
  return {
    url: NAYARA_LOCATOR_PAGE_URL,
    method: "GET",
    headers: { ...NAYARA_CHROME_HEADERS },
  };
}

/**
 * Extract the CSRF token (from the `<meta name="csrf-token">` tag) and the
 * session cookies (from `Set-Cookie`) out of the bootstrap GET's response.
 * Returns null if either piece is missing — a caller should treat that as a
 * failed session bootstrap, not proceed with a doomed POST. Never throws.
 */
export function extractSession(html: string, setCookieHeaders: string[]): NayaraSession | null {
  const csrfMatch = /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i.exec(html);
  const csrfToken = csrfMatch?.[1];
  if (!csrfToken) return null;

  const cookiePairs: string[] = [];
  for (const raw of setCookieHeaders) {
    const pair = raw.split(";")[0]?.trim();
    if (pair) cookiePairs.push(pair);
  }
  if (cookiePairs.length === 0) return null;

  return { cookieHeader: cookiePairs.join("; "), csrfToken };
}

/**
 * POST /get-code-ro-radius — a single call at a large radius returns (almost)
 * the entire national dataset (see docs/nayara-api.md's "Discovery: one call
 * is (almost) the whole census" section) — no grid, no batching, no
 * pagination needed. Requires a live session (cookies + csrf token) from
 * `extractSession`.
 */
export function buildRadiusRequest(
  session: NayaraSession,
  latDeg: number,
  lngDeg: number,
  radiusKm: number,
): NayaraRequestSpec {
  const body = new URLSearchParams({
    curr_lat: String(latDeg),
    curr_long: String(lngDeg),
    radius: String(radiusKm),
  }).toString();
  return {
    url: NAYARA_RADIUS_ENDPOINT,
    method: "POST",
    headers: {
      ...NAYARA_CHROME_HEADERS,
      "content-type": "application/x-www-form-urlencoded",
      "x-csrf-token": session.csrfToken,
      "x-requested-with": "XMLHttpRequest",
      cookie: session.cookieHeader,
    },
    body,
  };
}

export interface NayaraProduct {
  name: string;
  priceInr: number | null;
}

export interface NayaraStation {
  cmsCode: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  /** Exactly the products whose keys were present in the source (PETROL/DIESEL) — never fabricated for an absent key. */
  products: NayaraProduct[];
}

/**
 * Parse a `/get-code-ro-radius` (or `/get-code-ro`) response into station
 * records. Never throws. Skips entries missing `cms_code` or with
 * non-finite `latitude`/`longitude`. `PETROL`/`DIESEL` are FLAT top-level
 * string keys, not an array (see docs/nayara-api.md) — extracted as two
 * fixed keys; a product is omitted entirely (not fabricated as 0/null) if
 * its key is absent from the record. `efp` and `distance` are deliberately
 * NOT surfaced here — `efp`'s meaning is unestablished and `distance` is
 * query-relative, neither belongs in a grade-agnostic, query-independent
 * `RawOutletRecord`.
 */
export function parseRadiusResponse(json: unknown): NayaraStation[] {
  if (!Array.isArray(json)) return [];

  const results: NayaraStation[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;

    const cmsCode = rec.cms_code;
    if (typeof cmsCode !== "string" || !cmsCode.trim()) continue;

    const lat = toCoord(rec.latitude);
    const lng = toCoord(rec.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const rawName = rec.ro_name;
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : cmsCode;

    const rawAddress = rec.address;
    const address = typeof rawAddress === "string" && rawAddress.trim() ? rawAddress.trim() : null;

    const products: NayaraProduct[] = [];
    for (const key of ["PETROL", "DIESEL"] as const) {
      if (!(key in rec)) continue;
      const rawPrice = rec[key];
      const price =
        typeof rawPrice === "string" || typeof rawPrice === "number" ? Number(rawPrice) : NaN;
      products.push({ name: key, priceInr: Number.isFinite(price) && price > 0 ? price : null });
    }

    results.push({ cmsCode, name, address, lat, lng, products });
  }
  return results;
}
