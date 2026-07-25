import { describe, expect, it, vi } from "vitest";
import type { ProviderContext, WorkUnit } from "../provider.js";
import { createShellProvider } from "./shell-provider.js";
import { makeStationId } from "../id.js";
import { SHELL_WITHIN_BOUNDS_ENDPOINT, SHELL_LOCATION_ENDPOINT } from "../parsers/shell.js";

function jsonResponse(status: number, json: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => json } as unknown as Response;
}

/** Maps a within_bounds URL's sw/ne bbox to a canned response, keyed by a caller-provided lookup fn — lets tests script the recursive quadrant walk without hardcoding real India coords. */
function makeDiscoverFetch(
  responderFor: (url: string) => { status?: number; json?: unknown } | undefined,
): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    const entry = responderFor(u);
    if (!entry) throw new Error(`unexpected within_bounds fetch in test: ${u}`);
    return jsonResponse(entry.status ?? 200, entry.json ?? { locations: [], clusters: [] });
  }) as unknown as typeof fetch;
}

function makeCtx(detailResponses: Record<string, { status?: number; json?: unknown }>): ProviderContext {
  return {
    now: () => "2026-07-25T00:00:00.000Z",
    fetch: (async (url: string) => {
      const entry = detailResponses[url];
      if (!entry) throw new Error(`unexpected detail fetch in test: ${url}`);
      return jsonResponse(entry.status ?? 200, entry.json ?? {});
    }) as ProviderContext["fetch"],
  };
}

