/**
 * Reads `output/{hpcl,iocl,bpcl}-raw.jsonl`, dedupes each brand's records by
 * `stationId` (latest `capturedAt` wins), merges all brands, groups by
 * 3-character geohash prefix, and writes content-hashed shard files to
 * `dataset/shards/` plus a `dataset/index.json` manifest.
 *
 * No grade filtering — this is an all-pumps, all-products dataset. Grade
 * classification is a downstream consumer's opinion.
 *
 * Missing brand files are skipped gracefully (e.g. during a single-brand
 * calibration run). Zero-outlet output is a no-op (nothing written).
 *
 * Run: npm run build-dataset
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RawOutletRecord } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../output");
const DATASET_DIR = path.join(__dirname, "../dataset");
const SHARDS_DIR = path.join(DATASET_DIR, "shards");
const SHARD_PREFIX_LENGTH = 3;

const BRANDS = ["hpcl", "iocl", "bpcl"] as const;

async function readRawJsonl(filePath: string): Promise<RawOutletRecord[]> {
  if (!existsSync(filePath)) return [];
  const records: RawOutletRecord[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RawOutletRecord);
    } catch {
      // skip malformed/torn lines
    }
  }
  return records;
}

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

function contentHash(outlets: RawOutletRecord[]): string {
  return createHash("sha256").update(JSON.stringify(outlets)).digest("hex").slice(0, 16);
}

async function main(): Promise<void> {
  const allOutlets: RawOutletRecord[] = [];
  const brandCounts: Record<string, number> = {};

  for (const brand of BRANDS) {
    const filePath = path.join(OUTPUT_DIR, `${brand}-raw.jsonl`);
    const records = await readRawJsonl(filePath);
    const deduped = dedupeByStationId(records);
    brandCounts[brand] = deduped.length;
    allOutlets.push(...deduped);
    if (records.length === 0) {
      console.log(`[build-dataset] ${brand}: file missing — skipped`);
    } else {
      console.log(`[build-dataset] ${brand}: ${records.length} raw records → ${deduped.length} unique outlets`);
    }
  }

  const totalOutlets = allOutlets.length;
  console.log(`[build-dataset] total: ${totalOutlets} unique outlets`);

  if (totalOutlets === 0) {
    console.log("[build-dataset] no outlets to write — exiting without touching dataset/");
    return;
  }

  // Group by geohash prefix
  const byPrefix = new Map<string, RawOutletRecord[]>();
  for (const outlet of allOutlets) {
    const prefix = outlet.geohash.slice(0, SHARD_PREFIX_LENGTH);
    const group = byPrefix.get(prefix) ?? [];
    group.push(outlet);
    byPrefix.set(prefix, group);
  }

  // Clear old shards so stale files don't linger after outlets move/disappear
  if (existsSync(SHARDS_DIR)) {
    for (const f of readdirSync(SHARDS_DIR)) {
      rmSync(path.join(SHARDS_DIR, f));
    }
  } else {
    mkdirSync(SHARDS_DIR, { recursive: true });
  }

  const generatedAt = process.env.DATASET_GENERATED_AT ?? new Date().toISOString();
  const shardEntries: Array<{ prefix: string; file: string; count: number }> = [];

  for (const [prefix, outlets] of [...byPrefix.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Stable sort by stationId → deterministic content and hash
    const sorted = [...outlets].sort((a, b) => a.stationId.localeCompare(b.stationId));
    const hash = contentHash(sorted);
    const filename = `${prefix}.${hash}.json`;
    writeFileSync(path.join(SHARDS_DIR, filename), JSON.stringify({ prefix, outlets: sorted }));
    shardEntries.push({ prefix, file: `shards/${filename}`, count: sorted.length });
  }

  const index = {
    schemaVersion: 1,
    generatedAt,
    totalOutlets,
    brands: brandCounts,
    shards: shardEntries,
  };

  writeFileSync(path.join(DATASET_DIR, "index.json"), JSON.stringify(index, null, 2));
  console.log(`[build-dataset] wrote ${shardEntries.length} shards → dataset/index.json`);
}

main().catch((err) => {
  console.error("[build-dataset] fatal:", err);
  process.exitCode = 1;
});
