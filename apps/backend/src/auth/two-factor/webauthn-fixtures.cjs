// Accept/reject fixtures for a WebAuthn verifier (review 4.4): the W3C test vectors (webauthn-test-vectors.json),
// changed copies of them, and ceremonies of a software authenticator. webauthn-conformance.test.cjs runs them on the
// site's verifier. To compare another implementation, run them through an adapter implementing WebAuthnVerifier
// (webauthn.ts) and compare which cases each one accepts.
//
// A case is { name, kind: "registration" | "assertion", response, expected, credential (assertions), accept, result },
// where `result` holds the fields an accepting verifier must return.
const crypto = require("node:crypto");
const { vectors } = require("./webauthn-test-vectors.json");
const { relyingParty, sha256, softwareAuthenticator } = require("./two-factor-test-helpers.cjs");

const hex = text => Buffer.from(text, "hex");
const b64u = buffer => Buffer.from(buffer).toString("base64url");
const example = { origin: "https://example.org", rpId: "example.org" };
const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 };

function vector(section) {
  return vectors.find(item => item.section === section);
}

function vectorCeremonies(item) {
  const { registration: r, authentication: a } = item;
  return {
    registration: {
      response: { clientDataJSON: hex(r.clientDataJSON), attestationObject: hex(r.attestationObject) },
      expected: { challenge: b64u(hex(r.challenge)), ...example }
    },
    assertion: {
      response: {
        clientDataJSON: hex(a.clientDataJSON),
        authenticatorData: hex(a.authenticatorData),
        signature: hex(a.signature)
      },
      expected: { challenge: b64u(hex(a.challenge)), ...example },
      credential: { publicKey: hex(item.credentialPublicKey), signCount: 0 }
    }
  };
}

// The authenticator data flags inside an attestation object, found by the RP ID hash that starts the data.
function registrationFlags(attestationObject) {
  return attestationObject[attestationObject.indexOf(sha256(example.rpId)) + 32];
}

function withRegistrationFlags(attestationObject, change) {
  const copy = Buffer.from(attestationObject);
  const at = copy.indexOf(sha256(example.rpId)) + 32;
  copy[at] = change(copy[at]);
  return copy;
}

function w3cCases() {
  const cases = [];
  for (const item of vectors) {
    const { registration, assertion } = vectorCeremonies(item);
    // The site accepts ES256, EdDSA (Ed25519) and RS256, and no ceremonies in another site's frame.
    const unsupported = /ES384|ES512|Ed448/.test(item.title);
    const crossOrigin = /crossOrigin|topOrigin/.test(item.title);
    const accept = !unsupported && !crossOrigin;
    const algorithm = /RS256/.test(item.title) ? -257 : /Ed25519/.test(item.title) ? -8 : -7;
    const name = `W3C ${item.section} ${item.title}`;
    cases.push({
      name: `${name}: registration`,
      kind: "registration",
      ...registration,
      accept,
      result: accept && {
        id: hex(item.credentialId),
        publicKey: hex(item.credentialPublicKey),
        algorithm,
        signCount: 0,
        backupEligible: !!(registrationFlags(registration.response.attestationObject) & FLAG.BE)
      }
    });
    cases.push({
      name: `${name}: authentication`,
      kind: "assertion",
      ...assertion,
      accept,
      result: accept && {
        signCount: 0,
        userVerified: !!(assertion.response.authenticatorData[32] & FLAG.UV)
      }
    });
  }
  return cases;
}

