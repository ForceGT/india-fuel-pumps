/**
 * BPCL parser — api.cep.bpcl.in, the same backend BPCL's own "BharatGas"
 * consumer app uses for its fuel-station locator (reverse-engineered via
 * static disassembly of the app's public bundle — no bypassing of any
 * cert-pinning/anti-tamper check, both of which only matter for intercepting
 * the app's OWN traffic, not for calling the same public API ourselves).
 *
 * Auth: `/authorizationserver/oauth/token`, OAuth2 client-credentials grant
 * with the app's own baked-in service-account creds (shipped in every
 * install, not anything user-specific or secret).
 *
 * Data shape difference from HPCL/IOCL (both scraped-page + a separate
 * price-fragment fetch): BPCL's locator response already carries live
 * per-outlet fuel prices in `weekDayFuelPriceList` on the SAME payload as
 * the outlet metadata — one call gives us both.
 *
 * No grade opinion anywhere in this module — every product+price the
 * payload reports is captured, exactly as reported (including the raw
 * "SPEED 100 BS IV"-style emission-norm suffix); classifying any of them is
 * a downstream consumer's job, not this repo's.
 */
import { geohashEncode } from "../geo.js";
import { makeStationId } from "../id.js";
import type { OutletMetadata } from "../lib/raw-record.js";

export const BPCL_API_HOST = "https://api.cep.bpcl.in";

const TOKEN_PATH = "/authorizationserver/oauth/token";
const RO_LOCATORS_PATH = "/retail/v2/bpcl/retail/rolocators";
const RO_DETAILS_PATH = "/retail/v2/bpcl/retail/rolocator/details";
const RO_ROUTE_PATH = "/retail/v2/bpcl/retail/rolocator/route";

/** The app's own baked-in client-credentials — same values in every install, not anything obtained privately or unique to us. */
const TOKEN_CLIENT_ID = "hybris2";
const TOKEN_CLIENT_SECRET = "nimda";

export interface BpclTokenRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** Pure builder for the token request. Doesn't fetch. */
export function buildTokenRequest(): BpclTokenRequest {
  const body = new URLSearchParams({
    client_id: TOKEN_CLIENT_ID,
    client_secret: TOKEN_CLIENT_SECRET,
    grant_type: "client_credentials",
  }).toString();
  return {
    url: `${BPCL_API_HOST}${TOKEN_PATH}`,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  };
}

/** Pure parse of the token endpoint's JSON body. Returns null on any unexpected shape — never guesses a token. */
export function parseAccessToken(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const token = (json as Record<string, unknown>).access_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

export interface BpclLocatorParams {
  latitude: number;
  longitude: number;
  radius?: number;
  currentPage?: number;
  pageSize?: number;
}

/** Pure builder for the RO locator search URL. Doesn't fetch. */
export function buildLocatorUrl(params: BpclLocatorParams): string {
  const { latitude, longitude, radius = 20000, currentPage = 0, pageSize = 100 } = params;
  const qs = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    radius: String(radius),
    currentPage: String(currentPage),
    pageSize: String(pageSize),
    sort: "asc",
  });
  return `${BPCL_API_HOST}${RO_LOCATORS_PATH}?${qs.toString()}`;
}

/** Build the per-outlet details URL (roId) — used as an outlet's sourceUrl. */
export function buildDetailsUrl(roId: string): string {
  return `${BPCL_API_HOST}${RO_DETAILS_PATH}?${new URLSearchParams({ roId }).toString()}`;
}

export interface BpclRouteStep {
  lat: number;
  lng: number;
}

export interface BpclRouteParams {
  sourceLat: number;
  sourceLng: number;
  destLat: number;
  destLng: number;
  /** Points describing the path to search along. */
  steps: BpclRouteStep[];
  radius?: number;
  pageSize?: number;
}

export interface BpclRouteRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * Pure builder for the "outlets along a route" search (`rolocator/route`).
 * Doesn't fetch. The server does real per-step geospatial work, not a
 * simple point-to-point search — very sparse `steps` spanning a huge
 * distance can 504; keep consecutive steps roughly `radius`-to-`1.5x radius`
 * apart and keep each call's total span bounded (the caller's job, not
 * this pure builder's).
 */
