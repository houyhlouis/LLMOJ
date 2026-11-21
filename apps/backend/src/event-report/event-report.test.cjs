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

const { Logger } = require("@nestjs/common");
const { ErrorFilter } = require("../error.filter.ts");
const { EventReportService, EventReportType } = require("./event-report.service.ts");

function reportingFixture() {
  const messages = [],
    documents = [],
    deliveries = [],
    counted = [];
  let service;
  service = new EventReportService(
    { config: { eventReport: { sentTo: "fixture-sink" }, preference: { siteName: "Test Judge" } } },
    {
      postMessageToMaster(channel, payload) {
        assert.equal(channel, "event-report");
        deliveries.push(service.doReport(payload));
      }
    }
  );
  // Capture the Telegram API requests from the real report consumer.
  service.enabled = true;
  service.telegram = {
    async callApi(method, payload) {
      assert.equal(payload.chat_id, "fixture-sink");
      if (method === "sendMessage") {
        assert.equal(payload.parse_mode, "HTML");
        messages.push(payload.text);
      } else {
        assert.equal(method, "sendDocument");
        documents.push(payload.document);
      }
    }
  };
  const filter = new ErrorFilter(service, { counter: () => ({ inc: labels => counted.push(labels) }) });
  return { service, filter, messages, documents, deliveries, counted };
}

const fixtures = [
  ["auth/login", { username: "fixture-username", password: "fixture-login-password" }],
  ["auth/register", { username: "fixture-new-user", password: "fixture-registration-password", code: "638492" }],
  ["auth/resetPassword", { password: "fixture-reset-password", code: "294837", email: "fixture@example.invalid" }],
  [
    "twoFactor/reauthenticate",
    { password: "fixture-reauth-password", code: "764839", recoveryCode: "fixture-recovery-code" }
  ],
  [
    "ai/saveConfiguration",
    {
      llm: { apiKey: ["sk", "fixture012345678901234567890123"].join("-") },
      search: { apiKey: ["tvly", "fixture012345678901234567890123"].join("-") }
    }
  ],
  [
    "submission/submit",
    {
      sourceCode: "private fixture solution\nreturn fixture_answer;",
      answer: "fixture-private-answer",
      isPublic: false
    }
  ]
];

for (const [route, requestBody] of fixtures)
  test(`unexpected ${route} failure sends safe context to Telegram`, async () => {
    const fixture = reportingFixture();
    const logs = [];
    const oldLogger = Logger.prototype.error;
    Logger.prototype.error = (...values) => logs.push(values);
    let responseStatus, responseBody;
    const requestId = "bd51aa82-08dd-4988-813b-3b53af5f04ad";
    const privateQuery = "fixture-query-credential";
    const privateHeader = "fixture-cookie-and-authorization";
    const privateSession = "fixture-session-key";
    const request = {
      originalUrl: `/api/${route}?token=${privateQuery}&revision=2`,
      method: "POST",
      requestId,
      route: { path: `/api/${route}` },
      body: requestBody,
      headers: { authorization: `Bearer ${privateHeader}`, cookie: `session=${privateHeader}` },
      session: { sessionKey: privateSession, user: { id: 57, username: "fixture-private-username" } }
    };
    const bodyValues = JSON.stringify(requestBody).match(/fixture[^"\\]+|\d{6}/g) ?? [];
    const error = Object.assign(new TypeError(`Write failed: ${JSON.stringify(requestBody)} ${privateQuery}`), {
      query: "fixture-private-SQL",
      parameters: ["fixture-private-parameter"],
      config: { apiKey: "fixture-private-config-key" },
      response: { data: "fixture-private-response" },
      stack: "fixture-private-stack-message",
      toJSON() {
        throw new Error("must not serialize entire errors");
      }
    });
    try {
      fixture.filter.catch(error, {
        getType: () => "http",
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({
            status(code) {
              responseStatus = code;
              return this;
            },
            send(body) {
              responseBody = body;
            }
          })
        })
      });
      await Promise.all(fixture.deliveries);
    } finally {
      Logger.prototype.error = oldLogger;
    }
    assert.equal(responseStatus, 500);
    assert.deepEqual(responseBody, { error: "INTERNAL_ERROR", requestId });
    assert.deepEqual(fixture.counted, [{ error: "TypeError" }]);
    assert.equal(fixture.messages.length, 1);
    assert.equal(fixture.documents.length, 1);
    const context = JSON.parse(fixture.documents[0].source.toString("utf8"));
    assert.match(context.eventId, /^\d{8}$/);
    assert.equal(fixture.documents[0].filename, `Event_${context.eventId}.json`);
    assert.equal(context.requestId, requestId);
    assert.equal(context.method, "POST");
    assert.equal(context.route, `/api/${route}`);
    assert.equal(context.userId, 57);
    assert.equal(context.errorClass, "TypeError");
    assert.deepEqual(context.queryKeys, ["token", "revision"]);
    const emitted = JSON.stringify([fixture.messages, context]);
    const localLogs = JSON.stringify(logs);
    for (const secret of [...bodyValues, privateQuery, privateHeader, privateSession]) {
      assert.ok(!emitted.includes(secret), `Report leaked ${secret}`);
      assert.ok(!localLogs.includes(secret), `Local log leaked request value ${secret}`);
    }
    for (const secret of [
      "fixture-private-username",
      error.query,
      error.parameters[0],
      error.config.apiKey,
      error.response.data,
      error.stack
    ])
      assert.ok(!emitted.includes(secret), `Report leaked ${secret}`);
    if (route.startsWith("ai/")) assert.ok(!localLogs.includes(error.stack));
    else assert.equal(logs[0][1], error.stack, "The local stack is retained");
    for (const forbidden of ["body", "headers", "stack", "query", "parameters", "config", "response", "ip"])
      assert.equal(Object.hasOwn(context, forbidden), false);
    assert.ok(fixture.messages[0].includes(context.eventId));
    assert.ok(fixture.messages[0].includes(requestId));
  });

