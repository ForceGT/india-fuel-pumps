/**
 * Reads `output/{hpcl,iocl,bpcl}-raw.jsonl`, dedupes each brand's records by
 * `stationId` (latest `capturedAt` wins), merges all brands, groups by
 * 3-character geohash prefix, and writes content-hashed shard files to
 * `dataset/shards/` plus a `dataset/index.json` manifest.
 *
 * Also emits `dataset/release-stats.json` (machine-readable current state)
 * and `dataset/release-notes.md` (human-readable diff vs the previous run)
 * so the GH Actions publish step can create a tagged GitHub Release with a
 * readable changelog.
 *
 * Partial-failure aware: brands whose raw JSONL is missing are tracked as
 * `missingBrands` and flagged in the release notes as "no data this run"
 * rather than being silently counted as zero — this prevents a single failed
 * census job from looking like every outlet of that brand disappeared.
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
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ── Types ──────────────────────────────────────────────────────────────────────

interface CurrentStats {
  generatedAt: string;
  totalOutlets: number;
  brands: Record<string, number>;
  shardCount: number;
  /** Brands whose raw JSONL was missing this run (census failed or was skipped). */
  missingBrands: string[];
}

interface ReleaseStats {
  previous: CurrentStats | null;
  current: CurrentStats;
}

// ── JSONL reader ───────────────────────────────────────────────────────────────

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

// ── Dedup ──────────────────────────────────────────────────────────────────────

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

// ── Release stats ──────────────────────────────────────────────────────────────

function readPreviousStats(): CurrentStats | null {
  const statsPath = path.join(DATASET_DIR, "release-stats.json");
  if (!existsSync(statsPath)) return null;
  try {
    const prev = JSON.parse(readFileSync(statsPath, "utf-8")) as ReleaseStats;
    return prev.current ?? null;
  } catch {
    return null;
  }
}

function deltaStr(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return "0";
}

