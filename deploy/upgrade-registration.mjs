// Explicit data migration from the first approval implementation. Never imported
// by the backend: only the offline, stopped-application upgrader may run it.
import { createHash } from 'node:crypto';

export class RegistrationMigrationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const CLEANUP = new Set(['registration_review.userId', 'user_auth.userId', 'user_information.userId', 'user_preference.userId']);
const USER_COLUMNS = new Set(['userId', 'ownerId', 'publisherId', 'submitterId', 'reviewedBy']);
const INFORMATION = ['organization', 'location', 'url', 'telegram', 'qq', 'github'];
const quote = name => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new RegistrationMigrationError('UNEXPECTED_IDENTIFIER');
  return '`'+name+'`';
};
const object = value => typeof value === 'string' ? JSON.parse(value) : value;
const sameTime = (a, b) => a != null && b != null && new Date(a).getTime() === new Date(b).getTime();

export function validateEmptyAccount(row) {
  if (!['pending', 'rejected'].includes(row.status) || !row.id || row.id !== row.userId ||
      row.authId !== row.userId || row.informationId !== row.userId || row.preferenceId !== row.userId ||
      row.isAdmin !== 0 || row.publicEmail !== 0 || row.acceptedProblemCount !== 0 || row.submissionCount !== 0 || row.rating !== 0 ||
      row.nickname !== '' || row.bio !== '' || row.avatarInfo !== 'gravatar:' ||
      INFORMATION.some(key => row[key] !== '') || !sameTime(row.createdAt, row.registrationTime)) {
    throw new RegistrationMigrationError('LEGACY_NONDEFAULT_PROFILE');
  }
  const preference = object(row.preference);
  if (!preference || Array.isArray(preference) || typeof preference !== 'object' || Object.keys(preference).length ||
      !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(row.passwordHash || '') ||
      typeof row.username !== 'string' || !row.username || typeof row.email !== 'string' || !row.email) {
    throw new RegistrationMigrationError('LEGACY_CREDENTIALS_OR_PREFERENCES');
  }
  if (row.status === 'pending' && (row.reviewedAt != null || row.reviewedBy != null || row.reason != null)) {
    throw new RegistrationMigrationError('LEGACY_REVIEW_METADATA');
  }
  if (row.status === 'rejected' && (!row.reviewedAt || !Number.isInteger(row.reviewedBy) || row.reviewedBy < 1)) {
    throw new RegistrationMigrationError('LEGACY_REVIEW_METADATA');
  }
}

export function isRoutineRejectionAudit(audit, row) {
  let detail;
  try { detail = object(audit.details); } catch { return false; }
  return row.status === 'rejected' && audit.action === 'auth.registration_rejected' &&
    audit.firstObjectType === 'User' && audit.firstObjectId === row.userId &&
    audit.secondObjectType == null && audit.secondObjectId == null && audit.userId === row.reviewedBy &&
    sameTime(audit.time, row.reviewedAt) && detail && !Array.isArray(detail) &&
    Object.keys(detail).sort().join(',') === 'from,reason,to' && detail.from === 'pending' && detail.to === 'rejected' &&
    detail.reason === row.reason;
}

export function isRoutineAccountAudit(audit, row) {
  if (audit.userId !== row.userId || audit.firstObjectType != null || audit.firstObjectId != null ||
      audit.secondObjectType != null || audit.secondObjectId != null) return false;
  let details;
  try { details = object(audit.details); } catch { return false; }
  if (audit.action === 'auth.login_failed.wrong_password') return details == null;
  return audit.action === 'auth.register' && details && !Array.isArray(details) &&
    Object.keys(details).sort().join(',') === 'email,username' && details.username === row.username && details.email === row.email;
}

async function hasTable(connection, name) {
  const rows = await connection.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name]);
  return Number(rows[0].n) === 1;
}

