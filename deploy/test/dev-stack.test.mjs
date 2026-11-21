import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  backendConfig, backendEnvironment, checkPorts, contributorExample, launchService, loadBackendConfig, newSecrets, openState, parseOptions,
  portsFor, run, stopServices, viteOptions
} from '../dev/stack.mjs';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-dev-test-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

test('CLI selects a private seven-port range and rejects invalid commands, ports and options', () => {
  assert.ok(parseOptions(['start']).dir.endsWith('/.dev-stack'));
  assert.deepEqual(parseOptions(['start', '--dir', './stack', '--base-port', '65000']), {
    command: 'start', dir: path.resolve('./stack'), base: 65000
  });
  assert.deepEqual(Object.values(portsFor(65529)), [65529, 65530, 65531, 65532, 65533, 65534, 65535]);
  for (const args of [[], ['purge'], ['reset', 'extra'], ['start', '--dir'], ['start', '--dir', ''],
    ['start', '--base-port', '2e4'], ['start', '--base-port', '65530'], ['start', '--base-port', '80'],
    ['stop', '--base-port', '28400'], ['start', '--db', 'production']]) assert.throws(() => parseOptions(args));
});

test('backend example becomes a single-process, loopback config with per-stack credentials', () => {
  const p = portsFor(28400);
  const secrets = newSecrets();
  assert.equal(new Set(Object.values(secrets)).size, Object.values(secrets).length);
  assert.notDeepEqual(newSecrets(), secrets);
  const config = backendConfig(p, secrets);
  assert.deepEqual(config.server, { hostname: '127.0.0.1', port: p.backend, trustProxy: ['loopback'], clusters: null });
  assert.deepEqual(config.metrics, { hostname: '127.0.0.1', basePort: p.metrics, allowedIps: ['127.0.0.1'] });
  assert.deepEqual(config.services.database, { type: 'mariadb', host: '127.0.0.1', port: p.mariadb, database: 'llmoj_dev',
    username: 'llmoj_dev', password: secrets.database });
  const cache = new URL(config.services.redis);
  assert.deepEqual([cache.hostname, Number(cache.port), cache.password], ['127.0.0.1', p.redis, secrets.redis]);
  assert.equal(config.services.minio.default.endpoint, 'http://127.0.0.1:' + p.minio);
  assert.equal(config.services.minio.secretKey, secrets.minio);
  assert.deepEqual(config.services.mail.transport, { jsonTransport: true });
  assert.ok(config.resourceLimit.problemTestcases > 0);
  assert.doesNotMatch(JSON.stringify(config), /CHANGE_THIS|REPLACE_WITH_|libreoj\.test/);
});

test('a restart preserves contributor settings and rejects a changed database target', t => {
  const dir = temporary(t);
  const expected = backendConfig(portsFor(28400), newSecrets());
  assert.deepEqual(loadBackendConfig(dir, expected), expected);
  const file = path.join(dir, 'backend.yaml');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const edited = structuredClone(expected);
  edited.security.rateLimit = null;
  fs.writeFileSync(file, JSON.stringify(edited));
  assert.deepEqual(loadBackendConfig(dir, expected), edited);
  edited.services.database.port = 31003;
  fs.writeFileSync(file, JSON.stringify(edited));
  assert.throws(() => loadBackendConfig(dir, expected), /services settings/);
});

test('contributor statement references a runnable sample and two different hidden input/output pairs', () => {
  const { sections, samples, files, content } = contributorExample;
  const sample = samples[sections.find(s => s.type === 'Sample').sampleId];
  assert.equal(Number(sample.outputData), 2 * Number(sample.inputData));
  const inputs = Object.keys(files).filter(name => name.endsWith('.in'));
  assert.equal(inputs.length, 2);
  assert.equal(Object.keys(files).length, 4);
  for (const name of inputs) assert.equal(Number(files[name.replace('.in', '.out')]), 2 * Number(files[name]));
  assert.equal(content.language, 'cpp');
});

test('frontend proxies HTTP and socket upgrades and restricts its sources to frontend assets', () => {
  const p = portsFor(31000);
  const config = viteOptions('/private/stack', p);
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.server.port, p.frontend);
  assert.equal(config.server.strictPort, true);
  assert.deepEqual(config.server.proxy['/api'], { target: 'http://127.0.0.1:31000', ws: true });
  assert.ok(config.configFile.endsWith('packages/frontend/vite.config.ts'));
  assert.ok(config.server.fs.allow.includes(config.cacheDir));
  assert.ok(!config.server.fs.allow.includes('/private/stack'));
});

