import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

// RFC 6238 time-based one-time passwords with the parameters every authenticator app supports.
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const TOTP_MODULUS = 10 ** TOTP_DIGITS;
// Codes of the previous and next period are accepted for clock drift.
const TOTP_WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(data: Buffer): string {
  let result = "";
  let bits = 0;
  let value = 0;
  for (const byte of data) {
    // eslint-disable-next-line no-bitwise
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      // eslint-disable-next-line no-bitwise
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // eslint-disable-next-line no-bitwise
  if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

/** Decodes unpadded base32, ignoring case and spaces. Returns null for invalid input. */
export function base32Decode(text: string): Buffer | null {
  const normalized = text.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z2-7]*$/.test(normalized)) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of normalized) {
    // eslint-disable-next-line no-bitwise
    value = (value << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      // eslint-disable-next-line no-bitwise
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** RFC 4226 HMAC-based one-time password. */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  // eslint-disable-next-line no-bitwise
  const offset = digest[digest.length - 1] & 15;
  // eslint-disable-next-line no-bitwise
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % TOTP_MODULUS).padStart(TOTP_DIGITS, "0");
}

export function totpTimeStep(time = Date.now()): number {
  return Math.floor(time / 1000 / TOTP_PERIOD_SECONDS);
}

/** Returns the time step the code belongs to, or null if it is not valid now. */
export function verifyTotp(secret: Buffer, code: string, time = Date.now()): number | null {
  if (typeof code !== "string" || !new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)) return null;
  const current = totpTimeStep(time);
  let matched: number = null;
  // Compare every candidate so the response time does not depend on which one matches.
  for (let step = Math.max(0, current - TOTP_WINDOW); step <= current + TOTP_WINDOW; step++)
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) matched = step;
  return matched;
}

/** The otpauth:// URI authenticator apps import from a QR code. */
export function totpUri(secret: Buffer, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const parameters = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });
  return `otpauth://totp/${label}?${parameters.toString().replace(/\+/g, "%20")}`;
}

// One-time recovery codes: 80 random bits each, shown once and stored only as SHA-256 hashes.
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    base32Encode(randomBytes(10)).toLowerCase().match(/.{4}/g).join("-")
  );
}

export function hashRecoveryCode(code: string): string | null {
  const normalized = typeof code === "string" ? code.replace(/[\s-]+/g, "").toUpperCase() : "";
  if (!/^[A-Z2-7]{16}$/.test(normalized)) return null;
  return createHash("sha256").update(normalized).digest("hex");
}
