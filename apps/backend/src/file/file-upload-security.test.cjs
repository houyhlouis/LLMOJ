const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
const { FileService, MinioSignFor, JUDGE_FILE_DOWNLOAD_EXPIRE_TIME } = require("./file.service.ts");
function fixture({ registered = false, actualSize = 10, statError } = {}) {
  const service = Object.create(FileService.prototype),
    calls = { deletes: [], saved: [], expiry: [], checks: [] };
  const minio = {
    statObject: async () => {
      if (statError) throw statError;
      return { size: actualSize };
    },
    removeObject: async (...args) => calls.deletes.push(args),
    presignedGetObject: async (...args) => {
      calls.expiry.push(args[2]);
      return "https://storage.example/signed";
    }
  };
  Object.assign(service, {
    bucket: "test",
    minioClient: minio,
    minioSigner: { [MinioSignFor.UserDownload]: { client: minio, replaceUrl: value => value } }
  });
  const manager = {
    countBy: async () => (registered ? 1 : 0),
    save: async (_entity, record) => {
      calls.saved.push(record);
      return record;
    }
  };
  const check = async size => {
    calls.checks.push(size);
    return size > 64 ? "FILE_TOO_LARGE" : null;
  };
  return { service, calls, manager, check };
}
test("registered UUIDs cannot be deleted by supplying an oversized upload", async () => {
  const { service, calls, manager, check } = fixture({ registered: true });
  assert.equal(
    await service.processUploadRequest({ uuid: "existing-evidence", size: 1000 }, check, manager),
    "FILE_UUID_EXISTS"
  );
  assert.deepEqual(calls.deletes, []);
  assert.deepEqual(calls.checks, []);
  assert.deepEqual(calls.saved, []);
});
test("claimed size must equal actual stored bytes; rejected UUIDs are never deleted", async () => {
  for (const actualSize of [11, 67108865, -1, NaN]) {
    const { service, calls, manager, check } = fixture({ actualSize });
    await assert.rejects(
      service.processUploadRequest({ uuid: "pending-other-request", size: 10 }, check, manager),
      /FILE_SIZE_MISMATCH/
    );
    assert.deepEqual(calls.deletes, []);
    assert.deepEqual(calls.saved, []);
  }
});
test("actual quota checks reject without deleting an object another request could accept", async () => {
  const { service, calls, manager, check } = fixture({ actualSize: 100 });
  assert.equal(
    await service.processUploadRequest({ uuid: "pending-object", size: 100 }, check, manager),
    "FILE_TOO_LARGE"
  );
  assert.deepEqual(calls.checks, [100]);
  assert.deepEqual(calls.deletes, []);
  assert.deepEqual(calls.saved, []);
});
test("valid uploads persist their verified size and missing objects remain unregistered", async () => {
  const { service, calls, manager, check } = fixture();
  const file = await service.processUploadRequest({ uuid: "valid-object", size: 10 }, check, manager);
  assert.equal(file.uuid, "valid-object");
  assert.equal(file.size, 10);
  assert.deepEqual(calls.checks, [10]);
  const missing = fixture({ statError: Error("The specified key does not exist.") });
  assert.equal(
    await missing.service.processUploadRequest({ uuid: "missing", size: 10 }, missing.check, missing.manager),
    "FILE_NOT_UPLOADED"
  );
  assert.deepEqual(missing.calls.saved, []);
  assert.deepEqual(missing.calls.deletes, []);
});
test("team download links expire after 60 seconds and invalid lifetimes are rejected", async () => {
  const { service, calls } = fixture();
  await service.signDownloadLink({ uuid: "private-team-file", signFor: MinioSignFor.UserDownload, expiresSeconds: 60 });
  assert.deepEqual(calls.expiry, [60]);
  await service.signDownloadLink({ uuid: "ordinary-file" });
  await service.signDownloadLink({ uuid: "judge-file", expiresSeconds: JUDGE_FILE_DOWNLOAD_EXPIRE_TIME });
  assert.equal(JUDGE_FILE_DOWNLOAD_EXPIRE_TIME, 21600);
  assert.deepEqual(calls.expiry, [60, 72000, 21600]);
  for (const expiry of [0, -1, 1.5, 604801, NaN])
    await assert.rejects(
      service.signDownloadLink({ uuid: "private", expiresSeconds: expiry }),
      /Invalid download expiry/
    );
});

