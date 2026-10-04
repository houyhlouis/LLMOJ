/* Run: node --test apps/backend/src/ai/ai-provider.test.cjs. Uses a loopback mock only. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
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
const {
  generateText,
  listModels,
  searchWeb,
  validateBaseUrl,
  providerRequest,
  parseProviderResponse,
  parseModelJson
} = require("./ai-provider.ts");
const { AiService } = require("./ai.service.ts");
const { AiError } = require("./ai.types.ts");
const { validateLlmConfiguration, DEEPSEEK_MAX_OUTPUT_TOKENS } = require("./ai-validation.ts");
const { LlmConfigurationDto } = require("./ai.dto.ts");
const { plainToInstance } = require("class-transformer");
const { validateSync } = require("class-validator");
let server,
  baseUrl,
  mode = "",
  requests = [];
before(async () => {
  process.env.HYHOJ_AI_PRIVATE_HOSTS = "127.0.0.1";
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ path: req.url, headers: req.headers, body });
    res.setHeader("Content-Type", "application/json");
    if (mode === "http-error") {
      res.statusCode = 401;
      res.end(JSON.stringify({ secret: "must-never-leak" }));
      return;
    }
    if (req.url.startsWith("/models")) {
      res.end(
        JSON.stringify({
          data: [{ id: req.url.includes("after_id") ? "model-b" : "model-a" }],
          has_more: mode === "paged" && !req.url.includes("after_id"),
          last_id: "model-a"
        })
      );
      return;
    }
    if (req.url === "/chat/completions") {
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: mode === "truncate" ? "length" : "stop",
              message: { content: mode === "validator-code" ? "int main(){return 0;}" : "chat-ok" }
            }
          ]
        })
      );
      return;
    }
    if (req.url === "/responses") {
      if (mode === "responses-sse" || mode === "responses-incomplete" || mode === "responses-failed") {
        const status =
          mode === "responses-incomplete" ? "incomplete" : mode === "responses-failed" ? "failed" : "completed";
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          ': keep-alive\r\n\r\nevent: response.created\r\ndata: {"type":"response.created","response":{"status":"in_progress"}}\r\n\r\n' +
            "event: response." +
            status +
            "\r\ndata: " +
            JSON.stringify({
              type: "response." + status,
              response: {
                status,
                output: [{ content: [{ type: "output_text", text: "responses-ok" }] }],
                ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
                ...(status === "failed" ? { error: { message: "must-never-leak" } } : {})
              }
            }) +
            "\r\n\r\n"
        );
        return;
      }
      if (mode === "blank-keepalive") res.write("\r\n \n\n");
      res.end(
        JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: "responses-ok" }] }] })
      );
      return;
    }
    if (req.url === "/messages") {
      res.end(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "anthropic-ok" }
          ]
        })
      );
      return;
    }
    if (req.url === "/search") {
      res.end(JSON.stringify({ results: [{ title: "Result", url: "https://example.org/problem", content: "text" }] }));
      return;
    }
    if (req.url === "/mcp") {
      if (body.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : body.method === "tools/list"
          ? { tools: [{ name: "tavily-search", inputSchema: { properties: { query: {}, max_results: {} } } }] }
          : { content: [{ type: "text", text: "search-result" }] };
      res.setHeader("Mcp-Session-Id", "test-session");
      if (body.method === "tools/call") {
        res.setHeader("Content-Type", "text/event-stream");
        res.end("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) + "\n\n");
      } else res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  delete process.env.HYHOJ_AI_PRIVATE_HOSTS;
  await new Promise(resolve => server.close(resolve));
});
const config = type => ({
  type,
  baseUrl,
  apiKey: "test-secret",
  model: "test-model",
  maxTokens: 4096,
  reasoning: "high"
});
test("chat completions: headers, reasoning, vision and output", async () => {
  mode = "";
  const text = await generateText(config("chat"), "system", "prompt", "data:image/png;base64,YQ==");
  assert.equal(text, "chat-ok");
  const r = requests.at(-1);
  assert.equal(r.headers.authorization, "Bearer test-secret");
  assert.equal(r.body.reasoning_effort, "high");
  assert.equal(r.body.messages[1].content[1].image_url.url, "data:image/png;base64,YQ==");
});
test("responses: no server storage, typed image content and reasoning", async () => {
  assert.equal(
    await generateText(config("responses"), "system", "prompt", "data:image/png;base64,YQ=="),
    "responses-ok"
  );
  const b = requests.at(-1).body;
  assert.equal(b.store, false);
  assert.equal(b.reasoning.effort, "high");
  assert.equal(b.input[0].content[1].type, "input_image");
});
test("Anthropic: separate system, x-api-key and adaptive/budget reasoning", async () => {
  assert.equal(
    await generateText(config("anthropic"), "system", "prompt", "data:image/png;base64,YQ=="),
    "anthropic-ok"
  );
  let r = requests.at(-1);
  assert.equal(r.headers["x-api-key"], "test-secret");
  assert.equal(r.body.system, "system");
  assert.equal(r.body.thinking.type, "adaptive");
  await generateText({ ...config("anthropic"), reasoning: "2048" }, "system", "prompt");
  r = requests.at(-1);
  assert.equal(r.body.thinking.budget_tokens, 2048);
  await assert.rejects(
    generateText({ ...config("anthropic"), reasoning: "4000", maxTokens: 3000 }, "", ""),
    /INVALID_REASONING_BUDGET/
  );
});
test("models and Anthropic pagination", async () => {
  mode = "paged";
  assert.deepEqual(await listModels(config("anthropic")), ["model-a", "model-b"]);
  mode = "";
  assert.deepEqual(await listModels(config("chat")), ["model-a"]);
});
test("Tavily and initialized MCP sessions including SSE", async () => {
  assert.match(await searchWeb({ type: "tavily", baseUrl, apiKey: "search-secret" }, "query"), /example.org/);
  assert.equal(requests.at(-1).headers.authorization, "Bearer search-secret");
  assert.match(
    await searchWeb({ type: "mcp", baseUrl: `${baseUrl}/mcp`, apiKey: "search-secret" }, "query"),
    /search-result/
  );
  const r = requests.at(-1);
  assert.equal(r.body.method, "tools/call");
  assert.equal(r.headers["mcp-session-id"], "test-session");
  assert.equal(r.body.params.arguments.query, "query");
});
test("errors never expose upstream response or secrets", async () => {
  mode = "http-error";
  await assert.rejects(
    generateText(config("chat"), "", ""),
    error => /PROVIDER_HTTP_ERROR: 401/.test(error.message) && !/must-never-leak|test-secret/.test(error.message)
  );
  mode = "truncate";
  await assert.rejects(generateText(config("chat"), "", ""), /MODEL_OUTPUT_TRUNCATED/);
  mode = "";
  await assert.rejects(generateText({ ...config("chat"), apiKey: "" }, "", ""), /LLM_NOT_CONFIGURED/);
  await assert.rejects(searchWeb({ type: "tavily", baseUrl, apiKey: "" }, ""), /SEARCH_NOT_CONFIGURED/);
});
test("private providers are permitted while credential URL validation remains enforced", async () => {
  for (const url of [
    "file:///etc/passwd",
    "https://u:p@example.org",
    "https://example.org?key=secret",
    "https://example.org#x"
  ])
    assert.throws(() => validateBaseUrl(url), /INVALID_BASE_URL/);
  delete process.env.HYHOJ_AI_PRIVATE_HOSTS;
  assert.deepEqual((await providerRequest(`${baseUrl}/models`, {})).data.data, [{ id: "model-a" }]);
  process.env.HYHOJ_AI_PRIVATE_HOSTS = "127.0.0.1";
});
test("strict JSON output accepts fences but rejects surrounding text", () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseModelJson('answer {"a":1}'), /INVALID_MODEL_JSON/);
});
test("configuration AES-GCM and response key redaction, owner-scoped storage", async () => {
  const stored = new Map();
  const repo = {
    findOneBy: async ({ userId }) => stored.get(userId),
    save: async value => stored.set(value.userId, value)
  };
  const svc = new AiService({}, repo, {}, { userHasPrivilege: async user => !!user }, {}, {}, {});
  svc.key = require("node:crypto").randomBytes(32);
  const user = { id: 1 };
  const saved = await svc.saveConfiguration(user, {
    llm: config("chat"),
    search: { type: "tavily", baseUrl, apiKey: "search-secret" },
    autoOnSave: true
  });
  assert.equal(saved.llm.hasKey, true);
  assert.equal(saved.llm.apiKey, undefined);
  assert.equal(saved.search.apiKey, undefined);
  assert.equal(JSON.stringify(saved).includes("test-secret"), false);
  assert.equal(stored.get(1).encrypted.includes("test-secret"), false);
  assert.equal(svc.decrypt(stored.get(1).encrypted).llm.apiKey, "test-secret");
  assert.equal((await svc.getConfiguration({ id: 2 })).llm.hasKey, false);
  await svc.saveConfiguration(user, {
    llm: { ...config("chat"), apiKey: "" },
    search: { type: "tavily", baseUrl },
    autoOnSave: true
  });
  assert.equal(svc.decrypt(stored.get(1).encrypted).llm.apiKey, "test-secret");
  await svc.saveConfiguration(user, {
    llm: config("chat"),
    search: { type: "tavily", baseUrl },
    autoOnSave: true,
    clearLlmKey: true
  });
  assert.equal((await svc.getConfiguration(user)).llm.hasKey, false);
  await assert.rejects(svc.getConfiguration(null), /PERMISSION_DENIED/);
});
test("jobs expose only the owner and no persisted private prompts or source code", async () => {
  const calls = [];
  const repo = {
    find: async query => {
      calls.push(query);
      return [
        {
          id: "job",
          ownerId: 7,
          status: "running",
          problemId: 12,
          action: "all",
          state: { completed: [], makeCode: "PRIVATE SOURCE", importStatement: { secret: "PRIVATE IMAGE" } },
          input: { image: "PRIVATE IMAGE" }
        }
      ];
    }
  };
  const svc = new AiService({}, {}, repo, {}, {}, {}, {});
  const result = await svc.listJobs({ id: 7 }, 12);
  assert.deepEqual(calls[0].where, { ownerId: 7, problemId: 12 });
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  await assert.rejects(svc.listJobs(null), /PERMISSION_DENIED/);
});
test("restarted pipeline skips committed steps and reruns only pending actions", async () => {
  const edits = [];
  const svc = new AiService({}, {}, {}, {}, {}, {}, {});
  svc.config = async () => ({ llm: {}, search: {} });
  svc.assertJob = async () => ({ id: 1 });
  svc.editable = async () => ({ id: 8 });
  svc.snapshot = async () => ({});
  svc.checkpoint = async () => {};
  svc.edit = async (_job, _user, _problem, _config, _snapshot, action) => edits.push(action);
  svc.testdata = async () => edits.push("testdata");
  const job = { ownerId: 1, problemId: 8, action: "all", state: { completed: ["source", "translate"] } };
  await svc.execute(job);
  assert.deepEqual(edits, ["tags", "difficulty", "tutorial", "testdata"]);
  await svc.execute(job);
  assert.equal(edits.length, 4);
});
test("cancelled jobs and revoked privileges stop before mutation", async () => {
  const svc = new AiService(
    { getRepository: () => ({ findOneBy: async () => ({ id: 1 }) }) },
    {},
    { findOneBy: async () => ({ status: "cancelled" }) },
    { userHasPrivilege: async () => false },
    {},
    {},
    {}
  );
  await assert.rejects(svc.assertJob({ id: "job", ownerId: 1 }), /JOB_CANCELLED/);
  svc.jobs.findOneBy = async () => ({ status: "running" });
  await assert.rejects(svc.assertJob({ id: "job", ownerId: 1 }), /PERMISSION_DENIED/);
});
test("completed tutorial checkpoint makes a retry side-effect free", async () => {
  const svc = new AiService(
    {},
    {},
    {},
    {},
    {},
    {
      createDiscussion: () => {
        throw new Error("should not create");
      }
    },
    {}
  );
  await svc.edit({ state: { discussionId: 91, discussionIds: { zh_CN: 91, en_US: 92 } } }, {}, {}, {}, {}, "tutorial");
});
test("stale problem snapshot refuses AI overwrite", async () => {
  const svc = new AiService({}, {}, {}, {}, {}, {}, {});
  svc.assertJob = async () => ({ id: 1 });
  svc.editable = async () => ({ id: 8 });
  svc.snapshot = async () => ({ statements: "manually changed" });
  await assert.rejects(svc.assertSnapshot({ problemId: 8 }, { statements: "old" }), /PROBLEM_CHANGED_DURING_AI/);
});
test("hostname DNS lookup supports Node autoSelectFamily", async () => {
  process.env.HYHOJ_AI_PRIVATE_HOSTS = "127.0.0.1,localhost";
  const address = baseUrl.replace("127.0.0.1", "localhost");
  assert.deepEqual(await listModels({ ...config("chat"), baseUrl: address }), ["model-a"]);
  process.env.HYHOJ_AI_PRIVATE_HOSTS = "127.0.0.1";
});

test("testdata publishes a uniquely named SPJ before switching and preserves old fixed filenames on failure", async () => {
  const os = require("node:os"),
    path = require("node:path"),
    crypto = require("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyhoj-ai-publish-test-"));
  const oldDirectory = process.env.HYHOJ_AI_GENERATED_DIR;
  process.env.HYHOJ_AI_GENERATED_DIR = root;
  try {
    for (const failConfiguration of [false, true]) {
      const id = crypto.randomUUID(),
        directory = path.join(root, id),
        names = [];
      fs.mkdirSync(directory);
      for (let i = 1; i <= 5; i++)
        for (const ext of ["in", "out"]) {
          const name = `${i}.${ext}`;
          fs.writeFileSync(path.join(directory, name), "1\n");
          names.push(name);
        }
      const user = { id: 1 },
        events = [];
      let cleaned = false,
        judgeInfo;
      const svc = new AiService(
        {},
        {},
        {},
        { userHasPrivilege: async () => true, permissionDecision: async () => true },
        {
          updateProblemJudgeInfo: async (_problem, value) => {
            judgeInfo = value;
            events.push("switch-config");
            return failConfiguration ? ["FIXTURE_REJECT"] : null;
          }
        },
        {},
        {}
      );
      svc.readExistingAiHelpers = async () => ({ extraSourceFiles: { "helper.h": "// existing public header" } });
      svc.assertJob = async () => user;
      svc.assertSnapshot = async () => user;
      svc.checkpoint = async () => {};
      svc.runSandbox = async (_job, payload) => {
        assert.equal(payload.validatorCode, "int main(){return 0;}");
        return {
          directory,
          files: names,
          validation: { samplesPassed: 0, inputsPassed: 5, sampleInputsPassed: 0 }
        };
      };
      svc.cleanupSandbox = async () => {
        cleaned = true;
        fs.rmSync(directory, { recursive: true, force: true });
      };
      svc.putFile = async (_problem, name) => events.push(name);
      const job = {
        id,
        input: { count: 5 },
        progress: 0,
        state: {
          plan: { subtasks: [{ id: 1, points: 100 }], needsSpj: true, timeLimitMs: 2000, memoryLimitMiB: 128 },
          makeCode: "int main(){}",
          stdCode: "int main(){}",
          checkerCode: "int main(){}",
          validatorCode: "int main(){return 0;}"
        }
      };
      const snapshot = {
        samples: [],
        judgeInfo: {
          timeLimit: 1000,
          memoryLimit: 256,
          fileIo: { inputFilename: "configured.in", outputFilename: "configured.out" },
          checker: { type: "custom", filename: "checker.cpp" },
          extraSourceFiles: { cpp: { "helper.h": "helper.h" } }
        }
      };
      job.state.testdataSnapshotHash = svc.testdataFingerprint(snapshot);
      const execution = svc.testdata(job, user, { id: 1, type: "Traditional" }, {}, snapshot, 0, 100);
      if (failConfiguration) await assert.rejects(execution, /INVALID_GENERATED_JUDGE_INFO/);
      else await execution;
      const uniqueChecker = judgeInfo.checker.filename;
      assert.match(uniqueChecker, /^ai-managed-[0-9a-f-]{36}-checker\.cpp$/);
      assert(events.indexOf(uniqueChecker) < events.indexOf("switch-config"));
      assert(!events.includes("checker.cpp"));
      assert.equal(cleaned, true);
      for (const name of ["make.cpp", "std.cpp", "validator.cpp", "data.yaml"])
        assert(events.indexOf(name) < events.indexOf("switch-config"));
      assert.equal(judgeInfo.extraSourceFiles.cpp["helper.h"], "helper.h");
      assert.deepEqual(judgeInfo.fileIo, snapshot.judgeInfo.fileIo);
    }
  } finally {
    if (oldDirectory === undefined) delete process.env.HYHOJ_AI_GENERATED_DIR;
    else process.env.HYHOJ_AI_GENERATED_DIR = oldDirectory;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("testdata requires proof for every generated input and sample before publishing", async () => {
  const os = require("node:os"),
    path = require("node:path"),
    crypto = require("node:crypto");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyhoj-ai-input-validation-"));
  const oldDirectory = process.env.HYHOJ_AI_GENERATED_DIR;
  process.env.HYHOJ_AI_GENERATED_DIR = root;
  const expected = { samplesPassed: 1, inputsPassed: 5, sampleInputsPassed: 1 };
  const responses = [
    undefined,
    { samplesPassed: 1 },
    { ...expected, inputsPassed: undefined },
    { ...expected, inputsPassed: 4 },
    { ...expected, inputsPassed: 6 },
    { ...expected, inputsPassed: "5" },
    { ...expected, sampleInputsPassed: undefined },
    { ...expected, sampleInputsPassed: 0 },
    { ...expected, sampleInputsPassed: 2 },
    { ...expected, sampleInputsPassed: "1" },
    { ...expected, samplesPassed: 0 },
    expected
  ];
  try {
    for (const validation of responses) {
      const id = crypto.randomUUID(),
        directory = path.join(root, id),
        filenames = [];
      fs.mkdirSync(directory);
      for (let index = 1; index <= 5; index++)
        for (const suffix of ["in", "out"]) {
          const filename = `${index}.${suffix}`;
          fs.writeFileSync(path.join(directory, filename), "1\n");
          filenames.push(filename);
        }
      const published = [],
        user = { id: 1 };
      let switches = 0,
        cleaned = 0;
      const svc = new AiService(
        {},
        {},
        {},
        { userHasPrivilege: async () => true, permissionDecision: async () => true },
        {
          updateProblemJudgeInfo: async () => {
            switches++;
            return null;
          }
        },
        {},
        {}
      );
      svc.assertJob = async () => user;
      svc.assertSnapshot = async () => user;
      svc.checkpoint = async () => {};
      svc.putFile = async (_problem, filename) => published.push(filename);
      svc.runSandbox = async (_job, payload) => {
        assert.equal(payload.validatorCode, "int main(){return 0;}");
        assert.equal(payload.cases.length, 5);
        assert.deepEqual(payload.samples, [{ input: "1\n", output: "1\n" }]);
        return { directory, files: filenames, validation };
      };
      svc.cleanupSandbox = async jobId => {
        assert.equal(jobId, id);
        cleaned++;
        fs.rmSync(directory, { recursive: true, force: true });
      };
      const job = {
        id,
        input: { count: 5 },
        progress: 0,
        state: {
          plan: { subtasks: [{ id: 1, points: 100 }], needsSpj: false, timeLimitMs: 1000, memoryLimitMiB: 128 },
          makeCode: "int main(){}",
          stdCode: "int main(){}",
          validatorCode: "int main(){return 0;}"
        }
      };
      const snapshot = {
        samples: [{ inputData: "1\n", outputData: "1\n" }],
        judgeInfo: { timeLimit: 1000, memoryLimit: 128 }
      };
      job.state.testdataSnapshotHash = svc.testdataFingerprint(snapshot);
      const execution = svc.testdata(job, user, { id: 1, type: "Traditional" }, {}, snapshot, 0, 100);
      if (validation === expected) {
        await execution;
        assert.equal(switches, 1);
        assert.equal(published.length, 14);
        assert(published.includes("validator.cpp"));
        assert.deepEqual(job.state.generated.sampleValidation, expected);
      } else {
        await assert.rejects(execution, /INVALID_SANDBOX_RESPONSE/);
        assert.equal(switches, 0, "unverified input cannot change judging configuration");
        assert.deepEqual(published, [], "unverified input cannot publish any file");
        assert.equal(job.state.generated, undefined);
      }
      assert.equal(cleaned, 1, "success and rejected proof both clean root-owned artifacts");
      assert.equal(fs.existsSync(directory), false);
    }
  } finally {
    if (oldDirectory === undefined) delete process.env.HYHOJ_AI_GENERATED_DIR;
    else process.env.HYHOJ_AI_GENERATED_DIR = oldDirectory;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validator artifact cannot replace an existing judging dependency", async () => {
  const svc = new AiService(
    {},
    {},
    {},
    { userHasPrivilege: async () => true, permissionDecision: async () => true },
    {},
    {},
    {}
  );
  let started = false;
  svc.runSandbox = async () => {
    started = true;
  };
  await assert.rejects(
    svc.testdata(
      { input: { count: 5 }, state: {} },
      { id: 1 },
      { id: 1, type: "Traditional" },
      {},
      { judgeInfo: { extraSourceFiles: { cpp: { "validator.cpp": "validator.cpp" } } }, samples: [] },
      0,
      100
    ),
    /GENERATOR_FILENAME_CONFLICT/
  );
  assert.equal(started, false);
});

test("input validator is generated independently from make/std and a runner rejection never publishes", async () => {
  mode = "validator-code";
  const user = { id: 1 },
    checkpoints = [];
  let uploaded = 0,
    switched = 0;
  const svc = new AiService(
    {},
    {},
    {},
    { userHasPrivilege: async () => true, permissionDecision: async () => true },
    {
      updateProblemJudgeInfo: async () => {
        switched++;
      }
    },
    {},
    {}
  );
  svc.assertJob = async () => user;
  svc.assertSnapshot = async () => user;
  svc.checkpoint = async (_job, step) => checkpoints.push(step);
  svc.putFile = async () => {
    uploaded++;
  };
  svc.runSandbox = async (_job, payload) => {
    assert.equal(payload.validatorCode, "int main(){return 0;}");
    assert.equal(payload.samples.length, 1);
    assert.deepEqual(
      payload.cases.map(item => item.subtask),
      [1, 1, 1, 2, 2, 2]
    );
    throw new AiError("SANDBOX_GENERATION_FAILED", "validator: global sum exceeded after operation 1");
  };
  const job = {
    id: "6a83e61a-f0ba-4fc2-8a8f-b79607aeb22f",
    input: { count: 5 },
    progress: 0,
    state: {
      plan: {
        subtasks: [
          { id: 1, points: 50, constraints: "PLAN_CONSTRAINT_MARKER" },
          { id: 2, points: 50 }
        ],
        needsSpj: false
      },
      makeCode: "int main(){/* PRIVATE_GENERATOR_IMPLEMENTATION */}",
      stdCode: "int main(){/* PRIVATE_SOLUTION_IMPLEMENTATION */}"
    }
  };
  const snapshot = {
    statements: [{ text: "STATEMENT_CONSTRAINT_MARKER: global sum must remain bounded after every update." }],
    samples: [{ inputData: "1 2\n", outputData: "3\n" }],
    judgeInfo: {}
  };
  job.state.testdataSnapshotHash = svc.testdataFingerprint(snapshot);
  const beforeRequests = requests.length;
  try {
    await assert.rejects(
      svc.testdata(job, user, { id: 1, type: "Traditional" }, { llm: config("chat") }, snapshot, 0, 100),
      /SANDBOX_GENERATION_FAILED: validator: global sum exceeded after operation 1/
    );
    assert.equal(requests.length - beforeRequests, 1, "validator must use its own model request");
    const prompt = requests.at(-1).body.messages.at(-1).content;
    assert.match(prompt, /^Generate ONLY validator\.cpp/);
    assert.match(prompt, /STATEMENT_CONSTRAINT_MARKER/);
    assert.match(prompt, /PLAN_CONSTRAINT_MARKER/);
    assert.match(prompt, /after EVERY operation/);
    assert(!prompt.includes("PRIVATE_GENERATOR_IMPLEMENTATION"));
    assert(!prompt.includes("PRIVATE_SOLUTION_IMPLEMENTATION"));
    assert(checkpoints.includes("testdata.validator"));
    assert.equal(uploaded, 0);
    assert.equal(switched, 0);
    assert.equal(job.state.generated, undefined);
  } finally {
    mode = "";
  }
});

