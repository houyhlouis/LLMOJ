// TOTP (RFC 4226/6238 vectors) and WebAuthn verification against a software authenticator.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(file) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", source)(require, loaded, loaded.exports);
  return loaded.exports;
}
const totp = load("totp.ts");
const webauthn = load("webauthn.ts");

const rfcSecret = Buffer.from("12345678901234567890");

test("HOTP matches the RFC 4226 test values", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.equal(totp.hotp(rfcSecret, counter), code));
});

test("TOTP matches the RFC 6238 SHA-1 test values and tolerates one period of drift", () => {
  for (const [seconds, code] of [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"]
  ]) {
    const time = seconds * 1000;
    assert.equal(totp.hotp(rfcSecret, totp.totpTimeStep(time)), code);
    assert.equal(totp.verifyTotp(rfcSecret, code, time), totp.totpTimeStep(time));
    assert.equal(totp.verifyTotp(rfcSecret, code, time + 30000), totp.totpTimeStep(time));
    assert.equal(totp.verifyTotp(rfcSecret, code, time - 30000), totp.totpTimeStep(time));
    assert.equal(totp.verifyTotp(rfcSecret, code, time + 90000), null);
  }
  for (const invalid of ["", "28708", "2870822", "abcdef", " 287082", null, 287082])
    assert.equal(totp.verifyTotp(rfcSecret, invalid, 59000), null);
});

test("base32 secrets round-trip and the otpauth URI is importable", () => {
  assert.equal(totp.base32Encode(rfcSecret), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(totp.base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"), rfcSecret);
  assert.equal(totp.base32Decode("not base32!"), null);
  const secret = totp.generateTotpSecret();
  assert.equal(secret.length, 20);
  assert.deepEqual(totp.base32Decode(totp.base32Encode(secret)), secret);
  const uri = new URL(totp.totpUri(rfcSecret, "My OJ", "alice:1"));
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.host, "totp");
  assert.equal(decodeURIComponent(uri.pathname), "/My OJ:alice:1");
  assert.equal(uri.searchParams.get("secret"), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(uri.searchParams.get("issuer"), "My OJ");
  assert.equal(uri.searchParams.get("digits"), "6");
  assert.equal(uri.searchParams.get("period"), "30");
});

test("recovery codes are random, formatted for reading, and hash the same however they are typed", () => {
  const codes = totp.generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
  const hash = totp.hashRecoveryCode(codes[0]);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(totp.hashRecoveryCode(codes[0].toUpperCase().replace(/-/g, " ")), hash);
  for (const invalid of ["", "too-short", codes[0] + "a", "0000-0000-0000-0000", null])
    assert.equal(totp.hashRecoveryCode(invalid), null);
});

const { cbor, relyingParty, softwareAuthenticator } = require("./two-factor-test-helpers.cjs");

for (const kind of ["ES256", "EdDSA", "RS256"]) {
  test(`${kind} passkeys register and sign in; tampered ceremonies are rejected`, () => {
    const authenticator = softwareAuthenticator(kind);
    const registration = { challenge: "registration-challenge", ...relyingParty };
    const created = webauthn.verifyRegistration(authenticator.create(registration), registration);
    assert.deepEqual(created.id, authenticator.credentialId);
    assert.equal(created.algorithm, { ES256: -7, EdDSA: -8, RS256: -257 }[kind]);
    const credential = { publicKey: created.publicKey, signCount: created.signCount };

    const expected = { challenge: "sign-in-challenge", ...relyingParty };
    const result = webauthn.verifyAssertion(authenticator.get(expected), expected, credential);
    assert.equal(result.signCount, 1);
    assert.equal(result.userVerified, true);
    credential.signCount = result.signCount;

    const rejects = (response, message) =>
      assert.throws(() => webauthn.verifyAssertion(response, expected, credential), message);
    rejects(authenticator.get({ ...expected, challenge: "other" }), /Challenge mismatch/);
    rejects(authenticator.get({ ...expected, origin: "https://evil.example" }), /Origin mismatch/);
    rejects(authenticator.get({ ...expected, rpId: "evil.example" }), /Relying party mismatch/);
    rejects(authenticator.get({ ...expected, flags: 0x04 }), /User presence/);
    credential.signCount = 1000;
    rejects(authenticator.get({ ...expected, advance: 0 }), /counter did not increase/);
    credential.signCount = 1;
    const tampered = authenticator.get(expected);
    tampered.signature = Buffer.from(tampered.signature);
    tampered.signature[tampered.signature.length - 1] ^= 1;
    rejects(tampered, /Invalid signature/);
    const swapped = authenticator.get(expected);
    swapped.clientDataJSON = Buffer.from(swapped.clientDataJSON.toString().replace("webauthn.get", "webauthn.create"));
    rejects(swapped, /Unexpected ceremony type/);

    assert.throws(
      () => webauthn.verifyRegistration(authenticator.create({ ...registration, rpId: "evil.example" }), registration),
      /Relying party mismatch/
    );
    assert.throws(
      () => webauthn.verifyRegistration(authenticator.create({ ...registration, flags: 0x40 }), registration),
      /User presence/
    );
  });
}

test("synced passkeys that always report counter 0 keep working", () => {
  const authenticator = softwareAuthenticator("ES256");
  const registration = { challenge: "c", ...relyingParty };
  const created = webauthn.verifyRegistration(authenticator.create(registration), registration);
  const expected = { challenge: "d", ...relyingParty };
  for (let i = 0; i < 2; i++)
    assert.equal(
      webauthn.verifyAssertion(authenticator.get({ ...expected, advance: 0 }), expected, {
        publicKey: created.publicKey,
        signCount: 0
      }).signCount,
      0
    );
});

test("malformed CBOR and unsupported keys are rejected, never mis-parsed", () => {
  for (const data of [
    Buffer.from([0x5f]), // indefinite-length bytes
    Buffer.from([0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), // beyond safe integers
    Buffer.from([0x42, 0x01]), // truncated
    Buffer.concat([cbor(1), cbor(2)]), // trailing data
    Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02]) // duplicate map key
  ])
    assert.throws(() => webauthn.decodeCbor(data), webauthn.WebAuthnError);
  assert.deepEqual(
    webauthn.decodeCbor(cbor(new Map([[1, [Buffer.from("x"), "y", -3]]]))),
    new Map([[1, [Buffer.from("x"), "y", -3]]])
  );
  let nested = cbor(1);
  for (let i = 0; i < 40; i++) nested = Buffer.concat([Buffer.from([0x81]), nested]);
  assert.throws(() => webauthn.decodeCbor(nested), /too deep/);
  assert.throws(
    () =>
      webauthn.coseToPublicKey(
        cbor(
          new Map([
            [1, 2],
            [3, -35]
          ])
        )
      ),
    /Unsupported credential algorithm/
  );
  assert.throws(
    () =>
      webauthn.coseToPublicKey(
        cbor(
          new Map([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, Buffer.alloc(31)],
            [-3, Buffer.alloc(32)]
          ])
        )
      ),
    /Invalid COSE key parameter/
  );
  const weak = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" });
  assert.throws(
    () =>
      webauthn.coseToPublicKey(
        cbor(
          new Map([
            [1, 3],
            [3, -257],
            [-1, Buffer.from(weak.n, "base64url")],
            [-2, Buffer.from(weak.e, "base64url")]
          ])
        )
      ),
    /2048 bits/
  );
});

