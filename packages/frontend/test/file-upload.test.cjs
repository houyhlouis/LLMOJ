// Run with: node --test packages/frontend/test/file-upload.test.cjs
// Transpile the actual browser utilities without loading the application's global state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

function load(relative, dependencies = {}, globals = {}) {
  const filename = path.join(__dirname, "../src", relative);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require: name => {
        if (!(name in dependencies)) throw new Error(`Unexpected runtime import: ${name}`);
        return dependencies[name];
      },
      setTimeout,
      clearTimeout,
      Blob,
      File,
      FormData,
      DOMException,
      AbortController,
      Math: Object.assign(Object.create(Math), { random: () => 0 }),
      ...globals
    },
    { filename }
  );
  return module.exports;
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function mockAxios(handler = async () => ({ status: 204 })) {
  const requests = [];
  const axios = {
    requests,
    isCancel: error => !!error?.__CANCEL__,
    CancelToken: {
      source: () => {
        const token = { cancelled: false };
        return {
          token,
          cancel: () => {
            token.cancelled = true;
          }
        };
      }
    }
  };
  for (const method of ["post", "put"])
    axios[method] = async (url, body, config) => {
      requests.push({ method, url, body, config });
      return handler({ method, url, body, config });
    };
  return axios;
}
function setup({ method = "POST", axios = mockAxios(), prepareUploadApi, globals = {}, ...extra } = {}) {
  const calls = [];
  const signed = {
    method,
    url: "/upload",
    uuid: "file-uuid",
    fileFieldName: "file",
    extraFormData: { policy: "test-policy" }
  };
  const api = async request => {
    calls.push(request);
    return { response: request.uploadInfo?.uuid ? { submissionId: 17 } : { signedUploadRequest: signed } };
  };
  const options = {
    api,
    request: { problemId: 1 },
    file: new File(["sample"], "sample.zip"),
    prepareUploadApi,
    ...extra
  };
  const { callApiWithFileUpload } = load("utils/callApiWithFileUpload.ts", { axios }, globals);
  return { calls, signed, axios, options, run: () => callApiWithFileUpload(options) };
}

test("legacy POST uploads keep form fields and call completion only after confirmed 204", async () => {
  const s = setup();
  const result = await s.run();
  assert.equal(result.response.submissionId, 17);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].uploadInfo.uuid, "file-uuid");
  assert.equal(s.axios.requests[0].body.get("policy"), "test-policy");
  assert.equal(await s.axios.requests[0].body.get("file").text(), "sample");
  assert.equal(s.axios.requests[0].config.timeout, 0); // no new cap for existing large uploads
});

test("PUT and separate prepareUploadApi preserve existing submission flow", async () => {
  const s = setup({ method: "PUT", uploadTimeoutMs: 1234 });
  s.options.prepareUploadApi = async (request, file) => {
    assert.equal(request.problemId, 1);
    assert.equal(file.size, 6);
    return { response: { signedUploadRequest: s.signed } };
  };
  assert.equal((await s.run()).response.submissionId, 17);
  assert.equal(s.calls.length, 1);
  assert.equal(s.axios.requests[0].method, "put");
  assert.equal(s.axios.requests[0].body, s.options.file);
  assert.equal(s.axios.requests[0].config.timeout, 1234);
});

test("requests with no file still invoke their API once", async () => {
  const s = setup({
    file: null,
    api: async request => ({ response: { submissionId: request.uploadInfo === null ? 18 : 0 } })
  });
  assert.equal((await s.run()).response.submissionId, 18);
  assert.equal(s.axios.requests.length, 0);
});

for (const status of [0, 403, 500, undefined])
  test(`resolved upload status ${status} cannot invoke completion`, async () => {
    const s = setup({ axios: mockAxios(async () => ({ status })), uploadAttempts: 1 });
    assert.ok((await s.run()).uploadError);
    assert.equal(s.calls.length, 1);
  });

test("explicit upload timeout rejects without completing or retrying an AI upload", async () => {
  const s = setup({
    axios: mockAxios(async ({ config }) => {
      assert.equal(config.timeout, 120000);
      throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
    }),
    uploadAttempts: 1,
    uploadTimeoutMs: 120000
  });
  assert.equal((await s.run()).uploadError.code, "ECONNABORTED");
  assert.equal(s.calls.length, 1);
  assert.equal(s.axios.requests.length, 1);
});

