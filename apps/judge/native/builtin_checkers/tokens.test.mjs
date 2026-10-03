import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const require = createRequire(import.meta.url),
  native = require(process.env.HYHOJ_TEST_CHECKER_BINARY || "../../build/Release/builtin_checkers.node"),
  run = promisify(native.runBuiltinChecker),
  dir = await fs.mkdtemp(path.join(tmpdir(), "hyhoj-tokens-"));
const cases = [
  ["missing terminal newline", "1 2", "1 2\n", true, true],
  ["trailing spaces", "1 2   \n\n", "1 2\n", true, true],
  ["multiple separators", " \t1   2\r\n", "1 2\n", true, true],
  ["wrapped lines", "1\n2\n", "1 2", true, true],
  ["leading blank lines", "\n\n1\t2\n", "1 2", true, true],
  ["empty output", "\n\t  ", "", true, true],
  ["case folded", "yEs\tNO", "YES no", false, true],
  ["case sensitive", "yes", "YES", true, false],
  ["wrong value", "1 3", "1 2", true, false],
  ["missing token", "1", "1 2", true, false],
  ["extra token", "1 2 3", "1 2", true, false],
  ["token order", "2 1", "1 2", true, false],
  ["numeric text kept exact", "01", "1", true, false],
  ["no implicit float epsilon", "1.000001", "1.000000", true, false],
  ["unicode exact", "答案 你好", "答案\n你好", true, true]
];
try {
  for (const [name, actual, expected, caseSensitive, accept] of cases) {
    await fs.writeFile(dir + "/actual", actual);
    await fs.writeFile(dir + "/expected", expected);
    const result = await run(dir + "/actual", dir + "/expected", { type: "tokens", caseSensitive });
    assert.equal(result.startsWith("ok"), accept, name + ": " + result);
  }
  await fs.writeFile(dir + "/actual", "1\n2\n");
  await fs.writeFile(dir + "/expected", "1 2\n");
  assert(
    (await run(dir + "/actual", dir + "/expected", { type: "lines", caseSensitive: true })).startsWith("wrong answer"),
    "Existing lines format must remain strict"
  );
  await fs.writeFile(dir + "/actual", "1.0000001\n");
  await fs.writeFile(dir + "/expected", "1.0");
  assert(
    (await run(dir + "/actual", dir + "/expected", { type: "floats", precision: 6 })).startsWith("ok"),
    "Explicit float tolerance"
  );
  await fs.writeFile(dir + "/actual", "1.01");
  assert(
    (await run(dir + "/actual", dir + "/expected", { type: "floats", precision: 6 })).startsWith("wrong answer"),
    "Float outside tolerance"
  );
  console.log(
    JSON.stringify({
      passed: true,
      cases: cases.length + 3,
      comparison: "tokens/lines/floats",
      unchangedLegacyLines: true
    })
  );
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
