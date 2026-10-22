import fs from "fs";
import path from "path";

import * as unzipper from "unzipper";
import { ArchiveError, extractZipEntry, inspectZipDirectory, safeZipEntryPath } from "@libreoj/judge-protocol/archive";

// Shared with the judge, which reads submitted answer archives by the same rules
export { ArchiveError };

export const ZIP_LIMITS = {
  archiveBytes: 8 * 1024 ** 3,
  totalBytes: 8 * 1024 ** 3,
  fileBytes: 256 * 1024 ** 2,
  files: 4096
};
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
  const expectedEntries = await inspectZipDirectory(filename, {
    archiveBytes: bound.archiveBytes,
    entries: bound.files * 2
  });
  const directory = await unzipper.Open.file(filename);
  if (directory.files.length !== expectedEntries) fail("INVALID_ZIP");
  const skippedFiles: string[] = [];
  const paths = new Set<string>();
  const entries = directory.files.flatMap(entry => {
    const archivePath = safeZipEntryPath(entry);
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
  const budget = { remainingBytes: bound.totalBytes };
  try {
    for (const item of planned) {
      const output = path.join(destination, item.filename);
      created.push(output);
      // eslint-disable-next-line no-await-in-loop -- Extract one entry at a time to enforce shared byte limits and bound memory.
      const size = await extractZipEntry(item.entry, output, budget, { fileBytes: bound.fileBytes, entryTime: 120000 });
      files.push({ archivePath: item.archivePath, filename: item.filename, path: output, size });
    }
    return { files, pairs: detectArchivePairs(files), skippedFiles };
  } catch (error) {
    await Promise.all(created.map(file => fs.promises.unlink(file).catch(() => undefined)));
    throw error;
  }
}
