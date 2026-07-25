/**
 * `pnpm census:shell` — a full NATIONAL Shell outlet census via
 * shell.in's locator (see docs/shell-api.md for the reverse-engineered
 * reference this scraper is built from).
 *
 * A thin CLI entrypoint: build the Shell `Provider`
 * (./providers/shell-provider.ts — bbox-walk discovery + one detail call
 * per outlet), read this brand's own env vars, run it via the generic
 * `runProvider` (./run-provider.ts).
 *
 * Output: `output/shell-raw.jsonl` (grade-agnostic `RawOutletRecord`s) and
 * `output/shell-worklog.jsonl` (crawl-attempt bookkeeping, for
 * resumability only).
 *
 * Env vars:
 *  - SHELL_CENSUS_CONCURRENCY: number of concurrent lanes (default 5 — no
 *    rate limiting observed against shellretaillocator.geoapp.me, see
 *    docs/shell-api.md).
 *  - SHELL_CENSUS_LIMIT: stop after processing roughly this many NEW units
 *    this run (smoke-test only).
 *  - SHELL_CENSUS_MAX_AGE_DAYS: re-check anything older than this (default 3).
 *  - SHELL_CENSUS_STALE_AFTER_DAYS: drop baseline records not refreshed
 *    within this many days, so closed/removed stations age out (default 14).
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createShellProvider } from "./providers/shell-provider.js";
import { runProvider } from "./run-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../output");

const limit = process.env.SHELL_CENSUS_LIMIT ? Number(process.env.SHELL_CENSUS_LIMIT) : Infinity;
const concurrency = Math.max(1, Number(process.env.SHELL_CENSUS_CONCURRENCY ?? 5));
const maxAgeDays = process.env.SHELL_CENSUS_MAX_AGE_DAYS ? Number(process.env.SHELL_CENSUS_MAX_AGE_DAYS) : 3;
const staleAfterDays = process.env.SHELL_CENSUS_STALE_AFTER_DAYS
  ? Number(process.env.SHELL_CENSUS_STALE_AFTER_DAYS)
  : 14;

async function main(): Promise<void> {
  const provider = createShellProvider();

  const result = await runProvider(provider, {
    outputDir: OUTPUT_DIR,
    concurrency,
    maxAgeDays,
    staleAfterDays,
    limit,
  });

  console.log(`[census:shell] run segment done. processed=${result.processedThisRun} units this run.`);
  console.log(`[census:shell] raw: ${result.rawPath}`);
  console.log(`[census:shell] worklog: ${result.workLogPath}`);
  if (result.alreadyDone + result.processedThisRun < result.totalDiscovered) {
    console.log(
      `[census:shell] NOT finished — ${result.totalDiscovered - result.alreadyDone - result.processedThisRun} units remain. Re-run this same command to continue.`,
    );
  } else {
    console.log(`[census:shell] ALL discovered units processed for this run.`);
  }
}

// Without this, importing this module for its pure/testable exports would
// trigger a real network crawl + real file writes as a side effect.
const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[census:shell] fatal (safe to re-run — already-done units will be skipped):", err);
    process.exitCode = 1;
  });
}
