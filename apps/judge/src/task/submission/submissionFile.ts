import fs from "fs";
import { tmpdir } from "os";
import path from "path";

import winston from "winston";
import unzipper from "unzipper";
import {
  ArchiveError,
  extractZipEntry,
  inspectZipDirectory,
  ZipDirectoryEntry,
  zipEntryName
} from "@libreoj/judge-protocol/archive";

import { serverSideConfig } from "../../config";
import { download } from "../../utils";
import * as fsNative from "../../fsNative";
import { fileContentMismatch, hashFileAtPath } from "../../file";
import { CanceledError } from "../../error";

export interface SubmissionFileInfo {
  uuid: string;
  url: string;
}

export interface SubmissionFileUnzipResult {
  path: string;
  status: Record<
    string,
    {
      path?: string;
      success?: boolean;
      sizeExceededLimit?: boolean;
      /** Why the file couldn't be read from the archive: an ArchiveError code, or ZIP_DUPLICATE_FILE */
      error?: string;
    }
  >;
}

/**
 * What a submitted answer archive may hold. Only the files the problem asks for are extracted, each up to the output
 * limit, and together up to `totalBytes` (or as many outputs as the problem has, if that's less).
 */
export const ANSWER_ARCHIVE_LIMITS = {
  entries: 65536,
  totalBytes: 4 * 1024 ** 3,
  entryTime: 120_000,
  time: 600_000
};
// Space the judge keeps free beside answers
const FREE_SPACE_RESERVE = 256 * 1024 ** 2;

// Bytes the answers of running tasks may still write to the temporary directory
let reservedBytes = 0;

/** Bytes reserved for the answers of running tasks, until their files are removed */
export const reservedAnswerBytes = () => reservedBytes;

/** What an answer archive's errors say to the contestant */
export const ARCHIVE_ERROR_MESSAGES: Record<string, string> = {
  INVALID_ZIP: "The submitted file isn't a ZIP archive that can be read.",
  UNSUPPORTED_ZIP:
    "The archive uses a feature that isn't supported (encryption, a compression method other than stored or deflated, or several disks).",
  ZIP_DIRECTORY_LIMIT: `The archive has too many entries (at most ${ANSWER_ARCHIVE_LIMITS.entries}) or a damaged directory.`,
  ZIP_INTEGRITY_ERROR:
    "This file's data in the archive is damaged: it doesn't inflate to the size and checksum the archive records.",
  ZIP_EXPANSION_LIMIT: "This file inflates to more bytes than the archive says it holds.",
  ZIP_TIMEOUT: "This file took too long to unpack.",
  ZIP_DUPLICATE_FILE: "The archive contains this file more than once."
};

export class SubmissionFile {
  /** A directory of this attempt only, even when another judges the same file at the same time (a rejudge) */
  private directory: string;

  private reservation = 0;

  private readonly downloadPromise: Promise<void>;

  // With `expectedHash` (the SHA-256 recorded when it was uploaded), a file with other content fails the task.
  constructor(fileInfo: SubmissionFileInfo, expectedHash?: string) {
    this.downloadPromise = (async () => {
      this.directory = await fs.promises.mkdtemp(path.join(tmpdir(), "llmoj-answer-"));
      await download(fileInfo.url, this.path, "answer file");
      if (!expectedHash) return;
      const actualHash = await hashFileAtPath(this.path);
      if (actualHash !== expectedHash) throw fileContentMismatch("The submitted file", expectedHash, actualHash);
    })();
    // Reported when it's waited for
    this.downloadPromise.catch(() => null);
  }

  get path() {
    return path.join(this.directory, "answer.zip");
  }

  get unzippedPath() {
    return path.join(this.directory, "files");
  }

  async waitForDownload() {
    return await this.downloadPromise;
  }

