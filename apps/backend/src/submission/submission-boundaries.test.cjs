// Run: node --test apps/backend/src/submission/submission-boundaries.test.cjs
// Who owns what in the submission module, so the split stays a split:
// - SubmissionAccessService owns who may do what with a submission;
// - SubmissionJudgingService owns judging (the Submission judge task type, progress, results) and the submission lock;
// - SubmissionService takes, reads and changes submissions, using the other two, which never depend on it.
// Study lists keep their data access in StudyListService, not in the controller.
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
function classOf(source, name) {
  const found = source.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === name);
  assert.ok(found, `${name} in ${source.fileName}`);
  return found;
}
function methods(declaration) {
  return declaration.members
    .filter(member => ts.isMethodDeclaration(member) && member.body)
    .map(member => member.name.getText());
}
function implementsNames(declaration) {
  return (declaration.heritageClauses || []).flatMap(clause => clause.types.map(type => type.expression.getText()));
}
function sourceFiles(directory = src) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}

const access = parse("submission/submission-access.service.ts");
const judging = parse("submission/submission-judging.service.ts");
const submissions = parse("submission/submission.service.ts");

test("access and judging never depend on the submission service, and access doesn't depend on judging", () => {
  assert.ok(!imports(access).some(name => /submission(\.service|-judging\.service)$/.test(name)), imports(access).join());
  assert.ok(!imports(judging).includes("./submission.service"), imports(judging).join());
});

test("the permission rules live only in SubmissionAccessService", () => {
  assert.ok(methods(classOf(access, "SubmissionAccessService")).includes("userHasPermission"));
  assert.ok(!methods(classOf(submissions, "SubmissionService")).includes("userHasPermission"));
  assert.ok(!methods(classOf(judging, "SubmissionJudgingService")).includes("userHasPermission"));
  // Every other module takes the permission type from there
  const elsewhere = sourceFiles().filter(file => {
    const text = fs.readFileSync(file, "utf8");
    return /export enum SubmissionPermissionType\b/.test(text) && !file.endsWith("submission-access.service.ts");
  });
  assert.deepEqual(elsewhere, []);
});

test("only SubmissionJudgingService handles the Submission judge task type", () => {
  const judgingClass = classOf(judging, "SubmissionJudgingService");
  assert.ok(implementsNames(judgingClass).some(name => name.startsWith("JudgeTaskService")));
  assert.match(judging.text, /registerTaskType\(JudgeTaskType\.Submission, this\)/);
  for (const name of ["onTaskProgress", "getTaskToBeSentToJudgeByTaskId", "listActiveTasks", "onTaskFailed", "lockSubmission"])
    assert.ok(methods(judgingClass).includes(name), name);

  const submissionClass = classOf(submissions, "SubmissionService");
  assert.deepEqual(implementsNames(submissionClass), []);
  assert.doesNotMatch(submissions.text, /registerTaskType/);
  const registrations = sourceFiles().filter(file =>
    /registerTaskType\(JudgeTaskType\.Submission\b/.test(fs.readFileSync(file, "utf8"))
  );
  assert.deepEqual(registrations.map(file => path.relative(src, file)), ["submission/submission-judging.service.ts"]);
});

test("the study list controller leaves data access to StudyListService", () => {
  const controller = fs.readFileSync(path.join(src, "study-list/study-list.controller.ts"), "utf8");
  assert.doesNotMatch(controller, /getRepository|createQueryBuilder|DataSource|InjectDataSource/);
  assert.match(fs.readFileSync(path.join(src, "study-list/study-list.service.ts"), "utf8"), /getRepository\(StudyListEntity\)/);
});
