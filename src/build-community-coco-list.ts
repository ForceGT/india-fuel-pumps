/**
 * Coordinate-joins the crowdsourced "COCO Fuel Station" Google Maps list
 * (382 places, shared by a friend of the repo owner, spanning multiple
 * brands — see docs/EDGE-CASES.md or ask before assuming this file's
 * provenance if you're reading this cold) against the brands that have NO
 * native ownership signal of their own: HPCL, JioBP, Nayara, Shell. (BPCL
 * has a live API filter — `fuelStationCategory=Owned_Operated` — and IOCL
 * has a name-substring signal; neither needs this list. See
 * bpcl-provider.ts and iocl.ts's module doc comments.)
 *
 * This is a ONE-TIME, hand-triggered join, not part of any census run —
 * the crowdsourced list only changes when its owner edits it, nothing like
 * the 3-day freshness cycle the actual outlet scrapers use. Re-run by hand
 * (`npm run join-community-coco`) if/when the source list is re-pulled.
 *
 * Two-tier output, same discipline as `iocl-swagat-outlet-ids.json`'s
 * provenance (<0.3km auto-match, everything else needs a human):
 *  - `src/data/community-coco-station-ids.json` (committed): stationIds
 *    within CLEAN_THRESHOLD_KM of a crowdsourced entry — these get tagged
 *    `categories: ["COCO"]` by the four providers above.
 *  - `coco-community-anomalies.json` (repo root, gitignored working
 *    artifact, NOT auto-applied): 0.3-2km matches for manual review. Some
 *    of these are outright brand mismatches — e.g. a crowdsourced entry
 *    literally named "BP COCO ..." matching an HPCL station because no
 *    closer BPCL record existed within range — not just distance noise.
 *    Never promote an entry from here into the committed list without
 *    checking it by hand first.
 *
 * Usage:
 *   npm run join-community-coco
 *   (reads coco-fuel-stations-raw.json from the repo root — the raw
 *   extraction produced by the gmaps_list_export.py-style pull; not itself
 *   committed, since it's just this script's input)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { haversineKm } from "./geo.js";

const CLEAN_THRESHOLD_KM = 0.3;
const ANOMALY_THRESHOLD_KM = 2.0;

const RAW_LIST_PATH = "coco-fuel-stations-raw.json";
const OUTPUT_PATH = "src/data/community-coco-station-ids.json";
const ANOMALY_REPORT_PATH = "coco-community-anomalies.json";

/** Brands with no native COCO/ownership signal of their own — the only ones this list's OUTPUT is for. */
const TARGET_BRANDS = new Set(["HPCL", "JioBP", "Nayara", "Shell"]);

/**
 * ALL brands must be candidates for nearest-neighbor, not just the target
 * ones — otherwise a crowdsourced entry that's genuinely a BPCL/IOCL station
 * (which already have their own signal and don't need this list) gets
 * force-matched to the nearest WRONG-brand station instead of correctly
 * having no eligible match. Matched-but-wrong-brand results are dropped
 * after the nearest-neighbor search, not before it.
 */
const ALL_BRAND_FILES: Record<string, string> = {
  BPCL: "output/bpcl-raw.jsonl.gz",
  IOCL: "output/iocl-raw.jsonl.gz",
  HPCL: "output/hpcl-raw.jsonl.gz",
  JioBP: "output/jiobp-raw.jsonl.gz",
  Nayara: "output/nayara-raw.jsonl.gz",
  Shell: "output/shell-raw.jsonl.gz",
};

interface CommunityListEntry {
  name: string;
  label: string;
  address: string;
  lat: number;
  lng: number;
  cid?: unknown;
  placeId?: string;
}

interface BrandOutlet {
  brand: string;
  stationId: string;
  name: string;
  lat: number;
  lng: number;
}

