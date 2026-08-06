/**
 * Reconciles two conflicting copies of a `{slug}-raw.jsonl(.gz)` file —
 * the fix for the merge hazard documented in docs/EDGE-CASES.md's
 * "Append-only raw JSONL merge conflicts must be unioned, not resolved by
 * picking one side". A `git merge` conflict on this file has no correct
 * resolution via `--ours`/`--theirs`: the file is append-only and keyed by
 * `outletId`, so "more total bytes" doesn't mean "strictly better" — one
 * side can easily be missing a handful of individually fresher captures
 * that the other side has (exactly what happened 2026-08-05, see the
 * EDGE-CASES.md entry for the confirmed incident).
 *
 * This keeps BASE's full line-for-line history untouched, then appends
 * exactly one line per outlet from OTHER: whichever outlet in OTHER has a
 * `capturedAt` strictly newer than anything already in BASE for that
 * outlet (or an outlet OTHER has that BASE lacks entirely). It never
 * removes or rewrites a BASE line.
 *
 * Usage:
 *   tsx src/reconcile-raw-jsonl.ts <base.jsonl[.gz]> <other.jsonl[.gz]> <output.jsonl[.gz]>
 *
 * Typical merge-conflict use: run this with git's two conflict sides (e.g.
 * `git show <merge>^1:output/iocl-raw.jsonl.gz` and `^2:...` written to temp
 * files) and the same path as output, then `git add` the result.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

interface RawLine {
  outletId: string;
  capturedAt: string;
}

function readLines(path: string): string[] {
  const buf = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(buf).toString("utf-8") : buf.toString("utf-8");
  return text.split("\n").filter((l) => l.trim().length > 0);
}

function latestByOutlet(lines: string[]): Map<string, string> {
  const maxCap = new Map<string, string>();
  for (const line of lines) {
    let rec: RawLine;
    try {
      rec = JSON.parse(line) as RawLine;
    } catch {
      continue; // malformed line — ignore, matches computeDoneWorkUnitIds' convention
    }
    const prev = maxCap.get(rec.outletId);
    if (!prev || rec.capturedAt > prev) maxCap.set(rec.outletId, rec.capturedAt);
  }
  return maxCap;
}

function main(): void {
  const [basePath, otherPath, outputPath] = process.argv.slice(2);
  if (!basePath || !otherPath || !outputPath) {
    console.error("Usage: tsx src/reconcile-raw-jsonl.ts <base.jsonl[.gz]> <other.jsonl[.gz]> <output.jsonl[.gz]>");
    process.exitCode = 1;
    return;
  }

  const baseLines = readLines(basePath);
  const otherLines = readLines(otherPath);

  const baseLatest = latestByOutlet(baseLines);

  const linesToAppend: string[] = [];
  const otherLatestLine = new Map<string, { capturedAt: string; line: string }>();
  for (const line of otherLines) {
    let rec: RawLine;
    try {
      rec = JSON.parse(line) as RawLine;
    } catch {
      continue;
    }
    const prev = otherLatestLine.get(rec.outletId);
    if (!prev || rec.capturedAt > prev.capturedAt) otherLatestLine.set(rec.outletId, { capturedAt: rec.capturedAt, line });
  }

  for (const [outletId, { capturedAt, line }] of otherLatestLine) {
    const baseCap = baseLatest.get(outletId);
    if (!baseCap || capturedAt > baseCap) linesToAppend.push(line);
  }

  const outText = [...baseLines, ...linesToAppend].join("\n") + "\n";
  const outBuf = outputPath.endsWith(".gz") ? gzipSync(Buffer.from(outText, "utf-8")) : Buffer.from(outText, "utf-8");
  writeFileSync(outputPath, outBuf);

  console.log(
    `[reconcile] base=${baseLines.length} lines, other=${otherLines.length} lines, ` +
      `restored ${linesToAppend.length} fresher-in-other record(s), wrote ${outText.split("\n").length - 1} total lines to ${outputPath}`,
  );
}

main();