test("passkeys need a secure, named origin", () => {
  assert.deepEqual(webauthn.relyingPartyForOrigin("https://oj.example.com"), relyingParty);
  assert.deepEqual(webauthn.relyingPartyForOrigin("http://localhost:5173"), {
    origin: "http://localhost:5173",
    rpId: "localhost"
  });
  for (const origin of [
    "http://oj.example.com",
    "http://192.168.137.2",
    "https://192.168.1.2",
    "https://[::1]",
    "https://oj.example.com/",
    "https://oj.example.com:443",
    "null",
    undefined,
    42
  ])
    assert.equal(webauthn.relyingPartyForOrigin(origin), null, String(origin));
});

test("audit actions for sign-in and two-factor changes fit the audit log column", () => {
  const entity = fs.readFileSync(path.join(__dirname, "../../audit/audit-log.entity.ts"), "utf8");
  const length = Number(/length: (\d+) \}\)\s*@Index\(\)\s*action: string/.exec(entity)[1]);
  for (const file of ["two-factor.controller.ts", "../auth.controller.ts"]) {
    const actions = [...fs.readFileSync(path.join(__dirname, file), "utf8").matchAll(/"(auth\.[a-z_.]+)"/g)].map(
      match => match[1]
    );
    assert(actions.length > 0, file);
    for (const action of actions) assert(action.length <= length, `${action} is longer than ${length}`);
  }
});
