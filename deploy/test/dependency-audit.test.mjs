// The dependency audit's placement and triage rules, on synthetic `pnpm audit` reports (no network), and the pinned
// toolchain agreeing everywhere it's written down.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify, loadTriage } from "../dependency-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

const advisory = (id, name, severity, paths, version = "1.0.0") => ({
  id,
  url: `https://github.com/advisories/${id}`,
  module_name: name,
  severity,
  title: `${name} problem`,
  vulnerable_versions: "<2.0.0",
  findings: [{ version, paths }]
});
const triage = (accepted = [], places = ["server"]) => ({
  version: 1,
  block: { places, severities: ["critical", "high"] },
  buildTools: ["vite", "sass"],
  accepted
});

test("an advisory is placed by the most exposed way the dependencies reach it", () => {
  const all = [
    advisory("GHSA-2222-3333-4444", "express-dep", "high", ["apps__backend>express>express-dep"]),
    advisory("GHSA-3333-4444-5555", "browser-dep", "high", ["packages__frontend>react-dom>browser-dep"]),
    advisory("GHSA-4444-5555-6666", "tool-dep", "critical", ["packages__frontend>vite>rollup>tool-dep"]),
    advisory("GHSA-5555-6666-7777", "dev-dep", "critical", ["apps__backend>@nestjs/cli>dev-dep"]),
    // A production path of the judge outranks a frontend one
    advisory("GHSA-6666-7777-8888", "both", "moderate", ["packages__frontend>axios>both", "apps__judge>axios>both"])
  ];
  const production = [all[0], { ...all[4], findings: [{ version: "1.0.0", paths: ["apps__judge>axios>both"] }] }];
  const { findings } = classify(all, production, triage(), "2026-10-20");
  assert.deepEqual(
    findings.map(f => [f.package, f.place, f.status]),
    [
      ["express-dep", "server", "blocking"],
      ["browser-dep", "browser", "reported"],
      ["tool-dep", "build", "reported"],
      ["dev-dep", "build", "reported"],
      ["both", "server", "reported"]
    ]
  );
  assert.equal(findings[0].example, "apps/backend>express>express-dep");
  // Once browsers' code blocks too
  const strict = classify(all, production, triage([], ["server", "browser"]), "2026-10-20").findings;
  assert.deepEqual(
    strict.map(f => f.status),
    ["blocking", "blocking", "reported", "reported", "reported"]
  );
});

test("a triaged advisory is accepted until its review date, and unmatched entries are reported", () => {
  const all = [advisory("GHSA-2222-3333-4444", "express-dep", "high", ["apps__backend>express>express-dep"])];
  const entry = {
    advisory: "GHSA-2222-3333-4444",
    package: "express-dep",
    decision: "not-reachable",
    reason: "Only the unused part of the package is affected",
    reviewBy: "2026-12-31"
  };
  const stale = { ...entry, advisory: "GHSA-7777-8888-9999" };
  const accepted = classify(all, all, triage([entry, stale]), "2026-10-20");
  assert.equal(accepted.findings[0].status, "accepted");
  assert.equal(accepted.findings[0].reviewBy, "2026-12-31");
  assert.deepEqual(accepted.stale, [stale]);
  assert.equal(classify(all, all, triage([entry]), "2027-01-01").findings[0].status, "expired");
  // An entry is for its own package only
  assert.equal(
    classify(all, all, triage([{ ...entry, package: "other" }]), "2026-10-20").findings[0].status,
    "blocking"
  );
});

test("the repository's triage file is valid and names real frontend build tools", () => {
  const triageFile = loadTriage();
  const frontend = JSON.parse(read("packages/frontend/package.json"));
  const dependencies = { ...frontend.dependencies, ...frontend.devDependencies };
  assert.deepEqual(
    triageFile.buildTools.filter(name => !(name in dependencies)),
    [],
    "build tools that aren't frontend dependencies"
  );
  assert(triageFile.block.places.includes("server") && triageFile.block.severities.includes("critical"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-triage-"));
  try {
    for (const broken of [
      { ...triageFile, version: 2 },
      { ...triageFile, block: { ...triageFile.block, places: ["everywhere"] } },
      { ...triageFile, accepted: [{ advisory: "CVE-2026-1", package: "x", decision: "accepted", reason: "x".repeat(30), reviewBy: "2027-01-01" }] },
      { ...triageFile, accepted: [{ advisory: "GHSA-2222-3333-4444", package: "x", decision: "ignored", reason: "x".repeat(30), reviewBy: "2027-01-01" }] },
      { ...triageFile, accepted: [{ advisory: "GHSA-2222-3333-4444", package: "x", decision: "accepted", reason: "short", reviewBy: "2027-01-01" }] }
    ]) {
      const file = path.join(directory, "triage.json");
      fs.writeFileSync(file, JSON.stringify(broken));
      assert.throws(() => loadTriage(file), /triage/);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the pinned Node.js and pnpm are the same everywhere", () => {
  const node = read(".node-version").trim();
  assert.match(node, /^24\.\d+\.\d+$/);
  assert.equal(/^NODE_VERSION=([0-9.]+)$/m.exec(read("deploy/install.sh"))?.[1], node, "deploy/install.sh");
  const manifest = JSON.parse(read("package.json"));
  const pnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
  assert.ok(pnpm, "packageManager names an exact pnpm");
  assert.match(read("deploy/install.sh"), new RegExp(`--ignore-scripts pnpm@${pnpm.replaceAll(".", "\\.")}\\n`));
  // The upgrader refuses installations on another pnpm or Node.js major
  const upgrader = read("deploy/upgrade.py");
  assert.ok(upgrader.includes(`self.pnpm_version != '${pnpm}'`), "deploy/upgrade.py's pnpm");
  assert.ok(upgrader.includes(`self.node_version.startswith('v${node.split(".")[0]}.')`), "deploy/upgrade.py's Node.js");
  assert.equal(manifest.engines.node, `>=${node} <${Number(node.split(".")[0]) + 1}`, "package.json engines");
});
