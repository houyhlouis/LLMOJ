#!/usr/bin/env node
// The dependency inventory and advisory check (see wiki/Dependencies.md). Run from the repository, after `pnpm install`:
//
//   node deploy/dependency-audit.mjs audit [--json FILE]   known advisories of the locked dependencies, by where they
//                                                          reach; exits 1 if one that blocks isn't triaged
//   node deploy/dependency-audit.mjs sbom FILE             a CycloneDX inventory of the locked dependencies
//
// Advisories come from the npm registry's audit service through `pnpm audit`. Each is placed by the most exposed way
// a locked package reaches it:
//   server   a production dependency of the backend, the judge, the judge protocol or the sandbox
//   browser  a frontend dependency other than its build tools (deploy/dependency-triage.json lists those), so possibly
//            in the pages browsers run
//   build    anything else: build, test and development tools, and the bootstrap packages no installation runs
// deploy/dependency-triage.json says which places and severities block, and records each blocking advisory that is
// accepted: why, and until when (a decision expires, so that it's looked at again).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRIAGE = path.join(root, "deploy/dependency-triage.json");
const SERVER = ["apps/backend", "apps/judge", "packages/judge-protocol", "packages/simple-sandbox"];
const FRONTEND = "packages/frontend";
const PLACES = ["server", "browser", "build"];
const SEVERITIES = ["critical", "high", "moderate", "low", "info"];

class AuditError extends Error {}

function pnpm(args) {
  const result = spawnSync(process.env.PNPM_BINARY || "pnpm", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024
  });
  if (result.error) throw new AuditError(`Couldn't run pnpm: ${result.error.message}`);
  return result;
}

// pnpm names a dependency path's first step after its project: apps__backend>express>...
const project = name => name.replaceAll("/", "__");

function advisories(prod) {
  // pnpm audit exits 1 when it finds advisories; only its output says whether it worked
  const result = pnpm(["audit", "--json", ...(prod ? ["--prod"] : [])]);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new AuditError(`pnpm audit gave no report (exit ${result.status}): ${result.stderr.trim().slice(0, 500)}`);
  }
  if (report.error || !report.advisories)
    throw new AuditError(`The audit service didn't answer: ${JSON.stringify(report.error ?? report).slice(0, 500)}`);
  return Object.values(report.advisories);
}

export function loadTriage(file = TRIAGE) {
  const triage = JSON.parse(fs.readFileSync(file, "utf8"));
  const { block, buildTools, accepted } = triage;
  if (
    triage.version !== 1 ||
    !Array.isArray(block?.places) ||
    !block.places.every(place => PLACES.includes(place)) ||
    !Array.isArray(block.severities) ||
    !block.severities.every(severity => SEVERITIES.includes(severity)) ||
    !Array.isArray(buildTools) ||
    !Array.isArray(accepted)
  )
    throw new AuditError("deploy/dependency-triage.json isn't a version 1 triage file");
  for (const entry of accepted)
    if (
      !/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(entry.advisory) ||
      typeof entry.package !== "string" ||
      !["not-reachable", "accepted"].includes(entry.decision) ||
      typeof entry.reason !== "string" ||
      entry.reason.length < 20 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy)
    )
      throw new AuditError(`Invalid triage entry: ${JSON.stringify(entry)}`);
  return triage;
}

/**
 * Places every advisory of `all` (`pnpm audit`) by the dependency paths it's found on, with `production`
 * (`pnpm audit --prod`) telling production dependencies apart, and decides which ones block.
 */
