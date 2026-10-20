import { Column, Entity, Index, PrimaryColumn } from "typeorm";

import type { AiExecutionProgress } from "@libreoj/judge-protocol";

import { JsonColumn } from "../database/json-column";

export enum AiExecutionState {
  // Waiting for a judge machine
  Queued = "Queued",
  // Sent to a judge machine
  Running = "Running",
  // Terminal
  Complete = "Complete",
  Failed = "Failed",
  Canceled = "Canceled"
}

/**
 * A run of an AI job's programs on a judge machine (an AiExecution judge task), instead of the local AI runner. Its
 * request and the files it generates are temporary objects in storage; the AI job waits for its result here.
 */
@Entity("ai_execution")
@Index(["jobId"])
@Index(["state", "createdAt"])
export class AiExecutionEntity {
  // Also the judge task's ID
  @PrimaryColumn({ type: "char", length: 36 })
  taskId: string;

  @Column({ type: "varchar", length: 36 })
  jobId: string;

  @Column({ type: "varchar", length: 10 })
  state: AiExecutionState;

  // The stored files the request's sample files are
  @JsonColumn()
  sampleFiles: { name: string; uuid: string }[];

  // The latest progress while it runs
  @JsonColumn({ nullable: true })
  progress: Pick<AiExecutionProgress, "phase" | "completed" | "total">;

  // The judge's final progress
  @JsonColumn({ nullable: true })
  result: AiExecutionProgress;

  // The files the judge was given upload forms for
  @JsonColumn({ nullable: true })
  uploads: { name: string; size: number }[];

  @Column({ type: "datetime", precision: 3 })
  createdAt: Date;

  @Column({ type: "datetime", precision: 3, nullable: true })
  finishedAt: Date;
}
