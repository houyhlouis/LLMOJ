// The CSV files people download (contest scoreboards, team assignment results) share one writer (review section 4.3):
// text that a spreadsheet could take for a formula, also after spaces or control characters, is written as text.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const filename = path.join(__dirname, "csv.ts");
const loaded = { exports: {} };
new Function(
  "module",
  "exports",
  ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
)(loaded, loaded.exports);
const { csvCell, csvDocument } = loaded.exports;

test("text that could start a formula gets an apostrophe, also after spaces and control characters", () => {
  for (const [value, expected] of [
    ["=1+1", `"'=1+1"`],
    ["+1", `"'+1"`],
    ["-1", `"'-1"`],
    ["@SUM(A1)", `"'@SUM(A1)"`],
    ["\t=1+1", `"'\t=1+1"`],
    ["\r=1+1", `"'\r=1+1"`],
    [" \t=cmd|' /C calc'!A0", `"' \t=cmd|' /C calc'!A0"`],
    ["\u0000=1", `"'\u0000=1"`],
    ["\u3000=1", `"'\u3000=1"`],
    ["\uff1d1+1", `"'\uff1d1+1"`],
    ["\uff0b1", `"'\uff0b1"`]
  ])
    assert.equal(csvCell(value), expected, JSON.stringify(value));
});

test("other text is quoted as it is, with quotes doubled", () => {
  assert.equal(csvCell("alice"), `"alice"`);
  assert.equal(csvCell("a=b"), `"a=b"`);
  assert.equal(csvCell('say "hi", then go'), `"say ""hi"", then go"`);
  assert.equal(csvCell("two\nlines"), `"two\nlines"`);
  assert.equal(csvCell("题目1"), `"题目1"`);
  assert.equal(csvCell(""), `""`);
  assert.equal(csvCell(null), `""`);
  assert.equal(csvCell(undefined), `""`);
});

test("numbers the site computes are written as numbers, negative ones too", () => {
  assert.equal(csvCell(100), "100");
  assert.equal(csvCell(-3), "-3");
  assert.equal(csvCell(37.5), "37.5");
  assert.equal(csvCell(NaN), "");
  assert.equal(csvCell(Infinity), "");
});

test("a document is UTF-8 with a byte order mark and CRLF line endings", () => {
  const csv = csvDocument([
    ["User", "Score"],
    ["=evil", 5]
  ]);
  assert.equal(csv, `\ufeff"User","Score"\r\n"'=evil",5`);
});
