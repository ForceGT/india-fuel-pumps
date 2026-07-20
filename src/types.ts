/**
 * Grade-agnostic wire format this repo's scrapers produce. Deliberately does
 * NOT define anything like a `Grade`/`StationGrade`/ethanol-content field —
 * deciding what counts as "ethanol-free" or any other classification is a
 * downstream consumer's opinion (e.g. the private E0-Finder project), not a
 * fact this repo asserts. A scraper here reports every product/price a
 * source makes public, exactly as reported, and nothing else.
 */

export type Brand = "IOCL" | "BPCL" | "HPCL" | "JioBP" | "Nayara" | "Shell";

export interface RawProduct {
  /** Exactly as the source reports it — "Power 100", "SPEED 100 BS IV", "XP100", "Diesel". No cleanup, no casing fixes. */
  name: string;
  /** `null` = a card/entry was present for this product but its price was missing/unparseable/non-positive — never fabricated. */
  priceInr: number | null;
}

export interface RawOutletRecord {
  schemaVersion: 1;
  brand: Brand;
  /** OMC's own id: HPCL/IOCL outletId, BPCL roId. */
  outletId: string;
  /** Stable dedup key: makeStationId(brand, outletId, lat, lng). */
  stationId: string;
  sourceUrl: string | null;
  capturedAt: string;
  name: string;
  address: string | null;
  /** The RAW breadcrumb/town string as the source reports it — not reconciled against any external city list. */
  city: string | null;
  state: string | null;
  pincode: string | null;
  lat: number;
  lng: number;
  geohash: string;
  hours: string | null;
  contact: string | null;
  mapsLink: string | null;
  /** Every product+price seen at this outlet, exactly as reported. */
  products: RawProduct[];
}

/**
 * Crawl-attempt bookkeeping, deliberately separate from `RawOutletRecord` —
 * `status` describes whether ONE unit of work succeeded, not what an outlet
 * is; an outlet only appears in the raw-record stream if its unit's status
 * was "ok"/"empty".
 */
export interface WorkLogRecord {
  /** sourceUrl (HPCL/IOCL, 1:1 with an outlet) or routeChunkId/cellId (BPCL, may yield 0..N outlets). */
  workUnitId: string;
  status: "ok" | "empty" | "httpFailed" | "parsedNull" | "errored";
  /** How many RawOutletRecords this unit emitted. */
  recordCount: number;
  /** BPCL adaptive-grid-subdivision hint only; absent for other brands. */
  saturated?: boolean;
  detail?: string;
  fetchedAt: string;
}
