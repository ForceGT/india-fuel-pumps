/**
 * Unit tests for the IOCL Provider's `process()` — mirrors
 * hpcl-provider.test.ts, verifying the ported `scrapeOne` logic against
 * real IOCL HTML fixtures via a mocked `ctx.fetch`. Deliberately NO live
 * network call anywhere in this file — per the Phase-3 dispatch, IOCL must
 * be verified via fixtures/unit tests only (locator.iocl.com is presently
 * WAF-sensitive to concurrent load; see docs/research/iocl-waf-calibration.md).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderContext } from "../provider.js";
import { createIoclProvider } from "./iocl-provider.js";

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../parsers/__fixtures__/iocl/${name}`, import.meta.url)), "utf-8");
}

const OUTLET_102595_URL = "https://locator.iocl.com/indianoil-car-care-petrol-pump-rk-puram-sector-8-new-delhi-102595/Home";
const PRICE_102595_URL = "https://locator.iocl.com/getPetrolPricesForIOCL.php?master_outlet_id=99528&outlet_id=102595";
const PRICE_237882_URL = "https://locator.iocl.com/getPetrolPricesForIOCL.php?master_outlet_id=99528&outlet_id=237882";

function makeCtx(responses: Record<string, { status?: number; body: string }>): ProviderContext {
  return {
    now: () => "2026-07-19T00:00:00.000Z",
    fetch: (async (url: string) => {
      const entry = responses[url.toString()];
      if (!entry) throw new Error(`unexpected fetch in test: ${url}`);
      const status = entry.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => entry.body,
        json: async () => JSON.parse(entry.body),
      } as unknown as Response;
    }) as ProviderContext["fetch"],
  };
}

describe("createIoclProvider().process", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ok: builds a grade-agnostic RawOutletRecord from a real E0 (XP100) outlet's page + price fragment", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "iocl-provider-test-"));
    const provider = createIoclProvider({ outputDir: tmpDir });
    const ctx = makeCtx({
      [OUTLET_102595_URL]: { body: loadFixture("102595.html") },
      [PRICE_102595_URL]: { body: loadFixture("price-102595.html") },
    });

    const result = await provider.process({ id: OUTLET_102595_URL, payload: OUTLET_102595_URL }, ctx);

    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.brand).toBe("IOCL");
    expect(record.outletId).toBe("102595");
    const names = record.products.map((p) => p.name).sort();
    expect(names).toEqual(["Diesel", "Petrol", "XP100", "XP95"].sort());
    expect(record.products.find((p) => p.name === "XP100")?.priceInr).toBe(167.35);
  });

  it("ok (no E0 signal): a remote Leh outlet's fragment has only Petrol/Diesel — no XP100 card, grade decision deferred to grade-assign.ts", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "iocl-provider-test-"));
    const provider = createIoclProvider({ outputDir: tmpDir });
    const lehUrl = "https://locator.iocl.com/some-leh-outlet-237882/Home";
    const ctx = makeCtx({
      // Reuses the real 102595 GasStation page fixture — parseOutletHtml
      // extracts outletId from the URL, so the html body doesn't need to
      // mention "237882" for this test.
      [lehUrl]: { body: loadFixture("102595.html") },
      [PRICE_237882_URL]: { body: loadFixture("price-237882.html") },
    });

    const result = await provider.process({ id: lehUrl, payload: lehUrl }, ctx);
    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.products.some((p) => p.name === "XP100")).toBe(false);
  });

  it("httpFailed: page fetch returns non-OK", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "iocl-provider-test-"));
    const provider = createIoclProvider({ outputDir: tmpDir });
    const ctx = makeCtx({ [OUTLET_102595_URL]: { status: 503, body: "" } });

    const result = await provider.process({ id: OUTLET_102595_URL, payload: OUTLET_102595_URL }, ctx);
    expect(result.status).toBe("httpFailed");
    expect(result.records).toEqual([]);
  });

  it("parsedNull: stale/redirected page with no GasStation JSON-LD (e.g. error.html slug drift)", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "iocl-provider-test-"));
    const provider = createIoclProvider({ outputDir: tmpDir });
    const ctx = makeCtx({ [OUTLET_102595_URL]: { body: "<html><body>Error</body></html>" } });

    const result = await provider.process({ id: OUTLET_102595_URL, payload: OUTLET_102595_URL }, ctx);
    expect(result.status).toBe("parsedNull");
    expect(result.records).toEqual([]);
  });

  it("errored (price fetch failed): page ok, price endpoint fails", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "iocl-provider-test-"));
    const provider = createIoclProvider({ outputDir: tmpDir });
    const ctx = makeCtx({
      [OUTLET_102595_URL]: { body: loadFixture("102595.html") },
      [PRICE_102595_URL]: { status: 500, body: "" },
    });

    const result = await provider.process({ id: OUTLET_102595_URL, payload: OUTLET_102595_URL }, ctx);
    expect(result.status).toBe("errored");
    expect(result.detail).toContain("priceFailed");
    expect(result.records).toEqual([]);
  });
});
