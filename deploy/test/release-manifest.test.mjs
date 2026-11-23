import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installSource, writeManifest } from '../release-manifest.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const present = fs.existsSync(path.join(repository, '.git'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(root, name, contents) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), contents);
}
function build(root, program) {
  put(root, 'apps/backend/dist/main.js', program);
  put(root, 'public/offline-manifest.json', '{"files":[]}');
  fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
}
const manifestPath = 'deploy/release-manifest.json';

test('a build of a clean checkout records its actual HEAD and refuses to attribute a dirty rebuild to it',
  { skip: !present && 'requires a source checkout' }, t => {
    // Borrow the local commit objects, but give the snapshot its own HEAD, working tree and index.
    const root = temporary(t);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    t.mock.property(process, 'env', env);
    const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('clone', '--quiet', '--local', '--shared', '--', repository, root);
    const input = installSource(root, root);
    assert.equal(input.commit, git('-C', root, 'rev-parse', 'HEAD'));
    assert.equal(input.kind, 'checkout');
    assert.match(input.treeSha256, /^[0-9a-f]{64}$/);
    const program = fs.readFileSync(path.join(root, 'apps/judge/index.mjs'));
    build(root, program);
    const before = writeManifest(root, 'all', input);
    assert.equal(before.artifacts.backend, sha(Buffer.concat([Buffer.from('main.js\0'), program, Buffer.from('\0')])));
    assert.equal(before.artifacts.frontend, sha('{"files":[]}'));
    assert.match(before.artifacts.judgeProgram, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, manifestPath))).source.commit, input.commit);
    // A checkout of a pre-manifest release does not yet ignore the output.
    fs.unlinkSync(path.join(root, manifestPath));
    assert.deepEqual(installSource(root, root), input);
    fs.appendFileSync(path.join(root, 'apps/judge/index.mjs'), '\n// local modification\n');
    const dirty = installSource(root, root);
    assert.equal(dirty.kind, 'dirty');
    assert.equal(dirty.commit, null);
    assert.notEqual(writeManifest(root, 'all', dirty).artifacts.judgeProgram, before.artifacts.judgeProgram);
  });

test('an installed tree without a source handoff records artifacts and unknown provenance; a web build has no local judge', t => {
  const root = temporary(t);
  const key = 'OJ_SOURCE_TREE_SHA256', saved = process.env[key];
  delete process.env[key];
  t.after(() => { if (saved !== undefined) process.env[key] = saved; });
  build(root, 'standalone');
  const source = installSource(root, root);
  assert.deepEqual(source, { kind: 'unknown', repository: null, commit: null, treeSha256: null, archiveSha256: null });
  const manifest = writeManifest(root, 'web', { ...source, password: 'PRIVATE_FIXTURE', path: root });
  assert.equal(manifest.artifacts.judgeProgram, null);
  const file = path.join(root, manifestPath);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(!content.includes(root));
  assert.ok(!content.includes('PRIVATE_FIXTURE'));
  assert.deepEqual(JSON.parse(content), manifest);
  assert.throws(() => writeManifest(root, 'web', { kind: 'github', repository: root, commit: 'PRIVATE_FIXTURE' }));
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

test('the GitHub installer binds its resolved commit and archive to the extracted tree copied for the build', t => {
  const source = temporary(t), target = temporary(t);
  for (const root of [source, target]) put(root, 'input.js', 'release');
  const tree = execFileSync('python3', ['-B', path.join(repository, 'deploy/upgrade.py'),
    '--source', source, '--source-digest'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const env = { OJ_SOURCE_TREE_SHA256: tree, OJ_SOURCE_COMMIT: '1'.repeat(40),
    OJ_SOURCE_REPOSITORY: 'synthetic/repository', OJ_SOURCE_ARCHIVE_SHA256: sha('synthetic archive') };
  for (const [name, value] of Object.entries(env)) {
    const old = process.env[name];
    process.env[name] = value;
    t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
  }
  const identity = installSource(source, target);
  build(target, 'compiled release');
  const manifest = writeManifest(target, 'web', identity);
  assert.deepEqual(manifest.source, { kind: 'github', repository: env.OJ_SOURCE_REPOSITORY, commit: env.OJ_SOURCE_COMMIT,
    treeSha256: tree, archiveSha256: env.OJ_SOURCE_ARCHIVE_SHA256 });
  assert.throws(() => { put(target, 'input.js', 'changed'); installSource(source, target); }, /differs from build input/);
  put(source, 'input.js', 'changed');
  assert.throws(() => installSource(source, target), /changed after extraction/);
});
