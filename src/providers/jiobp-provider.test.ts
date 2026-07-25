/**
 * Unit tests for the Jio-bp Provider's `process()` and `discover()` methods.
 * Tests the two-call shape: discover() fetches the ROMaster index, yields
 * batches of station codes as WorkUnits, then process() calls FindFuelStation
 * for each batch and builds grade-agnostic RawOutletRecords from the response.
 * State is carried from the ROMaster index via the unit's payload, not from
 * the FindFuelStation response (which doesn't include it).
 */
import { describe, expect, it } from "vitest";
import type { ProviderContext, WorkUnit } from "../provider.js";
import { createJiobpProvider } from "./jiobp-provider.js";
import { makeStationId } from "../id.js";
import { JIOBP_ENDPOINT } from "../parsers/jiobp.js";

/**
 * Helper to build a ProviderContext with body-based fetch mocking.
 * Since Jio-bp only POSTs to one endpoint, we match on the request body
 * string (JSON-stringified) rather than URL.
 */
function makeCtx(
  bodyMatchers: { match: (body: string) => boolean; status?: number; json: unknown }[]
): ProviderContext {
  return {
    now: () => "2026-07-25T00:00:00.000Z",
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const entry = bodyMatchers.find((m) => m.match(body));
      if (!entry) throw new Error(`unexpected fetch body in test: ${body.slice(0, 200)}`);
      const status = entry.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => entry.json,
      } as unknown as Response;
    }) as ProviderContext["fetch"],
  };
}

