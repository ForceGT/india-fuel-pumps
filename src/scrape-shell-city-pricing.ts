/**
 * `pnpm pricing:shell` — downloads Shell India's public city-price table
 * (see src/parsers/shell-pricing.ts + docs/shell-api.md) and writes
 * it to `output/shell-city-prices.jsonl`.
 *
 * DELIBERATELY NOT a `Provider`/`runProvider` job: this isn't a crawl (one
 * page, one small file, ~22 rows), there's no per-unit resumability to
 * track, and — most importantly — this output is NEVER merged into
 * `output/shell-raw.jsonl` or `build-dataset.ts`'s outlet stream. It's a
 * city-level INDICATIVE estimate ("may not reflect most recent price
 * changes... prices might vary from site to site in the same city," per
 * Shell's own page), not a per-outlet fact, so it stays a separate artifact
 * with its own distinct record shape — a downstream consumer that wants to
 * approximate a Shell outlet's price by city can join on `city` themselves,
 * with full knowledge of what this data actually is.
 *
 * Steps: fetch the pricing page's AEM `.model.json` (the current `.xlsx`
 * download link isn't stable — it's a content-hashed DAM asset path that
 * changes every time Shell re-uploads updated prices, so it has to be
 * discovered fresh each run) -> fetch that `.xlsx` -> parse it.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fetchWithBackoff } from "./http.js";
import {
  SHELL_PRICING_MODEL_JSON_URL,
  extractXlsxUrl,
  parseCityPricingXlsx,
  type ShellCityPricingSheet,
} from "./parsers/shell-pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../output");
const OUTPUT_PATH = path.join(OUTPUT_DIR, "shell-city-prices.jsonl");

export interface ShellCityPriceRecord {
  brand: "Shell";
  city: string;
  /** Shell's own grade code (ULP/HSD/SVPM/SVPD), captured verbatim — no grade opinion, same policy as every RawProduct in this repo. */
  grade: string;
  priceInr: number;
  /** Verbatim from the workbook, e.g. "26 May 2026". Null if unparseable. */
  effectiveDate: string | null;
  /** The .xlsx URL actually fetched this run (changes with every Shell price update — never assume stability across runs). */
  sourceUrl: string;
  capturedAt: string;
}

export function toRecords(sheet: ShellCityPricingSheet, sourceUrl: string, capturedAt: string): ShellCityPriceRecord[] {
  const records: ShellCityPriceRecord[] = [];
  for (const row of sheet.rows) {
    for (const p of row.prices) {
      records.push({
        brand: "Shell",
        city: row.city,
        grade: p.name,
        priceInr: p.priceInr,
        effectiveDate: sheet.effectiveDate,
        sourceUrl,
        capturedAt,
      });
    }
  }
  return records;
}

async function main(): Promise<void> {
  console.log(`[pricing:shell] fetching ${SHELL_PRICING_MODEL_JSON_URL}`);
  const modelRes = await fetchWithBackoff(SHELL_PRICING_MODEL_JSON_URL);
  if (!modelRes.ok) throw new Error(`[pricing:shell] model.json fetch failed: HTTP ${modelRes.status}`);
  const modelJson = (await modelRes.json()) as unknown;

  const xlsxUrl = extractXlsxUrl(modelJson);
  if (!xlsxUrl) throw new Error("[pricing:shell] no .xlsx link found in model.json — page layout may have changed");
  console.log(`[pricing:shell] fetching ${xlsxUrl}`);

  const xlsxRes = await fetchWithBackoff(xlsxUrl);
  if (!xlsxRes.ok) throw new Error(`[pricing:shell] xlsx fetch failed: HTTP ${xlsxRes.status}`);
  const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());

  const sheet = parseCityPricingXlsx(xlsxBuf);
  if (!sheet) throw new Error("[pricing:shell] xlsx parsed to nothing — workbook shape may have changed");

  const capturedAt = new Date().toISOString();
  const records = toRecords(sheet, xlsxUrl, capturedAt);
  if (records.length === 0) throw new Error("[pricing:shell] parsed workbook but produced zero price records");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, "");
  for (const r of records) appendFileSync(OUTPUT_PATH, JSON.stringify(r) + "\n");

  console.log(`[pricing:shell] effectiveDate=${sheet.effectiveDate} cities=${sheet.rows.length} records=${records.length}`);
  console.log(`[pricing:shell] wrote ${OUTPUT_PATH}`);
}

const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[pricing:shell] fatal:", err);
    process.exitCode = 1;
  });
}
