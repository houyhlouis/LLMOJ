#!/usr/bin/env node
// Checks that a backup's key files decrypt the encrypted values saved in its database: users' AI settings
// (data/ai/master.key) and authenticator secrets (data/ai/two-factor.key). Neither a key nor a value is printed.
// Used by verify-backup.py. Input on stdin, as JSON:
//   { "aiKey": path, "twoFactorKey": path, "ai": [value], "twoFactor": [{ "userId": number, "value": string }] }
// Output on stdout, as JSON: { "ai": { "key", "checked", "failed" }, "twoFactor": { ... } } where "key" is
// "ok", "missing" or "invalid".
import fs from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** The 32-byte key in `file`, or the reason it can't be used. */
export function readKey(file) {
  let key;
  try {
    key = fs.readFileSync(file);
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'invalid';
  }
  return key.length === 32 ? key : 'invalid';
}

function decrypts(key, iv, tag, ciphertext, aad) {
  try {
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) return false;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).fill(0);
    return true;
  } catch {
    return false;
  }
}

/** As `decryptAiConfiguration` in apps/backend/src/ai/ai-crypto.ts: iv.tag.ciphertext in base64. */
export function decryptsAiConfiguration(key, value) {
  const parts = String(value).split('.');
  if (parts.length !== 3) return false;
  const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64'));
  // The backend refuses anything but canonical base64
  if ([iv, tag, ciphertext].some((decoded, index) => decoded.toString('base64') !== parts[index])) return false;
  return decrypts(key, iv, tag, ciphertext);
}

/** As `decryptSecret` in apps/backend/src/auth/two-factor/two-factor.service.ts: v1.iv.tag.ciphertext in base64url. */
export function decryptsTwoFactorSecret(key, userId, value) {
  const [version, ...parts] = String(value).split('.');
  if (version !== 'v1' || parts.length !== 3) return false;
  const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64url'));
  return decrypts(key, iv, tag, ciphertext, Buffer.from(`user_two_factor:${userId}`));
}

export function checkKeys(request) {
  const result = {};
  for (const [name, file, values, check] of [
    ['ai', request.aiKey, request.ai ?? [], (key, value) => decryptsAiConfiguration(key, value)],
    ['twoFactor', request.twoFactorKey, request.twoFactor ?? [], (key, item) => decryptsTwoFactorSecret(key, item.userId, item.value)]
  ]) {
    const key = readKey(file);
    if (typeof key === 'string') {
      result[name] = { key, checked: values.length, failed: values.length };
      continue;
    }
    const failed = values.filter(value => !check(key, value)).length;
    key.fill(0);
    result[name] = { key: 'ok', checked: values.length, failed };
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(checkKeys(JSON.parse(fs.readFileSync(0, 'utf8')))));
  } catch {
    console.error(JSON.stringify({ error: 'KEY_CHECK_FAILED' }));
    process.exit(1);
  }
}
