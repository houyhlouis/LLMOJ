import { Column, Entity, Index, JoinColumn, OneToOne, PrimaryColumn, Unique } from "typeorm";

import { UserEntity } from "../user/user.entity";

export enum RegistrationReviewStatus {
  Pending = "pending",
  Approved = "approved",
  Rejected = "rejected"
}

// Absence of a row means an existing/open-registration account is already active.
@Entity("registration_review")
// The unique index TypeORM 0.3.7 also made for this one-to-one primary key; newer TypeORM leaves it out, so it
// is declared to keep the schema of existing and new installations the same
@Unique("REL_9ae4f649115581773289397754", ["userId"])
@Index(["status", "createdAt"])
export class RegistrationReviewEntity {
  @PrimaryColumn()
  userId: number;

  @OneToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: UserEntity;

  @Column({ type: "enum", enum: RegistrationReviewStatus, default: RegistrationReviewStatus.Pending })
  status: RegistrationReviewStatus;

  @Column({ type: "datetime" })
  createdAt: Date;

  @Column({ type: "datetime", nullable: true })
  reviewedAt: Date;

  @Column({ type: "integer", nullable: true })
  reviewedBy: number;

  @Column({ type: "varchar", length: 500, nullable: true })
  reason: string;
}
