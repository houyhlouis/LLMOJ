// Run: node --test apps/backend/src/ai/ai-boundaries.test.cjs
// Who owns what in the AI module, so the split stays a split:
// - AiJobCoordinator runs jobs. It alone takes the worker lock, claims jobs and changes them: their status, and their
//   progress saved under the run's token. It rechecks the owner's permissions during a run.
// - AiArtifactPublisher alone opens the transactions that publish to a problem after checking the job's snapshot.
// - AiWorkflowService holds the workflow steps; AiConfigurationService the encrypted configurations and the AI key.
// - AiService answers the AI pages. The others never depend on it, and the coordinator depends on neither the
//   workflow nor the publisher: the workflow registers itself with the coordinator.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const FILES = {
  AiService: "ai.service.ts",
  AiConfigurationService: "ai-configuration.service.ts",
  AiJobCoordinator: "ai-job-coordinator.service.ts",
  AiArtifactPublisher: "ai-artifact-publisher.service.ts",
  AiWorkflowService: "ai-workflow.service.ts"
};
const read = name => fs.readFileSync(path.join(__dirname, FILES[name]), "utf8");
function parse(name) {
  return ts.createSourceFile(FILES[name], read(name), ts.ScriptTarget.Latest, true);
}
function aiServiceImports(name) {
  return parse(name)
    .statements.filter(ts.isImportDeclaration)
    .map(statement => statement.moduleSpecifier.text)
    .filter(specifier => Object.values(FILES).some(file => `./${file.replace(/\.ts$/, "")}` === specifier))
    .sort();
}
function methods(name) {
  const source = parse(name);
  const found = source.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === name);
  assert.ok(found, name);
  return found.members.filter(member => ts.isMethodDeclaration(member) && member.body).map(member => member.name.getText());
}
const others = owner => Object.keys(FILES).filter(name => name !== owner);

test("dependencies point one way", () => {
  assert.deepEqual(aiServiceImports("AiConfigurationService"), []);
  assert.deepEqual(aiServiceImports("AiJobCoordinator"), ["./ai-configuration.service"]);
  assert.deepEqual(aiServiceImports("AiArtifactPublisher"), ["./ai-job-coordinator.service"]);
  assert.deepEqual(aiServiceImports("AiWorkflowService"), [
    "./ai-artifact-publisher.service",
    "./ai-configuration.service",
    "./ai-job-coordinator.service"
  ]);
  assert.match(read("AiWorkflowService"), /coordinator\.registerWorkflow\(this\)/);
  // Outside the module only the controller uses AiService
  const users = fs
    .readdirSync(path.join(__dirname, ".."), { recursive: true })
    .filter(file => /\.ts$/.test(file) && /from "(\.\.\/ai|\.)\/ai\.service"/.test(fs.readFileSync(path.join(__dirname, "..", file), "utf8")));
  assert.deepEqual(users.sort(), ["ai/ai.controller.ts", "ai/ai.module.ts"]);
});

test("only the coordinator runs and changes jobs", () => {
  for (const name of ["work", "runJob", "checkpoint", "assertJob", "enqueue", "cancel", "requeue", "saveInTransaction"]) {
    assert.ok(methods("AiJobCoordinator").includes(name), name);
    for (const other of others("AiJobCoordinator").filter(service => service !== "AiService" || name !== "cancel"))
      assert.ok(!methods(other).includes(name), `${other} also has ${name}`);
  }
  assert.match(read("AiJobCoordinator"), /GET_LOCK/);
  for (const other of others("AiJobCoordinator")) {
    const text = read(other);
    assert.doesNotMatch(text, /GET_LOCK|RELEASE_LOCK/, other);
    // No job row is written elsewhere: not through the repository, not in a transaction
    assert.doesNotMatch(text, /this\.jobs\.(update|save|insert|delete)\(|\b(update|save|insert|delete)\(\s*AiJobEntity\b|getRepository\(AiJobEntity\)/, other);
  }
});

test("only the publisher opens publication transactions and checks problem snapshots", () => {
  for (const name of ["snapshot", "assertSnapshot", "authorizeProblemCommit", "lockProblemCommit", "commitProblem", "putFile"]) {
    assert.ok(methods("AiArtifactPublisher").includes(name), name);
    for (const other of others("AiArtifactPublisher")) assert.ok(!methods(other).includes(name), `${other} also has ${name}`);
  }
  for (const other of others("AiArtifactPublisher")) assert.doesNotMatch(read(other), /transaction\("SERIALIZABLE"/, other);
});

test("only the configuration service holds the AI key", () => {
  for (const other of others("AiConfigurationService"))
    assert.doesNotMatch(
      read(other),
      /loadAiEncryptionKey|encryptAiConfiguration|decryptAiConfiguration|signAiAttachment|readAiAttachment|this\.key\b/,
      other
    );
});

test("the workflow steps live in the workflow service", () => {
  for (const name of ["execute", "importProblem", "edit", "testdata", "model", "runSandbox"]) {
    assert.ok(methods("AiWorkflowService").includes(name), name);
    for (const other of others("AiWorkflowService")) assert.ok(!methods(other).includes(name), `${other} also has ${name}`);
  }
});
