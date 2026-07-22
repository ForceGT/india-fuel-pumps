/**
 * The generic runner behind every `Provider` (see provider.ts's module doc).
 * This is the single replacement for the ~90%-duplicated orchestration
 * logic that used to live independently in `run-hpcl-full-census.ts`,
 * `run-iocl-full-census.ts`, and `run-bpcl-full-census.ts`:
 *  - `computeDoneWorkUnitIds`: the resumability/staleness filter (was
 *    `computeDoneUrls` in HPCL/IOCL, `loadDoneIds` in BPCL — byte-identical
 *    logic, just keyed by `sourceUrl` vs a generic `idField` string).
 *  - `runDynamicQueue`: the worker pool (was `runWorkerPool`/`runFixedPool`
 *    for HPCL/IOCL/BPCL's fixed-list phase, `runGridCrawl` for BPCL's
 *    adaptive grid phase). `runGridCrawl`'s dynamic-queue + `activeCount`
 *    design is strictly more general — a fixed list is just the case where
 *    `handle` never pushes new work onto the queue — so ONE function now
 *    covers both, confirmed by reading the original `runGridCrawl` (see the
 *    dispatch prompt's "Confirmed facts" #1).
 *  - The serialized single-promise-chain JSONL writer (was
 *    `enqueueWrite`/`appendRecord`/`writeProgress`, duplicated three times).
 *  - The two output files: `{slug}-raw.jsonl` (from `ProcessResult.records`
 *    — pure `RawOutletRecord`s, no grade opinion) and `{slug}-worklog.jsonl`
 *    (from the unit's status/detail — `WorkLogRecord`, see
 *    packages/core/src/raw.ts), replacing each brand's bespoke
 *    `{brand}-census.jsonl` / `bpcl-census-{routes,cells,outlets}.jsonl`
 *    output shapes with one uniform pair every brand now shares. This is
 *    also exactly the input `fold-raw.ts`'s `foldRaw()` already expects
 *    (`{brand}-raw.jsonl`, deduped by `stationId`) — see that file.
 *
 * A brand-specific `run-{brand}-full-census.ts` is now just: build a
 * `Provider` (via its `providers/{brand}-provider.ts` factory), read its own
 * env vars, and call `runProvider(provider, opts)`.
 */
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import path from "node:path";
import type { RawOutletRecord, WorkLogRecord } from "./types.js";
import { fetchWithBackoff, sleep } from "./http.js";
import type { Provider, ProviderContext, WorkUnit } from "./provider.js";

/**
 * Pure filtering logic, no fs dependency — independently unit-testable with
 * literal JSONL fixtures (see run-provider.test.ts). This is the exact same
 * bug-fixed rule every brand's resumability check already enforced
 * separately (`computeDoneUrls` in HPCL/IOCL, `loadDoneIds` in BPCL): a
 * `WorkUnit` only counts as "done" (skip on resume) if its LATEST record's
 * `status` is `"ok"` or `"empty"` (both mean "fully processed," the latter
 * meaning "processed and legitimately yielded nothing," e.g. BPCL's
 * "NoDataFoundError" 404 over open ocean) AND `fetchedAt` is within
 * `maxAgeMs` of `nowMs`. Any other status (`httpFailed`/`parsedNull`/
 * `errored`) is NEVER treated as done, regardless of recency — a transient
 * failure must always be retried on the next run, or it becomes a permanent
 * silent gap (the exact bug class documented in
 * docs/research/scraper-stability-analysis.md). The same `workUnitId` can
 * appear multiple times across retries; lines are processed in file order,
 * so a later ok/fresh line correctly overrides an earlier failed one.
 */
export function computeDoneWorkUnitIds(jsonlContent: string, maxAgeMs: number, nowMs: number): Set<string> {
  const done = new Set<string>();
  for (const line of jsonlContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as WorkLogRecord;
      const fetchedAtMs = typeof rec.fetchedAt === "string" ? Date.parse(rec.fetchedAt) : NaN;
      const fresh = Number.isFinite(fetchedAtMs) && nowMs - fetchedAtMs <= maxAgeMs;
      if ((rec.status === "ok" || rec.status === "empty") && fresh) done.add(rec.workUnitId);
    } catch {
      // Malformed line (e.g. a torn write from a kill -9 mid-write) — ignore
      // and let this unit be re-processed; better a duplicate than a gap.
    }
  }
  return done;
}

