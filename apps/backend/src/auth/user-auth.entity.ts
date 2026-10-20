import { Entity, PrimaryColumn, OneToOne, Column, JoinColumn, Unique } from "typeorm";

import { UserEntity } from "../user/user.entity";

@Entity("user_auth")
// The unique index TypeORM 0.3.7 also made for this one-to-one primary key; newer TypeORM leaves it out, so it
// is declared to keep the schema of existing and new installations the same
@Unique("REL_52403f2133a7b1851d8ab4dc9d", ["userId"])
export class UserAuthEntity {
  @OneToOne(() => UserEntity)
  @JoinColumn()
  user: Promise<UserEntity>;

  @PrimaryColumn()
  userId: number;

  @Column({ type: "char", length: 60, nullable: true })
  password: string;
}
