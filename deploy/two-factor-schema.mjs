// Exact, additive tables for two-factor sign-in (authenticator apps, passkeys
// and recovery codes). Imported only by the offline upgrader.
export const USER_TWO_FACTOR_CREATE_SQL = "CREATE TABLE `user_two_factor` (`userId` int NOT NULL, " +
  "`totpSecret` varchar(255) NULL, `totpEnabledAt` datetime NULL, `recoveryCodes` longtext NULL, " +
  "`updatedAt` datetime NOT NULL, UNIQUE INDEX `REL_2cbb5b2d99e69fabcd8a5a0fdb` (`userId`), " +
  "PRIMARY KEY (`userId`)) ENGINE=InnoDB";
export const USER_PASSKEY_CREATE_SQL = "CREATE TABLE `user_passkey` (`id` int NOT NULL AUTO_INCREMENT, " +
  "`userId` int NOT NULL, `credentialIdHash` char(64) NOT NULL, `credentialId` varchar(1400) NOT NULL, " +
  "`publicKey` text NOT NULL, `algorithm` int NOT NULL, `signCount` int UNSIGNED NOT NULL, " +
  "`rpId` varchar(253) NOT NULL, `transports` varchar(120) NOT NULL, `name` varchar(80) NOT NULL, " +
  "`createdAt` datetime NOT NULL, `lastUsedAt` datetime NULL, INDEX `IDX_e34332f6df76720f7208cd5c04` (`userId`), " +
  "UNIQUE INDEX `IDX_abafa7c255ab9f20d3398fbe5b` (`credentialIdHash`), PRIMARY KEY (`id`)) ENGINE=InnoDB";
export const USER_TWO_FACTOR_FOREIGN_KEY_SQL = "ALTER TABLE `user_two_factor` ADD CONSTRAINT " +
  "`FK_2cbb5b2d99e69fabcd8a5a0fdb0` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION";
export const USER_PASSKEY_FOREIGN_KEY_SQL = "ALTER TABLE `user_passkey` ADD CONSTRAINT " +
  "`FK_e34332f6df76720f7208cd5c049` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION";
const TABLES = Object.freeze([
  ["user_two_factor", USER_TWO_FACTOR_CREATE_SQL, USER_TWO_FACTOR_FOREIGN_KEY_SQL],
  ["user_passkey", USER_PASSKEY_CREATE_SQL, USER_PASSKEY_FOREIGN_KEY_SQL]
]);
export const TWO_FACTOR_TABLES = Object.freeze(TABLES.map(([name]) => name));
export const TWO_FACTOR_SQL = Object.freeze(TABLES.flatMap(([, create, foreignKey]) => [create, foreignKey]));
const sqlOf = value => (typeof value === "string" ? value : value.query);
const count = (queries, sql) => queries.filter(query => sqlOf(query) === sql).length;

// Each table is created together with its foreign key, exactly once, and only when it is absent.
// TypeORM proposes any other change to an existing table, which the general contract refuses.
export async function validateTwoFactorSchema(ds, queries, ErrorType = Error) {
  const rows = await ds.query(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('user_two_factor','user_passkey')`);
  for (const [table, create, foreignKey] of TABLES) {
    const pending = Number(!rows.some(row => row.name === table));
    if (count(queries, create) !== pending || count(queries, foreignKey) !== pending)
      throw new ErrorType("Two-factor table addition does not match the existing schema");
  }
}
