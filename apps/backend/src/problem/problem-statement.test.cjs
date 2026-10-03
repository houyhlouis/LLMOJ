// Isolated DTO and service persistence tests; no database, Redis, files, or live OJ calls.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
const { plainToInstance } = require("class-transformer");
const { validateSync } = require("class-validator");
const { CreateProblemRequestDto } = require("./dto/create-problem-request.dto.ts");
const { UpdateProblemStatementRequestDto } = require("./dto/update-problem-statement-request.dto.ts");
const { ProblemService } = require("./problem.service.ts");
const { ProblemEntity, ProblemType } = require("./problem.entity.ts");
const { ProblemSampleEntity } = require("./problem-sample.entity.ts");
const { LocalizedContentType } = require("../localized-content/localized-content.entity.ts");
const { Locale } = require("../common/locale.type.ts");
const localized = (title = "Only a title", contentSections = []) => ({ locale: Locale.en_US, title, contentSections });
const statement = (contents = [localized()]) => ({
  localizedContents: contents,
  samples: [],
  problemTagIds: [],
  difficulty: null,
  originalProblem: ""
});
const errors = (type, value) =>
  validateSync(plainToInstance(type, value), { whitelist: true, forbidNonWhitelisted: true });
function fakeService() {
  const service = Object.create(ProblemService.prototype),
    saved = [],
    localizedWrites = [],
    deleted = [];
  const sample = { problemId: 42, data: [{ inputData: "1", outputData: "2" }] };
  const manager = {
    save: async entity => {
      if (entity instanceof ProblemEntity && entity.id == null) entity.id = 42;
      saved.push(entity);
      return entity;
    },
    findOneBy: async () => sample,
    findOne: async () => ({ id: 42, locales: [Locale.en_US], originalProblem: "old source" }),
    update: async (type, id, changes) => saved.push({ type, id, changes })
  };
  let transactions = 0;
  service.connection = {
    transaction: async (_level, callback) => {
      transactions++;
      return callback(manager);
    }
  };
  service.problemTypeFactoryService = { type: () => ({ getDefaultJudgeInfo: () => ({}) }) };
  service.localizedContentService = {
    createOrUpdate: async (id, type, locale, content) => localizedWrites.push({ id, type, locale, content }),
    delete: async (...args) => deleted.push(args)
  };
  service.setProblemTags = async () => {};
  service.getProblemAllLocalizedContents = async () => [
    localized("Existing title", [{ type: "Text", sectionTitle: "Description", text: "Previous body" }])
  ];
  return { service, saved, localizedWrites, deleted, sample, transactions: () => transactions };
}
test("create and update DTOs accept title-only and explicitly empty statement/sample fields", () => {
  for (const contents of [[localized()], [localized("Only a title", [{ type: "Text", sectionTitle: "", text: "" }])]]) {
    assert.equal(
      errors(CreateProblemRequestDto, { type: ProblemType.Traditional, statement: statement(contents) }).length,
      0
    );
    assert.equal(errors(UpdateProblemStatementRequestDto, { problemId: 42, ...statement(contents) }).length, 0);
  }
  const withBlankSample = statement([
    localized("Title", [{ type: "Sample", sectionTitle: "", sampleId: 0, text: "" }])
  ]);
  withBlankSample.samples = [{ inputData: "", outputData: "" }];
  assert.equal(
    errors(CreateProblemRequestDto, { type: ProblemType.Traditional, statement: withBlankSample }).length,
    0
  );
});
test("a second language can remain an incomplete draft", () => {
  const contents = [
    localized("Title"),
    { locale: Locale.zh_CN, title: "", contentSections: [{ type: "Text", sectionTitle: "", text: "草稿" }] }
  ];
  assert.equal(
    errors(CreateProblemRequestDto, { type: ProblemType.Traditional, statement: statement(contents) }).length,
    0
  );
});
test("creation rejects missing, empty and whitespace-only titles", () => {
  for (const contents of [[], [localized("")], [localized(" \t\n")], [{ locale: Locale.en_US, contentSections: [] }]])
    assert.ok(
      errors(CreateProblemRequestDto, { type: ProblemType.Traditional, statement: statement(contents) }).length > 0
    );
});
test("real type, locale uniqueness and length restrictions remain", () => {
  for (const contents of [
    [localized("x".repeat(121))],
    [localized("Title", [{ type: "Text", sectionTitle: "x".repeat(121), text: "" }])],
    [localized("Title", [{ type: "Text", sectionTitle: "", text: 3 }])],
    [localized("First"), localized("Second")]
  ])
    assert.ok(
      errors(CreateProblemRequestDto, { type: ProblemType.Traditional, statement: statement(contents) }).length > 0
    );
  for (const value of [null, {}, "invalid"])
    assert.ok(
      errors(CreateProblemRequestDto, {
        type: ProblemType.Traditional,
        statement: { ...statement(), localizedContents: value }
      }).length > 0
    );
  for (const difficulty of [-1, 4001, 1.5, "800"])
    assert.ok(errors(UpdateProblemStatementRequestDto, { problemId: 42, ...statement(), difficulty }).length > 0);
});
test("service creates a title-only problem without invented body, samples, difficulty or source", async () => {
  const f = fakeService();
  const problem = await f.service.createProblem({ id: 7 }, ProblemType.Traditional, statement(), []);
  assert.equal(problem.difficulty, null);
  assert.equal(problem.originalProblem, "");
  assert.deepEqual(f.saved.find(x => x instanceof ProblemSampleEntity).data, []);
  assert.equal(f.localizedWrites.find(x => x.type === LocalizedContentType.ProblemContent).content, "[]");
});
test("editing can delete every section, sample, source and difficulty", async () => {
  const f = fakeService(),
    problem = { id: 42, locales: [Locale.en_US], difficulty: 1200, originalProblem: "old source" };
  assert.equal(await f.service.updateProblemStatement(problem, { problemId: 42, ...statement() }, []), true);
  assert.deepEqual(f.sample.data, []);
  assert.equal(problem.difficulty, null);
  assert.equal(problem.originalProblem, "");
  assert.equal(f.localizedWrites.find(x => x.type === LocalizedContentType.ProblemContent).content, "[]");
});
test("partial updates preserve omitted existing title, statement and samples", async () => {
  const f = fakeService(),
    problem = { id: 42, locales: [Locale.en_US] };
  await f.service.updateProblemStatement(
    problem,
    { problemId: 42, localizedContents: [{ locale: Locale.en_US }], problemTagIds: [] },
    []
  );
  assert.equal(f.localizedWrites.find(x => x.type === LocalizedContentType.ProblemTitle).content, "Existing title");
  assert.match(f.localizedWrites.find(x => x.type === LocalizedContentType.ProblemContent).content, /Previous body/);
  assert.deepEqual(f.sample.data, [{ inputData: "1", outputData: "2" }]);
});
test("service rejects clearing the last title before any persistence", async () => {
  for (const title of ["", " \n\t"]) {
    const f = fakeService();
    await assert.rejects(
      f.service.updateProblemStatement(
        { id: 42, locales: [Locale.en_US] },
        { problemId: 42, ...statement([localized(title)]) },
        []
      ),
      e => e.getStatus() === 400
    );
    assert.equal(f.transactions(), 0);
    await assert.rejects(
      f.service.createProblem({ id: 7 }, ProblemType.Traditional, statement([localized(title)]), []),
      e => e.getStatus() === 400
    );
    assert.equal(f.transactions(), 0);
  }
});
