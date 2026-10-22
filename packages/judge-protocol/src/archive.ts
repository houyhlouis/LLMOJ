/*
 * Reading ZIP archives from users, shared by the backend (test data imports) and the judge (submitted answer files).
 * Each caller has its own policy; these are the rules every archive is held to:
 *
 * - the central directory is bounded before a ZIP library allocates its entries;
 * - an entry's bytes are counted as they're inflated, against its declared size, a per-file limit and a budget
 *   shared by the whole archive, and checked against its CRC-32;
 * - an entry is written to a new file only (never over an existing one or through a link), and a failed entry leaves
 *   no partial file behind;
 * - every stream error, of the archive, the decompressor or the destination, rejects the extraction.
 *
 * The entries are those of `unzipper`'s Open.file, described structurally so that this package needs no ZIP library.
 */
import fs from "fs";
import { Transform, TransformCallback } from "stream";
import { pipeline } from "stream/promises";
import { TextDecoder } from "util";

export class ArchiveError extends Error {
  constructor(
    public readonly code: string,
    message = code
  ) {
    super(message);
  }
}

const fail = (code: string): never => {
  throw new ArchiveError(code);
};

export interface ZipDirectoryLimits {
  /** Bytes of the archive itself */
  archiveBytes: number;
  /** Entries (files and directories) in its central directory */
  entries: number;
}

/** What a ZIP library's central directory reader gives for an entry */
export interface ZipDirectoryEntry {
  path: string;
  pathBuffer: Buffer;
  type: "File" | "Directory";
  flags: number;
  externalFileAttributes: number;
  compressionMethod: number;
  uncompressedSize: number;
  crc32: number;
  stream(): NodeJS.ReadableStream;
}

// The central directory of the largest archive any caller accepts
const DIRECTORY_BYTES = 16 * 1024 ** 2;

/**
 * Reads the end of the central directory and returns how many entries the archive declares, refusing archives over
 * the limits before their entries are parsed. ZIP64 is supported; multi-disk archives are not.
 */
export async function inspectZipDirectory(filename: string, limits: ZipDirectoryLimits): Promise<number> {
  // eslint-disable-next-line no-bitwise -- open flags
  const file = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 22 || stat.size > limits.archiveBytes) fail("ZIP_SIZE_LIMIT");
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
      entries > limits.entries ||
      bytes < 0 ||
      bytes > DIRECTORY_BYTES ||
      offset < 0 ||
      offset + bytes > eocd
    )
      fail("ZIP_DIRECTORY_LIMIT");
    return entries;
  } finally {
    await file.close();
  }
}

/**
 * An entry's name: UTF-8, or GB18030 (Chinese Windows) when it isn't valid UTF-8 and the archive doesn't say it's
 * UTF-8; in Unicode normalization form C.
 */
export function zipEntryName(entry: Pick<ZipDirectoryEntry, "pathBuffer" | "flags">): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(entry.pathBuffer);
  } catch {
    // eslint-disable-next-line no-bitwise -- ZIP flags
    if (entry.flags & 0x800) return fail("INVALID_ZIP_FILENAME");
    try {
      value = new TextDecoder("gb18030", { fatal: true }).decode(entry.pathBuffer);
    } catch {
      return fail("INVALID_ZIP_FILENAME");
    }
  }
  return value.normalize("NFC");
}

/**
 * An entry's name, refusing names that could leave the destination or that aren't portable, and entries that aren't
 * plain files or directories, or that are encrypted or use a compression method other than stored or deflated.
 */
export function safeZipEntryPath(entry: ZipDirectoryEntry): string {
  const value = zipEntryName(entry);
  // eslint-disable-next-line no-control-regex -- control bytes in untrusted names
  if (!value || value.length > 2048 || /[\\\x00-\x1f\x7f:]/.test(value) || value.startsWith("/"))
    fail("UNSAFE_ZIP_PATH");
  const parts = value.replace(/\/$/, "").split("/");
  if (parts.some(part => !part || part === "." || part === "..")) fail("UNSAFE_ZIP_PATH");
  // eslint-disable-next-line no-bitwise -- Unix mode in the external attributes
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (mode && mode !== 0x8000 && mode !== 0x4000) fail("UNSAFE_ZIP_ENTRY");
  checkZipEntryFormat(entry);
  return value;
}

