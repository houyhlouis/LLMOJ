const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
require("../auth/registration-test-helpers.cjs");
const { writeManifest } = require("../../../../deploy/release-manifest.mjs");
const { captureDeployment } = require("./deployment-identity.ts");

test("the process verifies its loaded bytes once; only the matching judge and frontend can use its release", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-verified-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = path.join(root, "apps/backend/dist"), frontend = path.join(root, "public");
  for (const dir of [backend, frontend, path.join(root, "deploy"), path.join(root, "apps/judge/src")]) fs.mkdirSync(dir, { recursive: true });
  const main = path.join(backend, "main.js"), offline = path.join(frontend, "offline-manifest.json"), manifest = path.join(root, "deploy/release-manifest.json");
  fs.writeFileSync(main, "first backend");
  fs.writeFileSync(offline, "frontend");
  fs.writeFileSync(path.join(root, "apps/judge/src/main.ts"), "judge");
  const capture = () => captureDeployment(root, backend);
  const unknown = { status: "unknown", commit: null, treeSha256: null };
  const mismatch = { ...unknown, status: "mismatch" };
  const first = capture();
  assert.deepEqual(first.backend.provenance, unknown);
  const source = { kind: "checkout", commit: "a".repeat(40), treeSha256: "b".repeat(64), privatePath: root };
  const release = writeManifest(root, "all", source);
  const verified = { status: "verified", commit: source.commit, treeSha256: source.treeSha256 };
  const loaded = capture();
  assert.equal(loaded.backend.sha256, first.backend.sha256);
  assert.equal(loaded.backend.sha256, release.artifacts.backend);
  assert.deepEqual(loaded.backend.provenance, verified);
  assert.deepEqual(loaded.frontend(frontend).provenance, verified);
  assert.deepEqual(loaded.worker(release.artifacts.judgeProgram), { ...verified, status: "server_release" });
  for (const digest of [null, "c".repeat(64)]) assert.deepEqual(loaded.worker(digest), unknown);
  // As after a process restart, both administrator endpoints consume the same captured release.
  const identity = require("./deployment-identity.ts");
  const original = identity.deploymentBuildIdentity;
  identity.deploymentBuildIdentity = { ...original, backend: loaded.backend, frontend: loaded.frontend(frontend) };
  t.after(() => { identity.deploymentBuildIdentity = original; });
  t.mock.method(identity, "workerProvenance", loaded.worker);
  const { JudgeClientService } = require("../judge/judge-client.service.ts");
  const { AiJobViewService } = require("../ai/ai-job-view.service.ts");
  const machines = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const capabilities = [ { runtime: { judgeProgram: release.artifacts.judgeProgram } },
    { runtime: { judgeProgram: "c".repeat(64) } }, null ];
  const judges = Object.assign(Object.create(JudgeClientService.prototype), {
    listJudgeClients: async () => machines, isJudgeClientOnline: async () => true,
    getJudgeClientSystemInfo: async () => null, judgeJobRepository: { countBy: async () => 0 },
    getJudgeClientCapabilities: async client => capabilities[client.id - 1]
  });
  const views = Object.assign(Object.create(AiJobViewService.prototype), { judges,
    db: { getRepository: () => ({ findOneBy: async ({ id }) => id ? { isAdmin: true } : null }), query: async () => [] } });
  const deployment = await views.deployment({ id: 1 });
  assert.deepEqual(deployment.backend.provenance, verified);
  assert.deepEqual(deployment.workers.map(w => w.provenance), [loaded.worker(release.artifacts.judgeProgram), unknown, unknown]);
  for (const [i, machine] of machines.entries())
    assert.deepEqual((await judges.getJudgeClientInfo(machine, true, false)).provenance, deployment.workers[i].provenance);
  assert.ok(!JSON.stringify(deployment).includes(root));
  fs.writeFileSync(offline, "replacement");
  assert.deepEqual(loaded.frontend(frontend).provenance, mismatch);
  fs.writeFileSync(main, "changed backend");
  const changed = capture();
  assert.notEqual(changed.backend.sha256, loaded.backend.sha256);
  assert.deepEqual(changed.backend.provenance, mismatch);
  assert.deepEqual(changed.worker(release.artifacts.judgeProgram), unknown);
  assert.deepEqual(loaded.backend.provenance, verified);
  const badSource = { ...release, source: { ...release.source, treeSha256: root+"/PRIVATE_FIXTURE" } };
  for (const invalid of [JSON.stringify(badSource), "{", "x".repeat(4097)]) {
    fs.writeFileSync(manifest, invalid);
    assert.deepEqual(capture().backend.provenance, unknown);
    assert.deepEqual(capture().worker(release.artifacts.judgeProgram), unknown);
    assert.ok(!JSON.stringify(capture().backend).includes(root));
  }
});
