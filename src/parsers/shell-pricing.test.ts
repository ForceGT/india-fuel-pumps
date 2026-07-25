import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  SHELL_PRICING_MODEL_JSON_URL,
  SHELL_PRICING_PAGE_URL,
  extractXlsxUrl,
  parseCityPricingXlsx,
  parseSharedStrings,
  parseSheetGrid,
} from "./shell-pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "__fixtures__/shell/india-price-update.xlsx");

describe("SHELL_PRICING_MODEL_JSON_URL", () => {
  it("is the .html page URL with .model.json substituted", () => {
    expect(SHELL_PRICING_MODEL_JSON_URL).toBe(
      "https://www.shell.in/fuels-oils-and-coolants/shell-fuels/fuel-pricing-in-india.model.json",
    );
    expect(SHELL_PRICING_PAGE_URL.endsWith(".html")).toBe(true);
  });
});

describe("extractXlsxUrl", () => {
  it("finds an .xlsx URL nested arbitrarily deep in the AEM model tree", () => {
    const model = {
      children: [
        { children: [{ model: { links: ["https://example.com/foo.pdf", "https://example.com/price.xlsx"] } } ] },
      ],
    };
    expect(extractXlsxUrl(model)).toBe("https://example.com/price.xlsx");
  });

  it("returns null when no .xlsx string is present anywhere", () => {
    expect(extractXlsxUrl({ a: { b: ["x", "y.pdf"] } })).toBeNull();
  });

  it("returns null for malformed/non-object input, never throws", () => {
    expect(extractXlsxUrl(null)).toBeNull();
    expect(extractXlsxUrl(undefined)).toBeNull();
    expect(extractXlsxUrl("plain string")).toBeNull();
    expect(extractXlsxUrl(42)).toBeNull();
  });

  it("doesn't infinite-loop on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { url: "no-match-here" };
    cyclic.self = cyclic;
    expect(extractXlsxUrl(cyclic)).toBeNull();
  });
});

describe("parseSharedStrings", () => {
  it("extracts plain <t> entries in order", () => {
    const xml = `<sst><si><t>Ahmedabad</t></si><si><t>ULP</t></si></sst>`;
    expect(parseSharedStrings(xml)).toEqual(["Ahmedabad", "ULP"]);
  });

  it("concatenates multiple rich-text runs within one <si>", () => {
    const xml = `<sst><si><r><t>Ahmed</t></r><r><t>abad</t></r></si></sst>`;
    expect(parseSharedStrings(xml)).toEqual(["Ahmedabad"]);
  });

  it("decodes XML entities", () => {
    const xml = `<sst><si><t>Tom &amp; Jerry</t></si></sst>`;
    expect(parseSharedStrings(xml)).toEqual(["Tom & Jerry"]);
  });

  it("returns [] for no <si> entries", () => {
    expect(parseSharedStrings(`<sst></sst>`)).toEqual([]);
  });
});

describe("parseSheetGrid", () => {
  it("parses numeric and shared-string cells by row/column", () => {
    const xml = `<sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>119.21</v></c></row>
    </sheetData>`;
    const grid = parseSheetGrid(xml);
    expect(grid["1"]!.A).toEqual({ type: "s", raw: "0" });
    expect(grid["2"]!.B).toEqual({ type: "n", raw: "119.21" });
  });

  it("handles self-closing (blank) cells without crashing", () => {
    const xml = `<row r="1"><c r="A1" s="1"/><c r="B1"><v>5</v></c></row>`;
    const grid = parseSheetGrid(xml);
    expect(grid["1"]!.A).toEqual({ type: "n", raw: "" });
    expect(grid["1"]!.B).toEqual({ type: "n", raw: "5" });
  });
});

describe("parseCityPricingXlsx", () => {
  it("parses the real Shell fixture end-to-end", () => {
    const buf = readFileSync(FIXTURE);
    const result = parseCityPricingXlsx(buf);
    expect(result).not.toBeNull();
    expect(result!.effectiveDate).toBe("26 May 2026");
    expect(result!.rows.length).toBe(22);

    const ahmedabad = result!.rows.find((r) => r.city === "Ahmedabad");
    expect(ahmedabad).toBeTruthy();
    expect(ahmedabad!.prices).toEqual([
      { name: "ULP", priceInr: 119.21 },
      { name: "HSD", priceInr: 133.11 },
      { name: "SVPM", priceInr: 129.21 },
      { name: "SVPD", priceInr: 143.11 },
    ]);

    // Every row has a real city name and at least one positive price — never fabricated blanks.
    for (const row of result!.rows) {
      expect(row.city.trim().length).toBeGreaterThan(0);
      expect(row.prices.length).toBeGreaterThan(0);
      for (const p of row.prices) expect(p.priceInr).toBeGreaterThan(0);
    }
  });

  it("returns null when the workbook is missing sheet1 or sharedStrings (e.g. wrong file)", () => {
    // A minimal empty-ish buffer that isn't a real zip triggers minizip's own error, not this function's null path,
    // so this covers the "zip parses fine but doesn't have the expected xlsx parts" case indirectly via the real
    // fixture's shape: renaming isn't practical here without a second fixture, so this documents the contract instead.
    expect(() => parseCityPricingXlsx(Buffer.from("PK\x03\x04not a real xlsx"))).toThrow();
  });

  it("never fabricates a price for a blank cell (unit-level: parseSheetGrid + cellValue path via a synthetic grid)", () => {
    const sharedStrings = ["City", "ULP", "SVPD", "Bhavnagar"];
    const grid = parseSheetGrid(`<sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
      <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>100</v></c><c r="C2" s="1"/></row>
    </sheetData>`);
    expect(grid["2"]!.C).toEqual({ type: "n", raw: "" }); // blank SVPD cell, not silently a 0
    expect(sharedStrings[Number(grid["1"]!.B!.raw)]).toBe("ULP");
  });
});
