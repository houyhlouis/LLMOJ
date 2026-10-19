// Run: node --test apps/backend/src/problem/problem-boundaries.test.cjs
// Who owns what in the problem module, so the split stays a split:
// - ProblemAccessService owns who may do what with a problem;
// - ProblemFileService owns a problem's files, ProblemTagService the tags, ProblemLockService the problem lock;
// - ProblemService keeps the catalog (statements, samples, judge info, publicness, deletion) and uses the others,
//   which never depend on it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const src = path.join(__dirname, "..");

function parse(relative) {
  const file = path.join(src, relative);
  return ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}
function imports(source) {
  return source.statements.filter(ts.isImportDeclaration).map(statement => statement.moduleSpecifier.text);
}
function methods(source, name) {
  const found = source.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === name);
  assert.ok(found, `${name} in ${source.fileName}`);
  return found.members.filter(member => ts.isMethodDeclaration(member) && member.body).map(member => member.name.getText());
}
function sourceFiles(directory = src) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}

const SERVICES = {
  ProblemService: parse("problem/problem.service.ts"),
  ProblemAccessService: parse("problem/problem-access.service.ts"),
  ProblemFileService: parse("problem/problem-file.service.ts"),
  ProblemTagService: parse("problem/problem-tag.service.ts"),
  ProblemLockService: parse("problem/problem-lock.service.ts")
};
const OWNED = {
  ProblemAccessService: ["userHasPermission", "getUserPermissions", "userHasCreateProblemPermission", "authorizeProblemMutation"],
  ProblemFileService: ["addProblemFile", "addProblemFilesFromDisk", "removeProblemFiles", "renameProblemFile", "getProblemFiles", "listProblemFiles"],
  ProblemTagService: ["createProblemTag", "updateProblemTag", "deleteProblemTag", "setProblemTags", "getProblemTagsByProblem"],
  ProblemLockService: ["lockProblemById"]
};

test("the split services never depend on ProblemService", () => {
  for (const name of ["ProblemAccessService", "ProblemFileService", "ProblemTagService", "ProblemLockService"])
    assert.ok(!imports(SERVICES[name]).includes("./problem.service"), name);
  // Access rules and tags depend on no other problem service; files only on access and the lock
  assert.deepEqual(imports(SERVICES.ProblemAccessService).filter(name => /^\.\/problem-.*\.service$/.test(name)), []);
  assert.deepEqual(imports(SERVICES.ProblemTagService).filter(name => /^\.\/problem-.*\.service$/.test(name)), []);
  assert.deepEqual(
    imports(SERVICES.ProblemFileService).filter(name => /^\.\/problem-.*\.service$/.test(name)).sort(),
    ["./problem-access.service", "./problem-lock.service"]
  );
});

test("each operation has one owner", () => {
  for (const [owner, names] of Object.entries(OWNED))
    for (const name of names) {
      assert.ok(methods(SERVICES[owner], owner).includes(name), `${owner}.${name}`);
      for (const other of Object.keys(SERVICES).filter(service => service !== owner))
        assert.ok(!methods(SERVICES[other], other).includes(name), `${other} also has ${name}`);
    }
});

test("the permission types are declared once, with the rules", () => {
  const declaring = sourceFiles().filter(file =>
    /export enum ProblemPermission(Type|Level)\b/.test(fs.readFileSync(file, "utf8"))
  );
  assert.deepEqual(declaring.map(file => path.relative(src, file)), ["problem/problem-access.service.ts"]);
});

test("only the problem services write problem files, tags and tag assignments", () => {
  // Writes go through the entity classes; reads elsewhere are fine
  const writers = sourceFiles().filter(file => {
    const text = fs.readFileSync(file, "utf8");
    return /\.(save|update|delete|insert|remove)\((ProblemFileEntity|ProblemTagEntity|ProblemTagMapEntity)\b|\.into\(ProblemTagMapEntity\)/.test(text);
  });
  assert.deepEqual(
    writers.map(file => path.relative(src, file)).sort(),
    ["problem/problem-file.service.ts", "problem/problem-tag.service.ts"]
  );
});

test("the preprocessed judge info cache key is written in one place", () => {
  const users = sourceFiles().filter(file =>
    fs.readFileSync(file, "utf8").includes("problem-preprocessed-judge-info-and-submittable")
  );
  assert.deepEqual(users.map(file => path.relative(src, file)), ["problem/problem-judge-info-cache.ts"]);
});
