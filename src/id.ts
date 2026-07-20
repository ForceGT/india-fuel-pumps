/**
 * Stable station id + slug helpers. The id must be deterministic across
 * re-scrapes so upserts are idempotent (see docs/lld.md §Dedup).
 */

/** URL/SEO-safe slug. */
export function slugify(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Deterministic 16-hex station id from brand + outletId (+ geo fallback).
 * Uses SHA-1 via the Web Crypto API (available in Workers and Node ≥ 20).
 */
export async function makeStationId(input: {
  brand: string;
  outletId?: string | null;
  lat: number;
  lng: number;
}): Promise<string> {
  const key = `${input.brand}:${input.outletId ?? ""}:${input.lat}:${input.lng}`;
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 16);
}