test("retry regenerates failed programs while retaining committed artifacts", () => {
  const svc = new AiService({}, {}, {}, {}, {}, {}, {});
  const state = {
    completed: ["import", "tutorial"],
    discussionId: 7,
    plan: { subtasks: [] },
    makeCode: "bad make",
    stdCode: "bad std",
    checkerCode: "bad checker",
    validatorCode: "bad validator"
  };
  const result = svc.retryState({ state, error: "SANDBOX_GENERATION_FAILED: checker failed sample" });
  assert.equal(result.makeCode, undefined);
  assert.equal(result.stdCode, undefined);
  assert.equal(result.checkerCode, undefined);
  assert.equal(result.validatorCode, undefined);
  assert.deepEqual(result.completed, ["import", "tutorial"]);
  assert.equal(result.discussionId, 7);
  assert.equal(result.plan, state.plan);
  assert.match(result.generationFailure, /checker failed sample/);
  assert.equal(state.makeCode, "bad make");
  assert.equal(svc.retryState({ state, error: "PROBLEM_CHANGED_DURING_AI" }).plan, undefined);
  assert.equal(svc.retryState({ state, error: "SANDBOX_UNAVAILABLE" }).stdCode, "bad std");
  assert.equal(svc.retryState({ state, error: "SANDBOX_UNAVAILABLE" }).validatorCode, "bad validator");
  const invalidInput = svc.retryState({
    state,
    error: "SANDBOX_GENERATION_FAILED: validator: cumulative bound exceeded"
  });
  for (const field of ["makeCode", "stdCode", "checkerCode", "validatorCode"])
    assert.equal(invalidInput[field], undefined);
  assert.equal(invalidInput.discussionId, 7);
  assert.match(invalidInput.generationFailure, /cumulative bound exceeded/);
  assert.equal(state.validatorCode, "bad validator");
});

