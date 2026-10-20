import { Column, ColumnOptions, ValueTransformer } from "typeorm";

// What TypeORM's `json` type does to values: JSON text in the database, the parsed value in entities.
const json: ValueTransformer = {
  to: (value: unknown) => (value === null || value === undefined ? value : JSON.stringify(value)),
  from: (value: unknown) => (typeof value === "string" ? JSON.parse(value) : value)
};

/**
 * A column of JSON values. TypeORM's `json` type has always been a plain `longtext` on MariaDB here, but TypeORM after
 * 0.3.7 creates MariaDB's JSON type instead (`utf8mb4_bin`, with a `json_valid` check) when it makes a table. Declared
 * as `longtext`, every installation, old or new, keeps the same schema, which the upgrader's contracts expect.
 */
export function JsonColumn(options: Pick<ColumnOptions, "nullable" | "select"> = {}): PropertyDecorator {
  return Column({ ...options, type: "longtext", transformer: json });
}
