import { describe, it, expect } from "vitest";
import {
  NAYARA_LOCATOR_PAGE_URL,
  NAYARA_RADIUS_ENDPOINT,
  NAYARA_CHROME_HEADERS,
  buildSessionBootstrapRequest,
  extractSession,
  buildRadiusRequest,
  parseRadiusResponse,
  type NayaraSession,
} from "./nayara.js";

describe("buildSessionBootstrapRequest", () => {
  it("builds a GET request to the locator page with Chrome-mimicking headers", () => {
    const result = buildSessionBootstrapRequest();
    expect(result.url).toBe(NAYARA_LOCATOR_PAGE_URL);
    expect(result.method).toBe("GET");
    expect(result.headers["user-agent"]).toBe(NAYARA_CHROME_HEADERS["user-agent"]);
    expect(result.headers["sec-ch-ua"]).toBeTruthy();
  });
});

describe("extractSession", () => {
  it("extracts csrf token and cookie pairs from html + set-cookie headers", () => {
    const html = `<html><head><meta name="csrf-token" content="abc123XYZ"></head></html>`;
    const setCookie = [
      "laravel_session=sessval; path=/; httponly",
      "XSRF-TOKEN=xsrfval; path=/",
    ];
    const session = extractSession(html, setCookie);
    expect(session).toEqual({
      cookieHeader: "laravel_session=sessval; XSRF-TOKEN=xsrfval",
      csrfToken: "abc123XYZ",
    });
  });

  it("returns null when csrf-token meta tag is missing", () => {
    const html = `<html><head></head></html>`;
    const session = extractSession(html, ["laravel_session=sessval; path=/"]);
    expect(session).toBeNull();
  });

  it("returns null when no set-cookie headers are present", () => {
    const html = `<html><head><meta name="csrf-token" content="abc123"></head></html>`;
    const session = extractSession(html, []);
    expect(session).toBeNull();
  });

  it("handles single-quoted meta tag attributes", () => {
    const html = `<meta name='csrf-token' content='tok-999'>`;
    const session = extractSession(html, ["a=1"]);
    expect(session?.csrfToken).toBe("tok-999");
  });
});

describe("buildRadiusRequest", () => {
  const session: NayaraSession = { cookieHeader: "laravel_session=s; XSRF-TOKEN=x", csrfToken: "tok-abc" };

  it("builds a form-encoded POST with csrf token + cookie headers", () => {
    const result = buildRadiusRequest(session, 23.2599, 77.4126, 3000);
    expect(result.url).toBe(NAYARA_RADIUS_ENDPOINT);
    expect(result.method).toBe("POST");
    expect(result.headers["x-csrf-token"]).toBe("tok-abc");
    expect(result.headers["cookie"]).toBe("laravel_session=s; XSRF-TOKEN=x");
    expect(result.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(result.headers["x-requested-with"]).toBe("XMLHttpRequest");

    const params = new URLSearchParams(result.body);
    expect(params.get("curr_lat")).toBe("23.2599");
    expect(params.get("curr_long")).toBe("77.4126");
    expect(params.get("radius")).toBe("3000");
  });
});

describe("parseRadiusResponse", () => {
  it("ok: parses a real station with both PETROL and DIESEL", () => {
    const json = [
      {
        ro_name: "Auto Pushp",
        cms_code: "45839TA839",
        address: "Survey no.56, (P), CTS no.686, Village - Nahore, Bhandup, Taluka-Kurla, Mumbai, Maharashtra",
        address1: "Bhandup",
        latitude: "19.162741",
        longitude: "72.941088",
        efp: "NO",
        distance: 11.720905582510369,
        PETROL: "122.7",
        DIESEL: "106.03",
      },
    ];

    const result = parseRadiusResponse(json);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      cmsCode: "45839TA839",
      name: "Auto Pushp",
      address: "Survey no.56, (P), CTS no.686, Village - Nahore, Bhandup, Taluka-Kurla, Mumbai, Maharashtra",
      lat: 19.162741,
      lng: 72.941088,
      products: [
        { name: "PETROL", priceInr: 122.7 },
        { name: "DIESEL", priceInr: 106.03 },
      ],
    });
  });

  it("omits a product entirely when its key is absent (never fabricates 0/null)", () => {
    const json = [
      {
        ro_name: "Diesel Only Station",
        cms_code: "DSL001",
        latitude: "10.0",
        longitude: "20.0",
        DIESEL: "95.5",
      },
    ];
    const result = parseRadiusResponse(json);
    expect(result[0]!.products).toEqual([{ name: "DIESEL", priceInr: 95.5 }]);
  });

  it("skips entries with missing cms_code or non-finite coordinates", () => {
    const json = [
      { ro_name: "No Code", latitude: "10.0", longitude: "20.0", PETROL: "100" }, // missing cms_code
      { cms_code: "BAD001", latitude: "not-a-number", longitude: "20.0", PETROL: "100" }, // bad lat
      { cms_code: "GOOD001", latitude: "10.0", longitude: "20.0", PETROL: "100" }, // valid
    ];
    const result = parseRadiusResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0]!.cmsCode).toBe("GOOD001");
  });

  it("falls back to cms_code as name when ro_name is missing", () => {
    const json = [{ cms_code: "NONAME01", latitude: "10.0", longitude: "20.0" }];
    const result = parseRadiusResponse(json);
    expect(result[0]!.name).toBe("NONAME01");
  });

  it("address is null when missing/blank", () => {
    const json = [{ cms_code: "A1", latitude: "10.0", longitude: "20.0", address: "   " }];
    const result = parseRadiusResponse(json);
    expect(result[0]!.address).toBeNull();
  });

  it("priceInr is null when the value is unparseable or non-positive", () => {
    const json = [
      { cms_code: "P1", latitude: "10.0", longitude: "20.0", PETROL: "N/A" },
      { cms_code: "P2", latitude: "11.0", longitude: "21.0", PETROL: "0" },
      { cms_code: "P3", latitude: "12.0", longitude: "22.0", PETROL: "-5" },
    ];
    const result = parseRadiusResponse(json);
    expect(result[0]!.products).toEqual([{ name: "PETROL", priceInr: null }]);
    expect(result[1]!.products).toEqual([{ name: "PETROL", priceInr: null }]);
    expect(result[2]!.products).toEqual([{ name: "PETROL", priceInr: null }]);
  });

  it("returns [] for malformed/non-array input", () => {
    expect(parseRadiusResponse(null)).toEqual([]);
    expect(parseRadiusResponse(undefined)).toEqual([]);
    expect(parseRadiusResponse({})).toEqual([]);
    expect(parseRadiusResponse("not an array")).toEqual([]);
    expect(parseRadiusResponse([null, "not-an-object", 42])).toEqual([]);
  });

  it("rejects null/blank coordinates instead of silently coercing to 0 (Number(null) === 0 would otherwise pass)", () => {
    const json = [
      { cms_code: "NULL01", latitude: null, longitude: "76.5" },
      { cms_code: "BLANK01", latitude: "10.0", longitude: "" },
      { cms_code: "WS01", latitude: "10.0", longitude: "   " },
      { cms_code: "GOOD01", latitude: "10.0", longitude: "20.0" },
    ];
    const result = parseRadiusResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0]!.cmsCode).toBe("GOOD01");
  });
});
