/**
 * Unit tests for the BPCL Provider — mirrors run-bpcl-full-census.test.ts's
 * original coverage philosophy (no real network calls; a fake `ctx.fetch`
 * stands in for api.cep.bpcl.in) but targets `process()`/`discover()`/
 * `init()` directly, since the old script's `processRouteChunk`/
 * `processCell`/token-refresh logic is now inlined into this provider
 * instead of being its own standalone exported function. Per the Phase-3
 * dispatch: BPCL must be verified via unit tests/fixtures only, never a
 * live call to api.cep.bpcl.in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderContext, WorkUnit } from "../provider.js";
import { createBpclProvider, subdivide, type Cell } from "./bpcl-provider.js";

function samplePointOfService(roId: string, lat = 12.9716, lng = 77.5946) {
  return {
    roId,
    displayName: `BPCL Outlet ${roId}`,
    telephone: "080-1234567",
    geoPoint: { latitude: lat, longitude: lng },
    address: { formattedAddress: "MG Road", town: "BANGALORE", postalCode: "560001", region: { name: "Karnataka" } },
    weekDayFuelPriceList: [
      { code: "PETROL", displayName: "Petrol", price: 102.5 },
      { code: "DIESEL", displayName: "Diesel", price: 95.1 },
      { code: "SPEED100", displayName: "SPEED 100 BS VI", price: 168.2 },
    ],
  };
}

interface MockCall {
  url: string;
  opts?: { method?: string; headers?: Record<string, string>; body?: string };
}

function makeCtx(
  handler: (call: MockCall) => { status?: number; body: unknown },
  calls: MockCall[] = [],
): ProviderContext {
  return {
    now: () => "2026-07-19T00:00:00.000Z",
    fetch: (async (url: string, opts?: MockCall["opts"]) => {
      calls.push({ url: url.toString(), opts });
      const { status = 200, body } = handler({ url: url.toString(), opts });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    }) as ProviderContext["fetch"],
  };
}

const TOKEN_RESPONSE = { access_token: "tok-1", expires_in: 3600 };

describe("createBpclProvider().init", () => {
  it("fetches an access token up front, failing fast on a broken token endpoint", async () => {
    const ctx = makeCtx((call) => {
      if (call.url.includes("/oauth/token")) return { body: TOKEN_RESPONSE };
      throw new Error("unexpected call");
    });
    const provider = createBpclProvider({});
    await expect(provider.init!(ctx)).resolves.toBeUndefined();
  });

  it("throws when the token endpoint fails", async () => {
    const ctx = makeCtx(() => ({ status: 500, body: {} }));
    const provider = createBpclProvider({});
    await expect(provider.init!(ctx)).rejects.toThrow();
  });
});

describe("createBpclProvider().discover", () => {
  it("yields route-chunk units and grid-cell units, both with collision-free ids", async () => {
    const provider = createBpclProvider({ bounds: { minLat: 12, maxLat: 13, minLng: 77, maxLng: 78 } });
    const units: WorkUnit[] = [];
    for await (const u of provider.discover({})) units.push(u);

    expect(units.length).toBeGreaterThan(0);
    const ids = units.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length); // no collisions
    expect(units.some((u) => (u.payload as { kind: string }).kind === "route")).toBe(true);
    expect(units.some((u) => (u.payload as { kind: string }).kind === "cell")).toBe(true);
  });

  it("skipRoutes/skipGrid (config) omit the corresponding unit kind entirely", async () => {
    const routesOnly = createBpclProvider({ bounds: { minLat: 12, maxLat: 13, minLng: 77, maxLng: 78 }, skipGrid: true });
    const routesOnlyUnits: WorkUnit[] = [];
    for await (const u of routesOnly.discover({})) routesOnlyUnits.push(u);
    expect(routesOnlyUnits.every((u) => (u.payload as { kind: string }).kind === "route")).toBe(true);
    expect(routesOnlyUnits.length).toBeGreaterThan(0);

    const gridOnly = createBpclProvider({ bounds: { minLat: 12, maxLat: 13, minLng: 77, maxLng: 78 }, skipRoutes: true });
    const gridOnlyUnits: WorkUnit[] = [];
    for await (const u of gridOnly.discover({})) gridOnlyUnits.push(u);
    expect(gridOnlyUnits.every((u) => (u.payload as { kind: string }).kind === "cell")).toBe(true);
    expect(gridOnlyUnits.length).toBeGreaterThan(0);
  });

  it("discover(opts) overrides config's skipRoutes/skipGrid", async () => {
    const provider = createBpclProvider({ bounds: { minLat: 12, maxLat: 13, minLng: 77, maxLng: 78 } });
    const units: WorkUnit[] = [];
    for await (const u of provider.discover({ skipGrid: "1" })) units.push(u);
    expect(units.every((u) => (u.payload as { kind: string }).kind === "route")).toBe(true);
  });
});

describe("createBpclProvider().process", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ok: a route chunk returning outlets yields grade-agnostic RawOutletRecords (grades from parsePointOfService are ignored; products come straight from weekDayFuelPriceList)", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bpcl-provider-test-"));
    const provider = createBpclProvider({});
    const ctx = makeCtx((call) => {
      if (call.url.includes("/oauth/token")) return { body: TOKEN_RESPONSE };
      if (call.url.includes("rolocator/route")) return { body: { pointOfServices: [samplePointOfService("RO1")] } };
      throw new Error(`unexpected call: ${call.url}`);
    });
    await provider.init!(ctx);

    const routeUnits: WorkUnit[] = [];
    for await (const u of provider.discover({ skipGrid: "1" })) routeUnits.push(u);
    const result = await provider.process(routeUnits[0]!, ctx);

    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.brand).toBe("BPCL");
    expect(record.outletId).toBe("RO1");
    const names = record.products.map((p) => p.name).sort();
    expect(names).toEqual(["Diesel", "Petrol", "SPEED 100 BS VI"].sort());
    // Raw capture keeps the BS-suffix verbatim — normalization/grade
    // assignment is explicitly grade-assign.ts's job, not this provider's.
    expect(record.products.find((p) => p.name === "SPEED 100 BS VI")?.priceInr).toBe(168.2);
  });

  it("empty: a 404 NoDataFoundError response is a legitimate zero-result success, not a failure", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bpcl-provider-test-"));
    const provider = createBpclProvider({});
    const ctx = makeCtx((call) => {
      if (call.url.includes("/oauth/token")) return { body: TOKEN_RESPONSE };
      return { status: 404, body: { errors: [{ type: "NoDataFoundError" }] } };
    });
    await provider.init!(ctx);

    const cellUnit: WorkUnit = { id: "d0:1:1:1", payload: { kind: "cell", cell: { cellId: "d0:1:1:1", lat: 1, lng: 1, radiusM: 75000, spacingKm: 100, depth: 0 } as Cell } };
    const result = await provider.process(cellUnit, ctx);
    expect(result.status).toBe("empty");
    expect(result.records).toEqual([]);
    expect(result.saturated).toBe(false);
  });

  it("saturation: a cell returning >= 100 outlets is subdivided into 4 followup cells at depth+1", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bpcl-provider-test-"));
    const provider = createBpclProvider({ maxDepth: 4 });
    const hundredOutlets = Array.from({ length: 100 }, (_, i) => samplePointOfService(`RO${i}`));
    const ctx = makeCtx((call) => {
      if (call.url.includes("/oauth/token")) return { body: TOKEN_RESPONSE };
      return { body: { pointOfServices: hundredOutlets } };
    });
    await provider.init!(ctx);

    const cell: Cell = { cellId: "d0:12.00000:77.00000:75000", lat: 12, lng: 77, radiusM: 75000, spacingKm: 100, depth: 0 };
    const result = await provider.process({ id: cell.cellId, payload: { kind: "cell", cell } }, ctx);

    expect(result.status).toBe("ok");
    expect(result.saturated).toBe(true);
    expect(result.followups).toHaveLength(4);
    const expectedChildren = subdivide(cell).map((c) => c.cellId).sort();
    expect(result.followups!.map((f) => f.id).sort()).toEqual(expectedChildren);
  });

  it("does NOT subdivide past maxDepth (still saturated, but no followups)", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bpcl-provider-test-"));
    const provider = createBpclProvider({ maxDepth: 0 });
    const hundredOutlets = Array.from({ length: 100 }, (_, i) => samplePointOfService(`RO${i}`));
    const ctx = makeCtx((call) => {
      if (call.url.includes("/oauth/token")) return { body: TOKEN_RESPONSE };
      return { body: { pointOfServices: hundredOutlets } };
    });
    await provider.init!(ctx);

    const cell: Cell = { cellId: "d0:12.00000:77.00000:75000", lat: 12, lng: 77, radiusM: 75000, spacingKm: 100, depth: 0 };
    const result = await provider.process({ id: cell.cellId, payload: { kind: "cell", cell } }, ctx);
    expect(result.saturated).toBe(true);
    expect(result.followups ?? []).toEqual([]);
  });

  it("401 mid-crawl triggers exactly one token refresh + retry of the same unit", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bpcl-provider-test-"));
    const provider = createBpclProvider({});
    let tokenCalls = 0;
    const calls: MockCall[] = [];
    const ctx = makeCtx((call) => {
      if (call.url.includes("/oauth/token")) {
        tokenCalls++;
        return { body: { access_token: `tok-${tokenCalls}`, expires_in: 3600 } };
      }
      const authHeader = call.opts?.headers?.Authorization;
      if (authHeader === "Bearer tok-1") return { status: 401, body: {} };
      return { body: { pointOfServices: [samplePointOfService("RO-retry")] } };
    }, calls);
    await provider.init!(ctx);
    expect(tokenCalls).toBe(1);

    const cell: Cell = { cellId: "d0:12.00000:77.00000:75000", lat: 12, lng: 77, radiusM: 75000, spacingKm: 100, depth: 0 };
    const result = await provider.process({ id: cell.cellId, payload: { kind: "cell", cell } }, ctx);

    expect(tokenCalls).toBe(2); // one more refresh triggered by the 401
    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
  });

  it("httpFailed: a real (non-NoDataFound) HTTP failure is reported and NOT treated as done", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bpcl-provider-test-"));
    const provider = createBpclProvider({});
    const ctx = makeCtx((call) => {
      if (call.url.includes("/oauth/token")) return { body: TOKEN_RESPONSE };
      return { status: 500, body: {} };
    });
    await provider.init!(ctx);

    const cell: Cell = { cellId: "d0:12.00000:77.00000:75000", lat: 12, lng: 77, radiusM: 75000, spacingKm: 100, depth: 0 };
    const result = await provider.process({ id: cell.cellId, payload: { kind: "cell", cell } }, ctx);
    expect(result.status).toBe("httpFailed");
    expect(result.records).toEqual([]);
  });

  it("never throws: an exception during processing is caught and reported as errored", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "bpcl-provider-test-"));
    const provider = createBpclProvider({});
    const ctx: ProviderContext = {
      now: () => "2026-07-19T00:00:00.000Z",
      fetch: (async () => {
        throw new Error("network exploded");
      }) as ProviderContext["fetch"],
    };

    const cell: Cell = { cellId: "d0:12.00000:77.00000:75000", lat: 12, lng: 77, radiusM: 75000, spacingKm: 100, depth: 0 };
    const result = await provider.process({ id: cell.cellId, payload: { kind: "cell", cell } }, ctx);
    expect(result.status).toBe("errored");
    expect(result.detail).toContain("network exploded");
  });
});
