import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("cgroup-events.cc", import.meta.url));

test("the cgroup waiter closes its poll descriptor on success and on a malformed event file", async t => {
  if (process.platform !== "linux") return t.skip("requires Linux procfs");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "llmoj-cgroup-events-"));
  try {
    const binary = path.join(temporary, "test");
    const probe = spawnSync("g++", ["-std=c++17", "-x", "c++", "-", "-lfmt", "-o", binary], {
      input: "#include <fmt/format.h>\nint main() {}\n",
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 30000
    });
    if (probe.error?.code === "ENOENT") return t.skip("requires g++");
    if (probe.error) throw probe.error;
    if (probe.status !== 0) {
      if (/fmt\/format\.h: No such file or directory|cannot find -lfmt/.test(probe.stderr))
        return t.skip("requires libfmt headers and library");
      throw new Error(`g++ prerequisite check failed: ${probe.stderr}`);
    }
    await execute("g++", ["-std=c++17", fixture, "-lfmt", "-o", binary], { timeout: 30000 });
    await execute(binary, [temporary], { timeout: 5000 });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