test("DeepSeek 384K output budget and max reasoning are valid; 1M is not an output budget", () => {
  const current = {
    ...config("responses"),
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    maxTokens: 393216,
    reasoning: "max"
  };
  assert.equal(DEEPSEEK_MAX_OUTPUT_TOKENS, 393216);
  assert.doesNotThrow(() => validateLlmConfiguration(current));
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", ""])
    assert.doesNotThrow(() => validateLlmConfiguration({ ...current, reasoning: effort }));
  for (const budget of [393217, 1000000])
    assert.throws(
      () => validateLlmConfiguration({ ...current, maxTokens: budget }),
      /DEEPSEEK_MAX_OUTPUT_TOKENS: 393216/
    );
  assert.throws(() => validateLlmConfiguration({ ...current, reasoning: "unlimited" }), /INVALID_DEEPSEEK_REASONING/);
  for (const budget of [0, 511, 1024.5, 1000001, NaN, Infinity])
    assert.throws(() => validateLlmConfiguration({ ...current, maxTokens: budget }), /INVALID_MAX_TOKENS/);
});

test("configuration DTO accepts larger integer output limits without accepting units or fractions", () => {
  for (const maxTokens of [65537, 393216, 1000000])
    assert.deepEqual(validateSync(plainToInstance(LlmConfigurationDto, { ...config("responses"), maxTokens })), []);
  for (const maxTokens of ["1m", 1000001, 393216.5])
    assert(
      validateSync(plainToInstance(LlmConfigurationDto, { ...config("responses"), maxTokens })).some(
        error => error.property === "maxTokens"
      )
    );
});

