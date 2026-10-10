import { Column, Entity, Index, JoinColumn, OneToOne, PrimaryGeneratedColumn } from "typeorm";

import { RegistrationReviewStatus } from "./registration-review.entity";

import { UserEntity } from "../user/user.entity";

// This identifier belongs to the private application queue, never to the user table.
@Entity("registration_application")
@Index(["status", "createdAt"])
export class RegistrationApplicationEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar", length: 24 })
  username: string;

  @Column({ type: "varchar", length: 255 })
  email: string;

  // Preserve review history without permanently reserving approved users' old names.
  @Column({ type: "varchar", length: 24, nullable: true })
  @Index({ unique: true })
  reservedUsername: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  @Index({ unique: true })
  reservedEmail: string;

  @Column({ type: "varchar", length: 60, nullable: true, select: false })
  passwordHash: string;

  // Verified legacy authentication audit rows are archived by the upgrader only.
  @Column({ type: "json", nullable: true, select: false })
  legacyAccountAudit: unknown;

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

  @Column({ type: "integer", nullable: true })
  userId: number;

  @OneToOne(() => UserEntity, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "userId" })
  user: UserEntity;
}
