#!/usr/bin/env node
// No Nest startup, HTTP listeners, workers or automatic service changes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditSchema, applySchema, SchemaCompatibilityError } from './upgrade-schema.mjs';
import { RegistrationMigrationError } from './upgrade-registration.mjs';

function argumentsFor(values) {
  const result = { apply: false, drained: false };
  for (let index = 0; index < values.length; index++) {
    const option = values[index];
    if (option === '--apply' || option === '--drained') {
      const key = option.slice(2);
      if (result[key]) throw new SchemaCompatibilityError('Duplicate option');
      result[key] = true;
    } else if (option === '--root' || option === '--config') {
      const key = option.slice(2);
      if (result[key] || !values[index + 1] || values[index + 1].startsWith('--'))
        throw new SchemaCompatibilityError('Invalid path option');
      result[key] = values[++index];
    } else throw new SchemaCompatibilityError('Unknown option');
  }
  if (!result.root || !result.config || (result.apply && !result.drained))
    throw new SchemaCompatibilityError('Specify --root and --config; --apply also requires --drained');
  return result;
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const root = fs.realpathSync(path.resolve(args.root));
  const require = createRequire(path.join(root, 'apps/backend/package.json'));
  require('reflect-metadata');
  const config = require('js-yaml').load(fs.readFileSync(path.resolve(args.config), 'utf8'));
  const database = config?.services?.database;
  if (!database || !['mariadb', 'mysql'].includes(database.type) || !database.database ||
      !fs.existsSync(path.join(root, 'apps/backend/dist')))
    throw new SchemaCompatibilityError('A built source tree and existing MariaDB/MySQL instance are required');
  const { DataSource } = require('typeorm');
  const ds = new DataSource({ ...database,
    entities: [path.join(root, 'apps/backend/dist/**/*.entity.js')],
    synchronize: false, migrationsRun: false, logging: false
  });
  try {
    await ds.initialize();
    const result = args.apply ? await applySchema(ds) : await auditSchema(ds);
    process.stdout.write(JSON.stringify({
      mode: args.apply ? 'apply' : 'audit',
      compatible: result.compatible,
      schemaChanges: result.queries.length,
      queries: result.queries,
      registration: result.migration,
      solutions: result.solutions
    }) + '\n');
  } finally { if (ds.isInitialized) await ds.destroy(); }
}

main().catch(error => {
  const code = error instanceof RegistrationMigrationError ? error.code :
    error instanceof SchemaCompatibilityError ? 'SCHEMA_CHANGE_UNSUPPORTED' : 'DATABASE_OPERATION_FAILED';
  // Connection details and SQL-driver exceptions may contain secrets; never print them.
  process.stderr.write('COMMUNITY_MIGRATION: ' + code + '\n');
  process.exitCode = 1;
});
