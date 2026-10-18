import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";

export enum JudgeJobState {
  // Waiting for a judge client (from `availableAt`)
  Queued = "Queued",
  // Assigned to a judge client connection until `leaseUntil`, renewed while it stays connected
  Leased = "Leased",
  // Terminal states
  Finished = "Finished",
  Canceled = "Canceled",
  Failed = "Failed"
}

/**
 * The durable judge queue: one row per judge task. The task's resource (a submission, hack or self evaluation)
 * references the same `taskId` while the task is active. Redis only wakes up waiting consumers.
 */
@Entity("judge_job")
@Index(["state", "priority", "createdAt"])
@Index(["state", "leaseUntil"])
export class JudgeJobEntity {
  @PrimaryColumn({ type: "char", length: 36 })
  taskId: string;

  @Column({ type: "varchar", length: 24 })
  type: string;

  // Smaller is judged first; ties by creation time
  @Column({ type: "double" })
  priority: number;

  @Column({ type: "varchar", length: 10 })
  state: JudgeJobState;

  @Column({ type: "datetime", precision: 3 })
  createdAt: Date;

  @Column({ type: "datetime", precision: 3 })
  availableAt: Date;

  // Incremented by every lease. A result is accepted only from the connection holding the current fence.
  @Column({ type: "integer", unsigned: true })
  fence: number;

  // The judge client connection (Socket.IO session ID) holding the lease
  @Column({ type: "varchar", length: 40, nullable: true })
  leaseOwner: string;

  @Column({ type: "integer", nullable: true })
  judgeClientId: number;

  @Column({ type: "datetime", precision: 3, nullable: true })
  leaseUntil: Date;

  // Leases that ended without a result (disconnect, expiry, a crashed task handler)
  @Column({ type: "smallint", unsigned: true })
  unfinishedLeases: number;

  @Column({ type: "smallint", unsigned: true })
  preparationFailures: number;

  @Column({ type: "varchar", length: 255, nullable: true })
  lastError: string;

  // SHA-256 of the accepted final result, to tell a resent result from a conflicting one
  @Column({ type: "char", length: 64, nullable: true })
  resultHash: string;

  @Column({ type: "datetime", precision: 3, nullable: true })
  finishedAt: Date;
}

export enum JudgeJobAttemptOutcome {
  Finished = "Finished",
  Canceled = "Canceled",
  // The connection closed before a result
  Disconnected = "Disconnected",
  // The lease wasn't renewed in time (e.g. its backend process stopped)
  Expired = "Expired",
  // The judge client finished the task without a result
  Abandoned = "Abandoned",
  // Preparing the task to send failed; retried later
  NotPrepared = "NotPrepared",
  Failed = "Failed"
}

/** Retained history of the leases of a judge job. */
@Entity("judge_job_attempt")
@Index(["taskId", "fence"], { unique: true })
@Index(["startedAt"])
export class JudgeJobAttemptEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "char", length: 36 })
  taskId: string;

  @Column({ type: "integer", unsigned: true })
  fence: number;

  @Column({ type: "integer", nullable: true })
  judgeClientId: number;

  // What the judge client judges with (see `JudgeRuntimeEntity`); null if it announced nothing
  @Column({ type: "integer", nullable: true })
  judgeRuntimeId: number;

  @Column({ type: "varchar", length: 40 })
  leaseOwner: string;

  @Column({ type: "datetime", precision: 3 })
  startedAt: Date;

  @Column({ type: "datetime", precision: 3, nullable: true })
  endedAt: Date;

  @Column({ type: "varchar", length: 16, nullable: true })
  outcome: JudgeJobAttemptOutcome;
}
