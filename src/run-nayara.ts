/**
 * `pnpm census:nayara` — a full NATIONAL Nayara Energy outlet census via
 * nayaraenergy.com's public locator (see docs/nayara-api.md for the
 * reverse-engineered reference this scraper is built from).
 *
 * A thin CLI entrypoint: build the Nayara `Provider`
 * (./providers/nayara-provider.ts — session bootstrap + two large-radius
 * calls, no grid/batching needed), read this brand's own env vars, run it
 * via the generic `runProvider` (./run-provider.ts).
 *
 * Output: `output/nayara-raw.jsonl` (grade-agnostic `RawOutletRecord`s) and
 * `output/nayara-worklog.jsonl` (crawl-attempt bookkeeping, for
 * resumability only).
 *
 * Env vars:
 *  - NAYARA_CENSUS_CONCURRENCY: number of concurrent lanes (default 1 — only
 *    two work units total, concurrency doesn't meaningfully speed this up).
 *  - NAYARA_CENSUS_LIMIT: stop after processing roughly this many NEW units
 *    this run (smoke-test only).
 *  - NAYARA_CENSUS_MAX_AGE_DAYS: re-check anything older than this (default 3).
 *  - NAYARA_CENSUS_STALE_AFTER_DAYS: drop baseline records not refreshed
 *    within this many days, so closed/removed stations age out (default 14).
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNayaraProvider } from "./providers/nayara-provider.js";
import { runProvider } from "./run-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../output");

const limit = process.env.NAYARA_CENSUS_LIMIT ? Number(process.env.NAYARA_CENSUS_LIMIT) : Infinity;
const concurrency = Math.max(1, Number(process.env.NAYARA_CENSUS_CONCURRENCY ?? 1));
const maxAgeDays = process.env.NAYARA_CENSUS_MAX_AGE_DAYS ? Number(process.env.NAYARA_CENSUS_MAX_AGE_DAYS) : 3;
const staleAfterDays = process.env.NAYARA_CENSUS_STALE_AFTER_DAYS
  ? Number(process.env.NAYARA_CENSUS_STALE_AFTER_DAYS)
  : 14;

async function main(): Promise<void> {
  const provider = createNayaraProvider();

  const result = await runProvider(provider, {
    outputDir: OUTPUT_DIR,
    concurrency,
    maxAgeDays,
    staleAfterDays,
    limit,
  });

  console.log(`[census:nayara] run segment done. processed=${result.processedThisRun} units this run.`);
  console.log(`[census:nayara] raw: ${result.rawPath}`);
  console.log(`[census:nayara] worklog: ${result.workLogPath}`);
  if (result.alreadyDone + result.processedThisRun < result.totalDiscovered) {
    console.log(
      `[census:nayara] NOT finished — ${result.totalDiscovered - result.alreadyDone - result.processedThisRun} units remain. Re-run this same command to continue.`,
    );
  } else {
    console.log(`[census:nayara] ALL discovered units processed for this run.`);
  }
}

// Without this, importing this module for its pure/testable exports would
// trigger a real network crawl + real file writes as a side effect.
const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[census:nayara] fatal (safe to re-run — already-done units will be skipped):", err);
    process.exitCode = 1;
  });
}
