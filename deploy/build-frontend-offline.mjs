#!/usr/bin/env node
/** Stage the upstream frontend with local static dependencies and deployment settings. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontend = path.join(root, 'packages/frontend');
const output = path.resolve(process.env.HYHOJ_PUBLIC_DIR || path.join(root, 'public'));
const siteName = process.env.OJ_SITE_NAME || 'LLMOJ';
const copy = (source, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
};
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : [filename];
  });
}

fs.mkdirSync(output, { recursive: true });
// The build is self-contained: its libraries are bundled, and those loaded on demand (the code editor, maths,
// highlighting, emoji images) are in its vendor/ directory. Publish the main libraries' licences next to it.
for (const name of ['react', 'react-dom', 'mobx', 'axios', 'noty', 'semantic-ui-react', 'fomantic-ui-css', 'monaco-editor',
  'mathjax-full', 'prismjs', '@twemoji/api', '@twemoji/svg']) {
  const directory = fs.realpathSync(path.join(frontend, 'node_modules', name));
  for (const entry of fs.readdirSync(directory))
    if (/^(?:license|licence|copying|notice|copyright)(?:[.-]|$)/i.test(entry))
      copy(path.join(directory, entry), path.join(output, 'licenses', name, entry));
}
// Keep the site without a favicon or logo and remove the retired quote source.
for (const name of ['favicon.ico', 'logo-website.min.svg', 'hitokoto.json']) {
  fs.rmSync(path.join(output, 'assets', name), { force: true });
}

// Deploy only quote data for which the operator has redistribution rights.
const quoteFile = process.env.HYHOJ_QUOTE_FILE;
if (quoteFile) copy(path.resolve(quoteFile), path.join(output, 'assets/hitokoto.json'));
copy(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'licenses/THIRD_PARTY_NOTICES.md'));
copy(path.join(root, 'LICENSE'), path.join(output, 'licenses/LibreOJ-LICENSE'));

if (process.argv.includes('--assets-only')) {
  console.log('Offline dependency assets staged in ' + output);
  process.exit(0);
}
if (process.argv.includes('--build')) {
  const pnpm = process.env.PNPM_BINARY || 'pnpm';
  execFileSync(pnpm, ['--filter', '@libreoj/frontend', 'run', 'build'], {
    cwd: root, env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=2300' }, stdio: 'inherit'
  });
}
const dist = path.join(frontend, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Build the frontend first or pass --build.');
copy(dist, path.join(output, 'frontend'));
fs.rmSync(path.join(output, 'frontend/index.html'), { force: true });

// Render a single same-origin bootstrap. Do not install the upstream bootstrap
// CDN service worker: it was designed for a separate origin and corrupts cached
// same-origin API/static responses by mapping non-JavaScript paths to '/'.
// /sw.js removes it from browsers that still have it (see that file).
const substitutions = {
  __public_path__: '/frontend',
  __default_title__: siteName,
  __api_endpoint__: '',
  __favicon__: '',
  __applogo__: null,
  __gravatar__: 'https://gravatar.com',
  __ghavatar__: 'https://github.com'
};
let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
for (const [placeholder, value] of Object.entries(substitutions)) {
  const escaped = JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  html = html.replaceAll(placeholder, () => escaped);
}
if (Object.keys(substitutions).some(placeholder => html.includes(placeholder))) throw new Error('Unresolved bootstrap placeholder.');
fs.writeFileSync(path.join(output, 'index.html'), html);
fs.copyFileSync(path.join(root, 'packages/service-worker/retire-service-worker.js'), path.join(output, 'sw.js'));

const manifest = files(output).filter(filename => !filename.endsWith('/offline-manifest.json')).map(filename => ({
  path: path.relative(output, filename),
  size: fs.statSync(filename).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}));
fs.writeFileSync(path.join(output, 'offline-manifest.json'), JSON.stringify({ site: siteName, files: manifest }, null, 2));
console.log(`${siteName} staged ${manifest.length} local files in ${output}`);