test("old 1M save requests are capped, keep both keys, and return the applied budget", async () => {
  const stored = new Map();
  const svc = new AiService(
    {},
    { findOneBy: async ({ userId }) => stored.get(userId), save: async row => stored.set(row.userId, row) },
    {},
    { userHasPrivilege: async user => !!user },
    {},
    {},
    {}
  );
  svc.key = require("node:crypto").randomBytes(32);
  const user = { id: 1 };
  const value = {
    llm: {
      ...config("responses"),
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      maxTokens: 1000000,
      reasoning: "max"
    },
    search: { type: "tavily", baseUrl: "https://api.tavily.com", apiKey: "saved-search-secret" },
    autoOnSave: true
  };
  let saved = await svc.saveConfiguration(user, value);
  assert.equal(saved.error, undefined);
  assert.equal(saved.llm.maxTokens, 393216);
  assert.equal(saved.llm.reasoning, "max");
  assert.deepEqual(saved.adjustments, { maxTokens: { requested: 1000000, applied: 393216 } });
  assert.equal(value.llm.maxTokens, 1000000, "Do not mutate the caller's request");
  assert.equal(saved.llm.hasKey, true);
  assert.equal(saved.search.hasKey, true);
  assert(!JSON.stringify(saved).includes("secret"));
  assert(!stored.get(1).encrypted.includes("secret"));
  saved = await svc.saveConfiguration(user, {
    ...value,
    llm: { ...value.llm, apiKey: "" },
    search: { ...value.search, apiKey: "" }
  });
  const decoded = svc.decrypt(stored.get(1).encrypted);
  assert.equal(decoded.llm.apiKey, "test-secret");
  assert.equal(decoded.search.apiKey, "saved-search-secret");
  assert.equal(decoded.llm.maxTokens, 393216);
  const ciphertext = stored.get(1).encrypted;
  for (const maxTokens of [511, 1000001, 393216.5])
    await assert.rejects(
      svc.saveConfiguration(user, { ...value, llm: { ...value.llm, maxTokens } }),
      /INVALID_MAX_TOKENS/
    );
  assert.equal(stored.get(1).encrypted, ciphertext, "Invalid requests must not overwrite saved keys");
  saved = await svc.saveConfiguration(user, { ...value, llm: { ...value.llm, maxTokens: 393216 } });
  assert.equal(saved.adjustments, undefined);
  saved = await svc.saveConfiguration(user, { ...value, llm: { ...value.llm, baseUrl: "https://example.org/v1" } });
  assert.equal(saved.llm.maxTokens, 1000000, "Other providers keep their requested budget");
});

