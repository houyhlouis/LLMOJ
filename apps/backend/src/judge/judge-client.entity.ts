import { Entity, PrimaryGeneratedColumn, Column, Index } from "typeorm";

@Entity("judge_client")
export class JudgeClientEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar", length: 80 })
  name: string;

  @Column({ type: "char", length: 40 })
  @Index({ unique: true })
  key: string;

  @Column({ type: "json" })
  allowedHosts: string[];

  // A draining judge client is sent no new tasks; it finishes the ones it has.
  @Column({ type: "boolean", default: false })
  draining: boolean;
}
