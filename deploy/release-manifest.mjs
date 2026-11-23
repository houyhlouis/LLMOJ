#!/usr/bin/env node
// Called only while installing or building a staged release. Never consult Git from the running backend.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { artifactIdentity, frontendBuildIdentity } from '../apps/backend/src/health/artifact-identity.ts';
import { releaseSource, releaseManifest } from '../apps/backend/src/health/release-provenance.ts';
import { judgeProgramDigest } from '../apps/judge/src/judge-program.ts';

const upgrade = fileURLToPath(new URL('./upgrade.py', import.meta.url));
const treeDigest = root => execFileSync('python3', ['-B', upgrade, '--source', root, '--source-digest'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function installSource(source, target) {
  let identity;
  if (fs.existsSync(path.join(source, '.git'))) {
    const git = (...args) => execFileSync('git', ['--no-optional-locks', '-c', 'safe.directory='+source, '-C', source, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (git('rev-parse', '--show-toplevel') !== source || git('status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'))
      return releaseSource({ kind: 'dirty' });
    identity = { kind: 'checkout', commit: git('rev-parse', '--verify', 'HEAD^{commit}') };
  } else if (process.env.OJ_SOURCE_TREE_SHA256 && process.env.OJ_SOURCE_ARCHIVE_SHA256 && process.env.OJ_SOURCE_COMMIT && process.env.OJ_SOURCE_REPOSITORY) {
    identity = { kind: 'github', repository: process.env.OJ_SOURCE_REPOSITORY, commit: process.env.OJ_SOURCE_COMMIT,
      archiveSha256: process.env.OJ_SOURCE_ARCHIVE_SHA256 };
  } else {
    return releaseSource({ kind: 'unknown' });
  }
  const treeSha256 = treeDigest(source);
  if (identity.kind === 'github' && treeSha256 !== process.env.OJ_SOURCE_TREE_SHA256)
    throw new Error('Downloaded source changed after extraction');
  if (source !== target && treeDigest(target) !== treeSha256) throw new Error('Installed source differs from build input');
  const result = releaseSource({ ...identity, treeSha256 });
  if (!result) throw new Error('Invalid release source');
  return result;
}

export function writeManifest(root, role, source) {
  if (!['web', 'all'].includes(role) || !fs.existsSync(path.join(root, 'apps/backend/dist/main.js')))
    throw new Error('A completed backend build and installation role are required');
  const manifest = releaseManifest({ schemaVersion: 1, builtAt: new Date().toISOString(), source,
    artifacts: { backend: artifactIdentity(path.join(root, 'apps/backend/dist')).sha256,
      judgeProgram: role === 'all' ? judgeProgramDigest(root) : null,
      frontend: frontendBuildIdentity(path.join(root, 'public')).sha256 } });
  if (!manifest) throw new Error('Incomplete release artifacts or invalid build provenance');
  const destination = path.join(root, 'deploy/release-manifest.json');
  const temporary = destination+'.'+randomUUID();
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest)+'\n', { flag: 'wx', mode: 0o644 });
    fs.chmodSync(temporary, 0o644); // The service account reads this even under the installer's private umask.
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return manifest;
}

if (import.meta.main) {
  const [action, root, arg, source] = process.argv.slice(2);
  if (action === 'install-source') console.log(JSON.stringify(installSource(fs.realpathSync(root), fs.realpathSync(arg))));
  else if (action === 'write') writeManifest(fs.realpathSync(root), arg, JSON.parse(source));
  else throw new Error('Expected install-source SOURCE TARGET or write ROOT ROLE SOURCE_JSON');
}
