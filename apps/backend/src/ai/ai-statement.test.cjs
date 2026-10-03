/* Pure service regression tests; no database, runner, real credentials or external API. */
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
const { AiService } = require("./ai.service.ts");
const { resolveAiFileIo } = require("./ai-file-io.ts");
const { ProblemLocalizedContentDto } = require("../problem/dto/problem-statement.dto.ts");
const {
  UpdateProblemRequestUpdatingLocalizedContentDto
} = require("../problem/dto/update-problem-statement-request.dto.ts");
const { plainToInstance } = require("class-transformer");
const { validateSync } = require("class-validator");
const text = (sectionTitle = "Description", value = "Task") => ({ sectionTitle, type: "Text", text: value });
const localized = (locale = "en_US", contentSections = [text()]) => ({ locale, title: "Fixture", contentSections });
const sample = { inputData: "1\n", outputData: "1\n" };
const service = () => new AiService({}, {}, {}, {}, {}, {}, {});

test("normalization keeps section order and existing labels, deduplicates references and fills both languages", () => {
  const first = { sectionTitle: "Original sample label", type: "Sample", sampleId: 1, text: "" };
  const input = {
    localizedContents: [localized("en_US", [text("Before"), first, text("After"), { ...first }]), localized("zh_CN")],
    samples: [sample, sample, sample]
  };
  const saved = JSON.stringify(input),
    svc = service(),
    result = svc.normalizeStatement(input);
  assert.equal(JSON.stringify(input), saved, "input snapshot must remain unchanged");
  assert.deepEqual(
    result.localizedContents[0].contentSections.map(x => x.sectionTitle),
    ["Before", "Original sample label", "After", "Sample 1", "Sample 3"]
  );
  for (const content of result.localizedContents)
    assert.deepEqual(
      content.contentSections
        .filter(x => x.type === "Sample")
        .map(x => x.sampleId)
        .sort(),
      [0, 1, 2]
    );
  assert.equal(result.localizedContents[1].contentSections.at(-1).sectionTitle, "样例 3");
  assert.deepEqual(svc.normalizeStatement(result), result, "normalization must be idempotent");
});

test("100 samples plus 20 text sections remain valid for both normal editor DTOs", () => {
  const svc = service();
  const result = svc.normalizeStatement({
    localizedContents: [
      localized(
        "zh_CN",
        Array.from({ length: 20 }, (_, i) => text("Section " + i))
      )
    ],
    samples: Array(100).fill(sample)
  });
  assert.equal(result.localizedContents[0].contentSections.length, 120);
  assert.doesNotThrow(() => svc.validateStatement(result));
  for (const dto of [ProblemLocalizedContentDto, UpdateProblemRequestUpdatingLocalizedContentDto]) {
    assert.deepEqual(validateSync(plainToInstance(dto, result.localizedContents[0])), []);
    assert(validateSync(plainToInstance(dto, localized("en_US", Array(21).fill(text())))).length > 0);
    const excessiveSamples = Array(101).fill({ sectionTitle: "Sample", type: "Sample", sampleId: 0 });
    assert(validateSync(plainToInstance(dto, localized("en_US", excessiveSamples))).length > 0);
  }
  assert.throws(
    () => svc.normalizeStatement({ localizedContents: [localized()], samples: Array(101).fill(sample) }),
    /INVALID_AI_SAMPLE/
  );
  assert.throws(
    () => svc.normalizeStatement({ localizedContents: [localized("en_US", Array(21).fill(text()))], samples: [] }),
    /INVALID_AI_STATEMENT/
  );
});

test("normalization never silently drops illegal sample IDs", () => {
  for (const sampleId of [-1, 1, 0.5, "0", null, undefined])
    assert.throws(
      () =>
        service().normalizeStatement({
          localizedContents: [localized("en_US", [text(), { sectionTitle: "Sample", type: "Sample", sampleId }])],
          samples: [sample]
        }),
      /INVALID_AI_SAMPLE/
    );
});

