import { Column, Entity, Index, PrimaryColumn } from "typeorm";

import type { AiArtifactRef, AiExecutionProfile, AiFailureKind, AiFailureObservation } from "@libreoj/judge-protocol";

import { JsonColumn } from "../database/json-column";

/**
 * Whether an observation's artifacts are kept: all of them ("stored"), some ("partial"), none because it has none
 * ("none"), none because they couldn't be kept ("unavailable"), or no longer ("expired").
 */
export type AiEvidenceState = "stored" | "partial" | "none" | "unavailable" | "expired";

export interface StoredAiArtifact extends AiArtifactRef {
  // Whether its bytes are in storage, and why not
  stored: boolean;
  missing?: string;
}

/** An observation as kept: what the runner observed, and the run it belongs to. */
export interface StoredAiObservation extends Omit<AiFailureObservation, "artifacts"> {
  artifacts: StoredAiArtifact[];
  // Where the run was: the local AI runner, a judge machine, or the backend itself (transport and time limits)
  origin: "local" | "judge" | "backend";
  operation: "generate" | "validate-reference";
  attemptId: string;
  // Of the run (absent for one the backend observed)
  sourceHashes?: Record<string, string>;
  profile?: AiExecutionProfile;
  // A tutorial's solution that failed its sample check: the job went on with a model-written reference solution
  context?: "tutorial-reference";
}

/**
 * A failed AI run's observation (review Part III, W01), kept for the job's owner: what failed, how, and the exact
 * input, outputs and diagnostics, which are temporary objects under temporary/ai-evidence/<id>/ until `expiresAt`.
 * The row itself, without its evidence and previews, stays a while longer.
 */
@Entity("ai_observation")
@Index(["jobId", "createdAt"])
@Index(["expiresAt"])
export class AiObservationEntity {
  // Derived from the run's attempt ID and the observation's index, so that recording it twice records it once
  @PrimaryColumn({ type: "char", length: 36 })
  id: string;

  @Column({ type: "varchar", length: 36 })
  jobId: string;

  // The job's run that recorded it; null if recorded later (e.g. after the backend restarted)
  @Column({ type: "varchar", length: 36, nullable: true })
  runToken: string;

  // Whether it ended the job's run
  @Column({ type: "boolean" })
  fatal: boolean;

  @Column({ type: "varchar", length: 32 })
  kind: AiFailureKind;

  @Column({ type: "varchar", length: 16 })
  evidence: AiEvidenceState;

  // Bytes of evidence kept in storage
  @Column({ type: "int" })
  bytes: number;

  @JsonColumn()
  observation: StoredAiObservation;

  @Column({ type: "datetime", precision: 3 })
  createdAt: Date;

  // When its evidence is deleted
  @Column({ type: "datetime", precision: 3 })
  expiresAt: Date;
}
