const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const crypto=require('node:crypto');
const ts=require('typescript');
const protocol=require('@libreoj/judge-protocol');
const statuses={OK:'OK',RuntimeError:'RuntimeError',TimeLimitExceeded:'TimeLimitExceeded',MemoryLimitExceeded:'MemoryLimitExceeded',Cancelled:'Cancelled',OutputLimitExceeded:'OutputLimitExceeded',Unknown:'Unknown'};
class ConfigurationError extends Error {}
class CanceledError extends Error {}
class Compiled {constructor(code){this.binaryDirectory=code;this.extraInfo='';}async dereference(){}}
const state={output:'wrong',validator:statuses.OK,reference:statuses.OK,target:statuses.OK,compile:true,checkerScore:null,downloaded:[],calls:[],files:{},programFileIo:{}};
const roots=[];
function mapped(base,name){return typeof base==='string'?path.join(base,name):{outside:path.join(base.outside,name),inside:path.join(base.inside,name)};}
const fakeFs={ensureDir:async p=>fsp.mkdir(p,{recursive:true}),exists:async p=>fsp.access(p).then(()=>true,()=>false),calcSize:async p=>{let size=0;const stat=await fsp.lstat(p);if(stat.isDirectory())for(const name of await fsp.readdir(p))size+=await fakeFs.calcSize(path.join(p,name));else size=stat.size;return size;}};
const dependencies={
 'winston':{__esModule:true,default:{error:()=>{}}},
 '@libreoj/judge-protocol':protocol,'simple-sandbox':{SandboxStatus:statuses},
 '../../compile':{CompileResultSuccess:Compiled,compile:async content=>state.compile?new Compiled(content.code):{success:false,message:'SECRET compiler output'}},
 '../../error':{ConfigurationError,CanceledError},'../../file':{ensureFiles:async ids=>state.downloaded.push(...ids),getFile:id=>state.files[id]},
 '../../config':{serverSideConfig:{limit:{outputSize:4*1024*1024}}},
 '../submission/common':{getExtraSourceFiles:()=>({})},
 '../../languages':{__esModule:true,default:()=>({run:opts=>({stdin:opts.stdinFile,stdout:opts.stdoutFile,parameters:opts.parameters})})},
 '../../taskQueue':{runTaskQueued:async callback=>{const root=await fsp.mkdtemp(path.join(os.tmpdir(),'llmoj-hack-unit-'));roots.push(root);return callback(root);}},
 '../../sandbox':{SANDBOX_INSIDE_PATH_BINARY:'/sandbox/binary',SANDBOX_INSIDE_PATH_WORKING:'/sandbox/working',CpuAffinityStrategy:{UserProgram:'user'},runSandbox:async(_id,config)=>{
   const program=config.extraMounts[0].mappedPath.outside;
   const mount=config.extraMounts[1].mappedPath;
   // A named-file program reads/writes its hardcoded filenames, regardless of the sandbox's stdio plumbing.
   const fileIo=state.programFileIo[program];
   const output=fileIo?path.join(mount.outside,fileIo.outputFilename):config.stdout?.replace(mount.inside,mount.outside);
   const input=fileIo?path.join(mount.outside,fileIo.inputFilename):config.stdin?.replace(mount.inside,mount.outside);
   state.calls.push({program,parameters:config.parameters,input:input?await fsp.readFile(input,'utf8'):null,stdin:config.stdin,stdout:config.stdout});
   if(program==='throw')throw Error('SECRET input private path');
   const status=program==='validator'?state.validator:program==='reference'||program==='standard'?state.reference:program==='target'?state.target:statuses.OK;
   if(output)await fsp.writeFile(output,program==='reference'||program==='standard'?'answer':program==='generator'?'generated':program==='target'?state.output:'');
   return {status,time:2000000,memory:2048};
 }},
 '../../utils':{safelyJoinPath:mapped},'../../fsNative':fakeFs,
 '../../checkers/builtin':{runBuiltinChecker:async(actual,expected)=>({score:state.checkerScore??((await fsp.readFile(actual)).equals(await fsp.readFile(expected))?100:0)})},
 '../../checkers/custom':{validateCustomChecker:()=>{},runCustomChecker:async()=>({score:state.checkerScore??100})},
 '../../omittableString':{isOmittableString:x=>typeof x==='string'||x?.omittedLength!==undefined}
};
function load(file,extra={}){
 const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const module={exports:{}};
 vm.runInNewContext(`(function(require,module,exports){${source}\n})`,{Buffer,console})(name=>extra[name]||dependencies[name]||require(name),module,module.exports);
 return module.exports;
}
const hack=load(path.join(__dirname,'index.ts'));
const selfEval=load(path.join(__dirname,'../self-eval/index.ts'),{'../hack':hack});
function reset(){Object.assign(state,{output:'wrong',validator:statuses.OK,reference:statuses.OK,target:statuses.OK,compile:true,checkerScore:null,downloaded:[],calls:[],programFileIo:{}});}
function task(overrides={}){const progress=[];return {taskId:'test',extraInfo:{inputData:'valid input',judgeInfo:{timeLimit:1000,memoryLimit:128,subtasks:[{testcases:[],scoringType:'Sum'}],checker:{type:'tokens'}},testData:{'official.in':'official-data'},target:{language:'cpp',code:'target',compileAndRunOptions:{}},reference:{language:'cpp',code:'reference',compileAndRunOptions:{}},validator:{language:'cpp',code:'validator',compileAndRunOptions:{}},...overrides},reportProgressRaw:value=>progress.push(value),progress};}
test('sandboxed hack verdicts and hidden prediction feedback',async t=>{
 try {
  await t.test('validated mismatch succeeds after validator/reference/target sandbox stages',async()=>{reset();const job=task();await hack.default(job);assert.equal(job.progress.at(-1).status,'Success');assert.equal(job.progress.at(-1).targetStatus,'WrongAnswer');assert.equal(job.progress.at(-1).targetScore,0);assert.equal(job.progress.at(-1).targetExecuted,true);assert.deepEqual(state.calls.map(x=>x.program),['validator','reference','target']);assert.equal(state.downloaded.includes('official-data'),false);});
  await t.test('matching answer fails without disqualifying a correct program',async()=>{reset();state.output='answer';const job=task();await hack.default(job);assert.equal(job.progress.at(-1).status,'Failed');assert.equal(job.progress.at(-1).targetStatus,'Accepted');assert.equal(job.progress.at(-1).targetScore,100);});
  await t.test('STD stdio remains independent of a target that requires named files',async()=>{
   reset();state.output='answer';const targetIo={inputFilename:'contest.in',outputFilename:'contest.out'};state.programFileIo.target=targetIo;
   const job=task({referenceFileIo:null});job.extraInfo.judgeInfo.fileIo=targetIo;await hack.default(job);
   assert.equal(job.progress.at(-1).status,'Failed');
   const reference=state.calls.find(call=>call.program==='reference'),target=state.calls.find(call=>call.program==='target');
   assert.equal(reference.input,'valid input');assert.equal(reference.stdin,'/sandbox/working/hack-input');assert.equal(reference.stdout,'/sandbox/working/hack-output');
   assert.equal(target.input,'valid input');assert.equal(target.stdin,null);assert.equal(target.stdout,null);
  });
  await t.test('STD named files remain independent of a target that uses stdio',async()=>{
   reset();const referenceIo={inputFilename:'std.in',outputFilename:'std.out'};state.programFileIo.reference=referenceIo;
   const job=task({referenceFileIo:referenceIo});await hack.default(job);assert.equal(job.progress.at(-1).status,'Success');
   const reference=state.calls.find(call=>call.program==='reference'),target=state.calls.find(call=>call.program==='target');
   assert.equal(reference.input,'valid input');assert.equal(reference.stdin,null);assert.equal(reference.stdout,null);
   assert.equal(target.input,'valid input');assert.equal(target.stdin,'/sandbox/working/hack-input');assert.equal(target.stdout,'/sandbox/working/hack-output');
  });
  await t.test('STD and target can use different named files without overriding the target configuration',async()=>{
   reset();state.output='answer';const referenceIo={inputFilename:'std.in',outputFilename:'std.out'},targetIo={inputFilename:'problem.in',outputFilename:'problem.out'};
   state.programFileIo={reference:referenceIo,target:targetIo};const job=task({referenceFileIo:referenceIo});job.extraInfo.judgeInfo.fileIo=targetIo;
   await hack.default(job);assert.equal(job.progress.at(-1).status,'Failed');assert.deepEqual(state.calls.map(call=>call.input),['valid input','valid input','valid input']);
  });
  await t.test('queued legacy jobs without referenceFileIo retain the target named-file convention for STD',async()=>{
   reset();state.output='answer';const legacyIo={inputFilename:'legacy.in',outputFilename:'legacy.out'};state.programFileIo={reference:legacyIo,target:legacyIo};
   const job=task();job.extraInfo.judgeInfo.fileIo=legacyIo;assert.equal(Object.hasOwn(job.extraInfo,'referenceFileIo'),false);await hack.default(job);
   assert.equal(job.progress.at(-1).status,'Failed');assert.deepEqual(state.calls.map(call=>call.input),['valid input','valid input','valid input']);
   assert.equal(state.calls[1].stdin,null);assert.equal(state.calls[2].stdin,null);
  });
  await t.test('invalid input never executes the reference or target',async()=>{reset();state.validator='RuntimeError';const job=task();await hack.default(job);assert.equal(job.progress.at(-1).status,'InvalidInput');assert.equal(state.calls.length,1);assert.equal(job.progress.at(-1).targetExecuted,false);assert.equal(job.progress.at(-1).targetStatus,undefined);});
  await t.test('validator timeout is a configuration error, not success',async()=>{reset();state.validator='TimeLimitExceeded';const job=task();await hack.default(job);assert.equal(job.progress.at(-1).status,'ConfigurationError');});
  await t.test('reference timeout cannot make a target look incorrect',async()=>{reset();state.reference='TimeLimitExceeded';const job=task();await hack.default(job);assert.equal(job.progress.at(-1).status,'ConfigurationError');assert.equal(state.calls.length,2);assert.equal(job.progress.at(-1).targetExecuted,false);assert.equal(job.progress.at(-1).targetStatus,undefined);});
  await t.test('a target timeout on trusted validated input succeeds with resources',async()=>{reset();state.target='TimeLimitExceeded';const job=task();await hack.default(job);assert.equal(job.progress.at(-1).status,'Success');assert.equal(job.progress.at(-1).timeUsed,2);assert.equal(job.progress.at(-1).memoryUsed,2);assert.equal(job.progress.at(-1).targetStatus,'TimeLimitExceeded');assert.equal(job.progress.at(-1).targetScore,0);});
  await t.test('checker infrastructure failure cannot be scored as a successful hack',async()=>{reset();state.checkerScore=NaN;const job=task();await hack.default(job);assert.equal(job.progress.at(-1).status,'ConfigurationError');});
  await t.test('partial checker results preserve the actual target score and never return private outputs',async()=>{reset();state.checkerScore=37.5;const job=task();await hack.default(job);const final=job.progress.at(-1);assert.equal(final.status,'Success');assert.equal(final.targetStatus,'PartiallyCorrect');assert.equal(final.targetScore,37.5);assert.equal(final.targetExecuted,true);assert.doesNotMatch(JSON.stringify(final),/valid input|wrong|answer|output\":|checkerMessage|stderr/);});
  await t.test('target memory, runtime, output and file errors produce their actual verdicts',async()=>{
   for(const targetStatus of ['MemoryLimitExceeded','RuntimeError','OutputLimitExceeded']){reset();state.target=targetStatus;const job=task();await hack.default(job);assert.equal(job.progress.at(-1).status,'Success');assert.equal(job.progress.at(-1).targetStatus,targetStatus);assert.equal(job.progress.at(-1).targetScore,0);}
   reset();state.programFileIo.target={inputFilename:'hack-input',outputFilename:'unrelated.out'};const job=task();await hack.default(job);assert.equal(job.progress.at(-1).status,'Success');assert.equal(job.progress.at(-1).targetStatus,'FileError');
  });
  await t.test('cancelled and unknown sandbox results cannot be successful counterexamples',async()=>{for(const [target,status] of [['Cancelled','Canceled'],['Unknown','SystemError']]){reset();state.target=target;const job=task();await hack.default(job);assert.equal(job.progress.at(-1).status,status);assert.equal(job.progress.at(-1).targetStatus,undefined);assert.equal(job.progress.at(-1).targetExecuted,true);}});
  await t.test('checker failures after target execution record no invented verdict',async()=>{for(const score of [NaN,-1,101]){reset();state.checkerScore=score;const job=task();await hack.default(job);const final=job.progress.at(-1);assert.equal(final.status,'ConfigurationError');assert.equal(final.targetExecuted,true);assert.equal(final.targetStatus,undefined);assert.equal(final.targetScore,undefined);assert.equal(final.timeUsed,2);}});
  await t.test('compile logs and unexpected exceptions never expose input or paths',async()=>{reset();state.compile=false;const job=task();await hack.default(job);assert.doesNotMatch(JSON.stringify(job.progress),/SECRET/);});
  await t.test('self evaluation executes the candidate and returns only aggregate feedback',async()=>{reset();state.output='answer';const job=task({content:{language:'cpp',code:'target',compileAndRunOptions:{}},cases:[{subtask:1,input:Buffer.from('SECRET').toString('base64'),output:Buffer.from('answer').toString('base64')}]});await selfEval.onSelfEval(job);const result=job.progress.at(-1);assert.equal(result.status,'Accepted');assert.equal(result.score,100);assert.doesNotMatch(JSON.stringify(result),/SECRET|input|output|checker|stderr/);assert.equal(state.downloaded.includes('official-data'),false);});
  await t.test('self evaluation compilation errors suppress compiler diagnostics',async()=>{reset();state.compile=false;const job=task({content:{language:'cpp',code:'target',compileAndRunOptions:{}},cases:[{subtask:1,input:'',output:''}]});await selfEval.onSelfEval(job);assert.equal(job.progress.at(-1).status,'CompilationError');assert.doesNotMatch(JSON.stringify(job.progress),/SECRET/);});
  await t.test('fixed prediction preparation verifies all hashes and uses one shared seed per scope',async()=>{
   reset();const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'llmoj-profile-unit-'));roots.push(directory);
   const recipe={subtaskIds:[1]};for(const name of ['generator','standard','validator']){const file=path.join(directory,name);await fsp.writeFile(file,name);state.files[name]=file;recipe[name+'File']=name;recipe[name+'Sha256']=crypto.createHash('sha256').update(name).digest('hex');}
   const jobs=[];for(let i=0;i<2;i++){const job=task({scope:'contest:7:problem:1',testData:{generator:'generator',standard:'standard',validator:'validator'},judgeInfo:{timeLimit:1000,memoryLimit:128,selfEval:recipe}});await selfEval.onSelfEvalPrepare(job);jobs.push(job);assert.equal(job.progress.at(-1).status,'Ready');}
   assert.deepEqual(jobs[0].progress.at(-1).cases,jobs[1].progress.at(-1).cases);assert.deepEqual(state.calls.filter(x=>x.program==='generator')[0].parameters,state.calls.filter(x=>x.program==='generator')[1].parameters);
   const bad=task({scope:'contest:7:problem:1',testData:{generator:'generator',standard:'standard',validator:'validator'},judgeInfo:{selfEval:{...recipe,generatorSha256:'0'.repeat(64)},timeLimit:1000,memoryLimit:128}});await selfEval.onSelfEvalPrepare(bad);assert.equal(bad.progress.at(-1).status,'ConfigurationError');
  });
 } finally {await Promise.all(roots.map(root=>fsp.rm(root,{recursive:true,force:true})));}
});