async function inspect(connection, dataSource, lock = false) {
  if (!await hasTable(connection, 'registration_review')) return { rows: [], audits: [], actorAudits: [] };
  const rows = await connection.query(`SELECT r.userId, r.status, r.createdAt, r.reviewedAt, r.reviewedBy, r.reason,
    u.id, u.username, u.email, u.nickname, u.bio, u.avatarInfo, u.isAdmin, u.publicEmail,
    u.acceptedProblemCount, u.submissionCount, u.rating, u.registrationTime,
    a.userId AS authId, a.password AS passwordHash, i.userId AS informationId,
    i.organization, i.location, i.url, i.telegram, i.qq, i.github,
    p.userId AS preferenceId, p.preference
    FROM registration_review r LEFT JOIN user u ON u.id=r.userId
    LEFT JOIN user_auth a ON a.userId=r.userId
    LEFT JOIN user_information i ON i.userId=r.userId
    LEFT JOIN user_preference p ON p.userId=r.userId
    ORDER BY r.userId${lock ? ' FOR UPDATE' : ''}`);
  const applicationExists = await hasTable(connection, 'registration_application');
  const pending = [];
  const actionable = [];
  for (const row of rows) {
    if (!row.id || !['pending', 'approved', 'rejected'].includes(row.status)) throw new RegistrationMigrationError('LEGACY_INVALID_ACCOUNT');
    if (applicationExists) {
      const existing = await connection.query('SELECT id,status FROM registration_application WHERE userId=?', [row.userId]);
      if (existing.length) {
        if (row.status !== 'approved' || existing.length !== 1 || existing[0].status !== 'approved') throw new RegistrationMigrationError('APPLICATION_CONFLICT');
        continue; // Approved users may have renamed since their history was copied.
      }
    }
    if (row.status !== 'approved') {
      validateEmptyAccount(row);
      pending.push(row);
      if (applicationExists) {
        const collision = await connection.query('SELECT id FROM registration_application WHERE reservedUsername=? OR reservedEmail=? LIMIT 1', [row.username, row.email]);
        if (collision.length) throw new RegistrationMigrationError('APPLICATION_CONFLICT');
      }
    }
    actionable.push(row);
  }
  const audits = [];
  const actorAudits = [];
  if (pending.length) {
    const knownTables = new Set(dataSource.entityMetadatas.map(meta => meta.tableName));
    const actualTables = await connection.query("SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
    if (actualTables.some(table => !knownTables.has(table.tableName))) {
      throw new RegistrationMigrationError('UNKNOWN_TABLE');
    }
    const knownReferences = new Set(dataSource.entityMetadatas.flatMap(meta => meta.foreignKeys
      .flatMap(key => key.columnNames.map((column, index) => `${meta.tableName}.${column}>${key.referencedEntityMetadata.tableName}.${key.referencedColumnNames[index]}`))));
    const allReferences = await connection.query(`SELECT TABLE_SCHEMA AS tableSchema, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
      REFERENCED_TABLE_SCHEMA AS parentSchema, REFERENCED_TABLE_NAME AS parentTable, REFERENCED_COLUMN_NAME AS parentColumn
      FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE()
      AND REFERENCED_TABLE_NAME IN ('user','user_auth','user_information','user_preference','registration_review','audit_log')`);
    for (const reference of allReferences) {
      if (reference.tableSchema !== reference.parentSchema || !knownReferences.has(`${reference.tableName}.${reference.columnName}>${reference.parentTable}.${reference.parentColumn}`)) {
        throw new RegistrationMigrationError('UNKNOWN_FOREIGN_KEY');
      }
    }
    const references = allReferences.filter(reference => reference.parentTable === 'user');
    // Include source-defined references without SQL foreign keys (AI/contest etc).
    const checks = new Set(references.map(ref => ref.tableName+'.'+ref.columnName));
    for (const meta of dataSource.entityMetadatas) {
      if (!await hasTable(connection, meta.tableName)) continue;
      for (const column of meta.columns) if (USER_COLUMNS.has(column.databaseName)) checks.add(meta.tableName+'.'+column.databaseName);
    }
    for (const row of pending) {
      for (const reference of checks) {
        if (CLEANUP.has(reference) || reference === 'audit_log.userId') continue;
        const [table, column] = reference.split('.');
        const related = await connection.query(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${quote(column)}=?`, [row.userId]);
        if (Number(related[0].n)) throw new RegistrationMigrationError('LEGACY_BUSINESS_REFERENCES');
      }
      if (await hasTable(connection, 'contest')) {
        const related = await connection.query('SELECT COUNT(*) AS n FROM contest WHERE JSON_CONTAINS(adminIds, ?) OR JSON_CONTAINS(adminIds, ?)', [JSON.stringify(row.userId), JSON.stringify(String(row.userId))]);
        if (Number(related[0].n)) throw new RegistrationMigrationError('LEGACY_BUSINESS_REFERENCES');
      }
      const ownHistory = await connection.query('SELECT * FROM audit_log WHERE userId=? ORDER BY id', [row.userId]);
      for (const audit of ownHistory) {
        if (!isRoutineAccountAudit(audit, row)) throw new RegistrationMigrationError('LEGACY_UNSUPPORTED_AUDIT');
        actorAudits.push({ ...audit, details: object(audit.details) });
      }
      const history = await connection.query("SELECT * FROM audit_log WHERE (firstObjectType='User' AND firstObjectId=?) OR (secondObjectType='User' AND secondObjectId=?)", [row.userId, row.userId]);
      for (const audit of history) {
        if (!isRoutineRejectionAudit(audit, row)) throw new RegistrationMigrationError('LEGACY_UNSUPPORTED_AUDIT');
        audits.push({ ...audit, legacyUserId: row.userId });
      }
    }
  }
  return { rows: actionable, audits, actorAudits };
}

function summary(plan) {
  const clean = plan.rows.map(row => ({ ...row, passwordHash: row.status === 'approved' ? null : row.passwordHash }));
  return {
    pending: clean.filter(row => row.status === 'pending').length,
    rejected: clean.filter(row => row.status === 'rejected').length,
    approvedHistory: clean.filter(row => row.status === 'approved').length,
    reassignedAuditRecords: plan.audits.length,
    archivedAccountAuditRecords: plan.actorAudits.length,
    fingerprint: createHash('sha256').update(JSON.stringify({ rows: clean, audits: plan.audits, actorAudits: plan.actorAudits })).digest('hex')
  };
}

export async function inspectLegacyRegistration(dataSource) {
  return summary(await inspect(dataSource, dataSource));
}

export async function migrateLegacyRegistration(dataSource) {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction('SERIALIZABLE');
  try {
    const plan = await inspect(runner, dataSource, true);
    const result = summary(plan);
    for (const row of plan.rows) {
      const approved = row.status === 'approved';
      const archive = plan.actorAudits.filter(audit => audit.userId === row.userId);
      const archiveJson = archive.length ? JSON.stringify(archive) : null;
      const inserted = await runner.query(`INSERT INTO registration_application
        (username,email,reservedUsername,reservedEmail,passwordHash,legacyAccountAudit,status,createdAt,reviewedAt,reviewedBy,reason,userId)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [row.username, row.email, approved ? null : row.username, approved ? null : row.email,
        approved ? null : row.passwordHash, archiveJson, row.status, row.createdAt, row.reviewedAt, row.reviewedBy, row.reason, approved ? row.userId : null]);
      const applicationId = Number(inserted.insertId);
      if (!Number.isSafeInteger(applicationId) || applicationId < 1) throw new RegistrationMigrationError('MIGRATION_WRITE_VERIFICATION');
      if (approved) continue;
      if (archive.length) {
        const stored = await runner.query('SELECT legacyAccountAudit FROM registration_application WHERE id=?', [applicationId]);
        if (stored.length !== 1 || JSON.stringify(object(stored[0].legacyAccountAudit)) !== archiveJson) throw new RegistrationMigrationError('AUDIT_COPY_VERIFICATION');
        for (const audit of archive) {
          const removed = await runner.query('DELETE FROM audit_log WHERE id=? AND userId=?', [audit.id, row.userId]);
          if (Number(removed.affectedRows) !== 1) throw new RegistrationMigrationError('MIGRATION_CONCURRENT_CHANGE');
        }
      }
      for (const audit of plan.audits.filter(item => item.legacyUserId === row.userId)) {
        const details = { ...object(audit.details), applicationId, legacyUserId: row.userId };
        const update = await runner.query('UPDATE audit_log SET firstObjectType=NULL,firstObjectId=NULL,details=? WHERE id=? AND firstObjectType=\'User\' AND firstObjectId=?', [JSON.stringify(details), audit.id, row.userId]);
        if (Number(update.affectedRows) !== 1) throw new RegistrationMigrationError('MIGRATION_CONCURRENT_CHANGE');
      }
      // No CASCADE is relied upon. Every allowed row must be present exactly once;
      // all other SQL/non-SQL references were proven absent inside this transaction.
      for (const table of ['user_auth', 'user_information', 'user_preference', 'registration_review']) {
        const deleted = await runner.query(`DELETE FROM ${quote(table)} WHERE userId=?`, [row.userId]);
        if (Number(deleted.affectedRows) !== 1) throw new RegistrationMigrationError('MIGRATION_CONCURRENT_CHANGE');
      }
      const deleted = await runner.query('DELETE FROM user WHERE id=?', [row.userId]);
      if (Number(deleted.affectedRows) !== 1) throw new RegistrationMigrationError('MIGRATION_CONCURRENT_CHANGE');
    }
    await runner.commitTransaction();
    return result;
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally { await runner.release(); }
}
