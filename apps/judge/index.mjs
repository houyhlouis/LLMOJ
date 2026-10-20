// The judge service's entry: its sandbox launcher, the only part of the judge that runs as root
// (src/launcher/main.ts). It starts the judge itself (src/index.ts) as the account libreoj-judge, runs sandboxes for
// it, and starts it again when it lost its connection to the site (exit code 100).
import { createRequire } from "module";

const require = createRequire(import.meta.url);

if (!process.env.LIBREOJ_JUDGE_CONFIG_FILE) {
  console.error("Please specify configuration file with environment variable LIBREOJ_JUDGE_CONFIG_FILE");
  process.exit(1);
}

try {
  const { runLauncher } = require("./src/launcher/main");
  process.exit(
    await runLauncher({ configFile: process.env.LIBREOJ_JUDGE_CONFIG_FILE, worker: "./src/index", restart: true })
  );
} catch (error) {
  console.error(error);
  process.exit(1);
}
