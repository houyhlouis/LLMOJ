import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type ContestRule = "noi" | "ioi" | "acm";

@Entity("contest")
export class ContestEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column({ length: 160 }) title: string;

  @Column({ type: "text" }) subtitle: string;

  @Column({ type: "mediumtext" }) description: string;

  @Column({ type: "varchar", length: 8 }) rule: ContestRule;

  @Column({ type: "datetime" }) @Index() startTime: Date;

  @Column({ type: "datetime" }) endTime: Date;

  @Column() ownerId: number;

  @Column({ type: "json" }) adminIds: number[];

  @Column({ default: false }) @Index() isPublic: boolean;

  @Column({ default: false }) hideStatistics: boolean;

  @Column({ type: "json" }) languages: string[];

  @Column({ type: "datetime" }) createdAt: Date;
}
