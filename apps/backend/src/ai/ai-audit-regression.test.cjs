/* Credential-free regressions for the October live audit; no DB or provider requests. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const provider = require('./ai-provider.ts');
const { aiServices, bareAiServices } = require("./ai-test-services.cjs");
const { AiError } = require('./ai.types.ts');
const { aiTutorialFacts, aiTutorialFactViolation } = require('./ai-tutorial-facts.ts');
const sum = { subtasks: [{ points: 100, scoringType: 'Sum', testcases: Array(5).fill({}) }] };
const related = { url: 'https://github.com/doocs/leetcode/485', title: 'Max Consecutive Ones', searchEvidence: 'semantic_match' };
const badPartial = ['本题没有子任务或部分分。', 'This problem has no subtasks or partial scores.'];
const badSource = ['题面与样例的原始出处：[doocs/leetcode](https://example.org)。', 'Original source of the statement and sample: [doocs/leetcode](https://example.org).'];

test('five Sum cases establish possible partial scoring; upcoming generation is not old scoring', () => {
  for (const facts of [aiTutorialFacts(sum, false, {}), aiTutorialFacts({}, true, {}), aiTutorialFacts({}, false, {})])
    for (const text of badPartial) assert.equal(aiTutorialFactViolation(text, facts), 'UNSUPPORTED_NO_PARTIAL_SCORE_CLAIM');
  const facts = aiTutorialFacts({subtasks: [{points:100, scoringType:'GroupMin',testcases:[{}]}]}, true, {});
  assert.equal(facts.scoring.currentPartialScoring, 'not established');
  assert.match(facts.scoring.instructions, /precedes data generation/);
  assert.match(facts.scoring.instructions, /not yet verified/);
  assert(aiTutorialFactViolation(badPartial[0], facts));
});

test('the actual Sunny Days provenance claims are rejected; matching algorithms are not sample provenance', () => {
  const facts = aiTutorialFacts({}, true, related);
  assert.equal(facts.source.exactStatementAndSamplesVerified, false);
  assert.equal(facts.source.searchEvidence, 'semantic_match');
  for (const text of badSource) assert.equal(aiTutorialFactViolation(text, facts), 'UNVERIFIED_SOURCE_PROVENANCE_CLAIM');
});

test('qualified references, negated warnings and source code literals are not assertions', () => {
  const facts = aiTutorialFacts(sum, true, related);
  for (const text of ['不能说本题没有部分分。', '不能把参考链接称为原题面与样例的来源。', '引用页并未包含本题样例。',
    'Do not claim this problem has no subtasks or partial scores.',
    'The reference page is not the original source of the statement and sample.',
    '相关算法参考：LeetCode 485；本文使用本地题面样例。',
    'Related problem: LeetCode 485. Local samples remain authoritative.',
    '本题样例来自本地题面。', 'The sample comes from the local problem statement.',
    '```cpp\nconst char* s = "no partial scores";\n```'])
    assert.equal(aiTutorialFactViolation(text, facts), null, text);
});

function tutorialFixture(result, action='all') {
  const published = [], prompts = [];
  const user = {id:1}, problem = {id:8, type:'Traditional', originalProblem:related.url};
  const snapshot = {samples:[], statements:[], judgeInfo:sum};
  const job = {id:'tutorial-memory',action,state:{},progress:0};
  const svc = aiServices({}, {}, {}, {}, {}, {
    userHasCreateDiscussionPermission:async()=>true,
    createDiscussion:async(_u,_t,content)=>{published.push(content);return {id:published.length};}
  },{});
  svc.assertSnapshot=async()=>user;
  svc.references=async()=> 'A related algorithm page with different examples.';
  svc.checkpoint=async()=>{};
  svc.model=async(_config,prompt)=>{prompts.push(prompt);return result;};
  return {svc, job, published, prompts, run:()=>svc.edit(job,user,problem,{},snapshot,'tutorial')};
}

test('both localized tutorials are checked before either discussion is published', async () => {
  for (const text of [...badPartial, ...badSource]) {
    const f=tutorialFixture({zh_CN:'正确的解法',en_US:text});
    await assert.rejects(f.run(), /INVALID_AI_TUTORIAL/);
    assert.deepEqual(f.published, []);
    assert.equal(f.job.state.tutorialContents,undefined);
  }
});

test('safe tutorials retain bilingual publication, with scoring and source context in the model input',async()=>{
  const f=tutorialFixture({zh_CN:'求和即可。评分以实际配置为准。相关问题仅作算法参考。',en_US:'Sum the values. See the active scoring configuration; links are related references.'});
  await f.run();assert.equal(f.published.length,2);
  assert.match(f.prompts[0],/currentSubtasks/);
  assert.match(f.prompts[0],/"caseCount":5/);
  assert.match(f.prompts[0],/exactStatementAndSamplesVerified/);
  assert.match(f.prompts[0],/precedes data generation/);
});

const bad = '#include <random>\nint main(){std::random_device rd; std::mt19937_64 rnd(rd);return 0;}';
const good = '#include <random>\nint main(){std::random_device rd; const auto seed = rd(); std::mt19937_64 rnd(seed);return 0;}';
// A typed compile failure of make.cpp (judge protocol 6 and later), kept with its whole diagnostics
const compileFailure=(detail='no matching function for mt19937_64(random_device&)',execution={status:'RuntimeError',exitCode:1,termination:'exited'},role='make')=>{
  const error=new AiError('SANDBOX_GENERATION_FAILED',`${role} compilation failed: `+detail.slice(0,200));
  error.failure={kind:'compile_error',fatal:true,role,phase:`compile-${role}`,execution,summary:error.message,artifacts:[
    {role:'diagnostics',classification:'author-private',name:'0.diagnostics',size:detail.length,originalSize:detail.length,sha256:'d'.repeat(64),preview:detail.slice(0,100),binary:false,stored:true}]};
  error.diagnostics=detail;
  return error;
};
function repairFixture() {
  const checks=[], user={id:1}, job={id:'repair-memory',ownerId:1,state:{makeCode:bad,plan:{},validatorCode:'official validator',stdCode:'accepted std',managerCode:'official manager',problemHelpers:['manager']},progress:45,step:'testdata.compile'};
  const svc=aiServices({}, {}, {}, {userHasPrivilege:async()=>true,permissionDecision:async()=>true});
  svc.assertSnapshot=async()=>{checks.push('authorize');return user;};
  svc.checkpoint=async(_j,phase)=>checks.push(phase);
  svc.services.workflow.retryDelay=0;
  const request={makeCode:bad,validatorCode:'official validator',stdCode:'accepted std',managerCode:'official manager',extraSourceFiles:{'message.h':'official header'}};
  const rows=new Map();
  // A failed run's observation is kept as the runner reported it, with the program it failed with
  const keep=(error,source)=>{
    if(!error.failure)return error;
    error.observationId=error.observationId||`00000000-0000-4000-8000-${String(rows.size+1).padStart(12,'0')}`;
    rows.set(error.observationId,{id:error.observationId,evidence:'stored',expiresAt:new Date(Date.now()+86400000),
      observation:{...error.failure,origin:'local',operation:'generate',attemptId:'a',sourceHashes:{make:require('node:crypto').createHash('sha256').update(source).digest('hex')}},diagnostics:error.diagnostics});
    return error;
  };
  svc.services.workflow.evidence={
    observation:async(_j,id)=>{if(!rows.has(id))throw new AiError('NO_SUCH_OBSERVATION');return rows.get(id);},
    readText:async(_j,id,_role,limit)=>rows.get(id).diagnostics.slice(0,limit),
    addReplay:async()=>{},updateReplay:async()=>{}
  };
  // The repaired generator is compiled first, as the kept failure was
  const compiled=[];
  svc.replayRequest=async(current,_p,plan)=>({request:{profiles:{},replay:{...plan,programs:{make:current.state.makeCode}}},programs:{make:current.state.makeCode},profiles:'same'});
  svc.execution={replay:async(_j,req)=>{
    compiled.push(req.replay.programs.make);
    const now=new Date().toISOString();
    return {validation:{profiles:require('@libreoj/judge-protocol').aiContractDigest({})},
      execution:{contract:require('@libreoj/judge-protocol').AI_EXECUTION_PROTOCOL_VERSION,attemptId:'b',runtime:{judgeProgram:'0'.repeat(64),sandboxImage:'t',arch:'x64'},startedAt:now,finishedAt:now,reuse:{builds:0,inputs:0}},
      replay:{runs:[{outcome:'passed',summary:'ok'}]}};
  }};
  const config={llm:{apiKey:'synthetic-llm-secret'},search:{apiKey:'synthetic-search-secret'}};
  const run=()=>svc.runGenerationSandbox(job,config,{id:8,type:'Traditional'},{statements:[],judgeInfo:{}},request,async()=>{});
  return {svc,job,request,config,checks,run,keep,compiled};
}
async function withModel(fn, work) {
  const old=provider.generateText;provider.generateText=fn;
  try{return await work();}finally{provider.generateText=old;}
}

test('real GCC compiler diagnostics trigger one repair, which compiles; other roles and public headers are unchanged',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'llmoj-make-repair-'));
  let calls=0,compiles=0;
  try {
    const f=repairFixture();
    f.svc.runSandbox=async(_job,req,progress)=>{
      compiles++;await progress({phase:'compile-make'});
      for(const key of ['stdCode','validatorCode','managerCode','extraSourceFiles'])assert.deepEqual(req[key],f.request[key]);
      const filename=path.join(directory,'make.cpp');fs.writeFileSync(filename,req.makeCode);
      const out=spawnSync('g++',['-std=c++17','-fsyntax-only',filename],{encoding:'utf8'});
      if(out.error)throw out.error;
      if(out.status!==0)throw f.keep(compileFailure(out.stderr),req.makeCode);
      return {validated:true};
    };
    await withModel(async(_config,_system,prompt)=>{
      calls++;assert.match(prompt,/no matching function/);assert.match(prompt,/rnd\(rd\)/);
      assert.equal(f.job.state.repair.automatic,1,'budget persisted before model');
      assert(f.checks.includes('testdata.repair'));
      return good;
    },async()=>assert.equal((await f.run()).validated,true));
    assert.equal(calls,1);assert.equal(compiles,2);assert.equal(f.job.state.makeCode,good);
    assert.deepEqual(f.compiled,[good],'tested against the kept failure first');
    assert.equal(f.checks.filter(x=>x==='authorize').length,2);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('a bad repair stops after one request; the same failure of the same program never asks again',async()=>{
  const f=repairFixture();let calls=0,runs=0;
  f.svc.runSandbox=async(_j,req,p)=>{runs++;await p({phase:'compile-make'});throw f.keep(compileFailure(),req.makeCode);};
  await withModel(async()=>{calls++;return bad;},async()=>{
    await assert.rejects(f.run(),/SANDBOX_GENERATION_FAILED/);
    await assert.rejects(f.run(),/SANDBOX_GENERATION_FAILED/);
  });
  assert.equal(calls,1);assert.equal(runs,2);
  assert.equal(f.job.state.repair.review.reason,'UNCHANGED');
  assert.equal(f.job.state.repair.revisions[0].rejected,'IDENTICAL');
});

test('infrastructure, cancellation, the problem\'s own helpers and untyped failures are not repaired',async()=>{
  const killed={status:'TimeLimitExceeded',exitCode:-1,termination:'signaled'};
  for (const [error,review] of [
    [new AiError('JOB_CANCELLED'),undefined],[new AiError('SANDBOX_UNAVAILABLE'),'INFRASTRUCTURE'],
    [compileFailure(undefined,undefined,'manager'),'PROBLEM_HELPER'],
    [new AiError('SANDBOX_GENERATION_FAILED','make compilation failed (exit=1, termination=exited): untyped'),'UNCLASSIFIED'],
    [compileFailure('no output',killed),'INFRASTRUCTURE']
  ]) {
    const f=repairFixture();f.svc.runSandbox=async(_j,req,p)=>{await p({phase:'compile-make'});throw f.keep(error,req.makeCode);};
    await withModel(async()=>assert.fail('must not spend on repair'),async()=>await assert.rejects(f.run(),e=>e===error));
    assert.equal(f.job.state.repair.automatic,0);
    assert.equal(f.job.state.repair.review?.reason,review,error.message);
  }
});

test('permission/cancellation/snapshot revocation before and during repair prevent re-running or publishing code',async()=>{
  for(const errorCode of ['JOB_CANCELLED','PERMISSION_DENIED','PROBLEM_CHANGED_DURING_AI'])
    for(const when of ['before','during']){
      const f=repairFixture();let calls=0,runs=0,checks=0;
      f.svc.runSandbox=async(_j,req,p)=>{runs++;await p({phase:'compile-make'});throw f.keep(compileFailure(),req.makeCode);};
      f.svc.assertSnapshot=async()=>{if(++checks===(when==='before'?1:2))throw new AiError(errorCode);return{id:1};};
      await withModel(async()=>{calls++;return good;},async()=>await assert.rejects(f.run(),new RegExp(errorCode)));
      assert.equal(calls,when==='before'?0:1);assert.equal(runs,1);assert.equal(f.job.state.makeCode,bad);
    }
});

test('the repair diagnostic is bounded and redacts known configured secrets without sending configuration',async()=>{
  const f=repairFixture();let runs=0;
  f.request.makeCode=bad+' // synthetic-llm-secret';f.job.state.makeCode=f.request.makeCode;
  f.svc.runSandbox=async(_j,req,p)=>{if(++runs>1)return {};await p({phase:'compile-make'});throw f.keep(compileFailure('synthetic-search-secret '+ 'x'.repeat(10000)),req.makeCode);};
  await withModel(async(_config,_system,prompt)=>{
    assert(!prompt.includes('synthetic-llm-secret'));assert(!prompt.includes('synthetic-search-secret'));
    assert(!prompt.includes('x'.repeat(8100)));assert.match(prompt,/REDACTED/);return good;
  },f.run);
});


test('unsafe legacy tutorial caches are rejected, and explicit retry regenerates only unpublished tutorials',async()=>{
  const f=tutorialFixture({zh_CN:'should not regenerate without retry',en_US:'unused'});
  f.job.state.tutorialContents={zh_CN:badPartial[0],en_US:badPartial[1]};
  f.job.state.tutorialSnapshotHash=f.svc.problemSnapshotFingerprint({samples:[],statements:[],judgeInfo:sum});
  await assert.rejects(f.run(),/INVALID_AI_TUTORIAL/);
  assert.equal(f.prompts.length,0);assert.equal(f.published.length,0);
  f.job.error='INVALID_AI_TUTORIAL: UNSUPPORTED_NO_PARTIAL_SCORE_CLAIM';
  const retry=f.svc.retryState(f.job);
  assert.equal(retry.tutorialContents,undefined);assert.equal(retry.tutorialSnapshotHash,undefined);
  f.job.state.discussionIds={zh_CN:7};
  const partial=f.svc.retryState(f.job);
  assert.deepEqual(partial.discussionIds,{zh_CN:7});
  assert.deepEqual(partial.tutorialContents,f.job.state.tutorialContents,'never mix versions after partial publication');
});

test('data-generation and data-edit rights are checked again before spending on a repair',async()=>{
  for(const permission of ['generate','edit']) {
    const f=repairFixture();
    f.svc.privileges.userHasPrivilege=async()=>permission!=='generate';
    f.svc.privileges.permissionDecision=async()=>permission!=='edit';
    f.svc.runSandbox=async(_j,req,p)=>{await p({phase:'compile-make'});throw f.keep(compileFailure(),req.makeCode);};
    await withModel(async()=>assert.fail('revoked permission must not incur a repair call'),async()=>await assert.rejects(f.run(),/PERMISSION_DENIED/));
    assert.equal(f.job.state.repair.automatic,0);
  }
});
