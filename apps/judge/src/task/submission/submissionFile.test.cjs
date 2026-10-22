/* Run with the judge's installed dependencies, after building @libreoj/judge-protocol:
 * node --test apps/judge/src/task/submission/submissionFile.test.cjs. */
// Submitted answer archives are real ZIP files from contestants: their files are bounded by the bytes they actually
// inflate to, a file named twice is refused, every stream error ends the extraction, and each attempt works in a
// directory of its own.
const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Writable } = require("node:stream");
const zlib = require("node:zlib");
const ts = require("typescript");

const OUTPUT_LIMIT = 4096;
const canceledError = class CanceledError extends Error {};

function load(file, overrides) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", "__dirname", source)(
    name => (name in overrides ? overrides[name] : require(name)),
    loaded,
    loaded.exports,
    __dirname
  );
  return loaded.exports;
}

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const archives = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-answer-test-"));
process.on("exit", () => fs.rmSync(archives, { recursive: true, force: true }));

const { SubmissionFile, ANSWER_ARCHIVE_LIMITS, ARCHIVE_ERROR_MESSAGES, reservedAnswerBytes } = load(
  "submissionFile.ts",
  {
    winston: { verbose() {} },
    "../../config": { serverSideConfig: { limit: { outputSize: OUTPUT_LIMIT } } },
    // The "URL" is a local archive
    "../../utils": { download: (url, destination) => fs.promises.copyFile(url, destination) },
    "../../fsNative": { remove: directory => fs.promises.rm(directory, { recursive: true, force: true }) },
    "../../file": {
      hashFileAtPath: async file => sha256(await fs.promises.readFile(file)),
      fileContentMismatch: () => new Error("mismatch")
    },
    "../../error": { CanceledError: canceledError }
  }
);

