// What C and C++ programs are built for on x86-64 and arm64 judges, and how the languages pass it to the compilers.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// Loads a judge source file as on a machine of `arch` (process.arch), with `modules` as its imports
function load(file, arch, modules = {}) {
  const loaded = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    "process",
    ts.transpileModule(fs.readFileSync(path.join(__dirname, file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText
  )(
    name => {
      if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
      return modules[name];
    },
    loaded,
    loaded.exports,
    { ...process, arch }
  );
  return loaded.exports;
}

const compileParameters = (language, options) =>
  language.compile({
    sourceDirectoryInside: "/sandbox/source",
    sourcePathInside: `/sandbox/source/${language.getMetaOptions(options).sourceFilename}`,
    binaryDirectoryInside: "/sandbox/binary",
    compileAndRunOptions: options
  }).parameters;

for (const [arch, architectures] of [
  ["x64", ["64", "32"]],
  ["arm64", ["64"]]
]) {
  const architecture = load("architecture.ts", arch);
  const cpp = load("languages/cpp.ts", arch, { "../architecture": architecture }).languageConfig;
  const c = load("languages/c.ts", arch, { "../architecture": architecture }).languageConfig;

  test(`${arch} judges build C and C++ for ${architectures.join(" and ")} bits`, () => {
    assert.deepEqual([...architecture.C_ARCHITECTURES], architectures);
    for (const m of architectures) {
      assert.equal(architecture.cArchitectureUnavailable(m), null);
      assert.equal(cpp.unavailable({ compiler: "g++", std: "c++17", O: "2", m }), null);
      assert.equal(c.unavailable({ compiler: "gcc", std: "c11", O: "2", m }), null);
    }
  });

  test(`${arch} judges pass their architecture to GCC and Clang`, () => {
    for (const [language, compiler] of [
      [cpp, "g++"],
      [cpp, "clang++"],
      [c, "gcc"],
      [c, "clang"]
    ]) {
      const parameters = compileParameters(language, { compiler, std: language === cpp ? "c++17" : "c11", O: "2", m: "64" });
      if (arch === "x64") {
        // Exactly as before arm64 was supported
        assert.deepEqual(parameters.slice(-3, -1), ["-m64", "-march=native"]);
        assert(!parameters.includes("-fsigned-char"));
      } else {
        assert.deepEqual(parameters.slice(-3, -1), ["-march=native", "-fsigned-char"]);
        assert(!parameters.some(parameter => /^-m(64|32|x32)$/.test(parameter)), parameters.join(" "));
      }
      assert.equal(parameters.includes("-stdlib=libc++"), compiler === "clang++");
    }
    if (arch === "x64") {
      const parameters = compileParameters(cpp, { compiler: "clang++", std: "c++17", O: "2", m: "32" });
      assert(parameters.includes("-m32") && !parameters.includes("-stdlib=libc++"));
    }
  });
}

test("arm64 judges refuse 32-bit programs with a message for the submitter", () => {
  const architecture = load("architecture.ts", "arm64");
  const cpp = load("languages/cpp.ts", "arm64", { "../architecture": architecture }).languageConfig;
  const message = cpp.unavailable({ compiler: "g++", std: "c++17", O: "2", m: "32" });
  assert.match(message, /AArch64/);
  assert.match(message, /x86-64 judge machine/);
  assert.match(message, /64-bit/);
});
