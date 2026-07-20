/**
 * `pnpm census:bpcl` — a full NATIONAL BPCL outlet census via
 * api.cep.bpcl.in.
 *
 * A thin CLI entrypoint: build the BPCL `Provider`
 * (./providers/bpcl-provider.ts — route mesh + adaptive grid fallback, both
 * phases merged into one discover() stream), read this brand's own env
 * vars, run it via the generic `runProvider` (./run-provider.ts).
 *
 * Output: `output/bpcl-raw.jsonl` (grade-agnostic `RawOutletRecord`s,
 * routes + cells both included — a station's provenance, if needed, is
 * discoverable from `output/bpcl-worklog.jsonl`'s `workUnitId`, which is
 * either a `<City>-><City>#<n>` route-chunk id or a
 * `d<depth>:<lat>:<lng>:<radiusM>` cell id) and `output/bpcl-worklog.jsonl`
 * (crawl-attempt bookkeeping).
 *
 * Env vars:
 *  - BPCL_CENSUS_CONCURRENCY, BPCL_CENSUS_LIMIT, BPCL_CENSUS_MAX_AGE_DAYS,
 *    BPCL_CENSUS_MAX_DEPTH, BPCL_CENSUS_BOUNDS, BPCL_CENSUS_SKIP_ROUTES,
 *    BPCL_CENSUS_SKIP_GRID.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBpclProvider } from "./providers/bpcl-provider.js";
import { runProvider } from "./run-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../output");

const limit = process.env.BPCL_CENSUS_LIMIT ? Number(process.env.BPCL_CENSUS_LIMIT) : Infinity;
const concurrency = Math.max(1, Number(process.env.BPCL_CENSUS_CONCURRENCY ?? 1));
const maxAgeDays = process.env.BPCL_CENSUS_MAX_AGE_DAYS ? Number(process.env.BPCL_CENSUS_MAX_AGE_DAYS) : 30;
const maxDepth = process.env.BPCL_CENSUS_MAX_DEPTH ? Number(process.env.BPCL_CENSUS_MAX_DEPTH) : 4;
const skipRoutes = process.env.BPCL_CENSUS_SKIP_ROUTES === "1";
const skipGrid = process.env.BPCL_CENSUS_SKIP_GRID === "1";

const DEFAULT_INDIA_BOUNDS = { minLat: 6.5, maxLat: 37.5, minLng: 68, maxLng: 97.5 };
function parseBoundsEnv(raw: string | undefined): typeof DEFAULT_INDIA_BOUNDS {
  if (!raw) return DEFAULT_INDIA_BOUNDS;
  const [minLat, maxLat, minLng, maxLng] = raw.split(",").map(Number);
  if ([minLat, maxLat, minLng, maxLng].some((n) => !Number.isFinite(n))) {
    throw new Error(`BPCL_CENSUS_BOUNDS malformed: "${raw}" (expected "minLat,maxLat,minLng,maxLng")`);
  }
  return { minLat: minLat!, maxLat: maxLat!, minLng: minLng!, maxLng: maxLng! };
}
const bounds = parseBoundsEnv(process.env.BPCL_CENSUS_BOUNDS);

async function main(): Promise<void> {
  const provider = createBpclProvider({ bounds, maxDepth, skipRoutes, skipGrid });

  const result = await runProvider(provider, {
    outputDir: OUTPUT_DIR,
    concurrency,
    maxAgeDays,
    limit,
  });

  console.log(`[census:bpcl] run segment done. processed=${result.processedThisRun} units this run.`);
  console.log(`[census:bpcl] raw: ${result.rawPath}`);
  console.log(`[census:bpcl] worklog: ${result.workLogPath}`);
  if (result.alreadyDone + result.processedThisRun < result.totalDiscovered) {
    console.log(
      `[census:bpcl] NOT finished — ${result.totalDiscovered - result.alreadyDone - result.processedThisRun} units remain (routes+cells combined, subdivided cells not yet counted). Re-run this same command to continue.`,
    );
  } else {
    console.log(`[census:bpcl] ALL discovered units processed for this run.`);
  }
}

// Without this, importing this module for its pure/testable exports would
// trigger a real network crawl + real file writes as a side effect.
const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[census:bpcl] fatal (safe to re-run — already-done outlets will be skipped):", err);
    process.exitCode = 1;
  });
}