test("HTTP save with the real controller and DTO accepts stale 1M settings on the search tab", async () => {
  const { NestFactory } = require("@nestjs/core");
  const { Module, ValidationPipe } = require("@nestjs/common");
  const { AiController } = require("./ai.controller.ts");
  const stored = new Map();
  const svc = new AiService(
    {},
    {
      findOneBy: async ({ userId }) => stored.get(userId),
      save: async row => stored.set(row.userId, row)
    },
    {},
    { userHasPrivilege: async user => user?.id === 1 },
    {},
    {},
    {}
  );
  // This isolated fixture must never start workers or read any real encryption key.
  svc.onModuleInit = async () => {};
  svc.onModuleDestroy = () => {};
  svc.key = require("node:crypto").randomBytes(32);
  class FixtureModule {}
  Module({ controllers: [AiController], providers: [{ provide: AiService, useValue: svc }] })(FixtureModule);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.use((req, _res, next) => {
    req.session = { user: { id: 1 } };
    next();
  });
  const providerCalls = requests.length;
  await app.listen(0, "127.0.0.1");
  const origin = await app.getUrl();
  const post = async (route, body) => {
    const response = await fetch(origin + "/api/ai/" + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const value = {
      llm: {
        type: "responses",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
        reasoning: "max",
        maxTokens: 393216,
        apiKey: "fixture-llm-secret"
      },
      search: { type: "tavily", baseUrl: "https://api.tavily.com" },
      autoOnSave: true
    };
    assert.equal((await post("saveConfiguration", value)).status, 201);
    const result = await post("saveConfiguration", {
      ...value,
      llm: { ...value.llm, maxTokens: 1000000, apiKey: "" },
      search: { ...value.search, apiKey: "fixture-search-secret" }
    });
    assert.equal(result.status, 201);
    assert.equal(result.data.error, undefined);
    assert.equal(result.data.llm.maxTokens, 393216);
    assert.equal(result.data.llm.hasKey, true);
    assert.equal(result.data.search.hasKey, true);
    assert(!JSON.stringify(result.data).includes("secret"));
    const reload = await post("getConfiguration", {});
    assert.equal(reload.data.llm.maxTokens, 393216);
    assert.equal(reload.data.search.hasKey, true);
    const decoded = svc.decrypt(stored.get(1).encrypted);
    assert.equal(decoded.llm.apiKey, "fixture-llm-secret");
    assert.equal(decoded.search.apiKey, "fixture-search-secret");
    const ciphertext = stored.get(1).encrypted;
    assert.equal(
      (await post("saveConfiguration", { ...value, llm: { ...value.llm, maxTokens: 1000001 } })).status,
      400
    );
    assert.equal(stored.get(1).encrypted, ciphertext);
    assert.equal(requests.length, providerCalls, "Saving must not make an inference call");
  } finally {
    await app.close();
    svc.key.fill(0);
  }
});

test("Responses forwards max effort, 393216 output tokens and image input unchanged", async () => {
  assert.equal(
    await generateText(
      { ...config("responses"), model: "deepseek-flash", maxTokens: 393216, reasoning: "max" },
      "system",
      "prompt",
      "data:image/png;base64,YQ=="
    ),
    "responses-ok"
  );
  const body = requests.at(-1).body;
  assert.equal(body.max_output_tokens, 393216);
  assert.deepEqual(body.reasoning, { effort: "max" });
  assert.equal(body.input[0].content[1].type, "input_image");
  assert.equal(body.store, false);
});

test("non-streaming whitespace keepalives and Responses terminal SSE are parsed correctly", async () => {
  try {
    for (mode of ["blank-keepalive", "responses-sse"])
      assert.equal(await generateText(config("responses"), "system", "prompt"), "responses-ok");
    mode = "responses-incomplete";
    await assert.rejects(generateText(config("responses"), "system", "prompt"), /MODEL_OUTPUT_TRUNCATED/);
    mode = "responses-failed";
    await assert.rejects(
      generateText(config("responses"), "system", "prompt"),
      error => error.code === "MODEL_OUTPUT_INCOMPLETE" && !error.message.includes("must-never-leak")
    );
  } finally {
    mode = "";
  }
});

test("SSE keepalives are ignored but missing Responses terminal events never count as success", () => {
  assert.equal(
    parseProviderResponse(
      ': keep-alive\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\ndata: \n\n',
      "text/event-stream"
    ).result.ok,
    true
  );
  assert.throws(
    () =>
      parseProviderResponse(
        'event: response.created\ndata: {"type":"response.created","response":{"status":"in_progress"}}\n\n',
        "text/event-stream"
      ),
    /MODEL_OUTPUT_INCOMPLETE/
  );
  assert.throws(
    () =>
      parseProviderResponse('event: response.completed\ndata: {"type":"response.completed"}\n\n', "text/event-stream"),
    /INVALID_PROVIDER_RESPONSE/
  );
});

test("unreadable image import returns a specific error before creating or checkpointing a problem", async () => {
  let mutations = 0;
  const svc = new AiService(
    {},
    {},
    {},
    { userHasPrivilege: async () => true },
    {
      userHasCreateProblemPermission: async () => true,
      createProblem: async () => {
        mutations++;
      }
    },
    {},
    {}
  );
  svc.model = async () => ({ error: "UNREADABLE" });
  svc.assertJob = async () => ({ id: 1 });
  svc.checkpoint = async () => {
    mutations++;
  };
  const job = { state: {}, input: { image: "data:image/png;base64,YQ==" } };
  await assert.rejects(
    svc.importProblem(job, { id: 1 }, {}),
    error => error instanceof AiError && error.code === "UNREADABLE_STATEMENT"
  );
  assert.equal(mutations, 0);
  assert.equal(job.state.importStatement, undefined);
  assert.equal(job.problemId, undefined);
});

test("null and empty import output produce expected validation errors with no business writes", async () => {
  let mutations = 0;
  const svc = new AiService(
    {},
    {},
    {},
    { userHasPrivilege: async () => true },
    {
      userHasCreateProblemPermission: async () => true,
      createProblem: async () => {
        mutations++;
      }
    },
    {},
    {}
  );
  svc.assertJob = async () => ({ id: 1 });
  svc.checkpoint = async () => {
    mutations++;
  };
  for (const result of [null, undefined, "", {}, [], { localizedContents: null, samples: [] }]) {
    svc.model = async () => result;
    await assert.rejects(
      svc.importProblem({ state: {}, input: { markdown: "fixture" } }, { id: 1 }, {}),
      error => error instanceof AiError && error.code === "INVALID_AI_STATEMENT"
    );
  }
  assert.equal(mutations, 0);
});

test("nested null statement fields and samples never throw TypeError", () => {
  const svc = new AiService({}, {}, {}, {}, {}, {}, {});
  const valid = {
    localizedContents: [
      {
        locale: "en_US",
        title: "Fixture",
        contentSections: [{ sectionTitle: "Description", type: "Text", text: "Statement." }]
      }
    ],
    samples: []
  };
  assert.doesNotThrow(() => svc.validateStatement(valid));
  for (const value of [
    { ...valid, localizedContents: [null] },
    { ...valid, localizedContents: [{ ...valid.localizedContents[0], contentSections: [null] }] },
    { ...valid, localizedContents: [{ ...valid.localizedContents[0], contentSections: null }] }
  ])
    assert.throws(
      () => svc.validateStatement(value),
      error => error instanceof AiError && error.code === "INVALID_AI_STATEMENT"
    );
  for (const samples of [null, [null], [undefined], [[]]])
    assert.throws(
      () => svc.validateStatement({ ...valid, samples }),
      error => error instanceof AiError && error.code === "INVALID_AI_SAMPLE"
    );
});

test("source verification matches full evidence URLs and known problem aliases without accepting prefixes", () => {
  const { findVerifiedSourceUrl } = require("./ai-source.ts");
  const refs = JSON.stringify([{ url: "https://codeforces.com/contest/4/problem/B", content: "Official problem" }]);
  assert.equal(
    findVerifiedSourceUrl("https://codeforces.com/problemset/problem/4/B", refs),
    "https://codeforces.com/contest/4/problem/B"
  );
  for (const url of [
    "https://codeforces.com",
    "https://codeforces.com/contest/4",
    "https://codeforces.com/problemset/problem/4/A",
    "https://codeforces.com.evil.invalid/contest/4/problem/B",
    "https://user:secret@codeforces.com/contest/4/problem/B"
  ])
    assert.equal(findVerifiedSourceUrl(url, refs), undefined);
  const atcoder = "https://atcoder.jp/contests/abc081/tasks/abc081_b?lang=en";
  assert.equal(
    findVerifiedSourceUrl(
      "https://atcoder.jp/contests/abc081/tasks/abc081_b",
      JSON.stringify([{ type: "text", text: JSON.stringify({ results: [{ url: atcoder }] }) }])
    ),
    atcoder
  );
  assert.equal(
    findVerifiedSourceUrl(
      "https://usaco.org/index.php?page=viewproblem2&cpid=762",
      JSON.stringify([{ url: "https://usaco.org/index.php?page=viewproblem2&cpid=761" }])
    ),
    undefined
  );
});

test("source resolution verifies aliases and performs a targeted search before independent semantic confirmation", async () => {
  const official = "https://codeforces.com/contest/4/problem/B";
  const proposed = "https://codeforces.com/problemset/problem/4/B";
  const core = "Find an integer study schedule whose total equals the requested time and each day stays within its allowed interval.";
  const bounds = "1 <= days <= 30";
  for (const targeted of [false, true]) {
    const searches = [], prompts = [], updates = [], stages = [];
    let permissionChecks = 0, snapshotChecks = 0;
    const svc = new AiService(
      { getRepository: () => ({ update: async (id, value) => updates.push({ id, value }) }) }, {}, {}, {}, {}, {}, {}
    );
    svc.references = async (_job, _config, query) => {
      searches.push(query);
      return JSON.stringify([{ url: targeted && !query.includes(proposed) ? "https://example.org/discussion" : official,
        content: `${core} ${bounds}.` }]);
    };
    svc.model = async (_config, prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith("Identify candidate original")) return { candidates: [{ url: proposed, title: "Before an Exam" }], queries: [] };
      assert.match(prompt, /^Independently verify/);
      return { sameProblem: true, pageType: "problem", originalTitle: "Before an Exam", contradictions: [],
        matches: [{ aspect: "core", quote: core }, { aspect: "constraints", quote: bounds }], reason: "Task and full constraints agree." };
    };
    svc.assertJob = async () => { permissionChecks++; return { id: 1 }; };
    svc.checkpoint = async (_job, stage) => stages.push(stage);
    svc.assertSnapshot = async () => { snapshotChecks++; return { id: 1 }; };
    const job = { action: "source", progress: 10, state: {} };
    const problem = {id: 12, originalProblem: ""}, snapshot = {
      statements: [{ title: "Before an Exam", contentSections: [{ text: "Find a bounded integer study schedule." }] }]
    };
    require("./ai-commit.fixture.cjs").commitFixture(svc, job, problem, snapshot, async (id, value) => updates.push({id, value}));
    await svc.edit(job, {id: 1}, problem, {search: {apiKey: "fixture-search-secret"}}, snapshot, "source");
    assert.equal(searches.length, 3);
    assert.equal(searches.filter(query => query.includes(proposed)).length, 1);
    assert.equal(prompts.length, 2);
    assert(permissionChecks > 5);
    assert.equal(snapshotChecks, 1);
    assert(stages.includes("source.verifying"));
    assert.equal(job.state.sourceVerification, "grounded_semantic_match");
    assert.equal(job.state.sourceSearch.status, "verified");
    assert.deepEqual(updates, [{ id: 12, value: { originalProblem: official, originalProblemTitle: "Before an Exam" } }]);
  }
});

