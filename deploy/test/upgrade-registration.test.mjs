import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEmptyAccount, isRoutineAccountAudit, isRoutineRejectionAudit } from '../upgrade-registration.mjs';
const created = new Date('2026-10-10T12:00:00Z');
const empty = () => ({ userId: 7,id:7,authId:7,informationId:7,preferenceId:7,status:'pending',
  isAdmin:0,publicEmail:0,acceptedProblemCount:0,submissionCount:0,rating:0,nickname:'',bio:'',avatarInfo:'gravatar:',
  organization:'',location:'',url:'',telegram:'',qq:'',github:'',createdAt:created,registrationTime:created,
  preference:'{}',passwordHash:'$2b$10$'+'a'.repeat(53),username:'applicant',email:'applicant@example.invalid',
  reviewedAt:null,reviewedBy:null,reason:null });
const audit = () => ({id:19,userId:7,action:'auth.register',firstObjectType:null,firstObjectId:null,secondObjectType:null,secondObjectId:null,
  time:created,ip:'127.0.0.1',details:{username:'applicant',email:'applicant@example.invalid'}});
test('default generated account is transferable without changing bcrypt',()=>assert.doesNotThrow(()=>validateEmptyAccount(empty())));
for (const [name,value] of Object.entries({isAdmin:1,submissionCount:1,acceptedProblemCount:1,rating:50,nickname:'changed',bio:'content',avatarInfo:'qq:123',organization:'school',publicEmail:1,authId:null,preferenceId:9,passwordHash:'invalid',preference:'{"editor":"vim"}',reviewedBy:1})) {
  test('reject nonempty/inconsistent '+name,()=>assert.throws(()=>validateEmptyAccount({...empty(),[name]:value})));
}
test('only exact registration and wrong-password actor history are archivable',()=>{
  assert.equal(isRoutineAccountAudit(audit(),empty()),true);
  assert.equal(isRoutineAccountAudit({...audit(),action:'auth.login_failed.wrong_password',details:null},empty()),true);
  for (const changed of [{action:'auth.login'},{userId:8},{details:{username:'other',email:'applicant@example.invalid'}},{firstObjectType:'User',firstObjectId:7},{details:{...audit().details,extra:true}}]) assert.equal(isRoutineAccountAudit({...audit(),...changed},empty()),false);
});
test('ordinary administrator rejection can keep its history under application semantics',()=>{
  const row={...empty(),status:'rejected',reviewedAt:created,reviewedBy:1,reason:'test reason'};
  assert.doesNotThrow(()=>validateEmptyAccount(row));
  const event={...audit(),userId:1,action:'auth.registration_rejected',firstObjectType:'User',firstObjectId:7,details:{from:'pending',to:'rejected',reason:'test reason'}};
  assert.equal(isRoutineRejectionAudit(event,row),true);
  for(const changed of [{userId:2},{time:new Date('2025-01-01')},{secondObjectType:'Problem',secondObjectId:1},{details:{...event.details,to:'approved'}},{action:'user.update'}]) assert.equal(isRoutineRejectionAudit({...event,...changed},row),false);
});
