import { createHash, createPublicKey, KeyObject, timingSafeEqual, verify } from "crypto";

// The parts of WebAuthn Level 2 (https://www.w3.org/TR/webauthn-2/) a relying party needs to register
// passkeys as a second sign-in factor and to verify their assertions. Attestation statements are not
// verified: registration requests `attestation: "none"`, so authenticators are not identified.

export class WebAuthnError extends Error {}

export const WEBAUTHN_ALGORITHMS = Object.freeze({ ES256: -7, EdDSA: -8, RS256: -257 });
const SUPPORTED_ALGORITHMS: number[] = Object.values(WEBAUTHN_ALGORITHMS);

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_CREDENTIAL = 0x40;
const FLAG_EXTENSIONS = 0x80;

export function base64url(data: Buffer): string {
  return data.toString("base64url");
}

export function fromBase64url(text: unknown, maxBytes = 65536): Buffer {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length > Math.ceil((maxBytes * 4) / 3))
    throw new WebAuthnError("Invalid base64url data");
  return Buffer.from(text, "base64url");
}

function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// A CBOR (RFC 8949) decoder for the definite-length items WebAuthn uses. Maps decode to Map objects,
// so integer COSE labels keep their type.
const MAX_CBOR_DEPTH = 16;

function cborLength(data: Buffer, offset: number, additional: number): [length: number, next: number] {
  if (additional < 24) return [additional, offset];
  const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[additional];
  if (!size || offset + size > data.length) throw new WebAuthnError("Unsupported or truncated CBOR length");
  const value = size === 8 ? data.readBigUInt64BE(offset) : BigInt(data.readUIntBE(offset, size));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError("CBOR value too large");
  return [Number(value), offset + size];
}

function decodeHalfFloat(half: number): number {
  // eslint-disable-next-line no-bitwise
  const exponent = (half >> 10) & 31;
  // eslint-disable-next-line no-bitwise
  const fraction = half & 1023;
  // eslint-disable-next-line no-bitwise
  const sign = half & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function decodeCborItem(data: Buffer, offset: number, depth: number): [value: unknown, next: number] {
  if (depth > MAX_CBOR_DEPTH) throw new WebAuthnError("CBOR nesting too deep");
  if (offset >= data.length) throw new WebAuthnError("Truncated CBOR");
  // eslint-disable-next-line no-bitwise
  const major = data[offset] >> 5;
  // eslint-disable-next-line no-bitwise
  const additional = data[offset] & 31;
  if (major === 7) {
    const simple = { 20: false, 21: true, 22: null as null, 23: undefined as undefined };
    if (additional in simple) return [simple[additional], offset + 1];
    const size = { 25: 2, 26: 4, 27: 8 }[additional];
    if (!size || offset + 1 + size > data.length) throw new WebAuthnError("Unsupported CBOR simple value");
    const value =
      size === 2
        ? decodeHalfFloat(data.readUInt16BE(offset + 1))
        : size === 4
          ? data.readFloatBE(offset + 1)
          : data.readDoubleBE(offset + 1);
    return [value, offset + 1 + size];
  }
  const [length, next] = cborLength(data, offset + 1, additional);
  switch (major) {
    case 0:
      return [length, next];
    case 1:
      return [-1 - length, next];
    case 2:
    case 3: {
      if (next + length > data.length) throw new WebAuthnError("Truncated CBOR string");
      const bytes = data.subarray(next, next + length);
      return [major === 2 ? Buffer.from(bytes) : bytes.toString("utf8"), next + length];
    }
    case 4: {
      const array: unknown[] = [];
      let position = next;
      for (let i = 0; i < length; i++) {
        const [value, after] = decodeCborItem(data, position, depth + 1);
        array.push(value);
        position = after;
      }
      return [array, position];
    }
    case 5: {
      const map = new Map<unknown, unknown>();
      let position = next;
      for (let i = 0; i < length; i++) {
        const [key, afterKey] = decodeCborItem(data, position, depth + 1);
        if (typeof key !== "number" && typeof key !== "string") throw new WebAuthnError("Unsupported CBOR map key");
        if (map.has(key)) throw new WebAuthnError("Duplicate CBOR map key");
        const [value, afterValue] = decodeCborItem(data, afterKey, depth + 1);
        map.set(key, value);
        position = afterValue;
      }
      return [map, position];
    }
    case 6:
      // Tags carry no meaning for WebAuthn structures; keep the tagged value.
      return decodeCborItem(data, next, depth + 1);
    default:
      throw new WebAuthnError("Unsupported CBOR item");
  }
}

/** Decodes exactly one CBOR item. */
export function decodeCbor(data: Buffer): unknown {
  const [value, next] = decodeCborItem(data, 0, 0);
  if (next !== data.length) throw new WebAuthnError("Trailing data after CBOR item");
  return value;
}

export interface AuthenticatorData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  signCount: number;
  credential?: { aaguid: Buffer; id: Buffer; publicKey: Buffer };
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) throw new WebAuthnError("Authenticator data too short");
  const flags = data[32];
  const result: AuthenticatorData = {
    rpIdHash: data.subarray(0, 32),
    // eslint-disable-next-line no-bitwise
    userPresent: !!(flags & FLAG_USER_PRESENT),
    // eslint-disable-next-line no-bitwise
    userVerified: !!(flags & FLAG_USER_VERIFIED),
    // eslint-disable-next-line no-bitwise
    backupEligible: !!(flags & FLAG_BACKUP_ELIGIBLE),
    // eslint-disable-next-line no-bitwise
    backedUp: !!(flags & FLAG_BACKED_UP),
    signCount: data.readUInt32BE(33)
  };
  let offset = 37;
  // eslint-disable-next-line no-bitwise
  if (flags & FLAG_ATTESTED_CREDENTIAL) {
    if (data.length < offset + 18) throw new WebAuthnError("Attested credential data too short");
    const aaguid = data.subarray(offset, offset + 16);
    const idLength = data.readUInt16BE(offset + 16);
    offset += 18;
    if (idLength < 1 || idLength > 1023 || data.length < offset + idLength)
      throw new WebAuthnError("Invalid credential ID length");
    const id = data.subarray(offset, offset + idLength);
    offset += idLength;
    const [, keyEnd] = decodeCborItem(data, offset, 0);
    result.credential = { aaguid, id: Buffer.from(id), publicKey: Buffer.from(data.subarray(offset, keyEnd)) };
    offset = keyEnd;
  }
  // eslint-disable-next-line no-bitwise
  if (flags & FLAG_EXTENSIONS) [, offset] = decodeCborItem(data, offset, 0);
  if (offset !== data.length) throw new WebAuthnError("Trailing authenticator data");
  return result;
}

