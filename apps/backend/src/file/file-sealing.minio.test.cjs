/* Sealed uploads (review N03) on a temporary MinIO server: LLMOJ_MINIO_BINARY, or an installation's runtime/minio.
 * Skipped without one. Upload forms are posted to MinIO as a browser would; the file table is kept in memory. */
// A signed upload form can be used again until it expires: S3 doesn't make it single-use. Here an old form is used
// again after the upload became a file, and the file's bytes don't change; a form can't be redirected to a file's
// object; a replacement during sealing is refused by MinIO's If-Match; simultaneous completions make one file; a
// team upload in parts is composed from its parts.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
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
const { Client } = require("minio");
const { FileService, stagingObject } = require("./file.service.ts");

const minioBinary =
  process.env.LLMOJ_MINIO_BINARY ||
  ["/opt/LLMOJ/runtime/minio"].find(file => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
const skip = !minioBinary && "needs MinIO (LLMOJ_MINIO_BINARY, or an installation's runtime/minio)";
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

let context;
test.before(async () => {
  if (skip) return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-file-sealing-"));
  const [port, consolePort] = [await freePort(), await freePort()];
  const accessKey = "sealing-" + crypto.randomBytes(4).toString("hex");
  const secretKey = crypto.randomBytes(16).toString("hex");
  const server = spawn(
    minioBinary,
    ["server", "--quiet", "--address", `127.0.0.1:${port}`, "--console-address", `127.0.0.1:${consolePort}`, directory],
    { env: { ...process.env, MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey }, stdio: "ignore" }
  );
  const client = new Client({ endPoint: "127.0.0.1", port, useSSL: false, accessKey, secretKey, region: "us-east-1" });
  for (let attempt = 0; ; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await client.makeBucket("sealing", "us-east-1");
      break;
    } catch (e) {
      if (attempt > 100) throw e;
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  // The file table: uuid and uploadUuid are unique, as in the database
  const files = [];
  const matches = (file, where) => [where].flat().some(w => Object.entries(w).every(([key, value]) => file[key] === value));
  const fileRepository = {
    countBy: async where => files.filter(file => matches(file, where)).length,
    findBy: async ({ uuid }) => files.filter(file => (uuid.value ?? [uuid]).includes(file.uuid))
  };
  const manager = {
    countBy: async (_entity, where) => files.filter(file => matches(file, where)).length,
    insert: async (_entity, record) => {
      if (files.some(file => file.uuid === record.uuid || (record.uploadUuid && file.uploadUuid === record.uploadUuid)))
        throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
      files.push(record);
    }
  };
  const endpoint = `http://127.0.0.1:${port}`;
  const service = new FileService(fileRepository, {
    config: {
      services: { minio: { default: { endpoint, urlEndpoint: null }, accessKey, secretKey, bucket: "sealing" } }
    }
  });
  context = { server, directory, client, service, manager, files };
});
test.after(() => {
  if (!context) return;
  context.server.kill();
  fs.rmSync(context.directory, { recursive: true, force: true });
});

// Posts a signed form as a browser does, optionally with other fields
async function post(signed, content, fields = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ ...signed.extraFormData, ...fields })) form.append(key, value);
  form.append(signed.fileFieldName, new Blob([content]));
  return await fetch(signed.url, { method: signed.method, body: form });
}
async function download(uuid) {
  return Buffer.from(await (await fetch(await context.service.signDownloadLink({ uuid }))).arrayBuffer());
}
const noLimit = () => null;

test("an old upload form, used again after its upload became a file, doesn't change the file", { skip }, async () => {
  const { service, manager, client } = context;
  const original = Buffer.from("the original answer\n");
  const signed = await service.prepareUploadRequest(original.length, noLimit);
  assert.equal(signed.extraFormData.key, stagingObject(signed.uuid), "the form writes the upload's staging object");
  assert((await post(signed, original)).ok);
  const file = await service.processUploadRequest({ uuid: signed.uuid, size: original.length }, noLimit, manager);
  assert.notEqual(file.uuid, signed.uuid);
  assert.equal(file.sha256, sha256(original));
  await assert.rejects(client.statObject("sealing", stagingObject(signed.uuid)), /Not Found|NotFound|does not exist/,
    "staging is deleted once the file is registered");
  // The form is still valid, and MinIO accepts it again: same size, other bytes
  const replacement = Buffer.from("a replaced answer!!\n");
  assert.equal(replacement.length, original.length);
  assert((await post(signed, replacement)).ok, "S3 upload forms can be used again until they expire");
  assert.deepEqual(await download(file.uuid), original, "the file is what was sealed");
  const staged = Buffer.concat(await (await client.getObject("sealing", stagingObject(signed.uuid))).toArray());
  assert.deepEqual(staged, replacement, "only staging changed");
  assert.equal(
    await service.processUploadRequest({ uuid: signed.uuid, size: original.length }, noLimit, manager),
    "FILE_UUID_EXISTS"
  );
});

