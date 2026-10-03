/* Pure tests: synthetic extraction only; no provider, database or judge requests. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
require('reflect-metadata');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2019,module:ts.ModuleKind.CommonJS,esModuleInterop:true,experimentalDecorators:true,emitDecoratorMetadata:true}}).outputText,filename);

const {declaredAiProblemType,resolveAiImportType}=require('./ai-import-type.ts');
const {AiService}=require('./ai.service.ts');
test('explicit bilingual interactive and communication declarations retain their real type',()=>{
 for(const text of ['This is an interactive problem.','This problem is interactive.','本题为交互式问题。','题目类型：交互题','## Interaction']) assert.equal(resolveAiImportType(text),'Interaction',text);
 for(const text of ['The task is communication.','This is a run-twice communication problem.','本题为通信题。','## Problem type: Communication'])assert.equal(resolveAiImportType(text),'Communication',text);
});
test('ordinary stories, negations and fenced code never change traditional classification',()=>{
 for(const text of ['Find minimum communication cost on a tree.','This is a non-interactive problem.','This is not an interactive problem.','本题不是交互题。','Print `This is an interactive problem.`','```cpp\n// This is an interactive problem.\n```\nRead two integers.'])assert.equal(resolveAiImportType(text),'Traditional',text);
});
test('output-only imports remain unsupported with a clear error',()=>{
 for(const text of ['This task is an output-only task.','本题是提交答案题。'])assert.throws(()=>resolveAiImportType(text),/AI_IMPORT_TYPE_UNSUPPORTED/);
 assert.throws(()=>resolveAiImportType('',{problemType:'SubmitAnswer'}),/AI_IMPORT_TYPE_UNSUPPORTED/);
});
test('explicit type override prevents model downgrade but cannot contradict an explicit original protocol',()=>{
 assert.equal(resolveAiImportType('',{problemType:'Traditional'},'Interaction'),'Interaction');
 assert.equal(resolveAiImportType('This is an interactive problem.',{problemType:'Traditional'}),'Interaction');
 assert.throws(()=>resolveAiImportType('This is an interactive problem.',{},'Traditional'),/AI_PROBLEM_TYPE_MISMATCH/);
 assert.throws(()=>resolveAiImportType('',{problemType:'Interaction'},'Traditional'),/AI_PROBLEM_TYPE_MISMATCH/);
 assert.throws(()=>resolveAiImportType('',{problemType:'Unknown'}),/AI_IMPORT_TYPE_UNSUPPORTED/);
});
test('unsupported admission still rejects before configuration or any provider/job call',async()=>{
 const svc=Object.create(AiService.prototype);svc.requirePrivilege=async()=>{};svc.problems={userHasCreateProblemPermission:async()=>true};svc.config=async()=>assert.fail('must not read configuration');
 await assert.rejects(svc.start({id:4},{action:'import',markdown:'This is an output-only task.'}),/AI_IMPORT_TYPE_UNSUPPORTED/);
});
function fixture(result){
 const svc=Object.create(AiService.prototype),created=[];
 svc.requirePrivilege=svc.checkpoint=async()=>{};svc.assertJob=async()=>({id:4});svc.installAttachment=async()=>{};svc.resolveImportedFileIo=async()=>null;svc.model=async()=>structuredClone(result);
 svc.problems={userHasCreateProblemPermission:async()=>true,createProblem:async(user,type,statement,_tags,commit)=>{created.push({type,statement});await commit({id:9},{findOneBy:async()=>({judgeInfo:{timeLimit:1000,memoryLimit:256}}),update:async()=>({affected:1})});return{id:9,type};}};
 return {svc,created};
}
const extracted=(problemType)=>({problemType,localizedContents:[{locale:'en_US',title:'Protocol fixture',description:'Preserve the original public protocol.',input:'Input rules.',output:'Output rules.',limitsAndHints:'Constraints.'}],samples:[{inputData:'hidden state\n',outputData:''}]});
test('image or Markdown extraction creates Interaction and Communication rather than Traditional',async()=>{
 for(const type of ['Interaction','Communication']){const {svc,created}=fixture(extracted(type)),job={input:{image:'synthetic-image'},state:{}};await svc.importProblem(job,{id:4},{});assert.equal(created[0].type,type);assert.equal(job.state.importStatement.problemType,type);assert.equal(job.problemId,9);assert.deepEqual(job.state.protocolSamples,[]);}
});
test('grader mode and original hidden sample indices survive extraction without invented samples',async()=>{
 const result={...extracted('Communication'),communicationMode:'grader',protocolSampleIndices:[0]}, {svc}=fixture(result),job={input:{markdown:'This is a communication problem.'},state:{}};await svc.importProblem(job,{id:4},{});assert.equal(job.state.communicationMode,'grader');assert.deepEqual(job.state.protocolSamples,[{input:'hidden state\n'}]);
});
test('invalid protocol sample indices reject before creating any problem',async()=>{
 const {svc,created}=fixture({...extracted('Interaction'),protocolSampleIndices:[8]});await assert.rejects(svc.importProblem({input:{markdown:'This is an interactive problem.'},state:{}},{id:4},{}),/INVALID_AI_PROTOCOL/);assert.equal(created.length,0);
});
test('a previously misclassified legacy Traditional import cannot silently resume as interactive',async()=>{
 const svc=Object.create(AiService.prototype);svc.problems={findProblemById:async()=>({id:26,type:'Traditional'})};svc.installAttachment=async()=>assert.fail('must not resume the wrong type');
 await assert.rejects(svc.importProblem({problemId:26,input:{markdown:'This is an interactive problem.'},state:{}},{id:4},{}),/AI_PROBLEM_TYPE_MISMATCH/);
});