test('backend shell environment confines AI/temporary data, including paths with spaces or quotes', t => {
  const dir = path.join(temporary(t), "user's private stack");
  const env = path.join(path.dirname(dir), 'backend.env');
  fs.writeFileSync(env, backendEnvironment(dir));
  const child = spawnSync('sh', ['-c', '. "$1" && printf "%s\n" "$LIBREOJ_CONFIG_FILE" "$TMPDIR" "$HYHOJ_AI_STATE_DIR" "$HYHOJ_AI_RUNNER_SOCKET" "$LIBREOJ_SCHEMA_SYNC" "$LIBREOJ_MIGRATION_CONFIG_FILE"', 'test', env],
    { encoding: 'utf8', env: { LIBREOJ_MIGRATION_CONFIG_FILE: '/some/other/db', PATH: process.env.PATH } });
  assert.equal(child.status, 0);
  assert.deepEqual(child.stdout.split('\n').slice(0, -1), [path.join(dir, 'backend.yaml'), path.join(dir, 'tmp'),
    path.join(dir, 'ai'), path.join(dir, 'ai-runner.sock'), '0', '']);
});

test('checks all loopback ports, releases successful probes, identifies the occupied service', async () => {
  const events = [];
  const ports = portsFor(28400);
  const probe = occupied => () => {
    const server = new EventEmitter();
    let port;
    server.listen = options => {
      port = options.port;
      assert.equal(options.host, '127.0.0.1');
      assert.equal(options.exclusive, true);
      events.push(port);
      queueMicrotask(() => port === occupied ? server.emit('error', Object.assign(new Error(), { code: 'EADDRINUSE' })) : server.emit('listening'));
    };
    server.close = done => { events.push(-port); done(); };
    return server;
  };
  await checkPorts(ports, probe());
  assert.deepEqual(events, Object.values(ports).flatMap(p => [p, -p]));
  events.length = 0;
  await assert.rejects(checkPorts(ports, probe(ports.redis)), /redis port 127\.0\.0\.1:28404 \(EADDRINUSE\)/);
  assert.deepEqual(events, [...[28400, 28401, 28402, 28403].flatMap(p => [p, -p]), 28404]);
});

test('markers preserve secrets/ports across restarts and refuse unrelated or moved directories', t => {
  const dir = temporary(t);
  assert.throws(() => openState(dir, false), /existing LLMOJ dev stack marker/);
  const state = openState(dir, true, 29500);
  assert.equal(fs.statSync(path.join(dir, 'llmoj-dev.json')).mode & 0o777, 0o600);
  assert.deepEqual(openState(dir, true), state);
  assert.throws(() => openState(dir, true, 32000), /different base port/);
  const other = temporary(t);
  fs.writeFileSync(path.join(other, 'unrelated'), '');
  assert.throws(() => openState(other, true), /empty directory/);
  fs.copyFileSync(path.join(dir, 'llmoj-dev.json'), path.join(other, 'llmoj-dev.json'));
  assert.throws(() => openState(other, false), /moved/);
});

test('stop uses its recorded process instance, ignores a reused PID and rejects foreign PID records', {
  skip: process.platform !== 'linux'
}, async t => {
  const dir = temporary(t);
  const state = openState(dir, true);
  // A plain child with no sockets exercises the real launch gate and Linux PID identity check.
  const child = await launchService(state, 'redis', process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { PATH: process.env.PATH });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'redis.pid'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'minio.pid'), JSON.stringify({ ...record, name: 'minio', stack: 'another-stack' }), { mode: 0o600 });
  assert.throws(() => stopServices(state), /Invalid minio PID record/);
  // A stale PID now naming the test runner must not receive the signal.
  fs.writeFileSync(path.join(dir, 'minio.pid'), JSON.stringify({ ...record, name: 'minio', pid: process.pid, stamp: '00000000-0000-0000-0000-000000000000:1' }));
  stopServices(state);
  assert.equal((await exited)[1], 'SIGTERM');
  assert.ok(!fs.existsSync(path.join(dir, 'redis.pid')));
  assert.ok(!fs.existsSync(path.join(dir, 'minio.pid')));
  stopServices(state);
});

test('stop/reset default to preserving an unmarked directory, and reset unlinks only marked data', {
  skip: process.platform !== 'linux' || process.getuid?.() === 0
}, async t => {
  const savedUmask = process.umask();
  t.after(() => process.umask(savedUmask));
  const unrelated = temporary(t);
  const keep = path.join(unrelated, 'keep');
  fs.writeFileSync(keep, 'untouched');
  for (const command of ['stop', 'reset']) await assert.rejects(run({ command, dir: unrelated }), /existing LLMOJ dev stack marker/);
  const dir = temporary(t);
  openState(dir, true);
  fs.symlinkSync(keep, path.join(dir, 'link'));
  await run({ command: 'stop', dir });
  assert.ok(fs.existsSync(dir));
  await run({ command: 'reset', dir });
  assert.ok(!fs.existsSync(dir));
  await run({ command: 'reset', dir });
  await run({ command: 'stop', dir });
  assert.equal(fs.readFileSync(keep, 'utf8'), 'untouched');
});
