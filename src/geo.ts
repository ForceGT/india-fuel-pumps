/**
 * Geo helpers. D1/SQLite has no native spatial index, so we prefilter by
 * geohash prefix (cheap, indexed) and sort/filter precisely with haversine in
 * the Worker. See docs/lld.md §Query patterns.
 */

/** Exported so shard.ts (`prefixesForBbox`) can walk the same alphabet without reinventing it. */
export const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Encode lat/lng to a geohash of the given precision (default 7 ≈ 150m cell). */
export function geohashEncode(lat: number, lng: number, precision = 7): string {
  let latMin = -90,
    latMax = 90,
    lngMin = -180,
    lngMax = 180;
  let hash = "";
  let bit = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng > mid) {
        ch |= 1 << (4 - bit);
        lngMin = mid;
      } else lngMax = mid;
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat > mid) {
        ch |= 1 << (4 - bit);
        latMin = mid;
      } else latMax = mid;
    }
    even = !even;
    if (bit < 4) {
      bit++;
    } else {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

const R = 6371; // km
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Decode a geohash string back to the lat/lng bounding box it represents.
 * Exact inverse of `geohashEncode`'s bit-halving — used by `neighborPrefixes`
 * (via the exact neighbor algorithm below) and by `neighborCoverageKm` to
 * reason about true cell size in km.
 */
export function geohashDecodeBounds(hash: string): {
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
} {
  let latMin = -90,
    latMax = 90,
    lngMin = -180,
    lngMax = 180;
  let even = true;
  for (const c of hash.toLowerCase()) {
    const idx = BASE32.indexOf(c);
    for (let bit = 4; bit >= 0; bit--) {
      const bitVal = (idx >> bit) & 1;
      if (even) {
        const mid = (lngMin + lngMax) / 2;
        if (bitVal) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bitVal) latMin = mid;
        else latMax = mid;
      }
      even = !even;
    }
  }
  return { latMin, latMax, lngMin, lngMax };
}

/**
 * Standard geohash bit-manipulation neighbor tables (Gustavo Niemeyer's
 * geohash algorithm, as popularized by davetroy/node-geohash and
 * chrisveness/latlon-geohash). Index order is [even-length, odd-length]
 * because the meaning of a geohash character's bits alternates between
 * longitude-major and latitude-major depending on whether the hash so far
 * has an even or odd number of characters.
 *
 * This gives the EXACT adjacent cell (not an approximate lat/lng step —
 * see the old `cellSizeDeg` sampling this replaced), so `neighborPrefixes`
 * is provably correct rather than a best-effort 3x3 sample.
 */
const NEIGHBOR_TABLE: Record<"n" | "s" | "e" | "w", [string, string]> = {
  n: ["p0r21436x8zb9dcf5h7kjnmqesgutwvy", "bc01fg45238967deuvhjyznpkmstqrwx"],
  s: ["14365h7k9dcfesgujnmqp0r2twvyx8zb", "238967debc01fg45kmstqrwxuvhjyznp"],
  e: ["bc01fg45238967deuvhjyznpkmstqrwx", "p0r21436x8zb9dcf5h7kjnmqesgutwvy"],
  w: ["238967debc01fg45kmstqrwxuvhjyznp", "14365h7k9dcfesgujnmqp0r2twvyx8zb"],
};
const BORDER_TABLE: Record<"n" | "s" | "e" | "w", [string, string]> = {
  n: ["prxz", "bcfguvyz"],
  s: ["028b", "0145hjnp"],
  e: ["bcfguvyz", "prxz"],
  w: ["0145hjnp", "028b"],
};

/**
 * Exact geohash of the cell adjacent to `hash` in one cardinal direction, via
 * the standard bit-manipulation algorithm. Diagonal neighbours are two calls
 * composed (e.g. north-east = `adjacentGeohash(adjacentGeohash(h, "n"), "e")`).
 *
 * Latitude does NOT wrap: there is no "north of the north pole", so repeatedly
 * walking north from a cell already touching lat=+90 (or south from lat=-90)
 * keeps re-deriving a degenerate/duplicate cell rather than erroring — callers
 * should expect fewer than 8 distinct neighbours very close to the poles
 * (`neighborPrefixes` dedupes via `Set`, so this only ever reduces the result
 * count, never throws or corrupts it). Longitude DOES wrap correctly across
 * the antimeridian (±180): the border/neighbor tables encode that seam as an
 * ordinary cell boundary, exactly like any other column edge.
 */
function adjacentGeohash(hash: string, direction: "n" | "s" | "e" | "w"): string {
  const lower = hash.toLowerCase();
  const lastChr = lower.charAt(lower.length - 1);
  const type = lower.length % 2 === 0 ? 0 : 1; // even length -> 0, odd length -> 1
  let base = lower.substring(0, lower.length - 1);
  if (BORDER_TABLE[direction][type].includes(lastChr) && base !== "") {
    base = adjacentGeohash(base, direction);
  }
  const idx = NEIGHBOR_TABLE[direction][type].indexOf(lastChr);
  return base + BASE32[idx];
}

/**
 * Geohash prefixes covering a lat/lng point plus its true 8 geohash
 * neighbours at the given prefix length — used to build an indexed
 * `geohash LIKE prefix%` prefilter that won't miss stations sitting just
 * across a cell boundary. Computed via exact geohash bit-manipulation
 * (see `adjacentGeohash`), not approximate lat/lng-degree sampling, so this
 * is provably the point's own cell plus all 8 adjacent cells (fewer near the
 * poles, where some directions degenerate — see `adjacentGeohash`).
 */
export function neighborPrefixes(lat: number, lng: number, prefixLen: number): string[] {
  const own = geohashEncode(lat, lng, prefixLen);
  const n = adjacentGeohash(own, "n");
  const s = adjacentGeohash(own, "s");
  const e = adjacentGeohash(own, "e");
  const w = adjacentGeohash(own, "w");
  const prefixes = new Set<string>([
    own,
    n,
    s,
    e,
    w,
    adjacentGeohash(n, "e"), // ne
    adjacentGeohash(n, "w"), // nw
    adjacentGeohash(s, "e"), // se
    adjacentGeohash(s, "w"), // sw
  ]);
  return [...prefixes];
}

/**
 * Guaranteed radius in km around (lat,lng) that `neighborPrefixes(lat, lng,
 * prefixLen)` fully covers — i.e. no point within this many km of (lat,lng)
 * can fall outside the returned own+8-neighbour cell block. Deliberately
 * conservative: uses the SMALLER of the own cell's lat-height and lng-width
 * in km (lng-width shrinks with latitude), and credits only one further full
 * cell width beyond the own cell — the worst case where the query point sits
 * right on the own cell's edge, so only the adjacent cell (not the far edge
 * of a "your own cell plus neighbour" span) can be relied on.
 *
 * Used by workers/api's `/near` widening loop (see routes/near.ts) to turn
 * "widen until we have `limit` candidates" into "widen until correctness is
 * actually guaranteed", per docs/lld.md §4.
 */
export function neighborCoverageKm(lat: number, lng: number, prefixLen: number): number {
  const hash = geohashEncode(lat, lng, prefixLen);
  const { latMin, latMax, lngMin, lngMax } = geohashDecodeBounds(hash);
  const heightKm = haversineKm(latMin, lng, latMax, lng);
  const widthKm = haversineKm(lat, lngMin, lat, lngMax);
  return Math.min(heightKm, widthKm);
}
