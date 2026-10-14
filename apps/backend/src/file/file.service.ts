import { URL } from "url";
import { Readable, Transform } from "stream";
import fs from "fs";
import { pipeline } from "stream/promises";

import { BadRequestException, Injectable, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository, EntityManager, In, MoreThan } from "typeorm";
import { v4 as UUID } from "uuid";
import { Client as MinioClient, ClientOptions } from "minio";
import * as minioHelpers from "minio/dist/main/helpers";

import { FileEntity } from "./file.entity";

import { FileUploadInfoDto, SignedFileUploadRequestDto } from "./dto";

import { TeamFileUploadEntity } from "../team/team.entity";
import { logger } from "../logger";
import { ConfigService } from "../config/config.service";

// 10 minutes upload expire time
const FILE_UPLOAD_EXPIRE_TIME = 10 * 60;
// Default download links last 20 hours; private team files explicitly request 60 seconds.
const FILE_DOWNLOAD_EXPIRE_TIME = 20 * 60 * 60;

// MinIO 7 exposes these constructors from its helpers module, while its public
// declarations expose their types from minio. Composition copies on the server.
const minioCopy = minioHelpers as Pick<typeof import("minio"), "CopySourceOptions" | "CopyDestinationOptions">;

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

  async uploadFile(uuid: string, streamOrBufferOrFile: string | Buffer | Readable, retryCount = 10): Promise<void> {
    for (let i = 0; i < retryCount; i++) {
      try {
        /* eslint-disable no-await-in-loop */
        if (typeof streamOrBufferOrFile === "string")
          await this.minioClient.fPutObject(this.bucket, uuid, streamOrBufferOrFile, {});
        else await this.minioClient.putObject(this.bucket, uuid, streamOrBufferOrFile, {});
        /* eslint-enable no-await-in-loop */
        return;
      } catch (e) {
        if (i === retryCount - 1) throw e;
        else {
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
      }
    }
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
    transactionalEntityManager: EntityManager
  ): Promise<FileEntity | SignedFileUploadRequestDto | LimitCheckErrorType | "FILE_UUID_EXISTS" | "FILE_NOT_UPLOADED"> {
    if (!uploadInfo.uuid) return await this.prepareUploadRequest(uploadInfo.size, checkLimit);

    if ((await transactionalEntityManager.countBy(FileEntity, { uuid: uploadInfo.uuid })) !== 0)
      return "FILE_UUID_EXISTS";

    let actualSize: number;
    try {
      actualSize = (await this.minioClient.statObject(this.bucket, uploadInfo.uuid)).size;
    } catch (e) {
      if (e.message === "The specified key does not exist.") {
        return "FILE_NOT_UPLOADED";
      }
      throw e;
    }

    if (!Number.isSafeInteger(actualSize) || actualSize < 0 || actualSize !== uploadInfo.size)
      throw new BadRequestException("FILE_SIZE_MISMATCH");
    const limitCheckError = await checkLimit(actualSize);
    if (limitCheckError) return limitCheckError;

    const file = new FileEntity();
    file.uuid = uploadInfo.uuid;
    file.size = actualSize;
    file.uploadTime = new Date();

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
    expiresAt = new Date(Date.now() + FILE_UPLOAD_EXPIRE_TIME * 1000)
  ): Promise<SignedFileUploadRequestDto> {
    const signer = this.minioSigner[MinioSignFor.UserUpload];
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
          if (
            error.code === "NoSuchKey" ||
            error.code === "NotFound" ||
            error.message === "The specified key does not exist."
          )
            throw new BadRequestException("FILE_NOT_UPLOADED");
          throw error;
        }
        if (stored.size !== part.size) throw new BadRequestException("FILE_SIZE_MISMATCH");
        return new minioCopy.CopySourceOptions({ Bucket: this.bucket, Object: part.uuid, MatchETag: stored.etag });
      })
    );
    await this.minioClient.composeObject(
      new minioCopy.CopyDestinationOptions({ Bucket: this.bucket, Object: uuid }),
      sources
    );
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
      if (e.message === "The specified key does not exist.") return;
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
    noExpire,
    signFor,
    expiresSeconds
  }: {
    uuid: string;
    downloadFilename?: string;
    noExpire?: boolean;
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
      expiresSeconds ?? (noExpire ? 24 * 60 * 60 * 7 : FILE_DOWNLOAD_EXPIRE_TIME),
      !downloadFilename
        ? {}
        : {
            "response-content-disposition": `attachment; filename="${encodeRFC5987ValueChars(downloadFilename)}"`
          }
    );

    if (signFor) return this.minioSigner[signFor].replaceUrl(url);
    else return url;
  }

  async runMaintainceTasks(): Promise<void> {
    const activeUploads = await this.fileRepository.manager.findBy(TeamFileUploadEntity, {
      expiresAt: MoreThan(new Date())
    });
    const pendingTeamObjects = new Set(activeUploads.flatMap(upload => [upload.uuid, ...upload.parts]));
    // Delete unused files
    const stream = this.minioClient.listObjectsV2(this.bucket);
    const deleteList: string[] = [];
    await new Promise((resolve, reject) => {
      const promises: Promise<void>[] = [];
      stream.on("data", object => {
        promises.push(
          (async () => {
            const uuid = object.name;
            // Keep active team chunks and recent signed uploads while their
            // policies can still be used. Expired/cancelled chunks are collected.
            if (pendingTeamObjects.has(uuid) || +object.lastModified > Date.now() - FILE_UPLOAD_EXPIRE_TIME * 1000)
              return;
            if (!(await this.fileRepository.countBy({ uuid }))) {
              deleteList.push(uuid);
            }
          })()
        );
      });
      stream.on("end", () => Promise.all(promises).then(resolve).catch(reject));
      stream.on("error", reject);
    });
    await this.minioClient.removeObjects(this.bucket, deleteList);
  }
}
