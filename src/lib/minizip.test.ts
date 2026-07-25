import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { readZipEntry } from "./minizip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "../parsers/__fixtures__/shell/india-price-update.xlsx");

describe("readZipEntry", () => {
  const buf = readFileSync(FIXTURE);

  it("reads a DEFLATE-compressed entry as UTF-8 text", () => {
    const xml = readZipEntry(buf, "xl/sharedStrings.xml");
    expect(xml).toBeTruthy();
    expect(xml).toContain("<sst");
    expect(xml).toContain("Ahmedabad");
  });

  it("reads a second entry from the same archive (central directory walked correctly, not just the first entry)", () => {
    const xml = readZipEntry(buf, "xl/worksheets/sheet1.xml");
    expect(xml).toBeTruthy();
    expect(xml).toContain("<worksheet");
  });

  it("returns null for a missing entry name, never throws", () => {
    expect(readZipEntry(buf, "nonexistent/entry.xml")).toBeNull();
  });

  it("throws on a buffer that isn't a valid ZIP", () => {
    expect(() => readZipEntry(Buffer.from("not a zip file"), "anything")).toThrow();
  });
});
