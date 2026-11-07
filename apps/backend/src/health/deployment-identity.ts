import { createHash } from "crypto";
import fs from "fs";
import path from "path";

import { AI_EXECUTION_PROTOCOL_VERSION, AI_QUALITY_POLICY_VERSION, AI_RECEIPT_VERSION } from "@libreoj/judge-protocol";

/** Identity of loaded artifacts, captured at process start. Never a git checkout/branch/HEAD guess. */
export function artifactIdentity(root: string): {
  sha256: string | null;
  status: "available" | "missing" | "truncated";
} {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const visit = (relative: string) => {
    const name = path.join(root, relative);
    const stat = fs.lstatSync(name);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(name).sort()) visit(path.join(relative, child));
    } else if (stat.isFile() && /\.(?:js|mjs|cjs|json|ts)$/.test(name) && !/\.test\./.test(name)) {
      bytes += stat.size;
      files++;
      if (files > 10000 || bytes > 128 * 1024 * 1024) throw new Error("truncated");
      hash.update(relative).update("\0").update(fs.readFileSync(name)).update("\0");
    }
  };
  try {
    visit("");
    return { sha256: files ? hash.digest("hex") : null, status: files ? "available" : "missing" };
  } catch (error) {
    return { sha256: null, status: error.message === "truncated" ? "truncated" : "missing" };
  }
}
const backend = artifactIdentity(path.resolve(__dirname, ".."));
export function frontendBuildIdentity() {
  try {
    const manifest = fs.readFileSync(
      path.join(
        process.env.HYHOJ_PUBLIC_DIR || path.resolve(__dirname, "../../../..", "public"),
        "offline-manifest.json"
      )
    );
    if (manifest.length > 4 * 1024 * 1024) return { sha256: null, status: "truncated" };
    return { sha256: createHash("sha256").update(manifest).digest("hex"), status: "available" };
  } catch {
    return { sha256: null, status: "missing" };
  }
}
export const deploymentBuildIdentity = Object.freeze({
  backend: { ...backend, basis: "loaded_program_artifacts", capturedAt: new Date().toISOString() },
  get frontend() {
    return { ...frontendBuildIdentity(), basis: "deployed_offline_manifest" };
  },
  qualityPolicyVersion: AI_QUALITY_POLICY_VERSION,
  receiptVersion: AI_RECEIPT_VERSION,
  executionProtocolVersion: AI_EXECUTION_PROTOCOL_VERSION
});
