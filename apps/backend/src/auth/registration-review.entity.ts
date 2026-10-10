import { Column, Entity, Index, JoinColumn, OneToOne, PrimaryColumn } from "typeorm";

import { UserEntity } from "../user/user.entity";

export enum RegistrationReviewStatus {
  Pending = "pending",
  Approved = "approved",
  Rejected = "rejected"
}

// Absence of a row means an existing/open-registration account is already active.
@Entity("registration_review")
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
