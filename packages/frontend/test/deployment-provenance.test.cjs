// Run with: node --test packages/frontend/test/deployment-provenance.test.cjs
// Review 2026-11-20 RV-08: the AI page's "Deployment identity" shows which source each artifact was built from, only
// as far as it was verified (a verified commit or source tree, this server's release for a judge, a mismatch, or
// unknown), next to the artifact digests it already showed.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

const commit = "e".repeat(40),
  tree = "f".repeat(64);
const identity = {
  backend: { sha256: "a".repeat(64), status: "available", capturedAt: "2026-11-23T00:00:00.000Z", provenance: { status: "verified", commit, treeSha256: tree } },
  frontend: { sha256: "b".repeat(64), status: "available", provenance: { status: "mismatch", commit: null, treeSha256: null } },
  qualityPolicyVersion: 2,
  receiptVersion: 1,
  executionProtocolVersion: 9,
  schema: { version: "contest-virtual-v1", appliedAt: "2026-11-21T02:05:13.594Z" },
  usageIdentityColumns: { purpose: true, generationId: true },
  workers: [
    { id: 1, online: true, build: "c".repeat(64), provenance: { status: "server_release", commit, treeSha256: tree }, sandboxImage: null, protocolVersion: 9, qualityPolicies: [2], receiptVersions: [1] },
    { id: 2, online: true, build: "d".repeat(64), provenance: { status: "unknown", commit: null, treeSha256: null }, sandboxImage: null, protocolVersion: 9, qualityPolicies: [2], receiptVersions: [1] }
  ],
  workersTruncated: false
};

async function render(data) {
  const h = componentHarness("pages/ai/AiDeploymentIdentity.tsx", {
    admin: true,
    deps: {
      "./api": { aiCall: async () => data, aiText: (zh, en) => en },
      "./Ai.module.less": {}
    }
  });
  await h.settle();
  return h;
}
// A Source element's text, as the user reads it
const text = node =>
  node == null || typeof node === "boolean"
    ? ""
    : typeof node !== "object"
      ? String(node)
      : Array.isArray(node)
        ? node.map(text).join("")
        : text(node.props?.children);
const sources = h => h.all(node => node.type?.name === "Source").map(node => node.props.provenance);

test("each artifact's verified source is shown next to its digest; a mismatch or an unknown source says so", async () => {
  const h = await render(identity);
  const shown = sources(h);
  assert.deepEqual(
    shown.map(p => p.status),
    ["verified", "mismatch", "server_release", "unknown"],
    "backend, frontend and each judge"
  );
});

test("a source reads as a short commit or tree, this server's release, a mismatch or unknown, never a digest", async () => {
  const shown = async data =>
    (await render(data)).all(node => node.type?.name === "Source").map(node => text(node.type(node.props)));
  assert.deepEqual(await shown(identity), [
    ` · source ${"e".repeat(12)} (verified)`,
    " · differs from its release manifest",
    ` · source ${"e".repeat(12)} (this server's release)`,
    " · source unknown"
  ]);
  const treeOnly = { ...identity, backend: { ...identity.backend, provenance: { status: "verified", commit: null, treeSha256: tree } } };
  assert.equal((await shown(treeOnly))[0], ` · source tree ${"f".repeat(12)} (verified)`);
  const unknown = { ...identity, backend: { ...identity.backend, provenance: { status: "unknown", commit: null, treeSha256: null } } };
  const first = (await shown(unknown))[0];
  assert.equal(first, " · source unknown");
  assert.ok(!first.includes("a".repeat(12)), "the artifact digest isn't presented as a source");
});
