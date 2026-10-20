import { Entity, PrimaryColumn, OneToOne, Column, JoinColumn, Unique } from "typeorm";

import { DiscussionEntity } from "./discussion.entity";

@Entity("discussion_content")
// The unique index TypeORM 0.3.7 also made for this one-to-one primary key; newer TypeORM leaves it out, so it
// is declared to keep the schema of existing and new installations the same
@Unique("REL_ead0dc8aaf683b5f0d8ed214f6", ["discussionId"])
export class DiscussionContentEntity {
  @OneToOne(() => DiscussionEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  discussion: Promise<DiscussionEntity>;

  @PrimaryColumn()
  discussionId: number;

  @Column({ type: "mediumtext" })
  content: string;
}