describe("createJiobpProvider().process", () => {
  it("ok: builds grade-agnostic RawOutletRecords from a batch response, using state from the unit's stateByCode", async () => {
    const provider = createJiobpProvider();
    const unit: WorkUnit = {
      id: "batch-0",
      payload: {
        codes: ["MHC117"],
        stateByCode: { MHC117: "Maharashtra" },
      },
    };

    const ctx = makeCtx([
      {
        match: (body) => body.includes('"FuelStationCode":"MHC117"'),
        json: {
          CustomerResponse: {
            FuelStation: {
              FindFuelStation: {
                ResponseFlag: "S",
                FuelStations: [
                  {
                    FuelStationCode: "MHC117",
                    FuelStationName: "PALM BEACH",
                    ContactNumber: "9930505541",
                    Address: "PLOT NO 7, SECTOR 18, Sanpada, Navi Mumbai, Maharashtra 400706",
                    Lattitude: "19.05508168",
                    Longitude: "73.00673056",
                    HistoryFuelProducts: [
                      {
                        ProductName: "Petrol",
                        PriceDetails: [{ ProductPrice: "     111.28", PriceDate: "05-07-2026 06:00:00" }],
                      },
                      {
                        ProductName: "Diesel",
                        PriceDetails: [{ ProductPrice: "      97.90", PriceDate: "25-05-2026 07:44:00" }],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    ]);

    const result = await provider.process(unit, ctx);

    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);

    const record = result.records[0]!;
    expect(record.brand).toBe("JioBP");
    expect(record.outletId).toBe("MHC117");
    expect(record.name).toBe("PALM BEACH");
    expect(record.contact).toBe("9930505541");
    expect(record.state).toBe("Maharashtra");
    expect(record.lat).toBe(19.05508168);
    expect(record.lng).toBe(73.00673056);
    expect(record.sourceUrl).toBe(JIOBP_ENDPOINT);
    expect(record.capturedAt).toBe("2026-07-25T00:00:00.000Z");
    expect(record.geohash).toBeTruthy();
    expect(typeof record.geohash).toBe("string");
    expect(record.geohash.length).toBeGreaterThan(0);

    // Verify products (order-independent comparison).
    const productNames = record.products.map((p) => p.name).sort();
    expect(productNames).toEqual(["Diesel", "Petrol"]);

    const petrol = record.products.find((p) => p.name === "Petrol");
    expect(petrol?.priceInr).toBe(111.28);

    // Verify stationId is deterministic.
    const expectedId = await makeStationId({
      brand: "JioBP",
      outletId: "MHC117",
      lat: 19.05508168,
      lng: 73.00673056,
    });
    expect(record.stationId).toBe(expectedId);
  });

  it("state falls back to null when the code isn't in stateByCode", async () => {
    const provider = createJiobpProvider();
    const unit: WorkUnit = {
      id: "batch-0",
      payload: {
        codes: ["MHC117"],
        stateByCode: {}, // Empty — no state for MHC117
      },
    };

    const ctx = makeCtx([
      {
        match: (body) => body.includes('"FuelStationCode":"MHC117"'),
        json: {
          CustomerResponse: {
            FuelStation: {
              FindFuelStation: {
                ResponseFlag: "S",
                FuelStations: [
                  {
                    FuelStationCode: "MHC117",
                    FuelStationName: "PALM BEACH",
                    ContactNumber: "9930505541",
                    Address: "PLOT NO 7, SECTOR 18, Sanpada, Navi Mumbai, Maharashtra 400706",
                    Lattitude: "19.05508168",
                    Longitude: "73.00673056",
                    HistoryFuelProducts: [
                      {
                        ProductName: "Petrol",
                        PriceDetails: [{ ProductPrice: "111.28", PriceDate: "05-07-2026 06:00:00" }],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    ]);

    const result = await provider.process(unit, ctx);

    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.state).toBe(null);
  });

  it("empty: FindFuelStation returns zero stations", async () => {
    const provider = createJiobpProvider();
    const unit: WorkUnit = {
      id: "batch-0",
      payload: {
        codes: ["NONEXISTENT"],
        stateByCode: { NONEXISTENT: "SomeState" },
      },
    };

    const ctx = makeCtx([
      {
        match: (body) => body.includes('"FuelStationCode":"NONEXISTENT"'),
        json: {
          CustomerResponse: {
            FuelStation: {
              FindFuelStation: {
                ResponseFlag: "S",
                FuelStations: [],
              },
            },
          },
        },
      },
    ]);

    const result = await provider.process(unit, ctx);

    expect(result.status).toBe("empty");
    expect(result.records).toEqual([]);
  });

  it("httpFailed: non-OK response", async () => {
    const provider = createJiobpProvider();
    const unit: WorkUnit = {
      id: "batch-0",
      payload: {
        codes: ["MHC117"],
        stateByCode: { MHC117: "Maharashtra" },
      },
    };

    const ctx = makeCtx([
      {
        match: (body) => body.includes('"FuelStationCode":"MHC117"'),
        status: 500,
        json: {},
      },
    ]);

    const result = await provider.process(unit, ctx);

    expect(result.status).toBe("httpFailed");
    expect(result.records).toEqual([]);
  });

  it("parsedNull: a non-success ResponseFlag with an empty FuelStations array is retried, not treated as done", async () => {
    const provider = createJiobpProvider();
    const unit: WorkUnit = {
      id: "batch-MHC117",
      payload: { codes: ["MHC117"], stateByCode: { MHC117: "Maharashtra" } },
    };

    const ctx = makeCtx([
      {
        match: (body) => body.includes('"FuelStationCode":"MHC117"'),
        json: { ResponseFlag: "E", ResponseMsg: "An error occurred while processing" },
      },
    ]);

    const result = await provider.process(unit, ctx);

    expect(result.status).toBe("parsedNull");
    expect(result.records).toEqual([]);
  });

  it("errored: ctx.fetch throws", async () => {
    const provider = createJiobpProvider();
    const unit: WorkUnit = {
      id: "batch-0",
      payload: {
        codes: ["MHC117"],
        stateByCode: { MHC117: "Maharashtra" },
      },
    };

    const ctx: ProviderContext = {
      now: () => "2026-07-25T00:00:00.000Z",
      fetch: (async () => {
        throw new Error("network exploded");
      }) as ProviderContext["fetch"],
    };

    const result = await provider.process(unit, ctx);

    expect(result.status).toBe("errored");
    expect(result.detail).toContain("network exploded");
    expect(result.records).toEqual([]);
  });

  it("a batch with multiple codes produces multiple records", async () => {
    const provider = createJiobpProvider();
    const unit: WorkUnit = {
      id: "batch-0",
      payload: {
        codes: ["AAA001", "BBB002"],
        stateByCode: { AAA001: "StateA", BBB002: "StateB" },
      },
    };

    const ctx = makeCtx([
      {
        match: (body) => body.includes('"FuelStationCode":"AAA001"') && body.includes('"FuelStationCode":"BBB002"'),
        json: {
          CustomerResponse: {
            FuelStation: {
              FindFuelStation: {
                ResponseFlag: "S",
                FuelStations: [
                  {
                    FuelStationCode: "AAA001",
                    FuelStationName: "Station A",
                    ContactNumber: "9111111111",
                    Address: "Address A",
                    Lattitude: "10.0",
                    Longitude: "20.0",
                    HistoryFuelProducts: [
                      {
                        ProductName: "Petrol",
                        PriceDetails: [{ ProductPrice: "100.00", PriceDate: "25-07-2026 00:00:00" }],
                      },
                    ],
                  },
                  {
                    FuelStationCode: "BBB002",
                    FuelStationName: "Station B",
                    ContactNumber: "9222222222",
                    Address: "Address B",
                    Lattitude: "30.0",
                    Longitude: "40.0",
                    HistoryFuelProducts: [
                      {
                        ProductName: "Diesel",
                        PriceDetails: [{ ProductPrice: "85.00", PriceDate: "25-07-2026 00:00:00" }],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    ]);

    const result = await provider.process(unit, ctx);

    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(2);

    const outletIds = result.records.map((r) => r.outletId).sort();
    expect(outletIds).toEqual(["AAA001", "BBB002"]);

    const recordA = result.records.find((r) => r.outletId === "AAA001")!;
    expect(recordA.state).toBe("StateA");

    const recordB = result.records.find((r) => r.outletId === "BBB002")!;
    expect(recordB.state).toBe("StateB");
  });
});

describe("createJiobpProvider().discover", () => {
  it("batches station codes from the ROMaster index by batchSize, carrying each entry's state into the batch payload", async () => {
    const mockROMasterResponse = {
      CustomerResponse: {
        MasterData: {
          FetchROMaster: {
            ROMasterData: [
              { FuelStationCode: "A1", Lattitude: "1", Longitude: "1", State: "S1" },
              { FuelStationCode: "A2", Lattitude: "2", Longitude: "2", State: "S2" },
              { FuelStationCode: "A3", Lattitude: "3", Longitude: "3", State: "S3" },
            ],
          },
        },
      },
    };

    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => mockROMasterResponse,
    })) as unknown as typeof fetch;

    const provider = createJiobpProvider({ batchSize: 2, fetchImpl: mockFetch });

    const units: WorkUnit[] = [];
    for await (const unit of provider.discover({})) {
      units.push(unit);
    }

    expect(units).toHaveLength(2);

    // First batch: A1 and A2
    expect(units[0]!.payload).toEqual({
      codes: ["A1", "A2"],
      stateByCode: { A1: "S1", A2: "S2" },
    });

    // Second batch: A3
    expect(units[1]!.payload).toEqual({
      codes: ["A3"],
      stateByCode: { A3: "S3" },
    });

    // Unit IDs should be distinct
    expect(units[0]!.id).not.toBe(units[1]!.id);
    expect(typeof units[0]!.id).toBe("string");
    expect(units[0]!.id.length).toBeGreaterThan(0);
    expect(typeof units[1]!.id).toBe("string");
    expect(units[1]!.id.length).toBeGreaterThan(0);
  });

  it("discover() throws if the ROMaster fetch fails (so a broken discovery call fails the job loudly instead of silently scraping nothing)", async () => {
    const mockFetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const provider = createJiobpProvider({ fetchImpl: mockFetch });

    await expect(async () => {
      const units: WorkUnit[] = [];
      for await (const unit of provider.discover({})) units.push(unit);
    }).rejects.toThrow();
  });
});