export function buildRouteRequest(params: BpclRouteParams): BpclRouteRequest {
  const { sourceLat, sourceLng, destLat, destLng, steps, radius = 25000, pageSize = 20 } = params;
  const body = JSON.stringify({
    accuracy: 0,
    currentPage: 0,
    pageSize,
    radius,
    slatitude: sourceLat,
    slongitude: sourceLng,
    tlatitude: destLat,
    tlongitude: destLng,
    sort: "asc",
    steps: steps.map((s) => ({ lat: s.lat, lng: s.lng })),
  });
  return {
    url: `${BPCL_API_HOST}${RO_ROUTE_PATH}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };
}

/** Raw per-outlet shape from the `rolocators`/`rolocator/route` response — only the fields we use; the live API returns more. */
export interface BpclFuelPrice {
  code?: string;
  displayName?: string;
  price?: number;
}

export interface BpclPointOfService {
  roId?: string;
  name?: string;
  displayName?: string;
  telephone?: string;
  geoPoint?: { latitude?: number; longitude?: number };
  address?: {
    formattedAddress?: string;
    town?: string;
    postalCode?: string;
    region?: { name?: string };
  };
  weekDayFuelPriceList?: BpclFuelPrice[];
}

export interface BpclLocatorResponse {
  pointOfServices?: BpclPointOfService[];
  status?: string;
  statusCode?: number;
}

/** Pure parse of the locator endpoint's JSON body. Never throws; a malformed/missing shape yields []. */
export function parseLocatorResponseJson(json: unknown): BpclPointOfService[] {
  if (typeof json !== "object" || json === null) return [];
  const list = (json as Record<string, unknown>).pointOfServices;
  return Array.isArray(list) ? (list as BpclPointOfService[]) : [];
}

/**
 * Both `rolocators` and `rolocator/route` return HTTP 404 with this exact
 * error shape when a query genuinely finds zero results — not a request
 * failure. A national grid crawl hits this constantly (ocean, mountains,
 * foreign territory, sparse rural areas) and must distinguish it from a
 * real failure.
 */
export function isNoDataFoundResponse(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  const errors = (json as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => typeof e === "object" && e !== null && (e as Record<string, unknown>).type === "NoDataFoundError");
}

/** BPCL's `address.town` (and similar fields) come back ALL CAPS (e.g. "BANGALORE") — title-case for display. Purely a display-cleanup of the source's own field, not a reconciliation against any external list. */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse one BPCL `pointOfServices` entry into outlet metadata, or null if
 * it's missing what we need to trust it (no roId, or no usable
 * coordinates). Pure: no fetch, no fs, never throws.
 *
 * `city` is the RAW `address.town` field (title-cased for display only),
 * unreconciled against any external city list. `products` is NOT built
 * here — a caller reconstructs it straight from `weekDayFuelPriceList`
 * (every product+price, exactly as reported, no positivity filter — that's
 * a downstream classification concern, not this raw capture's).
 */
export async function parseOutletMetadata(raw: BpclPointOfService, capturedAt: string): Promise<OutletMetadata | null> {
  const roId = raw.roId?.trim();
  const lat = raw.geoPoint?.latitude;
  const lng = raw.geoPoint?.longitude;
  if (!roId || typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const outletName = raw.displayName?.trim() || raw.name?.trim() || "BPCL Outlet";
  const address = raw.address ?? {};
  const rawTown = address.town?.trim();
  const city = rawTown ? titleCase(rawTown) : null;

  const stationId = await makeStationId({ brand: "BPCL", outletId: roId, lat, lng });

  return {
    brand: "BPCL",
    outletId: roId,
    stationId,
    sourceUrl: buildDetailsUrl(roId),
    capturedAt,
    name: outletName,
    address: address.formattedAddress?.trim() || null,
    city,
    state: address.region?.name?.trim() || null,
    pincode: address.postalCode?.trim() || null,
    lat,
    lng,
    geohash: geohashEncode(lat, lng, 7),
    hours: null, // not present in this payload (unlike HPCL/IOCL's JSON-LD openingHoursSpecification)
    contact: raw.telephone?.trim() || null,
    mapsLink: null, // no field in this payload
  };
}
