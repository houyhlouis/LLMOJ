const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

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
  createReportContext,
  localErrorDiagnostics,
  redactReportText,
  reportErrorClass,
  reportErrorMessage
} = require("./report-redaction.ts");

test("ordinary diagnostic strings survive and arbitrary objects are never coerced", () => {
  assert.equal(redactReportText("Unable to update row"), "Unable to update row");
  const dangerous = {
    toString() {
      throw new Error("must not be called");
    },
    toJSON() {
      throw new Error("must not be called");
    }
  };
  assert.equal(redactReportText(dangerous), "");
  assert.equal(reportErrorClass(dangerous), "UnknownError");
  assert.equal(reportErrorMessage(dangerous), "Unexpected exception; details omitted.");
});

test("labelled credentials, codes, headers and private content discard the entire message", () => {
  const fields = [
    "password",
    "newPassword",
    "currentPassword",
    "passwd",
    "secret",
    "secretKey",
    "clientSecret",
    "providerApiKey",
    "recoveryCode",
    "emailCode",
    "verificationCode",
    "totp",
    "otp",
    "2fa",
    "twoFactorCode",
    "sessionId",
    "session_key",
    "access_token",
    "refreshToken",
    "token",
    "apiKey",
    "authorization",
    "cookie",
    "sourceCode",
    "answer",
    "code",
    "privateKey"
  ];
  for (const field of fields) {
    for (const message of [
      `${field}=private fixture`,
      `{"${field}": "private fixture"}`,
      `${field} is private fixture`
    ])
      assert.equal(redactReportText(message), "[REDACTED]", message);
  }
  for (const content of [
    ["-----BEGIN ", "PRIVATE KEY-----\nfixture\n-----END ", "PRIVATE KEY-----"].join(""),
    "```cpp\nfixture\n```",
    "int main() { return 7; }",
    "#include <iostream>",
    "def solve(): pass"
  ])
    assert.equal(redactReportText(content), "[REDACTED]");
});

test("unlabelled provider keys, bearer tokens, JWTs and session hashes are removed", () => {
  const secrets = [
    ["sk", "fixture012345678901234567890123"].join("-"),
    ["tvly", "fixture012345678901234567890123"].join("-"),
    ["ghp", "fixture012345678901234567890123456789"].join("_"),
    ["github", "pat", "fixture012345678901234567890123456789"].join("_"),
    ["AI", "za", "fixture012345678901234567890123456789"].join(""),
    ["AKIA", "0123456789ABCDEF"].join(""),
    ["ASIA", "0123456789ABCDEF"].join(""),
    ["xoxb", "1234567890", "fixture"].join("-"),
    ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmaXh0dXJlIn0", "fixture-signature"].join("."),
    "a1".repeat(32)
  ];
  for (const secret of secrets) assert.equal(redactReportText(`Failed using ${secret}`), "Failed using [REDACTED]");
  assert.equal(redactReportText("Failed using Bearer fixture-token"), "Failed using [REDACTED]");
  assert.equal(redactReportText("Failed using Basic Zml4dHVyZTpmaXh0dXJl"), "Failed using [REDACTED]");
  assert.equal(redactReportText("Failed at https://fixture.invalid/private?opaque=value"), "Failed at [URL omitted]");
});

test("request values are removed from free text, including escaped and URL-encoded forms", () => {
  const privateValue = 'fixture "private"\nvalue';
  const variants = [privateValue, JSON.stringify(privateValue).slice(1, -1), encodeURIComponent(privateValue)];
  for (const value of variants) assert.equal(redactReportText(`Failed ${value}`, [privateValue]), "Failed [REDACTED]");
  assert.equal(
    reportErrorMessage(new Error("Failed 482971"), { body: { arbitraryField: 482971 } }),
    "Failed [REDACTED]"
  );
});

test("context contains only approved fields, route templates and query keys", () => {
  const error = Object.assign(new TypeError("Unable to update row"), {
    query: "fixture SQL",
    parameters: ["fixture private parameter"],
    config: { privateValue: "fixture configuration" },
    response: { privateValue: "fixture response" },
    toJSON() {
      throw new Error("must not serialize the exception");
    }
  });
  const context = createReportContext({
    eventId: "10203040",
    error,
    message: "Unexpected write failure",
    request: {
      requestId: "request-fixture",
      method: "POST",
      originalUrl: "/api/submission/fixture-path-secret?search=fixture-query-value&revision=8",
      baseUrl: "/api",
      route: { path: "/submission/:id" },
      body: { title: "fixture private title" },
      headers: { accept: "application/json" },
      session: { user: { id: 17, username: "fixture private username" } }
    }
  });
  assert.deepEqual(context, {
    eventId: "10203040",
    requestId: "request-fixture",
    method: "POST",
    route: "/api/submission/:id",
    queryKeys: ["search", "revision"],
    userId: 17,
    errorClass: "TypeError",
    errorMessage: "Unable to update row",
    message: "Unexpected write failure"
  });
});

test("body, header, session and query values cannot be echoed in diagnostic messages", () => {
  const values = ["fixture-body-value", "fixture-header-value", "fixture-session-value", "fixture-query-value"];
  const request = {
    originalUrl: `/api/problem/getProblem?query=${values[3]}`,
    body: { nested: [{ arbitraryName: values[0] }] },
    headers: { arbitraryHeader: values[1] },
    session: { sessionKey: values[2] }
  };
  const context = createReportContext({
    eventId: "12345678",
    request,
    error: new Error(values.join(" ")),
    message: values.join(" ")
  });
  assert.equal(context.errorMessage, values.map(() => "[REDACTED]").join(" "));
  assert.equal(context.message, context.errorMessage);
  assert.deepEqual(context.queryKeys, ["query"]);
});

