// Test fixtures: a CBOR encoder and a software WebAuthn authenticator.
const crypto = require("node:crypto");

// A minimal CBOR encoder for test fixtures.
function cbor(value) {
  const head = (major, length) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    if (length < 65536) {
      const buffer = Buffer.alloc(3);
      buffer[0] = (major << 5) | 25;
      buffer.writeUInt16BE(length, 1);
      return buffer;
    }
    const buffer = Buffer.alloc(5);
    buffer[0] = (major << 5) | 26;
    buffer.writeUInt32BE(length, 1);
    return buffer;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map)
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
  throw new Error("unsupported fixture value");
}

const sha256 = data => crypto.createHash("sha256").update(data).digest();
const relyingParty = { origin: "https://oj.example.com", rpId: "oj.example.com" };

function softwareAuthenticator(kind, defaults = relyingParty) {
  const generated =
    kind === "ES256"
      ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
      : kind === "EdDSA"
      ? crypto.generateKeyPairSync("ed25519")
      : crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = generated.publicKey.export({ format: "jwk" });
  const b = value => Buffer.from(value, "base64url");
  const cose =
    kind === "ES256"
      ? new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, b(jwk.x)],
          [-3, b(jwk.y)]
        ])
      : kind === "EdDSA"
      ? new Map([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, b(jwk.x)]
        ])
      : new Map([
          [1, 3],
          [3, -257],
          [-1, b(jwk.n)],
          [-2, b(jwk.e)]
        ]);
  const credentialId = crypto.randomBytes(32);
  let counter = 0;
  const authenticatorData = (rpId, flags, attested) => {
    const head = Buffer.alloc(37);
    sha256(rpId).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(counter, 33);
    if (!attested) return head;
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), length, credentialId, cbor(cose)]);
  };
  const clientData = (type, challenge, origin = defaults.origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    credentialId,
    create({ challenge, rpId = defaults.rpId, origin, flags = 0x41 }) {
      return {
        clientDataJSON: clientData("webauthn.create", challenge, origin),
        attestationObject: cbor(
          new Map([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", authenticatorData(rpId, flags, true)]
          ])
        )
      };
    },
    get({ challenge, rpId = defaults.rpId, origin, flags = 0x05, advance = 1 }) {
      counter += advance;
      const data = authenticatorData(rpId, flags, false);
      const clientDataJSON = clientData("webauthn.get", challenge, origin);
      const signed = Buffer.concat([data, sha256(clientDataJSON)]);
      const signature =
        kind === "EdDSA"
          ? crypto.sign(null, signed, generated.privateKey)
          : crypto.sign("sha256", signed, generated.privateKey);
      return { clientDataJSON, authenticatorData: data, signature };
    }
  };
}

module.exports = { cbor, relyingParty, sha256, softwareAuthenticator };