test("a form can't be pointed at a file's object, or write more or fewer bytes than signed", { skip }, async () => {
  const { service, manager } = context;
  const content = Buffer.from("published file\n");
  const signed = await service.prepareUploadRequest(content.length, noLimit);
  assert((await post(signed, content)).ok);
  const file = await service.processUploadRequest({ uuid: signed.uuid, size: content.length }, noLimit, manager);
  const again = await service.prepareUploadRequest(content.length, noLimit);
  for (const key of [file.uuid, signed.uuid, stagingObject(signed.uuid)])
    assert.equal((await post(again, Buffer.from("overwritten  !!\n"), { key })).status, 403, key);
  assert.equal((await post(again, Buffer.from("too long for the form\n"))).ok, false);
  assert.deepEqual(await download(file.uuid), content);
});

test("an upload replaced while it's sealed is refused by MinIO's If-Match, and leaves no copy", { skip }, async () => {
  const { service, manager, client, files } = context;
  const content = Buffer.from("measured bytes\n");
  const signed = await service.prepareUploadRequest(content.length, noLimit);
  assert((await post(signed, content)).ok);
  const objectsBefore = await list(client);
  const compose = service.minioClient.composeObject.bind(service.minioClient);
  service.minioClient.composeObject = async (...args) => {
    // The form writes other bytes of the same size after the size check
    assert((await post(signed, Buffer.from("replaced bytes\n"))).ok);
    return await compose(...args);
  };
  try {
    await assert.rejects(
      service.processUploadRequest({ uuid: signed.uuid, size: content.length }, noLimit, manager),
      /FILE_CHANGED_DURING_UPLOAD/
    );
  } finally {
    service.minioClient.composeObject = compose;
  }
  assert.equal(files.filter(file => file.uploadUuid === signed.uuid).length, 0);
  assert.deepEqual(await list(client), objectsBefore, "no sealed copy is left behind");
});

test("simultaneous completions of one upload make one file, and the other copies are deleted", { skip }, async () => {
  const { service, manager, client, files } = context;
  const content = crypto.randomBytes(256 * 1024);
  const signed = await service.prepareUploadRequest(content.length, noLimit);
  assert((await post(signed, content)).ok);
  const before = new Set(await list(client));
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      service.processUploadRequest({ uuid: signed.uuid, size: content.length }, noLimit, manager)
    )
  );
  const made = results.filter(result => typeof result === "object");
  assert.equal(made.length, 1);
  assert.equal(results.filter(result => result === "FILE_UUID_EXISTS").length, 5);
  assert.equal(files.filter(file => file.uploadUuid === signed.uuid).length, 1);
  assert.deepEqual((await list(client)).filter(name => !before.has(name)), [made[0].uuid]);
  assert.deepEqual(await download(made[0].uuid), content);
});

test("a team upload in parts is composed from its parts, and its part forms can't change the file", { skip }, async () => {
  const { service, client } = context;
  // Every part but the last has at least 5 MiB, as S3 composition requires
  const parts = [crypto.randomBytes(5 * 1024 * 1024), crypto.randomBytes(1000)];
  const uploadUuid = crypto.randomUUID();
  const partUuids = parts.map(() => crypto.randomUUID());
  const expiresAt = new Date(Date.now() + 600000);
  const forms = await Promise.all(parts.map((part, i) => service.signTeamUploadPart(partUuids[i], part.length, expiresAt)));
  for (let i = 0; i < parts.length; i++) assert((await post(forms[i], parts[i])).ok);
  const size = parts[0].length + parts[1].length;
  const sealed = await service.sealUpload(
    uploadUuid,
    size,
    parts.map((part, i) => ({ uuid: partUuids[i], size: part.length })),
    false
  );
  assert.equal(sealed.size, size);
  assert.equal(sealed.sha256, null, "team files are hashed in the background");
  assert((await post(forms[1], crypto.randomBytes(1000))).ok);
  const stored = Buffer.concat(await (await client.getObject("sealing", sealed.uuid)).toArray());
  assert.deepEqual(stored, Buffer.concat(parts));
  await service.discardUploads([uploadUuid, ...partUuids]);
  assert.deepEqual((await list(client)).filter(name => partUuids.some(part => name.includes(part))), []);
  await service.discardSealedUpload(sealed);
  assert.equal((await list(client)).includes(sealed.uuid), false, "an unregistered copy is deleted");
});

async function list(client) {
  const names = [];
  for await (const object of client.listObjectsV2("sealing", "", true)) names.push(object.name);
  return names.sort();
}