test("translate repairs already bilingual statements without another model call and preserves existing tags", async () => {
  let saved,
    writes = 0;
  const svc = new AiService(
    {},
    {},
    {},
    {},
    {
      getProblemTagsByProblem: async () => [{ id: 7 }],
      updateProblemStatement: async (_problem, value) => {
        saved = value;
        writes++;
      }
    },
    {},
    {}
  );
  svc.model = async () => {
    throw new Error("bilingual statements do not need a translation request");
  };
  svc.assertSnapshot = async () => ({ id: 1 });
  const snapshot = { statements: [localized(), localized("zh_CN")], samples: [sample] };
  await svc.edit({}, { id: 1 }, { id: 9 }, {}, snapshot, "translate");
  assert.equal(writes, 1);
  assert.deepEqual(saved.problemTagIds, [7]);
  assert(saved.localizedContents.every(x => x.contentSections.at(-1).sampleId === 0));
  await svc.edit({}, { id: 1 }, { id: 9 }, {}, { statements: saved.localizedContents, samples: [sample] }, "translate");
  assert.equal(writes, 1, "repeating normalization must not cause another edit");
});

test("import persists normalized sample references before its durable checkpoint", async () => {
  let created, checkpoint;
  const svc = new AiService(
    {},
    {},
    {},
    { userHasPrivilege: async () => true },
    {
      userHasCreateProblemPermission: async () => true,
      createProblem: async (_user, _type, value) => {
        created = value;
        return { id: 20 };
      }
    },
    {},
    {}
  );
  svc.assertJob = async () => ({ id: 1 });
  svc.checkpoint = async job => {
    checkpoint = job.state.importStatement;
  };
  const job = {
    state: { importStatement: { localizedContents: [localized()], samples: [sample] } },
    input: {},
    progress: 0
  };
  await svc.importProblem(job, { id: 1 }, {});
  const sections = created.localizedContents[0].contentSections;
  assert.equal(sections.find(x => x.type === "Sample").sampleId, 0);
  assert.equal(sections.at(-1).sectionTitle, "Limits And Hints");
  assert.deepEqual(checkpoint.localizedContents, created.localizedContents);
});

const named = (input = "homework.in", output = "homework.out") => [
  localized("en_US", [
    text("Input", `Input file: \`${input}\`\nRead N scores.`),
    text("Output", `Output file: \`${output}\`\nPrint K.`)
  ])
];
test("file I/O uses explicit bilingual declarations, including underscores, and configured filenames take priority", () => {
  assert.deepEqual(resolveAiFileIo({}, named()), { inputFilename: "homework.in", outputFilename: "homework.out" });
  assert.deepEqual(
    resolveAiFileIo({}, [localized("zh_CN", [text("输入文件", "data_in.txt"), text("输出文件", "data_out.txt")])]),
    { inputFilename: "data_in.txt", outputFilename: "data_out.txt" }
  );
  assert.deepEqual(
    resolveAiFileIo({}, [
      localized("en_US", [
        text("INPUT FORMAT (file in.dat)", "N integers"),
        text("OUTPUT FORMAT (file out.dat)", "Answer")
      ])
    ]),
    { inputFilename: "in.dat", outputFilename: "out.dat" }
  );
  const configured = { inputFilename: "configured.in", outputFilename: "configured.out" };
  assert.deepEqual(
    resolveAiFileIo({ fileIo: configured }, named(), { inputFilename: "guessed.in", outputFilename: "guessed.out" }),
    configured
  );
});

test("file I/O cannot be guessed from the original site or arbitrary filenames and honors explicit standard I/O", () => {
  assert.equal(
    resolveAiFileIo({}, [
      localized("en_US", [
        text("Description", "USACO homework.in homework.out https://usaco.org/homework.in"),
        text("Input", "N integers"),
        text("Output", "The answer")
      ])
    ]),
    null
  );
  assert.throws(
    () => resolveAiFileIo({}, [localized()], { inputFilename: "homework.in", outputFilename: "homework.out" }),
    /UNVERIFIED_AI_FILE_IO/
  );
  assert.equal(
    resolveAiFileIo({}, [...named(), localized("zh_CN", [text("适配说明", "本题使用标准输入和标准输出。")])]),
    null
  );
  assert.equal(
    resolveAiFileIo({}, [
      localized("en_US", [text("Input: N integers", "Then the array"), text("Output: answer", "The answer")])
    ]),
    null
  );
});

