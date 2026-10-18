// Maintenance deletes stored objects no file refers to. It checks them in batches, one batch at a time, so a large
// bucket can't start thousands of concurrent queries (it used to start one per object, all at once).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Readable } = require("node:stream");
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
const { FileService } = require("./file.service.ts");

const old = new Date(Date.now() - 3600 * 1000);

function fixture({ objects, files, uploads = [] }) {
  const calls = { queries: [], removed: [], inFlight: 0, maxInFlight: 0 };
  const service = Object.create(FileService.prototype);
  Object.assign(service, {
    bucket: "test",
    minioClient: {
      listObjectsV2: bucket => {
        assert.equal(bucket, "test");
        return Readable.from(objects, { objectMode: true });
      },
      removeObjects: async (bucket, names) => {
        calls.removed.push(...names);
      }
    },
    fileRepository: {
      manager: { findBy: async () => uploads },
      find: async ({ where }) => {
        calls.inFlight++;
        calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
        // The operator TypeORM's In() builds
        const names = where.uuid.value;
        calls.queries.push(names.length);
        await new Promise(resolve => setTimeout(resolve, 1));
        calls.inFlight--;
        return names.filter(name => files.has(name)).map(uuid => ({ uuid }));
      }
    }
  });
  return { service, calls };
}

test("unused objects are deleted, in batches checked one at a time", async () => {
  const objects = Array.from({ length: 1234 }, (_, i) => ({ name: `object-${i}`, lastModified: old }));
  const files = new Set(objects.filter((_, i) => i % 3 === 0).map(object => object.name));
  const { service, calls } = fixture({ objects, files });
  assert.deepEqual(await service.runMaintainceTasks(100), { checked: 1234, deleted: 1234 - files.size });
  assert.equal(calls.maxInFlight, 1);
  assert(calls.queries.every(size => size <= 100));
  assert.equal(calls.queries.length, 13);
  assert.equal(calls.removed.length, 1234 - files.size);
  assert(calls.removed.every(name => !files.has(name)));
});

test("recent uploads and the parts of active team uploads are kept", async () => {
  const objects = [
    { name: "recent", lastModified: new Date() },
    { name: "team-upload", lastModified: old },
    { name: "team-part", lastModified: old },
    { name: "registered", lastModified: old },
    { name: "orphan", lastModified: old },
    // A directory entry of the listing has no name
    { prefix: "folder/", lastModified: old }
  ];
  const { service, calls } = fixture({
    objects,
    files: new Set(["registered"]),
    uploads: [{ uuid: "team-upload", parts: ["team-part"] }]
  });
  assert.deepEqual(await service.runMaintainceTasks(), { checked: 5, deleted: 1 });
  assert.deepEqual(calls.removed, ["orphan"]);
  assert.deepEqual(calls.queries, [2]);
});

test("an empty bucket needs no query", async () => {
  const { service, calls } = fixture({ objects: [], files: new Set() });
  assert.deepEqual(await service.runMaintainceTasks(), { checked: 0, deleted: 0 });
  assert.deepEqual(calls.queries, []);
});
