const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
const { ContestService } = require("./contest.service.ts");
const { UserPrivilegeType } = require("../user/user-privilege.service.ts");
const { ForbiddenException, NotFoundException } = require("@nestjs/common");
function fixture() {
  const service = Object.create(ContestService.prototype),
    user = { id: 7 },
    reads = [],
    signed = [],
    contents = { public: Buffer.from("void Alice();"), hidden: Buffer.from("void Alice();") };
  const contest = {
    id: 10,
    ownerId: 1,
    adminIds: [],
    isPublic: true,
    startTime: new Date(Date.now() - 60000),
    endTime: new Date(Date.now() + 60000)
  };
  const problem = { id: 3, type: "Communication", locales: ["en_US"] };
  const info = {
    timeLimit: 1000,
    memoryLimit: 128,
    grader: { filename: "secret-grader.cpp" },
    manager: { filename: "secret-manager.cpp" },
    extraSourceFiles: { cpp: { "communication.h": "hidden-header.h" } }
  };
  const row = { id: 20, contestId: 10, problemId: 3, title: "", attachments: [], problem: Promise.resolve(problem) };
  const publicFiles = [{ filename: "communication.h", uuid: "public", size: contents.public.length }],
    hiddenFiles = [{ filename: "hidden-header.h", uuid: "hidden", size: contents.hidden.length }];
  service.privileges = {
    userHasPrivilege: async (u, p) =>
      !!u &&
      !u.denied?.includes(p) &&
      [
        UserPrivilegeType.ViewContest,
        UserPrivilegeType.ParticipateContest,
        UserPrivilegeType.DownloadProblemAttachments
      ].includes(p)
  };
  service.db = {
    getRepository: entity => ({
      findOneBy: async q =>
        entity.name === "ContestEntity"
          ? q.id === 10
            ? contest
            : null
          : q.id === 20 && q.contestId === 10
          ? row
          : null
    })
  };
  service.problems = {
    getProblemJudgeInfo: async () => [info, true],
    listProblemFiles: async (_p, type) => (type === "AdditionalFile" ? publicFiles : hiddenFiles),
    getProblemLocalizedTitle: async () => "Public title",
    getProblemLocalizedContent: async () => [],
    getProblemSamples: async () => []
  };
  service.files = {
    downloadFileToPath: async (uuid, file, maximum) => {
      assert.equal(maximum, 256 * 1024);
      reads.push({ uuid, file });
      const b = contents[uuid];
      if (!b) throw Error("missing");
      if (b.length > maximum) throw Error("FILE_SIZE_LIMIT");
      await fs.promises.writeFile(file, b, { flag: "wx" });
      return b.length;
    },
    signDownloadLink: async input => {
      signed.push(input.uuid);
      return "signed:" + input.uuid;
    }
  };
  return { service, user, contest, problem, info, row, publicFiles, hiddenFiles, contents, reads, signed };
}
function cleanReads(f) {
  for (const read of f.reads)
    assert(!fs.existsSync(path.dirname(read.file)), "header comparison temporary directory must be removed");
}
test("matching declared public header is listed and only the AdditionalFile object is signed", async () => {
  const f = fixture();
  const result = await f.service.problem(f.user, 10, 20, "en_US");
  assert.deepEqual(result.problem.attachments, [
    { filename: "communication.h", uuid: "public", size: 13, derived: true }
  ]);
  assert(!JSON.stringify(result).includes("hidden-header"));
  assert(!JSON.stringify(result).includes("secret-"));
  assert.equal((await f.service.download(f.user, 10, 20, "communication.h")).url, "signed:public");
  assert.deepEqual(f.signed, ["public"]);
  cleanReads(f);
});
test("same-name different bytes and unreferenced public files are not derived attachments", async () => {
  const f = fixture();
  f.contents.public = Buffer.from("void Zlice();");
  f.publicFiles.push(
    { filename: "std.cpp", uuid: "answer", size: 1 },
    { filename: "unrelated.h", uuid: "other", size: 1 }
  );
  assert.deepEqual((await f.service.problem(f.user, 10, 20, "en_US")).problem.attachments, []);
  await assert.rejects(f.service.download(f.user, 10, 20, "communication.h"), NotFoundException);
  assert(f.reads.every(r => ["public", "hidden"].includes(r.uuid)));
  assert.deepEqual(f.signed, []);
  cleanReads(f);
});
test("explicit contest attachment wins a same-name collision without reading source headers", async () => {
  const f = fixture();
  f.row.attachments = [{ filename: "communication.h", uuid: "contest-explicit", size: 5 }];
  assert.deepEqual((await f.service.problem(f.user, 10, 20, "en_US")).problem.attachments, f.row.attachments);
  assert.equal((await f.service.download(f.user, 10, 20, "communication.h")).url, "signed:contest-explicit");
  assert.deepEqual(f.reads, []);
});
test("before-start, nonparticipant, explicit attachment deny and hidden contest permissions are respected", async () => {
  const f = fixture();
  f.contest.startTime = new Date(Date.now() + 60000);
  await assert.rejects(f.service.download(f.user, 10, 20, "communication.h"), ForbiddenException);
  f.contest.startTime = new Date(Date.now() - 60000);
  for (const deny of [UserPrivilegeType.ParticipateContest, UserPrivilegeType.DownloadProblemAttachments]) {
    f.user.denied = [deny];
    assert.deepEqual((await f.service.problem(f.user, 10, 20, "en_US")).problem.attachments, []);
    await assert.rejects(f.service.download(f.user, 10, 20, "communication.h"), ForbiddenException);
  }
  f.user.denied = [];
  f.contest.isPublic = false;
  await assert.rejects(f.service.download(f.user, 10, 20, "communication.h"), ForbiddenException);
  assert.deepEqual(f.reads, []);
});
test("arbitrary TestData names, paths, unrelated headers and cross-contest/problem identifiers are rejected", async () => {
  const f = fixture();
  for (const name of [
    "secret-manager.cpp",
    "secret-grader.cpp",
    "std.cpp",
    "hidden-header.h",
    "../communication.h",
    "/communication.h",
    "unrelated.h"
  ])
    await assert.rejects(f.service.download(f.user, 10, 20, name), NotFoundException);
  await assert.rejects(f.service.download(f.user, 11, 20, "communication.h"), NotFoundException);
  await assert.rejects(f.service.download(f.user, 10, 21, "communication.h"), NotFoundException);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.signed, []);
});
test("a download compares only the requested header even when other candidates exist", async () => {
  const f = fixture();
  f.info.extraSourceFiles.cpp["other.hpp"] = "hidden-other.hpp";
  f.publicFiles.push({ filename: "other.hpp", uuid: "other-public", size: 1 });
  f.hiddenFiles.push({ filename: "hidden-other.hpp", uuid: "other-hidden", size: 1 });
  assert.equal((await f.service.download(f.user, 10, 20, "communication.h")).url, "signed:public");
  assert.deepEqual(f.reads.map(x => x.uuid).sort(), ["hidden", "public"]);
  cleanReads(f);
});
test("comparison has a 16-header and 256 KiB-per-object bound", async () => {
  const f = fixture();
  f.info.extraSourceFiles.cpp = {};
  f.publicFiles.length = 0;
  f.hiddenFiles.length = 0;
  for (let i = 0; i < 18; i++) {
    f.info.extraSourceFiles.cpp["h" + i + ".h"] = "hidden" + i + ".h";
    f.publicFiles.push({ filename: "h" + i + ".h", uuid: "p" + i, size: 1 });
    f.hiddenFiles.push({ filename: "hidden" + i + ".h", uuid: "h" + i, size: 1 });
    f.contents["p" + i] = f.contents["h" + i] = Buffer.from("x");
  }
  const result = await f.service.problem(f.user, 10, 20, "en_US");
  assert.equal(result.problem.attachments.length, 16);
  assert.equal(f.reads.length, 32);
  cleanReads(f);
  f.reads.length = 0;
  f.publicFiles[0].size = f.hiddenFiles[0].size = 256 * 1024 + 1;
  await assert.rejects(f.service.download(f.user, 10, 20, "h0.h"), NotFoundException);
  assert.deepEqual(f.reads, []);
});
test("failed comparison waits for both bounded reads before cleaning its temporary directory", async () => {
  const f = fixture();
  let finished = false;
  const original = f.service.files.downloadFileToPath;
  f.service.files.downloadFileToPath = async (uuid, file, limit) => {
    if (uuid === "public") throw Error("missing");
    await new Promise(resolve => setTimeout(resolve, 20));
    const size = await original(uuid, file, limit);
    finished = true;
    return size;
  };
  await assert.rejects(f.service.download(f.user, 10, 20, "communication.h"), NotFoundException);
  assert(finished);
  cleanReads(f);
});

test("public header aliases use the same underscore and no-parent-segment contract as AI publication", async () => {
  const f = fixture();
  f.info.extraSourceFiles.cpp = { "_public.h": "hidden-header.h", "bad..h": "hidden-header.h" };
  f.publicFiles[0].filename = "_public.h";
  f.publicFiles.push({ filename: "bad..h", uuid: "public", size: 13 });
  const result = await f.service.problem(f.user, 10, 20, "en_US");
  assert.deepEqual(
    result.problem.attachments.map(file => file.filename),
    ["_public.h"]
  );
  assert.equal((await f.service.download(f.user, 10, 20, "_public.h")).url, "signed:public");
  await assert.rejects(f.service.download(f.user, 10, 20, "bad..h"), NotFoundException);
  cleanReads(f);
});

test("an explicit DownloadProblemAttachments deny also blocks explicit contest attachments", async () => {
  const f = fixture();
  f.row.attachments = [{ filename: "communication.h", uuid: "contest-explicit", size: 5 }];
  f.user.denied = [UserPrivilegeType.DownloadProblemAttachments];
  await assert.rejects(f.service.download(f.user, 10, 20, "communication.h"), ForbiddenException);
  assert.deepEqual(f.signed, []);
});
