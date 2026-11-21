import { Entity, Column, PrimaryColumn, Index, CreateDateColumn, UpdateDateColumn, VersionColumn } from "typeorm";

import type { AiJobProjection, AiStageAttempt } from "./ai-job-view";

import { JsonColumn } from "../database/json-column";

@Entity("ai_configuration")
export class AiConfigurationEntity {
  @PrimaryColumn() userId: number;

  @Column({ type: "longtext" }) encrypted: string;

  @UpdateDateColumn() updatedAt: Date;
}

export const AI_ACTIONS = [
  "metadata",
  "tags",
  "source",
  "difficulty",
  "translate",
  "tutorial",
  "testdata",
  "all",
  "import"
] as const;
export type AiAction = (typeof AI_ACTIONS)[number];
export const AI_JOB_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

@Entity("ai_job")
@Index(["ownerId", "createdAt"])
@Index(["problemId", "status"])
@Index("IDX_ai_job_owner_status_created", ["ownerId", "status", "createdAt", "id"])
export class AiJobEntity {
  @PrimaryColumn({ type: "varchar", length: 36 }) id: string;

  @Column() ownerId: number;

  @Column({ nullable: true }) problemId: number;

  @Column({ type: "varchar", length: 20 }) action: AiAction;

  @Column({ type: "varchar", length: 20, default: "queued" }) status: AiJobStatus;

  @Column({ type: "varchar", length: 36, nullable: true }) runToken: string;

  @Column({ default: 0 }) progress: number;

  @Column({ type: "varchar", length: 80, default: "queued" }) step: string;

  @JsonColumn() input: {
    count: number;
    workflow?: import("./ai-workflow-state").AiWorkflowOption;
    corpusPolicy?: import("./ai-workflow-state").AiCorpusPolicy;
    allocationMode?: "coverage" | "score_ratio";
    markdown?: string;
    image?: string;
    attachmentToken?: string;
    problemType?: "Traditional" | "Interaction" | "Communication";
    communicationMode?: "run-twice" | "grader";
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Persisted AI checkpoints contain versioned model and runner payloads; keep backward compatibility.
  @JsonColumn() state: Record<string, any>;

  @Column({ type: "text", nullable: true }) error: string;

  @VersionColumn({ default: 1 }) revision: number;

  @Column({ default: 0 }) attempt: number;

  @Column({ type: "datetime", precision: 6, nullable: true }) stageStartedAt: Date;

  @Column({ type: "datetime", precision: 6, nullable: true }) stageEndedAt: Date;

  @JsonColumn({ nullable: true }) projection: AiJobProjection;

  @JsonColumn({ nullable: true }) timeline: {
    entries: AiStageAttempt[];
    omitted: number;
    legacyHistoryUnavailable?: boolean;
  };

  @CreateDateColumn() createdAt: Date;

  @UpdateDateColumn() updatedAt: Date;
}
