// Load the real task handler with the runner, storage and RPC transport provided by each test.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

module.exports = function loadWorker(stubs) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "index.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", source)(
    name => {
      if (["fs", "path", "@libreoj/judge-protocol"].includes(name)) return require(name);
      if (!(name in stubs)) throw new Error(`Unexpected runtime import ${name}`);
      return stubs[name];
    },
    loaded,
    loaded.exports
  );
  return loaded.exports.default;
};
