import type { DataSource } from "typeorm";

import {
  backendBinding,
  isDigest,
  storedProvenance,
  unknownProvenance,
  type BuildProvenance
} from "./release-provenance";

import { SettingsEntity } from "../settings/settings.entity";

const KEY = "deployment.buildHistory";
const LIMIT = 20;
type Binding = { sha256: string; firstSeenAt: string; provenance: BuildProvenance };

function bindings(value: unknown): Binding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, LIMIT).flatMap(row => {
    const provenance = storedProvenance(row?.provenance);
    return provenance.status === "verified" &&
      isDigest(row.sha256) &&
      typeof row.firstSeenAt === "string" &&
      Number.isFinite(Date.parse(row.firstSeenAt))
      ? [{ sha256: row.sha256, firstSeenAt: row.firstSeenAt, provenance }]
      : [];
  });
}

export async function recordBackendBinding(
  db: DataSource,
  backend: { sha256: string | null; capturedAt: string; provenance: BuildProvenance }
) {
  const { sha256, capturedAt: firstSeenAt } = backend;
  const provenance = storedProvenance(backend.provenance);
  if (provenance.status !== "verified" || !isDigest(sha256)) return;
  await db.transaction("READ COMMITTED", async manager => {
    // Serialize initial creation as well as updates from clustered backends.
    await manager.query(
      "INSERT INTO settings (`key`, value) VALUES (?, '[]') ON DUPLICATE KEY UPDATE `key`=VALUES(`key`)",
      [KEY]
    );
    const repository = manager.getRepository(SettingsEntity);
    const row = await repository.findOneByOrFail({ key: KEY });
    const history = bindings(row.value);
    const matches = (binding: Binding) =>
      binding.sha256 === sha256 &&
      binding.provenance.commit === provenance.commit &&
      binding.provenance.treeSha256 === provenance.treeSha256;
    const existing = history.find(matches);
    const earliest = existing && existing.firstSeenAt < firstSeenAt ? existing.firstSeenAt : firstSeenAt;
    await repository.update(
      { key: KEY },
      {
        value: [{ sha256, firstSeenAt: earliest, provenance }, ...history.filter(binding => !matches(binding))].slice(
          0,
          LIMIT
        )
      }
    );
  });
}

export async function readBackendBindings(db: DataSource) {
  const row = await db.getRepository(SettingsEntity).findOneBy({ key: KEY });
  return bindings(row?.value);
}

export function historicalProvenance(
  sha256: string | null,
  observation: string | undefined,
  history: Binding[]
): BuildProvenance {
  if (observation === "mismatch") return { status: "mismatch", commit: null, treeSha256: null };
  if (!isDigest(sha256) || !isDigest(observation)) return unknownProvenance;
  return (
    history.find(binding => binding.sha256 === sha256 && backendBinding(sha256, binding.provenance) === observation)
      ?.provenance || unknownProvenance
  );
}
