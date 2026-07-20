/**
 * HPCL `Provider` (see ../provider.ts).
 *
 * `discover()` deliberately does NOT cap district files the way an opt-in
 * bounded discovery path might — a full national census must walk every
 * district file, so this drives the lower-level `fetchSitemapIndexUrls`/
 * `fetchDistrictHomeUrls` directly via this module's own uncapped
 * concurrent pool (reusing `runDynamicQueue` from ../run-provider.ts).
 *
 * `process()` is: page fetch -> parse metadata -> price-fragment fetch ->
 * build a `RawOutletRecord` from both. No grade opinion anywhere — every
 * product+price the price fragment reports is captured.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { sleep, REQUEST_DELAY_MS } from "../http.js";
import { buildRawRecord, priceMapToProducts } from "../lib/raw-record.js";
import type { Provider, ProcessResult } from "../provider.js";
import { runDynamicQueue } from "../run-provider.js";
import { fetchDistrictHomeUrls, fetchSitemapIndexUrls } from "../locator-platform.js";
import { buildPriceUrl, extractMasterOutletId, parseHpclPriceFragment, parseOutletHtml } from "../parsers/hpcl.js";

const SITEMAP_INDEX_URL = "https://petrolpump.hpretail.in/sitemap.xml";

export interface HpclProviderConfig {
  /** Where to cache the discovered outlet-URL list across runs — same directory `runProvider` writes its own output into. */
  outputDir: string;
  /** Empty (default) = every district nationwide. Overridable per-call via `discover(opts)`'s `stateAllowList` (comma-separated). */
  stateAllowList?: string[];
  /** Concurrency for Phase A's district-sitemap walk. Default 1. */
  discoveryConcurrency?: number;
  /** Politeness delay for the discovery pool, ms. Default 1200. */
  discoveryDelayMs?: number;
  /** Injectable for tests, so discover() never makes a real network call in a unit-test run. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Trailing `-<digits>/Home` on every HPCL source_url. */
function outletIdFromUrl(url: string): string | null {
  const m = /-(\d+)\/Home\/?(?:[?#].*)?$/i.exec(url);
  return m ? m[1]! : null;
}

export function createHpclProvider(config: HpclProviderConfig): Provider {
  const urlsCachePath = path.join(config.outputDir, "hpcl-discovered-urls.json");

  // Error logging — first 3 of each type so GH Actions logs are diagnostic.
  const errCounts: Record<string, number> = {};
  function logErr(category: string, detail: string, url: string): void {
    const key = `${category}:${detail}`;
    const n = errCounts[key] ?? 0;
    errCounts[key] = n + 1;
    if (n < 3) console.error(`[hpcl] ${detail} — ${url.slice(0, 120)}`);
  }

  return {
    brand: "HPCL",
    slug: "hpcl",

    async *discover(opts) {
      const stateAllowList = opts.stateAllowList
        ? opts.stateAllowList.split(",").map((s) => s.trim()).filter(Boolean)
        : (config.stateAllowList ?? []);

      if (existsSync(urlsCachePath)) {
        const cached = JSON.parse(await readFile(urlsCachePath, "utf-8")) as string[];
        console.log(`[hpcl-provider] discovery cache hit — ${cached.length} outlet URLs (${urlsCachePath})`);
        for (const url of cached) yield { id: url, payload: url };
        return;
      }

      console.log(`[hpcl-provider] Phase A: fetching sitemap index...`);
      const allDistrictUrls = await fetchSitemapIndexUrls(SITEMAP_INDEX_URL, config.fetchImpl ?? fetch);
      const districtUrls =
        stateAllowList.length === 0
          ? allDistrictUrls
          : allDistrictUrls.filter((url) => stateAllowList.some((state) => url.includes(`/${state}/`)));
      console.log(
        `[hpcl-provider] Phase A: ${districtUrls.length}/${allDistrictUrls.length} district files to walk` +
          (stateAllowList.length ? ` (state allow-list: ${stateAllowList.join(",")})` : ""),
      );

      const outletUrls: string[] = [];
      let districtsWalked = 0;
      await runDynamicQueue<string>(
        [...districtUrls],
        Math.max(1, config.discoveryConcurrency ?? 1),
        config.discoveryDelayMs ?? 1200,
        () => false,
        async (districtUrl) => {
          const urls = await fetchDistrictHomeUrls(districtUrl, config.fetchImpl ?? fetch);
          outletUrls.push(...urls); // safe: plain array push, single JS thread
          districtsWalked++;
          if (districtsWalked % 50 === 0 || districtsWalked === districtUrls.length) {
            console.log(
              `[hpcl-provider] Phase A: ${districtsWalked}/${districtUrls.length} districts walked, ${outletUrls.length} outlet URLs so far`,
            );
          }
        },
        () => {},
      );

      await writeFile(urlsCachePath, JSON.stringify(outletUrls, null, 2), "utf-8");
      console.log(`[hpcl-provider] Phase A done: ${outletUrls.length} outlet URLs written to ${urlsCachePath}`);
      for (const url of outletUrls) yield { id: url, payload: url };
    },

    async process(unit, ctx): Promise<ProcessResult> {
      const sourceUrl = unit.payload as string;
      try {
        const res = await ctx.fetch(sourceUrl);
        if (!res.ok) {
          logErr("httpFailed", `HTTP ${res.status}`, sourceUrl);
          return { status: "httpFailed", detail: `HTTP ${res.status}`, records: [] };
        }
        const html = await res.text();

        const metadata = await parseOutletHtml(html, sourceUrl);
        if (!metadata) return { status: "parsedNull", records: [] };

        const outletId = outletIdFromUrl(sourceUrl);
        const masterOutletId = extractMasterOutletId(html);
        if (!masterOutletId || !outletId) {
          // Metadata parsed fine but no price fetch is possible — must
          // still be retried (not a permanent state), so this is "errored"
          // rather than "ok"/"empty".
          logErr("errored", "noMasterOutletId", sourceUrl);
          return { status: "errored", detail: "noMasterOutletId", records: [] };
        }

        await sleep(REQUEST_DELAY_MS);
        const priceUrl = buildPriceUrl(masterOutletId, outletId);
        const priceRes = await ctx.fetch(priceUrl, {
          headers: { "x-requested-with": "XMLHttpRequest", Referer: sourceUrl },
        });
        if (!priceRes.ok) {
          logErr("errored", `priceFailed: HTTP ${priceRes.status}`, sourceUrl);
          return { status: "errored", detail: `priceFailed: HTTP ${priceRes.status}`, records: [] };
        }
        const priceHtml = await priceRes.text();
        const priceFragment = parseHpclPriceFragment(priceHtml);
        const capturedAt = ctx.now();
        const record = buildRawRecord({ ...metadata, capturedAt }, priceMapToProducts(priceFragment));
        return { status: "ok", records: [record] };
      } catch (err) {
        console.error(`[hpcl] connection error on ${sourceUrl}:`, String(err));
        return { status: "errored", detail: String(err), records: [] };
      }
    },
  };
}
