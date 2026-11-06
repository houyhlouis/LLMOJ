// Run: node --test apps/backend/src/statement-export/statement-export.test.cjs
// Statement downloads: safe and unique names, the statement and its Markdown, images and their address checks, the
// Markdown the PDF reads, the PDF itself (its text read back), the worker pool, and what a contest's archive holds.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const ts = require("typescript");
require("reflect-metadata");

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true
};
require.extensions[".ts"] = (module, filename) =>
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: COMPILER_OPTIONS }).outputText, filename);

const { safeFileName, UniqueNames } = require("./export-names.ts");
const { buildStatement, limitRange } = require("./statement.ts");
const { statementMarkdown, codeBlock } = require("./statement-markdown.ts");
const images = require("./pdf/images.ts");
const { markdownBlocks, cssColor } = require("./pdf/markdown.ts");
const { renderStatementsPdf } = require("./pdf/statement-pdf.ts");
const { StatementPdfService, PDF_LIMITS } = require("./statement-pdf.service.ts");
const { ContestStatementService, formatContestTime, problemLabel } = require("../contest/contest-statement.service.ts");

// ---------------------------------------------------------------------------------------------------------------
// A small PDF reader: inflates pdfkit's streams and reads its text through each font's ToUnicode map

function readPdf(buffer) {
  const text = buffer.toString("latin1");
  const objects = new Map();
  const pattern = /(\d+) 0 obj\s*/g;
  let match;
  while ((match = pattern.exec(text))) {
    const start = match.index + match[0].length;
    const end = text.indexOf("endobj", start);
    const body = text.slice(start, end);
    const object = { dictionary: body, stream: null };
    const streamAt = body.indexOf("stream");
    if (streamAt >= 0 && /\/Length (\d+)/.test(body.slice(0, streamAt))) {
      const length = Number(/\/Length (\d+)/.exec(body.slice(0, streamAt))[1]);
      let from = start + streamAt + "stream".length;
      if (text[from] === "\r") from++;
      if (text[from] === "\n") from++;
      let data = buffer.subarray(from, from + length);
      if (/\/Filter \/FlateDecode/.test(body.slice(0, streamAt))) data = zlib.inflateSync(data);
      object.dictionary = body.slice(0, streamAt);
      object.stream = data;
    }
    objects.set(Number(match[1]), object);
  }
  const ref = (dictionary, key) => Number(new RegExp(`/${key} (\\d+) 0 R`).exec(dictionary)?.[1]);
  const cmaps = new Map();
  const cmapOf = fontNumber => {
    if (cmaps.has(fontNumber)) return cmaps.get(fontNumber);
    const map = new Map();
    const stream = objects.get(ref(objects.get(fontNumber)?.dictionary ?? "", "ToUnicode"))?.stream?.toString("latin1") ?? "";
    const hex = value => String.fromCodePoint(...(value.match(/.{4}/g) ?? []).map(unit => parseInt(unit, 16)));
    const utf16 = value => {
      try {
        return Buffer.from(value, "hex").swap16().toString("utf16le");
      } catch (error) {
        throw new Error(`ToUnicode target <${value}>: ${error.message}`);
      }
    };
    for (const [, block] of stream.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
      for (const [, low, high, target] of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(\[[^\]]*\]|<[0-9a-f]+>)/gi)) {
        const from = parseInt(low, 16);
        const to = parseInt(high, 16);
        if (target.startsWith("[")) {
          // A ligature maps to several characters: "<0066 0069>"
          const values = [...target.matchAll(/<([0-9a-f\s]+)>/gi)].map(item => item[1].replace(/\s+/g, ""));
          for (let code = from; code <= to; code++) map.set(code, utf16(values[code - from]));
        } else {
          const base = parseInt(target.slice(1, -1), 16);
          for (let code = from; code <= to; code++) map.set(code, hex((base + code - from).toString(16).padStart(4, "0")));
        }
      }
    for (const [, block] of stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
      for (const [, code, target] of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) map.set(parseInt(code, 16), utf16(target));
    cmaps.set(fontNumber, map);
    return map;
  };
  const pages = [];
  // Pages in the page tree's order
  const tree = [...objects.values()].find(object => /\/Type \/Pages\b/.test(object.dictionary));
  const kids = [.../\/Kids \[([^\]]*)\]/.exec(tree?.dictionary ?? "")?.[1].matchAll(/(\d+) 0 R/g) ?? []].map(item => Number(item[1]));
  for (const number of kids) {
    const object = objects.get(number);
    const resources = objects.get(ref(object.dictionary, "Resources"))?.dictionary ?? object.dictionary;
    const fonts = new Map();
    const fontDictionary = /\/Font <<([\s\S]*?)>>/.exec(resources)?.[1] ?? "";
    for (const [, name, fontNumber] of fontDictionary.matchAll(/\/(\S+) (\d+) 0 R/g)) fonts.set(name, Number(fontNumber));
    const contents = objects.get(ref(object.dictionary, "Contents"))?.stream?.toString("latin1") ?? "";
    let font = null;
    let out = "";
    for (const [token] of contents.matchAll(/\/\S+ [\d.]+ Tf|\[[^\]]*\] TJ|<[0-9a-f]*> Tj|\bET\b/gi)) {
      if (token.endsWith("Tf")) font = cmapOf(fonts.get(/\/(\S+) /.exec(token)[1]));
      else if (token === "ET") out += "\n";
      else
        for (const [, hex] of token.matchAll(/<([0-9a-f]*)>/gi))
          for (const unit of hex.match(/.{4}/g) ?? []) out += font?.get(parseInt(unit, 16)) ?? "\ufffd";
    }
    pages.push(out);
  }
  return { objects, pages, text: pages.join("\n"), raw: text };
}
const squash = text => text.replace(/\s+/g, "");

