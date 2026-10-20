import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  VersionColumn,
  UpdateDateColumn
} from "typeorm";

import { UserEntity } from "../user/user.entity";
import { JsonColumn } from "../database/json-column";

export interface StudyListItem {
  problemId: number;
  section: string;
  note: string;
}
@Entity("study_list")
export class StudyListEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column() ownerId: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" }) @JoinColumn() owner: Promise<UserEntity>;

  @Column({ length: 160 }) title: string;

  @Column({ type: "mediumtext" }) description: string;

  @JsonColumn() items: StudyListItem[];

  @Column({ default: false }) starred: boolean;

  @Column({ default: false }) archived: boolean;

  @VersionColumn() version: number;

  @UpdateDateColumn() updatedAt: Date;
}
