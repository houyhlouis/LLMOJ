const test=require('node:test'),assert=require('node:assert/strict');require('reflect-metadata');const fs=require('node:fs'),ts=require('typescript');require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText,filename);
const{validateChecker}=require('./checker.ts');const validate=checker=>validateChecker({timeLimit:1000,memoryLimit:128,checker},[],{validateCompileAndRunOptions:()=>true});
for(const type of ['tokens','lines']){
 test(type+' accepts an explicit case policy',()=>{validate({type,caseSensitive:true});validate({type,caseSensitive:false});});
 test(type+' rejects an absent or non-boolean case policy',()=>{for(const value of [undefined,null,'false',0])assert.throws(()=>validate({type,caseSensitive:value}));});
 test(type+' strips unrelated checker fields without changing comparison',()=>{const value={type,caseSensitive:true,precision:6};validate(value);assert.deepEqual(value,{type,caseSensitive:true});});
}
test('an unknown checker cannot silently become binary',()=>assert.throws(()=>validate({type:'token'})));
