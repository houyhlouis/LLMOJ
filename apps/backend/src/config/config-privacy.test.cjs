const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const root = path.resolve(__dirname, "../../../..");
const backend = createRequire(path.join(root, "apps/backend/package.json"));
const judge = createRequire(path.join(root, "apps/judge/package.json"));
backend("reflect-metadata");
process.env.SWC_NODE_PROJECT = path.join(root, "apps/backend/tsconfig.json");
judge("@swc-node/register");
const yaml = backend("js-yaml");
const { ConfigService } = require("./config.service.ts");

function withPrivateConfig(content, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "libreoj-config-privacy-"));
  const previous = process.env.LIBREOJ_CONFIG_FILE;
  try {
    const file = path.join(directory, "backend.yaml");
    fs.writeFileSync(file, content, { mode: 0o600 });
    process.env.LIBREOJ_CONFIG_FILE = file;
    run();
  } finally {
    if (previous === undefined) delete process.env.LIBREOJ_CONFIG_FILE;
    else process.env.LIBREOJ_CONFIG_FILE = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("malformed private YAML cannot appear in a startup error", () => {
  const marker = "synthetic-private-config-value";
  withPrivateConfig(`services: [\nsecret: ${marker}\n`, () => {
    assert.throws(() => new ConfigService(), error => {
      assert.match(error.message, /Cannot read or parse/);
      assert.ok(!error.message.includes(marker));
      return true;
    });
  });
});

test("nested schema validation reports fields without serializing credentials", () => {
  const marker = "synthetic-private-config-value";
  const config = yaml.load(fs.readFileSync(path.join(root, "config/backend.yaml.example"), "utf8"));
  config.server.hostname = marker;
  config.services.database.password = marker;
  config.services.minio.secretKey = marker;
  config.security.sessionSecret = marker;
  withPrivateConfig(yaml.dump(config), () => {
    assert.throws(() => new ConfigService(), error => {
      assert.match(error.message, /hostname/);
      assert.ok(!error.message.includes(marker));
      assert.ok(!error.message.includes('"target"'));
      assert.ok(!error.message.includes('"value"'));
      return true;
    });
  });
});