/** Refuses encrypted entries and compression methods other than stored and deflated. */
export function checkZipEntryFormat(entry: Pick<ZipDirectoryEntry, "flags" | "compressionMethod">) {
  // eslint-disable-next-line no-bitwise -- ZIP flags: encrypted, strong encryption
  if (entry.flags & 0x41 || ![0, 8].includes(entry.compressionMethod)) fail("UNSUPPORTED_ZIP");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  // eslint-disable-next-line no-bitwise -- CRC-32
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  // eslint-disable-next-line no-bitwise -- CRC-32
  return crc >>> 0;
});

export interface ZipEntryLimits {
  /** Bytes of one file */
  fileBytes: number;
  /** Milliseconds one entry may take */
  entryTime: number;
}

/** What the files of one archive may still use together, decreased as their bytes are written */
export interface ZipBudget {
  remainingBytes: number;
}

/**
 * Inflates a file entry into a new file at `destination`, which must not exist, and returns its size.
 *
 * Refuses, with an ArchiveError:
 * - an entry that says it's larger than the per-file limit or the budget (`ZIP_FILE_SIZE_LIMIT`), before inflating;
 * - one that inflates to more bytes than it declares (`ZIP_EXPANSION_LIMIT`), as soon as it has;
 * - one that inflates to fewer or other bytes than it declares, or whose compressed data is damaged
 *   (`ZIP_INTEGRITY_ERROR`);
 * - one that takes longer than the time limit (`ZIP_TIMEOUT`).
 * It also stops when `signal` aborts (its reason), and fails with the destination's error (no space left, say).
 * On any failure the entry's bytes return to the budget and the file is removed.
 */
export async function extractZipEntry(
  entry: ZipDirectoryEntry,
  destination: string,
  budget: ZipBudget,
  limits: ZipEntryLimits,
  signal?: AbortSignal
): Promise<number> {
  checkZipEntryFormat(entry);
  const declared = entry.uncompressedSize;
  if (!Number.isSafeInteger(declared) || declared < 0) fail("ZIP_INTEGRITY_ERROR");
  if (declared > limits.fileBytes || declared > budget.remainingBytes) fail("ZIP_FILE_SIZE_LIMIT");
  signal?.throwIfAborted();

  let size = 0;
  let crc = 0xffffffff;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new ArchiveError("ZIP_TIMEOUT")), limits.entryTime);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  // Reserved before writing: actual bytes never exceed what the entry declares
  budget.remainingBytes -= declared;
  try {
    await pipeline(
      entry.stream(),
      new Transform({
        transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
          size += chunk.length;
          if (size > declared) {
            callback(new ArchiveError("ZIP_EXPANSION_LIMIT"));
            return;
          }
          // eslint-disable-next-line no-bitwise -- CRC-32
          for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
          callback(null, chunk);
        }
      }),
      fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      { signal: combined }
    );
    // eslint-disable-next-line no-bitwise -- CRC-32
    if (size !== declared || (crc ^ 0xffffffff) >>> 0 !== entry.crc32 >>> 0) fail("ZIP_INTEGRITY_ERROR");
    return size;
  } catch (error) {
    budget.remainingBytes += declared;
    const { code, name, syscall } = (error ?? {}) as { code?: string; name?: string; syscall?: string };
    // The file is removed unless it existed before (the destination isn't this call's)
    if (code !== "EEXIST") await fs.promises.unlink(destination).catch(() => undefined);
    if (error instanceof ArchiveError) throw error;
    // pipeline's AbortError carries the reason as its cause
    if (name === "AbortError" && combined.aborted) throw combined.reason;
    // A system call that failed (no space left, an I/O error) is the caller's failure, not the archive's
    if (syscall) throw error;
    // Otherwise the ZIP reader or zlib refused the entry's data (truncated, or not inflating)
    throw new ArchiveError("ZIP_INTEGRITY_ERROR");
  } finally {
    clearTimeout(timer);
  }
}
