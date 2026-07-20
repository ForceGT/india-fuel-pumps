/**
 * HPCL parser — petrolpump.hpretail.in. Pure, testable pieces, no fetch/fs
 * except where noted; no grade opinion anywhere in this module (this repo
 * reports every product+price a source makes public, exactly as reported —
 * deciding what counts as "ethanol-free" or any other classification is a
 * downstream consumer's job, not this repo's).
 *
 *  - parseOutletHtml: html string -> outlet metadata | null. No fetch, no
 *    fs. Rejects stale/error pages (no GasStation JSON-LD).
 *  - extractMasterOutletId: outlet html string -> the `master_outlet_id`
 *    needed to build the price URL. Pure; no fetch.
 *  - buildPriceUrl / parseHpclPriceFragment: pure helpers for the price
 *    endpoint — the per-outlet product+price signal. The actual GET happens
 *    in providers/hpcl-provider.ts, not here.
 */
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { geohashEncode } from "../geo.js";
import { makeStationId } from "../id.js";
import {
  decodeHtmlEntities,
  extractHours,
  extractJsonLd,
  extractMasterOutletId,
  extractOutletId,
  findByType,
  findOpeningHoursSpec,
  type BreadcrumbLd,
  type GasStationLd,
} from "../locator-platform.js";
import type { OutletMetadata } from "../lib/raw-record.js";

// Re-exported so importers only need "./hpcl.js" for both.
export { extractMasterOutletId };

const HPCL_HOST = "https://petrolpump.hpretail.in";

/**
 * HPCL's breadcrumb is Home > "Fuel station in <State>" > "Fuel station in
 * <City>" > "Fuel station in <Locality>" > <outlet name>. Rather than index
 * into the raw crumb list, filter to just the "Fuel station in X" crumbs —
 * unambiguous by pattern regardless of position — and take the first two as
 * state/city.
 */
function extractStateCity(breadcrumb: BreadcrumbLd | null): {
  state: string | null;
  city: string | null;
} {
  const FUEL_STATION_IN_RE = /^Fuel station in\s+(.+)$/i;
  const names = (breadcrumb?.itemListElement ?? [])
    .map((el) => el.item?.name)
    .filter((n): n is string => Boolean(n));
  const stationCrumbs = names
    .map((n) => FUEL_STATION_IN_RE.exec(n)?.[1]?.trim())
    .filter((n): n is string => Boolean(n));
  return {
    state: stationCrumbs[0] ?? null,
    city: stationCrumbs[1] ?? null,
  };
}

/** Build the price endpoint URL for one outlet. Pure — doesn't fetch. */
export function buildPriceUrl(masterOutletId: string, outletId: string): string {
  const params = new URLSearchParams({ master_outlet_id: masterOutletId, outlet_id: outletId });
  return `${HPCL_HOST}/getPetrolPricesForHPCL.php?${params.toString()}`;
}

/**
 * Parse the HTML fragment returned by `getPetrolPricesForHPCL.php` into a
 * map of raw product display name (as HPCL writes it, e.g. "Power 100") ->
 * price in INR, or `null` when a card is present for a named product but its
 * price can't be trusted. Pure: no fetch, no fs, never throws.
 *
 * Scoped per `.fule-price-card` (sic — HPCL's own class name typo) rather
 * than flat-matching every `.fuel_Name`/`.fuel-text` pair in document order.
 * A card is skipped ENTIRELY only if it has no product name; once a name IS
 * present, the card is always kept — a live, per-outlet card for a real
 * product is itself confirmation the outlet sells it, even when the price
 * text is missing/unparseable/non-positive (in that case the price is
 * `null` rather than fabricated).
 */
export function parseHpclPriceFragment(html: string): Map<string, number | null> {
  const prices = new Map<string, number | null>();
  let root: HTMLElement;
  try {
    root = parseHtml(html);
  } catch {
    return prices;
  }

  for (const card of root.querySelectorAll(".fule-price-card")) {
    const name = card.querySelector(".fuel_Name")?.text?.trim();
    if (!name) continue;

    const priceText = card.querySelector(".fuel-text")?.text?.trim();
    let price: number | null = null;
    if (priceText) {
      const match = /([\d.]+)/.exec(priceText);
      const parsed = match ? Number(match[1]) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) price = parsed;
      // else: missing/unparseable/non-positive — keep the card, null the price.
    }

    prices.set(name, price);
  }
  return prices;
}

/**
 * Parse one HPCL outlet `/Home` page into outlet metadata, or null if the
 * page doesn't carry what we need to trust it (no GasStation JSON-LD —
 * which also rejects stale/error pages — or no coordinates).
 *
 * `city`/`state` are the RAW breadcrumb strings, unreconciled against any
 * external city list — that's a downstream consumer's opinion, not a raw
 * fact this repo asserts. Pure: no fetch, no fs, never throws.
 */
export async function parseOutletHtml(html: string, sourceUrl: string): Promise<OutletMetadata | null> {
  let root: HTMLElement;
  try {
    root = parseHtml(html);
  } catch {
    return null;
  }

  const ldItems = extractJsonLd(root);
  const gasStation = findByType<GasStationLd>(ldItems, "GasStation");
  if (!gasStation) return null;

  const lat = gasStation.geo?.latitude != null ? Number(gasStation.geo.latitude) : NaN;
  const lng = gasStation.geo?.longitude != null ? Number(gasStation.geo.longitude) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const outletId = extractOutletId(html, sourceUrl);
  const breadcrumb = findByType<BreadcrumbLd>(ldItems, "BreadcrumbList");
  const { state, city } = extractStateCity(breadcrumb);

  const address = gasStation.address ?? {};
  const rawOutletName = gasStation.alternateName?.trim() || gasStation.name?.trim() || "HPCL Outlet";
  // HPCL's page templating HTML-escapes strings even inside JSON-LD; undo it
  // here — see decodeHtmlEntities' doc comment in locator-platform.ts.
  const outletName = decodeHtmlEntities(rawOutletName);
  const rawStreetAddress = address.streetAddress?.trim();
  const telephone = Array.isArray(gasStation.telephone) ? gasStation.telephone[0] : gasStation.telephone;

  const stationId = await makeStationId({ brand: "HPCL", outletId, lat, lng });

  return {
    brand: "HPCL",
    outletId: outletId ?? stationId,
    stationId,
    sourceUrl,
    capturedAt: new Date().toISOString(),
    name: outletName,
    address: rawStreetAddress ? decodeHtmlEntities(rawStreetAddress) : null,
    city,
    state,
    pincode: address.postalCode?.trim() || null,
    lat,
    lng,
    geohash: geohashEncode(lat, lng, 7),
    hours: extractHours(findOpeningHoursSpec(ldItems)),
    contact: telephone?.trim() || null,
    mapsLink: gasStation.hasMap?.trim() || null,
  };
}
