/**
 * Shell India "Fuel Pricing in India" city-price-table parser — a
 * DELIBERATELY SEPARATE, DIFFERENT-SHAPED asset from the per-outlet
 * `RawOutletRecord` stream every other parser in this repo produces (see
 * ../providers/shell-provider.ts for that one). See docs/shell-api.md
 * for the full reverse-engineered reference and — importantly — WHY this
 * data is never joined onto a `RawOutletRecord`.
 *
 * The page at shell.in/.../fuel-pricing-in-india.html renders its table
 * client-side from a downloadable `.xlsx` the page links to (an AEM DAM
 * asset, re-uploaded whenever Shell updates prices — the URL itself
 * changes with a new content hash each time, so the CURRENT link has to be
 * discovered fresh from the page's `.model.json` on every run, not
 * hardcoded). The xlsx is a plain small ZIP of XML parts — read via
 * ../lib/minizip.ts, a purpose-built minimal reader (see that module's doc
 * comment for why this repo doesn't just depend on a general xlsx library).
 *
 * ONLY 22 major cities, 4 grades (ULP/HSD = regular petrol/diesel,
 * SVPM/SVPD = V-Power premium petrol/diesel — Shell's own codes, captured
 * verbatim, no grade opinion). The page's own disclaimer: "indicative...
 * may not reflect most recent price changes... prices might vary from
 * site to site in the same city." This is a city-AVERAGE estimate, not a
 * per-outlet fact — never merged into `RawOutletRecord.products`, which
 * this repo's schema promises means "the source reported this exact price
 * for this exact outlet."
 */
import { readZipEntry } from "../lib/minizip.js";

export const SHELL_PRICING_PAGE_URL = "https://www.shell.in/fuels-oils-and-coolants/shell-fuels/fuel-pricing-in-india.html";
export const SHELL_PRICING_MODEL_JSON_URL = `${SHELL_PRICING_PAGE_URL.replace(/\.html$/, "")}.model.json`;

/** Walks the AEM model JSON looking for any string value that looks like an xlsx asset link — deliberately shape-based (not a hardcoded JSON path) since AEM component tree positions are fragile across page edits. Returns the FIRST match; the page has exactly one price-sheet download link in practice. */
export function extractXlsxUrl(modelJson: unknown): string | null {
  const seen = new Set<unknown>();
  function walk(node: unknown): string | null {
    if (typeof node === "string") {
      return /\.xlsx(\?|$)/i.test(node) ? node : null;
    }
    if (typeof node !== "object" || node === null || seen.has(node)) return null;
    seen.add(node);
    const values = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const v of values) {
      const found = walk(v);
      if (found) return found;
    }
    return null;
  }
  return walk(modelJson);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** `xl/sharedStrings.xml` -> ordered string table (referenced by index from sheet cells with `t="s"`). Concatenates every `<t>` run within each `<si>` entry (handles both plain and rich-text runs). */
export function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const SI_RE = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = SI_RE.exec(xml))) {
    const body = siMatch[1]!;
    const parts: string[] = [];
    const T_RE = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = T_RE.exec(body))) parts.push(decodeXmlEntities(tMatch[1]!));
    strings.push(parts.join(""));
  }
  return strings;
}

interface SheetCell {
  type: string; // "s" (shared string), "n"/absent (number), etc.
  raw: string;
}

/** `xl/worksheets/sheet1.xml` -> `{ rowNumber: { columnLetter: cell } }`. Handles both `<c ...>...</c>` and self-closing `<c .../>` (blank) cells. */
export function parseSheetGrid(xml: string): Record<string, Record<string, SheetCell>> {
  const grid: Record<string, Record<string, SheetCell>> = {};
  const CELL_RE = /<c\s+r="([A-Za-z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = CELL_RE.exec(xml))) {
    const [, col, row, attrs, inner] = m;
    const type = /\st="([a-z]+)"/.exec(attrs!)?.[1] ?? "n";
    const raw = inner ? (/<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? "") : "";
    (grid[row!] ??= {})[col!] = { type, raw };
  }
  return grid;
}

function cellValue(cell: SheetCell | undefined, sharedStrings: string[]): string | null {
  if (!cell || cell.raw === "") return null;
  if (cell.type === "s") {
    const idx = Number(cell.raw);
    return Number.isInteger(idx) ? (sharedStrings[idx] ?? null) : null;
  }
  return decodeXmlEntities(cell.raw);
}

export interface ShellCityPrice {
  name: string;
  priceInr: number;
}

export interface ShellCityPriceRow {
  city: string;
  prices: ShellCityPrice[];
}

export interface ShellCityPricingSheet {
  /** Verbatim from the workbook's own metadata (`docProps/core.xml`'s description, e.g. "...effective from 26 May 2026"). Null if that phrasing isn't found — never guessed. */
  effectiveDate: string | null;
  rows: ShellCityPriceRow[];
}

/**
 * Parses a downloaded `.xlsx` buffer (the whole file, not just the sheet)
 * into city price rows. Row 1 is treated as the header (city-label column +
 * one column per grade, in WHATEVER order the workbook uses — never
 * hardcoded, since Shell controls this file's layout, not this repo).
 * Returns null if the workbook doesn't have the expected parts (sheet1 or
 * sharedStrings) — never throws, never fabricates partial data.
 */
export function parseCityPricingXlsx(buf: Buffer): ShellCityPricingSheet | null {
  const sheetXml = readZipEntry(buf, "xl/worksheets/sheet1.xml");
  const sharedStringsXml = readZipEntry(buf, "xl/sharedStrings.xml");
  if (!sheetXml || !sharedStringsXml) return null;

  const sharedStrings = parseSharedStrings(sharedStringsXml);
  const grid = parseSheetGrid(sheetXml);

  const rowNumbers = Object.keys(grid)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (rowNumbers.length < 2) return null; // need at least a header + one data row

  const headerRow = grid[String(rowNumbers[0])]!;
  // Column A is always the city label (matches the observed workbook: "City" header). Every other column is a grade name -> price.
  const gradeColumns: { col: string; name: string }[] = [];
  for (const [col, cell] of Object.entries(headerRow)) {
    if (col === "A") continue;
    const name = cellValue(cell, sharedStrings);
    if (name) gradeColumns.push({ col, name });
  }
  if (gradeColumns.length === 0) return null;

  const rows: ShellCityPriceRow[] = [];
  for (const rowNum of rowNumbers.slice(1)) {
    const rowCells = grid[String(rowNum)]!;
    const city = cellValue(rowCells.A, sharedStrings);
    if (!city) continue;
    const prices: ShellCityPrice[] = [];
    for (const { col, name } of gradeColumns) {
      const raw = cellValue(rowCells[col], sharedStrings);
      if (raw === null) continue;
      const priceInr = Number(raw);
      if (Number.isFinite(priceInr) && priceInr > 0) prices.push({ name, priceInr });
    }
    rows.push({ city, prices });
  }

  const coreXml = readZipEntry(buf, "docProps/core.xml");
  const effectiveDate = coreXml ? (/effective from ([^<"]*)/i.exec(coreXml)?.[1]?.trim() ?? null) : null;

  return { effectiveDate, rows };
}
