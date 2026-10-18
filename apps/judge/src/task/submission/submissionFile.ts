import fs from "fs";
import { tmpdir } from "os";

import winston from "winston";
import unzipper from "unzipper";

import { serverSideConfig } from "../../config";
import { safelyJoinPath, ensureDirectoryEmpty, download } from "../../utils";
import * as fsNative from "../../fsNative";
import { fileContentMismatch, hashFileAtPath } from "../../file";

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
    }
  >;
}

export class SubmissionFile {
  readonly path: string;

  readonly unzippedPath: string;

  private readonly downloadPromise: Promise<void>;

  // With `expectedHash` (the SHA-256 recorded when it was uploaded), a file with other content fails the task.
  constructor(fileInfo: SubmissionFileInfo, expectedHash?: string) {
    // It's fine to use the uuid as filename since every submission has a different file uuid
    this.path = safelyJoinPath(tmpdir(), fileInfo.uuid);
    this.unzippedPath = safelyJoinPath(tmpdir(), `${fileInfo.uuid}_unzipped`);

    this.downloadPromise = (async () => {
      await download(fileInfo.url, this.path, "answer file");
      if (!expectedHash) return;
      const actualHash = await hashFileAtPath(this.path);
      if (actualHash !== expectedHash) throw fileContentMismatch("The submitted file", expectedHash, actualHash);
    })();
    // Reported when it's waited for
    this.downloadPromise.catch(() => null);
  }

  async waitForDownload() {
    return await this.downloadPromise;
  }

  async unzip(wantedFiles: string[]) {
    await ensureDirectoryEmpty(this.unzippedPath);

    winston.verbose(`SubmissionFile.unzip: start unzipping file ${this.path}`);

    const writeFilePromises: Promise<void>[] = [];
    const result: SubmissionFileUnzipResult = { path: this.unzippedPath, status: {} };

    // The unzipper library is poorly typed
    await fs
      .createReadStream(this.path)
      .pipe(unzipper.Parse())
      .on("entry", (entry: unzipper.Entry) => {
        if (entry.type === "File" && wantedFiles.includes(entry.path)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((entry.vars as any).uncompressedSize <= serverSideConfig.limit.outputSize) {
            // Unzip this file
            writeFilePromises.push(
              new Promise((resolve, reject) => {
                try {
                  entry.pipe(fs.createWriteStream(safelyJoinPath(this.unzippedPath, entry.path))).on("finish", () => {
                    result.status[entry.path] = { success: true, path: safelyJoinPath(this.unzippedPath, entry.path) };
                    resolve();
                  });
                  entry.on("error", reject);
                } catch (e) {
                  reject(e);
                }
              })
            );

            return;
          } else {
            // Size exceeded the limit
            result.status[entry.path] = { sizeExceededLimit: true };
          }
        }

        // Ignore this file
        entry.autodrain();
      })
      .promise();

    winston.verbose(`SubmissionFile.unzip: awaiting writing unzipped files of ${this.path}`);

    await Promise.all(writeFilePromises);

    winston.verbose(`SubmissionFile.unzip: unzipped ${this.path}`);

    return result;
  }

  dispose() {
    // No need to await
    fsNative.remove(this.path);
    fsNative.remove(this.unzippedPath);
  }
}
