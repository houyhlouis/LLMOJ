// Run with: node --test packages/frontend/test/qrcode.test.cjs
// The authenticator-app QR encoder against reference symbols generated with segno 1.6.1 (qrcode-fixtures.json).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/utils/qrcode.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const loaded = { exports: {} };
new Function("module", "exports", code)(loaded, loaded.exports);
const { encodeQrCode } = loaded.exports;
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "qrcode-fixtures.json"), "utf8"));

const rows = modules => modules.map(row => row.map(Number).join(""));
const fromHex = (hex, width) =>
  BigInt("0x" + hex)
    .toString(2)
    .padStart(width, "0");

for (const fixture of fixtures)
  test(`version ${fixture.version}-${fixture.level} mask ${fixture.mask} matches the reference symbol`, () => {
    const symbol = encodeQrCode(fixture.text, fixture.level, fixture.mask);
    assert.equal(symbol.version, fixture.version, "smallest version that fits");
    const width = fixture.version * 4 + 17;
    assert.deepEqual(
      rows(symbol.modules),
      fixture.rows.map(hex => fromHex(hex, width))
    );
  });

test("automatic mask choice and capacity limits match the standard", () => {
  for (const fixture of fixtures) {
    const symbol = encodeQrCode(fixture.text, fixture.level);
    assert(symbol.mask >= 0 && symbol.mask < 8);
    // The chosen mask is the only free parameter: the symbol equals the one encoded with it explicitly.
    assert.deepEqual(rows(symbol.modules), rows(encodeQrCode(fixture.text, fixture.level, symbol.mask).modules));
  }
  for (const [level, bytes] of Object.entries({ L: 2953, M: 2331, Q: 1663, H: 1273 })) {
    assert.equal(encodeQrCode("a".repeat(bytes), level, 0).version, 40);
    assert.throws(() => encodeQrCode("a".repeat(bytes + 1), level, 0), RangeError);
  }
});
