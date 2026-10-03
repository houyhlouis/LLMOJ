// Opt-in actual service/SQL regression. Random isolated tables only; all dropped in finally.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => {
  const source = process.env.HYHOJ_SUBMISSION_TEST_BASELINE && filename.endsWith('/submission.service.ts')
    ? process.env.HYHOJ_SUBMISSION_TEST_BASELINE : filename;
  module._compile(ts.transpileModule(fs.readFileSync(source,'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true
  } }).outputText, filename);
};
String.prototype.format ||= function(...args) { return require('node:util').format(this,...args); };
const { DataSource, EntitySchema } = require('typeorm');
const { SubmissionService } = require('./submission.service.ts');
const { SubmissionEntity } = require('./submission.entity.ts');
const { SubmissionDetailEntity } = require('./submission-detail.entity.ts');
const { UserEntity } = require('../user/user.entity.ts');
const { UserService } = require('../user/user.service.ts');
const { ProblemEntity } = require('../problem/problem.entity.ts');
const { ProblemService } = require('../problem/problem.service.ts');

test('deleted submissions keep owner counts atomic (real MariaDB)',
  { skip: !process.env.HYHOJ_SUBMISSION_TEST_DB_CONFIG, timeout: 60000 }, async t => {
  const cfg = require('js-yaml').load(fs.readFileSync(process.env.HYHOJ_SUBMISSION_TEST_DB_CONFIG,'utf8')).services.database;
  const prefix = 'qa_submission_finalfix_' + crypto.randomBytes(8).toString('hex') + '_';
  const int = { type: Number };
  const defs = [
    [UserEntity,'user',{ id:{...int,primary:true}, submissionCount:int,acceptedProblemCount:int }],
    [ProblemEntity,'problem',{id:{...int,primary:true},submissionCount:int,acceptedSubmissionCount:int}],
    [SubmissionEntity,'submission',{id:{...int,primary:true,generated:true},problemId:int,submitterId:int,
      contestId:{...int,nullable:true},taskId:{type:String,nullable:true},status:{type:String}}],
    [SubmissionDetailEntity,'detail',{submissionId:{...int,primary:true},fileUuid:{type:String,nullable:true}}]
  ];
  const db = new DataSource({...cfg,entities:defs.map(([target,name,columns])=>new EntitySchema({
    name:target.name,target,tableName:prefix+name,columns})),synchronize:true,logging:false});
  const report={prefix,cases:[],baseline:!!process.env.HYHOJ_SUBMISSION_TEST_BASELINE};
  try {
    await db.initialize();
    await db.query('ALTER TABLE `'+prefix+'detail` ADD FOREIGN KEY (`submissionId`) REFERENCES `'+prefix+'submission` (`id`) ON DELETE CASCADE');
    const users=db.getRepository(UserEntity),problems=db.getRepository(ProblemEntity),subs=db.getRepository(SubmissionEntity),details=db.getRepository(SubmissionDetailEntity);
    const tails=new Map();
    const locks={lock:async(key,callback)=>{
      const previous=tails.get(key)||Promise.resolve();let release;
      const gate=new Promise(done=>release=done),tail=previous.then(()=>gate);tails.set(key,tail);await previous;
      try{return await callback();}finally{release();if(tails.get(key)===tail)tails.delete(key);}
    }};
    const problemService=Object.create(ProblemService.prototype);
    Object.assign(problemService,{problemRepository:problems,lockProblemById:async(id,_type,callback)=>callback(await problems.findOneBy({id}))});
    const svc=Object.create(SubmissionService.prototype),userService=Object.create(UserService.prototype);
    Object.assign(userService,{userRepository:users,submissionService:svc,lockService:locks});
    Object.assign(svc,{connection:db,submissionRepository:subs,submissionDetailRepository:details,problemService,
      userService,lockService:locks,submissionStatisticsService:{onSubmissionUpdated:async()=>{}},
      judgeGateway:{cancelTask:()=>{}},submissionProgressService:{emitSubmissionEvent:async()=>{}},
      fileService:{deleteFile:async()=>()=>{}}});
    async function fixture(contest=false,status='WrongAnswer') {
      await users.save([{id:1,submissionCount:9,acceptedProblemCount:2},{id:2,submissionCount:contest?0:1,acceptedProblemCount:status==='Accepted'?1:0}]);
      await problems.save({id:1,submissionCount:contest?0:1,acceptedSubmissionCount:status==='Accepted'?1:0});
      const s=await subs.save({problemId:1,submitterId:2,contestId:contest?7:null,taskId:null,status});
      await details.save({submissionId:s.id,fileUuid:null});return s;
    }
    async function check(s,deleted,expectedCount) {
      assert.equal(await subs.countBy({id:s.id}),deleted?0:1);
      assert.equal(await details.countBy({submissionId:s.id}),deleted?0:1);
      assert.equal((await users.findOneBy({id:2})).submissionCount,expectedCount);
      assert.equal((await users.findOneBy({id:1})).submissionCount,9,'Deleter/admin count must remain untouched');
    }
    async function run(name,callback){await t.test(name,async()=>{await callback();report.cases.push({name,passed:true});});}
    await run('non-owner deletes a normal submission: decrement its owner exactly once',async()=>{
      const s=await fixture();await svc.deleteSubmission(s);await check(s,true,0);
      assert.equal((await problems.findOneBy({id:1})).submissionCount,0);
      await svc.deleteSubmission(s);await check(s,true,0);
    });
    await run('concurrent duplicate deletion re-reads under actual submission lock',async()=>{
      const s=await fixture();await Promise.all([svc.deleteSubmission({...s}),svc.deleteSubmission({...s})]);await check(s,true,0);
      assert.equal((await problems.findOneBy({id:1})).submissionCount,0);
    });
    await run('accepted deletion preserves accepted-problem counter behavior',async()=>{
      const s=await fixture(false,'Accepted');await svc.deleteSubmission(s);await check(s,true,0);
      assert.equal((await users.findOneBy({id:2})).acceptedProblemCount,0);
      assert.equal((await problems.findOneBy({id:1})).acceptedSubmissionCount,0);
    });
    await run('contest deletion never decrements user/problem statistics',async()=>{
      const s=await fixture(true);await svc.deleteSubmission(s);await check(s,true,0);
      assert.equal((await problems.findOneBy({id:1})).submissionCount,0);
    });
    for(const failure of ['remove','increment'])await run(failure+' failure rolls back deletion and owner count together',async()=>{
      const s=await fixture();const original=svc.connection;
      svc.connection={transaction:(level,callback)=>db.transaction(level,manager=>{
        manager[failure]=async()=>{throw new Error('forced '+failure+' failure');};return callback(manager);
      })};
      try{await assert.rejects(svc.deleteSubmission(s),new RegExp('forced '+failure+' failure'));}
      finally{svc.connection=original;}
      await check(s,false,1);assert.equal((await problems.findOneBy({id:1})).submissionCount,1);
      await svc.deleteSubmission(s);await check(s,true,0);
    });
    await run('concurrent fresh submission increment is preserved',async()=>{
      const s=await fixture();await Promise.all([svc.deleteSubmission(s),users.increment({id:2},'submissionCount',1)]);
      await check(s,true,1);
    });
  } finally {
    if(db.isInitialized){for(const name of ['detail','submission','problem','user'])await db.query('DROP TABLE IF EXISTS `'+prefix+name+'`');
      const remaining=await db.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LEFT(TABLE_NAME,?)=?',[prefix.length,prefix]);
      report.remainingTables=remaining;assert.equal(remaining.length,0);await db.destroy();}
    if(process.env.HYHOJ_SUBMISSION_TEST_OUTPUT)fs.writeFileSync(process.env.HYHOJ_SUBMISSION_TEST_OUTPUT,JSON.stringify(report,null,2)+'\n');
  }
});
