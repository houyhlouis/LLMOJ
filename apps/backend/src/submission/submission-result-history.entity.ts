import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, JoinColumn } from "typeorm";

import { SubmissionEntity } from "./submission.entity";
import { SubmissionProgress } from "./submission-progress.interface";

/**
 * A result a rejudge replaced, so the previous result isn't lost. Only the most recent few are kept per submission.
 */
@Entity("submission_result_history")
export class SubmissionResultHistoryEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => SubmissionEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  submission: Promise<SubmissionEntity>;

  @Column()
  @Index()
  submissionId: number;

  // The data version it was judged with; null for results from before data versions
  @Column({ type: "integer", nullable: true })
  problemDataVersionId: number;

  // What it was judged with; null if not recorded
  @Column({ type: "integer", nullable: true })
  judgeRuntimeId: number;

  @Column({ type: "varchar", length: 32 })
  status: string;

  @Column({ type: "integer", nullable: true })
  score: number;

  @Column({ type: "integer", nullable: true })
  timeUsed: number;

  @Column({ type: "integer", nullable: true })
  memoryUsed: number;

  @Column({ type: "integer", nullable: true })
  totalOccupiedTime: number;

  @Column({ type: "json", nullable: true })
  result: SubmissionProgress;

  @Column({ type: "datetime" })
  replacedAt: Date;

  // Who rejudged it
  @Column({ type: "integer", nullable: true })
  replacedBy: number;
}
