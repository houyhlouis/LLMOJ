import { Entity, PrimaryColumn, OneToOne, Column, JoinColumn, Unique } from "typeorm";

import { UserEntity } from "./user.entity";

@Entity("user_information")
// The unique index TypeORM 0.3.7 also made for this one-to-one primary key; newer TypeORM leaves it out, so it
// is declared to keep the schema of existing and new installations the same
@Unique("REL_9505f52b69dcdd979173b620ca", ["userId"])
export class UserInformationEntity {
  @OneToOne(() => UserEntity)
  @JoinColumn()
  user: Promise<UserEntity>;

  @PrimaryColumn()
  userId: number;

  @Column({ type: "varchar", length: 80 })
  organization: string;

  @Column({ type: "varchar", length: 80 })
  location: string;

  @Column({ type: "varchar", length: 80 })
  url: string;

  @Column({ type: "varchar", length: 30 })
  telegram: string;

  @Column({ type: "varchar", length: 30 })
  qq: string;

  @Column({ type: "varchar", length: 30 })
  github: string;
}
