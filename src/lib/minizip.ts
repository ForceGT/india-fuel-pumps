/**
 * Minimal read-only ZIP reader — just enough to pull named entries (as
 * UTF-8 text) out of a small, well-formed archive (this repo's only use
 * case: Shell's `.xlsx` price sheet, see ../parsers/shell-pricing.ts).
 *
 * Deliberately NOT a dependency on a general-purpose zip/xlsx library: this
 * repo's other dependency footprint is a single html parser, and every
 * general-purpose xlsx package on npm (exceljs, xlsx/SheetJS, ...) either
 * pulls in a write-path archiver with known CVEs (exceljs -> archiver ->
 * zip-stream -> archiver-utils -> glob/minimatch/brace-expansion — a real
 * ReDoS advisory, unused code paths or not) or has its own supply-chain
 * baggage, for a read-only need this small. `.xlsx` is just a ZIP of small
 * XML files with DEFLATE compression (verified against the real file with
 * Python's zipfile — every entry uses compression method 8), so a ~60-line
 * hand-rolled End-Of-Central-Directory -> Central-Directory -> Local-File-
 * Header walker + Node's built-in `zlib.inflateRawSync` covers it exactly,
 * with zero new dependencies.
 *
 * Only reads what it needs: no zip64, no encryption, no STORED (method 0)
 * fallback — a `.xlsx` from Excel's own exporter has none of those, and if
 * a future revision does, `readZipEntry` throws rather than silently
 * returning wrong bytes.
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MIN_EOCD_SIZE = 22;

interface CentralDirEntry {
  fileName: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Scans backward for the End Of Central Directory record (present at the very end of every valid, non-zip64 ZIP). Throws if not found within the trailing 64KB (the max comment length a plain EOCD allows). */
function findEndOfCentralDirectory(buf: Buffer): number {
  const searchStart = Math.max(0, buf.length - MIN_EOCD_SIZE - 0xffff);
  for (let i = buf.length - MIN_EOCD_SIZE; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("minizip: End Of Central Directory record not found — not a valid ZIP or a format this reader doesn't support");
}

function readCentralDirectory(buf: Buffer): CentralDirEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries: CentralDirEntry[] = [];
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`minizip: expected central directory entry signature at offset ${offset}`);
    }
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const fileNameLength = buf.readUInt16LE(offset + 28);
    const extraFieldLength = buf.readUInt16LE(offset + 30);
    const fileCommentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const fileName = buf.toString("utf8", offset + 46, offset + 46 + fileNameLength);

    entries.push({ fileName, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return entries;
}

function extractEntry(buf: Buffer, entry: CentralDirEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (buf.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`minizip: expected local file header signature for ${entry.fileName} at offset ${offset}`);
  }
  const fileNameLength = buf.readUInt16LE(offset + 26);
  const extraFieldLength = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraFieldLength;
  const compressedData = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(compressedData); // stored, no compression
  if (entry.compressionMethod === 8) return inflateRawSync(compressedData);
  throw new Error(`minizip: unsupported compression method ${entry.compressionMethod} for ${entry.fileName} (only STORED/DEFLATE supported)`);
}

/** Reads one named entry out of a ZIP buffer as UTF-8 text. Returns null if the entry isn't present (never throws for a missing name — callers decide whether that's fatal). */
export function readZipEntry(buf: Buffer, entryName: string): string | null {
  const entries = readCentralDirectory(buf);
  const entry = entries.find((e) => e.fileName === entryName);
  if (!entry) return null;
  return extractEntry(buf, entry).toString("utf8");
}