/**
 * Generic dynamic-queue worker pool: `lanes` concurrent lanes pull from the
 * FRONT of a shared, mutable `queue` array until it's empty AND no lane is
 * still mid-`handle()` (`activeCount === 0`) — a lane can't exit just
 * because the queue looked momentarily empty, since a sibling lane's
 * in-flight `handle()` call might be about to push more work onto it (BPCL's
 * grid subdivision). This is `runGridCrawl` generalized: when `handle` never
 * pushes onto `queue`, this degenerates exactly to the old fixed-list
 * `runWorkerPool`/`runFixedPool` behavior — every item processed once, no
 * dynamic growth — which is how HPCL/IOCL use it. Lane `i`'s first
 * iteration waits `i * (perLaneDelayMs / lanes)` before its first request so
 * `lanes` lanes starting together don't all hit the server in the same
 * instant.
 *
 * `handle` receives the live `queue` so it can push followups; a throw from
 * `handle` propagates out of this function entirely (no internal try/catch —
 * every real provider's `process()` already catches its own errors and
 * reports them as an `errored` ProcessResult, matching the original
 * `runGridCrawl`'s documented behavior).
 */
export async function runDynamicQueue<T>(
  queue: T[],
  lanes: number,
  perLaneDelayMs: number,
  shouldStop: () => boolean,
  handle: (item: T, queue: T[]) => Promise<void>,
  onProcessed: () => void,
): Promise<void> {
  let activeCount = 0;
  const stagger = perLaneDelayMs / lanes;

  async function lane(laneId: number): Promise<void> {
    if (laneId > 0) await sleep(laneId * stagger);
    let first = true;
    for (;;) {
      if (shouldStop()) return;
      if (queue.length === 0) {
        if (activeCount === 0) return;
        await sleep(200);
        continue;
      }
      const item = queue.shift() as T;
      activeCount++;
      if (!first) await sleep(perLaneDelayMs);
      first = false;
      try {
        await handle(item, queue);
        onProcessed();
      } finally {
        activeCount--;
      }
    }
  }

  // Always spawn exactly `lanes` lanes (matching the original runGridCrawl,
  // not runFixedPool's Math.min(lanes, items.length)) — the queue can grow
  // dynamically via followups, so a lane idle at start might still have
  // work to do later; an idle lane with nothing to do simply sees an empty
  // queue + activeCount === 0 and returns immediately (harmless).
  await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)));
}

export interface RunProviderOptions {
  /** Directory both output files (and any provider-internal cache, e.g. HPCL's discovered-URL list) are written into. Created if missing. */
  outputDir: string;
  /** Forwarded to `provider.discover()` verbatim. */
  discoverOpts?: Record<string, string>;
  /** Concurrent lanes. Each lane paces itself at `perLaneDelayMs`, so N lanes multiplies the aggregate request rate by N — same politeness contract every scraper in this repo has always had. Default 1. */
  concurrency?: number;
  /** Politeness floor per lane, ms. Default 1200 (every scraper in this repo's existing floor). */
  perLaneDelayMs?: number;
  /** A unit whose last "ok"/"empty" record is older than this many days is treated as NOT done and re-processed. Default 3. */
  maxAgeDays?: number;
  /** Stop after processing roughly this many NEW units this run (smoke-test only). Under concurrency this is a soft cap. Default Infinity. */
  limit?: number;
  /** Injectable for tests. Defaults to the real clock. */
  now?: () => string;
  /** Log + write a progress line every N processed units. Default 25. */
  progressEvery?: number;
  /** Injectable for tests, so a suite doesn't wait out real politeness delays. Defaults to the real fetchWithBackoff. */
  fetchImpl?: typeof fetchWithBackoff;
}

