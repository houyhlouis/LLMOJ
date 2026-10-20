import { Entity, PrimaryColumn, OneToOne, Column, JoinColumn, Index, Unique } from "typeorm";

import { SubmissionProgress } from "./submission-progress.interface";
import { SubmissionEntity } from "./submission.entity";

import { JsonColumn } from "../database/json-column";

@Entity("submission_detail")
// The unique index TypeORM 0.3.7 also made for this one-to-one primary key; newer TypeORM leaves it out, so it
// is declared to keep the schema of existing and new installations the same
@Unique("REL_23be757795c044a246c82e414e", ["submissionId"])
export class SubmissionDetailEntity {
  @OneToOne(() => SubmissionEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  submission: Promise<SubmissionEntity>;

  @PrimaryColumn()
  submissionId: number;

  @JsonColumn()
  content: unknown;

  @Column({ type: "char", length: 36, nullable: true })
  @Index({ unique: true })
  fileUuid: string;

  @JsonColumn({ nullable: true })
  result: SubmissionProgress;
}
