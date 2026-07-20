/**
 * Shared pure helpers for outlet-locator pages built on the "singleinterface.com"
 * vendor platform. Confirmed (Task #3, Task #13, Task #14) that HPCL
 * (petrolpump.hpretail.in) and IOCL (locator.iocl.com) both run on this
 * platform: identical robots.txt template, identical JSON-LD entity shapes
 * (BreadcrumbList / LocalBusiness / Organization / GasStation), an identical
 * `jsMasterOutletId` hidden input, and an identical `-<outletId>/Home` URL /
 * `url_alias` convention. See docs/data-sources.md and
 * docs/research/price-sourcing.md.
 *
 * Only pieces verified genuinely brand-agnostic live here:
 *  - JSON-LD extraction (JSON-LD is a schema.org standard, not brand markup).
 *  - The two outlet identifiers (`extractOutletId` / `extractMasterOutletId`)
 *    — pure regex over a tag/URL pattern re-verified live against IOCL
 *    fixtures during Task #14 (same `-<digits>/Home` URL suffix, same
 *    `url_alias` hidden input, same `jsMasterOutletId` hidden input).
 *  - Opening-hours extraction (schema.org `openingHoursSpecification`).
 *
 * Anything that differs even slightly between brands — breadcrumb shape
 * (HPCL: "Fuel station in X" text; IOCL: fixed-position plain names),
 * product-name casing, or price-fragment markup (HPCL: text `fuel_Name`;
 * IOCL: CSS icon class) — stays in hpcl.ts / iocl.ts respectively. Do NOT
 * move brand-specific logic here "for DRY" without re-verifying it's
 * actually identical on both sites — see the module-level warning in each
 * source file.
 *
 * NOTE (post-Task-#14 correctness fix): grade assertion is deliberately NOT
 * here and NOT shared. Each brand builds its Station's grades from its OWN
 * per-outlet price fragment (see hpcl.ts / iocl.ts `buildGradesFromPriceFragment`),
 * because that is the only per-outlet product signal — the outlet page's
 * `data-product` "Featured Products" widget is a STATIC SITE-WIDE catalogue
 * (proven: remote Leh outlets that don't sell XP100/Power 100 still list it in
 * the widget), so it must never assert a grade. See the module docs in each
 * source file and docs/data-sources.md.
 *
 * NOTE (added for the IOCL XP100-snapshot discovery tool): `discoverFromSitemaps`
 * originally lived only in hpcl.ts. `locator.iocl.com` was verified live to carry
 * the byte-identical sitemap-index -> per-district `.xml.gz` -> outlet `/Home`
 * structure (see run-iocl-discovery.ts's module doc), so the walking logic below
 * is genuinely brand-agnostic and takes the sitemap index URL as a parameter.
 * hpcl.ts's own `discoverFromSitemaps` is now a thin wrapper around
 * `walkSitemapDistricts` with HPCL's URL + default state allow-list baked in —
 * its behavior and its existing tests (hpcl-sitemap.test.ts) are unchanged.
 */
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { fetchWithBackoff, sleep } from "./http.js";

export interface GasStationLd {
  "@type"?: string;
  name?: string;
  alternateName?: string;
  telephone?: string | string[];
  url?: string;
  hasMap?: string;
  geo?: { latitude?: string; longitude?: string };
  address?: {
    streetAddress?: string;
    addressLocality?: string;
    addressRegion?: string;
    postalCode?: string;
  };
  openingHoursSpecification?: Array<{
    dayOfWeek?: string;
    opens?: string;
    closes?: string;
  }>;
}

export interface BreadcrumbLd {
  "@type"?: string;
  itemListElement?: Array<{ item?: { name?: string } }>;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Parse every `<script type="application/ld+json">` block on the page.
 * Both HPCL and IOCL emit one block containing an *array* of schema.org
 * entities (BreadcrumbList, LocalBusiness, Organization, GasStation,
 * WebPageElement, ...). Malformed/unparseable blocks are skipped, not
 * thrown — a script tag we don't understand shouldn't crash ingestion of
 * everything else on the page.
 */
export function extractJsonLd(root: HTMLElement): unknown[] {
  const out: unknown[] = [];
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.rawText) as unknown;
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      // Ignore malformed JSON-LD; other blocks / DOM fallback may still work.
    }
  }
  return out;
}

export function findByType<T>(items: unknown[], type: string): T | null {
  for (const item of items) {
    if (isRecord(item) && item["@type"] === type) return item as T;
  }
  return null;
}

/**
 * `openingHoursSpecification` lives on the page's `LocalBusiness` JSON-LD
 * item, NOT on the `GasStation` item, even though both describe the same
 * outlet (verified on both HPCL and IOCL fixtures — `GasStation` has no
 * hours field at all). Scan every item rather than assume which type
 * carries it.
 */
