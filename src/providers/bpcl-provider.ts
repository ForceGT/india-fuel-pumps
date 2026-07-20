/**
 * BPCL `Provider` (see ../provider.ts) — a two-phase discovery: a
 * hand-curated route mesh (fast, high-value corridors) followed by an
 * adaptive point-grid over India (the actual completeness guarantee — grid
 * radius is provably >= cell half-diagonal, plus saturation-triggered
 * subdivision, so a real gap shows up as an explicit "still saturated at
 * MAX_DEPTH" log line, not silently).
 *
 * Both phases feed the SAME dynamic queue the generic runner drives — a
 * saturated cell's subdivision arrives via `ProcessResult.followups`. Route
 * chunks and grid cells can be processed concurrently/interleaved;
 * resumability is keyed by `workUnitId` (routeChunkId/cellId, which never
 * collide across the two work kinds).
 *
 * No grade opinion anywhere in this module — `products` is built straight
 * from the raw `weekDayFuelPriceList`, exactly as reported (no positivity
 * filter, no BS-suffix cleanup); classifying any of it is a downstream
 * consumer's job, not this repo's.
 */
import { haversineKm } from "../geo.js";
import { buildRawRecord } from "../lib/raw-record.js";
import type { Provider, ProcessResult, ProviderContext, WorkUnit } from "../provider.js";
import {
  buildLocatorUrl,
  buildRouteRequest,
  buildTokenRequest,
  isNoDataFoundResponse,
  parseAccessToken,
  parseLocatorResponseJson,
  parseOutletMetadata,
  type BpclPointOfService,
  type BpclRouteStep,
} from "../parsers/bpcl.js";

/** Refresh the access token if less than this much of its TTL remains. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// Phase 1: route mesh
// ─────────────────────────────────────────────────────────────────────────

/** Hand-curated mesh of major Indian city-pairs. */
const CITIES: Record<string, [number, number]> = {
  Srinagar: [34.0837, 74.7973], Jammu: [32.7266, 74.857], Amritsar: [31.634, 74.8723],
  Chandigarh: [30.7333, 76.7794], Shimla: [31.1048, 77.1734], Dehradun: [30.3165, 78.0322],
  Delhi: [28.6139, 77.209], Jaipur: [26.9124, 75.7873], Jodhpur: [26.2389, 73.0243],
  Udaipur: [24.5854, 73.7125], Ahmedabad: [23.0225, 72.5714], Rajkot: [22.3039, 70.8022],
  Surat: [21.1702, 72.8311], Mumbai: [19.076, 72.8777], Pune: [18.5204, 73.8567],
  Nagpur: [21.1458, 79.0882], Bhopal: [23.2599, 77.4126], Indore: [22.7196, 75.8577],
  Lucknow: [26.8467, 80.9462], Kanpur: [26.4499, 80.3319], Agra: [27.1767, 78.0081],
  Varanasi: [25.3176, 82.9739], Prayagraj: [25.4358, 81.8463], Patna: [25.5941, 85.1376],
  Ranchi: [23.3441, 85.3096], Kolkata: [22.5726, 88.3639], Bhubaneswar: [20.2961, 85.8245],
  Raipur: [21.2514, 81.6296], Guwahati: [26.1445, 91.7362], Shillong: [25.5788, 91.8933],
  Dibrugarh: [27.4728, 94.912], Imphal: [24.817, 93.9368], Aizawl: [23.7271, 92.7176],
  Agartala: [23.8315, 91.2868], Kohima: [25.6751, 94.1086], Gangtok: [27.3389, 88.6065],
  Hyderabad: [17.385, 78.4867], Vijayawada: [16.5062, 80.648], Visakhapatnam: [17.6868, 83.2185],
  Bengaluru: [12.9716, 77.5946], Chennai: [13.0827, 80.2707], Madurai: [9.9252, 78.1198],
  Kanniyakumari: [8.0883, 77.5385], Kochi: [9.9312, 76.2673], Thiruvananthapuram: [8.5241, 76.9366],
  Mangalore: [12.9141, 74.856], Goa: [15.4909, 73.8278], Coimbatore: [11.0168, 76.9558],
  Salem: [11.6643, 78.146],
};

