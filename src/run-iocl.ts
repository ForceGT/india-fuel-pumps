/**
 * `pnpm census:iocl` — a full NATIONAL IOCL outlet census.
 *
 * ⚠️ `locator.iocl.com` is sensitive to concurrent request load — start at
 * IOCL_CENSUS_CONCURRENCY=10 (proven safe from live testing) and back off
 * immediately if you see sustained failures rather than stepping up.
 *
 * See run-hpcl.ts's module doc for the shared design (Provider + generic
 * runner, output files, resumability rules) — this is the IOCL twin.
 *
 * Env vars: IOCL_CENSUS_CONCURRENCY, IOCL_CENSUS_LIMIT,
 * IOCL_CENSUS_STATE_ALLOWLIST, IOCL_CENSUS_MAX_AGE_DAYS, IOCL_CENSUS_STALE_AFTER_DAYS — same meaning as
 * their HPCL_ counterparts.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createIoclProvider } from "./providers/iocl-provider.js";
import { runProvider } from "./run-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../output");

const stateAllowList = (process.env.IOCL_CENSUS_STATE_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const limit = process.env.IOCL_CENSUS_LIMIT ? Number(process.env.IOCL_CENSUS_LIMIT) : Infinity;
const concurrency = Math.max(1, Number(process.env.IOCL_CENSUS_CONCURRENCY ?? 1));
const maxAgeDays = process.env.IOCL_CENSUS_MAX_AGE_DAYS ? Number(process.env.IOCL_CENSUS_MAX_AGE_DAYS) : 3;
const staleAfterDays = process.env.IOCL_CENSUS_STALE_AFTER_DAYS ? Number(process.env.IOCL_CENSUS_STALE_AFTER_DAYS) : 14;

async function main(): Promise<void> {
  const provider = createIoclProvider({
    outputDir: OUTPUT_DIR,
    stateAllowList,
    discoveryConcurrency: concurrency,
  });

  const result = await runProvider(provider, {
    outputDir: OUTPUT_DIR,
    concurrency,
    maxAgeDays,
    staleAfterDays,
    limit,
  });

  if (result.alreadyDone + result.processedThisRun < result.totalDiscovered) {
    console.log(
      `[census:iocl] NOT finished — ${result.totalDiscovered - result.alreadyDone - result.processedThisRun} outlets remain. Re-run this same command to continue; it will skip everything already done.`,
    );
  } else {
    console.log(`[census:iocl] ALL outlets processed. Census complete.`);
  }
}

const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[census:iocl] fatal (safe to re-run — already-done outlets will be skipped):", err);
    process.exitCode = 1;
  });
}