// ---------------------------------------------------------------------------------------------------------------
// Names

test("folder and file names keep the problem's exact name; only unsafe characters change", () => {
  assert.equal(safeFileName("test", "x"), "test");
  assert.equal(safeFileName("A+B Problem", "x"), "A+B Problem");
  assert.equal(safeFileName("最短路 (Dijkstra) — 100% [hard] #1 & more", "x"), "最短路 (Dijkstra) — 100% [hard] #1 & more");
  assert.equal(safeFileName('a<b>c:d"e/f\\g|h?i*j', "x"), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(safeFileName("tab\there\u0000\u001f\u007f\u0085", "x"), "tab_here____");
  // Bidirectional controls can make "gpj.exe" show as "exe.jpg"
  assert.equal(safeFileName("evil\u202egpj.exe", "x"), "evil_gpj.exe");
  assert.equal(safeFileName("  ..hidden. . ", "x"), "hidden");
  assert.equal(safeFileName(" . ", "fallback"), "fallback");
  assert.equal(safeFileName("", ""), "_");
  assert.equal(safeFileName("CON", "x"), "CON_");
  assert.equal(safeFileName("con.txt", "x"), "con_.txt");
  assert.equal(safeFileName("LPT¹", "x"), "LPT¹_");
  assert.equal(safeFileName("Console", "x"), "Console");
  // NFC: the same name typed two ways is one name
  assert.equal(safeFileName("e\u0301", "x"), "\u00e9");
  // Cut at 180 UTF-8 bytes without splitting a character
  const long = safeFileName("题".repeat(100), "x");
  assert.equal(long, "题".repeat(60));
  assert.ok(Buffer.byteLength(long) <= 180);
  assert.equal(safeFileName("😀".repeat(50), "x"), "😀".repeat(45));
});

test("duplicate names are numbered, also when only their case differs, and nothing is overwritten", () => {
  const top = new UniqueNames();
  top.reserve("statements.pdf");
  const names = ["test", "A+B Problem", "Test", "TEST", "a/b", "a_b", "statements.pdf", "CON", "test (2)"].map(name =>
    top.take(name, "untitled")
  );
  assert.deepEqual(names, [
    "test",
    "A+B Problem",
    "Test (2)",
    "TEST (3)",
    "a_b",
    "a_b (2)",
    "statements.pdf (2)",
    "CON_",
    "test (2) (2)"
  ]);
  const inside = new UniqueNames();
  inside.reserve("sample1.in");
  inside.reserve("sample1.ans");
  assert.equal(inside.take("sample1.in", "attachment", { keepExtension: true }), "sample1 (2).in");
  assert.equal(inside.take("SAMPLE1.ANS", "attachment", { keepExtension: true }), "SAMPLE1 (2).ANS");
  assert.equal(inside.take(".bashrc", "attachment", { keepExtension: true }), "bashrc");
  assert.equal(inside.take("archive.tar.gz", "attachment", { keepExtension: true }), "archive.tar.gz");
  assert.equal(inside.take("archive.tar.gz", "attachment", { keepExtension: true }), "archive.tar (2).gz");
});

// ---------------------------------------------------------------------------------------------------------------
// The statement and its Markdown

const SECTIONS = [
  { sectionTitle: "Description", type: "Text", text: "Compute $a+b$.\n\n![x](https://example.com/x.png)" },
  { sectionTitle: "Empty", type: "Text", text: "   " },
  { sectionTitle: "Input", type: "Text", text: "Two integers." },
  { sectionTitle: "", type: "Sample", sampleId: 1, text: "Since 1 + 2 = 3." },
  { sectionTitle: "Hidden placeholder", type: "Sample", sampleId: 2, text: "" },
  { sectionTitle: "Second sample", type: "Sample", sampleId: 0, text: "" }
];
const SAMPLES = [
  { inputData: "5 6\n", outputData: "11\n" },
  { inputData: "1 2\n", outputData: "3\n" },
  { inputData: " ", outputData: "" }
];
const JUDGE_INFO = {
  timeLimit: 1000,
  memoryLimit: 256,
  fileIo: { inputFilename: "plus.in", outputFilename: "plus.out" },
  subtasks: [
    { timeLimit: 2000, testcases: [{ inputFile: "secret-1.in" }, { timeLimit: 500, inputFile: "secret-2.in" }] },
    { testcases: [{ memoryLimit: 512, inputFile: "secret-3.in" }] }
  ]
};

test("limits are ranges over test cases, like the problem page", () => {
  assert.equal(limitRange(JUDGE_INFO, "timeLimit"), "500 - 2000");
  assert.equal(limitRange(JUDGE_INFO, "memoryLimit"), "256 - 512");
  assert.equal(limitRange({ timeLimit: 1000, subtasks: [] }, "timeLimit"), "1000");
  assert.equal(limitRange({ subtasks: [{ testcases: [{}] }] }, "timeLimit"), null);
  assert.equal(limitRange(null, "timeLimit"), null);
});

test("the statement shows what the page shows: visible sections, samples in statement order, file I/O", () => {
  const statement = buildStatement({
    locale: "en_US",
    contentLocale: "en_US",
    label: "#1001",
    title: "  A+B Problem  ",
    type: "Traditional",
    judgeInfo: JUDGE_INFO,
    source: "https://example.com/original",
    sections: SECTIONS,
    samples: SAMPLES,
    files: ["readme.txt"]
  });
  assert.equal(statement.title, "A+B Problem");
  assert.deepEqual(
    statement.sections.map(section => section.title),
    ["Description", "Input", "Sample 1", "Second sample"]
  );
  assert.deepEqual(statement.samples, [
    { number: 1, input: "1 2\n", output: "3\n" },
    { number: 2, input: "5 6\n", output: "11\n" }
  ]);
  assert.deepEqual(statement.io, { kind: "file", input: "plus.in", output: "plus.out" });
  assert.equal(statement.timeLimit, "500 - 2000");
  // Nothing of the test data
  assert.doesNotMatch(JSON.stringify(statement), /secret/);
});

test("in a contest, the contest's own file I/O applies, never the problem's", () => {
  const base = { locale: "en_US", contentLocale: "en_US", label: "A", title: "t", type: "Traditional", judgeInfo: JUDGE_INFO, sections: [], samples: [] };
  assert.deepEqual(buildStatement({ ...base, contestFiles: { input: "", output: "" } }).io, { kind: "standard" });
  assert.deepEqual(buildStatement({ ...base, contestFiles: { input: "a.in", output: "a.out" } }).io, {
    kind: "file",
    input: "a.in",
    output: "a.out"
  });
  assert.deepEqual(buildStatement({ ...base, type: "Interaction" }).io, { kind: "interactive" });
  assert.deepEqual(buildStatement({ ...base, type: "Communication", judgeInfo: { grader: {} } }).io, { kind: "grader" });
  const answer = buildStatement({ ...base, type: "SubmitAnswer" });
  assert.deepEqual([answer.io, answer.timeLimit, answer.memoryLimit], [{ kind: "answer" }, null, null]);
  assert.equal(buildStatement({ ...base, title: " " }).title, "Untitled");
});

test("the Markdown keeps every section's text exactly and holds samples whatever they contain", () => {
  const statement = buildStatement({
    locale: "zh_CN",
    contentLocale: "zh_CN",
    label: "#1001",
    title: "A*B_[x]",
    type: "Traditional",
    judgeInfo: JUDGE_INFO,
    source: "NOI 2026",
    sections: [
      { sectionTitle: "题目描述", type: "Text", text: "$$\\sum_{i=1}^n a_i$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<b>粗体</b>  \n\n" },
      { sectionTitle: "", type: "Sample", sampleId: 0, text: "说明" }
    ],
    samples: [{ inputData: "```\n``` inside\n", outputData: "no newline" }],
    files: ["a`b.txt", "数据.zip"]
  });
  const markdown = statementMarkdown(statement);
  assert.match(markdown, /^# #1001\. A\\\*B\\_\\\[x\\\]\n/);
  assert.match(markdown, /- 时间限制：500 - 2000 ms\n- 内存限制：256 - 512 MiB\n/);
  assert.match(markdown, /- 输入输出：文件输入输出（输入文件：`plus\.in`，输出文件：`plus\.out`）\n/);
  assert.match(markdown, /- 来源：NOI 2026\n/);
  assert.ok(markdown.includes("$$\\sum_{i=1}^n a_i$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<b>粗体</b>\n"));
  assert.ok(markdown.includes("## 样例 1\n\n**输入**\n\n````\n```\n``` inside\n````\n\n**输出**\n\n```\nno newline\n```\n\n说明\n"));
  assert.ok(markdown.includes("## 附加文件\n\n- ``a`b.txt``\n- `数据.zip`\n"));
  assert.equal(codeBlock(""), "```\n```");
  assert.equal(
    statementMarkdown({ ...statement, source: "https://example.com/p?id=1", files: [] }).includes("<https://example.com/p?id=1>"),
    true
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Images

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
// A 2×2 GIF: red, green / blue, white (a 4-colour global palette, LZW minimum code size 2, a clear code every two
// pixels)
const GIF_2x2 = Buffer.from("R0lGODlhAgACAPEAAP8AAAD/AAAA/////ywAAAAAAgACAAACA0SoFQA7", "base64");

test("images are identified by their bytes: PNG and JPEG kept, GIF's first frame as PNG, SVG sized, WebP refused", () => {
  assert.deepEqual(images.parseDataUri("data:text/plain,a%20b").toString(), "a b");
  assert.deepEqual(images.parseDataUri(`data:image/png;base64,${PNG_1x1.toString("base64")}`), PNG_1x1);
  assert.equal(images.parseDataUri("http://x"), null);
  const png = images.identifyImage(PNG_1x1);
  assert.deepEqual([png.kind, png.width, png.height], ["png", 1, 1]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpegImage = images.identifyImage(jpeg);
  assert.deepEqual([jpegImage.kind, jpegImage.width, jpegImage.height], ["jpeg", 48, 32]);
  const gif = images.identifyImage(GIF_2x2);
  assert.deepEqual([gif.kind, gif.width, gif.height], ["png", 2, 2]);
  const decoded = images.identifyImage(gif.data);
  assert.equal(decoded.kind, "png");
  const svg = images.identifyImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20" width="80"></svg>'));
  assert.deepEqual([svg.kind, svg.width, svg.height], ["svg", 80, 40]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);
  assert.throws(() => images.identifyImage(webp), /WebP/);
  assert.throws(() => images.identifyImage(Buffer.from("plain text")), /format/);
});

test("the encoded PNG decodes to the GIF's colours", () => {
  const { data } = images.gifToPng(GIF_2x2);
  // Inflate the IDAT and read the four pixels back (filter byte 0 per row)
  const idat = [];
  for (let offset = 8; offset < data.length; ) {
    const length = data.readUInt32BE(offset);
    if (data.toString("latin1", offset + 4, offset + 8) === "IDAT") idat.push(data.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rows = [raw.subarray(1, 9), raw.subarray(10, 18)];
  assert.deepEqual([...rows[0]], [255, 0, 0, 255, 0, 255, 0, 255]);
  assert.deepEqual([...rows[1]], [0, 0, 255, 255, 255, 255, 255, 255]);
});

test("the server never fetches an image from this host or a private network", async () => {
  const deadline = Date.now() + 5000;
  for (const url of [
    "http://127.0.0.1/a.png",
    "http://localhost/a.png",
    "http://10.1.2.3/a.png",
    "http://192.168.0.1/a.png",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/a.png",
    "http://[fd00::1]/a.png",
    "http://[::ffff:127.0.0.1]/a.png",
    "http://0.0.0.0/a.png",
    "http://2130706433/a.png"
  ])
    await assert.rejects(images.downloadImage(url, deadline), /private network or this server/, url);
  await assert.rejects(images.downloadImage("ftp://example.com/a.png", deadline), /Only http and https/);
  await assert.rejects(images.downloadImage("http://user:pass@example.com/a.png", deadline), /Only http and https/);
});

test("the image loader: each address once, a few at a time, bounded in number and total size", async () => {
  let running = 0;
  let most = 0;
  const requests = [];
  const loader = new images.ImageLoader(async url => {
    requests.push(url);
    running++;
    most = Math.max(most, running);
    await new Promise(resolve => setTimeout(resolve, 5));
    running--;
    if (url.includes("big")) return Buffer.alloc(images.IMAGE_LIMITS.totalBytes);
    return PNG_1x1;
  });
  const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index % 7}.png`);
  const results = await Promise.all(urls.map(url => loader.load(url)));
  assert.equal(requests.length, 7);
  assert.ok(most <= images.IMAGE_LIMITS.concurrency, `${most} at a time`);
  assert.ok(results.every(result => result.kind === "png"));
  assert.match((await loader.load("https://example.com/big.png")).error, /too large together/);
  assert.match((await loader.load("/files/relative.png")).error, /full http\(s\) address/);
  assert.match((await loader.load("file:///etc/passwd")).error, /full http\(s\) address/);
  assert.match((await loader.load("data:image/png;base64,@@@")).error, /format/);
  const many = new images.ImageLoader(async () => PNG_1x1);
  for (let index = 0; index < images.IMAGE_LIMITS.images; index++) await many.load(`https://example.com/${index}`);
  assert.match((await many.load("https://example.com/one-more")).error, /too many images/);
});

// ---------------------------------------------------------------------------------------------------------------
// The Markdown the PDF reads

test("statement Markdown becomes blocks the way the page reads it, sanitized the same way", () => {
  const blocks = markdownBlocks(
    [
      "Text with $x^2$ and **bold** <span style=\"color: red\">red</span>.",
      "",
      "$$\\frac{a}{b}$$",
      "",
      "| a | b |",
      "|:-:|--:|",
      "| 1 | 2 |",
      "",
      "- [x] done",
      "- [ ] open",
      "",
      "```cpp",
      "int main() {}",
      "```",
      "",
      "<script>alert(1)</script><img src=x onerror=alert(1)><img src=\"data:image/png;base64,AAAA\">",
      "",
      "<a href=\"javascript:alert(1)\">bad</a> <a href=\"https://example.com\">good</a>"
    ].join("\n")
  );
  const kinds = blocks.map(block => block.kind);
  assert.deepEqual(kinds.slice(0, 5), ["paragraph", "math", "table", "list", "code"]);
  const inlines = blocks[0].inlines;
  assert.ok(inlines.some(inline => inline.kind === "math" && inline.tex === "x^2"));
  assert.ok(inlines.some(inline => inline.kind === "text" && inline.text === "bold" && inline.style.bold));
  assert.ok(inlines.some(inline => inline.kind === "text" && inline.text === "red" && inline.style.color === "#db2828"));
  assert.equal(blocks[1].tex.trim(), "\\frac{a}{b}");
  assert.deepEqual(blocks[2].rows[0].map(cell => [cell.header, cell.align]), [[true, "center"], [true, "right"]]);
  assert.deepEqual(blocks[3].items.map(item => item.task), [{ checked: true }, { checked: false }]);
  assert.equal(blocks[4].text, "int main() {}");
  const json = JSON.stringify(blocks);
  // As on the page: the script's tags go and its text stays text; event handlers and javascript: links go
  assert.doesNotMatch(json, /<script|onerror|javascript:/);
  assert.ok(blocks[5].inlines.some(inline => inline.kind === "text" && inline.text === "alert(1)"));
  assert.match(json, /data:image\/png;base64,AAAA/);
  assert.match(json, /"link":"https:\/\/example.com"/);
  assert.equal(cssColor("#abc"), "#aabbcc");
  assert.equal(cssColor("rgb(255, 0, 16)"), "#ff0010");
  assert.equal(cssColor("url(javascript:x)"), undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// The PDF

function sampleBook(extra = {}) {
  const english = buildStatement({
    locale: "zh_CN",
    contentLocale: "en_US",
    label: "A",
    title: "test",
    type: "Traditional",
    judgeInfo: { timeLimit: 1000, memoryLimit: 256 },
    contestFiles: { input: "test.in", output: "test.out" },
    sections: [
      {
        sectionTitle: "Description",
        type: "Text",
        text: "Print the sum $\\sum_{i=1}^n a_i$ of the numbers.\n\n$$\\int_0^1 x\\,dx = \\frac12$$\n\nBroken: $\\frac{$ end.\n\n![private](http://127.0.0.1/secret.png)"
      },
      { sectionTitle: "", type: "Sample", sampleId: 0, text: "Explanation of the sample." }
    ],
    samples: [{ inputData: "3\r\n1\t2 3\r\n", outputData: "6\n" }]
  });
  const chinese = buildStatement({
    locale: "zh_CN",
    contentLocale: "zh_CN",
    label: "B",
    title: "A+B Problem",
    type: "Interaction",
    judgeInfo: { timeLimit: 2000, memoryLimit: 512 },
    contestFiles: { input: "", output: "" },
    sections: [
      { sectionTitle: "题目描述", type: "Text", text: "给定两个整数，输出它们的和。“引号”与……省略号。\n\n| 子任务 | 分值 |\n|---|---|\n| 1 | 30 |\n| 2 | 70 |" }
    ],
    samples: []
  });
  return {
    locale: "zh_CN",
    title: "Contest 2026",
    subtitle: "Round 1",
    details: ["时间：2026-11-06 14:00 — 2026-11-06 19:00 (UTC+08:00)", "赛制：IOI"],
    description: "Good luck.",
    problems: [
      { statement: english, sampleFiles: [{ input: "sample1.in", output: "sample1.ans" }] },
      { statement: chinese, sampleFiles: [] }
    ],
    ...extra
  };
}

test("the PDF holds every statement in order, readable as text, with its fonts embedded", async () => {
  const loader = new images.ImageLoader(async () => {
    throw new Error("no network in this test");
  });
  const result = await renderStatementsPdf(sampleBook(), loader);
  assert.equal(result.pdf.subarray(0, 5).toString(), "%PDF-");
  const pdf = readPdf(result.pdf);
  assert.equal(pdf.pages.length, result.pages);
  assert.ok(result.pages >= 3, `${result.pages} pages`);
  // The cover page, then each problem from a new page, in contest order
  const cover = squash(pdf.pages[0]);
  for (const text of ["Contest2026", "Round1", "赛制：IOI", "test", "A+BProblem"]) assert.ok(cover.includes(text), text);
  const english = pdf.pages.findIndex(page => squash(page).includes("Printthesum"));
  const chinese = pdf.pages.findIndex(page => squash(page).includes("给定两个整数，输出它们的和。"));
  assert.ok(english > 0 && chinese > english, `${english} ${chinese}`);
  const all = squash(pdf.text);
  for (const text of ["A.test", "B.A+BProblem", "sample1.in", "sample1.ans", "123", "Explanationofthesample.", "test.in", "test.out", "“引号”与……省略号。", "子任务", "70"])
    assert.ok(all.includes(squash(text)), text);
  // Windows line ends are line breaks and a tab stops at the next 4th column: no stray control character is drawn
  assert.ok(pdf.text.includes("1   2 3"), "tab expanded");
  assert.doesNotMatch(pdf.text, /[\r\t]/);
  // Page numbers in the viewer's language
  assert.ok(all.includes(`第1/${result.pages}页`));
  // A formula that doesn't typeset is shown as its source, and the private image as a note
  assert.ok(all.includes("\\frac{"), "broken formula shown as TeX");
  assert.ok(all.includes("图片未能包含"), "image note");
  assert.deepEqual(
    result.warnings.map(warning => warning.kind).sort(),
    ["formula", "image"]
  );
  // Every font is embedded as a subset; the outline names each problem
  const fonts = [...pdf.raw.matchAll(/\/BaseFont \/([A-Z]{6}\+[^\s/]+)/g)].map(item => item[1]);
  assert.ok(fonts.some(font => /NotoSansSC/.test(font)) && fonts.some(font => /NotoSans-/.test(font)), fonts.join());
  assert.ok(fonts.some(font => /SourceCodePro/.test(font)), fonts.join());
  assert.match(pdf.raw, /\/FontFile2/);
  assert.equal([...pdf.raw.matchAll(/\/Title /g)].length >= 2, true);
});

test("an English PDF uses English labels", async () => {
  const book = sampleBook({ locale: "en_US", details: [] });
  book.problems = book.problems.map(problem => ({ ...problem, statement: { ...problem.statement, locale: "en_US" } }));
  const result = await renderStatementsPdf(book, new images.ImageLoader(async () => PNG_1x1));
  const all = squash(readPdf(result.pdf).text);
  assert.ok(all.includes(`Page1/${result.pages}`));
  assert.ok(all.includes("Timelimit"));
});

// ---------------------------------------------------------------------------------------------------------------
// The worker pool

function workerHook() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "statement-pdf-")), "hook.cjs");
  fs.writeFileSync(
    file,
    `const fs = require("fs"); const ts = require(${JSON.stringify(require.resolve("typescript"))});
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"),
  { compilerOptions: ${JSON.stringify(COMPILER_OPTIONS)} }).outputText, filename);`
  );
  return file;
}

function smallBook(title) {
  const statement = buildStatement({
    locale: "en_US",
    contentLocale: "en_US",
    label: "A",
    title,
    type: "Traditional",
    judgeInfo: { timeLimit: 1000, memoryLimit: 256 },
    sections: [{ sectionTitle: "Description", type: "Text", text: "Sum $a+b$." }],
    samples: []
  });
  return { locale: "en_US", title, details: [], problems: [{ statement, sampleFiles: [] }] };
}

test("the PDF worker: equal books share one rendering and a cached result; the queue and the time are bounded", async () => {
  StatementPdfService.workerPreload = workerHook();
  const limits = { ...PDF_LIMITS };
  const service = new StatementPdfService();
  try {
    const [first, second] = await Promise.all([service.render(smallBook("One")), service.render(smallBook("One"))]);
    assert.equal(first, second);
    assert.equal(first.pdf.subarray(0, 5).toString(), "%PDF-");
    assert.equal(await service.render(smallBook("One")), first);
    assert.ok(squash(readPdf(first.pdf).text).includes("A.One"));

    // One running and one waiting; a third different book is refused as busy
    PDF_LIMITS.queue = 1;
    const running = service.render(smallBook("Two"));
    const waiting = service.render(smallBook("Three"));
    await assert.rejects(service.render(smallBook("Four")), error => error.getResponse().error === "STATEMENTS_BUSY" && error.getStatus() === 503);
    await Promise.all([running, waiting]);
    PDF_LIMITS.queue = limits.queue;

    // A rendering that takes too long fails and its worker is replaced
    PDF_LIMITS.timeout = 1;
    await assert.rejects(service.render(smallBook("Five")), error => error.getResponse().error === "STATEMENTS_TIMEOUT");
    PDF_LIMITS.timeout = limits.timeout;
    const after = await service.render(smallBook("Six"));
    assert.equal(after.pdf.subarray(0, 5).toString(), "%PDF-");
  } finally {
    Object.assign(PDF_LIMITS, limits);
    await service.onModuleDestroy();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The contest archive

function contestFixture({ canDownload = true, manager = false, access } = {}) {
  const service = Object.create(ContestStatementService.prototype);
  const contest = {
    id: 5,
    title: "Spring: Round 1?",
    subtitle: "",
    description: "Rules here.",
    rule: "ioi",
    startTime: new Date("2026-11-06T06:00:00Z"),
    endTime: new Date("2026-11-06T11:00:00Z")
  };
  const problems = {
    1: { id: 1, type: "Traditional", locales: ["en_US"], title: "test" },
    2: { id: 2, type: "Traditional", locales: ["zh_CN", "en_US"], title: "A+B Problem" },
    3: { id: 3, type: "Traditional", locales: ["en_US"], title: "Test" },
    4: { id: 4, type: "Traditional", locales: ["en_US"], title: "x/y" }
  };
  const row = (id, position, extra = {}) => ({
    id: 100 + id,
    contestId: 5,
    problemId: id,
    position,
    title: "",
    inputFilename: "",
    outputFilename: "",
    attachments: [],
    problem: Promise.resolve(problems[id]),
    ...extra
  });
  const rows = [
    row(2, 1, { attachments: [{ filename: "sample1.in", uuid: "u-att", size: 3 }] }),
    row(1, 0, { inputFilename: "test.in", outputFilename: "test.out" }),
    row(3, 2),
    row(4, 3, { title: "Renamed: in contest" })
  ].sort((a, b) => a.position - b.position);
  const calls = { get: [], books: [], signed: [] };
  service.db = { getRepository: () => ({ find: async () => rows }) };
  service.access = {
    get: async (...args) => {
      calls.get.push(args);
      if (access) await access();
      return { contest, manager };
    },
    canDownloadAttachments: async () => canDownload
  };
  service.contestProblems = {
    visibleAttachments: async (_user, _manager, contestRow) => contestRow.attachments
  };
  service.problems = {
    getProblemJudgeInfo: async () => [{ timeLimit: 1000, memoryLimit: 256, subtasks: [{ testcases: [{ inputFile: "hidden-1.in", outputFile: "hidden-1.out" }] }], checker: { type: "custom", filename: "checker.cpp" } }],
    getProblemPreprocessedJudgeInfo: async () => [{ timeLimit: 1000, memoryLimit: 256, subtasks: [{ testcases: [{ inputFile: "hidden-1.in", outputFile: "hidden-1.out" }] }], checker: { type: "custom", filename: "checker.cpp" } }],
    getProblemLocalizedTitle: async (problem, locale) => `${problem.title}${locale === "zh_CN" ? "" : ""}`,
    getProblemLocalizedContent: async () => [
      { sectionTitle: "Description", type: "Text", text: "Read the input." },
      { sectionTitle: "", type: "Sample", sampleId: 0, text: "" }
    ],
    getProblemSamples: async () => [{ inputData: "1 2\n", outputData: "3\n" }]
  };
  service.files = {
    signDownloadLink: async ({ uuid, downloadFilename }) => {
      calls.signed.push(uuid);
      return `https://files.example.com/${uuid}?name=${encodeURIComponent(downloadFilename)}`;
    }
  };
  service.pdf = {
    render: async book => {
      calls.books.push(book);
      return { pdf: Buffer.from("%PDF-1.7 test"), pages: 3, warnings: [] };
    }
  };
  return { service, calls };
}

test("the archive: folders named exactly as the problems, in contest order, numbered only when names collide", async () => {
  const { service, calls } = contestFixture();
  const user = { id: 9 };
  const archive = await service.archive(user, 5, "en_US", "Asia/Shanghai");
  assert.deepEqual(calls.get, [[user, 5, true]]);
  assert.equal(archive.filename, "Spring_ Round 1_.zip");
  assert.deepEqual(
    archive.folders.map(folder => [folder.label, folder.name]),
    [
      ["A", "test"],
      ["B", "A+B Problem"],
      ["C", "Test (2)"],
      ["D", "Renamed_ in contest"]
    ]
  );
  assert.deepEqual(archive.folders[0].files, [
    { name: "sample1.in", text: "1 2\n" },
    { name: "sample1.ans", text: "3\n" }
  ]);
  // An attachment can't replace a sample
  assert.deepEqual(archive.folders[1].files.map(file => file.name), ["sample1.in", "sample1.ans", "sample1 (2).in"]);
  assert.equal(archive.folders[1].files[2].url, "https://files.example.com/u-att?name=sample1.in");
  assert.equal(archive.attachments, 1);
  assert.equal(archive.attachmentsWithheld, false);
  assert.equal(Buffer.from(archive.pdf, "base64").toString(), "%PDF-1.7 test");
  // The PDF's book: contest times in the viewer's zone, the contest's file I/O, no judge-only data
  const [book] = calls.books;
  assert.deepEqual(book.details, ["Time: 2026-11-06 14:00 — 2026-11-06 19:00 (UTC+08:00)", "Rules: IOI"]);
  assert.deepEqual(book.problems[0].statement.io, { kind: "file", input: "test.in", output: "test.out" });
  assert.deepEqual(book.problems[1].statement.io, { kind: "standard" });
  assert.deepEqual(book.problems[0].sampleFiles, [{ input: "sample1.in", output: "sample1.ans" }]);
  const everything = JSON.stringify({ archive, book });
  assert.doesNotMatch(everything, /hidden-1|checker\.cpp/);
});

test("without the privilege to download attachments, the archive has none and says some were left out", async () => {
  const { service, calls } = contestFixture({ canDownload: false });
  const archive = await service.archive({ id: 9 }, 5, "zh_CN", "UTC");
  assert.equal(archive.attachments, 0);
  assert.equal(archive.attachmentsWithheld, true);
  assert.deepEqual(calls.signed, []);
  assert.doesNotMatch(JSON.stringify(archive.folders), /u-att|https:/);
  assert.deepEqual(calls.books[0].details, ["时间：2026-11-06 06:00 — 2026-11-06 11:00 (UTC+00:00)", "赛制：IOI"]);
});

test("the archive and the Markdown refuse whatever the contest's pages refuse", async () => {
  const notStarted = Object.assign(new Error("CONTEST_NOT_STARTED"), { status: 403 });
  const { service, calls } = contestFixture({ access: async () => Promise.reject(notStarted) });
  await assert.rejects(service.archive({ id: 9 }, 5, "en_US", "UTC"), notStarted);
  await assert.rejects(service.markdown({ id: 9 }, 5, 101, "en_US"), notStarted);
  assert.deepEqual(calls.books, []);
  const open = contestFixture().service;
  await assert.rejects(open.markdown({ id: 9 }, 5, 999, "en_US"), /Not Found/);
  const { filename, markdown } = await open.markdown({ id: 9 }, 5, 102, "en_US");
  assert.equal(filename, "A+B Problem.md");
  assert.match(markdown, /^# B\. A\+B Problem\n/);
  assert.match(markdown, /## Files\n\n- `sample1\.in`\n/);
  const hidden = contestFixture({ canDownload: false }).service;
  assert.doesNotMatch((await hidden.markdown({ id: 9 }, 5, 102, "en_US")).markdown, /## Files/);
});

test("contest labels and times", () => {
  assert.deepEqual([0, 1, 25, 26].map(problemLabel), ["A", "B", "Z", "27"]);
  assert.deepEqual(formatContestTime(new Date("2026-01-01T00:30:00Z"), "America/St_Johns"), {
    time: "2025-12-31 21:00",
    offset: "UTC-03:30"
  });
  assert.deepEqual(formatContestTime(new Date("2026-01-01T00:30:00Z"), "Not/AZone"), {
    time: "2026-01-01 00:30",
    offset: "UTC+00:00"
  });
});
