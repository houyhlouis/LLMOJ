import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";

import { JsonColumn } from "../database/json-column";

@Entity("self_eval_set")
export class SelfEvalSetEntity {
  @PrimaryColumn({ type: "varchar", length: 80 }) scope: string;

  @Column({ type: "integer" }) problemId: number;

  @Column({ type: "integer", nullable: true }) contestId: number;

  @Column({ type: "varchar", length: 64 }) recipeHash: string;

  @Column({ type: "varchar", length: 64 }) configHash: string;

  @Column({ type: "varchar", length: 36, nullable: true }) @Index({ unique: true }) taskId: string;

  @Column({ type: "varchar", length: 24 }) status: string;

  @JsonColumn({ nullable: true }) cases: unknown;

  @Column({ type: "text", nullable: true }) message: string;

  @JsonColumn() snapshot: unknown;

  @Column({ type: "datetime" }) createdAt: Date;
}

@Entity("self_eval")
@Index("IDX_self_eval_list", ["contestId", "submitterId", "id"])
export class SelfEvalEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column({ type: "varchar", length: 80 }) scope: string;

  @Column({ type: "integer" }) @Index() problemId: number;

  @Column({ type: "integer", nullable: true }) contestId: number;

  @Column({ type: "integer" }) submitterId: number;

  @Column({ type: "varchar", length: 24 }) status: string;

  @Column({ type: "varchar", length: 36, nullable: true }) @Index({ unique: true }) taskId: string;

  @Column({ type: "integer", nullable: true }) score: number;

  @Column({ type: "integer", nullable: true }) timeUsed: number;

  @Column({ type: "integer", nullable: true }) memoryUsed: number;

  @JsonColumn({ nullable: true }) feedback: unknown;

  @JsonColumn() content: unknown;

  @JsonColumn() snapshot: unknown;

  @Column({ type: "datetime" }) createTime: Date;

  @Column({ type: "datetime", nullable: true }) finishTime: Date;
}

@Entity("self_eval_quota")
export class SelfEvalQuotaEntity {
  @PrimaryColumn({ type: "varchar", length: 80 }) scope: string;

  @PrimaryColumn({ type: "integer" }) userId: number;

  @Column({ type: "integer", default: 0 }) used: number;
}
