import { Entity, PrimaryColumn, OneToOne, Column, JoinColumn, Unique } from "typeorm";

import { UserEntity } from "../user/user.entity";

@Entity("user_migration_info")
// The unique index TypeORM 0.3.7 also made for this one-to-one primary key; newer TypeORM leaves it out, so it
// is declared to keep the schema of existing and new installations the same
@Unique("REL_ec55c7dc1c79cfbd36caed67d7", ["userId"])
export class UserMigrationInfoEntity {
  @OneToOne(() => UserEntity, {
    onDelete: "CASCADE"
  })
  @JoinColumn()
  user: Promise<UserEntity>;

  @PrimaryColumn()
  userId: number;

  @Column({ type: "varchar", length: 80 })
  oldUsername: string;

  @Column({ type: "varchar", length: 120 })
  oldEmail: string;

  /**
   * `bcrypt(md5(password + "syzoj2_xxx"))`
   */
  @Column({ type: "char", length: 60 })
  oldPasswordHashBcrypt: string;

  @Column({ type: "boolean" })
  usernameMustChange: boolean;

  @Column({ type: "boolean" })
  migrated: boolean;
}
