// Checks the sandbox and every language on this host through the judge's own code: see src/selfTest.ts.
// Run as root with -r @swc-node/register, in a systemd unit with delegated cgroups (deploy/sandbox/self-test.sh).
// Like the judge, it runs as the account libreoj-judge under the sandbox launcher (src/launcher/main.ts). It uses a
// copy of the judge's configuration with its own directories and without the key, so it can run beside a running
// judge, and never connects to the server.
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
const only = option("--only");
if (!configFile) {
  console.error("Usage: self-test.mjs --config /opt/LLMOJ/config/judge.yaml [--only cpp,java,...]");
  process.exit(2);
}

const original = yaml.load(fs.readFileSync(configFile, "utf-8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-judge-self-test-"));
// The judge's account passes through to its directories, which the launcher gives it
fs.chmodSync(root, 0o711);
const derived = require("./src/selfTestConfig").deriveSelfTestConfig(original, root);
// Only errors from the judge's own logging: e.g. its directories aren't tmpfs mount points, which doesn't matter here
process.env.LIBREOJ_JUDGE_LOG_LEVEL ||= "error";

let code = 1;
try {
  const { runLauncher } = require("./src/launcher/main");
  code = await runLauncher({
    configText: yaml.dump(derived),
    worker: "./src/selfTestWorker",
    args: only ? [only] : [],
    restart: false
  });
} catch (error) {
  console.error(error);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(code);
