/**
 * `pnpm census:jiobp` — a full NATIONAL Jio-bp outlet census via the
 * Jio-bp (RBML) mobility API (see docs/jiobp-api.md for the reverse-engineered
 * reference this scraper is built from).
 *
 * A thin CLI entrypoint: build the Jio-bp `Provider`
 * (./providers/jiobp-provider.ts — one ROMaster index call, then batched
 * FindFuelStation calls), read this brand's own env vars, run it via the
 * generic `runProvider` (./run-provider.ts).
 *
 * Unlike HPCL/IOCL/BPCL, the whole national census is only ~dozens of
 * batched requests (2294 stations / batchSize), so a low default
 * concurrency is deliberately conservative — this is a private customer-app
 * backend, not a public store locator (see docs/jiobp-api.md's "Ethics /
 * authorization" note).
 *
 * Output: `output/jiobp-raw.jsonl` (grade-agnostic `RawOutletRecord`s) and
 * `output/jiobp-worklog.jsonl` (crawl-attempt bookkeeping, for resumability
 * only).
 *
 * Env vars:
 *  - JIOBP_CENSUS_CONCURRENCY: number of concurrent lanes (default 2).
 *  - JIOBP_CENSUS_LIMIT: stop after processing roughly this many NEW batches
 *    this run (smoke-test only).
 *  - JIOBP_CENSUS_BATCH_SIZE: station codes per FindFuelStation call
 *    (default 18, matching the app's observed batch size).
 *  - JIOBP_CENSUS_MAX_AGE_DAYS: re-check anything older than this (default 3).
 *  - JIOBP_CENSUS_STALE_AFTER_DAYS: drop baseline records not refreshed
 *    within this many days, so closed/removed stations age out (default 14).
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiobpProvider } from "./providers/jiobp-provider.js";
import { runProvider } from "./run-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../output");

const limit = process.env.JIOBP_CENSUS_LIMIT ? Number(process.env.JIOBP_CENSUS_LIMIT) : Infinity;
const concurrency = Math.max(1, Number(process.env.JIOBP_CENSUS_CONCURRENCY ?? 2));
const batchSize = process.env.JIOBP_CENSUS_BATCH_SIZE ? Number(process.env.JIOBP_CENSUS_BATCH_SIZE) : 18;
const maxAgeDays = process.env.JIOBP_CENSUS_MAX_AGE_DAYS ? Number(process.env.JIOBP_CENSUS_MAX_AGE_DAYS) : 3;
const staleAfterDays = process.env.JIOBP_CENSUS_STALE_AFTER_DAYS
  ? Number(process.env.JIOBP_CENSUS_STALE_AFTER_DAYS)
  : 14;

async function main(): Promise<void> {
  const provider = createJiobpProvider({ batchSize });

  const result = await runProvider(provider, {
    outputDir: OUTPUT_DIR,
    concurrency,
    maxAgeDays,
    staleAfterDays,
    limit,
  });

  console.log(`[census:jiobp] run segment done. processed=${result.processedThisRun} batches this run.`);
  console.log(`[census:jiobp] raw: ${result.rawPath}`);
  console.log(`[census:jiobp] worklog: ${result.workLogPath}`);
  if (result.alreadyDone + result.processedThisRun < result.totalDiscovered) {
    console.log(
      `[census:jiobp] NOT finished — ${result.totalDiscovered - result.alreadyDone - result.processedThisRun} batches remain. Re-run this same command to continue.`,
    );
  } else {
    console.log(`[census:jiobp] ALL discovered batches processed for this run.`);
  }
}

// Without this, importing this module for its pure/testable exports would
// trigger a real network crawl + real file writes as a side effect.
const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[census:jiobp] fatal (safe to re-run — already-done batches will be skipped):", err);
    process.exitCode = 1;
  });
}
