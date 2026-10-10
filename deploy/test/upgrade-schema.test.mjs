import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQueries, validatePrivilegeSchema, LEGACY_PRIVILEGES, REVIEW_PRIVILEGE, PRIVILEGE_EXPANSION_SQL } from '../upgrade-schema.mjs';
const create = "CREATE TABLE `registration_review` (`userId` int NOT NULL, `status` enum ('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending', `createdAt` datetime NOT NULL, `reviewedAt` datetime NULL, `reviewedBy` int NULL, `reason` varchar(500) NULL, INDEX `IDX_a74ed8c7d42252b6ece8a0833c` (`status`, `createdAt`), UNIQUE INDEX `REL_9ae4f649115581773289397754` (`userId`), PRIMARY KEY (`userId`)) ENGINE=InnoDB";
const foreign = 'ALTER TABLE `registration_review` ADD CONSTRAINT `FK_9ae4f6491155817732893977546` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION';
test('exact new table and FK accepted; no-op accepted',()=>{assert.deepEqual(validateQueries([{query:create},{query:foreign}]),[create,foreign]);assert.deepEqual(validateQueries([]),[])});
for(const [name,sql] of Object.entries({drop:'DROP TABLE `user`', alter:'ALTER TABLE `user` ADD COLUMN `a` int', other:create.replaceAll('registration_review','another_table'), wrongColumn:create.replace('varchar(500)','varchar(1000)'), wrongStatus:create.replace("'rejected'","'active'"), wrongTarget:foreign.replace('`user`','`user_auth`'), removeGate:foreign.replace('CASCADE','SET NULL'), injection:create+'; DROP TABLE `user`', comments:create+' -- comment'})) {
 test('reject '+name,()=>assert.throws(()=>validateQueries([{query:sql}])));
}
test('parameterized or partially destructive batch rejected',()=>{assert.throws(()=>validateQueries([{query:create,parameters:['value']}]));assert.throws(()=>validateQueries([{query:create},{query:'DROP TABLE `user`'}]));});

const application = "CREATE TABLE `registration_application` (`id` int NOT NULL AUTO_INCREMENT, `username` varchar(24) NOT NULL, `email` varchar(255) NOT NULL, `reservedUsername` varchar(24) NULL, `reservedEmail` varchar(255) NULL, `passwordHash` varchar(60) NULL, `legacyAccountAudit` longtext NULL, `status` enum ('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending', `createdAt` datetime NOT NULL, `reviewedAt` datetime NULL, `reviewedBy` int NULL, `reason` varchar(500) NULL, `userId` int NULL, UNIQUE INDEX `IDX_f2fc8c69d04804ba9ae7c56105` (`reservedUsername`), UNIQUE INDEX `IDX_adc509d1634e2666f777efe841` (`reservedEmail`), INDEX `IDX_2659d12875dd85c716f4c10649` (`status`, `createdAt`), UNIQUE INDEX `REL_79bad6b8ec15830e8d666eaf05` (`userId`), PRIMARY KEY (`id`)) ENGINE=InnoDB";
const applicationForeign = "ALTER TABLE `registration_application` ADD CONSTRAINT `FK_79bad6b8ec15830e8d666eaf05d` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION";
test('exact independent application table and nullable user link accepted',()=>{assert.deepEqual(validateQueries([application,applicationForeign]),[application,applicationForeign]);});
for(const [name,sql] of Object.entries({requiredUser:application.replace('`userId` int NULL','`userId` int NOT NULL'),requiredPassword:application.replace('`passwordHash` varchar(60) NULL','`passwordHash` varchar(60) NOT NULL'),missingAuditArchive:application.replace('`legacyAccountAudit` longtext NULL, ',''),nonUniqueReservation:application.replace('UNIQUE INDEX `IDX_f2fc8c69d04804ba9ae7c56105`','INDEX `IDX_f2fc8c69d04804ba9ae7c56105`'),cascadeDeletion:applicationForeign.replace('SET NULL','CASCADE'),wrongApplicationTarget:applicationForeign.replace('`user`','`user_auth`')})) {
 test('reject application '+name,()=>assert.throws(()=>validateQueries([sql])));
}

const enumColumn = values => ({columnType:"enum("+values.map(x=>"'"+x+"'").join(',')+")",isNullable:'NO',defaultValue:null,columnKey:'PRI',collation:'utf8mb4_unicode_ci',extra:'',comment:''});
const fakeColumn = row => ({query:async()=>row ? [row] : []});
test('only exact append-only review privilege DDL is accepted',()=>assert.deepEqual(validateQueries([PRIVILEGE_EXPANSION_SQL]),[PRIVILEGE_EXPANSION_SQL]));
for (const [name,sql] of Object.entries({removedValue:PRIVILEGE_EXPANSION_SQL.replace("'ManageUser', ",''),renamedValue:PRIVILEGE_EXPANSION_SQL.replace("'ManageUser'","'ManagePeople'"),reordered:PRIVILEGE_EXPANSION_SQL.replace("'EditHomepage', 'ManageUser'","'ManageUser', 'EditHomepage'"),extraValue:PRIVILEGE_EXPANSION_SQL.replace("'ManageRegistrationReviews'","'ManageRegistrationReviews', 'Unexpected'"),nullable:PRIVILEGE_EXPANSION_SQL.replace('NOT NULL','NULL'),otherColumn:PRIVILEGE_EXPANSION_SQL.replaceAll('`privilegeType`','`other`')})) test('reject privilege '+name,()=>assert.throws(()=>validateQueries([sql])));
test('existing old privilege enum requires exactly one expansion; new enum requires none',async()=>{
 await validatePrivilegeSchema(fakeColumn(enumColumn(LEGACY_PRIVILEGES)),[PRIVILEGE_EXPANSION_SQL]);
 await validatePrivilegeSchema(fakeColumn(enumColumn([...LEGACY_PRIVILEGES,REVIEW_PRIVILEGE])),[]);
 await assert.rejects(()=>validatePrivilegeSchema(fakeColumn(enumColumn(LEGACY_PRIVILEGES)),[]));
 await assert.rejects(()=>validatePrivilegeSchema(fakeColumn(enumColumn([...LEGACY_PRIVILEGES,REVIEW_PRIVILEGE])),[PRIVILEGE_EXPANSION_SQL]));
 await assert.rejects(()=>validatePrivilegeSchema(fakeColumn(enumColumn(LEGACY_PRIVILEGES)),[PRIVILEGE_EXPANSION_SQL,PRIVILEGE_EXPANSION_SQL]));
});
test('unknown existing privilege values/order or custom column properties cannot be overwritten',async()=>{
 const old=enumColumn(LEGACY_PRIVILEGES);
 for (const column of [null,enumColumn([...LEGACY_PRIVILEGES,'CustomPrivilege']),enumColumn([...LEGACY_PRIVILEGES].reverse()),{...old,isNullable:'YES'},{...old,defaultValue:'ManageUser'},{...old,collation:'utf8mb4_bin'},{...old,columnKey:''},{...old,comment:'custom'}]) await assert.rejects(()=>validatePrivilegeSchema(fakeColumn(column),[PRIVILEGE_EXPANSION_SQL]));
});
