const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const jwt = require('jsonwebtoken');
const {diff} = require('jsondiffpatch');
const noop = () => {};
const decorator = () => noop;
const P = {ViewSite:'ViewSite',ViewSubmission:'ViewSubmission', ManageProblem:'ManageProblem', ReadProblemData:'ReadProblemData'};
function load(file, overrides) {
  const source = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, file), 'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true,experimentalDecorators:true}
  }).outputText;
  const module = {exports:{}};
  const generic = new Proxy({}, {get:()=>decorator});
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`) (name => overrides[name] || generic, module, module.exports);
  return module.exports;
}
const {withoutTestData} = load('submission-redaction.ts', {});
const {SubmissionProgressGateway:Gateway, SubmissionProgressSubscriptionType:T} = load('submission-progress.gateway.ts', {
  '@nestjs/common':{Inject:decorator,forwardRef:x=>x},
  '@nestjs/websockets':{WebSocketGateway:decorator,WebSocketServer:decorator},
  'jsonwebtoken':jwt, 'jsondiffpatch':{diff}, './submission-redaction':{withoutTestData},
  './submission.service':{SubmissionPermissionType:{View:'View'}},
  './submission-progress.interface':{SubmissionProgressType:{Finished:'Finished'}},
  './submission-progress.service':{SubmissionEventType:{Progress:0,Deleted:2}},
  '@libreoj/judge-protocol':{SubmissionStatus:{Pending:'Pending'}},
  '../user/user-privilege.service':{UserPrivilegeType:P},
  '../problem/problem.service':{ProblemPermissionType:{View:'View'}},
  '../logger':{logger:{log:noop,error:noop}}
});
function fixture() {
  const state = {view:true,site:true,data:true,session:true,problem:true,code:true,fail:false};
  const records = new Map([[74,{id:74,problemId:1,submitterId:5,isPublic:true,status:'Pending'}]]);
  const metrics = {inc:noop,dec:noop};
  const g = new Gateway({config:{security:{sessionSecret:'test-fixture-only'}}}, {
    findSubmissionById:async id=>records.get(id),
    userHasPermission:async (user, submission, type)=> {assert.equal(type,'View');if(state.fail)throw Error('storage unavailable');return state.view && state.code && (submission.isPublic || user?.id===submission.submitterId || state.problem);},
    getSubmissionBasicMeta:async sub=>({status:sub.status}),
    getSubmissionDetail:async()=>({result:{progressType:'Finished',testcaseResult:{a:{status:'Accepted',input:'private input',output:'private answer'}}}})
  }, {gauge:()=>metrics,counter:()=>metrics}, {
    accessSessionById:async (uid,sid)=> {assert.equal(uid,5);assert.equal(sid,8);return state.session ? {id:5} : null;}
  }, {
    userHasPrivilege:async (user,p)=>p===P.ViewSite ? state.site : p===P.ViewSubmission ? state.view : false,
    permissionDecision:async (user,p)=> {assert.equal(p,P.ReadProblemData);return state.data;}
  }, {
    findProblemById:async ()=>({id:1}), userHasPermission:async ()=>state.problem
  });
  const messages=[];
  g.server={sockets:new Map(),to:id=>({emit:(event, submissionId, delta)=>messages.push({id,submissionId,delta})})};
  function key(type=T.Detail,ids=[74],userId=5,sessionId=8) {return g.encodeSubscription({type,submissionIds:ids,userId,sessionId});}
  function socket(token,id='socket') {
    const client = {id,connected:true,handshake:{query:{subscriptionKey:token}},disconnect:()=>{client.connected=false;g.handleDisconnect(client);g.server.sockets.delete(id);}};
    g.server.sockets.set(id,client);
    return client;
  }
  return {g,state,records,messages,key,socket};
}
const progress = {progressType:'Running',testcaseResult:{a:{status:'Accepted',input:'private input',output:'private answer'}}};
test('signed credentials bind identity/session and expire',()=>{
  const {g,key}=fixture();const claims=g.decodeSubscription(key());
  assert.equal(claims.userId,5);assert.equal(claims.sessionId,8);assert.equal(claims.exp-claims.iat,86400);
});
test('legacy, expired, malformed and tampered credentials cannot connect',async()=>{
  const {g,key,socket,messages}=fixture();const secret='test-fixture-onlySubmissionProgress';
  const tokens=[jwt.sign({type:1,submissionIds:[74]},secret),jwt.sign({type:1,submissionIds:[74],userId:5,sessionId:8},secret,{issuer:'libreoj:submission-progress',expiresIn:-1}),key()+'.tamper',key(T.Detail,[-1]),key(T.Detail,[74],5,null),key(99)];
  for(const token of tokens){assert.equal(g.decodeSubscription(token),null);const s=socket(token);await g.handleConnection(s);assert.equal(s.connected,false);}
  assert.equal(messages.length,0);
});
test('authorized connected client receives detailed progress',async()=>{
  const {g,key,socket,messages}=fixture();const s=socket(key());await g.handleConnection(s);await g.onSubmissionEvent(74,0,progress);
  assert.equal(s.connected,true);assert.match(JSON.stringify(messages),/private input/);
});
test('revoked ViewSubmission denies both reconnect and future active-stream messages',async()=>{
  const {g,key,socket,state,messages}=fixture();const token=key();const active=socket(token);await g.handleConnection(active);state.view=false;
  await g.onSubmissionEvent(74,0,progress);assert.equal(active.connected,false);assert.equal(messages.length,0);
  const replay=socket(token);await g.handleConnection(replay);assert.equal(replay.connected,false);assert.equal(g.rooms.size,0);
});
test('revoked test data rejects an old detailed key without leaking deletion deltas',async()=>{
  const {g,key,socket,state,messages}=fixture();const token=key();const active=socket(token);await g.handleConnection(active);await g.onSubmissionEvent(74,0,progress);messages.length=0;state.data=false;
  await g.onSubmissionEvent(74,0,{...progress,score:50});assert.equal(active.connected,false);assert.equal(messages.length,0);
  const replay=socket(token);await g.handleConnection(replay);assert.equal(replay.connected,false);
});
test('fresh redacted subscriptions still receive verdict and safe progress',async()=>{
  const {g,key,socket,state,messages}=fixture();state.data=false;const s=socket(key(T.DetailWithoutTestData));await g.handleConnection(s);await g.onSubmissionEvent(74,0,progress);
  assert.equal(s.connected,true);assert.equal(messages.length,1);assert.doesNotMatch(JSON.stringify(messages),/private input|private answer/);assert.match(JSON.stringify(messages),/Accepted/);
});
test('logout/session revocation rejects existing and replayed subscriptions',async()=>{
  const {g,key,socket,state,messages}=fixture();const token=key();const active=socket(token);await g.handleConnection(active);state.session=false;await g.onSubmissionEvent(74,0,progress);
  assert.equal(active.connected,false);const replay=socket(token);await g.handleConnection(replay);assert.equal(replay.connected,false);assert.equal(messages.length,0);
});
test('permission changes after handshake are checked on already-finished results',async()=>{
  const {g,key,socket,state,records,messages}=fixture();records.get(74).status='Accepted';g.submissionService.getSubmissionDetail=async()=>{state.view=false;return {result:progress};};
  const s=socket(key());await g.handleConnection(s);assert.equal(s.connected,false);assert.equal(messages.length,0);
});
test('metadata access remains independent of permission to read code',async()=>{
  const {g,key,socket,state,messages}=fixture();state.code=false;const s=socket(key(T.Meta));await g.handleConnection(s);await g.onSubmissionEvent(74,0,progress);
  assert.equal(s.connected,true);assert.equal(messages.length,1);assert.doesNotMatch(JSON.stringify(messages),/private input|private answer/);
});
test('private metadata stops when problem ACL is revoked',async()=>{
  const {g,key,socket,state,records,messages}=fixture();records.get(74).submitterId=6;records.get(74).isPublic=false;const s=socket(key(T.Meta));await g.handleConnection(s);state.problem=false;await g.onSubmissionEvent(74,0,progress);
  assert.equal(s.connected,false);assert.equal(messages.length,0);
});
test('anonymous public subscriptions use current public visibility',async()=>{
  const {g,key,socket,records,messages}=fixture();const s=socket(key(T.Detail,[74],null,null));await g.handleConnection(s);records.get(74).isPublic=false;g.submissionService.userHasPermission=async()=>false;
  await g.onSubmissionEvent(74,0,progress);assert.equal(s.connected,false);assert.equal(messages.length,0);
});
test('authorization storage failure disconnects without any data',async()=>{
  const {g,key,socket,state,messages}=fixture();const s=socket(key());await g.handleConnection(s);state.fail=true;await g.onSubmissionEvent(74,0,progress);
  assert.equal(s.connected,false);assert.equal(messages.length,0);
});
test('deleted submissions and finished rooms release client state',async()=>{
  const {g,key,socket,records,messages}=fixture();const s=socket(key());await g.handleConnection(s);records.get(74).status='Accepted';await g.onSubmissionEvent(74,0,{...progress,progressType:'Finished'});
  assert.equal(messages.length,1);assert.equal(s.connected,false);assert.equal(g.rooms.size,0);assert.equal(g.clientSubscriptions.size,0);assert.equal(g.clientLastMessages.size,0);
  const t=socket(key());records.delete(74);await g.handleConnection(t);assert.equal(t.connected,false);
});
test('concurrent progress events retain wire order',async()=>{
  const {g,key,socket,messages}=fixture();const s=socket(key());await g.handleConnection(s);const seen=[];const send=g.sendMessage.bind(g);g.sendMessage=async(to,id,message)=>{if(typeof to==='string' && to.startsWith('1_'))seen.push(message.progressDetail.score);await send(to,id,message);};
  await Promise.all([g.onSubmissionEvent(74,0,{...progress,score:1}),g.onSubmissionEvent(74,0,{...progress,score:2})]);assert.deepEqual(seen,[1,2]);assert.equal(g.eventQueues.size,0);assert.equal(messages.length,2);
});

test('finished-result storage failures close the socket',async()=>{
  const {g,key,socket,records,messages}=fixture();records.get(74).status='Accepted';g.submissionService.getSubmissionDetail=async()=>{throw Error('read failed');};
  const s=socket(key());await g.handleConnection(s);assert.equal(s.connected,false);assert.equal(messages.length,0);assert.equal(g.rooms.size,0);
});

test('ViewSite revocation stops all stream types even when object permission remains',async()=>{
  for(const type of [T.Meta,T.Detail,T.DetailWithoutTestData]){
    const {g,key,socket,state,messages}=fixture();const s=socket(key(type));await g.handleConnection(s);state.site=false;
    await g.onSubmissionEvent(74,0,progress);assert.equal(s.connected,false);assert.equal(messages.length,0);
  }
});
test('contest object permission cannot bypass revoked global ViewSubmission',async()=>{
  const {g,key,socket,state,records,messages}=fixture();records.get(74).contestId=14;g.submissionService.userHasPermission=async()=>true;
  const s=socket(key());await g.handleConnection(s);state.view=false;await g.onSubmissionEvent(74,0,progress);
  assert.equal(s.connected,false);assert.equal(messages.length,0);
});