export interface RunProviderResult {
  totalDiscovered: number;
  alreadyDone: number;
  processedThisRun: number;
  okCount: number;
  recordsWritten: number;
  rawPath: string;
  workLogPath: string;
}

/**
 * ONE serialized write queue per run, for every write this run performs
 * (raw records, worklog entries, progress) — a single promise chain
 * guarantees strict ordering, so concurrent lanes can never interleave or
 * corrupt either output file. Mirrors the identical pattern each of the
 * three original census scripts had independently (`enqueueWrite`).
 */
function createWriter(rawPath: string, workLogPath: string, progressPath: string) {
  let writeChain: Promise<void> = Promise.resolve();
  function enqueue(fn: () => Promise<void>): Promise<void> {
    writeChain = writeChain.then(fn, fn); // run fn even if a prior write somehow rejected
    return writeChain;
  }
  return {
    appendRecords(records: unknown[]): Promise<void> {
      if (records.length === 0) return writeChain;
      return enqueue(() => appendFile(rawPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8"));
    },
    appendWorkLog(record: WorkLogRecord): Promise<void> {
      return enqueue(() => appendFile(workLogPath, JSON.stringify(record) + "\n", "utf-8"));
    },
    writeProgress(line: string): Promise<void> {
      return enqueue(() => writeFile(progressPath, line + `\nlast update: ${new Date().toISOString()}\n`, "utf-8"));
    },
  };
}

async function loadAlreadyDone(workLogPath: string, maxAgeMs: number, nowMs: number): Promise<Set<string>> {
  if (!existsSync(workLogPath)) return new Set();
  const raw = await readFile(workLogPath, "utf-8");
  return computeDoneWorkUnitIds(raw, maxAgeMs, nowMs);
}

/**
 * Load baseline `RawOutletRecord[]` from the raw path, streaming to handle
 * large files (~90 MB uncompressed for BPCL) without blowing memory. Tries
 * `{rawPath}.gz` first (git-committed compressed files take priority), then
 * falls back to uncompressed `{rawPath}` if it exists, else returns `[]`.
 * Skips blank/malformed lines with try/catch, mirroring `build-dataset.ts`'s
 * identical `readRawJsonl` logic.
 */
async function readBaselineRawJsonl(rawPath: string): Promise<RawOutletRecord[]> {
  const gzPath = `${rawPath}.gz`;
  const readPath = existsSync(gzPath) ? gzPath : existsSync(rawPath) ? rawPath : null;
  if (!readPath) return [];

  const records: RawOutletRecord[] = [];
  const input = readPath.endsWith(".gz")
    ? createReadStream(readPath).pipe(createGunzip())
    : createReadStream(readPath);
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RawOutletRecord);
    } catch {
      // Skip malformed/torn lines (e.g. from kill -9 mid-write).
    }
  }
  return records;
}

/**
 * Dedupe a `RawOutletRecord[]` by `stationId`, keeping, per unique stationId,
 * the record with the greatest `capturedAt` (string compare, same rule as
 * `build-dataset.ts`'s `dedupeByStationId`). This ensures baseline records
 * from prior runs are preserved in order, with only the freshest capture
 * per station.
 */
function dedupeByStationId(records: RawOutletRecord[]): RawOutletRecord[] {
  const byId = new Map<string, RawOutletRecord>();
  for (const rec of records) {
    const existing = byId.get(rec.stationId);
    if (!existing || rec.capturedAt > existing.capturedAt) {
      byId.set(rec.stationId, rec);
    }
  }
  return [...byId.values()];
}

/**
 * Run one `Provider` end-to-end: discover -> filter already-done -> process
 * via a concurrent dynamic queue -> write `{slug}-raw.jsonl` /
 * `{slug}-worklog.jsonl` (+ a `{slug}-progress.txt`). Safe to re-run: only
 * NEW/failed/stale units are re-processed (see `computeDoneWorkUnitIds`).
 */