function writeReleaseNotes(stats: ReleaseStats): void {
  const { previous: prev, current: cur } = stats;
  const lines: string[] = [];
  const dateLabel = cur.generatedAt.slice(0, 10);

  // ── Warning banner for missing brands ──
  if (cur.missingBrands.length > 0) {
    lines.push(
      `> ⚠️ **Partial dataset** — ${cur.missingBrands.map(b => b.toUpperCase()).join(", ")} did not produce data this run.`,
      "",
    );
    // If the missing brand HAD data in the previous release, call out that
    // this is a census failure, not a real drop.
    if (prev) {
      const missingWithPrior = cur.missingBrands.filter(b => (prev.brands[b] ?? 0) > 0);
      if (missingWithPrior.length > 0) {
        const parts = missingWithPrior.map(b => {
          const priorCount = prev.brands[b]?.toLocaleString() ?? "?";
          return `**${b.toUpperCase()}**: previous count was ${priorCount} — not dropped, just missing from this run`;
        });
        lines.push(`> ${parts.join("  \n> ")}`, "");
      }
    }
  }

  if (!prev) {
    // ── First-ever publish — baseline snapshot ──
    lines.push(`## Dataset baseline — ${dateLabel}`, "");
    const activeBrands = Object.entries(cur.brands).filter(([, count]) => count > 0).length;
    lines.push(
      `**${cur.totalOutlets.toLocaleString()}** outlets across **${activeBrands}** brands, split into **${cur.shardCount}** geohash shards.`,
      "",
    );
    lines.push("| Brand | Outlets |");
    lines.push("|-------|--------:|");
    for (const brand of BRANDS) {
      const count = cur.brands[brand] ?? 0;
      if (cur.missingBrands.includes(brand)) {
        lines.push(`| ${brand.toUpperCase()} | ⚠️ *no data* |`);
      } else if (count > 0) {
        lines.push(`| ${brand.toUpperCase()} | ${count.toLocaleString()} |`);
      }
    }
  } else {
    // ── Subsequent publish — show diff ──
    const totalDelta = cur.totalOutlets - prev.totalOutlets;
    const shardDelta = cur.shardCount - prev.shardCount;

    lines.push(`## Census update — ${dateLabel}`, "");
    lines.push("### Summary", "");
    lines.push("| Metric | Before | After | Δ |");
    lines.push("|--------|-------:|------:|--:|");
    lines.push(
      `| **Total outlets** | ${prev.totalOutlets.toLocaleString()} | ${cur.totalOutlets.toLocaleString()} | **${deltaStr(totalDelta)}** |`,
    );
    lines.push(
      `| **Shards** | ${prev.shardCount} | ${cur.shardCount} | ${deltaStr(shardDelta)} |`,
    );
    lines.push("");

    // Per-brand breakdown
    lines.push("### Per brand", "");
    const allBrands = new Set([...Object.keys(prev.brands), ...Object.keys(cur.brands)]);
    for (const brand of cur.missingBrands) allBrands.add(brand);
    const sortedBrands = [...allBrands].sort();
    lines.push("| Brand | Before | After | Δ |");
    lines.push("|-------|-------:|------:|--:|");
    for (const brand of sortedBrands) {
      const before = prev.brands[brand] ?? 0;
      if (cur.missingBrands.includes(brand)) {
        // Brand is absent this run — flag, don't pretend it dropped to 0.
        const beforeStr = before > 0 ? before.toLocaleString() : "—";
        lines.push(`| ${brand.toUpperCase()} | ${beforeStr} | ⚠️ *no data* | — |`);
      } else {
        const after = cur.brands[brand] ?? 0;
        const delta = after - before;
        const icon = delta > 0 ? "📈" : delta < 0 ? "📉" : "—";
        lines.push(
          `| ${brand.toUpperCase()} | ${before.toLocaleString()} | ${after.toLocaleString()} | ${deltaStr(delta)} ${icon} |`,
        );
      }
    }
    lines.push("");

    // Call out which brands meaningfully changed (excluding missing)
    const presentBrands = sortedBrands.filter(b => !cur.missingBrands.includes(b));
    const brandsWithChanges = presentBrands.filter(b => (cur.brands[b] ?? 0) !== (prev.brands[b] ?? 0));
    if (brandsWithChanges.length > 0) {
      lines.push(
        "### Changed brands",
        "",
        brandsWithChanges.map(b => {
          const before = prev.brands[b] ?? 0;
          const after = cur.brands[b] ?? 0;
          const delta = after - before;
          if (delta > 0) return `- **${b.toUpperCase()}**: ${deltaStr(delta)} outlets (${before.toLocaleString()} → ${after.toLocaleString()})`;
          return `- **${b.toUpperCase()}**: ${deltaStr(delta)} outlets (${before.toLocaleString()} → ${after.toLocaleString()})`;
        }).join("\n"),
        "",
      );
    }
  }

  lines.push(
    "---",
    `*Generated: ${cur.generatedAt}*`,
    "",
  );

  writeFileSync(path.join(DATASET_DIR, "release-notes.md"), lines.join("\n"), "utf-8");
  console.log("[build-dataset] wrote dataset/release-notes.md");
}

function writeReleaseStats(current: CurrentStats): void {
  const stats: ReleaseStats = {
    previous: readPreviousStats(),
    current,
  };
  writeFileSync(path.join(DATASET_DIR, "release-stats.json"), JSON.stringify(stats, null, 2), "utf-8");
  console.log("[build-dataset] wrote dataset/release-stats.json");
  writeReleaseNotes(stats);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const allOutlets: RawOutletRecord[] = [];
  const brandCounts: Record<string, number> = {};
  const missingBrands: string[] = [];

  for (const brand of BRANDS) {
    const filePath = path.join(OUTPUT_DIR, `${brand}-raw.jsonl`);
    const records = await readRawJsonl(filePath);
    if (records.length === 0) {
      missingBrands.push(brand);
      console.log(`[build-dataset] ${brand}: file missing — skipped`);
    } else {
      const deduped = dedupeByStationId(records);
      brandCounts[brand] = deduped.length;
      allOutlets.push(...deduped);
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

  // Emit release stats and release notes for the GH Release step
  writeReleaseStats({
    generatedAt,
    totalOutlets,
    brands: brandCounts,
    shardCount: shardEntries.length,
    missingBrands,
  });
}

main().catch((err) => {
  console.error("[build-dataset] fatal:", err);
  process.exitCode = 1;
});
