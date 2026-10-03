import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from "typeorm";

import { UserEntity } from "../user/user.entity";

@Entity("user_permission_rule")
export class UserPermissionRuleEntity {
  @PrimaryColumn() userId: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" }) @JoinColumn() user: Promise<UserEntity>;

  @PrimaryColumn({ type: "varchar", length: 64 }) permission: string;

  @Column({ type: "boolean" }) allowed: boolean;
}