/**
 * A ZIP archive written byte by byte, so that it can say what a well-behaved writer never would. Each entry:
 * name, data, method (0 stored, 8 deflated), and optionally descriptor (sizes after the data), size and crc (what
 * the archive declares), flags, compressed (the stored bytes).
 */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const method = entry.method ?? 0;
    const compressed = entry.compressed ?? (method === 8 ? zlib.deflateRawSync(data) : data);
    const crc = entry.crc ?? zlib.crc32(data);
    const size = entry.size ?? data.length;
    const flags = (entry.flags ?? 0x800) | (entry.descriptor ? 0x08 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
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
    header.writeUInt16LE(0x21, 14);
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

let archiveCount = 0;
const opened = [];
function answerFile(content) {
  const file = path.join(archives, `answer-${archiveCount++}.zip`);
  fs.writeFileSync(file, content);
  const answer = new SubmissionFile({ uuid: "same-upload-for-every-attempt", url: file });
  opened.push(answer);
  return answer;
}
after(() => Promise.all(opened.map(answer => answer.dispose())));

async function unzip(content, wanted, canceled) {
  const file = answerFile(content);
  await file.waitForDownload();
  const result = await file.unzip(wanted, canceled);
  const files = fs.readdirSync(result.path);
  const read = name => fs.readFileSync(result.status[name].path, "utf8");
  return { file, result, files, read };
}

test("wanted files are extracted, stored, deflated or with their sizes after the data; others aren't", async () => {
  const { file, result, files, read } = await unzip(
    zip([
      { name: "1.out", data: "1 2 3\n" },
      { name: "2.out", data: "x".repeat(4000), method: 8 },
      { name: "3.out", data: "described later\n", method: 8, descriptor: true },
      { name: "extra/notes.txt", data: "not asked for" },
      { name: "../escape.out", data: "never written" }
    ]),
    ["1.out", "2.out", "3.out", "4.out"]
  );
  assert.equal(read("1.out"), "1 2 3\n");
  assert.equal(read("2.out"), "x".repeat(4000));
  assert.equal(read("3.out"), "described later\n");
  assert.deepEqual(result.status["4.out"], undefined);
  // Written under names of the judge's choosing, only the three
  assert.deepEqual(files.sort(), ["0", "1", "2"]);
  await file.dispose();
  assert(!fs.existsSync(result.path));
});

test("a file that inflates to more than it declares is refused once it has, and nothing of it stays", async () => {
  const { result, files, read } = await unzip(
    zip([
      { name: "big.out", data: "y".repeat(100_000), method: 8, size: 1 },
      { name: "small.out", data: "ok\n" }
    ]),
    ["big.out", "small.out"]
  );
  assert.deepEqual(result.status["big.out"], { error: "ZIP_EXPANSION_LIMIT" });
  assert.equal(read("small.out"), "ok\n");
  assert.equal(files.length, 1);
});

test("files over the output limit are refused before inflating; so are those past the archive's budget", async () => {
  const over = await unzip(zip([{ name: "1.out", data: "z".repeat(OUTPUT_LIMIT + 1), method: 8 }]), ["1.out"]);
  assert.deepEqual(over.result.status["1.out"], { sizeExceededLimit: true });
  assert.deepEqual(over.files, []);

  const total = ANSWER_ARCHIVE_LIMITS.totalBytes;
  ANSWER_ARCHIVE_LIMITS.totalBytes = 5000;
  try {
    const budget = await unzip(
      zip([
        { name: "a.out", data: "a".repeat(3000) },
        { name: "b.out", data: "b".repeat(3000) },
        { name: "c.out", data: "c".repeat(1000) }
      ]),
      ["a.out", "b.out", "c.out"]
    );
    // In the archive's order: the second no longer fits, the third still does
    assert.equal(budget.result.status["a.out"].success, true);
    assert.deepEqual(budget.result.status["b.out"], { sizeExceededLimit: true });
    assert.equal(budget.result.status["c.out"].success, true);
  } finally {
    ANSWER_ARCHIVE_LIMITS.totalBytes = total;
  }
});

test("a file in the archive twice is refused, also when the names differ only in Unicode form", async () => {
  const { result, files, read } = await unzip(
    zip([
      { name: "1.out", data: "first" },
      { name: "1.out", data: "second" },
      { name: "café.out", data: "composed" },
      { name: "café.out", data: "decomposed" },
      { name: "2.out", data: "fine" }
    ]),
    ["1.out", "café.out", "2.out"]
  );
  assert.deepEqual(result.status["1.out"], { error: "ZIP_DUPLICATE_FILE" });
  assert.deepEqual(result.status["café.out"], { error: "ZIP_DUPLICATE_FILE" });
  assert.equal(read("2.out"), "fine");
  assert.equal(files.length, 1);
  assert.equal(ARCHIVE_ERROR_MESSAGES.ZIP_DUPLICATE_FILE, "The archive contains this file more than once.");
});

test("damaged data, a wrong checksum and encryption fail only their file", async () => {
  const { result, read } = await unzip(
    zip([
      { name: "crc.out", data: "checksum", crc: 1234 },
      { name: "deflate.out", data: "damaged", method: 8, compressed: Buffer.from([0xff, 0xff, 0xff, 0xff]) },
      { name: "secret.out", data: "encrypted", flags: 0x801 },
      { name: "fine.out", data: "fine" }
    ]),
    ["crc.out", "deflate.out", "secret.out", "fine.out"]
  );
  assert.deepEqual(result.status["crc.out"], { error: "ZIP_INTEGRITY_ERROR" });
  assert.deepEqual(result.status["deflate.out"], { error: "ZIP_INTEGRITY_ERROR" });
  assert.deepEqual(result.status["secret.out"], { error: "UNSUPPORTED_ZIP" });
  assert.equal(read("fine.out"), "fine");
});

test("an archive that can't be read gives every wanted file its error, instead of failing the judge", async () => {
  const valid = zip([{ name: "1.out", data: "1" }]);
  for (const [content, code] of [
    [Buffer.from("not a zip archive at all, but long enough to be one"), "INVALID_ZIP"],
    [valid.subarray(0, valid.length - 10), "INVALID_ZIP"],
    [Buffer.alloc(0), "INVALID_ZIP"]
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const { result, files } = await unzip(content, ["1.out", "2.out"]);
    assert.deepEqual(result.status, { "1.out": { error: code }, "2.out": { error: code } });
    assert.deepEqual(files, []);
  }

  const entries = ANSWER_ARCHIVE_LIMITS.entries;
  ANSWER_ARCHIVE_LIMITS.entries = 3;
  try {
    const many = await unzip(zip(["1", "2", "3", "4"].map(name => ({ name: `${name}.out`, data: name }))), ["1.out"]);
    assert.deepEqual(many.result.status, { "1.out": { error: "ZIP_DIRECTORY_LIMIT" } });
  } finally {
    ANSWER_ARCHIVE_LIMITS.entries = entries;
  }
});

test("a failing destination ends the extraction promptly, with no partial file", async () => {
  const createWriteStream = fs.createWriteStream;
  let written = 0;
  fs.createWriteStream = (destination, options) => {
    const real = createWriteStream(destination, options);
    return new Writable({
      write(chunk, encoding, callback) {
        written += chunk.length;
        callback(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" }));
      },
      final(callback) {
        real.end(callback);
      },
      destroy(error, callback) {
        real.destroy();
        callback(error);
      }
    });
  };
  try {
    const file = answerFile(zip([{ name: "1.out", data: "data" }]));
    await file.waitForDownload();
    const started = Date.now();
    await assert.rejects(file.unzip(["1.out"]), { code: "ENOSPC" });
    assert(Date.now() - started < 2000);
    assert(written > 0);
    assert.deepEqual(fs.readdirSync(file.unzippedPath), []);
    await file.dispose();
  } finally {
    fs.createWriteStream = createWriteStream;
  }
});

test("without the space the answers declare, the judge fails the task instead of filling its disk", async () => {
  const statfs = fs.promises.statfs;
  fs.promises.statfs = async () => ({ bavail: 1, bsize: 4096 });
  try {
    const file = answerFile(zip([{ name: "1.out", data: "1" }]));
    await file.waitForDownload();
    await assert.rejects(file.unzip(["1.out"]), /Not enough free space/);
    await file.dispose();
  } finally {
    fs.promises.statfs = statfs;
  }
});

test("space is reserved per attempt until its files are removed", async () => {
  const before = reservedAnswerBytes();
  const { file } = await unzip(zip([{ name: "1.out", data: "1234" }]), ["1.out"]);
  assert.equal(reservedAnswerBytes(), before + 4);
  await file.dispose();
  assert.equal(reservedAnswerBytes(), before);
});

test("a canceled task stops extracting", async () => {
  const file = answerFile(zip([{ name: "1.out", data: "1" }]));
  await file.waitForDownload();
  await assert.rejects(
    file.unzip(["1.out"], () => true),
    error => error instanceof canceledError
  );
  await file.dispose();
});

test("two attempts over the same upload never share or remove each other's files", async () => {
  const content = zip([{ name: "1.out", data: "shared upload" }]);
  const first = answerFile(content);
  const second = answerFile(content);
  await Promise.all([first.waitForDownload(), second.waitForDownload()]);
  assert.notEqual(first.path, second.path);
  const [a, b] = await Promise.all([first.unzip(["1.out"]), second.unzip(["1.out"])]);
  await first.dispose();
  assert.equal(fs.readFileSync(b.status["1.out"].path, "utf8"), "shared upload");
  assert(!fs.existsSync(a.path));
  // Private to the judge's account
  assert.equal(fs.statSync(path.dirname(second.path)).mode % 0o1000, 0o700);
  await second.dispose();
});
