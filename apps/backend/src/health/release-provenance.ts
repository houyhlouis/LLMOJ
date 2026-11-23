import { createHash } from "crypto";

export const isDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isCommit = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export type ReleaseSource = {
  kind: "github" | "github-bootstrap" | "checkout" | "local" | "dirty" | "unknown";
  repository: string | null;
  commit: string | null;
  treeSha256: string | null;
  archiveSha256: string | null;
};

export type BuildProvenance = {
  status: "verified" | "mismatch" | "unknown";
  commit: string | null;
  treeSha256: string | null;
};
export const unknownProvenance: BuildProvenance = Object.freeze({ status: "unknown", commit: null, treeSha256: null });

/** Only this projection crosses the build/diagnostic boundary. */
export function releaseSource(value: unknown): ReleaseSource | null {
  if (!record(value)) return null;
  const { kind, repository = null, commit = null, treeSha256 = null, archiveSha256 = null } = value;
  if (
    repository !== null &&
    !(
      typeof repository === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(repository)
    )
  )
    return null;
  if (commit !== null && !isCommit(commit)) return null;
  if (treeSha256 !== null && !isDigest(treeSha256)) return null;
  if (archiveSha256 !== null && !isDigest(archiveSha256)) return null;
  if (kind === "dirty" || kind === "unknown")
    return { kind, repository: null, commit: null, treeSha256: null, archiveSha256: null };
  if (kind !== "github" && kind !== "github-bootstrap" && kind !== "local" && kind !== "checkout") return null;
  if (!isDigest(treeSha256) || (kind === "local" ? commit !== null : !isCommit(commit))) return null;
  if ((kind === "github" || kind === "github-bootstrap") && !repository) return null;
  return {
    kind,
    repository: repository as string,
    commit: commit as string,
    treeSha256,
    archiveSha256: archiveSha256 as string
  };
}

export type ReleaseManifest = {
  schemaVersion: 1;
  builtAt: string;
  source: ReleaseSource;
  artifacts: { backend: string; judgeProgram: string | null; frontend: string };
};
export function releaseManifest(value: unknown): ReleaseManifest | null {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.artifacts)) return null;
  const {
    builtAt,
    artifacts: { backend, judgeProgram, frontend }
  } = value;
  const source = releaseSource(value.source);
  if (
    !source ||
    typeof builtAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(builtAt) ||
    !Number.isFinite(Date.parse(builtAt)) ||
    !isDigest(backend) ||
    !isDigest(frontend) ||
    !(judgeProgram === null || isDigest(judgeProgram))
  )
    return null;
  return { schemaVersion: 1, builtAt, source, artifacts: { backend, judgeProgram: judgeProgram as string, frontend } };
}

export function verifyArtifact(
  digest: string | null,
  expected: string | null,
  source?: ReleaseSource
): BuildProvenance {
  if (!expected) return unknownProvenance;
  if (digest !== expected) return { status: "mismatch", commit: null, treeSha256: null };
  if (!source?.treeSha256) return unknownProvenance;
  return { status: "verified", commit: source.commit, treeSha256: source.treeSha256 };
}

export function storedProvenance(value: unknown): BuildProvenance {
  if (record(value)) {
    if (value.status === "mismatch") return { status: "mismatch", commit: null, treeSha256: null };
    if (value.status === "verified" && isDigest(value.treeSha256) && (value.commit === null || isCommit(value.commit)))
      return { status: "verified", commit: value.commit as string, treeSha256: value.treeSha256 };
  }
  return unknownProvenance;
}

/** Pin the observation in a timeline row even when different releases produced identical backend artifacts. */
export function backendBinding(sha256: string | null, provenance: BuildProvenance): string {
  if (provenance.status !== "verified") return provenance.status;
  return createHash("sha256")
    .update(JSON.stringify([sha256, provenance.commit, provenance.treeSha256]))
    .digest("hex");
}
