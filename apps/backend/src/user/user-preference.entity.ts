import { Entity, PrimaryColumn, OneToOne, JoinColumn, Unique } from "typeorm";

import { UserEntity } from "./user.entity";
import { UserPreference } from "./user-preference.interface";

import { JsonColumn } from "../database/json-column";

@Entity("user_preference")
// The unique index TypeORM 0.3.7 also made for this one-to-one primary key; newer TypeORM leaves it out, so it
// is declared to keep the schema of existing and new installations the same
@Unique("REL_5b141fbd1fef95a0540f7e7d1e", ["userId"])
export class UserPreferenceEntity {
  @OneToOne(() => UserEntity)
  @JoinColumn()
  user: Promise<UserEntity>;

  @PrimaryColumn()
  userId: number;

  @JsonColumn()
  preference: UserPreference;
}
