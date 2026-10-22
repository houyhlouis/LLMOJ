// Test data archives are read with the same rules as the judge's answer archives (@libreoj/judge-protocol/archive):
// real ZIP files whose names, sizes, checksums or data are wrong are refused, and nothing of them stays behind.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText,
    filename
  );
const { extractSafeZip, ArchiveError } = require("./safe-zip.ts");

// The extraction keeps 2 GiB free beside its files; a test's temporary directory may be smaller
const statfs = fs.promises.statfs;
fs.promises.statfs = async () => ({ bavail: 1024 ** 2, bsize: 1024 ** 2 });
test.after(() => (fs.promises.statfs = statfs));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-safe-zip-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A ZIP archive written byte by byte: entries of name, data, and optionally method 8, descriptor, size, crc, mode. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 0;
    const compressed = entry.compressed ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = entry.crc ?? zlib.crc32(data);
    const size = entry.size ?? data.length;
    const flags = 0x800 | (entry.descriptor ? 0x08 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const parts = [local, name, compressed];
    if (entry.descriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(size, 12);
      parts.push(descriptor);
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((entry.mode ?? 0o100644) * 0x10000, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    locals.push(...parts);
    offset += parts.reduce((sum, part) => sum + part.length, 0);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let count = 0;
async function extract(content) {
  const directory = path.join(root, String(count++));
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "archive.zip"), content);
  const destination = path.join(directory, "files");
  try {
    return { result: await extractSafeZip(path.join(directory, "archive.zip"), destination), destination };
  } catch (error) {
    // Nothing of a refused archive stays
    assert.deepEqual(fs.existsSync(destination) ? fs.readdirSync(destination) : [], []);
    throw error;
  }
}
const refused = (content, code) =>
  assert.rejects(extract(content), error => error instanceof ArchiveError && error.code === code);

test("an archive's files are extracted under flattened names, stored, deflated or with sizes after the data", async () => {
  const { result, destination } = await extract(
    zip([
      { name: "data/1.in", data: "1 2\n" },
      { name: "data/1.out", data: "3\n", method: 8 },
      { name: "data/sub/2.in", data: "x".repeat(5000), method: 8, descriptor: true },
      { name: "data/__MACOSX/._1.in", data: "skipped" }
    ])
  );
  assert.deepEqual(
    result.files.map(file => [file.filename, file.size]),
    [
      ["1.in", 4],
      ["1.out", 2],
      ["sub__2.in", 5000]
    ]
  );
  assert.deepEqual(result.pairs, [{ inputFile: "1.in", outputFile: "1.out" }]);
  assert.deepEqual(result.skippedFiles, ["data/__MACOSX/._1.in"]);
  assert.equal(fs.readFileSync(path.join(destination, "sub__2.in"), "utf8"), "x".repeat(5000));
});

test("names that could leave the destination, links, and names given twice are refused", async () => {
  await refused(zip([{ name: "../1.in", data: "1" }]), "UNSAFE_ZIP_PATH");
  await refused(zip([{ name: "/etc/passwd", data: "1" }]), "UNSAFE_ZIP_PATH");
  await refused(zip([{ name: "link", data: "/etc/passwd", mode: 0o120777 }]), "UNSAFE_ZIP_ENTRY");
  await refused(
    zip([
      { name: "1.in", data: "1" },
      { name: "1.IN", data: "2" }
    ]),
    "DUPLICATE_ZIP_PATH"
  );
});

test("a file larger than it declares, or whose checksum or data is wrong, is refused with nothing left", async () => {
  await refused(
    zip([
      { name: "1.in", data: "fine" },
      { name: "2.in", data: "y".repeat(100000), method: 8, size: 10 }
    ]),
    "ZIP_EXPANSION_LIMIT"
  );
  await refused(
    zip([
      { name: "1.in", data: "fine" },
      { name: "2.in", data: "checksum", crc: 1 }
    ]),
    "ZIP_INTEGRITY_ERROR"
  );
  await refused(
    zip([{ name: "1.in", data: "damaged", method: 8, compressed: Buffer.from([0xff, 0xff]) }]),
    "ZIP_INTEGRITY_ERROR"
  );
  await refused(zip([{ name: "1.in", data: "short", size: 100 }]), "ZIP_INTEGRITY_ERROR");
});

test("what isn't a ZIP archive is refused", async () => {
  await refused(Buffer.from("not a zip archive, though long enough to be one"), "INVALID_ZIP");
  await refused(Buffer.from("tiny"), "ZIP_SIZE_LIMIT");
  const valid = zip([{ name: "1.in", data: "1" }]);
  await refused(valid.subarray(0, valid.length - 5), "INVALID_ZIP");
});
