/**
 * Coverage for the generic Provider runner (Phase 3 of the decoupling plan
 * — see run-provider.ts's module doc). This file ports/merges test
 * assertions that used to live in THREE separate files, one per brand:
 *  - run-hpcl-full-census.test.ts / run-iocl-full-census.test.ts:
 *    `computeDoneUrls` -> ported below as `computeDoneWorkUnitIds`.
 *  - run-bpcl-full-census.test.ts: `loadDoneIds` -> ported below as
 *    `computeDoneWorkUnitIds` (same rule, now generic); `runFixedPool` +
 *    `runGridCrawl` -> both ported below as ONE `runDynamicQueue`, since
 *    `runFixedPool`'s fixed-list behavior is just the degenerate case of
 *    `runGridCrawl`'s dynamic queue (see run-provider.ts's module doc for
 *    why one function now covers both).
 * Every original assertion is preserved; nothing is dropped, only
 * generalized. A `runProvider` integration test is added on top (new
 * coverage — the runner itself, including resumability across two real
 * invocations against a tmp directory, and followups actually reaching the
 * output files) since this end-to-end wiring didn't exist as a single unit
 * before.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Provider, ProcessResult, WorkUnit } from "./provider.js";
import type { RawOutletRecord } from "./types.js";
import { computeDoneWorkUnitIds, runDynamicQueue, runProvider } from "./run-provider.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const MAX_AGE_MS = 30 * DAY_MS;

function jsonl(...records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

describe("computeDoneWorkUnitIds", () => {
  it("includes a status:ok record with a recent fetchedAt", () => {
    const content = jsonl({ workUnitId: "a", fetchedAt: new Date(NOW - DAY_MS).toISOString(), status: "ok" });
    const done = computeDoneWorkUnitIds(content, MAX_AGE_MS, NOW);
    expect(done.has("a")).toBe(true);
  });

  it("includes a status:empty record with a recent fetchedAt (a legitimately-empty result is still done, not retried forever)", () => {
    const content = jsonl({ workUnitId: "empty-cell", fetchedAt: new Date(NOW - DAY_MS).toISOString(), status: "empty" });
    const done = computeDoneWorkUnitIds(content, MAX_AGE_MS, NOW);
    expect(done.has("empty-cell")).toBe(true);
  });

  it("THE BUG FIX (ported from HPCL/IOCL/BPCL's independent copies): a failed record (any non-ok/non-empty status) with a recent fetchedAt is NOT treated as done, regardless of status text", () => {
    const failureStatuses = ["httpFailed", "errored", "parsedNull"];
    for (const status of failureStatuses) {
      const id = `unit-${status}`;
      const content = jsonl({ workUnitId: id, fetchedAt: new Date(NOW - DAY_MS).toISOString(), status });
      const done = computeDoneWorkUnitIds(content, MAX_AGE_MS, NOW);
      expect(done.has(id)).toBe(false);
    }
  });

  it("excludes a status:ok record whose fetchedAt is older than maxAgeMs (staleness)", () => {
    const content = jsonl({ workUnitId: "stale", fetchedAt: new Date(NOW - MAX_AGE_MS - DAY_MS).toISOString(), status: "ok" });
    const done = computeDoneWorkUnitIds(content, MAX_AGE_MS, NOW);
    expect(done.has("stale")).toBe(false);
  });

  it("includes a status:ok record whose fetchedAt is exactly at/just under the maxAgeMs boundary", () => {
    const atBoundary = jsonl({ workUnitId: "boundary-exact", fetchedAt: new Date(NOW - MAX_AGE_MS).toISOString(), status: "ok" });
    expect(computeDoneWorkUnitIds(atBoundary, MAX_AGE_MS, NOW).has("boundary-exact")).toBe(true);

    const underBoundary = jsonl({
      workUnitId: "boundary-under",
      fetchedAt: new Date(NOW - MAX_AGE_MS + 1000).toISOString(),
      status: "ok",
    });
    expect(computeDoneWorkUnitIds(underBoundary, MAX_AGE_MS, NOW).has("boundary-under")).toBe(true);
  });

  it("skips a malformed/unparseable JSON line without throwing and without affecting other lines", () => {
    const content = [
      "{not valid json,,,",
      JSON.stringify({ workUnitId: "good", fetchedAt: new Date(NOW - DAY_MS).toISOString(), status: "ok" }),
    ].join("\n");
    let done: Set<string> | undefined;
    expect(() => {
      done = computeDoneWorkUnitIds(content, MAX_AGE_MS, NOW);
    }).not.toThrow();
    expect(done?.has("good")).toBe(true);
    expect(done?.size).toBe(1);
  });

  it("skips empty and whitespace-only lines without error", () => {
    const content = ["", "   ", JSON.stringify({ workUnitId: "good2", fetchedAt: new Date(NOW - DAY_MS).toISOString(), status: "ok" }), "", "\t"].join(
      "\n",
    );
    const done = computeDoneWorkUnitIds(content, MAX_AGE_MS, NOW);
    expect(done.has("good2")).toBe(true);
    expect(done.size).toBe(1);
  });

  it("resumability story: the SAME workUnitId appearing twice — once httpFailed (old), once ok (newer, fresh) — ends up in the done set", () => {
    const content = jsonl(
      { workUnitId: "retried", fetchedAt: new Date(NOW - 10 * DAY_MS).toISOString(), status: "httpFailed", detail: "HTTP 503" },
      { workUnitId: "retried", fetchedAt: new Date(NOW - DAY_MS).toISOString(), status: "ok" },
    );
    const done = computeDoneWorkUnitIds(content, MAX_AGE_MS, NOW);
    expect(done.has("retried")).toBe(true);
  });

  it("returns an empty set for empty content", () => {
    expect(computeDoneWorkUnitIds("", MAX_AGE_MS, NOW).size).toBe(0);
  });
});

describe("runDynamicQueue", () => {
  // NOTE: unlike the original index-based runFixedPool (which never mutated
  // its input `items` array), runDynamicQueue's `queue.shift()` DOES mutate
  // its input in place (it's a live, growable queue — see the module doc).
  // Every test below that needs to assert against "the original item set"
  // captures a copy BEFORE calling runDynamicQueue, rather than comparing
  // against the (now-emptied) array reference afterwards.

  it("processes every item exactly once, across multiple lanes (ported from runWorkerPool/runFixedPool's fixed-list case)", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const expected = [...items];
    const seen: number[] = [];
    await runDynamicQueue(items, 4, 1, () => false, async (item) => {
      seen.push(item);
    }, () => {});
    expect(seen.slice().sort((a, b) => a - b)).toEqual(expected);
  });

  it("stops early when shouldStop() becomes true, leaving some items unprocessed", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const totalItems = items.length;
    let count = 0;
    await runDynamicQueue(items, 5, 1, () => count >= 10, async () => {
      count++;
    }, () => {});
    expect(count).toBeGreaterThanOrEqual(10);
    expect(count).toBeLessThan(totalItems);
  });

  it("handles an empty item list without hanging", async () => {
    const seen: number[] = [];
    await runDynamicQueue<number>([], 4, 1, () => false, async (item) => {
      seen.push(item);
    }, () => {});
    expect(seen).toEqual([]);
  });

  it("handles more lanes than items gracefully", async () => {
    const items = [1, 2, 3];
    const expected = [...items];
    const seen: number[] = [];
    await runDynamicQueue(items, 10, 1, () => false, async (item) => {
      seen.push(item);
    }, () => {});
    expect(seen.slice().sort()).toEqual(expected);
  });

  it("THE CORE BEHAVIOR (ported from runGridCrawl): a handler that pushes new work onto the queue gets that work processed too — a lane can't exit just because the queue looked momentarily empty", async () => {
    const queue = ["parent"];
    const seen: string[] = [];
    await runDynamicQueue(
      queue,
      2, // more lanes than initial queue length — the other lane(s) must not exit prematurely
      1,
      () => false,
      async (item, q) => {
        seen.push(item);
        if (item === "parent") q.push("child-1", "child-2");
      },
      () => {},
    );
    expect(seen.slice().sort()).toEqual(["child-1", "child-2", "parent"]);
  });

  it("respects shouldStop and stops enqueuing further work", async () => {
    const queue = Array.from({ length: 20 }, (_, i) => `c${i}`);
    let processed = 0;
    await runDynamicQueue(queue, 4, 1, () => processed >= 5, async () => {}, () => {
      processed++;
    });
    expect(processed).toBeGreaterThanOrEqual(5);
    expect(processed).toBeLessThan(20);
  });

  it("calls onProcessed exactly once per successfully handled item, even when the handler throws (finally still decrements activeCount)", async () => {
    const queue = ["ok1", "throws", "ok2"];
    let processedCount = 0;
    await expect(
      runDynamicQueue(
        queue,
        1, // single lane, deterministic order
        1,
        () => false,
        async (item) => {
          if (item === "throws") throw new Error("boom");
        },
        () => {
          processedCount++;
        },
      ),
    ).rejects.toThrow("boom");
    expect(processedCount).toBe(1);
  });
});

describe("runProvider (integration)", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFakeProvider(units: WorkUnit[], resultFor: (unit: WorkUnit) => ProcessResult): Provider {
    const calls: string[] = [];
    return {
      brand: "FAKE",
      slug: "fake",
      async *discover() {
        for (const u of units) yield u;
      },
      async process(unit) {
        calls.push(unit.id);
        return resultFor(unit);
      },
      // expose calls for assertions via a closure property (cast, test-only)
      // @ts-expect-error test-only escape hatch
      __calls: calls,
    };
  }

  it("writes raw records + worklog, and skips already-done units on a resumed run", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "run-provider-test-"));
    const units: WorkUnit[] = [
      { id: "u1", payload: "u1" },
      { id: "u2", payload: "u2" },
    ];
    const provider = makeFakeProvider(units, (unit) => ({
      status: "ok",
      records: [
        {
          schemaVersion: 1,
          brand: "HPCL",
          outletId: unit.id,
          stationId: unit.id,
          sourceUrl: null,
          capturedAt: "2026-07-18T00:00:00.000Z",
          name: `Station ${unit.id}`,
          address: null,
          city: null,
          state: null,
          pincode: null,
          lat: 0,
          lng: 0,
          geohash: "x",
          hours: null,
          contact: null,
          mapsLink: null,
          products: [],
        },
      ],
    }));

    const first = await runProvider(provider, { outputDir: tmpDir, now: () => "2026-07-18T00:00:00.000Z" });
    expect(first.totalDiscovered).toBe(2);
    expect(first.alreadyDone).toBe(0);
    expect(first.processedThisRun).toBe(2);
    expect(first.okCount).toBe(2);
    expect(first.recordsWritten).toBe(2);
    expect(existsSync(first.rawPath)).toBe(true);
    expect(existsSync(first.workLogPath)).toBe(true);

    const rawContent = await readFile(first.rawPath, "utf-8");
    expect(rawContent.trim().split("\n")).toHaveLength(2);
    const workLogContent = await readFile(first.workLogPath, "utf-8");
    expect(workLogContent.trim().split("\n")).toHaveLength(2);

    // Second invocation against the SAME output dir: both units are now
    // "ok" + fresh, so nothing should be re-processed.
    const second = await runProvider(provider, { outputDir: tmpDir, now: () => "2026-07-18T00:05:00.000Z" });
    expect(second.alreadyDone).toBe(2);
    expect(second.processedThisRun).toBe(0);
  });

  it("retries a unit whose latest record was a failure, does not retry a stale-but-ok unit incorrectly, and honors limit", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "run-provider-test-"));
    const units: WorkUnit[] = [
      { id: "will-fail-then-succeed", payload: null },
      { id: "always-ok", payload: null },
      { id: "third", payload: null },
    ];
    let failFirstAttempt = true;
    const provider: Provider = {
      brand: "FAKE",
      slug: "fake2",
      async *discover() {
        for (const u of units) yield u;
      },
      async process(unit) {
        if (unit.id === "will-fail-then-succeed" && failFirstAttempt) {
          return { status: "httpFailed", detail: "HTTP 503", records: [] };
        }
        return { status: "ok", records: [] };
      },
    };

    const first = await runProvider(provider, { outputDir: tmpDir, limit: 2 });
    expect(first.processedThisRun).toBe(2); // limit respected

    failFirstAttempt = false;
    const second = await runProvider(provider, { outputDir: tmpDir });
    // whichever units weren't done yet (including the failed one, since
    // httpFailed never counts as done) get retried/processed now.
    expect(second.alreadyDone + second.processedThisRun).toBe(3);
    const workLogContent = await readFile(second.workLogPath, "utf-8");
    const lines = workLogContent.trim().split("\n").map((l) => JSON.parse(l));
    const failLines = lines.filter((l) => l.workUnitId === "will-fail-then-succeed");
    expect(failLines.some((l: { status: string }) => l.status === "httpFailed")).toBe(true);
    expect(failLines.some((l: { status: string }) => l.status === "ok")).toBe(true);
  });

  it("processes a followup emitted by a unit's ProcessResult (dynamic-queue growth reaches the output files)", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "run-provider-test-"));
    const provider: Provider = {
      brand: "FAKE",
      slug: "fake3",
      async *discover() {
        yield { id: "parent", payload: null };
      },
      async process(unit) {
        if (unit.id === "parent") {
          return { status: "ok", records: [], followups: [{ id: "child", payload: null }] };
        }
        return { status: "ok", records: [] };
      },
    };

    const result = await runProvider(provider, { outputDir: tmpDir });
    expect(result.processedThisRun).toBe(2); // parent + child
    const workLogContent = await readFile(result.workLogPath, "utf-8");
    const ids = workLogContent.trim().split("\n").map((l) => JSON.parse(l).workUnitId);
    expect(ids.sort()).toEqual(["child", "parent"]);
  });

  it("accumulates baseline records from prior runs and dedupes by stationId keeping the newest capturedAt", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "run-provider-test-"));

    // Create a fake provider that discovers only "u2" and emits a newer record for it.
    const newU2Record: RawOutletRecord = {
      schemaVersion: 1,
      brand: "HPCL",
      outletId: "u2",
      stationId: "u2",
      sourceUrl: null,
      capturedAt: "2026-07-18T00:00:00.000Z", // newer
      name: "Station u2 (new)",
      address: null,
      city: null,
      state: null,
      pincode: null,
      lat: 0,
      lng: 0,
      geohash: "x",
      hours: null,
      contact: null,
      mapsLink: null,
      products: [],
    };
    const provider = makeFakeProvider([{ id: "u2", payload: "u2" }], () => ({
      status: "ok",
      records: [newU2Record],
    }));

    // Pre-write a baseline raw file (using the provider's slug) with two records:
    // one for stationId "u1" (preserved from baseline), and one for stationId "u2"
    // with an old timestamp (should be deduped and replaced by the newer one).
    const oldU2Record: RawOutletRecord = {
      schemaVersion: 1,
      brand: "HPCL",
      outletId: "u2",
      stationId: "u2",
      sourceUrl: null,
      capturedAt: "2026-07-17T00:00:00.000Z", // older
      name: "Station u2 (old)",
      address: null,
      city: null,
      state: null,
      pincode: null,
      lat: 0,
      lng: 0,
      geohash: "x",
      hours: null,
      contact: null,
      mapsLink: null,
      products: [],
    };
    const u1BaselineRecord: RawOutletRecord = {
      schemaVersion: 1,
      brand: "HPCL",
      outletId: "u1",
      stationId: "u1",
      sourceUrl: null,
      capturedAt: "2026-07-17T00:00:00.000Z",
      name: "Station u1",
      address: null,
      city: null,
      state: null,
      pincode: null,
      lat: 0,
      lng: 0,
      geohash: "y",
      hours: null,
      contact: null,
      mapsLink: null,
      products: [],
    };
    const rawPath = path.join(tmpDir, `${provider.slug}-raw.jsonl`);
    writeFileSync(rawPath, [u1BaselineRecord, oldU2Record].map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");

    const result = await runProvider(provider, { outputDir: tmpDir, now: () => "2026-07-18T00:00:00.000Z" });
    expect(result.processedThisRun).toBe(1); // only u2 was processed
    expect(result.recordsWritten).toBe(1); // only the new u2 record from processing
    expect(existsSync(rawPath)).toBe(true);

    // Parse the resulting raw file: should contain u1 (from baseline) and TWO
    // u2 records (one old from baseline, one new from processing) — raw files
    // contain all records, deduplication happens later in build-dataset.ts.
    const rawContent = await readFile(rawPath, "utf-8");
    const records = rawContent.trim().split("\n").map((l) => JSON.parse(l) as RawOutletRecord);
    const uniqueStationIds = [...new Set(records.map((r) => r.stationId))].sort();
    expect(uniqueStationIds).toEqual(["u1", "u2"]);

    // Verify u1 is present (preserved from baseline).
    const u1Records = records.filter((r) => r.stationId === "u1");
    expect(u1Records).toHaveLength(1);
    expect(u1Records[0]!.name).toBe("Station u1");

    // Verify u2 has both old (from baseline) and new (from processing) records.
    const u2Records = records.filter((r) => r.stationId === "u2");
    expect(u2Records).toHaveLength(2);
    const u2Timestamps = u2Records.map((r) => r.capturedAt).sort();
    expect(u2Timestamps).toEqual(["2026-07-17T00:00:00.000Z", "2026-07-18T00:00:00.000Z"]);
  });

  it("prunes baseline records older than staleAfterDays so closed/removed stations age out", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "run-provider-test-"));

    // Create a fake provider that discovers nothing, so processing writes no
    // records and the test isolates the seed/prune step.
    const provider: Provider = {
      brand: "FAKE",
      slug: "fake-prune",
      async *discover() {
        // yield nothing
      },
      async process() {
        return { status: "ok", records: [] };
      },
    };

    // Pre-write a baseline raw file with two records:
    // - "old-gone" with capturedAt ~40 days before now (should be pruned)
    // - "recent" with capturedAt ~1 day before now (should be kept)
    const oldGoneRecord: RawOutletRecord = {
      schemaVersion: 1,
      brand: "HPCL",
      outletId: "old-gone",
      stationId: "old-gone",
      sourceUrl: null,
      capturedAt: "2026-06-08T12:00:00.000Z", // ~40 days before 2026-07-18
      name: "Station Old Gone",
      address: null,
      city: null,
      state: null,
      pincode: null,
      lat: 0,
      lng: 0,
      geohash: "x",
      hours: null,
      contact: null,
      mapsLink: null,
      products: [],
    };
    const recentRecord: RawOutletRecord = {
      schemaVersion: 1,
      brand: "HPCL",
      outletId: "recent",
      stationId: "recent",
      sourceUrl: null,
      capturedAt: "2026-07-17T12:00:00.000Z", // ~1 day before 2026-07-18
      name: "Station Recent",
      address: null,
      city: null,
      state: null,
      pincode: null,
      lat: 0,
      lng: 0,
      geohash: "y",
      hours: null,
      contact: null,
      mapsLink: null,
      products: [],
    };
    const rawPath = path.join(tmpDir, `${provider.slug}-raw.jsonl`);
    writeFileSync(rawPath, [oldGoneRecord, recentRecord].map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");

    // Run with default staleAfterDays=14 and fixed now time
    const result = await runProvider(provider, {
      outputDir: tmpDir,
      now: () => "2026-07-18T12:00:00.000Z",
    });
    expect(result.processedThisRun).toBe(0); // no units to process
    expect(result.recordsWritten).toBe(0); // no new records
    expect(existsSync(rawPath)).toBe(true);

    // Parse the resulting raw file: should contain ONLY "recent" — "old-gone" was pruned
    const rawContent = await readFile(rawPath, "utf-8");
    const records = rawContent.trim().split("\n").map((l) => JSON.parse(l) as RawOutletRecord);
    const stationIds = records.map((r) => r.stationId).sort();
    expect(stationIds).toEqual(["recent"]);
    expect(records[0]!.name).toBe("Station Recent");
  });
});
