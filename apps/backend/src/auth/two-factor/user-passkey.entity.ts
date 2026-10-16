import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { UserEntity } from "../../user/user.entity";

// A WebAuthn credential registered as a second sign-in factor.
@Entity("user_passkey")
export class UserPasskeyEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  userId: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: UserEntity;

  // SHA-256 of the credential ID: credential IDs can be up to 1023 bytes, too long for a unique index.
  @Index({ unique: true })
  @Column({ type: "char", length: 64 })
  credentialIdHash: string;

  // base64url
  @Column({ type: "varchar", length: 1400 })
  credentialId: string;

  // base64url of the COSE public key
  @Column({ type: "text" })
  publicKey: string;

  // COSE algorithm identifier
  @Column({ type: "integer" })
  algorithm: number;

  @Column({ type: "integer", unsigned: true })
  signCount: number;

  // The relying party (site domain) the credential is bound to.
  @Column({ type: "varchar", length: 253 })
  rpId: string;

  @Column({ type: "varchar", length: 120 })
  transports: string;

  @Column({ type: "varchar", length: 80 })
  name: string;

  @Column({ type: "datetime" })
  createdAt: Date;

  @Column({ type: "datetime", nullable: true })
  lastUsedAt: Date;
}