test("a proposed original URL remains rejected when targeted search cannot verify the exact page", async () => {
  const searches = [];
  let writes = 0, verificationCalls = 0;
  const svc = new AiService({ getRepository: () => ({ update: async () => writes++ }) }, {}, {}, {}, {}, {}, {});
  svc.references = async (_job, _config, query) => {
    searches.push(query);
    return JSON.stringify([{ url: "https://example.org/problem/123-extra", content: "An unrelated problem with a different exact URL." }]);
  };
  svc.model = async (_config, prompt) => {
    if (prompt.startsWith("Independently verify")) verificationCalls++;
    return { candidates: [{ url: "https://example.org/problem/123", title: "Unverified claim" }], queries: [] };
  };
  svc.assertJob = async () => ({ id: 1 });
  svc.checkpoint = async () => {};
  svc.assertSnapshot = async () => assert.fail("unverified source must never reach the metadata write boundary");
  const job = { action: "source", progress: 10, state: {} };
  await svc.edit(job, { id: 1 }, { id: 12, originalProblem: "" }, { search: { apiKey: "fixture" } }, {
    statements: [{ title: "Fixture", contentSections: [] }]
  }, "source");
  assert.equal(job.state.sourceSearch.status, "not_found");
  assert(job.state.warnings.includes("SOURCE_NOT_FOUND"));
  assert(job.state.sourceSearchTrace.rejected.some(item => item.reason === "candidate_not_in_search_evidence"));
  assert(searches.some(query => query.includes("https://example.org/problem/123")));
  assert(searches.length <= 8);
  assert.equal(verificationCalls, 0);
  assert.equal(writes, 0);
});