/** Converts a COSE_Key (RFC 9053) of a supported algorithm into a public key. */
export function coseToPublicKey(cose: Buffer): { key: KeyObject; algorithm: number } {
  const map = decodeCbor(cose);
  if (!(map instanceof Map)) throw new WebAuthnError("COSE key is not a map");
  const kty = map.get(1);
  const algorithm = map.get(3);
  if (typeof algorithm !== "number" || !SUPPORTED_ALGORITHMS.includes(algorithm))
    throw new WebAuthnError("Unsupported credential algorithm");
  const bytes = (label: number, length?: number) => {
    const value = map.get(label);
    if (!Buffer.isBuffer(value) || (length != null && value.length !== length))
      throw new WebAuthnError("Invalid COSE key parameter");
    return value.toString("base64url");
  };
  let jwk: Record<string, string>;
  if (algorithm === WEBAUTHN_ALGORITHMS.ES256 && kty === 2 && map.get(-1) === 1)
    jwk = { kty: "EC", crv: "P-256", x: bytes(-2, 32), y: bytes(-3, 32) };
  else if (algorithm === WEBAUTHN_ALGORITHMS.EdDSA && kty === 1 && map.get(-1) === 6)
    jwk = { kty: "OKP", crv: "Ed25519", x: bytes(-2, 32) };
  else if (algorithm === WEBAUTHN_ALGORITHMS.RS256 && kty === 3) {
    jwk = { kty: "RSA", n: bytes(-1), e: bytes(-2) };
    if (Buffer.from(jwk.n, "base64url").length < 256) throw new WebAuthnError("RSA key shorter than 2048 bits");
  } else throw new WebAuthnError("COSE key does not match its algorithm");
  try {
    return { key: createPublicKey({ key: jwk, format: "jwk" }), algorithm };
  } catch {
    throw new WebAuthnError("Invalid public key");
  }
}

