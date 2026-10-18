// deploy/backup-keys.mjs recognizes values encrypted by the backend's own code (AI settings with master.key,
// authenticator secrets with two-factor.key) and prints neither keys nor values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkKeys, decryptsAiConfiguration, decryptsTwoFactorSecret } from '../backup-keys.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/backend/package.json'));
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
        experimentalDecorators: true, emitDecoratorMetadata: true }
    }).outputText,
    filename
  );
const { encryptAiConfiguration } = require(path.join(root, 'apps/backend/src/ai/ai-crypto.ts'));
const { TwoFactorService } = require(path.join(root, 'apps/backend/src/auth/two-factor/two-factor.service.ts'));
const encryptTwoFactor = (key, userId, secret) =>
  TwoFactorService.prototype.encryptSecret.call({ encryptionKey: async () => key }, userId, secret);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-keys-test-'));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const keyFile = (name, bytes) => {
  const file = path.join(directory, name);
  fs.writeFileSync(file, bytes);
  return file;
};

test('values the backend encrypted are recognized with their key only', async () => {
  const aiKey = randomBytes(32), twoFactorKey = randomBytes(32), other = randomBytes(32);
  const ai = [encryptAiConfiguration(aiKey, { apiKey: 'sk-secret' }), encryptAiConfiguration(aiKey, { searchKey: 'x' })];
  const secret = await encryptTwoFactor(twoFactorKey, 7, Buffer.from('totp secret'));
  assert(decryptsAiConfiguration(aiKey, ai[0]));
  assert(!decryptsAiConfiguration(other, ai[0]));
  const [iv, tag, ciphertext] = ai[0].split('.');
  const flipped = tag[0] === 'A' ? 'B' + tag.slice(1) : 'A' + tag.slice(1);
  assert(!decryptsAiConfiguration(aiKey, [iv, flipped, ciphertext].join('.')));
  // The same bytes in non-canonical base64 (a padding bit of the 16-byte tag set), which the backend refuses too
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padded = tag.slice(0, 21) + alphabet[alphabet.indexOf(tag[21]) ^ 1] + tag.slice(22);
  assert.deepEqual(Buffer.from(padded, 'base64'), Buffer.from(tag, 'base64'));
  assert(!decryptsAiConfiguration(aiKey, [iv, padded, ciphertext].join('.')));
  assert(decryptsTwoFactorSecret(twoFactorKey, 7, secret));
  // The user ID is part of what's authenticated
  assert(!decryptsTwoFactorSecret(twoFactorKey, 8, secret));
  assert(!decryptsTwoFactorSecret(aiKey, 7, secret));
  assert(!decryptsAiConfiguration(aiKey, 'not.encrypted'));

  assert.deepEqual(checkKeys({
    aiKey: keyFile('master.key', aiKey), twoFactorKey: keyFile('two-factor.key', twoFactorKey),
    ai, twoFactor: [{ userId: 7, value: secret }]
  }), { ai: { key: 'ok', checked: 2, failed: 0 }, twoFactor: { key: 'ok', checked: 1, failed: 0 } });
  assert.deepEqual(checkKeys({
    aiKey: keyFile('other.key', other), twoFactorKey: path.join(directory, 'missing.key'), ai, twoFactor: [{ userId: 7, value: secret }]
  }), { ai: { key: 'ok', checked: 2, failed: 2 }, twoFactor: { key: 'missing', checked: 1, failed: 1 } });
  assert.equal(checkKeys({ aiKey: keyFile('short.key', aiKey.subarray(1)), ai }).ai.key, 'invalid');
  assert.deepEqual(checkKeys({ aiKey: keyFile('master.key', aiKey) }).ai, { key: 'ok', checked: 0, failed: 0 });
});

test('the command prints counts only', () => {
  const key = randomBytes(32);
  const value = encryptAiConfiguration(key, { apiKey: 'sk-printed-never' });
  const result = spawnSync(process.execPath, [path.join(root, 'deploy/backup-keys.mjs')], {
    input: JSON.stringify({ aiKey: keyFile('cli.key', key), twoFactorKey: path.join(directory, 'none'), ai: [value], twoFactor: [] }),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ai: { key: 'ok', checked: 1, failed: 0 }, twoFactor: { key: 'missing', checked: 0, failed: 0 }
  });
  assert(!result.stdout.includes(value) && !result.stdout.includes(key.toString('base64')));
  const invalid = spawnSync(process.execPath, [path.join(root, 'deploy/backup-keys.mjs')], { input: 'not json', encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
});
