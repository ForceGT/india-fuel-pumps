/**
 * Unit tests for parseOutletHtml's `categories` derivation (COCO from name,
 * Swagat from the static outletId list) — see iocl.ts's module doc comment
 * for why both are computed inline here with zero extra requests. Uses
 * minimal synthetic HTML (not a real captured fixture) since these tests
 * only need to exercise the categories logic, not the full page shape —
 * see iocl-provider.test.ts for real-fixture coverage of the rest of
 * parseOutletHtml.
 */
import { describe, expect, it } from "vitest";
import { parseOutletHtml } from "./iocl.js";

function buildHtml(name: string): string {
  const ld = [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { item: { name: "Home" } },
        { item: { name: "Delhi" } },
        { item: { name: "New Delhi" } },
      ],
    },
    {
      "@type": "GasStation",
      name,
      geo: { latitude: "28.5", longitude: "77.2" },
      address: { streetAddress: "Test Address" },
    },
  ];
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`;
}

const SWAGAT_URL = "https://locator.iocl.com/some-swagat-outlet-102570/Home"; // 102570 is in src/data/iocl-swagat-outlet-ids.json
const NON_SWAGAT_URL = "https://locator.iocl.com/some-ordinary-outlet-999999/Home"; // not in the Swagat list

describe("parseOutletHtml categories", () => {
  it("tags COCO when the name contains 'coco' (case-insensitive)", async () => {
    const metadata = await parseOutletHtml(buildHtml("Coco Khanvel"), NON_SWAGAT_URL);
    expect(metadata?.categories).toEqual(["COCO"]);
  });

  it("does NOT tag COCO for an ordinary name", async () => {
    const metadata = await parseOutletHtml(buildHtml("Ordinary Filling Station"), NON_SWAGAT_URL);
    expect(metadata?.categories).toEqual([]);
  });

  it("tags Swagat when the outletId is in the static Swagat list", async () => {
    const metadata = await parseOutletHtml(buildHtml("Ordinary Filling Station"), SWAGAT_URL);
    expect(metadata?.outletId).toBe("102570");
    expect(metadata?.categories).toEqual(["Swagat"]);
  });

  it("does NOT tag Swagat for an outletId outside the static list", async () => {
    const metadata = await parseOutletHtml(buildHtml("Ordinary Filling Station"), NON_SWAGAT_URL);
    expect(metadata?.categories).toEqual([]);
  });

  it("tags both COCO and Swagat independently when both signals are present", async () => {
    const metadata = await parseOutletHtml(buildHtml("Swagat Coco Hogalberia"), SWAGAT_URL);
    expect(metadata?.categories?.sort()).toEqual(["COCO", "Swagat"]);
  });

  it("applies a manual name override when the outletId is in iocl-name-overrides.json (184493: Mundra -> Shri Nidhi Petroleum)", async () => {
    const url = "https://locator.iocl.com/indianoil-swagat-mundra-cng-pump-mundra-kachchh-184493/Home";
    const metadata = await parseOutletHtml(buildHtml("Mundra"), url);
    expect(metadata?.name).toBe("Shri Nidhi Petroleum");
  });

  it("does NOT override the name for an outletId not in iocl-name-overrides.json", async () => {
    const metadata = await parseOutletHtml(buildHtml("Mundra"), NON_SWAGAT_URL);
    expect(metadata?.name).toBe("Mundra");
  });
});
