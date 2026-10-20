import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, Unique } from "typeorm";

import { UserEntity } from "../../user/user.entity";
import { JsonColumn } from "../../database/json-column";

// Absence of a row, or a row without an authenticator secret or passkeys, means two-factor sign-in is off.
@Entity("user_two_factor")
// The unique index TypeORM 0.3.7 also made for this one-to-one primary key; newer TypeORM leaves it out, so it
// is declared to keep the schema of existing and new installations the same
@Unique("REL_2cbb5b2d99e69fabcd8a5a0fdb", ["userId"])
export class UserTwoFactorEntity {
  @PrimaryColumn()
  userId: number;

  @OneToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: UserEntity;

  // AES-256-GCM encrypted authenticator (TOTP) secret, bound to the user ID; null when not enrolled.
  @Column({ type: "varchar", length: 255, nullable: true })
  totpSecret: string;

  @Column({ type: "datetime", nullable: true })
  totpEnabledAt: Date;

  // SHA-256 hashes of the unused one-time recovery codes.
  @JsonColumn({ nullable: true })
  recoveryCodes: string[];

  @Column({ type: "datetime" })
  updatedAt: Date;
}