  /**
   * Extracts the files the problem asks for (by their names in the archive). A file that's missing, too large,
   * damaged or in the archive twice gets a status saying so; an archive that can't be read gives every file its
   * error. Fails when the judge can't store the files or the task is canceled (`canceled` is checked each second).
   */
  async unzip(wantedFiles: string[], canceled: () => boolean = () => false): Promise<SubmissionFileUnzipResult> {
    await fs.promises.mkdir(this.unzippedPath, { mode: 0o700 });
    const result: SubmissionFileUnzipResult = { path: this.unzippedPath, status: {} };
    const wanted = new Set(wantedFiles);
    const fileBytes = serverSideConfig.limit.outputSize;
    const totalBytes = Math.min(wanted.size * fileBytes, Math.max(fileBytes, ANSWER_ARCHIVE_LIMITS.totalBytes));

    winston.verbose(`SubmissionFile.unzip: start unzipping file ${this.path}`);

    let entries: ZipDirectoryEntry[];
    try {
      const expected = await inspectZipDirectory(this.path, {
        archiveBytes: Number.MAX_SAFE_INTEGER,
        entries: ANSWER_ARCHIVE_LIMITS.entries
      });
      entries = (await unzipper.Open.file(this.path)).files;
      if (entries.length !== expected) throw new ArchiveError("INVALID_ZIP");
    } catch (error) {
      // An error of the system (the disk, no descriptors left) isn't the archive's
      if (typeof error?.code === "string" && /^E[A-Z]+$/.test(error.code) && error.syscall) throw error;
      // Too small to be an archive (ZIP_SIZE_LIMIT) or unreadable by the ZIP reader: not a ZIP archive
      const code = error instanceof ArchiveError && error.code !== "ZIP_SIZE_LIMIT" ? error.code : "INVALID_ZIP";
      for (const name of wanted) result.status[name] = { error: code };
      return result;
    }

    // The entries of each wanted file, by its name in normalization form C as the problem's file names are compared
    const matches = new Map<string, ZipDirectoryEntry[]>();
    const byName = new Map([...wanted].map(name => [name.normalize("NFC"), name]));
    for (const entry of entries) {
      if (entry.type !== "File") continue;
      let name: string;
      try {
        name = byName.get(zipEntryName(entry));
      } catch {
        // A name that can't be decoded isn't one the problem asks for
        continue;
      }
      if (name === undefined) continue;
      if (!matches.has(name)) matches.set(name, []);
      matches.get(name).push(entry);
    }

    // Space for what the archive says the files hold: actual bytes never exceed that
    const needed = [...matches.values()]
      .filter(list => list.length === 1)
      .reduce((sum, [entry]) => sum + Math.min(Math.max(0, entry.uncompressedSize) || 0, fileBytes), 0);
    const reserving = Math.min(needed, totalBytes);
    const { bavail, bsize } = await fs.promises.statfs(this.unzippedPath);
    if (bavail * bsize - reservedBytes < reserving + FREE_SPACE_RESERVE)
      throw new Error(`Not enough free space in ${tmpdir()} for the submitted answers (${reserving} bytes)`);
    reservedBytes += reserving;
    this.reservation += reserving;

    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new Error("Unpacking the submitted answers took too long")),
      ANSWER_ARCHIVE_LIMITS.time
    );
    const cancelCheck = setInterval(() => canceled() && controller.abort(new CanceledError()), 1000);
    try {
      const budget = { remainingBytes: totalBytes };
      let index = 0;
      // In the order the archive lists them, so the same archive always fits the budget the same way
      for (const [name, list] of matches) {
        if (canceled()) throw new CanceledError();
        if (list.length > 1) {
          result.status[name] = { error: "ZIP_DUPLICATE_FILE" };
          continue;
        }
        // Not the archive's name: nothing in it decides where a file is written
        const destination = path.join(this.unzippedPath, String(index++));
        try {
          // eslint-disable-next-line no-await-in-loop -- one file at a time, within one budget
          await extractZipEntry(
            list[0],
            destination,
            budget,
            { fileBytes, entryTime: ANSWER_ARCHIVE_LIMITS.entryTime },
            controller.signal
          );
          result.status[name] = { success: true, path: destination };
        } catch (error) {
          if (!(error instanceof ArchiveError)) throw error;
          result.status[name] =
            error.code === "ZIP_FILE_SIZE_LIMIT" ? { sizeExceededLimit: true } : { error: error.code };
        }
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(cancelCheck);
    }

    winston.verbose(`SubmissionFile.unzip: unzipped ${this.path}`);
    return result;
  }

  /** Removes this attempt's files, after the download has stopped, and then returns their space. */
  async dispose() {
    await this.downloadPromise.catch(() => null);
    try {
      if (this.directory) await fsNative.remove(this.directory);
    } finally {
      reservedBytes -= this.reservation;
      this.reservation = 0;
    }
  }
}
