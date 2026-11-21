import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { ContestEntity } from "./contest.entity";

import { UserEntity } from "../user/user.entity";

@Entity("contest_virtual_participation")
@Index(["contestId", "userId"], { unique: true })
export class ContestVirtualParticipationEntity {
  @PrimaryGeneratedColumn() id: number;

  @ManyToOne(() => ContestEntity, { onDelete: "CASCADE" }) @JoinColumn() contest: Promise<ContestEntity>;

  @Column() contestId: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" }) @JoinColumn() user: Promise<UserEntity>;

  @Column() userId: number;

  @Column({ type: "datetime" }) startTime: Date;

  @Column({ type: "datetime" }) endTime: Date;

  @Column({ type: "datetime" }) createdAt: Date;
}
