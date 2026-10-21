import type { DataSource } from "typeorm";

/**
 * How the database differs from what this release's entities describe, from the statements TypeORM's schema builder
 * would run to make them equal (the same comparison as the upgrader's schema audit):
 * - missing: tables and columns this release reads and writes. It can't work without them.
 * - changed: columns of another definition, missing indexes or keys. It works, perhaps slower or less strictly.
 * - extra: columns, indexes and keys a newer release added; they don't matter to this one.
 */
export interface SchemaDifferences {
  missing: string[];
  changed: string[];
  extra: string[];
}

const name = "`([^`]+)`";
const CREATE_TABLE = new RegExp(`^CREATE TABLE ${name}`, "i");
const ADD_COLUMN = new RegExp(
  `^ALTER TABLE ${name} ADD (?!CONSTRAINT|UNIQUE|INDEX|PRIMARY|FULLTEXT|SPATIAL)${name}`,
  "i"
);
const DROP_COLUMN = new RegExp(`^ALTER TABLE ${name} DROP COLUMN ${name}`, "i");
const DROP_INDEX = new RegExp(`^DROP INDEX ${name} ON ${name}`, "i");
const DROP_FOREIGN_KEY = new RegExp(`^ALTER TABLE ${name} DROP FOREIGN KEY ${name}`, "i");
const CHANGE_COLUMN = new RegExp(`^ALTER TABLE ${name} CHANGE ${name} ${name}`, "i");

/** Classifies the schema builder's statements (MySQL and MariaDB syntax). */
export function classifySchemaQueries(queries: string[]): SchemaDifferences {
  const result: SchemaDifferences = { missing: [], changed: [], extra: [] };
  const statements = queries.map(query => query.trim());
  // A column the builder drops and adds again changed its definition
  const dropped = new Set(
    statements
      .map(query => DROP_COLUMN.exec(query))
      .filter(Boolean)
      .map(m => `${m[1]}.${m[2]}`)
  );
  const added = new Set(
    statements
      .map(query => ADD_COLUMN.exec(query))
      .filter(Boolean)
      .map(m => `${m[1]}.${m[2]}`)
  );
  // Where a table lacks a column and has another, the builder renames one to the other: the new name is missing
  const renamedTo = new Set<string>();
  for (const query of statements) {
    const created = CREATE_TABLE.exec(query);
    const changedName = CHANGE_COLUMN.exec(query);
    const addedColumn = ADD_COLUMN.exec(query);
    const droppedColumn = DROP_COLUMN.exec(query);
    const droppedIndex = DROP_INDEX.exec(query);
    const droppedKey = DROP_FOREIGN_KEY.exec(query);
    if (created) result.missing.push(`table ${created[1]}`);
    else if (changedName && changedName[2] !== changedName[3]) {
      renamedTo.add(`${changedName[1]}.${changedName[3]}`);
      result.missing.push(`column ${changedName[1]}.${changedName[3]}`);
      result.extra.push(`column ${changedName[1]}.${changedName[2]}`);
    } else if (addedColumn) {
      const column = `${addedColumn[1]}.${addedColumn[2]}`;
      if (!renamedTo.has(column)) (dropped.has(column) ? result.changed : result.missing).push(`column ${column}`);
    } else if (droppedColumn) {
      const column = `${droppedColumn[1]}.${droppedColumn[2]}`;
      if (!added.has(column)) result.extra.push(`column ${column}`);
    } else if (droppedIndex) result.extra.push(`index ${droppedIndex[2]}.${droppedIndex[1]}`);
    else if (droppedKey) result.extra.push(`foreign key ${droppedKey[1]}.${droppedKey[2]}`);
    else result.changed.push(query.length > 160 ? `${query.slice(0, 157)}...` : query);
  }
  return result;
}

/** Compares the connected database with the entities; reads only. */
export async function checkSchemaCompatibility(dataSource: DataSource): Promise<SchemaDifferences> {
  const { upQueries } = await dataSource.driver.createSchemaBuilder().log();
  return classifySchemaQueries(upQueries.map(query => query.query));
}

/** Whether the backend checks the schema when it starts (see main.ts). */
export function isSchemaCheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LIBREOJ_SCHEMA_CHECK !== "0";
}

export function describeMissing(differences: SchemaDifferences): string {
  const shown = differences.missing.slice(0, 5).join(", ");
  const more = differences.missing.length > 5 ? ` and ${differences.missing.length - 5} more` : "";
  return (
    `The database lacks what this release needs: ${shown}${more}. It was probably restored from an older release or ` +
    "not upgraded. Upgrade it with deploy/upgrade.sh (or restore a matching backup); LIBREOJ_SCHEMA_CHECK=0 starts " +
    "the backend anyway."
  );
}
