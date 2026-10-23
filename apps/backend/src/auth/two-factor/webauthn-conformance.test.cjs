// The site's WebAuthn verifier on the fixtures of webauthn-fixtures.cjs (review 4.4): the W3C test vectors, changed
// copies of them that must be refused, counters, backup flags, and the site's exact origin and RP ID.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { conformanceCases, vectors } = require("./webauthn-fixtures.cjs");

const loaded = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  ts.transpileModule(fs.readFileSync(path.join(__dirname, "webauthn.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
)(require, loaded, loaded.exports);
const { builtInWebAuthnVerifier: verifier, WebAuthnError } = loaded.exports;

async function run(verifierUnderTest, item) {
  return item.kind === "registration"
    ? await verifierUnderTest.verifyRegistration(item.response, item.expected)
    : await verifierUnderTest.verifyAssertion(item.response, item.expected, item.credential);
}

test("the fixtures cover every W3C vector the site can use, and the ones it refuses", () => {
  assert.equal(vectors.length, 15);
  const cases = conformanceCases();
  assert.equal(cases.length, 75);
  assert.equal(new Set(cases.map(item => item.name)).size, cases.length, "case names are unique");
  const accepted = cases.filter(item => item.name.startsWith("W3C") && item.accept).length;
  assert.equal(accepted, 20, "10 vectors (ES256, RS256, Ed25519 in every attestation format), both ceremonies");
});

for (const item of conformanceCases()) {
  test(`${item.accept ? "accepts" : "refuses"}: ${item.name}`, async () => {
    if (!item.accept) {
      await assert.rejects(run(verifier, item), WebAuthnError);
      return;
    }
    const result = await run(verifier, item);
    for (const [field, value] of Object.entries(item.result)) assert.deepEqual(result[field], value, field);
  });
}
