import { URL } from "url";
import { Readable, Transform, Writable } from "stream";
import fs from "fs";
import { createHash, Hash } from "crypto";
import { pipeline } from "stream/promises";

import { BadRequestException, Injectable, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository, EntityManager, In, IsNull, MoreThan } from "typeorm";
import { v4 as UUID } from "uuid";
import { Client as MinioClient, ClientOptions, CopyDestinationOptions, CopySourceOptions } from "minio";

import { FileEntity } from "./file.entity";

import { FileUploadInfoDto, SignedFileUploadRequestDto } from "./dto";

import { TeamFileUploadEntity } from "../team/team.entity";
import { logger } from "../logger";
import { ConfigService } from "../config/config.service";

// 10 minutes upload expire time
const FILE_UPLOAD_EXPIRE_TIME = 10 * 60;
// Stored objects checked by one query of maintenance
const MAINTENANCE_BATCH_SIZE = 500;
// Default download links last 20 hours; private team files explicitly request 60 seconds.
const FILE_DOWNLOAD_EXPIRE_TIME = 20 * 60 * 60;
// Judge clients download a task's files as soon as they receive it; allow for slow links to large test data.
export const JUDGE_FILE_DOWNLOAD_EXPIRE_TIME = 6 * 60 * 60;
// Temporary objects of other services under this prefix (e.g. AI runs on judges), which delete them themselves.
// Maintenance leaves them alone.
export const TEMPORARY_OBJECT_PREFIX = "temporary/";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const isMissingObject = (error: { code?: string; message?: string }) =>
  error?.code === "NoSuchKey" || error?.code === "NotFound" || error?.message === "The specified key does not exist.";

// Passes a stream through, updating `hash` with its content
const hashing = (hash: Hash) =>
  new Transform({
    transform(chunk: Buffer, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    }
  });

