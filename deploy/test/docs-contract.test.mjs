import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'packages/judge-protocol/src/index.ts'), 'utf8');
const versions = {};
for (const name of ['JUDGE_PROTOCOL_VERSION', 'AI_EXECUTION_PROTOCOL_VERSION', 'AI_QUALITY_POLICY_VERSION', 'AI_RECEIPT_VERSION']) {
  const match = source.match(new RegExp(`^export const ${name} = (\\d+);$`, 'm'));
  assert.ok(match, `Could not read exported ${name}`);
  versions[name] = Number(match[1]);
}

// The bilingual current labels are unambiguous. The longer "protocol version N" also appears in
// feature histories, so check it when the surrounding words describe today's AI admission requirement.
const labels = /(\b(?:(?:AI execution |judge )?protocol(?: version)?|(?:quality )?policy|receipt version)|(?:AI\s*执行协议|判题协议|评测协议|协议)(?:版本)?|质量策略|质量规则|回执版本|结果凭据)\s*(\d+)\b/giu;

function isHistory(before, after) {
  return /\b(?:before|older than|prior to)\s+$/i.test(before) ||
    /^\s*(?:之前|以前|(?:到|至|[-–])\s*\d|(?:to|through)\s+\d|(?:added|introduced)\b)/i.test(after) ||
    (before.endsWith('(') && /^\s+and later\)/i.test(after));
}

function describesAdmission(before, after) {
  return /\b(?:only|on|any)\s+(?:(?:an?|any|online)\s+)*judges?\s+(?:of|with|using)\s+$/i.test(before) ||
    /(?:\b(?:current|required|requires?|needs?)(?:\s+version)?\s*\(?|当前(?:版本)?[（(]?|需要|要求|任意(?:一台)?(?:在线)?|只在|仅在)\s*$/i.test(before) ||
    /^\s*[)）]?\s*(?:takes?\b|(?:also )?runs? AI\b|(?:are|is) sent AI\b)/i.test(after) ||
    /^\s*(?:的(?:在线)?(?:评测|判题)机(?:领取|才会收到)|）也负责 AI)/.test(after);
}

function mismatches(markdown, values) {
  const issues = [];
  // Ignore emphasis and inline-code marks so formatting a label does not change its meaning.
  const text = markdown.replace(/[`*]/g, '');
  for (const match of text.matchAll(labels)) {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    if (isHistory(before, after)) continue;

    const label = match[1].toLowerCase();
    let name;
    if (/policy|策略|规则/.test(label)) name = 'AI_QUALITY_POLICY_VERSION';
    else if (/receipt|回执|凭据/.test(label)) name = 'AI_RECEIPT_VERSION';
    else if (label === 'judge protocol' || label === '判题协议') name = 'JUDGE_PROTOCOL_VERSION';
    else if (/^ai/.test(label) || describesAdmission(before, after)) name = 'AI_EXECUTION_PROTOCOL_VERSION';
    else continue;
    if (Number(match[2]) !== values[name])
      issues.push(`line ${before.split('\n').length}: ${match[0]} (expected ${name} = ${values[name]})`);
  }
  return issues;
}

test('current requirements in either language use the corresponding exported version', () => {
  // Distinct values exercise the mapping even when today's judge and AI execution versions coincide.
  const values = { JUDGE_PROTOCOL_VERSION: 23, AI_EXECUTION_PROTOCOL_VERSION: 17, AI_QUALITY_POLICY_VERSION: 5, AI_RECEIPT_VERSION: 3 };
  for (const [current, stale] of [
    ['judge protocol 23, quality policy 5, receipt version 3', 'judge protocol 8, quality policy 5, receipt version 3'],
    ['判题协议 23', '判题协议 8'], ['质量策略 5', '质量策略 4'], ['回执版本 3', '回执版本 2'],
    ['AI execution protocol 17', 'AI execution protocol 23'],
    ['AI 执行协议 17', 'AI 执行协议 23'],
    ['only judges of protocol 17 are sent AI runs', 'only judges of protocol 8 are sent AI runs'],
    ['any online judge of protocol version 17 takes the run', 'any online judge of protocol version 4 takes the run'],
    ['AI programs run on judges of protocol version 17', 'AI programs run on judges of protocol version 8'],
    ['up-to-date judges (protocol version 17) also run AI validation', 'up-to-date judges (protocol version 4) also run AI validation'],
    ['由协议版本 17 的在线评测机领取', '由协议版本 4 的在线评测机领取'],
    ['quality policy 5', 'quality policy 4'], ['receipt version 3', 'receipt version 2']
  ]) {
    assert.deepEqual(mismatches(current, values), [], current);
    assert.ok(mismatches(stale, values).length, stale);
  }
});

test('capability history can identify the version that introduced a feature', () => {
  const history = [
    'before judge protocol 4', 'before protocol 8', '判题协议 4 之前', '协议 8 之前',
    'a judge of protocol version 5 also reports the architecture', 'one of protocol version 4 to 8 still judges submissions',
    'A judge machine (protocol 6) uploads evidence.', 'Judge protocol 8 added replay.', '协议版本 4 到 8',
    'The runner (judge protocol 7 and later) compiles each program with its profile.'
  ].join('\n');
  assert.deepEqual(mismatches(history, versions), []);
  assert.equal(mismatches('Before judge protocol 4, things differed. Today judge protocol 999 is required.', versions).length, 1);
});

test('Wiki pages and the AI developer README agree with the shipped judge protocol', () => {
  const pages = fs.readdirSync(path.join(root, 'wiki')).filter(name => name.endsWith('.md')).sort().map(name => 'wiki/' + name);
  const issues = [];
  for (const file of [...pages, 'apps/backend/src/ai/README.md'])
    for (const issue of mismatches(fs.readFileSync(path.join(root, file), 'utf8'), versions)) issues.push(`${file}:${issue}`);
  assert.deepEqual(issues, [], issues.join('\n'));
});