// Changed copies of the vectors, each of which a verifier must refuse.
function changedVectorCases() {
  const none = vectorCeremonies(vector("16.2"));
  const ed25519 = vectorCeremonies(vector("16.11"));
  const rs256 = vectorCeremonies(vector("16.10"));
  const otherKey = hex(vector("16.7").credentialPublicKey);
  const reg = (name, response, expected = none.registration.expected) => ({
    name: `16.2 registration, ${name}`,
    kind: "registration",
    response: { ...none.registration.response, ...response },
    expected,
    accept: false
  });
  const get = (name, changes, base = none.assertion) => ({
    name,
    kind: "assertion",
    response: { ...base.response, ...changes.response },
    expected: changes.expected || base.expected,
    credential: changes.credential || base.credential,
    accept: false
  });
  const attestation = none.registration.response.attestationObject;
  const flipLast = buffer => {
    const copy = Buffer.from(buffer);
    copy[copy.length - 1] ^= 1;
    return copy;
  };
  return [
    reg("another challenge", {}, { ...example, challenge: b64u(Buffer.alloc(32)) }),
    reg("another origin", {}, { ...none.registration.expected, origin: "https://example.com" }),
    reg("another RP ID", {}, { ...none.registration.expected, rpId: "login.example.org" }),
    reg("client data of an authentication", { clientDataJSON: none.assertion.response.clientDataJSON }, none.assertion.expected),
    reg("truncated attestation object", { attestationObject: attestation.subarray(0, attestation.length - 1) }),
    reg("trailing byte after the attestation object", { attestationObject: Buffer.concat([attestation, Buffer.from([0])]) }),
    reg("user presence not set", { attestationObject: withRegistrationFlags(attestation, flags => flags & ~FLAG.UP) }),
    reg("no attested credential data", { attestationObject: withRegistrationFlags(attestation, flags => flags & ~FLAG.AT) }),
    reg("extension flag without extensions", { attestationObject: withRegistrationFlags(attestation, flags => flags | FLAG.ED) }),
    {
      name: "16.11 registration, backed up but not backup eligible",
      kind: "registration",
      response: {
        ...ed25519.registration.response,
        attestationObject: withRegistrationFlags(ed25519.registration.response.attestationObject, flags => flags | FLAG.BS)
      },
      expected: ed25519.registration.expected,
      accept: false
    },
    get("16.2 authentication, signature changed", { response: { signature: flipLast(none.assertion.response.signature) } }),
    get("16.10 authentication (RS256), signature changed", { response: { signature: flipLast(rs256.assertion.response.signature) } }, rs256.assertion),
    get("16.11 authentication (Ed25519), signature changed", { response: { signature: flipLast(ed25519.assertion.response.signature) } }, ed25519.assertion),
    get("16.2 authentication, empty signature", { response: { signature: Buffer.alloc(0) } }),
    get("16.2 authentication, another challenge", { expected: { ...example, challenge: b64u(Buffer.alloc(32)) } }),
    get("16.2 authentication, another origin", { expected: { ...none.assertion.expected, origin: "https://example.com" } }),
    get("16.2 authentication, another RP ID", { expected: { ...none.assertion.expected, rpId: "login.example.org" } }),
    get("16.2 authentication, client data of the registration", {
      response: { clientDataJSON: none.registration.response.clientDataJSON },
      expected: none.registration.expected
    }),
    get("16.2 authentication, stored counter ahead", { credential: { ...none.assertion.credential, signCount: 5 } }),
    get("16.2 authentication, another credential's key", { credential: { publicKey: otherKey, signCount: 0 } }),
    get("16.2 authentication, truncated authenticator data", {
      response: { authenticatorData: none.assertion.response.authenticatorData.subarray(0, 36) }
    }),
    get("16.2 authentication, flags changed after signing", {
      response: {
        authenticatorData: Buffer.concat([
          none.assertion.response.authenticatorData.subarray(0, 32),
          Buffer.from([none.assertion.response.authenticatorData[32] & ~FLAG.UV & ~FLAG.UP]),
          none.assertion.response.authenticatorData.subarray(33)
        ])
      }
    })
  ];
}