describe("createShellProvider().discover", () => {
  it("yields one WorkUnit per India location id when the outer bbox resolves without clustering", async () => {
    const fetchImpl = makeDiscoverFetch(() => ({
      json: {
        locations: [
          { id: "1", country_code: "IN" },
          { id: "2", country_code: "IN" },
          { id: "3", country_code: "PK" }, // filtered out — not India
        ],
        clusters: [],
      },
    }));
    const provider = createShellProvider({ fetchImpl });
    const units: WorkUnit[] = [];
    for await (const unit of provider.discover({})) units.push(unit);
    expect(units.map((u) => u.id).sort()).toEqual(["1", "2"]);
  });

  it("recursively subdivides a clustered bbox into 4 quadrants and unions their leaves", async () => {
    let callCount = 0;
    const fetchImpl = makeDiscoverFetch((url) => {
      callCount++;
      const params = new URL(url).searchParams;
      // First call (outer bbox) is clustered; every subsequent (quadrant) call resolves.
      if (callCount === 1) {
        expect(url.startsWith(`${SHELL_WITHIN_BOUNDS_ENDPOINT}?`)).toBe(true);
        return { json: { locations: [], clusters: [{ size: 999 }] } };
      }
      const [swLat, swLng] = params.getAll("sw[]");
      return { json: { locations: [{ id: `id-${swLat}-${swLng}`, country_code: "IN" }], clusters: [] } };
    });
    const provider = createShellProvider({ fetchImpl, bounds: { minLat: 0, minLng: 0, maxLat: 10, maxLng: 10 } });
    const units: WorkUnit[] = [];
    for await (const unit of provider.discover({})) units.push(unit);
    expect(callCount).toBe(5); // 1 outer + 4 quadrants
    expect(units).toHaveLength(4);
  });

  it("dedupes ids seen twice across quadrant leaves", async () => {
    let callCount = 0;
    const fetchImpl = makeDiscoverFetch(() => {
      callCount++;
      if (callCount === 1) return { json: { locations: [], clusters: [{ size: 1 }] } };
      // every quadrant reports the same single id (simulating a boundary-adjacent duplicate)
      return { json: { locations: [{ id: "dup-1", country_code: "IN" }], clusters: [] } };
    });
    const provider = createShellProvider({ fetchImpl, bounds: { minLat: 0, minLng: 0, maxLat: 10, maxLng: 10 } });
    const units: WorkUnit[] = [];
    for await (const unit of provider.discover({})) units.push(unit);
    expect(units).toHaveLength(1);
    expect(units[0]!.id).toBe("dup-1");
  });

  it("throws when a within_bounds call fails, rather than silently yielding a partial set", async () => {
    // discover() retries 500s via fetchWithBackoff's real exponential backoff (~14s worst case) —
    // fake timers let this test verify the eventual throw without actually waiting.
    vi.useFakeTimers();
    try {
      const fetchImpl = makeDiscoverFetch(() => ({ status: 500 }));
      const provider = createShellProvider({ fetchImpl });
      const drain = (async () => {
        for await (const _unit of provider.discover({})) {
          // draining the generator triggers the throw
        }
      })();
      const assertion = expect(drain).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createShellProvider().process", () => {
  const REAL_DETAIL = {
    id: "12665703",
    name: "DAVANAGERE-OLD PB RD",
    lat: 14.472296,
    lng: 75.893283,
    country_code: "IN",
    address: "DAVANGERE",
    city: "DAVANGERE",
    state: "Karnataka",
    postcode: "577004",
    telephone: "+91 99014 90156",
    website_url: "https://find.shell.com/in/fuel/12665703-davanagere-old-pb-rd",
    fuels: ["premium_gasoline", "shell_regular_diesel"],
    opening_hours: [{ days: ["Mon", "Sun"], hours: [["06:00", "22:00"]] }],
    fuel_pricing: { status: "unavailable" },
  };
  const detailUrl = `${SHELL_LOCATION_ENDPOINT}/12665703`;

  it("ok: builds a grade-agnostic RawOutletRecord with null-priced products", async () => {
    const provider = createShellProvider();
    const ctx = makeCtx({ [detailUrl]: { json: REAL_DETAIL } });
    const unit: WorkUnit = { id: "12665703", payload: { id: "12665703" } };
    const result = await provider.process(unit, ctx);

    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.brand).toBe("Shell");
    expect(record.outletId).toBe("12665703");
    expect(record.name).toBe("DAVANAGERE-OLD PB RD");
    expect(record.lat).toBe(14.472296);
    expect(record.lng).toBe(75.893283);
    expect(record.city).toBe("DAVANGERE");
    expect(record.state).toBe("Karnataka");
    expect(record.pincode).toBe("577004");
    expect(record.contact).toBe("+91 99014 90156");
    expect(record.hours).toBe("Mon-Sun 06:00-22:00");
    expect(record.sourceUrl).toBe("https://find.shell.com/in/fuel/12665703-davanagere-old-pb-rd");
    expect(record.mapsLink).toBeNull();
    expect(record.capturedAt).toBe("2026-07-25T00:00:00.000Z");
    expect(record.geohash).toBeTruthy();
    expect(record.products).toEqual([
      { name: "premium_gasoline", priceInr: null },
      { name: "shell_regular_diesel", priceInr: null },
    ]);

    const expectedId = await makeStationId({ brand: "Shell", outletId: "12665703", lat: 14.472296, lng: 75.893283 });
    expect(record.stationId).toBe(expectedId);
  });

  it("sourceUrl falls back to the detail endpoint URL when website_url is absent", async () => {
    const provider = createShellProvider();
    const { website_url, ...withoutWebsite } = REAL_DETAIL;
    const ctx = makeCtx({ [detailUrl]: { json: withoutWebsite } });
    const unit: WorkUnit = { id: "12665703", payload: { id: "12665703" } };
    const result = await provider.process(unit, ctx);
    expect(result.records[0]!.sourceUrl).toBe(detailUrl);
  });

  it("httpFailed: non-ok detail response", async () => {
    const provider = createShellProvider();
    const ctx = makeCtx({ [detailUrl]: { status: 500 } });
    const unit: WorkUnit = { id: "12665703", payload: { id: "12665703" } };
    const result = await provider.process(unit, ctx);
    expect(result.status).toBe("httpFailed");
    expect(result.records).toEqual([]);
  });

  it("parsedNull: detail response missing required fields", async () => {
    const provider = createShellProvider();
    const ctx = makeCtx({ [detailUrl]: { json: { name: "no id or coords" } } });
    const unit: WorkUnit = { id: "12665703", payload: { id: "12665703" } };
    const result = await provider.process(unit, ctx);
    expect(result.status).toBe("parsedNull");
    expect(result.records).toEqual([]);
  });

  it("empty: guards against a stale id resolving to a non-India outlet", async () => {
    const provider = createShellProvider();
    const ctx = makeCtx({ [detailUrl]: { json: { ...REAL_DETAIL, country_code: "PK" } } });
    const unit: WorkUnit = { id: "12665703", payload: { id: "12665703" } };
    const result = await provider.process(unit, ctx);
    expect(result.status).toBe("empty");
    expect(result.records).toEqual([]);
  });

  it("errored: ctx.fetch throws", async () => {
    const provider = createShellProvider();
    const ctx: ProviderContext = {
      now: () => "2026-07-25T00:00:00.000Z",
      fetch: (async () => {
        throw new Error("network exploded");
      }) as ProviderContext["fetch"],
    };
    const unit: WorkUnit = { id: "12665703", payload: { id: "12665703" } };
    const result = await provider.process(unit, ctx);
    expect(result.status).toBe("errored");
    expect(result.detail).toContain("network exploded");
    expect(result.records).toEqual([]);
  });
});
