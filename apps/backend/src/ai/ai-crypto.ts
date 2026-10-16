import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

import { AiConfiguration } from "./ai.types";

import { loadServiceKey } from "../common/service-key";

/** Load the existing key in place; a missing key must never silently replace one protecting stored configuration. */
export async function loadAiEncryptionKey(directory: string, hasStoredConfiguration: boolean): Promise<Buffer> {
  return await loadServiceKey(directory, "master.key", "AI encryption key", hasStoredConfiguration);
}

/** Keep the original iv.tag.ciphertext format so saved LLM and search credentials require no migration. */
export function encryptAiConfiguration(key: Buffer, value: AiConfiguration): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString("base64")).join(".");
}

export function decryptAiConfiguration(key: Buffer, value: string): AiConfiguration {
  try {
    const parts = value.split(".");
    if (parts.length !== 3) throw new Error();
    const [iv, tag, ciphertext] = parts.map(part => {
      const decoded = Buffer.from(part, "base64");
      if (decoded.toString("base64") !== part) throw new Error();
      return decoded;
    });
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return JSON.parse(plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
  } catch {
    // Do not expose parser excerpts, crypto internals, ciphertext, or plaintext in exceptions or logs.
    throw new Error("Invalid AI encrypted configuration");
  }
}