/** [source city, dest city][] — see CITIES above. */
const ROUTES: [string, string][] = [
  ["Srinagar", "Jammu"], ["Jammu", "Amritsar"], ["Amritsar", "Chandigarh"], ["Chandigarh", "Delhi"],
  ["Chandigarh", "Shimla"], ["Shimla", "Dehradun"], ["Dehradun", "Delhi"], ["Delhi", "Jaipur"],
  ["Delhi", "Agra"], ["Delhi", "Kanpur"], ["Jaipur", "Jodhpur"], ["Jodhpur", "Udaipur"],
  ["Udaipur", "Ahmedabad"], ["Jaipur", "Ahmedabad"], ["Ahmedabad", "Rajkot"], ["Ahmedabad", "Surat"],
  ["Surat", "Mumbai"], ["Mumbai", "Pune"], ["Pune", "Goa"], ["Goa", "Mangalore"],
  ["Mangalore", "Kochi"], ["Kochi", "Thiruvananthapuram"], ["Thiruvananthapuram", "Kanniyakumari"],
  ["Kanniyakumari", "Madurai"], ["Madurai", "Coimbatore"], ["Coimbatore", "Bengaluru"],
  ["Bengaluru", "Chennai"], ["Chennai", "Madurai"], ["Bengaluru", "Salem"], ["Salem", "Chennai"],
  ["Bengaluru", "Mangalore"], ["Bengaluru", "Hyderabad"], ["Hyderabad", "Vijayawada"],
  ["Vijayawada", "Visakhapatnam"], ["Visakhapatnam", "Bhubaneswar"], ["Bhubaneswar", "Kolkata"],
  ["Kolkata", "Patna"], ["Patna", "Varanasi"], ["Varanasi", "Prayagraj"], ["Prayagraj", "Kanpur"],
  ["Kanpur", "Lucknow"], ["Lucknow", "Patna"], ["Patna", "Ranchi"], ["Ranchi", "Raipur"],
  ["Raipur", "Nagpur"], ["Nagpur", "Bhopal"], ["Bhopal", "Indore"], ["Indore", "Ahmedabad"],
  ["Nagpur", "Hyderabad"], ["Nagpur", "Mumbai"], ["Kolkata", "Guwahati"], ["Guwahati", "Shillong"],
  ["Guwahati", "Dibrugarh"], ["Guwahati", "Imphal"], ["Guwahati", "Agartala"], ["Imphal", "Aizawl"],
  ["Dibrugarh", "Kohima"], ["Kolkata", "Gangtok"],
];

const STEP_SPACING_KM = 35;
const MAX_STEPS_PER_CHUNK = 16;
const ROUTE_RADIUS_M = 25000;

function interpolatePoints(sLat: number, sLng: number, tLat: number, tLng: number, spacingKm: number): BpclRouteStep[] {
  const distKm = haversineKm(sLat, sLng, tLat, tLng);
  const n = Math.max(1, Math.round(distKm / spacingKm));
  const points: BpclRouteStep[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    points.push({ lat: sLat + (tLat - sLat) * f, lng: sLng + (tLng - sLng) * f });
  }
  return points;
}

export interface RouteChunk {
  routeChunkId: string;
  routeName: string;
  sourceLat: number;
  sourceLng: number;
  destLat: number;
  destLng: number;
  steps: BpclRouteStep[];
}

function buildRouteChunks(routeName: string, sLat: number, sLng: number, tLat: number, tLng: number): RouteChunk[] {
  const allPoints = interpolatePoints(sLat, sLng, tLat, tLng, STEP_SPACING_KM);
  const chunks: RouteChunk[] = [];
  let chunkIdx = 0;
  let i = 0;
  while (i < allPoints.length - 1) {
    const end = Math.min(i + MAX_STEPS_PER_CHUNK, allPoints.length - 1);
    const steps = allPoints.slice(i, end + 1);
    const first = steps[0]!;
    const last = steps[steps.length - 1]!;
    chunks.push({
      routeChunkId: `${routeName}#${chunkIdx}`,
      routeName,
      sourceLat: first.lat, sourceLng: first.lng, destLat: last.lat, destLng: last.lng,
      steps,
    });
    chunkIdx++;
    i = end;
  }
  return chunks;
}

