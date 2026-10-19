// Real SQL regression for saving study lists. Opt in with an isolated database configuration
// (HYHOJ_PROBLEM_TEST_DB_CONFIG); the test's own randomly named table is dropped afterwards.
// Only the owner reads, changes or deletes a list; a save applies only on top of the version its editor loaded; notes on
// problems the owner can no longer view are kept, but such problems can't be added.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
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

const { DataSource, EntitySchema } = require("typeorm");
const { StudyListService } = require("./study-list.service.ts");
const { StudyListEntity } = require("./study-list.entity.ts");

test("study lists: owner only, saved on top of the loaded version, notes kept (real MariaDB)", {
  skip: !process.env.HYHOJ_PROBLEM_TEST_DB_CONFIG,
  timeout: 60000
}, async () => {
  const cfg = require("js-yaml").load(fs.readFileSync(process.env.HYHOJ_PROBLEM_TEST_DB_CONFIG, "utf8")).services.database;
  const table = "qa_study_" + crypto.randomBytes(6).toString("hex");
  const db = new DataSource({
    ...cfg,
    entities: [
      new EntitySchema({
        name: StudyListEntity.name,
        target: StudyListEntity,
        tableName: table,
        columns: {
          id: { type: Number, primary: true, generated: true },
          ownerId: { type: Number },
          title: { type: String, length: 160 },
          description: { type: "mediumtext" },
          items: { type: "json" },
          starred: { type: Boolean, default: false },
          archived: { type: Boolean, default: false },
          version: { type: Number, version: true },
          updatedAt: { type: Date, updateDate: true }
        }
      })
    ],
    synchronize: true,
    logging: false
  });
  await db.initialize();
  try {
    // Problem 1 is public; 2 is private to its owner (user 7); 3 doesn't exist
    const viewable = { 1: () => true, 2: user => user.id === 7 };
    const problems = {
      findProblemById: async id => (viewable[id] ? { id } : null),
      userHasPermission: async (user, problem) => viewable[problem.id](user)
    };
    const service = new StudyListService(db, problems, problems, {});
    const owner = { id: 7 },
      other = { id: 8 };
    const item = (problemId, note = "") => ({ problemId, section: "S", note });
    const changes = (title, items) => ({ title, description: "d", items, starred: false, archived: false });

    const created = await service.save(owner, undefined, undefined, changes(" Graphs ", [item(1), item(2, "mine")]));
    const id = created.id;
    let list = await service.findOwned(owner, id);
    assert.equal(list.title, "Graphs", "the title is trimmed");
    assert.equal(list.version, 1);

    // Owner only
    assert.equal(await service.findOwned(other, id), null);
    assert.deepEqual(await service.save(other, id, 1, changes("Mine now", [])), { error: "NOT_FOUND" });
    assert.equal(await service.remove(other, id), false);
    assert.deepEqual((await service.listOwned(other)).length, 0);

    // A save applies only on top of the version its editor loaded
    assert.deepEqual(await service.save(owner, id, 1, changes("Graphs 2", [item(1), item(2, "mine")])), { id });
    list = await service.findOwned(owner, id);
    assert.equal(list.title, "Graphs 2");
    assert.equal(list.version, 2, "each save makes a new version");
    assert.deepEqual(await service.save(owner, id, 1, changes("Stale editor", [])), { error: "CHANGED" });
    assert.equal((await service.findOwned(owner, id)).title, "Graphs 2", "a stale save changes nothing");
    // Two editors that loaded the same version: one save applies, the other is refused
    const results = await Promise.all([
      service.save(owner, id, 2, changes("Tab A", [item(1)])),
      service.save(owner, id, 2, changes("Tab B", [item(1)]))
    ]);
    assert.deepEqual(
      results.map(result => ("error" in result ? result.error : "saved")).sort(),
      ["CHANGED", "saved"]
    );
    list = await service.findOwned(owner, id);
    assert.equal(list.version, 3);

    // Problem 2 becomes private to someone else: the note on it is kept, but it can't be added again
    viewable[2] = () => false;
    const withNote = changes("Graphs", [item(1), item(2, "still mine")]);
    assert.deepEqual(await service.save(owner, id, 3, changes("Graphs", [item(1)])), { id });
    assert.deepEqual(await service.save(owner, id, 4, withNote), { error: "PROBLEM_UNAVAILABLE" });
    const keeps = await service.save(owner, undefined, undefined, changes("Kept", [item(1)]));
    assert.deepEqual(await service.save(owner, keeps.id, 1, changes("Kept", [item(1), item(3)])), {
      error: "PROBLEM_UNAVAILABLE"
    });
    const old = await service.save(owner, undefined, undefined, changes("Old", [item(1)]));
    await db.getRepository(StudyListEntity).update({ id: old.id }, { items: [item(1), item(2, "from before")] });
    const before = (await service.findOwned(owner, old.id)).version;
    assert.deepEqual(await service.save(owner, old.id, before, changes("Old", [item(2, "edited note"), item(1)])), {
      id: old.id
    });
    assert.deepEqual((await service.findOwned(owner, old.id)).items, [item(2, "edited note"), item(1)]);

    // Invalid lists aren't saved
    assert.deepEqual(await service.save(owner, undefined, undefined, changes("  ", [])), { error: "INVALID" });
    assert.deepEqual(await service.save(owner, undefined, undefined, changes("Dup", [item(1), item(1)])), {
      error: "INVALID"
    });

    // Listing: starred first, then the most recently changed
    await service.save(owner, keeps.id, 1, { ...changes("Kept", [item(1)]), starred: true });
    assert.equal((await service.listOwned(owner))[0].id, keeps.id);
    assert.equal(await service.remove(owner, id), true);
    assert.equal(await service.findOwned(owner, id), null);
  } finally {
    await db.query(`DROP TABLE IF EXISTS \`${table}\``);
    await db.destroy();
  }
});