for (const privateBody of [false, true])
  test(`signed-in reports ${privateBody ? "suppress private body diagnostics" : "retain safe diagnostics"}`, async () => {
    const fixture = reportingFixture();
    const sessionKey = "fixture-session-key";
    const cookie = `session=${sessionKey}`;
    const authorization = "Bearer fixture-auth-value";
    const request = {
      requestId: "signed-in-request",
      originalUrl: "/api/user/updateProfile",
      route: { path: "/api/user/updateProfile" },
      method: "POST",
      body: privateBody ? { password: "fixture-password" } : { title: "fixture harmless title" },
      headers: { cookie, authorization },
      session: { sessionKey, user: { id: 57 } }
    };
    await fixture.service.report({
      type: EventReportType.Error,
      request,
      error: new Error(`Storage write failed after ${cookie} | ${authorization} | ${sessionKey}`),
      message: "Unexpected write failure"
    });
    await Promise.all(fixture.deliveries);
    const context = JSON.parse(fixture.documents[0].source.toString("utf8"));
    assert.equal(
      context.errorMessage,
      privateBody ? "[REDACTED]" : "Storage write failed after [REDACTED] | [REDACTED] | [REDACTED]"
    );
    assert.equal(context.message, privateBody ? "[REDACTED]" : "Unexpected write failure");
    assert.equal(context.requestId, request.requestId);
    assert.equal(context.route, request.route.path);
    assert.equal(context.userId, 57);
    const emitted = JSON.stringify([fixture.messages, context]);
    for (const secret of [cookie, authorization, sessionKey, "fixture-password"]) assert.ok(!emitted.includes(secret));
  });

test("local password diagnostics retain message and stack by request ID while Telegram omits both", async () => {
  const fixture = reportingFixture();
  const password = 'fixture "private"\nvalue';
  const message = `Account write failed using ${password}; escaped ${JSON.stringify(password).slice(1, -1)}; encoded ${encodeURIComponent(password)}`;
  const redactedMessage = "Account write failed using [REDACTED]; escaped [REDACTED]; encoded [REDACTED]";
  const frame = "    at updateProfile (/fixture/user.service.ts:42:7)";
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n${frame}`;
  const requestId = "password-write-request";
  const logs = [];
  const oldLogger = Logger.prototype.error;
  Logger.prototype.error = (...values) => logs.push(values);
  try {
    fixture.filter.catch(error, {
      getType: () => "http",
      switchToHttp: () => ({
        getRequest: () => ({
          requestId,
          originalUrl: "/api/user/updateProfile",
          route: { path: "/api/user/updateProfile" },
          method: "POST",
          body: { password },
          headers: { cookie: "session=fixture-session", authorization: "Bearer fixture-auth" },
          session: { sessionKey: "fixture-session", user: { id: 57 } }
        }),
        getResponse: () => ({
          status() {
            return this;
          },
          send(value) {
            assert.deepEqual(value, { error: "INTERNAL_ERROR", requestId });
          }
        })
      })
    });
    await Promise.all(fixture.deliveries);
  } finally {
    Logger.prototype.error = oldLogger;
  }
  assert.deepEqual(logs, [[`[${requestId}] ${redactedMessage}`, `TypeError: ${redactedMessage}\n${frame}`]]);
  const context = JSON.parse(fixture.documents[0].source.toString("utf8"));
  assert.equal(context.errorMessage, "[REDACTED]");
  assert.equal(context.errorClass, "TypeError");
  assert.equal(context.requestId, requestId);
  const emitted = JSON.stringify([fixture.messages, context]);
  for (const text of [password, "Account write failed", "escaped", "encoded", "updateProfile (/fixture"])
    assert.ok(!emitted.includes(text), `Telegram leaked diagnostic text ${text}`);
});

test("an early failure without a request ID reports the same generated ID returned to the client", async () => {
  const fixture = reportingFixture();
  const oldLogger = Logger.prototype.error;
  Logger.prototype.error = () => {};
  let response;
  try {
    fixture.filter.catch(null, {
      getType: () => "http",
      switchToHttp: () => ({
        getRequest: () => ({ originalUrl: "/api/auth/login", method: "POST" }),
        getResponse: () => ({
          status() {
            return this;
          },
          send(value) {
            response = value;
          }
        })
      })
    });
    await Promise.all(fixture.deliveries);
  } finally {
    Logger.prototype.error = oldLogger;
  }
  const context = JSON.parse(fixture.documents[0].source.toString("utf8"));
  assert.match(response.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(context.requestId, response.requestId);
  assert.equal(context.errorClass, "UnknownError");
});

test("long escaped diagnostics keep the Telegram preview bounded and the safe attachment complete", async () => {
  const fixture = reportingFixture();
  await fixture.service.report({
    type: EventReportType.Error,
    error: new Error("<".repeat(5000)),
    message: "&".repeat(5000)
  });
  await Promise.all(fixture.deliveries);
  assert.equal(fixture.messages.length, 1);
  assert.ok(fixture.messages[0].length < 4096);
  const context = JSON.parse(fixture.documents[0].source.toString("utf8"));
  assert.equal(context.errorMessage, "<".repeat(2000));
  assert.equal(context.message, "&".repeat(2000));
});