// Ceremonies of a software authenticator on the site's own relying party.
function authenticatorCases() {
  const cases = [];
  const expected = { challenge: b64u(crypto.randomBytes(32)), ...relyingParty };
  for (const kind of ["ES256", "EdDSA", "RS256"]) {
    const authenticator = softwareAuthenticator(kind);
    cases.push({
      name: `software ${kind}: registration`,
      kind: "registration",
      response: authenticator.create({ challenge: expected.challenge }),
      expected,
      accept: true,
      result: {
        id: authenticator.credentialId,
        publicKey: authenticator.publicKey,
        algorithm: { ES256: -7, EdDSA: -8, RS256: -257 }[kind],
        signCount: 0,
        backupEligible: false
      }
    });
    cases.push({
      name: `software ${kind}: authentication`,
      kind: "assertion",
      response: authenticator.get({ challenge: expected.challenge }),
      expected,
      credential: { publicKey: authenticator.publicKey, signCount: 0 },
      accept: true,
      result: { signCount: 1, userVerified: true }
    });
  }

  // Each case has its own authenticator, whose counter starts at 0 and advances by `advance` before signing.
  const signed = (name, { stored = 0, accept, result, create, ...options }) => {
    const authenticator = softwareAuthenticator("ES256");
    const challenge = b64u(crypto.randomBytes(32));
    if (create)
      return {
        name: `software: ${name}`,
        kind: "registration",
        response: authenticator.create({ challenge, ...options }),
        expected: { challenge, ...relyingParty },
        accept,
        result
      };
    return {
      name: `software: ${name}`,
      kind: "assertion",
      response: authenticator.get({ challenge, ...options }),
      expected: { challenge, ...relyingParty },
      credential: { publicKey: authenticator.publicKey, signCount: stored },
      accept,
      result
    };
  };
  cases.push(
    // Counters: a counter must increase, unless the authenticator has none (always 0)
    signed("counter increases", { stored: 7, advance: 8, accept: true, result: { signCount: 8, userVerified: true } }),
    signed("counter repeats", { stored: 8, advance: 8, accept: false }),
    signed("counter goes back", { stored: 9, advance: 8, accept: false }),
    signed("no counter (always 0)", { stored: 0, advance: 0, accept: true, result: { signCount: 0, userVerified: true } }),
    signed("counter reset to 0", { stored: 3, advance: 0, accept: false }),
    // Flags
    signed("user presence not set", { flags: FLAG.UV, accept: false }),
    signed("user not verified (preferred, not required)", {
      flags: FLAG.UP,
      accept: true,
      result: { signCount: 1, userVerified: false }
    }),
    signed("backup eligible and backed up", {
      flags: FLAG.UP | FLAG.UV | FLAG.BE | FLAG.BS,
      accept: true,
      result: { signCount: 1, userVerified: true }
    }),
    signed("backed up but not backup eligible", { flags: FLAG.UP | FLAG.UV | FLAG.BS, accept: false }),
    signed("registration backed up but not backup eligible", {
      create: true,
      flags: FLAG.UP | FLAG.AT | FLAG.BS,
      accept: false
    }),
    // Client data: unknown members are ignored; ceremonies in another site's frame are refused
    signed("client data with an unknown member", {
      clientDataExtra: { other_keys_can_be_added_here: "do not compare clientDataJSON against a template" },
      accept: true,
      result: { signCount: 1, userVerified: true }
    }),
    signed("cross-origin ceremony", { clientDataExtra: { crossOrigin: true }, accept: false }),
    // The origin and RP ID must be exactly the site's: oj.example.com
    signed("origin with another port", { origin: "https://oj.example.com:8443", accept: false }),
    signed("origin over HTTP", { origin: "http://oj.example.com", accept: false }),
    signed("origin of a subdomain", { origin: "https://sub.oj.example.com", accept: false }),
    signed("origin that only starts with the site's name", { origin: "https://oj.example.com.evil.test", accept: false }),
    signed("credential of the parent domain", { rpId: "example.com", accept: false })
  );
  return cases;
}

function conformanceCases() {
  return [...w3cCases(), ...changedVectorCases(), ...authenticatorCases()];
}

module.exports = { conformanceCases, vectors };
