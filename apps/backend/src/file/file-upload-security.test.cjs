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
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { FileService, MinioSignFor, JUDGE_FILE_DOWNLOAD_EXPIRE_TIME } = require("./file.service.ts");
// An object store: name -> { data, etag, lastModified }. Forms write to staging/<upload UUID> (see FileService).
function fixture({ registered = false, objects = {}, statError, onCompose } = {}) {
  const service = Object.create(FileService.prototype),
    calls = { deletes: [], saved: [], expiry: [], checks: [], reads: [], copies: [] };
  const store = new Map();
  const put = (name, data, lastModified = new Date()) =>
    store.set(name, { data, etag: crypto.createHash("md5").update(data).digest("hex"), lastModified });
  for (const [name, data] of Object.entries(objects)) put(name, data);
  const missing = () => Object.assign(Error("The specified key does not exist."), { code: "NotFound" });
  const minio = {
    statObject: async (_bucket, name) => {
      if (statError) throw statError;
      const object = store.get(name);
      if (!object) throw missing();
      return { size: object.data.length, etag: object.etag, lastModified: object.lastModified };
    },
    getObject: async (_bucket, name) => {
      calls.reads.push(name);
      if (!store.has(name)) throw missing();
      return Readable.from([store.get(name).data]);
    },
    composeObject: async (destination, sources) => {
      await onCompose?.(store, put);
      const parts = sources.map(source => {
        const object = store.get(source.Object);
        if (!object) throw missing();
        if (source.MatchETag && source.MatchETag !== object.etag)
          throw Object.assign(Error("At least one of the pre-conditions you specified did not hold"), { code: "PreconditionFailed" });
        return object.data;
      });
      calls.copies.push([sources.map(source => source.Object), destination.Object]);
      put(destination.Object, Buffer.concat(parts));
    },
    removeObject: async (_bucket, name) => {
      calls.deletes.push(name);
      store.delete(name);
    },
    removeObjects: async (_bucket, names) => names.forEach(name => (calls.deletes.push(name), store.delete(name))),
    presignedGetObject: async (...args) => {
      calls.expiry.push(args[2]);
      return "https://storage.example/signed";
    }
  };
  const files = [];
  Object.assign(service, {
    bucket: "test",
    minioClient: minio,
    minioSigner: { [MinioSignFor.UserDownload]: { client: minio, replaceUrl: value => value } },
    fileRepository: {
      countBy: async ({ uuid }) => files.filter(file => file.uuid === uuid).length,
      // TypeORM's In() keeps its values in `value`
      findBy: async ({ uuid }) => files.filter(file => (uuid.value ?? [uuid]).includes(file.uuid))
    }
  });
  // The file table: uuid and uploadUuid are unique
  const manager = {
    countBy: async (_entity, where) =>
      registered ? 1 : files.filter(file => [where].flat().some(w => Object.entries(w).every(([k, v]) => file[k] === v))).length,
    insert: async (_entity, record) => {
      if (files.some(file => file.uuid === record.uuid || (record.uploadUuid && file.uploadUuid === record.uploadUuid)))
        throw Object.assign(Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
      files.push(record);
      calls.saved.push(record);
    }
  };
  const check = async size => {
    calls.checks.push(size);
    return size > 64 ? "FILE_TOO_LARGE" : null;
  };
  return { service, calls, manager, check, store, put, files };
}
const upload = crypto.randomUUID;
const staging = uuid => `staging/${uuid}`;
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");

test("registered uploads, and files registered under their upload's UUID, are not registered again", async () => {
  const { service, calls, manager, check } = fixture({ registered: true });
  assert.equal(await service.processUploadRequest({ uuid: upload(), size: 1000 }, check, manager), "FILE_UUID_EXISTS");
  assert.deepEqual(calls.deletes, []);
  assert.deepEqual(calls.checks, []);
  assert.deepEqual(calls.saved, []);
});
test("claimed size must equal actual stored bytes; rejected uploads are never deleted", async () => {
  for (const actualSize of [11, 9, 0]) {
    const id = upload();
    const { service, calls, manager, check } = fixture({ objects: { [staging(id)]: Buffer.alloc(actualSize) } });
    await assert.rejects(service.processUploadRequest({ uuid: id, size: 10 }, check, manager), /FILE_SIZE_MISMATCH/);
    assert.deepEqual(calls.deletes, []);
    assert.deepEqual(calls.saved, []);
    assert.deepEqual(calls.copies, []);
  }
});
test("actual quota checks reject without deleting an object another request could accept", async () => {
  const id = upload();
  const { service, calls, manager, check } = fixture({ objects: { [staging(id)]: Buffer.alloc(100) } });
  assert.equal(await service.processUploadRequest({ uuid: id, size: 100 }, check, manager), "FILE_TOO_LARGE");
  assert.deepEqual(calls.checks, [100]);
  assert.deepEqual(calls.deletes, []);
  assert.deepEqual(calls.saved, []);
  assert.deepEqual(calls.copies, [], "nothing is copied before the limits are checked");
});
test("an accepted upload is sealed: copied to an object of its own, which is what is hashed and registered", async () => {
  const id = upload();
  const content = Buffer.alloc(10, "x");
  const { service, calls, manager, check, store, put } = fixture({ objects: { [staging(id)]: content } });
  const file = await service.processUploadRequest({ uuid: id, size: 10 }, check, manager);
  assert.notEqual(file.uuid, id);
  assert.match(file.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(file.uploadUuid, id);
  assert.equal(file.size, 10);
  assert.equal(file.sha256, sha256(content));
  assert.deepEqual(calls.copies, [[[staging(id)], file.uuid]]);
  assert.deepEqual(calls.reads, [file.uuid], "the copy is read once, to record its hash");
  assert.equal(store.has(staging(id)), false, "staging is deleted once the copy is registered");
  // The form can write staging again; the file doesn't change
  put(staging(id), Buffer.alloc(10, "y"));
  assert.deepEqual(store.get(file.uuid).data, content);
  // ...and the upload can't be completed again
  assert.equal(await service.processUploadRequest({ uuid: id, size: 10 }, check, manager), "FILE_UUID_EXISTS");
  assert.equal(calls.copies.length, 1);
});
test("missing uploads and upload UUIDs the backend never issued stay unregistered", async () => {
  const missing = fixture();
  for (const uuid of [upload(), "../other", "not-a-uuid", `staging/${upload()}`])
    assert.equal(
      await missing.service.processUploadRequest({ uuid, size: 10 }, missing.check, missing.manager),
      "FILE_NOT_UPLOADED"
    );
  assert.deepEqual(missing.calls.saved, []);
  assert.deepEqual(missing.calls.deletes, []);
});
test("a form signed before sealing is completed from its own object for a while, and sealed all the same", async () => {
  const id = upload();
  const content = Buffer.alloc(10, "z");
  const { service, manager, check, store, put } = fixture({ objects: { [id]: content } });
  const file = await service.processUploadRequest({ uuid: id, size: 10 }, check, manager);
  assert.notEqual(file.uuid, id, "the legacy object, which the old form can still write, is never the file");
  assert.equal(file.sha256, sha256(content));
  // After the window, an unregistered object at an upload's UUID isn't taken as an upload
  const late = upload();
  put(late, content, new Date(Date.now() - 21 * 60 * 1000));
  assert.equal(await service.processUploadRequest({ uuid: late, size: 10 }, check, manager), "FILE_NOT_UPLOADED");
  assert(store.has(late));
  // ...unless it's a part a team upload's record names: those wait for the upload, however long it takes
  const team = upload();
  const sealed = await service.sealUpload(team, 10, [{ uuid: late, size: 10 }], true, true);
  assert.equal(sealed.sha256, sha256(content));
});
test("an upload replaced while it's sealed is refused, and nothing is left behind", async () => {
  const id = upload();
  const fixed = fixture({
    objects: { [staging(id)]: Buffer.alloc(10, "a") },
    // The form writes other bytes of the same size between the size check and the copy
    onCompose: (store, put) => put(staging(id), Buffer.alloc(10, "b"))
  });
  await assert.rejects(
    fixed.service.processUploadRequest({ uuid: id, size: 10 }, fixed.check, fixed.manager),
    /FILE_CHANGED_DURING_UPLOAD/
  );
  assert.deepEqual(fixed.calls.saved, []);
  assert.deepEqual([...fixed.store.keys()], [staging(id)], "only the staging object remains");
});
test("simultaneous completions of one upload register one file; the other copy is deleted", async () => {
  const id = upload();
  const { service, manager, check, store, files } = fixture({ objects: { [staging(id)]: Buffer.alloc(10, "c") } });
  const results = await Promise.all([1, 2, 3].map(() => service.processUploadRequest({ uuid: id, size: 10 }, check, manager)));
  const registered = results.filter(result => typeof result === "object");
  assert.equal(registered.length, 1);
  assert.equal(results.filter(result => result === "FILE_UUID_EXISTS").length, 2);
  assert.equal(files.length, 1);
  assert.deepEqual([...store.keys()], [registered[0].uuid], "the other copies and staging are deleted");
});
test("the content hash is of the sealed copy; a file judges don't use may leave it to the background", async () => {
  const id = upload();
  const team = fixture({ objects: { [staging(id)]: Buffer.alloc(10) } });
  const file = await team.service.processUploadRequest({ uuid: id, size: 10 }, team.check, team.manager, false);
  assert.equal(file.sha256, null);
  assert.deepEqual(team.calls.reads, []);
});
test("a team upload in parts is sealed from its parts in order; a missing part fails without a copy", async () => {
  const id = upload(),
    parts = [upload(), upload()];
  const { service, store, calls } = fixture({
    objects: { [staging(parts[0])]: Buffer.from("first-"), [staging(parts[1])]: Buffer.from("second") }
  });
  const sealed = await service.sealUpload(id, 12, [
    { uuid: parts[0], size: 6 },
    { uuid: parts[1], size: 6 }
  ]);
  assert.deepEqual(store.get(sealed.uuid).data, Buffer.from("first-second"));
  assert.equal(sealed.uploadUuid, id);
  assert.equal(sealed.sha256, sha256("first-second"));
  store.delete(staging(parts[1]));
  assert.equal(await service.sealUpload(id, 12, [{ uuid: parts[0], size: 6 }, { uuid: parts[1], size: 6 }]), "FILE_NOT_UPLOADED");
  await assert.rejects(service.sealUpload(id, 13, [{ uuid: parts[0], size: 7 }]), /FILE_SIZE_MISMATCH/);
  assert.equal(calls.copies.length, 1);
  // Storage errors other than a missing object are not hidden
  const broken = fixture({ statError: Object.assign(Error("backend unavailable"), { code: "InternalError" }) });
  await assert.rejects(broken.service.sealUpload(id, 10), /backend unavailable/);
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

test("team chunk policies bind exactly one staging object, its byte length and reservation expiry", async () => {
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
  assert.equal(policies[0].key, "staging/generated-team-part", "the form writes staging, never a file's object");
  assert.deepEqual(policies[0].range, [32 * 1024 ** 2, 32 * 1024 ** 2]);
  assert.equal(+policies[0].expiresAt, +expiry);
  await service.signTeamUploadPart("empty-team-file", 0, expiry);
  assert.deepEqual(policies[1].range, [0, 0]);
});


test("object maintenance keeps active team uploads, recent uploads and recent sealed copies", async () => {
  const { Readable } = require("node:stream");
  const service = Object.create(FileService.prototype),
    removed = [];
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  const minutesAgo = minutes => new Date(Date.now() - minutes * 60 * 1000);
  Object.assign(service, {
    bucket: "test",
    fileRepository: {
      manager: { findBy: async () => [{ uuid: "active-final", parts: ["active-chunk"] }] },
      // One query per batch of object names (TypeORM's In() keeps them in `value`)
      find: async ({ where }) => where.uuid.value.filter(uuid => uuid === "registered").map(uuid => ({ uuid }))
    },
    minioClient: {
      listObjectsV2: () =>
        Readable.from([
          { name: "staging/active-final", lastModified: old },
          { name: "staging/active-chunk", lastModified: old },
          { name: "active-chunk", lastModified: old },
          { name: "registered", lastModified: old },
          { name: "staging/recent-upload", lastModified: minutesAgo(5) },
          { name: "staging/expired-upload", lastModified: minutesAgo(15) },
          { name: "recent-unregistered-copy", lastModified: minutesAgo(15) },
          { name: "stale-unregistered-copy", lastModified: old },
          { name: "temporary/ai-run", lastModified: old }
        ]),
      removeObjects: async (_bucket, uuids) => removed.push(...uuids)
    }
  });
  await service.runMaintainceTasks();
  assert.deepEqual(removed, ["staging/expired-upload", "stale-unregistered-copy"]);
});

test("discarding uploads removes what their forms wrote, never a registered file", async () => {
  const service = Object.create(FileService.prototype),
    removed = [];
  const completed = upload(),
    pending = upload();
  Object.assign(service, {
    bucket: "test",
    fileRepository: { findBy: async () => [{ uuid: completed }] },
    minioClient: { removeObjects: async (_bucket, uuids) => removed.push(...uuids) }
  });
  await service.discardUploads([completed, pending, "../not-an-upload"]);
  assert.deepEqual(removed, [staging(completed), staging(pending), pending]);
});

test("the backend's own content becomes an upload to seal like a user's", async () => {
  const { service, store, manager, check } = fixture();
  service.uploadFile = async (name, data) => (store.set(name, { data, etag: "e", lastModified: new Date() }), sha256(data));
  const stored = await service.storeUpload(Buffer.from("int main() {}"));
  assert(store.has(staging(stored.uuid)));
  assert.equal(stored.size, 13);
  const file = await service.processUploadRequest(stored, check, manager);
  assert.equal(file.sha256, sha256("int main() {}"));
});
