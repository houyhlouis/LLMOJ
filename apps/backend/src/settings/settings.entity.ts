import { Entity, PrimaryColumn } from "typeorm";

import { JsonColumn } from "../database/json-column";

@Entity("settings")
export class SettingsEntity {
  @PrimaryColumn({ type: "varchar", length: 30 })
  key: string;

  @JsonColumn()
  value: unknown;
}