export function classify(all, production, triage, today = new Date().toISOString().slice(0, 10)) {
  const productionPaths = new Map(production.map(advisory => [advisory.url, advisory.findings.flatMap(f => f.paths)]));
  const buildTools = new Set(triage.buildTools);
  const used = new Set();
  const findings = all.map(advisory => {
    const paths = advisory.findings.flatMap(finding => finding.paths);
    const places = new Set();
    for (const step of productionPaths.get(advisory.url) ?? [])
      if (SERVER.some(name => step.startsWith(project(name) + ">"))) places.add("server");
    for (const step of paths) {
      const [first, dependency] = step.split(">");
      if (first === project(FRONTEND)) places.add(buildTools.has(dependency) ? "build" : "browser");
      else if (!places.has("server")) places.add("build");
    }
    const place = PLACES.find(candidate => places.has(candidate)) ?? "build";
    const id = /GHSA(-[23456789cfghjmpqrvwx]{4}){3}/.exec(advisory.url ?? "")?.[0] ?? `npm-${advisory.id}`;
    const entry = triage.accepted.find(item => item.advisory === id && item.package === advisory.module_name);
    if (entry) used.add(entry);
    const blocks = triage.block.places.includes(place) && triage.block.severities.includes(advisory.severity);
    const status = !blocks ? "reported" : !entry ? "blocking" : entry.reviewBy < today ? "expired" : "accepted";
    return {
      advisory: id,
      package: advisory.module_name,
      severity: advisory.severity,
      place,
      status,
      title: advisory.title,
      vulnerable: advisory.vulnerable_versions,
      versions: [...new Set(advisory.findings.map(finding => finding.version))],
      example: paths[0]?.replaceAll("__", "/"),
      ...(entry ? { decision: entry.decision, reason: entry.reason, reviewBy: entry.reviewBy } : {})
    };
  });
  const stale = triage.accepted.filter(entry => !used.has(entry));
  return { findings, stale };
}

function summary({ findings, stale }) {
  const lines = [];
  const counts = Object.fromEntries(PLACES.map(place => [place, Object.fromEntries(SEVERITIES.map(s => [s, 0]))]));
  for (const finding of findings) counts[finding.place][finding.severity]++;
  lines.push("Known advisories of the locked dependencies, by where they reach:");
  for (const place of PLACES)
    lines.push(
      `  ${place.padEnd(8)} ${SEVERITIES.filter(s => s !== "info")
        .map(s => `${counts[place][s]} ${s}`)
        .join(", ")}`
    );
  const show = (title, items, describe) => {
    if (!items.length) return;
    lines.push("", title);
    for (const item of items) lines.push("  " + describe(item));
  };
  const describe = f =>
    `${f.severity} ${f.package}@${f.versions.join(",")} ${f.advisory}: ${f.title} (${f.place}; via ${f.example})`;
  show(
    "Accepted (deploy/dependency-triage.json):",
    findings.filter(f => f.status === "accepted"),
    f => `${describe(f)}\n    ${f.decision} until ${f.reviewBy}: ${f.reason}`
  );
  show(
    "Expired decisions, to look at again:",
    findings.filter(f => f.status === "expired"),
    f => `${describe(f)}\n    was ${f.decision} until ${f.reviewBy}: ${f.reason}`
  );
  show("Blocking: update the dependency, or triage the advisory:", findings.filter(f => f.status === "blocking"), describe);
  show(
    "Triage entries no advisory matches any more (remove them):",
    stale,
    entry => `${entry.advisory} ${entry.package}`
  );
  return lines.join("\n");
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "sbom" && rest.length === 1) {
    const result = pnpm(["sbom", "--sbom-format", "cyclonedx", "--out", path.resolve(rest[0])]);
    if (result.status) throw new AuditError(`pnpm sbom failed: ${result.stderr.trim().slice(0, 500)}`);
    const sbom = JSON.parse(fs.readFileSync(path.resolve(rest[0]), "utf8"));
    console.log(`${sbom.components.length} locked components written to ${rest[0]} (CycloneDX ${sbom.specVersion})`);
    return 0;
  }
  if (command === "audit" && (rest.length === 0 || (rest.length === 2 && rest[0] === "--json"))) {
    const triage = loadTriage();
    const result = classify(advisories(false), advisories(true), triage);
    if (rest.length) fs.writeFileSync(path.resolve(rest[1]), JSON.stringify(result, null, 2) + "\n");
    console.log(summary(result));
    const blocking = result.findings.filter(f => f.status === "blocking" || f.status === "expired").length;
    console.log(
      `\n${blocking ? `${blocking} advisories block` : "Nothing blocks"} (blocking: ${triage.block.severities.join(
        " and "
      )} advisories that reach ${triage.block.places.join(" or ")} code).`
    );
    return blocking ? 1 : 0;
  }
  console.error("Usage: dependency-audit.mjs audit [--json FILE] | dependency-audit.mjs sbom FILE");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof AuditError)) throw error;
    console.error(error.message);
    process.exitCode = 2;
  }
}
