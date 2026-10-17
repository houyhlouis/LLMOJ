// The committed typed client (src/api-generated) must describe the backend's current controllers and DTOs, so a
// changed endpoint or error code can't silently disagree with the pages using it. After changing the backend API,
// build it (`pnpm --filter @libreoj/backend build`) and run `node packages/frontend/scripts/generate-api.js --from-backend-build`.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const committed = path.join(__dirname, "../src/api-generated");
const built = fs.existsSync(path.join(__dirname, "../../../apps/backend/dist/app.module.js"));

function files(directory, prefix = "") {
  return fs
    .readdirSync(path.join(directory, prefix), { withFileTypes: true })
    .flatMap(entry =>
      entry.isDirectory() ? files(directory, path.join(prefix, entry.name)) : [path.join(prefix, entry.name)]
    )
    .sort();
}

test(
  "the generated API client matches the compiled backend",
  { skip: !built && "needs the compiled backend (pnpm build)", timeout: 180000 },
  () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-api-client-"));
    try {
      execFileSync(
        process.execPath,
        [path.join(__dirname, "../scripts/generate-api.js"), "--from-backend-build", "--out", output],
        { stdio: "pipe" }
      );
      assert.deepEqual(files(output), files(committed), "generated files differ: regenerate the client");
      for (const file of files(committed))
        assert.equal(
          fs.readFileSync(path.join(output, file), "utf8"),
          fs.readFileSync(path.join(committed, file), "utf8"),
          `src/api-generated/${file} is out of date: regenerate the client`
        );
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  }
);
