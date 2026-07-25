/**
 * Nayara `Provider` (see ../provider.ts) — see docs/nayara-api.md for the
 * reverse-engineered API reference this is built from.
 *
 * Unlike every other brand here, discovery needs no network call at all:
 * one `/get-code-ro-radius` call at a large radius (e.g. 3000km) from a
 * central point returns (almost) the entire national dataset in one shot
 * (see docs/nayara-api.md's "Discovery" section) — so `discover()` just
 * yields a small, fixed set of center-point WorkUnits; a second center is
 * kept as a cheap safety margin against edge-of-radius gaps, exactly as the
 * doc recommends. Both units' results overlap heavily (near-duplicate
 * national rosters) — this is intentional and harmless, same as BPCL's
 * overlapping route/grid cells: `build-dataset.ts` dedupes by `stationId`
 * (latest `capturedAt` wins).
 *
 * Session handling: `init()` bootstraps ONE session (cookies + CSRF token,
 * from a GET of the locator page) before any work is attempted, mirroring
 * BPCL's OAuth-token init() so a broken auth setup fails fast. `process()`
 * treats an HTTP 419 (CSRF/session expiry) like BPCL treats a 401 — refresh
 * once, retry once — rather than assuming the one bootstrapped session lasts
 * the whole run (see docs/nayara-api.md's "Auth model" section, which
 * explicitly recommends this over a one-time init()).
 *
 * DELIBERATE DECISION: this brand's requests present as a normal Chrome
 * browser (NAYARA_CHROME_HEADERS in ../parsers/nayara.js), not this repo's
 * honest IndiaFuelPumpsBot identity — see that module's doc comment and
 * docs/nayara-api.md's "Blocker: Akamai WAF..." section for the full
 * rationale.
 *
 * No grade opinion anywhere here — PETROL/DIESEL are captured verbatim per
 * parseRadiusResponse.
 */
import { geohashEncode } from "../geo.js";
import { makeStationId } from "../id.js";
import { buildRawRecord, type OutletMetadata } from "../lib/raw-record.js";
import type { Provider, ProcessResult, ProviderContext, WorkUnit } from "../provider.js";
import {
  NAYARA_RADIUS_ENDPOINT,
  buildRadiusRequest,
  buildSessionBootstrapRequest,
  extractSession,
  parseRadiusResponse,
  type NayaraSession,
} from "../parsers/nayara.js";

/** Two widely-separated center points at a large radius — see module doc comment for why two is enough. */
const CENTER_POINTS: { id: string; lat: number; lng: number }[] = [
  { id: "center-bhopal", lat: 23.2599, lng: 77.4126 }, // central Madhya Pradesh
  { id: "center-kolkata", lat: 22.5726, lng: 88.3639 }, // far east, safety margin
];
const RADIUS_KM = 3000;

interface NayaraUnitPayload {
  lat: number;
  lng: number;
  radiusKm: number;
}

interface SessionState {
  session: NayaraSession | null;
}

/** Node's fetch (undici) Headers supports getSetCookie() for multiple Set-Cookie values; fall back to the single-value get() for other implementations. */
function extractSetCookieHeaders(res: Response): string[] {
  const headersAny = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof headersAny.getSetCookie === "function") return headersAny.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

export interface NayaraProviderConfig {
  /** Override the default two center points (tests only). */
  centerPoints?: { id: string; lat: number; lng: number }[];
  /** Override the default 3000km radius (tests only). */
  radiusKm?: number;
}

export function createNayaraProvider(config: NayaraProviderConfig = {}): Provider {
  const centerPoints = config.centerPoints ?? CENTER_POINTS;
  const radiusKm = config.radiusKm ?? RADIUS_KM;
  const sessionState: SessionState = { session: null };

  // Error logging — first 3 of each type, matching every other provider in this repo.
  const errCounts: Record<string, number> = {};
  const MAX_ERROR_LOG = 3;
  function logErr(kind: string, detail: string): void {
    const n = errCounts[kind] ?? 0;
    errCounts[kind] = n + 1;
    if (n < MAX_ERROR_LOG) console.error(`[nayara] error ${n + 1} — ${detail.slice(0, 200)}`);
  }

  async function bootstrapSession(ctx: ProviderContext): Promise<NayaraSession> {
    const req = buildSessionBootstrapRequest();
    const res = await ctx.fetch(req.url, { method: req.method, headers: req.headers });
    if (!res.ok) throw new Error(`Nayara session bootstrap failed: HTTP ${res.status}`);
    const html = await res.text();
    const setCookie = extractSetCookieHeaders(res);
    const session = extractSession(html, setCookie);
    if (!session) {
      throw new Error("Nayara session bootstrap failed: missing CSRF token or session cookies in locator page response");
    }
    return session;
  }

  return {
    brand: "Nayara",
    slug: "nayara",

    async init(ctx) {
      // Fail fast if the session bootstrap is broken, before any work is attempted.
      sessionState.session = await bootstrapSession(ctx);
    },

    async *discover(): AsyncIterable<WorkUnit> {
      for (const center of centerPoints) {
        const payload: NayaraUnitPayload = { lat: center.lat, lng: center.lng, radiusKm };
        yield { id: center.id, payload };
      }
    },

    async process(unit, ctx): Promise<ProcessResult> {
      const { lat, lng, radiusKm: unitRadiusKm } = unit.payload as NayaraUnitPayload;
      try {
        if (!sessionState.session) {
          sessionState.session = await bootstrapSession(ctx);
        }

        const req = buildRadiusRequest(sessionState.session, lat, lng, unitRadiusKm);
        let res = await ctx.fetch(req.url, { method: req.method, headers: req.headers, body: req.body });

        if (res.status === 419) {
          // CSRF/session expired — refresh once and retry once (mirrors BPCL's 401 -> refresh-token -> retry).
          sessionState.session = await bootstrapSession(ctx);
          const retryReq = buildRadiusRequest(sessionState.session, lat, lng, unitRadiusKm);
          res = await ctx.fetch(retryReq.url, {
            method: retryReq.method,
            headers: retryReq.headers,
            body: retryReq.body,
          });
        }

        if (!res.ok) {
          logErr("httpFailed", `HTTP ${res.status} for unit ${unit.id}`);
          return { status: "httpFailed", detail: `HTTP ${res.status}`, records: [] };
        }

        const json = (await res.json()) as unknown;
        const stations = parseRadiusResponse(json);
        if (stations.length === 0) return { status: "empty", records: [] };

        const now = ctx.now();
        const records = [];
        for (const s of stations) {
          const stationId = await makeStationId({ brand: "Nayara", outletId: s.cmsCode, lat: s.lat, lng: s.lng });
          const metadata: OutletMetadata = {
            brand: "Nayara",
            outletId: s.cmsCode,
            stationId,
            sourceUrl: NAYARA_RADIUS_ENDPOINT,
            capturedAt: now,
            name: s.name,
            address: s.address,
            city: null,
            state: null,
            pincode: null,
            lat: s.lat,
            lng: s.lng,
            geohash: geohashEncode(s.lat, s.lng, 7),
            hours: null,
            contact: null,
            mapsLink: null,
          };
          records.push(buildRawRecord(metadata, s.products));
        }
        return { status: "ok", records };
      } catch (err) {
        console.error(`[nayara] connection error on unit ${unit.id}:`, String(err));
        return { status: "errored", detail: String(err), records: [] };
      }
    },
  };
}
