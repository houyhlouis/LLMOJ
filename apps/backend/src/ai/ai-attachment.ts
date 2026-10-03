import { createHmac, timingSafeEqual } from "crypto";

import { AiError } from "./ai.types";

export interface AiAttachment {
  ownerId: number;
  uuid: string;
  filename: string;
  size: number;
  expires: number;
}
export function signAiAttachment(key: Buffer, value: AiAttachment): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(`hyhoj-ai-attachment-v1:${payload}`).digest("base64url")}`;
}
export function readAiAttachment(key: Buffer, token: string, ownerId: number, admittedAt = Date.now()): AiAttachment {
  try {
    const [payload, signature, ...rest] = token.split(".");
    if (rest.length || !payload || !signature || token.length > 4096) throw new Error();
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", key).update(`hyhoj-ai-attachment-v1:${payload}`).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const value = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (
      value.ownerId !== ownerId ||
      !Number.isSafeInteger(value.expires) ||
      !Number.isFinite(admittedAt) ||
      value.expires < admittedAt ||
      !/^[0-9a-f-]{36}$/i.test(value.uuid) ||
      typeof value.filename !== "string" ||
      value.filename.length > 256 ||
      // eslint-disable-next-line no-control-regex -- Explicitly reject or remove control bytes from untrusted names and text.
      !/^([^/\\\x00-\x1f]+)\.zip$/i.test(value.filename) ||
      !Number.isSafeInteger(value.size) ||
      value.size < 22 ||
      value.size > 67108864
    )
      throw new Error();
    return value;
  } catch {
    throw new AiError("INVALID_ATTACHMENT_TOKEN");
  }
}
