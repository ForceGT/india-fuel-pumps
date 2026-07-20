/**
 * IOCL parser — locator.iocl.com. `locator.iocl.com` runs the same vendor
 * platform ("singleinterface.com") as HPCL's petrolpump.hpretail.in —
 * identical robots.txt template, identical JSON-LD shape, identical
 * `jsMasterOutletId` hidden input — so the shared pieces live in
 * ../locator-platform.ts.
 *
 * Two structural differences from HPCL, both load-bearing:
 *  1. IOCL's breadcrumb has no "Fuel station in X" text wrapper — it's just
 *     `Home > <State> > <City> > <Locality> > <outlet name>`, a fixed
 *     depth-5 shape.
 *  2. IOCL's price fragment carries product *only* as a CSS icon class
 *     (`icn-xp`, `icn-xptwo`, ...), never as text — unlike HPCL's explicit
 *     `fuel_Name` text label.
 *
 * No grade opinion anywhere in this module — every recognized icon's price
 * is captured, exactly as reported; classifying any of them (e.g. as
 * "ethanol-free") is a downstream consumer's job, not this repo's.
 */
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
  tryParseHtml,
  type BreadcrumbLd,
  type GasStationLd,
} from "../locator-platform.js";
import type { OutletMetadata } from "../lib/raw-record.js";

// Re-exported so importers only need "./iocl.js" for both.
export { extractMasterOutletId };

const IOCL_HOST = "https://locator.iocl.com";

/**
 * IOCL's breadcrumb is `Home > <State> > <City> > <Locality> > <outlet name>`
 * — plain names, no "Fuel station in X" wrapper (unlike HPCL). Because
 * there's no distinguishing text pattern to filter on, extraction is
 * positional instead: require the first crumb to literally be "Home" and at
 * least 3 crumbs total, then take positions 1 and 2 as state/city.
 */
function extractStateCity(breadcrumb: BreadcrumbLd | null): {
  state: string | null;
  city: string | null;
} {
  const names = (breadcrumb?.itemListElement ?? [])
    .map((el) => el.item?.name)
    .filter((n): n is string => Boolean(n));

  if (names[0] !== "Home" || names.length < 3) return { state: null, city: null };
  return { state: names[1]?.trim() ?? null, city: names[2]?.trim() ?? null };
}

/** Build the price endpoint URL for one outlet. Pure — doesn't fetch. */
export function buildPriceUrl(masterOutletId: string, outletId: string): string {
  const params = new URLSearchParams({ master_outlet_id: masterOutletId, outlet_id: outletId });
  return `${IOCL_HOST}/getPetrolPricesForIOCL.php?${params.toString()}`;
}

/**
 * icon-class suffix (the part after `icn-`) -> clean product display name.
 * A purely a naming lookup (icon -> product name), not a grade assertion.
 * An icon class not in this map is skipped entirely at parse time, never
 * guessed — this map only grows when a new icon's meaning has actually been
 * verified live.
 */
const ICON_TO_PRODUCT_NAME: Record<string, string> = {
  xp: "XP100",
  xptwo: "XP95",
  petrol: "Petrol",
  diesel: "Diesel",
  indigreen: "XtraGreen Diesel",
};

const ICON_CLASS_RE = /\bicn-([a-z0-9]+)\b/i;

/**
 * Parse the HTML fragment returned by `getPetrolPricesForIOCL.php` into a
 * map of clean product display name -> price in INR, or `null` when a card
 * is present for a recognized product but its price can't be trusted. Pure:
 * no fetch, no fs, never throws.
 *
 * A card is skipped ENTIRELY only if its icon class isn't recognized (see
 * ICON_TO_PRODUCT_NAME) or it has no icon element. Once the icon IS
 * recognized, the card is always kept — a live, per-outlet card for a real
 * product is itself confirmation the outlet sells it, even when the price
 * text is missing/unparseable/non-positive (in that case the price is
 * `null` rather than fabricated). Two cards resolving to the same product
 * name: first one found wins.
 */
export function parseIoclPriceFragment(html: string): Map<string, number | null> {
  const prices = new Map<string, number | null>();
  const root = tryParseHtml(html);
  if (!root) return prices;

  for (const card of root.querySelectorAll(".fule-price-card")) {
    const iconClassAttr = card.querySelector(".sprite-icon")?.getAttribute("class") ?? "";
    const icon = ICON_CLASS_RE.exec(iconClassAttr)?.[1]?.toLowerCase();
    if (!icon) continue;
    const productName = ICON_TO_PRODUCT_NAME[icon];
    if (!productName) continue; // unrecognized/unverified icon — skip, never guess

    const priceText = card.querySelector(".fuel-text")?.text?.trim();
    let price: number | null = null;
    if (priceText) {
      const match = /([\d.]+)/.exec(priceText);
      const parsed = match ? Number(match[1]) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) price = parsed;
      // else: missing/unparseable/non-positive — keep the card, null the price.
    }

    if (!prices.has(productName)) prices.set(productName, price);
  }
  return prices;
}

/**
 * Parse one IOCL outlet `/Home` page into outlet metadata, or null if the
 * page doesn't carry what we need to trust it (no GasStation JSON-LD at
 * all — this is also how a redirected/stale `error.html` page is rejected —
 * or no coordinates).
 *
 * `city`/`state` are the RAW breadcrumb strings, unreconciled against any
 * external city list. Pure: no fetch, no fs, never throws.
 */
export async function parseOutletHtml(html: string, sourceUrl: string): Promise<OutletMetadata | null> {
  const root = tryParseHtml(html);
  if (!root) return null;

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
  const rawOutletName = gasStation.alternateName?.trim() || gasStation.name?.trim() || "IOCL Outlet";
  // IOCL's page templating HTML-escapes strings even inside JSON-LD; undo it
  // here — see decodeHtmlEntities' doc comment in locator-platform.ts.
  const outletName = decodeHtmlEntities(rawOutletName);
  const rawStreetAddress = address.streetAddress?.trim();
  const telephone = Array.isArray(gasStation.telephone) ? gasStation.telephone[0] : gasStation.telephone;

  const stationId = await makeStationId({ brand: "IOCL", outletId, lat, lng });

  return {
    brand: "IOCL",
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
