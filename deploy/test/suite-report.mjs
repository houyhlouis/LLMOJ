// Keep output in a private temporary file so large suites do not hit a pipe buffer or require socket IPC.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export async function runSuite(program, args, { cwd, env, format, timeout, stdout = process.stdout }) {
  let total, skipped = 0, todo = 0, skippedFixtures = 0;
  const reasons = new Set();
  function observe(line) {
    let match;
    if (format === 'python') {
      if ((match = /^Ran (\d+) tests? in /.exec(line))) total = Number(match[1]);
      if ((match = / \.\.\. skipped (.*)$/.exec(line))) {
        reasons.add(match[1].replace(/^(['"])(.*)\1$/, '$2'));
        // unittest counts a skipped class/module setup in its skip list, but not in testsRun.
        if (/^(?:setUpClass|setUpModule) \(/.test(line)) skippedFixtures++;
      }
      if ((match = /^(?:OK|FAILED) \(.*\bskipped=(\d+)/.exec(line))) skipped = Number(match[1]);
    } else if (format === 'tap') {
      if ((match = /^# tests (\d+)$/.exec(line))) total = Number(match[1]);
      if ((match = /^# skipped (\d+)$/.exec(line))) skipped = Number(match[1]);
      if ((match = /^# todo (\d+)$/.exec(line))) todo = Number(match[1]);
      if ((match = /^\s*(?:not )?ok \d+ - (.*?) # (SKIP|TODO)\b\s*(.*)$/i.exec(line)))
        reasons.add(match[3] || `${match[2]}: ${match[1]}`);
    } else if ((match = /^SKIP: (.+)$/.exec(line))) {
      total = skipped = 1;
      reasons.add(match[1]);
    } else if (/^[\w-]+: (?:passed|FAILED\b.*)$/.test(line)) {
      // The standalone migration harness prints one result per case.
      total = (total ?? 0) + 1;
    }
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-test-report-'));
  const log = path.join(directory, 'output');
  let child;
  try {
    const fd = fs.openSync(log, 'wx', 0o600);
    try {
      child = spawnSync(program, args, { cwd, env, stdio: ['inherit', fd, fd], timeout, killSignal: 'SIGKILL' });
    } finally { fs.closeSync(fd); }
    const output = fs.createReadStream(log);
    output.pipe(stdout, { end: false });
    for await (const line of createInterface({ input: output, crlfDelay: Infinity })) observe(line);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const status = child.status ?? child.signal;
  let { error } = child;
  if (status === 0 && total === undefined && format !== 'script')
    error = new Error(`Missing ${format === 'python' ? 'unittest' : 'TAP'} case counts`);
  const executed = (total ?? (format === 'script' && !error ? 1 : 0)) - skipped - todo + skippedFixtures;
  return { ok: !error && status === 0, status, error, executed, skipped: skipped + todo, reasons: [...reasons] };
}
