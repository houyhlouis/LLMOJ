import fs from "fs";
import path from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { TextDecoder } from "util";

import * as unzipper from "unzipper";

export const ZIP_LIMITS = {
  archiveBytes: 8 * 1024 ** 3,
  totalBytes: 8 * 1024 ** 3,
  fileBytes: 256 * 1024 ** 2,
  files: 4096
};
export class ArchiveError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
  }
}
export interface ExtractedArchiveFile {
  archivePath: string;
  filename: string;
  path: string;
  size: number;
}
export interface ArchivePair {
  inputFile: string;
  outputFile: string;
}
const fail = (code: string): never => {
  throw new ArchiveError(code);
};
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  // eslint-disable-next-line no-bitwise -- ZIP checksums and flags require exact bit operations.
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  // eslint-disable-next-line no-bitwise -- ZIP checksums and flags require exact bit operations.
  return crc >>> 0;
});

// Bound the central directory before unzipper allocates its entries. ZIP64 is supported.
async function inspectDirectory(filename: string, limit: number, maxFiles: number) {
  // eslint-disable-next-line no-bitwise -- ZIP checksums and flags require exact bit operations.
  const file = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 22 || stat.size > limit) fail("ZIP_SIZE_LIMIT");
    const length = Math.min(stat.size, 65557);
    const tail = Buffer.alloc(length);
    await file.read(tail, 0, length, stat.size - length);
    let at = tail.length - 22;
    for (; at >= 0; at--)
      if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) break;
    if (at < 0) fail("INVALID_ZIP");
    if (tail.readUInt16LE(at + 4) || tail.readUInt16LE(at + 6)) fail("UNSUPPORTED_ZIP");
    let entries = tail.readUInt16LE(at + 10);
    let bytes = tail.readUInt32LE(at + 12);
    let offset = tail.readUInt32LE(at + 16);
    const eocd = stat.size - length + at;
    if (entries === 0xffff || bytes === 0xffffffff || offset === 0xffffffff) {
      if (eocd < 20) fail("INVALID_ZIP");
      const locator = Buffer.alloc(20);
      await file.read(locator, 0, 20, eocd - 20);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) || locator.readUInt32LE(16) !== 1)
        fail("UNSUPPORTED_ZIP");
      const recordOffset = Number(locator.readBigUInt64LE(8));
      if (!Number.isSafeInteger(recordOffset) || recordOffset < 0 || recordOffset + 56 > eocd - 20) fail("INVALID_ZIP");
      const record = Buffer.alloc(56);
      await file.read(record, 0, 56, recordOffset);
      if (record.readUInt32LE(0) !== 0x06064b50 || record.readUInt32LE(16) || record.readUInt32LE(20))
        fail("UNSUPPORTED_ZIP");
      entries = Number(record.readBigUInt64LE(32));
      bytes = Number(record.readBigUInt64LE(40));
      offset = Number(record.readBigUInt64LE(48));
    }
    if (
      ![entries, bytes, offset].every(Number.isSafeInteger) ||
      entries < 1 ||
      entries > maxFiles * 2 ||
      bytes < 0 ||
      bytes > 16 * 1024 ** 2 ||
      offset < 0 ||
      offset + bytes > eocd
    )
      fail("ZIP_DIRECTORY_LIMIT");
    return entries;
  } finally {
    await file.close();
  }
}

function safeArchivePath(entry: unzipper.File): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(entry.pathBuffer);
  } catch {
    // eslint-disable-next-line no-bitwise -- ZIP checksums and flags require exact bit operations.
    if (entry.flags & 0x800) return fail("INVALID_ZIP_FILENAME");
    value = new TextDecoder("gb18030", { fatal: true }).decode(entry.pathBuffer);
  }
  value = value.normalize("NFC");
  // eslint-disable-next-line no-control-regex -- Explicitly reject or remove control bytes from untrusted names and text.
  if (!value || value.length > 2048 || /[\\\x00-\x1f\x7f:]/.test(value) || value.startsWith("/"))
    fail("UNSAFE_ZIP_PATH");
  const parts = value.replace(/\/$/, "").split("/");
  if (parts.some(part => !part || part === "." || part === "..")) fail("UNSAFE_ZIP_PATH");
  // eslint-disable-next-line no-bitwise -- ZIP checksums and flags require exact bit operations.
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (mode && mode !== 0x8000 && mode !== 0x4000) fail("UNSAFE_ZIP_ENTRY");
  // eslint-disable-next-line no-bitwise -- ZIP checksums and flags require exact bit operations.
  if (entry.flags & 0x41 || ![0, 8].includes(entry.compressionMethod)) fail("UNSUPPORTED_ZIP");
  return value;
}

