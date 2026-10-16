const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { DataSource } = require('typeorm');
const { SelfEvalService } = require('./self-eval.service.ts');
const { SelfEvalEntity, SelfEvalSetEntity, SelfEvalQuotaEntity } = require('./self-eval.entity.ts');
const { UserEntity } = require('../user/user.entity.ts');
const { HackEntity } = require('../hack/hack.entity.ts');
const { HackService } = require('../hack/hack.service.ts');
const options = { compiler:'g++',std:'c++17',O:'2',m:'64' };

test('private fixed prediction sets and contest-wide quotas (real MariaDB)', {skip: !process.env.LLMOJ_SELF_EVAL_TEST_DB_CONFIG, timeout:120000}, async t => {
  const cfg = require('js-yaml').load(fs.readFileSync(process.env.LLMOJ_SELF_EVAL_TEST_DB_CONFIG, 'utf8')).services.database;
  if (!/^llmoj_(?:features|test)_/.test(cfg.database)) throw new Error('Disposable test databases only');
  const db = new DataSource({...cfg,entities:[path.join(__dirname,'../**/*.entity.ts')],synchronize:false});
  let owned=false;
  try {
    await db.initialize();
    if ((await db.query('SHOW TABLES')).length) throw new Error('The self-evaluation fixture requires an empty disposable database');
    owned=true; await db.synchronize();
    const users = db.getRepository(UserEntity);
    const user = await users.save(users.create({username:'self-eval-user',email:'self-eval@example.invalid',nickname:'',bio:'',avatarInfo:'gravatar:',isAdmin:false,acceptedProblemCount:0,submissionCount:0,rating:0,publicEmail:false,registrationTime:new Date()}));
    const tails = new Map();
    const locks = {lock:async(key, fn)=>{const previous=tails.get(key)||Promise.resolve(); let release; const gate=new Promise(done=>release=done); tails.set(key,previous.then(()=>gate)); await previous; try{return await fn();}finally{release();}}};
    const queued=[]; const service=Object.create(SelfEvalService.prototype);
    let allowed=true;
    Object.assign(service,{db,locks,queue:{enqueue:async(...args)=>queued.push(args),notifyJobsAvailable(){}},privileges:{userHasPrivilege:async()=>allowed,permissionDecision:async()=>allowed},contests:{get:async()=>({contest:{rule:"noi",ruleOptions:{selfEvalEnabled:true}}})}});
    const contexts = problemId => ({problem:{id:problemId},manager:true,enabled:true,active:true,limit:2,scope:`contest:7:problem:${problemId}`,quotaScope:'contest:7',recipeHash:'recipe',configHash:'config',languages:['cpp:c++17'],judgeInfo:{selfEval:{subtaskIds:[1]},timeLimit:1000,memoryLimit:128,subtasks:[{testcases:[],scoringType:'Sum'}],checker:{type:'tokens'}},testData:{}});
    service.context=async(_u, request)=>contexts(request.problemId);
    for(const problemId of [1,2]) await db.getRepository(SelfEvalSetEntity).save({scope:contexts(problemId).scope,problemId,contestId:7,recipeHash:'recipe',configHash:'config',status:'Ready',taskId:null,cases:[{subtask:1,input:Buffer.from('SECRET INPUT').toString('base64'),output:Buffer.from('SECRET EXPECTED').toString('base64')}],snapshot:{judgeInfo:contexts(problemId).judgeInfo},createdAt:new Date()});
    const request = problemId=>({problemId,contestId:7,content:{language:'cpp',code:'int main(){}',compileAndRunOptions:options}});
    let ids;
    await t.test('concurrent attempts across different problems share one atomic contest quota',async()=>{
      const results=await Promise.allSettled([service.create(user,request(1)),service.create(user,request(2)),service.create(user,request(1))]);
      assert.equal(results.filter(x=>x.status==='fulfilled').length,2);
      assert.match(results.find(x=>x.status==='rejected').reason.message,/limit reached/);
      assert.equal((await db.getRepository(SelfEvalQuotaEntity).findOneBy({scope:'contest:7',userId:user.id})).used,2);
      assert.equal(await db.getRepository(SelfEvalEntity).count(),2);
      ids=results.filter(x=>x.status==='fulfilled').map(x=>x.value.id);
    });
    await t.test('get/list whitelist hides input, expected answer, code and snapshots',async()=>{
      const response=await service.get(user,ids[0]);
      assert.deepEqual(Object.keys(response).sort(),['contestId','createTime','feedback','finishTime','id','memoryUsed','problemId','score','status','timeUsed'].sort());
      assert.doesNotMatch(JSON.stringify(response),/SECRET|snapshot|code|input|output/);
      assert.doesNotMatch(JSON.stringify(await service.list(user,{contestId:7})),/SECRET|snapshot|code|input|output/);
    });
    await t.test('configuration drift refuses evaluation without resetting used attempts',async()=>{
      await db.getRepository(SelfEvalSetEntity).update(contexts(1).scope,{configHash:'changed'});
      await assert.rejects(service.create(user,request(1)),/does not match/);
      assert.equal((await db.getRepository(SelfEvalQuotaEntity).findOneBy({scope:'contest:7',userId:user.id})).used,2);
      await db.getRepository(SelfEvalSetEntity).update(contexts(1).scope,{configHash:'config'});
    });
    await t.test('contest language version restrictions apply before quota consumption',async()=>{
      await assert.rejects(service.create(user,{...request(1),content:{...request(1).content,compileAndRunOptions:{...options,std:'c++20'}}}),/Language/);
    });
    await t.test('finished feedback stores only safe subtask scores and rejects stale callbacks',async()=>{
      const record=await db.getRepository(SelfEvalEntity).findOneBy({id:ids[0]});
      assert.equal(await service.onTaskProgress(record.taskId,{finished:true,status:'Accepted',score:100,timeUsed:4,memoryUsed:10,subtasks:[{score:100,fullScore:100,input:'SECRET',checkerMessage:'SECRET'}],cases:[{input:'SECRET'}]}),true);
      const saved=await db.getRepository(SelfEvalEntity).findOneBy({id:record.id});
      assert.deepEqual(saved.feedback,{subtasks:[{score:100,fullScore:100}]});
      assert.equal(await service.onTaskProgress(record.taskId,{finished:true,status:'WrongAnswer',score:0}),false);
      assert.equal((await db.getRepository(SelfEvalEntity).findOneBy({id:record.id})).status,'Accepted');
      assert.equal((await users.findOneBy({id:user.id})).submissionCount,0);
    });
    await t.test('revoking global evaluation permission cancels a queued completion',async()=>{
      const record=await db.getRepository(SelfEvalEntity).findOneBy({id:ids[1]}); allowed=false;
      assert.equal(await service.onTaskProgress(record.taskId,{finished:true,status:'Accepted',score:100}),false);
      assert.equal((await db.getRepository(SelfEvalEntity).findOneBy({id:record.id})).status,'Canceled'); allowed=true;
    });
    await t.test('a used fixed prediction set cannot be replaced',async()=>{
      await assert.rejects(service.prepareContext({...contexts(1),configHash:'new'},user,true),/cannot be replaced/);
    });
    await t.test('a quota reduced while waiting is enforced from the fresh locked context',async()=>{
      const reducedUser=await users.save(users.create({...user,id:undefined,username:'quota-reduced-user',email:'quota-reduced@example.invalid'}));
      await db.getRepository(SelfEvalQuotaEntity).save({scope:'contest:7',userId:reducedUser.id,used:1});
      await db.getRepository(SelfEvalEntity).save({scope:contexts(1).scope,problemId:1,contestId:7,submitterId:reducedUser.id,status:'Accepted',taskId:null,score:100,content:request(1).content,snapshot:{},createTime:new Date(),finishTime:new Date()});
      const before=await db.getRepository(SelfEvalEntity).count(),previous=service.context;let calls=0;
      service.context=async(_u,r)=>({...contexts(r.problemId),limit:++calls===1?2:1});
      try{await assert.rejects(service.create(reducedUser,request(1)),/limit reached/);}finally{service.context=previous;}
      assert.equal((await db.getRepository(SelfEvalQuotaEntity).findOneBy({scope:'contest:7',userId:reducedUser.id})).used,1);
      assert.equal(await db.getRepository(SelfEvalEntity).count(),before);
    });
    await t.test('hack task callbacks are immutable and stale successes cannot charge points',async()=>{
      const hacks=db.getRepository(HackEntity); const hack=await hacks.save({submissionId:99,problemId:1,submitterId:2,hackerId:user.id,status:'Pending',taskId:'task-1',inputData:'input',snapshot:{},targetFingerprint:'fingerprint',createTime:new Date()});
      let marked=0; const hackService=Object.create(HackService.prototype);
      Object.assign(hackService,{db,locks,submissions:{findSubmissionById:async()=>({id:99}),markSubmissionHacked:async(_target,_hacker,_id,_fingerprint,persist)=>{marked++;await db.transaction(persist);return true;}}});
      hackService.taskAuthorised=async()=>true;
      assert.equal(await hackService.onTaskProgress('task-1',{finished:true,status:'Success',message:'valid',timeUsed:1,memoryUsed:2}),true);
      assert.equal(await hackService.onTaskProgress('task-1',{finished:true,status:'Success'}),false);
      assert.equal(marked,1); assert.equal((await hacks.findOneBy({id:hack.id})).status,'Success');
      const second=await hacks.save({...hack,id:undefined,taskId:'task-2',status:'Pending'});
      hackService.submissions.markSubmissionHacked=async()=>false;
      assert.equal(await hackService.onTaskProgress('task-2',{finished:true,status:'Success'}),true);
      assert.equal((await hacks.findOneBy({id:second.id})).status,'Canceled');
      const denied=await hacks.save({...hack,id:undefined,taskId:'task-3',status:'Pending'});
      hackService.taskAuthorised=async()=>false;
      assert.equal(await hackService.onTaskProgress('task-3',{finished:true,status:'Success'}),false);
      assert.equal((await hacks.findOneBy({id:denied.id})).status,'Canceled');
    });
    await t.test('results from an obsolete judge lease store nothing; current ones commit with the job',async()=>{
      // The judge queue's completion: confirmed in the transaction that stores the result
      const completion=current=>({calls:0,async confirm(manager){this.calls++;assert.equal(manager.queryRunner.isTransactionActive,true);return current;}});
      const records=db.getRepository(SelfEvalEntity);
      const record=await records.save({scope:contexts(1).scope,problemId:1,contestId:7,submitterId:user.id,status:'Pending',taskId:'eval-lease',content:request(1).content,snapshot:{},createTime:new Date()});
      const stale=completion(false);
      assert.equal(await service.onTaskProgress('eval-lease',{finished:true,status:'Accepted',score:100},stale),false);
      assert.equal(stale.calls,1);
      assert.deepEqual([(await records.findOneBy({id:record.id})).status,(await records.findOneBy({id:record.id})).taskId],['Pending','eval-lease']);
      const fresh=completion(true);
      assert.equal(await service.onTaskProgress('eval-lease',{finished:true,status:'Accepted',score:100},fresh),true);
      assert.equal(fresh.calls,1);
      assert.deepEqual([(await records.findOneBy({id:record.id})).status,(await records.findOneBy({id:record.id})).taskId],['Accepted',null]);

      const hacks=db.getRepository(HackEntity);
      const hack=await hacks.save({submissionId:99,problemId:1,submitterId:2,hackerId:user.id,status:'Pending',taskId:'hack-lease',inputData:'input',snapshot:{},targetFingerprint:'fingerprint',createTime:new Date()});
      const hackService=Object.create(HackService.prototype);
      Object.assign(hackService,{db,locks,submissions:{findSubmissionById:async()=>({id:99}),markSubmissionHacked:async(_target,_hacker,_id,_fingerprint,persist)=>{await db.transaction(persist);return true;}}});
      hackService.taskAuthorised=async()=>true;
      assert.equal(await hackService.onTaskProgress('hack-lease',{finished:true,status:'Success'},completion(false)),false);
      assert.deepEqual([(await hacks.findOneBy({id:hack.id})).status,(await hacks.findOneBy({id:hack.id})).taskId],['Pending','hack-lease']);
      assert.equal(await hackService.onTaskProgress('hack-lease',{finished:true,status:'Success'},completion(true)),true);
      assert.equal((await hacks.findOneBy({id:hack.id})).status,'Success');
      const failed=await hacks.save({...hack,id:undefined,taskId:'hack-failed',status:'Pending'});
      assert.equal(await hackService.onTaskProgress('hack-failed',{finished:true,status:'Failed'},completion(false)),false);
      assert.equal((await hacks.findOneBy({id:failed.id})).status,'Pending');
    });
  } finally { if(db.isInitialized) {if(owned) await db.dropDatabase(); await db.destroy();} }
});
