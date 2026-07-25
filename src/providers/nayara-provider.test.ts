import { describe, expect, it } from "vitest";
import type { ProviderContext, WorkUnit } from "../provider.js";
import { createNayaraProvider } from "./nayara-provider.js";
import { makeStationId } from "../id.js";
import { NAYARA_LOCATOR_PAGE_URL, NAYARA_RADIUS_ENDPOINT } from "../parsers/nayara.js";

const VALID_HTML = `<html><head><meta name="csrf-token" content="test-csrf-token"></head></html>`;
const VALID_SET_COOKIE = ["laravel_session=sess1; path=/", "XSRF-TOKEN=xsrf1; path=/"];

interface MockOptions {
  bootstrap?: { status?: number; html?: string; setCookie?: string[] };
  /** One entry per successive POST call to the radius endpoint (last entry repeats if more calls happen than entries). */
  radiusResponses?: { status?: number; json?: unknown }[];
}

function makeCtx(opts: MockOptions = {}): ProviderContext {
  let radiusCallCount = 0;
  return {
    now: () => "2026-07-25T00:00:00.000Z",
    fetch: (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url === NAYARA_LOCATOR_PAGE_URL) {
        const status = opts.bootstrap?.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => opts.bootstrap?.html ?? VALID_HTML,
          headers: {
            getSetCookie: () => opts.bootstrap?.setCookie ?? VALID_SET_COOKIE,
            get: (_name: string) => null,
          },
        } as unknown as Response;
      }
      if (method === "POST" && url === NAYARA_RADIUS_ENDPOINT) {
        const responses = opts.radiusResponses ?? [{ status: 200, json: [] }];
        const entry = responses[radiusCallCount] ?? responses[responses.length - 1]!;
        radiusCallCount++;
        const status = entry.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => entry.json ?? [],
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }) as ProviderContext["fetch"],
  };
}

describe("createNayaraProvider().discover", () => {
  it("yields exactly two center-point WorkUnits with the default radius, no network calls", async () => {
    const provider = createNayaraProvider();
    const units: WorkUnit[] = [];
    for await (const unit of provider.discover({})) {
      units.push(unit);
    }
    expect(units).toHaveLength(2);
    expect(units[0]!.payload).toMatchObject({ radiusKm: 3000 });
    expect(units[1]!.payload).toMatchObject({ radiusKm: 3000 });
    expect(units[0]!.id).not.toBe(units[1]!.id);
  });

  it("honors a custom centerPoints/radiusKm config", async () => {
    const provider = createNayaraProvider({
      centerPoints: [{ id: "custom-1", lat: 1, lng: 2 }],
      radiusKm: 500,
    });
    const units: WorkUnit[] = [];
    for await (const unit of provider.discover({})) {
      units.push(unit);
    }
    expect(units).toEqual([{ id: "custom-1", payload: { lat: 1, lng: 2, radiusKm: 500 } }]);
  });
});

describe("createNayaraProvider().init", () => {
  it("bootstraps a session successfully from a valid locator page response", async () => {
    const provider = createNayaraProvider();
    const ctx = makeCtx();
    await expect(provider.init!(ctx)).resolves.toBeUndefined();
  });

  it("throws when the csrf token / cookies are missing from the bootstrap response", async () => {
    const provider = createNayaraProvider();
    const ctx = makeCtx({ bootstrap: { html: "<html><head></head></html>", setCookie: [] } });
    await expect(provider.init!(ctx)).rejects.toThrow();
  });

  it("throws when the bootstrap GET itself fails", async () => {
    const provider = createNayaraProvider();
    const ctx = makeCtx({ bootstrap: { status: 500 } });
    await expect(provider.init!(ctx)).rejects.toThrow();
  });
});