test("file I/O rejects invalid paths, ambiguity, same-file truncation and guessed names", () => {
  for (const inputFilename of ["../input", "bad/input", "", "a\n.in", "x".repeat(256)])
    assert.throws(
      () => resolveAiFileIo({ fileIo: { inputFilename, outputFilename: "out" } }, []),
      /INVALID_AI_FILE_IO/
    );
  assert.throws(
    () => resolveAiFileIo({ fileIo: { inputFilename: "same", outputFilename: "same" } }, []),
    /INVALID_AI_FILE_IO/
  );
  assert.throws(() => resolveAiFileIo({}, [...named(), ...named("different.in")]), /INVALID_AI_FILE_IO/);
  assert.throws(
    () => resolveAiFileIo({}, named(), { inputFilename: "guess.in", outputFilename: "homework.out" }),
    /UNVERIFIED_AI_FILE_IO/
  );
});

test("case-insensitive statements or explicit plan flag force SPJ before the runner", async () => {
  for (const statement of ["Letter case is ignored.", "Output is case-insensitive.", "答案不区分大小写。", ""]) {
    const svc = new AiService(
      {},
      {},
      {},
      { userHasPrivilege: async () => true, permissionDecision: async () => true },
      {},
      {},
      {}
    );
    svc.checkpoint = async () => {};
    let payload;
    svc.runSandbox = async (_job, value) => {
      payload = value;
      throw new Error("MOCK_STOP");
    };
    const job = {
      id: "unused",
      input: { count: 5 },
      state: {
        plan: { subtasks: [{ id: 1, points: 100 }], needsSpj: false, caseSensitive: !!statement },
        makeCode: "int main(){}",
        stdCode: "int main(){}",
        validatorCode: "int main(){}",
        checkerCode: "int main(){}"
      }
    };
    const snapshot = { statements: [localized("en_US", [text("Output", statement)])], judgeInfo: {}, samples: [] };
    job.state.testdataSnapshotHash = svc.testdataFingerprint(snapshot);
    await assert.rejects(svc.testdata(job, { id: 1 }, { type: "Traditional" }, {}, snapshot, 0, 100), /MOCK_STOP/);
    assert.equal(job.state.plan.needsSpj, true);
    assert.equal(job.state.plan.caseSensitive, false);
    assert.equal(payload.checkerCode, "int main(){}");
  }
});

test("invalid I/O and malformed plan retries clear generated code without duplicating committed tutorial", () => {
  const state = {
    completed: ["tutorial"],
    discussionId: 8,
    plan: {},
    makeCode: "make",
    stdCode: "std",
    validatorCode: "validator",
    checkerCode: "checker"
  };
  for (const error of ["INVALID_AI_FILE_IO", "UNVERIFIED_AI_FILE_IO", "INVALID_TEST_PLAN"]) {
    const next = service().retryState({ state, error });
    for (const name of ["plan", "makeCode", "stdCode", "validatorCode", "checkerCode"])
      assert.equal(next[name], undefined);
    assert.equal(next.discussionId, 8);
    assert.deepEqual(next.completed, ["tutorial"]);
  }
});

test("file-I/O discovery never confuses freopen arguments with standard-I/O requirements", () => {
  assert.deepEqual(
    resolveAiFileIo({}, [
      ...named(),
      localized("zh_CN", [
        text("代码示意", 'freopen("homework.in", "r", stdin); freopen("homework.out", "w", stdout);')
      ])
    ]),
    { inputFilename: "homework.in", outputFilename: "homework.out" }
  );
  assert.throws(
    () => resolveAiFileIo({}, [localized("en_US", [text("Input file", "data.in")])]),
    /UNVERIFIED_AI_FILE_IO/
  );
});

