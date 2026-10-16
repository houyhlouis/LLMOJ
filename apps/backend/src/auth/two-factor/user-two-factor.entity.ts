import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from "typeorm";

import { UserEntity } from "../../user/user.entity";

// Absence of a row, or a row without an authenticator secret or passkeys, means two-factor sign-in is off.
@Entity("user_two_factor")
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
  @Column({ type: "json", nullable: true })
  recoveryCodes: string[];

  @Column({ type: "datetime" })
  updatedAt: Date;
}