describe("createNayaraProvider().process", () => {
  it("ok: builds grade-agnostic RawOutletRecords from a radius response, after init()", async () => {
    const provider = createNayaraProvider();
    const ctx = makeCtx({
      radiusResponses: [
        {
          status: 200,
          json: [
            {
              ro_name: "Auto Pushp",
              cms_code: "45839TA839",
              address: "Survey no.56, Bhandup, Mumbai, Maharashtra",
              latitude: "19.162741",
              longitude: "72.941088",
              PETROL: "122.7",
              DIESEL: "106.03",
            },
          ],
        },
      ],
    });
    await provider.init!(ctx);

    const unit: WorkUnit = { id: "center-1", payload: { lat: 23.2599, lng: 77.4126, radiusKm: 3000 } };
    const result = await provider.process(unit, ctx);

    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);

    const record = result.records[0]!;
    expect(record.brand).toBe("Nayara");
    expect(record.outletId).toBe("45839TA839");
    expect(record.name).toBe("Auto Pushp");
    expect(record.lat).toBe(19.162741);
    expect(record.lng).toBe(72.941088);
    expect(record.sourceUrl).toBe(NAYARA_RADIUS_ENDPOINT);
    expect(record.capturedAt).toBe("2026-07-25T00:00:00.000Z");
    expect(record.contact).toBeNull();
    expect(record.hours).toBeNull();
    expect(record.pincode).toBeNull();
    expect(record.state).toBeNull();
    expect(record.city).toBeNull();
    expect(record.geohash).toBeTruthy();

    const productNames = record.products.map((p) => p.name).sort();
    expect(productNames).toEqual(["DIESEL", "PETROL"]);
    const petrol = record.products.find((p) => p.name === "PETROL");
    expect(petrol?.priceInr).toBe(122.7);

    const expectedId = await makeStationId({ brand: "Nayara", outletId: "45839TA839", lat: 19.162741, lng: 72.941088 });
    expect(record.stationId).toBe(expectedId);
  });

  it("lazily bootstraps a session in process() if init() was never called", async () => {
    const provider = createNayaraProvider();
    const ctx = makeCtx({ radiusResponses: [{ status: 200, json: [] }] });
    const unit: WorkUnit = { id: "center-1", payload: { lat: 1, lng: 2, radiusKm: 3000 } };
    const result = await provider.process(unit, ctx);
    expect(result.status).toBe("empty");
  });

  it("empty: radius response is an empty array", async () => {
    const provider = createNayaraProvider();
    const ctx = makeCtx({ radiusResponses: [{ status: 200, json: [] }] });
    await provider.init!(ctx);
    const unit: WorkUnit = { id: "center-1", payload: { lat: 1, lng: 2, radiusKm: 3000 } };
    const result = await provider.process(unit, ctx);
    expect(result.status).toBe("empty");
    expect(result.records).toEqual([]);
  });

  it("httpFailed: non-419 non-ok response", async () => {
    const provider = createNayaraProvider();
    const ctx = makeCtx({ radiusResponses: [{ status: 500, json: {} }] });
    await provider.init!(ctx);
    const unit: WorkUnit = { id: "center-1", payload: { lat: 1, lng: 2, radiusKm: 3000 } };
    const result = await provider.process(unit, ctx);
    expect(result.status).toBe("httpFailed");
    expect(result.records).toEqual([]);
  });

  it("419 (CSRF/session expiry): refreshes the session once and retries once, succeeding on retry", async () => {
    const provider = createNayaraProvider();
    const ctx = makeCtx({
      radiusResponses: [
        { status: 419, json: {} },
        { status: 200, json: [{ cms_code: "R1", latitude: "1", longitude: "2", PETROL: "100" }] },
      ],
    });
    await provider.init!(ctx);
    const unit: WorkUnit = { id: "center-1", payload: { lat: 1, lng: 2, radiusKm: 3000 } };
    const result = await provider.process(unit, ctx);
    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.outletId).toBe("R1");
  });

  it("errored: ctx.fetch throws", async () => {
    const provider = createNayaraProvider();
    const ctx: ProviderContext = {
      now: () => "2026-07-25T00:00:00.000Z",
      fetch: (async () => {
        throw new Error("network exploded");
      }) as ProviderContext["fetch"],
    };
    const unit: WorkUnit = { id: "center-1", payload: { lat: 1, lng: 2, radiusKm: 3000 } };
    const result = await provider.process(unit, ctx);
    expect(result.status).toBe("errored");
    expect(result.detail).toContain("network exploded");
    expect(result.records).toEqual([]);
  });
});
