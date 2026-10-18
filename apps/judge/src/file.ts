import fs from "fs";
import crypto from "crypto";

import Queue from "promise-queue";
import winston from "winston";
import LRUCache from "lru-cache";

import config from "./config";
import rpc from "./rpc";
import * as fsNative from "./fsNative";
import { download, safelyJoinPath } from "./utils";

/**
 * A stored file whose content isn't what the server recorded when it was uploaded, e.g. because it was changed in
 * storage afterwards. Judging with it could give a different result than other judges, so the task fails.
 */
export class FileContentError extends Error {}

const downloadingFiles: Map<string, Promise<void>> = new Map();
const queue = new Queue(config.maxConcurrentDownloads, Infinity);

async function fileExists(fileUuid: string): Promise<boolean> {
  return await fsNative.exists(safelyJoinPath(config.dataStore, fileUuid));
}

export function hashFileAtPath(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");

    const file = fs.createReadStream(filePath);
    file.pipe(hash);

    file.on("error", reject);
    hash.on("error", reject);

    hash.on("finish", () => resolve(hash.digest("hex")));
  });
}

export function fileContentMismatch(description: string, expected: string, actual: string): FileContentError {
  return new FileContentError(
    `${description} doesn't match its recorded content (SHA-256 ${expected.slice(0, 12)}…, but it is ${actual.slice(
      0,
      12
    )}…). It was probably changed in storage after it was uploaded; upload it again.`
  );
}

/**
 * We use SHA256 to distinguish different input/output files for a testcase
 * It's cached in a LRU cache.
 */
const fileHashCache = new LRUCache<string, Promise<string>>({
  // One file's SHA256 cache costs very little, so we can cache very much results.
  max: 1024 * 1024
});

async function downloadFile(url: string, fileUuid: string, expectedHash?: string) {
  winston.info(`Downloading file ${fileUuid} from server`);
  const tempDir = safelyJoinPath(config.dataStore, "temp");
  await fsNative.ensureDir(tempDir);

  const tempFilename = safelyJoinPath(tempDir, fileUuid);

  await download(url, tempFilename, `testdata file ${fileUuid}`);

  // Only a file with the recorded content is kept
  if (expectedHash) {
    const actualHash = await hashFileAtPath(tempFilename);
    if (actualHash !== expectedHash) {
      await fs.promises.rm(tempFilename, { force: true });
      throw fileContentMismatch(`Test data file ${fileUuid}`, expectedHash, actualHash);
    }
  }

  const persistFilename = safelyJoinPath(config.dataStore, fileUuid);
  fileHashCache.delete(fileUuid);
  await fs.promises.rename(tempFilename, persistFilename);
}

/**
 * Downloads the files that aren't kept yet. With `expectedHashes` (SHA-256 by UUID, as sent with the task), a kept
 * file that doesn't match is downloaded again, and a file that still doesn't match fails the task.
 */
export async function ensureFiles(fileUuids: string[], expectedHashes?: Record<string, string>) {
  fileUuids = Array.from(new Set(fileUuids));
  const expectedHashOf = (fileUuid: string) =>
    expectedHashes && Object.prototype.hasOwnProperty.call(expectedHashes, fileUuid) ? expectedHashes[fileUuid] : null;

  const nonExists: string[] = [];
  await Promise.all(
    fileUuids.map(async fileUuid => {
      if (!(await fileExists(fileUuid))) {
        nonExists.push(fileUuid);
        return;
      }
      // A kept copy that's damaged, or kept from before its stored file was changed
      const expectedHash = expectedHashOf(fileUuid);
      if (!expectedHash || downloadingFiles.has(fileUuid) || (await getFileHash(fileUuid)) === expectedHash) return;
      winston.warn(`Kept file ${fileUuid} doesn't match its recorded SHA-256, downloading it again`);
      fileHashCache.delete(fileUuid);
      await fs.promises.rm(getFile(fileUuid), { force: true });
      nonExists.push(fileUuid);
    })
  );

  winston.verbose(`ensureFiles: ${fileUuids.length - nonExists.length} files already exists`);
  winston.verbose(`ensureFiles: ${nonExists.length} files to download`);

  if (nonExists.length !== 0) {
    const alreadyDownloading: Promise<void>[] = nonExists
      .map(fileUuid => downloadingFiles.get(fileUuid))
      .filter(x => x);
    const notDownloading: string[] = nonExists.filter(fileUuid => !downloadingFiles.has(fileUuid));

    winston.verbose(`ensureFiles: ${alreadyDownloading.length} files already downloading`);

    let newDownloading: Promise<void>[] = [];
    if (notDownloading.length === 0) {
      winston.verbose(`ensureFiles: no files to request`);
    } else {
      winston.verbose(`ensureFiles: requesting ${notDownloading.length} files`);

      const fetchFiles = rpc.requestFiles(notDownloading);
      newDownloading = notDownloading.map((fileUuid, i) => {
        const promise = queue
          .add(async () => {
            const urlList = await fetchFiles;
            await downloadFile(urlList[i], fileUuid, expectedHashOf(fileUuid));
          })
          .finally(() => downloadingFiles.delete(fileUuid));

        downloadingFiles.set(fileUuid, promise);
        return promise;
      });
    }

    await Promise.all([...alreadyDownloading, ...newDownloading]);
  }

  // Also the files another task downloaded meanwhile
  await Promise.all(
    fileUuids.map(async fileUuid => {
      const expectedHash = expectedHashOf(fileUuid);
      if (!expectedHash) return;
      const actualHash = await getFileHash(fileUuid);
      if (actualHash !== expectedHash)
        throw fileContentMismatch(`Test data file ${fileUuid}`, expectedHash, actualHash);
    })
  );
  return null;
}

export function getFile(fileUuid: string) {
  return safelyJoinPath(config.dataStore, fileUuid);
}

const emptyDataHash = crypto.createHash("sha256").update("").digest("hex");
export async function getFileHash(fileUuid: string) {
  if (!fileUuid) return emptyDataHash;

  if (fileHashCache.has(fileUuid)) return await fileHashCache.get(fileUuid);

  const promise = hashFileAtPath(getFile(fileUuid));
  fileHashCache.set(fileUuid, promise);
  // A failure (e.g. a missing file) isn't kept
  promise.catch(() => {
    if (fileHashCache.get(fileUuid) === promise) fileHashCache.delete(fileUuid);
  });

  return await promise;
}