function allRouteChunks(): RouteChunk[] {
  return ROUTES.flatMap(([a, b]) => {
    const [sLat, sLng] = CITIES[a]!;
    const [tLat, tLng] = CITIES[b]!;
    return buildRouteChunks(`${a}->${b}`, sLat, sLng, tLat, tLng);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 2: adaptive grid
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_INDIA_BOUNDS = { minLat: 6.5, maxLat: 37.5, minLng: 68, maxLng: 97.5 };
const GRID_SPACING_KM = 100;
const GRID_RADIUS_M = 75000;
const SATURATION_COUNT = 100;
const DEFAULT_MAX_DEPTH = 4;

export interface Cell {
  cellId: string;
  lat: number;
  lng: number;
  radiusM: number;
  spacingKm: number;
  depth: number;
}

function kmToDegLat(km: number): number {
  return km / 111;
}
function kmToDegLng(km: number, atLatDeg: number): number {
  return km / (111 * Math.cos((atLatDeg * Math.PI) / 180));
}
function makeCell(lat: number, lng: number, radiusM: number, spacingKm: number, depth: number): Cell {
  const cellId = `d${depth}:${lat.toFixed(5)}:${lng.toFixed(5)}:${Math.round(radiusM)}`;
  return { cellId, lat, lng, radiusM, spacingKm, depth };
}
function generateCoarseGrid(bounds: typeof DEFAULT_INDIA_BOUNDS): Cell[] {
  const cells: Cell[] = [];
  const dLat = kmToDegLat(GRID_SPACING_KM);
  for (let lat = bounds.minLat; lat <= bounds.maxLat; lat += dLat) {
    const dLng = kmToDegLng(GRID_SPACING_KM, lat);
    for (let lng = bounds.minLng; lng <= bounds.maxLng; lng += dLng) {
      cells.push(makeCell(lat, lng, GRID_RADIUS_M, GRID_SPACING_KM, 0));
    }
  }
  return cells;
}
/** Exported for tests. */
export function subdivide(cell: Cell): Cell[] {
  const childSpacingKm = cell.spacingKm / 2;
  const childRadiusM = cell.radiusM / 2;
  const offsetLat = kmToDegLat(childSpacingKm / 2);
  const offsetLng = kmToDegLng(childSpacingKm / 2, cell.lat);
  const children: Cell[] = [];
  for (const sLat of [-1, 1]) {
    for (const sLng of [-1, 1]) {
      children.push(makeCell(cell.lat + sLat * offsetLat, cell.lng + sLng * offsetLng, childRadiusM, childSpacingKm, cell.depth + 1));
    }
  }
  return children;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared: token state, raw-price extraction
// ─────────────────────────────────────────────────────────────────────────

interface TokenState {
  token: string | null;
  expiresAt: number;
}

/** Every product+price this outlet reports, exactly as the payload names it — no cleanup, no positivity filter (that's a downstream classification concern). */
function extractRawPrices(raw: BpclPointOfService): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of raw.weekDayFuelPriceList ?? []) {
    const key = f.displayName ?? f.code;
    if (!key || typeof f.price !== "number" || !Number.isFinite(f.price)) continue;
    out[key] = f.price;
  }
  return out;
}

export interface BpclProviderConfig {
  bounds?: typeof DEFAULT_INDIA_BOUNDS;
  maxDepth?: number;
  skipRoutes?: boolean;
  skipGrid?: boolean;
}

type BpclUnitPayload = { kind: "route"; chunk: RouteChunk } | { kind: "cell"; cell: Cell };

/** `opts` (from discover()'s Record<string,string>) wins if present ("1"/"true" = skip); otherwise falls back to the provider's construction-time config. */
function resolveSkip(optValue: string | undefined, configValue: boolean | undefined): boolean {
  if (optValue !== undefined) return optValue === "1" || optValue === "true";
  return configValue ?? false;
}

export function createBpclProvider(config: BpclProviderConfig = {}): Provider {
  const bounds = config.bounds ?? DEFAULT_INDIA_BOUNDS;
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
  const tokenState: TokenState = { token: null, expiresAt: 0 };

  async function refreshToken(ctx: ProviderContext): Promise<string> {
    const req = buildTokenRequest();
    const res = await ctx.fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`);
    const json = (await res.json()) as unknown;
    const token = parseAccessToken(json);
    if (!token) throw new Error("token refresh returned no access_token");
    const expiresInRaw = (json as Record<string, unknown>)?.expires_in;
    const expiresInSec = typeof expiresInRaw === "number" ? expiresInRaw : 3600;
    tokenState.token = token;
    tokenState.expiresAt = Date.now() + expiresInSec * 1000;
    return token;
  }

  async function ensureAccessToken(ctx: ProviderContext): Promise<string> {
    if (!tokenState.token || Date.now() > tokenState.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return refreshToken(ctx);
    }
    return tokenState.token;
  }

  async function recordOutlets(rawList: BpclPointOfService[], now: string): Promise<ReturnType<typeof buildRawRecord>[]> {
    const records: ReturnType<typeof buildRawRecord>[] = [];
    for (const raw of rawList) {
      const metadata = await parseOutletMetadata(raw, now);
      if (!metadata) continue;
      const products = Object.entries(extractRawPrices(raw)).map(([name, priceInr]) => ({ name, priceInr }));
      records.push(buildRawRecord(metadata, products));
    }
    return records;
  }

  return {
    brand: "BPCL",
    slug: "bpcl",

    async init(ctx) {
      await ensureAccessToken(ctx); // fail fast if auth is broken, before any work is attempted
    },

    async *discover(opts) {
      const skipRoutes = resolveSkip(opts.skipRoutes, config.skipRoutes);
      const skipGrid = resolveSkip(opts.skipGrid, config.skipGrid);

      if (!skipRoutes) {
        for (const chunk of allRouteChunks()) {
          const unit: WorkUnit = { id: chunk.routeChunkId, payload: { kind: "route", chunk } satisfies BpclUnitPayload };
          yield unit;
        }
      }
      if (!skipGrid) {
        for (const cell of generateCoarseGrid(bounds)) {
          const unit: WorkUnit = { id: cell.cellId, payload: { kind: "cell", cell } satisfies BpclUnitPayload };
          yield unit;
        }
      }
    },

    async process(unit, ctx): Promise<ProcessResult> {
      const payload = unit.payload as BpclUnitPayload;
      const now = ctx.now();
      try {
        const token = await ensureAccessToken(ctx);

        if (payload.kind === "route") {
          const { chunk } = payload;
          const req = buildRouteRequest({
            sourceLat: chunk.sourceLat, sourceLng: chunk.sourceLng,
            destLat: chunk.destLat, destLng: chunk.destLng,
            steps: chunk.steps, radius: ROUTE_RADIUS_M,
          });
          let res = await ctx.fetch(req.url, {
            method: req.method, body: req.body, headers: { ...req.headers, Authorization: `Bearer ${token}` },
          });
          if (res.status === 401) {
            const fresh = await refreshToken(ctx);
            res = await ctx.fetch(req.url, {
              method: req.method, body: req.body, headers: { ...req.headers, Authorization: `Bearer ${fresh}` },
            });
          }
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            if (res.status === 404 && isNoDataFoundResponse(body)) {
              return { status: "empty", records: [] };
            }
            return { status: "httpFailed", detail: `HTTP ${res.status}`, records: [] };
          }
          const json = (await res.json()) as unknown;
          const rawList = parseLocatorResponseJson(json);
          const records = await recordOutlets(rawList, now);
          return { status: records.length > 0 ? "ok" : "empty", records };
        }

        // payload.kind === "cell"
        const { cell } = payload;
        const url = buildLocatorUrl({ latitude: cell.lat, longitude: cell.lng, radius: cell.radiusM, pageSize: 100 });
        let res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) {
          const fresh = await refreshToken(ctx);
          res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
        }
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          if (res.status === 404 && isNoDataFoundResponse(body)) {
            return { status: "empty", records: [], saturated: false };
          }
          return { status: "httpFailed", detail: `HTTP ${res.status}`, records: [] };
        }
        const json = (await res.json()) as unknown;
        const rawList = parseLocatorResponseJson(json);
        const saturated = rawList.length >= SATURATION_COUNT;
        const records = await recordOutlets(rawList, now);

        const followups: WorkUnit[] = [];
        if (saturated) {
          if (cell.depth < maxDepth) {
            for (const child of subdivide(cell)) {
              followups.push({ id: child.cellId, payload: { kind: "cell", cell: child } satisfies BpclUnitPayload });
            }
          } else {
            console.warn(`[bpcl-provider] ${cell.cellId}: still saturated at maxDepth=${maxDepth} — some outlets here may be missed`);
          }
        }

        return {
          status: records.length > 0 ? "ok" : "empty",
          records,
          saturated,
          ...(followups.length > 0 ? { followups } : {}),
        };
      } catch (err) {
        return { status: "errored", detail: String(err), records: [] };
      }
    },
  };
}