test("team chunk policies bind exactly one generated object, its byte length and reservation expiry", async () => {
  const service = Object.create(FileService.prototype),
    policies = [];
  Object.assign(service, {
    bucket: "test",
    minioSigner: {
      [MinioSignFor.UserUpload]: {
        replaceUrl: value => value,
        client: {
          newPostPolicy: () => {
            const policy = {};
            policies.push(policy);
            return {
              setBucket: value => {
                policy.bucket = value;
              },
              setKey: value => {
                policy.key = value;
              },
              setExpires: value => {
                policy.expiresAt = value;
              },
              setContentLengthRange: (min, max) => {
                policy.range = [min, max];
              }
            };
          },
          presignedPostPolicy: async () => ({ postURL: "https://storage.example/upload", formData: {} })
        }
      }
    }
  });
  const expiry = new Date(Date.now() + 10000);
  const signed = await service.signTeamUploadPart("generated-team-part", 32 * 1024 ** 2, expiry);
  assert.equal(signed.uuid, "generated-team-part");
  assert.deepEqual(policies[0].range, [32 * 1024 ** 2, 32 * 1024 ** 2]);
  assert.equal(+policies[0].expiresAt, +expiry);
  await service.signTeamUploadPart("empty-team-file", 0, expiry);
  assert.deepEqual(policies[1].range, [0, 0]);
});

test("object maintenance keeps active team chunks and recent uploads while collecting stale cancelled chunks", async () => {
  const { Readable } = require("node:stream");
  const service = Object.create(FileService.prototype),
    removed = [];
  const old = new Date(Date.now() - 3600 * 1000);
  Object.assign(service, {
    bucket: "test",
    fileRepository: {
      manager: { findBy: async () => [{ uuid: "active-final", parts: ["active-chunk"] }] },
      countBy: async ({ uuid }) => (uuid === "registered" ? 1 : 0)
    },
    minioClient: {
      listObjectsV2: () =>
        Readable.from([
          { name: "active-final", lastModified: old },
          { name: "active-chunk", lastModified: old },
          { name: "registered", lastModified: old },
          { name: "recent-cancelled", lastModified: new Date() },
          { name: "stale-cancelled", lastModified: old }
        ]),
      removeObjects: async (_bucket, uuids) => removed.push(...uuids)
    }
  });
  await service.runMaintainceTasks();
  assert.deepEqual(removed, ["stale-cancelled"]);
});

test("cancellation cleanup cannot remove an already registered completed file", async () => {
  const service = Object.create(FileService.prototype),
    removed = [];
  Object.assign(service, {
    bucket: "test",
    fileRepository: { findBy: async () => [{ uuid: "completed" }] },
    minioClient: { removeObjects: async (_bucket, uuids) => removed.push(...uuids) }
  });
  await service.discardTeamUploadObjects(["completed", "own-pending-chunk"]);
  assert.deepEqual(removed, ["own-pending-chunk"]);
});

test("composing missing team chunks reports a client error for real MinIO HEAD responses", async () => {
  for (const code of ["NoSuchKey", "NotFound"]) {
    const { service } = fixture({ statError: Object.assign(Error("missing chunk"), { code }) });
    await assert.rejects(
      service.composeTeamUpload("target", [{ uuid: "missing-part", size: 10 }]),
      error => error.getStatus() === 400 && error.message === "FILE_NOT_UPLOADED"
    );
  }
  const { service } = fixture({ statError: Object.assign(Error("backend unavailable"), { code: "InternalError" }) });
  await assert.rejects(service.composeTeamUpload("target", [{ uuid: "part", size: 10 }]), /backend unavailable/);
});