export function detectArchivePairs(files: Pick<ExtractedArchiveFile, "filename">[]): ArchivePair[] {
  const byName = new Map(files.map(file => [file.filename.toLowerCase(), file.filename]));
  return files
    .filter(file => /\.in$/i.test(file.filename))
    .flatMap(file => {
      const stem = file.filename.slice(0, -3).toLowerCase();
      const outputs = [byName.get(`${stem}.out`), byName.get(`${stem}.ans`)].filter(Boolean);
      if (outputs.length > 1) fail("AMBIGUOUS_ZIP_PAIR");
      return outputs.length ? [{ inputFile: file.filename, outputFile: outputs[0] }] : [];
    })
    .sort((a, b) => a.inputFile.localeCompare(b.inputFile, "en", { numeric: true }));
}

export async function extractSafeZip(filename: string, destination: string, limits: Partial<typeof ZIP_LIMITS> = {}) {
  const bound = { ...ZIP_LIMITS, ...limits };
  for (const [key, value] of Object.entries(bound))
    if (!Number.isSafeInteger(value) || value <= 0 || value > ZIP_LIMITS[key]) fail("INVALID_ZIP_LIMIT");
  const expectedEntries = await inspectDirectory(filename, bound.archiveBytes, bound.files);
  const directory = await unzipper.Open.file(filename);
  if (directory.files.length !== expectedEntries) fail("INVALID_ZIP");
  const skippedFiles: string[] = [];
  const paths = new Set<string>();
  const entries = directory.files.flatMap(entry => {
    const archivePath = safeArchivePath(entry);
    const key = archivePath.toLowerCase();
    if (paths.has(key)) fail("DUPLICATE_ZIP_PATH");
    paths.add(key);
    if (entry.type === "Directory" || archivePath.endsWith("/")) return [];
    if (archivePath.split("/").some(part => part === "__MACOSX" || part === ".DS_Store")) {
      skippedFiles.push(archivePath);
      return [];
    }
    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0 ||
      entry.uncompressedSize > bound.fileBytes
    )
      fail("ZIP_FILE_SIZE_LIMIT");
    return [{ entry, archivePath, parts: archivePath.split("/") }];
  });
  if (!entries.length || entries.length > bound.files) fail("ZIP_FILE_COUNT_LIMIT");
  const totalSize = entries.reduce((sum, item) => sum + item.entry.uncompressedSize, 0);
  if (totalSize > bound.totalBytes) fail("ZIP_TOTAL_SIZE_LIMIT");
  let common = 0;
  // eslint-disable-next-line no-loop-func -- This callback runs synchronously or in an awaited serial chain; shared state is intentional.
  while (entries.every(item => item.parts.length > common + 1 && item.parts[common] === entries[0].parts[common]))
    common++;
  const names = new Set<string>();
  const planned = entries.map(item => {
    const flat = item.parts.slice(common).join("__");
    if (flat.length > 256 || names.has(flat.toLowerCase())) fail("ZIP_FILENAME_CONFLICT");
    names.add(flat.toLowerCase());
    return { ...item, filename: flat };
  });
  await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
  if ((await fs.promises.readdir(destination)).length) fail("ZIP_DESTINATION_NOT_EMPTY");
  const statfs = await (
    fs.promises as typeof fs.promises & { statfs(path: string): Promise<{ bavail: number; bsize: number }> }
  ).statfs(destination);
  if (statfs.bavail * statfs.bsize < totalSize + 2 * 1024 ** 3) fail("ZIP_INSUFFICIENT_STORAGE");
  const files: ExtractedArchiveFile[] = [];
  const created: string[] = [];
  let total = 0;
  try {
    for (const item of planned) {
      const output = path.join(destination, item.filename);
      created.push(output);
      let size = 0;
      let crc = 0xffffffff;
      const stream = item.entry.stream();
      const timer = setTimeout(() => stream.destroy(new ArchiveError("ZIP_TIMEOUT")), 120000);
      try {
        // eslint-disable-next-line no-await-in-loop -- Extract one entry at a time to enforce shared byte limits and bound memory.
        await pipeline(
          stream,
          new Transform({
            // eslint-disable-next-line no-loop-func -- This callback runs synchronously or in an awaited serial chain; shared state is intentional.
            transform(chunk: Buffer, encoding, callback) {
              size += chunk.length;
              total += chunk.length;
              if (size > item.entry.uncompressedSize || size > bound.fileBytes || total > bound.totalBytes) {
                callback(new ArchiveError("ZIP_EXPANSION_LIMIT"));
                return;
              }
              // eslint-disable-next-line no-bitwise -- ZIP checksums and flags require exact bit operations.
              for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
              callback(null, chunk);
            }
          }),
          fs.createWriteStream(output, { flags: "wx", mode: 0o600 })
        );
      } finally {
        clearTimeout(timer);
      }
      // eslint-disable-next-line no-bitwise -- ZIP checksums and flags require exact bit operations.
      if (size !== item.entry.uncompressedSize || (crc ^ 0xffffffff) >>> 0 !== item.entry.crc32 >>> 0)
        fail("ZIP_INTEGRITY_ERROR");
      files.push({ archivePath: item.archivePath, filename: item.filename, path: output, size });
    }
    return { files, pairs: detectArchivePairs(files), skippedFiles };
  } catch (error) {
    await Promise.all(created.map(file => fs.promises.unlink(file).catch(() => undefined)));
    throw error;
  }
}
