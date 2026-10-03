import { test } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
test("closing stdio delivers pipe EOF before process exit while extra FDs survive", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "libreoj-redirect-"));
  try {
    const binary = path.join(temporary, "test");
    await execute("g++", ["-std=c++17", path.join(packageRoot, "test/io-redirection.cc"),
      path.join(packageRoot, "native/utils.cc"), "-lfmt", "-o", binary], { timeout: 30000 });
    await execute(binary, [], { timeout: 5000 });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