export function findOpeningHoursSpec(
  items: unknown[],
): GasStationLd["openingHoursSpecification"] | null {
  for (const item of items) {
    if (isRecord(item) && Array.isArray(item.openingHoursSpecification)) {
      return item.openingHoursSpecification as GasStationLd["openingHoursSpecification"];
    }
  }
  return null;
}

/**
 * Summarize openingHoursSpecification into a display string. If every day
 * shares the same opens/closes (the common case observed), collapse to a
 * single range; otherwise fall back to the first entry with a "varies" note
 * rather than guessing. Returns null if the page has no hours data at all.
 */
export function extractHours(spec: GasStationLd["openingHoursSpecification"] | null): string | null {
  if (!spec || spec.length === 0) return null;
  const first = spec[0];
  if (!first) return null;
  const allSame = spec.every((s) => s.opens === first.opens && s.closes === first.closes);
  if (first.opens && first.closes) {
    return allSame ? `${first.opens} - ${first.closes}` : `${first.opens} - ${first.closes} (varies by day)`;
  }
  return null;
}

/** Trailing `-<digits>/Home` on every seed HPCL/IOCL source_url. */
const OUTLET_ID_FROM_URL_RE = /-(\d+)\/Home\/?(?:[?#].*)?$/i;
/** Fallback: the page's own hidden `url_alias` input also ends in `-<outletId>`. */
const OUTLET_ID_FROM_ALIAS_RE = /name="url_alias"\s+value="[^"]*-(\d+)"/i;

/**
 * Extract the outlet id from the source URL (preferred — the seed's own
 * `outlet_id`) or, failing that, the page's `url_alias` hidden input. Pure;
 * no fetch. Re-verified identical on IOCL fixtures during Task #14.
 */
export function extractOutletId(html: string, sourceUrl: string): string | null {
  return OUTLET_ID_FROM_URL_RE.exec(sourceUrl)?.[1] ?? OUTLET_ID_FROM_ALIAS_RE.exec(html)?.[1] ?? null;
}

/** The tag itself, captured whole so VALUE_ATTR_RE below doesn't have to assume attribute order. */
const MASTER_OUTLET_ID_TAG_RE = /<input[^>]*id="jsMasterOutletId"[^>]*>/i;
const VALUE_ATTR_RE = /value="(\d+)"/i;

/**
 * Extract the `master_outlet_id` needed to build the price URL from an
 * outlet `/Home` page — it's a hidden input already present in the same
 * HTML the outlet parser parses, e.g.
 * `<input id="jsMasterOutletId" type="hidden" value="96681" >`. Verified
 * present on both HPCL (chain-wide `96681`) and IOCL (chain-wide `99528`,
 * confirmed across 18 live outlets spanning 7 states — Task #14) fixtures.
 * Pure: no fetch. Returns null if the input isn't found — callers must
 * treat that as "can't fetch price for this outlet," never guess a value.
 */
export function extractMasterOutletId(html: string): string | null {
  const tag = MASTER_OUTLET_ID_TAG_RE.exec(html)?.[0];
  if (!tag) return null;
  return VALUE_ATTR_RE.exec(tag)?.[1] ?? null;
}

/** Pure HTML parse, never throws — callers get `null` back on garbage input. */
export function tryParseHtml(html: string): HTMLElement | null {
  try {
    return parseHtml(html);
  } catch {
    return null;
  }
}

/**
 * Named HTML entities we've actually observed in HPCL/IOCL outlet data
 * (`&amp;` in outlet names like "Pannalal Rameswar &amp; Co", `&#039;`/`&apos;`
 * in names with an apostrophe like "Kini&#039;S Causeway"). Kept intentionally
 * small — this is not a general-purpose HTML5 entity table, just correct for
 * the free-text fields this source actually produces.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
};

/** Matches `&name;`, `&#NNN;` (decimal), and `&#xHHH;`/`&#XHHH;` (hex) entity refs. */
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;

/**
 * Decode HTML entities in free text pulled out of JSON-LD embedded in an
 * outlet page. Both HPCL's and IOCL's page templates HTML-escape strings
 * even inside `<script type="application/ld+json">` blocks (a site-side
 * templating quirk, not something we control) — e.g. the literal JSON-LD
 * value `"alternateName":"Kini&#039;S Causeway"`. `JSON.parse` has no concept
 * of HTML entities, so it passes a substring like `&#039;` straight through
 * as literal text; this function is the fix, applied by hpcl.ts/iocl.ts to
 * every free-text field sourced from that JSON-LD (outletName, address).
 *
 * No DOM/`document.createElement` available in the Workers runtime this
 * module runs in, so this is a plain string implementation: a single regex
 * pass over named entities (`&amp;`, `&apos;`/`&#039;`, `&quot;`, `&lt;`,
 * `&gt;`) plus generic numeric decimal/hex entities
 * (`&#NNN;`/`&#xHHH;` -> `String.fromCodePoint`). A single pass (rather than
 * chained `.replace()` calls) means an already-substituted character is never
 * re-scanned, so there's no double-decode risk (e.g. a literal `&amp;amp;` in
 * the source correctly becomes `&amp;`, not `&`). An unrecognized named
 * entity or an out-of-range numeric one is left untouched rather than guessed
 * — per design principle #4, a wrong substitution is worse than none. Text
 * with no `&` at all (the common case) short-circuits before the regex runs.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = isHex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Fetch a sitemap INDEX (`<sitemapindex>` of `.xml.gz` per-district files —
 * the shape both HPCL and IOCL use, verified live for both, Task #3/#14) and
 * return every district file URL it lists. Does not filter or fetch the
 * district files themselves — callers (walkSitemapDistricts, or the IOCL
 * discovery tool's own match-then-fetch flow) decide which ones to visit.
 */
export async function fetchSitemapIndexUrls(
  sitemapIndexUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const indexRes = await fetchWithBackoff(sitemapIndexUrl, { fetchImpl });
  if (!indexRes.ok) {
    throw new Error(`sitemap index fetch failed: HTTP ${indexRes.status}`);
  }
  const indexXml = await indexRes.text();
  return [...indexXml.matchAll(/<loc>([^<]+\.xml\.gz)<\/loc>/g)].map((m) => m[1]!);
}

/**
 * Fetch one district `.xml.gz` sitemap file, gunzip it, and return only the
 * `<loc>` entries ending in `/Home` (the outlet pages — `/Map` and
 * `/Contact-Us` entries in the same file are dropped). Returns `[]` on a
 * non-OK response rather than throwing, so a caller walking many districts
 * can skip-and-continue past one bad file.
 */
export async function fetchDistrictHomeUrls(
  districtUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const res = await fetchWithBackoff(districtUrl, { fetchImpl });
  if (!res.ok) return [];
  const xml = await gunzipToText(await res.arrayBuffer());
  const urls: string[] = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const loc = m[1]!;
    if (loc.endsWith("/Home")) urls.push(loc);
  }
  return urls;
}

