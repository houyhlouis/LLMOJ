// Compare a cold scoring call with the old full-row read and the backend's current projection.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readBenchmarkDatabase } from "./seed.mjs";

const backend = createRequire(new URL("../../apps/backend/package.json", import.meta.url));
const usage =
  "node deploy/benchmark/strict-ioi.mjs --config DIR/backend.yaml --manifest DIR/benchmark.json [--yes-this-is-disposable]";
class MeasurementError extends Error {}

export async function measureStrictScore(runner, manifest, mode) {
  const { ContestScoreService } = backend("./dist/contest/contest-score.service");
  const { ContestEntity } = backend("./dist/contest/contest.entity");
  const { ContestProblemEntity } = backend("./dist/contest/contest-problem.entity");
  const { SubmissionDetailEntity } = backend("./dist/submission/submission-detail.entity");
  // One leased mysql2 socket. Its read counter includes result-set metadata and packet headers.
  const { stream } = await runner.connect();
  if (!Number.isSafeInteger(stream?.bytesRead))
    throw new MeasurementError("The mysql2 connection has no byte counter.");
  const contest = await runner.manager.findOneBy(ContestEntity, { id: manifest.ids.strictContest });
  if (contest?.rule !== "strictioi")
    throw new MeasurementError("The manifest must identify a seeded strict IOI contest.");
  const problems = await runner.manager.find(ContestProblemEntity, {
    where: { contestId: contest.id },
    select: { id: true, weight: true },
    order: { position: "ASC", id: "ASC" }
  });
  let detailQueryBytes = 0;
  let detailRows = 0;
  const repository = runner.manager.getRepository(SubmissionDetailEntity);
  const details = {
    async find(options) {
      const start = stream.bytesRead;
      const rows = mode === "full" ? await repository.findBy(options.where) : await repository.find(options);
      detailQueryBytes += stream.bytesRead - start;
      detailRows += rows.length;
      return rows;
    }
  };
  // A new service without a revision cache, using this connection for both real scoring queries.
  const service = new ContestScoreService({
    getRepository: entity => (entity === SubmissionDetailEntity ? details : runner.manager.getRepository(entity))
  });
  const rssBeforeBytes = process.memoryUsage.rss();
  const started = performance.now();
  const scores = await service.contestScores(contest, problems);
  const elapsedMs = performance.now() - started;
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  if (detailRows !== manifest.counts.strictSubmissions || !detailQueryBytes || !scores.length)
    throw new MeasurementError(
      "Scoring did not read the expected fixture. Rebuild the backend and verify the seed manifest."
    );
  return {
    mode,
    contestId: contest.id,
    detailRows,
    detailQueryBytes,
    rssBeforeBytes,
    peakRssBytes,
    elapsedMs,
    rankedUsers: scores.length,
    scoreSha256: createHash("sha256").update(JSON.stringify(scores)).digest("hex")
  };
}

async function measure(database, manifest, mode) {
  backend("reflect-metadata");
  const { DataSource } = backend("typeorm");
  const ds = new DataSource({
    ...database,
    entities: [fileURLToPath(new URL("../../apps/backend/dist/**/*.entity.js", import.meta.url))],
    synchronize: false,
    migrationsRun: false,
    logging: false,
    connectorPackage: "mysql2",
    poolSize: 1
  });
  await ds.initialize();
  const runner = ds.createQueryRunner();
  try {
    return await measureStrictScore(runner, manifest, mode);
  } finally {
    await runner.release();
    await ds.destroy();
  }
}

async function main(args) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      manifest: { type: "string" },
      mode: { type: "string" },
      "yes-this-is-disposable": { type: "boolean" },
      help: { type: "boolean" }
    }
  });
  if (values.help) return console.log(usage);
  if (!values.config || !values.manifest) throw new MeasurementError(usage);
  const manifest = JSON.parse(await readFile(values.manifest, "utf8"));
  if (
    manifest.version !== 1 ||
    !Number.isSafeInteger(manifest.ids?.strictContest) ||
    !(manifest.counts?.strictSubmissions > 0)
  )
    throw new MeasurementError("Seed with --strict-submissions before measuring.");
  if (values.mode !== undefined) {
    if (!["full", "projected"].includes(values.mode)) throw new MeasurementError("Unknown scoring projection.");
    const db = await readBenchmarkDatabase(values.config, values["yes-this-is-disposable"]);
    return console.log(JSON.stringify(await measure(db, manifest, values.mode)));
  }
  // The OS high-water mark belongs to one process. Run each projection in a fresh process.
  const run = mode =>
    JSON.parse(
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...args, "--mode", mode], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"]
      })
    );
  const full = run("full"),
    projected = run("projected");
  if (full.scoreSha256 !== projected.scoreSha256) throw new MeasurementError("The two scoring results differ.");
  console.log(
    JSON.stringify(
      {
        version: 1,
        seed: manifest.seed,
        sourceBytesPerSubmission: manifest.sourceBytes,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        full,
        projected,
        detailBytesSaved: full.detailQueryBytes - projected.detailQueryBytes
      },
      null,
      2
    )
  );
}

if (import.meta.main)
  main(process.argv.slice(2)).catch(error => {
    // Config parser and driver messages may contain credentials or query parameters.
    console.error(
      error instanceof MeasurementError
        ? error.message
        : `Strict IOI measurement failed (${error.code || "check the disposable config, manifest and backend build"}).`
    );
    process.exitCode = 1;
  });
