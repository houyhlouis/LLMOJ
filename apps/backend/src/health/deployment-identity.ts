import fs from "fs";
import path from "path";

import { AI_EXECUTION_PROTOCOL_VERSION, AI_QUALITY_POLICY_VERSION, AI_RECEIPT_VERSION } from "@libreoj/judge-protocol";

import { artifactIdentity, frontendBuildIdentity as offlineManifest } from "./artifact-identity";
import { releaseManifest, unknownProvenance, verifyArtifact } from "./release-provenance";

export { artifactIdentity } from "./artifact-identity";

function readRelease(root: string) {
  const file = path.join(root, "deploy/release-manifest.json");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) return null;
    return releaseManifest(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export type WorkerProvenance = {
  status: "server_release" | "unknown";
  commit: string | null;
  treeSha256: string | null;
};

/** Capture the manifest and loaded backend together. A running process never borrows the next release's identity. */
export function captureDeployment(root: string, backendDirectory: string) {
  const manifest = readRelease(root);
  const backend = artifactIdentity(backendDirectory);
  const provenance = verifyArtifact(backend.sha256, manifest?.artifacts.backend, manifest?.source);
  return {
    backend: { ...backend, basis: "loaded_program_artifacts", capturedAt: new Date().toISOString(), provenance },
    frontend(directory: string) {
      const frontend = offlineManifest(directory);
      return {
        ...frontend,
        basis: "deployed_offline_manifest",
        provenance:
          provenance.status === "verified"
            ? verifyArtifact(frontend.sha256, manifest.artifacts.frontend, manifest.source)
            : unknownProvenance
      };
    },
    worker(digest: string | null): WorkerProvenance {
      if (digest && provenance.status === "verified" && digest === manifest.artifacts.judgeProgram)
        return { status: "server_release", commit: provenance.commit, treeSha256: provenance.treeSha256 };
      return { status: "unknown", commit: null, treeSha256: null };
    }
  };
}

const root = path.resolve(__dirname, "../../../..");
const release = captureDeployment(root, path.resolve(__dirname, ".."));
export const workerProvenance = release.worker;
export const frontendBuildIdentity = () => offlineManifest(process.env.HYHOJ_PUBLIC_DIR || path.join(root, "public"));
export const deploymentBuildIdentity = Object.freeze({
  backend: release.backend,
  get frontend() {
    return release.frontend(process.env.HYHOJ_PUBLIC_DIR || path.join(root, "public"));
  },
  qualityPolicyVersion: AI_QUALITY_POLICY_VERSION,
  receiptVersion: AI_RECEIPT_VERSION,
  executionProtocolVersion: AI_EXECUTION_PROTOCOL_VERSION
});
