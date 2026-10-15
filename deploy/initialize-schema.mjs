#!/usr/bin/env node
// Creates the database schema of a new installation from the built backend's entities.
// The production backend never changes the schema at startup; installed instances use the upgrader.
// No Nest startup, HTTP listeners, workers or service changes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

class SchemaInitializationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function argumentsFor(values) {
  const result = {};
  for (let index = 0; index < values.length; index++) {
    const option = values[index];
    if (option !== '--root' && option !== '--config') throw new SchemaInitializationError('INVALID_ARGUMENTS');
    const key = option.slice(2);
    if (result[key] || !values[index + 1] || values[index + 1].startsWith('--'))
      throw new SchemaInitializationError('INVALID_ARGUMENTS');
    result[key] = values[++index];
  }
  if (!result.root || !result.config) throw new SchemaInitializationError('INVALID_ARGUMENTS');
  return result;
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const root = fs.realpathSync(path.resolve(args.root));
  if (fs.existsSync(path.join(root, 'config/install-complete.json')))
    throw new SchemaInitializationError('INSTALLATION_ALREADY_COMPLETE');
  const require = createRequire(path.join(root, 'apps/backend/package.json'));
  require('reflect-metadata');
  const config = require('js-yaml').load(fs.readFileSync(path.resolve(args.config), 'utf8'));
  const database = config?.services?.database;
  if (!database || !['mariadb', 'mysql'].includes(database.type) || !database.database ||
      !fs.existsSync(path.join(root, 'apps/backend/dist')))
    throw new SchemaInitializationError('BUILT_BACKEND_AND_DATABASE_REQUIRED');
  const { DataSource } = require('typeorm');
  const ds = new DataSource({ ...database,
    entities: [path.join(root, 'apps/backend/dist/**/*.entity.js')],
    synchronize: false, migrationsRun: false, logging: false
  });
  try {
    await ds.initialize();
    // Same entity definitions the backend used to synchronize at startup. Re-running it after an
    // interrupted installation completes the schema without touching existing rows.
    await ds.synchronize();
    const tables = await ds.query('SHOW TABLES');
    process.stdout.write(JSON.stringify({ initialized: true, tables: tables.length }) + '\n');
  } finally { if (ds.isInitialized) await ds.destroy(); }
}

main().catch(error => {
  // Connection details and SQL-driver exceptions may contain secrets; never print them.
  const code = error instanceof SchemaInitializationError ? error.code : 'DATABASE_OPERATION_FAILED';
  process.stderr.write('SCHEMA_INITIALIZATION: ' + code + '\n');
  process.exitCode = 1;
});
