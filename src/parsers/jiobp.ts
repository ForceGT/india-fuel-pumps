/**
 * Jio-bp (RBML) Mobility API parser — pure request-builders + response
 * parsers, no fetch/fs. See docs/jiobp-api.md for the full reverse-engineered
 * reference this is built from. No grade opinion anywhere in this module —
 * every product name a source reports is captured verbatim; classifying it
 * is a downstream consumer's job, not this repo's.
 */

export const JIOBP_ENDPOINT = "https://netmanager.ril.com:4005/CustomerMobility";

/** Synthetic identity fields — the live API returns full real data for ANY well-formed mobile/token/IMEI, no login/OTP required (verified end-to-end, see docs/jiobp-api.md). */
export const JIOBP_MOBILE_NUMBER = "9028833886";
export const JIOBP_IMEI_NO = "AE3A.240806.043";

export interface JiobpRequestSpec {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** Operation 1: national station index (code + coordinates + state only, no prices). */
export function buildROMasterRequest(tokenNumber: string): JiobpRequestSpec {
  const body = {
    CustomerRequest: {
      ROMaster: {
        IMEINo: JIOBP_IMEI_NO,
        MobileNumber: JIOBP_MOBILE_NUMBER,
        TokenNumber: tokenNumber,
      },
    },
  };
  return {
    url: JIOBP_ENDPOINT,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Operation 2: batch station detail + prices + amenities. All five trailing fields (IMEINo/MobileNumber/TokenNumber/SearchFlag/State) are required by the server even though their VALUES aren't validated — omitting any of them returns an error response. */
export function buildFindFuelStationRequest(codes: string[], tokenNumber: string): JiobpRequestSpec {
  const body = {
    CustomerRequest: {
      FuelStation: {
        FindFuelStation: {
          FuelStations: codes.map((FuelStationCode) => ({ FuelStationCode })),
          IMEINo: JIOBP_IMEI_NO,
          MobileNumber: JIOBP_MOBILE_NUMBER,
          TokenNumber: tokenNumber,
          SearchFlag: "R",
          State: "",
        },
      },
    },
  };
  return {
    url: JIOBP_ENDPOINT,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export interface JiobpIndexEntry {
  fuelStationCode: string;
  lat: number;
  lng: number;
  /** Raw state string as the index reports it, or null if absent. */
  state: string | null;
}

/**
 * Parse the ROMaster response into index entries. Never throws. Skips any
 * entry missing FuelStationCode or with non-finite lat/lng (note the source
 * field is misspelled "Lattitude", two t's — that's intentional, not a bug
 * here). Path: CustomerResponse.MasterData.FetchROMaster.ROMasterData[].
 */
export function parseROMasterResponse(json: unknown): JiobpIndexEntry[] {
  if (typeof json !== "object" || json === null) return [];
  const arr = (json as any)?.CustomerResponse?.MasterData?.FetchROMaster?.ROMasterData;
  if (!Array.isArray(arr)) return [];

  const results: JiobpIndexEntry[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const fuelStationCode = (item as Record<string, unknown>)?.FuelStationCode;
    if (typeof fuelStationCode !== "string") continue;

    const lat = Number((item as Record<string, unknown>)?.Lattitude);
    const lng = Number((item as Record<string, unknown>)?.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const rawState = (item as Record<string, unknown>)?.State;
    const state = typeof rawState === "string" && rawState.trim() ? rawState.trim() : null;

    results.push({ fuelStationCode, lat, lng, state });
  }
  return results;
}

export interface JiobpProduct {
  name: string;
  priceInr: number | null;
}

export interface JiobpStationDetail {
  fuelStationCode: string;
  name: string;
  address: string | null;
  contact: string | null;
  lat: number;
  lng: number;
  products: JiobpProduct[];
}

/**
 * `PriceDetails` is a dated history per product; the CURRENT price is the
 * entry with the latest `PriceDate` (format "dd-MM-yyyy HH:mm:ss" — NOT
 * ISO, do not use `Date.parse` directly on it, it will misread day/month).
 * Returns null if there are no entries or none have a parseable positive
 * price. Never throws.
 */
function latestProductPrice(priceDetails: unknown): number | null {
  if (!Array.isArray(priceDetails) || priceDetails.length === 0) return null;

  let latestEntry: Record<string, unknown> | null = null;
  let latestTimestamp = -Infinity;

  for (const entry of priceDetails) {
    if (typeof entry !== "object" || entry === null) continue;
    const entryRecord = entry as Record<string, unknown>;
    const priceDate = entryRecord?.PriceDate;

    let timestamp = -Infinity;
    if (typeof priceDate === "string") {
      const match = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(priceDate);
      if (match) {
        const [, dd, mm, yyyy, HH, MM, SS] = match;
        timestamp = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(HH), Number(MM), Number(SS));
      }
    }

    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
      latestEntry = entryRecord;
    }
  }

  if (!latestEntry) return null;
  const productPrice = latestEntry.ProductPrice;
  if (typeof productPrice !== "string") return null;
  const price = Number(productPrice.trim());
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Parse the FindFuelStation response into station details. Never throws.
 * Skips any station missing FuelStationCode or with non-finite lat/lng.
 * Path: CustomerResponse.FuelStation.FindFuelStation.FuelStations[].
 * `HistoryFuelProducts[].ProductName` becomes each product's `name` VERBATIM
 * — do not rename/clean it, this repo captures grades exactly as reported.
 */
export function parseFindFuelStationResponse(json: unknown): JiobpStationDetail[] {
  if (typeof json !== "object" || json === null) return [];
  const arr = (json as any)?.CustomerResponse?.FuelStation?.FindFuelStation?.FuelStations;
  if (!Array.isArray(arr)) return [];

  const results: JiobpStationDetail[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const itemRecord = item as Record<string, unknown>;

    const fuelStationCode = itemRecord?.FuelStationCode;
    if (typeof fuelStationCode !== "string") continue;

    const lat = Number(itemRecord?.Lattitude);
    const lng = Number(itemRecord?.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const fuelStationName = itemRecord?.FuelStationName;
    const name = typeof fuelStationName === "string" ? fuelStationName : fuelStationCode;

    const rawAddress = itemRecord?.Address;
    const address = typeof rawAddress === "string" && rawAddress.trim() ? rawAddress.trim() : null;

    const rawContact = itemRecord?.ContactNumber;
    const contact = typeof rawContact === "string" && rawContact.trim() ? rawContact.trim() : null;

    const products: JiobpProduct[] = [];
    const historyFuelProducts = itemRecord?.HistoryFuelProducts;
    if (Array.isArray(historyFuelProducts)) {
      for (const product of historyFuelProducts) {
        if (typeof product !== "object" || product === null) continue;
        const productRecord = product as Record<string, unknown>;
        const productName = productRecord?.ProductName;
        if (typeof productName !== "string") continue;
        const priceInr = latestProductPrice(productRecord?.PriceDetails);
        products.push({ name: productName, priceInr });
      }
    }

    results.push({ fuelStationCode, name, address, contact, lat, lng, products });
  }
  return results;
}
