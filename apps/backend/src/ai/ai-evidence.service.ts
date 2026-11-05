import { createHash } from "crypto";
import { constants, promises as fs } from "fs";

import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, In, LessThan, Not } from "typeorm";

import {
  AI_EVIDENCE_FILE,
  AiArtifactRef,
  AiArtifactRole,
  AiFailureKind,
  AiFailureObservation,
  AiRunFailure,
  textPreview
} from "@libreoj/judge-protocol";

import { AiEvidenceState, AiObservationEntity, StoredAiArtifact, StoredAiObservation } from "./ai-observation.entity";
import { AiJobEntity } from "./ai.entity";
import { AiError } from "./ai.types";
import type { AiReplayRecord } from "./ai-replay";

import { logger } from "../logger";
import { FileService, MinioSignFor, TEMPORARY_OBJECT_PREFIX } from "../file/file.service";

const OBJECT_PREFIX = `${TEMPORARY_OBJECT_PREFIX}ai-evidence/`;
const DAY = 24 * 60 * 60 * 1000;
// Evidence is kept this long; an observation without it until OBSERVATION_RETENTION after it was made
export const EVIDENCE_RETENTION = 14 * DAY;
const OBSERVATION_RETENTION = 90 * DAY;
// Storage for evidence, of one job and of the whole site; and observations of one job
const JOB_EVIDENCE_BYTES = 256 * 1024 * 1024;
const SITE_EVIDENCE_BYTES = 2 * 1024 * 1024 * 1024;
const JOB_OBSERVATIONS = 64;
// An artifact is read this much at a time
const RANGE_BYTES = 64 * 1024;
// Objects of an observation whose row isn't there are deleted after this (it may still be being recorded)
const UNRECORDED_GRACE = 60 * 60 * 1000;
const SWEEP_BATCH = 500;
const STORE_ATTEMPTS = 3;
// Replays kept with an observation
const REPLAYS = 5;

const sha256Of = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export const evidenceObject = (id: string, role: AiArtifactRole) => `${OBJECT_PREFIX}${id}/${role}`;