test("local messages and stacks redact exact request values in every supported representation", () => {
  const values = ['body "fixture"\nvalue', "query fixture/value", "header fixture/value", "session fixture/value"];
  const request = {
    body: { password: values[0] },
    query: { code: values[1] },
    headers: { authorization: values[2] },
    session: { sessionKey: values[3] }
  };
  for (const represent of [value => value, value => JSON.stringify(value).slice(1, -1), encodeURIComponent]) {
    const error = new Error(`Unable to save password: ${values.map(represent).join(" | ")}`);
    const message = "Unable to save password: [REDACTED] | [REDACTED] | [REDACTED] | [REDACTED]";
    error.stack = `Error: ${error.message}\n    at save (/fixture/server.ts:12:4)`;
    assert.deepEqual(localErrorDiagnostics(error, request), {
      message,
      stack: `Error: ${message}\n    at save (/fixture/server.ts:12:4)`
    });
  }
});

test("local exact redaction retains long diagnostics and scans values beyond external-report bounds", () => {
  const values = Array.from({ length: 300 }, (_, i) => `fixture-private-${i}-value`);
  const longValue = "private-data".repeat(1000);
  const diagnostic = "password write failed at https://fixture.invalid/save: " + "details ".repeat(1200);
  const error = new Error(`${diagnostic}${values[0]} ${values.at(-1)} ${longValue}`);
  error.stack = `Error: ${error.message}\n    at save (/fixture/server.ts:12:4)`;
  const request = { body: { values, password: longValue } };
  const message = `${diagnostic}[REDACTED] [REDACTED] [REDACTED]`;
  assert.deepEqual(localErrorDiagnostics(error, request), {
    message,
    stack: `Error: ${message}\n    at save (/fixture/server.ts:12:4)`
  });
  assert.equal(reportErrorMessage(error, request), "[REDACTED]");
  assert.equal(
    localErrorDiagnostics(new Error("Failed \ud800"), { body: { value: "\ud800" } }).message,
    "Failed [REDACTED]"
  );
});

test("private body and query fields or string bodies suppress signed-in Telegram diagnostics", () => {
  const authenticated = {
    headers: { cookie: "session=fixture-session", authorization: "Bearer fixture-auth" },
    session: { sessionKey: "fixture-session", user: { id: 57 } }
  };
  assert.equal(reportErrorMessage(new Error("Unable to update row"), authenticated), "Unable to update row");
  for (const privateInput of [
    { body: { password: "fixture-password" } },
    { body: { nested: [{ content: "fixture-content" }] } },
    { query: { token: "fixture-token" } },
    { originalUrl: "/api/user/update?code=fixture-code" },
    { body: "fixture string body" }
  ])
    assert.equal(
      reportErrorMessage(new Error("Unable to update row"), { ...authenticated, ...privateInput }),
      "[REDACTED]"
    );
});

test("large or accessor-based inputs fail closed and circular bodies remain safe", () => {
  for (const body of [
    { huge: "x".repeat(8193) },
    Array.from({ length: 257 }, (_, i) => `fixture${i}`),
    {
      get dangerous() {
        throw new Error("must not invoke accessor");
      }
    }
  ])
    assert.equal(reportErrorMessage(new Error("could echo omitted data"), { body }), "[REDACTED]");
  const body = { value: "circular-fixture" };
  body.self = body;
  assert.equal(reportErrorMessage(new Error("Failed circular-fixture"), { body }), "Failed [REDACTED]");
  assert.equal(redactReportText("x".repeat(8193)), "[REDACTED]");
});

test("AI messages remain generic even when their sensitive value has no known pattern", () => {
  const context = createReportContext({
    eventId: "12345678",
    request: { originalUrl: "/api/%61i/start" },
    error: new Error("opaque fixture provider detail"),
    message: "opaque fixture custom detail"
  });
  assert.equal(context.errorMessage, "AI request failed; sensitive details omitted.");
  assert.equal(context.message, context.errorMessage);
});

test("sensitive request fields suppress arbitrary truncated excerpts in errors and custom messages", () => {
  for (const field of ["password", "recoveryCode", "apiKey", "sourceCode", "answer"]) {
    const context = createReportContext({
      eventId: "12345678",
      request: { body: { [field]: "private-fixture-complete-value" }, route: { path: "/api/example/action" } },
      error: new TypeError("Failed at fixture-complete"),
      message: "Unexpected value private-fixture"
    });
    assert.equal(context.errorMessage, "[REDACTED]");
    assert.equal(context.message, "[REDACTED]");
    assert.equal(context.route, "/api/example/action");
    assert.equal(context.errorClass, "TypeError");
  }
});

test("unmatched paths cannot smuggle arbitrary private values into route context", () => {
  const context = createReportContext({
    eventId: "12345678",
    request: { originalUrl: "/api/fixture-private-path/%73%6b%2dfixture" },
    error: new Error("Unable to match route")
  });
  assert.equal(context.route, "[unmatched route]");
  assert.ok(!JSON.stringify(context).includes("fixture-private-path"));
  assert.ok(!JSON.stringify(context).includes("%73%6b"));
});
