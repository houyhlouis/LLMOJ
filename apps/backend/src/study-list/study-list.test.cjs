// A study list shows each problem the reader may view, with its titles and accepted submission, and marks the others
// unavailable. Its problems and titles are read together, but each problem's access is still checked on its own.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
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
const main = require.resolve("../main.ts");
require.cache[main] = { id: main, filename: main, loaded: true, exports: { appGitRepoInfo: {} } };
String.prototype.format ||= function format(...args) {
  return require("node:util").format(String(this), ...args);
};

const { StudyListController } = require("./study-list.controller.ts");
const { StudyListEntity } = require("./study-list.entity.ts");

test("problems are shown, or marked unavailable, as each one's access allows", async () => {
  const items = [
    { problemId: 1, section: "A", note: "public" },
    { problemId: 2, section: "A", note: "hidden" },
    { problemId: 3, section: "B", note: "deleted" },
    { problemId: 4, section: "B", note: "English only" }
  ];
  const list = { id: 5, ownerId: 9, items };
  const problems = {
    1: { id: 1, locales: ["zh_CN", "en_US"], isPublic: true },
    2: { id: 2, locales: ["en_US"], isPublic: false },
    4: { id: 4, locales: ["en_US"], isPublic: true }
  };
  const titles = { "1:zh_CN": "一", "1:en_US": "One", "4:en_US": "Four" };
  const checked = [];
  const controller = new StudyListController(
    {
      getRepository: entity =>
        entity === StudyListEntity
          ? { findOneBy: async ({ id, ownerId }) => (id === 5 && ownerId === 9 ? list : null) }
          : {
              createQueryBuilder: () => {
                const builder = {
                  select: () => builder,
                  addSelect: () => builder,
                  where: () => builder,
                  andWhere: () => builder,
                  groupBy: () => builder,
                  getRawMany: async () => [{ problemId: "4", submissionId: "77" }]
                };
                return builder;
              }
            }
    },
    {
      findProblemsByExistingIds: async ids => ids.map(id => problems[id]),
      userHasPermission: async (user, problem) => (checked.push(problem.id), problem.isPublic),
      getProblemLocalizedTitles: async (list, locales) => list.map((problem, i) => titles[`${problem.id}:${locales[i]}`] ?? null),
      getProblemMeta: async problem => ({ id: problem.id })
    },
    { userHasPrivilege: async () => true }
  );
  // The team-resource note needs a request; outside one it does nothing
  const result = await controller.get({ id: 9 }, { id: 5 });
  assert.deepEqual(checked, [1, 2, 4]);
  assert.deepEqual(result.details, [
    {
      ...items[0],
      meta: { id: 1 },
      titles: { zh_CN: "一", en_US: "One" },
      accepted: false,
      submission: null
    },
    { ...items[1], unavailable: true },
    { ...items[2], unavailable: true },
    {
      ...items[3],
      meta: { id: 4 },
      titles: { zh_CN: "Four", en_US: "Four" },
      accepted: true,
      submission: { id: 77, status: "Accepted" }
    }
  ]);
  await assert.rejects(controller.get({ id: 8 }, { id: 5 }), /Not Found/);
});
