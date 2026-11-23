import { createHash } from "crypto";
import fs from "fs";
import path from "path";

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
export function frontendBuildIdentity(directory: string) {
  const filename = path.join(directory, "offline-manifest.json");
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile()) return { sha256: null, status: "missing" };
    if (stat.size > 4 * 1024 * 1024) return { sha256: null, status: "truncated" };
    const manifest = fs.readFileSync(filename);
    if (manifest.length > 4 * 1024 * 1024) return { sha256: null, status: "truncated" };
    return { sha256: createHash("sha256").update(manifest).digest("hex"), status: "available" };
  } catch {
    return { sha256: null, status: "missing" };
  }
}
