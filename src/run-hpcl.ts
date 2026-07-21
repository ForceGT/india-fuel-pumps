/**
 * `pnpm census:hpcl` — a full NATIONAL HPCL outlet census.
 *
 * Long-running (many hours), meant to be run standalone, typically
 * overnight. A thin CLI entrypoint: build the HPCL `Provider`
 * (./providers/hpcl-provider.ts), read this brand's own env vars, run it
 * via the generic `runProvider` (./run-provider.ts).
 *
 * Output: `output/hpcl-raw.jsonl` (grade-agnostic `RawOutletRecord`s) and
 * `output/hpcl-worklog.jsonl` (crawl-attempt bookkeeping, for resumability
 * only). The discovered-URL cache (`hpcl-discovered-urls.json`) is
 * provider-internal — see providers/hpcl-provider.ts.
 *
 * Resumability: only a status "ok"/"empty" AND fresh record counts as
 * done; anything else is retried on resume — see run-provider.ts's
 * `runProvider`/`computeDoneWorkUnitIds` doc comments.
 *
 * Env vars:
 *  - HPCL_CENSUS_CONCURRENCY: number of concurrent lanes (default 1).
 *  - HPCL_CENSUS_LIMIT: stop after processing roughly this many NEW outlets
 *    this run (smoke-test only).
 *  - HPCL_CENSUS_STATE_ALLOWLIST: comma-separated state slugs to restrict
 *    discovery to, for testing. Omit for the real run (all districts).
 *  - HPCL_CENSUS_MAX_AGE_DAYS: re-check anything older than this (default 3).
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHpclProvider } from "./providers/hpcl-provider.js";
import { runProvider } from "./run-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../output");

const stateAllowList = (process.env.HPCL_CENSUS_STATE_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const limit = process.env.HPCL_CENSUS_LIMIT ? Number(process.env.HPCL_CENSUS_LIMIT) : Infinity;
const concurrency = Math.max(1, Number(process.env.HPCL_CENSUS_CONCURRENCY ?? 1));
const maxAgeDays = process.env.HPCL_CENSUS_MAX_AGE_DAYS ? Number(process.env.HPCL_CENSUS_MAX_AGE_DAYS) : 3;

async function main(): Promise<void> {
  const provider = createHpclProvider({
    outputDir: OUTPUT_DIR,
    stateAllowList,
    discoveryConcurrency: concurrency,
  });

  const result = await runProvider(provider, {
    outputDir: OUTPUT_DIR,
    concurrency,
    maxAgeDays,
    limit,
  });

  if (result.alreadyDone + result.processedThisRun < result.totalDiscovered) {
    console.log(
      `[census:hpcl] NOT finished — ${result.totalDiscovered - result.alreadyDone - result.processedThisRun} outlets remain. Re-run this same command to continue; it will skip everything already done.`,
    );
  } else {
    console.log(`[census:hpcl] ALL outlets processed. Census complete.`);
  }
}

// Only run main() when this file is executed directly, not when it's
// imported — otherwise importing this module would trigger a real network
// crawl as a side effect.
const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[census:hpcl] fatal (safe to re-run — already-done outlets will be skipped):", err);
    process.exitCode = 1;
  });
}
