import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const program = new URL("../../build/Release/builtin_checker", import.meta.url).pathname;

const workingDirectory = await mkdtemp(join(tmpdir(), "libreoj-builtin-checker-"));

// The judge passes the output and the answer as descriptors 3 and 4 and reads testlib's message from standard error
function check(output, answer, ...args) {
  const files = [openSync(output, "r"), openSync(answer, "r")];
  try {
    return spawnSync(program, args, { stdio: ["ignore", "ignore", "pipe", ...files], encoding: "utf8" });
  } finally {
    files.forEach(closeSync);
  }
}

try {
  const outputFile = join(workingDirectory, "output.txt");
  const answerFile = join(workingDirectory, "answer.txt");
  await Promise.all([writeFile(outputFile, "1 2 3\n"), writeFile(answerFile, "1 2 3\n")]);

  const accepted = check(outputFile, answerFile, "integers");
  assert.equal(accepted.stderr, 'ok 3 number(s): "1 2 3"\n');
  assert.equal(accepted.status, 0);

  await writeFile(outputFile, "1 2 4\n");
  const wrong = check(outputFile, answerFile, "integers");
  assert.equal(wrong.stderr, "wrong answer 3rd number differ - expected: '3', found: '4'\n");
  assert.equal(wrong.status, 1);

  // Arguments the judge never passes are refused with a status that isn't a verdict
  const invalid = check(outputFile, answerFile, "floats", "six");
  assert.equal(invalid.status, 64);
  assert.match(invalid.stderr, /^Invalid built-in checker arguments/);
} finally {
  await rm(workingDirectory, { recursive: true });
}

// Then the comparison cases of the token checker
await import("./tokens.test.mjs");