function readJsonlGz(path: string): unknown[] {
  const buf = readFileSync(path);
  const text = gunzipSync(buf).toString("utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

function loadAllBrandOutlets(): BrandOutlet[] {
  const outlets: BrandOutlet[] = [];
  for (const [brand, path] of Object.entries(ALL_BRAND_FILES)) {
    if (!existsSync(path)) {
      console.warn(`[join-community-coco] ${path} not found — skipping ${brand}`);
      continue;
    }
    const records = readJsonlGz(path) as Array<{ stationId: string; name: string; lat: number; lng: number }>;
    for (const r of records) {
      outlets.push({ brand, stationId: r.stationId, name: r.name, lat: r.lat, lng: r.lng });
    }
  }
  return outlets;
}

function nearest(entry: CommunityListEntry, outlets: BrandOutlet[]): { outlet: BrandOutlet; distanceKm: number } | null {
  let best: { outlet: BrandOutlet; distanceKm: number } | null = null;
  for (const outlet of outlets) {
    const d = haversineKm(entry.lat, entry.lng, outlet.lat, outlet.lng);
    if (!best || d < best.distanceKm) best = { outlet, distanceKm: d };
  }
  return best;
}

function main(): void {
  if (!existsSync(RAW_LIST_PATH)) {
    console.error(`[join-community-coco] ${RAW_LIST_PATH} not found — run the list export first.`);
    process.exitCode = 1;
    return;
  }

  const entries = JSON.parse(readFileSync(RAW_LIST_PATH, "utf-8")) as CommunityListEntry[];
  const outlets = loadAllBrandOutlets();
  console.log(`[join-community-coco] ${entries.length} crowdsourced entries, ${outlets.length} candidate outlets across all ${Object.keys(ALL_BRAND_FILES).length} brands`);

  const clean: Array<{ stationId: string; brand: string }> = [];
  const anomalies: Array<{
    communityName: string;
    communityLat: number;
    communityLng: number;
    matchedStationId: string;
    matchedBrand: string;
    matchedName: string;
    distanceKm: number;
  }> = [];
  let noMatch = 0;
  let otherBrand = 0; // true nearest match is BPCL/IOCL — already have their own signal, not this list's concern

  for (const entry of entries) {
    const match = nearest(entry, outlets);
    if (!match || match.distanceKm > ANOMALY_THRESHOLD_KM) {
      noMatch++;
      continue;
    }
    if (!TARGET_BRANDS.has(match.outlet.brand)) {
      otherBrand++;
      continue;
    }
    if (match.distanceKm <= CLEAN_THRESHOLD_KM) {
      clean.push({ stationId: match.outlet.stationId, brand: match.outlet.brand });
    } else {
      anomalies.push({
        communityName: entry.name,
        communityLat: entry.lat,
        communityLng: entry.lng,
        matchedStationId: match.outlet.stationId,
        matchedBrand: match.outlet.brand,
        matchedName: match.outlet.name,
        distanceKm: Math.round(match.distanceKm * 1000) / 1000,
      });
    }
  }

  const byBrand: Record<string, number> = {};
  for (const c of clean) byBrand[c.brand] = (byBrand[c.brand] ?? 0) + 1;

  const output = {
    _comment:
      "stationIds confirmed COCO by coordinate-join (<0.3km) against a crowdsourced Google Maps list, for the brands with no native ownership signal of their own (HPCL, JioBP, Nayara, Shell — see src/build-community-coco-list.ts). Static/hand-triggered, not re-pulled automatically.",
    resolvedAt: new Date().toISOString().slice(0, 10),
    sourceEntries: entries.length,
    byBrand,
    stationIds: clean.map((c) => c.stationId).sort(),
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");

  writeFileSync(ANOMALY_REPORT_PATH, JSON.stringify(anomalies, null, 2) + "\n");

  console.log(`[join-community-coco] clean matches: ${clean.length} (${JSON.stringify(byBrand)})`);
  console.log(`[join-community-coco] anomalies for manual review: ${anomalies.length} -> ${ANOMALY_REPORT_PATH}`);
  console.log(`[join-community-coco] no match (>${ANOMALY_THRESHOLD_KM}km): ${noMatch}`);
  console.log(`[join-community-coco] nearest match was BPCL/IOCL (already have their own signal, skipped): ${otherBrand}`);
  console.log(`[join-community-coco] wrote ${OUTPUT_PATH}`);
}

main();
