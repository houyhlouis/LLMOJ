import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { ContestEntity } from "./contest.entity";

import { UserEntity } from "../user/user.entity";

@Entity("contest_summary")
@Index(["contestId", "userId"], { unique: true })
export class ContestSummaryEntity {
  @PrimaryGeneratedColumn() id: number;

  @ManyToOne(() => ContestEntity, { onDelete: "CASCADE" }) @JoinColumn() contest: Promise<ContestEntity>;

  @Column() contestId: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" }) @JoinColumn() user: Promise<UserEntity>;

  @Column() userId: number;

  @Column({ type: "mediumtext" }) content: string;

  @Column({ type: "json" }) problems: { contestProblemId: number; content: string; minutes: number }[];

  @Column({ type: "datetime" }) updatedAt: Date;
}
