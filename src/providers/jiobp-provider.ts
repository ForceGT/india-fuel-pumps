/**
 * Jio-bp `Provider` (see ../provider.ts) — see docs/jiobp-api.md for the
 * reverse-engineered API reference this is built from.
 *
 * Two-call shape: discover() makes ONE `FetchROMaster` call to get the
 * national station index (code + coords + state), then yields WorkUnits
 * that are BATCHES of station codes (batchSize, default 18 — matches the
 * app's observed batch size). process() makes one `FindFuelStation` call
 * per batch and turns the response into RawOutletRecords.
 *
 * `state` isn't present in the FindFuelStation response, only in the
 * ROMaster index — so each WorkUnit's payload carries a `stateByCode` map
 * built from the index entries in that batch, and process() looks up state
 * from it rather than needing any shared/global state across calls.
 *
 * No auth: MobileNumber/IMEINo are constants, TokenNumber is a fresh
 * crypto.randomUUID() per request (see docs/jiobp-api.md — values aren't
 * validated by the server, they just need to be present and well-formed).
 *
 * No grade opinion anywhere here — HistoryFuelProducts' ProductName is
 * captured verbatim per parseFindFuelStationResponse.
 */
import { createHash } from "node:crypto";
import { geohashEncode } from "../geo.js";
import { makeStationId } from "../id.js";
import { buildRawRecord, type OutletMetadata } from "../lib/raw-record.js";
import type { Provider, ProcessResult, WorkUnit } from "../provider.js";
import {
  JIOBP_ENDPOINT,
  buildFindFuelStationRequest,
  buildROMasterRequest,
  parseFindFuelStationResponse,
  parseROMasterResponse,
} from "../parsers/jiobp.js";

export interface JiobpProviderConfig {
  /** Station codes per FindFuelStation batch. Default 18 (observed in-app batch size). */
  batchSize?: number;
  /** Injectable for tests / discover()'s own ROMaster call, which runs before ctx exists. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface JiobpUnitPayload {
  codes: string[];
  stateByCode: Record<string, string | null>;
}

export function createJiobpProvider(config: JiobpProviderConfig = {}): Provider {
  const batchSize = Math.max(1, config.batchSize ?? 18);

  // Error logging — first 3 of each type, matching every other provider in this repo.
  const errCounts: Record<string, number> = {};
  const MAX_ERROR_LOG = 3;
  function logErr(kind: string, detail: string): void {
    const n = errCounts[kind] ?? 0;
    errCounts[kind] = n + 1;
    if (n < MAX_ERROR_LOG) console.error(`[jiobp] error ${n + 1} — ${detail.slice(0, 200)}`);
  }

  return {
    brand: "JioBP",
    slug: "jiobp",

    async *discover(): AsyncIterable<WorkUnit> {
      const fetchImpl = config.fetchImpl ?? fetch;
      const req = buildROMasterRequest(crypto.randomUUID());
      let res: Response;
      try {
        res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
      } catch (err) {
        throw new Error(`[jiobp-provider] discover: ROMaster fetch threw: ${String(err)}`);
      }
      if (!res.ok) {
        throw new Error(`[jiobp-provider] discover: ROMaster fetch failed HTTP ${res.status}`);
      }
      const json = (await res.json()) as unknown;
      const entries = parseROMasterResponse(json);
      console.log(`[jiobp-provider] discovered ${entries.length} stations from ROMaster index`);

      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        const codes = batch.map((e) => e.fuelStationCode);
        const stateByCode: Record<string, string | null> = {};
        for (const e of batch) stateByCode[e.fuelStationCode] = e.state;
        const payload: JiobpUnitPayload = { codes, stateByCode };
        const batchHash = createHash("sha1").update(codes.slice().sort().join(",")).digest("hex").slice(0, 12);
        yield { id: `batch-${batchHash}`, payload };
      }
    },

    async process(unit, ctx): Promise<ProcessResult> {
      const { codes, stateByCode } = unit.payload as JiobpUnitPayload;
      try {
        const req = buildFindFuelStationRequest(codes, crypto.randomUUID());
        const res = await ctx.fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
        if (!res.ok) {
          logErr("httpFailed", `HTTP ${res.status} for unit ${unit.id}`);
          return { status: "httpFailed", detail: `HTTP ${res.status}`, records: [] };
        }
        const json = (await res.json()) as unknown;
        const responseFlag = (json as Record<string, unknown> | null)?.["CustomerResponse"] as Record<string, unknown> | undefined;
        const findFuelStation = (responseFlag?.["FuelStation"] as Record<string, unknown> | undefined)?.["FindFuelStation"] as
          | Record<string, unknown>
          | undefined;
        const isSuccessResponse = findFuelStation?.["ResponseFlag"] === "S";
        const stations = parseFindFuelStationResponse(json);
        if (stations.length === 0) {
          const detail = isSuccessResponse
            ? "FindFuelStation returned zero stations for a batch of known-valid codes from our own ROMaster index — unexpected, retrying rather than treating as permanently empty"
            : "API response was not ResponseFlag S — retrying rather than treating as permanently empty";
          logErr("parsedNull", `${isSuccessResponse ? "unexpected empty result" : "non-success ResponseFlag"} for unit ${unit.id}`);
          return { status: "parsedNull", detail, records: [] };
        }

        const now = ctx.now();
        const records = [];
        for (const s of stations) {
          const stationId = await makeStationId({ brand: "JioBP", outletId: s.fuelStationCode, lat: s.lat, lng: s.lng });
          const metadata: OutletMetadata = {
            brand: "JioBP",
            outletId: s.fuelStationCode,
            stationId,
            sourceUrl: JIOBP_ENDPOINT,
            capturedAt: now,
            name: s.name,
            address: s.address,
            city: null,
            state: stateByCode[s.fuelStationCode] ?? null,
            pincode: null,
            lat: s.lat,
            lng: s.lng,
            geohash: geohashEncode(s.lat, s.lng, 7),
            hours: null,
            contact: s.contact,
            mapsLink: null,
          };
          records.push(buildRawRecord(metadata, s.products));
        }
        return { status: "ok", records };
      } catch (err) {
        console.error(`[jiobp] connection error on unit ${unit.id}:`, String(err));
        return { status: "errored", detail: String(err), records: [] };
      }
    },
  };
}
