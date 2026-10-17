// Checks the sandbox and every language on this host through the judge's own code: see src/selfTest.ts.
// Run as root with -r @swc-node/register, in a systemd unit with delegated cgroups (deploy/sandbox/self-test.sh).
// It uses a copy of the judge's configuration with its own directories and without the key, so it can run beside
// a running judge, and never connects to the server.
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const configFile = option("--config") || process.env.LIBREOJ_JUDGE_CONFIG_FILE;
const only = option("--only")?.split(",");
if (!configFile) {
  console.error("Usage: self-test.mjs --config /opt/LLMOJ/config/judge.yaml [--only cpp,java,...]");
  process.exit(2);
}

const original = yaml.load(fs.readFileSync(configFile, "utf-8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-judge-self-test-"));
const derived = require("./src/selfTestConfig").deriveSelfTestConfig(original, root);
for (const directory of [derived.dataStore, derived.binaryCacheStore, ...derived.taskWorkingDirectories])
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
const derivedFile = path.join(root, "judge.yaml");
fs.writeFileSync(derivedFile, yaml.dump(derived), { mode: 0o600 });
process.env.LIBREOJ_JUDGE_CONFIG_FILE = derivedFile;
// Only errors from the judge's own logging: e.g. its directories aren't tmpfs mount points, which doesn't matter here
process.env.LIBREOJ_JUDGE_LOG_LEVEL ||= "error";

let passed = false;
try {
  passed = await require("./src/selfTest").runSelfTest(only);
} catch (error) {
  console.error(error);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(passed ? 0 : 1);
