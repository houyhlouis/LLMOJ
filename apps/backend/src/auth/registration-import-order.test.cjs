const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Each case starts a fresh Node process and enters through main, so no test helper
// preloads UserService and accidentally changes CommonJS cycle evaluation order.
// Suppress only main's final bootstrap call: imports and decorators are real, but
// this regression never connects to a database, Redis, MinIO, or a listening port.
const inspect = String.raw`
const fs = require("node:fs"), path = require("node:path");
require("reflect-metadata");
const mode = process.argv[1];
const sourceRoot = path.resolve("dist");
const extension = ".js";
const main = path.join(sourceRoot, "main" + extension);
const gatewayFile = path.join(sourceRoot, "submission/submission-progress.gateway" + extension);
const original = require.extensions[extension];
let entrySuppressed = false, mutationApplied = false;
require.extensions[extension] = (module, filename) => {
  if (filename !== main && filename !== gatewayFile) return original(module, filename);
  let source = fs.readFileSync(filename, "utf8");
  if (filename === main) {
    const start = source.lastIndexOf("\nbootstrap().catch(");
    if (start === -1) throw Error("Cannot locate the startup-only entrypoint");
    source = source.slice(0, start);
    entrySuppressed = true;
  }
  if (filename === gatewayFile && mode === "without-forward-ref") {
    const declaration = "    __param(4, (0, common_1.Inject)((0, common_1.forwardRef)(() => user_privilege_service_1.UserPrivilegeService))),\n";
    if (!source.includes(declaration)) throw Error("Cannot locate the known regression mutation");
    source = source.replace(declaration, "");
    mutationApplied = true;
  }
  module._compile(source, filename);
};
require(main);
const missing = [];
const inspected = new Set();
for (const module of Object.values(require.cache)) {
  if (!module.filename?.startsWith(sourceRoot + path.sep) || !module.filename.endsWith(extension)) continue;
  for (const component of Object.values(module.exports)) {
    if (typeof component !== "function" || inspected.has(component)) continue;
    const params = Reflect.getMetadata("design:paramtypes", component);
    if (!params) continue;
    inspected.add(component);
    const dependencies = [...params];
    for (const dependency of Reflect.getMetadata("self:paramtypes", component) || [])
      dependencies[dependency.index] = dependency.param;
    dependencies.forEach((dependency, index) => {
      const token = dependency?.forwardRef ? dependency.forwardRef() : dependency;
      if (token == null) missing.push({ component: component.name, index });
    });
  }
}
process.stdout.write(JSON.stringify({ entrySuppressed, mutationApplied, checkedClasses: inspected.size, missing }));
`;

function inspectFreshProcess(mode) {
  const result = spawnSync(process.execPath, ["-e", inspect, mode], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.entrySuppressed, true);
  assert.ok(report.checkedClasses >= 60, "must inspect the complete application import graph");
  return report;
}

// Use the emitted production graph: transpileModule can mask a missing cyclic
// runtime type with Object, so its metadata is not a substitute for a real build.
const requiresBuild = {
  skip: !require("node:fs").existsSync(path.resolve(__dirname, "../../dist/main.js"))
};
test("main-first production build imports resolve every constructor dependency", requiresBuild, () => {
  assert.deepEqual(inspectFreshProcess("compiled").missing, []);
});

test("main-first production regression detects the omitted gateway forwardRef", requiresBuild, () => {
  const report = inspectFreshProcess("without-forward-ref");
  assert.equal(report.mutationApplied, true);
  assert.deepEqual(report.missing, [{ component: "SubmissionProgressGateway", index: 4 }]);
});
