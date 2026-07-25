/**
 * Shell India locator parser — pure request-builders + response parsers, no
 * fetch/fs. See docs/shell-api.md for the full reverse-engineered reference
 * this is built from.
 *
 * Unlike Nayara, this is a plain unauthenticated JSON REST API (a
 * white-labelled "geoapp.me" locator widget, not Shell's own
 * infrastructure) — no session, no CSRF, this repo's honest
 * IndiaFuelPumpsBot User-Agent works fine.
 *
 * No grade opinion anywhere in this module — `fuels` slugs (e.g.
 * "premium_gasoline", "shell_regular_diesel") are captured verbatim;
 * classifying them is a downstream consumer's job, not this repo's.
 * `priceInr` is always null here — `fuel_pricing.status` was "unavailable"
 * on every India outlet sampled (see docs/shell-api.md) — never fabricated.
 */

export const SHELL_BASE = "https://shellretaillocator.geoapp.me";
export const SHELL_WITHIN_BOUNDS_ENDPOINT = `${SHELL_BASE}/api/v2/locations/within_bounds`;
export const SHELL_LOCATION_ENDPOINT = `${SHELL_BASE}/api/v2/locations`;

export interface ShellBounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/** `sw`/`ne` repeated-key query params + the fuel_type filter the widget always sends (conventional + ev — this repo captures both categories, see docs/shell-api.md). */
export function buildWithinBoundsUrl(bounds: ShellBounds): string {
  const params = new URLSearchParams();
  params.append("sw[]", String(bounds.minLat));
  params.append("sw[]", String(bounds.minLng));
  params.append("ne[]", String(bounds.maxLat));
  params.append("ne[]", String(bounds.maxLng));
  params.append("with_any[fuel_type][]", "conventional");
  params.append("with_any[fuel_type][]", "ev");
  params.append("locale", "en_IN");
  params.append("format", "json");
  params.append("driving_distances", "false");
  return `${SHELL_WITHIN_BOUNDS_ENDPOINT}?${params.toString()}`;
}

export function buildLocationDetailUrl(id: string): string {
  return `${SHELL_LOCATION_ENDPOINT}/${encodeURIComponent(id)}`;
}

/** Number(null)/Number("")/Number("  ") all coerce to 0, which would silently accept a missing coordinate as (0,0) — this only accepts a real number or a non-blank numeric-looking string. */
function toCoord(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
  return NaN;
}

function toNonEmptyString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export interface ShellLocationStub {
  id: string;
  countryCode: string | null;
}

/**
 * `within_bounds` returns EITHER a `locations[]` array of individual outlet
 * stubs OR a `clusters[]` array of aggregated blobs (never both non-empty) —
 * `hasClusters: true` tells the caller to subdivide the bbox and recurse
 * rather than treat this as a resolved leaf. Never throws.
 */
export function parseWithinBoundsResponse(json: unknown): { stubs: ShellLocationStub[]; hasClusters: boolean } {
  if (typeof json !== "object" || json === null) return { stubs: [], hasClusters: false };
  const rec = json as Record<string, unknown>;
  const clusters = Array.isArray(rec.clusters) ? rec.clusters : [];
  const locations = Array.isArray(rec.locations) ? rec.locations : [];

  const stubs: ShellLocationStub[] = [];
  for (const item of locations) {
    if (typeof item !== "object" || item === null) continue;
    const loc = item as Record<string, unknown>;
    const id = loc.id;
    if (typeof id !== "string" && typeof id !== "number") continue;
    stubs.push({ id: String(id), countryCode: toNonEmptyString(loc.country_code) });
  }
  return { stubs, hasClusters: clusters.length > 0 };
}

export interface ShellProduct {
  name: string;
  priceInr: number | null;
}

export interface ShellStationDetail {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  telephone: string | null;
  countryCode: string | null;
  websiteUrl: string | null;
  hours: string | null;
  products: ShellProduct[];
}

interface OpeningHoursEntry {
  days?: unknown;
  hours?: unknown;
}

/** `[{"days":["Mon","Sun"],"hours":[["06:00","22:00"]]}, ...]` -> "Mon-Sun 06:00-22:00; ...". Exactly what the source reports, no inference beyond joining its own arrays. Returns null if absent/empty/malformed. */
function formatOpeningHours(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parts: string[] = [];
  for (const entry of raw as OpeningHoursEntry[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const days = Array.isArray(entry.days) ? entry.days.filter((d): d is string => typeof d === "string") : [];
    const hours = Array.isArray(entry.hours) ? entry.hours : [];
    const hourRanges: string[] = [];
    for (const h of hours) {
      if (Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string") {
        hourRanges.push(`${h[0]}-${h[1]}`);
      }
    }
    if (days.length === 0 || hourRanges.length === 0) continue;
    parts.push(`${days.join("-")} ${hourRanges.join(",")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Parse a `GET /api/v2/locations/{id}` response into a station record.
 * Never throws. Returns null if `id` or a finite `lat`/`lng` is missing —
 * those are the only fields this repo can't do without.
 *
 * `fuels` -> `products`, every entry with `priceInr: null` — see module doc
 * comment for why (fuel_pricing.status is "unavailable" for every India
 * outlet sampled; never fabricated as 0 or a guessed number).
 */
export function parseLocationDetail(json: unknown): ShellStationDetail | null {
  if (typeof json !== "object" || json === null) return null;
  const rec = json as Record<string, unknown>;

  const rawId = rec.id;
  if (typeof rawId !== "string" && typeof rawId !== "number") return null;
  const id = String(rawId);

  const lat = toCoord(rec.lat);
  const lng = toCoord(rec.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const name = toNonEmptyString(rec.name) ?? id;

  const fuels = Array.isArray(rec.fuels) ? rec.fuels.filter((f): f is string => typeof f === "string" && f.trim() !== "") : [];
  const products: ShellProduct[] = fuels.map((f) => ({ name: f, priceInr: null }));

  return {
    id,
    name,
    lat,
    lng,
    address: toNonEmptyString(rec.address) ?? toNonEmptyString(rec.formatted_address),
    city: toNonEmptyString(rec.city),
    state: toNonEmptyString(rec.state),
    postcode: toNonEmptyString(rec.postcode),
    telephone: toNonEmptyString(rec.telephone),
    countryCode: toNonEmptyString(rec.country_code),
    websiteUrl: toNonEmptyString(rec.website_url),
    hours: formatOpeningHours(rec.opening_hours),
    products,
  };
}
