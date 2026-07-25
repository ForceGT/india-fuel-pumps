import { describe, it, expect } from "vitest";
import {
  SHELL_WITHIN_BOUNDS_ENDPOINT,
  SHELL_LOCATION_ENDPOINT,
  buildWithinBoundsUrl,
  buildLocationDetailUrl,
  parseWithinBoundsResponse,
  parseLocationDetail,
} from "./shell.js";

describe("buildWithinBoundsUrl", () => {
  it("builds a repeated-key sw/ne query string plus the fixed fuel_type filter", () => {
    const url = buildWithinBoundsUrl({ minLat: 6.5, minLng: 68, maxLat: 37.5, maxLng: 97.5 });
    expect(url.startsWith(`${SHELL_WITHIN_BOUNDS_ENDPOINT}?`)).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.getAll("sw[]")).toEqual(["6.5", "68"]);
    expect(params.getAll("ne[]")).toEqual(["37.5", "97.5"]);
    expect(params.getAll("with_any[fuel_type][]")).toEqual(["conventional", "ev"]);
    expect(params.get("locale")).toBe("en_IN");
    expect(params.get("format")).toBe("json");
    expect(params.get("driving_distances")).toBe("false");
  });
});

describe("buildLocationDetailUrl", () => {
  it("builds a plain id-suffixed URL, no query params", () => {
    expect(buildLocationDetailUrl("12665703")).toBe(`${SHELL_LOCATION_ENDPOINT}/12665703`);
  });

  it("URL-encodes the id", () => {
    expect(buildLocationDetailUrl("a b")).toBe(`${SHELL_LOCATION_ENDPOINT}/a%20b`);
  });
});

describe("parseWithinBoundsResponse", () => {
  it("returns location stubs with hasClusters=false when the bbox resolved to individual locations", () => {
    const json = {
      locations: [
        { id: "111", country_code: "IN" },
        { id: 222, country_code: "IN" },
        { id: "333", country_code: "PK" },
      ],
      clusters: [],
    };
    const result = parseWithinBoundsResponse(json);
    expect(result.hasClusters).toBe(false);
    expect(result.stubs).toEqual([
      { id: "111", countryCode: "IN" },
      { id: "222", countryCode: "IN" },
      { id: "333", countryCode: "PK" },
    ]);
  });

  it("returns hasClusters=true and no stubs when the bbox is too dense to enumerate", () => {
    const json = { locations: [], clusters: [{ centroid: [1, 2], bounds: {}, size: 500, id: "c1" }] };
    const result = parseWithinBoundsResponse(json);
    expect(result.hasClusters).toBe(true);
    expect(result.stubs).toEqual([]);
  });

  it("returns empty/false for malformed input, never throws", () => {
    expect(parseWithinBoundsResponse(null)).toEqual({ stubs: [], hasClusters: false });
    expect(parseWithinBoundsResponse(undefined)).toEqual({ stubs: [], hasClusters: false });
    expect(parseWithinBoundsResponse("not an object")).toEqual({ stubs: [], hasClusters: false });
    expect(parseWithinBoundsResponse({ locations: "nope", clusters: "nope" })).toEqual({ stubs: [], hasClusters: false });
  });

  it("skips location entries with no usable id", () => {
    const json = { locations: [{ country_code: "IN" }, { id: "ok", country_code: "IN" }], clusters: [] };
    const result = parseWithinBoundsResponse(json);
    expect(result.stubs).toEqual([{ id: "ok", countryCode: "IN" }]);
  });
});

describe("parseLocationDetail", () => {
  const REAL_DETAIL = {
    id: "12665703",
    name: "DAVANAGERE-OLD PB RD",
    lat: 14.472296,
    lng: 75.893283,
    country_code: "IN",
    address: "DAVANGERE",
    city: "DAVANGERE",
    state: "Karnataka",
    postcode: "577004",
    telephone: "+91 99014 90156",
    website_url: "https://find.shell.com/in/fuel/12665703-davanagere-old-pb-rd",
    formatted_address: "DAVANGERE\nDAVANGERE, Karnataka, 577004",
    fuels: ["premium_gasoline", "premium_diesel", "midgrade_gasoline", "shell_regular_diesel"],
    opening_hours: [{ days: ["Mon", "Sun"], hours: [["06:00", "22:00"]] }],
    fuel_pricing: { status: "unavailable" },
  };

  it("ok: parses a real detail response, priceInr always null (fuel_pricing unavailable)", () => {
    const result = parseLocationDetail(REAL_DETAIL);
    expect(result).toEqual({
      id: "12665703",
      name: "DAVANAGERE-OLD PB RD",
      lat: 14.472296,
      lng: 75.893283,
      address: "DAVANGERE",
      city: "DAVANGERE",
      state: "Karnataka",
      postcode: "577004",
      telephone: "+91 99014 90156",
      countryCode: "IN",
      websiteUrl: "https://find.shell.com/in/fuel/12665703-davanagere-old-pb-rd",
      hours: "Mon-Sun 06:00-22:00",
      products: [
        { name: "premium_gasoline", priceInr: null },
        { name: "premium_diesel", priceInr: null },
        { name: "midgrade_gasoline", priceInr: null },
        { name: "shell_regular_diesel", priceInr: null },
      ],
    });
  });

  it("returns null when id is missing", () => {
    expect(parseLocationDetail({ lat: 1, lng: 2 })).toBeNull();
  });

  it("returns null when lat/lng are missing or non-finite", () => {
    expect(parseLocationDetail({ id: "1", lat: "not-a-number", lng: 2 })).toBeNull();
    expect(parseLocationDetail({ id: "1", lng: 2 })).toBeNull();
  });

  it("falls back to id as name when name is missing", () => {
    const result = parseLocationDetail({ id: "NONAME1", lat: 1, lng: 2 });
    expect(result?.name).toBe("NONAME1");
  });

  it("falls back to formatted_address when address is blank/missing", () => {
    const result = parseLocationDetail({ id: "1", lat: 1, lng: 2, address: "   ", formatted_address: "Fallback Addr" });
    expect(result?.address).toBe("Fallback Addr");
  });

  it("empty fuels array -> empty products, never fabricated", () => {
    const result = parseLocationDetail({ id: "1", lat: 1, lng: 2, fuels: [] });
    expect(result?.products).toEqual([]);
  });

  it("hours is null when opening_hours is absent/empty/malformed", () => {
    expect(parseLocationDetail({ id: "1", lat: 1, lng: 2 })?.hours).toBeNull();
    expect(parseLocationDetail({ id: "1", lat: 1, lng: 2, opening_hours: [] })?.hours).toBeNull();
    expect(parseLocationDetail({ id: "1", lat: 1, lng: 2, opening_hours: [{ days: [], hours: [] }] })?.hours).toBeNull();
  });

  it("returns null for malformed/non-object input", () => {
    expect(parseLocationDetail(null)).toBeNull();
    expect(parseLocationDetail(undefined)).toBeNull();
    expect(parseLocationDetail("not an object")).toBeNull();
  });
});