test("legacy transient upload failures can still retry", async () => {
  let attempts = 0;
  const s = setup({
    axios: mockAxios(async () => {
      if (++attempts === 1) throw new Error("temporary network failure");
      return { status: 200 };
    })
  });
  assert.equal((await s.run()).response.submissionId, 17);
  assert.equal(attempts, 2);
  assert.equal(s.calls.length, 2);
});

test("cancellation before preparation does not send any request", async () => {
  const controller = new AbortController();
  controller.abort();
  const s = setup({ signal: controller.signal });
  assert.equal((await s.run()).uploadCancelled, true);
  assert.equal(s.calls.length, 0);
  assert.equal(s.axios.requests.length, 0);
});

test("cancellation while preparing blocks the later upload", async () => {
  const controller = new AbortController(),
    pending = deferred();
  const s = setup({ signal: controller.signal, prepareUploadApi: () => pending.promise });
  const running = s.run();
  controller.abort();
  pending.resolve({ response: { signedUploadRequest: s.signed } });
  assert.equal((await running).uploadCancelled, true);
  assert.equal(s.axios.requests.length, 0);
  assert.equal(s.calls.length, 0);
});

test("unmount cancellation wins even if the adapter later resolves upload successfully", async () => {
  const controller = new AbortController(),
    pending = deferred(),
    started = deferred();
  const s = setup({
    signal: controller.signal,
    axios: mockAxios(async () => {
      started.resolve();
      return pending.promise;
    })
  });
  const running = s.run();
  await started.promise;
  controller.abort();
  pending.resolve({ status: 204 });
  assert.equal((await running).uploadCancelled, true);
  assert.equal(s.calls.length, 1);
  assert.equal(s.axios.requests[0].config.cancelToken.cancelled, true);
});

test("legacy onCancelAvailable works during a retry and prevents subsequent requests", async () => {
  let cancel;
  const s = setup({
    axios: mockAxios(async () => {
      throw new Error("offline");
    }),
    onCancelAvailable: value => {
      cancel = value;
    },
    onProgress: p => {
      if (p.status === "Retrying") cancel();
    }
  });
  assert.equal((await s.run()).uploadCancelled, true);
  assert.equal(s.axios.requests.length, 1);
  assert.equal(s.calls.length, 1);
});

test("preparation API cancellation is returned consistently", async () => {
  const controller = new AbortController();
  const s = setup({
    signal: controller.signal,
    prepareUploadApi: async () => {
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    }
  });
  assert.equal((await s.run()).uploadCancelled, true);
});

