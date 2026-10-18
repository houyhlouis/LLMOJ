import fs from "fs";
import path from "path";
import crypto from "crypto";

import { JudgeRuntimeInfo } from "@libreoj/judge-protocol";

import config from "./config";
import getSystemInfo from "./systemInfo";

const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");

// The judge program: the source files it runs, relative to the repository root. Its compilers and interpreters are
// identified by the sandbox image instead.
export const JUDGE_PROGRAM_SOURCES = [
  "apps/judge/index.mjs",
  "apps/judge/src",
  "apps/judge/native",
  "apps/judge/vendor/testlib/testlib.h",
  "packages/judge-protocol/src",
  "packages/simple-sandbox/src",
  "packages/simple-sandbox/native"
];

// Tests don't change what the judge does
const isTest = (name: string) => /\.test\.[cm]?[jt]s$/.test(name) || name === "smoke-test.mjs";

function listFiles(root: string, relative: string, result: string[]): void {
  const absolute = path.join(root, relative);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    // Missing: the digest differs from that of a judge that has it
    return;
  }
  if (stat.isFile()) {
    if (!isTest(path.basename(relative))) result.push(relative);
  } else if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) listFiles(root, path.posix.join(relative, name), result);
  }
}

const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

/**
 * SHA-256 over the judge program's source files (each one's path and content), so judges installed from the same
 * source have the same digest.
 */
export function judgeProgramDigest(root = REPOSITORY_ROOT): string {
  const files: string[] = [];
  for (const source of JUDGE_PROGRAM_SOURCES) listFiles(root, source, files);
  const lines = files.sort().map(file => `${file}\0${sha256(fs.readFileSync(path.join(root, file)))}\n`);
  return sha256(lines.join(""));
}

let cachedResult: Promise<JudgeRuntimeInfo>;

/** What this judge judges with, announced to the server and recorded with each result. */
export default function getRuntimeInfo(): Promise<JudgeRuntimeInfo> {
  cachedResult ||= (async () => {
    const systemInfo = await getSystemInfo();
    return {
      judgeProgram: judgeProgramDigest(),
      sandboxImage: config.sandbox.rootfsId,
      node: process.version,
      os: systemInfo.os,
      kernel: systemInfo.kernel,
      arch: systemInfo.arch,
      cpu: systemInfo.cpu.model
    };
  })();
  return cachedResult;
}