test("source evidence ignores echoed search metadata and requires actual result links", () => {
  const { findVerifiedSourceUrl } = require("./ai-source.ts");
  const candidate = "https://codeforces.com/contest/4/problem/B";
  for (const field of ["query", "answer", "request", "title"]) {
    const text = JSON.stringify({ [field]: candidate + " Before an Exam", results: [] });
    assert.equal(findVerifiedSourceUrl(candidate, JSON.stringify([{ type: "text", text }])), undefined);
    assert.equal(
      findVerifiedSourceUrl(candidate, JSON.stringify({ [field]: { url: candidate }, results: [] })),
      undefined
    );
  }
  const results = {
    query: candidate,
    results: [{ url: "https://example.org/discussion", content: "See [original](" + candidate + ")." }]
  };
  assert.equal(
    findVerifiedSourceUrl(candidate, JSON.stringify([{ type: "text", text: JSON.stringify(results) }])),
    candidate
  );
  assert.equal(
    findVerifiedSourceUrl(candidate, JSON.stringify([{ type: "text", text: "Original: " + candidate }])),
    candidate
  );
  assert.equal(
    findVerifiedSourceUrl(
      candidate,
      JSON.stringify([{ type: "text", text: '{"query":"' + candidate + '","results":[' }])
    ),
    undefined
  );
});

