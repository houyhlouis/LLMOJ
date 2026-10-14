const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { SelfEvalService } = require('./self-eval.service.ts');
const { ContestProblemEntity } = require('../contest/contest-problem.entity.ts');
const { BadRequestException, ForbiddenException } = require('@nestjs/common');
function fixture() {
  const user = { id: 7 };
  const now = Date.now();
  const contest = { id: 1, rule: 'noi', ruleOptions: {selfEvalEnabled: true,selfEvalMaxAttempts:2}, languages:['cpp:c++17'], startTime:new Date(now+60000), endTime:new Date(now+120000) };
  const judgeInfo = {timeLimit:1000,memoryLimit:128,subtasks:[{testcases:[],scoringType:'Sum'}],checker:{type:'custom',filename:'official-spj.cpp',interface:'testlib',language:'cpp',compileAndRunOptions:{compiler:'g++',std:'c++17',O:'2',m:'64'}}};
  const service = Object.create(SelfEvalService.prototype);
  const files = [], uploads = new Map(), events = [];
  let manager = true, allowed = true, writeLocked = false, failSecondUpload = false;
  Object.assign(service, {
    db: {getRepository: entity => ({findOneBy:async()=>entity === ContestProblemEntity ? {inputFilename:'',outputFilename:''} : null})},
    privileges: {userHasPrivilege:async()=>allowed},
    contests: {get:async()=>({contest,manager})},
    problems: {
      findProblemById:async()=>({id:1,type:'Traditional'}),
      getProblemPreprocessedJudgeInfo:async()=>[structuredClone(judgeInfo)],
      getProblemJudgeInfo:async()=>[structuredClone(judgeInfo),true],
      getProblemFiles:async()=>files,
      userHasPermission:async()=>manager && allowed,
      lockProblemById:async(_id,_kind,callback)=>{writeLocked=true; try { return await callback({id:1}); } finally {writeLocked=false;}},
      addProblemFile:async(_problem,_type,upload,name)=>{assert.equal(writeLocked,false,'source publication must not deadlock by nesting read under write lock');events.push('file:'+name);files.push({filename:name,uuid:upload.uuid});return failSecondUpload&&files.length===2?'UPLOAD_FAILED':null;},
      updateProblemJudgeInfo:async(_problem,next)=>{events.push('activate');Object.assign(judgeInfo,next);return null;}
    },
    locks:{lock:async(_key,callback)=>callback()},
    files:{uploadFile:async(id,bytes)=>uploads.set(id,bytes),deleteUnfinishedUploadedFile:async id=>uploads.delete(id)},
    queue:{pushTask:async()=>{}}
  });
  return {service,user,contest,judgeInfo,files,uploads,events,setManager:value=>manager=value,setAllowed:value=>allowed=value,setFailUpload:()=>failSecondUpload=true};
}
const manual = {problemId:1,contestId:1,generatorCode:'int main(){return 0;}',standardCode:'int main(){return 1;}',subtaskIds:[1],attestSameGenerator:true};
test('all self-evaluation context APIs reject ordinary tasks, disabled contests and every non-NOI rule', async()=>{
  for(const method of ['info','prepare','create','configureProfile']) {
    const f=fixture();await assert.rejects(f.service[method](f.user,{...manual,contestId:undefined}), /only in enabled NOI/);
    for(const rule of ['ioi','strictioi','acm']) {f.contest.rule=rule;await assert.rejects(f.service[method](f.user,manual), /only in enabled NOI/);}
    f.contest.rule='noi';f.contest.ruleOptions.selfEvalEnabled=false;await assert.rejects(f.service[method](f.user,manual), /only in enabled NOI/);
    assert.equal(f.events.length,0);
  }
});
test('NOI preparation requires an organizer with problem data permissions before the start', async()=>{
  const f=fixture();f.setManager(false);await assert.rejects(f.service.configureProfile(f.user,manual),ForbiddenException);
  f.setManager(true);f.contest.startTime=new Date(Date.now()-1);await assert.rejects(f.service.configureProfile(f.user,manual),/before the contest/);
  await assert.rejects(f.service.prepare(f.user,manual),/before the contest/);assert.equal(f.events.length,0);
});
test('manual make/std publication is immutable, preserves the official SPJ and does not require a separate validator', async()=>{
  const f=fixture();const checker=structuredClone(f.judgeInfo.checker);
  await f.service.configureProfile(f.user,manual);
  assert.deepEqual(f.judgeInfo.checker,checker);
  assert.equal(f.judgeInfo.selfEval.validatorFile,undefined);
  for(const [role,source] of [['generator',manual.generatorCode],['standard',manual.standardCode]]) {
    const digest=crypto.createHash('sha256').update(source).digest('hex');
    assert.equal(f.judgeInfo.selfEval[role+'Sha256'],digest);
    assert.match(f.judgeInfo.selfEval[role+'File'],new RegExp(digest));
    assert.equal(f.uploads.get(f.files.find(file=>file.filename===f.judgeInfo.selfEval[role+'File']).uuid).toString(),source);
  }
  assert.equal(f.events.at(-1),'activate');await f.service.configureProfile(f.user,manual);assert.equal(f.files.length,2);
});
test('formal input validation is retained automatically when an AI profile already exists', async()=>{
  const f=fixture();f.judgeInfo.selfEval={validatorFile:'formal-validator.cpp',validatorSha256:'a'.repeat(64)};
  await f.service.configureProfile(f.user,manual);assert.equal(f.judgeInfo.selfEval.validatorFile,'formal-validator.cpp');assert.equal(f.judgeInfo.selfEval.validatorSha256,'a'.repeat(64));
});
test('failed partial uploads never activate a make/std recipe', async()=>{
  const f=fixture();f.setFailUpload();await assert.rejects(f.service.configureProfile(f.user,manual),/Could not save/);assert.equal(f.events.includes('activate'),false);assert.equal(f.judgeInfo.selfEval,undefined);
});
test('source attestation and bounded C++ sources are validated before any publication', async()=>{
  for(const bad of [{attestSameGenerator:false},{generatorCode:''},{standardCode:'a'.repeat(1048577)},{subtaskIds:[2]}]) {
    const f=fixture();await assert.rejects(f.service.configureProfile(f.user,{...manual,...bad}),BadRequestException);assert.equal(f.events.length,0);
  }
});