test("named I/O from an old durable plan is normalized before sample execution without changing the generation harness", async () => {
  const svc = new AiService(
    {},
    {},
    {},
    { userHasPrivilege: async () => true, permissionDecision: async () => true },
    {},
    {},
    {}
  );
  svc.checkpoint = async () => {};
  const job = {
    id: "unused",
    input: { count: 5 },
    state: {
      plan: { subtasks: [{ id: 1, points: 100 }], needsSpj: false },
      makeCode: "int main(){}",
      stdCode: "int main(){}",
      validatorCode: "int main(){}"
    }
  };
  const snapshot = { statements: named(), samples: [sample], judgeInfo: {} };
  job.state.testdataSnapshotHash = svc.testdataFingerprint(snapshot);
  let payload;
  svc.runSandbox = async (_job, value) => {
    payload = value;
    throw new Error("MOCK_STOP");
  };
  await assert.rejects(svc.testdata(job, { id: 1 }, { type: "Traditional" }, {}, snapshot, 0, 100), /MOCK_STOP/);
  assert.deepEqual(job.state.plan.fileIo, { inputFilename: "homework.in", outputFilename: "homework.out" });
  assert.deepEqual(payload.samples, [{ input: sample.inputData, output: sample.outputData }]);
  assert.equal(payload.fileIo, undefined, "make/std/validator harness still uses isolated stdin/stdout");
  assert.equal(job.state.plan.caseSensitive, true, "old plans retain a compatible default");
  job.state.plan.caseSensitive = "false";
  await assert.rejects(
    svc.testdata(job, { id: 1 }, { type: "Traditional" }, {}, snapshot, 0, 100),
    /INVALID_TEST_PLAN/
  );
});

test("tutorial instructions use effective judging I/O and reject implicit machine-integer bounds", async () => {
  let prompt;
  const svc = new AiService(
    {},
    {},
    {},
    {},
    {},
    {
      userHasCreateDiscussionPermission: async () => true,
      createDiscussion: async () => ({ id: 30 })
    },
    {}
  );
  svc.assertSnapshot = async () => ({ id: 1 });
  svc.checkpoint = async () => {};
  svc.model = async (_config, text) => {
    prompt = text;
    return { zh_CN: "题解", en_US: "Tutorial" };
  };
  const configured = { inputFilename: "configured.in", outputFilename: "configured.out" };
  await svc.edit(
    { state: {} },
    { id: 1 },
    { id: 1 },
    {},
    { statements: named(), judgeInfo: { fileIo: configured }, samples: [] },
    "tutorial"
  );
  assert(prompt.includes(JSON.stringify(configured)));
  assert.match(prompt, /Escape code exactly once for JSON serialization/);
  assert.match(prompt, /prefer std::endl/);
  assert.match(prompt, /Do not assume an int or int64 bound/);
  assert.match(prompt, /saturation at a proved task-relevant cutoff/);
  await svc.edit(
    { state: {} },
    { id: 1 },
    { id: 1 },
    {},
    { statements: [localized()], judgeInfo: {}, samples: [] },
    "tutorial"
  );
  assert.match(prompt, /effective judging I\/O is null/);
});

