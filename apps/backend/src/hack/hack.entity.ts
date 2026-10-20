import { Entity, PrimaryGeneratedColumn, PrimaryColumn, Column, Index } from "typeorm";

import { HackStatus } from "@libreoj/judge-protocol";

import { JsonColumn } from "../database/json-column";

@Entity("hack")
@Index("IDX_hack_list", ["contestId", "problemId", "hackerId", "status", "id"])
export class HackEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column({ type: "integer" }) @Index() submissionId: number;

  @Column({ type: "integer" }) @Index() problemId: number;

  @Column({ type: "integer", nullable: true }) @Index() contestId: number;

  @Column({ type: "integer", nullable: true }) contestProblemId: number;

  @Column({ type: "integer" }) submitterId: number;

  @Column({ type: "integer" }) @Index() hackerId: number;

  @Column({ type: "varchar", length: 24, default: HackStatus.Pending }) status: HackStatus;

  @Column({ type: "varchar", length: 36, nullable: true }) @Index({ unique: true }) taskId: string;

  @Column({ type: "mediumtext" }) inputData: string;

  @JsonColumn() snapshot: unknown;

  @Column({ type: "varchar", length: 64 }) targetFingerprint: string;

  @Column({ type: "text", nullable: true }) message: string;

  @Column({ type: "integer", nullable: true }) timeUsed: number;

  @Column({ type: "integer", nullable: true }) memoryUsed: number;

  @Column({ type: "datetime" }) @Index() createTime: Date;

  @Column({ type: "datetime", nullable: true }) finishTime: Date;
}

@Entity("hack_problem")
export class HackProblemEntity {
  @PrimaryColumn({ type: "integer" }) problemId: number;

  @Column({ type: "integer" }) referenceSubmissionId: number;

  @JsonColumn({ nullable: true }) standardContent: unknown;

  @Column({ type: "varchar", length: 20 }) validatorLanguage: string;

  @Column({ type: "mediumtext" }) validatorCode: string;

  @Column({ type: "integer" }) configuredById: number;

  @Column({ type: "datetime" }) updateTime: Date;
}
