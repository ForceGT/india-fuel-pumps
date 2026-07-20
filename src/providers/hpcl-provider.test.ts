/**
 * Unit tests for the HPCL Provider's `process()` — verifies the ported
 * `scrapeOne` logic (page fetch -> parse -> price-fragment fetch -> build a
 * grade-agnostic RawOutletRecord) against the SAME real HTML fixtures
 * hpcl.test.ts/hpcl-price.test.ts already use, via a mocked `ctx.fetch` (no
 * real network call). `discover()` isn't exercised against the real
 * sitemap here (that needs Phase A's own fixture set); the HPCL live smoke
 * test (HPCL_CENSUS_LIMIT=5) is what proves discover()+process() work
 * end-to-end against the real site.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderContext } from "../provider.js";
import { createHpclProvider } from "./hpcl-provider.js";

function loadFixture(brand: "hpcl", name: string): string {
  return readFileSync(fileURLToPath(new URL(`../parsers/__fixtures__/${brand}/${name}`, import.meta.url)), "utf-8");
}

const OUTLET_97365_URL =
  "https://petrolpump.hpretail.in/hindustan-petroleum-corporation-limited-angra-hp-centre-compressed-natural-gas-station-chanakyapuri-new-delhi-97365/Home";
const PRICE_97365_URL = "https://petrolpump.hpretail.in/getPetrolPricesForHPCL.php?master_outlet_id=96681&outlet_id=97365";

const LEH_398563_PRICE_URL = "https://petrolpump.hpretail.in/getPetrolPricesForHPCL.php?master_outlet_id=96681&outlet_id=398563";

function makeCtx(responses: Record<string, { status?: number; body: string }>): ProviderContext {
  return {
    now: () => "2026-07-19T00:00:00.000Z",
    fetch: (async (url: string) => {
      const key = url.toString();
      const entry = responses[key];
      if (!entry) throw new Error(`unexpected fetch in test: ${key}`);
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

describe("createHpclProvider().process", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ok: builds a grade-agnostic RawOutletRecord from a real E0 (Power 100) outlet's page + price fragment", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "hpcl-provider-test-"));
    const provider = createHpclProvider({ outputDir: tmpDir });
    const ctx = makeCtx({
      [OUTLET_97365_URL]: { body: loadFixture("hpcl", "97365.html") },
      [PRICE_97365_URL]: { body: loadFixture("hpcl", "price-97365.html") },
    });

    const result = await provider.process({ id: OUTLET_97365_URL, payload: OUTLET_97365_URL }, ctx);

    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.brand).toBe("HPCL");
    expect(record.outletId).toBe("97365");
    expect(record.sourceUrl).toBe(OUTLET_97365_URL);
    // Every product the fragment reported, not just Power 100 — grade
    // assignment is explicitly NOT this module's job (see grade-assign.ts).
    const names = record.products.map((p) => p.name).sort();
    expect(names).toEqual(["Diesel", "Petrol", "Power 100", "Power 99", "Power95", "TurboJet"].sort());
    const power100 = record.products.find((p) => p.name === "Power 100");
    expect(power100?.priceInr).toBe(167.4);
  });

  it("ok (no E0 signal): a remote Leh outlet's fragment has no Power 100 card — still 'ok', products just lack it (grade decision deferred to grade-assign.ts, not made here)", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "hpcl-provider-test-"));
    const provider = createHpclProvider({ outputDir: tmpDir });
    const lehUrl = "https://petrolpump.hpretail.in/some-leh-outlet-398563/Home";
    const ctx = makeCtx({
      // Reuses the real 97365 GasStation page fixture — parseOutletHtml
      // extracts outletId from the URL (preferred over html), so the page
      // body itself doesn't need to mention "398563" for this test.
      [lehUrl]: { body: loadFixture("hpcl", "97365.html") },
      [LEH_398563_PRICE_URL]: {
        body: loadFixture("hpcl", "price-398563.html"),
      },
    });

    const result = await provider.process({ id: lehUrl, payload: lehUrl }, ctx);
    expect(result.status).toBe("ok");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.products.some((p) => p.name === "Power 100")).toBe(false);
  });

  it("httpFailed: page fetch returns non-OK", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "hpcl-provider-test-"));
    const provider = createHpclProvider({ outputDir: tmpDir });
    const ctx = makeCtx({ [OUTLET_97365_URL]: { status: 503, body: "" } });

    const result = await provider.process({ id: OUTLET_97365_URL, payload: OUTLET_97365_URL }, ctx);
    expect(result.status).toBe("httpFailed");
    expect(result.records).toEqual([]);
  });

  it("parsedNull: page has no GasStation JSON-LD", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "hpcl-provider-test-"));
    const provider = createHpclProvider({ outputDir: tmpDir });
    const ctx = makeCtx({ [OUTLET_97365_URL]: { body: "<html><body>not a real outlet page</body></html>" } });

    const result = await provider.process({ id: OUTLET_97365_URL, payload: OUTLET_97365_URL }, ctx);
    expect(result.status).toBe("parsedNull");
    expect(result.records).toEqual([]);
  });

  it("errored (price fetch failed): page ok, price endpoint fails", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "hpcl-provider-test-"));
    const provider = createHpclProvider({ outputDir: tmpDir });
    const ctx = makeCtx({
      [OUTLET_97365_URL]: { body: loadFixture("hpcl", "97365.html") },
      [PRICE_97365_URL]: { status: 500, body: "" },
    });

    const result = await provider.process({ id: OUTLET_97365_URL, payload: OUTLET_97365_URL }, ctx);
    expect(result.status).toBe("errored");
    expect(result.detail).toContain("priceFailed");
    expect(result.records).toEqual([]);
  });

  it("never throws: a fetch implementation that throws is caught and reported as errored", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "hpcl-provider-test-"));
    const provider = createHpclProvider({ outputDir: tmpDir });
    const ctx: ProviderContext = {
      now: () => "2026-07-19T00:00:00.000Z",
      fetch: (async () => {
        throw new Error("network exploded");
      }) as ProviderContext["fetch"],
    };

    const result = await provider.process({ id: OUTLET_97365_URL, payload: OUTLET_97365_URL }, ctx);
    expect(result.status).toBe("errored");
    expect(result.detail).toContain("network exploded");
  });
});