function readerFixture(behavior) {
  const instances = [];
  class Reader {
    result = null;
    error = null;
    constructor() {
      instances.push(this);
    }
    readAsText(file) {
      behavior(this, file, "text");
    }
    readAsDataURL(file) {
      behavior(this, file, "dataURL");
    }
    readAsArrayBuffer(file) {
      behavior(this, file, "arrayBuffer");
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }
  return { instances, ...load("utils/readBrowserFile.ts", {}, { FileReader: Reader }) };
}
test("file reader returns text, data URLs and owned ArrayBuffers", async () => {
  const values = { text: "# readable", dataURL: "data:image/png;base64,AA==", arrayBuffer: new ArrayBuffer(3) };
  const r = readerFixture((reader, file, format) => {
    reader.result = values[format];
    queueMicrotask(() => reader.onload());
  });
  for (const format of Object.keys(values)) assert.equal(await r.readBrowserFile(new Blob(), format), values[format]);
  assert.ok(r.instances.every(x => x.onload === null && x.onerror === null && x.onabort === null));
});
for (const event of ["error", "abort"])
  test(`unreadable file ${event} rejects instead of hanging`, async () => {
    const r = readerFixture(reader => queueMicrotask(() => reader[`on${event}`]()));
    await assert.rejects(r.readBrowserFile(new Blob(), "text"));
  });
test("file reading timeout aborts the reader and releases event handlers", async () => {
  const r = readerFixture(() => {});
  await assert.rejects(r.readBrowserFile(new Blob(), "arrayBuffer", { timeoutMs: 5 }), { name: "TimeoutError" });
  assert.equal(r.instances[0].aborted, true);
  assert.equal(r.instances[0].onload, null);
});
test("file reading cancellation on unmount aborts ongoing work", async () => {
  const r = readerFixture(() => {}),
    controller = new AbortController();
  const reading = r.readBrowserFile(new Blob(), "text", { signal: controller.signal });
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(r.instances[0].aborted, true);
});

test("AI attachment requires both a signed upload and token before it can succeed", async () => {
  const axios = mockAxios(async () => ({ status: 201, data: { attachmentToken: "fixture-token" } }));
  const upload = load("utils/callApiWithFileUpload.ts", { axios });
  const api = load(
    "pages/ai/api.ts",
    { axios, "@/utils/callApiWithFileUpload": upload, "@/appState": { appState: { locale: "en_US", token: null } } },
    { window: { apiEndpoint: "/" } }
  );
  await assert.rejects(
    api.uploadAiAttachment(new File(["zip"], "case.zip"), () => {}),
    /preparation failed/
  );
  assert.equal(axios.requests.length, 1);
});
test("AI requests honor an already aborted signal without sending a request", async () => {
  const axios = mockAxios(),
    controller = new AbortController();
  controller.abort();
  const api = load(
    "pages/ai/api.ts",
    { axios, "@/utils/callApiWithFileUpload": {}, "@/appState": { appState: { locale: "en_US", token: null } } },
    { window: { apiEndpoint: "/" } }
  );
  await assert.rejects(api.aiCall("start", {}, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(axios.requests.length, 0);
});

test("late failed-upload progress cannot replace Retrying, and retry delay is cancellable", async () => {
  let cancel;
  const states = [];
  const s = setup({
    axios: mockAxios(async ({ config }) => {
      config.onUploadProgress({ loaded: 100, total: 100 });
      throw new Error("network failed after sending body");
    }),
    globals: { Math: Object.assign(Object.create(Math), { random: () => 1 }) },
    onCancelAvailable: value => {
      cancel = value;
    },
    onProgress: p => {
      states.push(p.status);
      if (p.status === "Retrying") setTimeout(() => cancel(), 5);
    }
  });
  assert.equal((await s.run()).uploadCancelled, true);
  assert.deepEqual(states, ["Requesting", "Retrying"]);
  assert.equal(s.axios.requests.length, 1);
});

test("cancelling from preparation progress stops the first API request", async () => {
  let cancel;
  const s = setup({
    onCancelAvailable: value => {
      cancel = value;
    },
    onProgress: () => cancel()
  });
  assert.equal((await s.run()).uploadCancelled, true);
  assert.equal(s.calls.length, 0);
});

test("AI attachment applies bounded requests and returns a token only after confirmed upload", async () => {
  const controller = new AbortController();
  const axios = mockAxios(async ({ url, config }) => {
    if (url.endsWith("prepareAttachment")) {
      assert.equal(config.timeout, 30000);
      assert.equal(config.signal, controller.signal);
      return {
        status: 201,
        data: {
          attachmentToken: "fixture-token",
          signedUploadRequest: {
            method: "POST",
            url: "/upload",
            uuid: "fixture-uuid",
            fileFieldName: "file",
            extraFormData: {}
          }
        }
      };
    }
    assert.equal(config.timeout, 120000);
    return { status: 204 };
  });
  const upload = load("utils/callApiWithFileUpload.ts", { axios });
  const api = load(
    "pages/ai/api.ts",
    { axios, "@/utils/callApiWithFileUpload": upload, "@/appState": { appState: { locale: "en_US", token: null } } },
    { window: { apiEndpoint: "/" } }
  );
  assert.equal(
    await api.uploadAiAttachment(new File(["zip"], "case.zip"), () => {}, controller.signal),
    "fixture-token"
  );
  assert.equal(axios.requests.length, 2);
});

test("tutorial fact errors are localized without rendering arbitrary backend detail", () => {
  const appState = { locale: "en_US", token: null };
  const api = load("pages/ai/api.ts", {
    axios: mockAxios(),
    "@/utils/callApiWithFileUpload": {},
    "@/appState": { appState }
  });
  assert.match(api.aiError("INVALID_AI_TUTORIAL: UNSUPPORTED_NO_PARTIAL_SCORE_CLAIM"), /partial scoring/);
  assert.match(api.aiError("INVALID_AI_TUTORIAL: UNVERIFIED_SOURCE_PROVENANCE_CLAIM"), /original source/);
  assert.match(api.aiError("INVALID_AI_TUTORIAL: must-not-render-provider-text"), /format or factual/);
  assert.doesNotMatch(api.aiError("INVALID_AI_TUTORIAL: must-not-render-provider-text"), /must-not-render/);
  appState.locale = "zh_CN";
  assert.match(api.aiError("INVALID_AI_TUTORIAL: UNSUPPORTED_NO_PARTIAL_SCORE_CLAIM"), /部分分/);
  assert.match(api.aiError("INVALID_AI_TUTORIAL: UNVERIFIED_SOURCE_PROVENANCE_CLAIM"), /原题来源/);
  assert.match(api.actionName("repair-make"), /修复/);
});