/** Node's zlib is imported lazily so this module stays loadable in non-Node runtimes (Workers) if only the pure parsers are used. */
async function gunzipToText(buf: ArrayBuffer): Promise<string> {
  const { gunzipSync } = await import("node:zlib");
  return gunzipSync(Buffer.from(buf)).toString("utf-8");
}

export interface SitemapDistrictWalkOptions {
  /**
   * Lowercase, underscored state-slug allow-list matching the sitemap path
   * segment (e.g. "tamil_nadu"). Empty array (the default here) crawls every
   * district — brand-specific wrappers (e.g. hpcl.ts) should pass their own
   * conservative default.
   */
  stateAllowList?: string[];
  /** Politeness delay between district-file fetches, ms. Must stay >= 1000. */
  delayMs?: number;
  /** Safety cap on number of district files fetched in one call. */
  maxDistricts?: number;
  fetchImpl?: typeof fetch;
  /**
   * Injectable delay implementation; defaults to the real `sleep()`. Tests
   * pass a no-op here so the suite doesn't actually wait out the politeness
   * delay — `delayMs` itself still enforces the >= 1000ms floor below,
   * independent of whether the injected implementation really sleeps.
   */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * OPT-IN discovery crawl, shared by every brand on this vendor platform:
 * sitemap index -> per-district `.xml.gz` -> outlet `/Home` URLs. Not
 * invoked automatically by any `run*.ts` MVP path — see hpcl.ts's and
 * iocl.ts's `discoverFromSitemaps` wrappers, and run-iocl-discovery.ts,
 * for the only callers.
 */
export async function* walkSitemapDistricts(
  sitemapIndexUrl: string,
  opts: SitemapDistrictWalkOptions = {},
): AsyncGenerator<string> {
  const {
    stateAllowList = [],
    delayMs = 1200,
    maxDistricts = 20,
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = opts;

  if (delayMs < 1000) {
    throw new Error("walkSitemapDistricts: delayMs must be >= 1000ms (politeness floor)");
  }

  const allDistrictUrls = await fetchSitemapIndexUrls(sitemapIndexUrl, fetchImpl);
  const districtUrls =
    stateAllowList.length === 0
      ? allDistrictUrls
      : allDistrictUrls.filter((url) => stateAllowList.some((state) => url.includes(`/${state}/`)));

  let visited = 0;
  for (const districtUrl of districtUrls) {
    if (visited >= maxDistricts) break;
    visited++;
    if (visited > 1) await sleepImpl(delayMs);

    const urls = await fetchDistrictHomeUrls(districtUrl, fetchImpl);
    for (const loc of urls) yield loc;
  }
}
