// Run with: node --test packages/frontend/test/contest-archive.test.cjs
// The contest archive the page writes: the actual contestArchive.ts and streamsaver's zip-stream writer, with the
// server's manifest, the attachment downloads and the save dialog replaced. The ZIP is read back byte by byte.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { test } = require("node:test");
const ts = require("typescript");

const globals = { ReadableStream, TextEncoder, Response, Blob, Uint8Array, DataView, Date, Promise, Error, TypeError, atob, Intl };

function zipWriter() {
  const window = {};
  const file = require.resolve("streamsaver/examples/zip-stream.js", { paths: [path.join(__dirname, "..")] });
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { window, ...globals }, { filename: file });
  return window.ZIP;
}

function load(relative, dependencies, extraGlobals = {}) {
  const filename = path.join(__dirname, "../src", relative);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require: name => {
        if (!(name in dependencies)) throw new Error(`Unexpected runtime import: ${name}`);
        return dependencies[name];
      },
      ...globals,
      ...extraGlobals
    },
    { filename }
  );
  return module.exports;
}

// Values made inside the module's context have its own Array and Object
const plain = value => JSON.parse(JSON.stringify(value));

/** Reads a ZIP's central directory and each file's bytes */
function readZip(bytes) {
  const data = Buffer.from(bytes);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "end of central directory");
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(at), 0x02014b50);
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16);
    const size = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    assert.equal(data.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const content = data.subarray(start, start + size);
    entries.push({ name, flags, method, crc, content });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function manifest() {
  return {
    filename: "Spring_ Round 1_.zip",
    pdf: Buffer.from("%PDF-1.7 statements").toString("base64"),
    pages: 3,
    warnings: [],
    folders: [
      {
        name: "test",
        label: "A",
        files: [
          { name: "sample1.in", text: "1 2\n" },
          { name: "sample1.ans", text: "3\n" }
        ]
      },
      {
        name: "A+B Problem",
        label: "B",
        files: [
          { name: "sample1.in", text: "" },
          { name: "sample1.ans", text: "求和\n" },
          { name: "附件 说明.pdf", url: "https://files.example.com/a", size: 5 }
        ]
      },
      { name: "最短路 (2)", label: "C", files: [] }
    ],
    attachmentsWithheld: false,
    attachments: 1
  };
}

function archiveModule(server, fetched, saved) {
  return load(
    "pages/contest/contestArchive.ts",
    {
      "@/appState": { appState: { locale: "zh_CN" } },
      "@/utils/zip": { createZipStream: zipWriter() },
      "@/utils/saveStream": {
        saveStream: async (stream, filename) => {
          saved.push({ filename, bytes: new Uint8Array(await new Response(stream).arrayBuffer()), via: "stream" });
        }
      },
      "@/utils/downloadFile": {
        saveBlob: async (blob, filename) => {
          saved.push({ filename, bytes: new Uint8Array(await blob.arrayBuffer()), via: "blob" });
        }
      },
      "./api": { callContest: server }
    },
    {
      fetch: async url => {
        fetched.push(url);
        return new Response(new Blob([Buffer.from("%PDF-")]), { status: 200 });
      }
    }
  );
}

test("the entries: the PDF first, then each problem's folder and its files, in order", () => {
  const { archiveEntries } = archiveModule(async () => manifest(), [], []);
  const entries = archiveEntries(manifest());
  assert.deepEqual(
    plain(entries.map(entry => entry.path)),
    [
      "statements.pdf",
      "test",
      "test/sample1.in",
      "test/sample1.ans",
      "A+B Problem",
      "A+B Problem/sample1.in",
      "A+B Problem/sample1.ans",
      "A+B Problem/附件 说明.pdf",
      "最短路 (2)"
    ]
  );
  assert.equal(Buffer.from(entries[0].bytes).toString(), "%PDF-1.7 statements");
  assert.equal(entries[7].url, "https://files.example.com/a");
});

test("the ZIP the page writes: UTF-8 names, folders, exact bytes, attachments from their signed links", async () => {
  const calls = [];
  const fetched = [];
  const saved = [];
  const progress = [];
  const { downloadContestArchive } = archiveModule(
    async (name, request) => {
      calls.push([name, request]);
      return manifest();
    },
    fetched,
    saved
  );
  await downloadContestArchive(5, value => progress.push(value));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "archive");
  assert.equal(calls[0][1].id, 5);
  assert.equal(calls[0][1].data.locale, "zh_CN");
  assert.equal(typeof calls[0][1].data.timeZone, "string");
  assert.deepEqual(fetched, ["https://files.example.com/a"]);
  assert.deepEqual(plain(progress.at(-1)), { stage: "downloading", done: 1, total: 1 });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].filename, "Spring_ Round 1_.zip");
  assert.equal(saved[0].via, "stream");

  const entries = readZip(saved[0].bytes);
  assert.deepEqual(
    entries.map(entry => entry.name),
    [
      "statements.pdf",
      "test/",
      "test/sample1.in",
      "test/sample1.ans",
      "A+B Problem/",
      "A+B Problem/sample1.in",
      "A+B Problem/sample1.ans",
      "A+B Problem/附件 说明.pdf",
      "最短路 (2)/"
    ]
  );
  // Every name is marked UTF-8 (general purpose bit 11), so Windows and macOS show 最短路 rather than mojibake
  for (const entry of entries) {
    assert.equal(entry.flags & 0x0800, 0x0800, entry.name);
    assert.equal(entry.method, 0, entry.name);
    assert.equal(entry.crc, zlib.crc32(entry.content), entry.name);
  }
  const content = Object.fromEntries(entries.map(entry => [entry.name, entry.content.toString("utf8")]));
  assert.equal(content["statements.pdf"], "%PDF-1.7 statements");
  assert.equal(content["test/sample1.in"], "1 2\n");
  assert.equal(content["A+B Problem/sample1.in"], "");
  assert.equal(content["A+B Problem/sample1.ans"], "求和\n");
  assert.equal(content["A+B Problem/附件 说明.pdf"], "%PDF-");
});

test("without attachments the ZIP is made in memory and saved as one file", async () => {
  const saved = [];
  const fetched = [];
  const withoutAttachments = { ...manifest(), attachments: 0 };
  withoutAttachments.folders = withoutAttachments.folders.map(folder => ({
    ...folder,
    files: folder.files.filter(file => !file.url)
  }));
  const { downloadContestArchive } = archiveModule(async () => withoutAttachments, fetched, saved);
  await downloadContestArchive(5, () => {});
  assert.deepEqual(fetched, []);
  assert.equal(saved[0].via, "blob");
  assert.equal(readZip(saved[0].bytes).length, 8);
});

test("a failed attachment download fails the archive instead of writing a damaged file", async () => {
  const saved = [];
  const module = load(
    "pages/contest/contestArchive.ts",
    {
      "@/appState": { appState: { locale: "en_US" } },
      "@/utils/zip": { createZipStream: zipWriter() },
      "@/utils/saveStream": {
        saveStream: async stream => saved.push(new Uint8Array(await new Response(stream).arrayBuffer()))
      },
      "@/utils/downloadFile": { saveBlob: async () => {} },
      "./api": { callContest: async () => manifest() }
    },
    { fetch: async () => new Response("expired", { status: 403, statusText: "Forbidden" }) }
  );
  await assert.rejects(module.downloadContestArchive(5, () => {}), /附件 说明\.pdf: 403 Forbidden/);
  assert.deepEqual(saved, []);
});
