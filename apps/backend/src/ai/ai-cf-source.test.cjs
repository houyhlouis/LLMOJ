/* Pure tests: synthetic extraction only; no provider, database or judge requests. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
require('reflect-metadata');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2019,module:ts.ModuleKind.CommonJS,esModuleInterop:true,experimentalDecorators:true,emitDecoratorMetadata:true}}).outputText,filename);
const {normalizeProblemSource,problemSourceLabel}=require('../problem/problem-source.ts');
const {exactCodeforcesRating}=require('./codeforces-calibration.ts');
const {AiService}=require('./ai.service.ts');

test('verified Luogu CF mirror URLs canonicalize and use the official CF rating snapshot',()=>{
 for(const source of ['https://www.luogu.com.cn/problem/CF868F','https://luogu.com.cn/problem/cf868f?lang=en','https://www.luogu.org/problem/CF868F/']){
  assert.equal(normalizeProblemSource(source),'https://codeforces.com/problemset/problem/868/F');
  assert.equal(exactCodeforcesRating(source),2500);
  assert.equal(problemSourceLabel(source,'Yet Another Minimization Problem'),'Codeforces 868F Yet Another Minimization Problem');
 }
});

test('CF rating lookup rejects lookalike hosts, credentials, ports and unrelated paths instead of guessing',()=>{
 for(const source of ['https://luogu.com.cn.evil.example/problem/CF868F','https://www.luogu.com.cn:444/problem/CF868F','https://user@www.luogu.com.cn/problem/CF868F','https://www.luogu.com.cn/problem/CF868F/solution','https://www.luogu.com.cn/problem/P868','ftp://codeforces.com/problemset/problem/868/F','https://codeforces.com:444/problemset/problem/868/F']) assert.equal(exactCodeforcesRating(source),null,source);
});

test('difficulty action for a verified CF mirror updates official 2500 without model or search calls',async()=>{
 const service=Object.create(AiService.prototype), writes=[];
 service.assertSnapshot=async()=>({id:4});
 service.db={getRepository:()=>({update:async(id,data)=>writes.push({id,data})})};
 service.model=async()=>assert.fail('official rating must bypass inference');
 service.references=async()=>assert.fail('official rating needs no search');
 const job={state:{}}, problem={id:7,originalProblem:'https://www.luogu.com.cn/problem/CF868F'}, snapshot={statements:[],samples:[]};
 require('./ai-commit.fixture.cjs').commitFixture(service,job,problem,snapshot,async(id,data)=>writes.push({id,data}));
 await service.edit(job,{id:4},problem,{},snapshot,'difficulty');
 assert.deepEqual(writes,[{id:7,data:{difficulty:2500}}]);assert.match(job.state.difficultyRationale,/Official Codeforces/);
});