async function hashLocalFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(path), hashing(hash), new Writable({ write: (chunk, encoding, done) => done() }));
  return hash.digest("hex");
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent
function encodeRFC5987ValueChars(str: string) {
  return (
    encodeURIComponent(str)
      // Note that although RFC3986 reserves "!", RFC5987 does not,
      // so we do not need to escape it
      .replace(/['()]/g, escape) // i.e., %27 %28 %29
      .replace(/\*/g, "%2A")
      // The following are not required for percent-encoding per RFC5987,
      // so we can allow for a little better readability over the wire: |`^
      .replace(/%(?:7C|60|5E)/g, unescape)
  );
}

interface MinioEndpointConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
}

function parseMainEndpointUrl(endpoint: string): MinioEndpointConfig {
  const url = new URL(endpoint);
  const result: Partial<MinioEndpointConfig> = {};

  if (url.pathname !== "/") throw new Error("Main MinIO endpoint URL of a sub-directory is not supported.");
  if (url.username || url.password || url.hash || url.search)
    throw new Error("Authorization, search parameters and hash are not supported for main MinIO endpoint URL.");

  if (url.protocol === "http:") result.useSSL = false;
  else if (url.protocol === "https:") result.useSSL = true;
  else
    throw new Error(
      `Invalid protocol "${url.protocol}" for main MinIO endpoint URL. Only HTTP and HTTPS are supported.`
    );

  result.endPoint = url.hostname;
  result.port = url.port ? Number(url.port) : result.useSSL ? 443 : 80;

  return result as MinioEndpointConfig;
}

function parseSignEndpointUrl(endpoint: string): (originalUrl: string) => string {
  if (!endpoint) return originalUrl => originalUrl;

  const url = new URL(endpoint);
  if (url.hash || url.search)
    throw new Error("Search parameters and hash are not supported for MinIO sign endpoint URL.");
  if (!url.pathname.endsWith("/")) throw new Error("MinIO sign endpoint URL's pathname must ends with '/'.");

  return originalUrl => {
    const parsedOriginUrl = new URL(originalUrl);
    return new URL(parsedOriginUrl.pathname.slice(1) + parsedOriginUrl.search + parsedOriginUrl.hash, url).toString();
  };
}

export enum MinioSignFor {
  UserUpload = "UserUpload",
  UserDownload = "UserDownload",
  Judge = "Judge"
}

@Injectable()
export class FileService implements OnModuleInit {
  private readonly minioClient: MinioClient;

  private readonly bucket: string;

  private readonly minioSigner: Record<
    MinioSignFor,
    {
      client: MinioClient;
      replaceUrl: (originalUrl: string) => string;
    }
  >;

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly configService: ConfigService
  ) {
    const config = this.configService.config.services.minio;
    const commonOptions: Pick<ClientOptions, "accessKey" | "secretKey" | "region"> = {
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: "us-east-1"
    };

    this.minioClient = new MinioClient({
      ...parseMainEndpointUrl(config.default.endpoint),
      ...commonOptions
    });
    this.bucket = config.bucket;
    this.minioSigner = {
      [MinioSignFor.UserUpload]: {
        client: new MinioClient({
          ...parseMainEndpointUrl(config?.forUserUpload?.endpoint || config.default.endpoint),
          ...commonOptions
        }),
        replaceUrl: parseSignEndpointUrl(config?.forUserUpload?.urlEndpoint || config.default.urlEndpoint)
      },
      [MinioSignFor.UserDownload]: {
        client: new MinioClient({
          ...parseMainEndpointUrl(config?.forUserDownload?.endpoint || config.default.endpoint),
          ...commonOptions
        }),
        replaceUrl: parseSignEndpointUrl(config?.forUserDownload?.urlEndpoint || config.default.urlEndpoint)
      },
      [MinioSignFor.Judge]: {
        client: new MinioClient({
          ...parseMainEndpointUrl(config?.forJudge?.endpoint || config.default.endpoint),
          ...commonOptions
        }),
        replaceUrl: parseSignEndpointUrl(config?.forJudge?.urlEndpoint || config.default.urlEndpoint)
      }
    };
  }

  fileExistsInMinio(uuid: string): Promise<boolean> {
    return new Promise(resolve =>
      this.minioClient
        .statObject(this.bucket, uuid)
        .then(() => resolve(true))
        .catch(() => resolve(false))
    );
  }

  /**
   * Stores an object from the backend itself.
   *
   * @return The SHA-256 of what was stored.
   */
  async uploadFile(uuid: string, streamOrBufferOrFile: string | Buffer | Readable, retryCount = 10): Promise<string> {
    for (let i = 0; i < retryCount; i++) {
      try {
        /* eslint-disable no-await-in-loop */
        if (typeof streamOrBufferOrFile === "string") {
          const sha256 = await hashLocalFile(streamOrBufferOrFile);
          await this.minioClient.fPutObject(this.bucket, uuid, streamOrBufferOrFile, {});
          return sha256;
        }
        if (Buffer.isBuffer(streamOrBufferOrFile)) {
          await this.minioClient.putObject(this.bucket, uuid, streamOrBufferOrFile);
          return createHash("sha256").update(streamOrBufferOrFile).digest("hex");
        }
        const hash = createHash("sha256");
        await this.minioClient.putObject(this.bucket, uuid, streamOrBufferOrFile.pipe(hashing(hash)));
        return hash.digest("hex");
        /* eslint-enable no-await-in-loop */
      } catch (e) {
        if (i === retryCount - 1) throw e;
        else {
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
      }
    }
    throw new Error("No attempt to store the file was made");
  }

  /** Reads a stored object to compute its SHA-256. */
  async hashStoredObject(uuid: string): Promise<{ sha256: string; size: number }> {
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      await this.minioClient.getObject(this.bucket, uuid),
      new Writable({
        write(chunk: Buffer, encoding, callback) {
          hash.update(chunk);
          size += chunk.length;
          callback();
        }
      })
    );
    return { sha256: hash.digest("hex"), size };
  }

  /** The recorded SHA-256 of the given files, by UUID; files without one are left out. */
  async getContentHashes(uuids: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(uuids.filter(uuid => typeof uuid === "string"))];
    if (unique.length === 0) return {};
    const files = await this.fileRepository.find({ select: ["uuid", "sha256"], where: { uuid: In(unique) } });
    return Object.fromEntries(
      files.filter(file => SHA256_PATTERN.test(file.sha256 ?? "")).map(file => [file.uuid, file.sha256])
    );
  }

  /**
   * Computes the content hashes that aren't recorded yet (files from before content hashes, or added another way),
   * in the order the files were added, from the file after `afterId`. A file whose object is missing, or whose size
   * isn't the recorded one, is left without.
   *
   * @return The ID of the last file looked at (`null` when there were no more), and how many hashes were recorded.
   */
  async recordMissingContentHashes(
    afterId: number,
    maximumFiles: number,
    maximumBytes: number
  ): Promise<{ lastId: number; recorded: number; skipped: number }> {
    const files = await this.fileRepository.find({
      select: ["id", "uuid", "size"],
      where: { sha256: IsNull(), id: MoreThan(afterId) },
      order: { id: "ASC" },
      take: maximumFiles
    });
    let lastId: number = null;
    let recorded = 0;
    let skipped = 0;
    let bytes = 0;
    for (const file of files) {
      if (lastId !== null && bytes + file.size > maximumBytes) break;
      lastId = file.id;
      bytes += file.size;
      let content: { sha256: string; size: number };
      try {
        // eslint-disable-next-line no-await-in-loop -- One file at a time
        content = await this.hashStoredObject(file.uuid);
      } catch (e) {
        if (!isMissingObject(e)) throw e;
        skipped++;
        continue;
      }
      if (content.size !== file.size) {
        logger.error(
          `Stored file ${file.uuid} has ${content.size} bytes, but ${file.size} were recorded; its content hash is not recorded`
        );
        skipped++;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- One file at a time
      await this.fileRepository.update({ id: file.id, sha256: IsNull() }, { sha256: content.sha256 });
      recorded++;
    }
    return { lastId, recorded, skipped };
  }

  async downloadFileToPath(uuid: string, destination: string, maximumBytes: number): Promise<number> {
    const meta = await this.minioClient.statObject(this.bucket, uuid);
    if (!Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > maximumBytes)
      throw new Error("FILE_SIZE_LIMIT");
    let received = 0;
    try {
      await pipeline(
        await this.minioClient.getObject(this.bucket, uuid),
        new Transform({
          transform(chunk: Buffer, encoding, callback) {
            received += chunk.length;
            callback(received > maximumBytes || received > meta.size ? new Error("FILE_SIZE_LIMIT") : null, chunk);
          }
        }),
        fs.createWriteStream(destination, { flags: "wx", mode: 0o600 })
      );
      if (received !== meta.size) throw new Error("FILE_SIZE_MISMATCH");
      return received;
    } catch (error) {
      await fs.promises.unlink(destination).catch(() => undefined);
      throw error;
    }
  }

  async onModuleInit(): Promise<void> {
    let bucketExists: boolean;
    try {
      bucketExists = await this.minioClient.bucketExists(this.bucket);
    } catch (e) {
      throw new Error(
        `Error initializing the MinIO client. Please check your configuration file and MinIO server. ${e}`
      );
    }

    if (!bucketExists)
      throw new Error(
        `MinIO bucket ${this.bucket} doesn't exist. Please check your configuration file and MinIO server.`
      );
  }

  /** Whether object storage answers and has the site's bucket. */
  async storageAvailable(): Promise<boolean> {
    return await this.minioClient.bucketExists(this.bucket);
  }

  /**
   * Process the client's request about uploading a file.
   *
   * * If the user has not uploaded the file, return a signed upload info object.
   * * If the user has uploaded the file, check the file existance, file size and limits.
   *
   * @note
   * The `checkLimit` function may return different result for each call with the same upload info.
   *
   * e.g. When a user uploaded other files before upload this file, the quota is enough before uploading but
   *      not enough after uploading.
   *
   * Rejected uploads are left for maintenance cleanup. A caller-supplied UUID must
   * never cause another registered or concurrently accepted object to be deleted.
   *
   * @return A `SignedFileUploadRequestDto` to return to the client if the file is not uploaded.
   * @return `string` error message if client says the file is uploaded but we do not accept it according to some errors.
   * @return A `FileEntity` if the file is uploaded successfully and saved to the database.
   */
  async processUploadRequest<LimitCheckErrorType extends string>(
    uploadInfo: FileUploadInfoDto,
    checkLimit: (size: number) => Promise<LimitCheckErrorType> | LimitCheckErrorType,
    transactionalEntityManager: EntityManager,
    recordContentHash = true
  ): Promise<FileEntity | SignedFileUploadRequestDto | LimitCheckErrorType | "FILE_UUID_EXISTS" | "FILE_NOT_UPLOADED"> {
    if (!uploadInfo.uuid) return await this.prepareUploadRequest(uploadInfo.size, checkLimit);

    if ((await transactionalEntityManager.countBy(FileEntity, { uuid: uploadInfo.uuid })) !== 0)
      return "FILE_UUID_EXISTS";

    let actualSize: number;
    try {
      actualSize = (await this.minioClient.statObject(this.bucket, uploadInfo.uuid)).size;
    } catch (e) {
      if (isMissingObject(e)) return "FILE_NOT_UPLOADED";
      throw e;
    }

    if (!Number.isSafeInteger(actualSize) || actualSize < 0 || actualSize !== uploadInfo.size)
      throw new BadRequestException("FILE_SIZE_MISMATCH");
    const limitCheckError = await checkLimit(actualSize);
    if (limitCheckError) return limitCheckError;

    // Judges check the file against what's stored now; its upload form stays valid for a while, so the file could
    // still be replaced in storage, but not without that being noticed. A file judges don't use may leave its hash to
    // the background (FileContentHashService), so that a large one isn't read while the caller holds its locks.
    const content = recordContentHash ? await this.hashStoredObject(uploadInfo.uuid) : null;
    if (content && content.size !== actualSize) throw new BadRequestException("FILE_SIZE_MISMATCH");

    const file = new FileEntity();
    file.uuid = uploadInfo.uuid;
    file.size = actualSize;
    file.uploadTime = new Date();
    file.sha256 = content?.sha256 ?? null;

    await transactionalEntityManager.save(FileEntity, file);

    return file;
  }

  async prepareUploadRequest<LimitCheckErrorType extends string>(
    size: number,
    checkLimit: (size: number) => Promise<LimitCheckErrorType> | LimitCheckErrorType
  ): Promise<SignedFileUploadRequestDto | LimitCheckErrorType> {
    const limitCheckError = await checkLimit(size);
    if (limitCheckError) return limitCheckError;
    return await this.signUploadRequest(size, size);
  }

  /**
   * Sign a upload request for given size. The alternative MinIO endpoint for user will be used in the POST URL.
   */
  private async signUploadRequest(
    minSize?: number,
    maxSize?: number,
    objectUuid = UUID(),
    expiresAt = new Date(Date.now() + FILE_UPLOAD_EXPIRE_TIME * 1000),
    signFor = MinioSignFor.UserUpload
  ): Promise<SignedFileUploadRequestDto> {
    const signer = this.minioSigner[signFor];
    const uuid = objectUuid;
    const policy = signer.client.newPostPolicy();
    policy.setBucket(this.bucket);
    policy.setKey(uuid);
    policy.setExpires(expiresAt);
    if (minSize != null || maxSize != null) {
      policy.setContentLengthRange(minSize || 0, maxSize || 0);
    }
    const policyResult = await signer.client.presignedPostPolicy(policy);

    return {
      uuid,
      method: "POST",
      url: signer.replaceUrl(policyResult.postURL),
      extraFormData: policyResult.formData,
      fileFieldName: "file"
    };
  }

  /** A form for a judge client to upload exactly `size` bytes as the temporary object `name`. */
  async signJudgeUpload(name: string, size: number): Promise<SignedFileUploadRequestDto> {
    if (!name.startsWith(TEMPORARY_OBJECT_PREFIX)) throw new Error("Judges only upload temporary objects");
    return await this.signUploadRequest(
      size,
      size,
      name,
      new Date(Date.now() + JUDGE_FILE_DOWNLOAD_EXPIRE_TIME * 1000),
      MinioSignFor.Judge
    );
  }

  /** Stores a temporary object; see `TEMPORARY_OBJECT_PREFIX`. */
  async putTemporaryObject(name: string, data: Buffer): Promise<void> {
    if (!name.startsWith(TEMPORARY_OBJECT_PREFIX)) throw new Error("Not a temporary object");
    await this.minioClient.putObject(this.bucket, name, data, data.length);
  }

  /** Reads a stored object of at most `maximumBytes`. */
  async readObject(name: string, maximumBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of await this.minioClient.getObject(this.bucket, name)) {
      size += chunk.length;
      if (size > maximumBytes) throw new Error("FILE_SIZE_LIMIT");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** The temporary objects under `prefix`. */
  async listTemporaryObjects(prefix: string): Promise<{ name: string; lastModified: Date }[]> {
    if (!prefix.startsWith(TEMPORARY_OBJECT_PREFIX)) throw new Error("Not a temporary prefix");
    const objects: { name: string; lastModified: Date }[] = [];
    for await (const object of this.minioClient.listObjectsV2(this.bucket, prefix, true) as AsyncIterable<{
      name?: string;
      lastModified: Date;
    }>)
      if (object.name) objects.push({ name: object.name, lastModified: object.lastModified });
    return objects;
  }

  async removeTemporaryObjects(names: string[]): Promise<void> {
    if (names.some(name => !name.startsWith(TEMPORARY_OBJECT_PREFIX))) throw new Error("Not a temporary object");
    for (let i = 0; i < names.length; i += 1000)
      // eslint-disable-next-line no-await-in-loop -- One batch at a time
      await this.minioClient.removeObjects(this.bucket, names.slice(i, i + 1000));
  }

  async signTeamUploadPart(uuid: string, size: number, expiresAt: Date): Promise<SignedFileUploadRequestDto> {
    return await this.signUploadRequest(
      size,
      size,
      uuid,
      new Date(Math.min(+expiresAt, Date.now() + FILE_UPLOAD_EXPIRE_TIME * 1000))
    );
  }

  async composeTeamUpload(uuid: string, parts: { uuid: string; size: number }[]): Promise<void> {
    const sources = await Promise.all(
      parts.map(async part => {
        let stored: Awaited<ReturnType<MinioClient["statObject"]>>;
        try {
          stored = await this.minioClient.statObject(this.bucket, part.uuid);
        } catch (error) {
          if (isMissingObject(error)) throw new BadRequestException("FILE_NOT_UPLOADED");
          throw error;
        }
        if (stored.size !== part.size) throw new BadRequestException("FILE_SIZE_MISMATCH");
        return new CopySourceOptions({ Bucket: this.bucket, Object: part.uuid, MatchETag: stored.etag });
      })
    );
    await this.minioClient.composeObject(new CopyDestinationOptions({ Bucket: this.bucket, Object: uuid }), sources);
  }

  async discardTeamUploadObjects(uuids: string[]): Promise<void> {
    const registered = await this.fileRepository.findBy({ uuid: In(uuids) });
    const retained = new Set(registered.map(file => file.uuid));
    const unused = uuids.filter(uuid => !retained.has(uuid));
    if (unused.length) await this.minioClient.removeObjects(this.bucket, unused);
  }

  /**
   * @return A function to run after transaction, to delete the file(s) actually.
   */
  async deleteFile(uuid: string | string[], transactionalEntityManager: EntityManager): Promise<() => void> {
    if (typeof uuid === "string") {
      await transactionalEntityManager.delete(FileEntity, { uuid });
      return () =>
        this.minioClient.removeObject(this.bucket, uuid).catch(e => {
          logger.error(`Failed to delete file ${uuid}: ${e}`);
        });
    }
    if (uuid.length > 0) {
      await transactionalEntityManager.delete(FileEntity, { uuid: In(uuid) });
      return () =>
        this.minioClient.removeObjects(this.bucket, uuid).catch(e => {
          logger.error(`Failed to delete file [${uuid}]: ${e}`);
        });
    }
    return () => {
      /* do nothing */
    };
  }

  /**
   * Delete a user-uploaded file before calling finishUpload()
   */
  deleteUnfinishedUploadedFile(uuid: string): void {
    this.minioClient.removeObject(this.bucket, uuid).catch(e => {
      if (isMissingObject(e)) return;
      logger.error(`Failed to delete unfinished uploaded file ${uuid}: ${e}`);
    });
  }

  async getFileSizes(uuids: string[], transcationalEntityManager: EntityManager): Promise<number[]> {
    if (uuids.length === 0) return [];
    const uniqueUuids = Array.from(new Set(uuids));
    const files = await transcationalEntityManager.findBy(FileEntity, {
      uuid: In(uniqueUuids)
    });
    const map = Object.fromEntries(files.map(file => [file.uuid, file]));
    return uuids.map(uuid => map[uuid].size);
  }

  async signDownloadLink({
    uuid,
    downloadFilename,
    signFor,
    expiresSeconds
  }: {
    uuid: string;
    downloadFilename?: string;
    signFor?: MinioSignFor;
    expiresSeconds?: number;
  }): Promise<string> {
    if (
      expiresSeconds !== undefined &&
      (!Number.isSafeInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604800)
    )
      throw new BadRequestException("Invalid download expiry");
    const client = signFor ? this.minioSigner[signFor].client : this.minioClient;
    const url = await client.presignedGetObject(
      this.bucket,
      uuid,
      // The maximum expire time is 7 days
      expiresSeconds ?? FILE_DOWNLOAD_EXPIRE_TIME,
      !downloadFilename
        ? {}
        : {
            "response-content-disposition": `attachment; filename="${encodeRFC5987ValueChars(downloadFilename)}"`
          }
    );

    if (signFor) return this.minioSigner[signFor].replaceUrl(url);
    else return url;
  }

  /**
   * Deletes stored objects that no file refers to, except recent uploads and the parts of active team uploads.
   * Objects are checked in batches, one batch at a time with one query, so a large bucket never means many
   * concurrent queries.
   *
   * @return How many objects were checked and how many deleted.
   */
  async runMaintainceTasks(batchSize = MAINTENANCE_BATCH_SIZE): Promise<{ checked: number; deleted: number }> {
    const activeUploads = await this.fileRepository.manager.findBy(TeamFileUploadEntity, {
      expiresAt: MoreThan(new Date())
    });
    const pendingTeamObjects = new Set(activeUploads.flatMap(upload => [upload.uuid, ...upload.parts]));
    let checked = 0;
    let deleted = 0;
    let batch: string[] = [];
    const deleteUnused = async () => {
      const names = batch;
      batch = [];
      if (!names.length) return;
      const used = new Set(
        (await this.fileRepository.find({ select: ["uuid"], where: { uuid: In(names) } })).map(file => file.uuid)
      );
      const unused = names.filter(name => !used.has(name));
      if (unused.length) await this.minioClient.removeObjects(this.bucket, unused);
      deleted += unused.length;
    };
    // The listing waits while a batch is checked.
    for await (const object of this.minioClient.listObjectsV2(this.bucket) as AsyncIterable<{
      name?: string;
      lastModified: Date;
    }>) {
      if (!object.name) continue;
      checked++;
      // Keep active team chunks and recent signed uploads while their policies can still be used. Expired or
      // cancelled chunks are collected.
      if (
        pendingTeamObjects.has(object.name) ||
        object.name.startsWith(TEMPORARY_OBJECT_PREFIX) ||
        +object.lastModified > Date.now() - FILE_UPLOAD_EXPIRE_TIME * 1000
      )
        continue;
      batch.push(object.name);
      // eslint-disable-next-line no-await-in-loop -- One batch at a time
      if (batch.length >= batchSize) await deleteUnused();
    }
    await deleteUnused();
    return { checked, deleted };
  }
}