test("testdata checkpoints each current model stage before dispatch and persists its output afterward", async () => {
  const http = require("node:http");
  const job = { id: "stage-fixture", input: { count: 5 }, state: {}, step: "testdata", progress: 10 };
  const fields = { plan: "plan", make: "makeCode", checker: "checkerCode", validator: "validatorCode", std: "stdCode" };
  const fractions = { plan: 0.1, make: 0.2, std: 0.44, checker: 0.4, validator: 0.43 };
  const requests = [],
    checkpoints = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const prompt = JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content;
    const stage = prompt.startsWith("Design a test-data plan")
      ? "plan"
      : prompt.match(/^Generate ONLY (make|std|checker|validator)\.cpp/)?.[1];
    requests.push({ stage, step: job.step, progress: job.progress, artifactExists: !!job.state[fields[stage]] });
    const output =
      stage === "plan"
        ? JSON.stringify({
            subtasks: [{ id: 1, points: 100, constraints: "1<=n<=10", coverage: ["minimum", "maximum"] }],
            needsSpj: true,
            spjReason: "Multiple outputs",
            caseSensitive: true,
            timeLimitMs: 1000,
            memoryLimitMiB: 128
          })
        : "int main(){return 0;}";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: output } }] }));
  });
  const oldHosts = process.env.HYHOJ_AI_PRIVATE_HOSTS;
  process.env.HYHOJ_AI_PRIVATE_HOSTS = "127.0.0.1";
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const svc = new AiService(
      {},
      {},
      {},
      { userHasPrivilege: async () => true, permissionDecision: async () => true },
      {},
      {},
      {}
    );
    svc.checkpoint = async (current, step, progress) => {
      current.step = step;
      current.progress = progress;
      const stage = step.split(".")[1];
      checkpoints.push({ stage, artifactExists: !!current.state[fields[stage]] });
    };
    svc.runSandbox = async () => {
      throw new Error("STOP_BEFORE_SANDBOX");
    };
    const config = {
      llm: {
        type: "chat",
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        apiKey: "stage-fixture-only",
        model: "fixture",
        maxTokens: 4096
      }
    };
    await assert.rejects(
      svc.testdata(
        job,
        { id: 1 },
        { type: "Traditional" },
        config,
        { statements: [localized()], samples: [], judgeInfo: {} },
        10,
        60
      ),
      /STOP_BEFORE_SANDBOX/
    );
    assert.deepEqual(
      requests.map(x => x.stage),
      Object.keys(fields)
    );
    for (const request of requests) {
      assert.equal(
        request.step,
        `testdata.${request.stage}`,
        "stage must already be visible when the HTTP request arrives"
      );
      assert.equal(request.progress, 10 + 60 * fractions[request.stage]);
      assert.equal(request.artifactExists, false, "stage starts before its model output exists");
      assert.deepEqual(
        checkpoints.filter(x => x.stage === request.stage).map(x => x.artifactExists),
        [false, true],
        "keep the post-request checkpoint for durable output"
      );
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (oldHosts === undefined) delete process.env.HYHOJ_AI_PRIVATE_HOSTS;
    else process.env.HYHOJ_AI_PRIVATE_HOSTS = oldHosts;
  }
});

test("cached archive-derived I/O cannot override the current standard-input judging contract", async () => {
  const svc = new AiService({}, {}, {}, { userHasPrivilege: async () => true, permissionDecision: async () => true }, {}, {}, {});
  svc.checkpoint = async () => {};
  const snapshot = { statements: [localized("en_US", [text("Input", "The first line of the input file contains n."), text("Output", "The output file contains the answer.")])], samples: [sample], judgeInfo: { fileIo: null } };
  const job = { id: "archive-io", input: { count: 5 }, state: {
    plan: { subtasks: [{ id: 1, points: 100 }], needsSpj: false, fileIo: { inputFilename: "sample.in", outputFilename: "sample.out" } },
    makeCode: "int main(){}", stdCode: "int main(){}", validatorCode: "int main(){}"
  } };
  job.state.testdataSnapshotHash = svc.testdataFingerprint(snapshot);
  svc.runSandbox = async () => { throw Error("STOP_BEFORE_SANDBOX"); };
  await assert.rejects(svc.testdata(job, { id: 1 }, { type: "Traditional" }, {}, snapshot, 0, 100), /STOP_BEFORE_SANDBOX/);
  assert.equal(job.state.plan.fileIo, null);
});

test("a fresh model plan cannot replace manually configured named I/O with attachment basenames", async () => {
  const svc = new AiService({}, {}, {}, { userHasPrivilege: async () => true, permissionDecision: async () => true }, {}, {}, {});
  svc.checkpoint = async () => {};
  const actual = { inputFilename: "a.in", outputFilename: "a.out" };
  const snapshot = { statements: [localized()], samples: [], judgeInfo: { fileIo: actual } };
  const job = { id: "fresh-archive-io", input: { count: 5 }, state: {} };
  svc.model = async (_config, prompt) => {
    assert(prompt.startsWith("Design a test-data plan"));
    assert(prompt.includes(JSON.stringify(actual)));
    return { subtasks: [{ id: 1, points: 100, constraints: "1<=n<=10", coverage: ["maximum"] }], needsSpj: false,
      timeLimitMs: 1000, memoryLimitMiB: 128, fileIo: { inputFilename: "sample.in", outputFilename: "sample.out" } };
  };
  svc.checkpoint = async (_job, step) => { if (step === "testdata.make") throw Error("STOP_AFTER_PLAN"); };
  await assert.rejects(svc.testdata(job, { id: 1 }, { type: "Traditional" }, {}, snapshot, 0, 100), /STOP_AFTER_PLAN/);
  assert.deepEqual(job.state.plan.fileIo, actual);
});
