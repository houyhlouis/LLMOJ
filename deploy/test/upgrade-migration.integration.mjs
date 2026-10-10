import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {validateQueries,validatePrivilegeSchema,LEGACY_PRIVILEGES,REVIEW_PRIVILEGE,PRIVILEGE_EXPANSION_SQL} from '../upgrade-schema.mjs';
import {inspectLegacyRegistration,migrateLegacyRegistration} from '../upgrade-registration.mjs';
// Opt-in integration test. Only isolated, disposable MariaDB servers are allowed.
// Example (the socket/server and pristine baseline dump must already exist):
// sudo env UPGRADE_TEST_ALLOW_DATABASE_CREATION=1 UPGRADE_TEST_MARIADB_SOCKET=/var/tmp/llmoj-registration-fixture/mariadb/mysql.sock \
//   UPGRADE_TEST_BASELINE_SQL=/var/tmp/llmoj-registration-fixture/baseline.sql node deploy/test/upgrade-migration.integration.mjs
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const SOCKET=process.env.UPGRADE_TEST_MARIADB_SOCKET;
const BASELINE=process.env.UPGRADE_TEST_BASELINE_SQL;
if (!SOCKET && !BASELINE && !process.env.UPGRADE_TEST_ALLOW_DATABASE_CREATION) {
 console.log('SKIP: isolated MariaDB integration fixture is not configured');
 process.exit(0);
}
const socketPath=SOCKET ? fs.realpathSync(SOCKET) : '';
if(process.env.UPGRADE_TEST_ALLOW_DATABASE_CREATION!=='1'||!SOCKET||!BASELINE||
   !/^(?:\/tmp\/llmoj-registration-[^/]+\/data|\/var\/tmp\/llmoj-registration-[^/]+)\/mariadb\/mysql\.sock$/.test(socketPath)||
   !fs.statSync(socketPath).isSocket()) {
 throw new Error('Use the dedicated llmoj-registration-* fixture socket layout, a trusted synthetic single-database baseline dump, and explicit UPGRADE_TEST_ALLOW_DATABASE_CREATION=1');
}
const reportDir=fs.mkdtempSync(path.join(os.tmpdir(),'libreoj-upgrade-integration-'));
const report=path.join(reportDir,'results.json');
const require=createRequire(ROOT+'/apps/backend/package.json');require('reflect-metadata');
const {DataSource}=require('typeorm');const bcrypt=require('bcrypt');
const results=[];const mysql=['--no-defaults','--protocol=socket','--socket='+socketPath,'--user=root'];
// This is an opt-in test with a trusted, synthetic single-database dump, not a
// sandbox for arbitrary SQL. Reject common accidental full-server/client dumps.
const sourceDump=fs.readFileSync(BASELINE);
const sqlText=sourceDump.toString('utf8');
if (/\b(?:CREATE|DROP)\s+(?:DATABASE|SCHEMA)\b|\bUSE\s+[`A-Za-z_]/i.test(sqlText)||
    /^\s*(?:SOURCE|SYSTEM|CONNECT|DELIMITER|\\[.!ruc])(?:\s|$)/im.test(sqlText)||
    /`[A-Za-z_][A-Za-z0-9_]*`\s*\.\s*`[A-Za-z_][A-Za-z0-9_]*`/.test(sqlText)) {
 throw new Error('Baseline must be a trusted synthetic single-database dump without database selection, cross-database qualifiers, or client commands');
}
let ddl;
const hash=bcrypt.hashSync('SyntheticMigrationPass42!',4);
const stamp=new Date('2026-10-10T12:00:00Z'),decision=new Date('2026-10-10T12:00:10Z');
function dsFor(database){return new DataSource({type:'mariadb',username:'root',database,extra:{socketPath:SOCKET},entities:[ROOT+'/apps/backend/dist/**/*.entity.js'],synchronize:false,logging:false});}
async function clone(run,dump=sourceDump){
 const name='libreoj_upgrade_'+crypto.randomBytes(8).toString('hex');
 execFileSync('mariadb',mysql,{input:'CREATE DATABASE `'+name+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;'});
 let ds;
 try{execFileSync('mariadb',[...mysql,name],{input:dump});ds=dsFor(name);await ds.initialize();return await run(ds);}
 finally{if(ds?.isInitialized)await ds.destroy();execFileSync('mariadb',mysql,{input:'DROP DATABASE `'+name+'`;'});}
}
async function tables(ds,application=true){for(const sql of ddl)if(application||!sql.includes('`registration_application`'))await ds.query(sql);}
async function legacy(ds,status,suffix=''){
 const username='legacy_'+status+suffix,email=username+'@example.invalid';
 const created=await ds.query("INSERT INTO user (username,email,nickname,bio,avatarInfo,isAdmin,acceptedProblemCount,submissionCount,rating,publicEmail,registrationTime) VALUES (?,?,'','','gravatar:',0,0,0,0,0,?)",[username,email,stamp]);
 const id=Number(created.insertId);const admin=Number((await ds.query('SELECT id FROM user WHERE isAdmin=1 ORDER BY id LIMIT 1'))[0].id);
 await ds.query('INSERT INTO user_auth (userId,password) VALUES (?,?)',[id,hash]);
 await ds.query("INSERT INTO user_information (userId,organization,location,url,telegram,qq,github) VALUES (?,'','','','','','')",[id]);
 await ds.query("INSERT INTO user_preference (userId,preference) VALUES (?,'{}')",[id]);
 await ds.query('INSERT INTO registration_review (userId,status,createdAt,reviewedAt,reviewedBy,reason) VALUES (?,?,?,?,?,?)',[id,status,stamp,status==='pending'?null:decision,status==='pending'?null:admin,status==='pending'?null:'fixture decision']);
 await ds.query("INSERT INTO audit_log (userId,ip,time,action,details) VALUES (?,'127.0.0.1',?,'auth.register',?)",[id,stamp,JSON.stringify({username,email})]);
 await ds.query("INSERT INTO audit_log (userId,ip,time,action,details) VALUES (?,'127.0.0.1',?,'auth.login_failed.wrong_password',NULL)",[id,stamp]);
 if(status!=='pending')await ds.query("INSERT INTO audit_log (userId,ip,time,action,firstObjectType,firstObjectId,details) VALUES (?,'127.0.0.1',?,?,'User',?,?)",[admin,decision,'auth.registration_'+status,id,JSON.stringify({from:'pending',to:status,reason:'fixture decision'})]);
 return {id,username,email,admin};
}
async function state(ds){
 const answer={};for(const table of ['user','user_auth','user_information','user_preference','registration_review','registration_application','audit_log']){
 const rows=await ds.query('SELECT * FROM `'+table+'` ORDER BY '+(table==='registration_review'||['user_auth','user_information','user_preference'].includes(table)?'userId':'id'));
 answer[table]=crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');}
 return answer;
}
async function caseRun(name,fn){try{const detail=await fn();results.push({case:name,status:'passed',...detail});console.log(name+': passed');}catch(error){results.push({case:name,status:'failed',code:error.code||error.name,message:error.code?undefined:error.message?.slice(0,180)});console.log(name+': FAILED '+(error.code||error.name));throw error;}finally{fs.writeFileSync(report,JSON.stringify({productionModified:false,results},null,2)+'\n');fs.chmodSync(report,0o644);}}
await caseRun('pristine-baseline-schema-and-noop',()=>clone(async ds=>{
 const queries=validateQueries((await ds.driver.createSchemaBuilder().log()).upQueries);assert.equal(queries.length,5);await validatePrivilegeSchema(ds,queries);ddl=queries;
 const before=await inspectLegacyRegistration(ds);assert.equal(before.pending,0);
 for(const sql of queries)await ds.query(sql);await migrateLegacyRegistration(ds);
 assert.equal((await ds.driver.createSchemaBuilder().log()).upQueries.length,0);return {ddlStatements:5};
}));
await caseRun('v3-application-schema-requires-only-review-privilege-expansion',()=>clone(async ds=>{
 for(const sql of ddl) if(sql!==PRIVILEGE_EXPANSION_SQL) await ds.query(sql);
 const before=await state(ds);
 const queries=validateQueries((await ds.driver.createSchemaBuilder().log()).upQueries);
 assert.deepEqual(queries,[PRIVILEGE_EXPANSION_SQL]);await validatePrivilegeSchema(ds,queries);
 const plan=await inspectLegacyRegistration(ds);assert.deepEqual([plan.pending,plan.rejected,plan.approvedHistory],[0,0,0]);
 for(const sql of queries) await ds.query(sql);
 await migrateLegacyRegistration(ds);assert.deepEqual(await state(ds),before);
 const next=validateQueries((await ds.driver.createSchemaBuilder().log()).upQueries);assert.deepEqual(next,[]);await validatePrivilegeSchema(ds,next);
 return {ddlStatements:1,noAccountApplicationOrAuditChanges:true,idempotent:true};
}));
await caseRun('pending-rejected-approved-audits-passwords-and-idempotency',()=>clone(async ds=>{
 await tables(ds,false);const p=await legacy(ds,'pending'),r=await legacy(ds,'rejected'),a=await legacy(ds,'approved');
 const oldCounter=Number((await ds.query("SELECT AUTO_INCREMENT AS value FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user'"))[0].value);
 const queries=validateQueries((await ds.driver.createSchemaBuilder().log()).upQueries);assert.equal(queries.length,2);await validatePrivilegeSchema(ds,queries);
 const plan=await inspectLegacyRegistration(ds);assert.deepEqual([plan.pending,plan.rejected,plan.approvedHistory,plan.archivedAccountAuditRecords,plan.reassignedAuditRecords],[1,1,1,4,1]);
 for(const sql of queries)await ds.query(sql);const moved=await migrateLegacyRegistration(ds);assert.equal(moved.fingerprint,plan.fingerprint);
 const applications=await ds.query('SELECT * FROM registration_application ORDER BY id');assert.equal(applications.length,3);
 for(const app of applications){
 if(app.status==='approved'){assert.equal(app.userId,a.id);assert.equal(app.passwordHash,null);assert.equal(app.reservedUsername,null);continue;}
 assert.equal(app.userId,null);assert.equal(app.passwordHash,hash);assert.ok(await bcrypt.compare('SyntheticMigrationPass42!',app.passwordHash));
 const archive=typeof app.legacyAccountAudit==='string'?JSON.parse(app.legacyAccountAudit):app.legacyAccountAudit;assert.equal(archive.length,2);assert.deepEqual(archive.map(x=>x.action),['auth.register','auth.login_failed.wrong_password']);
 }
 assert.equal(Number((await ds.query('SELECT COUNT(*) AS n FROM user WHERE id IN (?,?)',[p.id,r.id]))[0].n),0);
 assert.equal(Number((await ds.query('SELECT COUNT(*) AS n FROM user WHERE id=?',[a.id]))[0].n),1);
 assert.equal(Number((await ds.query("SELECT COUNT(*) AS n FROM registration_review WHERE status<>'approved'"))[0].n),0);
 const reject=(await ds.query("SELECT * FROM audit_log WHERE action='auth.registration_rejected'"))[0];assert.equal(reject.firstObjectId,null);const detail=JSON.parse(reject.details);assert.equal(detail.legacyUserId,r.id);assert.ok(detail.applicationId>0);
 assert.equal(Number((await ds.query("SELECT AUTO_INCREMENT AS value FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user'"))[0].value),oldCounter);
 const after=await state(ds);await migrateLegacyRegistration(ds);assert.deepEqual(await state(ds),after);
 const clean=await inspectLegacyRegistration(ds);assert.deepEqual([clean.pending,clean.rejected,clean.approvedHistory],[0,0,0]);
 return {pendingRemoved:1,rejectedRemoved:1,approvedIdPreserved:true,bcryptPreserved:true,actorAuditsArchived:4,rejectionAuditRetained:true,userAutoIncrementPreserved:true,idempotent:true};
}));
const failures=[
 ['nondefault-profile','LEGACY_NONDEFAULT_PROFILE',async(ds,p)=>ds.query("UPDATE user SET nickname='changed' WHERE id=?",[p.id])],
 ['administrator','LEGACY_NONDEFAULT_PROFILE',async(ds,p)=>ds.query('UPDATE user SET isAdmin=1 WHERE id=?',[p.id])],
 ['permission','LEGACY_BUSINESS_REFERENCES',async(ds,p)=>ds.query("INSERT INTO user_permission_rule(userId,permission,allowed) VALUES (?,'problem.create',1)",[p.id])],
 ['non-fk-ai-config','LEGACY_BUSINESS_REFERENCES',async(ds,p)=>ds.query("INSERT INTO ai_configuration(userId,encrypted,updatedAt) VALUES (?,'synthetic',NOW())",[p.id])],
 ['unknown-table','UNKNOWN_TABLE',async(ds)=>ds.query('CREATE TABLE custom_usage(ownerId int) ENGINE=InnoDB')],
 ['unknown-fk','UNKNOWN_FOREIGN_KEY',async(ds)=>ds.query('ALTER TABLE contest ADD CONSTRAINT custom_owner_fk FOREIGN KEY(ownerId) REFERENCES user(id)')],
 ['business-audit','LEGACY_UNSUPPORTED_AUDIT',async(ds,p)=>ds.query("INSERT INTO audit_log(userId,ip,time,action,details) VALUES (?,'127.0.0.1',NOW(),'user.update',NULL)",[p.id])],
 ['reserved-name-conflict','APPLICATION_CONFLICT',async(ds,p)=>ds.query("INSERT INTO registration_application(username,email,reservedUsername,reservedEmail,passwordHash,status,createdAt) VALUES (?,?,?,?,'synthetic','pending',NOW())",[p.username,p.email,p.username,p.email])]
];
for(const [name,code,modify] of failures)await caseRun(name+'-safe-refusal',()=>clone(async ds=>{
 await tables(ds);const p=await legacy(ds,'pending');await modify(ds,p);const before=await state(ds);
 await assert.rejects(()=>migrateLegacyRegistration(ds),error=>error.code===code);assert.deepEqual(await state(ds),before);return {code,allAccountAndAuditRowsPreserved:true};
}));
await caseRun('transaction-failure-after-user-delete-rolls-back-every-row',()=>clone(async ds=>{
 await tables(ds);await legacy(ds,'pending');const before=await state(ds);const proxy=Object.create(ds);
 proxy.createQueryRunner=()=>{const runner=ds.createQueryRunner();const query=runner.query.bind(runner);runner.query=async(...args)=>{const result=await query(...args);if(args[0]==='DELETE FROM user WHERE id=?')throw new Error('synthetic transaction failure');return result;};return runner;};
 await assert.rejects(()=>migrateLegacyRegistration(proxy));assert.deepEqual(await state(ds),before);return {allAccountAndAuditRowsRestored:true};
}));

await caseRun('cross-database-cascade-reference-refused-with-both-databases-intact',()=>clone(async ds=>{
 await tables(ds);const p=await legacy(ds,'pending');const before=await state(ds);
 const foreign='libreoj_upgrade_'+crypto.randomBytes(8).toString('hex');
 const current=(await ds.query('SELECT DATABASE() AS name'))[0].name;
 await ds.query('CREATE DATABASE `'+foreign+'`');
 try {
  await ds.query('CREATE TABLE `'+foreign+'`.external_content (id int PRIMARY KEY, userId int, CONSTRAINT cross_account FOREIGN KEY(userId) REFERENCES `'+current+'`.user(id) ON DELETE CASCADE) ENGINE=InnoDB');
  await ds.query('INSERT INTO `'+foreign+'`.external_content VALUES (1,?)',[p.id]);
  await assert.rejects(()=>inspectLegacyRegistration(ds),error=>error.code==='UNKNOWN_FOREIGN_KEY');
  await assert.rejects(()=>migrateLegacyRegistration(ds),error=>error.code==='UNKNOWN_FOREIGN_KEY');
  assert.deepEqual(await state(ds),before);
  assert.equal(Number((await ds.query('SELECT COUNT(*) AS n FROM `'+foreign+'`.external_content WHERE userId=?',[p.id]))[0].n),1);
  return {code:'UNKNOWN_FOREIGN_KEY',bothDatabasesIntact:true};
 } finally {await ds.query('DROP DATABASE `'+foreign+'`');}
}));
await caseRun('audit-archive-readback-failure-restores-original-rows',()=>clone(async ds=>{
 await tables(ds);await legacy(ds,'pending');const before=await state(ds);const proxy=Object.create(ds);
 proxy.createQueryRunner=()=>{const runner=ds.createQueryRunner();const query=runner.query.bind(runner);runner.query=async(...args)=>{const result=await query(...args);if(args[0].startsWith('SELECT legacyAccountAudit FROM'))return [{legacyAccountAudit:'[]'}];return result;};return runner;};
 await assert.rejects(()=>migrateLegacyRegistration(proxy),error=>error.code==='AUDIT_COPY_VERIFICATION');assert.deepEqual(await state(ds),before);return {allOriginalAuditAndAccountRowsPreserved:true};
}));
await caseRun('privilege-append-preserves-all-existing-values-and-grants',()=>clone(async ds=>{
 const admin=Number((await ds.query('SELECT id FROM user WHERE isAdmin=1 ORDER BY id LIMIT 1'))[0].id);
 for (const privilege of LEGACY_PRIVILEGES) await ds.query('INSERT IGNORE INTO user_privilege(userId,privilegeType) VALUES (?,?)',[admin,privilege]);
 const before=await ds.query('SELECT userId,privilegeType,privilegeType+0 AS enumIndex FROM user_privilege ORDER BY userId,privilegeType+0');
 const queries=validateQueries((await ds.driver.createSchemaBuilder().log()).upQueries);
 assert.ok(queries.includes(PRIVILEGE_EXPANSION_SQL));await validatePrivilegeSchema(ds,queries);
 for(const query of queries) await ds.query(query);
 assert.deepEqual(await ds.query('SELECT userId,privilegeType,privilegeType+0 AS enumIndex FROM user_privilege ORDER BY userId,privilegeType+0'),before);
 await ds.query('INSERT INTO user_privilege(userId,privilegeType) VALUES (?,?)',[admin,REVIEW_PRIVILEGE]);
 assert.equal(Number((await ds.query('SELECT privilegeType+0 AS n FROM user_privilege WHERE userId=? AND privilegeType=?',[admin,REVIEW_PRIVILEGE]))[0].n),LEGACY_PRIVILEGES.length+1);
 const next=validateQueries((await ds.driver.createSchemaBuilder().log()).upQueries);assert.deepEqual(next,[]);await validatePrivilegeSchema(ds,next);
 return {existingEnumValues:LEGACY_PRIVILEGES.length,oldNumericIndexesAndRowsPreserved:true,newValueAppendOnly:true,idempotent:true};
}));
await caseRun('privilege-unknown-value-and-order-refused-before-ddl',()=>clone(async ds=>{
 await tables(ds);const admin=Number((await ds.query('SELECT id FROM user WHERE isAdmin=1 ORDER BY id LIMIT 1'))[0].id);
 const custom=[...LEGACY_PRIVILEGES,REVIEW_PRIVILEGE,'CustomPrivilege'];
 const columnSql=values=>'ALTER TABLE user_privilege CHANGE privilegeType privilegeType enum ('+values.map(x=>"'"+x+"'").join(',')+') NOT NULL';
 await ds.query(columnSql(custom));await ds.query('INSERT INTO user_privilege(userId,privilegeType) VALUES (?,?)',[admin,'CustomPrivilege']);
 const query="SELECT COLUMN_TYPE AS value FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_privilege' AND COLUMN_NAME='privilegeType'";
 const before=await ds.query(query),rows=await ds.query('SELECT * FROM user_privilege ORDER BY userId,privilegeType');
 const changes=validateQueries((await ds.driver.createSchemaBuilder().log()).upQueries);assert.ok(changes.includes(PRIVILEGE_EXPANSION_SQL));
 await assert.rejects(()=>validatePrivilegeSchema(ds,changes));
 const database=(await ds.query('SELECT DATABASE() AS name'))[0].name;
 let refused=false;
 try {execFileSync(process.execPath,[ROOT+'/deploy/upgrade-schema.mjs','--root',ROOT,'--socket',socketPath,'--database',database,'--action','apply'],{stdio:'pipe'});}
 catch(error){assert.equal(error.status,1);assert.equal(error.stderr.toString(),'UPGRADE_COMPATIBILITY: SCHEMA_CHANGE_UNSUPPORTED\n');refused=true;}
 assert.ok(refused);assert.deepEqual(await ds.query(query),before);assert.deepEqual(await ds.query('SELECT * FROM user_privilege ORDER BY userId,privilegeType'),rows);
 await ds.query('DELETE FROM user_privilege WHERE privilegeType=?',['CustomPrivilege']);
 await ds.query(columnSql([...LEGACY_PRIVILEGES,REVIEW_PRIVILEGE].reverse()));
 await assert.rejects(()=>validatePrivilegeSchema(ds,[]));
 return {unknownValueRetained:true,allGrantsRetained:true,cliApplyRefusedBeforeWrite:true,reorderedEnumRefusedEvenWithoutDdl:true};
}));
console.log('migration validation finished: '+results.length+' passed; sanitized report: '+report);