/** A UUID-shaped ID of a run's observation: the same run's observation always gets the same one. */
export function observationId(attemptId: string, index: number) {
  const hex = createHash("sha256").update(`${attemptId}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Where a run's evidence files are until they're stored. */
export interface EvidenceSource {
  origin: "local" | "judge";
  // A local file with the named evidence, or null if there's none; `done` lets it go
  fetch(name: string, size: number): Promise<{ path: string; done?: () => Promise<void> } | null>;
}

export interface RecordOptions {
  // The job's run that records it
  runToken?: string;
  // A failure the job went on after: not the one that ended its run
  context?: StoredAiObservation["context"];
}

/** What the job's owner sees of an observation. */
export type AiObservationView = Omit<StoredAiObservation, "attemptId"> & {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  evidence: AiEvidenceState;
  // The failure that ended the job's latest run
  current: boolean;
};

export type AiFailureSummary = Pick<
  AiObservationView,
  "id" | "kind" | "phase" | "role" | "candidate" | "subject" | "verdict" | "evidence" | "expiresAt"
>;

function stateOf(observation: AiFailureObservation, artifacts: StoredAiArtifact[]): AiEvidenceState {
  const stored = artifacts.filter(artifact => artifact.stored).length;
  if (!artifacts.length) return observation.evidenceError ? "unavailable" : "none";
  if (stored === artifacts.length && !observation.evidenceError) return "stored";
  return stored ? "partial" : "unavailable";
}

/**
 * Keeps the observations of failed AI runs with their evidence (review Part III, H01/W01): the exact input, outputs
 * and diagnostics a run reported, copied into storage before the run's workspace is cleaned up, for the job's owner to
 * inspect. Evidence is bounded per job and for the site, and deleted after EVIDENCE_RETENTION. Who may read it is the
 * AI service's decision; this service only reads what belongs to the job it's given.
 */
@Injectable()
export class AiEvidenceService {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    private readonly fileService: FileService
  ) {}

  private get repository() {
    return this.connection.getRepository(AiObservationEntity);
  }

  /**
   * Records a failed run's observations and stores their evidence from `source`. Recording the same run again records
   * nothing new. Returns the ID of the observation that ended the run.
   */
  async record(
    job: Pick<AiJobEntity, "id">,
    failure: AiRunFailure,
    source: EvidenceSource,
    options: RecordOptions = {}
  ): Promise<string> {
    const ids = failure.observations.map((observation, index) => observationId(failure.attemptId, index));
    if (await this.repository.existsBy({ id: ids[0] })) return ids[0];
    const runBytes = failure.observations.reduce(
      (total, observation) => total + observation.artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
      0
    );
    const refusal = runBytes ? await this.quotaRefusal(job.id, runBytes) : null;
    const now = new Date();
    const rows: AiObservationEntity[] = [];
    for (const [index, observation] of failure.observations.entries()) {
      const id = ids[index];
      const artifacts: StoredAiArtifact[] = [];
      for (const artifact of observation.artifacts) {
        // eslint-disable-next-line no-await-in-loop -- One artifact at a time
        const missing = refusal || (await this.store(id, artifact, source));
        artifacts.push({ ...artifact, stored: !missing, ...(missing ? { missing } : {}) });
      }
      rows.push({
        id,
        jobId: job.id,
        runToken: options.runToken || null,
        fatal: index === 0 && !options.context,
        kind: observation.kind,
        evidence: stateOf(observation, artifacts),
        bytes: artifacts.reduce((sum, artifact) => sum + (artifact.stored ? artifact.size : 0), 0),
        observation: {
          ...observation,
          artifacts,
          origin: source.origin,
          operation: failure.operation,
          attemptId: failure.attemptId,
          sourceHashes: failure.sourceHashes,
          profile: failure.profile,
          ...(options.context ? { context: options.context } : {})
        },
        createdAt: now,
        expiresAt: new Date(+now + EVIDENCE_RETENTION)
      });
    }
    // Recorded at the same time elsewhere (e.g. by the cleanup of another backend): the same rows and objects
    await this.repository.createQueryBuilder().insert().into(AiObservationEntity).values(rows).orIgnore().execute();
    return ids[0];
  }

  /**
   * Records a failure the backend observed itself, without evidence: the run's transport or time limit, or a runner
   * that kept no evidence.
   */
  async recordObserved(
    job: Pick<AiJobEntity, "id">,
    attemptId: string,
    observed: { kind: AiFailureKind; phase: string; summary: string; evidenceError?: string },
    operation: StoredAiObservation["operation"],
    options: RecordOptions = {}
  ): Promise<string> {
    const id = observationId(attemptId, 0);
    const now = new Date();
    const observation: StoredAiObservation = {
      kind: observed.kind,
      fatal: true,
      phase: (observed.phase || "queued").slice(0, 64),
      summary: observed.summary.slice(0, 2000),
      artifacts: [],
      ...(observed.evidenceError ? { evidenceError: observed.evidenceError } : {}),
      origin: "backend",
      operation,
      attemptId,
      ...(options.context ? { context: options.context } : {})
    };
    await this.repository
      .createQueryBuilder()
      .insert()
      .into(AiObservationEntity)
      .values({
        id,
        jobId: job.id,
        runToken: options.runToken || null,
        fatal: !options.context,
        kind: observed.kind,
        evidence: observed.evidenceError ? "unavailable" : "none",
        bytes: 0,
        observation,
        createdAt: now,
        expiresAt: new Date(+now + EVIDENCE_RETENTION)
      })
      .orIgnore()
      .execute();
    return id;
  }

  // Why no evidence of this size may be stored for the job, if it may not
  private async quotaRefusal(jobId: string, bytes: number): Promise<string> {
    const [usage] = await this.connection.query(
      `SELECT COALESCE(SUM(bytes), 0) AS site, COALESCE(SUM(IF(jobId = ?, bytes, 0)), 0) AS job,
        COALESCE(SUM(jobId = ?), 0) AS observations FROM ai_observation WHERE evidence IN ('stored', 'partial')
          OR jobId = ?`,
      [jobId, jobId, jobId]
    );
    if (Number(usage.observations) >= JOB_OBSERVATIONS) return "This job has kept as many failures as it may";
    if (Number(usage.job) + bytes > JOB_EVIDENCE_BYTES) return "This job's storage for failure evidence is full";
    if (Number(usage.site) + bytes > SITE_EVIDENCE_BYTES) return "The site's storage for failure evidence is full";
    return null;
  }

  // Stores an artifact; returns why it couldn't be, or null
  private async store(id: string, artifact: AiArtifactRef, source: EvidenceSource): Promise<string> {
    let local: Awaited<ReturnType<EvidenceSource["fetch"]>> = null;
    try {
      if (!AI_EVIDENCE_FILE.test(artifact.name)) return "Not an evidence file";
      local = await source.fetch(artifact.name, artifact.size);
      if (!local) return "The run didn't keep it";
      // eslint-disable-next-line no-bitwise
      const file = await fs.open(local.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== artifact.size) return "It isn't what the run reported";
        // At most an artifact's limit, read once: checked before it's stored, and stored again on a storage error
        const data = await file.readFile();
        if (data.length !== artifact.size || sha256Of(data) !== artifact.sha256)
          return "It isn't what the run reported";
        await this.fileService.uploadFile(evidenceObject(id, artifact.role), data, STORE_ATTEMPTS);
        return null;
      } finally {
        await file.close();
      }
    } catch (error) {
      logger.error(`Failed to store the AI failure evidence ${artifact.name} of observation ${id}: ${error}`);
      return "It couldn't be stored";
    } finally {
      await local?.done?.().catch(() => undefined);
    }
  }

  /** A job's observation as it's kept. */
  async observation(job: Pick<AiJobEntity, "id">, id: string): Promise<AiObservationEntity> {
    const row = await this.repository.findOneBy({ id, jobId: job.id });
    if (!row) throw new AiError("NO_SUCH_OBSERVATION");
    return row;
  }

  /** Adds a replay to an observation; its REPLAYS latest are kept. */
  async addReplay(id: string, replay: AiReplayRecord): Promise<void> {
    await this.changeReplays(id, replays => [...replays, replay].slice(-REPLAYS));
  }

  /** Records how a replay went. */
  async updateReplay(id: string, replayId: string, changes: Partial<AiReplayRecord>): Promise<void> {
    await this.changeReplays(id, replays =>
      replays.map(replay => (replay.id === replayId ? { ...replay, ...changes } : replay))
    );
  }

  private async changeReplays(id: string, change: (replays: AiReplayRecord[]) => AiReplayRecord[]) {
    await this.connection.transaction(async manager => {
      const row = await manager.findOne(AiObservationEntity, { where: { id }, lock: { mode: "pessimistic_write" } });
      if (!row) return;
      await manager.update(
        AiObservationEntity,
        { id },
        { observation: { ...row.observation, replays: change(row.observation.replays || []) } }
      );
    });
  }

  /** A job's observations, latest first, as its owner sees them. */
  async list(job: AiJobEntity): Promise<AiObservationView[]> {
    const rows = await this.repository.find({
      where: { jobId: job.id },
      // A run's observations share their time: the one that ended it first, then those related to it
      order: { createdAt: "DESC", fatal: "DESC", id: "ASC" },
      take: JOB_OBSERVATIONS
    });
    return rows.map(row => this.view(row, job));
  }

  private view(row: AiObservationEntity, job: AiJobEntity): AiObservationView {
    // The attempt ID is the judge task's or the runner's own; the owner sees the observation's
    const observation: Omit<StoredAiObservation, "attemptId"> & { attemptId?: string } = { ...row.observation };
    delete observation.attemptId;
    return {
      ...observation,
      id: row.id,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      evidence: row.evidence,
      current: this.isCurrent(row, job)
    };
  }

  private isCurrent(row: Pick<AiObservationEntity, "fatal" | "runToken">, job: AiJobEntity) {
    return row.fatal && job.status === "failed" && !!row.runToken && row.runToken === job.runToken;
  }

  /** For each job: how many observations it has, and the failure that ended its latest run if it failed. */
  async summaries(jobs: AiJobEntity[]): Promise<Map<string, { count: number; failure?: AiFailureSummary }>> {
    const result = new Map<string, { count: number; failure?: AiFailureSummary }>();
    if (!jobs.length) return result;
    const counts: { jobId: string; count: string }[] = await this.repository
      .createQueryBuilder("observation")
      .select("observation.jobId", "jobId")
      .addSelect("COUNT(*)", "count")
      .where({ jobId: In(jobs.map(job => job.id)) })
      .groupBy("observation.jobId")
      .getRawMany();
    for (const { jobId, count } of counts) result.set(jobId, { count: Number(count) });
    const failed = jobs.filter(job => job.status === "failed" && job.runToken && result.has(job.id));
    if (!failed.length) return result;
    const rows = await this.repository.find({
      where: { jobId: In(failed.map(job => job.id)), fatal: true, runToken: In(failed.map(job => job.runToken)) },
      order: { createdAt: "DESC" }
    });
    for (const job of failed) {
      const row = rows.find(candidate => candidate.jobId === job.id && this.isCurrent(candidate, job));
      if (row)
        result.get(job.id).failure = {
          id: row.id,
          kind: row.kind,
          phase: row.observation.phase,
          role: row.observation.role,
          candidate: row.observation.candidate,
          subject: row.observation.subject,
          verdict: row.observation.verdict,
          evidence: row.evidence,
          expiresAt: row.expiresAt
        };
    }
    return result;
  }

  // An artifact of a job's observation whose bytes are in storage
  private async storedArtifact(job: AiJobEntity, id: string, role: AiArtifactRole) {
    const row = await this.repository.findOneBy({ id, jobId: job.id });
    if (!row) throw new AiError("NO_SUCH_OBSERVATION");
    const artifact = row.observation.artifacts.find(candidate => candidate.role === role);
    if (!artifact) throw new AiError("NO_SUCH_OBSERVATION");
    if (!artifact.stored || row.evidence === "expired" || row.expiresAt <= new Date())
      throw new AiError("EVIDENCE_UNAVAILABLE");
    return artifact;
  }

  /** A part of an artifact from `offset`, as text (see textPreview); `bytes` of it are shown. */
  async readArtifact(job: AiJobEntity, id: string, role: AiArtifactRole, offset: number) {
    const artifact = await this.storedArtifact(job, id, role);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.size)
      throw new AiError("INVALID_ARTIFACT_RANGE");
    // A little more than a part, to end it on a whole character
    const data =
      offset === artifact.size
        ? Buffer.alloc(0)
        : await this.fileService.readObjectRange(
            evidenceObject(id, role),
            offset,
            Math.min(RANGE_BYTES + 3, artifact.size - offset)
          );
    const preview = textPreview(data, RANGE_BYTES, 4096, role === "diagnostics");
    return { offset, bytes: preview.bytes, size: artifact.size, text: preview.text, binary: preview.binary };
  }

  /** A short-lived link to download an artifact. */
  async downloadLink(job: AiJobEntity, id: string, role: AiArtifactRole) {
    const artifact = await this.storedArtifact(job, id, role);
    return await this.fileService.signDownloadLink({
      uuid: evidenceObject(id, role),
      downloadFilename: `ai-failure-${id.slice(0, 8)}-${role}${artifact.binary ? ".bin" : ".txt"}`,
      signFor: MinioSignFor.UserDownload,
      expiresSeconds: 120
    });
  }

  /** The text of a stored artifact, up to `limit` characters (e.g. a compiler's diagnostics for a repair). */
  async readText(jobId: string, id: string, role: AiArtifactRole, limit: number): Promise<string> {
    const row = await this.repository.findOneBy({ id, jobId });
    const artifact = row?.observation.artifacts.find(candidate => candidate.role === role);
    if (!artifact?.stored) return null;
    const data = await this.fileService.readObjectRange(
      evidenceObject(id, role),
      0,
      Math.min(artifact.size, limit * 4)
    );
    // Without terminal colours: they're not for a model
    return (
      data
        .toString("utf8")
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
        .slice(0, limit)
    );
  }

  /**
   * Deletes evidence past its time (the observation stays, without its previews and excerpts, until
   * OBSERVATION_RETENTION), then such observations, then objects of observations that aren't recorded.
   */
  async sweep(now = Date.now()): Promise<void> {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- One batch at a time
      const expired = await this.repository.find({
        where: { expiresAt: LessThan(new Date(now)), evidence: Not("expired") },
        take: SWEEP_BATCH
      });
      for (const row of expired) {
        // eslint-disable-next-line no-await-in-loop -- One observation at a time
        const objects = await this.fileService.listTemporaryObjects(`${OBJECT_PREFIX}${row.id}/`);
        // eslint-disable-next-line no-await-in-loop -- One observation at a time
        if (objects.length) await this.fileService.removeTemporaryObjects(objects.map(object => object.name));
        const { difference, ...observation } = row.observation;
        // eslint-disable-next-line no-await-in-loop -- One observation at a time
        await this.repository.update(
          { id: row.id },
          {
            evidence: "expired",
            bytes: 0,
            observation: {
              ...observation,
              ...(difference ? { difference: { ...difference, actual: "", expected: "" } } : {}),
              artifacts: observation.artifacts.map(artifact => ({
                ...artifact,
                preview: "",
                stored: false,
                missing: "Expired"
              }))
            }
          }
        );
      }
      if (expired.length < SWEEP_BATCH) break;
    }
    await this.repository.delete({
      expiresAt: LessThan(new Date(now - (OBSERVATION_RETENTION - EVIDENCE_RETENTION)))
    });
    const idOf = (name: string) => name.slice(OBJECT_PREFIX.length).split("/")[0];
    const objects = (await this.fileService.listTemporaryObjects(OBJECT_PREFIX)).filter(
      object => +object.lastModified < now - UNRECORDED_GRACE
    );
    const ids = [...new Set(objects.map(object => idOf(object.name)))];
    const kept = new Set<string>();
    for (let i = 0; i < ids.length; i += SWEEP_BATCH) {
      // eslint-disable-next-line no-await-in-loop -- One batch at a time
      const rows = await this.repository.find({
        select: ["id"],
        where: { id: In(ids.slice(i, i + SWEEP_BATCH)), evidence: Not("expired") }
      });
      for (const row of rows) kept.add(row.id);
    }
    const unused = objects.filter(object => !kept.has(idOf(object.name))).map(object => object.name);
    if (unused.length) await this.fileService.removeTemporaryObjects(unused);
  }
}
