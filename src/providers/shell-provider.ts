/**
 * Shell `Provider` (see ../provider.ts) — see docs/shell-api.md for the
 * reverse-engineered API reference this is built from.
 *
 * Two-phase discovery, both against the SAME unauthenticated `geoapp.me`
 * REST API (no session, no CSRF, unlike Nayara):
 *
 *  1. `discover()` walks a bounding-box grid over India via
 *     `within_bounds`, recursively subdividing any bbox that comes back
 *     clustered (mirrors BPCL's adaptive-grid saturation handling, except
 *     the API itself signals "too dense" via `clusters` instead of a size
 *     threshold this repo has to guess). Leaves yield outlet ids
 *     (`country_code === "IN"` only). This runs entirely inside `discover()`
 *     — no ctx available there (matches jiobp/nayara precedent) — using
 *     `fetchWithBackoff` directly for retry/backoff parity with `process()`.
 *  2. `process()` makes ONE `GET /api/v2/locations/{id}` call per unit — the
 *     only place `fuels` (products) and opening hours are available; the
 *     `within_bounds` stub doesn't carry them.
 *
 * No grade opinion anywhere here — `fuels` slugs are captured verbatim per
 * parseLocationDetail. Every product's `priceInr` is null: Shell's India
 * locator doesn't publish per-outlet prices through this API (see
 * docs/shell-api.md) — never fabricated.
 */
import { geohashEncode } from "../geo.js";
import { makeStationId } from "../id.js";
import { fetchWithBackoff } from "../http.js";
import { buildRawRecord, type OutletMetadata } from "../lib/raw-record.js";
import { isCommunityCoco } from "../lib/community-coco.js";
import type { Provider, ProcessResult, WorkUnit } from "../provider.js";
import {
  buildLocationDetailUrl,
  buildWithinBoundsUrl,
  parseLocationDetail,
  parseWithinBoundsResponse,
  type ShellBounds,
} from "../parsers/shell.js";

/** Same outer bounding box as BPCL's grid (src/providers/bpcl-provider.ts) — generously covers India; border overshoot into neighbouring countries is filtered out via country_code. */
const INDIA_BOUNDS: ShellBounds = { minLat: 6.5, minLng: 68, maxLat: 37.5, maxLng: 97.5 };

/** Safety cap on bbox-subdivision recursion — no leaf has ever needed more than a handful of levels in testing (see docs/shell-api.md), this just guards against an unexpected pathological response. */
const MAX_SUBDIVIDE_DEPTH = 10;

function subdivideBounds(bounds: ShellBounds): ShellBounds[] {
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const midLng = (bounds.minLng + bounds.maxLng) / 2;
  return [
    { minLat: bounds.minLat, minLng: bounds.minLng, maxLat: midLat, maxLng: midLng },
    { minLat: midLat, minLng: bounds.minLng, maxLat: bounds.maxLat, maxLng: midLng },
    { minLat: bounds.minLat, minLng: midLng, maxLat: midLat, maxLng: bounds.maxLng },
    { minLat: midLat, minLng: midLng, maxLat: bounds.maxLat, maxLng: bounds.maxLng },
  ];
}

export interface ShellProviderConfig {
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  bounds?: ShellBounds;
  maxSubdivideDepth?: number;
}

export function createShellProvider(config: ShellProviderConfig = {}): Provider {
  const bounds = config.bounds ?? INDIA_BOUNDS;
  const maxDepth = config.maxSubdivideDepth ?? MAX_SUBDIVIDE_DEPTH;

  // Error logging — first 3 of each type, matching every other provider in this repo.
  const errCounts: Record<string, number> = {};
  const MAX_ERROR_LOG = 3;
  function logErr(kind: string, detail: string): void {
    const n = errCounts[kind] ?? 0;
    errCounts[kind] = n + 1;
    if (n < MAX_ERROR_LOG) console.error(`[shell] error ${n + 1} — ${detail.slice(0, 200)}`);
  }

  async function* discoverIds(box: ShellBounds, depth: number): AsyncGenerator<string> {
    const url = buildWithinBoundsUrl(box);
    let res: Response;
    try {
      res = await fetchWithBackoff(url, { fetchImpl: config.fetchImpl });
    } catch (err) {
      throw new Error(`[shell-provider] discover: within_bounds fetch threw for ${JSON.stringify(box)}: ${String(err)}`);
    }
    if (!res.ok) {
      throw new Error(`[shell-provider] discover: within_bounds HTTP ${res.status} for ${JSON.stringify(box)}`);
    }
    const json = (await res.json()) as unknown;
    const { stubs, hasClusters } = parseWithinBoundsResponse(json);

    if (hasClusters && depth < maxDepth) {
      for (const child of subdivideBounds(box)) {
        yield* discoverIds(child, depth + 1);
      }
      return;
    }
    if (hasClusters) {
      console.warn(`[shell-provider] still clustered at maxSubdivideDepth=${maxDepth} bounds=${JSON.stringify(box)} — some outlets here may be missed`);
    }
    for (const stub of stubs) {
      if (stub.countryCode === "IN") yield stub.id;
    }
  }

  return {
    brand: "Shell",
    slug: "shell",

    async *discover(): AsyncIterable<WorkUnit> {
      const seen = new Set<string>();
      let count = 0;
      for await (const id of discoverIds(bounds, 0)) {
        if (seen.has(id)) continue; // bbox leaves are disjoint but boundary-adjacent stubs could theoretically repeat — cheap dedup, matches other providers' resumability-key discipline.
        seen.add(id);
        count++;
        yield { id, payload: { id } };
      }
      console.log(`[shell-provider] discovered ${count} India outlet ids`);
    },

    async process(unit, ctx): Promise<ProcessResult> {
      const { id } = unit.payload as { id: string };
      try {
        const url = buildLocationDetailUrl(id);
        const res = await ctx.fetch(url);
        if (!res.ok) {
          logErr("httpFailed", `HTTP ${res.status} for unit ${unit.id}`);
          return { status: "httpFailed", detail: `HTTP ${res.status}`, records: [] };
        }
        const json = (await res.json()) as unknown;
        const detail = parseLocationDetail(json);
        if (!detail) {
          logErr("parsedNull", `unparseable detail response for unit ${unit.id}`);
          return { status: "parsedNull", detail: "parseLocationDetail returned null", records: [] };
        }
        if (detail.countryCode !== "IN") {
          // Shouldn't happen — discover() already filtered to country_code === "IN" — but guard against a stale/renumbered id.
          return { status: "empty", records: [] };
        }

        const now = ctx.now();
        const stationId = await makeStationId({ brand: "Shell", outletId: detail.id, lat: detail.lat, lng: detail.lng });
        const metadata: OutletMetadata = {
          brand: "Shell",
          outletId: detail.id,
          stationId,
          sourceUrl: detail.websiteUrl ?? url,
          capturedAt: now,
          name: detail.name,
          address: detail.address,
          city: detail.city,
          state: detail.state,
          pincode: detail.postcode,
          lat: detail.lat,
          lng: detail.lng,
          geohash: geohashEncode(detail.lat, detail.lng, 7),
          hours: detail.hours,
          contact: detail.telephone,
          mapsLink: null,
          amenities: null,
          categories: isCommunityCoco(stationId) ? ["COCO"] : [],
        };
        const record = buildRawRecord(metadata, detail.products);
        return { status: "ok", records: [record] };
      } catch (err) {
        console.error(`[shell] connection error on unit ${unit.id}:`, String(err));
        return { status: "errored", detail: String(err), records: [] };
      }
    },
  };
}