function verifySignature(algorithm: number, key: KeyObject, data: Buffer, signature: Buffer): boolean {
  try {
    if (algorithm === WEBAUTHN_ALGORITHMS.ES256) return verify("sha256", data, { key, dsaEncoding: "der" }, signature);
    if (algorithm === WEBAUTHN_ALGORITHMS.RS256) return verify("sha256", data, key, signature);
    if (algorithm === WEBAUTHN_ALGORITHMS.EdDSA) return verify(null, data, key, signature);
  } catch {
    return false;
  }
  return false;
}

/**
 * The relying party for a browser origin. WebAuthn requires a secure context: HTTPS, or HTTP on localhost.
 * IP addresses cannot be relying party IDs. Returns null when passkeys cannot be used from this origin.
 */
export function relyingPartyForOrigin(origin: unknown): { origin: string; rpId: string } | null {
  if (typeof origin !== "string" || origin.length > 300) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  const host = url.hostname;
  const local = host === "localhost" || host.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return null;
  return { origin, rpId: host };
}

export interface CeremonyExpectation {
  challenge: string;
  origin: string;
  rpId: string;
}

function checkClientData(clientDataJSON: Buffer, type: string, expected: CeremonyExpectation) {
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    clientData = JSON.parse(clientDataJSON.toString("utf8"));
  } catch {
    throw new WebAuthnError("Invalid client data");
  }
  if (clientData?.type !== type) throw new WebAuthnError("Unexpected ceremony type");
  if (
    typeof clientData.challenge !== "string" ||
    !sameBytes(Buffer.from(clientData.challenge), Buffer.from(expected.challenge))
  )
    throw new WebAuthnError("Challenge mismatch");
  if (clientData.origin !== expected.origin) throw new WebAuthnError("Origin mismatch");
  if (clientData.crossOrigin === true) throw new WebAuthnError("Cross-origin ceremonies are not accepted");
}

function checkAuthenticatorData(authenticatorData: AuthenticatorData, rpId: string) {
  if (!sameBytes(authenticatorData.rpIdHash, sha256(rpId))) throw new WebAuthnError("Relying party mismatch");
  if (!authenticatorData.userPresent) throw new WebAuthnError("User presence was not confirmed");
}

export interface RegisteredCredential {
  id: Buffer;
  publicKey: Buffer;
  algorithm: number;
  signCount: number;
  backupEligible: boolean;
}

/** Verifies a navigator.credentials.create() response. */
export function verifyRegistration(
  response: { clientDataJSON: Buffer; attestationObject: Buffer },
  expected: CeremonyExpectation
): RegisteredCredential {
  checkClientData(response.clientDataJSON, "webauthn.create", expected);
  const attestation = decodeCbor(response.attestationObject);
  if (!(attestation instanceof Map) || typeof attestation.get("fmt") !== "string")
    throw new WebAuthnError("Invalid attestation object");
  const authData = attestation.get("authData");
  if (!Buffer.isBuffer(authData)) throw new WebAuthnError("Missing authenticator data");
  const parsed = parseAuthenticatorData(authData);
  checkAuthenticatorData(parsed, expected.rpId);
  if (!parsed.credential) throw new WebAuthnError("No credential was created");
  const { algorithm } = coseToPublicKey(parsed.credential.publicKey);
  return {
    id: parsed.credential.id,
    publicKey: parsed.credential.publicKey,
    algorithm,
    signCount: parsed.signCount,
    backupEligible: parsed.backupEligible
  };
}

/** Verifies a navigator.credentials.get() response for a stored credential; returns its new signature counter. */
export function verifyAssertion(
  response: { clientDataJSON: Buffer; authenticatorData: Buffer; signature: Buffer },
  expected: CeremonyExpectation,
  credential: { publicKey: Buffer; signCount: number }
): { signCount: number; userVerified: boolean } {
  checkClientData(response.clientDataJSON, "webauthn.get", expected);
  const parsed = parseAuthenticatorData(response.authenticatorData);
  checkAuthenticatorData(parsed, expected.rpId);
  const { key, algorithm } = coseToPublicKey(credential.publicKey);
  const signed = Buffer.concat([response.authenticatorData, sha256(response.clientDataJSON)]);
  if (!verifySignature(algorithm, key, signed, response.signature)) throw new WebAuthnError("Invalid signature");
  // A counter that does not increase may mean the authenticator was cloned. Synced passkeys always report 0.
  if ((parsed.signCount !== 0 || credential.signCount !== 0) && parsed.signCount <= credential.signCount)
    throw new WebAuthnError("Signature counter did not increase");
  return { signCount: parsed.signCount, userVerified: parsed.userVerified };
}