test("structured source URLs preserve trailing characters and cannot manufacture a shorter page", () => {
  const { findVerifiedSourceUrl } = require("./ai-source.ts");
  for (const ending of [".", ";", ",", ")"]) {
    const actual = "https://example.org/problem/123" + ending;
    assert.equal(findVerifiedSourceUrl(actual, JSON.stringify([{ url: actual }])), actual);
    assert.equal(
      findVerifiedSourceUrl("https://example.org/problem/123", JSON.stringify([{ url: actual }])),
      undefined
    );
  }
});

test("known aliases require exact platform paths and standard ports", () => {
  const { findVerifiedSourceUrl } = require("./ai-source.ts");
  const official = "https://codeforces.com/contest/4/problem/B";
  for (const proposed of [
    "https://codeforces.com/contest/4/B",
    "https://codeforces.com/problemset/problem/4/problem/B",
    "https://codeforces.com:8443/contest/4/problem/B"
  ])
    assert.equal(findVerifiedSourceUrl(proposed, JSON.stringify([{ url: official }])), undefined);
  assert.equal(
    findVerifiedSourceUrl(official, JSON.stringify([{ url: "https://codeforces.com:8443/contest/4/problem/B" }])),
    undefined
  );
  assert.equal(
    findVerifiedSourceUrl("https://www.codeforces.com:443/problemset/problem/4/B", JSON.stringify([{ url: official }])),
    official
  );
  assert.equal(
    findVerifiedSourceUrl("https://codeforces.com/contest/4/problem/B1", JSON.stringify([{ url: official }])),
    undefined
  );
  const atcoder = "https://atcoder.jp/contests/abc081/tasks/abc081_b";
  assert.equal(
    findVerifiedSourceUrl(
      atcoder,
      JSON.stringify([{ url: atcoder.replace("atcoder.jp", "atcoder.jp:8443") + "?lang=en" }])
    ),
    undefined
  );
});

test("source validation preserves unknown page fragments and rejects oversized evidence URLs", () => {
  const { findVerifiedSourceUrl } = require("./ai-source.ts");
  assert.equal(
    findVerifiedSourceUrl(
      "https://example.org/problems#b",
      JSON.stringify([{ url: "https://example.org/problems#a" }])
    ),
    undefined
  );
  const cf = "https://codeforces.com/contest/4/problem/B";
  assert.equal(findVerifiedSourceUrl(cf, JSON.stringify([{ url: cf + "?tracking=" + "x".repeat(2200) }])), undefined);
});

test("a matching URL alone cannot confirm a targeted original problem", async () => {
  for (const confirmation of [
    { sameProblem: false }, { sameProblem: "true" }, null,
    { sameProblem: true, pageType: "problem", contradictions: [], matches: [] }
  ]) {
    let searches = 0, verifications = 0, writes = 0;
    const official = "https://codeforces.com/contest/4/problem/B";
    const svc = new AiService({ getRepository: () => ({ update: async () => writes++ }) }, {}, {}, {}, {}, {}, {});
    svc.references = async () => JSON.stringify([{ url: ++searches <= 2 ? "https://example.org/discussion" : official }]);
    svc.model = async (_config, prompt) => {
      if (prompt.startsWith("Independently verify")) { verifications++; return confirmation; }
      return { candidates: [{ url: official, title: "Fixture" }], queries: [] };
    };
    svc.assertJob = async () => ({ id: 1 });
    svc.checkpoint = async () => {};
    svc.assertSnapshot = async () => assert.fail("URL-only evidence must not reach publication");
    const job = { action: "source", progress: 10, state: {} };
    await svc.edit(job, { id: 1 }, { id: 12, originalProblem: "" }, { search: { apiKey: "fixture" } }, {
      statements: [{ title: "Fixture", contentSections: [{ text: "Find a bounded integer study schedule." }] }]
    }, "source");
    assert.equal(job.state.sourceSearch.status, "not_found");
    assert.equal(job.state.sourceVerification, "insufficient_or_conflicting_evidence");
    assert.equal(verifications, 1);
    assert(searches <= 8);
    assert.equal(writes, 0);
  }
});

test("invalid source model output produces a predictable not-found state and no writes", async () => {
  for (const response of [null, undefined, [], {}, { candidates: null }, { candidates: [null, { url: 42 }] }]) {
    let writes = 0, searches = 0, modelCalls = 0;
    const svc = new AiService({ getRepository: () => ({ update: async () => writes++ }) }, {}, {}, {}, {}, {}, {});
    svc.references = async () => { searches++; return "[]"; };
    svc.model = async () => { modelCalls++; return response; };
    svc.assertJob = async () => ({ id: 1 });
    svc.checkpoint = async () => {};
    svc.assertSnapshot = async () => assert.fail("invalid model output must not reach publication");
    const job = { action: "source", progress: 10, state: {} };
    await svc.edit(job, { id: 1 }, { id: 12, originalProblem: "" }, { search: { apiKey: "fixture" } }, {
      statements: [{ title: "Fixture", contentSections: [] }]
    }, "source");
    assert.equal(job.state.sourceSearch.status, "not_found");
    assert.equal(job.state.sourceVerification, "no_search_results");
    assert(job.state.warnings.includes("SOURCE_NOT_FOUND"));
    assert(searches <= 8);
    assert(modelCalls <= 4);
    assert.equal(writes, 0);
  }
});
