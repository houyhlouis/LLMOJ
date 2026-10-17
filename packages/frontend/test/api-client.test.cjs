// The shared API client (src/api.ts): a sensitive change refused for want of a recent password is confirmed in the
// dialog and sent once more; an ended session is forgotten; server errors quote the server's error ID.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const src = path.join(__dirname, "../src");
// Objects made inside the VM have its prototypes; compare their JSON.
const plain = value => JSON.parse(JSON.stringify(value));

function client(respond) {
  const appState = { token: "key", locale: "en_US" };
  const requests = [];
  const axios = async (url, config) => {
    requests.push({ url, config });
    return await respond(requests.length, config);
  };
  const modules = new Map();
  function load(filename, dependencies) {
    if (modules.has(filename)) return modules.get(filename);
    const module = { exports: {} };
    modules.set(filename, module.exports);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText;
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      console: { log() {}, error() {} },
      window: { apiEndpoint: "/" },
      require: name => {
        if (name in dependencies) return dependencies[name];
        const local = {
          "./utils/reauthentication": "utils/reauthentication.ts",
          "./utils/session": "utils/session.ts"
        };
        if (local[name]) return load(path.join(src, local[name]), { "@/appState": { appState } });
        throw new Error(`Unexpected import ${name}`);
      }
    });
    modules.set(filename, module.exports);
    return module.exports;
  }
  const api = load(path.join(src, "api.ts"), {
    axios: { default: axios, __esModule: true },
    "./appState": { appState },
    "./locales": { makeToBeLocalizedText: (id, parameters) => ({ id, parameters }) },
    "./utils/proofOfWork": {},
    "./api-generated": {}
  });
  const reauthentication = load(path.join(src, "utils/reauthentication.ts"), {});
  return { api, appState, requests, reauthentication };
}

const refused = { status: 200, data: { error: "REAUTHENTICATION_REQUIRED" }, headers: {} };

test("a refused sensitive change asks for the password once and is sent again only after confirmation", async () => {
  const { api, requests, reauthentication } = client(count =>
    count === 1 ? refused : { status: 200, data: {}, headers: {} }
  );
  let asked = 0;
  reauthentication.setReauthenticationHandler(async () => {
    asked++;
    return true;
  });
  const save = api.createPostApi("user/setUserPrivileges", {});
  assert.deepEqual(plain(await save({ userId: 2, privileges: [] })), { response: {} });
  assert.equal(asked, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].config.data, requests[0].config.data);
});

test("cancelling the dialog returns the refusal, and a refusal after confirming isn't repeated again", async () => {
  const cancelled = client(() => refused);
  cancelled.reauthentication.setReauthenticationHandler(async () => false);
  const save = cancelled.api.createPostApi("judgeClient/addJudgeClient", {});
  assert.deepEqual(plain((await save({ name: "x" })).response), { error: "REAUTHENTICATION_REQUIRED" });
  assert.equal(cancelled.requests.length, 1);

  const stubborn = client(() => refused);
  stubborn.reauthentication.setReauthenticationHandler(async () => true);
  await stubborn.api.createPostApi("judgeClient/addJudgeClient", {})({ name: "x" });
  assert.equal(stubborn.requests.length, 2);

  // Routes that answer with HTTP 403 are confirmed the same way.
  const forbidden = client(count =>
    count === 1
      ? { status: 403, data: { error: "REAUTHENTICATION_REQUIRED" }, headers: {} }
      : { status: 201, data: { paused: true }, headers: {} }
  );
  forbidden.reauthentication.setReauthenticationHandler(async () => true);
  assert.deepEqual(plain(await forbidden.api.createPostApi("site-management/updateAiPolicy", {})({})), {
    response: { paused: true }
  });
});

test("without a dialog (no page mounted it), the refusal is reported as is", async () => {
  const { api, requests } = client(() => ({
    status: 403,
    data: { error: "REAUTHENTICATION_REQUIRED" },
    headers: {}
  }));
  const result = await api.createPostApi("access/set", {})({});
  assert.equal(requests.length, 1);
  assert.equal(result.requestErrorCode, "REAUTHENTICATION_REQUIRED");
  assert.deepEqual(plain(result.requestError), { id: "common.request_error.reauthentication_required" });
});

test("server errors carry the server's error ID; an ended session is forgotten", async () => {
  const id = "6f1c2a4e-8d3b-4c5a-9e7f-0a1b2c3d4e5f";
  const { api, appState } = client(() => ({
    status: 500,
    data: { error: "INTERNAL_ERROR", requestId: id },
    headers: { "x-request-id": id, "x-session-ended": "1" }
  }));
  const result = await api.createGetApi("homepage/getHomepage")();
  assert.equal(result.requestId, id);
  assert.deepEqual(plain(result.requestError), { id: "common.request_error.server_error_with_id", parameters: { id } });
  assert.equal(appState.token, "");
  assert.equal(appState.sessionEnded, true);
});