export async function runProvider(provider: Provider, opts: RunProviderOptions): Promise<RunProviderResult> {
  const {
    outputDir,
    discoverOpts = {},
    concurrency = 1,
    perLaneDelayMs = 1200,
    maxAgeDays = 3,
    limit = Infinity,
    now = () => new Date().toISOString(),
    progressEvery = 25,
    fetchImpl = fetchWithBackoff,
  } = opts;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  await mkdir(outputDir, { recursive: true });
  const rawPath = path.join(outputDir, `${provider.slug}-raw.jsonl`);
  const workLogPath = path.join(outputDir, `${provider.slug}-worklog.jsonl`);
  const progressPath = path.join(outputDir, `${provider.slug}-progress.txt`);
  const writer = createWriter(rawPath, workLogPath, progressPath);

  const ctx: ProviderContext = { fetch: fetchImpl, now };
  if (provider.init) await provider.init(ctx);

  const allUnits: WorkUnit[] = [];
  for await (const unit of provider.discover(discoverOpts)) allUnits.push(unit);

  const alreadyDone = await loadAlreadyDone(workLogPath, maxAgeMs, Date.parse(now()));
  const queue = allUnits.filter((u) => !alreadyDone.has(u.id));

  // ── SEED baseline records from prior runs into the raw file ──
  // This ensures resumable runs ACCUMULATE onto prior data instead of
  // replacing it. We load the baseline fully into memory BEFORE writing
  // rawPath, since the baseline source might BE rawPath (uncompressed).
  // Seeding is separate from processing — these records are NOT counted in
  // the run's recordsWritten/okCount/processedThisRun counters.
  const baselineRecords = await readBaselineRawJsonl(rawPath);
  const dedupedBaseline = dedupeByStationId(baselineRecords);
  if (dedupedBaseline.length > 0) {
    const baselineContent = dedupedBaseline.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(rawPath, baselineContent, "utf-8");
    console.log(`[${provider.slug}-provider] seeded ${dedupedBaseline.length} baseline records`);
  }

  console.log(
    `[${provider.slug}-provider] ${allUnits.length} total units, ${alreadyDone.size} already done, ${queue.length} pending — concurrency=${concurrency}`,
  );

  let processed = 0;
  let okCount = 0;
  let recordsWritten = 0;
  const startedAt = Date.now();

  await runDynamicQueue<WorkUnit>(
    queue,
    Math.max(1, concurrency),
    perLaneDelayMs,
    () => processed >= limit,
    async (unit, q) => {
      const result = await provider.process(unit, ctx);
      const fetchedAt = now();

      await writer.appendRecords(result.records);
      await writer.appendWorkLog({
        workUnitId: unit.id,
        status: result.status,
        recordCount: result.records.length,
        ...(result.saturated !== undefined ? { saturated: result.saturated } : {}),
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        fetchedAt,
      });

      if (result.followups && result.followups.length > 0) q.push(...result.followups);

      processed++;
      if (result.status === "ok" || result.status === "empty") okCount++;
      recordsWritten += result.records.length;

      if (processed % progressEvery === 0) {
        const elapsedMin = (Date.now() - startedAt) / 60000;
        const line =
          `[${provider.slug}-provider] ${processed} units processed this run ` +
          `(ok=${okCount} records=${recordsWritten}) elapsed=${elapsedMin.toFixed(1)}min` +
          (q.length > 0 ? ` queued=${q.length}` : "");
        console.log(line);
        await writer.writeProgress(line);
      }
    },
    () => {
      // onProcessed is folded into the handle() body above (we need result
      // fields there, not just a bump), so this is intentionally a no-op —
      // kept only because runDynamicQueue's signature always calls it.
    },
  );

  console.log(
    `[${provider.slug}-provider] run segment done. processed=${processed} ok=${okCount} records=${recordsWritten}`,
  );
  console.log(`[${provider.slug}-provider] raw: ${rawPath}`);
  console.log(`[${provider.slug}-provider] worklog: ${workLogPath}`);

  return {
    totalDiscovered: allUnits.length,
    alreadyDone: alreadyDone.size,
    processedThisRun: processed,
    okCount,
    recordsWritten,
    rawPath,
    workLogPath,
  };
}
